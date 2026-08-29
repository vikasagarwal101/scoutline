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
import { createTavilyDescriptor } from "../dist/providers/tavily/adapter.js";
import { createExaDescriptor } from "../dist/providers/exa/adapter.js";
import { createBraveDescriptor } from "../dist/providers/brave/adapter.js";
import { createFirecrawlDescriptor } from "../dist/providers/firecrawl/adapter.js";
import { createParallelDescriptor, ParallelAdapter } from "../dist/providers/parallel/adapter.js";
import { createPerplexityDescriptor, PerplexityAdapter } from "../dist/providers/perplexity/adapter.js";
import { createJinaDescriptor, JinaAdapter } from "../dist/providers/jina/adapter.js";
import { createYouDescriptor } from "../dist/providers/you/adapter.js";
import { createLinkupDescriptor } from "../dist/providers/linkup/adapter.js";
import { createSpiderDescriptor } from "../dist/providers/spider/adapter.js";
import {
  BUILT_IN_PROVIDER_DESCRIPTORS,
  getProviderDescriptor,
  getConfiguredProviderDescriptors,
} from "../dist/providers/registry.js";
import { readFixture } from "./helpers/fixtures.js";
import { FakeUtcpClient } from "./helpers/fake-utcp-client.js";
import { TimeoutError } from "../dist/lib/errors.js";

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

/**
 * Compare a Provider's normalized search output to the shared fixture.
 *
 * The fixture pins the core fields (title/url/summary) every Provider
 * must converge on. The OPTIONAL `source`/`date` fields of
 * SearchSource are provider-variable — e.g. Spider.cloud attributes
 * every row to "spider.cloud" — so they are constrained to the
 * documented optional-key set instead of being required absent. For
 * every Provider whose fixture produces no optional fields this is
 * exactly the previous deepStrictEqual against the fixture.
 */
function assertMatchesSharedSearchFixture(normalized, expected, id) {
  const core = normalized.map(({ title, url, summary }) => ({ title, url, summary }));
  assert.deepStrictEqual(
    core,
    expected,
    `Provider "${id}" must normalize its raw fixture to the shared normalized form`,
  );
  for (const entry of normalized) {
    for (const key of Object.keys(entry)) {
      assert.ok(
        key === "title" || key === "url" || key === "summary" || key === "source" || key === "date",
        `Provider "${id}" normalized entry carries non-contract field "${key}"`,
      );
    }
  }
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
 * fake fetch that returns the scripted response, and returns the
 * descriptor's Search Capability.
 */
function makeMiniMaxCapability(rawResult) {
  // Wrap the raw envelope in a fetch response carrying `base_resp` so
  // the direct-transport envelope check passes.
  const fetchFn = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(rawResult),
    json: async () => ({ ...rawResult, base_resp: { status_code: 0 } }),
    headers: { get: () => null },
    arrayBuffer: async () => new ArrayBuffer(0),
  });
  const descriptor = createMiniMaxDescriptor({ transport: { fetch: fetchFn } });
  const adapter = descriptor.create({ env: { MINIMAX_API_KEY: "k" } });
  return adapter.search;
}

/**
 * Brave Adapter factory: accepts a raw Brave-shaped web response
 * (`web.results[]`), builds a fake fetch that returns the scripted
 * response, and returns the descriptor's Search Capability. Mirrors
 * `makeMiniMaxCapability`.
 */
function makeBraveCapability(rawResult) {
  const fetchFn = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(rawResult),
    json: async () => rawResult,
    headers: { get: () => null },
    arrayBuffer: async () => new ArrayBuffer(0),
  });
  const descriptor = createBraveDescriptor({ transport: { fetch: fetchFn } });
  const adapter = descriptor.create({ env: { BRAVE_SEARCH_API_KEY: "k" } });
  return adapter.search;
}

/**
 * Tavily Adapter factory: accepts a raw Tavily-shaped response
 * (`results[].title/url/content`), builds a fake fetch that returns the
 * scripted response, and returns the descriptor's Search Capability.
 */
function makeTavilyCapability(rawResult) {
  const fetchFn = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(rawResult),
    json: async () => rawResult,
    headers: { get: () => null },
    arrayBuffer: async () => new ArrayBuffer(0),
  });
  const descriptor = createTavilyDescriptor({ transport: { fetch: fetchFn } });
  const adapter = descriptor.create({ env: { TAVILY_API_KEY: "k" } });
  return adapter.search;
}

/**
 * Exa Adapter factory: accepts a raw Exa-shaped response
 * (`results[].title/url/highlights`), builds a fake fetch, and returns
 * the descriptor's Search Capability.
 */
function makeExaCapability(rawResult) {
  const fetchFn = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(rawResult),
    json: async () => rawResult,
    headers: { get: () => null },
    arrayBuffer: async () => new ArrayBuffer(0),
  });
  const descriptor = createExaDescriptor({ transport: { fetch: fetchFn } });
  const adapter = descriptor.create({ env: { EXA_API_KEY: "k" } });
  return adapter.search;
}

/**
 * Firecrawl Adapter factory: accepts a raw Firecrawl-shaped response
 * (`data.web[].title/url/description`), builds a fake fetch, and returns
 * the descriptor's Search Capability.
 */
function makeFirecrawlCapability(rawResult) {
  const fetchFn = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(rawResult),
    json: async () => rawResult,
    headers: { get: () => null },
    arrayBuffer: async () => new ArrayBuffer(0),
  });
  const descriptor = createFirecrawlDescriptor({ transport: { fetch: fetchFn } });
  const adapter = descriptor.create({ env: { FIRECRAWL_API_KEY: "k" } });
  return adapter.search;
}

/**
 * Spider Adapter factory: accepts a raw Spider-shaped response (flat
 * page array with url + metadata.title/description), builds a fake
 * fetch, and returns the adapter's Search Capability.
 */
function makeSpiderCapability(rawResult) {
  const fetchFn = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(rawResult),
    json: async () => rawResult,
    headers: { get: () => null },
  });
  const descriptor = createSpiderDescriptor({ transport: { fetch: fetchFn } });
  const adapter = descriptor.create({ env: { SPIDER_API_KEY: "k" } });
  return adapter.search;
}

/**
 * Parallel Adapter factory: accepts a raw Parallel-shaped response
 * (`results[].title/url/excerpts`), builds a fake fetch, and returns
 * the adapter's Search Capability.
 */
function makeParallelCapability(rawResult) {
  const fetchFn = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(rawResult),
  });
  const adapter = new ParallelAdapter(
    { env: { PARALLEL_API_KEY: "k" } },
    { transport: { fetch: fetchFn } },
  );
  return adapter.search;
}

/**
 * Perplexity Adapter factory: accepts a raw Perplexity-shaped response
 * (`results[].title/url/snippet`), builds a fake fetch, and returns
 * the adapter's Search Capability.
 */
function makePerplexityCapability(rawResult) {
  const fetchFn = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(rawResult),
  });
  const adapter = new PerplexityAdapter(
    { env: { PERPLEXITY_API_KEY: "k" } },
    { transport: { fetch: fetchFn } },
  );
  return adapter.search;
}

/**
 * Jina Adapter factory: accepts a raw Jina-shaped response
 * (`data[].title/url/description`), builds a fake fetch, and returns
 * the adapter's Search Capability.
 */
