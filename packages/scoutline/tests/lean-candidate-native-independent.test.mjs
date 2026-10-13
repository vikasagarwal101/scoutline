import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import * as pure from "../dist/lib/lean-candidates.js";
import {
  runLunaExtraction,
  runCandidateJudge,
  buildLunaRequestBody,
} from "../dist/lib/lean-candidate-transport.js";
const ROOT =
  new URL("..", import.meta.url).pathname;
const config = {
  endpoint: "https://fixture.invalid/native",
  model: "fixture-request",
  apiKey: "private-marker",
  maxRequestBytes: 96 * 1024,
  maxResponseBytes: 64 * 1024,
  timeoutMs: 20,
};
const source = {
  evidenceId: "s1",
  url: "https://fixture.invalid/source",
  title: "Doc",
  content: "Invoice identifier: INV-1. License: MIT",
  byteLength: 39,
  origins: [],
};
const rawOutput =
  '{"invoiceId":{"value":"INV-1","quote":"Invoice identifier: INV-1"},"license":{"value":"MIT","quote":"License: MIT"}}';
const request = {
  sourceId: source.evidenceId,
  sourceText: source.content,
  fields: [
    { id: "invoiceId", description: "Exact invoice ID" },
    { id: "license", description: "License for release 2.4.0 only" },
  ],
};
const validated = pure.validateCandidates(
  source,
  { finishReason: "stop", rawOutput },
  { invoiceId: {}, license: {} },
);
const input = {
  source,
  fieldMeanings: { invoiceId: "Exact invoice", license: "Scoped license" },
  scope: { release: "2.4.0" },
  candidates: validated.fields,
  opposingContext: [],
};
const chat = (extra = {}) => ({
  model: "fixture-resolved",
  usage: { prompt_tokens: 100, completion_tokens: 10 },
  choices: [{ finish_reason: "stop", message: { content: rawOutput } }],
  ...extra,
});
const native = (extra = {}) => ({
  model: "fixture-resolved",
  usage: { input_tokens: 200, output_tokens: 20 },
  answers: {
    q0s: { type: "noul", noul: 0.97 },
    q0c: { type: "noul", noul: 0.01 },
    q1s: { type: "noul", noul: 0.97 },
    q1c: { type: "noul", noul: 0.01 },
  },
  ...extra,
});
const response = (payload) => new Response(JSON.stringify(payload));
function objects(v, pred, out = []) {
  if (!v || typeof v !== "object") return out;
  if (pred(v)) out.push(v);
  for (const child of Object.values(v)) objects(child, pred, out);
  return out;
}

test("extractor explicit refusal cannot produce valid candidate content", async () => {
  const result = await runLunaExtraction(request, config, async () =>
    response(
      chat({
        choices: [
          { finish_reason: "stop", message: { content: rawOutput, refusal: "I cannot comply" } },
        ],
      }),
    ),
  );
  assert.ok(
    result.kind === "error" || result.value.finishReason !== "stop",
    "native refusal ignored behind apparently valid JSON",
  );
});
test("null choice cannot escape native transport as raw TypeError", async () => {
  let result;
  let error;
  try {
    result = await runLunaExtraction(request, config, async () =>
      response(chat({ choices: [null] })),
    );
  } catch (caught) {
    error = caught;
  }
  if (error) assert.equal(typeof error.code, "string");
  else assert.equal(result.kind, "error");
});
for (const [name, answers] of [
  ["missing", { q0s: native().answers.q0s }],
  ["extra", { ...native().answers, extra: { type: "noul", noul: 0.97 } }],
]) {
  test(`native judge ${name} answer IDs reject at transport boundary`, async () => {
    const result = await runCandidateJudge(
      input,
      config,
      pure.buildCandidateJudgeRequest,
      async () => response(native({ answers })),
    );
    assert.equal(result.kind, "error");
    assert.equal(result.code, "CAND_PROTOCOL");
  });
}
test("chat extractor cannot substitute System One usage counters", async () => {
  const result = await runLunaExtraction(request, config, async () =>
    response(chat({ usage: { input_tokens: 100, output_tokens: 10 } })),
  );
  assert.equal(result.kind, "error");
});
test("System One judge cannot substitute chat usage counters", async () => {
  const result = await runCandidateJudge(input, config, pure.buildCandidateJudgeRequest, async () =>
    response(native({ usage: { prompt_tokens: 200, completion_tokens: 20 } })),
  );
  assert.equal(result.kind, "error");
});
test("rejected native response conserves available request identity and measured usage", async () => {
  const result = await runCandidateJudge(input, config, pure.buildCandidateJudgeRequest, async () =>
    response(native({ answers: { q0s: { type: "noul", noul: 2 } } })),
  );
  assert.equal(result.kind, "error");
  assert.ok(
    objects(result, (v) => v.usage?.inputTokens === 200 && typeof v.requestSha256 === "string")
      .length > 0,
    "known failed-attempt measurement disappeared",
  );
  assert.equal(JSON.stringify(result).includes(config.apiKey), false);
});

