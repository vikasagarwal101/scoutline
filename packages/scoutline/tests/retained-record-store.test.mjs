/**
 * Retained investigation record store — hermetic real-fs tests.
 * Ticket: unified-investigation/caller-assisted-engine/tickets/retained-records
 *
 * Runs against the compiled package (build first). Every case uses the
 * actual native fs/abstract-socket interfaces and exact outcomes; no fake
 * counters, no permissive assertions. Store roots live under os.tmpdir() so
 * the test-isolation write guard passes.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import fsp from "node:fs/promises";
import { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";

import {
  openStore,
  StoreCapacityError,
  OwnerBusyError,
  ExpectedRevisionError,
  CorruptRecordError,
  CorruptContentError,
  InvalidReferenceError,
  InvalidRecordInputError,
  UnacknowledgedInterruptionError,
  DeletionIncompleteError,
  BODY_MAX_BYTES,
} from "../dist/lib/retained-record-store.js";
import { atomicReplaceFile } from "../dist/lib/config-store.js";

const REQUIREMENTS = {
  schemaVersion: 1,
  fields: {
    csv_support: { definition: "Does the tool support CSV export?", required: true },
  },
};

// Every helper-created root is registered for failure-safe cleanup: the
// after-hook removes exactly the directories this run created (native
// children settled first), never pre-existing owner tmp trees.
const ownedRoots = new Set();
const activeChildren = new Set();
const trackedSpawn = (...args) => {
  const child = spawn(...args);
  activeChildren.add(child);
  child.once("exit", () => activeChildren.delete(child));
  return child;
};
function tempRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), "rrs-")).then((p) => {
    ownedRoots.add(p);
    return p;
  });
}
const cleanupFailures = [];
test.after(async () => {
  // Native children (spawned writers) must exit before their trees vanish.
  for (const child of activeChildren) {
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve) => {
        child.once("exit", resolve); // observe before signaling, including stopped children
        child.kill("SIGKILL");
      });
    }
  }
  // Attempt EVERY owned root; a genuine deletion failure must surface and
  // fail the suite (reported per-root) rather than pass green with leaked
  // test trees. test.after failures add to — never replace — body failures.
  for (const root of ownedRoots) {
    try {
      await fs.rm(root, { recursive: true, force: true });
    } catch (error) {
      cleanupFailures.push(`${root}: ${error?.message ?? error}`);
    }
  }
  if (cleanupFailures.length > 0) {
    throw new Error(
      `temp-root cleanup failed for ${cleanupFailures.length}/${ownedRoots.size} owned roots:\n` +
        cleanupFailures.join("\n"),
    );
  }
});

async function created(root) {
  const store = openStore({ root });
  const { investigationRef, revision } = await store.createInvestigation({
    requirements: REQUIREMENTS,
  });
  return { store, ref: investigationRef, revision };
}

function snapshotFor(store, ref, revision, requirementsDigest, bodies = [], rounds = []) {
  return {
    schemaVersion: 1,
    revision,
    parentRevision: revision - 1,
    createdAt: Date.now(),
    requirementsDigest,
    bodies,
    rounds,
    audit: [],
  };
}

// Frozen recovery framing: 2048-byte header, 4096-byte payload, 128-byte
// length/hash seal, padded to 8192. This independent reader never calls the
// production parser; an allocated/name-matching pending file is not a receipt.
function recoveryFile(dir, marker) {
  const tupleHash = createHash("sha256")
    .update(JSON.stringify([marker.roundId, marker.ownerId, marker.revisionBase])).digest("hex");
  const name = `ack-${tupleHash}.record`;
  assert.equal(marker.recovery.name, name);
  return path.join(dir, "audit", name);
}

function verifyRecovery(bytes, marker, sealed) {
  assert.equal(bytes.length, 8192);
  const field = (slot) => {
    const end = slot.indexOf(0);
    assert.ok(end >= 0 && slot.subarray(end).every((byte) => byte === 0), "invalid framing padding");
    return JSON.parse(slot.subarray(0, end).toString("utf8"));
  };
  assert.deepEqual(field(bytes.subarray(0, 2048)), {
    schemaVersion: 1, kind: "ack-recovery", roundId: marker.roundId,
    priorOwner: marker.ownerId, revisionBase: marker.revisionBase, reserveBytes: 8192,
  });
  const sealSlot = bytes.subarray(6144, 6272);
  if (!sealed) {
    assert.ok(sealSlot.every((byte) => byte === 0), "pending recovery unexpectedly sealed");
    return;
  }
  assert.ok(sealSlot.some((byte) => byte !== 0), "sealed recovery receipt missing seal");
  const seal = field(sealSlot);
  assert.deepEqual(Object.keys(seal).sort(), ["bytes", "digest"]);
  assert.ok(Number.isInteger(seal.bytes) && seal.bytes > 0 && seal.bytes <= 4096);
  assert.match(seal.digest, /^[0-9a-f]{64}$/);
  const payload = bytes.subarray(2048, 2048 + seal.bytes);
  assert.equal(createHash("sha256").update(payload).digest("hex"), seal.digest);
  assert.ok(bytes.subarray(2048 + seal.bytes, 6144).every((byte) => byte === 0));
  assert.ok(bytes.subarray(6272).every((byte) => byte === 0));
  const receipt = JSON.parse(payload.toString("utf8"));
  const { at, ...identity } = receipt;
  assert.ok(Number.isFinite(at) && at >= 0);
  assert.deepEqual(identity, {
    schemaVersion: 2, kind: "acknowledge-interrupted", publicationState: "unpublished",
    work: { schemaVersion: 1, measured: null, status: null, settledAt: null, unavailableReason: "unsettled" }, roundId: marker.roundId,
    priorOwner: marker.ownerId, revisionBase: marker.revisionBase, remoteWork: "unknown",
  });
}

async function recordBytes(dir) {
  let bytes = 0;
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    bytes += entry.isDirectory() ? await recordBytes(file) : (await fs.stat(file)).size;
  }
  return bytes; // counts each hardlink entry, matching actual physical admission
}

// Observe real native writes/link peaks in ONLY this owned cap fixture. No
// synthetic counters, sibling dispatch, admission hooks or production edits.
async function observeRecordPeak(dir, action) {
  const originals = { open: fsp.open, writeFile: fsp.writeFile, link: fsp.link };
  let peak = await recordBytes(dir), recoveryLinkPeak = 0;
  const owned = (file) => String(file).startsWith(dir + path.sep);
  const observe = async () => { peak = Math.max(peak, await recordBytes(dir)); };
  fsp.writeFile = async function (file, ...args) {
    const result = await originals.writeFile.call(this, file, ...args);
    if (owned(file)) await observe();
    return result;
  };
  fsp.link = async function (from, to) {
    const result = await originals.link.call(this, from, to);
    if (owned(to)) {
      await observe();
      if (String(to).endsWith(".record")) recoveryLinkPeak = await recordBytes(dir);
    }
    return result;
  };
  fsp.open = async function (file, ...args) {
    const handle = await originals.open.call(this, file, ...args);
    if (!owned(file)) return handle;
    return new Proxy(handle, { get(target, key) {
      const value = Reflect.get(target, key, target);
      if (key === "write" || key === "writeFile") return async (...params) => {
        const result = await value.apply(target, params);
        await observe();
        return result;
      };
      return typeof value === "function" ? value.bind(target) : value;
    } });
  };
  syncBuiltinESMExports();
  try { await action(); return { peak, recoveryLinkPeak }; }
  finally { Object.assign(fsp, originals); syncBuiltinESMExports(); }
}

// ---------------------------------------------------------------------------
// create / inspect / readBody — positive controls
// ---------------------------------------------------------------------------

test("create persists verifiable revision 0 and inspect round-trips it", async () => {
  const root = await tempRoot();
  const { store, ref } = await created(root);
  const insp = await store.inspect(ref);
  assert.equal(insp.ownership, "free");
  assert.equal(insp.committed.revision, 0);
  assert.equal(insp.committed.snapshot.schemaVersion, 1);
  assert.equal(insp.committed.verified, true);
  assert.equal(insp.incomplete, null);
  assert.equal(insp.damage, undefined);
});

test("reopen across separate store instances sees the same committed revision", async () => {
  const root = await tempRoot();
  const { ref } = await created(root);
  const second = openStore({ root }); // fresh instance = separate invocation
  const insp = await second.inspect(ref);
  assert.equal(insp.committed.revision, 0);
});

test("readBody returns retained bytes and re-hashes on read", async () => {
  const root = await tempRoot();
  const content = "evidence body one";
  const store = openStore({ root });
  const { investigationRef } = await store.createInvestigation({
    requirements: REQUIREMENTS,
    bodies: [{ label: "doc", content }],
  });
  const insp = await store.inspect(investigationRef);
  const bodyId = insp.committed.snapshot.bodies[0].bodyId;
  const buf = await store.readBody(investigationRef, bodyId);
  assert.equal(buf.toString("utf8"), content);
  // digest substitution on disk is detected on read
  const hex = bodyId.slice(2);
  await fs.writeFile(path.join(root, "investigations", investigationRef, "bodies", `${hex}.bin`), "tampered");
  await assert.rejects(() => store.readBody(investigationRef, bodyId), CorruptContentError);
});

// ---------------------------------------------------------------------------
// Validation / references
// ---------------------------------------------------------------------------

test("traversal and malformed refs are rejected", async () => {
  const root = await tempRoot();
  const { store } = await created(root);
  await assert.rejects(() => store.inspect("../evil"), InvalidReferenceError);
  await assert.rejects(() => store.inspect("inv_NOTHEX"), InvalidReferenceError);
  await assert.rejects(() => store.inspect("inv_" + "a".repeat(33)), InvalidReferenceError);
  await assert.rejects(() => store.readBody("inv_" + "0".repeat(32), "b:xyz"), InvalidReferenceError);
});

test("symlinked record directory is refused", async () => {
  const root = await tempRoot();
  const { store, ref } = await created(root);
  const outside = await tempRoot(); // "caller file" outside the owned root
  await fs.writeFile(path.join(outside, "caller.txt"), "caller data");
  // replace the record dir with a symlink to outside
  const dir = path.join(root, "investigations", ref);
  const stolen = path.join(root, "investigations", `${ref}.stolen`);
  await fs.rename(dir, stolen);
  await fs.symlink(outside, dir);
  await assert.rejects(() => store.inspect(ref), InvalidReferenceError);
  await assert.rejects(() => store.deleteInvestigation(ref), InvalidReferenceError);
  // caller file untouched
  assert.equal((await fs.readFile(path.join(outside, "caller.txt"), "utf8")), "caller data");
});

test("body over 16KiB is refused without partial accept", async () => {
  const root = await tempRoot();
  const store = openStore({ root });
  const countComplete = async () => {
    const entries = await fs.readdir(path.join(root, "investigations")).catch(() => []);
    let n = 0;
    for (const entry of entries) {
      const has = await fs
        .stat(path.join(root, "investigations", entry, "store.json"))
        .then(() => true)
        .catch(() => false);
      if (has) n += 1;
    }
    return n;
  };
  assert.equal(await countComplete(), 0); // baseline: nothing yet
  const big = "x".repeat(BODY_MAX_BYTES + 1);
  await assert.rejects(
    () => store.createInvestigation({ requirements: REQUIREMENTS, bodies: [{ content: big }] }),
    InvalidRecordInputError,
  );
  assert.equal(await countComplete(), 0); // refusal left no complete record
});

test("malformed requirements are refused", async () => {
  const root = await tempRoot();
  const store = openStore({ root });
  await assert.rejects(
    () => store.createInvestigation({ requirements: { schemaVersion: 2, fields: {} } }),
    InvalidRecordInputError,
  );
  await assert.rejects(
    () => store.createInvestigation({ requirements: { schemaVersion: 1, fields: {} } }),
    InvalidRecordInputError,
  );
});

// ---------------------------------------------------------------------------
// Ownership: live holder, concurrent contender, release
// ---------------------------------------------------------------------------

test("second acquire while live is refused; inspect shows live-owner; release frees", async () => {
  const root = await tempRoot();
  const { store, ref } = await created(root);
  const handle = await store.acquireOwnership(ref);
  const insp = await store.inspect(ref);
  assert.equal(insp.ownership, "live-owner");
  // read-only inspection of committed state still works during activity
  assert.equal(insp.committed.revision, 0);
  const contender = openStore({ root });
  await assert.rejects(() => contender.acquireOwnership(ref), OwnerBusyError);
  // deletion refused while live
  await assert.rejects(() => contender.deleteInvestigation(ref), OwnerBusyError);
  await handle.release();
  const after = await store.inspect(ref);
  assert.equal(after.ownership, "free");
});

test("cross-process live holder blocks contender; kernel releases on exit; successor takes over", async () => {
  const root = await tempRoot();
  const { store, ref } = await created(root);
  const dir = path.join(root, "investigations", ref);
  const child = trackedSpawn(
    process.execPath,
    ["-e", `
      const net = require("node:net");
      const crypto = require("node:crypto");
      const p = ${JSON.stringify(dir)};
      const h = crypto.createHash("sha256").update("owner:" + p).digest("hex").slice(0, 48);
      const srv = net.createServer(() => {});
      srv.listen({ path: "\\0zai-rrs-owner-" + h }, () => console.log("held"));
      setInterval(() => {}, 1000);
    `],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  child.stdout.resume();
  // wait until the child holds the gate
  const t0 = Date.now();
  for (;;) {
    const insp = await store.inspect(ref);
    if (insp.ownership === "live-owner") break;
    if (Date.now() - t0 > 10_000) assert.fail("child never acquired ownership");
    await new Promise((r) => setTimeout(r, 50));
  }
  await assert.rejects(() => store.acquireOwnership(ref), OwnerBusyError);
  await assert.rejects(() => store.deleteInvestigation(ref), OwnerBusyError);
  // kill holder → kernel releases → successor acquires
  child.kill("SIGKILL");
  await new Promise((r) => setTimeout(r, 300));
  const handle = await store.acquireOwnership(ref);
  await handle.release();
});

test("SIGSTOP'd holder remains owner past any nominal stale age", async () => {
  const root = await tempRoot();
  const { store, ref } = await created(root);
  const dir = path.join(root, "investigations", ref);
  // child acquires ownership THROUGH the real store API, then parks.
  const child = trackedSpawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
      import { openStore } from ${JSON.stringify(new URL("../dist/lib/retained-record-store.js", import.meta.url).href)};
      const handle = await openStore({ root: ${JSON.stringify(root)} }).acquireOwnership(${JSON.stringify(ref)});
      console.log("held");
      setInterval(() => {}, 1000);
    `,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  child.stdout.resume();
  const t0 = Date.now();
  for (;;) {
    const i = await store.inspect(ref);
    if (i.ownership === "live-owner") break;
    if (Date.now() - t0 > 10_000) assert.fail("child never held gate");
    await new Promise((r) => setTimeout(r, 50));
  }
  child.kill("SIGSTOP");
  await new Promise((r) => setTimeout(r, 400));
  const insp = await store.inspect(ref);
  assert.equal(insp.ownership, "live-owner"); // suspended holder is live
  await assert.rejects(() => store.acquireOwnership(ref), OwnerBusyError);
  await assert.rejects(() => store.deleteInvestigation(ref), OwnerBusyError);
  child.kill("SIGCONT");
  child.kill("SIGKILL");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await store.inspect(ref)).ownership, "free");
});

// ---------------------------------------------------------------------------
// Rounds, staging, commit
// ---------------------------------------------------------------------------

async function commitRoundOne(store, ref) {
  const handle = await store.acquireOwnership(ref);
  await handle.beginRound({ roundId: "r1", intent: "start" });
  const staged = await handle.stageBody("retained round-one body");
  await handle.appendAudit({ at: Date.now(), kind: "dispatch", detail: "search x1" });
  await handle.settleRound("r1", {
    status: "complete",
    measured: { searches: 1, reads: 0, judgments: 0 },
    uncertainty: null,
  });
  const insp0 = await store.inspect(ref);
  const digest = insp0.committed.snapshot.requirementsDigest;
  const snap = snapshotFor(store, ref, 1, digest, [
    { bodyId: staged.bodyId, digest: `sha256:${staged.bodyId.slice(2)}`, bytes: staged.bytes },
  ], [{ roundId: "r1", intent: "start", settledAt: Date.now(), usage: { searches: 1, reads: 0, judgments: 0 } }]);
  const { revision } = await handle.commitRevision({ expectedRevision: 0, snapshot: snap });
  await handle.release();
  return { revision, bodyId: staged.bodyId };
}

test("full round: marker first, staged body, settle, commit revision 1, reopen", async () => {
  const root = await tempRoot();
  const { store, ref } = await created(root);
  // marker is discoverable BEFORE commit: begin round then inspect
  const handle = await store.acquireOwnership(ref);
  await handle.beginRound({ roundId: "r1", intent: "start" });
  const mid = await store.inspect(ref);
  assert.equal(mid.incomplete.roundId, "r1");
  assert.equal(mid.incomplete.intent, "start");
  assert.equal(mid.incomplete.settled, false);
  const dir = path.join(root, "investigations", ref);
  const marker = JSON.parse(await fs.readFile(path.join(dir, "incomplete.json"), "utf8"));
  const pendingRecovery = recoveryFile(dir, marker);
  verifyRecovery(await fs.readFile(pendingRecovery), marker, false);
  // committed view still inspectable during active round
  assert.equal(mid.committed.revision, 0);
  const staged = await handle.stageBody("retained round-one body");
  assert.equal(staged.deduplicated, false);
  const dup = await handle.stageBody("retained round-one body");
  assert.equal(dup.deduplicated, true);
  await handle.appendAudit({ at: Date.now(), kind: "dispatch", detail: "search x1" });
  await handle.settleRound("r1", {
    status: "complete",
    measured: { searches: 1, reads: 0, judgments: 0 },
    uncertainty: null,
  });
  const insp0 = await store.inspect(ref);
  const snap = snapshotFor(store, ref, 1, insp0.committed.snapshot.requirementsDigest, [
    { bodyId: staged.bodyId, digest: `sha256:${staged.bodyId.slice(2)}`, bytes: staged.bytes },
  ], [{ roundId: "r1", intent: "start", settledAt: Date.now(), usage: { searches: 1, reads: 0, judgments: 0 } }]);
  const committed = await handle.commitRevision({ expectedRevision: 0, snapshot: snap });
  assert.equal(committed.revision, 1);
  await handle.release();
  // separate invocation
  const reopened = openStore({ root });
  const final = await reopened.inspect(ref);
  assert.equal(final.committed.revision, 1);
  assert.equal(final.incomplete, null);
  await assert.rejects(fs.stat(pendingRecovery), { code: "ENOENT" });
  const body = await reopened.readBody(ref, staged.bodyId);
  assert.equal(body.toString("utf8"), "retained round-one body");
});

test("expected-revision conflict is refused", async () => {
  const root = await tempRoot();
  const { store, ref } = await created(root);
  const handle = await store.acquireOwnership(ref);
  await handle.beginRound({ roundId: "r1", intent: "start" });
  const snap = snapshotFor(store, ref, 1, (await store.inspect(ref)).committed.snapshot.requirementsDigest);
  await assert.rejects(
    () => handle.commitRevision({ expectedRevision: 7, snapshot: { ...snap, revision: 8, parentRevision: 7 } }),
    ExpectedRevisionError,
  );
  await handle.release();
});

test("commit refuses when referenced body was substituted on disk; prior revision intact", async () => {
  const root = await tempRoot();
  const { store, ref } = await created(root);
  const handle = await store.acquireOwnership(ref);
  await handle.beginRound({ roundId: "r1", intent: "start" });
  const staged = await handle.stageBody("authentic body");
  // tamper the body file
  await fs.writeFile(
    path.join(root, "investigations", ref, "bodies", `${staged.bodyId.slice(2)}.bin`),
    "substituted",
  );
  const snap = snapshotFor(store, ref, 1, (await store.inspect(ref)).committed.snapshot.requirementsDigest, [
    { bodyId: staged.bodyId, digest: `sha256:${staged.bodyId.slice(2)}`, bytes: staged.bytes },
  ]);
  await assert.rejects(
    () => handle.commitRevision({ expectedRevision: 0, snapshot: snap }),
    CorruptContentError,
  );
  await handle.release();
  // committed revision 0 still inspectable
  const insp = await store.inspect(ref);
  assert.equal(insp.committed.revision, 0);
});

test("commit refuses when referenced body is missing from disk", async () => {
  const root = await tempRoot();
  const { store, ref } = await created(root);
  const handle = await store.acquireOwnership(ref);
  await handle.beginRound({ roundId: "r1", intent: "start" });
  const fakeBody = "b:" + "a".repeat(64);
  const snap = snapshotFor(store, ref, 1, (await store.inspect(ref)).committed.snapshot.requirementsDigest, [
    { bodyId: fakeBody, digest: `sha256:${"a".repeat(64)}`, bytes: 3 },
  ]);
  await assert.rejects(
    () => handle.commitRevision({ expectedRevision: 0, snapshot: snap }),
    CorruptContentError,
  );
  await handle.release();
});

test("snapshot requirements digest must match RETAINED requirements", async () => {
  const root = await tempRoot();
  const { store, ref } = await created(root);
  const handle = await store.acquireOwnership(ref);
  await handle.beginRound({ roundId: "r1", intent: "start" });
  const liar = snapshotFor(store, ref, 1, "sha256:" + "0".repeat(64));
  await assert.rejects(
    () => handle.commitRevision({ expectedRevision: 0, snapshot: liar }),
    CorruptRecordError,
  );
  await handle.release();
});

// ---------------------------------------------------------------------------
// Manifest faults / corruption — fail closed, delete-only
// ---------------------------------------------------------------------------

test("corrupt manifest: inspect reports damage without fabricating; continuation refused; delete-only", async () => {
  const root = await tempRoot();
  const { store, ref } = await created(root);
  const dir = path.join(root, "investigations", ref);
  await fs.writeFile(path.join(dir, "store.json"), "{corrupt json");
  const insp = await store.inspect(ref);
  assert.equal(insp.committed, null);
  assert.equal(insp.damage, "manifest-corrupt");
  // acquire still possible (ownership is independent of manifest), but
  // commit is refused because manifest is unreadable
  const handle = await store.acquireOwnership(ref);
  try {
    await assert.rejects(() => handle.beginRound({ roundId: "r2", intent: "continue" }), CorruptRecordError);
  } finally {
    await handle.release();
  }
  // delete-only recovery is permitted
  const del = await store.deleteInvestigation(ref);
  assert.equal(del.deleted, true);
  await assert.rejects(() => store.inspect(ref), InvalidReferenceError);
});

test("missing manifest behaves the same (delete-only)", async () => {
  const root = await tempRoot();
  const { store, ref } = await created(root);
  const dir = path.join(root, "investigations", ref);
  await fs.rm(path.join(dir, "store.json"));
  const insp = await store.inspect(ref);
  assert.equal(insp.damage, "manifest-missing");
  await store.deleteInvestigation(ref);
});

test("write fault on manifest publish leaves prior committed revision readable", async () => {
  const root = await tempRoot();
  const store = openStore({ root });
  const { investigationRef: ref } = await store.createInvestigation({ requirements: REQUIREMENTS });
  // commit round one successfully
  const ok = await store.acquireOwnership(ref);
  await ok.beginRound({ roundId: "r1", intent: "start" });
  const staged = await ok.stageBody("body one");
  const digest0 = (await store.inspect(ref)).committed.snapshot.requirementsDigest;
  const snap1 = snapshotFor(store, ref, 1, digest0, [
    { bodyId: staged.bodyId, digest: `sha256:${staged.bodyId.slice(2)}`, bytes: staged.bytes },
  ]);
  await ok.commitRevision({ expectedRevision: 0, snapshot: snap1 });
  await ok.release();
  // now fault the manifest write path for the NEXT commit
  const faulted = openStore({
    root,
    deps: {
      writeFileAtomic: async (p, c) => {
        if (p.endsWith("store.json")) throw Object.assign(new Error("EIO: manifest"), { code: "EIO" });
        await atomicReplaceFile(p, c);
      },
    },
  });
  const h2 = await faulted.acquireOwnership(ref);
  await h2.beginRound({ roundId: "r2", intent: "continue" });
  const staged2 = await h2.stageBody("body two");
  const snap2 = snapshotFor(store, ref, 2, digest0, [
    { bodyId: staged2.bodyId, digest: `sha256:${staged2.bodyId.slice(2)}`, bytes: staged2.bytes },
  ]);
  try {
    await assert.rejects(
      () => h2.commitRevision({ expectedRevision: 1, snapshot: snap2 }),
      { name: "Error", code: "EIO", message: "EIO: manifest" },
    );
  } finally {
    await h2.release();
  }
  // revision 1 remains the committed, verifiable view
  const insp = await openStore({ root }).inspect(ref);
  assert.equal(insp.committed.revision, 1);
});

// ---------------------------------------------------------------------------
// Interruption / acknowledgment
// ---------------------------------------------------------------------------

test("unacknowledged incomplete marker blocks a fresh owner's round; acknowledgment permits one fresh round", async () => {
  const root = await tempRoot();
  const { store, ref } = await created(root);
  const dir = path.join(root, "investigations", ref);
  // child becomes the real owner via the store API, begins a round, parks.
  const child = trackedSpawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
      import { openStore } from ${JSON.stringify(new URL("../dist/lib/retained-record-store.js", import.meta.url).href)};
      const h = await openStore({ root: ${JSON.stringify(root)} }).acquireOwnership(${JSON.stringify(ref)});
      await h.beginRound({ roundId: "interrupted", intent: "start" });
      await h.appendAudit({ at: 1, kind: "dispatch", detail: "preserved normal evidence" });
      console.log("held");
      setInterval(() => {}, 1000);
    `,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  child.stdout.resume();
  const normalAuditPath = path.join(dir, "audit", "round-interrupted.json");
  let normalAuditBefore;
  const t0 = Date.now();
  for (;;) {
    const i = await store.inspect(ref);
    if (i.ownership === "live-owner" && i.incomplete?.roundId === "interrupted") {
      try { normalAuditBefore = await fs.readFile(normalAuditPath); break; }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    if (Date.now() - t0 > 10_000) assert.fail("child never staged interruption");
    await new Promise((r) => setTimeout(r, 50));
  }
  await assert.rejects(() => store.acquireOwnership(ref), OwnerBusyError);
  const marker = JSON.parse(await fs.readFile(path.join(dir, "incomplete.json"), "utf8"));
  const receiptPath = recoveryFile(dir, marker);
  verifyRecovery(await fs.readFile(receiptPath), marker, false);
  // kill prior owner; kernel proves exit
  child.kill("SIGKILL");
  await new Promise((r) => setTimeout(r, 300));
  const insp = await store.inspect(ref);
  assert.equal(insp.ownership, "free");
  assert.equal(insp.incomplete.roundId, "interrupted");
  // fresh owner without acknowledgment is blocked
  const h = await store.acquireOwnership(ref);
  await assert.rejects(() => h.beginRound({ roundId: "fresh", intent: "continue" }), UnacknowledgedInterruptionError);
  await h.release();
  // acknowledgment admits ONE fresh round (handle returned live)
  const ack = await store.acknowledgeInterrupted(ref);
  try {
    const afterAck = await store.inspect(ref);
    assert.equal(afterAck.incomplete, null);
    verifyRecovery(await fs.readFile(receiptPath), marker, true);
    assert.equal((await fs.readdir(path.join(dir, "audit")))
      .filter((name) => name === path.basename(receiptPath)).length, 1);
    assert.deepEqual(await fs.readFile(normalAuditPath), normalAuditBefore);
    await ack.beginRound({ roundId: "fresh", intent: "continue" });
    await assert.rejects(() => ack.beginRound({ roundId: "again", intent: "continue" }), InvalidRecordInputError);
  } finally {
    await ack.release();
  }
  // The sealed exact-instance receipt is ACK authority; normal rows remain
  // byte-preserved informational history, including across the fresh round.
  assert.deepEqual(await fs.readFile(normalAuditPath), normalAuditBefore);
});

test("acknowledgment refuses damaged state (delete-only path)", async () => {
  const root = await tempRoot();
  const { store, ref } = await created(root);
  const dir = path.join(root, "investigations", ref);
  await fs.writeFile(path.join(dir, "store.json"), "garbage");
  await fs.writeFile(
    path.join(dir, "incomplete.json"),
    JSON.stringify({ schemaVersion: 1, roundId: "x", intent: "start", ownerId: "dead", startedAt: 1, revisionBase: 0, settled: false }),
  );
  await assert.rejects(() => store.acknowledgeInterrupted(ref), CorruptRecordError);
  await store.deleteInvestigation(ref);
});

// ---------------------------------------------------------------------------
// Storage caps — actual bytes, no eviction
// ---------------------------------------------------------------------------

test("record cap rejects admission; retained evidence survives refusal", async (t) => {
  const root = await tempRoot();
  // Default 64KiB settlement reserve; one paid 8KiB recovery envelope.
  const store = openStore({ root, caps: { recordMaxBytes: 84 * 1024 } });
  const { investigationRef: ref } = await store.createInvestigation({ requirements: REQUIREMENTS });
  const h = await store.acquireOwnership(ref);
  const dir = path.join(root, "investigations", ref);
  const baseline = await recordBytes(dir);
  let afterFirst;
  let measured;
  try {
    measured = await observeRecordPeak(dir, async () => {
      await h.beginRound({ roundId: "r1", intent: "start" });
      await h.stageBody("y".repeat(6 * 1024)); // fits
      afterFirst = await recordBytes(dir);
      await assert.rejects(() => h.stageBody("z".repeat(6 * 1024)), StoreCapacityError);
    });
  } finally {
    await h.release();
  }
  assert.equal(measured.recoveryLinkPeak, baseline + 2 * 8192);
  assert.ok(measured.peak <= 84 * 1024);
  t.diagnostic(JSON.stringify({ cap: 84 * 1024, baseline, afterFirst, ...measured }));
  // committed evidence still present and readable
  const insp = await store.inspect(ref);
  assert.equal(insp.committed.revision, 0);
});

test("store cap rejects new retention across investigations, never evicts", async () => {
  const root = await tempRoot();
  const store = openStore({ root, caps: { storeMaxBytes: 64 * 1024 } });
  // fill with distinct investigations until the cap refuses
  let ref = null;
  let refused = false;
  for (let i = 0; i < 40 && !refused; i += 1) {
    try {
      const r = await store.createInvestigation({
        requirements: REQUIREMENTS,
        bodies: [{ content: "e".repeat(4 * 1024) }], // distinct per record; dedup within one only
      });
      ref ??= r.investigationRef;
    } catch (err) {
      if (!(err instanceof StoreCapacityError)) throw err;
      refused = true;
    }
  }
  assert.ok(refused, "store cap must eventually refuse");
  assert.ok(ref !== null, "at least one record must have been admitted");
  // the FIRST record's evidence still verifiable — no eviction
  const first = openStore({ root }).inspect(ref);
  assert.equal((await first).committed.revision, 0);
});

test("settlement reserve counts against record admission before dispatch", async (t) => {
  // Pay the native two-entry 8KiB envelope peak first. SAME cap, initial
  // body and payload then straddle only the real 4096-vs-256 reserve cost.
  const cap = 26 * 1024, payload = "w".repeat(10 * 1024);
  const measurements = [];
  for (const reserveBytes of [256, 4096]) {
    const root = await tempRoot();
    const store = openStore({ root, caps: { recordMaxBytes: cap, settlementReserveBytes: reserveBytes } });
    const { investigationRef: ref } = await store.createInvestigation({
      requirements: REQUIREMENTS,
      bodies: [{ content: "q".repeat(5 * 1024) }],
    });
    const h = await store.acquireOwnership(ref);
    const dir = path.join(root, "investigations", ref);
    const baseline = await recordBytes(dir);
    let beforeStage;
    try {
      const measured = await observeRecordPeak(dir, async () => {
        await h.beginRound({ roundId: "r1", intent: "start" }); // BOTH must succeed
        const reserve = await fs.readFile(path.join(dir, "reserve.settlement"));
        assert.equal(reserve.length, reserveBytes);
        const marker = JSON.parse(await fs.readFile(path.join(dir, "incomplete.json"), "utf8"));
        assert.deepEqual(JSON.parse(reserve.subarray(0, reserve.indexOf(0)).toString("utf8")), {
          schemaVersion: 1, kind: "settlement-reserve", roundId: "r1", ownerId: marker.ownerId, reserveBytes,
        });
        verifyRecovery(await fs.readFile(recoveryFile(dir, marker)), marker, false);
        beforeStage = await recordBytes(dir);
        if (reserveBytes === 256) {
          const staged = await h.stageBody(payload);
          assert.equal(staged.bytes, payload.length);
          assert.equal((await store.readBody(ref, staged.bodyId)).toString("utf8"), payload);
          assert.ok(cap - (beforeStage + payload.length) >= 512, "positive margin too small");
        } else {
          await assert.rejects(() => h.stageBody(payload), StoreCapacityError);
          assert.equal(await recordBytes(dir), beforeStage, "refused body materialized");
          assert.ok(beforeStage + payload.length - cap >= 512, "negative margin too small");
        }
      });
      assert.equal(measured.recoveryLinkPeak, baseline + 2 * 8192);
      assert.ok(measured.peak <= cap);
      measurements.push({ reserveBytes, baseline, beforeStage, ...measured });
    } finally {
      await h.release();
    }
  }
  t.diagnostic(JSON.stringify({ cap, payloadBytes: payload.length, measurements }));
});

// ---------------------------------------------------------------------------
// Deletion
// ---------------------------------------------------------------------------

test("delete removes only the record tree; sibling records and caller files untouched", async () => {
  const root = await tempRoot();
  const store = openStore({ root });
  const a = await store.createInvestigation({ requirements: REQUIREMENTS });
  const b = await store.createInvestigation({ requirements: REQUIREMENTS });
  await store.deleteInvestigation(a.investigationRef);
  await assert.rejects(() => store.inspect(a.investigationRef), InvalidReferenceError);
  const insp = await store.inspect(b.investigationRef);
  assert.equal(insp.committed.revision, 0);
});

test("partial deletion reports incomplete and blocks continuation; retry completes", async () => {
  const root = await tempRoot();
  let failNext = true;
  const store = openStore({
    root,
    deps: {
      removeTree: async (d) => {
        if (failNext) {
          failNext = false;
          // partially remove: delete the manifest then fail
          await fs.rm(path.join(d, "store.json"), { force: true });
          throw Object.assign(new Error("EIO mid-delete"), { code: "EIO" });
        }
        await fs.rm(d, { recursive: true, force: true });
      },
    },
  });
  const { investigationRef: ref } = await store.createInvestigation({ requirements: REQUIREMENTS });
  await assert.rejects(() => store.deleteInvestigation(ref), DeletionIncompleteError);
  // partly deleted state is noncontinuable: tombstone dominates, mutation refused
  const damaged = await store.inspect(ref);
  assert.equal(damaged.committed, null);
  assert.equal(damaged.damage, "deletion-incomplete");
  await assert.rejects(() => store.acquireOwnership(ref), InvalidReferenceError);
  // retry under safe ownership completes
  const retried = await openStore({ root }).deleteInvestigation(ref);
  assert.equal(retried.deleted, true);
  await assert.rejects(() => openStore({ root }).inspect(ref), InvalidReferenceError);
});

test("no automatic replay: interrupted record shows committed view, incomplete separately, no dispatch", async () => {
  const root = await tempRoot();
  const { store, ref } = await created(root);
  // prior owner staged a round then died without commit (gate released by kernel)
  const handle = await store.acquireOwnership(ref);
  await handle.beginRound({ roundId: "lost", intent: "start" });
  // simulate death of ownership without settling: release gate but leave marker
  // (release() normally the clean path; emulate crash by removing gate only)
  await handle["gate"].release(); // hard-drop ownership, marker stays
  const insp = await openStore({ root }).inspect(ref);
  assert.equal(insp.committed.revision, 0);
  assert.equal(insp.incomplete.roundId, "lost");
  assert.equal(insp.ownership, "free");
  // store performed NO dispatch, NO commit: revision still 0 — asserted above.
});

// ---------------------------------------------------------------------------
// Fault seam: ordinary atomic documents and immutable revision staging
// ---------------------------------------------------------------------------

test("ordinary document writes and revision staging flow through writeFileAtomic", async () => {
  const root = await tempRoot();
  const seen = [];
  const store = openStore({
    root,
    deps: {
      writeFileAtomic: async (p, c) => {
        seen.push(p);
        await atomicReplaceFile(p, c);
      },
    },
  });
  const { investigationRef: ref } = await store.createInvestigation({
    requirements: REQUIREMENTS,
    bodies: [{ content: "fault-seen" }],
  });
  const h = await store.acquireOwnership(ref);
  await h.beginRound({ roundId: "r1", intent: "start" });
  const staged = await h.stageBody("staged");
  await h.appendAudit({ at: 1, kind: "dispatch", detail: "x" });
  await h.settleRound("r1", { status: "complete", measured: { searches: 1, reads: 0, judgments: 0 }, uncertainty: null });
  const digest = (await store.inspect(ref)).committed.snapshot.requirementsDigest;
  const snap = snapshotFor(store, ref, 1, digest);
  await h.commitRevision({ expectedRevision: 0, snapshot: snap });
  await h.release();
  const rel = seen.map((p) => path.relative(path.join(root, "investigations", ref), p));
  assert.ok(rel.includes("requirements.json"));
  assert.ok(rel.includes(`bodies/${staged.bodyId.slice(2)}.bin`), "exact staged body must reach the funnel");
  assert.ok(rel.includes("revisions/r0.json"));
  // Correction (2026-10-08 finding 8, updated 2026-10-09 latest-correctness P1):
  // immutable revision publication IS seam-visible — the store performs the
  // authoritative no-clobber placement itself and hands the funnel a
  // revision-local STAGING name (never the final immutable r1.json), where it
  // may inject a SAFE staging fault. The final name is published atomically by
  // the store, preserving no-clobber semantics (default path stays
  // atomicPlaceNoClobber).
  // Recovery envelope allocation uses native placement, with an injected
  // staging witness; its bounded payload/seal ACK writes are native in place.
  assert.ok(rel.some((r) => r.includes("revisions/") && r.includes(".stage.tmp")));
  assert.ok(rel.includes("store.json"));
  assert.ok(rel.includes("incomplete.json"));
  assert.ok(rel.some((r) => r.startsWith("audit/")));
  assert.ok(rel.includes("owner.lock"));
});

// ---------------------------------------------------------------------------
// Repair teeth (cold-review 2026-10-07): one durable in-tree regression test
// per repaired defect. Each fails against the pre-repair source.
// ---------------------------------------------------------------------------

test("repair: root alias cannot produce a second owner or divergent admission", async () => {
  const root = await tempRoot();
  const store = openStore({ root });
  const { investigationRef: ref } = await store.createInvestigation({ requirements: REQUIREMENTS });
  const alias = path.join(os.tmpdir(), "rrs-alias-" + Date.now());
  await fs.symlink(root, alias);
  const h = await store.acquireOwnership(ref);
  try {
    await assert.rejects(openStore({ root: alias }).acquireOwnership(ref), OwnerBusyError);
  } finally {
    await h.release();
    await fs.rm(alias, { force: true });
  }
});

test("repair: path-unsafe roundId rejected before any path use", async () => {
  const root = await tempRoot();
  const store = openStore({ root });
  const { investigationRef: ref } = await store.createInvestigation({ requirements: REQUIREMENTS });
  const h = await store.acquireOwnership(ref);
  try {
    await assert.rejects(
      h.beginRound({ roundId: "x/../../../escaped", intent: "continue" }),
      InvalidRecordInputError,
    );
    const investigationsDir = path.join(root, "investigations");
    const entries = await fs.readdir(investigationsDir);
    for (const e of entries) {
      assert.ok(e.startsWith("inv_"), `stray non-record entry: ${e}`);
    }
  } finally {
    await h.release();
  }
});

test("repair: settlement preserves audit rows in the round document", async () => {
  const root = await tempRoot();
  const store = openStore({ root });
  const { investigationRef: ref } = await store.createInvestigation({ requirements: REQUIREMENTS });
  const dir = path.join(root, "investigations", ref);
  const h = await store.acquireOwnership(ref);
  try {
    await h.beginRound({ roundId: "r", intent: "start" });
    await h.appendAudit({ at: 1, kind: "dispatch-started", detail: "observed" });
    await h.settleRound("r", {
      status: "partial",
      measured: { searches: 1, reads: 0, judgments: 0 },
      uncertainty: "unknown",
    });
    const doc = JSON.parse(await fs.readFile(path.join(dir, "audit", "round-r.json"), "utf8"));
    assert.ok(JSON.stringify(doc).includes("dispatch-started"));
    const settlement = JSON.parse(
      await fs.readFile(path.join(dir, "audit", "settlement-r.json"), "utf8"),
    );
    assert.equal(settlement.summary.status, "partial");
  } finally {
    await h.release();
  }
});

test("repair: commitRevision requires an active OWNED round (no interruption bypass)", async () => {
  const root = await tempRoot();
  const store = openStore({ root });
  const { investigationRef: ref } = await store.createInvestigation({ requirements: REQUIREMENTS });
  const dir = path.join(root, "investigations", ref);
  const prior = await store.acquireOwnership(ref);
  await prior.beginRound({ roundId: "orphan", intent: "continue" });
  await prior.release();
  const h = await store.acquireOwnership(ref);
  try {
    const r0 = JSON.parse(await fs.readFile(path.join(dir, "revisions", "r0.json"), "utf8"));
    await assert.rejects(
      h.commitRevision({
        expectedRevision: 0,
        snapshot: { ...r0, revision: 1, parentRevision: 0 },
      }),
      UnacknowledgedInterruptionError,
    );
    assert.equal((await store.inspect(ref)).committed.revision, 0);
  } finally {
    await h.release();
  }
});

test("repair: corrupt committed revision blocks beginRound (delete-only)", async () => {
  const root = await tempRoot();
  const store = openStore({ root });
  const { investigationRef: ref } = await store.createInvestigation({ requirements: REQUIREMENTS });
  const dir = path.join(root, "investigations", ref);
  await fs.writeFile(path.join(dir, "revisions", "r0.json"), "{broken");
  const h = await store.acquireOwnership(ref);
  try {
    await assert.rejects(
      h.beginRound({ roundId: "n", intent: "continue" }),
      CorruptRecordError
    );
  } finally {
    await h.release();
  }
});

test("repair: release drains pending writes before closing the owner gate", async () => {
  const root = await tempRoot();
  let paused, go;
  const ready = new Promise((r) => (paused = r)),
    resume = new Promise((r) => (go = r));
  const slow = openStore({
    root,
    deps: {
      writeFileAtomic: async (p, c) => {
        if (p.endsWith(".bin")) {
          paused();
          await resume;
        }
        await atomicReplaceFile(p, c);
      },
    },
  });
  const { investigationRef: ref } = await slow.createInvestigation({ requirements: REQUIREMENTS });
  const h = await slow.acquireOwnership(ref);
  await h.beginRound({ roundId: "w", intent: "start" });
  const writing = h.stageBody("pending");
  await ready;
  const releasing = h.release();
  let successor = undefined;
  let assertionFailed = false;
  try {
    await new Promise((r) => setTimeout(r, 20));
    try {
      successor = await openStore({ root }).acquireOwnership(ref);
    } catch (e) {
      assert.equal(e.name, "OwnerBusyError");
    }
    assert.equal(successor, undefined, "successor admitted while prior write in flight");
  } catch (error) {
    assertionFailed = true;
    throw error;
  } finally {
    go();
    const settled = await Promise.allSettled([writing, releasing]);
    if (successor) settled.push(...await Promise.allSettled([successor.release()]));
    // Cleanup cannot replace the assertion that exposed a premature admission.
    if (!assertionFailed) {
      for (const result of settled) if (result.status === "rejected") throw result.reason;
    }
  }
});

for (const faultAt of ["payload-write", "payload-sync"]) {
  test(`repair: ack audit fault releases the owner gate (no leaked handle): ${faultAt}`, async (t) => {
    const root = await tempRoot();
    const store = openStore({ root });
    const { investigationRef: ref } = await store.createInvestigation({ requirements: REQUIREMENTS });
    const prior = await store.acquireOwnership(ref);
    await prior.beginRound({ roundId: "dead-owner", intent: "continue" });
    await prior.release();
    const dir = path.join(root, "investigations", ref);
    const markerPath = path.join(dir, "incomplete.json");
    const reservePath = path.join(dir, "reserve.settlement");
    const markerBytes = await fs.readFile(markerPath);
    const marker = JSON.parse(markerBytes.toString("utf8"));
    const receiptPath = recoveryFile(dir, marker);
    const reserveBefore = await fs.readFile(reservePath);
    const recoveryBefore = await fs.readFile(receiptPath);
    const identityBefore = await fs.stat(receiptPath, { bigint: true });
    verifyRecovery(recoveryBefore, marker, false);
    const nativeOpen = fsp.open;
    let hits = 0, unexpectedAck;
    fsp.open = async function (file, flags, ...args) {
      const handle = await nativeOpen.call(this, file, flags, ...args);
      if (file !== receiptPath || typeof flags !== "number" || !(flags & fs.constants.O_RDWR)) return handle;
      let payloadWritten = false;
      return new Proxy(handle, { get(target, key) {
        const value = Reflect.get(target, key, target);
        if (key === "write") return async (...params) => {
          if (faultAt === "payload-write" && params[3] === 2048) {
            hits += 1;
            throw new Error("audit write failed");
          }
          const result = await value.apply(target, params);
          if (params[3] === 2048) payloadWritten = true;
          return result;
        };
        if (key === "sync") return async () => {
          if (faultAt === "payload-sync" && payloadWritten) {
            hits += 1;
            throw new Error("audit write failed");
          }
          return value.call(target);
        };
        return typeof value === "function" ? value.bind(target) : value;
      } });
    };
    syncBuiltinESMExports();
    try {
      await assert.rejects(async () => {
        unexpectedAck = await store.acknowledgeInterrupted(ref);
      }, { name: "Error", message: "audit write failed" });
    } finally {
      fsp.open = nativeOpen;
      syncBuiltinESMExports();
      await unexpectedAck?.release();
    }
    assert.equal(hits, 1, "owned native fault was not armed exactly once");
    assert.equal((await store.inspect(ref)).ownership, "free");
    assert.deepEqual(await fs.readFile(markerPath), markerBytes);
    assert.deepEqual(await fs.readFile(reservePath), reserveBefore);
    const recoveryAfter = await fs.readFile(receiptPath);
    assert.deepEqual(recoveryAfter.subarray(0, 2048), recoveryBefore.subarray(0, 2048));
    verifyRecovery(recoveryAfter, marker, false); // payload preparation is never authority
    const identityAfter = await fs.stat(receiptPath, { bigint: true });
    for (const key of ["dev", "ino", "size"]) assert.equal(identityAfter[key], identityBefore[key]);
    t.diagnostic(JSON.stringify({ faultAt, hits, markerPreserved: true, reserveBytes: reserveBefore.length,
      recoveryBytes: recoveryAfter.length, unsealed: true }));
  });
}

test("repair: tombstone-fault deletion leaves noncontinuable damage, not a valid view", async () => {
  const root = await tempRoot();
  const store = openStore({ root });
  const { investigationRef: ref } = await store.createInvestigation({ requirements: REQUIREMENTS });
  const dir = path.join(root, "investigations", ref);
  await fs.mkdir(path.join(dir, "staging"));
  await fs.writeFile(path.join(dir, "staging", "uncommitted"), "x");
  const bad = openStore({
    root,
    deps: {
      removeTree: async (d) => {
        await fs.rm(path.join(d, "staging"), { recursive: true });
        throw new Error("partial removal");
      },
      writeFileAtomic: async () => {
        throw new Error("tombstone write failed");
      },
    },
  });
  await assert.rejects(bad.deleteInvestigation(ref), DeletionIncompleteError);
  const view = await store.inspect(ref);
  assert.equal(view.committed, null);
  assert.ok(view.damage);
});

test("repair: committed revisions are immutable (no-clobber publication)", async () => {
  const root = await tempRoot();
  const store = openStore({ root });
  const { investigationRef: ref } = await store.createInvestigation({ requirements: REQUIREMENTS });
  const dir = path.join(root, "investigations", ref);
  const h = await store.acquireOwnership(ref);
  try {
    await h.beginRound({ roundId: "imm", intent: "start" });
    const digest = (await store.inspect(ref)).committed.snapshot.requirementsDigest;
    const snap = snapshotFor(store, ref, 1, digest);
    await h.commitRevision({ expectedRevision: 0, snapshot: snap });
    const before = await fs.readFile(path.join(dir, "revisions", "r1.json"), "utf8");
    await h.release();
    const h2 = await store.acquireOwnership(ref);
    try {
      await h2.beginRound({ roundId: "imm2", intent: "continue" });
      // Advance to revision 2 (legitimate successor)…
      await h2.commitRevision({
        expectedRevision: 1,
        snapshot: { ...snap, revision: 2, parentRevision: 1, createdAt: snap.createdAt + 1 },
      });
      const r1After = await fs.readFile(path.join(dir, "revisions", "r1.json"), "utf8");
      assert.equal(r1After, before, "publication of r2 rewrote immutable r1");
      // …then hand-edit the manifest back to 1 and try to publish a
      // CONFLICTING r2: no-clobber must refuse, preserving the staged file.
      await fs.writeFile(
        path.join(dir, "store.json"),
        JSON.stringify({ schemaVersion: 1, committedRevision: 1, updatedAt: Date.now() }),
      );
      const conflicting = { ...snap, revision: 2, parentRevision: 1, createdAt: snap.createdAt + 999 };
      const r2Before = await fs.readFile(path.join(dir, "revisions", "r2.json"), "utf8");
      // Re-arm a round for the conflicting attempt (commit removed the marker).
      await h2.release();
      const h3 = await store.acquireOwnership(ref);
      await h3.beginRound({ roundId: "imm3", intent: "continue" });
      await assert.rejects(
        h3.commitRevision({ expectedRevision: 1, snapshot: conflicting }),
        CorruptRecordError,
      );
      await h3.release();
      assert.equal(
        await fs.readFile(path.join(dir, "revisions", "r2.json"), "utf8"),
        r2Before,
        "conflicting republication overwrote immutable r2",
      );
    } finally {
      await h2.release();
    }
    assert.equal(await fs.readFile(path.join(dir, "revisions", "r1.json"), "utf8"), before);
  } finally {
    await h.release();
  }
});
