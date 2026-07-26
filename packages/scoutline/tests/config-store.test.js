import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { withTempDir } from "./helpers/temp-dir.js";
import { ConfigurationError } from "../dist/lib/errors.js";

describe("resolveConfigRootPure", () => {
  it("uses only SCOUTLINE_CONFIG_DIR and otherwise defaults to homedir/.scoutline", async () => {
    const { resolveConfigRootPure } = await import("../dist/lib/config-store.js");

    assert.strictEqual(
      resolveConfigRootPure(
        {
          SCOUTLINE_CONFIG_DIR: "/explicit/config",
          SCOUTLINE_CACHE_DIR: "/ignored/cache",
          ZAI_MCP_CACHE_DIR: "/ignored/tool-cache",
          ZAI_CACHE_DIR: "/ignored/response-cache",
        },
        { homedir: "/home/u" },
      ),
      "/explicit/config",
    );
    assert.strictEqual(
      resolveConfigRootPure(
        {
          SCOUTLINE_CACHE_DIR: "/ignored/cache",
          ZAI_MCP_CACHE_DIR: "/ignored/tool-cache",
          ZAI_CACHE_DIR: "/ignored/response-cache",
        },
        { homedir: "/home/u" },
      ),
      path.join("/home/u", ".scoutline"),
    );
  });
});

describe("readConfig", () => {
  it("treats an absent injected config file as an empty env-only configuration", async (t) => {
    await withTempDir(t, async (dir) => {
      const { readConfig } = await import("../dist/lib/config-store.js");

      const config = await readConfig({ filePath: path.join(dir, "config.json") });

      assert.deepStrictEqual(config, { version: 1, providers: {} });
    });
  });

  it("loads the versioned provider schema including verification and hintShown", async (t) => {
    await withTempDir(t, async (dir) => {
      const filePath = path.join(dir, "config.json");
      await fs.writeFile(
        filePath,
        JSON.stringify({
          version: 1,
          fallbackEnabled: true,
          hintShown: true,
          providers: {
            zai: {
              apiKey: "zai-key",
              onboarded: true,
              verification: { status: "verified", checkedAt: 1786000060000 },
            },
          },
        }),
      );
      const { readConfig } = await import("../dist/lib/config-store.js");

      const config = await readConfig({ filePath });

      assert.deepStrictEqual(config, {
        version: 1,
        fallbackEnabled: true,
        hintShown: true,
        providers: {
          zai: {
            apiKey: "zai-key",
            onboarded: true,
            verification: { status: "verified", checkedAt: 1786000060000 },
          },
        },
      });
    });
  });

  it("classifies malformed JSON as a structured corrupt-config error", async (t) => {
    await withTempDir(t, async (dir) => {
      const filePath = path.join(dir, "config.json");
      await fs.writeFile(filePath, "{not-json");
      const { readConfig } = await import("../dist/lib/config-store.js");

      await assert.rejects(
        readConfig({ filePath }),
        (error) => {
          assert.ok(error instanceof ConfigurationError);
          assert.strictEqual(error.code, "CONFIGURATION_ERROR");
          assert.strictEqual(error.exitCode, 3);
          assert.match(error.message, /config\.json is corrupt/i);
          assert.match(error.help, /scoutline init/i);
          return true;
        },
      );
    });
  });

  it("classifies an unsupported version as an upgrade error", async (t) => {
    await withTempDir(t, async (dir) => {
      const filePath = path.join(dir, "config.json");
      await fs.writeFile(filePath, JSON.stringify({ version: 2, providers: {} }));
      const { readConfig } = await import("../dist/lib/config-store.js");

      await assert.rejects(
        readConfig({ filePath }),
        (error) => {
          assert.ok(error instanceof ConfigurationError);
          assert.match(error.message, /unsupported config version 2/i);
          assert.match(error.help, /upgrade scoutline/i);
          return true;
        },
      );
    });
  });

  it("ignores unknown providers with a warning and treats blank keys as absent", async (t) => {
    await withTempDir(t, async (dir) => {
      const filePath = path.join(dir, "config.json");
      await fs.writeFile(
        filePath,
        JSON.stringify({
          version: 1,
          providers: {
            zai: { apiKey: "   ", onboarded: true },
            exa: { apiKey: "exa-key" },
            future_provider: { apiKey: "future-key" },
          },
        }),
      );
      const warnings = [];
      const { readConfig } = await import("../dist/lib/config-store.js");

      const config = await readConfig({ filePath, onWarning: (warning) => warnings.push(warning) });

      assert.deepStrictEqual(config, {
        version: 1,
        providers: { zai: { onboarded: true }, exa: { apiKey: "exa-key" } },
      });
      assert.deepStrictEqual(warnings, [
        {
          code: "UNKNOWN_PROVIDER",
          providerId: "future_provider",
          message: 'Ignoring unknown provider "future_provider" in config.json.',
        },
      ]);
    });
  });

  it("preserves a nonblank API key byte-for-byte", async (t) => {
    await withTempDir(t, async (dir) => {
      const filePath = path.join(dir, "config.json");
      await fs.writeFile(
        filePath,
        JSON.stringify({ version: 1, providers: { brave: { apiKey: "  raw-key  " } } }),
      );
      const { readConfig } = await import("../dist/lib/config-store.js");

      const config = await readConfig({ filePath });

      assert.strictEqual(config.providers.brave.apiKey, "  raw-key  ");
    });
  });

  it("classifies an unreadable config path separately from absent and malformed files", async (t) => {
    await withTempDir(t, async (dir) => {
      const filePath = path.join(dir, "config.json");
      await fs.mkdir(filePath);
      const { readConfig } = await import("../dist/lib/config-store.js");

      await assert.rejects(
        readConfig({ filePath }),
        (error) => {
          assert.ok(error instanceof ConfigurationError);
          assert.match(error.message, /unable to read config\.json/i);
          assert.match(error.help, /scoutline init/i);
          return true;
        },
      );
    });
  });
});

