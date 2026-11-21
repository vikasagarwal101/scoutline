/**
 * Evidence-backed comparison consumer (v3 seed 02 first slice,
 * docs/plans/v3/02-evidence-backed-comparison.md + FIRST-SLICE.json).
 * EXPERIMENTAL lane-owned surface — NOT yet dispatched from the public
 * CLI (index.ts wiring is a convergence-review item).
 *
 * Responsibilities (consumer layer only — the shared lean engine owns
 * acquisition, judgment, cancellation and acceptance):
 *   - caller declares the comparison frame: explicit entity list
 *     (releases), typed dimensions (question template + classification
 *     schema), common frame tokens and engine limits;
 *   - DETERMINISTIC expansion into one requirement per entity ×
 *     dimension with a stable cell-to-requirement map (slugged keys,
 *     collision-refused, never concatenated display labels) — the
 *     entity is interpolated LITERALLY (function replacement, so `$&`
 *     and friends in a release label cannot rewrite the obligation);
 *   - preflight BEFORE any runtime composition or acquisition: shape,
 *     duplicate labels, template/entity sanity, exact schema key set
 *     (unsupported controls are rejected, never silently stripped),
 *     the comparison's own limits key screen, and the expansion cap
 *     (the engine's frozen maxFields ceiling — kept as-is per PREP.md);
 *   - SECRET BASIS, captured ONCE at entry (supplied host env shallow
 *     copy + host.secrets, merged with configuredSecrets through the
 *     existing helper — never ambient process.env, never a reread):
 *     an invocation-OWNED host carries the merged basis into
 *     withRequirementsRuntime, so the shared projection redacts env
 *     credentials in the nested envelope too, and the same basis plus
 *     runtime-reported secrets governs this lane's metadata;
 *   - every lane diagnostic is redacted with the captured basis before
 *     it is thrown — a validation failure never echoes an unsafe
 *     string, while codes/typed semantics are unchanged;
 *   - output identity surfaces (cell keys, entity/dimension labels,
 *     frame keys, requirement/evidence ids, provenance map keys) are
 *     never redacted-and-corrupted: a basis secret occurring in ANY of
 *     them — including generated id patterns — is a static typed
 *     rejection that does not echo the secret;
 *   - the shared projected engine envelope is embedded BYTE-FOR-BYTE
 *     and its delivered display digests/lengths are VERIFIED before
 *     delivery (fail closed with a static error on inconsistency —
 *     the shared projector's own basis gap is a recorded convergence
 *     defect, not something this lane rewrites);
 *   - Reader serve provenance carries the FULL record (url, finalUrl,
 *     provider, fromCache, cacheProbeWarm, servedAt) joined to retained
 *     evidenceIds on exact unredacted URLs BEFORE any display
 *     redaction, so redacted-URL collisions cannot collapse the link;
 *   - projection of the engine result into the four-state cell matrix
 *     (supported / refuted / disputed / unresolved) with per-cell
 *     evidence references that resolve into the delivered evidence.
 *
 * Scope boundaries preserved: a wrong-scope document (e.g. Enterprise
 * evidence for a Community cell) is the semantic judge's relevance
 * call — the consumer never guesses a normalized value, and silence
 * stays unresolved. No ranking, no cross-cell conversion, one frame.
 *
 * Cancellation: a pre-aborted signal settles the owned 130 outcome
 * before any work. Setup-phase aborts are raced by the SHARED seam;
 * this lane only narrowly normalizes an AbortError that actually
 * escapes setup — it never races the run itself, so once the runtime
 * has entered dispatches the await keeps the engine's settled
 * cancellation ledger and maps it to exit 130. Unrelated errors
 * surface as themselves, never masked as cancellation.
 */

import { createHash } from "node:crypto";
import { ValidationError } from "../lib/errors.js";
import { redactSecrets, configuredSecrets } from "../lib/redact.js";
import {
  compileLeanContract,
  runLeanInvestigation,
  LEAN_LIMIT_CEILINGS,
  type LeanResult,
} from "../lib/lean-investigation.js";
import {
  withRequirementsRuntime,
  type InvestigateRequirementsDeps,
} from "./investigate-requirements.js";
import type { CommandResult } from "../command-invocation.js";

// ---------------------------------------------------------------------------
// Input (caller-declared comparison frame) — strict closed key sets
// ---------------------------------------------------------------------------

const COMPARISON_KEYS: ReadonlySet<string> = new Set([
  "schemaVersion",
  "question",
  "entities",
  "dimensions",
  "frame",
  "limits",
]);
const DIMENSION_KEYS: ReadonlySet<string> = new Set(["question", "schema", "criteria"]);
/** The comparison owns its limits screen; the values/ceilings remain the
 *  engine compiler's (same closed key set as the requirements mode). */
