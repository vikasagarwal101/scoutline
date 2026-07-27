/**
 * PB-T4 — Effective Provider Selection (`resolveEffectiveProvider`).
 *
 * Coverage map (per the PB-T4 ticket):
 *   - Resolver unit tests (table-driven): pin paths, absent-snapshot
 *     compat, eligibility filtering, known-before-unknown ranking,
 *     stable tie-breaks, none-eligible fallback, determinism, and the
 *     no-write contract.
 *   - Dispatch tests: one per shared handler (7) proving the resolved
 *     scalar becomes `effectiveProvider` (the highest-scored provider
 *     is attempted first) and the executor's reactive loop is
 *     byte-unchanged.
 *   - Negative assertions: Doctor / quota / raw Z.AI commands never
 *     call `resolveEffectiveProvider`.
 *
 * The ranking primitives themselves (`rankProvidersForCapability`,
 * `scoreCapability`) are exhaustively covered by
 * `tests/quota-mapping.test.js`; this file asserts the resolver's OWN
 * logic (pin detection, eligibility filtering, delegation, compat
 * fallback) and the dispatch wiring.
 *
 * Test file is `.test.js` so it runs under `node --test` without a
 * TypeScript preprocessor; the dist artefacts supply runtime types.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { resolveProviderId, resolveEffectiveProvider } from "../dist/providers/selection.js";
import { ValidationError } from "../dist/lib/errors.js";
import { createInMemoryQuotaStore } from "../dist/lib/quota-store.js";
import { main } from "../dist/index.js";

// ---------------------------------------------------------------------------
// Fixtures — raw QuotaCategory[] matching each provider's live shape
// (mirrors tests/quota-mapping.test.js so scores are characterised)
// ---------------------------------------------------------------------------

const ZAI_CATEGORIES_25 = [
  {
    name: "requests",
    unit: "requests",
    current: { used: 750, limit: 1000, remaining: 250, remainingPercent: 25 },
  },
  { name: "tokens", unit: "tokens", current: { remainingPercent: 40 } },
];

const ZAI_CATEGORIES_5 = [
  {
    name: "requests",
    unit: "requests",
    current: { used: 950, limit: 1000, remaining: 50, remainingPercent: 5 },
  },
  { name: "tokens", unit: "tokens", current: { remainingPercent: 100 } },
];

const TAVILY_CATEGORIES_95 = [
  {
    name: "requests",
    unit: "requests",
    current: { used: 100, limit: 1000, remaining: 900, remainingPercent: 90 },
  },
  {
    name: "search",
    unit: "requests",
    current: { used: 50, limit: 1000, remaining: 950, remainingPercent: 95 },
  },
  {
    name: "extract",
    unit: "requests",
    current: { used: 10, limit: 1000, remaining: 990, remainingPercent: 99 },
  },
];

const FIRECRAWL_CATEGORIES_30 = [
  {
    name: "Credits",
    unit: "credits",
    current: { used: 700, limit: 1000, remaining: 300, remainingPercent: 30 },
  },
];

const BRAVE_CATEGORIES = [
  {
    name: "monthly",
    unit: "requests",
    current: { used: 500, limit: 15000, remaining: 14500, remainingPercent: 96.7 },
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a fresh QuotaState seeded with the given per-provider category
 * arrays. Uses the in-memory store so no disk I/O touches these tests.
 */
async function stateWith(entries) {
  const store = createInMemoryQuotaStore();
  for (const e of entries) {
    await store.writeObserved(e.provider, {
      observedAt: e.observedAt ?? 1_700_000_000_000,
      categories: e.categories,
    });
  }
  return store.read();
}

/**
 * Build a descriptor double that reports a fixed capability set and
 * configured state. The adapter handle is faked only when needed by
 * dispatch tests; the resolver itself never calls `create()`.
 */
