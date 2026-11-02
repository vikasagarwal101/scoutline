/**
 * T2a - Credential view: file keys flow to shared commands + fallback
 * wiring + command classification.
 *
 * Acceptance gates (Plan A - T2a ticket):
 *   - resolveEnvFromConfig: env overrides file; alias precedence preserved.
 *   - Command classification: --help / --version / cache short-circuit
 *     before config load (corrupt config can't block them).
 *   - Fallback wiring: config.fallbackEnabled narrows the executor below
 *     invocation/env opt-outs and above the default true.
 *   - Env-only regression: the env path is byte-for-byte unchanged when
 *     no config file exists.
 *   - Shared-command acceptance probe: a file-only key reaches a shared
 *     command (search) through a real descriptor/handler boundary and is
 *     redacted on success/error - with ambient provider keys absent.
 *   - Hermeticity: main() tests inject in-memory config + stores; no real
 *     config-root I/O.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { main } from "../dist/index.js";
import { resolveEnvFromConfig } from "../dist/lib/config-store.js";
import { configuredSecrets } from "../dist/lib/redact.js";
import { loadConfig, getApiKey } from "../dist/lib/config.js";
import { ConfigurationError, NetworkError } from "../dist/lib/errors.js";
import { useTempConfigDir } from "./helpers/config-dir-pin.js";
import { getHermeticArtifactsDir } from "./helpers/hermetic-main.js";

// #152: file-level cache-root isolation. The `cache stats` / `cache clear`
// main() runs here dispatch to cacheStats()/clearAllCaches(), which read
// the AMBIENT cache root (process.env) rather than the injected deps.env —
// without arming they scan/empty the developer's real ~/.scoutline/cache
// and ~/.scoutline/tools. Same shape as useTempConfigDir() above.
import { after, before } from "node:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
{
  let pinned = false;
  let dir;
  let previous;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "scoutline-test-cache-"));
    previous = process.env.SCOUTLINE_CACHE_DIR;
    process.env.SCOUTLINE_CACHE_DIR = dir;
    pinned = true;
  });
  after(() => {
    if (pinned) {
      if (previous === undefined) delete process.env.SCOUTLINE_CACHE_DIR;
      else process.env.SCOUTLINE_CACHE_DIR = previous;
    }
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  });
}

useTempConfigDir();

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function createTestAdapter(overrides = {}) {
  const stdout = [];
  const stderr = [];
  const adapter = {
    stdoutIsTTY: false,
    stdinIsTTY: false,
    environmentOutputMode: "data",
    readStdin: async () => "",
    writeStdout: (v) => stdout.push(v),
    writeStderr: (v) => stderr.push(v),
    runQuietly: async (op) => op(),
    setExitCode: () => {},
    ...overrides,
  };
  return { adapter, stdout, stderr };
}

/** A minimal CredentialDescriptor double for resolveEnvFromConfig unit tests. */
function credDescriptor(id, envVars, configured) {
  return {
    id,
    credentialEnvVars: envVars,
    isConfigured: (env) => (typeof configured === "function" ? configured(env) : configured),
  };
}

/**
 * Build a fake zai descriptor whose create({env}) captures the resolved
 * env so a test can prove a file-configured key reached the adapter.
 * The search capability embeds the resolved key into the result/error so
 * redaction is observable at the outward boundary.
 */
function makeKeyCapturingDescriptor(opts) {
  const {
    id = "zai",
    credentialEnvVars = ["Z_AI_API_KEY", "ZAI_API_KEY"],
    resultMode = "embed-key",
  } = opts || {};
  let capturedEnv = null;
  const invokes = [];
  const descriptor = {
    id,
    credentialEnvVars,
    isConfigured: (env) => {
      const v = env[credentialEnvVars[0]] || env[credentialEnvVars[1]];
      return typeof v === "string" && v.trim().length > 0;
    },
    capabilities: () => new Set(["search"]),
    create: ({ env }) => {
      capturedEnv = env;
      return {
        id,
        search: {
          validate() {},
          cacheIdentity(r) {
            return {
              provider: id,
              capability: "search",
              credentialFingerprint: "fp-" + id,
              request: r,
              legacyCandidates: [],
            };
          },
          async invoke(r) {
            invokes.push(r);
            const key = env[credentialEnvVars[0]] || env[credentialEnvVars[1]] || "";
            if (resultMode === "embed-key") {
              return [{ title: "result with key=" + key, url: "https://e/1", summary: "s" }];
            }
            if (resultMode === "throw-with-key") {
              // NetworkError is classified as fallback-eligible by the
              // provider-fallback executor, so the candidate loop advances
              // to the next provider. A plain Error would be re-thrown.
              throw new NetworkError("adapter failure exposing key=" + key);
            }
            return [];
          },
        },
      };
    },
  };
  return { descriptor, getCapturedEnv: () => capturedEnv, invokes };
}

