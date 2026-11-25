/**
 * Compiled-CLI regression for the requirements-lane quota refresh (#315).
 *
 * The after-command refresh runs only in production mode (`main` gates it
 * on having no injected config or descriptors), so an in-process `main()`
 * test cannot reach it. These rows spawn the built `bin/scoutline.js` with
 * a fake-transport preload, a throwaway HOME and isolated config, cache and
 * artifact dirs. The preload appends one label per mock request to a single
 * log in dispatch order, plus `stdout` at the first result write and `error`
 * at the first error envelope, all from inside the child, so the order in
 * the log is the program's own.
 *
 * Tavily serves the investigation; Jina is only configured. Both are
 * quota-capable, so a due refresh probes both AFTER the result and outside
 * the run's reported physical-attempt count.
 *
 * Every run seeds `state.json`, the shared quota snapshots, and inspects
 * it before and after the child (`state`: bytes, inode and mtime), so a
 * rewrite shows even when it changes no byte. An isolated run must leave
 * that file alone (ADR-0006 §5); the per-process cache and artifact
 * subtrees it does write live elsewhere.
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
const CONTRACT = {
  schemaVersion: 1,
  question: "Does ExampleApp release 2.4.0 support CSV export?",
  scope: { entity: "ExampleApp", release: "2.4.0" },
  requirements: {
    csv: { question: "Does ExampleApp release 2.4.0 support CSV export?", schema: { enum: ["supported", "refuted", "disputed"] } },
  },
};
const INVESTIGATION_CALLS = ["search", "read", "judge"];
const QUOTA_CALLS = ["quota:jina", "quota:tavily"];
/** An hour old: past the 10-minute refresh cadence. */
const STALE = () => Date.now() - 60 * 60 * 1000;

const SCRATCH = await mkdtemp(join(tmpdir(), "scoutline-requirements-quota-"));
after(() => rm(SCRATCH, { recursive: true, force: true }));

const preload = join(SCRATCH, "fake-transport.mjs");
await writeFile(preload, [
  'import { appendFileSync } from "node:fs";',
  'const log = (stage) => appendFileSync(process.env.SCOUTLINE_TEST_TRAFFIC, stage + "\\n");',
  'const url = "https://offline.test/release";',
  'const text = "ExampleApp release 2.4.0. CSV export is supported from the reports screen.";',
  'const writeOut = process.stdout.write.bind(process.stdout);',
  'let emitted = false;',
  'process.stdout.write = (chunk, ...rest) => {',
  '  if (!emitted) { emitted = true; log("stdout"); }',
  '  return writeOut(chunk, ...rest);',
  '};',
  'const writeErr = process.stderr.write.bind(process.stderr);',
  'let reported = false;',
  'process.stderr.write = (chunk, ...rest) => {',
  '  if (!reported && String(chunk).startsWith("{")) { reported = true; log("error"); }',
  '  return writeErr(chunk, ...rest);',
  '};',
  'globalThis.fetch = async (raw, init) => {',
  '  const target = new URL(String(raw));',
  '  const key = target.host + target.pathname;',
  '  if (key === "api.tavily.com/usage") {',
  '    log("quota:tavily");',
  '    return Response.json({ key: { usage: 5, limit: 1000 }, account: { current_plan: "free", plan_usage: 5, plan_limit: 1000 } });',
  '  }',
  '  if (target.host === "s.jina.ai") {',
  '    log("quota:jina");',
  '    return new Response("", { status: 200, headers: { "X-RateLimit-Remaining-Requests": "499", "X-RateLimit-Remaining-Tokens": "999000" } });',
  '  }',
  '  if (key === "api.tavily.com/search" || key === "api.tavily.com/extract") {',
  '    log(key.endsWith("/search") ? "search" : "read");',
  '    const page = { url, title: "ExampleApp 2.4.0 release notes" };',
  '    return Response.json({ results: [{ ...page, content: text, raw_content: text }] });',
  '  }',
  '  if (key === "api.typesafe.ai/v1/systemone") {',
  '    log("judge");',
  '    const ids = Object.keys(JSON.parse(init.body).questions ?? {});',
  '    return Response.json({ model: "jev-1.13.0", usage: { input_tokens: 1, output_tokens: 1 },',
  '      answers: Object.fromEntries(ids.map((id) => [id, { type: "noul", noul: /[cf]$/.test(id) ? 0.02 : 0.98 }])) });',
  '  }',
  '  log("unexpected:" + key);',
  '  throw new Error("unexpected synthetic transport " + key);',
  '};',
].join("\n"));
const contract = join(SCRATCH, "requirements.json");
await writeFile(contract, JSON.stringify(CONTRACT));

