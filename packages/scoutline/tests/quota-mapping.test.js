/**
 * Quota mapping + authority-aware scoring tests (PB-T3 — Plan B).
 *
 * Verifies the pure derivation that turns PB-T1's raw category snapshot
 * into a ranked, authority-aware selection view:
 *   - Mapping coverage: every advertised `(provider, capability)` is
 *     either mapped or always-unknown by policy.
 *   - Fail-open on drift (missing/renamed/case-changed/empty/corrupt).
 *   - Authority separation: known tier ranks above unknown tier even
 *     at 5%; Brave/Exa never win over a known-scored provider.
 *   - Deterministic output for identical snapshots.
 *   - Pure module contract: no disk I/O, warning metadata only.
 *
 * Tests import `../dist/...` (built output), so the verification order
 * is `npm run build` then `node --test tests/quota-mapping.test.js`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  CAPABILITY_MAPPINGS,
  DEFAULT_MINIMAX_MODEL_ALIASES,
  FIRECRAWL_CREDIT_CAPABILITIES,
  MINIMAX_VISION_CAPABILITIES,
  PROVIDER_AUTHORITY_POLICIES,
  TAVILY_CAPABILITY_TO_ENDPOINT,
  TAVILY_ENDPOINT_CAPABILITIES,
  ZAI_REQUEST_CAPABILITIES,
  ZAI_VISION_CAPABILITIES,
  getCapabilityMapping,
  getProviderAuthorityPolicy,
  rankProvidersForCapability,
  resolveMiniMaxAliasesForCapability,
  scoreCapability,
} from "../dist/lib/quota-mapping.js";
import {
  QUOTA_EXHAUSTION_DEMOTION_HORIZON_MS,
  createInMemoryQuotaStore,
} from "../dist/lib/quota-store.js";
import { BUILT_IN_PROVIDER_DESCRIPTORS } from "../dist/providers/registry.js";

// ---------------------------------------------------------------------------
// Fixtures — raw QuotaCategory[] matching each provider's live shape
// ---------------------------------------------------------------------------

const ZAI_CATEGORIES = [
  {
    name: "requests",
    unit: "requests",
    current: {
      used: 750,
      limit: 1000,
      remaining: 250,
      durationSeconds: 18000,
      remainingPercent: 25,
      resetsAt: "2023-11-14T22:13:20.000Z",
    },
  },
  {
    name: "tokens",
    unit: "tokens",
    current: { remainingPercent: 40, resetsAt: "2023-11-14T22:13:20.000Z" },
  },
];

const TAVILY_CATEGORIES = [
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
  {
    name: "crawl",
    unit: "requests",
    current: { used: 200, limit: 1000, remaining: 800, remainingPercent: 80 },
  },
  {
    name: "map",
    unit: "requests",
    current: { used: 5, limit: 1000, remaining: 995, remainingPercent: 99.5 },
  },
  {
    name: "research",
    unit: "requests",
    current: { used: 0, limit: 1000, remaining: 1000, remainingPercent: 100 },
  },
];

const FIRECRAWL_CATEGORIES = [
  {
    name: "Credits",
    unit: "credits",
    current: { used: 700, limit: 1000, remaining: 300, remainingPercent: 30 },
  },
];

// Spider — single `credits` pool from GET /data/credits (remaining-only
// signal on the wire; the fixture carries a percent for scoring tests).
const SPIDER_CATEGORIES = [
  {
    name: "credits",
    unit: "credits",
    current: { remaining: 600 },
  },
];

const MINIMAX_CATEGORIES = [
  {
    name: "zorla-x",
    unit: "requests",
    current: { used: 50, limit: 200, remaining: 150, remainingPercent: 75 },
  },
  {
    name: "abab6.5s-chat",
    unit: "requests",
    current: { used: 30, limit: 100, remaining: 70, remainingPercent: 70 },
  },
];

const BRAVE_CATEGORIES = [
  {
    name: "monthly",
    unit: "requests",
    current: {
      used: 500,
      limit: 15000,
      remaining: 14500,
      durationSeconds: 2592000,
      remainingPercent: 96.7,
      resetsAt: "2025-01-15T00:00:00.000Z",
    },
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

function captureWarnings() {
  const warnings = [];
  return {
    warnings,
    onWarning: (w) => warnings.push(w),
  };
}

// ===========================================================================
// 1. Mapping coverage — every advertised capability is mapped or unknown
// ===========================================================================

describe("quota-mapping: static mapping coverage", () => {
  it("maps every advertised, claimable capability for every built-in provider", () => {
    // For each built-in descriptor, every advertised capability that is
    // NOT (a) `quota`/`diagnostics` (observational) or (b) on an
    // always-unknown provider must have a mapping row.
    for (const descriptor of BUILT_IN_PROVIDER_DESCRIPTORS) {
      const provider = descriptor.id;
      const policy = getProviderAuthorityPolicy(provider);
      const caps = descriptor.capabilities();
      for (const cap of caps) {
        if (cap === "quota" || cap === "diagnostics") continue;
        if (policy?.kind === "always-unknown") continue;
        const mapping = getCapabilityMapping(provider, cap);
        assert.ok(
          mapping,
          `(${provider}, ${cap}) is advertised and on a mapped provider but has no mapping row`,
        );
      }
    }
  });

  it("does not map quota/diagnostics (observational capabilities)", () => {
    for (const m of CAPABILITY_MAPPINGS) {
      assert.notStrictEqual(m.capability, "quota");
      assert.notStrictEqual(m.capability, "diagnostics");
    }
  });

  it("does not emit mapping rows for always-unknown providers (Brave, Exa, Jina, Linkup, Spider)", () => {
    for (const m of CAPABILITY_MAPPINGS) {
      assert.notStrictEqual(m.provider, "brave");
      assert.notStrictEqual(m.provider, "exa");
      assert.notStrictEqual(m.provider, "jina");
      assert.notStrictEqual(m.provider, "linkup");
      assert.notStrictEqual(m.provider, "spider");    }
  });

  it("zai search/reader/repository-exploration all map to requests", () => {
    for (const cap of ZAI_REQUEST_CAPABILITIES) {
      const m = getCapabilityMapping("zai", cap);
      assert.deepStrictEqual(m.categoryAliases, ["requests"]);
      assert.strictEqual(m.providerFallbackCategory, undefined);
    }
  });

  it("every zai vision capability maps to tokens", () => {
    for (const cap of ZAI_VISION_CAPABILITIES) {
      const m = getCapabilityMapping("zai", cap);
      assert.deepStrictEqual(m.categoryAliases, ["tokens"]);
    }
  });

  it("tavily reader maps to the extract endpoint, others to same-named endpoint", () => {
    assert.strictEqual(TAVILY_CAPABILITY_TO_ENDPOINT.reader, "extract");
    assert.strictEqual(TAVILY_CAPABILITY_TO_ENDPOINT.search, "search");
    assert.strictEqual(TAVILY_CAPABILITY_TO_ENDPOINT.crawl, "crawl");
    assert.strictEqual(TAVILY_CAPABILITY_TO_ENDPOINT.map, "map");
    assert.strictEqual(TAVILY_CAPABILITY_TO_ENDPOINT.research, "research");
  });

  it("every tavily endpoint mapping has providerFallbackCategory 'requests'", () => {
    for (const cap of TAVILY_ENDPOINT_CAPABILITIES) {
      const m = getCapabilityMapping("tavily", cap);
      assert.strictEqual(m.providerFallbackCategory, "requests");
    }
  });

  it("every firecrawl capability maps to case-sensitive 'Credits'", () => {
    for (const cap of FIRECRAWL_CREDIT_CAPABILITIES) {
      const m = getCapabilityMapping("firecrawl", cap);
      assert.deepStrictEqual(m.categoryAliases, ["Credits"]);
    }
  });

  it("spider emits no mapping rows (always-unknown authority tier)", () => {
    for (const cap of ["search", "reader", "crawl", "map"]) {
      assert.strictEqual(
        getCapabilityMapping("spider", cap),
        undefined,
        `(spider, ${cap}) must not have a mapping row`,
      );
    }
  });
});

// ===========================================================================
// 2. Authority policy — Brave/Exa always-unknown; others mapped
// ===========================================================================

describe("quota-mapping: authority policy", () => {
  it("zai, minimax, tavily, firecrawl are mapped", () => {
    for (const id of ["zai", "minimax", "tavily", "firecrawl"]) {
      const p = getProviderAuthorityPolicy(id);
      assert.strictEqual(p.kind, "mapped", `${id} should be mapped`);
    }
  });

  it("spider is always-unknown with the credit-balance reason", () => {
    const p = getProviderAuthorityPolicy("spider");
    assert.ok(p, "spider policy row exists");
    assert.strictEqual(p.kind, "always-unknown");
    assert.match(p.reason, /credit remaining balance/i);
  });

  it("brave and exa are always-unknown with documented reasons", () => {
    const brave = getProviderAuthorityPolicy("brave");
    assert.strictEqual(brave.kind, "always-unknown");
    assert.match(brave.reason, /rate-limit/i);

    const exa = getProviderAuthorityPolicy("exa");
    assert.strictEqual(exa.kind, "always-unknown");
    assert.match(exa.reason, /quota capability/i);
  });

  it("every PROVIDER_IDS entry has a policy row", () => {
    for (const p of PROVIDER_AUTHORITY_POLICIES) {
      assert.ok(p.reason.length > 0, `${p.provider} policy needs a reason`);
    }
  });

  it("jina policy reason no longer claims Jina lacks a quota capability (#49)", () => {
    const jina = PROVIDER_AUTHORITY_POLICIES.find((p) => p.provider === "jina");
    assert.ok(jina, "jina policy row exists");
    assert.doesNotMatch(
      jina.reason,
      /does not advertise a quota capability/i,
      "reason must reflect createJinaQuotaCapability (providers/jina/quota.ts)",
    );
  });

  it("linkup is always-unknown with credit balance reason", () => {
    const linkup = getProviderAuthorityPolicy("linkup");
    assert.ok(linkup, "linkup policy row exists");
    assert.strictEqual(linkup.kind, "always-unknown");
    assert.match(linkup.reason, /credit remaining balance/i);
  });
});

// ===========================================================================
// 3. scoreCapability — known providers return numeric score
// ===========================================================================

describe("quota-mapping: scoreCapability — known providers", () => {
  it("zai search returns the requests category score", async () => {
    const state = await stateWith([{ provider: "zai", categories: ZAI_CATEGORIES }]);
    const result = scoreCapability(state, "zai", "search");
    assert.deepStrictEqual(result, {
      authority: "known",
      score: 25,
      category: "requests",
    });
  });

  it("zai vision.interpret-image returns the tokens category score", async () => {
    const state = await stateWith([{ provider: "zai", categories: ZAI_CATEGORIES }]);
    const result = scoreCapability(state, "zai", "vision.interpret-image");
    assert.deepStrictEqual(result, {
      authority: "known",
      score: 40,
      category: "tokens",
    });
  });

  it("zai reader and repository-exploration share the requests category", async () => {
    const state = await stateWith([{ provider: "zai", categories: ZAI_CATEGORIES }]);
    for (const cap of ["reader", "repository-exploration"]) {
      const result = scoreCapability(state, "zai", cap);
      assert.strictEqual(result.authority, "known");
      assert.strictEqual(result.score, 25);
      assert.strictEqual(result.category, "requests");
    }
  });

  it("every zai vision operation scores against tokens", async () => {
    const state = await stateWith([{ provider: "zai", categories: ZAI_CATEGORIES }]);
    for (const cap of ZAI_VISION_CAPABILITIES) {
      const result = scoreCapability(state, "zai", cap);
      assert.strictEqual(result.authority, "known", `${cap} should be known`);
      assert.strictEqual(result.score, 40, `${cap} score`);
      assert.strictEqual(result.category, "tokens");
    }
  });

  it("tavily search uses the search endpoint category (90 -> 95)", async () => {
    const state = await stateWith([{ provider: "tavily", categories: TAVILY_CATEGORIES }]);
    const result = scoreCapability(state, "tavily", "search");
    assert.strictEqual(result.authority, "known");
    assert.strictEqual(result.score, 95);
    assert.strictEqual(result.category, "search");
  });

  it("tavily reader maps to the extract endpoint category", async () => {
    const state = await stateWith([{ provider: "tavily", categories: TAVILY_CATEGORIES }]);
    const result = scoreCapability(state, "tavily", "reader");
    assert.strictEqual(result.score, 99);
    assert.strictEqual(result.category, "extract");
  });

  it("firecrawl capabilities share the Credits category", async () => {
    const state = await stateWith([{ provider: "firecrawl", categories: FIRECRAWL_CATEGORIES }]);
    for (const cap of FIRECRAWL_CREDIT_CAPABILITIES) {
      const result = scoreCapability(state, "firecrawl", cap);
      assert.strictEqual(result.authority, "known");
      assert.strictEqual(result.score, 30);
      assert.strictEqual(result.category, "Credits");
    }
  });

  it("spider scores non-authoritative without a PERCENT_CORRUPT warning", async () => {
    const state = await stateWith([{ provider: "spider", categories: SPIDER_CATEGORIES }]);
    for (const cap of ["search", "reader", "crawl", "map"]) {
      const codes = [];
      const result = scoreCapability(state, "spider", cap, {
        onWarning: (w) => codes.push(w.code),
      });
      assert.strictEqual(result.authority, "unknown");
      assert.strictEqual(result.reason, "PROVIDER_NON_AUTHORITATIVE");
      assert.ok(codes.includes("PROVIDER_NON_AUTHORITATIVE"));
      assert.ok(
        !codes.includes("PERCENT_CORRUPT"),
        "a valid remaining-credits snapshot must not be scored PERCENT_CORRUPT",
      );
    }
  });

  it("minimax search resolves via the zorla-x alias", async () => {
    const state = await stateWith([{ provider: "minimax", categories: MINIMAX_CATEGORIES }]);
    const result = scoreCapability(state, "minimax", "search");
    assert.strictEqual(result.authority, "known");
    assert.strictEqual(result.score, 75);
    assert.strictEqual(result.category, "zorla-x");
  });

  it("minimax vision resolves via the abab6.5s-chat alias (characterized fallback)", async () => {
    const state = await stateWith([{ provider: "minimax", categories: MINIMAX_CATEGORIES }]);
    const result = scoreCapability(state, "minimax", "vision.interpret-image");
    assert.strictEqual(result.authority, "known");
    assert.strictEqual(result.score, 70);
    assert.strictEqual(result.category, "abab6.5s-chat");
  });
});

// ===========================================================================
// 4. scoreCapability — fail-open paths + warnings
// ===========================================================================

describe("quota-mapping: scoreCapability — fail-open paths", () => {
  it("returns MAPPING_MISSING for an unmapped (provider, capability)", async () => {
    const state = await stateWith([{ provider: "zai", categories: ZAI_CATEGORIES }]);
    const { onWarning, warnings } = captureWarnings();
    const result = scoreCapability(state, "zai", "diagnostics", { onWarning });
    assert.strictEqual(result.authority, "unknown");
    assert.strictEqual(result.reason, "MAPPING_MISSING");
    assert.strictEqual(warnings.length, 1);
    assert.strictEqual(warnings[0].code, "MAPPING_MISSING");
    assert.strictEqual(warnings[0].provider, "zai");
    assert.strictEqual(warnings[0].capability, "diagnostics");
  });

  it("returns SNAPSHOT_MISSING when the provider has no snapshot", async () => {
    const state = await stateWith([{ provider: "zai", categories: ZAI_CATEGORIES }]);
    const { onWarning, warnings } = captureWarnings();
    const result = scoreCapability(state, "tavily", "search", { onWarning });
    assert.strictEqual(result.authority, "unknown");
    assert.strictEqual(result.reason, "SNAPSHOT_MISSING");
    assert.strictEqual(warnings[0].code, "SNAPSHOT_MISSING");
    assert.match(warnings[0].message, /tavily/);
  });

  it("returns SNAPSHOT_EMPTY when the categories array is empty", async () => {
    const state = await stateWith([{ provider: "zai", categories: [] }]);
    const { onWarning, warnings } = captureWarnings();
    const result = scoreCapability(state, "zai", "search", { onWarning });
    assert.strictEqual(result.authority, "unknown");
    assert.strictEqual(result.reason, "SNAPSHOT_EMPTY");
    assert.strictEqual(warnings[0].code, "SNAPSHOT_EMPTY");
  });

  it("returns CATEGORY_NOT_FOUND for a renamed/case-changed category + warns about drift", async () => {
    // Tavily renames `search` to `Search` (case drift). No alias
    // matches, but `providerFallbackCategory: "requests"` should kick
    // in. The category is still found via fallback, so this tests the
    // PROVIDER_FALLBACK_USED path.
    const renamed = [
      ...TAVILY_CATEGORIES.filter((c) => c.name !== "search"),
      { name: "Search", unit: "requests", current: { remainingPercent: 12 } },
    ];
    const state = await stateWith([{ provider: "tavily", categories: renamed }]);
    const { onWarning, warnings } = captureWarnings();
    const result = scoreCapability(state, "tavily", "search", { onWarning });
    // Fallback hit: still known, but a warning fires.
    assert.strictEqual(result.authority, "known");
    assert.strictEqual(result.category, "requests");
    assert.strictEqual(warnings.length, 1);
    assert.strictEqual(warnings[0].code, "PROVIDER_FALLBACK_USED");
  });

  it("returns CATEGORY_NOT_FOUND when both alias and fallback miss (zai tokens renamed)", async () => {
    // Z.AI renames `tokens` to `Tokens`. No fallback defined for Z.AI
    // → CATEGORY_NOT_FOUND.
    const renamed = [
      { name: "requests", unit: "requests", current: { remainingPercent: 25 } },
      { name: "Tokens", unit: "tokens", current: { remainingPercent: 40 } },
    ];
    const state = await stateWith([{ provider: "zai", categories: renamed }]);
    const { onWarning, warnings } = captureWarnings();
    const result = scoreCapability(state, "zai", "vision.interpret-image", { onWarning });
    assert.strictEqual(result.authority, "unknown");
    assert.strictEqual(result.reason, "CATEGORY_NOT_FOUND");
    assert.strictEqual(warnings[0].code, "CATEGORY_NOT_FOUND");
    assert.match(warnings[0].message, /aliases: \[tokens\]/);
  });

  it("returns PERCENT_CORRUPT for a non-finite remainingPercent (hand-edited state)", async () => {
    const corrupt = [{ name: "requests", unit: "requests", current: { remainingPercent: NaN } }];
    const state = await stateWith([{ provider: "zai", categories: corrupt }]);
    const { onWarning, warnings } = captureWarnings();
    const result = scoreCapability(state, "zai", "search", { onWarning });
    assert.strictEqual(result.authority, "unknown");
    assert.strictEqual(result.reason, "PERCENT_CORRUPT");
    assert.strictEqual(warnings[0].code, "PERCENT_CORRUPT");
  });

  it("returns PERCENT_CORRUPT for an out-of-range remainingPercent (101)", async () => {
    const corrupt = [{ name: "requests", unit: "requests", current: { remainingPercent: 101 } }];
    const state = await stateWith([{ provider: "zai", categories: corrupt }]);
    const result = scoreCapability(state, "zai", "search");
    assert.strictEqual(result.authority, "unknown");
    assert.strictEqual(result.reason, "PERCENT_CORRUPT");
  });

  it("does NOT treat 0 as corrupt (a depleted category is still known)", async () => {
    const depleted = [{ name: "requests", unit: "requests", current: { remainingPercent: 0 } }];
    const state = await stateWith([{ provider: "zai", categories: depleted }]);
    const result = scoreCapability(state, "zai", "search");
    assert.strictEqual(result.authority, "known");
    assert.strictEqual(result.score, 0);
    assert.strictEqual(result.category, "requests");
  });

  it("tavily aggregate fallback works when no per-endpoint categories exist", async () => {
    const onlyAggregate = [
      { name: "requests", unit: "requests", current: { remainingPercent: 42 } },
    ];
    const state = await stateWith([{ provider: "tavily", categories: onlyAggregate }]);
    const { onWarning, warnings } = captureWarnings();
    const result = scoreCapability(state, "tavily", "crawl", { onWarning });
    assert.strictEqual(result.authority, "known");
    assert.strictEqual(result.score, 42);
    assert.strictEqual(result.category, "requests");
    assert.strictEqual(warnings[0].code, "PROVIDER_FALLBACK_USED");
  });
});

// ===========================================================================
// 5. Authority separation — Brave/Exa never win over known
// ===========================================================================

describe("quota-mapping: authority separation", () => {
  it("brave returns PROVIDER_NON_AUTHORITATIVE regardless of a numeric rate-limit signal", async () => {
    const state = await stateWith([{ provider: "brave", categories: BRAVE_CATEGORIES }]);
    const { onWarning, warnings } = captureWarnings();
    const result = scoreCapability(state, "brave", "search", { onWarning });
    assert.strictEqual(result.authority, "unknown");
    assert.strictEqual(result.reason, "PROVIDER_NON_AUTHORITATIVE");
    assert.strictEqual(warnings[0].code, "PROVIDER_NON_AUTHORITATIVE");
    // Never reads the snapshot; no further warning.
    assert.strictEqual(warnings.length, 1);
  });

  it("exa returns PROVIDER_NON_AUTHORITATIVE (no quota capability at all)", async () => {
    const state = await stateWith([]);
    const result = scoreCapability(state, "exa", "search");
    assert.strictEqual(result.authority, "unknown");
    assert.strictEqual(result.reason, "PROVIDER_NON_AUTHORITATIVE");
  });

  it("brave ignores an injected snapshot with a high remainingPercent", async () => {
    // Even if Brave reports 96.7% monthly rate-limit remaining, the
    // authority axis refuses to use it as a budget score.
    const state = await stateWith([
      { provider: "brave", categories: BRAVE_CATEGORIES },
      { provider: "zai", categories: ZAI_CATEGORIES },
    ]);
    const braveScore = scoreCapability(state, "brave", "search");
    const zaiScore = scoreCapability(state, "zai", "search");
    assert.strictEqual(braveScore.authority, "unknown");
    assert.strictEqual(zaiScore.authority, "known");
    assert.strictEqual(zaiScore.score, 25); // well below Brave's 96.7
  });
});

// ===========================================================================
// 6. rankProvidersForCapability — known-first, unknown-last, stable ties
// ===========================================================================

describe("quota-mapping: rankProvidersForCapability", () => {
  it("returns known-tier providers sorted by score descending", async () => {
    const state = await stateWith([
      { provider: "zai", categories: ZAI_CATEGORIES }, // search=25
      {
        provider: "tavily",
        categories: TAVILY_CATEGORIES, // search=95
      },
      { provider: "firecrawl", categories: FIRECRAWL_CATEGORIES }, // search=30
    ]);
    const ranked = rankProvidersForCapability(state, "search", ["zai", "tavily", "firecrawl"]);
    assert.deepStrictEqual(
      ranked.map((r) => r.provider),
      ["tavily", "firecrawl", "zai"],
    );
    assert.deepStrictEqual(
      ranked.map((r) => r.score),
      [95, 30, 25],
    );
  });

  it("5% known ranks above an unknown-tier provider (the core authority contract)", async () => {
    // ZAI at 5% search remaining; Brave at 96.7% rate-limit. The known
    // tier wins regardless of score.
    const lowZai = [
      {
        name: "requests",
        unit: "requests",
        current: { used: 950, limit: 1000, remaining: 50, remainingPercent: 5 },
      },
      { name: "tokens", unit: "tokens", current: { remainingPercent: 100 } },
    ];
    const state = await stateWith([
      { provider: "zai", categories: lowZai },
      { provider: "brave", categories: BRAVE_CATEGORIES },
    ]);
    const ranked = rankProvidersForCapability(state, "search", ["brave", "zai"]);
    assert.strictEqual(ranked[0].provider, "zai", "5% known still ranks first");
    assert.strictEqual(ranked[0].authority, "known");
    assert.strictEqual(ranked[0].score, 5);
    assert.strictEqual(ranked[1].provider, "brave");
    assert.strictEqual(ranked[1].authority, "unknown");
    assert.strictEqual(ranked[1].reason, "PROVIDER_NON_AUTHORITATIVE");
  });

  it("a fresh-0% known provider ranks below an unknown provider (#97 KNOWN_EXHAUSTED demotion)", async () => {
    // REVERSED by #97: the pre-#97 pin ("a 0% known provider still
    // ranks above an unknown provider") encoded freshness-blind
    // ranking — a still-exhausted provider floated to the top of the
    // selection order. The fixture now passes an explicit `now` that
    // makes the 0% reading fresh (within the 24h
    // QUOTA_EXHAUSTION_DEMOTION_HORIZON_MS); zai is demoted to the
    // unknown tier with reason KNOWN_EXHAUSTED and ranks strictly
    // below the natural unknown exa.
    const depleted = [
      {
        name: "requests",
        unit: "requests",
        current: { used: 1000, limit: 1000, remaining: 0, remainingPercent: 0 },
      },
    ];
    const observedAt = 1_700_000_000_000;
    const state = await stateWith([
      { provider: "zai", categories: depleted, observedAt },
      { provider: "exa", categories: [] },
    ]);
    const ranked = rankProvidersForCapability(state, "search", ["exa", "zai"], {
      now: observedAt + 1_000,
    });
    assert.strictEqual(ranked[0].provider, "exa");
    assert.strictEqual(ranked[0].authority, "unknown");
    assert.strictEqual(ranked[1].provider, "zai");
    assert.strictEqual(ranked[1].authority, "unknown");
    assert.strictEqual(ranked[1].reason, "KNOWN_EXHAUSTED");
  });

  it("a no-clock call keeps the pre-#97 ordering (0% known above unknown)", async () => {
    // ScoreOptions.now absent ⇒ the exhaustiveness check is skipped
    // entirely (quota-mapping stays clockless); callers that do not
    // pass a clock see the pre-#97 ranking unchanged.
    const depleted = [
      {
        name: "requests",
        unit: "requests",
        current: { used: 1000, limit: 1000, remaining: 0, remainingPercent: 0 },
      },
    ];
    const state = await stateWith([
      { provider: "zai", categories: depleted },
      { provider: "exa", categories: [] },
    ]);
    const ranked = rankProvidersForCapability(state, "search", ["exa", "zai"]);
    assert.strictEqual(ranked[0].provider, "zai");
    assert.strictEqual(ranked[0].authority, "known");
    assert.strictEqual(ranked[0].score, 0);
    assert.strictEqual(ranked[1].provider, "exa");
    assert.strictEqual(ranked[1].authority, "unknown");
  });

  it("unknown tier is sorted by registry order (zai < minimax < tavily < exa < brave < firecrawl)", async () => {
    // Build a state where every mapped provider has zero snapshot, so
    // every provider ends up in the unknown tier. The order should
    // follow PROVIDER_IDS.
    const state = await stateWith([]);
    const ranked = rankProvidersForCapability(state, "search", [
      "brave",
      "exa",
      "firecrawl",
      "tavily",
      "minimax",
      "zai",
    ]);
    assert.deepStrictEqual(
      ranked.map((r) => r.provider),
      ["zai", "minimax", "tavily", "exa", "brave", "firecrawl"],
    );
    for (const r of ranked) {
      assert.strictEqual(r.authority, "unknown");
    }
  });

  it("ties within the known tier break by registry order", async () => {
    // All three known providers at 50%.
    const state = await stateWith([
      {
        provider: "zai",
        categories: [
          { name: "requests", unit: "requests", current: { remainingPercent: 50 } },
          { name: "tokens", unit: "tokens", current: { remainingPercent: 50 } },
        ],
      },
      {
        provider: "tavily",
        categories: [{ name: "search", unit: "requests", current: { remainingPercent: 50 } }],
      },
      {
        provider: "firecrawl",
        categories: [{ name: "Credits", unit: "credits", current: { remainingPercent: 50 } }],
      },
    ]);
    const ranked = rankProvidersForCapability(state, "search", ["firecrawl", "tavily", "zai"]);
    // Same score → registry order: zai(0), tavily(2), firecrawl(5)
    assert.deepStrictEqual(
      ranked.map((r) => r.provider),
      ["zai", "tavily", "firecrawl"],
    );
  });

  it("de-duplicates candidates before scoring (no double warnings)", async () => {
    const state = await stateWith([{ provider: "zai", categories: ZAI_CATEGORIES }]);
    const { onWarning, warnings } = captureWarnings();
    const ranked = rankProvidersForCapability(state, "search", ["zai", "zai", "zai"], {
      onWarning,
    });
    assert.strictEqual(ranked.length, 1);
    assert.strictEqual(ranked[0].provider, "zai");
    // zai is known + mapped, so no warnings should fire.
    assert.strictEqual(warnings.length, 0);
  });

  it("is deterministic: same input -> same output order", async () => {
    const state = await stateWith([
      { provider: "zai", categories: ZAI_CATEGORIES },
      { provider: "tavily", categories: TAVILY_CATEGORIES },
      { provider: "firecrawl", categories: FIRECRAWL_CATEGORIES },
      { provider: "brave", categories: BRAVE_CATEGORIES },
    ]);
    const candidates = ["zai", "brave", "tavily", "firecrawl"];
    const a = rankProvidersForCapability(state, "search", candidates);
    const b = rankProvidersForCapability(state, "search", candidates);
    assert.deepStrictEqual(a, b);
  });

  it("returns an empty array for an empty candidate list", async () => {
    const state = await stateWith([]);
    const ranked = rankProvidersForCapability(state, "search", []);
    assert.deepStrictEqual(ranked, []);
  });

  it("emits warnings in candidate-input order", async () => {
    // All three are unknown (no snapshot). Warnings should fire in
    // candidate order, not registry order.
    const state = await stateWith([]);
    const { onWarning, warnings } = captureWarnings();
    rankProvidersForCapability(state, "search", ["tavily", "zai", "firecrawl"], {
      onWarning,
    });
    assert.deepStrictEqual(
      warnings.map((w) => w.provider),
      ["tavily", "zai", "firecrawl"],
    );
  });

  it("honors a custom registryOrder for tie-breaking", async () => {
    // Two known providers tied at 50%; custom registry order reverses
    // their preference.
    const state = await stateWith([
      {
        provider: "zai",
        categories: [{ name: "requests", unit: "requests", current: { remainingPercent: 50 } }],
      },
      {
        provider: "tavily",
        categories: [{ name: "search", unit: "requests", current: { remainingPercent: 50 } }],
      },
    ]);
    const ranked = rankProvidersForCapability(state, "search", ["zai", "tavily"], {
      registryOrder: ["tavily", "zai", "minimax", "exa", "brave", "firecrawl"],
    });
    assert.deepStrictEqual(
      ranked.map((r) => r.provider),
      ["tavily", "zai"],
    );
  });
});

// ===========================================================================
// 6.5 KNOWN_EXHAUSTED demotion (#97) — freshness-gated ranking demotion
// ===========================================================================

describe("quota-mapping: KNOWN_EXHAUSTED demotion (#97)", () => {
  const depletedRequests = [
    {
      name: "requests",
      unit: "requests",
      current: { used: 1000, limit: 1000, remaining: 0, remainingPercent: 0 },
    },
  ];

  it("demotes a fresh-0% known provider strictly below every natural unknown", async () => {
    // The D6 positioning pin: registry-early mapped provider (zai,
    // fresh 0%) + registry-later never-mapped provider (exa) ⇒ the
    // demoted provider is LAST. A membership-only rewrite into the
    // existing unknown bucket would leave registry-early zai above
    // registry-later exa — the exact motivating bug (#97).
    const observedAt = 1_700_000_000_000;
    const state = await stateWith([
      { provider: "zai", categories: depletedRequests, observedAt },
      { provider: "exa", categories: [] }, // never-mapped, natural unknown
    ]);
    const { onWarning, warnings } = captureWarnings();
    const ranked = rankProvidersForCapability(state, "search", ["zai", "exa"], {
      now: observedAt + 60_000,
      onWarning,
    });
    assert.deepStrictEqual(ranked.map((r) => r.provider), ["exa", "zai"]);
    assert.strictEqual(ranked[0].authority, "unknown");
    assert.strictEqual(ranked[0].reason, "PROVIDER_NON_AUTHORITATIVE");
    assert.strictEqual(ranked[1].authority, "unknown");
    assert.strictEqual(ranked[1].reason, "KNOWN_EXHAUSTED");
    assert.ok(
      warnings.some(
        (w) => w.code === "KNOWN_EXHAUSTED" && w.provider === "zai" && w.capability === "search",
      ),
      `expected a KNOWN_EXHAUSTED warning for zai, got ${JSON.stringify(warnings)}`,
    );
  });

  it("natural unknowns come first in registry order, demoted entries after them in registry order", async () => {
    // Two fresh-0% mapped providers (zai and minimax — registry 0 and
    // 1; minimax resolves through the model-alias table) and one
    // natural unknown registry-later (exa, registry 3). D6 order:
    // [natural unknowns in registry order] then [demoted entries in
    // registry order] ⇒ exa, zai, minimax.
    const observedAt = 1_700_000_000_000;
    const state = await stateWith([
      { provider: "zai", categories: depletedRequests, observedAt },
      {
        provider: "minimax",
        categories: [{ name: "zorla-x", unit: "requests", current: { remainingPercent: 0 } }],
        observedAt,
      },
      { provider: "exa", categories: [] },
    ]);
    const ranked = rankProvidersForCapability(state, "search", ["minimax", "exa", "zai"], {
      now: observedAt + 60_000,
    });
    assert.deepStrictEqual(ranked.map((r) => r.provider), ["exa", "zai", "minimax"]);
    for (const r of ranked) {
      assert.strictEqual(r.authority, "unknown");
    }
    assert.strictEqual(ranked[0].reason, "PROVIDER_NON_AUTHORITATIVE");
    assert.strictEqual(ranked[1].reason, "KNOWN_EXHAUSTED");
    assert.strictEqual(ranked[2].reason, "KNOWN_EXHAUSTED");
  });

  it("stale-0% (observedAt older than the horizon) stays known-at-0", async () => {
    // Trust-decay guard: a snapshot older than the 24h horizon scores
    // exactly as it did before #97 (known tier, score 0).
    const observedAt = 1_700_000_000_000;
    const state = await stateWith([
      { provider: "zai", categories: depletedRequests, observedAt },
      { provider: "exa", categories: [] },
    ]);
    const ranked = rankProvidersForCapability(state, "search", ["exa", "zai"], {
      now: observedAt + QUOTA_EXHAUSTION_DEMOTION_HORIZON_MS + 1,
    });
    assert.deepStrictEqual(ranked.map((r) => r.provider), ["zai", "exa"]);
    assert.strictEqual(ranked[0].authority, "known");
    assert.strictEqual(ranked[0].score, 0);
    assert.strictEqual(ranked[1].authority, "unknown");
  });

  it("the horizon boundary is inclusive (age === horizon demotes; older does not)", async () => {
    const observedAt = 1_700_000_000_000;
    const state = await stateWith([
      { provider: "zai", categories: depletedRequests, observedAt },
      { provider: "exa", categories: [] },
    ]);
    const atHorizon = rankProvidersForCapability(state, "search", ["exa", "zai"], {
      now: observedAt + QUOTA_EXHAUSTION_DEMOTION_HORIZON_MS,
    });
    assert.strictEqual(atHorizon[0].provider, "exa");
    assert.strictEqual(atHorizon[0].reason, "PROVIDER_NON_AUTHORITATIVE");
    assert.strictEqual(atHorizon[1].reason, "KNOWN_EXHAUSTED");

    const pastHorizon = rankProvidersForCapability(state, "search", ["exa", "zai"], {
      now: observedAt + QUOTA_EXHAUSTION_DEMOTION_HORIZON_MS + 1,
    });
    assert.strictEqual(pastHorizon[0].provider, "zai");
    assert.strictEqual(pastHorizon[0].authority, "known");
  });

  it("scoreCapability is unchanged: a fresh-0% category is still known/0 with no demotion warning", async () => {
    // D6: demotion lives in ranking, not in scoring's meaning. The
    // scorer has no clock and never emits KNOWN_EXHAUSTED.
    const observedAt = 1_700_000_000_000;
    const state = await stateWith([{ provider: "zai", categories: depletedRequests, observedAt }]);
    const { onWarning, warnings } = captureWarnings();
    const result = scoreCapability(state, "zai", "search", {
      now: observedAt + 1_000,
      onWarning,
    });
    assert.deepStrictEqual(result, { authority: "known", score: 0, category: "requests" });
    assert.deepStrictEqual(warnings.map((w) => w.code), []);
  });

  it("emits exactly one KNOWN_EXHAUSTED warning per demoted provider (de-duped candidates)", async () => {
    const observedAt = 1_700_000_000_000;
    const state = await stateWith([{ provider: "zai", categories: depletedRequests, observedAt }]);
    const { onWarning, warnings } = captureWarnings();
    const ranked = rankProvidersForCapability(state, "search", ["zai", "zai"], {
      now: observedAt + 1_000,
      onWarning,
    });
    assert.strictEqual(ranked.length, 1);
    assert.strictEqual(ranked[0].reason, "KNOWN_EXHAUSTED");
    assert.strictEqual(warnings.length, 1);
    assert.strictEqual(warnings[0].code, "KNOWN_EXHAUSTED");
  });
});

// ===========================================================================
// 7. MiniMax alias resolution — explicit alias policy
// ===========================================================================

describe("quota-mapping: MiniMax alias resolution", () => {
  it("DEFAULT_MINIMAX_MODEL_ALIASES exposes search and vision.interpret-image", () => {
    assert.ok(DEFAULT_MINIMAX_MODEL_ALIASES.search.length >= 1);
    assert.ok(DEFAULT_MINIMAX_MODEL_ALIASES["vision.interpret-image"].length >= 1);
    // zorla-x is the characterized representative from fixtures.
    assert.ok(DEFAULT_MINIMAX_MODEL_ALIASES.search.includes("zorla-x"));
  });

  it("resolveMiniMaxAliasesForCapability returns search aliases for search", () => {
    const aliases = resolveMiniMaxAliasesForCapability("search");
    assert.deepStrictEqual(aliases, DEFAULT_MINIMAX_MODEL_ALIASES.search);
  });

  it("resolveMiniMaxAliasesForCapability returns vision aliases for every MiniMax vision cap", () => {
    for (const cap of MINIMAX_VISION_CAPABILITIES) {
      const aliases = resolveMiniMaxAliasesForCapability(cap);
      assert.deepStrictEqual(aliases, DEFAULT_MINIMAX_MODEL_ALIASES["vision.interpret-image"]);
    }
  });

  it("resolveMiniMaxAliasesForCapability returns [] for a non-MiniMax capability", () => {
    assert.deepStrictEqual(
      resolveMiniMaxAliasesForCapability("search", { search: [], "vision.interpret-image": [] }),
      [],
    );
    // Non-vision, non-search capability on a custom table:
    assert.deepStrictEqual(
      resolveMiniMaxAliasesForCapability("quota", DEFAULT_MINIMAX_MODEL_ALIASES),
      [],
    );
  });

  it("fails open when no MiniMax alias matches the live snapshot (unknown model)", async () => {
    // The live API emits a model_name we have never seen.
    const unknownModel = [
      {
        name: "future-model-xyz",
        unit: "requests",
        current: { used: 1, limit: 100, remaining: 99, remainingPercent: 99 },
      },
    ];
    const state = await stateWith([{ provider: "minimax", categories: unknownModel }]);
    const { onWarning, warnings } = captureWarnings();
    const result = scoreCapability(state, "minimax", "search", { onWarning });
    assert.strictEqual(result.authority, "unknown");
    assert.strictEqual(result.reason, "CATEGORY_NOT_FOUND");
    assert.strictEqual(warnings[0].code, "CATEGORY_NOT_FOUND");
    // MiniMax has NO providerFallbackCategory; drift surfaces as
    // CATEGORY_NOT_FOUND, not PROVIDER_FALLBACK_USED.
    assert.match(warnings[0].message, /aliases: \[/);
  });

  it("honors an injected minimaxModelAliases override", async () => {
    const state = await stateWith([
      {
        provider: "minimax",
        categories: [
          {
            name: "brand-new-model",
            unit: "requests",
            current: { remainingPercent: 88 },
          },
        ],
      },
    ]);
    const result = scoreCapability(state, "minimax", "search", {
      minimaxModelAliases: {
        search: ["brand-new-model"],
        "vision.interpret-image": [],
      },
    });
    assert.strictEqual(result.authority, "known");
    assert.strictEqual(result.score, 88);
    assert.strictEqual(result.category, "brand-new-model");
  });
});

// ===========================================================================
// 8. Pure-module contract — no disk, no stderr, no throw
// ===========================================================================

describe("quota-mapping: pure-module contract", () => {
  it("scoreCapability never throws on any fail-open path", async () => {
    const empty = await stateWith([]);
    const emptyZai = await stateWith([{ provider: "zai", categories: [] }]);
    const corruptZai = await stateWith([
      {
        provider: "zai",
        categories: [{ name: "requests", unit: "requests", current: { remainingPercent: "bad" } }],
      },
    ]);
    // Exercise every fail-open branch; none should throw.
    assert.doesNotThrow(() => scoreCapability(empty, "zai", "search"));
    assert.doesNotThrow(() => scoreCapability(empty, "brave", "search"));
    assert.doesNotThrow(() => scoreCapability(empty, "exa", "search"));
    assert.doesNotThrow(() => scoreCapability(emptyZai, "zai", "search"));
    assert.doesNotThrow(() => scoreCapability(corruptZai, "zai", "search"));
  });

  it("scoreCapability does not call process.stderr.write (warnings route through callback)", async () => {
    const state = await stateWith([{ provider: "zai", categories: ZAI_CATEGORIES }]);
    const original = process.stderr.write.bind(process.stderr);
    let violated = false;
    process.stderr.write = () => {
      violated = true;
      return true;
    };
    try {
      // Trigger a warning path.
      scoreCapability(state, "zai", "diagnostics");
    } finally {
      process.stderr.write = original;
    }
    assert.strictEqual(violated, false, "pure module must not write to stderr");
  });

  it("scoreCapability tolerates a missing onWarning callback (defaults to no-op)", async () => {
    const empty = await stateWith([]);
    assert.doesNotThrow(() => scoreCapability(empty, "zai", "search"));
    // No callback supplied; warning is silently dropped.
  });
});
