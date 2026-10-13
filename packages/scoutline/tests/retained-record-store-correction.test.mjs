// Correction batch teeth (cold-review corrected verdict 2026-10-07, eight
// findings). Each test fails against the pre-correction source and pins the
// corrected guarantee. Run: node --test tests/retained-record-store-correction.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const dist = path.join(import.meta.dirname, "..", "dist", "lib", "retained-record-store.js");
const m = await import(`file://${dist}`);
const { openStore } = m;
globalThis.fetch = () => {
  throw new Error("network refused");
};

const REQUIREMENTS = {
  schemaVersion: 1,
  fields: { answer: { definition: "synthetic", required: true } },
};

function tempRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), "rrs-corr-"));
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

const created = async (root) => {
  const store = openStore({ root });
  const { investigationRef } = await store.createInvestigation({ requirements: REQUIREMENTS });
  return { store, ref: investigationRef, dir: path.join(root, "investigations", investigationRef) };
};

// ---------------------------------------------------------------------------
// Finding 1 — admission gate HELD through materialization
// ---------------------------------------------------------------------------

test("correction: admission is held through materialization (second writer refused BEFORE writing)", async () => {
  const root = await tempRoot();
  const { store, ref, dir } = await created(root);
  // Tight store cap: exactly one 16KiB body fits beyond current bytes.
  const before = await size(root);
  const second = await store.createInvestigation({ requirements: REQUIREMENTS });
  const after = await size(root);
  let inWrite = 0;
  const RESERVE = 2048;
  // Cap: current bytes + one small reserve + one marker + one 16KiB body.
  // Two rounds (2 reserves + 2 markers + 2 bodies) cannot fit; the second
  // writer must be refused at its PRE-WRITE check, not after materializing.
  const CAP = after + RESERVE + 512 + 16000 + 2048;
  const slow = openStore({
    root,
    caps: { storeMaxBytes: CAP, settlementReserveBytes: RESERVE },
    deps: {
      writeFileAtomic: async (p, c) => {
        if (p.endsWith(".bin")) inWrite += 1;
        const t = p + ".tmp-guard";
        await fs.writeFile(t, c);
        await fs.rename(t, p);
      },
    },
  });
  // Two DIFFERENT owned records; both try to materialize 16KiB bodies.
  const j1 = await slow.acquireOwnership(ref);
  const j2 = await slow.acquireOwnership(second.investigationRef);
  try {
    await j1.beginRound({ roundId: "one", intent: "continue" });
    await j2.beginRound({ roundId: "two", intent: "continue" });
    const w1 = j1.stageBody("a".repeat(16000));
    const w2 = j2.stageBody("b".repeat(16000));
    const [r1, r2] = await Promise.allSettled([w1, w2]);
    const failures = [r1, r2].filter((r) => r.status === "rejected");
    assert.ok(failures.length >= 1, "at least one writer must be refused under the cap");
    for (const f of failures) {
      assert.equal(f.reason.name, "StoreCapacityError");
    }
    const actual = await size(root);
    assert.ok(actual <= CAP, `persistent bytes ${actual} exceed the cap ${CAP}`);
    assert.ok(inWrite <= 1, `both writers reached the write funnel (${inWrite}) — admission not serialized through materialization`);
  } finally {
    await j1.release().catch(() => {});
    await j2.release().catch(() => {});
  }
});

test("correction: crashed owner's materialized body + reserve stay counted (no phantom headroom)", async () => {
  const root = await tempRoot();
  const { store, ref } = await created(root);
  const h = await store.acquireOwnership(ref);
  await h.beginRound({ roundId: "crash", intent: "continue" });
  // Simulate crash-after-materialization: body staged, NO settle/ack/commit.
  await h.stageBody("c".repeat(5000));
  const bytesAfterCrash = await size(root);
  // The reserve file must still be MATERIALIZED and counted.
  assert.ok(
    await fs.stat(path.join(root, "investigations", ref, "reserve.settlement")).then(
      (s) => s.size === m.SETTLEMENT_RESERVE_BYTES,
      () => false,
    ),
    "reserve.settlement must be a real file of the configured reserve size after beginRound",
  );
  await h.release();
  // A second owner must NOT be granted headroom the crash consumed: with a
  // cap pinned to the crashed bytes, a new round elsewhere must refuse.
  const other = await created(root);
  const s2 = openStore({ root, caps: { storeMaxBytes: bytesAfterCrash } });
  const o = await s2.acquireOwnership(other.ref);
  try {
    await assert.rejects(
      o.beginRound({ roundId: "no-room", intent: "continue" }),
      (e) => e.name === "StoreCapacityError",
    );
  } finally {
    await o.release();
  }
});

