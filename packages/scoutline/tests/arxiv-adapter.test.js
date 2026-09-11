/**
 * arXiv adapter — T3 RED tests (TASKS T3; DESIGN D2/D3/D7; PRD AC-3,
 * AC-4b, AC-5, AC-7d).
 *
 * GROUND map (per describe below):
 *   - TASKS T3: "Atom hand parser (D3) + client + adapter +
 *     diagnostics.ts keyless probe" — adapter lives at
 *     providers/arxiv/{adapter,client,credentials,diagnostics}.ts
 *     cloning the spider/linkup shape (DESIGN D2 supplier-directory
 *     bullet).
 *   - TASKS T3: "rejects all four controls" / DESIGN D7 table + D7
 *     amendment (arXiv rejects author/year/venue/type — no post-filter,
 *     PRD AC-3) — UnsupportedOptionError at validate, before transport.
 *   - TASKS T3: "ScienceWork mapping pins" / PRD AC-7d ("arXiv Atom
 *     fields — adapters map, tests pin the mapping") — the fixture is
 *     a real-shape arXiv Atom feed slice (opensearch namespace,
 *     arxiv:doi, arxiv:primary_category, pdf link, CDATA, unicode).
 *   - TASKS T3: "cache identity (empty fingerprint)" / DESIGN D1 +
 *     D4b note — arXiv is keyless; credentialFingerprint is "" (no key
 *     model exists for arXiv at all, D2 table).
 *   - TASKS T3: "diagnostics probe smoke (keyless, bounded)" / DESIGN
 *     D2 round-3 ruling — doctor probes every always-configured
 *     supplier; probe is a minimal keyless wire call (max_results=1)
 *     on the arXiv query endpoint (PRD AC-5 round-3 consequence).
 *   - Registry flip: the T2 stub seat's create() throws ("not yet
 *     implemented"); T3 wires the real adapter into
 *     BUILT_IN_PROVIDER_DESCRIPTORS (anchor: registry.ts
 *     createXDescriptor import pattern).
 *
 * Tests import ../dist/... — verification order is build, then test.
 * No real network: transport fetch is injected (house pattern from
 * tests/spider-adapter.test.js).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createArxivDescriptor } from "../dist/providers/arxiv/adapter.js";
import { BUILT_IN_PROVIDER_DESCRIPTORS } from "../dist/providers/registry.js";
import {
  QuotaError,
  UnsupportedOptionError,
  ValidationError,
} from "../dist/lib/errors.js";

// ---------------------------------------------------------------------------
// Fixture — real-shape arXiv Atom feed slice (DESIGN D3; PRD AC-7d
// "arXiv Atom" verbatim-evidence column: id/title/summary/authors/
// published/updated/primary_category/doi(null)).
//
// Feed-level traps baked in on purpose: a feed <title>/<id>/<updated>
// OUTSIDE any <entry> (an entry-block tokenizer must not read them),
// opensearch:* elements, the XML prolog, root-level arxiv/opensearch
// namespace declarations, plus one per-element xmlns redeclaration
// (entry 2's arxiv:doi) and CDATA + unicode in entry 2.
// ---------------------------------------------------------------------------

const ARXIV_ATOM_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
  <link href="http://arxiv.org/api/query?search_query=all:attention" rel="self" type="application/atom+xml"/>
  <title type="html">ArXiv Query: search_query=all:attention</title>
  <id>http://arxiv.org/api/cHxbTPvP4AJhd2Rb2Rd4H1eO5Bn</id>
  <updated>2026-09-11T00:00:00-04:00</updated>
  <opensearch:totalResults xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">2</opensearch:totalResults>
  <opensearch:startIndex>0</opensearch:startIndex>
  <opensearch:itemsPerPage>10</opensearch:itemsPerPage>
  <entry>
    <id>http://arxiv.org/abs/1706.03762v7</id>
    <updated>2023-08-02T00:41:18Z</updated>
    <published>2017-06-12T17:57:34Z</published>
    <title>Attention Is All You Need</title>
    <summary>  The dominant sequence transduction models are based on complex recurrent or convolutional neural networks that include at least two neural-network-based components.  </summary>
    <author><name>Ashish Vaswani</name></author>
    <author><name>Noam Shazeer</name></author>
    <author><name>Niki Parmar</name></author>
    <link title="pdf" href="http://arxiv.org/pdf/1706.03762v7" rel="related" type="application/pdf"/>
    <link href="http://arxiv.org/abs/1706.03762v7" rel="alternate" type="text/html"/>
    <arxiv:primary_category term="cs.CL" scheme="http://arxiv.org/schemas/atom"/>
    <category term="cs.CL" scheme="http://arxiv.org/schemas/atom"/>
    <category term="cs.LG" scheme="http://arxiv.org/schemas/atom"/>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2401.12345v2</id>
    <updated>2024-02-01T09:00:00Z</updated>
    <published>2024-01-22T18:00:00Z</published>
    <title><![CDATA[Wieferich primes & the “abc” conjecture — an étale café]]></title>
    <summary><![CDATA[We study naïve sets & prove a theorem.]]></summary>
    <author><name>José García</name></author>
    <link href="http://arxiv.org/abs/2401.12345v2" rel="alternate" type="text/html"/>
    <link title="pdf" href="http://arxiv.org/pdf/2401.12345v2" rel="related" type="application/pdf"/>
    <arxiv:doi xmlns:arxiv="http://arxiv.org/schemas/atom">10.1000/example.2401.12345</arxiv:doi>
    <arxiv:primary_category term="math.NT" scheme="http://arxiv.org/schemas/atom"/>
  </entry>
</feed>`;

const ARXIV_EMPTY_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
  <title type="html">ArXiv Query: search_query=all:nonexistenttermxyz</title>
  <id>http://arxiv.org/api/nothing</id>
  <updated>2026-09-11T00:00:00-04:00</updated>
  <opensearch:totalResults>0</opensearch:totalResults>
  <opensearch:startIndex>0</opensearch:startIndex>
  <opensearch:itemsPerPage>10</opensearch:itemsPerPage>
</feed>`;

/** Response-like double for an XML body (house spider-adapter shape). */
function xmlResponse(xml) {
  return {
    ok: true,
    status: 200,
    json: async () => {
      throw new Error("json() must not be called on an Atom feed");
    },
    text: async () => xml,
    headers: { get: () => null },
  };
}

