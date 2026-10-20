/** PR289 native retained-store regression cases. Owned local fixtures only. */
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { spawn } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import {
  openStore,
  SNAPSHOT_MAX_BYTES,
  SETTLEMENT_RESERVE_BYTES,
} from "../dist/lib/retained-record-store.js";
import { atomicReplaceFile } from "../dist/lib/config-store.js";

globalThis.fetch = () => { throw new Error("HTTP refused"); };
const REQUIREMENTS = { schemaVersion: 1, fields: { a: { definition: "synthetic", required: true } } };

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rrs-pr289-"));
  t.diagnostic(`owned fixture ${root}`);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = openStore({ root, ...options });
  const { investigationRef: ref } = await store.createInvestigation({ requirements: REQUIREMENTS });
  return { root, store, ref, dir: path.join(root, "investigations", ref) };
}

// Exit at the real native placement boundaries; abrupt exit deliberately skips
// createRecoveryHeld's finally. The parent owns and joins this exact child.
async function crashRecoveryPreparation(t, root, ref, dir, phase, ownerId = "") {
  const script = `
    import fsp from "node:fs/promises";
    import { syncBuiltinESMExports } from "node:module";
    const [root, ref, phase, moduleUrl, ownerId] = process.argv.slice(1);
    if (phase === "postlink") {
      const link = fsp.link;
      fsp.link = async (from, to) => {
        await link(from, to);
        if (String(from).endsWith(".reserve.tmp") && String(to).endsWith(".record")) process.exit(94);
      };
      syncBuiltinESMExports();
    }
    const { openStore } = await import(moduleUrl);
    const store = openStore({ root, deps: { ...(ownerId ? { randomId: () => ownerId } : {}), writeFileAtomic: async (file) => {
      if (String(file).endsWith(".reserve.tmp")) {
        if (phase === "prelink") process.exit(93);
        return;
      }
      throw new Error("unexpected write funnel before recovery exit");
    } } });
    const handle = await store.acquireOwnership(ref);
    try { await handle.beginRound({ roundId: "crashed-preparation", intent: "continue" }); }
    finally { await handle.release(); }
    throw new Error("native exit boundary not reached");
  `;
  t.diagnostic(`owned crash root ${root}; phase ${phase}`);
  const child = spawn(process.execPath, ["--input-type=module", "-e", script, root, ref, phase,
    new URL("../dist/lib/retained-record-store.js", import.meta.url).href, ownerId],
  { env: process.env, stdio: ["ignore", "ignore", "pipe"], timeout: 15000 });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4096); });
  const exit = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  assert.deepEqual(exit, { code: phase === "prelink" ? 93 : 94, signal: null }, stderr);
  const auditDir = path.join(dir, "audit");
  const stages = (await fs.readdir(auditDir)).filter((name) => name.endsWith(".reserve.tmp"));
  assert.equal(stages.length, 1, "actual native allocation must survive child exit");
  const stage = path.join(auditDir, stages[0]);
  const bytes = await fs.readFile(stage);
  assert.equal(bytes.length, 8192);
  const final = path.join(auditDir, stages[0].match(/^\.(ack-[0-9a-f]{64}\.record)\./)[1]);
  if (phase === "postlink") {
    const [a, b] = await Promise.all([fs.lstat(stage, { bigint: true }), fs.lstat(final, { bigint: true })]);
    assert.equal(a.dev, b.dev);
    assert.equal(a.ino, b.ino, "actual native link must share the stage inode");
  } else await assert.rejects(fs.lstat(final), { code: "ENOENT" });
  await assert.rejects(fs.lstat(path.join(dir, "incomplete.json")), { code: "ENOENT" });
  return { stage, final, bytes };
}

test("R3: canonical replacement during native read preserves both preparations", async (t) => {
  const { root, ref, dir } = await fixture(t);
  const { stage, final, bytes } = await crashRecoveryPreparation(t, root, ref, dir, "postlink");
  const oldStage = await fs.lstat(stage, { bigint: true });
  const revision = await fs.readFile(path.join(dir, "revisions", "r0.json"));
  const originalOpen = fsp.open;
  const replacement = path.join(dir, "audit", "owned-canonical-replacement.tmp");
  let swapped = 0;
  let foreign;
  const writes = [];
  const store = openStore({ root, deps: { writeFileAtomic: async (file, data) => {
    writes.push(file);
    await atomicReplaceFile(file, data);
  } } });
  const handle = await store.acquireOwnership(ref);
  writes.length = 0; // Only beginRound's fresh allocations are forbidden after the swap.
  try {
    fsp.open = async (file, ...args) => {
      const opened = await originalOpen(file, ...args);
      if (file !== final) return opened;
      return new Proxy(opened, { get(target, key) {
        if (key === "read") return async (...readArgs) => {
          const result = await target.read(...readArgs);
          if (result.bytesRead > 0 && swapped === 0) {
            await fs.writeFile(replacement, bytes, { flag: "wx" });
            await fs.rename(replacement, final);
            foreign = await fs.lstat(final, { bigint: true });
            assert.notEqual(foreign.ino, oldStage.ino, "replacement must be a different native inode");
            swapped += 1;
            t.diagnostic(`canonical read replacement witness ${swapped}; old inode ${oldStage.ino}; foreign inode ${foreign.ino}`);
          }
          return result;
        };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      } });
    };
    syncBuiltinESMExports();
    await assert.rejects(handle.beginRound({ roundId: "must-preserve-swapped-canonical", intent: "continue" }),
      (error) => error.name === "CorruptContentError" && error.code === "CORRUPT_CONTENT" &&
        error.message === `Refusing changed native retained path: ${final}`);
    assert.equal(swapped, 1, "canonical replacement must occur inside the opened native read");
    for (const [file, before] of [[stage, oldStage], [final, foreign]]) {
      const after = await fs.lstat(file, { bigint: true });
      assert.equal(after.ino, before.ino); assert.equal(after.dev, before.dev);
      assert.deepEqual(await fs.readFile(file), bytes);
    }
    assert.deepEqual((await fs.readdir(path.join(dir, "audit"))).sort(), [path.basename(stage), path.basename(final)].sort());
    assert.deepEqual(writes, [], "no fresh recovery slot, reserve or marker may be dispatched");
    for (const name of ["incomplete.json", "reserve.settlement"]) await assert.rejects(fs.lstat(path.join(dir, name)), { code: "ENOENT" });
    assert.deepEqual(await fs.readFile(path.join(dir, "revisions", "r0.json")), revision);
  } finally {
    fsp.open = originalOpen;
    syncBuiltinESMExports();
    await handle.release();
  }
});

for (const canonicalOnly of [false, true]) {
  test(`R3: legacy UTF16 owner reclaims ${canonicalOnly ? "canonical-only" : "linked-stage"} pending preparation`, async (t) => {
    const { root, store, ref, dir } = await fixture(t);
    const revision = await fs.readFile(path.join(dir, "revisions", "r0.json"));
    const ownerId = "€".repeat(32);
    assert.equal(ownerId.length, 32); assert.equal(Buffer.byteLength(ownerId), 96);
    const { stage, final, bytes } = await crashRecoveryPreparation(t, root, ref, dir, "postlink", ownerId);
    assert.equal(JSON.parse(bytes.subarray(0, bytes.indexOf(0)).toString()).priorOwner, ownerId);
    // Explicit fixture derivation from the real postlink pair; no canonical-only crash claim.
    if (canonicalOnly) await fs.unlink(stage);
    const originalUnlink = fsp.unlink;
    const reclaimed = [];
    const handle = await store.acquireOwnership(ref);
    try {
      fsp.unlink = async (file) => {
        if (file === stage || file === final) reclaimed.push((await fs.lstat(file)).size);
        return originalUnlink(file);
      };
      syncBuiltinESMExports();
      await handle.beginRound({ roundId: "legacy-owner-successor", intent: "continue" });
      assert.deepEqual(reclaimed, canonicalOnly ? [8192] : [8192, 8192]);
      for (const file of [stage, final]) await assert.rejects(fs.lstat(file), { code: "ENOENT" });
      assert.deepEqual(await fs.readFile(path.join(dir, "revisions", "r0.json")), revision);
      const marker = JSON.parse(await fs.readFile(path.join(dir, "incomplete.json"), "utf8"));
      assert.equal(marker.roundId, "legacy-owner-successor");
      assert.equal((await fs.readdir(path.join(dir, "audit"))).filter((name) => name.endsWith(".record")).length, 1);
    } finally {
      fsp.unlink = originalUnlink;
      syncBuiltinESMExports();
      await handle.release();
    }
  });
}

