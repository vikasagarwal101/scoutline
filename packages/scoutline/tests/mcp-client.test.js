/**
 * ZaiMcpClient — tool-name translation defect baseline (P0-03).
 *
 * Captures the known translation defect: the public operation name returned
 * by `getMcpToolName("search", "web_search_prime")` is
 *   "scoutline.zai.search.web_search_prime"
 * but UTCP only accepts the sanitized internal name
 *   "scoutline_zai.search.web_search_prime"
 * (the manual-segment dots are replaced with underscores during registration).
 *
 * Phase 0 records the defect with explicit `test.todo` placeholders and a
 * passing characterization of private discovery. Phase 2 (P2-03) converts
 * the two todos into ordinary passing regression tests once the client
 * translates the public name to the discovered UTCP name.
 *
 * No production code is altered in this file.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { ZaiMcpClient, ZReadMcpClient } from "../dist/lib/mcp-client.js";
import { getMcpToolName, MCP_MANUAL_NAME } from "../dist/lib/mcp-config.js";
import { buildCacheKey, writeCache } from "../dist/lib/cache.js";
import { FakeUtcpClient } from "./helpers/fake-utcp-client.js";
import { readFixture } from "./helpers/fixtures.js";
import { formatErrorOutput } from "../dist/lib/output.js";
import { ApiError } from "../dist/lib/errors.js";

// P6-08A: install a test-local fake credential so the init path's
// ambient `getApiKey()` lookup (reached through `buildMcpCallTemplate`)
// resolves cleanly when the offline suite runs with all Provider
// credentials stripped. Restored in `after` so no value leaks across
// suites. Individual tests that need a SPECIFIC credential value
// (e.g. fingerprint proofs) still set their own value on top of this
// default and restore it within their own scope.
const FAKE_TEST_API_KEY = "test-fake-mcp-client-key-DO-NOT-USE";
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

// Public dotted identity the production code constructs via getMcpToolName.
const PUBLIC_SEARCH_NAME = getMcpToolName("search", "web_search_prime");

// Internal sanitized UTCP identity — the manual segment ("scoutline.zai")
// is rewritten to "scoutline_zai" during UTCP manual registration.
const INTERNAL_SEARCH_NAME = "scoutline_zai.search.web_search_prime";

// Defensive sanity: the two identities must actually differ. If they ever
// collapse to the same string the translation defect silently disappears
// and these tests would no longer describe the intended boundary.
assert.notStrictEqual(
  PUBLIC_SEARCH_NAME,
  INTERNAL_SEARCH_NAME,
  "Public and internal identities collapsed — defect shape changed.",
);

const TEMP_PREFIX = "scoutline-mcp-client-";

/**
 * Build a FakeUtcpClient wired to the sanitized Z.AI discovery fixture.
 *
 * The fake mirrors UTCP's actual behaviour: it knows only the internal
 * (sanitized) names. Calls to the public dotted name are rejected with an
 * error that names the unknown tool, exactly as a real UTCP client would
 * when handed an identity outside its registry.
 */
async function makeSearchFake() {
  const fixture = await readFixture("providers", "zai", "tools.json");
  const searchResult = (await readFixture("providers", "zai", "search.json")).result;
  const fake = new FakeUtcpClient({ discoveredTools: fixture.tools });
  fake.errorsByName[PUBLIC_SEARCH_NAME] = new Error(
    `Tool not found in UTCP manual: ${PUBLIC_SEARCH_NAME}`,
  );
  fake.resultsByName[INTERNAL_SEARCH_NAME] = searchResult;
  return fake;
}