let homes = 0;
/** One compiled run over its own HOME, config, cache and artifacts. `exit`
 *  is the exit code the row expects; a killed or timed-out child has none.
 *  `state` is the seeded `state.json` as inspected before and after. */
async function run({ observedAt, judge = true, args = [], env: extraEnv = {}, exit = 0 }) {
  const home = join(SCRATCH, `home-${homes++}`);
  const traffic = join(home, "traffic.log");
  await mkdir(join(home, "config"), { recursive: true });
  await writeFile(traffic, "");
  const stateFile = join(home, "config", "state.json");
  await writeFile(stateFile, JSON.stringify({
    version: 1,
    quota: { tavily: { observedAt, categories: [] }, jina: { observedAt, categories: [] } },
  }));
  // The file is as old as its snapshots, so a rewrite cannot land on the
  // seeded mtime.
  await utimes(stateFile, new Date(observedAt), new Date(observedAt));
  /** The bytes, plus the inode and mtime a same-bytes rewrite still changes. */
  const inspectState = async () => {
    const { ino, mtimeMs } = await stat(stateFile);
    return { bytes: await readFile(stateFile, "utf8"), stamp: `${ino}:${mtimeMs}` };
  };
  const stateBefore = await inspectState();
  const env = {
    PATH: process.env.PATH, HOME: home, TMPDIR: home,
    SCOUTLINE_CONFIG_DIR: join(home, "config"),
    SCOUTLINE_CACHE_DIR: join(home, "cache"),
    SCOUTLINE_ARTIFACTS_DIR: join(home, "artifacts"),
    TAVILY_API_KEY: "synthetic-tavily",
    // Configured but unused by the run; quota-capable.
    JINA_API_KEY: "synthetic-jina",
    SCOUTLINE_TEST_TRAFFIC: traffic,
    ...(judge ? { SCOUTLINE_JUDGE: "typesafe", TYPESAFE_API_KEY: "synthetic-judge", SCOUTLINE_JUDGE_TRANSMIT: "1" } : {}),
    ...extraEnv,
  };
  const { stdout, stderr, code = 0 } = await execFileP(process.execPath, [
    "--import", preload, BIN, "investigate", "--provider", "tavily", "--requirements", contract, ...args,
  ], { env, timeout: 30_000 }).catch((error) => error);
  assert.equal(code, exit, "child exit code (null means killed or timed out)");
  const calls = (await readFile(traffic, "utf8")).split("\n").filter(Boolean);
  return {
    stdout, stderr, calls,
    quotaCalls: calls.filter((call) => call.startsWith("quota:")).sort(),
    state: { before: stateBefore, after: await inspectState() },
  };
}

/** The result came first, then one quota call per configured provider. The
 *  reported attempts equal the investigation's own requests, so the quota
 *  calls sit outside that count. */
function assertRefreshFollowsResult(calls, result) {
  const emitted = calls.indexOf("stdout");
  const attempts = calls.slice(0, emitted);
  assert.deepEqual(calls.slice(emitted + 1).sort(), QUOTA_CALLS, "every quota call follows the result");
  assert.ok(attempts.every((call) => INVESTIGATION_CALLS.includes(call)), "unclassified mock call");
  assert.equal(result.usage.physicalHttpAttempts, attempts.length, "quota calls sit outside the reported attempt count");
}

/** Control for the isolated row's comparison: through the same two
 *  reads, a run that does refresh shows every seeded snapshot advance. */
