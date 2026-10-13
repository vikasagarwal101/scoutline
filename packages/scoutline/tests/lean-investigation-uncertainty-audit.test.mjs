import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { runLeanInvestigation } from "../dist/lib/lean-investigation.js";
import { createLeanJevJudge } from "../dev-dist/lean-jev-adapter.js";
const ROOT =
  new URL("..", import.meta.url).pathname;
const CONFIG = {
  endpoint: "https://fixture.invalid/private-endpoint-marker",
  model: "fixture-request",
  apiKey: "private-credential-marker",
  timeoutMs: 50,
};
const CONTRACT = {
  schemaVersion: 1,
  question: "Assess",
  requirements: {
    csv: {
      question: "CSV?",
      required: true,
      schema: { enum: ["supported", "refuted", "disputed"] },
    },
  },
};
function objects(value, predicate, out = []) {
  if (!value || typeof value !== "object") return out;
  if (predicate(value)) out.push(value);
  for (const child of Object.values(value)) objects(child, predicate, out);
  return out;
}
const isAssessment = (v) =>
  Object.hasOwn(v, "evidenceId") &&
  Object.hasOwn(v, "relevant") &&
  Object.hasOwn(v, "supportsClaim") &&
  Object.hasOwn(v, "refutesClaim");
const isMeta = (v) =>
  Object.hasOwn(v, "probabilities") &&
  Object.hasOwn(v, "usage") &&
  Object.hasOwn(v, "attemptSha256");
const hasUntrustedMarker = (v) =>
  v.trusted === false ||
  v.accepted === false ||
  Object.values(v).some(
    (x) => typeof x === "string" && /reject|untrust|inconsisten|invalid/.test(x),
  );

test("all native attempts survive rejected known-to-unknown history with explicit untrusted records", async () => {
  let calls = 0;
  const judge = createLeanJevJudge(CONFIG, async (_endpoint, init) => {
    calls++;
    const request = JSON.parse(init.body);
    const answers = Object.fromEntries(
      request.state.sources.flatMap((_, i) =>
        ["r", "s", "f"].map((kind) => [
          `q${i}${kind}`,
          {
            type: "noul",
            noul: kind === "f" ? 0.01 : kind === "s" && i === 0 && calls > 1 ? 0.25 : 0.97,
          },
        ]),
      ),
    );
    return new Response(
      JSON.stringify({
        model: "fixture-resolved",
        usage: { input_tokens: calls, output_tokens: 1 },
        answers,
      }),
    );
  });
  const result = await runLeanInvestigation(CONTRACT, {
    now: () => 0,
    search: async (query) => [
      {
        url: `https://fixture.invalid/${query === "Assess" ? "one" : query === "CSV?" ? "two" : "three"}`,
      },
    ],
    read: async () => "Supports CSV",
    judge,
  });
  assert.equal(result.requirements.csv.status, "unresolved");
  assert.equal(result.requirements.csv.inconsistentJudgments, 2);
  assert.equal(Object.hasOwn(result.data, "csv"), false);
  assert.equal(calls, 3);
  const metas = objects(result, isMeta);
  assert.equal(
    new Set(metas.map((m) => m.attemptSha256)).size,
    3,
    "rejected rounds must preserve distinct native attempt probabilities and identity",
  );
  assert.ok(metas.filter((m) => m.probabilities.q0s === 0.25).length >= 2);
  const rejectedRecords = objects(
    result,
    (v) =>
      hasUntrustedMarker(v) &&
      objects(v, isAssessment).some((a) => a.evidenceId === "e1" && a.supportsClaim === null),
  );
  assert.ok(
    rejectedRecords.length >= 2,
    "rejected null records must be inspectable and explicitly untrusted",
  );
});

test("malformed new assessment is audited as invalid without contribution", async () => {
  let calls = 0;
  const result = await runLeanInvestigation(CONTRACT, {
    now: () => 0,
    search: async (query) =>
      query === "Assess"
        ? [{ url: "https://fixture.invalid/one" }]
        : query === "CSV?"
          ? [{ url: "https://fixture.invalid/two" }]
          : [],
    read: async () => "Supports CSV",
    judge: async ({ documents }) => {
      calls++;
      const response = {
        documents: documents.slice(0, 1).map((doc) => ({
          evidenceId: doc.evidenceId,
          relevant: true,
          supportsClaim: true,
          refutesClaim: false,
        })),
      };
      response[Symbol.for("leanJevAttemptMeta")] = {
        attemptSha256: String(calls).repeat(64),
        usage: { inputTokens: 1, outputTokens: 1 },
        probabilities: { q0s: calls === 1 ? 0.97 : 0.25 },
      };
      return response;
    },
  });
  assert.equal(result.requirements.csv.status, "unresolved");
  assert.equal(Object.hasOwn(result.data, "csv"), false);
  assert.equal(calls, 2);
  assert.equal(
    new Set(objects(result, isMeta).map((m) => m.attemptSha256)).size,
    2,
    "malformed attempts cannot vanish from audit trail",
  );
  assert.ok(
    objects(result, (v) => hasUntrustedMarker(v) && JSON.stringify(v).includes("0.25")).length > 0,
  );
});

