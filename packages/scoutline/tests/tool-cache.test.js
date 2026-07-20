/**
 * Tool-cache extraction characterization tests (Ticket 02).
 *
 * Covers the extracted `tool-cache.ts` module that owns its filesystem
 * I/O directly against the `tools/` subdirectory (D1 — does NOT reuse
 * ResponseCache). Verifies:
 *
 *   - `readToolCache` / `writeToolCache` round-trip.
 *   - Key construction: distinct configs → distinct keys; same → same.
 *   - Version stamp: old version → miss.
 *   - TTL expiry: old timestamp → miss.
 *   - `redactTool` applied to every tool before disk write (B2 fix).
 *   - `ZAI_MCP_TOOL_CACHE=0` disables the tool cache only (response
 *     cache stays enabled — D3 deviation preserved).
 *   - `SCOUTLINE_CACHE=0` disables both.
 *   - Corruption (invalid JSON, missing envelope fields) → miss, no throw.
 *
 * The existing four `mcp-client.test.js` suites that mutate
 * `ZAI_MCP_TOOL_CACHE` per-suite continue to pass unchanged because the
 * tool-cache enable check reads the env var at call time (H1 fix).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  readToolCache,
  writeToolCache,
  buildToolCacheKey,
  buildToolCachePath,
  isToolCacheEnabled,
  TOOL_CACHE_VERSION,
} from "../dist/lib/tool-cache.js";
import { isCacheEnabled, getCacheTtlMs } from "../dist/lib/cache.js";

// All env vars the tool-cache module reads at call time. Saved and
// restored around the suite so each test sees a deterministic
// environment.
const ENV_VARS = [
  "SCOUTLINE_CACHE",
  "ZAI_CACHE",
  "ZAI_MCP_TOOL_CACHE",
  "SCOUTLINE_CACHE_TTL_MS",
  "ZAI_CACHE_TTL_MS",
  "ZAI_MCP_TOOL_CACHE_TTL_MS",
  "SCOUTLINE_CACHE_DIR",
  "ZAI_MCP_CACHE_DIR",
  "ZAI_CACHE_DIR",
];

const ENV_DIR_VARS = ["SCOUTLINE_CACHE_DIR", "ZAI_MCP_CACHE_DIR", "ZAI_CACHE_DIR"];

const savedEnv = {};
const savedCreds = { Z_AI_API_KEY: undefined, ZAI_API_KEY: undefined };

before(() => {
  for (const v of ENV_VARS) savedEnv[v] = process.env[v];
  // Install a fake credential so redactTool has a non-empty secret list
  // for the "raw secret is removed" assertions to be meaningful.
  savedCreds.Z_AI_API_KEY = process.env.Z_AI_API_KEY;
  savedCreds.ZAI_API_KEY = process.env.ZAI_API_KEY;
  process.env.Z_AI_API_KEY = "RAW_TEST_SECRET_DO_NOT_LEAK_12345";
  delete process.env.ZAI_API_KEY;
});

after(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const [k, v] of Object.entries(savedCreds)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// Helper: clear every env var the tool cache reads so each test starts
// from a clean baseline.
function clearCacheEnv() {
  for (const v of ENV_VARS) delete process.env[v];
}

// Helper: redirect the cache root into a fresh temp directory and return
// its path. Tests assert on files under `<root>/tools/`.
async function redirectCacheRoot() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scoutline-tool-cache-test-"));
  process.env.SCOUTLINE_CACHE_DIR = dir;
  return dir;
}

function baseConfig(overrides = {}) {
  return {
    mode: "ZAI",
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    endpoints: {
      ZREAD: "https://api.z.ai/api/mcp/zread/mcp",
      WEB_SEARCH: "https://api.z.ai/api/mcp/web_search_prime/mcp",
      WEB_READER: "https://api.z.ai/api/mcp/web_reader/mcp",
    },
    enableVision: false,
    ...overrides,
  };
}

function sampleTools() {
  return [
    {
      name: "scoutline_zai.search.web_search_prime",
      description: "Search the web. Auth: Bearer RAW_TEST_SECRET_DO_NOT_LEAK_12345",
      inputs: { type: "object", required: ["search_query"], properties: {} },
    },
    {
      name: "scoutline_zai.reader.webReader",
      description: "Read a page. x-api-key: RAW_TEST_SECRET_DO_NOT_LEAK_12345",
      inputs: { type: "object" },
    },
  ];
}

describe("tool-cache: key construction", () => {
  it("same config produces same key (deterministic)", () => {
    const a = baseConfig();
    const b = baseConfig();
    assert.strictEqual(buildToolCacheKey(a), buildToolCacheKey(b));
  });

  it("distinct modes produce distinct keys", () => {
    const a = baseConfig({ mode: "ZAI" });
    const b = baseConfig({ mode: "ZHIPU" });
    assert.notStrictEqual(buildToolCacheKey(a), buildToolCacheKey(b));
  });

  it("distinct baseUrls produce distinct keys", () => {
    const a = baseConfig({ baseUrl: "https://a.example.com" });
    const b = baseConfig({ baseUrl: "https://b.example.com" });
    assert.notStrictEqual(buildToolCacheKey(a), buildToolCacheKey(b));
  });

  it("distinct endpoints produce distinct keys", () => {
    const a = baseConfig();
    const b = baseConfig({
      endpoints: { ...a.endpoints, ZREAD: "https://different.example.com/mcp" },
    });
    assert.notStrictEqual(buildToolCacheKey(a), buildToolCacheKey(b));
  });

  it("enableVision flip produces distinct keys", () => {
    const a = baseConfig({ enableVision: false });
    const b = baseConfig({ enableVision: true });
    assert.notStrictEqual(buildToolCacheKey(a), buildToolCacheKey(b));
  });

  it("buildToolCachePath lands under the tools/ subdirectory", async () => {
    clearCacheEnv();
    const dir = await redirectCacheRoot();
    try {
      const p = buildToolCachePath(baseConfig());
      assert.ok(
        p.startsWith(path.join(dir, "tools") + path.sep),
        `expected path under ${dir}/tools/, got ${p}`,
      );
      assert.ok(
        /tools-[0-9a-f]{16}\.json$/.test(p),
        `expected tools-<16-hex>.json filename, got ${p}`,
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
});

describe("tool-cache: round-trip read/write", () => {
  it("writeToolCache then readToolCache returns the same tools", async () => {
    clearCacheEnv();
    const dir = await redirectCacheRoot();
    try {
      const config = baseConfig();
      const tools = sampleTools();
      await writeToolCache(config, tools);

      const readBack = await readToolCache(config);
      assert.ok(readBack !== null, "expected a cache hit");
      assert.strictEqual(readBack.length, tools.length);
      assert.deepStrictEqual(
        readBack.map((t) => t.name),
        tools.map((t) => t.name),
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("readToolCache returns null when no cache file exists", async () => {
    clearCacheEnv();
    const dir = await redirectCacheRoot();
    try {
      const readBack = await readToolCache(baseConfig());
      assert.strictEqual(readBack, null);
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
});

describe("tool-cache: version stamp", () => {
  it("TOOL_CACHE_VERSION is 1 (matches the v0.4.0 envelope)", () => {
    assert.strictEqual(TOOL_CACHE_VERSION, 1);
  });

  it("old version stamp → miss, no throw", async () => {
    clearCacheEnv();
    const dir = await redirectCacheRoot();
    try {
      const config = baseConfig();
      await writeToolCache(config, sampleTools());

      // Corrupt the version to simulate an old envelope.
      const filePath = buildToolCachePath(config);
      const raw = JSON.parse(await fs.readFile(filePath, "utf8"));
      raw.version = 0;
      await fs.writeFile(filePath, JSON.stringify(raw));

      const readBack = await readToolCache(config);
      assert.strictEqual(readBack, null, "old version must miss");
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("missing version field → miss", async () => {
    clearCacheEnv();
    const dir = await redirectCacheRoot();
    try {
      const config = baseConfig();
      const filePath = buildToolCachePath(config);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, JSON.stringify({ timestamp: Date.now(), tools: sampleTools() }));

      const readBack = await readToolCache(config);
      assert.strictEqual(readBack, null);
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
});

describe("tool-cache: TTL expiry", () => {
  it("fresh entry hits (within default 24h TTL)", async () => {
    clearCacheEnv();
    const dir = await redirectCacheRoot();
    try {
      const config = baseConfig();
      await writeToolCache(config, sampleTools());
      const readBack = await readToolCache(config);
      assert.ok(readBack !== null);
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("old timestamp → miss (single TTL check; H2 fix)", async () => {
    clearCacheEnv();
    const dir = await redirectCacheRoot();
    try {
      const config = baseConfig();
      await writeToolCache(config, sampleTools());

      // Push the timestamp 25h into the past.
      const filePath = buildToolCachePath(config);
      const raw = JSON.parse(await fs.readFile(filePath, "utf8"));
      raw.timestamp = Date.now() - 25 * 60 * 60 * 1000;
      await fs.writeFile(filePath, JSON.stringify(raw));

      const readBack = await readToolCache(config);
      assert.strictEqual(readBack, null, "stale entry must miss");
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("SCOUTLINE_CACHE_TTL_MS shortens the TTL window (single TTL honored)", async () => {
    clearCacheEnv();
    const dir = await redirectCacheRoot();
    process.env.SCOUTLINE_CACHE_TTL_MS = "1000"; // 1s
    try {
      const config = baseConfig();
      await writeToolCache(config, sampleTools());
      assert.strictEqual(getCacheTtlMs(), 1000);

      // Wait 1.2s so the entry is now stale.
      await new Promise((resolve) => setTimeout(resolve, 1200));

      const readBack = await readToolCache(config);
      assert.strictEqual(readBack, null, "entry must miss after the shortened TTL elapses");
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
});

describe("tool-cache: redactTool applied before disk write (B2 fix)", () => {
  it("raw secrets in description are scrubbed on disk", async () => {
    clearCacheEnv();
    const dir = await redirectCacheRoot();
    try {
      const config = baseConfig();
      const tools = sampleTools();
      await writeToolCache(config, tools);

      const filePath = buildToolCachePath(config);
      const onDisk = await fs.readFile(filePath, "utf8");

      // The raw credential the test fixture planted must NOT appear in
      // the on-disk envelope. redactTool must have replaced it with the
      // [REDACTED] marker.
      assert.ok(
        !onDisk.includes("RAW_TEST_SECRET_DO_NOT_LEAK_12345"),
        "raw credential leaked into tool-cache file",
      );
      assert.ok(
        onDisk.includes("[REDACTED]"),
        "expected [REDACTED] marker in the scrubbed envelope",
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("redaction is non-mutating: the in-memory tools passed in are untouched", async () => {
    clearCacheEnv();
    const dir = await redirectCacheRoot();
    try {
      const config = baseConfig();
      const tools = sampleTools();
      const before = JSON.parse(JSON.stringify(tools));
      await writeToolCache(config, tools);
      assert.deepStrictEqual(tools, before, "writeToolCache must not mutate its input");
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
});

describe("tool-cache: enable check granularity (D3 deviation preserved)", () => {
  it("isToolCacheEnabled defaults to true when nothing is set", () => {
    clearCacheEnv();
    assert.strictEqual(isToolCacheEnabled(), true);
  });

  it("ZAI_MCP_TOOL_CACHE=0 disables ONLY the tool cache (response cache stays on)", () => {
    clearCacheEnv();
    process.env.ZAI_MCP_TOOL_CACHE = "0";
    assert.strictEqual(
      isCacheEnabled(),
      true,
      "response cache must stay enabled when only ZAI_MCP_TOOL_CACHE=0",
    );
    assert.strictEqual(
      isToolCacheEnabled(),
      false,
      "tool cache must be disabled by ZAI_MCP_TOOL_CACHE=0",
    );
  });

  it("ZAI_MCP_TOOL_CACHE=false (case-insensitive) disables only the tool cache", () => {
    clearCacheEnv();
    process.env.ZAI_MCP_TOOL_CACHE = "FALSE";
    assert.strictEqual(isCacheEnabled(), true);
    assert.strictEqual(isToolCacheEnabled(), false);
  });

  it("SCOUTLINE_CACHE=0 disables BOTH caches", () => {
    clearCacheEnv();
    process.env.SCOUTLINE_CACHE = "0";
    assert.strictEqual(isCacheEnabled(), false);
    assert.strictEqual(isToolCacheEnabled(), false);
  });

  it("ZAI_CACHE=0 (legacy) disables BOTH caches", () => {
    clearCacheEnv();
    process.env.ZAI_CACHE = "0";
    assert.strictEqual(isCacheEnabled(), false);
    assert.strictEqual(isToolCacheEnabled(), false);
  });

  it("SCOUTLINE_CACHE=1 wins over ZAI_MCP_TOOL_CACHE=0 (response cache perspective)", () => {
    clearCacheEnv();
    process.env.SCOUTLINE_CACHE = "1";
    process.env.ZAI_MCP_TOOL_CACHE = "0";
    assert.strictEqual(isCacheEnabled(), true);
    assert.strictEqual(isToolCacheEnabled(), false);
  });

  it("writeToolCache is a no-op when ZAI_MCP_TOOL_CACHE=0 (no file written)", async () => {
    clearCacheEnv();
    const dir = await redirectCacheRoot();
    process.env.ZAI_MCP_TOOL_CACHE = "0";
    try {
      const config = baseConfig();
      await writeToolCache(config, sampleTools());

      // The path must not exist on disk because writeToolCache must
      // short-circuit before fs.writeFile.
      await assert.rejects(
        () => fs.access(buildToolCachePath(config)),
        (err) => err.code === "ENOENT",
        "writeToolCache wrote a file despite ZAI_MCP_TOOL_CACHE=0",
      );

      // And readToolCache must miss.
      const readBack = await readToolCache(config);
      assert.strictEqual(readBack, null);
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("writeToolCache is a no-op when SCOUTLINE_CACHE=0 (no file written)", async () => {
    clearCacheEnv();
    const dir = await redirectCacheRoot();
    process.env.SCOUTLINE_CACHE = "0";
    try {
      const config = baseConfig();
      await writeToolCache(config, sampleTools());

      await assert.rejects(
        () => fs.access(buildToolCachePath(config)),
        (err) => err.code === "ENOENT",
        "writeToolCache wrote a file despite SCOUTLINE_CACHE=0",
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
});

describe("tool-cache: corruption safety", () => {
  it("invalid JSON → miss, no throw", async () => {
    clearCacheEnv();
    const dir = await redirectCacheRoot();
    try {
      const config = baseConfig();
      const filePath = buildToolCachePath(config);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, "{not valid json");

      const readBack = await readToolCache(config);
      assert.strictEqual(readBack, null);
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("tools field is not an array → miss", async () => {
    clearCacheEnv();
    const dir = await redirectCacheRoot();
    try {
      const config = baseConfig();
      const filePath = buildToolCachePath(config);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(
        filePath,
        JSON.stringify({
          version: TOOL_CACHE_VERSION,
          timestamp: Date.now(),
          tools: "not-an-array",
        }),
      );

      const readBack = await readToolCache(config);
      assert.strictEqual(readBack, null);
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("missing timestamp → treated as age-infinity (miss)", async () => {
    clearCacheEnv();
    const dir = await redirectCacheRoot();
    try {
      const config = baseConfig();
      const filePath = buildToolCachePath(config);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(
        filePath,
        JSON.stringify({
          version: TOOL_CACHE_VERSION,
          tools: sampleTools(),
        }),
      );

      const readBack = await readToolCache(config);
      assert.strictEqual(
        readBack,
        null,
        "missing timestamp must fail the TTL check (age = now - 0 > ttlMs only if ttlMs < now; this guards the ?? 0 fallback)",
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
});

describe("tool-cache: ZAI_CACHE_DIR alias still resolves the path (B3 + D2)", () => {
  it("ZAI_CACHE_DIR redirects toolCacheDir through the legacy alias", async () => {
    clearCacheEnv();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scoutline-tool-cache-alias-"));
    // Set the LEGACY alias only — proves the cache-root resolver chain
    // still feeds toolCacheDir() through tool-cache.ts.
    process.env.ZAI_CACHE_DIR = dir;
    try {
      const config = baseConfig();
      await writeToolCache(config, sampleTools());

      const expectedFile = path.join(dir, "tools", `tools-${buildToolCacheKey(config)}.json`);
      await fs.access(expectedFile);
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