describe("inspectConfig", () => {
  it("preserves absent, valid, and corrupt states for the repair flow", async (t) => {
    await withTempDir(t, async (dir) => {
      const filePath = path.join(dir, "config.json");
      const { inspectConfig } = await import("../dist/lib/config-store.js");

      assert.deepStrictEqual(await inspectConfig({ filePath }), { status: "absent", filePath });

      await fs.writeFile(
        filePath,
        JSON.stringify({ version: 1, providers: { exa: { apiKey: "key" }, future: {} } }),
      );
      assert.deepStrictEqual(await inspectConfig({ filePath }), {
        status: "valid",
        filePath,
        config: { version: 1, providers: { exa: { apiKey: "key" } } },
        warnings: [
          {
            code: "UNKNOWN_PROVIDER",
            providerId: "future",
            message: 'Ignoring unknown provider "future" in config.json.',
          },
        ],
      });

      await fs.writeFile(filePath, "broken");
      const corrupt = await inspectConfig({ filePath });
      assert.strictEqual(corrupt.status, "corrupt");
      assert.strictEqual(corrupt.filePath, filePath);
      assert.ok(corrupt.error instanceof ConfigurationError);
    });
  });
});

describe("writeConfig", () => {
  it("atomically writes formatted config with private file and root permissions", async (t) => {
    await withTempDir(t, async (dir) => {
      const root = path.join(dir, "config-root");
      const filePath = path.join(root, "config.json");
      await fs.mkdir(root, { mode: 0o777 });
      await fs.chmod(root, 0o777);
      const { writeConfig, readConfig } = await import("../dist/lib/config-store.js");

      await writeConfig(
        {
          version: 1,
          fallbackEnabled: false,
          hintShown: true,
          providers: { tavily: { apiKey: "tvly-key", onboarded: true } },
        },
        { filePath },
      );

      assert.deepStrictEqual(await readConfig({ filePath }), {
        version: 1,
        fallbackEnabled: false,
        hintShown: true,
        providers: { tavily: { apiKey: "tvly-key", onboarded: true } },
      });
      assert.match(await fs.readFile(filePath, "utf8"), /\n  "providers":/);
      assert.strictEqual((await fs.stat(filePath)).mode & 0o777, 0o600);
      if (process.platform !== "win32") {
        assert.strictEqual((await fs.stat(root)).mode & 0o777, 0o700);
      }
      assert.deepStrictEqual(await fs.readdir(root), ["config.json"]);
    });
  });

  it("preserves the prior target and cleans the orphan temp when replacement fails", async (t) => {
    await withTempDir(t, async (dir) => {
      const filePath = path.join(dir, "config.json");
      await fs.writeFile(filePath, "previous");
      const { atomicReplaceFile } = await import("../dist/lib/config-store.js");

      await assert.rejects(
        atomicReplaceFile(filePath, "next", {
          rename: async () => {
            const error = new Error("simulated interruption before rename");
            error.code = "EIO";
            throw error;
          },
        }),
        /simulated interruption/,
      );

      assert.strictEqual(await fs.readFile(filePath, "utf8"), "previous");
      assert.deepStrictEqual(await fs.readdir(dir), ["config.json"]);
    });
  });

  it("uses collision-free temp names across concurrent replacements", async (t) => {
    await withTempDir(t, async (dir) => {
      const filePath = path.join(dir, "config.json");
      const tempPaths = [];
      const { atomicReplaceFile } = await import("../dist/lib/config-store.js");
      const rename = async (source, target) => {
        tempPaths.push(source);
        await fs.rename(source, target);
      };

      await Promise.all(
        Array.from({ length: 16 }, (_, index) =>
          atomicReplaceFile(filePath, `value-${index}`, { rename }),
        ),
      );

      assert.strictEqual(new Set(tempPaths).size, 16);
      assert.match(await fs.readFile(filePath, "utf8"), /^value-\d+$/);
      assert.deepStrictEqual(await fs.readdir(dir), ["config.json"]);
    });
  });

  it("uses replacing rename on the narrowed Windows path without deleting the live target", async (t) => {
    await withTempDir(t, async (dir) => {
      const filePath = path.join(dir, "config.json");
      await fs.writeFile(filePath, "old");
      const { atomicReplaceFile } = await import("../dist/lib/config-store.js");
      let renameCalls = 0;

      await atomicReplaceFile(filePath, "new", {
        platform: "win32",
        rename: async (source, target) => {
          renameCalls += 1;
          assert.strictEqual(await fs.readFile(target, "utf8"), "old");
          await fs.rename(source, target);
        },
      });

      assert.strictEqual(renameCalls, 1);
      assert.strictEqual(await fs.readFile(filePath, "utf8"), "new");
      assert.deepStrictEqual(await fs.readdir(dir), ["config.json"]);
    });
  });
});
