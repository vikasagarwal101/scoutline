/**
 * Cache command — `scoutline cache stats` and `scoutline cache clear`
 * (Cache Module Unification Ticket 03).
 *
 * Verifies:
 *   - The pure formatting helpers (`formatBytes`, `formatTtl`,
 *     `formatCacheStats`, `formatCacheClear`,
 *     `formatDoctorCacheSummary`).
 *   - The command handlers (`cacheStatsCommand`, `cacheClearCommand`)
 *     return data CommandResults with TTY/compact/markdown/refs
 *     presentation overrides and exit 0 on success.
 *   - The CLI surface (`scoutline cache stats`, `scoutline cache clear`,
 *     `scoutline cache --help`) via subprocess with isolated
 *     `SCOUTLINE_CACHE_DIR`.
 *   - Exit codes: 0 on success, 1 on I/O error.
 *
 * The underlying `cacheStats()` / `clearAllCaches()` behaviour (file
 * I/O, env-var aliasing, directory resolution) is covered by
 * `tests/cache.test.js`. This file covers the command and CLI layer
 * only.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  cacheStatsCommand,
  cacheClearCommand,
  formatBytes,
  formatTtl,
  formatCacheStats,
  formatCacheClear,
  formatDoctorCacheSummary,
} from "../dist/commands/cache.js";
import { runProcess } from "./helpers/run-process.js";

// ---------------------------------------------------------------------------
// Pure formatting helpers
// ---------------------------------------------------------------------------

describe("cache command — formatBytes", () => {
  it("formats sub-KB values in bytes", () => {
    assert.strictEqual(formatBytes(0), "0 B");
    assert.strictEqual(formatBytes(1), "1 B");
    assert.strictEqual(formatBytes(512), "512 B");
    assert.strictEqual(formatBytes(1023), "1023 B");
  });

  it("formats KB and MB with one decimal", () => {
    assert.strictEqual(formatBytes(1024), "1.0 KB");
    assert.strictEqual(formatBytes(8400), "8.2 KB"); // 8400/1024 = 8.203...
    assert.strictEqual(formatBytes(1024 * 1024 * 12.34), "12.3 MB");
  });

  it("scales up to GB and TB", () => {
    assert.strictEqual(formatBytes(1024 * 1024 * 1024 * 3), "3.0 GB");
    assert.strictEqual(formatBytes(1024 * 1024 * 1024 * 1024 * 5), "5.0 TB");
  });

  it("clamps non-finite or negative inputs to 0 B", () => {
    assert.strictEqual(formatBytes(NaN), "0 B");
    assert.strictEqual(formatBytes(-1), "0 B");
    assert.strictEqual(formatBytes(Infinity), "0 B");
  });
});

describe("cache command — formatTtl", () => {
  it("renders whole-hour TTLs with the h suffix", () => {
    assert.strictEqual(formatTtl(60 * 60 * 1000), "1h");
    assert.strictEqual(formatTtl(24 * 60 * 60 * 1000), "24h");
    assert.strictEqual(formatTtl(48 * 60 * 60 * 1000), "48h");
  });

  it("renders whole-minute but sub-hour TTLs with the m suffix", () => {
    assert.strictEqual(formatTtl(5 * 60 * 1000), "5m");
    assert.strictEqual(formatTtl(30 * 60 * 1000), "30m");
  });

  it("renders sub-minute TTLs with the s suffix", () => {
    assert.strictEqual(formatTtl(60_000), "1m");
    assert.strictEqual(formatTtl(45_000), "45s");
    assert.strictEqual(formatTtl(0), "0s");
    assert.strictEqual(formatTtl(-100), "0s");
  });
});

describe("cache command — formatCacheStats (enabled vs disabled)", () => {
  const baseStats = {
    dir: "/tmp/scoutline",
    enabled: true,
    ttlMs: 24 * 60 * 60 * 1000,
    sizeCapBytes: 100 * 1024 * 1024,
    responseCache: { entries: 47, totalBytes: 12.3 * 1024 * 1024 },
    toolCache: { entries: 1, totalBytes: 8400 },
  };

  it("formats an enabled cache exactly per the core-flows artifact", () => {
    const out = formatCacheStats({ ...baseStats });
    assert.strictEqual(
      out,
      [
        "Cache directory: /tmp/scoutline",
        "Status: enabled (TTL 24h, cap 100MB)",
        "",
        "Response cache:",
        "  Entries: 47",
        "  Size: 12.3 MB",
        "",
        "Tool cache:",
        "  Entries: 1",
        "  Size: 8.2 KB",
      ].join("\n"),
    );
  });

  it("renders the disabled-state status line and still reports the inventory", () => {
    const out = formatCacheStats({ ...baseStats, enabled: false });
    assert.ok(out.includes("Status: disabled"), "disabled status present");
    // The dispatcher reads stats regardless of enablement so the
    // operator sees the on-disk inventory from the last-enabled state.
    assert.ok(out.includes("Response cache:"), "response section still present");
    assert.ok(out.includes("Tool cache:"), "tool section still present");
    // The TTL/cap parenthetical must NOT appear on a disabled line.
    assert.ok(!/Status: disabled \(/.test(out), "disabled line has no parenthetical");
  });

  it("rounds the size cap to whole MB to match SCOUTLINE_CACHE_SIZE_MB spelling", () => {
    const out = formatCacheStats({ ...baseStats, sizeCapBytes: 50 * 1024 * 1024 });
    assert.ok(out.includes("cap 50MB"), `expected cap 50MB in:\n${out}`);
  });
});

describe("cache command — formatCacheClear", () => {
  it("pluralizes entries correctly", () => {
    assert.ok(
      formatCacheClear({ responsesCleared: 1, toolsCleared: 1, bytesFreed: 100 }).includes(
        "1 response entry",
      ),
    );
    assert.ok(
      formatCacheClear({ responsesCleared: 1, toolsCleared: 1, bytesFreed: 100 }).includes(
        "1 tool entry",
      ),
    );
    const many = formatCacheClear({
      responsesCleared: 47,
      toolsCleared: 2,
      bytesFreed: 12.3 * 1024 * 1024,
    });
    assert.ok(many.includes("47 response entries"), many);
    assert.ok(many.includes("2 tool entries"), many);
    assert.ok(many.includes("12.3 MB freed"), many);
  });
});

describe("cache command — formatDoctorCacheSummary", () => {
  const baseStats = {
    dir: "/home/u/.scoutline",
    enabled: true,
    ttlMs: 24 * 60 * 60 * 1000,
    sizeCapBytes: 100 * 1024 * 1024,
    responseCache: { entries: 47, totalBytes: 12.3 * 1024 * 1024 },
    toolCache: { entries: 1, totalBytes: 8400 },
  };

  it("formats the one-line enabled summary exactly", () => {
    assert.strictEqual(
      formatDoctorCacheSummary({ ...baseStats }),
      "Cache: enabled, 47 response entries (12.3 MB), 1 tool entry (8.2 KB), /home/u/.scoutline",
    );
  });

  it("formats the disabled summary as 'Cache: disabled'", () => {
    assert.strictEqual(
      formatDoctorCacheSummary({ ...baseStats, enabled: false }),
      "Cache: disabled",
    );
  });
});

// ---------------------------------------------------------------------------
// Command handlers (in-process, with injected deps)
// ---------------------------------------------------------------------------

describe("cache stats command — handler", () => {
  it("returns a data CommandResult carrying the inventory and a TTY presentation", async () => {
    const stats = {
      dir: "/tmp/x",
      enabled: true,
      ttlMs: 24 * 60 * 60 * 1000,
      sizeCapBytes: 100 * 1024 * 1024,
      responseCache: { entries: 3, totalBytes: 2048 },
      toolCache: { entries: 0, totalBytes: 0 },
    };
    const result = await cacheStatsCommand({ getStats: async () => stats });
    assert.strictEqual(result.kind, "data");
    assert.deepStrictEqual(result.data, stats);
    assert.strictEqual(result.presentations.tty, formatCacheStats(stats));
    assert.strictEqual(result.presentations.compact, formatCacheStats(stats));
    assert.strictEqual(result.presentations.markdown, formatCacheStats(stats));
    assert.strictEqual(result.presentations.refs, formatCacheStats(stats));
    // exitCode is undefined; the invocation seam defaults it to 0.
    assert.strictEqual(result.exitCode, undefined);
  });

  it("propagates getStats errors (sanitized at the invocation seam)", async () => {
    const boom = new Error("disk on fire");
    await assert.rejects(
      cacheStatsCommand({
        getStats: async () => {
          throw boom;
        },
      }),
      /disk on fire/,
    );
  });
});

describe("cache clear command — handler", () => {
  it("returns a data CommandResult carrying counts and a TTY presentation", async () => {
    const clear = { responsesCleared: 5, toolsCleared: 1, bytesFreed: 12_000 };
    const result = await cacheClearCommand({ clear: async () => clear });
    assert.strictEqual(result.kind, "data");
    assert.deepStrictEqual(result.data, clear);
    assert.strictEqual(result.presentations.tty, formatCacheClear(clear));
    assert.strictEqual(result.presentations.compact, formatCacheClear(clear));
  });

  it("propagates clear errors", async () => {
    await assert.rejects(
      cacheClearCommand({
        clear: async () => {
          throw new Error("nope");
        },
      }),
      /nope/,
    );
  });
});

// ---------------------------------------------------------------------------
// CLI surface (subprocess against the real dispatcher)
// ---------------------------------------------------------------------------

const BASE_ENV = { Z_AI_API_KEY: "cache-test-key" };

/**
 * Create a temp cache directory, populate both subdirectories, and run
 * `scoutline cache ...` against it through SCOUTLINE_CACHE_DIR.
 *
 * Returns the directory path so the caller can assert against it. The
 * caller is responsible for cleanup.
 */
