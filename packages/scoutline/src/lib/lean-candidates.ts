/**
 * Arbitrary-value candidate path (arbitrary-candidates ticket; dev POC,
 * not a production surface, not an enum-engine rewrite — this composes
 * with the shared lean engine later, it does not fork it).
 *
 * Pipeline: runtime-configured extractor (dev: Luna via native
 * chat-completions structured output — GENERIC profile name, runtime
 * selected, no defaults) PROPOSES {value, quote} per field →
 * DETERMINISTIC code binds the candidate to the exact retained
 * representation (byte-exact quote substring, half-open UTF-16 charRange
 * convention `content.slice(start,end) === quote`, SHA-256 digest over
 * the exact retained UTF-8 bytes, no normalization) → native Jev
 * assesses candidate-SPECIFIC support / material conflict against the
 * FULL original source + opposing context → code accepts only on
 * structural/source gates plus clear support and no conflict-or-unknown
 * conflict. The extractor's word is never truth; a wrong/unsupported
 * candidate has no dispatch authority and cannot replace the source.
 *
 * Null = abstention → unresolved (never an accepted null; caller-opt-in
 * positively-evidenced null is out of scope). Schema descriptors are
 * bounded pattern STRINGS compiled once with a safety check (no caller
 * regex-exec surprises); Unicode min/max counts UTF-16 code units
 * (declared convention, matches the charRange locator space).
 *
 * finishReason guard: only "stop" may produce candidates; "length" /
 * "refusal" / anything else is a whole-response diagnostic with zero
 * fields promoted. No repair heuristics, no salvage.
 */

import { createHash } from "node:crypto";
import { ValidationError } from "./errors.js";
import { COMPOSED_STOP_ROOTS } from "./lean-composed-stop.js";
import type { LeanEvidenceRecord } from "./lean-investigation.js";

// ---------------------------------------------------------------------------
// Extractor dep (injected; runtime-configured; NO defaults, no env reads)
// ---------------------------------------------------------------------------

export interface CandidateFieldSpec {
  readonly id: string;
  /** Field meaning for the extractor prompt and the judge state. */
  readonly description: string;
  /** Unified proof: accepted prerequisite values + provenance the
   *  extractor must condition on (explicit payload, not description
   *  text). Optional so legacy enum-era callers compile unchanged. */
  readonly depBindings?: Readonly<Record<string, unknown>>;
}

export interface ExtractorRequest {
  readonly sourceId: string;
  readonly sourceText: string;
  readonly fields: readonly CandidateFieldSpec[];
  /** Unified proof: contract scope (wire-visible). */
  readonly scope?: Readonly<Record<string, string>>;
  /** Unified proof: accepted prerequisite values + provenance at
   *  top level (wire-visible; identical snapshot to fields[].depBindings). */
  readonly depBindings?: Readonly<Record<string, unknown>>;
}

export interface ExtractorAttempt {
  readonly finishReason: string;
  /** Model JSON, unparsed — validation owns parsing. */
  readonly rawOutput: string;
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly reasoningTokens?: number;
  } | null;
  readonly observedCost: number | null;
  readonly elapsedMs: number;
  readonly requestSha256: string;
}

export interface ExtractorDeps {
  extract(request: ExtractorRequest): Promise<ExtractorAttempt>;
}

// ---------------------------------------------------------------------------
// Schema descriptors (bounded pattern strings, compiled once)
// ---------------------------------------------------------------------------

export interface CandidateFieldSchema {
  /** Bounded pattern string. Compiled with the 'u' flag after a safety
   *  screen: length-capped and forbidden constructs rejected so a caller
   *  cannot smuggle unbounded backtracking or side effects. */
  readonly pattern?: string;
  /** Min/max length in UTF-16 code units (declared convention — the same
   *  space as the charRange locator). */
  readonly minLength?: number;
  readonly maxLength?: number;
}

const PATTERN_MAX_SOURCE = 256;

/**
 * Proof ceilings (parent-approved EXPERIMENTAL constants — NOT
 * production defaults, NOT coupled to the enum engine's per-doc cap).
 * Caller descriptors may LOWER these, never raise.
 */
export const CANDIDATE_MAX_SOURCE_BYTES = 64 * 1024; // retained UTF-8
export const CANDIDATE_MAX_RAW_OUTPUT_BYTES = 64 * 1024; // extractor UTF-8
export const CANDIDATE_MAX_VALUE_UTF16 = 4096; // UTF-16 code units
export const CANDIDATE_MAX_QUOTE_BYTES = 16 * 1024; // UTF-8 (source-bound)
/**
 * Restricted supported pattern syntax (validation-time screen — NOT a
 * universal ReDoS-safety claim): any QUANTIFIED GROUP — nested
 * quantifiers like (a+)+ AND alternation-bearing groups like (a|aa)+ —
 * backreferences and lookarounds are rejected UPFRONT; a short source
 * cap alone bounds nothing. At most ONE choice site is supported: one
 * alternation scope OR one variable-count atom quantifier. Fixed atom
 * counts remain supported. This conservative syntax policy is not a
 * universal JavaScript-regexp execution-time guarantee.
 */
/** Sanitized measured-observation allowlist (mirrors the engine's
 *  SAFE_FAILED_OBSERVATION_KEYS): only known safe fields survive the
 *  normalization boundary; raw text/headers/credentials never do. */
