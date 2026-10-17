/**
 * Hermetic self-check for the direct TypeSafe native judge lifecycle.
 * Credential-free: synthetic key, fake HTTP, scrubbed env. Uses the Node
 * test runner + assert only. No framework, no fixtures.
 *
 * Run: node --test tests/lean-typesafe-judge-selfcheck.test.mjs
 */
import test from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import * as tsj from "../dist/lib/lean-typesafe-judge.js";

const INPUT = {
  fieldId: "f0",
  fieldQuestion: "What is the pinned model's current version?",
  criteria: ["Explicit version statement"],
  scope: { domain: "official docs" },
  candidates: [],
  documents: [
    { evidenceId: "e0", url: "https://example.test/a", title: "A", content: "jev-1.13.0 is current." },
    { evidenceId: "e1", url: "https://example.test/b", title: "B", content: "Unrelated." },
  ],
};

function streamOf(text) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

function okResponse(answers, usage = { input_tokens: 10, output_tokens: 2 }) {
  return {
    status: 200,
    ok: true,
    headers: { get: () => null },
    body: streamOf(JSON.stringify({ model: tsj.TYPESAFE_PINNED_MODEL, answers, usage })),
  };
}

function noulAnswersFor(docCount) {
  const answers = {};
  for (let i = 0; i < docCount; i++) {
    answers[`q${i}r`] = { type: "noul", noul: 0.95 };
    answers[`q${i}s`] = { type: "noul", noul: 0.92 };
    answers[`q${i}f`] = { type: "noul", noul: 0.05 };
  }
  return answers;
}

function statusResponse(status, headers = {}) {
  return {
    status,
    ok: false,
    headers: { get: (n) => headers[n.toLowerCase()] ?? null },
    body: { cancel: () => Promise.resolve() },
  };
}

function makeFetch(script) {
  const calls = [];
  const fetchLike = async (url, init) => {
    calls.push({ url, init });
    const step = script[Math.min(calls.length - 1, script.length - 1)];
    if (typeof step === "function") return step(url, init);
    return step;
  };
  return { fetchLike, calls };
}

test("complete flow: request shape, auth, redirect refusal, normalization", async () => {
  const { fetchLike, calls } = makeFetch([okResponse(noulAnswersFor(2))]);
  let reserved = 0;
  const profile = tsj.createTypesafeJudge({
    apiKey: "synthetic-key",
    fetchLike,
    reserveAttempt: () => {
      reserved += 1;
    },
  });
  const response = await profile.judge(INPUT);
  assert.equal(reserved, 1, "exactly one physical admission");
  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(init.redirect, "error");
  assert.equal(init.headers.authorization, "Bearer synthetic-key");
  const body = JSON.parse(init.body);
  assert.equal(body.model, "jev-1.13.0");
  assert.deepEqual(Object.keys(body.questions).sort(), ["q0f", "q0r", "q0s", "q1f", "q1r", "q1s"]);
  assert.equal(body.state.sources[0].text, INPUT.documents[0].content, "source text travels as data");
  assert.deepEqual(
    response.documents.map((d) => [d.relevant, d.supportsClaim, d.refutesClaim]),
    [[true, true, false], [true, true, false]],
  );
  const meta = response[Symbol.for("leanJevAttemptMeta")];
  assert.ok(meta, "engine audit seam attached");
  assert.equal(meta.resolvedModel, "jev-1.13.0");
  assert.deepEqual(meta.usage, { inputTokens: 10, outputTokens: 2 });
  assert.equal(meta.probabilities.q0r, 0.95, "raw probabilities preserved as data");
});

test("middle-band probability is unknown, never false", async () => {
  const answers = noulAnswersFor(1);
  answers.q0r = { type: "noul", noul: 0.5 };
  const { fetchLike } = makeFetch([okResponse(answers)]);
  const profile = tsj.createTypesafeJudge({
    apiKey: "k", fetchLike, reserveAttempt: () => {},
  });
  const response = await profile.judge({ ...INPUT, documents: [INPUT.documents[0]] });
  assert.equal(response.documents[0].relevant, null);
});

