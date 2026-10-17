import test from "node:test";
import assert from "node:assert/strict";
import { runLeanInvestigation, LEAN_LIMIT_CEILINGS } from "../dist/lib/lean-investigation.js";
import { buildCandidateJudgeRequest, candidateIdentity, candidateSourceDigest } from "../dist/lib/lean-candidates.js";

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

async function repeatedQuestionRun({ failures = 0, searchCap = 7, readCap = 3,
  opposition = false, sharedQuestion = "Shared", deterministicOnly = false } = {}) {
  const queries = [], reads = [], judgments = [];
  let contraryAttempts = 0;
  let checkpoint;
  const result = await runLeanInvestigation({
    schemaVersion: 1, question: sharedQuestion,
    requirements: Object.fromEntries(["alpha", "beta"].map((id) => [id, {
      question: "CSV?", schema: { enum: ["supported", "refuted", "disputed"] },
    }])),
    limits: { maxSearchAttempts: searchCap, maxUniqueReads: readCap, readBatchSize: 2 },
  }, {
    now: () => 0,
    seed: { identity: "repeated-question-fixture-v1", capture: (state) => { checkpoint = state; } },
    search: async (query) => {
      queries.push(query);
      if (query.endsWith(" contrary evidence refuted")) {
        contraryAttempts += 1;
        if (contraryAttempts <= failures) throw new Error("fixture contrary failure");
        return opposition ? [hit(CONTRARY)] : query === sharedQuestion ? [hit(GUIDE)] : [];
      }
      return query === sharedQuestion ? [hit(GUIDE)] : [];
    },
    read: async (url) => { reads.push(url); return url === CONTRARY ? "refutes CSV" : "supports CSV"; },
    judge: deterministicOnly ? null : async (input) => {
      judgments.push(structuredClone(input));
      return { documents: input.documents.map((doc) => ({
        evidenceId: doc.evidenceId, relevant: true,
        supportsClaim: doc.content.includes("supports CSV"),
        refutesClaim: doc.content.includes("refutes CSV"),
      })) };
    },
  });
  const coverage = Object.fromEntries(checkpoint.history.map(({ state }) =>
    [state.id, { issued: state.ctrvIssued, pendingUrls: state.ctrvSources }]));
  assert.equal(result.usage.searches, queries.length);
  assert.equal(result.usage.readAttempts, reads.length);
  assert.equal(result.usage.judgeCalls, judgments.length);
  return { result, queries, reads, judgments, coverage };
}

test("one successful duplicate query covers both fields without phantom future acquisition", async () => {
  const { result, queries, coverage } = await repeatedQuestionRun();
  assert.deepEqual(result.data, { alpha: "supported", beta: "supported" });
  assert.deepEqual(queries, ["Shared", "CSV?", "CSV? contrary evidence refuted"]);
  assert.deepEqual(coverage, { alpha: { issued: true, pendingUrls: [] }, beta: { issued: true, pendingUrls: [] } });
});

for (const [name, options, paid, accepted] of [
  ["later genuine success covers an earlier failed owner", { failures: 1 }, 4, true],
  ["failed queries never become coverage", { failures: 2 }, 4, false],
  ["cap before contrary search never becomes coverage", { searchCap: 2 }, 2, false],
  ["success at the physical search cap covers both owners", { searchCap: 3 }, 3, true],
  ["shared primary text reuses its paid request", { sharedQuestion: "CSV?" }, 2, true],
  ["shared contrary text covers every matching owner", { sharedQuestion: "CSV? contrary evidence refuted" }, 2, true],
]) {
  test(`duplicate-query coverage: ${name}`, async () => {
    const { result, queries, coverage } = await repeatedQuestionRun(options);
    assert.equal(queries.length, paid);
    assert.deepEqual(result.data, accepted ? { alpha: "supported", beta: "supported" } : {});
    for (const field of ["alpha", "beta"]) {
      assert.equal(coverage[field].issued, accepted);
      if (!accepted) assert.equal(result.requirements[field].reason, "counterevidence_not_acquired");
    }
  });
}
test("duplicate-query contrary URLs are retained and assessed by both fields", async () => {
  const { result, reads, judgments, coverage } = await repeatedQuestionRun({ opposition: true });
  assert.deepEqual(reads, [GUIDE, CONTRARY]);
  assert.deepEqual(result.data, { alpha: "disputed", beta: "disputed" });
  for (const field of ["alpha", "beta"]) {
    assert(judgments.some((input) => input.fieldId === field && input.documents.some((doc) => doc.url === CONTRARY)));
    assert.deepEqual(coverage[field], { issued: true, pendingUrls: [] });
  }
});
test("duplicate-query unread contrary URLs block both owners under the read cap", async () => {
  const { result, reads, coverage } = await repeatedQuestionRun({ opposition: true, readCap: 1 });
  assert.deepEqual(reads, [GUIDE]);
  assert.deepEqual(result.data, {});
  for (const field of ["alpha", "beta"])
    assert.deepEqual(coverage[field], { issued: true, pendingUrls: [CONTRARY] });
});
test("deterministic-only duplicate-query coverage persists for every owner", async () => {
  const { queries, judgments, coverage } = await repeatedQuestionRun({ deterministicOnly: true });
  assert.equal(queries.length, 3);
  assert.equal(judgments.length, 0);
  assert.deepEqual(coverage, { alpha: { issued: true, pendingUrls: [] }, beta: { issued: true, pendingUrls: [] } });
});
test("deterministic-only retention settles shared contrary URLs for every owner", async () => {
  const { reads, judgments, coverage } = await repeatedQuestionRun({ deterministicOnly: true, opposition: true });
  assert.deepEqual(reads, [GUIDE, CONTRARY]);
  assert.equal(judgments.length, 0);
  assert.deepEqual(coverage, { alpha: { issued: true, pendingUrls: [] }, beta: { issued: true, pendingUrls: [] } });
});

async function rawAcquisitionRun({ phase = "read", deterministicOnly = false,
  error = Object.assign(new Error("fixture stop"), { code: "EVAL_STOPPED", reason: "global_deadline" }) } = {}) {
  const events = [];
  let stopIndex = -1;
  const record = (kind, options, detail) => {
    events.push({ kind, detail, aborted: options.signal.aborted });
    if (kind === phase && stopIndex === -1) {
      stopIndex = events.length - 1;
      throw error;
    }
  };
  const result = await runLeanInvestigation({
    schemaVersion: 1, question: "Shared",
    requirements: {
      csv: { question: "CSV?", schema: { enum: ["supported", "refuted", "disputed"] } },
      version: { question: "Version?", schema: { type: "string" } },
    },
    limits: { readBatchSize: 2, maxUniqueReads: 2, maxSearchAttempts: 5, deadlineMs: 1000 },
  }, {
    now: () => 0,
    search: async (query, options) => {
      record("search", options, query);
      return query.endsWith(" contrary evidence refuted") ? [] : [hit(GUIDE), hit(CONTRARY)];
    },
    read: async (url, options) => { record("read", options, url); return "Release 1.0 supports CSV."; },
    judge: deterministicOnly ? null : async (input, options) => {
      record("judge", options, input.fieldId);
      return { documents: input.documents.map((doc) => verdict(doc.evidenceId)) };
    },
    extract: async (input, options) => {
      record("extract", options, input.sourceId);
      return { finishReason: "stop", rawOutput: JSON.stringify({
        version: { value: "1.0", quote: input.sourceText },
      }), usage: { inputTokens: 1, outputTokens: 1 }, observedCost: null };
    },
    candidateJudge: async (_input, options) => {
      record("candidate", options, "version");
      return { model: "fixture", answers: { q0s: { type: "noul", noul: 0.97 }, q0c: { type: "noul", noul: 0.01 } },
        usage: { inputTokens: 1, outputTokens: 1 }, elapsedMs: 1, requestSha256: "a".repeat(64) };
    },
  });
  assert.notEqual(stopIndex, -1);
  for (const [counter, kind] of [["searches", "search"], ["readAttempts", "read"],
    ["judgeCalls", "judge"], ["extractorCalls", "extract"], ["candidateJudgeCalls", "candidate"]])
    assert.equal(result.usage[counter], events.filter((event) => event.kind === kind).length);
  return { result, events, stopIndex };
}

