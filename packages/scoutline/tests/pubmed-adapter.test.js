/**
 * PubMed adapter — T4c RED tests (TASKS T4c; DESIGN D2/D4b/D7/D10; PRD AC-3,
 * AC-4b, AC-5, AC-6b, AC-7d, AC-8b).
 *
 * GROUND map (per describe below):
 *   - TASKS T4c: "esearch→efetch two-step internal" / DESIGN D2 pubmed row
 *     (wire base `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/`) + D4
 *     ("PubMed two-step = ONE cache identity (the logical query); adapter
 *     composes esearch+efetch internally") + PRD AC-8b ("PubMed two-step
 *     (esearch→efetch) is the adapter's internal concern; single
 *     `science search` invocation = single logical query, two HTTP calls").
 *
 *     PLAN DEVIATION (RED-agent finding, probe-verified 2026-09-11 against
 *     the live eutils wire — D10's own verify-at-implementation duty):
 *     efetch `retmode=json` returns ONLY the bare id list ("36959025\n"),
 *     not records; esummary `retmode=json` DOES carry title, authors,
 *     venue, and pubtype but NO AbstractText, so neither JSON endpoint
 *     is record-complete. The ONLY record-complete second step is
 *     efetch `retmode=xml` (PubmedArticleSet). Tests below pin
 *     esearch(retmode=json) → efetch(retmode=xml) — two calls, both on the
 *     D2 base. esearch's JSON envelope matches the PRD verbatim wire
 *     evidence ({"esearchresult":{"count":"119",…,"idlist":[…]}}) so that
 *     half of D2 survives verbatim.
 *   - TASKS T4c: "author `[AU]`, year mindate/maxdate; type `pt`; venue
 *     reject" / DESIGN D7 table pubmed column (`[AU]`, `mindate/maxdate`,
 *     `pt`, venue reject) + PRD AC-3 (venue rejected with
 *     UNSUPPORTED_OPTION — never accept-and-drop).
 *   - TASKS T4c: "type-VALUE mapping pin (D7 translation table column —
 *     e.g. article→`journal article`)" / DESIGN D7 round-2 translation
 *     table pubmed `pt` column: journal article / preprint / congress /
 *     book chapter / dataset / review / other.
 *   - TASKS T4c: "`diagnostics.ts` keyless probe (D2 round-3)" / DESIGN
 *     D2 round-3 ruling (doctor probes every always-configured supplier;
 *     ONE minimal keyless wire call).
 *   - Registry flip: the T2 stub seat's create() throws ("not yet
 *     implemented"); T4c wires the real adapter (registry.ts import
 *     pattern — arXiv/OpenAlex/Crossref precedent).
 *   - DESIGN D10 ruling 3 (identifier routing): "PubMed esummary direct"
 *     for PMID; PMID routes to openalex + europepmc + pubmed. Deviation
 *     above applies: the get path may compose the same two-step
 *     (esearch id-restricted / direct-id efetch) instead of esummary;
 *     DOI routes to pubmed via a `[DOI]`-field esearch term (probe: DOI
 *     term → idlist, count=1); arXiv ids do NOT route to pubmed —
 *     UnsupportedOptionError at validate.
 *   - Credential model (DESIGN D2 + D4b note): keyless 3 r/s default;
 *     free `NCBI_API_KEY` lifts to 10 r/s. credentialEnvVars
 *     `["NCBI_API_KEY"]` (registry seat already carries it); cache
 *     fingerprint `""` keyless / SHA-256 hex of the key otherwise
 *     (PRD AC-6b keyed upgrades re-partition).
 *
 * Tests import ../dist/... — verification order is build, then test.
 * No real network: transport fetch is injected (house pattern from
 * tests/openalex-adapter.test.js / crossref-adapter.test.js).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";

import { MAX_BUFFERED_RESPONSE_BYTES } from "../dist/lib/bounded-body.js";

import { createPubmedDescriptor } from "../dist/providers/pubmed/adapter.js";
import { BUILT_IN_PROVIDER_DESCRIPTORS } from "../dist/providers/registry.js";
import { ApiError, QuotaError, TimeoutError, UnsupportedOptionError, ValidationError } from "../dist/lib/errors.js";

// ---------------------------------------------------------------------------
// Fixtures — real-shape eutils responses.
// esearch JSON envelope is the PRD verbatim wire evidence. The efetch XML is
// a minimal real-shape PubmedArticleSet slice (probe 2026-09-11, PMID
// 36959025): PMID, Article/Journal/Title (venue), ArticleTitle,
// ELocationID doi, AuthorList (LastName/ForeName), Language, PublicationType
// (the `pt` vocabulary), PubDate Year, AbstractText. A second record with
// NO AbstractText and NO doi pins the AC-7c absent-stays-absent honesty.
// ---------------------------------------------------------------------------

/** Two records found (esearch step). */
const ESEARCH_TWO = {
  header: { type: "esearch", version: "0.3" },
  esearchresult: {
    count: "2",
    retmax: "2",
    retstart: "0",
    idlist: ["36959025", "31687970"],
    translationset: [],
    querytranslation: "deep learning[AU]",
  },
};

/** Zero records found (esearch step) — short-circuits to no efetch. */
const ESEARCH_ZERO = {
  header: { type: "esearch", version: "0.3" },
  esearchresult: {
    count: "0",
    retmax: "0",
    retstart: "0",
    idlist: [],
  },
};

const PMID_FULL_XML = `<?xml version="1.0" ?>
<!DOCTYPE PubmedArticleSet PUBLIC "-//NLM//DTD PubMedArticle, 1st January 2025//EN" "https://dtd.nlm.nih.gov/ncbi/pubmed/out/pubmed_250101.dtd">
<PubmedArticleSet>
<PubmedArticle><MedlineCitation Status="MEDLINE" Owner="NLM"><PMID Version="1">36959025</PMID><DateCompleted><Year>2022</Year><Month>05</Month><Day>12</Day></DateCompleted><Article PubModel="Print-Electronic"><Journal><ISSN IssnType="Electronic">1523-1747</ISSN><JournalIssue CitedMedium="Internet"><Volume>143</Volume><Issue>8</Issue><PubDate><Year>2023</Year><Month>Aug</Month></PubDate></JournalIssue><Title>The Journal of investigative dermatology</Title><ISOAbbreviation>J Invest Dermatol</ISOAbbreviation></Journal><ArticleTitle>T Cells Remember SARS-CoV-2 in Rituximab-Treated Pemphigus Vulgaris.</ArticleTitle><Abstract><AbstractText>Rituximab-treated pemphigus vulgaris patients mount SARS-CoV-2-specific T cell responses &amp; form durable memory.</AbstractText></Abstract><ELocationID EIdType="doi" ValidYN="Y">10.1016/j.jid.2023.02.002</ELocationID><AuthorList CompleteYN="Y"><Author ValidYN="Y"><LastName>Croitoru</LastName><ForeName>David O</ForeName><Initials>DO</Initials></Author><Author ValidYN="Y"><LastName>Piguet</LastName><ForeName>Vincent</ForeName><Initials>V</Initials></Author></AuthorList><Language>eng</Language><PublicationTypeList><PublicationType UI="D016428">Journal Article</PublicationType></PublicationTypeList></Article><MedlineJournalInfo><Country>United States</Country><MedlineTA>J Invest Dermatol</MedlineTA></MedlineJournalInfo></MedlineCitation></PubmedArticle>
<PubmedArticle><MedlineCitation Status="PubMed" Owner="NLM"><PMID Version="1">31687970</PMID><Article PubModel="Print"><Journal><JournalIssue CitedMedium="Print"><Volume>93</Volume><PubDate><Year>2019</Year><Month>Oct</Month></PubDate></JournalIssue><Title>Environmental research</Title></Journal><ArticleTitle>Graph attention networks: a survey.</ArticleTitle><AuthorList CompleteYN="Y"><Author ValidYN="Y"><LastName>Kim</LastName><ForeName>Soo</ForeName><Initials>S</Initials></Author></AuthorList><Language>eng</Language><PublicationTypeList><PublicationType UI="D016428">Journal Article</PublicationType></PublicationTypeList></Article></MedlineCitation></PubmedArticle>
</PubmedArticleSet>`;

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

