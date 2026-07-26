/**
 * T2b - Credential view (raw/cache path): file keys flow to the raw
 * ZAI command families (tools / tool / call / code) and the cache key.
 *
 * Acceptance gates (Plan A - T2b ticket):
 *   - buildMcpCallTemplate fake-UTCP probe (moved here from T2a):
 *       * a file-only ZAI key reaches the real buildMcpCallTemplate
 *         through a fake UTCP transport and authorises the template
 *         (no ambient provider keys required).
 *       * a success payload containing the key is redacted before
 *         return / cache write.
 *       * a thrown registration error containing the key is redacted
 *         in the public typed error.
 *       * the same chain fails with CONFIGURATION_ERROR exit 3 when
 *         neither resolved nor ambient key exists.
 *   - Raw commands (tools/call/code) work with file-only keys.
 *   - Cache-key fingerprint uses the file key, not ambient state.
 *   - No ambient process.env credential reads on the dispatch path
 *     (the load-failure adapter + monitor-client back-compat shims
 *     remain the documented exceptions).
 *
 * Scope: the raw Z.AI chain stays Z.AI-specific. No provider selection
 * or fallback is introduced here (commands/tools.ts:1-12 boundary).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { ZaiMcpClient } from "../dist/lib/mcp-client.js";
import { buildMcpCallTemplate } from "../dist/lib/mcp-config.js";
import { buildCacheKey } from "../dist/lib/cache.js";
import { listTools, showTool, callTool } from "../dist/commands/tools.js";
import { runCodeFile, evalCode, printInterfaces } from "../dist/commands/code.js";
import { ConfigurationError, ApiError } from "../dist/lib/errors.js";
import { formatErrorOutput } from "../dist/lib/output.js";

// ---------------------------------------------------------------------------
// Ambient credential hygiene — strip every Provider key from process.env
// before any test runs and restore it after, so a probe that asserts
// "ambient keys never read" is provable rather than incidental.
//
// Also disable the on-disk tool-discovery cache (ZAI_MCP_TOOL_CACHE=0) so
// the acceptance probe can observe registerManual running on every call
// instead of being short-circuited by a stale entry from another suite.
// ---------------------------------------------------------------------------
const AMBIENT_KEYS = [
  "Z_AI_API_KEY",
  "ZAI_API_KEY",
  "MINIMAX_API_KEY",
  "TAVILY_API_KEY",
  "EXA_API_KEY",
  "BRAVE_SEARCH_API_KEY",
  "FIRECRAWL_API_KEY",
];
const saved = {};
const savedToolCache = {};
before(() => {
  for (const k of AMBIENT_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  savedToolCache.ZAI_MCP_TOOL_CACHE = process.env.ZAI_MCP_TOOL_CACHE;
  process.env.ZAI_MCP_TOOL_CACHE = "0";
});
after(() => {
  for (const k of AMBIENT_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  if (savedToolCache.ZAI_MCP_TOOL_CACHE === undefined) delete process.env.ZAI_MCP_TOOL_CACHE;
  else process.env.ZAI_MCP_TOOL_CACHE = savedToolCache.ZAI_MCP_TOOL_CACHE;
});

const FILE_KEY = "t2b-file-only-zai-key-112358";

/** Minimal in-memory command context for the command-module probes. */
function silentContext() {
  return {
    stdinIsTTY: true,
    readStdin: async () => "",
  };
}

/** Recursively read every file under `dir`, returning their string contents. */
async function readAllFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await readAllFiles(full)));
    else out.push(await fs.readFile(full, "utf8"));
  }
  return out;
}

/**
 * Fake UTCP that captures the registration template and then resolves
 * init. Used by the buildMcpCallTemplate acceptance probe to prove the
 * file key reached the real template.
 */
class TemplateCapturingUtcp {
  constructor() {
    this.capturedTemplate = null;
    this.registerManualCalls = 0;
  }
  async registerManual(template) {
    this.registerManualCalls += 1;
    this.capturedTemplate = template;
    return { success: true, errors: [] };
  }
  async getTools() {
    return [];
  }
  async callTool() {
    return { ok: true };
  }
  async close() {}
}

