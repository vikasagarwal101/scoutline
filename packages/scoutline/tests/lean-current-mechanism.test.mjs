import test from "node:test";
import assert from "node:assert/strict";
import { createTavilyDescriptor } from "../dist/providers/tavily/adapter.js";
import { createExaDescriptor } from "../dist/providers/exa/adapter.js";
import { createLeanAcquisitionDeps } from "../dist/lib/lean-acquisition-bridge.js";
const env = {
  TAVILY_API_KEY: "synthetic",
  EXA_API_KEY: "synthetic",
  TAVILY_TIMEOUT: "1000",
  EXA_TIMEOUT: "1000",
};
const json = (v, status = 200) => new Response(JSON.stringify(v), { status });
const policy = { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, jitterMs: 0 };
function opts(transport) {
  const d = createTavilyDescriptor({ transport });
  return {
    transports: { tavily: transport },
    descriptorFactory: (_id, t) => createTavilyDescriptor({ transport: t }),
    searchDescriptor: d,
    readerDescriptor: d,
    env,
    cache: { get: async () => null, set: async () => {} },
    sleep: async () => {},
    random: () => 0,
    retryPolicy: policy,
  };
}

test("partial selected provider map refuses Exa before its real HTTP", async () => {
  let calls = 0;
  const tavily = { env, fetch: async () => json({ results: [] }) };
  const exa = {
    env,
    fetch: async () => {
      calls++;
      return json({ results: [] });
    },
  };
  const o = opts(tavily);
  o.searchDescriptor = createExaDescriptor({ transport: exa });
  await assert.rejects(() => createLeanAcquisitionDeps(o).search("q"));
  assert.equal(calls, 0);
});

test("same actual-main factory does not rewrap prior operation or inherit expired deadline", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  let calls = 0;
  const transports = {
    tavily: {
      env,
      fetch: async () => {
        calls++;
        return json({ results: [] });
      },
    },
  };
  const o = opts(transports.tavily);
  o.transports = transports;
  // Exact actual-main factory behavior: updates runtime map with copied wrapped transport.
  o.descriptorFactory = (id, transport) => {
    const d = createTavilyDescriptor({ transport });
    transports[id] = transport;
    return d;
  };
  const deps = createLeanAcquisitionDeps(o);
  await deps.search("a", { signal: new AbortController().signal, timeoutMs: 5 });
  assert.equal(Date.now(), 1000);
  t.mock.timers.tick(12);
  assert.equal(Date.now(), 1012);
  await deps.search("b", { signal: new AbortController().signal, timeoutMs: 100 });
  assert.equal(calls, 2);
  assert.equal(
    deps.physicalLedger.attempts,
    2,
    "one record per physical fetch, no nested old wrapper",
  );
});

test("malformed JSON body is a failed physical outcome not complete", async () => {
  const deps = createLeanAcquisitionDeps(
    opts({ env, fetch: async () => new Response("{broken", { status: 200 }) }),
  );
  await assert.rejects(() => deps.search("q"));
  assert.equal(deps.physicalLedger.attempts, 1);
  assert.equal(deps.physicalLedger.perAttempt[0].outcome, "failed");
});