function inMemoryCache() {
  const store = new Map();
  return {
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async set(key, value) {
      store.set(key, value);
    },
  };
}

// ---------------------------------------------------------------------------
// resolveEnvFromConfig - env overrides file, alias precedence preserved
// ---------------------------------------------------------------------------

describe("resolveEnvFromConfig - env overrides file, alias precedence preserved", () => {
  const ZAI = credDescriptor("zai", ["Z_AI_API_KEY", "ZAI_API_KEY"], (env) => {
    const v = env.Z_AI_API_KEY || env.ZAI_API_KEY;
    return typeof v === "string" && v.trim().length > 0;
  });
  const MMX = credDescriptor("minimax", ["MINIMAX_API_KEY"], (env) => {
    const v = env.MINIMAX_API_KEY;
    return typeof v === "string" && v.trim().length > 0;
  });
  const DESCRIPTORS = [ZAI, MMX];

  const configWithKeys = (providers) => ({ version: 1, providers });

  it("canonical-env key wins over a file key (Z_AI_API_KEY env beats file)", () => {
    const env = { Z_AI_API_KEY: "env-key" };
    const config = configWithKeys({ zai: { apiKey: "file-key" } });
    const resolved = resolveEnvFromConfig(env, config, DESCRIPTORS);
    assert.strictEqual(resolved.Z_AI_API_KEY, "env-key");
  });

  it("alias-env key wins over a file key (ZAI_API_KEY env beats file)", () => {
    const env = { ZAI_API_KEY: "alias-env-key" };
    const config = configWithKeys({ zai: { apiKey: "file-key" } });
    const resolved = resolveEnvFromConfig(env, config, DESCRIPTORS);
    assert.strictEqual(resolved.ZAI_API_KEY, "alias-env-key");
    assert.strictEqual(resolved.Z_AI_API_KEY, undefined);
  });

  it("blank env does not block a file key (blank-env fallback)", () => {
    const env = { Z_AI_API_KEY: "   " };
    const config = configWithKeys({ zai: { apiKey: "file-key" } });
    const resolved = resolveEnvFromConfig(env, config, DESCRIPTORS);
    assert.strictEqual(resolved.Z_AI_API_KEY, "file-key");
  });

  it("file-only key populates the canonical slot when env has no zai key", () => {
    const env = {};
    const config = configWithKeys({ zai: { apiKey: "file-only-key" } });
    const resolved = resolveEnvFromConfig(env, config, DESCRIPTORS);
    assert.strictEqual(resolved.Z_AI_API_KEY, "file-only-key");
  });

  it("file-only key for minimax populates MINIMAX_API_KEY", () => {
    const env = {};
    const config = configWithKeys({ minimax: { apiKey: "mmx-file-key" } });
    const resolved = resolveEnvFromConfig(env, config, DESCRIPTORS);
    assert.strictEqual(resolved.MINIMAX_API_KEY, "mmx-file-key");
  });

  it("blank file key is treated as absent (not populated)", () => {
    const env = {};
    const config = configWithKeys({ zai: { apiKey: "  " } });
    const resolved = resolveEnvFromConfig(env, config, DESCRIPTORS);
    assert.strictEqual(resolved.Z_AI_API_KEY, undefined);
  });

  it("process.env is never mutated", () => {
    const env = { Z_AI_API_KEY: "env-key" };
    const config = configWithKeys({ minimax: { apiKey: "file-key" } });
    const resolved = resolveEnvFromConfig(env, config, DESCRIPTORS);
    assert.strictEqual(resolved.MINIMAX_API_KEY, "file-key");
    assert.strictEqual(env.MINIMAX_API_KEY, undefined);
    assert.notStrictEqual(resolved, env);
  });

  it("empty config (no providers) returns env values unchanged", () => {
    const env = { Z_AI_API_KEY: "env-key", OTHER_VAR: "x" };
    const config = { version: 1, providers: {} };
    const resolved = resolveEnvFromConfig(env, config, DESCRIPTORS);
    assert.deepStrictEqual(resolved, env);
    assert.notStrictEqual(resolved, env);
  });

  it("unknown provider id in config is silently skipped", () => {
    const env = {};
    const config = configWithKeys({ unknown: { apiKey: "k" } });
    const resolved = resolveEnvFromConfig(env, config, DESCRIPTORS);
    assert.deepStrictEqual(resolved, {});
  });

  it("descriptor without credentialEnvVars is skipped", () => {
    const env = {};
    const bareDesc = { id: "zai", isConfigured: () => false };
    const config = configWithKeys({ zai: { apiKey: "file-key" } });
    const resolved = resolveEnvFromConfig(env, config, [bareDesc]);
    assert.deepStrictEqual(resolved, {});
  });
});

