/**
 * Retained investigation record store — caller-assisted engine ticket 1
 * (retained-records). Corrected per cold review (see ticket cold-review).
 *
 * Authoritative local record library: immutable revision snapshots,
 * content-addressed shared body files, a small atomically replaced manifest,
 * kernel-verified local-owner exclusion (no age-based takeover), explicit
 * acknowledge/delete-only recovery, and actual-byte store/record admission
 * (32MiB record / 256MiB store / 64KiB settlement reserve, plus physically
 * provisioned 8KiB recovery/audit headroom per dispatched round).
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
 *     revisions/.r<n>.json.<pid>.<uuid>.stage.tmp
 *                            retained candidate until publication cleanup;
 *                            acknowledged unpublished candidates remain evidence
 *     bodies/<sha256hex>.bin content-addressed shared bodies (deduped)
 *     audit/round-<id>.json  per-round bounded audit rows (never replaced
 *                            by settlement)
 *     audit/settlement-<id>.json  round settlement summary (separate file)
 *     audit/ack-<instance hash>.record  preallocated recovery headroom, then
 *                            one sealed authoritative interruption disposition
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
// Required audit headroom, physically provisioned before dispatch and kept
// across settlement/publication. Only its private mutable receipt slot is
// written in place; snapshots and all other documents remain atomic writes.
const RECOVERY_BYTES = 8192;
const RECOVERY_HEADER_BYTES = 2048;
const RECOVERY_PAYLOAD_BYTES = 4096;
const RECOVERY_SEAL_BYTES = 128;
const RECOVERY_SEAL_OFFSET = RECOVERY_HEADER_BYTES + RECOVERY_PAYLOAD_BYTES;

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
  /** Atomic document/staging fault seam; native publication and the private
   * preallocated ACK slot retain store-owned no-clobber/durability authority. */
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
      try {
        const stat = await fs.lstat(child);
        total += stat.size;
      } catch (err) {
        // Destructive sibling deletion may remove a listed leaf while this
        // admitted write measures the store. It only reduces retained bytes;
        // all admitted additions remain serialized by the admission gate.
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
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
  // Open the file we CHECKED, never a substitute (L5 F3): the open is
  // no-follow, the handle's own type must be regular, and its device/inode
  // identity must match the lstat above before a single byte is read. A leaf
  // swapped to a symlink fails ELOOP at open; a same-content replacement
  // under a different inode fails the identity comparison — digest equality
  // can never bless an unverified inode. The open is also NON-BLOCKING: a
  // leaf swapped to a FIFO between the check and a plain O_RDONLY open would
  // block the reader indefinitely waiting for a writer (open(2)); O_NONBLOCK
  // makes the open return immediately so the handle's own regular-file check
  // can refuse it. O_NONBLOCK has no effect on regular-file semantics.
  const noFollow: number | undefined = fs.constants.O_NOFOLLOW;
  const nonBlock: number | undefined = fs.constants.O_NONBLOCK;
  if (noFollow === undefined || nonBlock === undefined) {
    // Fail closed within the supported-platform contract: a read without the
    // no-follow/non-blocking guarantees is refused, never silently followed
    // or blocked.
    throw new CorruptContentError(
      `Cannot safely open retained file without no-follow/non-blocking guarantees on this platform: ${p}`,
    );
  }
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(p, fs.constants.O_RDONLY | noFollow | nonBlock);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ELOOP") {
      throw new CorruptContentError(`Retained file is a symlink: ${p}`) as Error &
        NodeJS.ErrnoException;
    }
    throw err;
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) {
      throw new CorruptContentError(`Opened retained file is not a regular file: ${p}`) as Error &
        NodeJS.ErrnoException;
    }
    if (opened.dev !== stat.dev || opened.ino !== stat.ino) {
      throw new CorruptContentError(
        `Retained file identity changed between check and open: ${p}`,
      ) as Error & NodeJS.ErrnoException;
    }
    // Incremental bounded read (Opus closure G3): the byte ceiling is enforced
    // by an ACTIVE counter during the read, so a concurrent writer cannot grow
    // the file between the stat precheck and the read and cause an unbounded
    // allocation/parse. We read at most maxBytes+1 bytes; the +1 proves overflow
    // without ever buffering more than the ceiling.
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
  recovery?: NativeFileIdentity & { name: string };
  publication?: PublicationProof;
}

interface NativeFileIdentity { device: string; inode: string }
interface PublicationProof {
  revision: number;
  digest: string;
  stageName: string;
  identity?: NativeFileIdentity;
}
interface PublicationDisposition {
  disposition: "unverified-preparation" | "unpublished" | "completed";
  proof: PublicationProof;
}
type InterruptedIdentity = Pick<IncompleteMarker, "roundId" | "ownerId" | "revisionBase">;
interface AckReceipt {
  schemaVersion: 1;
  kind: "acknowledge-interrupted";
  roundId: string;
  priorOwner: string;
  revisionBase: number;
  at: number;
  remoteWork: "unknown";
  publication?: PublicationDisposition;
}

function validatePublicationShape(value: unknown, base: number): PublicationProof {
  if (!isPlainObject(value) || !Number.isSafeInteger(value.revision) || value.revision !== base + 1 ||
    typeof value.digest !== "string" || !SHA256_HEX_RE.test(value.digest) ||
    typeof value.stageName !== "string" || value.stageName.length > 160 ||
    !/^\.r[1-9][0-9]*\.json\.[1-9][0-9]*\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.stage\.tmp$/.test(value.stageName) ||
    !value.stageName.startsWith(`.r${value.revision}.json.`) ||
    Object.keys(value).length !== (value.identity === undefined ? 3 : 4) ||
    (value.identity !== undefined && (!validIdentity(value.identity) || Object.keys(value.identity).length !== 2))) {
    throw new CorruptRecordError("Incomplete publication proof corrupt.");
  }
  return { revision: value.revision as number, digest: value.digest, stageName: value.stageName,
    ...(value.identity !== undefined ? { identity: { device: value.identity.device, inode: value.identity.inode } } : {}) };
}

