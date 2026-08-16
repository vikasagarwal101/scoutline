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

async function baseDeps(invocation, env) {
  return {
    invocation,
    env,
    // `quotaState` must be the resolved QuotaState, not the Promise
    // `read()` returns — main skips its production read when the field
    // is defined and would thread the Promise through to handlers.
    quotaState: await createInMemoryQuotaStore().read(),
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
        const status = await main(["config", "get"], await baseDeps(invocation, { SCOUTLINE_CONFIG_DIR: dir }));
        assert.strictEqual(status, 0);
        assert.ok(stdout().includes("tavily"));
        assert.ok(stdout().includes("brave"));
        assert.ok(!stdout().includes("sk-live-zai-key-12345"), "credential must be masked");
        assert.strictEqual(stderr(), "");
      },
    );
  });

  it("config short-circuits before the credentialed config load", async (t) => {
    await withTempConfig(t, { version: 1, providers: {} }, async (dir) => {
      const { invocation, stdout, stderr } = makeInvocation();
      const failingLoad = async () => {
        throw new Error("credentialed config load must not run for config");
      };
      const status = await main(
        ["config", "get"],
        { ...(await baseDeps(invocation, { SCOUTLINE_CONFIG_DIR: dir })), loadScoutlineConfig: failingLoad },
      );
      assert.strictEqual(status, 0);
      assert.strictEqual(stderr(), "");
      assert.ok(stdout().length > 0, "config dump rendered");
    });
  });

  it("config get with a typo'd capability fails, never (not set)", async (t) => {
    await withTempConfig(t, { version: 1, providers: {} }, async (dir) => {
      const { invocation, stdout, stderr } = makeInvocation();
      const status = await main(
        ["config", "get", "routing.serch"],
        await baseDeps(invocation, { SCOUTLINE_CONFIG_DIR: dir }),
      );
      assert.strictEqual(status, 1);
      assert.ok(stderr().includes("Unknown capability"), stderr());
      assert.ok(!stdout().includes("(not set)"));
    });
  });

  it("trailing arguments are rejected for every config subcommand", async (t) => {
    await withTempConfig(t, { version: 1, providers: {} }, async (dir) => {
      for (const argv of [
        ["config", "get", "routing", "extra"],
        ["config", "set", "fallbackEnabled", "true", "extra"],
        ["config", "unset", "routing", "extra"],
      ]) {
        const { invocation, stderr } = makeInvocation();
        const status = await main(argv, await baseDeps(invocation, { SCOUTLINE_CONFIG_DIR: dir }));
        assert.strictEqual(status, 1, argv.join(" "));
        assert.ok(stderr().includes("Usage"), argv.join(" "));
      }
    });
  });

  it("provider field paths are unknown to get (never a provider dump)", async (t) => {
    await withTempConfig(
      t,
      { version: 1, providers: { zai: { apiKey: "sk-live-zai-key-12345", onboarded: true } } },
      async (dir) => {
        const { invocation, stderr } = makeInvocation();
        const status = await main(
          ["config", "get", "providers.zai.apiKey"],
          await baseDeps(invocation, { SCOUTLINE_CONFIG_DIR: dir }),
        );
        assert.strictEqual(status, 1);
        assert.ok(stderr().includes("Unknown config key"), stderr());
      },
    );
  });

  it("unknown provider ids are unknown keys, not credential paths", async (t) => {
    await withTempConfig(t, { version: 1, providers: {} }, async (dir) => {
      const { invocation, stderr } = makeInvocation();
      const status = await main(
        ["config", "set", "providers.tylvy.apiKey", "sk-xyz"],
        await baseDeps(invocation, { SCOUTLINE_CONFIG_DIR: dir }),
      );
      assert.strictEqual(status, 1);
      assert.ok(stderr().includes("Unknown config key"), stderr());
      assert.ok(!stderr().includes("credential-bearing"), stderr());
    });
  });

  it("config set end-to-end persists and is visible to the next get", async (t) => {
    await withTempConfig(t, { version: 1, providers: {} }, async (dir) => {
      const env = { SCOUTLINE_CONFIG_DIR: dir };
      const setIo = makeInvocation();
      const setStatus = await main(["config", "set", "routing.search", "brave, zai"], await baseDeps(setIo.invocation, env));
      assert.strictEqual(setStatus, 0);

      const { readConfig } = await import("../dist/lib/config-store.js");
      const stored = await readConfig({
        filePath: pathMod.join(dir, "config.json"),
        onWarning: () => {},
      });
      assert.deepStrictEqual(stored.routing, { search: ["brave", "zai"] });

      const getIo = makeInvocation();
      const getStatus = await main(["config", "get", "routing.search"], await baseDeps(getIo.invocation, env));
      assert.strictEqual(getStatus, 0);
      assert.ok(getIo.stdout().includes("brave"));
    });
  });

  it("config set with a typo exits 1 with the JSON error envelope on stderr", async (t) => {
    await withTempConfig(t, { version: 1, providers: {} }, async (dir) => {
      const { invocation, stdout, stderr } = makeInvocation();
      const status = await main(["config", "set", "routing.search", "tavlly"], await baseDeps(invocation, { SCOUTLINE_CONFIG_DIR: dir }));
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
        await baseDeps(invocation, { SCOUTLINE_CONFIG_DIR: dir }),
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
          await baseDeps(invocation, { SCOUTLINE_CONFIG_DIR: dir }),
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
      const status = await main(["config", "--help"], await baseDeps(invocation, { SCOUTLINE_CONFIG_DIR: dir }));
      assert.strictEqual(status, 0);
      assert.ok(stdout().includes("scoutline config get"));
    });
  });
});

