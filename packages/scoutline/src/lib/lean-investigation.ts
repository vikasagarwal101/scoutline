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
import { COMPOSED_STOP_ROOTS, composedStopRootOf } from "./lean-composed-stop.js";
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

// Only the declared caller-control bags are closed. Evidence extras,
// arbitrary scope entries and field IDs retain their existing policy.
const CONTRACT_KEYS: ReadonlySet<string> = new Set([
  "schemaVersion", "question", "scope", "requirements", "evidence", "limits",
]);
const REQUIREMENT_KEYS: ReadonlySet<string> = new Set([
  "question", "schema", "criteria", "required", "dependsOn",
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
    readonly origins?: readonly string[];
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
  const contractExtras = Object.keys(input).filter((key) => !CONTRACT_KEYS.has(key));
  if (contractExtras.length > 0) {
    throw new ValidationError(
      `Lean investigation contract carries unsupported keys (${contractExtras.join(", ")}).`,
    );
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
      // extractor-time validator enforces (min<=max, min/max<=4096,
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
    // Keep the explicit per-field-scope diagnostic above; other unknown
    // own enumerable controls must not silently disappear from the plan.
    const requirementExtras = Object.keys(raw).filter((key) => !REQUIREMENT_KEYS.has(key));
    if (requirementExtras.length > 0) {
      throw new ValidationError(
        `requirements.${id} carries unsupported keys (${requirementExtras.join(", ")}).`,
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

interface FieldState {
  readonly id: string;
  readonly req: LeanCompiledField;
  /**
   * Round-2 repair: per-evidence side history — the (supports, refutes)
   * pair last recorded for each retained evidenceId. A verdict flip on
   * an UNCHANGED representation (e.g. supports→refutes with no new
   * contrary content) is inconsistent model behavior, not discovered
   * counterevidence: it must never fabricate a dispute.
   */
  readonly sideHistory: Map<string, readonly [boolean | null, boolean | null, boolean | null]>;
  /** Round-2: judge threw — the field ends unresolved, never rejudged. */
  judgeUnavailable: boolean;
  /**
   * Dev-jev (parent-authorized): a RECOGNIZED typed indeterminate
   * judgment (code === "JEV_DEV_INDETERMINATE"). Not a service failure:
   * no contribution, pending cleared, judge stays available — the field
   * is rejudged only when the evidence identity changes; exhaustion
   * ends with the explicit judge_indeterminate reason.
   */
  judgeIndeterminate: boolean;
  pendingAccept: string | null;
  /** Evidence-identity key the current pendingAccept was decided on. */
  pendingSinceKey: string | null;
  disputedSinceKey: string | null;
  /** Counterevidence round coverage: issued = search returned; sources = URLs it surfaced. */
  ctrvIssued: boolean;
  /** URLs surfaced by this field's contrary query that are not yet retained. */
  ctrvSources: Set<string>;
  conflictUnresolvable: boolean;
  judgmentCount: number;
  inconsistentJudgments: number;
  /** ACCEPTED per-source normalized assessments, append-only history
   *  (uncertainty policy: earlier unknowns stay inspectable after later
   *  resolution on new context). */
  assessmentHistory: LeanJudgeDocVerdict[][];
  /** Adapter attempt metadata for ACCEPTED judgments (sanitized). */
  judgeAttemptMeta: unknown[];
  /**
   * Audit trail (uncertainty policy): EVERY protocol-valid attempted
   * assessment set + adapter metadata, recorded BEFORE the semantic
   * history decision, rejected ones marked { trusted: false, reason }.
   * Rejected records never contribute to acceptance and never overwrite
   * trusted history — recording a rejection is not accepting it.
   */
  attemptedRecords: {
    trusted: boolean;
    reason?: string;
    assessments: (LeanJudgeDocVerdict | Record<string, unknown>)[];
    metadata: unknown;
  }[];
  lastJudgedKey: string | null;
  relevantEvidenceIds: string[];
  terminal:
    | null
    | { readonly status: "satisfied"; readonly value: string }
    | { readonly status: "unresolved"; readonly reason: string };
  // --- value-mode (unified proof) state --------------------------------
  /** Extraction/validation outcomes per source, newest last. */
  candidateOutcomes: import("./lean-candidates.js").CandidateFieldOutcome[];
  /** Accepted-candidate provenance + judgement (until revoked). */
  acceptedCandidate: null | {
    readonly provenance: import("./lean-candidates.js").CandidateProvenance;
    readonly judgment: import("./lean-candidates.js").CandidateJudgement;
  };
  /** Every TRUSTED accept with the exact evidence context it was judged
   *  on (opposing id set). Retention: a trusted accept on the FINAL
   *  context survives later unknown/non-accepted candidates on other
   *  sources — the latest dispatch no longer erases it. */
  trustedAccepts: {
    readonly provenance: import("./lean-candidates.js").CandidateProvenance;
    readonly judgment: import("./lean-candidates.js").CandidateJudgement;
    readonly opposingIds: readonly string[];
    /** FULL judged-context identity: the exact content digests of the
     *  source and every opposing record AT TRUST TIME. A later same-ID
     *  content revision breaks the match — history can never authorize
     *  against changed bytes. */
    readonly sourceDigest: string;
    readonly opposingDigests: readonly string[];
    /** FULL recorded acceptance proof (final full-context repair): the
     *  validated candidate outcome plus the exact meaning/scope/
     *  dependency context the judgment was rendered under. History may
     *  authorize eligibility/bindings/pair-completeness/projection ONLY
     *  by re-running the deterministic `acceptCandidate` seam against
     *  the LIVE contract representations — an altered meaning, scope,
     *  dependency value or provenance revision fails the same
     *  `judgement_context_mismatch` gate an immediate acceptance would. */
    readonly outcome: import("./lean-candidates.js").CandidateFieldOutcome;
    readonly judgedContext: import("./lean-candidates.js").CandidateJudgedContext;
  }[];
  /** depBindings identity the current accepts were assessed under. */
  depBindingKey: string | null;
  /** Per-source assessment identities actually DISPATCHED (source
   *  context + opposing set). Re-judging an unchanged pair is not new
   *  information; only a changed pair earns a fresh judgment. */
  judgedSourceKeys: Set<string>;
  /** True when deps.judge === null (no semantic assessor). */
  noSemanticJudge: boolean;
  /** Typed harness/stop reason surfaced by a failing dependency
   *  (e.g. global_extraction_cap) — takes precedence over generic
   *  unavailability labels in the final reason. */
  stopReason: string | null;
  /** True when no extractor is configured for value mode. */
  noExtractor: boolean;
}

interface QueryPlanEntry {
  readonly query: string;
  readonly fieldId: string | null;
  readonly kind: "shared" | "primary" | "counterevidence";
}

/**
 * Run the lean investigation. `compileLeanContract` semantics apply
 * (throws ValidationError before any acquisition on bad input). All
 * network/semantic behavior is injected through `deps`; the engine
 * itself is deterministic given deterministic deps (no clocks, no
 * randomness of its own).
 */
export async function runLeanInvestigation(input: unknown, deps: LeanDeps): Promise<LeanResult> {
  const compiled = compileLeanContract(input);
  // Unified proof: value-mode deps arrive on the same object (extract,
  // candidateJudge, extractorRevision) — one engine, no second runner.
  const udeps = deps as LeanUnifiedDeps;
  const { limits } = compiled;

  // Frozen engine-owned query plan: shared question, then every field's
  // primary question, then every field's counterevidence round (repair
  // pass: counterevidence queries are no longer interleaved per-field —
  // under a shared search ceiling the interleaved order starved later
  // fields' contrary rounds; primaries-first gives every field its main
  // evidence before any contrary round). No runtime generative planner.
  const plan: QueryPlanEntry[] = [
    { query: compiled.question, fieldId: null, kind: "shared" },
    ...compiled.fields.map((f): QueryPlanEntry => ({
      query: f.question,
      fieldId: f.id,
      kind: "primary",
    })),
    ...compiled.fields.map((f): QueryPlanEntry => ({
      query: `${f.question} contrary evidence refuted`,
      fieldId: f.id,
      kind: "counterevidence",
    })),
  ];

  const fields = new Map<string, FieldState>();
  for (const f of compiled.fields) {
    fields.set(f.id, {
      id: f.id,
      req: f,
      sideHistory: new Map(),
      judgeUnavailable: false,
      judgeIndeterminate: false,
      pendingAccept: null,
      pendingSinceKey: null,
      disputedSinceKey: null,
      ctrvIssued: false,
      ctrvSources: new Set(),
      conflictUnresolvable: false,
      judgmentCount: 0,
      inconsistentJudgments: 0,
      assessmentHistory: [],
      judgeAttemptMeta: [],
      attemptedRecords: [],
      lastJudgedKey: null,
      relevantEvidenceIds: [],
      terminal: null,
      candidateOutcomes: [],
      acceptedCandidate: null,
      trustedAccepts: [],
      depBindingKey: null,
      judgedSourceKeys: new Set(),
      noSemanticJudge: false,
      noExtractor: false,
      stopReason: null,
    });
  }

  const evidence: LeanEvidenceRecord[] = [];
  const originsByUrl = new Map<string, Set<string>>();
  const log: LeanAcquisitionEvent[] = [];
  const coverageNotes: string[] = [];
  const queue: { url: string; title: string }[] = [];
  const queuedUrls = new Set<string>();
  const attemptedUrls = new Set<string>();
  const issuedQueries = new Set<string>();
  let readPtr = 0;
  let queryIdx = 0;
  let searches = 0;
  let readAttempts = 0;
  let readsRetained = 0;
  let judgeCalls = 0;
  let extractorCalls = 0;
  // Run-level typed harness stop (e.g. global_extraction_cap): once a
  // dependency physically refused further work, acquisition coverage is
  // INCOMPLETE — no value field may finalize its accept on the claim
  // that the current context is final.
  let runTypedStop: string | null = null;
  // Composed-stop root carried by a collaborator rejection. The typed
  // collaborators disagree on the carrier field: the direct-TypeSafe
  // judge attaches it as `stopReason` (TypesafeRejection), while
  // transport-style adapters rethrow it as `reason` alongside an
  // EVAL_STOPPED code. Both promote ONLY through the exact
  // COMPOSED_STOP_ROOTS vocabulary — an arbitrary string on either
  // field is discarded, so the finite trust boundary is unchanged.
  const composedRootOf = (error: unknown): string | null => {
    const carrier = error as { stopReason?: unknown; reason?: unknown } | null;
    for (const value of [carrier?.stopReason, carrier?.reason]) {
      if (typeof value === "string" && COMPOSED_STOP_ROOTS.has(value)) return value;
    }
    return null;
  };
  let extractorCacheHits = 0;
  let candidateJudgeCalls = 0;
  let retainedBytes = 0;
  const startMs = deps.now();
  // Caller-rounds seed (caller-assisted ticket): retained evidence and
  // round-scoped lead exclusions injected BEFORE the loop. A seeded
  // record carries its origins and counts toward this round's retained
  // bytes without an HTTP reread; seeded leads are queued as NEW
  // eligible work (a prior round's failed read requeues with a fresh
  // attempt budget — prior failure never becomes coverage).
  const seed = (deps as { seed?: LeanSeed }).seed;
  if (seed !== undefined) {
    for (const rec of seed.evidence ?? []) {
      const byteLength = Buffer.byteLength(rec.content, "utf8");
      evidence.push({ ...rec, byteLength });
      // Reused context is not newly admitted round bytes.
      originsByUrl.set(rec.url, new Set(rec.origins));
    }
    for (const lead of seed.leads ?? []) {
      // Carried lineage is metadata, never imported search/proof coverage.
      const carrier = lead.origins;
      const carriedOrigins = Array.isArray(carrier) ? [...carrier] : [];
      if (
        carriedOrigins.length > 0 &&
        carriedOrigins.every((origin) => typeof origin === "string")
      ) {
        const origins = originsByUrl.get(lead.url) ?? new Set<string>();
        for (const origin of carriedOrigins) origins.add(origin);
        originsByUrl.set(lead.url, origins);
      }
      if (queuedUrls.has(lead.url)) continue;
      queuedUrls.add(lead.url);
      queue.push({ url: lead.url, title: lead.title });
    }
    // Prior-round successful searches are reusable coverage under an
    // unchanged basis (rounds spec): mark their queries issued so this
    // round does not repeat identical paid searches. The searches
    // counter stays per-round and counts only NEW dispatches. The plan
    // pointer skips the reused prefix (plan order is frozen, so an
    // issued prefix is exactly the reusable-coverage set).
    for (const q of seed.issuedQueries ?? []) issuedQueries.add(q);
    // Skip only actual reused entries, never a count-as-prefix.
    while (queryIdx < plan.length && issuedQueries.has(plan[queryIdx]!.query)) queryIdx += 1;
    // Contrary-round coverage state follows the same reuse basis: a
    // field's contrary query is settled iff it was issued successfully
    // in a prior round (its surfaced URLs are either retained seeds
    // above or requeued unread leads).
    for (const f of fields.values()) {
      if (issuedQueries.has(`${f.req.question} contrary evidence refuted`)) {
        f.ctrvIssued = true;
        for (const lead of seed.leads ?? []) f.ctrvSources.add(lead.url);
      }
    }
  }
  const namespaceOf = (f: FieldState): string =>
    JSON.stringify([
      compiled.question,
      compiled.scope,
      f.req,
      compiled.evidenceCriteria,
      seed?.identity ?? null,
    ]);
  const contextOf = (): string =>
    JSON.stringify(
      evidence.map((e) => [e.evidenceId, createHash("sha256").update(e.content).digest("hex")]),
    );
  if (seed?.history !== undefined) {
    const reopenedContraryFields = new Set<string>();
    const restoredDependencyGaps = new Map<string, string>();
    for (const f of fields.values()) {
      // Unknown judge/policy identity NEVER restores history: an absent
      // identity token cannot assert the same basis (a swapped judge would
      // inherit a stale accept). Live revalidation still governs; only a
      // caller-PINNED identity participates in cross-round reuse.
      if (seed.identity === undefined) continue;
      const matches = seed.history.filter((h) => h.namespace === namespaceOf(f));
      const exact = [...matches].reverse().find((h) => h.context === contextOf());
      const latest = exact ?? matches.at(-1);
      if (latest === undefined) continue;
      const state = structuredClone(latest.state);
      Object.assign(f, state, { id: f.id, req: f.req });
      Object.assign(f, {
        sideHistory: new Map(
          state.sideHistory as [
            string,
            readonly [boolean | null, boolean | null, boolean | null],
          ][],
        ),
      });
      f.ctrvSources = new Set([
        ...(state.ctrvSources as string[]),
        ...(seed.leads ?? []).map((l) => l.url),
      ]);
      f.judgedSourceKeys = new Set(state.judgedSourceKeys as string[]);
      // New opposition/prerequisite context requires a new assessment,
      // preserving SAME-meaning stability and rejected history.
      // Round-local availability reasons (no_extractor/no_semantic_judge) describe
      // THIS round's collaborators, never a settled disposition: a restored
      // unresolved field reopens when its availability flags disagree with
      // the current deps (a proposal extractor or a configured judge), so
      // a caller proposal can be assessed on the same retained context.
      const roundLocal =
        exact !== undefined &&
        f.terminal?.status === "unresolved" &&
        (f.noExtractor || f.noSemanticJudge || f.judgeUnavailable || f.judgeIndeterminate) &&
        (f.noExtractor !== (udeps.extract == null) || f.noSemanticJudge !== (deps.judge === null));
      if (
        exact !== undefined &&
        f.terminal?.status === "unresolved" &&
        f.stopReason === null &&
        typeof f.terminal.reason === "string" &&
        f.terminal.reason.startsWith("prerequisite_unresolved:")
      ) {
        const dep = f.terminal.reason.slice("prerequisite_unresolved:".length);
        if (f.req.dependsOn.includes(dep)) restoredDependencyGaps.set(f.id, dep);
      }
      if (exact === undefined || roundLocal || (seed.leads?.length ?? 0) > 0) {
        f.terminal = null;
        f.lastJudgedKey = null;
        f.depBindingKey = null;
        f.acceptedCandidate = null;
        f.judgeUnavailable = false;
        // Producer availability is a property of THIS round's deps, never
        // of the prior round's: a caller proposal (local extractor) or a
        // newly configured producer reopens extraction eligibility.
        f.noExtractor = false;
        f.noSemanticJudge = deps.judge === null;
        f.judgeIndeterminate = false;
        f.stopReason = null;
        f.pendingAccept = null;
        f.pendingSinceKey = null;
        f.disputedSinceKey = null;
      } else if (
        exact !== undefined &&
        f.terminal?.status === "unresolved" &&
        f.terminal.reason === "counterevidence_not_acquired" &&
        f.stopReason === null &&
        !f.ctrvIssued &&
        limits.maxSearchAttempts > 0 &&
        plan.some((entry) =>
          entry.fieldId === f.id &&
          entry.kind === "counterevidence" &&
          !issuedQueries.has(entry.query),
        )
      ) {
        // Fresh acquisition may finish an unmet contrary round. Keep the
        // exact-context judgment/proof caches; only its local stop reopens.
        f.terminal = null;
        reopenedContraryFields.add(f.id);
      }
    }
    // Reconsider only saved gaps caused by this continuation's reopened
    // prerequisites. Retaining no new document must not strand their closure.
    const reopenedDependencies = new Set(reopenedContraryFields);
    for (let pass = 0; runTypedStop === null && pass < fields.size; pass += 1) {
      let reopened = false;
      for (const [id, dep] of restoredDependencyGaps) {
        const f = fields.get(id)!;
        if (
          !reopenedDependencies.has(dep) ||
          f.stopReason !== null ||
          f.terminal?.status !== "unresolved" ||
          f.terminal.reason !== `prerequisite_unresolved:${dep}`
        ) continue;
        f.terminal = null;
        reopenedDependencies.add(id);
        reopened = true;
      }
      if (!reopened) break;
    }
  }

  // Whole-run deadline guard: MUST be consulted before EVERY physical
  // dispatch (extract, enum judge, candidate judge, read, search), not
  // once per scheduler iteration — a single iteration can chain several
  // dispatches and one of them can consume the remaining time.
  // The run owns an AbortController: every dependency receives the
  // signal + the REMAINING time so an in-flight native request is
  // bounded by the whole-run deadline, not only the next dispatch.
  // (Pre-dispatch gating alone cannot stop a request begun before
  // expiry from running past it.)
  const runAbort = new AbortController();
  // Run expiry OWNER: the wall-clock timer aborts an in-flight awaited
  // request even when the engine itself never resumes to call expired()
  // (deterministic deps can freeze the injected clock; the timer is
  // engine-owned real time). Cleared on every exit path below.
  const expiryTimer = setTimeout(() => runAbort.abort(), limits.deadlineMs);
  // Owned-interruption integration seam (unified-investigation
  // correction 7, parent-authorized minimum patch): a dispatcher-level
  // SIGINT registrar hands the run an EXTERNAL AbortSignal; aborting it
  // aborts runAbort — every in-flight dependency dispatch sees the same
  // signal, the expiry timer stays owned by the run, and listener
  // cleanup happens exactly at this run's exit paths. The bridge is
  // one-directional (external → run): the engine's own deadline cannot
  // fire the external signal. Absent → byte-identical behavior.
  const externalSignal = (deps as { externalSignal?: AbortSignal }).externalSignal;
  // ONE guaranteed ownership scope (consolidated root 5): the wall-clock
  // timer and the external-signal listener are released together on
  // EVERY exit — normal return, early return, and a dependency/clock
  // throw — so an exceptional run never leaves a live timer or a
  // retained listener behind. `releaseRunResources` is idempotent.
  let onExternalAbort: (() => void) | undefined;
  if (externalSignal !== undefined) {
    onExternalAbort = () => runAbort.abort();
    externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    if (externalSignal.aborted) runAbort.abort();
  }
  let runResourcesReleased = false;
  const releaseRunResources = (): void => {
    if (runResourcesReleased) return;
    runResourcesReleased = true;
    clearTimeout(expiryTimer);
    if (onExternalAbort !== undefined)
      externalSignal?.removeEventListener("abort", onExternalAbort);
  };
  try {
    // Optional composition channel: a runtime harness that owns a GLOBAL
    // wall may publish its known stop root here. When the engine's own
    // clock stops dispatching before any dependency call can surface a
    // typed error, this is how the actual root (not a generic local
    // deadline) reaches the terminal reasons. Absent -> engine behaves
    // exactly as before. Read only, never invented.
    const harnessStopRoot = (): string | null => {
      const fn = (deps as { runStopReason?: () => unknown }).runStopReason;
      if (typeof fn !== "function") return null;
      const value = fn();
      return typeof value === "string" && COMPOSED_STOP_ROOTS.has(value) ? value : null;
    };
    const dispatchOptions = (): { timeoutMs: number; signal: AbortSignal } => ({
      timeoutMs: Math.max(1, limits.deadlineMs - (deps.now() - startMs)),
      signal: runAbort.signal,
    });
    // Dispatch gate (consolidated root 5): a run stops dispatching when
    // its wall expires OR when the owning invocation cancelled it — the
    // external signal is consulted INDEPENDENTLY of whether any injected
    // dependency honours its signal, so a pre-aborted (or mid-run
    // aborted) signal means zero new work from the next gate onward.
    const cancelled = (): boolean => externalSignal?.aborted === true;
    const expired = (): boolean => {
      if (runTypedStop !== null) return true;
      if (cancelled()) {
        runAbort.abort();
        return true;
      }
      if (runAbort.signal.aborted || deps.now() - startMs >= limits.deadlineMs) {
        runAbort.abort();
        return true;
      }
      return false;
    };

    // Sanitized failed-attempt observation allowlist: ONLY known typed
    // codes and validated measured fields survive into the audit — raw
    // error.message, headers, bodies, credentials and arbitrary observed
    // keys are dropped at this boundary, not downstream. Unknown values
    // stay null/absent, never zero.
    const SAFE_FAILED_OBSERVATION_KEYS: ReadonlySet<string> = new Set([
      "requestSha256",
      "resolvedModel",
      "requestedModel",
      "usage",
      "elapsedMs",
      "status",
    ]);
    const sanitizeObservation = (observed: unknown): Record<string, unknown> | undefined => {
      if (observed === null || typeof observed !== "object") return undefined;
      const out: Record<string, unknown> = {};
      let any = false;
      for (const [key, value] of Object.entries(observed as Record<string, unknown>)) {
        if (!SAFE_FAILED_OBSERVATION_KEYS.has(key)) continue;
        if (key === "usage") {
          const u = value as {
            inputTokens?: unknown;
            outputTokens?: unknown;
            reasoningTokens?: unknown;
          } | null;
          if (u !== null && typeof u === "object") {
            const usage: Record<string, number> = {};
            for (const [tk, tv] of [
              ["inputTokens", u.inputTokens],
              ["outputTokens", u.outputTokens],
              ["reasoningTokens", u.reasoningTokens],
            ] as const) {
              if (typeof tv === "number" && Number.isSafeInteger(tv) && tv >= 0) usage[tk] = tv;
            }
            out.usage = usage;
            any = true;
          }
          continue;
        }
        if (key === "elapsedMs") {
          if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
            out.elapsedMs = value;
            any = true;
          }
          continue;
        }
        if (key === "status") {
          if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
            out.status = value;
            any = true;
          }
          continue;
        }
        // hash / model id strings
        if (typeof value === "string" && value.length > 0 && value.length <= 512) {
          out[key] = value;
          any = true;
        }
      }
      return any ? out : undefined;
    };
    const safeErrorCode = (code: unknown): string => {
      // Typed transport codes only — never free text.
      return typeof code === "string" && /^[A-Z][A-Z0-9_]{2,63}$/.test(code) ? code : "unknown";
    };

    // Complete assembled semantic-request bound (caller-rounds root 3): the
    // FULL serialized judge/candidate-judge request — every reused and new
    // document, framing question, criteria and prerequisite bindings — must
    // fit the 256KiB assessment-context ceiling BEFORE dispatch. Overflow is
    // an explicit incomplete assessment (0 semantic dispatch), never a silent
    // truncation and never an oversized shipped payload. Body-byte caps alone
    // do not bound the assembled context (framing and seeding bypass them).
    const ASSEMBLED_CONTEXT_MAX_BYTES = 256 * 1024;
    const assembledContextOverflow = (fieldId: string, request: unknown): boolean =>
      Buffer.byteLength(JSON.stringify(request), "utf8") > ASSEMBLED_CONTEXT_MAX_BYTES &&
      (contextOverflowFields.add(fieldId), true);
    const contextOverflowFields = new Set<string>();
    const pushLog = (kind: LeanAcquisitionKind, detail: string): void => {
      log.push({ kind, detail, at: deps.now() - startMs });
    };

    const evidenceKey = (): string => evidence.map((e) => e.evidenceId).join(",");

    // --- value-mode helpers (unified proof) -------------------------------
    /** depBindings for a field: accepted prerequisite value + provenance.
     *  Identical object travels to the extractor payload and the candidate
     *  judge state; its JSON identity keys the assessment context. */
    const depBindingsFor = (f: FieldState): Record<string, DepBinding> => {
      const out: Record<string, DepBinding> = {};
      for (const dep of f.req.dependsOn) {
        const d = fields.get(dep);
        // Provisional accepted candidate unblocks dependants for
        // scheduling; the binding must carry it too (same accept the
        // dependant is conditioned on).
        // Terminal status is not proof. A VALUE prerequisite binds from
        // its MATCHED full proof (standing first, then retained); an
        // unproven one contributes no binding. An ENUM prerequisite keeps
        // its recorded classification-evidence binding.
        const prereqSatisfied =
          d !== undefined &&
          (d.req.schema.mode !== "value"
            ? d.terminal?.status === "satisfied"
            : currentBindingOf(dep) !== null);
        // VALUE prerequisite: publish the proven binding itself, so a raw
        // terminal/provisional provenance can never authorize a dependent.
        if (d !== undefined && d.req.schema.mode === "value") {
          const proven =
            (d.acceptedCandidate !== null ? standingProofOf(d) : null) ?? retainedProofOf(d);
          if (proven === null) continue;
          out[dep] = {
            value: proven.provenance.value,
            evidenceId: proven.provenance.sourceId,
            sourceDigest: proven.provenance.sourceDigest,
          };
          continue;
        }
        if (!prereqSatisfied || d === undefined) continue;
        if (d.acceptedCandidate !== null) {
          const { provenance } = d.acceptedCandidate;
          out[dep] = {
            value: provenance.value,
            evidenceId: provenance.sourceId,
            sourceDigest: provenance.sourceDigest,
          };
        } else if (d.terminal?.status === "satisfied") {
          // enum prerequisite: provenance is the accepted judgment's
          // relevant evidence (first relevant id + digest of that record).
          const evId = d.relevantEvidenceIds[0] ?? "";
          const rec = evidence.find((e) => e.evidenceId === evId);
          out[dep] = {
            value: d.terminal.value,
            evidenceId: evId,
            sourceDigest:
              rec === undefined
                ? ""
                : createHash("sha256").update(rec.content, "utf8").digest("hex"),
          } as DepBinding;
        }
      }
      return out;
    };

    const depBindingKeyOf = (f: FieldState): string => JSON.stringify(depBindingsFor(f));

    /** Field-level extractor cache: extraction reuse only (Q2 verdict) —
     *  keyed on source digest + field ids + per-field schema + scope +
     *  depBindings + extractor revision. Judgments are never reused. */
    const extractionCache = new Map<string, import("./lean-candidates.js").ValidationResult>();
    const extractionKey = (
      source: LeanEvidenceRecord,
      f: FieldState,
      bindings: Record<string, DepBinding>,
    ): string =>
      JSON.stringify([
        source.evidenceId,
        createHash("sha256").update(source.content, "utf8").digest("hex"),
        f.id,
        f.req.schema,
        // Criteria are part of the extraction contract (common evidence
        // criteria included — changed criteria invalidate the cache).
        [...f.req.criteria, ...compiled.evidenceCriteria],
        compiled.scope,
        bindings,
        udeps.extractorRevision ?? "unspecified",
      ]);

    const hasUnread = (): boolean => {
      while (readPtr < queue.length && attemptedUrls.has(queue[readPtr]!.url)) readPtr += 1;
      return readPtr < queue.length;
    };

    const nextUnissuedQuery = (index: number): number => {
      while (index < plan.length && issuedQueries.has(plan[index]!.query)) index += 1;
      return index;
    };
    const noMoreAcquisition = (): boolean =>
      !canReadMore() &&
      (nextUnissuedQuery(queryIdx) >= plan.length || searches >= limits.maxSearchAttempts);
    // Unread URLs under an exhausted read cap can never be read — they
    // are not future acquisition for progress purposes (the contrary
    // round records them as unassessed coverage, which blocks acceptance
    // honestly instead).
    const canReadMore = (): boolean => hasUnread() && attemptedUrls.size < limits.maxUniqueReads;

    // One paid query may be the contrary round of several fields. Only
    // genuine success settles coverage; every owner keeps its unread URLs.
    const recordSearchSuccess = (query: string, results: readonly LeanSearchResult[]): void => {
      issuedQueries.add(query);
      const retainedUrls = new Set(evidence.map((e) => e.url));
      for (const f of fields.values()) {
        if (query !== `${f.req.question} contrary evidence refuted`) continue;
        f.ctrvIssued = true;
        for (const result of results) {
          if (typeof result.url !== "string" || result.url.length === 0) continue;
          if (!retainedUrls.has(result.url)) f.ctrvSources.add(result.url);
        }
      }
    };

    /** FULL live-identity validation of a trusted accept (final
     *  full-context repair): the recorded source/opposing evidence IDs
     *  must match the CURRENT retained set, live content digests must
     *  equal the trust-time digests (same-ID content revision breaks the
     *  match), AND the recorded acceptance proof must RE-PASS the exact
     *  deterministic `acceptCandidate` seam against the LIVE contract
     *  context — live field meaning/criteria, live compiled scope, live
     *  opposing records and the CURRENT dependency bindings. An accept
     *  judged under an altered meaning, scope, dependency value or
     *  provenance revision fails `judgement_context_mismatch` here,
     *  exactly as an immediate acceptance would. History authorizes
     *  eligibility, reconciled bindings, pair completion and final
     *  projection ONLY through this check — no ID-only or digest-only
     *  shortcut survives alongside it. */

    const currentBindingOf = (
      dep: string,
    ): { value: string; evidenceId: string; sourceDigest: string } | null => {
      const d = fields.get(dep);
      if (d === undefined) return null;
      // ENUM prerequisites keep their recorded value-mode binding
      // semantics: the classification judgment's own evidence record is
      // the provenance. Enum history policy is unchanged.
      if (d.req.schema.mode !== "value") {
        if (d.terminal?.status !== "satisfied") return null;
        const evId = d.relevantEvidenceIds[0] ?? "";
        const rec = evidence.find((e) => e.evidenceId === evId);
        if (rec === undefined) return null;
        return {
          value: d.terminal.value,
          evidenceId: evId,
          sourceDigest: createHash("sha256").update(rec.content, "utf8").digest("hex"),
        };
      }
      // VALUE prerequisites: terminal status is NOT proof. A satisfied
      // terminal and a standing provisional accept both resolve through
      // the SAME matched full proof, so a raw terminal/provisional
      // provenance can never authorize a dependent by itself.
      // The STANDING accept when there is one, else the best passing
      // retained accept — both validated by the same full proof, in that
      // order, so a terminal or provisional raw provenance never resolves
      // on its own.
      const proof =
        (d.acceptedCandidate !== null ? standingProofOf(d) : null) ?? retainedProofOf(d);
      if (proof === null) return null;
      return {
        value: proof.provenance.value,
        evidenceId: proof.provenance.sourceId,
        sourceDigest: proof.provenance.sourceDigest,
      };
    };

    /** The best passing retained-history proof for a field, or null. */
    const retainedProofOf = (f: FieldState): AcceptProof | null => {
      for (const t of f.trustedAccepts) {
        const proven = proveAccept(t);
        if (proven !== null) return proven;
      }
      return null;
    };

    /** A candidate acceptance plus the exact judged context it was
     *  rendered under — the single proof shape every authorization path
     *  (retained history AND the standing accept) is validated against. */
    type AcceptProof = {
      readonly provenance: import("./lean-candidates.js").CandidateProvenance;
      readonly judgment: import("./lean-candidates.js").CandidateJudgement;
      readonly outcome: import("./lean-candidates.js").CandidateFieldOutcome;
      readonly judgedContext: import("./lean-candidates.js").CandidateJudgedContext;
      readonly opposingIds: readonly string[];
      readonly sourceDigest: string;
      readonly opposingDigests: readonly string[];
    };

    /** FULL live validation of a candidate acceptance proof. Re-runs the
     *  deterministic `acceptCandidate` seam against the LIVE contract
     *  representations: retained source/opposing IDs must match the
     *  current retained set, live content digests must equal the recorded
     *  ones (same-ID revision fails), every recorded dependency must equal
     *  the prerequisite's authoritative current binding (value AND
     *  provenance revision), and the acceptance itself must re-pass
     *  `acceptCandidate` under the live meaning/scope/opposition/dependency
     *  context. Returns the MATCHED proof, or null — never a substituted
     *  or empty default, so a missing proof fails closed. */
    const proveAccept = (t: AcceptProof): AcceptProof | null => {
      const finalIds = [...evidence.map((e) => e.evidenceId)].sort();
      const judgedSet = [...t.opposingIds, t.provenance.sourceId].sort();
      if (judgedSet.length !== finalIds.length) return null;
      if (!judgedSet.every((id, i) => id === finalIds[i])) return null;
      const digest = (id: string): string | null => {
        const rec = evidence.find((e) => e.evidenceId === id);
        return rec === undefined
          ? null
          : createHash("sha256").update(rec.content, "utf8").digest("hex");
      };
      const liveSourceDigest = digest(t.provenance.sourceId);
      if (liveSourceDigest === null || liveSourceDigest !== t.sourceDigest) return null;
      const liveOpposingDigests = t.opposingIds.map((id) => digest(id));
      if (liveOpposingDigests.some((d) => d === null)) return null;
      if (!t.opposingDigests.every((d, i) => liveOpposingDigests[i] === d)) return null;
      if (t.outcome === undefined || t.judgedContext === undefined) return null;
      const liveSource = evidence.find((e) => e.evidenceId === t.provenance.sourceId);
      if (liveSource === undefined) return null;
      const liveOpposingRecords = t.opposingIds
        .map((id) => evidence.find((e) => e.evidenceId === id))
        .filter((e): e is LeanEvidenceRecord => e !== undefined);
      if (liveOpposingRecords.length !== t.opposingIds.length) return null;
      const liveOwner = fields.get(t.outcome.fieldId);
      if (liveOwner === undefined) return null;
      // Every recorded dependency must resolve, through the SAME full
      // proof, to a prerequisite whose CURRENT accepted value AND
      // provenance revision are exactly what this accept was judged under.
      const recordedDeps = t.judgedContext.depBindings ?? {};
      for (const dep of Object.keys(recordedDeps).sort()) {
        const rec = recordedDeps[dep];
        const live = currentBindingOf(dep);
        if (rec === undefined || live === null) return null;
        if (
          rec.value !== live.value ||
          rec.evidenceId !== live.evidenceId ||
          rec.sourceDigest !== live.sourceDigest
        ) {
          return null;
        }
      }
      const liveMeanings: Record<string, string> = {
        [t.outcome.fieldId]: [
          liveOwner.req.question,
          ...liveOwner.req.criteria,
          ...compiled.evidenceCriteria,
        ].join("\n"),
      };
      const reaccepted = acceptCandidate(t.outcome, t.judgment, liveSource, liveSourceDigest, {
        fieldMeanings: liveMeanings,
        scope: compiled.scope,
        opposingContext: liveOpposingRecords,
        depBindings: depBindingsFor(liveOwner),
      });
      return reaccepted.status === "accepted" ? t : null;
    };

    /** Boolean form: a full proof exists for this accept. Missing or
     *  non-passing proof is false — never vacuously true. */
    const liveIdentityOf = (t: AcceptProof): boolean => proveAccept(t) !== null;

    /** The FULL proof for the STANDING accept, validated against the
     *  live contract. A standing accept that cannot be proven publishes
     *  nothing: authorization requires a non-null matched proof, never an
     *  empty dependency map. */
    const standingProofOf = (f: FieldState): AcceptProof | null => {
      const a = f.acceptedCandidate;
      if (a === null) return null;
      const recorded = f.trustedAccepts.find(
        (x) =>
          x.provenance.sourceId === a.provenance.sourceId &&
          x.provenance.value === a.provenance.value &&
          x.provenance.quote === a.provenance.quote &&
          x.provenance.sourceDigest === a.provenance.sourceDigest &&
          x.judgment.candidateId === a.judgment.candidateId,
      );
      if (recorded === undefined) return null;
      return proveAccept(recorded);
    };

    /** Authoritative CURRENT prerequisite binding: the prerequisite's
     *  projected/terminal accept when settled, else its provisional
     *  accept, else a retained accept that passes the FULL live proof.
     *  Shared by every history authorization path and by final
     *  projection, so a dependent can never be published against a
     *  prerequisite value or provenance revision other than this one. */

    // Run-local turns only: no scheduler cursor leaks into checkpoints.
    const lastValueTurn = new Map<string, number>();
    let valueTurn = 0;
    const pendingValueTurns = new Map<string, { basis: string; visited: Set<string> }>();

    const eligibleFields = (): FieldState[] => {
      const out: FieldState[] = [];
      // A prerequisite is unblocking when it is terminally satisfied OR
      // carries a provisional accepted candidate on the current context
      // (final-context revocation still reopens dependants if that accept
      // is later revoked — dirtying handles the rollback).
      const unblocking = (dep: string): boolean => {
        const d = fields.get(dep);
        if (d === undefined) return false;
        if (d.terminal?.status === "satisfied" && d.req.schema.mode !== "value") return true;
        if (d.terminal?.status === "satisfied" || d.acceptedCandidate !== null) {
          if (d.req.schema.mode === "value") {
            const proof =
              (d.acceptedCandidate !== null ? standingProofOf(d) : null) ?? retainedProofOf(d);
            if (proof !== null) return true;
          }
        }
        // A STANDING accept authorizes dependent work only through the
        // same full live proof as retained history — an unproven standing
        // accept unblocks nothing.
        if (d.acceptedCandidate !== null) return standingProofOf(d) !== null;
        // Reconciliation: a prerequisite whose active accept was cleared by a
        // later unknown/non-accepted candidate STILL unblocks when trusted
        // history holds an accept judged on the EXACT current retained source
        // set (full opposing-context identity; smaller/stale contexts never
        // unblock). GATED on acquisition quiescence: new dependent work is
        // scheduled only once no further read/search can change the context,
        // preserving the dispatch order the originally-eligible fields
        // established. Revocation machinery reopens dependents if the accept
        // is later revoked.
        if (!noMoreAcquisition()) return false;
        return d.trustedAccepts.some((t) => liveIdentityOf(t));
      };
      for (const f of fields.values()) {
        if (f.terminal !== null) continue;
        const blocked = f.req.dependsOn.some((dep) => !unblocking(dep));
        if (!blocked) out.push(f);
      }

      // Fair mandatory allocation: the REQUIRED TRANSITIVE DEPENDENCY
      // CLOSURE gets first claim on the shared semantic budget. Required
      // alone is not enough — a mandatory field blocked on an OPTIONAL
      // prerequisite must pull that prerequisite (and its ancestors) into
      // the priority set, or unrelated optional work in declaration order
      // starves the closure. Raising the cap is not fairness — the
      // closure computation is.
      const requiredClosure = new Set<string>();
      // A field is in the required closure iff it is required OR a
      // required field (transitively) depends on it — i.e. traverse
      // dependsOn FORWARD from every open required field. A mandatory
      // field blocked on an optional prerequisite pulls that prerequisite
      // (and its ancestors) into the priority set. Cycles are already
      // rejected at compile, so this recursion terminates.
      const addWithPrereqs = (id: string): void => {
        if (requiredClosure.has(id)) return;
        requiredClosure.add(id);
        const f = fields.get(id);
        if (f === undefined) return;
        for (const dep of f.req.dependsOn) addWithPrereqs(dep);
      };
      for (const f of fields.values()) {
        if (f.terminal === null && f.req.required) addWithPrereqs(f.id);
      }
      const priority: FieldState[] = [];
      const deferred: FieldState[] = [];
      // Reconciled dependents (unblocked only by trusted-history
      // prerequisite recovery, not by a terminal/provisional accept) run
      // LAST within their tier: their work is newly enabled by a late
      // recovery, and deferring preserves the dispatch order the
      // originally-eligible fields established before the recovery.
      const reconciled: FieldState[] = [];
      const isReconciledOnly = (f: FieldState): boolean =>
        f.req.dependsOn.some((dep) => {
          const d = fields.get(dep);
          if (d === undefined) return false;
          if (d.terminal?.status === "satisfied" || d.acceptedCandidate !== null) return false;
          return d.trustedAccepts.some((t) => liveIdentityOf(t));
        });
      for (const f of out) {
        if (isReconciledOnly(f)) reconciled.push(f);
        else (requiredClosure.has(f.id) ? priority : deferred).push(f);
      }
      // Prerequisite-first WITHIN each tier. Tier order (required closure,
      // then optionals, then reconciled-only) is the mandatory-closure
      // fairness contract and is preserved exactly; only ties inside a
      // tier are broken by open-prerequisite depth, so a descendant
      // declared before its prerequisite still runs after it. Acyclic
      // input (compile rejects cycles) makes this ordering total.
      const depth = (f: FieldState, seen: Set<string>): number => {
        if (seen.has(f.id)) return 0;
        seen.add(f.id);
        let max = 0;
        for (const dep of f.req.dependsOn) {
          const d = fields.get(dep);
          if (d !== undefined && d.terminal === null) max = Math.max(max, 1 + depth(d, seen));
        }
        return max;
      };
      const prereqFirst = (list: FieldState[]): FieldState[] =>
        list
          .map((f, i) => ({ f, i, d: depth(f, new Set()) }))
          .sort((a, b) =>
            a.d - b.d ||
            (lastValueTurn.get(a.f.id) ?? 0) - (lastValueTurn.get(b.f.id) ?? 0) ||
            a.i - b.i,
          )
          .map((x) => x.f);
      return [...prereqFirst(priority), ...prereqFirst(deferred), ...prereqFirst(reconciled)];
    };

    const finalizeUnmet = (reason: string, pool: FieldState[]): number => {
      let terminalizedCount = 0;
      for (const f of pool) {
        if (f.terminal !== null) continue;
        // A value field with a standing OR RETAINED accept whose
        // prerequisite closure is satisfied belongs to the FINAL
        // PROJECTION, not here — terminalizing it now (with a misnomer
        // reason) would publish a false unresolved for a valid accept.
        // (trustedAccepts included: a mid-loop unknown on another source
        // clears the standing accept, but the retained final-context
        // accept still projects.)
        const depMayRecover = f.req.dependsOn.every((dep) => {
          const d = fields.get(dep);
          if (d === undefined) return false;
          if (d.terminal?.status === "satisfied" || d.acceptedCandidate !== null) return true;
          // Reconciliation-aware: a prerequisite with a trusted accept on the
          // exact current retained source set can still be satisfied by the
          // FINAL PROJECTION after scheduling ends — a dependent holding its
          // own accept must not be terminalized here first. Uses the same
          // full proof as every other history path, and the dependent's own
          // judged dependency revision must equal the prerequisite's
          // authoritative current binding (value AND provenance), so a
          // dependent judged against a different prerequisite can never
          // defer itself here as publishable.
          if (!d.trustedAccepts.some((t) => liveIdentityOf(t))) return false;
          const held = f.trustedAccepts.find((x) => liveIdentityOf(x));
          if (held === undefined) return true;
          return Object.entries(held.judgedContext?.depBindings ?? {}).every(([k, rec]) => {
            const live = currentBindingOf(k);
            return (
              live !== null &&
              rec.value === live.value &&
              rec.evidenceId === live.evidenceId &&
              rec.sourceDigest === live.sourceDigest
            );
          });
        });
        if (
          f.req.schema.mode === "value" &&
          (f.acceptedCandidate !== null || f.trustedAccepts.length > 0) &&
          depMayRecover
        ) {
          continue;
        }
        // Priority: a pending one-sided accept that never got its
        // completed counterevidence round (limits/failed search/unread
        // queue) is counterevidence_not_acquired — limits are never an
        // acceptance criterion. Then unfixed inconsistency, then
        // unresolvable conflict, then the generic stop reason.
        // Source-uncertainty: a CLEAR contribution that acceptance blockers
        // (possibly-relevant possible opposite side) kept out reports the
        // uncertainty explicitly — not service failure, not exhaustion.
        const hasClearSide = f.assessmentHistory
          .at(-1)
          ?.some(
            (d) => d.relevant === true && (d.supportsClaim === true || d.refutesClaim === true),
          );
        // Any retained unknown flag (assessed but not known) is visible
        // uncertainty: even without a clear side, honest reporting says
        // uncertain rather than generically exhausted.
        const hasUnknownFlag = f.assessmentHistory
          .at(-1)
          ?.some((d) => d.relevant === null || d.supportsClaim === null || d.refutesClaim === null);
        const finalReason =
          f.stopReason !== null
            ? f.stopReason
            : contextOverflowFields.has(f.id)
              ? "assessment_context_overflow"
              : runTypedStop !== null
                ? runTypedStop
                : f.req.schema.mode === "value"
                  ? f.noExtractor
                    ? "no_extractor"
                    : f.noSemanticJudge || f.judgeUnavailable
                      ? f.noSemanticJudge
                        ? "no_semantic_judge"
                        : "judge_unavailable"
                      : f.acceptedCandidate !== null
                        ? "counterevidence_not_acquired"
                        : (hasClearSide || hasUnknownFlag) && reason === "exhausted"
                          ? "uncertain_evidence"
                          : reason
                  : f.pendingAccept !== null
                    ? "counterevidence_not_acquired"
                    : f.judgeUnavailable
                      ? "judge_unavailable"
                      : f.judgeIndeterminate
                        ? "judge_indeterminate"
                        : f.inconsistentJudgments > 0
                          ? "inconsistent_judgments"
                          : f.conflictUnresolvable
                            ? "conflicting_evidence"
                            : (hasClearSide || hasUnknownFlag) && reason === "exhausted"
                              ? "uncertain_evidence"
                              : reason;
        f.terminal = { status: "unresolved", reason: finalReason };
        terminalizedCount += 1;
      }
      return terminalizedCount;
    };

    // --- deterministic-only mode (repair pass): no semantic judge, but
    // the engine still runs the SAME bounded deterministic acquisition
    // path — shared query first, bounded reads, retained evidence and
    // coverage — because evidence gathering is provider work, not
    // semantic work. Semantic-classification fields stay unresolved with
    // an explicit basis; nothing is relabeled as accepted. ---------------
    if (deps.judge === null) {
      // ponytail: deterministic-only runs the acquisition loop inline
      // (search/read only, no judgment phase) rather than a separate
      // code path — the read/budget/oversize machinery must not fork.
      let dQueryIdx = queryIdx; // seeded reusable-coverage prefix (caller rounds)
      for (;;) {
        if (expired()) break;
        dQueryIdx = nextUnissuedQuery(dQueryIdx);
        const eligibleLeft = [...fields.values()].some((f) => f.terminal === null);
        if (!eligibleLeft) break;
        if (canReadMore() && !expired()) {
          const batch: { url: string; title: string }[] = [];
          while (
            batch.length < limits.readBatchSize &&
            attemptedUrls.size + batch.length < limits.maxUniqueReads &&
            hasUnread()
          ) {
            batch.push(queue[readPtr]!);
            readPtr += 1;
          }
          for (const [batchIndex, item] of batch.entries()) {
            let content: string | null = null;
            for (let attempt = 0; attempt < 2 && content === null; attempt += 1) {
              if (expired()) break;
              attemptedUrls.add(item.url);
              readAttempts += 1;
              pushLog(attempt === 0 ? "read" : "read-retry", item.url);
              try {
                content = await deps.read(item.url, dispatchOptions());
              } catch (error) {
                const root = composedStopRootOf(error);
                if (root !== null) {
                  runTypedStop = root;
                  break;
                }
                content = null;
              }
            }
            if (runTypedStop !== null) {
              readPtr -= batch.length - batchIndex - 1;
              pushLog("read-failed", item.url);
              break;
            }
            // Batch preparation is not admission: an uninvoked item is
            // still unread, and must not acquire a failed-read audit.
            if (!attemptedUrls.has(item.url)) {
              readPtr -= batch.length - batchIndex;
              break;
            }
            if (content === null) {
              pushLog("read-failed", item.url);
              continue;
            }
            const byteLength = Buffer.byteLength(content, "utf8");
            if (byteLength > limits.maxEvidenceBytesPerDoc) {
              pushLog("evidence-oversize-rejected", item.url);
              coverageNotes.push(
                `incomplete coverage: ${item.url} rejected unread at ${byteLength} bytes over the ${limits.maxEvidenceBytesPerDoc}-byte per-document ceiling`,
              );
              continue;
            }
            if (retainedBytes + byteLength > limits.maxTotalEvidenceBytes) {
              pushLog("evidence-bytes-cap", item.url);
              coverageNotes.push(`evidence bytes ceiling reached: ${item.url} not retained`);
              continue;
            }
            retainedBytes += byteLength;
            const retained: LeanEvidenceRecord = {
              evidenceId: `e${evidence.length + 1}`,
              url: item.url,
              title: item.title,
              content,
              byteLength,
              origins: [...(originsByUrl.get(item.url) ?? new Set<string>())],
            };
            await seed?.retainEvidence?.(retained);
            evidence.push(retained);
            readsRetained += 1;
            for (const f of fields.values()) f.ctrvSources.delete(item.url);
          }
        } else if (dQueryIdx < plan.length && searches < limits.maxSearchAttempts && !expired()) {
          const entry = plan[dQueryIdx]!;
          dQueryIdx += 1;
          searches += 1;
          try {
            const results = await deps.search(entry.query, dispatchOptions());
            recordSearchSuccess(entry.query, results);
            pushLog("search", entry.query);
            for (const result of results) {
              if (typeof result.url !== "string" || result.url.length === 0) continue;
              let origins = originsByUrl.get(result.url);
              if (origins === undefined) {
                origins = new Set<string>();
                originsByUrl.set(result.url, origins);
                if (!queuedUrls.has(result.url)) {
                  queue.push({ url: result.url, title: result.title ?? result.url });
                  queuedUrls.add(result.url);
                }
              }
              origins.add(entry.query);
            }
          } catch (error) {
            const root = composedStopRootOf(error);
            if (root !== null) runTypedStop = root;
            pushLog("search-failed", entry.query);
          }
        } else {
          break;
        }
      }
      for (const f of fields.values()) {
        // CR4-2: the assembled-context bound runs in the deterministic-only
        // path too — a caller must be able to distinguish "would not have fit
        // anyway" from "fit but no judge". Overflow keeps the availability
        // fact visible (stop reason stays no-judge) while the field reason
        // and audit record the overflow.
        const overflow = assembledContextOverflow(f.id, {
          fieldMeanings: {
            [f.id]: [f.req.question, ...f.req.criteria, ...compiled.evidenceCriteria].join("\n"),
          },
          scope: compiled.scope,
          documents: evidence,
          depBindings: depBindingsFor(f),
        });
        f.terminal = {
          status: "unresolved",
          reason: runTypedStop ?? (overflow ? "assessment_context_overflow" : "no_semantic_judge"),
        };
        if (overflow) {
          f.attemptedRecords.push({
            trusted: false,
            reason: "assessment_context_overflow",
            assessments: [],
            metadata: { kind: "context-bound", judgePresent: false },
          });
        }
      }
      // Deterministic-only early exit: the run-owned timer/abort and the
      // external-signal listener are disposed by the single ownership
      // scope's `finally` on the way out.
      return assemble("deterministic-only");
    }

    const judge = deps.judge;

    // --- main loop --------------------------------------------------------
    let stalledOn: string | null = null;
    for (;;) {
      // Stop independently of acquisition exhaustion or proof finalization:
      // those may leave a standing accept open without making progress.
      if (expired()) {
        const reason = runTypedStop ?? (cancelled() ? "cancelled" : "deadline");
        finalizeUnmet(
          reason,
          [...fields.values()].filter((f) => eligibleIds().has(f.id)),
        );
        finalizeWaitingDependants(reason);
        break;
      }
      queryIdx = nextUnissuedQuery(queryIdx);

      // Dependency terminalization: a terminally-unresolved prerequisite
      // blocks only its dependants.
      for (const f of fields.values()) {
        if (f.terminal !== null) continue;
        const deadDep = f.req.dependsOn.find(
          (dep) => fields.get(dep)?.terminal?.status === "unresolved",
        );
        if (deadDep !== undefined) {
          f.terminal = { status: "unresolved", reason: `prerequisite_unresolved:${deadDep}` };
        }
      }

      // Prerequisite-first ordering: a field is considered only after every
      // open prerequisite has had its turn, so declaration order cannot
      // starve a descendant whose prerequisite becomes eligible later in
      // the same run. Stable within each tier, so the dispatch order the
      // originally-eligible fields established is otherwise preserved.
      const eligibleFieldsPrereqFirst = (): FieldState[] => eligibleFields();
      const eligible = eligibleFieldsPrereqFirst();
      // Fair mandatory allocation (intra-pass): newly-eligible fields must
      // not lose their priority turn to deferred optionals processed
      // later in the SAME pass. The judgment phase re-sorts per field:
      // when an acceptance makes a blocked dependant eligible, that
      // dependant outranks still-unprocessed deferred optionals.
      const eligibleNow = (): FieldState[] => eligibleFieldsPrereqFirst();
      if (eligible.length === 0 && [...fields.values()].every((f) => f.terminal !== null)) break;
      if (eligible.length === 0) {
        // Only BLOCKED dependants remain. A dependant can still be waiting
        // on a prerequisite that this same pass has just made eligible but
        // not yet run — that is exactly the reverse-declaration-order case
        // (leaf declared before its prerequisite). Breaking here would
        // strand it. Re-enter the existing bounded assessment instead: the
        // prerequisite-first ordering below brings the newly unblocked
        // work forward, and the bounded budget/selector guards still apply.
        // If nothing became newly eligible this is a genuine stall, and
        // the pre-assembly reconciliation terminalizes the waiters with an
        // explicit prerequisite-owned reason.
        // Re-enter ONLY when a FINITE state transition is actually
        // available. Nonterminal ancestry is not progress: a waiter whose
        // prerequisites are themselves blocked with no runnable field
        // cannot become eligible in this or any later pass, so continuing
        // would spin this synchronous loop forever under a frozen clock
        // (the expiry timer cannot fire while it never yields). Progress
        // exists only when a waiter inside the required transitive closure
        // has a nonterminal prerequisite that is itself blocked SOLELY by
        // an unaccepted-but-otherwise-runnable field — i.e. a prerequisite
        // that the next assessment pass can still act on.
        //
        // Otherwise this is a genuine no-eligible stall: break, and let the
        // pre-assembly reconciliation perform bounded proof/closure
        // withdrawal and terminalize the waiters with recorded
        // prerequisite-owned reasons. No cap, clock manipulation, invented
        // response or second pipeline is involved.
        const closure = new Set<string>();
        const collect = (id: string): void => {
          if (closure.has(id)) return;
          closure.add(id);
          const f = fields.get(id);
          if (f === undefined) return;
          for (const dep of f.req.dependsOn) collect(dep);
        };
        for (const f of fields.values()) {
          if (f.terminal === null && f.req.required) collect(f.id);
        }
        // A prerequisite is ACTIONABLE when it is itself nonterminal and
        // has NO nonterminal prerequisite of its own — the head of a
        // remaining chain. If every remaining nonterminal field in the
        // closure has a nonterminal prerequisite, the graph has a cycle of
        // mutual waiting (acyclic input rules out a true cycle, so this
        // means every head is itself blocked by a non-closure field), and
        // no pass can make progress.
        // A re-entry is real progress only if the NEXT pass can change
        // some field's judged/dispatch state. This pass already ran the
        // dependency terminalization and every eligible assessment, so the
        // only way forward is a waiter whose own assessment would now be
        // selected: that requires the shared budget to still have room and
        // the waiter not to be blocked by an unsatisfied prerequisite. With
        // no budget left, or with every waiter blocked, no pass can
        // dispatch — continuing would spin this synchronous loop forever
        // under a frozen clock.
        const budgetLeft = judgeCalls + candidateJudgeCalls < limits.maxJudgeAttempts;
        const actionable = [...fields.values()].some((f) => {
          if (f.terminal !== null || !closure.has(f.id)) return false;
          if (f.judgeUnavailable) return false;
          if (f.req.dependsOn.some((dep) => fields.get(dep)?.terminal?.status !== "satisfied"))
            return false;
          // Same due-ness identity the selector uses, computed locally:
          // `key` is not yet in scope on this path.
          const currentKey = evidenceKey();
          return (
            f.lastJudgedKey !== currentKey ||
            (f.req.schema.mode === "value" && f.depBindingKey !== depBindingKeyOf(f))
          );
        });
        // Re-enter at most once per distinct wait-set: a second identical
        // no-progress pass is a genuine stall. This keeps reverse-order
        // recovery (prerequisite satisfied later in the same pass) while
        // making the loop provably finite.
        const waitKey = [...fields.values()]
          .filter((f) => f.terminal === null)
          .map((f) => `${f.id}:${f.lastJudgedKey}:${f.depBindingKey}`)
          .sort()
          .join(",");
        if (!budgetLeft || !actionable || stalledOn === waitKey) break;
        stalledOn = waitKey;
        continue;
      }

      // Acquisition: read the next bounded batch of unread deduplicated
      // results; else issue the next frozen query. Never reset readPtr —
      // earlier results are never reread.
      if (canReadMore() && !expired()) {
        const batch: { url: string; title: string }[] = [];
        while (
          batch.length < limits.readBatchSize &&
          attemptedUrls.size + batch.length < limits.maxUniqueReads &&
          hasUnread()
        ) {
          batch.push(queue[readPtr]!);
          readPtr += 1;
        }
        for (const [batchIndex, item] of batch.entries()) {
          let content: string | null = null;
          for (let attempt = 0; attempt < 2 && content === null; attempt += 1) {
            if (expired()) break;
            attemptedUrls.add(item.url);
            readAttempts += 1;
            pushLog(attempt === 0 ? "read" : "read-retry", item.url);
            try {
              content = await deps.read(item.url, dispatchOptions());
            } catch (error) {
              const root = composedStopRootOf(error);
              if (root !== null) {
                runTypedStop = root;
                break;
              }
              content = null;
            }
          }
          if (runTypedStop !== null) {
            readPtr -= batch.length - batchIndex - 1;
            pushLog("read-failed", item.url);
            break;
          }
          // Batch preparation is not admission: an uninvoked item is
          // still unread, and must not acquire a failed-read audit.
          if (!attemptedUrls.has(item.url)) {
            readPtr -= batch.length - batchIndex;
            break;
          }
          if (content === null) {
            pushLog("read-failed", item.url);
            continue;
          }
          // Repair pass: oversize content is REJECTED, never truncated —
          // slicing at a byte ceiling can silently drop counterevidence
          // past the cut (parent finding 2). Byte accounting is exact
          // UTF-8 (Buffer.byteLength), never a character count.
          const byteLength = Buffer.byteLength(content, "utf8");
          if (byteLength > limits.maxEvidenceBytesPerDoc) {
            pushLog("evidence-oversize-rejected", item.url);
            coverageNotes.push(
              `incomplete coverage: ${item.url} rejected unread at ${byteLength} bytes over the ${limits.maxEvidenceBytesPerDoc}-byte per-document ceiling`,
            );
            continue;
          }
          if (retainedBytes + byteLength > limits.maxTotalEvidenceBytes) {
            pushLog("evidence-bytes-cap", item.url);
            coverageNotes.push(`evidence bytes ceiling reached: ${item.url} not retained`);
            continue;
          }
          retainedBytes += byteLength;
          const retained: LeanEvidenceRecord = {
            evidenceId: `e${evidence.length + 1}`,
            url: item.url,
            title: item.title,
            content,
            byteLength,
            origins: [...(originsByUrl.get(item.url) ?? new Set<string>())],
          };
          await seed?.retainEvidence?.(retained);
          evidence.push(retained);
          readsRetained += 1;
          // Round-2 repair: a retained document settles its URL as contrary
          // coverage for every field whose contrary query surfaced it.
          for (const f of fields.values()) f.ctrvSources.delete(item.url);
          // Unified proof (final-context revocation): ANY newly retained
          // potentially-relevant source changes the assessment context —
          // terminal (already-satisfied) fields reopen for reassessment
          // BEFORE final projection; adversity is never pre-judged (a
          // missing judgment must not hide a contradiction). Fields whose
          // acceptance is re-earned on the final context re-finalize in
          // the judgment/finalization phases; dependants reopen
          // transitively because their prerequisite binding identity
          // (value + provenance digest) may change.
          for (const f of fields.values()) {
            if (f.terminal?.status !== "satisfied") continue;
            f.terminal = null;
            f.lastJudgedKey = null;
            f.depBindingKey = null;
          }
          // A dependant terminalized earlier on a prerequisite gap must
          // re-queue when that prerequisite reopens: the gap was decided
          // on a context that no longer holds. Only gap reasons reopen
          // (a genuinely failed/absent prerequisite keeps its own
          // terminal reason and is not resurrected).
          for (const f of fields.values()) {
            if (f.terminal?.status !== "unresolved") continue;
            const reason = f.terminal.reason;
            if (!reason.startsWith("prerequisite_unresolved:")) continue;
            const dep = reason.slice("prerequisite_unresolved:".length);
            if (fields.get(dep)?.terminal === null) {
              f.terminal = null;
              f.lastJudgedKey = null;
              f.depBindingKey = null;
            }
          }
        }
      } else if (queryIdx < plan.length && searches < limits.maxSearchAttempts && !expired()) {
        const entry = plan[queryIdx]!;
        queryIdx += 1;
        searches += 1;
        let results: readonly LeanSearchResult[] = [];
        try {
          results = await deps.search(entry.query, dispatchOptions());
        } catch (error) {
          const root = composedStopRootOf(error);
          if (root !== null) runTypedStop = root;
          pushLog("search-failed", entry.query);
          // A FAILED counterevidence search is not coverage — the round
          // stays unissued (parent finding: failed query ≠ completed
          // contrary evidence).
          continue;
        }
        recordSearchSuccess(entry.query, results);
        pushLog("search", entry.query);
        for (const result of results) {
          if (typeof result.url !== "string" || result.url.length === 0) continue;
          let origins = originsByUrl.get(result.url);
          if (origins === undefined) {
            origins = new Set<string>();
            originsByUrl.set(result.url, origins);
            if (!queuedUrls.has(result.url)) {
              queue.push({ url: result.url, title: result.title ?? result.url });
              queuedUrls.add(result.url);
            }
          }
          origins.add(entry.query);
        }
      } else {
        // Sol-review fix 3: before declaring acquisition exhausted, a
        // newly-eligible dependant whose prerequisite was satisfied by
        // the last acquisition must still be JUDGED over the retained
        // context — a dependency gates acceptance, not the right to
        // assess shared retained evidence. Loop back when any eligible
        // field has unjudged current-context evidence and judge budget.
        // Round-5 (Sol chain finding): per-field progress, no global
        // once-per-evidence-key lock — prerequisite acceptance is real
        // progress without changing evidence identity, so ANY number of
        // newly eligible fields may each earn a fall-through to the
        // judgment phase. Termination is bounded by the judgment phase's
        // own guards: a field is judged only when lastJudgedKey !==
        // current key, and every attempt either consumes judge budget or
        // sets lastJudgedKey/judgeUnavailable/terminal — so a second
        // arrival here with no field left to judge takes the finalize
        // path. The frozen clock makes a synchronous nonprogress loop
        // visible as a deadline miss, and none of the guards below can
        // advance without one of those counters moving.
        const key0 = evidenceKey();
        // Shared semantic budget: enum and candidate judgments reserve
        // from ONE ceiling. This predicate MUST match the judgment
        // phase's reservation exactly — when it disagreed (enum-only
        // check vs shared check) a field whose budget was spent by the
        // other mode stayed unjudged forever and this loop spun
        // synchronously (no await, so not even a frozen clock could end
        // it). One predicate, one predicate site.
        const needsContextJudgment = eligible.some(
          (f) =>
            f.lastJudgedKey !== key0 &&
            !f.judgeUnavailable &&
            evidence.length > 0 &&
            judgeCalls + candidateJudgeCalls < limits.maxJudgeAttempts,
        );
        if (!needsContextJudgment) {
          // Deadline beats generic limits wording when the run clock is
          // what actually stopped dispatch (per-dispatch expiry checks
          // mean acquisition branches no longer see the deadline first).
          const reason = expired()
            ? "deadline"
            : noMoreAcquisition()
              ? "exhausted"
              : "limits_reached";
          const terminalized = finalizeUnmet(reason, eligible);
          // No-progress break: when nothing in the pool was terminalized
          // (finalizeUnmet deliberately skipped standing accepts that
          // belong to the final projection) AND no acquisition or judgment
          // can proceed, looping would livelock — exit to the final
          // projection which resolves those fields.
          if (terminalized === 0 && noMoreAcquisition()) break;
          continue;
        }
        // Fall through to the judgment phase below (it lives after the
        // acquisition if/else); `continue` would skip it and spin.
      }

      // A raw acquisition root returns through the existing terminal stop
      // path before any judgment or provisional finalization can run.
      if (runTypedStop !== null) continue;

      // Judgment phase: every eligible unmet field whose presented
      // evidence identity changed since its last judgment. Identical
      // judge input is structurally impossible. Repair pass: (a) no
      // empty-context calls — a field with zero retained evidence is not
      // rejudged (adjacent waste fixed); (b) verdict responses are
      // validated at runtime against the exact presented set — unknown,
      // duplicate, non-string evidenceIds, non-boolean flags, or missing
      // per-document coverage make the response invalid: the field gains
      // nothing (no acceptance), the attempt is charged and logged.
      const key = evidenceKey();
      // Deterministic finite-progress guard: this selector loop must make
      // state or budget progress on every iteration. A field that is
      // re-selected without any change to its judged/dispatch identity
      // cannot produce new information, and looping on it would spin
      // forever under a frozen clock (the expiry timer never fires because
      // the loop never yields). The identity is the same due-ness
      // predicate the selector uses, so this only removes genuinely
      // non-progressing selections — real work is never skipped.
      let noProgressDispatches = new Set<string>();
      for (let __i = 0; ; __i += 1) {
        // Turn boundary: owned/observed stops need no additional clock or
        // harness-attribution polling; actual dispatches check elapsed time.
        if (runTypedStop !== null || runAbort.signal.aborted) break;
        if (noProgressDispatches.size >= fields.size) break;
        // Per-field re-eligibility: an acceptance earlier in this pass may
        // have unblocked a dependant that outranks remaining deferred
        // optionals — take the highest-priority STILL-eligible unjudged
        // field each step instead of the pass-start snapshot order. The
        // selector MUST skip fields that cannot proceed this pass (shared
        // budget exhausted) — selecting them would spin forever: both
        // branch guards skip on budget without advancing any state.
        const budgetLeft = judgeCalls + candidateJudgeCalls < limits.maxJudgeAttempts;
        const liveEligible = eligibleNow();
        const liveIdx = budgetLeft
          ? liveEligible.findIndex(
              (x) =>
                x.terminal === null &&
                !x.judgeUnavailable &&
                // A value field is due when its evidence key OR its
                // dependency-binding identity moved (a prerequisite's
                // final accept can change the binding after the evidence
                // stopped changing).
                (x.lastJudgedKey !== key ||
                  (x.req.schema.mode === "value" && x.depBindingKey !== depBindingKeyOf(x))),
            )
          : liveEligible.findIndex(
              // Budget gone: only fields needing NO semantic dispatch
              // (e.g. value field with no extractor configured) may still
              // be selected; everything else ends via finalize below.
              (x) =>
                x.lastJudgedKey !== key &&
                !x.judgeUnavailable &&
                x.terminal === null &&
                x.req.schema.mode === "value" &&
                udeps.extract == null,
            );
        if (liveIdx === -1) break;
        const f = liveEligible[liveIdx]!;
        // Already dispatched on this exact due-ness identity: selecting it
        // again is a no-op, so stop rather than spin.
        {
          const identity = `${f.id}|${key}|${depBindingKeyOf(f)}|${f.lastJudgedKey}|${f.depBindingKey}|${lastValueTurn.get(f.id) ?? 0}`;
          if (noProgressDispatches.has(identity)) {
            noProgressDispatches = new Set<string>();
            break;
          }
          noProgressDispatches.add(identity);
        }
        void __i;
        // No lastJudgedKey check here: the value branch's own guard ALSO
        // considers depBindingKey movement (evidence key alone is not the
        // whole due-ness identity for dependent fields).
        if (f.terminal !== null || f.judgeUnavailable) continue;
        // Value-mode assessment (unified proof): extract → validate →
        // judge → acceptCandidate, sharing evidence/queue/budget with the
        // enum path. lastJudgedKey gates re-extraction the same way it
        // gates re-judgment; depBindings identity changes also re-fire.
        if (f.req.schema.mode === "value") {
          const bindingKey = depBindingKeyOf(f);
          // Pair completeness: lastJudgedKey alone says the field ran under
          // this evidence key — not that EVERY (source, current-opposing-set)
          // pair was judged. A field that judged one pair and then became
          // dependency-blocked (cleared prerequisite) still owes its other
          // current-context pairs once unblocked; re-enter while any current
          // pair is unjudged and budget remains.
          const bindings0 = depBindingsFor(f);
          const pairsComplete = evidence.every((src) => {
            const opp = evidence
              .filter((e) => e.evidenceId !== src.evidenceId)
              .map((e) => e.evidenceId)
              .join(",");
            const ck = `${extractionKey(src, f, bindings0)}|${opp}`;
            return (
              f.judgedSourceKeys.has(ck) ||
              (f.req.schema.pattern === undefined &&
                f.trustedAccepts.some((t) => liveIdentityOf(t)))
            );
          });
          if (f.lastJudgedKey === key && f.depBindingKey === bindingKey && pairsComplete) continue;
          if (evidence.length === 0) {
            f.lastJudgedKey = key;
            f.depBindingKey = bindingKey;
            continue;
          }
          f.lastJudgedKey = key;
          f.depBindingKey = bindingKey;
          // Per-dispatch snapshot: the bindings object travels BY
          // REFERENCE to the extractor and the judge, and a collaborator
          // may mutate it in place. Handing each dispatch its own copy
          // keeps the engine's own state exactly as presented, so what is
          // judged, recorded and revalidated is the same revision.
          const bindings: Record<string, DepBinding> = structuredClone(depBindingsFor(f));
          const descriptors = {
            pattern: f.req.schema.pattern,
            minLength: f.req.schema.minLength,
            maxLength: f.req.schema.maxLength,
          } as import("./lean-candidates.js").CandidateFieldSchema;
          // Revocation precondition (Q2/context-change): a previously
          // accepted candidate is dropped ONLY if the field's judged
          // per-source context identity actually changed this round (a new
          // source, or a dependency binding revision). When every
          // (source, opposing-set) pair is unchanged, the prior accept was
          // rendered on exactly the current context and STANDS — clearing
          // it unconditionally orphaned fields whose re-extraction hit the
          // judged-pair cache and never re-earned an identical accept.
          const contextChanged =
            f.depBindingKey !== bindingKey ||
            evidence.some(
              (source) =>
                !f.judgedSourceKeys.has(
                  `${extractionKey(source, f, bindings)}|${evidence
                    .filter((e) => e.evidenceId !== source.evidenceId)
                    .map((e) => e.evidenceId)
                    .join(",")}`,
                ),
            );
          // Complete assembled-context bound (root 3) fires BEFORE the
          // producer-availability gate: the full judged context (every
          // document, framing, prerequisites) is known here regardless of
          // whether an extractor is configured.
          if (
            assembledContextOverflow(f.id, {
              fieldMeanings: {
                [f.id]: [f.req.question, ...f.req.criteria, ...compiled.evidenceCriteria].join(
                  "\n",
                ),
              },
              scope: compiled.scope,
              documents: evidence,
              depBindings: bindings,
            })
          ) {
            f.attemptedRecords.push({
              trusted: false,
              reason: "assessment_context_overflow",
              assessments: [],
              metadata: { kind: "context-bound", evidenceIds: evidence.map((e) => e.evidenceId) },
            });
            continue;
          }
          if (udeps.extract == null) {
            f.noExtractor = true;
            continue;
          }
          if (udeps.candidateJudge == null || deps.judge === null) {
            // Extraction may still retain untrusted candidates, but the
            // semantic assessor is absent — no acceptance (§7).
            f.noSemanticJudge = true;
          }
          // Unified proof: common evidence criteria apply to string
          // obligations exactly as they do to enum ones (compiled.
          // evidenceCriteria was previously dropped here). Meaning AND
          // identity carry them.
          const fullCriteria = [...f.req.criteria, ...compiled.evidenceCriteria];
          const fieldMeanings: Record<string, string> = {
            [f.id]: [f.req.question, ...fullCriteria].join("\n"),
          };
          // A turn visits one source pair. Its pending basis includes every
          // source digest and dependency binding, so revisions reopen work.
          const turnBasis = JSON.stringify(
            evidence.map((source) => extractionKey(source, f, bindings)),
          );
          let turn = pendingValueTurns.get(f.id);
          if (turn === undefined || turn.basis !== turnBasis) {
            turn = { basis: turnBasis, visited: new Set() };
            pendingValueTurns.set(f.id, turn);
          }
          const nextSource = evidence.find((source) => !turn.visited.has(source.evidenceId));
          for (const source of nextSource === undefined ? [] : [nextSource]) {
            if (expired()) break;
            turn.visited.add(source.evidenceId);
            lastValueTurn.set(f.id, ++valueTurn);
            const ck = extractionKey(source, f, bindings);
            // Per-source assessment identity: a candidate is judged over
            // ITS source plus the opposing set. Re-running that exact pair
            // after an unrelated new source arrived is not new information
            // — only judge when this source's own context actually
            // changed. Without this, a field re-judged every candidate on
            // every context change consumed the whole shared budget and
            // starved other fields' mandatory challenge work.
            const opposing = evidence.filter((e) => e.evidenceId !== source.evidenceId);
            // Opposing context IS part of what this judgment saw, so a
            // newly retained source legitimately re-opens the pair. The
            // budget guard below still bounds the run; this key only
            // suppresses the pathological case of re-judging an
            // IDENTICAL pair (same source, same opposing set) in a later
            // iteration.
            const sourceJudgeKey = `${ck}|${opposing.map((e) => e.evidenceId).join(",")}`;
            if (f.judgedSourceKeys.has(sourceJudgeKey)) continue;
            let validation = extractionCache.get(ck);
            if (validation === undefined) {
              if (expired()) break;
              extractorCalls += 1;
              pushLog("judge", `${f.id} extract ${source.evidenceId}`);
              try {
                const extractInput = {
                  sourceId: source.evidenceId,
                  sourceText: source.content,
                  fields: [
                    {
                      id: f.id,
                      description: [f.req.question, ...fullCriteria].join("\n"),
                      depBindings: bindings,
                    },
                  ],
                  scope: compiled.scope,
                  depBindings: bindings,
                } as ExtractorRequest;
                const attempt = await udeps.extract!(extractInput, dispatchOptions());
                validation = validateCandidates(
                  source,
                  { finishReason: attempt.finishReason, rawOutput: attempt.rawOutput },
                  { [f.id]: descriptors },
                );
                // Append-only extraction audit: sanitized attempt
                // (identity, usage/latency, outcome statuses) — retained
                // even when the candidate is rejected; unknown usage/cost
                // stays null, never invented as zero.
                f.attemptedRecords.push({
                  trusted: true,
                  assessments: validation.fields.map((x) => ({ ...x })),
                  metadata: {
                    kind: "extraction",
                    sourceId: source.evidenceId,
                    sourceDigest: validation.sourceDigest,
                    depBindings: bindings,
                    finishReason: attempt.finishReason,
                    usage: attempt.usage,
                    observedCost: attempt.observedCost,
                    elapsedMs: attempt.elapsedMs,
                    requestSha256: attempt.requestSha256,
                  },
                });
              } catch (extractError) {
                // A FATAL measurement error (a declared-but-malformed
                // producer attempt count) is a RUN-level fault, not a
                // field outcome: rethrow so the caller sees the
                // measurement defect instead of an unresolved field that
                // hides it. Ordinary extraction failures keep the
                // measured-attempt accounting below.
                if (
                  (extractError as { fatalMeasurement?: unknown } | null)?.fatalMeasurement === true
                ) {
                  throw extractError;
                }
                // Failed extraction is a MEASURED physical attempt: append
                // the sanitized observation (typed observed payload when
                // the dependency provides one) before terminalizing — a
                // failed physical call cannot disappear from the audit.
                const observed = sanitizeObservation(
                  (extractError as { observed?: unknown } | null)?.observed,
                );
                // Typed harness stop reasons (e.g. EVAL_STOPPED with an
                // explicit reason like global_extraction_cap) surface AS
                // the field's terminal reason — never collapsed into
                // judge_unavailable or a network/deadline label.
                // Same FINITE trust boundary as the transport: only the
                // approved stop type (EVAL_STOPPED) with an exactly-known
                // root promotes; arbitrary reason strings are discarded.
                // Finite trust boundary: the transport already validated
                // the marker (TransportError.stopReason is only ever an
                // approved root); the adapter rethrow carries it as
                // error.reason with the transport's error code. Membership
                // in the exact vocabulary is the validation here — an
                // arbitrary string never promotes.
                f.stopReason = composedRootOf(extractError);
                if (f.stopReason !== null) runTypedStop = f.stopReason;
                f.attemptedRecords.push({
                  trusted: false,
                  reason: `extract_failed:${safeErrorCode((extractError as { code?: unknown } | null)?.code)}`,
                  assessments: [],
                  metadata: {
                    kind: "extraction",
                    sourceId: source.evidenceId,
                    depBindings: bindings,
                    // Raw error text is deliberately NOT persisted — typed
                    // code only (safe measured fields via `observed`).
                    ...(observed !== undefined ? { observed } : {}),
                  },
                });
                f.judgeUnavailable = true;
                f.acceptedCandidate = null;
                break;
              }
              extractionCache.set(ck, validation);
            } else {
              extractorCacheHits += 1;
            }
            const outcome = validation.fields.find((x) => x.fieldId === f.id);
            if (outcome !== undefined && !f.candidateOutcomes.some((x) => x === outcome)) {
              f.candidateOutcomes.push(outcome);
            }
            if (outcome?.status !== "candidate") continue;
            if (udeps.candidateJudge == null || deps.judge === null) continue;
            // Complete assembled-context bound (caller-rounds root 3): the
            // whole serialized candidate-judge request must fit the 256KiB
            // assessment ceiling. Overflow = explicit incomplete assessment
            // with ZERO semantic dispatch — no truncation, no shipping it.
            if (
              assembledContextOverflow(f.id, {
                source,
                fieldMeanings,
                scope: compiled.scope,
                opposingContext: opposing,
                depBindings: bindings,
                candidates: [outcome],
              })
            ) {
              f.attemptedRecords.push({
                trusted: false,
                reason: "assessment_context_overflow",
                assessments: [],
                metadata: { kind: "candidate-judgment", sourceId: source.evidenceId },
              });
              continue;
            }
            // Shared ceiling: same reservation as the enum path above.
            if (judgeCalls + candidateJudgeCalls >= limits.maxJudgeAttempts) continue;
            // Whole-run deadline: reserve before dispatch (an extraction
            // earlier in this iteration may have consumed the remainder).
            if (expired()) break;
            candidateJudgeCalls += 1;
            f.judgmentCount += 1;
            // Only an ACTUAL dispatch of this source's context records the
            // key — a budget-blocked attempt must stay retryable, or the
            // field would silently end without ever being assessed.
            // Context-change revocation happens AT DISPATCH: the prior
            // accept is cleared exactly when a NEW (source,opposing,pair)
            // judgment is about to be rendered, so a cleared accept always
            // has a re-earn opportunity in the same pass; an unchanged
            // context never clears.
            if (contextChanged) f.acceptedCandidate = null;
            f.judgedSourceKeys.add(sourceJudgeKey);
            try {
              // Snapshot BEFORE dispatch: what the engine presents is
              // what is judged and recorded. A collaborator mutating the
              // objects it was handed afterwards cannot redefine either.
              const judgedContext: import("./lean-candidates.js").CandidateJudgedContext = {
                fieldMeanings: structuredClone(fieldMeanings),
                scope: structuredClone(compiled.scope),
                opposingContext: structuredClone(opposing),
                depBindings: structuredClone(bindings),
              };
              const judged = await assessCandidates(
                {
                  source,
                  fieldMeanings,
                  scope: compiled.scope,
                  candidates: [
                    {
                      fieldId: f.id,
                      value: outcome.value!,
                      quote: outcome.quote!,
                      charRange: outcome.charRange!,
                    },
                  ],
                  opposingContext: opposing,
                  depBindings: structuredClone(bindings),
                } as Parameters<typeof assessCandidates>[0],
                {
                  judge: (input) =>
                    udeps.candidateJudge!(input as LeanCandidateJudgeInput, dispatchOptions()),
                },
              );
              // Append-only judgment audit — errors included: a rejected
              // protocol attempt records its sanitized observation with
              // trusted:false rather than vanishing.
              if (judged.error !== undefined) {
                pushLog("judge-invalid", `${f.id} candidate judge ${judged.error}`);
                // Minimal returned-error promotion: a stop root that
                // survived the normalizer's exact-vocabulary gate stops
                // the composed run — same finite boundary as every other
                // promotion site; the audit row below is unchanged.
                const normalizedRoot = judged.stopRoot;
                if (
                  typeof normalizedRoot === "string" &&
                  COMPOSED_STOP_ROOTS.has(normalizedRoot)
                ) {
                  f.stopReason = normalizedRoot;
                  runTypedStop = normalizedRoot;
                }
                f.attemptedRecords.push({
                  trusted: false,
                  reason: judged.error,
                  assessments: [],
                  metadata: {
                    kind: "candidate-judgment",
                    sourceId: source.evidenceId,
                    depBindings: bindings,
                    error: judged.error,
                    // Typed measured observation attached by the normalizer
                    // (assessCandidates), when present.
                    ...(judged.metadata !== undefined
                      ? { observed: sanitizeObservation(judged.metadata) ?? {} }
                      : {}),
                  },
                });
                // A validated composed-stop root is RUN-WIDE: after its
                // single refused audit record, no later retained source in
                // this batch may extract or admit again. An unrecognized
                // error keeps the ordinary continue (next source).
                if (f.stopReason !== null) break;
                continue;
              }
              const judgement = judged.judgements[0] ?? null;
              const accepted = acceptCandidate(
                outcome,
                judgement,
                source,
                validation.sourceDigest,
                judgedContext,
              );
              // Append-only judgment audit: raw decisions, context/
              // dependency identity, measured usage/latency — for the
              // accepted AND the unaccepted outcome alike.
              f.attemptedRecords.push({
                trusted: accepted.status === "accepted",
                ...(accepted.status === "accepted"
                  ? {}
                  : { reason: accepted.reason ?? "not_accepted" }),
                assessments: [
                  {
                    fieldId: f.id,
                    candidateId: judged.judgements[0]?.candidateId ?? "",
                    support: judged.judgements[0]?.support ?? null,
                    conflict: judged.judgements[0]?.conflict ?? null,
                    rawSupport: judged.judgements[0]?.rawSupport ?? -1,
                    rawConflict: judged.judgements[0]?.rawConflict ?? -1,
                    value: outcome.value,
                  },
                ],
                metadata: {
                  kind: "candidate-judgment",
                  sourceId: source.evidenceId,
                  opposingIds: opposing.map((e) => e.evidenceId),
                  // The snapshot the judgment was actually assessed
                  // under, NOT the live object: the audit must state the
                  // provenanced dependency revision, and a post-dispatch
                  // mutation of the dispatched object can never rewrite
                  // the recorded condition.
                  depBindings: judgedContext.depBindings,
                  usage: (judged.metadata as { usage?: unknown } | undefined)?.usage ?? null,
                  model: (judged.metadata as { model?: unknown } | undefined)?.model ?? null,
                  requestSha256:
                    (judged.metadata as { requestSha256?: unknown } | undefined)?.requestSha256 ??
                    null,
                  elapsedMs:
                    (judged.metadata as { elapsedMs?: unknown } | undefined)?.elapsedMs ?? null,
                  // Optional supplier identity hashes — validated lowercase-64-hex
                  // only (the normalizer already discarded invalid values);
                  // suppliers that omit them keep null, staying legacy-compatible.
                  contextSha256:
                    (judged.metadata as { contextSha256?: unknown } | undefined)?.contextSha256 ??
                    null,
                  policySha256:
                    (judged.metadata as { policySha256?: unknown } | undefined)?.policySha256 ??
                    null,
                },
              });
              if (accepted.status === "accepted" && accepted.provenance !== undefined) {
                // Keep the latest accept on the freshest source; earlier
                // per-source accepts are recorded via candidateOutcomes.
                f.acceptedCandidate = {
                  provenance: accepted.provenance,
                  judgment: accepted.judgement!,
                };
                // RETENTION (eval-04 finding): every trusted accept is
                // recorded with the opposing-set it was judged against. A
                // later unknown/non-accepted candidate on another source
                // can no longer erase a trusted accept whose judged
                // context IS the final evidence set.
                f.trustedAccepts.push({
                  provenance: accepted.provenance,
                  judgment: accepted.judgement!,
                  opposingIds: opposing.map((e) => e.evidenceId),
                  sourceDigest: createHash("sha256").update(source.content, "utf8").digest("hex"),
                  opposingDigests: opposing.map((e) =>
                    createHash("sha256").update(e.content, "utf8").digest("hex"),
                  ),
                  outcome,
                  judgedContext,
                });
              }
            } catch (judgeError) {
              // Rejected/throwing candidate judgment with a MEASURED typed
              // observation (hash/model/usage/status/latency) — the
              // observation survives into the audit; taxonomy preserved.
              // Composed-run stops promote through the SAME finite
              // vocabulary boundary as the extract and enum paths.
              f.stopReason = composedRootOf(judgeError);
              if (f.stopReason !== null) runTypedStop = f.stopReason;
              const observed = sanitizeObservation(
                (judgeError as { observed?: unknown } | null)?.observed,
              );
              f.attemptedRecords.push({
                trusted: false,
                reason: `candidate_judge_failed:${safeErrorCode((judgeError as { code?: unknown } | null)?.code)}`,
                assessments: [],
                metadata: {
                  kind: "candidate-judgment",
                  sourceId: source.evidenceId,
                  opposingIds: opposing.map((e) => e.evidenceId),
                  depBindings: bindings,
                  ...(observed !== undefined ? { observed } : {}),
                },
              });
              f.judgeUnavailable = true;
              f.acceptedCandidate = null;
              break;
            }
          }
          // Yielding is not context completion. Keep the field due until
          // all pending pairs had a turn, even after a trusted first accept.
          if (turn.visited.size < evidence.length) f.lastJudgedKey = null;
          continue;
        }
        // Unified proof: ONE shared physical-judge ceiling across enum and
        // candidate judgments (parent authorization — the cap reserves
        // budget before ANY mode's dispatch, failures included).
        if (judgeCalls + candidateJudgeCalls >= limits.maxJudgeAttempts) continue;
        if (evidence.length === 0) {
          f.lastJudgedKey = key;
          continue;
        }
        // Stop-path agreement: an expired field must ADVANCE lastJudgedKey
        // (marking it visited this context) before skipping, or the
        // selector re-selects it forever in a synchronous spin — no await,
        // so neither the outer deadline check nor any timer can run.
        if (expired()) {
          f.lastJudgedKey = key;
          continue;
        }
        // Visited even when preflight refuses this context; only actual
        // invocations consume the shared slot or emit a dispatch event.
        f.lastJudgedKey = key;
        let response: LeanJudgeResponse;
        let classificationInvoked = false;
        try {
          const enumRequest = {
            fieldId: f.id,
            fieldQuestion: f.req.question,
            criteria: [...f.req.criteria, ...compiled.evidenceCriteria],
            scope: compiled.scope,
            candidates: [...f.req.schema.enum!],
            documents: evidence.map((e) => ({
              evidenceId: e.evidenceId,
              url: e.url,
              title: e.title,
              content: e.content,
            })),
            depBindings: depBindingsFor(f),
          };
          // Complete assembled-context bound (caller-rounds root 3) — enum
          // path: zero dispatch and an explicit overflow record when the
          // assembled request exceeds the 256KiB ceiling.
          if (assembledContextOverflow(f.id, enumRequest)) {
            f.attemptedRecords.push({
              trusted: false,
              reason: "assessment_context_overflow",
              assessments: [],
              metadata: {
                kind: "classification-judgment",
                evidenceIds: evidence.map((e) => e.evidenceId),
              },
            });
            continue;
          }
          if (expired()) continue;
          judgeCalls += 1;
          f.judgmentCount += 1;
          pushLog("judge", `${f.id} over [${key}]`);
          const options = dispatchOptions();
          classificationInvoked = true;
          response = await judge(enumRequest, options);
        } catch (error) {
          // Round-2 repair: a rejected judge promise must not escape as a
          // raw crash that discards the run's evidence/usage.
          // Dev-jev authorization: a RECOGNIZED typed indeterminate
          // (code === JEV_DEV_INDETERMINATE) is uncertainty, not failure —
          // no contribution and pending cleared (no false coercion, no
          // threshold relaxation), but the judge is NOT permanently
          // unavailable: the field rejudges only when evidence identity
          // changes (lastJudgedKey was set above; identical context is
          // never reissued), and exhaustion ends with an explicit
          // judge_indeterminate reason.
          const code = (error as { code?: unknown } | null)?.code;
          if (classificationInvoked) {
            const observed = sanitizeObservation(
              (error as { observed?: unknown } | null)?.observed,
            );
            f.attemptedRecords.push({
              trusted: false,
              reason: `enum_judge_failed:${safeErrorCode(code)}`,
              assessments: [],
              metadata: {
                kind: "classification-judgment",
                ...(observed !== undefined ? { observed } : {}),
              },
            });
          }
          if (code === "JEV_DEV_INDETERMINATE") {
            pushLog("judge-invalid", `${f.id} indeterminate over [${key}]`);
            f.judgeIndeterminate = true;
            f.pendingAccept = null;
            f.pendingSinceKey = null;
            f.disputedSinceKey = null;
            continue;
          }
          pushLog("judge-invalid", `${f.id} judge unavailable over [${key}]`);
          // Classification composed-run stops take the SAME finite trust
          // boundary as the value path: only an exact vocabulary root
          // promotes; anything else keeps the honest unavailability label.
          f.stopReason = composedRootOf(error);
          if (f.stopReason !== null) {
            runTypedStop = f.stopReason;
          }
          f.judgeUnavailable = true;
          f.pendingAccept = null;
          f.pendingSinceKey = null;
          f.disputedSinceKey = null;
          continue;
        }
        // --- runtime verdict validation (repair pass finding 3) ------
        const presented = new Set(evidence.map((e) => e.evidenceId));
        const rawDocs = Array.isArray(response?.documents) ? response.documents : null;
        let valid = rawDocs !== null && rawDocs.length === presented.size;
        const seen = new Set<string>();
        const docVerdicts: LeanJudgeDocVerdict[] = [];
        if (valid) {
          for (const d of rawDocs!) {
            const id = (d as { evidenceId?: unknown })?.evidenceId;
            const relevantFlag = (d as { relevant?: unknown })?.relevant;
            const supports = (d as { supportsClaim?: unknown })?.supportsClaim;
            const refutes = (d as { refutesClaim?: unknown })?.refutesClaim;
            const isFlag = (v: unknown): boolean => v === true || v === false || v === null;
            if (
              typeof id !== "string" ||
              !presented.has(id) ||
              seen.has(id) ||
              !isFlag(relevantFlag) ||
              !isFlag(supports) ||
              !isFlag(refutes)
            ) {
              valid = false;
              break;
            }
            seen.add(id);
            docVerdicts.push({
              evidenceId: id,
              relevant: relevantFlag as boolean | null,
              supportsClaim: supports as boolean | null,
              refutesClaim: refutes as boolean | null,
            });
          }
        }
        // AUDIT (before any semantic decision): preserve this attempt's
        // protocol-valid normalized records and adapter metadata. If the
        // response was malformed, keep the attempt's transport metadata
        // with an invalid status — never fabricate flags for it.
        const attemptMeta = (response as unknown as Record<symbol, unknown> | null | undefined)?.[
          LEAN_JEV_ATTEMPT_META_SYMBOL
        ];
        if (valid) {
          f.attemptedRecords.push({
            trusted: true,
            assessments: docVerdicts.map((d) => ({ ...d })),
            metadata: attemptMeta ?? null,
          });
        } else {
          f.attemptedRecords.push({
            trusted: false,
            reason: "invalid_response",
            assessments: [],
            metadata: attemptMeta ?? null,
          });
        }
        if (!valid) {
          pushLog("judge-invalid", `${f.id} over [${key}]`);
          // Conservative: an invalid response contributes nothing. Any
          // previously pending accept was decided on a strictly smaller
          // evidence set and may be stale — clear it.
          f.pendingAccept = null;
          f.pendingSinceKey = null;
          f.disputedSinceKey = null;
          continue;
        }
        // Round-2 repair (per-source stability): record each document's
        // side and compare against its previous judgment. A flip on an
        // UNCHANGED representation is inconsistent model behavior —
        // recorded, and this judgment contributes NO pending accept
        // (acquisition continues; exhaustion leaves the field unresolved
        // with inconsistent_judgments). A dispute may only arise from
        // newly RETAINED contrary content, never from re-judging an old
        // representation into the contrary side.
        // Source-uncertainty policy: unknown(null)->known is allowed
        // PROGRESS on new context (no flip); known->unknown or
        // known->opposite on an unchanged representation is inconsistent
        // model behavior (never silently erases trusted evidence).
        let flippedOldEvidence = false;
        for (const d of docVerdicts) {
          const verdict3: readonly [boolean | null, boolean | null, boolean | null] = [
            d.relevant,
            d.supportsClaim,
            d.refutesClaim,
          ];
          const prev = f.sideHistory.get(d.evidenceId);
          if (prev !== undefined) {
            for (let axis = 0; axis < 3; axis += 1) {
              const before = prev[axis];
              const after = verdict3[axis];
              // null -> known: progress. known -> anything else (unknown or
              // opposite) on the same representation: inconsistent.
              if (before !== null && before !== after) flippedOldEvidence = true;
            }
          }
        }
        if (flippedOldEvidence) {
          f.inconsistentJudgments += 1;
          f.pendingAccept = null;
          f.pendingSinceKey = null;
          f.disputedSinceKey = null;
          pushLog("judge-invalid", `${f.id} side-flip on unchanged evidence over [${key}]`);
          // Mark the just-recorded attempt untrusted with the reason —
          // visible in audit, never in trusted history.
          const last = f.attemptedRecords.at(-1);
          if (last !== undefined && last.trusted) {
            last.trusted = false;
            last.reason = "inconsistent_history_flip";
          }
          // Sol-review fix 1: a REJECTED response must not overwrite the
          // trusted baseline. History is only written by accepted
          // judgments, so repeating a rejected tuple later still reads as
          // a flip against the last TRUSTED verdict — it can neither
          // fabricate a dispute nor erase a retained conflict.
          continue;
        }
        for (const d of docVerdicts) {
          f.sideHistory.set(d.evidenceId, [d.relevant, d.supportsClaim, d.refutesClaim]);
        }
        f.assessmentHistory.push(docVerdicts.map((d) => ({ ...d })));
        const meta = (response as unknown as Record<symbol, unknown> | null | undefined)?.[
          LEAN_JEV_ATTEMPT_META_SYMBOL
        ];
        f.judgeAttemptMeta.push(meta ?? null);
        // Source-uncertainty policy (per-source contribution/blockers):
        //   contribution  = relevant===true AND side===true (null never contributes)
        //   supported blocker = any source with relevance!==false AND refutes!==false
        //     (a possibly-relevant possible refutation vetoes one-sided support)
        //   refuted blocker   = symmetric over supports
        //   disputed needs CLEAR contributions on BOTH sides; unknowns never
        //     manufacture a dispute.
        const clearSupport = docVerdicts.filter(
          (d) => d.relevant === true && d.supportsClaim === true,
        );
        const clearRefute = docVerdicts.filter(
          (d) => d.relevant === true && d.refutesClaim === true,
        );
        f.relevantEvidenceIds = docVerdicts
          .filter((d) => d.relevant === true)
          .map((d) => d.evidenceId);
        const supportBlocker = docVerdicts.some(
          (d) => d.relevant !== false && d.refutesClaim !== false,
        );
        const refuteBlocker = docVerdicts.some(
          (d) => d.relevant !== false && d.supportsClaim !== false,
        );
        let accept: string | null = null;
        if (clearSupport.length > 0 && clearRefute.length > 0) {
          accept = f.req.schema.enum!.includes("disputed") ? "disputed" : null;
          if (accept === null) f.conflictUnresolvable = true;
        } else if (
          clearSupport.length > 0 &&
          !supportBlocker &&
          f.req.schema.enum!.includes("supported")
        ) {
          accept = "supported";
        } else if (
          clearRefute.length > 0 &&
          !refuteBlocker &&
          f.req.schema.enum!.includes("refuted")
        ) {
          accept = "refuted";
        }
        if (accept !== null && f.pendingAccept !== null && accept !== f.pendingAccept) {
          // one-sided -> disputed is legitimate counterevidence discovery;
          // every other flip is inconsistent model answers.
          if (f.pendingAccept !== "disputed" && accept === "disputed") {
            f.pendingAccept = accept;
            f.pendingSinceKey = key;
            f.disputedSinceKey = key;
          } else {
            f.inconsistentJudgments += 1;
            f.pendingAccept = null;
            f.pendingSinceKey = null;
            f.disputedSinceKey = null;
          }
        } else if (accept !== null) {
          f.pendingAccept = accept;
          f.pendingSinceKey = key;
          if (accept === "disputed") f.disputedSinceKey = key;
        } else {
          f.pendingAccept = null;
          f.pendingSinceKey = null;
          f.disputedSinceKey = null;
        }
      }

      // Finalization (repair pass): disputed finalizes on its evidencing
      // judgment (both sides positively evidenced). A ONE-SIDED accept
      // finalizes only when its counterevidence round COMPLETED: the
      // contrary query was issued SUCCESSFULLY and its results have been
      // read (or it surfaced none). Limits, failed searches, or unread
      // queues can never stand in for that round — the field stays
      // unresolved with counterevidence_not_acquired instead.
      // Unified proof: value-mode fields finalize symmetrically — the
      // candidate accept must live on the CURRENT evidence context (any
      // newly retained source dirties it via the judgment phase's
      // pre-clear) and the contrary round must have completed the same
      // way. An accept whose source vanished or whose conflict state is
      // unknown stays unresolved.
      // Unified proof: a terminal-satisfied field is a PROJECTION over
      // the CURRENT evidence set. While acquisition can still deliver a
      // new source, that projection is provisional — finalize it later
      // (the retention handler reopens it) rather than committing now.
      // Without this, a field accepted mid-loop could be stranded on the
      // pre-adverse accept simply because its last acquisition happened
      // after the only finalization pass.
      const canStillAcquire =
        hasUnread() ||
        (nextUnissuedQuery(queryIdx) < plan.length && searches < limits.maxSearchAttempts);
      for (const f of eligibleNow()) {
        if (f.terminal !== null) continue;
        if (f.req.schema.mode === "value") {
          if (f.acceptedCandidate === null) continue;
          const stillRetained = evidence.some(
            (e) => e.evidenceId === f.acceptedCandidate!.provenance.sourceId,
          );
          if (!stillRetained) {
            f.acceptedCandidate = null;
            continue;
          }
          // Mid-loop finalization applies the SAME prerequisite-closure
          // rule as the final projection: terminal satisfaction AND the
          // dependent's judged dependency revision must equal the
          // prerequisite's authoritative current binding (value AND
          // provenance). A standing accept carried over from an earlier
          // context can otherwise publish against a prerequisite that has
          // since re-satisfied on a different value or source.
          // Standing accepts get the SAME full live proof as retained
          // history — validated for THIS accept, not inferred from an
          // unrelated passing entry. A missing proof is a null proof, NOT
          // an empty dependency map: an unproven accept publishes nothing.
          const midProof = standingProofOf(f);
          if (
            midProof !== null &&
            f.lastJudgedKey === evidenceKey() &&
            f.req.dependsOn.every((dep) => fields.get(dep)?.terminal?.status === "satisfied") &&
            f.ctrvIssued &&
            f.ctrvSources.size === 0 &&
            !hasUnread() &&
            !canStillAcquire
          ) {
            // Publish the VALIDATED proof's own value/provenance — never a
            // different standing candidate's.
            f.terminal = { status: "satisfied", value: midProof.provenance.value };
            f.acceptedCandidate = { provenance: midProof.provenance, judgment: midProof.judgment };
          }
          continue;
        }
        if (f.pendingAccept === null) continue;
        if (f.pendingAccept === "disputed") {
          if (f.disputedSinceKey === evidenceKey()) {
            f.terminal = { status: "satisfied", value: f.pendingAccept };
          }
          continue;
        }
        // Staleness guard (parent finding: judge caps): the pending accept
        // must have been decided on the CURRENT evidence set. If evidence
        // changed after that judgment (e.g. the contrary doc was read but
        // the judge cap blocked reassessment), the accept is unproven —
        // clear it; finalizeUnmet reports the reason honestly.
        if (f.pendingSinceKey !== evidenceKey()) {
          f.pendingAccept = null;
          f.pendingSinceKey = null;
          f.disputedSinceKey = null;
          continue;
        }
        // Round-2 repair (outcome-aware contrary coverage): the contrary
        // round is COMPLETE only when every URL its query surfaced was
        // actually RETAINED (assessable). A URL that failed reads or was
        // rejected for oversize/byte-cap stays in ctrvSources forever —
        // queue drain alone can never satisfy the round. Prerequisite
        // closure rule identical to the final projection.
        if (
          f.req.dependsOn.every((dep) => fields.get(dep)?.terminal?.status === "satisfied") &&
          f.ctrvIssued &&
          f.ctrvSources.size === 0 &&
          !hasUnread() &&
          !canStillAcquire
        ) {
          f.terminal = { status: "satisfied", value: f.pendingAccept };
        }
      }
    }

    // Final projection: acquisition is over, so every provisional accept
    // still standing is projected onto the FINAL trusted context. A
    // pending accept that survived the run (all retained sources
    // assessed, contrary round settled) finalizes here; one that was
    // dirtied by a late source and never re-earned does not — finalizeUnmet
    // reports it honestly instead of leaking a stale value.
    {
      for (const f of fields.values()) {
        if (f.terminal !== null) continue;
        if (f.req.schema.mode === "value") {
          // RETENTION: choose the accept to project from ALL trusted
          // accepts — the latest acceptedCandidate if its context matches,
          // else any retained accept whose judged (source, opposing-set)
          // equals the FINAL evidence set. A material conflict on the
          // final context still blocks: the conflict-side judgment on that
          // same set prevents retention of a smaller-context accept only
          // when the conflicting judgment exists for the SAME pair
          // (acceptCandidate itself refuses conflict !== false).
          const finalIds = evidence.map((e) => e.evidenceId).sort();
          // Selection uses ONLY recorded judged contexts — the opposing set
          // an accept was ACTUALLY judged against (trustedAccepts entries;
          // the standing accept's entry is recorded at accept time). The
          // standing accept's opposing set is never fabricated from the
          // final ids: that would launder a smaller-context accept into a
          // final-context one.
          const chosen = f.trustedAccepts.find((t) => liveIdentityOf(t)) ?? null;
          if (chosen === null) continue;
          // Typed-stop veto: the harness physically refused further
          // acquisition — coverage is incomplete, so no accept is
          // projected as final on this run.
          if (runTypedStop !== null) continue;
          const stillRetained = evidence.some((e) => e.evidenceId === chosen.provenance.sourceId);
          // Provisional scheduling is NOT final trust: a dependant may only
          // project into accepted data when EVERY prerequisite is
          // terminally satisfied on the final context (an unfulfilled or
          // later-failed prerequisite rejects the dependent's accept —
          // the attempt audit is preserved; the value is not published).
          // A dependent publishes ONLY against the prerequisite binding it
          // was actually judged under: value AND provenance revision must
          // equal the prerequisite's authoritative current accept. A
          // dependency that re-satisfied on a different value/source
          // after this dependent was judged withdraws the dependent.
          const prereqsSatisfied = f.req.dependsOn.every(
            (dep) => fields.get(dep)?.terminal?.status === "satisfied",
          );
          const finalBindingMatches = Object.entries(chosen.judgedContext?.depBindings ?? {}).every(
            ([dep, rec]) => {
              const live = currentBindingOf(dep);
              return (
                live !== null &&
                rec.value === live.value &&
                rec.evidenceId === live.evidenceId &&
                rec.sourceDigest === live.sourceDigest
              );
            },
          );
          if (
            prereqsSatisfied &&
            stillRetained &&
            finalBindingMatches &&
            f.ctrvIssued &&
            f.ctrvSources.size === 0
          ) {
            f.terminal = { status: "satisfied", value: chosen.provenance.value };
            f.acceptedCandidate = { provenance: chosen.provenance, judgment: chosen.judgment };
          }
          continue;
        }
        if (f.pendingAccept === null) continue;
        // Same closure rule for enum dependants.
        if (!f.req.dependsOn.every((dep) => fields.get(dep)?.terminal?.status === "satisfied")) {
          continue;
        }
        if (f.pendingAccept === "disputed") {
          if (f.disputedSinceKey === evidenceKey()) {
            f.terminal = { status: "satisfied", value: f.pendingAccept };
          }
          continue;
        }
        if (f.pendingSinceKey === evidenceKey() && f.ctrvIssued && f.ctrvSources.size === 0) {
          f.terminal = { status: "satisfied", value: f.pendingAccept };
        }
      }
    }

    // Run over: release any in-flight bound request AND the expiry timer
    // (idempotent when nothing is pending). A request that outlived its
    // useful window is cancelled rather than left dangling past return.
    // Run-owned timer/abort/listener disposal: the `finally` above owns
    // it on every exit path.
    // Stop-root attribution: when a composed-run stop (cap/deadline) was
    // typed by a dependency DURING the run, fields already terminalized
    // with the engine-clock 'deadline' label are re-attributed to the
    // actual root — the engine clock reads expired once a harness stop
    // freezes it, so 'deadline' is an artifact of the stop, not a second
    // independent cause. Only that exact label is re-opened; every other
    // terminal reason keeps its ownership.
    {
      // Effective run root: a typed stop observed on a dependency, else the
      // harness-published global root when one exists.
      const effectiveRoot = runTypedStop ?? harnessStopRoot();
      if (effectiveRoot !== null) {
        for (const f of fields.values()) {
          if (f.terminal?.status === "unresolved" && f.terminal.reason === "deadline") {
            f.terminal = { status: "unresolved", reason: effectiveRoot };
          }
        }
      }
    }
    // Truthful terminal reasons for fields the final projection declined:
    // a value field with a standing accept but an UNSETTLED contrary round
    // ends counterevidence_not_acquired (never the generic internal_stop),
    // and a dependant blocked on prerequisite closure keeps that reason.
    for (const f of fields.values()) {
      if (f.terminal !== null) continue;
      if (f.req.schema.mode !== "value") continue;
      if (!f.req.dependsOn.every((dep) => fields.get(dep)?.terminal?.status === "satisfied")) {
        const deadDep = f.req.dependsOn.find(
          (dep) => fields.get(dep)?.terminal?.status !== "satisfied",
        );
        if (deadDep !== undefined && fields.get(deadDep)?.terminal !== null) {
          f.terminal = { status: "unresolved", reason: `prerequisite_unresolved:${deadDep}` };
          continue;
        }
      }
      if (f.acceptedCandidate !== null || f.trustedAccepts.length > 0) {
        if (runTypedStop !== null) {
          f.terminal = { status: "unresolved", reason: runTypedStop };
          continue;
        }
        if (f.ctrvIssued && f.ctrvSources.size === 0) {
          // Contrary round settled and SOME trusted accept exists. If
          // projection finalized it, terminal is already set and this pass
          // never runs. If it did NOT, the accepts are on smaller/stale
          // contexts — settled URLs are not evidence of a current-context
          // accept. Name the actual basis: the recorded missing-work
          // failure if present, else the explicit unscheduled-final-context
          // assessment cause (never the generic internal fallback).
          const failReason = [...f.attemptedRecords]
            .reverse()
            .find(
              (r0) =>
                r0.trusted === false &&
                typeof r0.reason === "string" &&
                r0.reason.startsWith("extract_failed:"),
            );
          f.terminal = {
            status: "unresolved",
            reason: failReason !== undefined ? failReason.reason! : "final_context_unassessed",
          };
          continue;
        }
        f.terminal = { status: "unresolved", reason: "counterevidence_not_acquired" };
        continue;
      }
      // No accept at all: terminalize with a RECORD-DERIVED cause — never the
      // generic internal fallback. Priority: an observed typed run stop; a
      // failed extraction (its sanitized audit reason, e.g. the explicit
      // missing-response marker of a frozen replay); judge unavailability;
      // unmet contrary coverage; otherwise honest exhaustion.
      if (runTypedStop !== null) {
        f.terminal = { status: "unresolved", reason: runTypedStop };
        continue;
      }
      const extractFail = [...f.attemptedRecords]
        .reverse()
        .find(
          (r0) =>
            r0.trusted === false &&
            typeof r0.reason === "string" &&
            r0.reason.startsWith("extract_failed:"),
        );
      if (extractFail !== undefined) {
        f.terminal = { status: "unresolved", reason: extractFail.reason! };
        continue;
      }
      if (f.judgeUnavailable) {
        f.terminal = { status: "unresolved", reason: "judge_unavailable" };
        continue;
      }
      if (f.noExtractor) {
        f.terminal = { status: "unresolved", reason: "no_extractor" };
        continue;
      }
      if (!(f.ctrvIssued && f.ctrvSources.size === 0)) {
        f.terminal = { status: "unresolved", reason: "counterevidence_not_acquired" };
        continue;
      }
      f.terminal = { status: "unresolved", reason: "exhausted" };
    }
    return assemble("semantic");

    function eligibleIds(): Set<string> {
      return new Set(eligibleFields().map((f) => f.id));
    }

    function finalizeWaitingDependants(reason: string): void {
      for (const f of fields.values()) {
        if (f.terminal !== null) continue;
        const deadDep = f.req.dependsOn.find(
          (dep) => fields.get(dep)?.terminal?.status === "unresolved",
        );
        if (deadDep !== undefined) {
          f.terminal = { status: "unresolved", reason: `prerequisite_unresolved:${deadDep}` };
        } else if (fields.get(f.id)?.terminal === null) {
          f.terminal = { status: "unresolved", reason };
        }
      }
    }

    function assemble(assessment: "semantic" | "deterministic-only"): LeanResult {
      // PRE-ASSEMBLY REVALIDATION, two distinct rules:
      //
      //  (a) FULL PROOF revalidation applies to VALUE fields only. A value
      //      field that reached "satisfied" earlier in the run has NOT yet
      //      satisfied the final-context proof; it re-proves against the
      //      live records here and a failure withdraws it with the explicit
      //      record-derived reason `final_context_unassessed`. Classification
      //      fields keep their own judgment/history semantics untouched.
      //
      //  (b) DEPENDENCY CLOSURE applies to EVERY satisfied dependent,
      //      classification included. A dependent whose prerequisite is no
      //      longer satisfied — or whose value prerequisite can no longer be
      //      proven — loses its own publication with the explicit reason
      //      `prerequisite_unproven`, because its value was conditioned on
      //      that prerequisite. This is closure enforcement only: it never
      //      re-judges a classification nor alters enum history policy.
      //
      // Repeated to a fixed point so withdrawal propagates through the
      // whole bounded dependency DAG; compile rejects cycles, and the pass
      // is bounded by the field count, so it terminates.
      for (let pass = 0; pass <= fields.size; pass += 1) {
        let withdrew = false;
        for (const f of fields.values()) {
          if (f.terminal?.status !== "satisfied") continue;
          // (a) value-proof revalidation, value mode only.
          if (f.req.schema.mode === "value") {
            const proof = standingProofOf(f) ?? retainedProofOf(f);
            if (proof === null) {
              f.terminal = { status: "unresolved", reason: "final_context_unassessed" };
              f.acceptedCandidate = null;
              withdrew = true;
              continue;
            }
            // Publish the VALIDATED proof's own value/provenance.
            f.acceptedCandidate = { provenance: proof.provenance, judgment: proof.judgment };
            f.terminal = { status: "satisfied", value: proof.provenance.value };
          }
          // (b) dependency closure, every satisfied dependent.
          const depBroken = f.req.dependsOn.some((dep) => {
            const d = fields.get(dep);
            if (d === undefined) return true;
            if (d.terminal?.status !== "satisfied") return true;
            if (d.req.schema.mode !== "value") return false;
            return (standingProofOf(d) ?? retainedProofOf(d)) === null;
          });
          if (depBroken) {
            f.terminal = { status: "unresolved", reason: "prerequisite_unproven" };
            f.acceptedCandidate = null;
            withdrew = true;
          }
        }
        if (!withdrew) break;
      }
      const rows: Record<string, LeanFieldRow> = {};
      const data: Record<string, string> = {};
      let satisfied = 0;
      let mandatory = 0;
      let mandatorySatisfied = 0;
      for (const f of fields.values()) {
        if (f.req.required) mandatory += 1;
        // A field left with no terminal is a WAITING dependant whose
        // prerequisite never resolved. That is a prerequisite-owned
        // outcome, not an opaque internal fallback: name the blocking
        // prerequisite explicitly so the generic reason can never conceal
        // the reproduced path. Genuinely unstarted fields with no
        // dependency keep the existing fallback.
        let terminal = f.terminal;
        if (terminal === null) {
          const blockedBy = f.req.dependsOn.find(
            (dep) => fields.get(dep)?.terminal?.status !== "satisfied",
          );
          terminal =
            blockedBy === undefined
              ? { status: "unresolved" as const, reason: "internal_stop" }
              : { status: "unresolved" as const, reason: `prerequisite_unresolved:${blockedBy}` };
        }
        if (terminal.status === "satisfied") {
          satisfied += 1;
          if (f.req.required) mandatorySatisfied += 1;
          rows[f.id] = {
            status: "satisfied",
            value: terminal.value,
            required: f.req.required,
            evidenceIds: [...f.relevantEvidenceIds],
            judgmentCount: f.judgmentCount,
            inconsistentJudgments: f.inconsistentJudgments,
            assessments: f.assessmentHistory,
            judgeAttempts: f.judgeAttemptMeta,
            attemptedRecords: f.attemptedRecords,
            ...(f.req.schema.mode === "value"
              ? {
                  candidates: f.candidateOutcomes,
                  ...(f.acceptedCandidate !== null
                    ? {
                        provenance: f.acceptedCandidate.provenance,
                        judgment: f.acceptedCandidate.judgment,
                      }
                    : {}),
                }
              : {}),
          };
          data[f.id] = terminal.value;
        } else {
          rows[f.id] = {
            status: "unresolved",
            reason: terminal.reason,
            required: f.req.required,
            evidenceIds: [...f.relevantEvidenceIds],
            judgmentCount: f.judgmentCount,
            inconsistentJudgments: f.inconsistentJudgments,
            assessments: f.assessmentHistory,
            judgeAttempts: f.judgeAttemptMeta,
            attemptedRecords: f.attemptedRecords,
            // Unified audit (§everyattempt): value rows keep their
            // extraction/validation history even when unresolved — a
            // length/refusal reject stays inspectable.
            ...(f.req.schema.mode === "value" ? { candidates: f.candidateOutcomes } : {}),
          };
        }
      }
      if (seed?.capture !== undefined) {
        // Coverage (issued queries / unread leads) persists for EVERY round —
        // it is acquisition bookkeeping, not judgment history. Field-state
        // history persists ONLY under a caller-pinned judge/policy identity;
        // an unknown identity never records reusable proof state.
        const history: LeanFieldCheckpoint[] =
          seed.identity === undefined
            ? [...(seed.history ?? [])]
            : (() => {
                const out = [...(seed.history ?? [])];
                for (const f of fields.values()) {
                  const state = structuredClone({
                    ...f,
                    sideHistory: [...f.sideHistory],
                    ctrvSources: [...f.ctrvSources],
                    judgedSourceKeys: [...f.judgedSourceKeys],
                  });
                  out.push({ namespace: namespaceOf(f), context: contextOf(), state });
                }
                return out;
              })();
        seed.capture({
          history,
          issuedQueries: [...issuedQueries],
          leads: queue
            .filter((l) => !evidence.some((e) => e.url === l.url))
            .map((l) => ({ ...l, origins: [...(originsByUrl.get(l.url) ?? [])] })),
        });
      }
      // Preserve every representation's lineage before adding current URL discoveries.
      const returnedOriginsByUrl = new Map<string, Set<string>>();
      for (const record of evidence) {
        returnedOriginsByUrl.set(
          record.url,
          new Set([...(returnedOriginsByUrl.get(record.url) ?? []), ...record.origins]),
        );
      }
      for (const [url, origins] of originsByUrl) {
        returnedOriginsByUrl.set(
          url,
          new Set([...(returnedOriginsByUrl.get(url) ?? []), ...origins]),
        );
      }
      return {
        schemaVersion: 1,
        // Unified completion (Rev3): complete iff the MANDATORY set is
        // satisfied — required fields + their dependency closure + limits.
        // Optional gaps never force partial; zero-accept mandatory-miss is
        // partial (legacy "empty" dropped).
        status: mandatorySatisfied === mandatory ? "complete" : "partial",
        assessment,
        question: compiled.question,
        plan: { queries: plan.map((p) => ({ query: p.query, fieldId: p.fieldId, kind: p.kind })) },
        data,
        requirements: rows,
        coverageNotes,
        // Final query lineage is returned metadata. Keep the records that
        // judgments and early retention hooks saw unchanged.
        evidence: evidence.map((record) => ({
          ...record,
          origins: [...(returnedOriginsByUrl.get(record.url) ?? record.origins)],
        })),
        acquisitionLog: log,
        usage: {
          searches,
          readAttempts,
          readsRetained,
          judgeCalls,
          extractorCalls,
          extractorCacheHits,
          candidateJudgeCalls,
        },
      };
    }
  } finally {
    releaseRunResources();
    runAbort.abort();
  }
}