const CANDIDATE_SAFE_OBSERVATION_KEYS: ReadonlySet<string> = new Set([
  "requestSha256",
  "resolvedModel",
  "requestedModel",
  "usage",
  "elapsedMs",
  "status",
  // Optional supplier identity hashes (final completion release):
  // validated lowercase-64-hex only — invalid/arbitrary values are
  // discarded, never copied as raw metadata.
  "contextSha256",
  "policySha256",
]);
const HASH_64 = /^[a-f0-9]{64}$/;
function sanitizeCandidateObservation(
  observed: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  let any = false;
  for (const [key, value] of Object.entries(observed)) {
    if (!CANDIDATE_SAFE_OBSERVATION_KEYS.has(key)) continue;
    if (key === "usage" && value !== null && typeof value === "object") {
      const u = value as Record<string, unknown>;
      const usage: Record<string, number> = {};
      for (const tk of ["inputTokens", "outputTokens", "reasoningTokens"] as const) {
        const tv = u[tk];
        if (typeof tv === "number" && Number.isSafeInteger(tv) && tv >= 0) usage[tk] = tv;
      }
      out.usage = usage;
      any = true;
      continue;
    }
    if (
      (key === "elapsedMs" || key === "status") &&
      typeof value === "number" &&
      Number.isFinite(value) &&
      value >= 0
    ) {
      out[key] = value;
      any = true;
      continue;
    }
    if (key === "contextSha256" || key === "policySha256") {
      if (typeof value === "string" && HASH_64.test(value)) {
        out[key] = value;
        any = true;
      }
      continue;
    }
    if (typeof value === "string" && value.length > 0 && value.length <= 512) {
      out[key] = value;
      any = true;
    }
  }
  return any ? out : undefined;
}

const FORBIDDEN_PATTERN =
  /\\[1-9]|\(\?<[=!]|\(\?<=|\(\?=|\(\?!|\(\?[Pp]|[{}]{2,}|\*{3,}/;

/** Named references are excluded along with numeric references. Scan
 *  actual syntax so escaped backslashes and class literals remain data;
 *  reference-free named captures remain supported. */
function hasNamedReference(pattern: string): boolean {
  let inClass = false;
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]!;
    if (ch === "\\") {
      if (!inClass && pattern[i + 1] === "k" && pattern[i + 2] === "<") return true;
      i += 1;
    } else if (ch === "[") {
      inClass = true;
    } else if (ch === "]") {
      inClass = false;
    }
  }
  return false;
}

/**
 * True when a REAL group-closing paren is directly followed by a group
 * quantifier (`*`, `+`, `?` or a `{m[,n]}` brace quantifier). Tracks
 * backslash escaping and character classes so escaped literal parens
 * (`^\(MIT\)$`) and parens inside a class (`^[()]+$`) never count.
 * Groups are part of the supported subset ONLY unquantified; any
 * quantified group (nested, braced or optional inner atom) is the
 * excluded backtracking shape — no spelling enumeration.
 */
function hasQuantifiedGroup(pattern: string): boolean {
  let inClass = false;
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]!;
    if (ch === "\\") {
      i += 1; // escaped literal: skip the next character wholesale
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
      continue;
    }
    if (ch === "[") {
      inClass = true;
      continue;
    }
    if (ch !== ")") continue;
    const next = pattern[i + 1];
    if (next === "*" || next === "+" || next === "?") return true;
    if (next === "{") {
      // Brace quantifier on the group: {m}, {m,} or {m,n}. An atom brace
      // (invoice [0-9]{4}) never follows a group close, so any `{` here
      // is a group quantifier as long as it parses as one.
      const m = /^\{\d+(,\d*)?\}/.exec(pattern.slice(i + 1));
      if (m !== null) return true;
    }
  }
  return false;
}

/**
 * Independent choices can multiply even without quantified groups:
 * `(a|aa)(a|aa)...` and `a?a?...` both backtrack exponentially.
 * Admit one alternation scope OR one variable-count atom quantifier.
 * Deliberately rejects even safe combinations such as `^a+b+$`,
 * `^a?b?$`, `^(cat|dog)-(red|blue)$` and `^(MIT|Apache)-[0-9]+$`.
 * Escapes/classes are literals here; group prefixes and lazy suffixes
 * are syntax, not extra choices. RegExp still validates the grammar.
 */
function hasMultiplePatternChoices(pattern: string): boolean {
  // One entry per group INSTANCE (plus the root), never per depth:
  // sibling groups at the same depth introduce distinct choices.
  const alternatives = [false];
  let choices = 0;
  let inClass = false;
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]!;
    if (ch === "\\") {
      // A braced Unicode/property escape is ONE atom, not a fixed-count
      // quantifier. Leave its following '?' visible as an optional site.
      if (/[upP]/.test(pattern[i + 1] ?? "") && pattern[i + 2] === "{") {
        const end = pattern.indexOf("}", i + 3);
        if (end !== -1) i = end - 1;
      }
      i += 1;
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
      continue;
    }
    if (ch === "[") {
      inClass = true;
    } else if (ch === "(") {
      alternatives.push(false);
      if (pattern[i + 1] === "?") {
        // Noncapturing/modifier prefixes end at ':', named captures at
        // '>'. Existing forbidden-construct screening excludes assertions.
        const end = pattern.indexOf(pattern[i + 2] === "<" ? ">" : ":", i + 2);
        if (end !== -1) i = end;
      }
    } else if (ch === ")") {
      if (alternatives.length > 1) alternatives.pop();
    } else if (ch === "|") {
      const scope = alternatives.length - 1;
      if (!alternatives[scope]) {
        alternatives[scope] = true;
        choices += 1;
      }
    } else if (ch === "*" || ch === "+" || ch === "?") {
      choices += 1;
      if (pattern[i + 1] === "?") i += 1; // lazy modifier of THIS site
    } else if (ch === "{") {
      const count = /^\{(\d+)(?:,(\d*))?\}/.exec(pattern.slice(i));
      if (count !== null) {
        if (count[2] !== undefined && (count[2] === "" || BigInt(count[1]!) !== BigInt(count[2]))) {
          choices += 1;
        }
        i += count[0].length - 1;
        if (pattern[i + 1] === "?") i += 1;
      }
    }
    if (choices > 1) return true;
  }
  return false;
}

