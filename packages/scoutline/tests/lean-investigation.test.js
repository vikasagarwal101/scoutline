/**
 * Lean Investigation engine POC tests (branch poc/v3-lean-investigation;
 * plan doc docs/plans/v3/07-lean-investigation-contract.md §"Proof of
 * concept" checks 1–8).
 *
 * 100% offline: acquisition, judge and clock are fixtures. No network,
 * no user stores, no credentials.
 *
 * Fixture judge policy (encodes the JEV-CONTENT-ASSESSMENT observed
 * failure modes — keyword-stuffed docs are relevant=false and judge
 * nothing; clean statements are judged by their sentence):
 *   - a doc whose content is exactly repeated search keywords with no
 *     period sentence stating a feature → irrelevant;
 *   - a doc containing an explicit statement sentence ("ExampleApp 2.4.0
 *     supports …" / "… does not support …") → relevant + side flags;
 *   - both statements in one doc → supports AND refutes (explicit
 *     same-scope contradiction);
 *   - a verdict can be scripted to flip between judgments to simulate
 *     inconsistent model answers.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  runLeanInvestigation,
  compileLeanContract,
} from "../dist/lib/lean-investigation.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const SCOPE = { entity: "ExampleApp", release: "2.4.0" };

function baseContract(requirements, limits) {
  return {
    schemaVersion: 1,
    question: "Assess CSV and offline export support in ExampleApp 2.4.0.",
    scope: SCOPE,
    requirements,
    evidence: { criteria: ["Check relevant contrary evidence before accepting a result."] },
    ...(limits ? { limits } : {}),
  };
}

function enumField(question, extra = {}) {
  return { question, schema: { enum: ["supported", "refuted", "disputed"] }, required: true, ...extra };
}

/** A deterministic fixture judge over scripted per-doc verdicts. */
function createFixtureJudge() {
  const calls = [];
  /** @type {Map<string, {relevant:boolean, supportsClaim:boolean, refutesClaim:boolean}>} keyed by url prefix */
  const policies = new Map();
  const judge = {
    calls,
    policies,
    /** Script the verdict for every doc whose url contains `urlPart`. */
    setPolicy(urlPart, verdict) {
      policies.set(urlPart, verdict);
    },
    async judgeFn(input) {
      calls.push(input);
      const documents = input.documents.map((doc) => {
        for (const [urlPart, verdict] of policies) {
          if (doc.url.includes(urlPart)) return { evidenceId: doc.evidenceId, ...verdict };
        }
        // default: irrelevant (keyword-only fixture docs judge nothing)
        return { evidenceId: doc.evidenceId, relevant: false, supportsClaim: false, refutesClaim: false };
      });
      return { documents };
    },
  };
  return judge;
}

function depsWith({ searchResults, reads, judge, now }) {
  return {
    search: async (query) => {
      const hits = searchResults.filter((r) => r.queries.includes(query));
      return hits.map((r) => ({ url: r.url, title: r.url }));
    },
    read: async (url) => {
      const hit = reads[url];
      if (hit === undefined) throw new Error(`fixture read miss: ${url}`);
      return hit;
    },
    judge: judge === undefined ? null : judge,
    now: now ?? (() => 0),
  };
}

const CSV_Q = "Does ExampleApp 2.4.0 support CSV export?";
const OFFLINE_Q = "Does ExampleApp 2.4.0 support offline export?";

/** Support/refute sentence fixtures (clean statements, not keywords). */
const SUPPORT_CSV = "ExampleApp 2.4.0 supports CSV export from the reports screen.";
const REFUTE_CSV = "ExampleApp 2.4.0 does not support CSV export in any release.";
const KEYWORD_STUFFING = "csv export exampleapp 2.4.0 csv export exampleapp 2.4.0 csv export";

// ---------------------------------------------------------------------------
// Demonstration 1 — irrelevant first batch, decisive evidence later
// ---------------------------------------------------------------------------