// Runner unchanged; external fixtures injected via built-in VM module link.
const fixture = {
  results: ["first", "second"].map((id) => ({
    id,
    source: source.content,
    gold: { invoiceId: "INV-1", license: "MIT" },
    finishReason: "stop",
    rawOutput,
  })),
};
async function runRunner(mode = "ok") {
  const logs = [];
  let extracts = 0,
    judges = 0;
  const env = {
    LUNA_DEV_ENDPOINT: config.endpoint,
    LUNA_DEV_MODEL: config.model,
    LUNA_DEV_API_KEY: config.apiKey,
    LUNA_DEV_ALLOWED_MODELS: "fixture-resolved",
    JEV_DEV_ENDPOINT: config.endpoint,
    JEV_DEV_MODEL: config.model,
    JEV_DEV_API_KEY: config.apiKey,
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
        ...(mode === "replay" ? ["--rejection-fixtures", "replay.json"] : []),
      ],
      env,
      exit: () => {
        throw Error("exit");
      },
    },
  });
  const fixtureText = (path) => JSON.stringify(
          path === "replay.json"
            ? {
                results: [
                  {
                    id: "script-bad",
                    source: '<script>license="MIT";</script>',
                    gold: { invoiceId: null, license: null },
                    finishReason: "stop",
                    rawOutput:
                      '{"invoiceId":{"value":null,"quote":null},"license":{"value":"MIT","quote":"license=\\\"MIT\\\";"}}',
                  },
                ],
              }
            : path === "rates.json"
              ? {
                  extractionInputPerMillion: 1,
                  extractionOutputPerMillion: 2,
                  judgeInputPerMillion: 3,
                  judgeOutputPerMillion: 4,
                }
              : fixture,
      );