const COMPARISON_LIMIT_KEYS: ReadonlySet<string> = new Set([
  "readBatchSize",
  "maxUniqueReads",
  "maxSearchAttempts",
  "maxJudgeAttempts",
  "deadlineMs",
]);

/** The classification vocabulary every comparison cell may take. */
const CELL_OUTCOMES: readonly string[] = ["supported", "refuted", "disputed"];

export interface ComparisonDimension {
  readonly question: string;
  readonly schema?: { readonly enum: readonly string[] };
  readonly criteria?: readonly string[];
}

export interface ComparisonInput {
  readonly schemaVersion: 1;
  readonly question: string;
  readonly entities: readonly string[];
  readonly dimensions: Readonly<Record<string, ComparisonDimension>>;
  readonly frame?: Readonly<Record<string, string>>;
  readonly limits?: Readonly<Record<string, number>>;
}

/** One expanded matrix cell: stable identity + engine requirement id. */
export interface ComparisonCell {
  readonly entity: string;
  readonly dimension: string;
  readonly requirementId: string;
}

export interface ExpandedComparison {
  /** The plain engine contract document (schemaVersion 1 shape), built
   *  ONLY from validated copies — caller-held objects cannot mutate it. */
  readonly contractInput: Readonly<Record<string, unknown>>;
  /** The compiled lean contract (engine-validated, zero acquisition). */
  readonly contract: ReturnType<typeof compileLeanContract>;
  /** Stable cell-to-requirement map, keyed by slugged cell key. */
  readonly cells: Readonly<Record<string, ComparisonCell>>;
  /** Caller frame verbatim (the contract scope). */
  readonly frame: Readonly<Record<string, string>>;
  /** The validated question SNAPSHOT — the executed and delivered
   *  question both come from here, never a later reread of the input. */
  readonly question: string;
}

/** FULL Reader serve provenance for one retained evidence record, keyed
 *  by the stable evidenceId (joined on exact unredacted URLs inside the
 *  engine run, before any display redaction). */
export interface EvidenceServeProvenance {
  readonly url: string;
  readonly finalUrl: string;
  readonly provider: string;
  readonly fromCache: boolean;
  readonly cacheProbeWarm: boolean | "unknown";
  readonly servedAt: number;
}

// ---------------------------------------------------------------------------
// Deterministic key slugging
// ---------------------------------------------------------------------------

/**
 * Deterministic cell key: lowercase, every non-[a-z0-9] run collapses to
 * one `_`. `2.4.0` → `2_4_0`. Collisions across (entity, dimension)
 * pairs are REFUSED at preflight — never silently merged.
 */
export function comparisonCellKey(entity: string, dimension: string): string {
  const slug = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  return `${slug(entity)}_${slug(dimension)}`;
}

// ---------------------------------------------------------------------------
// Owned interruption outcome (exit 130)
// ---------------------------------------------------------------------------

/** Selected owned cancellation: the comparison was interrupted; nothing
 *  runnable had begun at the stated stage. */
export class ComparisonInterruptedError extends ValidationError {
  constructor(stage: "before any work" | "while setup was pending" = "before any work") {
    super(
      `comparison interrupted ${stage}: no acquisition result is being delivered.`,
      "The run was cancelled; re-run to compare.",
    );
    Object.assign(this, { exitCode: 130 });
  }
}

// ---------------------------------------------------------------------------
// Secret basis (captured ONCE) + safe diagnostics
// ---------------------------------------------------------------------------

/** The run's captured secret basis: host.secrets UNION
 *  configuredSecrets over the SUPPLIED host env (captured shallow copy
 *  — never ambient process.env, never reread after capture). Runtime
 *  secrets are added at delivery; the host part never changes. */
export interface CapturedSecretBasis {
  readonly env: NodeJS.ProcessEnv;
  readonly host: readonly string[];
  withRuntime(runtime: readonly string[]): string[];
}

function captureSecretBasis(host: { secrets?: readonly string[]; env?: NodeJS.ProcessEnv }): CapturedSecretBasis {
  const env: NodeJS.ProcessEnv = { ...(host.env ?? {}) };
  const basis = [
    ...new Set([...(host.secrets ?? []), ...configuredSecrets(env)]),
  ].filter((s) => typeof s === "string" && s !== "");
  return {
    env,
    host: basis,
    withRuntime(runtime: readonly string[]): string[] {
      return [...new Set([...basis, ...runtime])].filter((s) => typeof s === "string" && s !== "");
    },
  };
}

/** Throw a typed validation error whose dynamic text is REDACTED with
 *  the captured basis first — a lane diagnostic never echoes an unsafe
 *  string, and the code/typed semantics are unchanged. */
function fail(basis: readonly string[], message: string, help?: string): never {
  const secrets = [...basis];
  const safe = redactSecrets(message, secrets) as string;
  const safeHelp = help === undefined ? undefined : (redactSecrets(help, secrets) as string);
  throw new ValidationError(safe, safeHelp);
}

