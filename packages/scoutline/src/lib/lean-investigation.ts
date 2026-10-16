/**
 * Experimental requirements-driven Investigation engine, shared by the
 * requirements and caller-assisted CLI surfaces and hermetic fixtures.
 * Plain-question Investigation retains its separate EvidencePack contract.
 *
 *   - Caller supplies question + scope + named fields (enum schema,
 *     criteria, required, dependsOn). No search arms, no parser ids,
 *     no judge prompts, no thresholds.
 *   - Engine owns a frozen deterministic query plan, a monotone
 *     read cursor over a deduplicated result queue, bounded limits,
 *     and the acceptance policy below.
 *   - Scope of acceptance: finite classifications from the literal
 *     set {supported, refuted, disputed} — the compiler REJECTS any
 *     other enum value. Source-bound strings use caller-proposed candidates;
 *     automatic candidate production is not a default of the CLI.
 *
 * Acceptance policy (deterministic code over typed judge verdicts —
 * the judge never picks the answer alone; per JEV-CONTENT-ASSESSMENT,
 * a disputed label needs positive evidence of BOTH sides, keywords
 * score nothing, and one-sided accepts wait for the counterevidence
 * query round before finalizing):
 *   supported : >=1 relevant doc evidences the claim, none refutes it
 *   refuted   : >=1 relevant doc refutes the claim, none supports it
 *   disputed  : >=1 relevant doc on EACH side (single-doc explicit
 *               contradiction counts — probe row "explicit same-scope
 *               contradiction"). Enum must allow `disputed`; a scalar-
 *               only enum ({supported,refuted}) stays unresolved with
 *               reason `conflicting_evidence`, never silently converted.
 *   Inconsistent judgments (one-sided accept flipping to a DIFFERENT
 *   one-sided accept, or disputed collapsing back to one side) never
 *   accept: the flip is recorded, the pending accept is cleared, and
 *   acquisition continues within limits. The one legitimate flip is
 *   one-sided -> disputed: that is counterevidence being found, which
 *   is exactly what the counterevidence round exists for.
 *
 * Identical judge input is never reissued: a field is judged only when
 * the retained-evidence identity set changed since its last judgment.
 *
 * ponytail: proof ceilings are single flat constants, result rows are
 * plain JSON — per-field limit overrides, pagination and preferred-URL
 * leads are contract clauses deliberately NOT implemented here (see
 * plan §"Engine-owned acquisition" items 1 and 6); add when a live
 * proof needs them.
 */

import { createHash } from "node:crypto";
import { ValidationError } from "./errors.js";
import { COMPOSED_STOP_ROOTS } from "./lean-composed-stop.js";
import {
  validateCandidates,
  acceptCandidate,
  assessCandidates,
  assertCandidateFieldSchema,
  type CandidateFieldOutcome,
  type CandidateFieldSchema,
  type CandidateJudgement,
  type CandidateProvenance,
  type ExtractorAttempt,
  type ExtractorRequest,
} from "./lean-candidates.js";

/** Registry symbol mirroring the dev adapter's attempt-metadata channel
 *  (engine stays importable without the dev adapter module). */
const LEAN_JEV_ATTEMPT_META_SYMBOL = Symbol.for("leanJevAttemptMeta");

// ---------------------------------------------------------------------------
// Proof limits (engineering trial values — NOT approved production defaults)
// ---------------------------------------------------------------------------

/**
 * Engine ceilings. Caller `limits` may lower these, never raise them.
 * maxFields is 3, not the plan doc's trial 2: demonstration 7 needs a
 * prerequisite + a blocked dependant + an independent field in one run.
 */
export const LEAN_LIMIT_CEILINGS = Object.freeze({
  maxFields: 3,
  readBatchSize: 2,
  maxUniqueReads: 6,
  // Unified proof (parent Rev3): the plan is shared + per-field primary +
  // per-field contrary = 1 + 3 + 3 = 7 queries for a full 3-field run —
  // the old 4-search ceiling starved contrary rounds. Callers may LOWER;
  // parent's live caps stay separate (24 extract / 48 judge).
  maxSearchAttempts: 7,
  // Shared semantic ceiling across enum AND candidate judgments. A
  // candidate is judged over its source plus the full opposing set, so
  // each newly retained source legitimately re-opens every earlier
  // candidate pair — 3 sources x 2 value fields is 6 re-assessments
  // before the enum field's own challenge. 8 was sized for the
  // enum-only plan and starves value-mode challenge work.
  maxJudgeAttempts: 24,
  deadlineMs: 60_000,
  maxEvidenceBytesPerDoc: 16_384,
  maxTotalEvidenceBytes: 262_144,
});