function compilePattern(fieldId: string, pattern: string): RegExp {
  if (pattern.length > PATTERN_MAX_SOURCE) {
    throw new ValidationError(
      `Field "${fieldId}" pattern exceeds the ${PATTERN_MAX_SOURCE}-character bound.`,
    );
  }
  if (
    FORBIDDEN_PATTERN.test(pattern) ||
    hasNamedReference(pattern) ||
    hasQuantifiedGroup(pattern) ||
    hasMultiplePatternChoices(pattern)
  ) {
    throw new ValidationError(`Field "${fieldId}" pattern uses forbidden constructs.`);
  }
  try {
    return new RegExp(pattern, "u");
  } catch {
    throw new ValidationError(`Field "${fieldId}" pattern is not a valid unicode RegExp.`);
  }
}

// ---------------------------------------------------------------------------
// Deterministic validation (pure)
// ---------------------------------------------------------------------------

export type CandidateStatus = "candidate" | "abstained" | "invalid";

export interface CandidateFieldOutcome {
  readonly fieldId: string;
  readonly status: CandidateStatus;
  /** invalid/abstain cause (diagnostics; never repaired). */
  readonly reason?: string;
  readonly value?: string;
  readonly quote?: string;
  /** Half-open UTF-16 range into the EXACT retained content:
   *  content.slice(charRange[0], charRange[1]) === quote. */
  readonly charRange?: readonly [number, number];
  /**
   * CODE-OWNED identity of the validated candidate (sha256 over
   * sourceId + source digest + fieldId + value + quote + range).
   * Computed at validation; tampered outcomes stop matching, so
   * acceptance rejects substitutions.
   */
  readonly candidateId?: string;
}

export interface ValidationResult {
  readonly fields: readonly CandidateFieldOutcome[];
  /** false when the response never parsed (finishReason or JSON) — every
   *  field is then invalid with a shared reason; nothing is promoted. */
  readonly parsed: boolean;
  readonly finishReason: string;
  readonly sourceDigest: string;
}

/** Count ALL occurrences including overlapping ones. */
function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    count += 1;
    at = haystack.indexOf(needle, at + 1);
  }
  return count;
}

/** SHA-256 over the exact retained content UTF-8 bytes — no normalization. */
export function candidateSourceDigest(source: LeanEvidenceRecord): string {
  return createHash("sha256").update(source.content, "utf8").digest("hex");
}

/**
 * Validate one extractor attempt against the exact retained source.
 * Pure: no extraction, no judging, no repair.
 */
/**
 * Descriptor preflight: the EXACT supported-descriptor policy
 * (min<=max, min/max<=4096, screened pattern subset) that validateCandidates
 * enforces at extraction time, exported so the unified compiler can
 * reject the same declarations BEFORE any acquisition instead of
 * discovering them mid-run. One policy, one implementation — the
 * compiler calls this rather than restating the rules.
 */
export function assertCandidateFieldSchema(fieldId: string, schema: CandidateFieldSchema): void {
  for (const [name, value] of [
    ["minLength", schema.minLength],
    ["maxLength", schema.maxLength],
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new ValidationError(`Field "${fieldId}" ${name} must be a safe non-negative integer.`);
    }
  }
  if (
    schema.minLength !== undefined &&
    schema.maxLength !== undefined &&
    schema.minLength > schema.maxLength
  ) {
    throw new ValidationError(`Field "${fieldId}" minLength exceeds maxLength.`);
  }
  if (schema.minLength !== undefined && schema.minLength > CANDIDATE_MAX_VALUE_UTF16) {
    throw new ValidationError(
      `Field "${fieldId}" minLength exceeds the ${CANDIDATE_MAX_VALUE_UTF16} value ceiling.`,
    );
  }
  if (schema.maxLength !== undefined && schema.maxLength > CANDIDATE_MAX_VALUE_UTF16) {
    throw new ValidationError(
      `Field "${fieldId}" maxLength exceeds the ${CANDIDATE_MAX_VALUE_UTF16} value ceiling.`,
    );
  }
  if (schema.pattern !== undefined) {
    compilePattern(fieldId, schema.pattern);
  }
}