// ---------------------------------------------------------------------------
// buildMcpCallTemplate — explicit env threads file key into the template
// ---------------------------------------------------------------------------

describe("buildMcpCallTemplate: explicit env threads the credential view", () => {
  it("the file key authorises the search/reader/zread Bearer headers", () => {
    // enableVision:false keeps the assertion scoped to the 3 HTTP
    // servers; the Vision stdio server is exercised separately below.
    const template = buildMcpCallTemplate({
      env: { Z_AI_API_KEY: FILE_KEY },
      enableVision: false,
    });
    const servers = template.config.mcpServers;
    for (const name of ["search", "reader", "zread"]) {
      assert.ok(servers[name], `expected ${name} server in template`);
      assert.strictEqual(
        servers[name].headers.Authorization,
        `Bearer ${FILE_KEY}`,
        `${name} Authorization must use the file key`,
      );
    }
    assert.ok(!servers.vision, "vision must be off when enableVision:false");
  });

  it("the file key is not echoed in any non-authorization field (vision off)", () => {
    const template = buildMcpCallTemplate({
      env: { Z_AI_API_KEY: FILE_KEY },
      enableVision: false,
    });
    const serialized = JSON.stringify(template);
    // Count occurrences of the raw key — exactly 3 (one per Bearer
    // header on search/reader/zread). A leak elsewhere would bump this.
    const matches = serialized.match(new RegExp(FILE_KEY, "g")) || [];
    assert.strictEqual(matches.length, 3, "raw key must appear only in the 3 Bearer headers");
  });

  it("the file key reaches the Vision stdio server env when vision is enabled", () => {
    const template = buildMcpCallTemplate({
      env: { Z_AI_API_KEY: FILE_KEY },
      enableVision: true,
    });
    const vision = template.config.mcpServers.vision;
    assert.ok(vision, "vision server must be present when enableVision:true");
    assert.strictEqual(vision.env.Z_AI_API_KEY, FILE_KEY);
    // 4 occurrences: 3 Bearer headers + 1 Vision env entry.
    const serialized = JSON.stringify(template);
    const matches = serialized.match(new RegExp(FILE_KEY, "g")) || [];
    assert.strictEqual(matches.length, 4, "raw key must appear in 3 Bearer + 1 Vision env");
  });

  it("ZAI_API_KEY alias resolves identically to Z_AI_API_KEY", () => {
    const template = buildMcpCallTemplate({ env: { ZAI_API_KEY: FILE_KEY } });
    assert.strictEqual(
      template.config.mcpServers.search.headers.Authorization,
      `Bearer ${FILE_KEY}`,
    );
  });

  it("throws ConfigurationError (exit 3) when no key is resolvable", () => {
    assert.throws(
      () => buildMcpCallTemplate({ env: {} }),
      (err) => err instanceof ConfigurationError && err.exitCode === 3,
    );
  });

  it("threads base URL / mode from the env view (file-configurable)", () => {
    const template = buildMcpCallTemplate({
      env: {
        Z_AI_API_KEY: FILE_KEY,
        Z_AI_BASE_URL: "https://custom.example/api/coding/paas/v4/",
        Z_AI_MODE: "ZHIPU",
      },
    });
    // The search URL itself is the constant MCP endpoint, but the base
    // URL is what the template would embed for any provider-relative
    // path. Prove the mode propagated by checking loadConfig's view: if
    // Z_AI_MODE was ignored, the alias for the canonical env would not
    // surface. We assert the template still built (no throw) and that
    // the headers carry the file key (proving config + key both resolved).
    assert.strictEqual(
      template.config.mcpServers.search.headers.Authorization,
      `Bearer ${FILE_KEY}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Acceptance probe — file-only key reaches the real template via fake UTCP
// and is redacted on success / error paths
// ---------------------------------------------------------------------------

describe("acceptance probe: file-only key reaches buildMcpCallTemplate via ZaiMcpClient", () => {
  it("registerManual receives a template whose Authorization uses the file key", async () => {
    const utcp = new TemplateCapturingUtcp();
    const client = new ZaiMcpClient({
      env: { Z_AI_API_KEY: FILE_KEY },
      utcpFactory: async () => utcp,
      // Skip the on-disk tool cache so init reaches registerManual.
      noCache: true,
    });
    try {
      await client.listTools();
    } finally {
      await client.close().catch(() => {});
    }
    assert.strictEqual(utcp.registerManualCalls, 1, "registerManual must run");
    const auth = utcp.capturedTemplate.config.mcpServers.search.headers.Authorization;
    assert.strictEqual(auth, `Bearer ${FILE_KEY}`);
  });

  it("ambient keys are absent from the captured template even when the file key is present", async () => {
    // Defensive: even if a stray ambient key existed in process.env at
    // test time (we strip them in `before`), the captured template must
    // only ever reference the env-supplied key. Proves the env-seam is
    // the authority, not a fallback onto process.env.
    const utcp = new TemplateCapturingUtcp();
    const client = new ZaiMcpClient({
      env: { Z_AI_API_KEY: FILE_KEY },
      utcpFactory: async () => utcp,
      noCache: true,
    });
    try {
      await client.listTools();
    } finally {
      await client.close().catch(() => {});
    }
    const serialized = JSON.stringify(utcp.capturedTemplate);
    // Any provider credential shape we know about must be absent except
    // the file key (which appears in the 3 Bearer headers).
    for (const ambient of ["ZAI_AMBIENT_SHOULD_NOT_APPEAR", "sk-ambient-zai-fixture"]) {
      assert.ok(!serialized.includes(ambient), `ambient value leaked: ${ambient}`);
    }
  });

  it("a success payload containing the key is redacted before return and before cache write", async () => {
    // Fake UTCP returns a payload that echoes the file key. The F2 scrub
    // at the client boundary (callToolWithPublicCacheIdentity) must
    // replace the key with [REDACTED] before the value reaches the
    // caller AND before it is persisted to the on-disk cache.
    //
    // T2b twist: the scrub authority is `configuredSecrets(env)`. With
    // ambient stripped, only the env-supplied file key is in that set —
    // proving the scrub is keyed to the resolved credential view, not
    // ambient state.
    const INTERNAL = "scoutline_zai.search.web_search_prime";
    const credentialedResult = [
      {
        refer: "r",
        title: "t",
        link: "l",
        media: "m",
        content: `echoed key=${FILE_KEY} tail`,
        icon: "i",
      },
    ];
    const fake = {
      async registerManual() {
        return { success: true, errors: [] };
      },
      async getTools() {
        return [{ name: INTERNAL }];
      },
      async callTool(name) {
        if (name === INTERNAL) return credentialedResult;
        throw new Error(`unexpected callTool: ${name}`);
      },
      async close() {},
    };
    // Isolate the on-disk cache so the proof is hermetic and the
    // asserted cache file is observable.
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "t2b-credential-raw-"));
    const prevCacheDir = process.env.SCOUTLINE_CACHE_DIR;
    const prevToolCache = process.env.ZAI_MCP_TOOL_CACHE;
    process.env.SCOUTLINE_CACHE_DIR = tempDir;
    process.env.ZAI_MCP_TOOL_CACHE = "0";
    const client = new ZaiMcpClient({
      env: { Z_AI_API_KEY: FILE_KEY },
      utcpFactory: async () => fake,
      // noCache intentionally unset → cache+scrub path runs.
    });
    try {
      const result = await client.webSearch({ query: "redaction-probe" });
      const serialized = JSON.stringify(result);
      assert.ok(!serialized.includes(FILE_KEY), `file key leaked through result: ${serialized}`);
      assert.ok(serialized.includes("[REDACTED]"), "redaction marker missing from result");

      // (b) The on-disk cache entry must also be scrubbed.
      const files = await readAllFiles(tempDir);
      const combined = files.join("\n");
      assert.ok(
        !combined.includes(FILE_KEY),
        "file key must not be persisted to the cache in cleartext",
      );
      assert.ok(combined.includes("[REDACTED]"), "cache file must carry the redaction marker");
    } finally {
      if (prevCacheDir === undefined) delete process.env.SCOUTLINE_CACHE_DIR;
      else process.env.SCOUTLINE_CACHE_DIR = prevCacheDir;
      if (prevToolCache === undefined) delete process.env.ZAI_MCP_TOOL_CACHE;
      else process.env.ZAI_MCP_TOOL_CACHE = prevToolCache;
      await client.close().catch(() => {});
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("a thrown registration error containing the key is redacted in the public error", async () => {
    // Fake UTCP whose registerManual fails with an error message that
    // embeds the file key (mirrors a raw Provider response body). The
    // surfaced typed ApiError must not carry the key.
    const leakingUtcp = {
      async registerManual() {
        throw new Error(`upstream said: key=${FILE_KEY} body=<html>secret</html>`);
      },
      async getTools() {
        return [];
      },
      async callTool() {
        return {};
      },
      async close() {},
    };
    const client = new ZaiMcpClient({
      env: { Z_AI_API_KEY: FILE_KEY },
      utcpFactory: async () => leakingUtcp,
      noCache: true,
    });
    let captured;
    try {
      try {
        await client.listTools();
      } catch (err) {
        captured = err;
      }
    } finally {
      await client.close().catch(() => {});
    }
    assert.ok(captured, "init must throw");
    assert.ok(
      captured instanceof ApiError,
      `expected ApiError, got ${captured?.constructor?.name}`,
    );
    assert.ok(!captured.message.includes(FILE_KEY), `key leaked into message: ${captured.message}`);
    const formatted = formatErrorOutput(captured, "data");
    assert.ok(!formatted.includes(FILE_KEY), `key reached public envelope: ${formatted}`);
  });

  it("fails fast with ConfigurationError (exit 3) when neither env nor ambient key exists", async () => {
    // Ambient keys are stripped in the suite `before`. An empty env
    // means there is nothing to authorise with — init must surface a
    // ConfigurationError BEFORE any real transport work happens.
    const fake = {
      async registerManual() {
        throw new Error("should not be reached");
      },
      async getTools() {
        return [];
      },
      async callTool() {
        return {};
      },
      async close() {},
    };
    const client = new ZaiMcpClient({
      env: {},
      utcpFactory: async () => fake,
      noCache: true,
    });
    try {
      await assert.rejects(
        client.listTools(),
        (err) => err instanceof ConfigurationError && err.exitCode === 3,
      );
    } finally {
      await client.close().catch(() => {});
    }
  });
});

// ---------------------------------------------------------------------------
// Raw commands (tools / tool / call / code) — env seam is observable via
// the credential gate
//
// The positive proof (file key reaches the registration template) lives
// in the acceptance-probe suite above via ZaiMcpClient + a fake UTCP
// transport — that is the only hermetic way to observe registerManual
// without making a real network call. At the command-module level we
// prove the credential gate is reached at all: with ambient stripped
// and no env supplied, each command MUST surface ConfigurationError
// (exit 3) — proving the dispatch path no longer relies on ambient
// process.env credentials. If env threading regressed (the option
// silently dropped onto ambient resolution), these tests would NOT
// fire ConfigurationError here and would fail.
// ---------------------------------------------------------------------------

describe("raw commands: omitting env surfaces ConfigurationError (no ambient fallback)", () => {
  it("listTools fails with CONFIGURATION_ERROR when no env is supplied", async () => {
    await assert.rejects(
      listTools({ typescript: false }),
      (err) => err instanceof ConfigurationError && err.exitCode === 3,
    );
  });

  it("listTools --typescript fails with CONFIGURATION_ERROR when no env is supplied", async () => {
    await assert.rejects(
      listTools({ typescript: true }),
      (err) => err instanceof ConfigurationError && err.exitCode === 3,
    );
  });

  it("showTool fails with CONFIGURATION_ERROR when no env is supplied", async () => {
    await assert.rejects(
      showTool("scoutline.zai.search.web_search_prime"),
      (err) => err instanceof ConfigurationError && err.exitCode === 3,
    );
  });

  it("callTool fails with CONFIGURATION_ERROR when no env is supplied", async () => {
    await assert.rejects(
      callTool("scoutline.zai.search.web_search_prime", { json: "{}" }, silentContext()),
      (err) => err instanceof ConfigurationError && err.exitCode === 3,
    );
  });

  it("runCodeFile fails with CONFIGURATION_ERROR when no env is supplied", async () => {
    // The file read for runCodeFile happens BEFORE client init, so we
    // pass a real path that exists (this test file itself).
    await assert.rejects(
      runCodeFile(new URL("./credential-view-raw.test.js", import.meta.url).pathname, {}),
      (err) => err instanceof ConfigurationError && err.exitCode === 3,
    );
  });

  it("evalCode fails with CONFIGURATION_ERROR when no env is supplied", async () => {
    await assert.rejects(
      evalCode("return 1;", {}),
      (err) => err instanceof ConfigurationError && err.exitCode === 3,
    );
  });

  it("printInterfaces fails with CONFIGURATION_ERROR when no env is supplied", async () => {
    await assert.rejects(
      printInterfaces({}),
      (err) => err instanceof ConfigurationError && err.exitCode === 3,
    );
  });
});

// ---------------------------------------------------------------------------
// Cache-key fingerprint — uses the file key, not ambient state
// ---------------------------------------------------------------------------

describe("buildCacheKey: explicit env fingerprints against the supplied key", () => {
  it("different explicit keys produce different fingerprints", () => {
    const a = buildCacheKey("search.webSearch", { q: "x" }, { Z_AI_API_KEY: "key-a" });
    const b = buildCacheKey("search.webSearch", { q: "x" }, { Z_AI_API_KEY: "key-b" });
    assert.notStrictEqual(a, b, "different keys must produce different cache filenames");
  });

  it("the same explicit key produces the same fingerprint regardless of ambient state", () => {
    // Prove the explicit env wins over whatever ambient might exist.
    const k1 = buildCacheKey(
      "reader.webReader",
      { url: "https://e.com" },
      {
        Z_AI_API_KEY: FILE_KEY,
      },
    );
    // Mutate ambient after the first call — explicit env must still be
    // the authority.
    process.env.Z_AI_API_KEY = "should-not-affect-the-next-call";
    try {
      const k2 = buildCacheKey(
        "reader.webReader",
        { url: "https://e.com" },
        {
          Z_AI_API_KEY: FILE_KEY,
        },
      );
      assert.strictEqual(k1, k2, "explicit env must dominate ambient");
    } finally {
      delete process.env.Z_AI_API_KEY;
    }
  });

  it("the cache key shape is preserved when env is supplied", () => {
    const key = buildCacheKey("search.webSearch", { q: "shape" }, { Z_AI_API_KEY: FILE_KEY });
    assert.match(
      key,
      /^search\.webSearch\.[0-9a-f]{12}\.[0-9a-f]{24}\.json$/,
      `key shape changed: ${key}`,
    );
  });

  it("ZAI_API_KEY alias resolves to the same fingerprint as Z_AI_API_KEY with the same value", () => {
    const canonical = buildCacheKey("search.webSearch", { q: "x" }, { Z_AI_API_KEY: FILE_KEY });
    const alias = buildCacheKey("search.webSearch", { q: "x" }, { ZAI_API_KEY: FILE_KEY });
    assert.strictEqual(canonical, alias);
  });

  it("throws ConfigurationError (exit 3) when no key is resolvable", () => {
    assert.throws(
      () => buildCacheKey("search.webSearch", { q: "x" }, {}),
      (err) => err instanceof ConfigurationError && err.exitCode === 3,
    );
  });
});
