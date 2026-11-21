/**
 * Deterministic release-manifest document producer (v3 structured
 * document extraction, first slice).
 *
 * One declared grammar: public/synthetic UTF-8 release manifests whose
 * lines are exactly `Label: value` — label at column 0, a single space,
 * then one non-space value token. Line endings are LF or CRLF, freely
 * mixed per line; spans are always computed on the ORIGINAL text (a
 * CRLF line's quote excludes the trailing \r but keeps its original
 * offsets). Exact `Version` and `License` labels are bound to the
 * `version` and `license` fields.
 *
 * Order of operations is structural, not caller-dependent:
 * well-formed-UTF-16 check → byte ceiling → SHA-256 digest → parse.
 * A malformed or over-ceiling source aborts BEFORE any hashing or
 * parsing (pre-abort), with a typed ValidationError.
 *
 * The producer PROPOSES candidates only. It binds each proposal to the
 * exact retained source text with half-open UTF-16 charRanges and
 * abstains (value:null, quote:null) when a label is missing or is
 * CLAIMED on more than one line — every line starting `${label}:`
 * counts as a claim, whether or not its value is a grammar token
 * (including two IDENTICAL lines and malformed-value duplicates). It
 * never picks the first of conflicting labels and never invents values.
 * Acceptance stays with the
 * shared engine: validateCandidates / assessCandidates / acceptCandidate
 * (lean-candidates). Manifest parsing is separate from evidence
 * acceptance by construction — this module knows nothing about judges.
 *
 * The producer serves only the field subset it was admitted for
 * (create(fields)); a request naming any other field is refused loudly,
 * never silently served.
 *
 * No binary/OCR adapters and no model calls: the parse is pure text
 * scanning over the exact retained representation.
 */

import { createHash } from "node:crypto";
import { ValidationError } from "./errors.js";
import { LEAN_LIMIT_CEILINGS } from "./lean-investigation.js";
import type { ExtractorAttempt, ExtractorDeps, ExtractorRequest } from "./lean-candidates.js";

// ---------------------------------------------------------------------------
// Grammar declaration (fixed vocabulary; callers cannot add labels)
// ---------------------------------------------------------------------------

export const RELEASE_MANIFEST_GRAMMAR_ID = "release-manifest@1" as const;
export const RELEASE_MANIFEST_PRODUCER_REVISION = "release-manifest-parse-5" as const;

/** Field id -> exact label spelling. The complete declared vocabulary. */
export const RELEASE_MANIFEST_FIELD_BINDINGS: Readonly<
  Record<string, string>
> = Object.freeze({ version: "Version", license: "License" });

/**
 * One grammar value token: printable ASCII minus spaces — SPDX license
 * identifiers and semver strings fit; anything else is not a declared
 * value (the label counts as missing, never guessed).
 */
const MANIFEST_VALUE_TOKEN = /^[0-9A-Za-z][0-9A-Za-z.+~-]*$/;

// ---------------------------------------------------------------------------
// Admission: bounds BEFORE hashing/parsing (structural order)
// ---------------------------------------------------------------------------

/**
 * Per-document acquisition ceiling for caller-supplied manifests: the
 * SAME engine constant (LEAN_LIMIT_CEILINGS.maxEvidenceBytesPerDoc)
 * that rejects oversized acquired documents — a newly supplied manifest
 * is an acquisition, so it gets the acquisition bound, not the wider
 * candidate-validation bound.
 */
const MANIFEST_MAX_BYTES = LEAN_LIMIT_CEILINGS.maxEvidenceBytesPerDoc;

/**
 * ONE combined scan pass: UTF-16 well-formedness (every surrogate has
 * its pair) AND bare-carriage-return detection. A `\r` is legal only
 * immediately before `\n` (CRLF); anywhere else — including end-of-text
 * — it is outside the declared LF/CRLF grammar and is refused loudly so
 * it can never silently hide what would otherwise be a duplicate line.
 * Returns null when valid, else the typed violation.
 */