function assertSnapshotsAdvanced({ before, after }) {
  const seeded = JSON.parse(before.bytes).quota;
  const refreshed = JSON.parse(after.bytes).quota;
  for (const [provider, { observedAt }] of Object.entries(seeded)) {
    assert.ok(refreshed[provider].observedAt > observedAt, `${provider} snapshot advanced past its stale seed`);
  }
}

for (const [status, judge, exit] of [["complete", true, 0], ["partial", false, 1]]) {
  test(`compiled requirements run refreshes stale quotas after a ${status} result`, async () => {
    const { stdout, calls, state } = await run({ observedAt: STALE(), judge, exit });
    const result = JSON.parse(stdout);
    assert.equal(result.status, status);
    assertRefreshFollowsResult(calls, result);
    assertSnapshotsAdvanced(state);
  });
}

test("compiled requirements run refreshes stale quotas after its attempt allowance is exhausted", async () => {
  const { stdout, calls } = await run({ observedAt: STALE(), env: { SCOUTLINE_REQUIREMENTS_MAX_PHYSICAL: "1" }, exit: 1 });
  const result = JSON.parse(stdout);
  assert.equal(result.status, "partial");
  assert.equal(result.usage.physicalHttpAttempts, 1);
  assert.ok(result.acquisition.physicalAttempts.some((row) => row.outcome === "refused"), "the run really hit its allowance");
  assertRefreshFollowsResult(calls, result);
});

test("compiled requirements run leaves fresh quota snapshots alone", async () => {
  const { stdout, calls, quotaCalls } = await run({ observedAt: Date.now() });
  assert.equal(JSON.parse(stdout).status, "complete");
  assert.equal(calls.at(-1), "stdout", "the log is live and ends at the result");
  assert.deepEqual(quotaCalls, []);
});

test("compiled --isolated requirements run issues no quota calls and preserves the shared quota snapshots", async () => {
  const { stdout, calls, quotaCalls, state } = await run({ observedAt: STALE(), args: ["--isolated"] });
  assert.equal(JSON.parse(stdout).status, "complete");
  assert.equal(calls.at(-1), "stdout", "the log is live and ends at the result");
  assert.deepEqual(quotaCalls, []);
  assert.deepEqual(state.after, state.before, "the seeded state.json keeps its bytes, inode and mtime");
});

test("compiled requirements run still refreshes quotas when a late --save fails", async () => {
  // The export target is a directory: pre-validation passes under
  // --save-force, then the write itself fails after the result exists.
  const target = join(SCRATCH, "occupied-export-target");
  await mkdir(target);
  const { stdout, stderr, calls } = await run({ observedAt: STALE(), args: ["--save", target, "--save-force"], exit: 1 });
  // No result reaches stdout here, so the reported save failure is the boundary.
  const reported = calls.indexOf("error");
  const before = calls.slice(0, reported);
  assert.ok(before.includes("judge") && before.every((call) => INVESTIGATION_CALLS.includes(call)), "the investigation, judge included, ran before the save failed");
  assert.deepEqual(calls.slice(reported + 1).sort(), QUOTA_CALLS, "the refresh ran, and only after the save failure was reported");
  assert.equal(stdout, "", "a failed save suppresses the result");
  // The env-credential hint precedes the error envelope on stderr.
  const { code, error: message } = JSON.parse(stderr.trim().split("\n").at(-1));
  assert.equal(code, "FILE_ERROR");
  assert.ok(message.includes(target), "the blocked destination is what failed the save");
});

test("compiled requirements run issues no quota calls after a preflight rejection", async () => {
  // Both configured providers are due a refresh. The preload marks the
  // error envelope even though no HTTP runs.
  const { stdout, stderr, calls } = await run({ observedAt: STALE(), env: { SCOUTLINE_REQUIREMENTS_MAX_PHYSICAL: "0" }, exit: 1 });
  const { code, error: message } = JSON.parse(stderr.trim().split("\n").at(-1));
  assert.equal(code, "VALIDATION_ERROR");
  assert.match(message, /^SCOUTLINE_REQUIREMENTS_MAX_PHYSICAL must be .*got "0" \(below the minimum of 1\)\.$/);
  assert.equal(stdout, "", "a rejected preflight prints no result");
  assert.deepEqual(calls, ["error"], "no mock request of any kind through child exit");
});