export function validateCandidates(
  source: LeanEvidenceRecord,
  raw: { readonly finishReason: string; readonly rawOutput: string },
  fieldSchemas: Readonly<Record<string, CandidateFieldSchema>>,
): ValidationResult {
  const sourceDigest = candidateSourceDigest(source);
  // ---- upfront descriptor + source/output ceiling validation ----------
  // Descriptors must be finite safe non-negative ints with min<=max and
  // min/max<=4096 (caller bounds LOWER the ceilings, never raise); patterns
  // pre-screened (supported subset). Source and rawOutput capped.
  // Validation happens BEFORE abstention — bad descriptors are rejected
  // even when the extractor abstained.
  for (const [fieldId, schema] of Object.entries(fieldSchemas)) {
    assertCandidateFieldSchema(fieldId, schema);
  }
  if (Buffer.byteLength(source.content, "utf8") > CANDIDATE_MAX_SOURCE_BYTES) {
    throw new ValidationError(
      `Retained source exceeds the ${CANDIDATE_MAX_SOURCE_BYTES}-byte ceiling.`,
    );
  }
  if (Buffer.byteLength(raw.rawOutput, "utf8") > CANDIDATE_MAX_RAW_OUTPUT_BYTES) {
    throw new ValidationError(
      `Extractor raw output exceeds the ${CANDIDATE_MAX_RAW_OUTPUT_BYTES}-byte ceiling.`,
    );
  }
  const finishAll = (fields: readonly { fieldId: string; reason: string }[]): ValidationResult => ({
    fields: fields.map((f) => ({ fieldId: f.fieldId, status: "invalid", reason: f.reason })),
    parsed: false,
    finishReason: raw.finishReason,
    sourceDigest,
  });
  const fieldIds = Object.keys(fieldSchemas);
  if (raw.finishReason !== "stop") {
    return finishAll(
      fieldIds.map((id) => ({ fieldId: id, reason: `finish_reason:${raw.finishReason}` })),
    );
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw.rawOutput);
  } catch {
    return finishAll(fieldIds.map((id) => ({ fieldId: id, reason: "json_parse_failed" })));
  }
  if (typeof parsedJson !== "object" || parsedJson === null || Array.isArray(parsedJson)) {
    return finishAll(fieldIds.map((id) => ({ fieldId: id, reason: "json_not_object" })));
  }
  const obj = parsedJson as Record<string, unknown>;
  // Strict output contract: only requested field keys at top level and
  // only {value, quote, charRange?} inside each entry. Extra properties
  // are NOT stripped — the field is invalid.
  const entryKeys = new Set(["value", "quote", "charRange"]);
  // Own-property checks only: inherited names (toString/constructor/
  // __proto__) are NOT valid extraction keys and must not bypass.
  const hasUnknownTop = Object.keys(obj).some((k) => !Object.hasOwn(fieldSchemas, k));

  const out: CandidateFieldOutcome[] = [];
  for (const fieldId of fieldIds) {
    const schema = fieldSchemas[fieldId]!;
    const entry = obj[fieldId];
    if (entry === undefined) {
      out.push({ fieldId, status: "invalid", reason: "field_missing" });
      continue;
    }
    if (hasUnknownTop) {
      out.push({ fieldId, status: "invalid", reason: "unknown_top_level_property" });
      continue;
    }
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      out.push({ fieldId, status: "invalid", reason: "field_not_object" });
      continue;
    }
    if (Object.keys(entry as Record<string, unknown>).some((k) => !entryKeys.has(k))) {
      out.push({ fieldId, status: "invalid", reason: "unknown_entry_property" });
      continue;
    }
    const value = (entry as Record<string, unknown>).value;
    const quote = (entry as Record<string, unknown>).quote;
    const locator = (entry as Record<string, unknown>).charRange;
    if (value === null && quote === null) {
      out.push({ fieldId, status: "abstained", reason: "extractor_abstained" });
      continue;
    }
    if (typeof value !== "string" || typeof quote !== "string") {
      out.push({ fieldId, status: "invalid", reason: "value_or_quote_not_string" });
      continue;
    }
    if (value.length === 0 || quote.length === 0) {
      out.push({ fieldId, status: "invalid", reason: "empty_value_or_quote" });
      continue;
    }
    if (value.length > CANDIDATE_MAX_VALUE_UTF16) {
      out.push({ fieldId, status: "invalid", reason: "value_exceeds_ceiling" });
      continue;
    }
    if (Buffer.byteLength(quote, "utf8") > CANDIDATE_MAX_QUOTE_BYTES) {
      out.push({ fieldId, status: "invalid", reason: "quote_exceeds_ceiling" });
      continue;
    }
    // --- schema checks (bounded pattern + UTF-16 length bounds) ------
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      out.push({ fieldId, status: "invalid", reason: "min_length" });
      continue;
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      out.push({ fieldId, status: "invalid", reason: "max_length" });
      continue;
    }
    if (schema.pattern !== undefined) {
      const re = compilePattern(fieldId, schema.pattern);
      if (!re.test(value)) {
        out.push({ fieldId, status: "invalid", reason: "pattern_mismatch" });
        continue;
      }
    }
    // --- exact-quote binding -----------------------------------------
    const occurrences = countOccurrences(source.content, quote);
    let range: readonly [number, number] | undefined;
    if (locator !== undefined) {
      if (
        !Array.isArray(locator) ||
        locator.length !== 2 ||
        !Number.isSafeInteger(locator[0]) ||
        !Number.isSafeInteger(locator[1]) ||
        (locator[0] as number) < 0 ||
        (locator[1] as number) <= (locator[0] as number) ||
        (locator[1] as number) > source.content.length ||
        source.content.slice(locator[0] as number, locator[1] as number) !== quote
      ) {
        out.push({ fieldId, status: "invalid", reason: "locator_invalid" });
        continue;
      }
      range = [locator[0] as number, locator[1] as number];
    } else if (occurrences === 1) {
      range = [source.content.indexOf(quote), source.content.indexOf(quote) + quote.length];
    } else if (occurrences === 0) {
      out.push({ fieldId, status: "invalid", reason: "quote_not_in_source" });
      continue;
    } else {
      out.push({ fieldId, status: "invalid", reason: "ambiguous_quote" });
      continue;
    }
    // --- value occurs within the quote --------------------------------
    if (!quote.includes(value)) {
      out.push({ fieldId, status: "invalid", reason: "value_not_in_quote" });
      continue;
    }
    const candidateId = createHash("sha256")
      .update(
        JSON.stringify([
          source.evidenceId,
          sourceDigest,
          fieldId,
          value,
          quote,
          [range[0], range[1]],
        ]),
      )
      .digest("hex");
    out.push({ fieldId, status: "candidate", value, quote, charRange: range, candidateId });
  }
  return { fields: out, parsed: true, finishReason: raw.finishReason, sourceDigest };
}

