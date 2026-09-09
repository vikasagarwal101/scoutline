/**
 * Artifact store core (save-artifacts epic, ticket T1).
 *
 * Three primitives every later save/history ticket builds on:
 *   - `newRequestId(now)` — `<UTC compact>-<4 lowercase hex>` (e.g.
 *     `20260829T142233Z-7f3a`). Timestamp from the INJECTED `now` (repo
 *     time-injection rule — never `Date.now()` for the timestamp part),
 *     hex tail from `crypto.randomBytes(2)` (injectable for hermetic
 *     tests). Lexicographically sortable; filesystem-safe.
 *   - `resolveArtifactsDir(env)` — `SCOUTLINE_ARTIFACTS_DIR` wins, else
 *     `<resolveConfigRootPure(env)>/artifacts`.
 *   - `writeArtifact(dir, requestId, content, { format, force })` — an
 *     atomic artifact write that REFUSES overwrites: the pre-check the
 *     `atomicReplaceFile` primitive deliberately lacks. The refusal leaves
 *     an existing target byte-identical (checked before any write); with
 *     `force` the replacement rides the same atomic rename.
 *
 * Ticket T2 adds the metadata side of the clean-report split — the
 * `index.json` log under the artifacts dir:
 *   - `appendLogEntry(dir, entry, options?)` — one versioned save entry
 *     appended under the `artifacts-write` file lock (the cache-write
 *     precedent), so concurrent CLI invocations never lose or tear
 *     entries. Resolves with a stderr notice when a corrupt pre-existing
 *     log was reset by the append.
 *   - `readLog(dir)` — lock-free, fail-open: a missing store reads as
 *     `{version:1, entries:[]}`; a corrupt or unrecognized file reads the
 *     same plus a notice for stderr. Never throws.
 */
