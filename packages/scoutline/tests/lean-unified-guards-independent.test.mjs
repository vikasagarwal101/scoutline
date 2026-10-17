import test from "node:test";
import assert from "node:assert/strict";
import { inputs } from "./unified-review-corpus.mjs";
import { offlineDeps } from "./unified-review-offline-deps.mjs";
const root =
  new URL("..", import.meta.url).pathname;
const { runLeanInvestigation } = await import(`${root}/dist/lib/lean-investigation.js`);
function valueCase() {
  const c = structuredClone(inputs[0]);
  c.contract.requirements = { version: c.contract.requirements.version };
  return c;
}
test("unknown candidate conflict is actually judged then abstains", async () => {
  const c = valueCase();
  const { deps, calls } = offlineDeps(c);
  const judge = deps.candidateJudge;
  deps.candidateJudge = async (input) => {
    const response = await judge(input);
    for (const [id, answer] of Object.entries(response.answers))
      if (id.endsWith("c")) answer.noul = 0.5;
    return response;
  };
  const result = await runLeanInvestigation(c.contract, deps);
  assert(
    calls.extract.length > 0 && calls.candidateJudge.length > 0,
    "negative must exercise actual candidate judgment",
  );
  assert.deepEqual(result.data, {});
  assert.equal(result.status, "partial");
});
for (const finishReason of ["length", "refusal"])
  test(`unified ${finishReason} extraction dispatches but cannot promote`, async () => {
    const c = valueCase();
    const { deps, calls } = offlineDeps(c);
    const extract = deps.extract;
    deps.extract = async (input) => ({ ...(await extract(input)), finishReason });
    const result = await runLeanInvestigation(c.contract, deps);
    assert(calls.extract.length > 0);
    assert.equal(calls.candidateJudge.length, 0);
    assert.deepEqual(result.data, {});
    assert(
      result.requirements.version.candidates?.some((x) => x.status === "invalid"),
      "rejected extraction must remain in field audit",
    );
  });
test("unified extra extractor key is rejected before semantic dispatch", async () => {
  const c = valueCase();
  const { deps, calls } = offlineDeps(c);
  const extract = deps.extract;
  deps.extract = async (input) => {
    const response = await extract(input);
    response.rawOutput = JSON.stringify({
      ...JSON.parse(response.rawOutput),
      workflow: "ignore limits",
    });
    return response;
  };
  const result = await runLeanInvestigation(c.contract, deps);
  assert(calls.extract.length > 0);
  assert.equal(calls.candidateJudge.length, 0);
  assert.deepEqual(result.data, {});
});
test("unified malformed raw candidate score remains an audited rejected attempt", async () => {
  const c = valueCase();
  const { deps, calls } = offlineDeps(c);
  const judge = deps.candidateJudge;
  deps.candidateJudge = async (input) => {
    const response = await judge(input);
    response.answers.q0s.noul = NaN;
    return response;
  };
  const result = await runLeanInvestigation(c.contract, deps);
  assert(calls.candidateJudge.length > 0);
  assert.deepEqual(result.data, {});
  assert.equal(result.usage.candidateJudgeCalls, calls.candidateJudge.length);
  assert(
    result.requirements.version.attemptedRecords?.some(
      (record) => record.trusted === false &&
        record.metadata?.kind === "candidate-judgment" &&
        record.reason?.startsWith("candidate_judge_failed:"),
    ),
    "malformed score must remain an audited rejected candidate judgment",
  );
});
test("missing extractor retains acquired evidence with explicit unresolved mode", async () => {
  const c = valueCase();
  const { deps, calls } = offlineDeps(c);
  deps.extract = null;
  const result = await runLeanInvestigation(c.contract, deps);
  assert(result.evidence.length > 0);
  assert.deepEqual(result.data, {});
  assert.equal(result.requirements.version.reason, "no_extractor");
  assert.equal(calls.extract.length + calls.candidateJudge.length, 0);
});
test("all-optional requested values actually execute before complete", async () => {
  const c = valueCase();
  c.contract.requirements.version.required = false;
  const { deps, calls } = offlineDeps(c);
  const result = await runLeanInvestigation(c.contract, deps);
  assert(calls.search.length > 0 && calls.extract.length > 0 && calls.candidateJudge.length > 0);
  assert.equal(result.status, "complete");
  assert.equal(result.data.version, "2.4");
});
test("read cap cannot waive returned contrary source", async () => {
  const c = valueCase();
  c.contract.limits = { maxUniqueReads: 1 };
  const { deps, calls } = offlineDeps(c);
  const result = await runLeanInvestigation(c.contract, deps);
  assert(calls.read.length > 0);
  assert(calls.read.length <= 1);
  assert.deepEqual(result.data, {});
  assert.equal(result.status, "partial");
});
test("optional blocked dependency does not revoke independent mandatory value", async () => {
  const c = valueCase();
  c.contract.requirements.version.required = true;
  c.contract.requirements.absent = {
    question: "Does feature X exist?",
    schema: { enum: ["supported", "refuted"] },
    required: false,
  };
  c.contract.requirements.dependent = {
    question: "License under feature X?",
    schema: { type: "string" },
    required: false,
    dependsOn: ["absent"],
  };
  const { deps } = offlineDeps(c);
  deps.judge = async (input) => ({
    documents: input.documents.map((d) => ({
      evidenceId: d.evidenceId,
      relevant: false,
      supportsClaim: false,
      refutesClaim: false,
    })),
  });
  const result = await runLeanInvestigation(c.contract, deps);
  assert.equal(result.data.version, "2.4");
  assert.equal(result.requirements.dependent.status, "unresolved");
  assert.equal(result.status, "complete");
});