test("R3: over64 UTF16 owner preserves both orphan forms", async (t) => {
  for (const canonicalOnly of [false, true]) {
    const { root, store, ref, dir } = await fixture(t);
    const { stage, final, bytes } = await crashRecoveryPreparation(t, root, ref, dir, "postlink", "€".repeat(65));
    if (canonicalOnly) await fs.unlink(stage);
    const names = await fs.readdir(path.join(dir, "audit"));
    const before = await Promise.all(names.map(async (name) => [name, await fs.lstat(path.join(dir, "audit", name), { bigint: true })]));
    const handle = await store.acquireOwnership(ref);
    try {
      await assert.rejects(handle.beginRound({ roundId: "overlong-owner-refused", intent: "continue" }),
        (error) => error.name === "CorruptRecordError" && error.code === "CORRUPT_RECORD" &&
          error.message === `Orphan recovery${canonicalOnly ? "" : " stage"} instance cannot be verified.`);
      assert.deepEqual(await fs.readdir(path.join(dir, "audit")), names);
      for (const [name, old] of before) {
        const file = path.join(dir, "audit", name);
        const after = await fs.lstat(file, { bigint: true });
        assert.equal(after.ino, old.ino); assert.equal(after.dev, old.dev);
        assert.deepEqual(await fs.readFile(file), bytes);
      }
      for (const name of ["incomplete.json", "reserve.settlement"]) await assert.rejects(fs.lstat(path.join(dir, name)), { code: "ENOENT" });
      assert.equal((await store.inspect(ref)).committed.revision, 0);
    } finally { await handle.release(); }
  }
});

for (const phase of ["prelink", "postlink"]) {
  test(`F1: next owner reclaims actual native ${phase} crash preparation`, async (t) => {
    const { root, store, ref, dir } = await fixture(t);
    const revision = await fs.readFile(path.join(dir, "revisions", "r0.json"));
    const { stage, final } = await crashRecoveryPreparation(t, root, ref, dir, phase);
    const handle = await store.acquireOwnership(ref);
    try {
      await handle.beginRound({ roundId: "successor", intent: "continue" });
      await assert.rejects(fs.lstat(stage), { code: "ENOENT" }, "old native stage must be reclaimed");
      await assert.rejects(fs.lstat(final), { code: "ENOENT" });
      assert.deepEqual(await fs.readFile(path.join(dir, "revisions", "r0.json")), revision);
    } finally { await handle.release(); }
  });
}

for (const phase of ["prelink", "postlink"]) {
  test(`F2: ${phase} cleanup reclaims each admitted directory entry and retry is idempotent`, async (t) => {
    const { root, ref, dir } = await fixture(t);
    const { stage, final } = await crashRecoveryPreparation(t, root, ref, dir, phase);
    const revision = await fs.readFile(path.join(dir, "revisions", "r0.json"));
    const auditDir = path.join(dir, "audit");
    const ordinary = path.join(auditDir, "ordinary.txt");
    const foreign = path.join(auditDir, ".ack-foreign.reserve.tmp");
    const publication = path.join(dir, "revisions", ".r1.json.owned.stage.tmp");
    for (const file of [ordinary, foreign, publication]) await fs.writeFile(file, "owned unrelated evidence");
    const auditBytes = async () => {
      let sum = 0;
      for (const name of await fs.readdir(auditDir)) sum += (await fs.lstat(path.join(auditDir, name))).size;
      return sum;
    };
    const originalUnlink = fsp.unlink;
    const reclaimed = [];
    let refuseFresh = true;
    const freshFault = new Error("F2-fresh-preparation-refusal");
    const store = openStore({ root, deps: { writeFileAtomic: async (file, bytes) => {
      if (refuseFresh && file.endsWith(".reserve.tmp")) throw freshFault;
      await atomicReplaceFile(file, bytes);
    } } });
    const handle = await store.acquireOwnership(ref);
    try {
      fsp.unlink = async (file) => {
        if (file !== stage && file !== final) return originalUnlink(file);
        const before = await auditBytes();
        await originalUnlink(file);
        reclaimed.push(before - await auditBytes());
      };
      syncBuiltinESMExports();
      await assert.rejects(handle.beginRound({ roundId: "retry-cleanup", intent: "continue" }), (error) => error === freshFault);
      assert.deepEqual(reclaimed, phase === "prelink" ? [8192] : [8192, 8192]);
      assert.equal(reclaimed.reduce((a, b) => a + b, 0), phase === "prelink" ? 8192 : 16384);
      for (const file of [stage, final]) await assert.rejects(fs.lstat(file), { code: "ENOENT" });
      refuseFresh = false;
      await handle.beginRound({ roundId: "retry-cleanup", intent: "continue" });
      assert.equal(reclaimed.length, phase === "prelink" ? 1 : 2, "retry must not reclaim already removed paths");
      assert.equal((await fs.readdir(auditDir)).filter((name) => name.endsWith(".record")).length, 1);
      assert.deepEqual(await fs.readFile(path.join(dir, "revisions", "r0.json")), revision);
      for (const file of [ordinary, foreign, publication]) assert.equal(await fs.readFile(file, "utf8"), "owned unrelated evidence");
    } finally {
      fsp.unlink = originalUnlink;
      syncBuiltinESMExports();
      await handle.release();
    }
  });
}

for (const variant of ["partial", "malformed", "tail", "future", "foreign-final", "symlink-final", "symlink-stage", "sealed-alias", "active-marker"]) {
  test(`F2: unprovable ${variant} preparation preserves exact native paths and bytes`, async (t) => {
    const { root, store, ref, dir } = await fixture(t);
    let { stage, final, bytes } = await crashRecoveryPreparation(t, root, ref, dir, "prelink");
    if (variant === "partial") await fs.truncate(stage, 3000);
    if (variant === "malformed") { const changed = Buffer.from(bytes); changed[0] = 0x21; await fs.writeFile(stage, changed); }
    if (variant === "tail") { const changed = Buffer.from(bytes); changed[8191] = 1; await fs.writeFile(stage, changed); }
    if (variant === "future") {
      const header = JSON.parse(bytes.subarray(0, bytes.indexOf(0)).toString());
      header.revisionBase = 1;
      const changed = Buffer.alloc(8192); Buffer.from(JSON.stringify(header)).copy(changed); await fs.writeFile(stage, changed);
    }
    if (variant === "foreign-final") await fs.writeFile(final, bytes, { flag: "wx" });
    if (variant === "symlink-final") await fs.symlink(stage, final);
    if (variant === "symlink-stage") { await fs.rename(stage, final); await fs.symlink(final, stage); }
    if (variant === "sealed-alias" || variant === "active-marker") {
      // A real interrupted round produces the sealed history / active marker.
      await fs.unlink(stage);
      const previous = await store.acquireOwnership(ref);
      try { await previous.beginRound({ roundId: "history", intent: "continue" }); }
      finally { await previous.release(); }
      const marker = JSON.parse(await fs.readFile(path.join(dir, "incomplete.json"), "utf8"));
      if (variant === "sealed-alias") {
        const ack = await store.acknowledgeInterrupted(ref);
        await ack.release();
      }
      // Bind the alias basename to the real history tuple: refusal must reach
      // the pristine-image guard, rather than an unrelated name/hash mismatch.
      stage = path.join(dir, "audit", path.basename(stage).replace(/^\.ack-[0-9a-f]{64}\.record\./, `.${marker.recovery.name}.`));
      await fs.link(path.join(dir, "audit", marker.recovery.name), stage);
    }
    const names = await fs.readdir(path.join(dir, "audit"));
    const before = await Promise.all(names.map(async (name) => {
      const file = path.join(dir, "audit", name);
      const stat = await fs.lstat(file, { bigint: true });
      return { file, bytes: await fs.readFile(file), ino: stat.ino, dev: stat.dev, link: stat.isSymbolicLink() ? await fs.readlink(file) : null };
    }));
    const handle = await store.acquireOwnership(ref);
    try {
      await assert.rejects(handle.beginRound({ roundId: "must-refuse", intent: "continue" }), (error) =>
        variant === "active-marker" ? error.code === "UNACKNOWLEDGED_INTERRUPTION" :
          ["CORRUPT_RECORD", "CORRUPT_CONTENT", "INVALID_REFERENCE"].includes(error.code));
      assert.deepEqual(await fs.readdir(path.join(dir, "audit")), names);
      for (const item of before) {
        const after = await fs.lstat(item.file, { bigint: true });
        assert.equal(after.ino, item.ino); assert.equal(after.dev, item.dev);
        assert.deepEqual(await fs.readFile(item.file), item.bytes);
        if (item.link !== null) assert.equal(await fs.readlink(item.file), item.link);
      }
    } finally { await handle.release(); }
  });
}

test("D: reserve above bounded reader ceiling refuses at construction", () => {
  assert.throws(
    () => openStore({ root: "/tmp/rrs-pr289-constructor-only", caps: { settlementReserveBytes: 512 * 1024 } }),
    (error) => error.name === "InvalidRecordInputError" && error.code === "INVALID_RECORD_INPUT",
  );
});