test("429/529 then 200 with retry settings: two admissions, truthful attempts", async () => {
  for (const status of [429, 529]) {
    const { fetchLike, calls } = makeFetch([
      statusResponse(status, { "retry-after": "0" }),
      okResponse(noulAnswersFor(1)),
    ]);
    const admissions = [];
    const events = [];
    const profile = tsj.createTypesafeJudge({
      apiKey: "k",
      fetchLike,
      reserveAttempt: (_ctx) => admissions.push(_ctx.attempt),
      retrySettings: { maxTransientRetries: 1, baseDelayMs: 1, maxDelayMs: 5 },
      maxAttempts: 2,
      onAttempt: (e) => events.push(e),
    });
    const response = await profile.judge({ ...INPUT, documents: [INPUT.documents[0]] });
    assert.equal(calls.length, 2);
    assert.deepEqual(admissions, [0, 1], "admission before EVERY attempt including retry");
    assert.deepEqual(events.map((e) => e.outcome), [status === 429 ? "TYPESAFE_RATE_LIMIT" : "TYPESAFE_OVERLOADED", "ok"]);
    assert.deepEqual(events.map((e) => e.status), [status, 200]);
    assert.ok(response.documents.length === 1);
  }
});

test("default: no retry on 429 — terminal", async () => {
  const { fetchLike, calls } = makeFetch([statusResponse(429, { "retry-after": "0" })]);
  const profile = tsj.createTypesafeJudge({ apiKey: "k", fetchLike, reserveAttempt: () => {} });
  await assert.rejects(
    () => profile.judge({ ...INPUT, documents: [INPUT.documents[0]] }),
    (e) => e.code === "TYPESAFE_RATE_LIMIT",
  );
  assert.equal(calls.length, 1, "default maxTransientRetries=0 → one attempt");
});

test("admission refusal: zero HTTP sent", async () => {
  const { fetchLike, calls } = makeFetch([okResponse(noulAnswersFor(1))]);
  let callsToReserve = 0;
  const profile = tsj.createTypesafeJudge({
    apiKey: "k",
    fetchLike,
    reserveAttempt: () => {
      callsToReserve += 1;
      throw new Error("run budget exhausted");
    },
  });
  await assert.rejects(
    () => profile.judge({ ...INPUT, documents: [INPUT.documents[0]] }),
    (e) => e.code === "TYPESAFE_ATTEMPT_REFUSED",
  );
  assert.equal(calls.length, 0, "refused admission dispatches nothing");
  assert.equal(callsToReserve, 1);
});

test("terminal statuses: 401/422 do not retry or substitute", async () => {
  for (const [status, code] of [[401, "TYPESAFE_AUTH"], [422, "TYPESAFE_REQUEST"], [500, "TYPESAFE_PROTOCOL"]]) {
    const { fetchLike, calls } = makeFetch([statusResponse(status)]);
    const profile = tsj.createTypesafeJudge({
      apiKey: "k",
      fetchLike,
      reserveAttempt: () => {},
      retrySettings: { maxTransientRetries: 2 },
      maxAttempts: 5,
    });
    await assert.rejects(
      () => profile.judge({ ...INPUT, documents: [INPUT.documents[0]] }),
      (e) => e.code === code,
      `status ${status}`,
    );
    assert.equal(calls.length, 1, `status ${status} is terminal`);
  }
});

test("resolved model mismatch is terminal and typed", async () => {
  const wrong = {
    status: 200,
    ok: true,
    headers: { get: () => null },
    body: streamOf(
      JSON.stringify({ model: "jev-1.14.0", answers: noulAnswersFor(1), usage: { input_tokens: 1, output_tokens: 1 } }),
    ),
  };
  const { fetchLike } = makeFetch([wrong]);
  const profile = tsj.createTypesafeJudge({ apiKey: "k", fetchLike, reserveAttempt: () => {} });
  await assert.rejects(
    () => profile.judge({ ...INPUT, documents: [INPUT.documents[0]] }),
    (e) => e.code === "TYPESAFE_MODEL",
  );
});

test("non-Noul answer (choice) is a protocol failure, never translated", async () => {
  const answers = { q0r: { type: "choice", choice: "x", probabilities: { x: 1 }, confidence: 1 } };
  const { fetchLike } = makeFetch([okResponse(answers)]);
  const profile = tsj.createTypesafeJudge({ apiKey: "k", fetchLike, reserveAttempt: () => {} });
  await assert.rejects(
    () => profile.judge({ ...INPUT, documents: [INPUT.documents[0]] }),
    (e) => e.code === "TYPESAFE_PROTOCOL",
  );
});

