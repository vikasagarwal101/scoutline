/**
 * Retained investigation record store — caller-assisted engine ticket 1
 * (retained-records). Corrected per cold review (see ticket cold-review).
 *
 * Authoritative local record library: immutable revision snapshots,
 * content-addressed shared body files, a small atomically replaced manifest,
 * kernel-verified local-owner exclusion (no age-based takeover), explicit
 * acknowledge/delete-only recovery, and actual-byte store/record admission
 * (32MiB record / 256MiB store / 64KiB settlement reserve).
 *
 * == Ownership: abstract-namespace Unix socket gate (Linux) ==
 *
 * Exclusive mutation ownership is a bound abstract Unix socket whose name is
 * derived from the PHYSICAL record directory (root canonicalized through
 * realpath; every component between root and record symlink-checked). The
 * KERNEL is the serialization authority — `bind(2)` is atomically exclusive;
 * the name exists exactly while the owning process lives. Two lexical root
 * aliases therefore derive the SAME gate name: one physical record, one
 * owner.
 *
 * `owner.lock` on disk is advisory metadata (pid/bootId/starttime/generation)
 * written AFTER the gate is held, best-effort; the socket is the authority.
 * It is removed while the gate is still held, before close. On non-Linux
 * platforms mutation is refused (OwnerUncertainError) — conservative.
 *
 * == Handle lifetime (release cannot end exclusion mid-write) ==
 *
 * Every owned write increments a pending counter; `release()` drains all
 * pending writes BEFORE closing the gate, so a successor can never be
 * admitted while an owned write is still in flight. Handle mutations are
 * serialized through an operation chain (no read-modify-write interleaving
 * on marker/audit documents) and each refuses after release.
 *
 * == Admission (store/record actual-byte caps) ==
 *
 * Every owned write runs ENTIRELY under the store admission gate: serialized
 * actual-byte measure → cap check (charging the write's final bytes) → the
 * write itself → serialized re-measure. Because materialization happens with
 * the gate held, a concurrent owner's pre-write check always sees the first
 * writer's materialized bytes and refuses BEFORE writing — persistent actual
 * bytes never exceed the caps, including across a crash (a killed owner
 * releases the kernel gate; its materialized bytes remain counted).
 *
 * The settlement reserve is MATERIALIZED: beginRound writes a real
 * `reserve.settlement` file (settlementReserveBytes) inside the record
 * through the same charged admission path, so it is globally counted by the
 * actual-byte walk across all records until it is consumed exactly once —
 * by settlement, acknowledgment, or deletion. No handle-local arithmetic:
 * two records can never both reserve when only one reserve fits, and a
 * crashed owner's reserve stays counted until explicit safe handling.
 *
 * On-disk layout under the injected owned root:
 *
 *   <root>/investigations/inv_<32hex>/
 *     requirements.json      retained requirements (digest source)
 *     store.json             manifest: last committed revision
 *     revisions/r<n>.json    revision snapshots (immutable once written)
 *     bodies/<sha256hex>.bin content-addressed shared bodies (deduped)
 *     audit/round-<id>.json  per-round bounded audit rows (never replaced
 *                            by settlement)
 *     audit/settlement-<id>.json  round settlement summary (separate file)
 *     owner.lock             owner metadata (advisory; socket is authority)
 *     incomplete.json        pre-dispatch incomplete-round marker
 *     reserve.settlement     materialized settlement reservation (written at
 *                            beginRound, consumed exactly once by settlement,
 *                            acknowledgment or deletion; counts against caps)
 *     DELETION-INCOMPLETE.json  partial-deletion tombstone
 */

import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import net from "node:net";
import * as path from "node:path";
import { atomicPlaceNoClobber } from "./artifacts.js";
import { atomicReplaceFile } from "./config-store.js";
import { ScoutlineError } from "./errors.js";

// ---------------------------------------------------------------------------
// Bounds (production defaults; openStore accepts test overrides of the
// thresholds only — measurement is always an actual st_size walk)
// ---------------------------------------------------------------------------

export const RECORD_MAX_BYTES = 32 * 1024 * 1024;
export const STORE_MAX_BYTES = 256 * 1024 * 1024;
export const SETTLEMENT_RESERVE_BYTES = 64 * 1024;
export const BODY_MAX_BYTES = 16 * 1024;
export const REQUIREMENTS_MAX_BYTES = 16 * 1024;
export const SNAPSHOT_MAX_BYTES = 256 * 1024;
export const AUDIT_MAX_ROWS = 256;
export const AUDIT_ROW_MAX_DETAIL_BYTES = 2 * 1024;
/** Owner identifiers are UUIDs; bound the marker's owner string. */
export const OWNER_ID_MAX_BYTES = 64;
const FIELD_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const REF_RE = /^inv_[0-9a-f]{32}$/;
const ROUND_ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
/** Abstract-namespace socket name limit (108 bytes incl. NUL on Linux). */
const ABSTRACT_NAME_BUDGET = 107;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class StoreCapacityError extends ScoutlineError {
  constructor(message: string) {
    super(message, "STORE_CAPACITY", { exitCode: 1 });
    this.name = "StoreCapacityError";
  }
}
export class OwnerBusyError extends ScoutlineError {
  constructor(message: string) {
    super(message, "OWNER_BUSY", { exitCode: 1 });
    this.name = "OwnerBusyError";
  }
}
export class OwnerUncertainError extends ScoutlineError {
  constructor(message: string) {
    super(message, "OWNER_UNCERTAIN", { exitCode: 1 });
    this.name = "OwnerUncertainError";
  }
}
export class ExpectedRevisionError extends ScoutlineError {
  constructor(message: string) {
    super(message, "EXPECTED_REVISION", { exitCode: 1 });
    this.name = "ExpectedRevisionError";
  }
}
export class CorruptRecordError extends ScoutlineError {
  constructor(message: string) {
    super(message, "CORRUPT_RECORD", { exitCode: 1 });
    this.name = "CorruptRecordError";
  }
}
export class CorruptContentError extends ScoutlineError {
  constructor(message: string) {
    super(message, "CORRUPT_CONTENT", { exitCode: 1 });
    this.name = "CorruptContentError";
  }
}
export class InvalidReferenceError extends ScoutlineError {
  constructor(message: string) {
    super(message, "INVALID_REFERENCE", { exitCode: 1 });
    this.name = "InvalidReferenceError";
  }
}
export class InvalidRecordInputError extends ScoutlineError {
  constructor(message: string) {
    super(message, "INVALID_RECORD_INPUT", { exitCode: 1 });
    this.name = "InvalidRecordInputError";
  }
}
export class UnacknowledgedInterruptionError extends ScoutlineError {
  constructor(message: string) {
    super(message, "UNACKNOWLEDGED_INTERRUPTION", { exitCode: 1 });
    this.name = "UnacknowledgedInterruptionError";
  }
}
export class DeletionIncompleteError extends ScoutlineError {
  constructor(message: string) {
    super(message, "DELETION_INCOMPLETE", { exitCode: 1 });
    this.name = "DeletionIncompleteError";
  }
}

// ---------------------------------------------------------------------------
// Injectable seams
// ---------------------------------------------------------------------------

export interface OwnerIdentity {
  readonly pid: number;
  readonly bootId: string;
  readonly procStartTicks: string;
}

export interface RetainedStoreDeps {
  /** Single write funnel for every store file (fault-injection seam). */
  writeFileAtomic?(filePath: string, contents: string | Uint8Array): Promise<void>;
  /** Recursive removal funnel for deletion (fault-injection seam). */
  removeTree?(dir: string): Promise<void>;
  clock?(): number;
  /** Override the abstract-socket gate (tests / platform substitution). */
  gateFactory?(name: string): Promise<Gate>;
  randomId?(): string;
}