/** Response-like double for an XML/text body. */
function xmlResponse(text) {
  return {
    ok: true,
    status: 200,
    body: Readable.toWeb(Readable.from([Buffer.from(text)])),
    json: async () => {
      throw new Error("not json");
    },
    text: async () => text,
    headers: { get: () => null },
  };
}

/** Decoded full URL — encoding must not hide wire params (+ is a space). */
function decodedUrl(url) {
  return decodeURIComponent(String(url).replace(/\+/g, " "));
}

/**
 * Build an adapter with an injected fetch that records every wire call.
 * The eutils wire mixes JSON (esearch) and XML (efetch) responses — the
 * double picks by path, mirroring how the client must consume both.
 */
function makeAdapter(responses = {}, env = {}) {
  const calls = [];
  const { esearch = ESEARCH_TWO, efetch = PMID_FULL_XML } = responses;
  const descriptor = createPubmedDescriptor({
    transport: {
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        const path = new URL(String(url)).pathname;
        if (path.endsWith("/esearch.fcgi")) return jsonResponse(esearch);
        return xmlResponse(typeof efetch === "string" ? efetch : efetch());
      },
    },
  });
  return { adapter: descriptor.create({ env }), calls, descriptor };
}

// ---------------------------------------------------------------------------
// Registry flip — the T2 stub seat must become the real adapter
// ---------------------------------------------------------------------------

describe("pubmed registry wiring — T2 stub seat flips to the real adapter", () => {
  it("BUILT_IN_PROVIDER_DESCRIPTORS pubmed descriptor creates an adapter (stub seat throws)", () => {
    // GROUND: TASKS T4c adapter bullet; registry.ts import pattern
    // (arXiv/OpenAlex/Crossref precedent). The T2 seat's create() throws
    // "not yet implemented"; after T4c the registry must carry the real
    // providers/pubmed/adapter.js descriptor.
    const seat = BUILT_IN_PROVIDER_DESCRIPTORS.find((d) => d.id === "pubmed");
    assert.ok(seat, "pubmed descriptor must be in BUILT_IN_PROVIDER_DESCRIPTORS");
    const adapter = seat.create({ env: {} });
    assert.ok(adapter.science, "pubmed adapter must expose the science slot");
    assert.ok(adapter.science.search, "science.search capability must exist");
    assert.ok(adapter.science.get, "science.get capability must exist");
    assert.ok(adapter.diagnostics, "diagnostics capability must exist (D2 round-3)");
  });

  it("credential model: NCBI_API_KEY env var, keyless configured, quota never listed", () => {
    // GROUND: DESIGN D2 supplier table (keyless 3 r/s; free NCBI_API_KEY
    // 10 r/s) + D2 credentialEnvVars bullet + PRD AC-5 round-5 scope pin
    // (isConfigured keyless-true ONLY for the no-capability form and the
    // science set + diagnostics — never `quota`). The registry stub
    // already carried ["NCBI_API_KEY"]; the real descriptor preserves it.
    const { descriptor } = makeAdapter();
    assert.deepEqual(descriptor.credentialEnvVars, ["NCBI_API_KEY"]);
    assert.equal(descriptor.isConfigured({}), true);
    assert.equal(
      descriptor.isConfigured({}, "quota"),
      false,
      "quota dashboard filter must never list science suppliers (AC-5)",
    );
    assert.equal(descriptor.isConfigured({}, "science.search"), true);
  });
});

// ---------------------------------------------------------------------------
// Two-step composition — esearch(JSON) then efetch(XML) on the D2 base
// ---------------------------------------------------------------------------

describe("pubmed search invoke — two-step esearch→efetch composition (TASKS T4c; DESIGN D2/D4; PRD AC-8b)", () => {
  it("one search invoke = exactly TWO wire calls: esearch then efetch, both on the eutils base", async () => {
    // GROUND: PRD AC-8b — "PubMed two-step (esearch→efetch) is the
    // adapter's internal concern; single `science search` invocation =
    // single logical query, two HTTP calls". DESIGN D2 pubmed row wire
    // base: https://eutils.ncbi.nlm.nih.gov/entrez/eutils/.
    // DEVIATION (see file header): the record-carrying second step is
    // efetch retmode=xml, not json (efetch json returns bare ids;
    // esummary json lacks title/authors).
    const { adapter, calls } = makeAdapter();
    const works = await adapter.science.search.invoke({ query: "attention" });
    assert.equal(calls.length, 2, "exactly two wire calls per search invoke (AC-8b)");
    const first = new URL(calls[0].url);
    const second = new URL(calls[1].url);
    assert.equal(
      first.origin + first.pathname,
      "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi",
      "step 1 hits esearch.fcgi on the D2 base",
    );
    assert.equal(
      second.origin + second.pathname,
      "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi",
      "step 2 hits efetch.fcgi on the D2 base",
    );
    assert.equal(works.length, 2, "both records mapped");
  });

  it("esearch carries the query with retmode=json; efetch carries the returned idlist joined", async () => {
    // GROUND: PRD verbatim wire evidence — esearch json envelope
    // {"esearchresult":{"count":"119",…,"idlist":["41283759",…]}};
    // the adapter must consume idlist (string ids) and address efetch
    // with them (the eutils efetch contract: one idlist, comma-joined).
    const { adapter, calls } = makeAdapter();
    await adapter.science.search.invoke({ query: "attention" });
    const wire1 = decodedUrl(calls[0].url);
    const u1 = new URL(calls[0].url);
    assert.equal(u1.searchParams.get("db"), "pubmed", "esearch db=pubmed");
    assert.equal(
      u1.searchParams.get("retmode"),
      "json",
      "esearch retmode=json (PRD wire evidence)",
    );
    assert.ok(wire1.includes("attention"), "query rides the esearch term");
    const u2 = new URL(calls[1].url);
    assert.equal(u2.searchParams.get("db"), "pubmed", "efetch db=pubmed");
    assert.equal(
      u2.searchParams.get("retmode"),
      "xml",
      "efetch retmode=xml — the record-carrying mode (deviation pin)",
    );
    const idParam = u2.searchParams.get("id") ?? "";
    assert.ok(
      idParam
        .split(",")
        .map((s) => s.trim())
        .includes("36959025") &&
        idParam
          .split(",")
          .map((s) => s.trim())
          .includes("31687970"),
      "efetch carries BOTH esearch-returned ids (idlist consumed)",
    );
  });

  it("empty idlist short-circuits: ONE esearch call, zero efetch calls, empty result", async () => {
    // GROUND: AC-8b's "two HTTP calls" is the ceiling for a record-carrying
    // query — zero records means the second step has nothing to fetch, and
    // making it anyway would waste the 3 r/s keyless budget (D2). The
    // esearch count=0/idlist=[] evidence is the PRD probe shape.
    const { adapter, calls } = makeAdapter({ esearch: ESEARCH_ZERO });
    const works = await adapter.science.search.invoke({ query: "nonexistenttermxyz" });
    assert.deepEqual(works, []);
    assert.equal(calls.length, 1, "no efetch when the idlist is empty");
    assert.ok(decodedUrl(calls[0].url).includes("esearch.fcgi"), "the one call is esearch");
  });
});

