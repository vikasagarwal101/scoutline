/**
 * Retained-record store callable demo — start→round→commit→reopen→inspect→
 * acknowledge-interruption→delete through the compiled package (dist).
 * Ticket: caller-assisted-engine/tickets/retained-records (proof artifact).
 *
 * Usage: node scripts/retained-records-demo.mjs
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

import {
  openStore,
  OwnerBusyError,
  InvalidReferenceError,
  UnacknowledgedInterruptionError,
} from "../dist/lib/retained-record-store.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "rrs-demo-"));
const ownedHandles = new Set();
let child, childExit;
let flowFailed = false;

try {
  const store = openStore({ root });

  // 1) start: create with requirements + supplied bodies
  const { investigationRef: ref, revision } = await store.createInvestigation({
    requirements: {
      schemaVersion: 1,
      fields: { csv: { definition: "Does it support CSV?", required: true } },
    },
    bodies: [{ label: "readme", content: "demo evidence body" }],
  });
  assert.equal(revision, 0);
  console.log("created", ref, "revision 0");

  // 2) one fresh round under exclusive ownership: marker→stage→audit→settle→commit
  const h = await store.acquireOwnership(ref);
  ownedHandles.add(h);
  await h.beginRound({ roundId: "r1", intent: "start" });
  const staged = await h.stageBody("round one retained body");
  await h.appendAudit({ at: Date.now(), kind: "dispatch", detail: "search x1" });
  await h.settleRound("r1", {
    status: "complete",
    measured: { searches: 1, reads: 0, judgments: 0 },
    uncertainty: null,
  });
  const digest = (await store.inspect(ref)).committed.snapshot.requirementsDigest;
  const { revision: rev1 } = await h.commitRevision({
    expectedRevision: 0,
    snapshot: {
      schemaVersion: 1,
      revision: 1,
      parentRevision: 0,
      createdAt: Date.now(),
      requirementsDigest: digest,
      bodies: [{ bodyId: staged.bodyId, digest: `sha256:${staged.bodyId.slice(2)}`, bytes: staged.bytes }],
      rounds: [{ roundId: "r1", intent: "start", settledAt: Date.now(), usage: { searches: 1, reads: 0, judgments: 0 } }],
      audit: [],
    },
  });
  await h.release();
  ownedHandles.delete(h);
  assert.equal(rev1, 1);
  console.log("committed revision 1");

  // 3) reopen (separate store instance) + read retained evidence
  const reopened = openStore({ root });
  const insp = await reopened.inspect(ref);
  assert.equal(insp.committed.revision, 1);
  const body = await reopened.readBody(ref, staged.bodyId);
  assert.equal(body.toString("utf8"), "round one retained body");
  console.log("reopened; evidence readable:", body.toString("utf8"));

  // 4) interruption: child owner begins a round then is SIGKILLed
  child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
      import { openStore } from ${JSON.stringify(new URL("../dist/lib/retained-record-store.js", import.meta.url).href)};
      const handle = await openStore({ root: ${JSON.stringify(root)} }).acquireOwnership(${JSON.stringify(ref)});
      await handle.beginRound({ roundId: "r2", intent: "continue" });
      console.log("held");
      setInterval(() => {}, 1000);
    `,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  childExit = new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", (error) => resolve({ error }));
  });
  child.stdout.resume();
  let reachedLiveRound = false;
  for (let i = 0; i < 200; i += 1) {
    const s = await store.inspect(ref);
    if (s.ownership === "live-owner" && s.incomplete?.roundId === "r2") {
      reachedLiveRound = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(reachedLiveRound, "child never reached live-owned r2 marker");
  await assert.rejects(() => store.acquireOwnership(ref), OwnerBusyError); // live owner busy
  child.kill("SIGKILL");
  assert.deepEqual(await childExit, { code: null, signal: "SIGKILL" });

  // kernel proved exit: unacknowledged marker blocks, then acknowledgment admits fresh work
  const h2 = await store.acquireOwnership(ref);
  ownedHandles.add(h2);
  await assert.rejects(
    () => h2.beginRound({ roundId: "r3", intent: "continue" }),
    UnacknowledgedInterruptionError,
  );
  await h2.release();
  ownedHandles.delete(h2);
  const ack = await store.acknowledgeInterrupted(ref);
  ownedHandles.add(ack);
  await ack.beginRound({ roundId: "r3", intent: "continue" });
  await ack.release();
  ownedHandles.delete(ack);
  console.log("interruption acknowledged; fresh round admitted");

  // 5) delete
  await store.deleteInvestigation(ref);
  await assert.rejects(
    () => store.inspect(ref),
    (error) => error instanceof InvalidReferenceError &&
      error.code === "INVALID_REFERENCE" && error.message === `No such investigation record: ${ref}`,
  );
  console.log("deleted; inspect now fails explicitly");
} catch (error) {
  flowFailed = true;
  throw error;
} finally {
  const cleanup = await Promise.allSettled([...ownedHandles].map((handle) => handle.release()));
  if (child) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    const exited = await childExit;
    if (exited.error) cleanup.push({ status: "rejected", reason: exited.error });
  }
  cleanup.push(...await Promise.allSettled([fs.rm(root, { recursive: true, force: true })]));
  if (!flowFailed) {
    const errors = cleanup.filter((result) => result.status === "rejected").map((result) => result.reason);
    if (errors.length > 0) throw new AggregateError(errors, "demo cleanup failed");
  }
}
console.log("DEMO OK");
