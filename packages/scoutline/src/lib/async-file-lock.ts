/**
 * Shared async file-mutex for serializing create-persist critical sections.
 *
 * Extracted from the near-identical `withCrawlLock` (firecrawl) and
 * `withResearchLock` (parallel) into a single reusable helper. Any
 * long-running capability that POSTs to create a server-side job then
 * persists the job ID should wrap the create-persist sequence in this lock
 * so concurrent identical invocations serialize — the second caller waits,
 * then re-reads the state file and finds the first's persisted job ID
 * instead of creating (and billing) a second job.
 *
 * The lock uses an exclusive `wx`-create lockfile sibling to the state
 * file. A stale lock (holder crashed without releasing) is broken after
 * `staleMs`. While the critical section runs, the lock mtime is refreshed
 * periodically (issue #46/#48a) so a slow-but-live holder is never
 * displaced by the staleMs check.
 *
 * When `stateDir` is undefined (in-memory test mode), the lock is a no-op —
 * tests are single-process and need no cross-process serialization.
 */

import * as fs from "node:fs/promises";
import path from "node:path";

/**
 * Default lock timing constants. Consumers that need the standard values
 * (30s acquire timeout, 10-min stale threshold) should import these
 * instead of duplicating magic numbers.
 */
export const DEFAULT_LOCK_TIMEOUT_MS = 30000;
export const DEFAULT_LOCK_STALE_MS = 10 * 60 * 1000;

/**
 * Options for {@link withAsyncFileLock}.
 */
export interface AsyncFileLockOptions {
  /** How long to wait for a contended lock before giving up (ms). */
  readonly timeoutMs: number;
  /** A lock older than this is treated as stale and broken (ms). */
  readonly staleMs: number;
  /**
   * Injectable timer (tests pass a capped timer so lock-acquire retry
   * loops resolve faster than the production 500ms sleep).
   */
  readonly setTimeout?: typeof setTimeout;
  /** Label used in the timeout error message (e.g. "Firecrawl crawl"). */
  readonly timeoutLabel: string;
  /**
   * Cooperative-cancellation signal (issue #47). When aborted — before
   * the call or during the lock wait — the pending wait rejects promptly
   * instead of sleeping through to the acquire deadline. A live critical
   * section is NOT interrupted: the holder's `fn` owns its own signal
   * handling.
   */
  readonly signal?: AbortSignal;
}

/**
 * Check if an error is an EEXIST (file already exists) error from `fs.open`
 * with the `wx` flag.
 */
function isEexistError(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as { code: unknown }).code === "EEXIST";
}

/**
 * Check if an error is an ENOENT (no such file or directory) error. The
 * only `fs.stat` failure that means "no lock / fresh start" — every other
 * stat error is a real I/O failure and must propagate (issue #46).
 */
function isEnoentError(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as { code: unknown }).code === "ENOENT";
}

/**
 * Serialize a critical section via an exclusive lockfile.
 *
 * Creates `{stateDir}/{identityHash}.lock` with `wx` (exclusive create).
 * If the lock is held, polls every 500ms until acquired or `timeoutMs`
 * elapses. A lock older than `staleMs` is broken (unlinked) and retried —
 * but only when its mtime is genuinely stale: while `fn()` runs, the
 * holder refreshes the lock mtime (issue #46/#48a), so a live holder is
 * never displaced no matter how long the critical section takes.
 *
 * When `stateDir` is undefined, the lock is a no-op — `fn()` runs directly.
 *
 * @example
 * ```ts
 * const jobId = await withAsyncFileLock(
 *   stateDir,
 *   identityHash,
 *   async () => createAndPersistJob(),
 *   { timeoutMs: 30_000, staleMs: 600_000, timeoutLabel: "Tavily research" },
 * );
 * ```
 */
export async function withAsyncFileLock<T>(
  stateDir: string | undefined,
  identityHash: string,
  fn: () => Promise<T>,
  options: AsyncFileLockOptions,
): Promise<T> {
  if (stateDir === undefined) return fn();

  const setT = options.setTimeout ?? setTimeout;
  const signal = options.signal;
  const lockAborted = (): Error =>
    new Error(`${options.timeoutLabel} create-lock wait aborted by signal`);
  // Contention sleep, raced against the caller's signal (issue #47): an
  // abort rejects the pending wait immediately instead of sleeping
  // through to the acquire deadline.
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
  await fs.mkdir(stateDir, { recursive: true }).catch(() => {});
  const lockPath = path.join(stateDir, `${identityHash}.lock`);
  const deadline = Date.now() + options.timeoutMs;
  // Mtime-refresh cadence for the critical section (issue #46/#48a): half
  // the stale window, so the worst-case mtime age a contender can observe
  // is strictly below `staleMs`. Floored at 10ms for degenerate tiny
  // staleMs values, capped at 5s so production holds (10-min staleMs)
  // do not touch the file in a tight loop.
  const refreshIntervalMs = Math.min(Math.max(10, Math.floor(options.staleMs / 2)), 5000);

  for (;;) {
    if (signal?.aborted) throw lockAborted();
    let handle;
    try {
      handle = await fs.open(lockPath, "wx");
    } catch (err) {
      // Only EEXIST from the wx-create is a lock-contention signal.
      // Errors from fn() (below) propagate directly without retry.
      if (!isEexistError(err)) throw err;
      if (Date.now() > deadline) {
        throw new Error(`${options.timeoutLabel} create-lock timed out`);
      }
      // Break a stale lock (the holder died without releasing). Only
      // ENOENT counts as "no lock / fresh start" — the file vanished
      // between the failed open and this stat (another holder released),
      // so retry the open. Any other stat failure is a real I/O error
      // and propagates verbatim (issue #46) instead of masquerading as
      // contention.
      let stat: Awaited<ReturnType<typeof fs.stat>>;
      try {
        stat = await fs.stat(lockPath);
      } catch (statErr) {
        if (isEnoentError(statErr)) continue;
        throw statErr;
      }
      if (Date.now() - stat.mtimeMs > options.staleMs) {
        await fs.unlink(lockPath).catch(() => {});
        // Back off after stale-break attempt to avoid a tight loop if
        // the unlink failed or another waiter re-acquired immediately.
        await sleep(500);
        continue;
      }
      await sleep(500);
      // Re-check deadline after sleeping — the 500ms sleep may have
      // crossed it, and the next open attempt bypasses the check above.
      if (Date.now() > deadline) {
        throw new Error(`${options.timeoutLabel} create-lock timed out`);
      }
      continue;
    }
    // Lock acquired — run fn() and always clean up. While fn() runs, a
    // self-re-arming timer keeps the lock mtime fresh so contenders
    // never observe a live holder as stale (issue #46/#48a).
    let refreshAlive = true;
    let refreshTimer: ReturnType<typeof setT> | undefined;
    const refresh = (): void => {
      if (!refreshAlive) return;
      fs.utimes(lockPath, new Date(), new Date()).catch(() => {});
      refreshTimer = setT(refresh, refreshIntervalMs);
    };
    try {
      refreshTimer = setT(refresh, refreshIntervalMs);
      return await fn();
    } finally {
      refreshAlive = false;
      if (refreshTimer !== undefined) clearTimeout(refreshTimer);
      await handle.close().catch(() => {});
      await fs.unlink(lockPath).catch(() => {});
    }
  }
}