const builtin = new vm.SyntheticModule(
    ["readFileSync", "statSync", "openSync", "readSync", "closeSync", "fstatSync"],
    function () {
      this.setExport("readFileSync", (path) => fixtureText(path));
      this.setExport("statSync", (path) => ({ size: Buffer.byteLength(fixtureText(path)), isFile: () => true }));
      // Mechanical fs-stub addition (parent-authorized): bounded-read
      // preflight support — fixture-backed openSync/readSync/closeSync.
      const openFds = new Map();
      let nextFd = 3;
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
      this.setExport("validateCandidates", pure.validateCandidates);
      this.setExport("assessCandidates", pure.assessCandidates);
      this.setExport("candidateSourceDigest", pure.candidateSourceDigest);
      this.setExport("buildCandidateJudgeRequest", pure.buildCandidateJudgeRequest);
      this.setExport("acceptCandidate", (...args) =>
        mode === "reject-all"
          ? { fieldId: args[0].fieldId, status: "unresolved", reason: "fixture rejection" }
          : pure.acceptCandidate(...args),
      );
    },
    { context },
  );
  const transport = new vm.SyntheticModule(
    ["runLunaExtraction", "runCandidateJudge"],
    function () {
      this.setExport("runLunaExtraction", async (req, cfg) => {
        extracts++;
        if (mode === "fatal") return { kind: "error", code: "CAND_AUTH", message: "fixture" };
        if (mode === "wrong-extractor-model")
          return runLunaExtraction(req, cfg, async () => response(chat({ model: "not-allowed" })));
        return runLunaExtraction(req, cfg, async () => response(chat()));
      });
      this.setExport("runCandidateJudge", async (inp, cfg, build) => {
        judges++;
        return runCandidateJudge(inp, cfg, build, async () => {
          const answers = Object.fromEntries(
            inp.candidates.flatMap((_, i) => [
              [
                `q${i}s`,
                { type: "noul", noul: inp.source.content.includes("<script>") ? 0.01 : 0.97 },
              ],
              [`q${i}c`, { type: "noul", noul: 0.01 }],
            ]),
          );
          return response(native(mode === "protocol" ? { answers: {} } : { answers }));
        });
      });
    },
    { context },
  );
  const module = new vm.SourceTextModule(
    fs.readFileSync(`${ROOT}/scripts/lean-candidates-e2e.mjs`, "utf8"),
    { context },
  );
  await module.link((name) =>
    name === "node:fs" ? builtin : name.includes("transport") ? transport : pureMod,
  );
  await module.evaluate();
  return { report: JSON.parse(logs[0]), extracts, judges };
}
test("runner native protocol failure stops later dispatches", async () => {
  const { report, extracts, judges } = await runRunner("protocol");
  assert.equal(extracts, 1);
  assert.equal(judges, 1);
  assert.ok(report.stopReasons.length > 0);
});
test("runner extractor model allowlist is forwarded and failure stops", async () => {
  const { extracts, judges } = await runRunner("wrong-extractor-model");
  assert.equal(extracts, 1);
  assert.equal(judges, 0);
});
test("runner workload gold denominator includes skipped cases after fatal failure", async () => {
  const { report } = await runRunner("fatal");
  assert.equal(
    report.gold.present,
    4,
    "failed/skipped fields cannot disappear from eligible coverage denominator",
  );
  assert.equal(report.gold.totalSlots, 4);
});
test("runner estimates extraction and judge costs at their respective rates", async () => {
  const { report } = await runRunner();
  // 2x100/10 extraction, 2x200/20 judge; rate formula per1M.
  const expected = (200 * 1 + 20 * 2 + 400 * 3 + 40 * 4) / 1e6;
  const estimated = report.metrics.estimatedOfficialCost;
  const numbers = objects(estimated, () => false); // no field-name contract beyond numeric amounts
  const flatten = (v) =>
    !v || typeof v !== "object"
      ? []
      : Object.values(v).flatMap((x) => (typeof x === "number" ? [x] : flatten(x)));
  assert.ok(
    flatten(estimated).some((value) => Math.abs(value - expected) < 1e-12),
    `all-stage estimate must equal ${expected}`,
  );
});
test("runner reports eligible coverage and full accepted provenance/quote binding", async () => {
  const { report } = await runRunner();
  assert.equal(report.metrics.acceptedCorrect, 4);
  assert.equal(report.metrics.eligibleCoverage, 1);
  assert.ok(
    objects(
      report.cases,
      (v) =>
        v.value === "MIT" &&
        v.quote === "License: MIT" &&
        Array.isArray(v.charRange) &&
        typeof v.sourceDigest === "string",
    ).length > 0,
    "acceptance audit lost quote/range/source hash",
  );
});
test("runner cannot report useful coverage for always-rejected workload", async () => {
  const { report } = await runRunner("reject-all");
  assert.equal(report.metrics.acceptedFields, 0);
  assert.equal(report.metrics.acceptedPrecision, null);
  assert.equal(report.metrics.eligibleCoverage, 0);
});

