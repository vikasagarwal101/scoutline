import test from "node:test";
import assert from "node:assert/strict";
import { createTavilyDescriptor } from "../dist/providers/tavily/adapter.js";
import { createLeanAcquisitionDeps } from "../dist/lib/lean-acquisition-bridge.js";
import { runLeanVerticalSlice } from "../scripts/lean-vertical-slice.mjs";
const env = { TAVILY_API_KEY: "synthetic-key", TAVILY_TIMEOUT: "1000" };
const json = (v, s = 200) => new Response(JSON.stringify(v), { status: s });
const cache = () => ({ get: async () => null, set: async () => {} });
const policy = { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, jitterMs: 0 };
function options(fetch) {
  const transport = { fetch, env };
  const descriptor = createTavilyDescriptor({ transport });
  return {
    transports: { tavily: transport },
    descriptorFactory: (_id, t) => createTavilyDescriptor({ transport: t }),
    searchDescriptor: descriptor,
    readerDescriptor: descriptor,
    env,
    cache: cache(),
    sleep: async () => {},
    random: () => 0,
    retryPolicy: policy,
  };
}
const url = "https://offline.test/release";

test("Provider failed_results and malformed normalized search cannot claim completed acquisition", async () => {
  for (const mode of ["read", "search"]) {
    const deps = createLeanAcquisitionDeps(
      options(async () =>
        json(
          mode === "read"
            ? { failed_results: [{ url, error: "missing" }], results: [] }
            : { results: [{ url, title: 17, content: "malformed" }] },
        ),
      ),
    );
    await assert.rejects(() => (mode === "read" ? deps.read(url) : deps.search("q")));
    assert.equal(deps.physicalLedger.attempts, 1);
    assert.equal(
      deps.physicalLedger.perAttempt[0].outcome,
      "failed",
      "parsed JSON is not normalized operation success",
    );
  }
});

test("ignored headers aborted before remaining deadline settle promptly and report unknown remote outcome", async () => {
  let release;
  const deps = createLeanAcquisitionDeps(options(() => new Promise((r) => (release = r))));
  const controller = new AbortController();
  const pending = deps.search("q", { signal: controller.signal, timeoutMs: 1000 });
  setTimeout(() => controller.abort(), 3);
  try {
    const r = await Promise.race([
      pending.then(
        () => "success",
        () => "rejected",
      ),
      new Promise((r) => setTimeout(() => r("watchdog"), 60)),
    ]);
    assert.equal(
      r,
      "rejected",
      "caller abort must race headers, not wait whole remaining deadline",
    );
    assert.equal(deps.physicalLedger.perAttempt[0].outcome, "unknown");
  } finally {
    release(json({ results: [] }));
    await pending.catch(() => {});
  }
});

test("late Response cancel that never resolves cannot hang the bounded disposal grace", async () => {
  let release;
  const deps = createLeanAcquisitionDeps(options(() => new Promise((r) => (release = r))));
  const controller = new AbortController();
  const pending = deps.search("q", { signal: controller.signal, timeoutMs: 5 });
  setTimeout(() => controller.abort(), 1);
  setTimeout(
    () =>
      release(
        new Response(
          new ReadableStream({
            cancel() {
              return new Promise(() => {});
            },
          }),
        ),
      ),
    9,
  );
  const r = await Promise.race([
    pending.then(
      () => "success",
      () => "rejected",
    ),
    new Promise((r) => setTimeout(() => r("watchdog"), 75)),
  ]);
  assert.equal(r, "rejected", "grace must bound body.cancel too");
});

