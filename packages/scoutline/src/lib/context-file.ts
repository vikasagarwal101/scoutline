/**
 * Local context source parsing for `--context` / `--context-stdin`
 * (local-context plan, DESIGN.md D2/D3).
 *
 * D2 — pure, deterministic text analysis: `parseContextText` walks the
 * text once, building a positioned document-order stream of
 * (heading | question) items; `terms` and `subQueries` derive from that
 * stream while `headings` / `questions` are per-type projections.
 * `deriveSubQueries`, `buildBiasAppend`, and `slug` are pure helpers on
 * top of the same rules.
 *
 * D3 — `readContextSource` reads a file or stdin through an injected io
 * adapter (`readFile` / `readStdin`), enforces the raw byte cap before
 * decode, applies the NUL-in-first-8KiB binary heuristic, and returns
 * the decoded text plus its sha256. The module owns no fs access of its
 * own so tests and command handlers stay offline-friendly and stdin
 * reads stay owned by the invocation adapter.
 */

import { createHash } from "node:crypto";
import { FileError, ValidationError } from "./errors.js";

/** D3 (G2): byte cap applied to the raw read buffer before decode. */
export const MAX_CONTEXT_BYTES = 262_144; // 256 KiB

/** D2.4: cap on derived sub-queries (the user query is not counted). */
export const MAX_SUBQUERIES = 8;

/** D2.3: cap on derived focus terms. */
export const MAX_TERMS = 12;

/**
 * D2.3: frozen stopword list. Membership tests use the derived
 * `STOPWORD_SET`; the frozen array is the shipped constant.
 */
export const STOPWORDS: readonly string[] = Object.freeze([
  "a", "an", "the", "and", "or", "but", "if", "then", "else", "when",
  "what", "which", "who", "whom", "whose", "why", "how", "this", "that",
  "these", "those", "with", "without", "from", "into", "onto", "for",
  "are", "was", "were", "been", "being", "does", "did", "doing",
  "should", "could", "would", "will", "shall", "can", "may", "might",
  "must", "about", "over", "under", "between", "through", "during",
  "before", "after", "above", "below", "there", "here", "where",
]);

const STOPWORD_SET: ReadonlySet<string> = new Set(STOPWORDS);

/**
 * D2.1: ATX heading pattern — the same pattern family as
 * `parseReportSections` in `src/commands/research.ts`. Deliberately
 * duplicated as a local constant (not imported/shared) so this
 * module's footprint stays off that function.
 */