test("extractor request forwards strict named field schema matching candidate contract", () => {
  const body = JSON.parse(buildLunaRequestBody(request, config.model));
  assert.equal(
    body.response_format.type,
    "json_schema",
    "json_object does not request the measured strict field contract",
  );
  const schema = body.response_format.json_schema.schema;
  assert.deepEqual(Object.keys(schema.properties).sort(), ["invoiceId", "license"]);
  assert.equal(schema.additionalProperties, false);
  for (const key of ["invoiceId", "license"]) {
    assert.deepEqual(Object.keys(schema.properties[key].properties).sort(), ["quote", "value"]);
    assert.equal(schema.properties[key].additionalProperties, false);
  }
});
test("structurally valid bad script replay receives semantic judgment before rejection", async () => {
  const { report, judges } = await runRunner("replay");
  assert.equal(
    judges,
    3,
    "2 primary grouped judges plus1 structurally valid bad replay judge required",
  );
  const replay = report.rejectionReplay[0];
  assert.equal(replay.judgeCalls, 1);
  assert.ok(
    objects(replay, (v) => v.status === "unresolved" && /support|eligib|refut/.test(v.reason ?? ""))
      .length > 0,
    "literal script candidate cannot be called rejected using structural checks alone",
  );
});
test("runner latency distinguishes per-case end-to-end walltime and stage distributions", async () => {
  const { report } = await runRunner();
  for (const row of report.cases.filter((c) => !c.skipped)) {
    assert.equal(typeof row.latencies.endToEndMs, "number");
    assert.ok(row.latencies.endToEndMs >= row.latencies.extractionMs);
    assert.ok(row.latencies.endToEndMs >= row.latencies.judgeMs);
  }
  assert.ok(
    report.metrics.latency.extraction &&
      report.metrics.latency.judge &&
      report.metrics.latency.endToEnd,
    "mixing extraction and judge calls into one p50 is not end-to-end latency",
  );
});

test("control: serialized full source/opposition request cap is predispatch and no trim", async () => {
  let calls = 0;
  const huge = { ...input, opposingContext: [{ ...source, content: "界".repeat(2000) }] };
  const result = await runCandidateJudge(
    huge,
    { ...config, maxRequestBytes: 1000 },
    pure.buildCandidateJudgeRequest,
    async () => {
      calls++;
      return response(native());
    },
  );
  assert.equal(result.code, "CAND_REQUEST_CAP");
  assert.equal(calls, 0);
  assert.equal(
    JSON.parse(pure.buildCandidateJudgeRequest(huge, "fixture")).state.opposingContext[0].text,
    huge.opposingContext[0].content,
  );
});
test("control: body deadline and unread status cancellation are bounded", async () => {
  for (const status of [200, 422]) {
    let cancelled = false;
    const body = new ReadableStream({
      cancel() {
        cancelled = true;
      },
    });
    const result = await runLunaExtraction(request, { ...config, timeoutMs: 5 }, async () => ({
      status,
      ok: status === 200,
      headers: new Headers(),
      body,
    }));
    assert.equal(result.code, status === 200 ? "CAND_TIMEOUT" : "CAND_PROTOCOL");
    assert.equal(cancelled, true);
  }
});
test("control: valid source request fidelity and model/usage/native mapping", async () => {
  let calls = 0;
  const result = await runLunaExtraction(
    request,
    { ...config, allowedModels: ["fixture-resolved"] },
    async (_url, init) => {
      calls++;
      assert.equal(init.redirect, "error");
      assert.equal(JSON.parse(JSON.parse(init.body).messages[1].content).source, source.content);
      return response(chat());
    },
  );
  assert.equal(result.kind, "ok");
  assert.equal(calls, 1);
  assert.deepEqual(result.metadata.usage, { inputTokens: 100, outputTokens: 10 });
  assert.equal(result.value.rawOutput, rawOutput);
});
