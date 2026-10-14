import test from "node:test";
import assert from "node:assert/strict";
const root =
  new URL("..", import.meta.url).pathname;
const { createTypesafeJudge } = await import(`${root}/dist/lib/lean-typesafe-judge.js`);
const { createLeanAcquisitionDeps } = await import(`${root}/dist/lib/lean-acquisition-bridge.js`);
const { createTavilyDescriptor } = await import(`${root}/dist/providers/tavily/adapter.js`);
const source = {
  evidenceId: "e1",
  url: "https://fixture.invalid/source",
  title: "source",
  content: "License MIT.",
  byteLength: 12,
  origins: [],
};
const candidate = {
  source,
  scope: {},
  fieldMeanings: { license: "License?" },
  opposingContext: [],
  candidates: [
    {
      fieldId: "license",
      value: "MIT",
      quote: source.content,
      charRange: [0, source.content.length],
    },
  ],
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The extractor seam is a REAL production surface: the acquisition
// bridge's bounded native read over an injected transport. Both guards
// below drive the bridge itself, not a test-local reimplementation.
function bridgeOver(fetch, extras = {}) {
  const env = { TAVILY_API_KEY: "obviously-fake", TAVILY_TIMEOUT: "1000" };
  const transport = { fetch, env };
  const descriptor = createTavilyDescriptor({ transport });
  const deps = createLeanAcquisitionDeps({
    transports: { tavily: transport },
    descriptorFactory: (_id, t) => createTavilyDescriptor({ transport: t }),
    searchDescriptor: descriptor,
    readerDescriptor: descriptor,
    env,
    cache: { get: async () => null, set: async () => {} },
    sleep: async () => {},
    random: () => 0,
    retryPolicy: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, jitterMs: 0 },
    now: Date.now,
    ...extras,
  });
  return { deps, transport };
}

test("bridge reader cancellation settles via the caller abort, not the deadline", async () => {
  // Deadline is 5s — far above the observation bound — so settling
  // ~5ms can only be the caller's abort. Typed cancellation asserted;
  // dropping the external signal would hang to the 5s deadline and RED.
  const controller = new AbortController();
  let nativeSignal;
  const pending = new Promise(() => {});
  const { deps } = bridgeOver(async (_url, init) => {
    nativeSignal = init?.signal;
    return pending;
  });
  const abortTimer = setTimeout(() => controller.abort(), 5);
  const started = performance.now();
  let failure;
  try {
    await deps.read(source.url, { signal: controller.signal, timeoutMs: 5_000 });
  } catch (error) {
    failure = error;
  }
  clearTimeout(abortTimer);
  const elapsed = performance.now() - started;
  assert(
    elapsed < 500,
    `settled in ${elapsed.toFixed(1)}ms — deadline (5s) masked the abort`,
  );
  assert(failure, "an aborted read must reject");
  assert(
    failure.code === "TIMEOUT_ERROR" || failure.name === "AbortError" || failure.code === "CANCELLED",
    `typed cancellation expected, got ${failure.code ?? failure.name}`,
  );
  assert(nativeSignal?.aborted, "the bridge must abort the transport's own signal");
});

test("official candidate judge cancellation settles via the caller abort, not the deadline", async () => {
  // 5s deadline: settling ~5ms proves the ABORT fired, and the typed
  // rejection must name cancellation; the fetch's native signal must be
  // aborted by the caller's. Dropping the signal hangs to 5s and REDs.
  const controller = new AbortController();
  let nativeSignal;
  const profile = createTypesafeJudge({
    apiKey: "obviously-fake",
    reserveAttempt: () => {},
    fetchLike: async (_url, init) => {
      nativeSignal = init?.signal;
      return new Promise(() => {});
    },
  });
  const abortTimer = setTimeout(() => controller.abort(), 5);
  const started = performance.now();
  let failure;
  try {
    await profile.candidateJudge(candidate, { timeoutMs: 5_000, signal: controller.signal });
  } catch (error) {
    failure = error;
  }
  clearTimeout(abortTimer);
  const elapsed = performance.now() - started;
  assert(
    elapsed < 500,
    `settled in ${elapsed.toFixed(1)}ms — deadline (5s) masked the abort`,
  );
  assert.equal(failure.code, "TYPESAFE_CANCELLED");
  assert(nativeSignal?.aborted, "the caller abort must reach the fetch signal");
});

test("external cancellation promptly settles actual classification wrapper even when fetch ignores its signal", async () => {
  const controller = new AbortController();
  let cancelled = false;
  let nativeSignal;
  const profile = createTypesafeJudge({
    apiKey: "obviously-fake",
    reserveAttempt: () => {},
    fetchLike: async (_url, init) => {
      nativeSignal = init.signal;
      await sleep(100);
      return {
        status: 200,
        ok: true,
        headers: { get: () => "application/json" },
        body: new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(JSON.stringify({
              model: "jev-1.13.0",
              answers: {
                q0r: { type: "noul", noul: 0.97 },
                q0s: { type: "noul", noul: 0.97 },
                q0f: { type: "noul", noul: 0.01 },
              },
              usage: { input_tokens: 1, output_tokens: 1 },
            })));
            c.close();
          },
          cancel: onCancelMarker(),
        }),
      };
      function onCancelMarker() {
        return () => {
          cancelled = true;
        };
      }
    },
  });
  const input = {
    fieldId: "csv",
    fieldQuestion: "CSV?",
    criteria: [],
    scope: {},
    candidates: ["supported"],
    documents: [{ evidenceId: "e1", url: source.url, title: "source", content: source.content }],
  };
  const judge = profile.judge;
  const timer = setTimeout(() => controller.abort(), 5);
  const started = performance.now();
  let rejected = false;
  try {
    await judge(input, { timeoutMs: 1000, signal: controller.signal });
  } catch {
    rejected = true;
  }
  clearTimeout(timer);
  assert(nativeSignal.aborted, "actual native controller not connected");
  assert(performance.now() - started < 60, "abort hook set signal but did not settle header wait");
  assert(rejected, "aborted native request returned successful judgment");
  await sleep(120);
  assert(cancelled);
});