test("network failure: remote-uncertain, never auto-retried", async () => {
  const { fetchLike, calls } = makeFetch([
    async () => {
      throw new Error("connection reset");
    },
  ]);
  const profile = tsj.createTypesafeJudge({
    apiKey: "k",
    fetchLike,
    reserveAttempt: () => {},
    retrySettings: { maxTransientRetries: 3 },
    maxAttempts: 5,
  });
  await assert.rejects(
    () => profile.judge({ ...INPUT, documents: [INPUT.documents[0]] }),
    (e) => e.code === "TYPESAFE_REMOTE_UNCERTAIN" && e.remoteWorkUncertain === true,
  );
  assert.equal(calls.length, 1, "uncertain remote work is not free work");
});

test("Retry-After larger than budget: honest stop, no shortening", async () => {
  const { fetchLike, calls } = makeFetch([statusResponse(429, { "retry-after": "60" })]);
  const profile = tsj.createTypesafeJudge({
    apiKey: "k",
    fetchLike,
    reserveAttempt: () => {},
    retrySettings: { maxTransientRetries: 2, baseDelayMs: 1 },
    maxAttempts: 3,
  });
  await assert.rejects(
    () => profile.judge({ ...INPUT, documents: [INPUT.documents[0]] }, { timeoutMs: 50 }),
    (e) => e.code === "TYPESAFE_RETRY_REFUSED",
  );
  assert.equal(calls.length, 1, "no second dispatch when the wait does not fit");
});

test("already-aborted signal: zero physical attempts", async () => {
  const { fetchLike, calls } = makeFetch([okResponse(noulAnswersFor(1))]);
  const profile = tsj.createTypesafeJudge({ apiKey: "k", fetchLike, reserveAttempt: () => {} });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => profile.judge({ ...INPUT, documents: [INPUT.documents[0]] }, { signal: controller.signal }),
    (e) => e.code === "TYPESAFE_CANCELLED",
  );
  assert.equal(calls.length, 0);
});

test("observer failure is contained: judgment stands", async () => {
  const { fetchLike } = makeFetch([okResponse(noulAnswersFor(1))]);
  const profile = tsj.createTypesafeJudge({
    apiKey: "k",
    fetchLike,
    reserveAttempt: () => {},
    onAttempt: () => {
      throw new Error("observer sink down");
    },
  });
  const response = await profile.judge({ ...INPUT, documents: [INPUT.documents[0]] });
  assert.equal(response.documents.length, 1, "valid judgment not suppressed by observer failure");
});

test("profile resolution trust boundary", async () => {
  const deps = { apiKey: "k", reserveAttempt: () => {} };
  assert.equal(tsj.resolveTypesafeJudgeProfile({ env: {}, transmitConsent: false }, deps), null);
  assert.throws(() => tsj.resolveTypesafeJudgeProfile({ env: {}, transmitConsent: true }, deps), /no TYPESAFE_API_KEY/);
  assert.throws(
    () => tsj.resolveTypesafeJudgeProfile({ env: { TYPESAFE_API_KEY: "k" }, transmitConsent: false }, deps),
    /credentials alone are not consent/,
  );
  assert.throws(
    () =>
      tsj.resolveTypesafeJudgeProfile(
        { env: { TYPESAFE_API_KEY: "k" }, transmitConsent: true, devProfileSelected: true },
        deps,
      ),
    /both selected/,
  );
  assert.throws(
    () =>
      tsj.resolveTypesafeJudgeProfile(
        { env: { TYPESAFE_API_KEY: "k", TYPESAFE_ENDPOINT: "http://localhost:1" }, transmitConsent: true },
        deps,
      ),
    /fixed official endpoint/,
  );
  assert.throws(() => tsj.resolveTypesafeJudgeProfile({ env: { TYPESAFE_API_KEY: "k" }, transmitConsent: true }, {}), /reserveAttempt/);
  const fake = makeFetch([okResponse(noulAnswersFor(1))]);
  const profile = tsj.resolveTypesafeJudgeProfile(
    { env: { TYPESAFE_API_KEY: "synthetic" }, transmitConsent: true },
    { ...deps, fetchLike: fake.fetchLike },
  );
  assert.ok(profile, "complete profile resolves");
  const composed = tsj.composeTypesafeJudgeDeps(profile);
  assert.equal(composed.judge, profile.judge, "one shared-admission profile reaches both seams");
  assert.equal(composed.candidateJudge, profile.candidateJudge);
  const nullComposed = tsj.composeTypesafeJudgeDeps(null);
  assert.deepEqual(nullComposed, { judge: null, candidateJudge: null });
});