// ---------------------------------------------------------------------------
// loadConfig / getApiKey - explicit env parameter
// ---------------------------------------------------------------------------

describe("loadConfig(env) and getApiKey(env) - explicit env parameter", () => {
  it("loadConfig reads from the passed env, not process.env", () => {
    const cfg = loadConfig({ Z_AI_API_KEY: "explicit-key" });
    assert.strictEqual(cfg.apiKey, "explicit-key");
  });

  it("loadConfig defaults to process.env when env is omitted (no throw from signature)", () => {
    assert.doesNotThrow(() => {
      try {
        loadConfig();
      } catch (e) {
        if (!(e instanceof ConfigurationError)) throw e;
      }
    });
  });

  it("getApiKey reads from the passed env", () => {
    assert.strictEqual(getApiKey({ Z_AI_API_KEY: "gak-key" }), "gak-key");
    assert.strictEqual(getApiKey({ ZAI_API_KEY: "alias-key" }), "alias-key");
  });

  it("getApiKey throws ConfigurationError when env has no key", () => {
    assert.throws(
      () => getApiKey({}),
      (err) => err instanceof ConfigurationError && err.exitCode === 3,
    );
  });

  it("loadConfig respects Z_AI_API_KEY over ZAI_API_KEY alias", () => {
    const cfg = loadConfig({ Z_AI_API_KEY: "primary", ZAI_API_KEY: "alias" });
    assert.strictEqual(cfg.apiKey, "primary");
  });
});

// ---------------------------------------------------------------------------
// Command classification - help/version/cache short-circuit before config
// ---------------------------------------------------------------------------

describe("command classification: credential-free commands short-circuit before config load", () => {
  it("--help succeeds even when config reader throws (corrupt config)", async () => {
    const { adapter, stdout, stderr } = createTestAdapter();
    const status = await main(["--help"], {
      invocation: adapter,
      env: {},
      loadScoutlineConfig: async () => {
        throw new ConfigurationError("config.json is corrupt");
      },
    });
    assert.strictEqual(status, 0);
    assert.strictEqual(stderr.length, 0);
    assert.ok(stdout[0].includes("scoutline"));
  });

  it("--version succeeds even when config reader throws", async () => {
    const { adapter, stdout, stderr } = createTestAdapter();
    const status = await main(["--version"], {
      invocation: adapter,
      env: {},
      loadScoutlineConfig: async () => {
        throw new ConfigurationError("config.json is corrupt");
      },
    });
    assert.strictEqual(status, 0);
    assert.strictEqual(stderr.length, 0);
    assert.match(stdout[0].trim(), /^\d+\.\d+\.\d+$/);
  });

  it("cache stats succeeds even when config reader throws", async () => {
    const { adapter, stdout, stderr } = createTestAdapter();
    const status = await main(["cache", "stats"], {
      invocation: adapter,
      env: {},
      loadScoutlineConfig: async () => {
        throw new ConfigurationError("config.json is corrupt");
      },
    });
    assert.strictEqual(status, 0);
    assert.strictEqual(stderr.length, 0);
    assert.ok(stdout.length > 0);
  });

  it("cache clear succeeds even when config reader throws", async () => {
    const { adapter, stdout, stderr } = createTestAdapter();
    const status = await main(["cache", "clear"], {
      invocation: adapter,
      env: {},
      loadScoutlineConfig: async () => {
        throw new ConfigurationError("config.json is corrupt");
      },
    });
    assert.strictEqual(status, 0);
    assert.strictEqual(stderr.length, 0);
  });

  it("a credentialed command surfaces the corrupt-config error (not silenced)", async () => {
    const { adapter, stdout, stderr } = createTestAdapter();
    const status = await main(["doctor", "--no-tools"], {
      invocation: adapter,
      env: {},
      loadScoutlineConfig: async () => {
        throw new ConfigurationError("config.json is corrupt", "fix it");
      },
    });
    assert.strictEqual(status, 3);
    const err = JSON.parse(stderr[stderr.length - 1]);
    assert.strictEqual(err.code, "CONFIGURATION_ERROR");
    assert.ok(err.error.includes("corrupt"));
  });
});

// ---------------------------------------------------------------------------
// Fallback wiring - config.fallbackEnabled
// ---------------------------------------------------------------------------

