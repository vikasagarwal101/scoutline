import test from "node:test";
import assert from "node:assert/strict";
import { inputs } from "./unified-review-corpus.mjs";
import { offlineDeps } from "./unified-review-offline-deps.mjs";
import { runLeanInvestigation } from "../dist/lib/lean-investigation.js";
import { acceptCandidate } from "../dist/lib/lean-candidates.js";

test("history projection rejects acceptance assessed under altered meaning and criteria", async () => {
  const c = structuredClone(inputs[0]);
  const { deps } = offlineDeps(c);
  const judge = deps.candidateJudge;
  let changed = false;
  deps.candidateJudge = async (input) => {
    const response = await judge(input);
    if (input.candidates[0].fieldId === "version" && input.opposingContext.length) {
      if (input.source.evidenceId === "e1") {
        input.fieldMeanings.version += "\nRevised criterion: accept an obsolete release.";
        changed = true;
      } else response.answers.q0s.noul = 0.5;
    }
    return response;
  };
  const result = await runLeanInvestigation(c.contract, deps);
  assert(changed);
  assert(
    !("version" in result.data),
    "history must revalidate judgment against actual compiled meaning and criteria",
  );
});

test("control unchanged full context preserves prerequisite and dependent", async () => {
  const c = structuredClone(inputs[0]);
  const { deps } = offlineDeps(c);
  const result = await runLeanInvestigation(c.contract, deps);
  assert.equal(result.data.version, "2.4");
  assert.equal(result.data.license, "MIT");
});

test("history projection revalidates full live scope through deterministic acceptance", async () => {
  const c = structuredClone(inputs[0]);
  const { deps, live } = offlineDeps(c, { captureLiveTargets: true });
  const judge = deps.candidateJudge;
  let changed = false;
  deps.candidateJudge = async (input) => {
    const response = await judge(input);
    if (
      input.candidates[0].fieldId === "version" &&
      input.source.evidenceId === "e2" &&
      input.opposingContext.length
    ) {
      live.reviseScope((scope) => { scope.release = "3.0"; });
      changed = true;
      response.answers.q0s.noul = 0.5;
    }
    return response;
  };
  const result = await runLeanInvestigation(c.contract, deps);
  assert(changed, "synthetic collaborator exercised shared live scope revision");
  if (result.requirements.version.provenance) {
    const row = result.requirements.version;
    const source = result.evidence.find((e) => e.evidenceId === row.provenance.sourceId);
    const candidate = row.candidates.find(
      (x) =>
        x.status === "candidate" &&
        x.value === row.provenance.value &&
        x.quote === row.provenance.quote,
    );
    const checked = acceptCandidate(candidate, row.judgment, source, row.provenance.sourceDigest, {
      fieldMeanings: {
        version: [
          c.contract.requirements.version.question,
          ...c.contract.requirements.version.criteria,
          ...(c.contract.evidence?.criteria ?? []),
        ].join("\n"),
      },
      scope: { ...c.contract.scope, release: "3.0" },
      opposingContext: result.evidence.filter((e) => e.evidenceId !== source.evidenceId),
      depBindings: {},
    });
    assert.equal(
      checked.reason,
      "judgement_context_mismatch",
      "existing seam rejects the historical judgment on revised live scope",
    );
  }
  assert(
    !("version" in result.data),
    "scheduler cannot publish historical acceptance rejected by the full current-context seam",
  );
});

test("projected dependent acceptance must match final prerequisite value and provenance", async () => {
  const c = structuredClone(inputs[0]);
  const { deps } = offlineDeps(c);
  const judge = deps.candidateJudge;
  let changed = false;
  deps.candidateJudge = async (input) => {
    const response = await judge(input);
    if (input.candidates[0].fieldId === "license" && input.opposingContext.length) {
      input.depBindings.version.value = "3.0";
      changed = true;
    }
    return response;
  };
  const result = await runLeanInvestigation(c.contract, deps);
  assert(changed, "synthetic collaborator exercised shared dependency binding revision");
  const row = result.requirements.license;
  if (row.status === "satisfied") {
    const audit = row.attemptedRecords.find((x) =>
      x.assessments.some((a) => a.candidateId === row.judgment.candidateId),
    );
    assert.equal(
      audit.metadata.depBindings.version.value,
      result.data.version,
      "published dependent was judged under a different accepted prerequisite value",
    );
    assert.equal(
      audit.metadata.depBindings.version.evidenceId,
      result.requirements.version.provenance.sourceId,
    );
    assert.equal(
      audit.metadata.depBindings.version.sourceDigest,
      result.requirements.version.provenance.sourceDigest,
    );
  }
});
