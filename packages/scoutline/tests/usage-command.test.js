/**
 * Usage command — `scoutline usage [--days N] [--provider <id>]`
 * (usage-ledger plan, Ticket 5).
 *
 * Verifies:
 *   - The D8 envelope (schemaVersion/windowDays/generatedAt/unitNote/
 *     providers) emitted in data mode, with counters summed across the
 *     UTC-day window and totals per provider.
 *   - `--days` window filtering: default 7, edge day in / one day
 *     older out; `--days 1` narrows to today.
 *   - `--days 0` / non-numeric / non-integer / bare `--days` → exit 1
 *     VALIDATION_ERROR.
 *   - `--provider` filter: known id keeps only its rows; known but
 *     unrecorded id → empty providers + exit 0; unknown id → exit 1
 *     VALIDATION_ERROR listing the accepted ids.
 *   - Fail-open reads: missing ledger, corrupt JSON, wrong version →
 *     empty providers + exit 0 + silent stderr (D8).
 *   - Deterministic provider/capability ordering (both ascending).
 *   - The dispatcher `handleUsage` parses flags and reads the ledger
 *     through `resolveConfigRootPure(deps.env, ...)` — tests inject
 *     `SCOUTLINE_CONFIG_DIR` at a prepared temp dir (the same
 *     injection-free posture as `handleCache`).
 *   - Dispatch through `main` with injected deps (including a
 *     pre-command-token `--provider`, which `extractGlobalOptions`
 *     strips and the handler recovers from `deps.provider`).
 *   - The CLI surface via subprocess against an isolated config dir.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { buildUsageReport, formatUsageReport, USAGE_HELP } from "../dist/commands/usage.js";
import { handleUsage, main } from "../dist/index.js";
import { ValidationError } from "../dist/lib/errors.js";
import { defaultResponseCache } from "../dist/lib/cache.js";
import { runProcess } from "./helpers/run-process.js";
import { withTempDir } from "./helpers/temp-dir.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Fixed clock: 2026-08-16T12:00:00.000Z → UTC day key "2026-08-16".
const NOW = Date.parse("2026-08-16T12:00:00.000Z");
const fixedNow = () => NOW;

const UNIT_NOTE =
  "counts are billable call attempts; providers do not report credit costs";

/** Counters helper: (attempts, firstTries, estimateUnits, exactUnits, unknownCount). */
function c(attempts, firstTries, estimateUnits, exactUnits = 0, unknownCount = 0) {
  return { attempts, firstTries, exactUnits, estimateUnits, unknownCount };
}

/** Ledger with two providers on today's key (capability keys pre-sorted). */
function ledgerTwoProviders() {
  return {
    version: 1,
    days: {
      "2026-08-16": {
        zai: { search: c(2, 2, 2), reader: c(1, 1, 1) },
        tavily: { read: c(3, 3, 3) },
      },
    },
  };
}

/** Ledger spanning the --days boundary plus one day too old. */
function ledgerWindowed() {
  return {
    version: 1,
    days: {
      "2026-08-16": { zai: { search: c(2, 1, 2) } },
      "2026-08-15": { zai: { search: c(5, 5, 5) } },
      // Exactly 7 days back from today (edge of the default window): IN.
      "2026-08-10": { zai: { search: c(10, 10, 10) } },
      // 8 days back: OUT for --days 7.
      "2026-08-09": { zai: { search: c(100, 100, 100) } },
    },
  };
}

/** Ledger whose map insertion order is deliberately unsorted. */
function ledgerUnsorted() {
  return {
    version: 1,
    days: {
      "2026-08-16": {
        exa: { search: c(1, 1, 1) },
        brave: { crawl: c(1, 1, 1) },
        zai: { search: c(1, 1, 1), read: c(1, 1, 1), crawl: c(1, 1, 1) },
      },
    },
  };
}

/**
 * Minimal HandlerDependencies stub for in-process dispatcher tests
 * (same shape as the cache-command double). The `env` carries
 * SCOUTLINE_CONFIG_DIR at the prepared temp dir — the ONLY injection
 * seam the handler needs (injection-free posture, like handleCache).
 */