describe("fallback wiring: config.fallbackEnabled narrows the executor", () => {
  it("fallbackEnabled:false narrows the executor to the effective provider only", async () => {
    const zai = makeKeyCapturingDescriptor({ id: "zai" });
    const minimax = makeKeyCapturingDescriptor({ id: "minimax" });
    const { adapter } = createTestAdapter();
    const status = await main(["--provider", "minimax", "search", "q"], {
      invocation: adapter,
      env: { Z_AI_API_KEY: "env-zai", MINIMAX_API_KEY: "env-mmx", SCOUTLINE_ARTIFACTS_DIR: getHermeticArtifactsDir() },
      providerDescriptors: [zai.descriptor, minimax.descriptor],
      searchCache: inMemoryCache(),
      searchSleep: async () => {},
      searchRandom: () => 0.5,
      loadScoutlineConfig: async () => ({
        version: 1,
        fallbackEnabled: false,
        providers: {},
      }),
    });
    assert.strictEqual(status, 0);
    assert.strictEqual(
      zai.invokes.length,
      0,
      "zai must not be attempted under fallbackEnabled:false",
    );
    assert.ok(minimax.invokes.length > 0, "minimax (effective) must be attempted");
  });

  it("fallbackEnabled:true preserves cross-provider fallback behavior", async () => {
    const zai = makeKeyCapturingDescriptor({ id: "zai" });
    const minimax = makeKeyCapturingDescriptor({ id: "minimax", resultMode: "throw-with-key" });
    const { adapter } = createTestAdapter();
    const status = await main(["--provider", "minimax", "search", "q"], {
      invocation: adapter,
      env: { Z_AI_API_KEY: "env-zai", MINIMAX_API_KEY: "env-mmx", SCOUTLINE_ARTIFACTS_DIR: getHermeticArtifactsDir() },
      providerDescriptors: [zai.descriptor, minimax.descriptor],
      searchCache: inMemoryCache(),
      searchSleep: async () => {},
      searchRandom: () => 0.5,
      loadScoutlineConfig: async () => ({
        version: 1,
        fallbackEnabled: true,
        providers: {},
      }),
    });
    assert.strictEqual(status, 0, "zai fallback should succeed");
    assert.ok(minimax.invokes.length > 0, "minimax (effective) must be tried first");
    assert.ok(zai.invokes.length > 0, "zai must be tried as fallback when minimax fails");
  });

  it("default (no fallbackEnabled in config) is true", async () => {
    const zai = makeKeyCapturingDescriptor({ id: "zai" });
    const minimax = makeKeyCapturingDescriptor({ id: "minimax", resultMode: "throw-with-key" });
    const { adapter } = createTestAdapter();
    const status = await main(["--provider", "minimax", "search", "q"], {
      invocation: adapter,
      env: { Z_AI_API_KEY: "env-zai", MINIMAX_API_KEY: "env-mmx", SCOUTLINE_ARTIFACTS_DIR: getHermeticArtifactsDir() },
      providerDescriptors: [zai.descriptor, minimax.descriptor],
      searchCache: inMemoryCache(),
      searchSleep: async () => {},
      searchRandom: () => 0.5,
      loadScoutlineConfig: async () => ({ version: 1, providers: {} }),
    });
    assert.strictEqual(status, 0);
    assert.ok(zai.invokes.length > 0, "fallback to zai under default (true)");
  });

  it("--no-fallback overrides config.fallbackEnabled:true", async () => {
    const zai = makeKeyCapturingDescriptor({ id: "zai" });
    const minimax = makeKeyCapturingDescriptor({ id: "minimax", resultMode: "throw-with-key" });
    const { adapter } = createTestAdapter();
    const status = await main(["--no-fallback", "--provider", "minimax", "search", "q"], {
      invocation: adapter,
      env: { Z_AI_API_KEY: "env-zai", MINIMAX_API_KEY: "env-mmx", SCOUTLINE_ARTIFACTS_DIR: getHermeticArtifactsDir() },
      providerDescriptors: [zai.descriptor, minimax.descriptor],
      searchCache: inMemoryCache(),
      searchSleep: async () => {},
      searchRandom: () => 0.5,
      loadScoutlineConfig: async () => ({
        version: 1,
        fallbackEnabled: true,
        providers: {},
      }),
    });
    assert.strictEqual(status, 1);
    assert.strictEqual(
      zai.invokes.length,
      0,
      "--no-fallback must override config.fallbackEnabled:true",
    );
  });

  it("SCOUTLINE_NO_FALLBACK env overrides config.fallbackEnabled:true", async () => {
    const zai = makeKeyCapturingDescriptor({ id: "zai" });
    const minimax = makeKeyCapturingDescriptor({ id: "minimax", resultMode: "throw-with-key" });
    const { adapter } = createTestAdapter();
    const status = await main(["--provider", "minimax", "search", "q"], {
      invocation: adapter,
      env: {
        Z_AI_API_KEY: "env-zai",
        MINIMAX_API_KEY: "env-mmx",
        SCOUTLINE_NO_FALLBACK: "1",
      },
      providerDescriptors: [zai.descriptor, minimax.descriptor],
      searchCache: inMemoryCache(),
      searchSleep: async () => {},
      searchRandom: () => 0.5,
      loadScoutlineConfig: async () => ({
        version: 1,
        fallbackEnabled: true,
        providers: {},
      }),
    });
    assert.strictEqual(status, 1);
    assert.strictEqual(
      zai.invokes.length,
      0,
      "env opt-out must override config.fallbackEnabled:true",
    );
  });
});

