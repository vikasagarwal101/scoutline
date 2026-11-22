/**
 * Per-monitor write exclusion on a local filesystem. A SQLite write
 * transaction stays open on the same connection across the operation.
 * A paused process holds its lock until it exits or closes the connection.
 *
 * The old lockfile name is permanently claimed as a directory. An older
 * binary cannot create or unlink a lockfile at that name after cutover.
 * Upgrade with all older monitor writers stopped. A surviving legacy
 * lockfile is refused for manual inspection.
 *
 * SQLite owns the database inode. Use lstat for path checks and open the
 * database only through SQLite. On POSIX a separate fs close on that inode
 * can release the process's advisory locks. Never remove the lock directory
 * or replace its database while monitor processes are running.
 *
 * Pathname-replacement trace (r4655167732): after requireLockDbPath and
 * the DatabaseSync open, NO in-contract writer replaces the inode — this
 * module never unlinks lock.db, node:sqlite keeps one open handle for the
 * connection's lifetime, SQLite's rollback journal operates on a sidecar
 * (lock.db-journal) it unlinks per transaction, and the permanent
 * directory claim above keeps legacy lockfile binaries off the name
 * (their unlink(2) on a directory fails).
 *
 * ACTUAL BOUNDARY, stated directly: the CALLER supplies an owned, local,
 * access-controlled, stable directory tree and must itself guard against
 * external pathname/inode replacement (POSIX advisory locks bind to
 * (inode, process), not the pathname, so a replaced path is a different,
 * lock-free inode). Within that tree, no cooperating writer replaces
 * lock.db. The mode passed to mkdir applies only when THIS code creates
 * a directory, subject to the process umask; pre-existing directory
 * modes are neither verified nor enforced — lstat/isDirectory checks
 * establish type, not access control. The tests and the existing
 * symlink/regular-file guard catch misdirected opens; they do NOT prove
 * protection against replacement of an already-held file, and no such
 * protection is claimed here.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { LockTimeoutError, DEFAULT_LOCK_TIMEOUT_MS } from "./async-file-lock.js";
import { ValidationError } from "./errors.js";
import { assertTestSafeWrite } from "./test-isolation.js";

/** The legacy lockfile name, claimed permanently as a real directory. */
export const TICK_LOCK_DIR_PREFIX = "fact-monitor-";
/** The permanent SQLite lock database inside the claimed directory. */
export const TICK_LOCK_DB_FILENAME = "lock.db";

/** SQLite's SQLITE_BUSY raw result code (errcode on node:sqlite errors). */
const SQLITE_BUSY_ERRCODE = 5;

export function tickLockDirPath(monitorDir: string, monitorId: string): string {
  return path.join(monitorDir, `${TICK_LOCK_DIR_PREFIX}${monitorId}.lock`);
}

function tickLockDbPath(lockDir: string): string {
  return path.join(lockDir, TICK_LOCK_DB_FILENAME);
}

function isBusy(error: unknown): boolean {
  return (error as { errcode?: unknown } | null)?.errcode === SQLITE_BUSY_ERRCODE;
}

async function ensureDirectory(directory: string): Promise<void> {
  try {
    await fs.mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
  }
}

export async function claimTickLockDir(monitorDir: string, monitorId: string): Promise<string> {
  assertTestSafeWrite(monitorDir, "claimTickLockDir");
  await ensureDirectory(monitorDir);
  if (!(await fs.lstat(monitorDir)).isDirectory()) {
    throw new ValidationError(`fact monitor ${monitorId}: monitor directory is redirected or invalid.`);
  }
  const lockDir = tickLockDirPath(monitorDir, monitorId);
  await ensureDirectory(lockDir);
  if (!(await fs.lstat(lockDir)).isDirectory()) {
    throw new ValidationError(`fact monitor ${monitorId}: a legacy lock artifact exists; inspect it before upgrading.`);
  }
  return lockDir;
}