test("D: reserve too small for actual maximum-ID header refuses before marker publication", async (t) => {
  const { root, ref, dir } = await fixture(t);
  const store = openStore({
    root,
    caps: { settlementReserveBytes: 1 },
    deps: { randomId: () => "o".repeat(64) },
  });
  const handle = await store.acquireOwnership(ref);
  try {
    await assert.rejects(
      handle.beginRound({ roundId: "r".repeat(64), intent: "continue" }),
      (error) => error.name === "InvalidRecordInputError" && error.code === "INVALID_RECORD_INPUT",
    );
    for (const name of ["incomplete.json", "reserve.settlement"]) {
      await assert.rejects(fs.lstat(path.join(dir, name)), { code: "ENOENT" });
    }
    assert.equal((await store.inspect(ref)).committed.revision, 0);
  } finally {
    await handle.release();
  }
});

for (const reserveBytes of [256, SETTLEMENT_RESERVE_BYTES, SNAPSHOT_MAX_BYTES]) {
  test(`D: supported reserve ${reserveBytes} preserves full headers through settle restoration/ACK refusal and reopen`, async (t) => {
    const { root, ref, dir } = await fixture(t);
    let fault = null;
    const roundId = "r".repeat(64);
    const priorOwner = "o".repeat(64);
    let ownerCount = 0;
    const store = openStore({
      root,
      caps: { settlementReserveBytes: reserveBytes },
      deps: {
        randomId: () => ownerCount++ === 0 ? priorOwner : String.fromCharCode(96 + ownerCount).repeat(64),
        writeFileAtomic: async (file, bytes) => {
          if (fault === "settle" && path.basename(file).startsWith("settlement-")) {
            throw new Error("D-summary-refusal");
          }
          await atomicReplaceFile(file, bytes);
        },
      },
    });
    const verifyHeader = async () => {
      const bytes = await fs.readFile(path.join(dir, "reserve.settlement"));
      assert.equal(bytes.length, reserveBytes);
      const end = bytes.indexOf(0);
      const header = JSON.parse(bytes.subarray(0, end === -1 ? bytes.length : end).toString("utf8"));
      assert.equal(header.roundId, roundId);
      assert.equal(header.ownerId, priorOwner);
      assert.equal(header.reserveBytes, reserveBytes);
    };
    const summary = { status: "partial", measured: { searches: 0, reads: 0, judgments: 0 }, uncertainty: null };
    const handle = await store.acquireOwnership(ref);
    try {
      await handle.beginRound({ roundId, intent: "continue" });
      await verifyHeader();
      fault = "settle";
      await assert.rejects(handle.settleRound(roundId, summary), { message: "D-summary-refusal" });
      await verifyHeader();
      assert.equal((await store.inspect(ref)).incomplete.settled, false);
    } finally {
      await handle.release();
    }
    fault = "ack";
    const originalOpen = fsp.open;
    try {
      fsp.open = async (file, flags, ...args) => {
        const opened = await originalOpen(file, flags, ...args);
        if (String(file).endsWith(".record") && typeof flags === "number" && (flags & fs.constants.O_RDWR)) {
          opened.sync = async () => { throw new Error("D-ack-refusal"); };
        }
        return opened;
      };
      syncBuiltinESMExports();
      await assert.rejects(store.acknowledgeInterrupted(ref), { message: "D-ack-refusal" });
    } finally {
      fsp.open = originalOpen;
      syncBuiltinESMExports();
    }
    await verifyHeader();
    fault = null;
    const successor = await store.acknowledgeInterrupted(ref);
    try {
      await successor.beginRound({ roundId, intent: "continue" });
      await successor.settleRound(roundId, summary);
      const prior = (await store.inspect(ref)).committed.snapshot;
      await successor.commitRevision({ expectedRevision: 0, snapshot: { ...prior, revision: 1, parentRevision: 0 } });
    } finally {
      await successor.release();
    }
    const reopened = await openStore({ root, caps: { settlementReserveBytes: reserveBytes } }).inspect(ref);
    assert.equal(reopened.committed.revision, 1);
    assert.equal(reopened.incomplete, null);
  });
}

async function siblingDeletionSchedule(t, phase, scenario = { mode: "normal" }) {
  const { root, store, ref: victimRef, dir: victimDir } = await fixture(t);
  const { investigationRef: writerRef } = await store.createInvestigation({ requirements: REQUIREMENTS });
  Object.assign(scenario, { root, writerRef, store });
  const writerDir = path.join(root, "investigations", writerRef);
  const victimLeaf = path.join(victimDir, "requirements.json");
  const manifestBefore = await fs.readFile(path.join(writerDir, "store.json"));
  const revisionBefore = await fs.readFile(path.join(writerDir, "revisions", "r0.json"));
  let bodyLanded = false;
  const writerStore = openStore({ root, deps: { writeFileAtomic: async (file, bytes) => {
    await atomicReplaceFile(file, bytes);
    if (path.dirname(file) === path.join(writerDir, "bodies")) bodyLanded = true;
  } } });
  const handle = await writerStore.acquireOwnership(writerRef);
  scenario.handle = handle;
  let allowRemoval;
  const removeAllowed = new Promise((resolve) => { allowRemoval = resolve; });
  let announceRemoval;
  const removalReady = new Promise((resolve) => { announceRemoval = resolve; });
  const earlyFault = new Error("F3-early-deletion-fault");
  const deletionStore = openStore({ root, deps: {
    ...(scenario.mode === "early" ? { gateFactory: async () => ({
      isHeld: async () => false, tryAcquire: async () => { throw earlyFault; }, release: async () => {},
    }) } : {}),
    removeTree: async (dir) => {
      assert.equal(dir, victimDir);
      if (scenario.mode === "complete") return;
      scenario.announced = true;
      announceRemoval();
      await removeAllowed;
      if (scenario.mode === "late") throw new Error("F4-post-announcement-removal-fault");
      await fs.rm(dir, { recursive: true, force: true });
  } } });
  let deletionOutcome;
  let primaryError;
  const originalReaddir = fsp.readdir;
  const originalLstat = fsp.lstat;
  let listed = false;
  let intercepted = 0;
  try {
    await handle.beginRound({ roundId: `writer-${phase}`, intent: "continue" });
    // Consume rejection immediately, including faults before removeTree can announce.
    deletionOutcome = deletionStore.deleteInvestigation(victimRef).then(
      (value) => ({ ok: true, value }),
      (error) => { scenario.deletionError = error; return { ok: false, error }; },
    );
    await Promise.race([
      removalReady,
      deletionOutcome.then((outcome) => {
        if (!outcome.ok) throw outcome.error;
        throw new Error("deletion completed before the removal seam was announced");
      }),
    ]);
    t.diagnostic(`listed-leaf schedule ${JSON.stringify({ phase, victimLeaf, writerDir })}`);
    fsp.readdir = async (dir, ...args) => {
      const entries = await originalReaddir(dir, ...args);
      if (dir === victimDir && bodyLanded === (phase === "post")) {
        listed = entries.some((entry) => typeof entry !== "string" && entry.name === "requirements.json" && entry.isFile());
      }
      return entries;
    };
    fsp.lstat = async (file, ...args) => {
      if (file === victimLeaf && listed && bodyLanded === (phase === "post") && intercepted === 0) {
        intercepted += 1;
        allowRemoval();
        const outcome = await deletionOutcome;
        if (!outcome.ok) throw outcome.error;
        // The REAL leaf lstat below now returns ENOENT after actual deletion.
      }
      return originalLstat(file, ...args);
    };
    syncBuiltinESMExports();
    const content = `retained sibling body ${phase}`;
    const staged = await handle.stageBody(content);
    assert.equal(intercepted, 1, "actual listed-file/lstat deletion window must execute exactly once");
    assert.equal(bodyLanded, true);
    assert.deepEqual(await writerStore.readBody(writerRef, staged.bodyId), Buffer.from(content));
    assert.deepEqual(await fs.readFile(path.join(writerDir, "store.json")), manifestBefore);
    assert.deepEqual(await fs.readFile(path.join(writerDir, "revisions", "r0.json")), revisionBefore);
    await assert.rejects(fs.lstat(victimDir), { code: "ENOENT" });
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    fsp.readdir = originalReaddir;
    fsp.lstat = originalLstat;
    syncBuiltinESMExports();
    allowRemoval();
    const cleanupErrors = [];
    try {
      const outcome = await deletionOutcome;
      if (outcome && !outcome.ok && outcome.error !== primaryError) cleanupErrors.push(outcome.error);
    } catch (error) {
      if (error !== primaryError) cleanupErrors.push(error);
    } finally {
      try { await handle.release(); }
      catch (error) { cleanupErrors.push(error); }
    }
    if (cleanupErrors.length > 0) {
      if (primaryError !== undefined) throw new AggregateError([primaryError, ...cleanupErrors], "Sibling deletion and cleanup failed");
      if (cleanupErrors.length === 1) throw cleanupErrors[0];
      throw new AggregateError(cleanupErrors, "Sibling deletion cleanup failed");
    }
  }
}

