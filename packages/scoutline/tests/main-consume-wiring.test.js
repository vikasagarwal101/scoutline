/**
 * Usage-ledger Ticket 3 — production consume wiring in `main`.
 *
 * DESIGN D3: behind the `quotaRefreshEnabled` hermeticity gate,
 * production `consume` becomes
 * `composite(quotaStoreSink, usageLedgerSink)`. Three lenses:
 *
 *   1. Source-shape (RED driver): `src/index.ts` must construct the
 *      composite inside the gate ternary, with the ledger sink at
 *      `resolveUsageLedgerPath()` (config-root sibling, DESIGN D1).
 *      Source-assertion precedent: adapter-conformance's "the
 *      production registry is reachable from src/index.ts".
 *
 *   2. Hermeticity (through `main`): injected `MainDependencies.consume`
 *      (in-memory double) AND `providerDescriptors` (minimal fake set)
 *      AND the driven capability's cache/sleep/random triple (the
 *      `tests/reader-command.test.js` makeMainDeps pattern). Either
 *      injection flips the hermeticity gate off, so the production
 *      composite is never constructed on a test path;
 *      `SCOUTLINE_CONFIG_DIR` points at a temp dir that must stay
 *      EMPTY (no `usage.json`, no `state.json`). The response-cache
 *      root keys off `SCOUTLINE_CACHE_DIR` (NOT `SCOUTLINE_CONFIG_DIR`),
 *      so it gets a temp dir too. A second variant drops the `consume`
 *      injection entirely and still drives billable fan-out invokes —
 *      with the gate off there is no sink at all.
 *
 *   3. Composition (direct construction): the exact production shape —
 *      `composite(quotaStoreSink, usageLedgerSink)` with the ledger at
 *      `resolveUsageLedgerPath()` over `SCOUTLINE_CONFIG_DIR` — records
 *      one event and lands a row in `usage.json`. The main-as-subprocess
 *      production gate lands in Ticket 4 with the handler threading:
 *      until then only vision and the fan-out arms forward `consume`,
 *      so a subprocess run here would write no row.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { main } from "../dist/index.js";
import {
  createCompositeConsumptionSink,
  createInMemoryConsumptionSink,
  createQuotaStoreConsumptionSink,
} from "../dist/lib/consumption.js";
import { createUsageLedgerSink, resolveUsageLedgerPath } from "../dist/lib/usage-ledger.js";
import { createDefaultQuotaStore } from "../dist/lib/quota-store.js";
import { withTempDir } from "./helpers/temp-dir.js";
import { hermeticMainDeps } from "./helpers/hermetic-main.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(__dirname, "..", "src");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Redirect both real-fs roots at temp dirs for the duration of
 * `operation`, restoring the previous values after. The config root
 * feeds `resolveConfigRoot()` (config.json, state.json, usage.json);
 * the cache root is a SEPARATE env var (`SCOUTLINE_CACHE_DIR`), so an
 * un-redirected cache root would silently fall back to the real
 * `~/.scoutline` cache.
 */