// ---------------------------------------------------------------------------
// Native Jev candidate assessment (grouped per source/candidate-set)
// ---------------------------------------------------------------------------

export interface CandidateJudgeInput {
  readonly source: LeanEvidenceRecord;
  readonly fieldMeanings: Readonly<Record<string, string>>;
  readonly scope: Readonly<Record<string, string>>;
  readonly candidates: readonly {
    readonly fieldId: string;
    readonly value: string;
    readonly quote: string;
    readonly charRange: readonly [number, number];
  }[];
  /** Opposing/qualifying context: other retained representations the
   *  judge must see for material-conflict decisions. */
  readonly opposingContext: readonly LeanEvidenceRecord[];
  /** Unified proof: accepted prerequisite values + provenance revision
   *  this assessment is conditioned on (explicit wire payload; part of
   *  the assessment identity). */
  readonly depBindings?: Readonly<
    Record<
      string,
      { readonly value: string; readonly evidenceId: string; readonly sourceDigest: string }
    >
  >;
}

export interface CandidateJudgement {
  readonly fieldId: string;
  /** Identity of the exact candidate assessed — a good result for one
   *  value/quote NEVER transfers to another candidate of the same field. */
  readonly candidateId: string;
  /** .9/.1 on the raw Noul probability; null = middle band (unknown). */
  readonly support: boolean | null;
  readonly conflict: boolean | null;
  readonly rawSupport: number;
  readonly rawConflict: number;
}

export interface CandidateJudgeDeps {
  judge(input: CandidateJudgeInput): Promise<{
    readonly model: string;
    readonly answers: Readonly<Record<string, { readonly type: string; readonly noul: number }>>;
    readonly usage: { readonly inputTokens: number; readonly outputTokens: number } | null;
    readonly requestSha256: string;
    readonly elapsedMs: number;
  }>;
}

/**
 * Build the native candidate-assessment request body (exported for
 * tests): candidate identity lives in the INSTRUCTION TEXT via explicit
 * paths (`fields[i].value` etc.), never in question-id convention alone.
 */
export function buildCandidateJudgeRequest(input: CandidateJudgeInput, model: string): string {
  const questions: Record<string, { type: "noul"; instructions: string }> = {};
  input.candidates.forEach((c, i) => {
    questions[`q${i}s`] = {
      type: "noul",
      instructions: `Candidate \`fields[${i}].value\` (field \`fields[${i}].fieldId\`) claims a value for its field. Judging the exact designated passage \`fields[${i}].quote\` within \`source.text\` (locator \`fields[${i}].charRange\`), against the declared field meaning in \`fields[${i}].meaning\`, \`scope\` and \`criteria\` (consulting \`opposingContext\` only for qualifications or corrections): does that passage substantively substantiate THIS exact value for THIS field in scope — not merely resemble or relate to it? Answer the probability that it does.`,
    };
    questions[`q${i}c`] = {
      type: "noul",
      instructions: `Candidate \`fields[${i}].value\`: does \`source.text\` or \`opposingContext\` contain material same-scope evidence CONTRADICTING this exact value for field \`fields[${i}].fieldId\` (a competing authoritative value, or an explicit statement that the value is wrong)? Answer the probability that it does.`,
    };
  });
  return JSON.stringify({
    model,
    state: {
      scope: input.scope,
      source: { id: input.source.evidenceId, url: input.source.url, text: input.source.content },
      fields: input.candidates.map((c, i) => ({
        fieldId: c.fieldId,
        meaning: input.fieldMeanings[c.fieldId] ?? "",
        value: c.value,
        quote: c.quote,
        charRange: c.charRange,
        index: i,
      })),
      // Unified proof: accepted prerequisite values + their exact
      // provenance revision travel on the wire — a dependency re-accept
      // on new evidence changes this object, so the serialized request
      // identity (and its sha256) changes with the revision alone.
      depBindings: input.depBindings ?? {},
      criteria: [
        "Candidate support means the exact designated passage substantiates this exact value for this field in scope.",
        "A quote substring alone is not substantive support: script content, wrong-release statements and repeated keywords do not substantiate.",
        "Conflict means material same-scope contradiction, not the mere existence of other values elsewhere.",
      ],
      opposingContext: input.opposingContext.map((e) => ({
        id: e.evidenceId,
        url: e.url,
        text: e.content,
      })),
    },
    questions,
  });
}

/**
 * Assess candidates through the injected judge dep. Strict native
 * validation: model identity present; every expected question answered
 * exactly once with noul ∈ [0,1]; usage counters present and nonnegative
 * for real calls; trial .9/.1 thresholds translate to boolean|null
 * (null = unknown, never false).
 */
/** Fixed trial thresholds — the contract; per-call overrides are not part of it. */
export const CANDIDATE_THRESHOLD_TRUE = 0.9 as const;
export const CANDIDATE_THRESHOLD_FALSE = 0.1 as const;

/**
 * Code-owned candidate identity (single source of truth for validation
 * and assessment binding). Two layers:
 *  - payload identity (validation outcome): source id+digest, fieldId,
 *    value, quote, range.
 *  - assessment identity (judgement): payload identity PLUS the judged
 *    context — field meaning, scope, and primary/opposing wire URLs and
 *    content — so a judgement rendered under one meaning/scope/opposition never
 *    authorizes acceptance under a different one.
 */
/** Assessment-context identity inputs (unified proof): dependency
 *  bindings travel alongside meaning/scope/opposition so a judgment
 *  rendered under one dependency revision NEVER authorizes acceptance
 *  under another. All keys optional to keep legacy identities
 *  byte-stable when absent. */
