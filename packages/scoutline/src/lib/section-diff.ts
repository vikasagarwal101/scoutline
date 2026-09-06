/**
 * Section-diff engine (watch-temporal-diff lane B, ticket T1).
 *
 * Pure primitives shared by `archive diff` and the `watch` family:
 *   - `extractSections(raw, charsetHint?)` — decode (charset hint, default
 *     UTF-8) and bucket a document into ordered heading/paragraph sections
 *     with a lenient tag scanner that survives 2001-era archived markup:
 *     uppercase tags (`<H1>`), missing closers (`<H1>Title<p>text`), and
 *     attribute-laden tags. Deliberately NOT a strict DOM parser — zero
 *     dependencies, garbage-tolerant.
 *   - `diffSections(a, b)` — heading-anchored structural diff
 *     (`{added, removed, changed}` as heading texts; untitled lead
 *     sections pair positionally under the identifier `(intro)`).
 *   - `diffDocuments(a, b)` — extraction-result pairing: both sides
 *     extracted → section diff; any extraction failure degrades to the
 *     raw-hash verdict, the fallback for non-HTML bytes.
 *   - `hashRaw(raw)` — sha256 hex over RAW bytes (never the decoded
 *     string), so identical text under different encodings still hashes
 *     differently.
 *
 * Normalization: comparison collapses whitespace runs (including NBSP)
 * to single spaces before heading/body equality — minor reformatting is
 * not a change; a heading reword is removed+added, never changed.
 *
 * Purity: no I/O, no fs/net/process.env, no command or provider imports.
 * Only `node:crypto` (hashing) plus the global TextDecoder.
 */
import { createHash } from "node:crypto";

/** One extracted section: a heading (or `null` for untitled lead text). */
export interface Section {
  readonly heading: string | null;
  readonly body: string;
}

/**
 * Success extraction result: ordered section buckets. Carries the raw-
 * byte hash so {@link diffDocuments} can fall back without re-reading.
 */
export interface ExtractedSections {
  readonly ok: true;
  readonly sections: Section[];
  readonly hash: string;
}

/** Failed extraction: bytes are not HTML-shaped, caller falls back to hashing. */
export interface ExtractionFailure {
  readonly ok: false;
  readonly reason: "no-html";
  readonly hash: string;
}

export type ExtractionResult = ExtractedSections | ExtractionFailure;

/** Structural diff identifiers: heading texts (or position placeholders). */
export interface SectionDiff {
  readonly added: string[];
  readonly removed: string[];
  readonly changed: string[];
}

/** Document-level outcome: section diff, or hash verdict for non-HTML. */
export interface DocumentDiff extends SectionDiff {
  readonly hashOnly: boolean;
}

/**
 * HTML media-type gate (review: classify by Content-Type, not by byte
 * sniffing): extraction is structural ONLY for HTML responses. A
 * `text/plain` or `application/json` body that happens to contain an
 * `<x>`-like token must go down the hash-only path — otherwise two
 * different plain-text bodies can extract identical (empty) section
 * lists and report a silent no-change instead of a `(hash)` verdict.
 * Unknown/missing content types keep the legacy sniff path (old
 * Wayback replays often carry none). Returns null = "unknown": the
 * caller falls back to extractSections' own HTML-shaped detection.
 */
export function isHtmlContentType(contentType?: string): boolean | null {
  if (contentType === undefined) return null;
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (type === "") return null;
  if (type === "text/html" || type === "application/xhtml+xml") return true;
  return false;
}

/** Placeholder identifier for the untitled lead section. */
const INTRO_ID = "(intro)";
/** Placeholder identifier reported when only the raw-byte hash is compared. */
const HASH_ID = "(hash)";

/**
 * Decode raw bytes to text under `charsetHint` (default UTF-8). Unknown or
 * unsupported labels fall back to UTF-8 — extraction-only; hashes always
 * stay over raw bytes.
 */
function decodeText(raw: Uint8Array, charsetHint?: string): string {
  const label = charsetHint?.trim().toLowerCase();
  try {
    return new TextDecoder(label || "utf-8", { fatal: false }).decode(raw);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(raw);
  }
}

/** Collapse whitespace runs (incl. NBSP) to single spaces and trim. */
function normalizeText(text: string): string {
  return text.replace(/[\s ]+/gu, " ").trim();
}

/** Strip tags and unescape the small set of entities old markup leans on. */
function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&");
}

/**
 * Elements whose content is metadata/script noise, dropped from buckets.
 * With paired close tags only — `meta`/`link` are VOID: they never close,
 * so a skip region must never be opened for them (a void `<meta ...>` would
 * otherwise swallow every following token to end of document).
 */
const SKIPPED_ELEMENTS = new Set(["script", "style", "head", "title"]);

/** Inline elements whose tags never break text flow. */
const INLINE_TAGS = new Set([
  "a",
  "b",
  "i",
  "em",
  "strong",
  "span",
  "code",
  "small",
  "sub",
  "sup",
  "u",
  "s",
  "abbr",
  "cite",
  "kbd",
  "mark",
  "q",
  "time",
  "font",
  "big",
]);

