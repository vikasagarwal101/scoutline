/**
 * Retained record store — fresh-review repair regression teeth.
 * Ticket: unified-investigation/caller-assisted-engine/tickets/retained-records
 *
 * One durable in-tree test per fresh-cold-review (2026-10-08) finding F1–F7.
 * Every case failed against the pre-repair source (RED verified before the
 * fix batch). Real fs, real abstract sockets, exact byte counts; roots under
 * os.tmpdir(); fetch refuses.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
// Mutable alias of the builtin exports object — the ESM namespace above is
// frozen; patching the default export + syncBuiltinESMExports() is what the
// compiled dist modules observe (deterministic owned-target refusal below).
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";

import {
  openStore,
  SETTLEMENT_RESERVE_BYTES,
  SNAPSHOT_MAX_BYTES,
} from "../dist/lib/retained-record-store.js";

globalThis.fetch = () => {
  throw new Error("HTTP refused");
};

const REQUIREMENTS = { schemaVersion: 1, fields: { a: { definition: "synthetic", required: true } } };

// Every root this run creates is registered and removed in test.after —
// only current-run owned roots are touched, never pre-existing temp dirs.
const ownedRoots = new Set();
function tempRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), "rrs-fresh-")).then((p) => {
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

async function size(d) {
  let n = 0;
  for (const e of await fs.readdir(d, { withFileTypes: true })) {
    const f = path.join(d, e.name);
    if (e.isDirectory()) n += await size(f);
    else if (e.isFile()) n += (await fs.stat(f)).size;
  }
  return n;
}

async function setup(name = "s", caps) {
  const root = await tempRoot();
  const store = openStore({ root, ...caps });
  const { investigationRef: ref } = await store.createInvestigation({ requirements: REQUIREMENTS });
  return { root, store, ref, dir: path.join(root, "investigations", ref) };
}

async function ballastTo(root, dir, cap) {
  await fs.mkdir(path.join(dir, "staging"), { recursive: true });
  await fs.writeFile(path.join(dir, "staging", "ballast"), Buffer.alloc(cap - (await size(root))));
}

const tempRename = (extra = () => {}) => async (f, b) => {
  await extra(f, b);
  await fs.writeFile(f + ".temp", b);
  await fs.rename(f + ".temp", f);
};

const SUMMARY = (uncertainty = null) => ({
  status: "partial",
  measured: { searches: 0, reads: 0, judgments: 0 },
  uncertainty,
});

// F1: metadata failure must not collapse two owners onto one identity.
test("F1: metadata-faulted handles get distinct identities; successor cannot adopt unacknowledged round", async () => {
  const { root, ref } = await setup();
  const store = openStore({
    root,
    deps: {
      writeFileAtomic: async (f, b) => {
        if (f.endsWith("/owner.lock")) throw new Error("metadata fault");
        await fs.writeFile(f + ".temp", b);
        await fs.rename(f + ".temp", f);
      },
    },
  });
  const h1 = await store.acquireOwnership(ref);
  const id1 = h1.ownerId();
  await h1.beginRound({ roundId: "prior", intent: "continue" });
  await h1.release();
  const h2 = await store.acquireOwnership(ref);
  try {
    const id2 = h2.ownerId();
    assert.notEqual(id1, "unknown");
    assert.notEqual(id2, "unknown");
    assert.notEqual(id1, id2);
    await assert.rejects(
      h2.beginRound({ roundId: "next", intent: "continue" }),
      (e) => e.name === "UnacknowledgedInterruptionError",
    );
  } finally {
    await h2.release();
  }
});

// F2a: a failed settlement must retain the reserve for retry (verified-pressure-03).
test("F2a: settlement write fault preserves the reservation for retry", async () => {
  const { root, ref, dir } = await setup();
  let fail = false;
  const store = openStore({
    root,
    deps: {
      writeFileAtomic: async (f, b) => {
        if (fail && f.includes("/settlement-")) throw new Error("write fault");
        await fs.writeFile(f + ".temp", b);
        await fs.rename(f + ".temp", f);
      },
    },
  });
  const h = await store.acquireOwnership(ref);
  try {
    await h.beginRound({ roundId: "r", intent: "continue" });
    fail = true;
    await assert.rejects(h.settleRound("r", SUMMARY("failed")));
    assert.equal(
      (await fs.stat(path.join(dir, "reserve.settlement"))).size,
      SETTLEMENT_RESERVE_BYTES,
      "reservation vanished on failed settlement",
    );
  } finally {
    await h.release();
  }
});

// F2b: repeated settlement with the reserve consumed must be refused before
// materializing temp bytes past the cap (verified-pressure-09, peak 105157>100000).
test("F2b: re-settle without reserve refuses without materializing past the cap", async () => {
  const { root, ref, dir } = await setup(null, { storeMaxBytes: 100000 });
  let wroteSettlement = false;
  const store = openStore({
    root,
    caps: { storeMaxBytes: 100000 },
    deps: {
      writeFileAtomic: async (f, b) => {
        if (f.includes("/settlement-")) wroteSettlement = true;
        await fs.writeFile(f + ".temp", b);
        await fs.rename(f + ".temp", f);
      },
    },
  });
  const h = await store.acquireOwnership(ref);
  try {
    await h.beginRound({ roundId: "r", intent: "continue" });
    await h.settleRound("r", SUMMARY(null));
    const bytes = await size(root);
    await fs.mkdir(path.join(dir, "staging"), { recursive: true });
    await fs.writeFile(path.join(dir, "staging", "ballast"), Buffer.alloc(100000 - bytes - 3000));
    wroteSettlement = false;
    // The refusal must come BEFORE dispatch: no settlement byte (temp or
    // final) may materialize on a re-settle past the first.
    await assert.rejects(
      h.settleRound("r", SUMMARY("x".repeat(8000))),
      (e) => e.name === "InvalidRecordInputError" || e.name === "StoreCapacityError",
    );
    assert.equal(wroteSettlement, false, "re-settlement materialized bytes before refusal");
    assert.ok((await size(root)) <= 100000);
  } finally {
    await h.release();
  }
});

// F2c (extra-5): complete settle+marker transition fits the reserved budget at full capacity.
test("F2c: maximum bounded settlement plus marker succeeds at full store", async () => {
  const { root, ref, dir } = await setup();
  const cap = 200000;
  const store = openStore({ root, caps: { storeMaxBytes: cap } });
  const h = await store.acquireOwnership(ref);
  try {
    await h.beginRound({ roundId: "r", intent: "continue" });
    await ballastTo(root, dir, cap);
    await h.settleRound("r", SUMMARY("x".repeat(65300)));
    assert.equal((await store.inspect(ref)).incomplete.settled, true);
    assert.ok((await size(root)) <= cap);
  } finally {
    await h.release();
  }
});

// F2d (extra-4): full-cap acknowledgment seals its retained envelope in place.
test("F2d: acknowledgment at full capacity seals the retained envelope without new allocation", async () => {
  const { root, ref, dir } = await setup();
  const h = await openStore({ root }).acquireOwnership(ref);
  await h.beginRound({ roundId: "r", intent: "continue" });
  await h.release();
  const cap = 200000;
  await ballastTo(root, dir, cap);
  const limited = openStore({ root, caps: { storeMaxBytes: cap } });
  let ack = null;
  try {
    ack = await limited.acknowledgeInterrupted(ref);
    assert.equal((await limited.inspect(ref)).incomplete, null);
  } finally {
    await ack?.release();
  }
});

// F2e (extra-6): a failed settlement's reserve still fences other records.
test("F2e: failed settlement keeps the reserve counted; a sibling record cannot spend it", async () => {
  const { root, store, ref, dir } = await setup();
  const b = (await store.createInvestigation({ requirements: REQUIREMENTS })).investigationRef;
  let fail = false;
  const cap = 200000;
  const limited = openStore({
    root,
    caps: { storeMaxBytes: cap },
    deps: {
      writeFileAtomic: async (f, c) => {
        if (fail && f.includes("/settlement-")) throw new Error("fault before materialization");
        await fs.writeFile(f + ".temp", c);
        await fs.rename(f + ".temp", f);
      },
    },
  });
  const h = await limited.acquireOwnership(ref);
  const j = await limited.acquireOwnership(b);
  try {
    await h.beginRound({ roundId: "a", intent: "continue" });
    await ballastTo(root, dir, cap);
    fail = true;
    await assert.rejects(h.settleRound("a", SUMMARY(null)));
    assert.equal(
      (await fs.stat(path.join(dir, "reserve.settlement"))).size,
      SETTLEMENT_RESERVE_BYTES,
    );
    await assert.rejects(
      j.beginRound({ roundId: "b", intent: "continue" }),
      (e) => e.name === "StoreCapacityError",
    );
  } finally {
    await h.release();
    await j.release();
  }
});

// F3 (extra-1): mutators share complete marker validation.
test("F3: partial marker rejected by stageBody, not only beginRound", async () => {
  const { store, ref, dir } = await setup();
  const h = await store.acquireOwnership(ref);
  try {
    await h.beginRound({ roundId: "r", intent: "continue" });
    await fs.writeFile(
      path.join(dir, "incomplete.json"),
      JSON.stringify({ roundId: "r", ownerId: h.ownerId() }),
    );
    await assert.rejects(h.stageBody("must not be retained"), (e) => e.name === "CorruptRecordError");
  } finally {
    await h.release();
  }
});

// F4: durable over-cap damage must be inspectable, not an ordinary view.
test("F4: rollback-failed over-cap state surfaces as inspection damage", async () => {
  const { root, ref, dir } = await setup(null, { storeMaxBytes: 120000 });
  let armed = false;
  const bodyDir = path.join(dir, "bodies");
  const store = openStore({
    root,
    caps: { storeMaxBytes: 120000 },
    deps: {
      writeFileAtomic: async (f, b) => {
        await fs.writeFile(f + ".temp", b);
        await fs.rename(f + ".temp", f);
        // Fault AFTER placement (reviewer harness shape): the write lands,
        // then external ballast pushes over cap so the post-write re-measure
        // demands a rollback — a truthful ROLLBACK FAILED over-cap state
        // that must be inspectable damage, not an ordinary view.
        if (armed && f.endsWith(".bin")) {
          await fs.writeFile(path.join(dir, "external-ballast"), Buffer.alloc(120000));
        }
      },
    },
  });
  // Deterministic rollback denial: the builtin removal of the staged body is
  // refused for this exact owned target — uid-independent (unlike a chmod
  // 0o500 directory, which root ignores), restored in finally. The body stays
  // present and over-cap, exactly the state the error contract describes.
  const originalRm = fsp.rm;
  fsp.rm = async (p, ...rest) => {
    if (typeof p === "string" && p.startsWith(bodyDir) && p.endsWith(".bin")) {
      throw Object.assign(new Error("rollback unlink refused (owned fixture)"), { code: "EPERM" });
    }
    return originalRm(p, ...rest);
  };
  syncBuiltinESMExports();
  const h = await store.acquireOwnership(ref);
  try {
    await h.beginRound({ roundId: "r", intent: "continue" });
    // ACTIVE unsettled round (no settle): stageBody runs against a live round
    // with a valid reservation, so the rollback-failed over-cap fault is the
    // behavior under test — not a settled-round refusal. Proves the native
    // failed-cleanup over-cap state is inspectable damage.
    armed = true;
    await assert.rejects(h.stageBody("body"), (e) => {
      assert.equal(e.name, "StoreCapacityError");
      assert.match(e.message, /ROLLBACK FAILED/);
      return true;
    });
    const view = await store.inspect(ref);
    assert.ok(view.damage, "unfinished over-cap state not inspectable");
    assert.match(view.damage, /over-cap/);
  } finally {
    fsp.rm = originalRm;
    syncBuiltinESMExports();
    await h.release();
  }
});

// F5 (extra-2): inspect shares complete manifest validation.
test("F5: manifest with updatedAt:-1 is damage, not a verified view", async () => {
  const { store, ref, dir } = await setup();
  await fs.writeFile(
    path.join(dir, "store.json"),
    JSON.stringify({ schemaVersion: 1, committedRevision: 0, updatedAt: -1 }),
  );
  const view = await store.inspect(ref);
  assert.equal(view.committed, null);
  assert.ok(view.damage);
});

// F6 (extra-3): reopen enforces the serialized snapshot ceiling.
test("F6: oversized retained snapshot refuses verification at inspect", async () => {
  const { store, ref, dir } = await setup();
  const p = path.join(dir, "revisions", "r0.json");
  const base = JSON.parse(await fs.readFile(p, "utf8"));
  base.outcome = { status: "partial", data: { a: "x".repeat(SNAPSHOT_MAX_BYTES) }, evidence: [] };
  await fs.writeFile(p, JSON.stringify(base));
  const view = await store.inspect(ref);
  assert.equal(view.committed, null);
  assert.ok(view.damage);
});

// F7 (verified-pressure-07): injected temp+rename funnel must not enable
// destruction of a conflicting immutable revision placed at publication.
// Updated 2026-10-09 (latest-correctness P1): the store now performs the
// authoritative no-clobber placement itself and hands the funnel a
// revision-local STAGING name (never the final r1.json). A rename-replaced
// conflict (a different inode at the final name) is detected and preserved.
test("F7: conflicting r1.json placed by an injected funnel is refused, not overwritten", async () => {
  const { root, ref, dir } = await setup();
  const base = JSON.parse(await fs.readFile(path.join(dir, "revisions", "r0.json"), "utf8"));
  let conflict, conflictInode;
  let conflictPlacements = 0;
  const store = openStore({
    root,
    deps: {
      writeFileAtomic: async (f, b) => {
        if (/r1\.json\..*\.stage\.tmp$/.test(f)) {
          // Install a rename-replaced conflict at the FINAL immutable name.
          conflict = JSON.stringify({
            ...base,
            revision: 1,
            parentRevision: 0,
            createdAt: base.createdAt + 999,
          });
          await fs.writeFile(f + ".foreign", conflict);
          await fs.rename(f + ".foreign", path.join(dir, "revisions", "r1.json"));
          conflictInode = (await fs.stat(path.join(dir, "revisions", "r1.json"))).ino;
          conflictPlacements += 1;
        }
        await fs.writeFile(f + ".temp", b);
        await fs.rename(f + ".temp", f);
      },
    },
  });
  const h = await store.acquireOwnership(ref);
  try {
    await h.beginRound({ roundId: "r", intent: "continue" });
    await assert.rejects(
      h.commitRevision({
        expectedRevision: 0,
        snapshot: { ...base, revision: 1, parentRevision: 0 },
      }),
      (e) => e.name === "CorruptContentError" && e.code === "CORRUPT_CONTENT" &&
        e.message === `Native retained file identity changed: ${path.join(dir, "revisions", "r1.json")}`,
      "foreign final must refuse at the exact owned native identity boundary",
    );
    assert.equal(conflictPlacements, 1, "revision staging must install the foreign final exactly once");
    const final = path.join(dir, "revisions", "r1.json");
    assert.equal(await fs.readFile(final, "utf8"), conflict, "conflict bytes destroyed");
    assert.equal((await fs.stat(final)).ino, conflictInode, "conflict inode replaced");
    assert.equal((await store.inspect(ref)).committed.revision, 0);
  } finally {
    await h.release();
  }
});