async function makePopulatedCacheDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scoutline-cache-cmd-"));
  await fs.mkdir(path.join(dir, "cache"), { recursive: true });
  await fs.mkdir(path.join(dir, "tools"), { recursive: true });
  await fs.writeFile(path.join(dir, "cache", "a.json"), JSON.stringify({ ts: 1, data: {} }));
  await fs.writeFile(path.join(dir, "cache", "b.json"), JSON.stringify({ ts: 2, data: {} }));
  await fs.writeFile(path.join(dir, "tools", "tools-deadbeef.json"), "{}");
  return dir;
}

describe("CLI: scoutline cache --help", () => {
  it("lists both subcommands and exits 0 on stdout", async () => {
    const { stdout, stderr, code } = await runProcess(["cache", "--help"], { env: BASE_ENV });
    assert.strictEqual(code, 0);
    assert.strictEqual(stderr, "");
    assert.ok(stdout.includes("stats"), "help mentions stats");
    assert.ok(stdout.includes("clear"), "help mentions clear");
    assert.ok(stdout.includes("scoutline cache stats"), "help shows stats usage");
    assert.ok(stdout.includes("scoutline cache clear"), "help shows clear usage");
    assert.ok(stdout.includes("SCOUTLINE_CACHE_DIR"), "help documents the override env");
  });

  it("prints help when no subcommand is given (mirrors tools/repo/etc.)", async () => {
    const { stdout, code } = await runProcess(["cache"], { env: BASE_ENV });
    assert.strictEqual(code, 0);
    assert.ok(stdout.includes("scoutline cache stats"));
  });
});

