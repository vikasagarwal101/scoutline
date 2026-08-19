/**
 * #73 — main() config hermeticity: deps.config short-circuits ambient
 * config loading, and hermeticMainDeps defaults an empty config loader.
 * `env: {}` is NOT isolation (inspectConfig reads process.env /
 * ~/.scoutline, never deps.env); these pins make the isolation explicit.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "../dist/index.js";
import { hermeticMainDeps, createInMemoryResponseCache } from "./helpers/hermetic-main.js";

// Ambient config with fanout enabled — the exact leak vector of #63-#65.
let ambientDir;
before(() => {
  ambientDir = mkdtempSync(join(tmpdir(), "scoutline-ambient-"));
  writeFileSync(join(ambientDir, "config.json"), JSON.stringify({ version: 1, fanout: true, providers: {} }));
});
after(() => rmSync(ambientDir, { recursive: true, force: true }));

function makeSearchDescriptor(id) {
  return {
    id,
    isConfigured: () => true,
    capabilities: () => new Set(["search"]),
    create: () => ({
      id,
      search: {
        validate() {},
        cacheIdentity(r) {
          return { provider: id, capability: "search", credentialFingerprint: `fp-${id}`, request: r, legacyCandidates: [] };
        },
        async invoke() {
          return [{ title: id, url: `https://${id}/r`, summary: "s" }];
        },
      },
    }),
  };
}

function makeAdapter() {
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
  };
  return { adapter, stdout, stderr };
}

const withAmbientConfigDir = async (fn) => {
  const prev = process.env.SCOUTLINE_CONFIG_DIR;
  process.env.SCOUTLINE_CONFIG_DIR = ambientDir;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.SCOUTLINE_CONFIG_DIR;
    else process.env.SCOUTLINE_CONFIG_DIR = prev;
  }
};

describe("main() config hermeticity (#73)", () => {
  it("hermeticMainDeps defaults an empty config loader (caller values win)", async () => {
    const { adapter } = makeAdapter();
    const deps = hermeticMainDeps({ invocation: adapter });
    assert.strictEqual(deps.configFanout, false);
    assert.ok(typeof deps.loadScoutlineConfig === "function", "config loader default present");
    assert.deepStrictEqual(await deps.loadScoutlineConfig(), { version: 1, providers: {} });
    const custom = async () => ({ version: 1, fanout: true, providers: {} });
    const overridden = hermeticMainDeps({ invocation: adapter, loadScoutlineConfig: custom });
    assert.strictEqual(overridden.loadScoutlineConfig, custom, "explicit caller loader wins");
  });

  it("deps.config short-circuits the ambient config file (fanout stays off)", async () => {
    const { adapter, stdout, stderr } = makeAdapter();
    const status = await withAmbientConfigDir(() =>
      main(["search", "q"], {
        invocation: adapter,
        env: {},
        providerDescriptors: [makeSearchDescriptor("zai"), makeSearchDescriptor("tavily")],
        config: { version: 1, providers: {} },
        searchCache: createInMemoryResponseCache(),
        searchSleep: async () => {},
        searchRandom: () => 0.5,
      }),
    );
    assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
    assert.ok(
      !stderr.some((l) => /fanned out to/i.test(l)),
      `deps.config must prevent ambient fanout:true from engaging; stderr=${JSON.stringify(stderr)}`,
    );
    const data = JSON.parse(stdout[0]);
    assert.ok(Array.isArray(data) && data.length === 1, "single-provider run, not fan-out");
  });

  it("control: without deps.config the ambient file does engage fanout", async () => {
    const { adapter, stderr } = makeAdapter();
    const status = await withAmbientConfigDir(() =>
      main(["search", "q"], {
        invocation: adapter,
        env: {},
        providerDescriptors: [makeSearchDescriptor("zai"), makeSearchDescriptor("tavily")],
        searchCache: createInMemoryResponseCache(),
        searchSleep: async () => {},
        searchRandom: () => 0.5,
      }),
    );
    assert.strictEqual(status, 0);
    assert.ok(
      stderr.some((l) => /fanned out to/i.test(l)),
      `ambient fanout:true should engage when no isolation is provided; stderr=${JSON.stringify(stderr)}`,
    );
  });
});
