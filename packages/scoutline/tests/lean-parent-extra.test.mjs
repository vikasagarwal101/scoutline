import test from "node:test";
import assert from "node:assert/strict";
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
