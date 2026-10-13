import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { inputs } from "../unified-review-corpus.mjs";
import { offlineDeps } from "../unified-review-offline-deps.mjs";
const root =
  new URL("../..", import.meta.url).pathname;
const { runLeanInvestigation } = await import(`${root}/dist/lib/lean-investigation.js`);
// HISTORICAL RECOVERY GATE — NOT part of the ordinary test selector.
// Replays the frozen sanitized evaluation04 runtime report
// (expected raw SHA-256 b7d8cfae1c6dd3596d7bfbef473e8d0eec086cfff16eae6354f9aeea054db763).
// No copy is currently authorized/recoverable; this gate MUST FAIL clearly
// (EVAL_REPORT_MISSING / EVAL_REPORT_HASH_MISMATCH) until the exact
// original is provided. No fallback, skip or synthesized response.
const EXPECTED_RAW_SHA256 =
  "b7d8cfae1c6dd3596d7bfbef473e8d0eec086cfff16eae6354f9aeea054db763";
function loadHistoricalReport() {
  const candidate = [
    process.env.EVAL04_REPORT_PATH,
    new URL("./fixtures/evaluation-04/result.json", import.meta.url).pathname,
  ].find((p) => p && existsSync(p));
  if (!candidate)
    throw Object.assign(
      Error(
        `EVAL_REPORT_MISSING: sanitized evaluation04 result.json not provided. ` +
          `Set EVAL04_REPORT_PATH to the authorized sanitized original ` +
          `(raw SHA-256 ${EXPECTED_RAW_SHA256}) or place it at ` +
          `tests/historical-replay/fixtures/evaluation-04/result.json. ` +
          `Historical replay cannot run without the exact recorded evidence.`,
      ),
      { code: "EVAL_REPORT_MISSING" },
    );
  const raw = readFileSync(candidate, "utf8");
  const actual = createHash("sha256").update(raw).digest("hex");
  if (actual !== EXPECTED_RAW_SHA256)
    throw Object.assign(
      Error(
        `EVAL_REPORT_HASH_MISMATCH: ${candidate} hashes ${actual}, ` +
          `expected original ${EXPECTED_RAW_SHA256}. Refusing to replay ` +
          `from altered evidence.`,
      ),
      { code: "EVAL_REPORT_HASH_MISMATCH" },
    );
  return JSON.parse(raw);
}
const report = loadHistoricalReport();
function replay(caseId) {
  const c = structuredClone(inputs.find((x) => x.id === caseId)),
    original = report.results.find((x) => x.id === caseId),
    base = offlineDeps(c);
  const pools = Object.fromEntries(
    ["extraction", "candidate", "classification"].map((stage) => [
      stage,
      report.attempts.filter((x) => x.caseId === caseId && x.stage === stage),
    ]),
  );
  const cursor = { extraction: 0, candidate: 0, classification: 0 };
  const take = (stage) => {
    const a = pools[stage][cursor[stage]++];
    if (!a)
      throw Object.assign(Error("Frozen replay has no additional authorized response"), {
        code: "REPLAY_EXHAUSTED",
      });
    return a;
  };
  const deps = {
    now: () => 0,
    search: base.deps.search,
    read: base.deps.read,
    extractorRevision: "frozen-eval04-replay-v1",
    extract: async (input) => {
      const a = take("extraction"),
        s = JSON.parse(a.request.messages.find((m) => m.role === "user").content);
      assert.equal(input.sourceText, s.source);
      assert.deepEqual(
        input.fields.map((x) => x.id),
        s.fields.map((x) => x.id),
      );
      assert.deepEqual(input.depBindings, s.depBindings);
      return {
        ...a.native.value,
        usage: a.native.metadata.usage,
        observedCost: null,
        elapsedMs: a.native.metadata.elapsedMs,
        requestSha256: a.requestSha256,
      };
    },
    candidateJudge: async (input) => {
      const a = take("candidate"),
        s = a.request.state;
      assert.equal(input.source.content, s.source.text);
      assert.deepEqual(
        input.opposingContext.map((x) => x.content),
        s.opposingContext.map((x) => x.text),
      );
      assert.deepEqual(input.depBindings, s.depBindings);
      assert.deepEqual(
        input.candidates.map((x) => [x.fieldId, x.value, x.quote, x.charRange]),
        s.fields.map((x) => [x.fieldId, x.value, x.quote, x.charRange]),
      );
      return {
        model: "frozen-sanitized-replay",
        answers: a.rawResponse.answers,
        usage: a.native.metadata.usage,
        requestSha256: a.requestSha256,
        elapsedMs: a.native.metadata.elapsedMs,
      };
    },
    judge: async (input) => {
      const a = take("classification"),
        s = a.request.state;
      assert.equal(input.fieldQuestion, s.requirement);
      assert.deepEqual(
        input.documents.map((x) => x.content),
        s.sources.map((x) => x.text),
      );
      const flag = (p) => (p >= 0.9 ? true : p <= 0.1 ? false : null);
      return {
        documents: input.documents.map((d, i) => ({
          evidenceId: d.evidenceId,
          relevant: flag(a.rawResponse.answers[`q${i}r`].noul),
          supportsClaim: flag(a.rawResponse.answers[`q${i}s`].noul),
          refutesClaim: flag(a.rawResponse.answers[`q${i}f`].noul),
        })),
      };
    },
  };
  return { c, deps, cursor, original };
}
test("frozen Birch final-context accepted guide license survives later unknown review candidate and cache iteration", async () => {
  const { c, deps } = replay("birch-progressive");
  const result = await runLeanInvestigation(c.contract, deps);
  assert.equal(result.data.version, "5.1");
  assert.equal(result.data.csv, "supported");
  assert.equal(
    result.data.license,
    "Apache-2.0",
    "trusted guide .96/.02 on the same final context must not disappear",
  );
  assert.equal(result.requirements.license.provenance.sourceId, "e2");
});
test("frozen Dune final-context accepted guide version survives later unknown source candidates", async () => {
  const { c, deps } = replay("dune-late-adverse");
  const result = await runLeanInvestigation(c.contract, deps);
  assert.equal(
    result.data.version,
    "2.0",
    "trusted final-context guide .91/.05 must not disappear",
  );
  assert.equal(result.requirements.version.provenance.sourceId, "e1");
  assert(!("license" in result.data), "replay must not invent acceptance for conflicting license");
});
test("frozen Cedar failed returned contrary read ends explicit coverage reason rather than internal stop", async () => {
  const { c, deps } = replay("cedar-challenge-failed");
  const result = await runLeanInvestigation(c.contract, deps);
  assert.deepEqual(result.data, {});
  assert.equal(result.requirements.version.reason, "counterevidence_not_acquired");
});
test("material conflict in final context cannot retain an older accepted guide candidate", async () => {
  const { c, deps } = replay("birch-progressive");
  const judge = deps.candidateJudge;
  deps.candidateJudge = async (input) => {
    const response = await judge(input);
    if (input.candidates.some((x) => x.fieldId === "license") && input.source.evidenceId === "e2") {
      response.answers = { ...response.answers, q0c: { type: "noul", noul: 0.97 } };
    }
    return response;
  };
  const result = await runLeanInvestigation(c.contract, deps);
  assert(
    !("license" in result.data),
    "clear final-context conflict must not reuse support from a smaller context",
  );
  assert.equal(result.data.version, "5.1");
});
test("unfulfilled prerequisite and contrary coverage keep dependent accepted data absent", async () => {
  const { c, deps } = replay("cedar-challenge-failed");
  const result = await runLeanInvestigation(c.contract, deps);
  assert.equal(result.requirements.version.status, "unresolved");
  assert.equal(result.requirements.license.status, "unresolved");
  assert(!("license" in result.data));
  assert.equal(result.status, "partial");
});
test("predispatch physical extraction cap is recorded as cap rather than network failure or elapsed deadline", async () => {
  const c = structuredClone(inputs[0]);
  c.contract.requirements = { version: c.contract.requirements.version };
  // Witness-first supersession (parent-authorized setup-only change): the
  // canonical single-version shape is deferral-eligible, so the pilot
  // would rightly avoid the second extraction this cap fixture throws
  // on. Adding the explicit nonqualifying multi-witness criterion keeps
  // the original purpose — cap attribution before dispatch — on the
  // exhaustive fallback path. All original assertions unchanged.
  c.contract.requirements.version.criteria.push(
    "Require two independently extracted source witnesses before this field is fulfilled.",
  );
  const { deps } = offlineDeps(c);
  let physical = 0;
  const original = deps.extract;
  deps.extract = async (input) => {
    if (physical === 1)
      throw Object.assign(Error("physical extraction cap reserved before dispatch"), {
        code: "EVAL_STOPPED",
        reason: "global_extraction_cap",
      });
    physical++;
    return original(input);
  };
  const result = await runLeanInvestigation(c.contract, deps);
  assert.equal(physical, 1);
  assert(!("version" in result.data));
  assert.equal(result.requirements.version.reason, "global_extraction_cap");
});