const HEADING_PATTERN = /^(#{1,6})\s+(.+)$/;

/** D2.2: raw question line length bound (checked before stripping). */
const MAX_QUESTION_CHARS = 200;

/** D2.4: headings longer than this are dropped from sub-queries. */
const MAX_SUBQUERY_HEADING_CHARS = 60;

/** D2.3: term length bounds. Exported: `investigate-planner` shares them. */
export const MIN_TERM_CHARS = 4;
export const MAX_TERM_CHARS = 40;

/** D2.5: the appended bias segment fits within this many chars. */
const MAX_BIAS_APPEND_CHARS = 240;

// ---------------------------------------------------------------------------
// Issue #271: Unicode word segmentation at the shared term seam.
//
// Pure-ASCII input keeps the legacy split verbatim (byte-identical A/B —
// the segmenter would fuse ASCII punctuation into words like "3.14").
// Input containing non-ASCII goes through `Intl.Segmenter` (fixed "en"
// locale, granularity "word" — locale-independent for determinism; en/ja
// agree on CJK corpus). Non-ASCII word-like segments are kept WHOLE: a
// CJK word is a meaningful unit, so the 4-char ASCII minimum never
// applies to them (single CJK chars pass); the 40-char cap still does.
// Length bounds themselves are applied by the CALLERS, not here.
//
// OUT OF SCOPE (documented): negation cues stay English literals —
// non-Latin contradiction detection is not attempted.
// ---------------------------------------------------------------------------

/** The legacy ASCII split class (kept verbatim for the A/B pin). */
const ASCII_SPLIT = /[^a-z0-9]+/;
/** Claims' apostrophe-keeping variant of the legacy split. */
const ASCII_SPLIT_APOSTROPHE = /[^a-z0-9']+/;
/** Journal recall's underscore-keeping variant (identifiers stay whole). */
const ASCII_SPLIT_UNDERSCORE = /[^a-z0-9_]+/;

const SEGMENTER = new Intl.Segmenter("en", { granularity: "word" });

function isAscii(text: string): boolean {
  return /^[\x00-\x7f]*$/.test(text);
}

/**
 * True for pure-ASCII tokens — callers use this to apply the
 * MIN_TERM_CHARS floor to ASCII only (single non-ASCII chars are
 * meaningful word units; issue #271).
 */
export function isAsciiToken(token: string): boolean {
  return isAscii(token);
}

/**
 * Tokenize lowercased text into term tokens: word-like units with
 * ASCII punctuation never inside a non-ASCII token. `keepApostrophe`
 * selects claims' grammar ("don't" stays one token) and
 * `keepUnderscore` journal recall's (snake_case identifiers stay
 * whole tokens) — both on the ASCII path only.
 * Segments longer than MAX_TERM_CHARS are dropped here (not by
 * callers): the "en" segmenter splits long unspaced CJK runs into
 * dictionary chunks (東東×…), so a caller-side length check could
 * admit sub-cap chunks of an over-long word.
 */
export function tokenizeTerms(
  text: string,
  keepApostrophe = false,
  keepUnderscore = false,
): string[] {
  // ponytail: keepApostrophe (claims) and keepUnderscore (journal) are
  // caller-exclusive today; a stacking caller adds the combined class.
  const split = keepUnderscore
    ? ASCII_SPLIT_UNDERSCORE
    : keepApostrophe
      ? ASCII_SPLIT_APOSTROPHE
      : ASCII_SPLIT;
  const lower = text.toLowerCase();
  if (isAscii(lower)) {
    return lower.split(split).filter((t) => t.length > 0);
  }
  const tokens: string[] = [];
  for (const { segment, isWordLike } of SEGMENTER.segment(lower)) {
    if (!isWordLike) continue;
    if (isAscii(segment)) {
      tokens.push(...segment.split(split).filter((t) => t.length > 0));
    } else if (segment.length <= MAX_TERM_CHARS) {
      tokens.push(segment);
    }
  }
  return tokens;
}

/** D3 (G3): NUL byte anywhere in this prefix marks the source binary. */
const BINARY_SNIFF_BYTES = 8192;

export interface ParsedContextText {
  /** In document order, deduped exact-trim (case-sensitive). */
  readonly headings: readonly string[];
  /** In document order, deduped exact, `?` stripped. */
  readonly questions: readonly string[];
  /** <= MAX_TERMS derived, deduped focus terms. */
  readonly terms: readonly string[];
  /** <= MAX_SUBQUERIES document-order interleaved stream (D2.4). */
  readonly subQueries: readonly string[];
}

interface StreamItem {
  readonly kind: "heading" | "question";
  readonly value: string;
}

/**
 * Parse context text into the D2 projections plus the derived streams.
 *
 * The walk is single-pass and deterministic: the interleaved
 * (heading | question) stream is built first (deduped, first-occurrence
 * positions), then `terms` and `subQueries` are derived from it. Lines
 * that match the heading pattern are headings even when they end with
 * `?`; question candidacy requires the raw line to end with `?` and be
 * at most 200 chars before stripping.
 */
export function parseContextText(text: string): ParsedContextText {
  const stream: StreamItem[] = [];
  const headings: string[] = [];
  const questions: string[] = [];
  const seenHeadings = new Set<string>();
  const seenQuestions = new Set<string>();

  for (const rawLine of text.split("\n")) {
    // CRLF sources keep a trailing "\r" after the split; strip it so the
    // question checks below see the same lines on every platform.
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const headingMatch = line.match(HEADING_PATTERN);
    if (headingMatch) {
      const heading = headingMatch[2]!.trim();
      if (heading.length > 0 && !seenHeadings.has(heading)) {
        seenHeadings.add(heading);
        headings.push(heading);
        stream.push({ kind: "heading", value: heading });
      }
      continue;
    }
    if (line.endsWith("?") && line.length <= MAX_QUESTION_CHARS) {
      const question = line.replace(/\?+$/, "").trim();
      if (question.length > 0 && !seenQuestions.has(question)) {
        seenQuestions.add(question);
        questions.push(question);
        stream.push({ kind: "question", value: question });
      }
    }
  }

  return {
    headings,
    questions,
    terms: deriveTerms(stream),
    subQueries: deriveSubQueriesFromStream(stream),
  };
}

/**
 * D2.3: lowercase tokens from the stream, stopword/length filtered,
 * capped. Issue #271: tokens come from the shared Unicode tokenizer —
 * non-ASCII segments are meaningful single units, so the ASCII
 * MIN_TERM_CHARS floor never applies to them (single CJK chars pass);
 * the MAX_TERM_CHARS cap applies to every token.
 */
function deriveTerms(stream: readonly StreamItem[]): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const item of stream) {
    for (const token of tokenizeTerms(item.value)) {
      if (isAscii(token) && token.length < MIN_TERM_CHARS) {
        continue;
      }
      if (token.length > MAX_TERM_CHARS) {
        continue;
      }
      if (STOPWORD_SET.has(token) || seen.has(token)) {
        continue;
      }
      seen.add(token);
      terms.push(token);
      if (terms.length === MAX_TERMS) {
        return terms;
      }
    }
  }
  return terms;
}

/**
 * D2.4: the document-order interleaved sub-query stream. Headings over
 * 60 chars are dropped (not truncated); trailing backslashes are
 * trimmed during derivation so no stream member fuses with the D7 join
 * separator; items that trim to empty are dropped; a heading and a
 * question that reduce to the same string emit once (first occurrence).
 */