// ---------------------------------------------------------------------------
// Preflight + deterministic expansion (pure; throws before any work)
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Validate the comparison declaration, expand it deterministically and
 * compile the lean contract. Throws ValidationError on every malformed
 * shape, duplicate/colliding label, missing `{entity}` template hole,
 * silently-strippable schema control, unknown limit key, or over-cap
 * expansion — always BEFORE any runtime composition or acquisition,
 * and always through the redacted-diagnostic boundary (the caller's
 * captured secret basis is REQUIRED — an omitted or non-array basis is
 * itself a typed refusal, never a silent empty-basis echo).
 */
export function expandComparison(input: unknown, basis: readonly string[]): ExpandedComparison {
  if (!Array.isArray(basis)) {
    throw new ValidationError(
      "expandComparison requires the caller's captured secret-basis array; diagnostics are sanitized against it (pass [] for an explicitly empty basis).",
    );
  }
  if (!isPlainObject(input)) {
    throw new ValidationError("comparison must be a JSON object.");
  }
  if (input.schemaVersion !== 1) {
    fail(basis, `comparison schemaVersion must be the number 1 (got ${JSON.stringify(input.schemaVersion)}).`);
  }
  const extras = Object.keys(input).filter((key) => !COMPARISON_KEYS.has(key));
  if (extras.length > 0) {
    fail(basis, `comparison carries unsupported keys (${extras.join(", ")}) — unknown declarations are rejected, not dropped.`);
  }
  if (!isNonEmptyString(input.question)) {
    throw new ValidationError("comparison question must be a non-empty string.");
  }

  if (!Array.isArray(input.entities) || input.entities.length === 0) {
    throw new ValidationError("comparison entities must be a non-empty array of release/entity identifiers.");
  }

  if (!isPlainObject(input.dimensions)) {
    throw new ValidationError("comparison dimensions must be an object keyed by dimension id.");
  }
  const dimensionIds = Object.keys(input.dimensions);
  if (dimensionIds.length === 0) {
    throw new ValidationError("comparison must declare at least one dimension.");
  }
  // Deterministic matrix cardinality gate BEFORE any element is read:
  // with both counts known from the containers themselves, an
  // over-ceiling declaration refuses immediately — no entity or
  // dimension element is inspected, so an oversized hostile list costs
  // two property reads, never a scan. The cap itself is the engine's
  // frozen ceiling — kept as-is; widening it is a shared convergence
  // decision, never a consumer constant.
  {
    const total = input.entities.length * dimensionIds.length;
    if (total > LEAN_LIMIT_CEILINGS.maxFields) {
      throw new ValidationError(
        `comparison expands to ${total} cells (${input.entities.length} entities × ${dimensionIds.length} dimensions) over the engine's frozen ceiling of ${LEAN_LIMIT_CEILINGS.maxFields} fields; refused before any acquisition. Widening the matrix needs the shared field-expansion decision first.`,
      );
    }
  }

  const entities: string[] = [];
  const seenEntities = new Set<string>();
  for (const raw of input.entities) {
    if (!isNonEmptyString(raw)) {
      throw new ValidationError("comparison entities must contain only non-empty strings.");
    }
    if (seenEntities.has(raw)) {
      fail(basis, `comparison declares duplicate entity "${raw}".`);
    }
    seenEntities.add(raw);
    entities.push(raw);
  }
  const dimensions: { id: string; dim: ComparisonDimension }[] = [];
  for (const id of dimensionIds) {
    if (!isNonEmptyString(id)) {
      throw new ValidationError("comparison dimension ids must be non-empty strings.");
    }
    const raw = input.dimensions[id];
    if (!isPlainObject(raw)) {
      fail(basis, `comparison dimension "${id}" must be an object.`);
    }
    const dimExtras = Object.keys(raw).filter((key) => !DIMENSION_KEYS.has(key));
    if (dimExtras.length > 0) {
      fail(basis, `comparison dimension "${id}" carries unsupported keys (${dimExtras.join(", ")}).`);
    }
    if (!isNonEmptyString(raw.question)) {
      fail(basis, `comparison dimension "${id}".question must be a non-empty string.`);
    }
    const holes = raw.question.split("{entity}").length - 1;
    if (holes !== 1) {
      fail(basis, `comparison dimension "${id}".question must reference the entity placeholder {entity} exactly once (found ${holes}) — each cell's obligation must name its exact entity.`);
    }
    let schema: { enum: readonly string[] } | undefined;
    if (raw.schema !== undefined) {
      if (!isPlainObject(raw.schema)) {
        fail(basis, `comparison dimension "${id}".schema must be { enum: [...] } (the first slice supports classification dimensions only).`);
      }
      // Exact key set: an unsupported schema control is REJECTED here,
      // never accepted-and-stripped on its way into the engine contract.
      const schemaKeys = Object.keys(raw.schema);
      if (schemaKeys.length !== 1 || schemaKeys[0] !== "enum" || !Array.isArray(raw.schema.enum)) {
        fail(basis, `comparison dimension "${id}".schema supports exactly { enum: [...] } (got keys: ${schemaKeys.join(", ") || "none"}) — unsupported controls are rejected, not stripped.`);
      }
      schema = { enum: [...(raw.schema.enum as unknown[])] as string[] };
    }
    let criteria: readonly string[] | undefined;
    if (raw.criteria !== undefined) {
      if (!Array.isArray(raw.criteria) || raw.criteria.some((c) => !isNonEmptyString(c))) {
        fail(basis, `comparison dimension "${id}".criteria must be an array of non-empty strings.`);
      }
      criteria = [...raw.criteria] as string[];
    }
    dimensions.push({ id, dim: { question: raw.question, schema, criteria } });
  }

  let frame: Record<string, string> = {};
  if (input.frame !== undefined) {
    // Plain-record requirement at the boundary: a Map or class instance
    // has no enumerable own string keys, so accepting it would let the
    // declared scope silently DISAPPEAR (an empty frame). Ordinary JSON
    // objects (Object.prototype or null prototype) pass. The null guard
    // runs BEFORE getPrototypeOf so `frame: null` is a typed rejection,
    // never a raw TypeError.
    if (typeof input.frame !== "object" || input.frame === null || Array.isArray(input.frame)) {
      throw new ValidationError(
        "comparison frame must be a plain record of string tokens — null, Maps, class instances and arrays are rejected so the declared scope cannot silently disappear.",
      );
    }
    const frameProto = Object.getPrototypeOf(input.frame);
    if (frameProto !== Object.prototype && frameProto !== null) {
      throw new ValidationError(
        "comparison frame must be a plain record of string tokens — Maps, class instances and arrays are rejected so the declared scope cannot silently disappear.",
      );
    }
    frame = {};
    for (const [key, value] of Object.entries(input.frame)) {
      if (!isNonEmptyString(key) || typeof value !== "string") {
        throw new ValidationError("comparison frame keys must be non-empty and values strings.");
      }
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        fail(basis, `comparison frame key "${key}" is reserved and cannot be declared.`);
      }
      frame[key] = value;
    }
  }

  // The comparison owns its limits key screen; the engine compiler owns
  // value validation (types, ceilings). The contract carries a validated
  // COPY so a caller-held object cannot mutate between preflight and run.
  let limits: Record<string, number> | undefined;
  if (input.limits !== undefined) {
    if (!isPlainObject(input.limits)) {
      throw new ValidationError("comparison limits must be an object.");
    }
    const limitExtras = Object.keys(input.limits).filter((key) => !COMPARISON_LIMIT_KEYS.has(key));
    if (limitExtras.length > 0) {
      fail(basis, `comparison limits declare unsupported keys (${limitExtras.join(", ")}) — supported: ${[...COMPARISON_LIMIT_KEYS].join(", ")}.`);
    }
    limits = { ...(input.limits as Record<string, number>) };
  }

  // Deterministic expansion: dimensions in declaration order, entities in
  // declaration order, one requirement per cell with the exact entity
  // named in the obligation question and the common frame as scope.
  const requirements: Record<string, unknown> = {};
  const cells: Record<string, ComparisonCell> = {};
  for (const { id: dimension, dim } of dimensions) {
    for (const entity of entities) {
      const key = comparisonCellKey(entity, dimension);
      if (Object.hasOwn(cells, key)) {
        fail(basis, `comparison cell key "${key}" collides across (entity, dimension) pairs — rename the entities or dimensions; keys are never silently merged.`);
      }
      // LITERAL interpolation: the function form never interprets `$`
      // sequences in the entity, so the release named in the obligation
      // is exactly the caller's string.
      const question = dim.question.replace("{entity}", () => entity);
      if (question.includes("{entity}")) {
        fail(basis, `entity "${entity}" interpolates into itself; reserved placeholder text is not a valid entity label.`);
      }
      requirements[key] = {
        question,
        schema: dim.schema ?? { enum: [...CELL_OUTCOMES] },
        ...(dim.criteria !== undefined ? { criteria: dim.criteria } : {}),
        required: true,
      };
      cells[key] = { entity, dimension, requirementId: key };
    }
  }

  const contractInput: Record<string, unknown> = {
    schemaVersion: 1,
    question: input.question,
    ...(Object.keys(frame).length > 0 ? { scope: frame } : {}),
    requirements,
    ...(limits !== undefined ? { limits } : {}),
  };
  // Full deep validation (limits values/ceilings, enum vocabulary,
  // cycles) through the engine's own compiler — zero acquisition on
  // failure. A compiler ValidationError can ECHO caller material (an
  // invalid enum value that is itself a secret), so it is sanitized
  // with the captured basis before outward delivery; the type, code and
  // exit semantics are preserved.
  let contract: ReturnType<typeof compileLeanContract>;
  try {
    contract = compileLeanContract(contractInput);
  } catch (error) {
    if (error instanceof ValidationError) {
      const secrets = [...basis];
      const sanitized = new ValidationError(
        redactSecrets(error.message, secrets) as string,
        error.help === undefined ? undefined : (redactSecrets(error.help, secrets) as string),
      );
      const exitCode = (error as { exitCode?: number }).exitCode;
      if (exitCode !== undefined) Object.assign(sanitized, { exitCode });
      throw sanitized;
    }
    throw error;
  }
  // Classification enum screen — AFTER the compiler's typed validation:
  // the compiler has already rejected non-string/malformed/duplicate
  // enum entries with its own typed diagnostics, so this screen sees
  // only validated string values. The screen reads field.schema.enum
  // DIRECTLY off each compiled field — compiled field ids are cell keys
  // (entity × dimension), so any lookup keyed by dimension id would
  // resolve the WRONG enum (or none, falling back to the default and
  // both missing declared values and falsely refusing excluded ones).
  // A basis secret the redactor would touch is a static no-echo
  // refusal; enums are never rewritten. Delivered values are screened
  // again once runtime secrets are known.
  {
    const secrets = [...basis];
    for (const field of contract.fields) {
      const values = field.schema.enum ?? [];
      for (const value of values) {
        if (redactSecrets(value, secrets) !== value) {
          throw new ValidationError(
            `comparison field "${redactSecrets(field.id, secrets)}" declares a classification value that is not publishable under the run's secret basis — rename the value or remove the credential material from the basis.`,
            "Classification values are bounded enums and are never partially redacted; a value that carries credential material cannot be delivered.",
          );
        }
      }
    }
  }
  return { contractInput, contract, cells, frame, question: input.question };
}

