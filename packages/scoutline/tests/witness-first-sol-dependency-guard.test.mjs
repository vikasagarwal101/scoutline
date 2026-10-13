import test from "node:test";
import assert from "node:assert/strict";
import { inputs } from "./unified-review-corpus.mjs";
import { offlineDeps } from "./unified-review-offline-deps.mjs";
import { runLeanInvestigation } from "../dist/lib/lean-investigation.js";

// Timing supersession (parent-authorized, reviewer-documented): the
// original draft hooked csv's enum judgment expecting license's
// full-context proof to precede it, but the preserved selector sorts
// open-prerequisite depth first — csv (depth 0) runs before license
// (depth 1) in the last-retention pass, so that boundary never saw a
// post-license-deferral state. The genuine boundary after the actual
// license deferral is the injected clock seam: after the full license
// e1 judgment is observed, the first subsequent now() call is the
// deferral eligibility expiry check and the second is the pushLog after
// the deferred record/map is set — the mutation lands there, on a REAL
// deferral. This is test-specific timing against the injected seam,
// not a general clock contract. Behavioral assertions unchanged.
test("deferred dependent generation reopens after prerequisite source binding revision", async () => {
  const c = structuredClone(inputs[0]);
  const { deps, calls } = offlineDeps(c);
  const candidateJudge = deps.candidateJudge;
  let source, licenseFull = false, clockAfter = 0, mutated = false;
  deps.search = async (q) => {
    calls.search.push(q);
    return [c.sources[q === `${c.contract.requirements.csv.question} contrary evidence refuted` ? 1 : 0]].map((s) => ({ url: s.url, title: s.title }));
  };
  deps.candidateJudge = async (input) => {
    if (input.candidates[0].fieldId === "version" && input.source.evidenceId === "e1" && input.opposingContext.length) source = input.source;
    const r = await candidateJudge(input);
    if (input.candidates[0].fieldId === "license" && input.source.evidenceId === "e1" && input.opposingContext.length) licenseFull = true;
    return r;
  };
  deps.now = () => {
    if (licenseFull && !mutated && ++clockAfter === 2) {
      assert(!calls.extract.some((x) => x.fields[0].id === "license" && x.sourceId === "e2"), "mutation happens before any license e2 extraction");
      source.content += "\nPrerequisite provenance revised after dependent deferral.";
      mutated = true;
    }
    return 0;
  };
  const r = await runLeanInvestigation(c.contract, deps);
  assert(mutated, "revision boundary observed after actual license deferral");
  assert(r.requirements.license.attemptedRecords.some((x) => x.metadata?.kind === "candidate-generation-deferred"), "license actually deferred before revision");
  assert(calls.extract.some((x) => x.fields[0].id === "license" && x.sourceId === "e2"), "changed prerequisite provenance restores dependent generation when unblocked");
  assert.equal(r.usage.extractorCalls, calls.extract.length);
  if (r.data.license) {
    const row = r.requirements.license;
    const proof = row.attemptedRecords.find((x) => x.assessments.some((a) => a.candidateId === row.judgment.candidateId));
    assert.equal(proof.metadata.depBindings.version.value, r.data.version);
    assert.equal(proof.metadata.depBindings.version.evidenceId, r.requirements.version.provenance.sourceId);
    assert.equal(proof.metadata.depBindings.version.sourceDigest, r.requirements.version.provenance.sourceDigest);
  }
});
