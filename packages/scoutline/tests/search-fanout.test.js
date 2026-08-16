/**
 * Multi-Provider Search Fan-Out tests — Ticket 1.
 *
 * Scope of THIS ticket: pure helpers only.
 *   - `canonicalUrl` (DESIGN D4, ADR-0004 §5): identity-only normalization;
 *     never throws; malformed passes through verbatim.
 *   - `parseProviderIds` (additive sibling of `parseProviderId`): comma-
 *     split, trim, drop empties, validate against PROVIDER_IDS, dedupe
 *     preserving order; `"all"` sentinel; `null` on any unknown id.
 *
 * Tickets 2-5 append their own sections to this file. Each section is
 * kept self-contained so a single test file drives the whole feature.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { canonicalUrl } from "../dist/lib/url.js";
import { parseProviderIds } from "../dist/providers/selection.js";
import {
  mergeResults,
  search,
  resolveFanoutPlan,
  executeFanoutPlan,
  SEARCH_HELP,
} from "../dist/commands/search.js";
import { main } from "../dist/index.js";
import { ValidationError } from "../dist/lib/errors.js";

// ---------------------------------------------------------------------------
// canonicalUrl — identity-only normalization (DESIGN D4, ADR-0004 §5)
// ---------------------------------------------------------------------------

describe("canonicalUrl: scheme + host lowercasing", () => {
  it("lowercases the scheme", () => {
    assert.strictEqual(canonicalUrl("HTTPS://Example.com/path"), "https://example.com/path");
  });

  it("lowercases the host only — preserves mixed-case path", () => {
    assert.strictEqual(canonicalUrl("https://EXAMPLE.COM/Search/AI-News"), "https://example.com/Search/AI-News");
  });

  it("preserves port when non-default", () => {
    assert.strictEqual(canonicalUrl("https://example.com:8443/a"), "https://example.com:8443/a");
  });
});

describe("canonicalUrl: default-port stripping", () => {
  it("strips :443 from https URLs", () => {
    assert.strictEqual(canonicalUrl("https://example.com:443/a"), "https://example.com/a");
  });

  it("strips :80 from http URLs", () => {
    assert.strictEqual(canonicalUrl("http://example.com:80/a"), "http://example.com/a");
  });

  it("keeps :443 on non-https URLs (it is meaningful there)", () => {
    assert.strictEqual(canonicalUrl("http://example.com:443/a"), "http://example.com:443/a");
  });
});

describe("canonicalUrl: fragment stripping", () => {
  it("drops the URL fragment entirely", () => {
    assert.strictEqual(canonicalUrl("https://example.com/a#section-2"), "https://example.com/a");
  });

  it("drops a fragment even when it is the only thing after the path", () => {
    // WHATWG fills the implicit root "/" for `https://example.com#x`;
    // DESIGN D4 preserves the root "/" so the canonical form keeps the
    // trailing slash. The fragment is the only thing that gets dropped.
    assert.strictEqual(canonicalUrl("https://example.com#x"), "https://example.com/");
  });
});

describe("canonicalUrl: trailing-slash trimming", () => {
  it("trims a trailing slash from the path", () => {
    assert.strictEqual(canonicalUrl("https://example.com/a/"), "https://example.com/a");
  });

  it("does not trim the slash that follows the host with an empty path", () => {
    // "/" is the canonical path for "example.com/"; trimming it would
    // collapse the URL to the host, which is a different origin form.
    assert.strictEqual(canonicalUrl("https://example.com/"), "https://example.com/");
  });
});

describe("canonicalUrl: tracking-parameter removal", () => {
  it("removes utm_source but preserves remaining query order", () => {
    assert.strictEqual(
      canonicalUrl("https://example.com/a?b=1&utm_source=x&c=2"),
      "https://example.com/a?b=1&c=2",
    );
  });

  it("removes every utm_* variant and fbclid, preserving order of the survivors", () => {
    assert.strictEqual(
      canonicalUrl(
        "https://example.com/a?utm_source=x&utm_medium=y&utm_campaign=z&fbclid=abc&keep=yes",
      ),
      "https://example.com/a?keep=yes",
    );
  });

  it("does NOT remove parameters that merely contain utm as a substring (e.g. autumn)", () => {
    assert.strictEqual(
      canonicalUrl("https://example.com/a?autumn=leaf&keep=yes"),
      "https://example.com/a?autumn=leaf&keep=yes",
    );
  });

  it("treats utm_* case-insensitively", () => {
    assert.strictEqual(
      canonicalUrl("https://example.com/a?UTM_Source=x&Keep=yes"),
      "https://example.com/a?Keep=yes",
    );
  });
});

describe("canonicalUrl: relative + malformed pass-through (identity must never throw)", () => {
  it("returns an empty string unchanged", () => {
    assert.strictEqual(canonicalUrl(""), "");
  });

  it("passes through a relative URL", () => {
    assert.strictEqual(canonicalUrl("/foo/bar?q=1"), "/foo/bar?q=1");
  });

  it("passes through plain garbage without throwing", () => {
    assert.strictEqual(canonicalUrl("not a url at all"), "not a url at all");
  });

  it("does not throw on non-strings cast to string", () => {
    // Even if callers accidentally pass a number, identity must never throw.
    assert.strictEqual(canonicalUrl(String(123)), "123");
  });
});

describe("canonicalUrl: idempotence", () => {
  it("canonicalUrl(x) === canonicalUrl(canonicalUrl(x)) for every URL in the table", () => {
    const urls = [
      "https://Example.com/A/",
      "HTTPS://example.com:443/a?utm_source=x&b=1#frag",
      "http://example.com:80/",
      "https://example.com/A/B/C?c=3&a=1",
      "https://EXAMPLE.com/a?Fbclid=x&keep=yes",
    ];
    for (const u of urls) {
      const once = canonicalUrl(u);
      const twice = canonicalUrl(once);
      assert.strictEqual(twice, once, `idempotence broken for ${u}`);
    }
  });
});

// ---------------------------------------------------------------------------
// parseProviderIds — comma-split + validate + dedupe (DESIGN D1)
// ---------------------------------------------------------------------------

describe("parseProviderIds: happy path", () => {
  it("parses a two-id comma-separated list in input order", () => {
    assert.deepStrictEqual(parseProviderIds("tavily,exa"), ["tavily", "exa"]);
  });

  it("trims whitespace around each id", () => {
    assert.deepStrictEqual(parseProviderIds(" tavily , exa "), ["tavily", "exa"]);
  });

  it("preserves input order across duplicates (dedupe keeps first occurrence)", () => {
    assert.deepStrictEqual(parseProviderIds("tavily,tavily,exa"), ["tavily", "exa"]);
  });

  it("drops empty fragments between commas", () => {
    assert.deepStrictEqual(parseProviderIds("tavily,,exa"), ["tavily", "exa"]);
  });

  it("drops leading/trailing empty fragments", () => {
    assert.deepStrictEqual(parseProviderIds(",tavily,exa,"), ["tavily", "exa"]);
  });
});

describe('parseProviderIds: "all" sentinel', () => {
  it("returns the literal sentinel \"all\"", () => {
    assert.strictEqual(parseProviderIds("all"), "all");
  });

  it("trims whitespace around \"all\"", () => {
    assert.strictEqual(parseProviderIds(" all "), "all");
  });

  it("is case-insensitive", () => {
    assert.strictEqual(parseProviderIds("ALL"), "all");
    assert.strictEqual(parseProviderIds("All"), "all");
  });
});

describe("parseProviderIds: unknown id → null (whole parse fails)", () => {
  it("returns null for a single unknown id", () => {
    assert.strictEqual(parseProviderIds("tavlly"), null);
  });

  it("returns null when ANY id in a multi-id list is unknown", () => {
    assert.strictEqual(parseProviderIds("tavily,openai"), null);
    assert.strictEqual(parseProviderIds("openai,tavily"), null);
  });

  it("returns null for empty input", () => {
    assert.strictEqual(parseProviderIds(""), null);
  });

  it("returns null for whitespace-only input", () => {
    assert.strictEqual(parseProviderIds("   "), null);
  });

  it("returns null for a list of only commas", () => {
    assert.strictEqual(parseProviderIds(",,,"), null);
  });
});

describe("parseProviderIds: case normalisation", () => {
  it("lowercases valid ids before emitting them", () => {
    assert.deepStrictEqual(parseProviderIds("TAVILY,Exa"), ["tavily", "exa"]);
  });
});

// ---------------------------------------------------------------------------
// Ticket 2 — Merge generalization + provenance (DESIGN D3)
//
// `mergeResults` generalizes from (sub-query × results) to
// (arm × sub-query) × results grids keyed by canonicalUrl. The single-
// provider `--merge` path and the fan-out path share this one exported
// function. On the single path the output stays byte-identical to the
// pre-fan-out merge (no `mergedFrom` field, no count slice).
// ---------------------------------------------------------------------------

// --- helpers (self-contained for this section) --------------------------

/** Shorthand for a single formatted result. */
function src(title, url, summary, extra = {}) {
  return { rank: 1, title, url, summary, ...extra };
}

