/**
 * Deterministic claim splitting + claim↔evidence matching for
 * `investigate --verify` (investigate-verify lane, Ticket T1; DESIGN
 * D2, PRD AC-2/AC-4/AC-5).
 *
 * splitClaims: the extract grammar's terminator rules verbatim
 * (lib/investigate-extract.ts splitWindows) — `[.!?]` followed by a
 * space (or end of input), or a newline; the terminator char belongs
 * to the window, the separator run (spaces/tabs) to neither. The
 * splitter is PURE: the ≤ 8 claim cap is the CALLER's fail-loud
 * validation (commands/investigate.ts, T3) — a 9-sentence statement
 * returns 9 claims here, never a throw, never a truncation.
 *
 * matchClaimsToEvidence: zero-model, deterministic. Per claim —
 * terms = normalizeTerms over the claim's stopword-filtered tokens
 * (reused from lib/investigate-extract.ts, imports only); a passage
 * matches when any term appears whole-word case-folded in
 * passage.quote; the negation-cue scan runs over MATCHING passages
 * only; evidence pointers land in first-encounter order (source
 * order, then passage order); negationCues counts cue-bearing
 * matching passages.
 *
 * Byte-stable: no clocks, no randomness, no locale-dependent casing
 * beyond toLowerCase.
 */

import { STOPWORDS } from "./context-file.js";
import { normalizeTerms } from "./investigate-extract.js";
import type { EvidenceSource } from "../capabilities/investigation.js";

// ---------------------------------------------------------------------------
// Claim splitting (extract-grammar terminators)
// ---------------------------------------------------------------------------

const STOPWORD_SET: ReadonlySet<string> = new Set(STOPWORDS);

/**
 * The verify-mode claim cap (PRD AC-1: > 8 sentence-claims is a
 * fail-loud VALIDATION_ERROR, the R1 pipe-cap precedent — fail, never
 * truncate). Exported so the command's error message names the cap
 * from the single source of truth.
 */
export const MAX_VERIFY_CLAIMS = 8;

/** A window [start, end) with the terminator char owned by the window. */
interface Window {
  start: number;
  end: number;
}

/**
 * Split input into sentence windows on the extract grammar: `[.!?]`
 * followed by a space (or end of input), plus newline boundaries.
 * Pinned to lib/investigate-extract.ts splitWindows — a decimal like
 * "3.14" has no space after the dot, so it never terminates.
 */
function splitWindows(content: string): Window[] {
  const windows: Window[] = [];
  let start = 0;
  for (let i = 0; i < content.length; i += 1) {
    const ch = content.charAt(i);
    const next = content.charAt(i + 1);
    const isTerminator =
      (ch === "." || ch === "!" || ch === "?") &&
      (i + 1 >= content.length || next === " ");
    const isNewline = ch === "\n";
    if (!isTerminator && !isNewline) {
      continue;
    }
    const end = i + 1; // terminator char owned by the window
    windows.push({ start, end });
    // Skip the horizontal-whitespace separator run; the next window
    // starts at the first character that is neither space nor tab.
    let cursor = end;
    while (cursor < content.length) {
      const sep = content.charAt(cursor);
      if (sep !== " " && sep !== "\t") {
        break;
      }
      cursor += 1;
    }
    start = cursor;
    i = cursor - 1; // loop increment lands on `cursor`
  }
  if (start < content.length) {
    windows.push({ start, end: content.length });
  }
  return windows;
}

/**
 * Split a statement into sentence-claims: extract-grammar windows,
 * whitespace-only sentences dropped, quotes trimmed. Deterministic —
 * the same statement yields the identical claim array byte-stably.
 * `|` needs no handling: claims split on sentences, never pipes.
 */
export function splitClaims(statement: string): string[] {
  const claims: string[] = [];
  for (const window of splitWindows(statement)) {
    const claim = statement.slice(window.start, window.end).trim();
    if (claim.length > 0) {
      claims.push(claim);
    }
  }
  return claims;
}

// ---------------------------------------------------------------------------
// Negation cues (frozen, versioned contract — PRD AC-5)
// ---------------------------------------------------------------------------

