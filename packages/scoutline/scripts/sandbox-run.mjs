#!/usr/bin/env node
/**
 * sandbox-run.mjs — isolated scratch execution wrapper (issue #168).
 *
 * Spawns child processes in an isolated scratch environment where HOME and
 * SCOUTLINE_CONFIG_DIR point to dedicated throwaway directories under /var/tmp.
 *
 * Env trap exception (incident #168): this wrapper exports ONLY HOME and
 * SCOUTLINE_CONFIG_DIR. It explicitly does NOT export SCOUTLINE_ARTIFACTS_DIR or
 * SCOUTLINE_CACHE_DIR. Exporting the roots causes false-positive test failures
 * in store-perimeter-guard and mcp-client suites when the guard-suite itself is
 * executed under this wrapper. Unsetting / not exporting those roots prevents
 * triggering that perimeter-guard env trap while providing full config isolation.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";

if (process.env.SCOUTLINE_NO_TEST_GUARD !== undefined) {
  process.stderr.write("[sandbox-run] Refusing to run with SCOUTLINE_NO_TEST_GUARD set.\n");
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.length === 0) {
  process.stderr.write("Usage: sandbox-run.mjs <command> [args...]\n");
  process.exit(1);
}

// ponytail: fake home lives under /var/tmp, NOT os.tmpdir(). Two reasons,
// both load-bearing: (1) isolation tests assert an un-isolated write to a
// homedir-derived path THROWS — under a /tmp fake home the guard's tmpdir
// allowance would permit it and tests would go red; (2) writes into a
// /tmp fake home would be guard-allowed, disarming the in-process layer.
// /var/tmp keeps isolation armed. Ceiling: needs /var/tmp user-writable
// (POSIX; CI is ubuntu-latest) — an unusable base fails LOUD below.
let fakeHome;
let fakeConfigDir;
try {
  fakeHome = mkdtempSync(path.join("/var/tmp", "scoutline-sandbox-home-"));
  fakeConfigDir = mkdtempSync(path.join("/var/tmp", "scoutline-sandbox-config-"));
} catch (error) {
  console.error(
    `[sandbox-run] cannot create sandbox scratch dirs under /var/tmp (${error instanceof Error ? error.message : String(error)}). ` +
      "A fake home under os.tmpdir() would be guard-allowed and disarm isolation guards — refusing to run without a strict scratch base.",
  );
  process.exit(1);
}

process.stderr.write(`[sandbox-run] HOME=${fakeHome} SCOUTLINE_CONFIG_DIR=${fakeConfigDir}\n`);

const env = {
  ...process.env,
  HOME: fakeHome,
  SCOUTLINE_CONFIG_DIR: fakeConfigDir,
};
delete env.SCOUTLINE_ARTIFACTS_DIR;
delete env.SCOUTLINE_CACHE_DIR;

const [command, ...commandArgs] = args;
const child = spawn(command, commandArgs, {
  stdio: "inherit",
  env,
});

child.on("error", (error) => {
  try {
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(fakeConfigDir, { recursive: true, force: true });
  } catch {}
  process.stderr.write(`[sandbox-run] failed to spawn child: ${error.message}\n`);
  process.exit(1);
});

child.on("close", (code, signal) => {
  try {
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(fakeConfigDir, { recursive: true, force: true });
  } catch {}
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 0);
  }
});