test("qualified raw read stop prevents retry, second batch item and later collaborators", async () => {
  const { result, events, stopIndex } = await rawAcquisitionRun();
  assert.deepEqual(events.slice(stopIndex + 1), [], "a qualified root forbids every later physical call");
  assert.deepEqual(result.data, {});
  for (const row of Object.values(result.requirements)) assert.equal(row.reason, "global_deadline");
});

for (const root of ["global_deadline", "global_extraction_cap", "global_judgment_cap"])
  for (const phase of ["read", "search"])
    for (const deterministicOnly of [false, true]) {
      if (root === "global_deadline" && phase === "read" && !deterministicOnly) continue;
      test(`qualified raw ${phase} stop ${root}, deterministic-only=${deterministicOnly}`, async () => {
        const error = Object.assign(new Error("fixture stop"), { code: "EVAL_STOPPED", reason: root });
        const { result, events, stopIndex } = await rawAcquisitionRun({ phase, deterministicOnly, error });
        assert.equal(events[stopIndex].aborted, false, "the local clock/signal did not stop this call");
        assert.deepEqual(events.slice(stopIndex + 1), []);
        assert.deepEqual(result.data, {});
        for (const row of Object.values(result.requirements)) assert.equal(row.reason, root);
      });
    }
for (const [name, makeError] of [
  ["ordinary", () => new Error("fixture ordinary failure")],
  ["wrong code", () => Object.assign(new Error("fixture wrong code"), { code: "BENIGN_WRONG_CODE", reason: "global_deadline" })],
  ["unknown root", () => Object.assign(new Error("fixture unknown root"), { code: "EVAL_STOPPED", reason: "not_a_declared_root" })],
  ["non-Error carrier", () => ({ code: "EVAL_STOPPED", reason: "global_deadline" })],
  ["normalized-only carrier", () => Object.assign(new Error("fixture alternate carrier"), { code: "EVAL_STOPPED", stopReason: "global_deadline" })],
])
  for (const phase of ["read", "search"])
    for (const deterministicOnly of [false, true]) {
      test(`unqualified raw ${phase} ${name}, deterministic-only=${deterministicOnly}`, async () => {
        const { result, events, stopIndex } = await rawAcquisitionRun({ phase, deterministicOnly, error: makeError() });
        assert(events.slice(stopIndex + 1).length > 0, "ordinary acquisition recovery stays available");
        assert(events.every((event) => !event.aborted));
        if (phase === "read")
          assert.deepEqual(events.filter((event) => event.kind === "read").map((event) => event.detail), [GUIDE, GUIDE, CONTRARY]);
        if (deterministicOnly)
          for (const row of Object.values(result.requirements)) assert.equal(row.reason, "no_semantic_judge");
        else assert.deepEqual(result.data, { csv: "supported", version: "1.0" });
      });
    }

const measuredFailure = {
  requestSha256: "a".repeat(64), resolvedModel: "fixture", requestedModel: "requested-fixture",
  usage: { inputTokens: 7, outputTokens: 3, reasoningTokens: 2, extra: "BENIGN_NESTED_EXTRA" },
  elapsedMs: 2.5, status: 503, headers: { fixture: "BENIGN_RAW_HEADER" },
  endpoint: "https://synthetic.invalid/not-sent", raw: "BENIGN_RAW_BODY",
};
const safeFailure = {
  requestSha256: "a".repeat(64), resolvedModel: "fixture", requestedModel: "requested-fixture",
  usage: { inputTokens: 7, outputTokens: 3, reasoningTokens: 2 }, elapsedMs: 2.5, status: 503,
};
async function classificationAttemptRun({ mode = "ordinary", recover = false,
  preflightFailure = false, observations = true } = {}) {
  let calls = 0;
  const code = mode === "indeterminate" ? "JEV_DEV_INDETERMINATE"
    : mode === "stop" ? "EVAL_STOPPED" : mode === "normalized-carrier" ? "BENIGN_WRONG_CODE" : "FIXTURE_NETWORK";
  const error = Object.assign(new Error("BENIGN_RAW_ERROR_MESSAGE"), {
    code, observed: observations ? structuredClone(measuredFailure) : undefined,
    ...(["stop", "normalized-carrier"].includes(mode) ? { reason: "global_judgment_cap" } : {}),
  });
  const result = await runLeanInvestigation({
    schemaVersion: 1, question: "Shared",
    requirements: { csv: { question: "CSV?", schema: { enum: ["supported", "refuted", "disputed"] } } },
    limits: { readBatchSize: 1, maxSearchAttempts: 3 },
  }, {
    now: () => 0,
    seed: preflightFailure ? { retainEvidence: async (record) => {
      // A public retention collaborator fails while its record is copied
      // into the request, before any judge invocation. Restore the getter
      // immediately so the returned evidence remains ordinary data.
      const title = record.title;
      Object.defineProperty(record, "title", { configurable: true, enumerable: true, get() {
        Object.defineProperty(record, "title", { value: title, writable: true, configurable: true, enumerable: true });
        throw error;
      } });
    } } : undefined,
    search: async (query) => query === "Shared" ? [hit(GUIDE)] : recover && query === "CSV?" ? [hit(CONTRARY)] : [],
    read: async () => "supports CSV",
    judge: async (input) => {
      calls += 1;
      if (mode !== "success" && mode !== "invalid" && !(recover && calls > 1)) throw error;
      return { documents: mode === "invalid" ? [] : input.documents.map((doc) => verdict(doc.evidenceId)) };
    },
  });
  assert.equal(result.usage.judgeCalls, calls);
  assert.equal(result.requirements.csv.judgmentCount, calls);
  assert(!JSON.stringify(result).includes("BENIGN_RAW"));
  assert(!JSON.stringify(result).includes("BENIGN_NESTED_EXTRA"));
  assert(!JSON.stringify(result).includes("synthetic.invalid"));
  return { result, calls, code };
}
test("ordinary paid classification rejection keeps one sanitized attempt record", async () => {
  const { result, calls } = await classificationAttemptRun();
  assert.equal(calls, 1);
  assert.equal(result.requirements.csv.reason, "judge_unavailable");
  assert.deepEqual(result.requirements.csv.attemptedRecords, [{
    trusted: false, reason: "enum_judge_failed:FIXTURE_NETWORK", assessments: [],
    metadata: { kind: "classification-judgment", observed: safeFailure },
  }]);
});

