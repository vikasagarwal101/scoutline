/**
 * Fact monitoring store + tick state machine (v3 seed 03 first slice).
 *
 * Lane-owned consumer of the lean investigation engine. One explicit
 * user-requested tick per invocation runs ONE bounded engine pass
 * (runLeanInvestigation) for a monitor definition and compares each
 * requirement's ACCEPTED value against the last accepted baseline —
 * distinct from `watch`, whose baseline is the previous captured
 * DOCUMENT. Reuses the watch operational conventions (per-target lock
 * at the target dir, atomicReplaceFile, newRequestId tick ids) without
 * touching watch storage.
 *
 * Layout under a caller-supplied root:
 *
 *   <root>/<monitorId>/current.json          — THE authoritative committed state
 *   <root>/<monitorId>/ticks/tick-<seq>.json — per-tick commit record
 *                                               (engine outcome + events +
 *                                               complete state after)
 *
 * Commit protocol (all under the per-monitor lock): evaluate transitions
 * in memory, then publish — 1) the tick record, 2) the current.json
 * atomic replace. current.json's replace IS the commit point. The state
 * carries `commit: {seq, tickId}` naming the record that produced it,
 * and loading VALIDATES that chain: the referenced record must exist,
 * parse, agree on tickId/seq, and its stateAfter must byte-match the
 * state. Anything ambiguous fails CLOSED — a missing current.json with
 * surviving tick records is treated as history loss, never as a fresh
 * monitor; a torn or disagreeing referenced record is corruption, never
 * silently skipped. Tick records beyond the referenced sequence are
 * DEFINITELY UNCOMMITTED orphans (a crash between the two writes); the
 * next commit at that sequence atomically replaces them.
 *
 * Durability — exactly what is proven, no more:
 *   - atomicReplaceFile fsyncs the payload file and fsyncs the target
 *     file's containing directory after the rename; rename is atomic.
 *     A replace that returned is durable; a replace in flight leaves
 *     the old or the new complete file, never a torn one.
 *   - monitor/ticks directory CREATION is made durable by this module
 *     fsyncing the parent directory after mkdir (the helper alone only
 *     syncs the leaf directory).
 *   - A surviving record with no pointer after a crash requires inspection.
 *     A visible current.json at seq N with its intact referenced record
 *     is committed. Power loss follows the fsync contract of the host
 *     filesystem — on a filesystem that honors fsync, the above holds
 *     across power loss too. On Windows, directory sync is skipped
 *     (read-only directory handles cannot FlushFileBuffers): successful
 *     ticks report durability "fsync-limited" there, and power-loss
 *     durability narrows to rename atomicity.
 *
 * Overlap rule (documented sequence rule, seed 03 "first useful scope"):
 * a tick commits only when the state sequence still equals the one it was
 * prepared against. The engine run happens outside the commit lock; the
 * optimistic base-sequence check inside the lock rejects late older
 * results (no loser writes), so an older tick can never overwrite a
 * newer accepted baseline.
 *
 * Publication holds one SQLite write transaction from the locked read
 * through both atomic writes and failure reconciliation. A paused writer
 * retains the lock. Stop older monitor writers before upgrading; the
 * permanent lock directory blocks legacy lockfile acquisition after cutover.
 * A caught first-publication failure can clean up only this attempt's exact
 * record while the pointer is absent. Ambiguous history requires inspection.
 *
 * Definition identity: prepare compiles the definition FIRST
 * (compileLeanContract — a malformed definition, revised or not, fails
 * as a validation error before any state is read or a baseline can be
 * cleared), deep-freezes a size-bounded JSON snapshot, and digests the
 * COMPILED contract (canonical object key order, limits excluded as run
 * knobs, FIELD ORDER PRESERVED because the bounded engine plan executes
 * in that order, and meaningful inner array order — enum vocabularies,
 * criteria — preserved). Equivalent definitions that compile identically
 * share one identity; a materially different compiled contract
 * re-baselines without comparing values.
 *
 * Owned-path confinement: every read/written path lives under
 * <root>/<monitorId>, whose directory chain is checked — a symlinked or
 * non-regular monitor/ticks directory or state file is refused, reads
 * open with O_NOFOLLOW|O_NONBLOCK on Linux, and all reads and writes
 * are byte-bounded. SCOPE of these guards (r4659866115): they catch
 * misdirected opens and REFUSE pre-existing redirection at every entry
 * (root, monitor dir, ticks dir, state and record files — including a
 * re-check of the ticks directory immediately before the record write);
 * they do NOT protect the PUBLICATION files (tick records, current.json,
 * the lock database) against replacement by an arbitrary external actor
 * after those checks — no in-contract writer replaces or unlinks them
 * (each atomicReplaceFile renames onto the exact owned path; the lock
 * module never unlinks its database), and the actual boundary is the
 * CALLER-supplied owned, local, access-controlled, stable directory
 * tree, whose owner must guard against external replacement. No safety
 * against arbitrary external pathname/inode replacement is claimed.
 *
 * Cancellation: ALL sources (the tick option and the engine deps'
 * externalSignal) are merged once with AbortSignal.any; the merged
 * signal is bridged to the engine run and the commit lock acquire,
 * checked after the locked state read (so an abort there is never
 * misreported as a late commit) and immediately before publication — a
 * cancelled tick writes NOTHING. Once publication starts, the commit
 * finishes coherently; a publication-phase failure is triaged into
 * definitely-uncommitted (retry-safe), visible-unconfirmed (commit
 * stands; NEVER blind-retry) or uncertain (operator inspects).
 *
 * ponytail: value equality is exact string equality; declared
 * normalization rules arrive with the engine's typed-value comparison
 * work — add them inside valuesEqual() then. Tick-record
 * retention/pruning is later work; the hot path reads current.json plus
 * exactly one referenced record, and never scans beyond it.
 */
import { createHash } from "node:crypto";
import * as path from "node:path";
import * as fs from "node:fs/promises";

import { atomicReplaceFile } from "./config-store.js";
import { LockTimeoutError } from "./async-file-lock.js";
import { withSqliteTickLock } from "./sqlite-tick-lock.js";
import { ValidationError } from "./errors.js";
import { newRequestId } from "./artifacts.js";
import {
  compileLeanContract,
  runLeanInvestigation,
  type LeanCompiledContract,
  type LeanDeps,
  type LeanResult,
} from "./lean-investigation.js";

export const FACT_MONITOR_STATE_VERSION = 1 as const;
export const FACT_MONITOR_CURRENT_FILENAME = "current.json" as const;
export const FACT_MONITOR_TICKS_DIRNAME = "ticks" as const;
/** Read AND write ceiling for one persisted record (state or tick record). */
export const MAX_FACT_MONITOR_RECORD_BYTES = 2 * 1024 * 1024;
/** Ceiling for the serialized definition snapshot (matches the requirements input ceiling). */
export const MAX_FACT_MONITOR_DEFINITION_BYTES = 1024 * 1024;
/** Highest storable sequence: +1 must stay a safe integer. */
export const MAX_FACT_MONITOR_SEQUENCE = Number.MAX_SAFE_INTEGER - 1;
/** Pre-flight nesting ceiling: bounded BEFORE any recursive materialization. */
export const MAX_FACT_MONITOR_DEFINITION_DEPTH = 64;

/** Transition vocabulary (seed 03 table). */
export type FactMonitorEventKind =
  | "baseline_established"
  | "unchanged"
  | "value_changed"
  | "became_unresolved"
  | "unresolved_attempt"
  | "recovered"
  | "redefined";

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
/** Valid transition kinds, used to validate stored event entries. */
const EVENT_KINDS: ReadonlySet<string> = new Set<string>([
  "baseline_established",
  "unchanged",
  "value_changed",
  "became_unresolved",
  "unresolved_attempt",
  "recovered",
  "redefined",
]);
const TICK_RECORD_PATTERN = /^tick-(\d+)\.json$/;
const LINUX_O_NOFOLLOW_NONBLOCK = process.platform === "linux" ? 0x20000 | 0x800 : 0;

/** One transition record; persisted inside the per-tick commit record. */
export interface FactMonitorEvent {
  readonly schemaVersion: 1;
  readonly seq: number;
  readonly tickId: string;
  readonly at: string;
  /** null only for monitor-level events (`redefined`). */
  readonly fieldId: string | null;
  readonly kind: FactMonitorEventKind;
  readonly oldValue?: string;
  readonly newValue?: string;
  /** Tick that ACCEPTED the old value — evidence references are tick-bound. */
  readonly oldTickId?: string;
  /** Sequence of that tick's record — evidence opens directly by path. */
  readonly oldSeq?: number;
  readonly oldEvidenceIds?: readonly string[];
  readonly newEvidenceIds?: readonly string[];
  readonly reason?: string;
  /** Present on `redefined`: the digest this event switched the monitor to. */
  readonly definitionDigest?: string;
}

