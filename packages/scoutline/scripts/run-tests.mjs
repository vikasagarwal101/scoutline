#!/usr/bin/env node
/**
 * Scoutline test runner.
 *
 * Modes:
 *   offline         — every top-level test except live and smoke files.
 *   smoke           — only the executable smoke suite (cli-smoke.test.js).
 *   live            — both opt-in live files; unconfigured Providers may skip.
 *   live-release    — only provider-live.test.js; both credentials required,
 *                     any skip fails.
 *
 * Modes clear live env vars in spawned Node child processes so live tests
 * cannot accidentally run under offline/smoke. The runner enumerates test
 * files explicitly via fs.readdir() (sorted) to avoid shell glob assumptions.
 *
 * Live modes also auto-set SCOUTLINE_LIVE_TESTS=1 in the spawned Node child
 * processes so `npm run test:live` / `npm run test:live:release` is itself
 * the explicit opt-in. npm test and prepublishOnly (which run as `offline`)
 * CLEAR that variable, so credentials alone never trigger live tests.
 */
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TESTS_DIR = path.resolve(__dirname, "..", "tests");

const ALL_LIVE_FILES = ["mcp-live.test.js", "provider-live.test.js"];
const SMOKE_FILE = "cli-smoke.test.js";

function listTopLevelTests() {
  return readdirSync(TESTS_DIR)
    .filter((name) => name.endsWith(".test.js"))
    .sort();
}

function selectFiles(mode) {
  // Node's --test flag interprets relative test paths under cwd; we anchor
  // every file to the tests/ directory so the runner can be invoked from any
  // package working directory.
  const all = listTopLevelTests();
  const prefix = (name) => path.join("tests", name);
  switch (mode) {
    case "offline":
      return all
        .filter((name) => name !== SMOKE_FILE && !ALL_LIVE_FILES.includes(name))
        .map(prefix);
    case "smoke":
      return [prefix(SMOKE_FILE)];
    case "live":
      return ALL_LIVE_FILES.filter((name) => all.includes(name)).map(prefix);
    case "live-release":
      return all.filter((name) => name === "provider-live.test.js").map(prefix);
    default:
      throw new Error(`Unknown mode: ${mode}`);
  }
}

/**
 * Build the spawned Node child's environment. The runner is the single
 * authoritative gate for live opt-in: `npm test` and `prepublishOnly` (which
 * run as `offline`) clear SCOUTLINE_LIVE_TESTS and ZAI_LIVE_TESTS so live
 * tests cannot accidentally run under offline/smoke. Live modes set
 * SCOUTLINE_LIVE_TESTS=1 explicitly; running a live mode is the explicit
 * opt-in. `mcp-live.test.js` continues to gate on ZAI_LIVE_TESTS, which
 * callers set themselves (the legacy opt-in path).
 */
function childEnvFor(mode) {
  const env = { ...process.env };
  if (mode === "offline" || mode === "smoke") {
    // Belt-and-suspenders: clear BOTH live opt-in variables even if
    // credentials exist. This guarantees that a stray `SCOUTLINE_LIVE_TESTS=1`
    // in the shell environment cannot accidentally trigger live tests when
    // the user runs `npm test` or `npm publish` (which invokes
    // `prepublishOnly`).
    env.SCOUTLINE_LIVE_TESTS = "";
    env.ZAI_LIVE_TESTS = "";
  } else if (mode === "live" || mode === "live-release") {
    // Live modes are themselves the explicit opt-in: set the gate so the
    // spawned child sees it. We do NOT inherit a possibly-unset
    // SCOUTLINE_LIVE_TESTS from the shell.
    env.SCOUTLINE_LIVE_TESTS = "1";
  }
  return env;
}

function runNodeTests(files, mode) {
  return new Promise((resolve, reject) => {
    if (files.length === 0) {
      console.error(`[run-tests] mode=${mode}: no test files matched`);
      resolve(0);
      return;
    }
    const args = ["--test", ...files];
    const proc = spawn(process.execPath, args, {
      cwd: path.resolve(__dirname, ".."),
      env: childEnvFor(mode),
      stdio: "inherit",
    });
    proc.on("error", reject);
    proc.on("close", (code) => resolve(code ?? 1));
  });
}

function preflightLiveRelease() {
  const required = ["Z_AI_API_KEY", "MINIMAX_API_KEY"];
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    console.error(
      `[run-tests] live-release preflight failed: missing required env vars: ${missing.join(", ")}`,
    );
    process.exit(2);
  }
}

const mode = process.argv[2];
if (!mode) {
  console.error(
    "Usage: node scripts/run-tests.mjs <offline|smoke|live|live-release>",
  );
  process.exit(2);
}

if (mode === "live-release") {
  preflightLiveRelease();
}

const files = selectFiles(mode);
console.error(`[run-tests] mode=${mode} files=${files.join(",")}`);
const code = await runNodeTests(files, mode);
process.exit(code);