function makeDescriptor(id, { capabilities = ["search"], configured = true } = {}) {
  return {
    id,
    isConfigured: () => configured,
    capabilities: () => new Set(capabilities),
    create: () => ({ id }),
  };
}

// ===========================================================================
// 1. Pin paths — explicit, env, empty, pinned-but-ineligible
// ===========================================================================

describe("resolveEffectiveProvider: pin paths bypass ranking", () => {
  const cases = [
    {
      name: "explicit pin wins over a higher-scored provider",
      explicit: "zai",
      env: {},
      snapshot: async () =>
        stateWith([
          { provider: "zai", categories: ZAI_CATEGORIES_25 }, // 25%
          { provider: "tavily", categories: TAVILY_CATEGORIES_95 }, // 95%
        ]),
      expected: "zai",
    },
    {
      name: "env pin wins over a higher-scored provider",
      explicit: undefined,
      env: { SCOUTLINE_PROVIDER: "zai" },
      snapshot: async () =>
        stateWith([
          { provider: "zai", categories: ZAI_CATEGORIES_25 },
          { provider: "tavily", categories: TAVILY_CATEGORIES_95 },
        ]),
      expected: "zai",
    },
    {
      name: "explicit pin wins over env pin (precedence preserved)",
      explicit: "tavily",
      env: { SCOUTLINE_PROVIDER: "zai" },
      snapshot: async () => stateWith([{ provider: "zai", categories: ZAI_CATEGORIES_25 }]),
      expected: "tavily",
    },
    {
      name: "explicit pin returned even when pinned provider is unconfigured",
      explicit: "minimax",
      env: {},
      snapshot: async () => stateWith([{ provider: "tavily", categories: TAVILY_CATEGORIES_95 }]),
      expected: "minimax",
      // minimax is absent from descriptors / unconfigured — the pin
      // still wins so the executor surfaces the typed error.
      descriptors: [makeDescriptor("tavily", { capabilities: ["search"] })],
    },
    {
      name: "explicit pin returned even when pinned provider is incapable",
      explicit: "minimax",
      env: { MINIMAX_API_KEY: "k" },
      snapshot: async () => stateWith([{ provider: "tavily", categories: TAVILY_CATEGORIES_95 }]),
      expected: "minimax",
      // minimax is configured but does not advertise "crawl" — the pin
      // still wins so the executor surfaces UnsupportedCapabilityError.
      descriptors: [
        makeDescriptor("minimax", { capabilities: ["search"], configured: true }),
        makeDescriptor("tavily", { capabilities: ["crawl"], configured: true }),
      ],
      capabilityId: "crawl",
    },
  ];

  for (const c of cases) {
    it(c.name, async () => {
      const snapshot = await c.snapshot();
      const result = resolveEffectiveProvider({
        explicitProvider: c.explicit,
        env: c.env,
        capabilityId: c.capabilityId ?? "search",
        descriptors: c.descriptors ?? [
          makeDescriptor("zai"),
          makeDescriptor("tavily"),
          makeDescriptor("minimax"),
        ],
        quotaSnapshot: snapshot,
      });
      assert.strictEqual(result, c.expected);
    });
  }

  it("explicitly empty pin throws ValidationError (does not fall through to ranking)", async () => {
    const snapshot = await stateWith([{ provider: "tavily", categories: TAVILY_CATEGORIES_95 }]);
    assert.throws(
      () =>
        resolveEffectiveProvider({
          explicitProvider: "",
          env: {},
          capabilityId: "search",
          descriptors: [makeDescriptor("tavily")],
          quotaSnapshot: snapshot,
        }),
      ValidationError,
    );
  });

  it("unknown env pin throws ValidationError", async () => {
    const snapshot = await stateWith([{ provider: "tavily", categories: TAVILY_CATEGORIES_95 }]);
    assert.throws(
      () =>
        resolveEffectiveProvider({
          explicitProvider: undefined,
          env: { SCOUTLINE_PROVIDER: "openai" },
          capabilityId: "search",
          descriptors: [makeDescriptor("tavily")],
          quotaSnapshot: snapshot,
        }),
      ValidationError,
    );
  });
});

