/**
 * Compiled-CLI regression for the Brave passive quota harvest under
 * `--isolated` (#322).
 *
 * Brave's production descriptor harvests the `X-RateLimit-*` headers of
 * every successful web search and writes the shared quota snapshot through
 * its own default store, outside the dispatcher's quota writes. The flag's
 * shared-state skip (ADR-0006 §5) therefore missed it.
 *
 * The rows spawn the built `bin/scoutline.js` with a fake-transport preload,
 * a throwaway HOME and isolated config, cache and artifact dirs. The preload
 * appends one label per mock request to a log the test reads on its own,
 * plus `stdout` at the first result write, all from inside the child, so
 * the order in the log is the program's own. Brave is the only configured
 * provider, and its quota probe shares the web-search endpoint (a stub
 * query tells them apart).
 *
 * Every run seeds `state.json` with a stale Brave snapshot and an old mtime,
 * and inspects it before and after the child (bytes, inode and mtime), so a
 * rewrite shows even when it changes no byte. A quota request would be in
 * the log, and local consumption moves `locallyUpdatedAt`, never
 * `observedAt`: an advanced `observedAt` with no quota request is the
 * harvest and only the harvest.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "scoutline.js");
/** An hour old: past the 10-minute refresh cadence. */
const STALE = () => Date.now() - 60 * 60 * 1000;

const SCRATCH = await mkdtemp(join(tmpdir(), "scoutline-brave-quota-"));
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
  'globalThis.fetch = async (raw) => {',
  '  const url = new URL(String(raw));',
  '  const key = url.host + url.pathname;',
  '  if (key !== "api.search.brave.com/res/v1/web/search") {',
  '    log("unexpected:" + key);',
  '    throw new Error("unexpected synthetic transport " + key);',
  '  }',
  '  if (url.searchParams.get("q") === "scoutline-quota-probe") {',
  '    log("quota:brave");',
  '    return new Response("{}", { headers: rateLimit });',
  '  }',
  '  log("search");',
  '  const page = { url: "https://offline.test/release", title: "ExampleApp 2.4.0 release notes" };',
  '  return Response.json({ web: { results: [{ ...page, description: "CSV export is supported from the reports screen." }] } }, { headers: rateLimit });',
  '};',
].join("\n"));

let homes = 0;
/** One compiled Brave search over its own HOME, config, cache and
 *  artifacts. `state` is the seeded `state.json` as inspected before and
 *  after the child. */
async function run({ args = [], env: extraEnv = {} }) {
  const home = join(SCRATCH, `home-${homes++}`);
  const traffic = join(home, "traffic.log");
  await mkdir(join(home, "config"), { recursive: true });
  await writeFile(traffic, "");
  const stateFile = join(home, "config", "state.json");
  const seeded = STALE();
  await writeFile(stateFile, JSON.stringify({
    version: 1,
    quota: { brave: { observedAt: seeded, categories: [] } },
  }));
  // The file is as old as its snapshot, so a rewrite cannot land on the
  // seeded mtime.
  await utimes(stateFile, new Date(seeded), new Date(seeded));
  /** The bytes, plus the inode and mtime a same-bytes rewrite still changes. */
  const inspectState = async () => {
    const { ino, mtimeMs } = await stat(stateFile);
    return { bytes: await readFile(stateFile, "utf8"), stamp: `${ino}:${mtimeMs}` };
  };
  const stateBefore = await inspectState();
  const { stdout, stderr, code = 0 } = await execFileP(process.execPath, [
    "--import", preload, BIN, "search", "csv export", "--provider", "brave", "--no-cache", ...args,
  ], {
    env: {
      PATH: process.env.PATH, HOME: home, TMPDIR: home,
      SCOUTLINE_CONFIG_DIR: join(home, "config"),
      SCOUTLINE_CACHE_DIR: join(home, "cache"),
      SCOUTLINE_ARTIFACTS_DIR: join(home, "artifacts"),
      BRAVE_SEARCH_API_KEY: "synthetic-brave",
      SCOUTLINE_TEST_TRAFFIC: traffic,
      ...extraEnv,
    },
    timeout: 30_000,
  }).catch((error) => error);
  assert.equal(code, 0, `child exit code (null means killed or timed out)\n${stderr}`);
  const calls = (await readFile(traffic, "utf8")).split("\n").filter(Boolean);
  return { stdout, calls, state: { before: stateBefore, after: await inspectState() } };
}

/** The search returned the fake page off exactly one web-search request,
 *  and no quota request followed it. */
function assertSearched(stdout, calls) {
  assert.deepEqual(JSON.parse(stdout).map(({ url }) => url), ["https://offline.test/release"]);
  assert.deepEqual(calls, ["search", "stdout"], "one web search, no quota request, then the result");
}

test("compiled --isolated Brave search returns its results and leaves the shared quota snapshot untouched", async () => {
  const { stdout, calls, state } = await run({ args: ["--isolated"] });
  assertSearched(stdout, calls);
  assert.deepEqual(state.after, state.before, "the seeded state.json keeps its bytes, inode and mtime");
});

// The env-only variable is the partial mode: the shared-state skip keys on
// the flag alone (docs/configuration.md), so both of these still harvest.
for (const [mode, env] of [["normal", {}], ["SCOUTLINE_ISOLATED=1", { SCOUTLINE_ISOLATED: "1" }]]) {
  test(`compiled Brave search harvests rate-limit headers into the shared quota snapshot in a ${mode} run`, async () => {
    const { stdout, calls, state } = await run({ env });
    assertSearched(stdout, calls);
    assert.ok(
      JSON.parse(state.after.bytes).quota.brave.observedAt > JSON.parse(state.before.bytes).quota.brave.observedAt,
      "the stale Brave snapshot advanced without a quota request",
    );
  });
}