for (const [mode, reason] of [["indeterminate", "judge_indeterminate"],
  ["stop", "global_judgment_cap"], ["normalized-carrier", "global_judgment_cap"]]) {
  test(`failed enum audit preserves existing ${mode} disposition with exactly one row`, async () => {
    const { result, calls, code } = await classificationAttemptRun({ mode });
    assert.equal(calls, 1);
    assert.equal(result.requirements.csv.reason, reason);
    assert.deepEqual(result.requirements.csv.attemptedRecords, [{
      trusted: false, reason: `enum_judge_failed:${code}`, assessments: [],
      metadata: { kind: "classification-judgment", observed: safeFailure },
    }]);
  });
}
test("indeterminate enum audit does not disable assessment on new retained context", async () => {
  const { result, calls } = await classificationAttemptRun({ mode: "indeterminate", recover: true });
  assert.equal(calls, 2);
  assert.equal(result.data.csv, "supported");
  const rows = result.requirements.csv.attemptedRecords;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].reason, "enum_judge_failed:JEV_DEV_INDETERMINATE");
  assert.equal(rows[0].trusted, false);
  assert.equal(rows[1].trusted, true);
  assert.equal(rows[1].assessments.length, 2);
});
for (const mode of ["success", "invalid"]) {
  test(`enum ${mode} response keeps its single existing audit row`, async () => {
    const { result, calls } = await classificationAttemptRun({ mode });
    assert.equal(calls, 1);
    const rows = result.requirements.csv.attemptedRecords;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].trusted, mode === "success");
    assert.equal(rows[0].reason, mode === "success" ? undefined : "invalid_response");
  });
}
test("uninvoked enum preflight failure fabricates neither a paid call nor rejection row", async () => {
  const { result, calls } = await classificationAttemptRun({ preflightFailure: true });
  assert.equal(calls, 0);
  assert.deepEqual(result.requirements.csv.attemptedRecords, []);
  assert.deepEqual(result.data, {});
});
test("failed enum audit leaves unmeasured observations absent rather than inventing zeros", async () => {
  const { result } = await classificationAttemptRun({ observations: false });
  assert.deepEqual(result.requirements.csv.attemptedRecords[0].metadata, { kind: "classification-judgment" });
});


const ROUND_LEAD_A = "https://fixture.invalid/round-seed-a";
const ROUND_LEAD_B = "https://fixture.invalid/round-seed-b";
const ROUND_LEAD_C = "https://fixture.invalid/round-new-c";
const ROUND_SHARED = "Assess QueueFixture 1.0 CSV exports.";
const ROUND_QUESTION = "Does QueueFixture 1.0 support csv export?";
async function runSeedLeadRound({ semantic, seedInput = {}, first = false,
  retain = false, maxReads = 1, maxSearches = 3 }) {
  const calls = { search: [], read: [] };
  let checkpoint;
  const input = structuredClone(seedInput);
  const before = structuredClone(input);
  const result = await runLeanInvestigation({
    schemaVersion: 1, question: ROUND_SHARED,
    scope: { entity: "QueueFixture", release: "1.0" },
    requirements: { csv: { question: ROUND_QUESTION,
      schema: { enum: ["supported", "refuted", "disputed"] }, required: true } },
    evidence: { criteria: ["Assess relevant contrary evidence before accepting."] },
    limits: { maxUniqueReads: maxReads, maxSearchAttempts: maxSearches },
  }, {
    now: () => 0,
    seed: { ...input, capture: (state) => { checkpoint = state; } },
    search: async (query) => {
      calls.search.push(query);
      return first ? [{ url: ROUND_LEAD_A, title: "original seed A" },
        { url: ROUND_LEAD_B, title: "original seed B" }]
        : [{ url: ROUND_LEAD_A, title: "later search A" }, { url: ROUND_LEAD_C, title: "new C" }];
    },
    read: async (url) => {
      calls.read.push(url);
      if (!retain) throw new Error("ordinary fixture read unavailable");
      return "QueueFixture 1.0 supports csv export.";
    },
    judge: semantic ? async ({ documents }) => ({
      documents: documents.map((doc) => ({ evidenceId: doc.evidenceId,
        relevant: true, supportsClaim: true, refutesClaim: false })),
    }) : null,
  });
  assert.deepEqual(input, before, "continuation inputs remain caller-owned");
  return { result, calls, checkpoint };
}
async function assertUniqueSeedContinuation(semantic, reuseIssued) {
  const first = await runSeedLeadRound({ semantic, first: true, maxSearches: 1 });
  assert.deepEqual(first.checkpoint.leads.map((lead) => lead.url), [ROUND_LEAD_A, ROUND_LEAD_B]);
  const second = await runSeedLeadRound({ semantic, seedInput: {
    evidence: first.result.evidence, leads: first.checkpoint.leads,
    issuedQueries: reuseIssued ? first.checkpoint.issuedQueries : [],
  } });
  assert.deepEqual(second.checkpoint.leads.map((lead) => lead.url),
    [ROUND_LEAD_A, ROUND_LEAD_B, ROUND_LEAD_C], "search must not duplicate a pending seeded URL");
  assert.deepEqual(second.checkpoint.leads.map((lead) => lead.title),
    ["original seed A", "original seed B", "new C"]);
  assert.deepEqual(second.calls.read, [ROUND_LEAD_A, ROUND_LEAD_A]);
  assert.equal(second.result.usage.readAttempts, 2, "both ordinary physical attempts are counted");
  assert.equal(second.result.usage.readsRetained, 0);
  assert.equal(second.calls.search.length, reuseIssued ? 2 : 3);
  assert.equal(second.result.usage.searches, second.calls.search.length);
  for (const url of [ROUND_LEAD_A, ROUND_LEAD_C]) {
    assert.deepEqual(second.checkpoint.leads.find((lead) => lead.url === url).origins,
      [...new Set([
        ...(first.checkpoint.leads.find((lead) => lead.url === url)?.origins ?? []),
        ...second.calls.search,
      ])], "deduplication must preserve every successful query origin");
  }
  assert.deepEqual(second.result.data, {});
  assert.equal(second.result.requirements.csv.status, "unresolved");
  assert.deepEqual(second.checkpoint.issuedQueries,
    [ROUND_SHARED, ROUND_QUESTION, `${ROUND_QUESTION} contrary evidence refuted`]);
  const third = await runSeedLeadRound({ semantic, retain: true, maxReads: 3, seedInput: {
    evidence: second.result.evidence, leads: second.checkpoint.leads,
    issuedQueries: second.checkpoint.issuedQueries,
  } });
  assert.deepEqual(third.calls.read, [ROUND_LEAD_A, ROUND_LEAD_B, ROUND_LEAD_C]);
  assert.equal(third.result.usage.readAttempts, 3);
  assert.equal(third.result.usage.readsRetained, 3);
  assert.deepEqual(third.calls.search, []);
  assert.deepEqual(third.checkpoint.leads, []);
  assert.deepEqual(third.result.evidence.map((doc) => doc.title),
    ["original seed A", "original seed B", "new C"]);
}
test("seeded pending leads stay unique in semantic continuation", async () => {
  await assertUniqueSeedContinuation(true, true);
});