// ---------------------------------------------------------------------------
// Env-only regression - byte-for-byte unchanged when no config file exists
// ---------------------------------------------------------------------------

describe("env-only regression: no config file means env path is unchanged", () => {
  it("empty config returns env that is a shallow copy with identical values", () => {
    const env = { Z_AI_API_KEY: "env-key", SCOUTLINE_PROVIDER: "minimax", OTHER: "x" };
    const config = { version: 1, providers: {} };
    const resolved = resolveEnvFromConfig(env, config, [
      credDescriptor("zai", ["Z_AI_API_KEY", "ZAI_API_KEY"], () => false),
    ]);
    assert.deepStrictEqual(resolved, env);
  });

  it("configuredSecrets(resolvedEnv) === configuredSecrets(env) when no file keys", () => {
    const env = { Z_AI_API_KEY: "env-key", MINIMAX_API_KEY: "mmx-key" };
    const config = { version: 1, providers: {} };
    const resolved = resolveEnvFromConfig(env, config, [
      credDescriptor("zai", ["Z_AI_API_KEY", "ZAI_API_KEY"], (e) => !!e.Z_AI_API_KEY),
      credDescriptor("minimax", ["MINIMAX_API_KEY"], (e) => !!e.MINIMAX_API_KEY),
    ]);
    assert.deepStrictEqual(configuredSecrets(resolved), configuredSecrets(env));
  });

  it("main() with empty config behaves identically to no-config for help/version", async () => {
    const r1 = createTestAdapter();
    const r2 = createTestAdapter();
    await main(["--version"], {
      invocation: r1.adapter,
      env: {},
      loadScoutlineConfig: async () => ({ version: 1, providers: {} }),
    });
    await main(["--version"], {
      invocation: r2.adapter,
      env: {},
      loadScoutlineConfig: async () => {
        throw new ConfigurationError("no file");
      },
    });
    assert.strictEqual(r1.stdout[0], r2.stdout[0]);
  });
});

// ---------------------------------------------------------------------------
// Shared-command acceptance probe - file-only key reaches search + redacted
// ---------------------------------------------------------------------------

