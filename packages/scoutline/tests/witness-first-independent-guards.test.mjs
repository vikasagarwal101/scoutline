import test from "node:test";
import assert from "node:assert/strict";
import { inputs } from "./unified-review-corpus.mjs";
import { offlineDeps } from "./unified-review-offline-deps.mjs";
import { runLeanInvestigation } from "../dist/lib/lean-investigation.js";

function setup(mode = "clean") {
  const c = structuredClone(inputs[0]);
  c.contract.requirements = { version: c.contract.requirements.version };
  if (mode === "multi-witness")
    c.contract.requirements.version.criteria.push(
      "Require two independently extracted source witnesses before this field is fulfilled.",
    );
  if (mode === "failed-read") c.sources[1].readError = "fixture_read_failed";
  const { deps, calls } = offlineDeps(c);
  const judge = deps.candidateJudge;
  let judgedFull = false;
  deps.candidateJudge = async (input) => {
    const r = await judge(input);
    if (input.source.evidenceId === "e1" && input.opposingContext.length) {
      judgedFull = true;
      if (mode === "unknown") r.answers.q0c.noul = 0.5;
      if (mode === "conflict") r.answers.q0c.noul = 0.97;
      if (mode === "revised")
        input.source.content += "\nSame-ID revision invalidates earlier validated candidate.";
    }
    return r;
  };
  return { c, deps, calls, full: () => judgedFull };
}
test("quiescent full-proof witness defers alternative extraction after required opposition assessment", async () => {
  const { c, deps, calls, full } = setup();
  const r = await runLeanInvestigation(c.contract, deps);
  assert(full(), "the existing candidate is actually assessed against retained contrary source");
  assert.equal(calls.read.length, 2, "both mandatory source representations retained");
  assert.equal(calls.search.length, 3, "all frozen queries including contrary completed");
  assert.equal(r.data.version, "2.4");
  assert.equal(
    calls.extract.length,
    1,
    "passing full-context witness must defer the otherwise subsequent alternative-source extraction",
  );
});
for (const mode of ["unknown", "conflict", "revised", "multi-witness"])
  test(`alternative extraction remains due without eligible full proof: ${mode}`, async () => {
    const { c, deps, calls, full } = setup(mode);
    const r = await runLeanInvestigation(c.contract, deps);
    assert(full());
    assert(
      calls.extract.some((x) => x.sourceId === "e2"),
      "ineligible witness must not suppress alternative generation",
    );
  });
test("failed required opposition read never qualifies one-sided witness", async () => {
  const { c, deps, calls } = setup("failed-read");
  const r = await runLeanInvestigation(c.contract, deps);
  assert.equal(
    calls.read.length,
    3,
    "failed contrary source is retried within existing acquisition",
  );
  assert(!("version" in r.data));
  assert.equal(r.requirements.version.reason, "counterevidence_not_acquired");
});
test("pending other-field contrary query prevents retrospective final-set shortcut", async () => {
  const c = structuredClone(inputs[0]);
  const { deps, calls } = offlineDeps(c);
  const extract = deps.extract;
  let observedPending = false;
  deps.extract = async (input) => {
    if (input.fields[0].id === "version" && input.sourceId === "e2") {
      assert(
        !calls.search.includes(`${c.contract.requirements.csv.question} contrary evidence refuted`),
      );
      observedPending = true;
    }
    return extract(input);
  };
  await runLeanInvestigation(c.contract, deps);
  assert(
    observedPending,
    "a full eventual source-set witness must not qualify while acquisition can still enlarge context",
  );
});
