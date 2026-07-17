/**
 * Search Adapter Conformance + Static Registry (P2-05, DESIGN.md §5, §7).
 *
 * One conformance function invokes the SAME SearchRequest through each
 * built-in Adapter (wired to a fake transport) and compares the
 * normalized output to fixtures/normalized/search.json. The expected
 * normalized shape is NOT branched by Provider: each Adapter is fed a
 * Provider-shaped raw response that normalizes to the shared form.
 *
 * Also covers the static production registry: exact order [zai, minimax],
 * unique IDs, pure metadata, side-effect-free creation, configured
 * filtering, and production reachability from src/index.ts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { createZaiDescriptor } from "../dist/providers/zai/adapter.js";
import { createMiniMaxDescriptor } from "../dist/providers/minimax/adapter.js";
import {
  BUILT_IN_PROVIDER_DESCRIPTORS,
  getProviderDescriptor,
  getConfiguredProviderDescriptors,
} from "../dist/providers/registry.js";
import { readFixture } from "./helpers/fixtures.js";
import { FakeUtcpClient } from "./helpers/fake-utcp-client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(__dirname, "..", "src");

// ---------------------------------------------------------------------------
// Shared conformance: same request, same expected normalized output.
// ---------------------------------------------------------------------------

const CONFORMANCE_REQUEST = { query: "conformance query" };

/**
 * Conformance function: invoke the SAME {@link CONFORMANCE_REQUEST} through
 * a Capability produced by an Adapter factory (fed a Provider-shaped raw
 * fixture), and compare the normalized output to the shared fixture.
 *
 * Provider branching is forbidden: every Adapter must converge on this
 * shape. The expected fixture does NOT branch by Provider.
 *
 * Returns the full normalized list (for additional assertions the test
 * may want to add, such as "no Provider-only fields leak through").
 */
async function runSearchConformance(createCapability, rawFixture) {
  const capability = createCapability(rawFixture);
  const normalized = await capability.invoke(CONFORMANCE_REQUEST);
  return [...normalized].map((s) => ({ ...s }));
}

// ---------------------------------------------------------------------------
// Fake transports per Adapter (Adapter factories; the conformance function
// feeds them a Provider-shaped raw fixture)
// ---------------------------------------------------------------------------

/**
 * Z.AI Adapter factory: accepts a raw `WebSearchResult[]`, builds a fake
 * `ZaiAdapterClientPort` via the `clientFactory` dependency, and returns
 * the descriptor's Search Capability. The fake mirrors the discovered-
 * name path used by the production Z.AI Search Adapter.
 */
function makeZaiCapability(rawResult) {
  const factory = (options) => {
    const fake = new FakeUtcpClient({
      discoveredTools: [{ name: "scoutline_zai.search.web_search_prime" }],
      resultsByName: { "scoutline_zai.search.web_search_prime": rawResult },
    });
    return {
      options,
      async callToolRaw(name, args) {
        return fake.callTool("scoutline_zai.search.web_search_prime", args);
      },
      async close() {
        return fake.close();
      },
    };
  };
  const descriptor = createZaiDescriptor({ clientFactory: factory });
  const adapter = descriptor.create({ env: { Z_AI_API_KEY: "k" } });
  return adapter.search;
}

/**
 * MiniMax Adapter factory: accepts a raw MiniMax-shaped envelope, builds a
 * fake SDK constructor that returns the scripted response, and returns
 * the descriptor's Search Capability.
 */
function makeMiniMaxCapability(rawResult) {
  const Constructor = function FakeMiniMaxSdk(_options) {
    return {
      search: {
        async query() {
          return rawResult;
        },
      },
      vision: {
        async describe() {
          throw new Error("unused");
        },
      },
    };
  };
  const descriptor = createMiniMaxDescriptor({ sdkConstructor: Constructor });
  const adapter = descriptor.create({ env: { MINIMAX_API_KEY: "k" } });
  return adapter.search;
}

// ---------------------------------------------------------------------------
// Search conformance: both Adapters converge on the shared normalized form
// ---------------------------------------------------------------------------

