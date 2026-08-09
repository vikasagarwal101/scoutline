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
 * `staleMs`.
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
}

/**
 * Check if an error is an EEXIST (file already exists) error from `fs.open`
 * with the `wx` flag.
 */
function isEexistError(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as { code: unknown }).code === "EEXIST";
}

/**
 * Serialize a critical section via an exclusive lockfile.
 *
 * Creates `{stateDir}/{identityHash}.lock` with `wx` (exclusive create).
 * If the lock is held, polls every 500ms until acquired or `timeoutMs`
 * elapses. A lock older than `staleMs` is broken (unlinked) and retried.
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
  const sleep = (ms: number): Promise<void> => new Promise((r) => setT(() => r(), ms));
  await fs.mkdir(stateDir, { recursive: true }).catch(() => {});
  const lockPath = path.join(stateDir, `${identityHash}.lock`);
  const deadline = Date.now() + options.timeoutMs;

  for (;;) {
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
      // Break a stale lock (the holder died without releasing).
      const stat = await fs.stat(lockPath).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > options.staleMs) {
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
    // Lock acquired — run fn() and always clean up.
    try {
      return await fn();
    } finally {
      await handle.close().catch(() => {});
      await fs.unlink(lockPath).catch(() => {});
    }
  }
}