function makeJinaCapability(rawResult) {
  const fetchFn = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(rawResult),
  });
  const adapter = new JinaAdapter(
    { env: {} },
    { transport: { fetch: fetchFn } },
  );
  return adapter.search;
}

/**
 * You.com Adapter factory: accepts a raw You.com-shaped response
 * (`results.web[].title/url/description`), builds a fake fetch, and
 * returns the descriptor's Search Capability.
 */
function makeYouCapability(rawResult) {
  const fetchFn = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(rawResult),
    json: async () => rawResult,
    headers: { get: () => null },
  });
  const descriptor = createYouDescriptor({ transport: { fetch: fetchFn } });
  const adapter = descriptor.create({ env: { YDC_API_KEY: "k" } });
  return adapter.search;
}

/**
 * Linkup Adapter factory: accepts a raw Linkup-shaped response
 * (`results[].name/url/content`), builds a fake fetch, and returns the
 * descriptor's Search Capability.
 */
function makeLinkupCapability(rawResult) {
  const fetchFn = async () => ({
    ok: true,
    status: 200,
    json: async () => rawResult,
    text: async () => JSON.stringify(rawResult),
    headers: { get: () => null },
  });
  const descriptor = createLinkupDescriptor({ transport: { fetch: fetchFn } });
  const adapter = descriptor.create({ env: { LINKUP_API_KEY: "k" } });
  return adapter.search;
}

// ---------------------------------------------------------------------------
// Vision conformance: same interpret-image request, same normalized text (P3-03)
// ---------------------------------------------------------------------------

const VISION_CONFORMANCE_REQUEST = {
  operation: "interpret-image",
  source: "https://example.test/conformance.png",
  instruction: "Describe this image.",
};
const VISION_CONFORMANCE_EXPECTED = "A clear description of the shared conformance image.";

/**
 * Z.AI Vision Capability factory: accepts a raw direct-text result and
 * returns the descriptor's Vision Capability.
 */
function makeZaiVisionCapability(rawResult) {
  const factory = (options) => {
    const fake = new FakeUtcpClient({
      discoveredTools: [{ name: "scoutline_zai.vision.analyze_image" }],
      resultsByName: { "scoutline_zai.vision.analyze_image": rawResult },
    });
    return {
      options,
      async callToolRaw(name, args) {
        return fake.callTool("scoutline_zai.vision.analyze_image", args);
      },
      async close() {
        return fake.close();
      },
    };
  };
  const descriptor = createZaiDescriptor({ clientFactory: factory });
  const adapter = descriptor.create({ env: { Z_AI_API_KEY: "k" } });
  return adapter.vision;
}

/**
 * MiniMax Vision Capability factory: accepts a raw characterized envelope
 * and returns the descriptor's Vision Capability. The fake fetch serves
 * an HTTP image response for the data-URI conversion step and a VLM
 * response with the script result for the transport call.
 */
function makeMiniMaxVisionCapability(rawResult) {
  let i = 0;
  const fetchFn = async () => {
    const which = i++;
    if (which === 0) {
      // Image fetch (PNG bytes).
      return {
        ok: true,
        status: 200,
        text: async () => "",
        json: async () => ({}),
        headers: { get: (name) => (name.toLowerCase() === "content-type" ? "image/png" : null) },
        arrayBuffer: async () =>
          new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).buffer,
      };
    }
    // VLM response.
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(rawResult),
      json: async () => ({ ...rawResult, base_resp: { status_code: 0 } }),
      headers: { get: () => null },
      arrayBuffer: async () => new ArrayBuffer(0),
    };
  };
  const descriptor = createMiniMaxDescriptor({ transport: { fetch: fetchFn } });
  const adapter = descriptor.create({ env: { MINIMAX_API_KEY: "k" } });
  return adapter.vision;
}

// ---------------------------------------------------------------------------
// Search conformance: both Adapters converge on the shared normalized form
// ---------------------------------------------------------------------------

