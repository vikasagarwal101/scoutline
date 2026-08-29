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
import { FileError } from "./errors.js";
import {
  DEFAULT_LOCK_STALE_MS,
  DEFAULT_LOCK_TIMEOUT_MS,
  withAsyncFileLock,
} from "./async-file-lock.js";
import pkg from "../../package.json" with { type: "json" };

/** Report format of a saved artifact (spec: `--save-format json|markdown`). */
export type ArtifactFormat = "json" | "markdown";

/** Environment keys {@link resolveArtifactsDir} reads. */
export interface ArtifactsDirEnvironment extends ConfigRootEnvironment {
  readonly SCOUTLINE_ARTIFACTS_DIR?: string;
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

/**
 * Artifacts root: `SCOUTLINE_ARTIFACTS_DIR` (canonical SCOUTLINE_* name, no
 * legacy alias) wins; otherwise the config root's `artifacts/` sibling.
 * Pure — the caller supplies env and platform; the convenience wrapper is
 * left to the command layer (T2/T3) so tests never touch process.env.
 */
export function resolveArtifactsDir(
  env: ArtifactsDirEnvironment,
  platform: ConfigRootPlatform = { homedir: os.homedir() },
): string {
  return (
    env.SCOUTLINE_ARTIFACTS_DIR || path.join(resolveConfigRootPure(env, platform), "artifacts")
  );
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
export async function atomicPlaceNoClobber(
  filePath: string,
  contents: string,
): Promise<boolean> {
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
  const tempPath = path.join(root, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
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
const ARTIFACTS_LOG_LOCK_IDENTITY = "artifacts-write";

/** CLI version stamped into each entry (the src/index.ts pkg-import idiom). */
export const CLI_VERSION: string = pkg.version;

/** Entry kind discriminator — "save" now; seed-07 journaling adds "journal" later. */
export type LogEntryKind = "save";

/** Single-provider routing: what was requested and what actually served. */
export interface SingleProviderRouting {
  readonly mode: "single";
  readonly requested?: string;
  readonly effective: string;
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
 * Structural guard for one entry: every field of the {@link SaveLogEntry}
 * shape is type-checked BEFORE the cast, and `masterPath` must be a bare
 * filename (no path separators, no dot segments) so a hostile persisted
 * entry cannot steer `history show`'s `path.join(dir, masterPath)` read
 * outside the artifacts dir (review fixup: the unvalidated-entry hole).
 */
function asSaveLogEntry(value: unknown): SaveLogEntry | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const e = value as Record<string, unknown>;
  if (e.kind !== "save") return undefined;
  if (typeof e.requestId !== "string" || e.requestId.length === 0) return undefined;
  if (typeof e.timestamp !== "number" || !Number.isFinite(e.timestamp)) return undefined;
  // Reject finite-but-out-of-Date-range values: history list/stats render
  // via new Date(ms).toISOString(), which throws RangeError on them — the
  // entry must fail validation here so the log fails open instead (review
  // fixup).
  if (!Number.isFinite(new Date(e.timestamp).getTime())) return undefined;
  if (typeof e.command !== "string" || e.command.length === 0) return undefined;
  if (typeof e.args !== "object" || e.args === null || Array.isArray(e.args)) return undefined;
  const provider = e.provider as Record<string, unknown> | undefined;
  if (typeof provider !== "object" || provider === null) return undefined;
  if (provider.mode === "single") {
    if (typeof provider.effective !== "string" || provider.effective.length === 0) return undefined;
    if (provider.requested !== undefined && typeof provider.requested !== "string") return undefined;
  } else if (provider.mode === "fanout") {
    if (
      !Array.isArray(provider.arms) ||
      provider.arms.length === 0 ||
      !provider.arms.every((arm) => typeof arm === "string" && arm.length > 0)
    ) {
      return undefined;
    }
    if (provider.requested !== undefined && typeof provider.requested !== "string") return undefined;
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
    const entry = asSaveLogEntry(raw);
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