function scanAdmissionDefect(text: string): string | null {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return "Manifest text is not well-formed UTF-16 (lone surrogate).";
      }
      i += 1; // the pair is one admitted unit
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return "Manifest text is not well-formed UTF-16 (lone surrogate).";
    } else if (code === 0x0d /* \r */ && text.charCodeAt(i + 1) !== 0x0a /* \n */) {
      return "Manifest text contains a bare carriage return outside a CRLF pair.";
    }
  }
  return null;
}

/**
 * Admit one retained manifest text, cheapest checks first:
 *  1. FAST length rejection — text.length over the ceiling can never be
 *     within it in bytes (every UTF-16 unit is >=1 UTF-8 byte), so an
 *     oversized input is refused before ANY string scan;
 *  2. one combined scan pass (UTF-16 well-formedness + bare-CR refusal —
 *     a lone surrogate would make the digest describe replacement bytes,
 *     not the retained content);
 *  3. exact UTF-8 byte count against the 16,384-byte acquisition
 *     ceiling (multibyte text that slipped the length gate).
 * All of this happens BEFORE any digest or parse. Returns the admitted
 * text unchanged; throws ValidationError otherwise.
 */
export function admitManifestText(text: string): string {
  // Runtime type guard FIRST: a JS caller's non-string (42, undefined,
  // null) must fail as the promised typed ValidationError, never as a
  // native TypeError deep inside the length read or the scan.
  if (typeof text !== "string") {
    throw new ValidationError("Manifest text must be a string.");
  }
  if (text.length > MANIFEST_MAX_BYTES) {
    throw new ValidationError(
      `Manifest text exceeds the ${MANIFEST_MAX_BYTES}-byte retained-document ceiling.`,
    );
  }
  const defect = scanAdmissionDefect(text);
  if (defect !== null) throw new ValidationError(defect);
  if (Buffer.byteLength(text, "utf8") > MANIFEST_MAX_BYTES) {
    throw new ValidationError(
      `Manifest text exceeds the ${MANIFEST_MAX_BYTES}-byte retained-document ceiling.`,
    );
  }
  return text;
}

// ---------------------------------------------------------------------------
// Deterministic parse (bounds → digest → scan, in that order)
// ---------------------------------------------------------------------------

export type ManifestFieldStatus = "proposed" | "ambiguous" | "missing";

export interface ManifestParseRow {
  readonly fieldId: string;
  readonly label: string;
  readonly status: ManifestFieldStatus;
  /** Proposed value only (never a guess). */
  readonly value?: string;
  /** The exact grammar-matching line, verbatim, without its line break. */
  readonly quote?: string;
  /** Half-open UTF-16 span of quote in the ORIGINAL retained text. */
  readonly charRange?: readonly [number, number];
  /** Half-open UTF-16 span of the value token inside the original text. */
  readonly valueRange?: readonly [number, number];
  readonly lineIndex?: number;
}

export interface ManifestParseReport {
  readonly grammarId: typeof RELEASE_MANIFEST_GRAMMAR_ID;
  /** SHA-256 over the exact admitted UTF-8 bytes — binds this report to
   *  one retained representation; a different text yields a different
   *  digest, so report spans can never masquerade as another source's. */
  readonly sourceDigest: string;
  readonly fields: readonly ManifestParseRow[];
}

interface ScannedLine {
  readonly content: string;
  readonly start: number;
}

/** LF and CRLF line endings, freely mixed; offsets stay original. */
function scanLines(text: string): ScannedLine[] {
  const out: ScannedLine[] = [];
  let pos = 0;
  for (;;) {
    const nl = text.indexOf("\n", pos);
    const lineEnd = nl === -1 ? text.length : nl;
    // Strip ONE trailing \r for matching; the span excludes it, so the
    // quote stays an exact slice of the original text.
    const contentEnd = lineEnd > pos && text[lineEnd - 1] === "\r" ? lineEnd - 1 : lineEnd;
    out.push({ content: text.slice(pos, contentEnd), start: pos });
    if (nl === -1) return out;
    pos = nl + 1;
  }
}

/**
 * ONE shared field-id admission for create/parse/invoke: an array of
 * duplicate-free ids, each an OWN-property name of the binding map.
 * Membership MUST be Object.hasOwn — a plain truthiness or map[id]
 * lookup would admit INHERITED names such as "constructor" and
 * "__proto__" as if they were declared grammar fields.
 */
