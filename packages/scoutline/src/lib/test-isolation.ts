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
 * Known limitation: the target is compared LEXICALLY (`path.resolve`, no
 * realpath on the target's ancestor chain). A symlinked target whose real
 * location is under an isolated root may false-positive. Deepest-existing-
 * ancestor realpath is a possible cheap fix if this ever bites.
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

/** realpath the root where its segments exist; nonexistent root stays lexical. */
function realpathBestEffort(root: string): string {
  try {
    return fs.realpathSync(root);
  } catch {
    return root;
  }
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

  const target = path.resolve(absPath);
  const allowedRoots: string[] = [os.tmpdir()];
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
