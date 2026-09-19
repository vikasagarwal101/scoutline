/**
 * `config get` stored-value posture (#245).
 *
 * `config get fusion` renders the STORED value, not the env-resolved
 * effective one: with config `fusion=rrf` and SCOUTLINE_FUSION=
 * occurrence, `config get fusion` prints `rrf` while actual searches
 * rank by occurrence. Same posture as `fanout`/`journal` (reviewer
 * NIT'd it as defensible during PR #240; owner accepted filing). The
 * chosen fix is the cheap honest one: a docs note on env-overridable
 * keys in docs/configuration.md — "get shows the stored key; environment
 * overrides are runtime-only and are not reflected" — pinned here along
 * with the behavior it describes.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "../dist/index.js";
import { useTempConfigDir } from "./helpers/config-dir-pin.js";
import { hermeticMainDeps } from "./helpers/hermetic-main.js";

useTempConfigDir();

describe("docs/configuration.md: config get stored-key note (#245)", () => {
  it("the `config` Command Family section documents the stored-key posture", async () => {
    const docs = await readFile(new URL("../../../docs/configuration.md", import.meta.url), "utf8");
    const start = docs.indexOf("## `config` Command Family");
    assert.ok(start > 0, "configuration.md has a `config` Command Family section");
    const end = docs.indexOf("\n## ", start + 1);
    const section = docs.slice(start, end > 0 ? end : undefined);
    assert.match(section, /stored/i, "the section must say get shows the stored key");
    assert.match(section, /runtime-only/i, "the section must say env overrides are runtime-only");
    assert.match(section, /SCOUTLINE_FUSION|environment override/i);
  });
});

describe("config get renders the stored key with an injected loader (PR #253 r1 hermeticity)", () => {
  it("stored occurrence + SCOUTLINE_FUSION=rrf → config get outputs occurrence", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "scoutline-cfgget2-"));
    t.after(async () => {
      await rm(dir, { recursive: true, force: true });
    });
    const configPath = join(dir, "config.json");
    await writeFile(configPath, JSON.stringify({ version: 1, providers: {}, fusion: "occurrence" }));
    const stdout = [];
    const deps = hermeticMainDeps({
      invocation: {
        stdoutIsTTY: false,
        stdinIsTTY: false,
        environmentOutputMode: "data",
        readStdin: async () => "",
        writeStdout: (v) => stdout.push(v),
        writeStderr: () => {},
        runQuietly: async (op) => op(),
        setExitCode: () => {},
      },
      env: { SCOUTLINE_CONFIG_DIR: dir, SCOUTLINE_FUSION: "rrf" },
      // Isolated loader seam (the hermetic-main contract): main never
      // falls through to the ambient config read.
      loadScoutlineConfig: async () => JSON.parse(await readFile(configPath, "utf8")),
    });
    const status = await main(["config", "get", "fusion"], deps);
    assert.strictEqual(status, 0);
    const out = stdout.join("");
    assert.match(out, /occurrence/);
    assert.doesNotMatch(out, /"rrf"|fusion → rrf/);
  });
});

describe("config get renders the stored value under an env override (#245 posture pin)", () => {
  it("stored rrf + SCOUTLINE_FUSION=occurrence → config get prints rrf, exit 0", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "scoutline-cfgget-"));
    t.after(async () => {
      await rm(dir, { recursive: true, force: true });
    });
    await writeFile(
      join(dir, "config.json"),
      JSON.stringify({ version: 1, providers: {}, fusion: "rrf" }),
    );
    const stdout = [];
    const deps = hermeticMainDeps({
      invocation: {
        stdoutIsTTY: false,
        stdinIsTTY: false,
        environmentOutputMode: "data",
        readStdin: async () => "",
        writeStdout: (v) => stdout.push(v),
        writeStderr: () => {},
        runQuietly: async (op) => op(),
        setExitCode: () => {},
      },
      env: { SCOUTLINE_CONFIG_DIR: dir, SCOUTLINE_FUSION: "occurrence" },
    });
    const status = await main(["config", "get", "fusion"], deps);
    assert.strictEqual(status, 0);
    assert.match(stdout.join(""), /rrf/);
    assert.doesNotMatch(stdout.join(""), /occurrence/);
  });
});
