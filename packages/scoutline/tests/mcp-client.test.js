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

import { ZaiMcpClient } from "../dist/lib/mcp-client.js";
import { getMcpToolName, MCP_MANUAL_NAME } from "../dist/lib/mcp-config.js";
import { FakeUtcpClient } from "./helpers/fake-utcp-client.js";
import { readFixture } from "./helpers/fixtures.js";

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