test("seeded pending leads stay unique in deterministic-only continuation", async () => {
  await assertUniqueSeedContinuation(false, true);
});

for (const semantic of [true, false]) {
  test(`new-basis pending seed leads preserve query origins (${semantic ? "semantic" : "deterministic-only"})`, async () => {
    await assertUniqueSeedContinuation(semantic, false);
  });
  test(`retained seed search results do not trigger another paid read (${semantic ? "semantic" : "deterministic-only"})`, async () => {
    const first = await runSeedLeadRound({ semantic, first: true, retain: true, maxSearches: 1 });
    assert.deepEqual(first.result.evidence.map((doc) => doc.url), [ROUND_LEAD_A]);
    assert.deepEqual(first.checkpoint.leads.map((lead) => lead.url), [ROUND_LEAD_B]);
    const firstSnapshot = structuredClone(first.result);
    freezeProvenanceInput(first.result);
    const second = await runSeedLeadRound({ semantic, retain: true, maxReads: 3, seedInput: {
      evidence: first.result.evidence, leads: first.checkpoint.leads,
      issuedQueries: first.checkpoint.issuedQueries,
    } });
    assert.deepEqual(second.calls.read, [ROUND_LEAD_B, ROUND_LEAD_C],
      "returning a retained URL must not admit another paid read");
    assert.equal(second.result.usage.readAttempts, 2);
    assert.equal(second.result.usage.readsRetained, 2);
    assert.equal(second.result.evidence.filter((doc) => doc.url === ROUND_LEAD_A).length, 1);
    const later = second.result.evidence.find((doc) => doc.url === ROUND_LEAD_A);
    const { origins: _priorOrigins, ...priorStable } = first.result.evidence[0];
    const { origins: _laterOrigins, ...laterStable } = later;
    assert.deepEqual(laterStable, priorStable, "every stable retained field is preserved");
    assert.deepEqual(later.origins,
      [ROUND_SHARED, ROUND_QUESTION, `${ROUND_QUESTION} contrary evidence refuted`]);
    assert.deepEqual(first.result, firstSnapshot, "the complete prior result remains unchanged");
    assert.notEqual(later, first.result.evidence[0]);
    assert.notEqual(later.origins, first.result.evidence[0].origins);
    assert.deepEqual(second.calls.search,
      [ROUND_QUESTION, `${ROUND_QUESTION} contrary evidence refuted`]);
    assert.deepEqual(second.checkpoint.leads, []);
  });
}

// Query lineage is final-result metadata, independent of the physical read.
function freezeProvenanceInput(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(freezeProvenanceInput);
    Object.freeze(value);
  }
  return value;
}
async function provenanceRun({ semantic = true, kind = "lead" } = {}) {
  const url = "https://fixture.invalid/provenance-a";
  const fieldQuestion = "Does ProvenanceFixture 1.0 support CSV?";
  const shared = kind === "repeated" ? fieldQuestion : "Assess ProvenanceFixture 1.0 exports.";
  const content = "ProvenanceFixture 1.0 supports CSV.";
  const prior = { evidenceId: "prior1", url, title: "caller title", content,
    byteLength: Buffer.byteLength(content), origins: ["Caller prior query"] };
  const input = freezeProvenanceInput(kind === "nonseed" ? {}
    : kind === "retained" ? { evidence: [prior] }
      : { leads: [{ url, title: "caller title" }] });
  const before = structuredClone(input), calls = [], hits = [], hooks = [], snapshots = [];
  const result = await runLeanInvestigation({
    schemaVersion: 1, question: shared, scope: { release: "1.0" },
    requirements: { csv: { question: fieldQuestion, schema: { enum: ["supported", "refuted", "disputed"] } } },
    limits: { maxSearchAttempts: 3, maxUniqueReads: 2, readBatchSize: 1 },
  }, {
    now: () => 0,
    seed: { ...input, retainEvidence: async (record) => {
      hooks.push(record); snapshots.push(structuredClone(record)); freezeProvenanceInput(record);
    } },
    search: async (query) => {
      calls.push(["search", query]);
      if (kind === "failed") throw new Error("ordinary fixture search failure");
      const results = freezeProvenanceInput(kind === "invalid"
        ? [{ url: "", title: "empty" }, { url: 7, title: "wrong type" }]
        : [{ url, title: "search title" }, { url, title: "duplicate hit" }]);
      hits.push({ results, before: structuredClone(results) });
      return results;
    },
    read: async (readUrl) => { calls.push(["read", readUrl]); return content; },
    judge: semantic ? async ({ documents }) => {
      calls.push(["judge", "csv"]);
      return { documents: documents.map((doc) => verdict(doc.evidenceId)) };
    } : null,
  });
  assert.deepEqual(input, before, "caller records and their origin arrays stay unchanged");
  for (const hit of hits) assert.deepEqual(hit.results, hit.before);
  hooks.forEach((record, i) => assert.deepEqual(record, snapshots[i], "early hook snapshot is immutable"));
  assert.equal(result.evidence.length, 1);
  const record = result.evidence[0];
  assert.equal(record.url, url);
  assert.equal(record.content, content);
  assert.equal(record.byteLength, Buffer.byteLength(content));
  const reads = kind === "retained" ? 0 : 1;
  assert.equal(result.usage.readAttempts, reads);
  assert.equal(result.usage.readsRetained, reads);
  assert.equal(calls.filter(([kind]) => kind === "read").length, reads);
  assert.equal(hooks.length, reads, "provenance must not recall the physical retention hook");
  assert.equal(result.usage.searches, kind === "repeated" ? 2 : 3);
  assert.equal(result.usage.judgeCalls, semantic ? 1 : 0);
  const original = kind === "retained" ? input.evidence[0] : hooks[0];
  const { origins: _oldOrigins, ...oldStable } = original;
  const { origins: _newOrigins, ...newStable } = record;
  assert.deepEqual(newStable, oldStable, "all retained stable fields survive rediscovery");
  return { result, calls, snapshots, shared, fieldQuestion, original };
}

test("returned provenance includes later queries for a seeded read (semantic)", async () => {
  const { result, calls, snapshots, shared, fieldQuestion, original } = await provenanceRun();
  assert.deepEqual(calls[0], ["read", result.evidence[0].url]);
  assert.deepEqual(snapshots[0].origins, [], "a caller lead invents no search origin");
  assert.deepEqual(result.evidence[0].origins,
    [shared, fieldQuestion, `${fieldQuestion} contrary evidence refuted`]);
  assert.notEqual(result.evidence[0], original, "returned records are owned final snapshots");
  assert.notEqual(result.evidence[0].origins, original.origins, "returned origin arrays are owned");
});

