/**
 * Env-door validation scope (#244).
 *
 * Env-door validation was inconsistent: SCOUTLINE_FUSION=bogus failed
 * `quota` (the credentialed path resolves the door unconditionally)
 * but silently succeeded on every early-return command (`config get`
 * returned null, exit 0). The owner-accepted direction: validate the
 * env doors ONCE pre-dispatch for ALL commands, so a bad value fails
 * identically everywhere:
 *
 *   - SCOUTLINE_FUSION — strict enum via resolveFusionMode (bogus →
 *     ValidationError; empty string = unset);
 *   - SCOUTLINE_PROVIDER — a single shared Provider id via
 *     parseProviderId, EXCEPT on `science` (its env-door grammar is the
 *     science supplier ids + "all", validated inside handleScience);
 *   - SCOUTLINE_NO_FALLBACK — boolean kill-switch: any non-empty value
 *     is valid, nothing to validate.
 *
 * The `--provider` FLAG keeps its per-command validation (extracted
 * globally; unknown values still surface at the handlers that consume
 * it) — this pass is about the ENV doors only.
 *
 * Tests import from ../dist (the established convention); build first.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fsMod from "node:fs/promises";
import * as osMod from "node:os";
import * as pathMod from "node:path";

import { main, validateEnvDoors } from "../dist/index.js";
import { useTempConfigDir } from "./helpers/config-dir-pin.js";
import { hermeticMainDeps } from "./helpers/hermetic-main.js";

useTempConfigDir();

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

async function withTempConfig(t, run) {
  const dir = await fsMod.mkdtemp(pathMod.join(osMod.tmpdir(), "scoutline-envdoor-"));
  t.after(async () => {
    await fsMod.rm(dir, { recursive: true, force: true });
  });
  await run(dir);
}

// ---------------------------------------------------------------------------
// Pure pass: validateEnvDoors(env, command)
// ---------------------------------------------------------------------------

describe("validateEnvDoors (pure)", () => {
  it("bogus SCOUTLINE_FUSION throws for an early-return command", () => {
    assert.throws(
      () => validateEnvDoors({ SCOUTLINE_FUSION: "bogus" }, "config"),
      (error) => {
        assert.strictEqual(error.name, "ValidationError");
        assert.match(String(error.message), /SCOUTLINE_FUSION/);
        return true;
      },
    );
  });

  it("valid SCOUTLINE_FUSION values and empty/unset pass", () => {
    validateEnvDoors({ SCOUTLINE_FUSION: "rrf" }, "config");
    validateEnvDoors({ SCOUTLINE_FUSION: "occurrence" }, "cache");
    validateEnvDoors({ SCOUTLINE_FUSION: "" }, "usage");
    validateEnvDoors({}, "history");
  });

  it("bogus SCOUTLINE_PROVIDER throws for a shared-grammar command", () => {
    assert.throws(
      () => validateEnvDoors({ SCOUTLINE_PROVIDER: "bogus" }, "config"),
      (error) => {
        assert.strictEqual(error.name, "ValidationError");
        assert.match(String(error.message), /Unknown provider "bogus"/);
        return true;
      },
    );
  });

  it("empty SCOUTLINE_PROVIDER is present-and-invalid (matches shared paths today)", () => {
    assert.throws(() => validateEnvDoors({ SCOUTLINE_PROVIDER: "" }, "cache"), /not be empty/);
  });

  it("science is exempt from the shared provider door (supplier grammar)", () => {
    validateEnvDoors({ SCOUTLINE_PROVIDER: "openalex" }, "science");
    validateEnvDoors({ SCOUTLINE_PROVIDER: "all" }, "science");
  });

  it("valid shared SCOUTLINE_PROVIDER passes", () => {
    validateEnvDoors({ SCOUTLINE_PROVIDER: "tavily" }, "config");
  });

  it("an explicit --provider flag wins: the dead env value is not validated (PR #253 r1)", () => {
    // Precedence chain flag > env > config: a pinned run never reads
    // SCOUTLINE_PROVIDER, so a bogus (dead) env value must not fail it.
    validateEnvDoors({ SCOUTLINE_PROVIDER: "bogus" }, "config", "tavily");
    validateEnvDoors({ SCOUTLINE_PROVIDER: "bogus" }, "search", "tavily,exa");
    validateEnvDoors({ SCOUTLINE_PROVIDER: "bogus" }, "search", "all");
  });

  it("SCOUTLINE_NO_FALLBACK accepts any value (boolean kill-switch)", () => {
    validateEnvDoors({ SCOUTLINE_NO_FALLBACK: "bogus" }, "config");
    validateEnvDoors({ SCOUTLINE_NO_FALLBACK: "" }, "quota");
  });
});

// ---------------------------------------------------------------------------
// main() wiring — the two #244 probes plus scope pins
// ---------------------------------------------------------------------------

describe("env-door validation through main() (#244)", () => {
  it("probe 1 (kept): SCOUTLINE_FUSION=bogus quota fails with the envelope", async (t) => {
    await withTempConfig(t, async (dir) => {
      const { invocation, stderr } = makeInvocation();
      const deps = hermeticMainDeps({
        invocation,
        env: { SCOUTLINE_CONFIG_DIR: dir, SCOUTLINE_FUSION: "bogus" },
      });
      const status = await main(["quota"], deps);
      assert.strictEqual(status, 1);
      assert.match(stderr(), /VALIDATION_ERROR/);
      assert.match(stderr(), /SCOUTLINE_FUSION/);
    });
  });

  it("probe 2 (fixed): SCOUTLINE_FUSION=bogus config get now fails identically", async (t) => {
    await withTempConfig(t, async (dir) => {
      const { invocation, stderr } = makeInvocation();
      const deps = hermeticMainDeps({
        invocation,
        env: { SCOUTLINE_CONFIG_DIR: dir, SCOUTLINE_FUSION: "bogus" },
      });
      const status = await main(["config", "get", "fanout"], deps);
      assert.strictEqual(status, 1, "config get no longer silently ignores a bad env door");
      assert.match(stderr(), /VALIDATION_ERROR/);
      assert.match(stderr(), /SCOUTLINE_FUSION/);
    });
  });

  it("early-return commands fail on a bogus SCOUTLINE_PROVIDER too", async (t) => {
    await withTempConfig(t, async (dir) => {
      const { invocation, stderr } = makeInvocation();
      const deps = hermeticMainDeps({
        invocation,
        env: { SCOUTLINE_CONFIG_DIR: dir, SCOUTLINE_PROVIDER: "bogus" },
      });
      const status = await main(["config", "get", "fusion"], deps);
      assert.strictEqual(status, 1);
      assert.match(stderr(), /Unknown provider/);
      assert.match(stderr(), /bogus/);
    });
  });

  it("an explicit --provider flag lets a bogus SCOUTLINE_PROVIDER env through (PR #253 r1)", async (t) => {
    await withTempConfig(t, async (dir) => {
      const { invocation, stderr } = makeInvocation();
      const deps = hermeticMainDeps({
        invocation,
        env: { SCOUTLINE_CONFIG_DIR: dir, SCOUTLINE_PROVIDER: "bogus" },
      });
      const status = await main(["--provider", "tavily", "config", "get", "fanout"], deps);
      assert.strictEqual(status, 0, "flag-pinned run must not fail on the dead env value");
      assert.strictEqual(stderr(), "");
    });
  });

  it("valid doors never break early-return commands", async (t) => {
    await withTempConfig(t, async (dir) => {
      const { invocation } = makeInvocation();
      const deps = hermeticMainDeps({
        invocation,
        env: {
          SCOUTLINE_CONFIG_DIR: dir,
          SCOUTLINE_FUSION: "occurrence",
          SCOUTLINE_PROVIDER: "tavily",
          SCOUTLINE_NO_FALLBACK: "1",
        },
      });
      const status = await main(["config", "get", "fusion"], deps);
      assert.strictEqual(status, 0);
    });
  });

  it("science's env door keeps its own grammar (zero-network shape, PR #253 r1)", async (t) => {
    await withTempConfig(t, async (dir) => {
      const { invocation, stderr } = makeInvocation();
      const deps = hermeticMainDeps({
        invocation,
        env: { SCOUTLINE_CONFIG_DIR: dir, SCOUTLINE_PROVIDER: "openalex" },
      });
      // A parse-time-invalid --year fails BEFORE any supplier invoke
      // (buildScienceControls validates the grammar pre-arms), so this
      // reaches exactly one network-free failure. If the pre-dispatch
      // door had rejected openalex, the envelope would be the shared
      // Unknown-provider one instead of the --year error.
      const status = await main(["science", "search", "q", "--year", "bogus"], deps);
      assert.strictEqual(status, 1);
      assert.match(stderr(), /--year/);
      assert.doesNotMatch(stderr(), /Unknown provider/);
    });
  });

  it("SCOUTLINE_NO_FALLBACK=bogus is not a door failure (any value disables)", async (t) => {
    await withTempConfig(t, async (dir) => {
      const { invocation } = makeInvocation();
      const deps = hermeticMainDeps({
        invocation,
        env: { SCOUTLINE_CONFIG_DIR: dir, SCOUTLINE_NO_FALLBACK: "bogus" },
      });
      const status = await main(["config", "get", "fanout"], deps);
      assert.strictEqual(status, 0);
    });
  });
});
