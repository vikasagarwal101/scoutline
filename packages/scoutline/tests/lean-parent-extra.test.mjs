import test from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { createTavilyDescriptor } from "../dist/providers/tavily/adapter.js";
import { createLeanAcquisitionDeps } from "../dist/lib/lean-acquisition-bridge.js";
const env = { TAVILY_API_KEY: "sentinel", TAVILY_TIMEOUT: "1000" };
const json = (v, status = 200) => new Response(JSON.stringify(v), { status });
const noRetry = { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, jitterMs: 0 };
function setup(fetch, extra = {}) {
  const t = { fetch, env };
  const d = createTavilyDescriptor({ transport: t });
  const o = {
    transports: { tavily: t },
    descriptorFactory: (_id, copy) => createTavilyDescriptor({ transport: copy }),
    searchDescriptor: d,
    readerDescriptor: d,
    env,
    cache: { get: async () => null, set: async () => {} },
    sleep: async () => {},
    random: () => 0,
    retryPolicy: noRetry,
    ...extra,
  };
  return { o, deps: createLeanAcquisitionDeps(o) };
}

test("missing factory rejects before any native dispatch with explicit bounded-stage error", async () => {
  let calls = 0;
  const { o } = setup(async () => {
    calls++;
    return json({ results: [] });
  });
  delete o.descriptorFactory;
  await assert.rejects(() => createLeanAcquisitionDeps(o).search("q"));
  assert.equal(calls, 0);
});

test("retry wire failure and success retain exactly two native attempts and separate outcomes", async () => {
  let calls = 0;
  const { deps } = setup(async () => (++calls === 1 ? json({}, 429) : json({ results: [] })), {
    retryPolicy: { maxRetries: 1, baseDelayMs: 0, maxDelayMs: 0, jitterMs: 0 },
  });
  assert.deepEqual(await deps.search("q"), []);
  assert.equal(calls, 2);
  assert.equal(deps.physicalLedger.attempts, 2);
  assert.deepEqual(
    deps.physicalLedger.perAttempt.map((r) => r.outcome),
    ["failed", "complete"],
  );
});

test("caller abort returning before deadline clears every bridge deadline timer", async () => {
  const timers = new Set();
  const nativeSet = globalThis.setTimeout;
  const nativeClear = globalThis.clearTimeout;
  globalThis.setTimeout = (fn, ms, ...args) => {
    let timer;
    timer = nativeSet(() => {
      timers.delete(timer);
      fn(...args);
    }, ms);
    timers.add(timer);
    return timer;
  };
  globalThis.clearTimeout = (timer) => {
    timers.delete(timer);
    return nativeClear(timer);
  };
  let release;
  const { deps } = setup(() => new Promise((r) => (release = r)));
  const controller = new AbortController();
  const pending = deps.search("q", { signal: controller.signal, timeoutMs: 1000 });
  await new Promise((r) => setImmediate(r));
  controller.abort();
  try {
    await assert.rejects(() => pending);
    assert.equal(deps.physicalLedger.perAttempt[0].outcome, "unknown");
    assert.equal(timers.size, 0, "lost outer race must dispose inner deadline timer");
  } finally {
    release?.(json({ results: [] }));
    for (const t of timers) nativeClear(t);
    globalThis.setTimeout = nativeSet;
    globalThis.clearTimeout = nativeClear;
    await pending.catch(() => {});
  }
});

test("body limit cancellation cannot await a producer cancel promise beyond the local deadline", async () => {
  let resolveCancel;
  let cancelled = false;
  const { deps } = setup(
    async () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(" ".repeat(20)));
          },
          cancel() {
            cancelled = true;
            return new Promise((r) => (resolveCancel = r));
          },
        }),
      ),
    { maxResponseBytes: 10 },
  );
  const pending = deps.search("q", { signal: new AbortController().signal, timeoutMs: 15 });
  try {
    const status = await Promise.race([
      pending.then(
        () => "resolved",
        () => "rejected",
      ),
      new Promise((r) => setTimeout(() => r("watchdog"), 70)),
    ]);
    assert.equal(status, "rejected", "cleanup wait must not destroy the whole-run deadline");
    assert.equal(cancelled, true);
  } finally {
    resolveCancel?.();
    await pending.catch(() => {});
  }
});