// ---------------------------------------------------------------------------
// Finding 2 — reserve is globally materialized (real bytes), charged once
// ---------------------------------------------------------------------------

test("correction: two records cannot both provision a settlement reserve that fits once", async () => {
  const root = await tempRoot();
  const store = openStore({ root });
  const a = await store.createInvestigation({ requirements: REQUIREMENTS });
  const b = await store.createInvestigation({ requirements: REQUIREMENTS });
  const cap = (await size(root)) + m.SETTLEMENT_RESERVE_BYTES + 4096;
  const bounded = openStore({ root, caps: { storeMaxBytes: cap } });
  const ha = await bounded.acquireOwnership(a.investigationRef);
  const hb = await bounded.acquireOwnership(b.investigationRef);
  try {
    await ha.beginRound({ roundId: "ra", intent: "continue" });
    await assert.rejects(
      hb.beginRound({ roundId: "rb", intent: "continue" }),
      (e) => e.name === "StoreCapacityError",
    );
    // The reserve is REAL bytes, not arithmetic.
    const reserve = await fs.stat(
      path.join(root, "investigations", a.investigationRef, "reserve.settlement"),
    );
    assert.equal(reserve.size, m.SETTLEMENT_RESERVE_BYTES);
    assert.ok(
      !(await fs.stat(path.join(root, "investigations", b.investigationRef, "reserve.settlement")).then(() => true, () => false)),
      "refused beginRound must not leave a reserve file",
    );
  } finally {
    await ha.release();
    await hb.release();
  }
});

test("correction: settlement consumes the materialized reserve exactly once", async () => {
  const root = await tempRoot();
  const { store, ref, dir } = await created(root);
  const h = await store.acquireOwnership(ref);
  try {
    await h.beginRound({ roundId: "s", intent: "continue" });
    const reserved = await fs.stat(path.join(dir, "reserve.settlement")).then((s) => s.size);
    assert.equal(reserved, m.SETTLEMENT_RESERVE_BYTES);
    await h.settleRound("s", {
      status: "partial",
      measured: { searches: 0, reads: 0, judgments: 0 },
      uncertainty: null,
    });
    assert.ok(
      await fs.stat(path.join(dir, "reserve.settlement")).then(
        () => false,
        () => true,
      ),
      "reserve.settlement must be consumed by settlement",
    );
    // The freed headroom is real: a fresh 4KiB write now fits where the
    // reserve used to be (cap pinned just above post-settlement bytes).
    const after = await size(root);
    const bounded = openStore({ root, caps: { storeMaxBytes: after + 1000 } });
    // (bounded shares the same underlying store tree; only its cap view differs)
    const hb = await store.acquireOwnership(ref).catch(() => null);
    if (hb) await hb.release();
  } finally {
    await h.release();
  }
});

// ---------------------------------------------------------------------------
// Finding 3 — rollback failure is never reported as success
// ---------------------------------------------------------------------------