test("candidate seam: native response shape for assessCandidates", async () => {
  const answers = { "q0s": { type: "noul", noul: 0.95 }, "q0c": { type: "noul", noul: 0.02 } };
  const { fetchLike, calls } = makeFetch([okResponse(answers)]);
  const profile = tsj.createTypesafeJudge({ apiKey: "k", fetchLike, reserveAttempt: () => {} });
  const candidateInput = {
    source: { evidenceId: "e0", url: "https://example.test/a", content: "text", fetchedAt: "2026-10-04", digest: "d" },
    fieldMeanings: { f0: "the version" },
    scope: { domain: "docs" },
    candidates: [{ fieldId: "f0", value: "1.13.0", quote: "jev-1.13.0", charRange: [0, 10] }],
    opposingContext: [],
    depBindings: {},
  };
  const response = await profile.candidateJudge(candidateInput);
  assert.equal(response.model, "jev-1.13.0");
  assert.equal(response.answers["q0s"].noul, 0.95);
  assert.deepEqual(response.usage, { inputTokens: 10, outputTokens: 2 });
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.state.fields[0].value, "1.13.0", "candidate identity via explicit paths");
});

test("request ceiling enforced before any dispatch", async () => {
  const { fetchLike, calls } = makeFetch([okResponse(noulAnswersFor(1))]);
  const profile = tsj.createTypesafeJudge({
    apiKey: "k",
    fetchLike,
    reserveAttempt: () => {},
    maxRequestBytes: 10,
  });
  await assert.rejects(
    () => profile.judge({ ...INPUT, documents: [INPUT.documents[0]] }),
    (e) => e instanceof Error && /input ceiling/.test(e.message),
  );
  assert.equal(calls.length, 0);
});


test("null body preserves dispatched deadline and cancellation outcomes", async () => {
  for (const [state, code, uncertain] of [
    ["expired", "TYPESAFE_TIMEOUT", true],
    ["cancelled", "TYPESAFE_CANCELLED", true],
    ["live", "TYPESAFE_MALFORMED", false],
  ]) {
    let clock = 0, calls = 0, admissions = 0;
    const caller = new AbortController();
    const events = [];
    const profile = tsj.createTypesafeJudge({
      apiKey: "k", now: () => clock, timeoutMs: 10,
      reserveAttempt: () => { admissions++; },
      onAttempt: (event) => events.push(event),
      fetchLike: async () => {
        calls++;
        return {
          status: 200, ok: true, headers: { get: () => null },
          get body() {
            if (state === "expired") clock = 20;
            if (state === "cancelled") caller.abort();
            return null;
          },
        };
      },
    });
    await assert.rejects(
      profile.judge(INPUT, { timeoutMs: 10, signal: caller.signal }),
      (error) => {
        assert.equal(error.code, code, state);
        assert.equal(error.attempts, 1);
        assert.equal(error.remoteWorkUncertain, state === "live" ? undefined : uncertain);
        assert.equal(Object.hasOwn(error, "remoteWorkUncertain"), state !== "live");
        return true;
      },
    );
    assert.equal(calls, 1);
    assert.equal(admissions, 1);
    assert.equal(events.length, 1);
    assert.equal(events[0].outcome, code);
    assert.equal(events[0].remoteWorkUncertain, uncertain);
  }
});