for (const phase of ["pre", "post"]) {
  test(`C: sibling deletion in ${phase}-write listed-leaf lstat window preserves unrelated write`, (t) => siblingDeletionSchedule(t, phase));
}

test("F3: early deletion fault fails promptly and releases the writer before the seam", { timeout: 1000 }, async (t) => {
  const scenario = { mode: "early" };
  const originalReaddir = fsp.readdir;
  const originalLstat = fsp.lstat;
  try {
    await assert.rejects(siblingDeletionSchedule(t, "pre", scenario), (error) => error === scenario.deletionError && error.message === "F3-early-deletion-fault");
    assert.notEqual(scenario.announced, true);
    assert.equal(fsp.readdir, originalReaddir);
    assert.equal(fsp.lstat, originalLstat);
    const successor = await scenario.store.acquireOwnership(scenario.writerRef);
    await successor.release();
  } finally { await scenario.handle?.release(); }
});

for (const mode of ["late", "complete"]) {
  test(`F4: ${mode} deletion outcome preserves the fault or seam witness and releases the writer`, { timeout: 1000 }, async (t) => {
    const scenario = { mode };
    const originalReaddir = fsp.readdir;
    const originalLstat = fsp.lstat;
    try {
      await assert.rejects(siblingDeletionSchedule(t, "pre", scenario), (error) => mode === "late" ?
        error === scenario.deletionError && error.code === "DELETION_INCOMPLETE" && /F4-post-announcement-removal-fault/.test(error.message) :
        error.message === "deletion completed before the removal seam was announced");
      assert.equal(scenario.announced === true, mode === "late");
      assert.equal(fsp.readdir, originalReaddir);
      assert.equal(fsp.lstat, originalLstat);
      const successor = await scenario.store.acquireOwnership(scenario.writerRef);
      await successor.release();
    } finally { await scenario.handle?.release(); }
  });
}

test("C: leaf measurement permission failure still refuses before unrelated body write", async (t) => {
  const { root, store, ref, dir } = await fixture(t);
  const handle = await store.acquireOwnership(ref);
  const originalLstat = fsp.lstat;
  const leaf = path.join(root, "permission-leaf");
  let intercepted = 0;
  try {
    await handle.beginRound({ roundId: "permission-control", intent: "continue" });
    await fs.writeFile(leaf, "owned measurement leaf");
    t.diagnostic(`permission-fault target ${leaf}`);
    fsp.lstat = async (file, ...args) => {
      if (file === leaf) {
        intercepted += 1;
        throw Object.assign(new Error("C-permission-refusal"), { code: "EACCES" });
      }
      return originalLstat(file, ...args);
    };
    syncBuiltinESMExports();
    await assert.rejects(handle.stageBody("must not land"), { code: "EACCES", message: "C-permission-refusal" });
    assert.equal(intercepted, 1);
    assert.deepEqual(await fs.readdir(path.join(dir, "bodies")), []);
  } finally {
    fsp.lstat = originalLstat;
    syncBuiltinESMExports();
    await handle.release();
  }
});

for (const [label, detail] of [["ASCII", "a".repeat(2048)], ["escaping", "\0".repeat(2048)]]) {
  test(`B: ${label} serialized audit crossing refuses before changing bounded prior bytes`, async (t) => {
    const { store, ref, dir } = await fixture(t);
    const handle = await store.acquireOwnership(ref);
    try {
      await handle.beginRound({ roundId: "audit-bound", intent: "continue" });
      const row = { at: 1, kind: "observation", detail };
      const doc = { schemaVersion: 1, roundId: "audit-bound", rows: [] };
      while (Buffer.byteLength(JSON.stringify({ ...doc, rows: [...doc.rows, row] })) <= SNAPSHOT_MAX_BYTES) {
        doc.rows.push(row);
      }
      assert.ok(doc.rows.length < 256);
      const auditPath = path.join(dir, "audit", "round-audit-bound.json");
      const prior = Buffer.from(JSON.stringify(doc));
      assert.ok(prior.length <= SNAPSHOT_MAX_BYTES);
      await fs.mkdir(path.dirname(auditPath), { recursive: true });
      await fs.writeFile(auditPath, prior);
      t.diagnostic(`audit byte-bound fault target ${auditPath}`);
      await assert.rejects(handle.appendAudit(row), (error) => error.code === "STORE_CAPACITY");
      assert.deepEqual(await fs.readFile(auditPath), prior);
      assert.equal((await store.inspect(ref)).committed.revision, 0);
    } finally {
      await handle.release();
    }
  });
}

async function treeBytes(dir) {
  let bytes = 0;
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) bytes += await treeBytes(file);
    else if (entry.isFile()) bytes += (await fs.lstat(file)).size;
  }
  return bytes;
}

for (const { settled, dimension } of [{ settled: false, dimension: "rows" }, { settled: true, dimension: "rows" }, { settled: true, dimension: "bytes" }]) {
  test(`B: full ${dimension} and physical store cap ACK ${settled ? "settled" : "unsettled"} without spending sibling bytes`, async (t) => {
    const caps = { recordMaxBytes: 400000, storeMaxBytes: 500000 };
    const { root, store, ref, dir } = await fixture(t, { caps });
    const { investigationRef: siblingRef } = await store.createInvestigation({ requirements: REQUIREMENTS });
    const siblingDir = path.join(root, "investigations", siblingRef);
    const sibling = await store.acquireOwnership(siblingRef);
    const handle = await store.acquireOwnership(ref);
    const roundId = "full-audit";
    const row = { at: 1, kind: "observation", detail: dimension === "rows" ? "normal history" : "\0".repeat(2048) };
    const rows = [];
    while (rows.length < 256 && Buffer.byteLength(JSON.stringify({ schemaVersion: 1, roundId, rows: [...rows, row] })) <= SNAPSHOT_MAX_BYTES) rows.push(row);
    const prior = Buffer.from(JSON.stringify({ schemaVersion: 1, roundId, rows }));
    if (dimension === "rows") assert.equal(rows.length, 256);
    else assert.ok(Buffer.byteLength(JSON.stringify({ schemaVersion: 1, roundId, rows: [...rows, row] })) > SNAPSHOT_MAX_BYTES);
    const auditPath = path.join(dir, "audit", `round-${roundId}.json`);
    let acknowledged;
    try {
      await sibling.beginRound({ roundId: "sibling", intent: "continue" });
      await handle.beginRound({ roundId, intent: "continue" });
      await fs.mkdir(path.dirname(auditPath), { recursive: true });
      await fs.writeFile(auditPath, prior);
      if (settled) await handle.settleRound(roundId, { status: "partial", measured: { searches: 0, reads: 0, judgments: 0 }, uncertainty: null });
      await handle.release();
      await fs.writeFile(path.join(dir, "ballast"), Buffer.alloc(caps.recordMaxBytes - await treeBytes(dir)));
      const fill = path.join(siblingDir, "fill");
      const fillBytes = Buffer.alloc(caps.storeMaxBytes - await treeBytes(root), 113);
      await store.admittedWrite(siblingDir, fill, fillBytes, { chargeBytes: fillBytes.length, rollback: { kind: "created" } }, "real sibling fill");
      assert.equal(await treeBytes(root), caps.storeMaxBytes);
      t.diagnostic(`full-cap ACK ${JSON.stringify({ dir, fill, settled, storeBytes: await treeBytes(root) })}`);
      acknowledged = await store.acknowledgeInterrupted(ref);
      assert.deepEqual(await fs.readFile(auditPath), prior);
      assert.deepEqual(await fs.readFile(fill), fillBytes);
      assert.equal((await store.inspect(ref)).incomplete, null);
      assert.ok(await treeBytes(root) <= caps.storeMaxBytes);
      const receipts = (await fs.readdir(path.join(dir, "audit"))).filter((name) => /^ack-[0-9a-f]{64}\.record$/.test(name));
      assert.equal(receipts.length, 1);
    } finally {
      if (acknowledged) await acknowledged.release();
      await handle.release();
      await sibling.release();
    }
  });
}

