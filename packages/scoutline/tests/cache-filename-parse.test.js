/**
 * `parseCacheFileName` widening — dotted science capabilities and
 * keyless (empty) credential segments (issue #140 T4b).
 *
 * The pre-science grammar required EXACTLY six dot-separated segments
 * with every middle segment non-empty, which two settled #140 rulings
 * violate:
 *   - the science capability is carried VERBATIM and is dotted
 *     (`science.search` / `science.get`), so a science key has seven
 *     dot-separated fields;
 *   - science suppliers are keyless, so the credential fingerprint is
 *     `""` and the key carries an EMPTY segment
 *     (`v2.science.search.openalex..<hash>.json`).
 *
 * The widened grammar is a right-split: the request hash is last, the
 * credential fingerprint is second-to-last (MAY be empty), the provider
 * is third-to-last (non-empty), and everything left of it — joined back
 * on "." — is the capability (MAY carry dots, must be non-empty). To
 * keep the widening from being a loosening, the request hash must have
 * the SHA-256 house shape (64 lowercase hex); anything else stays a
 * legacy non-v2 name and parses to `null` exactly as before.
 *
 * Stats bucketing and prune selector matching over these shapes are
 * pinned in `tests/cache.test.js` (they need an isolated cache dir).
 * Tests import ../dist/... — verification order is build, then test.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { parseCacheFileName, buildProviderCacheKey } from "../dist/lib/cache.js";

const credHash = crypto.createHash("sha256").update("cred").digest("hex");
const reqHash = crypto.createHash("sha256").update("req").digest("hex");

describe("parseCacheFileName — science shape: dotted capability, keyless credential (#140 T4b)", () => {
  it("(a) parses a dotted science capability built by buildProviderCacheKey", () => {
    const name = buildProviderCacheKey({
      provider: "openalex",
      capability: "science.search",
      credentialFingerprint: credHash,
      request: { query: "graph transformers" },
    });
    assert.deepStrictEqual(parseCacheFileName(name), {
      capability: "science.search",
      provider: "openalex",
    });
  });

  it("(a) parses the literal 7-field science search filename", () => {
    // The exact shape the RED brief pins: v2.<cap>.<cap-part>.<provider>.<cred>.<req>.json
    const name = `v2.science.search.openalex.${credHash}.${reqHash}.json`;
    assert.deepStrictEqual(parseCacheFileName(name), {
      capability: "science.search",
      provider: "openalex",
    });
  });

  it("(b) parses a keyless (EMPTY credential segment) science key", () => {
    const name = buildProviderCacheKey({
      provider: "arxiv",
      capability: "science.get",
      credentialFingerprint: "",
      request: { identifier: "10.1038/nature12373" },
    });
    assert.deepStrictEqual(parseCacheFileName(name), {
      capability: "science.get",
      provider: "arxiv",
    });
  });

  it("(b) parses the literal dotted+keyless filename with an empty segment", () => {
    const name = `v2.science.get.arxiv..${reqHash}.json`;
    assert.deepStrictEqual(parseCacheFileName(name), {
      capability: "science.get",
      provider: "arxiv",
    });
  });

  it("the keyless science get key really does carry the empty segment", () => {
    // Guards the fixture itself: if buildProviderCacheKey ever stopped
    // emitting the empty segment, pin (b) would silently stop testing it.
    const name = buildProviderCacheKey({
      provider: "europepmc",
      capability: "science.get",
      credentialFingerprint: "",
      request: { identifier: "10.1038/nature12373" },
    });
    assert.match(name, /^v2\.science\.get\.europepmc\.\.[0-9a-f]{64}\.json$/);
  });

  it("a dotted capability and a non-empty credential parse together", () => {
    // Keyed science upgrade (OPENALEX_API_KEY present): both widened
    // features at once.
    const name = `v2.science.get.pubmed.${credHash}.${reqHash}.json`;
    assert.deepStrictEqual(parseCacheFileName(name), {
      capability: "science.get",
      provider: "pubmed",
    });
  });
});

describe("parseCacheFileName — back-compat: every pre-science shape parses identically (#140 T4b)", () => {
  const cases = [
    { capability: "search", provider: "zai" },
    { capability: "search", provider: "tavily" },
    { capability: "read", provider: "tavily" },
    { capability: "reader-reader-fetch", provider: "tavily" },
    { capability: "repository-exploration-file", provider: "zai" },
    { capability: "repository-exploration-directory", provider: "zai" },
    { capability: "repository-exploration-search", provider: "zai" },
    { capability: "crawl-crawl-fetch", provider: "firecrawl" },
    { capability: "map-map-fetch", provider: "tavily" },
    { capability: "research-research-fetch", provider: "exa" },
  ];

  it("(e) parses each real dash-suffixed namespace key to its exact pair", () => {
    for (const { capability, provider } of cases) {
      const name = buildProviderCacheKey({
        provider,
        capability,
        credentialFingerprint: credHash,
        request: { probe: capability },
      });
      assert.deepStrictEqual(
        parseCacheFileName(name),
        { capability, provider },
        `parsed pair for ${capability}/${provider}`,
      );
    }
  });

  it("(e) parses the literal 6-field v2 filenames used across the suite", () => {
    assert.deepStrictEqual(parseCacheFileName(`v2.search.zai.${credHash}.${reqHash}.json`), {
      capability: "search",
      provider: "zai",
    });
    assert.deepStrictEqual(parseCacheFileName(`v2.read.tavily.${credHash}.${reqHash}.json`), {
      capability: "read",
      provider: "tavily",
    });
  });

  it("(e) the widened parse agrees with the raw segment positions for 6-field names", () => {
    // A 6-field name still right-splits to the same two fields: no
    // pre-science shape changes bucket or selector membership.
    for (const { capability, provider } of cases) {
      const name = `v2.${capability}.${provider}.${credHash}.${reqHash}.json`;
      assert.deepStrictEqual(parseCacheFileName(name), { capability, provider });
    }
  });
});

describe("parseCacheFileName — malformed shapes stay null (#140 T4b)", () => {
  it("(f) rejects a non-hex request hash instead of widening into it", () => {
    assert.strictEqual(parseCacheFileName(`v2.search.zai.${credHash}.not-a-hash.json`), null);
    assert.strictEqual(
      parseCacheFileName(`v2.search.zai.${credHash}.${"r".repeat(64)}.json`),
      null,
    );
  });

  it("(f) rejects an uppercase hex request hash (the house shape is lowercase)", () => {
    assert.strictEqual(
      parseCacheFileName(`v2.search.zai.${credHash}.${"A".repeat(64)}.json`),
      null,
    );
    assert.strictEqual(parseCacheFileName(`v2.science.get.arxiv..${"A".repeat(64)}.json`), null);
  });

  it("(f) rejects a short or over-long request hash", () => {
    assert.strictEqual(
      parseCacheFileName(`v2.search.zai.${credHash}.${"a".repeat(63)}.json`),
      null,
    );
    assert.strictEqual(
      parseCacheFileName(`v2.search.zai.${credHash}.${"a".repeat(65)}.json`),
      null,
    );
  });

  it("(f) rejects junk that has enough segments but no v2 hash shape", () => {
    assert.strictEqual(parseCacheFileName("v2.foo.bar.baz.qux.quux.json"), null);
    // A hex-LOOKING provider or capability is still fine (the fields are
    // opaque strings), but a non-hex request hash at the right-hand end
    // is what disqualifies the name.
    assert.strictEqual(parseCacheFileName("v2.foo.bar.baz.qux.zzzz.json"), null);
  });

  it("(f) rejects a NON-HEX credential fingerprint (empty or 64-lowercase-hex only — fix round F3)", () => {
    // External-review F3: the credential shape check was not
    // load-bearing (deleting it survived the full suite). A junk
    // credential segment must null — the widening admits the KEYLESS
    // empty fingerprint and the keyed SHA-256 digest, nothing between.
    assert.strictEqual(
      parseCacheFileName(`v2.science.search.openalex.junk-not-hex.${reqHash}.json`),
      null,
    );
    assert.strictEqual(
      parseCacheFileName(`v2.science.search.openalex.${"R".repeat(64)}.${reqHash}.json`),
      null,
      "uppercase hex credential is not the house shape either",
    );
    // The two legal shapes stay admitted (boundary neighbors of the pin).
    assert.deepStrictEqual(parseCacheFileName(`v2.science.search.openalex..${reqHash}.json`), {
      capability: "science.search",
      provider: "openalex",
    });
    assert.deepStrictEqual(
      parseCacheFileName(`v2.science.search.openalex.${credHash}.${reqHash}.json`),
      { capability: "science.search", provider: "openalex" },
    );
  });

  it("(f) rejects fewer than four segments after the v2./.json strip", () => {
    assert.strictEqual(parseCacheFileName("v2.only-three-parts.json"), null);
    assert.strictEqual(parseCacheFileName(`v2.search.zai.${credHash}.json`), null);
    assert.strictEqual(parseCacheFileName("v2.json"), null);
  });

  it("(f) rejects an empty capability — a leading-dot or interior-empty join", () => {
    assert.strictEqual(parseCacheFileName(`v2..zai.${credHash}.${reqHash}.json`), null);
    // The right-split joins the capability fields, so an EMPTY field
    // inside the join (`a..b`) is a malformed name, not a capability.
    assert.strictEqual(parseCacheFileName(`v2..science.get.${credHash}.${reqHash}.json`), null);
    assert.strictEqual(parseCacheFileName(`v2.science..get.${credHash}.${reqHash}.json`), null);
  });

  it("(f) rejects an empty provider", () => {
    assert.strictEqual(parseCacheFileName(`v2.search..${credHash}.${reqHash}.json`), null);
    assert.strictEqual(parseCacheFileName(`v2.science.search...${credHash}.${reqHash}.json`), null);
  });

  it("(f) rejects names missing the v2 prefix or the .json suffix", () => {
    assert.strictEqual(parseCacheFileName(`v2.search.zai.${credHash}.${reqHash}`), null);
    assert.strictEqual(parseCacheFileName(`search.zai.${credHash}.${reqHash}.json`), null);
    assert.strictEqual(parseCacheFileName(`v3.search.zai.${credHash}.${reqHash}.json`), null);
  });

  it("(f) rejects staging files, lock files, and non-strings", () => {
    assert.strictEqual(parseCacheFileName(".abc.tmp"), null);
    assert.strictEqual(
      parseCacheFileName(`.v2.search.zai.${credHash}.${reqHash}.json.1234.uuid.tmp`),
      null,
    );
    assert.strictEqual(parseCacheFileName("cache-write.lock"), null);
    assert.strictEqual(parseCacheFileName(""), null);
    assert.strictEqual(parseCacheFileName(undefined), null);
    assert.strictEqual(parseCacheFileName(42), null);
  });

  it("(f) a crafted __proto__ PROVIDER segment parses as an ordinary own field", () => {
    // `__proto__` in the provider slot (review P2 hardening): the parse is
    // a value, never a prototype write. The stats-bucket half of this pin
    // lives in tests/cache.test.js with an isolated cache dir.
    const parsed = parseCacheFileName(`v2.cap.__proto__.${credHash}.${reqHash}.json`);
    assert.deepStrictEqual(parsed, { capability: "cap", provider: "__proto__" });
    assert.strictEqual(Object.getPrototypeOf(parsed), Object.prototype);
    assert.strictEqual({}.polluted, undefined);
  });

  it("(f) a crafted __proto__ CAPABILITY segment is returned verbatim", () => {
    // Under the widening the capability may carry dots, so a proto-looking
    // capability joins into the field value rather than a prototype key.
    const parsed = parseCacheFileName(`v2.__proto__.zai.${credHash}.${reqHash}.json`);
    assert.deepStrictEqual(parsed, { capability: "__proto__", provider: "zai" });
    assert.strictEqual(Object.getPrototypeOf(parsed), Object.prototype);
    assert.strictEqual({}.polluted, undefined);
  });
});