describe("lean investigation D1: advances past irrelevant first results", () => {
  it("does not accept from keyword-stuffed batch 1; completes after later decisive doc", async () => {
    const judge = createFixtureJudge();
    judge.setPolicy("guide", { relevant: true, supportsClaim: true, refutesClaim: false });
    // The shared question surfaces junk first; the primary query surfaces
    // the guide third.
    const shared = [
      { url: "https://example.com/junk1", queries: ["Assess CSV and offline export support in ExampleApp 2.4.0."] },
      { url: "https://example.com/junk2", queries: ["Assess CSV and offline export support in ExampleApp 2.4.0."] },
    ];
    const contract = baseContract({ csv: enumField(CSV_Q) });
    const deps = depsWith({
      searchResults: [
        ...shared,
        { url: "https://example.com/guide", queries: [CSV_Q] },
      ],
      reads: {
        "https://example.com/junk1": KEYWORD_STUFFING,
        "https://example.com/junk2": "Unrelated product announcement text.",
        "https://example.com/guide": SUPPORT_CSV,
      },
      judge: judge.judgeFn,
    });
    const result = await runLeanInvestigation(contract, deps);

    assert.equal(result.requirements.csv.status, "satisfied");
    assert.equal(result.data.csv, "supported");
    assert.ok(result.requirements.csv.evidenceIds.includes("e3"), "guide is third retained doc");
    // No rereading: each url attempted exactly once (no read-retry for ok reads).
    const readKinds = result.acquisitionLog.filter((e) => e.kind === "read").map((e) => e.detail);
    assert.deepEqual(readKinds, [
      "https://example.com/junk1",
      "https://example.com/junk2",
      "https://example.com/guide",
    ]);
    // Field was judged more than once (evidence identity changed between
    // judgments) — progression, not single-shot.
    assert.ok(result.requirements.csv.judgmentCount >= 2);
  });
});

// ---------------------------------------------------------------------------
// Demonstration 2 — two fields, one acquisition, separate outcomes
// ---------------------------------------------------------------------------

describe("lean investigation D2: shared evidence, separate judgments", () => {
  it("one doc read once serves two fields with independent outcomes", async () => {
    const judge = createFixtureJudge();
    // One doc supports csv but explicitly refutes offline.
    judge.setPolicy("combo", {
      relevant: (url, doc, input) => true,
      supportsClaim: true,
      refutesClaim: false,
    });
    // Need doc- and field-sensitive verdicts: script per (url, field).
    const verdicts = new Map([
      ["combo|csv", { relevant: true, supportsClaim: true, refutesClaim: false }],
      ["combo|offline", { relevant: true, supportsClaim: false, refutesClaim: true }],
    ]);
    const judgeFn = async (input) => {
      const documents = input.documents.map((doc) => {
        const v = verdicts.get(`${doc.url.includes("combo") ? "combo" : "other"}|${input.fieldId}`);
        return { evidenceId: doc.evidenceId, ...(v ?? { relevant: false, supportsClaim: false, refutesClaim: false }) };
      });
      return { documents };
    };
    const comboDoc = `${SUPPORT_CSV} ExampleApp 2.4.0 does not support offline export; an internet connection is required.`;
    const deps = depsWith({
      searchResults: [{ url: "https://example.com/combo", queries: [CSV_Q, OFFLINE_Q] }],
      reads: { "https://example.com/combo": comboDoc },
      judge: judgeFn,
    });
    const result = await runLeanInvestigation(
      baseContract({ csv: enumField(CSV_Q), offline: enumField(OFFLINE_Q) }),
      deps,
    );

    assert.equal(result.data.csv, "supported");
    // Unified proof (Rev3 plan-aware ceilings): the default search
    // ceiling now serves every field's contrary round, so offline's
    // one-sided `refuted` accept completes its own counterevidence
    // round and finalizes. Starvation under lower ceilings stays
    // guarded by lean-investigation-regression's explicit
    // maxSearchAttempts:4 pin.
    assert.equal(result.requirements.offline.status, "satisfied");
    assert.equal(result.data.offline, "refuted");
    assert.equal(result.usage.readsRetained, 1, "single acquisition reused");
    assert.deepEqual(result.evidence.map((e) => e.url), ["https://example.com/combo"]);
    // Reuse cannot inflate read attempts or judge-side acquisitions: one
    // read attempt total, and each field judged independently over the
    // SAME doc identity.
    assert.equal(result.usage.readAttempts, 1);
  });
});

// ---------------------------------------------------------------------------
// Demonstration 3 — inconsistent judgments trigger new evidence
// ---------------------------------------------------------------------------

