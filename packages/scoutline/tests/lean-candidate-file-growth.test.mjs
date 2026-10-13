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
const fixture = JSON.stringify({
  results: [
    {
      id: "one",
      source: "Invoice identifier: INV-1. License: MIT",
      gold: { invoiceId: "INV-1", license: "MIT" },
      finishReason: "stop",
      rawOutput,
    },
  ],
});
async function run(mode) {
  let extracts = 0,
    judges = 0;
  const opens = [];
  const closed = [];
  const logs = [];
  const paths = { "fixture.json": fixture, "replay.json": JSON.stringify({ results: [] }) };
  const handles = new Map();
  let next = 3;
  const context = vm.createContext({
    Buffer,
    Date,
    console: { log: (v) => logs.push(v), error: () => {} },
    process: {
      argv: [
        "node",
        "runner",
        "--live",
        "--fixture",
        "fixture.json",
        ...(mode === "replay-once" ? ["--rejection-fixtures", "replay.json"] : []),
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
  const builtin = new vm.SyntheticModule(
    ["readFileSync", "statSync", "openSync", "readSync", "closeSync", "fstatSync"],
    function () {
      this.setExport("readFileSync", (path) => paths[path]);
      this.setExport("statSync", (path) => ({
        size: Buffer.byteLength(paths[path]),
        isFile: () => mode !== "nonregular",
      }));
      this.setExport("openSync", (path) => {
        const fd = next++;
        opens.push(path);
        // File is a valid JSON prefix at stat time, then grows before open.
        const bytes = Buffer.from(
          paths[path] + (mode === "growth" && path === "fixture.json" ? " ".repeat(1_048_577) : ""),
        );
        handles.set(fd, { bytes, at: 0 });
        return fd;
      });
      this.setExport("fstatSync", (fd) => ({
        size: handles.get(fd).bytes.length,
        isFile: () => true,
      }));
      this.setExport("readSync", (fd, buffer, offset, length, position) => {
        const handle = handles.get(fd);
        const at = position == null ? handle.at : position;
        const n = Math.min(length, Math.max(0, handle.bytes.length - at));
        handle.bytes.subarray(at, at + n).copy(buffer, offset);
        if (position == null) handle.at += n;
        return n;
      });
      this.setExport("closeSync", (fd) => {
        closed.push(fd);
        handles.delete(fd);
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
      this.setExport("runLunaExtraction", async (req, config) => {
        extracts++;
        return runLunaExtraction(
          req,
          config,
          async () =>
            new Response(
              JSON.stringify({
                model: "fixture-resolved",
                usage: { prompt_tokens: 1, completion_tokens: 1 },
                choices: [{ finish_reason: "stop", message: { content: rawOutput } }],
              }),
            ),
        );
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
                usage: { input_tokens: 1, output_tokens: 1 },
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
  const mod = new vm.SourceTextModule(
    fs.readFileSync(`${ROOT}/scripts/lean-candidates-e2e.mjs`, "utf8"),
    { context },
  );
  let error;
  try {
    await mod.link((name) => (name === "node:fs" ? builtin : name.includes("transport") ? tm : pm));
    await mod.evaluate();
  } catch (caught) {
    error = caught;
  }
  return {
    error,
    extracts,
    judges,
    opens,
    closed,
    report: logs.length ? JSON.parse(logs[0]) : undefined,
  };
}
test("file growing beyond cap after stat cannot be silently read as valid JSON prefix", async () => {
  const { error, extracts, judges, opens, closed } = await run("growth");
  assert.ok(
    error,
    "bounded read must check EOF/current fd size rather than truncate at stale stat size",
  );
  assert.equal(extracts, 0);
  assert.equal(judges, 0);
  assert.equal(closed.length, opens.length);
});
test("upfront validated replay representation is retained instead of reread after billed work", async () => {
  const { error, opens } = await run("replay-once");
  assert.equal(error, undefined);
  assert.equal(
    opens.filter((path) => path === "replay.json").length,
    1,
    "preflight replay must be the exact representation consumed later",
  );
});
test("control: unchanged exact-size regular file is fully processed and handles close", async () => {
  const { error, extracts, judges, opens, closed, report } = await run("ok");
  assert.equal(error, undefined);
  assert.equal(extracts, 1);
  assert.equal(judges, 1);
  assert.equal(report.metrics.acceptedCorrect, 2);
  assert.equal(closed.length, opens.length);
});
test("control: nonregular input rejects before opening or native work", async () => {
  const { error, extracts, judges, opens } = await run("nonregular");
  assert.ok(error);
  assert.deepEqual(opens, []);
  assert.equal(extracts, 0);
  assert.equal(judges, 0);
});
