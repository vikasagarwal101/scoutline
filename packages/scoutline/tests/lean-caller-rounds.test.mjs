/**
 * Caller-directed rounds in the existing evidence engine — ticket:
 * unified-investigation/caller-assisted-engine/tickets/caller-rounds.
 *
 * Real fs store + fake native search/read/judge deps (no HTTP).
 * RED-first: every case below failed against the pre-ticket source
 * (no caller-round API existed).
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { startCallerRound } from "../dist/lib/lean-caller-rounds.js";
import { runLeanInvestigation } from "../dist/lib/lean-investigation.js";

globalThis.fetch = () => {
  throw new Error("HTTP refused");
};

const REQUIREMENTS = { schemaVersion: 1, fields: { a: { definition: "synthetic", required: true } } };
const now = () => 1_000;

/** URL -> content search/read world. search returns every URL. */
function world(pages) {
  const searches = [];
  const reads = [];
  return {
    searches,
    reads,
    deps: (extra = {}) => ({
      search: async (q) => {
        searches.push(q);
        return Object.entries(pages).map(([url, rawContent]) => ({ url, title: url, rawContent }));
      },
      read: async (url) => {
        reads.push(url);
        if (!(url in pages)) throw new Error(`no page ${url}`);
        return pages[url];
      },
      judge: null,
      now,
      ...extra,
    }),
  };
}

async function freshRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), "caller-rounds-"));
}