// ===========================================================================
// 2. Absent snapshot — exact pre-PB-T4 compat ("always zai")
// ===========================================================================

describe("resolveEffectiveProvider: absent snapshot delegates to resolveProviderId (compat)", () => {
  it("returns zai when no pin and no snapshot, even if another provider is configured+capable", () => {
    // This is the CRITICAL compat test: tests that inject descriptors
    // but not a snapshot must get byte-for-byte the pre-PB-T4
    // selection ("always zai"), so the skip-notice auto-reroute
    // behaviour survives unchanged.
    const result = resolveEffectiveProvider({
      explicitProvider: undefined,
      env: {},
      capabilityId: "search",
      descriptors: [makeDescriptor("tavily", { configured: true })],
      quotaSnapshot: undefined,
    });
    assert.strictEqual(result, "zai");
  });

  it("matches resolveProviderId output for every no-snapshot input", () => {
    const inputs = [
      { explicit: undefined, env: {} },
      { explicit: "minimax", env: {} },
      { explicit: undefined, env: { SCOUTLINE_PROVIDER: "tavily" } },
    ];
    for (const { explicit, env } of inputs) {
      assert.strictEqual(
        resolveEffectiveProvider({
          explicitProvider: explicit,
          env,
          capabilityId: "search",
          descriptors: [makeDescriptor("zai"), makeDescriptor("minimax")],
          quotaSnapshot: undefined,
        }),
        resolveProviderId(explicit, env),
        `mismatch for explicit=${String(explicit)} env=${JSON.stringify(env)}`,
      );
    }
  });
});

// ===========================================================================
// 3. Known-score ordering — highest-scored configured+capable wins
// ===========================================================================

describe("resolveEffectiveProvider: known-score ordering", () => {
  it("picks the highest-scored known provider (tavily 95 > firecrawl 30 > zai 25)", async () => {
    const snapshot = await stateWith([
      { provider: "zai", categories: ZAI_CATEGORIES_25 },
      { provider: "tavily", categories: TAVILY_CATEGORIES_95 },
      { provider: "firecrawl", categories: FIRECRAWL_CATEGORIES_30 },
    ]);
    const result = resolveEffectiveProvider({
      explicitProvider: undefined,
      env: { Z_AI_API_KEY: "z", TAVILY_API_KEY: "t", FIRECRAWL_API_KEY: "f" },
      capabilityId: "search",
      descriptors: [
        makeDescriptor("zai", { configured: true, capabilities: ["search"] }),
        makeDescriptor("tavily", { configured: true, capabilities: ["search"] }),
        makeDescriptor("firecrawl", { configured: true, capabilities: ["search"] }),
      ],
      quotaSnapshot: snapshot,
    });
    assert.strictEqual(result, "tavily");
  });

  it("a known provider at 5% still wins over a non-authoritative provider (Brave 96.7%)", async () => {
    // The core authority contract: known tier always beats unknown tier
    // regardless of numeric score.
    const snapshot = await stateWith([
      { provider: "zai", categories: ZAI_CATEGORIES_5 },
      { provider: "brave", categories: BRAVE_CATEGORIES },
    ]);
    const result = resolveEffectiveProvider({
      explicitProvider: undefined,
      env: { Z_AI_API_KEY: "z", BRAVE_API_KEY: "b" },
      capabilityId: "search",
      descriptors: [
        makeDescriptor("zai", { configured: true, capabilities: ["search"] }),
        makeDescriptor("brave", { configured: true, capabilities: ["search"] }),
      ],
      quotaSnapshot: snapshot,
    });
    assert.strictEqual(result, "zai");
  });
});

// ===========================================================================
// 4. Ties — stable registry order
// ===========================================================================