/** Build a fake SearchCapability returning scripted results per query. */
function makeFakeCapability(resultsByQuery) {
  const invokes = [];
  const capability = {
    validate() {},
    cacheIdentity(request) {
      return {
        provider: "zai",
        capability: "search",
        credentialFingerprint: "fake-fingerprint",
        request,
        legacyCandidates: [],
      };
    },
    async invoke(request) {
      invokes.push(request);
      return resultsByQuery[request.query] ?? [];
    },
  };
  return { capability, invokes };
}

function makeExecDeps(capability) {
  const store = new Map();
  return {
    capability,
    cache: {
      async get(key) {
        return store.has(key) ? store.get(key) : null;
      },
      async set(key, value) {
        store.set(key, value);
      },
    },
    sleep: async () => {},
    random: () => 0.5,
  };
}

function makeContext() {
  const notices = [];
  return { context: { stdinIsTTY: false, readStdin: async () => "", notice: (m) => notices.push(m) }, notices };
}

async function runSearch(query, options, resultsByQuery) {
  const fake = makeFakeCapability(resultsByQuery);
  const { context, notices } = makeContext();
  const result = await search(query, options, makeExecDeps(fake.capability), context);
  return { result, fake, notices };
}

// --- cross-arm near-duplicate collapse -----------------------------------

describe("mergeResults: cross-arm near-duplicates collapse by canonical identity", () => {
  it("collapses /a vs /a/ vs ?utm_source=x into one result keyed by canonicalUrl", () => {
    const grid = [
      {
        provider: "tavily",
        results: [
          [
            { rank: 1, title: "Tavily /a", url: "https://e/a/", summary: "tavily a" },
            { rank: 2, title: "Tavily /b", url: "https://e/b", summary: "tavily b" },
          ],
        ],
      },
      {
        provider: "exa",
        results: [
          [
            { rank: 1, title: "Exa /a", url: "https://e/a?utm_source=x", summary: "exa a" },
            { rank: 2, title: "Exa only-b", url: "https://e/only-b", summary: "exa only-b" },
          ],
        ],
      },
    ];
    const merged = mergeResults(grid, { emitMergedFrom: true });
    assert.deepStrictEqual(merged, [
      {
        rank: 1,
        title: "Tavily /a",
        url: "https://e/a/",
        summary: "tavily a",
        occurrences: 2,
        mergedFrom: ["tavily", "exa"],
      },
      {
        rank: 2,
        title: "Tavily /b",
        url: "https://e/b",
        summary: "tavily b",
        occurrences: 1,
        mergedFrom: ["tavily"],
      },
      {
        rank: 3,
        title: "Exa only-b",
        url: "https://e/only-b",
        summary: "exa only-b",
        occurrences: 1,
        mergedFrom: ["exa"],
      },
    ]);
  });

  it("emits the FIRST writer's original url string (canonical key never leaks)", () => {
    const grid = [
      { provider: "tavily", results: [[{ rank: 1, title: "T", url: "https://e/page/", summary: "t" }]] },
      { provider: "exa", results: [[{ rank: 1, title: "E", url: "https://e/page?utm_campaign=c", summary: "e" }]] },
    ];
    const merged = mergeResults(grid, { emitMergedFrom: true });
    assert.strictEqual(merged.length, 1);
    assert.strictEqual(merged[0].url, "https://e/page/");
  });
});

// --- occurrence ranking across the (arm × sub-query) grid ----------------

describe("mergeResults: occurrence ranking across the arms × sub-queries grid", () => {
  it("counts occurrences across every arm and sub-query, then ranks (occ desc, bestPos asc)", () => {
    const grid = [
      {
        provider: "tavily",
        results: [
          [{ rank: 1, title: "Tav A", url: "https://e/shared", summary: "ta" }],
          [{ rank: 1, title: "Tav C", url: "https://e/shared", summary: "tc" }],
          [{ rank: 2, title: "Tav B", url: "https://e/only-a", summary: "tb" }],
        ],
      },
      {
        provider: "exa",
        results: [[{ rank: 1, title: "Exa D", url: "https://e/shared", summary: "td" }]],
      },
    ];
    const merged = mergeResults(grid, { emitMergedFrom: true });
    assert.strictEqual(merged[0].url, "https://e/shared");
    assert.strictEqual(merged[0].occurrences, 3);
    assert.strictEqual(merged[0].bestPos === undefined, true); // internal field never leaks
    assert.strictEqual(merged[1].url, "https://e/only-a");
    assert.strictEqual(merged[1].occurrences, 1);
  });

  it("best position tie is broken by arm order (earlier arm wins)", () => {
    const grid = [
      { provider: "tavily", results: [[{ rank: 1, title: "T1", url: "https://e/a", summary: "t" }]] },
      { provider: "exa", results: [[{ rank: 1, title: "E1", url: "https://e/b", summary: "e" }]] },
    ];
    const merged = mergeResults(grid, { emitMergedFrom: true });
    assert.strictEqual(merged[0].url, "https://e/a");
    assert.strictEqual(merged[1].url, "https://e/b");
  });
});

// --- arm-order first-writer-wins -----------------------------------------

describe("mergeResults: earlier arm's metadata wins on collision", () => {
  it("keeps the first arm's title/summary/url for a shared canonical URL", () => {
    const grid = [
      { provider: "tavily", results: [[{ rank: 1, title: "First", url: "https://e/page", summary: "first summary" }]] },
      { provider: "exa", results: [[{ rank: 1, title: "Second", url: "https://e/page", summary: "second summary" }]] },
    ];
    const merged = mergeResults(grid, { emitMergedFrom: true });
    assert.strictEqual(merged.length, 1);
    assert.strictEqual(merged[0].title, "First");
    assert.strictEqual(merged[0].summary, "first summary");
    assert.strictEqual(merged[0].url, "https://e/page");
  });
});

// --- mergedFrom provenance ----------------------------------------------

describe("mergeResults: mergedFrom provenance (unique, first-encounter order)", () => {
  it("accumulates distinct providers in first-encounter order across a three-arm collision", () => {
    const grid = [
      { provider: "tavily", results: [[{ rank: 1, title: "T", url: "https://e/collide", summary: "t" }]] },
      { provider: "exa", results: [[{ rank: 1, title: "E", url: "https://e/collide", summary: "e" }]] },
      { provider: "brave", results: [[{ rank: 1, title: "B", url: "https://e/collide", summary: "b" }]] },
    ];
    const merged = mergeResults(grid, { emitMergedFrom: true });
    assert.strictEqual(merged.length, 1);
    assert.deepStrictEqual(merged[0].mergedFrom, ["tavily", "exa", "brave"]);
    assert.strictEqual(merged[0].occurrences, 3);
  });

  it("does not duplicate a provider when its sub-queries hit the same URL twice", () => {
    const grid = [
      {
        provider: "tavily",
        results: [
          [{ rank: 1, title: "A", url: "https://e/x", summary: "a" }],
          [{ rank: 1, title: "B", url: "https://e/x", summary: "b" }],
        ],
      },
      { provider: "exa", results: [[{ rank: 1, title: "C", url: "https://e/x", summary: "c" }]] },
    ];
    const merged = mergeResults(grid, { emitMergedFrom: true });
    assert.strictEqual(merged[0].occurrences, 3);
    assert.deepStrictEqual(merged[0].mergedFrom, ["tavily", "exa"]);
  });

  it("omits mergedFrom entirely when emitMergedFrom is false (single-provider path)", () => {
    const grid = [
      { provider: "tavily", results: [[{ rank: 1, title: "T", url: "https://e/page", summary: "t" }]] },
      { provider: "exa", results: [[{ rank: 1, title: "E", url: "https://e/page", summary: "e" }]] },
    ];
    const merged = mergeResults(grid);
    assert.strictEqual(merged.length, 1);
    assert.ok(!Object.hasOwn(merged[0], "mergedFrom"), "no mergedFrom key on the single path");
  });
});