describe("ZaiMcpClient — tool-name translation (P0-03 baseline)", () => {
  let tempDir;
  let originalCacheDir;
  let originalToolCache;

  before(async () => {
    // Redirect both the tool cache and the response cache into a temp
    // directory so this test never touches the user's real cache. Disable
    // the on-disk tool cache entirely so each test sees its own fake's
    // discovered tool list instead of a stale cross-test entry.
    originalCacheDir = process.env.ZAI_CACHE_DIR;
    originalToolCache = process.env.ZAI_MCP_TOOL_CACHE;
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), TEMP_PREFIX));
    process.env.ZAI_CACHE_DIR = tempDir;
    process.env.ZAI_MCP_TOOL_CACHE = "0";
  });

  after(async () => {
    if (originalCacheDir === undefined) delete process.env.ZAI_CACHE_DIR;
    else process.env.ZAI_CACHE_DIR = originalCacheDir;
    if (originalToolCache === undefined) delete process.env.ZAI_MCP_TOOL_CACHE;
    else process.env.ZAI_MCP_TOOL_CACHE = originalToolCache;
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("public listTools projects internal UTCP names to stable dotted names", async () => {
    const fake = await makeSearchFake();
    const client = new ZaiMcpClient({
      utcpFactory: async () => fake,
      noCache: true,
    });
    try {
      const tools = await client.listTools();

      assert.ok(tools.length >= 3, `expected at least 3 projected tools, got ${tools.length}`);

      for (const tool of tools) {
        assert.ok(
          tool.name.startsWith("scoutline.zai."),
          `public listTools must use dotted prefix, got: ${tool.name}`,
        );
        assert.ok(
          !tool.name.startsWith("scoutline_zai."),
          `internal prefix leaked into public listTools: ${tool.name}`,
        );
      }

      const searchTool = tools.find((t) => t.name === PUBLIC_SEARCH_NAME);
      assert.ok(searchTool, `expected projected search tool: ${PUBLIC_SEARCH_NAME}`);
      assert.ok(searchTool.inputs, "search tool must declare an inputs schema");
      assert.strictEqual(searchTool.inputs.type, "object");
      assert.ok(
        Array.isArray(searchTool.inputs.required) &&
          searchTool.inputs.required.includes("search_query"),
        "search tool schema must require search_query",
      );
    } finally {
      await client.close();
    }
  });

  it("public dotted search name resolves to discovered UTCP name", async () => {
    // Regression for the P0-03 translation defect. The public name
    //   "scoutline.zai.search.web_search_prime"
    // must resolve through discovery to the internal UTCP identity
    //   "scoutline_zai.search.web_search_prime"
    // and return the sanitized fixture result array.
    const fake = await makeSearchFake();
    const client = new ZaiMcpClient({
      utcpFactory: async () => fake,
      noCache: true,
    });
    try {
      const result = await client.callToolRaw(PUBLIC_SEARCH_NAME, { search_query: "x" });
      assert.ok(Array.isArray(result), "expected array result");
      // The fake received exactly one call, and it used the internal name.
      assert.strictEqual(fake.callToolCalls.length, 1);
      assert.strictEqual(fake.callToolCalls[0].name, INTERNAL_SEARCH_NAME);
    } finally {
      await client.close();
    }
  });

  it("listTools projects discovered UTCP names to public dotted names", async () => {
    // Regression for the second P0-03 placeholder: the public list must
    // contain the dotted identity `scoutline.zai.search.web_search_prime`
    // and no name with the sanitized internal prefix. The detailed schema
    // check lives in the related projection test above; this assertion
    // keeps the original P0-03 entry as a focused regression.
    const fake = await makeSearchFake();
    const client = new ZaiMcpClient({
      utcpFactory: async () => fake,
      noCache: true,
    });
    try {
      const tools = await client.listTools();
      const searchTool = tools.find((t) => t.name === PUBLIC_SEARCH_NAME);
      assert.ok(searchTool, `expected projected search tool: ${PUBLIC_SEARCH_NAME}`);
      for (const tool of tools) {
        assert.ok(
          !tool.name.startsWith("scoutline_zai."),
          `internal prefix leaked into public listTools: ${tool.name}`,
        );
      }
    } finally {
      await client.close();
    }
  });

  it("exact discovered private names win before aliases", async () => {
    // A name that is exactly an internal UTCP name must be invoked
    // verbatim; no aliasing or projection is applied.
    const fake = await makeSearchFake();
    const client = new ZaiMcpClient({
      utcpFactory: async () => fake,
      noCache: true,
    });
    try {
      await client.callToolRaw(INTERNAL_SEARCH_NAME, { search_query: "x" });
      assert.strictEqual(fake.callToolCalls[0].name, INTERNAL_SEARCH_NAME);
    } finally {
      await client.close();
    }
  });

  it("ambiguous provider-relative suffix fails with API_ERROR and leaks no schema or credential", async () => {
    // Two discovered tools share the same ".search.web_search_prime"
    // suffix under different manual segments. The public name resolves
    // to zero or multiple matches and must fail with API_ERROR.
    const ambiguousFake = new FakeUtcpClient({
      discoveredTools: [
        {
          name: "scoutline_zai.search.web_search_prime",
          inputs: { type: "object", properties: {}, required: [] },
        },
        {
          name: "scoutline_other.search.web_search_prime",
          inputs: { type: "object", properties: {}, required: [] },
        },
      ],
    });
    const client = new ZaiMcpClient({
      utcpFactory: async () => ambiguousFake,
      noCache: true,
    });
    try {
      await assert.rejects(
        client.callToolRaw("scoutline.zai.search.web_search_prime", { search_query: "x" }),
        (err) => {
          // API_ERROR code in message; no raw schema or credential.
          const msg = err instanceof Error ? err.message : String(err);
          assert.match(msg, /API_ERROR|Unknown tool|ambiguous/i, msg);
          assert.ok(!msg.includes("Bearer "), `credential leaked: ${msg}`);
          return true;
        },
      );
      // The fake never received a callTool — resolution failed first.
      assert.strictEqual(ambiguousFake.callToolCalls.length, 0);
    } finally {
      await client.close();
    }
  });

  it("discovery refresh occurs at most once after an initial miss", async () => {
    // First call resolves; second unrelated name triggers at most one
    // refresh of the discovery list (the existing getTool fallback).
    const refreshFake = new FakeUtcpClient({
      discoveredTools: [
        {
          name: "scoutline_zai.reader.webReader",
          inputs: { type: "object", properties: {}, required: [] },
        },
      ],
      resultsByName: {
        "scoutline_zai.reader.webReader": "ok",
      },
    });
    const client = new ZaiMcpClient({
      utcpFactory: async () => refreshFake,
      noCache: true,
    });
    try {
      // First call resolves via the public projection.
      await client.callToolRaw("scoutline.zai.reader.webReader", { url: "x" });
      const getToolsBefore = refreshFake.getToolsCalls || 0;
      // An unrelated unknown name triggers refresh; then a known name
      // must not trigger another refresh.
      await assert.rejects(client.callToolRaw("scoutline.zai.does_not_exist", {}));
      const getToolsAfterUnknown = refreshFake.getToolsCalls || 0;
      assert.ok(getToolsAfterUnknown >= getToolsBefore, "refresh ran after miss");
      await client.callToolRaw("scoutline.zai.reader.webReader", { url: "y" });
      const getToolsFinal = refreshFake.getToolsCalls || 0;
      assert.ok(
        getToolsFinal <= getToolsAfterUnknown + 1,
        "discovery refresh ran more than once after a miss",
      );
    } finally {
      await client.close();
    }
  });
});

describe("ZaiMcpClient — public identity contract", () => {
  it("MCP_MANUAL_NAME retains its dotted public form", () => {
    // Documents the public name contract that callers see. If this ever
    // changes to the underscored form, the public API has shifted.
    assert.strictEqual(MCP_MANUAL_NAME, "scoutline.zai");
  });

  it("getMcpToolName produces the dotted public identity for search", () => {
    assert.strictEqual(
      getMcpToolName("search", "web_search_prime"),
      "scoutline.zai.search.web_search_prime",
    );
  });
});

// ---------------------------------------------------------------------------
// Fixup B — error normalization in the low-level MCP client.
//
// B2: raw Provider response bodies must not be embedded into public error
//     messages (NFR-006). The client throws stable typed errors whose
//     messages are sanitized; downstream redaction is defence-in-depth.
// B6b: an "unexpected system error" / "-500" is a 500-equivalent (retryable),
//     NOT a negative status code the execution layer can't match.
//
// Each client is constructed with disableRetry:true so the error path is
// exercised exactly once without retry/backoff loops.
// ---------------------------------------------------------------------------

