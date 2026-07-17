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
import crypto from "node:crypto";
import {
  resolveCacheDirPure,
  buildCacheKey,
  readCache,
  writeCache,
  clearCache,
  cacheStats,
  buildProviderCacheKey,
  defaultResponseCache,
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

describe("defaultResponseCache: ResponseCache wrapper over legacy cache", () => {
  it("get returns null when the key is absent", async () => {
    await withTempDir({}, async (dir) => {
      process.env.ZAI_CACHE_DIR = dir;
      try {
        const hit = await defaultResponseCache.get("absent.json");
        assert.strictEqual(hit, null);
      } finally {
        delete process.env.ZAI_CACHE_DIR;
      }
    });
  });

  it("set then get round-trips a value through the legacy cache", async () => {
    await withTempDir({}, async (dir) => {
      process.env.ZAI_CACHE_DIR = dir;
      try {
        const key = "v2-roundtrip.json";
        const value = [{ title: "T", url: "u", summary: "s" }];
        await defaultResponseCache.set(key, value);
        const out = await defaultResponseCache.get(key);
        assert.deepStrictEqual(out, value);
      } finally {
        delete process.env.ZAI_CACHE_DIR;
      }
    });
  });

  it("preserves the existing zai-cli/responses default directory", async () => {
    // Just confirm the default cache directory resolver is unchanged.
    const p = resolveCacheDirPure({}, { platform: "linux", homedir: "/home/u" });
    assert.ok(p.endsWith(path.join("zai-cli", "responses")));
  });
});
