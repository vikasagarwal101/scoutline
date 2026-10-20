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
import * as fs from "node:fs/promises";
// Mutable alias of the builtin exports object — the ESM namespace above is
// frozen; patching the default export + syncBuiltinESMExports() is what the
// compiled dist modules observe (same mechanism as the reviewer controls).
import fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { execFile as execFileCb } from "node:child_process";
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
 * Start a sibling operation and observe its ADMISSION ATTEMPT without joining
 * it: the caller invokes this inside a boundary hook that fires while the
 * protected transition is mid-flight. An operation that is not serialized
 * against the transition completes within a handful of local-fs event-loop
 * turns; one correctly blocked on the store admission gate cannot complete
 * until the transition finishes. Never await the sibling inside the hook.
 */
async function observeSiblingBlocked(start) {
  const observed = { pending: true, outcome: null, joined: null };
  observed.joined = (async () => {
    try {
      await start();
      observed.outcome = { ok: true };
    } catch (error) {
      observed.outcome = { error };
    }
    observed.pending = false;
  })();
  for (let i = 0; i < 50; i++) await new Promise((resolve) => setImmediate(resolve));
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
  const cap = 16000;
  const reserveBytes = 4096;
  const root = await tempRoot();
  const store = openStore({ root, caps: { storeMaxBytes: cap, settlementReserveBytes: reserveBytes } });
  const { investigationRef: ref } = await store.createInvestigation({ requirements: REQUIREMENTS });
  const dir = path.join(root, "investigations", ref);
  const h = await store.acquireOwnership(ref);
  try {
    await h.beginRound({ roundId: "r", intent: "start" });
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
  const cap = 16000;
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
    await fs.writeFile(path.join(aDir, "ballast"), Buffer.alloc(cap - (await treeSize(root))));
    const originalRm = fs.rm;
    let triggered = false;
    let sibling = null;
    fsp.rm = async (p, ...args) => {
      const value = await originalRm(p, ...args);
      if (p === path.join(aDir, "reserve.settlement") && !triggered) {
        triggered = true;
        // The reserve just became visibly free. A sibling body write must NOT
        // be able to spend those bytes mid-transition: observe its admission
        // attempt, do NOT join it inside the hook.
        sibling = await observeSiblingBlocked(() => j.stageBody("s".repeat(3500)));
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
    }
    assert.ok(triggered, "sibling boundary did not fire");
    assert.equal(error, null, `settlement failed: ${error && error.message}`);
    assert.ok(sibling.pending, "sibling body write completed while the settlement held admission");
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
  const cap = 16000;
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
    await fs.writeFile(path.join(aDir, "ballast"), Buffer.alloc(cap - (await treeSize(root))));
    const originalRm = fs.rm;
    let triggered = false;
    let sibling = null;
    fsp.rm = async (p, ...args) => {
      const value = await originalRm(p, ...args);
      if (p === path.join(aDir, "reserve.settlement") && !triggered) {
        triggered = true;
        sibling = await observeSiblingBlocked(() => j.stageBody("s".repeat(3500)));
      }
      return value;
    };
    syncBuiltinESMExports();
    try {
      await assert.rejects(h.settleRound("a", SUMMARY("x".repeat(100))));
    } finally {
      fsp.rm = originalRm;
      syncBuiltinESMExports();
      await h.release().catch(() => {});
    }
    assert.ok(triggered, "sibling boundary did not fire");
    assert.ok(sibling.pending, "sibling body write completed while the failed settlement held admission");
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
  const cap = 16000;
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
    await h.release();
    // Leave just enough headroom for the ack's advisory metadata write.
    await fs.writeFile(path.join(aDir, "ballast"), Buffer.alloc(cap - 256 - (await treeSize(root))));
    ackStore = openStore({
      root,
      caps: { storeMaxBytes: cap, settlementReserveBytes: reserveBytes },
      deps: {
        writeFileAtomic: async (p, bytes) => {
          if (p.endsWith("/round-a.json")) throw new Error("owned ACK audit fault");
          await atomicReplaceFile(p, bytes);
        },
      },
    });
    const originalRm = fs.rm;
    let triggered = false;
    let sibling = null;
    fsp.rm = async (p, ...args) => {
      const value = await originalRm(p, ...args);
      if (p === path.join(aDir, "reserve.settlement") && !triggered) {
        triggered = true;
        sibling = await observeSiblingBlocked(() => j.stageBody("s".repeat(3500)));
      }
      return value;
    };
    syncBuiltinESMExports();
    let ack = null;
    let error = null;
    try {
      ack = await ackStore.acknowledgeInterrupted(a);
    } catch (e) {
      error = e;
    } finally {
      fsp.rm = originalRm;
      syncBuiltinESMExports();
    }
    assert.ok(error instanceof Error, "the injected ACK audit fault must surface truthfully");
    assert.ok(triggered, "sibling boundary did not fire");
    assert.ok(sibling.pending, "sibling body write completed while the acknowledgment held admission");
    await sibling.joined;
    const siblingError = sibling.outcome?.error;
    assert.ok(
      siblingError?.name === "StoreCapacityError",
      `sibling must be fenced by the restored reserve, got ${siblingError && siblingError.name}`,
    );
    assert.equal((await fs.stat(path.join(aDir, "reserve.settlement"))).size, reserveBytes);
    assert.equal(JSON.parse(await fs.readFile(path.join(aDir, "incomplete.json"), "utf8")).settled, false);
    assert.ok((await treeSize(root)) <= cap, "persistent bytes over cap after failed acknowledgment");
    await ack?.release().catch(() => {});
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
  try {
    const { investigationRef: ref } = await store.createInvestigation({ requirements: REQUIREMENTS });
    const dir = path.join(root, "investigations", ref);
    const h = await store.acquireOwnership(ref);
    await h.beginRound({ roundId: "r", intent: "start" });
    const firstOwner = h.ownerId();
    await h.release();
    const ack1 = await store.acknowledgeInterrupted(ref);
    try {
      // Legal label reuse: beginRound permits a path-safe round id that a
      // prior acknowledged round already used — under a NEW owner identity.
      await ack1.beginRound({ roundId: "r", intent: "continue" });
      const secondOwner = ack1.ownerId();
      assert.notEqual(firstOwner, secondOwner);
      await ack1.release();
      const ack2 = await store.acknowledgeInterrupted(ref);
      await ack2.release();
      const auditDoc = JSON.parse(await fs.readFile(path.join(dir, "audit", "round-r.json"), "utf8"));
      const rows = auditDoc.rows.filter((row) => row.kind === "acknowledge-interrupted");
      assert.equal(rows.length, 2, `expected one disposition per interrupted instance, found ${rows.length}`);
      assert.ok(
        rows.some((row) => JSON.parse(row.detail).priorOwner === secondOwner),
        "no disposition recorded for the second owner's interruption",
      );
      assert.equal((await store.inspect(ref)).incomplete, null, "marker not cleared by the second acknowledgment");
      await assert.rejects(
        fs.stat(path.join(dir, "reserve.settlement")),
        (e) => e.code === "ENOENT",
        "the second owner's reserve was not consumed with its marker",
      );
    } catch (e) {
      await ack1.release().catch(() => {});
      throw e;
    }
  } finally {
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
  const cap = 16000;
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
      await assert.rejects(h.settleRound("a", SUMMARY("x".repeat(100))));
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