describe("acceptance probe: file-only key reaches a shared command and is redacted", () => {
  it("a file-only Z.AI key reaches search through the descriptor boundary", async () => {
    const zai = makeKeyCapturingDescriptor({ id: "zai", resultMode: "embed-key" });
    const { adapter, stdout } = createTestAdapter();
    const FILE_KEY = "file-only-secret-key";
    const status = await main(["search", "probe-query"], {
      invocation: adapter,
      env: { SCOUTLINE_ARTIFACTS_DIR: getHermeticArtifactsDir() },
      providerDescriptors: [zai.descriptor],
      searchCache: inMemoryCache(),
      searchSleep: async () => {},
      searchRandom: () => 0.5,
      loadScoutlineConfig: async () => ({
        version: 1,
        providers: { zai: { apiKey: FILE_KEY } },
      }),
    });
    assert.strictEqual(status, 0);
    const captured = zai.getCapturedEnv();
    assert.ok(captured, "descriptor.create must have been called");
    assert.strictEqual(captured.Z_AI_API_KEY, FILE_KEY);
    const out = stdout[0];
    assert.ok(!out.includes(FILE_KEY), "file key must be redacted from stdout");
    assert.ok(out.includes("[REDACTED]"), "redaction marker must appear");
  });

  it("a file-only key is redacted from the error path when the adapter fails", async () => {
    const zai = makeKeyCapturingDescriptor({ id: "zai", resultMode: "throw-with-key" });
    const { adapter, stderr } = createTestAdapter();
    const FILE_KEY = "file-only-err-key";
    const status = await main(["--no-fallback", "search", "probe"], {
      invocation: adapter,
      env: {},
      providerDescriptors: [zai.descriptor],
      searchCache: inMemoryCache(),
      searchSleep: async () => {},
      searchRandom: () => 0.5,
      loadScoutlineConfig: async () => ({
        version: 1,
        providers: { zai: { apiKey: FILE_KEY } },
      }),
    });
    assert.strictEqual(status, 1);
    const errLine = stderr[stderr.length - 1];
    assert.ok(!errLine.includes(FILE_KEY), "file key must be redacted from stderr");
    const parsed = JSON.parse(errLine);
    assert.ok(parsed.error.includes("[REDACTED]"), "error message must carry redaction marker");
  });

  it("a file-only Tavily key reaches search through its descriptor boundary", async () => {
    const tavily = makeKeyCapturingDescriptor({
      id: "tavily",
      credentialEnvVars: ["TAVILY_API_KEY"],
      resultMode: "embed-key",
    });
    const { adapter, stdout } = createTestAdapter();
    const FILE_KEY = "tvly-file-only";
    const status = await main(["--provider", "tavily", "search", "q"], {
      invocation: adapter,
      env: { SCOUTLINE_ARTIFACTS_DIR: getHermeticArtifactsDir() },
      providerDescriptors: [tavily.descriptor],
      searchCache: inMemoryCache(),
      searchSleep: async () => {},
      searchRandom: () => 0.5,
      loadScoutlineConfig: async () => ({
        version: 1,
        providers: { tavily: { apiKey: FILE_KEY } },
      }),
    });
    assert.strictEqual(status, 0);
    const captured = tavily.getCapturedEnv();
    assert.strictEqual(captured.TAVILY_API_KEY, FILE_KEY);
    assert.ok(!stdout[0].includes(FILE_KEY));
  });

  it("configuredSecrets(resolvedEnv) includes a file-only key", () => {
    const env = {};
    const config = {
      version: 1,
      providers: { zai: { apiKey: "file-only-redact-probe" } },
    };
    const resolved = resolveEnvFromConfig(env, config, [
      credDescriptor("zai", ["Z_AI_API_KEY", "ZAI_API_KEY"], () => false),
    ]);
    const secrets = configuredSecrets(resolved);
    assert.ok(secrets.includes("file-only-redact-probe"));
  });
});

// ---------------------------------------------------------------------------
// Hermeticity - main() injects in-memory config, no real config-root I/O
// ---------------------------------------------------------------------------

describe("hermeticity: main() tests inject in-memory config stores", () => {
  it("loadScoutlineConfig is called exactly once for a credentialed command", async () => {
    let calls = 0;
    const zai = makeKeyCapturingDescriptor({ id: "zai" });
    const { adapter } = createTestAdapter();
    await main(["search", "q"], {
      invocation: adapter,
      env: { Z_AI_API_KEY: "k", SCOUTLINE_ARTIFACTS_DIR: getHermeticArtifactsDir() },
      providerDescriptors: [zai.descriptor],
      searchCache: inMemoryCache(),
      searchSleep: async () => {},
      searchRandom: () => 0.5,
      loadScoutlineConfig: async () => {
        calls += 1;
        return { version: 1, providers: {} };
      },
    });
    assert.strictEqual(calls, 1, "config reader called exactly once");
  });

  it("loadScoutlineConfig is NOT called for help/version/cache", async () => {
    let calls = 0;
    const { adapter } = createTestAdapter();
    for (const args of [["--help"], ["--version"], ["cache", "stats"]]) {
      await main(args, {
        invocation: adapter,
        env: {},
        loadScoutlineConfig: async () => {
          calls += 1;
          return { version: 1, providers: {} };
        },
      });
    }
    assert.strictEqual(calls, 0, "config reader must not be called for credential-free commands");
  });

  it("conflicting ambient keys do not leak when MainDependencies.env is clean", async () => {
    const zai = makeKeyCapturingDescriptor({ id: "zai" });
    const { adapter } = createTestAdapter();
    await main(["search", "q"], {
      invocation: adapter,
      env: { SCOUTLINE_ARTIFACTS_DIR: getHermeticArtifactsDir() },
      providerDescriptors: [zai.descriptor],
      searchCache: inMemoryCache(),
      searchSleep: async () => {},
      searchRandom: () => 0.5,
      loadScoutlineConfig: async () => ({
        version: 1,
        providers: { zai: { apiKey: "injected-file-key" } },
      }),
    });
    const captured = zai.getCapturedEnv();
    assert.strictEqual(captured.Z_AI_API_KEY, "injected-file-key");
  });
});