describe("Search Adapter conformance — shared normalized output", () => {
  it("all configured Adapters normalize to fixtures/normalized/search.json", async () => {
    const expected = await readFixture("normalized", "search.json");

    // Factories and raw fixtures are registered in the CI completeness
    // gate section below (SEARCH_CONFORMANCE_FACTORIES and
    // SEARCH_CONFORMANCE_RAW). `it` callbacks run after module
    // evaluation, so the forward reference is safe. Iterating the
    // registration means a newly registered Provider is exercised here
    // without hand-writing another per-Provider block.
    for (const [id, factory] of SEARCH_CONFORMANCE_FACTORIES) {
      const raw = SEARCH_CONFORMANCE_RAW.get(id);
      assert.ok(
        raw !== undefined,
        `Provider "${id}" has a conformance factory but no raw fixture in SEARCH_CONFORMANCE_RAW.`,
      );
      const normalized = await runSearchConformance(factory, raw);
      assertMatchesSharedSearchFixture(normalized, expected, id);
    }
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
// CI completeness gate: every search-advertising Provider must have a factory
// ---------------------------------------------------------------------------

/**
 * Map of Provider ID → factory function for search conformance. Each
 * entry MUST be a real callable factory that accepts a provider-shaped
 * raw fixture (see SEARCH_CONFORMANCE_RAW) and returns a
 * SearchCapability. When a new Provider is added to the registry, its
 * factory and raw fixture must be added here. This guard prevents
 * silent onboarding gaps — the gate below checks registration AND
 * executes every factory through runSearchConformance, so adding just
 * the ID, or a factory whose suite does not actually run, will fail
 * (#59).
 */
const SEARCH_CONFORMANCE_FACTORIES = new Map([
  ["zai", makeZaiCapability],
  ["minimax", makeMiniMaxCapability],
  ["tavily", makeTavilyCapability],
  ["exa", makeExaCapability],
  ["brave", makeBraveCapability],
  ["firecrawl", makeFirecrawlCapability],
  ["parallel", makeParallelCapability],
  ["perplexity", makePerplexityCapability],
  ["jina", makeJinaCapability],
  ["you", makeYouCapability],
  ["linkup", makeLinkupCapability],
  ["spider", makeSpiderCapability],
]);

/**
 * Map of Provider ID → Provider-shaped raw fixture for search
 * conformance. Each raw shape MUST normalize — through the matching
 * factory in SEARCH_CONFORMANCE_FACTORIES — to the SAME shared
 * fixtures/normalized/search.json form. The expected normalized shape
 * does NOT branch by Provider.
 */
const SEARCH_CONFORMANCE_RAW = new Map([
  // Z.AI raw response (title/link/content; no media/publish_date so the
  // normalized form carries no source/date — matching MiniMax's shape).
  [
    "zai",
    [
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
    ],
  ],
  // MiniMax raw response (organic title/link/snippet).
  [
    "minimax",
    {
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
    },
  ],
  // Brave raw web response (web.results[] with title/url/description;
  // no meta_url/page_age so source/date are absent — matching the
  // shared normalized form).
  [
    "brave",
    {
      web: {
        results: [
          {
            title: "Conformance result one",
            url: "https://example.test/one",
            description: "Shared normalized summary one.",
          },
          {
            title: "Conformance result two",
            url: "https://example.test/two",
            description: "Shared normalized summary two.",
          },
        ],
      },
    },
  ],
  // Tavily raw response (results[].title/url/content).
  [
    "tavily",
    {
      results: [
        {
          title: "Conformance result one",
          url: "https://example.test/one",
          content: "Shared normalized summary one.",
        },
        {
          title: "Conformance result two",
          url: "https://example.test/two",
          content: "Shared normalized summary two.",
        },
      ],
    },
  ],
  // Exa raw response (results[].title/url/highlights[]).
  [
    "exa",
    {
      results: [
        {
          title: "Conformance result one",
          url: "https://example.test/one",
          highlights: ["Shared normalized summary one."],
        },
        {
          title: "Conformance result two",
          url: "https://example.test/two",
          highlights: ["Shared normalized summary two."],
        },
      ],
    },
  ],
  // Firecrawl raw response (data.web[].title/url/description).
  [
    "firecrawl",
    {
      data: {
        web: [
          {
            title: "Conformance result one",
            url: "https://example.test/one",
            description: "Shared normalized summary one.",
          },
          {
            title: "Conformance result two",
            url: "https://example.test/two",
            description: "Shared normalized summary two.",
          },
        ],
      },
    },
  ],
  // Parallel raw response (results[].title/url/excerpts[]).
  [
    "parallel",
    {
      results: [
        {
          title: "Conformance result one",
          url: "https://example.test/one",
          excerpts: ["Shared normalized summary one."],
        },
        {
          title: "Conformance result two",
          url: "https://example.test/two",
          excerpts: ["Shared normalized summary two."],
        },
      ],
    },
  ],
  // Perplexity raw response (results[].title/url/snippet).
  [
    "perplexity",
    {
      results: [
        {
          title: "Conformance result one",
          url: "https://example.test/one",
          snippet: "Shared normalized summary one.",
        },
        {
          title: "Conformance result two",
          url: "https://example.test/two",
          snippet: "Shared normalized summary two.",
        },
      ],
    },
  ],
  // Jina raw response (data[].title/url/description).
  [
    "jina",
    {
      data: [
        {
          title: "Conformance result one",
          url: "https://example.test/one",
          description: "Shared normalized summary one.",
        },
        {
          title: "Conformance result two",
          url: "https://example.test/two",
          description: "Shared normalized summary two.",
        },
      ],
    },
  ],
  // You.com raw response (results.web[].title/url/description; the
  // summary falls back to description when snippets are absent).
  [
    "you",
    {
      results: {
        web: [
          {
            title: "Conformance result one",
            url: "https://example.test/one",
            description: "Shared normalized summary one.",
          },
          {
            title: "Conformance result two",
            url: "https://example.test/two",
            description: "Shared normalized summary two.",
          },
        ],
      },
    },
  ],
  // Linkup raw response (results[].name/url/content).
  [
    "linkup",
    {
      results: [
        {
          name: "Conformance result one",
          url: "https://example.test/one",
          content: "Shared normalized summary one.",
        },
        {
          name: "Conformance result two",
          url: "https://example.test/two",
          content: "Shared normalized summary two.",
        },
      ],
    },
  ],
  // Spider raw response (flat page array; url + metadata.title and
  // metadata.description feed title/summary; rows are attributed to
  // "spider.cloud" via the optional `source` field).
  [
    "spider",
    [
      {
        url: "https://example.test/one",
        metadata: {
          title: "Conformance result one",
          description: "Shared normalized summary one.",
        },
      },
      {
        url: "https://example.test/two",
        metadata: {
          title: "Conformance result two",
          description: "Shared normalized summary two.",
        },
      },
    ],
  ],
]);
describe("CI completeness gate — every search Provider has a conformance factory (6.2)", () => {
  it("all registry providers advertising 'search' have a conformance factory", () => {
    const searchProviders = BUILT_IN_PROVIDER_DESCRIPTORS.filter((d) =>
      d.capabilities().has("search"),
    );
    for (const descriptor of searchProviders) {
      const factory = SEARCH_CONFORMANCE_FACTORIES.get(descriptor.id);
      assert.ok(
        typeof factory === "function",
        `Provider "${descriptor.id}" advertises search but has no conformance factory. ` +
          `Add a make${descriptor.id.charAt(0).toUpperCase() + descriptor.id.slice(1)}Capability ` +
          `factory and register it in SEARCH_CONFORMANCE_FACTORIES.`,
      );
    }
  });

  it("every registered conformance factory EXECUTES a running suite (#59)", async () => {
    // `typeof factory === "function"` alone proves nothing about
    // execution (#59): a registered factory whose suite never runs — or
    // runs but diverges — must fail this gate instead of passing
    // silently. The loop below drives each Provider's full conformance
    // path (factory → capability → invoke(CONFORMANCE_REQUEST) →
    // normalization) and compares the result against the shared fixture.
    const expected = await readFixture("normalized", "search.json");
    assert.ok(
      SEARCH_CONFORMANCE_FACTORIES.size > 0,
      "SEARCH_CONFORMANCE_FACTORIES is empty — no provider conformance is wired",
    );
    for (const [id, factory] of SEARCH_CONFORMANCE_FACTORIES) {
      const raw = SEARCH_CONFORMANCE_RAW.get(id);
      assert.ok(
        raw !== undefined,
        `Provider "${id}" registered a conformance factory but no raw fixture in ` +
          `SEARCH_CONFORMANCE_RAW — its suite cannot execute.`,
      );
      let normalized;
      try {
        normalized = await runSearchConformance(factory, raw);
      } catch (err) {
        assert.fail(`Provider "${id}" conformance suite did not run: ${err?.message ?? err}`);
      }
      assert.ok(
        Array.isArray(normalized) && normalized.length > 0,
        `Provider "${id}" conformance suite produced no normalized results — ` +
          `invoke() did not execute a real path.`,
      );
      assertMatchesSharedSearchFixture(
        normalized,
        expected,
        `${id} (executed)`,
      );
    }
    // The executed set must cover every registry Provider advertising
    // search — the class guard for future onboarding gaps.
    for (const descriptor of BUILT_IN_PROVIDER_DESCRIPTORS) {
      if (!descriptor.capabilities().has("search")) continue;
      assert.ok(
        SEARCH_CONFORMANCE_FACTORIES.has(descriptor.id),
        `Provider "${descriptor.id}" advertises search but the gate executed no ` +
          `conformance suite for it — add a factory and a raw fixture.`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Error sanitization: new adapters must not leak raw upstream messages
// ---------------------------------------------------------------------------

describe("Error sanitization — new adapters strip raw upstream messages (2.1)", () => {
  const SECRET = "Bearer sk-leak-me-12345";

  /**
   * Fake fetch that throws a NetworkError whose message contains a
   * credential — simulating a raw upstream error body leaking through
   * the transport. The adapter's normalizeXxxError must sanitize it.
   */
  function leakingFetch() {
    return async () => {
      throw new Error(`fetch failed: getaddrinfo ENOTFOUND ${SECRET}`);
    };
  }

  it("Parallel search does not leak raw error messages", async () => {
    const adapter = new ParallelAdapter(
      { env: { PARALLEL_API_KEY: "k" } },
      { transport: { fetch: leakingFetch() } },
    );
    await assert.rejects(
      () => adapter.search.invoke({ query: "test" }),
      (err) => !err.message.includes(SECRET),
    );
  });

  it("Perplexity search does not leak raw error messages", async () => {
    const adapter = new PerplexityAdapter(
      { env: { PERPLEXITY_API_KEY: "k" } },
      { transport: { fetch: leakingFetch() } },
    );
    await assert.rejects(
      () => adapter.search.invoke({ query: "test" }),
      (err) => !err.message.includes(SECRET),
    );
  });

  it("Jina search does not leak raw error messages", async () => {
    const adapter = new JinaAdapter(
      { env: {} },
      { transport: { fetch: leakingFetch() } },
    );
    await assert.rejects(
      () => adapter.search.invoke({ query: "test" }),
      (err) => !err.message.includes(SECRET),
    );
  });

  it("You.com search does not leak raw error messages", async () => {
    const adapter = createYouDescriptor({ transport: { fetch: leakingFetch() } }).create({
      env: { YDC_API_KEY: "k" },
    });
    await assert.rejects(
      () => adapter.search.invoke({ query: "test" }),
      (err) => !err.message.includes(SECRET),
    );
  });

  it("Linkup search does not leak raw error messages", async () => {
    const adapter = createLinkupDescriptor({ transport: { fetch: leakingFetch() } }).create({
      env: { LINKUP_API_KEY: "k" },
    });
    await assert.rejects(
      () => adapter.search.invoke({ query: "test" }),
      (err) => !err.message.includes(SECRET),
    );
  });

  it("Spider search does not leak raw error messages", async () => {
    const adapter = createSpiderDescriptor({ transport: { fetch: leakingFetch() } }).create({
      env: { SPIDER_API_KEY: "k" },
    });
    await assert.rejects(
      () => adapter.search.invoke({ query: "test" }),
      (err) => !err.message.includes(SECRET),
    );
  });
});

// ---------------------------------------------------------------------------
// Validate-before-access: new adapters must call validate() before Provider HTTP (2.3)
// ---------------------------------------------------------------------------

describe("Validate-before-access — new adapters reject invalid requests (2.3)", () => {
  /**
   * A fetch that throws if ever called — proving validate() short-circuits
   * before any transport access.
   */
  function explodingFetch() {
    return async () => {
      throw new Error("fetch must not be called when validation fails");
    };
  }

  it("Parallel search rejects invalid query before transport access", async () => {
    const adapter = new ParallelAdapter(
      { env: { PARALLEL_API_KEY: "k" } },
      { transport: { fetch: explodingFetch() } },
    );
    await assert.rejects(
      () => adapter.search.invoke({ query: "  " }),
      (err) => err.name === "ValidationError",
    );
  });

  it("Perplexity search rejects invalid query before transport access", async () => {
    const adapter = new PerplexityAdapter(
      { env: { PERPLEXITY_API_KEY: "k" } },
      { transport: { fetch: explodingFetch() } },
    );
    await assert.rejects(
      () => adapter.search.invoke({ query: "" }),
      (err) => err.name === "ValidationError",
    );
  });

  it("Jina search rejects invalid query before transport access", async () => {
    const adapter = new JinaAdapter(
      { env: {} },
      { transport: { fetch: explodingFetch() } },
    );
    await assert.rejects(
      () => adapter.search.invoke({ query: "   " }),
      (err) => err.name === "ValidationError",
    );
  });
});

// ---------------------------------------------------------------------------
// Source normalization: new adapters must not hardcode Provider identity (2.4)
// ---------------------------------------------------------------------------

describe("Source normalization — new adapters omit source when no metadata (2.4)", () => {
  it("Parallel search omits source (no structured metadata field)", async () => {
    const fetchFn = async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        results: [{ title: "T", url: "https://example.test", excerpts: ["S"] }],
      }),
    });
    const adapter = new ParallelAdapter(
      { env: { PARALLEL_API_KEY: "k" } },
      { transport: { fetch: fetchFn } },
    );
    const results = await adapter.search.invoke({ query: "test" });
    assert.equal(results[0].source, undefined, "source must be absent, not hardcoded");
  });

  it("Perplexity search omits source (no structured metadata field)", async () => {
    const fetchFn = async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        results: [{ title: "T", url: "https://example.test", snippet: "S" }],
      }),
    });
    const adapter = new PerplexityAdapter(
      { env: { PERPLEXITY_API_KEY: "k" } },
      { transport: { fetch: fetchFn } },
    );
    const results = await adapter.search.invoke({ query: "test" });
    assert.equal(results[0].source, undefined, "source must be absent, not hardcoded");
  });

  it("Jina search omits source (no structured metadata field)", async () => {
    const fetchFn = async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        data: [{ title: "T", url: "https://example.test", description: "S" }],
      }),
    });
    const adapter = new JinaAdapter(
      { env: {} },
      { transport: { fetch: fetchFn } },
    );
    const results = await adapter.search.invoke({ query: "test" });
    assert.equal(results[0].source, undefined, "source must be absent, not hardcoded");
  });
});