test("blank retry milliseconds preserve fallback waits and numeric zero", async () => {
  for (const [ms, seconds, retries] of [["", "0.05", false], ["  ", "0.05", false], [" ", null, false], ["0", "0.05", true]]) {
    let admissions = 0;
    const headersRead = [];
    const events = [];
    const transient = statusResponse(429);
    transient.headers.get = (name) => {
      headersRead.push(name);
      return name === "retry-after-ms" ? ms : seconds;
    };
    const { fetchLike, calls } = makeFetch([transient, okResponse(noulAnswersFor(2))]);
    const profile = tsj.createTypesafeJudge({
      apiKey: "k", now: () => 0, timeoutMs: 10, maxAttempts: 2,
      retrySettings: { maxTransientRetries: 1, baseDelayMs: 50, maxDelayMs: 50, maxRetryAfterMs: 1000 },
      reserveAttempt: () => { admissions++; }, fetchLike,
      onAttempt: (event) => events.push(event),
    });
    if (retries) {
      const result = await profile.judge(INPUT, { timeoutMs: 10 });
      assert.equal(result.documents.length, 2);
    } else {
      await assert.rejects(profile.judge(INPUT, { timeoutMs: 10 }), { code: "TYPESAFE_RETRY_REFUSED", attempts: 1 });
    }
    assert.equal(calls.length, retries ? 2 : 1);
    assert.equal(admissions, calls.length);
    assert.deepEqual(events.map((event) => event.outcome), retries ? ["TYPESAFE_RATE_LIMIT", "ok"] : ["TYPESAFE_RATE_LIMIT"]);
    assert.deepEqual(headersRead, retries ? ["retry-after-ms"] : ["retry-after-ms", "retry-after"]);
  }
});


async function withManualTimers(action) {
  const originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout;
  const pending = new Map(), scheduled = [];
  let onSchedule;
  globalThis.setTimeout = (fn, ms, ...args) => {
    const handle = {};
    pending.set(handle, () => fn(...args));
    scheduled.push(ms);
    onSchedule?.(ms);
    return handle;
  };
  globalThis.clearTimeout = (handle) => { pending.delete(handle); };
  try {
    return await action({ pending, scheduled, observe: (callback) => { onSchedule = callback; } });
  } finally {
    pending.clear();
    globalThis.setTimeout = originalSet;
    globalThis.clearTimeout = originalClear;
  }
}

test("undefined retry fields use defaults and preserve defined zero", async () => {
  const fields = ["maxTransientRetries", "baseDelayMs", "maxDelayMs", "maxRetryAfterMs"];
  for (const retrySettings of [Object.fromEntries(fields.map((key) => [key, undefined])), undefined, Object.fromEntries(fields.map((key) => [key, 0]))]) {
    const actual = await withManualTimers(async ({ pending, scheduled }) => {
      let clock = 0, calls = 0, admissions = 0, rejectFetch;
      const profile = tsj.createTypesafeJudge({
        apiKey: "k", now: () => clock, timeoutMs: 25, retrySettings,
        reserveAttempt: () => { admissions++; },
        fetchLike: () => {
          calls++;
          return new Promise((_, reject) => { rejectFetch = reject; });
        },
      });
      const work = profile.judge(INPUT);
      work.catch(() => {});
      try {
        assert.equal(pending.size, 2);
        const [handle, fire] = pending.entries().next().value;
        clock = 25;
        pending.delete(handle);
        fire();
        const error = await work.catch((error) => error);
        return { requestedTimers: [...scheduled], code: error.code, attempts: error.attempts, calls, admissions, pending: pending.size };
      } finally {
        rejectFetch?.(new Error("owned fake fetch cleanup"));
        await work.catch(() => {});
      }
    });
    assert.deepEqual(actual, { requestedTimers: [25, 25], code: "TYPESAFE_TIMEOUT", attempts: 1, calls: 1, admissions: 1, pending: 0 });
  }
  // A real transient response distinguishes default backoff from numeric zero.
  for (const baseDelayMs of [undefined, 0]) {
    await withManualTimers(async ({ pending, observe }) => {
      observe((ms) => {
        if (ms === 0) {
          const [handle, fire] = [...pending.entries()].at(-1);
          queueMicrotask(() => { pending.delete(handle); fire(); });
        }
      });
      let admissions = 0;
      const events = [];
      const { fetchLike, calls } = makeFetch([statusResponse(429), okResponse(noulAnswersFor(2))]);
      const profile = tsj.createTypesafeJudge({
        apiKey: "k", now: () => 0, timeoutMs: 10, maxAttempts: 2,
        retrySettings: { maxTransientRetries: 1, baseDelayMs, maxDelayMs: 50, maxRetryAfterMs: 1000 },
        reserveAttempt: () => { admissions++; }, fetchLike,
        onAttempt: (event) => events.push(event),
      });
      if (baseDelayMs === undefined) {
        await assert.rejects(profile.judge(INPUT, { timeoutMs: 10 }), (error) => {
          assert.equal(error.code, "TYPESAFE_RETRY_REFUSED");
          assert.equal(error.attempts, 1);
          assert.equal(error.observed.status, 429);
          return true;
        });
        assert.equal(calls.length, 1);
        assert.equal(admissions, 1);
        assert.deepEqual(events.map((event) => event.outcome), ["TYPESAFE_RATE_LIMIT"]);
        assert.deepEqual(events.map((event) => event.status), [429]);
      } else {
        let response;
        await assert.doesNotReject(async () => { response = await profile.judge(INPUT, { timeoutMs: 10 }); });
        assert.equal(response.documents.length, 2);
        assert.equal(response[Symbol.for("leanJevAttemptMeta")].attempts, 2);
        assert.equal(calls.length, 2);
        assert.equal(admissions, 2);
        assert.deepEqual(events.map((event) => event.outcome), ["TYPESAFE_RATE_LIMIT", "ok"]);
        assert.deepEqual(events.map((event) => event.status), [429, 200]);
      }
      assert.equal(pending.size, 0);
    });
  }

});


