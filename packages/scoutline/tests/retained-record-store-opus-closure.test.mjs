/**
 * Retained record store — Opus closure four-gap finishing batch (2026-10-09).
 * Ticket: unified-investigation/caller-assisted-engine/tickets/retained-records
 *
 * One durable in-tree test per opus-cold-review P2 gap:
 *  G1 post-settlement staging/audit refusal while terminal commit succeeds
 *  G2 instance-configured reserve size coherence (128KiB override)
 *  G3 incremental bounded owned read: growth after stat cannot cause
 *     unbounded allocation/parse (active counter, max+1 refusal)
 *  G4 ACK disposition idempotence across crash-after-audit-before-marker-rm
 *
 * Every case failed against the pre-repair source (RED captured first).
 * Real fs, roots under os.tmpdir(); fetch refuses.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { openStore } from "../dist/lib/retained-record-store.js";

globalThis.fetch = () => {
  throw new Error("HTTP refused");
};

const REQUIREMENTS = { schemaVersion: 1, fields: { a: { definition: "synthetic", required: true } } };
const SUMMARY = { status: "partial", measured: { searches: 0, reads: 0, judgments: 0 }, uncertainty: null };

function tempRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), "rrs-opus-"));
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
    await h2.beginRound({ roundId: "r2", intent: "continue" });
    await h2.settleRound("r2", SUMMARY);
    await h2.release();
  } catch (e) {
    await h.release().catch(() => {});
    throw e;
  }
});

// G3: incremental bounded owned read — a file that GROWS after the reader's
// preliminary stat (concurrent rename-replacement) must be refused by the
// reader's ACTIVE byte counter at max+1, never parsed as ordinary state. The
// grown marker is VALID JSON with a distinctive startedAt: on a stat-only
// reader the lstat→readFile window can deliver it whole and accept it; the
// incremental reader reads at most max+1 bytes and refuses.
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
    let stop = false;
    let accepted = false;
    const grower = (async () => {
      while (!stop) {
        await fs.writeFile(p + ".grow", grown);
        await fs.rename(p + ".grow", p);
        await fs.writeFile(p + ".grow", original);
        await fs.rename(p + ".grow", p);
      }
    })().catch(() => {});
    try {
      for (let i = 0; i < 300 && !accepted; i++) {
        const view = await store.inspect(ref);
        if (view.incomplete?.startedAt === 9999999999999) accepted = true;
      }
    } finally {
      stop = true;
      await grower;
      await fs.writeFile(p, original).catch(() => {});
    }
    assert.equal(accepted, false, "oversized grown-after-stat marker was accepted as ordinary state");
  } finally {
    await h.release();
  }
});

// G4: crash after the ACK audit row but before marker removal — a re-ACK must
// not append a second identical acknowledge-interrupted disposition.
test("G4: re-ACK after crash between audit row and marker rm appends exactly one disposition", async () => {
  const root = await tempRoot();
  const store = openStore({ root });
  const { investigationRef: ref } = await store.createInvestigation({ requirements: REQUIREMENTS });
  const dir = path.join(root, "investigations", ref);
  const h = await store.acquireOwnership(ref);
  await h.beginRound({ roundId: "r", intent: "continue" });
  await h.release();
  // Simulate the crash state: the ack audit row was written, but the marker
  // removal never happened.
  const ack = await store.acknowledgeInterrupted(ref);
  await ack.release();
  // Marker is gone: reconstruct the interrupted state by hand (marker back,
  // no reserve — it was already consumed), which is exactly the state a
  // crash between audit-write and marker-rm leaves behind is NOT; instead
  // simulate directly: restore the marker file the crash would have left.
  await fs.writeFile(
    path.join(dir, "incomplete.json"),
    JSON.stringify({
      schemaVersion: 1,
      roundId: "r",
      intent: "continue",
      ownerId: "crashed-owner",
      startedAt: Date.now(),
      revisionBase: 0,
      settled: false,
    }),
  );
  const ack2 = await store.acknowledgeInterrupted(ref);
  await ack2.release();
  const auditDoc = JSON.parse(await fs.readFile(path.join(dir, "audit", "round-r.json"), "utf8"));
  const ackRows = auditDoc.rows.filter((row) => row.kind === "acknowledge-interrupted");
  assert.equal(ackRows.length, 1, `expected exactly 1 ack disposition, found ${ackRows.length}`);
});

// G2-negative: malformed reserve size fails before work.
test("G2n: malformed settlementReserveBytes cap fails before work", async () => {
  const root = await tempRoot();
  assert.throws(
    () => openStore({ root, caps: { settlementReserveBytes: 0 } }),
    (e) => e.name === "InvalidRecordInputError" || /reserve/i.test(e.message),
  );
});