function makeUsageDeps({ dir, provider, now = fixedNow } = {}) {
  const stdout = [];
  const stderr = [];
  const cache = defaultResponseCache;
  const sleep = () => Promise.resolve();
  const random = () => 0;
  return {
    stdout,
    stderr,
    deps: {
      invocation: {
        stdoutIsTTY: false,
        stdinIsTTY: false,
        environmentOutputMode: "data",
        readStdin: async () => "",
        writeStdout: (v) => stdout.push(v),
        writeStderr: (v) => stderr.push(v),
        runQuietly: async (op) => op(),
        setExitCode: () => {},
      },
      env: { SCOUTLINE_CONFIG_DIR: dir },
      secrets: [],
      ...(provider !== undefined ? { provider } : {}),
      now,
      providerDescriptors: [],
      fallbackEnabled: false,
      searchCache: cache,
      searchSleep: sleep,
      searchRandom: random,
      repositoryCache: cache,
      repositorySleep: sleep,
      repositoryRandom: random,
      readerCache: cache,
      readerSleep: sleep,
      readerRandom: random,
      crawlCache: cache,
      crawlSleep: sleep,
      crawlRandom: random,
      mapCache: cache,
      mapSleep: sleep,
      mapRandom: random,
      researchCache: cache,
      researchSleep: sleep,
      researchRandom: random,
    },
  };
}

/** Drive `handleUsage` in-process; returns { code, stdout, stderr } strings. */
async function runUsage(args, { dir, provider, outputMode = "data", now = fixedNow } = {}) {
  const ctx = makeUsageDeps({ dir, provider, now });
  const code = await handleUsage(args, outputMode, ctx.deps);
  return { code, stdout: ctx.stdout.join(""), stderr: ctx.stderr.join("") };
}

/** Drive `main` in-process with injected env (dispatch-level coverage). */
async function runMain(argv, { dir, now = fixedNow } = {}) {
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
  const code = await main(argv, {
    invocation: adapter,
    env: { SCOUTLINE_CONFIG_DIR: dir },
    now,
  });
  return { code, stdout: stdout.join(""), stderr: stderr.join("") };
}

async function writeLedger(dir, ledger) {
  await fs.writeFile(path.join(dir, "usage.json"), JSON.stringify(ledger));
}

async function assertValidationRejects(promise, pattern) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof ValidationError, `is ValidationError: ${error}`);
    assert.strictEqual(error.code, "VALIDATION_ERROR");
    assert.strictEqual(error.exitCode, 1);
    assert.ok(pattern.test(error.message), `message: ${error.message}`);
    return true;
  });
}

// ---------------------------------------------------------------------------
// D8 envelope
// ---------------------------------------------------------------------------

describe("usage command — envelope (DESIGN D8)", () => {
  it("emits the full envelope with sorted providers, summed totals, and capability rows", async () => {
    await withTempDir({}, async (dir) => {
      await writeLedger(dir, ledgerTwoProviders());
      const { code, stdout, stderr } = await runUsage(["usage"], { dir });
      assert.strictEqual(code, 0, `exit 0 (stderr: ${stderr})`);
      assert.strictEqual(stderr, "", "data mode writes nothing to stderr");
      assert.deepStrictEqual(JSON.parse(stdout), {
        schemaVersion: 1,
        windowDays: 7,
        generatedAt: NOW,
        unitNote: UNIT_NOTE,
        providers: [
          {
            provider: "tavily",
            totals: c(3, 3, 3),
            capabilities: [{ capabilityId: "read", counters: c(3, 3, 3) }],
          },
          {
            provider: "zai",
            totals: c(3, 3, 3),
            capabilities: [
              { capabilityId: "reader", counters: c(1, 1, 1) },
              { capabilityId: "search", counters: c(2, 2, 2) },
            ],
          },
        ],
      });
    });
  });

  it("carries every counter axis including exactUnits and unknownCount", async () => {
    await withTempDir({}, async (dir) => {
      await writeLedger(dir, {
        version: 1,
        days: {
          "2026-08-16": { zai: { search: c(4, 2, 0, 7, 2) } },
        },
      });
      const { stdout } = await runUsage(["usage"], { dir });
      const row = JSON.parse(stdout).providers[0].capabilities[0].counters;
      assert.deepStrictEqual(row, { attempts: 4, firstTries: 2, exactUnits: 7, estimateUnits: 0, unknownCount: 2 });
    });
  });

  it("renders a fixed-order table in tty mode", async () => {
    await withTempDir({}, async (dir) => {
      await writeLedger(dir, ledgerTwoProviders());
      const { code, stdout } = await runUsage(["usage"], { dir, outputMode: "tty" });
      assert.strictEqual(code, 0);
      assert.ok(stdout.includes("tavily"), `table lists tavily: ${stdout}`);
      assert.ok(stdout.includes("zai"), `table lists zai: ${stdout}`);
      assert.ok(stdout.includes("search"), `table lists capabilities: ${stdout}`);
      assert.ok(stdout.includes("attempts"), `table has an attempts column: ${stdout}`);
      // Fixed order: tavily row before zai row (provider asc).
      assert.ok(stdout.indexOf("tavily") < stdout.indexOf("zai"), `provider order asc: ${stdout}`);
    });
  });
});