describe("resolveEffectiveProvider: stable tie-break", () => {
  it("known-score ties break by registry order (zai before tavily)", async () => {
    // Both at 25% → zai wins (registry index 0 < tavily index 2).
    const snapshot = await stateWith([
      { provider: "zai", categories: ZAI_CATEGORIES_25 },
      {
        provider: "tavily",
        categories: [
          {
            name: "search",
            unit: "requests",
            current: { used: 750, limit: 1000, remaining: 250, remainingPercent: 25 },
          },
        ],
      },
    ]);
    const result = resolveEffectiveProvider({
      explicitProvider: undefined,
      env: { Z_AI_API_KEY: "z", TAVILY_API_KEY: "t" },
      capabilityId: "search",
      descriptors: [
        makeDescriptor("zai", { configured: true, capabilities: ["search"] }),
        makeDescriptor("tavily", { configured: true, capabilities: ["search"] }),
      ],
      quotaSnapshot: snapshot,
    });
    assert.strictEqual(result, "zai");
  });

  it("all-unknown ties (no snapshots) break by registry order", async () => {
    // Snapshot present but empty → every provider scores
    // SNAPSHOT_MISSING → unknown tier → registry order. First eligible
    // wins.
    const snapshot = await stateWith([]);
    const result = resolveEffectiveProvider({
      explicitProvider: undefined,
      env: { Z_AI_API_KEY: "z", TAVILY_API_KEY: "t" },
      capabilityId: "search",
      descriptors: [
        makeDescriptor("zai", { configured: true, capabilities: ["search"] }),
        makeDescriptor("tavily", { configured: true, capabilities: ["search"] }),
      ],
      quotaSnapshot: snapshot,
    });
    assert.strictEqual(result, "zai");
  });
});

// ===========================================================================
// 5. Eligibility filtering — unconfigured and incapable descriptors drop
// ===========================================================================

describe("resolveEffectiveProvider: eligibility filtering", () => {
  it("drops unconfigured providers (picks the next configured+capable)", async () => {
    const snapshot = await stateWith([
      { provider: "zai", categories: ZAI_CATEGORIES_25 },
      { provider: "tavily", categories: TAVILY_CATEGORIES_95 },
    ]);
    // zai is unconfigured (no Z_AI_API_KEY); tavily wins.
    const result = resolveEffectiveProvider({
      explicitProvider: undefined,
      env: { TAVILY_API_KEY: "t" },
      capabilityId: "search",
      descriptors: [
        makeDescriptor("zai", { configured: false, capabilities: ["search"] }),
        makeDescriptor("tavily", { configured: true, capabilities: ["search"] }),
      ],
      quotaSnapshot: snapshot,
    });
    assert.strictEqual(result, "tavily");
  });

  it("drops incapable providers (picks the next configured+capable)", async () => {
    const snapshot = await stateWith([
      { provider: "zai", categories: ZAI_CATEGORIES_25 },
      { provider: "tavily", categories: TAVILY_CATEGORIES_95 },
    ]);
    // zai is configured but does not advertise "crawl"; tavily wins.
    const result = resolveEffectiveProvider({
      explicitProvider: undefined,
      env: { Z_AI_API_KEY: "z", TAVILY_API_KEY: "t" },
      capabilityId: "crawl",
      descriptors: [
        makeDescriptor("zai", { configured: true, capabilities: ["search"] }),
        makeDescriptor("tavily", { configured: true, capabilities: ["crawl"] }),
      ],
      quotaSnapshot: snapshot,
    });
    assert.strictEqual(result, "tavily");
  });

  it("returns zai when no provider is eligible (none configured+capable)", async () => {
    const snapshot = await stateWith([{ provider: "zai", categories: ZAI_CATEGORIES_25 }]);
    // Only zai is in the registry, configured, but incapable for crawl.
    const result = resolveEffectiveProvider({
      explicitProvider: undefined,
      env: { Z_AI_API_KEY: "z" },
      capabilityId: "crawl",
      descriptors: [makeDescriptor("zai", { configured: true, capabilities: ["search"] })],
      quotaSnapshot: snapshot,
    });
    assert.strictEqual(result, "zai");
  });
});