describe("lean investigation D3: inconsistent judge answers", () => {
  it("flipping one-sided accept clears it, acquires more, never rejudges identical input", async () => {
    // Doc A supports on first judgment, refutes on second (inconsistent
    // model answers). Doc B is a stable refutation.
    let csvJudgments = 0;
    const judgeFn = async (input) => {
      const documents = input.documents.map((doc) => {
        if (doc.url.includes("flaky")) {
          csvJudgments += 1;
          const supports = csvJudgments <= 1;
          return { evidenceId: doc.evidenceId, relevant: true, supportsClaim: supports, refutesClaim: !supports };
        }
        if (doc.url.includes("stable")) {
          return { evidenceId: doc.evidenceId, relevant: true, supportsClaim: false, refutesClaim: true };
        }
        return { evidenceId: doc.evidenceId, relevant: false, supportsClaim: false, refutesClaim: false };
      });
      return { documents };
    };
    const deps = depsWith({
      searchResults: [
        { url: "https://example.com/flaky", queries: ["Assess CSV and offline export support in ExampleApp 2.4.0."] },
        { url: "https://example.com/stable", queries: [CSV_Q] },
        { url: "https://example.com/extra", queries: [`${CSV_Q} contrary evidence refuted`] },
      ],
      reads: {
        "https://example.com/flaky": SUPPORT_CSV,
        "https://example.com/stable": REFUTE_CSV,
        "https://example.com/extra": "Neither confirmatory nor contrary statement.",
      },
      judge: judgeFn,
    });
    const result = await runLeanInvestigation(baseContract({ csv: enumField(CSV_Q) }), deps);

    const row = result.requirements.csv;
    assert.ok(row.inconsistentJudgments >= 1, "flip recorded");
    // Sol-review update (explicit defect-pin removal): this test
    // previously expected `satisfied/refuted` after the flipped tuple
    // was REPEATED — i.e. it pinned exactly the trusted-history
    // poisoning defect (a rejected judgment overwriting the baseline,
    // then its repetition reading as "stable"). With history written
    // only by accepted judgments, the repeated flip is STILL a flip
    // against the last trusted verdict: rejected again, no acceptance,
    // field ends unresolved/inconsistent_judgments. Genuine refuted
    // acceptance is covered by the independent suites' controls.
    assert.equal(row.status, "unresolved");
    assert.equal(row.reason, "inconsistent_judgments");
    assert.equal(result.data.csv, undefined);
    // Identical judge input never reissued: every judged call had a
    // distinct evidence identity key.
    const judgedKeys = result.acquisitionLog.filter((e) => e.kind === "judge").map((e) => e.detail);
    assert.ok(new Set(judgedKeys).size === judgedKeys.length, "no duplicate judge inputs");
  });

  it("disputed pending under a judge cap cannot finalize after new evidence arrives", async () => {
    // Repair-pass rework: the plan reorder (primaries before contrary
    // rounds) removed the interleaving my old fixture relied on. The
    // durable collapse/staleness shape is the judge-cap one (mirrors
    // the independent suite's stale-answer case): judgment 1 sees
    // alpha+beta → disputed pending on key [e1,e2]; the contrary round
    // then reads gamma but the judge cap blocks reassessment — the
    // pending is stale against [e1,e2,e3] and must be cleared, never
    // finalized.
    const judgeFn = async (input) => ({
      documents: input.documents.map((doc) => {
        if (doc.url.includes("doc-alpha")) return { evidenceId: doc.evidenceId, relevant: true, supportsClaim: true, refutesClaim: false };
        if (doc.url.includes("doc-beta")) return { evidenceId: doc.evidenceId, relevant: true, supportsClaim: false, refutesClaim: true };
        return { evidenceId: doc.evidenceId, relevant: false, supportsClaim: false, refutesClaim: false };
      }),
    });
    const deps = depsWith({
      searchResults: [
        { url: "https://doc-alpha.example.com/", queries: [CSV_Q] },
        { url: "https://doc-beta.example.com/", queries: [CSV_Q] },
        { url: "https://doc-gamma.example.com/", queries: [`${CSV_Q} contrary evidence refuted`] },
      ],
      reads: {
        "https://doc-alpha.example.com/": SUPPORT_CSV,
        "https://doc-beta.example.com/": REFUTE_CSV,
        "https://doc-gamma.example.com/": "Third document.",
      },
      judge: judgeFn,
    });
    const result = await runLeanInvestigation(
      baseContract({ csv: enumField(CSV_Q) }, { readBatchSize: 1, maxJudgeAttempts: 1 }),
      deps,
    );

    const row = result.requirements.csv;
    assert.equal(row.status, "unresolved");
    assert.equal(row.judgmentCount, 1, "second judgment blocked by cap");
    assert.equal(result.data.csv, undefined, "stale disputed never finalized");
  });
});

// ---------------------------------------------------------------------------
// Demonstration 4 — disputed from credible sources vs model answers
// ---------------------------------------------------------------------------