describe("Search Adapter conformance — shared normalized output", () => {
  it("both built-in Adapters normalize to fixtures/normalized/search.json", async () => {
    const expected = await readFixture("normalized", "search.json");

    // Z.AI raw response (title/link/content; no media/publish_date so the
    // normalized form carries no source/date — matching MiniMax's shape).
    const zaiRaw = [
      {
        title: "Conformance result one",
        link: "https://example.test/one",
        content: "Shared normalized summary one.",
      },
      {
        title: "Conformance result two",
        link: "https://example.test/two",
        content: "Shared normalized summary two.",
      },
    ];
    const zaiNormalized = await runSearchConformance(makeZaiCapability, zaiRaw);
    assert.deepStrictEqual(zaiNormalized, expected);

    // MiniMax raw response (organic title/link/snippet).
    const minimaxRaw = {
      organic: [
        {
          title: "Conformance result one",
          link: "https://example.test/one",
          snippet: "Shared normalized summary one.",
        },
        {
          title: "Conformance result two",
          link: "https://example.test/two",
          snippet: "Shared normalized summary two.",
        },
      ],
    };
    const minimaxNormalized = await runSearchConformance(
      makeMiniMaxCapability,
      minimaxRaw,
    );
    assert.deepStrictEqual(minimaxNormalized, expected);
  });

  it("normalized output drops Provider-only fields (refer, icon, media, publish_date)", async () => {
    const zaiRaw = [
      {
        title: "Has extra fields",
        link: "https://example.test/extra",
        content: "Should keep only normalized fields.",
        refer: "r1",
        media: "example.test",
        icon: "https://example.test/icon.png",
        publish_date: "2025-01-01",
      },
    ];
    const normalized = await runSearchConformance(makeZaiCapability, zaiRaw);
    const allowed = new Set(["title", "url", "summary", "source", "date"]);
    for (const entry of normalized) {
      for (const key of Object.keys(entry)) {
        assert.ok(
          allowed.has(key),
          `normalized entry should not include Provider-only field "${key}"`,
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Static registry (DESIGN.md §5)
// ---------------------------------------------------------------------------

describe("Static provider registry — BUILT_IN_PROVIDER_DESCRIPTORS", () => {
  it("contains exactly [zai, minimax] in that order", () => {
    assert.deepStrictEqual(
      BUILT_IN_PROVIDER_DESCRIPTORS.map((d) => d.id),
      ["zai", "minimax"],
    );
  });

  it("has unique provider IDs", () => {
    const ids = BUILT_IN_PROVIDER_DESCRIPTORS.map((d) => d.id);
    assert.strictEqual(new Set(ids).size, ids.length);
  });

  it("descriptors expose pure metadata (capabilities + isConfigured, no transport)", () => {
    for (const d of BUILT_IN_PROVIDER_DESCRIPTORS) {
      const caps = d.capabilities();
      assert.ok(caps.has("search"), `${d.id} should advertise search`);
      // Metadata only — no Vision/quota/diagnostics wired in Phase 2.
      assert.ok(!caps.has("quota"));
    }
    const zai = getProviderDescriptor("zai");
    assert.strictEqual(zai.isConfigured({ Z_AI_API_KEY: "k" }), true);
    assert.strictEqual(zai.isConfigured({}), false);
    const mm = getProviderDescriptor("minimax");
    assert.strictEqual(mm.isConfigured({ MINIMAX_API_KEY: "k" }), true);
    assert.strictEqual(mm.isConfigured({}), false);
  });

  it("descriptor creation is side-effect-free (no transport construction)", () => {
    for (const d of BUILT_IN_PROVIDER_DESCRIPTORS) {
      // create() captures env but builds no transport; the capability is
      // returned without invoking any Provider call.
      const adapter = d.create({ env: {} });
      assert.strictEqual(typeof adapter.search, "object");
    }
  });

  it("getConfiguredProviderDescriptors filters by configured credentials", () => {
    const onlyZai = getConfiguredProviderDescriptors({ Z_AI_API_KEY: "k" });
    assert.deepStrictEqual(
      onlyZai.map((d) => d.id),
      ["zai"],
    );

    const onlyMm = getConfiguredProviderDescriptors({ MINIMAX_API_KEY: "k" });
    assert.deepStrictEqual(
      onlyMm.map((d) => d.id),
      ["minimax"],
    );

    const both = getConfiguredProviderDescriptors({
      Z_AI_API_KEY: "k",
      MINIMAX_API_KEY: "k",
    });
    assert.deepStrictEqual(
      both.map((d) => d.id),
      ["zai", "minimax"],
    );

    const neither = getConfiguredProviderDescriptors({});
    assert.deepStrictEqual(
      neither.map((d) => d.id),
      [],
    );
  });

  it("the production registry is reachable from src/index.ts (no dynamic imports)", async () => {
    const indexSource = await fs.readFile(path.join(SRC_DIR, "index.ts"), "utf8");
    assert.ok(
      indexSource.includes("providers/registry"),
      "src/index.ts must import the static provider registry",
    );
    // No dynamic import() of a Provider descriptor.
    assert.ok(
      !/import\s*\(\s*["'][^"']*provider/.test(indexSource),
      "src/index.ts must not dynamically import Provider descriptors",
    );
  });
});
