/**
 * Evidence-backed implementation audit — first-slice consumer
 * (docs/plans/v3/05-evidence-backed-implementation-audit.md,
 * FIRST-SLICE.json acceptance cases; review-repair round 1).
 *
 * Assesses a short, explicit, caller-supplied claim set against named
 * files of ONE immutable repository revision. This slice audits LITERAL
 * PREDICATES only: a "literal" claim is accepted when every declared
 * literal is present in its declared pinned file. Literal presence does
 * not establish active code, public reachability or runtime behavior —
 * comments and string data can match literals — so "reachability" and
 * "runtime" claims always project unresolved. The audit executes no
 * repository content, performs no network access and runs no behavioral
 * probes; all acquisition is fixture-injected through LeanDeps.
 *
 * Trust posture (review f4b5e545): the consumer requires EXACT revision
 * agreement between the claim set and the snapshot before anything is
 * acquired, materializes its own frozen copy of the claim-relevant
 * fixture bytes with consumer-computed digests (a caller-declared digest
 * verifies byte consistency, never commit membership — that limitation is
 * disclosed, not hidden), and refuses any acquisition outside the pinned
 * revision.
 *
 * Engine boundary (PREPARATION.md): claim mapping, revision binding and
 * proof-class admission are consumer policy here; bounded acquisition,
 * retention, judgment dispatch, acceptance and stopping belong to the
 * shared lean investigation engine, which this consumer drives unchanged.
 * Review fix2: every count/entry/byte bound (AUDIT_CEILINGS) is enforced
 * BEFORE any snapshot walking, copying or hashing; acquisition is scoped
 * per claim through the engine's exported frozen query plan (never by
 * re-encoding engine-private query formatting); revisions use the full
 * canonical 40/64 lowercase-hex shape and the snapshot URL scheme owns its
 * reversibility invariant. The open SHARED closed-source coverage gate is
 * documented in report coverageNotes.
 */
import { createHash } from "node:crypto";
import {
  runLeanInvestigation,
  compileLeanContract,
  frozenLeanQueryPlan,
  LEAN_LIMIT_CEILINGS,
  type LeanDeps,
  type LeanResult,
} from "./lean-investigation.js";
import { ValidationError } from "./errors.js";

// ---------------------------------------------------------------------------
// Bounded-audit ceilings — every bound is enforced BEFORE any snapshot
// walking, copying or hashing (review fix2: engine limits must not start
// only once the engine runs). Engine-mirrored values derive from the
// engine's own exported ceilings so they cannot drift.
// ---------------------------------------------------------------------------
export const AUDIT_CEILINGS = Object.freeze({
  /** Engine field ceiling: one claim = one engine requirement. */
  maxClaims: LEAN_LIMIT_CEILINGS.maxFields,
  /** Relevant unique paths must fit the engine's default read budget. */
  maxRelevantPaths: LEAN_LIMIT_CEILINGS.maxUniqueReads,
  /** Per relevant file: the engine's per-document evidence byte cap. */
  maxFileBytes: LEAN_LIMIT_CEILINGS.maxEvidenceBytesPerDoc,
  /** Aggregate relevant bytes: the engine's total evidence byte cap. */
  maxTotalRelevantBytes: LEAN_LIMIT_CEILINGS.maxTotalEvidenceBytes,
  /** Consumer-owned metadata ceilings (review fix3: cheap COUNT and
   * code-unit caps enforced BEFORE any validation scan, copy or hash, so
   * unbounded metadata can never inflate queries, logs or reports). */
  maxSnapshotEntries: 64,
  maxChecksPerClaim: 6,
  maxLiteralsPerCheck: 8,
  maxCriteriaPerClaim: 8,
  maxClaimTextChars: 512,
  maxCriterionChars: 256,
  maxLiteralChars: 256,
  maxPathSegments: 12,
  /** Cheap total-length gate enforced BEFORE any split/regex/scan (fix4):
   * the legal maximum is 12 segments of ≤100 chars joined by "/" slashes. */
  maxPathChars: 12 * 101,
});

// ---------------------------------------------------------------------------
// Claim set (caller input)
// ---------------------------------------------------------------------------

/** One deterministic literal-presence obligation on a named pinned file. */
export interface AuditSourceCheck {
  /** Repository-relative path: no leading "/", no "..", no ":" or "\". */
  readonly path: string;
  /** Distinct literals that must ALL appear in the pinned file's content. */
  readonly allOf: readonly string[];
}

export type AuditProofClass = "literal" | "reachability" | "runtime";

export interface AuditClaim {
  readonly id: string;
  readonly text: string;
  /** "literal" — assessable this slice. "reachability"/"runtime" — never
   * satisfiable from source text here; they project unresolved with an
   * explicit reason while their checks (if any) still surface facts. */
  readonly proofClass: AuditProofClass;
  readonly checks: readonly AuditSourceCheck[];
  readonly criteria?: readonly string[];
}

export interface AuditClaimSet {
  readonly schemaVersion: 1;
  readonly repository: string;
  readonly revision: string;
  readonly claims: readonly AuditClaim[];
}