// ---------------------------------------------------------------------------
// --days window filter
// ---------------------------------------------------------------------------

describe("usage command — --days window filter", () => {
  it("default --days 7 keeps the edge day and drops one day older", async () => {
    await withTempDir({}, async (dir) => {
      await writeLedger(dir, ledgerWindowed());
      const { stdout } = await runUsage(["usage"], { dir });
      const report = JSON.parse(stdout);
      assert.strictEqual(report.windowDays, 7);
      const zai = report.providers[0];
      // 08-16 (2) + 08-15 (5) + 08-10 (10) = 17; the 08-09 day (100) is out.
      assert.strictEqual(zai.totals.attempts, 17);
      assert.strictEqual(zai.totals.firstTries, 16);
      assert.strictEqual(zai.totals.estimateUnits, 17);
    });
  });

  it("--days 1 narrows the window to today only", async () => {
    await withTempDir({}, async (dir) => {
      await writeLedger(dir, ledgerWindowed());
      const { stdout } = await runUsage(["usage", "--days", "1"], { dir });
      const report = JSON.parse(stdout);
      assert.strictEqual(report.windowDays, 1);
      const zai = report.providers[0];
      assert.strictEqual(zai.totals.attempts, 2, `only today's row: ${stdout}`);
    });
  });

  it("--days 30 widens the window past the ledger's oldest day", async () => {
    await withTempDir({}, async (dir) => {
      await writeLedger(dir, ledgerWindowed());
      const { stdout } = await runUsage(["usage", "--days", "30"], { dir });
      const zai = JSON.parse(stdout).providers[0];
      assert.strictEqual(zai.totals.attempts, 117, `all four days summed: ${stdout}`);
    });
  });
});

// ---------------------------------------------------------------------------
// --days validation
// ---------------------------------------------------------------------------

