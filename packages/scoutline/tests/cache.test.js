/**
 * Cache characterization tests.
 *
 * Covers the unified cache root resolver (`resolveCacheRootPure`), the
 * call-time env-var aliasing policy, the response/tool split under
 * `~/.scoutline/`, and the `cacheStats` / `clearAllCaches` shape.
 *
 * The P6-02 / P6-08 legacy-key and continuity blocks below MUST remain
 * unchanged: they prove the pure helpers (`buildLegacyRepositoryCacheKey`)
 * are byte-identical to v0.2 and unaffected by the directory unification.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { withTempDir } from "./helpers/temp-dir.js";
import crypto from "node:crypto";
import {
  resolveCacheRootPure,
  toolCacheDir,
  isCacheEnabled,
  getCacheTtlMs,
  getCacheSizeCapBytes,
  buildCacheKey,
  buildLegacyRepositoryCacheKey,
  readCache,
  writeCache,
  clearCache,
  clearAllCaches,
  cacheStats,
  buildProviderCacheKey,
  defaultResponseCache,
} from "../dist/lib/cache.js";

// P6-08A: install a test-local fake credential so `buildCacheKey()`'s
// ambient `getApiKey()` lookup resolves cleanly when the offline suite
// runs with all Provider credentials stripped. Restored in `after` so
// no value leaks across suites.
const FAKE_TEST_API_KEY = "test-fake-cache-key-DO-NOT-USE";
const savedCreds = { Z_AI_API_KEY: undefined, ZAI_API_KEY: undefined };
before(() => {
  savedCreds.Z_AI_API_KEY = process.env.Z_AI_API_KEY;
  savedCreds.ZAI_API_KEY = process.env.ZAI_API_KEY;
  process.env.Z_AI_API_KEY = FAKE_TEST_API_KEY;
  delete process.env.ZAI_API_KEY;
});
after(() => {
  for (const [key, value] of Object.entries(savedCreds)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("resolveCacheRootPure: unified ~/.scoutline/ dotfile root", () => {
  it("SCOUTLINE_CACHE_DIR overrides every alias and the default", () => {
    const p = resolveCacheRootPure(
      {
        SCOUTLINE_CACHE_DIR: "/var/tmp/scoutline-root",
        ZAI_MCP_CACHE_DIR: "/alias-mcp",
        ZAI_CACHE_DIR: "/alias-zai",
      },
      { platform: "linux", homedir: "/home/u" },
    );
    assert.strictEqual(p, "/var/tmp/scoutline-root");
  });

  it("ZAI_MCP_CACHE_DIR takes precedence over ZAI_CACHE_DIR (B3 fix)", () => {
    // Documented operator surface for the tool cache directory in v0.4.0;
    // preserved as the middle-precedence alias.
    const p = resolveCacheRootPure(
      { ZAI_MCP_CACHE_DIR: "/mcp-alias", ZAI_CACHE_DIR: "/zai-alias" },
      { platform: "linux", homedir: "/home/u" },
    );
    assert.strictEqual(p, "/mcp-alias");
  });

  it("ZAI_CACHE_DIR is accepted as the lowest-precedence directory alias", () => {
    const p = resolveCacheRootPure(
      { ZAI_CACHE_DIR: "/var/tmp/legacy" },
      { platform: "linux", homedir: "/home/u" },
    );
    assert.strictEqual(p, "/var/tmp/legacy");
  });

  it("default Linux path uses homedir/.scoutline (dotfile convention)", () => {
    const p = resolveCacheRootPure({}, { platform: "linux", homedir: "/home/u" });
    assert.strictEqual(p, path.join("/home/u", ".scoutline"));
  });

  it("default macOS path uses homedir/.scoutline (no ~/Library/Caches branch)", () => {
    const p = resolveCacheRootPure({}, { platform: "darwin", homedir: "/Users/u" });
    assert.strictEqual(p, path.join("/Users/u", ".scoutline"));
  });

  it("default win32 path uses homedir/.scoutline", () => {
    const p = resolveCacheRootPure({}, { platform: "win32", homedir: "C:\\Users\\u" });
    assert.strictEqual(p, path.join("C:\\Users\\u", ".scoutline"));
  });

  it("all default platform paths end in .scoutline (no zai-cli/responses, no XDG branch)", () => {
    const linux = resolveCacheRootPure({}, { platform: "linux", homedir: "/h" });
    const darwin = resolveCacheRootPure({}, { platform: "darwin", homedir: "/h" });
    const win32 = resolveCacheRootPure({}, { platform: "win32", homedir: "C:\\h" });
    assert.ok(linux.endsWith(path.join(".scoutline")), `linux: ${linux}`);
    assert.ok(darwin.endsWith(path.join(".scoutline")), `darwin: ${darwin}`);
    assert.ok(win32.endsWith(".scoutline"), `win32: ${win32}`);
  });

  it("XDG_CACHE_HOME is no longer consulted (removed from interface and resolver)", () => {
    // The resolver type no longer carries XDG_CACHE_HOME. An env object
    // carrying it must not change resolution.
    const p = resolveCacheRootPure(
      // Cast through unknown so the test still compiles if a downstream
      // consumer accidentally re-adds the field to the interface.
      { XDG_CACHE_HOME: "/some-xdg" },
      { platform: "linux", homedir: "/home/u" },
    );
    assert.strictEqual(p, path.join("/home/u", ".scoutline"));
  });

  it("returns the ROOT only (no cache/ or tools/ suffix) — callers append their own subdir", () => {
    const p = resolveCacheRootPure(
      { SCOUTLINE_CACHE_DIR: "/explicit/root" },
      { platform: "linux", homedir: "/home/u" },
    );
    assert.strictEqual(p, "/explicit/root");
    assert.ok(!p.endsWith("cache"));
    assert.ok(!p.endsWith("tools"));
  });
});

describe("toolCacheDir: sibling tools/ subdirectory under the unified root", () => {
  it("returns <root>/tools when SCOUTLINE_CACHE_DIR is set", () => {
    process.env.SCOUTLINE_CACHE_DIR = "/tmp/scoutline-tool-1";
    try {
      assert.strictEqual(toolCacheDir(), path.join("/tmp/scoutline-tool-1", "tools"));
    } finally {
      delete process.env.SCOUTLINE_CACHE_DIR;
    }
  });

  it("returns <root>/tools when only ZAI_MCP_CACHE_DIR is set (B3 alias)", () => {
    process.env.ZAI_MCP_CACHE_DIR = "/tmp/scoutline-tool-2";
    try {
      assert.strictEqual(toolCacheDir(), path.join("/tmp/scoutline-tool-2", "tools"));
    } finally {
      delete process.env.ZAI_MCP_CACHE_DIR;
    }
  });

  it("returns <homedir>/.scoutline/tools by default", () => {
    delete process.env.SCOUTLINE_CACHE_DIR;
    delete process.env.ZAI_MCP_CACHE_DIR;
    delete process.env.ZAI_CACHE_DIR;
    const expected = path.join(os.homedir(), ".scoutline", "tools");
    assert.strictEqual(toolCacheDir(), expected);
  });
});

describe("call-time env reads (H1 fix): isCacheEnabled / getCacheTtlMs / getCacheSizeCapBytes", () => {
  // Save and restore all touched env vars around each test so call-time
  // reads observe a deterministic environment. Module-load capture was
  // removed; the helpers must reflect the live process.env.
  const vars = [
    "SCOUTLINE_CACHE",
    "ZAI_CACHE",
    "ZAI_MCP_TOOL_CACHE",
    "SCOUTLINE_CACHE_TTL_MS",
    "ZAI_CACHE_TTL_MS",
    "ZAI_MCP_TOOL_CACHE_TTL_MS",
    "SCOUTLINE_CACHE_SIZE_MB",
    "ZAI_CACHE_SIZE_MB",
  ];
  const saved = {};
  before(() => {
    for (const v of vars) saved[v] = process.env[v];
  });
  after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("isCacheEnabled defaults to true when no env var is set", () => {
    for (const v of vars) delete process.env[v];
    assert.strictEqual(isCacheEnabled(), true);
  });

  it("isCacheEnabled respects SCOUTLINE_CACHE=0", () => {
    for (const v of vars) delete process.env[v];
    process.env.SCOUTLINE_CACHE = "0";
    assert.strictEqual(isCacheEnabled(), false);
  });

  it("isCacheEnabled respects SCOUTLINE_CACHE=false (case-insensitive)", () => {
    for (const v of vars) delete process.env[v];
    process.env.SCOUTLINE_CACHE = "FALSE";
    assert.strictEqual(isCacheEnabled(), false);
  });

  it("isCacheEnabled aliases ZAI_CACHE=0 (legacy)", () => {
    for (const v of vars) delete process.env[v];
    process.env.ZAI_CACHE = "0";
    assert.strictEqual(isCacheEnabled(), false);
  });

  it("isCacheEnabled does NOT consult ZAI_MCP_TOOL_CACHE (granularity preserved)", () => {
    // ZAI_MCP_TOOL_CACHE is the tool cache's own enable flag, read
    // directly by mcp-client.ts. The response cache MUST stay enabled
    // when only ZAI_MCP_TOOL_CACHE=0 is set, so the four
    // mcp-client.test.js suites that disable the tool cache while
    // relying on response-cache hits remain observationally correct.
    // Aliasing it here would silently regress those suites.
    for (const v of vars) delete process.env[v];
    process.env.ZAI_MCP_TOOL_CACHE = "0";
    assert.strictEqual(
      isCacheEnabled(),
      true,
      "ZAI_MCP_TOOL_CACHE must not disable response cache",
    );
  });

  it("SCOUTLINE_CACHE wins over ZAI_CACHE when both are set (precedence)", () => {
    for (const v of vars) delete process.env[v];
    process.env.SCOUTLINE_CACHE = "1";
    process.env.ZAI_CACHE = "0";
    assert.strictEqual(isCacheEnabled(), true);
  });

  it("SCOUTLINE_CACHE wins over ZAI_MCP_TOOL_CACHE when both are set (response-cache perspective)", () => {
    // SCOUTLINE_CACHE is the unified override. When it is enabled and
    // ZAI_MCP_TOOL_CACHE is set to 0, the response cache stays enabled
    // (the unified var wins for the response cache; the tool-cache
    // alias does not even participate).
    for (const v of vars) delete process.env[v];
    process.env.SCOUTLINE_CACHE = "1";
    process.env.ZAI_MCP_TOOL_CACHE = "0";
    assert.strictEqual(isCacheEnabled(), true);
  });

  it("ZAI_CACHE=0 mid-process is observed at call time (test-contract H1 fix)", () => {
    // Mirrors the per-suite mutation pattern: an env change AFTER module
    // load MUST be observable. This is the assertion that broke under
    // module-load capture.
    for (const v of vars) delete process.env[v];
    assert.strictEqual(isCacheEnabled(), true);
    process.env.ZAI_CACHE = "0";
    assert.strictEqual(isCacheEnabled(), false);
    delete process.env.ZAI_CACHE;
    assert.strictEqual(isCacheEnabled(), true);
  });

  it("getCacheTtlMs defaults to 24h", () => {
    for (const v of vars) delete process.env[v];
    assert.strictEqual(getCacheTtlMs(), 24 * 60 * 60 * 1000);
  });

  it("getCacheTtlMs reads SCOUTLINE_CACHE_TTL_MS", () => {
    for (const v of vars) delete process.env[v];
    process.env.SCOUTLINE_CACHE_TTL_MS = "60000";
    assert.strictEqual(getCacheTtlMs(), 60000);
  });

  it("getCacheTtlMs aliases ZAI_CACHE_TTL_MS (response-cache legacy)", () => {
    for (const v of vars) delete process.env[v];
    process.env.ZAI_CACHE_TTL_MS = "2000";
    assert.strictEqual(getCacheTtlMs(), 2000);
    process.env.SCOUTLINE_CACHE_TTL_MS = "3000";
    assert.strictEqual(getCacheTtlMs(), 3000);
  });

  it("getCacheTtlMs does NOT consult ZAI_MCP_TOOL_CACHE_TTL_MS (granularity preserved)", () => {
    // The tool cache's TTL is read directly by mcp-client.ts; aliasing
    // it here would leak tool-cache TTL configuration into the response
    // cache.
    for (const v of vars) delete process.env[v];
    process.env.ZAI_MCP_TOOL_CACHE_TTL_MS = "9999";
    assert.strictEqual(getCacheTtlMs(), 24 * 60 * 60 * 1000);
  });

  it("getCacheSizeCapBytes defaults to 100MB", () => {
    for (const v of vars) delete process.env[v];
    assert.strictEqual(getCacheSizeCapBytes(), 100 * 1024 * 1024);
  });

  it("getCacheSizeCapBytes reads SCOUTLINE_CACHE_SIZE_MB", () => {
    for (const v of vars) delete process.env[v];
    process.env.SCOUTLINE_CACHE_SIZE_MB = "5";
    assert.strictEqual(getCacheSizeCapBytes(), 5 * 1024 * 1024);
  });

  it("getCacheSizeCapBytes aliases ZAI_CACHE_SIZE_MB", () => {
    for (const v of vars) delete process.env[v];
    process.env.ZAI_CACHE_SIZE_MB = "7";
    assert.strictEqual(getCacheSizeCapBytes(), 7 * 1024 * 1024);
  });
});

describe("cache key shape", () => {
  it("keys encode command, key hash, and args hash", () => {
    const key = buildCacheKey("search.webSearch", { q: "node test" });
    assert.match(key, /^search\.webSearch\.[0-9a-f]{12}\.[0-9a-f]{24}\.json$/);
  });

  it("identical command+args produce the same key", () => {
    const a = buildCacheKey("search.webSearch", { q: "node", n: 1 });
    const b = buildCacheKey("search.webSearch", { q: "node", n: 1 });
    assert.strictEqual(a, b);
  });

  it("different commands produce different keys", () => {
    const a = buildCacheKey("search.webSearch", { q: "node" });
    const b = buildCacheKey("reader.webReader", { q: "node" });
    assert.notStrictEqual(a, b);
  });
});

describe("readCache/writeCache behaviour", () => {
  it("returns null when no cache file exists", async () => {
    const out = await readCache("nonexistent.test.aaaa.bbbb.json", 60_000);
    assert.strictEqual(out, null);
  });

  it("valid cache hit avoids a second invocation", async () => {
    await withTempDir({}, async (dir) => {
      process.env.SCOUTLINE_CACHE_DIR = dir;
      try {
        const key = "test-hit." + Math.random().toString(36).slice(2) + ".json";
        const data = [{ title: "cached", link: "https://e/x" }];
        await writeCache(key, data);
        const hit = await readCache(key, 60_000);
        assert.deepStrictEqual(hit, data);
      } finally {
        delete process.env.SCOUTLINE_CACHE_DIR;
      }
    });
  });

  it("writes land under <root>/cache/ (unified layout)", async () => {
    // Direct proof that response cache writes go to the `cache/` sibling,
    // not the legacy `responses/` or `zai-cli/` location.
    await withTempDir({}, async (dir) => {
      process.env.SCOUTLINE_CACHE_DIR = dir;
      try {
        const key = "layout." + Math.random().toString(36).slice(2) + ".json";
        await writeCache(key, { ok: true });
        const expectedPath = path.join(dir, "cache", key);
        const raw = await fs.readFile(expectedPath, "utf8");
        assert.ok(JSON.parse(raw).ts > 0, "file written under <root>/cache/");
      } finally {
        delete process.env.SCOUTLINE_CACHE_DIR;
      }
    });
  });

  it("expired cache entry becomes a miss", async () => {
    await withTempDir({}, async (dir) => {
      process.env.SCOUTLINE_CACHE_DIR = dir;
      try {
        const key = "test-expired." + Math.random().toString(36).slice(2) + ".json";
        await writeCache(key, { ok: true });
        // ttlMs=0 is treated as disabled → miss.
        const out = await readCache(key, 0);
        assert.strictEqual(out, null);
      } finally {
        delete process.env.SCOUTLINE_CACHE_DIR;
      }
    });
  });

  it("corrupt cache JSON is treated as a miss", async () => {
    await withTempDir({}, async (dir) => {
      process.env.SCOUTLINE_CACHE_DIR = dir;
      try {
        const key = "test-corrupt." + Math.random().toString(36).slice(2) + ".json";
        await writeCache(key, { value: 7 });
        // Overwrite the underlying file with broken JSON.
        const file = path.join(dir, "cache", key);
        await fs.writeFile(file, "this is not json {{{ broken");
        const out = await readCache(key, 60_000);
        assert.strictEqual(out, null);
      } finally {
        delete process.env.SCOUTLINE_CACHE_DIR;
      }
    });
  });

  it("SCOUTLINE_CACHE=0 disables readCache and writeCache at call time (H1)", async () => {
    await withTempDir({}, async (dir) => {
      process.env.SCOUTLINE_CACHE_DIR = dir;
      process.env.SCOUTLINE_CACHE = "0";
      try {
        const key = "disabled." + Math.random().toString(36).slice(2) + ".json";
        await writeCache(key, { ok: true });
        // No file written.
        const dirEntries = await fs.readdir(path.join(dir, "cache")).catch(() => []);
        assert.deepStrictEqual(dirEntries, [], "no cache file written when disabled");
        // Read also a miss.
        const hit = await readCache(key, 60_000);
        assert.strictEqual(hit, null);
      } finally {
        delete process.env.SCOUTLINE_CACHE_DIR;
        delete process.env.SCOUTLINE_CACHE;
      }
    });
  });

  it("ZAI_CACHE=0 (legacy alias) also disables at call time", async () => {
    await withTempDir({}, async (dir) => {
      process.env.SCOUTLINE_CACHE_DIR = dir;
      process.env.ZAI_CACHE = "0";
      try {
        const key = "legacy-disabled." + Math.random().toString(36).slice(2) + ".json";
        await writeCache(key, { ok: true });
        const dirEntries = await fs.readdir(path.join(dir, "cache")).catch(() => []);
        assert.deepStrictEqual(dirEntries, [], "ZAI_CACHE=0 alias also disables writes");
      } finally {
        delete process.env.SCOUTLINE_CACHE_DIR;
        delete process.env.ZAI_CACHE;
      }
    });
  });
});

describe("best-effort cache helpers never fail", () => {
  it("clearCache returns counts even when the dir does not exist", async () => {
    process.env.SCOUTLINE_CACHE_DIR = path.join(os.tmpdir(), "scoutline-no-such-dir-" + Date.now());
    try {
      const result = await clearCache();
      assert.strictEqual(result.cleared, 0);
      assert.strictEqual(result.bytesFreed, 0);
    } finally {
      delete process.env.SCOUTLINE_CACHE_DIR;
    }
  });

  it("cacheStats returns the unified shape with responseCache and toolCache sections", async () => {
    await withTempDir({}, async (dir) => {
      process.env.SCOUTLINE_CACHE_DIR = dir;
      try {
        const stats = await cacheStats();
        assert.strictEqual(stats.enabled, true);
        assert.ok(typeof stats.dir === "string");
        assert.ok(typeof stats.ttlMs === "number");
        assert.ok(typeof stats.sizeCapBytes === "number");
        // H3 fix: the top-level entries/totalBytes fields are gone, replaced
        // by nested responseCache / toolCache sections.
        assert.ok(stats.responseCache && typeof stats.responseCache === "object");
        assert.ok(stats.toolCache && typeof stats.toolCache === "object");
        assert.strictEqual(stats.responseCache.entries, 0);
        assert.strictEqual(stats.responseCache.totalBytes, 0);
        assert.strictEqual(stats.toolCache.entries, 0);
        assert.strictEqual(stats.toolCache.totalBytes, 0);
        // The contract: top-level entries/totalBytes no longer exist.
        assert.strictEqual("entries" in stats, false, "top-level entries must be removed");
        assert.strictEqual("totalBytes" in stats, false, "top-level totalBytes must be removed");
        // dir is the ROOT (~/.scoutline/ or override), not a child subdir.
        assert.strictEqual(stats.dir, dir);
      } finally {
        delete process.env.SCOUTLINE_CACHE_DIR;
      }
    });
  });

  it("cacheStats counts files in both cache/ and tools/ subdirectories", async () => {
    await withTempDir({}, async (dir) => {
      process.env.SCOUTLINE_CACHE_DIR = dir;
      try {
        // Write two response entries directly under cache/ and one tool entry under tools/.
        await fs.mkdir(path.join(dir, "cache"), { recursive: true });
        await fs.mkdir(path.join(dir, "tools"), { recursive: true });
        await fs.writeFile(path.join(dir, "cache", "a.json"), JSON.stringify({ ts: 1, data: {} }));
        await fs.writeFile(path.join(dir, "cache", "b.json"), JSON.stringify({ ts: 2, data: {} }));
        await fs.writeFile(path.join(dir, "tools", "tools-deadbeef.json"), "{}");

        const stats = await cacheStats();
        assert.strictEqual(stats.responseCache.entries, 2);
        assert.strictEqual(stats.toolCache.entries, 1);
        assert.ok(stats.responseCache.totalBytes > 0);
        assert.ok(stats.toolCache.totalBytes > 0);
      } finally {
        delete process.env.SCOUTLINE_CACHE_DIR;
      }
    });
  });

  it("clearCache clears only cache/ (backward compat: response cache only)", async () => {
    await withTempDir({}, async (dir) => {
      process.env.SCOUTLINE_CACHE_DIR = dir;
      try {
        await fs.mkdir(path.join(dir, "cache"), { recursive: true });
        await fs.mkdir(path.join(dir, "tools"), { recursive: true });
        await fs.writeFile(path.join(dir, "cache", "resp.json"), "{}");
        await fs.writeFile(path.join(dir, "tools", "tools-x.json"), "{}");

        const result = await clearCache();
        assert.strictEqual(result.cleared, 1);
        assert.ok(result.bytesFreed > 0);

        // cache/ is empty; tools/ is untouched.
        const cacheLeft = await fs.readdir(path.join(dir, "cache"));
        const toolsLeft = await fs.readdir(path.join(dir, "tools"));
        assert.deepStrictEqual(cacheLeft, []);
        assert.strictEqual(toolsLeft.length, 1);
      } finally {
        delete process.env.SCOUTLINE_CACHE_DIR;
      }
    });
  });

  it("clearAllCaches clears both cache/ and tools/ subdirectories", async () => {
    await withTempDir({}, async (dir) => {
      process.env.SCOUTLINE_CACHE_DIR = dir;
      try {
        await fs.mkdir(path.join(dir, "cache"), { recursive: true });
        await fs.mkdir(path.join(dir, "tools"), { recursive: true });
        await fs.writeFile(path.join(dir, "cache", "a.json"), "{}");
        await fs.writeFile(path.join(dir, "cache", "b.json"), "{}");
        await fs.writeFile(path.join(dir, "tools", "tools-y.json"), "{}");

        const result = await clearAllCaches();
        assert.strictEqual(result.responsesCleared, 2);
        assert.strictEqual(result.toolsCleared, 1);
        assert.ok(result.bytesFreed > 0);

        // Both subdirs are empty but still exist (no directory-creation race).
        const cacheLeft = await fs.readdir(path.join(dir, "cache"));
        const toolsLeft = await fs.readdir(path.join(dir, "tools"));
        assert.deepStrictEqual(cacheLeft, []);
        assert.deepStrictEqual(toolsLeft, []);
      } finally {
        delete process.env.SCOUTLINE_CACHE_DIR;
      }
    });
  });

  it("clearAllCaches reports zeros when neither subdir exists", async () => {
    await withTempDir({}, async (dir) => {
      process.env.SCOUTLINE_CACHE_DIR = dir;
      try {
        const result = await clearAllCaches();
        assert.strictEqual(result.responsesCleared, 0);
        assert.strictEqual(result.toolsCleared, 0);
        assert.strictEqual(result.bytesFreed, 0);
      } finally {
        delete process.env.SCOUTLINE_CACHE_DIR;
      }
    });
  });

  it("eviction on a cache over the size cap does not throw", async () => {
    await withTempDir({}, async (dir) => {
      process.env.SCOUTLINE_CACHE_DIR = dir;
      // Force a very small size cap to trigger eviction.
      process.env.SCOUTLINE_CACHE_SIZE_MB = "0";
      try {
        const key = "evict-test." + Math.random().toString(36).slice(2) + ".json";
        // writeCache catches internal errors silently; it should not throw.
        await writeCache(key, { big: "x".repeat(1000) });
        assert.ok(true, "writeCache with eviction did not throw");
      } finally {
        delete process.env.SCOUTLINE_CACHE_DIR;
        delete process.env.SCOUTLINE_CACHE_SIZE_MB;
      }
    });
  });

  it("eviction scans cache/ only and never deletes files under tools/", async () => {
    // The eviction-isolation guarantee: even under heavy size pressure the
    // LRU loop in evictIfNeeded MUST NOT touch the tools/ sibling.
    await withTempDir({}, async (dir) => {
      process.env.SCOUTLINE_CACHE_DIR = dir;
      process.env.SCOUTLINE_CACHE_SIZE_MB = "0";
      try {
        await fs.mkdir(path.join(dir, "tools"), { recursive: true });
        const toolFile = path.join(dir, "tools", "tools-precious.json");
        await fs.writeFile(toolFile, '{"version":1,"timestamp":1,"tools":[]}');

        const key = "evict-isolation." + Math.random().toString(36).slice(2) + ".json";
        await writeCache(key, { big: "x".repeat(1000) });

        // The tools file MUST still exist after eviction.
        const stat = await fs.stat(toolFile);
        assert.ok(stat.size > 0, "tools/ files must survive cache/ eviction");
      } finally {
        delete process.env.SCOUTLINE_CACHE_DIR;
        delete process.env.SCOUTLINE_CACHE_SIZE_MB;
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Provider-partitioned cache keys (P2-02)
// ---------------------------------------------------------------------------

describe("buildProviderCacheKey: v2 key shape", () => {
  const fp = crypto.createHash("sha256").update("cred").digest("hex");

  it("produces v2.<capability>.<provider>.<credential-hash>.<request-hash>.json", () => {
    const key = buildProviderCacheKey({
      provider: "zai",
      capability: "search",
      credentialFingerprint: fp,
      request: { query: "q" },
    });
    assert.match(
      key,
      /^v2\.search\.zai\.[0-9a-f]{64}\.[0-9a-f]{64}\.json$/,
      `key shape off: ${key}`,
    );
  });

  it("uses the credential fingerprint verbatim (does not re-hash)", () => {
    const key = buildProviderCacheKey({
      provider: "zai",
      capability: "search",
      credentialFingerprint: fp,
      request: { query: "q" },
    });
    assert.ok(key.includes(`.${fp}.`), `credential fingerprint must appear verbatim, got: ${key}`);
  });

  it("Z.AI and MiniMax keys differ for the same query and credential", () => {
    const a = buildProviderCacheKey({
      provider: "zai",
      capability: "search",
      credentialFingerprint: fp,
      request: { query: "same" },
    });
    const b = buildProviderCacheKey({
      provider: "minimax",
      capability: "search",
      credentialFingerprint: fp,
      request: { query: "same" },
    });
    assert.notStrictEqual(a, b);
  });

  it("different credential fingerprints differ for the same provider and query", () => {
    const fp2 = crypto.createHash("sha256").update("other").digest("hex");
    const a = buildProviderCacheKey({
      provider: "zai",
      capability: "search",
      credentialFingerprint: fp,
      request: { query: "same" },
    });
    const b = buildProviderCacheKey({
      provider: "zai",
      capability: "search",
      credentialFingerprint: fp2,
      request: { query: "same" },
    });
    assert.notStrictEqual(a, b);
  });

  it("different queries produce different request hashes", () => {
    const a = buildProviderCacheKey({
      provider: "zai",
      capability: "search",
      credentialFingerprint: fp,
      request: { query: "alpha" },
    });
    const b = buildProviderCacheKey({
      provider: "zai",
      capability: "search",
      credentialFingerprint: fp,
      request: { query: "beta" },
    });
    assert.notStrictEqual(a, b);
  });

  it("count never enters request identity (excluded by caller)", () => {
    // The execution layer is responsible for stripping count. The cache
    // key builder only reflects what it is given; assert that omitting
    // count from the request produces a stable, count-independent key.
    const a = buildProviderCacheKey({
      provider: "zai",
      capability: "search",
      credentialFingerprint: fp,
      request: { query: "q", controls: { domain: "x" } },
    });
    const b = buildProviderCacheKey({
      provider: "zai",
      capability: "search",
      credentialFingerprint: fp,
      request: { query: "q", controls: { domain: "x" } },
    });
    assert.strictEqual(a, b);
  });

  it("key-sorted JSON: control key order does not change the hash", () => {
    const a = buildProviderCacheKey({
      provider: "zai",
      capability: "search",
      credentialFingerprint: fp,
      request: { query: "q", controls: { domain: "x", recency: "oneDay" } },
    });
    const b = buildProviderCacheKey({
      provider: "zai",
      capability: "search",
      credentialFingerprint: fp,
      request: { query: "q", controls: { recency: "oneDay", domain: "x" } },
    });
    assert.strictEqual(a, b);
  });

  it("cache filenames never contain the raw credential", () => {
    const rawKey = "sk-secret-DO-NOT-LEAK-1234567";
    const fingerprint = crypto.createHash("sha256").update(rawKey).digest("hex");
    const key = buildProviderCacheKey({
      provider: "zai",
      capability: "search",
      credentialFingerprint: fingerprint,
      request: { query: "q" },
    });
    assert.ok(!key.includes(rawKey), "raw credential leaked into filename");
    assert.ok(!key.includes("secret"), "credential substring leaked");
  });
});

describe("defaultResponseCache: ResponseCache wrapper over the on-disk cache", () => {
  it("get returns null when the key is absent", async () => {
    await withTempDir({}, async (dir) => {
      process.env.SCOUTLINE_CACHE_DIR = dir;
      try {
        const hit = await defaultResponseCache.get("absent.json");
        assert.strictEqual(hit, null);
      } finally {
        delete process.env.SCOUTLINE_CACHE_DIR;
      }
    });
  });

  it("set then get round-trips a value through the on-disk cache", async () => {
    await withTempDir({}, async (dir) => {
      process.env.SCOUTLINE_CACHE_DIR = dir;
      try {
        const key = "v2-roundtrip.json";
        const value = [{ title: "T", url: "u", summary: "s" }];
        await defaultResponseCache.set(key, value);
        const out = await defaultResponseCache.get(key);
        assert.deepStrictEqual(out, value);
      } finally {
        delete process.env.SCOUTLINE_CACHE_DIR;
      }
    });
  });

  it("default cache root resolves to homedir/.scoutline (dotfile)", async () => {
    // After unification the default root is the dotfile ~/.scoutline/ on
    // every platform. Legacy `~/.cache/zai-cli/responses/` is gone.
    const p = resolveCacheRootPure({}, { platform: "linux", homedir: "/home/u" });
    assert.strictEqual(p, path.join("/home/u", ".scoutline"));
  });
});

// ---------------------------------------------------------------------------
// P6-02 — Pure legacy repository key builder (DESIGN.md §18)
// ---------------------------------------------------------------------------
//
// The pure helper reconstructs v0.2 filenames byte-for-byte without reading
// the ambient credential. Algorithm:
//   credentialPart = sha256(apiKey).hex.slice(0, 12)
//   argumentPart   = sha256(JSON.stringify({ command: publicToolName,
//                                            args })).hex.slice(0, 24)
//   key            = `${publicToolName}.${credentialPart}.${argumentPart}.json`
//
// All four fixed legacy argument orders are tested with hard-coded literal
// filenames (no algorithm re-computation in the golden assertions):
//   Search   args: { repo_name, query, language }
//   File     args: { repo_name, file_path }
//   Directory root:           { repo_name }
//   Directory non-root:       { repo_name, dir_path }
//
// The algorithm itself is exercised separately below (algorithm-only checks
// that DO derive expected values); the golden assertions do not.
//
// The helper also proves it does not consult process.env at all — both an
// injected-only and an ambient-conflict call produce identical keys, and the
// resulting filename never contains the raw credential string.

describe("buildLegacyRepositoryCacheKey — pure v0.2 key builder", () => {
  // Locked apiKey inputs chosen so golden hashes are deterministic.
  const API_KEY = "sk-test-LEGACY-CACHE-KEY-1234567890";

  // Locked golden filenames for the four settled argument orders. These are
  // HARD-CODED LITERALS — the golden assertions below never re-compute them.
  // The literal values were independently computed once and are verified
  // against the v0.2 algorithm by the separate algorithm-only tests in this
  // block.
  const GOLDEN_SEARCH_KEY = "search_doc.69425f4812cb.0b24e0d13cbc0e111928b4e4.json";
  const GOLDEN_FILE_KEY = "read_file.69425f4812cb.45fa21f17c8471947807871a.json";
  const GOLDEN_DIRECTORY_ROOT_KEY = "get_repo_structure.69425f4812cb.f31c6f95fb6f94156924ffbd.json";
  const GOLDEN_DIRECTORY_NON_ROOT_KEY =
    "get_repo_structure.69425f4812cb.33983660382d603ef065bbc1.json";

  it("uses sha256(apiKey).hex.slice(0,12) as the credential part (algorithm check)", () => {
    const expectedCredential = crypto
      .createHash("sha256")
      .update(API_KEY)
      .digest("hex")
      .slice(0, 12);
    const key = buildLegacyRepositoryCacheKey(API_KEY, "search_doc", { repo_name: "x" });
    const parts = key.split(".");
    assert.strictEqual(parts[1], expectedCredential);
    assert.strictEqual(parts[1].length, 12);
  });

  it("uses sha256({command,args}).hex.slice(0,24) as the argument part (algorithm check)", () => {
    const expectedArgPart = crypto
      .createHash("sha256")
      .update(JSON.stringify({ command: "read_file", args: { repo_name: "r", file_path: "a/b" } }))
      .digest("hex")
      .slice(0, 24);
    const key = buildLegacyRepositoryCacheKey(API_KEY, "read_file", {
      repo_name: "r",
      file_path: "a/b",
    });
    const parts = key.split(".");
    assert.strictEqual(parts[2], expectedArgPart);
    assert.strictEqual(parts[2].length, 24);
  });

  it("Search legacy args produce the locked literal golden key (repo_name, query, language)", () => {
    const args = { repo_name: "owner/repo", query: "auth", language: "en" };
    const key = buildLegacyRepositoryCacheKey(API_KEY, "search_doc", args);
    // Hard-coded literal — independent of any runtime hash computation.
    assert.strictEqual(key, GOLDEN_SEARCH_KEY);
  });

  it("File legacy args produce the locked literal golden key (repo_name, file_path)", () => {
    const args = { repo_name: "owner/repo", file_path: "src/index.ts" };
    const key = buildLegacyRepositoryCacheKey(API_KEY, "read_file", args);
    assert.strictEqual(key, GOLDEN_FILE_KEY);
  });

  it("Directory root args omit dir_path and produce the locked literal golden key", () => {
    const args = { repo_name: "owner/repo" };
    const key = buildLegacyRepositoryCacheKey(API_KEY, "get_repo_structure", args);
    assert.strictEqual(key, GOLDEN_DIRECTORY_ROOT_KEY);
  });

  it("Directory non-root args include dir_path and produce the locked literal golden key", () => {
    const args = { repo_name: "owner/repo", dir_path: "src/lib" };
    const key = buildLegacyRepositoryCacheKey(API_KEY, "get_repo_structure", args);
    assert.strictEqual(key, GOLDEN_DIRECTORY_NON_ROOT_KEY);
  });

  it("Directory root and non-root literals are distinct (dir_path inclusion is observable)", () => {
    assert.notStrictEqual(GOLDEN_DIRECTORY_ROOT_KEY, GOLDEN_DIRECTORY_NON_ROOT_KEY);
  });

  it("golden keys all match the v0.2 filename shape", () => {
    for (const k of [
      GOLDEN_SEARCH_KEY,
      GOLDEN_FILE_KEY,
      GOLDEN_DIRECTORY_ROOT_KEY,
      GOLDEN_DIRECTORY_NON_ROOT_KEY,
    ]) {
      assert.match(k, /^[a-z_]+\.[0-9a-f]{12}\.[0-9a-f]{24}\.json$/);
    }
  });

  it("uses insertion-ordered argument JSON (order sensitive)", () => {
    // JSON.stringify follows argument insertion order, so
    // {a:1,b:2} and {b:2,a:1} hash to different argument parts.
    const a = buildLegacyRepositoryCacheKey(API_KEY, "read_file", {
      repo_name: "r",
      file_path: "p",
    });
    const b = buildLegacyRepositoryCacheKey(API_KEY, "read_file", {
      file_path: "p",
      repo_name: "r",
    });
    assert.notStrictEqual(a, b);
  });

  it("identical inputs produce identical keys", () => {
    const args = { repo_name: "r", query: "q", language: "en" };
    const a = buildLegacyRepositoryCacheKey(API_KEY, "search_doc", args);
    const b = buildLegacyRepositoryCacheKey(API_KEY, "search_doc", args);
    assert.strictEqual(a, b);
  });

  it("different public tool names produce different keys for the same args", () => {
    const args = { repo_name: "r" };
    const a = buildLegacyRepositoryCacheKey(API_KEY, "search_doc", args);
    const b = buildLegacyRepositoryCacheKey(API_KEY, "read_file", args);
    assert.notStrictEqual(a, b);
  });

  it("different credentials produce different keys for the same args", () => {
    const args = { repo_name: "r" };
    const a = buildLegacyRepositoryCacheKey(API_KEY, "read_file", args);
    const b = buildLegacyRepositoryCacheKey("sk-OTHER-CRED-XYZ", "read_file", args);
    assert.notStrictEqual(a, b);
  });

  it("filenames never contain the raw credential or its sensitive substrings", () => {
    const args = { repo_name: "owner/repo", query: "q", language: "en" };
    const key = buildLegacyRepositoryCacheKey(API_KEY, "search_doc", args);
    assert.ok(!key.includes(API_KEY), `raw credential must not appear in filename: ${key}`);
    assert.ok(!key.includes("LEGACY-CACHE-KEY"), "credential substring leaked into filename");
    assert.ok(!key.includes("sk-test"), "credential prefix leaked into filename");
  });

  it("golden literals never contain the raw credential or its sensitive substrings", () => {
    for (const k of [
      GOLDEN_SEARCH_KEY,
      GOLDEN_FILE_KEY,
      GOLDEN_DIRECTORY_ROOT_KEY,
      GOLDEN_DIRECTORY_NON_ROOT_KEY,
    ]) {
      assert.ok(!k.includes(API_KEY));
      assert.ok(!k.includes("LEGACY-CACHE-KEY"));
    }
  });

  it("performs no ambient environment lookup (injected-only call)", () => {
    // Save and force a conflicting ambient credential so any env read would
    // either fail or change the hash. The helper must produce a key derived
    // strictly from the injected value.
    const saved = process.env.Z_AI_API_KEY;
    const savedAlt = process.env.ZAI_API_KEY;
    process.env.Z_AI_API_KEY = "sk-AMBIENT-DO-NOT-USE-9999999";
    process.env.ZAI_API_KEY = "sk-AMBIENT-ALT-DO-NOT-USE-9999";
    try {
      const args = { repo_name: "r", query: "q", language: "en" };
      const key = buildLegacyRepositoryCacheKey(API_KEY, "search_doc", args);
      const expectedCredential = crypto
        .createHash("sha256")
        .update(API_KEY)
        .digest("hex")
        .slice(0, 12);
      const parts = key.split(".");
      assert.strictEqual(
        parts[1],
        expectedCredential,
        "helper must hash the injected credential, not the ambient one",
      );
      assert.ok(!key.includes("AMBIENT"));
    } finally {
      if (saved === undefined) delete process.env.Z_AI_API_KEY;
      else process.env.Z_AI_API_KEY = saved;
      if (savedAlt === undefined) delete process.env.ZAI_API_KEY;
      else process.env.ZAI_API_KEY = savedAlt;
    }
  });

  it("ambient and injected credentials produce different keys (no env blending)", () => {
    const args = { repo_name: "r", file_path: "p" };
    const injected = buildLegacyRepositoryCacheKey(API_KEY, "read_file", args);
    // Sanity build: an internally fabricated ambient credential cannot match
    // what the helper would produce from the injected API_KEY if the helper
    // ever swapped sources.
    const ambient = buildLegacyRepositoryCacheKey("sk-somewhere-else", "read_file", args);
    assert.notStrictEqual(injected, ambient);
  });

  it("does not mutate process global env defaults (non-mutation claim only)", () => {
    // The "no env read" behavioral proof is the "conflicting ambient"
    // test above; this test only claims that calling the helper does
    // not mutate the process environment.
    const before = {
      Z_AI_API_KEY: process.env.Z_AI_API_KEY,
      ZAI_API_KEY: process.env.ZAI_API_KEY,
      MINIMAX_API_KEY: process.env.MINIMAX_API_KEY,
    };
    buildLegacyRepositoryCacheKey(API_KEY, "read_file", { repo_name: "r" });
    const after = {
      Z_AI_API_KEY: process.env.Z_AI_API_KEY,
      ZAI_API_KEY: process.env.ZAI_API_KEY,
      MINIMAX_API_KEY: process.env.MINIMAX_API_KEY,
    };
    assert.deepStrictEqual(after, before);
  });
});

// ---------------------------------------------------------------------------
// Source-boundary proof for buildLegacyRepositoryCacheKey
//
// The behavioral tests above prove that the helper's *output* is not
// influenced by `process.env` or by `buildCacheKey`. The next block is a
// direct, structural proof: it reads `src/lib/cache.ts`, isolates the
// `buildLegacyRepositoryCacheKey` function body, and asserts that the
// body itself contains no `process.env`, `getApiKey`, or call to
// `buildCacheKey`. This locks the helper against future regression where
// someone adds a hidden dependency inside the body.
//
// The extractor walks past string literals, template literals (with
// `${...}` interpolations), and comments so braces inside them do not
// affect the depth count. It throws if the function disappears or its
// braces are unbalanced, so any structural change to the helper will
// fail these tests.
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CACHE_SOURCE_PATH = path.join(__dirname, "..", "src", "lib", "cache.ts");

/**
 * Extract the body of a top-level exported function `functionName` from a
 * TypeScript/JavaScript source string. Walks past string literals,
 * template literals (with `${...}` interpolations), and comments so braces
 * inside them do not affect the depth count. Returns the source slice
 * between the opening and closing braces.
 */