for (const boundary of ["short-write", "payload-sync", "seal-sync", "marker-unlink"]) {
  test(`B: native ${boundary} boundary retains allocated recovery and exact idempotent receipt`, async (t) => {
    const { root, store, ref, dir } = await fixture(t);
    const handle = await store.acquireOwnership(ref);
    await handle.beginRound({ roundId: "native-boundary", intent: "continue" });
    await handle.release();
    const markerPath = path.join(dir, "incomplete.json");
    const marker = JSON.parse(await fs.readFile(markerPath, "utf8"));
    const envelope = path.join(dir, "audit", marker.recovery.name);
    const before = await fs.readFile(envelope);
    const identity = await fs.lstat(envelope, { bigint: true });
    t.diagnostic(`native boundary ${JSON.stringify({ boundary, envelope, markerPath })}`);
    const originalOpen = fsp.open;
    const originalUnlink = fsp.unlink;
    let writes = 0;
    let syncs = 0;
    let peak = 0;
    let fail = true;
    let result;
    try {
      fsp.open = async (file, flags, ...args) => {
        const opened = await originalOpen(file, flags, ...args);
        if (file !== envelope || typeof flags !== "number" || !(flags & fs.constants.O_RDWR)) return opened;
        const nativeWrite = opened.write.bind(opened);
        const nativeSync = opened.sync.bind(opened);
        opened.write = async (buffer, offset, length, position) => {
          assert.ok(position >= 2048 && position + length <= 6272);
          assert.equal((await opened.stat()).size, 8192);
          writes += 1;
          const actual = await nativeWrite(buffer, offset, Math.min(length, 73), position);
          peak = Math.max(peak, await treeBytes(root));
          assert.equal((await opened.stat()).size, 8192);
          return actual;
        };
        opened.sync = async () => {
          syncs += 1;
          if (fail && ((boundary === "payload-sync" && syncs === 1) || (boundary === "seal-sync" && syncs === 2))) {
            throw new Error(`B-native-${boundary}`);
          }
          await nativeSync();
        };
        return opened;
      };
      fsp.unlink = async (file) => {
        if (file === markerPath && fail && boundary === "marker-unlink") throw new Error("B-native-marker-unlink");
        return originalUnlink(file);
      };
      syncBuiltinESMExports();
      if (boundary === "short-write") {
        result = await store.acknowledgeInterrupted(ref);
        assert.ok(writes > 2, "actual short native writes require progress loops");
      } else {
        await assert.rejects(store.acknowledgeInterrupted(ref), { message: `B-native-${boundary}` });
        assert.ok(await fs.lstat(markerPath));
        assert.equal((await fs.stat(envelope)).size, 8192);
        const faulted = await fs.readFile(envelope);
        assert.deepEqual(faulted.subarray(0, 2048), before.subarray(0, 2048));
        fail = false;
        writes = 0;
        syncs = 0;
        result = await store.acknowledgeInterrupted(ref);
        if (boundary !== "payload-sync") {
          assert.equal(writes, 0, "authoritative receipt must never be rewritten");
          assert.ok(syncs >= 1, "existing valid receipt must sync before marker cleanup");
          assert.deepEqual(await fs.readFile(envelope), faulted);
        }
      }
      assert.ok(peak > 0);
      assert.equal((await fs.lstat(envelope, { bigint: true })).ino, identity.ino);
      assert.deepEqual((await fs.readFile(envelope)).subarray(0, 2048), before.subarray(0, 2048));
      assert.equal((await store.inspect(ref)).incomplete, null);
      assert.equal((await fs.readdir(path.join(dir, "audit"))).filter((name) => name.endsWith(".record")).length, 1);
    } finally {
      fsp.open = originalOpen;
      fsp.unlink = originalUnlink;
      syncBuiltinESMExports();
      if (result) await result.release();
      await handle.release();
    }
  });
}

for (const corrupt of ["checksum", "seal-padding"]) {
  test(`B: sealed ${corrupt} corruption is refused without resetting receipt`, async (t) => {
    const { store, ref, dir } = await fixture(t);
    const handle = await store.acquireOwnership(ref);
    await handle.beginRound({ roundId: "sealed-corruption", intent: "continue" });
    await handle.release();
    const markerPath = path.join(dir, "incomplete.json");
    const marker = JSON.parse(await fs.readFile(markerPath, "utf8"));
    const envelope = path.join(dir, "audit", marker.recovery.name);
    const originalUnlink = fsp.unlink;
    try {
      fsp.unlink = async (file) => {
        if (file === markerPath) throw new Error("B-keep-marker");
        return originalUnlink(file);
      };
      syncBuiltinESMExports();
      await assert.rejects(store.acknowledgeInterrupted(ref), { message: "B-keep-marker" });
    } finally {
      fsp.unlink = originalUnlink;
      syncBuiltinESMExports();
    }
    const bytes = await fs.readFile(envelope);
    bytes[corrupt === "checksum" ? 2048 : 6271] ^= 1;
    await fs.writeFile(envelope, bytes);
    t.diagnostic(`sealed corruption target ${envelope}`);
    await assert.rejects(store.acknowledgeInterrupted(ref), (error) => error.code === "CORRUPT_RECORD");
    assert.deepEqual(await fs.readFile(envelope), bytes);
    assert.deepEqual(JSON.parse(await fs.readFile(markerPath, "utf8")), marker);
  });
}

for (const injected of [false, true]) {
  test(`A: ${injected ? "injected" : "native"} failed manifest ACK preserves candidate and permits different fresh snapshot`, async (t) => {
    const { root, ref, dir } = await fixture(t);
    let fault = false;
    const originalRename = fsp.rename;
    const store = openStore({ root, ...(injected ? { deps: { writeFileAtomic: async (file, bytes) => {
      if (fault && path.basename(file) === "store.json") throw new Error("A-manifest-refusal");
      await atomicReplaceFile(file, bytes);
    } } } : {}) });
    const handle = await store.acquireOwnership(ref);
    let successor;
    try {
      await handle.beginRound({ roundId: "failed-publication", intent: "continue" });
      const before = (await store.inspect(ref)).committed.snapshot;
      const snapshot = { ...before, revision: 1, parentRevision: 0, createdAt: before.createdAt + 1 };
      const priorRevision = await fs.readFile(path.join(dir, "revisions", "r0.json"));
      const final = path.join(dir, "revisions", "r1.json");
      t.diagnostic(`manifest fault ${JSON.stringify({ injected, final, manifest: path.join(dir, "store.json") })}`);
      if (!injected) {
        fsp.rename = async (source, destination) => {
          if (fault && destination === path.join(dir, "store.json")) throw new Error("A-manifest-refusal");
          return originalRename(source, destination);
        };
        syncBuiltinESMExports();
      }
      fault = true;
      await assert.rejects(handle.commitRevision({ expectedRevision: 0, snapshot }), { message: "A-manifest-refusal" });
      fault = false;
      fsp.rename = originalRename;
      syncBuiltinESMExports();
      const candidate = await fs.readFile(final);
      const native = await fs.lstat(final, { bigint: true });
      const interrupted = JSON.parse(await fs.readFile(path.join(dir, "incomplete.json"), "utf8"));
      assert.equal((await store.inspect(ref)).committed.revision, 0);
      await handle.release();
      successor = await store.acknowledgeInterrupted(ref);
      await successor.beginRound({ roundId: "different-fresh", intent: "continue" });
      await successor.commitRevision({ expectedRevision: 0, snapshot: { ...snapshot, createdAt: snapshot.createdAt + 1 } });
      assert.equal((await store.inspect(ref)).committed.revision, 1);
      const stage = path.join(dir, "revisions", interrupted.publication.stageName);
      assert.deepEqual(await fs.readFile(stage), candidate);
      assert.equal((await fs.lstat(stage, { bigint: true })).ino, native.ino);
      assert.deepEqual(await fs.readFile(path.join(dir, "revisions", "r0.json")), priorRevision);
      assert.notDeepEqual(await fs.readFile(final), candidate);
      const receiptBytes = await fs.readFile(path.join(dir, "audit", interrupted.recovery.name));
      const payload = receiptBytes.subarray(2048, 6144);
      const receipt = JSON.parse(payload.subarray(0, payload.indexOf(0)).toString("utf8"));
      assert.equal(receipt.publication.disposition, "unpublished");
      assert.equal(receipt.publication.proof.stageName, interrupted.publication.stageName);
    } finally {
      fsp.rename = originalRename;
      syncBuiltinESMExports();
      if (successor) await successor.release();
      await handle.release();
    }
  });
}

