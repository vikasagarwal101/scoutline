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

import { withAsyncFileLock } from "../dist/lib/async-file-lock.js";
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