/** Build an adapter with an injected fetch that records every wire call. */
function makeAdapter(xml = ARXIV_ATOM_FEED) {
  const calls = [];
  const descriptor = createArxivDescriptor({
    transport: {
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        return xmlResponse(xml);
      },
    },
  });
  return { adapter: descriptor.create({ env: {} }), calls, descriptor };
}

// ---------------------------------------------------------------------------
// Registry flip — the T2 stub seat must become the real adapter
// ---------------------------------------------------------------------------

describe("arxiv registry wiring — T2 stub seat flips to the real adapter", () => {
  it("BUILT_IN_PROVIDER_DESCRIPTORS arxiv descriptor creates an adapter (stub seat throws)", () => {
    // GROUND: TASKS T3 adapter bullet; anchor registry.ts import pattern.
    // The T2 seat's create() throws "not yet implemented"; after T3 the
    // registry must carry the real provider/arxiv/adapter.js descriptor.
    const seat = BUILT_IN_PROVIDER_DESCRIPTORS.find((d) => d.id === "arxiv");
    assert.ok(seat, "arxiv descriptor must be in BUILT_IN_PROVIDER_DESCRIPTORS");
    const adapter = seat.create({ env: {} });
    assert.ok(adapter.science, "arxiv adapter must expose the science slot (ProviderAdapter.science)");
    assert.ok(adapter.science.search, "science.search capability must exist");
    assert.ok(adapter.science.get, "science.get capability must exist");
    assert.ok(adapter.diagnostics, "diagnostics capability must exist (D2 round-3)");
  });

  it("arxiv stays keyless: credentialEnvVars is empty (no key model exists, D2 table)", () => {
    const { descriptor } = makeAdapter();
    assert.deepEqual(descriptor.credentialEnvVars, []);
    assert.equal(descriptor.isConfigured({}), true, "keyless supplier is configured with an empty env");
  });
});

// ---------------------------------------------------------------------------
// Control rejection — arXiv rejects all four controls (D7 + D7 amendment)
// ---------------------------------------------------------------------------