test("A: completed manifest marker cleanup failure surfaces and explicit ACK preserves committed inode", async (t) => {
  const { store, ref, dir } = await fixture(t);
  const handle = await store.acquireOwnership(ref);
  const originalRm = fsp.rm;
  const originalUnlink = fsp.unlink;
  const markerPath = path.join(dir, "incomplete.json");
  let acknowledged;
  try {
    await handle.beginRound({ roundId: "completed-cleanup", intent: "continue" });
    const prior = (await store.inspect(ref)).committed.snapshot;
    fsp.rm = async (file, ...args) => {
      if (file === markerPath) throw new Error("A-marker-cleanup-refusal");
      return originalRm(file, ...args);
    };
    fsp.unlink = async (file) => {
      if (file === markerPath) throw new Error("A-marker-cleanup-refusal");
      return originalUnlink(file);
    };
    syncBuiltinESMExports();
    t.diagnostic(`completed cleanup fault ${markerPath}`);
    await assert.rejects(handle.commitRevision({ expectedRevision: 0, snapshot: { ...prior, revision: 1, parentRevision: 0 } }), { message: "A-marker-cleanup-refusal" });
    fsp.rm = originalRm;
    fsp.unlink = originalUnlink;
    syncBuiltinESMExports();
    const final = path.join(dir, "revisions", "r1.json");
    const bytes = await fs.readFile(final);
    const identity = await fs.lstat(final, { bigint: true });
    assert.equal((await store.inspect(ref)).committed.revision, 1);
    await handle.release();
    acknowledged = await store.acknowledgeInterrupted(ref);
    assert.deepEqual(await fs.readFile(final), bytes);
    assert.equal((await fs.lstat(final, { bigint: true })).ino, identity.ino);
    assert.equal((await store.inspect(ref)).incomplete, null);
    assert.deepEqual((await fs.readdir(path.join(dir, "revisions"))).filter((name) => name.endsWith(".stage.tmp")), []);
  } finally {
    fsp.rm = originalRm;
    fsp.unlink = originalUnlink;
    syncBuiltinESMExports();
    if (acknowledged) await acknowledged.release();
    await handle.release();
  }
});

test("A: partial pre-proof stage with absent final ACKs as unverified preparation without losing bytes", async (t) => {
  const { root, ref, dir } = await fixture(t);
  let fail = true;
  const store = openStore({ root, deps: { writeFileAtomic: async (file, bytes) => {
    if (fail && file.endsWith(".stage.tmp")) {
      await fs.writeFile(file, "partial unverified bytes");
      throw new Error("A-pre-proof-stage-exit");
    }
    await atomicReplaceFile(file, bytes);
  } } });
  const handle = await store.acquireOwnership(ref);
  let acknowledged;
  try {
    await handle.beginRound({ roundId: "pre-proof", intent: "continue" });
    const prior = (await store.inspect(ref)).committed.snapshot;
    const snapshot = { ...prior, revision: 1, parentRevision: 0 };
    await assert.rejects(handle.commitRevision({ expectedRevision: 0, snapshot }), { message: "A-pre-proof-stage-exit" });
    fail = false;
    const marker = JSON.parse(await fs.readFile(path.join(dir, "incomplete.json"), "utf8"));
    assert.equal(marker.publication.identity, undefined);
    const stage = path.join(dir, "revisions", marker.publication.stageName);
    const partial = await fs.readFile(stage);
    const identity = await fs.lstat(stage, { bigint: true });
    t.diagnostic(`unverified partial stage ${stage}`);
    await handle.release();
    acknowledged = await store.acknowledgeInterrupted(ref);
    assert.deepEqual(await fs.readFile(stage), partial);
    assert.equal((await fs.lstat(stage, { bigint: true })).ino, identity.ino);
    const receipt = await fs.readFile(path.join(dir, "audit", marker.recovery.name));
    const payload = receipt.subarray(2048, 6144);
    assert.equal(JSON.parse(payload.subarray(0, payload.indexOf(0))).publication.disposition, "unverified-preparation");
    await acknowledged.beginRound({ roundId: "fresh-after-partial", intent: "continue" });
    await acknowledged.commitRevision({ expectedRevision: 0, snapshot: { ...snapshot, createdAt: snapshot.createdAt + 1 } });
    assert.deepEqual(await fs.readFile(stage), partial);
  } finally {
    if (acknowledged) await acknowledged.release();
    await handle.release();
  }
});

for (const boundary of ["before", "after"]) {
  test(`A: interruption ${boundary} unpublished-final unlink retains candidate and one exact disposition`, async (t) => {
    const { root, ref, dir } = await fixture(t);
    let failManifest = false;
    const store = openStore({ root, deps: { writeFileAtomic: async (file, bytes) => {
      if (failManifest && path.basename(file) === "store.json") throw new Error("A-manifest-disposition");
      await atomicReplaceFile(file, bytes);
    } } });
    const handle = await store.acquireOwnership(ref);
    const originalUnlink = fsp.unlink;
    let acknowledged;
    try {
      await handle.beginRound({ roundId: "disposition", intent: "continue" });
      const prior = (await store.inspect(ref)).committed.snapshot;
      failManifest = true;
      await assert.rejects(handle.commitRevision({ expectedRevision: 0, snapshot: { ...prior, revision: 1, parentRevision: 0 } }), { message: "A-manifest-disposition" });
      failManifest = false;
      const marker = JSON.parse(await fs.readFile(path.join(dir, "incomplete.json"), "utf8"));
      const stage = path.join(dir, "revisions", marker.publication.stageName);
      const final = path.join(dir, "revisions", "r1.json");
      const candidate = await fs.readFile(stage);
      const identity = await fs.lstat(stage, { bigint: true });
      const receiptPath = path.join(dir, "audit", marker.recovery.name);
      await handle.release();
      t.diagnostic(`disposition unlink fault ${JSON.stringify({ boundary, final, stage, receiptPath })}`);
      fsp.unlink = async (file) => {
        if (file === final) {
          if (boundary === "after") await originalUnlink(file);
          throw new Error(`A-disposition-${boundary}`);
        }
        return originalUnlink(file);
      };
      syncBuiltinESMExports();
      await assert.rejects(store.acknowledgeInterrupted(ref), { message: `A-disposition-${boundary}` });
      fsp.unlink = originalUnlink;
      syncBuiltinESMExports();
      const receipt = await fs.readFile(receiptPath);
      acknowledged = await store.acknowledgeInterrupted(ref);
      assert.deepEqual(await fs.readFile(receiptPath), receipt);
      assert.deepEqual(await fs.readFile(stage), candidate);
      assert.equal((await fs.lstat(stage, { bigint: true })).ino, identity.ino);
      await assert.rejects(fs.lstat(final), { code: "ENOENT" });
      assert.equal((await store.inspect(ref)).incomplete, null);
    } finally {
      fsp.unlink = originalUnlink;
      syncBuiltinESMExports();
      if (acknowledged) await acknowledged.release();
      await handle.release();
    }
  });
}

test("A: same-byte retry and successful-round orphan cleanup leave no redundant stages or pending envelopes", async (t) => {
  const { root, ref, dir } = await fixture(t);
  let fail = false;
  const store = openStore({ root, deps: { writeFileAtomic: async (file, bytes) => {
    if (fail && path.basename(file) === "store.json") throw new Error("A-retry-manifest");
    await atomicReplaceFile(file, bytes);
  } } });
  let handle = await store.acquireOwnership(ref);
  const originalUnlink = fsp.unlink;
  try {
    await handle.beginRound({ roundId: "same-byte", intent: "continue" });
    const prior = (await store.inspect(ref)).committed.snapshot;
    const snapshot = { ...prior, revision: 1, parentRevision: 0 };
    fail = true;
    await assert.rejects(handle.commitRevision({ expectedRevision: 0, snapshot }), { message: "A-retry-manifest" });
    fail = false;
    const marker = JSON.parse(await fs.readFile(path.join(dir, "incomplete.json"), "utf8"));
    const envelope = path.join(dir, "audit", marker.recovery.name);
    const candidate = await fs.lstat(path.join(dir, "revisions", "r1.json"), { bigint: true });
    fsp.unlink = async (file) => {
      if (file === envelope) throw new Error("A-post-marker-envelope-exit");
      return originalUnlink(file);
    };
    syncBuiltinESMExports();
    t.diagnostic(`post-marker reservation cleanup fault ${envelope}`);
    await assert.rejects(handle.commitRevision({ expectedRevision: 0, snapshot }), { message: "A-post-marker-envelope-exit" });
    fsp.unlink = originalUnlink;
    syncBuiltinESMExports();
    assert.equal((await fs.lstat(path.join(dir, "revisions", "r1.json"), { bigint: true })).ino, candidate.ino);
    assert.equal((await store.inspect(ref)).incomplete, null);
    await handle.release();
    handle = await store.acquireOwnership(ref);
    await handle.beginRound({ roundId: "orphan-cleanup", intent: "continue" });
    await assert.rejects(fs.lstat(envelope), { code: "ENOENT" });
    await handle.commitRevision({ expectedRevision: 1, snapshot: { ...snapshot, revision: 2, parentRevision: 1 } });
    assert.deepEqual((await fs.readdir(path.join(dir, "audit"))).filter((name) => name.endsWith(".record")), []);
    assert.deepEqual((await fs.readdir(path.join(dir, "revisions"))).filter((name) => name.endsWith(".stage.tmp")), []);
  } finally {
    fsp.unlink = originalUnlink;
    syncBuiltinESMExports();
    await handle.release();
  }
});

