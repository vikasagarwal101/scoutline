import test from "node:test";
import assert from "node:assert/strict";
import { runLeanInvestigation } from "../dist/lib/lean-investigation.js";
import { inputs } from "./unified-review-corpus.mjs";
import { offlineDeps } from "./unified-review-offline-deps.mjs";
test("post-adverse dependent actually rejudges against revised accepted prerequisite", async () => {
  const c = structuredClone(inputs.find((x) => x.id === "dune-late-adverse"));
  c.contract.requirements.version.dependsOn = ["csv"];
  c.contract.requirements = {
    csv: c.contract.requirements.csv,
    version: c.contract.requirements.version,
  };
  c.contract.limits = { maxJudgeAttempts: 8 };
  const { deps, calls } = offlineDeps(c);
  const search = deps.search;
  deps.search = (query) =>
    query.startsWith(c.contract.requirements.version.question) && query.includes("contrary")
      ? Promise.resolve(
          [c.sources.find((s) => s.id === "dune-late")].map((s) => ({
            url: s.url,
            title: s.title,
          })),
        )
      : search(query);
  await runLeanInvestigation(c.contract, deps);
  const postAdverse = calls.candidateJudge.filter(
    (x) =>
      x.candidates.some((c) => c.fieldId === "version") &&
      [x.source, ...x.opposingContext].some((s) => s.content.includes("GPL-3.0")),
  );
  assert(
    postAdverse.length > 0,
    "dependent must actually dispatch after adverse acquisition; empty filtered list is not proof",
  );
  for (const input of postAdverse) {
    assert.equal(input.depBindings.csv.value, "disputed");
    assert.match(input.depBindings.csv.sourceDigest, /^[a-f0-9]{64}$/);
    assert.equal(typeof input.depBindings.csv.evidenceId, "string");
  }
});
