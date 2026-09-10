/**
 * #119 bare-glob sweep: pin the ambient config root to a fresh
 * per-process temp directory for this test file.
 *
 * `node --test` sets NODE_TEST_CONTEXT, and the #119 resolver guard then
 * refuses `resolveConfigRoot()`'s default `~/.scoutline` — which `main()`
 * (quota store, agent-registration check, init roots) and direct
 * config-store/quota-store calls hit. Test files that do not route every
 * call through `hermeticMainDeps` call `useTempConfigDir()` once at
 * module scope: the file-level before/after pair pins process.env for
 * the whole file (covering direct store calls) and restores/cleans up
 * afterwards. Subprocess helpers (`runProcess`) isolate their own child
 * env independently and are unaffected.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before } from "node:test";

export function useTempConfigDir() {
  // State-guarded after(): if mkdtempSync throws, `pinned` stays false
  // and `dir` stays undefined, so after() no-ops instead of masking the
  // original before() failure with ERR_INVALID_ARG_TYPE from
  // rmSync(undefined).
  let pinned = false;
  let dir;
  let previous;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "scoutline-test-config-"));
    previous = process.env.SCOUTLINE_CONFIG_DIR;
    process.env.SCOUTLINE_CONFIG_DIR = dir;
    pinned = true;
  });
  after(() => {
    if (pinned) {
      if (previous === undefined) delete process.env.SCOUTLINE_CONFIG_DIR;
      else process.env.SCOUTLINE_CONFIG_DIR = previous;
    }
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  });
}
