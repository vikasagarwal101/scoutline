import test from "node:test";
import assert from "node:assert/strict";
import { runLeanInvestigation, LEAN_LIMIT_CEILINGS } from "../dist/lib/lean-investigation.js";

// Offline normalized proof inputs, not a production Jev wire protocol.
// The engine is in-memory: every run owns fresh fixtures, with no config/store reads.
const GUIDE = "https://fixture.invalid/guide";
const CONTRARY = "https://fixture.invalid/contrary";
const SHARED = "Assess ExampleApp 2.4.0 exports.";
const question = (id) => `Does ExampleApp 2.4.0 support ${id} export?`;
const hit = (url) => ({ url, title: url });
const verdict = (evidenceId, supportsClaim = true, refutesClaim = false) => ({
  evidenceId, relevant: true, supportsClaim, refutesClaim,
});
const assess = async ({ fieldId, documents }) => ({
  documents: documents.map((doc) => {
    const supportsClaim = doc.content.includes(`supports ${fieldId}`);
    const refutesClaim = doc.content.includes(`refutes ${fieldId}`);
    return { evidenceId: doc.evidenceId, relevant: supportsClaim || refutesClaim,
      supportsClaim, refutesClaim };
  }),
});

function run({ ids = ["csv"], limits = {}, search, read, judge = assess } = {}) {
  return runLeanInvestigation({
    schemaVersion: 1, question: SHARED,
    scope: { entity: "ExampleApp", release: "2.4.0" },
    requirements: Object.fromEntries(ids.map((id) => [id, {
      question: question(id), schema: { enum: ["supported", "refuted", "disputed"] },
      required: true,
    }])),
    evidence: { criteria: ["Check relevant contrary evidence before accepting a result."] },
    limits,
  }, {
    search: search ?? (async (query) => query === SHARED ? [hit(GUIDE)] : []),
    read: read ?? (async () => "ExampleApp 2.4.0 supports csv; supports offline."),
    judge, now: () => 0,
  });
}

function unresolved(result, id = "csv") {
  assert.equal(result.requirements[id].status, "unresolved",
    `${id} accepted as ${result.data[id]} despite unassessed coverage`);
  assert.equal(Object.hasOwn(result.data, id), false);
  assert.notEqual(result.status, "complete");
}

// These malformed normalized responses return invalid-response audit rows;
// an unexpected facade exception must fail the test.
async function rejectsVerdicts(judge, options = {}) {
  const result = await run({ ...options, judge });
  unresolved(result);
  assert.equal(result.requirements.csv.reason, "exhausted");
  assert.deepEqual(result.requirements.csv.attemptedRecords.map((row) => ({
    trusted: row.trusted, reason: row.reason, assessments: row.assessments,
  })), [{ trusted: false, reason: "invalid_response", assessments: [] }]);
}

test("search cap cannot waive required counterevidence", async () => {
  const result = await run({ limits: { maxSearchAttempts: 1 } });
  assert.equal(result.usage.searches, 1);
  unresolved(result);
});

test("later field starvation cannot waive its counterevidence", async () => {
  // Fixture pin (parent-approved): the OLD default ceiling is passed
  // explicitly so the starvation defect this regression guards against
  // stays exercised now that the engine default is plan-aware (7).
  const result = await run({ ids: ["csv", "offline"], limits: { maxSearchAttempts: 4 } });
  assert.ok(result.usage.searches <= 4);
  unresolved(result, "offline");
});

test("failed contrary query is not coverage when another field continues", async () => {
  const result = await run({ ids: ["csv", "offline"], search: async (query) => {
    if (query === SHARED) return [hit(GUIDE)];
    if (query === `${question("csv")} contrary evidence refuted`) throw new Error("fixture search failure");
    return [];
  } });
  assert.ok(result.acquisitionLog.some((event) => event.kind === "search-failed"));
  unresolved(result);
});

test("judge cap cannot finalize a stale answer after contrary content arrives", async () => {
  const result = await run({ limits: { maxJudgeAttempts: 2, readBatchSize: 1 },
    search: async (query) => query === SHARED ? [hit(GUIDE), hit(`${GUIDE}-2`)]
      : query === `${question("csv")} contrary evidence refuted` ? [hit(CONTRARY)] : [],
    read: async (url) => url === CONTRARY ? "refutes csv" : "supports csv",
  });
  assert.ok(result.usage.judgeCalls <= 2);
  unresolved(result);
});

test("read cap leaves unread contrary content unresolved", async () => {
  const result = await run({ limits: { maxUniqueReads: 1 },
    search: async (query) => query === SHARED ? [hit(GUIDE)]
      : query === `${question("csv")} contrary evidence refuted` ? [hit(CONTRARY)] : [],
    read: async (url) => url === GUIDE ? "supports csv" : "refutes csv",
  });
  assert.equal(result.usage.readAttempts, 1);
  unresolved(result);
});