test("retry-wait cancellation retains known response facts without an observer", async () => {
  for (const [status, code, reason, expectedStopReason] of [
    [429], [529],
    [429, "EVAL_STOPPED", "global_deadline", "global_deadline"],
    [529, "EVAL_STOPPED", "global_judgment_cap", "global_judgment_cap"],
    [429, "EVAL_STOPPED", "global_extraction_cap", "global_extraction_cap"],
    [529, "ORDINARY_ABORT", "global_deadline"],
    [429, "EVAL_STOPPED", "fixture_unknown_root"],
  ]) {
    const actual = await withManualTimers(async ({ pending, scheduled, observe }) => {
      const caller = new AbortController();
      const events = [], requests = [];
      let admissions = 0, bodyCancels = 0, markWaiting;
      const waiting = new Promise((resolve) => { markWaiting = resolve; });
      observe((ms) => { if (ms === 50) markWaiting(); });
      const profile = tsj.createTypesafeJudge({
        apiKey: "k", now: () => 0, timeoutMs: 25, maxAttempts: 2,
        retrySettings: { maxTransientRetries: 1, baseDelayMs: 50, maxDelayMs: 50, maxRetryAfterMs: 1000 },
        reserveAttempt: () => { admissions++; },
        ...(status === 429 ? { onAttempt: (event) => events.push(event) } : {}),
        fetchLike: async (_url, init) => {
          requests.push(init.body);
          return { status, ok: false, headers: { get: () => null }, body: { cancel: () => { bodyCancels++; return Promise.resolve(); } } };
        },
      });
      const work = profile.judge(INPUT, { timeoutMs: 200, signal: caller.signal });
      work.catch(() => {});
      try {
        await waiting;
        caller.abort(code === undefined ? undefined : Object.assign(new Error("synthetic composed stop"), { code, reason }));
        const error = await work.catch((error) => error);
        return { code: error.code, stopReason: error.stopReason, ownStopReason: Object.hasOwn(error, "stopReason"), attempts: error.attempts, uncertain: error.remoteWorkUncertain, observed: error.observed,
          admissions, requests, events, bodyCancels, scheduled: [...scheduled], pending: pending.size };
      } finally {
        caller.abort();
        await work.catch(() => {});
      }
    });
    assert.equal(actual.code, "TYPESAFE_CANCELLED");
    assert.equal(actual.stopReason, expectedStopReason);
    assert.equal(actual.ownStopReason, expectedStopReason !== undefined);
    assert.equal(actual.attempts, 1);
    assert.equal(actual.uncertain, true);
    assert.deepEqual(actual.observed, {
      requestSha256: createHash("sha256").update(actual.requests[0]).digest("hex"),
      requestedModel: tsj.TYPESAFE_PINNED_MODEL, resolvedModel: null, status, usage: null, elapsedMs: 0,
    });
    assert.equal(actual.admissions, 1);
    assert.equal(actual.requests.length, 1);
    assert.equal(actual.bodyCancels, 1);
    assert.deepEqual(actual.scheduled, [25, 25, 50]);
    assert.equal(actual.pending, 0);
    assert.equal(actual.events.length, status === 429 ? 1 : 0);
    if (status === 429) {
      assert.equal(actual.events[0].outcome, "TYPESAFE_RATE_LIMIT");
      assert.equal(actual.events[0].status, 429);
      assert.equal(actual.events[0].attemptSha256, actual.observed.requestSha256);
    }
  }
});