/** Block-level text breaks — enough section shape without a DOM tree. */
const BLOCK_TAGS = new Set([
  "p",
  "div",
  "br",
  "li",
  "tr",
  "table",
  "blockquote",
  "pre",
  "ul",
  "ol",
  "dl",
  "dd",
  "dt",
  "article",
  "section",
  "header",
  "footer",
  "nav",
  "aside",
  "main",
]);

/**
 * Extract ordered heading/paragraph sections from raw bytes.
 *
 * A single forward scan tokenizes tags case-insensitively, tolerates
 * missing closers and arbitrary attributes, and flushes a text buffer as
 * a new section whenever a heading (`h1`..`h6`) opens; other block tags
 * merely separate paragraphs inside the current section's body.
 */
export function extractSections(
  raw: Uint8Array,
  charsetHint?: string,
): ExtractionResult {
  if (raw.length === 0) {
    return { ok: true, sections: [], hash: hashRaw(raw) };
  }
  const decoded = decodeText(raw, charsetHint);
  const sections: Section[] = [];
  let currentHeading: string | null = null;
  let bodyChunks: string[] = [];
  let sawHtmlTag = false;
  let sawHeading = false;
  let skipUntil: string | null = null;
  let headingTag: string | null = null;
  let headingChunks: string[] = [];
  let inComment = false;
  // Tokenize on tags, honoring quoted attribute values first: `<a
  // title="1 > 0">` must land in ONE token, not split at the `>` inside
  // the quotes (splitting leaks `0">` into body text and false-diffs).
  const textParts = decoded.split(/(<(?:[^>"']|"[^"]*"|'[^']*')*>)/g);
  for (const part of textParts) {
    // HTML comments are not document text: a changed `<!-- retired
    // copy -->` must never produce a content diff. A comment containing
    // `>` splits across parts, so containment runs until `-->`.
    if (inComment) {
      if (part.includes("-->")) inComment = false;
      continue;
    }
    if (part.startsWith("<!--")) {
      if (!part.includes("-->")) inComment = true;
      continue;
    }
    // Doctype declarations are not document text: an HTML4→HTML5
    // doctype change must not report a content diff.
    if (/^<!doctype/i.test(part)) continue;
    // Skip-region containment: while inside an unclosed <script>/<style>/
    // <head>/<title>, everything — including tags and stray <h_> tokens —
    // is content noise. Recovery: the exact CLOSE tag ends the region
    // (a nested re-open does not; recovery still terminates at EOF since
    // the loop runs to end of document).
    if (skipUntil !== null) {
      if (new RegExp(`^<\\s*/\\s*${skipUntil}\\s*>$`, "i").test(part)) {
        skipUntil = null;
      }
      continue;
    }
    const match = part.startsWith("<") && part.length > 1
      ? /^<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9]*)/.exec(part)
      : null;
    if (match) {
      const isClose = (match[1] ?? "") === "/";
      const tag = (match[2] ?? "").toLowerCase();
      sawHtmlTag = true;
      // Skipped elements are checked BEFORE the heading branch so
      // `<h1>Doc <script>noise()</script> Title</h1>` drops the script
      // content but keeps the heading text (`meta`/`link` are void and
      // never open a skip region — see SKIPPED_ELEMENTS).
      if (SKIPPED_ELEMENTS.has(tag) && !isClose) {
        skipUntil = tag;
        continue;
      }
      if (headingTag !== null) {
        // Inside a heading: its own close ends it; a NEW heading open or
        // a BLOCK open also ends it (old markup never closed things).
        // INLINE closes (`</b>`, `</em>`) do NOT — `<h1>Hello
        // <b>world</b> again</h1>` keeps `again` in the heading.
        const endsHeading =
          (isClose && tag === headingTag) ||
          (!isClose && /^h[1-6]$/.test(tag)) ||
          (!isClose && BLOCK_TAGS.has(tag));
        if (endsHeading) {
          const headingText = normalizeText(decodeEntities(headingChunks.join("")));
          // A heading always emits its own section, even when the old
          // section has no body — two consecutive headings must not
          // merge into one bucket (`<h1>A</h1><h2>B</h2>` yields two).
          flushSection(sections, currentHeading, bodyChunks);
          currentHeading = headingText === "" ? null : headingText;
          bodyChunks = [];
          headingTag = null;
          headingChunks = [];
          sawHeading = true;
          if (!isClose && /^h[1-6]$/.test(tag)) {
            headingTag = tag;
            headingChunks = [];
          }
        }
        continue;
      }
      if (/^h[1-6]$/.test(tag) && !isClose) {
        headingTag = tag;
        headingChunks = [];
        sawHeading = true;
        continue;
      }
      if (!isClose && BLOCK_TAGS.has(tag) && !INLINE_TAGS.has(tag) && bodyChunks.length > 0) {
        bodyChunks.push("\n\n");
      }
      continue;
    }
    const text = decodeEntities(part);
    if (headingTag !== null) {
      headingChunks.push(text);
      continue;
    }
    if (text.trim() !== "") bodyChunks.push(text);
  }
  // Missing heading closer (old markup): flush the buffered heading anyway.
  if (headingTag !== null) {
    const headingText = normalizeText(decodeEntities(headingChunks.join("")));
    flushSection(sections, currentHeading, bodyChunks);
    currentHeading = headingText === "" ? null : headingText;
  }
  flushSection(sections, currentHeading, bodyChunks);
  if (!sawHtmlTag) return { ok: false, reason: "no-html", hash: hashRaw(raw) };
  // HTML detection saw a tag but no heading and no text survived (e.g.
  // an unclosed <script> swallowed the document): NOT a credible
  // structural extraction — degrade to the hash-only verdict instead of
  // reporting a false empty-section diff.
  if (!sawHeading && sections.length === 0) {
    return { ok: false, reason: "no-html", hash: hashRaw(raw) };
  }
  return { ok: true, sections, hash: hashRaw(raw) };
}

/** Append the pending section unless it is completely empty. */
function flushSection(
  sections: Section[],
  heading: string | null,
  bodyChunks: readonly string[],
): void {
  const body = normalizeText(bodyChunks.join("")).replace(/\s+([.,;:!?])/gu, "$1");
  if (heading === null && body === "") return;
  sections.push({ heading, body });
}

/** Sortable key pairing heading text with its ordinal among duplicates. */
function sectionKey(heading: string | null, ordinal: number): string {
  return `${heading ?? " "}#${ordinal}`;
}

/**
 * Heading-anchored structural diff over two extracted section lists.
 *
 * Matched by normalized heading text (duplicates pair ordinally in source
 * order); identical heading + identical normalized body = no change,
 * different body = changed. Headings present on only one side are added
 * or removed — a heading reword therefore reports removed+added, never
 * changed. Untitled lead sections pair positionally and report as
 * `(intro)` when their body changed. Output arrays follow source order.
 */
export function diffSections(a: readonly Section[], b: readonly Section[]): SectionDiff {
  const ordinalsOf = (sections: readonly Section[]) => {
    const seen = new Map<string, number>();
    return sections.map((section) => {
      const key = section.heading ?? " ";
      const ordinal = seen.get(key) ?? 0;
      seen.set(key, ordinal + 1);
      return sectionKey(section.heading, ordinal);
    });
  };
  const aKeys = ordinalsOf(a);
  const bKeys = ordinalsOf(b);
  const aIndex = new Map(aKeys.map((key, i) => [key, i]));
  const changed: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  const matchedA = new Set<number>();
  const identify = (section: Section): string => section.heading ?? INTRO_ID;
  b.forEach((section, j) => {
    const i = aIndex.get(bKeys[j] ?? "");
    if (i === undefined) {
      added.push(identify(section));
      return;
    }
    matchedA.add(i);
    if (normalizeBody(a[i]?.body ?? "") !== normalizeBody(section.body)) {
      changed.push(identify(section));
    }
  });
  a.forEach((section, i) => {
    if (!matchedA.has(i)) removed.push(identify(section));
  });
  return { added, removed, changed };
}

/** Body normalization alias — same rule as headings, applied to bodies. */
function normalizeBody(body: string): string {
  return normalizeText(body);
}

/**
 * Diff two extraction results at the document level.
 *
 * Both sides extracted → straight into the structural section diff —
 * there is NO whole-document byte-identical short-circuit on this
 * path; equal bytes just happen to yield equal sections (empty diff).
 * Callers wanting the cheap equality check compare the `hash` fields
 * before calling. Any extraction failure (either side) degrades to
 * the hash-only path: sha256 over the RAW bytes, changed reported as
 * `(hash)` — identical non-HTML bytes → no change, any byte
 * difference → change.
 */
export function diffDocuments(a: ExtractionResult, b: ExtractionResult): DocumentDiff {
  if (a.ok && b.ok) {
    return { ...diffSections(a.sections, b.sections), hashOnly: false };
  }
  return {
    added: [],
    removed: [],
    changed: a.hash === b.hash ? [] : [HASH_ID],
    hashOnly: true,
  };
}

/**
 * Forced hash-only extraction (review Content-Type gate): the media
 * type says non-HTML, so structural extraction is skipped entirely and
 * the result is the same failure shape extractSections produces for
 * non-HTML-shaped bytes — {@link diffDocuments} then lands on the
 * raw-hash verdict.
 */
export function extractSectionsHashOnly(raw: Uint8Array): ExtractionFailure {
  return { ok: false, reason: "no-html", hash: hashRaw(raw) };
}

/**
 * sha256 hex digest over raw bytes — never over the decoded string, so
 * the same text encoded UTF-8 vs GBK hashes differently.
 */
export function hashRaw(raw: Uint8Array): string {
  return createHash("sha256").update(raw).digest("hex");
}
