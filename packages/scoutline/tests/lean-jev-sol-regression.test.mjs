import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { runLeanInvestigation } from "../dist/lib/lean-investigation.js";
import {
  runLeanJevJudgment,
  createLeanJevJudge,
} from "../dist/lib/lean-jev-adapter.js";

const ROOT =
  new URL("..", import.meta.url).pathname;
const config = {
  endpoint: "https://fixture.invalid/native",
  model: "fixture-request-model",
  apiKey: "fixture-credential",
  timeoutMs: 10,
};
const input = {
  fieldId: "csv",
  fieldQuestion: "CSV?",
  criteria: [],
  scope: { release: "2.4.0" },
  candidates: ["supported", "refuted", "disputed"],
  documents: [
    {
      evidenceId: "e1",
      url: "https://fixture.invalid/guide",
      title: "Guide",
      content: "Supports CSV.",
    },
  ],
};
const answers = {
  q0r: { type: "noul", noul: 1 },
  q0s: { type: "noul", noul: 1 },
  q0f: { type: "noul", noul: 0 },
};
const payload = (extra = {}) => ({
  model: "fixture-resolved-model",
  answers,
  usage: { input_tokens: 12, output_tokens: 3 },
  ...extra,
});
const response = (body = payload()) => new Response(JSON.stringify(body), { status: 200 });

test("default wrapper fetch reaches native fetch when caller omits injection", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return response();
  };
  let failure;
  let result;
  try {
    result = await createLeanJevJudge(config, undefined)(input);
  } catch (error) {
    failure = error;
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(calls, 1, "runner-style undefined fetch must dispatch one native attempt");
  assert.equal(failure, undefined);
  assert.equal(result.documents[0].supportsClaim, true);
});

for (const [name, usage] of [
  ["absent", undefined],
  ["null", null],
  ["string", "unknown"],
  ["empty", {}],
  ["partial", { input_tokens: 12 }],
]) {
  test(`${name} usage cannot become invented zero usage`, async () => {
    const result = await runLeanJevJudgment(input, config, async () =>
      response(payload({ usage })),
    );
    assert.equal(result.kind, "error", "native usage counters must be present and validated");
    assert.equal(result.code, "JEV_DEV_MALFORMED");
  });
}

test("oversized request is rejected before any transport attempt", async () => {
  let calls = 0;
  const huge = {
    ...input,
    documents: [{ ...input.documents[0], content: "界".repeat(1_000_000) }],
  };
  let result;
  let error;
  try {
    result = await runLeanJevJudgment(huge, config, async () => {
      calls++;
      return response();
    });
  } catch (caught) {
    error = caught;
  }
  assert.equal(calls, 0, "finite input ceiling must reject a 3MB representation before HTTP");
  assert.ok(error?.code || result?.kind === "error");
});

test("body timeout cancels the active response stream", async () => {
  let cancelled = false;
  const body = new ReadableStream({
    cancel() {
      cancelled = true;
    },
  });
  const result = await runLeanJevJudgment(input, config, async () => ({
    status: 200,
    ok: true,
    headers: new Headers(),
    body,
  }));
  assert.equal(result.code, "JEV_DEV_TIMEOUT");
  assert.equal(cancelled, true, "racing a timeout must not leave the bounded reader pending");
});

test("header deadline bounds injected fetch that does not honor AbortSignal", async () => {
  const result = await Promise.race([
    runLeanJevJudgment(input, config, async () => new Promise(() => {})),
    new Promise((resolve) => setTimeout(() => resolve(null), 60)),
  ]);
  assert.ok(result, "abort-only timer leaves adapter promise pending past its deadline");
  assert.equal(result.code, "JEV_DEV_TIMEOUT");
});

test("auth response cancels its unread body", async () => {
  let cancelled = false;
  const body = new ReadableStream({
    cancel() {
      cancelled = true;
    },
  });
  const result = await runLeanJevJudgment(input, config, async () => ({
    status: 401,
    ok: false,
    headers: new Headers(),
    body,
  }));
  assert.equal(result.code, "JEV_DEV_AUTH");
  assert.equal(cancelled, true);
});

test("non-success status cancels body without waiting for stalled content", async () => {
  let cancelled = false;
  const body = new ReadableStream({
    cancel() {
      cancelled = true;
    },
  });
  const result = await runLeanJevJudgment(input, config, async () => ({
    status: 422,
    ok: false,
    headers: new Headers(),
    body,
  }));
  assert.equal(
    result.code,
    "JEV_DEV_PROTOCOL",
    "known fatal status must not be hidden by body timeout",
  );
  assert.equal(cancelled, true);
});

const engineContract = {
  schemaVersion: 1,
  question: "Assess CSV",
  requirements: {
    csv: {
      question: "CSV?",
      schema: { enum: ["supported", "refuted", "disputed"] },
      required: true,
    },
  },
};
const uncertainError = () =>
  Object.assign(new Error("fixture uncertainty"), { code: "JEV_DEV_INDETERMINATE" });
