/**
 * Unit tests for deterministic claim splitting + claim↔evidence
 * matching (investigate-verify lane, Ticket T1; DESIGN D2, PRD AC-2/
 * AC-4/AC-5/AC-6).
 *
 * splitClaims: the extract grammar's terminator rules (pinned to
 * lib/investigate-extract.ts splitWindows) — `[.!?]` followed by a
 * space (or end), or a newline; terminator owned by the window,
 * separator run owned by neither. The splitter is PURE: > 8 claims is
 * the CALLER's fail-loud cap (T3), so a 9-sentence statement returns
 * 9 claims here, no throw.
 *
 * matchClaimsToEvidence hand-computation (D7 fixture):
 *   claim A "Alpha reactors process data quietly."
 *     terms {alpha, reactors, process, data, quietly} → matches
 *     S0.p0 only ("The alpha reactors process incoming data rows.") —
 *     corroborated, 0 cues, evidence [{0,0}].
 *   claim B "Beta turbines never finish work."
 *     terms {beta, turbines, never, finish, work} → matches S0.p1
 *     ("Beta turbines never finish their assigned tasks."), which
 *     carries the whole-word cue "never" — contradicted, 1 cue,
 *     evidence [{0,1}].
 *   claim C "Gamma sensors record nothing."
 *     terms {gamma, sensors, record, nothing} → no matching passage —
 *     unresolved, evidence [].
 *   claim D "Roadmap reviews matter greatly."
 *     terms {roadmap, reviews, matter, greatly} → matches S1.p0
 *     ("Roadmap reviews matter; unrelated prose follows here.") and
 *     S1.p1 ("Nobody ever disputed the old roadmap.") in
 *     first-encounter order; S1.p1 carries the "disputed" cue
 *     (dispute(s/d)) — contradicted, 1 cue, evidence [{1,0},{1,1}].
 *
 * Cue-scan confinement pin: S1.p1 is cue-bearing but NON-matching for
 * claim A — if the cue scan wrongly ran over all passages, A would
 * flip to contradicted and this suite REDs.
 *
 * 100% offline: no filesystem, no providers; fixture-only.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  NEGATION_CUES,
  matchClaimsToEvidence,
  splitClaims,
} from "../dist/lib/investigate-claims.js";

// ---------------------------------------------------------------------------
// EvidenceSource fixtures (hand-built; the matcher reads passages only,
// but rows keep the full decode-valid source shape).
// ---------------------------------------------------------------------------

const S0_P0 = "The alpha reactors process incoming data rows.";
const S0_P1 = "Beta turbines never finish their assigned tasks.";
const S1_P0 = "Roadmap reviews matter; unrelated prose follows here.";
const S1_P1 = "Nobody ever disputed the old roadmap.";

function mkSource(index, passages) {
  return {
    url: `https://e/s${index}`,
    finalUrl: `https://e/s${index}`,
    title: `Source ${index}`,
    fetchedAt: "2026-09-21T00:00:00.000Z",
    provider: "tavily",
    contentFormat: "markdown",
    contentSha256: "0".repeat(64),
    passages: passages.map((quote, passageIndex) => ({
      quote,
      charRange: [0, quote.length + passageIndex],
    })),
  };
}

const SOURCES = [mkSource(0, [S0_P0, S0_P1]), mkSource(1, [S1_P0, S1_P1])];

const STATEMENT =
  "Alpha reactors process data quietly. " +
  "Beta turbines never finish work. " +
  "Gamma sensors record nothing. " +
  "Roadmap reviews matter greatly.";

// ---------------------------------------------------------------------------
// splitClaims — determinism table
// ---------------------------------------------------------------------------

describe("splitClaims (extract-grammar terminators; pure, no cap)", () => {
  it("splits on `.!?` followed by a space; terminator owned by the claim", () => {
    assert.deepEqual(splitClaims("Alpha beta. Gamma delta! Epsilon?"), [
      "Alpha beta.",
      "Gamma delta!",
      "Epsilon?",
    ]);
  });

  it("`.` before a newline is NOT a period-terminator — the newline terminates and owns (extract grammar)", () => {
    // Extract-grammar pin: `[.!?]` needs a SPACE to terminate; "End.\n"
    // ends at the `\n` (newline-owned), which trims away. The observable
    // claim text is identical either way; the row documents the grammar.
    assert.deepEqual(splitClaims("End.\nNext start"), ["End.", "Next start"]);
    assert.deepEqual(splitClaims("End!\nNext"), ["End!", "Next"]);
  });

  it("decimals and dotted abbreviations do not split (no space after the dot)", () => {
    assert.deepEqual(splitClaims("Pi is 3.14159 rounded. Done."), [
      "Pi is 3.14159 rounded.",
      "Done.",
    ]);
  });

  it("whitespace-only sentences drop; separator runs (spaces, tabs) own nothing", () => {
    assert.deepEqual(splitClaims("One.   \n\n  Two."), ["One.", "Two."]);
    assert.deepEqual(splitClaims("One.\n\tTwo."), ["One.", "Two."]);
  });

  it("`|` is literal text — claims split on sentences, never pipes", () => {
    assert.deepEqual(splitClaims("First claim. Second | third."), [
      "First claim.",
      "Second | third.",
    ]);
  });

  it("CRLF safety: trailing \\r never leaks into a claim", () => {
    assert.deepEqual(splitClaims("One.\r\nTwo.\r\n"), ["One.", "Two."]);
  });

  it("a statement without terminators is one claim; empty statements yield []", () => {
    assert.deepEqual(splitClaims("trailing fragment"), ["trailing fragment"]);
    assert.deepEqual(splitClaims(""), []);
    assert.deepEqual(splitClaims("   \n\t  "), []);
  });

  it("pure splitter: a 9-sentence statement returns 9 claims (the cap is the caller's)", () => {
    const nine = Array.from({ length: 9 }, (_, i) => `Claim number ${i}.`).join(" ");
    assert.equal(splitClaims(nine).length, 9);
  });

  it("deterministic: same statement → identical claim array (byte-stable)", () => {
    const a = splitClaims(STATEMENT);
    const b = splitClaims(STATEMENT);
    assert.deepEqual(a, b);
    assert.strictEqual(JSON.stringify(a), JSON.stringify(b));
  });
});

// ---------------------------------------------------------------------------
// NEGATION_CUES — frozen exported list
// ---------------------------------------------------------------------------

describe("NEGATION_CUES (frozen, versioned contract)", () => {
  it("is frozen and exports exactly the documented cues (fix-round m1 enriched list)", () => {
    assert.ok(Object.isFrozen(NEGATION_CUES));
    assert.deepEqual(NEGATION_CUES, [
      "not",
      "no",
      "never",
      "none",
      "cannot",
      "can't",
      "isn't",
      "aren't",
      "wasn't",
      "weren't",
      "doesn't",
      "don't",
      "didn't",
      "won't",
      "wouldn't",
      // m1: inflected variants spelled out as literal whole-word cues
      // (the parenthesized grammar is gone — every cue is a literal).
      "fail to",
      "fails to",
      "failed to",
      "denies",
      "denied",
      "refutes",
      "refuted",
      "disputes",
      "disputed",
      // m1: missing-absence cues (pre-release ruling).
      "without",
      "lacks",
      "untrue",
      "false",
      "absent",
      "rarely",
      "seldom",
    ]);
  });
});

// ---------------------------------------------------------------------------
// matchClaimsToEvidence — hand-computed verdict fixture
// ---------------------------------------------------------------------------

function runMatcher(claims = splitClaims(STATEMENT)) {
  return matchClaimsToEvidence({ statement: STATEMENT, claims, sources: SOURCES });
}

describe("matchClaimsToEvidence (hand-computed fixture)", () => {
  it("carries the statement verbatim and one row per claim in order", () => {
    const block = runMatcher();
    assert.strictEqual(block.statement, STATEMENT);
    assert.deepEqual(
      block.claims.map((c) => c.text),
      splitClaims(STATEMENT),
    );
  });

  it("claim A: corroborated, 0 cues, evidence [{sourceIndex:0, passageIndex:0}]", () => {
    const claimA = runMatcher().claims[0];
    assert.strictEqual(claimA.verdict, "corroborated");
    assert.strictEqual(claimA.negationCues, 0);
    assert.deepEqual(claimA.evidence, [{ sourceIndex: 0, passageIndex: 0 }]);
  });

  it("claim B: contradicted via the whole-word cue 'never', 1 cue-bearing match", () => {
    const claimB = runMatcher().claims[1];
    assert.strictEqual(claimB.verdict, "contradicted");
    assert.strictEqual(claimB.negationCues, 1);
    assert.deepEqual(claimB.evidence, [{ sourceIndex: 0, passageIndex: 1 }]);
  });

  it("claim C: unresolved — zero matching passages, empty evidence", () => {
    const claimC = runMatcher().claims[2];
    assert.strictEqual(claimC.verdict, "unresolved");
    assert.strictEqual(claimC.negationCues, 0);
    assert.deepEqual(claimC.evidence, []);
  });

  it("claim D: multi-pointer evidence in first-encounter order; cue flips it contradicted", () => {
    const claimD = runMatcher().claims[3];
    assert.strictEqual(claimD.verdict, "contradicted");
    assert.strictEqual(claimD.negationCues, 1);
    // Scan order: S1.p0 first, then S1.p1 — a reversed or sorted pointer
    // list REDs here (the pointer-reorder mutation pin).
    assert.deepEqual(claimD.evidence, [
      { sourceIndex: 1, passageIndex: 0 },
      { sourceIndex: 1, passageIndex: 1 },
    ]);
  });

  it("cue scan is confined to MATCHING passages (S1.p1's cue never leaks into claim A)", () => {
    // S1.p1 ("Nobody ever disputed...") carries cues but matches only
    // claim D — claim A stays corroborated precisely because the cue
    // scan skips non-matching passages.
    const claimA = runMatcher().claims[0];
    assert.strictEqual(claimA.verdict, "corroborated");
  });

  it("negationCues counts cue-bearing MATCHING passages, not distinct cues", () => {
    // One passage carrying two cues ("never" + "disputed") counts ONE.
    const sources = [
      mkSource(0, [
        "Beta turbines never finish; nobody disputed the roadmap work.",
        "Beta turbines idle instead.",
      ]),
    ];
    const block = matchClaimsToEvidence({
      statement: "Beta turbines never finish work.",
      claims: ["Beta turbines never finish work."],
      sources,
    });
    // Both passages match (beta/turbines/finish/work terms); both carry
    // cues ("never"/"disputed" in p0; "instead"? no — p1 carries none).
    assert.strictEqual(block.claims[0].negationCues, 1);
    assert.strictEqual(block.claims[0].verdict, "contradicted");
    assert.deepEqual(block.claims[0].evidence, [
      { sourceIndex: 0, passageIndex: 0 },
      { sourceIndex: 0, passageIndex: 1 },
    ]);
  });

  it("matching is whole-word, case-folded (normalizeTerms semantics)", () => {
    // Case-folds both ways; "rust" inside "rusttrust" is NOT a match.
    const sources = [mkSource(0, ["frustrating rusttrust notes.", "the RUST compiler guide."])];
    const block = matchClaimsToEvidence({
      statement: "The rust compiler exists.",
      claims: ["The rust compiler exists."],
      sources,
    });
    const claim = block.claims[0];
    // Only the whole-word, case-folded passage matches.
    assert.deepEqual(claim.evidence, [{ sourceIndex: 0, passageIndex: 1 }]);
    assert.strictEqual(claim.verdict, "corroborated");
  });

  it("claim terms are stopword-filtered: a stopword-only claim matches nothing", () => {
    const sources = [mkSource(0, ["the and but with over."])];
    const block = matchClaimsToEvidence({
      statement: "The and but.",
      claims: ["The and but."],
      sources,
    });
    assert.strictEqual(block.claims[0].verdict, "unresolved");
  });

  it("cue words are whole-word only: 'nothing' and 'notably' never fire the 'no'/'not' cues", () => {
    const sources = [mkSource(0, ["Gamma sensors record nothing notable."])];
    const block = matchClaimsToEvidence({
      statement: "Gamma sensors record nothing.",
      claims: ["Gamma sensors record nothing."],
      sources,
    });
    assert.strictEqual(block.claims[0].verdict, "corroborated");
    assert.strictEqual(block.claims[0].negationCues, 0);
  });

  it("multi-word cue forms match their literal spellings (fix-round m1: fails/failed to, refutes)", () => {
    const sources = [
      mkSource(0, ["The reactor failed to start. This study refutes that claim about studies."]),
    ];
    const block = matchClaimsToEvidence({
      statement: "Reactors start reliably. Studies hold up.",
      claims: ["Reactors start reliably.", "Studies hold up."],
      sources,
    });
    assert.strictEqual(block.claims[0].verdict, "contradicted"); // "failed to"
    assert.strictEqual(block.claims[1].verdict, "contradicted"); // "refutes"
  });

  it("m1: 'the study fails to replicate' fires the fails-to cue → contradicted", () => {
    const sources = [
      mkSource(0, ["Replication review notes. The study fails to replicate the earlier findings."]),
    ];
    const block = matchClaimsToEvidence({
      statement: "Studies replicate findings.",
      claims: ["Studies replicate findings."],
      sources,
    });
    assert.strictEqual(block.claims[0].verdict, "contradicted");
    assert.strictEqual(block.claims[0].negationCues, 1);
  });

  it("m1: 'without' fires as a whole-word cue", () => {
    const sources = [
      mkSource(0, ["Coverage review text. The schema ships without validation guards entirely."]),
    ];
    const block = matchClaimsToEvidence({
      statement: "Schemas carry validation guards.",
      claims: ["Schemas carry validation guards."],
      sources,
    });
    assert.strictEqual(block.claims[0].verdict, "contradicted"); // "without"
    assert.strictEqual(block.claims[0].negationCues, 1);
  });

  it("m1: 'withouts'-class near-misses never fire (whole-word only)", () => {
    const sources = [
      mkSource(0, ["Falsely tagged content stays neutral when cues embed mid-word."]),
    ];
    const block = matchClaimsToEvidence({
      statement: "Tagged content stays neutral.",
      claims: ["Tagged content stays neutral."],
      sources,
    });
    assert.strictEqual(block.claims[0].verdict, "corroborated");
    assert.strictEqual(block.claims[0].negationCues, 0);
  });

  it("zero sources (every read failed) → every claim unresolved, pack still valid", () => {
    const block = matchClaimsToEvidence({
      statement: STATEMENT,
      claims: splitClaims(STATEMENT),
      sources: [],
    });
    assert.ok(block.claims.every((c) => c.verdict === "unresolved"));
    assert.ok(block.claims.every((c) => c.evidence.length === 0));
  });

  it("deterministic: two runs deep-equal (byte-stable)", () => {
    assert.deepEqual(runMatcher(), runMatcher());
  });
});
