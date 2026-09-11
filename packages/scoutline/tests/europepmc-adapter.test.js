/**
 * EuropePMC adapter — T5 RED tests (TASKS T5; DESIGN D2/D4b/D7/D10; PRD AC-2,
 * AC-3, AC-4b, AC-5, AC-6b, AC-7c, AC-7d).
 *
 * GROUND map (per describe below):
 *   - TASKS T5: "JSON client" / DESIGN D2 supplier table (europepmc row:
 *     wire `https://www.ebi.ac.uk/europepmc/webservices/rest/search` JSON,
 *     "none exists" key model, "richest fields" note).
 *   - TASKS T5: "author `AUTH:`, year `PUB_YEAR:`, type `PUB_TYPE:`, venue
 *     reject" / DESIGN D7 table europepmc column (`AUTH:"…"`, `PUB_YEAR:`
 *     range, `PUB_TYPE:`, venue reject) + PRD AC-3 (venue rejected with
 *     UNSUPPORTED_OPTION at validation — never accept-and-drop).
 *   - TASKS T5: "authorString split" + "firstPublicationDate→year" /
 *     PRD AC-7d ("Wire shapes verbatim-pinned: … EuropePMC
 *     `authorString`/`firstPublicationDate`") against the PRD verbatim
 *     EuropePMC core evidence column (id/pmid/doi/title/authorString/
 *     journalTitle/pubYear/firstPublicationDate/citedByCount/
 *     isOpenAccess/language).
 *   - TASKS T5: "type-VALUE mapping pin (D7 translation table column —
 *     e.g. article→`"Journal Article"`)" / DESIGN D7 round-2 translation
 *     table europepmc `PUB_TYPE:` column: "Journal Article" / "Preprint" /
 *     "Conference Paper" / "Book Chapter" / "Dataset" / "Review" /
 *     "Other". EuropePMC consumes ALL seven union values — no rejection
 *     row for it.
 *   - TASKS T5: "`diagnostics.ts` keyless probe (D2 round-3)" / DESIGN
 *     D2 round-3 ruling (doctor probes every always-configured supplier;
 *     the probe is ONE minimal keyless wire call, arXiv max_results=1
 *     precedent).
 *   - Registry flip: the T2 stub seat's create() throws ("not yet
 *     implemented"); T5 wires the real adapter (registry.ts import
 *     pattern — arXiv/OpenAlex/Crossref/PubMed precedent).
 *   - DESIGN D10 ruling 3 (identifier routing): PMID routes to openalex +
 *     europepmc + pubmed (EuropePMC `EXT_ID:… AND SRC:MED` works,
 *     hits=1); DOI routes to all suppliers except arxiv (europepmc
 *     included); arXiv ids do NOT route to europepmc —
 *     UnsupportedOptionError at validate.
 *   - Credential model (DESIGN D2 + D4b note): keyless — no credential
 *     model exists for europepmc, so credentialEnvVars is `[]` and the
 *     cache fingerprint is ALWAYS `""` (keyless responses are
 *     user-independent; no keyed partition exists to re-partition into —
 *     crossref precedent).
 *   - Politeness (DESIGN D2 politeness bullet): every science client
 *     sends the house `USER_AGENT` (`scoutline/${VERSION}`). The
 *     mailto-bearing variants are openalex (query param) and crossref
 *     (UA-carried) specifics; europepmc carries the plain house UA.
 *   - format=json is LOAD-BEARING on the europepmc REST wire: the search
 *     endpoint defaults to XML, so the JSON client must request JSON
 *     explicitly (format=json). Pinned here as a corruption guard.
 *
 * Tests import ../dist/... — verification order is build, then test.
 * No real network: transport fetch is injected (house pattern from
 * tests/openalex-adapter.test.js / crossref-adapter.test.js).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createEuropepmcDescriptor } from "../dist/providers/europepmc/adapter.js";
import { BUILT_IN_PROVIDER_DESCRIPTORS } from "../dist/providers/registry.js";
import {
  QuotaError,
  UnsupportedOptionError,
  ValidationError,
} from "../dist/lib/errors.js";

// ---------------------------------------------------------------------------
// Fixtures — real-shape EuropePMC search JSON. Core fields are the PRD
// verbatim wire evidence column (id/pmid/doi/title/authorString/
// journalTitle/pubYear/firstPublicationDate/citedByCount/isOpenAccess/
// language) plus abstractText (the richest-fields supplier carries
// abstracts). Traps baked in on purpose: a second record with NO
// abstractText and NO journalTitle (absent supplier fields stay absent —
// AC-7c honesty), and no pmid on it (identifiers carry doi only).
// ---------------------------------------------------------------------------

/** Full journal-article record: PMID + DOI + abstract + venue + language. */
const WORK_FULL = {
  id: "36959025",
  source: "MED",
  pmid: "36959025",
  doi: "10.1016/j.jid.2023.02.002",
  title: "T Cells Remember SARS-CoV-2 in Rituximab-Treated Pemphigus Vulgaris.",
  authorString: "Croitoru DO, Piguet V;",
  journalTitle: "The Journal of investigative dermatology",
  journalVolume: "143",
  pubYear: "2023",
  firstPublicationDate: "2023-03-16",
  citedByCount: 12,
  isOpenAccess: "Y",
  language: "eng",
  pubType: "Journal Article",
  abstractText:
    "Rituximab-treated pemphigus vulgaris patients mount SARS-CoV-2-specific T cell responses.",
};