test("single-field failed contrary search stays unresolved", async () => {
  const result = await run({ search: async (query) => {
    if (query === SHARED) return [hit(GUIDE)];
    if (query === `${question("csv")} contrary evidence refuted`) throw new Error("fixture search failure");
    return [];
  } });
  assert.ok(result.acquisitionLog.some((event) => event.kind === "search-failed"));
  unresolved(result);
});

test("support before content cap cannot conceal refutation after it", async () => {
  const content = "supports csv " + "x".repeat(LEAN_LIMIT_CEILINGS.maxEvidenceBytesPerDoc) + " refutes csv";
  const result = await run({ read: async () => content });
  assert.ok(Buffer.byteLength(content) > LEAN_LIMIT_CEILINGS.maxEvidenceBytesPerDoc);
  unresolved(result);
});

test("multibyte retained content respects byte cap", async () => {
  const result = await run({ read: async () => "界".repeat(LEAN_LIMIT_CEILINGS.maxEvidenceBytesPerDoc) });
  for (const doc of result.evidence) {
    assert.ok(Buffer.byteLength(doc.content) <= LEAN_LIMIT_CEILINGS.maxEvidenceBytesPerDoc,
      `retained ${Buffer.byteLength(doc.content)} bytes exceeds ${LEAN_LIMIT_CEILINGS.maxEvidenceBytesPerDoc}`);
  }
  unresolved(result);
});

test("multibyte overflow cannot become accepted coverage", async () => {
  const result = await run({ read: async () => "supports csv " + "界".repeat(LEAN_LIMIT_CEILINGS.maxEvidenceBytesPerDoc) });
  unresolved(result);
});

test("unknown judge evidence ID cannot be cited as accepted evidence", async () => {
  await rejectsVerdicts(async ({ documents }) => ({
    documents: documents.length ? [verdict("never-presented")] : [],
  }));
});

test("duplicate judge evidence IDs cannot fulfill a requirement", async () => {
  await rejectsVerdicts(async ({ documents }) => ({
    documents: documents.length ? [verdict(documents[0].evidenceId), verdict(documents[0].evidenceId)] : [],
  }));
});

test("non-string judge evidence ID cannot fulfill a requirement", async () => {
  await rejectsVerdicts(async ({ documents }) => ({
    documents: documents.length ? [verdict(42)] : [],
  }));
});

test("omitting a presented refutation cannot yield accepted support", async () => {
  await rejectsVerdicts(async ({ documents }) => ({
    documents: documents.filter((doc) => doc.url === GUIDE).map((doc) => verdict(doc.evidenceId)),
  }), {
    search: async (query) => query === SHARED ? [hit(GUIDE), hit(CONTRARY)] : [],
    read: async (url) => url === GUIDE ? "supports csv" : "refutes csv",
  });
});

for (const flag of ["relevant", "supportsClaim", "refutesClaim"]) {
  test(`non-boolean ${flag} cannot fulfill a requirement`, async () => {
    await rejectsVerdicts(async ({ documents }) => ({
      documents: documents.map((doc) => ({
        ...verdict(doc.evidenceId, flag !== "refutesClaim", false), [flag]: "false",
      })),
    }));
  });
}

test("judge null gathers bounded evidence without semantic acceptance", async () => {
  const calls = { search: 0, read: 0 };
  const result = await run({ judge: null, limits: { maxSearchAttempts: 1, maxUniqueReads: 1 },
    search: async () => { calls.search += 1; return [hit(GUIDE), hit(CONTRARY)]; },
    read: async () => { calls.read += 1; return "supports csv"; },
  });
  assert.equal(result.assessment, "deterministic-only");
  assert.equal(result.usage.judgeCalls, 0);
  unresolved(result);
  assert.equal(calls.search, 1, "absent judge must not bypass deterministic search");
  assert.equal(calls.read, 1, "absent judge must retain bounded content");
  assert.equal(result.usage.searches, calls.search);
  assert.equal(result.usage.readAttempts, calls.read);
  assert.equal(result.evidence.length, 1);
  assert.equal(result.evidence[0].content, "supports csv");
});

test("valid complete coverage accepts support after successful contrary search", async () => {
  const queries = [];
  const result = await run({ search: async (query) => {
    queries.push(query);
    return query === SHARED ? [hit(GUIDE)] : [];
  } });
  assert.ok(queries.includes(`${question("csv")} contrary evidence refuted`));
  assert.equal(result.status, "complete");
  assert.equal(result.data.csv, "supported");
  assert.deepEqual(result.requirements.csv.evidenceIds, result.evidence.map((doc) => doc.evidenceId));
});

test("complete same-scope counterevidence can fulfill disputed classification", async () => {
  const result = await run({
    search: async (query) => query === SHARED ? [hit(GUIDE)]
      : query === `${question("csv")} contrary evidence refuted` ? [hit(CONTRARY)] : [],
    read: async (url) => url === GUIDE ? "supports csv" : "refutes csv",
  });
  assert.equal(result.status, "complete");
  assert.equal(result.data.csv, "disputed");
  assert.deepEqual(result.requirements.csv.evidenceIds, result.evidence.map((doc) => doc.evidenceId));
});
