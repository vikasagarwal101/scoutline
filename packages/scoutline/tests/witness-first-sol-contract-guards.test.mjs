import test from "node:test";
import assert from "node:assert/strict";
import { inputs } from "./unified-review-corpus.mjs";
import { offlineDeps } from "./unified-review-offline-deps.mjs";
import { runLeanInvestigation } from "../dist/lib/lean-investigation.js";
import { acceptCandidate } from "../dist/lib/lean-candidates.js";

function setup(change = () => {}) {
  const c = structuredClone(inputs[0]);
  c.contract.requirements = { version: c.contract.requirements.version };
  change(c.contract);
  const { deps, calls } = offlineDeps(c);
  return { c, deps, calls };
}
function deferred(row) {
  return row.attemptedRecords.filter((r) => r.metadata?.kind === "candidate-generation-deferred");
}
function verifyProof(c, r, field = "version") {
  const row = r.requirements[field], p = row.provenance;
  assert(p, "accepted value retains source-bound provenance");
  const outcome = row.candidates.find((x) => x.status === "candidate" && x.value === p.value && x.quote === p.quote && x.charRange[0] === p.charRange[0]);
  const depBindings = Object.fromEntries((c.contract.requirements[field].dependsOn ?? []).map((id) => {
    const d = r.requirements[id];
    return [id, { value: d.value, evidenceId: d.provenance.sourceId, sourceDigest: d.provenance.sourceDigest }];
  }));
  const checked = acceptCandidate(outcome, row.judgment, r.evidence.find((e) => e.evidenceId === p.sourceId), p.sourceDigest, {
    fieldMeanings: { [field]: [c.contract.requirements[field].question, ...(c.contract.requirements[field].criteria ?? []), ...(c.contract.evidence?.criteria ?? [])].join("\n") },
    scope: c.contract.scope,
    opposingContext: r.evidence.filter((e) => e.evidenceId !== p.sourceId),
    depBindings,
  });
  assert.equal(checked.status, "accepted", "published proof passes unchanged deterministic seam");
}

for (const [label, change] of [
  ["original exact two clauses", () => {}],
  ["empty field and common criteria", (c) => { c.requirements.version.criteria = []; }],
  ["known clause in common evidence", (c) => { c.requirements.version.criteria = []; c.evidence = { criteria: ["Use the specified release only."] }; }],
]) test(`eligible pilot preserves proof and honest deferral accounting: ${label}`, async () => {
  const { c, deps, calls } = setup(change);
  const r = await runLeanInvestigation(c.contract, deps);
  assert.equal(r.data.version, "2.4");
  verifyProof(c, r);
  assert.equal(calls.search.length, 3);
  assert.equal(calls.read.length, 2);
  assert(calls.candidateJudge.some((x) => x.source.evidenceId === "e1" && x.opposingContext.some((e) => e.evidenceId === "e2")), "opposition is genuinely assessed");
  assert.equal(calls.extract.length, 1, "physical alternative extraction is deferred");
  assert.equal(r.usage.extractorCalls, calls.extract.length);
  assert.equal(r.usage.candidateJudgeCalls, calls.candidateJudge.length);
  const row = r.requirements.version, records = deferred(row);
  assert.equal(records.length, 1, "one explicit deferral record, not fabricated assessment");
  const record = records[0];
  assert.deepEqual(record.assessments, []);
  assert.equal(record.trusted, false, "unperformed generation is not a trusted assessment");
  assert.equal(record.metadata.sourceId, "e2");
  assert.equal(record.metadata.witnessSourceId, "e1");
  assert.equal(record.reason, "quiescent_full_proof");
  assert(!Object.hasOwn(record.metadata, "usage"), "no fabricated measured model usage");
  assert.equal(row.attemptedRecords.filter((x) => x.metadata?.kind === "extraction").length, calls.extract.length);
  assert(!row.attemptedRecords.some((x) => ["extraction", "candidate-judgment"].includes(x.metadata?.kind) && x.metadata.sourceId === "e2"));
});