/** Abstractless preprint record: no abstractText, no journalTitle, no pmid. */
const WORK_PREPRINT = {
  id: "PPR426789",
  source: "PPR",
  doi: "10.1101/2020.11.30.402601",
  title: "Graph attention networks: a survey.",
  authorString: "Kim S;",
  pubYear: "2021",
  firstPublicationDate: "2020-11-30",
  citedByCount: 0,
  isOpenAccess: "N",
  language: "eng",
  pubType: "Preprint",
};

const EPMC_SEARCH_RESPONSE = {
  version: "6.9",
  hitCount: 2,
  request: { query: "attention", page: "1", pageSize: "25", format: "json" },
  resultList: { result: [WORK_FULL, WORK_PREPRINT] },
};

const EPMC_EMPTY_RESPONSE = {
  version: "6.9",
  hitCount: 0,
  request: { query: "nonexistenttermxyz", format: "json" },
  resultList: { result: [] },
};

/** Response-like double for a JSON body. */
function jsonResponse(obj) {
  return {
    ok: true,
    status: 200,
    json: async () => obj,
    text: async () => JSON.stringify(obj),
    headers: { get: () => null },
  };
}

/** Decoded full URL — query encoding (+ and %22) must not hide wire terms. */
function decodedUrl(url) {
  return decodeURIComponent(String(url).replace(/\+/g, " "));
}

