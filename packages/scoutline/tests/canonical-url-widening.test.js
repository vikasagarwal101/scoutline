/**
 * Canonicalization widening (fusion plan D3 / ticket T2): the URL
 * identity key collapses the direct www alias of a TWO-LABEL apex
 * host. Pure canonicalUrl unit tests + one read-only mergeResults pin
 * (the merge seam must keep emitting the first writer's URL verbatim).
 */
import test from "node:test";
import assert from "node:assert/strict";

import { canonicalUrl } from "../dist/lib/url.js";
import { mergeResults } from "../dist/commands/search.js";

test("www/apex identity pairs follow the two-label rule", () => {
  const rows = [
    // [urlA, urlB, sameIdentity]
    ["https://www.example.com/a", "https://example.com/a", true],
    ["https://WWW.EXAMPLE.COM/a", "https://example.com/a", true],
    ["https://www.blog.example.com/a", "https://blog.example.com/a", false],
    ["https://blog.example.com/a", "https://example.com/a", false],
    // Conservative boundary: three-label remainder stays distinct (no PSL).
    ["https://www.bbc.co.uk/a", "https://bbc.co.uk/a", false],
    // Single-label remainder (www.localhost) does not strip.
    ["https://www.localhost/a", "https://localhost/a", false],
  ];
  for (const [a, b, same] of rows) {
    const verdict = canonicalUrl(a) === canonicalUrl(b) ? "≡" : "≠";
    assert.equal(
      verdict,
      same ? "≡" : "≠",
      `${a} vs ${b}: got ${verdict}`,
    );
  }
});

test("www strip keeps explicit non-default port on both sides", () => {
  assert.equal(
    canonicalUrl("https://www.example.com:8080/a"),
    canonicalUrl("https://example.com:8080/a"),
  );
  assert.notEqual(
    canonicalUrl("https://www.example.com/a"),
    canonicalUrl("https://example.com:8080/a"),
  );
});

test("strip touches only the host; path and surviving query untouched", () => {
  const canonical = canonicalUrl("https://www.example.com/p?utm_source=x");
  assert.ok(
    canonical.startsWith("https://example.com/p"),
    `unexpected identity: ${canonical}`,
  );
  assert.ok(canonical.endsWith("/p"), `unexpected identity: ${canonical}`);
});

test("merge seam dedupes www/apex pairs but emits the first writer's URL verbatim", () => {
  const grid = [
    {
      provider: "tavily",
      results: [[{ rank: 1, title: "T", url: "https://www.example.com/p", summary: "s" }]],
    },
    {
      provider: "exa",
      results: [[{ rank: 1, title: "E", url: "https://example.com/p", summary: "s2" }]],
    },
  ];
  const merged = mergeResults(grid);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].url, "https://www.example.com/p");
  assert.equal(merged[0].occurrences, 2);

  const reversed = mergeResults([...grid].reverse());
  assert.equal(reversed.length, 1);
  assert.equal(reversed[0].url, "https://example.com/p");
  assert.equal(reversed[0].occurrences, 2);
});

test("malformed/relative input still passes through verbatim", () => {
  assert.equal(canonicalUrl("/path"), "/path");
});
