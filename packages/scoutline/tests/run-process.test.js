/**
 * Pins for the runProcess env-isolation contract (issue #154).
 *
 * A spawned CLI child cannot inherit the test process's perimeter guards
 * (hermeticMainDeps injects deps.env, but the child re-reads the ambient
 * environment). buildIsolatedEnv is the child's ONLY protection: every
 * run gets fresh per-call SCOUTLINE_CONFIG_DIR, SCOUTLINE_CACHE_DIR, and
 * SCOUTLINE_ARTIFACTS_DIR temp dirs, and caller-supplied values
 * (options.env or inherited process.env) always win.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";

import { buildIsolatedEnv } from "./helpers/run-process.js";

describe("runProcess buildIsolatedEnv", () => {
  it("injects all three isolation dirs as distinct temp paths", async () => {
    const env = await buildIsolatedEnv({});
    assert.ok(env.SCOUTLINE_CONFIG_DIR.startsWith(os.tmpdir()));
    assert.ok(env.SCOUTLINE_CACHE_DIR.startsWith(os.tmpdir()));
    assert.ok(env.SCOUTLINE_ARTIFACTS_DIR.startsWith(os.tmpdir()));
    assert.notEqual(env.SCOUTLINE_CONFIG_DIR, env.SCOUTLINE_CACHE_DIR);
    assert.notEqual(env.SCOUTLINE_CONFIG_DIR, env.SCOUTLINE_ARTIFACTS_DIR);
    assert.notEqual(env.SCOUTLINE_CACHE_DIR, env.SCOUTLINE_ARTIFACTS_DIR);
  });

  it("creates fresh dirs per call", async () => {
    const a = await buildIsolatedEnv({});
    const b = await buildIsolatedEnv({});
    assert.notEqual(a.SCOUTLINE_CACHE_DIR, b.SCOUTLINE_CACHE_DIR);
    assert.notEqual(a.SCOUTLINE_ARTIFACTS_DIR, b.SCOUTLINE_ARTIFACTS_DIR);
    assert.notEqual(a.SCOUTLINE_CONFIG_DIR, b.SCOUTLINE_CONFIG_DIR);
  });

  it("caller-supplied env values win", async () => {
    const env = await buildIsolatedEnv({
      env: {
        SCOUTLINE_CACHE_DIR: "/custom/cache",
        SCOUTLINE_ARTIFACTS_DIR: "/custom/artifacts",
      },
    });
    assert.equal(env.SCOUTLINE_CACHE_DIR, "/custom/cache");
    assert.equal(env.SCOUTLINE_ARTIFACTS_DIR, "/custom/artifacts");
  });

  it("inherited process.env values win over injection", async () => {
    const prevCache = process.env.SCOUTLINE_CACHE_DIR;
    const prevArtifacts = process.env.SCOUTLINE_ARTIFACTS_DIR;
    process.env.SCOUTLINE_CACHE_DIR = "/ambient/cache";
    process.env.SCOUTLINE_ARTIFACTS_DIR = "/ambient/artifacts";
    try {
      const env = await buildIsolatedEnv({});
      assert.equal(env.SCOUTLINE_CACHE_DIR, "/ambient/cache");
      assert.equal(env.SCOUTLINE_ARTIFACTS_DIR, "/ambient/artifacts");
    } finally {
      if (prevCache === undefined) delete process.env.SCOUTLINE_CACHE_DIR;
      else process.env.SCOUTLINE_CACHE_DIR = prevCache;
      if (prevArtifacts === undefined) delete process.env.SCOUTLINE_ARTIFACTS_DIR;
      else process.env.SCOUTLINE_ARTIFACTS_DIR = prevArtifacts;
    }
  });

  it("configDir:false skips only the config-dir injection", async () => {
    // configDir:false disables the T3b config isolation only; the #154
    // cache/artifacts guards still apply. Ambient SCOUTLINE_CONFIG_DIR
    // (runner pins one) still flows through baseEnv — that is the
    // caller-values-win contract pinned above.
    const env = await buildIsolatedEnv({ configDir: false });
    assert.ok(env.SCOUTLINE_CACHE_DIR.startsWith(os.tmpdir()));
    assert.ok(env.SCOUTLINE_ARTIFACTS_DIR.startsWith(os.tmpdir()));
  });
});