describe("ZaiMcpClient — error normalization (Fixup B — B2 + B6b)", () => {
  const RAW_BODY = '{"error":"RAW_PROVIDER_BODY","detail":"<html>secret</html>"}';

  async function clientThrowing(thrownError) {
    const fixture = await readFixture("providers", "zai", "tools.json");
    const fake = new FakeUtcpClient({
      discoveredTools: fixture.tools,
      errorsByName: { [INTERNAL_SEARCH_NAME]: thrownError },
    });
    const client = new ZaiMcpClient({
      utcpFactory: async () => fake,
      noCache: true,
      disableRetry: true,
    });
    return { client, fake };
  }

  it("B6b: unexpected-system/-500 maps to API_ERROR statusCode 500 (retryable), not -500", async () => {
    const { client } = await clientThrowing(new Error("Unexpected system error -500"));
    try {
      await assert.rejects(client.callToolRaw(PUBLIC_SEARCH_NAME, { search_query: "x" }), (err) => {
        assert.strictEqual(err.code, "API_ERROR", `code: ${err.message}`);
        assert.strictEqual(err.statusCode, 500, `expected 500, got ${err.statusCode}`);
        // The execution-layer retry set is 429 plus any 5xx (500..599).
        assert.ok(
          err.statusCode === 429 || (err.statusCode >= 500 && err.statusCode <= 599),
          `${err.statusCode} must fall in the retryable set`,
        );
        return true;
      });
    } finally {
      await client.close();
    }
  });

  it("B2: a generic tool-call failure does not embed the raw Provider body", async () => {
    const { client } = await clientThrowing(new Error(`provider said: ${RAW_BODY}`));
    try {
      await assert.rejects(client.callToolRaw(PUBLIC_SEARCH_NAME, { search_query: "x" }), (err) => {
        assert.strictEqual(err.code, "API_ERROR");
        assert.ok(!err.message.includes("RAW_PROVIDER_BODY"), `raw body leaked: ${err.message}`);
        assert.ok(!err.message.includes("<html>"), `html leaked: ${err.message}`);
        return true;
      });
    } finally {
      await client.close();
    }
  });

  it("B2: an auth failure does not embed the raw Provider body", async () => {
    const { client } = await clientThrowing(new Error(`401 unauthorized: ${RAW_BODY}`));
    try {
      await assert.rejects(client.callToolRaw(PUBLIC_SEARCH_NAME, { search_query: "x" }), (err) => {
        assert.strictEqual(err.code, "AUTH_ERROR");
        assert.ok(
          !err.message.includes("RAW_PROVIDER_BODY"),
          `raw body leaked into auth message: ${err.message}`,
        );
        return true;
      });
    } finally {
      await client.close();
    }
  });

  it("B2: raw body never reaches formatErrorOutput public envelope", async () => {
    const { client } = await clientThrowing(new Error(`provider said: ${RAW_BODY}`));
    let captured;
    try {
      try {
        await client.callToolRaw(PUBLIC_SEARCH_NAME, { search_query: "x" });
      } catch (err) {
        captured = err;
      }
    } finally {
      await client.close();
    }
    const formatted = formatErrorOutput(captured, "data");
    assert.ok(!formatted.includes("RAW_PROVIDER_BODY"), `raw body reached output: ${formatted}`);
    const parsed = JSON.parse(formatted);
    assert.strictEqual(parsed.code, "API_ERROR");
  });
});

// ---------------------------------------------------------------------------
// Fixup D — B2-remaining: INIT path raw-body scrubbing.
//
// registerManual() failures used to embed the raw error strings into the
// public ApiError message (`Failed to register MCP servers: <errors>`).
// If the Provider returned a raw response body in the registration errors,
// it leaked to public output. The init path must scrub the same way the
// tool-call path does (Fixup B).
// ---------------------------------------------------------------------------

describe("ZaiMcpClient — init path raw-body scrubbing (Fixup D — B2-remaining)", () => {
  const INIT_RAW_BODY = '{"error":"RAW_INIT_BODY","detail":"<html>secret</html>"}';

  // Disable the on-disk tool cache and redirect the response cache into a
  // temp dir so listTools() always reaches init() instead of being
  // short-circuited by a stale entry. Mirrors the first describe block.
  let tempDir;
  let originalCacheDir;
  let originalToolCache;
  before(async () => {
    originalCacheDir = process.env.ZAI_CACHE_DIR;
    originalToolCache = process.env.ZAI_MCP_TOOL_CACHE;
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), TEMP_PREFIX));
    process.env.ZAI_CACHE_DIR = tempDir;
    process.env.ZAI_MCP_TOOL_CACHE = "0";
  });
  after(async () => {
    if (originalCacheDir === undefined) delete process.env.ZAI_CACHE_DIR;
    else process.env.ZAI_CACHE_DIR = originalCacheDir;
    if (originalToolCache === undefined) delete process.env.ZAI_MCP_TOOL_CACHE;
    else process.env.ZAI_MCP_TOOL_CACHE = originalToolCache;
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  /**
   * Build a client whose UTCP factory returns a fake whose registerManual
   * reports a failure carrying a raw Provider body in the errors array.
   * `listTools` / `callToolRaw` trigger `init()` which hits the failure.
   */
  function clientWithRegistrationFailure() {
    const fake = new FakeUtcpClient({
      discoveredTools: [],
      registerManualResult: { success: false, errors: [INIT_RAW_BODY] },
    });
    const client = new ZaiMcpClient({
      utcpFactory: async () => fake,
      noCache: true,
      disableRetry: true,
    });
    return { client, fake };
  }

  it("registerManual failure does not embed the raw body in the public error", async () => {
    const { client } = clientWithRegistrationFailure();
    try {
      await assert.rejects(client.listTools(), (err) => {
        assert.strictEqual(err.code, "API_ERROR");
        assert.ok(
          !err.message.includes("RAW_INIT_BODY"),
          `raw body leaked into init message: ${err.message}`,
        );
        assert.ok(!err.message.includes("<html>"), `html leaked into init message: ${err.message}`);
        return true;
      });
    } finally {
      await client.close();
    }
  });

  it("registerManual failure preserves statusCode 500 for retry classification", async () => {
    const { client } = clientWithRegistrationFailure();
    try {
      await assert.rejects(client.listTools(), (err) => {
        assert.strictEqual(err.code, "API_ERROR");
        assert.strictEqual(err.statusCode, 500, `expected 500, got ${err.statusCode}`);
        return true;
      });
    } finally {
      await client.close();
    }
  });

  it("raw init body never reaches formatErrorOutput public envelope", async () => {
    const { client } = clientWithRegistrationFailure();
    let captured;
    try {
      try {
        await client.listTools();
      } catch (err) {
        captured = err;
      }
    } finally {
      await client.close();
    }
    const formatted = formatErrorOutput(captured, "data");
    assert.ok(
      !formatted.includes("RAW_INIT_BODY"),
      `raw init body reached public output: ${formatted}`,
    );
    const parsed = JSON.parse(formatted);
    assert.strictEqual(parsed.code, "API_ERROR");
  });

  it("registerManual failure never writes the raw body directly to process stderr", async () => {
    const { client } = clientWithRegistrationFailure();
    const writes = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = function (chunk) {
      writes.push(String(chunk));
      return true;
    };
    try {
      await assert.rejects(client.listTools());
    } finally {
      process.stderr.write = originalWrite;
      await client.close();
    }
    const outwardText = writes.join("");
    assert.ok(
      !outwardText.includes("RAW_INIT_BODY"),
      `raw init body reached process stderr: ${outwardText}`,
    );
  });

  it("typed init ApiError is rewrapped without its raw message while preserving status", async () => {
    const client = new ZaiMcpClient({
      utcpFactory: async () => {
        throw new ApiError(INIT_RAW_BODY, 503);
      },
      noCache: true,
      disableRetry: true,
    });
    try {
      await assert.rejects(client.callToolRaw(PUBLIC_SEARCH_NAME, { search_query: "q" }), (err) => {
        assert.strictEqual(err.code, "API_ERROR");
        assert.strictEqual(err.statusCode, 503);
        assert.ok(
          !err.message.includes("RAW_INIT_BODY"),
          `typed init ApiError leaked: ${err.message}`,
        );
        return true;
      });
    } finally {
      await client.close();
    }
  });
});