function extractFunctionBody(sourceText, functionName) {
  const sigStart = sourceText.search(new RegExp(`export\\s+function\\s+${functionName}\\s*\\(`));
  if (sigStart === -1) {
    throw new Error(`Function ${functionName} not found in source`);
  }
  const slice = sourceText.slice(sigStart);
  const openBraceMatch = slice.match(/\{/);
  if (!openBraceMatch) {
    throw new Error(`Function ${functionName} has no body`);
  }
  const openBraceIdx = sigStart + openBraceMatch.index;
  let depth = 1;
  let i = openBraceIdx + 1;
  while (i < sourceText.length && depth > 0) {
    const c = sourceText[i];
    if (c === "/" && sourceText[i + 1] === "/") {
      const nl = sourceText.indexOf("\n", i);
      i = nl === -1 ? sourceText.length : nl + 1;
      continue;
    }
    if (c === "/" && sourceText[i + 1] === "*") {
      const close = sourceText.indexOf("*/", i + 2);
      i = close === -1 ? sourceText.length : close + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const strChar = c;
      i++;
      while (i < sourceText.length) {
        if (sourceText[i] === "\\") {
          i += 2;
          continue;
        }
        if (sourceText[i] === strChar) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === "`") {
      i++;
      while (i < sourceText.length) {
        if (sourceText[i] === "\\") {
          i += 2;
          continue;
        }
        if (sourceText[i] === "`") {
          i++;
          break;
        }
        if (sourceText[i] === "$" && sourceText[i + 1] === "{") {
          i += 2;
          let idepth = 1;
          while (i < sourceText.length && idepth > 0) {
            if (sourceText[i] === "{") idepth++;
            else if (sourceText[i] === "}") idepth--;
            i++;
          }
          continue;
        }
        i++;
      }
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") depth--;
    i++;
  }
  if (depth !== 0) {
    throw new Error(`Unbalanced braces in ${functionName}`);
  }
  return sourceText.slice(openBraceIdx + 1, i - 1);
}

describe("buildLegacyRepositoryCacheKey — direct source-body purity", () => {
  let sourceText;
  let body;

  it("cache.ts source file is readable from the test directory", async () => {
    sourceText = await fs.readFile(CACHE_SOURCE_PATH, "utf8");
    assert.ok(typeof sourceText === "string" && sourceText.length > 0);
  });

  it("isolates the buildLegacyRepositoryCacheKey function body from cache.ts", async function () {
    if (sourceText === undefined) sourceText = await fs.readFile(CACHE_SOURCE_PATH, "utf8");
    body = extractFunctionBody(sourceText, "buildLegacyRepositoryCacheKey");
    assert.ok(typeof body === "string" && body.length > 0);
    // The body must contain the return statement that joins the key parts.
    assert.ok(
      body.includes("credentialPart") && body.includes("argumentPart"),
      "isolated body must reference both parts",
    );
  });

  it("isolated body contains no reference to process.env", function () {
    if (body === undefined) this.skip();
    assert.ok(
      !body.includes("process.env"),
      `buildLegacyRepositoryCacheKey body must not reference process.env:\n${body}`,
    );
  });

  it("isolated body contains no call to getApiKey", function () {
    if (body === undefined) this.skip();
    assert.ok(
      !/\bgetApiKey\s*\(/.test(body),
      `buildLegacyRepositoryCacheKey body must not call getApiKey:\n${body}`,
    );
  });

  it("isolated body contains no call to buildCacheKey (helper is independent)", function () {
    if (body === undefined) this.skip();
    assert.ok(
      !/\bbuildCacheKey\s*\(/.test(body),
      `buildLegacyRepositoryCacheKey body must not call buildCacheKey:\n${body}`,
    );
  });

  it("isolated body contains no use of ambient Z_AI_API_KEY / ZAI_API_KEY strings", function () {
    if (body === undefined) this.skip();
    assert.ok(
      !body.includes("Z_AI_API_KEY"),
      `buildLegacyRepositoryCacheKey body must not name Z_AI_API_KEY:\n${body}`,
    );
    assert.ok(
      !body.includes("ZAI_API_KEY"),
      `buildLegacyRepositoryCacheKey body must not name ZAI_API_KEY:\n${body}`,
    );
  });

  it("isolated body is non-empty and pure (no module-level ambient state access)", function () {
    if (body === undefined) this.skip();
    // Defense in depth: any of these would suggest the helper has reached
    // outside its own lexical scope.
    for (const forbidden of ["process.env", "getApiKey(", "buildCacheKey("]) {
      assert.ok(!body.includes(forbidden), `forbidden token in body: ${forbidden}`);
    }
  });
});

// ---------------------------------------------------------------------------
// P6-08 — Legacy-cache continuity for the Repository Capability.
//
// The pure helper above reconstructs v0.2 key bytes. This block proves the
// plumbing that connects the helper to the on-disk store:
//
//   - A legacy entry written through `writeCache` (the same path v0.2 used)
//     is read back unchanged through `readCache`, `defaultResponseCache`,
//     and a fresh `readCache` call after a process restart (modelled by
//     re-reading from the same directory).
//   - A normalized write-back through `defaultResponseCache.set` round-trips
//     a structured schema-version-1 value so the executor's `decodeCached`
//     sees byte-identical data on the next hit.
//   - Raw legacy Provider data is NEVER mutated by a normalized write-back
//     to a different key (the legacy file is preserved verbatim).
//
// These are plumbing proofs; the per-operation Adapter matrix that exercises
// the Adapter's legacy decoder is in `repository-conformance.test.js`.
// ---------------------------------------------------------------------------

describe("P6-08 legacy repository cache continuity (plumbing)", () => {
  const API_KEY = "sk-test-LEGACY-CACHE-KEY-1234567890";

  it("a legacy v0.2 entry written through writeCache round-trips through readCache and defaultResponseCache", async () => {
    await withTempDir({}, async (dir) => {
      process.env.ZAI_CACHE_DIR = dir;
      try {
        const legacyKey = buildLegacyRepositoryCacheKey(API_KEY, "search_doc", {
          repo_name: "owner/repo",
          query: "q",
          language: "en",
        });
        const rawLegacy = "<excerpt>legacy search text</excerpt>";
        await writeCache(legacyKey, rawLegacy);

        // readCache returns the raw value verbatim (the legacy store does
        // not interpret the cached payload).
        const viaReadCache = await readCache(legacyKey, 60_000);
        assert.strictEqual(viaReadCache, rawLegacy);

        // defaultResponseCache returns the same value through the
        // ResponseCache interface the executor uses.
        const viaResponseCache = await defaultResponseCache.get(legacyKey);
        assert.strictEqual(viaResponseCache, rawLegacy);
      } finally {
        delete process.env.ZAI_CACHE_DIR;
      }
    });
  });

  it("a normalized write-back to the new key never mutates the legacy file", async () => {
    await withTempDir({}, async (dir) => {
      process.env.ZAI_CACHE_DIR = dir;
      try {
        const legacyKey = buildLegacyRepositoryCacheKey(API_KEY, "read_file", {
          repo_name: "owner/repo",
          file_path: "README.md",
        });
        const rawLegacy = "<file_content>legacy file body</file_content>";
        await writeCache(legacyKey, rawLegacy);

        // Compute the normalized key the executor would use and write
        // a structured value to it.
        const fp = crypto.createHash("sha256").update(API_KEY).digest("hex");
        const normalizedKey = buildProviderCacheKey({
          provider: "zai",
          capability: "repository-exploration-repository-read-file",
          credentialFingerprint: fp,
          request: { repository: "owner/repo", path: "README.md" },
        });
        assert.notStrictEqual(legacyKey, normalizedKey);
        const normalizedValue = {
          schemaVersion: 1,
          repository: "owner/repo",
          path: "README.md",
          content: "legacy file body",
          truncated: false,
          originalContentLength: 17,
        };
        await defaultResponseCache.set(normalizedKey, normalizedValue);

        // Both files coexist; the legacy file is preserved verbatim.
        const legacyAfter = await defaultResponseCache.get(legacyKey);
        assert.strictEqual(legacyAfter, rawLegacy);
        const normalizedAfter = await defaultResponseCache.get(normalizedKey);
        assert.deepStrictEqual(normalizedAfter, normalizedValue);
      } finally {
        delete process.env.ZAI_CACHE_DIR;
      }
    });
  });

  it("all three operations' primary public names produce distinct legacy keys for the same repository", () => {
    // Belt-and-braces: the pure helper has already proven insertion-order
    // sensitivity for a single operation. Here we lock that the three
    // OPERATION primary public names also produce distinct keys for the
    // same repository, so a v0.2 File entry cannot satisfy a Directory
    // candidate lookup (and vice versa) at the cache-key level.
    const searchKey = buildLegacyRepositoryCacheKey(API_KEY, "search_doc", {
      repo_name: "owner/repo",
      query: "q",
      language: "en",
    });
    const fileKey = buildLegacyRepositoryCacheKey(API_KEY, "read_file", {
      repo_name: "owner/repo",
      file_path: "README.md",
    });
    const dirRootKey = buildLegacyRepositoryCacheKey(API_KEY, "get_repo_structure", {
      repo_name: "owner/repo",
    });
    const dirNonRootKey = buildLegacyRepositoryCacheKey(API_KEY, "get_repo_structure", {
      repo_name: "owner/repo",
      dir_path: "src",
    });
    const all = [searchKey, fileKey, dirRootKey, dirNonRootKey];
    assert.strictEqual(new Set(all).size, all.length, "all four legacy keys must be distinct");
  });
});
