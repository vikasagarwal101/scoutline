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

// ===========================================================================
// Routing key (routing-table plan, Ticket 2) — additive optional key,
// lenient load-time validation: warn and drop, never a load failure.
// ===========================================================================

describe("config routing key", () => {
  async function inspect(contents) {
    const { inspectConfig } = await import("../dist/lib/config-store.js");
    return withTempFileContents(contents, (filePath) => inspectConfig({ filePath }));
  }

  // Helper: write raw JSON contents to a temp config file and run the
  // given async callback against its path. Reuses the suite's temp-dir
  // discipline so no test touches the real ~/.scoutline/config.json.
  async function withTempFileContents(contents, run) {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const os = await import("node:os");
    const pathMod = await import("node:path");
    const dir = await mkdtemp(pathMod.join(os.tmpdir(), "scoutline-routing-"));
    try {
      const filePath = pathMod.join(dir, "config.json");
      await writeFile(filePath, typeof contents === "string" ? contents : JSON.stringify(contents));
      return await run(filePath);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it("parses a valid routing table", async () => {
    const result = await inspect({
      version: 1,
      providers: {},
      routing: { search: ["tavily", "brave"], crawl: ["firecrawl"] },
    });
    assert.strictEqual(result.status, "valid");
    assert.deepStrictEqual(result.config.routing, {
      search: ["tavily", "brave"],
      crawl: ["firecrawl"],
    });
    assert.deepStrictEqual(result.warnings, []);
  });

  it("unknown provider id is warned and dropped; the rest of the list is kept", async () => {
    const result = await inspect({
      version: 1,
      providers: {},
      routing: { search: ["tavlly", "brave"] },
    });
    assert.strictEqual(result.status, "valid");
    assert.deepStrictEqual(result.config.routing, { search: ["brave"] });
    assert.strictEqual(result.warnings.length, 1);
    assert.strictEqual(result.warnings[0].code, "UNKNOWN_PROVIDER");
    assert.ok(result.warnings[0].message.includes("tavlly"));
  });

  it("unknown capability key is warned and dropped (UNKNOWN_CAPABILITY)", async () => {
    const result = await inspect({
      version: 1,
      providers: {},
      routing: { serch: ["tavily"], crawl: ["firecrawl"] },
    });
    assert.strictEqual(result.status, "valid");
    assert.deepStrictEqual(result.config.routing, { crawl: ["firecrawl"] });
    assert.strictEqual(result.warnings.length, 1);
    assert.strictEqual(result.warnings[0].code, "UNKNOWN_CAPABILITY");
    assert.ok(result.warnings[0].message.includes("serch"));
  });

  it("duplicate ids deduplicate preserving first occurrence", async () => {
    const result = await inspect({
      version: 1,
      providers: {},
      routing: { search: ["tavily", "tavily", "brave"] },
    });
    assert.deepStrictEqual(result.config.routing, { search: ["tavily", "brave"] });
  });

  it("empty list is treated as absent (key omitted from parsed config)", async () => {
    const result = await inspect({
      version: 1,
      providers: {},
      routing: { search: [] },
    });
    assert.strictEqual(result.config.routing, undefined);
  });

  it("malformed routing value (not a record) warns and drops, never fails the load", async () => {
    const result = await inspect({
      version: 1,
      providers: {},
      routing: "tavily",
    });
    assert.strictEqual(result.status, "valid");
    assert.strictEqual(result.config.routing, undefined);
    assert.ok(result.warnings.length >= 1);
  });

  it("malformed list entries (non-strings) warn and drop the key", async () => {
    const result = await inspect({
      version: 1,
      providers: {},
      routing: { search: ["tavily", 42] },
    });
    assert.strictEqual(result.status, "valid");
    assert.strictEqual(result.config.routing, undefined);
    assert.ok(result.warnings.length >= 1);
  });

  it("writeConfig round-trips the routing key", async (t) => {
    await withTempDir(t, async (dir) => {
      const pathMod = await import("node:path");
      const fsMod = await import("node:fs/promises");
      const { writeConfig, readConfig } = await import("../dist/lib/config-store.js");
      const filePath = pathMod.join(dir, "config.json");
      await writeConfig(
        { version: 1, providers: {}, routing: { search: ["tavily", "brave"] } },
        { filePath, onWarning: () => {} },
      );
      const onDisk = JSON.parse(await fsMod.readFile(filePath, "utf8"));
      assert.deepStrictEqual(onDisk.routing, { search: ["tavily", "brave"] });
      const reread = await readConfig({ filePath, onWarning: () => {} });
      assert.deepStrictEqual(reread.routing, { search: ["tavily", "brave"] });
    });
  });

  it("config without a routing key parses with no warnings and no routing field", async () => {
    const result = await inspect({ version: 1, providers: {} });
    assert.strictEqual(result.config.routing, undefined);
    assert.deepStrictEqual(result.warnings, []);
  });
});

// ===========================================================================
// Typed key registry (routing-table plan, Ticket 3) — strict set/unset
// helpers over atomic read-modify-write. Set is STRICT (explicit
// command must not silently store a different value than typed);
// credential-bearing paths refuse set outright (API keys never ride
// argv).
// ===========================================================================

describe("config key registry", () => {
  // The registry helpers take explicit filePath options; every test
  // builds its own temp config so nothing touches the real store.
  async function withConfig(t, initial, run) {
    const { writeConfig } = await import("../dist/lib/config-store.js");
    await withTempDir(t, async (dir) => {
      const filePath = path.join(dir, "config.json");
      await writeConfig(initial, { filePath, onWarning: () => {} });
      await run(filePath);
    });
  }

  it("resolveConfigKey matches exact and parameterized paths", async () => {
    const { resolveConfigKey } = await import("../dist/lib/config-store.js");
    assert.ok(resolveConfigKey("fallbackEnabled")?.settable);
    const routing = resolveConfigKey("routing.search");
    assert.ok(routing?.settable);
    assert.strictEqual(resolveConfigKey("routing")?.path, "routing");
    const provider = resolveConfigKey("providers.tavily");
    assert.ok(provider?.gettable && !provider?.settable && provider?.credential);
    assert.strictEqual(resolveConfigKey("version"), null);
    assert.strictEqual(resolveConfigKey("hintShown"), null);
    assert.strictEqual(resolveConfigKey("nope.nope"), null);
  });

  it("credential refusal echoes the full typed field path", async (t) => {
    await withConfig(t, { version: 1, providers: {} }, async (filePath) => {
      const { setConfigValue } = await import("../dist/lib/config-store.js");
      await assert.rejects(
        () => setConfigValue("providers.zai.apiKey", "x", { filePath }),
        (error) =>
          error.name === "ValidationError" && error.message.includes('"providers.zai.apiKey"'),
      );
    });
  });

  it("lock-acquisition failures surface as ConfigurationError; run errors pass through", async (t) => {
    await withTempDir(t, async (dir) => {
      const blocker = path.join(dir, "blocker");
      await fs.writeFile(blocker, "not a directory");
      const { setConfigValue } = await import("../dist/lib/config-store.js");
      // dirname(filePath) is a regular file, so the lock create fails
      // with ENOTDIR (a non-EEXIST open error): a lock-level failure
      // that must land in the writeConfig ConfigurationError contract.
      const filePath = path.join(blocker, "config.json");
      await assert.rejects(
        () => setConfigValue("fallbackEnabled", "true", { filePath }),
        (error) => error.name === "ConfigurationError",
      );
      // A validation failure inside the locked section stays a
      // ValidationError, never the lock/ConfigurationError wrap.
      const good = path.join(dir, "config.json");
      await fs.writeFile(good, JSON.stringify({ version: 1, providers: {} }));
      await assert.rejects(
        () => setConfigValue("fallbackEnabled", "maybe", { filePath: good }),
        (error) => error.name === "ValidationError",
      );
    });
  });

  it("resolveConfigKey validates provider ids and splits field paths", async () => {
    const { resolveConfigKey } = await import("../dist/lib/config-store.js");
    const view = resolveConfigKey("providers.tavily");
    assert.ok(view?.gettable && !view?.settable && view?.credential);
    const field = resolveConfigKey("providers.tavily.apiKey");
    assert.ok(field && !field.gettable && !field.settable && field.credential);
    assert.strictEqual(resolveConfigKey("providers.tylvy"), null);
    assert.strictEqual(resolveConfigKey("providers.tylvy.apiKey"), null);
    assert.strictEqual(resolveConfigKey("providers."), null);
  });

  it("resolveConfigKey rejects unknown capabilities", async () => {
    const { resolveConfigKey } = await import("../dist/lib/config-store.js");
    assert.strictEqual(resolveConfigKey("routing.serch"), null);
    assert.strictEqual(resolveConfigKey("routing."), null);
    assert.notStrictEqual(resolveConfigKey("routing.search"), null);
  });

  it("routing set on the table path itself is refused (not settable)", async (t) => {
    await withConfig(t, { version: 1, providers: {} }, async (filePath) => {
      const { setConfigValue } = await import("../dist/lib/config-store.js");
      await assert.rejects(
        () => setConfigValue("routing", "search:tavily", { filePath }),
        (error) => error.name === "ValidationError" && error.message.includes("not settable"),
      );
    });
  });

  it("unset routing removes the whole table; absent table fails", async (t) => {
    await withConfig(
      t,
      { version: 1, providers: {}, routing: { search: ["tavily"] } },
      async (filePath) => {
        const { unsetConfigValue, readConfig } = await import("../dist/lib/config-store.js");
        const updated = await unsetConfigValue("routing", { filePath });
        assert.strictEqual(updated.routing, undefined);
        const reread = await readConfig({ filePath, onWarning: () => {} });
        assert.strictEqual(reread.routing, undefined);
        await assert.rejects(
          () => unsetConfigValue("routing", { filePath }),
          (error) => error.name === "ValidationError" && error.message.includes("not set"),
        );
      },
    );
  });

  it("unset fallbackEnabled removes the switch; absent switch fails", async (t) => {
    await withConfig(
      t,
      { version: 1, providers: {}, fallbackEnabled: false },
      async (filePath) => {
        const { unsetConfigValue, readConfig } = await import("../dist/lib/config-store.js");
        const updated = await unsetConfigValue("fallbackEnabled", { filePath });
        assert.strictEqual(updated.fallbackEnabled, undefined);
        const reread = await readConfig({ filePath, onWarning: () => {} });
        assert.strictEqual(reread.fallbackEnabled, undefined);
        await assert.rejects(
          () => unsetConfigValue("fallbackEnabled", { filePath }),
          (error) => error.name === "ValidationError" && error.message.includes("not set"),
        );
      },
    );
  });

  it("routing set parses a strict comma list and persists", async (t) => {
    await withConfig(t, { version: 1, providers: {} }, async (filePath) => {
      const { setConfigValue, readConfig } = await import("../dist/lib/config-store.js");
      const updated = await setConfigValue("routing.search", "tavily, brave", { filePath });
      assert.deepStrictEqual(updated.routing, { search: ["tavily", "brave"] });
      const reread = await readConfig({ filePath, onWarning: () => {} });
      assert.deepStrictEqual(reread.routing, { search: ["tavily", "brave"] });
    });
  });

  it("routing set with a typo'd provider id fails strictly, naming the id", async (t) => {
    await withConfig(t, { version: 1, providers: {} }, async (filePath) => {
      const { setConfigValue } = await import("../dist/lib/config-store.js");
      await assert.rejects(
        () => setConfigValue("routing.search", "tavlly,brave", { filePath }),
        (error) => {
          assert.strictEqual(error.name, "ValidationError");
          assert.ok(error.message.includes("tavlly"));
          assert.ok(error.message.includes("tavily"));
          return true;
        },
      );
    });
  });

  it("routing set with an unknown capability fails strictly", async (t) => {
    await withConfig(t, { version: 1, providers: {} }, async (filePath) => {
      const { setConfigValue } = await import("../dist/lib/config-store.js");
      await assert.rejects(
        () => setConfigValue("routing.serch", "tavily", { filePath }),
        (error) => error.name === "ValidationError",
      );
    });
  });

  it("routing set with an empty list fails (not silently absent)", async (t) => {
    await withConfig(t, { version: 1, providers: {} }, async (filePath) => {
      const { setConfigValue } = await import("../dist/lib/config-store.js");
      await assert.rejects(
        () => setConfigValue("routing.search", " , ", { filePath }),
        (error) => error.name === "ValidationError",
      );
    });
  });

  it("fallbackEnabled set accepts true/false and round-trips", async (t) => {
    await withConfig(t, { version: 1, providers: {} }, async (filePath) => {
      const { setConfigValue, readConfig } = await import("../dist/lib/config-store.js");
      const updated = await setConfigValue("fallbackEnabled", "false", { filePath });
      assert.strictEqual(updated.fallbackEnabled, false);
      const reread = await readConfig({ filePath, onWarning: () => {} });
      assert.strictEqual(reread.fallbackEnabled, false);
    });
  });

  it("fallbackEnabled set rejects non-boolean strings", async (t) => {
    await withConfig(t, { version: 1, providers: {} }, async (filePath) => {
      const { setConfigValue } = await import("../dist/lib/config-store.js");
      await assert.rejects(
        () => setConfigValue("fallbackEnabled", "maybe", { filePath }),
        (error) => error.name === "ValidationError",
      );
    });
  });

  it("credential-bearing paths refuse set with a pointer to init/env", async (t) => {
    await withConfig(t, { version: 1, providers: {} }, async (filePath) => {
      const { setConfigValue } = await import("../dist/lib/config-store.js");
      await assert.rejects(
        () => setConfigValue("providers.zai.apiKey", "sk-secret", { filePath }),
        (error) => {
          assert.strictEqual(error.name, "ValidationError");
          assert.ok(error.help.includes("init"));
          return true;
        },
      );
    });
  });

  it("unset removes a routing capability, then the whole table when last", async (t) => {
    await withConfig(
      t,
      { version: 1, providers: {}, routing: { search: ["tavily"], crawl: ["firecrawl"] } },
      async (filePath) => {
        const { unsetConfigValue, readConfig } = await import("../dist/lib/config-store.js");
        let updated = await unsetConfigValue("routing.search", { filePath });
        assert.deepStrictEqual(updated.routing, { crawl: ["firecrawl"] });
        updated = await unsetConfigValue("routing.crawl", { filePath });
        assert.strictEqual(updated.routing, undefined);
        const reread = await readConfig({ filePath, onWarning: () => {} });
        assert.strictEqual(reread.routing, undefined);
      },
    );
  });

  it("unset of a nonexistent path fails", async (t) => {
    await withConfig(t, { version: 1, providers: {} }, async (filePath) => {
      const { unsetConfigValue } = await import("../dist/lib/config-store.js");
      await assert.rejects(
        () => unsetConfigValue("routing.search", { filePath }),
        (error) => error.name === "ValidationError",
      );
    });
  });

  it("set preserves unrelated keys (read-modify-write isolation)", async (t) => {
    await withConfig(
      t,
      { version: 1, providers: {}, fallbackEnabled: true, hintShown: true },
      async (filePath) => {
        const { setConfigValue, readConfig } = await import("../dist/lib/config-store.js");
        await setConfigValue("routing.search", "brave", { filePath });
        const reread = await readConfig({ filePath, onWarning: () => {} });
        assert.strictEqual(reread.fallbackEnabled, true);
        assert.strictEqual(reread.hintShown, true);
        assert.deepStrictEqual(reread.routing, { search: ["brave"] });
      },
    );
  });
});