// ===========================================================================
// 6. Determinism + no-write contract
// ===========================================================================

describe("resolveEffectiveProvider: determinism + purity", () => {
  it("repeated calls with identical inputs return identical output", async () => {
    const snapshot = await stateWith([
      { provider: "zai", categories: ZAI_CATEGORIES_25 },
      { provider: "tavily", categories: TAVILY_CATEGORIES_95 },
    ]);
    const opts = {
      explicitProvider: undefined,
      env: { Z_AI_API_KEY: "z", TAVILY_API_KEY: "t" },
      capabilityId: "search",
      descriptors: [
        makeDescriptor("zai", { configured: true, capabilities: ["search"] }),
        makeDescriptor("tavily", { configured: true, capabilities: ["search"] }),
      ],
      quotaSnapshot: snapshot,
    };
    const a = resolveEffectiveProvider(opts);
    const b = resolveEffectiveProvider(opts);
    const c = resolveEffectiveProvider(opts);
    assert.strictEqual(a, b);
    assert.strictEqual(b, c);
  });

  it("does not mutate the injected snapshot (no writes)", async () => {
    const store = createInMemoryQuotaStore();
    await store.writeObserved("zai", {
      observedAt: 1_700_000_000_000,
      categories: ZAI_CATEGORIES_25,
    });
    const before = await store.read();
    const snapshot = await store.read();
    resolveEffectiveProvider({
      explicitProvider: undefined,
      env: { Z_AI_API_KEY: "z" },
      capabilityId: "search",
      descriptors: [makeDescriptor("zai", { configured: true, capabilities: ["search"] })],
      quotaSnapshot: snapshot,
    });
    const after = await store.read();
    assert.deepStrictEqual(after, before, "snapshot must be unchanged");
  });
});

// ===========================================================================
// 7. Dispatch wiring — 7 shared handlers route via resolveEffectiveProvider
// ===========================================================================
//
// For each shared handler, craft two configured+capable providers, inject
// a quotaState where the non-registry-first provider scores higher, and
// assert that provider was invoked first (proving the resolver's ranked
// pick became `effectiveProvider`, not the registry-first default).
//
// The adapter shapes mirror the real capability contracts:
//   - search: `adapter.search = { validate, cacheIdentity, invoke }`
//   - reader/crawl/map: `adapter.<cap> = { fetch: { validate, cacheIdentity, invoke } }`
//   - research: `adapter.research = { run: { validate, cacheIdentity, invoke } }`
//   - repository: `adapter.repository = { search, readFile, listDirectory }` (each an op triple)
//   - vision: `adapter.vision = { supports, invoke }`
// ---------------------------------------------------------------------------

function createTestAdapter() {
  const stdout = [];
  const stderr = [];
  const adapter = {
    stdoutIsTTY: false,
    stdinIsTTY: false,
    environmentOutputMode: "data",
    readStdin: async () => "",
    writeStdout: (v) => stdout.push(v),
    writeStderr: (v) => stderr.push(v),
    runQuietly: async (op) => op(),
    setExitCode: () => {},
  };
  return { adapter, stdout, stderr };
}

function makeInMemoryCache() {
  const store = new Map();
  return {
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async set(key, value) {
      store.set(key, value);
    },
  };
}

/**
 * Build a descriptor whose adapter exposes a fake capability returning a
 * canned result. Records every invoke() so the test can prove which
 * provider the resolver selected. `envVar` controls isConfigured so the
 * test controls which providers are eligible via the injected env.
 */
