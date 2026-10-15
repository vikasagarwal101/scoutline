import test from "node:test";
import assert from "node:assert/strict";
import { runLeanInvestigation, LEAN_LIMIT_CEILINGS } from "../dist/lib/lean-investigation.js";

// Read-only repaired-engine probe; normalized offline verdicts, not Jev wire format.
const GUIDE = "https://fixture.invalid/guide";
const CONTRARY = "https://fixture.invalid/contrary";
const SHARED = "Assess ExampleApp 2.4.0 exports.";
const QUESTION = "Does ExampleApp 2.4.0 support csv export?";
const verdict = (evidenceId, supportsClaim, refutesClaim) => ({
  evidenceId, relevant: true, supportsClaim, refutesClaim,
});
const assess = async ({ documents }) => ({ documents: documents.map((doc) =>
  verdict(doc.evidenceId, doc.content.includes("supports csv"), doc.content.includes("refutes csv"))) });

function run({ read, judge = assess, search } = {}) {
  return runLeanInvestigation({
    schemaVersion: 1, question: SHARED,
    scope: { entity: "ExampleApp", release: "2.4.0" },
    requirements: { csv: { question: QUESTION,
      schema: { enum: ["supported", "refuted", "disputed"] }, required: true } },
    evidence: { criteria: ["Assess relevant contrary content before acceptance; seek new evidence after inconsistent assessments."] },
  }, {
    now: () => 0,
    search: search ?? (async (query) => query === SHARED ? [{ url: GUIDE }]
      : query === `${QUESTION} contrary evidence refuted` ? [{ url: CONTRARY }] : []),
    read: read ?? (async (url) => url === GUIDE ? "supports csv" : "refutes csv"),
    judge,
  });
}

function notAccepted(result) {
  assert.equal(result.requirements.csv.status, "unresolved",
    `unassessed or inconsistent evidence accepted as ${result.data.csv}`);
  assert.equal(Object.hasOwn(result.data, "csv"), false);
  assert.notEqual(result.status, "complete");
}

test("successful contrary search with two failed reads cannot complete prior support", async () => {
  let failedReads = 0;
  const result = await run({ read: async (url) => {
    if (url === GUIDE) return "supports csv";
    failedReads += 1;
    throw new Error("fixture read unavailable");
  } });
  assert.equal(failedReads, 2);
  assert.ok(result.acquisitionLog.some((event) => event.kind === "read-failed"));
  assert.equal(result.evidence[0].content, "supports csv");
  notAccepted(result);
});

test("discarding oversized contrary content cannot complete prior support", async () => {
  const result = await run({ read: async (url) => url === GUIDE ? "supports csv"
    : "refutes csv " + "x".repeat(LEAN_LIMIT_CEILINGS.maxEvidenceBytesPerDoc) });
  assert.equal(result.evidence.length, 1);
  assert.ok(result.coverageNotes.length > 0);
  notAccepted(result);
});

test("flipping unchanged evidence cannot masquerade as a fresh genuine dispute", async () => {
  const inputs = [];
  const result = await run({ read: async () => "supports csv", judge: async ({ documents }) => {
    inputs.push(documents.map((doc) => ({ ...doc })));
    return { documents: documents.map((doc, index) => verdict(doc.evidenceId,
      documents.length === 1 || index === 1, documents.length === 2 && index === 0)) };
  } });
  assert.equal(inputs.length, 2);
  assert.deepEqual(inputs[0][0], inputs[1][0], "the contradicted representation must be unchanged");
  notAccepted(result);
  assert.ok(result.requirements.csv.inconsistentJudgments > 0,
    "opposite verdicts on unchanged evidence must register inconsistency");
});

test("judge rejection yields unresolved retained evidence or typed failure, not raw crash", async () => {
  let result;
  try {
    result = await run({ judge: async () => { throw new Error("fixture judge unavailable"); } });
  } catch (error) {
    assert.equal(typeof error.code, "string", "judge rejection must be an inspectable typed failure");
    return;
  }
  notAccepted(result);
  assert.ok(result.evidence.some((doc) => doc.content === "supports csv"),
    "usable evidence must survive an unresolved judge outcome");
});

test("valid assessed contrary content can complete a genuine dispute", async () => {
  const result = await run();
  assert.equal(result.status, "complete");
  assert.equal(result.data.csv, "disputed");
  assert.deepEqual(result.requirements.csv.evidenceIds, result.evidence.map((doc) => doc.evidenceId));
});

test("valid non-refuting contrary content can complete support", async () => {
  const result = await run({ read: async () => "supports csv" });
  assert.equal(result.status, "complete");
  assert.equal(result.data.csv, "supported");
  assert.deepEqual(result.requirements.csv.evidenceIds, result.evidence.map((doc) => doc.evidenceId));
});
