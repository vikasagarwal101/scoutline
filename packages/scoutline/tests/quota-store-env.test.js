/**
 * Issue #132 — `deps.env` plumbed into `createDefaultQuotaStore`.
 *
 * The factory's state path resolved via ambient `stateFilePath()`
 * (`resolveConfigRoot()` → `process.env`), so the `deps.env` the whole
 * invocation seam threads was ignored at main()'s `??` default — the
 * root of the #119 ambient-env test-leak class. Two pins:
 *
 *   1. Factory pin: `createDefaultQuotaStore({ env })` resolves the
 *      state path from the INJECTED env view (pure resolver), not
 *      ambient. RED at base: the factory ignored `env`, so the write
 *      lands in the ambient root (offline gate: the runner's temp dir;
 *      bare glob: the #119 guard throws outright).
 *
 *   2. main()-driven pin: full production mode (no config/descriptor/
 *      store injections → the hermeticity gate is ON) with
 *      `deps.env.SCOUTLINE_CONFIG_DIR` pointing at a root whose
 *      `state.json` is a DIRECTORY (deterministic read failure), while
 *      AMBIENT `SCOUTLINE_CONFIG_DIR` points at a clean root. The
 *      pre-dispatch `quotaStore.read()` (PB-T4) must fail against the
 *      env-injected root — the fail-open warning sink announces it on
 *      process stderr. RED at base: the store read the ambient root,
 *      whose absent state.json is silently empty (ENOENT → no warning).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { main } from "../dist/index.js";
import { createDefaultQuotaStore } from "../dist/lib/quota-store.js";

async function mkTemp(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("quota-store: env-aware state path (issue #132)", () => {
  it("factory resolves stateFilePath from the injected env view, not ambient", async (t) => {
    const injectedRoot = await mkTemp("scoutline-quota-env-injected-");
    t.after(async () => {
      await fs.rm(injectedRoot, { recursive: true, force: true }).catch(() => {});
    });

    const store = createDefaultQuotaStore({ env: { SCOUTLINE_CONFIG_DIR: injectedRoot } });
    const observedAt = 1_786_000_060_000;
    await store.writeObserved("zai", { observedAt, categories: [] });

    // The write must land under the INJECTED root. At base the factory
    // resolves the ambient root (offline gate: the runner's temp dir —
    // this file never appears; bare glob: the #119 guard throws first).
    const statePath = path.join(injectedRoot, "state.json");
    const raw = await fs.readFile(statePath, "utf8");
    const parsed = JSON.parse(raw);
    assert.strictEqual(parsed.version, 1);
    assert.strictEqual(parsed.quota.zai.observedAt, observedAt);
  });

  it("main() threads deps.env into the default quota store (ambient root untouched)", async (t) => {
    // deps.env root: state.json is a DIRECTORY → the read fails loudly
    // (EISDIR) and the fail-open warning sink announces it on stderr.
    const injectedRoot = await mkTemp("scoutline-quota-env-main-");
    await fs.mkdir(path.join(injectedRoot, "state.json"));
    // Ambient root: clean and state.json-absent → ENOENT reads are
    // silently empty, so ANY warning must have come from the injected
    // root's directory collision.
    const ambientRoot = await mkTemp("scoutline-quota-env-ambient-");
    const cacheRoot = await mkTemp("scoutline-quota-env-cache-");
    t.after(async () => {
      for (const dir of [injectedRoot, ambientRoot, cacheRoot]) {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    });

    // Redirect BOTH ambient roots (config + response cache — the
    // main-consume-wiring withRedirectedRoots pattern) so the
    // production-mode run never touches the real ~/.scoutline even
    // under the bare glob.
    const saved = {
      SCOUTLINE_CONFIG_DIR: process.env.SCOUTLINE_CONFIG_DIR,
      SCOUTLINE_CACHE_DIR: process.env.SCOUTLINE_CACHE_DIR,
    };
    process.env.SCOUTLINE_CONFIG_DIR = ambientRoot;
    process.env.SCOUTLINE_CACHE_DIR = cacheRoot;

    const stderr = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = function (chunk) {
      stderr.push(String(chunk));
      return true;
    };
    try {
      // Full production mode: NO config / providerDescriptors / quotaStore
      // / quotaState / consume injections — the hermeticity gate is ON,
      // so main() constructs the default store (the #132 seam) and the
      // PB-T4 pre-dispatch `quotaStore.read()` runs for this command.
      // `search` is non-observational (no live quota refresh probes).
      // The dispatch itself fails afterwards (no configured providers in
      // the ambient root's absent config.json) — that failure is after
      // the read and irrelevant to the pin.
      await main(["search", "quota-env-pin"], {
        invocation: {
          stdoutIsTTY: false,
          stdinIsTTY: false,
          environmentOutputMode: "data",
          readStdin: async () => "",
          writeStdout: () => {},
          writeStderr: () => {},
          runQuietly: async (op) => op(),
          setExitCode: () => {},
        },
        env: { SCOUTLINE_CONFIG_DIR: injectedRoot },
      });
    } finally {
      process.stderr.write = originalWrite;
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }

    // GREEN: the store read the INJECTED root, whose directory-shaped
    // state.json failed the read → fail-open warning on stderr.
    // RED at base: the store read the AMBIENT root, whose absent
    // state.json reads silently (ENOENT → empty, no warning).
    assert.ok(
      stderr.some((line) => line.includes("Unable to read state.json")),
      `expected the env-injected root's read failure on stderr, got: ${JSON.stringify(stderr)}`,
    );
  });
});
