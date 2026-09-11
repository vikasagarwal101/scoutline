/**
 * OpenAlex adapter — T4 RED tests (TASKS T4; DESIGN D2/D7/D10; PRD AC-3,
 * AC-6b, AC-7c, AC-7d).
 *
 * GROUND map (per describe below):
 *   - TASKS T4: "JSON client; abstract inverted-index reconstruct" /
 *     DESIGN D2 supplier table (openalex row: wire
 *     `https://api.openalex.org/works`, JSON; abstract reconstruct).
 *   - TASKS T4: "controls: author+year wire-consumed, venue reject
 *     (probe-closed: no name-based filter, D7), type wire-consumed" /
 *     DESIGN D7 table openalex column (`filter=raw_author_name.search:`,
 *     `filter=from_publication_date`+to, `filter=type:`, venue reject) +
 *     D7 venue ruling (display_name.search 400s — honest
 *     UNSUPPORTED_OPTION, PRD AC-3).
 *   - TASKS T4: "type-VALUE mapping pin (D7 translation table column)" /
 *     DESIGN D7 audit round-2 table — openalex column rewrites article /
 *     preprint / book-chapter / dataset / review / other verbatim;
 *     conference-paper is REJECTED v1 (probe-closed: no such type value,
 *     DESIGN D10 type-vocabulary probe).
 *   - TASKS T4: "House `USER_AGENT` + `mailto=` param whenever no api_key
 *     is present (D2 politeness); tests assert the param on the wire" /
 *     DESIGN D2 politeness bullet.
 *   - TASKS T4: "inverted-index determinism pin" / PRD AC-7c
 *     (reconstruction deterministic and unit-pinned).
 *   - TASKS T4: "mapping pins, identity pins" / PRD AC-7d verbatim wire
 *     evidence (openalex works: id/doi/title/publication_year/authorships/
 *     primary_location/cited_by_count/abstract_inverted_index/open_access/
 *     type) and AC-6b (keyless "" fingerprint; keyed upgrade re-partitions
 *     — D4b note: keyed fingerprint = SHA-256 of the key, house method).
 *   - TASKS T4: "`diagnostics.ts` keyless probe (D2 round-3)" / DESIGN D2
 *     round-3 ruling (doctor probes every always-configured supplier; the
 *     probe is ONE minimal keyless wire call).
 *   - Registry flip: the T2 stub seat's create() throws ("not yet
 *     implemented"); T4 wires the real adapter (registry.ts import
 *     pattern — arXiv precedent).
 *
 * Tests import ../dist/... — verification order is build, then test.
 * No real network: transport fetch is injected (house pattern from
 * tests/arxiv-adapter.test.js).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { createOpenalexDescriptor } from "../dist/providers/openalex/adapter.js";
import { BUILT_IN_PROVIDER_DESCRIPTORS } from "../dist/providers/registry.js";
import { QuotaError, UnsupportedOptionError, ValidationError } from "../dist/lib/errors.js";

// ---------------------------------------------------------------------------
// Fixture — real-shape OpenAlex works JSON (PRD AC-7d verbatim wire
// evidence column). Traps baked in on purpose: top-level `doi` in URL
// form (https://doi.org/… — bare DOI is the normalized house form),
// abstract_inverted_index with a REPEATED word occupying two positions,
// a null abstract on the second work (AC-7c honesty: absent, not
// fabricated), a null pdf_url on work 1 vs a set one on work 2.
// ---------------------------------------------------------------------------

const WORK_DEEP_LEARNING = {
  id: "https://openalex.org/W2756018616",
  doi: "https://doi.org/10.1038/nature12373",
  title: "Deep learning",
  publication_year: 2015,
  authorships: [
    {
      author_position: "first",
      author: { id: "https://openalex.org/A123", display_name: "Yann LeCun" },
    },
    {
      author_position: "last",
      author: { id: "https://openalex.org/A456", display_name: "Geoffrey Hinton" },
    },
  ],
  primary_location: {
    is_published: true,
    landing_page_url: "https://doi.org/10.1038/nature12373",
    pdf_url: null,
    source: {
      id: "https://openalex.org/S137773608",
      display_name: "Nature",
      type: "journal",
    },
  },
  cited_by_count: 44913,
  // "the cat sat on the mat" — "the" holds positions [0, 4]: the
  // reconstruction must place one word per position, not per token entry.
  abstract_inverted_index: { the: [0, 4], cat: [1], sat: [2], on: [3], mat: [5] },
  open_access: { is_oa: true, oa_status: "green" },
  type: "article",
  language: "en",
};

const WORK_GAT = {
  id: "https://openalex.org/W2100837266",
  doi: null,
  title: "Graph attention networks",
  publication_year: 2018,
  authorships: [
    {
      author_position: "first",
      author: { display_name: "Petar Veličković" },
    },
  ],
  primary_location: {
    landing_page_url: "https://arxiv.org/abs/1710.10903",
    pdf_url: "https://arxiv.org/pdf/1710.10903",
    source: {
      display_name: "arXiv (Cornell University Library)",
      type: "repository",
    },
  },
  cited_by_count: 8234,
  abstract_inverted_index: null,
  open_access: { is_oa: false, oa_status: "closed" },
  type: "preprint",
  language: "en",
};

const OPENALEX_SEARCH_RESPONSE = {
  meta: { count: 2, db_response_time_ms: 12, page: 1, per_page: 25 },
  results: [WORK_DEEP_LEARNING, WORK_GAT],
  group_by: [],
};

const OPENALEX_EMPTY_RESPONSE = { meta: { count: 0 }, results: [], group_by: [] };

/** OpenAlex get-by-PMID record (DESIGN D10 ruling 3: `filter=ids.pmid:` works). */
const WORK_BY_PMID = {
  ...WORK_DEEP_LEARNING,
  ids: {
    openalex: "https://openalex.org/W2756018616",
    doi: "https://doi.org/10.1038/nature12373",
    pmid: "https://pubmed.ncbi.nlm.nih.gov/23903748/",
  },
};

