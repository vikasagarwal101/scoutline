/**
 * Lock-semantics suite — audit 2026-08 issues #46/#47/#48 (class-guard).
 * All named cases except the sanity block FAIL at HEAD pre-fix; assertion
 * messages document the at-HEAD defect and post-fix contract. Spec notes:
 * docs/plans/pr-comment-audit/ (seams vs newly-expressed contracts).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { breakStaleLock, withAsyncFileLock } from "../dist/lib/async-file-lock.js";
import { executeProviderOperation } from "../dist/lib/execution.js";
import { TimeoutError } from "../dist/lib/errors.js";

async function mkTmp(t, label) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `scoutline-${label}-`));
  t.after(() => {
    fs.chmod(dir, 0o755).catch(() => {});
    fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });
  return dir;
}

async function capture(fn) {
  try {
    return { ok: true, value: await fn(), err: undefined };
  } catch (err) {
    return { ok: false, value: undefined, err };
  }
}

/** Shared displacement-race body for #46a and #48a: two acquirers, one lock. */
async function displacementRace(t, lockName, timeoutLabel) {
  const dir = await mkTmp(t, lockName);
  let running = 0;
  let maxConcurrent = 0;
  const fn = async () => {
    running += 1;
    maxConcurrent = Math.max(maxConcurrent, running);
    // Hold >1000ms so the contender spans two hardcoded 500ms poll cycles and
    // observes (at HEAD) an unrefreshed mtime older than staleMs.
    await new Promise((r) => setTimeout(r, 1500));
    running -= 1;
    return "done";
  };
  const opts = { timeoutMs: 10000, staleMs: 30, timeoutLabel };
  const a = withAsyncFileLock(dir, lockName, fn, opts);
  await new Promise((r) => setImmediate(r));
  const b = withAsyncFileLock(dir, lockName, fn, opts);
  await Promise.all([a, b]);
  return maxConcurrent;
}

describe("audit 2026-08 #46 — async-file-lock mtime + stat-error semantics", () => {
  it("#46a: lock mtime is refreshed while critical section runs (live holder must not be displaced)", async (t) => {
    const maxConcurrent = await displacementRace(t, "lock46a", "test-46a");
    assert.strictEqual(
      maxConcurrent,
      1,
      `live holder must not be displaced; observed maxConcurrent=${maxConcurrent} (expected 1 — at HEAD the second acquirer steals the lock after staleMs because mtime is never refreshed during the critical section)`,
    );
  });

  it("#46b: fs.stat failure other than ENOENT propagates as an error, not silent contention", async (t) => {
    const dir = await mkTmp(t, "46b");
    // Symlink to a root-owned file: open(lockPath,'wx') -> EEXIST, stat -> EACCES.
    const targetPath = "/root/.bashrc";
    const lockPath = path.join(dir, "lock46b.lock");
    try {
      await fs.symlink(targetPath, lockPath);
    } catch (symErr) {
      t.skip?.(`cannot create symlink to ${targetPath}: ${symErr.code}`);
      return;
    }
    let openCode, statCode;
    try { await fs.open(lockPath, "wx"); } catch (e) { openCode = e.code; }
    try { await fs.stat(lockPath); } catch (e) { statCode = e.code; }
    if (openCode !== "EEXIST" || statCode === "ENOENT" || !statCode) {
      t.skip?.(`host cannot exercise non-ENOENT stat contract (open=${openCode ?? "ok"}, stat=${statCode ?? "ok"})`);
      return;
    }

    const result = await capture(() =>
      withAsyncFileLock(dir, "lock46b", async () => "done", {
        timeoutMs: 200, staleMs: 600000, timeoutLabel: "test-46b",
      }),
    );

    assert.ok(result.err, "expected withAsyncFileLock to surface a real fs error");
    assert.ok(
      result.err.code === statCode,
      `non-ENOENT stat error must propagate with errno code ${statCode}; got code=${result.err.code}, message="${result.err.message}" (at HEAD the helper silently swallows and surfaces a misleading "create-lock timed out" error)`,
    );
  });
});

