import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { runLeanInvestigation } from "../dist/lib/lean-investigation.js";
import { createLeanJevJudge } from "../dev-dist/lean-jev-adapter.js";
const ROOT =
  new URL("..", import.meta.url).pathname;
async function evaluate(mode) {
  const logs = [];
  const results = [];
  const context = vm.createContext({
    Date,
    console: { log: (text) => logs.push(text), error: () => {} },
    process: {
      argv: ["node", "runner", "--live"],
      env: {
        JEV_DEV_ENDPOINT: "https://fixture.invalid/native",
        JEV_DEV_MODEL: "fixture",
        JEV_DEV_API_KEY: "fixture-key",
      },
      exit: () => {
        throw Error("unexpected exit");
      },
    },
  });
  const engine = new vm.SyntheticModule(
    ["runLeanInvestigation"],
    function () {
      this.setExport("runLeanInvestigation", async (contract, deps) => {
        const result = await runLeanInvestigation(JSON.parse(JSON.stringify(contract)), deps);
        results.push(result);
        return result;
      });
    },
    { context },
  );
  const adapter = new vm.SyntheticModule(
    ["createLeanJevJudge"],
    function () {
      this.setExport("createLeanJevJudge", (config, _fetch, hooks) =>
        createLeanJevJudge(
          config,
          async (_url, init) => {
            const request = JSON.parse(init.body);
            const probabilities = request.state.sources.map((doc) => {
              if (doc.url.includes("guide"))
                return mode === "refuted"
                  ? [0.97, 0.01, 0.97]
                  : mode === "disputed"
                    ? [0.97, 0.97, 0.97]
                    : [0.97, 0.97, 0.01];
              if (doc.url.includes("keywords"))
                return mode === "refuted"
                  ? [0.25, 0.01, 0.25]
                  : mode === "blocked" || mode === "disputed"
                    ? [0.25, 0.25, 0.25]
                    : [0.25, 0.25, 0.01];
              return [0.01, 0.01, 0.01];
            });
            const answers = Object.fromEntries(
              probabilities.flatMap((p, i) =>
                ["r", "s", "f"].map((axis, j) => [`q${i}${axis}`, { type: "noul", noul: p[j] }]),
              ),
            );
            return new Response(
              JSON.stringify({
                model: "fixture-resolved",
                usage: { input_tokens: 1, output_tokens: 1 },
                answers,
              }),
            );
          },
          hooks,
        ),
      );
    },
    { context },
  );
  const module = new vm.SourceTextModule(
    fs.readFileSync(`${ROOT}/scripts/lean-jev-e2e.mjs`, "utf8"),
    { context },
  );
  await module.link((specifier) => (specifier.includes("adapter") ? adapter : engine));
  await module.evaluate();
  return { actual: JSON.parse(logs[0]).cases[0].actual, result: results[0] };
}
test("accepted support ignores unknown support when opposite refutation is false", async () => {
  const { actual, result } = await evaluate("supported");
  assert.equal(result.data.csv, "supported");
  assert.deepEqual(
    actual.requirements.csv.pendingPossibleOpposite,
    [],
    "own-axis uncertainty is not pending opposition to accepted support",
  );
  assert.ok(
    actual.requirements.csv.attemptedRecords.some((record) =>
      record.assessments.some(
        (d) => d.evidenceId === "e1" && d.supportsClaim === null && d.refutesClaim === false,
      ),
    ),
  );
});
test("accepted refutation ignores unknown refutation when opposite support is false", async () => {
  const { actual, result } = await evaluate("refuted");
  assert.equal(result.data.csv, "refuted");
  assert.deepEqual(
    actual.requirements.csv.pendingPossibleOpposite,
    [],
    "own-axis uncertainty is not pending opposition to accepted refutation",
  );
  assert.ok(
    actual.requirements.csv.attemptedRecords.some((record) =>
      record.assessments.some(
        (d) => d.evidenceId === "e1" && d.refutesClaim === null && d.supportsClaim === false,
      ),
    ),
  );
});
test("clear established dispute has both sides and no pending acceptance blocker", async () => {
  const { actual, result } = await evaluate("disputed");
  assert.equal(result.data.csv, "disputed");
  const row = actual.requirements.csv;
  assert.ok(row.clearContributions.some((d) => d.evidenceId === "e3" && d.side === "support"));
  assert.ok(row.clearContributions.some((d) => d.evidenceId === "e3" && d.side === "refute"));
  assert.deepEqual(
    row.pendingPossibleOpposite,
    [],
    "source uncertainty cannot be labeled an acceptance blocker for fulfilled scoped disagreement",
  );
  assert.ok(
    row.attemptedRecords.some((record) =>
      record.assessments.some((d) => d.evidenceId === "e1" && d.relevant === null),
    ),
    "unknown coverage remains visible in audit",
  );
});
test("control: genuinely unknown refutation remains pending against clear support", async () => {
  const { actual, result } = await evaluate("blocked");
  assert.equal(result.requirements.csv.status, "unresolved");
  assert.equal(Object.hasOwn(result.data, "csv"), false);
  assert.ok(
    actual.requirements.csv.pendingPossibleOpposite.some(
      (d) => d.evidenceId === "e1" && d.refutesClaim === null,
    ),
  );
  assert.ok(
    actual.requirements.csv.clearContributions.some(
      (d) => d.evidenceId === "e3" && d.side === "support",
    ),
  );
});
