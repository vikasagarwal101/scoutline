/**
 * Config command family (routing-table plan, Ticket 4) — presentation
 * layer over the typed key registry. All dependencies are doubles;
 * nothing touches the filesystem or the real config store.
 *
 * The registry's OWN strictness (typo failure, credential refusal,
 * round-trip) is covered by tests/config-store.test.js; this file
 * asserts the command layer: redaction, path resolution errors,
 * presentation rendering, and result shapes.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  CONFIG_HELP,
  configGetCommand,
  configSetCommand,
  configUnsetCommand,
} from "../dist/commands/config.js";
import { ValidationError } from "../dist/lib/errors.js";

const BASE_CONFIG = {
  version: 1,
  providers: {
    zai: { apiKey: "sk-zai-secret-value", onboarded: true },
  },
  fallbackEnabled: true,
  routing: { search: ["tavily", "brave"], crawl: ["firecrawl"] },
};

function getDoubles(config = BASE_CONFIG, secrets = ["sk-zai-secret-value"]) {
  return { read: async () => config, secrets: () => secrets };
}

describe("config get", () => {
  it("full dump redacts credential values in data mode", async () => {
    const result = await configGetCommand(undefined, getDoubles());
    assert.strictEqual(result.kind, "data");
    const data = JSON.stringify(result.data);
    assert.ok(!data.includes("sk-zai-secret-value"), "raw key must never appear");
    assert.ok(data.includes("zai"), "structure preserved");
  });

  it("path get returns the routing table with human presentations", async () => {
    const result = await configGetCommand("routing", getDoubles());
    assert.deepStrictEqual(result.data, BASE_CONFIG.routing);
    const text = Object.values(result.presentations ?? {}).join("\n");
    assert.ok(text.includes("search → tavily, brave"));
    assert.ok(text.includes("crawl → firecrawl"));
  });

  it("routing capability get returns just that list", async () => {
    const result = await configGetCommand("routing.search", getDoubles());
    assert.deepStrictEqual(result.data, ["tavily", "brave"]);
  });

  it("fallbackEnabled get returns the scalar", async () => {
    const result = await configGetCommand("fallbackEnabled", getDoubles());
    assert.strictEqual(result.data, true);
  });

  it("provider view masks the apiKey by field name even when not in the secrets list", async () => {
    // File-stored key not present in env: key-name masking must still apply.
    const result = await configGetCommand("providers.zai", getDoubles(BASE_CONFIG, []));
    const data = JSON.stringify(result.data);
    assert.ok(!data.includes("sk-zai-secret-value"));
  });

  it("unknown path fails listing the valid roots", async () => {
    await assert.rejects(
      () => configGetCommand("nope.nope", getDoubles()),
      (error) => {
        assert.strictEqual(error.name, "ValidationError");
        assert.ok(error.message.includes("nope.nope"));
        assert.ok(error.help.includes("routing"));
        assert.ok(error.help.includes("providers.<id>"));
        return true;
      },
    );
  });

  it("unset path renders as (not set)", async () => {
    const result = await configGetCommand("routing.map", getDoubles());
    assert.strictEqual(result.data, null);
    assert.ok(
      Object.values(result.presentations ?? {}).join("\n").includes("(not set)"),
    );
  });
});

describe("config set", () => {
  function setDoubles() {
    let stored = { ...BASE_CONFIG, routing: { ...BASE_CONFIG.routing } };
    return {
      deps: {
        set: async (path, value) => {
          // Minimal strict-double: mirror the registry's contract for
          // the paths these tests exercise.
          if (path === "routing.search") {
            const ids = value.split(",").map((v) => v.trim().toLowerCase());
            for (const id of ids) {
              if (!["zai", "minimax", "tavily", "exa", "brave", "firecrawl"].includes(id)) {
                throw new ValidationError(
                  `Unknown provider "${id}".`,
                  "Accepted provider IDs: zai, minimax, tavily, exa, brave, firecrawl.",
                );
              }
            }
            stored = { ...stored, routing: { ...stored.routing, search: ids } };
            return stored;
          }
          if (path === "providers.zai.apiKey") {
            throw new ValidationError(
              '"providers.zai.apiKey" is credential-bearing.',
              "Use `scoutline init` or the provider's environment variable instead.",
            );
          }
          throw new ValidationError(`Unknown config key "${path}".`, "Run help.");
        },
      },
      stored: () => stored,
    };
  }

  it("success returns the stored value with presentations", async () => {
    const { deps, stored } = setDoubles();
    const result = await configSetCommand("routing.search", "brave, zai", deps);
    assert.deepStrictEqual(result.data, { path: "routing.search", value: ["brave", "zai"] });
    assert.deepStrictEqual(stored().routing.search, ["brave", "zai"]);
    assert.ok(
      Object.values(result.presentations ?? {}).join("\n").includes("routing.search →"),
    );
  });

  it("registry strictness propagates (typo'd id)", async () => {
    const { deps } = setDoubles();
    await assert.rejects(
      () => configSetCommand("routing.search", "tavlly", deps),
      (error) => error.name === "ValidationError" && error.message.includes("tavlly"),
    );
  });

  it("credential refusal propagates with init pointer", async () => {
    const { deps } = setDoubles();
    await assert.rejects(
      () => configSetCommand("providers.zai.apiKey", "x", deps),
      (error) => error.help.includes("init"),
    );
  });
});

describe("config unset", () => {
  it("reports the removed path", async () => {
    const result = await configUnsetCommand("routing.search", {
      unset: async (path) => {
        assert.strictEqual(path, "routing.search");
        return BASE_CONFIG;
      },
    });
    assert.deepStrictEqual(result.data, { path: "routing.search" });
    assert.ok(
      Object.values(result.presentations ?? {}).join("\n").includes("(not set)"),
    );
  });

  it("registry unset failure propagates", async () => {
    await assert.rejects(
      () =>
        configUnsetCommand("routing.search", {
          unset: async () => {
            throw new ValidationError('"routing.search" is not set.', "Nothing to unset.");
          },
        }),
      (error) => error.name === "ValidationError",
    );
  });
});

describe("config help", () => {
  it("documents get/set/unset, redaction, and the routing semantics", () => {
    assert.ok(CONFIG_HELP.includes("config get"));
    assert.ok(CONFIG_HELP.includes("config set"));
    assert.ok(CONFIG_HELP.includes("config unset"));
    assert.ok(CONFIG_HELP.includes("redacted"));
    assert.ok(CONFIG_HELP.includes("routing.search"));
    assert.ok(CONFIG_HELP.includes("never belong in"));
  });
});

// ===========================================================================
// Dispatcher wiring (routing-table plan, Ticket 5) — main-driven,
// hermetic via SCOUTLINE_CONFIG_DIR. Nothing touches the real
// ~/.scoutline/config.json.
// ===========================================================================

import { main } from "../dist/index.js";
import { createInMemoryQuotaStore } from "../dist/lib/quota-store.js";
import * as fsMod from "node:fs/promises";
import * as osMod from "node:os";
import * as pathMod from "node:path";

function makeInvocation() {
  const stdout = [];
  const stderr = [];
  return {
    invocation: {
      stdoutIsTTY: false,
      stdinIsTTY: false,
      environmentOutputMode: "data",
      readStdin: async () => "",
      writeStdout: (text) => stdout.push(text),
      writeStderr: (text) => stderr.push(text),
      runQuietly: async (op) => op(),
      setExitCode: () => {},
    },
    stdout: () => stdout.join(""),
    stderr: () => stderr.join(""),
  };
}

async function withTempConfig(t, initialConfig, run) {
  const dir = await fsMod.mkdtemp(pathMod.join(osMod.tmpdir(), "scoutline-config-cmd-"));
  t.after(async () => {
    await fsMod.rm(dir, { recursive: true, force: true });
  });
  const { writeConfig } = await import("../dist/lib/config-store.js");
  await writeConfig(initialConfig, {
    filePath: pathMod.join(dir, "config.json"),
    onWarning: () => {},
  });
  await run(dir);
}

function baseDeps(invocation, env) {
  return {
    invocation,
    env,
    quotaState: createInMemoryQuotaStore().read(),
  };
}

describe("config command dispatcher", () => {
  it("config get end-to-end: redacted routing visible, credential masked", async (t) => {
    await withTempConfig(
      t,
      {
        version: 1,
        providers: { zai: { apiKey: "sk-live-zai-key-12345", onboarded: true } },
        routing: { search: ["tavily", "brave"] },
      },
      async (dir) => {
        const { invocation, stdout, stderr } = makeInvocation();
        const status = await main(["config", "get"], baseDeps(invocation, { SCOUTLINE_CONFIG_DIR: dir }));
        assert.strictEqual(status, 0);
        assert.ok(stdout().includes("tavily"));
        assert.ok(stdout().includes("brave"));
        assert.ok(!stdout().includes("sk-live-zai-key-12345"), "credential must be masked");
        assert.strictEqual(stderr(), "");
      },
    );
  });

  it("config set end-to-end persists and is visible to the next get", async (t) => {
    await withTempConfig(t, { version: 1, providers: {} }, async (dir) => {
      const env = { SCOUTLINE_CONFIG_DIR: dir };
      const setIo = makeInvocation();
      const setStatus = await main(["config", "set", "routing.search", "brave, zai"], baseDeps(setIo.invocation, env));
      assert.strictEqual(setStatus, 0);

      const { readConfig } = await import("../dist/lib/config-store.js");
      const stored = await readConfig({
        filePath: pathMod.join(dir, "config.json"),
        onWarning: () => {},
      });
      assert.deepStrictEqual(stored.routing, { search: ["brave", "zai"] });

      const getIo = makeInvocation();
      const getStatus = await main(["config", "get", "routing.search"], baseDeps(getIo.invocation, env));
      assert.strictEqual(getStatus, 0);
      assert.ok(getIo.stdout().includes("brave"));
    });
  });

  it("config set with a typo exits 1 with the JSON error envelope on stderr", async (t) => {
    await withTempConfig(t, { version: 1, providers: {} }, async (dir) => {
      const { invocation, stdout, stderr } = makeInvocation();
      const status = await main(["config", "set", "routing.search", "tavlly"], baseDeps(invocation, { SCOUTLINE_CONFIG_DIR: dir }));
      assert.strictEqual(status, 1);
      assert.strictEqual(stdout(), "");
      assert.ok(stderr().includes("VALIDATION_ERROR"));
      assert.ok(stderr().includes("tavlly"));
    });
  });

  it("credential path set is refused end-to-end with the init pointer", async (t) => {
    await withTempConfig(t, { version: 1, providers: {} }, async (dir) => {
      const { invocation, stderr } = makeInvocation();
      const status = await main(
        ["config", "set", "providers.zai.apiKey", "sk-xyz"],
        baseDeps(invocation, { SCOUTLINE_CONFIG_DIR: dir }),
      );
      assert.strictEqual(status, 1);
      assert.ok(stderr().includes("init"));
    });
  });

  it("config unset end-to-end removes the entry", async (t) => {
    await withTempConfig(
      t,
      { version: 1, providers: {}, routing: { search: ["brave"], crawl: ["firecrawl"] } },
      async (dir) => {
        const { invocation } = makeInvocation();
        const status = await main(
          ["config", "unset", "routing.search"],
          baseDeps(invocation, { SCOUTLINE_CONFIG_DIR: dir }),
        );
        assert.strictEqual(status, 0);
        const { readConfig } = await import("../dist/lib/config-store.js");
        const stored = await readConfig({
          filePath: pathMod.join(dir, "config.json"),
          onWarning: () => {},
        });
        assert.deepStrictEqual(stored.routing, { crawl: ["firecrawl"] });
      },
    );
  });

  it("config --help prints the family help", async (t) => {
    await withTempConfig(t, { version: 1, providers: {} }, async (dir) => {
      const { invocation, stdout } = makeInvocation();
      const status = await main(["config", "--help"], baseDeps(invocation, { SCOUTLINE_CONFIG_DIR: dir }));
      assert.strictEqual(status, 0);
      assert.ok(stdout().includes("scoutline config get"));
    });
  });
});