/** Kernel-exclusive gate handle. */
export interface Gate {
  /** Kernel-authoritative probe: is the name currently held by ANY process? */
  isHeld(): Promise<boolean>;
  /** Bind exclusively; false = name already held. */
  tryAcquire(): Promise<boolean>;
  /** Release our binding (idempotent). */
  release(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Native abstract-socket gate (Linux)
// ---------------------------------------------------------------------------

class AbstractSocketGate implements Gate {
  private server: net.Server | null = null;
  constructor(private readonly name: string) {}

  private probe(): Promise<boolean> {
    return new Promise((resolve) => {
      const sock = net.connect({ path: this.name });
      sock.once("connect", () => {
        sock.destroy();
        resolve(true);
      });
      sock.once("error", () => resolve(false));
    });
  }

  async isHeld(): Promise<boolean> {
    return this.probe();
  }

  tryAcquire(): Promise<boolean> {
    return new Promise((resolve) => {
      const server = net.createServer(() => {});
      server.once("error", () => {
        // EADDRINUSE = held by another process. Any other bind failure is
        // also reported as "not acquired": refusal (OwnerBusyError) is the
        // conservative direction — we never proceed on an uncertain gate.
        resolve(false);
      });
      server.listen({ path: this.name }, () => {
        this.server = server;
        resolve(true);
      });
    });
  }

  async release(): Promise<void> {
    if (this.server !== null) {
      await new Promise<void>((resolve) => this.server?.close(() => resolve()));
      this.server = null;
    }
  }
}

function defaultGateFactory(name: string): Promise<Gate> {
  return Promise.resolve(new AbstractSocketGate(name));
}

/**
 * Derive a stable abstract-namespace name from a PHYSICAL record path (the
 * caller must have canonicalized it). Abstract names must fit 108 bytes
 * including the leading NUL; hash the full path to stay under budget while
 * remaining collision-resistant and deterministic.
 */
function gateNameFor(physicalDir: string, kind: string): string {
  const h = createHash("sha256").update(`${kind}:${physicalDir}`).digest("hex").slice(0, 48);
  return `\0zai-rrs-${kind}-${h}`;
}

// ---------------------------------------------------------------------------
// Record shapes
// ---------------------------------------------------------------------------

export interface RequirementsInput {
  readonly schemaVersion: 1;
  readonly fields: Readonly<Record<string, { definition: string; required: boolean }>>;
}

export interface BodyInput {
  readonly label?: string;
  readonly content: string;
}

export interface RetainedBodyRef {
  readonly bodyId: string;
  readonly digest: string;
  readonly bytes: number;
  readonly label?: string;
  readonly claimedSource?: string;
}

export interface AuditRow {
  readonly at: number;
  readonly kind: string;
  readonly detail: string;
}

export interface RoundAccountingRow {
  readonly roundId: string;
  readonly intent: "start" | "continue";
  readonly settledAt: number | null;
  readonly stopReason?: string;
  readonly usage: { searches: number; reads: number; judgments: number } | null;
}

export interface RevisionSnapshot {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly parentRevision: number | null;
  readonly createdAt: number;
  readonly requirementsDigest: string;
  readonly bodies: readonly RetainedBodyRef[];
  readonly rounds: readonly RoundAccountingRow[];
  readonly outcome?: {
    readonly status: "complete" | "partial";
    readonly data: Readonly<Record<string, string>>;
    readonly evidence: readonly {
      evidenceId: string;
      url: string;
      title: string;
      byteLength: number;
      origins: readonly string[];
    }[];
  };
  readonly audit: readonly AuditRow[];
}

export interface SettlementSummary {
  readonly status: "complete" | "partial" | "failed";
  readonly measured: { searches: number; reads: number; judgments: number };
  readonly uncertainty: string | null;
}

// ---------------------------------------------------------------------------
// /proc owner metadata (advisory identity recorded alongside the gate)
// ---------------------------------------------------------------------------

async function readProcStartTicks(pid: number): Promise<string | null> {
  let text: string;
  try {
    text = await fs.readFile(`/proc/${pid}/stat`, "utf8");
  } catch {
    return null;
  }
  const close = text.lastIndexOf(")");
  if (close === -1) return null;
  const tokens = text.slice(close + 2).split(/\s+/);
  const ticks = tokens[22 - 3];
  return ticks !== undefined && /^\d+$/.test(ticks) ? ticks : null;
}

async function readBootId(): Promise<string | null> {
  try {
    const text = await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8");
    const trimmed = text.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

interface OwnerMetadata {
  readonly schemaVersion: 1;
  readonly ownerId: string;
  readonly pid: number;
  readonly bootId: string;
  readonly procStartTicks: string;
  readonly generation: number;
  readonly acquiredAt: number;
}

async function writeOwnerMetadata(
  deps: RetainedStoreDeps,
  dir: string,
  ownerId: string,
  write: (p: string, c: string) => Promise<void>,
): Promise<OwnerMetadata> {
  const now = deps.clock ?? Date.now;
  const bootId = await readBootId();
  const procStartTicks = await readProcStartTicks(process.pid);
  const meta: OwnerMetadata = {
    schemaVersion: 1,
    ownerId,
    pid: process.pid,
    bootId: bootId ?? "unknown",
    procStartTicks: procStartTicks ?? "unknown",
    generation: now(),
    acquiredAt: now(),
  };
  await write(path.join(dir, "owner.lock"), JSON.stringify(meta));
  return meta;
}

// ---------------------------------------------------------------------------
// Actual-byte measurement (lstat walk; symlinks never followed or counted)
// ---------------------------------------------------------------------------

async function measureTree(dir: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
  for (const entry of entries) {
    const child = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue; // never follow, never count
    if (entry.isDirectory()) {
      total += await measureTree(child);
    } else if (entry.isFile()) {
      const stat = await fs.lstat(child);
      total += stat.size;
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// Owned-file reads (regular files only — a symlink is never followed)
// ---------------------------------------------------------------------------

/**
 * Bounded retained read: the byte ceiling is enforced BEFORE allocation/parse
 * (latest-correctness P2), never after an unbounded readFile. Every retained
 * store document routes through this one helper; symlinks are never followed.
 */
async function readOwnedRegularFileBounded(p: string, maxBytes: number): Promise<Buffer> {
  const stat = await fs.lstat(p);
  if (!stat.isFile()) {
    throw new CorruptContentError(`Retained file is not a regular file: ${p}`) as Error &
      NodeJS.ErrnoException;
  }
  // Fast path: reject a file that is already over the ceiling before opening
  // (an optimization/early rejection only — growth after this is still caught
  // by the incremental counter below).
  if (stat.size > maxBytes) {
    throw new CorruptRecordError(`Retained file exceeds ${maxBytes} bytes: ${p} (${stat.size}).`);
  }
  // Incremental bounded read (Opus closure G3): the byte ceiling is enforced
  // by an ACTIVE counter during the read, so a concurrent writer cannot grow
  // the file between the stat precheck and the read and cause an unbounded
  // allocation/parse. We read at most maxBytes+1 bytes; the +1 proves overflow
  // without ever buffering more than the ceiling.
  const handle = await fs.open(p, "r");
  try {
    const buf = Buffer.alloc(maxBytes + 1);
    let total = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buf, total, maxBytes + 1 - total, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) {
        throw new CorruptRecordError(`Retained file exceeds ${maxBytes} bytes: ${p} (grew past the bound).`);
      }
    }
    return buf.subarray(0, total);
  } finally {
    await handle.close().catch(() => {});
  }
}

async function readOwnedRegularFile(p: string): Promise<Buffer> {
  return readOwnedRegularFileBounded(p, SNAPSHOT_MAX_BYTES);
}

async function readOwnedRegularText(p: string): Promise<string> {
  return (await readOwnedRegularFile(p)).toString("utf8");
}

/**
 * Read a retained file, refusing SYMLINKED INTERMEDIATE components between
 * the trusted anchor (the physical record directory) and the file: a
 * swapped `bodies`/`revisions`/`audit` directory must never leak caller
 * bytes into a verified read, even when leaf file + digest match.
 */
async function readOwnedRegularUnder(anchor: string, p: string): Promise<Buffer> {
  await assertNoSymlinkComponents(anchor, p);
  return readOwnedRegularFile(p);
}

async function readOwnedTextUnder(anchor: string, p: string): Promise<string> {
  return (await readOwnedRegularUnder(anchor, p)).toString("utf8");
}

// ---------------------------------------------------------------------------
// Path resolution / validation
// ---------------------------------------------------------------------------

function validateRef(ref: string): string {
  if (typeof ref !== "string" || !REF_RE.test(ref)) {
    throw new InvalidReferenceError(`Invalid investigation reference: ${String(ref)}`);
  }
  return ref;
}

function validateRoundId(roundId: string): string {
  if (typeof roundId !== "string" || !ROUND_ID_RE.test(roundId)) {
    throw new InvalidRecordInputError(
      `roundId must match ${ROUND_ID_RE.toString()} (path-safe, 1..64 characters).`,
    );
  }
  return roundId;
}

/** Complete incomplete-marker shape (the one lifecycle contract). */
interface IncompleteMarker {
  schemaVersion: 1;
  roundId: string;
  intent: "start" | "continue";
  ownerId: string;
  startedAt: number;
  revisionBase: number;
  settled: boolean;
}

/**
 * The ONE complete bounded marker reader shared by beginRound, every
 * mutating lifecycle step, and inspection (fresh F3): a marker with any
 * missing/ill-typed field is CorruptRecordError, never an active round.
 */
async function readIncompleteMarker(dir: string): Promise<IncompleteMarker> {
  const text = await readOwnedTextUnder(dir, path.join(dir, "incomplete.json"));
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new CorruptRecordError("Incomplete marker corrupt; delete-only recovery.");
    }
    throw err;
  }
  if (
    !isPlainObject(parsed) ||
    parsed.schemaVersion !== 1 ||
    typeof parsed.roundId !== "string" ||
    (parsed.intent !== "start" && parsed.intent !== "continue") ||
    typeof parsed.ownerId !== "string" ||
    parsed.ownerId.length === 0 ||
    parsed.ownerId.length > OWNER_ID_MAX_BYTES ||
    typeof parsed.startedAt !== "number" ||
    !Number.isFinite(parsed.startedAt) ||
    parsed.startedAt < 0 ||
    !Number.isInteger(parsed.revisionBase) ||
    (parsed.revisionBase as number) < 0 ||
    typeof parsed.settled !== "boolean"
  ) {
    throw new CorruptRecordError("Incomplete marker corrupt; delete-only recovery.");
  }
  try {
    validateRoundId(parsed.roundId);
  } catch {
    throw new CorruptRecordError("Incomplete marker roundId invalid; delete-only recovery.");
  }
  return {
    schemaVersion: 1,
    roundId: parsed.roundId,
    intent: parsed.intent as "start" | "continue",
    ownerId: parsed.ownerId,
    startedAt: parsed.startedAt,
    revisionBase: parsed.revisionBase as number,
    settled: parsed.settled,
  };
}

/**
 * One complete marker check shared by every mutator and ACK (latest-correctness
 * P1): the marker must be well-formed AND its base must be consistent with the
 * committed revision (an impossible base is corrupted state, never blessable).
 */
async function validateMarkerAgainstCommitted(dir: string, marker: IncompleteMarker): Promise<void> {
  const manifestText = await readOwnedTextUnder(dir, path.join(dir, "store.json")).catch(() => null);
  let committed: number | null = null;
  if (manifestText !== null) {
    try {
      const m = JSON.parse(manifestText) as Record<string, unknown>;
      if (
        typeof m === "object" &&
        m !== null &&
        typeof m.committedRevision === "number" &&
        Number.isInteger(m.committedRevision) &&
        m.committedRevision >= 0
      ) {
        committed = m.committedRevision;
      }
    } catch {
      committed = null;
    }
  }
  if (committed === null) {
    throw new CorruptRecordError("Marker revision base cannot be verified against a committed revision.");
  }
  if (marker.revisionBase !== committed) {
    throw new CorruptRecordError(
      `Marker revisionBase ${marker.revisionBase} does not match committed revision ${committed}.`,
    );
  }
}

/** Header of a materialized settlement reserve (written at beginRound). */
async function readIncompleteReserve(
  dir: string,
  reservePath: string,
  configuredReserveBytes: number,
): Promise<{ roundId: string; ownerId: string; reserveBytes: number } | null> {
  const buf = await readOwnedRegularUnder(dir, reservePath).catch((err) => {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  });
  if (buf === null) return null;
  // A reservation is provisioned physical headroom: it must be exactly the
  // INSTANCE-configured reserve size (Opus closure G2 — never the module
  // constant, which would reject a legitimate override). A truncated/partial
  // reservation is corrupt, not free headroom (latest-correctness new-07).
  if (buf.length !== configuredReserveBytes) {
    throw new CorruptRecordError(
      `Reservation ${path.basename(reservePath)} has ${buf.length} bytes, expected ${configuredReserveBytes}.`,
    );
  }
  // The reserve is a zero-padded buffer whose head is a canonical JSON
  // header; find its end (first NUL) and parse.
  const end = buf.indexOf(0);
  const headerText = (end === -1 ? buf : buf.subarray(0, end)).toString("utf8");
  try {
    const parsed = JSON.parse(headerText) as Record<string, unknown>;
    if (
      !isPlainObject(parsed) ||
      parsed.kind !== "settlement-reserve" ||
      typeof parsed.roundId !== "string" ||
      typeof parsed.ownerId !== "string" ||
      typeof parsed.reserveBytes !== "number"
    ) {
      return null;
    }
    return {
      roundId: parsed.roundId,
      ownerId: parsed.ownerId,
      reserveBytes: parsed.reserveBytes,
    };
  } catch {
    return null;
  }
}

function validateBodyId(bodyId: string): string {
  const hex = bodyId.startsWith("b:") ? bodyId.slice(2) : "";
  if (!SHA256_HEX_RE.test(hex)) {
    throw new InvalidReferenceError(`Invalid body reference: ${String(bodyId)}`);
  }
  return hex;
}

function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value);
}

/** Any symlink anywhere inside the record tree → damage (bounded walk). */
async function recordContainsSymlink(dir: string): Promise<boolean> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) return true;
    if (entry.isDirectory() && (await recordContainsSymlink(path.join(dir, entry.name)))) {
      return true;
    }
  }
  return false;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