function nativeIdentity(stat: { dev: bigint; ino: bigint }): NativeFileIdentity {
  return { device: stat.dev.toString(), inode: stat.ino.toString() };
}

function sameIdentity(a: NativeFileIdentity, b: NativeFileIdentity): boolean {
  return a.device === b.device && a.inode === b.inode;
}

function validIdentity(value: unknown): value is NativeFileIdentity {
  return isPlainObject(value) && typeof value.device === "string" &&
    typeof value.inode === "string" && /^(0|[1-9][0-9]{0,31})$/.test(value.device) &&
    /^(0|[1-9][0-9]{0,31})$/.test(value.inode);
}

function recoveryName(marker: InterruptedIdentity): string {
  return `ack-${sha256Hex(canonicalJson([marker.roundId, marker.ownerId, marker.revisionBase]))}.record`;
}

async function openNativeOwnedFile(
  dir: string, file: string, writable: boolean, expected?: NativeFileIdentity,
): Promise<{ handle: Awaited<ReturnType<typeof fs.open>>; identity: NativeFileIdentity }> {
  await assertNoSymlinkComponents(dir, file);
  const before = await fs.lstat(file, { bigint: true });
  if (!before.isFile() || before.size > BigInt(SNAPSHOT_MAX_BYTES)) {
    throw new CorruptContentError(`Invalid bounded native retained file: ${file}`);
  }
  const { O_NOFOLLOW, O_NONBLOCK, O_RDONLY, O_RDWR } = fs.constants;
  if (O_NOFOLLOW === undefined || O_NONBLOCK === undefined) {
    throw new CorruptContentError("Safe native file flags unavailable.");
  }
  const handle = await fs.open(file, (writable ? O_RDWR : O_RDONLY) | O_NOFOLLOW | O_NONBLOCK);
  try {
    const opened = await handle.stat({ bigint: true });
    const identity = nativeIdentity(opened);
    if (!opened.isFile() || !sameIdentity(identity, nativeIdentity(before)) ||
      (expected !== undefined && !sameIdentity(identity, expected))) {
      throw new CorruptContentError(`Native retained file identity changed: ${file}`);
    }
    return { handle, identity };
  } catch (err) {
    await handle.close();
    throw err;
  }
}

async function readNativeBounded(handle: Awaited<ReturnType<typeof fs.open>>, max: number): Promise<Buffer> {
  const bytes = Buffer.alloc(max + 1);
  let total = 0;
  while (total <= max) {
    const result = await handle.read(bytes, total, max + 1 - total, total);
    if (result.bytesRead === 0) return bytes.subarray(0, total);
    total += result.bytesRead;
  }
  throw new CorruptRecordError(`Native retained file exceeds ${max} bytes.`);
}

function recoveryHeader(marker: InterruptedIdentity): Record<string, unknown> {
  return { schemaVersion: 1, kind: "ack-recovery", roundId: marker.roundId,
    priorOwner: marker.ownerId, revisionBase: marker.revisionBase, reserveBytes: RECOVERY_BYTES };
}

function paddedJson(value: unknown, length: number): Buffer {
  const encoded = Buffer.from(canonicalJson(value));
  if (encoded.length > length) throw new InvalidRecordInputError("Recovery record field exceeds its bound.");
  const buffer = Buffer.alloc(length);
  encoded.copy(buffer);
  return buffer;
}

function paddedText(bytes: Buffer): string {
  const end = bytes.indexOf(0);
  if (end !== -1 && bytes.subarray(end).some((byte) => byte !== 0)) {
    throw new CorruptRecordError("Recovery field has nonzero trailing padding.");
  }
  return bytes.subarray(0, end === -1 ? bytes.length : end).toString("utf8");
}

function parseRecovery(bytes: Buffer, marker: InterruptedIdentity): AckReceipt | null {
  if (bytes.length !== RECOVERY_BYTES) throw new CorruptRecordError("Recovery envelope allocation changed.");
  let header: unknown;
  try { header = JSON.parse(paddedText(bytes.subarray(0, RECOVERY_HEADER_BYTES))); }
  catch { throw new CorruptRecordError("Recovery envelope header corrupt."); }
  if (canonicalJson(header) !== canonicalJson(recoveryHeader(marker))) {
    throw new CorruptRecordError("Recovery envelope header/instance mismatch.");
  }
  const sealBytes = bytes.subarray(RECOVERY_SEAL_OFFSET, RECOVERY_SEAL_OFFSET + RECOVERY_SEAL_BYTES);
  let seal: unknown;
  const sealEnd = sealBytes.indexOf(0);
  try { seal = JSON.parse(sealBytes.subarray(0, sealEnd === -1 ? sealBytes.length : sealEnd).toString("utf8")); }
  catch (err) {
    if (err instanceof SyntaxError) return null; // genuinely torn/unsealed preparation
    throw err;
  }
  // A complete JSON seal with bad padding is corruption, never pending.
  paddedText(sealBytes);
  if (!isPlainObject(seal) || !Number.isInteger(seal.bytes) || (seal.bytes as number) <= 0 ||
    (seal.bytes as number) > RECOVERY_PAYLOAD_BYTES || typeof seal.digest !== "string" ||
    !SHA256_HEX_RE.test(seal.digest) || Object.keys(seal).length !== 2) {
    throw new CorruptRecordError("Complete recovery seal corrupt.");
  }
  const payload = bytes.subarray(RECOVERY_HEADER_BYTES, RECOVERY_HEADER_BYTES + (seal.bytes as number));
  if (sha256Hex(payload) !== seal.digest) throw new CorruptRecordError("Sealed recovery checksum mismatch.");
  let receipt: unknown;
  try { receipt = JSON.parse(payload.toString("utf8")); }
  catch { throw new CorruptRecordError("Sealed recovery payload corrupt."); }
  if (!isPlainObject(receipt) || receipt.schemaVersion !== 1 || receipt.kind !== "acknowledge-interrupted" ||
    receipt.roundId !== marker.roundId || receipt.priorOwner !== marker.ownerId ||
    receipt.revisionBase !== marker.revisionBase || receipt.remoteWork !== "unknown" ||
    typeof receipt.at !== "number" || !Number.isFinite(receipt.at) || receipt.at < 0 ||
    Object.keys(receipt).length !== (receipt.publication === undefined ? 7 : 8)) {
    throw new CorruptRecordError("Sealed recovery receipt conflicts with interrupted instance.");
  }
  if (receipt.publication !== undefined) {
    if (!isPlainObject(receipt.publication) || Object.keys(receipt.publication).length !== 2 ||
      typeof receipt.publication.disposition !== "string" ||
      !["unverified-preparation", "unpublished", "completed"].includes(receipt.publication.disposition)) {
      throw new CorruptRecordError("Sealed publication disposition malformed.");
    }
    const proof = validatePublicationShape(receipt.publication.proof, marker.revisionBase);
    if ((receipt.publication.disposition === "unverified-preparation") !== (proof.identity === undefined)) {
      throw new CorruptRecordError("Sealed disposition contradicts native publication proof.");
    }
  }
  return receipt as unknown as AckReceipt;
}