test("body arriving beyond disposal grace is cancelled eventually after local rejection", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1000 });
  let resolveHeaders;
  let markEntered;
  let calls = 0;
  let cancelled = false;
  let released = false;
  const order = [];
  const entered = new Promise((resolve) => { markEntered = resolve; });
  const signal = new AbortController();
  const acquisitionOptions = opts({
    env,
    fetch: () => {
      calls++;
      order.push("fetch-entered");
      return new Promise((resolve) => {
        resolveHeaders = resolve;
        markEntered();
      });
    },
  });
  const deps = createLeanAcquisitionDeps(acquisitionOptions);
  const pending = deps.search("q", { signal: signal.signal, timeoutMs: 5 });
  const settled = pending.then(
    (value) => { order.push("fulfilled"); return { status: "fulfilled", value }; },
    (error) => { order.push("rejected"); return { status: "rejected", error }; },
  );
  try {
    const boundary = await Promise.race([
      entered.then(() => "fetch-entered"),
      settled.then(() => "operation-settled-before-entry"),
    ]);
    const early = boundary === "operation-settled-before-entry" ? await settled : undefined;
    t.diagnostic(`late-body-entry ${JSON.stringify({
      boundary, calls, resolverType: typeof resolveHeaders, ledger: deps.physicalLedger, order: [...order],
      originalError: early?.error && { name: early.error.name, code: early.error.code, message: early.error.message, help: early.error.help },
    })}`);
    assert.equal(boundary, "fetch-entered", "dispatched fake fetch must precede cancellation");
    assert.equal(calls, 1);
    assert.equal(typeof resolveHeaders, "function");
    assert.equal(deps.physicalLedger.attempts, 1);
    order.push("controlled-abort");
    signal.abort();
    const outcome = await settled;
    t.diagnostic(`late-body-rejection ${JSON.stringify({
      status: outcome.status, calls, ledger: deps.physicalLedger, order: [...order],
      originalError: outcome.error && { name: outcome.error.name, code: outcome.error.code, message: outcome.error.message, help: outcome.error.help },
    })}`);
    assert.equal(outcome.status, "rejected");
    assert(outcome.error instanceof Error);
    assert.equal(outcome.error.code, "TIMEOUT_ERROR");
    assert.equal(deps.physicalLedger.attempts, 1);
    released = true;
    order.push("late-headers-released-after-rejection");
    resolveHeaders(
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode('{"results":['));
          },
          cancel() {
            cancelled = true;
            order.push("late-body-cancelled");
          },
        }),
      ),
    );
    await new Promise((r) => setImmediate(r));
    t.diagnostic(`late-body-final ${JSON.stringify({ cancelled, calls, ledger: deps.physicalLedger, order: [...order] })}`);
    assert.equal(
      cancelled,
      true,
      "lost-race promise must retain async late disposal after 25ms grace",
    );
  } finally {
    signal.abort();
    if (!released && typeof resolveHeaders === "function") resolveHeaders(json({ results: [] }));
    await settled;
  }
});

test("overlapping no-factory stages fail closed or retain each operation signal and budget", async () => {
  let releaseA;
  let releaseB;
  let calls = 0;
  const transport = {
    env,
    fetch: async () => {
      calls++;
      return json({ results: [] });
    },
  };
  const base = createTavilyDescriptor({ transport });
  const delayed = {
    ...base,
    create(ctx) {
      const a = base.create(ctx);
      const search = {
        ...a.search,
        async invoke(request, signal, count) {
          await new Promise((r) => (request.query === "a" ? (releaseA = r) : (releaseB = r)));
          return a.search.invoke(request, signal, count);
        },
      };
      return { ...a, search };
    },
  };
  const factory = (_id, t) => {
    const d = createTavilyDescriptor({ transport: t });
    return {
      ...d,
      create(ctx) {
        const a = d.create(ctx);
        return {
          ...a,
          search: {
            ...a.search,
            async invoke(request, signal, count) {
              await new Promise((r) => (request.query === "a" ? (releaseA = r) : (releaseB = r)));
              return a.search.invoke(request, signal, count);
            },
          },
        };
      },
    };
  };
  const first = createLeanAcquisitionDeps({
    ...opts(transport),
    searchDescriptor: delayed,
    descriptorFactory: factory,
  });
  const second = createLeanAcquisitionDeps({
    ...opts(transport),
    searchDescriptor: delayed,
    descriptorFactory: factory,
  });
  const signalA = new AbortController();
  const signalB = new AbortController();
  const a = first.search("a", { signal: signalA.signal, timeoutMs: 100 }).then(
    () => null,
    (e) => e,
  );
  await new Promise((r) => setImmediate(r));
  const b = second.search("b", { signal: signalB.signal, timeoutMs: 100 }).then(
    () => null,
    (e) => e,
  );
  await new Promise((r) => setImmediate(r));
  signalB.abort();
  releaseA();
  await a;
  releaseB?.();
  await b;
  assert.equal(first.physicalLedger.attempts, 1, "A must not inherit aborted B stack top");
  assert.equal(second.physicalLedger.attempts, 0);
  assert.equal(calls, 1);
});