describe("arxiv search validate — full control rejection (TASKS T3; DESIGN D7; PRD AC-3)", () => {
  it("rejects each of the four controls with UnsupportedOptionError before any transport call", () => {
    // GROUND: TASKS T3 "rejects all four controls"; DESIGN D7 table's
    // arxiv column (reject, reject, reject, reject) + D7 amendment (year
    // rejection: submittedDate is not publication year — different
    // meaning, so honest rejection, never post-filter).
    const { adapter, calls } = makeAdapter();
    assert.ok(adapter.science);
    for (const option of ["author", "year", "venue", "type"]) {
      assert.throws(
        () =>
          adapter.science.search.validate({
            query: "attention",
            controls: { [option]: option === "year" ? "2020" : "x" },
          }),
        (e) =>
          e instanceof UnsupportedOptionError &&
          e.provider === "arxiv" &&
          e.option === option,
        `controls.${option} must be rejected`,
      );
    }
    assert.equal(calls.length, 0, "validation must reject before any transport call");
  });

  it("accepts a plain query with no controls, and rejects an empty query with ValidationError", () => {
    // GROUND: DESIGN D1 shared validator (query non-whitespace) reached
    // through the adapter's validate delegation.
    const { adapter } = makeAdapter();
    assert.doesNotThrow(() => adapter.science.search.validate({ query: "attention" }));
    assert.throws(
      () => adapter.science.search.validate({ query: "   " }),
      (e) => e instanceof ValidationError,
    );
  });
});

// ---------------------------------------------------------------------------
// Parser + ScienceWork mapping pins (real feed slice; PRD AC-7d)
// ---------------------------------------------------------------------------

describe("arxiv search invoke — Atom parse + ScienceWork mapping (TASKS T3; DESIGN D3; PRD AC-7d)", () => {
  it("maps the first entry field-for-field: title, url, arxivId, authors, year, summary, pdfUrl, type, updated", async () => {
    const { adapter, calls } = makeAdapter();
    const works = await adapter.science.search.invoke({ query: "attention" });

    // Wire: arXiv Atom query endpoint, GET with search params.
    assert.equal(calls.length, 1, "exactly one wire call per search invoke");
    const wireUrl = new URL(calls[0].url);
    assert.equal(
      wireUrl.origin + wireUrl.pathname,
      "https://export.arxiv.org/api/query",
      "arXiv wire base URL (DESIGN D2 table)",
    );
    assert.ok(
      wireUrl.searchParams.get("search_query")?.includes("attention"),
      "query rides the search_query param",
    );

    assert.equal(works.length, 2, "both fixture entries parse");
    const w = works[0];
    assert.equal(w.title, "Attention Is All You Need");
    // rel="alternate" href is the work's landing url (not the pdf link).
    assert.equal(w.url, "http://arxiv.org/abs/1706.03762v7");
    // arxivId is version-stripped so it round-trips the bare grammar
    // (parseScienceIdentifier: ^\d{4}\.\d{4,5}$ — "v7" is not legal).
    assert.equal(w.identifiers?.arxivId, "1706.03762");
    assert.equal(w.identifiers?.doi, undefined, "no arxiv:doi in entry 1 — absent, not null");
    assert.deepEqual(w.authors, ["Ashish Vaswani", "Noam Shazeer", "Niki Parmar"]);
    assert.equal(w.year, 2017, "year from <published>");
    assert.equal(
      w.summary,
      "The dominant sequence transduction models are based on complex recurrent or convolutional neural networks that include at least two neural-network-based components.",
      "summary trimmed (real feeds pad with surrounding whitespace)",
    );
    assert.equal(w.pdfUrl, "http://arxiv.org/pdf/1706.03762v7", "rel=related title=pdf link");
    assert.equal(w.type, "cs.CL", "primary_category term — NOT the second <category> (cs.LG)");
    assert.equal(w.updated, "2023-08-02T00:41:18Z");
    // PRD AC-7c honesty: the arXiv Atom feed carries no citation data —
    // citationCount stays absent rather than fabricated.
    assert.equal(w.citationCount, undefined);
    // Teeth for the absent-key contract: assert.equal(…, undefined) also
    // passes an explicit `citationCount: undefined` key, but that shape
    // would survive a deepEqual pin. Key-presence must be false outright.
    assert.equal(
      Object.hasOwn(w, "citationCount"),
      false,
      "citationCount key absent, not undefined-valued",
    );
    assert.equal(Object.hasOwn(w, "venue"), false);
  });

  it("legacy archive/number entry ids keep their slash in arxivId (PRD AC-4b)", async () => {
    // GROUND: PRD AC-4b makes the legacy form (`cs/0501001`) first-class
    // grammar. The arxivIdFromEntryId capture must not stop at the `/`
    // after `/abs/` — `http://arxiv.org/abs/cs/0501001v2` must yield the
    // version-stripped `cs/0501001`, not no identifier at all.
    const LEGACY_FEED = ARXIV_ATOM_FEED.replace(
      "http://arxiv.org/abs/1706.03762v7</id>",
      "http://arxiv.org/abs/cs/0501001v2</id>",
    );
    const { adapter } = makeAdapter(LEGACY_FEED);
    const works = await adapter.science.search.invoke({ query: "legacy" });
    assert.equal(works[0].identifiers?.arxivId, "cs/0501001");
  });

  it("handles CDATA, unicode, per-element namespace redeclaration, and arxiv:doi (entry 2)", async () => {
    const { adapter } = makeAdapter();
    const works = await adapter.science.search.invoke({ query: "wieferich" });
    const w = works[1];
    assert.equal(w.title, "Wieferich primes & the “abc” conjecture — an étale café");
    assert.equal(w.summary, "We study naïve sets & prove a theorem.");
    assert.deepEqual(w.authors, ["José García"]);
    assert.equal(w.identifiers?.doi, "10.1000/example.2401.12345", "arxiv:doi with locally redeclared xmlns");
    assert.equal(w.identifiers?.arxivId, "2401.12345");
    assert.equal(w.identifiers?.pmid, undefined);
    assert.equal(w.year, 2024);
    assert.equal(w.pdfUrl, "http://arxiv.org/pdf/2401.12345v2");
    assert.equal(w.type, "math.NT");
  });

  it("an entry-less feed (feed-level title/id/updated present) maps to an empty array", async () => {
    // GROUND: D3 tokenizer is <entry>-block scoped — feed-level elements
    // must neither crash the parser nor surface as a phantom work.
    const { adapter } = makeAdapter(ARXIV_EMPTY_FEED);
    const works = await adapter.science.search.invoke({ query: "nonexistenttermxyz" });
    assert.deepEqual(works, []);
  });
});