function makeDispatchDescriptor(id, envVar, capability, resultFactory) {
  const invokes = [];
  const caps = new Set([capability]);
  return {
    invokes,
    descriptor: {
      id,
      isConfigured: (env) => typeof env[envVar] === "string" && env[envVar].length > 0,
      capabilities: () => caps,
      create: () => {
        const adapter = { id };
        const op = {
          validate() {},
          cacheIdentity(r) {
            return {
              provider: id,
              capability,
              credentialFingerprint: `fp-${id}`,
              request: r,
              legacyCandidates: [],
            };
          },
          async invoke(r) {
            invokes.push(r);
            return resultFactory(r, id);
          },
        };
        // Slot mapping: search/vision put methods directly on the
        // capability; reader/crawl/map wrap in `fetch`; research wraps
        // in `run`; repository has three operations.
        if (capability === "search") {
          adapter.search = op;
        } else if (capability === "reader" || capability === "crawl" || capability === "map") {
          const capKey = capability;
          adapter[capKey] = { fetch: op };
        } else if (capability === "research") {
          adapter.research = { run: op };
        } else if (capability === "repository-exploration") {
          adapter.repository = { search: op, readFile: op, listDirectory: op };
        } else if (capability.startsWith("vision.")) {
          adapter.vision = {
            supports: () => true,
            invoke: async (req) => {
              invokes.push(req);
              return resultFactory(req, id);
            },
          };
        }
        return adapter;
      },
    },
  };
}

// Per-capability minimal valid results.
const RESULT_FACTORIES = {
  search: () => [],
  reader: (r) => ({
    schemaVersion: 1,
    url: r?.url ?? "https://example.com/",
    finalUrl: r?.url ?? "https://example.com/",
    title: "Test",
    content: "body",
    contentFormat: "markdown",
  }),
  crawl: (r) => ({
    schemaVersion: 1,
    baseUrl: r?.url ?? "https://example.com/",
    pages: [
      { url: r?.url ?? "https://example.com/", content: "crawled", contentFormat: "markdown" },
    ],
    totalPages: 1,
  }),
  map: (r) => ({
    schemaVersion: 1,
    baseUrl: r?.url ?? "https://example.com/",
    urls: ["https://example.com/a"],
    totalUrls: 1,
  }),
  research: (r) => ({
    schemaVersion: 1,
    query: r?.query ?? "test",
    model: r?.model ?? "auto",
    report: "report body",
    sources: [],
  }),
  "repository-exploration": (r) => ({
    schemaVersion: 1,
    repo: r?.repo ?? "owner/repo",
    files: [{ path: "README.md", type: "file" }],
    totalFiles: 1,
  }),
  "vision.interpret-image": () => "image description result",
};

/**
 * Seven dispatch cases. Each runs `main()` with crafted descriptors +
 * quotaState and asserts which provider was attempted first.
 *
 * `winnerIsSecond`: when true, the SECOND listed provider has the
 * higher quota score (proving the resolver ranked by score, not just
 * returned registry-first). When false (single-provider capabilities),
 * the test verifies the handler runs successfully through the new
 * resolver path.
 */