for (const semantic of [true, false]) {
  for (const kind of ["lead", "nonseed", "retained", "failed", "invalid", "repeated"]) {
    if (semantic && kind === "lead") continue;
    test(`returned provenance preserves ${kind} lineage and ownership (${semantic ? "semantic" : "deterministic-only"})`, async () => {
      const { result, calls, snapshots, shared, fieldQuestion, original } = await provenanceRun({ semantic, kind });
      const queries = kind === "repeated" ? [fieldQuestion, `${fieldQuestion} contrary evidence refuted`]
        : [shared, fieldQuestion, `${fieldQuestion} contrary evidence refuted`];
      assert.deepEqual(calls.filter(([kind]) => kind === "search").map(([, query]) => query), queries);
      const expected = kind === "failed" || kind === "invalid" ? []
        : kind === "retained" ? ["Caller prior query", ...queries] : queries;
      assert.deepEqual(result.evidence[0].origins, expected);
      if (kind === "lead") {
        assert.deepEqual(calls[0], ["read", result.evidence[0].url]);
        assert.deepEqual(snapshots[0].origins, []);
      }
      if (kind === "failed") assert.equal(result.acquisitionLog.filter((e) => e.kind === "search-failed").length, 3);
      assert.notEqual(result.evidence[0], original);
      assert.notEqual(result.evidence[0].origins, original.origins);
    });
  }
}

test("returned provenance preserves the actually judged custom descriptor and native acceptance basis", async () => {
  const url = "https://fixture.invalid/provenance-license", content = "Release 1.0: License MIT.";
  const shared = "Assess license", question = "License of scoped release";
  const calls = [], judged = [], wires = [], hooks = [], hookSnapshots = [];
  let checkpoint;
  const lead = freezeProvenanceInput({ url, title: "Caller license" });
  const result = await runLeanInvestigation({
    schemaVersion: 1, question: shared, scope: { release: "1.0" },
    requirements: { license: { question, schema: { type: "string" } } },
  }, {
    now: () => 0,
    seed: { leads: freezeProvenanceInput([lead]), identity: "provenance-native-fixture",
      retainEvidence: async (record) => {
        hooks.push(record); hookSnapshots.push(structuredClone(record)); freezeProvenanceInput(record);
      }, capture: (state) => { checkpoint = structuredClone(state); } },
    search: async (query) => { calls.push(["search", query]); return freezeProvenanceInput([{ url, title: "Search title" }]); },
    read: async (readUrl) => { calls.push(["read", readUrl]); return content; },
    judge: async () => { assert.fail("value-only contract must not dispatch enum judgment"); },
    extract: async (input) => {
      calls.push(["extract", input.sourceId]);
      assert.deepEqual(input, { sourceId: "e1", sourceText: content,
        fields: [{ id: "license", description: question, depBindings: {} }], scope: { release: "1.0" }, depBindings: {} });
      return { finishReason: "stop", rawOutput: JSON.stringify({ license: { value: "MIT", quote: "License MIT" } }),
        usage: null, observedCost: null };
    },
    candidateJudge: async (input) => {
      calls.push(["candidate", input.source.evidenceId]);
      judged.push(structuredClone(input));
      wires.push(buildCandidateJudgeRequest(input, "fixture"));
      return { model: "fixture", answers: { q0s: { type: "noul", noul: 0.97 }, q0c: { type: "noul", noul: 0.01 } },
        usage: { inputTokens: 1, outputTokens: 1 }, requestSha256: "a".repeat(64), elapsedMs: 1 };
    },
  });
  assert.equal(result.status, "complete");
  assert.deepEqual(result.data, { license: "MIT" });
  assert.equal(judged.length, 1);
  assert.equal(hooks.length, 1);
  assert.deepEqual(judged[0].source, hookSnapshots[0], "custom assessor keeps the actual pre-query record");
  assert.deepEqual(judged[0].source.origins, []);
  assert.deepEqual(hooks[0], hookSnapshots[0], "projection does not mutate the early hook record");
  assert.deepEqual(result.evidence[0].origins, [shared, question, `${question} contrary evidence refuted`]);
  assert.notEqual(result.evidence[0], hooks[0]);
  assert.notEqual(result.evidence[0].origins, hooks[0].origins);
  const finalDescriptor = { ...judged[0], source: result.evidence[0] };
  assert.notDeepEqual(finalDescriptor, judged[0], "custom descriptors can observe lineage; they are never relabeled");
  assert.equal(buildCandidateJudgeRequest(finalDescriptor, "fixture"), wires[0]);
  assert.deepEqual(JSON.parse(wires[0]).state.source, { id: "e1", url, text: content });
  const candidate = judged[0].candidates[0];
  const expectedId = candidateIdentity(hookSnapshots[0], candidateSourceDigest(hookSnapshots[0]), "license",
    candidate.value, candidate.quote, candidate.charRange, { fieldMeaning: question, scope: { release: "1.0" }, opposingContext: [], depBindings: {} });
  assert.equal(result.requirements.license.judgment.candidateId, expectedId);
  assert.equal(candidateSourceDigest(result.evidence[0]), candidateSourceDigest(hookSnapshots[0]));
  assert.deepEqual(checkpoint.history.map((row) => row.context),
    [JSON.stringify([["e1", candidateSourceDigest(hookSnapshots[0])]])]);
  assert.deepEqual(result.usage, { searches: 3, readAttempts: 1, readsRetained: 1,
    judgeCalls: 0, extractorCalls: 1, extractorCacheHits: 0, candidateJudgeCalls: 1 });
  assert.deepEqual(calls.filter(([kind]) => kind === "search").map(([, query]) => query),
    [shared, question, `${question} contrary evidence refuted`]);
});

