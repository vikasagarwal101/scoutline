/**
 * Test helper: create and clean up a temporary directory.
 *
 * Usage:
 *   await withTempDir(t, async (dir) => { ... });
 *
 * Registers recursive cleanup with t.after; returns the absolute directory path.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const DEFAULT_PREFIX = "scoutline-test-";

export async function withTempDir(testContext, operation, options = {}) {
  const prefix = options.prefix || DEFAULT_PREFIX;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  // testContext is the node:test context (or any object exposing after())
  testContext.after?.(() => {
    fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });
  return operation(dir);
}
