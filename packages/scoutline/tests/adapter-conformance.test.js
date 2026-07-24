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
    const minimaxNormalized = await runSearchConformance(makeMiniMaxCapability, minimaxRaw);
    assert.deepStrictEqual(minimaxNormalized, expected);

    // Brave raw web response (web.results[] with title/url/description;
    // no meta_url/page_age so source/date are absent — matching the
    // shared normalized form).
    const braveRaw = {
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
    };
    const braveNormalized = await runSearchConformance(makeBraveCapability, braveRaw);
    assert.deepStrictEqual(braveNormalized, expected);
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
  it("contains exactly [zai, minimax, tavily, exa, brave, firecrawl] in that order", () => {
    assert.deepStrictEqual(
      BUILT_IN_PROVIDER_DESCRIPTORS.map((d) => d.id),
      ["zai", "minimax", "tavily", "exa", "brave", "firecrawl"],
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
      ["zai"],
    );

    const onlyMm = getConfiguredProviderDescriptors({ MINIMAX_API_KEY: "k" });
    assert.deepStrictEqual(
      onlyMm.map((d) => d.id),
      ["minimax"],
    );

    const onlyTv = getConfiguredProviderDescriptors({ TAVILY_API_KEY: "k" });
    assert.deepStrictEqual(
      onlyTv.map((d) => d.id),
      ["tavily"],
    );

    const onlyBrave = getConfiguredProviderDescriptors({ BRAVE_SEARCH_API_KEY: "k" });
    assert.deepStrictEqual(
      onlyBrave.map((d) => d.id),
      ["brave"],
    );

    const onlyExa = getConfiguredProviderDescriptors({ EXA_API_KEY: "k" });
    assert.deepStrictEqual(
      onlyExa.map((d) => d.id),
      ["exa"],
    );

    const both = getConfiguredProviderDescriptors({
      Z_AI_API_KEY: "k",
      MINIMAX_API_KEY: "k",
    });
    assert.deepStrictEqual(
      both.map((d) => d.id),
      ["zai", "minimax"],
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
      ["zai", "minimax", "tavily", "exa", "brave"],
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