for (const phase of ["retry", "cache", "reservation"]) {
  test(`L4 dispatch admission: ${phase} cannot spend the remaining operation deadline`, async () => {
    const originalNow = Date.now;
    let now = 1000;
    Date.now = () => now;
    let calls = 0;
    let sleeps = 0;
    let reservations = 0;
    const extra = {
      reservePhysicalAttempt() {
        reservations++;
        if (phase === "reservation") now = 1200;
      },
      ...(phase === "retry" ? {
        retryPolicy: { ...noRetry, maxRetries: 1 },
        sleep: async () => { sleeps++; now = 1200; },
      } : {}),
      ...(phase === "cache" ? {
        cache: { get: async () => { now = 1200; return null; }, set: async () => {} },
      } : {}),
    };
    const { deps } = setup(async () => {
      calls++;
      return phase === "retry" && calls === 1 ? json({}, 429) : json({ results: [] });
    }, extra);
    try {
      await assert.rejects(
        () => deps.search("q", { timeoutMs: 100 }),
        (error) => error?.code === "TIMEOUT_ERROR" && error.durationMs === 0 && error.message === "Request timed out after 0ms",
      );
      assert.equal(calls, phase === "retry" ? 1 : 0, "expired allowance must not dispatch native fetch");
      assert.equal(reservations, phase === "retry" || phase === "reservation" ? 1 : 0);
      assert.equal(sleeps, phase === "retry" ? 1 : 0);
      assert.equal(deps.physicalLedger.attempts, calls);
      assert.ok(deps.physicalLedger.perAttempt.every((row) => row.outcome !== "complete"));
      if (phase === "reservation") assert.equal(deps.physicalLedger.perAttempt.at(-1).outcome, "not-started");
    } finally {
      Date.now = originalNow;
    }
  });
}


for (const phase of ["probe", "cache", "sleep"]) {
  test(`L4 operation budget: cancellation settles a pending ${phase} without late publication`, async () => {
    const controller = new AbortController();
    let entered;
    const ready = new Promise((resolve) => { entered = resolve; });
    let release;
    let gets = 0;
    let calls = 0;
    const provenance = [];
    const url = "https://offline.test/cached";
    const value = { schemaVersion: 1, url, finalUrl: url, title: null, content: "Harmless cached text", contentFormat: "markdown" };
    const { deps } = setup(async () => { calls++; return json({}, 429); }, {
      cache: {
        get: async () => {
          gets++;
          if ((phase === "probe" && gets === 1) || (phase === "cache" && gets === 2)) {
            entered();
            return new Promise((resolve) => { release = () => resolve(value); });
          }
          return phase === "probe" ? value : null;
        },
        set: async () => {},
      },
      onReadProvenance: (row) => provenance.push(row),
      ...(phase === "sleep" ? {
        retryPolicy: { ...noRetry, maxRetries: 1 },
        sleep: async () => { entered(); return new Promise((resolve) => { release = resolve; }); },
      } : {}),
    });
    const pending = (phase === "sleep"
      ? deps.search("q", { signal: controller.signal, timeoutMs: 1000 })
      : deps.read(url, { signal: controller.signal, timeoutMs: 1000 }))
      .then((result) => ({ kind: "success", result }), (error) => ({ kind: "error", error }));
    await ready;
    controller.abort();
    try {
      const settled = await Promise.race([pending, new Promise((resolve) => setImmediate(() => resolve({ kind: "pending" })))]);
      assert.equal(settled.kind, "error", "caller abort must settle locally without releasing cache/sleep work");
      assert.equal(settled.error.code, "TIMEOUT_ERROR");
      assert.equal(calls, phase === "sleep" ? 1 : 0);
      assert.equal(deps.physicalLedger.attempts, calls);
      assert.deepEqual(provenance, []);
    } finally {
      release();
      await pending;
    }
  });
}

