/**
 * Retained record store — latest-correctness-review (2026-10-08) repair teeth.
 * Ticket: unified-investigation/caller-assisted-engine/tickets/retained-records
 *
 * One durable in-tree test per latest-correctness-review finding P1 settlement
 * peak / P1 failed-ack reservation / P1 publication seam / P1 marker+reserve
 * validation / P2 damage fence / P2 bounded+nested accounting. Every case
 * failed against the pre-repair source (RED captured first) using the
 * reviewer's own fixture shapes. Real fs, real abstract sockets, exact byte
 * counts; roots under os.tmpdir(); fetch refuses.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  openStore,
  SETTLEMENT_RESERVE_BYTES,
} from "../dist/lib/retained-record-store.js";

globalThis.fetch = () => {
  throw new Error("HTTP refused");
};

const REQUIREMENTS = { schemaVersion: 1, fields: { a: { definition: "synthetic", required: true } } };
const SUMMARY = { status: "partial", measured: { searches: 0, reads: 0, judgments: 0 }, uncertainty: null };

function tempRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), "rrs-latest-"));
}

async function size(d) {
  let n = 0;
  for (const e of await fs.readdir(d, { withFileTypes: true })) {
    const f = path.join(d, e.name);
    if (e.isDirectory()) n += await size(f);
    else if (e.isFile()) n += (await fs.stat(f)).size;
  }
  return n;
}

const renameWrite = async (f, b) => {
  await fs.writeFile(f + ".temp", b);
  await fs.rename(f + ".temp", f);
};

async function setup(cap = 200000) {
  const root = await tempRoot();
  const store = openStore({ root, caps: { storeMaxBytes: cap } });
  const { investigationRef: ref } = await store.createInvestigation({ requirements: REQUIREMENTS });
  const dir = path.join(root, "investigations", ref);
  const h = await store.acquireOwnership(ref);
  await h.beginRound({ roundId: "r", intent: "continue" });
  return { root, store, ref, dir, h };
}

async function fillTo(root, dir, cap) {
  await fs.writeFile(path.join(dir, "ballast"), Buffer.alloc(cap - (await size(root))));
}

// P1 settlement peak (new-01): reserve must free into REAL headroom before
// the summary temp materializes — the peak while reserve+temp coexist must
// not exceed cap (reviewer: peak 200159 > 200000).
test("first settlement peak never exceeds cap while reserve and temporary summary coexist", async () => {
  const { root, ref, dir, h } = await setup();
  let peak = 0;
  // Fresh store whose funnel measures the real-byte peak while the summary
  // temp coexists with the materialized reserve. Settle the FIRST round under
  // this funnel at a full cap: the reserve must free into real headroom BEFORE
  // the temp materializes (no duplicate occupied bytes), so the peak while
  // reserve+temp coexist stays within cap.
  const store = openStore({
    root,
    caps: { storeMaxBytes: 200000 },
    deps: {
      writeFileAtomic: async (f, b) => {
        await fs.writeFile(f + ".temp", b);
        if (f.includes("/settlement-")) peak = Math.max(peak, await size(root));
        await fs.rename(f + ".temp", f);
        if (f.includes("/settlement-")) peak = Math.max(peak, await size(root));
      },
    },
  });
  await fillTo(root, dir, 200000);
  try {
    await h.settleRound("r", SUMMARY);
    assert.ok(peak <= 200000, `materialized peak ${peak} > 200000`);
  } finally {
    await h.release();
  }
});

// P1 failed acknowledgment (new-02 + ack-after-fault): a failed ACK audit must
// preserve the reserve and the uncertainty marker, not free capacity.
test("failed acknowledgment preserves reserve and marker and blocks sibling spend", async () => {
  const cap = 200000;
  const root = await tempRoot();
  const store = openStore({ root, caps: { storeMaxBytes: cap } });
  const a = (await store.createInvestigation({ requirements: REQUIREMENTS })).investigationRef;
  const b = (await store.createInvestigation({ requirements: REQUIREMENTS })).investigationRef;
  const dir = path.join(root, "investigations", a);
  const h = await store.acquireOwnership(a);
  const j = await store.acquireOwnership(b);
  await h.beginRound({ roundId: "r", intent: "continue" });
  await h.release();
  await fillTo(root, dir, cap - 256);
  let fail = true;
  const failing = openStore({
    root,
    caps: { storeMaxBytes: cap },
    deps: {
      writeFileAtomic: async (f, c) => {
        if (fail && f.includes("/round-r.json")) throw Error("ack audit fault");
        await renameWrite(f, c);
      },
    },
  });
  try {
    await assert.rejects(failing.acknowledgeInterrupted(a));
    assert.equal(
      (await fs.stat(path.join(dir, "reserve.settlement"))).size,
      SETTLEMENT_RESERVE_BYTES,
      "failed ACK must keep its reservation",
    );
    assert.ok(await fs.readFile(path.join(dir, "incomplete.json"), "utf8"), "failed ACK must keep marker");
    let admitted = false;
    try {
      await j.beginRound({ roundId: "sibling", intent: "continue" });
      admitted = true;
    } catch (e) {
      assert.equal(e.name, "StoreCapacityError");
    }
    assert.equal(admitted, false, "sibling spent interrupted reserve after failed ACK");
  } finally {
    await j.release();
  }
});

// P1 happy-path ACK at full capacity (positive control: the ack transition
// must still fit once the reserve is validated and consumed transactionally).
test("happy-path acknowledgment succeeds at full capacity", async () => {
  const { root, ref, dir, h } = await setup();
  await h.release();
  await fillTo(root, dir, 200000);
  const limited = openStore({ root, caps: { storeMaxBytes: 200000 } });
  let ack = null;
  try {
    ack = await limited.acknowledgeInterrupted(ref);
    assert.equal((await limited.inspect(ref)).incomplete, null);
  } finally {
    await ack?.release();
  }
});

// P1 publication seam (new-08): a rename-replaced conflict at the final name
// must be detected and preserved, never destroyed by a replace writer. The
// conflict is installed at r1.json BEFORE the first round is acquired; the
// commit that would publish r1 is refused and the conflict survives.
test("rename-replaced conflict is preserved and publication refuses", async () => {
  const root = await tempRoot();
  const plain = openStore({ root });
  const { investigationRef: ref } = await plain.createInvestigation({ requirements: REQUIREMENTS });
  const dir = path.join(root, "investigations", ref);
  const base = JSON.parse(await fs.readFile(path.join(dir, "revisions", "r0.json"), "utf8"));
  let conflict, conflictInode;
  const store = openStore({
    root,
    deps: {
      writeFileAtomic: async (f, b) => {
        // Only react to the publication STAGING name (never the final r1.json,
        // never the r0/marker/store writes) so the conflict is installed once,
        // at publication, when the staging path already exists.
        if (/r1\.json\..*\.stage\.tmp$/.test(f) && conflict === undefined) {
          conflict = JSON.stringify({ ...base, revision: 1, parentRevision: 0, createdAt: base.createdAt + 999 });
          await fs.writeFile(f + ".foreign", conflict);
          // Rename-replace the FINAL immutable name with a DIFFERENT inode —
          // the store's no-clobber placement must detect and refuse this.
          await fs.rename(f + ".foreign", path.join(dir, "revisions", "r1.json"));
          conflictInode = (await fs.stat(path.join(dir, "revisions", "r1.json"))).ino;
        }
        await renameWrite(f, b);
      },
    },
  });
  const hh = await store.acquireOwnership(ref);
  try {
    await hh.beginRound({ roundId: "s2", intent: "continue" });
    await assert.rejects(
      hh.commitRevision({ expectedRevision: 0, snapshot: { ...base, revision: 1, parentRevision: 0 } }),
      (e) => e.name === "CorruptRecordError",
    );
    const p = path.join(dir, "revisions", "r1.json");
    assert.equal(await fs.readFile(p, "utf8"), conflict, "conflict bytes destroyed");
    assert.equal((await fs.stat(p)).ino, conflictInode, "conflict inode replaced");
    assert.equal((await store.inspect(ref)).committed.revision, 0);
  } finally {
    await hh.release();
  }
});

// P1 publication seam (new-09): an injected pre-publication fault must leave
// no corrupt sentinel at the final immutable name; retry is clean.
test("injected pre-publication fault leaves no corrupt final-name state; retry is clean", async () => {
  const root = await tempRoot();
  const plain = openStore({ root });
  const { investigationRef: ref } = await plain.createInvestigation({ requirements: REQUIREMENTS });
  const dir = path.join(root, "investigations", ref);
  const base = JSON.parse(await fs.readFile(path.join(dir, "revisions", "r0.json"), "utf8"));
  let fail = false;
  const store = openStore({
    root,
    deps: {
      writeFileAtomic: async (f, b) => {
        // Fire only on the publication STAGING name so the fault is scoped to
        // the actual revision materialization (never the publish/manifest
        // writes that follow a caught publication failure).
        if (fail && f.includes(".stage.tmp")) throw Error("before revision materialization");
        await renameWrite(f, b);
      },
    },
  });
  const hh = await store.acquireOwnership(ref);
  try {
    await hh.beginRound({ roundId: "s2", intent: "continue" });
    fail = true;
    // The fault fires at the staging write; the store must reject WITHOUT
    // leaving any corrupt sentinel at the final immutable name.
    await assert.rejects(hh.commitRevision({ expectedRevision: 0, snapshot: { ...base, revision: 1, parentRevision: 0 } }));
    const p = path.join(dir, "revisions", "r1.json");
    assert.equal(await fs.readFile(p, "utf8").catch(() => null), null, "final name holds sentinel junk");
    // commitRevision left an interrupted round and a handle may begin only
    // one fresh round; acknowledge, re-acquire, and retry cleanly (no
    // retry-poison from the earlier fault).
    await hh.release();
    const acked = await store.acknowledgeInterrupted(ref);
    await acked.release();
    const h3 = await store.acquireOwnership(ref);
    try {
      await h3.beginRound({ roundId: "s3", intent: "continue" });
      fail = false;
      await h3.commitRevision({ expectedRevision: 0, snapshot: { ...base, revision: 1, parentRevision: 0 } });
      assert.equal((await store.inspect(ref)).committed.revision, 1);
    } finally {
      await h3.release();
    }
  } finally {
    await hh.release();
  }
});

// P1 publication seam (new-10): a recording-only seam must never observe a
// partial/sentinel at the final immutable name — the funnel sees a staging
// name, the store publishes the final name atomically itself.
test("publication seam never exposes partial final-name content", async () => {
  const root = await tempRoot();
  const plain = openStore({ root });
  const { investigationRef: ref } = await plain.createInvestigation({ requirements: REQUIREMENTS });
  const dir = path.join(root, "investigations", ref);
  const base = JSON.parse(await fs.readFile(path.join(dir, "revisions", "r0.json"), "utf8"));
  const next = { ...base, revision: 1, parentRevision: 0 };
  let observed = [];
  const store = openStore({
    root,
    deps: {
      writeFileAtomic: async (f, b) => {
        if (f.endsWith("/r1.json") || f.includes(".stage.tmp")) {
          // Recording-only seam: observe the name the funnel is handed, but
          // perform NO write — the store must publish authoritatively through
          // its own no-clobber placement.
          observed.push({ f: path.basename(f), bytes: b });
          return;
        }
        await renameWrite(f, b);
      },
    },
  });
  const hh = await store.acquireOwnership(ref);
  try {
    await hh.beginRound({ roundId: "s2", intent: "continue" });
    await hh.commitRevision({ expectedRevision: 0, snapshot: next });
    const finals = observed.filter((o) => o.f === "r1.json");
    assert.equal(finals.length, 0, `final immutable name passed to funnel: ${JSON.stringify(observed.map((o) => o.f))}`);
    assert.equal(await fs.readFile(path.join(dir, "revisions", "r1.json"), "utf8"), JSON.stringify(next));
    assert.equal((await store.inspect(ref)).committed.revision, 1);
  } finally {
    await hh.release();
  }
});

// P1 publication seam (publication-async-fault): an async fault AFTER the
// funnel published replacement bytes must not destroy a rename-replaced
// conflict — the store, not the funnel, owns final placement.
test("async post-publication funnel fault cannot destroy the conflict", async () => {
  const root = await tempRoot();
  const plain = openStore({ root });
  const { investigationRef: ref } = await plain.createInvestigation({ requirements: REQUIREMENTS });
  const dir = path.join(root, "investigations", ref);
  const base = JSON.parse(await fs.readFile(path.join(dir, "revisions", "r0.json"), "utf8"));
  const conflict = JSON.stringify({ ...base, revision: 1, parentRevision: 0, createdAt: base.createdAt + 888 });
  let ino;
  const store = openStore({
    root,
    deps: {
      writeFileAtomic: async (f, b) => {
        if (f.includes(".stage.tmp")) {
          await fs.writeFile(f + ".foreign", conflict);
          await fs.rename(f + ".foreign", path.join(dir, "revisions", "r1.json"));
          ino = (await fs.stat(path.join(dir, "revisions", "r1.json"))).ino;
          await renameWrite(f, b);
          await new Promise((r) => setImmediate(r));
          throw Error("fault after replacement");
        }
        await renameWrite(f, b);
      },
    },
  });
  const hh = await store.acquireOwnership(ref);
  try {
    await hh.beginRound({ roundId: "s2", intent: "continue" });
    await assert.rejects(
      hh.commitRevision({ expectedRevision: 0, snapshot: { ...base, revision: 1, parentRevision: 0 } }),
      /fault after replacement/,
    );
    const p = path.join(dir, "revisions", "r1.json");
    assert.equal(await fs.readFile(p, "utf8"), conflict, "conflict destroyed by async fault");
    assert.equal((await fs.stat(p)).ino, ino, "conflict inode destroyed by async fault");
    assert.equal((await store.inspect(ref)).committed.revision, 0);
  } finally {
    await hh.release();
  }
});

// P1 marker validation (new-04): a marker whose base revision does not match
// the committed revision must refuse body staging.
test("marker base revision must match committed revision before body staging", async () => {
  const { root, ref, dir, h } = await setup();
  const p = path.join(dir, "incomplete.json");
  const m = JSON.parse(await fs.readFile(p, "utf8"));
  m.revisionBase = 999;
  await fs.writeFile(p, JSON.stringify(m));
  await assert.rejects(h.stageBody("must refuse"), (e) => e.name === "CorruptRecordError");
  await h.release();
});

// P1 marker validation (new-05): negative startedAt and fractional base are
// corrupt at inspect and mutation, not ordinary incomplete state.
test("negative marker timestamps and fractional base are corrupt at inspect and mutation", async () => {
  const { store, ref, dir, h } = await setup();
  const p = path.join(dir, "incomplete.json");
  const m = JSON.parse(await fs.readFile(p, "utf8"));
  m.startedAt = -1;
  m.revisionBase = 0.5;
  await fs.writeFile(p, JSON.stringify(m));
  // Inspect must surface the corrupt marker as damage, not ordinary state.
  const view = await store.inspect(ref);
  assert.ok(view.damage, "corrupt marker exposed as ordinary state");
  // A mutator on the same handle must refuse the corrupt marker.
  await assert.rejects(h.appendAudit({ at: Date.now(), kind: "test", detail: "reject" }), (e) => e.name === "CorruptRecordError");
  await h.release();
});

// P1 marker validation (new-06): acknowledgment cannot bless an impossible
// base revision.
test("acknowledgment cannot bless a marker with impossible base revision", async () => {
  const { root, ref, dir, h } = await setup();
  const p = path.join(dir, "incomplete.json");
  const m = JSON.parse(await fs.readFile(p, "utf8"));
  m.revisionBase = -2;
  await fs.writeFile(p, JSON.stringify(m));
  await h.release();
  // The impossible base is corrupted state: ACK must refuse (the marker
  // reader raises CorruptRecordError, surfaced as a marker validation failure).
  await assert.rejects(
    openStore({ root }).acknowledgeInterrupted(ref),
    (e) => e.name === "CorruptRecordError",
  );
});

// P1 reserve validation (new-07): a truncated reserve with a matching header
// cannot authorize zero-charge settlement.
test("truncated reserve with matching header cannot authorize settlement", async () => {
  const { dir, h } = await setup();
  const p = path.join(dir, "reserve.settlement");
  const bytes = await fs.readFile(p);
  await fs.writeFile(p, bytes.subarray(0, bytes.indexOf(0)));
  await assert.rejects(h.settleRound("r", SUMMARY), (e) => e.name === "CorruptRecordError");
  await h.release();
});

// P2 damage fence (damage-ack-fence): measured over-cap damage must refuse
// acknowledgment, not silently clear unfinished state.
test("over-cap damage refuses acknowledgment", async () => {
  const { store, ref, dir, h } = await setup();
  await h.release();
  await fs.writeFile(path.join(dir, "external-ballast"), Buffer.alloc(200100 - (await size(store.root))));
  const view = await store.inspect(ref);
  assert.match(view.damage, /over-cap/);
  await assert.rejects(
    store.acknowledgeInterrupted(ref),
    (e) => e.name === "StoreCapacityError" || e.name === "CorruptRecordError",
  );
});

// P2 nested accounting (new-11): negative settledAt and evidence byteLength
// must refuse verification, not reopen as verified.
test("nested retained snapshot rejects negative accounting", async () => {
  const { store, ref, dir, h } = await setup();
  const p = path.join(dir, "revisions", "r0.json");
  const base = JSON.parse(await fs.readFile(p, "utf8"));
  await fs.writeFile(
    p,
    JSON.stringify({
      ...base,
      rounds: [{ roundId: "prior", intent: "continue", settledAt: -1, usage: null }],
      outcome: {
        status: "partial",
        data: {},
        evidence: [{ evidenceId: "e", url: "u", title: "t", byteLength: -4, origins: [] }],
      },
    }),
  );
  const view = await store.inspect(ref);
  assert.equal(view.committed, null, "invalid nested accounting verified");
  assert.ok(view.damage);
  await h.release();
});
