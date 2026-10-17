import test from "node:test";
import assert from "node:assert/strict";
import { runLeanInvestigation } from "../dist/lib/lean-investigation.js";
import { inputs } from "./unified-review-corpus.mjs";
import { offlineDeps } from "./unified-review-offline-deps.mjs";
test("budget-exhausted final context cannot retain stale accepted prerequisite or dependent", async () => {
  const c = structuredClone(inputs.find((x) => x.id === "dune-late-adverse"));
  c.contract.requirements.version.dependsOn = ["csv"];
  c.contract.requirements = {
    csv: c.contract.requirements.csv,
    version: c.contract.requirements.version,
  };
  c.contract.limits = { maxJudgeAttempts: 5 };
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
  const result = await runLeanInvestigation(c.contract, deps);
  assert(result.evidence.some((s) => s.content.includes("GPL-3.0")));
  assert.notEqual(
    result.data.csv,
    "supported",
    "smaller-context support cannot survive unassessed final adverse evidence",
  );
  if ("csv" in result.data) {
    assert.equal(result.data.csv, "disputed", "a present final classification must retain both evidenced sides");
  }
  if ("version" in result.data) {
    assert.equal(result.data.csv, "disputed");
    assert(
      calls.candidateJudge.some(
        (x) =>
          x.candidates.some((c) => c.fieldId === "version") &&
          x.depBindings.csv?.value === "disputed" &&
          [x.source, ...x.opposingContext].some((s) => s.content.includes("GPL-3.0")),
      ),
    );
  }
  assert(calls.judge.length + calls.candidateJudge.length <= 5);
});
