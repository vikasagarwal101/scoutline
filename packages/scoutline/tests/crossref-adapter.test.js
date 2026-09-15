/**
 * Crossref adapter — T4b RED tests (TASKS T4b; DESIGN D2/D7/D10; PRD AC-3,
 * AC-4, AC-4b, AC-5, AC-6b, AC-7c, AC-7d, AC-8).
 *
 * GROUND map (per describe below):
 *   - TASKS T4b: "JSON client; author/year/venue/type wire-consumed" /
 *     DESIGN D2 supplier table (crossref row: wire
 *     `https://api.crossref.org/works`, JSON, mailto polite pool 3/s) +
 *     DESIGN D7 table crossref column (`query.author=`,
 *     `filter=from-pub-date`, `query.container-title=`, `filter=type:`).
 *   - TASKS T4b: "component junk filter" / PRD AC-4 ("type: component
 *     results never surface (default junk filter)") + AC-8 (full
 *     junk-tier handling beyond the default filter is NOT in v1 — the
 *     pin is exactly the component drop, nothing more).
 *   - TASKS T4b: "`is-referenced-by-count` → citationCount" / PRD AC-7d
 *     (verbatim wire pin; Crossref works evidence: DOI/title/author/
 *     container-title/is-referenced-by-count) + AC-7c ("summary
 *     honestly absent when the supplier carries none (Crossref)").
 *   - TASKS T4b: "House `USER_AGENT` carrying mailto (polite pool, D2);
 *     tests assert the UA on the wire" / DESIGN D2 politeness bullet —
 *     crossref sends its mailto-bearing UA so it lands in the polite
 *     pool; credentialEnvVars stays `[]` (mailto is politeness, not a
 *     credential).
 *   - TASKS T4b: "type-VALUE mapping pin (D7 translation table column —
 *     e.g. article→journal-article)" / DESIGN D7 audit round-2 table,
 *     crossref column (journal-article / posted-content /
 *     proceedings-article / book-chapter / dataset / review-article /
 *     other). Unlike openalex, crossref consumes ALL seven union
 *     values — no rejection row for it.
 *   - TASKS T4b: "`diagnostics.ts` keyless probe (D2 round-3)" / DESIGN
 *     D2 round-3 ruling (doctor probes every always-configured
 *     supplier; the probe is ONE minimal keyless wire call).
 *   - Registry flip: the T2 stub seat's create() throws ("not yet
 *     implemented"); T4b wires the real adapter (registry.ts import
 *     pattern — arXiv/OpenAlex precedent).
 *   - DESIGN D10 ruling 3 (identifier routing): DOI routes to all
 *     suppliers except arxiv (crossref included); PMID routes to
 *     openalex + europepmc + pubmed ONLY — so crossref serves DOI gets
 *     and rejects PMID/arXiv ids at validate.
 *
 * Tests import ../dist/... — verification order is build, then test.
 * No real network: transport fetch is injected (house pattern from
 * tests/openalex-adapter.test.js).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";

import { MAX_BUFFERED_RESPONSE_BYTES } from "../dist/lib/bounded-body.js";

import { createCrossrefDescriptor } from "../dist/providers/crossref/adapter.js";
import { BUILT_IN_PROVIDER_DESCRIPTORS } from "../dist/providers/registry.js";
import {
  ApiError,
  QuotaError,
  TimeoutError,
  UnsupportedOptionError,
  ValidationError,
} from "../dist/lib/errors.js";

// ---------------------------------------------------------------------------
// Fixture — real-shape Crossref works JSON (PRD AC-7d verbatim wire
// evidence column: DOI/title/author/container-title/is-referenced-by-count).
// Traps baked in on purpose: a `type: "component"` junk record between
// two real works (AC-4 default filter must drop it), a posted-content
// record with NO author key and an EMPTY container-title array (absent
// supplier fields stay absent — AC-7c honesty), and title as an ARRAY
// (Crossref ships titles as arrays; ScienceWork.title is a string).
// ---------------------------------------------------------------------------

const WORK_JOURNAL_ARTICLE = {
  DOI: "10.1038/nature12373",
  title: ["Deep learning"],
  author: [
    { given: "Yann", family: "LeCun", sequence: "first", affiliation: [] },
    { given: "Yoshua", family: "Bengio", sequence: "additional", affiliation: [] },
    { given: "Geoffrey", family: "Hinton", sequence: "additional", affiliation: [] },
  ],
  "container-title": ["Nature"],
  "is-referenced-by-count": 44913,
  type: "journal-article",
  issued: { "date-parts": [[2015, 6]] },
  URL: "https://doi.org/10.1038/nature12373",
  publisher: "Springer Science and Business Media LLC",
  ISSN: ["0028-0836"],
  volume: "521",
  issue: "7553",
  page: "436-444",
};

/** Crossref junk record: a figure/table component riding a real DOI. */
const WORK_COMPONENT = {
  DOI: "10.1038/nature12373.fig1",
  title: ["Deep learning Figure 1 data"],
  author: [],
  "container-title": [],
  "is-referenced-by-count": 0,
  type: "component",
  issued: { "date-parts": [[2015, 6]] },
  URL: "https://doi.org/10.1038/nature12373.fig1",
};

/** Posted-content record with NO author key and empty container-title. */
const WORK_PREPRINT = {
  DOI: "10.1101/2020.11.30.402601",
  title: ["Graph attention networks"],
  "container-title": [],
  "is-referenced-by-count": 12,
  type: "posted-content",
  issued: { "date-parts": [[2020, 11]] },
  URL: "https://doi.org/10.1101/2020.11.30.402601",
};

