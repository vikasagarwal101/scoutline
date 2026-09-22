/**
 * T3 — `investigate --verify` command mode branch + e2e
 * (investigate-verify lane; DESIGN D3/D6, PRD AC-1/AC-3/AC-5/AC-6/AC-7/
 * AC-8/AC-9).
 *
 * 100% hermetic: fixture search/reader descriptors, in-memory cache,
 * counting consumption sink, fixed clocks (the shipped
 * investigate-orchestrator.test.js pattern, fixtures adapted to the
 * verify grid).
 *
 * ---------------------------------------------------------------------------
 * Fixture grid + hand-computation. The 3-claim statement (splitClaims
 * determinism, T1):
 *
 *   A "Alpha reactors process data."      → sub-query verbatim
 *   B "Beta turbines never ship."         → carries "never" IN THE CLAIM
 *   C "Zebra metrics record nothing."    → unmatched terms
 *
 * Single arm "tavily", M = 1, so N×M = 3 searches. Fixture rows per
 * sub-query (rank = index+1, one row each, no clustering):
 *
 *   sub-query A → s1 ; sub-query B → s2 ; sub-query C → s3
 *
 * Reader contents (term-bearing sentences hand-marked):
 *   s1: "Alpha reactors process data cleanly. Filler without terms."
 *   s2: "Beta turbines never ship. Other unrelated text."
 *   s3: "Totally unrelated body text here."
 *
 * Expected verify block (matchClaimsToEvidence, T1 semantics):
 *   A → matches s1.p0 (alpha/reactors/process/data) — corroborated,
 *        0 cues, evidence [{0,0}]
 *   B → matches s2.p0 (beta/turbines/ship) — the SAME passage carries
 *        whole-word "never" → contradicted, 1 cue, evidence [{1,0}]
 *   C → no matching passage anywhere → unresolved, 0 cues, evidence []
 *
 * Cost: 3 claims × 1 arm = 3 billable searches + up to 3 sources
 * (default --sources 5 > 3 distinct rows, so K=3 reads) = 6 events.
 * ---------------------------------------------------------------------------
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { investigate, INVESTIGATE_LADDER } from "../dist/commands/investigate.js";
import { decodeInvestigationPack } from "../dist/capabilities/investigation.js";
import { createInMemoryConsumptionSink } from "../dist/lib/consumption.js";
import { ValidationError } from "../dist/lib/errors.js";

const URLS = { s1: "https://e/s1", s2: "https://e/s2", s3: "https://e/s3" };

const STATEMENT =
  "Alpha reactors process data. " +
  "Beta turbines never ship. " +
  "Zebra metrics record nothing.";

function makeSearchDescriptor(id, resultsByQuery) {
  const invokes = [];
  const descriptor = {
    id,
    isConfigured: () => true,
    capabilities: () => new Set(["search"]),
    create: () => ({
      id,
      search: {
        validate() {},
        cacheIdentity(request) {
          return {
            provider: id,
            capability: "search",
            credentialFingerprint: "fp-" + id,
            request,
            legacyCandidates: [],
          };
        },
        async invoke(request) {
          invokes.push(request.query);
          return resultsByQuery[request.query] ?? [];
        },
      },
    }),
  };
  return { descriptor, invokes };
}

function makeReaderDescriptor(id, results = {}) {
  const invokes = [];
  const descriptor = {
    id,
    isConfigured: () => true,
    capabilities: () => new Set(["reader"]),
    create: () => ({
      id,
      reader: {
        fetch: {
          kind: "reader-fetch",
          validate() {},
          cacheIdentity(request) {
            return {
              provider: id,
              capability: "reader",
              operation: "reader-fetch",
              credentialFingerprint: "fp-" + id,
              request,
              legacyCandidates: [],
            };
          },
          decodeCached(value) {
            return value === null || typeof value !== "object" ? null : value;
          },
          async invoke(request) {
            invokes.push(request.url);
            const canned = results[request.url];
            if (canned === undefined) throw new Error("no canned result");
            return {
              schemaVersion: 1,
              url: request.url,
              finalUrl: request.url,
              title: "Page " + request.url,
              content: canned.content,
              contentFormat: "markdown",
            };
          },
        },
      },
    }),
  };
  return { descriptor, invokes };
}

const CLAIM_A = "Alpha reactors process data.";
const CLAIM_B = "Beta turbines never ship.";
const CLAIM_C = "Zebra metrics record nothing.";

function verifyDeps() {
  const search = makeSearchDescriptor("tavily", {
    [CLAIM_A]: [{ title: "s1 page", url: URLS.s1, summary: "s1" }],
    [CLAIM_B]: [{ title: "s2 page", url: URLS.s2, summary: "s2" }],
    [CLAIM_C]: [{ title: "s3 page", url: URLS.s3, summary: "s3" }],
  });
  const reader = makeReaderDescriptor("zai", {
    [URLS.s1]: { content: "Alpha reactors process data cleanly. Filler without terms." },
    [URLS.s2]: { content: "Beta turbines never ship. Other unrelated text." },
    [URLS.s3]: { content: "Totally unrelated body text here." },
  });
  const store = new Map();
  const sink = createInMemoryConsumptionSink();
  const deps = {
    descriptors: [search.descriptor, reader.descriptor],
    env: {},
    configFanout: false,
    cache: {
      async get(key) {
        return store.has(key) ? store.get(key) : null;
      },
      async set(key, value) {
        store.set(key, value);
      },
    },
    sleep: async () => {},
    random: () => 0.5,
    consume: sink,
    now: () => 1_700_000_000_000,
    nowWall: () => new Date(1_700_000_000_000),
    loadContextText: async () => {
      throw new Error("no --context in verify mode");
    },
    readerCapabilityFor: (d) => d.create({ env: {} }).reader,
  };
  return { deps, sink, search, reader };
}

function makeContext() {
  const notices = [];
  return {
    context: { stdinIsTTY: false, readStdin: async () => "", notice: (m) => notices.push(m) },
    notices,
  };
}

const VOPTIONS = { provider: "tavily", verify: true };

// ---------------------------------------------------------------------------
// 1. Fixture e2e — the hand-computed verify block
// ---------------------------------------------------------------------------

describe("investigate --verify: fixture e2e (3 claims × 1 arm)", () => {
  it("pack carries the hand-computed verify block; question/subQueries are the claim grid", async () => {
    const { deps, sink } = verifyDeps();
    const { context, notices } = makeContext();
    const result = await investigate(STATEMENT, VOPTIONS, deps, context);

    assert.strictEqual(result.kind, "data");
    const pack = result.data;
    assert.strictEqual(pack.schemaVersion, 1);
    assert.strictEqual(pack.question, STATEMENT);
    // One sub-query per claim, VERBATIM — statement not prepended.
    assert.deepEqual(pack.subQueries, [CLAIM_A, CLAIM_B, CLAIM_C]);
    // Hand-computed verify block (fixture header).
    assert.deepEqual(pack.verify, {
      statement: STATEMENT,
      claims: [
        { text: CLAIM_A, verdict: "corroborated", negationCues: 0, evidence: [{ sourceIndex: 0, passageIndex: 0 }] },
        { text: CLAIM_B, verdict: "contradicted", negationCues: 1, evidence: [{ sourceIndex: 1, passageIndex: 0 }] },
        { text: CLAIM_C, verdict: "unresolved", negationCues: 0, evidence: [] },
      ],
    });
    // The verify-bearing pack still decodes (the T2 branch round-trip).
    assert.notEqual(decodeInvestigationPack(pack), null);
    // Cost notice in the CLAIM form (PRD-3): N claims × M arms.
    assert.ok(
      notices.includes(
        "investigate: 3 claims × 1 arms = 3 billable searches + up to 5 sources (per-source supplier attempts apply)",
      ),
      `expected claim-form cost notice, got: ${JSON.stringify(notices)}`,
    );
    // Linearity: N×M + K = 3×1 + 3 = 6.
    assert.strictEqual(sink.events.length, 6);
    assert.strictEqual(sink.events.filter((e) => e.capabilityId === "search").length, 3);
    assert.strictEqual(sink.events.filter((e) => e.capabilityId === "reader").length, 3);
    // Coverage: 3 sub-queries (the claim count), 1 arm, 3 read.
    assert.strictEqual(pack.coverage.subQueries, 3);
    assert.strictEqual(pack.coverage.armsUsed, 1);
    assert.strictEqual(pack.coverage.sourcesRead, 3);
  });

  it("grid terms come from the claims (extraction still surfaces passages)", async () => {
    const { deps } = verifyDeps();
    const result = await investigate(STATEMENT, VOPTIONS, deps, makeContext().context);
    const pack = result.data;
    assert.strictEqual(pack.sources.length, 3);
    const s1 = pack.sources.find((s) => s.url === URLS.s1);
    assert.deepEqual(s1.passages.map((p) => p.quote), ["Alpha reactors process data cleanly."]);
    const s3 = pack.sources.find((s) => s.url === URLS.s3);
    assert.deepEqual(s3.passages, []);
  });

  it("deterministic: two cold runs byte-identical", async () => {
    const run = () => {
      const { deps } = verifyDeps();
      return investigate(STATEMENT, VOPTIONS, deps, makeContext().context);
    };
    const a = await run();
    const b = await run();
    assert.strictEqual(JSON.stringify(b.data), JSON.stringify(a.data));
  });
});

// ---------------------------------------------------------------------------
// 2. Cap + sad-statement validation (fail-loud, never truncate)
// ---------------------------------------------------------------------------

describe("investigate --verify: claim cap + zero-valid-claims (fail-loud)", () => {
  function nineClaimStatement() {
    return Array.from({ length: 9 }, (_, i) => `Claim number ${i} states facts.`).join(" ");
  }
  function eightClaimStatement() {
    return Array.from({ length: 8 }, (_, i) => `Claim number ${i} states facts.`).join(" ");
  }

  it("> 8 claims → VALIDATION_ERROR naming the cap (9 claims)", async () => {
    const { deps } = verifyDeps();
    await assert.rejects(
      () => investigate(nineClaimStatement(), VOPTIONS, deps, makeContext().context),
      (error) =>
        error instanceof ValidationError && /8/.test(error.message) && /claim/i.test(error.message),
    );
  });

  it("exactly 8 claims passes the boundary", async () => {
    const { deps, sink } = verifyDeps();
    const statement = eightClaimStatement();
    const result = await investigate(statement, VOPTIONS, deps, makeContext().context);
    assert.strictEqual(result.kind, "data");
    assert.strictEqual(result.data.verify.claims.length, 8);
    // 8 claims × 1 arm = 8 searches; 3 distinct rows (fixture caps at 3
    // sub-query rows) + 3 reads = 11.
    assert.strictEqual(sink.events.filter((e) => e.capabilityId === "search").length, 8);
  });

  it("a statement that splits to ZERO valid claims → VALIDATION_ERROR", async () => {
    const { deps } = verifyDeps();
    // Newlines alone: each `\n` ends an empty window; the trailing
    // whitespace-only window drops. ("." would be a claim — a bare
    // terminator char is non-empty text.)
    await assert.rejects(
      () => investigate(" \n \n\t  ", VOPTIONS, deps, makeContext().context),
      (error) => error instanceof ValidationError,
    );
  });

  it("cap off-by-one mutation pin: an 8-cap would reject the exactly-8 statement", async () => {
    // The boundary row above REDs under `claims.length > 7`; this row
    // documents the mutation contract (9 fails, 8 passes — no fencepost).
    const { deps } = verifyDeps();
    const statement = eightClaimStatement();
    const result = await investigate(statement, VOPTIONS, deps, makeContext().context);
    assert.strictEqual(result.data.verify.claims.length, 8);
  });
});

// ---------------------------------------------------------------------------
// 3. `|` literal + planner bypass
// ---------------------------------------------------------------------------

describe("investigate --verify: pipe literal, planner never invoked", () => {
  it("`|` in a statement is literal claim text — never a sub-query split", async () => {
    const { deps, search } = verifyDeps();
    const statement = "Alpha reactors process data. Pipe | stays literal here.";
    const result = await investigate(statement, { provider: "tavily", verify: true }, deps, makeContext().context);
    const pack = result.data;
    assert.deepEqual(pack.subQueries, [
      "Alpha reactors process data.",
      "Pipe | stays literal here.",
    ]);
    // The grid ran the two VERBATIM claim sub-queries — the pipe
    // fragment was never split into "Pipe " + " stays literal here.".
    assert.ok(search.invokes.includes("Pipe | stays literal here."));
    assert.ok(!search.invokes.includes("Pipe "));
  });
});

// ---------------------------------------------------------------------------
// 4. --synthesize composes (additive-only pin re-run in verify mode)
// ---------------------------------------------------------------------------

describe("investigate --verify: --synthesize composes", () => {
  it("brief attaches AFTER the verify block — additive only, never replaces", async () => {
    const { deps } = verifyDeps();
    const calls = [];
    const depsWithSynth = {
      ...deps,
      synthesize: async (prompt) => {
        calls.push(prompt);
        return "VERIFY BRIEF";
      },
    };
    const result = await investigate(
      STATEMENT,
      { ...VOPTIONS, synthesize: true },
      depsWithSynth,
      makeContext().context,
    );
    const pack = result.data;
    assert.strictEqual(pack.brief, "VERIFY BRIEF");
    // The verify block is untouched; brief is the LAST key.
    assert.deepEqual(pack.verify.claims.map((c) => c.verdict), [
      "corroborated",
      "contradicted",
      "unresolved",
    ]);
    const keys = Object.keys(pack);
    assert.strictEqual(keys[keys.length - 1], "brief");
    // The synthesis prompt carries the statement as the question.
    assert.strictEqual(calls[0].question, STATEMENT);
    assert.deepEqual(calls[0].subQueries, [CLAIM_A, CLAIM_B, CLAIM_C]);
  });

  it("--synthesize without a dep still fails loud in verify mode", async () => {
    const { deps } = verifyDeps();
    await assert.rejects(
      () =>
        investigate(STATEMENT, { ...VOPTIONS, synthesize: true }, deps, makeContext().context),
      (error) => /no synthesis dep/.test(error.message),
    );
  });
});

// ---------------------------------------------------------------------------
// 5. Budget ladder extension (D6): passages trim → evidence pointers
//    drop (whole, late) → claim text/verdicts never cut
// ---------------------------------------------------------------------------

describe("investigate --verify: budget ladder extension", () => {
  function verifyPackFixture() {
    return {
      schemaVersion: 1,
      question: STATEMENT,
      subQueries: [CLAIM_A, CLAIM_B, CLAIM_C],
      sources: [
        {
          url: URLS.s1,
          finalUrl: URLS.s1,
          title: "s1",
          fetchedAt: "2026-09-21T00:00:00.000Z",
          provider: "tavily",
          contentFormat: "markdown",
          contentSha256: "0".repeat(64),
          passages: [
            { quote: "alpha " + "x".repeat(120), charRange: [0, 126] },
          ],
        },
        {
          url: URLS.s2,
          finalUrl: URLS.s2,
          title: "s2",
          fetchedAt: "2026-09-21T00:00:01.000Z",
          provider: "tavily",
          contentFormat: "markdown",
          contentSha256: "0".repeat(64),
          passages: [
            { quote: "beta " + "x".repeat(120), charRange: [0, 125] },
          ],
        },
      ],
      coverage: {
        subQueries: 3,
        armsUsed: 1,
        sourcesConsidered: 3,
        sourcesRead: 2,
        cacheHits: 0,
        unread: [{ url: URLS.s3, reason: "no-reader-supplier" }],
      },
      verify: {
        statement: STATEMENT,
        claims: [
          { text: CLAIM_A, verdict: "corroborated", negationCues: 0, evidence: [{ sourceIndex: 0, passageIndex: 0 }] },
          { text: CLAIM_B, verdict: "contradicted", negationCues: 1, evidence: [{ sourceIndex: 1, passageIndex: 0 }] },
          { text: CLAIM_C, verdict: "unresolved", negationCues: 0, evidence: [] },
        ],
      },
    };
  }

  it("gentle budget trims passages; verify survives whole (pointers intact)", async () => {
    const { applyBudget, measurePayload } = await import("../dist/lib/output-budget.js");
    const pack = verifyPackFixture();
    const full = measurePayload(pack);
    const gentle = applyBudget(pack, Math.floor(full * 0.9), INVESTIGATE_LADDER);
    // Passages trimmed (quotes halved) but the verify block is whole.
    assert.ok(gentle.projection.sources[0].passages[0].quote.length < 126);
    assert.deepEqual(gentle.projection.verify.claims[0].evidence, [
      { sourceIndex: 0, passageIndex: 0 },
    ]);
  });

  it("tighter budget drops evidence pointers WHOLE before ever cutting claim text/verdicts", async () => {
    const { applyBudget, measurePayload } = await import("../dist/lib/output-budget.js");
    const pack = verifyPackFixture();
    // A budget that only the pointer-drop can reach: full pack minus
    // one pointer's serialized size, plus stamp reserve slack.
    const withoutPointers = measurePayload({
      ...pack,
      verify: {
        ...pack.verify,
        claims: pack.verify.claims.map((c) => ({ ...c, evidence: [] })),
      },
    });
    const budget = withoutPointers + 200;
    const crushed = applyBudget(pack, budget, INVESTIGATE_LADDER);
    const claims = crushed.projection.verify.claims;
    // Claim text + verdicts + cue counts NEVER cut.
    assert.deepEqual(
      claims.map((c) => [c.text, c.verdict, c.negationCues]),
      [
        [CLAIM_A, "corroborated", 0],
        [CLAIM_B, "contradicted", 1],
        [CLAIM_C, "unresolved", 0],
      ],
    );
    // Pointers dropped WHOLE: every claim has [] or its full set —
    // never a partial list.
    for (const claim of claims) {
      const original = pack.verify.claims.find((c) => c.text === claim.text);
      assert.ok(
        claim.evidence.length === original.evidence.length || claim.evidence.length === 0,
        `pointer drop must be whole per claim: ${claim.text}`,
      );
    }
    // The never-cut skeleton survives.
    assert.equal(crushed.projection.verify.statement, STATEMENT);
    assert.equal(crushed.projection.question, STATEMENT);
  });

  it("the ladder prefers passage trims + source drops over pointer drops at gentle budgets", async () => {
    const { applyBudget, measurePayload } = await import("../dist/lib/output-budget.js");
    const pack = verifyPackFixture();
    // Level-1-style budget: passages trim, pointers intact.
    const full = measurePayload(pack);
    const medium = applyBudget(pack, Math.floor(full * 0.75), INVESTIGATE_LADDER);
    assert.ok(medium.projection.verify.claims.some((c) => c.evidence.length > 0));
  });

  // -------------------------------------------------------------------------
  // Fix round M1: dangling evidence pointers under --max-chars. The
  // source-drop rule runs BEFORE the pointer-drop rule, so a dropped
  // source index leaves claims pointing past the truncated sources
  // array (decode's isSafeIndex checks non-negative only — the
  // dangling pointer ships). The fix scrubs pointers at the dropped
  // index INSIDE the source-drop rule (no ladder reorder: question-
  // mode projection order stays byte-stable). Probe band below sweeps
  // the reviewer's 509–955 budgets.
  // -------------------------------------------------------------------------
  it("M1: every surviving claim's evidence dereferences cleanly across the 509–955 probe band (no pointer >= sources.length)", async () => {
    const { applyBudget } = await import("../dist/lib/output-budget.js");
    const pack = verifyPackFixture();
    for (let budget = 509; budget <= 955; budget += 7) {
      const { projection } = applyBudget(pack, budget, INVESTIGATE_LADDER);
      for (const claim of projection.verify.claims) {
        for (const pointer of claim.evidence) {
          assert.ok(
            pointer.sourceIndex < projection.sources.length,
            `budget ${budget}: claim "${claim.text}" carries dangling pointer ` +
              `${JSON.stringify(pointer)} into ${projection.sources.length} sources`,
          );
          const source = projection.sources[pointer.sourceIndex];
          assert.ok(
            pointer.passageIndex < source.passages.length,
            `budget ${budget}: passage pointer ${JSON.stringify(pointer)} past ` +
              `${source.url}'s ${source.passages.length} passages`,
          );
        }
      }
      // The never-cut invariant holds at every probe budget too.
      assert.deepEqual(
        projection.verify.claims.map((c) => [c.text, c.verdict]),
        [
          [CLAIM_A, "corroborated"],
          [CLAIM_B, "contradicted"],
          [CLAIM_C, "unresolved"],
        ],
        `budget ${budget}: claim text/verdicts never cut`,
      );
    }
  });

  it("M1: a scrubbed pointer set is whole-per-claim (never partial); verdict/cue count survive the scrub", async () => {
    const { applyBudget, measurePayload } = await import("../dist/lib/output-budget.js");
    const pack = verifyPackFixture();
    // A budget in the band where s2 (claim B's only evidence) drops:
    // claim B must end with [] (whole scrub), never a dangling [{1,0}].
    const oneSource = measurePayload({ ...pack, sources: pack.sources.slice(0, 1) });
    const { projection } = applyBudget(pack, oneSource + 100, INVESTIGATE_LADDER);
    if (projection.sources.length === 1) {
      const claimB = projection.verify.claims.find((c) => c.text === CLAIM_B);
      assert.deepEqual(claimB.evidence, [], "dropped source's pointers scrubbed whole");
      // The verdict + cue count ride the ORIGINAL match state (they
      // describe the evidence found, not the budgeted residue).
      assert.equal(claimB.verdict, "contradicted");
      assert.equal(claimB.negationCues, 1);
    } else {
      assert.fail(`probe budget did not reach the 1-source level: ${projection.sources.length}`);
    }
  });

  it("M1: question-mode A/B — pointer scrubbing changes nothing when no verify block rides the pack", async () => {
    const { applyBudget, measurePayload } = await import("../dist/lib/output-budget.js");
    const { verify: _verify, ...questionPack } = verifyPackFixture();
    void _verify;
    const full = measurePayload(questionPack);
    // Same band, no verify block: the projection must be IDENTICAL to
    // the shipped (pre-fix) question-mode shape — the scrub lives only
    // in the verify-bearing branch of the rule.
    for (const factor of [0.9, 0.75, 0.5]) {
      const { projection } = applyBudget(questionPack, Math.floor(full * factor), INVESTIGATE_LADDER);
      assert.ok(!("verify" in projection), "question pack stays verify-free");
      assert.ok(Array.isArray(projection.sources));
      assert.equal(projection.question, questionPack.question);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Question-mode A/B byte-identity (the non-interference pin)
// ---------------------------------------------------------------------------

describe("investigate: question mode byte-identity under the verify fork (A/B)", () => {
  it("the same fixtures without --verify produce the byte-identical shipped pack (no verify key)", async () => {
    // Re-run the shipped question-mode fixture grid (2×2 orchestrator
    // shape) with and WITHOUT any verify code path engaged — the pack
    // must carry no verify key and stay deterministic.
    const { deps } = verifyDeps();
    const result = await investigate(
      "alpha | beta",
      { provider: "tavily" },
      deps,
      makeContext().context,
    );
    const pack = result.data;
    assert.ok(!("verify" in pack), "question mode never carries a verify key");
    const again = await investigate(
      "alpha | beta",
      { provider: "tavily" },
      verifyDeps().deps,
      makeContext().context,
    );
    assert.strictEqual(JSON.stringify(again.data), JSON.stringify(pack));
  });
});