import { randomBytes as cryptoRandomBytes, randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import {
  atomicReplaceFile,
  resolveConfigRootPure,
  type ConfigRootEnvironment,
  type ConfigRootPlatform,
} from "./config-store.js";
import { FileError, ScoutlineError } from "./errors.js";
import {
  DEFAULT_LOCK_STALE_MS,
  DEFAULT_LOCK_TIMEOUT_MS,
  LockTimeoutError,
  withAsyncFileLock,
} from "./async-file-lock.js";
import { asJournalEntry } from "./journal.js";
import pkg from "../../package.json" with { type: "json" };

/** Report format of a saved artifact (spec: `--save-format json|markdown`). */
export type ArtifactFormat = "json" | "markdown";

/** Environment keys {@link resolveArtifactsDir} reads. */
export interface ArtifactsDirEnvironment extends ConfigRootEnvironment {
  readonly SCOUTLINE_ARTIFACTS_DIR?: string;
  readonly SCOUTLINE_ISOLATED?: string;
}

/** Byte source for the request-id hex tail; defaults to crypto.randomBytes. */
export type RandomBytesSource = (size: number) => Uint8Array;

/** UTC compact timestamp `YYYYMMDDTHHMMSSZ` — fixed width, lex-sortable. */
function utcCompactTimestamp(now: Date): string {
  const pad2 = (value: number) => String(value).padStart(2, "0");
  return (
    `${String(now.getUTCFullYear()).padStart(4, "0")}` +
    `${pad2(now.getUTCMonth() + 1)}${pad2(now.getUTCDate())}` +
    `T${pad2(now.getUTCHours())}${pad2(now.getUTCMinutes())}${pad2(now.getUTCSeconds())}Z`
  );
}

/**
 * Build a request id from the injected instant: `<UTC compact>-<4 hex>`,
 * e.g. `20260829T142233Z-7f3a`. The hex tail comes from two random bytes
 * per call, so ids generated within the same second still differ.
 * Sorting ids lexicographically sorts them chronologically (same-second
 * ids tie — order between them is not defined).
 */
export function newRequestId(
  now: Date | number,
  randomBytes: RandomBytesSource = cryptoRandomBytes,
): string {
  const bytes = randomBytes(2);
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${utcCompactTimestamp(new Date(now))}-${hex}`;
}

export interface ArtifactsPlatform extends ConfigRootPlatform {
  readonly pid?: number;
}

/**
 * Artifacts root: `SCOUTLINE_ARTIFACTS_DIR` (canonical SCOUTLINE_* name, no
 * legacy alias) wins; otherwise the config root's `artifacts/` sibling.
 * Pure — the caller supplies env and platform; the convenience wrapper is
 * left to the command layer (T2/T3) so tests never touch process.env.
 */
export function resolveArtifactsDir(
  env: ArtifactsDirEnvironment,
  platform: ArtifactsPlatform = { homedir: os.homedir(), pid: process.pid },
): string {
  const baseDir =
    env.SCOUTLINE_ARTIFACTS_DIR || path.join(resolveConfigRootPure(env, platform), "artifacts");

  if (env.SCOUTLINE_ISOLATED === "1" || env.SCOUTLINE_ISOLATED === "true") {
    const pid = platform.pid ?? process.pid;
    return path.join(baseDir, "isolated", `${pid}`);
  }

  return baseDir;
}

export interface WriteArtifactOptions {
  /** Report extension; `"json"` (default) or `"markdown"` (`.md`). */
  readonly format?: ArtifactFormat;
  /** true → replace an existing target via the atomic path; false → refuse. */
  readonly force?: boolean;
  /** Lock-timing overrides for the master-write critical section (tests use small values). */
  readonly lock?: {
    readonly timeoutMs?: number;
    readonly staleMs?: number;
    readonly setTimeout?: typeof setTimeout;
  };
}

/**
 * Existence check that sees through NOTHING: {@link fs.lstat}, not
 * {@link fs.stat}, so a dangling symlink (stat: ENOENT) still counts as
 * an existing entry and is never silently replaced by a force=false
 * write (review fixup: the dangling-symlink hole).
 */
async function entryExists(filePath: string): Promise<boolean> {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Write one master artifact `<artifactsDir>/<requestId>.json|.md` through
 * {@link atomicReplaceFile} so the 0700-dir / 0600-temp / fsync / rename
 * discipline is inherited, never reimplemented. The one addition that
 * primitive lacks: without `force`, an existing target throws
 * {@link FileError} (`FILE_ERROR`, exit 1 — owner ruling, no new code)
 * BEFORE any write, leaving the file byte-identical. Resolves with the
 * target path (the later log's `masterPath`).
 *
 * Review fixup (atomic no-overwrite): the existence check and the write
 * are serialized through the shared `artifacts-write` lock (the same
 * identity {@link appendLogEntry} uses), and the check is re-run INSIDE
 * the critical section. Two concurrent saves racing on the same
 * requestId (or a same-path export) can no longer both pass the
 * pre-check and have the second silently overwrite the first — the
 * loser gets the FileError. `force` writes ride the same lock so a
 * forced replace cannot interleave with a concurrent no-force refusal
 * window; atomicReplaceFile keeps the replacement itself atomic.
 */
export async function writeArtifact(
  dir: string,
  requestId: string,
  content: string,
  options: WriteArtifactOptions = {},
): Promise<string> {
  const extension = options.format === "markdown" ? "md" : "json";
  const target = path.join(dir, `${requestId}.${extension}`);
  const refuse = (): FileError =>
    new FileError(
      `Refusing to overwrite existing artifact: ${target}`,
      "Pass --save-force to overwrite the existing artifact.",
    );
  await withAsyncFileLock(
    dir,
    ARTIFACTS_LOG_LOCK_IDENTITY,
    async () => {
      if (!options.force && (await entryExists(target))) throw refuse();
      await atomicReplaceFile(target, content);
    },
    {
      timeoutMs: options.lock?.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
      staleMs: options.lock?.staleMs ?? DEFAULT_LOCK_STALE_MS,
      setTimeout: options.lock?.setTimeout,
      timeoutLabel: "Artifacts master write",
    },
  );
  return target;
}

/**
 * Atomic check-and-place for the export copy: creates the target's
 * directory as needed (0700 when newly created; pre-existing directories
 * keep their permissions), writes the content to a unique 0600 temp file
 * in that directory (fsync'd),
 * then makes the target via {@link fs.link} — an atomic exclusive create
 * that fails with EEXIST when the target appeared meanwhile. Resolves
 * `true` when placed, `false` when the target already existed (which is
 * left byte-identical — the link never touched it). Review fixup: closes
 * the export TOCTOU the exists-recheck could only narrow (check and
 * place are one atomic step now).
 */
export async function atomicPlaceNoClobber(filePath: string, contents: string): Promise<boolean> {
  const root = path.dirname(filePath);
  // Harden only directories WE created (review r5, race-closed r7): a
  // pre-mkdir stat goes stale if a concurrent creator makes `root` first,
  // so decide "ours" from the non-recursive mkdir itself — EEXIST means
  // someone else made it and its permissions are not ours to change.
  await fs.mkdir(path.dirname(root), { recursive: true, mode: 0o700 });
  let created = false;
  try {
    await fs.mkdir(root, { mode: 0o700 });
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  if (created && process.platform !== "win32") await fs.chmod(root, 0o700);
  const tempPath = path.join(
    root,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const handle = await fs.open(tempPath, "wx", 0o600);
  let closed = false;
  try {
    await handle.writeFile(contents);
    await handle.sync();
    // Our temp file's identity, captured while the fd is still open.
    const mine = await handle.stat();
    await handle.close();
    closed = true;
    try {
      await fs.link(tempPath, filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
    // Swap guard (review r6): fs.link resolves the PATH, so in a writable,
    // non-sticky directory another local user can replace tempPath between
    // our close and the link — Node has no linkat(AT_EMPTY_PATH) to pin the
    // fd. Verify the placed entry IS our inode; never export swapped-in
    // content.
    const placed = await fs.stat(filePath);
    if (placed.dev !== mine.dev || placed.ino !== mine.ino) {
      await fs.unlink(filePath).catch(() => {});
      throw new FileError(
        "Refusing to export: the staged temp file was replaced while placing the artifact.",
        "Retry the save; if this recurs, export into a directory other users cannot write.",
      );
    }
    // Durability (review r4): fsync the directory so the new entry itself
    // survives power loss — file-data fsync alone can lose the link-in
    // (POSIX only; Windows has no directory-sync primitive).
    if (process.platform !== "win32") {
      const dirHandle = await fs.open(root, "r");
      try {
        await dirHandle.sync();
      } finally {
        await dirHandle.close().catch(() => {});
      }
    }
    return true;
  } finally {
    // Leak guard (review r4): close the temp handle even when writeFile or
    // sync rejected — open handles block the unlink below on platforms
    // that forbid unlinking open files.
    if (!closed) await handle.close().catch(() => {});
    await fs.unlink(tempPath).catch(() => {});
  }
}
// ---------------------------------------------------------------------------
// Metadata log (`index.json`) — ticket T2. The log is the metadata half of
// the clean-report split: reports carry content + requestId only, the log
// carries the "which provider did what and why" story joined by requestId.
// ---------------------------------------------------------------------------

/** Log filename under the artifacts dir (DESIGN.md D5). */
export const ARTIFACTS_LOG_FILENAME = "index.json";

/** The log's own version namespace — independent of the report schemaVersion. */
export const ARTIFACTS_LOG_VERSION = 1;

/** Fixed lock identity serializing every index.json append (cache-write precedent). */
export const ARTIFACTS_LOG_LOCK_IDENTITY = "artifacts-write";

/** CLI version stamped into each entry (the src/index.ts pkg-import idiom). */
export const CLI_VERSION: string = pkg.version;

/**
 * Entry kind discriminator — "save" masters plus "journal" (history-journal
 * merge D1): journal entries are LOG-ONLY (no master file); their body
 * fields arrive with the T2a/T3 writers. A kind outside this union still
 * fails the whole-log open — the fail-loud path is load-bearing.
 */
export type LogEntryKind = "save" | "journal";

/** Single-provider routing: what was requested and what actually served. */
export interface SingleProviderRouting {
  readonly mode: "single";
  readonly requested?: string;
  readonly effective: string;
  /**
   * Where the serving bytes came from (issue #108): "live" = the effective
   * provider was actually contacted; "cache" = served from that provider's
   * on-disk response cache (v2 partitioned or v0.2 legacy read-through),
   * possibly while the provider was unreachable. Optional so pre-#108
   * entries stay valid; save entries always set it.
   */
  readonly servedFrom?: "live" | "cache";
}

/** Fan-out routing (ADR-0004): ordered arms; no single effective exists. */
export interface FanoutProviderRouting {
  readonly mode: "fanout";
  readonly requested?: string;
  readonly arms: readonly string[];
}

/** `provider` field of a log entry (the search.ts FanoutPlan vocabulary). */
export type ProviderRouting = SingleProviderRouting | FanoutProviderRouting;

/**
 * One save record in `index.json` — the field set is pinned exactly by
 * tests/artifacts-log.test.js so unknown additions fail loudly. `args` is
 * the redacted allow-list of provider-influencing options (exact list
 * locked at ticket T4; no positionals, no presentation flags, no --save*).
 */
export interface SaveLogEntry {
  readonly kind: LogEntryKind;
  readonly requestId: string;
  /** ms epoch — the CALLER's injected instant; never Date.now() in here. */
  readonly timestamp: number;
  readonly command: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly provider: ProviderRouting;
  readonly outputFormat: string;
  readonly artifactFormat: ArtifactFormat;
  readonly cliVersion: string;
  /** Master filename relative to the artifacts dir (basename of writeArtifact's return). */
  readonly masterPath: string;
  /** Absolute export-copy path when `--save <path>` was given. */
  readonly exportPath?: string;
}

/** `index.json` shape: own version field, entries in append order. */
export interface ArtifactsLog {
  readonly version: typeof ARTIFACTS_LOG_VERSION;
  readonly entries: readonly SaveLogEntry[];
}

/** readLog result: the (possibly empty) log plus an optional stderr notice. */
export interface ReadLogResult {
  readonly log: ArtifactsLog;
  readonly notice?: string;
}

/** Lock-timing overrides for {@link appendLogEntry} (tests use small values). */
export interface AppendLogEntryOptions {
  readonly timeoutMs?: number;
  readonly staleMs?: number;
  /** Injectable timer so lock retries resolve faster than the 500ms sleep. */
  readonly setTimeout?: typeof setTimeout;
}

function emptyLog(): ArtifactsLog {
  return { version: ARTIFACTS_LOG_VERSION, entries: [] };
}

/**
 * Structural guard for one entry (history-journal merge D1): per-kind
 * dispatch over {@link LogEntryKind}. The BASE rules — kind known,
 * requestId non-empty string, timestamp a finite in-Date-range number —
 * are shared by every kind; the body check is per-kind. `save` keeps
 * every field of the {@link SaveLogEntry} shape type-checked BEFORE the
 * cast, and `masterPath` must be a bare filename (no path separators,
 * no dot segments) so a hostile persisted entry cannot steer `history
 * show`'s `path.join(dir, masterPath)` read outside the artifacts dir
 * (review fixup: the unvalidated-entry hole). `journal` entries are
 * LOG-ONLY (no master) and validate their FULL body through
 * `asJournalEntry` (capability enum, contentHash shape, provider
 * routing, skeleton rows, tags, saveRef) — an entry is kept only when
 * the whole body validates. Any other kind still returns undefined —
 * the fail-loud whole-log path is load-bearing.
 */
function asLogEntry(value: unknown): SaveLogEntry | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const e = value as Record<string, unknown>;
  if (e.kind !== "save" && e.kind !== "journal") return undefined;
  // T2b repeat markers are the one journal shape WITHOUT a requestId —
  // dispatch to the journal validator BEFORE the base requestId rule so
  // `repeatOf` presence routes to the marker check (which enforces its
  // own tiny field set); everything else keeps the base rules.
  if (e.kind === "journal" && e.repeatOf !== undefined) {
    return asJournalEntry(value) as SaveLogEntry | undefined;
  }
  if (typeof e.requestId !== "string" || e.requestId.length === 0) return undefined;
  if (typeof e.timestamp !== "number" || !Number.isFinite(e.timestamp)) return undefined;
  // Reject finite-but-out-of-Date-range values: history list/stats render
  // via new Date(ms).toISOString(), which throws RangeError on them — the
  // entry must fail validation here so the log fails open instead (review
  // fixup).
  if (!Number.isFinite(new Date(e.timestamp).getTime())) return undefined;
  // Journal entries (T2a): full body validation — capability enum,
  // redacted query, sha256 contentHash, cacheKey, provider restricted
  // to SingleProviderRouting (fanout has no single server), and the
  // skeleton shape per the writer's contract (search: url+title list;
  // read/research bodies arrive in T3, validated when written). Return
  // BEFORE the save-body checks below, which would reject their absent
  // master fields — the widening's whole point.
  if (e.kind === "journal") return asJournalEntry(value) as SaveLogEntry | undefined;
  if (typeof e.command !== "string" || e.command.length === 0) return undefined;
  if (typeof e.args !== "object" || e.args === null || Array.isArray(e.args)) return undefined;
  const provider = e.provider as Record<string, unknown> | undefined;
  if (typeof provider !== "object" || provider === null) return undefined;
  if (provider.mode === "single") {
    if (typeof provider.effective !== "string" || provider.effective.length === 0) return undefined;
    if (provider.requested !== undefined && typeof provider.requested !== "string")
      return undefined;
    // Issue #108 review: servedFrom is schema-optional but, when present,
    // enum-constrained — a persisted "banana" must fail the entry guard
    // (fail-open whole-log semantics) rather than flow into history
    // reports unvalidated.
    if (
      provider.servedFrom !== undefined &&
      provider.servedFrom !== "live" &&
      provider.servedFrom !== "cache"
    ) {
      return undefined;
    }
  } else if (provider.mode === "fanout") {
    if (
      !Array.isArray(provider.arms) ||
      provider.arms.length === 0 ||
      !provider.arms.every((arm) => typeof arm === "string" && arm.length > 0)
    ) {
      return undefined;
    }
    if (provider.requested !== undefined && typeof provider.requested !== "string")
      return undefined;
  } else {
    return undefined;
  }
  if (typeof e.outputFormat !== "string") return undefined;
  if (e.artifactFormat !== "json" && e.artifactFormat !== "markdown") return undefined;
  if (typeof e.cliVersion !== "string" || e.cliVersion.length === 0) return undefined;
  if (typeof e.masterPath !== "string") return undefined;
  const bare = e.masterPath;
  if (
    bare.length === 0 ||
    bare.includes("/") ||
    bare.includes("\\") ||
    bare.includes("\0") || // NUL passes the checks below yet ERRs the read path (greptile P1)
    bare.startsWith(".") ||
    bare !== path.basename(bare)
  ) {
    return undefined;
  }
  if (e.exportPath !== undefined && typeof e.exportPath !== "string") return undefined;
  return value as SaveLogEntry;
}

/** Structural guard: exactly `{version:1, entries:[...]}` with EVERY entry a valid {@link SaveLogEntry} — anything else is fail-open fodder. */
function asArtifactsLog(value: unknown): { log: ArtifactsLog; corruptEntry: boolean } | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== ARTIFACTS_LOG_VERSION || !Array.isArray(candidate.entries)) {
    return undefined;
  }
  const entries: SaveLogEntry[] = [];
  let corruptEntry = false;
  for (const raw of candidate.entries) {
    const entry = asLogEntry(raw);
    if (entry === undefined) {
      corruptEntry = true;
      continue;
    }
    entries.push(entry);
  }
  return { log: { version: ARTIFACTS_LOG_VERSION, entries }, corruptEntry };
}

/**
 * Lock-free, fail-open read of `<dir>/index.json`. A missing store is the
 * normal empty case (no notice); a corrupt or unrecognized file degrades to
 * an empty log plus a notice the caller flushes on stderr. NEVER throws —
 * `history` is a read-only inventory (D7), not a failure surface.
 */
export async function readLog(dir: string): Promise<ReadLogResult> {
  const file = path.join(dir, ARTIFACTS_LOG_FILENAME);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { log: emptyLog() };
    const code = (error as NodeJS.ErrnoException).code ?? "unknown";
    return {
      log: emptyLog(),
      notice: `Artifacts log ${file} is unreadable (${code}); continuing with an empty log.`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      log: emptyLog(),
      notice: `Artifacts log ${file} is corrupt (invalid JSON); ignoring existing entries.`,
    };
  }
  const log = asArtifactsLog(parsed);
  if (!log) {
    return {
      log: emptyLog(),
      notice: `Artifacts log ${file} has an unrecognized shape (expected {"version":1,"entries":[...]}); ignoring existing entries.`,
    };
  }
  if (log.corruptEntry) {
    // Review fixup: one entry failing the full SaveLogEntry shape makes
    // the whole log untrustworthy — fail open with the kept valid
    // entries dropped: an empty log plus a notice, never a throw.
    return {
      log: emptyLog(),
      notice: `Artifacts log ${file} contains an entry that does not match the log schema; ignoring existing entries.`,
    };
  }
  return { log: log.log };
}

/**
 * Append one entry to `<dir>/index.json`, serialized through the
 * `artifacts-write` file lock — the cache-write precedent (src/lib/cache.ts):
 * concurrent CLI invocations read-modify-write under one lockfile, so a
 * Promise.all of appends persists every entry intact (no lost update, no
 * torn entry). The write itself rides atomicReplaceFile (0700 dir / 0600
 * temp / fsync / rename). Resolves with a stderr notice when a corrupt
 * pre-existing log was reset by this append; write and lock-acquire
 * failures propagate — the save hook (T3) wraps them into FileError.
 */
export async function appendLogEntry(
  dir: string,
  entry: SaveLogEntry,
  options: AppendLogEntryOptions = {},
): Promise<string | undefined> {
  let notice: string | undefined;
  await withAsyncFileLock(
    dir,
    ARTIFACTS_LOG_LOCK_IDENTITY,
    async () => {
      const current = await readLog(dir);
      notice = current.notice;
      const next: ArtifactsLog = {
        version: ARTIFACTS_LOG_VERSION,
        entries: [...current.log.entries, entry],
      };
      await atomicReplaceFile(
        path.join(dir, ARTIFACTS_LOG_FILENAME),
        `${JSON.stringify(next, null, 2)}\n`,
      );
    },
    {
      timeoutMs: options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
      staleMs: options.staleMs ?? DEFAULT_LOCK_STALE_MS,
      setTimeout: options.setTimeout,
      timeoutLabel: "Artifacts log write",
    },
  );
  return notice;
}

/**
 * The save hook's ONE critical section (PR #111 review batch 1, cubic P2):
 * master write + log append under a single `artifacts-write` hold. The old
 * writeArtifact → appendLogEntry sequence took the lock twice, leaving a
 * crash/kill window between the holds — a written master with no log
 * entry, invisible to `history` and swept as an orphan by
 * `history clear --all`. The entry is CONSTRUCTED BY THE CALLER (it needs
 * the requestId, routing, args — hook-owned facts) with `masterPath`
 * already the bare filename; the target `<requestId>.<ext>` is computed
 * exactly as {@link writeArtifact} does, and the caller precomputes the
 * same path for `entry.masterPath` (keep the two in lockstep — the
 * duplication is pinned by tests/save-artifact.test.js). The no-force
 * existence refusal keeps its {@link FileError} contract; the append
 * mirrors {@link appendLogEntry} exactly (same fail-open read, same
 * notice, same 2-space JSON shape). An I/O failure INSIDE the section can
 * still leave the master written and unlogged — it surfaces as the save
 * hook's FILE_ERROR and a retry rewrites both; the closed window is the
 * crash between the two old lock holds.
 */
export async function writeArtifactWithLogEntry(
  dir: string,
  requestId: string,
  content: string,
  entry: SaveLogEntry,
  options: WriteArtifactOptions = {},
): Promise<string | undefined> {
  const extension = options.format === "markdown" ? "md" : "json";
  const target = path.join(dir, `${requestId}.${extension}`);
  const refuse = (): FileError =>
    new FileError(
      `Refusing to overwrite existing artifact: ${target}`,
      "Pass --save-force to overwrite the existing artifact.",
    );
  let notice: string | undefined;
  await withAsyncFileLock(
    dir,
    ARTIFACTS_LOG_LOCK_IDENTITY,
    async () => {
      if (!options.force && (await entryExists(target))) throw refuse();
      await atomicReplaceFile(target, content);
      const current = await readLog(dir);
      notice = current.notice;
      const next: ArtifactsLog = {
        version: ARTIFACTS_LOG_VERSION,
        entries: [...current.log.entries, entry],
      };
      await atomicReplaceFile(
        path.join(dir, ARTIFACTS_LOG_FILENAME),
        `${JSON.stringify(next, null, 2)}\n`,
      );
    },
    {
      timeoutMs: options.lock?.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
      staleMs: options.lock?.staleMs ?? DEFAULT_LOCK_STALE_MS,
      setTimeout: options.lock?.setTimeout,
      timeoutLabel: "Artifacts master write + log append",
    },
  );
  // PR #111 A2 fixup: resolve with the LOG notice (appendLogEntry's
  // contract — the readLog reset notice, when a corrupt pre-state was
  // replaced), never the master path; the caller already knows the path.
  return notice;
}

// ---------------------------------------------------------------------------
// T6a (history-journal merge DESIGN D5): `history clear` — the store's
// first sanctioned REWRITE seam. Bare clear is the journal-kind valve
// (the fast-refilling layer); `--all` extends to saves + their masters.
// ---------------------------------------------------------------------------

/** Lock options for {@link clearArtifactsLog} (tests shrink timings). */
export interface ClearArtifactsLogOptions {
  readonly timeoutMs?: number;
  readonly staleMs?: number;
  /** Injectable timer so lock retries resolve faster than the 500ms sleep. */
  readonly setTimeout?: typeof setTimeout;
  /** `--all`: also remove save entries AND delete their master files. */
  readonly all?: boolean;
}

/**
 * `history clear` (T6a): rewrite `<dir>/index.json` in place under the
 * SAME `artifacts-write` lock every append uses, so a clear never
 * interleaves with a concurrent append (the rewrite is read-filter-write
 * INSIDE the critical section — the whole-log consistency append relies
 * on). Read side rides the fail-open {@link readLog} contract: a corrupt
 * or unrecognized pre-state reads as EMPTY, so clear "removes nothing"
 * and writes back a valid empty log — the wipe still succeeds.
 *
 * Bare clear keeps every non-journal entry (saves + their masters are
 * byte-untouched); `--all` removes save entries too and unlinks their
 * master files (a master that vanished is fine; an `--all` sweep also
 * leaves no logged master behind — no orphans).
 */
export async function clearArtifactsLog(
  dir: string,
  options: ClearArtifactsLogOptions = {},
): Promise<ClearArtifactsLogResult> {
  let removedByKind: Record<string, number> = {};
  let kept = 0;
  // Review batch 3 (issue 7): honest master-unlink count — a vanished
  // file rejects and is NOT counted; a failed unlink is not counted.
  let mastersDeleted = 0;
  let notice: string | undefined;
  try {
    await withAsyncFileLock(
      dir,
      ARTIFACTS_LOG_LOCK_IDENTITY,
      async () => {
        const current = await readLog(dir);
        notice = current.notice;
        const keptEntries: SaveLogEntry[] = [];
        for (const entry of current.log.entries) {
          // Bare clear = the journal valve: remove kind:"journal" (full
          // entries + markers), keep everything else. --all removes all.
          if (options.all || entry.kind === "journal") {
            removedByKind[entry.kind] = (removedByKind[entry.kind] ?? 0) + 1;
          } else {
            keptEntries.push(entry);
            kept += 1;
          }
        }
        if (options.all) {
          // Review batch 1: sweep-then-rewrite. The master sweep runs
          // BEFORE the filtered-log rewrite so a sweep failure throws
          // with the log byte-untouched — entries are never discarded
          // while their masters survive (the old order reported success
          // and dropped entries behind unremovable files; retrying the
          // clear then completes the wipe).
          //
          // Full wipe sweeps the DIRECTORY, not just logged masters: an
          // orphan master (pre-clear corruption, manual file) would
          // otherwise survive the wipe. Bare clear never reaches here —
          // save masters stay byte-untouched under the journal valve.
          // Review r3: process temporaries are SPARED — an in-flight
          // save writes its temp file BEFORE appending the log entry
          // and renames after, so deleting one mid-save would corrupt
          // the atomic-replace contract (the rename then lands a master
          // the wipe cannot see). Two protected classes: names
          // CONTAINING `.tmp.` (process temps) and DOT-PREFIXED names
          // ENDING `.tmp` — the atomicReplaceFile /
          // atomicPlaceNoClobber staging shape
          // `.<basename>.<pid>.<uuid>.tmp` is always dot-prefixed, so a
          // plain user file ending `.tmp` is NOT staging and goes under
          // the documented full wipe. Temp files orphaned by a crash
          // are harmless leftovers, not store content.
          //
          // Review batch 1 (cubic): logged `--save` export copies placed
          // INSIDE the artifacts dir are spared — full resolved-path
          // compare (never basenames), so an unrelated file that happens
          // to share a name still goes. Unlogged files remain in scope:
          // the wipe must leave no orphans (T6a orphan pin).
          const spared = new Set(
            current.log.entries
              .filter((entry) => entry.exportPath !== undefined)
              .map((entry) => path.resolve(dir, entry.exportPath as string)),
          );
          const failed: { readonly path: string; readonly code: string }[] = [];
          for (const dirent of await fs.readdir(dir, { withFileTypes: true })) {
            if (
              dirent.name === ARTIFACTS_LOG_FILENAME ||
              dirent.name.endsWith(".lock") ||
              dirent.name.includes(".tmp.") ||
              (dirent.name.startsWith(".") && dirent.name.endsWith(".tmp")) ||
              dirent.isDirectory()
            ) {
              continue;
            }
            if (spared.has(path.resolve(dir, dirent.name))) continue;
            try {
              await fs.unlink(path.join(dir, dirent.name));
              mastersDeleted += 1;
            } catch (error) {
              // A vanished file is already gone — not a failure, not
              // counted. Any other unlink rejection fails the wipe.
              if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
              failed.push({
                path: path.join(dir, dirent.name),
                code: (error as NodeJS.ErrnoException).code ?? "unknown",
              });
            }
          }
          if (failed.length > 0) {
            throw new FileError(
              `history clear --all could not delete ${failed.length} file(s): ${failed
                .map((f) => `${f.path} (${f.code})`)
                .join("; ")}`,
              "Fix the file permissions (or close the program holding the files), then retry: scoutline history clear --all.",
            );
          }
        }
        await atomicReplaceFile(
          path.join(dir, ARTIFACTS_LOG_FILENAME),
          `${JSON.stringify({ version: ARTIFACTS_LOG_VERSION, entries: keptEntries }, null, 2)}\n`,
        );
      },
      {
        timeoutMs: options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
        staleMs: options.staleMs ?? DEFAULT_LOCK_STALE_MS,
        setTimeout: options.setTimeout,
        timeoutLabel: "Artifacts log clear",
      },
    );
  } catch (error) {
    // Lock-acquire timeout is a typed FILE_ERROR (the cache-prune seam
    // precedent): a bare LockTimeoutError would surface through the
    // dispatcher boundary as UNKNOWN_ERROR.
    if (
      error instanceof LockTimeoutError ||
      (error instanceof Error && error.message.endsWith("create-lock timed out"))
    ) {
      throw new FileError(
        error instanceof LockTimeoutError ? `${error.label} create-lock timed out` : error.message,
        "Another scoutline process holds the artifacts-write lock; try again once it finishes.",
      );
    }
    // A typed error thrown INSIDE the critical section (the --all
    // sweep's FileError) already carries the public contract — re-throw
    // as-is. The errno wrap below is for RAW I/O failures (lock
    // creation) only; re-wrapping here used to clobber the sweep's
    // "could not delete N file(s)" message with a false lock sentence.
    // ponytail: the sweep-failure path is not hermetically reachable on
    // Linux (an undeletable file needs an unwritable dir, which fails
    // lock creation before the sweep runs); add an fs-injection seam if
    // it ever needs a direct pin.
    if (error instanceof ScoutlineError) throw error;
    // Review batch 1: a lock-creation I/O failure (read-only artifacts
    // dir → EACCES on the wx-open of `artifacts-write.lock`) used to
    // surface as a bare errno error — exit 1, but an UNKNOWN-shaped
    // envelope. Same seam, same typed contract: wrap the errno into the
    // FileError the CLI boundary documents.
    if (error instanceof Error && "code" in error) {
      throw new FileError(
        `Artifacts log clear could not create the artifacts-write lock (${(error as NodeJS.ErrnoException).code ?? "unknown"}): ${error.message}`,
        "Fix the permissions on the artifacts directory, then retry: scoutline history clear --all.",
      );
    }
    throw error;
  }
  return {
    removed: Object.values(removedByKind).reduce((a, b) => a + b, 0),
    removedByKind,
    kept,
    ...(options.all ? { mastersDeleted } : {}),
    notice,
  };
}

/** `clearArtifactsLog` outcome: what the valve removed and what stayed. */
export interface ClearArtifactsLogResult {
  /** Total entries removed (all kinds). */
  readonly removed: number;
  /** Removed counts by entry kind. */
  readonly removedByKind: Readonly<Record<string, number>>;
  /** Entries that survived the clear. */
  readonly kept: number;
  /**
   * Master files actually unlinked by the `--all` sweep (review batch
   * 3, issue 7) — orphans add, vanished/failed unlinks subtract.
   * Present only under `--all`; a bare clear never sets it.
   */
  readonly mastersDeleted?: number;
  /** The fail-open read notice (corrupt pre-state), for stderr. */
  readonly notice?: string;
}
