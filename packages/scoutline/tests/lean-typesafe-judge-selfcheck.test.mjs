/**
 * Hermetic self-check for the direct TypeSafe native judge lifecycle.
 * Credential-free: synthetic key, fake HTTP, scrubbed env. Uses the Node
 * test runner + assert only. No framework, no fixtures.
 *
 * Run: node --test tests/lean-typesafe-judge-selfcheck.test.mjs
 */
import test from "node:test";
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

test("429 then 200 with retry settings: two admissions, truthful attempts", async () => {
  const { fetchLike, calls } = makeFetch([
    statusResponse(429, { "retry-after": "0" }),
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
    onAttempt: (e) => events.push(e.outcome),
  });
  const response = await profile.judge({ ...INPUT, documents: [INPUT.documents[0]] });
  assert.equal(calls.length, 2);
  assert.deepEqual(admissions, [0, 1], "admission before EVERY attempt including retry");
  assert.deepEqual(events, ["TYPESAFE_RATE_LIMIT", "ok"]);
  assert.ok(response.documents.length === 1);
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
  for (const status of [401, 422, 500]) {
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
      (e) => e.code !== undefined,
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
