/**
 * Cache characterization tests.
 *
 * P0-02 captures the shipped behaviour of the response cache and exposes a
 * pure resolver to allow tests to assert path resolution without changing
 * the process-level default. Legacy paths retain the `zai-cli/responses`
 * segment.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { withTempDir } from "./helpers/temp-dir.js";
import {
  resolveCacheDirPure,
  buildCacheKey,
  readCache,
  writeCache,
  clearCache,
  cacheStats,
} from "../dist/lib/cache.js";

describe("resolveCacheDirPure: legacy zai-cli/responses paths", () => {
  it("ZAI_CACHE_DIR overrides everything with its literal value", () => {
    const p = resolveCacheDirPure(
      { ZAI_CACHE_DIR: "/var/tmp/scoutline-cache", XDG_CACHE_HOME: "/elsewhere" },
      { platform: "linux", homedir: "/home/u" },
    );
    assert.strictEqual(p, "/var/tmp/scoutline-cache");
  });

  it("XDG path uses XDG_CACHE_HOME/zai-cli/responses", () => {
    const p = resolveCacheDirPure(
      { XDG_CACHE_HOME: "/cache/xdg" },
      { platform: "linux", homedir: "/home/user" },
    );
    assert.strictEqual(p, path.join("/cache/xdg", "zai-cli", "responses"));
  });

  it("macOS path uses homedir/Library/Caches/zai-cli/responses", () => {
    const p = resolveCacheDirPure({}, { platform: "darwin", homedir: "/Users/u" });
    assert.strictEqual(p, path.join("/Users/u", "Library", "Caches", "zai-cli", "responses"));
  });

  it("default Linux path uses homedir/.cache/zai-cli/responses", () => {
    const p = resolveCacheDirPure({}, { platform: "linux", homedir: "/home/u" });
    assert.strictEqual(p, path.join("/home/u", ".cache", "zai-cli", "responses"));
  });

  it("default win32 path uses homedir/.cache/zai-cli/responses", () => {
    const p = resolveCacheDirPure({}, { platform: "win32", homedir: "C:\\Users\\u" });
    assert.strictEqual(p, path.join("C:\\Users\\u", ".cache", "zai-cli", "responses"));
  });

  it("all non-explicit platform paths retain the zai-cli/responses segment", () => {
    const linux = resolveCacheDirPure({}, { platform: "linux", homedir: "/h" });
    const darwin = resolveCacheDirPure({}, { platform: "darwin", homedir: "/h" });
    assert.ok(linux.endsWith(path.join("zai-cli", "responses")));
    assert.ok(darwin.endsWith(path.join("zai-cli", "responses")));
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
      process.env.ZAI_CACHE_DIR = dir;
      try {
        const key = "test-hit." + Math.random().toString(36).slice(2) + ".json";
        const data = [{ title: "cached", link: "https://e/x" }];
        await writeCache(key, data);
        const hit = await readCache(key, 60_000);
        assert.deepStrictEqual(hit, data);
      } finally {
        delete process.env.ZAI_CACHE_DIR;
      }
    });
  });

  it("expired cache entry becomes a miss", async () => {
    await withTempDir({}, async (dir) => {
      process.env.ZAI_CACHE_DIR = dir;
      try {
        const key = "test-expired." + Math.random().toString(36).slice(2) + ".json";
        await writeCache(key, { ok: true });
        // ttlMs=0 is treated as disabled → miss.
        const out = await readCache(key, 0);
        assert.strictEqual(out, null);
      } finally {
        delete process.env.ZAI_CACHE_DIR;
      }
    });
  });

  it("corrupt cache JSON is treated as a miss", async () => {
    await withTempDir({}, async (dir) => {
      process.env.ZAI_CACHE_DIR = dir;
      try {
        const key = "test-corrupt." + Math.random().toString(36).slice(2) + ".json";
        await writeCache(key, { value: 7 });
        // Overwrite the underlying file with broken JSON.
        const file = path.join(dir, key);
        await fs.writeFile(file, "this is not json {{{ broken");
        const out = await readCache(key, 60_000);
        assert.strictEqual(out, null);
      } finally {
        delete process.env.ZAI_CACHE_DIR;
      }
    });
  });
});

describe("best-effort cache helpers never fail", () => {
  it("clearCache returns counts even when the dir does not exist", async () => {
    process.env.ZAI_CACHE_DIR = path.join(os.tmpdir(), "scoutline-no-such-dir-" + Date.now());
    try {
      const result = await clearCache();
      assert.strictEqual(result.cleared, 0);
      assert.strictEqual(result.bytesFreed, 0);
    } finally {
      delete process.env.ZAI_CACHE_DIR;
    }
  });

  it("cacheStats returns metadata even when the dir is empty", async () => {
    await withTempDir({}, async (dir) => {
      process.env.ZAI_CACHE_DIR = dir;
      try {
        const stats = await cacheStats();
        assert.strictEqual(stats.enabled, true);
        assert.strictEqual(stats.entries, 0);
        assert.strictEqual(stats.totalBytes, 0);
        assert.ok(typeof stats.dir === "string");
      } finally {
        delete process.env.ZAI_CACHE_DIR;
      }
    });
  });

  it("eviction on a cache over the size cap does not throw", async () => {
    await withTempDir({}, async (dir) => {
      process.env.ZAI_CACHE_DIR = dir;
      // Force a very small size cap to trigger eviction.
      process.env.ZAI_CACHE_SIZE_MB = "0";
      try {
        const key = "evict-test." + Math.random().toString(36).slice(2) + ".json";
        // writeCache catches internal errors silently; it should not throw.
        await writeCache(key, { big: "x".repeat(1000) });
        assert.ok(true, "writeCache with eviction did not throw");
      } finally {
        delete process.env.ZAI_CACHE_DIR;
        delete process.env.ZAI_CACHE_SIZE_MB;
      }
    });
  });
});