test("L4 operation budget: the original allowance expires during a cache probe", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  let entered;
  const ready = new Promise((resolve) => { entered = resolve; });
  let release;
  let calls = 0;
  let gets = 0;
  const provenance = [];
  const url = "https://offline.test/cached";
  const value = { schemaVersion: 1, url, finalUrl: url, title: null, content: "Harmless cached text", contentFormat: "markdown" };
  const { deps } = setup(async () => { calls++; return json({ results: [] }); }, {
    cache: { get: async () => { gets++; if (gets === 1) { entered(); return new Promise((resolve) => { release = () => resolve(value); }); } return value; }, set: async () => {} },
    onReadProvenance: (row) => provenance.push(row),
  });
  let settled = false;
  const pending = deps.read(url, { timeoutMs: 100 }).then(
    (result) => { settled = true; return { kind: "success", result }; },
    (error) => { settled = true; return { kind: "error", error }; },
  );
  await ready;
  try {
    t.mock.timers.tick(99);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    t.mock.timers.tick(1);
    const outcome = await Promise.race([pending, new Promise((resolve) => setImmediate(() => resolve({ kind: "pending" })))]);
    assert.equal(outcome.kind, "error", "cache work must settle at the original allowance without a native request");
    assert.equal(outcome.error.code, "TIMEOUT_ERROR");
    assert.equal(calls, 0);
    assert.deepEqual(provenance, []);
  } finally {
    release();
    await pending;
  }
});

for (const reader of ["json", "text"]) {
  test(`L4 stream contract: non-stream ${reader} fails before calling its own reader`, async () => {
    let ownReads = 0;
    let calls = 0;
    const payload = JSON.stringify({ results: [] });
    assert.ok(Buffer.byteLength(payload) > 10);
    const { deps } = setup(async () => {
      calls++;
      return {
        ok: true,
        status: 200,
        text: async () => { ownReads++; return payload; },
        ...(reader === "json" ? { json: async () => { ownReads++; return { results: [] }; } } : {}),
      };
    }, { maxResponseBytes: 10 });
    await assert.rejects(() => deps.search("q", { timeoutMs: 1000 }), { code: "API_ERROR", statusCode: 500 });
    assert.equal(ownReads, 0, "unsupported shape must be refused before unbounded own-reader work");
    assert.equal(calls, 1);
    assert.equal(deps.physicalLedger.attempts, 1);
    assert.deepEqual(deps.physicalLedger.perAttempt.map(row => row.outcome), ["failed"]);
  });
}

for (const over of [false, true]) {
  test(`L4 stream boundary: ${over ? "over cap rejects" : "exact cap accepts"} with native byte accounting`, async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ results: [] }));
    let pulls = 0;
    let cancellations = 0;
    const stream = new ReadableStream({
      pull(controller) {
        pulls++;
        if (pulls <= 2) controller.enqueue(bytes.slice((pulls - 1) * 7, pulls * 7));
        else controller.close();
      },
      cancel() { cancellations++; },
    }, { highWaterMark: 0 });
    const { deps } = setup(async () => new Response(stream), { maxResponseBytes: bytes.byteLength - (over ? 1 : 0) });
    if (over) await assert.rejects(() => deps.search("q"), { code: "API_ERROR", statusCode: 500 });
    else assert.deepEqual(await deps.search("q"), []);
    assert.equal(cancellations, over ? 1 : 0);
    assert.equal(pulls, over ? 2 : 3);
    assert.equal(stream.locked, false);
    assert.equal(deps.physicalLedger.attempts, 1);
    assert.deepEqual(deps.physicalLedger.perAttempt.map(row => row.outcome), [over ? "failed" : "complete"]);
  });
}