// Round5: carried discovery metadata is separate from query/proof authority.
const LINEAGE_SHARED = "Trace LineageApp 5 evidence";
const LINEAGE_QUESTION = "Does LineageApp 5 support CSV?";
const LINEAGE_A = "https://fixture.invalid/round5/unread-a";
const LINEAGE_B = "https://fixture.invalid/round5/spent-b";
async function runSeedLineage({ semantic = true, value = false, seedInput = {}, discover = () => [] } = {}) {
  const input = freezeProvenanceInput(seedInput), before = structuredClone(input);
  const calls = { search: [], read: [], enum: [], extract: [], candidate: [] };
  const hooks = [], hookSnapshots = [], judged = [], wires = [], hitInputs = [];
  let checkpoint;
  const question = value ? "License of LineageApp 5" : LINEAGE_QUESTION;
  const result = await runLeanInvestigation({
    schemaVersion: 1, question: LINEAGE_SHARED, scope: { release: "5" },
    requirements: value ? { license: { question, schema: { type: "string" } } }
      : { csv: { question, schema: { enum: ["supported", "refuted", "disputed"] } } },
    limits: { maxUniqueReads: 1, maxSearchAttempts: 3, readBatchSize: 1 },
  }, {
    now: () => 0,
    seed: { ...input, capture: (state) => { checkpoint = state; }, retainEvidence: async (record) => {
      hooks.push(record); hookSnapshots.push(structuredClone(record)); freezeProvenanceInput(record);
    } },
    search: async (query) => {
      calls.search.push(query);
      const hits = freezeProvenanceInput(discover(query));
      hitInputs.push({ hits, before: structuredClone(hits) });
      return hits;
    },
    read: async (url) => { calls.read.push(url); return `LineageApp 5 supports CSV. License MIT. ${url}`; },
    judge: semantic ? async (request) => {
      calls.enum.push(structuredClone(request));
      return { documents: request.documents.map((doc) => verdict(doc.evidenceId)) };
    } : null,
    extract: async (request) => {
      calls.extract.push(structuredClone(request));
      return { finishReason: "stop", rawOutput: JSON.stringify({ license: { value: "MIT", quote: "License MIT" } }), usage: null, observedCost: null };
    },
    candidateJudge: async (request) => {
      calls.candidate.push(request.source.evidenceId); judged.push(structuredClone(request));
      wires.push(buildCandidateJudgeRequest(request, "fixture"));
      return { model: "fixture", answers: { q0s: { type: "noul", noul: 0.97 }, q0c: { type: "noul", noul: 0.01 } },
        usage: { inputTokens: 1, outputTokens: 1 }, requestSha256: "a".repeat(64), elapsedMs: 1 };
    },
  });
  assert.deepEqual(input, before, "caller seed records and arrays remain unchanged");
  hitInputs.forEach(({ hits, before }) => assert.deepEqual(hits, before));
  hooks.forEach((record, i) => assert.deepEqual(record, hookSnapshots[i], "initial hook snapshots remain unchanged"));
  assert.equal(result.usage.searches, calls.search.length);
  assert.equal(result.usage.readAttempts, calls.read.length);
  assert.equal(result.usage.judgeCalls, calls.enum.length);
  assert.equal(result.usage.extractorCalls, calls.extract.length);
  assert.equal(result.usage.candidateJudgeCalls, calls.candidate.length);
  return { result, checkpoint, calls, hooks, hookSnapshots, judged, wires, input, question };
}
async function assertUnreadSeedRoundtrip(semantic) {
  const first = await runSeedLineage({ semantic,
    seedInput: { leads: [{ url: LINEAGE_B, title: "Spend one read" }] },
    discover: () => [{ url: LINEAGE_A, title: "Actual unread lead" }],
  });
  const queries = [LINEAGE_SHARED, LINEAGE_QUESTION, `${LINEAGE_QUESTION} contrary evidence refuted`];
  assert.deepEqual(first.calls.read, [LINEAGE_B]);
  assert.deepEqual(first.calls.search, queries);
  assert.equal(first.checkpoint.leads.length, 1);
  assert.deepEqual(first.checkpoint.leads[0].origins, queries);
  assert.deepEqual(first.checkpoint.history, []);
  const firstBefore = structuredClone(first);
  freezeProvenanceInput(first);
  const seed = { evidence: first.result.evidence, leads: first.checkpoint.leads, issuedQueries: first.checkpoint.issuedQueries };
  assert.equal(Object.hasOwn(seed, "history"), false);
  assert.equal(Object.hasOwn(seed, "proofs"), false);
  const second = await runSeedLineage({ semantic, seedInput: seed });
  assert.deepEqual(second.calls.read, [LINEAGE_A]);
  assert.deepEqual(second.calls.search, []);
  assert.equal(second.result.usage.readsRetained, 1);
  assert.deepEqual(second.result.evidence.map((record) => record.url), [LINEAGE_B, LINEAGE_A]);
  assert.deepEqual(second.result.evidence[1].origins, queries);
  assert.deepEqual(second.hookSnapshots[0].origins, queries, "carried metadata belongs to the newly read record from admission");
  assert.deepEqual(second.result.evidence[0], first.result.evidence[0]);
  assert.deepEqual(first, firstBefore, "the whole earlier result/checkpoint stays immutable");
  assert.notEqual(second.result.evidence[1], second.hooks[0]);
  assert.notEqual(second.result.evidence[1].origins, second.hooks[0].origins);
}
test("round5 unread seed checkpoint semantic", async () => {
  await assertUnreadSeedRoundtrip(true);
});

function lineageSeedRecord(id, url, origins) {
  const content = `${id}: LineageApp 5 supports CSV. License MIT.`;
  return { evidenceId: id, url, title: `Title ${id}`, content,
    byteLength: Buffer.byteLength(content), origins };
}
async function assertSeededURLLineage(semantic) {
  for (const kind of ["same", "unique", "rediscovered"]) {
    const records = [lineageSeedRecord("seed-a", LINEAGE_A, ["caller-A", "common"]),
      lineageSeedRecord("seed-b", kind === "unique" ? LINEAGE_B : LINEAGE_A, ["common", "caller-B"])];
    const original = structuredClone(records);
    const run = await runSeedLineage({ semantic, seedInput: { evidence: records },
      discover: () => kind === "rediscovered" ? [{ url: LINEAGE_A, title: "Rediscovered" }] : [],
    });
    const queries = [LINEAGE_SHARED, LINEAGE_QUESTION, `${LINEAGE_QUESTION} contrary evidence refuted`];
    const expected = kind === "unique" ? original.map((record) => record.origins)
      : [0, 1].map(() => ["caller-A", "common", "caller-B", ...(kind === "rediscovered" ? queries : [])]);
    assert.deepEqual(run.result.evidence.map((record) => record.origins), expected);
    assert.deepEqual(records, original);
    assert.equal(run.result.evidence.length, 2);
    run.result.evidence.forEach((record, i) => {
      const { origins: _returned, ...stable } = record;
      const { origins: _supplied, ...supplied } = original[i];
      assert.deepEqual(stable, supplied, "every representation and stable field is retained in order");
      assert.notEqual(record, records[i]);
      assert.notEqual(record.origins, records[i].origins);
    });
    assert.notEqual(run.result.evidence[0].origins, run.result.evidence[1].origins);
    assert.deepEqual(run.calls.read, []);
    assert.deepEqual(run.calls.search, queries);
    assert.deepEqual(run.hooks, []);
    assert.equal(run.result.usage.readsRetained, 0);
    assert.equal(run.result.usage.extractorCalls, 0);
    assert.equal(run.result.usage.candidateJudgeCalls, 0);
    assert.equal(run.calls.enum.length, semantic ? 1 : 0);
    if (semantic) assert.deepEqual(run.calls.enum[0].documents, original.map(({ origins, byteLength, ...doc }) => doc));
  }
}
test("round5 same URL seed lineage semantic", async () => {
  await assertSeededURLLineage(true);
});

