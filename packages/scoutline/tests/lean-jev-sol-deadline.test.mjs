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

const candidateInput = {
  source: { ...INPUT.documents[0], byteLength: 12, origins: [] },
  fieldMeanings: { csv: "CSV?" },
  scope: {},
  candidates: [{ fieldId: "csv", value: "supported", quote: "Supports CSV", charRange: [0, 12] }],
  opposingContext: [],
  depBindings: {},
};

async function controlledDeadline(method, budget, configured, expire, expectedDelay) {
  const originalSet = globalThis.setTimeout;
  const originalClear = globalThis.clearTimeout;
  const active = new Set();
  const scheduled = [];
  const caller = new AbortController();
  let ownedSignal;
  let calls = 0;
  let admissions = 0;
  let settled;
  const events = [];
  globalThis.setTimeout = (callback, delay) => {
    const timer = { callback, delay };
    active.add(timer);
    scheduled.push(timer);
    return timer;
  };
  globalThis.clearTimeout = (timer) => active.delete(timer);
  try {
    const profile = tsr.createTypesafeJudge({
      apiKey: CONFIG.apiKey,
      now: () => 0,
      timeoutMs: configured,
      reserveAttempt: () => { admissions++; },
      onAttempt: (event) => events.push(event),
      fetchLike: (_url, init) => {
        calls++;
        ownedSignal = init.signal;
        return new Promise(() => {});
      },
    });
    const options = { signal: caller.signal, ...(budget === undefined ? {} : { timeoutMs: budget }) };
    settled = profile[method](method === "judge" ? INPUT : candidateInput, options).catch((error) => error);
    assert.equal(calls, 1);
    assert.equal(admissions, 1);
    assert.equal(scheduled[0].delay, expectedDelay, `actual owned delay for ${String(budget)}`);
    if (expire) {
      const timer = scheduled[0];
      active.delete(timer);
      timer.callback();
    } else {
      caller.abort();
    }
    const error = await settled;
    assert.equal(error.code, expire ? "TYPESAFE_TIMEOUT" : "TYPESAFE_CANCELLED");
    assert.equal(error.remoteWorkUncertain, true);
    assert.equal(ownedSignal.aborted, true);
    assert.equal(caller.signal.aborted, !expire);
    assert.equal(calls, 1);
    assert.equal(events.length, 1);
    assert.equal(events[0].outcome, error.code);
    assert.equal(active.size, 0, "every owned timer is disposed");
  } finally {
    caller.abort();
    await settled;
    globalThis.setTimeout = originalSet;
    globalThis.clearTimeout = originalClear;
  }
}

for (const method of ["judge", "candidateJudge"]) {
  test(`${method}: fractional remaining budget owns timeout and abort`, async () => {
    await controlledDeadline(method, 10.5, 80, true, 10.5);
    await controlledDeadline(method, 0.5, 80, true, 1);
  });
  test(`${method}: integer, shorter attempt and invalid budget controls`, async () => {
    for (const [budget, configured, expected] of [
      [10, 80, 10], [10.5, 6, 6],
      [undefined, 80, 80], [0, 80, 80], [-1, 80, 80],
      [NaN, 80, 80], [Infinity, 80, 80], ["10.5", 80, 80],
    ]) {
      await controlledDeadline(method, budget, configured, false, expected);
    }
  });
}

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
    now: () => 0, // This control pins payload acceptance, independent of host pauses.
    fetchLike: async () => new Response(JSON.stringify(payload)),
  });
  const result = await profile.judge(INPUT);
  const metadata = result[Symbol.for("leanJevAttemptMeta")];
  assert.deepEqual(metadata.usage, { inputTokens: 1, outputTokens: 1 });
});

test("expired dispatch clock preempts both valid payload and malformed usage", async () => {
  for (const [budget, usage] of [[5, payload.usage], [10, undefined], [10, {}]]) {
    let clock = 0;
    let calls = 0;
    let ownedSignal;
    const profile = tsr.createTypesafeJudge({
      apiKey: CONFIG.apiKey,
      reserveAttempt: () => {},
      timeoutMs: budget,
      now: () => clock,
      fetchLike: async (_url, init) => {
        calls++;
        ownedSignal = init.signal;
        clock = budget + 1;
        return new Response(JSON.stringify({ ...payload, usage }));
      },
    });
    await assert.rejects(profile.judge(INPUT), (error) => error.code === "TYPESAFE_TIMEOUT");
    assert.equal(calls, 1);
    assert.equal(ownedSignal.aborted, true);
  }
});
