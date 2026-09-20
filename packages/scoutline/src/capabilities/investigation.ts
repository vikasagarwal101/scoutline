/**
 * EvidencePack schema + total decoder (T1, docs/plans/investigate-pipeline
 * PRD AC-6; ADR-0013 §7).
 *
 * The EvidencePack is the self-contained deliverable of an Investigation
 * (CONTEXT.md glossary): question, sub-queries, sources with per-source
 * content hashes and extracted passages, and a coverage block. The pack is
 * data, not prose — agent-synthesis is the contract; `--synthesize` (T7)
 * attaches a `brief` additively and is not part of this schema.
 *
 * This module declares the pack type, its total decoder, and the
 * contentSha256 shape predicate. It imports NOTHING from other src modules
 * (self-contained by ticket contract; hashing itself lands in T5 — this
 * module only validates hash *shape*).
 *
 * Decoder discipline mirrors capabilities/reader.ts exactly:
 *   - accepts `unknown`, returns the pack or `null`, never throws,
 *     never trusts a generic cast;
 *   - reject primitives and arrays at the top level;
 *   - `schemaVersion` MUST be the literal number 1 (rejects "1", 1.5,
 *     bigints, any future version);
 *   - `title: null` is a valid decoded value (reader parity);
 *   - optional fields preserved verbatim when present.
 */

// ---------------------------------------------------------------------------
// Pack schema (PRD AC-6)
// ---------------------------------------------------------------------------

/** `[start, end)` character offsets into the source `content` string. */
export type CharRange = readonly [number, number];

/**
 * One extracted passage. `quote` is pinned to the content by `charRange`:
 * `content.slice(...charRange) === quote` for every passage (D4). The pin
 * is enforced where content is available (assembly in T5, extraction in
 * T3); the decoder enforces the shape so a decoded pack is at least
 * structurally sound.
 */
export interface EvidencePassage {
  readonly quote: string;
  readonly charRange: CharRange;
}

/** One read source: reader-envelope fields + passages. */
export interface EvidenceSource {
  readonly url: string;
  /** The URL the Reader actually fetched (provider rewrite possible). */
  readonly finalUrl: string;
  /** Page title if the provider returned one; `null` if absent (reader parity). */
  readonly title: string | null;
  /** ISO-8601 UTC Z timestamp captured when the read resolved (D5). */
  readonly fetchedAt: string;
  /** Provider id that surfaced the source (search-arm winner). */
  readonly provider: string;
  /** Mirrors the read `format`; `"markdown"` or `"text"`. */
  readonly contentFormat: "markdown" | "text";
  /** Lowercase hex SHA-256 of the UTF-8 normalized content string (D5). */
  readonly contentSha256: string;
  readonly passages: readonly EvidencePassage[];
}

/** Coverage block: how much of the planned grid actually produced evidence. */
export interface EvidenceCoverage {
  /** Number of planned sub-queries. */
  readonly subQueries: number;
  /** Number of search arms actually used. */
  readonly armsUsed: number;
  /** Number of post-cluster candidate sources surfaced. */
  readonly sourcesConsidered: number;
  /** Number of sources whose read resolved successfully. */
  readonly sourcesRead: number;
  /** Count of search arms + reads served warm from cache (D5). */
  readonly cacheHits: number;
  /**
   * Sources surfaced but not read, each with a reason code only —
   * redacted, no error prose crossing the interface (house rule, D5).
   */
  readonly unread: readonly { readonly url: string; readonly reason: string }[];
}

/** The self-contained Investigation deliverable (PRD AC-6). */
export interface EvidencePack {
  readonly schemaVersion: 1;
  readonly question: string;
  readonly subQueries: readonly string[];
  readonly sources: readonly EvidenceSource[];
  readonly coverage: EvidenceCoverage;
}

// ---------------------------------------------------------------------------
// Field predicates
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * `contentSha256` validity: a 64-character lowercase hex string —
 * the exact shape of `createHash("sha256")…digest("hex")` output.
 * Ruling (ticket T1): hex-shape is enforced at decode, so an
 * uppercased, truncated, or non-hex string fails closed. Full
 * recompute-vs-content binding belongs to assembly (T5), which is the
 * only place the paired content string exists.
 */