describe("lean investigation D4: disputed classification boundary", () => {
  it("two credible conflicting docs fulfill an allowed disputed enum", async () => {
    const judgeFn = async (input) => {
      const documents = input.documents.map((doc) => {
        if (doc.url.includes("guide")) return { evidenceId: doc.evidenceId, relevant: true, supportsClaim: true, refutesClaim: false };
        if (doc.url.includes("limits")) return { evidenceId: doc.evidenceId, relevant: true, supportsClaim: false, refutesClaim: true };
        return { evidenceId: doc.evidenceId, relevant: false, supportsClaim: false, refutesClaim: false };
      });
      return { documents };
    };
    const deps = depsWith({
      searchResults: [
        { url: "https://example.com/guide", queries: [OFFLINE_Q] },
        { url: "https://example.com/limits", queries: [`${OFFLINE_Q} contrary evidence refuted`] },
      ],
      reads: {
        "https://example.com/guide": "ExampleApp 2.4.0 supports offline export via the mobile client cache.",
        "https://example.com/limits": "ExampleApp 2.4.0 does not support offline export; sync requires connectivity.",
      },
      judge: judgeFn,
    });
    const result = await runLeanInvestigation(baseContract({ offline: enumField(OFFLINE_Q) }), deps);

    assert.equal(result.requirements.offline.status, "satisfied");
    assert.equal(result.data.offline, "disputed");
    assert.deepEqual(result.requirements.offline.evidenceIds, ["e1", "e2"]);
  });

  it("single doc with explicit same-scope contradiction counts as disputed", async () => {
    const judgeFn = async (input) => {
      const documents = input.documents.map((doc) => {
        if (doc.url.includes("conflicted")) return { evidenceId: doc.evidenceId, relevant: true, supportsClaim: true, refutesClaim: true };
        return { evidenceId: doc.evidenceId, relevant: false, supportsClaim: false, refutesClaim: false };
      });
      return { documents };
    };
    const deps = depsWith({
      searchResults: [{ url: "https://example.com/conflicted", queries: [CSV_Q] }],
      reads: {
        "https://example.com/conflicted": `${SUPPORT_CSV} ${REFUTE_CSV}`,
      },
      judge: judgeFn,
    });
    const result = await runLeanInvestigation(baseContract({ csv: enumField(CSV_Q) }), deps);
    assert.equal(result.data.csv, "disputed");
  });

  it("scalar-only enum is not silently converted to a dispute", async () => {
    const judgeFn = async (input) => {
      const documents = input.documents.map((doc) => {
        if (doc.url.includes("guide")) return { evidenceId: doc.evidenceId, relevant: true, supportsClaim: true, refutesClaim: false };
        if (doc.url.includes("limits")) return { evidenceId: doc.evidenceId, relevant: true, supportsClaim: false, refutesClaim: true };
        return { evidenceId: doc.evidenceId, relevant: false, supportsClaim: false, refutesClaim: false };
      });
      return { documents };
    };
    const deps = depsWith({
      searchResults: [
        { url: "https://example.com/guide", queries: [OFFLINE_Q] },
        { url: "https://example.com/limits", queries: [`${OFFLINE_Q} contrary evidence refuted`] },
      ],
      reads: {
        "https://example.com/guide": "ExampleApp 2.4.0 supports offline export.",
        "https://example.com/limits": "ExampleApp 2.4.0 does not support offline export.",
      },
      judge: judgeFn,
    });
    const result = await runLeanInvestigation(
      baseContract({
        offline: {
          question: OFFLINE_Q,
          schema: { enum: ["supported", "refuted"] },
          required: true,
        },
      }),
      deps,
    );

    assert.equal(result.requirements.offline.status, "unresolved");
    assert.equal(result.requirements.offline.reason, "conflicting_evidence");
    assert.equal(result.data.offline, undefined);
    assert.equal(result.status, "partial");
  });
});

// ---------------------------------------------------------------------------
// Demonstration 5 — honest termination
// ---------------------------------------------------------------------------

