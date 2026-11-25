import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const CHILD = fileURLToPath(new URL("./reverse-order-progress-child.mjs", import.meta.url));
// Separate bounded budgets: startup (process boot, module loading, harness
// setup) is unbounded in cost on a cold or loaded runner, so it gets a
// generous deadline of its own. The stall budget starts only at the child's
// ready boundary and covers the scheduler run.
const STARTUP_MS = 30_000;
const STALL_MS = 1_000;

// Watchdog parent: kills the child when it misses its startup deadline or,
// once the child reports ready, its stall deadline. `killed` names the phase.
async function run(mode, slowStartupMs = 0, stallMs = 0) {
  const child = spawn(process.execPath, [CHILD, mode, String(slowStartupMs), String(stallMs)], {
    env: {}, // no ambient credentials or configuration; the fixture spawns nothing
    stdio: ["ignore", "pipe", "pipe", "pipe"], // fd 3: startup boundary
  });
  let output = "",
    error = "",
    ready = false,
    killed = "",
    timer;
  child.stdout.on("data", (x) => (output += x));
  child.stderr.on("data", (x) => (error += x));
  const exited = new Promise((resolve) =>
    child.on("close", (code, signal) => resolve({ code, signal })),
  );
  const arm = (phase, ms) => {
    if (killed) return; // the first timeout outcome stands
    clearTimeout(timer);
    timer = setTimeout(() => {
      killed = phase;
      child.kill("SIGKILL");
    }, ms);
  };
  arm("startup", STARTUP_MS);
  child.stdio[3].once("data", () => {
    ready = true;
    arm("stall", STALL_MS);
  });
  const exit = await exited;
  clearTimeout(timer);
  return { ...exit, output, error, ready, killed };
}

function settled(r, mode) {
  assert(
    !r.killed,
    r.killed === "startup"
      ? `child did not report readiness within ${STARTUP_MS}ms: ${r.error}`
      : `no-eligible re-entry cannot continue synchronously without state or budget progress: ${r.error}`,
  );
  assert.equal(r.code, 0, r.error);
  assert(r.ready, "a settled child must have crossed its startup boundary");
  const payload = JSON.parse(r.output);
  const { data } = payload;
  assert(!("license" in data));
  assert(!("csv" in data));
  if (mode !== "unchanged") assert(!("version" in data));
  return payload;
}

for (const mode of ["unchanged", "revise"]) {
  test(`no eligible field terminates boundedly under frozen clock: ${mode}`, async () => {
    settled(await run(mode), mode);
  });
}

// The revision fires inside the no-eligible pass, so clock reads witness
// the passes after it: exactly one more read is the identical-wait-set
// pass that follows the re-entry. Any other count means the revision
// landed earlier, while acquisition still had passes to run, that the
// fixture drifted off the re-entry, or that these passes gained or lost
// a clock read. With the repeated-wait-set check removed the child spins
// and the stall watchdog fails this row.
test("a repeated wait-set ends the no-eligible re-entry: prerequisite terminal with a dead proof", async () => {
  const { readsAfterRevision } = settled(await run("terminal"), "terminal");
  assert.equal(
    readsAfterRevision,
    1,
    "clock reads after the revision must be exactly 1: the revision lands at the first loop entry " +
      "after the final search and one identical-wait-set pass follows. Another count means the " +
      "revision moved, the fixture left the re-entry, or these passes gained or lost a clock read.",
  );
});

test("deliberately slow startup completes instead of reading as a scheduler stall", async () => {
  settled(await run("unchanged", 2 * STALL_MS), "unchanged");
});

test("deliberate synchronous scheduler stall after ready trips the watchdog", async () => {
  const r = await run("unchanged", 0, 5 * STALL_MS);
  assert.equal(r.killed, "stall", "a post-ready synchronous stall must be killed by the watchdog");
  assert.equal(r.signal, "SIGKILL");
});
