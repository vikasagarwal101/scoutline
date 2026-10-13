import test from "node:test";
import assert from "node:assert/strict";
import { inputs } from "./unified-review-corpus.mjs";
import { offlineDeps } from "./unified-review-offline-deps.mjs";
const root =
  new URL("..", import.meta.url).pathname;
const { runLeanInvestigation } = await import(`${root}/dist/lib/lean-investigation.js`);
const { runLunaExtraction } = await import(`${root}/dev-dist/lean-candidate-transport.js`);
const single = () => {
  const c = structuredClone(inputs[0]);
  c.contract.requirements = { version: c.contract.requirements.version };
  return c;
};
test("run deadline bounds an in-flight native extractor rather than only blocking next dispatch", async () => {
  const c = single();
  c.contract.limits = { deadlineMs: 10 };
  const base = offlineDeps(c);
  base.deps.now = Date.now;
  let observedSignal;
  let cancelled = false;
  base.deps.extract = async (request, options) => {
    const config = {
      endpoint: "https://fixture.invalid/no-network",
      model: "fixture",
      allowedModels: ["fixture"],
      apiKey: "obviously-fake",
      timeoutMs: options?.timeoutMs ?? request.timeoutMs ?? 1000,
      maxRequestBytes: 65536,
      maxResponseBytes: 65536,
    };
    observedSignal = options?.signal ?? request.signal;
    const result = await runLunaExtraction(request, config, async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return {
        status: 200,
        ok: true,
        headers: { get: () => "application/json" },
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                JSON.stringify({
                  model: "fixture",
                  choices: [
                    {
                      finish_reason: "stop",
                      message: {
                        content: '{"version":{"value":"2.4","quote":"Aster release 2.4."}}',
                      },
                    },
                  ],
                  usage: { prompt_tokens: 1, completion_tokens: 1 },
                }),
              ),
            );
            controller.close();
          },
          cancel() {
            cancelled = true;
          },
        }),
      };
    });
    if (result.kind !== "ok") throw new Error(result.code);
    return { ...result.value, ...result.metadata };
  };
  const start = performance.now();
  const result = await runLeanInvestigation(c.contract, base.deps);
  const elapsed = performance.now() - start;
  assert(
    elapsed < 60,
    `10ms whole-run deadline returned after ${elapsed.toFixed(1)}ms in-flight extraction`,
  );
  assert(
    observedSignal instanceof AbortSignal,
    "no run-owned cancellation signal reaches native dependency",
  );
  assert(observedSignal.aborted);
  assert.deepEqual(result.data, {});
});
test("rejected measured candidate attempt keeps request hash, model and usage in append-only audit", async () => {
  const c = single();
  const { deps, calls } = offlineDeps(c);
  const original = deps.candidateJudge;
  deps.candidateJudge = async (input) => {
    await original(input);
    throw Object.assign(new Error("protocol rejected"), {
      code: "CAND_MODEL",
      observed: {
        requestSha256: "a".repeat(64),
        resolvedModel: "fixture-unallowed",
        usage: { inputTokens: 17, outputTokens: 9 },
        elapsedMs: 3,
        status: 200,
      },
    });
  };
  const result = await runLeanInvestigation(c.contract, deps);
  assert(calls.candidateJudge.length > 0);
  const records = result.requirements.version.attemptedRecords.filter(
    (x) => x.metadata?.kind === "candidate-judgment",
  );
  assert.equal(records.length, calls.candidateJudge.length);
  assert(records.every((x) => x.trusted === false));
  assert(
    records.every(
      (x) =>
        JSON.stringify(x).includes("a".repeat(64)) &&
        JSON.stringify(x).includes("inputTokens") &&
        JSON.stringify(x).includes("17"),
    ),
    "measured rejected attempt observations discarded",
  );
});
test("extraction failure remains an attempted audit row with safely measured observations", async () => {
  const c = single();
  const { deps, calls } = offlineDeps(c);
  const original = deps.extract;
  deps.extract = async (input) => {
    await original(input);
    throw Object.assign(new Error("protocol rejected"), {
      code: "CAND_MODEL",
      observed: {
        requestSha256: "b".repeat(64),
        resolvedModel: "fixture-unallowed",
        usage: { inputTokens: 23, outputTokens: 4 },
        elapsedMs: 2,
        status: 200,
      },
    });
  };
  const result = await runLeanInvestigation(c.contract, deps);
  assert.equal(calls.extract.length, 1);
  const rows = result.requirements.version.attemptedRecords.filter(
    (x) => x.metadata?.kind === "extraction",
  );
  assert.equal(rows.length, 1, "failed extraction disappeared despite a physical attempt");
  assert.equal(rows[0].trusted, false);
  assert(JSON.stringify(rows[0]).includes("b".repeat(64)));
});