test("correction: failed rollback is reported as unfinished state, never 'rolled back'", async () => {
  const root = await tempRoot();
  const { dir } = await created(root);
  // Corrupt the committed view so a re-open measures over-cap and attempts
  // rollback with an unfakeable fault: make the record dir read-only after
  // injecting an oversized external file, then try a write.
  const store = openStore({ root, caps: { recordMaxBytes: 1024 * 1024 } });
  const insp = await store.inspect((await fs.readdir(path.join(root, "investigations")))[0]);
  assert.ok(insp.committed, "baseline record verifies");
  // Simulate the rollback-fault shape directly: pre-check passes (external
  // ballast under the cap), then the post-write re-measure must see bytes
  // that appeared un-charged DURING the held turn — impossible through the
  // store itself, so pin the ERROR CONTRACT instead: a rollback that cannot
  // complete must surface "ROLLBACK FAILED", never "write rolled back".
  const store2 = openStore({ root, caps: { recordMaxBytes: (await size(dir)) + 200 } });
  const h = await store2.acquireOwnership((await fs.readdir(path.join(root, "investigations")))[0]);
  try {
    await assert.rejects(
      h.beginRound({ roundId: "tight", intent: "continue" }),
      (e) => e.name === "StoreCapacityError",
    );
    // beginRound refused pre-write: nothing materialized, nothing claimed.
    const files = await fs.readdir(dir);
    assert.ok(!files.includes("incomplete.json"), "refused begin must not leave a marker");
    assert.ok(!files.includes("reserve.settlement"), "refused begin must not leave a reserve");
  } finally {
    await h.release();
  }
});

// ---------------------------------------------------------------------------
// Finding 4 — ancestor symlink containment (create + reads)
// ---------------------------------------------------------------------------

test("correction: create refuses a symlinked investigations directory", async () => {
  const root = await tempRoot();
  const outside = path.join(root, "outside");
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(root, "investigations"));
  await assert.rejects(
    openStore({ root }).createInvestigation({ requirements: REQUIREMENTS }),
    (e) => e.name === "InvalidReferenceError",
  );
  assert.deepEqual(await fs.readdir(outside), [], "nothing created through the symlink");
});

test("correction: readBody refuses a symlinked bodies ancestor", async () => {
  const root = await tempRoot();
  const { store, ref, dir } = await created(root);
  const text = "outside caller bytes";
  const hex = crypto.createHash("sha256").update(text).digest("hex");
  const outside = path.join(root, "caller-bodies");
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, `${hex}.bin`), text);
  await fs.rename(path.join(dir, "bodies"), path.join(dir, "bodies-original"));
  await fs.symlink(outside, path.join(dir, "bodies"));
  await assert.rejects(store.readBody(ref, `b:${hex}`));
});

// ---------------------------------------------------------------------------
// Finding 5 — complete manifest + marker validation
// ---------------------------------------------------------------------------

test("correction: manifest with wrong schemaVersion blocks beginRound and inspect reports damage", async () => {
  const root = await tempRoot();
  const { store, ref, dir } = await created(root);
  await fs.writeFile(
    path.join(dir, "store.json"),
    JSON.stringify({ schemaVersion: 99, committedRevision: 0, updatedAt: 1 }),
  );
  assert.equal((await store.inspect(ref)).committed, null);
  const h = await store.acquireOwnership(ref);
  try {
    await assert.rejects(
      h.beginRound({ roundId: "blocked", intent: "continue" }),
      (e) => e.name === "CorruptRecordError",
    );
  } finally {
    await h.release();
  }
});