/** The finite classification vocabulary this proof accepts. */
const CLASSIFICATION_VALUES: ReadonlySet<string> = new Set(["supported", "refuted", "disputed"]);

const CALLER_LIMIT_KEYS: ReadonlySet<string> = new Set([
  "readBatchSize",
  "maxUniqueReads",
  "maxSearchAttempts",
  "maxJudgeAttempts",
  "deadlineMs",
]);

// ---------------------------------------------------------------------------
// Caller contract (input)
// ---------------------------------------------------------------------------

export interface LeanRequirement {
  readonly question: string;
  /** Discriminated schema: { enum: [...] } classification OR
   *  { type: "string", pattern?, minLength?, maxLength? } source-bound
   *  string value (unified proof — exact keyword set, fail-loud). */
  readonly schema:
    | { readonly enum: readonly string[] }
    | {
        readonly type: "string";
        readonly pattern?: string;
        readonly minLength?: number;
        readonly maxLength?: number;
      };
  readonly criteria?: readonly string[];
  readonly required?: boolean;
  readonly dependsOn?: readonly string[];
}

/** Discriminated compiled schema (runtime-checked, not trusted). */
export type LeanFieldMode = "classification" | "value";
export interface LeanCompiledSchema {
  readonly mode: LeanFieldMode;
  readonly enum?: readonly string[];
  readonly pattern?: string;
  readonly minLength?: number;
  readonly maxLength?: number;
}

export interface LeanContract {
  readonly schemaVersion: 1;
  readonly question: string;
  readonly scope?: Readonly<Record<string, string>>;
  readonly requirements: Readonly<Record<string, LeanRequirement>>;
  readonly evidence?: { readonly criteria?: readonly string[] };
  readonly limits?: Partial<
    Record<
      "readBatchSize" | "maxUniqueReads" | "maxSearchAttempts" | "maxJudgeAttempts" | "deadlineMs",
      number
    >
  >;
}

export interface LeanLimits {
  readonly readBatchSize: number;
  readonly maxUniqueReads: number;
  readonly maxSearchAttempts: number;
  readonly maxJudgeAttempts: number;
  readonly deadlineMs: number;
  readonly maxEvidenceBytesPerDoc: number;
  readonly maxTotalEvidenceBytes: number;
}

// ---------------------------------------------------------------------------
// Injected dependencies
// ---------------------------------------------------------------------------

export interface LeanSearchResult {
  readonly url: string;
  readonly title?: string;
}

/** One retained document as presented to the judge — full bounded text. */
export interface LeanJudgeInputDoc {
  readonly evidenceId: string;
  readonly url: string;
  readonly title: string;
  readonly content: string;
}

export interface LeanJudgeInput {
  readonly fieldId: string;
  readonly fieldQuestion: string;
  readonly criteria: readonly string[];
  readonly scope: Readonly<Record<string, string>>;
  readonly candidates: readonly string[];
  readonly documents: readonly LeanJudgeInputDoc[];
  /** Unified proof: accepted prerequisite values + provenance revision
   *  this classification is conditioned on (explicit wire payload;
   *  empty when the field has no dependencies). */
  readonly depBindings?: Readonly<Record<string, DepBinding>>;
}

/**
 * Per-document typed verdicts in the probe's independent-question
 * shape: relevance, claim support and claim refutation are separate
 * booleans so a keyword-stuffed doc can be relevant=false while
 * containing every search term.
 */
export interface LeanJudgeDocVerdict {
  readonly evidenceId: string;
  /** null = unknown (per-source uncertainty policy) — never coerced to false. */
  readonly relevant: boolean | null;
  readonly supportsClaim: boolean | null;
  readonly refutesClaim: boolean | null;
}

export interface LeanJudgeResponse {
  readonly documents: readonly LeanJudgeDocVerdict[];
}

/** Per-dispatch bounds the engine hands every dependency: the run's
 *  REMAINING time and a run-owned AbortSignal, so an in-flight native
 *  request is bounded by the whole-run deadline, not only the next
 *  dispatch. Optional so legacy single-arg deps keep working. */