// --- post-merge --count slice --------------------------------------------

describe("mergeResults: post-merge --count slice", () => {
  const grid = [
    {
      provider: "tavily",
      results: [
        [
          { rank: 1, title: "A", url: "https://e/a", summary: "s" },
          { rank: 2, title: "B", url: "https://e/b", summary: "s" },
          { rank: 3, title: "C", url: "https://e/c", summary: "s" },
        ],
      ],
    },
  ];

  it("slices the merged list to count after ranking (not before)", () => {
    const merged = mergeResults(grid, { emitMergedFrom: true, count: 2 });
    assert.deepStrictEqual(
      merged.map((r) => r.url),
      ["https://e/a", "https://e/b"],
    );
    assert.deepStrictEqual(
      merged.map((r) => r.rank),
      [1, 2],
    );
  });

  it("count 0 returns no results", () => {
    const merged = mergeResults(grid, { emitMergedFrom: true, count: 0 });
    assert.deepStrictEqual(merged, []);
  });

  it("an absent count returns everything (slice is a no-op)", () => {
    const merged = mergeResults(grid, { emitMergedFrom: true });
    assert.strictEqual(merged.length, 3);
  });
});

// --- single-provider --merge golden (byte-identical to pre-fan-out) ------

describe("single-provider --merge path: golden byte-identical output", () => {
  it("produces today's exact merged data (no mergedFrom, no count slice)", async () => {
    const { result, notices } = await runSearch(
      "a|b",
      { merge: true },
      {
        a: [src("A1", "https://e/shared", "shared A"), src("A2", "https://e/only-a", "only A")],
        b: [src("B1", "https://e/shared", "shared B"), src("B2", "https://e/only-b", "only B")],
      },
    );
    assert.deepStrictEqual(result.data, [
      { rank: 1, title: "A1", url: "https://e/shared", summary: "shared A", occurrences: 2 },
      { rank: 2, title: "A2", url: "https://e/only-a", summary: "only A", occurrences: 1 },
      { rank: 3, title: "B2", url: "https://e/only-b", summary: "only B", occurrences: 1 },
    ]);
    // Byte-level pin: key order and value serialization unchanged.
    assert.strictEqual(
      JSON.stringify(result.data),
      '[{"rank":1,"title":"A1","url":"https://e/shared","summary":"shared A","occurrences":2},'
        + '{"rank":2,"title":"A2","url":"https://e/only-a","summary":"only A","occurrences":1},'
        + '{"rank":3,"title":"B2","url":"https://e/only-b","summary":"only B","occurrences":1}]',
    );
    for (const r of result.data) {
      assert.ok(!Object.hasOwn(r, "mergedFrom"), "mergedFrom omitted on the single path");
    }
    assert.strictEqual(notices.length, 1);
    assert.match(notices[0], /merged 2 queries/);
  });

  it("--merge with a canonical near-duplicate across sub-queries collapses (new D3 key)", async () => {
    // Today's raw-string dedupe would keep these apart; canonical identity
    // collapses them. This is the one intended behavioral delta on the
    // single path: URL identity now uses canonicalUrl.
    const { result } = await runSearch(
      "a|b",
      { merge: true },
      {
        a: [src("A", "https://e/a/", "slash")],
        b: [src("B", "https://e/a?utm_source=x", "tracked")],
      },
    );
    assert.strictEqual(result.data.length, 1);
    assert.strictEqual(result.data[0].url, "https://e/a/");
    assert.strictEqual(result.data[0].occurrences, 2);
    assert.strictEqual(result.data[0].title, "A");
  });
});

// =============================================================================
// Ticket 3 — Activation resolver + fan-out executor (DESIGN D1, D2, D5, D6)
//
// `resolveFanoutPlan` is the pure resolver that decides fan-out vs single
// and produces the ordered arm list. The fan-out executor runs every arm
// in parallel with one client per arm, settles per-arm failures, drops
// arm-specific option failures, and merges through `mergeResults` with
// `emitMergedFrom: true`. The single-path is verified byte-identical
// (single-pin golden) at the end of the section.
// =============================================================================

// --- resolveFanoutPlan: explicit --provider tier (D1) -----------------------

describe("resolveFanoutPlan: explicit --provider tier (D1.1)", () => {
  const env = { Z_AI_API_KEY: "k", MINIMAX_API_KEY: "k", TAVILY_API_KEY: "k" };
  const descriptors = [
    {
      id: "zai",
      isConfigured: () => true,
      capabilities: () => new Set(["search"]),
      create: () => ({ id: "zai", search: {} }),
    },
    {
      id: "minimax",
      isConfigured: () => true,
      capabilities: () => new Set(["search"]),
      create: () => ({ id: "minimax", search: {} }),
    },
    {
      id: "tavily",
      isConfigured: () => true,
      capabilities: () => new Set(["search"]),
      create: () => ({ id: "tavily", search: {} }),
    },
  ];

  it("returns fanout with parsed ids when explicit raw contains a comma", () => {
    const plan = resolveFanoutPlan({
      explicitProviderRaw: "tavily,minimax",
      env,
      configFanout: false,
      descriptors,
    });
    assert.deepStrictEqual(plan, { mode: "fanout", arms: ["tavily", "minimax"] });
  });

  it('returns fanout with arms expanded when explicit raw is "all"', () => {
    const plan = resolveFanoutPlan({
      explicitProviderRaw: "all",
      env,
      configFanout: false,
      descriptors,
    });
    // Tier 1b: "all" is fanout; the resolver expands against
    // configured∩advertising in registry order (never the sentinel).
    assert.strictEqual(plan.mode, "fanout");
    assert.deepStrictEqual(plan.arms, ["zai", "minimax", "tavily"]);
  });

  it("returns single when explicit raw is a single id", () => {
    const plan = resolveFanoutPlan({
      explicitProviderRaw: "tavily",
      env,
      configFanout: false,
      descriptors,
    });
    assert.deepStrictEqual(plan, { mode: "single", arms: ["tavily"] });
  });

  it("returns single+suppress when explicit single id + fanout=true", () => {
    const plan = resolveFanoutPlan({
      explicitProviderRaw: "tavily",
      env,
      configFanout: true,
      descriptors,
    });
    assert.strictEqual(plan.mode, "single");
    assert.deepStrictEqual(plan.arms, ["tavily"]);
    assert.ok(
      typeof plan.suppress === "string" && /explicit pin.*fan-out ignored/i.test(plan.suppress),
      `expected suppress notice, got: ${plan.suppress}`,
    );
  });

  it("throws VALIDATION_ERROR for an invalid explicit raw (fanout off; review fix)", () => {
    // A non-empty explicit value that names no valid id, comma list,
    // or "all" sentinel is a usage error — parseProviderIds returns
    // null and the resolver surfaces the typed VALIDATION_ERROR (the
    // same wording parseProviderId produces) instead of falling
    // through to the env/config/default tiers.
    assert.throws(
      () =>
        resolveFanoutPlan({
          explicitProviderRaw: "tavlly",
          env,
          configFanout: false,
          descriptors,
        }),
      (error) => {
        assert.strictEqual(error.name, "ValidationError");
        assert.match(error.message, /Unknown provider "tavlly"/);
        return true;
      },
    );
  });

  it("throws VALIDATION_ERROR for an invalid explicit raw even when fanout=true (review fix)", () => {
    // The P1 case: with the config switch on, a typo'd pin used to
    // fall through to tier 3 and silently converted into a fan-out
    // activation. The parse failure must surface before the config
    // fan-out tier is ever evaluated.
    assert.throws(
      () =>
        resolveFanoutPlan({
          explicitProviderRaw: "tavlly",
          env,
          configFanout: true,
          descriptors,
        }),
      (error) => {
        assert.strictEqual(error.name, "ValidationError");
        assert.match(error.message, /Unknown provider "tavlly"/);
        return true;
      },
    );
  });

  it("throws VALIDATION_ERROR when a comma list contains an unknown id (review fix)", () => {
    assert.throws(
      () =>
        resolveFanoutPlan({
          explicitProviderRaw: "tavily,openai",
          env,
          configFanout: true,
          descriptors,
        }),
      (error) => {
        assert.strictEqual(error.name, "ValidationError");
        return true;
      },
    );
  });

  it("treats a whitespace-only explicit raw as absent (tier evaluation continues)", () => {
    const plan = resolveFanoutPlan({
      explicitProviderRaw: "   ",
      env,
      configFanout: true,
      descriptors,
    });
    // Absent explicit → tier 3 fan-out over configured∩advertising.
    assert.strictEqual(plan.mode, "fanout");
    assert.deepStrictEqual(plan.arms, ["zai", "minimax", "tavily"]);
  });
});