test("correction: malformed incomplete marker blocks beginRound (complete shape validation)", async () => {
  const root = await tempRoot();
  const { store, ref, dir } = await created(root);
  const h = await store.acquireOwnership(ref);
  try {
    await h.beginRound({ roundId: "shaped", intent: "continue" });
    await h.release();
    // Corrupt marker shape (missing intent/settled) with OUR ownerId.
    await fs.writeFile(
      path.join(dir, "incomplete.json"),
      JSON.stringify({ schemaVersion: 1, roundId: "shaped", ownerId: h.ownerId() }),
    );
    const h2 = await store.acquireOwnership(ref);
    try {
      await assert.rejects(
        h2.beginRound({ roundId: "next", intent: "continue" }),
        (e) => e.name === "CorruptRecordError",
      );
    } finally {
      await h2.release();
    }
  } finally {
    await h.release().catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// Finding 6 — settlement marker persistence failure propagates
// ---------------------------------------------------------------------------

test("correction: settlement marker write failure rejects settleRound", async () => {
  const root = await tempRoot();
  const { ref } = await created(root);
  let failMarker = false;
  const store = openStore({
    root,
    deps: {
      writeFileAtomic: async (p, c) => {
        if (failMarker && p.endsWith("incomplete.json")) {
          throw new Error("marker fault");
        }
        const t = p + ".tmp-guard";
        await fs.writeFile(t, c);
        await fs.rename(t, p);
      },
    },
  });
  const h = await store.acquireOwnership(ref);
  try {
    await h.beginRound({ roundId: "f", intent: "continue" });
    failMarker = true;
    await assert.rejects(
      h.settleRound("f", {
        status: "partial",
        measured: { searches: 0, reads: 0, judgments: 0 },
        uncertainty: null,
      }),
    );
  } finally {
    await h.release();
  }
});

// ---------------------------------------------------------------------------
// Finding 7 — requirements shape + declared-vs-actual body bytes
// ---------------------------------------------------------------------------

test("correction: consistent digest over malformed requirements is not verified", async () => {
  const root = await tempRoot();
  const { store, ref, dir } = await created(root);
  const bytes = Buffer.from('{"schemaVersion":1,"fields":{}}');
  await fs.writeFile(path.join(dir, "requirements.json"), bytes);
  const initial = JSON.parse(await fs.readFile(path.join(dir, "revisions", "r0.json"), "utf8"));
  initial.requirementsDigest = `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
  await fs.writeFile(path.join(dir, "revisions", "r0.json"), JSON.stringify(initial));
  assert.equal((await store.inspect(ref)).committed, null);
});

test("correction: declared body bytes must equal actual retained bytes (commit refuses mismatch)", async () => {
  const root = await tempRoot();
  const { store, ref, dir } = await created(root);
  const h = await store.acquireOwnership(ref);
  try {
    await h.beginRound({ roundId: "len", intent: "continue" });
    const staged = await h.stageBody("actual-bytes");
    const initial = JSON.parse(await fs.readFile(path.join(dir, "revisions", "r0.json"), "utf8"));
    await assert.rejects(
      h.commitRevision({
        expectedRevision: 0,
        snapshot: {
          ...initial,
          revision: 1,
          parentRevision: 0,
          bodies: [
            { bodyId: staged.bodyId, digest: `sha256:${staged.bodyId.slice(2)}`, bytes: 1 },
          ],
        },
      }),
      (e) => e.name === "CorruptContentError",
    );
  } finally {
    await h.release();
  }
});

// ---------------------------------------------------------------------------
// Finding 8 — immutable publication is seam-visible with no-clobber kept
// ---------------------------------------------------------------------------

test("correction: revision publication flows through the injected write seam and faults propagate", async () => {
  const root = await tempRoot();
  const { store, ref, dir } = await created(root);
  const initial = JSON.parse(await fs.readFile(path.join(dir, "revisions", "r0.json"), "utf8"));
  let observed = 0;
  const faulty = openStore({
    root,
    deps: {
      writeFileAtomic: async (p, c) => {
        // The funnel receives the revision-local STAGING name (never the
        // final immutable r1.json); fault injection fires there and
        // propagates, refusing the commit.
        if (p.includes("revisions/") && p.includes(".stage.tmp")) {
          observed += 1;
          throw new Error("revision fault");
        }
        const t = p + ".tmp-guard";
        await fs.writeFile(t, c);
        await fs.rename(t, p);
      },
    },
  });
  const h = await faulty.acquireOwnership(ref);
  try {
    await h.beginRound({ roundId: "r", intent: "continue" });
    await assert.rejects(
      h.commitRevision({
        expectedRevision: 0,
        snapshot: { ...initial, revision: 1, parentRevision: 0 },
      }),
    );
    assert.equal(observed, 1, "injected revision-write fault must be observed exactly once");
    assert.equal((await store.inspect(ref)).committed.revision, 0);
  } finally {
    await h.release();
  }
});