export interface LeanDispatchOptions {
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}

export interface LeanDeps {
  readonly search: (
    query: string,
    options?: LeanDispatchOptions,
  ) => Promise<readonly LeanSearchResult[]>;
  readonly read: (url: string, options?: LeanDispatchOptions) => Promise<string>;
  /** `null` = no semantic judge configured (deterministic-only mode). */
  readonly judge:
    | ((input: LeanJudgeInput, options?: LeanDispatchOptions) => Promise<LeanJudgeResponse>)
    | null;
  readonly now: () => number;
  /**
   * Owned-interruption integration seam (correction 7): an external
   * AbortSignal whose abort cancels THIS run (bridged to the run-owned
   * controller; every dependency dispatch observes it). The dispatcher
   * owns registration/cleanup of the underlying OS signal — the engine
   * only removes its listener at exit. Absent = unchanged behavior.
   */
  readonly externalSignal?: AbortSignal;
}

/**
 * One persisted accepted/rejected proof with its FULL basis (caller
 * rounds: cross-round no-score-fishing). This is the engine's existing
 * `AcceptProof` shape — provenance, judgment, validated outcome, the exact
 * judged meaning/scope/opposition/prerequisite context, and every source
 * content digest. Rehydration is only an OPTIMIZATION: every proof still
 * passes the unchanged `proveAccept` live revalidation before it can
 * authorize anything, so a stale/mismatched basis authorizes nothing.
 */
export interface LeanSeededProof {
  readonly provenance: import("./lean-candidates.js").CandidateProvenance;
  readonly judgment: import("./lean-candidates.js").CandidateJudgement;
  readonly outcome: import("./lean-candidates.js").CandidateFieldOutcome;
  readonly judgedContext: import("./lean-candidates.js").CandidateJudgedContext;
  readonly opposingIds: readonly string[];
  readonly sourceDigest: string;
  readonly opposingDigests: readonly string[];
}

/** Caller-rounds seed (caller-assisted ticket): retained evidence
 *  reused without HTTP reread, plus explicit new URL leads with any
 *  prior-round attempt exclusions. Absent = unchanged one-shot run. */
export interface LeanSeed {
  readonly evidence?: readonly LeanEvidenceRecord[];
  readonly leads?: readonly {
    readonly url: string;
    readonly title: string;
    readonly priorAttemptUrls?: readonly string[];
  }[];
  readonly issuedQueries?: readonly string[];
  /** Persisted proofs from prior rounds (cross-round no-score-fishing). */
  readonly proofs?: readonly LeanSeededProof[];
  readonly history?: readonly LeanFieldCheckpoint[];
  readonly identity?: string;
  readonly retainEvidence?: (record: LeanEvidenceRecord) => Promise<void>;
  readonly capture?: (state: LeanRoundCheckpoint) => void;
}

export interface LeanFieldCheckpoint {
  readonly namespace: string;
  readonly context: string;
  readonly state: Record<string, unknown>;
}

export interface LeanRoundCheckpoint {
  readonly history: readonly LeanFieldCheckpoint[];
  readonly issuedQueries: readonly string[];
  readonly leads: readonly { url: string; title: string; origins: readonly string[] }[];
}

/** One dependency binding: accepted prerequisite value + provenance. */
export interface DepBinding {
  readonly value: string;
  readonly evidenceId: string;
  readonly sourceDigest: string;
}

/** Value-mode candidate-judge input: lean-candidates CandidateJudgeInput
 *  plus explicit depBindings (identical snapshots to extractor payload). */
export interface LeanCandidateJudgeInput {
  readonly source: LeanEvidenceRecord;
  readonly fieldMeanings: Readonly<Record<string, string>>;
  readonly scope: Readonly<Record<string, string>>;
  readonly candidates: readonly {
    readonly fieldId: string;
    readonly value: string;
    readonly quote: string;
    readonly charRange: readonly [number, number];
  }[];
  readonly opposingContext: readonly LeanEvidenceRecord[];
  readonly depBindings: Readonly<Record<string, DepBinding>>;
}

/** Response shape mirrors CandidateJudgeDeps["judge"] exactly (validated
 *  by the same assessCandidates protocol). */
export interface LeanCandidateJudgeResponse {
  readonly model: string;
  readonly answers: Readonly<Record<string, { readonly type: string; readonly noul: number }>>;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number } | null;
  readonly requestSha256: string;
  readonly elapsedMs: number;
}