describe("audit 2026-08 #47 — AbortSignal threading", () => {
  it("#47a: lock-wait sleep is aborted by signal (via { signal } option on withAsyncFileLock)", async (t) => {
    const dir = await mkTmp(t, "47a");
    await fs.writeFile(path.join(dir, "lock47a.lock"), "x"); // force contention
    const controller = new AbortController();
    controller.abort(); // pre-aborted; `signal` option does not exist at HEAD

    const result = await capture(() =>
      withAsyncFileLock(dir, "lock47a", async () => "done", {
        timeoutMs: 10000, staleMs: 600000, signal: controller.signal, timeoutLabel: "test-47a",
      }),
    );

    assert.ok(result.err, "expected withAsyncFileLock to reject (either via abort or via timeout)");
    const message = (result.err && result.err.message) || "";
    assert.ok(
      !message.includes("create-lock timed out"),
      `aborted signal must abort the lock-wait, not sleep through to a create-lock timeout; got message="${message}"`,
    );
  });

  it("#47b: retry loop checks signal.aborted BEFORE invoking (no invoke when pre-aborted)", async (t) => {
    const controller = new AbortController();
    controller.abort();
    let invokeCount = 0;
    const sleepCalls = [];
    const invoke = async () => {
      invokeCount += 1;
      throw new TimeoutError(5000); // retryable — would force the backoff path
    };
    const result = await capture(() =>
      executeProviderOperation(
        "search", invoke,
        { sleep: (ms) => { sleepCalls.push(ms); return Promise.resolve(); }, random: () => 0 },
        { maxRetries: 1, baseDelayMs: 100, maxDelayMs: 100, jitterMs: 0 },
        undefined, controller.signal,
      ),
    );
    assert.ok(result.err, "expected retry loop to reject when aborted");
    assert.strictEqual(
      invokeCount, 0,
      `pre-aborted signal must skip invoke() entirely; observed invokeCount=${invokeCount} (at HEAD the retry loop consults signal only inside the catch, so the first invoke runs even when the caller is already aborted)`,
    );
    assert.strictEqual(sleepCalls.length, 0, `pre-aborted signal must not trigger backoff; observed sleepCalls=${JSON.stringify(sleepCalls)}`);
  });

  it("#47c: backoff sleep is abortable (abort during backoff -> rejects promptly)", async (t) => {
    let sleepResolved = false;
    const sleep = (ms) => new Promise((resolve) => {
      setTimeout(() => { sleepResolved = true; resolve(); }, ms);
    });
    const controller = new AbortController();
    let firstInvoke = true;
    const invoke = async () => {
      if (firstInvoke) {
        firstInvoke = false;
        setTimeout(() => controller.abort(), 80); // abort mid-backoff (baseDelayMs 500)
        throw new TimeoutError(5000); // retryable — forces the backoff path
      }
      return "ok";
    };
    const start = Date.now();
    const result = await capture(() =>
      executeProviderOperation(
        "search", invoke,
        { sleep, random: () => 0 },
        { maxRetries: 1, baseDelayMs: 500, maxDelayMs: 500, jitterMs: 0 },
        undefined, controller.signal,
      ),
    );
    const elapsed = Date.now() - start;
    assert.ok(result.err, "expected operation to reject after abort");
    assert.ok(
      elapsed < 300,
      `backoff must be aborted promptly when signal fires; elapsed=${elapsed}ms (at HEAD the plain 500ms sleep runs to completion regardless of abort)`,
    );
    assert.ok(!sleepResolved, "sleep must NOT run to completion when aborted");
  });
});