describe("resolveFanoutPlan: SCOUTLINE_PROVIDER env tier (D1.2)", () => {
  it("returns single when SCOUTLINE_PROVIDER is set and no explicit raw", () => {
    const env = { SCOUTLINE_PROVIDER: "tavily" };
    const descriptors = [];
    const plan = resolveFanoutPlan({
      explicitProviderRaw: undefined,
      env,
      configFanout: false,
      descriptors,
    });
    assert.strictEqual(plan.mode, "single");
    assert.deepStrictEqual(plan.arms, ["tavily"]);
  });

  it("returns single+suppress when SCOUTLINE_PROVIDER is set + fanout=true", () => {
    const env = { SCOUTLINE_PROVIDER: "tavily" };
    const descriptors = [];
    const plan = resolveFanoutPlan({
      explicitProviderRaw: undefined,
      env,
      configFanout: true,
      descriptors,
    });
    assert.strictEqual(plan.mode, "single");
    assert.ok(
      typeof plan.suppress === "string" && /SCOUTLINE_PROVIDER/.test(plan.suppress),
      `expected SCOUTLINE_PROVIDER suppress notice, got: ${plan.suppress}`,
    );
  });

  it("explicit raw (single) wins over SCOUTLINE_PROVIDER (Tier 1 over Tier 2)", () => {
    const env = { SCOUTLINE_PROVIDER: "minimax" };
    const descriptors = [];
    const plan = resolveFanoutPlan({
      explicitProviderRaw: "tavily",
      env,
      configFanout: false,
      descriptors,
    });
    assert.deepStrictEqual(plan, { mode: "single", arms: ["tavily"] });
  });
});

describe("resolveFanoutPlan: fanout=true with no pin (D1.3)", () => {
  const env = { Z_AI_API_KEY: "k", MINIMAX_API_KEY: "k", TAVILY_API_KEY: "k", EXA_API_KEY: "k" };
  const fakeDesc = (id, configured = true) => ({
    id,
    isConfigured: () => configured,
    capabilities: () => new Set(["search"]),
    create: () => ({ id, search: {} }),
  });
  const allDescriptors = [
    fakeDesc("zai"),
    fakeDesc("minimax"),
    fakeDesc("tavily"),
    fakeDesc("exa"),
  ];

  it("expands 'all' against configured∩advertising in registry order", () => {
    const plan = resolveFanoutPlan({
      explicitProviderRaw: "all",
      env,
      configFanout: false,
      descriptors: allDescriptors,
    });
    assert.strictEqual(plan.mode, "fanout");
    assert.deepStrictEqual(plan.arms, ["zai", "minimax", "tavily", "exa"]);
  });

  it("drops unconfigured providers when 'all' is expanded", () => {
    const plan = resolveFanoutPlan({
      explicitProviderRaw: "all",
      env,
      configFanout: false,
      descriptors: [fakeDesc("zai", false), fakeDesc("tavily", true)],
    });
    assert.strictEqual(plan.mode, "fanout");
    assert.deepStrictEqual(plan.arms, ["tavily"]);
  });

  it("uses routing.search order when set (D1.3.b)", () => {
    const plan = resolveFanoutPlan({
      explicitProviderRaw: undefined,
      env,
      configFanout: true,
      routing: { search: ["tavily", "zai"] },
      descriptors: allDescriptors,
    });
    assert.strictEqual(plan.mode, "fanout");
    assert.deepStrictEqual(plan.arms, ["tavily", "zai"]);
  });

  it("filters routing.search against configured∩advertising + dedupes", () => {
    const plan = resolveFanoutPlan({
      explicitProviderRaw: undefined,
      env,
      configFanout: true,
      routing: { search: ["tavily", "exa", "tavily", "openai"] },
      descriptors: allDescriptors,
    });
    assert.strictEqual(plan.mode, "fanout");
    // openai is unknown (not in PROVIDER_IDS); tavily listed twice; exa
    // is configured. Dedup by first-encounter, then filter, then order
    // preserved.
    assert.deepStrictEqual(plan.arms, ["tavily", "exa"]);
  });

  it("falls through to configured∩advertising in registry order when routing.search is absent", () => {
    const plan = resolveFanoutPlan({
      explicitProviderRaw: undefined,
      env,
      configFanout: true,
      descriptors: allDescriptors,
    });
    assert.strictEqual(plan.mode, "fanout");
    assert.deepStrictEqual(plan.arms, ["zai", "minimax", "tavily", "exa"]);
  });
});

describe("resolveFanoutPlan: no pin, no fanout (D1.4, default single path)", () => {
  it("returns single with the default provider picked", () => {
    const env = { Z_AI_API_KEY: "k" };
    const descriptors = [
      {
        id: "zai",
        isConfigured: () => true,
        capabilities: () => new Set(["search"]),
        create: () => ({ id: "zai", search: {} }),
      },
    ];
    const plan = resolveFanoutPlan({
      explicitProviderRaw: undefined,
      env,
      configFanout: false,
      descriptors,
    });
    assert.strictEqual(plan.mode, "single");
    assert.deepStrictEqual(plan.arms, ["zai"]);
  });
});

// --- executeFanoutPlan: partial failure (D5/D6) -----------------------------

function makeExecDepsForFanout() {
  const store = new Map();
  return {
    cache: {
      async get(key) {
        return store.has(key) ? store.get(key) : null;
      },
      async set(key, value) {
        store.set(key, value);
      },
    },
    sleep: async () => {},
    random: () => 0.5,
  };
}

function makeFanoutContext() {
  const notices = [];
  return { context: { stdinIsTTY: false, readStdin: async () => "", notice: (m) => notices.push(m) }, notices };
}

function makeFanoutDescriptor(id, resultsByQuery, { fail } = {}) {
  const invokes = [];
  const descriptor = {
    id,
    isConfigured: () => true,
    capabilities: () => new Set(["search"]),
    create: () => ({
      id,
      search: {
        validate() {},
        cacheIdentity(request) {
          return {
            provider: id,
            capability: "search",
            credentialFingerprint: "fp-" + id,
            request,
            legacyCandidates: [],
          };
        },
        async invoke(request) {
          invokes.push(request);
          if (fail) {
            throw fail;
          }
          return resultsByQuery[request.query] ?? [];
        },
      },
    }),
  };
  return { descriptor, invokes };
}

