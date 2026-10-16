import test from "node:test";
import assert from "node:assert/strict";
import { inputs } from "./unified-review-corpus.mjs";
import { offlineDeps } from "./unified-review-offline-deps.mjs";
const root =
  new URL("..", import.meta.url).pathname;
const { runLeanInvestigation } = await import(`${root}/dist/lib/lean-investigation.js`);
test("optional value field cannot consume mandatory classification challenge reservation", async () => {
  const c = structuredClone(inputs[0]);
  const optional = { ...c.contract.requirements.version, required: false };
  const mandatory = { ...c.contract.requirements.csv, required: true };
  c.contract.requirements = { version: optional, csv: mandatory };
  c.contract.limits = { maxJudgeAttempts: 3 };
  const { deps, calls } = offlineDeps(c);
  const result = await runLeanInvestigation(c.contract, deps);
  assert(calls.judge.length + calls.candidateJudge.length <= 3);
  assert.equal(
    result.data.csv,
    "supported",
    "optional source-by-source work starved mandatory final-context assessment",
  );
  assert.equal(result.status, "complete");
});