export interface CandidateIdentityContext {
  readonly fieldMeaning: string;
  readonly scope: Readonly<Record<string, string>>;
  readonly opposingContext: readonly LeanEvidenceRecord[];
  readonly depBindings?: Readonly<
    Record<
      string,
      { readonly value: string; readonly evidenceId: string; readonly sourceDigest: string }
    >
  >;
}
export function candidateIdentity(
  source: LeanEvidenceRecord,
  sourceDigest: string,
  fieldId: string,
  value: string,
  quote: string,
  charRange: readonly [number, number],
): string;
export function candidateIdentity(
  source: LeanEvidenceRecord,
  sourceDigest: string,
  fieldId: string,
  value: string,
  quote: string,
  charRange: readonly [number, number],
  context: CandidateIdentityContext,
): string;
export function candidateIdentity(
  source: LeanEvidenceRecord,
  sourceDigest: string,
  fieldId: string,
  value: string,
  quote: string,
  charRange: readonly [number, number],
  context?: CandidateIdentityContext,
): string {
  const payload = [
    source.evidenceId,
    sourceDigest,
    fieldId,
    value,
    quote,
    [charRange[0], charRange[1]],
  ];
  if (context === undefined) {
    return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  }
  const ctx = [
    context.fieldMeaning,
    context.scope,
    // URLs are visible to the judge alongside ids/text. Bind them only
    // in assessment context; validation/payload identity stays byte-stable.
    // Titles are not on this wire and do not enter the assessed identity.
    source.url,
    context.opposingContext.map((e) => [e.evidenceId, candidateSourceDigest(e), e.url] as const),
    // Dependency revision is part of what the judgment judged: a
    // digest-only change yields a different assessment identity, so a
    // stale judgment can never re-authorize acceptance.
    ...(context.depBindings === undefined ? [] : [context.depBindings]),
  ];
  return createHash("sha256")
    .update(JSON.stringify([payload, ctx]))
    .digest("hex");
}