for (const phase of ["headers", "body", "cache-write", "cache-hit"]) {
  test(`L4 completion guard: ${phase} expiry cannot publish success or invent native failure`, async () => {
    const originalNow = Date.now;
    let now = 1000;
    Date.now = () => now;
    let calls = 0;
    let gets = 0;
    let writes = 0;
    const provenance = [];
    const url = "https://offline.test/completion";
    const cached = { schemaVersion: 1, url, finalUrl: url, title: null, content: "Harmless cached text", contentFormat: "markdown" };
    const payload = { results: [{ url, raw_content: cached.content }] };
    const { deps } = setup(async () => {
      calls++;
      if (phase === "headers") now = 1200;
      if (phase !== "body") return json(payload);
      return new Response(new ReadableStream({ start(controller) {
        now = 1200;
        controller.enqueue(new TextEncoder().encode(JSON.stringify(payload)));
        controller.close();
      } }));
    }, {
      cache: {
        get: async () => {
          gets++;
          if (phase === "cache-hit") { if (gets === 2) now = 1200; return cached; }
          return null;
        },
        set: async () => { writes++; if (phase === "cache-write") now = 1200; },
      },
      onReadProvenance: row => provenance.push(row),
    });
    try {
      await assert.rejects(() => deps.read(url, { timeoutMs: 100 }));
      assert.deepEqual(provenance, [], "expired logical operation cannot publish read provenance");
      assert.equal(calls, phase === "cache-hit" ? 0 : 1);
      assert.equal(writes, phase === "cache-write" ? 1 : 0);
      assert.equal(deps.physicalLedger.attempts, calls);
      // These tiny synchronous wire bodies actually completed and normalized
      // before the outer cache/publication guard rejected. Preserve that fact.
      assert.deepEqual(deps.physicalLedger.perAttempt.map(row => row.outcome), phase === "cache-hit" ? [] : ["complete"]);
    } finally { Date.now = originalNow; }
  });
}

for (const phase of ["probe", "cache", "sleep", "write"]) {
  test(`L4 late collaborator: ${phase} rejection after abort has no timer listener or unhandled rejection`, async () => {
    const timers = new Set();
    const unhandled = [];
    const nativeSet = globalThis.setTimeout;
    const nativeClear = globalThis.clearTimeout;
    const controller = new AbortController();
    globalThis.setTimeout = (fn, ms, ...args) => { let timer; timer = nativeSet(() => { timers.delete(timer); fn(...args); }, ms); timers.add(timer); return timer; };
    globalThis.clearTimeout = timer => { timers.delete(timer); return nativeClear(timer); };
    const onUnhandled = error => unhandled.push(error);
    process.on("unhandledRejection", onUnhandled);
    let entered;
    const ready = new Promise(resolve => { entered = resolve; });
    let rejectLate;
    const pause = () => { entered(); return new Promise((_resolve, reject) => { rejectLate = reject; }); };
    let gets = 0;
    let calls = 0;
    const provenance = [];
    const url = "https://offline.test/cleanup";
    const { deps } = setup(async () => { calls++; return phase === "sleep" ? json({}, 429) : json({ results: [{ url, raw_content: "Harmless cleanup text" }] }); }, {
      cache: { get: async () => { gets++; return (phase === "probe" && gets === 1) || (phase === "cache" && gets === 2) ? pause() : null; }, set: async () => phase === "write" ? pause() : undefined },
      ...(phase === "sleep" ? { retryPolicy: { ...noRetry, maxRetries: 1 }, sleep: pause } : {}),
      onReadProvenance: row => provenance.push(row),
    });
    const pending = (phase === "sleep" ? deps.search("q", { signal: controller.signal, timeoutMs: 1000 }) : deps.read(url, { signal: controller.signal, timeoutMs: 1000 })).then(() => "success", () => "rejected");
    try {
      await ready;
      controller.abort();
      assert.equal(await pending, "rejected");
      assert.equal(timers.size, 0);
      assert.equal(getEventListeners(controller.signal, "abort").length, 0);
      assert.deepEqual(provenance, []);
      assert.equal(calls, phase === "write" || phase === "sleep" ? 1 : 0);
      rejectLate(new Error("ordinary late collaborator rejection"));
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(unhandled, []);
      assert.equal(timers.size, 0);
      assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    } finally {
      rejectLate?.(new Error("cleanup"));
      await pending;
      for (const timer of timers) nativeClear(timer);
      globalThis.setTimeout = nativeSet;
      globalThis.clearTimeout = nativeClear;
      process.removeListener("unhandledRejection", onUnhandled);
    }
  });
}

