import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const engine = new URL("../dist/lib/lean-investigation.js", import.meta.url).href;
const corpus = new URL("./unified-review-corpus.mjs", import.meta.url).href;
const offlineDepsUrl = new URL("./unified-review-offline-deps.mjs", import.meta.url).href;
const program = `
import assert from "node:assert/strict";
import { inputs } from ${JSON.stringify(corpus)};
import { offlineDeps } from ${JSON.stringify(offlineDepsUrl)};
import { runLeanInvestigation } from ${JSON.stringify(engine)};
let deferrals = 0;
for (const budget of [1, 2, 6, 24]) for (const reverse of [false, true]) for (const optionalPrerequisite of [false, true]) {
  const c = structuredClone(inputs[0]);
  c.contract.limits = { maxJudgeAttempts: budget };
  c.contract.requirements.version.required = !optionalPrerequisite;
  if (reverse) c.contract.requirements = Object.fromEntries(Object.entries(c.contract.requirements).reverse());
  const { deps, calls } = offlineDeps(c);
  deps.search = async (q) => {
    calls.search.push(q);
    return [c.sources[q === c.contract.requirements.csv.question + " contrary evidence refuted" ? 1 : 0]].map(s => ({ url: s.url, title: s.title }));
  };
  const r = await runLeanInvestigation(c.contract, deps);
  assert(r.usage.judgeCalls + r.usage.candidateJudgeCalls <= budget);
  assert.equal(r.usage.extractorCalls, calls.extract.length);
  for (const [id, row] of Object.entries(r.requirements)) {
    assert.notEqual(row.reason, "internal_stop");
    if (row.status === "satisfied") for (const dep of c.contract.requirements[id].dependsOn ?? []) assert.equal(r.requirements[dep].status, "satisfied");
    deferrals += row.attemptedRecords.filter(x => x.metadata?.kind === "candidate-generation-deferred").length;
  }
}
assert(deferrals > 0, "bounded DAG matrix actually exercises treatment deferral");
console.log("16 budget/order/required-closure cases passed with actual deferral");
`;
test("witness deferral terminates under frozen clock across bounded DAG budgets and declaration orders", () => {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", program], { timeout: 2000, encoding: "utf8" });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /16 budget\/order\/required-closure cases passed/);
});