const CROSSREF_SEARCH_RESPONSE = {
  status: "ok",
  "message-type": "work-list",
  "message-version": "1.0.0",
  message: {
    "total-results": 3,
    "items-per-page": 20,
    query: { "search-terms": "deep learning", "start-index": 0 },
    items: [WORK_JOURNAL_ARTICLE, WORK_COMPONENT, WORK_PREPRINT],
  },
};

const CROSSREF_EMPTY_RESPONSE = {
  status: "ok",
  "message-type": "work-list",
  "message-version": "1.0.0",
  message: { "total-results": 0, items: [] },
};

const CROSSREF_WORK_RESPONSE = {
  status: "ok",
  "message-type": "work",
  "message-version": "1.0.0",
  message: WORK_JOURNAL_ARTICLE,
};

/** Response-like double for a JSON body (house pattern). */
function jsonResponse(obj) {
  const payload = JSON.stringify(obj);
  return {
    ok: true,
    status: 200,
    body: Readable.toWeb(Readable.from([Buffer.from(payload)])),
    json: async () => obj,
    text: async () => payload,
    headers: { get: () => null },
  };
}

/** Decoded full URL — query encoding (`:`→%3A) must not hide wire params. */
function decodedUrl(url) {
  return decodeURIComponent(String(url));
}

/** Build an adapter with an injected fetch that records every wire call. */
function makeAdapter(json = CROSSREF_SEARCH_RESPONSE, env = {}) {
  const calls = [];
  const descriptor = createCrossrefDescriptor({
    transport: {
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        return jsonResponse(json);
      },
    },
  });
  return { adapter: descriptor.create({ env }), calls, descriptor };
}

// ---------------------------------------------------------------------------
// Registry flip — the T2 stub seat must become the real adapter
// ---------------------------------------------------------------------------

describe("crossref registry wiring — T2 stub seat flips to the real adapter", () => {
  it("BUILT_IN_PROVIDER_DESCRIPTORS crossref descriptor creates an adapter (stub seat throws)", () => {
    // GROUND: TASKS T4b adapter bullet; registry.ts import pattern
    // (arXiv/OpenAlex precedent). The T2 seat's create() throws "not yet
    // implemented"; after T4b the registry must carry the real
    // providers/crossref/adapter.js descriptor.
    const seat = BUILT_IN_PROVIDER_DESCRIPTORS.find((d) => d.id === "crossref");
    assert.ok(seat, "crossref descriptor must be in BUILT_IN_PROVIDER_DESCRIPTORS");
    const adapter = seat.create({ env: {} });
    assert.ok(
      adapter.science,
      "crossref adapter must expose the science slot (ProviderAdapter.science)",
    );
    assert.ok(adapter.science.search, "science.search capability must exist");
    assert.ok(adapter.science.get, "science.get capability must exist");
    assert.ok(adapter.diagnostics, "diagnostics capability must exist (D2 round-3)");
  });

  it("crossref has NO key model: credentialEnvVars is exactly [] (mailto is politeness, not a credential)", () => {
    // GROUND: DESIGN D2 credentialEnvVars bullet — `[]` for crossref
    // ("crossref's `mailto` is politeness, not a credential"); D2
    // supplier table (mailto polite pool, no key tier). The real
    // descriptor preserves the T2 seat's keyless rulings (AC-5 round 5
    // scope pin: isConfigured keyless-true only for the no-capability
    // form and science/diagnostics — never `quota`).
    const { descriptor } = makeAdapter();
    assert.deepEqual(descriptor.credentialEnvVars, []);
    assert.equal(
      descriptor.isConfigured({}),
      true,
      "keyless supplier is configured with an empty env",
    );
    assert.equal(
      descriptor.isConfigured({}, "quota"),
      false,
      "quota dashboard filter must never list science suppliers (AC-5)",
    );
    assert.equal(descriptor.isConfigured({}, "science.search"), true);
  });
});

// ---------------------------------------------------------------------------
// Controls — author/year/venue/type ALL wire-consumed (D7 crossref column)
// ---------------------------------------------------------------------------

