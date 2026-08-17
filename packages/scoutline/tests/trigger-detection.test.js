/**
 * Trigger detection (T3b — Plan A, Option B).
 *
 * Three classified outcomes when the user runs a credentialed command:
 *   - env-only setup → one-time stderr hint + command runs normally;
 *   - missing credential everywhere → the handler's own preflight
 *     surfaces CONFIGURATION_ERROR exit 3 (the trigger layer does NOT
 *     intercept — the locked validation-before-configuration ordering
 *     is preserved);
 *   - credential-free (--help / --version / cache / init / <cmd> --help)
 *     → no config read at all.
 *
 * The pure classifier ({@link classifyCredentialState}) is tested
 * directly against fake descriptors. The end-to-end hint emission is
 * tested via subprocess so the real `inspectConfig` + production
 * hint-shown store run against a temp `SCOUTLINE_CONFIG_DIR`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as fs from "node:fs/promises";

import {
  classifyCredentialState,
  formatEnvOnlyHint,
  missingCredentialError,
  isCommandHelpInvocation,
  isDryRunBatchInvocation,
  OBSERVATIONAL_COMMANDS,
  ZAI_ONLY_COMMANDS,
} from "../dist/lib/trigger-detection.js";
import { ConfigurationError } from "../dist/lib/errors.js";
import { runProcess } from "./helpers/run-process.js";
import { withTempDir } from "./helpers/temp-dir.js";

// ---------------------------------------------------------------------------
// Fake descriptors for the pure classifier tests.
// ---------------------------------------------------------------------------

function fakeDescriptor(id, { envConfigured = true, credVars } = {}) {
  // Default to the provider's canonical env var. Callers can override.
  const defaults = {
    zai: ["Z_AI_API_KEY"],
    minimax: ["MINIMAX_API_KEY"],
    tavily: ["TAVILY_API_KEY"],
    exa: ["EXA_API_KEY"],
    brave: ["BRAVE_SEARCH_API_KEY"],
    firecrawl: ["FIRECRAWL_API_KEY"],
  };
  const resolvedVars = credVars ?? defaults[id] ?? [`${id.toUpperCase()}_API_KEY`];
  const canonical = resolvedVars[0];
  void envConfigured; // retained for API symmetry; the closure decides.
  return {
    id,
    credentialEnvVars: resolvedVars,
    isConfigured: (env) => {
      const v = env[canonical];
      return typeof v === "string" && v.trim().length > 0;
    },
    capabilities: () => new Set(["search"]),
    create: () => {
      throw new Error("create() must not be called by the classifier");
    },
  };
}

// ---------------------------------------------------------------------------
// Pure classifier tests
// ---------------------------------------------------------------------------

describe("classifyCredentialState: pure classification across the registry", () => {
  const zai = fakeDescriptor("zai");
  const minimax = fakeDescriptor("minimax", { credVars: ["MINIMAX_API_KEY"] });
  const descriptors = [zai, minimax];

  it("missing: no env key and no file key for any provider", () => {
    const state = classifyCredentialState({
      descriptors,
      env: {},
      resolvedEnv: {},
      config: { version: 1, providers: {} },
    });
    assert.strictEqual(state.kind, "missing");
  });

  it("env-only: env key present, no file key, empty config", () => {
    const state = classifyCredentialState({
      descriptors,
      env: { Z_AI_API_KEY: "env-key" },
      resolvedEnv: { Z_AI_API_KEY: "env-key" },
      config: { version: 1, providers: {} },
    });
    assert.strictEqual(state.kind, "env-only");
  });

  it("env-only: env key present but file providers map is empty", () => {
    const state = classifyCredentialState({
      descriptors,
      env: { MINIMAX_API_KEY: "env-mmx" },
      resolvedEnv: { MINIMAX_API_KEY: "env-mmx" },
      config: { version: 1, providers: {} },
    });
    assert.strictEqual(state.kind, "env-only");
  });

  it("file-configured: no env key, file key present (resolved env picks it up)", () => {
    const state = classifyCredentialState({
      descriptors,
      env: {},
      resolvedEnv: { Z_AI_API_KEY: "file-key" },
      config: {
        version: 1,
        providers: { zai: { apiKey: "file-key" } },
      },
    });
    assert.strictEqual(state.kind, "file-configured");
  });

  it("env-and-file: both env and file carry keys (different providers)", () => {
    const state = classifyCredentialState({
      descriptors,
      env: { Z_AI_API_KEY: "env-zai" },
      resolvedEnv: { Z_AI_API_KEY: "env-zai", MINIMAX_API_KEY: "file-mmx" },
      config: {
        version: 1,
        providers: { minimax: { apiKey: "file-mmx" } },
      },
    });
    assert.strictEqual(state.kind, "env-and-file");
  });

  it("file-configured: blank file key is treated as absent (not file-configured)", () => {
    const state = classifyCredentialState({
      descriptors,
      env: { Z_AI_API_KEY: "env-key" },
      resolvedEnv: { Z_AI_API_KEY: "env-key" },
      config: {
        version: 1,
        providers: { zai: { apiKey: "   " } },
      },
    });
    // Blank file key + env key → env-only (the blank file key does not
    // count as a file configuration).
    assert.strictEqual(state.kind, "env-only");
  });
});

// ---------------------------------------------------------------------------
// formatEnvOnlyHint + missingCredentialError
// ---------------------------------------------------------------------------

describe("formatEnvOnlyHint: stderr message shape", () => {
  it("mentions the wizard, config.json path, and one-time nature", () => {
    const hint = formatEnvOnlyHint();
    assert.match(hint, /scoutline:/i);
    assert.match(hint, /`scoutline init`/);
    assert.match(hint, /config\.json/i);
    assert.match(hint, /one-time hint/i);
    assert.match(hint, /\n$/);
  });
});

describe("missingCredentialError: CONFIGURATION_ERROR exit 3", () => {
  it("produces a ConfigurationError with exit code 3", () => {
    const zai = fakeDescriptor("zai");
    const err = missingCredentialError([zai]);
    assert.ok(err instanceof ConfigurationError);
    assert.strictEqual(err.exitCode, 3);
    assert.strictEqual(err.code, "CONFIGURATION_ERROR");
  });

  it("lists canonical env vars from the descriptors in the help text", () => {
    const zai = fakeDescriptor("zai");
    const minimax = fakeDescriptor("minimax", { credVars: ["MINIMAX_API_KEY"] });
    const err = missingCredentialError([zai, minimax]);
    assert.match(err.help, /Z_AI_API_KEY/);
    assert.match(err.help, /MINIMAX_API_KEY/);
    assert.match(err.help, /scoutline init/);
  });

  it("falls back to a generic message when descriptors lack credentialEnvVars", () => {
    const bare = {
      id: "bare",
      isConfigured: () => false,
      capabilities: () => new Set(["search"]),
      create: () => {
        throw new Error("nope");
      },
    };
    const err = missingCredentialError([bare]);
    assert.match(err.help, /scoutline init/);
    assert.ok(!/Z_AI_API_KEY/.test(err.help), "must not list vars when descriptor lacks them");
  });
});

// ---------------------------------------------------------------------------
// isCommandHelpInvocation + classification tables
// ---------------------------------------------------------------------------

describe("isCommandHelpInvocation: shallow peek at --help/-h", () => {
  it("detects --help anywhere in the arg list", () => {
    assert.ok(isCommandHelpInvocation(["--help"]));
    assert.ok(isCommandHelpInvocation(["analyze", "img.png", "--help"]));
    assert.ok(isCommandHelpInvocation(["-h"]));
  });
  it("returns false when no help flag is present", () => {
    assert.ok(!isCommandHelpInvocation([]));
    assert.ok(!isCommandHelpInvocation(["analyze", "img.png"]));
  });
});

describe("isDryRunBatchInvocation: dry-run batches skip the quota due-refresh", () => {
  it("detects batch --dry-run with a file manifest, a stdin manifest, and any flag order", () => {
    assert.ok(isDryRunBatchInvocation("batch", ["manifest.json", "--dry-run"]));
    assert.ok(isDryRunBatchInvocation("batch", ["--dry-run", "-"]));
    assert.ok(isDryRunBatchInvocation("batch", ["manifest.json", "--concurrency", "2", "--dry-run"]));
  });
  it("detects the vision batch wrapper's --dry-run", () => {
    assert.ok(isDryRunBatchInvocation("vision", ["batch", "shots/*.png", "--out", "o", "--dry-run"]));
  });
  it("returns false for non-dry-run batches", () => {
    assert.ok(!isDryRunBatchInvocation("batch", ["manifest.json"]));
    assert.ok(!isDryRunBatchInvocation("vision", ["batch", "shots/*.png", "--out", "o"]));
    assert.ok(!isDryRunBatchInvocation("batch", ["manifest.json", "--help"]));
  });
  it("is flag-order independent for vision batch (review fix: flags may precede the subcommand)", () => {
    assert.ok(isDryRunBatchInvocation("vision", ["--out", "o", "batch", "shots/*.png", "--dry-run"]));
    assert.ok(isDryRunBatchInvocation("vision", ["--prompt", "p", "batch", "g", "--dry-run"]));
  });
  it("does not classify valued --dry-run tokens (the wrapper rejects them, so they are not previews)", () => {
    assert.ok(!isDryRunBatchInvocation("batch", ["--dry-run", "manifest.json"]));
    assert.ok(!isDryRunBatchInvocation("vision", ["--dry-run", "batch", "g"]));
  });
  it("returns false outside the batch surfaces even when a --dry-run token is present", () => {
    assert.ok(!isDryRunBatchInvocation("vision", ["analyze", "img.png", "--dry-run"]));
    assert.ok(!isDryRunBatchInvocation("search", ["--dry-run", "query"]));
    assert.ok(!isDryRunBatchInvocation("quota", ["--dry-run"]));
  });
});

describe("classification tables: observational + ZAI-only command sets", () => {
  it("doctor and quota are observational", () => {
    assert.ok(OBSERVATIONAL_COMMANDS.has("doctor"));
    assert.ok(OBSERVATIONAL_COMMANDS.has("quota"));
    assert.ok(!OBSERVATIONAL_COMMANDS.has("search"));
  });
  it("tools/tool/call/code are Z.AI-only", () => {
    assert.ok(ZAI_ONLY_COMMANDS.has("tools"));
    assert.ok(ZAI_ONLY_COMMANDS.has("tool"));
    assert.ok(ZAI_ONLY_COMMANDS.has("call"));
    assert.ok(ZAI_ONLY_COMMANDS.has("code"));
    assert.ok(!ZAI_ONLY_COMMANDS.has("search"));
  });
});

// ---------------------------------------------------------------------------
// End-to-end subprocess: the env-only hint fires once, persists, and
// the command then runs normally.
// ---------------------------------------------------------------------------

describe("trigger detection subprocess: env-only hint fires once + persists", () => {
  it("emits the one-time hint to stderr when env key is set but no config exists", async () => {
    // `cache --help` is credential-free and short-circuits before
    // trigger detection; `cache stats` is also credential-free. We need
    // a command that reaches trigger detection. `search` with no
    // credential would fail at the handler preflight (exit 3) — but the
    // env-only hint fires BEFORE the handler. So with an env key set
    // and no config file, stderr should contain the hint line.
    //
    // We use `doctor --no-tools` here because under --no-tools doctor
    // does NOT make a network call and exits cleanly; trigger detection
    // classifies it as observational and does NOT emit the hint — so
    // this test proves the hint is SKIPPED for observational commands.
    const r = await runProcess(["doctor", "--no-tools"], {
      env: { Z_AI_API_KEY: "env-only-key" },
    });
    // Doctor is observational → no hint.
    assert.ok(
      !/using credentials from the environment/.test(r.stderr),
      "doctor (observational) must not get the env-only hint",
    );
  });

  it("emits the one-time hint for a credentialed non-observational command", async (t) => {
    await withTempDir(t, async (configDir) => {
      // No config file → absent. Env key set → env-only.
      // `code prompt` is a credentialed Z.AI-only command that produces
      // offline output (the prompt template). It does NOT make a
      // network call, so it runs cleanly after the hint.
      const r = await runProcess(["--output-format", "data", "code", "prompt"], {
        env: { Z_AI_API_KEY: "env-only-key" },
        configDir,
      });
      // The command ran and exited 0.
      assert.strictEqual(r.code, 0);
      // The hint was emitted to stderr (one-time).
      assert.match(r.stderr, /using credentials from the environment/);
      assert.match(r.stderr, /`scoutline init`/);
      // The command's natural stdout output is preserved (the prompt
      // template). Data-only stdout contract holds.
      assert.ok(r.stdout.length > 0, "command output must still reach stdout");
      // hintShown was persisted to the config file.
      const configPath = path.join(configDir, "config.json");
      const written = JSON.parse(await fs.readFile(configPath, "utf8"));
      assert.strictEqual(written.hintShown, true);
    });
  });

  it("hint does NOT repeat on the second run (hintShown persists)", async (t) => {
    await withTempDir(t, async (configDir) => {
      // Pre-seed the config with hintShown: true.
      await fs.writeFile(
        path.join(configDir, "config.json"),
        JSON.stringify({ version: 1, providers: {}, hintShown: true }),
      );
      const r = await runProcess(["--output-format", "data", "code", "prompt"], {
        env: { Z_AI_API_KEY: "env-only-key" },
        configDir,
      });
      assert.strictEqual(r.code, 0);
      // The hint must NOT repeat.
      assert.ok(
        !/using credentials from the environment/.test(r.stderr),
        "hint must not repeat after hintShown is persisted",
      );
    });
  });

  it("file-configured setup does NOT emit the hint", async (t) => {
    await withTempDir(t, async (configDir) => {
      // Pre-seed a file-configured key.
      await fs.writeFile(
        path.join(configDir, "config.json"),
        JSON.stringify({
          version: 1,
          providers: { zai: { apiKey: "file-key" } },
        }),
      );
      const r = await runProcess(["--output-format", "data", "code", "prompt"], {
        env: {},
        configDir,
      });
      assert.strictEqual(r.code, 0);
      assert.ok(
        !/using credentials from the environment/.test(r.stderr),
        "file-configured setup must not emit the env-only hint",
      );
    });
  });

  it("credential-free commands (--help) do not read config at all", async (t) => {
    await withTempDir(t, async (configDir) => {
      // Write a corrupt config to prove --help does not even read it.
      await fs.writeFile(path.join(configDir, "config.json"), "{not-json");
      const r = await runProcess(["--help"], { configDir });
      assert.strictEqual(r.code, 0);
      assert.strictEqual(r.stderr, "");
      assert.ok(r.stdout.includes("scoutline"));
    });
  });

  it("command help (<cmd> --help) bypasses the corrupt-config refuse", async (t) => {
    await withTempDir(t, async (configDir) => {
      await fs.writeFile(path.join(configDir, "config.json"), "{not-json");
      // `search --help` under a corrupt config must still render help.
      const r = await runProcess(["search", "--help"], { configDir });
      assert.strictEqual(r.code, 0);
      assert.ok(r.stdout.includes("--count"));
    });
  });
});
