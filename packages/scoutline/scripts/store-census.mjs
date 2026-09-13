#!/usr/bin/env node
/**
 * Store census audit (lane-K T4 rework, §4) — out-of-band, guard-independent.
 *
 * Runs the offline suite with `HOME` pointed at a throwaway mkdtemp dir, then
 * censuses the fake home's `.scoutline` tree and FAILS (exit 1) if any entry
 * exists. The census records (path, inode, mtimeMs, size, type) for EVERY
 * entry — inode churn and same-bytes atomic rewrites are the signatures
 * file-stat probes are blind to — and prints them before failing.
 *
 * Why spawn `run-tests.mjs` rather than `node --test` directly: it is the
 * single authoritative gate for live opt-in and per-run SCOUTLINE_CONFIG_DIR
 * isolation; the census targets the FAKE HOME only (config dir writes are
 * legitimate — hermetic helpers point stores there), so the runner's
 * force-overridden SCOUTLINE_CONFIG_DIR does not need to win anything here.
 * My HOME override survives the runner's `{...process.env}` spread, and the
 * runner clears live opt-in variables exactly as CI's gate does.
 *
 * `--bare` runs `node --test tests/*.test.js` directly (top-level .test.js
 * files, smoke+live included — same file set a bare shell invocation would
 * sweep) with the same fake-home env, for the spec §8.1 both-gate census.
 *
 * Exit 0 = fake-home `.scoutline` absent or empty. Exit 1 = any entry.
 * Exit 2 = suite failure or spawn error.
 */
import { spawn } from "node:child_process";
import {
  readdirSync,
  mkdtempSync,
  existsSync,
  statSync,
  rmSync,
  mkdirSync,
  writeFileSync, lstatSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, "..");
const TESTS_DIR = path.join(PKG_ROOT, "tests");
const bare = process.argv.includes("--bare");
// Scratch-only teeth check: pre-seed an entry so the detector must fire.
// SCOUTLINE_CENSUS_SKIP_SUITE=1 skips the suite (teeth-check convenience).
const seedTeeth = process.argv.includes("--seed-teeth");
const skipSuite = process.env.SCOUTLINE_CENSUS_SKIP_SUITE === "1";
// Scratch-only: keep fake home for post-mortem (SCOUTLINE_CENSUS_KEEP=1).
const keep = process.env.SCOUTLINE_CENSUS_KEEP === "1";

// ponytail: fake home lives under /var/tmp, NOT os.tmpdir(). Two reasons,
// both load-bearing: (1) the §5 teeth tests assert an un-isolated write to a
// homedir-derived path THROWS — under a /tmp fake home the guard's tmpdir
// allowance would permit it and the suite would go red; (2) writes into a
// /tmp fake home would be guard-allowed, disarming the in-process layer and
// leaving only this out-of-band census to notice. /var/tmp keeps both layers
// armed. Ceiling: needs /var/tmp user-writable (POSIX; CI is ubuntu-latest) —
// an unusable base fails LOUD below rather than silently passing.
let fakeHome;
try {
  fakeHome = mkdtempSync(path.join("/var/tmp", "scoutline-census-home-"));
} catch (error) {
  console.error(
    `[store-census] cannot create a fake home under /var/tmp (${error instanceof Error ? error.message : String(error)}). ` +
      "A fake home under os.tmpdir() would be guard-allowed and blind the census — refusing to run a census that cannot detect.",
  );
  process.exit(2);
}
if (seedTeeth) {
  mkdirSync(path.join(fakeHome, ".scoutline", "tools"), { recursive: true });
  writeFileSync(path.join(fakeHome, ".scoutline", "tools", "x.json"), "{}");
}

function listTopLevelTests() {
  return readdirSync(TESTS_DIR)
    .filter((name) => name.endsWith(".test.js"))
    .sort()
    .map((name) => path.join("tests", name));
}

/**
 * Census every entry INSIDE `dir` (spec §4, brief: "Exit 0 = empty fake-home
 * .scoutline (or absent). Exit 1 = any entry").
 *
 * Walks children recursively. If `.scoutline/` exists but is empty (e.g.
 * created by a test that unlinks its files in afterEach), entries is empty
 * (exit 0). If any child file or subdirectory exists (e.g. tools/x.json,
 * state.json, cache blobs), it is recorded and reported (exit 1).
 */
function census(dir) {
  const entries = [];
  const walk = (current) => {
    let names;
    try {
      names = readdirSync(current).sort();
    } catch (error) {
      // Only a disappearing directory reads as absent; anything else
      // (EACCES, EIO, ...) must fail the census, never pass it blind.
      if (error?.code === "ENOENT") return;
      throw new Error(`Unable to inspect census directory: ${current}`, { cause: error });
    }
    for (const name of names) {
      const full = path.join(current, name);
      // lstat, never stat: a symlink entry is a FINDING (recorded, not
      // followed) — following could recurse outside the fake home, hit a
      // loop, or hang on a link to /.
      const st = lstatSync(full);
      const type = st.isSymbolicLink()
        ? "symlink"
        : st.isDirectory()
          ? "dir"
          : st.isFile()
            ? "file"
            : "other";
      entries.push({
        path: path.relative(fakeHome, full),
        inode: st.ino,
        mtimeMs: st.mtimeMs,
        size: st.size,
        type,
      });
      if (st.isDirectory()) {
        walk(full);
      }
    }
  };
  walk(dir);
  return entries;
}

function runSuite() {
  return new Promise((resolve, reject) => {
    // Spread preserves the runner's own isolation + live opt-in clearing.
    // HOME is the census lever; SCOUTLINE_CONFIG_DIR stays runner-owned (the
    // runner mkdtemps it per run and stores legitimately write there).
    const env = { ...process.env, HOME: fakeHome };
    const args = bare
      ? ["--test", ...listTopLevelTests()]
      : [path.join("scripts", "run-tests.mjs"), "offline"];
    const proc = spawn(process.execPath, args, {
      cwd: PKG_ROOT,
      env,
      stdio: "inherit",
    });
    proc.on("error", reject);
    proc.on("close", (code) => resolve(code ?? 1));
  });
}

let exitCode = 0;
try {
  const suiteCode = skipSuite ? 0 : await runSuite();
  if (suiteCode !== 0) {
    console.error(`[store-census] suite failed (exit ${suiteCode}); census aborted`);
    exitCode = 2;
  } else {
    const target = path.join(fakeHome, ".scoutline");
    const entries = existsSync(target) ? census(target) : [];
    if (entries.length === 0) {
      console.log("[store-census] PASS — fake-home .scoutline absent or empty (0 entries)");
    } else {
      console.error(`[store-census] FAIL — ${entries.length} entr${entries.length === 1 ? "y" : "ies"} under fake-home .scoutline:`);
      for (const e of entries) {
        console.error(
          `  ${e.type.padEnd(5)} inode=${e.inode} mtime=${e.mtimeMs} size=${e.size} ${e.path}`,
        );
      }
      exitCode = 1;
    }
  }
} finally {
  if (keep && exitCode !== 0) {
    console.error(`[store-census] kept fake home for post-mortem: ${fakeHome}`);
  } else {
    try {
      // ponytail: rmSync recursive — fine, the fake home is census-owned mkdtemp
      rmSync(fakeHome, { recursive: true, force: true });
    } catch {
      // leftover tmpdir is harmless; don't mask the census verdict
    }
  }
}
process.exit(exitCode);