describe("CLI: scoutline cache stats", () => {
  it("prints the formatted output with both cache sections in TTY mode", async () => {
    const dir = await makePopulatedCacheDir();
    try {
      const { stdout, stderr, code } = await runProcess(
        ["--output-format", "tty", "cache", "stats"],
        {
          env: { ...BASE_ENV, SCOUTLINE_CACHE_DIR: dir },
        },
      );
      assert.strictEqual(code, 0);
      assert.strictEqual(stderr, "");
      assert.ok(stdout.includes(`Cache directory: ${dir}`), "directory line present");
      assert.ok(stdout.includes("Status: enabled"), "enabled status present");
      assert.ok(stdout.includes("Response cache:"), "response section present");
      assert.ok(stdout.includes("Tool cache:"), "tool section present");
      assert.ok(stdout.includes("Entries: 2"), "response entry count is 2");
      assert.ok(stdout.includes("Entries: 1"), "tool entry count is 1");
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("emits raw JSON in data mode with the nested responseCache/toolCache shape", async () => {
    const dir = await makePopulatedCacheDir();
    try {
      const { stdout, code } = await runProcess(["--output-format", "data", "cache", "stats"], {
        env: { ...BASE_ENV, SCOUTLINE_CACHE_DIR: dir },
      });
      assert.strictEqual(code, 0);
      const parsed = JSON.parse(stdout);
      assert.strictEqual(parsed.dir, dir);
      assert.strictEqual(parsed.enabled, true);
      assert.strictEqual(parsed.responseCache.entries, 2);
      assert.strictEqual(parsed.toolCache.entries, 1);
      assert.ok(parsed.responseCache.totalBytes > 0);
      assert.ok(parsed.toolCache.totalBytes > 0);
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("reports the disabled-state status when SCOUTLINE_CACHE=0", async () => {
    const dir = await makePopulatedCacheDir();
    try {
      const { stdout, code } = await runProcess(["--output-format", "tty", "cache", "stats"], {
        env: { ...BASE_ENV, SCOUTLINE_CACHE_DIR: dir, SCOUTLINE_CACHE: "0" },
      });
      assert.strictEqual(code, 0);
      assert.ok(stdout.includes("Status: disabled"), "disabled status surfaced");
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("reports zeros for an empty cache directory without error", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scoutline-cache-empty-"));
    try {
      const { stdout, code } = await runProcess(["--output-format", "tty", "cache", "stats"], {
        env: { ...BASE_ENV, SCOUTLINE_CACHE_DIR: dir },
      });
      assert.strictEqual(code, 0);
      assert.ok(stdout.includes("Entries: 0"), "zero entries reported");
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
});

describe("CLI: scoutline cache clear", () => {
  it("clears both subdirectories, preserves the directory shells, and reports freed bytes", async () => {
    const dir = await makePopulatedCacheDir();
    try {
      const { stdout, stderr, code } = await runProcess(
        ["--output-format", "tty", "cache", "clear"],
        {
          env: { ...BASE_ENV, SCOUTLINE_CACHE_DIR: dir },
        },
      );
      assert.strictEqual(code, 0);
      assert.strictEqual(stderr, "");
      assert.ok(stdout.includes("Cleared"), "summary line present");
      assert.ok(/2 response entr(y|ies)/.test(stdout), `response count in: ${stdout}`);
      assert.ok(/1 tool entr(y|ies)/.test(stdout), `tool count in: ${stdout}`);
      assert.ok(/freed/.test(stdout), "freed bytes mentioned");

      // cache/ and tools/ are now empty but the directories themselves
      // still exist (no directory-creation race on the next invocation).
      const cacheLeft = await fs.readdir(path.join(dir, "cache"));
      const toolsLeft = await fs.readdir(path.join(dir, "tools"));
      assert.deepStrictEqual(cacheLeft, [], "cache/ is empty");
      assert.deepStrictEqual(toolsLeft, [], "tools/ is empty");
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("emits the structured counts in data mode", async () => {
    const dir = await makePopulatedCacheDir();
    try {
      const { stdout, code } = await runProcess(["--output-format", "data", "cache", "clear"], {
        env: { ...BASE_ENV, SCOUTLINE_CACHE_DIR: dir },
      });
      assert.strictEqual(code, 0);
      const parsed = JSON.parse(stdout);
      assert.strictEqual(parsed.responsesCleared, 2);
      assert.strictEqual(parsed.toolsCleared, 1);
      assert.ok(parsed.bytesFreed > 0);
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("reports zero counts and exit 0 when there is nothing to clear", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scoutline-cache-clearempty-"));
    try {
      const { stdout, code } = await runProcess(["--output-format", "tty", "cache", "clear"], {
        env: { ...BASE_ENV, SCOUTLINE_CACHE_DIR: dir },
      });
      assert.strictEqual(code, 0);
      assert.ok(/0 response entr(y|ies)/.test(stdout), `zero responses in: ${stdout}`);
      assert.ok(/0 tool entr(y|ies)/.test(stdout), `zero tools in: ${stdout}`);
      assert.ok(/0 B freed/.test(stdout), "zero bytes freed reported");
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
});

describe("CLI: scoutline cache <unknown>", () => {
  it("exits 1 with VALIDATION_ERROR on stderr for an unknown subcommand", async () => {
    const { stdout, stderr, code } = await runProcess(["cache", "nope"], { env: BASE_ENV });
    assert.strictEqual(code, 1);
    assert.strictEqual(stdout, "");
    const err = JSON.parse(stderr);
    assert.strictEqual(err.success, false);
    assert.strictEqual(err.code, "VALIDATION_ERROR");
    assert.ok(err.error.includes("Unknown cache command: nope"));
  });
});

// ---------------------------------------------------------------------------
// MAIN_HELP lists the cache command
// ---------------------------------------------------------------------------

describe("CLI: main help lists cache", () => {
  it("scoutline --help mentions cache and points at 'cache --help'", async () => {
    const { stdout, code } = await runProcess(["--help"], { env: BASE_ENV });
    assert.strictEqual(code, 0);
    assert.ok(/^\s*cache\s+/m.test(stdout), "main help lists the cache command");
    assert.ok(stdout.includes("scoutline cache --help"), "main help points at cache --help");
  });
});

// ---------------------------------------------------------------------------
// Doctor picks up the cache summary at the CLI layer
// ---------------------------------------------------------------------------

describe("CLI: doctor embeds the one-line cache summary", () => {
  it("scoutline doctor --no-tools output contains the formatted Cache: line", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scoutline-doctor-cache-"));
    try {
      const { stdout, code } = await runProcess(
        ["doctor", "--no-tools", "--output-format", "data"],
        {
          env: { ...BASE_ENV, SCOUTLINE_CACHE_DIR: dir },
        },
      );
      assert.strictEqual(code, 0);
      const parsed = JSON.parse(stdout);
      assert.ok(parsed.cache, "report carries the cache field");
      assert.ok(
        parsed.cache.summary.startsWith("Cache: "),
        `summary starts with 'Cache: ': ${parsed.cache.summary}`,
      );
      assert.ok(
        parsed.cache.summary.includes(dir),
        `summary includes the cache dir: ${parsed.cache.summary}`,
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