test("overlapping no-factory bridge calls cannot run A with B signal or cross-dispatch after B abort", async () => {
  let readyA, readyB;
  const observed = [];
  const transport = {
    env,
    fetch: async (_u, i) => {
      observed.push(i.signal);
      return json({ results: [] });
    },
  };
  const base = createTavilyDescriptor({ transport });
  const descriptor = {
    ...base,
    create(ctx) {
      const a = base.create(ctx);
      return {
        ...a,
        search: {
          ...a.search,
          async invoke(req, s, c) {
            await new Promise((r) => (req.query === "a" ? (readyA = r) : (readyB = r)));
            return a.search.invoke(req, s, c);
          },
        },
      };
    },
  };
  const factory = (_id, t) => {
    const base = createTavilyDescriptor({ transport: t });
    return {
      ...base,
      create(ctx) {
        const a = base.create(ctx);
        return {
          ...a,
          search: {
            ...a.search,
            async invoke(req, s, c) {
              await new Promise((r) => (req.query === "a" ? (readyA = r) : (readyB = r)));
              return a.search.invoke(req, s, c);
            },
          },
        };
      },
    };
  };
  const o = {
    ...options(transport.fetch),
    transports: { tavily: transport },
    searchDescriptor: descriptor,
    descriptorFactory: factory,
  };
  const first = createLeanAcquisitionDeps(o),
    second = createLeanAcquisitionDeps(o);
  const aSignal = new AbortController(),
    bSignal = new AbortController();
  const a = first.search("a", { signal: aSignal.signal, timeoutMs: 100 }).then(
    () => true,
    () => false,
  );
  await new Promise((r) => setImmediate(r));
  const b = second.search("b", { signal: bSignal.signal, timeoutMs: 100 }).then(
    () => true,
    () => false,
  );
  await new Promise((r) => setImmediate(r));
  bSignal.abort();
  readyA();
  const aPassed = await a;
  readyB?.();
  await b;
  assert.equal(aPassed, true, "independent A must not inherit B abort");
  assert.equal(observed.length, 1);
  assert.equal(first.physicalLedger.attempts, 1);
  assert.equal(second.physicalLedger.attempts, 0);
});

test("legacy cache candidate decoding certifies the actual serve without physical HTTP", async () => {
  const valid = {
    schemaVersion: 1,
    url,
    finalUrl: url,
    title: null,
    content: "legacy retained",
    contentFormat: "markdown",
  };
  let calls = 0;
  const records = [];
  const fetch = async () => {
    calls++;
    return json({ results: [] });
  };
  const baseOptions = options(fetch);
  const factory = (_id, t) => {
    const base = createTavilyDescriptor({ transport: t });
    return {
      ...base,
      create(ctx) {
        const a = base.create(ctx);
        const op = a.reader.fetch;
        return {
          ...a,
          reader: {
            fetch: {
              ...op,
              cacheIdentity(req) {
                const id = op.cacheIdentity(req);
                return {
                  ...id,
                  legacyCandidates: [
                    {
                      key: "legacy-real",
                      decode(raw) {
                        return raw?.legacy === true ? valid : null;
                      },
                    },
                  ],
                };
              },
            },
          },
        };
      },
    };
  };
  const deps = createLeanAcquisitionDeps({
    ...baseOptions,
    descriptorFactory: factory,
    cache: {
      get: async (key) => (key === "legacy-real" ? { legacy: true } : null),
      set: async () => {},
    },
    onReadProvenance: (r) => records.push(r),
  });
  assert.equal(await deps.read(url), "legacy retained");
  assert.equal(calls, 0);
  assert.equal(
    records[0].fromCache,
    true,
    "candidate.decode, not decodeCached, was the serve basis",
  );
});

test("invalid argv containing a configured key is redacted at the same outward boundary", async () => {
  const rt = {
    acquisitionOptions: options(async () => json({ results: [] })),
    engineDeps: { judge: null, now: Date.now },
    invocation: { writeOut() {}, writeErr() {}, setExit() {} },
  };
  await assert.rejects(
    () => runLeanVerticalSlice(["--requirements-json", "{}", env.TAVILY_API_KEY], rt),
    (e) => !String(e.message).includes(env.TAVILY_API_KEY),
  );
});
