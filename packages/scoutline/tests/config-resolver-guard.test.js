import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { withTempDir } from "./helpers/temp-dir.js";
import { ConfigurationError } from "../dist/lib/errors.js";

/**
 * Pins for issue #119 — test-isolation resolver guard + config .bak
 * rotation.
 *
 * The guard lives ONLY in `resolveConfigRoot()` (the ambient process-env
 * seam); `resolveConfigRootPure` stays total/pure and is pinned by
 * config-store.test.js. `NODE_TEST_CONTEXT` is set by `node --test` in
 * every spawned test child (value varies by Node version — the guard
 * and these pins check "is set", never a literal).
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
  SCOUTLINE_CONFIG_DIR: undefined,
  SCOUTLINE_NO_TEST_GUARD: undefined,
};

describe("resolveConfigRoot test-isolation guard (issue #119)", () => {
  it("refuses the default root under a test context without injection", async () => {
    const { resolveConfigRoot } = await import("../dist/lib/config-store.js");
    await withEnv(guardOverrides, async () => {
      assert.throws(
        () => resolveConfigRoot(),
        (error) => {
          assert.ok(error instanceof ConfigurationError);
          assert.match(error.message, /SCOUTLINE_CONFIG_DIR/);
          return true;
        },
      );
    });
  });

  it("SCOUTLINE_NO_TEST_GUARD=1 bypasses the guard to the real default", async () => {
    const { resolveConfigRoot } = await import("../dist/lib/config-store.js");
    await withEnv({ ...guardOverrides, SCOUTLINE_NO_TEST_GUARD: "1" }, async () => {
      // Read-only assert: never writes the default root.
      assert.strictEqual(resolveConfigRoot(), path.join(os.homedir(), ".scoutline"));
    });
  });

  it("an injected SCOUTLINE_CONFIG_DIR resolves even under a test context", async () => {
    const { resolveConfigRoot } = await import("../dist/lib/config-store.js");
    const injected = path.join(os.tmpdir(), "scoutline-guard-injected");
    await withEnv({ ...guardOverrides, SCOUTLINE_CONFIG_DIR: injected }, async () => {
      assert.strictEqual(resolveConfigRoot(), injected);
    });
  });
});

describe("writeConfig .bak rotation (issue #119)", () => {
  it("rotates the previous generation to <file>.bak on overwrite", async (t) => {
    await withTempDir(t, async (dir) => {
      const { writeConfig } = await import("../dist/lib/config-store.js");
      const filePath = path.join(dir, "config.json");
      const v1 = { version: 1, providers: {}, fallbackEnabled: false };
      const v2 = { version: 1, providers: {}, fallbackEnabled: true };
      await writeConfig(v1, { filePath });
      await writeConfig(v2, { filePath });

      assert.deepStrictEqual(JSON.parse(await fs.readFile(filePath, "utf8")), v2);
      assert.deepStrictEqual(JSON.parse(await fs.readFile(`${filePath}.bak`, "utf8")), v1);
    });
  });

  it("the first write creates no .bak and succeeds cleanly", async (t) => {
    await withTempDir(t, async (dir) => {
      const { writeConfig } = await import("../dist/lib/config-store.js");
      const filePath = path.join(dir, "config.json");
      const v1 = { version: 1, providers: {} };
      await writeConfig(v1, { filePath });

      assert.deepStrictEqual(JSON.parse(await fs.readFile(filePath, "utf8")), v1);
      await assert.rejects(fs.stat(`${filePath}.bak`), (error) => {
        assert.strictEqual(error.code, "ENOENT");
        return true;
      });
    });
  });

  it("the .bak carries restrictive 0600 permissions", async (t) => {
    if (process.platform === "win32") return;
    await withTempDir(t, async (dir) => {
      const { writeConfig } = await import("../dist/lib/config-store.js");
      const filePath = path.join(dir, "config.json");
      await writeConfig({ version: 1, providers: {} }, { filePath });
      await writeConfig({ version: 1, providers: {}, fallbackEnabled: true }, { filePath });
      assert.strictEqual((await fs.stat(`${filePath}.bak`)).mode & 0o777, 0o600);
    });
  });
});
