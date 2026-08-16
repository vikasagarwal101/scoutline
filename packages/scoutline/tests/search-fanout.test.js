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
import { mergeResults, search } from "../dist/commands/search.js";

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