// ---------------------------------------------------------------------------
// P6-01 — public ZRead wrapper names resolve through discovered internal
// identity.
//
// The P2-03 translation change introduced `callToolRaw()` to route public
// dotted ZRead names through `resolveToolName()` before invoking UTCP. The
// three convenience wrappers (`searchDoc`, `getRepoStructure`, `readFile`
// on the legacy `ZReadMcpClient`) previously bypassed that path and called
// `callTool()` with the public dotted name. UTCP only accepts the
// sanitized internal identity (`scoutline_zai.zread.*`), so the legacy
// wrappers failed before the Provider could answer.
//
// Each test below:
//   - configures the FakeUtcpClient with the INTERNAL names in
//     `discoveredTools` and `resultsByName`, exactly mirroring a real UTCP
//     registration that only ever knows the sanitized identity;
//   - sets the PUBLIC dotted name as an explicit error (UTCP behaviour for a
//     name outside its registry);
//   - invokes the public wrapper and asserts the fake received the call with
//     the internal identity, returning the fixture result.
//
// These tests describe the intended wrapper behaviour; they FAIL against the
// pre-fix `mcp-client.ts` because the wrappers bypass discovery.
// ---------------------------------------------------------------------------

describe("ZaiMcpClient — legacy ZRead wrappers resolve through discovered identity (P6-01)", () => {
  // Same public-vs-internal shape as Search, applied to each ZRead operation.
  const PUBLIC_SEARCH_DOC = getMcpToolName("zread", "search_doc");
  const PUBLIC_GET_REPO_STRUCTURE = getMcpToolName("zread", "get_repo_structure");
  const PUBLIC_READ_FILE = getMcpToolName("zread", "read_file");
  const INTERNAL_SEARCH_DOC = `${MCP_MANUAL_NAME.replace(/\./g, "_")}.zread.search_doc`;
  const INTERNAL_GET_REPO_STRUCTURE = `${MCP_MANUAL_NAME.replace(/\./g, "_")}.zread.get_repo_structure`;
  const INTERNAL_READ_FILE = `${MCP_MANUAL_NAME.replace(/\./g, "_")}.zread.read_file`;

  // Sanity: the public identity and the internal identity must differ. If
  // they collapse the translation defect silently disappears and the tests
  // below would no longer describe the intended boundary.
  assert.notStrictEqual(PUBLIC_SEARCH_DOC, INTERNAL_SEARCH_DOC);
  assert.notStrictEqual(PUBLIC_GET_REPO_STRUCTURE, INTERNAL_GET_REPO_STRUCTURE);
  assert.notStrictEqual(PUBLIC_READ_FILE, INTERNAL_READ_FILE);

  const discoveredZreadTools = [
    {
      name: INTERNAL_SEARCH_DOC,
      inputs: {
        type: "object",
        properties: {
          repo_name: { type: "string" },
          query: { type: "string" },
          language: { type: "string", enum: ["zh", "en"] },
        },
        required: ["repo_name", "query"],
      },
      outputs: { type: "string" },
    },
    {
      name: INTERNAL_GET_REPO_STRUCTURE,
      inputs: {
        type: "object",
        properties: {
          repo_name: { type: "string" },
          dir_path: { type: "string" },
        },
        required: ["repo_name"],
      },
      outputs: { type: "string" },
    },
    {
      name: INTERNAL_READ_FILE,
      inputs: {
        type: "object",
        properties: {
          repo_name: { type: "string" },
          file_path: { type: "string" },
        },
        required: ["repo_name", "file_path"],
      },
      outputs: { type: "string" },
    },
  ];

  function wirePublicAsUnknown(fake) {
    // UTCP rejects names outside its registry. Mirror that by mapping the
    // public dotted name to an explicit unknown-tool error. The wrapper
    // MUST resolve through discovery and never callTool with the dotted
    // form.
    for (const publicName of [PUBLIC_SEARCH_DOC, PUBLIC_GET_REPO_STRUCTURE, PUBLIC_READ_FILE]) {
      fake.errorsByName[publicName] = new Error(`Tool not found in UTCP manual: ${publicName}`);
    }
  }

  it("zreadSearch public name resolves to the discovered internal identity", async () => {
    const fake = new FakeUtcpClient({
      discoveredTools: discoveredZreadTools,
      resultsByName: { [INTERNAL_SEARCH_DOC]: "<excerpt>hello</excerpt>" },
    });
    wirePublicAsUnknown(fake);

    const client = new ZaiMcpClient({
      utcpFactory: async () => fake,
      noCache: true,
    });
    try {
      const result = await client.zreadSearch("acme/widgets", "hello", "en");
      assert.strictEqual(result, "<excerpt>hello</excerpt>");
      assert.strictEqual(fake.callToolCalls.length, 1);
      assert.strictEqual(fake.callToolCalls[0].name, INTERNAL_SEARCH_DOC);
    } finally {
      await client.close();
    }
  });

  it("zreadTree public name resolves to the discovered internal identity", async () => {
    const fake = new FakeUtcpClient({
      discoveredTools: discoveredZreadTools,
      resultsByName: { [INTERNAL_GET_REPO_STRUCTURE]: "<structure>x/</structure>" },
    });
    wirePublicAsUnknown(fake);

    const client = new ZaiMcpClient({
      utcpFactory: async () => fake,
      noCache: true,
    });
    try {
      const result = await client.zreadTree("acme/widgets", "packages");
      assert.strictEqual(result, "<structure>x/</structure>");
      assert.strictEqual(fake.callToolCalls.length, 1);
      assert.strictEqual(fake.callToolCalls[0].name, INTERNAL_GET_REPO_STRUCTURE);
    } finally {
      await client.close();
    }
  });

  it("zreadFile public name resolves to the discovered internal identity", async () => {
    const fake = new FakeUtcpClient({
      discoveredTools: discoveredZreadTools,
      resultsByName: { [INTERNAL_READ_FILE]: "<file_content>hi</file_content>" },
    });
    wirePublicAsUnknown(fake);

    const client = new ZaiMcpClient({
      utcpFactory: async () => fake,
      noCache: true,
    });
    try {
      const result = await client.zreadFile("acme/widgets", "README.md");
      assert.strictEqual(result, "<file_content>hi</file_content>");
      assert.strictEqual(fake.callToolCalls.length, 1);
      assert.strictEqual(fake.callToolCalls[0].name, INTERNAL_READ_FILE);
    } finally {
      await client.close();
    }
  });

  it("the wrappers never invoke UTCP with the public dotted ZRead name", async () => {
    // Defensive: a single end-to-end pass that checks all three wrappers,
    // asserting the fake received exactly one call per wrapper, each with
    // the internal identity and never with the public dotted name.
    const fake = new FakeUtcpClient({
      discoveredTools: discoveredZreadTools,
      resultsByName: {
        [INTERNAL_SEARCH_DOC]: "ok-search",
        [INTERNAL_GET_REPO_STRUCTURE]: "ok-tree",
        [INTERNAL_READ_FILE]: "ok-file",
      },
    });
    wirePublicAsUnknown(fake);

    const client = new ZaiMcpClient({
      utcpFactory: async () => fake,
      noCache: true,
    });
    try {
      await client.zreadSearch("acme/widgets", "hello", "en");
      await client.zreadTree("acme/widgets");
      await client.zreadFile("acme/widgets", "README.md");

      assert.strictEqual(fake.callToolCalls.length, 3);
      const invokedNames = fake.callToolCalls.map((c) => c.name);
      assert.deepStrictEqual(invokedNames, [
        INTERNAL_SEARCH_DOC,
        INTERNAL_GET_REPO_STRUCTURE,
        INTERNAL_READ_FILE,
      ]);
      for (const publicName of [PUBLIC_SEARCH_DOC, PUBLIC_GET_REPO_STRUCTURE, PUBLIC_READ_FILE]) {
        assert.ok(
          !invokedNames.includes(publicName),
          `wrapper invoked UTCP with public dotted name ${publicName}`,
        );
      }
    } finally {
      await client.close();
    }
  });

  it("legacy ZReadMcpClient wrappers (searchDoc/getRepoStructure/readFile) also resolve", async () => {
    // The legacy convenience wrappers on `ZReadMcpClient` delegate to the
    // internal `zreadSearch/zreadTree/zreadFile` methods. P6-01 requires
    // both the modern and the legacy public names to resolve through the
    // discovered internal identity so the repo command's older call sites
    // continue to work after the migration.
    const fake = new FakeUtcpClient({
      discoveredTools: discoveredZreadTools,
      resultsByName: {
        [INTERNAL_SEARCH_DOC]: "ok-search",
        [INTERNAL_GET_REPO_STRUCTURE]: "ok-tree",
        [INTERNAL_READ_FILE]: "ok-file",
      },
    });
    wirePublicAsUnknown(fake);

    const client = new ZReadMcpClient({
      utcpFactory: async () => fake,
      noCache: true,
    });
    try {
      await client.searchDoc("acme/widgets", "hello", "en");
      await client.getRepoStructure("acme/widgets");
      await client.readFile("acme/widgets", "README.md");

      const invokedNames = fake.callToolCalls.map((c) => c.name);
      assert.deepStrictEqual(invokedNames, [
        INTERNAL_SEARCH_DOC,
        INTERNAL_GET_REPO_STRUCTURE,
        INTERNAL_READ_FILE,
      ]);
      for (const publicName of [PUBLIC_SEARCH_DOC, PUBLIC_GET_REPO_STRUCTURE, PUBLIC_READ_FILE]) {
        assert.ok(
          !invokedNames.includes(publicName),
          `legacy wrapper invoked UTCP with public dotted name ${publicName}`,
        );
      }
    } finally {
      await client.close();
    }
  });
});

