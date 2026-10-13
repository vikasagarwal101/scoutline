import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import * as pure from "../dist/lib/lean-candidates.js";
import {
  runLunaExtraction,
  runCandidateJudge,
} from "../dev-dist/lean-candidate-transport.js";
const ROOT =
  new URL("..", import.meta.url).pathname;
const rawOutput =
  '{"invoiceId":{"value":"INV-1","quote":"Invoice identifier: INV-1"},"license":{"value":"MIT","quote":"License: MIT"}}';
const record = (id = "one") => ({
  id,
  source: "Invoice identifier: INV-1. License: MIT",
  gold: { invoiceId: "INV-1", license: "MIT" },
  rawOutput,
  finishReason: "stop",
});
const RATES = {
  extractionInputPerMillion: 1,
  extractionOutputPerMillion: 2,
  judgeInputPerMillion: 3,
  judgeOutputPerMillion: 4,
};
async function run({
  mode = "ok",
  fixture = { results: [record()] },
  rates = RATES,
  replay,
  dry = false,
  nowStart = 0,
} = {}) {
  const logs = [];
  let extracts = 0,
    judges = 0,
    now = nowStart;
  const configs = [];
  const context = vm.createContext({
    Date: { now: () => now },
    Buffer,
    console: { log: (text) => logs.push(text), error: () => {} },
    process: {
      argv: [
        "node",
        "runner",
        ...(!dry ? ["--live"] : []),
        "--fixture",
        "fixture.json",
        "--cost-rates",
        "rates.json",
        ...(replay ? ["--rejection-fixtures", "replay.json"] : []),
      ],
      env: {
        LUNA_DEV_ENDPOINT: "https://fixture.invalid/native",
        LUNA_DEV_MODEL: "fixture",
        LUNA_DEV_API_KEY: "secret-marker",
        JEV_DEV_ENDPOINT: "https://fixture.invalid/native",
        JEV_DEV_MODEL: "fixture",
        JEV_DEV_API_KEY: "secret-marker",
      },
      exit: () => {
        throw Object.assign(Error("preflight exit"), { code: "EXIT" });
      },
    },
  });
  // Mechanical fs-stub addition (parent-authorized): bounded-read
  // preflight support — fixture-backed statSync/openSync/readSync/closeSync.
  const fixtureText = (path) => JSON.stringify(path === "rates.json" ? rates : path === "replay.json" ? replay : fixture);
  const openFds = new Map();
  let nextFd = 3;
  const builtin = new vm.SyntheticModule(
    ["readFileSync", "statSync", "openSync", "readSync", "closeSync", "fstatSync"],
    function () {
      this.setExport("readFileSync", (path) => fixtureText(path));
      this.setExport("statSync", (path) => ({ size: Buffer.byteLength(fixtureText(path)), isFile: () => true }));
      this.setExport("openSync", (path) => {
        const fd = nextFd++;
        openFds.set(fd, { text: fixtureText(path), pos: 0 });
        return fd;
      });
      this.setExport("readSync", (fd, buffer, offset, length) => {
        const entry = openFds.get(fd);
        if (entry === undefined) throw Error("bad fd");
        const remaining = Buffer.byteLength(entry.text) - entry.pos;
        const n = remaining <= 0 ? 0 : Math.min(length ?? remaining, remaining);
        if (n > 0) {
          Buffer.from(entry.text, "utf8").subarray(entry.pos, entry.pos + n).copy(buffer, offset ?? 0);
          entry.pos += n;
        }
        return n;
      });
      this.setExport("fstatSync", (fd) => {
        const entry = openFds.get(fd);
        if (entry === undefined) throw Error("bad fd");
        return { size: Buffer.byteLength(entry.text), isFile: () => true };
      });
      this.setExport("closeSync", (fd) => {
        openFds.delete(fd);
      });
    },
    { context },
  );
  const pureMod = new vm.SyntheticModule(
    [
      "validateCandidates",
      "assessCandidates",
      "acceptCandidate",
      "candidateSourceDigest",
      "buildCandidateJudgeRequest",
    ],
    function () {
      for (const key of [
        "validateCandidates",
        "assessCandidates",
        "acceptCandidate",
        "candidateSourceDigest",
        "buildCandidateJudgeRequest",
      ])
        this.setExport(key, pure[key]);
    },
    { context },
  );
  const transport = new vm.SyntheticModule(
    ["runLunaExtraction", "runCandidateJudge"],
    function () {
      this.setExport("runLunaExtraction", async (req, config) => {
        extracts++;
        configs.push({ kind: "extract", at: now, timeout: config.timeoutMs });
        const result = await runLunaExtraction(
          req,
          config,
          async () =>
            new Response(
              JSON.stringify({
                model: "fixture-resolved",
                usage: {
                  prompt_tokens: 100,
                  completion_tokens: 10,
                  completion_tokens_details: { reasoning_tokens: 3 },
                },
                ...(mode === "partial-cost" ? { cost: 0.1 } : {}),
                choices: [{ finish_reason: "stop", message: { content: rawOutput } }],
              }),
            ),
        );
        if (mode === "near-deadline") now = 299_995;
        return result;
      });
      this.setExport("runCandidateJudge", async (input, config, build) => {
        judges++;
        configs.push({ kind: "judge", at: now, timeout: config.timeoutMs });
        return runCandidateJudge(
          input,
          config,
          build,
          async () =>
            new Response(
              JSON.stringify({
                model: "fixture-resolved",
                usage: { input_tokens: 200, output_tokens: 20 },
                answers:
                  mode === "judge-error"
                    ? {}
                    : Object.fromEntries(
                        input.candidates.flatMap((_, i) => [
                          [`q${i}s`, { type: "noul", noul: 0.97 }],
                          [`q${i}c`, { type: "noul", noul: 0.01 }],
                        ]),
                      ),
              }),
            ),
        );
      });
    },
    { context },
  );
  const module = new vm.SourceTextModule(
    fs.readFileSync(`${ROOT}/scripts/lean-candidates-e2e.mjs`, "utf8"),
    { context },
  );
  let error;
  try {
    await module.link((name) =>
      name === "node:fs" ? builtin : name.includes("transport") ? transport : pureMod,
    );
    await module.evaluate();
  } catch (caught) {
    error = caught;
  }
  return {
    report: logs.length ? JSON.parse(logs[0]) : undefined,
    error,
    extracts,
    judges,
    configs,
  };
}