export interface CompiledAuditClaimSet {
  /** Carried so the compiled form round-trips through compileAuditClaimSet
   * — the exported seam recompiles whatever structurally arrives with the
   * SAME compiler, so there is exactly one admission path for claims too. */
  readonly schemaVersion: 1;
  readonly repository: string;
  readonly revision: string;
  readonly claims: readonly AuditClaim[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

// ---------------------------------------------------------------------------
// ONE address grammar (review fix3): a single component vocabulary shared
// by ADMISSION (compile validators), BUILD (snapshotFileUrl) and PARSE
// (SNAPSHOT_URL). No control characters, no reserved delimiters ("@",
// "%", ":", "\", "/"), no "." / ".." aliases, no abbreviated pins — full
// SHA-1 (40) and SHA-256 (64) lowercase forms only. Every grammar string
// must also be well-formed UTF-16 so no two distinct caller strings can
// hash to the same UTF-8 bytes (lone surrogates mangle to U+FFFD) while
// producing different literal verdicts.
// ---------------------------------------------------------------------------

/** True when the string carries no lone surrogate code units (every high
 * surrogate is immediately followed by its low surrogate). */
function wellFormedUtf16(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = i + 1 < value.length ? value.charCodeAt(i + 1) : 0;
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

const REPOSITORY_GRAMMAR = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const REVISION_GRAMMAR = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const PATH_SEGMENT_GRAMMAR = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const CLAIM_ID_GRAMMAR = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function validRepository(value: unknown): value is string {
  // Cheap total-length gate BEFORE the regex (fix4: no unbounded scan on
  // oversized caller strings). Grammar max is 64 chars.
  return typeof value === "string" && value.length <= 64 && REPOSITORY_GRAMMAR.test(value);
}

function validRevision(value: unknown): value is string {
  // Grammar is fixed-length (40/64), so a length check is the whole cost
  // gate; the regex only ever sees bounded input.
  return typeof value === "string" && (value.length === 40 || value.length === 64) && REVISION_GRAMMAR.test(value);
}

/** Fixed non-echo diagnostic (fix4): names the JS type — and for strings
 * and arrays a bounded SIZE — without echoing caller-controlled content
 * into error messages or logs. Circular or huge malformed values produce
 * a ValidationError, never a JSON.stringify crash or a megabyte message. */
function describeValue(value: unknown): string {
  if (typeof value === "string") return `type string (${value.length} code units)`;
  if (Array.isArray(value)) return `type array (${value.length} entries)`;
  if (value === null) return "type null";
  return `type ${typeof value}`;
}

/** Repository-relative path: 1..maxPathSegments slash-separated segments,
 * each matching the shared segment grammar (charset alone excludes ".",
 * "..", controls and every reserved delimiter). The CHEAP total code-unit
 * cap runs before the split, the well-formedness scan and every segment
 * regex (fix4). */
function validRepoPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length > AUDIT_CEILINGS.maxPathChars) return false;
  if (!wellFormedUtf16(value)) return false;
  const segments = value.split("/");
  if (segments.length === 0 || segments.length > AUDIT_CEILINGS.maxPathSegments) return false;
  return segments.every((segment) => PATH_SEGMENT_GRAMMAR.test(segment));
}

/** Claim ids become engine requirement keys AND the question prefix that
 * guarantees unique rendered queries; bounded, well-formed, reserved-free. */
const RESERVED_IDS = new Set(["__proto__", "constructor", "prototype"]);
function validClaimId(value: unknown): value is string {
  return typeof value === "string" && CLAIM_ID_GRAMMAR.test(value);
}

function decodeChecks(value: unknown, claimId: string, requireNonEmpty: boolean): AuditSourceCheck[] {
  if (value === undefined || (Array.isArray(value) && value.length === 0)) {
    if (requireNonEmpty) {
      throw new ValidationError(
        `claims.${claimId}.checks must be a non-empty array of { path, allOf } literal checks.`,
      );
    }
    return [];
  }
  if (!Array.isArray(value)) {
    throw new ValidationError(
      `claims.${claimId}.checks must be an array of { path, allOf } literal checks.`,
    );
  }
  if (value.length > AUDIT_CEILINGS.maxChecksPerClaim) {
    throw new ValidationError(
      `claims.${claimId}.checks exceeds the per-claim ceiling of ${AUDIT_CEILINGS.maxChecksPerClaim} declared files.`,
    );
  }
  const seenPaths = new Set<string>();
  return value.map((check, index): AuditSourceCheck => {
    if (!isPlainObject(check) || !validRepoPath(check.path)) {
      throw new ValidationError(
        `claims.${claimId}.checks[${index}].path must be a repository-relative path without traversal.`,
      );
    }
    if (seenPaths.has(check.path)) {
      throw new ValidationError(
        `claims.${claimId}.checks declares duplicate path "${check.path}"; ambiguous basis is refused.`,
      );
    }
    seenPaths.add(check.path);
    // COUNT caps BEFORE any per-item scan (review fix3: a malformed item
    // past the cap must never be touched by a validation scan).
    if (!Array.isArray(check.allOf) || check.allOf.length === 0) {
      throw new ValidationError(
        `claims.${claimId}.checks[${index}].allOf must be a non-empty array of non-empty string literals.`,
      );
    }
    if (check.allOf.length > AUDIT_CEILINGS.maxLiteralsPerCheck) {
      throw new ValidationError(
        `claims.${claimId}.checks[${index}].allOf exceeds the per-check ceiling of ${AUDIT_CEILINGS.maxLiteralsPerCheck} clauses.`,
      );
    }
    if (!check.allOf.every((literal) => isNonEmptyString(literal))) {
      throw new ValidationError(
        `claims.${claimId}.checks[${index}].allOf must be a non-empty array of non-empty string literals.`,
      );
    }
    const seenLiterals = new Set<string>();
    for (const literal of check.allOf) {
      if (seenLiterals.has(literal)) {
        throw new ValidationError(
          `claims.${claimId}.checks[${index}].allOf declares duplicate clause ${JSON.stringify(literal)}.`,
        );
      }
      seenLiterals.add(literal);
      if (literal.length > AUDIT_CEILINGS.maxLiteralChars || !wellFormedUtf16(literal)) {
        throw new ValidationError(
          `claims.${claimId}.checks[${index}].allOf clause exceeds ${AUDIT_CEILINGS.maxLiteralChars} code units or is not well-formed UTF-16.`,
        );
      }
    }
    return { path: check.path, allOf: [...check.allOf] };
  });
}

/** Compile + validate the claim set. Throws ValidationError on every
 * malformed shape — unknown proof class, invalid id/revision/path,
 * duplicate paths or clauses — BEFORE any acquisition. */
export function compileAuditClaimSet(input: unknown): CompiledAuditClaimSet {
  if (!isPlainObject(input)) {
    throw new ValidationError("Implementation audit claim set must be a JSON object.");
  }
  if (input.schemaVersion !== 1) {
    throw new ValidationError(
      `schemaVersion must be the number 1 (got ${describeValue(input.schemaVersion)}).`,
    );
  }
  if (!validRepository(input.repository)) {
    throw new ValidationError(
      "repository must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (address-scheme safe).",
    );
  }
  if (!validRevision(input.revision)) {
    throw new ValidationError(
      "revision must be a full canonical commit shape: 40 or 64 lowercase hex characters.",
    );
  }
  if (!Array.isArray(input.claims) || input.claims.length === 0) {
    throw new ValidationError("claims must be a non-empty array.");
  }
  // Field-count ceiling BEFORE any snapshot work: one claim maps to one
  // engine requirement, and the engine's own field ceiling is hard.
  if (input.claims.length > AUDIT_CEILINGS.maxClaims) {
    throw new ValidationError(
      `claims exceeds the engine field ceiling of ${AUDIT_CEILINGS.maxClaims} (got ${input.claims.length}).`,
    );
  }
  const seen = new Set<string>();
  const claims = input.claims.map((claim, index): AuditClaim => {
    if (!isPlainObject(claim)) {
      throw new ValidationError(`claims[${index}] must be an object.`);
    }
    if (!validClaimId(claim.id) || RESERVED_IDS.has(claim.id)) {
      throw new ValidationError(
        `claims[${index}].id must match ${CLAIM_ID_GRAMMAR.source} and not be a reserved key.`,
      );
    }
    if (seen.has(claim.id)) {
      throw new ValidationError(`claims[${index}].id "${claim.id}" is duplicated.`);
    }
    seen.add(claim.id);
    if (!isNonEmptyString(claim.text)) {
      throw new ValidationError(`claims.${claim.id}.text must be a non-empty string.`);
    }
    // Code-unit cap BEFORE any downstream use of the text (it flows into
    // the engine question, the acquisition log and the report projection).
    if (claim.text.length > AUDIT_CEILINGS.maxClaimTextChars || !wellFormedUtf16(claim.text)) {
      throw new ValidationError(
        `claims.${claim.id}.text exceeds ${AUDIT_CEILINGS.maxClaimTextChars} code units or is not well-formed UTF-16.`,
      );
    }
    if (claim.proofClass !== "literal" && claim.proofClass !== "reachability" && claim.proofClass !== "runtime") {
      throw new ValidationError(
        `claims.${claim.id}.proofClass must be "literal", "reachability" or "runtime" (got ${describeValue(claim.proofClass)}).`,
      );
    }
    // COUNT cap before the per-item scan (review fix3).
    if (
      claim.criteria !== undefined &&
      (!Array.isArray(claim.criteria) || claim.criteria.length > AUDIT_CEILINGS.maxCriteriaPerClaim)
    ) {
      throw new ValidationError(
        `claims.${claim.id}.criteria must be an array of at most ${AUDIT_CEILINGS.maxCriteriaPerClaim} strings.`,
      );
    }
    const criteria =
      claim.criteria === undefined
        ? []
        : Array.isArray(claim.criteria) && claim.criteria.every(isNonEmptyString)
          ? claim.criteria.map((criterion) => {
              if (criterion.length > AUDIT_CEILINGS.maxCriterionChars || !wellFormedUtf16(criterion)) {
                throw new ValidationError(
                  `claims.${claim.id}.criteria entry exceeds ${AUDIT_CEILINGS.maxCriterionChars} code units or is not well-formed UTF-16.`,
                );
              }
              return criterion;
            })
          : (() => {
              throw new ValidationError(`claims.${claim.id}.criteria must be strings.`);
            })();
    const checks = decodeChecks(claim.checks, claim.id, claim.proofClass === "literal");
    // OWNED validated state (fix4): the compiled claim set is deep-frozen
    // so no caller — and no mid-run mutation of a caller-held reference —
    // can alter proof-class policy, checks or basis after admission.
    return Object.freeze({
      id: claim.id,
      text: claim.text,
      proofClass: claim.proofClass,
      checks: Object.freeze(
        checks.map((check) =>
          Object.freeze({ path: check.path, allOf: Object.freeze([...check.allOf]) }),
        ),
      ),
      criteria: Object.freeze([...criteria]),
    });
  });
  return Object.freeze({
    schemaVersion: 1 as const,
    repository: input.repository,
    revision: input.revision,
    claims: Object.freeze(claims),
  });
}

// ---------------------------------------------------------------------------
// Pinned snapshot (trusted offline fixture)
// ---------------------------------------------------------------------------

export interface SnapshotFile {
  readonly path: string;
  /** The commit this fixture file's content actually came from. A file
   * whose revision differs from the audit pin is REFUSED at read time. */
  readonly revision: string;
  readonly content: string;
  /** Caller-declared digest. Verified for CONSISTENCY against the content
   * for claim-relevant files before the run; it never proves commit
   * membership — that is a fixture-trust limitation, disclosed in reports. */
  readonly sha256: string;
}

export interface PinnedSnapshot {
  readonly repository: string;
  readonly revision: string;
  readonly files: readonly SnapshotFile[];
}

/** Compile + structurally validate the snapshot. Duplicate file paths are
 * refused (ambiguous provenance). Digest consistency for claim-relevant
 * files is enforced when the read seam materializes its own copy; files
 * the claims never name are neither hashed nor read (bounded). */
export function compilePinnedSnapshot(input: unknown): PinnedSnapshot {
  if (!isPlainObject(input)) {
    throw new ValidationError("Pinned snapshot must be a JSON object.");
  }
  if (!validRepository(input.repository)) {
    throw new ValidationError(
      "Snapshot repository must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (address-scheme safe).",
    );
  }
  if (!validRevision(input.revision)) {
    throw new ValidationError(
      "Snapshot revision must be a full canonical commit shape: 40 or 64 lowercase hex characters.",
    );
  }
  if (!Array.isArray(input.files) || input.files.length === 0) {
    throw new ValidationError("Snapshot files must be a non-empty array.");
  }
  // Entry ceiling BEFORE the walk: a snapshot is bounded metadata, and no
  // per-file work (copy, byte-count or hash) may run on an oversized one.
  if (input.files.length > AUDIT_CEILINGS.maxSnapshotEntries) {
    throw new ValidationError(
      `Snapshot exceeds the entry ceiling of ${AUDIT_CEILINGS.maxSnapshotEntries} files; refusing before any walk, copy or hash.`,
    );
  }
  const seenPaths = new Set<string>();
  const files = input.files.map((file, index): SnapshotFile => {
    const digestOk =
      isPlainObject(file) &&
      typeof file.sha256 === "string" &&
      /^[0-9a-f]{64}$/.test(file.sha256);
    if (
      !isPlainObject(file) ||
      !validRepoPath(file.path) ||
      !validRevision(file.revision) ||
      typeof file.content !== "string" ||
      !digestOk
    ) {
      throw new ValidationError(
        `files[${index}] must carry path, canonical hex revision (40/64 lowercase), content and a 64-hex sha256.`,
      );
    }
    if (seenPaths.has(file.path)) {
      throw new ValidationError(
        `files[${index}] duplicates path "${file.path}"; ambiguous provenance is refused.`,
      );
    }
    seenPaths.add(file.path);
    return {
      path: file.path,
      revision: file.revision,
      content: file.content,
      sha256: file.sha256 as string,
    };
  });
  return { repository: input.repository, revision: input.revision, files };
}

/** Canonical trusted-snapshot URL: the revision is part of the address, so
 * provenance travels with every acquisition and the pin gate is checkable
 * per read. The scheme owns its reversibility invariant: the builder
 * re-parses its own output and refuses any identity whose components do
 * not round-trip exactly (review fix2: one reversible address scheme with
 * its own validation, independent of caller-side charset screens). */
export function snapshotFileUrl(repository: string, revision: string, path: string): string {
  // ONE grammar across admission/build/parse (review fix3): construction
  // validates its components against the SAME predicates admission uses,
  // then asserts its own output round-trips — build can never accept an
  // identity admission would refuse, or vice versa.
  if (!validRepository(repository)) {
    throw new ValidationError("snapshotFileUrl: repository violates the address grammar.");
  }
  if (!validRevision(revision)) {
    throw new ValidationError("snapshotFileUrl: revision must be 40/64 lowercase hex.");
  }
  if (!validRepoPath(path)) {
    throw new ValidationError("snapshotFileUrl: path violates the address grammar.");
  }
  const url = `snapshot://${repository}@${revision}/${path}`;
  const roundTrip = SNAPSHOT_URL.exec(url);
  if (
    roundTrip === null ||
    roundTrip[1] !== repository ||
    roundTrip[2] !== revision ||
    roundTrip[3] !== path
  ) {
    throw new ValidationError(
      "Snapshot URL is not reversible for this identity; components carry reserved characters.",
    );
  }
  return url;
}

const SNAPSHOT_URL = /^snapshot:\/\/([^@]+)@([0-9a-f]+)\/(.+)$/;

export type SnapshotRefusalKind =
  | "revision_mismatch"
  | "unknown_file"
  | "digest_mismatch";

export interface AuditRefusal {
  readonly kind: SnapshotRefusalKind;
  readonly url: string;
  readonly detail: string;
}

/** Typed refusal carried by the trusted read seam: the engine sees a failed
 * read; the audit report sees the exact trust reason. */
export class SnapshotRefusalError extends Error {
  readonly refusal: AuditRefusal;
  constructor(refusal: AuditRefusal) {
    super(`snapshot refusal (${refusal.kind}): ${refusal.detail}`);
    this.name = "SnapshotRefusalError";
    this.refusal = refusal;
  }
}

export interface AuditJournal {
  readonly searches: number;
  readonly reads: number;
  readonly judgeCalls: number;
  readonly verifiedPins: readonly { url: string; path: string; revision: string; sha256: string }[];
  readonly refusals: readonly AuditRefusal[];
  readonly abstentions: readonly { fieldId: string; reason: string }[];
  /** The seam's own frozen verified materialization of claim-relevant
   * files. Powers observation rows for files the engine never retained
   * (e.g. refused at a mismatched revision) — observations, never
   * acceptance evidence. */
  readonly materialized: readonly {
    url: string;
    path: string;
    revision: string;
    sha256: string;
  }[];
}

/** A materialized, frozen, consumer-owned fixture entry. Bytes and digest
 * are the consumer's own verified copy; later mutation of the CALLER's
 * input objects cannot reach what the audit serves. */
interface MaterializedFile {
  readonly url: string;
  readonly path: string;
  readonly revision: string;
  readonly content: string;
  readonly sha256: string;
}

function pathOfUrl(url: string): string | null {
  const match = SNAPSHOT_URL.exec(url);
  return match === null ? null : match[3]!;
}

/** The claim-relevant file paths this audit is entitled to acquire. */
function relevantPaths(claims: CompiledAuditClaimSet): Set<string> {
  const paths = new Set<string>();
  for (const claim of claims.claims) {
    for (const check of claim.checks) paths.add(check.path);
  }
  return paths;
}

/**
 * Build the narrow trusted acquisition surface:
 *
 *  - MATERIALIZATION: the claim-relevant snapshot files are copied once,
 *    digest-verified against their declared digests (consistency only),
 *    given consumer-computed digests and frozen. Unrelated files are never
 *    hashed, indexed or read (bounded index; no budget burn).
 *  - SEARCH: closed-scope index resolution — every engine query resolves
 *    to the claim-relevant file index of the pinned snapshot. This is NOT
 *    remote discovery and is disclosed as such; contrary coverage is
 *    bounded to the closed scope (see report coverageNotes).
 *  - READ: the pin gate — only the pinned revision is admissible, bytes
 *    must still bind the materialized digest, and provenance travels in
 *    the URL.
 *  - JUDGE: deterministic literal assessment with abstention on any
 *    incomplete basis (see below).
 *
 * Throws ValidationError before returning deps if a claim-relevant file's
 * declared digest does not bind its content.
 */
export function createSnapshotReadDeps(
  claims: CompiledAuditClaimSet,
  snapshot: PinnedSnapshot,
): {
  deps: LeanDeps;
  observe: (path: string) => MaterializedFile | null;
  journal: AuditJournal;
} {
  // BOUNDARY PREFLIGHT (review fix4 + fix5 — no call-surface bypass):
  // BOTH parameters are recompiled with the SAME compilers the runner
  // uses, cloned into owned validated state. A structurally constructed
  // CompiledAuditClaimSet is accepted only as RAW INPUT: it is validated
  // (all caps/grammar), deep-frozen and captured here, and every closure
  // below (judge, scoping, contract build) reads the CAPTURED copy — the
  // caller's mutable objects can never alter policy mid-run. The compiled
  // form carries schemaVersion precisely so it round-trips this gate.
  claims = compileAuditClaimSet(claims);
  // A raw structurally-typed snapshot that never went through
  // compilePinnedSnapshot is validated here (entry ceiling, per-file
  // grammar, duplicate paths, digest shape) and CLONED into owned state —
  // there is exactly one admission policy and no way around it. No new
  // API: this reuses compilePinnedSnapshot unchanged.
  snapshot = compilePinnedSnapshot(snapshot);
  // SeAM ADMISSION (review fix3): the exported seam enforces exact
  // repository+revision agreement between the claim set and the snapshot
  // ON ITS OWN — direct callers get the same guarantee the runner has —
  // and captures the validated header ONCE, so later mutation of the
  // caller's PinnedSnapshot object cannot alter the pin gate mid-run.
  if (snapshot.repository !== claims.repository || snapshot.revision !== claims.revision) {
    throw new ValidationError(
      `Snapshot pin (${snapshot.repository}@${snapshot.revision}) does not exactly match the claim set pin (${claims.repository}@${claims.revision}); different revisions must never be conflated.`,
    );
  }
  const pinnedRepository = snapshot.repository;
  const pinnedRevision = snapshot.revision;
  const relevant = relevantPaths(claims);
  // Read-budget cap BEFORE any per-file work: a declared basis the engine
  // could never fully read fails loud and visible, not as mid-run gaps.
  if (relevant.size > AUDIT_CEILINGS.maxRelevantPaths) {
    throw new ValidationError(
      `Declared basis of ${relevant.size} unique files exceeds the read budget of ${AUDIT_CEILINGS.maxRelevantPaths}; the audit cannot establish complete scoped assessment.`,
    );
  }
  const materialized: MaterializedFile[] = [];
  const byPath = new Map<string, MaterializedFile>();
  let totalRelevantBytes = 0;
  for (const file of snapshot.files) {
    if (!relevant.has(file.path)) continue;
    // Byte bounds BEFORE hashing (review fix2: no unbounded hashing).
    // Cheap UTF-16 length gate first (chars <= bytes is guaranteed only in
    // the rejecting direction), then the exact byte count, then hash.
    if (file.content.length > AUDIT_CEILINGS.maxFileBytes) {
      throw new ValidationError(
        `Claim-relevant snapshot file ${file.path} exceeds the per-file byte ceiling of ${AUDIT_CEILINGS.maxFileBytes}.`,
      );
    }
    // Well-formed UTF-16 BEFORE hashing and comparing (review fix3): lone
    // surrogates mangle to U+FFFD in the digest while remaining distinct
    // for includes() — two different verdicts, one hash — so they are
    // refused outright rather than riskily normalized.
    if (!wellFormedUtf16(file.content)) {
      throw new ValidationError(
        `Claim-relevant snapshot file ${file.path} content is not well-formed UTF-16.`,
      );
    }
    const bytes = Buffer.byteLength(file.content, "utf8");
    if (bytes > AUDIT_CEILINGS.maxFileBytes) {
      throw new ValidationError(
        `Claim-relevant snapshot file ${file.path} exceeds the per-file byte ceiling of ${AUDIT_CEILINGS.maxFileBytes}.`,
      );
    }
    totalRelevantBytes += bytes;
    if (totalRelevantBytes > AUDIT_CEILINGS.maxTotalRelevantBytes) {
      throw new ValidationError(
        `Claim-relevant snapshot bytes exceed the aggregate ceiling of ${AUDIT_CEILINGS.maxTotalRelevantBytes}.`,
      );
    }
    const computed = createHash("sha256").update(file.content, "utf8").digest("hex");
    if (computed !== file.sha256) {
      throw new ValidationError(
        `Claim-relevant snapshot file ${file.path} does not bind its declared sha256.`,
      );
    }
    const entry: MaterializedFile = Object.freeze({
      url: snapshotFileUrl(pinnedRepository, file.revision, file.path),
      path: file.path,
      revision: file.revision,
      content: file.content,
      sha256: computed,
    });
    materialized.push(entry);
    byPath.set(file.path, entry);
  }

  // Per-claim acquisition scoping (review fix2 P1, hardened fix3): resolve
  // each engine query to its OWNING claim through the engine's own
  // exported frozen plan — never by re-encoding the engine's private
  // query formatting. Every audit obligation is prefixed with its unique
  // admitted claim ID at contract build, so two distinct claims can never
  // render the same query; a conflicting ownership in the plan is
  // REJECTED loudly rather than silently overwriting (last-writer-wins
  // would let one claim's refused file block another claim's acceptance).
  const queryOwner = new Map<string, string | null>();
  for (const entry of frozenLeanQueryPlan(compileLeanContract(buildEngineContract(claims)))) {
    const previous = queryOwner.get(entry.query);
    if (previous !== undefined && previous !== entry.fieldId) {
      throw new ValidationError(
        `Rendered query collision between claim ids "${previous}" and "${entry.fieldId}"; claim ids must be unique owners of their obligations.`,
      );
    }
    queryOwner.set(entry.query, entry.fieldId);
  }
  const filesOfClaim = (fieldId: string | null): readonly MaterializedFile[] =>
    fieldId === null
      ? materialized
      : materialized.filter((f) => {
          const claim = claims.claims.find((c) => c.id === fieldId);
          return claim !== undefined && claim.checks.some((check) => check.path === f.path);
        });

  let searches = 0;
  let reads = 0;
  let judgeCalls = 0;
  const verifiedPins: { url: string; path: string; revision: string; sha256: string }[] = [];
  const refusals: AuditRefusal[] = [];
  const abstentions: { fieldId: string; reason: string }[] = [];

  const deps: LeanDeps = {
    search: async (query: string) => {
      searches += 1;
      // Closed-scope enumeration, not discovery: the snapshot's
      // claim-relevant files are the complete acquisition universe, scoped
      // to the claim that owns this query.
      if (!queryOwner.has(query)) return [];
      return filesOfClaim(queryOwner.get(query)!).map((f) => ({ url: f.url, title: f.path }));
    },
    read: async (url: string) => {
      reads += 1;
      const match = SNAPSHOT_URL.exec(url);
      // Captured header (fix3): the pin gate reads the values admitted at
      // seam creation, never the live mutable caller object.
      if (match === null || match[1] !== pinnedRepository) {
        const refusal = {
          kind: "unknown_file" as const,
          url,
          detail: "not a snapshot URL for this repository",
        };
        refusals.push(refusal);
        throw new SnapshotRefusalError(refusal);
      }
      const urlRevision = match[2]!;
      const path = match[3]!;
      if (urlRevision !== pinnedRevision) {
        const refusal = {
          kind: "revision_mismatch" as const,
          url,
          detail: `requested revision ${urlRevision} is not the pinned audit revision ${pinnedRevision}`,
        };
        refusals.push(refusal);
        throw new SnapshotRefusalError(refusal);
      }
      // Identity match on BOTH path and revision (review fix2 spoof): an
      // entry whose true revision differs from the addressed revision is
      // NOT served under the addressed revision, even when the pin itself
      // matches — no wrong-commit bytes may ever flow as pinned evidence.
      const file = byPath.get(path);
      if (file === undefined || file.revision !== urlRevision) {
        const refusal = {
          kind: "unknown_file" as const,
          url,
          detail: `no claim-relevant file at ${path} under revision ${urlRevision} in the pinned snapshot index`,
        };
        refusals.push(refusal);
        throw new SnapshotRefusalError(refusal);
      }
      const actual = createHash("sha256").update(file.content, "utf8").digest("hex");
      if (actual !== file.sha256) {
        const refusal = {
          kind: "digest_mismatch" as const,
          url,
          detail: `materialized bytes no longer bind the verified digest for ${path}`,
        };
        refusals.push(refusal);
        throw new SnapshotRefusalError(refusal);
      }
      verifiedPins.push({ url, path, revision: urlRevision, sha256: file.sha256 });
      return file.content;
    },
    // Deterministic literal judge — the consumer's proof-class policy.
    judge: async (input) => {
      judgeCalls += 1;
      const claim = claims.claims.find((c) => c.id === input.fieldId);
      if (claim === undefined || claim.proofClass !== "literal") {
        // Reachability and runtime obligations are never fulfillable by
        // literal presence: abstain on every document (all flags unknown).
        if (claim !== undefined) {
          abstentions.push({
            fieldId: claim.id,
            reason:
              claim.proofClass === "runtime"
                ? "runtime_proof_class_not_admissible_from_static_source"
                : "reachability_not_provable_from_literal_evidence",
          });
        }
        return {
          documents: input.documents.map((doc) => ({
            evidenceId: doc.evidenceId,
            relevant: null,
            supportsClaim: null,
            refutesClaim: null,
          })),
        };
      }
      // LITERAL policy with claim-global conjunction semantics, made
      // flip-safe by completeness gating:
      //
      // ABSTAIN ON INCOMPLETE BASIS (both polarities): while any declared
      // check file is missing from the retained set, every verdict is
      // unknown. Neither support nor refutation may be derived from a
      // partial basis — a missing file must never be masked by another
      // file's failing literals, and an early one-sided verdict must never
      // poison the engine's side history (null -> known is the only
      // transition the engine accepts as progress).
      //
      // ONCE COMPLETE: the acquisition index contains only check-path
      // files, so no NEW basis doc can ever appear — the claim-global
      // conjunction (every check holds across the retained docs) is final
      // and verdicts can never flip. A check-file doc refutes when its own
      // literals are absent; it supports only when the WHOLE conjunction
      // holds (a holding conjunct alone must not manufacture a "disputed"
      // against a failing one — the conjunction is simply refuted).
      const retainedPaths = new Set(input.documents.map((d) => pathOfUrl(d.url)));
      const basisComplete = claim.checks.every((check) => retainedPaths.has(check.path));
      if (!basisComplete) {
        return {
          documents: input.documents.map((doc) => ({
            evidenceId: doc.evidenceId,
            relevant: null,
            supportsClaim: null,
            refutesClaim: null,
          })),
        };
      }
      const conjunctionHolds = claim.checks.every((check) => {
        const doc = input.documents.find((d) => pathOfUrl(d.url) === check.path);
        return doc !== undefined && check.allOf.every((literal) => doc.content.includes(literal));
      });
      return {
        documents: input.documents.map((doc) => {
          const path = pathOfUrl(doc.url);
          const check = claim.checks.find((c) => c.path === path);
          if (check === undefined) {
            // Not a declared basis file for this claim: judges nothing.
            return {
              evidenceId: doc.evidenceId,
              relevant: false,
              supportsClaim: false,
              refutesClaim: false,
            };
          }
          const holds = check.allOf.every((literal) => doc.content.includes(literal));
          return {
            evidenceId: doc.evidenceId,
            relevant: true,
            supportsClaim: conjunctionHolds && holds,
            refutesClaim: !holds,
          };
        }),
      };
    },
    // True monotonic clock: the run's deadline math must reflect real
    // elapsed time, not a frozen instant (budget honesty).
    now: () => performance.now(),
  };
  return {
    deps,
    /** Observation lookup into the seam's own frozen verified copies. */
    observe: (path: string): MaterializedFile | null => byPath.get(path) ?? null,
    journal: {
      get searches() { return searches; },
      get reads() { return reads; },
      get judgeCalls() { return judgeCalls; },
      get verifiedPins() { return verifiedPins; },
      get refusals() { return refusals; },
      get abstentions() { return abstentions; },
      get materialized() {
        return materialized.map((f) => ({
          url: f.url,
          path: f.path,
          revision: f.revision,
          sha256: f.sha256,
        }));
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Engine contract mapping + report projection
// ---------------------------------------------------------------------------

function buildEngineContract(claims: CompiledAuditClaimSet): unknown {
  const requirements: Record<string, unknown> = {};
  for (const claim of claims.claims) {
    const files = claim.checks.map((c) => c.path).join(", ");
    // UNIQUE claim-ID PREFIX (review fix3): every audit obligation renders
    // a question distinct from every other claim's, so duplicate claim
    // text or identical rendered bases can never collide in the engine's
    // query plan. Claim ids are grammar-bounded and unique at admission,
    // making the rendered question a collision-free obligation address.
    requirements[claim.id] = {
      question: `[audit:${claim.id}] ${claim.text} (proof class: ${claim.proofClass}${files === "" ? "" : `; declared literal basis: ${files}`})`,
      schema: { enum: ["supported", "refuted", "disputed"] },
      required: true,
      criteria: claim.criteria,
    };
  }
  return {
    schemaVersion: 1,
    question: `Assess the declared literal implementation predicates for ${claims.repository} at revision ${claims.revision}.`,
    scope: { repository: claims.repository, revision: claims.revision },
    requirements,
    evidence: {
      criteria: [
        "Evidence must be acquired from the pinned snapshot revision only.",
        "Literal findings are bounded to each claim's declared files; they are not whole-repository absence proofs.",
      ],
    },
  };
}

export interface AuditLiteralMatch {
  readonly literal: string;
  readonly charRange: readonly [number, number];
}

export interface AuditBasisRow {
  readonly path: string;
  /** True when the ENGINE retained this file as assessed evidence. */
  readonly retained: boolean;
  readonly revision: string | null;
  readonly sha256: string | null;
  readonly matched: readonly AuditLiteralMatch[];
  readonly missing: readonly string[];
  /** Present when the file was NOT engine-retained but the seam holds its
   * own verified materialization (e.g. refused at a mismatched revision):
   * a preserved literal OBSERVATION with exact locators, clearly not
   * acceptance evidence. */
  readonly observed?: {
    readonly revision: string;
    readonly sha256: string;
    readonly matched: readonly AuditLiteralMatch[];
    readonly missing: readonly string[];
  };
}

export interface AuditClaimResult {
  readonly id: string;
  readonly text: string;
  readonly proofClass: AuditProofClass;
  /** "supported"/"refuted"/"disputed" are LITERAL-PREDICATE outcomes from
   * the engine's acceptance path; they assert literal presence/absence at
   * the pinned revision and nothing more. */
  readonly status: "supported" | "refuted" | "disputed" | "unresolved";
  /** Consumer-owned unresolved cause (revision_mismatch:<path>,
   * digest_mismatch:<path>, unknown_file:<path>, missing_evidence:<path>,
   * reachability_not_provable_from_literal_evidence,
   * no_authorized_runtime_probe) or the engine's own terminal reason. */
  readonly unresolvedReason?: string;
  /** The engine's own terminal state for this claim, unmodified. */
  readonly engine: {
    readonly status: string;
    readonly value?: string;
    readonly reason?: string;
    readonly judgmentCount: number;
    readonly inconsistentJudgments: number;
  };
  readonly basis: readonly AuditBasisRow[];
}

export interface AuditReport {
  readonly schemaVersion: 1;
  readonly repository: string;
  readonly revision: string;
  readonly status: "complete" | "partial";
  readonly assessment: "semantic" | "deterministic-only";
  readonly claims: readonly AuditClaimResult[];
  readonly evidence: readonly {
    evidenceId: string;
    url: string;
    path: string;
    revision: string;
    sha256: string;
    byteLength: number;
  }[];
  readonly refusals: readonly AuditRefusal[];
  readonly abstentions: readonly { fieldId: string; reason: string }[];
  readonly acquisitionLog: readonly { kind: string; detail: string; at: number }[];
  readonly usage: LeanResult["usage"];
  readonly coverageNotes: readonly string[];
}

/** Frozen literal-match locator (report-internal owned data; PR #304
 * thread 2: nested report data must be as immutable as the rows holding
 * it, without freezing caller- or engine-owned objects). */
function frozenMatches(
  pairs: readonly { literal: string; charRange: readonly [number, number] }[],
): readonly AuditLiteralMatch[] {
  return Object.freeze(
    pairs.map((m): AuditLiteralMatch => {
      const range: readonly [number, number] = [m.charRange[0], m.charRange[1]];
      return Object.freeze({ literal: m.literal, charRange: Object.freeze(range) });
    }),
  );
}

function basisFor(
  claim: AuditClaim,
  result: LeanResult,
  observe: (path: string) => MaterializedFile | null,
): AuditBasisRow[] {
  return claim.checks.map((check): AuditBasisRow => {
    const record = result.evidence.find((e) => pathOfUrl(e.url) === check.path);
    if (record === undefined) {
      // Not engine-retained: preserve the seam's own verified observation
      // when it holds a materialized copy — with exact locators, its true
      // revision and a clear observation-only status. Never acceptance.
      const own = observe(check.path);
      const observed =
        own === null
          ? undefined
          : Object.freeze({
              revision: own.revision,
              sha256: own.sha256,
              matched: frozenMatches(
                check.allOf.flatMap((literal): AuditLiteralMatch[] => {
                  const at = own.content.indexOf(literal);
                  return at === -1 ? [] : [{ literal, charRange: [at, at + literal.length] }];
                }),
              ),
              missing: Object.freeze(
                check.allOf.filter((literal) => !own.content.includes(literal)),
              ),
            });
      return Object.freeze({
        path: check.path,
        retained: false,
        revision: null,
        sha256: null,
        matched: Object.freeze([]),
        missing: Object.freeze([...check.allOf]),
        ...(observed === undefined ? {} : { observed }),
      });
    }
    const digest = createHash("sha256").update(record.content, "utf8").digest("hex");
    return Object.freeze({
      path: check.path,
      retained: true,
      revision: /@([0-9a-f]+)\//.exec(record.url)?.[1] ?? null,
      sha256: digest,
      matched: frozenMatches(
        check.allOf.flatMap((literal): AuditLiteralMatch[] => {
          const at = record.content.indexOf(literal);
          return at === -1 ? [] : [{ literal, charRange: [at, at + literal.length] }];
        }),
      ),
      missing: Object.freeze(
        check.allOf.filter((literal) => !record.content.includes(literal)),
      ),
    });
  });
}

/** Unresolved cause for a literal claim, in trust order: a seam refusal on
 * a declared file carries its ACTUAL refusal kind; then a declared file
 * that was never retained (missing evidence); else the engine's own
 * terminal reason verbatim. */
function unresolvedLiteralReason(
  claim: AuditClaim,
  basis: readonly AuditBasisRow[],
  journal: AuditJournal,
  engineReason?: string,
): string {
  for (const check of claim.checks) {
    const refusal = journal.refusals.find((r) => pathOfUrl(r.url) === check.path);
    if (refusal !== undefined) {
      return `${refusal.kind}:${check.path}`;
    }
  }
  const unretained = basis.find((b) => !b.retained);
  if (unretained !== undefined) return `missing_evidence:${unretained.path}`;
  return engineReason ?? "engine_unresolved";
}

/**
 * Run the audit: compile both inputs (fail-loud, pre-acquisition), require
 * EXACT repository+revision agreement between the claim set and the
 * snapshot (different pins must never be conflated), drive the shared lean
 * investigation engine through the trusted snapshot deps, and project the
 * engine result into the claim-level audit report.
 */
export async function runImplementationAudit(
  claimSetInput: unknown,
  snapshotInput: unknown,
): Promise<AuditReport> {
  const claims = compileAuditClaimSet(claimSetInput);
  const snapshot = compilePinnedSnapshot(snapshotInput);
  // Pin agreement is enforced INSIDE the exported seam (single authority,
  // direct callers included); it fires here before any acquisition.
  const { deps, journal, observe } = createSnapshotReadDeps(claims, snapshot);
  const result = await runLeanInvestigation(buildEngineContract(claims), deps);

  const claimResults = claims.claims.map((claim): AuditClaimResult => {
    const row = result.requirements[claim.id];
    // PR #304 thread 2: the ENTIRE report is owned frozen data — engine
    // projections, basis rows and their locators included — so callers can
    // never rewrite accepted findings or provenance after the audit. Only
    // report-internal copies are frozen; caller/engine-owned objects are
    // copied first, never frozen in place.
    const engine = Object.freeze(
      row === undefined
        ? { status: "unresolved", reason: "absent_from_engine_result", judgmentCount: 0, inconsistentJudgments: 0 }
        : row.status === "satisfied"
          ? {
              status: row.status,
              value: row.value,
              judgmentCount: row.judgmentCount,
              inconsistentJudgments: row.inconsistentJudgments,
            }
          : {
              status: row.status,
              reason: row.reason,
              judgmentCount: row.judgmentCount,
              inconsistentJudgments: row.inconsistentJudgments,
            },
    );
    const basis = Object.freeze(basisFor(claim, result, observe));
    if (row?.status === "satisfied") {
      return Object.freeze({
        id: claim.id,
        text: claim.text,
        proofClass: claim.proofClass,
        status: row.value as "supported" | "refuted" | "disputed",
        engine,
        basis,
      });
    }
    const reason =
      claim.proofClass === "runtime"
        ? "no_authorized_runtime_probe"
        : claim.proofClass === "reachability"
          ? "reachability_not_provable_from_literal_evidence"
          : unresolvedLiteralReason(claim, basis, journal, row?.reason);
    return Object.freeze({
      id: claim.id,
      text: claim.text,
      proofClass: claim.proofClass,
      status: "unresolved",
      unresolvedReason: reason,
      engine,
      basis,
    });
  });

  const evidence = result.evidence.map((e) =>
    Object.freeze({
      evidenceId: e.evidenceId,
      url: e.url,
      path: pathOfUrl(e.url) ?? e.url,
      revision: /@([0-9a-f]+)\//.exec(e.url)?.[1] ?? "unpinned",
      sha256: createHash("sha256").update(e.content, "utf8").digest("hex"),
      byteLength: e.byteLength,
    }),
  );
  const report: AuditReport = Object.freeze({
    schemaVersion: 1,
    repository: claims.repository,
    revision: claims.revision,
    status: result.status,
    assessment: result.assessment,
    claims: Object.freeze(claimResults),
    evidence: Object.freeze(evidence),
    // Journal elements are seam-shared: COPY then freeze, never freeze in place.
    refusals: Object.freeze(journal.refusals.map((r) => Object.freeze({ ...r }))),
    abstentions: Object.freeze(journal.abstentions.map((a) => Object.freeze({ ...a }))),
    acquisitionLog: Object.freeze(result.acquisitionLog.map((e) => Object.freeze({ ...e }))),
    // Engine-owned object graph: copy into an owned frozen record.
    usage: Object.freeze({ ...result.usage }),
    coverageNotes: Object.freeze([
      ...result.coverageNotes,
      "Accepted findings are literal-presence predicates at the pinned revision; they do not establish active code, public reachability or runtime behavior (comments and string data can match literals).",
      "Acquisition is closed-scope: queries resolve against the claim-relevant file index of the pinned snapshot (scoped to the claim owning each query), not remote discovery; contrary coverage is bounded to that scope.",
      "SHARED GATE (open, documented for convergence): closed-source coverage — what it means for a FINITE declared source universe to be completely assessed — is not yet an explicit engine contract. This consumer approximates it (claim-scoped enumeration; acceptance withheld wherever complete scoped assessment cannot be established). Extraction and audit need one shared explicit closed-source coverage gate in the engine before this approximation is replaced.",
      "Observation rows (basis.observed) come from the seam's own verified materialization of files the engine never retained; they preserve literal facts with locators and never support acceptance.",
      "Revision identity is fixture-declared: digests verify byte consistency, not commit membership. Claim-relevant bytes were digest-verified and frozen by the consumer before the run.",
      "Absence findings are bounded to each claim's declared files at the pinned revision, not whole-repository absence proofs.",
    ]),
  });
  return report;
}