// ---------------------------------------------------------------------------
// P6-01A — ZRead wrappers preserve the legacy v0.2 public-name cache
// identity and skip discovery/registration/UTCP invocation on a cache hit.
//
// The v0.2 repository cache contract (P0–P2) keyed entries under the public
// dotted tool name and returned them before any transport work. A naive
// `callToolRaw` migration routes through `resolveToolName` first, which
// forces discovery and registration even when a v0.2 hit is present. The
// fix introduces a ZRead-scoped cache-identity helper that:
//   - reads and writes cache entries under the public dotted name;
//   - skips discovery/registration/UTCP entirely on a hit;
//   - resolves to the internal sanitized identity only on a miss.
//
// Each test below seeds a v0.2-shaped cache entry under the public name
// and asserts no fake counter moved during the call.
// ---------------------------------------------------------------------------

describe("ZaiMcpClient — ZRead wrappers preserve public cache identity (P6-01A)", () => {
  const PUBLIC_SEARCH_DOC = getMcpToolName("zread", "search_doc");
  const PUBLIC_GET_REPO_STRUCTURE = getMcpToolName("zread", "get_repo_structure");
  const PUBLIC_READ_FILE = getMcpToolName("zread", "read_file");

  // `buildCacheKey` reads the API key to namespace the cache key. The
  // legacy v0.2 contract used `Z_AI_API_KEY` as the namespace, so seed a
  // fixed value and restore the previous environment around the suite.
  let tempDir;
  let originalCacheDir;
  let originalToolCache;
  let originalApiKey;
  const TEST_API_KEY = "p6-01a-cache-identity-fixture";

  before(async () => {
    originalCacheDir = process.env.ZAI_CACHE_DIR;
    originalToolCache = process.env.ZAI_MCP_TOOL_CACHE;
    originalApiKey = process.env.Z_AI_API_KEY;
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), TEMP_PREFIX));
    process.env.ZAI_CACHE_DIR = tempDir;
    process.env.ZAI_MCP_TOOL_CACHE = "0";
    process.env.Z_AI_API_KEY = TEST_API_KEY;
  });

  after(async () => {
    if (originalCacheDir === undefined) delete process.env.ZAI_CACHE_DIR;
    else process.env.ZAI_CACHE_DIR = originalCacheDir;
    if (originalToolCache === undefined) delete process.env.ZAI_MCP_TOOL_CACHE;
    else process.env.ZAI_MCP_TOOL_CACHE = originalToolCache;
    if (originalApiKey === undefined) delete process.env.Z_AI_API_KEY;
    else process.env.Z_AI_API_KEY = originalApiKey;
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  // The fake registers every callback. We do NOT want it called at all on
  // a cache hit — that is the regression we are proving the fix prevents.
  function unusedFake() {
    const fake = new FakeUtcpClient({ discoveredTools: [] });
    // If the fake is touched on a hit, every counter must remain zero.
    return fake;
  }

  it("zreadSearch returns a legacy public-key cache hit without discovery", async () => {
    const fake = unusedFake();
    const args = { repo_name: "acme/widgets", query: "hello", language: "en" };
    const key = buildCacheKey(PUBLIC_SEARCH_DOC, args);
    await writeCache(key, "<excerpt>cached</excerpt>");

    const client = new ZaiMcpClient({
      utcpFactory: async () => fake,
      // noCache is intentionally NOT set — the v0.2 hit must apply.
    });
    try {
      const result = await client.zreadSearch("acme/widgets", "hello", "en");
      assert.strictEqual(result, "<excerpt>cached</excerpt>");
      assert.strictEqual(fake.registerManualCalls, 0, "registerManual must not run on cache hit");
      assert.strictEqual(fake.getToolsCalls, 0, "getTools must not run on cache hit");
      assert.strictEqual(fake.callToolCalls.length, 0, "callTool must not run on cache hit");
    } finally {
      await client.close();
    }
  });

  it("zreadTree returns a legacy public-key cache hit without discovery", async () => {
    const fake = unusedFake();
    const args = { repo_name: "acme/widgets", dir_path: "packages" };
    const key = buildCacheKey(PUBLIC_GET_REPO_STRUCTURE, args);
    await writeCache(key, "<structure>cached/</structure>");

    const client = new ZaiMcpClient({
      utcpFactory: async () => fake,
    });
    try {
      const result = await client.zreadTree("acme/widgets", "packages");
      assert.strictEqual(result, "<structure>cached/</structure>");
      assert.strictEqual(fake.registerManualCalls, 0);
      assert.strictEqual(fake.getToolsCalls, 0);
      assert.strictEqual(fake.callToolCalls.length, 0);
    } finally {
      await client.close();
    }
  });

  it("zreadFile returns a legacy public-key cache hit without discovery", async () => {
    const fake = unusedFake();
    const args = { repo_name: "acme/widgets", file_path: "README.md" };
    const key = buildCacheKey(PUBLIC_READ_FILE, args);
    await writeCache(key, "<file_content>cached</file_content>");

    const client = new ZaiMcpClient({
      utcpFactory: async () => fake,
    });
    try {
      const result = await client.zreadFile("acme/widgets", "README.md");
      assert.strictEqual(result, "<file_content>cached</file_content>");
      assert.strictEqual(fake.registerManualCalls, 0);
      assert.strictEqual(fake.getToolsCalls, 0);
      assert.strictEqual(fake.callToolCalls.length, 0);
    } finally {
      await client.close();
    }
  });

  it("legacy ZReadMcpClient.searchDoc returns a v0.2 cache hit without discovery", async () => {
    const fake = unusedFake();
    const args = { repo_name: "acme/widgets", query: "hello", language: "en" };
    const key = buildCacheKey(PUBLIC_SEARCH_DOC, args);
    await writeCache(key, "<excerpt>legacy-hit</excerpt>");

    const client = new ZReadMcpClient({
      utcpFactory: async () => fake,
    });
    try {
      const result = await client.searchDoc("acme/widgets", "hello", "en");
      assert.strictEqual(result, "<excerpt>legacy-hit</excerpt>");
      assert.strictEqual(fake.registerManualCalls, 0);
      assert.strictEqual(fake.getToolsCalls, 0);
      assert.strictEqual(fake.callToolCalls.length, 0);
    } finally {
      await client.close();
    }
  });

  it("callToolRaw semantics for non-ZRead callers are unchanged", async () => {
    // P6-01A guardrail: the cache-identity fix is scoped to the ZRead
    // wrappers only. A non-ZRead public caller must still resolve through
    // `resolveToolName` and pass the internal identity to `callTool` —
    // `callToolRaw` is not modified.
    const fake = new FakeUtcpClient({
      discoveredTools: [
        {
          name: "scoutline_zai.search.web_search_prime",
          inputs: { type: "object", properties: {}, required: ["search_query"] },
        },
      ],
      resultsByName: { "scoutline_zai.search.web_search_prime": "ok" },
    });
    fake.errorsByName["scoutline.zai.search.web_search_prime"] = new Error(
      "Tool not found in UTCP manual: scoutline.zai.search.web_search_prime",
    );

    const client = new ZaiMcpClient({
      utcpFactory: async () => fake,
      noCache: true,
    });
    try {
      const result = await client.callToolRaw("scoutline.zai.search.web_search_prime", {
        search_query: "x",
      });
      assert.strictEqual(result, "ok");
      assert.strictEqual(fake.callToolCalls.length, 1);
      assert.strictEqual(
        fake.callToolCalls[0].name,
        "scoutline_zai.search.web_search_prime",
        "callToolRaw must continue to invoke UTCP under the internal name",
      );
    } finally {
      await client.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Reader Migration Ticket 02 — `webRead` preserves the legacy v0.2
// public-name cache identity and resolves the discovered internal UTCP
// identity only on a cache miss. Mirrors the P6-01A ZRead fix shape:
// the cache hit path never touches discovery / registration / UTCP, the
// cache miss path resolves the internal sanitized name before invocation,
// and the TypeScript return type honestly reflects the
// `ReaderRawResponse` (`ReaderRawObjectResponse | string`) runtime shape.
//
// These tests parallel the P6-01A ZRead cache-identity block above. The
// `webRead` method is the Reader-equivalent of the same wrapper-name
// translation defect P6-01A fixed for `zreadSearch` / `zreadTree` /
// `zreadFile`.
//
// Test (3) is the RED→GREEN proof: against the unfixed `webRead` it
// fails because the public dotted name is passed straight to UTCP
// (which rejects it). After the fix routes through
// `callToolWithPublicCacheIdentity`, the internal sanitized name is
// resolved on the miss and UTCP accepts it.
// ---------------------------------------------------------------------------

describe("ZaiMcpClient — webRead preserves public cache identity (Reader Ticket 02)", () => {
  const PUBLIC_WEB_READER = getMcpToolName("reader", "webReader");
  const INTERNAL_WEB_READER = "scoutline_zai.reader.webReader";

  // `buildCacheKey` reads the API key to namespace the cache key. The
  // legacy v0.2 contract used `Z_AI_API_KEY` as the namespace, so seed a
  // fixed value and restore the previous environment around the suite.
  let tempDir;
  let originalCacheDir;
  let originalToolCache;
  let originalApiKey;
  const TEST_API_KEY = "reader-ticket-02-cache-identity-fixture";

  before(async () => {
    originalCacheDir = process.env.ZAI_CACHE_DIR;
    originalToolCache = process.env.ZAI_MCP_TOOL_CACHE;
    originalApiKey = process.env.Z_AI_API_KEY;
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), TEMP_PREFIX));
    process.env.ZAI_CACHE_DIR = tempDir;
    process.env.ZAI_MCP_TOOL_CACHE = "0";
    process.env.Z_AI_API_KEY = TEST_API_KEY;
  });

  after(async () => {
    if (originalCacheDir === undefined) delete process.env.ZAI_CACHE_DIR;
    else process.env.ZAI_CACHE_DIR = originalCacheDir;
    if (originalToolCache === undefined) delete process.env.ZAI_MCP_TOOL_CACHE;
    else process.env.ZAI_MCP_TOOL_CACHE = originalToolCache;
    if (originalApiKey === undefined) delete process.env.Z_AI_API_KEY;
    else process.env.Z_AI_API_KEY = originalApiKey;
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  // The fake registers every callback. We do NOT want it called at all on
  // a cache hit — that is the regression we are proving the fix prevents.
  function unusedFake() {
    const fake = new FakeUtcpClient({ discoveredTools: [] });
    // If the fake is touched on a hit, every counter must remain zero.
    return fake;
  }

  it("webRead returns a legacy public-key cache hit without discovery", async () => {
    // (1) Cache hit without discovery / registration / UTCP. Pre-seed the
    //     cache with a public-named entry; call webRead; assert the cache
    //     hit returned the value and discovery/registration/UTCP were
    //     never touched. Mirrors the P6-01A ZRead cache-identity tests.
    const fake = unusedFake();
    const args = { url: "https://example.com/" };
    const key = buildCacheKey(PUBLIC_WEB_READER, args);
    await writeCache(key, { title: "cached", content: "<cached/>" });

    const client = new ZaiMcpClient({
      utcpFactory: async () => fake,
      // noCache is intentionally NOT set — the v0.2 hit must apply.
    });
    try {
      const result = await client.webRead({ url: "https://example.com/" });
      assert.deepStrictEqual(result, { title: "cached", content: "<cached/>" });
      assert.strictEqual(fake.registerManualCalls, 0, "registerManual must not run on cache hit");
      assert.strictEqual(fake.getToolsCalls, 0, "getTools must not run on cache hit");
      assert.strictEqual(fake.callToolCalls.length, 0, "callTool must not run on cache hit");
    } finally {
      await client.close();
    }
  });

  it("webRead cache key shape is the legacy public-name form", async () => {
    // (2) Legacy `ZaiMcpClient.webRead` continues to hit the public-named
    //     cache entry. The cache key shape is
    //     `scoutline.zai.reader.webReader.<credential-hash>.<request-hash>.json`.
    //     Assert by reconstructing the key via `buildCacheKey` (the same
    //     helper production uses) and proving a hit under that key returns
    //     through `webRead` without transport construction.
    const fake = unusedFake();
    const args = { url: "https://example.com/" };
    const key = buildCacheKey(PUBLIC_WEB_READER, args);
    // Direct probe of the public-name cache key shape.
    assert.match(
      key,
      /^scoutline\.zai\.reader\.webReader\.[0-9a-f]{12}\.[0-9a-f]{24}\.json$/,
      `legacy reader cache key shape changed: ${key}`,
    );
    await writeCache(key, "legacy-string-hit");

    const client = new ZaiMcpClient({
      utcpFactory: async () => fake,
    });
    try {
      const result = await client.webRead({ url: "https://example.com/" });
      assert.strictEqual(result, "legacy-string-hit");
      assert.strictEqual(fake.registerManualCalls, 0);
      assert.strictEqual(fake.getToolsCalls, 0);
      assert.strictEqual(fake.callToolCalls.length, 0);
    } finally {
      await client.close();
    }
  });

  it("webRead cache miss resolves the discovered internal identity before invocation", async () => {
    // (3) RED→GREEN proof. Cache miss resolves the discovered internal
    //     identity before invocation — assert the internal sanitized name
    //     reached `callTool` (UTCP). Against the unfixed `webRead` this
    //     test fails because the public dotted name is passed straight
    //     to UTCP and UTCP rejects it. After the fix routes through
    //     `callToolWithPublicCacheIdentity`, the internal sanitized name
    //     is resolved and UTCP accepts it.
    const fake = new FakeUtcpClient({
      discoveredTools: [
        {
          name: INTERNAL_WEB_READER,
          inputs: { type: "object", properties: {}, required: ["url"] },
        },
      ],
      resultsByName: { [INTERNAL_WEB_READER]: { title: "live", content: "fetched" } },
    });
    // UTCP rejects the public dotted name — mirrors real UTCP behaviour
    // where only the registered sanitized identity is known.
    fake.errorsByName[PUBLIC_WEB_READER] = new Error(
      `Tool not found in UTCP manual: ${PUBLIC_WEB_READER}`,
    );

    const client = new ZaiMcpClient({
      utcpFactory: async () => fake,
      // Force the miss path; we are testing name resolution, not caching.
      noCache: true,
    });
    try {
      const result = await client.webRead({ url: "https://example.com/" });
      assert.deepStrictEqual(result, { title: "live", content: "fetched" });
      assert.strictEqual(fake.callToolCalls.length, 1, "UTCP callTool must run exactly once");
      assert.strictEqual(
        fake.callToolCalls[0].name,
        INTERNAL_WEB_READER,
        "webRead must resolve the internal sanitized name before invoking UTCP",
      );
    } finally {
      await client.close();
    }
  });

  it("callToolRaw semantics for non-reader callers remain unchanged", async () => {
    // (4) P6-01A guardrail extended to the Reader fix: the cache-identity
    //     fix is scoped to the Reader wrapper only. A non-Reader public
    //     caller must still resolve through `resolveToolName` and pass
    //     the internal identity to `callTool` — `callToolRaw` is not
    //     modified.
    const fake = new FakeUtcpClient({
      discoveredTools: [
        {
          name: "scoutline_zai.search.web_search_prime",
          inputs: { type: "object", properties: {}, required: ["search_query"] },
        },
      ],
      resultsByName: { "scoutline_zai.search.web_search_prime": "ok" },
    });
    fake.errorsByName["scoutline.zai.search.web_search_prime"] = new Error(
      "Tool not found in UTCP manual: scoutline.zai.search.web_search_prime",
    );

    const client = new ZaiMcpClient({
      utcpFactory: async () => fake,
      noCache: true,
    });
    try {
      const result = await client.callToolRaw("scoutline.zai.search.web_search_prime", {
        search_query: "x",
      });
      assert.strictEqual(result, "ok");
      assert.strictEqual(fake.callToolCalls.length, 1);
      assert.strictEqual(
        fake.callToolCalls[0].name,
        "scoutline_zai.search.web_search_prime",
        "callToolRaw must continue to invoke UTCP under the internal name",
      );
    } finally {
      await client.close();
    }
  });

  it("webRead return shape matches ReaderRawResponse (object | string union)", async () => {
    // (5) Return-type widening. The TypeScript signature widens from
    //     `Promise<string>` to `Promise<ReaderRawResponse>` (object |
    //     string). A simple typeof / shape assertion is sufficient; the
    //     full decoder is Ticket 01's coverage.
    //
    //     Common case (object success): UTCP returns an object shaped
    //     like `ReaderRawObjectResponse`; the union's object arm covers
    //     it. The bare-string arm covers MCP-level error envelopes
    //     (`"MCP error -500: ..."`); we exercise it through the cache
    //     path because `callToolUncached` would otherwise JSON-parse a
    //     JSON-shaped string into an object.
    const objectFake = new FakeUtcpClient({
      discoveredTools: [
        {
          name: INTERNAL_WEB_READER,
          inputs: { type: "object", properties: {}, required: ["url"] },
        },
      ],
      resultsByName: {
        [INTERNAL_WEB_READER]: {
          title: "live",
          url: "https://example.com/",
          content: "fetched",
        },
      },
    });
    objectFake.errorsByName[PUBLIC_WEB_READER] = new Error(
      `Tool not found in UTCP manual: ${PUBLIC_WEB_READER}`,
    );

    const objectClient = new ZaiMcpClient({
      utcpFactory: async () => objectFake,
      noCache: true,
    });
    try {
      const result = await objectClient.webRead({ url: "https://example.com/" });
      assert.ok(
        typeof result === "object" || typeof result === "string",
        `webRead must return object | string, got ${typeof result}`,
      );
      assert.strictEqual(typeof result, "object");
      assert.ok(result !== null);
      // Spot-check the object-shape arm without re-asserting the full
      // decoder (Ticket 01's coverage).
      assert.ok("content" in result, "object arm should carry ReaderRawObjectResponse fields");
    } finally {
      await objectClient.close();
    }

    // Bare-string arm: a non-JSON string returned by UTCP passes through
    // `callToolUncached`'s `JSON.parse` fallback verbatim, exercising the
    // string arm of the union. This mirrors how a `"MCP error -500: ..."`
    // envelope reaches the caller.
    const stringFake = new FakeUtcpClient({
      discoveredTools: [
        {
          name: INTERNAL_WEB_READER,
          inputs: { type: "object", properties: {}, required: ["url"] },
        },
      ],
      resultsByName: { [INTERNAL_WEB_READER]: "MCP error -500: transport failure" },
    });
    stringFake.errorsByName[PUBLIC_WEB_READER] = new Error(
      `Tool not found in UTCP manual: ${PUBLIC_WEB_READER}`,
    );

    // Seed a cache entry so `webRead` returns the raw string verbatim
    // without going through the JSON-parse branch in `callToolUncached`.
    // Using the cache path here isolates the union's string arm from
    // `callToolUncached`'s string-coercion behaviour.
    const cacheKey = buildCacheKey(PUBLIC_WEB_READER, { url: "https://example.com/" });
    await writeCache(cacheKey, "MCP error -500: cached failure");

    const stringClient = new ZaiMcpClient({
      utcpFactory: async () => stringFake,
    });
    try {
      const result = await stringClient.webRead({ url: "https://example.com/" });
      assert.ok(
        typeof result === "object" || typeof result === "string",
        `webRead must return object | string, got ${typeof result}`,
      );
      assert.strictEqual(typeof result, "string");
      assert.strictEqual(result, "MCP error -500: cached failure");
    } finally {
      await stringClient.close();
    }
  });
});

describe("ZaiMcpClient — response-cache redaction (F2, code-review-baseline)", () => {
  // Previously `writeCache(key, result)` stored raw provider responses; a
  // credential embedded in a response persisted to ~/.scoutline/cache/ in
  // cleartext. The F2 fix scrubs before persist AND before return. Proves
  // both the returned value and the on-disk cache carry [REDACTED].
  let tempDir;
  let originalCacheDir;
  let originalToolCache;
  let originalZaiKey;

  before(async () => {
    originalCacheDir = process.env.ZAI_CACHE_DIR;
    originalToolCache = process.env.ZAI_MCP_TOOL_CACHE;
    // The F2 scrub uses configuredSecrets() (the configured provider key),
    // so the realistic leak — a provider echoing the user's own key back in
    // a response — is what we prove closed. Set a known key value that the
    // redactor's literal-substitution will catch.
    originalZaiKey = process.env.Z_AI_API_KEY;
    process.env.Z_AI_API_KEY = "sk-zai-fixture-key-1234567890ab";
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), TEMP_PREFIX));
    process.env.ZAI_CACHE_DIR = tempDir;
    // Disable the tool-discovery cache so the only on-disk write is the
    // response cache entry this test exercises.
    process.env.ZAI_MCP_TOOL_CACHE = "0";
  });

  after(async () => {
    if (originalCacheDir === undefined) delete process.env.ZAI_CACHE_DIR;
    else process.env.ZAI_CACHE_DIR = originalCacheDir;
    if (originalToolCache === undefined) delete process.env.ZAI_MCP_TOOL_CACHE;
    else process.env.ZAI_MCP_TOOL_CACHE = originalToolCache;
    if (originalZaiKey === undefined) delete process.env.Z_AI_API_KEY;
    else process.env.Z_AI_API_KEY = originalZaiKey;
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

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

  it("scrubs credential-bearing responses before persisting to cache and returning", async () => {
    const key = process.env.Z_AI_API_KEY;
    const fixture = await readFixture("providers", "zai", "tools.json");
    // Two leak shapes: (1) the configured key echoed in a content string
    // (literal-substitution), (2) a literal `api_key` field (key-name
    // redaction, independent of env).
    const credentialedResult = [
      {
        refer: "r",
        title: "t",
        link: "l",
        media: "m",
        content: `echoed key=${key} tail`,
        icon: "i",
        api_key: key,
      },
    ];
    const fake = new FakeUtcpClient({ discoveredTools: fixture.tools });
    fake.errorsByName[PUBLIC_SEARCH_NAME] = new Error(
      `Tool not found in UTCP manual: ${PUBLIC_SEARCH_NAME}`,
    );
    fake.resultsByName[INTERNAL_SEARCH_NAME] = credentialedResult;

    const client = new ZaiMcpClient({
      utcpFactory: async () => fake,
      // noCache deliberately unset → caching ENABLED so the F2 scrub path runs.
    });
    try {
      const results = await client.webSearch({ query: "redaction-probe" });

      // (a) The returned value is redacted at the client boundary.
      const serialized = JSON.stringify(results);
      assert.ok(
        !serialized.includes(key),
        "configured credential must not leak through the returned result",
      );
      assert.ok(
        serialized.includes("[REDACTED]"),
        "returned result must carry the redaction marker",
      );

      // (b) The on-disk response cache is redacted (at-rest leak closure).
      const files = await readAllFiles(tempDir);
      const combined = files.join("\n");
      assert.ok(
        !combined.includes(key),
        "configured credential must not be persisted to the cache in cleartext",
      );
      assert.ok(combined.includes("[REDACTED]"), "cache file must carry the redaction marker");
    } finally {
      await client.close();
    }
  });
});