export interface LeanUnifiedDeps extends LeanDeps {
  /** Value-mode extractor; null/absent = no extractor configured. */
  readonly extract?:
    | ((request: ExtractorRequest, options?: LeanDispatchOptions) => Promise<ExtractorAttempt>)
    | null;
  /** Value-mode semantic assessor; null/absent = no_semantic_judge. */
  readonly candidateJudge?:
    | ((
        input: LeanCandidateJudgeInput,
        options?: LeanDispatchOptions,
      ) => Promise<LeanCandidateJudgeResponse>)
    | null;
  /** Cache-identity component for extraction reuse. */
  readonly extractorRevision?: string;
}

// ---------------------------------------------------------------------------
// Result envelope
// ---------------------------------------------------------------------------

export interface LeanFieldRow {
  readonly status: "satisfied" | "unresolved";
  readonly value?: string;
  readonly reason?: string;
  readonly required: boolean;
  readonly evidenceIds: readonly string[];
  readonly judgmentCount: number;
  readonly inconsistentJudgments: number;
  /**
   * Source-uncertainty policy: last ACCEPTED per-source normalized
   * assessments (null = unknown), inspectable so uncertainty is visible
   * rather than coerced or dropped.
   */
  readonly assessments?: readonly LeanJudgeDocVerdict[][];
  /** Adapter attempt metadata for accepted judgments (raw probabilities,
   *  revisions, usage) — sanitized, no endpoint/credential material. */
  readonly judgeAttempts?: readonly unknown[];
  /** Full per-attempt audit trail: every protocol-valid attempted
   *  assessment set + metadata; rejected ones carry trusted:false and a
   *  reason. Accepted history lives in `assessments`. */
  readonly attemptedRecords?: readonly {
    trusted: boolean;
    reason?: string;
    assessments: (LeanJudgeDocVerdict | Record<string, unknown>)[];
    metadata: unknown;
  }[];
  /** Value-mode only: per-source extraction/validation attempts. */
  readonly candidates?: readonly CandidateFieldOutcome[];
  /** Value-mode only: accepted candidate provenance (undefined unless accepted). */
  readonly provenance?: CandidateProvenance;
  /** Value-mode only: the judgement that grounded acceptance. */
  readonly judgment?: CandidateJudgement;
}

export interface LeanEvidenceRecord {
  readonly evidenceId: string;
  readonly url: string;
  readonly title: string;
  readonly content: string;
  readonly byteLength: number;
  /** Queries that surfaced this URL (deduplicated); first = origin. */
  readonly origins: readonly string[];
}

export type LeanAcquisitionKind =
  | "search"
  | "search-failed"
  | "read"
  | "read-retry"
  | "read-failed"
  | "judge"
  | "judge-invalid"
  | "evidence-bytes-cap"
  | "evidence-oversize-rejected";

export interface LeanAcquisitionEvent {
  readonly kind: LeanAcquisitionKind;
  readonly detail: string;
  readonly at: number;
}

export interface LeanUsage {
  readonly searches: number;
  readonly readAttempts: number;
  readonly readsRetained: number;
  readonly judgeCalls: number;
  /** Value-mode counters (unified proof; 0 for enum-only runs). */
  readonly extractorCalls: number;
  readonly extractorCacheHits: number;
  readonly candidateJudgeCalls: number;
}

export interface LeanResult {
  readonly schemaVersion: 1;
  /** "empty" dropped (unified proof): mandatory-set unmet at zero accepted
   *  values is "partial". */
  readonly status: "complete" | "partial";
  readonly assessment: "semantic" | "deterministic-only";
  readonly question: string;
  readonly plan: {
    readonly queries: readonly {
      readonly query: string;
      readonly fieldId: string | null;
      readonly kind: "shared" | "primary" | "counterevidence";
    }[];
  };
  readonly data: Readonly<Record<string, string>>;
  readonly requirements: Readonly<Record<string, LeanFieldRow>>;
  readonly evidence: readonly LeanEvidenceRecord[];
  readonly acquisitionLog: readonly LeanAcquisitionEvent[];
  readonly usage: LeanUsage;
  readonly coverageNotes: readonly string[];
}

