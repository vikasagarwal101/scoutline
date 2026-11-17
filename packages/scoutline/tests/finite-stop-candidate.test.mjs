import test from "node:test";
import assert from "node:assert/strict";
import { runLeanInvestigation } from "../dist/lib/lean-investigation.js";
import { createTypesafeJudge } from "../dist/lib/lean-typesafe-judge.js";
// Engine → normalizer (assessCandidates) → OFFICIAL candidate judge.
// A refusing admission callback (typed EVAL_STOPPED + composed-stop
// root) must end the run with the exact root preserved, ZERO physical
// HTTP, and no repeat dispatch after the refusal. This is the normal
// returned-error path — no exceptional catch involved.
const CONTRACT = {
  schemaVersion: 1,
  question: "Which release?",
  scope: { entity: "ExampleApp", release: "2.4.0" },
  requirements: {
    version: { question: "Which exact release is documented?", schema: { type: "string" } },
  },
};
const CONTENT = "ExampleApp release 2.4.0.";
const seed = (count) => ({
  evidence: Array.from({ length: count }, (_, i) => ({
    evidenceId: `seed${i}`,
    url: `https://fixture.invalid/${i}`,
    title: `s${i}`,
    content: CONTENT,
    byteLength: CONTENT.length,
    origins: [],
  })),
});
// TWO retained documents: the run-wide stop must hold after the FIRST
for (const root of ["global_extraction_cap", "global_judgment_cap", "global_deadline"]) {
  test(`official candidate admission refusal preserves ${root} and stops the source batch exactly once`, async () => {
    let admissions = 0;
    let physical = 0;
    let extracts = 0;
    const profile = createTypesafeJudge({
      apiKey: "fake-only",
      reserveAttempt: () => {
        admissions += 1;
        throw Object.assign(Error("admission refused before dispatch"), {
          code: "EVAL_STOPPED",
          reason: root,
        });
      },
      fetchLike: async () => {
        physical += 1;
        throw new Error("must not dispatch");
      },
    });
    const result = await runLeanInvestigation(structuredClone(CONTRACT), {
      now: () => 0,
      search: async () => [],
      read: async () => CONTENT,
      seed: seed(2),
      extract: async (input) => {
        extracts += 1;
        return {
          finishReason: "stop",
          rawOutput: JSON.stringify(
            Object.fromEntries(
              input.fields.map((f) => [
                f.id,
                { value: "2.4.0", quote: CONTENT },
              ]),
            ),
          ),
          usage: { inputTokens: 1, outputTokens: 1 },
          observedCost: null,
        };
      },
      extractorRevision: "fixture-extractor",
      candidateJudge: profile.candidateJudge,
    });
    assert.equal(physical, 0, "refused admission must not reach HTTP");
    assert.equal(result.requirements.version.reason, root);
    assert.deepEqual(result.data, {});
    // EXACTLY ONE refusal for the whole run — the second retained
    // document must not be extracted or admitted after the stop.
    assert.equal(admissions, 1, "the global stop must prevent subsequent admissions");
    assert.equal(extracts, 1, "no new extraction after the composed stop");
    assert.equal(
      result.requirements.version.attemptedRecords.filter(
        (r) => r.metadata?.kind === "candidate-judgment",
      ).length,
      1,
      "exactly one refused audit record",
    );
  });
}
test("control: invalid root stays sanitized and the source batch continues", async () => {
  let admissions = 0;
  let extracts = 0;
  const profile = createTypesafeJudge({
    apiKey: "fake-only",
    reserveAttempt: () => {
      admissions += 1;
      throw Object.assign(Error("refused"), {
        code: "EVAL_STOPPED",
        reason: "arbitrary_unrelated_root",
      });
    },
    fetchLike: async () => {
      throw new Error("must not dispatch");
    },
  });
  const result = await runLeanInvestigation(structuredClone(CONTRACT), {
    now: () => 0,
    search: async () => [],
    read: async () => CONTENT,
    seed: seed(2),
    extract: async (input) => {
      extracts += 1;
      return {
        finishReason: "stop",
        rawOutput: JSON.stringify(
          Object.fromEntries(
            input.fields.map((f) => [
              f.id,
              { value: "2.4.0", quote: CONTENT },
            ]),
          ),
        ),
        usage: { inputTokens: 1, outputTokens: 1 },
        observedCost: null,
      };
    },
    extractorRevision: "fixture-extractor",
    candidateJudge: profile.candidateJudge,
  });
  assert.equal(result.requirements.version.reason, "exhausted");
  assert.notEqual(result.requirements.version.reason, "arbitrary_unrelated_root");
  assert.deepEqual(result.data, {});
  // An UNRECOGNIZED root is ordinary continuation: the second retained
  // document IS still extracted and admitted (no stop occurred).
  assert.equal(admissions, 2, "unrecognized roots keep per-source continuation");
  assert.equal(extracts, 2, "both documents processed without a typed stop");
});
