import test from "node:test";
import assert from "node:assert/strict";
import { inputs } from "./unified-review-corpus.mjs";
import { offlineDeps } from "./unified-review-offline-deps.mjs";
const root =
  new URL("..", import.meta.url).pathname;
const { runLeanInvestigation } = await import(`${root}/dist/lib/lean-investigation.js`);
test("global deadline is checked before candidate semantic dispatch after extraction consumes remaining time", async () => {
  const c = structuredClone(inputs[0]);
  c.contract.requirements = { version: c.contract.requirements.version };
  c.contract.limits = { deadlineMs: 10 };
  const { deps, calls } = offlineDeps(c);
  let elapsed = 0;
  deps.now = () => elapsed;
  const extract = deps.extract;
  deps.extract = async (input) => {
    const response = await extract(input);
    elapsed = 11;
    return response;
  };
  const result = await runLeanInvestigation(c.contract, deps);
  assert(calls.extract.length > 0);
  assert.equal(calls.candidateJudge.length, 0, "judge dispatched after declared deadline expired");
  assert.deepEqual(result.data, {});
});