for (const injected of [false, true]) {
  test(`A: ${injected ? "injected" : "native"} equal-byte foreign final inode is never adopted or deleted`, async (t) => {
    const { root, ref, dir } = await fixture(t);
    const final = path.join(dir, "revisions", "r1.json");
    let conflict;
    let armed = false;
    const originalLink = fsp.link;
    const placeForeign = async (bytes) => {
      await fs.writeFile(final, bytes, { flag: "wx" });
      conflict = { bytes: await fs.readFile(final), stat: await fs.lstat(final, { bigint: true }) };
    };
    const store = openStore({ root, ...(injected ? { deps: { writeFileAtomic: async (file, bytes) => {
      if (armed && file.endsWith(".stage.tmp")) await placeForeign(bytes);
      await atomicReplaceFile(file, bytes);
    } } } : {}) });
    const handle = await store.acquireOwnership(ref);
    try {
      await handle.beginRound({ roundId: "foreign-inode", intent: "continue" });
      const prior = (await store.inspect(ref)).committed.snapshot;
      const oldPath = path.join(dir, "revisions", "r0.json");
      const old = { bytes: await fs.readFile(oldPath), stat: await fs.lstat(oldPath, { bigint: true }) };
      t.diagnostic(`foreign no-clobber path ${final}`);
      if (!injected) {
        fsp.link = async (source, destination) => {
          if (armed && destination === final) await placeForeign(await fs.readFile(source));
          return originalLink(source, destination);
        };
        syncBuiltinESMExports();
      }
      armed = true;
      await assert.rejects(handle.commitRevision({ expectedRevision: 0, snapshot: { ...prior, revision: 1, parentRevision: 0 } }), (error) => error.code === "CORRUPT_CONTENT");
      armed = false;
      fsp.link = originalLink;
      syncBuiltinESMExports();
      await handle.release();
      await assert.rejects(store.acknowledgeInterrupted(ref), (error) => error.code === "CORRUPT_CONTENT");
      assert.deepEqual(await fs.readFile(final), conflict.bytes);
      assert.equal((await fs.lstat(final, { bigint: true })).ino, conflict.stat.ino);
      assert.deepEqual(await fs.readFile(oldPath), old.bytes);
      assert.equal((await fs.lstat(oldPath, { bigint: true })).ino, old.stat.ino);
      assert.equal((await store.inspect(ref)).committed.revision, 0);
    } finally {
      fsp.link = originalLink;
      syncBuiltinESMExports();
      await handle.release();
    }
  });
}

test("A: insufficient full publication peak refuses before changing marker or creating stage", async (t) => {
  const cap = 100000;
  const { root, store, ref, dir } = await fixture(t, { caps: { recordMaxBytes: cap, storeMaxBytes: cap } });
  const handle = await store.acquireOwnership(ref);
  try {
    await handle.beginRound({ roundId: "peak-refusal", intent: "continue" });
    await handle.settleRound("peak-refusal", { status: "partial", measured: { searches: 0, reads: 0, judgments: 0 }, uncertainty: null });
    const prior = (await store.inspect(ref)).committed.snapshot;
    const snapshot = { ...prior, revision: 1, parentRevision: 0, audit: Array.from({ length: 8 }, () => ({ at: 1, kind: "retained", detail: "x".repeat(2048) })) };
    const snapshotBytes = Buffer.byteLength(JSON.stringify(snapshot));
    const headroom = snapshotBytes + 1024;
    const ballast = path.join(dir, "ballast");
    await fs.writeFile(ballast, Buffer.alloc(cap - headroom - await treeBytes(root)));
    const markerPath = path.join(dir, "incomplete.json");
    const marker = await fs.readFile(markerPath);
    const before = await treeBytes(root);
    t.diagnostic(`publication peak refusal ${JSON.stringify({ markerPath, cap, before, headroom, snapshotBytes })}`);
    await assert.rejects(handle.commitRevision({ expectedRevision: 0, snapshot }), (error) => error.code === "STORE_CAPACITY");
    assert.deepEqual(await fs.readFile(markerPath), marker);
    assert.equal(await treeBytes(root), before);
    assert.deepEqual((await fs.readdir(path.join(dir, "revisions"))).sort(), ["r0.json"]);
  } finally { await handle.release(); }
});

test("A: settled publication-outstanding full-cap ACK retains native peaks and real sibling bytes", async (t) => {
  const caps = { recordMaxBytes: 200000, storeMaxBytes: 300000 };
  const { root, store, ref, dir } = await fixture(t, { caps });
  const { investigationRef: siblingRef } = await store.createInvestigation({ requirements: REQUIREMENTS });
  const siblingDir = path.join(root, "investigations", siblingRef);
  const sibling = await store.acquireOwnership(siblingRef);
  const handle = await store.acquireOwnership(ref);
  const originalOpen = fsp.open;
  const originalLink = fsp.link;
  const originalRename = fsp.rename;
  let peak = 0;
  let nativeWrites = 0;
  let linkedBytes = 0;
  let acknowledged;
  try {
    await sibling.beginRound({ roundId: "sibling-fill", intent: "continue" });
    await handle.beginRound({ roundId: "publication-full", intent: "continue" });
    await handle.settleRound("publication-full", { status: "partial", measured: { searches: 0, reads: 0, judgments: 0 }, uncertainty: null });
    const snapshot = { ...(await store.inspect(ref)).committed.snapshot, revision: 1, parentRevision: 0 };
    const final = path.join(dir, "revisions", "r1.json");
    const observe = async () => {
      const bytes = await treeBytes(root);
      peak = Math.max(peak, bytes);
      assert.ok(bytes <= caps.storeMaxBytes);
      assert.ok(await treeBytes(dir) <= caps.recordMaxBytes);
    };
    fsp.open = async (file, ...args) => {
      const opened = await originalOpen(file, ...args);
      if (!String(file).startsWith(root + path.sep)) return opened;
      for (const method of ["write", "writeFile"]) {
        const native = opened[method].bind(opened);
        opened[method] = async (...values) => {
          const result = await native(...values);
          nativeWrites += 1;
          await observe();
          return result;
        };
      }
      return opened;
    };
    fsp.link = async (source, destination) => {
      const before = await treeBytes(root);
      if (destination === final) {
        const marker = JSON.parse(await fs.readFile(path.join(dir, "incomplete.json"), "utf8"));
        assert.equal(marker.publication.identity.inode, (await fs.lstat(source, { bigint: true })).ino.toString());
      }
      await originalLink(source, destination);
      if (destination === final) {
        linkedBytes = (await fs.stat(source)).size;
        assert.equal(await treeBytes(root) - before, linkedBytes, "walker must charge a second full hardlink entry");
      }
      await observe();
    };
    fsp.rename = async (source, destination) => {
      if (destination === path.join(dir, "store.json")) throw new Error("A-full-cap-manifest");
      return originalRename(source, destination);
    };
    syncBuiltinESMExports();
    t.diagnostic(`native publication peak fixture ${JSON.stringify({ dir, final, caps })}`);
    await assert.rejects(handle.commitRevision({ expectedRevision: 0, snapshot }), { message: "A-full-cap-manifest" });
    fsp.rename = originalRename;
    syncBuiltinESMExports();
    const marker = JSON.parse(await fs.readFile(path.join(dir, "incomplete.json"), "utf8"));
    const stage = path.join(dir, "revisions", marker.publication.stageName);
    const candidate = await fs.readFile(stage);
    const identity = await fs.lstat(stage, { bigint: true });
    await handle.release();
    await fs.writeFile(path.join(dir, "ballast"), Buffer.alloc(caps.recordMaxBytes - await treeBytes(dir)));
    const fill = path.join(siblingDir, "fill");
    const fillBytes = Buffer.alloc(caps.storeMaxBytes - await treeBytes(root), 101);
    await store.admittedWrite(siblingDir, fill, fillBytes, { chargeBytes: fillBytes.length, rollback: { kind: "created" } }, "sibling consumes all remaining publication headroom");
    assert.equal(await treeBytes(root), caps.storeMaxBytes);
    acknowledged = await store.acknowledgeInterrupted(ref);
    assert.deepEqual(await fs.readFile(stage), candidate);
    assert.equal((await fs.lstat(stage, { bigint: true })).ino, identity.ino);
    assert.deepEqual(await fs.readFile(fill), fillBytes);
    assert.equal((await store.inspect(ref)).committed.revision, 0);
    assert.equal((await store.inspect(ref)).incomplete, null);
    assert.ok(nativeWrites > 0 && linkedBytes > 0 && peak > 0);
    assert.equal(peak, caps.storeMaxBytes);
  } finally {
    fsp.open = originalOpen;
    fsp.link = originalLink;
    fsp.rename = originalRename;
    syncBuiltinESMExports();
    if (acknowledged) await acknowledged.release();
    await handle.release();
    await sibling.release();
  }
});