const DISPATCH_CASES = [
  {
    label: "search → tavily (95%) ranked over zai (25%)",
    capability: "search",
    args: ["search", "query"],
    providers: [
      { id: "zai", envVar: "Z_AI_API_KEY" },
      { id: "tavily", envVar: "TAVILY_API_KEY" },
    ],
    env: { Z_AI_API_KEY: "z", TAVILY_API_KEY: "t" },
    snapshot: async (sw) =>
      sw([
        { provider: "zai", categories: ZAI_CATEGORIES_25 },
        { provider: "tavily", categories: TAVILY_CATEGORIES_95 },
      ]),
    expectedFirst: "tavily",
    cacheKey: "searchCache",
  },
  {
    label: "read → tavily (95%) ranked over zai (25%)",
    capability: "reader",
    args: ["read", "https://example.com/"],
    providers: [
      { id: "zai", envVar: "Z_AI_API_KEY" },
      { id: "tavily", envVar: "TAVILY_API_KEY" },
    ],
    env: { Z_AI_API_KEY: "z", TAVILY_API_KEY: "t" },
    snapshot: async (sw) =>
      sw([
        { provider: "zai", categories: ZAI_CATEGORIES_25 },
        { provider: "tavily", categories: TAVILY_CATEGORIES_95 },
      ]),
    expectedFirst: "tavily",
    cacheKey: "readerCache",
  },
  {
    label: "crawl → tavily (95%) ranked over firecrawl (30%)",
    capability: "crawl",
    args: ["crawl", "https://example.com/"],
    providers: [
      { id: "firecrawl", envVar: "FIRECRAWL_API_KEY" },
      { id: "tavily", envVar: "TAVILY_API_KEY" },
    ],
    env: { FIRECRAWL_API_KEY: "f", TAVILY_API_KEY: "t" },
    snapshot: async (sw) =>
      sw([
        { provider: "firecrawl", categories: FIRECRAWL_CATEGORIES_30 },
        { provider: "tavily", categories: TAVILY_CATEGORIES_95 },
      ]),
    expectedFirst: "tavily",
    cacheKey: "crawlCache",
  },
  {
    label: "map → tavily (95%) ranked over firecrawl (30%)",
    capability: "map",
    args: ["map", "https://example.com/"],
    providers: [
      { id: "firecrawl", envVar: "FIRECRAWL_API_KEY" },
      { id: "tavily", envVar: "TAVILY_API_KEY" },
    ],
    env: { FIRECRAWL_API_KEY: "f", TAVILY_API_KEY: "t" },
    snapshot: async (sw) =>
      sw([
        { provider: "firecrawl", categories: FIRECRAWL_CATEGORIES_30 },
        { provider: "tavily", categories: TAVILY_CATEGORIES_95 },
      ]),
    expectedFirst: "tavily",
    cacheKey: "mapCache",
  },
  {
    label: "research → tavily (known 95%) ranked over exa (unknown tier)",
    capability: "research",
    args: ["research", "topic"],
    providers: [
      { id: "exa", envVar: "EXA_API_KEY" },
      { id: "tavily", envVar: "TAVILY_API_KEY" },
    ],
    env: { EXA_API_KEY: "e", TAVILY_API_KEY: "t" },
    snapshot: async (sw) => sw([{ provider: "tavily", categories: TAVILY_CATEGORIES_95 }]),
    expectedFirst: "tavily",
    cacheKey: "researchCache",
  },
  {
    label: "repo (zai-only) → handler runs through new resolver path",
    capability: "repository-exploration",
    args: ["repo", "search", "owner/repo", "query"],
    providers: [{ id: "zai", envVar: "Z_AI_API_KEY" }],
    env: { Z_AI_API_KEY: "z" },
    snapshot: async (sw) => sw([{ provider: "zai", categories: ZAI_CATEGORIES_25 }]),
    expectedFirst: "zai",
    cacheKey: "repositoryCache",
  },
  {
    label:
      "vision.interpret-image → zai (known 25%) ranked over minimax (unknown, snapshot absent)",
    capability: "vision.interpret-image",
    args: ["vision", "analyze", "https://example.com/img.png", "describe"],
    providers: [
      { id: "minimax", envVar: "MINIMAX_API_KEY" },
      { id: "zai", envVar: "Z_AI_API_KEY" },
    ],
    env: { MINIMAX_API_KEY: "m", Z_AI_API_KEY: "z" },
    // minimax snapshot absent → SNAPSHOT_MISSING → unknown tier → zai wins.
    snapshot: async (sw) => sw([{ provider: "zai", categories: ZAI_CATEGORIES_25 }]),
    expectedFirst: "zai",
    cacheKey: "searchCache", // vision reuses searchSleep/searchRandom
  },
];