for (const [label, change] of [
  ["unfamiliar corroboration prose", (c) => c.requirements.version.criteria.push("The answer must be corroborated by separate primary and secondary records.")],
  ["numeric witness obligation", (c) => c.requirements.version.criteria.push("Accept only with 2 distinct source derivations.")],
  ["unknown benign criterion", (c) => c.requirements.version.criteria.push("Prefer official documentation.")],
  ["common evidence corroboration", (c) => { c.evidence = { criteria: ["A second independently derived witness is mandatory."] }; }],
  ["common evidence unknown wording", (c) => { c.evidence = { criteria: ["Use primary materials."] }; }],
  ["field question evidence-count obligation", (c) => { c.requirements.version.question = "What exact release identifier is documented by two independent extractions?"; }],
  ["unknown scalar question", (c) => { c.requirements.version.question = "Which release is documented?"; }],
  ["caller-level evidence-count obligation", (c) => { c.question += " Require separate independently extracted witnesses."; }],
  ["unknown sibling field question", (c) => { c.requirements.csv = structuredClone(inputs[0].contract.requirements.csv); c.requirements.csv.question += " Two independent derivations are required."; }],
  ["unrecognized additional field", (c) => { c.requirements.extra = structuredClone(c.requirements.version); }],
  ["unknown sibling criteria", (c) => { c.requirements.csv = structuredClone(inputs[0].contract.requirements.csv); c.requirements.csv.criteria.push("Independently derive every scalar answer twice."); }],
  ["additional scope obligation", (c) => { c.scope.evidencePolicy = "Require two independently derived values."; }],
  ["release-carried scope prose", (c) => { c.scope.release = "2.4; require two independently extracted witnesses"; }],
  ["scope-carried prose in canonical caller template", (c) => { c.scope.entity = "Aster; require two independent extractions"; c.question = `Identify the release, its license and whether ${c.scope.entity} supports CSV export.`; }],
]) test(`arbitrary obligations fall back without interpretation: ${label}`, async () => {
  const { c, deps, calls } = setup(change);
  const r = await runLeanInvestigation(c.contract, deps);
  assert(calls.extract.some((x) => x.fields[0].id === "version" && x.sourceId === "e2"), "unrecognized contract never grants optimization permission");
  assert.equal(deferred(r.requirements.version).length, 0);
});

for (const mode of ["source", "opposition", "scope"]) test(`proof revision after real deferral reopens generation: ${mode}`, async () => {
  const { c, deps, calls } = setup((contract) => { contract.requirements.csv = structuredClone(inputs[0].contract.requirements.csv); });
  const judge = deps.judge, candidateJudge = deps.candidateJudge;
  let lastQuery = false, source, opposition, scope, exercised = false, deferredBeforeRevision = false;
  deps.search = async (q) => {
    calls.search.push(q);
    lastQuery = q === `${c.contract.requirements.csv.question} contrary evidence refuted`;
    return [c.sources[lastQuery ? 1 : 0]].map((s) => ({ url: s.url, title: s.title }));
  };
  deps.candidateJudge = async (input) => {
    if (input.opposingContext.length && input.source.evidenceId === "e1") {
      source = input.source; opposition = input.opposingContext[0]; scope = input.scope;
    }
    return candidateJudge(input);
  };
  deps.judge = async (input) => {
    const response = await judge(input);
    if (lastQuery && source && !exercised) {
      deferredBeforeRevision = !calls.extract.some((x) => x.sourceId === "e2");
      if (mode === "source") source.content += "\nSame-ID source revised after deferral.";
      if (mode === "opposition") opposition.content += "\nSame-ID opposition revised after deferral.";
      if (mode === "scope") scope.release = "3.0";
      exercised = true;
    }
    return response;
  };
  const r = await runLeanInvestigation(c.contract, deps);
  assert(exercised);
  assert(deferredBeforeRevision, "revision happens after an actual qualifying deferral");
  assert(calls.extract.some((x) => x.sourceId === "e2"), "changed context invalidates deferral and restores due generation");
  assert.equal(r.usage.extractorCalls, calls.extract.length);
  assert.notEqual(r.requirements.version.reason, "internal_stop");
  if (r.data.version) verifyProof({ ...c, contract: { ...c.contract, scope: scope ?? c.contract.scope } }, r);
});