test("round5 unread seed checkpoint deterministic-only", async () => {
  await assertUnreadSeedRoundtrip(false);
});
test("round5 same URL seed lineage deterministic-only", async () => {
  await assertSeededURLLineage(false);
});
test("round5 optional lead metadata stays separate from coverage and preserves ownership", async () => {
  const cases = [{ name: "omitted" }, { name: "empty", origins: [] },
    { name: "string", origins: "not an array" }, { name: "null", origins: null },
    { name: "mixed", origins: ["discard the whole carrier", 7] },
    { name: "sparse", origins: new Array(1) }];
  for (const semantic of [true, false]) {
    for (const row of cases) {
      const lead = { url: LINEAGE_A, title: row.name,
        ...(Object.hasOwn(row, "origins") ? { origins: row.origins } : {}) };
      const run = await runSeedLineage({ semantic, seedInput: { leads: [lead] } });
      assert.deepEqual(run.result.evidence[0].origins, [], row.name);
      assert.deepEqual(run.hookSnapshots[0].origins, [], row.name);
      assert.deepEqual(run.calls.read, [LINEAGE_A]);
      assert.equal(run.result.usage.readsRetained, 1);
      assert.equal(run.calls.search.length, 3, "metadata cannot settle or skip a query");
      assert.notEqual(run.result.evidence[0], run.hooks[0]);
      assert.notEqual(run.result.evidence[0].origins, run.hooks[0].origins);
    }
    const contrary = `${LINEAGE_QUESTION} contrary evidence refuted`;
    const leads = [{ url: LINEAGE_A, title: "first title", origins: ["caller-A", LINEAGE_SHARED] },
      { url: LINEAGE_A, title: "ignored later title", origins: [LINEAGE_SHARED, "caller-B", contrary] }];
    const run = await runSeedLineage({ semantic, seedInput: { leads } });
    const expected = ["caller-A", LINEAGE_SHARED, "caller-B", contrary];
    assert.deepEqual(run.result.evidence[0].origins, expected);
    assert.deepEqual(run.hookSnapshots[0].origins, expected, "duplicate lead metadata merges before its queue skip");
    assert.equal(run.result.evidence[0].title, "first title");
    assert.deepEqual(run.calls.read, [LINEAGE_A]);
    assert.equal(run.hooks.length, 1);
    assert.deepEqual(run.calls.search, [LINEAGE_SHARED, LINEAGE_QUESTION, contrary]);
    assert.deepEqual(run.checkpoint.issuedQueries, run.calls.search, "only actual successful calls establish coverage");
    assert.notEqual(run.result.evidence[0].origins, leads[0].origins);
    assert.notEqual(run.result.evidence[0].origins, leads[1].origins);
  }
});
test("round5 custom descriptors retain their actual metadata and native acceptance basis", async () => {
  const carried = ["prior discovery"];
  const newlyRead = await runSeedLineage({ value: true,
    seedInput: { leads: [{ url: LINEAGE_A, title: "Carried license", origins: carried }], identity: "round5-new-record" },
    discover: () => [{ url: LINEAGE_A, title: "Rediscovered license" }],
  });
  const queries = [LINEAGE_SHARED, newlyRead.question, `${newlyRead.question} contrary evidence refuted`];
  assert.equal(newlyRead.result.status, "complete");
  assert.deepEqual(newlyRead.result.data, { license: "MIT" });
  assert.deepEqual(newlyRead.calls.read, [LINEAGE_A]);
  assert.deepEqual(newlyRead.calls.search, queries);
  assert.equal(newlyRead.calls.extract.length, 1);
  assert.equal(newlyRead.judged.length, 1);
  assert.deepEqual(newlyRead.hookSnapshots[0].origins, carried);
  assert.deepEqual(newlyRead.judged[0].source, newlyRead.hookSnapshots[0], "the first custom assessment receives the carried metadata");
  assert.deepEqual(newlyRead.result.evidence[0].origins, [...carried, ...queries]);
  assert.notEqual(newlyRead.hooks[0].origins, carried);
  assert.notEqual(newlyRead.result.evidence[0].origins, newlyRead.hooks[0].origins);
  assert.deepEqual(newlyRead.checkpoint.history.map((row) => row.context),
    [JSON.stringify([["e1", candidateSourceDigest(newlyRead.hookSnapshots[0])]])]);
  const records = [lineageSeedRecord("value-a", LINEAGE_A, ["caller-A", "common"]),
    lineageSeedRecord("value-b", LINEAGE_A, ["common", "caller-B"])];
  const original = structuredClone(records);
  const seeded = await runSeedLineage({ value: true, seedInput: { evidence: records },
    discover: () => [{ url: LINEAGE_A, title: "Rediscovered" }],
  });
  assert.equal(seeded.result.status, "complete");
  assert.deepEqual(seeded.result.data, { license: "MIT" });
  assert.deepEqual(seeded.calls.read, []);
  assert.deepEqual(seeded.hooks, []);
  assert.equal(seeded.calls.extract.length, 2);
  assert.equal(seeded.judged.length, 2);
  assert.equal(seeded.calls.enum.length, 0);
  assert.deepEqual(records, original);
  assert.deepEqual(seeded.result.evidence.map((record) => record.origins),
    [0, 1].map(() => ["caller-A", "common", "caller-B", ...queries]));
  for (const run of [newlyRead, seeded]) {
    const ids = [];
    run.judged.forEach((request, i) => {
      const source = run === seeded ? original.find((row) => row.evidenceId === request.source.evidenceId) : run.hookSnapshots[0];
      const opposing = run === seeded ? original.filter((row) => row.evidenceId !== source.evidenceId) : [];
      const quote = "License MIT", start = source.content.indexOf(quote);
      assert.deepEqual(request, { source, fieldMeanings: { license: run.question }, scope: { release: "5" },
        candidates: [{ fieldId: "license", value: "MIT", quote, charRange: [start, start + quote.length] }],
        opposingContext: opposing, depBindings: {} }, "the full actual descriptor is never relabeled by final aggregation");
      const finalRequest = { ...request,
        source: run.result.evidence.find((row) => row.evidenceId === source.evidenceId),
        opposingContext: run.result.evidence.filter((row) => row.evidenceId !== source.evidenceId) };
      assert.notDeepEqual(finalRequest, request);
      assert.equal(buildCandidateJudgeRequest(finalRequest, "fixture"), run.wires[i]);
      ids.push(candidateIdentity(source, candidateSourceDigest(source), "license", "MIT", quote,
        [start, start + quote.length], { fieldMeaning: run.question, scope: { release: "5" }, opposingContext: opposing, depBindings: {} }));
    });
    assert.ok(ids.includes(run.result.requirements.license.judgment.candidateId));
    assert.equal(run.result.usage.extractorCacheHits, 0);
  }
});

