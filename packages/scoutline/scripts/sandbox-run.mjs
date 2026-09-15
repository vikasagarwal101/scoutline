#!/usr/bin/env node
/**
 * sandbox-run.mjs — isolated scratch execution wrapper for probe/mutation
 * work (issue #168; full-root isolation per the #168 review, MAJOR-4).
 *
 * The test-isolation guard (src/lib/test-isolation.ts) allowlists SIX env
 * roots — SCOUTLINE_CONFIG_DIR, SCOUTLINE_ARTIFACTS_DIR, SCOUTLINE_CACHE_DIR,
 * SCOUTLINE_WATCH_DIR, ZAI_MCP_CACHE_DIR, ZAI_CACHE_DIR — plus os.tmpdir().
 * Forwarding any root from the caller would let a sandboxed probe write the
 * caller's real store with the in-process guard's BLESSING (the root is
 * allowlisted), so every root is pointed at its own fresh scratch dir. The
 * child also runs with cwd = a fresh scratch dir, so the documented
 * relative-path fixture pattern lands in the sandbox, not the repo tree.
 *
 * Containment posture (incident #168 + review MAJOR-4): the first revision
 * redirected only HOME + SCOUTLINE_CONFIG_DIR and left three allowlisted
 * roots plus the working directory reachable — it did not close the class
 * it exists to close. Full-root isolation + cwd containment is the correct
 * posture for probe/mutation work. Running the full test suite under this
 * wrapper is NOT its purpose; the guard-suite env-trap exception from the
 * first revision is obsolete under this design.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";

if (process.env.SCOUTLINE_NO_TEST_GUARD === "1") {
  process.stderr.write(
    "[sandbox-run] Refusing to run with SCOUTLINE_NO_TEST_GUARD=1 (strict equality, matching the guard's bypass contract; unset or =0 does not refuse).\n",
  );
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
const ROOT_VARS = [
  "SCOUTLINE_CONFIG_DIR",
  "SCOUTLINE_ARTIFACTS_DIR",
  "SCOUTLINE_CACHE_DIR",
  "SCOUTLINE_WATCH_DIR",
  "ZAI_MCP_CACHE_DIR",
  "ZAI_CACHE_DIR",
];

let sandbox;
try {
  sandbox = { HOME: mkdtempSync(path.join("/var/tmp", "scoutline-sandbox-home-")) };
  for (const name of ROOT_VARS) {
    const slug = name.toLowerCase().replaceAll("_", "-");
    sandbox[name] = mkdtempSync(path.join("/var/tmp", `scoutline-sandbox-${slug}-`));
  }
  sandbox.cwd = mkdtempSync(path.join("/var/tmp", "scoutline-sandbox-cwd-"));
} catch (error) {
  console.error(
    `[sandbox-run] cannot create sandbox scratch dirs under /var/tmp (${error instanceof Error ? error.message : String(error)}). ` +
      "A fake home under os.tmpdir() would be guard-allowed and disarm isolation guards — refusing to run without a strict scratch base.",
  );
  process.exit(1);
}

process.stderr.write(
  `[sandbox-run] ${Object.entries(sandbox)
    .map(([name, dir]) => `${name}=${dir}`)
    .join(" ")}\n`,
);

const env = {
  ...process.env,
  HOME: sandbox.HOME,
  ...Object.fromEntries(ROOT_VARS.map((name) => [name, sandbox[name]])),
};

const [command, ...commandArgs] = args;
const child = spawn(command, commandArgs, {
  stdio: "inherit",
  env,
  cwd: sandbox.cwd,
});

function cleanup() {
  for (const dir of Object.values(sandbox)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
}

child.on("error", (error) => {
  cleanup();
  process.stderr.write(`[sandbox-run] failed to spawn child: ${error.message}\n`);
  process.exit(1);
});

child.on("close", (code, signal) => {
  cleanup();
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 0);
  }
});