function deriveSubQueriesFromStream(stream: readonly StreamItem[]): string[] {
  const subQueries: string[] = [];
  const seen = new Set<string>();
  for (const item of stream) {
    if (item.kind === "heading" && item.value.length > MAX_SUBQUERY_HEADING_CHARS) {
      continue;
    }
    const subQuery = item.value.replace(/\\+$/, "");
    if (subQuery.length === 0) {
      continue;
    }
    if (seen.has(subQuery)) {
      continue;
    }
    seen.add(subQuery);
    subQueries.push(subQuery);
    if (subQueries.length === MAX_SUBQUERIES) {
      break;
    }
  }
  return subQueries;
}

/**
 * Pure helper producing the D2.4 stream directly; equivalent to
 * `parseContextText(text).subQueries` (it delegates there — the parser
 * computes the stream unconditionally in the same pass).
 */
export function deriveSubQueries(text: string): readonly string[] {
  return parseContextText(text).subQueries;
}

/** D4: exact slug-equality key for section/heading matching. */
export function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function biasSegment(terms: readonly string[]): string {
  return ` (focus: ${terms.join(", ")})`;
}

/**
 * D2.5: bias/both query mutation. Returns the query unchanged when
 * there are no terms; otherwise appends ` (focus: <terms>)`, dropping
 * trailing terms until the appended segment fits MAX_BIAS_APPEND_CHARS
 * (at least one term is always retained).
 */
export function buildBiasAppend(query: string, terms: readonly string[]): string {
  if (terms.length === 0) {
    return query;
  }
  const retained = [...terms];
  let segment = biasSegment(retained);
  while (segment.length > MAX_BIAS_APPEND_CHARS && retained.length > 1) {
    retained.pop();
    segment = biasSegment(retained);
  }
  return query + segment;
}

/** D3: which source to read. */
export type ContextSourceKind =
  | { readonly file: string }
  | { readonly stdin: true };

/** Injected io so the module stays test-offline and adapter-owned. */
export interface ContextSourceIo {
  readFile(filePath: string): Promise<Buffer>;
  /**
   * Reads at most `maxBytes` (plus the one chunk that crosses the bound):
   * the caller rejects any over-cap result, so implementations stop early
   * instead of draining an unbounded pipe into memory.
   */
  readStdin(maxBytes: number): Promise<string>;
}

export interface ContextSourceContent {
  readonly text: string;
  /** File source only (G6: always recorded; paths are not secrets). */
  readonly path?: string;
  readonly sha256: string;
  readonly source: "file" | "stdin";
}

export async function readContextSource(
  kind: ContextSourceKind,
  io: ContextSourceIo,
): Promise<ContextSourceContent> {
  if ("file" in kind) {
    const buffer = await readFileChecked(kind.file, io);
    validateBuffer(buffer, `file ${kind.file}`);
    return toContent(buffer, { source: "file", path: kind.file });
  }
  // Stdin arrives already decoded by the invocation adapter; re-encode
  // so the byte cap and binary heuristic see the same units as file
  // sources (a UTF-8 round-trip is byte-exact).
  // Bounded at MAX_CONTEXT_BYTES (+ one chunk): an oversized pipe rejects
  // here with the same VALIDATION_ERROR as an oversized file, instead of
  // being fully buffered first.
  const buffer = Buffer.from(await io.readStdin(MAX_CONTEXT_BYTES), "utf8");
  validateBuffer(buffer, "standard input");
  return toContent(buffer, { source: "stdin" });
}

async function readFileChecked(filePath: string, io: ContextSourceIo): Promise<Buffer> {
  try {
    return await io.readFile(filePath);
  } catch (error) {
    throw toFileError(filePath, error);
  }
}

/** D3: ENOENT/EACCES/EISDIR map to FileError; other errors propagate. */
function toFileError(filePath: string, error: unknown): unknown {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === "ENOENT") {
    return new FileError(`Context file not found: ${filePath}`, "Check the --context path");
  }
  if (code === "EACCES") {
    return new FileError(
      `Permission denied reading context file: ${filePath}`,
      "Check the file permissions on the --context path",
    );
  }
  if (code === "EISDIR") {
    return new FileError(`Context path is a directory: ${filePath}`, "--context expects a file path");
  }
  return error;
}

function validateBuffer(buffer: Buffer, label: string): void {
  if (buffer.length > MAX_CONTEXT_BYTES) {
    throw new ValidationError(
      `Context source exceeds the ${MAX_CONTEXT_BYTES}-byte limit (${buffer.length} bytes)`,
      "Use a smaller context file or trim the piped input",
    );
  }
  if (buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
    throw new FileError(
      `Context source (${label}) appears to be binary`,
      "Provide a UTF-8 text file",
    );
  }
}

function toContent(
  buffer: Buffer,
  meta: { source: "file" | "stdin"; path?: string },
): ContextSourceContent {
  const text = buffer.toString("utf8");
  const sha256 = createHash("sha256").update(text, "utf8").digest("hex");
  return meta.path === undefined
    ? { text, sha256, source: meta.source }
    : { text, sha256, source: meta.source, path: meta.path };
}