describe("executeFanoutPlan: partial failure exit 0 with drop notices (D5/D6)", () => {
  it("exits 0 when ≥1 arm ok; failed arms produce notices (not errors)", async () => {
    const tav = makeFanoutDescriptor("tavily", {
      q: [{ title: "Tav", url: "https://e/tav", summary: "tav" }],
    });
    const exa = makeFanoutDescriptor("exa", {}, { fail: new Error("exa transport gone") });
    const { context, notices } = makeFanoutContext();
    const result = await executeFanoutPlan(
      { mode: "fanout", arms: ["tavily", "exa"] },
      {
        descriptors: [tav.descriptor, exa.descriptor],
        env: {},
        query: "q",
        searchOptions: {},
        dependencies: makeExecDepsForFanout(),
      },
      context,
    );
    assert.strictEqual(result.kind, "data");
    assert.strictEqual(result.data.length, 1);
    assert.strictEqual(result.data[0].url, "https://e/tav");
    // Summary notice + per-arm drop notice
    const summary = notices.find((n) => /fanned out to 2 providers/.test(n));
    assert.ok(summary, `expected summary notice, got: ${JSON.stringify(notices)}`);
    assert.ok(/unique of \d+ results/.test(summary), "notice counts unique results");
    const drop = notices.find((n) => /arm exa dropped/.test(n));
    assert.ok(drop, `expected arm drop notice, got: ${JSON.stringify(notices)}`);
  });

  it("emits mergedFrom on the fan-out path (two-arm shared URL)", async () => {
    // Fan-out provenance sanity, in-process (not via main()). The
    // single-provider path's no-mergedFrom guarantee is pinned by the
    // golden tests below (mergeResults unit + main() single-pin run).
    const tav = makeFanoutDescriptor("tavily", {
      q: [{ title: "Tav", url: "https://e/p", summary: "s" }],
    });
    const exa = makeFanoutDescriptor("exa", {
      q: [{ title: "Exa", url: "https://e/p", summary: "different" }],
    });
    const { context, notices } = makeFanoutContext();
    const result = await executeFanoutPlan(
      { mode: "fanout", arms: ["tavily", "exa"] },
      {
        descriptors: [tav.descriptor, exa.descriptor],
        env: {},
        query: "q",
        searchOptions: {},
        dependencies: makeExecDepsForFanout(),
      },
      context,
    );
    // Two arms, shared URL → occurrences 2, mergedFrom present.
    assert.strictEqual(result.data.length, 1);
    assert.deepStrictEqual(result.data[0].mergedFrom, ["tavily", "exa"]);
    assert.strictEqual(result.data[0].occurrences, 2);
    // Suppress notice NOT present on fan-out
    assert.ok(
      !notices.some((n) => /explicit pin/.test(n)),
      "no suppress notice on fan-out path",
    );
  });
});

describe("executeFanoutPlan: option-drop arm (D5)", () => {
  it("emits an arm-drop notice naming the rejected control", async () => {
    const { UnsupportedOptionError } = await import("../dist/lib/errors.js");
    const tav = makeFanoutDescriptor("tavily", {
      q: [{ title: "Tav", url: "https://e/tav", summary: "tav" }],
    });
    const exa = makeFanoutDescriptor("exa", {}, {
      fail: new UnsupportedOptionError("exa", "search", "--domain"),
    });
    const { context, notices } = makeFanoutContext();
    const result = await executeFanoutPlan(
      { mode: "fanout", arms: ["tavily", "exa"] },
      {
        descriptors: [tav.descriptor, exa.descriptor],
        env: {},
        query: "q",
        searchOptions: { domain: "example.com" },
        dependencies: makeExecDepsForFanout(),
      },
      context,
    );
    assert.strictEqual(result.kind, "data");
    assert.strictEqual(result.data.length, 1);
    const drop = notices.find((n) => /arm exa dropped/.test(n));
    assert.ok(drop, `expected drop notice, got: ${JSON.stringify(notices)}`);
    assert.ok(/--domain/.test(drop), "drop notice names the rejected control");
    assert.ok(/UNSUPPORTED_OPTION/.test(drop), "drop notice names the error code");
  });
});

describe("executeFanoutPlan: all-fail exit 1 via boundary (D6)", () => {
  it("propagates the last arm's typed error so the boundary exits 1", async () => {
    const { UnsupportedOptionError } = await import("../dist/lib/errors.js");
    const err1 = new UnsupportedOptionError("tavily", "search", "--domain");
    const err2 = new UnsupportedOptionError("exa", "search", "--domain");
    const tav = makeFanoutDescriptor("tavily", {}, { fail: err1 });
    const exa = makeFanoutDescriptor("exa", {}, { fail: err2 });
    const { context } = makeFanoutContext();
    await assert.rejects(
      () =>
        executeFanoutPlan(
          { mode: "fanout", arms: ["tavily", "exa"] },
          {
            descriptors: [tav.descriptor, exa.descriptor],
            env: {},
            query: "q",
            searchOptions: { domain: "example.com" },
            dependencies: makeExecDepsForFanout(),
          },
          context,
        ),
      (error) => {
        // The last arm's error wins; the boundary maps it to the proper
        // exit code (UNSUPPORTED_OPTION is exit 1).
        assert.strictEqual(error.name, "UnsupportedOptionError");
        return true;
      },
    );
  });
});

describe("executeFanoutPlan: zero arms → VALIDATION_ERROR (D6)", () => {
  it("throws ValidationError naming the configured set when no arms resolve", async () => {
    // The resolver expanded "all" against unconfigured descriptors →
    // an empty arm list reaches the executor.
    const unconfigured = {
      id: "tavily",
      isConfigured: () => false,
      capabilities: () => new Set(["search"]),
      create: () => ({ id: "tavily", search: {} }),
    };
    const { context } = makeFanoutContext();
    await assert.rejects(
      () =>
        executeFanoutPlan(
          { mode: "fanout", arms: [] },
          {
            descriptors: [unconfigured],
            env: {},
            query: "q",
            searchOptions: {},
            dependencies: makeExecDepsForFanout(),
          },
          context,
        ),
      (error) => {
        assert.strictEqual(error.name, "ValidationError");
        assert.ok(/tavily/.test(error.message), "names the configured set");
        return true;
      },
    );
  });
});

describe("executeFanoutPlan: --no-cache forwarding to every arm", () => {
  it("forwards noCache=true to every arm's executeSearch path", async () => {
    const a = makeFanoutDescriptor("tavily", {
      q: [{ title: "A", url: "https://e/a", summary: "a" }],
    });
    const b = makeFanoutDescriptor("exa", {
      q: [{ title: "B", url: "https://e/b", summary: "b" }],
    });
    const { context } = makeFanoutContext();
    const result = await executeFanoutPlan(
      { mode: "fanout", arms: ["tavily", "exa"] },
      {
        descriptors: [a.descriptor, b.descriptor],
        env: {},
        query: "q",
        searchOptions: { noCache: true },
        dependencies: makeExecDepsForFanout(),
      },
      context,
    );
    // Both arms invoked regardless of caching policy.
    assert.strictEqual(a.invokes.length, 1);
    assert.strictEqual(b.invokes.length, 1);
    // The cache state is irrelevant; the noCache flag is consumed by
    // executeSearch, which is what the executor forwards to. The fan-
    // out executor passes the options through unchanged.
    assert.strictEqual(result.kind, "data");
  });
});

