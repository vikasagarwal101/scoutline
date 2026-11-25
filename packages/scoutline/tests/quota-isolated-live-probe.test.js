/**
 * Compiled-CLI regression for the quota command's live-probe write-through
 * under `--isolated` (#324).
 *
 * `quota` reads each provider's snapshot and, when it is missing or stale,
 * probes the provider and writes the result through the quota store the
 * dispatcher hands it. The flag skipped the dispatcher's own pre-command
 * refresh but not that write-through, so an isolated `quota` still created
 * or rewrote the shared `state.json` (#323 closed the sibling path for
 * Brave searches).
 *
 * The rows spawn the built `bin/scoutline.js` with a fake-transport preload,
 * a throwaway HOME and isolated config, cache and artifact dirs. The preload
 * appends one label per mock request to a log the test reads on its own,
 * plus `stdout` at the first result write, all from inside the child.
 * `state.json` is seeded as the row needs and inspected before and after
 * the child (bytes, inode and mtime, or its absence), so a rewrite shows
 * even when it changes no byte.
 *
 * A normal run refreshes a stale snapshot BEFORE the handler runs, and the
 * handler then answers from the fresh snapshot without probing. To reach
 * the handler's own write-through, the persistence rows fail the FIRST
 * quota probe (the pre-command refresh, which then writes nothing) and
 * serve the second (the handler's live probe). What lands in `state.json`
 * is the handler's response and only that.
 *
 * The last row runs `main()` in process: the flag withholds the PRODUCTION
 * store, and never a store the caller injected.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { main } from "../dist/index.js";
import { createInMemoryQuotaStore } from "../dist/lib/quota-store.js";
import { hermeticMainDeps } from "./helpers/hermetic-main.js";

const execFileP = promisify(execFile);
const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "scoutline.js");
/** An hour old: past the 10-minute freshness threshold. */
const STALE = () => Date.now() - 60 * 60 * 1000;

const SCRATCH = await mkdtemp(join(tmpdir(), "scoutline-quota-live-probe-"));
after(() => rm(SCRATCH, { recursive: true, force: true }));

const preload = join(SCRATCH, "fake-transport.mjs");
await writeFile(preload, [
  'import { appendFileSync } from "node:fs";',
  'const log = (stage) => appendFileSync(process.env.SCOUTLINE_TEST_TRAFFIC, stage + "\\n");',
  '// The two-window shape Brave documents (CSV aligned by index).',
  'const rateLimit = {',
  '  "X-RateLimit-Limit": "1, 15000",',
  '  "X-RateLimit-Policy": "1;w=1, 15000;w=2592000",',
  '  "X-RateLimit-Remaining": "1, 14500",',
  '  "X-RateLimit-Reset": "1, 1296000",',
  '};',
  'const writeOut = process.stdout.write.bind(process.stdout);',
  'let emitted = false;',
  'process.stdout.write = (chunk, ...rest) => {',
  '  if (!emitted) { emitted = true; log("stdout"); }',
  '  return writeOut(chunk, ...rest);',
  '};',
  '// Brave reads quota off a stub-query web search. The first probe can be',
  '// made to fail, so a run that refreshes before the handler writes nothing.',
  'let probes = 0;',
  'globalThis.fetch = async (raw) => {',
  '  const url = new URL(String(raw));',
  '  const key = url.host + url.pathname;',
  '  if (key !== "api.search.brave.com/res/v1/web/search" || url.searchParams.get("q") !== "scoutline-quota-probe") {',
  '    log("unexpected:" + key);',
  '    throw new Error("unexpected synthetic transport " + key);',
  '  }',
  '  probes += 1;',
  '  if (probes === 1 && process.env.SCOUTLINE_TEST_FAIL_FIRST_PROBE === "1") {',
  '    log("quota:brave:500");',
  '    return new Response("{}", { status: 500, headers: rateLimit });',
  '  }',
  '  log("quota:brave");',
  '  return new Response("{}", { headers: rateLimit });',
  '};',
].join("\n"));

let homes = 0;
/** One compiled quota run over its own HOME, config, cache and artifacts.
 *  `seed` is `absent`, `stale` or `fresh`. `state` is `state.json` as
 *  inspected before and after the child; `seeded` is the snapshot's time. */
