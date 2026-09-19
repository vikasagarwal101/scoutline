/**
 * Fusion config key tests — seed-24 fusion T1.
 *
 * Scope of THIS ticket: the `fusion` config key (rrf | occurrence), the
 * SCOUTLINE_FUSION env door, strict enum validation, and the resolveFusionMode
 * precedence helper. Owner rulings: NO --fusion query flag (config key + env
 * only, AC-1 pin at the bottom); env > config > default "rrf"; typos FAIL
 * at `config set` and at env resolution — never silently drop.
 *
 * Tests import from ../dist (the established convention); build first.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fsMod from "node:fs/promises";
import * as osMod from "node:os";
import * as pathMod from "node:path";

import { main } from "../dist/index.js";
import { resolveFusionMode } from "../dist/lib/config-store.js";
import { useTempConfigDir } from "./helpers/config-dir-pin.js";
import { hermeticMainDeps, getHermeticArtifactsDir } from "./helpers/hermetic-main.js";

useTempConfigDir();

// ---------------------------------------------------------------------------
// config set/get round-trip (strict enum registry row)
// ---------------------------------------------------------------------------

describe("fusion config key: set/get round-trip", () => {
  for (const value of ["rrf", "occurrence"]) {
    it(`config set fusion ${value} persists and config get renders it`, async (t) => {
      await withTempConfig(t, async (dir) => {
        const setStatus = await runMain(["config", "set", "fusion", value], dir);
        assert.strictEqual(setStatus, 0);

        const { readConfig } = await import("../dist/lib/config-store.js");
        const stored = await readConfig({
          filePath: pathMod.join(dir, "config.json"),
          onWarning: () => {},
        });
        assert.strictEqual(stored.fusion, value);

        const io = makeInvocation();
        const getStatus = await main(
          ["config", "get", "fusion"],
          await baseDeps(io.invocation, dir),
        );
        assert.strictEqual(getStatus, 0);
        // data output mode: stdout carries the JSON value, text mode the
        // `fusion → <value>` presentation — the value must appear either way.
        assert.ok(io.stdout().includes(value) || io.stdout().includes(`fusion → ${value}`));
      });
    });
  }
});

describe("fusion config key: strict enum validation", () => {
  for (const bad of ["rrff", "RRF", ""]) {
    it(`config set fusion ${JSON.stringify(bad)} throws ValidationError`, async (t) => {
      await withTempConfig(t, async (dir) => {
        const { setConfigValue } = await import("../dist/lib/config-store.js");
        await assert.rejects(
          () => setConfigValue("fusion", bad, { filePath: pathMod.join(dir, "config.json") }),
          (error) => {
            assert.strictEqual(error.name, "ValidationError");
            // House style: message names the bad value, help lists the
            // accepted enum (mirrors the routing "tavlly" precedent).
            assert.match(String(error.message) + " " + String(error.help), /rrf/);
            assert.match(String(error.help), /occurrence/);
            return true;
          },
        );
      });
    });
  }

  it("config unset fusion removes the switch; absent switch fails", async (t) => {
    await withTempConfig(t, async (dir) => {
      const filePath = pathMod.join(dir, "config.json");
      const { setConfigValue, unsetConfigValue, readConfig } =
        await import("../dist/lib/config-store.js");
      assert.strictEqual(
        (await setConfigValue("fusion", "occurrence", { filePath })).fusion,
        "occurrence",
      );
      const updated = await unsetConfigValue("fusion", { filePath });
      assert.strictEqual(updated.fusion, undefined);
      await assert.rejects(
        () => unsetConfigValue("fusion", { filePath }),
        (error) => error.name === "ValidationError" && error.message.includes("not set"),
      );
    });
  });
});

// ---------------------------------------------------------------------------
// DESIGN D1: the user-facing `config set fusion` notice names the ordering
// consequence in one plain sentence (stderr; stdout stays data-only).
// ---------------------------------------------------------------------------

describe("fusion config key: set notice names the ranking consequence (D1)", () => {
  for (const value of ["rrf", "occurrence"]) {
    it(`config set fusion ${value} emits a stderr notice naming the new ordering`, async (t) => {
      await withTempConfig(t, async (dir) => {
        const { invocation, stdout, stderr } = makeInvocation();
        const deps = await baseDeps(invocation, dir);
        const status = await main(["config", "set", "fusion", value], deps);
        assert.strictEqual(status, 0);
        assert.match(stderr(), /rank/i);
        assert.ok(stderr().includes(value), "notice names the active mode");
        // stdout stays data-only — the notice never leaks into it.
        assert.ok(!stdout().toLowerCase().includes("rank by"));
      });
    });
  }
});

// ---------------------------------------------------------------------------
// resolveFusionMode — pure precedence: env > config > "rrf" default
// ---------------------------------------------------------------------------

describe("resolveFusionMode precedence (pure, injected env+config)", () => {
  it("env SCOUTLINE_FUSION=occurrence wins over config fusion rrf", () => {
    assert.strictEqual(
      resolveFusionMode(
        { SCOUTLINE_FUSION: "occurrence" },
        { version: 1, providers: {}, fusion: "rrf" },
      ),
      "occurrence",
    );
  });

  it("env unset + config occurrence → occurrence", () => {
    assert.strictEqual(
      resolveFusionMode({}, { version: 1, providers: {}, fusion: "occurrence" }),
      "occurrence",
    );
  });

  it("both unset → default rrf", () => {
    assert.strictEqual(resolveFusionMode({}, { version: 1, providers: {} }), "rrf");
    assert.strictEqual(resolveFusionMode({}, undefined), "rrf");
  });

  it("env typo throws ValidationError (strict — never drops)", () => {
    assert.throws(
      () => resolveFusionMode({ SCOUTLINE_FUSION: "bogus" }, { version: 1, providers: {} }),
      (error) => {
        assert.strictEqual(error.name, "ValidationError");
        assert.match(String(error.help), /occurrence/);
        return true;
      },
    );
  });

  it("env empty string is treated as unset (not a ValidationError)", () => {
    assert.strictEqual(
      resolveFusionMode(
        { SCOUTLINE_FUSION: "" },
        { version: 1, providers: {}, fusion: "occurrence" },
      ),
      "occurrence",
    );
  });
});

// ---------------------------------------------------------------------------
// AC-1 pin: NO --fusion query flag — rejected at the parser, forever
// ---------------------------------------------------------------------------

describe("AC-1: search rejects --fusion and --no-fusion at parse time", () => {
  for (const flagForm of [["--fusion", "rrf"], ["--no-fusion"]]) {
    it(`search q ${flagForm.join(" ")} exits 1 pointing at the config key`, async (t) => {
      await withTempConfig(t, async (dir) => {
        const { invocation, stdout, stderr } = makeInvocation();
        const deps = hermeticMainDeps({
          invocation,
          env: { SCOUTLINE_CONFIG_DIR: dir },
          providerDescriptors: [configuredDescriptor("tavily")],
        });
        const status = await main(["search", "q", ...flagForm], deps);
        assert.strictEqual(status, 1);
        assert.ok(stderr().includes("VALIDATION_ERROR"));
        assert.match(stderr(), /--fusion/);
        assert.match(stderr(), /config set fusion|SCOUTLINE_FUSION/);
        assert.strictEqual(stdout(), "");
      });
    });
  }
});

// ---------------------------------------------------------------------------
// Local helpers (mirroring tests/config-command.test.js + search-fanout patterns)
// ---------------------------------------------------------------------------

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

async function baseDeps(invocation, dir) {
  return {
    invocation,
    env: { SCOUTLINE_CONFIG_DIR: dir },
  };
}

async function runMain(args, dir) {
  const { invocation } = makeInvocation();
  return main(args, await baseDeps(invocation, dir));
}

async function withTempConfig(t, run) {
  const dir = await fsMod.mkdtemp(pathMod.join(osMod.tmpdir(), "scoutline-fusion-"));
  const savedConfigDir = process.env.SCOUTLINE_CONFIG_DIR;
  process.env.SCOUTLINE_CONFIG_DIR = dir;
  t.after(async () => {
    if (savedConfigDir === undefined) delete process.env.SCOUTLINE_CONFIG_DIR;
    else process.env.SCOUTLINE_CONFIG_DIR = savedConfigDir;
    await fsMod.rm(dir, { recursive: true, force: true });
  });
  await run(dir);
}

/** Minimal configured search descriptor (no transport touched on a parse error). */
function configuredDescriptor(id) {
  return {
    id,
    isConfigured: () => true,
    capabilities: () => new Set(["search"]),
    create: () => ({ id, search: {} }),
  };
}