export function isValidContentSha256(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== 64) return false;
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    const isDigit = code >= 48 && code <= 57;
    const isLowerHex = (code >= 97 && code <= 102) || isDigit;
    if (!isLowerHex) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Total decoder
// ---------------------------------------------------------------------------

function decodeCharRange(value: unknown): value is CharRange {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    isFiniteNumber(value[0]) &&
    isFiniteNumber(value[1])
  );
}

function decodePassage(value: unknown): EvidencePassage | null {
  if (!isPlainObject(value)) return null;
  if (!isNonEmptyString(value.quote)) return null;
  if (!decodeCharRange(value.charRange)) return null;
  return { quote: value.quote, charRange: [value.charRange[0], value.charRange[1]] };
}

function decodeSource(value: unknown): EvidenceSource | null {
  if (!isPlainObject(value)) return null;
  if (!isNonEmptyString(value.url)) return null;
  if (!isNonEmptyString(value.finalUrl)) return null;
  const title = value.title;
  if (title !== null && typeof title !== "string") return null;
  if (!isNonEmptyString(value.fetchedAt)) return null;
  if (!isNonEmptyString(value.provider)) return null;
  if (value.contentFormat !== "markdown" && value.contentFormat !== "text") return null;
  if (!isValidContentSha256(value.contentSha256)) return null;
  if (!Array.isArray(value.passages)) return null;

  const passages: EvidencePassage[] = [];
  for (const raw of value.passages) {
    const passage = decodePassage(raw);
    if (passage === null) return null;
    passages.push(passage);
  }
  return {
    url: value.url,
    finalUrl: value.finalUrl,
    title: title as string | null,
    fetchedAt: value.fetchedAt,
    provider: value.provider,
    contentFormat: value.contentFormat,
    contentSha256: value.contentSha256,
    passages,
  };
}

function decodeCoverage(value: unknown): EvidenceCoverage | null {
  if (!isPlainObject(value)) return null;
  if (!isFiniteNumber(value.subQueries)) return null;
  if (!isFiniteNumber(value.armsUsed)) return null;
  if (!isFiniteNumber(value.sourcesConsidered)) return null;
  if (!isFiniteNumber(value.sourcesRead)) return null;
  if (!isFiniteNumber(value.cacheHits)) return null;
  if (!Array.isArray(value.unread)) return null;
  const unread: { url: string; reason: string }[] = [];
  for (const raw of value.unread) {
    if (!isPlainObject(raw)) return null;
    if (!isNonEmptyString(raw.url)) return null;
    if (!isNonEmptyString(raw.reason)) return null;
    unread.push({ url: raw.url, reason: raw.reason });
  }
  return {
    subQueries: value.subQueries,
    armsUsed: value.armsUsed as number,
    sourcesConsidered: value.sourcesConsidered,
    sourcesRead: value.sourcesRead,
    cacheHits: value.cacheHits as number,
    unread,
  };
}

/**
 * Decode an `unknown` value into a canonical `EvidencePack`. Returns the
 * typed pack on success, `null` for any malformed value. NEVER throws,
 * NEVER trusts a generic cast.
 *
 * `title: null` is valid (reader parity). `sources` and `passages` may be
 * empty arrays (a pack whose every read failed is still a valid, sad pack).
 * `brief` (T7) is additive: unknown keys are NOT rejected — a decoded pack
 * carries exactly the AC-6 keys, and an input carrying extra keys decodes
 * to the canonical subset.
 */
export function decodeInvestigationPack(value: unknown): EvidencePack | null {
  if (!isPlainObject(value)) return null;
  if (value.schemaVersion !== 1) return null;
  if (!isNonEmptyString(value.question)) return null;
  if (!Array.isArray(value.subQueries)) return null;
  for (const q of value.subQueries) {
    if (!isNonEmptyString(q)) return null;
  }
  if (!Array.isArray(value.sources)) return null;
  const sources: EvidenceSource[] = [];
  for (const raw of value.sources) {
    const source = decodeSource(raw);
    if (source === null) return null;
    sources.push(source);
  }
  const coverage = decodeCoverage(value.coverage);
  if (coverage === null) return null;
  return {
    schemaVersion: 1,
    question: value.question,
    subQueries: [...value.subQueries],
    sources,
    coverage,
  };
}