// A round-local acquisition terminal must not erase reusable semantic history.
async function continuationGapEpisode({ mode = "enum", scene = "gap", maxSearches, seedInput = {} } = {}) {
  const shared = "Review CapCarry 1 signed-export evidence";
  const question = mode === "value" ? "License of CapCarry 1" : "Does CapCarry 1 enable signed export?";
  const contrary = `${question} contrary evidence refuted`;
  const positive = "https://fixture.invalid/cap-carry/positive";
  const adverse = "https://fixture.invalid/cap-carry/contrary";
  const input = freezeProvenanceInput(seedInput), before = structuredClone(input);
  const calls = [];
  let checkpoint;
  const result = await runLeanInvestigation({
    schemaVersion: 1, question: shared, scope: { product: "CapCarry", release: "1" },
    requirements: { feature: { question, required: true, schema: mode === "value"
      ? { type: "string" } : { enum: ["supported", "refuted", "disputed"] } } },
    limits: { maxSearchAttempts: maxSearches, maxUniqueReads: 2 },
  }, {
    now: () => 0,
    seed: { ...input, identity: `cap-carry-${mode}-regression-v1`, capture: (state) => { checkpoint = state; } },
    search: async (query) => {
      calls.push({ op: "search", query });
      assert([shared, question, contrary].includes(query), "only the existing frozen query plan is used");
      return query === shared ? [{ url: positive, title: "positive specification" },
        ...(scene === "complete" && mode === "enum" ? [{ url: adverse, title: "contrary specification" }] : [])]
        : query === contrary ? [{ url: adverse, title: "contrary specification" }] : [];
    },
    read: async (url) => {
      calls.push({ op: "read", url });
      assert([positive, adverse].includes(url));
      return mode === "value" ? `CapCarry 1 License MIT. ${url}`
        : url === positive ? "CapCarry 1 enables signed export." : "CapCarry 1 disables signed export.";
    },
    judge: async (request) => {
      calls.push({ op: "judge", request: structuredClone(request) });
      return { documents: request.documents.map((doc) => ({ evidenceId: doc.evidenceId,
        relevant: true, supportsClaim: scene === "unresolved" ? null : doc.content.includes("enables"),
        refutesClaim: scene === "unresolved" ? null : doc.content.includes("disables") })) };
    },
    extractorRevision: "cap-carry-extractor-v1",
    extract: async (request) => {
      calls.push({ op: "extract", request: structuredClone(request) });
      return { finishReason: "stop", rawOutput: JSON.stringify({ feature: { value: "MIT", quote: "License MIT" } }),
        usage: null, observedCost: null };
    },
    candidateJudge: async (request) => {
      calls.push({ op: "candidateJudge", request: structuredClone(request) });
      return { model: "fixture", answers: { q0s: { type: "noul", noul: 0.97 }, q0c: { type: "noul", noul: 0.01 } },
        usage: { inputTokens: 1, outputTokens: 1 }, requestSha256: "c".repeat(64), elapsedMs: 1 };
    },
  });
  assert.deepEqual(input, before, "history and retained records remain caller-owned");
  for (const [counter, op] of [["searches", "search"], ["readAttempts", "read"], ["judgeCalls", "judge"],
    ["extractorCalls", "extract"], ["candidateJudgeCalls", "candidateJudge"]]) {
    assert.equal(result.usage[counter], calls.filter((c) => c.op === op).length, `${counter} counts actual calls`);
  }
  return { result, checkpoint, calls, positive, adverse, contrary };
}

test("cap-partial continuation resumes useful contrary work without discarding its judged basis", async (t) => {
  for (const mode of ["enum", "value"]) {
    const first = await continuationGapEpisode({ mode, maxSearches: 1 });
    t.diagnostic(`continuation-first ${JSON.stringify({ mode, ...first })}`);
    assert.equal(first.result.status, "partial");
    assert.equal(first.result.requirements.feature.reason, "counterevidence_not_acquired");
    const prior = first.checkpoint.history.at(-1).state;
    assert.equal(prior.ctrvIssued, false);
    if (mode === "enum") assert.equal(prior.pendingAccept, "supported");
    else assert(prior.acceptedCandidate !== null && prior.trustedAccepts.length > 0, "the actual provisional proof is carried");
    const before = structuredClone(first);
    freezeProvenanceInput(first);
    const second = await continuationGapEpisode({ mode, maxSearches: 3, seedInput: {
      evidence: first.result.evidence, history: first.checkpoint.history,
      leads: first.checkpoint.leads, issuedQueries: first.checkpoint.issuedQueries,
    } });
    t.diagnostic(`continuation-second ${JSON.stringify({ mode, ...second })}`);
    assert(second.calls.some((c) => c.op === "search" && c.query === second.contrary),
      "fresh continuation must perform its useful never-issued contrary acquisition");
    const newRead = second.calls.findIndex((c) => c.op === "read" && c.url === second.adverse);
    assert(newRead >= 0, "the newly discovered contrary URL must actually be read");
    assert(!second.calls.some((c) => c.op === "read" && c.url === first.positive), "retained source is never reread");
    assert(second.calls.every((c, i) => !["judge", "extract", "candidateJudge"].includes(c.op) || i > newRead),
      "unchanged retained context must not buy another judgment or extraction before new evidence");
    assert(second.result.evidence.some((e) => e.url === second.adverse));
    assert(second.checkpoint.issuedQueries.includes(second.contrary));
    assert.deepEqual(second.checkpoint.history.slice(0, first.checkpoint.history.length), first.checkpoint.history);
    assert.deepEqual(second.checkpoint.history.at(-1).state.attemptedRecords.slice(0, prior.attemptedRecords.length),
      prior.attemptedRecords, "prior semantic attempts remain intact");
    assert.deepEqual(second.checkpoint.history.at(-1).state.assessmentHistory.slice(0, prior.assessmentHistory.length),
      prior.assessmentHistory, "prior semantic assessments remain intact");
    assert.deepEqual(first, before, "the complete prior result and captured packet remain unchanged");
  }
});

test("stable complete continuation does not spend a larger allowance on unused plan entries", async () => {
  for (const mode of ["enum", "value"]) {
    const first = await continuationGapEpisode({ mode, scene: "complete", maxSearches: mode === "enum" ? 1 : 3 });
    assert.equal(first.result.status, "complete");
    if (mode === "enum") assert(!first.checkpoint.issuedQueries.includes(first.contrary), "disputed completion needs no invented contrary search");
    const before = structuredClone(first);
    freezeProvenanceInput(first);
    const second = await continuationGapEpisode({ mode, scene: "complete", maxSearches: 6, seedInput: {
      evidence: first.result.evidence, history: first.checkpoint.history,
      leads: first.checkpoint.leads, issuedQueries: first.checkpoint.issuedQueries,
    } });
    assert.deepEqual(second.calls, [], "a settled proof cannot score-fish with a larger ceiling");
    assert.equal(second.result.status, "complete");
    assert.deepEqual(second.result.data, first.result.data);
    assert.deepEqual(first, before);
  }
});

test("fully issued stable unresolved continuation invents no acquisition or judgment", async () => {
  const first = await continuationGapEpisode({ scene: "unresolved", maxSearches: 3 });
  assert.equal(first.result.status, "partial");
  assert.equal(first.result.requirements.feature.status, "unresolved");
  assert(first.result.plan.queries.every((entry) => first.checkpoint.issuedQueries.includes(entry.query)));
  assert.deepEqual(first.checkpoint.leads, []);
  const before = structuredClone(first);
  freezeProvenanceInput(first);
  const second = await continuationGapEpisode({ scene: "unresolved", maxSearches: 6, seedInput: {
    evidence: first.result.evidence, history: first.checkpoint.history,
    leads: first.checkpoint.leads, issuedQueries: first.checkpoint.issuedQueries,
  } });
  assert.deepEqual(second.calls, [], "no useful remaining route means no paid retry or score fishing");
  assert.deepEqual(second.result.requirements, first.result.requirements);
  assert.deepEqual(second.checkpoint.issuedQueries, first.checkpoint.issuedQueries);
  assert.deepEqual(first, before);
});