async function requireLockDbPath(dbPath: string, monitorId: string): Promise<void> {
  let info;
  try {
    info = await fs.lstat(dbPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return;
    throw error;
  }
  if (!info.isFile() || info.nlink !== 1) {
    throw new ValidationError(`fact monitor ${monitorId}: lock database must be an owned regular file.`);
  }
}

export interface SqliteTickLockOptions {
  /** Acquire deadline in ms (default: the shared 30s lock timeout). */
  readonly timeoutMs?: number;
  /** Injectable timer for tests (capped retry loops). */
  readonly setTimeout?: typeof setTimeout;
  /** Cooperative cancellation: an aborted signal rejects the parked wait promptly. */
  readonly signal?: AbortSignal;
  /** Error-message label (e.g. "Fact monitor tick"). */
  readonly label?: string;
}

/**
 * Serialize a critical section with the per-monitor SQLite tick lock.
 *
 * `fn` runs while the SAME in-process connection holds the RESERVED
 * lock acquired by `BEGIN IMMEDIATE` — the locked state read, both
 * publication writes and any reconciliation all happen inside it, so
 * there is NO assertion-then-mutate gap: the kernel-enforced exclusion
 * spans every mutation. The lock is never committed; the finally block
 * rolls back (best effort) and closes, which releases the file lock
 * even if fn threw. SQLITE_BUSY is the ONLY retried error — bounded by
 * `timeoutMs` (LockTimeoutError past it) and cancellable by `signal`
 * (also LockTimeoutError, matching the legacy lock's issue-#47 shape so
 * the fact-monitor's existing cancellation mapping keeps working).
 * Every other error propagates verbatim.
 */
export async function withSqliteTickLock<T>(
  monitorDir: string,
  monitorId: string,
  fn: () => Promise<T>,
  options: SqliteTickLockOptions = {},
): Promise<T> {
  const label = options.label ?? "Fact monitor tick";
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  // Typed refusal BEFORE any mutation (the lock directory is not even
  // claimed): NaN/±Infinity poison the deadline arithmetic (NaN never
  // compares true — the BUSY retry would spin forever; Infinity never
  // times out) and a negative deadline fails accidentally on first BUSY.
  // 0 stays supported: an uncontended acquire still succeeds, contention
  // times out immediately.
  if (typeof timeoutMs !== "number" || Number.isNaN(timeoutMs) || !Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new ValidationError(
      `${label}: timeoutMs must be a finite non-negative number of milliseconds (got ${String(options.timeoutMs)}).`,
    );
  }
  const setT = options.setTimeout ?? setTimeout;
  const signal = options.signal;
  const deadline = performance.now() + timeoutMs;
  const lockAborted = (): LockTimeoutError =>
    new LockTimeoutError(label, "tick-lock wait aborted by signal");
  const lockDeadline = (): LockTimeoutError =>
    new LockTimeoutError(label, `tick-lock deadline exceeded after ${timeoutMs}ms`);

  if (signal?.aborted) throw lockAborted();
  const lockDir = await claimTickLockDir(monitorDir, monitorId);
  const dbPath = tickLockDbPath(lockDir);
  // Load SQLite only when the monitor acquires its lock. Early Node 24
  // releases may report the built-in module's experimental warning.
  const { DatabaseSync } = await import("node:sqlite");
  await requireLockDbPath(dbPath, monitorId);
  if (signal?.aborted) throw lockAborted();
  const db = new DatabaseSync(dbPath, { timeout: 0 });

  const sleep = (ms: number): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(lockAborted());
        return;
      }
      if (signal === undefined) {
        setT(() => resolve(), ms);
        return;
      }
      const onAbort = (): void => {
        clearTimeout(id);
        reject(lockAborted());
      };
      const id = setT(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal.addEventListener("abort", onAbort, { once: true });
    });

  let held = false;
  try {
    for (let attempt = 0; ; attempt += 1) {
      if (signal?.aborted) throw lockAborted();
      try {
        // An empty SQLite database can hold the write lock. No schema
        // initialization or database writes are needed for exclusion.
        db.exec("BEGIN IMMEDIATE");
        held = true;
        break;
      } catch (error) {
        if (!isBusy(error)) throw error;
        if (performance.now() >= deadline) throw lockDeadline();
        // Bounded, jittered, cancellable backoff — retry ONLY on BUSY.
        const backoffMs = Math.min(
          500,
          Math.floor(50 * Math.pow(1.3, Math.min(attempt, 8)) + Math.random() * 50),
        );
        await sleep(backoffMs);
        if (performance.now() >= deadline) throw lockDeadline();
      }
    }
    return await fn();
  } finally {
    if (held) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Best effort: close() below rolls back and releases regardless.
      }
    }
    db.close();
  }
}