export async function assessCandidates(
  input: CandidateJudgeInput,
  deps: CandidateJudgeDeps,
  ...forbiddenOverrides: unknown[]
): Promise<{
  readonly judgements: readonly CandidateJudgement[];
  readonly error?: string;
  /** Validated composed-stop root carried through a rejected judgment
   * (exact COMPOSED_STOP_ROOTS membership only; absent otherwise). */
  readonly stopRoot?: string;
  readonly metadata?: unknown;
}> {
  // Threshold overrides are NOT part of the contract: any attempt to
  // pass them is a loud rejection, never silently ignored (an ignored
  // override could hide a caller's intent to invert the policy).
  if (forbiddenOverrides.length > 0) {
    return { judgements: [], error: "JEV_DEV_PROTOCOL:threshold_overrides_unsupported" };
  }
  // Dispatch-time snapshot (review F2): the caller's input is ordinary
  // mutable nested records — TS `readonly` is not a runtime guarantee.
  // Take ONE owned deep snapshot synchronously BEFORE dispatch; the judge
  // and every downstream identity/descriptor derivation read this snapshot,
  // never the caller's objects, so an in-flight mutation cannot relabel
  // the judgment or leak into the wire payload.
  const dispatch = structuredClone(input) as CandidateJudgeInput;
  let response: Awaited<ReturnType<CandidateJudgeDeps["judge"]>>;
  try {
    response = await deps.judge(dispatch);
  } catch (judgeError) {
    // A MEASURED typed rejection (safe observed hash/model/usage/status/
    // latency on the thrown error) survives normalization — the audit
    // keeps the observation; only the judgement is dropped.
    const observed = (judgeError as { observed?: unknown } | null)?.observed;
    // Composed-run stop root retention: a VALIDATED finite vocabulary
    // root carried by the rejection (either carrier field) survives
    // normalization as a separate typed envelope field — the error
    // string taxonomy is unchanged, observations stay attached, and an
    // arbitrary reason string never promotes (exact-membership gate,
    // same boundary as the engine's other promotion sites).
    const stopCarrier = judgeError as { stopReason?: unknown; reason?: unknown } | null;
    const stopRoot =
      typeof stopCarrier?.stopReason === "string" && COMPOSED_STOP_ROOTS.has(stopCarrier.stopReason)
        ? stopCarrier.stopReason
        : typeof stopCarrier?.reason === "string" && COMPOSED_STOP_ROOTS.has(stopCarrier.reason)
          ? stopCarrier.reason
          : undefined;
    return {
      judgements: [],
      error: `JEV_DEV_NETWORK:judge_rejected:${(judgeError as { code?: string } | null)?.code ?? "unknown"}`,
      ...(observed !== undefined && observed !== null && typeof observed === "object"
        ? { metadata: sanitizeCandidateObservation(observed as Record<string, unknown>) ?? {} }
        : {}),
      ...(stopRoot !== undefined ? { stopRoot } : {}),
    };
  }
  if (response == null || typeof response !== "object") {
    return { judgements: [], error: "JEV_DEV_MALFORMED:response_not_object" };
  }
  if (typeof response.model !== "string" || response.model.length === 0) {
    return { judgements: [], error: "JEV_DEV_MALFORMED:model_missing" };
  }
  const expected = new Set<string>();
  dispatch.candidates.forEach((_, i) => {
    expected.add(`q${i}s`);
    expected.add(`q${i}c`);
  });
  const answers = response.answers;
  if (typeof answers !== "object" || answers === null) {
    return { judgements: [], error: "JEV_DEV_MALFORMED:answers_missing" };
  }
  for (const id of Object.keys(answers)) {
    if (!expected.has(id))
      return { judgements: [], error: `JEV_DEV_PROTOCOL:unknown_question_${id}` };
  }
  for (const id of expected) {
    if (!Object.hasOwn(answers, id))
      return { judgements: [], error: `JEV_DEV_PROTOCOL:missing_question_${id}` };
  }
  const usage = (response as { usage?: unknown }).usage;
  if (
    typeof usage !== "object" ||
    usage === null ||
    !Number.isSafeInteger((usage as { inputTokens?: unknown }).inputTokens) ||
    (usage as { inputTokens: number }).inputTokens < 0 ||
    !Number.isSafeInteger((usage as { outputTokens?: unknown }).outputTokens) ||
    (usage as { outputTokens: number }).outputTokens < 0
  ) {
    return { judgements: [], error: "JEV_DEV_MALFORMED:usage_invalid" };
  }
  const translate = (p: number): boolean | null =>
    p >= CANDIDATE_THRESHOLD_TRUE ? true : p <= CANDIDATE_THRESHOLD_FALSE ? false : null;
  const sourceDigest = candidateSourceDigest(dispatch.source);
  const judgements: CandidateJudgement[] = dispatch.candidates.map((c, i) => {
    // Context-bound assessment identity: meaning/scope/opposition are
    // part of what the judgement judged, so they are part of the id.
    const _assessmentId = candidateIdentity(
      dispatch.source,
      sourceDigest,
      c.fieldId,
      c.value,
      c.quote,
      c.charRange,
      {
        fieldMeaning: dispatch.fieldMeanings[c.fieldId] ?? "",
        scope: dispatch.scope,
        opposingContext: dispatch.opposingContext,
        depBindings: dispatch.depBindings,
      },
    );
    void _assessmentId;
    const s = (answers as Record<string, { type: string; noul: number } | null>)[`q${i}s`] ?? null;
    const f = (answers as Record<string, { type: string; noul: number } | null>)[`q${i}c`] ?? null;
    for (const a of [s, f]) {
      if (
        a === null ||
        a.type !== "noul" ||
        typeof a.noul !== "number" ||
        !Number.isFinite(a.noul) ||
        a.noul < 0 ||
        a.noul > 1
      ) {
        throw new ValidationError(
          `Jev candidate answer q${i} was not a finite noul probability in [0,1].`,
        );
      }
    }
    return {
      fieldId: c.fieldId,
      candidateId: _assessmentId,
      support: translate(s!.noul),
      conflict: translate(f!.noul),
      rawSupport: s!.noul,
      rawConflict: f!.noul,
    };
  });
  // Optional supplier identity hashes: forwarded only when the response
  // carries VALID lowercase-64-hex values; invalid/arbitrary values are
  // discarded here (the normalizer boundary), never copied as raw
  // metadata. Suppliers that omit them stay legacy-compatible.
  const identityHash = (v: unknown): string | null =>
    typeof v === "string" && HASH_64.test(v) ? v : null;
  // Success observations use the same owned allowlist projection as
  // rejections. resolvedModel is an INTERNAL sanitizer key only: the
  // public success envelope retains model and its six legacy keys.
  const safeMetadata = sanitizeCandidateObservation({
    requestSha256: response.requestSha256,
    resolvedModel: response.model,
    usage,
    // Do not let nonnumeric latency reach the sanitizer's generic
    // string fallback; invalid optional observations normalize to null.
    elapsedMs: typeof response.elapsedMs === "number" ? response.elapsedMs : undefined,
    contextSha256: identityHash((response as { contextSha256?: unknown }).contextSha256),
    policySha256: identityHash((response as { policySha256?: unknown }).policySha256),
  }) ?? {};
  return {
    judgements,
    metadata: {
      requestSha256: safeMetadata.requestSha256 ?? null,
      model: safeMetadata.resolvedModel ?? null,
      usage: safeMetadata.usage ?? null,
      elapsedMs: safeMetadata.elapsedMs ?? null,
      contextSha256: safeMetadata.contextSha256 ?? null,
      policySha256: safeMetadata.policySha256 ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// Acceptance (pure; code owns it)
// ---------------------------------------------------------------------------

export interface CandidateProvenance {
  readonly fieldId: string;
  readonly sourceId: string;
  readonly sourceDigest: string;
  readonly value: string;
  readonly quote: string;
  readonly charRange: readonly [number, number];
}

export interface AcceptanceOutcome {
  readonly fieldId: string;
  readonly status: "accepted" | "unresolved";
  readonly reason?: string;
  readonly provenance?: CandidateProvenance;
  readonly judgement?: CandidateJudgement;
}

/**
 * Accept a candidate: structural/source gates (validation status
 * "candidate") plus judge support === true and conflict === false.
 * Unknown conflict blocks (conservative). Judgement must match THIS
 * fieldId exactly — a good result for another field never transfers.
 */
export interface CandidateJudgedContext {
  readonly fieldMeanings: Readonly<Record<string, string>>;
  readonly scope: Readonly<Record<string, string>>;
  readonly opposingContext: readonly LeanEvidenceRecord[];
  /** Unified proof: the dependency revision acceptance is checked
   *  against — must match the one the judgment was rendered under. */
  readonly depBindings?: Readonly<
    Record<
      string,
      { readonly value: string; readonly evidenceId: string; readonly sourceDigest: string }
    >
  >;
}

export function acceptCandidate(
  validation: CandidateFieldOutcome,
  judgement: CandidateJudgement | null,
  source: LeanEvidenceRecord,
  sourceDigest: string,
  judgedContext: CandidateJudgedContext,
): AcceptanceOutcome {
  if (
    validation.status !== "candidate" ||
    validation.value === undefined ||
    validation.quote === undefined ||
    validation.charRange === undefined
  ) {
    return {
      fieldId: validation.fieldId,
      status: "unresolved",
      reason: validation.status === "abstained" ? "abstained" : (validation.reason ?? "invalid"),
    };
  }
  // ---- CODE-OWNED SOURCE/CANDIDATE BINDING (no caller trust) ----------
  // Recompute digest + identity from the LIVE source content and verify
  // the validation outcome against them: stale digests, tampered
  // value/quote/range and changed same-ID sources all fail here.
  const liveDigest = candidateSourceDigest(source);
  if (liveDigest !== sourceDigest) {
    return { fieldId: validation.fieldId, status: "unresolved", reason: "source_digest_mismatch" };
  }
  const liveIdentity = candidateIdentity(
    source,
    liveDigest,
    validation.fieldId,
    validation.value,
    validation.quote,
    validation.charRange,
  );
  if (validation.candidateId !== liveIdentity) {
    return {
      fieldId: validation.fieldId,
      status: "unresolved",
      reason: "candidate_identity_mismatch",
    };
  }
  // The locator must still hold against the live content.
  if (source.content.slice(validation.charRange[0], validation.charRange[1]) !== validation.quote) {
    return { fieldId: validation.fieldId, status: "unresolved", reason: "locator_stale" };
  }
  if (judgement === null) {
    return {
      fieldId: validation.fieldId,
      status: "unresolved",
      reason: "not_judged",
      provenance: {
        fieldId: validation.fieldId,
        sourceId: source.evidenceId,
        sourceDigest: liveDigest,
        value: validation.value,
        quote: validation.quote,
        charRange: validation.charRange,
      },
    };
  }
  if (judgement.fieldId !== validation.fieldId) {
    return {
      fieldId: validation.fieldId,
      status: "unresolved",
      reason: "judgement_candidate_mismatch",
    };
  }
  // Runtime fail-closed on missing context (TS arity alone is not
  // relied upon): no payload-only fallback exists — a judgement can only
  // ever authorize acceptance under the exact context it was assessed in.
  if (
    judgedContext === null ||
    typeof judgedContext !== "object" ||
    typeof judgedContext.fieldMeanings !== "object" ||
    judgedContext.fieldMeanings === null ||
    typeof judgedContext.scope !== "object" ||
    judgedContext.scope === null ||
    !Array.isArray(judgedContext.opposingContext)
  ) {
    return { fieldId: validation.fieldId, status: "unresolved", reason: "judged_context_required" };
  }
  const expectedJudgementId = candidateIdentity(
    source,
    liveDigest,
    validation.fieldId,
    validation.value,
    validation.quote,
    validation.charRange,
    {
      fieldMeaning: judgedContext.fieldMeanings[validation.fieldId] ?? "",
      scope: judgedContext.scope,
      opposingContext: judgedContext.opposingContext,
      depBindings: judgedContext.depBindings,
    },
  );
  if (judgement.candidateId !== expectedJudgementId) {
    return {
      fieldId: validation.fieldId,
      status: "unresolved",
      reason: "judgement_context_mismatch",
    };
  }
  // Raw scores must be finite numbers in [0,1] — Infinity, -Infinity
  // and numeric strings never reach the normalized check.
  for (const raw of [judgement.rawSupport, judgement.rawConflict]) {
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0 || raw > 1) {
      return {
        fieldId: validation.fieldId,
        status: "unresolved",
        reason: "raw_score_invalid",
        judgement,
      };
    }
  }
  // Normalized flags must be consistent with their raw probabilities
  // under the fixed trial thresholds — a fabricated true against a low
  // raw score never accepts.
  const rawSupportOk =
    (judgement.support === true && judgement.rawSupport >= CANDIDATE_THRESHOLD_TRUE) ||
    (judgement.support === false && judgement.rawSupport <= CANDIDATE_THRESHOLD_FALSE) ||
    (judgement.support === null &&
      judgement.rawSupport > CANDIDATE_THRESHOLD_FALSE &&
      judgement.rawSupport < CANDIDATE_THRESHOLD_TRUE);
  const rawConflictOk =
    (judgement.conflict === true && judgement.rawConflict >= CANDIDATE_THRESHOLD_TRUE) ||
    (judgement.conflict === false && judgement.rawConflict <= CANDIDATE_THRESHOLD_FALSE) ||
    (judgement.conflict === null &&
      judgement.rawConflict > CANDIDATE_THRESHOLD_FALSE &&
      judgement.rawConflict < CANDIDATE_THRESHOLD_TRUE);
  if (!rawSupportOk || !rawConflictOk) {
    return {
      fieldId: validation.fieldId,
      status: "unresolved",
      reason: "normalized_raw_inconsistency",
      judgement,
    };
  }
  if (judgement.support !== true) {
    return {
      fieldId: validation.fieldId,
      status: "unresolved",
      reason: judgement.support === null ? "support_unknown" : "support_refuted",
      judgement,
    };
  }
  if (judgement.conflict !== false) {
    return {
      fieldId: validation.fieldId,
      status: "unresolved",
      reason: judgement.conflict === null ? "conflict_unknown" : "material_conflict",
      judgement,
    };
  }
  return {
    fieldId: validation.fieldId,
    status: "accepted",
    provenance: {
      fieldId: validation.fieldId,
      sourceId: source.evidenceId,
      sourceDigest: liveDigest,
      value: validation.value,
      quote: validation.quote,
      charRange: validation.charRange,
    },
    judgement,
  };
}