test("large native deadlines retain their full wait across bounded timer chunks", { timeout: 1000 }, async (t) => {
  const maxTimer = 0x7fffffff;
  const candidateInput = {
    source: { evidenceId: "e0", url: "https://fixture.invalid/license", title: "License", content: "License MIT.", byteLength: 12, origins: [] },
    fieldMeanings: { license: "License?" }, scope: { release: "1" },
    candidates: [{ fieldId: "license", value: "MIT", quote: "License MIT", charRange: [0, 11] }],
    opposingContext: [], depBindings: {},
  };
  for (const [seam, phase] of [["judge", "header"], ["candidateJudge", "body"]]) {
    await withManualTimers(async ({ pending, scheduled, observe }) => {
      const caller = new AbortController(), events = [];
      let admissions = 0, physical = 0, signal, rejectFetch, reading = false, bodyCancels = 0, releases = 0, bodyArmed;
      const ready = new Promise((resolve) => { bodyArmed = resolve; });
      observe(() => { if (reading) bodyArmed(); });
      const profile = tsj.createTypesafeJudge({
        apiKey: "k", now: () => 0, timeoutMs: maxTimer + 1,
        reserveAttempt: () => { admissions++; }, onAttempt: (event) => events.push(event),
        fetchLike: async (_url, init) => {
          physical++; signal = init.signal;
          if (phase === "header") return await new Promise((_, reject) => { rejectFetch = reject; });
          return { status: 200, ok: true, headers: { get: () => null }, body: {
            getReader: () => ({
              read: () => { reading = true; return new Promise(() => {}); },
              cancel: () => { bodyCancels++; return Promise.resolve(); },
              releaseLock: () => { releases++; },
            }),
          } };
        },
      });
      const work = profile[seam](seam === "judge" ? INPUT : candidateInput, { timeoutMs: maxTimer + 1, signal: caller.signal });
      let settled = false;
      work.then(() => { settled = true; }, () => { settled = true; });
      try {
        if (phase === "body") await ready;
        t.diagnostic(`large-deadline-before ${JSON.stringify({ seam, phase, scheduled, admissions, physical, events, pending: pending.size })}`);
        assert(scheduled.every((ms) => ms <= maxTimer), "an admitted finite deadline must never overflow a raw Node timer");
        assert.equal(pending.size, 2);
        const [firstHandle, firstFire] = [...pending.entries()].at(-1);
        pending.delete(firstHandle); firstFire();
        await Promise.resolve();
        t.diagnostic(`large-deadline-intermediate ${JSON.stringify({ seam, phase, scheduled, admissions, physical, events, settled, aborted: signal.aborted, pending: pending.size })}`);
        assert.equal(scheduled.at(-1), 1);
        assert.equal(settled, false);
        assert.equal(signal.aborted, false);
        assert.equal(events.length, 0);
        assert.equal(admissions, 1);
        assert.equal(physical, 1);
        const [lastHandle, lastFire] = [...pending.entries()].at(-1);
        pending.delete(lastHandle); lastFire();
        const error = await work.catch((error) => error);
        t.diagnostic(`large-deadline-after ${JSON.stringify({ seam, phase, code: error.code, attempts: error.attempts, admissions, physical, events, aborted: signal.aborted, bodyCancels, releases, pending: pending.size })}`);
        assert.equal(error.code, "TYPESAFE_TIMEOUT");
        assert.equal(error.attempts, 1);
        assert.equal(signal.aborted, true);
        assert.equal(events.length, 1);
        assert.equal(events[0].outcome, "TYPESAFE_TIMEOUT");
        assert.equal(admissions, 1);
        assert.equal(physical, 1);
        assert.equal(pending.size, 0);
        assert.equal(bodyCancels, phase === "body" ? 1 : 0);
        assert.equal(releases, phase === "body" ? 1 : 0);
      } finally {
        caller.abort(); rejectFetch?.(new Error("owned fake fetch cleanup"));
        await work.catch(() => {});
      }
    });
  }
});