// ---------------------------------------------------------------------------
// science get — identifier grammar + id_list wire + single work
// ---------------------------------------------------------------------------

describe("arxiv get — validate, cache identity, invoke (TASKS T3; DESIGN D1/D6; PRD AC-4b)", () => {
  it("validate accepts arXiv ids (modern + legacy) and rejects out-of-grammar identifiers", () => {
    const { adapter } = makeAdapter();
    assert.doesNotThrow(() => adapter.science.get.validate({ identifier: "1706.03762" }));
    assert.doesNotThrow(() => adapter.science.get.validate({ identifier: "cs/0501001" }));
    assert.throws(
      () => adapter.science.get.validate({ identifier: "doi:10.1038/nature12373" }),
      (e) => e instanceof ValidationError,
      "prefixed doi: is outside the bare grammar",
    );
    assert.throws(
      () => adapter.science.get.validate({ identifier: "not-an-identifier" }),
      (e) => e instanceof ValidationError,
    );
    // GROUND: D10 ruling 3 — a bare DOI or numeric PMID is IN the shared
    // grammar (so the shared validator accepts it) but not servable by
    // arXiv; validate must reject with UNSUPPORTED_OPTION before any
    // transport call. A regression would surface downstream as a
    // confusing 404 ApiError instead of the designed option error.
    const assertUnsupportedIdentifier = (identifier) =>
      assert.throws(
        () => adapter.science.get.validate({ identifier }),
        (e) =>
          e instanceof UnsupportedOptionError &&
          e.provider === "arxiv" &&
          e.option === "identifier",
      );
    assertUnsupportedIdentifier("10.1038/nature12373");
    assertUnsupportedIdentifier("23903748");
  });

  it("invoke fetches id_list and returns ONE normalized work", async () => {
    const { adapter, calls } = makeAdapter();
    const work = await adapter.science.get.invoke({ identifier: "1706.03762" });
    const wireUrl = new URL(calls[0].url);
    assert.equal(wireUrl.origin + wireUrl.pathname, "https://export.arxiv.org/api/query");
    assert.equal(wireUrl.searchParams.get("id_list"), "1706.03762");
    assert.equal(work.title, "Attention Is All You Need");
    assert.equal(work.identifiers?.arxivId, "1706.03762");
  });
});