// ---------------------------------------------------------------------------
// AbortSignal: new adapters honour cooperative cancellation in research (2.6)
// ---------------------------------------------------------------------------

describe("AbortSignal — new research invokes honour pre-aborted signal (2.6)", () => {
  /**
   * A fetch that throws if ever called — proving the pre-abort check
   * short-circuits before any transport access.
   */
  function explodingFetch() {
    return async () => {
      throw new Error("fetch must not be called when signal is pre-aborted");
    };
  }

  it("Parallel research rejects before transport when signal is pre-aborted", async () => {
    const adapter = new ParallelAdapter(
      { env: { PARALLEL_API_KEY: "k" } },
      { transport: { fetch: explodingFetch() } },
    );
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () => adapter.research.run.invoke({ query: "test" }, controller.signal),
      (err) => err instanceof TimeoutError,
    );
  });

  it("Perplexity research rejects before transport when signal is pre-aborted", async () => {
    const adapter = new PerplexityAdapter(
      { env: { PERPLEXITY_API_KEY: "k" } },
      { transport: { fetch: explodingFetch() } },
    );
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () => adapter.research.run.invoke({ query: "test" }, controller.signal),
      (err) => err instanceof TimeoutError,
    );
  });

  it("Jina research rejects before transport when signal is pre-aborted", async () => {
    const adapter = new JinaAdapter(
      { env: {} },
      { transport: { fetch: explodingFetch() } },
    );
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () => adapter.research.run.invoke({ query: "test" }, controller.signal),
      (err) => err instanceof TimeoutError,
    );
  });
});

// ---------------------------------------------------------------------------
// Static registry (DESIGN.md §5)
// ---------------------------------------------------------------------------