/** Last accepted baseline — historical truth, never replaced by a failed attempt. */
export interface AcceptedBaseline {
  readonly value: string;
  readonly acceptedAt: string;
  readonly acceptedSeq: number;
  readonly tickId: string;
  readonly evidenceIds: readonly string[];
}

/** Latest attempt, accepted or not — kept separate from the baseline. */
export interface LatestAttempt {
  readonly status: "satisfied" | "unresolved" | "error";
  readonly value?: string;
  readonly reason?: string;
  readonly at: string;
  readonly seq: number;
  readonly tickId: string;
  readonly evidenceIds: readonly string[];
}

export interface FactMonitorFieldState {
  /** Absent until first acceptance under the current definition digest. */
  readonly accepted?: AcceptedBaseline;
  /** Set while the field is in an unresolved stretch (drives once-only transition). */
  readonly unresolvedSince?: string;
  readonly latest?: LatestAttempt;
}

/** Reference to the commit record that produced this state (absent only on a fresh monitor). */
export interface FactMonitorCommitRef {
  readonly seq: number;
  readonly tickId: string;
}

/** The authoritative content of current.json. */
export interface FactMonitorState {
  readonly schemaVersion: 1;
  readonly monitorId: string;
  /** Compiled-contract digest the baselines were accepted under; mismatch ⇒ re-baseline. */
  readonly definitionDigest: string;
  /** Last committed tick sequence. */
  readonly seq: number;
  /** The record under ticks/ that produced this state; required when seq > 0. */
  readonly commit?: FactMonitorCommitRef;
  readonly fields: Readonly<Record<string, FactMonitorFieldState>>;
}

/** The lossless per-tick commit record under ticks/tick-<seq>.json. */
export interface FactMonitorTickRecord {
  readonly schemaVersion: 1;
  readonly monitorId: string;
  readonly tickId: string;
  readonly seq: number;
  readonly at: string;
  readonly definitionDigest: string;
  readonly engine: FactMonitorEngineOutcome;
  readonly events: readonly FactMonitorEvent[];
  readonly stateAfter: FactMonitorState;
}

/** A tick prepared against a base sequence (engine run happens next). */
export interface PreparedFactMonitorTick {
  readonly monitorId: string;
  readonly tickId: string;
  readonly basedOnSeq: number;
  readonly definitionDigest: string;
  /** Frozen JSON snapshot of the validated definition (the engine input). */
  readonly definition: unknown;
  /** The validated compiled contract (authoritative field set + requiredness). */
  readonly compiled: LeanCompiledContract;
}

/** Evaluated engine outcome handed to commit — result, or failed run. */
export type FactMonitorEngineOutcome =
  | { readonly kind: "result"; readonly result: LeanResult }
  | { readonly kind: "error"; readonly reason: string };

export interface FactMonitorFieldReport {
  readonly status: "satisfied" | "unresolved" | "error";
  readonly required: boolean;
  /** Current accepted value for THIS tick; absent when unresolved/error. */
  readonly value?: string;
  readonly reason?: string;
  /** Event kinds emitted for this field by this tick. */
  readonly events: readonly FactMonitorEventKind[];
  /** Last accepted baseline, clearly separated from current data. */
  readonly lastAccepted?: { readonly value: string; readonly acceptedAt: string };
}

export interface FactMonitorTickReport {
  readonly schemaVersion: 1;
  readonly monitorId: string;
  readonly tickId: string;
  /** Committed sequence, or the current state sequence when rejected. */
  readonly seq: number;
  readonly definitionDigest: string;
  readonly committed: boolean;
  readonly rejection?: "late_commit";
  /** Publication outcome: "confirmed" (fully durable: payload+directory
   *  fsync), "fsync-limited" (succeeded, but directory sync is skipped on
   *  this platform — power-loss durability narrows to rename atomicity),
   *  or "visible-unconfirmed" (current.json names this tick but a
   *  post-rename step failed — visible, not re-runnable). */
  readonly durability?: "confirmed" | "fsync-limited" | "visible-unconfirmed";
  readonly durabilityWarning?: string;
  readonly fields: Readonly<Record<string, FactMonitorFieldReport>>;
  readonly events: readonly FactMonitorEvent[];
  readonly engine: {
    readonly status: "complete" | "partial" | "error";
    readonly reason?: string;
  };
  readonly paths: {
    readonly current: string;
    readonly ticksDir: string;
    readonly tickRecord: string | null;
  };
}

/** Raised when the tick's AbortSignal fires before publication: nothing is written. */
export class FactMonitorCancelledError extends Error {
  constructor(monitorId: string) {
    super(`fact monitor ${monitorId}: tick cancelled before publication.`);
    this.name = "FactMonitorCancelledError";
  }
}

/**
 * Raised when a publication-phase error leaves the commit state
 * UNRESOLVABLE from this process (post-error inspection could not
 * confirm either outcome). The operator must inspect current.json
 * before any retry — a blind retry could double-apply a visible tick.
 */
export class FactMonitorPublicationUncertainError extends Error {
  constructor(monitorId: string, cause: unknown) {
    super(
      `fact monitor ${monitorId}: publication failed with the commit state unverifiable (${cause instanceof Error ? cause.message : String(cause)}); inspect current.json before retrying — do NOT blind-retry.`,
    );
    this.name = "FactMonitorPublicationUncertainError";
  }
}

/** Load-side and pre-publication shared check: a cited evidence entry
 *  must be a USABLE LeanEvidenceRecord, not an ID-only stub. */
function requireUsableEvidenceEntry(
  entry: { evidenceId?: string; url?: unknown; title?: unknown; content?: unknown; byteLength?: unknown; origins?: unknown } | undefined,
  evidenceId: string,
  what: string,
): void {
  if (entry === undefined) {
    throw new ValidationError(`${what}: accepted evidence ${JSON.stringify(evidenceId)} does not resolve in the engine artifact.`);
  }
  if (typeof entry.url !== "string" || typeof entry.title !== "string" ||
    typeof entry.content !== "string" || typeof entry.byteLength !== "number" || entry.byteLength < 0 ||
    !Array.isArray(entry.origins) || entry.origins.some((origin) => typeof origin !== "string")) {
    throw new ValidationError(`${what}: accepted evidence ${JSON.stringify(evidenceId)} is not a usable evidence record.`);
  }
}

/** Injectable knobs (watch's WatchStoreOptions pattern). */
export interface FactMonitorOptions {
  readonly now: Date;
  /** Cancellation: bridges to the engine and the lock acquire; checked before publication. */
  readonly signal?: AbortSignal;
  readonly lock?: {
    readonly timeoutMs?: number;
    /** Retained for callers of the old lock. The publication lock has no expiry. */
    readonly staleMs?: number;
    readonly setTimeout?: typeof setTimeout;
  };
}

// ---------------------------------------------------------------------------
// Paths + small helpers
// ---------------------------------------------------------------------------

const MONITOR_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function monitorDir(root: string, monitorId: string): string {
  return path.join(root, monitorId);
}

function currentPath(root: string, monitorId: string): string {
  return path.join(monitorDir(root, monitorId), FACT_MONITOR_CURRENT_FILENAME);
}

function ticksDir(root: string, monitorId: string): string {
  return path.join(monitorDir(root, monitorId), FACT_MONITOR_TICKS_DIRNAME);
}

function tickRecordPath(root: string, monitorId: string, seq: number): string {
  return path.join(ticksDir(root, monitorId), `tick-${seq}.json`);
}

/** Validate a monitor id (exported for the command layer's pre-input
 *  check — the store re-validates before any path use regardless). */
export function requireMonitorId(monitorId: string): string {
  if (!MONITOR_ID_PATTERN.test(monitorId)) {
    throw new ValidationError(
      `monitor id ${JSON.stringify(monitorId)} is invalid: use 1-128 chars of letters, digits, '.', '_' or '-', starting alphanumeric.`,
    );
  }
  return monitorId;
}

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

function toIso(date: Date): string {
  return date.toISOString();
}

/** Key-sorted stable JSON: object key order is not identity; ARRAY order is (field plan, enum vocabularies, criteria) and is preserved. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    value.forEach(deepFreeze);
    return Object.freeze(value);
  }
  if (typeof value === "object" && value !== null) {
    Object.values(value as Record<string, unknown>).forEach(deepFreeze);
    return Object.freeze(value);
  }
  return value;
}

/**
 * Stable monitor DEFINITION identity over VALIDATED semantics: the
 * compiled contract with `limits` excluded (per-run knobs) and FIELD
 * ORDER PRESERVED (the bounded engine plan executes in that order — two
 * orderings are two different runs, not one identity). Object key order
 * canonicalized; meaningful inner arrays preserved. Throws
 * ValidationError for a malformed definition — always BEFORE any state
 * is read, so an invalid revised definition can never clear a baseline.
 */
export function factMonitorDefinitionDigest(definition: object): string {
  const compiled = compileLeanContract(definition);
  return compiledContractDigest(compiled);
}