describe("executeFanoutPlan: single-pin golden via main() (byte-identical stdout, no mergedFrom, no fan-out notices)", () => {
  it("scoutline --provider tavily with fanout=true produces byte-identical output + suppress notice", async () => {
    // Build a hermetic main() environment. Two fake descriptors; only
    // `tavily` is configured. routing and fanout are off.
    function makeConfiguredDescriptor(id, results) {
      const invokes = [];
      return {
        descriptor: {
          id,
          isConfigured: () => true,
          capabilities: () => new Set(["search"]),
          create: () => ({
            id,
            search: {
              validate() {},
              cacheIdentity(r) {
                return {
                  provider: id,
                  capability: "search",
                  credentialFingerprint: "fp-" + id,
                  request: r,
                  legacyCandidates: [],
                };
              },
              async invoke(r) {
                invokes.push(r);
                return results.map((entry) => ({ ...entry }));
              },
            },
          }),
        },
        invokes,
      };
    }
    const tav = makeConfiguredDescriptor("tavily", [
      { title: "Tav", url: "https://e/p", summary: "s" },
    ]);
    const exa = makeConfiguredDescriptor("exa", [
      { title: "Exa", url: "https://e/p", summary: "different" },
    ]);
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
    // --provider tavily is an explicit pin and forces single mode even
    // when fanout=true. The Golden run comparison comes from the same
    // input with fanout=false; both must produce byte-identical
    // stdout and no fan-out notices. We assert byte-identical in-process
    // by running both modes. The A run carries configFanout: true (the
    // injected Ticket-3 seam); the B run leaves it off (pre-fan-out
    // behavior).
    const freshCache = () => {
      const s = new Map();
      return {
        async get(k) {
          return s.has(k) ? s.get(k) : null;
        },
        async set(k, v) {
          s.set(k, v);
        },
      };
    };
    const statusA = await main(["--provider", "tavily", "search", "q"], {
      invocation: adapter,
      env: {},
      providerDescriptors: [tav.descriptor, exa.descriptor],
      configFanout: true,
      searchCache: freshCache(),
      searchSleep: async () => {},
      searchRandom: () => 0.5,
    });
    const outA = stdout.slice();
    const errA = stderr.slice();
    stdout.length = 0;
    stderr.length = 0;
    const statusB = await main(["--provider", "tavily", "search", "q"], {
      invocation: adapter,
      env: {},
      providerDescriptors: [tav.descriptor, exa.descriptor],
      searchCache: freshCache(),
      searchSleep: async () => {},
      searchRandom: () => 0.5,
    });
    const outB = stdout.slice();
    const errB = stderr.slice();
    assert.strictEqual(statusA, 0);
    assert.strictEqual(statusB, 0);
    // Byte-identical stdout between fanout-on and fanout-off (single pin).
    assert.deepStrictEqual(outA, outB);
    // No mergedFrom field on the single-pin path.
    const data = JSON.parse(outA[0]);
    assert.strictEqual(data.length, 1);
    assert.strictEqual(data[0].title, "Tav");
    assert.ok(
      !Object.hasOwn(data[0], "mergedFrom"),
      "single-pin output must omit mergedFrom",
    );
    // The single intended stderr delta: exactly one suppress notice on
    // the fanout=true run, nothing on the fanout=false run, and no
    // fan-out vocabulary (summary/merged notices) in either.
    assert.deepStrictEqual(errA, ["explicit pin: fan-out ignored"]);
    assert.deepStrictEqual(errB, []);
    assert.ok(
      !errA.some((n) => /fanned out to/.test(n)),
      "no fan-out summary on the single-pin path",
    );
  });
});

// =============================================================================
// Ticket 4 — Config toggle + help (DESIGN D7)
//
// The `fanout` typed registry row makes the switch a first-class config
// key (`config set/get/unset fanout`) with the mandated cost sentence on
// enable, and SEARCH_HELP documents the four activation tiers, the cost
// line, `mergedFrom`, and the identity-only canonicalization note. The
// golden test drives the toggle through the REAL config store: enabling
// fans out, and toggling back off restores the never-enabled single
// path byte-for-byte. (The `--provider tavily` single-pin suppress
// notice under fanout=true is already pinned by the Ticket 3 golden
// above.)
// =============================================================================

describe("SEARCH_HELP: fan-out documentation anchors (Ticket 4, D7)", () => {
  it("documents all four activation tiers", () => {
    assert.ok(SEARCH_HELP.includes("activation tiers"), "section heading");
    // Tier 1: explicit comma-list / all → fan-out.
    assert.ok(SEARCH_HELP.includes("--provider all"), "tier 1: all sentinel");
    assert.ok(/--provider <[a-z]+,[a-z]+/i.test(SEARCH_HELP), "tier 1: comma-list");
    // Tier 2: single id / env pin → single, fan-out ignored.
    assert.ok(SEARCH_HELP.includes("SCOUTLINE_PROVIDER"), "tier 2: env pin");
    assert.match(SEARCH_HELP, /explicit pin; fan-out is ignored/i, "tier 2 wording");
    // Tier 3: config switch, routing.search order.
    assert.ok(SEARCH_HELP.includes("config set fanout true"), "tier 3: config switch");
    assert.ok(SEARCH_HELP.includes("routing.search"), "tier 3: routing order");
    // Tier 4: default single.
    assert.match(SEARCH_HELP, /No pin and fanout off \(the default\)/, "tier 4: default");
  });

  it("carries the mandated cost line verbatim", () => {
    assert.ok(
      SEARCH_HELP.includes(
        "every search will bill ALL configured search providers — N arms = N billable calls",
      ),
      "cost sentence must appear verbatim",
    );
  });

  it("documents mergedFrom and the identity-only canonicalization note", () => {
    assert.ok(SEARCH_HELP.includes("mergedFrom"), "mergedFrom doc");
    assert.ok(SEARCH_HELP.includes("utm_*"), "tracking-param removal named");
    assert.match(SEARCH_HELP, /dedupe identity ONLY/i, "identity-only note");
    assert.ok(SEARCH_HELP.includes("first arm"), "first-arm metadata wins");
  });

  it("keeps the existing single-path documentation (regression anchors)", () => {
    assert.ok(SEARCH_HELP.includes("--merge"));
    assert.ok(SEARCH_HELP.includes("--count"));
    assert.ok(SEARCH_HELP.includes("--topic"));
    assert.ok(SEARCH_HELP.includes("SCOUTLINE_PROVIDER=<id>"));
  });
});

describe("config toggle: fanout on → off restores the single path (golden)", () => {
  it("toggling fanout off is byte-identical to never enabling it", async (t) => {
    const fsMod = await import("node:fs/promises");
    const osMod = await import("node:os");
    const pathMod = await import("node:path");
    const { writeConfig, readConfig, setConfigValue } = await import(
      "../dist/lib/config-store.js"
    );

    function makeConfiguredDescriptor(id, results) {
      const invokes = [];
      return {
        descriptor: {
          id,
          isConfigured: () => true,
          capabilities: () => new Set(["search"]),
          create: () => ({
            id,
            search: {
              validate() {},
              cacheIdentity(r) {
                return {
                  provider: id,
                  capability: "search",
                  credentialFingerprint: "fp-" + id,
                  request: r,
                  legacyCandidates: [],
                };
              },
              async invoke(r) {
                invokes.push(r);
                return results.map((entry) => ({ ...entry }));
              },
            },
          }),
        },
        invokes,
      };
    }
    // Three configured providers: zai (the single-path default pick)
    // plus tavily/exa with one overlapping URL → the ON run fans out to
    // all three and proves provenance on the overlap; the OFF/NEVER
    // runs stay single (zai) with no fan-out vocabulary.
    const zai = makeConfiguredDescriptor("zai", [
      { title: "Zai", url: "https://e/z", summary: "from zai" },
    ]);
    const tav = makeConfiguredDescriptor("tavily", [
      { title: "Tav", url: "https://e/p", summary: "from tavily" },
    ]);
    const exa = makeConfiguredDescriptor("exa", [
      { title: "Exa", url: "https://e/p", summary: "from exa" },
    ]);

    const mkOptions = (dir) => ({ filePath: pathMod.join(dir, "config.json"), onWarning: () => {} });
    const dirs = [];
    t.after(async () => {
      for (const dir of dirs) await fsMod.rm(dir, { recursive: true, force: true });
    });
    const tempDir = async () => {
      const dir = await fsMod.mkdtemp(pathMod.join(osMod.tmpdir(), "scoutline-fanout-toggle-"));
      dirs.push(dir);
      await writeConfig({ version: 1, providers: {} }, mkOptions(dir));
      return dir;
    };

    const freshCache = () => {
      const store = new Map();
      return {
        async get(k) {
          return store.has(k) ? store.get(k) : null;
        },
        async set(k, v) {
          store.set(k, v);
        },
      };
    };

    // One search run against the REAL config store at `dir` (production
    // read path: main → loadScoutlineConfig → config.fanout).
    const runSearch = async (dir) => {
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
      const status = await main(["search", "q"], {
        invocation: adapter,
        env: {},
        providerDescriptors: [zai.descriptor, tav.descriptor, exa.descriptor],
        loadScoutlineConfig: () => readConfig(mkOptions(dir)),
        searchCache: freshCache(),
        searchSleep: async () => {},
        searchRandom: () => 0.5,
      });
      return { status, stdout: stdout.slice(), stderr: stderr.slice() };
    };

    // ON — enable through the Ticket 4 registry surface.
    const onDir = await tempDir();
    await setConfigValue("fanout", "true", mkOptions(onDir));
    const on = await runSearch(onDir);
    assert.strictEqual(on.status, 0);
    assert.ok(
      on.stderr.some((n) => /fanned out to 3 providers \(zai, tavily, exa\)/.test(n)),
      `fan-out summary notice expected, got: ${JSON.stringify(on.stderr)}`,
    );
    const onData = JSON.parse(on.stdout[0]);
    assert.strictEqual(onData.length, 2, "overlap merged + zai's distinct URL");
    const merged = onData.find((r) => r.url === "https://e/p");
    assert.ok(merged, "overlapping result present");
    assert.deepStrictEqual(merged.mergedFrom, ["tavily", "exa"]);
    assert.strictEqual(merged.occurrences, 2);

    // OFF — toggle back off through the same surface.
    await setConfigValue("fanout", "false", mkOptions(onDir));
    const off = await runSearch(onDir);
    assert.strictEqual(off.status, 0);
    assert.ok(
      !JSON.stringify(off.stdout).includes("mergedFrom"),
      "toggle-off output omits mergedFrom",
    );
    assert.deepStrictEqual(off.stderr, [], "no notices after toggle-off");

    // NEVER — a config that never carried the switch.
    const neverDir = await tempDir();
    const never = await runSearch(neverDir);
    assert.strictEqual(never.status, 0);

    // The golden: toggle-off restores the never-enabled single path
    // byte-for-byte (stdout AND stderr).
    assert.deepStrictEqual(off.stdout, never.stdout, "toggle-off stdout must be byte-identical");
    assert.deepStrictEqual(off.stderr, never.stderr, "toggle-off stderr must be byte-identical");
    // And the environment really did toggle: the ON output differs.
    assert.notDeepStrictEqual(on.stdout, off.stdout, "fan-out engaged on the ON run");
  });
});

