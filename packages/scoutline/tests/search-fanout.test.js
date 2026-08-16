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
