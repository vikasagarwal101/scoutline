/**
 * Retained record store — current-readiness four-defect repair regressions
 * (layer5 current-parent-independent review, 2026-10-20).
 * Ticket: unified-investigation/stacked-review-resolution/layer5/current-repair
 *
 * Vertical groups, one per verified defect:
 *   reader            — opened-file identity (F3): leaf symlink at the open
 *                        boundary and same-content inode substitution both
 *                        reject; a normal regular file still reads.
 *   reserved transfer — settlement/ACK reserve consumption holds ONE store
 *                        admission turn (F1) and the complete native
 *                        transition peak — including the replacement-marker
 *                        temp while the old marker exists — stays under the
 *                        cap (F2). Siblings are observed BLOCKED mid-turn,
 *                        never awaited inside the boundary hook.
 *   ACK identity      — a disposition matches the exact interrupted tuple
 *                        (round/owner/revisionBase), so legal label reuse
 *                        under a different owner gets its own disposition
 *                        and consumes its own reserve (F4).
 *
 * Real fs, roots under os.tmpdir(); fetch refuses; every fixture tree is
 * owned and removed. Each case failed against the pre-repair source for the
 * stated reason before the fix (RED captured first).
 */
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import * as fs from "node:fs/promises";
// Mutable alias of the builtin exports object — the ESM namespace above is
// frozen; patching the default export + syncBuiltinESMExports() is what the
// compiled dist modules observe (same mechanism as the reviewer controls).
import fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { execFile as execFileCb } from "node:child_process";
import netDefault from "node:net";
import { promisify } from "node:util";

import { openStore } from "../dist/lib/retained-record-store.js";
import { atomicReplaceFile } from "../dist/lib/config-store.js";

globalThis.fetch = () => {
  throw new Error("HTTP refused");
};

const REQUIREMENTS = { schemaVersion: 1, fields: { a: { definition: "synthetic", required: true } } };
const execFileAsync = promisify(execFileCb);
const SUMMARY = (uncertainty = null) => ({
  status: "partial",
  measured: { searches: 0, reads: 0, judgments: 0 },
  uncertainty,
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

function tempRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), "rrs-ready-"));
}

async function treeSize(dir) {
  let total = 0;
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += await treeSize(p);
    else if (e.isFile()) total += (await fs.lstat(p)).size;
  }
  return total;
}

/**
 * Deterministic admission witness (T13): wraps node:net server creation so
 * every abstract-socket bind is recorded with a monotonic sequence and its
 * kernel outcome. A transition's successful admission bind marks the held
 * interval; a sibling's EADDRINUSE binds on the SAME name inside that
 * interval are the WITNESSED admission attempts — order and refusal are
 * kernel-observed facts, not timing inference. Delegates to the real
 * createServer/listen, so behavior is unchanged.
 */
function trackAbstractBinds() {
  const log = [];
  const counter = { n: 0 };
  const originalCreateServer = netDefault.createServer;
  netDefault.createServer = function (...args) {
    const server = originalCreateServer.apply(netDefault, args);
    const originalListen = server.listen.bind(server);
    server.listen = function (options, ...rest) {
      const target = typeof options === "object" && options !== null ? options.path : options;
      const entry = {
        path: typeof target === "string" ? target : null,
        seq: counter.n++,
        ok: false,
        err: null,
      };
      if (entry.path !== null) log.push(entry);
      server.once("listening", () => {
        entry.ok = true;
      });
      server.once("error", (e) => {
        entry.err = e?.code ?? null;
      });
      return originalListen(options, ...rest);
    };
    return server;
  };
  syncBuiltinESMExports();
  return {
    log,
    mark: () => counter.n++,
    restore() {
      netDefault.createServer = originalCreateServer;
      syncBuiltinESMExports();
    },
  };
}

/**
 * Find the admission path whose successful bind PRECEDED the boundary mark
 * and that received kernel-refused (EADDRINUSE) binds AFTER it: the held
 * store admission gate plus the sibling's witnessed mid-turn attempts.
 */