// ---------------------------------------------------------------------------
// F5: the judge section's config views under the secret union.
//
// The stored judge credentials join the SAME redaction basis as every
// other credential, so the config views never print them — and a stored
// value that is ALSO a plain model string masks wherever it appears.
// ---------------------------------------------------------------------------

describe("F5: judge config views redact the stored judge credentials", () => {
  /** The private roots this block creates; removed when the block ends. */
  const ownedRoots = new Set();
  after(() => {
    for (const root of ownedRoots) rmSync(root, { recursive: true, force: true });
    ownedRoots.clear();
  });

  /** One `config get` run over a private config root. */
  async function configGet(path, { config, env = {} } = {}) {
    const root = mkdtempSync(join(tmpdir(), "scoutline-judge-view-"));
    ownedRoots.add(root);
    const configDir = join(root, "config");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config.json"), JSON.stringify(config, null, 2));
    const { adapter, stdout, stderr } = createTestAdapter();
    const code = await main(
      path === undefined ? ["config", "get"] : ["config", "get", path],
      {
        invocation: adapter,
        env: { SCOUTLINE_CONFIG_DIR: configDir, ...env },
        loadScoutlineConfig: async () => config,
      },
    );
    return { code, stdout: stdout.join(""), stderr: stderr.join(""), root };
  }

  it("masks both stored route keys in the full config view", async () => {
    const storedSelected = "or-stored-key-0001";
    const storedInactive = "ts-stored-key-0002";
    const run = await configGet(undefined, {
      config: {
        version: 1, providers: {},
        judge: {
          route: "openrouter",
          openrouter: { model: "typesafe/jev-1.14", transmitConsent: true, apiKey: storedSelected },
          typesafe: { model: "jev-1.13.0", transmitConsent: false, apiKey: storedInactive },
        },
      },
    });
    assert.strictEqual(run.code, 0, run.stderr);
    assert.ok(!run.stdout.includes(storedSelected), "the selected stored key must never print");
    assert.ok(!run.stdout.includes(storedInactive), "the inactive stored key must never print");
    assert.ok(run.stdout.includes("[REDACTED]"), "the redaction marker must appear");
    // The public structure around it survives.
    const view = JSON.parse(run.stdout);
    assert.strictEqual(view.judge.route, "openrouter");
    assert.strictEqual(view.judge.openrouter.model, "typesafe/jev-1.14");
    assert.strictEqual(view.judge.openrouter.transmitConsent, true);
    assert.strictEqual(view.judge.typesafe.model, "jev-1.13.0");
    assert.strictEqual(view.judge.typesafe.transmitConsent, false);
  });

  it("keeps the stored route key out of the profile and scalar views too", async () => {
    const storedSelected = "or-stored-key-0003";
    const config = {
      version: 1, providers: {},
      judge: {
        route: "openrouter",
        openrouter: { model: "typesafe/jev-1.14", transmitConsent: true, apiKey: storedSelected },
      },
    };
    // The profile views carry the model and the consent, never the key.
    for (const path of ["judge", "judge.openrouter"]) {
      const run = await configGet(path, { config });
      assert.strictEqual(run.code, 0, run.stderr);
      assert.ok(!run.stdout.includes(storedSelected), `the ${path} view must not print the stored key`);
    }
    const profile = JSON.parse((await configGet("judge.openrouter", { config })).stdout);
    assert.strictEqual(profile.model, "typesafe/jev-1.14");
    assert.strictEqual(profile.transmitConsent, true);
    // The scalar route view is not a credential at all.
    const route = await configGet("judge.route", { config });
    assert.strictEqual(route.code, 0, route.stderr);
    assert.strictEqual(JSON.parse(route.stdout), "openrouter");
  });

  it("masks a stored model string that is ALSO an inactive route's credential", async () => {
    // The stored OpenRouter model string is the exact value of a synthetic
    // INACTIVE TYPESAFE_API_KEY. The model is not an apiKey field, but the
    // LITERAL is a credential, so the scalar view must still mask it.
    const literal = "typesafe/jev-1.14";
    const run = await configGet("judge.openrouter.model", {
      config: {
        version: 1, providers: {},
        judge: { route: "openrouter", openrouter: { model: literal, transmitConsent: true } },
      },
      env: { TYPESAFE_API_KEY: literal },
    });
    assert.strictEqual(run.code, 0, run.stderr);
    assert.strictEqual(JSON.parse(run.stdout), "[REDACTED]", "the model scalar must mask the credential literal");
  });

  it("masks a plain model scalar that equals an ENV-ONLY inactive route credential", async () => {
    // The ENV-ONLY case: there is NO stored copy at all. The shipped
    // OpenRouter model default is "typesafe/jev-1.14", and a synthetic
    // INACTIVE TYPESAFE_API_KEY carries exactly that literal. The model is
    // not an apiKey field, but the LITERAL is a credential, so the plain
    // scalar must still mask.
    const literal = "typesafe/jev-1.14";
    const run = await configGet("judge.openrouter.model", {
      config: { version: 1, providers: {} },
      env: { TYPESAFE_API_KEY: literal },
    });
    assert.strictEqual(run.code, 0, run.stderr);
    assert.strictEqual(JSON.parse(run.stdout), "[REDACTED]", "the model scalar must mask the env-only credential literal");
    // The profile view around it keeps its public structure.
    const profile = await configGet("judge.openrouter", {
      config: { version: 1, providers: {} },
      env: { TYPESAFE_API_KEY: literal },
    });
    assert.strictEqual(profile.code, 0, profile.stderr);
    const view = JSON.parse(profile.stdout);
    assert.strictEqual(view.model, "[REDACTED]");
    assert.strictEqual(view.transmitConsent, false);
  });

  it("keeps env-only preferences inspectable without constructing a judge or any HTTP", async () => {
    // A valid consented env-only selection stores no credential, so the
    // preferences stay inspectable — and nothing native is constructed.
    const httpCalls = [];
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (url) => { httpCalls.push(String(url)); throw new Error("no HTTP permitted"); };
    try {
      const run = await configGet("judge", {
        config: { version: 1, providers: {} },
        env: { OPENROUTER_API_KEY: "or-env-only-key-0004", SCOUTLINE_JUDGE_TRANSMIT: "1" },
      });
      assert.strictEqual(run.code, 0, run.stderr);
      const view = JSON.parse(run.stdout);
      assert.strictEqual(view.route, "openrouter");
      assert.strictEqual(view.openrouter.model, "typesafe/jev-1.14");
      assert.strictEqual(httpCalls.length, 0, "the config view performed no HTTP");
      assert.ok(!run.stdout.includes("or-env-only-key-0004"), "the env credential never prints");
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// F5: a normal save-capable command path.
//
// A served plain marker that is a credential must not reach the stdout, the
// stderr or the saved artifact bytes. The saved artifact path is compared
// EXACTLY — this suite creates its own root and reads only its own files.
// ---------------------------------------------------------------------------

describe("F5: a save-capable command path keeps a served credential out of every byte", () => {
  it("redacts a served credential from stdout, stderr and the saved artifact", async () => {
    const marker = "tavily-served-marker-0005";
    const publicFact = "ExampleApp release 2.4.0 supports CSV.";
    const tavily = makeKeyCapturingDescriptor({ id: "tavily", credentialEnvVars: ["TAVILY_API_KEY"], resultMode: "embed-key" });
    const { adapter, stdout, stderr } = createTestAdapter();
    const artifactsDir = mkdtempSync(join(tmpdir(), "scoutline-judge-save-"));
    const cacheDir = mkdtempSync(join(tmpdir(), "scoutline-judge-save-cache-"));
    try {
      const exportPath = join(artifactsDir, "export.json");
      const code = await main(["--provider", "tavily", "search", "probe", "--save", exportPath], {
        invocation: adapter,
        env: {
          TAVILY_API_KEY: marker,
          SCOUTLINE_ARTIFACTS_DIR: artifactsDir,
          SCOUTLINE_CACHE_DIR: cacheDir,
        },
        providerDescriptors: [tavily.descriptor],
        searchCache: inMemoryCache(),
        searchSleep: async () => {},
        searchRandom: () => 0.5,
        loadScoutlineConfig: async () => ({ version: 1, providers: {} }),
      });
      assert.strictEqual(code, 0, stderr.join(""));
      const out = stdout.join("");
      // The POSITIVE visible fact: the redaction marker, not mere omission.
      assert.ok(out.includes("[REDACTED]"), "the redaction marker must appear in stdout");
      assert.ok(out.includes(publicFact) || out.includes("result with key="), "the public result structure survives");
      assert.ok(!out.includes(marker), "the served credential must not reach stdout");
      assert.ok(!stderr.join("").includes(marker), "the served credential must not reach stderr");
      // Only the EXACT artifact paths this run created are compared.
      const saved = readFileSync(exportPath, "utf8");
      assert.ok(!saved.includes(marker), "the served credential must not reach the saved export bytes");
      assert.ok(saved.includes("[REDACTED]"), "the saved export carries the redaction marker");
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});
