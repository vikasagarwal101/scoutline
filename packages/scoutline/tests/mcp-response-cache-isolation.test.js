/**
 * N6 (external-review finding, muse-spark + deepseek converged) — the MCP
 * client's OWN response cache must follow the invocation env's isolation.
 *
 * mcp-client.ts callTool/callToolWithPublicCacheIdentity used bare
 * readCache/writeCache, which resolve the SHARED <root>/cache/ even when
 * the client's injected env carries SCOUTLINE_ISOLATED=1 — the tool cache
 * in the same file threaded options.env, the response cache beside it did
 * not. These pins drive callToolRaw through a fake UTCP client and assert
 * the response-cache entry lands under <root>/cache/isolated/<pid>/ with
 * the shared top level untouched, plus the non-isolated default staying
 * byte-identical (shared dir).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { ZaiMcpClient } from "../dist/lib/mcp-client.js";
import { FakeUtcpClient } from "./helpers/fake-utcp-client.js";

const FAKE_KEY = "test-n6-mcp-key-DO-NOT-USE";

const TOOL = { name: "fake.tool.op" };
const ARGS = { q: "n6" };

let tempRoot;
const saved = {};

before(() => {
  // SCOUTLINE_CACHE_DIR both redirects resolution and allowlists the temp
  // root for the store-perimeter guard under node --test; each test points
  // it at its own fresh root.
  saved.SCOUTLINE_CACHE_DIR = process.env.SCOUTLINE_CACHE_DIR;
  // Keep the on-disk TOOL cache out of the way; this file pins the
  // RESPONSE cache.
  saved.ZAI_MCP_TOOL_CACHE = process.env.ZAI_MCP_TOOL_CACHE;
  process.env.ZAI_MCP_TOOL_CACHE = "0";
  // The init path consults ambient credentials (same reason the
  // mcp-client suite installs a test-local key).
  saved.Z_AI_API_KEY = process.env.Z_AI_API_KEY;
  process.env.Z_AI_API_KEY = FAKE_KEY;
});

after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
});

function freshRoot() {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scoutline-n6-mcp-"));
  process.env.SCOUTLINE_CACHE_DIR = tempRoot;
  return tempRoot;
}

function entryFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => name.endsWith(".json"));
}

async function driveClient(env) {
  const fake = new FakeUtcpClient({
    discoveredTools: [TOOL],
    resultsByName: { [TOOL.name]: { ok: true } },
  });
  const client = new ZaiMcpClient({ utcpFactory: async () => fake, env });
  try {
    const result = await client.callToolRaw(TOOL.name, ARGS);
    assert.deepEqual(result, { ok: true });
  } finally {
    await client.close().catch(() => {});
  }
}

describe("MCP client response cache follows the invocation env's isolation (N6)", () => {
  it("isolated env: response-cache entry lands under cache/isolated/<pid>/, shared top level untouched", async () => {
    const root = freshRoot();
    await driveClient({ Z_AI_API_KEY: FAKE_KEY, SCOUTLINE_ISOLATED: "1" });

    const isolatedDir = path.join(tempRoot, "cache", "isolated", `${process.pid}`);
    const isolatedEntries = entryFiles(isolatedDir);
    assert.ok(
      isolatedEntries.length >= 1,
      `expected a response-cache entry under ${isolatedDir}, found: ${isolatedEntries.join(", ")}`,
    );

    const sharedTop = entryFiles(path.join(tempRoot, "cache"));
    assert.deepEqual(
      sharedTop,
      [],
      "isolated run must not write response-cache entries into the shared cache/ top level",
    );

    // Read-path teeth: a second isolated client with a fresh fake must
    // serve the SAME call from the isolated cache without touching the
    // transport — if the read resolved the shared dir it would miss and
    // re-invoke the tool.
    const fake2 = new FakeUtcpClient({
      discoveredTools: [TOOL],
      resultsByName: { [TOOL.name]: { ok: true } },
    });
    const client2 = new ZaiMcpClient({
      utcpFactory: async () => fake2,
      env: { Z_AI_API_KEY: FAKE_KEY, SCOUTLINE_ISOLATED: "1" },
    });
    try {
      const hit = await client2.callToolRaw(TOOL.name, ARGS);
      assert.deepEqual(hit, { ok: true });
      assert.equal(
        fake2.callToolCalls.length,
        0,
        "cache HIT must come from the isolated subtree; a transport call means the read resolved the shared dir",
      );
    } finally {
      await client2.close().catch(() => {});
    }
  });

  it("non-isolated env: response-cache entry lands in the shared cache/ (default unchanged)", async () => {
    const root = freshRoot();
    await driveClient({ Z_AI_API_KEY: FAKE_KEY });

    const sharedTop = entryFiles(path.join(tempRoot, "cache"));
    assert.ok(
      sharedTop.length >= 1,
      `expected the non-isolated entry in shared cache/, found: ${sharedTop.join(", ")}`,
    );
    assert.ok(
      !fs.existsSync(path.join(tempRoot, "cache", "isolated")),
      "non-isolated run must not create an isolated subtree",
    );
  });
});

// ---------------------------------------------------------------------------
// #189 — the TOOL-cache env wiring is pinned at the client level too.
// mcp-client.ts:555/:566 thread this.options.env into read/writeToolCache;
// these pins drive listTools() through the fake UTCP factory (the public
// path to discoverTools) and assert the tool-cache entry lands under
// <root>/tools/isolated/<pid>/ with the shared top level untouched.
// Teeth: mutation — drop the env arg at the two tool-cache sites and this
// block fails while the response-cache blocks above stay green.
// ---------------------------------------------------------------------------
describe("#189 — MCP tool-cache isolation (client-level pin)", () => {
  before(() => {
    // The file-level before() parks the tool cache OUT of the way
    // (ZAI_MCP_TOOL_CACHE=0); this block re-enables it — the subject here
    // IS the tool cache. Restored by the file-level after() via the saved
    // value.
    process.env.ZAI_MCP_TOOL_CACHE = "1";
  });

  function toolEntryFiles(dir) {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((name) => name.endsWith(".json"));
  }

  it("isolated client: tool-cache entry lands under tools/isolated/<pid>, shared tools/ untouched", async () => {
    const root = freshRoot();
    const fake = new FakeUtcpClient({ discoveredTools: [TOOL] });
    const client = new ZaiMcpClient({
      utcpFactory: async () => fake,
      env: { Z_AI_API_KEY: FAKE_KEY, SCOUTLINE_CACHE_DIR: root, SCOUTLINE_ISOLATED: "1" },
    });
    try {
      const tools = await client.listTools();
      assert.equal(tools.length, 1, "fake tool must be discovered through listTools");
    } finally {
      await client.close().catch(() => {});
    }
    const shared = path.join(root, "tools");
    const isolated = path.join(root, "tools", "isolated", String(process.pid));
    assert.equal(toolEntryFiles(shared).length, 0, "shared tools/ top level must stay empty");
    const isolatedEntries = toolEntryFiles(isolated);
    assert.ok(isolatedEntries.length > 0, `expected a tool-cache entry under ${isolated}`);
  });

  it("isolated read path: a SECOND isolated client serves from the isolated cache — zero UTCP discovery calls", async () => {
    const root = freshRoot();
    const first = new ZaiMcpClient({
      utcpFactory: async () => new FakeUtcpClient({ discoveredTools: [TOOL] }),
      env: { Z_AI_API_KEY: FAKE_KEY, SCOUTLINE_CACHE_DIR: root, SCOUTLINE_ISOLATED: "1" },
    });
    await first.listTools().catch(() => {});
    await first.close().catch(() => {});
    // Second client, fresh fake: the ONLY way it sees the tool without
    // discovery is reading the isolated cache entry the first wrote.
    const secondFake = new FakeUtcpClient({ discoveredTools: [] });
    const second = new ZaiMcpClient({
      utcpFactory: async () => secondFake,
      env: { Z_AI_API_KEY: FAKE_KEY, SCOUTLINE_CACHE_DIR: root, SCOUTLINE_ISOLATED: "1" },
    });
    try {
      const tools = await second.listTools();
      assert.equal(tools.length, 1, "must serve the cached tool from the isolated entry");
      assert.equal(secondFake.getToolsCalls, 0, "read must resolve the ISOLATED dir — a discovery call means it did not");
    } finally {
      await second.close().catch(() => {});
    }
  });

  it("non-isolated client: tool-cache entry stays in the shared tools/ dir", async () => {
    const root = freshRoot();
    const fake = new FakeUtcpClient({ discoveredTools: [TOOL] });
    const client = new ZaiMcpClient({
      utcpFactory: async () => fake,
      env: { Z_AI_API_KEY: FAKE_KEY, SCOUTLINE_CACHE_DIR: root },
    });
    try {
      const tools = await client.listTools();
      assert.equal(tools.length, 1);
    } finally {
      await client.close().catch(() => {});
    }
    const shared = path.join(root, "tools");
    const entries = toolEntryFiles(shared);
    assert.ok(entries.length > 0, "shared tools/ must carry the entry when not isolated");
    assert.ok(!fs.existsSync(path.join(root, "tools", "isolated")), "no isolated/ subtree without isolation");
  });
});