test("L4 cache positive: valid normalized serve retains provenance with zero native attempts", async () => {
  const url = "https://offline.test/warm";
  const value = { schemaVersion: 1, url, finalUrl: url, title: null, content: "Harmless warm text", contentFormat: "markdown" };
  const provenance = [];
  let calls = 0;
  const { deps } = setup(async () => { calls++; return json({}); }, { cache: { get: async () => value, set: async () => {} }, onReadProvenance: row => provenance.push(row) });
  assert.equal(await deps.read(url), value.content);
  assert.equal(calls, 0);
  assert.equal(deps.physicalLedger.attempts, 0);
  assert.deepEqual(deps.physicalLedger.perAttempt, []);
  assert.equal(provenance.length, 1);
  assert.equal(provenance[0].fromCache, true);
  assert.equal(provenance[0].cacheProbeWarm, true);
});

for (const phase of ["success", "deadline", "abort"]) {
  test(`L4 ledger admission: native dispatch precedes ${phase} observer`, async () => {
    const originalNow = Date.now;
    let now = 1000;
    Date.now = () => now;
    const controller = new AbortController();
    const events = [];
    const snapshots = [];
    let calls = 0;
    let reservations = 0;
    let cacheWrites = 0;
    let nativeSignal;
    const { deps } = setup((_input, init) => {
      calls++;
      nativeSignal = init.signal;
      events.push({ kind: "native", at: Date.now(), calls });
      if (phase === "abort") {
        return new Promise((_resolve, reject) => {
          nativeSignal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        });
      }
      return Promise.resolve(json({ results: [] }));
    }, {
      reservePhysicalAttempt() { reservations++; },
      cache: { get: async () => null, set: async () => { cacheWrites++; } },
      onPhysicalLedger(ledger) {
        snapshots.push({ calls, at: Date.now(), ledger });
        if (ledger.perAttempt.length === 1 && ledger.perAttempt[0].outcome === "unknown" && events.every((event) => event.kind !== "observer")) {
          events.push({ kind: "observer", at: Date.now(), calls });
          if (phase === "deadline") now = 1200;
          if (phase === "abort") controller.abort();
        }
      },
    });
    try {
      const outcome = await deps.search("q", { signal: controller.signal, timeoutMs: 100 }).then(
        (result) => ({ result }), (error) => ({ error }),
      );
      assert.deepEqual(events, [
        { kind: "native", at: 1000, calls: 1 },
        { kind: "observer", at: 1000, calls: 1 },
      ], "the documented after-dispatch sink cannot consume native admission time or see a ghost counted attempt");
      assert.equal(calls, 1);
      assert.equal(reservations, 1);
      assert.ok(snapshots.every((snapshot) => snapshot.ledger.attempts === snapshot.calls), "every public snapshot counts actual invocations");
      assert.equal(deps.physicalLedger.attempts, 1);
      assert.equal(deps.physicalLedger.perAttempt.length, 1);
      assert.equal(deps.physicalLedger.reservationsRefused, 0);
      if (phase === "success") {
        assert.deepEqual(outcome.result, []);
        assert.equal(outcome.error, undefined);
        assert.equal(cacheWrites, 1);
      } else {
        assert.equal(outcome.result, undefined, "adverse observer cannot publish a logical success");
        assert.equal(outcome.error?.code, "TIMEOUT_ERROR");
        assert.equal(outcome.error?.durationMs, phase === "deadline" ? 0 : 1000);
        assert.equal(cacheWrites, 0);
      }
      assert.equal(deps.physicalLedger.perAttempt[0].outcome, phase === "abort" ? "unknown" : "complete", "completed wire remains complete after later logical deadline refusal");
      assert.equal(nativeSignal.aborted, true, "the operation releases its child signal");
      assert.equal(getEventListeners(controller.signal, "abort").length, 0);
      assert.equal(getEventListeners(nativeSignal, "abort").length, 0);
    } finally {
      controller.abort();
      Date.now = originalNow;
    }
  });
}