// ---------------------------------------------------------------------------
// Controls — author [AU], year mindate/maxdate, type pt, venue REJECT (D7)
// ---------------------------------------------------------------------------

describe("pubmed controls — D7 pubmed column (TASKS T4c; DESIGN D7; PRD AC-3)", () => {
  it("author maps to an [AU] term, single year to mindate/maxdate, type to the pt field — all on the esearch call", async () => {
    // GROUND: DESIGN D7 table pubmed column — author `[AU]`, year
    // `mindate/maxdate` + `datetype=pdat` (same-meaning discipline: the
    // eutils default datetype is ENTRY date, live-verified to select a
    // different record set than publication date), type `pt`. All three
    // are esearch-term-level controls (the second efetch step is
    // id-addressed, carrying no controls); a single search still totals
    // TWO calls (AC-8b).
    const { adapter, calls } = makeAdapter();
    await adapter.science.search.invoke({
      query: "attention",
      controls: { author: "Vaswani", year: "2020", type: "article" },
    });
    assert.equal(calls.length, 2);
    const wire = decodedUrl(calls[0].url);
    const u1 = new URL(calls[0].url);
    assert.ok(
      wire.includes("Vaswani[AU]"),
      "author control maps to an [AU] term (D7 pubmed column)",
    );
    assert.equal(u1.searchParams.get("mindate"), "2020", "single year → mindate");
    assert.equal(u1.searchParams.get("maxdate"), "2020", "single year → maxdate (closed form)");
    assert.equal(
      u1.searchParams.get("datetype"),
      "pdat",
      "year control must filter PUBLICATION date (D7 same-meaning; eutils default datetype is entry date — verified live: [Date - Entry] vs [Date - Publication], counts 232759 vs 264981)",
    );
    assert.ok(
      wire.includes("journal article[pt]") || wire.includes("[pt]"),
      "type control maps to the pt field with the pubmed wire literal (D7 round-2 table)",
    );
    assert.equal(
      new URL(calls[1].url).searchParams.has("term"),
      false,
      "efetch carries NO control terms — controls live on esearch only",
    );
  });

  it("year range 2018:2022 maps to mindate=2018 maxdate=2022", async () => {
    // GROUND: DESIGN D7 year row (pubmed column: mindate/maxdate) + PRD
    // AC-7b closed range form.
    const { adapter, calls } = makeAdapter();
    await adapter.science.search.invoke({
      query: "attention",
      controls: { year: "2018:2022" },
    });
    const u1 = new URL(calls[0].url);
    assert.equal(u1.searchParams.get("mindate"), "2018");
    assert.equal(u1.searchParams.get("maxdate"), "2022");
  });

  it("venue is REJECTED at validate with UnsupportedOptionError, before any transport call", async () => {
    // GROUND: DESIGN D7 venue row (pubmed column: reject) + PRD AC-3 —
    // UNSUPPORTED_OPTION at validation, never accept-and-drop, never
    // silent post-filtering. D5: pubmed is not a venue-capable supplier
    // (crossref-only in v1).
    const { adapter, calls } = makeAdapter();
    assert.throws(
      () => adapter.science.search.validate({ query: "attention", controls: { venue: "Nature" } }),
      (e) => e instanceof UnsupportedOptionError && e.provider === "pubmed" && e.option === "venue",
    );
    await assert.rejects(
      adapter.science.search.invoke({ query: "attention", controls: { venue: "Nature" } }),
    );
    assert.equal(calls.length, 0, "rejection before any transport call");
  });

  it("empty query and reversed year range throw ValidationError through the adapter's validate", () => {
    // GROUND: DESIGN D1 shared validator (query non-whitespace; year
    // closed forms, reversed rejected — PRD AC-7b) reached through the
    // adapter's validate delegation (crossref/openalex precedent).
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
// Type VALUE translation — D7 round-2 table, pubmed pt column
// ---------------------------------------------------------------------------

describe("pubmed type-VALUE mapping (TASKS T4c; DESIGN D7 translation table; PRD AC-7)", () => {
  it("union vocabulary maps to the pubmed pt wire literals column — all seven values consumed", async () => {
    // GROUND: TASKS T4c — "type-VALUE mapping pin (D7 translation table
    // column — e.g. article→`journal article`)". Pubmed pt column:
    // article→journal article, preprint→preprint, conference-paper→
    // congress, chapter→book chapter, dataset→dataset, review→review,
    // other→other.
    const cases = [
      ["article", "journal article"],
      ["preprint", "preprint"],
      ["conference-paper", "congress"],
      ["chapter", "book chapter"],
      ["dataset", "dataset"],
      ["review", "review"],
      ["other", "other"],
    ];
    for (const [unionValue, wireLiteral] of cases) {
      const { adapter, calls } = makeAdapter();
      await adapter.science.search.invoke({
        query: "attention",
        controls: { type: unionValue },
      });
      const wire = decodedUrl(calls[0].url);
      assert.ok(
        wire.includes(`${wireLiteral}[pt]`),
        `union type "${unionValue}" must map to wire literal "${wireLiteral}[pt]"`,
      );
    }
  });

  it("unknown type value is rejected at validate, before any transport call (no accept-and-drop)", async () => {
    const { adapter, calls } = makeAdapter();
    assert.throws(
      () => adapter.science.search.validate({ query: "x", controls: { type: "bogus" } }),
      (e) => e instanceof UnsupportedOptionError && e.provider === "pubmed" && e.option === "type",
    );
    await assert.rejects(
      adapter.science.search.invoke({ query: "x", controls: { type: "bogus" } }),
    );
    assert.equal(calls.length, 0, "rejection before any transport call");
  });
});

// ---------------------------------------------------------------------------
// Mapping pins — efetch XML record → ScienceWork (PRD AC-7d)
// ---------------------------------------------------------------------------

describe("pubmed search invoke — XML mapping to ScienceWork (TASKS T4c; PRD AC-7d/AC-7c)", () => {
  it("maps the full record field-for-field: title, url, identifiers (pmid+doi), authors, year, venue, summary, type", async () => {
    // GROUND: PRD AC-7d wire-shape discipline (PubMed's record fields are
    // the efetch XML shape — probe 2026-09-11): ArticleTitle → title,
    // PMID → identifiers.pmid, ELocationID doi → identifiers.doi,
    // AuthorList LastName+ForeName → authors, PubDate Year → year,
    // Journal Title → venue, AbstractText → summary, Language → language,
    // PublicationType → type. url is the pubmed landing page for the PMID
    // (the house-visible identity for a pubmed-sourced work).
    const { adapter } = makeAdapter();
    const works = await adapter.science.search.invoke({ query: "attention" });
    const w = works.find(
      (x) => x.title === "T Cells Remember SARS-CoV-2 in Rituximab-Treated Pemphigus Vulgaris.",
    );
    assert.ok(w, "full record present");
    assert.equal(w.identifiers?.pmid, "36959025", "PMID → identifiers.pmid");
    assert.equal(
      w.identifiers?.doi,
      "10.1016/j.jid.2023.02.002",
      "ELocationID doi → identifiers.doi",
    );
    assert.deepEqual(
      w.authors,
      ["Croitoru DO", "Piguet V"],
      "AuthorList LastName+ForeName → joined display strings",
    );
    assert.equal(w.year, 2023, "PubDate Year → year");
    assert.equal(w.venue, "The Journal of investigative dermatology", "Journal Title → venue");
    assert.equal(w.language, "eng", "Language → language");
    // Review: XML entities decode — the wire carries `&amp;`, the
    // normalized field carries `&`.
    assert.equal(
      w.summary,
      "Rituximab-treated pemphigus vulgaris patients mount SARS-CoV-2-specific T cell responses & form durable memory.",
      "AbstractText → summary with entities decoded",
    );
    assert.ok(
      typeof w.url === "string" && w.url.includes("36959025"),
      "url is PMID-addressed (pubmed landing identity)",
    );
    // Deep-review pin: the eutils `pt` vocabulary surfaces VERBATIM —
    // the fixture's first PublicationType is the literal "Journal
    // Article" (not normalized, not dropped).
    assert.equal(w.type, "Journal Article", "PublicationType → type, verbatim vocabulary");
    // type: the record's first PublicationType (journal article).
    assert.ok(typeof w.type === "string" && w.type.length > 0, "PublicationType → type");
  });

  it("AbstractText maps to summary when present; record without abstract stays honestly absent", async () => {
    // GROUND: PRD AC-7c — "summary honestly absent when the supplier
    // carries none". The fixture's second record (PMID 31687970) has NO
    // AbstractText and NO ELocationID doi — absent stays absent, never
    // undefined-valued and never fabricated. The first record carries
    // a single AbstractText (review: present-case must be positively
    // asserted — the fixture previously lacked any AbstractText, so
    // only the absent branch ran).
    const { adapter } = makeAdapter();
    const works = await adapter.science.search.invoke({ query: "graph attention" });
    const full = works.find(
      (x) => x.title === "T Cells Remember SARS-CoV-2 in Rituximab-Treated Pemphigus Vulgaris.",
    );
    assert.ok(full, "record with an AbstractText is present");
    assert.ok(
      typeof full.summary === "string" && full.summary.includes("T cell responses"),
      "AbstractText present → summary populated",
    );
    const w = works.find((x) => x.title === "Graph attention networks: a survey.");
    assert.ok(w, "abstractless record present");
    assert.equal(
      Object.hasOwn(w, "summary"),
      false,
      "no AbstractText → summary honestly absent (AC-7c)",
    );
    assert.equal(
      Object.hasOwn(w, "identifiers"),
      false,
      "no doi → identifiers key absent (pmid absent too)",
    );
  });

  it("pre-2007 record: DOI comes from PubmedData/ArticleIdList when ELocationID carries none (#147)", async () => {
    // GROUND: pre-2007 eutils records carry the doi ONLY in
    // `PubmedData/ArticleIdList/ArticleId[@IdType="doi"]` — no ELocationID
    // doi element. Without the fallback the record parses doi-less, so
    // `identifiers` is omitted entirely and `scienceMergeKey` (DOI-first,
    // normalized-url fallback) can never merge this row with the Europe
    // PMC / OpenAlex row for the same work: duplicate fanout rows.
    const pre2007Xml = `<?xml version="1.0" ?>
<PubmedArticleSet>
<PubmedArticle><MedlineCitation Status="MEDLINE" Owner="NLM"><PMID Version="1">12345678</PMID><Article PubModel="Print"><Journal><JournalIssue CitedMedium="Print"><PubDate><Year>2003</Year><Month>Jan</Month></PubDate></JournalIssue><Title>Journal of old records</Title></Journal><ArticleTitle>An older record with an ArticleIdList doi.</ArticleTitle></Article></MedlineCitation><PubmedData><ArticleIdList><ArticleId IdType="pubmed">12345678</ArticleId><ArticleId IdType="doi">10.1234/x</ArticleId></ArticleIdList></PubmedData></PubmedArticle>
</PubmedArticleSet>`;
    const { adapter } = makeAdapter({ efetch: pre2007Xml });
    const works = await adapter.science.search.invoke({ query: "older record" });
    assert.equal(works.length, 1, "the pre-2007 record parses");
    assert.equal(
      works[0].identifiers?.doi,
      "10.1234/x",
      "ArticleIdList ArticleId[@IdType=doi] → identifiers.doi (no ELocationID doi present)",
    );
  });

  it("#147 review B1: a cited ReferenceList DOI never retargets the record — own PubmedData ArticleIdList wins", async () => {
    // GROUND: cited works carry their OWN ArticleIdList inside
    // ReferenceList spans, and eutils emits line-joined XML where the
    // cited list can precede the record's own PubmedData list. A
    // block-level leftmost ArticleIdList match lands on the CITED list
    // and stamps the record with a citation's DOI — scienceMergeKey's
    // first choice, so fan-out dedup would merge unrelated works. The
    // fallback must read the record's OWN list: PubmedData-scoped,
    // ReferenceList spans stripped.
    const xml = `<?xml version="1.0" ?>
<PubmedArticleSet>
<PubmedArticle><MedlineCitation Status="MEDLINE" Owner="NLM"><PMID Version="1">11111111</PMID><Article PubModel="Print"><ArticleTitle>Own record with cited references.</ArticleTitle><ReferenceList><Reference><ArticleIdList><ArticleId IdType="pubmed">99999999</ArticleId><ArticleId IdType="doi">10.9999/CITED</ArticleId></ArticleIdList></Reference></ReferenceList></Article></MedlineCitation><PubmedData><ArticleIdList><ArticleId IdType="pubmed">11111111</ArticleId><ArticleId IdType="doi">10.1000/OWN</ArticleId></ArticleIdList></PubmedData></PubmedArticle>
</PubmedArticleSet>`;
    const { adapter } = makeAdapter({ efetch: xml });
    const works = await adapter.science.search.invoke({ query: "own record" });
    assert.equal(works.length, 1);
    assert.equal(
      works[0].identifiers?.doi,
      "10.1000/OWN",
      "the record's OWN PubmedData doi — never the cited 10.9999/CITED",
    );
  });

  it("#147 review: present-but-empty ELocationID carries no DOI — the ArticleIdList fallback fires on VALUE, not presence", async () => {
    // GROUND: `<ELocationID EIdType="doi"></ELocationID>` (or whitespace-
    // only) is PRESENT but carries no value; keying the fallback on
    // element presence suppressed it and the record parsed doi-less even
    // though its own ArticleIdList carries a doi. The contract keys on
    // "carries no DOI" — an empty/blank element carries none.
    const xml = `<?xml version="1.0" ?>
<PubmedArticleSet>
<PubmedArticle><MedlineCitation Status="MEDLINE" Owner="NLM"><PMID Version="1">22222221</PMID><Article PubModel="Print"><ArticleTitle>Empty ELocationID record.</ArticleTitle><ELocationID EIdType="doi" ValidYN="N"></ELocationID></Article></MedlineCitation><PubmedData><ArticleIdList><ArticleId IdType="pubmed">22222221</ArticleId><ArticleId IdType="doi">10.1000/EMPTY-ELOC</ArticleId></ArticleIdList></PubmedData></PubmedArticle>
<PubmedArticle><MedlineCitation Status="MEDLINE" Owner="NLM"><PMID Version="1">22222222</PMID><Article PubModel="Print"><ArticleTitle>Whitespace ELocationID record.</ArticleTitle><ELocationID EIdType="doi" ValidYN="N">   </ELocationID></Article></MedlineCitation><PubmedData><ArticleIdList><ArticleId IdType="pubmed">22222222</ArticleId><ArticleId IdType="doi">10.1000/BLANK-ELOC</ArticleId></ArticleIdList></PubmedData></PubmedArticle>
</PubmedArticleSet>`;
    const { adapter } = makeAdapter({ efetch: xml });
    const works = await adapter.science.search.invoke({ query: "elocation" });
    assert.equal(works.length, 2);
    assert.equal(works[0].identifiers?.doi, "10.1000/EMPTY-ELOC", "empty element falls through to ArticleIdList");
    assert.equal(works[1].identifiers?.doi, "10.1000/BLANK-ELOC", "whitespace-only element falls through too");
  });

  it("#147: ELocationID wins when both sources carry a DOI (precedence pin)", async () => {
    // GROUND: contract pin — when ELocationID AND ArticleIdList both
    // carry a doi, the ELocationID value wins (the modern record's own
    // declaration). Inverted-precedence mutants must fail this.
    const xml = `<?xml version="1.0" ?>
<PubmedArticleSet>
<PubmedArticle><MedlineCitation Status="MEDLINE" Owner="NLM"><PMID Version="1">33333331</PMID><Article PubModel="Print"><ArticleTitle>Both sources present.</ArticleTitle><ELocationID EIdType="doi">10.1111/ELOC</ELocationID></Article></MedlineCitation><PubmedData><ArticleIdList><ArticleId IdType="pubmed">33333331</ArticleId><ArticleId IdType="doi">10.2222/ARTC</ArticleId></ArticleIdList></PubmedData></PubmedArticle>
</PubmedArticleSet>`;
    const { adapter } = makeAdapter({ efetch: xml });
    const works = await adapter.science.search.invoke({ query: "both present" });
    assert.equal(works.length, 1);
    assert.equal(works[0].identifiers?.doi, "10.1111/ELOC", "ELocationID doi wins over ArticleIdList doi");
  });

  it("#147 review: per-record ReferenceLists never bleed across records (multi-record isolation pin)", async () => {
    // GROUND: every record parses inside its own PubmedArticle block;
    // a cited doi in record A's ReferenceList must never surface on
    // record B. B's own list carries no doi, so B must stay honestly
    // doi-less (identifiers absent) even though A cites a doi.
    const xml = `<?xml version="1.0" ?>
<PubmedArticleSet>
<PubmedArticle><MedlineCitation Status="MEDLINE" Owner="NLM"><PMID Version="1">44444441</PMID><Article PubModel="Print"><ArticleTitle>Record A citing a doi.</ArticleTitle></Article></MedlineCitation><PubmedData><ArticleIdList><ArticleId IdType="pubmed">44444441</ArticleId><ArticleId IdType="doi">10.1/A-OWN</ArticleId></ArticleIdList><ReferenceList><Reference><ArticleIdList><ArticleId IdType="doi">10.9/A-CITED</ArticleId></ArticleIdList></Reference></ReferenceList></PubmedData></PubmedArticle>
<PubmedArticle><MedlineCitation Status="MEDLINE" Owner="NLM"><PMID Version="1">44444442</PMID><Article PubModel="Print"><ArticleTitle>Record B without own doi.</ArticleTitle></Article></MedlineCitation><PubmedData><ArticleIdList><ArticleId IdType="pubmed">44444442</ArticleId></ArticleIdList></PubmedData></PubmedArticle>
</PubmedArticleSet>`;
    const { adapter } = makeAdapter({ efetch: xml });
    const works = await adapter.science.search.invoke({ query: "records" });
    assert.equal(works.length, 2);
    assert.equal(works[0].identifiers?.doi, "10.1/A-OWN", "A keeps its own doi (cited 10.9/A-CITED ignored)");
    assert.equal(
      Object.hasOwn(works[1], "identifiers"),
      false,
      "B stays honestly doi-less — A's cited doi never bleeds across records",
    );
  });

  it("PubmedBookArticle records parse — book PMIDs no longer vanish (review round 6)", async () => {
    // Review: eutils emits <PubmedBookArticle> for book-oriented PMIDs;
    // the block matcher dropped them, so searches omitted ids esearch
    // returned and direct gets 404'd.
    const bookXml = `<?xml version="1.0" ?>
<PubmedArticleSet>
<PubmedBookArticle><PMID Version="1">31687970</PMID><Article><ArticleTitle>Genome Editing Handbook.</ArticleTitle></Article></PubmedBookArticle>
</PubmedArticleSet>`;
    const { adapter } = makeAdapter({
      esearch: { header: { type: "esearch", version: "0.3" }, esearchresult: { count: "1", idlist: ["31687970"] } },
      efetch: bookXml,
    });
    const works = await adapter.science.search.invoke({ query: "handbook" });
    assert.equal(works.length, 1, "the book record parses");
    assert.equal(works[0].title, "Genome Editing Handbook.");
    assert.ok(works[0].url.includes("31687970"), "PMID-addressed url");
  });

  it("nested inline markup is stripped from titles and abstracts (review round 6)", async () => {
    // Review: eutils titles carry <i>/<b>/<sub> markup — surfacing it
    // literally in ScienceWork fields is markup leakage, not fidelity.
    const marked = PMID_FULL_XML.replace(
      "<ArticleTitle>T Cells Remember SARS-CoV-2 in Rituximab-Treated Pemphigus Vulgaris.</ArticleTitle>",
      "<ArticleTitle>Gene <i>ABC</i> and the <sub>2</sub> splice variant.</ArticleTitle>",
    );
    assert.notEqual(marked, PMID_FULL_XML, "fixture splice must land");
    const { adapter } = makeAdapter({ efetch: marked });
    const works = await adapter.science.search.invoke({ query: "gene" });
    assert.equal(works[0].title, "Gene ABC and the 2 splice variant.");
  });

  it("a structured abstract joins EVERY labeled AbstractText section (review)", async () => {
    // Review: multi-section abstracts previously kept only the FIRST
    // <AbstractText> block — the labeled sections after it were lost.
    const structured = PMID_FULL_XML.replace(
      /<Abstract>[\s\S]*?<\/Abstract>/,
      "<Abstract>" +
        '<AbstractText Label="BACKGROUND">T cells respond to rituximab.</AbstractText>' +
        '<AbstractText Label="CONCLUSIONS">Memory persists &amp; protects.</AbstractText>' +
        "</Abstract>",
    );
    assert.notEqual(structured, PMID_FULL_XML, "fixture splice must land");
    const { adapter } = makeAdapter({ efetch: structured });
    const works = await adapter.science.search.invoke({ query: "attention" });
    const w = works.find(
      (x) => x.title === "T Cells Remember SARS-CoV-2 in Rituximab-Treated Pemphigus Vulgaris.",
    );
    assert.ok(w, "structured record present");
    assert.equal(
      w.summary,
      "T cells respond to rituximab. Memory persists & protects.",
      "all AbstractText sections join, in order, entities decoded",
    );
  });

  it("citationCount is honestly absent — eutils carries no citation signal on this wire", () => {
    // GROUND: PRD AC-7d pins per-supplier citation fields (Crossref
    // is-referenced-by-count, OpenAlex cited_by_count, EuropePMC
    // citedByCount); the eutils wire carries none (probe: no such field
    // in the efetch/esummary response). Honesty teeth: absent stays
    // absent — the pubmed adapter must not fabricate one.
    const { adapter } = makeAdapter();
    return adapter.science.search.invoke({ query: "attention" }).then((works) => {
      for (const w of works) {
        assert.equal(Object.hasOwn(w, "citationCount"), false);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// science get — PMID direct; DOI via id lookup; arXiv rejected (D10 ruling 3)
// ---------------------------------------------------------------------------

describe("pubmed get — PMID and DOI, never arXiv (TASKS T4c; DESIGN D10 ruling 3; PRD AC-2/AC-4b)", () => {
  it("get by bare PMID: efetch addressed with the id directly (no esearch), one normalized work", async () => {
    // GROUND: DESIGN D10 ruling 3 — PMID routes to pubmed (the native
    // id space: "PubMed esummary direct"; deviation above applies to the
    // endpoint, not the routing: efetch may be addressed by id directly).
    // AC-8b spirit: id-known gets skip the esearch step.
    const { adapter, calls } = makeAdapter();
    const work = await adapter.science.get.invoke({ identifier: "36959025" });
    assert.equal(calls.length, 1, "id-direct get is ONE wire call (no esearch step)");
    const u = new URL(calls[0].url);
    assert.equal(
      u.origin + u.pathname,
      "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi",
    );
    assert.ok(decodedUrl(calls[0].url).includes("36959025"), "the PMID addresses the efetch call");
    assert.equal(work.identifiers?.pmid, "36959025");
    assert.equal(
      work.title,
      "T Cells Remember SARS-CoV-2 in Rituximab-Treated Pemphigus Vulgaris.",
    );
  });

  it("get by bare DOI: resolved via an id lookup step, one normalized work", async () => {
    // GROUND: D10 ruling 3 — DOI routes to all suppliers except arxiv,
    // pubmed included. Probe evidence: esearch term "<doi>[DOI]" maps the
    // DOI to its PMID (count=1, idlist), then efetch returns the record.
    const { adapter, calls } = makeAdapter({
      esearch: {
        header: { type: "esearch", version: "0.3" },
        esearchresult: {
          count: "1",
          retmax: "1",
          retstart: "0",
          idlist: ["36959025"],
        },
      },
    });
    const work = await adapter.science.get.invoke({ identifier: "10.1016/j.jid.2023.02.002" });
    assert.ok(
      work.identifiers?.pmid === "36959025" ||
        work.identifiers?.doi === "10.1016/j.jid.2023.02.002",
    );
    assert.equal(calls.length, 2, "DOI get resolves through the two-step (lookup, then record)");
    const wire = decodedUrl(calls[0].url);
    assert.ok(wire.includes("10.1016/j.jid.2023.02.002"), "the DOI rides the lookup call's wire");
  });

  it("validate rejects arXiv ids (UnsupportedOptionError); out-of-grammar throws ValidationError; PMID passes", () => {
    // GROUND: DESIGN D10 ruling 3 — arXiv ids route to the arxiv adapter
    // only; PMID routes to pubmed. A bare arXiv id passes the shared
    // grammar but is not servable by pubmed → UnsupportedOptionError;
    // out-of-grammar strings throw the shared ValidationError (D1).
    const { adapter } = makeAdapter();
    assert.doesNotThrow(() => adapter.science.get.validate({ identifier: "36959025" }));
    assert.throws(
      () => adapter.science.get.validate({ identifier: "2401.12345" }),
      (e) =>
        e instanceof UnsupportedOptionError && e.provider === "pubmed" && e.option === "identifier",
      "arXiv id does not route to pubmed (D10 ruling 3)",
    );
    assert.throws(
      () => adapter.science.get.validate({ identifier: "pmid:36959025" }),
      (e) => e instanceof ValidationError,
      "prefixed pmid: is outside the bare grammar",
    );
  });

  it("get with an unresolvable id (empty idlist) fails loud, never an empty result", async () => {
    // GROUND: PRD AC-2 — science get returns ONE work or fails; a
    // zero-record lookup is a 404-class ApiError, not an empty array.
    const { adapter } = makeAdapter({ esearch: ESEARCH_ZERO });
    await assert.rejects(
      adapter.science.get.invoke({ identifier: "10.9999/nonexistent.doi" }),
      (e) => e instanceof Error,
    );
  });
});

// ---------------------------------------------------------------------------
// Cache identity — one logical identity per query (D4); "" keyless,
// SHA-256 keyed (D4b note; AC-6b)
// ---------------------------------------------------------------------------

describe("pubmed cache identity — one logical identity per query (TASKS T4c; DESIGN D4 + D4b note; PRD AC-6b/AC-8b note)", () => {
  it('search identity: supplier pubmed, capability science.search, fingerprint "", request echoed', () => {
    // GROUND: DESIGN D4 — "PubMed two-step = ONE cache identity (the
    // logical query); adapter composes esearch+efetch internally" + D4b
    // note — keyless "" fingerprint (user-independent). AC-8b note: the
    // identity covers the two-call sequence.
    const { adapter } = makeAdapter();
    const request = { query: "attention", controls: {} };
    const identity = adapter.science.search.cacheIdentity(request);
    assert.equal(identity.supplier, "pubmed");
    assert.equal(identity.capability, "science.search");
    assert.equal(identity.credentialFingerprint, "");
    assert.deepEqual(identity.request, request);
  });

  it('keyed upgrade re-partitions: NCBI_API_KEY present → SHA-256 hex fingerprint, not ""', () => {
    // GROUND: PRD AC-6b — "constant empty credentialFingerprint when
    // keyless; keyed upgrades re-partition" + DESIGN D4b note ("When a
    // key IS present, fingerprint = SHA-256 of the key, house method").
    const { adapter } = makeAdapter({}, { NCBI_API_KEY: "test-pubmed-key" });
    const identity = adapter.science.search.cacheIdentity({ query: "attention" });
    assert.equal(
      identity.credentialFingerprint,
      "09ba00c53dac8922d49ae607391f60fa4b862e027b05127e252b068170162b38",
      "SHA-256 hex of the active key (house method)",
    );
  });

  it("get identity: capability science.get, identifier echoed, one identity regardless of the internal steps", () => {
    const { adapter } = makeAdapter();
    const identity = adapter.science.get.cacheIdentity({ identifier: "36959025" });
    assert.equal(identity.supplier, "pubmed");
    assert.equal(identity.capability, "science.get");
    assert.equal(identity.credentialFingerprint, "");
    assert.deepEqual(identity.request, { identifier: "36959025" });
  });
});

// ---------------------------------------------------------------------------
// Diagnostics — keyless bounded probe smoke (D2 round-3)
// ---------------------------------------------------------------------------

describe("pubmed diagnostics — keyless bounded probe (TASKS T4c; DESIGN D2 round-3; PRD AC-5)", () => {
  it("probe:false resolves without touching the network", async () => {
    const { adapter, calls } = makeAdapter();
    await adapter.diagnostics.invoke({ probe: false });
    assert.equal(calls.length, 0);
  });

  it("probe:true makes exactly ONE bounded keyless wire call on the eutils base, retmax bounded", async () => {
    // GROUND: DESIGN D2 round-3 — doctor probes every always-configured
    // science supplier; the probe is ONE minimal keyless wire call
    // (arXiv max_results=1 precedent). On the eutils wire the cheapest
    // bounded call is a minimal esearch (retmax=1), never a full search
    // and never an efetch.
    const { adapter, calls } = makeAdapter();
    await adapter.diagnostics.invoke({ probe: true });
    assert.equal(calls.length, 1, "exactly one wire call");
    const u = new URL(calls[0].url);
    assert.equal(
      u.origin + u.pathname,
      "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi",
      "probe targets the eutils base",
    );
    assert.equal(
      u.searchParams.get("retmax"),
      "1",
      "probe is bounded — retmax=1, never a full search",
    );
  });

  it("a failing probe rejects (never resolves silently)", async () => {
    const descriptor = createPubmedDescriptor({
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

describe("PubMed 429 — keyless rate limit maps to QuotaError (DESIGN D4b honest class)", () => {
  it("a 429 response rejects with QuotaError and statusCode 429 on search invoke", async () => {
    const descriptor = createPubmedDescriptor({
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

/** Case-insensitive Headers double mirroring the fetch `Headers` contract. */
function headersOf(values = {}) {
  const lower = new Map();
  for (const [key, value] of Object.entries(values)) {
    lower.set(key.toLowerCase(), value);
  }
  return {
    get(name) {
      const hit = lower.get(String(name).toLowerCase());
      return hit === undefined ? null : hit;
    },
  };
}


// ---------------------------------------------------------------------------
// Retry-After header seam — Lane P P2 no-op pin (#186)
// ---------------------------------------------------------------------------

describe("PubMed retry-hint seam — no documented emitter; no-op pin (#186 P2)", () => {
  // GROUND: PubMed documents NO delay-hint headers. NO-OP pin: the status-map site now consults the parser; with no hint headers the error path stays byte-identical (field absent).
  //
  // The SEAM is still exercised: the Response headers are consulted at
  // the status-map site, and the no-op observable truth is that no
  // header value means no field.
  function hintDescriptor(status, headers) {
    return createPubmedDescriptor({
      transport: {
        fetch: async () => ({ ok: false, status, headers, text: async () => "" }),
      },
    });
  }

  it("a 429 with no hint headers still rejects as QuotaError with retryAfterMs absent", async () => {
    const adapter = hintDescriptor(429, headersOf({})).create({ env: {} });
    await assert.rejects(
      adapter.science.search.invoke({ query: "x" }),
      (e) => {
        assert.ok(e instanceof QuotaError, "the honest 429 class is unchanged");
        assert.equal(e.statusCode, 429);
        assert.equal(e.retryAfterMs, undefined, "no documented emitter → no field");
        return true;
      },
    );
  });

  it("a 500 with no hint headers still rejects as ApiError with retryAfterMs absent", async () => {
    const adapter = hintDescriptor(500, headersOf({})).create({ env: {} });
    await assert.rejects(
      adapter.science.search.invoke({ query: "x" }),
      (e) => {
        assert.ok(e instanceof ApiError, "the 5xx class is unchanged");
        assert.equal(e.statusCode, 500);
        assert.equal(e.retryAfterMs, undefined, "field stays absent on the 5xx path");
        return true;
      },
    );
  });

  it("headers that carry no hint are inert — the error is byte-identical", async () => {
    const bare = hintDescriptor(500, headersOf({})).create({ env: {} });
    const withOtherHeaders = hintDescriptor(
      500,
      headersOf({ "Content-Type": "text/plain", "Retry-After-Not": "5" }),
    ).create({ env: {} });
    let bareErr;
    let otherErr;
    await assert.rejects(bare.science.search.invoke({ query: "x" }), (e) => {
      bareErr = e;
      return true;
    });
    await assert.rejects(withOtherHeaders.science.search.invoke({ query: "x" }), (e) => {
      otherErr = e;
      return true;
    });
    assert.equal(otherErr.message, bareErr.message, "unrelated headers change nothing");
    assert.equal(otherErr.retryAfterMs, undefined);
  });
});

// ---------------------------------------------------------------------------
// Bounded response execution hardening (#150)
// ---------------------------------------------------------------------------

describe("pubmed bounded response execution hardening (#150)", () => {
  it("pre-read rejection on esearch: content-length > 50MB ceiling rejects with terminal 413 ApiError and cancels body without reading", async () => {
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
    const descriptor = createPubmedDescriptor({
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
        assert.match(err.message, /pubmed response exceeds.*50MB.*refusing to buffer/i);
        return true;
      },
    );
    assert.equal(cancelCalled, true, "body.cancel() must be called before throwing");
    assert.equal(readCalled, false, "body must never be read when declared size exceeds ceiling");
  });

  it("pre-read rejection on efetch: content-length > 50MB ceiling rejects with terminal 413 ApiError and cancels body without reading", async () => {
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
    const descriptor = createPubmedDescriptor({
      transport: {
        fetch: async () => ({
          ok: true,
          status: 200,
          headers: {
            get: (name) => (name.toLowerCase() === "content-length" ? "55000000" : null),
          },
          body: mockBody,
          text: async () => {
            readCalled = true;
            return "";
          },
        }),
      },
    });
    const adapter = descriptor.create({ env: {} });
    await assert.rejects(
      () => adapter.science.get.invoke({ identifier: "31687970" }),
      (err) => {
        assert.equal(err.code, "API_ERROR");
        assert.equal(err.statusCode, 413);
        assert.match(err.message, /pubmed response exceeds.*50MB.*refusing to buffer/i);
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
    const descriptor = createPubmedDescriptor({
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
        assert.match(err.message, /pubmed response exceeds.*50MB.*refusing to buffer/i);
        return true;
      },
    );
    assert.ok(chunksYielded > 50, "should have read past 50MB before rejecting");
    assert.ok(chunksYielded < totalChunks, "stream should stop yielding chunks once cancelled");
    assert.ok(chunksYielded <= 53, "stream should stop yielding chunks once cancelled");
    assert.equal(cancelCalled, true, "body stream must be cancelled");
  });

  it("headerless test double seam: minimal {ok, status, json()} double succeeds (pin a esearch)", async () => {
    const descriptor = createPubmedDescriptor({
      transport: {
        fetch: async () => ({
          ok: true,
          status: 200,
          json: async () => ({ esearchresult: { idlist: [] } }),
        }),
      },
    });
    const adapter = descriptor.create({ env: {} });
    const works = await adapter.science.search.invoke({ query: "attention" });
    assert.deepEqual(works, []);
  });

  it("headerless test double seam: minimal efetch {ok, status, text()} double succeeds (pin a efetch)", async () => {
    const minimalXml = `<PubmedArticleSet><PubmedArticle><MedlineCitation><PMID>36959025</PMID><Article><ArticleTitle>Test Title</ArticleTitle><Journal><Title>Test Journal</Title><JournalIssue><PubDate><Year>2023</Year></PubDate></JournalIssue></Journal></Article></MedlineCitation></PubmedArticle></PubmedArticleSet>`;
    const descriptor = createPubmedDescriptor({
      transport: {
        fetch: async () => ({
          ok: true,
          status: 200,
          text: async () => minimalXml,
        }),
      },
    });
    const adapter = descriptor.create({ env: {} });
    const work = await adapter.science.get.invoke({ identifier: "36959025" });
    assert.equal(work.title, "Test Title");
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
    const descriptor = createPubmedDescriptor({
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
        assert.match(err.message, /pubmed response exceeds.*50MB.*refusing to buffer/i);
        assert.doesNotMatch(err.message, /--out/);
        return true;
      },
    );
    assert.equal(cancelCalled, true, "body stream must be cancelled");
  });

  it("BOM-safe JSON parse: leading U+FEFF on esearch step is stripped and parses successfully (pin c)", async () => {
    const payload = "\uFEFF" + JSON.stringify({
      esearchresult: { idlist: [] },
    });
    const descriptor = createPubmedDescriptor({
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
    assert.deepEqual(works, []);
  });

  it("BOM fallback-path parse: text() double returning U+FEFF on esearch strips BOM and parses (pin a)", async () => {
    const payload = "\uFEFF" + JSON.stringify({
      esearchresult: { idlist: [] },
    });
    const descriptor = createPubmedDescriptor({
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
    assert.deepEqual(works, []);
  });

  it("content-length boundary: declared length exactly equal to 50MB ceiling on esearch is allowed (strict >)", async () => {
    const payload = JSON.stringify({
      esearchresult: { idlist: [] },
    });
    const descriptor = createPubmedDescriptor({
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
    const descriptor = createPubmedDescriptor({
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

describe("pubmed abort signal threading and honest cancellation (#151)", () => {
  it("a pre-aborted caller signal rejects before transport is invoked", async () => {
    let fetchCalls = 0;
    const descriptor = createPubmedDescriptor({
      transport: {
        fetch: async () => {
          fetchCalls += 1;
          return { ok: true, status: 200, json: async () => ({ esearchresult: { idlist: [] } }) };
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
        assert.match(e.message, /PubMed request was aborted by the caller/);
        assert.doesNotMatch(e.message, /timed out/i);
        return true;
      },
    );
    assert.equal(fetchCalls, 0, "transport fetch must never be invoked");
  });

  it("external abort mid-flight rejects with honest abort ApiError(499), not TimeoutError", async () => {
    const ac = new AbortController();
    const descriptor = createPubmedDescriptor({
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
        assert.match(e.message, /PubMed request was aborted by the caller/);
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
    const descriptor = createPubmedDescriptor({
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
        assert.match(e.message, /PubMed request was aborted by the caller/);
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
    const descriptor = createPubmedDescriptor({
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
    const descriptor = createPubmedDescriptor({
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

// ---------------------------------------------------------------------------
// Transport-env precedence — the descriptor env is AUTHORITATIVE (#260).
// The transport deps' optional `env` field is decorative in the adapter
// path: the adapter's `{ ...transport, env }` construction (pubmed,
// openalex, europepmc, crossref — env-last, #257/#260) always clobbers it.
// It exists for direct client-call test seams only. This pin proves the
// contract: a transport-injected PUBMED_TIMEOUT must NOT override through
// the adapter path.
// ---------------------------------------------------------------------------

describe("pubmed transport-env precedence — descriptor env wins (#260)", () => {
  it("transport-injected PUBMED_TIMEOUT does not override; the descriptor env arms the timer", async () => {
    let armedDelayMs;
    const descriptor = createPubmedDescriptor({
      transport: {
        env: { PUBMED_TIMEOUT: "12345" },
        fetch: (_url, init) =>
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
        setTimeout: (cb, delayMs) => {
          armedDelayMs = delayMs;
          setImmediate(cb);
          return 123;
        },
        clearTimeout: () => {},
      },
    });
    const adapter = descriptor.create({ env: {} });
    const promise = adapter.science.search.invoke({ query: "x" });
    await assert.rejects(promise, (e) => e instanceof TimeoutError);
    assert.equal(
      armedDelayMs,
      30000,
      "descriptor env must be authoritative: transport-injected PUBMED_TIMEOUT=12345 is decorative in the adapter path ({ ...transport, env } clobbers it), so the DEFAULT_TIMEOUT_MS 30000 from the empty descriptor env arms the timer",
    );
  });
});
