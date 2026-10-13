import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { runLeanJevJudgment } from "../dev-dist/lean-jev-adapter.js";

const ROOT =
  new URL("..", import.meta.url).pathname;
const CONFIG = {
  endpoint: "https://fixture.invalid/native",
  model: "fixture-request",
  apiKey: "fixture-key",
  timeoutMs: 100,
};
const INPUT = {
  fieldId: "csv",
  fieldQuestion: "CSV?",
  criteria: [],
  scope: {},
  candidates: ["supported"],
  documents: [
    { evidenceId: "e1", url: "https://fixture.invalid/doc", title: "Doc", content: "Supports CSV" },
  ],
};
const payload = {
  model: "fixture-resolved",
  usage: { input_tokens: 1, output_tokens: 1 },
  answers: {
    q0r: { type: "noul", noul: 1 },
    q0s: { type: "noul", noul: 1 },
    q0f: { type: "noul", noul: 0 },
  },
};

test("successful header/body races dispose every owned timer", async () => {
  const originalSet = globalThis.setTimeout;
  const originalClear = globalThis.clearTimeout;
  const active = new Set();
  globalThis.setTimeout = (callback, delay, ...args) => {
    let handle;
    handle = originalSet(() => {
      active.delete(handle);
      callback(...args);
    }, delay);
    active.add(handle);
    return handle;
  };
  globalThis.clearTimeout = (handle) => {
    active.delete(handle);
    return originalClear(handle);
  };
  let result;
  let pending;
  try {
    result = await runLeanJevJudgment(
      INPUT,
      CONFIG,
      async () => new Response(JSON.stringify(payload)),
    );
    pending = active.size;
  } finally {
    for (const handle of active) originalClear(handle);
    globalThis.setTimeout = originalSet;
    globalThis.clearTimeout = originalClear;
  }
  assert.equal(result.kind, "ok");
  assert.equal(pending, 0, "settled races must not leave timeout handles keeping process alive");
});

test("late header response after timeout disposes its unread body", async () => {
  let cancelled = false;
  const result = await runLeanJevJudgment(INPUT, { ...CONFIG, timeoutMs: 5 }, async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
    return {
      status: 200,
      ok: true,
      headers: new Headers(),
      body: new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
    };
  });
  assert.equal(result.code, "JEV_DEV_TIMEOUT");
  await new Promise((resolve) => setTimeout(resolve, 45));
  assert.equal(cancelled, true, "losing fetch promise may resolve later but cannot leak a body");
});

// Unchanged runner linked to synthetic clock/adapter/engine, no network.
async function runClockedRunner(startNearDeadline) {
  let now = 0;
  const timeouts = [];
  const reservations = [];
  const logs = [];
  let constructed = 0;
  const context = vm.createContext({
    Date: { now: () => now },
    console: { log: (value) => logs.push(value), error: () => {} },
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
  const adapter = new vm.SyntheticModule(
    ["createLeanJevJudge"],
    function () {
      this.setExport("createLeanJevJudge", (config, _fetch, hooks) => {
        constructed++;
        return async () => {
          timeouts.push(config.timeoutMs);
          reservations.push(now);
          hooks.onAttempt({
            kind: "ok",
            metadata: {
              probabilities: {},
              usage: { inputTokens: 1, outputTokens: 1 },
              resolvedModel: "fixture-resolved",
              requestedModel: CONFIG.model,
              attemptSha256: "a".repeat(64),
              thresholdRevision: "fixture",
              status: 200,
              elapsedMs: 0,
            },
          });
          now = 179_995;
          return { documents: [] };
        };
      });
    },
    { context },
  );
  const engine = new vm.SyntheticModule(
    ["runLeanInvestigation"],
    function () {
      this.setExport("runLeanInvestigation", async (_contract, deps) => {
        if (deps.judge && timeouts.length === 0) {
          if (startNearDeadline) now = 179_990;
          await deps.judge(INPUT);
          await deps.judge(INPUT);
        }
        return {
          status: "empty",
          data: {},
          requirements: { csv: { status: "unresolved" } },
          assessment: "semantic",
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
  return { timeouts, reservations, constructed, report: JSON.parse(logs[0]) };
}

test("runner recalculates attempt deadline for every dispatch in same case", async () => {
  const { timeouts, reservations } = await runClockedRunner(false);
  assert.deepEqual(reservations, [0, 179_995]);
  assert.deepEqual(
    timeouts,
    [15_000, 5],
    "cached judge must not carry first dispatch timeout past outer deadline",
  );
});

test("control: first dispatch already near outer bound uses remaining time", async () => {
  const { timeouts, reservations, report } = await runClockedRunner(true);
  assert.equal(reservations[0], 179_990);
  assert.equal(timeouts[0], 10);
  assert.equal(report.caps.attemptsUsed, 2);
});

test("control: ordinary finite successful native response is accepted", async () => {
  const result = await runLeanJevJudgment(
    INPUT,
    { ...CONFIG, timeoutMs: 5 },
    async () => new Response(JSON.stringify(payload)),
  );
  assert.equal(result.kind, "ok");
  assert.deepEqual(result.metadata.usage, { inputTokens: 1, outputTokens: 1 });
});
