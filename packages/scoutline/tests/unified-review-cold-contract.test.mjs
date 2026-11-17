import test from "node:test";
import assert from "node:assert/strict";
import { inputs } from "./unified-review-corpus.mjs";
import { offlineDeps } from "./unified-review-offline-deps.mjs";
const root =
  new URL("..", import.meta.url).pathname;
const { runLeanInvestigation } = await import(`${root}/dist/lib/lean-investigation.js`);
const { validateCandidates, assessCandidates, acceptCandidate } = await import(
  `${root}/dist/lib/lean-candidates.js`
);
test("common evidence criteria reach string extraction and candidate judgment", async () => {
  const c = structuredClone(inputs[0]);
  c.contract.requirements = { version: c.contract.requirements.version };
  const criterion = "Only an independently audited release attestation qualifies.";
  c.contract.evidence = { criteria: [criterion] };
  const { deps, calls } = offlineDeps(c);
  await runLeanInvestigation(c.contract, deps);
  assert(calls.extract.length && calls.candidateJudge.length);
  assert(
    calls.extract.every((x) => JSON.stringify(x).includes(criterion)),
    "common mandatory criteria missing in extractor input",
  );
  assert(
    calls.candidateJudge.every((x) => JSON.stringify(x).includes(criterion)),
    "common mandatory criteria missing in judgment input",
  );
});
test("actual candidate judgment attempts retain request identity, raw scores and usage in result audit", async () => {
  const c = structuredClone(inputs[0]);
  c.contract.requirements = { version: c.contract.requirements.version };
  const { deps, calls } = offlineDeps(c);
  const judge = deps.candidateJudge;
  deps.candidateJudge = async (input) => {
    const r = await judge(input);
    r.answers.q0c.noul = 0.5;
    return r;
  };
  const result = await runLeanInvestigation(c.contract, deps);
  const row = result.requirements.version;
  assert(calls.candidateJudge.length > 0);
  assert.equal(row.judgmentCount, calls.candidateJudge.length);
  assert(
    row.attemptedRecords.length >= calls.candidateJudge.length,
    "physical candidate judgments absent from append-only attempted audit",
  );
  const text = JSON.stringify(row.attemptedRecords);
  assert(text.includes("requestSha256") && text.includes("inputTokens") && text.includes("0.5"));
});
test("candidate assessment cannot authorize acceptance under changed accepted dependency revision", async () => {
  const source = {
    evidenceId: "e1",
    url: "https://fixture.invalid/guide",
    title: "guide",
    content: "Release 2.4 license MIT.",
    byteLength: 24,
    origins: [],
  };
  const validation = validateCandidates(
    source,
    {
      finishReason: "stop",
      rawOutput: JSON.stringify({ license: { value: "MIT", quote: source.content } }),
    },
    { license: {} },
  );
  const field = validation.fields[0];
  const input = {
    source,
    fieldMeanings: { license: "license for accepted version" },
    scope: {},
    candidates: [
      { fieldId: "license", value: field.value, quote: field.quote, charRange: field.charRange },
    ],
    opposingContext: [],
    depBindings: { version: { value: "2.4", evidenceId: "v1", sourceDigest: "a".repeat(64) } },
  };
  const judged = await assessCandidates(input, {
    judge: async () => ({
      model: "fixture",
      answers: { q0s: { type: "noul", noul: 0.97 }, q0c: { type: "noul", noul: 0.01 } },
      usage: { inputTokens: 1, outputTokens: 1 },
      requestSha256: "c".repeat(64),
      elapsedMs: 1,
    }),
  });
  const accepted = acceptCandidate(field, judged.judgements[0], source, validation.sourceDigest, {
    fieldMeanings: input.fieldMeanings,
    scope: input.scope,
    opposingContext: input.opposingContext,
    depBindings: input.depBindings,
  });
  assert.equal(accepted.status, "accepted", "exact current dependency positive control");
  const stale = acceptCandidate(field, judged.judgements[0], source, validation.sourceDigest, {
    fieldMeanings: input.fieldMeanings,
    scope: input.scope,
    opposingContext: input.opposingContext,
    depBindings: { version: { ...input.depBindings.version, sourceDigest: "b".repeat(64) } },
  });
  assert.equal(
    stale.status,
    "unresolved",
    "old dependency-bound judgment reused under changed revision",
  );
});
