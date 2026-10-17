import test from "node:test";
import assert from "node:assert/strict";
import { inputs } from "./unified-review-corpus.mjs";
import { offlineDeps } from "./unified-review-offline-deps.mjs";
const root =
  new URL("..", import.meta.url).pathname;
const { runLeanInvestigation } = await import(`${root}/dist/lib/lean-investigation.js`);
test("optional prerequisite in mandatory closure outranks unrelated optional work", async () => {
  const c = structuredClone(inputs[0]);
  c.contract.requirements = {
    unrelated: { question: "Optional identifier?", schema: { type: "string" }, required: false },
    version: { ...c.contract.requirements.version, required: false },
    csv: { ...c.contract.requirements.csv, required: true, dependsOn: ["version"] },
  };
  c.contract.limits = { maxJudgeAttempts: 2 };
  const { deps, calls } = offlineDeps(c);
  deps.search = async () => [{ url: c.sources[0].url, title: c.sources[0].title }];
  const extract = deps.extract;
  deps.extract = async (input) => {
    const result = await extract(input);
    result.rawOutput = JSON.stringify(
      Object.fromEntries(
        input.fields.map((f) => [f.id, { value: "2.4", quote: "Aster release 2.4." }]),
      ),
    );
    return result;
  };
  const result = await runLeanInvestigation(c.contract, deps);
  assert(calls.judge.length + calls.candidateJudge.length <= 2);
  assert.equal(result.data.version, "2.4");
  assert.equal(
    result.data.csv,
    "supported",
    "unrelated optional work consumed mandatory prerequisite+dependent budget",
  );
  assert.equal(result.status, "complete");
});
