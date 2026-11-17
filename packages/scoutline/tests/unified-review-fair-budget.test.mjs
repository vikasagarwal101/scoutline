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
  assert.equal(calls.candidateJudge.length, 1, "optional work receives exactly one candidate dispatch");
  assert.equal(calls.judge.length, 2, "mandatory classification receives its initial and final-context dispatches");
  assert.equal(result.usage.candidateJudgeCalls, calls.candidateJudge.length);
  assert.equal(result.usage.judgeCalls, calls.judge.length);
  assert.equal(result.evidence.length, 2);
  const finalDocuments = calls.judge.at(-1).documents;
  assert.equal(finalDocuments.length, result.evidence.length, "final classification receives every retained document");
  assert.deepEqual(
    finalDocuments.map((document) => document.evidenceId).sort(),
    result.evidence.map((record) => record.evidenceId).sort(),
  );
  for (const document of finalDocuments) {
    const retained = result.evidence.find((record) => record.evidenceId === document.evidenceId);
    assert(retained);
    assert.equal(document.url, retained.url);
    assert.equal(document.content, retained.content);
  }
  assert.equal(
    result.data.csv,
    "supported",
    "optional source-by-source work starved mandatory final-context assessment",
  );
  assert.equal(result.status, "complete");
});