async function assertNativeIdentity(file: string, expected: NativeFileIdentity): Promise<void> {
  const stat = await fs.lstat(file, { bigint: true });
  if (!stat.isFile() || !sameIdentity(nativeIdentity(stat), expected)) {
    throw new CorruptContentError(`Refusing changed native retained path: ${file}`);
  }
}

async function syncOwnedDirectory(dir: string): Promise<void> {
  const handle = await fs.open(dir, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function createRecoveryHeld(
  store: RetainedRecordStore, dir: string, marker: InterruptedIdentity,
): Promise<NativeFileIdentity & { name: string }> {
  const name = recoveryName(marker);
  const file = path.join(dir, "audit", name);
  const bytes = Buffer.alloc(RECOVERY_BYTES);
  paddedJson(recoveryHeader(marker), RECOVERY_HEADER_BYTES).copy(bytes);
  await store.admittedWriteHeld(dir, file, bytes, {
    chargeBytes: RECOVERY_BYTES * 2, rollback: { kind: "none" },
    writeImpl: async () => {
      const auditDir = path.dirname(file);
      await fs.mkdir(auditDir, { recursive: true, mode: 0o700 });
      const stage = path.join(auditDir, `.${name}.${process.pid}.${randomUUID()}.reserve.tmp`);
      let mine: NativeFileIdentity | undefined;
      let primary: unknown;
      try {
        const handle = await fs.open(stage, "wx", 0o600);
        try {
          mine = nativeIdentity(await handle.stat({ bigint: true }));
          await handle.writeFile(bytes);
          await handle.sync();
        } finally { await handle.close(); }
        const injected = store.depsWriteFunnel();
        if (injected !== undefined) await injected(stage, bytes);
        const staged = await openNativeOwnedFile(dir, stage, false);
        try {
          if (!(await readNativeBounded(staged.handle, RECOVERY_BYTES)).equals(bytes)) {
            throw new CorruptRecordError("Recovery staging bytes changed.");
          }
          mine = staged.identity;
          await staged.handle.sync();
        } finally { await staged.handle.close(); }
        try { await fs.link(stage, file); }
        catch (err) {
          if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new CorruptRecordError("Recovery envelope name already occupied.");
          throw err;
        }
        await assertNativeIdentity(file, mine);
        await syncOwnedDirectory(auditDir);
      } catch (err) {
        primary = err;
        throw err;
      } finally {
        if (mine !== undefined && await entryExistsStrict(stage)) {
          try {
            await assertNativeIdentity(stage, mine);
            await fs.unlink(stage);
          } catch (cleanupError) {
            if (primary !== undefined) {
              throw new CorruptRecordError(`Recovery preparation failed (${String(primary)}) and native staging cleanup failed (${String(cleanupError)}); unfinished state retained.`);
            }
            throw cleanupError;
          }
        }
      }
    },
  }, "recovery envelope native placement");
  const opened = await openNativeOwnedFile(dir, file, false);
  try { parseRecovery(await readNativeBounded(opened.handle, RECOVERY_BYTES), marker); }
  finally { await opened.handle.close(); }
  return { name, ...opened.identity };
}

async function sealRecovery(dir: string, marker: IncompleteMarker, at: number, publication?: PublicationDisposition): Promise<void> {
  if (marker.recovery === undefined) throw new CorruptRecordError("Recovery envelope missing.");
  const file = path.join(dir, "audit", marker.recovery.name);
  const { handle } = await openNativeOwnedFile(dir, file, true, marker.recovery);
  try {
    const existing = parseRecovery(await readNativeBounded(handle, RECOVERY_BYTES), marker);
    if (existing !== null && canonicalJson(existing.publication) !== canonicalJson(publication)) {
      throw new CorruptRecordError("Authoritative receipt publication conflicts with current proof.");
    }
    if (existing === null) {
      const receipt: AckReceipt = { schemaVersion: 1, kind: "acknowledge-interrupted", roundId: marker.roundId,
        priorOwner: marker.ownerId, revisionBase: marker.revisionBase, at, remoteWork: "unknown",
        ...(publication !== undefined ? { publication } : {}) };
      const payload = Buffer.from(canonicalJson(receipt));
      const writeSlot = async (buffer: Buffer, offset: number): Promise<void> => {
        let written = 0;
        while (written < buffer.length) {
          const result = await handle.write(buffer, written, buffer.length - written, offset + written);
          if (result.bytesWritten === 0) throw new CorruptRecordError("Recovery slot write made no progress.");
          written += result.bytesWritten;
        }
      };
      await writeSlot(paddedJson(receipt, RECOVERY_PAYLOAD_BYTES), RECOVERY_HEADER_BYTES);
      await handle.sync();
      await writeSlot(paddedJson({ bytes: payload.length, digest: sha256Hex(payload) }, RECOVERY_SEAL_BYTES), RECOVERY_SEAL_OFFSET);
    }
    // Also sync an already-valid receipt: a prior owner may have exited
    // after its last write but before the final durability barrier.
    const final = parseRecovery(await readNativeBounded(handle, RECOVERY_BYTES), marker);
    if (final === null) throw new CorruptRecordError("Recovery receipt not sealed.");
    await assertNativeIdentity(file, marker.recovery);
    await handle.sync();
    await assertNativeIdentity(file, marker.recovery);
  } finally { await handle.close(); }
}

/** Marker is absent, owner/admission held, and committed view verified. */
async function cleanupPendingRecoveries(dir: string, committed: number, reserveBytes: number): Promise<void> {
  const auditDir = path.join(dir, "audit");
  await assertNoSymlinkComponents(dir, auditDir);
  const entries = await fs.readdir(auditDir).catch((err) => {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  });
  for (const name of entries) {
    if (!/^ack-[0-9a-f]{64}\.record$/.test(name)) continue;
    const file = path.join(auditDir, name);
    const opened = await openNativeOwnedFile(dir, file, false);
    let pending = false;
    try {
      const bytes = await readNativeBounded(opened.handle, RECOVERY_BYTES);
      let header: unknown;
      try { header = JSON.parse(paddedText(bytes.subarray(0, RECOVERY_HEADER_BYTES))); }
      catch { throw new CorruptRecordError("Orphan recovery header corrupt; preserving file."); }
      if (!isPlainObject(header) || typeof header.roundId !== "string" || !ROUND_ID_RE.test(header.roundId) ||
        typeof header.priorOwner !== "string" || header.priorOwner.length === 0 || header.priorOwner.length > OWNER_ID_MAX_BYTES ||
        !Number.isInteger(header.revisionBase) || (header.revisionBase as number) < 0 || (header.revisionBase as number) > committed) {
        throw new CorruptRecordError("Orphan recovery instance cannot be verified.");
      }
      const identity = { roundId: header.roundId, ownerId: header.priorOwner, revisionBase: header.revisionBase as number };
      if (name !== recoveryName(identity)) throw new CorruptRecordError("Orphan recovery filename mismatch.");
      pending = parseRecovery(bytes, identity) === null;
      if (pending) {
        const reservePath = path.join(dir, "reserve.settlement");
        const reserve = await readIncompleteReserve(dir, reservePath, reserveBytes);
        if (reserve !== null) {
          if (reserve.roundId !== identity.roundId || reserve.ownerId !== identity.ownerId) {
            throw new CorruptRecordError("Orphan settlement reserve belongs to another preparation.");
          }
          // Reserve first, envelope last: interruption retains cleanup provenance.
          await fs.unlink(reservePath);
          await syncOwnedDirectory(dir);
        } else if (await fileExists(reservePath)) {
          throw new CorruptRecordError("Orphan settlement reserve corrupt.");
        }
      }
    } finally { await opened.handle.close(); }
    if (pending) {
      await assertNativeIdentity(file, opened.identity);
      await fs.unlink(file);
      await syncOwnedDirectory(auditDir);
    }
  }
}

async function entryExistsStrict(file: string): Promise<boolean> {
  try { await fs.lstat(file); return true; }
  catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return false; throw err; }
}

async function verifyPublicationFile(dir: string, file: string, proof: PublicationProof): Promise<void> {
  if (proof.identity === undefined) throw new CorruptRecordError("Publication native proof missing.");
  const opened = await openNativeOwnedFile(dir, file, false, proof.identity);
  try {
    const bytes = await readNativeBounded(opened.handle, SNAPSHOT_MAX_BYTES);
    if (sha256Hex(bytes) !== proof.digest) throw new CorruptRecordError("Publication candidate digest mismatch.");
    await verifySnapshotFile(dir, file, proof.revision);
    await assertNativeIdentity(file, proof.identity);
  } finally { await opened.handle.close(); }
}

async function publicationDisposition(
  store: RetainedRecordStore, dir: string, marker: IncompleteMarker,
): Promise<PublicationDisposition | undefined> {
  const committed = await store.currentCommittedRevision(dir);
  await store.verifyRevisionPrivate(dir, committed);
  const proof = marker.publication;
  const final = path.join(dir, "revisions", `r${marker.revisionBase + 1}.json`);
  if (proof === undefined) {
    await validateMarkerAgainstCommitted(dir, marker);
    if (await entryExistsStrict(final)) throw new CorruptRecordError("Unproven next revision present; cannot acknowledge publication.");
    return undefined;
  }
  if (committed !== marker.revisionBase && committed !== proof.revision) {
    throw new CorruptRecordError("Publication marker cannot be bound to committed view.");
  }
  const stage = path.join(dir, "revisions", proof.stageName);
  const finalExists = await entryExistsStrict(final);
  if (proof.identity === undefined) {
    if (committed !== marker.revisionBase || finalExists) {
      throw new CorruptRecordError("Final publication lacks native proof.");
    }
    if (await entryExistsStrict(stage)) {
      // Preserve even partial/invalid bytes as UNVERIFIED preparation.
      // Opening checks containment/type/identity only; do not parse content.
      const opened = await openNativeOwnedFile(dir, stage, false);
      await opened.handle.close();
    }
    return { disposition: "unverified-preparation", proof };
  }
  if (await entryExistsStrict(stage)) await verifyPublicationFile(dir, stage, proof);
  else if (committed !== proof.revision) throw new CorruptRecordError("Unpublished candidate stage missing.");
  if (finalExists) await verifyPublicationFile(dir, final, proof);
  else if (committed === proof.revision) throw new CorruptRecordError("Completed publication final missing.");
  return { disposition: committed === proof.revision ? "completed" : "unpublished", proof };
}

async function disposePublication(dir: string, disposition: PublicationDisposition | undefined): Promise<void> {
  if (disposition === undefined) return;
  const proof = disposition.proof;
  const final = path.join(dir, "revisions", `r${proof.revision}.json`);
  const stage = path.join(dir, "revisions", proof.stageName);
  if (disposition.disposition === "unverified-preparation") {
    if (await entryExistsStrict(final)) throw new CorruptRecordError("Unproven final appeared during disposition.");
    return; // partial stage remains untouched, with its intention in the receipt
  }
  if (disposition.disposition === "completed") {
    await verifyPublicationFile(dir, final, proof);
    if (await entryExistsStrict(stage)) {
      await verifyPublicationFile(dir, stage, proof);
      await fs.unlink(stage);
      await syncOwnedDirectory(path.dirname(stage));
    }
  } else {
    await verifyPublicationFile(dir, stage, proof);
    if (await entryExistsStrict(final)) {
      await verifyPublicationFile(dir, final, proof);
      await fs.unlink(final);
      await syncOwnedDirectory(path.dirname(final));
    }
  }
}

async function removePendingRecovery(dir: string, marker: IncompleteMarker): Promise<void> {
  if (marker.recovery === undefined) return;
  const file = path.join(dir, "audit", marker.recovery.name);
  const opened = await openNativeOwnedFile(dir, file, false, marker.recovery);
  try {
    if (parseRecovery(await readNativeBounded(opened.handle, RECOVERY_BYTES), marker) !== null) {
      throw new CorruptRecordError("Refusing to collect authoritative historical receipt.");
    }
  } finally { await opened.handle.close(); }
  await assertNativeIdentity(file, marker.recovery);
  await fs.unlink(file);
  await syncOwnedDirectory(path.dirname(file));
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
  if (parsed.recovery !== undefined && (!validIdentity(parsed.recovery) ||
    !isPlainObject(parsed.recovery) || typeof parsed.recovery.name !== "string" ||
    Object.keys(parsed.recovery).length !== 3 ||
    parsed.recovery.name !== recoveryName({ roundId: parsed.roundId, ownerId: parsed.ownerId, revisionBase: parsed.revisionBase as number }))) {
    throw new CorruptRecordError("Incomplete marker recovery binding corrupt.");
  }
  return {
    schemaVersion: 1,
    roundId: parsed.roundId,
    intent: parsed.intent as "start" | "continue",
    ownerId: parsed.ownerId,
    startedAt: parsed.startedAt,
    revisionBase: parsed.revisionBase as number,
    settled: parsed.settled,
    ...(parsed.recovery !== undefined ? { recovery: {
      device: parsed.recovery.device, inode: parsed.recovery.inode, name: String(parsed.recovery.name),
    } } : {}),
    ...(parsed.publication !== undefined ? { publication: validatePublicationShape(parsed.publication, parsed.revisionBase as number) } : {}),
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

/** Encode the full actual header before allocating or publishing any reserve. */
function encodeSettlementReserve(roundId: string, ownerId: string, reserveBytes: number): Buffer {
  const header = Buffer.from(canonicalJson({
    schemaVersion: 1,
    kind: "settlement-reserve",
    roundId,
    ownerId,
    reserveBytes,
  }), "utf8");
  if (header.length > reserveBytes) {
    throw new InvalidRecordInputError(
      `Settlement reserve header requires ${header.length} bytes, configured reserve has ${reserveBytes}.`,
    );
  }
  const buffer = Buffer.alloc(reserveBytes);
  header.copy(buffer);
  return buffer;
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
  /** Additional physical bytes at the native peak (full replacement temp,
   * or all charged stage/link entries, rather than only final size growth). */
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

async function verifySnapshotFile(dir: string, file: string, revision: number): Promise<RevisionSnapshot> {
    let snapshot: RevisionSnapshot;
    try {
      const text = await readOwnedTextUnder(dir, file);
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
      configuredReserve <= 0 ||
      configuredReserve > SNAPSHOT_MAX_BYTES
    ) {
      throw new InvalidRecordInputError(
        `settlementReserveBytes must be a positive integer no greater than ${SNAPSHOT_MAX_BYTES}, got ${String(configuredReserve)}.`,
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
    await this.withAdmission(() =>
      this.admittedWriteHeld(recordDir, filePath, contents, spec, label),
    );
  }

  /**
   * @internal — admission-checked write for code ALREADY inside one held
   * admission turn (the bounded settle/ack lifecycle transitions, L5 F1).
   * This is the small internal admission primitive those transitions share:
   * it is never caller-supplied and never skips the fence — the full
   * measure → check → write → re-measure sequence still runs inside the
   * already-held turn, so no nested gate acquisition can deadlock.
   */
  async admittedWriteHeld(
    recordDir: string,
    filePath: string,
    contents: string | Uint8Array,
    spec: AdmissionSpec,
    label: string,
  ): Promise<void> {
    const doWrite = spec.writeImpl ?? ((p: string, c: string | Uint8Array) => this.write(p, c));
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
  }

  /**
   * @internal — run one bounded lifecycle transition (settle/ack) under a
   * single held admission turn, so the reserve it consumes cannot be spent
   * by a sibling between its removal and the writes it pays for, and its
   * rollback restores bytes under the same fence (L5 F1).
   */
  admittedTransition<T>(fn: () => Promise<T>): Promise<T> {
    return this.withAdmission(fn);
  }

  /** @internal — capacity measurement for handle-run lifecycle transitions. */
  measureCapsFor(recordDir: string): Promise<{ recordBytes: number; storeBytes: number }> {
    return this.measureCaps(recordDir);
  }

  /** @internal — cap fence for handle-run lifecycle transitions. */
  checkCapsFor(recordBytes: number, storeBytes: number, charge: number, label: string): void {
    this.checkCaps(recordBytes, storeBytes, charge, false, label);
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
   * Preserves the unknown interval as a sealed bounded receipt, clears the incomplete
   * marker, and returns the live handle for ONE fresh round. Any failure
   * releases the gate before propagating — the handle never leaks.
   */
  async acknowledgeInterrupted(ref: string): Promise<OwnershipHandle> {
    const handle = await this.acquireOwnership(ref);
    try {
      const inspection = await this.inspect(ref);
      if (inspection.damage !== undefined && /over-cap/.test(inspection.damage)) {
        throw new StoreCapacityError(`Cannot acknowledge ${ref}: ${inspection.damage}.`);
      }
      if (inspection.committed === null || inspection.damage !== undefined) {
        throw new CorruptRecordError(`Cannot acknowledge ${ref}: committed view damaged (${inspection.damage ?? "unknown"}).`);
      }
      if (inspection.incomplete === null) {
        throw new UnacknowledgedInterruptionError(`No incomplete round marker present on ${ref}; nothing to acknowledge.`);
      }
      await this.withAdmission(async () => {
        const marker = await readIncompleteMarker(handle.dir);
        const publication = await publicationDisposition(this, handle.dir, marker);
        const auditPath = path.join(handle.dir, "audit", `round-${marker.roundId}.json`);
        try {
          const doc = JSON.parse(await readOwnedTextUnder(handle.dir, auditPath)) as unknown;
          if (!isPlainObject(doc) || doc.schemaVersion !== 1 || doc.roundId !== marker.roundId ||
            !Array.isArray(doc.rows) || doc.rows.length > AUDIT_MAX_ROWS) {
            throw new CorruptRecordError("Normal interrupted audit corrupt; preserving bytes.");
          }
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
        const reservePath = path.join(handle.dir, "reserve.settlement");
        const reserve = await readIncompleteReserve(handle.dir, reservePath, this.settlementReserveBytes);
        if (reserve !== null && (reserve.roundId !== marker.roundId || reserve.ownerId !== marker.ownerId)) {
          throw new CorruptRecordError("Settlement reserve does not match interrupted owner/round.");
        }
        if (reserve === null && await fileExists(reservePath)) {
          throw new CorruptRecordError("Settlement reserve header corrupt.");
        }
        if (marker.recovery === undefined) {
          // Legacy rounds never provisioned this headroom. Measure real room;
          // normal ACK-looking rows cannot manufacture recovery authority.
          const name = recoveryName(marker);
          const file = path.join(handle.dir, "audit", name);
          try {
            const opened = await openNativeOwnedFile(handle.dir, file, false);
            try { parseRecovery(await readNativeBounded(opened.handle, RECOVERY_BYTES), marker); }
            finally { await opened.handle.close(); }
            marker.recovery = { name, ...opened.identity };
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
            marker.recovery = await createRecoveryHeld(this, handle.dir, marker);
          }
        }
        await sealRecovery(handle.dir, marker, this.nowMs(), publication);
        await disposePublication(handle.dir, publication);
        // The durable bounded receipt already occupies its provisioned bytes.
        // No reserve-to-temp gap exists, even if this owner exits right here.
        if (reserve !== null) await fs.unlink(reservePath);
        await fs.unlink(path.join(handle.dir, "incomplete.json"));
        await syncOwnedDirectory(handle.dir);
      });
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
    return verifySnapshotFile(dir, path.join(dir, "revisions", `r${revision}.json`), revision);
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
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      if (err instanceof SyntaxError) {
        throw new CorruptRecordError("Manifest contains invalid JSON; delete-only recovery.");
      }
      throw err;
    }
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

  /** Provision settlement+recovery, then publish the marker before dispatch. */
  async beginRound(options: BeginRoundOptions): Promise<void> {
    await this.enqueue(async () => {
      if (this.roundBegun) throw new InvalidRecordInputError("Handle already began its one fresh round.");
      validateRoundId(options.roundId);
      if (options.intent !== "start" && options.intent !== "continue") {
        throw new InvalidRecordInputError('intent must be "start" or "continue".');
      }
      // Encode the actual header before allocating/publishing any retained round state.
      const reserveBuf = encodeSettlementReserve(options.roundId, this.ownerId(), this.store.settlementReserveBytesForCap());
      const markerPath = path.join(this.dir, "incomplete.json");
      await this.store.admittedTransition(async () => {
        try {
          await readIncompleteMarker(this.dir);
          throw new UnacknowledgedInterruptionError("Unacknowledged interrupted round present; call acknowledgeInterrupted or delete.");
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
        const revisionBase = await this.store.currentCommittedRevision(this.dir);
        await this.store.verifyRevisionPrivate(this.dir, revisionBase);
        await cleanupPendingRecoveries(this.dir, revisionBase, this.store.settlementReserveBytesForCap());
        const marker: IncompleteMarker = { schemaVersion: 1, roundId: options.roundId, intent: options.intent,
          ownerId: this.ownerId(), startedAt: this.store.nowMs(), revisionBase, settled: false };
        paddedJson(recoveryHeader(marker), RECOVERY_HEADER_BYTES);
        const worstMarker = canonicalJson({ ...marker, recovery: { name: recoveryName(marker),
          device: "9".repeat(32), inode: "9".repeat(32) } });
        const caps = await this.store.measureCapsFor(this.dir);
        this.store.checkCapsFor(caps.recordBytes, caps.storeBytes,
          Math.max(RECOVERY_BYTES * 2, RECOVERY_BYTES + reserveBuf.length + Buffer.byteLength(worstMarker)),
          "complete pre-dispatch reservations and marker");
        marker.recovery = await createRecoveryHeld(this.store, this.dir, marker);
        await this.store.admittedWriteHeld(this.dir, path.join(this.dir, "reserve.settlement"), reserveBuf,
          { chargeBytes: reserveBuf.length, rollback: { kind: "created" } }, "round settlement reserve");
        const text = canonicalJson(marker);
        await this.store.admittedWriteHeld(this.dir, markerPath, text,
          { chargeBytes: Buffer.byteLength(text), rollback: { kind: "created" } }, `round ${options.roundId}`);
      });
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

  /**
   * Audit append targeting an explicit round for the ACK transition, which
   * already holds the store admission turn (L5 F1): the write runs through
   * the in-turn admission primitive instead of acquiring the gate again —
   * same charged fence, no nested-admission deadlock.
   */
  appendAuditInTurn(roundId: string, row: AuditRow): Promise<void> {
    return this.enqueue(async () => {
      await this.appendAuditFor(roundId, row, true);
    });
  }

  private async appendAuditFor(roundId: string, row: AuditRow, held = false): Promise<void> {
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
    if (Buffer.byteLength(bytes, "utf8") > SNAPSHOT_MAX_BYTES) {
      throw new StoreCapacityError(`Serialized audit exceeds ${SNAPSHOT_MAX_BYTES} bytes for round ${roundId}.`);
    }
    await fs.mkdir(path.join(this.dir, "audit"), { recursive: true, mode: 0o700 }).catch(() => {});
    await this.trackWrite(
      held
        ? this.store.admittedWriteHeld(
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
          )
        : this.store.admittedWrite(
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
      // ONE admission turn owns the complete transition (L5 F1): the reserve
      // cannot be spent by a sibling between its removal and the writes it
      // pays for, and a failed transition restores it under the same fence.
      // The transition's TRUE native peak is admitted before any mutation
      // (L5 F2): the marker flip runs FIRST — the old marker and its full
      // replacement temp coexist on the small post-removal base — then the
      // summary temp, so a summary inside the reserve never pushes the
      // physical tree over the cap, and a transition that cannot fit refuses
      // with its reservation and prior marker intact.
      const newSummaryBytes = Buffer.from(bytes, "utf8").length;
      const newMarkerBytes = Buffer.from(settledMarkerText, "utf8").length;
      const priorMarkerBytes = Buffer.from(priorMarkerText, "utf8").length;
      const reserveBytes = this.settlementReserveBytes();
      let reserveRemoved = false;
      let markerFlipped = false;
      await this.store.admittedTransition(async () => {
        try {
          const caps = await this.store.measureCapsFor(this.dir);
          const freedRecord = caps.recordBytes - reserveBytes;
          const freedStore = caps.storeBytes - reserveBytes;
          // Interval 1 — marker replacement temp coexisting with the old
          // marker, immediately after the reserve is removed.
          this.store.checkCapsFor(freedRecord, freedStore, newMarkerBytes, "settlement marker peak");
          // Interval 2 — summary temp coexisting with any prior summary,
          // after the (shrinking) marker flip has landed.
          this.store.checkCapsFor(
            freedRecord - priorMarkerBytes + newMarkerBytes,
            freedStore - priorMarkerBytes + newMarkerBytes,
            newSummaryBytes,
            "settlement summary peak",
          );
          await fs.rm(reservePath, { force: true });
          reserveRemoved = true;
          await this.trackWrite(
            this.store.admittedWriteHeld(
              this.dir,
              markerPath,
              settledMarkerText,
              {
                // The replacement temp coexists with the old marker: charge
                // the FULL new marker bytes, not just its growth (L5 F2).
                chargeBytes: newMarkerBytes,
                rollback: { kind: "replace", prior: priorMarkerText },
              },
              "settlement marker",
            ),
          );
          markerFlipped = true;
          await this.trackWrite(
            this.store.admittedWriteHeld(
              this.dir,
              settlementPath,
              bytes,
              {
                // The summary temp coexists with any prior summary while the
                // freed reserve is the only headroom: charge its full bytes.
                chargeBytes: newSummaryBytes,
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
          // Roll back under the SAME held fence (L5 F1): restore the
          // unsettled marker and the reservation through admitted writes, and
          // surface a restoration failure truthfully — never claim a
          // rollback that did not happen, never restore silently over cap.
          // The restorations run SERIALLY, each awaited before the next is
          // constructed: concurrent restore writes materialize both native
          // temp files at once and exceed the cap the transition was admitted
          // under (observed 16157 @ cap 16000).
          const restoreErrors: unknown[] = [];
          if (markerFlipped) {
            try {
              await this.store.admittedWriteHeld(
                this.dir,
                markerPath,
                priorMarkerText,
                { chargeBytes: priorMarkerBytes, rollback: { kind: "none" } },
                "settlement marker restore",
              );
            } catch (restoreErr) {
              restoreErrors.push(restoreErr);
            }
          }
          if (reserveRemoved && !(await fileExists(reservePath))) {
            try {
              const reserveBuf = encodeSettlementReserve(roundId, this.ownerId(), reserveBytes);
              await this.store.admittedWriteHeld(
                this.dir,
                reservePath,
                reserveBuf,
                { chargeBytes: reserveBuf.length, rollback: { kind: "created" } },
                "settlement reserve restore",
              );
            } catch (restoreErr) {
              restoreErrors.push(restoreErr);
            }
          }
          if (restoreErrors.length > 0) {
            throw new StoreCapacityError(
              `Settlement failed (${String(err)}) and rollback could not complete (${restoreErrors
                .map((e) => String(e))
                .join("; ")}); unfinished state requires explicit handling.`,
            );
          }
          throw err;
        }
      });
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
      await this.store.admittedTransition(async () => {
        const markerPath = path.join(this.dir, "incomplete.json");
        let marker = await readIncompleteMarker(this.dir);
        await validateMarkerAgainstCommitted(this.dir, marker);
        if (marker.ownerId !== this.ownerId()) throw new UnacknowledgedInterruptionError("Marker belongs to another owner.");
        let markerText = await readOwnedTextUnder(this.dir, markerPath);
        const priorManifest = await readOwnedTextUnder(this.dir, path.join(this.dir, "store.json"));
        const manifestText = canonicalJson({ schemaVersion: 1, committedRevision: snapshot.revision, updatedAt: this.store.nowMs() });
        const revisionsDir = path.join(this.dir, "revisions");
        await assertNoSymlinkComponents(this.dir, revisionsDir);
        await fs.mkdir(revisionsDir, { recursive: true, mode: 0o700 });
        const digest = sha256Hex(serialized);
        let proof = marker.publication;
        if (proof !== undefined && (proof.digest !== digest || proof.revision !== snapshot.revision)) {
          throw new CorruptRecordError("Different publication pending; explicit acknowledgment required.");
        }
        const initial = proof === undefined;
        if (initial) {
          if (await entryExistsStrict(revisionPath)) throw new CorruptRecordError("Unproven immutable revision already exists; refusing overwrite.");
          proof = { revision: snapshot.revision, digest,
            stageName: `.${path.basename(revisionPath)}.${process.pid}.${randomUUID()}.stage.tmp` };
        }
        if (proof === undefined) throw new CorruptRecordError("Publication preparation missing.");
        validatePublicationShape(proof, marker.revisionBase);
        const stagePath = path.join(revisionsDir, proof.stageName);
        const size = Buffer.byteLength(serialized);
        const caps = await this.store.measureCapsFor(this.dir);
        const oldMarkerBytes = Buffer.byteLength(markerText);
        const preparedText = canonicalJson({ ...marker, publication: proof });
        const proofBound = canonicalJson({ ...marker, publication: { ...proof,
          identity: { device: "9".repeat(32), inode: "9".repeat(32) } } });
        const preparedDelta = Buffer.byteLength(preparedText) - oldMarkerBytes;
        const proofDelta = Buffer.byteLength(proofBound) - oldMarkerBytes;
        const finalExists = await entryExistsStrict(revisionPath);
        const peak = proof.identity === undefined
          ? Math.max(Buffer.byteLength(preparedText), preparedDelta + 2 * size,
              preparedDelta + size + Buffer.byteLength(proofBound), proofDelta + 2 * size + Buffer.byteLength(manifestText))
          : (finalExists ? 0 : size) + Buffer.byteLength(manifestText);
        this.store.checkCapsFor(caps.recordBytes, caps.storeBytes, peak, "complete publication native peak");
        if (initial) {
          await this.store.admittedWriteHeld(this.dir, markerPath, preparedText,
            { chargeBytes: Buffer.byteLength(preparedText), rollback: { kind: "replace", prior: markerText } }, "publication preparation");
          marker = { ...marker, publication: proof };
          markerText = preparedText;
        }
        if (proof.identity === undefined) {
          const injected = this.store.depsWriteFunnel();
          await this.store.admittedWriteHeld(this.dir, stagePath, serialized,
            { chargeBytes: injected === undefined ? size : 2 * size, rollback: { kind: "none" }, writeImpl: async () => {
              const staged = await fs.open(stagePath, "wx", 0o600);
              try { await staged.writeFile(serialized); await staged.sync(); }
              finally { await staged.close(); }
              if (injected !== undefined) await injected(stagePath, serialized);
            } }, "retained publication stage");
          const opened = await openNativeOwnedFile(this.dir, stagePath, false);
          try {
            const bytes = await readNativeBounded(opened.handle, SNAPSHOT_MAX_BYTES);
            if (bytes.toString("utf8") !== serialized) throw new CorruptRecordError("Revision staging diverged from validated snapshot.");
            await verifySnapshotFile(this.dir, stagePath, snapshot.revision);
            await assertNativeIdentity(stagePath, opened.identity);
            await opened.handle.sync();
            await syncOwnedDirectory(revisionsDir);
            proof = { ...proof, identity: opened.identity };
          } finally { await opened.handle.close(); }
          const complete = { ...marker, publication: proof };
          const text = canonicalJson(complete);
          await this.store.admittedWriteHeld(this.dir, markerPath, text,
            { chargeBytes: Buffer.byteLength(text), rollback: { kind: "replace", prior: markerText } }, "native publication proof");
          marker = complete;
        }
        await verifyPublicationFile(this.dir, stagePath, proof);
        if (!await entryExistsStrict(revisionPath)) {
          await this.store.admittedWriteHeld(this.dir, revisionPath, serialized,
            { chargeBytes: size, rollback: { kind: "none" }, writeImpl: async () => {
              try { await fs.link(stagePath, revisionPath); }
              catch (err) { if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err; }
              await verifyPublicationFile(this.dir, revisionPath, proof);
              const directory = await fs.open(revisionsDir, "r");
              try { await directory.sync(); } finally { await directory.close(); }
            } }, "immutable revision native link");
        }
        await verifyPublicationFile(this.dir, revisionPath, proof);
        await this.store.admittedWriteHeld(this.dir, path.join(this.dir, "store.json"), manifestText,
          { chargeBytes: Buffer.byteLength(manifestText), rollback: { kind: "replace", prior: priorManifest } }, "revision manifest");
        // Stage first; the remaining final still proves persisted native identity.
        await disposePublication(this.dir, { disposition: "completed", proof });
        await fs.rm(path.join(this.dir, "reserve.settlement"), { force: true });
        await fs.unlink(markerPath);
        await syncOwnedDirectory(this.dir);
        await removePendingRecovery(this.dir, marker);
      });
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
