/**
 * Direct-call deadline contract of the acquisition bridge (#300).
 *
 * A direct `timeoutMs` becomes the operation's deadline, and what remains of
 * it is handed to a native timer. Node coerces a NaN, infinite or
 * larger-than-2^31-1 delay to 1 ms, so those values used to start a paid
 * request under a timer that expired at once. They must be refused before any
 * paid work; the ceiling itself, the implicit default, an already-expired
 * allowance and cancellation keep their behavior.
 *
 * Every case runs on a fake clock and records each delay handed to the timer.
 * That is the bridge's own deadline, told apart from the adapter's shorter
 * `TAVILY_TIMEOUT`, so no case fast-forwards through an unrelated deadline.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createTavilyDescriptor } from "../dist/providers/tavily/adapter.js";
import { createLeanAcquisitionDeps } from "../dist/lib/lean-acquisition-bridge.js";

/** Largest delay Node's timers schedule as asked. */
const NATIVE_TIMER_MAX_MS = 2 ** 31 - 1;
const DEFAULT_TIMEOUT_MS = 60_000;
/** A regression must fail, never stall the gate. */
const GUARD = { timeout: 10_000 };
const NO_DISPATCH_OPTIONS = Symbol("no dispatch options");
const T0 = 1000;
const env = { TAVILY_API_KEY: "synthetic", TAVILY_TIMEOUT: "1000" };
const url = "https://offline.test/source";
const payload = { results: [{ url, title: "Title", content: "Harmless text", raw_content: "Harmless text" }] };
const settle = (promise) => promise.then((value) => ({ value }), (error) => ({ error }));
const flush = () => new Promise((resolve) => setImmediate(resolve));
/** The settled outcome once pending has had a turn, else "pending". */
const drained = (pending) => Promise.race([pending, flush().then(() => "pending")]);

/** Fake clock (t0 = T0) over a transport whose fetch answers promptly unless
 *  `fetch` says otherwise, and an instrumented cache. `delays` records every
 *  delay handed to the timer; `count()` is [fetch dispatches, reservations,
 *  ledger rows]; `cacheTouches()` is cache reads plus writes. */
function fixture(t, fetch = async () => new Response(JSON.stringify(payload), { status: 200 })) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: T0 });
  const delays = [];
  const arm = globalThis.setTimeout;
  globalThis.setTimeout = (callback, ms, ...rest) => {
    delays.push(ms);
    return arm(callback, ms, ...rest);
  };
  let calls = 0;
  let reservations = 0;
  let reads = 0;
  let writes = 0;
  const transport = { env, fetch(...args) { calls++; return fetch(...args); } };
  const descriptor = createTavilyDescriptor({ transport });
  const deps = createLeanAcquisitionDeps({
    transports: { tavily: transport },
    descriptorFactory: (_id, copy) => createTavilyDescriptor({ transport: copy }),
    searchDescriptor: descriptor,
    readerDescriptor: descriptor,
    env,
    cache: {
      get: async () => { reads++; return null; },
      set: async () => { writes++; },
    },
    sleep: async () => {},
    random: () => 0,
    retryPolicy: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, jitterMs: 0 },
    reservePhysicalAttempt() { reservations++; },
  });
  return {
    deps,
    delays,
    count: () => [calls, reservations, deps.physicalLedger.perAttempt.length],
    cacheTouches: () => reads + writes,
    cacheUsed: () => reads > 0 && writes > 0,
  };
}

const invoke = (deps, method, options) =>
  method === "search" ? deps.search("q", options) : deps.read(url, options);

for (const method of ["search", "read"]) {
  // [label, timeoutMs, error code when refused, else the deadline armed in ms]
  for (const [label, timeoutMs, expected] of [
    ["NaN", NaN, "VALIDATION_ERROR"],
    ["Infinity", Infinity, "VALIDATION_ERROR"],
    ["above the native timer ceiling", NATIVE_TIMER_MAX_MS + 1, "VALIDATION_ERROR"],
    // Not invalid input: an allowance that has already expired.
    ["of zero", 0, "TIMEOUT_ERROR"],
    ["at the native timer ceiling", NATIVE_TIMER_MAX_MS, NATIVE_TIMER_MAX_MS],
    ["omitted along with the dispatch options", NO_DISPATCH_OPTIONS, DEFAULT_TIMEOUT_MS],
    ["undefined", undefined, DEFAULT_TIMEOUT_MS],
    // Untyped callers only: the declared type requires a number.
    ["null", null, DEFAULT_TIMEOUT_MS],
  ]) {
    const refused = typeof expected === "string";
    test(`direct ${method} timeout ${label} ${refused ? "is refused before any paid work" : `arms exactly a ${expected} ms deadline`}`,
      GUARD, async (t) => {
        const { deps, delays, count, cacheTouches, cacheUsed } = fixture(t);
        const { error } = await settle(invoke(deps, method, timeoutMs === NO_DISPATCH_OPTIONS
          ? undefined : { signal: new AbortController().signal, timeoutMs }));
        if (refused) {
          assert.equal(error?.code, expected);
          assert.deepEqual([count(), delays, cacheTouches()], [[0, 0, 0], [], 0],
            "no cache read or write, reservation, dispatch, ledger row or timer");
        } else {
          assert.equal(error, undefined);
          assert.ok(cacheUsed(), "the same call reads and writes the cache when it is valid");
          assert.equal(Math.max(...delays), expected, "the largest delay handed to the timer is the deadline itself");
          assert.deepEqual(count(), [1, 1, 1]);
        }
      });
  }

  test(`direct ${method} cancellation does not wait for the deadline`, GUARD, async (t) => {
    const controller = new AbortController();
    let entered;
    const ready = new Promise((resolve) => { entered = resolve; });
    // The transport reports its entry and then never answers.
    const { deps } = fixture(t, () => { entered(); return new Promise(() => {}); });
    const deadline = 5000;
    const pending = settle(invoke(deps, method, { signal: controller.signal, timeoutMs: deadline }));
    assert.equal(await Promise.race([ready.then(() => "in flight"), pending]), "in flight",
      "the request must be waiting on the transport before it is cancelled");
    controller.abort();
    // Only the bridge's bounded abort and disposal grace: well under both the
    // adapter's 1 s timeout and the operation deadline.
    t.mock.timers.tick(100);
    await flush();
    t.mock.timers.tick(100);
    const { error } = await drained(pending);
    assert.equal(error?.code, "TIMEOUT_ERROR");
    assert.equal(error?.durationMs, 0, "cancelled by the caller, not expired");
    assert.ok(Date.now() < T0 + deadline, "settled without advancing to the operation deadline");
  });
}