// ---------------------------------------------------------------------------
// Compiler (validation — zero acquisition on failure)
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function decodeStringArray(value: unknown, what: string): string[] {
  if (!Array.isArray(value)) {
    throw new ValidationError(`${what} must be an array of strings.`);
  }
  const out: string[] = [];
  for (const item of value) {
    if (!isNonEmptyString(item)) {
      throw new ValidationError(`${what} must contain only non-empty strings.`);
    }
    out.push(item);
  }
  return out;
}

/** Compiled field: normalized (criteria/dependsOn always arrays, required always boolean). */
export interface LeanCompiledField {
  readonly id: string;
  readonly question: string;
  readonly schema: LeanCompiledSchema;
  readonly criteria: readonly string[];
  readonly required: boolean;
  readonly dependsOn: readonly string[];
}

export interface LeanCompiledContract {
  readonly question: string;
  readonly scope: Readonly<Record<string, string>>;
  readonly fields: readonly LeanCompiledField[];
  readonly evidenceCriteria: readonly string[];
  readonly limits: LeanLimits;
}

/**
 * Compile + validate the caller contract. Throws ValidationError on
 * every malformed shape, unknown dependency, cycle, unsupported enum
 * value, over-ceiling limit or unknown limit key — always BEFORE any
 * acquisition (the engine only runs after this returns).
 */
