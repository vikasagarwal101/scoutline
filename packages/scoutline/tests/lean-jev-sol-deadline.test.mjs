import test from "node:test";
import assert from "node:assert/strict";
import * as tsr from "../dist/lib/lean-typesafe-judge.js";

const ROOT =
  new URL("..", import.meta.url).pathname;
const CONFIG = {
  endpoint: "https://fixture.invalid/native",
  model: "fixture-request",
  apiKey: "fixture-key",
  timeoutMs: 100,
};
const INPUT = {
  fieldId: "csv",
  fieldQuestion: "CSV?",
  criteria: [],
  scope: {},
  candidates: ["supported"],
  documents: [
    { evidenceId: "e1", url: "https://fixture.invalid/doc", title: "Doc", content: "Supports CSV" },
  ],
};
const payload = {
  model: "jev-1.13.0",
  usage: { input_tokens: 1, output_tokens: 1 },
  answers: {
    q0r: { type: "noul", noul: 1 },
    q0s: { type: "noul", noul: 1 },
    q0f: { type: "noul", noul: 0 },
  },
};

test("successful header/body races dispose every owned timer", async () => {
  const originalSet = globalThis.setTimeout;
  const originalClear = globalThis.clearTimeout;
  const active = new Set();
  globalThis.setTimeout = (callback, delay, ...args) => {
    let handle;
    handle = originalSet(() => {
      active.delete(handle);
      callback(...args);
    }, delay);
    active.add(handle);
    return handle;
  };
  globalThis.clearTimeout = (handle) => {
    active.delete(handle);
    return originalClear(handle);
  };
  let result;
  let pending;
  try {
    const profile = tsr.createTypesafeJudge({
      apiKey: CONFIG.apiKey,
      reserveAttempt: () => {},
      timeoutMs: CONFIG.timeoutMs,
      fetchLike: async () => new Response(JSON.stringify(payload)),
    });
    result = await profile.judge(INPUT);
    pending = active.size;
  } finally {
    for (const handle of active) originalClear(handle);
    globalThis.setTimeout = originalSet;
    globalThis.clearTimeout = originalClear;
  }
  assert.ok(Array.isArray(result.documents));
  assert.equal(pending, 0, "settled races must not leave timeout handles keeping process alive");
});

test("late header response after timeout disposes its unread body", async () => {
  let cancelled = false;
  const profile = tsr.createTypesafeJudge({
    apiKey: CONFIG.apiKey,
    reserveAttempt: () => {},
    timeoutMs: 5,
    fetchLike: async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return {
        status: 200,
        ok: true,
        headers: new Headers(),
        body: new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
      };
    },
  });
  let result;
  try {
    await profile.judge(INPUT);
  } catch (error) {
    result = error;
  }
  assert.equal(result.code, "TYPESAFE_TIMEOUT");
  await new Promise((resolve) => setTimeout(resolve, 45));
  assert.equal(cancelled, true, "losing fetch promise may resolve later but cannot leak a body");
});

// Production clamp guard: the official judge clamps its attempt deadline
// to the run budget the CALLER hands it (options.timeoutMs), never to its
// own configured attempt timeout. Observed through actual settlement
// time against a stalled body — no locally computed arrays.
async function clampedDispatch(runBudgetMs, stalledBody = true) {
  let cancelled = false;
  const body = new ReadableStream({
    start(c) {
      if (!stalledBody) {
        c.enqueue(new TextEncoder().encode(JSON.stringify(payload)));
        c.close();
      }
    },
    cancel() {
      cancelled = true;
    },
  });
  const profile = tsr.createTypesafeJudge({
    apiKey: CONFIG.apiKey,
    reserveAttempt: () => {},
    timeoutMs: 15_000, // far larger than the run budget
    fetchLike: async () => ({
      status: 200,
      ok: true,
      headers: new Headers(),
      body,
    }),
  });
  const started = performance.now();
  let error;
  try {
    await profile.judge(INPUT, { timeoutMs: runBudgetMs });
  } catch (caught) {
    error = caught;
  }
  return { elapsed: performance.now() - started, error, cancelled };
}

test("run budget clamps the configured attempt timeout on a stalled body", async () => {
  const { elapsed, error, cancelled } = await clampedDispatch(10);
  assert(
    elapsed < 200,
    `a 10ms run budget must bound a 15s-configured stalled attempt; took ${elapsed.toFixed(1)}ms`,
  );
  assert.equal(error.code, "TYPESAFE_TIMEOUT");
  assert(cancelled, "the stalled reader must be cancelled, not awaited");
});

test("control: a body that completes stays inside the run budget", async () => {
  const { elapsed, error } = await clampedDispatch(1_000, false);
  assert(elapsed < 1_000, "completing bodies settle within their budget");
  assert.equal(error, undefined);
});

test("control: ordinary finite successful native response is accepted", async () => {
  const profile = tsr.createTypesafeJudge({
    apiKey: CONFIG.apiKey,
    reserveAttempt: () => {},
    timeoutMs: 5,
    fetchLike: async () => new Response(JSON.stringify(payload)),
  });
  const result = await profile.judge(INPUT);
  const metadata = result[Symbol.for("leanJevAttemptMeta")];
  assert.deepEqual(metadata.usage, { inputTokens: 1, outputTokens: 1 });
});