describe("crossref search validate/invoke — all four controls on the wire (TASKS T4b; DESIGN D7; PRD AC-3)", () => {
  it("author + year + venue + type are wire-consumed together on ONE works call", async () => {
    // GROUND: TASKS T4b "author/year/venue/type wire-consumed"; DESIGN
    // D7 table crossref column: `query.author=`,
    // `filter=from-pub-date`, `query.container-title=`, `filter=type:`.
    // Crossref is the ONLY v1 supplier consuming venue (D7 venue
    // ruling: openalex rejects, `--venue` is crossref-only). One
    // search = one logical query = one wire call.
    const { adapter, calls } = makeAdapter();
    await adapter.science.search.invoke({
      query: "attention",
      controls: {
        author: "Vaswani",
        year: "2018:2022",
        venue: "Nature",
        type: "article",
      },
    });
    assert.equal(calls.length, 1, "exactly one wire call per search invoke");
    const wireUrl = new URL(calls[0].url);
    assert.equal(
      wireUrl.origin + wireUrl.pathname,
      "https://api.crossref.org/works",
      "Crossref wire base URL (DESIGN D2 supplier table — api.crossref.org, not audio.crossref.org)",
    );
    const wire = decodedUrl(calls[0].url);
    assert.ok(wire.includes("attention"), "query rides the wire");
    assert.ok(
      wire.includes("query.author=Vaswani"),
      "author control maps to query.author (D7 crossref column)",
    );
    assert.ok(
      wire.includes("from-pub-date:2018"),
      "year range start maps to filter from-pub-date (D7 crossref column)",
    );
    assert.ok(
      wire.includes("until-pub-date:2022"),
      "year range end maps to Crossref's documented until-pub-date to-side",
    );
    assert.ok(
      wire.includes("query.container-title=Nature"),
      "venue control maps to query.container-title (D7 crossref column — the venue-capable supplier)",
    );
    assert.ok(
      wire.includes("type:journal-article"),
      "type control maps to the filter type: with the crossref wire literal (D7 round-2 table)",
    );
  });

  it("single-year control maps to the same-year from/until pair", async () => {
    // GROUND: DESIGN D7 year row; PRD AC-7b single year "2020" is one
    // of the two closed forms.
    const { adapter, calls } = makeAdapter();
    await adapter.science.search.invoke({
      query: "attention",
      controls: { year: "2020" },
    });
    const wire = decodedUrl(calls[0].url);
    assert.ok(wire.includes("from-pub-date:2020"), "single year → from-pub-date");
    assert.ok(wire.includes("until-pub-date:2020"), "single year → until-pub-date (closed form)");
  });

  it("an empty query and a reversed year range throw ValidationError through the adapter's validate", () => {
    // GROUND: DESIGN D1 shared validator (query non-whitespace; year
    // closed forms) reached through the adapter's validate delegation.
    const { adapter } = makeAdapter();
    assert.doesNotThrow(() => adapter.science.search.validate({ query: "attention" }));
    assert.throws(
      () => adapter.science.search.validate({ query: "   " }),
      (e) => e instanceof ValidationError,
    );
    assert.throws(
      () =>
        adapter.science.search.validate({ query: "attention", controls: { year: "2022:2018" } }),
      (e) => e instanceof ValidationError,
      "reversed range is rejected at validate (PRD AC-7b)",
    );
  });
});

// ---------------------------------------------------------------------------
// Type VALUE translation — D7 round-2 table, crossref column
// ---------------------------------------------------------------------------

describe("crossref type-VALUE mapping (TASKS T4b; DESIGN D7 translation table; PRD AC-7)", () => {
  it("union vocabulary maps to the crossref wire literals column — all seven values consumed", async () => {
    // GROUND: TASKS T4b "type-VALUE mapping pin (D7 translation table
    // column — e.g. article→journal-article)". The type VALUE is
    // rewritten per supplier (AC-7d discipline applied to type VALUES).
    // Crossref column: article→journal-article, preprint→posted-content,
    // conference-paper→proceedings-article, chapter→book-chapter,
    // dataset→dataset, review→review-article, other→other. Unlike
    // openalex, crossref carries a literal for conference-paper — no
    // rejection row.
    const cases = [
      ["article", "type:journal-article"],
      ["preprint", "type:posted-content"],
      ["conference-paper", "type:proceedings-article"],
      ["chapter", "type:book-chapter"],
      ["dataset", "type:dataset"],
      ["review", "type:review-article"],
      ["other", "type:other"],
    ];
    for (const [unionValue, wireLiteral] of cases) {
      const { adapter, calls } = makeAdapter();
      await adapter.science.search.invoke({
        query: "attention",
        controls: { type: unionValue },
      });
      assert.equal(calls.length, 1, "one wire call per type mapping probe");
      assert.ok(
        decodedUrl(calls[0].url).includes(wireLiteral),
        `union type "${unionValue}" must map to wire literal "${wireLiteral}"`,
      );
    }
  });

  it("unknown type value is rejected at validate, before any transport call (no accept-and-drop)", async () => {
    const { adapter, calls } = makeAdapter();
    assert.throws(
      () => adapter.science.search.validate({ query: "x", controls: { type: "bogus" } }),
      (e) =>
        e instanceof UnsupportedOptionError && e.provider === "crossref" && e.option === "type",
    );
    await assert.rejects(
      adapter.science.search.invoke({ query: "x", controls: { type: "bogus" } }),
    );
    assert.equal(calls.length, 0, "rejection before any transport call");
  });
});

// ---------------------------------------------------------------------------
// Mapping pins + component junk filter — ScienceWork field-for-field
// ---------------------------------------------------------------------------