async function run({ seed, failFirstProbe = false, args = [], env: extraEnv = {} }) {
  const home = join(SCRATCH, `home-${homes++}`);
  const traffic = join(home, "traffic.log");
  await mkdir(join(home, "config"), { recursive: true });
  await writeFile(traffic, "");
  const stateFile = join(home, "config", "state.json");
  const seeded = seed === "fresh" ? Date.now() : STALE();
  if (seed !== "absent") {
    await writeFile(stateFile, JSON.stringify({
      version: 1,
      quota: {
        brave: {
          observedAt: seeded,
          categories: [{
            name: "monthly",
            unit: "requests",
            current: {
              remainingPercent: 50, used: 10, limit: 20, remaining: 10,
              durationSeconds: 2592000, resetsAt: new Date(seeded).toISOString(),
            },
          }],
        },
      },
    }));
    // The file is as old as its snapshot, so a rewrite cannot land on the
    // seeded mtime.
    await utimes(stateFile, new Date(seeded), new Date(seeded));
  }
  /** The bytes, plus the inode and mtime a same-bytes rewrite still changes. */
  const inspectState = async () => {
    const { ino, mtimeMs } = await stat(stateFile).catch((error) => {
      if (error.code === "ENOENT") return { ino: undefined, mtimeMs: undefined };
      throw error;
    });
    if (ino === undefined) return "absent";
    return { bytes: await readFile(stateFile, "utf8"), stamp: `${ino}:${mtimeMs}` };
  };
  const stateBefore = await inspectState();
  const { stdout, stderr, code = 0 } = await execFileP(process.execPath, [
    "--import", preload, BIN, "quota", "--provider", "brave", ...args,
  ], {
    env: {
      PATH: process.env.PATH, HOME: home, TMPDIR: home,
      SCOUTLINE_CONFIG_DIR: join(home, "config"),
      SCOUTLINE_CACHE_DIR: join(home, "cache"),
      SCOUTLINE_ARTIFACTS_DIR: join(home, "artifacts"),
      BRAVE_SEARCH_API_KEY: "synthetic-brave",
      SCOUTLINE_TEST_TRAFFIC: traffic,
      ...(failFirstProbe ? { SCOUTLINE_TEST_FAIL_FIRST_PROBE: "1" } : {}),
      ...extraEnv,
    },
    timeout: 30_000,
  }).catch((error) => error);
  assert.equal(code, 0, `child exit code (null means killed or timed out)\n${stderr}`);
  const calls = (await readFile(traffic, "utf8")).split("\n").filter(Boolean);
  return { stdout, calls, seeded, state: { before: stateBefore, after: await inspectState() } };
}

/** The row came off a live probe: the fake window (limit 15000), labelled
 *  `live` and authoritative. */
function assertLiveRow(stdout) {
  const [row] = JSON.parse(stdout).providers;
  assert.equal(row.provider, "brave");
  assert.equal(row.status, "ok");
  assert.equal(row.categories[0].current.limit, 15000);
  assert.deepEqual([row.quotaSource.source, row.quotaSource.authoritative], ["live", true]);
}

for (const [seed, change] of [["absent", "create"], ["stale", "rewrite"]]) {
  test(`compiled --isolated quota returns a live probe and does not ${change} the shared quota snapshot (seed: ${seed})`, async () => {
    const { stdout, calls, state } = await run({ seed, args: ["--isolated"] });
    assert.deepEqual(calls, ["quota:brave", "stdout"], "one live probe, no pre-command refresh, then the result");
    assertLiveRow(stdout);
    assert.deepEqual(state.after, state.before, "the shared state.json is left exactly as it was");
  });
}

test("compiled --isolated quota answers from a fresh snapshot without a probe or a write", async () => {
  const { stdout, calls, state, seeded } = await run({ seed: "fresh", args: ["--isolated"] });
  assert.deepEqual(calls, ["stdout"], "no probe of any kind");
  const [row] = JSON.parse(stdout).providers;
  assert.deepEqual(
    [row.status, row.categories[0].current.limit, row.quotaSource.source, row.quotaSource.observedAt, row.quotaSource.authoritative],
    ["ok", 20, "snapshot", seeded, true],
    "the seeded snapshot is what the row carries",
  );
  assert.deepEqual(state.after, state.before, "the shared state.json is left exactly as it was");
});

// The env-only variable is the partial mode: the shared-state skip keys on
// the flag alone (docs/configuration.md), so both of these still persist.
for (const [mode, env] of [["normal", {}], ["SCOUTLINE_ISOLATED=1", { SCOUTLINE_ISOLATED: "1" }]]) {
  test(`compiled quota persists the handler's live probe in a ${mode} run`, async () => {
    const { stdout, calls, state } = await run({ seed: "stale", failFirstProbe: true, env });
    assert.deepEqual(calls, ["quota:brave:500", "quota:brave", "stdout"], "the pre-command refresh's probe fails, then the handler probes, then the result");
    assertLiveRow(stdout);
    const persisted = JSON.parse(state.after.bytes).quota.brave;
    assert.equal(persisted.categories[0].current.limit, 15000, "the handler's response is what landed");
    assert.ok(persisted.observedAt > JSON.parse(state.before.bytes).quota.brave.observedAt, "the stale snapshot advanced");
  });
}

test("an injected quota store still receives the live-probe write-through under --isolated", async () => {
  const category = {
    name: "monthly",
    unit: "requests",
    current: { remainingPercent: 50, used: 10, limit: 20, remaining: 10, durationSeconds: 2592000, resetsAt: "2026-12-26T00:00:00.000Z" },
  };
  let probes = 0;
  const store = createInMemoryQuotaStore();
  const status = await main(["quota", "--provider", "brave", "--isolated"], hermeticMainDeps({
    invocation: {
      stdoutIsTTY: false,
      stdinIsTTY: false,
      environmentOutputMode: "data",
      readStdin: async () => "",
      writeStdout: () => {},
      writeStderr: () => {},
      runQuietly: async (operation) => operation(),
      setExitCode: () => {},
    },
    env: { BRAVE_SEARCH_API_KEY: "synthetic-brave" },
    providerDescriptors: [{
      id: "brave",
      isConfigured: () => true,
      capabilities: () => new Set(["quota"]),
      create: () => ({
        id: "brave",
        quota: {
          invoke: async () => { probes += 1; return { provider: "brave", status: "ok", categories: [category] }; },
        },
      }),
    }],
    // The snapshot path is what enables the write-through; the entry is missing.
    quotaState: { version: 1, quota: {} },
    quotaStore: store,
  }));
  assert.equal(status, 0);
  assert.equal(probes, 1);
  assert.equal(store.state.quota.brave.categories[0], category, "the injected store got the live probe");
});
