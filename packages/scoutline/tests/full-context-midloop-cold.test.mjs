import test from "node:test";
import assert from "node:assert/strict";
import { inputs } from "./unified-review-corpus.mjs";
import { offlineDeps } from "./unified-review-offline-deps.mjs";
import { runLeanInvestigation } from "../dist/lib/lean-investigation.js";
import { acceptCandidate } from "../dist/lib/lean-candidates.js";

for (const mode of ["unchanged", "source-revision", "scope-revision"]) {
  test(`mid-loop finalization requires standing accept full proof: ${mode}`, async () => {
    const c = structuredClone(inputs[0]);
    const { deps, live } = offlineDeps(c, { captureLiveTargets: true });
    const judge = deps.candidateJudge;
    const search = deps.search;
    let guide,
      scope,
      exercised = false;
    deps.candidateJudge = async (input) => {
      if (input.source.evidenceId === "e1") guide = live.retained.get(input.source.evidenceId);
      scope = live.scope;
      return judge(input);
    };
    deps.search = async (query) => {
      const result = await search(query);
      if (query === `${c.contract.requirements.csv.question} contrary evidence refuted`) {
        assert(guide && scope, "actual prior candidate dispatch supplied retained records");
        if (mode === "source-revision") live.reviseSource(guide, (guide) => {
          guide.content += "\nThis record has been revised.";
        });
        if (mode === "scope-revision") live.reviseScope((scope) => { scope.release = "3.0"; });
        exercised = true;
      }
      return result;
    };
    const r = await runLeanInvestigation(c.contract, deps);
    assert(exercised);
    if (mode === "unchanged") {
      assert.equal(r.data.version, "2.4");
      assert.equal(r.data.license, "MIT");
    } else {
      const row = r.requirements.version;
      if (row.provenance) {
        const p = row.provenance;
        const source = r.evidence.find((e) => e.evidenceId === p.sourceId);
        const candidate = row.candidates.find(
          (x) => x.status === "candidate" && x.value === p.value && x.quote === p.quote,
        );
        const checked = acceptCandidate(candidate, row.judgment, source, p.sourceDigest, {
          fieldMeanings: {
            version: [
              c.contract.requirements.version.question,
              ...c.contract.requirements.version.criteria,
              ...(c.contract.evidence?.criteria ?? []),
            ].join("\n"),
          },
          scope,
          opposingContext: r.evidence.filter((e) => e.evidenceId !== p.sourceId),
          depBindings: {},
        });
        assert.equal(
          checked.status,
          "unresolved",
          "existing deterministic seam rejects the returned standing proof against actual current records",
        );
      }
      assert(
        !("version" in r.data),
        "standing acceptance invalidated after judgment must not bypass live proof in mid-loop finalization",
      );
      assert(!("license" in r.data), "dependent cannot finalize on invalid prerequisite proof");
    }
  });
}
