import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { ConfigurationError } from "../dist/lib/errors.js";

/**
 * Pins for issue #137 — test-isolation resolver guard on ambient artifacts fallback.
 *
 * The guard lives in `resolveArtifactsDir()` on the ambient fallback seam;
 * `NODE_TEST_CONTEXT` is set by `node --test` in every spawned test child.
 * When `SCOUTLINE_ARTIFACTS_DIR` is omitted from both injected env and ambient
 * process.env, and no `SCOUTLINE_CONFIG_DIR` isolates the root, resolving to
 * the ambient homedir artifacts store throws `ConfigurationError`.
 * `SCOUTLINE_NO_TEST_GUARD=1` is the documented escape hatch.
 */

/** Run `operation` under a controlled env overlay, restoring after. */
async function withEnv(overrides, operation) {
  const saved = { ...process.env };
  try {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await operation();
  } finally {
    process.env = saved;
  }
}

const guardOverrides = {
  NODE_TEST_CONTEXT: "1",
  SCOUTLINE_ARTIFACTS_DIR: undefined,
  SCOUTLINE_CONFIG_DIR: undefined,
  SCOUTLINE_NO_TEST_GUARD: undefined,
};

describe("resolveArtifactsDir test-isolation guard (issue #137)", () => {
  it("refuses the default artifacts dir under a test context without injection", async () => {
    const { resolveArtifactsDir } = await import("../dist/lib/artifacts.js");
    await withEnv(guardOverrides, async () => {
      assert.throws(
        () => resolveArtifactsDir({}),
        (error) => {
          assert.ok(error instanceof ConfigurationError);
          assert.match(error.message, /SCOUTLINE_ARTIFACTS_DIR/);
          return true;
        },
      );
    });
  });

  it("ambient process.env.SCOUTLINE_ARTIFACTS_DIR does NOT satisfy the guard (resolver ignores it)", async () => {
    const { resolveArtifactsDir } = await import("../dist/lib/artifacts.js");
    // Regression pin (PR #155 review): the guard must decide ONLY from the injected env,
    // because the resolver never reads process.env.SCOUTLINE_ARTIFACTS_DIR. If the ambient
    // var is set but the injected env lacks isolation, resolution lands on the REAL store.
    await withEnv({ ...guardOverrides, SCOUTLINE_ARTIFACTS_DIR: "/tmp/ambient-should-not-matter" }, async () => {
      assert.throws(
        () => resolveArtifactsDir({}),
        (error) => {
          assert.ok(error instanceof ConfigurationError);
          return true;
        },
      );
    });
  });

  it("SCOUTLINE_NO_TEST_GUARD=1 bypasses the guard to the real default", async () => {
    const { resolveArtifactsDir } = await import("../dist/lib/artifacts.js");
    await withEnv({ ...guardOverrides, SCOUTLINE_NO_TEST_GUARD: "1" }, async () => {
      assert.strictEqual(
        resolveArtifactsDir({}),
        path.join(os.homedir(), ".scoutline", "artifacts"),
      );
    });
  });

  it("an injected SCOUTLINE_ARTIFACTS_DIR resolves even under a test context", async () => {
    const { resolveArtifactsDir } = await import("../dist/lib/artifacts.js");
    const injected = path.join(os.tmpdir(), "scoutline-guard-artifacts-injected");
    await withEnv(guardOverrides, async () => {
      assert.strictEqual(
        resolveArtifactsDir({ SCOUTLINE_ARTIFACTS_DIR: injected }),
        injected,
      );
    });
  });

  it("an injected SCOUTLINE_CONFIG_DIR resolves even under a test context", async () => {
    const { resolveArtifactsDir } = await import("../dist/lib/artifacts.js");
    const injectedConfig = path.join(os.tmpdir(), "scoutline-guard-config-injected");
    await withEnv(guardOverrides, async () => {
      assert.strictEqual(
        resolveArtifactsDir({ SCOUTLINE_CONFIG_DIR: injectedConfig }),
        path.join(injectedConfig, "artifacts"),
      );
    });
  });

  it("resolves the default artifacts dir when not in a test context", async () => {
    const { resolveArtifactsDir } = await import("../dist/lib/artifacts.js");
    await withEnv({ ...guardOverrides, NODE_TEST_CONTEXT: undefined }, async () => {
      assert.strictEqual(
        resolveArtifactsDir({}),
        path.join(os.homedir(), ".scoutline", "artifacts"),
      );
    });
  });
});