// ---------------------------------------------------------------------------
// Result projection (four-state cells over the shared projected engine
// envelope)
// ---------------------------------------------------------------------------

/** Per-cell projection: the engine outcome plus evidence references. */
export interface ComparisonCellResult {
  readonly entity: string;
  readonly dimension: string;
  readonly requirementId: string;
  /** The four-state cell outcome: an accepted classification value, or
   *  `unresolved` — never a guessed normalized value. */
  readonly outcome: string;
  readonly status: "satisfied" | "unresolved";
  readonly value?: string;
  readonly reason?: string;
  readonly evidenceIds: readonly string[];
  readonly judgmentCount: number;
  readonly inconsistentJudgments: number;
}

export interface ComparisonMatrix {
  readonly kind: "evidence-comparison";
  readonly schemaVersion: 1;
  readonly status: "complete" | "partial";
  readonly assessment: LeanResult["assessment"];
  readonly question: string;
  readonly frame: Readonly<Record<string, string>>;
  readonly cells: Readonly<Record<string, ComparisonCellResult>>;
  /** FULL Reader serve provenance per retained evidenceId — joined on
   *  exact unredacted URLs inside the engine run, keyed by the stable
   *  evidenceId so display redaction can never collapse the link. */
  readonly evidenceProvenance: Readonly<Record<string, EvidenceServeProvenance>>;
  /** The shared projected engine envelope, VERBATIM: redacted evidence
   *  with original/display digests, per-field rows, acquisition log,
   *  usage with physical accounting, admission disclosure, Reader
   *  provenance — and its own resultSha256 binding that exact form. */
  readonly engine: Record<string, unknown>;
}