describe("usage command — --days validation", () => {
  it("rejects --days 0 with VALIDATION_ERROR", async () => {
    await withTempDir({}, async (dir) => {
      await assertValidationRejects(
        runUsage(["usage", "--days", "0"], { dir }),
        /--days/,
      );
    });
  });

  it("rejects non-numeric --days with VALIDATION_ERROR", async () => {
    await withTempDir({}, async (dir) => {
      await assertValidationRejects(
        runUsage(["usage", "--days", "fortnight"], { dir }),
        /--days/,
      );
    });
  });

  it("rejects a non-integer --days with VALIDATION_ERROR", async () => {
    await withTempDir({}, async (dir) => {
      await assertValidationRejects(
        runUsage(["usage", "--days", "2.5"], { dir }),
        /--days/,
      );
    });
  });

  it("rejects a bare --days with VALIDATION_ERROR", async () => {
    await withTempDir({}, async (dir) => {
      await assertValidationRejects(
        runUsage(["usage", "--days"], { dir }),
        /--days/,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// --provider filter
// ---------------------------------------------------------------------------

describe("usage command — --provider filter", () => {
  it("keeps only the selected provider's rows", async () => {
    await withTempDir({}, async (dir) => {
      await writeLedger(dir, ledgerTwoProviders());
      const { code, stdout } = await runUsage(["usage", "--provider", "zai"], { dir });
      assert.strictEqual(code, 0);
      const report = JSON.parse(stdout);
      assert.deepStrictEqual(
        report.providers.map((p) => p.provider),
        ["zai"],
      );
      assert.strictEqual(report.providers[0].totals.attempts, 3);
    });
  });

  it("a known-but-unrecorded provider yields empty providers and exit 0", async () => {
    await withTempDir({}, async (dir) => {
      await writeLedger(dir, ledgerTwoProviders());
      const { code, stdout, stderr } = await runUsage(["usage", "--provider", "minimax"], { dir });
      assert.strictEqual(code, 0);
      assert.strictEqual(stderr, "");
      const report = JSON.parse(stdout);
      assert.deepStrictEqual(report.providers, []);
    });
  });

  it("an unknown provider id is rejected with the accepted ids listed", async () => {
    await withTempDir({}, async (dir) => {
      await assertValidationRejects(
        runUsage(["usage", "--provider", "nope"], { dir }),
        /nope/,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Fail-open ledger reads (D8: silent on corrupt, never a throw)
// ---------------------------------------------------------------------------

describe("usage command — fail-open reads", () => {
  it("missing ledger → empty providers, exit 0, silent stderr", async () => {
    await withTempDir({}, async (dir) => {
      const { code, stdout, stderr } = await runUsage(["usage"], { dir });
      assert.strictEqual(code, 0);
      assert.strictEqual(stderr, "", "missing ledger never warns");
      const report = JSON.parse(stdout);
      assert.strictEqual(report.schemaVersion, 1);
      assert.deepStrictEqual(report.providers, []);
    });
  });

  it("corrupt JSON → empty providers, exit 0, silent stderr", async () => {
    await withTempDir({}, async (dir) => {
      await fs.writeFile(path.join(dir, "usage.json"), "{definitely not json");
      const { code, stdout, stderr } = await runUsage(["usage"], { dir });
      assert.strictEqual(code, 0);
      assert.strictEqual(stderr, "", "corrupt ledger never warns (D8)");
      assert.deepStrictEqual(JSON.parse(stdout).providers, []);
    });
  });

  it("wrong ledger version → empty providers, exit 0, silent stderr", async () => {
    await withTempDir({}, async (dir) => {
      await writeLedger(dir, { version: 99, days: { "2026-08-16": { zai: { search: c(1, 1, 1) } } } });
      const { code, stdout, stderr } = await runUsage(["usage"], { dir });
      assert.strictEqual(code, 0);
      assert.strictEqual(stderr, "");
      assert.deepStrictEqual(JSON.parse(stdout).providers, []);
    });
  });
});

// ---------------------------------------------------------------------------
// Deterministic ordering
// ---------------------------------------------------------------------------

describe("usage command — deterministic ordering", () => {
  it("sorts providers ascending and capabilities ascending regardless of insertion order", async () => {
    await withTempDir({}, async (dir) => {
      await writeLedger(dir, ledgerUnsorted());
      const { stdout } = await runUsage(["usage"], { dir });
      const report = JSON.parse(stdout);
      assert.deepStrictEqual(
        report.providers.map((p) => p.provider),
        ["brave", "exa", "zai"],
        "providers ascending",
      );
      assert.deepStrictEqual(
        report.providers[2].capabilities.map((row) => row.capabilityId),
        ["crawl", "read", "search"],
        "capabilities ascending",
      );
    });
  });

  it("buildUsageReport is a pure function over its inputs", async () => {
    const ledger = ledgerUnsorted();
    const first = buildUsageReport(ledger, { windowDays: 7, now: fixedNow });
    const second = buildUsageReport(ledger, { windowDays: 7, now: fixedNow });
    assert.deepStrictEqual(first, second);
    assert.deepStrictEqual(ledger, ledgerUnsorted(), "input ledger untouched");
    assert.deepStrictEqual(
      first.providers.map((p) => p.provider),
      ["brave", "exa", "zai"],
    );
  });
});

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

describe("usage command — --help", () => {
  it("prints USAGE_HELP and exits 0", async () => {
    await withTempDir({}, async (dir) => {
      const { code, stdout } = await runUsage(["usage", "--help"], { dir });
      assert.strictEqual(code, 0);
      assert.strictEqual(stdout, USAGE_HELP);
      assert.ok(stdout.includes("scoutline usage"), "help shows the usage line");
      assert.ok(stdout.includes("--days"), "help documents --days");
      assert.ok(stdout.includes("--provider"), "help documents --provider");
      // Ticket 6 wording contract — the docs-pass polish must keep these.
      assert.ok(stdout.includes("usage.json"), "help names the ledger file");
      assert.ok(stdout.includes("SCOUTLINE_CONFIG_DIR"), "help documents the config-dir override");
      assert.ok(stdout.includes("UTC"), "help documents UTC day bucketing");
      assert.ok(stdout.includes("90 days"), "help documents retention");
    });
  });
});

// ---------------------------------------------------------------------------
// Dispatch through main (Ticket 5: dispatch-level, injected deps)
// ---------------------------------------------------------------------------

describe("usage command — dispatch through main", () => {
  it("main(['usage']) returns the envelope with exit 0", async () => {
    await withTempDir({}, async (dir) => {
      await writeLedger(dir, ledgerTwoProviders());
      const { code, stdout, stderr } = await runMain(["usage"], { dir });
      assert.strictEqual(code, 0, `stderr: ${stderr}`);
      const report = JSON.parse(stdout);
      assert.strictEqual(report.windowDays, 7);
      assert.deepStrictEqual(
        report.providers.map((p) => p.provider),
        ["tavily", "zai"],
      );
    });
  });

  it("a pre-command-token --provider is recovered from deps.provider", async () => {
    // extractGlobalOptions strips --provider wherever it appears; the
    // handler must consult deps.provider (same recovery as cache prune).
    await withTempDir({}, async (dir) => {
      await writeLedger(dir, ledgerTwoProviders());
      const { code, stdout } = await runMain(["--provider", "tavily", "usage"], { dir });
      assert.strictEqual(code, 0);
      const report = JSON.parse(stdout);
      assert.deepStrictEqual(
        report.providers.map((p) => p.provider),
        ["tavily"],
      );
    });
  });

  it("main(['usage', '--days', '3']) threads the window through", async () => {
    await withTempDir({}, async (dir) => {
      await writeLedger(dir, ledgerWindowed());
      const { code, stdout } = await runMain(["usage", "--days", "3"], { dir });
      assert.strictEqual(code, 0);
      const report = JSON.parse(stdout);
      assert.strictEqual(report.windowDays, 3);
      // 08-16 + 08-15 only; 08-10 falls outside a 3-day window.
      assert.strictEqual(report.providers[0].totals.attempts, 7);
    });
  });

  it("an unknown --provider exits 1 with a VALIDATION_ERROR stderr envelope", async () => {
    await withTempDir({}, async (dir) => {
      const { code, stdout, stderr } = await runMain(["usage", "--provider", "nope"], { dir });
      assert.strictEqual(code, 1);
      assert.strictEqual(stdout, "");
      const err = JSON.parse(stderr);
      assert.strictEqual(err.success, false);
      assert.strictEqual(err.code, "VALIDATION_ERROR");
      assert.ok(err.error.includes("nope"), `error names the id: ${err.error}`);
    });
  });

  it("main(['usage', '--help']) prints USAGE_HELP with exit 0", async () => {
    await withTempDir({}, async (dir) => {
      const { code, stdout } = await runMain(["usage", "--help"], { dir });
      assert.strictEqual(code, 0);
      assert.strictEqual(stdout, USAGE_HELP);
    });
  });
});

// ---------------------------------------------------------------------------
// CLI surface (subprocess, isolated config dir)
// ---------------------------------------------------------------------------

describe("CLI: scoutline usage", () => {
  it("prints the envelope from the prepared ledger and exits 0", async () => {
    await withTempDir({}, async (dir) => {
      await writeLedger(dir, ledgerTwoProviders());
      const { stdout, stderr, code } = await runProcess(
        ["--output-format", "data", "usage"],
        { configDir: dir, env: {} },
      );
      assert.strictEqual(code, 0, `stderr: ${stderr}`);
      const report = JSON.parse(stdout);
      assert.strictEqual(report.schemaVersion, 1);
      assert.deepStrictEqual(
        report.providers.map((p) => p.provider),
        ["tavily", "zai"],
      );
    });
  });

  it("exits 1 with VALIDATION_ERROR for an unknown --provider", async () => {
    await withTempDir({}, async (dir) => {
      const { stdout, stderr, code } = await runProcess(
        ["usage", "--provider", "nope"],
        { configDir: dir, env: {} },
      );
      assert.strictEqual(code, 1);
      assert.strictEqual(stdout, "");
      const err = JSON.parse(stderr);
      assert.strictEqual(err.success, false);
      assert.strictEqual(err.code, "VALIDATION_ERROR");
      assert.ok(/nope/.test(err.error), `error names the id: ${err.error}`);
    });
  });

  it("reports an empty window with exit 0 when no ledger exists", async () => {
    await withTempDir({}, async (dir) => {
      const { stdout, stderr, code } = await runProcess(
        ["--output-format", "data", "usage"],
        { configDir: dir, env: {} },
      );
      assert.strictEqual(code, 0);
      assert.strictEqual(stderr, "");
      assert.deepStrictEqual(JSON.parse(stdout).providers, []);
    });
  });
});

// ---------------------------------------------------------------------------
// MAIN_HELP lists the usage command (Ticket 6 docs pass)
// ---------------------------------------------------------------------------

describe("CLI: main help lists usage", () => {
  it("scoutline --help mentions usage and points at 'usage --help'", async () => {
    const { stdout, code } = await runProcess(["--help"], { env: {} });
    assert.strictEqual(code, 0);
    assert.ok(/^\s*usage\s+/m.test(stdout), "main help lists the usage command");
    assert.ok(stdout.includes("scoutline usage --help"), "main help points at usage --help");
  });
});