describe("lean investigation D5: honest termination", () => {
  it("duplicate results dedupe; exhausted queries/results end unresolved without invention", async () => {
    const judge = createFixtureJudge();
    const deps = depsWith({
      searchResults: [
        // Every query returns the same two urls — duplicate queues.
        { url: "https://example.com/dup1", queries: ["Assess CSV and offline export support in ExampleApp 2.4.0.", CSV_Q, `${CSV_Q} contrary evidence refuted`] },
        { url: "https://example.com/dup2", queries: ["Assess CSV and offline export support in ExampleApp 2.4.0.", CSV_Q] },
      ],
      reads: {
        "https://example.com/dup1": "Unrelated content.",
        "https://example.com/dup2": "More unrelated content.",
      },
      judge: judge.judgeFn,
    });
    const result = await runLeanInvestigation(baseContract({ csv: enumField(CSV_Q) }), deps);

    assert.equal(result.requirements.csv.status, "unresolved");
    assert.equal(result.requirements.csv.reason, "exhausted");
    assert.equal(result.usage.readsRetained, 2, "deduplicated reads");
    assert.equal(result.usage.searches, 3, "all three planned queries attempted");
    assert.equal(result.data.csv, undefined);
  });

  it("failed reads charge read attempts and continue; all-failed ends honestly", async () => {
    const judge = createFixtureJudge();
    let sharedSearches = 0;
    const deps = {
      search: async () => {
        sharedSearches += 1;
        return [{ url: "https://example.com/down1" }, { url: "https://example.com/down2" }];
      },
      read: async () => {
        throw new Error("connection refused");
      },
      judge: judge.judgeFn,
      now: () => 0,
    };
    const result = await runLeanInvestigation(baseContract({ csv: enumField(CSV_Q) }), deps);

    assert.equal(result.requirements.csv.status, "unresolved");
    assert.equal(result.requirements.csv.reason, "exhausted");
    const kinds = result.acquisitionLog.map((e) => e.kind);
    assert.ok(kinds.includes("read-failed"));
    assert.ok(kinds.includes("read-retry"), "retry charged and distinct from new-evidence rounds");
    // 2 urls × (1 read + 1 retry) = 4 read attempts.
    assert.equal(result.usage.readAttempts, 4);
  });

  it("deadline terminates with reason deadline", async () => {
    const judge = createFixtureJudge();
    let tick = 0;
    const deps = depsWith({
      searchResults: [{ url: "https://example.com/never-enough", queries: [CSV_Q] }],
      reads: { "https://example.com/never-enough": "Some text." },
      judge: judge.judgeFn,
      now: () => {
        tick += 30_000;
        return tick;
      },
    });
    const result = await runLeanInvestigation(baseContract({ csv: enumField(CSV_Q) }), deps);
    assert.equal(result.requirements.csv.status, "unresolved");
    assert.equal(result.requirements.csv.reason, "deadline");
  });

  it("lowered caller limits cap judge attempts honestly", async () => {
    const judge = createFixtureJudge();
    const deps = depsWith({
      searchResults: [
        { url: "https://example.com/a", queries: ["Assess CSV and offline export support in ExampleApp 2.4.0."] },
        { url: "https://example.com/b", queries: [CSV_Q] },
        { url: "https://example.com/c", queries: [`${CSV_Q} contrary evidence refuted`] },
      ],
      reads: {
        "https://example.com/a": "Doc a.",
        "https://example.com/b": "Doc b.",
        "https://example.com/c": "Doc c.",
      },
      judge: judge.judgeFn,
    });
    const result = await runLeanInvestigation(
      baseContract({ csv: enumField(CSV_Q) }, { maxJudgeAttempts: 1, maxUniqueReads: 2 }),
      deps,
    );
    assert.equal(result.usage.judgeCalls, 1);
    assert.equal(result.usage.readsRetained, 2, "maxUniqueReads honored");
    assert.equal(result.requirements.csv.status, "unresolved");
  });
});

// ---------------------------------------------------------------------------
// Demonstration 6 — absent semantic judge
// ---------------------------------------------------------------------------

describe("lean investigation D6: deterministic-only mode", () => {
  it("no judge: bounded acquisition still runs, semantic fields unresolved, nothing relabeled", async () => {
    // Repair pass replaced the old zero-acquisition behavior (it pinned
    // the incomplete proof, not the agreed fallback): with judge null
    // the engine still runs the deterministic search/read path and
    // retains bounded evidence; semantic-classification fields stay
    // unresolved with an explicit basis.
    let searches = 0;
    let reads = 0;
    const deps = {
      search: async () => {
        searches += 1;
        return [{ url: "https://example.com/doc1" }, { url: "https://example.com/doc2" }];
      },
      read: async (url) => {
        reads += 1;
        return `Content of ${url}`;
      },
      judge: null,
      now: () => 0,
    };
    const result = await runLeanInvestigation(
      baseContract({ csv: enumField(CSV_Q), offline: enumField(OFFLINE_Q) }),
      deps,
    );

    assert.equal(result.assessment, "deterministic-only");
    assert.ok(searches > 0, "deterministic acquisition ran");
    assert.ok(reads > 0);
    assert.equal(result.usage.judgeCalls, 0);
    assert.ok(result.evidence.length > 0, "evidence retained without a judge");
    assert.equal(result.status, "partial");
    assert.equal(result.requirements.csv.reason, "no_semantic_judge");
    assert.equal(result.requirements.offline.reason, "no_semantic_judge");
    // Structure parity: every requested field has a row.
    assert.deepEqual(Object.keys(result.requirements), ["csv", "offline"]);
  });
});

// ---------------------------------------------------------------------------
// Demonstration 7 — dependencies
// ---------------------------------------------------------------------------