test("B: legacy marker and caller ACK-looking row remain informational while reused labels get exact distinct receipts", async (t) => {
  const { store, ref, dir } = await fixture(t);
  let handle = await store.acquireOwnership(ref);
  const roundId = "reused-label";
  try {
    await handle.beginRound({ roundId, intent: "continue" });
    const markerPath = path.join(dir, "incomplete.json");
    const marker = JSON.parse(await fs.readFile(markerPath, "utf8"));
    await handle.appendAudit({ at: 1, kind: "acknowledge-interrupted", detail: JSON.stringify({ roundId, priorOwner: marker.ownerId, revisionBase: 0, remoteWork: "unknown" }) });
    const auditPath = path.join(dir, "audit", `round-${roundId}.json`);
    const ordinary = await fs.readFile(auditPath);
    await handle.release();
    // A genuine old-format fixture has no native envelope binding/allocation.
    await fs.unlink(path.join(dir, "audit", marker.recovery.name));
    delete marker.recovery;
    await fs.writeFile(markerPath, JSON.stringify(marker));
    t.diagnostic(`legacy informational audit ${auditPath}`);
    handle = await store.acknowledgeInterrupted(ref);
    await handle.beginRound({ roundId, intent: "continue" });
    const second = JSON.parse(await fs.readFile(markerPath, "utf8"));
    assert.notEqual(second.ownerId, marker.ownerId);
    await handle.release();
    handle = await store.acknowledgeInterrupted(ref);
    assert.deepEqual(await fs.readFile(auditPath), ordinary);
    const names = (await fs.readdir(path.join(dir, "audit"))).filter((name) => /^ack-[0-9a-f]{64}\.record$/.test(name));
    assert.equal(names.length, 2);
    const owners = [];
    for (const name of names) {
      const slot = (await fs.readFile(path.join(dir, "audit", name))).subarray(2048, 6144);
      owners.push(JSON.parse(slot.subarray(0, slot.indexOf(0))).priorOwner);
    }
    assert.deepEqual(owners.sort(), [marker.ownerId, second.ownerId].sort());
  } finally { await handle.release(); }
});

test("B: overbound legacy audit refuses ACK without resetting retained bytes", async (t) => {
  const { store, ref, dir } = await fixture(t);
  const handle = await store.acquireOwnership(ref);
  await handle.beginRound({ roundId: "overbound", intent: "continue" });
  await handle.release();
  const file = path.join(dir, "audit", "round-overbound.json");
  const bytes = Buffer.alloc(SNAPSHOT_MAX_BYTES + 1, 32);
  await fs.writeFile(file, bytes);
  t.diagnostic(`overbound audit refusal ${file}`);
  await assert.rejects(store.acknowledgeInterrupted(ref), (error) => error.code === "CORRUPT_RECORD");
  assert.deepEqual(await fs.readFile(file), bytes);
  assert.ok(await fs.lstat(path.join(dir, "incomplete.json")));
});

test("B: pre-marker reservation failure is cleaned under ownership before a fresh successful round", async (t) => {
  const { root, ref, dir } = await fixture(t);
  let fail = true;
  const store = openStore({ root, deps: { writeFileAtomic: async (file, bytes) => {
    if (fail && path.basename(file) === "incomplete.json") throw new Error("B-pre-marker-refusal");
    await atomicReplaceFile(file, bytes);
  } } });
  const handle = await store.acquireOwnership(ref);
  try {
    await assert.rejects(handle.beginRound({ roundId: "aborted-prepare", intent: "continue" }), { message: "B-pre-marker-refusal" });
    const pending = (await fs.readdir(path.join(dir, "audit"))).filter((name) => name.endsWith(".record"));
    assert.equal(pending.length, 1);
    assert.equal((await fs.stat(path.join(dir, "reserve.settlement"))).size, SETTLEMENT_RESERVE_BYTES);
    assert.equal((await store.inspect(ref)).incomplete, null);
    fail = false;
    await handle.beginRound({ roundId: "fresh-preparation", intent: "continue" });
    await assert.rejects(fs.lstat(path.join(dir, "audit", pending[0])), { code: "ENOENT" });
    const prior = (await store.inspect(ref)).committed.snapshot;
    await handle.commitRevision({ expectedRevision: 0, snapshot: { ...prior, revision: 1, parentRevision: 0 } });
    assert.deepEqual((await fs.readdir(path.join(dir, "audit"))).filter((name) => name.endsWith(".record")), []);
  } finally { await handle.release(); }
});

test("A: foreign malformed orphan reservation and unproven final preserve fail-closed evidence", async (t) => {
  const { store, ref, dir } = await fixture(t);
  let handle = await store.acquireOwnership(ref);
  const foreign = path.join(dir, "audit", `ack-${"0".repeat(64)}.record`);
  await fs.mkdir(path.dirname(foreign), { recursive: true });
  const foreignBytes = Buffer.from("foreign malformed reservation");
  await fs.writeFile(foreign, foreignBytes);
  const identity = await fs.lstat(foreign, { bigint: true });
  try {
    await assert.rejects(handle.beginRound({ roundId: "foreign-orphan", intent: "continue" }), (error) => error.code === "CORRUPT_RECORD");
    assert.deepEqual(await fs.readFile(foreign), foreignBytes);
    assert.equal((await fs.lstat(foreign, { bigint: true })).ino, identity.ino);
    // Remove only this test-created malformed fixture to prepare the distinct
    // ordinary legacy/unproven-final witness in the same owned root.
    await fs.unlink(foreign);
    await handle.beginRound({ roundId: "legacy-unproven", intent: "continue" });
    const markerPath = path.join(dir, "incomplete.json");
    const marker = JSON.parse(await fs.readFile(markerPath, "utf8"));
    const final = path.join(dir, "revisions", "r1.json");
    await fs.writeFile(final, "foreign preplaced final");
    const bytes = await fs.readFile(final);
    const stat = await fs.lstat(final, { bigint: true });
    await handle.release();
    await assert.rejects(store.acknowledgeInterrupted(ref), (error) => error.code === "CORRUPT_RECORD");
    assert.deepEqual(JSON.parse(await fs.readFile(markerPath, "utf8")), marker);
    assert.deepEqual(await fs.readFile(final), bytes);
    assert.equal((await fs.lstat(final, { bigint: true })).ino, stat.ino);
  } finally { await handle.release(); }
});

test("B: recovery publication temp cleanup failure cannot report a successful begin", async (t) => {
  const { store, ref, dir } = await fixture(t);
  const handle = await store.acquireOwnership(ref);
  const originalUnlink = fsp.unlink;
  let intercepted = 0;
  try {
    fsp.unlink = async (file) => {
      if (path.dirname(file) === path.join(dir, "audit") && path.basename(file).startsWith(".ack-") && file.endsWith(".tmp")) {
        intercepted += 1;
        t.diagnostic(`owned recovery staging cleanup fault ${file}`);
        throw new Error("B-envelope-temp-cleanup");
      }
      return originalUnlink(file);
    };
    syncBuiltinESMExports();
    await assert.rejects(handle.beginRound({ roundId: "envelope-cleanup", intent: "continue" }), { message: "B-envelope-temp-cleanup" });
    assert.equal(intercepted, 1);
    assert.equal((await store.inspect(ref)).incomplete, null);
  } finally {
    fsp.unlink = originalUnlink;
    syncBuiltinESMExports();
    await handle.release();
  }
});

test("manifest: invalid JSON refuses typed corruption before round retention; release permits deletion", async (t) => {
  const { store, ref, dir } = await fixture(t);
  const handle = await store.acquireOwnership(ref);
  const manifest = path.join(dir, "store.json");
  const corrupt = Buffer.from("{ invalid manifest JSON");
  t.diagnostic(`invalid JSON manifest fixture ${manifest}`);
  try {
    await fs.writeFile(manifest, corrupt);
    const inspection = await store.inspect(ref);
    assert.equal(inspection.committed, null);
    assert.equal(typeof inspection.damage, "string");
    let failure;
    try { await handle.beginRound({ roundId: "corrupt-manifest", intent: "continue" }); }
    catch (error) { failure = error; }
    for (const name of ["incomplete.json", "reserve.settlement"]) {
      await assert.rejects(fs.lstat(path.join(dir, name)), { code: "ENOENT" });
    }
    const audit = await fs.readdir(path.join(dir, "audit")).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    assert.deepEqual(audit, [], "no recovery envelope or staging bytes may be published");
    assert.deepEqual(await fs.readFile(manifest), corrupt);
    assert.equal(failure?.name, "CorruptRecordError");
    assert.equal(failure.code, "CORRUPT_RECORD");
  } finally {
    await handle.release();
    assert.deepEqual(await store.deleteInvestigation(ref), { deleted: true });
    await assert.rejects(fs.lstat(dir), { code: "ENOENT" });
  }
});