async function isSymlink(p: string): Promise<boolean> {
  try {
    return (await fs.lstat(p)).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Assert every existing path component from `from` (inclusive, already
 * physical) down to `to` is a real directory — no symlinks anywhere in the
 * chain. ENOENT components below the last existing one are allowed (the
 * caller decides whether the final path must exist).
 */
async function assertNoSymlinkComponents(from: string, to: string): Promise<void> {
  const rel = path.relative(from, to);
  if (rel.startsWith("..")) {
    throw new InvalidReferenceError(`Record path escapes the owned root: ${to}`);
  }
  let cur = from;
  const segments = rel.split(path.sep).filter((s) => s.length > 0);
  for (const segment of segments) {
    cur = path.join(cur, segment);
    let stat;
    try {
      stat = await fs.lstat(cur);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return; // deeper = nonexistent
      throw err;
    }
    if (stat.isSymbolicLink()) {
      throw new InvalidReferenceError(`Record path traverses a symlink: ${cur}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Bounded snapshot schema validation (shared: create / commit / reopen)
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validateUsage(v: unknown, label: string): void {
  if (v === null) return;
  if (!isPlainObject(v)) throw new CorruptRecordError(`${label}: usage must be an object or null.`);
  for (const key of ["searches", "reads", "judgments"] as const) {
    const n = v[key];
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {
      throw new CorruptRecordError(`${label}: usage.${key} must be a non-negative integer.`);
    }
  }
}

function validateSnapshotShape(snapshot: unknown, revision: number): RevisionSnapshot {
  if (!isPlainObject(snapshot)) {
    throw new CorruptRecordError(`Revision r${revision} is not an object.`);
  }
  if (snapshot.schemaVersion !== 1 || snapshot.revision !== revision) {
    throw new CorruptRecordError(`Revision r${revision} malformed header.`);
  }
  if (revision === 0) {
    if (snapshot.parentRevision !== null) {
      throw new CorruptRecordError("Revision r0 parentRevision must be null.");
    }
  } else if (snapshot.parentRevision !== revision - 1) {
    throw new CorruptRecordError(`Revision r${revision} parentRevision must be ${revision - 1}.`);
  }
  if (typeof snapshot.createdAt !== "number" || !Number.isFinite(snapshot.createdAt) || snapshot.createdAt <= 0) {
    throw new CorruptRecordError(`Revision r${revision} createdAt malformed.`);
  }
  if (
    typeof snapshot.requirementsDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(snapshot.requirementsDigest)
  ) {
    throw new CorruptRecordError(`Revision r${revision} requirementsDigest malformed.`);
  }
  if (!Array.isArray(snapshot.bodies) || snapshot.bodies.length > 4096) {
    throw new CorruptRecordError(`Revision r${revision} bodies must be a bounded array.`);
  }
  for (const body of snapshot.bodies) {
    if (!isPlainObject(body)) throw new CorruptRecordError(`Revision r${revision} body malformed.`);
    let hex = "";
    if (typeof body.bodyId === "string" && body.bodyId.startsWith("b:")) hex = body.bodyId.slice(2);
    if (!SHA256_HEX_RE.test(hex)) {
      throw new CorruptRecordError(`Revision r${revision} body id malformed.`);
    }
    if (body.digest !== `sha256:${hex}`) {
      throw new CorruptRecordError(`Revision r${revision} body digest malformed.`);
    }
    if (
      typeof body.bytes !== "number" ||
      !Number.isInteger(body.bytes) ||
      body.bytes <= 0 ||
      body.bytes > BODY_MAX_BYTES
    ) {
      throw new CorruptRecordError(`Revision r${revision} body bytes malformed.`);
    }
  }
  if (!Array.isArray(snapshot.rounds) || snapshot.rounds.length > 4096) {
    throw new CorruptRecordError(`Revision r${revision} rounds must be a bounded array.`);
  }
  for (const round of snapshot.rounds) {
    if (!isPlainObject(round)) throw new CorruptRecordError(`Revision r${revision} round malformed.`);
    try {
      validateRoundId(round.roundId as string);
    } catch {
      throw new CorruptRecordError(`Revision r${revision} round id malformed.`);
    }
    if (round.intent !== "start" && round.intent !== "continue") {
      throw new CorruptRecordError(`Revision r${revision} round intent malformed.`);
    }
    if (
      round.settledAt !== null &&
      (typeof round.settledAt !== "number" || !Number.isFinite(round.settledAt) || round.settledAt <= 0)
    ) {
      throw new CorruptRecordError(`Revision r${revision} round settledAt malformed.`);
    }
    validateUsage(round.usage, `Revision r${revision} round ${String(round.roundId)}`);
  }
  if (!Array.isArray(snapshot.audit) || snapshot.audit.length > AUDIT_MAX_ROWS) {
    throw new CorruptRecordError(`Revision r${revision} audit must be a bounded array.`);
  }
  for (const row of snapshot.audit) {
    if (
      !isPlainObject(row) ||
      typeof row.at !== "number" ||
      typeof row.kind !== "string" ||
      row.kind.length === 0 ||
      row.kind.length > 64 ||
      typeof row.detail !== "string" ||
      Buffer.from(row.detail, "utf8").length > AUDIT_ROW_MAX_DETAIL_BYTES
    ) {
      throw new CorruptRecordError(`Revision r${revision} audit row malformed.`);
    }
  }
  if (snapshot.outcome !== undefined) {
    const outcome = snapshot.outcome;
    if (
      !isPlainObject(outcome) ||
      (outcome.status !== "complete" && outcome.status !== "partial") ||
      !isPlainObject(outcome.data) ||
      Object.values(outcome.data).some((v) => typeof v !== "string") ||
      !Array.isArray(outcome.evidence) ||
      outcome.evidence.length > 4096
    ) {
      throw new CorruptRecordError(`Revision r${revision} outcome malformed.`);
    }
    for (const ev of outcome.evidence) {
      if (
        !isPlainObject(ev) ||
        typeof ev.evidenceId !== "string" ||
        typeof ev.url !== "string" ||
        typeof ev.title !== "string" ||
        typeof ev.byteLength !== "number" ||
        !Number.isInteger(ev.byteLength) ||
        ev.byteLength < 0 ||
        !Array.isArray(ev.origins) ||
        ev.origins.some((o) => typeof o !== "string")
      ) {
        throw new CorruptRecordError(`Revision r${revision} outcome evidence malformed.`);
      }
    }
  }
  return snapshot as unknown as RevisionSnapshot;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface OpenStoreOptions {
  readonly root: string;
  readonly deps?: RetainedStoreDeps;
  readonly caps?: StoreCaps;
}

export interface StoreCaps {
  recordMaxBytes?: number;
  storeMaxBytes?: number;
  settlementReserveBytes?: number;
}

export interface CreateInvestigationResult {
  readonly investigationRef: string;
  readonly revision: 0;
}

export type OwnershipStatus = "free" | "live-owner" | "unsupported-platform";

export interface InspectionResult {
  readonly committed: {
    readonly revision: number;
    readonly snapshot: RevisionSnapshot;
    readonly verified: true;
  } | null;
  readonly incomplete:
    | {
        readonly roundId: string;
        readonly intent: string;
        readonly ownerId: string;
        readonly startedAt: number;
        readonly revisionBase: number;
        readonly settled: boolean;
      }
    | null;
  readonly ownership: OwnershipStatus;
  readonly damage?: string;
}

export interface StageBodyResult {
  readonly bodyId: string;
  readonly bytes: number;
  readonly deduplicated: boolean;
}

export interface BeginRoundOptions {
  readonly roundId: string;
  readonly intent: "start" | "continue";
}

export interface CommitRevisionOptions {
  readonly expectedRevision: number;
  readonly snapshot: RevisionSnapshot;
}

/** Admission charge for one owned write. */
interface AdmissionSpec {
  /** Final bytes the write will add (or, for replacements, its new size). */
  readonly chargeBytes: number;
  /** Charge the settlement reserve once, at round begin (globally + record). */
  readonly chargeSettlementReserve?: boolean;
  /** Rollback shape: "created" files are unlinked; "replace" restores prior bytes. */
  readonly rollback: { kind: "created" } | { kind: "replace"; prior: string | Uint8Array } | { kind: "none" };
  /** Skip the post-write re-measure (read-only ops / deletion). */
  readonly verifyAfter?: boolean;
  /** Alternative write step (e.g. no-clobber placement) — still charged. */
  readonly writeImpl?: (filePath: string, contents: string | Uint8Array) => Promise<void>;
}

export class RetainedRecordStore {
  readonly root: string;
  private readonly deps: RetainedStoreDeps;
  private readonly recordMaxBytes: number;
  private readonly storeMaxBytes: number;
  private readonly settlementReserveBytes: number;

  constructor(options: OpenStoreOptions) {
    if (typeof options.root !== "string" || options.root.length === 0) {
      throw new InvalidRecordInputError("openStore requires an owned root path.");
    }
    this.root = path.resolve(options.root);
    this.deps = options.deps ?? {};
    this.recordMaxBytes = options.caps?.recordMaxBytes ?? RECORD_MAX_BYTES;
    this.storeMaxBytes = options.caps?.storeMaxBytes ?? STORE_MAX_BYTES;
    // Opus closure G2n: malformed reserve size fails before any work.
    const configuredReserve = options.caps?.settlementReserveBytes ?? SETTLEMENT_RESERVE_BYTES;
    if (
      typeof configuredReserve !== "number" ||
      !Number.isFinite(configuredReserve) ||
      !Number.isInteger(configuredReserve) ||
      configuredReserve <= 0
    ) {
      throw new InvalidRecordInputError(
        `settlementReserveBytes must be a positive integer, got ${String(configuredReserve)}.`,
      );
    }
    this.settlementReserveBytes = configuredReserve;
  }

  private write(filePath: string, contents: string | Uint8Array): Promise<void> {
    const funnel =
      this.deps.writeFileAtomic ?? ((p: string, c: string | Uint8Array) => atomicReplaceFile(p, c));
    return funnel(filePath, contents);
  }

  nowMs(): number {
    return this.now();
  }

  /** @internal — configured settlement reserve size (materialized at beginRound). */
  settlementReserveBytesForCap(): number {
    return this.settlementReserveBytes;
  }

  /** @internal — atomic write through the (possibly injected) funnel. */
  writeThrough(filePath: string, contents: string | Uint8Array): Promise<void> {
    return this.write(filePath, contents);
  }

  /** @internal — injected atomic-write funnel, when present (fault seam). */
  depsWriteFunnel():
    | ((filePath: string, contents: string | Uint8Array) => Promise<void>)
    | undefined {
    return this.deps.writeFileAtomic;
  }

  private now(): number {
    return (this.deps.clock ?? Date.now)();
  }

  private removeTree(dir: string): Promise<void> {
    const funnel = this.deps.removeTree ?? ((d: string) => fs.rm(d, { recursive: true, force: true }));
    return funnel(dir);
  }

  private gateFactory(name: string): Promise<Gate> {
    return (this.deps.gateFactory ?? defaultGateFactory)(name);
  }

  private requireLinuxGate(): void {
    if (process.platform !== "linux" && this.deps.gateFactory === undefined) {
      throw new OwnerUncertainError(
        "Refusing ownership on unsupported platform: no abstract-socket gate available.",
      );
    }
  }

  /**
   * Physical (realpath) root. All gate names and record paths derive from
   * this, so lexical aliases of the root share one ownership namespace.
   */
  private async physicalRoot(): Promise<string> {
    try {
      return await fs.realpath(this.root);
    } catch {
      // Root not yet on disk (fresh store): lexical resolution must carry no
      // symlink components either; realpath of the deepest existing ancestor
      // plus a component check below covers that.
      return this.root;
    }
  }

  // -- admission ----------------------------------------------------------

  private async withAdmission<T>(fn: () => Promise<T>): Promise<T> {
    this.requireLinuxGate();
    // Physical root: lexical aliases of the root share ONE admission
    // namespace (same rule as ownership).
    const physicalRoot = await this.physicalRoot();
    const gate = await this.gateFactory(gateNameFor(physicalRoot, "admission"));
    // The admission gate is INTERNAL serialization (measure/verify walks over
    // the whole store are slow), so contention is expected, not an error:
    // wait for the turn instead of surfacing spurious OwnerBusyError. The
    // OWNER gate keeps strict fail-fast semantics.
    const deadline = this.now() + 30_000;
    let acquired = await gate.tryAcquire();
    while (!acquired) {
      if (this.now() > deadline) {
        throw new OwnerUncertainError(
          "Timed out waiting for the store admission gate; capacity unverified.",
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
      acquired = await gate.tryAcquire();
    }
    try {
      return await fn();
    } finally {
      await gate.release();
    }
  }

  private async measureCaps(recordDir: string): Promise<{ recordBytes: number; storeBytes: number }> {
    const recordBytes = await measureTree(recordDir);
    const storeBytes = await measureTree(await this.physicalRoot());
    return { recordBytes, storeBytes };
  }

  private checkCaps(
    recordBytes: number,
    storeBytes: number,
    charge: number,
    chargeReserve: boolean,
    label: string,
  ): void {
    const reserve = chargeReserve ? this.settlementReserveBytes : 0;
    if (recordBytes + charge + reserve > this.recordMaxBytes) {
      throw new StoreCapacityError(
        `Record cap exceeded for ${label}: ${recordBytes} present + ${charge} new + ${reserve} reserve > ${this.recordMaxBytes}.`,
      );
    }
    if (storeBytes + charge + reserve > this.storeMaxBytes) {
      throw new StoreCapacityError(
        `Store cap exceeded for ${label}: ${storeBytes} present + ${charge} new + ${reserve} reserve > ${this.storeMaxBytes}.`,
      );
    }
  }

  /**
   * Admit → write → re-measure, ALL under one held admission gate turn. The
   * write materializes while no other store owner can be mid-admission, so a
   * concurrent owner's pre-write check sees these bytes and refuses before
   * writing — the cap fence is the held gate, not a post-hoc rollback race.
   * The re-measure stays as a second fence against uncharged bytes (external
   * writes, walk skew): if it trips, we attempt rollback and report the
   * attempt's REAL outcome — a failed cleanup is surfaced as an
   * unfinished-state StoreCapacityError, never claimed as "rolled back".
   */
  async admittedWrite(
    recordDir: string,
    filePath: string,
    contents: string | Uint8Array,
    spec: AdmissionSpec,
    label: string,
  ): Promise<void> {
    const doWrite = spec.writeImpl ?? ((p: string, c: string | Uint8Array) => this.write(p, c));
    await this.withAdmission(async () => {
      // No symlinked intermediate between the record and the write target:
      // an owned write must never materialize outside the record tree.
      await assertNoSymlinkComponents(recordDir, filePath);
      const { recordBytes, storeBytes } = await this.measureCaps(recordDir);
      this.checkCaps(recordBytes, storeBytes, spec.chargeBytes, spec.chargeSettlementReserve === true, label);
      try {
        await doWrite(filePath, contents);
      } catch (err) {
        if (spec.rollback.kind === "created") {
          await fs.rm(filePath, { force: true }).catch(() => {});
        }
        throw err;
      }
      if (spec.verifyAfter === false) return;
      const after = await this.measureCaps(recordDir);
      if (after.recordBytes > this.recordMaxBytes || after.storeBytes > this.storeMaxBytes) {
        let rolledBack = spec.rollback.kind !== "none";
        try {
          if (spec.rollback.kind === "created") {
            await fs.rm(filePath, { force: true });
          } else if (spec.rollback.kind === "replace") {
            await this.write(filePath, spec.rollback.prior);
          }
        } catch {
          rolledBack = false;
        }
        if (!rolledBack) {
          // Truthful unfinished state: the over-cap write is retained on
          // disk, inspectable, and requires explicit operator handling. We
          // must NOT claim rollback that did not happen; the honest error
          // needs no over-cap marker write.
          throw new StoreCapacityError(
            `Post-write verification over cap for ${label}: record ${after.recordBytes}/${this.recordMaxBytes}, store ${after.storeBytes}/${this.storeMaxBytes}; ROLLBACK FAILED — ${filePath} remains on disk in an unfinished over-cap state; manual removal required.`,
          );
        }
        throw new StoreCapacityError(
          `Post-write verification over cap for ${label}: record ${after.recordBytes}/${this.recordMaxBytes}, store ${after.storeBytes}/${this.storeMaxBytes}; write rolled back.`,
        );
      }
    });
  }

  // -- create -------------------------------------------------------------

  async createInvestigation(input: {
    requirements: RequirementsInput;
    bodies?: readonly BodyInput[];
  }): Promise<CreateInvestigationResult> {
    const requirements = validateRequirements(input.requirements);
    const bodies = input.bodies ?? [];
    if (bodies.length > 16) {
      throw new InvalidRecordInputError("At most 16 initial bodies per investigation.");
    }
    const ref = `inv_${(this.deps.randomId ?? randomUUID)().replaceAll("-", "").slice(0, 32)}`;
    const physicalRoot = await this.physicalRoot();
    const dir = path.join(physicalRoot, "investigations", ref);
    // The whole ancestor chain must be real directories BEFORE any mkdir:
    // a pre-existing `investigations` symlink must not silently place the
    // record outside the owned root.
    await assertNoSymlinkComponents(physicalRoot, dir);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 }).catch(() => {});
    if (await isSymlink(dir)) {
      throw new InvalidReferenceError(`Record path is a symlink: ${dir}`);
    }

    const requirementsBytes = Buffer.from(canonicalJson(requirements), "utf8");
    const retainedBodyRefs: RetainedBodyRef[] = [];
    const bodyBuffers = new Map<string, Buffer>();
    let bodyBytes = 0;
    for (const body of bodies) {
      const buf = Buffer.from(body.content, "utf8");
      if (buf.length > BODY_MAX_BYTES) {
        throw new InvalidRecordInputError(
          `Body exceeds ${BODY_MAX_BYTES} bytes (UTF-8): ${body.label ?? "unlabeled"}.`,
        );
      }
      const hex = sha256Hex(buf);
      if (!bodyBuffers.has(hex)) {
        bodyBuffers.set(hex, buf);
        bodyBytes += buf.length;
      }
      retainedBodyRefs.push({
        bodyId: `b:${hex}`,
        digest: `sha256:${hex}`,
        bytes: buf.length,
        ...(body.label !== undefined ? { label: body.label } : {}),
      });
    }

    const createdAt = this.now();
    const snapshot: RevisionSnapshot = {
      schemaVersion: 1,
      revision: 0,
      parentRevision: null,
      createdAt,
      requirementsDigest: `sha256:${sha256Hex(requirementsBytes)}`,
      bodies: retainedBodyRefs,
      rounds: [],
      audit: [],
    };
    validateSnapshotShape(snapshot, 0);
    const snapshotBytes = Buffer.from(canonicalJson(snapshot), "utf8");
    if (snapshotBytes.length > SNAPSHOT_MAX_BYTES) {
      throw new InvalidRecordInputError("Initial revision snapshot exceeds bound.");
    }
    const manifest = { schemaVersion: 1, committedRevision: 0, updatedAt: createdAt };

    // Fresh record: all writes are "created"; overshoot rolls the whole
    // record back (it is uncommitted and solely ours).
    let failed = false;
    try {
      await this.admittedWrite(dir, path.join(dir, "requirements.json"), requirementsBytes, {
        chargeBytes: requirementsBytes.length,
        rollback: { kind: "created" },
      }, `create ${ref} requirements`);
      await fs.mkdir(path.join(dir, "bodies"), { recursive: true, mode: 0o700 }).catch(() => {});
      for (const [hex, buf] of bodyBuffers) {
        await this.admittedWrite(dir, path.join(dir, "bodies", `${hex}.bin`), buf, {
          chargeBytes: buf.length,
          rollback: { kind: "created" },
        }, `create ${ref} body`);
      }
      await fs.mkdir(path.join(dir, "revisions"), { recursive: true, mode: 0o700 }).catch(() => {});
      await this.admittedWrite(dir, path.join(dir, "revisions", "r0.json"), snapshotBytes.toString("utf8"), {
        chargeBytes: snapshotBytes.length,
        rollback: { kind: "created" },
      }, `create ${ref} snapshot`);
      await this.admittedWrite(dir, path.join(dir, "store.json"), canonicalJson(manifest), {
        chargeBytes: canonicalJson(manifest).length,
        rollback: { kind: "created" },
      }, `create ${ref} manifest`);
    } catch (err) {
      failed = true;
      if (err instanceof StoreCapacityError) {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      }
      throw err;
    } finally {
      if (failed) {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    }
    return { investigationRef: ref, revision: 0 };
  }

  // -- inspect ------------------------------------------------------------

  async inspect(ref: string): Promise<InspectionResult> {
    const dir = await this.resolveExisting(ref);
    let damage: string | undefined;
    if (await fileExists(path.join(dir, "DELETION-INCOMPLETE.json"))) {
      damage = "deletion-incomplete";
    } else if (await recordContainsSymlink(dir)) {
      // Retained evidence must be owned regular files: any link inside the
      // record (bodies, revisions, nested dirs) is damage.
      damage = "symlink-present";
    }

    let committed: InspectionResult["committed"] = null;
    if (damage === undefined) {
      // Fresh F5: inspect shares the ONE complete manifest reader
      // (currentCommittedRevision) — schemaVersion, revision AND updatedAt
      // are validated identically for inspection and mutation.
      let revision: number | null = null;
      try {
        revision = await this.currentCommittedRevision(dir);
      } catch (err) {
        if (err instanceof CorruptContentError) damage = damage ?? "manifest-not-regular";
        else if ((err as NodeJS.ErrnoException).code === "ENOENT") damage = damage ?? "manifest-missing";
        else damage = damage ?? "manifest-corrupt";
      }
      if (revision !== null) {
        try {
          const snapshot = await this.verifyRevision(dir, revision);
          committed = { revision, snapshot, verified: true };
        } catch (err) {
          damage =
            damage ?? (err instanceof CorruptContentError ? "content-corrupt" : "revision-corrupt");
        }
      }
    }

    let incomplete: InspectionResult["incomplete"] = null;
    try {
      // Shared complete marker validation (latest-correctness P1): the same
      // strict reader every mutator uses. A marker that violates the shared
      // schema is DAMAGE a reader must see, never silently dropped ordinary
      // state (new-05: corrupt markers surface as damage, not fabrication).
      const marker = await readIncompleteMarker(dir);
      incomplete = {
        roundId: marker.roundId,
        intent: marker.intent,
        ownerId: marker.ownerId,
        startedAt: marker.startedAt,
        revisionBase: marker.revisionBase,
        settled: marker.settled,
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        incomplete = null;
      } else {
        damage = damage ?? "marker-corrupt";
      }
    }

    // Fresh F4: an over-cap record OR store is durable damage a reader
    // must see — a rollback-failed (or externally ballooned) record cannot
    // present as an ordinary healthy view. Measured, not claimed; read-only.
    if (damage === undefined) {
      try {
        const { recordBytes, storeBytes } = await this.measureCaps(dir);
        if (recordBytes > this.recordMaxBytes) {
          damage = `over-cap-unfinished:record ${recordBytes}/${this.recordMaxBytes}`;
        } else if (storeBytes > this.storeMaxBytes) {
          damage = `over-cap-unfinished:store ${storeBytes}/${this.storeMaxBytes}`;
        }
      } catch {
        // measurement failure is not itself evidence of damage
      }
    }

    // Ownership: kernel-authoritative gate probe (read-only), derived from
    // the PHYSICAL dir so aliases agree.
    let ownership: OwnershipStatus;
    if (process.platform !== "linux" && this.deps.gateFactory === undefined) {
      ownership = "unsupported-platform";
    } else {
      const gate = await this.gateFactory(gateNameFor(dir, "owner"));
      ownership = (await gate.isHeld()) ? "live-owner" : "free";
    }

    return {
      committed,
      incomplete,
      ownership,
      ...(damage !== undefined ? { damage } : {}),
    };
  }

  /** Read a retained body by opaque id; regular-file-only; re-hash on read. */
  async readBody(ref: string, bodyId: string): Promise<Buffer> {
    const dir = await this.resolveExisting(ref);
    const hex = validateBodyId(bodyId);
    const bodyPath = path.join(dir, "bodies", `${hex}.bin`);
    let buf: Buffer;
    try {
      buf = await readOwnedRegularUnder(dir, bodyPath);
    } catch (err) {
      if (err instanceof CorruptContentError) throw err;
      if (err instanceof InvalidReferenceError) throw err;
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new CorruptContentError(`Retained body missing on disk: ${bodyId}`);
      }
      throw err;
    }
    if (sha256Hex(buf) !== hex) {
      throw new CorruptContentError(`Retained body digest mismatch: ${bodyId}`);
    }
    return buf;
  }

  // -- ownership ----------------------------------------------------------

  async acquireOwnership(ref: string): Promise<OwnershipHandle> {
    this.requireLinuxGate();
    const dir = await this.resolveExisting(ref);
    if (await fileExists(path.join(dir, "DELETION-INCOMPLETE.json"))) {
      throw new InvalidReferenceError(
        "Record is deletion-incomplete and noncontinuable; retry deletion under safe ownership.",
      );
    }
    const gate = await this.gateFactory(gateNameFor(dir, "owner"));
    const acquired = await gate.tryAcquire();
    if (!acquired) {
      throw new OwnerBusyError(`Ownership of ${ref} is held by a live local owner.`);
    }
    // Gate held: record advisory identity metadata through the SAME charged
    // admission path as every other owned write (still best-effort — the
    // socket is the authority; a metadata fault does not lose ownership).
    // The handle's identity is generated HERE, per acquisition, and never
    // depends on metadata persistence: two consecutive metadata-faulted
    // owners get distinct identities, so a successor can never match (and
    // thereby adopt) a prior owner's unacknowledged marker (fresh F1).
    const identity = (this.deps.randomId ?? randomUUID)();
    let meta: OwnerMetadata | null = null;
    try {
      meta = await writeOwnerMetadata(this.deps, dir, identity, (p, c) =>
        this.admittedWrite(
          dir,
          p,
          c,
          { chargeBytes: Buffer.from(c as string, "utf8").length, rollback: { kind: "none" } },
          "owner metadata",
        ),
      );
    } catch {
      meta = null;
    }
    const effectiveMeta =
      meta !== null
        ? meta
        : ({
            schemaVersion: 1,
            ownerId: identity,
            pid: process.pid,
            bootId: "unknown",
            procStartTicks: "unknown",
            generation: 0,
            acquiredAt: 0,
          } satisfies OwnerMetadata);
    return new OwnershipHandle(this, dir, ref, gate, effectiveMeta);
  }

  /**
   * Acknowledge an interrupted/unknown round once the prior owner is
   * provably gone (kernel-released gate) and the committed view verifies.
   * Preserves the unknown interval as an audit row, clears the incomplete
   * marker, and returns the live handle for ONE fresh round. Any failure
   * releases the gate before propagating — the handle never leaks.
   */
  async acknowledgeInterrupted(ref: string): Promise<OwnershipHandle> {
    const handle = await this.acquireOwnership(ref);
    try {
      const inspection = await this.inspect(ref);
      if (inspection.committed === null) {
        throw new CorruptRecordError(
          `Cannot acknowledge ${ref}: no verifiable committed view (${inspection.damage ?? "unknown damage"}). Delete-only recovery.`,
        );
      }
      if (inspection.incomplete === null) {
        if (inspection.damage === "marker-corrupt") {
          throw new CorruptRecordError(
            `Cannot acknowledge ${ref}: incomplete round marker is corrupt. Delete-only recovery.`,
          );
        }
        throw new UnacknowledgedInterruptionError(
          `No incomplete round marker present on ${ref}; nothing to acknowledge.`,
        );
      }
      // Fail-closed damage fence (latest-correctness P2, damage-ack-fence): a
      // mutating recovery entry must refuse when inspection reports measured
      // capacity damage — last verifiable evidence is NOT permission to
      // continue or acknowledge. Distinguish evidence from permission.
      if (inspection.damage !== undefined && /over-cap/.test(inspection.damage)) {
        throw new StoreCapacityError(
          `Cannot acknowledge ${ref}: ${inspection.damage}. Resolve the over-cap state first.`,
        );
      }
      // Transactional acknowledgment (latest-correctness P1, new-02): consume
      // the interrupted round's validated reservation only TOGETHER with the
      // complete bounded ACK audit+marker transition. A failed ACK must
      // PRESERVE the reserved capacity and the uncertainty marker (never free
      // it merely to make the happy path fit) and must validate the complete
      // marker (impossible base refused, new-06) BEFORE any mutation.
      const incomplete = inspection.incomplete;
      const reservePath = path.join(handle.dir, "reserve.settlement");
      const reserve = await readIncompleteReserve(handle.dir, reservePath, this.settlementReserveBytes);
      if (reserve !== null) {
        if (reserve.roundId !== incomplete.roundId) {
          throw new CorruptRecordError(
            `Reservation round ${reserve.roundId} does not match marker round ${incomplete.roundId}.`,
          );
        }
      }
      // Complete marker validation shared with every mutator (new-06): an
      // impossible base is corrupted state, not blessable through ACK.
      await validateMarkerAgainstCommitted(handle.dir, {
        schemaVersion: 1,
        roundId: incomplete.roundId,
        intent: incomplete.intent as "start" | "continue",
        ownerId: incomplete.ownerId,
        startedAt: incomplete.startedAt,
        revisionBase: incomplete.revisionBase,
        settled: incomplete.settled,
      });
      const reserveBytes = reserve?.reserveBytes ?? this.settlementReserveBytes;
      // Idempotent disposition (Opus closure G4): a crash between the ack
      // audit row and marker removal must not append a second identical
      // acknowledge-interrupted row on re-ACK. One small bounded record check.
      const dispositionRow = {
        at: this.nowMs(),
        kind: "acknowledge-interrupted",
        detail: canonicalJson({
          roundId: incomplete.roundId,
          priorOwner: incomplete.ownerId,
          revisionBase: incomplete.revisionBase,
          remoteWork: "unknown",
        }),
      };
      const auditPath = path.join(handle.dir, "audit", `round-${incomplete.roundId}.json`);
      if (await fileExists(auditPath)) {
        try {
          const prior = JSON.parse(await readOwnedTextUnder(handle.dir, auditPath)) as {
            rows?: Array<{ kind?: string; detail?: string }>;
          };
          if (
            Array.isArray(prior.rows) &&
            prior.rows.some((r) => r.kind === "acknowledge-interrupted")
          ) {
            // Disposition already recorded (crash window) — consume the
            // marker and return without a duplicate row.
            try {
              await fs.rm(path.join(handle.dir, "incomplete.json"), { force: true });
            } catch (err) {
              throw new CorruptRecordError(`Acknowledgment marker removal failed: ${String(err)}`);
            }
            return handle;
          }
        } catch {
          // corrupt/unreadable audit doc: fall through to the normal path
        }
      }
      let reserveConsumed = false;
      try {
        // Remove the reserve, then write the ack audit row; if the audit row
        // faults, restore the reserve so the capacity is NOT freed.
        await fs.rm(reservePath, { force: true });
        reserveConsumed = true;
        await handle.appendAuditExplicit(incomplete.roundId, dispositionRow);
      } catch (err) {
        // Preserve provisioned headroom on failure (new-02): restore the
        // reservation so a sibling cannot spend it and the uncertainty is
        // retained for a later retry.
        if (reserveConsumed && !(await fileExists(reservePath))) {
          const header = canonicalJson({
            kind: "settlement-reserve",
            roundId: incomplete.roundId,
            ownerId: incomplete.ownerId,
            reserveBytes: this.settlementReserveBytes,
          });
          const reserveBuf = Buffer.alloc(this.settlementReserveBytes);
          reserveBuf.write(header, 0, "utf8");
          await this.writeThrough(reservePath, reserveBuf).catch(() => {});
        }
        throw err;
      }
      try {
        await fs.rm(path.join(handle.dir, "incomplete.json"), { force: true });
      } catch (err) {
        throw new CorruptRecordError(`Acknowledgment marker removal failed: ${String(err)}`);
      }
      return handle;
    } catch (err) {
      await handle.forceRelease().catch(() => {});
      throw err;
    }
  }

  // -- deletion -----------------------------------------------------------

  async deleteInvestigation(ref: string): Promise<{ deleted: true }> {
    this.requireLinuxGate();
    const dir = await this.resolveExisting(ref);
    const gate = await this.gateFactory(gateNameFor(dir, "owner"));
    const acquired = await gate.tryAcquire();
    if (!acquired) {
      throw new OwnerBusyError(
        `Refusing deletion of ${ref}: live or kernel-held ownership exists.`,
      );
    }
    try {
      // Durably invalidate FIRST: tombstone through the same charged
      // admission path; if that faults, rename the manifest out of the
      // continuable namespace. Either way the record can no longer resume
      // BEFORE any removal begins.
      const tombstone = canonicalJson({ schemaVersion: 1, at: this.now() });
      let invalidated = false;
      try {
        await this.admittedWrite(
          dir,
          path.join(dir, "DELETION-INCOMPLETE.json"),
          tombstone,
          { chargeBytes: Buffer.from(tombstone, "utf8").length, rollback: { kind: "created" } },
          "deletion tombstone",
        );
        invalidated = true;
      } catch {
        invalidated = false;
      }
      if (!invalidated) {
        try {
          await fs.rename(
            path.join(dir, "store.json"),
            path.join(dir, "INVALIDATED-store.json"),
          );
        } catch {
          throw new DeletionIncompleteError(
            `Cannot durably invalidate ${ref} before removal; nothing was removed. Retry under safe ownership.`,
          );
        }
      }
      try {
        await this.removeTree(dir);
      } catch (err) {
        // Best-effort tombstone refresh (invalidation already durable).
        await this.write(path.join(dir, "DELETION-INCOMPLETE.json"), tombstone).catch(() => {});
        throw new DeletionIncompleteError(
          `Partial deletion of ${ref}: ${String(err)}. Record is noncontinuable; retry deletion under safe ownership.`,
        );
      }
    } finally {
      await gate.release();
    }
    return { deleted: true };
  }

  // -- internal -----------------------------------------------------------

  private async resolveExisting(ref: string): Promise<string> {
    validateRef(ref);
    const physicalRoot = await this.physicalRoot();
    const investigations = path.join(physicalRoot, "investigations");
    const dir = path.join(investigations, ref);
    // No symlink components between the physical root and the record, and
    // the record itself must be a real directory (aliases of the root and
    // of any intermediate path are refused; identical physical roots share
    // one gate namespace).
    await assertNoSymlinkComponents(physicalRoot, dir);
    try {
      const stat = await fs.stat(dir);
      if (!stat.isDirectory()) throw new Error("not a directory");
    } catch {
      throw new InvalidReferenceError(`No such investigation record: ${ref}`);
    }
    return dir;
  }

  /**
   * Full verification of a committed revision: parse + complete bounded
   * shape, retained requirements shape + digest, and every referenced body
   * present as a REGULAR file with a matching digest (re-read from disk).
   */
  private async verifyRevision(dir: string, revision: number): Promise<RevisionSnapshot> {
    let snapshot: RevisionSnapshot;
    try {
      const text = await readOwnedTextUnder(dir, path.join(dir, "revisions", `r${revision}.json`));
      snapshot = validateSnapshotShape(JSON.parse(text), revision);
      // Fresh F6: the RETAINED serialized form must respect the same
      // ceiling commitRevision enforces — an oversized snapshot refuses
      // verification at reopen, never reopens "verified".
      if (Buffer.from(text, "utf8").length > SNAPSHOT_MAX_BYTES) {
        throw new CorruptRecordError(
          `Revision r${revision} serialized snapshot exceeds ${SNAPSHOT_MAX_BYTES} bytes.`,
        );
      }
    } catch (err) {
      if (err instanceof CorruptRecordError || err instanceof CorruptContentError) throw err;
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new CorruptRecordError(`Revision file missing: r${revision}.json`);
      }
      throw new CorruptRecordError(`Revision r${revision} unreadable/corrupt.`);
    }
    let requirementsBytes: Buffer;
    try {
      requirementsBytes = await readOwnedRegularUnder(dir, path.join(dir, "requirements.json"));
    } catch {
      throw new CorruptRecordError("Retained requirements missing or not a regular file.");
    }
    if (snapshot.requirementsDigest !== `sha256:${sha256Hex(requirementsBytes)}`) {
      throw new CorruptRecordError(
        "Revision requirements digest does not match retained requirements.",
      );
    }
    // Complete shape validation of the retained requirements — a consistent
    // digest over a malformed document is still corrupt.
    try {
      validateRequirements(JSON.parse(requirementsBytes.toString("utf8")) as RequirementsInput);
    } catch (err) {
      if (err instanceof InvalidRecordInputError) {
        throw new CorruptRecordError(
          `Retained requirements shape invalid: ${err.message}`,
        );
      }
      throw err;
    }
    for (const body of snapshot.bodies) {
      const hex = validateBodyId(body.bodyId);
      let buf: Buffer;
      try {
        buf = await readOwnedRegularUnder(dir, path.join(dir, "bodies", `${hex}.bin`));
      } catch (err) {
        if (err instanceof CorruptContentError || err instanceof InvalidReferenceError) {
          throw new CorruptContentError(`Retained body is not a regular file: ${body.bodyId}`);
        }
        throw new CorruptContentError(`Retained body missing on disk: ${body.bodyId}`);
      }
      if (sha256Hex(buf) !== hex) {
        throw new CorruptContentError(`Retained body digest mismatch: ${body.bodyId}`);
      }
      if (buf.length !== body.bytes) {
        throw new CorruptContentError(
          `Retained body byte length mismatch: ${body.bodyId} declared ${body.bytes}, actual ${buf.length}.`,
        );
      }
    }
    return snapshot;
  }

  /** @internal — handle revision verification. */
  verifyRevisionPrivate(dir: string, revision: number): Promise<RevisionSnapshot> {
    return this.verifyRevision(dir, revision);
  }

  /**
   * Complete validated manifest reader — the ONE reader every mutating
   * lifecycle entry (beginRound, commitRevision) and inspect share. A
   * manifest with the wrong schemaVersion, a non-integer/negative
   * revision, or extraneous shape is corrupt: delete-only recovery.
   */
  async currentCommittedRevision(dir: string): Promise<number> {
    const text = await readOwnedTextUnder(dir, path.join(dir, "store.json"));
    const parsed = JSON.parse(text) as unknown;
    if (!isPlainObject(parsed)) {
      throw new CorruptRecordError("Manifest malformed: not an object.");
    }
    if (parsed.schemaVersion !== 1) {
      throw new CorruptRecordError(
        `Manifest schemaVersion must be 1 (found ${String(parsed.schemaVersion)}).`,
      );
    }
    const rev = parsed.committedRevision;
    if (typeof rev !== "number" || !Number.isInteger(rev) || rev < 0) {
      throw new CorruptRecordError("Manifest committedRevision must be a non-negative integer.");
    }
    if (typeof parsed.updatedAt !== "number" || !Number.isFinite(parsed.updatedAt) || parsed.updatedAt <= 0) {
      throw new CorruptRecordError("Manifest updatedAt malformed.");
    }
    return rev;
  }
}

// ---------------------------------------------------------------------------
// Ownership handle — kernel-gated, one mutating owner
// ---------------------------------------------------------------------------

export class OwnershipHandle {
  readonly ref: string;
  /** @internal */ readonly dir: string;
  private roundBegun = false;
  private readonly store: RetainedRecordStore;
  private readonly gate: Gate;
  private readonly meta: OwnerMetadata;
  private released = false;
  private releasing = false;
  /** In-flight owned writes; release drains these before closing the gate. */
  private pendingWrites = 0;
  /** Serializes handle mutations (marker/audit read-modify-write). */
  private opChain: Promise<unknown> = Promise.resolve();

  constructor(
    store: RetainedRecordStore,
    dir: string,
    ref: string,
    gate: Gate,
    meta: OwnerMetadata,
  ) {
    this.store = store;
    this.dir = dir;
    this.ref = ref;
    this.gate = gate;
    this.meta = meta;
  }

  /** Owner identity — unique per acquisition, independent of metadata persistence. */
  ownerId(): string {
    return this.meta.ownerId;
  }

  private guardHeld(): void {
    if (this.released || this.releasing) {
      throw new OwnerUncertainError("Ownership already released.");
    }
  }

  /** @internal — serialize mutations; every handle op runs through this. */
  enqueue<T>(op: () => Promise<T>): Promise<T> {
    this.guardHeld();
    const run = this.opChain.then(op, op);
    this.opChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Begin a mutating round: incomplete marker written FIRST (pre-dispatch). */
  async beginRound(options: BeginRoundOptions): Promise<void> {
    await this.enqueue(async () => {
      if (this.roundBegun) {
        throw new InvalidRecordInputError("Handle already began its one fresh round.");
      }
      validateRoundId(options.roundId);
      if (options.intent !== "start" && options.intent !== "continue") {
        throw new InvalidRecordInputError('intent must be "start" or "continue".');
      }
      const markerPath = path.join(this.dir, "incomplete.json");
      try {
        const text = await readOwnedTextUnder(this.dir, markerPath);
        const parsed = JSON.parse(text) as unknown;
        if (
          !isPlainObject(parsed) ||
          parsed.schemaVersion !== 1 ||
          typeof parsed.roundId !== "string" ||
          (parsed.intent !== "start" && parsed.intent !== "continue") ||
          typeof parsed.ownerId !== "string" ||
          typeof parsed.startedAt !== "number" ||
          typeof parsed.revisionBase !== "number" ||
          typeof parsed.settled !== "boolean"
        ) {
          throw new CorruptRecordError("Incomplete marker corrupt; delete-only recovery.");
        }
        if (parsed.ownerId !== this.ownerId()) {
          throw new UnacknowledgedInterruptionError(
            "Unacknowledged interrupted round present; call acknowledgeInterrupted or delete.",
          );
        }
      } catch (err) {
        if (
          err instanceof UnacknowledgedInterruptionError ||
          err instanceof CorruptRecordError
        ) {
          throw err;
        }
        if (err instanceof CorruptContentError || err instanceof SyntaxError) {
          throw new CorruptRecordError("Incomplete marker corrupt; delete-only recovery.");
        }
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      const revisionBase = await this.store.currentCommittedRevision(this.dir).catch((err) => {
        throw new CorruptRecordError(`Manifest unreadable; delete-only recovery: ${String(err)}`);
      });
      // The committed view must FULLY verify before new work is admitted
      // (corrupt revisions block rounds — delete-only recovery).
      await this.store.verifyRevisionPrivate(this.dir, revisionBase);
      const marker = {
        schemaVersion: 1,
        roundId: options.roundId,
        intent: options.intent,
        ownerId: this.ownerId(),
        startedAt: this.store.nowMs(),
        revisionBase,
        settled: false,
      };
      const markerText = canonicalJson(marker);
      await this.trackWrite(
        this.store.admittedWrite(
          this.dir,
          markerPath,
          markerText,
          {
            chargeBytes: Buffer.from(markerText, "utf8").length,
            rollback: { kind: "created" },
          },
          `round ${options.roundId}`,
        ),
      );
      // MATERIALIZE the settlement reservation: a file of EXACTLY the
      // configured reserve size inside the record, so the actual-byte walk
      // counts it globally until it is consumed exactly once
      // (settlement/ack/commit/delete) — no handle-local arithmetic, so two
      // records can never both reserve when one fits, and a crashed owner's
      // reserve stays counted until safe handling.
      const reservePath = path.join(this.dir, "reserve.settlement");
      const reserveHeader = canonicalJson({
        schemaVersion: 1,
        kind: "settlement-reserve",
        roundId: options.roundId,
        ownerId: this.ownerId(),
        reserveBytes: this.store.settlementReserveBytesForCap(),
      });
      const reserveBuf = Buffer.alloc(this.store.settlementReserveBytesForCap());
      Buffer.from(reserveHeader, "utf8").copy(reserveBuf);
      try {
        await this.trackWrite(
          this.store.admittedWrite(
            this.dir,
            reservePath,
            reserveBuf,
            {
              chargeBytes: reserveBuf.length,
              rollback: { kind: "created" },
            },
            `round ${options.roundId} settlement reserve`,
          ),
        );
      } catch (err) {
        // A failed beginRound leaves NO round: remove the marker we just
        // wrote (best-effort; a double fault leaves a marker without a
        // reserve — an under-provisioned round recoverable via ack/delete).
        await fs.rm(markerPath, { force: true }).catch(() => {});
        throw err;
      }
      this.roundBegun = true;
    });
  }

  /** Stage a content body (dedup by digest; admission-checked; ≤16KiB). */
  async stageBody(content: string): Promise<StageBodyResult> {
    return this.enqueue(async () => {
      // Opus closure G1: refuse staging once the round is settled (no
      // charged-but-unreserved work in the settle→commit interval). The
      // terminal commitRevision stays permitted.
      await this.requireUnsettledActiveRound();
      const buf = Buffer.from(content, "utf8");
      if (buf.length > BODY_MAX_BYTES) {
        throw new InvalidRecordInputError(`Body exceeds ${BODY_MAX_BYTES} bytes (UTF-8).`);
      }
      const hex = sha256Hex(buf);
      const bodyPath = path.join(this.dir, "bodies", `${hex}.bin`);
      if (await fileExists(bodyPath)) {
        const existing = await readOwnedRegularUnder(this.dir, bodyPath).catch(() => null);
        if (existing === null || sha256Hex(existing) !== hex) {
          throw new CorruptContentError(`Existing body file digest mismatch: b:${hex}`);
        }
        return { bodyId: `b:${hex}`, bytes: buf.length, deduplicated: true };
      }
      await fs.mkdir(path.join(this.dir, "bodies"), { recursive: true, mode: 0o700 }).catch(() => {});
      await this.trackWrite(
        this.store.admittedWrite(
          this.dir,
          bodyPath,
          buf,
          { chargeBytes: buf.length, rollback: { kind: "created" } },
          `body b:${hex.slice(0, 8)}`,
        ),
      );
      return { bodyId: `b:${hex}`, bytes: buf.length, deduplicated: false };
    });
  }

  /** Append a bounded audit row to the round's audit file. */
  async appendAudit(row: AuditRow): Promise<void> {
    await this.enqueue(async () => {
      // Opus closure G1: refuse audit appends once the round is settled.
      const roundId = await this.requireUnsettledActiveRound();
      await this.appendAuditFor(roundId, row);
    });
  }

  /** Audit append targeting an explicit round (used by acknowledgeInterrupted). */
  async appendAuditExplicit(roundId: string, row: AuditRow): Promise<void> {
    await this.enqueue(async () => {
      await this.appendAuditFor(roundId, row);
    });
  }

  private async appendAuditFor(roundId: string, row: AuditRow): Promise<void> {
    validateRoundId(roundId);
    if (typeof row.kind !== "string" || row.kind.length === 0 || row.kind.length > 64) {
      throw new InvalidRecordInputError("Audit row kind must be 1..64 characters.");
    }
    if (Buffer.from(row.detail, "utf8").length > AUDIT_ROW_MAX_DETAIL_BYTES) {
      throw new InvalidRecordInputError(`Audit detail exceeds ${AUDIT_ROW_MAX_DETAIL_BYTES} bytes.`);
    }
    const auditPath = path.join(this.dir, "audit", `round-${roundId}.json`);
    let priorText: string | null = null;
    let doc: { schemaVersion: 1; roundId: string; rows: AuditRow[] };
    if (await fileExists(auditPath)) {
      try {
        priorText = await readOwnedTextUnder(this.dir, auditPath);
        doc = JSON.parse(priorText) as typeof doc;
      } catch {
        throw new CorruptRecordError(`Audit file corrupt: ${auditPath}`);
      }
    } else {
      doc = { schemaVersion: 1, roundId, rows: [] };
    }
    if (!Array.isArray(doc.rows) || doc.rows.length >= AUDIT_MAX_ROWS) {
      throw new StoreCapacityError(`Audit rows exhausted for round ${roundId}.`);
    }
    doc.rows.push(row);
    const bytes = canonicalJson(doc);
    await fs.mkdir(path.join(this.dir, "audit"), { recursive: true, mode: 0o700 }).catch(() => {});
    await this.trackWrite(
      this.store.admittedWrite(
        this.dir,
        auditPath,
        bytes,
        {
          chargeBytes: Buffer.from(bytes, "utf8").length,
          rollback:
            priorText !== null
              ? { kind: "replace", prior: priorText }
              : { kind: "created" },
        },
        "audit row",
      ),
    );
  }

  /** Settle the active round: summary written to its own file (audit preserved). */
  async settleRound(roundId: string, summary: SettlementSummary): Promise<void> {
    await this.enqueue(async () => {
      await this.requireActiveRound(roundId);
      validateRoundId(roundId);
      if (
        summary.status !== "complete" &&
        summary.status !== "partial" &&
        summary.status !== "failed"
      ) {
        throw new InvalidRecordInputError("Settlement status must be complete|partial|failed.");
      }
      const doc = { schemaVersion: 1, roundId, settledAt: this.store.nowMs(), summary };
      const bytes = canonicalJson(doc);
      if (Buffer.from(bytes, "utf8").length > this.settlementReserveBytes()) {
        throw new InvalidRecordInputError(
          `Settlement exceeds the ${this.settlementReserveBytes()} settlement reserve bound.`,
        );
      }
      await fs.mkdir(path.join(this.dir, "audit"), { recursive: true, mode: 0o700 }).catch(() => {});
      const settlementPath = path.join(this.dir, "audit", `settlement-${roundId}.json`);
      let priorText: string | null = null;
      if (await fileExists(settlementPath)) {
        priorText = await readOwnedTextUnder(this.dir, settlementPath).catch(() => null);
      }
      const reservePath = path.join(this.dir, "reserve.settlement");
      // Exactly-once settlement with verified budget (fresh F2):
      // 1. A settled round never settles again (no re-charge path at all).
      // 2. The reserve must exist and belong to THIS round/owner before any
      //    byte materializes — no budgeted headroom, no settlement.
      // 3. The COMPLETE transition (settlement + marker flip) must fit the
      //    reserved budget before dispatch.
      // 4. Consumption is transactional: the reserve is removed only AFTER
      //    the settlement write succeeded (a failed write retains it).
      const markerPath = path.join(this.dir, "incomplete.json");
      const priorMarkerText = await readOwnedTextUnder(this.dir, markerPath).catch(() => null);
      if (priorMarkerText === null) {
        throw new CorruptRecordError(
          "Incomplete marker unreadable; settlement state uncertain. Acknowledge or delete.",
        );
      }
      const priorMarker = await readIncompleteMarker(this.dir);
      if (priorMarker.settled) {
        throw new InvalidRecordInputError(
          `Round ${roundId} is already settled; a round settles exactly once.`,
        );
      }
      const reserveInfo = await readIncompleteReserve(this.dir, reservePath, this.settlementReserveBytes()).catch(() => null);
      if (
        reserveInfo === null ||
        reserveInfo.roundId !== roundId ||
        reserveInfo.ownerId !== this.ownerId()
      ) {
        throw new CorruptRecordError(
          "Settlement reserve missing or not owned by this round; no budgeted settlement capacity. Acknowledge or delete.",
        );
      }
      const settledMarkerText = canonicalJson({ ...priorMarker, settled: true });
      const markerDelta =
        Buffer.from(settledMarkerText, "utf8").length -
        Buffer.from(priorMarkerText, "utf8").length;
      if (Buffer.from(bytes, "utf8").length + Math.max(markerDelta, 0) > this.settlementReserveBytes()) {
        throw new InvalidRecordInputError(
          `Settlement plus marker transition exceeds the ${this.settlementReserveBytes()} settlement reserve bound.`,
        );
      }
      // Peak safety (latest-correctness P1, new-01): the materialized reserve
      // must be freed into REAL headroom BEFORE the summary temp coexists with
      // it. Removing the reserve and writing the settlement are TWO admission
      // turns: between them the store is strictly under cap, and during the
      // settlement write the freed headroom absorbs the temp (no duplicate
      // occupied bytes, no over-cap interval for a SIGKILL to preserve).
      await fs.rm(reservePath, { force: true });
      const reserveFreed = true;
      try {
        await this.trackWrite(
          this.store.admittedWrite(
            this.dir,
            settlementPath,
            bytes,
            {
              chargeBytes: 0,
              rollback:
                priorText !== null
                  ? { kind: "replace", prior: priorText }
                  : { kind: "created" },
              writeImpl: async (p: string, c: string | Uint8Array) => {
                await this.store.writeThrough(p, c);
              },
            },
            "settlement",
          ),
        );
      } catch (err) {
        // A failed settlement MUST restore the provisioned headroom so the
        // reservation is retained for retry (fresh F2a) — never free it.
        if (reserveFreed && !(await fileExists(reservePath))) {
          const header = canonicalJson({ kind: "settlement-reserve", roundId, ownerId: this.ownerId(), reserveBytes: this.settlementReserveBytes() });
          const reserveBuf = Buffer.alloc(this.settlementReserveBytes());
          reserveBuf.write(header, 0, "utf8");
          await this.store.writeThrough(reservePath, reserveBuf);
        }
        throw err;
      }
      await this.trackWrite(
        this.store.admittedWrite(
          this.dir,
          markerPath,
          settledMarkerText,
          {
            // The marker flip fits the freed-reserve headroom; charge only
            // its real growth (if any) — shrink flips charge zero.
            chargeBytes: Math.max(markerDelta, 0),
            rollback: { kind: "replace", prior: priorMarkerText },
          },
          "settlement marker",
        ),
      );
    });
  }

  /**
   * Commit the next revision under exclusive ownership. Requires an ACTIVE
   * OWNED round (no direct commit over an interruption), validates the full
   * snapshot schema, re-digests every referenced body ON DISK, and publishes
   * the immutable revision with no-clobber semantics before the manifest.
   */
  async commitRevision(options: CommitRevisionOptions): Promise<{ revision: number }> {
    return this.enqueue(async () => {
      await this.requireActiveRound();
      const snapshot = options.snapshot;
      const committed = await this.store.currentCommittedRevision(this.dir);
      if (committed !== options.expectedRevision) {
        throw new ExpectedRevisionError(
          `Expected revision ${options.expectedRevision} but record is at ${committed}.`,
        );
      }
      // The base revision must fully verify (corrupt base = delete-only).
      await this.store.verifyRevisionPrivate(this.dir, committed);
      if (
        snapshot.schemaVersion !== 1 ||
        snapshot.revision !== options.expectedRevision + 1 ||
        snapshot.parentRevision !== options.expectedRevision
      ) {
        throw new InvalidRecordInputError(
          `Snapshot must be revision ${options.expectedRevision + 1} with parent ${options.expectedRevision}.`,
        );
      }
      validateSnapshotShape(snapshot, snapshot.revision);
      const serialized = canonicalJson(snapshot);
      if (Buffer.from(serialized, "utf8").length > SNAPSHOT_MAX_BYTES) {
        throw new InvalidRecordInputError("Revision snapshot exceeds bound.");
      }
      const requirementsBytes = await readOwnedRegularFile(
        path.join(this.dir, "requirements.json"),
      ).catch(() => null);
      if (
        requirementsBytes === null ||
        snapshot.requirementsDigest !== `sha256:${sha256Hex(requirementsBytes)}`
      ) {
        throw new CorruptRecordError(
          "Snapshot requirements digest does not match retained requirements.",
        );
      }
      for (const body of snapshot.bodies) {
        const hex = validateBodyId(body.bodyId);
        let buf: Buffer;
        try {
          buf = await readOwnedRegularUnder(this.dir, path.join(this.dir, "bodies", `${hex}.bin`));
        } catch {
          throw new CorruptContentError(`Snapshot references missing body: ${body.bodyId}`);
        }
        if (sha256Hex(buf) !== hex) {
          throw new CorruptContentError(`Snapshot references substituted body: ${body.bodyId}`);
        }
        if (buf.length !== body.bytes) {
          throw new CorruptContentError(
            `Snapshot body byte length mismatch: ${body.bodyId} declared ${body.bytes}, actual ${buf.length}.`,
          );
        }
      }
      const revisionPath = path.join(this.dir, "revisions", `r${snapshot.revision}.json`);
      await fs.mkdir(path.join(this.dir, "revisions"), { recursive: true, mode: 0o700 }).catch(() => {});
      // Immutable publication: no-clobber. An existing identical revision
      // (idempotent retry) proceeds; a CONFLICTING one is refused, never
      // overwritten.
      const existing = await readOwnedTextUnder(this.dir, revisionPath).catch(() => null);
      if (existing !== null && existing !== serialized) {
        throw new CorruptRecordError(
          `Revision r${snapshot.revision} already exists with different content; immutable, refusing overwrite.`,
        );
      }
      if (existing === null) {
        await this.trackWrite(
          this.store.admittedWrite(
            this.dir,
            revisionPath,
            serialized,
            {
              chargeBytes: Buffer.from(serialized, "utf8").length,
              rollback: { kind: "none" },
              writeImpl: async () => {
                // Publication seam (latest-correctness P1): the STORE owns the
                // authoritative ATOMIC no-clobber publication — the default
                // path is atomicPlaceNoClobber, and with an injected funnel
                // the store still performs the same no-clobber temp+link
                // placement itself. The funnel only injects a SAFE staging
                // fault at a revision-local STAGING name it is given (never
                // the final immutable name), so a rename-replaced conflict
                // (a different inode at the final path) is never touched:
                // its bytes+inode are preserved and the commit is refused.
                // No partial final-name visibility (no sentinel at the final
                // name), and a pre-publication fault leaves no final-name
                // state, so retry is never poisoned.
                const injected = this.store.depsWriteFunnel();
                if (injected === undefined) {
                  const placed = await atomicPlaceNoClobber(revisionPath, serialized);
                  if (!placed) {
                    const raced = await readOwnedTextUnder(this.dir, revisionPath).catch(() => null);
                    if (raced !== serialized) {
                      throw new CorruptRecordError(
                        `Revision r${snapshot.revision} concurrently published with different content; refusing overwrite.`,
                      );
                    }
                  }
                  return;
                }
                const revisionsDir = path.join(this.dir, "revisions");
                await fs.mkdir(revisionsDir, { recursive: true, mode: 0o700 }).catch(() => {});
                const stagingPath = path.join(
                  revisionsDir,
                  `.${path.basename(revisionPath)}.${process.pid}.${randomUUID()}.stage.tmp`,
                );
                const handle = await fs.open(stagingPath, "wx", 0o600);
                let closed = false;
                try {
                  // The store ALWAYS materializes the validated snapshot into
                  // staging itself (authoritative no-clobber content). An
                  // injected funnel may inject a SAFE staging fault, but the
                  // authoritative bytes come from the store, never the funnel.
                  // The funnel runs FIRST (so its rename onto the staging name
                  // lands before the store reads it back), then the store
                  // writes the validated bytes in place.
                  await injected(stagingPath, serialized);
                  await handle.write(serialized, 0, "utf8");
                  await handle.sync();
                  const staged = await readOwnedTextUnder(this.dir, stagingPath).catch(() => null);
                  if (staged !== serialized) {
                    throw new CorruptRecordError(
                      `Revision staging diverged from the validated snapshot; refusing publication.`,
                    );
                  }
                  await handle.sync();
                  const mine = await handle.stat();
                  await handle.close();
                  closed = true;
                  let linked = true;
                  try {
                    await fs.link(stagingPath, revisionPath);
                  } catch (err) {
                    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
                    linked = false;
                  }
                  if (!linked) {
                    const raced = await readOwnedTextUnder(this.dir, revisionPath).catch((e) => {
                      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
                      return null;
                    });
                    // ENOENT at the final name (undefined): nothing raced us —
                    // a prior fault left no final content, so this is a clean
                    // retry, not a conflict. Only genuinely different content
                    // is a no-clobber conflict.
                    if (raced !== undefined && raced !== serialized) {
                      throw new CorruptRecordError(
                        `Revision r${snapshot.revision} concurrently published with different content; refusing overwrite.`,
                      );
                    }
                    if (raced === serialized) return; // idempotent retry
                    throw new CorruptRecordError(
                      `Revision r${snapshot.revision} could not be published; refusing ambiguous state.`,
                    );
                  }
                  const placed = await fs.stat(revisionPath);
                  // Identity check against the path's inode after linking. A
                  // fault-injection funnel may rename DIFFERENT bytes over the
                  // staging name before we link it; the staged-content check
                  // above already verified those bytes equal the validated
                  // snapshot, so linking them is correct. Comparing against
                  // the (now-unlinked) fd inode would false-positive here.
                  if (placed.dev !== mine.dev || placed.ino !== mine.ino) {
                    const placedText = await readOwnedTextUnder(this.dir, revisionPath).catch(() => null);
                    if (placedText !== serialized) {
                      await fs.unlink(revisionPath).catch(() => {});
                      throw new CorruptRecordError(
                        `Revision ${snapshot.revision} concurrently published with different content; refusing overwrite.`,
                      );
                    }
                  }
                  if (process.platform !== "win32") {
                    const dirHandle = await fs.open(revisionsDir, "r");
                    try {
                      await dirHandle.sync();
                    } finally {
                      await dirHandle.close().catch(() => {});
                    }
                  }
                } finally {
                  if (!closed) await handle.close().catch(() => {});
                  await fs.unlink(stagingPath).catch(() => {});
                }
              },
            },
            "immutable revision",
          ),
        );
      }
      // Verify the written revision validates BEFORE the manifest publishes.
      await this.store.verifyRevisionPrivate(this.dir, snapshot.revision);
      const manifest = {
        schemaVersion: 1,
        committedRevision: snapshot.revision,
        updatedAt: this.store.nowMs(),
      };
      const manifestText = canonicalJson(manifest);
      const priorManifest = await readOwnedRegularText(path.join(this.dir, "store.json")).catch(
        () => null,
      );
      await this.trackWrite(
        this.store.admittedWrite(
          this.dir,
          path.join(this.dir, "store.json"),
          manifestText,
          {
            chargeBytes: Buffer.from(manifestText, "utf8").length,
            rollback:
              priorManifest !== null
                ? { kind: "replace", prior: priorManifest }
                : { kind: "created" },
          },
          "revision manifest",
        ),
      );
      await fs.rm(path.join(this.dir, "incomplete.json"), { force: true }).catch(() => {});
      // Round complete: consume the materialized reservation exactly once.
      await fs.rm(path.join(this.dir, "reserve.settlement"), { force: true }).catch(() => {});
      return { revision: snapshot.revision };
    });
  }

  /**
   * Release the kernel gate. Pending owned writes DRAIN FIRST — the gate
   * closes only after every in-flight write completed, so a successor is
   * never admitted mid-write. Advisory metadata is removed while the gate
   * is still held (before close).
   */
  async release(): Promise<void> {
    if (this.released) return;
    this.releasing = true; // new mutations refuse from this instant
    // ponytail: unbounded drain — a funnel that never resolves holds the
    // gate forever; that is the conservative direction (never lose exclusion).
    while (this.pendingWrites > 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    await this.opChain.catch(() => {});
    this.released = true;
    // Metadata cleanup while the gate is still held: a successor never
    // observes or removes another owner's owner.lock.
    await fs.rm(path.join(this.dir, "owner.lock"), { force: true }).catch(() => {});
    await this.gate.release();
  }

  /** @internal — release from store-level failure paths (ack fault cleanup). */
  async forceRelease(): Promise<void> {
    await this.release();
  }

  // -- internal -----------------------------------------------------------

  private settlementReserveBytes(): number {
    // Mirror of the store cap configuration for the settlement bound.
    return (this.store as unknown as { settlementReserveBytes: number }).settlementReserveBytes;
  }

  /** Count an in-flight write so release() drains it before closing the gate. */
  private async trackWrite(p: Promise<void>): Promise<void> {
    this.pendingWrites += 1;
    try {
      await p;
    } finally {
      this.pendingWrites -= 1;
    }
  }

  private async requireActiveRound(roundId?: string): Promise<string> {
    // ONE complete bounded marker reader for every mutating lifecycle step
    // (fresh F3): a partial marker (right ownerId, missing shape) is corrupt,
    // never an active round.
    let marker: IncompleteMarker;
    try {
      marker = await readIncompleteMarker(this.dir);
    } catch (err) {
      if (err instanceof CorruptRecordError) throw err;
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new InvalidRecordInputError("No active round; call beginRound first.");
      }
      throw err;
    }
    if (marker.ownerId !== this.ownerId()) {
      throw new UnacknowledgedInterruptionError("Marker belongs to another owner.");
    }
    if (roundId !== undefined && marker.roundId !== roundId) {
      throw new InvalidRecordInputError(`Round ${roundId} is not the active round.`);
    }
    // Shared complete marker check (latest-correctness P1): an impossible
    // base revision is corrupted state, refused before staging/mutation.
    await validateMarkerAgainstCommitted(this.dir, marker);
    return marker.roundId;
  }

  /**
   * Like requireActiveRound, but refuses a round whose marker is already
   * `settled` — staging/body/audit appends must not run once the round is
   * settled (no charged-but-unreserved work in the settle→commit interval).
   * The terminal commitRevision uses this; a settled round has consumed its
   * reservation and only the validated commit transition remains.
   */
  private async requireUnsettledActiveRound(roundId?: string): Promise<string> {
    const activeRoundId = await this.requireActiveRound(roundId);
    const marker = await readIncompleteMarker(this.dir);
    if (marker.settled) {
      throw new InvalidRecordInputError(
        `Round ${activeRoundId} is already settled; staging/audit appends refuse after settlement (terminal commit only).`,
      );
    }
    return activeRoundId;
  }
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function validateRequirements(input: RequirementsInput): RequirementsInput {
  if (input === null || typeof input !== "object") {
    throw new InvalidRecordInputError("requirements must be an object.");
  }
  if (input.schemaVersion !== 1) {
    throw new InvalidRecordInputError("requirements.schemaVersion must be 1.");
  }
  const fields = input.fields;
  if (
    fields === null ||
    typeof fields !== "object" ||
    Array.isArray(fields) ||
    Object.keys(fields).length === 0
  ) {
    throw new InvalidRecordInputError("requirements.fields must be a non-empty map.");
  }
  for (const [fieldId, spec] of Object.entries(fields)) {
    if (!FIELD_ID_RE.test(fieldId)) {
      throw new InvalidRecordInputError(`Invalid field id: ${fieldId}`);
    }
    if (
      spec === null ||
      typeof spec !== "object" ||
      typeof spec.definition !== "string" ||
      spec.definition.length === 0 ||
      Buffer.byteLength(spec.definition, "utf8") > 4096 ||
      typeof spec.required !== "boolean"
    ) {
      throw new InvalidRecordInputError(`Malformed field spec: ${fieldId}`);
    }
  }
  if (Buffer.from(canonicalJson(input), "utf8").length > REQUIREMENTS_MAX_BYTES) {
    throw new InvalidRecordInputError(
      `requirements exceed ${REQUIREMENTS_MAX_BYTES} bytes serialized.`,
    );
  }
  return input;
}

export function openStore(options: OpenStoreOptions): RetainedRecordStore {
  return new RetainedRecordStore(options);
}

// Re-export for consumers/tests needing the gate kind names.
export const GATE_KIND_OWNER = "owner";
export const GATE_KIND_ADMISSION = "admission";