// ---------------------------------------------------------------------------
// cold start: no extractor → handoff with evidence retained, gaps explicit
// ---------------------------------------------------------------------------
test("cold start: acquires context with no extractor and hands off awaiting caller proposals", async () => {
  const root = await freshRoot();
  const w = world({ "https://example.test/pkg": "package foo version 1.2.3 license MIT" });
  try {
    const deps = {
      ...w.deps(),
      // no extract, no candidateJudge
    };
    const { result, handoff, handle, store, investigationRef } = await startCallerRound({
      storeRoot: root,
      requirements: REQUIREMENTS,
      contract: {
        schemaVersion: 1,
        question: "What version is package foo?",
        requirements: { version: { question: "What version is package foo?", schema: { type: "string" }, required: true } },
      },
      deps,
    });
    try {
      assert.equal(result.assessment, "deterministic-only");
      assert.equal(result.usage.searches > 0, true, "cold start must search");
      assert.equal(result.usage.readsRetained > 0, true, "cold start must retain evidence");
      assert.equal(result.requirements.version.status, "unresolved");
      assert.equal(result.requirements.version.reason, "no_semantic_judge");
      assert.equal(handoff.kind, "caller-assisted-investigation");
      assert.equal(handoff.schemaVersion, 1);
      assert.equal(handoff.investigationRef, investigationRef);
      assert.equal(handoff.revision, 1);
      assert.equal(handoff.round.status, "settled");
      // judge absent + extractor absent: the engine truthfully labels the
      // missing JUDGE first (no semantic assessor at all); proposals are
      // still the caller's move once a judge exists.
      assert.equal(handoff.stopReason, "no-judge-evidence-retained");
      assert.ok(Array.isArray(handoff.gaps));
      assert.ok(handoff.gaps.length > 0);
      assert.ok(result.evidence.length > 0, "evidence retained in handoff");
    } finally {
      await handle.release();
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// round 2: caller string proposal → judged → accepted via original binding
// ---------------------------------------------------------------------------
test("continue: caller string proposal bound to retained evidence is judged and accepted", async () => {
  const root = await freshRoot();
  const w = world({ "https://example.test/pkg": "package foo version 1.2.3 license MIT" });
  const judgeCalls = [];
  const deps = {
    ...w.deps(),
    // value mode needs a present (non-null) judge to leave the
    // deterministic-only branch; it is never dispatched for string fields
    judge: async () => ({ documents: [] }),
    extract: null,
    candidateJudge: async (input) => {
      judgeCalls.push(input);
      const answers = {};
      input.candidates.forEach((c, i) => {
        answers[`q${i}s`] = { type: "noul", noul: 0.95 };
        answers[`q${i}c`] = { type: "noul", noul: 0.01 };
      });
      return {
        model: "fake",
        answers,
        usage: { inputTokens: 1, outputTokens: 1 },
        requestSha256: "0".repeat(64),
        elapsedMs: 1,
      };
    },
  };
  const PAGE_URL = "https://example.test/pkg";
  try {
    const first = await startCallerRound({
      storeRoot: root,
      requirements: REQUIREMENTS,
      contract: {
        schemaVersion: 1,
        question: "What version is package foo?",
        requirements: { version: { question: "What version is package foo?", schema: { type: "string" }, required: true } },
      },
      deps,
    });
    await first.handle.release();

    const representation = first.handoff.evidence.find((e) => e.url === PAGE_URL);
    const second = await continueCallerRoundFrom(first, deps, [
      {
        fieldId: "version",
        mode: "string",
        value: "1.2.3",
        definitionRevision: first.handoff.definitions.version,
        representationId: representation.representationId,
        digest: representation.digest,
        quote: "version 1.2.3",
        charRange: [12, 25],
      },
    ]);
    try {
      assert.equal(second.result.requirements.version.status, "satisfied", second.result.requirements.version.reason);
      assert.equal(second.result.data.version, "1.2.3");
      assert.ok(second.result.requirements.version.provenance, "accepted candidate keeps provenance");
      assert.equal(judgeCalls.length, 1, "exactly one candidate judgment");
      assert.ok(second.result.requirements.version.judgment, "accepted candidate keeps judgment");
      assert.equal(second.handoff.stopReason, "work-fulfilled");
    } finally {
      await second.handle.release();
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// classification proposal: engine re-derives label, caller assertion insufficient
test("continue: classification proposal is re-derived, not accepted by assertion", async () => {
  const root = await freshRoot();
  const w = world({ "https://example.test/pkg": "package foo is actively maintained and documented" });
  const judgeCalls = [];
  const deps = {
    ...w.deps(),
    judge: async (input) => {
      judgeCalls.push(input);
      return {
        documents: input.documents.map((d) => ({ evidenceId: d.evidenceId, relevant: true, supportsClaim: true, refutesClaim: false })),
        // lean judge contract fields
        fieldId: input.fieldId,
        answer: input.candidates[0],
      };
    },
  };
  try {
    const first = await startCallerRound({
      storeRoot: root,
      requirements: REQUIREMENTS,
      contract: {
        schemaVersion: 1,
        question: "Is package foo maintained?",
        requirements: { maintained: { question: "Is package foo maintained?", schema: { enum: ["supported", "refuted", "disputed"] }, required: true } },
      },
      deps,
    });
    await first.handle.release();

    assert.equal(first.result.data.maintained, "supported", "fixture must first derive supported");
    const before = judgeCalls.length, submittedLabel = "refuted";
    const second = await continueCallerRoundFrom(first, deps, [
      { fieldId: "maintained", mode: "classification", value: submittedLabel, definitionRevision: first.handoff.definitions.maintained },
    ]);
    try {
      assert.equal(second.result.requirements.maintained.status, "satisfied");
      assert.equal(second.result.data.maintained, "supported");
      assert.notEqual(second.result.data.maintained, submittedLabel, "caller label cannot replace independent derivation");
      const delta = judgeCalls.length - before;
      assert.ok(delta > 0, "unknown judge identity requires round-local assessment");
      assert.equal(delta, second.result.usage.judgeCalls);
      const maintained = second.result.requirements.maintained;
      assert.ok(maintained.judgmentCount > 0);
      const retainedIds = new Set(second.result.evidence.map(e => e.evidenceId));
      assert.ok(maintained.assessments.some(basis => basis.length > 0 && basis.every(d => retainedIds.has(d.evidenceId))
        && basis.some(d => d.relevant === true && d.supportsClaim === true && d.refutesClaim === false)),
      "accepted support must have an assessment basis tied to retained evidence");
    } finally {
      await second.handle.release();
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// malformed proposal: value not in quote → rejected, no judge call
test("continue: string proposal with value not in quote fails binding without judgment", async () => {
  const root = await freshRoot();
  const w = world({ "https://example.test/pkg": "package foo version 1.2.3 license MIT" });
  const judgeCalls = [];
  const deps = {
    ...w.deps(),
    judge: async () => ({ documents: [] }),
    candidateJudge: async (input) => {
      judgeCalls.push(input);
      const answers = {};
      input.candidates.forEach((c, i) => {
        answers[`q${i}s`] = { type: "noul", noul: 0.95 };
        answers[`q${i}c`] = { type: "noul", noul: 0.01 };
      });
      return {
        model: "fake",
        answers,
        usage: { inputTokens: 1, outputTokens: 1 },
        requestSha256: "0".repeat(64),
        elapsedMs: 1,
      };
    },
  };
  const PAGE_URL = "https://example.test/pkg";
  try {
    const first = await startCallerRound({
      storeRoot: root,
      requirements: REQUIREMENTS,
      contract: {
        schemaVersion: 1,
        question: "What version is package foo?",
        requirements: { version: { question: "What version is package foo?", schema: { type: "string" }, required: true } },
      },
      deps,
    });
    await first.handle.release();

    // "9.9.9" does not occur in the quote (or source) → binding fails
    const second = await continueCallerRoundFrom(first, deps, [
      {
        fieldId: "version",
        mode: "string",
        value: "9.9.9",
        definitionRevision: first.handoff.definitions.version,
        representationId: first.handoff.evidence.find((e) => e.url === PAGE_URL).representationId,
        digest: first.handoff.evidence.find((e) => e.url === PAGE_URL).digest,
        quote: "version 1.2.3",
        charRange: [12, 25],
      },
    ]);
    try {
      assert.equal(second.result.requirements.version.status, "unresolved");
      assert.equal(judgeCalls.length, 0, "no judgment for failed binding");
      assert.ok(
        second.result.requirements.version.candidates.some((c) => c.reason === "value_not_in_quote"),
        "binding failure recorded as invalid candidate",
      );
    } finally {
      await second.handle.release();
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// stale expected revision: fails before any HTTP
test("continue: stale expectedRevision fails before any dispatch", async () => {
  const root = await freshRoot();
  const w = world({ "https://example.test/pkg": "package foo version 1.2.3 license MIT" });
  const deps = w.deps();
  try {
    const first = await startCallerRound({
      storeRoot: root,
      requirements: REQUIREMENTS,
      contract: {
        schemaVersion: 1,
        question: "What version is package foo?",
        requirements: { version: { question: "What version is package foo?", schema: { type: "string" }, required: true } },
      },
      deps,
    });
    await first.handle.release();
    const searchesBefore = w.searches.length;
    const readsBefore = w.reads.length;
    await assert.rejects(
      continueCallerRoundFrom(first, deps, [], { expectedRevisionOverride: 999 }),
      (e) => /Expected revision|expected revision/i.test(e.message),
      "stale revision must fail",
    );
    assert.equal(w.searches.length, searchesBefore, "no search after stale revision");
    assert.equal(w.reads.length, readsBefore, "no read after stale revision");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// fresh caps: two rounds each get fresh search allowance; cumulative ledger
test("two rounds: fresh per-round caps, cumulative usage ledger", async () => {
  const root = await freshRoot();
  const w = world({ "https://example.test/pkg": "package foo version 1.2.3 license MIT" });
  const deps = w.deps();
  try {
    const first = await startCallerRound({
      storeRoot: root,
      requirements: REQUIREMENTS,
      contract: {
        schemaVersion: 1,
        question: "What version is package foo?",
        requirements: { version: { question: "What version is package foo?", schema: { type: "string" }, required: true } },
      },
      deps,
    });
    await first.handle.release();
    const firstSearches = w.searches.length;
    assert.ok(firstSearches > 0);

    const second = await continueCallerRoundFrom(first, deps, []);
    try {
      // Round 2 reuses round 1's successful coverage under an unchanged
      // basis (rounds spec: repeating unchanged paid work is no progress),
      // so its per-round search count is 0 — the fresh cap is available
      // but identical queries are not re-dispatched.
      assert.equal(second.result.usage.searches, 0, "unchanged coverage is reused, not re-searched");
      assert.equal(second.handoff.cumulativeUsage.searches, firstSearches, "cumulative ledger carries both rounds");
      assert.equal(second.handoff.cumulativeUsage.rounds, 2);
    } finally {
      await second.handle.release();
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// failed contrary lead: stays eligible in a later round
test("failed read in round 1 remains eligible and is retried in round 2 with fresh allowance", async () => {
  const root = await freshRoot();
  const BAD = "https://example.test/bad";
  const w = world({ [BAD]: "package foo version 1.2.3 license MIT" });
  let failReads = true;
  const deps = {
    ...w.deps(),
    read: async (url) => {
      w.reads.push(url);
      if (failReads && url === BAD) throw new Error("transient");
      return Object.fromEntries(Object.entries({ "https://example.test/bad": "package foo version 1.2.3 license MIT" }))[url];
    },
  };
  try {
    const first = await startCallerRound({
      storeRoot: root,
      requirements: REQUIREMENTS,
      contract: {
        schemaVersion: 1,
        question: "What version is package foo?",
        requirements: { version: { question: "What version is package foo?", schema: { type: "string" }, required: true } },
      },
      deps,
    });
    await first.handle.release();
    assert.ok(first.result.acquisitionLog.some((e) => e.kind === "read-failed"), "round 1 recorded the failed read");

    failReads = false;
    const second = await continueCallerRoundFrom(first, deps, []);
    try {
      assert.ok(
        second.result.acquisitionLog.some((e) => e.kind === "read" && e.detail === BAD),
        "round 2 retried the failed lead",
      );
      assert.ok(second.result.evidence.some((e) => e.url === BAD), "retried lead retained");
    } finally {
      await second.handle.release();
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// no-judge: zero semantic HTTP; proposals exposed unassessed
test("no judge: zero semantic dispatch, proposals unassessed, evidence retained", async () => {
  const root = await freshRoot();
  const w = world({ "https://example.test/pkg": "package foo version 1.2.3 license MIT" });
  const semanticCalls = [];
  const deps = {
    ...w.deps(),
    candidateJudge: async (input) => {
      semanticCalls.push(input);
      throw new Error("must not be called");
    },
  };
  const PAGE_URL = "https://example.test/pkg";
  try {
    const first = await startCallerRound({
      storeRoot: root,
      requirements: REQUIREMENTS,
      contract: {
        schemaVersion: 1,
 question: "What version is package foo?",
        requirements: { version: { question: "What version is package foo?", schema: { type: "string" }, required: true } },
      },
      deps,
    });
    await first.handle.release();
    const second = await continueCallerRoundFrom(first, deps, [
      {
        fieldId: "version",
        mode: "string",
        value: "1.2.3",
        definitionRevision: first.handoff.definitions.version,
        representationId: first.handoff.evidence.find((e) => e.url === PAGE_URL).representationId,
        digest: first.handoff.evidence.find((e) => e.url === PAGE_URL).digest,
        quote: "version 1.2.3",
        charRange: [12, 25],
      },
    ]);
    try {
      assert.equal(second.result.assessment, "deterministic-only");
      assert.equal(second.result.usage.candidateJudgeCalls, 0, "zero semantic calls");
      assert.equal(semanticCalls.length, 0);
      assert.equal(second.result.requirements.version.status, "unresolved");
      assert.equal(second.result.requirements.version.reason, "no_semantic_judge");
      assert.ok(second.handoff.gaps.some((g) => /proposal/i.test(String(g))), "proposal surfaced as unassessed gap");
    } finally {
      await second.handle.release();
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// storage-boundary truth: an impossible reservation (store cap smaller
// than the settlement reserve) refuses the round BEFORE any paid dispatch.
test("storage admission failure refuses the round before paid dispatch", async () => {
  const root = await freshRoot();
  const w = world({ "https://example.test/pkg": "package foo version 1.2.3 license MIT" });
  const deps = w.deps();
  const created = await startCallerRound({
    storeRoot: root,
    requirements: REQUIREMENTS,
    contract: {
      schemaVersion: 1, question: "What version is package foo?",
      requirements: { version: { question: "What version is package foo?", schema: { type: "string" }, required: true } },
    },
    deps,
  });
  await created.handle.release();
  const searchesBefore = w.searches.length;
  // Reopen the SAME record with a cap too small to reserve settlement
  // headroom: beginRound must refuse before the engine dispatches.
  const { openStore } = await import("../dist/lib/retained-record-store.js");
  const tight = openStore({ root, caps: { recordMaxBytes: 1 } });
  const handle = await tight.acquireOwnership(created.investigationRef);
  try {
    await assert.rejects(
      handle.beginRound({ roundId: "tight", intent: "continue" }),
      (e) => /capacity|reserve|admission|cap/i.test(e.message),
      "round must refuse when the settlement reservation cannot be charged",
    );
  } finally {
    await handle.release();
  }
  assert.equal(w.searches.length, searchesBefore, "no paid dispatch after storage refusal");
  await fs.rm(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// helper: continue a round from a prior handoff (uses the public API)
// ---------------------------------------------------------------------------
async function continueCallerRoundFrom(first, deps, proposals, opts = {}) {
  const { continueCallerRound } = await import("../dist/lib/lean-caller-rounds.js");
  return continueCallerRound({
    storeRoot: first.storeRoot,
    investigationRef: first.investigationRef,
    expectedRevision: opts.expectedRevisionOverride ?? first.handoff.revision,
    contract: first.contract,
    deps,
    proposals,
  });
}
