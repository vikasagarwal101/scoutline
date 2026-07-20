/**
 * Compiled MiniMax specialized-vision conformance registry (DESIGN.md §15,
 * phases/05-specialized-vision.md P5-02).
 *
 * This module is the single source of truth for which specialized
 * MiniMax Vision operations are supported at runtime. Help text, doctor
 * `sharedCapabilities`, MiniMax descriptor capability metadata, and the
 * Adapter support check all derive from this registry through the two
 * pure queries below. There is no environment override and no runtime
 * filesystem lookup.
 *
 * Boundary rules:
 *   - Pure module: no `process.env`, no I/O, no Provider calls.
 *   - Imports only the compiled revisions map, the compiled attestation
 *     manifest, and the shared capability type. It does not import the
 *     MiniMax Adapter, the Vision command, the doctor command, or any
 *     Provider transport.
 *   - The registry is built once at module load from immutable sources
 *     and frozen; support queries are pure functions over that snapshot.
 *
 * Support contract (DESIGN.md §15):
 *   `isMiniMaxVisionOperationSupported(op)` is true iff every condition
 *   holds:
 *     1. `op` is one of the five specialized operations
 *        (`ui-artifact`, `extract-text`, `diagnose-error`, `diagram`,
 *        `chart`); `interpret-image`, `diff`, and `video` are not
 *        registry entries.
 *     2. The entry's `offline` state is `"pass"`.
 *     3. The entry's `live` state is `"pass"`.
 *     4. A compiled attestation exists whose `operation` matches.
 *     5. The attestation's `fixtureVersion` equals the entry's
 *        `fixtureVersion`.
 *     6. The attestation's `implementationId` equals the entry's
 *        `implementationId` (which equals
 *        {@link MINIMAX_VISION_IMPLEMENTATION_ID}).
 *     7. The attestation's `mappingRevision` equals the entry's
 *        `mappingRevision` (sourced from `vision-revisions.ts`).
 *     8. Every entry in `attestation.assertions` has `passed: true`.
 *
 * At P5-02 every entry begins `pending/pending` with no attestation,
 * so every specialized operation is unsupported. P5-03 flips entries
 * to `pass/pass` and appends sanitized attestations one at a time.
 */

import type { VisionOperation } from "../../capabilities/vision.js";
import { MINIMAX_VISION_MAPPING_REVISIONS } from "./vision-revisions.js";
import { MINIMAX_VISION_ATTESTATIONS } from "./vision-attestations.js";

// ---------------------------------------------------------------------------
// Public types (DESIGN.md §15 — copied exactly)
// ---------------------------------------------------------------------------

/**
 * Conformance state for an offline or live test leg. `pending` means
 * the test has not been run; `pass` means it has run and the operation
 * is eligible for support; `fail` means it ran and the semantics did
 * not hold.
 */
export type ConformanceState = "pending" | "pass" | "fail";

/**
 * A specialized MiniMax Vision operation id. `interpret-image`, `diff`,
 * and `video` are excluded by design: `interpret-image` is supported
 * unconditionally by the MiniMax Adapter, and `diff`/`video` remain
 * Z.AI-only (DESIGN.md §15).
 */
export type SpecializedVisionOperation = Exclude<
  VisionOperation,
  "interpret-image" | "diff" | "video"
>;

/**
 * Sanitized attestation shape (DESIGN.md §15). Attestations contain
 * ONLY these fields and never include returned prose, credentials,
 * URLs with credentials, headers, raw response bodies, local paths,
 * or stacks.
 */
export interface VisionAttestation {
  readonly schemaVersion: 1;
  readonly provider: "minimax";
  readonly operation: SpecializedVisionOperation;
  readonly fixtureVersion: number;
  readonly implementationId: string;
  readonly mappingRevision: string;
  readonly testedAt: string;
  readonly resultDigest: string;
  readonly assertions: readonly { id: string; passed: true }[];
}

/**
 * A registry entry. Each immutable entry contains the fixture version,
 * the current Implementation identity, the generated mapping revision,
 * the offline/live conformance states, and an optional compiled
 * attestation attached at registry assembly time.
 */
