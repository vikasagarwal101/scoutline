import test from "node:test";
import assert from "node:assert/strict";
import * as pure from "../dist/lib/lean-candidates.js";
import * as tsj from "../dist/lib/lean-typesafe-judge.js";

// Reservation/measurement invariants for the native candidate path,
// ported onto the official candidate judge over a fake fetch. The dev
// e2e runner's report-shape assertions are archived with the runner.
const rawOutput =
  '{"invoiceId":{"value":"INV-1","quote":"Invoice identifier: INV-1"},"license":{"value":"MIT","quote":"License: MIT"}}';
const source = {
  evidenceId: "s1",
  url: "https://fixture.invalid/source",
  title: "Doc",
  content: "Invoice identifier: INV-1. License: MIT",
  byteLength: 39,
  origins: [],
};
const validated = pure.validateCandidates(
  source,
  { finishReason: "stop", rawOutput },
  { invoiceId: {}, license: {} },
);
const input = {
  source,
  fieldMeanings: { invoiceId: "Exact invoice", license: "Scoped license" },
  scope: { release: "2.4.0" },
  candidates: validated.fields,
  opposingContext: [],
};
const judgeOk = (extra = {}) => ({
  model: "jev-1.13.0",
  usage: { input_tokens: 200, output_tokens: 20 },
  answers: Object.fromEntries(
    validated.fields.flatMap((_, i) => [
      [`q${i}s`, { type: "noul", noul: 0.97 }],
      [`q${i}c`, { type: "noul", noul: 0.01 }],
    ]),
  ),
  ...extra,
});
const response = (payload) => new Response(JSON.stringify(payload));
async function runJudge(fetchLike, deps = {}) {
  const profile = tsj.createTypesafeJudge({
    apiKey: "secret-marker",
    reserveAttempt: () => {},
    fetchLike,
    ...deps,
  });
  return profile.candidateJudge(input);
}
async function rejectWith(fetchLike, deps = {}) {
  try {
    await runJudge(fetchLike, deps);
    return undefined;
  } catch (error) {
    return error;
  }
}

test("validated candidate trail survives native judge failure", async () => {
  // The engine-facing invariant: a candidate's value/quote/charRange/
  // sourceDigest are validated BEFORE the judge runs, so a rejected
  // judgment cannot destroy the trail.
  for (const c of validated.fields) {
    assert.ok(c.value);
    assert.ok(c.quote);
    assert.ok(Array.isArray(c.charRange) || c.charRange === undefined);
  }
  assert.equal(typeof validated.sourceDigest, "string");
  const error = await rejectWith(async () => response(judgeOk({ answers: {} })));
  assert(error, "protocol-invalid judgment must reject");
});

test("rejected native judge conserves measured usage and request identity", async () => {
  const error = await rejectWith(async () => response(judgeOk({ answers: { q0s: { type: "noul", noul: 2 } } })));
  assert(error);
  assert.equal(error.observed?.usage?.inputTokens, 200);
  assert.equal(error.observed?.status, 200);
  assert.equal(typeof error.observed?.requestSha256, "string");
});

test("model mismatch conserves safely parsed status/hash/usage despite rejection", async () => {
  const error = await rejectWith(async () =>
    response({
      model: "unexpected-model",
      usage: { input_tokens: 200, output_tokens: 20 },
      answers: judgeOk().answers,
    }),
  );
  assert.equal(error.code, "TYPESAFE_MODEL");
  assert.equal(error.observed?.usage?.inputTokens, 200);
  assert.equal(error.observed?.status, 200);
  assert.equal(typeof error.observed?.requestSha256, "string");
});

test("observed cost stays unknown when the protocol supplies none", async () => {
  const result = await runJudge(async () => response(judgeOk()));
  assert.equal(result.observedCost ?? null, null);
});

test("control: reservation precedes every dispatch and refuses over cap", async () => {
  let admitted = 0;
  const profile = tsj.createTypesafeJudge({
    apiKey: "secret-marker",
    reserveAttempt: () => {
      admitted += 1;
      if (admitted > 2) {
        throw Object.assign(new Error("cap"), { code: "EVAL_STOPPED", reason: "global_judgment_cap" });
      }
    },
    fetchLike: async () => response(judgeOk()),
  });
  const outcomes = [];
  for (let i = 0; i < 3; i++) {
    try {
      await profile.candidateJudge(input);
      outcomes.push("ok");
    } catch (error) {
      outcomes.push(error.code);
    }
  }
  assert.deepEqual(
    outcomes.slice(0, 2),
    ["ok", "ok"],
    "the first two admissions dispatch",
  );
  assert.equal(outcomes[2], "TYPESAFE_ATTEMPT_REFUSED", "the third admission must refuse");
});

test("run budget clamps the configured per-attempt timeout on a stalled body", async () => {
  let cancelled = false;
  const profile = tsj.createTypesafeJudge({
    apiKey: "secret-marker",
    reserveAttempt: () => {},
    timeoutMs: 15_000,
    fetchLike: async () => ({
      status: 200,
      ok: true,
      headers: { get: () => "application/json" },
      body: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('{"model":'));
        },
        cancel() {
          cancelled = true;
        },
      }),
    }),
  });
  const start = performance.now();
  let error;
  try {
    await profile.candidateJudge(input, { timeoutMs: 10 });
  } catch (caught) {
    error = caught;
  }
  const elapsed = performance.now() - start;
  assert(
    elapsed < 200,
    `a 10ms run budget must bound a 15s-configured stalled attempt; took ${elapsed.toFixed(1)}ms`,
  );
  assert.equal(error.code, "TYPESAFE_TIMEOUT");
  assert(cancelled, "the stalled reader must be cancelled");
});
