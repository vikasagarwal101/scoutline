import test from "node:test";
import assert from "node:assert/strict";
import { inputs } from "./unified-review-corpus.mjs";
import { offlineDeps } from "./unified-review-offline-deps.mjs";
const root =
  new URL("..", import.meta.url).pathname;
const { runLeanInvestigation } = await import(`${root}/dist/lib/lean-investigation.js`);
// Ported off the development transport: the extractor boundary is now a
// production-shaped ExtractorDeps double that honors the run-owned
// cancellation signal the engine hands it (same contract the removed
// transport exercised through nativePost options).
const single = () => {
  const c = structuredClone(inputs[0]);
  c.contract.requirements = { version: c.contract.requirements.version };
  return c;
};
test("run deadline bounds an in-flight native extractor rather than only blocking next dispatch", async (t) => {
  const c = single();
  c.contract.limits = { deadlineMs: 10 };
  const base = offlineDeps(c);
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  base.deps.now = () => Date.now();
  let entered;
  const extracting = new Promise((resolve) => { entered = resolve; });
  let observedSignal;
  let aborts = 0;
  let extractorSettled = false;
  let naturallySettled = false;
  let runSettled = false;
  base.deps.extract = async (_request, options) => {
    observedSignal = options.signal;
    assert(observedSignal instanceof AbortSignal);
    assert.equal(observedSignal.aborted, false);
    const wait = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { naturallySettled = true; resolve(); }, 100);
      observedSignal.addEventListener("abort", () => {
        aborts += 1;
        clearTimeout(timer);
        reject(Object.assign(new Error("aborted"), { code: "TYPESAFE_CANCELLED" }));
      }, { once: true });
    });
    entered();
    try { await wait; } finally { extractorSettled = true; }
    return {
      finishReason: "stop",
      rawOutput: '{"version":{"value":"2.4","quote":"Aster release 2.4."}}',
      usage: { inputTokens: 1, outputTokens: 1 }, observedCost: null,
    };
  };
  const pending = runLeanInvestigation(c.contract, base.deps).then((result) => {
    runSettled = true;
    return result;
  });
  await extracting;
  t.mock.timers.tick(9);
  assert.equal(observedSignal.aborted, false);
  assert.equal(aborts, 0);
  assert.equal(extractorSettled, false);
  assert.equal(runSettled, false);
  t.mock.timers.tick(1);
  assert.equal(observedSignal.aborted, true, "the run-owned deadline aborts the pending extractor");
  assert.equal(aborts, 1);
  const result = await pending;
  assert.equal(extractorSettled, true);
  assert.equal(runSettled, true);
  assert.equal(naturallySettled, false, "abort settles before the dependency's natural wait");
  assert.deepEqual(result.data, {});
  assert.equal(base.calls.candidateJudge.length, 0);
  assert.equal(base.calls.judge.length, 0);
  t.mock.timers.tick(90);
  assert.equal(naturallySettled, false, "the aborted dependency timer was cleared");
  assert.equal(aborts, 1);
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
        usage: { inputTokens: 17, outputTokens: 9, unapprovedFixtureKey: 41 },
        elapsedMs: 3,
        status: 200,
        unapprovedFixtureKey: "EXTRA-FIXTURE-OBSERVATION",
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
  for (const record of records) {
    assert.deepEqual(record.metadata?.observed, {
      requestSha256: "a".repeat(64),
      resolvedModel: "fixture-unallowed",
      usage: { inputTokens: 17, outputTokens: 9 },
      elapsedMs: 3,
      status: 200,
    });
  }
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
        usage: { inputTokens: 23, outputTokens: 4, unapprovedFixtureKey: 41 },
        elapsedMs: 2,
        status: 200,
        unapprovedFixtureKey: "EXTRA-FIXTURE-OBSERVATION",
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
  assert.deepEqual(rows[0].metadata?.observed, {
    requestSha256: "b".repeat(64),
    resolvedModel: "fixture-unallowed",
    usage: { inputTokens: 23, outputTokens: 4 },
    elapsedMs: 2,
    status: 200,
  });
});