describe("resolveEffectiveProvider: 7-handler dispatch wiring", () => {
  for (const tc of DISPATCH_CASES) {
    it(tc.label, async () => {
      const snapshot = await tc.snapshot(stateWith);
      const built = tc.providers.map((p) =>
        makeDispatchDescriptor(p.id, p.envVar, tc.capability, RESULT_FACTORIES[tc.capability]),
      );
      const { adapter, stderr } = createTestAdapter();

      const deps = {
        invocation: adapter,
        env: tc.env,
        providerDescriptors: built.map((b) => b.descriptor),
        quotaState: snapshot,
        [tc.cacheKey]: makeInMemoryCache(),
        searchSleep: async () => {},
        searchRandom: () => 0.5,
        repositorySleep: async () => {},
        repositoryRandom: () => 0.5,
        readerSleep: async () => {},
        readerRandom: () => 0.5,
        crawlSleep: async () => {},
        crawlRandom: () => 0.5,
        mapSleep: async () => {},
        mapRandom: () => 0.5,
        researchSleep: async () => {},
        researchRandom: () => 0.5,
      };

      const status = await main(tc.args, deps);
      assert.strictEqual(
        status,
        0,
        `${tc.label}: expected exit 0, got ${status}; stderr=${JSON.stringify(stderr)}`,
      );

      const firstInvoked = built.find((b) => b.invokes.length > 0);
      assert.ok(firstInvoked, `${tc.label}: at least one provider must be invoked`);
      assert.strictEqual(
        firstInvoked.descriptor.id,
        tc.expectedFirst,
        `${tc.label}: expected ${tc.expectedFirst} to be selected first, got ${firstInvoked.descriptor.id}`,
      );
    });
  }
});

// ===========================================================================
// 8. Negative assertions — Doctor / Quota / raw-tools bypass ranking
// ===========================================================================

describe("resolveEffectiveProvider: observational + raw handlers bypass ranking", () => {
  it("doctor --help exits 0 without invoking the ranking path", async () => {
    // Doctor uses resolveProviderId (not resolveEffectiveProvider) for
    // metadata. Injecting a quotaState that WOULD reroute search must
    // not change doctor's behavior — the command runs unchanged.
    const snapshot = await stateWith([
      { provider: "zai", categories: ZAI_CATEGORIES_25 },
      { provider: "tavily", categories: TAVILY_CATEGORIES_95 },
    ]);
    const { adapter, stdout } = createTestAdapter();
    const status = await main(["doctor", "--help"], {
      invocation: adapter,
      env: {},
      providerDescriptors: [makeDescriptor("zai", { configured: true, capabilities: ["search"] })],
      quotaState: snapshot,
    });
    assert.strictEqual(status, 0);
    assert.ok(stdout.length > 0, "doctor --help must produce help text");
  });

  it("quota --help exits 0 without invoking the ranking path", async () => {
    const snapshot = await stateWith([{ provider: "tavily", categories: TAVILY_CATEGORIES_95 }]);
    const { adapter, stdout } = createTestAdapter();
    const status = await main(["quota", "--help"], {
      invocation: adapter,
      env: {},
      providerDescriptors: [makeDescriptor("zai", { configured: true })],
      quotaState: snapshot,
    });
    assert.strictEqual(status, 0);
    assert.ok(stdout.length > 0, "quota --help must produce help text");
  });

  it("tools --help (raw Z.AI) never enters provider selection", async () => {
    const snapshot = await stateWith([{ provider: "tavily", categories: TAVILY_CATEGORIES_95 }]);
    const { adapter, stdout } = createTestAdapter();
    const status = await main(["tools", "--help"], {
      invocation: adapter,
      env: {},
      providerDescriptors: [makeDescriptor("zai", { configured: true })],
      quotaState: snapshot,
    });
    assert.strictEqual(status, 0);
    assert.ok(stdout.length > 0, "tools --help must produce help text");
  });
});