describe("lean investigation D7: dependency blocking", () => {
  it("unresolved prerequisite blocks only dependants; independent field continues", async () => {
    const judgeFn = async (input) => {
      const documents = input.documents.map((doc) => {
        if (input.fieldId === "license" && doc.url.includes("lic")) {
          return { evidenceId: doc.evidenceId, relevant: true, supportsClaim: true, refutesClaim: false };
        }
        return { evidenceId: doc.evidenceId, relevant: false, supportsClaim: false, refutesClaim: false };
      });
      return { documents };
    };
    const deps = depsWith({
      searchResults: [
        { url: "https://example.com/lic", queries: ["Which license does ExampleApp 2.4.0 use?"] },
      ],
      reads: { "https://example.com/lic": "ExampleApp 2.4.0 is MIT licensed." },
      judge: judgeFn,
    });
    const result = await runLeanInvestigation(
      baseContract({
        version: {
          question: "What ExampleApp version is current?",
          schema: { enum: ["supported", "refuted", "disputed"] },
          required: true,
        },
        license: {
          question: "Which license does ExampleApp 2.4.0 use?",
          schema: { enum: ["supported", "refuted", "disputed"] },
          required: true,
          dependsOn: ["version"],
        },
        csv: enumField(CSV_Q),
      }),
      deps,
    );

    // version: no evidence → exhausted; license blocked by it; csv unrelated
    // but also unevidenced here → exhausted. The blocked reason differs.
    assert.equal(result.requirements.version.status, "unresolved");
    assert.equal(result.requirements.license.reason, "prerequisite_unresolved:version");
    assert.notEqual(result.requirements.csv.reason, "prerequisite_unresolved:version");
  });

  it("cyclic, missing and self dependencies fail validation before acquisition", async () => {
    let searched = false;
    const deps = {
      search: async () => {
        searched = true;
        return [];
      },
      read: async () => "",
      judge: async () => ({ documents: [] }),
      now: () => 0,
    };
    const cycle = baseContract({
      a: enumField("A?", { dependsOn: ["b"] }),
      b: enumField("B?", { dependsOn: ["a"] }),
    });
    await assert.rejects(() => runLeanInvestigation(cycle, deps), /cycle/);
    const missing = baseContract({ a: enumField("A?", { dependsOn: ["ghost"] }) });
    await assert.rejects(() => runLeanInvestigation(missing, deps), /unknown field "ghost"/);
    const selfRef = baseContract({ a: enumField("A?", { dependsOn: ["a"] }) });
    await assert.rejects(() => runLeanInvestigation(selfRef, deps), /cannot reference itself/);
    assert.equal(searched, false, "zero acquisition on rejected contracts");
  });

  it("invalid schemas and ids fail validation", () => {
    assert.throws(
      () => compileLeanContract({ schemaVersion: 2, question: "q", requirements: { a: { question: "A?", schema: { enum: ["supported"] } } } }),
      /schemaVersion/,
    );
    assert.throws(
      () => compileLeanContract({ schemaVersion: 1, question: "q", requirements: { a: { question: "A?", schema: { enum: ["maybe"] } } } }),
      /outside the proof vocabulary/,
    );
    assert.throws(
      () => compileLeanContract({ schemaVersion: 1, question: "q", requirements: {} }),
      /at least one field/,
    );
    assert.throws(
      () => compileLeanContract({ schemaVersion: 1, question: "q", requirements: { a: { question: "A?", schema: { enum: ["supported"] } } }, limits: { maxJudgeAttempts: 99 } }),
      /engine ceiling/,
    );
    assert.throws(
      () => compileLeanContract({ schemaVersion: 1, question: "q", requirements: { a: { question: "A?", schema: { enum: ["supported"] } } }, limits: { banana: 1 } }),
      /not a recognized limit/,
    );
  });
});

// ---------------------------------------------------------------------------
// Demonstration 8 — faithful full-text presentation and truncation honesty
// ---------------------------------------------------------------------------

