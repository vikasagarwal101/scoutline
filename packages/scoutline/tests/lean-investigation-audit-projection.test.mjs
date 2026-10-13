import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { runLeanInvestigation } from "../dist/lib/lean-investigation.js";
import { createLeanJevJudge } from "../dev-dist/lean-jev-adapter.js";
const ROOT =
  new URL("..", import.meta.url).pathname;

for (const malformed of [null, undefined]) {
  test(`${String(malformed)} normalized response remains inspectable without raw crash`, async () => {
    let result;
    let error;
    try {
      result = await runLeanInvestigation(
        {
          schemaVersion: 1,
          question: "Assess",
          requirements: {
            csv: { question: "CSV?", required: true, schema: { enum: ["supported"] } },
          },
        },
        {
          now: () => 0,
          search: async () => [{ url: "https://fixture.invalid/guide" }],
          read: async () => "Supports CSV",
          judge: async () => malformed,
        },
      );
    } catch (caught) {
      error = caught;
    }
    if (error) {
      assert.equal(
        typeof error.code,
        "string",
        "raw TypeError is not an inspectable malformed outcome",
      );
      return;
    }
    assert.equal(result.requirements.csv.status, "unresolved");
    assert.equal(result.evidence[0].content, "Supports CSV");
    assert.equal(result.usage.judgeCalls, 1);
    assert.equal(Object.hasOwn(result.data, "csv"), false);
    assert.ok(result.requirements.csv.attemptedRecords.some((record) => record.trusted === false));
  });
}

// Unchanged runner, actual engine+adapter and fixture native probabilities.
async function reportFor(mode) {
  const logs = [];
  const results = [];
  const context = vm.createContext({
    Date,
    console: { log: (value) => logs.push(value), error: () => {} },
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
            const hasGuide = request.state.sources.some((doc) => doc.url.includes("guide"));
            const answers = Object.fromEntries(
              request.state.sources.flatMap((doc, i) =>
                ["r", "s", "f"].map((axis) => {
                  let probability = 0.01;
                  if (doc.url.includes("guide"))
                    probability = axis === "f" && mode !== "both" ? 0.01 : 0.97;
                  else if (doc.url.includes("keywords")) {
                    if (mode === "persistent") probability = axis === "s" ? 0.01 : 0.25;
                    else if (mode === "resolve" && !hasGuide)
                      probability = axis === "f" ? 0.01 : 0.25;
                  } else if (doc.url.includes("limitations"))
                    probability = axis === "s" ? 0.01 : 0.97;
                  return [`q${i}${axis}`, { type: "noul", noul: probability }];
                }),
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
  return { report: JSON.parse(logs[0]), result: results[0] };
}

test("resolved old null remains audit history but is not current pending opposite", async () => {
  const { report, result } = await reportFor("resolve");
  assert.equal(result.data.csv, "supported");
  assert.equal(result.requirements.csv.assessments[0][0].relevant, null);
  const row = report.cases[0].actual.requirements.csv;
  assert.ok(
    row.attemptedRecords.some((record) =>
      record.assessments.some((doc) => doc.evidenceId === "e1" && doc.relevant === null),
    ),
    "old unknown must not be deleted to clean projection",
  );
  assert.deepEqual(
    row.pendingPossibleOpposite,
    [],
    "historical unknowns and known nonrefutations cannot be current blockers",
  );
});

test("known refutation-false supporting source is not pending opposite", async () => {
  const { report, result } = await reportFor("resolve");
  assert.equal(result.data.csv, "supported");
  const row = report.cases[0].actual.requirements.csv;
  assert.equal(
    row.pendingPossibleOpposite.some((doc) => doc.refutesClaim === false),
    false,
  );
  assert.deepEqual(row.clearContributions, [{ evidenceId: "e3", side: "support" }]);
});

test("one clear true-both source reports both contribution sides", async () => {
  const { report, result } = await reportFor("both");
  assert.equal(result.data.csv, "disputed");
  const row = report.cases[0].actual.requirements.csv;
  assert.ok(
    row.clearContributions.some((doc) => doc.evidenceId === "e3" && doc.side === "support"),
  );
  assert.ok(
    row.clearContributions.some((doc) => doc.evidenceId === "e3" && doc.side === "refute"),
    "single-doc refutation side cannot disappear behind support ternary",
  );
});

test("control: persistent potential refutation remains pending with trusted history visible", async () => {
  const { report, result } = await reportFor("persistent");
  assert.equal(result.requirements.csv.status, "unresolved");
  assert.equal(Object.hasOwn(result.data, "csv"), false);
  const row = report.cases[0].actual.requirements.csv;
  assert.ok(
    row.pendingPossibleOpposite.some(
      (doc) => doc.evidenceId === "e1" && doc.relevant === null && doc.refutesClaim === null,
    ),
  );
  assert.ok(
    row.clearContributions.some((doc) => doc.evidenceId === "e3" && doc.side === "support"),
  );
  assert.equal(row.attemptedRecords.length, 2);
});
