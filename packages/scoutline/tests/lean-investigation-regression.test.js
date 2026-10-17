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
      second.calls.search, "deduplication must preserve every successful query origin");
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
    const second = await runSeedLeadRound({ semantic, retain: true, maxReads: 3, seedInput: {
      evidence: first.result.evidence, leads: first.checkpoint.leads,
      issuedQueries: first.checkpoint.issuedQueries,
    } });
    assert.deepEqual(second.calls.read, [ROUND_LEAD_B, ROUND_LEAD_C],
      "returning a retained URL must not admit another paid read");
    assert.equal(second.result.usage.readAttempts, 2);
    assert.equal(second.result.usage.readsRetained, 2);
    assert.equal(second.result.evidence.filter((doc) => doc.url === ROUND_LEAD_A).length, 1);
    assert.deepEqual(second.result.evidence.find((doc) => doc.url === ROUND_LEAD_A),
      first.result.evidence[0]);
    assert.deepEqual(second.calls.search,
      [ROUND_QUESTION, `${ROUND_QUESTION} contrary evidence refuted`]);
    assert.deepEqual(second.checkpoint.leads, []);
  });
}
