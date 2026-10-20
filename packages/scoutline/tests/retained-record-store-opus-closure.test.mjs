/**
 * Retained record store — Opus closure four-gap finishing batch (2026-10-09).
 * Ticket: unified-investigation/caller-assisted-engine/tickets/retained-records
 *
 * One durable in-tree test per opus-cold-review P2 gap:
 *  G1 post-settlement staging/audit refusal while terminal commit succeeds
 *  G2 instance-configured reserve size coherence (128KiB override)
 *  G3 incremental bounded owned read: growth after stat cannot cause
 *     unbounded allocation/parse (active counter, max+1 refusal)
 *  G4 sealed ACK disposition idempotence across crash-before-marker-rm
 *
 * Every case failed against the pre-repair source (RED captured first).
 * Real fs, roots under os.tmpdir(); fetch refuses.
 */
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import * as fs from "node:fs/promises";
// Mutable alias of the builtin exports object — the ESM namespace above is
// frozen; patching the default export + syncBuiltinESMExports() is what the
// compiled dist modules observe (deterministic growth stimulus below).
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";

import { openStore } from "../dist/lib/retained-record-store.js";

globalThis.fetch = () => {
  throw new Error("HTTP refused");
};

const REQUIREMENTS = { schemaVersion: 1, fields: { a: { definition: "synthetic", required: true } } };
const SUMMARY = { status: "partial", measured: { searches: 0, reads: 0, judgments: 0 }, uncertainty: null };

// Every root this run creates is registered and removed in test.after —
// only current-run owned roots are touched, never pre-existing temp dirs.
const ownedRoots = new Set();
function tempRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), "rrs-opus-")).then((p) => {
    ownedRoots.add(p);
    return p;
  });
}
test.after(async () => {
  const failures = [];
  for (const root of [...ownedRoots]) {
    try {
      await fs.rm(root, { recursive: true, force: true });
      ownedRoots.delete(root);
    } catch (e) {
      failures.push(`${root}: ${e.message}`);
    }
  }
  if (failures.length > 0) {
    assert.fail(`temp-root cleanup failed: ${failures.join("; ")}`);
  }
});

// Read-only check of the approved fixed frame, independent of the private parser.
// A pending 8192-byte file (or its hash-derived name) is never ACK authority.
function validateSealedReceipt(bytes, marker) {
  assert.equal(bytes.length, 8192, "receipt allocation changed");
  const paddedJson = (slot) => {
    const end = slot.indexOf(0);
    assert.ok(end > 0, "receipt is not sealed JSON");
    assert.ok(slot.subarray(end).every((byte) => byte === 0), "nonzero frame padding");
    return JSON.parse(slot.subarray(0, end).toString("utf8"));
  };
  assert.deepEqual(paddedJson(bytes.subarray(0, 2048)), {
    schemaVersion: 1, kind: "ack-recovery", roundId: marker.roundId,
    priorOwner: marker.ownerId, revisionBase: marker.revisionBase, reserveBytes: 8192,
  }, "receipt header must match the exact interrupted tuple");
  const seal = paddedJson(bytes.subarray(6144, 6272));
  assert.deepEqual(Object.keys(seal).sort(), ["bytes", "digest"]);
  assert.ok(Number.isInteger(seal.bytes) && seal.bytes > 0 && seal.bytes <= 4096);
  const payload = bytes.subarray(2048, 2048 + seal.bytes);
  assert.equal(crypto.createHash("sha256").update(payload).digest("hex"), seal.digest, "receipt seal checksum");
  const receipt = JSON.parse(payload.toString("utf8"));
  assert.deepEqual(Object.keys(receipt).sort(), ["at", "kind", "priorOwner", "remoteWork", "revisionBase", "roundId", "schemaVersion"]);
  assert.deepEqual({ ...receipt, at: 0 }, {
    schemaVersion: 1, kind: "acknowledge-interrupted", roundId: marker.roundId,
    priorOwner: marker.ownerId, revisionBase: marker.revisionBase, at: 0, remoteWork: "unknown",
  }, "receipt payload must match the exact interrupted tuple");
  assert.ok(Number.isFinite(receipt.at) && receipt.at >= 0);
}

function receiptName(marker) {
  const tuple = JSON.stringify([marker.roundId, marker.ownerId, marker.revisionBase]);
  return `ack-${crypto.createHash("sha256").update(tuple).digest("hex")}.record`;
}