async function withRedirectedRoots(configDir, cacheDir, operation) {
  const saved = {
    SCOUTLINE_CONFIG_DIR: process.env.SCOUTLINE_CONFIG_DIR,
    SCOUTLINE_CACHE_DIR: process.env.SCOUTLINE_CACHE_DIR,
  };
  process.env.SCOUTLINE_CONFIG_DIR = configDir;
  process.env.SCOUTLINE_CACHE_DIR = cacheDir;
  try {
    return await operation();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/**
 * Build a two-provider fan-out drive (the `tests/search-fanout.test.js`
 * "main() threads the configured consume sink into every fan-out arm"
 * pattern): fake descriptors whose search capabilities record every
 * `invoke` (proving the run reached the billable emission seam), an
 * in-memory response cache, and a recording invocation adapter. The
 * fan-out path is the only plain-dispatch route that forwards
 * `consume` before Ticket 4's handler threading.
 */
function makeFanoutDrive() {
  const stderr = [];
  const stdout = [];
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
  const state = { invokes: 0 };
  const store = new Map();
  const cache = {
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async set(key, value) {
      store.set(key, value);
    },
  };
  function makeDescriptor(id, result) {
    return {
      id,
      isConfigured: () => true,
      capabilities: () => new Set(["search"]),
      create: () => ({
        id,
        search: {
          validate() {},
          cacheIdentity(request) {
            return {
              provider: id,
              capability: "search",
              credentialFingerprint: `fp-${id}`,
              request,
              legacyCandidates: [],
            };
          },
          async invoke() {
            state.invokes += 1;
            return [{ ...result }];
          },
        },
      }),
    };
  }
  return {
    adapter,
    stdout,
    stderr,
    cache,
    state,
    descriptors: [
      makeDescriptor("tavily", { title: "T", url: "https://e/t", summary: "t" }),
      makeDescriptor("exa", { title: "E", url: "https://e/e", summary: "e" }),
    ],
  };
}

// ---------------------------------------------------------------------------
// 1. Source shape — the wiring itself (RED driver)
// ---------------------------------------------------------------------------

describe("usage-ledger Ticket 3 — production consume wiring in main", () => {
  it("src/index.ts composes composite(quotaStoreSink, usageLedgerSink) behind the hermeticity gate", async () => {
    const indexSource = await fs.readFile(path.join(SRC_DIR, "index.ts"), "utf8");

    // D6: the gate keeps its documented shape — the production sinks
    // are built ONLY in full production mode (no injected
    // loadScoutlineConfig AND no injected providerDescriptors).
    assert.match(
      indexSource,
      /const quotaRefreshEnabled =\s*!loadScoutlineConfig && !dependencies\.providerDescriptors;/,
      "hermeticity gate must keep its documented shape",
    );

    // D3: the production construction is the composite of the two
    // sinks, inside the gate's ternary (an injected
    // MainDependencies.consume still wins). The gate additionally
    // excludes isolated runs (ADR-0006 §5: --isolated skips shared
    // state persistence entirely).
    assert.match(
      indexSource,
      /dependencies\.consume\s*\?\?\s*(?:\/\/[^\n]*\n\s*)*\(quotaRefreshEnabled && !isolated\s*\?\s*createCompositeConsumptionSink\(/,
      "production consume must be composite(quotaStoreSink, usageLedgerSink) behind the gate",
    );

    // D1: the ledger side writes the config-root sibling usage.json
    // through the pure path resolver; warnings default to stderr like
    // the quota sink, so production passes only the file path. The root
    // comes from the INJECTED env (resolveConfigRootPure over
    // MainDependencies.env — the same root `handleUsage` reads through),
    // so embedded callers that inject SCOUTLINE_CONFIG_DIR record and
    // report from one ledger (review P2).
    assert.match(
      indexSource,
      /createUsageLedgerSink\(\{\s*filePath: resolveUsageLedgerPath\(\s*resolveConfigRootPure\(env, \{ homedir: os\.homedir\(\) \}\),\s*\),\s*\}\)/,
      "ledger sink must sit at resolveUsageLedgerPath(resolveConfigRootPure(env, ...)) — the injected env's config-root sibling",
    );

    // Both wrapped sinks are the documented ones.
    assert.ok(
      indexSource.includes("createQuotaStoreConsumptionSink("),
      "the composite's primary side must be the quota-store sink",
    );
  });

  // -------------------------------------------------------------------------
  // 2. Hermeticity — through main, redirected roots must stay untouched
  // -------------------------------------------------------------------------

  it("an injected consume sink receives the fan-out events and the redirected config root stays empty", async (t) => {
    await withTempDir(t, async (configDir) => {
      await withTempDir(t, async (cacheDir) => {
        const drive = makeFanoutDrive();
        const sink = createInMemoryConsumptionSink();
        let status;
        await withRedirectedRoots(configDir, cacheDir, async () => {
          status = await main(
            ["--provider", "tavily,exa", "search", "q"],
            hermeticMainDeps({
              invocation: drive.adapter,
              env: {},
              providerDescriptors: drive.descriptors,
              searchCache: drive.cache,
              searchSleep: async () => {},
              searchRandom: () => 0.5,
              consume: sink,
            }),
          );
        });
        assert.strictEqual(status, 0, `exit 0 expected, stderr: ${JSON.stringify(drive.stderr)}`);

        // The run genuinely reached the billable emission seam and the
        // injected sink (NOT any production sink) took the events.
        assert.strictEqual(drive.state.invokes, 2, "both fan-out arms invoked");
        assert.strictEqual(sink.events.length, 2, "both arms billed through the injected sink");
        assert.deepStrictEqual(
          sink.events.map((event) => event.provider).sort(),
          ["exa", "tavily"],
        );
        for (const event of sink.events) {
          assert.strictEqual(event.capabilityId, "search");
          assert.strictEqual(event.attempt, 1);
        }

        // Belt-and-braces: the production composite was never
        // constructed (gate off via providerDescriptors), so nothing —
        // usage.json, state.json, or any other file — landed in the
        // redirected config root.
        const entries = await fs.readdir(configDir);
        assert.deepStrictEqual(
          entries,
          [],
          `config root must stay empty (no usage.json, no state.json); got ${JSON.stringify(entries)}`,
        );
      });
    });
  });

  it("providerDescriptors injection alone flips the gate off: billable fan-out invokes record nothing anywhere", async (t) => {
    // No consume injection at all. quotaRefreshEnabled is false because
    // providerDescriptors is injected, so the production composite is
    // never constructed — there is no sink. The counted invokes prove
    // the empty-dir assertion below is not vacuous: the run really
    // reached the emission seam, it just had nowhere to record.
    await withTempDir(t, async (configDir) => {
      await withTempDir(t, async (cacheDir) => {
        const drive = makeFanoutDrive();
        let status;
        await withRedirectedRoots(configDir, cacheDir, async () => {
          status = await main(
            ["--provider", "tavily,exa", "search", "q"],
            hermeticMainDeps({
              invocation: drive.adapter,
              env: {},
              providerDescriptors: drive.descriptors,
              searchCache: drive.cache,
              searchSleep: async () => {},
              searchRandom: () => 0.5,
            }),
          );
        });
        assert.strictEqual(status, 0, `exit 0 expected, stderr: ${JSON.stringify(drive.stderr)}`);
        assert.strictEqual(drive.state.invokes, 2, "both fan-out arms still invoked");

        const entries = await fs.readdir(configDir);
        assert.deepStrictEqual(
          entries,
          [],
          `gate-off run must not construct the composite or write anything; got ${JSON.stringify(entries)}`,
        );
      });
    });
  });

  // -------------------------------------------------------------------------
  // 3. Composition — the production shape, direct construction
  // -------------------------------------------------------------------------

  it("the production composition lands a usage.json row (composite over a temp config root)", async (t) => {
    await withTempDir(t, async (configDir) => {
      // resolveUsageLedgerPath() honors the redirected config root, so
      // this is byte-for-byte the production construction from main.
      await withRedirectedRoots(configDir, configDir, async () => {
        const fixedNow = Date.UTC(2026, 0, 15, 10, 30, 0); // 2026-01-15T10:30:00.000Z
        const quotaStore = createDefaultQuotaStore({
          filePath: path.join(configDir, "state.json"),
          now: () => fixedNow,
        });
        const composite = createCompositeConsumptionSink(
          createQuotaStoreConsumptionSink({ store: quotaStore, now: () => fixedNow }),
          createUsageLedgerSink({ filePath: resolveUsageLedgerPath(), now: () => fixedNow }),
        );
        await composite.record({
          provider: "tavily",
          capabilityId: "search",
          amount: { kind: "estimate", value: 1 },
          attempt: 1,
          at: fixedNow,
        });

        const ledgerPath = resolveUsageLedgerPath();
        assert.strictEqual(
          ledgerPath,
          path.join(configDir, "usage.json"),
          "ledger resolves to the config-root sibling",
        );
        const ledger = JSON.parse(await fs.readFile(ledgerPath, "utf8"));
        assert.strictEqual(ledger.version, 1);
        const day = ledger.days["2026-01-15"];
        assert.ok(day, "row lands under the UTC day key derived from event.at");
        const row = day.tavily.search;
        assert.ok(row, "provider -> capability row exists");
        assert.strictEqual(row.attempts, 1);
        assert.strictEqual(row.firstTries, 1);
        assert.strictEqual(row.estimateUnits, 1);

        // Ledger row plus the quota-store scaffold (#41): writeConsumption
        // no longer no-ops before the first harvest, so state.json appears
        // alongside usage.json. The ledger lock still unlinks on exit.
        const entries = (await fs.readdir(configDir)).sort();
        assert.deepStrictEqual(entries, ["state.json", "usage.json"]);
      });
    });
  });
});