function compiledContractDigest(compiled: LeanCompiledContract): string {
  const { limits: _limits, ...identity } = compiled;
  return createHash("sha256").update(canonicalJson(identity)).digest("hex");
}

/** ponytail: exact equality; declared normalization rules land here later. */
function valuesEqual(a: string, b: string): boolean {
  return a === b;
}

/** Bounded read of an OWNED regular file: lstat screen (no symlink, no
 *  fifo/device), O_NOFOLLOW|O_NONBLOCK open on Linux, FSTAT of the opened
 *  handle (path-swap race closed), incremental 64 KiB reads failing the
 *  moment the ceiling is exceeded. */
export async function readOwnedFileBounded(
  filePath: string,
  label: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  const text = await readOwnedFileBoundedIfExists(filePath, label, maxBytes, signal);
  if (text === undefined) throw new ValidationError(`${label} is absent.`);
  return text;
}

/** Owned no-follow bounded read that distinguishes ABSENT (returns
 *  undefined) from REFUSED (symlink/non-regular/oversized/cancelled all
 *  throw) — callers must never conflate a redirected or inaccessible
 *  path with ENOENT. */
export async function readOwnedFileBoundedIfExists(
  filePath: string,
  label: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<string | undefined> {
  return (await readOwnedBytesBoundedIfExists(filePath, label, maxBytes, signal))?.toString("utf8");
}

async function readOwnedBytesBoundedIfExists(
  filePath: string,
  label: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Buffer | undefined> {
  if (signal?.aborted) {
    throw new FactMonitorReadAbortedError(`${label}: read cancelled before open.`);
  }
  let info;
  try {
    info = await fs.lstat(filePath);
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new ValidationError(`${label} is not a regular file; refusing redirected input.`);
  }
  if (info.size > maxBytes) {
    throw new ValidationError(`${label} exceeds the ${maxBytes}-byte record ceiling.`);
  }
  const handle = await fs.open(filePath, fs.constants.O_RDONLY | LINUX_O_NOFOLLOW_NONBLOCK);
  try {
    // fstat the OPENED handle: the lstat→open gap could swap the file.
    const opened = await handle.stat();
    if (!opened.isFile()) {
      throw new ValidationError(`${label} opened as a non-regular file; refusing.`);
    }
    const parts: Buffer[] = [];
    let total = 0;
    const chunk = Buffer.alloc(64 * 1024);
    for (;;) {
      if (signal?.aborted) {
        throw new FactMonitorReadAbortedError(`${label}: read cancelled mid-stream.`);
      }
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) {
        throw new ValidationError(`${label} exceeds the ${maxBytes}-byte record ceiling.`);
      }
      parts.push(Buffer.from(chunk.subarray(0, bytesRead)));
    }
    return Buffer.concat(parts);
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * Pre-flight a raw definition BEFORE any recursive materialization
 * (JSON clone/stringify, compile): an ITERATIVE depth+size walk with an
 * explicit stack, so a hostile deep/bloated object is rejected without
 * first being copied or blowing the JS stack. The estimate PRE-CHARGES
 * per-element wire overhead (quotes, separators, colons) so a huge array
 * of empty strings is rejected during the walk, and the exact serialized
 * byte count is re-checked before parsing downstream.
 */
function preflightDefinitionBounds(value: unknown): void {
  let total = 0;
  const stack: Array<[unknown, number]> = [[value, 0]];
  while (stack.length > 0) {
    const entry = stack.pop() as [unknown, number];
    const [item, depth] = entry;
    if (depth > MAX_FACT_MONITOR_DEFINITION_DEPTH) {
      throw new ValidationError(
        `fact monitor: definition exceeds the ${MAX_FACT_MONITOR_DEFINITION_DEPTH}-level nesting ceiling.`,
      );
    }
    if (typeof item === "string") {
      total += item.length + 2; // quotes
    } else if (typeof item === "number" || typeof item === "boolean" || item === null) {
      total += 9;
    } else if (Array.isArray(item)) {
      // PRE-CHARGE the container's whole length BEFORE queueing any child:
      // a huge (sparse) array must trip the ceiling without allocating a
      // huge worklist of tuple entries.
      total += 2 + item.length;
      if (total > MAX_FACT_MONITOR_DEFINITION_BYTES) {
        throw new ValidationError(
          `fact monitor: definition exceeds the ${MAX_FACT_MONITOR_DEFINITION_BYTES}-byte ceiling.`,
        );
      }
      for (const child of item) stack.push([child, depth + 1]);
    } else if (typeof item === "object") {
      const keys = Object.keys(item as Record<string, unknown>);
      total += 2 + keys.length;
      if (total > MAX_FACT_MONITOR_DEFINITION_BYTES) {
        throw new ValidationError(
          `fact monitor: definition exceeds the ${MAX_FACT_MONITOR_DEFINITION_BYTES}-byte ceiling.`,
        );
      }
      for (const key of keys) {
        total += key.length + 4; // quoted key + colon
        stack.push([(item as Record<string, unknown>)[key], depth + 1]);
      }
    }
    if (total > MAX_FACT_MONITOR_DEFINITION_BYTES) {
      throw new ValidationError(
        `fact monitor: definition exceeds the ${MAX_FACT_MONITOR_DEFINITION_BYTES}-byte ceiling.`,
      );
    }
  }
}

/** Merge every supplied cancellation source into ONE signal (AbortSignal.any). */
function mergeSignals(signals: ReadonlyArray<AbortSignal | undefined>): AbortSignal | undefined {
  const present = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  return AbortSignal.any(present);
}

/**
 * Internal read-abort identity: the owned readers' SIGNAL refusals.
 * Extends ValidationError so public catchers see the historical shape,
 * while internal classification uses the class, never message text —
 * a user-controlled label containing "cancelled" cannot impersonate it.
 */
class FactMonitorReadAbortedError extends ValidationError {}

/** Make a directory entry durable: fsync the directory itself. On
 *  Windows, directory-handle FlushFileBuffers needs write access (the
 *  shared atomicReplaceFile helper skips dir sync there for the same
 *  reason) — sync is a no-op and the durability claim narrows to
 *  rename-atomicity only on that platform. */
async function syncDir(dirPath: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await fs.open(dirPath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close().catch(() => {});
  }
}

/** Refuse a symlinked or non-directory owned path (redirected state). */
async function requireOwnedDirectory(dirPath: string, label: string): Promise<boolean> {
  let info;
  try {
    info = await fs.lstat(dirPath);
  } catch (error) {
    if (isEnoent(error)) return false;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new ValidationError(`${label} is not a regular directory; refusing redirected state.`);
  }
  return true;
}

/** Owned bounded state/record read under the load signal: a signal-fired
 *  refusal maps to the TYPED cancellation; every other error (redirected,
 *  oversized, IO) passes through unchanged. */
async function readStateFileBounded(
  root: string,
  monitorId: string,
  filePath: string,
  label: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  try {
    return await readOwnedFileBounded(filePath, label, MAX_FACT_MONITOR_RECORD_BYTES, signal);
  } catch (error) {
    if (error instanceof FactMonitorReadAbortedError) {
      throw new FactMonitorCancelledError(monitorId);
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Load — validated current.json + exact referenced-record agreement
// ---------------------------------------------------------------------------

function requireSafeSequence(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > MAX_FACT_MONITOR_SEQUENCE) {
    throw new ValidationError(`fact monitor state: ${what} is not a safe sequence number.`);
  }
  return value;
}

function requireEvidenceIds(value: unknown, what: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new ValidationError(`fact monitor state: ${what} must be an array of non-empty strings.`);
  }
  return value as readonly string[];
}

/** Exact plain-shape check: every present key must be known, and the
 *  required subset must be present. Persisted records are version-1
 *  local files — unknown keys are corruption, not forward compatibility. */
function requirePlainShape(
  value: unknown,
  what: string,
  required: ReadonlySet<string>,
  optional: ReadonlySet<string>,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ValidationError(`fact monitor state: ${what} must be a plain object.`);
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!required.has(key) && !optional.has(key)) {
      throw new ValidationError(`fact monitor state: ${what} carries an unknown key ${JSON.stringify(key)}.`);
    }
  }
  for (const key of required) {
    if (!(key in record)) {
      throw new ValidationError(`fact monitor state: ${what} is missing ${JSON.stringify(key)}.`);
    }
  }
  return record;
}

function validateStateShape(raw: unknown, monitorId: string): FactMonitorState {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ValidationError(`fact monitor ${monitorId}: current.json is not a state object.`);
  }
  const state = raw as Record<string, unknown>;
  if (state.schemaVersion !== 1) {
    throw new ValidationError(`fact monitor ${monitorId}: current.json has an unsupported schemaVersion.`);
  }
  if (state.monitorId !== monitorId) {
    throw new ValidationError(
      `fact monitor ${monitorId}: current.json names a different monitor ${JSON.stringify(state.monitorId)}.`,
    );
  }
  const seq = requireSafeSequence(state.seq, "sequence");
  if (seq === 0) {
    // A persisted state always comes from a commit, and the first commit
    // writes seq 1 — a seq-0 file is a crafted/foreign record that would
    // bypass history validation and open tick-1.json to overwrite.
    throw new ValidationError(`fact monitor ${monitorId}: current.json claims sequence 0; persisted states must start at 1.`);
  }
  if (typeof state.definitionDigest !== "string" || !DIGEST_PATTERN.test(state.definitionDigest)) {
    throw new ValidationError(`fact monitor ${monitorId}: current.json lacks a valid non-empty definition digest.`);
  }
  requirePlainShape(
    raw,
    "current.json",
    new Set(["schemaVersion", "monitorId", "definitionDigest", "seq", "commit", "fields"]),
    new Set([]),
  );
  const commit = requirePlainShape(state.commit, "commit reference", new Set(["seq", "tickId"]), new Set([]));
  if (requireSafeSequence(commit.seq, "commit sequence") !== seq || typeof commit.tickId !== "string" || commit.tickId.length === 0) {
    throw new ValidationError(`fact monitor ${monitorId}: current.json lacks a matching commit reference.`);
  }
  if (typeof state.fields !== "object" || state.fields === null || Array.isArray(state.fields)) {
    throw new ValidationError(`fact monitor ${monitorId}: current.json fields must be an object.`);
  }
  for (const [fieldId, field] of Object.entries(state.fields as Record<string, unknown>)) {
    const record = requirePlainShape(
      field,
      `field ${fieldId}`,
      new Set([]),
      new Set(["accepted", "unresolvedSince", "latest"]),
    );
    const accepted = record.accepted;
    if (accepted !== undefined) {
      const baseline = requirePlainShape(
        accepted,
        `${fieldId} accepted baseline`,
        new Set(["value", "acceptedAt", "acceptedSeq", "tickId", "evidenceIds"]),
        new Set([]),
      );
      if (typeof baseline.value !== "string" || typeof baseline.acceptedAt !== "string" || typeof baseline.tickId !== "string" || baseline.tickId.length === 0) {
        throw new ValidationError(`fact monitor ${monitorId}: field ${fieldId} has a malformed accepted baseline.`);
      }
      const acceptedSeq = requireSafeSequence(baseline.acceptedSeq, `${fieldId} accepted sequence`);
      if (acceptedSeq < 1 || acceptedSeq > seq) {
        throw new ValidationError(`fact monitor ${monitorId}: field ${fieldId} accepted sequence is out of range.`);
      }
      requireEvidenceIds(baseline.evidenceIds, `${fieldId} accepted evidence ids`);
    }
    const latest = record.latest;
    if (latest !== undefined) {
      const attempt = requirePlainShape(
        latest,
        `${fieldId} latest attempt`,
        new Set(["status", "at", "seq", "tickId", "evidenceIds"]),
        new Set(["value", "reason"]),
      );
      if ((attempt.status !== "satisfied" && attempt.status !== "unresolved" && attempt.status !== "error") ||
        typeof attempt.at !== "string" || typeof attempt.tickId !== "string" || attempt.tickId.length === 0) {
        throw new ValidationError(`fact monitor ${monitorId}: field ${fieldId} has a malformed latest attempt.`);
      }
      const latestSeq = requireSafeSequence(attempt.seq, `${fieldId} latest sequence`);
      if (latestSeq < 1 || latestSeq > seq) {
        throw new ValidationError(`fact monitor ${monitorId}: field ${fieldId} latest sequence is out of range.`);
      }
      requireEvidenceIds(attempt.evidenceIds, `${fieldId} latest evidence ids`);
    }
    if (record.unresolvedSince !== undefined && typeof record.unresolvedSince !== "string") {
      throw new ValidationError(`fact monitor ${monitorId}: field ${fieldId} has a malformed unresolvedSince.`);
    }
  }
  return raw as FactMonitorState;
}

/**
 * Load the authoritative committed state and VALIDATE the exact
 * referenced record before use. Fail-closed rules:
 *   - monitor/ticks dir or current.json symlinked or non-regular ⇒ refuse;
 *   - current.json absent BUT tick records survive ⇒ ambiguous history
 *     loss ⇒ refuse (never guessed as fresh, never overwritten);
 *   - referenced tick record absent, unparseable, or disagreeing with
 *     the state (tickId/seq/stateAfter byte-match) ⇒ corruption ⇒ refuse;
 *   - torn/oversized records ⇒ refused by the bounded owned reader.
 * Orphan tick records beyond the referenced sequence are definitely
 * uncommitted and ignored.
 */
export async function loadFactMonitorState(
  root: string,
  monitorId: string,
  options?: { readonly signal?: AbortSignal; readonly lock?: FactMonitorOptions["lock"] },
): Promise<FactMonitorState> {
  return loadFactMonitorStateInternal(root, monitorId, false, options);
}

/**
 * `alreadyLocked`: the caller (commit) already holds the per-monitor tick
 * lock, so reads are consistent and the ambiguity RE-CHECK must not
 * re-acquire it. Outside callers get
 * the lock-aware path: an absent current.json with surviving records is
 * first re-read UNDER the lock, because a healthy first publication
 * legitimately exposes exactly that window (record written, pointer not
 * yet replaced). Still ambiguous under the lock ⇒ no live publication is
 * in flight ⇒ a real orphan of an interrupted first publication or
 * pointer loss — an ACTUAL ORPHAN, which requires manual inspection.
 */
async function loadFactMonitorStateInternal(
  root: string,
  monitorId: string,
  alreadyLocked: boolean,
  options?: { readonly signal?: AbortSignal; readonly lock?: FactMonitorOptions["lock"] },
): Promise<FactMonitorState> {
  requireMonitorId(monitorId);
  // Pre-existing owned ROOT: created by the caller, never by this module,
  // and never followed through a symlink (it anchors every owned path).
  if (!(await requireOwnedDirectory(root, "fact monitor root"))) {
    throw new ValidationError("fact monitor root does not exist; create it explicitly (this module never creates the root).");
  }
  const dir = monitorDir(root, monitorId);
  const dirExists = await requireOwnedDirectory(dir, `fact monitor ${monitorId} directory`);
  const filePath = currentPath(root, monitorId);
  let currentInfo;
  try {
    currentInfo = await fs.lstat(filePath);
  } catch (error) {
    if (!isEnoent(error)) throw error;
    currentInfo = undefined;
  }
  if (currentInfo === undefined) {
    if (!dirExists) {
      return { schemaVersion: 1, monitorId, definitionDigest: "", seq: 0, fields: {} };
    }
    // No pointer: any surviving tick record is ambiguous — a healthy
    // first publication exposes exactly this window. Recheck under the
    // monitor lock before declaring damage.
    const ticksExists = await requireOwnedDirectory(ticksDir(root, monitorId), `fact monitor ${monitorId} ticks directory`);
    if (ticksExists) {
      const names = await fs.readdir(ticksDir(root, monitorId));
      if (names.some((name) => TICK_RECORD_PATTERN.test(name))) {
        if (alreadyLocked) {
          throw new ValidationError(
            `fact monitor ${monitorId}: tick records survive with no current.json while no publication can be in flight — an actual orphan of an interrupted first publication or pointer loss; this requires manual inspection. Refusing to guess a fresh monitor.`,
          );
        }
        // Cancellation-aware recheck: an aborted tick must exit PROMPTLY
        // with the typed cancellation, not sit out the lock deadline.
        if (options?.signal?.aborted) {
          throw new FactMonitorCancelledError(monitorId);
        }
        const lock = options?.lock ?? {};
        try {
          return await withSqliteTickLock(
            dir,
            monitorId,
            () => {
              if (options?.signal?.aborted) {
                throw new FactMonitorCancelledError(monitorId);
              }
              return loadFactMonitorStateInternal(root, monitorId, true, options);
            },
            {
              ...(lock.timeoutMs !== undefined ? { timeoutMs: lock.timeoutMs } : {}),
              ...(lock.setTimeout !== undefined ? { setTimeout: lock.setTimeout } : {}),
              ...(options?.signal !== undefined ? { signal: options.signal } : {}),
              label: "Fact monitor ambiguity recheck",
            },
          );
        } catch (error) {
          if (options?.signal?.aborted && error instanceof LockTimeoutError) {
            throw new FactMonitorCancelledError(monitorId);
          }
          throw error;
        }
      }
    }
    return { schemaVersion: 1, monitorId, definitionDigest: "", seq: 0, fields: {} };
  }
  if (currentInfo.isSymbolicLink() || !currentInfo.isFile()) {
    throw new ValidationError(
      `fact monitor ${monitorId}: current.json is not a regular file; refusing redirected state.`,
    );
  }
  let raw: unknown;
  try {
    const text = await readStateFileBounded(
      root,
      monitorId,
      filePath,
      `fact monitor ${monitorId} current.json`,
      options?.signal,
    );
    raw = JSON.parse(text);
  } catch (error) {
    if (error instanceof FactMonitorCancelledError || error instanceof ValidationError) throw error;
    throw new ValidationError(`fact monitor ${monitorId}: current.json is corrupt (unparseable).`);
  }
  const state = validateStateShape(raw, monitorId);

  // Owned ticks directory guards BOTH record reads and (in commit) record
  // writes — a symlinked ticks dir would redirect either.
  await requireOwnedDirectory(ticksDir(root, monitorId), `fact monitor ${monitorId} ticks directory`);

  // Reference agreement: validate the exact record the state names (with
  // the authoritative digest — the tip must have been written under the
  // state's definition identity even when no baseline cites the tip),
  // then resolve every accepted baseline (old records AND the tip)
  // against the engine artifact that produced it.
  const tipRecord = await readAndValidateCommitRecord(
    root,
    monitorId,
    state.commit!.seq,
    state.commit!.tickId,
    raw,
    state.definitionDigest,
    options?.signal,
  );
  await validateBaselineReferences(root, monitorId, state, tipRecord, options?.signal);
  return state;
}

/**
 * For every field's accepted baseline — whether it lives in an OLDER
 * record or the TIP record — the referenced record must: carry the
 * state's definition digest, agree on tickId/value/evidence ids in its
 * stateAfter, hold a satisfied engine row whose evidenceIds equal the
 * baseline's, and every evidence id must resolve to an evidence record
 * in that engine artifact. Bounded: one record per DISTINCT acceptedSeq,
 * never a history scan.
 */
async function validateBaselineReferences(
  root: string,
  monitorId: string,
  state: FactMonitorState,
  tipRecord: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<void> {
  const baselineSeqs = new Set<number>();
  for (const field of Object.values(state.fields)) {
    if (field.accepted !== undefined) baselineSeqs.add(field.accepted.acceptedSeq);
  }
  for (const baselineSeq of baselineSeqs) {
    const record: Record<string, unknown> =
      baselineSeq === state.commit!.seq
        ? tipRecord
        : await readAndValidateCommitRecord(root, monitorId, baselineSeq, null, null, undefined, signal);
    if (record.definitionDigest !== state.definitionDigest) {
      throw new ValidationError(`fact monitor ${monitorId}: baseline record ${baselineSeq} was accepted under a different definition digest.`);
    }
    const recordFields = (record.stateAfter as { fields?: Record<string, { accepted?: { value?: string; tickId?: string; evidenceIds?: readonly string[] } }> } | null)?.fields;
    const engineOutcome = record.engine as { kind?: string; result?: { requirements?: Record<string, { status?: string; value?: string; evidenceIds?: readonly string[] }>; evidence?: readonly { evidenceId?: string; url?: unknown; title?: unknown; content?: unknown; byteLength?: unknown; origins?: unknown }[] } } | undefined;
    for (const [fieldId, field] of Object.entries(state.fields)) {
      if (field.accepted === undefined || field.accepted.acceptedSeq !== baselineSeq) continue;
      if (record.tickId !== field.accepted.tickId) {
        throw new ValidationError(`fact monitor ${monitorId}: baseline record ${baselineSeq} disagrees with the accepted tick id for ${fieldId}.`);
      }
      const recordAccepted = recordFields?.[fieldId]?.accepted;
      if (recordAccepted?.value !== field.accepted.value ||
        JSON.stringify(recordAccepted?.evidenceIds ?? []) !== JSON.stringify(field.accepted.evidenceIds)) {
        throw new ValidationError(`fact monitor ${monitorId}: baseline record ${baselineSeq} does not carry the accepted value/evidence for ${fieldId}.`);
      }
      // The engine artifact of the accepting tick must have PRODUCED it:
      // result kind, accepted VALUE (both data and row), satisfied row
      // with the same evidence ids, and every cited id resolving to a
      // USABLE evidence record — not an ID-only stub.
      if (engineOutcome?.kind !== "result") {
        throw new ValidationError(`fact monitor ${monitorId}: baseline record ${baselineSeq} lacks the engine result that accepted ${fieldId}.`);
      }
      const row = engineOutcome.result?.requirements?.[fieldId];
      const acceptedDataValue = (engineOutcome.result as { data?: Record<string, unknown> })?.data?.[fieldId];
      if (row?.status !== "satisfied" || row.value !== field.accepted.value || acceptedDataValue !== field.accepted.value) {
        throw new ValidationError(`fact monitor ${monitorId}: baseline record ${baselineSeq} engine value does not match the accepted value for ${fieldId}.`);
      }
      if (JSON.stringify(row.evidenceIds ?? []) !== JSON.stringify(field.accepted.evidenceIds)) {
        throw new ValidationError(`fact monitor ${monitorId}: baseline record ${baselineSeq} engine row does not match the accepted evidence for ${fieldId}.`);
      }
      const byId = new Map((engineOutcome.result?.evidence ?? []).map((item) => [item.evidenceId, item]));
      for (const evidenceId of field.accepted.evidenceIds) {
        requireUsableEvidenceEntry(byId.get(evidenceId), evidenceId, `fact monitor ${monitorId}: ${fieldId} in record ${baselineSeq}`);
      }
    }
  }
}

/** Read and structurally validate one commit record — the COMPLETE
 *  lossless shape (identity, engine outcome, events, stateAfter), not
 *  just the fields the caller happens to need; strict identity checks
 *  (tickId/stateAfter byte-match/digest) apply when the state demands it. */
async function readAndValidateCommitRecord(
  root: string,
  monitorId: string,
  seq: number,
  expectedTickId: string | null,
  expectedStateAfter: unknown,
  expectedDigest?: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const recordPath = tickRecordPath(root, monitorId, seq);
  let recordRaw: unknown;
  try {
    const text = await readStateFileBounded(
      root,
      monitorId,
      recordPath,
      `fact monitor ${monitorId} tick record ${seq}`,
      signal,
    );
    recordRaw = JSON.parse(text);
  } catch (error) {
    if (error instanceof FactMonitorCancelledError || error instanceof ValidationError) throw error;
    throw new ValidationError(`fact monitor ${monitorId}: referenced tick record ${seq} is corrupt.`);
  }
  const record = requirePlainShape(
    recordRaw,
    `tick record ${seq}`,
    new Set(["schemaVersion", "monitorId", "tickId", "seq", "at", "definitionDigest", "engine", "events", "stateAfter"]),
    new Set([]),
  );
  if (record.schemaVersion !== 1) {
    throw new ValidationError(`fact monitor ${monitorId}: referenced tick record ${seq} has an unsupported schemaVersion.`);
  }
  if (record.seq !== seq || record.monitorId !== monitorId || typeof record.tickId !== "string" || record.tickId.length === 0 || typeof record.at !== "string") {
    throw new ValidationError(`fact monitor ${monitorId}: referenced tick record ${seq} disagrees with current.json.`);
  }
  if (typeof record.definitionDigest !== "string" || !DIGEST_PATTERN.test(record.definitionDigest)) {
    throw new ValidationError(`fact monitor ${monitorId}: referenced tick record ${seq} has an invalid definition digest.`);
  }
  if (expectedDigest !== undefined && record.definitionDigest !== expectedDigest) {
    throw new ValidationError(`fact monitor ${monitorId}: referenced tick record ${seq} was written under a different definition digest.`);
  }
  const engine = record.engine as Record<string, unknown> | undefined;
  if (typeof engine !== "object" || engine === null ||
    (engine.kind !== "result" && engine.kind !== "error") ||
    (engine.kind === "error" && typeof engine.reason !== "string") ||
    (engine.kind === "result" && (typeof engine.result !== "object" || engine.result === null))) {
    throw new ValidationError(`fact monitor ${monitorId}: referenced tick record ${seq} has a malformed engine outcome.`);
  }
  if (engine.kind === "result") {
    const result = engine.result as Record<string, unknown>;
    if (typeof result.requirements !== "object" || result.requirements === null ||
      typeof result.data !== "object" || result.data === null || !Array.isArray(result.evidence)) {
      throw new ValidationError(`fact monitor ${monitorId}: referenced tick record ${seq} has a malformed engine result.`);
    }
    // Minimum real LeanResult envelope — identity-level members only, no
    // deep protocol duplication: version, run status, question, and a
    // NON-EMPTY requirements map (the compiled contract always declares
    // at least one field, so an emptied map is truncated history even for
    // unresolved-only ticks; data/evidence may legitimately be empty).
    if (result.schemaVersion !== 1 ||
      (result.status !== "complete" && result.status !== "partial") ||
      typeof result.question !== "string" ||
      Object.keys(result.requirements as Record<string, unknown>).length === 0) {
      throw new ValidationError(`fact monitor ${monitorId}: referenced tick record ${seq} has a truncated engine result.`);
    }
    // Essential row envelope, including unresolved-only ticks: every
    // requirement row carries a valid status, requiredness and evidence
    // ids (the existing record contract — nothing deeper).
    for (const [rowId, row] of Object.entries(result.requirements as Record<string, unknown>)) {
      if (typeof row !== "object" || row === null ||
        ((row as { status?: unknown }).status !== "satisfied" && (row as { status?: unknown }).status !== "unresolved") ||
        typeof (row as { required?: unknown }).required !== "boolean" ||
        !Array.isArray((row as { evidenceIds?: unknown }).evidenceIds) ||
        (row as { evidenceIds?: unknown[] }).evidenceIds!.some((id) => typeof id !== "string")) {
        throw new ValidationError(`fact monitor ${monitorId}: referenced tick record ${seq} has a malformed requirements row ${rowId}.`);
      }
    }
  }
  if (!Array.isArray(record.events)) {
    throw new ValidationError(`fact monitor ${monitorId}: referenced tick record ${seq} has malformed events.`);
  }
  if (typeof record.stateAfter !== "object" || record.stateAfter === null) {
    throw new ValidationError(`fact monitor ${monitorId}: referenced tick record ${seq} has a malformed stateAfter.`);
  }
  const stateAfter = record.stateAfter as Record<string, unknown>;
  if (typeof stateAfter.fields !== "object" || stateAfter.fields === null || Array.isArray(stateAfter.fields)) {
    throw new ValidationError(`fact monitor ${monitorId}: referenced tick record ${seq} has a malformed stateAfter fields map.`);
  }
  const recordFields = stateAfter.fields as Record<string, unknown>;
  // Stored event entries must be actual transition records of THIS tick —
  // [null], kind-less objects, entries carrying another tick's identity
  // (schema/seq/tickId), wrong scope (a null field only for the
  // monitor-level `redefined`; per-field events naming a field this
  // record's state does not track) or a shifted timestamp are corruption.
  for (const event of record.events) {
    const entry = event as Record<string, unknown>;
    if (typeof event !== "object" || event === null ||
      entry.schemaVersion !== 1 ||
      entry.seq !== seq ||
      entry.tickId !== record.tickId ||
      (entry.fieldId !== null && typeof entry.fieldId !== "string") ||
      typeof entry.kind !== "string" ||
      !EVENT_KINDS.has(entry.kind) ||
      entry.at !== record.at ||
      (entry.kind === "redefined") !== (entry.fieldId === null) ||
      (entry.fieldId !== null && !Object.hasOwn(recordFields, entry.fieldId))) {
      throw new ValidationError(`fact monitor ${monitorId}: referenced tick record ${seq} has a malformed event entry.`);
    }
  }
  if (expectedTickId !== null && record.tickId !== expectedTickId) {
    throw new ValidationError(`fact monitor ${monitorId}: referenced tick record ${seq} disagrees with current.json.`);
  }
  if (expectedStateAfter !== null && JSON.stringify(record.stateAfter) !== JSON.stringify(expectedStateAfter)) {
    throw new ValidationError(`fact monitor ${monitorId}: referenced tick record ${seq} state does not match current.json.`);
  }
  return record;
}

// ---------------------------------------------------------------------------
// Prepare / commit
// ---------------------------------------------------------------------------

/**
 * Mint a fresh tick identity (fresh run id per tick, seed 03) against the
 * current state sequence. The definition is compiled FIRST (malformed ⇒
 * ValidationError before any state read) and frozen into a size-bounded,
 * deep-frozen JSON snapshot, so a caller mutating its object after
 * preparation cannot separate the digest from the evaluated contract.
 * No lock: the commit re-checks the base sequence under the lock, which
 * is the actual overlap guard.
 */
export async function prepareFactMonitorTick(
  root: string,
  monitorId: string,
  definition: object,
  options: FactMonitorOptions,
): Promise<PreparedFactMonitorTick> {
  requireMonitorId(monitorId);
  // Pre-flight depth/size BEFORE any recursive materialization; ONE
  // serialization provides the exact byte check, and the snapshot is
  // parsed from that already-bounded string.
  preflightDefinitionBounds(definition);
  const serialized = JSON.stringify(definition);
  if (Buffer.byteLength(serialized, "utf8") > MAX_FACT_MONITOR_DEFINITION_BYTES) {
    throw new ValidationError(
      `fact monitor ${monitorId}: definition exceeds the ${MAX_FACT_MONITOR_DEFINITION_BYTES}-byte ceiling.`,
    );
  }
  const snapshot: unknown = JSON.parse(serialized);
  const compiled = deepFreeze(compileLeanContract(deepFreeze(snapshot) as object));
  const digest = compiledContractDigest(compiled);
  const state = await loadFactMonitorState(root, monitorId, {
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(options.lock !== undefined ? { lock: options.lock } : {}),
  });
  return {
    monitorId,
    tickId: newRequestId(options.now),
    basedOnSeq: state.seq,
    definitionDigest: digest,
    definition: snapshot,
    compiled,
  };
}

interface FieldTickEvaluation {
  readonly events: FactMonitorEvent[];
  readonly next: FactMonitorFieldState;
  readonly report: FactMonitorFieldReport;
}

/** Pure per-field transition table (seed 03 "Transition semantics"). */
function evaluateField(
  fieldId: string,
  before: FactMonitorFieldState,
  outcome: { status: "satisfied" | "unresolved" | "error"; value?: string; reason?: string; evidenceIds: readonly string[] },
  tick: { seq: number; tickId: string; at: string },
): FieldTickEvaluation {
  const events: FactMonitorEvent[] = [];
  const base = { schemaVersion: 1 as const, seq: tick.seq, tickId: tick.tickId, at: tick.at, fieldId };
  const latest: LatestAttempt = {
    status: outcome.status,
    value: outcome.value,
    reason: outcome.reason,
    at: tick.at,
    seq: tick.seq,
    tickId: tick.tickId,
    evidenceIds: outcome.evidenceIds,
  };
  let accepted = before.accepted;
  let unresolvedSince = before.unresolvedSince;
  const oldRef = accepted !== undefined ? { oldValue: accepted.value, oldTickId: accepted.tickId, oldSeq: accepted.acceptedSeq } : {};

  if (outcome.status === "satisfied" && outcome.value !== undefined) {
    if (accepted === undefined) {
      events.push({ ...base, kind: "baseline_established", newValue: outcome.value, newEvidenceIds: outcome.evidenceIds });
      accepted = { value: outcome.value, acceptedAt: tick.at, acceptedSeq: tick.seq, tickId: tick.tickId, evidenceIds: outcome.evidenceIds };
    } else {
      if (unresolvedSince !== undefined) {
        events.push({ ...base, kind: "recovered", ...oldRef, newValue: outcome.value, oldEvidenceIds: accepted.evidenceIds, newEvidenceIds: outcome.evidenceIds });
        unresolvedSince = undefined;
      }
      if (!valuesEqual(accepted.value, outcome.value)) {
        events.push({ ...base, kind: "value_changed", ...oldRef, newValue: outcome.value, oldEvidenceIds: accepted.evidenceIds, newEvidenceIds: outcome.evidenceIds });
        accepted = { value: outcome.value, acceptedAt: tick.at, acceptedSeq: tick.seq, tickId: tick.tickId, evidenceIds: outcome.evidenceIds };
      } else if (!events.some((e) => e.kind === "recovered")) {
        events.push({ ...base, kind: "unchanged", newValue: outcome.value, newEvidenceIds: outcome.evidenceIds });
      }
    }
  } else {
    // Unresolved or errored attempt: the accepted baseline is preserved.
    if (accepted !== undefined && unresolvedSince === undefined && before.latest?.status === "satisfied") {
      events.push({ ...base, kind: "became_unresolved", ...oldRef, reason: outcome.reason });
      unresolvedSince = tick.at;
    } else {
      events.push({ ...base, kind: "unresolved_attempt", reason: outcome.reason, ...(accepted !== undefined ? oldRef : {}) });
    }
  }

  const next: FactMonitorFieldState = { accepted, unresolvedSince, latest };
  const report: FactMonitorFieldReport = {
    status: outcome.status,
    required: false,
    ...(outcome.value !== undefined && outcome.status === "satisfied" ? { value: outcome.value } : {}),
    ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
    events: events.map((event) => event.kind),
    ...(accepted !== undefined ? { lastAccepted: { value: accepted.value, acceptedAt: accepted.acceptedAt } } : {}),
  };
  return { events, next, report };
}

/** Bounded write: refuse to persist a record beyond the byte ceiling. */
function requireBoundedPayload(payload: string, label: string): string {
  if (Buffer.byteLength(payload, "utf8") > MAX_FACT_MONITOR_RECORD_BYTES) {
    throw new ValidationError(`fact monitor: ${label} exceeds the ${MAX_FACT_MONITOR_RECORD_BYTES}-byte record ceiling.`);
  }
  return payload;
}

/**
 * Commit one tick under the per-monitor lock. Rejections: a tick whose
 * basedOnSeq no longer matches state.seq is a LATE overlapping commit —
 * reported, nothing written, never able to regress a newer baseline. A
 * cancelled tick (signal fired before publication) throws
 * {@link FactMonitorCancelledError} and writes nothing. Once publication
 * starts it finishes coherently — no abort observation mid-write.
 *
 * Publication: tick record (lossless: engine outcome + events + complete
 * state after), then the current.json atomic replace — the commit point.
 * Directory creation is fsynced to its parent so first-commit durability
 * matches the helper's per-file guarantee. An interrupted write beyond
 * an intact pointer can be replaced on retry. An ambiguous first record
 * without a pointer requires manual inspection.
 */
export async function commitFactMonitorTick(
  root: string,
  prepared: PreparedFactMonitorTick,
  engineOutcome: FactMonitorEngineOutcome,
  options: FactMonitorOptions,
): Promise<FactMonitorTickReport> {
  requireMonitorId(prepared.monitorId);
  // Pre-existing owned root, then owned-path confinement before any lock
  // or write: a symlinked monitor/ticks directory would redirect the lock
  // file, the records and the state.
  if (!(await requireOwnedDirectory(root, "fact monitor root"))) {
    throw new ValidationError("fact monitor root does not exist; create it explicitly (this module never creates the root).");
  }
  await requireOwnedDirectory(monitorDir(root, prepared.monitorId), `fact monitor ${prepared.monitorId} directory`);
  // Fast cancellation path: an already-aborted tick never waits on the lock.
  if (options.signal?.aborted) {
    throw new FactMonitorCancelledError(prepared.monitorId);
  }
  const dir = monitorDir(root, prepared.monitorId);
  const lock = options.lock ?? {};
  try {
    return await commitUnderTickLock(root, prepared, engineOutcome, options, dir, lock);
  } catch (error) {
    // The lock's prompt abort (issue #47) surfaces as LockTimeoutError;
    // when the tick's own signal fired, that IS a cancellation.
    if (options.signal?.aborted && error instanceof LockTimeoutError) {
      throw new FactMonitorCancelledError(prepared.monitorId);
    }
    throw error;
  }
}

async function commitUnderTickLock(
  root: string,
  prepared: PreparedFactMonitorTick,
  engineOutcome: FactMonitorEngineOutcome,
  options: FactMonitorOptions,
  dir: string,
  lock: NonNullable<FactMonitorOptions["lock"]>,
): Promise<FactMonitorTickReport> {
  return withSqliteTickLock(
    dir,
    prepared.monitorId,
    async () => {
      // alreadyLocked=true: this critical section holds the tick lock, so
      // the ambiguity re-check must not re-acquire it.
      // Pre-publication locked load observes the tick signal: an abort in
      // this window is a typed cancellation, never a late-commit or
      // corruption report. (The post-publication reconciliation load in
      // the error triage deliberately stays UNSIGNALED — it reconciles
      // visibility and must not be cancelled mid-flight.)
      const state = await loadFactMonitorStateInternal(root, prepared.monitorId, true, {
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      });
      const paths = {
        current: currentPath(root, prepared.monitorId),
        ticksDir: ticksDir(root, prepared.monitorId),
        tickRecord: null as string | null,
      };
      // Cancellation observed after the locked state read and BEFORE the
      // stale-sequence return: an abort in that window is a cancellation,
      // never misreported as a clean late-commit rejection.
      if (options.signal?.aborted) {
        throw new FactMonitorCancelledError(prepared.monitorId);
      }
      if (state.seq !== prepared.basedOnSeq) {
        return {
          schemaVersion: 1 as const,
          monitorId: prepared.monitorId,
          tickId: prepared.tickId,
          seq: state.seq,
          definitionDigest: prepared.definitionDigest,
          committed: false,
          rejection: "late_commit" as const,
          fields: {},
          events: [],
          engine: engineOutcome.kind === "error" ? { status: "error" as const, reason: engineOutcome.reason } : { status: engineOutcome.result.status },
          paths,
        };
      }
      if (state.seq >= MAX_FACT_MONITOR_SEQUENCE) {
        throw new ValidationError(`fact monitor ${prepared.monitorId}: sequence ceiling reached; refusing to advance.`);
      }

      const seq = state.seq + 1;
      paths.tickRecord = tickRecordPath(root, prepared.monitorId, seq);
      const tick = { seq, tickId: prepared.tickId, at: toIso(options.now) };
      const events: FactMonitorEvent[] = [];
      const fields: Record<string, FactMonitorFieldState> = { ...state.fields };
      const reports: Record<string, FactMonitorFieldReport> = {};

      // Incompatible definition revision: re-baseline in place — never
      // compare values across digests, no spurious change events.
      if (state.definitionDigest !== "" && state.definitionDigest !== prepared.definitionDigest) {
        events.push({ schemaVersion: 1, seq, tickId: tick.tickId, at: tick.at, fieldId: null, kind: "redefined", definitionDigest: prepared.definitionDigest, oldValue: state.definitionDigest });
        for (const fieldId of Object.keys(fields)) delete fields[fieldId];
      }
      const definitionDigest = prepared.definitionDigest;

      // The COMPILED definition is the authority on the tracked field set
      // and each field's requiredness (compile materializes optional
      // defaults, so required:false survives); engine rows refine when
      // the run produced them, and a failed run still reports every
      // declared field as an unresolved attempt.
      const compiledFields = new Map(prepared.compiled.fields.map((field) => [field.id, field]));
      const fieldIds =
        engineOutcome.kind === "result"
          ? Object.keys(engineOutcome.result.requirements)
          : [...compiledFields.keys()];
      for (const fieldId of fieldIds) {
        const row = engineOutcome.kind === "result" ? engineOutcome.result.requirements[fieldId] : undefined;
        const outcome =
          row !== undefined && row.status === "satisfied" && engineOutcome.kind === "result" && engineOutcome.result.data[fieldId] !== undefined
            ? { status: "satisfied" as const, value: engineOutcome.result.data[fieldId], evidenceIds: row.evidenceIds }
            : {
                status: engineOutcome.kind === "error" ? ("error" as const) : ("unresolved" as const),
                reason:
                  engineOutcome.kind === "error"
                    ? engineOutcome.reason
                    : row?.reason ?? `requirement ${fieldId} unresolved`,
                evidenceIds: row?.evidenceIds ?? [],
              };
        const required = row?.required ?? compiledFields.get(fieldId)?.required ?? true;
        const evaluation = evaluateField(fieldId, fields[fieldId] ?? {}, outcome, tick);
        events.push(...evaluation.events);
        fields[fieldId] = evaluation.next;
        reports[fieldId] = { ...evaluation.report, required };
      }

      const nextState: FactMonitorState = {
        schemaVersion: 1,
        monitorId: prepared.monitorId,
        definitionDigest,
        seq,
        commit: { seq, tickId: prepared.tickId },
        fields,
      };

      // Cancellation boundary: the last observation of the signal. Past
      // this point publication runs to coherent completion.
      if (options.signal?.aborted) {
        throw new FactMonitorCancelledError(prepared.monitorId);
      }

      // Pre-publication candidate validation (write/load parity): apply
      // the SAME row/value/evidence checks the loader will apply, so a
      // self-inconsistent engine outcome is rejected HERE — the prior
      // committed state stays intact — instead of publishing a record
      // the next load refuses.
      if (engineOutcome.kind === "result") {
        const byId = new Map(engineOutcome.result.evidence.map((entry) => [entry.evidenceId, entry]));
        for (const [fieldId, field] of Object.entries(fields)) {
          if (field.accepted === undefined || field.accepted.acceptedSeq !== seq) continue;
          const row = engineOutcome.result.requirements[fieldId];
          if (row?.status !== "satisfied" ||
            row.value !== field.accepted.value ||
            engineOutcome.result.data[fieldId] !== field.accepted.value) {
            throw new ValidationError(
              `fact monitor ${prepared.monitorId}: refusing to publish — engine row/data value disagrees with the accepted value for ${fieldId}.`,
            );
          }
          if (JSON.stringify(row.evidenceIds ?? []) !== JSON.stringify(field.accepted.evidenceIds)) {
            throw new ValidationError(
              `fact monitor ${prepared.monitorId}: refusing to publish — engine row evidence disagrees with the accepted evidence for ${fieldId}.`,
            );
          }
          for (const evidenceId of field.accepted.evidenceIds) {
            requireUsableEvidenceEntry(
              byId.get(evidenceId),
              evidenceId,
              `fact monitor ${prepared.monitorId}: refusing to publish — ${fieldId}`,
            );
          }
        }
      }

      // Publication. 1) lossless per-tick record (an orphan left by a
      // crash before step 2 is unreferenced and simply replaced here).
      const record: FactMonitorTickRecord = {
        schemaVersion: 1,
        monitorId: prepared.monitorId,
        tickId: prepared.tickId,
        seq,
        at: tick.at,
        definitionDigest,
        engine: engineOutcome,
        events,
        stateAfter: nextState,
      };
      const recordPayload = requireBoundedPayload(`${JSON.stringify(record)}\n`, "tick record");
      const statePayload = requireBoundedPayload(`${JSON.stringify(nextState)}\n`, "monitor state");
      let durability: "confirmed" | "fsync-limited" | "visible-unconfirmed" =
        process.platform === "win32" ? "fsync-limited" : "confirmed";
      let recordWriteStarted = false;
      try {
        await fs.mkdir(paths.ticksDir, { recursive: true, mode: 0o700 });
        // Owned ticks directory as a WRITE guard too: a symlink planted
        // between load and publication must not redirect the record.
        await requireOwnedDirectory(paths.ticksDir, `fact monitor ${prepared.monitorId} ticks directory`);
        // Directory-entry durability BEFORE any payload write: a newly
        // created monitor dir / ticks dir must survive power loss for the
        // writes inside it to be meaningful.
        await syncDir(path.dirname(dir));
        await syncDir(dir);
        recordWriteStarted = true;
        await atomicReplaceFile(paths.tickRecord, recordPayload);
        await atomicReplaceFile(paths.current, statePayload);
      } catch (error) {
        // Only this attempt was allowed to write after the locked fresh-state read.
        if (recordWriteStarted && state.seq === 0 && seq === 1 && prepared.basedOnSeq === 0) {
          const cleanup = await reconcileOwnFirstPublicationRecord(prepared.monitorId, paths, recordPayload);
          if (cleanup === "cleaned") throw error;
          if (cleanup === "uncertain") throw new FactMonitorPublicationUncertainError(prepared.monitorId, error);
        }
        // Post-write reconciliation stays unsignaled so it can determine visibility.
        let observed: FactMonitorState | undefined;
        try {
          observed = await loadFactMonitorStateInternal(root, prepared.monitorId, true);
        } catch {
          observed = undefined;
        }
        if (observed !== undefined && observed.seq === seq && observed.commit?.tickId === prepared.tickId) {
          durability = "visible-unconfirmed";
        } else if (observed !== undefined && observed.seq === state.seq) {
          throw error; // definitely uncommitted — safe to reprepare and retry
        } else {
          throw new FactMonitorPublicationUncertainError(prepared.monitorId, error);
        }
      }

      return {
        schemaVersion: 1,
        monitorId: prepared.monitorId,
        tickId: prepared.tickId,
        seq,
        definitionDigest,
        committed: true,
        durability,
        ...(durability === "visible-unconfirmed"
          ? { durabilityWarning: "commit is visible but a post-rename step failed; do not retry this tick" }
          : durability === "fsync-limited"
            ? { durabilityWarning: "directory sync is skipped on this platform; power-loss durability narrows to rename atomicity" }
            : {}),
        fields: reports,
        events,
        engine: engineOutcome.kind === "error" ? { status: "error", reason: engineOutcome.reason } : { status: engineOutcome.result.status },
        paths,
      };
    },
    {
      ...(lock.timeoutMs !== undefined ? { timeoutMs: lock.timeoutMs } : {}),
      ...(lock.setTimeout !== undefined ? { setTimeout: lock.setTimeout } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      label: "Fact monitor tick",
    },
  );
}

/**
 * First-publication caught-failure reconciliation (runs INSIDE the held
 * tick lock). Provable-own cleanup of THIS attempt's tick-1 record:
 *  - the pointer must be provably ENOENT (a fresh lstat under the lock —
 *    any other pointer state returns "keep" and the ordinary triage
 *    decides, preserving visible/durability semantics);
 *  - tick-1.json, when present, must byte-match THIS attempt's exact
 *    record payload (the strongest identity: exact bytes — a
 *    pre-existing or foreign record NEVER matches and is NEVER deleted);
 *  - the record is removed and the ticks directory synced; a cleanup or
 *    sync failure is "uncertain" (typed uncertainty to the caller).
 * Absent record ⇒ "keep" (nothing of ours to clean; the triage decides).
 */
async function reconcileOwnFirstPublicationRecord(
  monitorId: string,
  paths: { readonly current: string; readonly ticksDir: string },
  exactRecordPayload: string,
): Promise<"cleaned" | "keep" | "uncertain"> {
  try {
    await fs.lstat(paths.current);
    return "keep"; // pointer EXISTS (visible): ordinary triage owns this case
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      return "keep"; // unknown pointer state: not provable — triage decides
    }
  }
  const recordPath = path.join(paths.ticksDir, "tick-1.json");
  let observedBytes: Buffer | undefined;
  try {
    if (!(await requireOwnedDirectory(paths.ticksDir, `fact monitor ${monitorId} ticks directory`))) return "keep";
    observedBytes = await readOwnedBytesBoundedIfExists(recordPath, `fact monitor ${monitorId} own tick record 1`, MAX_FACT_MONITOR_RECORD_BYTES);
  } catch {
    return "keep"; // absent/unreadable: nothing provably ours to clean
  }
  if (observedBytes === undefined || !observedBytes.equals(Buffer.from(exactRecordPayload, "utf8"))) {
    return "keep"; // pre-existing or foreign bytes: NEVER deleted
  }
  try {
    await fs.unlink(recordPath);
    await syncDir(paths.ticksDir);
    return "cleaned";
  } catch {
    return "uncertain";
  }
}

/**
 * One complete user-requested tick over one fact: prepare → one bounded
 * engine run → commit. Engine deps are passed through UNCHANGED,
 * including the engine's own clock (the monitor records its state
 * timestamps from options.now). Cancellation is NORMALIZED: the tick
 * signal is options.signal when supplied, otherwise the engine deps'
 * own externalSignal — either source cancels the engine run and
 * prevents publication. Engine failures become unresolved attempts (the
 * accepted baseline is preserved, never replaced by a failed current
 * answer). For deterministic overlap control, call prepare / commit
 * directly instead.
 */
export async function runFactMonitorTick(
  root: string,
  monitorId: string,
  definition: object,
  deps: LeanDeps,
  options: FactMonitorOptions,
): Promise<FactMonitorTickReport> {
  // ONE normalized signal from EVERY source: the tick option AND the
  // engine deps' external signal merged with AbortSignal.any, so aborting
  // either cancels input reading, dispatch, the lock and publication.
  const signal = mergeSignals([options.signal, deps.externalSignal]);
  const normalized: FactMonitorOptions = signal === undefined ? options : { ...options, signal };
  const prepared = await prepareFactMonitorTick(root, monitorId, definition, normalized);
  let engineOutcome: FactMonitorEngineOutcome;
  try {
    // Pass deps through UNCHANGED when no override is needed. When the
    // external signal must be set/merged, wrap the ORIGINAL object in a
    // receiver-preserving facade: a Proxy over a FRESH target that owns
    // only the replacement externalSignal. Proxy get-invariants bind to
    // the TARGET, so a fully FROZEN deps object (non-writable,
    // non-configurable own methods and externalSignal) works too — the
    // facade never claims frozen properties it returns differently.
    // Every method is returned BOUND to the original receiver, so class
    // methods using #private fields and getters keep working (a clone —
    // spread or Object.create+assign — breaks private-field access and
    // the run would fail inside deps.now()).
    const engineDeps: LeanDeps =
      normalized.signal === undefined || deps.externalSignal === normalized.signal
        ? deps
        : (new Proxy({ externalSignal: normalized.signal } as object, {
            get(target, property) {
              if (property === "externalSignal") return Reflect.get(target, property, target);
              const value = Reflect.get(deps, property, deps);
              return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(deps) : value;
            },
            has(_target, property) {
              return property === "externalSignal" ? true : property in deps;
            },
            ownKeys() {
              return Reflect.ownKeys(deps);
            },
            getOwnPropertyDescriptor(_target, property) {
              if (property === "externalSignal") return { configurable: true, enumerable: true, writable: true, value: normalized.signal };
              const descriptor = Reflect.getOwnPropertyDescriptor(deps, property);
              // Report as configurable so the proxy's bound-method reads
              // never violate the non-configurable-property invariants.
              return descriptor === undefined ? undefined : { ...descriptor, configurable: true };
            },
          }) as LeanDeps);
    const result = await runLeanInvestigation(prepared.definition, engineDeps);
    engineOutcome = { kind: "result", result };
  } catch (error) {
    if (normalized.signal?.aborted) {
      // The cancellation that failed the engine also stops the tick —
      // a user cancellation must not be recorded as an unresolved attempt.
      throw new FactMonitorCancelledError(monitorId);
    }
    engineOutcome = {
      kind: "error",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  return commitFactMonitorTick(root, prepared, engineOutcome, normalized);
}