// ---------------------------------------------------------------------------
// Cache identity — keyless empty fingerprint (D1 + D4b note)
// ---------------------------------------------------------------------------

describe("arxiv cache identity — empty credentialFingerprint (TASKS T3; DESIGN D1 + D4b note)", () => {
  it("search identity: supplier arxiv, capability science.search, fingerprint \"\", request echoed", () => {
    // GROUND: TASKS T3 "cache identity (empty fingerprint)"; D2 table —
    // arXiv has NO key model, so the fingerprint is always "".
    const { adapter } = makeAdapter();
    const request = { query: "attention", controls: {} };
    const identity = adapter.science.search.cacheIdentity(request);
    assert.equal(identity.supplier, "arxiv");
    assert.equal(identity.capability, "science.search");
    assert.equal(identity.credentialFingerprint, "");
    assert.deepEqual(identity.request, request);
  });

  it("get identity: capability science.get, fingerprint \"\", identifier echoed", () => {
    const { adapter } = makeAdapter();
    const identity = adapter.science.get.cacheIdentity({ identifier: "1706.03762" });
    assert.equal(identity.supplier, "arxiv");
    assert.equal(identity.capability, "science.get");
    assert.equal(identity.credentialFingerprint, "");
    assert.deepEqual(identity.request, { identifier: "1706.03762" });
  });
});

// ---------------------------------------------------------------------------
// Diagnostics — keyless bounded probe smoke (D2 round-3)
// ---------------------------------------------------------------------------

describe("arxiv diagnostics — keyless bounded probe (TASKS T3; DESIGN D2 round-3; PRD AC-5)", () => {
  it("probe:false resolves without touching the network", async () => {
    const { adapter, calls } = makeAdapter();
    await adapter.diagnostics.invoke({ probe: false });
    assert.equal(calls.length, 0);
  });

  it("probe:true makes exactly ONE keyless bounded wire call (max_results=1) on an empty env", async () => {
    // GROUND: D2 round-3 — doctor probes every always-configured
    // supplier; the probe is "a minimal wire call, e.g. arxiv
    // max_results=1". Keyless: no credential env exists to set.
    const { adapter, calls } = makeAdapter();
    await adapter.diagnostics.invoke({ probe: true });
    assert.equal(calls.length, 1, "exactly one wire call");
    const wireUrl = new URL(calls[0].url);
    assert.equal(wireUrl.origin + wireUrl.pathname, "https://export.arxiv.org/api/query");
    assert.equal(wireUrl.searchParams.get("max_results"), "1", "bounded probe");
  });

  it("a failing probe rejects (never resolves silently)", async () => {
    const descriptor = createArxivDescriptor({
      transport: {
        fetch: async () => {
          throw new Error("boom");
        },
      },
    });
    const adapter = descriptor.create({ env: {} });
    await assert.rejects(adapter.diagnostics.invoke({ probe: true }));
  });
});

// ---------------------------------------------------------------------------
// 429 pin — keyless rate-limit must surface as QuotaError, not ApiError (D4b)
// ---------------------------------------------------------------------------

describe("arXiv 429 — keyless rate limit maps to QuotaError (DESIGN D4b honest class)", () => {
  it("a 429 response rejects with QuotaError and statusCode 429 on search invoke", async () => {
    const descriptor = createArxivDescriptor({
      transport: {
        fetch: async () => ({ ok: false, status: 429, text: async () => "" }),
      },
    });
    const adapter = descriptor.create({ env: {} });
    await assert.rejects(
      adapter.science.search.invoke({ query: "x" }),
      (e) => e instanceof QuotaError && e.statusCode === 429,
    );
  });
});
