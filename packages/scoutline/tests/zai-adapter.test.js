/**
 * Z.AI Search Adapter (P2-03).
 *
 * Verifies the real Z.AI Adapter contract: argument mapping (no count
 * is ever sent), field mapping (title/link/content/media/publish_date),
 * client close-once semantics, normalized error mapping, cache identity
 * (legacy Z.AI candidate with decoder), and descriptor metadata. Uses
 * a fake `ZaiAdapterClientPort` so no real UTCP or network is touched.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import crypto from "node:crypto";

import { createZaiDescriptor } from "../dist/providers/zai/adapter.js";
import { getMcpToolName } from "../dist/lib/mcp-config.js";
import { FakeUtcpClient } from "./helpers/fake-utcp-client.js";
import { readFixture } from "./helpers/fixtures.js";

const SEARCH_TOOL_PUBLIC_NAME = getMcpToolName("search", "web_search_prime");

// ---------------------------------------------------------------------------
// Fake ZaiAdapterClientPort built on top of FakeUtcpClient so the Adapter
// exercises the same discovered-name raw invocation path the production
// ZaiMcpClient exposes.
// ---------------------------------------------------------------------------

function makeClientFactory({ discoveredTools, resultsByName, errorsByName } = {}) {
  const created = [];
  const factory = (options) => {
    const fake = new FakeUtcpClient({
      discoveredTools,
      resultsByName,
      errorsByName,
    });
    const port = {
      options,
      callToolCalls: [],
      async callToolRaw(name, args) {
        this.callToolCalls.push({ name, args });
        // Mirror the production ZaiMcpClient resolution path: exact
        // internal name first, then public prefix → exactly one
        // discovered name ending in `.<suffix>`. This isolates Adapter
        // tests from the resolution defect coverage in mcp-client tests.
        const tools = fake.discoveredTools;
        let resolved = tools.find((t) => t.name === name);
        if (!resolved && name.startsWith("scoutline.zai.")) {
          const suffix = name.slice("scoutline.zai.".length);
          const matches = tools.filter((t) => t.name.endsWith(`.${suffix}`));
          if (matches.length === 1) resolved = matches[0];
        }
        if (!resolved) {
          throw new Error(`API_ERROR: Unknown tool ${name}`);
        }
        return fake.callTool(resolved.name, args);
      },
      async listTools() {
        return fake.getTools();
      },
      async close() {
        return fake.close();
      },
    };
    // Record both the options the Adapter requested (so tests can assert
    // that internal cache and retry were disabled) and the live port
    // (so tests can read callToolCalls without exposing the fake's
    // internal state through created[]).
    created.push({ options, fake, port });
    return port;
  };
  factory.created = created;
  return factory;
}

// ---------------------------------------------------------------------------
// Test environment — redirect cache to a temp dir and supply a fake key.
// ---------------------------------------------------------------------------

const TEST_API_KEY = "test-zai-api-key-DO-NOT-LEAK";
const EXPECTED_FINGERPRINT = crypto.createHash("sha256").update(TEST_API_KEY).digest("hex");

function withEnv(env, fn) {
  return async () => {
    const saved = {};
    for (const [k, v] of Object.entries(env)) {
      saved[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      return await fn();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };
}

describe("Z.AI Search Adapter — descriptor metadata", () => {
  it("advertises id 'zai' and the search capability only", () => {
    const descriptor = createZaiDescriptor();
    assert.strictEqual(descriptor.id, "zai");
    const caps = descriptor.capabilities();
    assert.ok(caps.has("search"));
    // No Vision/quota/diagnostics in Phase 2.
    assert.ok(!caps.has("quota"));
    assert.ok(!caps.has("diagnostics"));
  });

  it("isConfigured is true only when Z_AI_API_KEY has non-whitespace", () => {
    const d = createZaiDescriptor();
    assert.strictEqual(d.isConfigured({ Z_AI_API_KEY: "k" }), true);
    assert.strictEqual(d.isConfigured({ Z_AI_API_KEY: "" }), false);
    assert.strictEqual(d.isConfigured({ Z_AI_API_KEY: "   " }), false);
    assert.strictEqual(d.isConfigured({}), false);
  });

  it("descriptor creation is side-effect-free (no transport, no I/O)", async () => {
    const factory = makeClientFactory();
    const d = createZaiDescriptor({ clientFactory: factory });
    d.create({ env: { Z_AI_API_KEY: TEST_API_KEY } });
    // No client was constructed just by create().
    assert.strictEqual(factory.created.length, 0);
  });
});

describe("Z.AI Search Adapter — argument mapping (no count)", () => {
  it("sends search_query and optional Provider controls, never count", async () => {
    const fixture = await readFixture("providers", "zai", "tools.json");
    const searchResult = (await readFixture("providers", "zai", "search.json")).result;
    const factory = makeClientFactory({
      discoveredTools: fixture.tools,
      resultsByName: { "scoutline_zai.search.web_search_prime": searchResult },
    });
    const descriptor = createZaiDescriptor({ clientFactory: factory });
    const adapter = descriptor.create({ env: { Z_AI_API_KEY: TEST_API_KEY } });

    await adapter.search.invoke({
      query: "rust async",
      controls: {
        domain: "example.com",
        recency: "oneWeek",
        contentSize: "high",
        location: "cn",
      },
    });

    assert.strictEqual(factory.created.length, 1);
    const port = factory.created[0].port;
    // Adapter disabled client-owned cache and retry.
    assert.strictEqual(port.options.noCache, true);
    assert.strictEqual(port.options.disableRetry, true);

    assert.strictEqual(port.callToolCalls.length, 1);
    const args = port.callToolCalls[0].args;
    assert.strictEqual(args.search_query, "rust async");
    assert.strictEqual(args.search_domain_filter, "example.com");
    assert.strictEqual(args.search_recency_filter, "oneWeek");
    assert.strictEqual(args.content_size, "high");
    assert.strictEqual(args.location, "cn");
    // NEVER sends count.
    assert.strictEqual(args.count, undefined);
  });

  it("bare query sends only search_query", async () => {
    const fixture = await readFixture("providers", "zai", "tools.json");
    const searchResult = (await readFixture("providers", "zai", "search.json")).result;
    const factory = makeClientFactory({
      discoveredTools: fixture.tools,
      resultsByName: { "scoutline_zai.search.web_search_prime": searchResult },
    });
    const descriptor = createZaiDescriptor({ clientFactory: factory });
    const adapter = descriptor.create({ env: { Z_AI_API_KEY: TEST_API_KEY } });
    await adapter.search.invoke({ query: "bare" });
    const args = factory.created[0].port.callToolCalls[0].args;
    assert.deepStrictEqual(args, { search_query: "bare" });
  });
});

describe("Z.AI Search Adapter — field mapping", () => {
  it("maps title/link/content/media/publish_date and discards unknown fields", async () => {
    const fixture = await readFixture("providers", "zai", "tools.json");
    const providerResult = [
      {
        refer: "ignored-refer",
        title: "T1",
        link: "https://example.test/one",
        media: "example.test",
        content: "summary one",
        icon: "ignored-icon",
        publish_date: "2024-05-06",
        unknown_extra: "discarded",
      },
    ];
    const factory = makeClientFactory({
      discoveredTools: fixture.tools,
      resultsByName: { "scoutline_zai.search.web_search_prime": providerResult },
    });
    const descriptor = createZaiDescriptor({ clientFactory: factory });
    const adapter = descriptor.create({ env: { Z_AI_API_KEY: TEST_API_KEY } });
    const out = await adapter.search.invoke({ query: "q" });
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].title, "T1");
    assert.strictEqual(out[0].url, "https://example.test/one");
    assert.strictEqual(out[0].summary, "summary one");
    assert.strictEqual(out[0].source, "example.test");
    assert.strictEqual(out[0].date, "2024-05-06");
    // Unknown fields discarded.
    assert.strictEqual(out[0].unknown_extra, undefined);
    assert.strictEqual(out[0].refer, undefined);
    assert.strictEqual(out[0].icon, undefined);
  });
});

describe("Z.AI Search Adapter — transport lifecycle", () => {
  it("closes the client exactly once on success", async () => {
    const fixture = await readFixture("providers", "zai", "tools.json");
    const searchResult = (await readFixture("providers", "zai", "search.json")).result;
    const factory = makeClientFactory({
      discoveredTools: fixture.tools,
      resultsByName: { "scoutline_zai.search.web_search_prime": searchResult },
    });
    const descriptor = createZaiDescriptor({ clientFactory: factory });
    const adapter = descriptor.create({ env: { Z_AI_API_KEY: TEST_API_KEY } });
    await adapter.search.invoke({ query: "q" });
    assert.strictEqual(factory.created[0].fake.closeCount, 1);
  });

  it("closes the client exactly once on normalized failure", async () => {
    const fixture = await readFixture("providers", "zai", "tools.json");
    const factory = makeClientFactory({
      discoveredTools: fixture.tools,
      errorsByName: {
        "scoutline_zai.search.web_search_prime": new Error("HTTP 500 internal"),
      },
    });
    const descriptor = createZaiDescriptor({ clientFactory: factory });
    const adapter = descriptor.create({ env: { Z_AI_API_KEY: TEST_API_KEY } });
    await assert.rejects(adapter.search.invoke({ query: "q" }));
    assert.strictEqual(factory.created[0].fake.closeCount, 1);
  });
});

describe("Z.AI Search Adapter — error normalization", () => {
  async function runWithError(message) {
    const fixture = await readFixture("providers", "zai", "tools.json");
    const factory = makeClientFactory({
      discoveredTools: fixture.tools,
      errorsByName: {
        "scoutline_zai.search.web_search_prime": new Error(message),
      },
    });
    const descriptor = createZaiDescriptor({ clientFactory: factory });
    const adapter = descriptor.create({ env: { Z_AI_API_KEY: TEST_API_KEY } });
    return adapter.search.invoke({ query: "q" });
  }

  it("maps 401/403 to AUTH_ERROR with no raw body", async () => {
    for (const msg of ["Unauthorized 401", "Forbidden 403"]) {
      await assert.rejects(runWithError(msg), (err) => {
        const text = err instanceof Error ? `${err.message} ${err.code ?? ""}` : String(err);
        assert.match(text, /AUTH_ERROR/);
        assert.ok(!text.includes("Bearer"), `credential leaked: ${text}`);
        return true;
      });
    }
  });

  it("maps timeout to TIMEOUT_ERROR", async () => {
    await assert.rejects(runWithError("operation timed out after 30s"), (err) => {
      assert.match(err.code || "", /TIMEOUT_ERROR/);
      return true;
    });
  });

  it("maps network errors to NETWORK_ERROR", async () => {
    await assert.rejects(runWithError("ECONNREFUSED"), (err) => {
      assert.match(err.code || "", /NETWORK_ERROR/);
      return true;
    });
  });

  it("maps 500 to API_ERROR with no stack or raw body", async () => {
    await assert.rejects(runWithError("HTTP 500 internal"), (err) => {
      const text = err instanceof Error ? `${err.message} ${err.code ?? ""}` : String(err);
      assert.match(text, /API_ERROR/);
      assert.ok(!/at\s+\w+\.\w+\(/.test(text), `stack leaked: ${text}`);
      return true;
    });
  });
});

describe("Z.AI Search Adapter — validation", () => {
  it("rejects empty query before any client construction", async () => {
    const factory = makeClientFactory();
    const descriptor = createZaiDescriptor({ clientFactory: factory });
    const adapter = descriptor.create({ env: { Z_AI_API_KEY: TEST_API_KEY } });
    await assert.rejects(
      async () => adapter.search.validate({ query: "   " }),
      (err) => {
        assert.match(err.code || "", /VALIDATION_ERROR/);
        return true;
      },
    );
    assert.strictEqual(factory.created.length, 0);
  });
});

describe("Z.AI Search Adapter — cache identity", () => {
  it("uses the SHA-256 credential fingerprint and supplies a legacy candidate", async () => {
    const fixture = await readFixture("providers", "zai", "tools.json");
    const searchResult = (await readFixture("providers", "zai", "search.json")).result;
    const factory = makeClientFactory({
      discoveredTools: fixture.tools,
      resultsByName: { "scoutline_zai.search.web_search_prime": searchResult },
    });
    const descriptor = createZaiDescriptor({ clientFactory: factory });
    const adapter = descriptor.create({ env: { Z_AI_API_KEY: TEST_API_KEY } });

    const identity = adapter.search.cacheIdentity({ query: "q" });
    assert.strictEqual(identity.provider, "zai");
    assert.strictEqual(identity.capability, "search");
    assert.strictEqual(identity.credentialFingerprint, EXPECTED_FINGERPRINT);
    assert.deepStrictEqual(identity.request, { query: "q" });
    assert.ok(Array.isArray(identity.legacyCandidates) && identity.legacyCandidates.length >= 1);
  });

  it("legacy candidate decoder maps WebSearchResult to normalized SearchSource", () => {
    const descriptor = createZaiDescriptor();
    const adapter = descriptor.create({ env: { Z_AI_API_KEY: TEST_API_KEY } });
    const identity = adapter.search.cacheIdentity({ query: "q" });
    const decoded = identity.legacyCandidates[0].decode([
      {
        title: "L",
        link: "https://l",
        content: "lc",
        media: "m",
        publish_date: "2024-01-02",
      },
    ]);
    assert.deepStrictEqual(decoded, [
      { title: "L", url: "https://l", summary: "lc", source: "m", date: "2024-01-02" },
    ]);
  });

  it("legacy candidate decoder returns null on invalid raw data", () => {
    const descriptor = createZaiDescriptor();
    const adapter = descriptor.create({ env: { Z_AI_API_KEY: TEST_API_KEY } });
    const identity = adapter.search.cacheIdentity({ query: "q" });
    assert.strictEqual(identity.legacyCandidates[0].decode("not-an-array"), null);
    assert.strictEqual(identity.legacyCandidates[0].decode(null), null);
  });

  it("count is carried only as legacyCount and never into identity.request", () => {
    const descriptor = createZaiDescriptor();
    const adapter = descriptor.create({ env: { Z_AI_API_KEY: TEST_API_KEY } });
    const identity = adapter.search.cacheIdentity({ query: "q" }, { legacyCount: 5 });
    assert.strictEqual(identity.request.count, undefined);
  });
});
