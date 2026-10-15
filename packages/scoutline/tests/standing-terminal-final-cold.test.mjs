import test from "node:test";
import assert from "node:assert/strict";
import { inputs } from "./unified-review-corpus.mjs";
import { offlineDeps } from "./unified-review-offline-deps.mjs";
import { runLeanInvestigation } from "../dist/lib/lean-investigation.js";
import { acceptCandidate } from "../dist/lib/lean-candidates.js";

for (const mode of ["unchanged", "source-revision", "scope-revision"]) {
  test(`terminal projection is revalidated before assembly: ${mode}`, async () => {
    const c = structuredClone(inputs[0]);
    const { deps } = offlineDeps(c);
    const judge = deps.candidateJudge,
      search = deps.search;
    let guide,
      scope,
      armed = false,
      afterSearch = 0,
      exercised = false;
    deps.candidateJudge = async (input) => {
      if (input.source.evidenceId === "e1") guide = input.source;
      scope = input.scope;
      return judge(input);
    };
    deps.search = async (query) => {
      const results = await search(query);
      if (query === `${c.contract.requirements.csv.question} contrary evidence refuted`)
        armed = true;
      return results;
    };
    // First now() logs the final successful search. Second now() is the
    // next loop entry, after mid-loop finalization has made fields terminal.
    deps.now = () => {
      if (armed && ++afterSearch === 2) {
        assert(guide && scope);
        if (mode === "source-revision") guide.content += "\nRevised retained representation.";
        if (mode === "scope-revision") scope.release = "3.0";
        exercised = true;
      }
      return 0;
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
        const outcome = row.candidates.find(
          (x) => x.status === "candidate" && x.value === p.value && x.quote === p.quote,
        );
        const checked = acceptCandidate(outcome, row.judgment, source, p.sourceDigest, {
          fieldMeanings: {
            version: [
              c.contract.requirements.version.question,
              ...c.contract.requirements.version.criteria,
            ].join("\n"),
          },
          scope,
          opposingContext: r.evidence.filter((e) => e.evidenceId !== p.sourceId),
          depBindings: {},
        });
        assert.equal(
          checked.status,
          "unresolved",
          "existing seam rejects actual returned proof under final live context",
        );
      }
      assert(
        !("version" in r.data),
        "already-terminal acceptance must still satisfy final current proof before assembly",
      );
      assert(
        !("license" in r.data),
        "terminal dependent must be withdrawn with invalid prerequisite",
      );
    }
  });
}