/**
 * Cell FREE TEXT (the engine judgment `reason`) is display-only prose
 * and rides the same captured basis as all other comparison metadata —
 * redacted at delivery, never assumed clean because today's engine
 * reason vocabulary happens to be fixed identifiers. Bounded enums
 * (`value`/`outcome`) and every structural id are NOT rewritten here:
 * enums are screened (static rejection on a redactor match) and ids are
 * identity surfaces covered by the identifier screens.
 */
export function redactComparisonCells(
  rows: Record<string, ComparisonCellResult>,
  basis: readonly string[],
): Record<string, ComparisonCellResult> {
  const secrets = [...basis];
  return Object.fromEntries(
    Object.entries(rows).map(([key, row]) => [
      key,
      {
        ...row,
        ...(row.reason !== undefined ? { reason: redactSecrets(row.reason, secrets) as string } : {}),
      },
    ]),
  );
}

function projectCells(
  expanded: ExpandedComparison,
  result: LeanResult,
): Record<string, ComparisonCellResult> {
  const cells: Record<string, ComparisonCellResult> = {};
  for (const [key, cell] of Object.entries(expanded.cells)) {
    const row = result.requirements[cell.requirementId];
    if (row === undefined) {
      // Unreachable: every mapped requirement id was compiled in.
      throw new ValidationError(
        "comparison cell lost its engine requirement row — expansion/projection disagree.",
      );
    }
    cells[key] = {
      entity: cell.entity,
      dimension: cell.dimension,
      requirementId: cell.requirementId,
      outcome: row.status === "satisfied" && row.value !== undefined ? row.value : "unresolved",
      status: row.status,
      ...(row.value !== undefined ? { value: row.value } : {}),
      ...(row.reason !== undefined ? { reason: row.reason } : {}),
      evidenceIds: [...row.evidenceIds],
      judgmentCount: row.judgmentCount,
      inconsistentJudgments: row.inconsistentJudgments,
    };
  }
  return cells;
}

