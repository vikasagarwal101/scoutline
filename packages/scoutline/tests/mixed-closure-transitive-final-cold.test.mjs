import test from "node:test";
import assert from "node:assert/strict";
import { inputs } from "./unified-review-corpus.mjs";
import { offlineDeps } from "./unified-review-offline-deps.mjs";
import { runLeanInvestigation } from "../dist/lib/lean-investigation.js";

for (const disputed of [false, true])
  for (const reverse of [false, true])
    for (const revised of [false, true]) {
      test(`transitive mixed closure reaches fixed point: disputed=${disputed}, reverse=${reverse}, revised=${revised}`, async () => {
        const c = structuredClone(inputs[0]);
        const version = c.contract.requirements.version;
        const middle = {
          ...structuredClone(c.contract.requirements.csv),
          question: "Middle CSV claim",
          dependsOn: ["version"],
        };
        const leaf = {
          ...structuredClone(c.contract.requirements.csv),
          question: "Leaf CSV claim",
          dependsOn: ["middle"],
        };
        c.contract.requirements = reverse ? { leaf, middle, version } : { version, middle, leaf };
        const { deps, calls, live } = offlineDeps(c, { captureLiveTargets: true });
        const enumJudge = deps.judge;
        deps.judge = async (input) => {
          const result = await enumJudge(input);
          return {
            ...result,
            documents: result.documents.map((d) => ({
              ...d,
              relevant: true,
              supportsClaim: true,
              refutesClaim: disputed,
            })),
          };
        };
        const judge = deps.candidateJudge,
          search = deps.search;
        const last = Object.values(c.contract.requirements).at(-1).question;
        let guide,
          armed = false,
          ticks = 0,
          exercised = false;
        deps.candidateJudge = async (input) => {
          if (input.source.evidenceId === "e1") guide = live.retained.get(input.source.evidenceId);
          return judge(input);
        };
        deps.search = async (query) => {
          const result = await search(query);
          if (query === `${last} contrary evidence refuted`) armed = true;
          return result;
        };
        deps.now = () => {
          if (armed && ++ticks === 2) {
            assert(guide);
            if (revised) live.reviseSource(guide, (guide) => {
              guide.content += "\nActual terminal record revision.";
            });
            exercised = true;
          }
          return 0;
        };
        const r = await runLeanInvestigation(c.contract, deps);
        assert(exercised);
        assert.equal(
          r.usage.searches,
          7,
          "all frozen primary and contrary queries completed within existing ceiling",
        );
        for (const field of Object.values(c.contract.requirements)) {
          assert(calls.search.includes(`${field.question} contrary evidence refuted`));
        }
        if (revised) {
          assert.deepEqual(r.data, {});
          assert.equal(r.requirements.version.reason, "final_context_unassessed");
          assert.equal(r.requirements.middle.reason, "prerequisite_unproven");
          assert.equal(r.requirements.leaf.reason, "prerequisite_unproven");
        } else {
          assert.equal(r.data.version, "2.4");
          assert.equal(r.data.middle, disputed ? "disputed" : "supported");
          assert.equal(r.data.leaf, disputed ? "disputed" : "supported");
        }
      });
    }