export interface VisionConformanceEntry {
  readonly fixtureVersion: number;
  readonly implementationId: string;
  readonly mappingRevision: string;
  readonly offline: ConformanceState;
  readonly live: ConformanceState;
  readonly attestation?: VisionAttestation;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The Implementation identity for the direct MiniMax Vision transport
 * maintained by Scoutline itself (Phase B — critique C3). The previous
 * SDK-backed identity (`mmx-cli-sdk@1.0.16`) pinned the bundled
 * `mmx-cli` runtime; this release replaces it with Scoutline's
 * maintained direct transport. Changing this value (e.g. swapping
 * transports again) invalidates every attestation until each mapping is
 * re-attested (DESIGN.md §17).
 */
export const MINIMAX_VISION_IMPLEMENTATION_ID = "scoutline-direct@0.5.0";

/**
 * The five specialized MiniMax Vision operations governed by this
 * registry, in stable canonical order. `interpret-image`, `diff`, and
 * `video` are deliberately absent.
 */
export const SPECIALIZED_VISION_OPERATIONS = [
  "ui-artifact",
  "extract-text",
  "diagnose-error",
  "diagram",
  "chart",
] as const;

/**
 * Readonly set form of {@link SPECIALIZED_VISION_OPERATIONS} for fast
 * membership checks. Used by the Adapter and by the support query.
 */
export const SPECIALIZED_VISION_OPERATION_SET: ReadonlySet<SpecializedVisionOperation> = new Set(
  SPECIALIZED_VISION_OPERATIONS,
);

/**
 * States considered valid for an entry's offline or live leg. Any
 * other string makes the entry invalid.
 */
const VALID_CONFORMANCE_STATES: ReadonlySet<string> = new Set(["pending", "pass", "fail"]);

// ---------------------------------------------------------------------------
// Source-of-truth: hand-authored per-operation state
// ---------------------------------------------------------------------------

/**
 * Per-operation hand-authored source. P5-02 leaves every entry
 * `pending/pending`. P5-03a–P5-03e flip individual entries to
 * `pass/pass` after each operation's mapping Module and sanitized
 * attestation land.
 *
 * `fixtureVersion` mirrors the version recorded in
 * `tests/fixtures/vision/specialized-cases.json` for that operation.
 * Bumping a fixture version here AND in the JSON requires re-attesting
 * the operation; the support query refuses mismatched versions.
 */
interface VisionConformanceSource {
  readonly fixtureVersion: number;
  readonly offline: ConformanceState;
  readonly live: ConformanceState;
}

const MINIMAX_VISION_CONFORMANCE_SOURCE: Readonly<
  Record<SpecializedVisionOperation, VisionConformanceSource>
> = Object.freeze({
  // P5-03a: ui-artifact offline conformance proven; live remains pending
  // until the opt-in live attestation script runs with credentials.
  "ui-artifact": { fixtureVersion: 1, offline: "pass", live: "pass" },
  // P5-03b: extract-text offline conformance proven; live pending.
  "extract-text": { fixtureVersion: 1, offline: "pass", live: "pending" },
  // P5-03c: diagnose-error offline conformance proven; live pending.
  "diagnose-error": { fixtureVersion: 1, offline: "pass", live: "pass" },
  // P5-03d: diagram offline conformance proven; live pending.
  diagram: { fixtureVersion: 1, offline: "pass", live: "pending" },
  // P5-03e: chart offline conformance proven; live pending.
  chart: { fixtureVersion: 1, offline: "pass", live: "pending" },
});

// ---------------------------------------------------------------------------
// Registry assembly (module load; pure; frozen)
// ---------------------------------------------------------------------------

/**
 * Build the immutable registry by joining the hand-authored source
 * with the generated mapping revisions and the compiled attestation
 * manifest. Exactly one entry per specialized operation. The result
 * is deeply frozen and indexed by operation.
 *
 * Attestations are matched by `operation`; if multiple attestations
 * share an operation (a malformed manifest), the first wins and later
 * duplicates are ignored. The support query performs the strict
 * validation, so a mismatched attestation (wrong version, wrong
 * implementation, etc.) is harmless to the registry shape — it simply
 * fails the support contract.
 */
function buildRegistry(): Readonly<Record<SpecializedVisionOperation, VisionConformanceEntry>> {
  const attestationByOp = new Map<SpecializedVisionOperation, VisionAttestation>();
  for (const att of MINIMAX_VISION_ATTESTATIONS) {
    if (
      typeof att === "object" &&
      att !== null &&
      typeof att.operation === "string" &&
      SPECIALIZED_VISION_OPERATION_SET.has(att.operation as SpecializedVisionOperation) &&
      !attestationByOp.has(att.operation as SpecializedVisionOperation)
    ) {
      attestationByOp.set(att.operation as SpecializedVisionOperation, att);
    }
  }

  const registry = {} as Record<SpecializedVisionOperation, VisionConformanceEntry>;
  for (const op of SPECIALIZED_VISION_OPERATIONS) {
    const source = MINIMAX_VISION_CONFORMANCE_SOURCE[op];
    const mappingRevision = MINIMAX_VISION_MAPPING_REVISIONS[op];
    const entry: VisionConformanceEntry = {
      fixtureVersion: source.fixtureVersion,
      implementationId: MINIMAX_VISION_IMPLEMENTATION_ID,
      mappingRevision,
      offline: source.offline,
      live: source.live,
    };
    const attestation = attestationByOp.get(op);
    if (attestation !== undefined) {
      (entry as { attestation?: VisionAttestation }).attestation = attestation;
    }
    Object.freeze(entry);
    registry[op] = entry;
  }
  return Object.freeze(registry);
}

/**
 * The immutable MiniMax specialized-vision conformance registry. Pure
 * snapshot; reading it performs no Provider call and inspects no
 * environment value.
 */
export const MINIMAX_VISION_CONFORMANCE_REGISTRY: Readonly<
  Record<SpecializedVisionOperation, VisionConformanceEntry>
> = buildRegistry();

// ---------------------------------------------------------------------------
// Pure validation helpers
// ---------------------------------------------------------------------------

/**
 * Validate a candidate registry against the structural contract. Used
 * by tests to prove invariants: the production registry is built from
 * frozen sources and is always valid. Returns a list of human-readable
 * errors; an empty list means the candidate is structurally valid.
 *
 * Validation rules:
 *   - Exactly the five specialized operation keys are present.
 *   - `diff`, `video`, and `interpret-image` never appear.
 *   - `offline` and `live` are each one of `pending|pass|fail`.
 *   - `fixtureVersion` is a positive integer.
 *   - `implementationId` equals {@link MINIMAX_VISION_IMPLEMENTATION_ID}.
 *   - `mappingRevision` is a non-empty string.
 *   - If an attestation is present, it may NOT be attached to an entry
 *     whose `live` state is not `pass` (an attestation is the proof of
 *     a passing live run).
 *
 * NOTE: this function intentionally does NOT cross-check the
 * attestation's `mappingRevision` against the generated revisions map
 * or its `implementationId` against the constant; those checks are the
 * `isMiniMaxVisionOperationSupported` query's job. The validator only
 * checks structural integrity of a candidate registry. Tests that need
 * to assert the attestation/revision match semantics use the support
 * query directly.
 */
export function validateConformanceRegistry(
  candidate: Readonly<Record<string, unknown>>,
): string[] {
  const errors: string[] = [];

  if (!candidate || typeof candidate !== "object") {
    return ["registry must be an object"];
  }

  const seen = new Set<string>();
  for (const key of Object.keys(candidate)) {
    seen.add(key);
    if (key === "diff" || key === "video") {
      errors.push(`forbidden key: ${key} never enters the specialized registry`);
      continue;
    }
    if (key === "interpret-image") {
      errors.push(
        "forbidden key: interpret-image is supported unconditionally and is not a registry entry",
      );
      continue;
    }
    if (!SPECIALIZED_VISION_OPERATION_SET.has(key as SpecializedVisionOperation)) {
      errors.push(`unknown key: ${key}`);
      continue;
    }
    const entry = candidate[key];
    if (!entry || typeof entry !== "object") {
      errors.push(`entry ${key} must be an object`);
      continue;
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.fixtureVersion !== "number" || !Number.isInteger(e.fixtureVersion)) {
      errors.push(`entry ${key} fixtureVersion must be an integer`);
    } else if (e.fixtureVersion <= 0) {
      errors.push(`entry ${key} fixtureVersion must be positive, got ${e.fixtureVersion}`);
    }
    if (typeof e.implementationId !== "string" || e.implementationId.length === 0) {
      errors.push(`entry ${key} implementationId must be a non-empty string`);
    } else if (e.implementationId !== MINIMAX_VISION_IMPLEMENTATION_ID) {
      errors.push(
        `entry ${key} implementationId must equal ${MINIMAX_VISION_IMPLEMENTATION_ID}, got ${e.implementationId}`,
      );
    }
    if (typeof e.mappingRevision !== "string" || e.mappingRevision.length === 0) {
      errors.push(`entry ${key} mappingRevision must be a non-empty string`);
    }
    if (typeof e.offline !== "string" || !VALID_CONFORMANCE_STATES.has(e.offline)) {
      errors.push(`entry ${key} offline state invalid: ${String(e.offline)}`);
    }
    if (typeof e.live !== "string" || !VALID_CONFORMANCE_STATES.has(e.live)) {
      errors.push(`entry ${key} live state invalid: ${String(e.live)}`);
    }
    if (e.attestation !== undefined) {
      if (e.live !== "pass") {
        errors.push(
          `entry ${key} carries an attestation but live state is ${String(e.live)} (must be pass)`,
        );
      }
    }
  }

  for (const op of SPECIALIZED_VISION_OPERATIONS) {
    if (!seen.has(op)) {
      errors.push(`missing key: ${op}`);
    }
  }

  return errors;
}

/**
 * Validate a candidate attestation against the schema contract.
 * Returns a list of human-readable errors; an empty list means the
 * attestation is structurally valid. Used by tests to prove the
 * support contract fails closed on malformed attestations.
 */
export function validateAttestation(candidate: unknown): string[] {
  const errors: string[] = [];
  if (!candidate || typeof candidate !== "object") {
    return ["attestation must be an object"];
  }
  const a = candidate as Record<string, unknown>;
  if (a.schemaVersion !== 1) {
    errors.push(`attestation schemaVersion must be 1, got ${String(a.schemaVersion)}`);
  }
  if (a.provider !== "minimax") {
    errors.push(`attestation provider must be minimax, got ${String(a.provider)}`);
  }
  if (typeof a.operation !== "string") {
    errors.push("attestation operation must be a string");
  } else if (!SPECIALIZED_VISION_OPERATION_SET.has(a.operation as SpecializedVisionOperation)) {
    errors.push(`attestation operation must be a specialized op, got ${a.operation}`);
  }
  if (
    typeof a.fixtureVersion !== "number" ||
    !Number.isInteger(a.fixtureVersion) ||
    a.fixtureVersion <= 0
  ) {
    errors.push(
      `attestation fixtureVersion must be a positive integer, got ${String(a.fixtureVersion)}`,
    );
  }
  if (typeof a.implementationId !== "string" || a.implementationId.length === 0) {
    errors.push("attestation implementationId must be a non-empty string");
  }
  if (typeof a.mappingRevision !== "string" || a.mappingRevision.length === 0) {
    errors.push("attestation mappingRevision must be a non-empty string");
  }
  if (typeof a.testedAt !== "string" || a.testedAt.length === 0) {
    errors.push("attestation testedAt must be a non-empty string");
  }
  if (typeof a.resultDigest !== "string" || a.resultDigest.length === 0) {
    errors.push("attestation resultDigest must be a non-empty string");
  }
  if (!Array.isArray(a.assertions) || a.assertions.length === 0) {
    errors.push("attestation assertions must be a non-empty array");
  } else {
    const ids = new Set<string>();
    for (const item of a.assertions) {
      if (!item || typeof item !== "object") {
        errors.push("attestation assertion must be an object");
        continue;
      }
      const r = item as Record<string, unknown>;
      if (typeof r.id !== "string" || r.id.length === 0) {
        errors.push("attestation assertion id must be a non-empty string");
        continue;
      }
      if (ids.has(r.id)) {
        errors.push(`attestation assertion duplicate id: ${r.id}`);
        continue;
      }
      ids.add(r.id);
      if (r.passed !== true) {
        errors.push(`attestation assertion ${r.id} must have passed: true`);
      }
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Pure support + metadata queries
// ---------------------------------------------------------------------------

/**
 * Options for {@link isMiniMaxVisionOperationSupported}. Tests pass a
 * synthetic `registry` and `attestations` to exercise pending/pass/fail
 * combinations without mutating compiled sources. Production calls
 * with no options; the compiled registry and manifest are used.
 */
export interface MiniMaxVisionSupportOptions {
  readonly registry?: Readonly<Record<SpecializedVisionOperation, VisionConformanceEntry>>;
  readonly revisions?: Readonly<Record<SpecializedVisionOperation, string>>;
  readonly implementationId?: string;
}

/**
 * Return true iff `operation` is currently a supported MiniMax
 * specialized Vision operation, per DESIGN.md §15. Pure: no Provider
 * call, no env read, no I/O. `interpret-image`, `diff`, and `video`
 * always return false (they are not registry entries).
 */
export function isMiniMaxVisionOperationSupported(
  operation: VisionOperation,
  options: MiniMaxVisionSupportOptions = {},
): boolean {
  if (!SPECIALIZED_VISION_OPERATION_SET.has(operation as SpecializedVisionOperation)) {
    return false;
  }
  const op = operation as SpecializedVisionOperation;
  const registry = options.registry ?? MINIMAX_VISION_CONFORMANCE_REGISTRY;
  const revisions = options.revisions ?? MINIMAX_VISION_MAPPING_REVISIONS;
  const implementationId = options.implementationId ?? MINIMAX_VISION_IMPLEMENTATION_ID;

  const entry = registry[op];
  if (!entry) return false;
  if (entry.offline !== "pass" || entry.live !== "pass") return false;

  const attestation = entry.attestation;
  if (!attestation) return false;

  // Strict attestation match. Every field that the registry records
  // for this operation must agree with the attestation.
  if (attestation.operation !== op) return false;
  if (attestation.fixtureVersion !== entry.fixtureVersion) return false;
  if (attestation.implementationId !== entry.implementationId) return false;
  if (attestation.implementationId !== implementationId) return false;
  if (attestation.mappingRevision !== entry.mappingRevision) return false;
  if (attestation.mappingRevision !== revisions[op]) return false;
  if (attestation.schemaVersion !== 1) return false;
  if (attestation.provider !== "minimax") return false;

  const assertions = attestation.assertions;
  if (!Array.isArray(assertions) || assertions.length === 0) return false;
  for (const a of assertions) {
    if (!a || a.passed !== true) return false;
  }
  return true;
}

/**
 * Return a snapshot of every specialized operation's registry entry.
 * The returned record is the same frozen object as the compiled
 * registry; callers MUST NOT mutate it. Use this for help text,
 * diagnostics, and packaging tests so there is a single source of
 * truth for registry metadata.
 */
export function getMiniMaxVisionConformanceMetadata(): Readonly<
  Record<SpecializedVisionOperation, VisionConformanceEntry>
> {
  return MINIMAX_VISION_CONFORMANCE_REGISTRY;
}

/**
 * Return the subset of specialized operations currently supported by
 * the MiniMax Vision conformance registry, in canonical order. Used by
 * the Adapter descriptor, Vision help, and doctor `sharedCapabilities`
 * so they all derive from a single query.
 */
export function listSupportedMiniMaxVisionOperations(): readonly SpecializedVisionOperation[] {
  return SPECIALIZED_VISION_OPERATIONS.filter((op) => isMiniMaxVisionOperationSupported(op));
}