/**
 * Join FULL Reader serve provenance to retained evidenceIds on EXACT
 * unredacted URLs, inside the engine run and BEFORE any display
 * redaction: two URLs that collapse after redaction keep distinct
 * evidenceId keys, so the link can never be lost to redaction. A
 * duplicate evidenceId join is a static typed failure, never a silent
 * overwrite.
 */
export function joinServeProvenance(
  result: LeanResult,
  readProvenance: readonly {
    url: string;
    finalUrl: string;
    provider: string;
    fromCache: boolean;
    cacheProbeWarm: boolean | "unknown";
    servedAt: number;
  }[] | undefined,
): Record<string, EvidenceServeProvenance> {
  const joined: Record<string, EvidenceServeProvenance> = {};
  if (readProvenance === undefined) return joined;
  for (const record of readProvenance) {
    const evidence = result.evidence.find((e) => e.url === record.url);
    if (evidence === undefined) continue;
    if (Object.hasOwn(joined, evidence.evidenceId)) {
      throw new ValidationError(
        "Reader serve provenance collided on one evidence id — refusing to silently overwrite the record.",
      );
    }
    joined[evidence.evidenceId] = {
      url: record.url,
      finalUrl: record.finalUrl,
      provider: record.provider,
      fromCache: record.fromCache,
      cacheProbeWarm: record.cacheProbeWarm,
      servedAt: record.servedAt,
    };
  }
  return joined;
}

/**
 * Delivered-display integrity gate: every evidence record in the shared
 * projected envelope must carry a display digest and byte length that
 * MATCH the delivered content bytes. The shared projector's basis gap
 * is a recorded convergence defect; this lane verifies the artifacts it
 * actually delivers and fails closed with a static error (no content
 * echo) on any inconsistency — including stale digests after any
 * double-redaction or repeat-marker corruption upstream.
 */