// Read and execute the runner unchanged, using actual engine+adapter with
// fixture native probabilities. No source transform or live request.
async function runnerReport() {
  const logs = [];
  const context = vm.createContext({
    Date,
    console: { log: (text) => logs.push(text), error: () => {} },
    process: {
      argv: ["node", "runner", "--live"],
      env: {
        JEV_DEV_ENDPOINT: CONFIG.endpoint,
        JEV_DEV_MODEL: CONFIG.model,
        JEV_DEV_API_KEY: CONFIG.apiKey,
      },
      exit: () => {
        throw Error("unexpected exit");
      },
    },
  });
  const engine = new vm.SyntheticModule(
    ["runLeanInvestigation"],
    function () {
      this.setExport("runLeanInvestigation", (contract, deps) =>
        runLeanInvestigation(JSON.parse(JSON.stringify(contract)), deps),
      );
    },
    { context },
  );
  const adapter = new vm.SyntheticModule(
    ["createLeanJevJudge"],
    function () {
      this.setExport("createLeanJevJudge", (config, _fetch, hooks) =>
        createLeanJevJudge(
          config,
          async (_endpoint, init) => {
            const request = JSON.parse(init.body);
            const answers = Object.fromEntries(
              request.state.sources.flatMap((doc, i) =>
                ["r", "s", "f"].map((kind) => {
                  let p;
                  if (doc.url.includes("keywords")) p = kind === "f" ? 0.25 : 0.5;
                  else if (doc.url.includes("limitations")) p = kind === "s" ? 0.01 : 0.97;
                  else if (doc.url.includes("guide")) p = kind === "f" ? 0.01 : 0.97;
                  else p = 0.01;
                  return [`q${i}${kind}`, { type: "noul", noul: p }];
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
  return JSON.parse(logs[0]);
}

test("runner identifies uncertainty revision in every completed native attempt", async () => {
  const report = await runnerReport();
  assert.ok(report.attempts.length > 0);
  assert.ok(
    report.attempts.every(
      (attempt) => attempt.kind !== "ok" || attempt.uncertaintyRevision === "per-source-null-v1",
    ),
    "saved run must identify its answer-specific uncertainty policy",
  );
  assert.equal(JSON.stringify(report).includes(CONFIG.endpoint), false);
  assert.equal(JSON.stringify(report).includes(CONFIG.apiKey), false);
});

test("runner preserves source assessments and clear support plus pending opposite uncertainty", async () => {
  const report = await runnerReport();
  const progression = report.cases.find((row) => row.id === "progression");
  assert.equal(progression.actual.data.csv, undefined);
  assert.match(progression.actual.csv, /unresolved/);
  const rows = objects(progression, isAssessment);
  assert.ok(
    rows.some((row) => row.evidenceId === "e1" && row.refutesClaim === null),
    "possible counterevidence must be inspectable in report",
  );
  assert.ok(
    rows.some(
      (row) => row.evidenceId === "e3" && row.relevant === true && row.supportsClaim === true,
    ),
    "clear support must survive compact report projection",
  );
  assert.ok(JSON.stringify(progression).includes("uncertain"));
});

test("control: actual engine remains blocked by possible opposite evidence", async () => {
  const result = await runLeanInvestigation(CONTRACT, {
    now: () => 0,
    search: async (query) =>
      query === "Assess"
        ? [{ url: "https://fixture.invalid/guide" }, { url: "https://fixture.invalid/junk" }]
        : [],
    read: async () => "Fixture",
    judge: async ({ documents }) => ({
      documents: documents.map((doc, i) => ({
        evidenceId: doc.evidenceId,
        relevant: i ? null : true,
        supportsClaim: i ? false : true,
        refutesClaim: i ? null : false,
      })),
    }),
  });
  assert.equal(result.requirements.csv.status, "unresolved");
  assert.ok(result.requirements.csv.evidenceIds.includes("e1"));
  assert.equal(Object.hasOwn(result.data, "csv"), false);
});