test("typed indeterminate seeks fresh evidence and rejudges only changed context", async () => {
  const seen = [];
  const result = await runLeanInvestigation(engineContract, {
    now: () => 0,
    search: async (query) =>
      query === "Assess CSV"
        ? [{ url: "https://fixture.invalid/junk" }]
        : query === "CSV?"
          ? [{ url: "https://fixture.invalid/guide" }]
          : [],
    read: async (url) => (url.endsWith("junk") ? "csv export keywords" : "Supports CSV."),
    judge: async ({ documents }) => {
      seen.push(documents.map((doc) => doc.evidenceId).join(","));
      if (documents.length === 1) throw uncertainError();
      return {
        documents: documents.map((doc) => ({
          evidenceId: doc.evidenceId,
          relevant: doc.url.endsWith("guide"),
          supportsClaim: doc.url.endsWith("guide"),
          refutesClaim: false,
        })),
      };
    },
  });
  assert.deepEqual(seen, ["e1", "e1,e2"]);
  assert.equal(result.data.csv, "supported");
  assert.equal(result.status, "complete");
});

test("exhausted indeterminate is explicit without identical-context retry", async () => {
  let calls = 0;
  const result = await runLeanInvestigation(engineContract, {
    now: () => 0,
    search: async () => [{ url: "https://fixture.invalid/junk" }],
    read: async () => "Keywords only",
    judge: async () => {
      calls++;
      throw uncertainError();
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.requirements.csv.status, "unresolved");
  assert.equal(result.requirements.csv.reason, "judge_indeterminate");
  assert.equal(Object.hasOwn(result.data, "csv"), false);
});

test("control: ordinary rejected judge still ends judge_unavailable", async () => {
  let calls = 0;
  const result = await runLeanInvestigation(engineContract, {
    now: () => 0,
    search: async (q) => [{ url: `https://fixture.invalid/${q === "Assess CSV" ? "one" : "two"}` }],
    read: async () => "Supports CSV",
    judge: async () => {
      calls++;
      throw Error("ordinary transport failure");
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.requirements.csv.reason, "judge_unavailable");
});

// Execute the runner unchanged, with synthetic linked dependencies: no HTTP,
// credentials or source rewrites. The engine fixture exercises its documented
// per-case allowance (up to 8 attempts) instead of relying on today's short cases.
async function runRunner(outcome) {
  const logs = [];
  let attempts = 0;
  const fetchFixture = async () => {
    attempts++;
    return response(payload(outcome === "protocol" ? { answers: {} } : {}));
  };
  const context = vm.createContext({
    fetch: fetchFixture,
    console: { log: (text) => logs.push(text), error: () => {} },
    Date,
    process: {
      argv: ["node", "runner", "--live"],
      env: {
        JEV_DEV_ENDPOINT: config.endpoint,
        JEV_DEV_MODEL: config.model,
        JEV_DEV_API_KEY: config.apiKey,
      },
      exit: () => {
        throw Error("unexpected exit");
      },
    },
  });
  const adapter = new vm.SyntheticModule(
    ["createLeanJevJudge"],
    function () {
      this.setExport("createLeanJevJudge", (runtimeConfig, fetchLike, hooks) =>
        createLeanJevJudge(runtimeConfig, fetchLike ?? fetchFixture, hooks),
      );
    },
    { context },
  );
  const engine = new vm.SyntheticModule(
    ["runLeanInvestigation"],
    function () {
      this.setExport("runLeanInvestigation", async (_contract, deps) => {
        if (deps.judge)
          for (let i = 0; i < (outcome === "protocol" ? 1 : 8); i++) {
            try {
              await deps.judge(input);
            } catch {
              break;
            }
          }
        return {
          status: "empty",
          data: {},
          requirements: {
            csv: {
              status: "unresolved",
              reason: deps.judge ? "judge_unavailable" : "no_semantic_judge",
            },
          },
          assessment: deps.judge ? "semantic" : "deterministic-only",
          usage: { judgeCalls: 0 },
          evidence: [],
        };
      });
    },
    { context },
  );
  const module = new vm.SourceTextModule(
    fs.readFileSync(`${ROOT}/scripts/lean-jev-e2e.mjs`, "utf8"),
    { context },
  );
  await module.link((specifier) => (specifier.includes("adapter") ? adapter : engine));
  await module.evaluate();
  return { attempts, report: JSON.parse(logs[0]) };
}

test("runner stops subsequent judge cases on native protocol failure", async () => {
  const { attempts, report } = await runRunner("protocol");
  assert.equal(attempts, 1, "protocol failure must stop remaining live cases");
  assert.ok(report.stopReasons.length > 0);
});

test("runner reserves global cap before every allowed per-case judge attempt", async () => {
  const { attempts, report } = await runRunner("ok");
  assert.ok(attempts <= 12, `global cap exceeded by ${attempts - 12} calls`);
  assert.ok(report.caps.attemptsUsed <= report.caps.globalAttemptCap);
});

test("control: valid exact native probabilities preserve observed usage", async () => {
  const result = await runLeanJevJudgment(input, config, async () => response());
  assert.equal(result.kind, "ok");
  assert.deepEqual(result.metadata.usage, { inputTokens: 12, outputTokens: 3 });
  assert.equal(result.response.documents[0].supportsClaim, true);
});

test("control: middle band becomes explicit per-source null, not a false verdict", async () => {
  // SUPERSEDED (source-uncertainty policy): whole-attempt discard is
  // replaced by a COMPLETE record whose middle-band flag is null with
  // the raw probability preserved — uncertainty stays visible and
  // non-coercing.
  const result = await runLeanJevJudgment(input, config, async () =>
    response(payload({ answers: { ...answers, q0r: { type: "noul", noul: 0.5 } } })),
  );
  assert.equal(result.kind, "ok");
  assert.deepEqual(result.response.documents, [
    { evidenceId: "e1", relevant: null, supportsClaim: true, refutesClaim: false },
  ]);
  assert.equal(result.metadata.probabilities.q0r, 0.5);
});