/** Response-like double for a JSON body (house pattern). */
function jsonResponse(obj) {
  return {
    ok: true,
    status: 200,
    json: async () => obj,
    text: async () => JSON.stringify(obj),
    headers: { get: () => null },
  };
}

/** Decoded full URL — query encoding (`:`→%3A) must not hide wire params. */
function decodedUrl(url) {
  return decodeURIComponent(String(url));
}

/** Build an adapter with an injected fetch that records every wire call. */
function makeAdapter(json = OPENALEX_SEARCH_RESPONSE, env = {}) {
  const calls = [];
  const descriptor = createOpenalexDescriptor({
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

describe("openalex registry wiring — T2 stub seat flips to the real adapter", () => {
  it("BUILT_IN_PROVIDER_DESCRIPTORS openalex descriptor creates an adapter (stub seat throws)", () => {
    // GROUND: TASKS T4 adapter bullet; registry.ts import pattern
    // (arXiv precedent). The T2 seat's create() throws "not yet
    // implemented"; after T4 the registry must carry the real
    // providers/openalex/adapter.js descriptor.
    const seat = BUILT_IN_PROVIDER_DESCRIPTORS.find((d) => d.id === "openalex");
    assert.ok(seat, "openalex descriptor must be in BUILT_IN_PROVIDER_DESCRIPTORS");
    const adapter = seat.create({ env: {} });
    assert.ok(
      adapter.science,
      "openalex adapter must expose the science slot (ProviderAdapter.science)",
    );
    assert.ok(adapter.science.search, "science.search capability must exist");
    assert.ok(adapter.science.get, "science.get capability must exist");
    assert.ok(adapter.diagnostics, "diagnostics capability must exist (D2 round-3)");
  });

  it('openalex upgrade key model: credentialEnvVars is exactly ["OPENALEX_API_KEY"] (D2)', () => {
    // GROUND: DESIGN D2 credentialEnvVars bullet — openalex carries the
    // optional OPENALEX_API_KEY upgrade; keyless trio carry [].
    const { descriptor } = makeAdapter();
    assert.deepEqual(descriptor.credentialEnvVars, ["OPENALEX_API_KEY"]);
    assert.equal(
      descriptor.isConfigured({}),
      true,
      "keyless-by-default supplier is configured with an empty env",
    );
  });
});

// ---------------------------------------------------------------------------
// Controls — author+year+type wire-consumed, venue rejected (D7)
// ---------------------------------------------------------------------------

describe("openalex search validate/invoke — controls on the wire (TASKS T4; DESIGN D7; PRD AC-3)", () => {
  it("venue is REJECTED at validate with UnsupportedOptionError before any transport call (probe-closed)", () => {
    // GROUND: TASKS T4 "venue reject (probe-closed: no name-based
    // filter, D7)"; DESIGN D7 venue ruling — OpenAlex has NO name-based
    // venue filter (display_name.search 400s on every variant), so the
    // honest v1 behavior is rejection at validation, never
    // accept-and-drop and never post-filter (PRD AC-3).
    const { adapter, calls } = makeAdapter();
    assert.ok(adapter.science);
    assert.throws(
      () => adapter.science.search.validate({ query: "attention", controls: { venue: "Nature" } }),
      (e) =>
        e instanceof UnsupportedOptionError && e.provider === "openalex" && e.option === "venue",
      "controls.venue must be rejected",
    );
    assert.equal(calls.length, 0, "validation must reject before any transport call");
  });

  it("author + year + type are wire-consumed together on the OpenAlex filter param", async () => {
    // GROUND: TASKS T4 "controls: author+year wire-consumed … type
    // wire-consumed"; DESIGN D7 table openalex column:
    // `filter=raw_author_name.search:`, `filter=from_publication_date` +
    // to, `filter=type:`. One search = one logical query = one wire call.
    const { adapter, calls } = makeAdapter();
    await adapter.science.search.invoke({
      query: "attention",
      controls: { author: "Vaswani", year: "2018:2022", type: "article" },
    });
    assert.equal(calls.length, 1, "exactly one wire call per search invoke");
    const wireUrl = new URL(calls[0].url);
    assert.equal(
      wireUrl.origin + wireUrl.pathname,
      "https://api.openalex.org/works",
      "OpenAlex wire base URL (DESIGN D2 supplier table)",
    );
    assert.ok(decodedUrl(calls[0].url).includes("attention"), "query rides the wire");
    const wire = decodedUrl(calls[0].url);
    assert.ok(
      wire.includes("raw_author_name.search:Vaswani"),
      "author control maps to raw_author_name.search (D7)",
    );
    assert.ok(
      wire.includes("from_publication_date:2018") &&
        wire.includes("to_publication_date:2022-12-31"),
      "year range maps to from/to publication date (D7)",
    );
    assert.ok(wire.includes("type:article"), "type control maps to type filter (D7)");
  });

  it("single-year control maps to the same-year from/to pair", async () => {
    // GROUND: DESIGN D7 year row ("filter=from_publication_date + to");
    // PRD AC-7b single year "2020" is one of the two closed forms.
    const { adapter, calls } = makeAdapter();
    await adapter.science.search.invoke({
      query: "attention",
      controls: { year: "2020" },
    });
    const wire = decodedUrl(calls[0].url);
    assert.ok(wire.includes("from_publication_date:2020"), "single year → from");
    assert.ok(
      wire.includes("to_publication_date:2020-12-31"),
      "single year → to (closed form, full year)",
    );
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
// Type VALUE translation — D7 round-2 table, openalex column
// ---------------------------------------------------------------------------

describe("openalex type-VALUE mapping (TASKS T4; DESIGN D7 translation table; PRD AC-7)", () => {
  it("union vocabulary maps to the openalex wire literals column", async () => {
    // GROUND: TASKS T4 "type-VALUE mapping pin (D7 translation table
    // column)". Unlike the other controls, the type VALUE is rewritten
    // per supplier (AC-7d discipline applied to type VALUES). OpenAlex
    // column: article→article, preprint→preprint, chapter→book-chapter,
    // dataset→dataset, review→review, other→other.
    const cases = [
      ["article", "type:article"],
      ["preprint", "type:preprint"],
      ["chapter", "type:book-chapter"],
      ["dataset", "type:dataset"],
      ["review", "type:review"],
      ["other", "type:other"],
    ];
    for (const [unionValue, wireLiteral] of cases) {
      const { adapter, calls } = makeAdapter();
      await adapter.science.search.invoke({
        query: "attention",
        controls: { type: unionValue },
      });
      assert.ok(
        decodedUrl(calls[0].url).includes(wireLiteral),
        `union type "${unionValue}" must map to wire literal "${wireLiteral}"`,
      );
    }
  });

  it("conference-paper is REJECTED v1 — the openalex type vocabulary carries no such value (probe-closed)", () => {
    // GROUND: DESIGN D7 translation table openalex conference-paper cell
    // + DESIGN D10 type-vocabulary probe ("NO conference-paper, NO
    // proceedings-article → conference-paper rejected by openalex").
    // Honest UNSUPPORTED_OPTION, never silent narrowing (PRD AC-3).
    const { adapter, calls } = makeAdapter();
    assert.throws(
      () =>
        adapter.science.search.validate({
          query: "attention",
          controls: { type: "conference-paper" },
        }),
      (e) =>
        e instanceof UnsupportedOptionError && e.provider === "openalex" && e.option === "type",
      "conference-paper must be rejected for openalex",
    );
    assert.equal(calls.length, 0, "rejection happens at validate, before transport");
  });
});

// ---------------------------------------------------------------------------
// Mapping pins — ScienceWork field-for-field (PRD AC-7d)
// ---------------------------------------------------------------------------

describe("openalex search invoke — JSON mapping to ScienceWork (TASKS T4; DESIGN D1/D2; PRD AC-7d)", () => {
  it("maps work 1 field-for-field: title, url, bare doi, authors, year, venue, summary, citationCount, openAccess, type, language", async () => {
    const { adapter, calls } = makeAdapter();
    const works = await adapter.science.search.invoke({ query: "deep learning" });
    assert.equal(calls.length, 1, "exactly one wire call per search invoke");
    assert.equal(works.length, 2, "both fixture results parse");

    const w = works[0];
    assert.equal(w.title, "Deep learning");
    // Landing page is the work's url (DESIGN D1 required field).
    assert.equal(w.url, "https://doi.org/10.1038/nature12373");
    // Top-level `doi` arrives in URL form; the normalized house form is
    // the BARE DOI (round-trips parseScienceIdentifier / science get).
    assert.equal(w.identifiers?.doi, "10.1038/nature12373");
    assert.deepEqual(w.authors, ["Yann LeCun", "Geoffrey Hinton"]);
    assert.equal(w.year, 2015, "publication_year → year");
    assert.equal(w.venue, "Nature", "primary_location.source.display_name → venue");
    assert.equal(w.summary, "the cat sat on the mat", "abstract_inverted_index reconstruct");
    assert.equal(w.citationCount, 44913, "cited_by_count → citationCount (AC-7d wire pin)");
    assert.equal(w.openAccess, true, "open_access.is_oa → openAccess");
    assert.equal(w.type, "article");
    assert.equal(w.language, "en");
    // AC-7c honesty teeth: absent supplier fields stay ABSENT, not
    // undefined-valued keys surviving a deepEqual.
    assert.equal(Object.hasOwn(w, "pdfUrl"), false, "pdf_url null → pdfUrl key absent");
    assert.equal(Object.hasOwn(w, "updated"), false, "openalex carries no updated → key absent");
  });

  it("maps work 2: pdfUrl present when pdf_url is set; summary honestly absent on null abstract (AC-7c)", async () => {
    const { adapter } = makeAdapter();
    const works = await adapter.science.search.invoke({ query: "graph attention" });
    const w = works[1];
    assert.equal(w.title, "Graph attention networks");
    assert.equal(w.pdfUrl, "https://arxiv.org/pdf/1710.10903", "primary_location.pdf_url → pdfUrl");
    assert.equal(
      Object.hasOwn(w, "summary"),
      false,
      "abstract_inverted_index null → summary key absent, never fabricated (AC-7c)",
    );
    assert.equal(
      Object.hasOwn(w.identifiers ?? {}, "doi"),
      false,
      "doi null → no phantom identifiers.doi",
    );
    assert.equal(w.openAccess, false);
    assert.deepEqual(w.authors, ["Petar Veličković"], "unicode author names survive");
  });

  it("a results:[] response maps to an empty array", async () => {
    const { adapter } = makeAdapter(OPENALEX_EMPTY_RESPONSE);
    const works = await adapter.science.search.invoke({ query: "nonexistenttermxyz" });
    assert.deepEqual(works, []);
  });
});

// ---------------------------------------------------------------------------
// Inverted-index determinism (AC-7c)
// ---------------------------------------------------------------------------

describe("openalex abstract_inverted_index reconstruction — deterministic (TASKS T4; PRD AC-7c)", () => {
  it("repeated words occupy their positions; two independent parses deepEqual", async () => {
    // GROUND: TASKS T4 "inverted-index determinism pin"; PRD AC-7c —
    // "OpenAlex abstract-inverted-index reconstruction is deterministic
    // and unit-pinned". The fixture's "the" occupies [0, 4]: a
    // token-entry-ordered reconstruction would produce "the the cat sat
    // on mat"-class corruption; only position-ordered output yields the
    // exact sentence.
    const { adapter } = makeAdapter();
    const first = await adapter.science.search.invoke({ query: "deep learning" });
    const second = await adapter.science.search.invoke({ query: "deep learning" });
    assert.equal(first[0].summary, "the cat sat on the mat");
    assert.deepEqual(second[0].summary, first[0].summary);
    assert.deepEqual(second, first, "two parses of the same index are identical");
  });
});

// ---------------------------------------------------------------------------
// science get — DOI and PMID (DESIGN D10 ruling 3)
// ---------------------------------------------------------------------------

describe("openalex get — DOI and PMID identifiers (TASKS T4; DESIGN D10 ruling 3; PRD AC-2/AC-4b)", () => {
  it("get by bare DOI: one wire call addressing the DOI, one normalized work", async () => {
    // GROUND: DESIGN D10 ruling 3 — DOI direct get verified live
    // (`works/doi:10.1038/nature12373` returns the record); DOI routes
    // to openalex. One identifier-addressed call, not a search.
    const { adapter, calls } = makeAdapter(WORK_DEEP_LEARNING);
    const work = await adapter.science.get.invoke({ identifier: "10.1038/nature12373" });
    assert.equal(calls.length, 1, "exactly one wire call for get");
    assert.equal(
      new URL(calls[0].url).pathname,
      "/works/doi:10.1038/nature12373",
      "DOI get addresses the entity route works/doi:<doi> (D10 ruling 3), not worksdoi:<doi>",
    );
    assert.equal(work.title, "Deep learning");
    assert.equal(work.identifiers?.doi, "10.1038/nature12373");
  });

  it("an EMPTY abstract_inverted_index leaves summary absent, not empty-string (review)", async () => {
    // GROUND: AC-7c — absent supplier fields stay absent. An empty
    // index reconstructs to "" and must be treated as NO abstract
    // (the old guard only rejected undefined and wrote summary: "").
    const emptyIndex = { ...WORK_DEEP_LEARNING, abstract_inverted_index: {} };
    const { adapter } = makeAdapter({ meta: {}, results: [emptyIndex] });
    const works = await adapter.science.search.invoke({ query: "deep" });
    assert.equal(
      Object.hasOwn(works[0], "summary"),
      false,
      "empty inverted index → summary honestly absent (AC-7c)",
    );
  });

  it("a hostile huge inverted-index position neither hangs nor corrupts the abstract (review round 6)", async () => {
    // Review: positions were used as array indexes — a value like 1e9
    // allocated a billion-slot sparse array and pinned the process.
    // Collection + sort must stay bounded and simply drop unsafe slots.
    const hostile = {
      ...WORK_DEEP_LEARNING,
      abstract_inverted_index: {
        Attention: [0, 1_000_000_000],
        All: [1],
        Beyond: [Number.MAX_SAFE_INTEGER + 1],
      },
    };
    const { adapter } = makeAdapter({ meta: {}, results: [hostile] });
    const works = await adapter.science.search.invoke({ query: "deep" });
    // A huge-but-safe position is kept (sorted, bounded work — no
    // billion-slot array); an unsafe (non-integer-representable)
    // position is dropped outright.
    assert.equal(
      works[0].summary,
      "Attention All Attention",
      "huge-but-safe positions reconstruct in order without hanging",
    );
    assert.ok(
      !works[0].summary.includes("Beyond"),
      "unsafe positions are dropped",
    );
  });

  it("get percent-encodes URL-delimiter characters in the DOI route (review)", async () => {
    // Review: a DOI suffix containing `?` or `#` truncated or rerouted
    // the entity path via `new URL`. The route must carry them
    // percent-encoded; the `doi:` prefix colon stays readable.
    const { adapter, calls } = makeAdapter(WORK_DEEP_LEARNING);
    await adapter.science.get.invoke({ identifier: "10.1038/nature12373?fig#1" });
    assert.equal(calls.length, 1);
    assert.equal(
      new URL(calls[0].url).pathname,
      "/works/doi:10.1038/nature12373%3Ffig%231",
      "DOI route delimiters must ride percent-encoded",
    );
  });

  it("get by numeric PMID: ids.pmid filter on the wire, pmid identifier normalized (D10 ruling 3)", async () => {
    // GROUND: DESIGN D10 ruling 3 — `filter=ids.pmid:23903748` verified
    // live (count=1, correct record); PMID routes to openalex. The
    // pubmed URL form of ids.pmid normalizes to the bare numeric PMID
    // (round-trips the AC-4b grammar).
    // Wrapped in the live response envelope (review): the real API
    // answers a filter query with { meta, results }; the DOI fixture
    // stays bare (the bare-record fallback is itself pinned).
    const { adapter, calls } = makeAdapter({ meta: {}, results: [WORK_BY_PMID] });
    const work = await adapter.science.get.invoke({ identifier: "23903748" });
    assert.equal(calls.length, 1, "exactly one wire call for get");
    const href = decodedUrl(calls[0].url);
    assert.ok(
      href.includes("ids.pmid:23903748"),
      "PMID get addresses the ids.pmid filter (D10 verified wire)",
    );
    assert.equal(work.title, "Deep learning");
    assert.equal(work.identifiers?.pmid, "23903748", "bare numeric pmid, not the pubmed URL form");
  });

  it("validate accepts DOI and PMID; out-of-grammar identifiers throw ValidationError", () => {
    // GROUND: DESIGN D1 shared get validator; D10 ruling 3 id routing.
    const { adapter } = makeAdapter();
    assert.doesNotThrow(() => adapter.science.get.validate({ identifier: "10.1038/nature12373" }));
    assert.doesNotThrow(() => adapter.science.get.validate({ identifier: "23903748" }));
    assert.throws(
      () => adapter.science.get.validate({ identifier: "doi:10.1038/nature12373" }),
      (e) => e instanceof ValidationError,
      "prefixed doi: is outside the bare grammar",
    );
    assert.throws(
      () => adapter.science.get.validate({ identifier: "not-an-identifier" }),
      (e) => e instanceof ValidationError,
    );
  });
});

// ---------------------------------------------------------------------------
// Cache identity — keyless "" and keyed SHA-256 re-partition (AC-6b)
// ---------------------------------------------------------------------------

describe('openalex cache identity — keyless "" and keyed re-partition (TASKS T4; DESIGN D1 + D4b note; PRD AC-6b)', () => {
  it('keyless: supplier openalex, capability science.search, fingerprint "", request echoed', () => {
    // GROUND: DESIGN D4b note — keyless `""` fingerprint is the seed-18
    // Q4 ruling (keyless responses are user-independent).
    const { adapter } = makeAdapter();
    const request = { query: "attention", controls: {} };
    const identity = adapter.science.search.cacheIdentity(request);
    assert.equal(identity.supplier, "openalex");
    assert.equal(identity.capability, "science.search");
    assert.equal(identity.credentialFingerprint, "");
    assert.deepEqual(identity.request, request);
  });

  it("keyed: fingerprint is the SHA-256 hex of OPENALEX_API_KEY — keyless and keyed partitions differ (AC-6b)", () => {
    // GROUND: DESIGN D4b note — "When a KEY is present, fingerprint =
    // SHA-256 of the key, house method"; PRD AC-6b — keyed upgrades
    // re-partition. The env key flows through the descriptor's
    // create({ env }) context.
    const key = "test-openalex-key";
    const keyed = makeAdapter(OPENALEX_SEARCH_RESPONSE, { OPENALEX_API_KEY: key }).adapter;
    const keyless = makeAdapter(OPENALEX_SEARCH_RESPONSE, {}).adapter;
    const expected = createHash("sha256").update(key).digest("hex");
    assert.equal(
      keyed.science.search.cacheIdentity({ query: "attention" }).credentialFingerprint,
      expected,
    );
    assert.equal(
      keyless.science.search.cacheIdentity({ query: "attention" }).credentialFingerprint,
      "",
    );
    assert.notEqual(
      keyed.science.search.cacheIdentity({ query: "attention" }).credentialFingerprint,
      keyless.science.search.cacheIdentity({ query: "attention" }).credentialFingerprint,
      "keyed upgrade must re-partition (AC-6b)",
    );
  });

  it('get identity: capability science.get, fingerprint "", identifier echoed', () => {
    const { adapter } = makeAdapter();
    const identity = adapter.science.get.cacheIdentity({ identifier: "10.1038/nature12373" });
    assert.equal(identity.supplier, "openalex");
    assert.equal(identity.capability, "science.get");
    assert.equal(identity.credentialFingerprint, "");
    assert.deepEqual(identity.request, { identifier: "10.1038/nature12373" });
  });
});

// ---------------------------------------------------------------------------
// Politeness — house USER_AGENT always; mailto only when keyless (D2)
// ---------------------------------------------------------------------------

describe("openalex wire politeness — house USER_AGENT + keyless mailto (TASKS T4; DESIGN D2 politeness)", () => {
  it("keyless request: house User-Agent rides and the mailto= param is present on the wire", async () => {
    // GROUND: TASKS T4 "House `USER_AGENT` + `mailto=` param whenever no
    // api_key is present (D2 politeness); tests assert the param on the
    // wire"; DESIGN D2 — every science client sends the house
    // `scoutline/${VERSION}` UA; openalex additionally appends mailto
    // whenever no api_key is present.
    const { adapter, calls } = makeAdapter();
    await adapter.science.search.invoke({ query: "attention" });
    assert.equal(calls.length, 1);
    const headers = calls[0].init?.headers ?? {};
    const ua = headers["User-Agent"];
    assert.ok(
      typeof ua === "string" && ua.startsWith("scoutline/"),
      "house USER_AGENT on the wire",
    );
    const wireUrl = new URL(calls[0].url);
    assert.ok(
      typeof wireUrl.searchParams.get("mailto") === "string" &&
        wireUrl.searchParams.get("mailto") !== "",
      "mailto= param present and non-empty when keyless (D2 politeness)",
    );
    assert.equal(calls[0].init?.method ?? "GET", "GET");
  });

  it("keyed request (OPENALEX_API_KEY): api_key rides the wire and mailto is absent", async () => {
    // GROUND: DESIGN D2 politeness bullet — mailto applies "whenever no
    // api_key is present"; the upgrade key replaces the politeness
    // param. The key must ride the WIRE (query param), not a header
    // invention — OpenAlex consumes api_key as a query param.
    const { adapter, calls } = makeAdapter(OPENALEX_SEARCH_RESPONSE, {
      OPENALEX_API_KEY: "test-openalex-key",
    });
    await adapter.science.search.invoke({ query: "attention" });
    assert.equal(calls.length, 1);
    const wireUrl = new URL(calls[0].url);
    assert.equal(
      wireUrl.searchParams.get("api_key"),
      "test-openalex-key",
      "api_key rides the wire as a query param",
    );
    assert.equal(
      wireUrl.searchParams.get("mailto"),
      null,
      "mailto is the keyless politeness param only",
    );
  });
});

// ---------------------------------------------------------------------------
// Diagnostics — keyless bounded probe smoke (D2 round-3)
// ---------------------------------------------------------------------------

describe("openalex diagnostics — keyless bounded probe (TASKS T4; DESIGN D2 round-3; PRD AC-5)", () => {
  it("probe:false resolves without touching the network", async () => {
    const { adapter, calls } = makeAdapter();
    await adapter.diagnostics.invoke({ probe: false });
    assert.equal(calls.length, 0);
  });

  it("probe:true makes exactly ONE keyless wire call on the works endpoint, politeness included", async () => {
    // GROUND: DESIGN D2 round-3 — doctor probes every always-configured
    // supplier; the probe is ONE minimal keyless wire call on the
    // supplier's endpoint. On an empty env the probe is keyless, so the
    // politeness posture (house UA + mailto) applies to it too.
    const { adapter, calls } = makeAdapter();
    await adapter.diagnostics.invoke({ probe: true });
    assert.equal(calls.length, 1, "exactly one wire call");
    const wireUrl = new URL(calls[0].url);
    assert.equal(
      wireUrl.origin + wireUrl.pathname,
      "https://api.openalex.org/works",
      "probe targets the works endpoint",
    );
    assert.ok(
      typeof wireUrl.searchParams.get("mailto") === "string" &&
        wireUrl.searchParams.get("mailto") !== "",
      "keyless probe carries the mailto politeness param",
    );
    // Review: the works API request parameter is `per-page` —
    // `per_page` is response metadata the server ignores.
    assert.equal(
      wireUrl.searchParams.get("per-page"),
      "1",
      "bounded probe rides the per-page request parameter",
    );
    assert.equal(
      wireUrl.searchParams.get("per_page"),
      null,
      "per_page (response-metadata name) must NOT be sent",
    );
  });

  it("a failing probe rejects (never resolves silently)", async () => {
    const descriptor = createOpenalexDescriptor({
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

describe("OpenAlex 429 — keyless rate limit maps to QuotaError (DESIGN D4b honest class)", () => {
  it("a 429 response rejects with QuotaError and statusCode 429 on search invoke", async () => {
    const descriptor = createOpenalexDescriptor({
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