export function verifyEngineDisplayIntegrity(
  engineEnvelope: Record<string, unknown>,
): void {
  const evidence = engineEnvelope.evidence;
  if (!Array.isArray(evidence)) {
    throw new ValidationError(
      "engine envelope delivered no evidence array — refusing to deliver a comparison without verifiable evidence identity.",
    );
  }
  for (const record of evidence) {
    if (!isPlainObject(record)) {
      throw new ValidationError(
        "engine envelope delivered a malformed evidence record — refusing unverifiable evidence.",
      );
    }
    const content = record.content;
    const digest = record.displayContentSha256;
    const bytes = record.displayByteLength;
    if (typeof content !== "string" || typeof digest !== "string" || typeof bytes !== "number") {
      throw new ValidationError(
        "engine evidence record lacks display digest/length fields — refusing unverifiable evidence.",
      );
    }
    if (digest !== createHash("sha256").update(content, "utf8").digest("hex") || bytes !== Buffer.byteLength(content, "utf8")) {
      throw new ValidationError(
        "engine evidence display digest or byte length is inconsistent with the delivered content — refusing a stale display projection.",
      );
    }
  }
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Output identifiers (cell keys, entity/dimension labels, frame keys,
 * requirement/evidence ids, provenance map keys) are identity surfaces:
 * redacting them would corrupt the cell↔engine row↔evidence links, and
 * leaving them untouched would leak. Safety is judged by the EXISTING
 * redactor semantics — an identifier the redactor would change (a basis
 * secret substring, OR a credential-shaped pattern with an EMPTY basis)
 * is a STATIC typed rejection whose message names the surface kind,
 * never the secret value. Identifiers are never rewritten.
 */
function assertPublishableIdentifiers(
  expanded: ExpandedComparison,
  rows: Record<string, ComparisonCellResult>,
  provenanceKeys: readonly string[],
  basis: readonly string[],
  stage: "preflight" | "delivery",
): void {
  const surfaces: readonly { kind: string; value: string }[] = [
    ...Object.keys(expanded.cells).map((key) => ({ kind: "cell key", value: key })),
    ...Object.values(expanded.cells).flatMap((cell) => [
      { kind: "entity label", value: cell.entity },
      { kind: "dimension id", value: cell.dimension },
    ]),
    ...Object.keys(expanded.frame).map((key) => ({ kind: "frame key", value: key })),
    ...Object.values(rows).flatMap((row) => {
      const own: { kind: string; value: string }[] = row.evidenceIds.map((id) => ({
        kind: "evidence id reference",
        value: id,
      }));
      // Bounded enums and control tokens delivered as text: screened
      // (never rewritten) — runtime secrets can add a match the
      // preflight screens could not see, so delivered values are
      // checked again here.
      if (row.value !== undefined) own.push({ kind: "classification value", value: row.value });
      own.push({ kind: "classification outcome", value: row.outcome });
      own.push({ kind: "cell status token", value: row.status });
      return own;
    }),
    ...provenanceKeys.map((id) => ({ kind: "evidence provenance key", value: id })),
  ];
  const secrets = [...basis];
  for (const surface of surfaces) {
    if (redactSecrets(surface.value, secrets) !== surface.value) {
      throw new ValidationError(
        `comparison ${surface.kind} is not publishable under the run's secret basis (the identifier matches credential material under the existing redaction semantics) — rejected ${stage === "preflight" ? "before any acquisition" : "before delivery"}; rename the identifier.`,
        "Identifiers are identity surfaces and are never partially redacted; choose a label that does not carry credential material.",
      );
    }
  }
}

/**
 * Output MAP KEYS ride whole-envelope object redaction at output
 * boundaries: the shared redactor replaces the VALUE under any key
 * whose lowercase name is a credential field (CREDENTIAL_KEYS). A cell
 * or frame key like `api_key` (entity "api" × dimension "key") would
 * have its row silently clobbered there. The check reuses the ACTUAL
 * redactor semantics — redactSecrets({[key]: numeric sentinel}) and a
 * value-identity check — and rejects statically, never echoing the key.
 */
function assertStableObjectKeys(expanded: ExpandedComparison, basis: readonly string[]): void {
  const secrets = [...basis];
  const keys = [...Object.keys(expanded.cells), ...Object.keys(expanded.frame)];
  for (const key of keys) {
    const redacted = redactSecrets({ [key]: 1 }, secrets) as Record<string, unknown>;
    if (redacted[key] !== 1) {
      throw new ValidationError(
        "comparison output key is not publishable: the shared object-key redaction semantics would replace its value — rename the identifier.",
        "Output map keys that read as credential-field names are clobbered by whole-envelope redaction at output boundaries; choose a key that is not a credential-field name.",
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Run one evidence-backed comparison through the merged lean engine.
 * `deps`/`host` are the requirements-mode seams (injected offline
 * runtime in tests; production composition at convergence wiring).
 * The read functions on `deps` are unused — the comparison declaration
 * arrives as a parsed object, not a file.
 *
 * Delivery: the shared redacted projected engine envelope rides
 * byte-for-byte under `engine` (its display digests verified); only
 * comparison-owned metadata is redacted, on the once-captured host
 * basis plus runtime secrets; `resultSha256` binds the FINAL delivered
 * matrix.
 *
 * Exit codes: 0 complete / 1 partial / 130 interrupted, matching the
 * requirements-mode recommendation.
 */
export async function runEvidenceComparison(
  input: unknown,
  deps: InvestigateRequirementsDeps,
  host: Parameters<typeof withRequirementsRuntime>[2],
  signal?: AbortSignal,
): Promise<CommandResult> {
  // Pre-abort: a signal already aborted at call time settles 130 before
  // ANY work — no expansion leak, no runtime composition, no HTTP.
  if (signal?.aborted) throw new ComparisonInterruptedError("before any work");

  // Secret basis captured ONCE from the SUPPLIED host (env shallow copy
  // + host.secrets + configuredSecrets). The same captured env and
  // merged basis ride an invocation-OWNED host into the shared runtime,
  // so the shared projection's own redaction covers env credentials in
  // the nested envelope; later caller mutation of host.env/host.secrets
  // cannot change either layer.
  const basis = captureSecretBasis(host);
  const ownedHost = { ...host, env: basis.env, secrets: basis.host };

  // Preflight + expansion + engine compile BEFORE any runtime work.
  // Identifiers are screened against the captured host basis now; the
  // runtime's own secrets join the basis again before delivery.
  const expanded = expandComparison(input, basis.host);
  assertPublishableIdentifiers(expanded, {}, [], basis.host, "preflight");
  assertStableObjectKeys(expanded, basis.host);

  let run: Awaited<ReturnType<typeof executeComparisonRun>>;
  try {
    // NO whole-run race: setup stages are raced by the shared seam, and
    // once dispatches are entered the await keeps the engine's settled
    // cancellation ledger (evidence + accounting) for the 130 exit.
    run = await executeComparisonRun(expanded, deps, ownedHost, signal);
  } catch (error) {
    // Narrow normalization: ONLY an AbortError that actually escaped
    // while the signal is aborted becomes the owned 130 — every other
    // error (shared 130 settlements included, which already carry
    // exitCode 130) surfaces exactly as itself.
    if (signal?.aborted === true && isAbortError(error)) {
      throw new ComparisonInterruptedError("while setup was pending");
    }
    throw error;
  }

  // Full basis (captured host basis ∪ runtime secrets) governs
  // comparison-owned metadata; the engine envelope is already redacted
  // on the same host basis (via the owned host) plus runtime secrets,
  // and is embedded byte-for-byte after integrity verification.
  const merged = basis.withRuntime(run.secrets);
  assertPublishableIdentifiers(expanded, run.value.rows, Object.keys(run.value.provenance), merged, "delivery");

  const engineEnvelope = (run.projected as { data: Record<string, unknown> }).data;

  // Run control tokens come from the RAW typed engine state, never the
  // redacted envelope: a basis secret matching "complete"/"partial"/
  // "semantic"/"deterministic-only" could otherwise rewrite the
  // delivered copy and silently flip the exit code. The raw values are
  // literal-checked (fail closed on anything unexpected) and SCREENED
  // against the full basis — a match is a static no-echo rejection, so
  // a secret-shaped control token is never delivered and never decides
  // the exit.
  const rawStatus = run.value.rawStatus;
  const rawAssessment = run.value.rawAssessment;
  if (rawStatus !== "complete" && rawStatus !== "partial") {
    throw new ValidationError(
      "engine run state carries an unrecognized status token — refusing to derive the comparison outcome from it.",
    );
  }
  if (rawAssessment !== "semantic" && rawAssessment !== "deterministic-only") {
    throw new ValidationError(
      "engine run state carries an unrecognized assessment token — refusing to derive the comparison outcome from it.",
    );
  }
  {
    const secrets = [...merged];
    for (const token of [rawStatus, rawAssessment]) {
      if (redactSecrets(token, secrets) !== token) {
        throw new ValidationError(
          "run control token is not publishable under the run's secret basis (a declared secret matches a status/assessment token) — rejected before delivery.",
          "Control tokens decide the exit code and are never rewritten; remove the credential material from the basis or rename nothing — choose a different secret value.",
        );
      }
    }
  }
  verifyEngineDisplayIntegrity(engineEnvelope);

  const redactedFrame = Object.fromEntries(
    Object.entries(expanded.frame).map(([key, value]) => [key, redactSecrets(value, merged) as string]),
  );
  const redactedProvenance = Object.fromEntries(
    Object.entries(run.value.provenance).map(([id, record]) => [
      id,
      redactSecrets(record, merged) as EvidenceServeProvenance,
    ]),
  );
  const matrix: ComparisonMatrix = {
    kind: "evidence-comparison",
    schemaVersion: 1,
    status: rawStatus,
    assessment: rawAssessment,
    question: redactSecrets(expanded.question, merged) as string,
    frame: redactedFrame,
    cells: redactComparisonCells(run.value.rows, merged),
    evidenceProvenance: redactedProvenance,
    engine: engineEnvelope,
  };
  // Hash the FINAL delivered form — after metadata redaction, never before.
  const resultSha256 = sha256Hex(JSON.stringify(matrix));
  // Exit derives from the RAW typed status — never the redacted copy.
  return {
    kind: "data",
    data: { ...matrix, resultSha256 },
    exitCode: run.interrupted ? 130 : rawStatus === "complete" ? 0 : 1,
  };
}

/** AbortError shape test (name-based, like the shared seam's own races). */
function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/** The engine run through the shared seam; `value` carries this lane's
 *  projections built INSIDE the run (pre-redaction provenance join,
 *  cells) plus the RAW typed run state (status/assessment, read from the
 *  engine result BEFORE any projection redacts anything). */
async function executeComparisonRun(
  expanded: ExpandedComparison,
  deps: InvestigateRequirementsDeps,
  host: Parameters<typeof withRequirementsRuntime>[2],
  signal?: AbortSignal,
): Promise<{
  projected: CommandResult;
  secrets: readonly string[];
  interrupted: boolean;
  value: {
    rows: Record<string, ComparisonCellResult>;
    provenance: Record<string, EvidenceServeProvenance>;
    rawStatus: LeanResult["status"];
    rawAssessment: LeanResult["assessment"];
  };
}> {
  return withRequirementsRuntime(
    expanded.contractInput,
    deps,
    host,
    async (contract, unified, _observation, _judgeDescriptor, readProvenance) => {
      const result = await runLeanInvestigation(contract, unified);
      return {
        result,
        value: {
          rows: projectCells(expanded, result),
          provenance: joinServeProvenance(result, readProvenance?.()),
          rawStatus: result.status,
          rawAssessment: result.assessment,
        },
      };
    },
    signal,
  );
}
