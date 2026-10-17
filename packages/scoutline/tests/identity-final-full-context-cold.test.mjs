import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { inputs } from "./unified-review-corpus.mjs";
import { offlineDeps } from "./unified-review-offline-deps.mjs";
import { runLeanInvestigation } from "../dist/lib/lean-investigation.js";
import { acceptCandidate } from "../dist/lib/lean-candidates.js";

test("detached field-meaning mutation causes immediate candidate context mismatch", async () => {
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
    result.requirements.version.attemptedRecords.some(
      (attempt) =>
        attempt.trusted === false &&
        attempt.metadata?.kind === "candidate-judgment" &&
        attempt.metadata.sourceId === "e1" &&
        attempt.reason === "judgement_context_mismatch",
    ),
    "detached field-meaning change records the immediate judgment-context mismatch",
  );
  assert(
    !("version" in result.data),
    "a detached changed meaning cannot publish a mismatched candidate judgment",
  );
});

test("control unchanged full context preserves prerequisite and dependent", async () => {
  const c = structuredClone(inputs[0]);
  const { deps } = offlineDeps(c);
  const result = await runLeanInvestigation(c.contract, deps);
  assert.equal(result.data.version, "2.4");
  assert.equal(result.data.license, "MIT");
  const prerequisite = result.requirements.version;
  const dependent = result.requirements.license;
  assert.equal(prerequisite.status, "satisfied");
  assert.equal(dependent.status, "satisfied");
  const prerequisiteSource = result.evidence.find((source) => source.evidenceId === prerequisite.provenance.sourceId);
  const dependentSource = result.evidence.find((source) => source.evidenceId === dependent.provenance.sourceId);
  assert(prerequisiteSource);
  assert(dependentSource);
  assert.equal(prerequisite.provenance.sourceDigest, createHash("sha256").update(prerequisiteSource.content).digest("hex"));
  assert.equal(dependent.provenance.sourceDigest, createHash("sha256").update(dependentSource.content).digest("hex"));
  const audit = dependent.attemptedRecords.find(
    (attempt) =>
      attempt.trusted &&
      attempt.metadata?.kind === "candidate-judgment" &&
      attempt.assessments.some((assessment) => assessment.candidateId === dependent.judgment.candidateId),
  );
  assert(audit, "accepted dependent has a real trusted candidate-judgment audit");
  assert.equal(audit.metadata.sourceId, dependentSource.evidenceId);
  assert.equal(
    audit.metadata.depBindings.version.value,
    result.data.version,
    "published dependent was judged under a different accepted prerequisite value",
  );
  assert.equal(audit.metadata.depBindings.version.evidenceId, prerequisite.provenance.sourceId);
  assert.equal(audit.metadata.depBindings.version.sourceDigest, prerequisite.provenance.sourceDigest);
  const candidate = dependent.candidates.find(
    (outcome) => outcome.status === "candidate" && outcome.value === dependent.provenance.value && outcome.quote === dependent.provenance.quote,
  );
  assert(candidate);
  assert.equal(
    acceptCandidate(candidate, dependent.judgment, dependentSource, dependent.provenance.sourceDigest, {
      fieldMeanings: {
        license: [
          c.contract.requirements.license.question,
          ...c.contract.requirements.license.criteria,
          ...(c.contract.evidence?.criteria ?? []),
        ].join("\n"),
      },
      scope: c.contract.scope,
      opposingContext: result.evidence.filter((source) => source.evidenceId !== dependentSource.evidenceId),
      depBindings: audit.metadata.depBindings,
    }).status,
    "accepted",
    "the published positive has a genuine current source/context/dependency proof",
  );
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

test("detached dependency-binding mutation is refused without changing the accepted prerequisite", async () => {
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
  assert(changed, "synthetic collaborator exercised detached dependency binding mutation");
  assert.equal(result.data.version, "2.4");
  assert.equal(result.requirements.version.status, "satisfied");
  const row = result.requirements.license;
  assert.equal(row.status, "unresolved");
  assert(!("license" in result.data));
  const audit = row.attemptedRecords.find(
    (attempt) =>
      attempt.trusted === false &&
      attempt.metadata?.kind === "candidate-judgment" &&
      attempt.reason === "judgement_context_mismatch",
  );
  assert(audit, "detached dependency mutation must record the immediate context mismatch");
  assert.equal(audit.metadata.depBindings.version.value, "2.4", "the engine audit keeps the authoritative binding snapshot");
  assert.equal(audit.metadata.depBindings.version.evidenceId, result.requirements.version.provenance.sourceId);
  assert.equal(audit.metadata.depBindings.version.sourceDigest, result.requirements.version.provenance.sourceDigest);
  const prerequisiteSource = result.evidence.find(
    (source) => source.evidenceId === result.requirements.version.provenance.sourceId,
  );
  assert(prerequisiteSource);
  assert.equal(
    result.requirements.version.provenance.sourceDigest,
    createHash("sha256").update(prerequisiteSource.content).digest("hex"),
  );
});