function witnessedAdmissionRefusal(log, markSeq) {
  const byPath = new Map();
  for (const entry of log) {
    if (!byPath.has(entry.path)) byPath.set(entry.path, []);
    byPath.get(entry.path).push(entry);
  }
  for (const [gatePath, entries] of byPath) {
    const heldBefore = entries.some((e) => e.ok && e.seq < markSeq);
    const refusalsAfter = entries.filter((e) => e.err === "EADDRINUSE" && e.seq > markSeq);
    if (heldBefore && refusalsAfter.length > 0) return { gatePath, refusalsAfter };
  }
  return null;
}

/**
 * Start a sibling operation and wait for its WITNESSED admission attempt —
 * a kernel-refused bind on the held admission gate — without joining it.
 * The bounded deadline is a safety valve only: the proof is the witnessed
 * bind sequence, never elapsed time. Never await the sibling inside the hook.
 */
async function observeSiblingBlocked(start, bindLog) {
  const observed = { outcome: null, joined: null };
  observed.joined = (async () => {
    try {
      await start();
      observed.outcome = { ok: true };
    } catch (error) {
      observed.outcome = { error };
    }
  })();
  const deadline = Date.now() + 5000;
  while (observed.outcome === null && Date.now() < deadline) {
    if (bindLog !== undefined && bindLog.some((e) => e.err === "EADDRINUSE")) break;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return observed;
}

// ---------------------------------------------------------------------------
// Reader group (F3): opened-file identity
// ---------------------------------------------------------------------------

test("reader: leaf swapped to a symlink at the fs.open boundary is rejected, not followed", async () => {
  const root = await tempRoot();
  const store = openStore({ root });
  try {
    const text = "tiny owned synthetic bytes";
    const { investigationRef: ref } = await store.createInvestigation({
      requirements: REQUIREMENTS,
      bodies: [{ content: text }],
    });
    const body = (await store.inspect(ref)).committed.snapshot.bodies[0];
    const leaf = path.join(root, "investigations", ref, "bodies", `${body.bodyId.slice(2)}.bin`);
    // A tiny owned synthetic caller file with the SAME bytes: digest equality
    // must not be able to bless the substituted leaf.
    const sibling = path.join(root, "owned-caller.txt");
    await fs.writeFile(sibling, text);
    const originalOpen = fs.open;
    let swaps = 0;
    fsp.open = async (p, ...args) => {
      if (p === leaf && swaps++ === 0) {
        await fs.rename(leaf, `${leaf}.original`);
        await fs.symlink(sibling, leaf);
      }
      return originalOpen(p, ...args);
    };
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        store.readBody(ref, body.bodyId),
        (e) => e.name === "CorruptContentError",
        "readBody accepted a leaf swapped to a symlink at the open boundary",
      );
      assert.equal(swaps, 1, "swap control did not fire exactly once");
      assert.equal(await fs.readFile(sibling, "utf8"), text, "sibling file was modified");
    } finally {
      fsp.open = originalOpen;
      syncBuiltinESMExports();
    }
    // Positive control: with the original regular leaf restored, the ordinary
    // read succeeds — identity hardening must not refuse legitimate reads.
    await fs.rm(leaf);
    await fs.rename(`${leaf}.original`, leaf);
    assert.equal((await store.readBody(ref, body.bodyId)).toString(), text);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("reader: same-content regular-file substitution (different inode) is rejected", async () => {
  const root = await tempRoot();
  const store = openStore({ root });
  try {
    const text = "identical bytes, different inode";
    const { investigationRef: ref } = await store.createInvestigation({
      requirements: REQUIREMENTS,
      bodies: [{ content: text }],
    });
    const body = (await store.inspect(ref)).committed.snapshot.bodies[0];
    const leaf = path.join(root, "investigations", ref, "bodies", `${body.bodyId.slice(2)}.bin`);
    const originalOpen = fs.open;
    let swaps = 0;
    fsp.open = async (p, ...args) => {
      if (p === leaf && swaps++ === 0) {
        // Replace the checked leaf with a REGULAR file carrying the same
        // bytes under a new inode: only an identity comparison at the opened
        // handle can catch this — digest equality cannot.
        await fs.rename(leaf, `${leaf}.original`);
        await fs.writeFile(`${leaf}.sub`, text);
        await fs.rename(`${leaf}.sub`, leaf);
      }
      return originalOpen(p, ...args);
    };
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        store.readBody(ref, body.bodyId),
        (e) => e.name === "CorruptContentError",
        "readBody accepted a same-content different-inode substitution",
      );
      assert.equal(swaps, 1, "swap control did not fire exactly once");
    } finally {
      fsp.open = originalOpen;
      syncBuiltinESMExports();
    }
    await fs.rm(leaf);
    await fs.rename(`${leaf}.original`, leaf);
    assert.equal((await store.readBody(ref, body.bodyId)).toString(), text);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Reserved-transition group (F1 + F2): one admission turn, honest native peak
// ---------------------------------------------------------------------------

test("settle: full-cap near-reserve settlement never materializes the marker-temp peak over the cap", async () => {
  // One retained envelope; the initial two-entry creation peak also fits.
  const cap = 16000 + 8192;
  const reserveBytes = 4096;
  const root = await tempRoot();
  const store = openStore({ root, caps: { storeMaxBytes: cap, settlementReserveBytes: reserveBytes } });
  const { investigationRef: ref } = await store.createInvestigation({ requirements: REQUIREMENTS });
  const dir = path.join(root, "investigations", ref);
  const h = await store.acquireOwnership(ref);
  try {
    await h.beginRound({ roundId: "r", intent: "start" });
    assert.equal((await fs.stat(path.join(dir, "audit", JSON.parse(await fs.readFile(path.join(dir, "incomplete.json"))).recovery.name))).size, 8192);
    await fs.writeFile(path.join(dir, "ballast"), Buffer.alloc(cap - (await treeSize(root))));
    // Summary doc sized to one byte below the reserve: the settlement fits
    // the reserved budget, but the complete native transition (summary temp,
    // then the replacement-marker temp while the old marker exists) must also
    // fit physically — the transient peak may never exceed the cap.
    const base = JSON.stringify({
      schemaVersion: 1,
      roundId: "r",
      settledAt: Date.now(),
      summary: SUMMARY(""),
    }).length;
    const uncertainty = "x".repeat(reserveBytes - base - 1);
    let peak = 0;
    const originalRename = fs.rename;
    fsp.rename = async (from, to) => {
      if (from.startsWith(root) && to.startsWith(root)) {
        peak = Math.max(peak, await treeSize(root));
      }
      return originalRename(from, to);
    };
    syncBuiltinESMExports();
    try {
      await h.settleRound("r", SUMMARY(uncertainty));
    } finally {
      fsp.rename = originalRename;
      syncBuiltinESMExports();
    }
    assert.ok(peak <= cap, `transient transition peak ${peak} exceeded the ${cap}-byte cap`);
    assert.ok((await treeSize(root)) <= cap, "final bytes over cap");
    assert.equal(JSON.parse(await fs.readFile(path.join(dir, "incomplete.json"), "utf8")).settled, true);
    await assert.rejects(fs.stat(path.join(dir, "reserve.settlement")), (e) => e.code === "ENOENT");
  } finally {
    await h.release().catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("settle: reserve removal through the marker flip holds one admission turn — a sibling cannot spend the transfer", async () => {
  // Two retained envelopes; the second begin also admits its two-entry creation peak.
  const cap = 16000 + 2 * 8192;
  const reserveBytes = 4096;
  const root = await tempRoot();
  const store = openStore({ root, caps: { storeMaxBytes: cap, settlementReserveBytes: reserveBytes } });
  const a = (await store.createInvestigation({ requirements: REQUIREMENTS })).investigationRef;
  const b = (await store.createInvestigation({ requirements: REQUIREMENTS })).investigationRef;
  const aDir = path.join(root, "investigations", a);
  const h = await store.acquireOwnership(a);
  const j = await store.acquireOwnership(b);
  try {
    await h.beginRound({ roundId: "a", intent: "start" });
    await j.beginRound({ roundId: "b", intent: "start" });
    for (const ref of [a, b]) {
      const dir = path.join(root, "investigations", ref);
      const marker = JSON.parse(await fs.readFile(path.join(dir, "incomplete.json")));
      assert.equal((await fs.stat(path.join(dir, "audit", marker.recovery.name))).size, 8192);
    }
    await fs.writeFile(path.join(aDir, "ballast"), Buffer.alloc(cap - (await treeSize(root))));
    const binds = trackAbstractBinds();
    const originalRm = fs.rm;
    let triggered = false;
    let markSeq = -1;
    let sibling = null;
    fsp.rm = async (p, ...args) => {
      const value = await originalRm(p, ...args);
      if (p === path.join(aDir, "reserve.settlement") && !triggered) {
        triggered = true;
        // The reserve just became visibly free. A sibling body write must NOT
        // be able to spend those bytes mid-transition: witness its admission
        // attempt (kernel-refused bind on the held gate), never join it
        // inside the hook.
        markSeq = binds.mark();
        sibling = await observeSiblingBlocked(() => j.stageBody("s".repeat(3500)), binds.log);
      }
      return value;
    };
    syncBuiltinESMExports();
    let error = null;
    try {
      await h.settleRound("a", SUMMARY("x".repeat(1000)));
    } catch (e) {
      error = e;
    } finally {
      fsp.rm = originalRm;
      syncBuiltinESMExports();
      binds.restore();
    }
    assert.ok(triggered, "sibling boundary did not fire");
    assert.equal(error, null, `settlement failed: ${error && error.message}`);
    const witness = witnessedAdmissionRefusal(binds.log, markSeq);
    assert.ok(
      witness,
      "no witnessed sibling admission refusal on the held store admission gate",
    );
    assert.ok(
      witness.refusalsAfter.length >= 1,
      "sibling admission attempt was not kernel-refused mid-turn",
    );
    // Join the sibling AFTER the protected operation finished.
    await sibling.joined;
    const siblingError = sibling.outcome?.error;
    assert.ok(
      siblingError?.name === "StoreCapacityError",
      `sibling must be refused by measured caps, got ${siblingError && siblingError.name}`,
    );
    assert.ok((await treeSize(root)) <= cap, "persistent bytes over cap after sibling join");
    assert.equal(
      JSON.parse(await fs.readFile(path.join(aDir, "incomplete.json"), "utf8")).settled,
      true,
    );
    await assert.rejects(fs.stat(path.join(aDir, "reserve.settlement")), (e) => e.code === "ENOENT");
  } finally {
    await h.release().catch(() => {});
    await j.release().catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("settle: failed settlement rolls back marker and reserve under the same turn; sibling still fenced", async () => {
  // Two retained envelopes; the second begin also admits its two-entry creation peak.
  const cap = 16000 + 2 * 8192;
  const reserveBytes = 4096;
  const root = await tempRoot();
  const plain = openStore({ root, caps: { storeMaxBytes: cap, settlementReserveBytes: reserveBytes } });
  const a = (await plain.createInvestigation({ requirements: REQUIREMENTS })).investigationRef;
  const b = (await plain.createInvestigation({ requirements: REQUIREMENTS })).investigationRef;
  const aDir = path.join(root, "investigations", a);
  const j = await plain.acquireOwnership(b);
  // The faulting funnel must live on the store whose handle OWNS the round:
  // a fresh acquire after release would carry a new owner identity and never
  // reach the settlement transition at all.
  const failing = openStore({
    root,
    caps: { storeMaxBytes: cap, settlementReserveBytes: reserveBytes },
    deps: {
      writeFileAtomic: async (p, bytes) => {
        if (p.includes("/settlement-a.json")) throw new Error("owned settlement fault");
        await atomicReplaceFile(p, bytes);
      },
    },
  });
  const h = await failing.acquireOwnership(a);
  try {
    await h.beginRound({ roundId: "a", intent: "start" });
    await j.beginRound({ roundId: "b", intent: "start" });
    for (const ref of [a, b]) {
      const dir = path.join(root, "investigations", ref);
      const marker = JSON.parse(await fs.readFile(path.join(dir, "incomplete.json")));
      assert.equal((await fs.stat(path.join(dir, "audit", marker.recovery.name))).size, 8192);
    }
    await fs.writeFile(path.join(aDir, "ballast"), Buffer.alloc(cap - (await treeSize(root))));
    const binds = trackAbstractBinds();
    const originalRm = fs.rm;
    let triggered = false;
    let markSeq = -1;
    let sibling = null;
    fsp.rm = async (p, ...args) => {
      const value = await originalRm(p, ...args);
      if (p === path.join(aDir, "reserve.settlement") && !triggered) {
        triggered = true;
        markSeq = binds.mark();
        sibling = await observeSiblingBlocked(() => j.stageBody("s".repeat(3500)), binds.log);
      }
      return value;
    };
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        h.settleRound("a", SUMMARY("x".repeat(100))),
        (e) => e.name === "Error" && e.message === "owned settlement fault",
        "failed settlement must reject with the exact injected settlement fault",
      );
    } finally {
      fsp.rm = originalRm;
      syncBuiltinESMExports();
      binds.restore();
      await h.release().catch(() => {});
    }
    assert.ok(triggered, "sibling boundary did not fire");
    const witness = witnessedAdmissionRefusal(binds.log, markSeq);
    assert.ok(
      witness,
      "no witnessed sibling admission refusal on the held store admission gate",
    );
    await sibling.joined;
    const siblingError = sibling.outcome?.error;
    assert.ok(
      siblingError?.name === "StoreCapacityError",
      `sibling must stay fenced by the restored reserve, got ${siblingError && siblingError.name}`,
    );
    // Rollback restored the reservation and the unsettled marker, all under
    // the held turn: bounded, recoverable, uncertainty preserved.
    assert.equal((await fs.stat(path.join(aDir, "reserve.settlement"))).size, reserveBytes);
    assert.equal(JSON.parse(await fs.readFile(path.join(aDir, "incomplete.json"), "utf8")).settled, false);
    assert.ok((await treeSize(root)) <= cap, "persistent bytes over cap after failed settlement");
  } finally {
    await h.release().catch(() => {});
    await j.release().catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("ack: reserve consumption through marker removal holds one admission turn; a fault preserves it and fences the sibling", async () => {
  // Two retained envelopes; the second begin also admits its two-entry creation peak.
  const cap = 16000 + 2 * 8192;
  const reserveBytes = 4096;
  const root = await tempRoot();
  const plain = openStore({ root, caps: { storeMaxBytes: cap, settlementReserveBytes: reserveBytes } });
  const a = (await plain.createInvestigation({ requirements: REQUIREMENTS })).investigationRef;
  const b = (await plain.createInvestigation({ requirements: REQUIREMENTS })).investigationRef;
  const aDir = path.join(root, "investigations", a);
  const h = await plain.acquireOwnership(a);
  const j = await plain.acquireOwnership(b);
  let ackStore = null;
  try {
    await h.beginRound({ roundId: "a", intent: "start" });
    await j.beginRound({ roundId: "b", intent: "start" });
    for (const ref of [a, b]) {
      const dir = path.join(root, "investigations", ref);
      const marker = JSON.parse(await fs.readFile(path.join(dir, "incomplete.json")));
      assert.equal((await fs.stat(path.join(dir, "audit", marker.recovery.name))).size, 8192);
    }
    await h.release();
    // ACK writes in place; retain the original 256-byte free-space relationship.
    await fs.writeFile(path.join(aDir, "ballast"), Buffer.alloc(cap - 256 - (await treeSize(root))));
    const marker = JSON.parse(await fs.readFile(path.join(aDir, "incomplete.json")));
    const recoveryPath = path.join(aDir, "audit", marker.recovery.name);
    const binds = trackAbstractBinds();
    ackStore = openStore({ root, caps: { storeMaxBytes: cap, settlementReserveBytes: reserveBytes } });
    const originalOpen = fs.open;
    let triggered = false;
    let markSeq = -1;
    let sibling = null;
    let ack = null;
    let error = null;
    // Payload durability fails BEFORE the seal. Reserve removal now follows
    // successful sealing, so it cannot witness this pre-seal failure.
    fsp.open = async (target, ...args) => {
      const handle = await originalOpen(target, ...args);
      if (target !== recoveryPath || (args[0] & fs.constants.O_RDWR) === 0) return handle;
      let payloadWritten = false;
      return new Proxy(handle, {
        get(target, key) {
          if (key === "write") return async (...writeArgs) => {
            const result = await target.write(...writeArgs);
            if (writeArgs[3] === 2048) payloadWritten = true;
            return result;
          };
          if (key === "sync") return async () => {
            if (payloadWritten && !triggered) {
              triggered = true;
              markSeq = binds.mark();
              sibling = await observeSiblingBlocked(() => j.stageBody("s".repeat(3500)), binds.log);
              throw new Error("owned ACK audit fault");
            }
            return target.sync();
          };
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    };
    syncBuiltinESMExports();
    try {
      ack = await ackStore.acknowledgeInterrupted(a);
    } catch (e) {
      error = e;
    } finally {
      fsp.open = originalOpen;
      syncBuiltinESMExports();
      binds.restore();
      // Both the sibling and an unexpectedly successful ACK are owned even
      // when a counterfactual makes the following rejection assertion fail.
      await sibling?.joined;
      await ack?.release();
    }
    assert.ok(
      error instanceof Error && error.message.includes("owned ACK audit fault"),
      `the injected ACK audit fault must surface truthfully, got ${error && error.message}`,
    );
    assert.ok(triggered, "sibling boundary did not fire");
    const witness = witnessedAdmissionRefusal(binds.log, markSeq);
    assert.ok(
      witness,
      "no witnessed sibling admission refusal on the held store admission gate",
    );
    await sibling.joined;
    const siblingError = sibling.outcome?.error;
    assert.ok(
      siblingError?.name === "StoreCapacityError",
      `sibling must be fenced by the restored reserve, got ${siblingError && siblingError.name}`,
    );
    assert.equal((await fs.stat(path.join(aDir, "reserve.settlement"))).size, reserveBytes);
    assert.equal(JSON.parse(await fs.readFile(path.join(aDir, "incomplete.json"), "utf8")).settled, false);
    assert.ok((await treeSize(root)) <= cap, "persistent bytes over cap after failed acknowledgment");
  } finally {
    await h.release().catch(() => {});
    await j.release().catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ACK identity group (F4): disposition matches the exact interrupted tuple
// ---------------------------------------------------------------------------

test("ack: reused round label under a different owner gets its own disposition and consumes its own reserve", async () => {
  const root = await tempRoot();
  const store = openStore({ root });
  let h = null;
  let ack1 = null;
  let ack2 = null;
  try {
    const { investigationRef: ref } = await store.createInvestigation({ requirements: REQUIREMENTS });
    const dir = path.join(root, "investigations", ref);
    const markerPath = path.join(dir, "incomplete.json");
    const auditPath = path.join(dir, "audit", "round-r.json");
    h = await store.acquireOwnership(ref);
    await h.beginRound({ roundId: "r", intent: "start" });
    const first = JSON.parse(await fs.readFile(markerPath));
    await h.appendAudit({ at: 1, kind: "ordinary", detail: "preserve caller bytes\n" });
    const firstAudit = await fs.readFile(auditPath);
    await h.release();
    ack1 = await store.acknowledgeInterrupted(ref);
    const firstPath = path.join(dir, "audit", receiptName(first));
    const firstReceipt = await fs.readFile(firstPath);
    validateSealedReceipt(firstReceipt, first);
    assert.deepEqual(await fs.readFile(auditPath), firstAudit);
    // Legal label reuse retains the first sealed instance and allocates a
    // second real envelope, distinguished by the NEW owner in the tuple.
    await ack1.beginRound({ roundId: "r", intent: "continue" });
    const second = JSON.parse(await fs.readFile(markerPath));
    assert.notEqual(first.ownerId, second.ownerId);
    await ack1.appendAudit({ at: 2, kind: "acknowledge-interrupted", detail: JSON.stringify({
      roundId: second.roundId, priorOwner: second.ownerId, revisionBase: second.revisionBase, remoteWork: "unknown",
    }) });
    const secondAudit = await fs.readFile(auditPath);
    const secondPath = path.join(dir, "audit", receiptName(second));
    const pending = await fs.readFile(secondPath);
    assert.throws(() => validateSealedReceipt(pending, second), /not sealed JSON/);
    await ack1.release();
    ack2 = await store.acknowledgeInterrupted(ref);
    await ack2.release();
    const names = (await fs.readdir(path.join(dir, "audit"))).filter((name) => /^ack-.*\.record$/.test(name)).sort();
    assert.deepEqual(names, [receiptName(first), receiptName(second)].sort(), "one receipt per distinct owner tuple");
    const secondReceipt = await fs.readFile(secondPath);
    validateSealedReceipt(await fs.readFile(firstPath), first);
    validateSealedReceipt(secondReceipt, second);
    assert.throws(() => validateSealedReceipt(secondReceipt, first), /exact interrupted tuple/);
    assert.deepEqual(await fs.readFile(firstPath), firstReceipt, "first sealed disposition changed");
    assert.deepEqual(await fs.readFile(auditPath), secondAudit, "normal audit bytes changed");
    assert.equal((await store.inspect(ref)).incomplete, null, "marker not cleared by the second acknowledgment");
    await assert.rejects(fs.stat(path.join(dir, "reserve.settlement")), (e) => e.code === "ENOENT",
      "the second owner's reserve was not consumed with its marker");
  } finally {
    await ack2?.release();
    await ack1?.release();
    await h?.release();
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Residual repair group (layer5-rollback-fifo-author, 2026-10-20): serialized
// rollback restores and non-blocking FIFO-safe opens.
// ---------------------------------------------------------------------------

// A summary refusal mid-settlement must roll the marker and the reservation
// back SERIALLY inside the held turn: constructing both restore writes before
// awaiting either lets their native temp files coexist and materialize more
// physical bytes than the cap ever admitted (observed 16157 @ cap 16000).
// The physical peak is measured after every mutating builtin call — no
// artificial barrier that would deadlock against correct serial code.
test("rollback: marker-then-reserve restore is serial; native temp peak stays under the cap", async () => {
  // One retained envelope; the initial two-entry creation peak also fits.
  const cap = 16000 + 8192;
  const reserveBytes = 4096;
  const root = await tempRoot();
  // The faulting funnel must live on the store whose handle OWNS the round.
  const failing = openStore({
    root,
    caps: { storeMaxBytes: cap, settlementReserveBytes: reserveBytes },
    deps: {
      writeFileAtomic: async (p, bytes) => {
        if (p.includes("/settlement-a.json")) throw new Error("owned summary refusal");
        await atomicReplaceFile(p, bytes);
      },
    },
  });
  const a = (await failing.createInvestigation({ requirements: REQUIREMENTS })).investigationRef;
  const aDir = path.join(root, "investigations", a);
  const h = await failing.acquireOwnership(a);
  try {
    await h.beginRound({ roundId: "a", intent: "start" });
    const marker = JSON.parse(await fs.readFile(path.join(aDir, "incomplete.json")));
    assert.equal((await fs.stat(path.join(aDir, "audit", marker.recovery.name))).size, 8192);
    await fs.writeFile(path.join(aDir, "ballast"), Buffer.alloc(cap - (await treeSize(root))));
    // Measure the PHYSICAL peak at every restore-temp rename, BEFORE the
    // rename consumes the temp. A bounded coordinated hold lets a SECOND
    // restore temp complete while the first is still un-renamed — the exact
    // coexistence concurrent restores materialize. Against correct serial
    // code no second temp can arrive, the hold expires, and the first
    // finishes: no impossible wait, no deadlock.
    let peak = 0;
    const originalRename = fsp.rename;
    const pendingReleases = new Set();
    const restoreTempRename = (from, to) =>
      String(from).includes(".tmp") &&
      (String(to).endsWith("incomplete.json") || String(to).endsWith("reserve.settlement"));
    fsp.rename = async (from, to) => {
      if (!restoreTempRename(from, to)) {
        return originalRename(from, to);
      }
      peak = Math.max(peak, await treeSize(root));
      if (pendingReleases.size > 0) {
        for (const release of pendingReleases) release();
        pendingReleases.clear();
        return originalRename(from, to);
      }
      let release;
      const held = new Promise((resolve) => {
        release = resolve;
      });
      pendingReleases.add(release);
      const timer = setTimeout(release, 250);
      await held;
      clearTimeout(timer);
      pendingReleases.delete(release);
      return originalRename(from, to);
    };
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        h.settleRound("a", SUMMARY("x".repeat(100))),
        (e) => e.name === "Error" && e.message === "owned summary refusal",
        "refused settlement must reject with the exact injected summary fault",
      );
    } finally {
      for (const release of pendingReleases) release();
      pendingReleases.clear();
      fsp.rename = originalRename;
      syncBuiltinESMExports();
    }
    assert.ok(peak <= cap, `native rollback peak ${peak} exceeded the ${cap}-byte cap`);
    // The rollback itself must still be complete and bounded.
    assert.equal((await fs.stat(path.join(aDir, "reserve.settlement"))).size, reserveBytes);
    assert.equal(JSON.parse(await fs.readFile(path.join(aDir, "incomplete.json"), "utf8")).settled, false);
    assert.ok((await treeSize(root)) <= cap, "persistent bytes over cap after rollback");
  } finally {
    await h.release().catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  }
});

// A leaf swapped to a FIFO between the type check and the open must refuse
// PROMPTLY: an O_RDONLY open of a FIFO with no writer blocks indefinitely.
// The hung-open case is bounded through an owned writer-end unblock so the
// baseline RED is an observed block, not a test timeout leak.
test("reader: leaf swapped to a FIFO at the open boundary refuses promptly, never blocks the open", async () => {
  const root = await tempRoot();
  const store = openStore({ root });
  try {
    const text = "tiny owned synthetic bytes";
    const { investigationRef: ref } = await store.createInvestigation({
      requirements: REQUIREMENTS,
      bodies: [{ content: text }],
    });
    const body = (await store.inspect(ref)).committed.snapshot.bodies[0];
    const leaf = path.join(root, "investigations", ref, "bodies", `${body.bodyId.slice(2)}.bin`);
    const originalOpen = fs.open;
    let swaps = 0;
    fsp.open = async (p, ...args) => {
      if (p === leaf && swaps++ === 0) {
        await fs.rename(leaf, `${leaf}.original`);
        await execFileAsync("mkfifo", [leaf]);
      }
      return originalOpen(p, ...args);
    };
    syncBuiltinESMExports();
    let failure = null;
    let result = null;
    const attempt = store
      .readBody(ref, body.bodyId)
      .then((r) => {
        result = r;
      }, (e) => {
        failure = e;
      });
    let timer = null;
    const timedOut = await Promise.race([
      attempt.then(() => false),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(true), 2000);
      }),
    ]);
    if (timedOut) {
      // Owned unblock: a brief writer end releases the hung read-only open so
      // the attempt settles, the handle closes through its finally, and the
      // fixture is fully cleaned before the failure is reported.
      const writer = await originalOpen(leaf, "w");
      await writer.close();
      await attempt;
    }
    clearTimeout(timer);
    fsp.open = originalOpen;
    syncBuiltinESMExports();
    assert.ok(!timedOut, "readBody blocked on the open of a FIFO-substituted leaf");
    assert.equal(swaps, 1, "FIFO swap control did not fire exactly once");
    assert.ok(failure, "readBody accepted a FIFO-substituted leaf");
    assert.equal(failure.name, "CorruptContentError");
    assert.equal(result, null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