/** Build an adapter with an injected fetch that records every wire call. */
function makeAdapter(json = EPMC_SEARCH_RESPONSE, env = {}) {
  const calls = [];
  const descriptor = createEuropepmcDescriptor({
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

describe("europepmc registry wiring — T2 stub seat flips to the real adapter", () => {
  it("BUILT_IN_PROVIDER_DESCRIPTORS europepmc descriptor creates an adapter (stub seat throws)", () => {
    // GROUND: TASKS T5 adapter bullet; registry.ts import pattern
    // (arXiv/OpenAlex/Crossref/PubMed precedent). The T2 seat's create()
    // throws "not yet implemented" and registry.ts still imports
    // createEuropepmcDescriptor from ./types.js; after T5 the registry must
    // carry the real providers/europepmc/adapter.js descriptor.
    const seat = BUILT_IN_PROVIDER_DESCRIPTORS.find((d) => d.id === "europepmc");
    assert.ok(seat, "europepmc descriptor must be in BUILT_IN_PROVIDER_DESCRIPTORS");
    const adapter = seat.create({ env: {} });
    assert.ok(adapter.science, "europepmc adapter must expose the science slot");
    assert.ok(adapter.science.search, "science.search capability must exist");
    assert.ok(adapter.science.get, "science.get capability must exist");
    assert.ok(adapter.diagnostics, "diagnostics capability must exist (D2 round-3)");
  });

  it("europepmc has NO key model: credentialEnvVars is exactly [], keyless configured, quota never listed", () => {
    // GROUND: DESIGN D2 supplier table (europepmc key model "none exists")
    // + D2 credentialEnvVars bullet ("[]" for arxiv/europepmc/crossref) +
    // PRD AC-5 round-5 scope pin (isConfigured keyless-true ONLY for the
    // no-capability form and the science set + diagnostics — never
    // `quota`, so the quota dashboard filter never lists it).
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
    assert.equal(descriptor.isConfigured({}, "science.get"), true);
    assert.equal(descriptor.isConfigured({}, "diagnostics"), true);
  });
});

// ---------------------------------------------------------------------------
// Controls — author AUTH:, year PUB_YEAR:, type PUB_TYPE:, venue REJECT (D7)
// ---------------------------------------------------------------------------

describe("europepmc controls — D7 europepmc column (TASKS T5; DESIGN D7; PRD AC-3)", () => {
  it("author + year + type are wire-consumed together on ONE search call; format=json rides the wire", async () => {
    // GROUND: TASKS T5 "author `AUTH:`, year `PUB_YEAR:`, type `PUB_TYPE:`";
    // DESIGN D7 table europepmc column — author `AUTH:"…"`, year `PUB_YEAR:`
    // range, type `PUB_TYPE:`. One search = one logical query = one wire
    // call (no two-step here — europepmc is a single JSON endpoint, D2).
    // format=json is pinned because the europepmc REST search endpoint
    // defaults to XML; a client that forgets it parses XML at runtime.
    const { adapter, calls } = makeAdapter();
    await adapter.science.search.invoke({
      query: "attention",
      controls: { author: "Vaswani", year: "2018:2022", type: "article" },
    });
    assert.equal(calls.length, 1, "exactly one wire call per search invoke");
    const wireUrl = new URL(calls[0].url);
    assert.equal(
      wireUrl.origin + wireUrl.pathname,
      "https://www.ebi.ac.uk/europepmc/webservices/rest/search",
      "EuropePMC wire base URL (DESIGN D2 supplier table)",
    );
    assert.equal(
      wireUrl.searchParams.get("format"),
      "json",
      "JSON requested explicitly — the search endpoint defaults to XML",
    );
    const wire = decodedUrl(calls[0].url);
    assert.ok(wire.includes("attention"), "query rides the wire");
    assert.ok(
      wire.includes('AUTH:"Vaswani"'),
      "author control maps to AUTH:\"…\" (D7 europepmc column)",
    );
    assert.ok(
      wire.includes("PUB_YEAR:[2018 TO 2022]"),
      "year range maps to PUB_YEAR:[from TO to] (D7 europepmc range)",
    );
    assert.ok(
      wire.includes('PUB_TYPE:"Journal Article"'),
      "type control maps to PUB_TYPE:\"…\" with the D7 round-2 wire literal",
    );
  });

  it("single-year control maps to the closed single-year PUB_YEAR form", async () => {
    // GROUND: DESIGN D7 year row + PRD AC-7b single year "2020" is one of
    // the two closed forms.
    const { adapter, calls } = makeAdapter();
    await adapter.science.search.invoke({
      query: "attention",
      controls: { year: "2020" },
    });
    const wire = decodedUrl(calls[0].url);
    assert.ok(
      wire.includes("PUB_YEAR:2020"),
      "single year → PUB_YEAR:2020 (closed form)",
    );
  });

  it("venue is REJECTED at validate with UnsupportedOptionError, before any transport call", async () => {
    // GROUND: DESIGN D7 venue row (europepmc column: reject) + PRD AC-3 —
    // UNSUPPORTED_OPTION at validation, never accept-and-drop, never
    // silent post-filtering. D5/D7 venue ruling: `--venue` is
    // crossref-only in v1.
    const { adapter, calls } = makeAdapter();
    assert.throws(
      () => adapter.science.search.validate({ query: "attention", controls: { venue: "Nature" } }),
      (e) =>
        e instanceof UnsupportedOptionError &&
        e.provider === "europepmc" &&
        e.option === "venue",
    );
    await assert.rejects(
      adapter.science.search.invoke({ query: "attention", controls: { venue: "Nature" } }),
    );
    assert.equal(calls.length, 0, "rejection before any transport call");
  });

  it("empty query and reversed year range throw ValidationError through the adapter's validate", () => {
    // GROUND: DESIGN D1 shared validator (query non-whitespace; year
    // closed forms, reversed rejected — PRD AC-7b) reached through the
    // adapter's validate delegation (openalex/crossref/pubmed precedent).
    const { adapter } = makeAdapter();
    assert.doesNotThrow(() => adapter.science.search.validate({ query: "attention" }));
    assert.throws(
      () => adapter.science.search.validate({ query: "   " }),
      (e) => e instanceof ValidationError,
    );
    assert.throws(
      () => adapter.science.search.validate({ query: "attention", controls: { year: "2022:2018" } }),
      (e) => e instanceof ValidationError,
      "reversed range is rejected at validate (PRD AC-7b)",
    );
  });
});

// ---------------------------------------------------------------------------
// Type VALUE translation — D7 round-2 table, europepmc PUB_TYPE column
// ---------------------------------------------------------------------------

describe("europepmc type-VALUE mapping (TASKS T5; DESIGN D7 translation table; PRD AC-7)", () => {
  it("union vocabulary maps to the europepmc PUB_TYPE wire literals column — all seven values consumed", async () => {
    // GROUND: TASKS T5 — "type-VALUE mapping pin (D7 translation table
    // column — e.g. article→`"Journal Article"`)". The type VALUE is
    // rewritten per supplier (AC-7d discipline applied to type VALUES).
    // EuropePMC column (quoted literals): article→"Journal Article",
    // preprint→"Preprint", conference-paper→"Conference Paper",
    // chapter→"Book Chapter", dataset→"Dataset", review→"Review",
    // other→"Other".
    const cases = [
      ["article", 'PUB_TYPE:"Journal Article"'],
      ["preprint", 'PUB_TYPE:"Preprint"'],
      ["conference-paper", 'PUB_TYPE:"Conference Paper"'],
      ["chapter", 'PUB_TYPE:"Book Chapter"'],
      ["dataset", 'PUB_TYPE:"Dataset"'],
      ["review", 'PUB_TYPE:"Review"'],
      ["other", 'PUB_TYPE:"Other"'],
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
        e instanceof UnsupportedOptionError &&
        e.provider === "europepmc" &&
        e.option === "type",
    );
    await assert.rejects(
      adapter.science.search.invoke({ query: "x", controls: { type: "bogus" } }),
    );
    assert.equal(calls.length, 0, "rejection before any transport call");
  });
});

// ---------------------------------------------------------------------------
// Mapping pins — authorString/firstPublicationDate and the core fields (AC-7d)
// ---------------------------------------------------------------------------

describe("europepmc search invoke — JSON mapping to ScienceWork (TASKS T5; PRD AC-7d/AC-7c)", () => {
  it("maps the full record field-for-field: title, url, identifiers (pmid+doi), authorString, firstPublicationDate, journalTitle, abstractText, citedByCount, language, openAccess", async () => {
    // GROUND: PRD AC-7d — "Wire shapes verbatim-pinned: … EuropePMC
    // `authorString`/`firstPublicationDate`" plus the verbatim core
    // evidence column (id/pmid/doi/title/authorString/journalTitle/
    // citedByCount/isOpenAccess/language). TASKS T5 names the two tricky
    // pins: authorString → authors[] (split), firstPublicationDate → year.
    const { adapter, calls } = makeAdapter();
    const works = await adapter.science.search.invoke({ query: "attention" });
    assert.equal(calls.length, 1, "exactly one wire call per search invoke");
    assert.equal(works.length, 2, "both records mapped");

    const w = works[0];
    assert.equal(
      w.title,
      "T Cells Remember SARS-CoV-2 in Rituximab-Treated Pemphigus Vulgaris.",
    );
    assert.equal(w.identifiers?.pmid, "36959025", "pmid → identifiers.pmid");
    assert.equal(w.identifiers?.doi, "10.1016/j.jid.2023.02.002", "doi → identifiers.doi");
    assert.deepEqual(
      w.authors,
      ["Croitoru DO", "Piguet V"],
      "authorString split: comma-separated, trailing semicolon stripped (TASKS T5)",
    );
    assert.equal(
      w.year,
      2023,
      "firstPublicationDate \"2023-03-16\" → year 2023 (TASKS T5 pin; NOT the pubYear string)",
    );
    assert.equal(w.venue, "The Journal of investigative dermatology", "journalTitle → venue");
    assert.equal(
      w.summary,
      "Rituximab-treated pemphigus vulgaris patients mount SARS-CoV-2-specific T cell responses.",
      "abstractText → summary (richest-fields supplier carries abstracts)",
    );
    assert.equal(w.citationCount, 12, "citedByCount → citationCount (AC-7d)");
    assert.equal(w.language, "eng", "language → language");
    assert.equal(w.openAccess, true, 'isOpenAccess "Y" → openAccess true');
    assert.ok(
      typeof w.url === "string" && w.url.includes("36959025"),
      "url is PMID-addressed (the europepmc landing identity for a MED record)",
    );
  });

  it("absent abstractText and absent journalTitle stay honestly absent — never undefined-valued, never fabricated", async () => {
    // GROUND: PRD AC-7c honesty teeth applied to the preprint record: no
    // abstractText, no journalTitle, and NO pmid (identifiers carry doi
    // only).
    const { adapter } = makeAdapter();
    const works = await adapter.science.search.invoke({ query: "graph attention" });
    const w = works.find((x) => x.title === "Graph attention networks: a survey.");
    assert.ok(w, "abstractless preprint record present");
    assert.equal(
      Object.hasOwn(w, "summary"),
      false,
      "no abstractText → summary honestly absent (AC-7c)",
    );
    assert.equal(Object.hasOwn(w, "venue"), false, "no journalTitle → venue key absent");
    assert.equal(
      w.identifiers?.pmid,
      undefined,
      "no pmid on the preprint → identifiers.pmid absent",
    );
    assert.equal(w.identifiers?.doi, "10.1101/2020.11.30.402601");
    assert.deepEqual(w.authors, ["Kim S"], "single-author authorString splits to one entry");
    assert.equal(w.year, 2020, "firstPublicationDate \"2020-11-30\" → year 2020");
  });

  it("an empty result list maps to an empty array", async () => {
    const { adapter } = makeAdapter(EPMC_EMPTY_RESPONSE);
    const works = await adapter.science.search.invoke({ query: "nonexistenttermxyz" });
    assert.deepEqual(works, []);
  });
});

// ---------------------------------------------------------------------------
// science get — DOI and PMID, never arXiv (DESIGN D10 ruling 3)
// ---------------------------------------------------------------------------

describe("europepmc get — DOI and PMID identifiers, never arXiv (TASKS T5; DESIGN D10 ruling 3; PRD AC-2/AC-4b)", () => {
  it("get by bare PMID: one wire call with EXT_ID:… AND SRC:MED, one normalized work", async () => {
    // GROUND: DESIGN D10 ruling 3 — PMID routes to openalex + europepmc +
    // pubmed; "EuropePMC `EXT_ID:… AND SRC:MED` works (hits=1)" is the
    // probed wire. Identifier-addressed get = ONE search call carrying
    // the id term, then the first record maps.
    const { adapter, calls } = makeAdapter();
    const work = await adapter.science.get.invoke({ identifier: "36959025" });
    assert.equal(calls.length, 1, "exactly one wire call for get");
    const wire = decodedUrl(calls[0].url);
    const wireUrl = new URL(calls[0].url);
    assert.equal(
      wireUrl.origin + wireUrl.pathname,
      "https://www.ebi.ac.uk/europepmc/webservices/rest/search",
      "get rides the same search endpoint (D2 europepmc row)",
    );
    assert.ok(
      wire.includes("EXT_ID:36959025"),
      "PMID addresses the get through the probed EXT_ID term (D10 ruling 3)",
    );
    assert.ok(wire.includes("SRC:MED"), "MED source term present (D10 ruling 3 probe shape)");
    assert.equal(work.identifiers?.pmid, "36959025");
    assert.equal(
      work.title,
      "T Cells Remember SARS-CoV-2 in Rituximab-Treated Pemphigus Vulgaris.",
    );
  });

  it("get by bare DOI: one wire call addressing the DOI, one normalized work", async () => {
    // GROUND: DESIGN D10 ruling 3 — DOI routes to all suppliers except
    // arxiv (europepmc included).
    const { adapter, calls } = makeAdapter();
    const work = await adapter.science.get.invoke({
      identifier: "10.1016/j.jid.2023.02.002",
    });
    assert.equal(calls.length, 1, "exactly one wire call for get");
    assert.ok(
      decodedUrl(calls[0].url).includes("10.1016/j.jid.2023.02.002"),
      "the DOI rides the get call's wire",
    );
    assert.equal(work.identifiers?.doi, "10.1016/j.jid.2023.02.002");
  });

  it("validate rejects arXiv ids (UnsupportedOptionError); out-of-grammar throws ValidationError; DOI and PMID pass", () => {
    // GROUND: DESIGN D10 ruling 3 — arXiv ids route to the arxiv adapter
    // only; DOI routes to all except arxiv, PMID to openalex + europepmc +
    // pubmed. A bare arXiv id passes the shared grammar but is not
    // servable by europepmc → UnsupportedOptionError (crossref/pubmed
    // precedent for the identifier option); out-of-grammar strings throw
    // the shared ValidationError (D1).
    const { adapter } = makeAdapter();
    assert.doesNotThrow(() =>
      adapter.science.get.validate({ identifier: "10.1016/j.jid.2023.02.002" }),
    );
    assert.doesNotThrow(() => adapter.science.get.validate({ identifier: "36959025" }));
    assert.throws(
      () => adapter.science.get.validate({ identifier: "2401.12345" }),
      (e) =>
        e instanceof UnsupportedOptionError &&
        e.provider === "europepmc" &&
        e.option === "identifier",
      "arXiv id does not route to europepmc (D10 ruling 3)",
    );
    assert.throws(
      () => adapter.science.get.validate({ identifier: "pmcid:PMC1234567" }),
      (e) => e instanceof ValidationError,
      "prefixed pmcid: is outside the bare grammar",
    );
  });

  it("get with an unresolvable id (hitCount 0) fails loud, never an empty result", async () => {
    // GROUND: PRD AC-2 — science get returns ONE work or fails; a
    // zero-record lookup is a 404-class error, not an empty array.
    const { adapter } = makeAdapter(EPMC_EMPTY_RESPONSE);
    await assert.rejects(
      adapter.science.get.invoke({ identifier: "10.9999/nonexistent.doi" }),
      (e) => e instanceof Error,
    );
  });
});

// ---------------------------------------------------------------------------
// Cache identity — always keyless "" (no key model exists, D2)
// ---------------------------------------------------------------------------

describe("europepmc cache identity — always keyless \"\" (TASKS T5; DESIGN D1 + D4b note; PRD AC-6b)", () => {
  it("search identity: supplier europepmc, capability science.search, fingerprint \"\", request echoed", () => {
    // GROUND: DESIGN D4b note — keyless `""` fingerprint is the seed-18
    // Q4 ruling (keyless responses are user-independent). EuropePMC has
    // no key model at all (D2 table), so the fingerprint is ALWAYS "" —
    // there is no keyed partition to re-partition into (crossref
    // precedent).
    const { adapter } = makeAdapter();
    const request = { query: "attention", controls: {} };
    const identity = adapter.science.search.cacheIdentity(request);
    assert.equal(identity.supplier, "europepmc");
    assert.equal(identity.capability, "science.search");
    assert.equal(identity.credentialFingerprint, "");
    assert.deepEqual(identity.request, request);
  });

  it("get identity: capability science.get, fingerprint \"\", identifier echoed", () => {
    const { adapter } = makeAdapter();
    const identity = adapter.science.get.cacheIdentity({ identifier: "36959025" });
    assert.equal(identity.supplier, "europepmc");
    assert.equal(identity.capability, "science.get");
    assert.equal(identity.credentialFingerprint, "");
    assert.deepEqual(identity.request, { identifier: "36959025" });
  });
});

// ---------------------------------------------------------------------------
// Politeness — plain house USER_AGENT (D2 politeness bullet)
// ---------------------------------------------------------------------------

describe("europepmc wire politeness — house USER_AGENT (TASKS T5; DESIGN D2 politeness)", () => {
  it("every request sends the house UA; no key model means no conditional posture", async () => {
    // GROUND: DESIGN D2 politeness bullet — "every science client sends
    // the house `USER_AGENT` (`scoutline/${VERSION}`)". The mailto
    // variants are openalex (query param) and crossref (UA-carried)
    // specifics; europepmc carries the plain house UA on every request.
    const { adapter, calls } = makeAdapter();
    await adapter.science.search.invoke({ query: "attention" });
    assert.equal(calls.length, 1);
    const headers = calls[0].init?.headers ?? {};
    const ua = headers["User-Agent"];
    assert.ok(
      typeof ua === "string" && ua.startsWith("scoutline/"),
      "house USER_AGENT on the wire",
    );
    assert.equal(calls[0].init?.method ?? "GET", "GET");
  });
});

// ---------------------------------------------------------------------------
// Diagnostics — keyless bounded probe smoke (D2 round-3)
// ---------------------------------------------------------------------------

describe("europepmc diagnostics — keyless bounded probe (TASKS T5; DESIGN D2 round-3; PRD AC-5)", () => {
  it("probe:false resolves without touching the network", async () => {
    const { adapter, calls } = makeAdapter();
    await adapter.diagnostics.invoke({ probe: false });
    assert.equal(calls.length, 0);
  });

  it("probe:true makes exactly ONE bounded keyless wire call on the search endpoint, pageSize bounded", async () => {
    // GROUND: DESIGN D2 round-3 — doctor probes every always-configured
    // science supplier; the probe is ONE minimal keyless wire call
    // (arXiv max_results=1 precedent). On the europepmc wire the cheapest
    // bounded call is the search endpoint with pageSize=1.
    const { adapter, calls } = makeAdapter();
    await adapter.diagnostics.invoke({ probe: true });
    assert.equal(calls.length, 1, "exactly one wire call");
    const wireUrl = new URL(calls[0].url);
    assert.equal(
      wireUrl.origin + wireUrl.pathname,
      "https://www.ebi.ac.uk/europepmc/webservices/rest/search",
      "probe targets the search endpoint",
    );
    assert.equal(
      wireUrl.searchParams.get("pageSize"),
      "1",
      "probe is bounded — pageSize=1, never a full search",
    );
    assert.equal(wireUrl.searchParams.get("query"), "*", "probe carries a valid search criterion");
  });

  it("a failing probe rejects (never resolves silently)", async () => {
    const descriptor = createEuropepmcDescriptor({
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

describe("Europe PMC 429 — keyless rate limit maps to QuotaError (DESIGN D4b honest class)", () => {
  it("a 429 response rejects with QuotaError and statusCode 429 on search invoke", async () => {
    const descriptor = createEuropepmcDescriptor({
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
