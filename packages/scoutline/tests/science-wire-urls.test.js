/**
 * Science supplier wire base-URL literal pins (TASKS T5b).
 *
 * GROUND map:
 *   - TASKS T5b: "Test pins the five wire base URLs as LITERAL STRINGS in
 *     the test file itself (not by importing the client's constant — a
 *     self-referential guard proves nothing)": each `it` carries its own
 *     independent literal compared against the client constant imported
 *     from dist/.
 *   - TASKS T5b: "Guards the `audio.crossref.org` corruption class in
 *     D2/D7" / DESIGN D2 corruption note (audit round 1): the original D2
 *     table accidentally listed `https://audio.crossref.org/works` — the
 *     crossref pin below asserts the corrected value AND carries an
 *     explicit notEqual against the corrupted literal so the guarded
 *     defect class is readable in the test itself.
 *   - DESIGN D2 wire table (corrected values) + "Wire base URLs:
 *     module-level constants in each supplier's client, NOT config-file
 *     configurable ... Defaults are pinned by tests for ALL five
 *     suppliers (T5b pattern) — vendor URLs rot (registry audit rule)."
 *   - All five literals re-verified live (HTTP 200) 2026-09-11 before
 *     pinning, per DESIGN D2 corruption note: "Fixers must re-verify all
 *     five URLs against live probes before implementation."
 *
 * Why constants are imported at all: the pin compares the test's
 * independent literal against the module constant, so a corrupted
 * constant (src edit → dist rebuild) fails here while a corrupted test
 * literal alone fails here too — neither side is trusted.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ARXIV_QUERY_URL } from "../dist/providers/arxiv/client.js";
import { OPENALEX_WORKS_URL } from "../dist/providers/openalex/client.js";
import { CROSSREF_WORKS_URL } from "../dist/providers/crossref/client.js";
import { EUTILS_BASE_URL } from "../dist/providers/pubmed/client.js";
import { EUROPEPMC_SEARCH_URL } from "../dist/providers/europepmc/client.js";

describe("science wire base URLs (T5b literal pins)", () => {
  it("arxiv constant is the D2 wire literal (Atom query endpoint)", () => {
    // GROUND: DESIGN D2 supplier table, arxiv row:
    // `https://export.arxiv.org/api/query` Atom XML.
    assert.equal(
      ARXIV_QUERY_URL,
      "https://export.arxiv.org/api/query",
    );
  });

  it("openalex constant is the D2 wire literal (works endpoint)", () => {
    // GROUND: DESIGN D2 supplier table, openalex row:
    // `https://api.openalex.org/works` JSON.
    assert.equal(
      OPENALEX_WORKS_URL,
      "https://api.openalex.org/works",
    );
  });

  it("crossref constant is the CORRECTED D2 wire literal, not the audio.* corruption", () => {
    // GROUND: DESIGN D2 corruption note (audit round 1) — original table
    // listed `https://audio.crossref.org/works` (transcript corruption);
    // correct default is `https://api.crossref.org/works`. The notEqual
    // documents the guarded defect class (TASKS T5b rationale).
    assert.equal(
      CROSSREF_WORKS_URL,
      "https://api.crossref.org/works",
    );
    assert.notEqual(
      CROSSREF_WORKS_URL,
      "https://audio.crossref.org/works",
    );
  });

  it("pubmed constant is the D2 wire literal (eutils base, trailing slash)", () => {
    // GROUND: DESIGN D2 supplier table, pubmed row:
    // `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/` (base verified
    // 2026-09-08, HTTP 200). The trailing slash is load-bearing — the
    // client resolves endpoints via `new URL(endpoint, EUTILS_BASE_URL)`.
    assert.equal(
      EUTILS_BASE_URL,
      "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/",
    );
  });

  it("europepmc constant is the D2 wire literal (REST search endpoint)", () => {
    // GROUND: DESIGN D2 supplier table, europepmc row:
    // `https://www.ebi.ac.uk/europepmc/webservices/rest/search` JSON.
    assert.equal(
      EUROPEPMC_SEARCH_URL,
      "https://www.ebi.ac.uk/europepmc/webservices/rest/search",
    );
  });

  it("all five literals are well-formed absolute https URLs (rot guard)", () => {
    // GROUND: TASKS T5b "wire base-URL sanity guard" — beyond equality,
    // each pinned literal must parse as an absolute https URL so a
    // scheme-less or http-downgraded constant fails loudly.
    const baseUrls = {
      arxiv: ARXIV_QUERY_URL,
      openalex: OPENALEX_WORKS_URL,
      crossref: CROSSREF_WORKS_URL,
      pubmed: EUTILS_BASE_URL,
      europepmc: EUROPEPMC_SEARCH_URL,
    };
    for (const [supplier, value] of Object.entries(baseUrls)) {
      const parsed = new URL(value);
      assert.equal(parsed.protocol, "https:", `${supplier} must be https`);
      assert.ok(parsed.hostname.includes("."), `${supplier} host must be absolute`);
    }
  });
});