describe("audit 2026-08 #48 — Firecrawl crawl lock", () => {
  it("#48a: withCrawlLock uses refreshed-mtime semantics (via wrapper timeoutLabel)", async (t) => {
    const maxConcurrent = await displacementRace(t, "lock48a", "Firecrawl crawl");
    assert.strictEqual(
      maxConcurrent,
      1,
      `live crawl lock must not be displaced; observed maxConcurrent=${maxConcurrent} (expected 1 — at HEAD the wrapper inherits withAsyncFileLock's unrefreshed-mtime race)`,
    );
  });

  it("#48b: lock-timeout error does not surface Z_AI_TIMEOUT guidance (lock contention is not a request timeout)", async (t) => {
    const dir = await mkTmp(t, "48b");
    await fs.writeFile(path.join(dir, "lock48b.lock"), "x"); // force contention -> deadline timeout
    const result = await capture(() =>
      withAsyncFileLock(dir, "lock48b", async () => "done", {
        timeoutMs: 200, staleMs: 600000, timeoutLabel: "Firecrawl crawl",
      }),
    );
    assert.ok(result.err, "expected withAsyncFileLock to time out");

    // Mirror of normalizeFirecrawlError's "timed out" branch (file-local,
    // unexported; the real path needs a 30s lock timeout — impractical here).
    const message = (result.err && result.err.message) || "";
    const lower = message.toLowerCase();
    const surfaced =
      result.err instanceof TimeoutError ||
      lower.includes("timeout") || lower.includes("timed out") || lower.includes("etimedout")
        ? new TimeoutError(30000)
        : result.err;
    const help = (surfaced && surfaced.help) || "";

    assert.ok(
      !help.includes("Z_AI_TIMEOUT"),
      `lock-timeout error must not surface Z_AI_TIMEOUT guidance; got help="${help}" (raw message="${message}")`,
    );
  });
});

// Review fixup (macroscope HIGH, artifacts.ts:291): the stale-lock break
// must be ownership-safe — unlink only when the path still holds the exact
// inode that was statted as stale, so a second waiter that already broke
// the same stale lock and re-acquired never loses its fresh lock to a
// slow first breaker's naked unlink.
describe("async-file-lock — ownership-safe stale break (breakStaleLock)", () => {
  it("unlinks when the path still holds the statted inode", async (t) => {
    const dir = await mkTmp(t, "stale-owned");
    const lockPath = path.join(dir, "owned.lock");
    await fs.writeFile(lockPath, "stale", { flag: "wx" });
    const statted = await fs.stat(lockPath);

    await breakStaleLock(lockPath, statted);

    await assert.rejects(fs.stat(lockPath), (e) => e.code === "ENOENT");
  });

  it("refuses to unlink when the path was replaced by a DIFFERENT inode (a successor's live lock)", async (t) => {
    const dir = await mkTmp(t, "stale-replaced");
    const lockPath = path.join(dir, "replaced.lock");
    await fs.writeFile(lockPath, "stale", { flag: "wx" });
    const statted = await fs.stat(lockPath);

    // Between the stat and the break attempt, another waiter broke the
    // stale lock and re-acquired: the path now holds a NEW inode.
    await fs.unlink(lockPath);
    await fs.writeFile(lockPath, "fresh-successor-lock", { flag: "wx" });

    await breakStaleLock(lockPath, statted);

    const survived = await fs.readFile(lockPath, "utf8");
    assert.strictEqual(
      survived,
      "fresh-successor-lock",
      "the successor's lock must survive a stale-break that no longer owns the inode",
    );
  });

  it("is a no-op when the lock vanished between stat and break", async (t) => {
    const dir = await mkTmp(t, "stale-vanished");
    const lockPath = path.join(dir, "vanished.lock");
    await fs.writeFile(lockPath, "stale", { flag: "wx" });
    const statted = await fs.stat(lockPath);
    await fs.unlink(lockPath);

    await breakStaleLock(lockPath, statted); // must not throw

    assert.ok(true, "ENOENT during re-stat resolves, never rejects");
  });
});

describe("async-file-lock — sanity checks (must pass at HEAD)", () => {
  it("withAsyncFileLock is a no-op when stateDir is undefined", async () => {
    const sentinel = Symbol("fn-ran");
    const out = await withAsyncFileLock(undefined, "any", async () => sentinel, {
      timeoutMs: 100, staleMs: 100, timeoutLabel: "sanity",
    });
    assert.strictEqual(out, sentinel);
  });

  it("executeProviderOperation returns invoke result on success", async () => {
    const out = await executeProviderOperation(
      "search", async () => "ok",
      { sleep: async () => {}, random: () => 0 },
      { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1, jitterMs: 0 },
    );
    assert.strictEqual(out, "ok");
  });
});
