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
const row = (id) => ({
  id,
  source: "Invoice identifier: INV-1. License: MIT",
  gold: { invoiceId: "INV-1", license: "MIT" },
  rawOutput,
  finishReason: "stop",
});
async function run(mode) {
  let extracts = 0,
    judges = 0;
  const logs = [];
  const fixtureText =
    (mode === "oversize-file" ? " ".repeat(1_048_577) : "") +
    JSON.stringify({ results: mode === "unknown-usage" ? [row("one"), row("two")] : [row("one")] });
  const paths = {
    "fixture.json": fixtureText,
    "rates.json": JSON.stringify({
      extractionInputPerMillion: 1,
      extractionOutputPerMillion: 2,
      judgeInputPerMillion: 3,
      judgeOutputPerMillion: 4,
    }),
    "replay.json": JSON.stringify({ results: [{ ...row("bad"), source: 42 }] }),
  };
  const context = vm.createContext({
    Date,
    Buffer,
    console: { log: (text) => logs.push(text), error: () => {} },
    process: {
      argv: [
        "node",
        "runner",
        "--live",
        "--fixture",
        "fixture.json",
        "--cost-rates",
        "rates.json",
        ...(mode === "invalid-replay" ? ["--rejection-fixtures", "replay.json"] : []),
      ],
      env: {
        LUNA_DEV_ENDPOINT: "https://fixture.invalid/native",
        LUNA_DEV_MODEL: "fixture",
        LUNA_DEV_API_KEY: "secret",
        JEV_DEV_ENDPOINT: "https://fixture.invalid/native",
        JEV_DEV_MODEL: "fixture",
        JEV_DEV_API_KEY: "secret",
      },
      exit: () => {
        throw Error("preflight exit");
      },
    },
  });
  // Mechanical fs-stub addition (parent-authorized): fixture-backed
  // openSync/readSync/closeSync for the runner's bounded-read preflight.
  // Per-path descriptors, correct offsets, EOF 0, exact Buffer bytes.
  const openFds = new Map();
  let nextFd = 3;
  const builtin = new vm.SyntheticModule(
    ["readFileSync", "statSync", "openSync", "readSync", "closeSync", "fstatSync"],
    function () {
      this.setExport("readFileSync", (path) => paths[path]);
      this.setExport("statSync", (path) => ({ size: Buffer.byteLength(paths[path]), isFile: () => true }));
      this.setExport("openSync", (path) => {
        const fd = nextFd++;
        openFds.set(fd, { text: paths[path], pos: 0 });
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
        return n; // 0 at EOF
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
  const pm = new vm.SyntheticModule(
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
  const tm = new vm.SyntheticModule(
    ["runLunaExtraction", "runCandidateJudge"],
    function () {
      this.setExport("runLunaExtraction", async (input, config) => {
        extracts++;
        return runLunaExtraction(input, config, async () => {
          if (mode === "unknown-usage" && extracts === 2)
            throw Error("network failed after uncertain remote dispatch");
          return new Response(
            JSON.stringify({
              model: "fixture-resolved",
              usage: { prompt_tokens: 100, completion_tokens: 10 },
              choices: [{ finish_reason: "stop", message: { content: rawOutput } }],
            }),
          );
        });
      });
      this.setExport("runCandidateJudge", async (input, config, build) => {
        judges++;
        return runCandidateJudge(
          input,
          config,
          build,
          async () =>
            new Response(
              JSON.stringify({
                model: "fixture-resolved",
                usage: { input_tokens: 200, output_tokens: 20 },
                answers: Object.fromEntries(
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
      name === "node:fs" ? builtin : name.includes("transport") ? tm : pm,
    );
    await module.evaluate();
  } catch (caught) {
    error = caught;
  }
  return { extracts, judges, error, report: logs.length ? JSON.parse(logs[0]) : undefined };
}
test("invalid rejection workload preflights before primary model work", async () => {
  const { extracts, judges, error } = await run("invalid-replay");
  assert.ok(error);
  assert.equal(extracts, 0, "late replay validation cannot undo already billed primary extraction");
  assert.equal(judges, 0);
});
test("raw fixture file byte ceiling includes whitespace before JSON parsing", async () => {
  const { extracts, judges, error } = await run("oversize-file");
  assert.ok(error, "reserializing parsed JSON loses actual file bytes");
  assert.equal(extracts, 0);
  assert.equal(judges, 0);
});
test("unknown physical attempt usage cannot produce complete total cost estimate", async () => {
  const { report, error } = await run("unknown-usage");
  assert.equal(error, undefined);
  assert.equal(report.metrics.acceptedCorrect, 2);
  assert.equal(report.caps.extract.used, 2);
  assert.ok(report.attempts.some((a) => !a.ok && !a.usage));
  assert.equal(
    report.metrics.estimatedOfficialCost.total,
    null,
    "known token subtotal is not full workload cost",
  );
  assert.equal(report.metrics.estimatedOfficialCost.costPerCorrectAccepted, null);
});
test("control: complete measured workload keeps finite stage-priced estimate", async () => {
  const { report, extracts, judges, error } = await run("ok");
  assert.equal(error, undefined);
  assert.equal(extracts, 1);
  assert.equal(judges, 1);
  assert.equal(report.metrics.acceptedCorrect, 2);
  assert.ok(Math.abs(report.metrics.estimatedOfficialCost.total - 0.0008) < 1e-12);
  assert.ok(Math.abs(report.metrics.estimatedOfficialCost.costPerCorrectAccepted - 0.0004) < 1e-12);
});