function manifestFieldIds(fields: readonly string[]): string[] {
  if (!Array.isArray(fields)) {
    throw new ValidationError("Manifest producer fields must be an array of field ids.");
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const id of fields) {
    if (typeof id !== "string" || !Object.hasOwn(RELEASE_MANIFEST_FIELD_BINDINGS, id)) {
      throw new ValidationError(
        `Field "${String(id)}" is not bound in grammar ${RELEASE_MANIFEST_GRAMMAR_ID} (bound: ${Object.keys(RELEASE_MANIFEST_FIELD_BINDINGS).join(", ")}).`,
      );
    }
    if (seen.has(id)) {
      throw new ValidationError(`Field "${id}" is declared twice for the manifest producer.`);
    }
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/**
 * Parse admitted manifest text against the declared grammar. Bounds and
 * UTF-16 well-formedness are enforced FIRST (admitManifestText); only
 * then is the digest computed and the text scanned. `fields` runs
 * through the shared duplicate-free own-key admission.
 */
export function parseReleaseManifest(
  text: string,
  fields: readonly string[],
): ManifestParseReport {
  admitManifestText(text);
  const fieldIds = manifestFieldIds(fields);
  const sourceDigest = createHash("sha256").update(text, "utf8").digest("hex");
  const lines = scanLines(text);
  const rows: ManifestParseRow[] = [];
  for (const fieldId of fieldIds) {
    const label = RELEASE_MANIFEST_FIELD_BINDINGS[fieldId]!;
    const labelClaim = `${label}:`;
    const prefix = `${label}: `;
    // Label-claim ambiguity: EVERY line that starts with `${label}:`
    // counts toward the ambiguity set — including lines whose value is
    // not a grammar token (e.g. `Version: 2.0.0 (rc)`). A malformed
    // duplicate must not silently shrink the claim set so the first
    // VALID line wins; the label is claimed twice, so abstain.
    let claims = 0;
    const matches: { quote: string; start: number; value: string; lineIndex: number }[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      const { content, start } = lines[i]!;
      if (!content.startsWith(labelClaim)) continue;
      claims += 1;
      if (content.startsWith(prefix)) {
        const value = content.slice(prefix.length);
        if (MANIFEST_VALUE_TOKEN.test(value)) {
          matches.push({ quote: content, start, value, lineIndex: i });
        }
      }
    }
    if (claims > 1) {
      rows.push({ fieldId, label, status: "ambiguous" });
      continue;
    }
    // Exactly one claim: proposed when its value is a grammar token;
    // otherwise the label has no declared value (missing, never guessed).
    if (matches.length === 0) {
      rows.push({ fieldId, label, status: "missing" });
      continue;
    }
    const m = matches[0]!;
    rows.push({
      fieldId,
      label,
      status: "proposed",
      value: m.value,
      quote: m.quote,
      charRange: [m.start, m.start + m.quote.length],
      valueRange: [m.start + prefix.length, m.start + m.quote.length],
      lineIndex: m.lineIndex,
    });
  }
  return { grammarId: RELEASE_MANIFEST_GRAMMAR_ID, sourceDigest, fields: rows };
}

// ---------------------------------------------------------------------------
// Producer attempt (pure; adapter over the parse for ExtractorDeps)
// ---------------------------------------------------------------------------

/**
 * Build the extractor attempt for a request. The source text is admitted
 * (bounds first) and every requested field must be bound in the grammar
 * AND — when `admittedFields` is given — a member of the admitted
 * subset; anything else is a loud refusal, never a silent serve. Each
 * field maps to `{value, quote, charRange}` or, for ambiguous/missing
 * labels, to the explicit abstention `{value:null, quote:null}` — the
 * existing validator's abstention spelling. usage and observedCost stay
 * null: a deterministic parse consumes no tokens and no paid work, and
 * null is "unknown/none", never an invented zero.
 */
export function manifestExtractorAttempt(
  request: ExtractorRequest,
  admittedFields?: readonly string[],
): ExtractorAttempt {
  // Owned immutable source: one captured string reference feeds the
  // digest, the parse and the output — a collaborator swapping fields on
  // the request object mid-flight cannot desync them.
  const sourceText = request.sourceText;
  if (!Array.isArray(request.fields)) {
    throw new ValidationError("Extractor request fields must be an array.");
  }
  // Invoke-time field validation: every id must be an OWN string property
  // of its field object (prototype-inherited ids never pass) and the id
  // list runs through the SHARED duplicate-free own-key admission
  // (inherited binding names like "constructor"/"__proto__"), plus the
  // per-instance admitted subset.
  const extractedIds: string[] = [];
  for (const f of request.fields) {
    if (f === null || typeof f !== "object" || !Object.hasOwn(f, "id") || typeof f.id !== "string") {
      throw new ValidationError(
        "Extractor request carries a field without an own string id.",
      );
    }
    extractedIds.push(f.id);
  }
  const fieldIds = manifestFieldIds(extractedIds);
  for (const id of fieldIds) {
    if (admittedFields !== undefined && !admittedFields.includes(id)) {
      throw new ValidationError(
        `Field "${id}" was not admitted for this producer instance (admitted: ${admittedFields.join(", ")}).`,
      );
    }
  }
  const report = parseReleaseManifest(sourceText, fieldIds);
  const output: Record<string, unknown> = {};
  for (const id of fieldIds) {
    const row = report.fields.find((r) => r.fieldId === id);
    output[id] =
      row !== undefined && row.status === "proposed" && row.value !== undefined
        ? { value: row.value, quote: row.quote, charRange: [...row.charRange!] }
        : { value: null, quote: null };
  }
  const canonical = JSON.stringify({
    grammarId: RELEASE_MANIFEST_GRAMMAR_ID,
    revision: RELEASE_MANIFEST_PRODUCER_REVISION,
    sourceDigest: report.sourceDigest,
    fields: fieldIds,
  });
  return {
    finishReason: "stop",
    rawOutput: JSON.stringify(output),
    usage: null,
    observedCost: null,
    // ponytail: synchronous parse, honestly sub-millisecond; measure
    // real elapsed only when a non-trivial producer exists.
    elapsedMs: 0,
    requestSha256: createHash("sha256").update(canonical, "utf8").digest("hex"),
  };
}

// ---------------------------------------------------------------------------
// Registration / admission seam (lane-owned; proposed shared surface)
// ---------------------------------------------------------------------------

export interface RegisteredDocumentProducer {
  readonly id: string;
  readonly revision: string;
  readonly supportedFields: readonly string[];
  /** Fields must be a duplicate-free subset of supportedFields; the
   *  returned extractor REFUSES any request outside that subset. */
  readonly create: (fields: readonly string[]) => ExtractorDeps;
}

/** The registered descriptor is a frozen singleton: id/revision/
 *  supportedFields cannot be mutated by a JavaScript caller, so later
 *  resolveDocumentProducer lookups stay stable. */
const RELEASE_MANIFEST_PRODUCER: RegisteredDocumentProducer = Object.freeze({
  id: RELEASE_MANIFEST_GRAMMAR_ID,
  revision: RELEASE_MANIFEST_PRODUCER_REVISION,
  supportedFields: Object.freeze([...Object.keys(RELEASE_MANIFEST_FIELD_BINDINGS)]),
  create: (fields) => {
    admitManifestFields(fields);
    const admitted = [...fields];
    return {
      extract: async (request) => manifestExtractorAttempt(request, admitted),
    };
  },
} as RegisteredDocumentProducer);

/** Admit a per-run field selection against the declared grammar —
 *  the shared duplicate-free own-key admission (create-side; parse and
 *  invoke call the same check). */
export function admitManifestFields(fields: readonly string[]): void {
  manifestFieldIds(fields);
}

/**
 * Resolve a declared producer id to its registered producer. The single
 * admission point a shared CLI seam would call (proposed: an
 * `--document-producer <id>` investigate flag); unknown ids fail closed.
 */
export function resolveDocumentProducer(id: string): RegisteredDocumentProducer {
  if (id === RELEASE_MANIFEST_PRODUCER.id) return RELEASE_MANIFEST_PRODUCER;
  throw new ValidationError(
    `Unknown document producer "${id}" (registered: ${RELEASE_MANIFEST_PRODUCER.id}).`,
  );
}