async function setup(caps) {
  const root = await tempRoot();
  const store = openStore({ root, ...(caps ? { caps } : {}) });
  const { investigationRef: ref } = await store.createInvestigation({ requirements: REQUIREMENTS });
  const dir = path.join(root, "investigations", ref);
  const h = await store.acquireOwnership(ref);
  await h.beginRound({ roundId: "r", intent: "continue" });
  return { root, store, ref, dir, h };
}

async function snapshotFor(store, ref, dir, revision) {
  const base = JSON.parse(await fs.readFile(path.join(dir, "revisions", "r0.json"), "utf8"));
  return { ...base, revision, parentRevision: revision - 1 };
}

// G1: after settleRound the round is settled — BOTH staging and audit appends
// must refuse (no charged-but-unreserved work in the settle→commit interval).
// Terminal commit is the one validated mutation that closes the round.
test("G1: post-settlement stage/audit refuse while terminal commit succeeds", async () => {
  const { root, store, ref, dir, h } = await setup();
  try {
    await h.settleRound("r", SUMMARY);
    await assert.rejects(
      h.stageBody("must not be retained after settlement"),
      (e) => e.name === "InvalidRecordInputError",
      "stageBody succeeded after settlement",
    );
    await assert.rejects(
      h.appendAudit({ at: Date.now(), kind: "post-settle", detail: "must refuse" }),
      (e) => e.name === "InvalidRecordInputError",
      "appendAudit succeeded after settlement",
    );
    // Terminal commit is the one permitted mutation in this state.
    const snap = await snapshotFor(store, ref, dir, 1);
    await h.commitRevision({ expectedRevision: 0, snapshot: snap });
    assert.equal((await store.inspect(ref)).committed.revision, 1);
  } finally {
    await h.release();
  }
});

// G2: a configured 128KiB reserve must be validated against the INSTANCE
// value — begin/settle/reopen all coherent; no module-constant mismatch.
test("G2: instance-configured 128KiB reserve works end to end", async () => {
  const { root, store, ref, dir, h } = await setup({ settlementReserveBytes: 128 * 1024 });
  try {
    await h.settleRound("r", SUMMARY);
    assert.equal((await store.inspect(ref)).incomplete.settled, true);
    await h.release();
    // The interrupted round (settled, no commit) is acknowledged — the ACK
    // path reads the reserve with the configured 128KiB size.
    const acked = await store.acknowledgeInterrupted(ref);
    await acked.release();
    // Reopen path: begin a fresh round under the same override — must accept
    // the 128KiB reserve file at every step.
    const h2 = await store.acquireOwnership(ref);
    try {
      await h2.beginRound({ roundId: "r2", intent: "continue" });
      await h2.settleRound("r2", SUMMARY);
    } finally {
      await h2.release();
    }
  } finally {
    await h.release();
  }
});

// G3: incremental bounded owned read — deterministic same-inode growth of
// the marker AT the reader's open (after the preliminary lstat, before the
// first read). The grown content is VALID JSON with a distinctive startedAt:
// a stat-only reader would deliver it whole and accept it; the incremental
// reader reads at most max+1 bytes and refuses, surfacing inspect damage.
// No random grower race: the stimulus is witnessed exactly once, and an
// unarmed control run proves the damage is caused by the growth alone.
test("G3: growth after stat is refused at max+1, not accepted unbounded", async () => {
  const { root, store, ref, dir, h } = await setup();
  try {
    const p = path.join(dir, "incomplete.json");
    const original = await fs.readFile(p, "utf8");
    const marker = JSON.parse(original);
    const grown = JSON.stringify({
      ...marker,
      startedAt: 9999999999999,
      intent: "continue",
      // pad well past any per-file ceiling
      pad: "x".repeat(300 * 1024),
    });
    // Unarmed control: the ordinary view is healthy without the stimulus.
    const before = await store.inspect(ref);
    assert.ok(before.incomplete, "control run lost the interrupted view");
    assert.notEqual(before.incomplete?.startedAt, 9999999999999);
    assert.ok(!before.damage, "control run already carried damage");
    const originalOpen = fs.open;
    let grew = 0;
    fsp.open = async (target, ...args) => {
      const handle = await originalOpen(target, ...args);
      if (target === p && grew === 0) {
        // Same-inode growth through a second owned handle: truncating
        // rewrite keeps the inode the reader's lstat identity-checked.
        grew += 1;
        const writer = await originalOpen(target, "w");
        await writer.writeFile(grown, "utf8");
        await writer.close();
      }
      return handle;
    };
    syncBuiltinESMExports();
    let view = null;
    try {
      view = await store.inspect(ref);
    } finally {
      fsp.open = originalOpen;
      syncBuiltinESMExports();
      await fs.writeFile(p, original).catch(() => {});
    }
    assert.equal(grew, 1, "growth stimulus did not fire exactly once");
    assert.notEqual(
      view?.incomplete?.startedAt,
      9999999999999,
      "oversized grown-after-stat marker was accepted as ordinary state",
    );
    assert.ok(view?.damage, "grown-marker refusal was swallowed: no inspect damage");
    // Post-restore control: the original marker reads normally again.
    const after = await store.inspect(ref);
    assert.ok(after.incomplete, "restored marker no longer reads");
    assert.notEqual(after.incomplete?.startedAt, 9999999999999);
  } finally {
    await h.release();
  }
});