describe("crossref search invoke — JSON mapping to ScienceWork (TASKS T4b; PRD AC-7d/AC-7c)", () => {
  it("maps the journal article field-for-field: title (array→string), url, bare doi, authors, year, venue, citationCount, type", async () => {
    // GROUND: PRD AC-7d — "Wire shapes verbatim-pinned: … Crossref
    // `is-referenced-by-count`→`citationCount`" plus the works evidence
    // column (DOI/title/author/container-title). Titles and
    // container-titles arrive as ARRAYS; ScienceWork carries strings.
    const { adapter, calls } = makeAdapter();
    const works = await adapter.science.search.invoke({ query: "deep learning" });
    assert.equal(calls.length, 1, "exactly one wire call per search invoke");
    // AC-4 junk filter: the component record between the two real
    // works must NOT surface, so only two works parse.
    assert.equal(works.length, 2, "component junk filtered; two real works remain");

    const w = works[0];
    assert.equal(w.title, "Deep learning", "title array → first string");
    assert.equal(w.url, "https://doi.org/10.1038/nature12373", "URL field → url");
    assert.equal(w.identifiers?.doi, "10.1038/nature12373", "DOI field → bare identifiers.doi");
    assert.deepEqual(
      w.authors,
      ["Yann LeCun", "Yoshua Bengio", "Geoffrey Hinton"],
      "author given+family → joined display strings",
    );
    assert.equal(w.year, 2015, "issued.date-parts[0][0] → year");
    assert.equal(w.venue, "Nature", "container-title[0] → venue");
    assert.equal(
      w.citationCount,
      44913,
      "is-referenced-by-count → citationCount (AC-7d verbatim pin)",
    );
    assert.equal(w.type, "journal-article", "type rides through on the record");
    // AC-7c honesty teeth: Crossref carries no abstracts — summary is
    // honestly absent, never undefined-valued and never fabricated.
    assert.equal(
      Object.hasOwn(w, "summary"),
      false,
      "summary honestly absent (AC-7c — Crossref carries no abstracts)",
    );
    assert.equal(Object.hasOwn(w, "pdfUrl"), false, "no pdf link in fixture → pdfUrl key absent");
  });

  it('component junk filter: type:"component" records NEVER surface (default filter, nothing more)', async () => {
    // GROUND: TASKS T4b "component junk filter"; PRD AC-4 — "type:
    // component results never surface (default junk filter)"; AC-8 —
    // the default filter is exactly the component drop (full junk-tier
    // handling is NOT in v1, so no other record class is filtered).
    const { adapter } = makeAdapter();
    const works = await adapter.science.search.invoke({ query: "deep learning" });
    const titles = works.map((w) => w.title);
    assert.equal(
      titles.includes("Deep learning Figure 1 data"),
      false,
      "the component record must be dropped by the default junk filter (AC-4)",
    );
    assert.deepEqual(
      titles,
      ["Deep learning", "Graph attention networks"],
      "every NON-component record still surfaces (AC-8: no over-filtering)",
    );
  });

  it("absent author key and empty container-title stay absent — never empty-array venue, never fabricated authors", async () => {
    // GROUND: PRD AC-7c honesty (absent supplier fields stay absent)
    // applied to the posted-content record: no `author` key at all and
    // `container-title: []`.
    const { adapter } = makeAdapter();
    const works = await adapter.science.search.invoke({ query: "graph attention" });
    const w = works.find((x) => x.title === "Graph attention networks");
    assert.ok(w, "posted-content record present after junk filter");
    assert.equal(Object.hasOwn(w, "authors"), false, "absent author key → authors key absent");
    assert.equal(Object.hasOwn(w, "venue"), false, "empty container-title → venue key absent");
    assert.equal(w.identifiers?.doi, "10.1101/2020.11.30.402601");
    assert.equal(w.citationCount, 12);
  });

  it("an empty items response maps to an empty array", async () => {
    const { adapter } = makeAdapter(CROSSREF_EMPTY_RESPONSE);
    const works = await adapter.science.search.invoke({ query: "nonexistenttermxyz" });
    assert.deepEqual(works, []);
  });
});

// ---------------------------------------------------------------------------
// science get — DOI entity route only (DESIGN D10 ruling 3)
// ---------------------------------------------------------------------------

describe("crossref get — DOI identifier only (TASKS T4b; DESIGN D10 ruling 3; PRD AC-2/AC-4b)", () => {
  it("get by bare DOI: one wire call addressing the works entity route, one normalized work", async () => {
    // GROUND: DESIGN D10 ruling 3 — "DOI direct get … DOI routes to all
    // except arxiv": crossref serves DOI gets via the documented
    // entity route `https://api.crossref.org/works/{doi}` (the
    // message-type:"work" single-record response). One
    // identifier-addressed call, not a search.
    const { adapter, calls } = makeAdapter(CROSSREF_WORK_RESPONSE);
    const work = await adapter.science.get.invoke({ identifier: "10.1038/nature12373" });
    assert.equal(calls.length, 1, "exactly one wire call for get");
    assert.equal(
      decodeURIComponent(new URL(calls[0].url).pathname),
      "/works/10.1038/nature12373",
      "DOI get addresses the entity route /works/<doi> (D10 ruling 3)",
    );
    assert.equal(work.title, "Deep learning");
    assert.equal(work.identifiers?.doi, "10.1038/nature12373");
    assert.equal(work.citationCount, 44913);
    assert.equal(
      Object.hasOwn(work, "summary"),
      false,
      "single-work mapping keeps the AC-7c honesty (no abstract on crossref)",
    );
  });

  it("get by a component DOI obeys the junk policy — ApiError 404, never the component record (review)", async () => {
    // Review: the direct-get path bypassed the search-side
    // isComponentJunk filter, so `science get` on a component DOI
    // returned the component. Same policy, same 404 no-work behavior.
    const { adapter } = makeAdapter({
      status: "ok",
      "message-type": "work",
      "message-version": "1.0.0",
      message: WORK_COMPONENT,
    });
    await assert.rejects(
      adapter.science.get.invoke({ identifier: "10.1038/nature12373.fig1" }),
      (e) => e instanceof ApiError && e.statusCode === 404,
      "component DOI get must be the 404 no-work error",
    );
  });

  it("get double-encodes dot-only path segments so `..` cannot traverse (review round 6)", async () => {
    // Review: `new URL` normalizes an unencoded `..` segment away —
    // /works/10.1234/../work addressed /works/work. The segment must
    // survive as %252E-encoded.
    const { adapter, calls } = makeAdapter(CROSSREF_WORK_RESPONSE);
    await adapter.science.get.invoke({ identifier: "10.1234/../work" });
    assert.equal(calls.length, 1);
    assert.equal(
      new URL(calls[0].url).pathname,
      "/works/10.1234/%252E%252E/work",
      "dot-only segments ride double-encoded",
    );
  });

  it("get percent-encodes URL-delimiter characters in the DOI path (review)", async () => {
    // Review: a DOI suffix containing `?` or `#` was truncated into the
    // query/fragment by `new URL` — the wire addressed the WRONG
    // resource. The path must carry the characters percent-encoded.
    const { adapter, calls } = makeAdapter(CROSSREF_WORK_RESPONSE);
    await adapter.science.get.invoke({ identifier: "10.1038/nature12373?fig#1" });
    assert.equal(calls.length, 1);
    assert.equal(
      new URL(calls[0].url).pathname,
      "/works/10.1038/nature12373%3Ffig%231",
      "DOI path delimiters must ride percent-encoded",
    );
  });

  it("validate rejects PMID and arXiv ids (UnsupportedOptionError); out-of-grammar throws ValidationError", () => {
    // GROUND: DESIGN D10 ruling 3 — "PMID routes to openalex +
    // europepmc + pubmed" (crossref is NOT in the PMID set); DOI to
    // all except arxiv (crossref included). ArXiv ids likewise route
    // to the arxiv adapter only. A bare PMID passes the shared grammar
    // but is not servable by crossref → UnsupportedOptionError (openalex
    // precedent for the identifier option); out-of-grammar strings
    // throw the shared ValidationError (D1).
    const { adapter } = makeAdapter();
    assert.doesNotThrow(() => adapter.science.get.validate({ identifier: "10.1038/nature12373" }));
    assert.throws(
      () => adapter.science.get.validate({ identifier: "23903748" }),
      (e) =>
        e instanceof UnsupportedOptionError &&
        e.provider === "crossref" &&
        e.option === "identifier",
      "PMID does not route to crossref (D10 ruling 3)",
    );
    assert.throws(
      () => adapter.science.get.validate({ identifier: "2401.12345" }),
      (e) => e instanceof UnsupportedOptionError && e.provider === "crossref",
      "arXiv id does not route to crossref (D10 ruling 3)",
    );
    assert.throws(
      () => adapter.science.get.validate({ identifier: "doi:10.1038/nature12373" }),
      (e) => e instanceof ValidationError,
      "prefixed doi: is outside the bare grammar",
    );
  });
});