// =============================================================================
// Ticket 5 — Wire (end-to-end through main) + ADR-0004 ship
//
// The Tier-1 comma-list pin (`--provider tavily,exa`) is the one
// activation tier that must survive the REAL main wire: global option
// extraction → handleSearch → resolveFanoutPlan → executeFanoutPlan →
// mergeResults → outputSuccess. Hermetic: fake descriptors, injected
// config loader (empty config — no fanout switch needed, Tier 1 wins),
// in-memory cache, deterministic sleep/random. stderr carries the D5
// fan-out summary notice ONLY — no other notices on the happy path.
// =============================================================================

describe("Ticket 5 — main-driven hermetic wire test (fan-out end-to-end)", () => {
  it("--provider tavily,exa merges overlapping fixtures through main; exit 0; stderr carries the summary notice only", async () => {
    function makeWireDescriptor(id, results) {
      const invokes = [];
      return {
        descriptor: {
          id,
          isConfigured: () => true,
          capabilities: () => new Set(["search"]),
          create: () => ({
            id,
            search: {
              validate() {},
              cacheIdentity(r) {
                return {
                  provider: id,
                  capability: "search",
                  credentialFingerprint: "fp-" + id,
                  request: r,
                  legacyCandidates: [],
                };
              },
              async invoke(r) {
                invokes.push(r);
                return results.map((entry) => ({ ...entry }));
              },
            },
          }),
        },
        invokes,
      };
    }
    // Two fake providers with overlapping fixtures. The overlap is a
    // canonical-identity collision (D4): trailing slash + utm_* +
    // fragment must dedupe to the first writer's original URL.
    const tav = makeWireDescriptor("tavily", [
      { title: "Shared (tavily)", url: "https://e/shared", summary: "tavily's copy" },
      { title: "Tav-only", url: "https://e/tav-only", summary: "t" },
    ]);
    const exa = makeWireDescriptor("exa", [
      { title: "Shared (exa)", url: "https://e/shared/?utm_source=x#frag", summary: "exa's copy" },
      { title: "Exa-only", url: "https://e/exa-only", summary: "x" },
    ]);
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
    const freshCache = () => {
      const store = new Map();
      return {
        async get(k) {
          return store.has(k) ? store.get(k) : null;
        },
        async set(k, v) {
          store.set(k, v);
        },
      };
    };
    // Hermetic env: the injected loader returns an empty config — the
    // Tier-1 explicit multi-pin must activate fan-out with NO config
    // switch and NO env pin.
    const status = await main(["--provider", "tavily,exa", "search", "q"], {
      invocation: adapter,
      env: {},
      providerDescriptors: [tav.descriptor, exa.descriptor],
      loadScoutlineConfig: async () => ({ version: 1, providers: {} }),
      searchCache: freshCache(),
      searchSleep: async () => {},
      searchRandom: () => 0.5,
    });
    assert.strictEqual(status, 0, `exit 0 expected, stderr: ${JSON.stringify(stderr)}`);
    // stderr carries the D5 summary notice ONLY — nothing else.
    assert.deepStrictEqual(stderr, [
      "fanned out to 2 providers (tavily, exa) → 3 unique of 4 results",
    ]);
    // Merged data-mode output end-to-end (stdout stays data-only).
    const data = JSON.parse(stdout[0]);
    assert.ok(Array.isArray(data), "data mode emits the results array");
    assert.strictEqual(data.length, 3, "overlap collapsed: 3 unique of 4 raw results");
    const merged = data[0];
    assert.strictEqual(merged.url, "https://e/shared", "first writer's original url survives");
    assert.strictEqual(merged.title, "Shared (tavily)", "first arm's metadata wins the collision");
    assert.strictEqual(merged.summary, "tavily's copy");
    assert.strictEqual(merged.occurrences, 2);
    assert.deepStrictEqual(merged.mergedFrom, ["tavily", "exa"]);
    // Distinct results keep their single-provider provenance.
    assert.deepStrictEqual(data[1].mergedFrom, ["tavily"]);
    assert.deepStrictEqual(data[2].mergedFrom, ["exa"]);
    // Both arms really executed exactly once (one client per arm).
    assert.strictEqual(tav.invokes.length, 1);
    assert.strictEqual(exa.invokes.length, 1);
  });
});

// =============================================================================
// Review fixes (PR #36 feedback) — behavior changes pinned tests-first.
//
// 1. `--merge` composes with fan-out: the executor splits the query per
//    arm and merges the (arm × sub-query) grid — the whole `a|b` string
//    must NEVER reach a provider as one query.
// 2. Consumption: fan-out arms thread the configured sink so every
//    billable arm records through local quota accounting.
// 3. canonicalUrl identity hardening: percent-encoded tracking names
//    collapse with decoded ones; raw path (dot segments) and userinfo
//    are preserved verbatim — D4 authorizes no other normalization.
// =============================================================================