test("large retry waits preserve full admission delay and latest-chunk cancellation", { timeout: 1000 }, async (t) => {
  const maxTimer = 0x7fffffff;
  for (const outcome of ["complete", "cancel"]) {
    await withManualTimers(async ({ pending, scheduled, observe }) => {
      const caller = new AbortController(), events = [];
      let admissions = 0, bodyCancels = 0, markWaiting;
      const waiting = new Promise((resolve) => { markWaiting = resolve; });
      observe((ms) => { if (ms >= maxTimer) markWaiting(); });
      const transient = statusResponse(429, { "retry-after-ms": String(maxTimer + 1) });
      transient.body.cancel = () => { bodyCancels++; return Promise.resolve(); };
      const { fetchLike, calls } = makeFetch([transient, okResponse(noulAnswersFor(2))]);
      const profile = tsj.createTypesafeJudge({
        apiKey: "k", now: () => 0, timeoutMs: 25, maxAttempts: 2,
        retrySettings: { maxTransientRetries: 1, maxRetryAfterMs: maxTimer + 1 },
        reserveAttempt: () => { admissions++; }, onAttempt: (event) => events.push(event), fetchLike,
      });
      const work = profile.judge(INPUT, { signal: caller.signal });
      work.catch(() => {});
      try {
        await waiting;
        t.diagnostic(`large-retry-before ${JSON.stringify({ outcome, scheduled, admissions, physical: calls.length, events, pending: pending.size })}`);
        assert.equal(scheduled.at(-1), maxTimer);
        const [firstHandle, firstFire] = [...pending.entries()].at(-1);
        pending.delete(firstHandle); firstFire();
        await Promise.resolve();
        t.diagnostic(`large-retry-intermediate ${JSON.stringify({ outcome, scheduled, admissions, physical: calls.length, events, pending: pending.size })}`);
        assert.equal(scheduled.at(-1), 1);
        assert.equal(admissions, 1);
        assert.equal(calls.length, 1);
        assert.deepEqual(events.map((event) => event.outcome), ["TYPESAFE_RATE_LIMIT"]);
        if (outcome === "cancel") {
          const [cancelledHandle, cancelledFire] = [...pending.entries()].at(-1);
          caller.abort(Object.assign(new Error("synthetic composed stop"), { code: "EVAL_STOPPED", reason: "global_deadline" }));
          const error = await work.catch((error) => error);
          cancelledFire(); // A disposed chunk cannot re-arm or admit work.
          t.diagnostic(`large-retry-cancel ${JSON.stringify({ code: error.code, stopReason: error.stopReason, observed: error.observed, attempts: error.attempts, admissions, physical: calls.length, events, pending: pending.size })}`);
          assert.equal(error.code, "TYPESAFE_CANCELLED");
          assert.equal(error.stopReason, "global_deadline");
          assert.equal(error.attempts, 1);
          assert.equal(error.remoteWorkUncertain, true);
          assert.deepEqual(error.observed, { requestSha256: createHash("sha256").update(calls[0].init.body).digest("hex"), requestedModel: tsj.TYPESAFE_PINNED_MODEL, resolvedModel: null, status: 429, usage: null, elapsedMs: 0 });
          assert.equal(pending.has(cancelledHandle), false);
          assert.equal(admissions, 1);
          assert.equal(calls.length, 1);
          assert.equal(events.length, 1);
        } else {
          const [lastHandle, lastFire] = [...pending.entries()].at(-1);
          pending.delete(lastHandle); lastFire();
          const result = await work;
          t.diagnostic(`large-retry-complete ${JSON.stringify({ result, admissions, physical: calls.length, events, pending: pending.size })}`);
          assert.equal(result.documents.length, 2);
          assert.equal(result[Symbol.for("leanJevAttemptMeta")].attempts, 2);
          assert.equal(admissions, 2);
          assert.equal(calls.length, 2);
          assert.deepEqual(events.map((event) => event.outcome), ["TYPESAFE_RATE_LIMIT", "ok"]);
        }
        assert.equal(bodyCancels, 1);
        assert.equal(pending.size, 0);
      } finally {
        caller.abort(); await work.catch(() => {});
      }
    });
  }
});