export function compileLeanContract(input: unknown): LeanCompiledContract {
  if (!isPlainObject(input)) {
    throw new ValidationError("Lean investigation contract must be a JSON object.");
  }
  if (input.schemaVersion !== 1) {
    throw new ValidationError(
      `schemaVersion must be the number 1 (got ${JSON.stringify(input.schemaVersion)}).`,
    );
  }
  if (!isNonEmptyString(input.question)) {
    throw new ValidationError("question must be a non-empty string.");
  }

  let scope: Record<string, string> = {};
  if (input.scope !== undefined) {
    if (!isPlainObject(input.scope)) {
      throw new ValidationError("scope must be an object of string values.");
    }
    scope = {};
    for (const [key, value] of Object.entries(input.scope)) {
      if (!isNonEmptyString(key) || typeof value !== "string") {
        throw new ValidationError("scope keys must be non-empty and values strings.");
      }
      // Same reserved-key screen as field ids below: a JSON `__proto__` key
      // would invoke the legacy setter and be silently lost, not retained as
      // an own property — reject preflight rather than dropping the declared
      // scope. `constructor`/`prototype` stay allowed unless own-keyed.
      if (key === "__proto__") {
        throw new ValidationError(
          `scope key "__proto__" is reserved and cannot be declared.`,
        );
      }
      scope[key] = value;
    }
    if (Object.hasOwn(input.scope, "constructor") || Object.hasOwn(input.scope, "prototype")) {
      throw new ValidationError(
        `scope key "constructor"/"prototype" is reserved and cannot be declared.`,
      );
    }
  }

  if (!isPlainObject(input.requirements)) {
    throw new ValidationError("requirements must be an object keyed by field id.");
  }
  // Sol-review fix 4: reserved keys cannot be field ids. A parsed-JSON
  // `__proto__` key would mutate (not create) own properties on the
  // plain result maps — reject preflight, zero acquisition, rather
  // than silently losing the coverage row.
  // `constructor`/`prototype` are inherited on every plain object, so
  // only __proto__ needs the prototype-chain probe; own-property checks
  // cover the rest without rejecting ordinary fields.
  if (
    Object.hasOwn(input.requirements, "constructor") ||
    Object.hasOwn(input.requirements, "prototype")
  ) {
    throw new ValidationError(
      `requirements key "constructor"/"prototype" is reserved and cannot be used as a field id.`,
    );
  }
  if ("__proto__" in input.requirements && input.requirements.__proto__ !== Object.prototype) {
    throw new ValidationError(
      `requirements key "__proto__" is reserved and cannot be used as a field id.`,
    );
  }
  const fieldIds = Object.keys(input.requirements);
  if (fieldIds.length === 0) {
    throw new ValidationError("requirements must declare at least one field.");
  }
  if (fieldIds.length > LEAN_LIMIT_CEILINGS.maxFields) {
    throw new ValidationError(
      `requirements exceed the proof ceiling of ${LEAN_LIMIT_CEILINGS.maxFields} fields (${fieldIds.length}).`,
    );
  }

  const fields: LeanCompiledField[] = [];
  for (const id of fieldIds) {
    if (!isNonEmptyString(id)) {
      throw new ValidationError("requirement keys must be non-empty field ids.");
    }
    const raw = input.requirements[id];
    if (!isPlainObject(raw)) {
      throw new ValidationError(`requirements.${id} must be an object.`);
    }
    if (!isNonEmptyString(raw.question)) {
      throw new ValidationError(`requirements.${id}.question must be a non-empty string.`);
    }
    if (!isPlainObject(raw.schema)) {
      throw new ValidationError(`requirements.${id}.schema must be an object.`);
    }
    // Unified proof: discriminated schema — { enum: [...] } (exact-key
    // classification subset, Sol-review fix 2 semantics preserved) OR
    // { type: "string", pattern?, minLength?, maxLength? } (source-bound
    // value mode; pattern/length descriptors are enforced by the same
    // lean-candidates compilePattern/bounds screen at extraction time).
    // Anything else fails closed at the compiler boundary.
    const schemaKeys = Object.keys(raw.schema);
    let compiledSchema: LeanCompiledSchema;
    if ("enum" in raw.schema) {
      if (schemaKeys.length > 1 || schemaKeys[0] !== "enum") {
        throw new ValidationError(
          `requirements.${id}.schema carries unsupported keywords (${schemaKeys.filter((k) => k !== "enum").join(", ") || "enum+extras"}); classification mode supports exactly { enum: [...] }.`,
        );
      }
      if (!Array.isArray(raw.schema.enum)) {
        throw new ValidationError(`requirements.${id}.schema.enum must be an array.`);
      }
      // Keep declaration order; duplicates are rejected by the enum
      // validation below (a dedupe here would silently accept a caller
      // error the old proof failed loud on).
      compiledSchema = { mode: "classification", enum: [...(raw.schema.enum as string[])] };
    } else if (raw.schema.type === "string") {
      const allowed = new Set(["type", "pattern", "minLength", "maxLength"]);
      const extras = schemaKeys.filter((k) => !allowed.has(k));
      if (extras.length > 0) {
        throw new ValidationError(
          `requirements.${id}.schema carries unsupported keywords (${extras.join(", ")}); value mode supports exactly { type: "string", pattern?, minLength?, maxLength? }.`,
        );
      }
      compiledSchema = { mode: "value" };
      for (const key of ["pattern", "minLength", "maxLength"] as const) {
        const value = (raw.schema as Record<string, unknown>)[key];
        if (value === undefined) continue;
        if (key === "pattern") {
          if (!isNonEmptyString(value)) {
            throw new ValidationError(
              `requirements.${id}.schema.pattern must be a non-empty string.`,
            );
          }
          compiledSchema = { ...compiledSchema, pattern: value };
        } else if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
          throw new ValidationError(
            `requirements.${id}.schema.${key} must be a non-negative safe integer.`,
          );
        } else {
          compiledSchema = { ...compiledSchema, [key]: value };
        }
      }
      // Supported-descriptor preflight: run the SAME policy the
      // extractor-time validator enforces (min<=max, max<=4096,
      // screened pattern subset) here at compile, so an unsupported
      // declaration is rejected BEFORE any acquisition rather than
      // surfacing mid-run. One implementation, no restated rules.
      assertCandidateFieldSchema(id, {
        pattern: compiledSchema.pattern,
        minLength: compiledSchema.minLength,
        maxLength: compiledSchema.maxLength,
      });
    } else {
      throw new ValidationError(
        `requirements.${id}.schema must discriminate: { enum: [...] } or { type: "string", ... } (got keys: ${schemaKeys.join(", ") || "none"}).`,
      );
    }
    // Per-field scope overrides are likewise unsupported in this proof
    // (plan §"How multiple requirements relate": reject ambiguous
    // overrides rather than silently merging onto the common scope).
    if (raw.scope !== undefined) {
      throw new ValidationError(
        `requirements.${id}.scope per-field overrides are not supported; declare scope at the contract level.`,
      );
    }
    if (compiledSchema.mode === "classification") {
      const enumValues = compiledSchema.enum ?? [];
      if (enumValues.length === 0) {
        throw new ValidationError(`requirements.${id}.schema.enum must be non-empty.`);
      }
      const seen = new Set<string>();
      for (const value of enumValues) {
        if (!isNonEmptyString(value)) {
          throw new ValidationError(
            `requirements.${id}.schema.enum values must be non-empty strings.`,
          );
        }
        if (seen.has(value)) {
          throw new ValidationError(
            `requirements.${id}.schema.enum has a duplicate value "${value}".`,
          );
        }
        seen.add(value);
        if (!CLASSIFICATION_VALUES.has(value)) {
          throw new ValidationError(
            `requirements.${id}.schema.enum value "${value}" is outside the proof vocabulary ${[...CLASSIFICATION_VALUES].join("/")}.`,
          );
        }
      }
    }
    const criteria =
      raw.criteria === undefined
        ? []
        : decodeStringArray(raw.criteria, `requirements.${id}.criteria`);
    if (raw.required !== undefined && typeof raw.required !== "boolean") {
      throw new ValidationError(`requirements.${id}.required must be a boolean.`);
    }
    const dependsOn =
      raw.dependsOn === undefined
        ? []
        : decodeStringArray(raw.dependsOn, `requirements.${id}.dependsOn`);
    fields.push({
      id,
      question: raw.question,
      schema: compiledSchema,
      criteria,
      required: raw.required !== false,
      dependsOn,
    });
  }

  // Dependency graph: unknown refs, self refs, cycles — all fail loud.
  const fieldIdSet = new Set(fieldIds);
  for (const field of fields) {
    for (const dep of field.dependsOn) {
      if (!fieldIdSet.has(dep)) {
        throw new ValidationError(
          `requirements.${field.id}.dependsOn references unknown field "${dep}".`,
        );
      }
      if (dep === field.id) {
        throw new ValidationError(`requirements.${field.id}.dependsOn cannot reference itself.`);
      }
    }
  }
  const visitState = new Map<string, "visiting" | "done">();
  const visit = (id: string, path: string[]): void => {
    const state = visitState.get(id);
    if (state === "done") return;
    if (state === "visiting") {
      throw new ValidationError(`dependencies form a cycle: ${[...path, id].join(" -> ")}.`);
    }
    visitState.set(id, "visiting");
    const field = fields.find((f) => f.id === id);
    for (const dep of field?.dependsOn ?? []) visit(dep, [...path, id]);
    visitState.set(id, "done");
  };
  for (const field of fields) visit(field.id, []);

  let evidenceCriteria: string[] = [];
  if (input.evidence !== undefined) {
    if (!isPlainObject(input.evidence)) {
      throw new ValidationError("evidence must be an object.");
    }
    if (input.evidence.criteria !== undefined) {
      evidenceCriteria = decodeStringArray(input.evidence.criteria, "evidence.criteria");
    }
  }

  const limits: LeanLimits = {
    readBatchSize: LEAN_LIMIT_CEILINGS.readBatchSize,
    maxUniqueReads: LEAN_LIMIT_CEILINGS.maxUniqueReads,
    maxSearchAttempts: LEAN_LIMIT_CEILINGS.maxSearchAttempts,
    maxJudgeAttempts: LEAN_LIMIT_CEILINGS.maxJudgeAttempts,
    deadlineMs: LEAN_LIMIT_CEILINGS.deadlineMs,
    maxEvidenceBytesPerDoc: LEAN_LIMIT_CEILINGS.maxEvidenceBytesPerDoc,
    maxTotalEvidenceBytes: LEAN_LIMIT_CEILINGS.maxTotalEvidenceBytes,
  };
  if (input.limits !== undefined) {
    if (!isPlainObject(input.limits)) {
      throw new ValidationError("limits must be an object.");
    }
    for (const [key, value] of Object.entries(input.limits)) {
      if (!CALLER_LIMIT_KEYS.has(key)) {
        throw new ValidationError(
          `limits.${key} is not a recognized limit (known: ${[...CALLER_LIMIT_KEYS].join(", ")}).`,
        );
      }
      const ceiling: number = (LEAN_LIMIT_CEILINGS as unknown as Record<string, number>)[key]!;
      if (
        typeof value !== "number" ||
        !Number.isSafeInteger(value) ||
        value <= 0 ||
        value > ceiling
      ) {
        throw new ValidationError(
          `limits.${key} must be a positive integer <= the engine ceiling ${ceiling}.`,
        );
      }
      (limits as unknown as Record<string, number>)[key] = value;
    }
  }

  return { question: input.question, scope, fields, evidenceCriteria, limits };
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