// ===========================================================================
// Search-fanout plan, Ticket 4 — the `fanout` typed registry row. The
// switch is a first-class config key: strict boolean set, get round-trip,
// unset removal, and the mandated cost sentence on enable (DESIGN D7).
// All runs go through main() against a hermetic SCOUTLINE_CONFIG_DIR.
// ===========================================================================

describe("config fanout key (search-fanout plan, Ticket 4)", () => {
  const COST_SENTENCE =
    "every search will bill ALL configured search providers — N arms = N billable calls";

  async function readStored(dir) {
    const { readConfig } = await import("../dist/lib/config-store.js");
    return readConfig({
      filePath: pathMod.join(dir, "config.json"),
      onWarning: () => {},
    });
  }

  it("config set fanout true: exit 0, cost sentence on stderr, data-only stdout, persisted", async (t) => {
    await withTempConfig(t, { version: 1, providers: {} }, async (dir) => {
      const io = makeInvocation();
      const status = await main(
        ["config", "set", "fanout", "true"],
        await baseDeps(io.invocation, { SCOUTLINE_CONFIG_DIR: dir }),
      );
      assert.strictEqual(status, 0);
      assert.deepStrictEqual(JSON.parse(io.stdout()), { path: "fanout", value: true });
      assert.ok(io.stderr().includes(COST_SENTENCE), `cost sentence expected: ${io.stderr()}`);
      assert.strictEqual((await readStored(dir)).fanout, true);
    });
  });

  it("config get fanout round-trips the stored value", async (t) => {
    await withTempConfig(t, { version: 1, providers: {} }, async (dir) => {
      const env = { SCOUTLINE_CONFIG_DIR: dir };
      const setIo = makeInvocation();
      await main(["config", "set", "fanout", "true"], await baseDeps(setIo.invocation, env));
      const getIo = makeInvocation();
      const status = await main(["config", "get", "fanout"], await baseDeps(getIo.invocation, env));
      assert.strictEqual(status, 0);
      assert.strictEqual(getIo.stdout().trim(), "true");
    });
  });

  it("config get fanout on a fresh config reports null (not set)", async (t) => {
    await withTempConfig(t, { version: 1, providers: {} }, async (dir) => {
      const io = makeInvocation();
      const status = await main(
        ["config", "get", "fanout"],
        await baseDeps(io.invocation, { SCOUTLINE_CONFIG_DIR: dir }),
      );
      assert.strictEqual(status, 0);
      assert.strictEqual(io.stdout().trim(), "null");
    });
  });

  it("config set fanout false persists false and emits no cost sentence", async (t) => {
    await withTempConfig(t, { version: 1, providers: {} }, async (dir) => {
      const io = makeInvocation();
      const status = await main(
        ["config", "set", "fanout", "false"],
        await baseDeps(io.invocation, { SCOUTLINE_CONFIG_DIR: dir }),
      );
      assert.strictEqual(status, 0);
      assert.strictEqual(io.stderr(), "", "cost sentence is an enable-time warning only");
      assert.strictEqual((await readStored(dir)).fanout, false);
    });
  });

  it("config set fanout rejects non-boolean values (strict parse)", async (t) => {
    await withTempConfig(t, { version: 1, providers: {} }, async (dir) => {
      const io = makeInvocation();
      const status = await main(
        ["config", "set", "fanout", "yes"],
        await baseDeps(io.invocation, { SCOUTLINE_CONFIG_DIR: dir }),
      );
      assert.strictEqual(status, 1);
      assert.ok(io.stderr().includes("VALIDATION_ERROR"), io.stderr());
      assert.ok(io.stderr().includes("Invalid boolean"), io.stderr());
      assert.ok(io.stderr().includes("true, false"), io.stderr());
      assert.strictEqual((await readStored(dir)).fanout, undefined);
    });
  });

  it("config unset fanout removes the switch; a second unset fails", async (t) => {
    await withTempConfig(t, { version: 1, providers: {} }, async (dir) => {
      const env = { SCOUTLINE_CONFIG_DIR: dir };
      const setIo = makeInvocation();
      await main(["config", "set", "fanout", "true"], await baseDeps(setIo.invocation, env));

      const unsetIo = makeInvocation();
      const status = await main(
        ["config", "unset", "fanout"],
        await baseDeps(unsetIo.invocation, env),
      );
      assert.strictEqual(status, 0);
      const stored = await readStored(dir);
      assert.strictEqual(stored.fanout, undefined);
      assert.ok(!("fanout" in stored), "fanout key fully removed");

      const againIo = makeInvocation();
      const again = await main(
        ["config", "unset", "fanout"],
        await baseDeps(againIo.invocation, env),
      );
      assert.strictEqual(again, 1);
      assert.ok(againIo.stderr().includes("not set"), againIo.stderr());
    });
  });

  it("config set fanout true names only the eligible routed arms (review fix, round 2)", async (t) => {
    // With a routing table in play, tier-3 fan-out queries only the
    // routed ELIGIBLE arms (routing.search ∩ configured ∩ search-capable
    // — the same set resolveFanoutPlan computes). Naming a routed
    // provider that lacks credentials would falsely claim it bills on
    // every search. Here tavily is configured via its FILE key and
    // brave has no credentials at all.
    await withTempConfig(
      t,
      {
        version: 1,
        providers: { tavily: { apiKey: "tvly-file-key-not-in-env" } },
        routing: { search: ["tavily", "brave"] },
      },
      async (dir) => {
        const io = makeInvocation();
        const status = await main(
          ["config", "set", "fanout", "true"],
          await baseDeps(io.invocation, { SCOUTLINE_CONFIG_DIR: dir }),
        );
        assert.strictEqual(status, 0);
        assert.ok(
          io.stderr().includes("routing.search (tavily)"),
          `eligible routed arm named: ${io.stderr()}`,
        );
        assert.ok(
          !io.stderr().includes("brave"),
          `unconfigured routed provider must not be named as billable: ${io.stderr()}`,
        );
        assert.ok(
          !io.stderr().includes("bill ALL configured"),
          "no blanket ALL-providers claim when routing narrows the arms",
        );
        assert.strictEqual((await readStored(dir)).fanout, true);
      },
    );
  });

  it("config set fanout true with no eligible routed arm reports zero arms, not a false billable set", async (t) => {
    // routing.search names brave but nothing is configured: tier 3
    // resolves ZERO arms (DESIGN D6 — every search then fails with
    // VALIDATION_ERROR), so no provider bills. The notice must say so
    // instead of claiming brave will be billed.
    await withTempConfig(
      t,
      { version: 1, providers: {}, routing: { search: ["brave"] } },
      async (dir) => {
        const io = makeInvocation();
        const status = await main(
          ["config", "set", "fanout", "true"],
          await baseDeps(io.invocation, { SCOUTLINE_CONFIG_DIR: dir }),
        );
        assert.strictEqual(status, 0);
        assert.ok(io.stderr().includes("zero arms"), `zero-arms wording: ${io.stderr()}`);
        assert.ok(
          !io.stderr().includes("billable calls"),
          `nothing bills at zero arms: ${io.stderr()}`,
        );
        assert.ok(
          !io.stderr().includes("brave"),
          `ineligible provider must not be named: ${io.stderr()}`,
        );
        assert.strictEqual((await readStored(dir)).fanout, true);
      },
    );
  });

  it("config --help documents `config unset fanout` (review fix)", async (t) => {
    await withTempConfig(t, { version: 1, providers: {} }, async (dir) => {
      const io = makeInvocation();
      const status = await main(
        ["config", "--help"],
        await baseDeps(io.invocation, { SCOUTLINE_CONFIG_DIR: dir }),
      );
      assert.strictEqual(status, 0);
      assert.ok(
        io.stdout().includes("config unset fanout"),
        "help must show how to remove the standing fan-out switch",
      );
    });
  });
});