test("runner conserves rejected native judge measurements in all-attempt totals", async () => {
  const { report, error } = await run({ mode: "judge-error" });
  assert.equal(error, undefined);
  const rejected = report.attempts.find((a) => a.kind === "judge");
  assert.equal(rejected.ok, false);
  assert.deepEqual(rejected.usage, { inputTokens: 200, outputTokens: 20 });
  assert.equal(typeof rejected.requestSha256, "string");
  assert.deepEqual(report.metrics.usage.judge, { input: 200, output: 20 });
});
test("failed judgment still records end-to-end case time and candidate provenance", async () => {
  const { report } = await run({ mode: "judge-error" });
  const row = report.cases[0];
  assert.equal(typeof row.latencies.endToEndMs, "number");
  assert.ok(
    Object.values(row.fields).some(
      (f) =>
        f.value === "MIT" &&
        f.quote === "License: MIT" &&
        Array.isArray(f.charRange) &&
        typeof f.sourceDigest === "string",
    ),
    "validated candidate trail must survive native judge failure",
  );
});

for (const [name, fixture] of [
  ["missing gold field", { results: [{ ...record(), gold: { invoiceId: "INV-1" } }] }],
  ["non-string source", { results: [{ ...record(), source: 42 }] }],
  ["duplicate source ID", { results: [record(), record()] }],
  ["oversized retained source", { results: [{ ...record(), source: "x".repeat(65_537) }] }],
  ["fixture above1MiB file ceiling", { results: [record()], padding: "x".repeat(1_048_576) }],
  ["oversized replay raw output", { results: [{ ...record(), rawOutput: " ".repeat(65_537) }] }],
]) {
  test(`external fixture ${name} rejects before any model dispatch`, async () => {
    const { error, extracts, judges, report } = await run({ fixture });
    assert.equal(extracts, 0);
    assert.equal(judges, 0);
    assert.ok(
      error || report?.stopReasons.length,
      "invalid fixture accepted without preflight diagnostic",
    );
  });
}
test("model mismatch conserves safely parsed status/hash/usage despite rejection", async () => {
  const request = {
    sourceId: "s",
    sourceText: "Source",
    fields: [{ id: "license", description: "License" }],
  };
  const result = await runLunaExtraction(
    request,
    {
      endpoint: "https://fixture.invalid/native",
      model: "fixture",
      apiKey: "secret",
      maxRequestBytes: 4096,
      maxResponseBytes: 4096,
      timeoutMs: 20,
      allowedModels: ["allowed"],
    },
    async () =>
      new Response(
        JSON.stringify({
          model: "wrong",
          usage: { prompt_tokens: 100, completion_tokens: 10 },
          choices: [{ finish_reason: "stop", message: { content: "{}" } }],
        }),
      ),
  );
  assert.equal(result.kind, "error");
  assert.equal(result.code, "CAND_MODEL");
  assert.equal(result.observed?.usage.inputTokens, 100);
  assert.equal(result.observed?.status, 200);
  assert.equal(typeof result.observed?.requestSha256, "string");
});
for (const [name, rates] of [
  ["negative", { ...RATES, judgeInputPerMillion: -1 }],
  ["string", { ...RATES, extractionInputPerMillion: "1" }],
  ["missing", { extractionInputPerMillion: 1 }],
]) {
  test(`cost rates ${name} reject before live dispatch rather than fabricate estimate`, async () => {
    const { error, report, extracts, judges } = await run({ rates });
    assert.equal(extracts, 0);
    assert.equal(judges, 0);
    assert.ok(error || report?.stopReasons.length);
  });
}
test("dry replay uses the same16 judge ceiling instead of uncapped increments", async () => {
  const replay = { results: Array.from({ length: 20 }, (_, i) => record(`replay-${i}`)) };
  const { report, error } = await run({ dry: true, replay });
  assert.equal(error, undefined);
  assert.ok(
    report.caps.judge.used <= 16,
    "dry-run cap contract must not exceed live proof ceiling",
  );
});
test("observed total billing stays unknown if any physical attempt cost is absent", async () => {
  const { report } = await run({ mode: "partial-cost" });
  assert.equal(report.metrics.observedCost, null, "partial known cost sum is not total billing");
});
test("native extraction reasoning tokens remain observable when supplied", async () => {
  const { report } = await run();
  const attempt = report.attempts.find((a) => a.kind === "extract");
  assert.equal(attempt.usage.reasoningTokens, 3);
});

test("control: reservation before each dispatch respects extraction8 and judge16 caps", async () => {
  const fixture = { results: Array.from({ length: 20 }, (_, i) => record(`primary-${i}`)) };
  const { extracts, judges, report } = await run({ fixture });
  assert.ok(extracts <= 8 && judges <= 16);
  assert.equal(report.gold.present, 40);
});
test("control: current remaining outer time clamps each next native timeout", async () => {
  const { configs } = await run({ mode: "near-deadline" });
  assert.deepEqual(
    configs.map((c) => [c.kind, c.timeout]),
    [
      ["extract", 30_000],
      ["judge", 5],
    ],
  );
});