describe("lean investigation D8: faithful evidence presentation", () => {
  it("full bounded text reaches the judge, including counterevidence", async () => {
    const longTail = "Filling prose. ".repeat(200);
    const content = `${SUPPORT_CSV} ${REFUTE_CSV} ${longTail}`;
    const seenDocs = [];
    const judgeFn = async (input) => {
      seenDocs.push(input.documents);
      return {
        documents: input.documents.map((doc) => {
          if (doc.url.includes("full")) {
            return { evidenceId: doc.evidenceId, relevant: true, supportsClaim: true, refutesClaim: true };
          }
          return { evidenceId: doc.evidenceId, relevant: false, supportsClaim: false, refutesClaim: false };
        }),
      };
    };
    const deps = depsWith({
      searchResults: [{ url: "https://example.com/full", queries: [CSV_Q] }],
      reads: { "https://example.com/full": content },
      judge: judgeFn,
    });
    const result = await runLeanInvestigation(baseContract({ csv: enumField(CSV_Q) }), deps);

    const doc = seenDocs.at(-1)[0];
    assert.ok(doc.content.includes(SUPPORT_CSV), "support text verbatim in judge input");
    assert.ok(doc.content.includes(REFUTE_CSV), "counterevidence NOT cut away");
    assert.equal(doc.content, result.evidence[0].content, "judge sees exactly the retained record");
    assert.equal(result.data.csv, "disputed");
  });

  it("oversize doc is rejected unread, never truncated into acceptance", async () => {
    // Repair pass: truncation at a byte ceiling could silently drop
    // counterevidence past the cut, so oversize content is now REJECTED
    // (retained nothing) with an explicit coverage note — the old test
    // pinned the truncation behavior, which is gone by design.
    const huge = `${SUPPORT_CSV} ${"x".repeat(20_000)}`;
    const judgeFn = async () => ({ documents: [] });
    const deps = depsWith({
      searchResults: [{ url: "https://example.com/huge", queries: [CSV_Q] }],
      reads: { "https://example.com/huge": huge },
      judge: judgeFn,
    });
    const result = await runLeanInvestigation(baseContract({ csv: enumField(CSV_Q) }), deps);

    assert.equal(result.evidence.length, 0, "nothing retained from the oversize doc");
    assert.ok(
      result.acquisitionLog.some((e) => e.kind === "evidence-oversize-rejected" && e.detail === "https://example.com/huge"),
    );
    assert.ok(result.coverageNotes.some((n) => n.includes("rejected unread") && n.includes("https://example.com/huge")));
    assert.equal(result.requirements.csv.status, "unresolved");
  });
});

// ---------------------------------------------------------------------------
// Regression: relevance gate is load-bearing (mutation-evidence case)
// ---------------------------------------------------------------------------

describe("lean investigation relevance gate", () => {
  it("a doc judged irrelevant but supportive cannot establish support", async () => {
    // The JEV-CONTENT-ASSESSMENT failure shape: keyword-stuffed content
    // where an over-eager support answer coexists with relevance=false.
    // Only the conjunction of BOTH typed verdicts may accept.
    const judgeFn = async (input) => ({
      documents: input.documents.map((doc) => ({
        evidenceId: doc.evidenceId,
        relevant: false,
        supportsClaim: true,
        refutesClaim: false,
      })),
    });
    const deps = depsWith({
      searchResults: [{ url: "https://spam.example/junk", queries: ["Assess CSV and offline export support in ExampleApp 2.4.0."] }],
      reads: { "https://spam.example/junk": "csv export exampleapp 2.4.0 csv export" },
      judge: judgeFn,
    });
    const result = await runLeanInvestigation(baseContract({ csv: enumField(CSV_Q) }), deps);
    assert.equal(result.data.csv, undefined);
    assert.equal(result.requirements.csv.status, "unresolved");
  });
});

// ---------------------------------------------------------------------------
// REPAIR PASS (ticket: repair-pass) — RED-first tests for the four
// parent-verified acceptance gaps. Each MUST fail on the pre-repair
// engine; see repair report for captured RED counts.
// ---------------------------------------------------------------------------

describe("REPAIR 1: limits cannot waive counterevidence", () => {
  it("maxSearchAttempts:1 cannot complete a one-sided accept without the contrary round", async () => {
    const judgeFn = async (input) => ({
      documents: input.documents.map((d) => ({ evidenceId: d.evidenceId, relevant: true, supportsClaim: true, refutesClaim: false })),
    });
    const deps = depsWith({
      searchResults: [{ url: "https://a.example/", queries: ["Assess CSV and offline export support in ExampleApp 2.4.0."] }],
      reads: { "https://a.example/": SUPPORT_CSV },
      judge: judgeFn,
    });
    const result = await runLeanInvestigation(
      baseContract({ csv: enumField(CSV_Q) }, { maxSearchAttempts: 1 }),
      deps,
    );
    // Fail closed: the counterevidence query never ran, so a required
    // one-sided accept is NOT satisfied — explicit unresolved with the
    // counterevidence-not-acquired basis. status is "partial" (nothing
    // accepted), not "complete".
    assert.equal(result.requirements.csv.status, "unresolved");
    assert.equal(result.requirements.csv.reason, "counterevidence_not_acquired");
    assert.equal(result.status, "partial");
  });

  it("a failed counterevidence search does not count as completed contrary evidence", async () => {
    const judgeFn = async (input) => ({
      documents: input.documents.map((d) => ({ evidenceId: d.evidenceId, relevant: true, supportsClaim: true, refutesClaim: false })),
    });
    const deps = {
      search: async (q) => {
        if (q.includes("contrary evidence")) throw new Error("search 503");
        return [{ url: "https://a.example/" }];
      },
      read: async () => SUPPORT_CSV,
      judge: judgeFn,
      now: () => 0,
    };
    const result = await runLeanInvestigation(baseContract({ csv: enumField(CSV_Q) }), deps);
    assert.equal(result.requirements.csv.status, "unresolved");
    assert.equal(result.requirements.csv.reason, "counterevidence_not_acquired");
  });
});

