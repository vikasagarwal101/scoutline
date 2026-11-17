import test from "node:test";
import assert from "node:assert/strict";
import { runLeanInvestigation, LEAN_LIMIT_CEILINGS } from "../dist/lib/lean-investigation.js";

// Independent normalized proof fixtures against read-only repaired dist.
const GUIDE = "https://fixture.invalid/guide";
const WRONG_RELEASE = "https://fixture.invalid/wrong-release";
const NEW = "https://fixture.invalid/new";
const SHARED = "Assess ExampleApp 2.4.0 exports.";
const QUESTION = "Does ExampleApp 2.4.0 support csv export?";
const hit = (url) => ({ url });
const verdict = (doc, relevant, supportsClaim, refutesClaim) => ({
  evidenceId: doc.evidenceId, relevant, supportsClaim, refutesClaim,
});

function run(search, judge, limits = {}, read = async (url) =>
  url === WRONG_RELEASE ? "ExampleApp 1.0 refutes csv" : "ExampleApp 2.4.0 supports csv") {
  return runLeanInvestigation({
    schemaVersion: 1, question: SHARED, scope: { entity: "ExampleApp", release: "2.4.0" },
    requirements: { csv: { question: QUESTION, required: true,
      schema: { enum: ["supported", "refuted", "disputed"] } } },
    evidence: { criteria: ["Exact release only; check contrary evidence; seek evidence after inconsistent assessments."] },
    limits,
  }, { now: () => 0, search, judge, read });
}

test("relevance flip on unchanged wrong-release source cannot fabricate dispute", async () => {
  const inputs = [];
  const result = await run(
    async (query) => query === SHARED ? [hit(GUIDE), hit(WRONG_RELEASE)]
      : query === `${QUESTION} contrary evidence refuted` ? [hit(NEW)] : [],
    async ({ documents }) => {
      inputs.push(documents);
      return { documents: documents.map((doc) => verdict(doc,
        doc.url !== WRONG_RELEASE || documents.length === 3,
        doc.url !== WRONG_RELEASE, doc.url === WRONG_RELEASE)) };
    },
  );
  assert.deepEqual(inputs[0][1], inputs[1][1], "flipped source must be unchanged");
  assert.equal(result.requirements.csv.status, "unresolved", "relevance flip fabricated an accepted dispute");
  assert.equal(Object.hasOwn(result.data, "csv"), false);
  assert.ok(result.requirements.csv.inconsistentJudgments > 0);
});

test("successful contrary query reusing retained assessed source can fulfill support", async () => {
  const result = await run(
    async (query) => query === SHARED || query === `${QUESTION} contrary evidence refuted` ? [hit(GUIDE)] : [],
    async ({ documents }) => ({ documents: documents.map((doc) => verdict(doc, true, true, false)) }),
  );
  assert.equal(result.usage.readAttempts, 1, "reuse must not reread an identical source");
  assert.equal(result.status, "complete", "retained assessed source was misreported as missing contrary coverage");
  assert.equal(result.data.csv, "supported");
});

for (const outcome of ["failed", "rejected", "invalidly assessed"]) {
  test(`reused ${outcome} URL cannot count as assessed contrary coverage`, async () => {
    const result = await run(
      async (query) => query === SHARED ? [hit(GUIDE)] : [hit(NEW)],
      async ({ documents }) => ({ documents: documents
        .slice(0, outcome === "invalidly assessed" ? 1 : documents.length)
        .map((doc) => verdict(doc, true, true, false)) }),
      {},
      async (url) => {
        if (url === NEW && outcome === "failed") throw new Error("fixture read unavailable");
        return url === NEW && outcome === "rejected"
          ? "x".repeat(LEAN_LIMIT_CEILINGS.maxEvidenceBytesPerDoc + 1) : "supports csv";
      },
    );
    assert.equal(result.requirements.csv.status, "unresolved");
    assert.equal(Object.hasOwn(result.data, "csv"), false);
    assert.notEqual(result.status, "complete");
    assert.equal(result.usage.readsRetained, outcome === "invalidly assessed" ? 2 : 1);
  });
}

test("stable full verdict tuples allow genuinely new contrary evidence", async () => {
  const result = await run(
    async (query) => query === SHARED ? [hit(GUIDE)]
      : query === `${QUESTION} contrary evidence refuted` ? [hit(NEW)] : [],
    async ({ documents }) => ({ documents: documents.map((doc) =>
      verdict(doc, true, doc.url === GUIDE, doc.url === NEW)) }),
    {}, async (url) => url === GUIDE ? "supports csv" : "refutes csv",
  );
  assert.equal(result.status, "complete");
  assert.equal(result.data.csv, "disputed");
  assert.equal(result.requirements.csv.inconsistentJudgments, 0);
});

test("newly retained contrary source still requires fresh assessment under judge cap", async () => {
  const result = await run(
    async (query) => query === SHARED ? [hit(GUIDE)]
      : query === `${QUESTION} contrary evidence refuted` ? [hit(NEW)] : [],
    async ({ documents }) => ({ documents: documents.map((doc) => verdict(doc, true, true, false)) }),
    { maxJudgeAttempts: 1 },
  );
  assert.equal(result.evidence.length, 2);
  assert.equal(result.usage.judgeCalls, 1);
  assert.equal(result.requirements.csv.status, "unresolved");
  assert.equal(Object.hasOwn(result.data, "csv"), false);
});
