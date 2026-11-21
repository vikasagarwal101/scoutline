/**
 * SQLite tick lock (process-lifetime kernel-backed mutual exclusion) and
 * the caught first-publication reconciliation — the #302 stale-writer
 * fix. Covers: same-process exclusion, cross-process pause and death
 * (real processes, real signals — POSIX only), cancellation while
 * parked, claim semantics against legacy artifacts, tick/current.json
 * format preservation, and the first-orphan fault matrix.
 *
 * Node >= 24 required (node:sqlite; EXPERIMENTAL upstream — on the
 * pinned 24.22.1 the import is clean; nothing here filters stderr).
 * SIGSTOP/SIGKILL tests are skipped on Windows (signal semantics); the
 * lock itself is platform-portable wherever node:sqlite ships, with
 * local owned filesystem scope only.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  commitFactMonitorTick,
  loadFactMonitorState,
  prepareFactMonitorTick,
  FactMonitorPublicationUncertainError,
} from "../dist/lib/fact-monitor.js";
import { claimTickLockDir, withSqliteTickLock } from "../dist/lib/sqlite-tick-lock.js";
import { LockTimeoutError, withAsyncFileLock } from "../dist/lib/async-file-lock.js";
import { ValidationError } from "../dist/lib/errors.js";

const MONITOR = "m";
const POSIX = process.platform !== "win32";

function definition() {
  return {
    schemaVersion: 1,
    question: "What version does the manifest state?",
    scope: { entity: "ExampleApp", documentType: "release-manifest" },
    requirements: {
      version: {
        question: "Which release version is stated in the manifest?",
        schema: { type: "string" },
        required: true,
      },
    },
  };
}

function satisfied(value) {
  const content = "Version: " + value;
  return {
    kind: "result",
    result: {
      status: "complete",
      schemaVersion: 1,
      assessment: "semantic",
      question: definition().question,
      plan: { queries: [] },
      requirements: {
        version: { status: "satisfied", required: true, value, evidenceIds: ["manifest-fixture"], judgmentCount: 1, inconsistentJudgments: 0 },
      },
      data: { version: value },
      evidence: [
        { evidenceId: "manifest-fixture", url: "urn:x-scoutline:manifest:sha256-" + "0".repeat(64), title: "m", content, byteLength: Buffer.byteLength(content, "utf8"), origins: [] },
      ],
      coverageNotes: [],
      acquisitionLog: [],
      usage: { searches: 0, readAttempts: 0, readsRetained: 0, judgeCalls: 0, extractorCalls: 0, extractorCacheHits: 0, candidateJudgeCalls: 0 },
    },
  };
}

async function mkTmp(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scoutline-sqlite-lock-"));
  t.after(async () => { await fs.rm(dir, { recursive: true, force: true }); });
  return dir;
}

async function commit(dir, outcome) {
  const now = new Date(0);
  const prepared = await prepareFactMonitorTick(dir, MONITOR, definition(), { now });
  return commitFactMonitorTick(dir, prepared, outcome, { now });
}

function fakeFs(t, name, invoke) {
  const original = fs[name];
  const stub = t.mock.method(fs, name, (...args) => invoke(original, ...args));
  syncBuiltinESMExports();
  t.after(() => {
    stub.mock.restore();
    syncBuiltinESMExports();
  });
}

async function bounded(work, what) {
  let timer;
  try {
    return await Promise.race([
      work,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${what}`)), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Exclusion — same process
// ---------------------------------------------------------------------------

test("same-process sections serialize: the second enters only after the first releases", async (t) => {
  const dir = await mkTmp(t);
  const monitorDir = path.join(dir, MONITOR);
  const order = [];
  const entered = Promise.withResolvers();
  const releaseFirst = Promise.withResolvers();
  const ready = Promise.withResolvers();
  let resumeSecond;
  const first = withSqliteTickLock(monitorDir, MONITOR, async () => {
    order.push("first-enter");
    entered.resolve();
    await releaseFirst.promise;
    order.push("first-exit");
  });
  let second;
  try {
    await bounded(Promise.race([entered.promise, first.then(() => assert.fail("holder exited early"))]), "holder entry");
    second = withSqliteTickLock(monitorDir, MONITOR, async () => {
      order.push("second-enter");
    }, { setTimeout: (resume) => { resumeSecond = resume; ready.resolve(); } });
    await bounded(Promise.race([ready.promise, second.then(() => assert.fail("second entered with lock held"))]), "contender backoff");
    assert.deepEqual(order, ["first-enter"]);
  } finally {
    releaseFirst.resolve();
    try { await bounded(first, "holder release"); } finally { resumeSecond?.(); }
  }
  await bounded(second, "second section");
  assert.deepEqual(order, ["first-enter", "first-exit", "second-enter"]);
});

test("a raw BEGIN IMMEDIATE holder drives the contender to the bounded deadline", async (t) => {
  const dir = await mkTmp(t);
  const lockDir = path.join(dir, MONITOR, `fact-monitor-${MONITOR}.lock`);
  await fs.mkdir(lockDir, { recursive: true });
  const db = new DatabaseSync(path.join(lockDir, "lock.db"), { timeout: 0 });
  db.exec("BEGIN IMMEDIATE");
  try {
    await assert.rejects(
      () => withSqliteTickLock(path.join(dir, MONITOR), MONITOR, async () => {}, { timeoutMs: 150, label: "t" }),
      (e) => e instanceof LockTimeoutError,
    );
  } finally {
    db.exec("ROLLBACK"); db.close();
  }
});

test("cancellation wakes a parked contender without a retry timer", async (t) => {
  const dir = await mkTmp(t);
  const monitorDir = path.join(dir, MONITOR);
  const lockDir = await claimTickLockDir(monitorDir, MONITOR);
  const db = new DatabaseSync(path.join(lockDir, "lock.db"), { timeout: 0 });
  db.exec("BEGIN IMMEDIATE");
  const controller = new AbortController();
  const parked = Promise.withResolvers();
  let resume;
  const pending = withSqliteTickLock(monitorDir, MONITOR, async () => {
    assert.fail("contender entered despite held lock");
  }, { signal: controller.signal, setTimeout: (retry) => { resume = retry; parked.resolve(); } });
  try {
    await bounded(Promise.race([parked.promise, pending.then(() => assert.fail("contender exited early"))]), "contender backoff");
    controller.abort();
    await bounded(assert.rejects(pending, { name: "LockTimeoutError", message: /aborted by signal/ }), "abort settlement");
  } finally {
    controller.abort();
    resume?.();
    db.close();
  }
});

// ---------------------------------------------------------------------------
// Exclusion — real separate processes: pause and death
// ---------------------------------------------------------------------------

test("a PAUSED holder keeps the lock; only death releases it", { skip: !POSIX }, async (t) => {
  const dir = await mkTmp(t);
  const lockDir = path.join(dir, MONITOR, `fact-monitor-${MONITOR}.lock`);
  await fs.mkdir(lockDir, { recursive: true });
  const child = spawn(process.execPath, ["-e", `
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(process.argv[1], { timeout: 0 });
    db.exec("BEGIN IMMEDIATE");
    process.send("held");
    process.kill(process.pid, "SIGSTOP");
    setInterval(() => {}, 60000);
  `, path.join(lockDir, "lock.db")], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
  const done = once(child, "exit");
  try {
    const [message] = await bounded(Promise.race([once(child, "message"), done]), "child lock acquisition");
    assert.equal(message, "held");
    await fs.utimes(path.join(lockDir, "lock.db"), new Date(0), new Date(0));
    await assert.rejects(
      () => withSqliteTickLock(path.join(dir, MONITOR), MONITOR, async () => assert.fail("contender entered"), { timeoutMs: 150 }),
      LockTimeoutError,
    );
  } finally {
    child.kill("SIGKILL");
    await bounded(done, "holder exit");
  }
  const acquired = await withSqliteTickLock(path.join(dir, MONITOR), MONITOR, async () => true);
  assert.equal(acquired, true);
});

test("a paused publisher keeps its record and pointer coherent when another process attempts the same sequence", { skip: !POSIX }, async (t) => {
  const dir = await mkTmp(t);
  const now = new Date(0);
  const loser = await prepareFactMonitorTick(dir, MONITOR, definition(), { now });
  const current = path.join(dir, MONITOR, "current.json");
  const record = path.join(dir, MONITOR, "ticks", "tick-1.json");
  const monitorModule = new URL("../dist/lib/fact-monitor.js", import.meta.url).href;
  const payload = JSON.stringify({ dir, monitorId: MONITOR, definition: definition(), outcome: satisfied("2.4.0"), current, monitorModule });
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import fs from "node:fs/promises";
    import { once } from "node:events";
    import { syncBuiltinESMExports } from "node:module";
    const params = JSON.parse(process.argv[1]);
    const { prepareFactMonitorTick, commitFactMonitorTick } = await import(params.monitorModule);
    const now = new Date(0);
    const prepared = await prepareFactMonitorTick(params.dir, params.monitorId, params.definition, { now });
    const rename = fs.rename;
    fs.rename = async (from, to) => {
      if (to === params.current) {
        const resume = once(process, "message");
        process.send({ at: "before-pointer", tickId: prepared.tickId });
        process.kill(process.pid, "SIGSTOP");
        await resume;
      }
      return rename(from, to);
    };
    syncBuiltinESMExports();
    const result = await commitFactMonitorTick(params.dir, prepared, params.outcome, { now });
    process.send({ at: "committed", tickId: result.tickId });
    process.disconnect();
  `, payload], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
  const done = once(child, "exit");
  try {
    const [ready] = await bounded(Promise.race([once(child, "message"), done]), "paused publication");
    assert.equal(ready?.at, "before-pointer");
    const bytesBefore = await fs.readFile(record);
    await assert.rejects(fs.lstat(current), { code: "ENOENT" });
    await assert.rejects(
      () => commitFactMonitorTick(dir, loser, satisfied("2.0.0"), { now, lock: { staleMs: 1, timeoutMs: 150 } }),
      LockTimeoutError,
    );
    assert.deepEqual(await fs.readFile(record), bytesBefore);
    await assert.rejects(fs.lstat(current), { code: "ENOENT" });
    const committed = once(child, "message");
    child.kill("SIGCONT");
    child.send("resume");
    const [result] = await bounded(Promise.race([committed, done]), "publication completed");
    assert.deepEqual(result, { at: "committed", tickId: ready.tickId });
    const retry = await commitFactMonitorTick(dir, loser, satisfied("2.0.0"), { now });
    assert.equal(retry.committed, false);
    const state = await loadFactMonitorState(dir, MONITOR);
    assert.equal(state.commit.tickId, ready.tickId);
    assert.deepEqual(await fs.readFile(record), bytesBefore);
  } finally {
    child.kill("SIGKILL");
    await bounded(done, "publisher exit");
  }
});

// ---------------------------------------------------------------------------
// Claim semantics against legacy artifacts
// ---------------------------------------------------------------------------

test("claim is idempotent on the directory and refuses legacy files/symlinks", async (t) => {
  const dir = await mkTmp(t);
  const monitorDir = path.join(dir, MONITOR);
  await fs.mkdir(monitorDir, { recursive: true });
  const lockDir = path.join(monitorDir, `fact-monitor-${MONITOR}.lock`);

  // Fresh claim: real directory + permanent DB; reuse on the second call.
  const first = await claimTickLockDir(monitorDir, MONITOR);
  const again = await claimTickLockDir(monitorDir, MONITOR);
  assert.equal(first, lockDir);
  assert.equal(again, lockDir);
  assert.equal((await fs.lstat(lockDir)).isDirectory(), true);
  await fs.utimes(lockDir, new Date(0), new Date(0));
  await assert.rejects(
    () => withAsyncFileLock(monitorDir, `fact-monitor-${MONITOR}`, async () => assert.fail("legacy writer entered"), {
      timeoutMs: 30, staleMs: 1, timeoutLabel: "legacy monitor", setTimeout: (retry) => setTimeout(retry, 5),
    }),
    LockTimeoutError,
  );
  assert.equal((await fs.lstat(lockDir)).isDirectory(), true);

  // A legacy FILE at the name (live legacy holder or stale) is refused.
  const dir2 = await mkTmp(t);
  const monitorDir2 = path.join(dir2, "legacy");
  await fs.mkdir(monitorDir2, { recursive: true });
  await fs.writeFile(path.join(monitorDir2, "fact-monitor-legacy.lock"), "legacy artifact");
  await assert.rejects(
    async () => claimTickLockDir(monitorDir2, "legacy"),
    (e) => e instanceof ValidationError && /legacy lock artifact/.test(e.message),
  );
  // ...and the file is left untouched (no automatic break).
  assert.equal(await fs.readFile(path.join(monitorDir2, "fact-monitor-legacy.lock"), "utf8"), "legacy artifact");

  // A symlink at the name is refused identically.
  const dir3 = await mkTmp(t);
  const monitorDir3 = path.join(dir3, "sym");
  const elsewhere = path.join(dir3, "elsewhere");
  await fs.mkdir(elsewhere, { recursive: true });
  await fs.mkdir(monitorDir3, { recursive: true });
  await fs.symlink(elsewhere, path.join(monitorDir3, "fact-monitor-sym.lock"), "junction");
  await assert.rejects(
    async () => claimTickLockDir(monitorDir3, "sym"),
    (e) => e instanceof ValidationError && /legacy lock artifact/.test(e.message),
  );
});

test("a redirected lock database is refused before SQLite opens it", { skip: !POSIX }, async (t) => {
  const dir = await mkTmp(t);
  const monitorDir = path.join(dir, MONITOR);
  const lockDir = await claimTickLockDir(monitorDir, MONITOR);
  const target = path.join(dir, "elsewhere.db");
  await fs.symlink(target, path.join(lockDir, "lock.db"));
  await assert.rejects(
    () => withSqliteTickLock(monitorDir, MONITOR, async () => assert.fail("redirected DB acquired")),
    { name: "ValidationError", message: /owned regular file/ },
  );
  await assert.rejects(fs.lstat(target), { code: "ENOENT" });
});

// ---------------------------------------------------------------------------
// Format preservation + first-orphan fault matrix
// ---------------------------------------------------------------------------

test("a committed tick preserves the exact current.json / tick-record format under the new lock", async (t) => {
  const dir = await mkTmp(t);
  const report = await commit(dir, satisfied("2.4.0"));
  assert.equal(report.committed, true);
  const state = JSON.parse(await fs.readFile(path.join(dir, MONITOR, "current.json"), "utf8"));
  assert.equal(state.schemaVersion, 1);
  assert.equal(state.seq, 1);
  assert.equal(state.commit.tickId, report.tickId);
  const record = JSON.parse(await fs.readFile(path.join(dir, MONITOR, "ticks", "tick-1.json"), "utf8"));
  assert.equal(record.seq, 1);
  assert.equal(record.tickId, report.tickId);
  assert.deepEqual(record.stateAfter, state);
  const loaded = await loadFactMonitorState(dir, MONITOR);
  assert.equal(loaded.seq, 1);
});

test("caught pre-pointer failure on a first publication cleans its OWN record and rethrows the original error", async (t) => {
  const dir = await mkTmp(t);
  const eio = new Error("synthetic pre-rename I/O failure");
  const current = path.join(dir, MONITOR, "current.json");
  let entered = false;
  fakeFs(t, "rename", async (rename, from, to) => {
    if (to === current && !entered) {
      entered = true;
      assert.equal(JSON.parse(await fs.readFile(path.join(dir, MONITOR, "ticks", "tick-1.json"), "utf8")).seq, 1);
      throw eio;
    }
    return rename(from, to);
  });
  await assert.rejects(() => commit(dir, satisfied("2.4.0")), (err) => err === eio);
  // Our own record was removed: no orphan, no pointer — clean retry state.
  const ticksDir = path.join(dir, MONITOR, "ticks");
  assert.deepEqual(await fs.readdir(ticksDir), []);
  await assert.rejects(() => fs.lstat(path.join(dir, MONITOR, "current.json")), (e) => e.code === "ENOENT");
  // The NEXT retry succeeds cleanly through the normal path.
  const retry = await commit(dir, satisfied("2.4.0"));
  assert.equal(retry.committed, true);
  assert.equal(retry.seq, 1);
});

test("a failed record write on a fresh store writes nothing; retry succeeds", async (t) => {
  const dir = await mkTmp(t);
  const eio = new Error("synthetic record-write failure");
  const record = path.join(dir, MONITOR, "ticks", "tick-1.json");
  let entered = false;
  fakeFs(t, "rename", async (rename, from, to) => {
    if (to === record && !entered) { entered = true; throw eio; }
    return rename(from, to);
  });
  await assert.rejects(() => commit(dir, satisfied("2.4.0")), (err) => err === eio);
  assert.deepEqual(await fs.readdir(path.join(dir, MONITOR, "ticks")), []);
  const retry = await commit(dir, satisfied("2.4.0"));
  assert.equal(retry.committed, true);
});

test("a pre-existing foreign orphan is never deleted and keeps failing closed", async (t) => {
  const dir = await mkTmp(t);
  const ticksDir = path.join(dir, MONITOR, "ticks");
  await fs.mkdir(ticksDir, { recursive: true });
  const foreign = `${JSON.stringify({ schemaVersion: 1, monitorId: MONITOR, tickId: "someone-else", seq: 1, at: "1970-01-01T00:00:00.000Z", definitionDigest: "0".repeat(64), engine: { kind: "error", reason: "x" }, events: [], stateAfter: null })}\n`;
  await fs.writeFile(path.join(ticksDir, "tick-1.json"), foreign);
  // The commit's locked load fails closed on the ambiguous history...
  await assert.rejects(
    () => commit(dir, satisfied("2.4.0")),
    (e) => e instanceof ValidationError && /actual orphan|manual inspection/.test(e.message),
  );
  // ...and the foreign record is byte-identical: never auto-deleted.
  assert.equal(await fs.readFile(path.join(ticksDir, "tick-1.json"), "utf8"), foreign);
});

test("a failed cleanup leaves the own record and reports uncertain publication", async (t) => {
  const dir = await mkTmp(t);
  const current = path.join(dir, MONITOR, "current.json");
  const record = path.join(dir, MONITOR, "ticks", "tick-1.json");
  fakeFs(t, "rename", async (rename, from, to) => {
    if (to === current) throw new Error("pointer rename failed");
    return rename(from, to);
  });
  fakeFs(t, "unlink", async (unlink, file) => {
    if (file === record) throw new Error("cleanup failed");
    return unlink(file);
  });
  await assert.rejects(() => commit(dir, satisfied("2.4.0")), FactMonitorPublicationUncertainError);
  assert.equal(JSON.parse(await fs.readFile(record, "utf8")).seq, 1);
  await assert.rejects(fs.lstat(current), { code: "ENOENT" });
});

test("a post-pointer failure keeps the visible-unconfirmed semantics", { skip: !POSIX }, async (t) => {
  const dir = await mkTmp(t);
  const monitorDir = path.join(dir, MONITOR);
  const current = path.join(monitorDir, "current.json");
  let moved = false;
  fakeFs(t, "rename", async (rename, from, to) => {
    await rename(from, to);
    if (to === current) moved = true;
  });
  fakeFs(t, "open", async (open, file, flags, ...rest) => {
    if (moved && file === monitorDir && flags === "r") throw new Error("pointer directory sync failed");
    return open(file, flags, ...rest);
  });
  const report = await commit(dir, satisfied("2.4.0"));
  assert.equal(moved, true);
  assert.equal(report.committed, true);
  assert.equal(report.durability, "visible-unconfirmed");
  assert.match(report.durabilityWarning, /do not retry/);
  const state = await loadFactMonitorState(dir, MONITOR);
  assert.equal(state.seq, 1);
  assert.equal(state.commit.tickId, report.tickId);
});
