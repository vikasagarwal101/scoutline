import test from "node:test";
import assert from "node:assert/strict";
import { inputs } from "./unified-review-corpus.mjs";
import { offlineDeps } from "./unified-review-offline-deps.mjs";
import { runLeanInvestigation } from "../dist/lib/lean-investigation.js";
test("scheduler projection reconciles exact dependency provenance across trusted multiple current candidates", async () => {
  const c = structuredClone(inputs[14]);
  c.contract.requirements.version.dependsOn = ["csv"];
  c.contract.requirements = {
    csv: c.contract.requirements.csv,
    version: c.contract.requirements.version,
    license: c.contract.requirements.license,
  };
  const { deps } = offlineDeps(c);
  const r = await runLeanInvestigation(c.contract, deps);
  assert.equal(r.data.csv, "disputed");
  assert.equal(r.data.version, "4.0");
  assert.equal(r.data.license, "BSD-2-Clause");
  const license = r.requirements.license,
    audit = license.attemptedRecords.find((x) =>
      x.assessments.some((a) => a.candidateId === license.judgment.candidateId),
    );
  assert.equal(
    audit.metadata.depBindings.version.evidenceId,
    r.requirements.version.provenance.sourceId,
  );
  assert.equal(
    audit.metadata.depBindings.version.sourceDigest,
    r.requirements.version.provenance.sourceDigest,
  );
});
test("same-ID evidence revision invalidates scheduler retained prerequisite before dependent dispatch", async () => {
  const c = structuredClone(inputs[0]);
  const { deps } = offlineDeps(c),
    judge = deps.candidateJudge;
  let revised = false;
  deps.candidateJudge = async (input) => {
    const response = await judge(input);
    if (
      input.candidates[0].fieldId === "version" &&
      input.source.evidenceId === "e2" &&
      input.opposingContext.length
    ) {
      const guide = input.opposingContext.find((x) => x.evidenceId === "e1");
      guide.content =
        "Aster release 3.0. License for release 3.0: GPL-3.0. Release 2.4 is superseded.";
      revised = true;
      response.answers.q0s.noul = 0.5;
    }
    return response;
  };
  const r = await runLeanInvestigation(c.contract, deps);
  assert(revised, "synthetic same-ID representation revision exercised");
  assert(
    !("version" in r.data),
    "old digest-bearing accept cannot survive changed source bytes with same evidence ID",
  );
  assert(!("license" in r.data), "stale prerequisite cannot authorize dependent value");
});