// G4: crash after a real receipt seal but before marker removal — retry
// consumes the exact restored marker without replacing its one disposition.
test("G4: re-ACK after seal and exact marker restoration retains one sealed disposition", async () => {
  const root = await tempRoot();
  const store = openStore({ root });
  const { investigationRef: ref } = await store.createInvestigation({ requirements: REQUIREMENTS });
  const dir = path.join(root, "investigations", ref);
  const markerPath = path.join(dir, "incomplete.json");
  const h = await store.acquireOwnership(ref);
  let ack = null;
  try {
    await h.beginRound({ roundId: "r", intent: "continue" });
    const originalMarker = await fs.readFile(markerPath);
    const marker = JSON.parse(originalMarker);
    // A matching public normal row is informational. It cannot turn the
    // still-pending native envelope into authoritative recovery history.
    await h.appendAudit({ at: 1, kind: "acknowledge-interrupted", detail: JSON.stringify({
      roundId: marker.roundId, priorOwner: marker.ownerId, revisionBase: marker.revisionBase, remoteWork: "unknown",
    }) });
    const auditPath = path.join(dir, "audit", "round-r.json");
    const normalAudit = await fs.readFile(auditPath);
    const receiptPath = path.join(dir, "audit", receiptName(marker));
    assert.throws(() => validateSealedReceipt(Buffer.alloc(8192), marker));
    const pending = await fs.readFile(receiptPath);
    assert.throws(() => validateSealedReceipt(pending, marker), /not sealed JSON/);
    await h.release();
    ack = await store.acknowledgeInterrupted(ref);
    await ack.release();
    const sealed = await fs.readFile(receiptPath);
    validateSealedReceipt(sealed, marker);
    // Validator teeth: neither an unsealed copy nor a foreign tuple passes.
    const unsealed = Buffer.from(sealed);
    unsealed.fill(0, 6144, 6272);
    assert.throws(() => validateSealedReceipt(unsealed, marker), /not sealed JSON/);
    assert.throws(() => validateSealedReceipt(sealed, { ...marker, ownerId: "foreign-owner" }), /exact interrupted tuple/);
    // Exact original-marker restoration models crash after durable seal.
    await fs.writeFile(markerPath, originalMarker);
    ack = await store.acknowledgeInterrupted(ref);
    await ack.release();
    const names = (await fs.readdir(path.join(dir, "audit"))).filter((name) => /^ack-.*\.record$/.test(name));
    assert.deepEqual(names, [receiptName(marker)], "exactly one receipt for the interrupted tuple");
    const retried = await fs.readFile(receiptPath);
    validateSealedReceipt(retried, marker);
    assert.deepEqual(retried, sealed, "re-ACK changed the sealed disposition");
    assert.deepEqual(await fs.readFile(auditPath), normalAudit, "normal audit bytes changed");
    assert.equal((await store.inspect(ref)).incomplete, null);
    await assert.rejects(fs.stat(path.join(dir, "reserve.settlement")), (e) => e.code === "ENOENT");
  } finally {
    await ack?.release();
    await h.release();
  }
});

// G2-negative: malformed reserve size fails before work.
test("G2n: malformed settlementReserveBytes cap fails before work", async () => {
  const root = await tempRoot();
  assert.throws(
    () => openStore({ root, caps: { settlementReserveBytes: 0 } }),
    (e) => e.name === "InvalidRecordInputError" &&
      /^settlementReserveBytes must be a positive integer no greater than \d+, got 0\.$/.test(e.message),
  );
});
