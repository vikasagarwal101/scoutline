/**
 * Write-chokepoint test-isolation guard (lane-K T4 rework, §1).
 *
 * Doctrine (spec §0): RESOLVING a real-user-store path is legal — import-time
 * string math and construction-time defaults stay untouched, which is why
 * #119/#137 guards remain resolution-time (their resolvers fire at use-time).
 * MUTATING a real-user-store path while `NODE_TEST_CONTEXT` is ambient is the
 * harm this module guards: any fs-mutation chokepoint calls
 * `assertTestSafeWrite` before touching disk.
 *
 * Allowlist-first comparator: a write passes iff the normalized target is
 * under one of the SET isolation roots (SCOUTLINE_CONFIG_DIR /
 * SCOUTLINE_ARTIFACTS_DIR / SCOUTLINE_CACHE_DIR / SCOUTLINE_WATCH_DIR,
 * realpath-resolved where segments exist) or `os.tmpdir()`. There is
 * deliberately NO homedir-prefix denylist — symlinked $HOME and
 * isolated-inside-homedir layouts must pass.
 *
 * Escape hatch `SCOUTLINE_NO_TEST_GUARD` uses STRICT equality (`=== "1"`),
 * unlike the #119/#137 truthiness convention: `=0` and every other value do
 * NOT bypass. The error message says so.
 *
 * Containment compares the DEEPEST-EXISTING-ANCESTOR realpath of both the
 * target and each approved root (PR #160 review): a symlink at any existing
 * level of either path is resolved before the prefix test, so a link inside
 * an allowed root pointing at a real store can no longer authorize the
 * write, and an allowed root that IS a symlink compares as its real target.
 * Valid symlinked roots (link -> isolated dir) keep working.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ScoutlineError } from "./errors.js";

const ISOLATION_ENV_VARS = [
  "SCOUTLINE_CONFIG_DIR",
  "SCOUTLINE_ARTIFACTS_DIR",
  "SCOUTLINE_CACHE_DIR",
  "SCOUTLINE_WATCH_DIR",
  "ZAI_MCP_CACHE_DIR",
  "ZAI_CACHE_DIR",
] as const;

export class TestIsolationViolationError extends ScoutlineError {
  readonly seam: string;
  readonly resolvedPath: string;
  constructor(seam: string, resolvedPath: string, message: string) {
    super(message, "TEST_ISOLATION_VIOLATION", { exitCode: 1 });
    this.name = "TestIsolationViolationError";
    this.seam = seam;
    this.resolvedPath = resolvedPath;
  }
}

export function isTestIsolationViolation(
  error: unknown,
): error is TestIsolationViolationError {
  return error instanceof TestIsolationViolationError;
}

/**
 * realpath the DEEPEST EXISTING ANCESTOR of `p`, then append the
 * nonexistent suffix (PR #160 review: lexical containment can be bypassed by
 * a symlink at any existing path level — target OR root). A missing path
 * stays lexical. Throws on realpath errors other than ENOENT (incl. symlink
 * loops — ELOOP), so a loop can never be silently authorized.
 */
function realpathDeepestExisting(p: string): string {
  const resolved = path.resolve(p);
  const segments = resolved.split(path.sep);
  // Walk from the root down; the deepest prefix that exists gets realpath'd.
  for (let i = segments.length; i >= 1; i -= 1) {
    const prefix = segments.slice(0, i).join(path.sep) || path.sep;
    try {
      return fs.realpathSync(prefix) + path.sep + segments.slice(i).join(path.sep);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue;
      throw error; // ELOOP, EACCES, ... — fail loud, never silently allow.
    }
  }
  return resolved;
}

/** realpath the root where its segments exist; nonexistent root stays lexical. */
function realpathBestEffort(root: string): string {
  return realpathDeepestExisting(root);
}

/**
 * Throw `TestIsolationViolationError` when `absPath` (normalized via
 * `path.resolve`, so relative targets resolve against cwd) is a real-user-
 * store write from a test process. See module doc for the doctrine and the
 * three firing conditions.
 *
 * `seam` names the call site (e.g. "atomicReplaceFile") so the failing
 * author needs no design doc.
 */
export function assertTestSafeWrite(absPath: string, seam: string): void {
  if (!process.env.NODE_TEST_CONTEXT) return;
  if (process.env.SCOUTLINE_NO_TEST_GUARD === "1") return;

  const target = realpathDeepestExisting(absPath);
  const allowedRoots: string[] = [realpathDeepestExisting(os.tmpdir())];
  for (const name of ISOLATION_ENV_VARS) {
    const value = process.env[name];
    if (value) allowedRoots.push(realpathBestEffort(value));
  }
  const isolated = allowedRoots.some(
    (root) => {
      const normalized = path.resolve(root);
      return target === normalized || target.startsWith(normalized + path.sep);
    },
  );
  if (isolated) return;

  throw new TestIsolationViolationError(
    seam,
    target,
    `Refusing test write to ${target} at seam '${seam}': path is outside every isolation root (set SCOUTLINE_CONFIG_DIR/SCOUTLINE_ARTIFACTS_DIR/SCOUTLINE_CACHE_DIR/SCOUTLINE_WATCH_DIR to an isolated directory). SCOUTLINE_NO_TEST_GUARD=1 bypasses (strict check: =0 does NOT).`,
  );
}