describe("Static provider registry — BUILT_IN_PROVIDER_DESCRIPTORS", () => {
  it("contains exactly [zai, minimax, tavily, exa, brave, firecrawl, parallel, perplexity, jina, you, linkup, spider] in that order", () => {
    assert.deepStrictEqual(
      BUILT_IN_PROVIDER_DESCRIPTORS.map((d) => d.id),
      [
        "zai",
        "minimax",
        "tavily",
        "exa",
        "brave",
        "firecrawl",
        "parallel",
        "perplexity",
        "jina",
        "you",
        "linkup",
        "spider",
      ],
    );
  });

  it("has unique provider IDs", () => {
    const ids = BUILT_IN_PROVIDER_DESCRIPTORS.map((d) => d.id);
    assert.strictEqual(new Set(ids).size, ids.length);
  });

  it("descriptors expose pure metadata (capabilities + isConfigured, no transport)", () => {
    // Fully-built Providers (zai/minimax/tavily/brave) advertise search,
    // quota, and diagnostics. Brave (T6) now joins that set; the loop
    // below is scoped to zai/minimax/tavily but the brave-specific
    // assertion follows.
    for (const id of ["zai", "minimax", "tavily"]) {
      const d = getProviderDescriptor(id);
      const caps = d.capabilities();
      assert.ok(caps.has("search"), `${id} should advertise search`);
      // P4-02 wires quota metadata; P4-04 wires diagnostics.
      assert.ok(caps.has("quota"));
      assert.ok(caps.has("diagnostics"));
    }
    // Brave T6: advertises search + diagnostics + quota (size 3).
    const brave = getProviderDescriptor("brave");
    const braveCaps = brave.capabilities();
    assert.strictEqual(braveCaps.size, 3, "Brave advertises search + diagnostics + quota");
    assert.ok(braveCaps.has("search"), "Brave must advertise search");
    assert.ok(braveCaps.has("diagnostics"), "Brave must advertise diagnostics (T5)");
    assert.ok(braveCaps.has("quota"), "Brave must advertise quota (T6)");
    const zai = getProviderDescriptor("zai");
    assert.strictEqual(zai.isConfigured({ Z_AI_API_KEY: "k" }), true);
    assert.strictEqual(zai.isConfigured({}), false);
    const mm = getProviderDescriptor("minimax");
    assert.strictEqual(mm.isConfigured({ MINIMAX_API_KEY: "k" }), true);
    assert.strictEqual(mm.isConfigured({}), false);
    const tv = getProviderDescriptor("tavily");
    assert.strictEqual(tv.isConfigured({ TAVILY_API_KEY: "k" }), true);
    assert.strictEqual(tv.isConfigured({}), false);
    // Brave isConfigured locks the foundation state.
    assert.strictEqual(brave.isConfigured({}), false);
    assert.strictEqual(brave.isConfigured({ BRAVE_SEARCH_API_KEY: "  " }), false);
    assert.strictEqual(brave.isConfigured({ BRAVE_SEARCH_API_KEY: "k" }), true);
    const exa = getProviderDescriptor("exa");
    assert.strictEqual(exa.isConfigured({ EXA_API_KEY: "k" }), true);
    assert.strictEqual(exa.isConfigured({}), false);
    const fc = getProviderDescriptor("firecrawl");
    assert.strictEqual(fc.isConfigured({ FIRECRAWL_API_KEY: "fc-test" }), true);
    assert.strictEqual(fc.isConfigured({}), false);
  });

  it("descriptor creation is side-effect-free (no transport construction)", () => {
    // Every built-in Provider advertises `search`; create() is
    // side-effect-free.
    for (const id of ["zai", "minimax", "tavily", "exa", "brave", "firecrawl"]) {
      const d = getProviderDescriptor(id);
      const adapter = d.create({ env: {} });
      assert.strictEqual(typeof adapter.search, "object", `${id} should expose adapter.search`);
    }
    const brave = getProviderDescriptor("brave");
    const braveAdapter = brave.create({ env: {} });
    assert.strictEqual(braveAdapter.id, "brave");
    assert.strictEqual(typeof braveAdapter.search, "object", "Brave must expose adapter.search");
  });

  it("firecrawl create() returns an adapter with all six capabilities", () => {
    const fc = getProviderDescriptor("firecrawl");
    const adapter = fc.create({ env: {} });
    assert.strictEqual(adapter.id, "firecrawl");
    assert.strictEqual(typeof adapter.search, "object");
    assert.strictEqual(typeof adapter.reader, "object");
    assert.strictEqual(typeof adapter.crawl, "object");
    assert.strictEqual(typeof adapter.map, "object");
    assert.strictEqual(typeof adapter.quota, "object");
    assert.strictEqual(typeof adapter.diagnostics, "object");
  });

  it("tavily create() returns an adapter with search, reader, and crawl", () => {
    const tv = getProviderDescriptor("tavily");
    const adapter = tv.create({ env: {} });
    assert.strictEqual(adapter.id, "tavily");
    assert.strictEqual(typeof adapter.search, "object");
    assert.strictEqual(typeof adapter.reader, "object");
    assert.strictEqual(typeof adapter.crawl, "object");
  });

  it("exa create() returns an adapter with search and diagnostics", () => {
    const exa = getProviderDescriptor("exa");
    const adapter = exa.create({ env: {} });
    assert.strictEqual(adapter.id, "exa");
    assert.strictEqual(typeof adapter.search, "object");
    assert.strictEqual(typeof adapter.diagnostics, "object");
  });

  it("getConfiguredProviderDescriptors filters by configured credentials", () => {
    const onlyZai = getConfiguredProviderDescriptors({ Z_AI_API_KEY: "k" });
    assert.deepStrictEqual(
      onlyZai.map((d) => d.id),
      ["zai", "jina"],
    );

    const onlyMm = getConfiguredProviderDescriptors({ MINIMAX_API_KEY: "k" });
    assert.deepStrictEqual(
      onlyMm.map((d) => d.id),
      ["minimax", "jina"],
    );

    const onlyTv = getConfiguredProviderDescriptors({ TAVILY_API_KEY: "k" });
    assert.deepStrictEqual(
      onlyTv.map((d) => d.id),
      ["tavily", "jina"],
    );

    const onlyBrave = getConfiguredProviderDescriptors({ BRAVE_SEARCH_API_KEY: "k" });
    assert.deepStrictEqual(
      onlyBrave.map((d) => d.id),
      ["brave", "jina"],
    );

    const onlyExa = getConfiguredProviderDescriptors({ EXA_API_KEY: "k" });
    assert.deepStrictEqual(
      onlyExa.map((d) => d.id),
      ["exa", "jina"],
    );

    const both = getConfiguredProviderDescriptors({
      Z_AI_API_KEY: "k",
      MINIMAX_API_KEY: "k",
    });
    assert.deepStrictEqual(
      both.map((d) => d.id),
      ["zai", "minimax", "jina"],
    );

    const all = getConfiguredProviderDescriptors({
      Z_AI_API_KEY: "k",
      MINIMAX_API_KEY: "k",
      TAVILY_API_KEY: "k",
      EXA_API_KEY: "k",
      BRAVE_SEARCH_API_KEY: "k",
    });
    assert.deepStrictEqual(
      all.map((d) => d.id),
      ["zai", "minimax", "tavily", "exa", "brave", "jina"],
    );

    // Jina is always configured (keyless access supported)
    const neither = getConfiguredProviderDescriptors({});
    assert.deepStrictEqual(
      neither.map((d) => d.id),
      ["jina"],
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

// ---------------------------------------------------------------------------
// Descriptor ↔ Adapter repository-exploration agreement (P6-06).
//
// A descriptor advertises `repository-exploration` iff the Adapter it
// creates supplies `adapter.repository`. Locking both directions keeps
// descriptor metadata honest: a Provider cannot claim repository
// support without the implementation handle, and cannot silently ship
// an Adapter handle without advertising the capability. `create()`
// stays side-effect-free — verified through injected transport spies,
// not timing heuristics.
// ---------------------------------------------------------------------------

describe("Descriptor ↔ Adapter repository-exploration agreement (P6-06)", () => {
  /**
   * Build a Z.AI descriptor whose `clientFactory` increments a spy
   * counter every time it is called. Production passes this factory
   * to search/vision/diagnostics/repository capabilities; they MUST
   * only invoke it inside Capability.invoke, never inside `create()`.
   * Returns `{ descriptor, calls }` so the test can assert zero
   * transport constructions after the agreement check.
   */
  function makeSpiedZaiDescriptor() {
    const calls = { clientFactory: 0 };
    const descriptor = createZaiDescriptor({
      clientFactory: () => {
        calls.clientFactory += 1;
        return {
          async callToolRaw() {
            throw new Error("clientFactory must not be invoked during create()");
          },
          async listTools() {
            throw new Error("clientFactory must not be invoked during create()");
          },
          async close() {},
        };
      },
    });
    return { descriptor, calls };
  }

  /**
   * Build a MiniMax descriptor whose `sdkConstructor` and quota
   * transport are spy counters. Every capability the MiniMax Adapter
   * constructs (search, vision, quota, diagnostics) carries these
   * spies through to the eventual transport; none of them MUST fire
   * during `create()`.
   */
  function makeSpiedMiniMaxDescriptor() {
    // Direct-transport seam: every transport call site (search, vision,
    // quota, diagnostics, image fetch) consumes the unified `transport`
    // binding. None of those MUST fire during `create()`.
    const calls = { fetch: 0, setTimeout: 0, clearTimeout: 0 };
    const descriptor = createMiniMaxDescriptor({
      transport: {
        fetch: async () => {
          calls.fetch += 1;
          throw new Error("transport.fetch must not run during create()");
        },
        setTimeout: () => {
          calls.setTimeout += 1;
          return 0;
        },
        clearTimeout: () => {
          calls.clearTimeout += 1;
        },
      },
    });
    return { descriptor, calls };
  }

  it("Z.AI advertises repository-exploration and the Adapter supplies `repository`", () => {
    const { descriptor, calls } = makeSpiedZaiDescriptor();
    const caps = descriptor.capabilities();
    assert.strictEqual(
      caps.has("repository-exploration"),
      true,
      "Z.AI descriptor must advertise repository-exploration",
    );
    const adapter = descriptor.create({ env: {} });
    assert.strictEqual(
      adapter.repository !== undefined,
      true,
      "Z.AI Adapter must supply adapter.repository",
    );
    // `create()` is side-effect-free: the transport factory is
    // captured but never invoked.
    assert.strictEqual(
      calls.clientFactory,
      0,
      "Z.AI clientFactory must not be invoked during descriptor.create()",
    );
  });

  it("MiniMax does NOT advertise repository-exploration and the Adapter supplies no `repository`", () => {
    const { descriptor, calls } = makeSpiedMiniMaxDescriptor();
    const caps = descriptor.capabilities();
    assert.strictEqual(
      caps.has("repository-exploration"),
      false,
      "MiniMax descriptor must NOT advertise repository-exploration",
    );
    const adapter = descriptor.create({ env: {} });
    assert.strictEqual(
      adapter.repository,
      undefined,
      "MiniMax Adapter must NOT supply adapter.repository",
    );
    // `create()` constructs zero transport. MiniMax must remain free
    // of repository credential/transport/fallback work; this
    // assertion locks that no transport is built eagerly.
    assert.strictEqual(calls.fetch, 0, "MiniMax transport.fetch must not run during create()");
    assert.strictEqual(
      calls.setTimeout,
      0,
      "MiniMax transport.setTimeout must not run during create()",
    );
    assert.strictEqual(
      calls.clearTimeout,
      0,
      "MiniMax transport.clearTimeout must not run during create()",
    );
  });

  it("repository-exploration is advertised IFF the Adapter supplies repository, for every built-in", () => {
    const builtIns = [
      createZaiDescriptor(),
      createMiniMaxDescriptor(),
      createTavilyDescriptor(),
      createExaDescriptor(),
    ];
    for (const descriptor of builtIns) {
      const advertised = descriptor.capabilities().has("repository-exploration");
      const adapter = descriptor.create({ env: {} });
      const supplied = adapter.repository !== undefined;
      assert.strictEqual(
        advertised,
        supplied,
        `${descriptor.id}: repository-exploration advertisement (${advertised}) must match adapter.repository presence (${supplied})`,
      );
    }
  });

  it("reader is advertised IFF the Adapter supplies reader, for every built-in (Reader Migration 04)", () => {
    const builtIns = [
      createZaiDescriptor(),
      createMiniMaxDescriptor(),
      createTavilyDescriptor(),
      createExaDescriptor(),
    ];
    for (const descriptor of builtIns) {
      const advertised = descriptor.capabilities().has("reader");
      const adapter = descriptor.create({ env: {} });
      const supplied = adapter.reader !== undefined;
      assert.strictEqual(
        advertised,
        supplied,
        `${descriptor.id}: reader advertisement (${advertised}) must match adapter.reader presence (${supplied})`,
      );
    }
  });

  it("Z.AI advertises reader and the Adapter supplies `reader` (Reader Migration 04)", () => {
    const { descriptor, calls } = makeSpiedZaiDescriptor();
    const caps = descriptor.capabilities();
    assert.strictEqual(caps.has("reader"), true, "Z.AI descriptor must advertise reader");
    const adapter = descriptor.create({ env: {} });
    assert.ok(adapter.reader, "Z.AI Adapter must supply adapter.reader");
    assert.ok(adapter.reader.fetch, "Z.AI Reader Capability must expose adapter.reader.fetch");
    // `create()` is side-effect-free.
    assert.strictEqual(
      calls.clientFactory,
      0,
      "Z.AI clientFactory must not be invoked during descriptor.create()",
    );
  });

  it("MiniMax does NOT advertise reader and the Adapter supplies no `reader` (Reader Migration 04)", () => {
    const { descriptor } = makeSpiedMiniMaxDescriptor();
    const caps = descriptor.capabilities();
    assert.strictEqual(caps.has("reader"), false, "MiniMax descriptor must NOT advertise reader");
    const adapter = descriptor.create({ env: {} });
    assert.strictEqual(adapter.reader, undefined, "MiniMax Adapter must NOT supply adapter.reader");
  });

  it("descriptor creation remains side-effect-free (injected transport spies stay at zero)", () => {
    // Spy-based side-effect proof: every transport seam the Adapter
    // could possibly construct (Z.AI UTCP clientFactory; MiniMax SDK
    // constructor + quota fetch + quota timers) is replaced with a
    // counter-injecting double. `create()` MUST capture them but
    // MUST NOT invoke them. Timing is intentionally not used — it
    // would not prove absence of transport construction.
    const zai = makeSpiedZaiDescriptor();
    const minimax = makeSpiedMiniMaxDescriptor();

    const zaiAdapter = zai.descriptor.create({ env: {} });
    const minimaxAdapter = minimax.descriptor.create({ env: {} });

    assert.ok(typeof zaiAdapter === "object" && zaiAdapter !== null);
    assert.ok(typeof minimaxAdapter === "object" && minimaxAdapter !== null);

    assert.strictEqual(zai.calls.clientFactory, 0, "Z.AI clientFactory spy must remain at 0");
    assert.strictEqual(minimax.calls.fetch, 0, "MiniMax transport.fetch spy must remain at 0");
    assert.strictEqual(
      minimax.calls.setTimeout,
      0,
      "MiniMax transport.setTimeout spy must remain at 0",
    );
    assert.strictEqual(
      minimax.calls.clearTimeout,
      0,
      "MiniMax transport.clearTimeout spy must remain at 0",
    );
  });
});

// ---------------------------------------------------------------------------
// Vision conformance (P3-03): both Adapters converge on the same text
// ---------------------------------------------------------------------------

describe("Vision Adapter conformance — shared normalized output (P3-03)", () => {
  it("both built-in Adapters normalize interpret-image to the same text", async () => {
    // Z.AI returns a direct-text result.
    const zaiVision = makeZaiVisionCapability(VISION_CONFORMANCE_EXPECTED);
    const zaiResult = await zaiVision.invoke(VISION_CONFORMANCE_REQUEST);
    assert.strictEqual(zaiResult, VISION_CONFORMANCE_EXPECTED);

    // MiniMax returns the characterized { content } envelope (loaded fixture).
    const minimaxEnvelope = await readFixture("providers", "minimax", "vision.json");
    assert.strictEqual(minimaxEnvelope.content, VISION_CONFORMANCE_EXPECTED);
    const minimaxVision = makeMiniMaxVisionCapability(minimaxEnvelope);
    const minimaxResult = await minimaxVision.invoke(VISION_CONFORMANCE_REQUEST);
    assert.strictEqual(minimaxResult, VISION_CONFORMANCE_EXPECTED);
  });

  it("normalized Vision output carries no Provider-only envelope fields", async () => {
    const zaiVision = makeZaiVisionCapability("plain text");
    const out = await zaiVision.invoke(VISION_CONFORMANCE_REQUEST);
    assert.strictEqual(typeof out, "string");
    assert.ok(!out.includes("{"), "Vision text must not leak a Provider envelope");
  });
});

// ---------------------------------------------------------------------------
// Repository Adapter conformance (P6-08): Z.AI and a fake second Adapter
// converge on the same normalized Search, File, and Directory Listing
// values. The fake Adapter is a reusable capability double supplied by
// `tests/helpers/fake-adapter.js`; it produces the SAME normalized contract
// WITHOUT touching any ZRead grammar.
//
// This block is the static-registry parallel to the integrated dispatcher
// proof in `repository-conformance.test.js`. Where that file proves
// end-to-end dispatch through `main()`, this file proves the per-Capability
// shape contract directly: same request → same normalized output.
// ---------------------------------------------------------------------------

import crypto from "node:crypto";
import { createFakeRepositoryCapability } from "./helpers/fake-adapter.js";
import { executeRepositoryOperation } from "../dist/lib/execution.js";
import { getMcpToolName } from "../dist/lib/mcp-config.js";

const REPO_INTERNAL_SEARCH = "scoutline_zai.zread.search_doc";
const REPO_INTERNAL_FILE = "scoutline_zai.zread.read_file";
const REPO_INTERNAL_DIR = "scoutline_zai.zread.get_repo_structure";
const REPO_PUBLIC_SEARCH = getMcpToolName("zread", "search_doc");
const REPO_PUBLIC_FILE = getMcpToolName("zread", "read_file");
const REPO_PUBLIC_DIR = getMcpToolName("zread", "get_repo_structure");

const REPO_DISCOVERED_TOOLS = [
  { name: REPO_INTERNAL_SEARCH, inputs: { type: "object" }, outputs: { type: "string" } },
  { name: REPO_INTERNAL_FILE, inputs: { type: "object" }, outputs: { type: "string" } },
  { name: REPO_INTERNAL_DIR, inputs: { type: "object" }, outputs: { type: "string" } },
];

/**
 * Z.AI Repository Adapter factory: build a Repository Capability whose
 * underlying UTCP client returns the supplied raw ZRead string for the
 * named tool. Mirrors the discovered-name resolution path used by the
 * production Adapter.
 */
function makeZaiRepositoryCapability({ searchRaw, fileRaw, dirRaw }) {
  const resultsByName = {};
  if (searchRaw !== undefined) resultsByName[REPO_INTERNAL_SEARCH] = searchRaw;
  if (fileRaw !== undefined) resultsByName[REPO_INTERNAL_FILE] = fileRaw;
  if (dirRaw !== undefined) resultsByName[REPO_INTERNAL_DIR] = dirRaw;
  const factory = (options) => {
    const fake = new FakeUtcpClient({
      discoveredTools: REPO_DISCOVERED_TOOLS,
      resultsByName,
    });
    return {
      options,
      async callToolRaw(name, args) {
        const tools = fake.discoveredTools;
        let resolved = tools.find((t) => t.name === name);
        if (!resolved && name.startsWith("scoutline.zai.")) {
          const suffix = name.slice("scoutline.zai.".length);
          const matches = tools.filter((t) => t.name.endsWith(`.${suffix}`));
          if (matches.length === 1) resolved = matches[0];
        }
        if (!resolved) throw new Error(`API_ERROR: Unknown tool ${name}`);
        return fake.callTool(resolved.name, args);
      },
      async listTools() {
        return fake.getTools();
      },
      async close() {
        return fake.close();
      },
    };
  };
  const descriptor = createZaiDescriptor({ clientFactory: factory });
  return descriptor.create({ env: { Z_AI_API_KEY: "k" } }).repository;
}

/**
 * Trivial in-memory ResponseCache; per-Capability conformance does not
 * exercise legacy candidates, so a plain Map suffices.
 */
function trivialCache() {
  const store = new Map();
  return {
    async get(k) {
      return store.has(k) ? store.get(k) : null;
    },
    async set(k, v) {
      store.set(k, v);
    },
    store,
  };
}

function trivialDeps() {
  return { cache: trivialCache(), sleep: async () => {}, random: () => 0 };
}

describe("Repository Adapter conformance — shared normalized output (P6-08)", () => {
  it("Z.AI and the fake Adapter normalize Search to the same structured value", async () => {
    const excerptText = "shared search excerpt";
    const raw = `<excerpt>${excerptText}</excerpt>`;
    const expected = {
      schemaVersion: 1,
      repository: "owner/repo",
      query: "conformance",
      language: "en",
      excerpts: [{ text: excerptText }],
      truncated: false,
      originalTextLength: excerptText.length,
    };

    const zaiRepo = makeZaiRepositoryCapability({ searchRaw: raw });
    const zaiOut = await executeRepositoryOperation(
      zaiRepo.search,
      { repository: "owner/repo", query: "conformance", language: "en" },
      { noCache: true },
      trivialDeps(),
    );

    const { capability: fakeRepo } = createFakeRepositoryCapability({
      apiKey: "k",
      provider: "zai",
      search: { result: expected },
    });
    const fakeOut = await executeRepositoryOperation(
      fakeRepo.search,
      { repository: "owner/repo", query: "conformance", language: "en" },
      { noCache: true },
      trivialDeps(),
    );

    assert.deepStrictEqual(zaiOut, expected);
    assert.deepStrictEqual(fakeOut, expected);
    assert.deepStrictEqual(zaiOut, fakeOut);
  });

  it("Z.AI and the fake Adapter normalize File to the same structured value", async () => {
    const body = "shared file body";
    const raw = `<file_content>${body}</file_content>`;
    const expected = {
      schemaVersion: 1,
      repository: "owner/repo",
      path: "README.md",
      content: body,
      truncated: false,
      originalContentLength: body.length,
    };

    const zaiRepo = makeZaiRepositoryCapability({ fileRaw: raw });
    const zaiOut = await executeRepositoryOperation(
      zaiRepo.readFile,
      { repository: "owner/repo", path: "README.md" },
      { noCache: true },
      trivialDeps(),
    );

    const { capability: fakeRepo } = createFakeRepositoryCapability({
      apiKey: "k",
      provider: "zai",
      readFile: { result: expected },
    });
    const fakeOut = await executeRepositoryOperation(
      fakeRepo.readFile,
      { repository: "owner/repo", path: "README.md" },
      { noCache: true },
      trivialDeps(),
    );

    assert.deepStrictEqual(zaiOut, expected);
    assert.deepStrictEqual(fakeOut, expected);
    assert.deepStrictEqual(zaiOut, fakeOut);
  });

  it("Z.AI and the fake Adapter normalize Directory Listing to the same structured value", async () => {
    const raw = "<structure>\nowner-repo/\n├── src/\n├── README.md\n└── package.json\n</structure>";
    const expected = {
      repository: "owner/repo",
      path: "",
      entries: [
        { name: "src", path: "src", kind: "directory" },
        { name: "README.md", path: "README.md", kind: "file" },
        { name: "package.json", path: "package.json", kind: "file" },
      ],
    };

    const zaiRepo = makeZaiRepositoryCapability({ dirRaw: raw });
    const zaiOut = await executeRepositoryOperation(
      zaiRepo.listDirectory,
      { repository: "owner/repo", path: "" },
      { noCache: true },
      trivialDeps(),
    );

    const { capability: fakeRepo } = createFakeRepositoryCapability({
      apiKey: "k",
      provider: "zai",
      listDirectory: { result: expected },
    });
    const fakeOut = await executeRepositoryOperation(
      fakeRepo.listDirectory,
      { repository: "owner/repo", path: "" },
      { noCache: true },
      trivialDeps(),
    );

    assert.deepStrictEqual(zaiOut, expected);
    assert.deepStrictEqual(fakeOut, expected);
    assert.deepStrictEqual(zaiOut, fakeOut);
  });

  it("normalized Repository outputs carry no Provider-only envelope fields", async () => {
    // The total decoders drop unknown fields. Provider-only metadata
    // like raw wrapper tags, error code text, and MCP envelopes cannot
    // leak through the cache.
    const { capability: fakeRepo } = createFakeRepositoryCapability({
      apiKey: "k",
      provider: "zai",
      search: {
        result: {
          schemaVersion: 1,
          repository: "owner/repo",
          query: "q",
          language: "en",
          excerpts: [{ text: "x", rank: 1, url: "should-drop" }],
          truncated: false,
          originalTextLength: 1,
        },
      },
    });
    const out = fakeRepo.search.decodeCached({
      schemaVersion: 1,
      repository: "owner/repo",
      query: "q",
      language: "en",
      excerpts: [{ text: "x", rank: 1, url: "should-drop" }],
      truncated: false,
      originalTextLength: 1,
    });
    assert.deepStrictEqual(out.excerpts, [{ text: "x" }]);
    assert.strictEqual(out.excerpts[0].rank, undefined);
    assert.strictEqual(out.excerpts[0].url, undefined);
  });

  it("the fake Adapter exposes the same Capability interface as Z.AI", () => {
    // Static shape proof: the fake Adapter exposes the three documented
    // operation handles, each with kind/validate/cacheIdentity/
    // decodeCached/invoke. This is the contract the production
    // dispatcher depends on.
    const zaiRepo = makeZaiRepositoryCapability({});
    const { capability: fakeRepo } = createFakeRepositoryCapability({
      apiKey: "k",
      provider: "fake",
      search: { result: null },
      readFile: { result: null },
      listDirectory: { result: null },
    });
    for (const slot of ["search", "readFile", "listDirectory"]) {
      assert.ok(zaiRepo[slot], `Z.AI adapter must expose ${slot}`);
      assert.ok(fakeRepo[slot], `fake adapter must expose ${slot}`);
      for (const method of ["kind", "validate", "cacheIdentity", "decodeCached", "invoke"]) {
        assert.ok(method in zaiRepo[slot], `Z.AI ${slot} must implement ${method}`);
        assert.ok(method in fakeRepo[slot], `fake ${slot} must implement ${method}`);
      }
    }
    // Operation kinds match the documented union literal-for-literal.
    assert.strictEqual(zaiRepo.search.kind, fakeRepo.search.kind);
    assert.strictEqual(zaiRepo.search.kind, "repository-search");
    assert.strictEqual(zaiRepo.readFile.kind, fakeRepo.readFile.kind);
    assert.strictEqual(zaiRepo.readFile.kind, "repository-read-file");
    assert.strictEqual(zaiRepo.listDirectory.kind, fakeRepo.listDirectory.kind);
    assert.strictEqual(zaiRepo.listDirectory.kind, "repository-list-directory");
  });

  it("both Adapters use the same credential-fingerprint algorithm (full SHA-256 hex)", () => {
    // The fake Adapter uses crypto.createHash('sha256').update(apiKey).digest('hex')
    // — identical to the Z.AI Adapter. The two fingerprints for the
    // same credential MUST be equal so a cross-Provider cache-key
    // identity proof is apples-to-apples.
    const credential = "shared-credential-for-fingerprint-test";
    const expected = crypto.createHash("sha256").update(credential).digest("hex");

    const zaiRepo = makeZaiRepositoryCapability({});
    const zaiIdentity = zaiRepo.search.cacheIdentity({
      repository: "owner/repo",
      query: "q",
      language: "en",
    });
    // Override the env-bound credential by reconstructing the Z.AI
    // adapter with the test credential.
    const factory = (options) => ({
      options,
      async callToolRaw() {
        return null;
      },
      async listTools() {
        return [];
      },
      async close() {},
    });
    const zaiDescriptor = createZaiDescriptor({ clientFactory: factory });
    const zaiAdapterBound = zaiDescriptor.create({
      env: { Z_AI_API_KEY: credential },
    });
    const zaiBoundIdentity = zaiAdapterBound.repository.search.cacheIdentity({
      repository: "owner/repo",
      query: "q",
      language: "en",
    });

    const { fingerprint: fakeFingerprint } = createFakeRepositoryCapability({
      apiKey: credential,
      provider: "fake",
    });

    assert.strictEqual(zaiBoundIdentity.credentialFingerprint, expected);
    assert.strictEqual(fakeFingerprint, expected);
    // Belt-and-braces: the env-bound Z.AI identity and the default-key
    // Z.AI identity differ because the credentials differ.
    assert.notStrictEqual(
      zaiIdentity.credentialFingerprint,
      zaiBoundIdentity.credentialFingerprint,
    );
  });
});