// ---------------------------------------------------------------------------
// Cache identity — always keyless "" (no key model exists, D2)
// ---------------------------------------------------------------------------

describe('crossref cache identity — always keyless "" (TASKS T4b; DESIGN D1 + D4b note; PRD AC-6b)', () => {
  it('search identity: supplier crossref, capability science.search, fingerprint "", request echoed', () => {
    // GROUND: DESIGN D4b note — keyless `""` fingerprint is the seed-18
    // Q4 ruling (keyless responses are user-independent). Crossref has
    // no key model at all (D2 table), so the fingerprint is ALWAYS ""
    // — there is no keyed partition to re-partition into.
    const { adapter } = makeAdapter();
    const request = { query: "attention", controls: {} };
    const identity = adapter.science.search.cacheIdentity(request);
    assert.equal(identity.supplier, "crossref");
    assert.equal(identity.capability, "science.search");
    assert.equal(identity.credentialFingerprint, "");
    assert.deepEqual(identity.request, request);
  });

  it('get identity: capability science.get, fingerprint "", identifier echoed', () => {
    const { adapter } = makeAdapter();
    const identity = adapter.science.get.cacheIdentity({ identifier: "10.1038/nature12373" });
    assert.equal(identity.supplier, "crossref");
    assert.equal(identity.capability, "science.get");
    assert.equal(identity.credentialFingerprint, "");
    assert.deepEqual(identity.request, { identifier: "10.1038/nature12373" });
  });
});

// ---------------------------------------------------------------------------
// Politeness — house USER_AGENT carrying mailto (polite pool, D2)
// ---------------------------------------------------------------------------

describe("crossref wire politeness — house USER_AGENT carrying mailto (TASKS T4b; DESIGN D2 politeness)", () => {
  it("every request sends the house UA with the mailto contact on the wire (polite pool)", async () => {
    // GROUND: TASKS T4b — "House `USER_AGENT` carrying mailto (polite
    // pool, D2); tests assert the UA on the wire"; DESIGN D2
    // politeness bullet — "crossref sends its mailto-bearing UA/param
    // so both land in the polite pool, not the rude one". The UA must
    // be the house `scoutline/${VERSION}` AND carry a `mailto:`
    // contact; crossref has no key model, so this posture applies to
    // every request unconditionally.
    const { adapter, calls } = makeAdapter();
    await adapter.science.search.invoke({ query: "attention" });
    assert.equal(calls.length, 1);
    const headers = calls[0].init?.headers ?? {};
    const ua = headers["User-Agent"];
    assert.ok(
      typeof ua === "string" && ua.startsWith("scoutline/"),
      "house USER_AGENT on the wire",
    );
    assert.ok(
      typeof ua === "string" && ua.includes("mailto:"),
      "UA carries the mailto contact — polite pool (T4b pin)",
    );
    assert.equal(calls[0].init?.method ?? "GET", "GET");
  });
});

// ---------------------------------------------------------------------------
// Diagnostics — keyless bounded probe smoke (D2 round-3)
// ---------------------------------------------------------------------------

