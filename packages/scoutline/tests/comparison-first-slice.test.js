/**
 * Evidence-backed comparison first slice (docs/plans/v3/FIRST-SLICE.json)
 * — offline acceptance through the REAL merged engine.
 *
 * Hermetic: runtime injected through the requirements seam with
 * fake-fetch HTTP and a scope-aware fake judge; zero network, zero
 * ambient credentials, constant clock (now() => 0).
 *
 * Covers the four proposed acceptance cases:
 *   1. positive-and-wrong-scope — same-scope support accepts, wrong-
 *      edition evidence leaves the cell unresolved;
 *   2. explicit-refutation — explicit same-scope refutation refutes,
 *      silence stays unresolved;
 *   3. conflict-and-budget — opposing same-scope evidence disputes;
 *      budget exhaustion retains rows and reasons;
 *   4. oversize-preflight — 2 × 2 expansion refuses before any runtime
 *      composition or acquisition;
 * plus stable cell mapping, preflight guards, and the repair-review
 * regression controls: literal `$`-sequence interpolation, exact schema
 * key set (no silent stripping), owned limits screen + copy, pre-abort
 * and setup-phase cancellation as 130 without masking unrelated
 * errors, and the delivery ties — shared redacted evidence, hash over
 * the final delivered matrix, physical accounting counts, and cell→
 * evidence ID resolution.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  expandComparison,
  comparisonCellKey,
  runEvidenceComparison,
  joinServeProvenance,
  verifyEngineDisplayIntegrity,
} from "../dist/commands/investigate-comparison.js";
import { createTavilyDescriptor } from "../dist/providers/tavily/adapter.js";

const ENV = { TAVILY_API_KEY: "guard-synthetic-key", TAVILY_TIMEOUT: "2000" };
const SECRET = "guard-synthetic-secret-9f1a";

const COMPARISON = {
  schemaVersion: 1,
  question: "Compare CSV export support across two ExampleApp releases.",
  entities: ["2.4.0", "2.5.0"],
  dimensions: {
    csv_export: {
      question:
        "Does ExampleApp Community {entity} for Linux explicitly support CSV export?",
      criteria: ["Same edition, release and platform as the requested scope."],
    },
  },
  frame: { entity: "ExampleApp", edition: "Community", platform: "Linux" },
};

// --- fixture world: docs, fake HTTP, scope-aware fake judge --------------

const DOC = (edition, release, stance) => ({
  url: `https://offline.test/exampleapp-${edition}-${release}-${stance}`,
  title: `ExampleApp ${edition} ${release} notes (${stance})`,
  content: `ExampleApp ${edition} ${release} on Linux ${stance} CSV export.`,
});
const SCOPE_RE = /^ExampleApp (Community|Enterprise) (\d+\.\d+\.\d+) on Linux (supports|does not support) CSV export\.$/;
const FIELD_RE = /ExampleApp (Community|Enterprise) (\d+\.\d+\.\d+) for Linux/;

function fakeWorld(docs, { onHttp = () => {} } = {}) {
  const httpLog = [];
  const fetch = async (url, init) => {
    httpLog.push(String(url));
    onHttp(httpLog.length);
    const path = new URL(String(url)).pathname;
    const body = JSON.parse(String(init.body ?? "{}"));
    if (path === "/search") {
      return Response.json({
        results: docs.map((d) => ({ url: d.url, title: d.title, content: d.content.slice(0, 40) })),
      });
    }
    const target = String(body.urls?.[0] ?? "");
    const doc = docs.find((d) => d.url === target);
    return Response.json({
      results: doc ? [{ url: doc.url, title: doc.title, raw_content: doc.content }] : [],
    });
  };
  // The judge is the scope authority: a document is relevant only when
  // its own edition + release match the exact entity named in the cell's
  // obligation question. Wrong-scope or silent evidence is never a value.
  const judge = async (input) => {
    onJudge?.(input);
    return {
      documents: input.documents.map((doc) => {
        const docMatch = SCOPE_RE.exec(doc.content);
        const fieldMatch = FIELD_RE.exec(input.fieldQuestion);
        if (!docMatch || !fieldMatch) {
          return { evidenceId: doc.evidenceId, relevant: false, supportsClaim: false, refutesClaim: false };
        }
        const scopeMatch =
          docMatch[1] === fieldMatch[1] && docMatch[2] === fieldMatch[2];
        if (!scopeMatch) {
          return { evidenceId: doc.evidenceId, relevant: false, supportsClaim: false, refutesClaim: false };
        }
        const supports = docMatch[3] === "supports";
        return {
          evidenceId: doc.evidenceId,
          relevant: true,
          supportsClaim: supports,
          refutesClaim: !supports,
        };
      }),
    };
  };
  return { httpLog, judge, fetch };
}
let onJudge = null;

function makeRuntime({ docs, withJudge = true, factoryOverride, onHttp }) {
  const world = fakeWorld(docs, { onHttp });
  const transport = { fetch: world.fetch, env: ENV };
  let composed = 0;
  const factory = (context) => {
    composed += 1;
    if (factoryOverride) return factoryOverride(context);
    return {
      acquisitionOptions: {
        transports: { tavily: transport },
        descriptorFactory: (_id, t) => createTavilyDescriptor({ transport: t }),
        searchDescriptor: createTavilyDescriptor({ transport }),
        readerDescriptor: createTavilyDescriptor({ transport }),
        env: ENV,
        cache: { get: async () => null, set: async () => {} },
        sleep: async () => {},
        random: () => 0,
        retryPolicy: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, jitterMs: 0 },
        reservePhysicalAttempt: context.reserveAttempt ?? (() => {}),
      },
      engineDeps: {
        judge: withJudge ? world.judge : null,
        candidateJudge: null,
        now: () => 0,
      },
    };
  };
  return { factory, world, composedCount: () => composed };
}

const THROWING_READS = {
  readFile: async () => { throw new Error("no input read in this lane"); },
  readStdin: async () => { throw new Error("no input read in this lane"); },
};

async function run(input, { docs, limits, secrets, signal, stallQuota, onHttp, env, judgeHook } = {}) {
  const runtime = makeRuntime({ docs, onHttp });
  const prevJudgeHook = onJudge;
  if (judgeHook) onJudge = judgeHook;
  try {
    const result = await runEvidenceComparison(
      limits === undefined ? input : { ...input, limits },
      { ...THROWING_READS, now: () => 0, requirementsRuntime: runtime.factory, registerUserInterrupt: () => () => {} },
      {
        env: env ?? { ...ENV },
        provider: "tavily",
        noCache: true,
        cache: { get: async () => null, set: async () => {} },
        sleep: async () => {},
        random: () => 0,
        ...(secrets !== undefined ? { secrets } : {}),
        ...(stallQuota ? { readQuotaSnapshot: () => new Promise(() => {}) } : {}),
      },
      signal,
    );
    return { result, runtime };
  } finally {
    onJudge = prevJudgeHook;
  }
}

// --- stable cell mapping + preflight guards ------------------------------

test("deterministic expansion produces the stable cell-to-requirement map", () => {
  const expanded = expandComparison(COMPARISON);
  assert.deepEqual(Object.keys(expanded.cells), ["2_4_0_csv_export", "2_5_0_csv_export"]);
  assert.equal(comparisonCellKey("2.4.0", "csv_export"), "2_4_0_csv_export");
  for (const [key, cell] of Object.entries(expanded.cells)) {
    assert.equal(cell.requirementId, key);
    assert.ok(["2.4.0", "2.5.0"].includes(cell.entity));
    assert.equal(cell.dimension, "csv_export");
    const requirement = expanded.contractInput.requirements[key];
    assert.match(requirement.question, new RegExp(`ExampleApp Community ${cell.entity.replace(/\./g, "\\.")} for Linux`));
    assert.deepEqual(requirement.schema, { enum: ["supported", "refuted", "disputed"] });
    assert.equal(requirement.required, true);
  }
  assert.deepEqual(expanded.contract.scope, COMPARISON.frame);
});

test("entity labels interpolate LITERALLY: $-sequences never rewrite the obligation", () => {
  const expanded = expandComparison({
    ...COMPARISON,
    entities: ["2$&4.0"],
    dimensions: { csv_export: { question: "Does release {entity} support CSV export?" } },
  });
  const question = expanded.contractInput.requirements["2_4_0_csv_export"].question;
  assert.equal(question, "Does release 2$&4.0 support CSV export?");
  for (const entity of ["2$'4", "2$`4", "2$$4", "2$<4"]) {
    const literal = expandComparison({
      ...COMPARISON,
      entities: [entity],
      dimensions: { csv_export: { question: "Does release {entity} support CSV export?" } },
    });
    assert.equal(
      literal.contractInput.requirements[comparisonCellKey(entity, "csv_export")].question,
      `Does release ${entity} support CSV export?`,
      `entity ${entity} must interpolate literally`,
    );
  }
});

test("oversize expansion (2 releases × 2 dimensions) refuses before any runtime composition or acquisition", async () => {
  const oversize = {
    ...COMPARISON,
    dimensions: {
      ...COMPARISON.dimensions,
      pdf_export: { question: "Does ExampleApp Community {entity} for Linux explicitly support PDF export?" },
    },
  };
  const runtime = makeRuntime({ docs: [] });
  await assert.rejects(
    runEvidenceComparison(
      oversize,
      { ...THROWING_READS, now: () => 0, requirementsRuntime: runtime.factory, registerUserInterrupt: () => () => {} },
      { env: { ...ENV }, provider: "tavily", noCache: true, cache: { get: async () => null, set: async () => {} }, sleep: async () => {}, random: () => 0 },
    ),
    (error) =>
      error.code === "VALIDATION_ERROR" &&
      /expands to 4 cells \(2 entities × 2 dimensions\) over the engine's frozen ceiling of 3 fields/.test(error.message) &&
      /refused before any acquisition/.test(error.message),
  );
  assert.equal(runtime.composedCount(), 0, "runtime must never compose for unsupported expansion");
  assert.equal(runtime.world.httpLog.length, 0, "zero HTTP dispatches for unsupported expansion");
});

for (const [name, input, pattern] of [
  ["duplicate entity", { ...COMPARISON, entities: ["2.4.0", "2.4.0"] }, /duplicate entity "2\.4\.0"/],
  ["colliding slugs", { ...COMPARISON, entities: ["2.4.0", "2_4_0"] }, /cell key "2_4_0_csv_export" collides/],
  ["missing entity placeholder", { ...COMPARISON, dimensions: { csv_export: { question: "Does it support CSV export?" } } }, /exactly once/],
  ["unknown top-level key", { ...COMPARISON, ranking: true }, /unsupported keys \(ranking\)/],
  ["unknown dimension key", { ...COMPARISON, dimensions: { csv_export: { question: "Q {entity}?", extractor: "x" } } }, /unsupported keys \(extractor\)/],
  ["wrong schemaVersion", { ...COMPARISON, schemaVersion: 2 }, /schemaVersion must be the number 1/],
  ["schema controls beyond enum are rejected, not silently stripped", { ...COMPARISON, dimensions: { csv_export: { question: "Q {entity}?", schema: { enum: ["supported", "refuted", "disputed"], pattern: "^x$" } } } }, /supports exactly \{ enum: \[\.\.\.\] \}.*pattern/],
  ["schema without enum is rejected", { ...COMPARISON, dimensions: { csv_export: { question: "Q {entity}?", schema: { type: "string" } } } }, /supports exactly \{ enum: \[\.\.\.\] \}/],
  ["unknown limits key is the comparison's own typed error", { ...COMPARISON, limits: { maxFields: 9 } }, /comparison limits declare unsupported keys \(maxFields\)/],
]) {
  test(`preflight rejects ${name} before any work`, () => {
    assert.throws(() => expandComparison(input), (error) => error.code === "VALIDATION_ERROR" && pattern.test(error.message));
  });
}

test("expanded contract carries a copy: caller-held limits cannot mutate the run", () => {
  const limits = { maxSearchAttempts: 3 };
  const input = { ...COMPARISON, limits };
  const expanded = expandComparison(input);
  limits.maxSearchAttempts = 1;
  assert.equal(expanded.contractInput.limits.maxSearchAttempts, 3, "preflight decision binds the copy, not the caller's object");
});

// --- acceptance case 1: positive and wrong scope --------------------------

test("same-scope support accepts; wrong-edition evidence leaves the cell unresolved", async () => {
  const { result, runtime } = await run(COMPARISON, {
    docs: [
      DOC("Community", "2.4.0", "supports"),
      DOC("Enterprise", "2.5.0", "supports"),
    ],
  });
  assert.equal(result.kind, "data");
  assert.equal(result.data.kind, "evidence-comparison");
  assert.equal(result.data.status, "partial");
  assert.equal(result.exitCode, 1);
  const cells = result.data.cells;
  assert.equal(cells["2_4_0_csv_export"].outcome, "supported");
  assert.equal(cells["2_4_0_csv_export"].status, "satisfied");
  assert.ok(cells["2_4_0_csv_export"].evidenceIds.length > 0, "accepted cell carries evidence references");
  assert.equal(cells["2_5_0_csv_export"].outcome, "unresolved");
  assert.equal(cells["2_5_0_csv_export"].status, "unresolved");
  assert.ok(cells["2_5_0_csv_export"].reason, "unresolved cell retains its reason");
  // Actual engine results ride in the shared projected envelope.
  assert.ok(result.data.engine.requirements["2_4_0_csv_export"].judgmentCount > 0);
  assert.ok(result.data.engine.evidence.some((e) => e.url.includes("Community-2.4.0")));
  assert.ok(result.data.engine.usage.judgeCalls > 0);
  assert.ok(runtime.world.httpLog.length > 0, "acquisition ran through the real engine bridge");
  assert.match(result.data.resultSha256, /^[0-9a-f]{64}$/);
});

// --- acceptance case 2: explicit refutation vs silence --------------------

test("explicit same-scope refutation refutes; silence stays unresolved", async () => {
  const { result } = await run(COMPARISON, {
    docs: [DOC("Community", "2.5.0", "does not support")],
  });
  const cells = result.data.cells;
  assert.equal(cells["2_5_0_csv_export"].outcome, "refuted");
  assert.equal(cells["2_5_0_csv_export"].value, "refuted");
  assert.ok(cells["2_5_0_csv_export"].evidenceIds.length > 0);
  assert.equal(cells["2_4_0_csv_export"].outcome, "unresolved");
  assert.ok(cells["2_4_0_csv_export"].reason);
  assert.equal(result.data.status, "partial");
});

// --- acceptance case 3: conflict and budget -------------------------------

test("opposing same-scope evidence reports disputed", async () => {
  const { result } = await run(COMPARISON, {
    docs: [
      DOC("Community", "2.4.0", "supports"),
      DOC("Community", "2.4.0", "does not support"),
      DOC("Community", "2.5.0", "supports"),
    ],
  });
  const cells = result.data.cells;
  assert.equal(cells["2_4_0_csv_export"].outcome, "disputed");
  // Both sides are retained as evidence for the disputed cell.
  assert.ok(cells["2_4_0_csv_export"].evidenceIds.length >= 2);
  assert.equal(cells["2_5_0_csv_export"].outcome, "supported");
});

test("budget exhaustion retains rows and reasons", async () => {
  const { result } = await run(COMPARISON, {
    docs: [DOC("Community", "2.4.0", "supports"), DOC("Community", "2.5.0", "supports")],
    limits: { maxSearchAttempts: 1, maxUniqueReads: 1, maxJudgeAttempts: 4 },
  });
  assert.equal(result.data.status, "partial");
  assert.equal(result.exitCode, 1);
  for (const key of ["2_4_0_csv_export", "2_5_0_csv_export"]) {
    const cell = result.data.cells[key];
    assert.ok(cell, `row ${key} retained under budget exhaustion`);
    assert.ok(cell.reason, `row ${key} retains its reason`);
    assert.ok(["unresolved", "supported", "refuted", "disputed"].includes(cell.outcome));
  }
  assert.ok(result.data.engine.coverageNotes.length > 0 || result.data.engine.usage.searches <= 1);
});

// --- delivery ties: redaction, hash, counts, IDs (fix2) -------------------

test("delivered evidence is the shared redacted projection; nested and outer hashes both recompute; the executed question is the preflight snapshot", async () => {
  const docs = [
    { ...DOC("Community", "2.4.0", "supports"), content: `Token ${SECRET} ExampleApp Community 2.4.0 on Linux supports CSV export.` },
  ];
  // The secret rides in COMPARISON METADATA too — the layer this lane
  // redacts and hashes itself (the engine content is the shared layer's).
  const input = { ...COMPARISON, question: `Compare CSV export across two ExampleApp releases (${SECRET}).` };
  const { result } = await run(input, {
    docs,
    secrets: [SECRET],
    // The caller mutates its input DURING the run (inside the judge):
    // the delivered question must remain the validated preflight snapshot.
    judgeHook: () => { input.question = "MUTATED DURING RUN"; },
  });
  const engine = result.data.engine;
  const record = engine.evidence.find((e) => e.url.includes("Community-2.4.0"));
  assert.ok(record, "evidence record delivered");
  assert.equal(record.displayRedacted, true, "planted secret redacted in the delivered content");
  assert.ok(!record.content.includes(SECRET), "delivered content carries no secret");
  assert.notEqual(record.contentSha256, record.displayContentSha256, "original vs display digests differ");
  assert.equal(
    record.contentSha256,
    createHash("sha256").update(`Token ${SECRET} ExampleApp Community 2.4.0 on Linux supports CSV export.`, "utf8").digest("hex"),
    "original digest recomputes over the unredacted fixture content",
  );
  // Snapshot question: executed AND delivered forms are the preflight
  // value (redacted), never the mid-run mutation.
  assert.ok(!result.data.question.includes(SECRET), "comparison metadata redacted with the run's secret union");
  assert.ok(!result.data.question.includes("MUTATED"), "delivered question is the snapshot, not a mid-run mutation");
  assert.ok(!engine.question.includes("MUTATED"), "engine question is the snapshot too");
  // Nested hash: the engine envelope is embedded byte-for-byte — its own
  // resultSha256 still binds it inside my delivery.
  const { resultSha256: nestedHash, ...engineDelivered } = engine;
  assert.equal(nestedHash, createHash("sha256").update(JSON.stringify(engineDelivered), "utf8").digest("hex"), "nested engine hash preserved byte-for-byte");
  // Outer hash: resultSha256 binds the delivered matrix minus itself.
  const { resultSha256, ...delivered } = result.data;
  assert.equal(resultSha256, createHash("sha256").update(JSON.stringify(delivered), "utf8").digest("hex"));
  // The whole delivered form is secret-free (metadata + engine layers).
  assert.ok(!JSON.stringify(delivered).includes(SECRET), "no secret anywhere in the delivered matrix");
});

test("env-only credential is redacted from the ENTIRE serialized response (owned host basis)", async () => {
  const envOnly = "env-only-synthetic-credential-77";
  // The credential rides ONLY in the supplied host env (a configured
  // supplier slot), never in host.secrets. The captured basis rides an
  // invocation-OWNED host into the shared runtime, so the shared
  // projection redacts it in the NESTED engine envelope too — the whole
  // serialized response must be free of it, with the nested hash still
  // binding the delivered bytes.
  const { result } = await run(
    { ...COMPARISON, question: `Compare CSV export across two ExampleApp releases (${envOnly}).` },
    {
      docs: [DOC("Community", "2.4.0", "supports")],
      env: { ...ENV, EXA_API_KEY: envOnly },
    },
  );
  assert.ok(!result.data.question.includes(envOnly), "env-only credential redacted from comparison metadata");
  assert.ok(!JSON.stringify(result.data).includes(envOnly), "env-only credential absent from the ENTIRE serialized response");
  const { resultSha256: nestedHash, ...engineDelivered } = result.data.engine;
  assert.equal(nestedHash, createHash("sha256").update(JSON.stringify(engineDelivered), "utf8").digest("hex"), "nested engine hash preserved byte-for-byte");
});

test("mid-run env/secrets mutation (after the engine await began) cannot change the delivered basis", async () => {
  const envOnly = "capture-time-credential-42";
  const hostSecret = "host-secret-at-capture-13";
  const host = {
    env: { ...ENV, EXA_API_KEY: envOnly },
    provider: "tavily",
    noCache: true,
    cache: { get: async () => null, set: async () => {} },
    sleep: async () => {},
    random: () => 0,
    secrets: [hostSecret],
  };
  const base = makeRuntime({ docs: [DOC("Community", "2.4.0", "supports")] });
  const innerJudge = base.factory({ reserveAttempt: () => {} }).engineDeps.judge;
  const runtime = {
    factory: (context) => {
      const composed = base.factory(context);
      return {
        ...composed,
        engineDeps: {
          ...composed.engineDeps,
          // MID-RUN (inside a judge call, after acquisition started):
          // the caller rewrites the env and secrets objects it still
          // holds. The once-captured basis must decide the delivery.
          judge: async (judgeInput) => {
            delete host.env.EXA_API_KEY;
            host.env.LATE_INJECTED_KEY = "late-injected-value-99";
            host.secrets = ["rewritten-array"];
            return innerJudge(judgeInput);
          },
        },
      };
    },
  };
  const result = await runEvidenceComparison(
    { ...COMPARISON, question: `Compare CSV export (${envOnly}) (${hostSecret}).` },
    { ...THROWING_READS, now: () => 0, requirementsRuntime: runtime.factory, registerUserInterrupt: () => () => {} },
    host,
  );
  assert.ok(!JSON.stringify(result.data).includes(envOnly), "capture-time env credential stays redacted despite mid-run env removal");
  assert.ok(!JSON.stringify(result.data).includes(hostSecret), "capture-time host secret stays redacted despite mid-run secrets rewrite");
});

test("pattern-only identities (a secret matching generated id patterns) fail closed without echo", async () => {
  // "e1" matches the engine's generated evidence id pattern: delivery
  // (where evidence ids exist) must refuse statically.
  await assert.rejects(
    run(COMPARISON, { docs: [DOC("Community", "2.4.0", "supports")], env: { ...ENV, EXA_API_KEY: "e1" } }),
    (error) =>
      error.code === "VALIDATION_ERROR" &&
      /not publishable under the run's secret basis/.test(error.message) &&
      !error.message.includes("e1"),
  );
  // "2" matches the slugged cell keys themselves: the PREFLIGHT screen
  // refuses before any composition or HTTP.
  const runtime = makeRuntime({ docs: [] });
  await assert.rejects(
    runEvidenceComparison(
      COMPARISON,
      { ...THROWING_READS, now: () => 0, requirementsRuntime: runtime.factory, registerUserInterrupt: () => () => {} },
      { env: { ...ENV, EXA_API_KEY: "2" }, provider: "tavily", noCache: true, cache: { get: async () => null, set: async () => {} }, sleep: async () => {}, random: () => 0 },
    ),
    (error) =>
      error.code === "VALIDATION_ERROR" &&
      /not publishable under the run's secret basis/.test(error.message) &&
      error.message !== undefined && !error.message.includes("2_4_0"),
  );
  assert.equal(runtime.composedCount(), 0, "pattern-only identity refused before composition");
  assert.equal(runtime.world.httpLog.length, 0);
});

test("validation diagnostics never echo secret-bearing caller strings", () => {
  // Duplicate entity whose label IS a secret: the diagnostic is redacted.
  assert.throws(
    () => expandComparison({ ...COMPARISON, entities: [SECRET, SECRET] }, [SECRET]),
    (error) => error.code === "VALIDATION_ERROR" && /duplicate entity/.test(error.message) && !error.message.includes(SECRET),
  );
  // Unsupported top-level key NAMED after a secret: also redacted.
  assert.throws(
    () => expandComparison({ ...COMPARISON, [SECRET]: true }, [SECRET]),
    (error) => error.code === "VALIDATION_ERROR" && /unsupported keys/.test(error.message) && !error.message.includes(SECRET),
  );
});

test("joinServeProvenance refuses a duplicate evidenceId join instead of overwriting", () => {
  const record = {
    url: "https://offline.test/a",
    finalUrl: "https://offline.test/a",
    provider: "tavily",
    fromCache: false,
    cacheProbeWarm: "unknown",
    servedAt: 0,
  };
  const result = {
    evidence: [{ evidenceId: "e1", url: record.url, title: "t", content: "c", byteLength: 1, origins: [] }],
  };
  const joined = joinServeProvenance(result, [record]);
  assert.deepEqual(Object.keys(joined), ["e1"]);
  assert.throws(
    () => joinServeProvenance(result, [record, { ...record, servedAt: 1 }]),
    (error) => error.code === "VALIDATION_ERROR" && /collided on one evidence id/.test(error.message),
  );
});

test("display integrity gate fails closed on stale or malformed shared display digests", async () => {
  const { result } = await run(COMPARISON, { docs: [DOC("Community", "2.4.0", "supports")] });
  const engine = result.data.engine;
  // The real delivered envelope verifies.
  assert.doesNotThrow(() => verifyEngineDisplayIntegrity(engine));
  // A tampered display digest refuses statically (no content echo).
  const tampered = structuredClone(engine);
  tampered.evidence[0].displayContentSha256 = "0".repeat(64);
  assert.throws(
    () => verifyEngineDisplayIntegrity(tampered),
    (error) => error.code === "VALIDATION_ERROR" && /display digest or byte length is inconsistent/.test(error.message),
  );
  // A stale byte length refuses too.
  const staleBytes = structuredClone(engine);
  staleBytes.evidence[0].displayByteLength = staleBytes.evidence[0].displayByteLength + 1;
  assert.throws(() => verifyEngineDisplayIntegrity(staleBytes), /inconsistent/);
  // Malformed record shape refuses without echoing content.
  assert.throws(
    () => verifyEngineDisplayIntegrity({ evidence: [{ url: "u" }] }),
    /lacks display digest\/length fields/,
  );
});

test("credential-shaped identifiers are rejected under the EXISTING redactor semantics with an EMPTY matching basis", async () => {
  // No secret list matches this label — only the redactor's credential
  // PATTERN does (scheme + 8+ credential-bearing chars). The preflight
  // screen must reject it with a static, echo-free error and zero
  // runtime composition.
  const shaped = "Token 9f1aZx9vQw2e";
  const runtime = makeRuntime({ docs: [] });
  await assert.rejects(
    runEvidenceComparison(
      { ...COMPARISON, entities: [shaped, "2.5.0"] },
      { ...THROWING_READS, now: () => 0, requirementsRuntime: runtime.factory, registerUserInterrupt: () => () => {} },
      { env: { ...ENV }, provider: "tavily", noCache: true, cache: { get: async () => null, set: async () => {} }, sleep: async () => {}, random: () => 0 },
    ),
    (error) =>
      error.code === "VALIDATION_ERROR" &&
      /not publishable under the run's secret basis/.test(error.message) &&
      !error.message.includes(shaped),
  );
  assert.equal(runtime.composedCount(), 0, "credential-shaped identifier refused before composition");
  assert.equal(runtime.world.httpLog.length, 0);
  // A credential-shaped FRAME KEY is rejected the same way.
  await assert.rejects(
    runEvidenceComparison(
      { ...COMPARISON, frame: { ...COMPARISON.frame, [shaped]: "x" } },
      { ...THROWING_READS, now: () => 0, requirementsRuntime: makeRuntime({ docs: [] }).factory, registerUserInterrupt: () => () => {} },
      { env: { ...ENV }, provider: "tavily", noCache: true, cache: { get: async () => null, set: async () => {} }, sleep: async () => {}, random: () => 0 },
    ),
    (error) => error.code === "VALIDATION_ERROR" && /frame key is not publishable/.test(error.message) && !error.message.includes(shaped),
  );
});

test("compiler diagnostics are sanitized: an invalid enum that IS a secret never echoes", async () => {
  // The synthetic token rides as an enum value (not in the classification
  // vocabulary) AND in the host basis: the engine compiler's rejection
  // would echo it — the lane must sanitize the outward message/help with
  // the captured basis while keeping the typed code, and no runtime may
  // compose.
  const runtime = makeRuntime({ docs: [] });
  await assert.rejects(
    runEvidenceComparison(
      {
        ...COMPARISON,
        dimensions: { csv_export: { question: "Q {entity}?", schema: { enum: ["supported", SECRET] } } },
      },
      { ...THROWING_READS, now: () => 0, requirementsRuntime: runtime.factory, registerUserInterrupt: () => () => {} },
      { env: { ...ENV }, provider: "tavily", noCache: true, cache: { get: async () => null, set: async () => {} }, sleep: async () => {}, random: () => 0, secrets: [SECRET] },
    ),
    (error) =>
      error.code === "VALIDATION_ERROR" &&
      error.exitCode !== 130 &&
      !error.message.includes(SECRET) &&
      (error.help === undefined || !error.help.includes(SECRET)),
  );
  assert.equal(runtime.composedCount(), 0, "invalid enum refused before composition");
  assert.equal(runtime.world.httpLog.length, 0);
});

test("a cell key the shared OBJECT-KEY redaction would clobber is refused preflight with an empty basis", async () => {
  // entity "api" × dimension "key" slugs to "api_key" — a CREDENTIAL_KEYS
  // name. No secret list is involved: the shared redactor's object pass
  // replaces the VALUE under such a key, so delivering it would clobber
  // the cell row at any output boundary. Preflight must refuse with a
  // static, echo-free error, zero composition/dispatch.
  const runtime = makeRuntime({ docs: [] });
  await assert.rejects(
    runEvidenceComparison(
      {
        ...COMPARISON,
        entities: ["api"],
        dimensions: { key: { question: "Does {entity} carry the credential field?" } },
      },
      { ...THROWING_READS, now: () => 0, requirementsRuntime: runtime.factory, registerUserInterrupt: () => () => {} },
      { env: { ...ENV }, provider: "tavily", noCache: true, cache: { get: async () => null, set: async () => {} }, sleep: async () => {}, random: () => 0 },
    ),
    (error) =>
      error.code === "VALIDATION_ERROR" &&
      /object-key redaction semantics would replace its value/.test(error.message) &&
      !error.message.includes("api_key"),
  );
  assert.equal(runtime.composedCount(), 0, "clobberable key refused before composition");
  assert.equal(runtime.world.httpLog.length, 0);
  // Same rule for an "access_token"-shaped key.
  await assert.rejects(
    runEvidenceComparison(
      {
        ...COMPARISON,
        entities: ["access"],
        dimensions: { token: { question: "Does {entity} carry the credential field?" } },
      },
      { ...THROWING_READS, now: () => 0, requirementsRuntime: makeRuntime({ docs: [] }).factory, registerUserInterrupt: () => () => {} },
      { env: { ...ENV }, provider: "tavily", noCache: true, cache: { get: async () => null, set: async () => {} }, sleep: async () => {}, random: () => 0 },
    ),
    (error) => error.code === "VALIDATION_ERROR" && /object-key redaction semantics would replace its value/.test(error.message),
  );
});

test("safe keys are unchanged by the object-key stability screen (positive control)", async () => {
  const { result } = await run(COMPARISON, { docs: [DOC("Community", "2.4.0", "supports")] });
  assert.equal(result.data.cells["2_4_0_csv_export"].outcome, "supported");
  assert.deepEqual(Object.keys(result.data.cells), ["2_4_0_csv_export", "2_5_0_csv_export"]);
});

test("a secret occurring in an output identifier is a static rejection that never echoes it", async () => {
  const label = `release-${SECRET}`;
  await assert.rejects(
    run({ ...COMPARISON, entities: [label, "2.5.0"] }, { docs: [], secrets: [SECRET] }),
    (error) =>
      error.code === "VALIDATION_ERROR" &&
      error.exitCode !== 130 &&
      /not publishable under the run's secret basis/.test(error.message) &&
      !error.message.includes(SECRET),
  );
  await assert.rejects(
    run({ ...COMPARISON, frame: { ...COMPARISON.frame, [SECRET]: "x" } }, { docs: [], secrets: [SECRET] }),
    (error) => error.code === "VALIDATION_ERROR" && /not publishable under the run's secret basis/.test(error.message) && !error.message.includes(SECRET),
  );
});

test("physical accounting matches observed dispatches; admission is shared; Reader provenance retained", async () => {
  const { result, runtime } = await run(COMPARISON, {
    docs: [DOC("Community", "2.4.0", "supports"), DOC("Community", "2.5.0", "supports")],
  });
  const engine = result.data.engine;
  assert.equal(engine.usage.physicalHttpAttempts, runtime.world.httpLog.length, "every fake HTTP dispatch is counted, no more, no less");
  assert.equal(engine.admission.acquisition, "shared");
  assert.ok(Array.isArray(engine.acquisition.readProvenance) && engine.acquisition.readProvenance.length > 0, "Reader provenance retained");
  assert.ok(Number.isFinite(engine.acquisition.reservationsRefused));
});

test("Reader serve provenance carries the FULL record keyed by original evidenceId; two DISTINCT secrets colliding after URL redaction never collapse it", async () => {
  const SECRET_A = "two-secret-collision-A-51";
  const SECRET_B = "two-secret-collision-B-52";
  // Two documents whose URLs differ by TWO DIFFERENT secrets: each
  // redacts to the same marker, so the DISPLAYED URLs are identical —
  // the evidenceId-keyed join must still carry both FULL records
  // distinctly (url, finalUrl, provider, fromCache, cacheProbeWarm,
  // servedAt).
  const docs = [
    { ...DOC("Community", "2.4.0", "supports"), url: `https://offline.test/doc-${SECRET_A}/a` },
    { ...DOC("Community", "2.5.0", "supports"), url: `https://offline.test/doc-${SECRET_B}/a` },
  ];
  const { result } = await run(COMPARISON, { docs, secrets: [SECRET_A, SECRET_B] });
  const provenance = result.data.evidenceProvenance;
  const ids = Object.keys(provenance);
  assert.equal(ids.length, 2, "both retained evidence records carry serve provenance");
  assert.equal(new Set(ids).size, 2, "distinct evidenceIds — no collapse after distinct-secret URL redaction");
  const displayedUrls = new Set();
  for (const id of ids) {
    assert.match(id, /^e\d+$/);
    const record = provenance[id];
    assert.ok(!record.url.includes(SECRET_A) && !record.url.includes(SECRET_B), "provenance URL redacted as metadata");
    assert.ok(!record.finalUrl.includes(SECRET_A) && !record.finalUrl.includes(SECRET_B), "finalUrl redacted as metadata");
    assert.equal(record.provider, "tavily");
    assert.equal(typeof record.fromCache, "boolean");
    assert.ok(typeof record.cacheProbeWarm === "boolean" || record.cacheProbeWarm === "unknown");
    assert.equal(typeof record.servedAt, "number");
    displayedUrls.add(record.url);
  }
  assert.equal(displayedUrls.size, 1, "the two original URLs collapse to ONE displayed form after redaction");
  // The joined ids are exactly the retained evidence ids.
  const delivered = new Set(result.data.engine.evidence.map((e) => e.evidenceId));
  assert.deepEqual([...ids].sort(), [...delivered].sort());
});

test("repeat-marker display: adjacent redactions verify through the integrity gate", async () => {
  // The secret occurs TWICE ADJACENTLY in one document's content: the
  // delivered display carries two adjacent markers, and the display
  // digest/length gate verifies the delivered bytes (a stale or corrupt
  // display projection would fail closed).
  const docs = [
    {
      ...DOC("Community", "2.4.0", "supports"),
      content: `Token ${SECRET} ${SECRET} ExampleApp Community 2.4.0 on Linux supports CSV export.`,
    },
  ];
  const { result } = await run(COMPARISON, { docs, secrets: [SECRET] });
  const record = result.data.engine.evidence.find((e) => e.url.includes("Community-2.4.0"));
  assert.ok(record, "evidence delivered");
  assert.ok(record.content.includes("[REDACTED]"), "marker present in display");
  assert.ok(!record.content.includes(SECRET), "secret absent from display");
  assert.equal(record.displayRedacted, true);
  // The gate itself re-verifies the delivered bytes end-to-end.
  assert.doesNotThrow(() => verifyEngineDisplayIntegrity(result.data.engine));
});

test("cell evidence references resolve into the delivered evidence set", async () => {
  const { result } = await run(COMPARISON, {
    docs: [DOC("Community", "2.4.0", "supports"), DOC("Community", "2.5.0", "does not support")],
  });
  const delivered = new Set(result.data.engine.evidence.map((e) => e.evidenceId));
  for (const [key, cell] of Object.entries(result.data.cells)) {
    for (const id of cell.evidenceIds) {
      assert.ok(delivered.has(id), `cell ${key} references delivered evidence ${id}`);
    }
  }
});

// --- cancellation (fix2: no whole-run race; shared setup races; entered
//     work keeps its settled ledger) ----------------------------------------

test("a pre-aborted signal settles 130 before any expansion leak, composition or HTTP", async () => {
  const runtime = makeRuntime({ docs: [DOC("Community", "2.4.0", "supports")] });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    runEvidenceComparison(
      COMPARISON,
      { ...THROWING_READS, now: () => 0, requirementsRuntime: runtime.factory, registerUserInterrupt: () => () => {} },
      { env: { ...ENV }, provider: "tavily", noCache: true, cache: { get: async () => null, set: async () => {} }, sleep: async () => {}, random: () => 0 },
      controller.signal,
    ),
    (error) => error.code === "VALIDATION_ERROR" && error.exitCode === 130 && /interrupted before any work/.test(error.message),
  );
  assert.equal(runtime.composedCount(), 0);
  assert.equal(runtime.world.httpLog.length, 0);
});

test("a real stalled quota read cancelled by the signal settles the shared 130 before composition", async () => {
  const runtime = makeRuntime({ docs: [DOC("Community", "2.4.0", "supports")] });
  const controller = new AbortController();
  const attempt = runEvidenceComparison(
    COMPARISON,
    { ...THROWING_READS, now: () => 0, requirementsRuntime: runtime.factory, registerUserInterrupt: () => () => {} },
    {
      env: { ...ENV },
      provider: "tavily",
      noCache: true,
      cache: { get: async () => null, set: async () => {} },
      sleep: async () => {},
      random: () => 0,
      readQuotaSnapshot: () => new Promise(() => {}),
    },
    controller.signal,
  );
  await Promise.resolve();
  controller.abort();
  await assert.rejects(
    attempt,
    (error) => error.code === "VALIDATION_ERROR" && error.exitCode === 130,
  );
  assert.equal(runtime.composedCount(), 0, "quota read precedes composition; nothing composed");
  assert.equal(runtime.world.httpLog.length, 0);
});

test("an abort after dispatches were entered keeps the settled ledger and maps exit 130", async () => {
  const controller = new AbortController();
  const { result } = await run(COMPARISON, {
    docs: [DOC("Community", "2.4.0", "supports"), DOC("Community", "2.5.0", "supports")],
    signal: controller.signal,
    onHttp: (count) => { if (count === 4) controller.abort(); },
  });
  assert.equal(result.exitCode, 130, "entered cancelled run maps to 130");
  assert.equal(result.data.status, "partial");
  assert.ok(result.data.engine.evidence.length >= 1, "retained evidence is DELIVERED, not discarded");
  assert.ok(result.data.engine.usage.physicalHttpAttempts >= 1, "accounting preserved");
  assert.ok(result.data.cells["2_4_0_csv_export"], "cells present for the entered run");
});

test("an unrelated setup error surfaces as itself, never masked as 130", async () => {
  const runtime = makeRuntime({
    docs: [],
    factoryOverride: () => { throw new Error("boom: unrelated setup failure"); },
  });
  await assert.rejects(
    runEvidenceComparison(
      COMPARISON,
      { ...THROWING_READS, now: () => 0, requirementsRuntime: runtime.factory, registerUserInterrupt: () => () => {} },
      { env: { ...ENV }, provider: "tavily", noCache: true, cache: { get: async () => null, set: async () => {} }, sleep: async () => {}, random: () => 0 },
    ),
    (error) => error.message === "boom: unrelated setup failure",
  );
});

// --- integration honesty: no fabricated engine delivery ------------------

test("comparison without a semantic judge leaves cells unresolved, never guessed", async () => {
  const runtime = makeRuntime({ docs: [DOC("Community", "2.4.0", "supports")], withJudge: false });
  const result = await runEvidenceComparison(
    COMPARISON,
    { ...THROWING_READS, now: () => 0, requirementsRuntime: runtime.factory, registerUserInterrupt: () => () => {} },
    { env: { ...ENV }, provider: "tavily", noCache: true, cache: { get: async () => null, set: async () => {} }, sleep: async () => {}, random: () => 0 },
  );
  assert.equal(result.data.assessment, "deterministic-only");
  assert.equal(result.data.cells["2_4_0_csv_export"].outcome, "unresolved");
  assert.equal(result.data.cells["2_5_0_csv_export"].outcome, "unresolved");
});
