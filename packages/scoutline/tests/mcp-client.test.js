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
import { describe, it, test, before, after } from "node:test";
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

  before(async () => {
    // Redirect both the tool cache and the response cache into a temp
    // directory so this test never touches the user's real cache.
    originalCacheDir = process.env.ZAI_CACHE_DIR;
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), TEMP_PREFIX));
    process.env.ZAI_CACHE_DIR = tempDir;
  });

  after(async () => {
    if (originalCacheDir === undefined) delete process.env.ZAI_CACHE_DIR;
    else process.env.ZAI_CACHE_DIR = originalCacheDir;
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("private discovery exposes exact UTCP names with internal prefix", async () => {
    const fake = await makeSearchFake();
    const client = new ZaiMcpClient({
      utcpFactory: async () => fake,
      noCache: true,
    });
    try {
      const tools = await client.listTools();

      assert.ok(tools.length >= 3, `expected at least 3 sanitized tools, got ${tools.length}`);

      for (const tool of tools) {
        assert.ok(
          tool.name.startsWith("scoutline_zai."),
          `private discovery must use internal prefix, got: ${tool.name}`,
        );
      }

      const searchTool = tools.find((t) => t.name === INTERNAL_SEARCH_NAME);
      assert.ok(searchTool, `expected internal search tool: ${INTERNAL_SEARCH_NAME}`);
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

  // P2-03 condition: client.webSearch({ query: "..." }) must invoke
  // client.callTool(INTERNAL_SEARCH_NAME, { search_query: "..." }) and
  // resolve with the fixture's sanitized result array. The current
  // implementation forwards PUBLIC_SEARCH_NAME, which UTCP rejects with
  // an unknown-tool error, so this test is recorded as a TODO rather than
  // a failure. P2-03 replaces this placeholder with a body that asserts
  // the fake received INTERNAL_SEARCH_NAME and returned the fixture result.
  test.todo("public dotted search name resolves to discovered UTCP name");

  // P2-03 condition: client.listTools() must project each internal UTCP
  // name (e.g. "scoutline_zai.search.web_search_prime") back to the
  // public dotted form (e.g. "scoutline.zai.search.web_search_prime")
  // produced by getMcpToolName. The current implementation returns the
  // internal names verbatim, which leaks the sanitized boundary into
  // callers. P2-03 replaces this placeholder with an assertion that
  // every returned tool name matches getMcpToolName(server, tool).
  test.todo("listTools projects discovered UTCP names to public dotted names");
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