describe("executeFanoutPlan: --merge composes with fan-out (arms × sub-queries grid, review fix)", () => {
  it("splits the query per arm; every arm runs every sub-query; occurrences span the grid", async () => {
    const tav = makeFanoutDescriptor("tavily", {
      a: [{ title: "T-a", url: "https://e/shared", summary: "t a" }],
      b: [{ title: "T-b", url: "https://e/shared", summary: "t b" }],
    });
    const exa = makeFanoutDescriptor("exa", {
      a: [{ title: "E-a", url: "https://e/shared", summary: "e a" }],
      b: [{ title: "E-b", url: "https://e/exa-only", summary: "e b" }],
    });
    const { context, notices } = makeFanoutContext();
    const result = await executeFanoutPlan(
      { mode: "fanout", arms: ["tavily", "exa"] },
      {
        descriptors: [tav.descriptor, exa.descriptor],
        env: {},
        query: "a|b",
        searchOptions: { merge: true },
        dependencies: makeExecDepsForFanout(),
      },
      context,
    );
    // Each arm ran BOTH sub-queries — never the raw "a|b" string.
    assert.deepStrictEqual(
      tav.invokes.map((r) => r.query),
      ["a", "b"],
    );
    assert.deepStrictEqual(
      exa.invokes.map((r) => r.query),
      ["a", "b"],
    );
    const merged = result.data;
    assert.strictEqual(merged.length, 2);
    const shared = merged.find((r) => r.url === "https://e/shared");
    assert.ok(shared, "shared result present");
    assert.strictEqual(shared.occurrences, 3, "2 tavily sub-queries + 1 exa sub-query");
    assert.deepStrictEqual(shared.mergedFrom, ["tavily", "exa"]);
    const only = merged.find((r) => r.url === "https://e/exa-only");
    assert.ok(only, "exa-only result present");
    assert.strictEqual(only.occurrences, 1);
    assert.deepStrictEqual(only.mergedFrom, ["exa"]);
    // D5: the fan-out summary replaces the single-path merged notice.
    assert.ok(
      notices.some((n) => /fanned out to 2 providers/.test(n)),
      `fan-out summary expected, got: ${JSON.stringify(notices)}`,
    );
    assert.ok(!notices.some((n) => /merged 2 queries/.test(n)), "no separate merged notice");
  });

  it("honors the \\| escape: one literal-pipe sub-query per arm", async () => {
    const tav = makeFanoutDescriptor("tavily", {
      "x|y": [{ title: "T", url: "https://e/t", summary: "t" }],
    });
    const result = await executeFanoutPlan(
      { mode: "fanout", arms: ["tavily"] },
      {
        descriptors: [tav.descriptor],
        env: {},
        query: "x\\|y",
        searchOptions: { merge: true },
        dependencies: makeExecDepsForFanout(),
      },
      makeFanoutContext().context,
    );
    assert.deepStrictEqual(
      tav.invokes.map((r) => r.query),
      ["x|y"],
    );
    assert.strictEqual(result.data.length, 1);
  });

  it("without --merge the raw query runs as ONE sub-query per arm", async () => {
    const tav = makeFanoutDescriptor("tavily", {
      "a|b": [{ title: "T", url: "https://e/t", summary: "t" }],
    });
    await executeFanoutPlan(
      { mode: "fanout", arms: ["tavily"] },
      {
        descriptors: [tav.descriptor],
        env: {},
        query: "a|b",
        searchOptions: {},
        dependencies: makeExecDepsForFanout(),
      },
      makeFanoutContext().context,
    );
    assert.deepStrictEqual(
      tav.invokes.map((r) => r.query),
      ["a|b"],
    );
  });

  it("rejects a merge query with no non-empty fragments (same error as the single path)", async () => {
    const tav = makeFanoutDescriptor("tavily", {});
    await assert.rejects(
      () =>
        executeFanoutPlan(
          { mode: "fanout", arms: ["tavily"] },
          {
            descriptors: [tav.descriptor],
            env: {},
            query: " | ",
            searchOptions: { merge: true },
            dependencies: makeExecDepsForFanout(),
          },
          makeFanoutContext().context,
        ),
      /--merge requires at least one non-empty query/,
    );
  });
});

describe("executeFanoutPlan: consumption sink (review fix)", () => {
  it("records one search consumption event per arm through the configured sink", async () => {
    const tav = makeFanoutDescriptor("tavily", {
      q: [{ title: "T", url: "https://e/t", summary: "t" }],
    });
    const exa = makeFanoutDescriptor("exa", {
      q: [{ title: "E", url: "https://e/e", summary: "e" }],
    });
    const events = [];
    const sink = {
      async record(event) {
        events.push(event);
      },
    };
    const result = await executeFanoutPlan(
      { mode: "fanout", arms: ["tavily", "exa"] },
      {
        descriptors: [tav.descriptor, exa.descriptor],
        env: {},
        query: "q",
        searchOptions: {},
        dependencies: { ...makeExecDepsForFanout(), consume: sink, now: () => 4242 },
      },
      makeFanoutContext().context,
    );
    assert.strictEqual(result.kind, "data");
    assert.strictEqual(events.length, 2, "one event per arm");
    assert.deepStrictEqual(
      events.map((e) => e.provider).sort(),
      ["exa", "tavily"],
    );
    for (const e of events) {
      assert.strictEqual(e.capabilityId, "search");
      assert.strictEqual(e.attempt, 1);
      assert.strictEqual(e.at, 4242, "injected now() timestamps the event");
    }
  });

  it("main() threads the configured consume sink into every fan-out arm", async () => {
    function makeSinkDescriptor(id, results) {
      return {
        id,
        isConfigured: () => true,
        capabilities: () => new Set(["search"]),
        create: () => ({
          id,
          search: {
            validate() {},
            cacheIdentity(r) {
              return {
                provider: id,
                capability: "search",
                credentialFingerprint: "fp-" + id,
                request: r,
                legacyCandidates: [],
              };
            },
            async invoke() {
              return results.map((entry) => ({ ...entry }));
            },
          },
        }),
      };
    }
    const events = [];
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
    const store = new Map();
    const status = await main(["--provider", "tavily,exa", "search", "q"], {
      invocation: adapter,
      env: {},
      providerDescriptors: [
        makeSinkDescriptor("tavily", [{ title: "T", url: "https://e/t", summary: "t" }]),
        makeSinkDescriptor("exa", [{ title: "E", url: "https://e/e", summary: "e" }]),
      ],
      loadScoutlineConfig: async () => ({ version: 1, providers: {} }),
      searchCache: {
        async get(k) {
          return store.has(k) ? store.get(k) : null;
        },
        async set(k, v) {
          store.set(k, v);
        },
      },
      searchSleep: async () => {},
      searchRandom: () => 0.5,
      consume: {
        async record(event) {
          events.push(event);
        },
      },
    });
    assert.strictEqual(status, 0, `exit 0 expected, stderr: ${JSON.stringify(stderr)}`);
    assert.strictEqual(events.length, 2, "both arms billed through the sink");
    assert.deepStrictEqual(
      events.map((e) => e.provider).sort(),
      ["exa", "tavily"],
    );
  });
});

describe("canonicalUrl: review fixes (decoded tracking names, raw path/userinfo preservation)", () => {
  it("collapses a percent-encoded tracking name with its decoded twin (%66bclid ≡ fbclid)", () => {
    assert.strictEqual(
      canonicalUrl("https://e/a?%66bclid=x&keep=1"),
      canonicalUrl("https://e/a?fbclid=x&keep=1"),
    );
    assert.strictEqual(canonicalUrl("https://e/a?%66bclid=x&keep=1"), "https://e/a?keep=1");
  });

  it("matches utm_* after percent-decoding too", () => {
    assert.strictEqual(canonicalUrl("https://e/a?%75tm_source=x&k=1"), "https://e/a?k=1");
  });

  it("keeps a malformed percent-escape in the name (identity never throws)", () => {
    assert.strictEqual(canonicalUrl("https://e/a?%zz=1&k=2"), "https://e/a?%zz=1&k=2");
  });

  it("preserves userinfo in the identity (D4 authorizes no authority dropping)", () => {
    assert.strictEqual(canonicalUrl("https://user@example.com/a"), "https://user@example.com/a");
    assert.strictEqual(
      canonicalUrl("https://user:pass@example.com/a"),
      "https://user:pass@example.com/a",
    );
    assert.notStrictEqual(
      canonicalUrl("https://user@example.com/a"),
      canonicalUrl("https://example.com/a"),
      "credential-bearing URL must not merge with the bare-authority twin",
    );
  });

  it("preserves dot segments in the path (no unauthorized normalization)", () => {
    assert.strictEqual(canonicalUrl("https://example.com/a/../b"), "https://example.com/a/../b");
    assert.notStrictEqual(
      canonicalUrl("https://example.com/a/../b"),
      canonicalUrl("https://example.com/b"),
    );
    assert.strictEqual(canonicalUrl("https://example.com/./a/"), "https://example.com/./a");
  });

  it("keeps the documented transformations on top of the raw path", () => {
    assert.strictEqual(
      canonicalUrl("HTTPS://EXAMPLE.com:443/A/../b?utm_source=x&k=1#frag"),
      "https://example.com/A/../b?k=1",
    );
  });

  it("stays idempotent on the new identity forms", () => {
    const urls = [
      "https://user@example.com/a/../b?k=1",
      "https://e/a?%66bclid=x&keep=1",
      "https://e/a?%zz=1",
    ];
    for (const u of urls) {
      const once = canonicalUrl(u);
      const twice = canonicalUrl(once);
      assert.strictEqual(twice, once, `idempotence broken for ${u}`);
    }
  });
});
