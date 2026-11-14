import test from "node:test";
import assert from "node:assert/strict";
import * as pure from "../dist/lib/lean-candidates.js";
import * as tsj from "../dist/lib/lean-typesafe-judge.js";

// Transport-boundary guards for the native candidate path, ported onto
// the production seams: the official direct-TypeSafe candidate judge for
// judgment validation, and the extractor-boundary contract the engine
// consumes (ExtractorDeps). The dev e2e runner's report-shape tests were
// development-only and are archived with the runner.
const config = {
  apiKey: "private-marker",
  timeoutMs: 20,
};
const source = {
  evidenceId: "s1",
  url: "https://fixture.invalid/source",
  title: "Doc",
  content: "Invoice identifier: INV-1. License: MIT",
  byteLength: 39,
  origins: [],
};
const rawOutput =
  '{"invoiceId":{"value":"INV-1","quote":"Invoice identifier: INV-1"},"license":{"value":"MIT","quote":"License: MIT"}}';
const request = {
  sourceId: source.evidenceId,
  sourceText: source.content,
  fields: [
    { id: "invoiceId", description: "Exact invoice ID" },
    { id: "license", description: "License for release 2.4.0 only" },
  ],
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
const native = (extra = {}) => ({
  model: "jev-1.13.0",
  usage: { input_tokens: 200, output_tokens: 20 },
  answers: {
    q0s: { type: "noul", noul: 0.97 },
    q0c: { type: "noul", noul: 0.01 },
    q1s: { type: "noul", noul: 0.97 },
    q1c: { type: "noul", noul: 0.01 },
  },
  ...extra,
});
const response = (payload) => new Response(JSON.stringify(payload));
function objects(v, pred, out = []) {
  if (!v || typeof v !== "object") return out;
  if (pred(v)) out.push(v);
  for (const child of Object.values(v)) objects(child, pred, out);
  return out;
}
async function judgeReject(inputArg, fetchLike) {
  const profile = tsj.createTypesafeJudge({
    apiKey: config.apiKey,
    reserveAttempt: () => {},
    fetchLike,
  });
  try {
    const value = await profile.candidateJudge(inputArg);
    return { kind: "ok", value };
  } catch (error) {
    return { kind: "error", code: error.code, observed: error.observed };
  }
}

test("extractor explicit refusal cannot produce valid candidate content", async () => {
  const attempt = {
    finishReason: "refusal",
    rawOutput,
    usage: { inputTokens: 100, outputTokens: 10 },
    observedCost: null,
  };
  const validation = pure.validateCandidates(source, attempt, {
    invoiceId: {},
    license: {},
  });
  assert.ok(
    validation.fields.every((f) => f.status !== "candidate"),
    "native refusal ignored behind apparently valid JSON",
  );
});
// Dev-only, removed per independent audit: the null-choice and
// cross-protocol chat-usage parsing guards belonged to the deleted
// development transport's response parser. The shipped seams cover the
// adjacent production invariants: refusal/finish-reason rejection lives
// in validateCandidates (test above), protocol-strict usage validation
// lives in the official judge (TYPESAFE_MALFORMED, tests below).
for (const [name, answers] of [
  ["missing", { q0s: native().answers.q0s }],
  ["extra", { ...native().answers, extra: { type: "noul", noul: 0.97 } }],
]) {
  test(`native judge ${name} answer IDs reject at the official boundary`, async () => {
    const result = await judgeReject(input, async () => response(native({ answers })));
    assert.equal(result.kind, "error");
    assert.match(result.code, /^TYPESAFE_(PROTOCOL|MALFORMED)$/);
  });
}

test("System One judge cannot substitute chat usage counters", async () => {
  const result = await judgeReject(input, async () =>
    response(native({ usage: { prompt_tokens: 200, completion_tokens: 20 } })),
  );
  assert.equal(result.kind, "error");
  assert.equal(result.code, "TYPESAFE_MALFORMED");
});
test("rejected native response conserves available request identity and measured usage", async () => {
  const result = await judgeReject(input, async () =>
    response(native({ answers: { q0s: { type: "noul", noul: 2 } } })),
  );
  assert.equal(result.kind, "error");
  assert.ok(
    objects(result, (v) => v.usage?.inputTokens === 200 && typeof v.requestSha256 === "string")
      .length > 0,
    "known failed-attempt measurement disappeared",
  );
  assert.equal(JSON.stringify(result).includes(config.apiKey), false);
});