describe("crossref diagnostics — keyless bounded probe (TASKS T4b; DESIGN D2 round-3; PRD AC-5)", () => {
  it("probe:false resolves without touching the network", async () => {
    const { adapter, calls } = makeAdapter();
    await adapter.diagnostics.invoke({ probe: false });
    assert.equal(calls.length, 0);
  });

  it("probe:true makes exactly ONE bounded keyless wire call exercising the SEARCH capability, polite UA included", async () => {
    // GROUND: DESIGN D2 round-3 — doctor probes every always-configured
    // supplier; the probe is ONE minimal keyless wire call on the
    // supplier's endpoint (rows=1 — the cheapest credible liveness
    // check, arXiv max_results=1 precedent). #163: the call exercises
    // the SEARCH capability (query=test) — a bare works list can stay
    // green while the search surface degrades, so a works-list-only
    // probe reports capability health it never tested. The politeness
    // posture applies to it too (house UA carrying mailto).
    const { adapter, calls } = makeAdapter();
    await adapter.diagnostics.invoke({ probe: true });
    assert.equal(calls.length, 1, "exactly one wire call");
    const wireUrl = new URL(calls[0].url);
    assert.equal(
      wireUrl.origin + wireUrl.pathname,
      "https://api.crossref.org/works",
      "probe targets the works endpoint",
    );
    assert.equal(
      wireUrl.searchParams.get("rows"),
      "1",
      "probe is bounded — rows=1, never a full search",
    );
    // #163: the probe must exercise the search capability — a bare
    // works list can stay green while the search surface degrades.
    assert.equal(
      wireUrl.searchParams.get("query"),
      "test",
      "probe exercises the search capability (query= is on the wire)",
    );
    const ua = calls[0].init?.headers?.["User-Agent"];
    assert.ok(
      typeof ua === "string" && ua.startsWith("scoutline/") && ua.includes("mailto:"),
      "keyless probe carries the house UA with the mailto contact",
    );
  });

  it("#163: a degraded search (HTTP 500) on the probe rejects the row — the probe carries the search param", async () => {
    // GROUND: #163 — the probe rides the search capability, so a
    // degraded search on THAT call must surface as a failed row
    // (ApiError 500 → the probe normalizer's ApiError pass-through
    // rethrows). Red on a degraded search is INTENDED: the row
    // reports capability health, not connectivity.
    const probeCalls = [];
    const descriptor = createCrossrefDescriptor({
      transport: {
        fetch: async (url) => {
          probeCalls.push(String(url));
          return { ok: false, status: 500, text: async () => "" };
        },
      },
    });
    const adapter = descriptor.create({ env: {} });
    await assert.rejects(
      adapter.diagnostics.invoke({ probe: true }),
      (e) => e instanceof ApiError && e.statusCode === 500,
      "500 on the probe call rejects as ApiError(500) — a failed doctor row",
    );
    assert.equal(probeCalls.length, 1, "the probe issued the failing call itself");
    assert.equal(
      new URL(probeCalls[0]).searchParams.get("query"),
      "test",
      "the failing call was the search probe, not the bare works list",
    );
  });

  it("a failing probe rejects (never resolves silently)", async () => {
    const descriptor = createCrossrefDescriptor({
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

describe("Crossref 429 — keyless rate limit maps to QuotaError (DESIGN D4b honest class)", () => {
  it("a 429 response rejects with QuotaError and statusCode 429 on search invoke", async () => {
    const descriptor = createCrossrefDescriptor({
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

// ---------------------------------------------------------------------------
// Bounded response execution hardening (#150)
// ---------------------------------------------------------------------------

describe("crossref bounded response execution hardening (#150)", () => {
  it("pre-read rejection: content-length > 50MB ceiling rejects with terminal 413 ApiError and cancels body without reading", async () => {
    let cancelCalled = false;
    let readCalled = false;
    const mockBody = {
      cancel: async () => {
        cancelCalled = true;
      },
      getReader: () => {
        readCalled = true;
        throw new Error("getReader must not be called when content-length exceeds ceiling");
      },
    };
    const descriptor = createCrossrefDescriptor({
      transport: {
        fetch: async () => ({
          ok: true,
          status: 200,
          headers: {
            get: (name) => (name.toLowerCase() === "content-length" ? "55000000" : null),
          },
          body: mockBody,
          json: async () => {
            readCalled = true;
            return {};
          },
          text: async () => {
            readCalled = true;
            return "{}";
          },
        }),
      },
    });
    const adapter = descriptor.create({ env: {} });
    await assert.rejects(
      () => adapter.science.search.invoke({ query: "attention" }),
      (err) => {
        assert.equal(err.code, "API_ERROR");
        assert.equal(err.statusCode, 413);
        assert.match(err.message, /crossref response exceeds.*50MB.*refusing to buffer/i);
        return true;
      },
    );
    assert.equal(cancelCalled, true, "body.cancel() must be called before throwing");
    assert.equal(readCalled, false, "body must never be read when declared size exceeds ceiling");
  });

  it("chunked mid-stream rejection: stream exceeding 50MB ceiling cancels reader and rejects with size error", async () => {
    const totalChunks = 55;
    let chunksYielded = 0;
    let cancelCalled = false;
    async function* generateChunks() {
      try {
        const chunk = Buffer.alloc(1024 * 1024, "x");
        for (let i = 0; i < totalChunks; i++) {
          chunksYielded++;
          yield chunk;
        }
      } finally {
        cancelCalled = true;
      }
    }
    const stream = Readable.toWeb(Readable.from(generateChunks()));
    const descriptor = createCrossrefDescriptor({
      transport: {
        fetch: async () => ({
          ok: true,
          status: 200,
          headers: {
            get: () => null,
          },
          body: stream,
        }),
      },
    });
    const adapter = descriptor.create({ env: {} });
    await assert.rejects(
      () => adapter.science.search.invoke({ query: "attention" }),
      (err) => {
        assert.equal(err.code, "API_ERROR");
        assert.equal(err.statusCode, 413);
        assert.match(err.message, /crossref response exceeds.*50MB.*refusing to buffer/i);
        return true;
      },
    );
    assert.ok(chunksYielded > 50, "should have read past 50MB before rejecting");
    assert.ok(chunksYielded < totalChunks, "stream should stop yielding chunks once cancelled");
    assert.ok(chunksYielded <= 53, "stream should stop yielding chunks once cancelled");
    assert.equal(cancelCalled, true, "body stream must be cancelled");
  });

  it("headerless test double seam: minimal {ok, status, json()} double succeeds (pin a)", async () => {
    const descriptor = createCrossrefDescriptor({
      transport: {
        fetch: async () => ({
          ok: true,
          status: 200,
          json: async () => ({ status: "ok", message: { items: [] } }),
        }),
      },
    });
    const adapter = descriptor.create({ env: {} });
    const works = await adapter.science.search.invoke({ query: "attention" });
    assert.deepEqual(works, []);
  });

  it("parity: content-length declares small size but streamed body exceeds ceiling rejects with terminal 413 ApiError (pin b)", async () => {
    const totalChunks = 55;
    let cancelCalled = false;
    async function* generateChunks() {
      try {
        const chunk = Buffer.alloc(1024 * 1024, "x");
        for (let i = 0; i < totalChunks; i++) {
          yield chunk;
        }
      } finally {
        cancelCalled = true;
      }
    }
    const stream = Readable.toWeb(Readable.from(generateChunks()));
    const descriptor = createCrossrefDescriptor({
      transport: {
        fetch: async () => ({
          ok: true,
          status: 200,
          headers: {
            get: (name) => (name.toLowerCase() === "content-length" ? "1024" : null),
          },
          body: stream,
        }),
      },
    });
    const adapter = descriptor.create({ env: {} });
    await assert.rejects(
      () => adapter.science.search.invoke({ query: "attention" }),
      (err) => {
        assert.equal(err.code, "API_ERROR");
        assert.equal(err.statusCode, 413);
        assert.notEqual(err.code, "VALIDATION_ERROR");
        assert.match(err.message, /crossref response exceeds.*50MB.*refusing to buffer/i);
        assert.doesNotMatch(err.message, /--out/);
        return true;
      },
    );
    assert.equal(cancelCalled, true, "body stream must be cancelled");
  });

  it("BOM-safe JSON parse: leading U+FEFF is stripped and parses successfully (pin c)", async () => {
    const payload = "\uFEFF" + JSON.stringify({
      status: "ok",
      message: {
        items: [WORK_JOURNAL_ARTICLE],
      },
    });
    const descriptor = createCrossrefDescriptor({
      transport: {
        fetch: async () => ({
          ok: true,
          status: 200,
          headers: {
            get: (name) => (name.toLowerCase() === "content-length" ? String(Buffer.byteLength(payload)) : null),
          },
          body: Readable.toWeb(Readable.from([Buffer.from(payload)])),
        }),
      },
    });
    const adapter = descriptor.create({ env: {} });
    const works = await adapter.science.search.invoke({ query: "attention" });
    assert.equal(works.length, 1);
    assert.equal(works[0].title, "Deep learning");
  });

  it("BOM fallback-path parse: text() double returning U+FEFF strips BOM and parses (pin a)", async () => {
    const payload = "\uFEFF" + JSON.stringify({
      status: "ok",
      message: {
        items: [WORK_JOURNAL_ARTICLE],
      },
    });
    const descriptor = createCrossrefDescriptor({
      transport: {
        fetch: async () => ({
          ok: true,
          status: 200,
          headers: {
            get: (name) => (name.toLowerCase() === "content-length" ? String(Buffer.byteLength(payload)) : null),
          },
          text: async () => payload,
        }),
      },
    });
    const adapter = descriptor.create({ env: {} });
    const works = await adapter.science.search.invoke({ query: "attention" });
    assert.equal(works.length, 1);
    assert.equal(works[0].title, "Deep learning");
  });

  it("content-length boundary: declared length exactly equal to 50MB ceiling is allowed (strict >)", async () => {
    const payload = JSON.stringify({
      status: "ok",
      message: { items: [] },
    });
    const descriptor = createCrossrefDescriptor({
      transport: {
        fetch: async () => ({
          ok: true,
          status: 200,
          headers: {
            get: (h) => (h.toLowerCase() === "content-length" ? String(MAX_BUFFERED_RESPONSE_BYTES) : null),
          },
          body: Readable.toWeb(Readable.from([Buffer.from(payload, "utf8")])),
        }),
      },
    });
    const adapter = descriptor.create({ env: {} });
    const result = await adapter.science.search.invoke({ query: "attention" });
    assert.ok(result);
    assert.deepEqual(result, []);
  });

  it("drain replacement: non-ok response cancels body and never buffers via text() or json()", async () => {
    let cancelCalled = false;
    let textCalled = false;
    let jsonCalled = false;
    let readerCalled = false;
    const mockBody = {
      cancel: async () => {
        cancelCalled = true;
      },
      getReader: () => {
        readerCalled = true;
        throw new Error("getReader must not be called on non-ok response");
      },
    };
    const descriptor = createCrossrefDescriptor({
      transport: {
        fetch: async () => ({
          ok: false,
          status: 500,
          headers: { get: () => null },
          body: mockBody,
          text: async () => {
            textCalled = true;
            return "error body";
          },
          json: async () => {
            jsonCalled = true;
            return {};
          },
        }),
      },
    });
    const adapter = descriptor.create({ env: {} });
    await assert.rejects(
      () => adapter.science.search.invoke({ query: "attention" }),
      (err) => {
        assert.equal(err.code, "API_ERROR");
        assert.equal(err.statusCode, 500);
        return true;
      },
    );
    assert.equal(cancelCalled, true, "body.cancel() must be called on non-ok response");
    assert.equal(textCalled, false, "text() must never be called on non-ok response");
    assert.equal(jsonCalled, false, "json() must never be called on non-ok response");
    assert.equal(readerCalled, false, "body stream must not be read on non-ok response");
  });
});

describe("crossref abort signal threading and honest cancellation (#151)", () => {
  it("a pre-aborted caller signal rejects before transport is invoked", async () => {
    let fetchCalls = 0;
    const descriptor = createCrossrefDescriptor({
      transport: {
        fetch: async () => {
          fetchCalls += 1;
          return { ok: true, status: 200, json: async () => ({}) };
        },
      },
    });
    const adapter = descriptor.create({ env: {} });
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(
      adapter.science.search.invoke({ query: "x" }, ac.signal),
      (e) => {
        assert.ok(e instanceof ApiError, `expected ApiError, got ${e?.constructor?.name}`);
        assert.equal(e.statusCode, 499);
        assert.match(e.message, /Crossref request was aborted by the caller/);
        assert.doesNotMatch(e.message, /timed out/i);
        return true;
      },
    );
    assert.equal(fetchCalls, 0, "transport fetch must never be invoked");
  });

  it("external abort mid-flight rejects with honest abort ApiError(499), not TimeoutError", async () => {
    const ac = new AbortController();
    const descriptor = createCrossrefDescriptor({
      transport: {
        fetch: async (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              const err = new Error("aborted");
              err.name = "AbortError";
              reject(err);
            });
          }),
      },
    });
    const adapter = descriptor.create({ env: {} });
    const promise = adapter.science.search.invoke({ query: "x" }, ac.signal);
    ac.abort();
    await assert.rejects(
      promise,
      (e) => {
        assert.ok(e instanceof ApiError, `expected ApiError, got ${e?.constructor?.name}`);
        assert.equal(e.statusCode, 499);
        assert.match(e.message, /Crossref request was aborted by the caller/);
        assert.doesNotMatch(e.message, /timed out/i);
        return true;
      },
    );
  });

  it("external abort during body consumption classifies by abort source, not error shape (review)", async () => {
    // undici may reject an in-flight body read with a raw non-AbortError
    // (`TypeError: terminated`) when the connection is torn down by an
    // abort. The abort SOURCE decides the class — a caller cancel is
    // never a retryable network failure.
    const ac = new AbortController();
    let readStarted = false;
    const descriptor = createCrossrefDescriptor({
      transport: {
        fetch: async () => ({
          ok: true,
          status: 200,
          headers: { get: () => null },
          body: {
            getReader: () => ({
              read: () => {
                readStarted = true;
                return Promise.reject(new TypeError("terminated"));
              },
              cancel: async () => {},
            }),
            cancel: async () => {},
          },
        }),
      },
    });
    const adapter = descriptor.create({ env: {} });
    const promise = adapter.science.search.invoke({ query: "x" }, ac.signal);
    ac.abort();
    await assert.rejects(
      promise,
      (e) => {
        assert.ok(e instanceof ApiError, `expected ApiError, got ${e?.constructor?.name}`);
        assert.equal(e.statusCode, 499);
        assert.equal(e.code, "API_ERROR");
        assert.match(e.message, /Crossref request was aborted by the caller/);
        assert.doesNotMatch(e.message, /timed out/i);
        assert.doesNotMatch(e.message, /network error/i);
        return true;
      },
      "a caller cancel during body consumption is never a NetworkError",
    );
    assert.equal(readStarted, true, "the body read must have been attempted");
  });

  it("a fired timeout during body consumption is never rewritten to a caller cancel (review)", async () => {
    // Guard teeth for the abort-source branch: with the timeout fired,
    // the same raw body-read rejection must NOT wear caller-cancel
    // wording — the abort source decides.
    let timerCallback;
    let rejectRead;
    const readPromise = new Promise((_res, rej) => {
      rejectRead = rej;
    });
    const descriptor = createCrossrefDescriptor({
      transport: {
        fetch: async () => ({
          ok: true,
          status: 200,
          headers: { get: () => null },
          body: {
            getReader: () => ({ read: () => readPromise, cancel: async () => {} }),
            cancel: async () => {},
          },
        }),
        setTimeout: (cb) => {
          timerCallback = cb;
          return 123;
        },
        clearTimeout: () => {},
      },
    });
    const adapter = descriptor.create({ env: {} });
    const promise = adapter.science.search.invoke({ query: "x" });
    assert.ok(timerCallback, "the timeout must be armed before the body read");
    timerCallback();
    rejectRead(new TypeError("terminated"));
    await assert.rejects(
      promise,
      (e) => {
        assert.notEqual(
          e?.statusCode,
          499,
          "a fired timeout is not a caller cancel — the abort source decides",
        );
        assert.doesNotMatch(
          e?.message ?? "",
          /aborted by the caller/i,
          "timeout-abort must not wear caller-cancel wording",
        );
        return true;
      },
    );
  });

  it("internal timer timeout rejects with TimeoutError", async () => {
    let timerCallback;
    const descriptor = createCrossrefDescriptor({
      transport: {
        fetch: async (_url, init) =>
          new Promise((_res, rej) => {
            if (init?.signal?.aborted) {
              const err = new Error("aborted");
              err.name = "AbortError";
              rej(err);
              return;
            }
            init?.signal?.addEventListener("abort", () => {
              const err = new Error("aborted");
              err.name = "AbortError";
              rej(err);
            });
          }),
        setTimeout: (cb) => {
          timerCallback = cb;
          return 123;
        },
        clearTimeout: () => {},
      },
    });
    const adapter = descriptor.create({ env: {} });
    const promise = adapter.science.search.invoke({ query: "x" });
    assert.ok(timerCallback);
    timerCallback();
    await assert.rejects(
      promise,
      (e) => {
        assert.ok(e instanceof TimeoutError, `expected TimeoutError, got ${e?.constructor?.name}`);
        assert.match(e.message, /Request timed out/i);
        return true;
      },
    );
  });
});
