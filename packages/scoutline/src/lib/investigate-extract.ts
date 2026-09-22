/**
 * Deterministic passage extraction for the investigate pipeline
 * (T3, docs/plans/investigate-pipeline DESIGN D4, PRD AC-5).
 *
 * Splits content into sentence windows with character-index tracking,
 * keeps the windows containing >= 1 term as a whole word (case-folded),
 * dedupes by exact quote equality, caps at 5 first-encounter passages.
 *
 * Boundary-char ownership: the terminator that ended a window
 * (`.`/`!`/`?`/`\n`) belongs to the window; the separator run
 * (spaces/tabs after a terminator) belongs to neither window. The
 * round-trip pin — content.slice(...charRange) === quote for every
 * passage — holds byte-exactly under this rule, and is invariant to
 * it (any slicing convention preserves the pin).
 *
 * Byte-stable: no clocks, no randomness, no locale-dependent casing
 * beyond toLowerCase. Self-contained: no imports.
 */

export interface Passage {
  quote: string;
  charRange: [number, number];
}

export interface ExtractPassagesArgs {
  content: string;
  terms: string[];
}

const MAX_PASSAGES = 5;

/** Normalize the term set: trim, case-fold, drop empties, dedupe. */
export function normalizeTerms(terms: string[]): string[] {
  const seen = new Set<string>();
  for (const term of terms) {
    const normalized = term.trim().toLowerCase();
    if (normalized.length > 0) {
      seen.add(normalized);
    }
  }
  return [...seen];
}

/** A window is [start, end) with the terminator char owned by the window. */
interface Window {
  start: number;
  end: number;
}

/**
 * Split content into sentence windows on `[.!?]` terminators followed
 * by a space (the literal `[.!?] +` grammar), plus newline
 * boundaries, tracking exact offsets into the original content.
 * Newlines terminate but never separate: "here.\n" ends at the `\n`.
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
 * Whole-word containment. ASCII terms keep the boundary guard;
 * non-ASCII terms match as substrings — unspaced scripts (CJK) have
 * no word separators, so the boundary class can never fire between
 * letters (issue #271).
 */
function containsWholeWord(content: string, term: string): boolean {
  const asciiTerm = /^[\x00-\x7f]*$/.test(term);
  const body = escapeRegExp(term);
  const re = new RegExp(
    asciiTerm
      ? `(^|[^\\p{L}\\p{N}_])${body}(?:[^\\p{L}\\p{N}_]|$)`
      : body,
    "iu",
  );
  return re.test(content);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Extract passages: sentence windows of `content` containing >= 1 of
 * `terms` as a whole word (case-folded), deduped by exact quote,
 * capped at 5 first-encounter. Empty term set -> [] (valid).
 */
export function extractPassages({ content, terms }: ExtractPassagesArgs): Passage[] {
  const normalized = normalizeTerms(terms);
  if (normalized.length === 0) {
    return [];
  }
  const seenQuotes = new Set<string>();
  const passages: Passage[] = [];
  for (const window of splitWindows(content)) {
    const quote = content.slice(window.start, window.end);
    if (
      normalized.some((term) => containsWholeWord(quote, term)) &&
      !seenQuotes.has(quote)
    ) {
      seenQuotes.add(quote);
      passages.push({ quote, charRange: [window.start, window.end] });
      if (passages.length >= MAX_PASSAGES) {
        break;
      }
    }
  }
  return passages;
}