/**
 * The negation-cue list behind `contradicted`. FROZEN and versioned:
 * additions change verdicts and are release-visible (the parent-owned
 * CHANGELOG bullet names them). Multi-word forms are mini-grammars in
 * parentheses: `fail(ed) to` = "fail to" | "failed to"; `denie(s/d)` =
 "denie" | "denies" | "denied"; refute(s/d) and dispute(s/d) likewise.
 *
 * DISCLOSED as hint-grade: `contradicted` means "a term-matching
 * passage carries a negation cue", NOT semantic contradiction —
 * semantic judgment stays with the calling agent (agent-synthesis
 * contract); the per-claim cue count exists for exactly that
 * re-judgment.
 */
export const NEGATION_CUES: readonly string[] = Object.freeze([
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
  "fail(ed) to",
  "denie(s/d)",
  "refute(s/d)",
  "dispute(s/d)",
]);

/** Expand a cue's parenthesized inflection grammar into its literals. */
function cueExpansions(cue: string): string[] {
  const match = cue.match(/^(.*?)\((.*?)\)(.*)$/);
  if (match === null) return [cue];
  const prefix = match[1]!;
  const alts = match[2]!;
  const suffix = match[3]!;
  return alts.split("/").filter((a) => a.length > 0).map((alt) => `${prefix}${alt}${suffix}`);
}

const CUE_LITERALS: readonly string[] = Object.freeze(
  NEGATION_CUES.flatMap(cueExpansions),
);

// ---------------------------------------------------------------------------
// Claim↔evidence matching
// ---------------------------------------------------------------------------

/** The deterministic verdict vocabulary (PRD AC-5). */
export type ClaimVerdict = "corroborated" | "contradicted" | "unresolved";

/** One evidence pointer into the pack's own sources array. */
export interface ClaimEvidencePointer {
  readonly sourceIndex: number;
  readonly passageIndex: number;
}

/** One claim row: text, verdict, cue count, evidence pointers. */
export interface ClaimRow {
  readonly text: string;
  readonly verdict: ClaimVerdict;
  /** Number of cue-bearing MATCHING passages (agent re-judgment input). */
  readonly negationCues: number;
  readonly evidence: readonly ClaimEvidencePointer[];
}

/** The additive verify block (PRD AC-6): statement + per-claim rows. */
export interface VerifyBlock {
  readonly statement: string;
  readonly claims: readonly ClaimRow[];
}

export interface MatchClaimsArgs {
  readonly statement: string;
  readonly claims: readonly string[];
  readonly sources: readonly EvidenceSource[];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsWholeWord(content: string, term: string): boolean {
  const re = new RegExp(
    `(^|[^\\p{L}\\p{N}_])${escapeRegExp(term)}(?:[^\\p{L}\\p{N}_]|$)`,
    "iu",
  );
  return re.test(content);
}

/** Claim terms: lowercase tokens, stopword-filtered, normalizeTerms-dedupe. */
function claimTerms(claim: string): string[] {
  const tokens = claim
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .filter((t) => t.length > 0 && !STOPWORD_SET.has(t));
  return normalizeTerms(tokens);
}

/**
 * Match claims to evidence: per claim, every (source, passage) whose
 * quote contains ≥ 1 claim term whole-word case-folded becomes an
 * evidence pointer in first-encounter order; the cue scan runs over
 * matching passages only; the verdict follows PRD-5 (corroborated =
 * matches + 0 cues; contradicted = ≥ 1 cue-bearing match; unresolved
 * = no matches).
 */
export function matchClaimsToEvidence({ statement, claims, sources }: MatchClaimsArgs): VerifyBlock {
  const rows: ClaimRow[] = claims.map((text) => {
    const terms = claimTerms(text);
    const evidence: ClaimEvidencePointer[] = [];
    let cueBearers = 0;
    sources.forEach((source, sourceIndex) => {
      source.passages.forEach((passage, passageIndex) => {
        const matched = terms.some((term) => containsWholeWord(passage.quote, term));
        if (!matched) return;
        evidence.push({ sourceIndex, passageIndex });
        const carriesCue = CUE_LITERALS.some((cue) =>
          containsWholeWord(passage.quote.toLowerCase(), cue),
        );
        if (carriesCue) cueBearers += 1;
      });
    });
    const verdict: ClaimVerdict =
      evidence.length === 0 ? "unresolved" : cueBearers > 0 ? "contradicted" : "corroborated";
    return { text, verdict, negationCues: cueBearers, evidence };
  });
  return { statement, claims: rows };
}