describe("REPAIR 2: truncated coverage cannot accept", () => {
  it("refutation beyond the byte ceiling blocks one-sided acceptance", async () => {
    const big = `${SUPPORT_CSV} ${"x".repeat(20_000)} ${REFUTE_CSV}`;
    const judgeFn = async (input) => ({
      documents: input.documents.map((d) => ({ evidenceId: d.evidenceId, relevant: true, supportsClaim: true, refutesClaim: false })),
    });
    const deps = depsWith({
      searchResults: [{ url: "https://big.example/", queries: [CSV_Q] }],
      reads: { "https://big.example/": big },
      judge: judgeFn,
    });
    const result = await runLeanInvestigation(baseContract({ csv: enumField(CSV_Q) }), deps);
    assert.equal(result.requirements.csv.status, "unresolved");
    assert.notEqual(result.data.csv, "supported");
    assert.ok(
      result.requirements.csv.reason === "incomplete_evidence_coverage" ||
        result.evidence.every((e) => !e.truncated),
      `oversize must reject-or-not-retain, reason=${result.requirements.csv.reason}`,
    );
  });
});

describe("REPAIR 3: judge verdicts validated at runtime", () => {
  it("unknown evidenceId verdicts are rejected, never accepted", async () => {
    const deps = depsWith({
      searchResults: [{ url: "https://a.example/", queries: [CSV_Q] }],
      reads: { "https://a.example/": SUPPORT_CSV },
      judge: async () => ({ documents: [{ evidenceId: "fabricated", relevant: true, supportsClaim: true, refutesClaim: false }] }),
    });
    const result = await runLeanInvestigation(baseContract({ csv: enumField(CSV_Q) }), deps);
    assert.notEqual(result.requirements.csv.status, "satisfied");
    assert.deepEqual(result.requirements.csv.evidenceIds.filter((id) => id === "fabricated"), []);
  });

  it("duplicate evidenceId verdicts, missing doc verdicts and truthy strings are malformed", async () => {
    const mkDeps = (docs) =>
      depsWith({
        searchResults: [{ url: "https://a.example/", queries: [CSV_Q] }],
        reads: { "https://a.example/": SUPPORT_CSV },
        judge: async () => ({ documents: docs }),
      });
    const dup = await runLeanInvestigation(
      baseContract({ csv: enumField(CSV_Q) }),
      mkDeps([
        { evidenceId: "e1", relevant: true, supportsClaim: true, refutesClaim: false },
        { evidenceId: "e1", relevant: true, supportsClaim: true, refutesClaim: false },
      ]),
    );
    assert.notEqual(dup.requirements.csv.status, "satisfied", "duplicate verdicts accepted");

    const missing = await runLeanInvestigation(
      baseContract({ csv: enumField(CSV_Q) }),
      mkDeps([]),
    );
    assert.notEqual(missing.requirements.csv.status, "satisfied", "missing doc verdicts accepted");

    const truthy = await runLeanInvestigation(
      baseContract({ csv: enumField(CSV_Q) }),
      mkDeps([{ evidenceId: "e1", relevant: "yes", supportsClaim: true, refutesClaim: false }]),
    );
    assert.notEqual(truthy.requirements.csv.status, "satisfied", "truthy string accepted as boolean");
  });
});

describe("REPAIR 4: no-judge mode still acquires bounded evidence", () => {
  it("deterministic-only run retains evidence with zero semantic calls", async () => {
    // Independent-suite finding: the original version of this test
    // passed a judge FUNCTION (never invoked) and so could not
    // distinguish the old zero-acquisition early return from the real
    // path. judge is now literal null, matching the agreed fallback.
    const deps = {
      search: async () => [{ url: "https://a.example/" }, { url: "https://b.example/" }],
      read: async (url) => `Content of ${url}`,
      judge: null,
      now: () => 0,
    };
    const result = await runLeanInvestigation(baseContract({ csv: enumField(CSV_Q) }), deps);
    assert.equal(result.assessment, "deterministic-only");
    assert.ok(result.evidence.length > 0, "evidence retained");
    assert.ok(result.evidence.every((e) => e.content.length > 0));
    assert.equal(result.requirements.csv.status, "unresolved");
    assert.equal(result.requirements.csv.reason, "no_semantic_judge");
    assert.ok(result.usage.searches > 0);
    assert.ok(result.usage.readsRetained > 0);
    assert.equal(result.usage.judgeCalls, 0);
  });
});
