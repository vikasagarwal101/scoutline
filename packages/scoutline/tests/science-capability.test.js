/**
 * Science capability contract — T1 unit tests (RED first).
 *
 * Grounds:
 *   - TASKS T1: `src/capabilities/science.ts` is ONE capability file
 *     (PRD AC-10d), exports the record types (ScienceControls,
 *     ScienceSearchRequest/GetRequest, ScienceWork, ScienceCacheIdentity)
 *     and three capability interfaces (search/get/cite — cite typed,
 *     "ships when needed"). No provider code in T1.
 *   - TASKS T1: unit tests cover validate grammar (year range, identifier
 *     regexes) and empty-query rejection.
 *   - DESIGN D1: `year` accepts closed forms "2020" | "2018:2022" only
 *     (PRD AC-7/AC-7b — empty/bad ranges rejected); `validate` throws
 *     ValidationError on empty query.
 *   - DESIGN D6: identifier grammar = bare DOI `^10\.\d{4,9}/`, numeric
 *     PMID, arXiv `\d{4}\.\d{4,5}` + legacy `cs/…` form; parse once at
 *     the command layer, route to suppliers serving that id type
 *     (PRD AC-4b).
 *   - TASKS T1 scope ruling: `--type` union vocabulary + `component`
 *     rejection live at command parse (T6/D6), NOT in capability
 *     validate() — pinned below as a negative.
 *   - DESIGN D2 listing (via D1 ScienceCacheIdentity.supplier union):
 *     the five supplier ids in D2 order arxiv, openalex, crossref,
 *     pubmed, europepmc (PROVIDER_IDS insertion order; the openalex-first
 *     arm order is D5 executor concern, NOT this constant).
 *
 * The unit-testable seam is the module-level pure grammar helpers the
 * capability interfaces' validate() methods delegate to:
 *   SCIENCE_SUPPLIER_IDS, validateScienceSearchRequest,
 *   validateScienceGetRequest, parseScienceIdentifier.
 * Interface shapes are owned by src/capabilities/science.ts; no build-time
 * pin exists in this ticket — the shape is pinned only once the T2/T3
 * consumers compile against it.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  SCIENCE_SUPPLIER_IDS,
  validateScienceSearchRequest,
  validateScienceGetRequest,
  parseScienceIdentifier,
} from "../dist/capabilities/science.js";
import { ValidationError } from "../dist/lib/errors.js";

// ---------------------------------------------------------------------------
// Module-level constants (D1/D2)
// ---------------------------------------------------------------------------

describe("science capability contract — supplier id constant", () => {
  it("exports the five supplier ids in D2 listing order, frozen", () => {
    // GROUND: TASKS T1 (ScienceCacheIdentity supplier union, D1) + DESIGN
    // D2 listing; PROVIDER_IDS insertion order stays the D2 listing (T2),
    // so this constant must NOT adopt the D5 openalex-first arm order.
    assert.deepStrictEqual([...SCIENCE_SUPPLIER_IDS], [
      "arxiv",
      "openalex",
      "crossref",
      "pubmed",
      "europepmc",
    ]);
    assert.ok(Object.isFrozen(SCIENCE_SUPPLIER_IDS));
  });
});

// ---------------------------------------------------------------------------
// validateScienceSearchRequest — empty-query rejection (D1)
// ---------------------------------------------------------------------------

describe("validateScienceSearchRequest — empty-query rejection", () => {
  it("rejects an empty query with ValidationError (code VALIDATION_ERROR)", () => {
    // GROUND: TASKS T1 "empty-query rejection" + DESIGN D1
    // (SearchCapability.validate contract mirrored for science).
    assert.throws(
      () => validateScienceSearchRequest({ query: "" }),
      (err) => err instanceof ValidationError && err.code === "VALIDATION_ERROR",
    );
  });

  it("rejects a whitespace-only query", () => {
    // GROUND: same as above — D1 says at least one non-whitespace char.
    assert.throws(
      () => validateScienceSearchRequest({ query: "   \t\n  " }),
      ValidationError,
    );
  });

  it("accepts a normal query without controls", () => {
    // GROUND: DESIGN D1 — valid request validates clean (no throw).
    assert.doesNotThrow(() =>
      validateScienceSearchRequest({ query: "attention mechanism" }),
    );
  });

  it("accepts a request carrying author/venue/type controls untouched", () => {
    // GROUND: TASKS T1 — per-control accept/reject is Adapter concern
    // (T3–T5 wire mapping, DESIGN D7); the shared validator owns only
    // query + year grammar. Controls must pass through unjudged here.
    assert.doesNotThrow(() =>
      validateScienceSearchRequest({
        query: "graph transformers",
        controls: { author: "Vaswani", venue: "Nature", type: "review" },
      }),
    );
  });

  it("does NOT reject type:'component' — command parse owns that (T6/D6)", () => {
    // GROUND: TASKS T1 explicit ruling — `--type` union vocabulary +
    // `component` rejection live at command parse in T6/D6, NOT in
    // capability validate(). If this test goes red, the rejection moved
    // into the capability and broke the T1 boundary.
    assert.doesNotThrow(() =>
      validateScienceSearchRequest({
        query: "componentized pipelines",
        controls: { type: "component" },
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// validateScienceSearchRequest — year control grammar (AC-7/AC-7b)
// ---------------------------------------------------------------------------

describe("validateScienceSearchRequest — year grammar (closed forms only)", () => {
  it("accepts a single year '2020'", () => {
    // GROUND: DESIGN D1 year comment "2020" | "2018:2022" (PRD AC-7).
    assert.doesNotThrow(() =>
      validateScienceSearchRequest({ query: "q", controls: { year: "2020" } }),
    );
  });

  it("accepts a closed range '2018:2022'", () => {
    // GROUND: same — the from:to range form (PRD AC-7b).
    assert.doesNotThrow(() =>
      validateScienceSearchRequest({ query: "q", controls: { year: "2018:2022" } }),
    );
  });

  it("rejects malformed single-year forms ('', '20x0', 'abcd', '20')", () => {
    // GROUND: PRD AC-7b — empty/bad values rejected at validate.
    for (const year of ["", "20x0", "abcd", "20"]) {
      assert.throws(
        () => validateScienceSearchRequest({ query: "q", controls: { year } }),
        (err) => err instanceof ValidationError && err.code === "VALIDATION_ERROR",
        `year "${year}" must be rejected`,
      );
    }
  });

  it("rejects malformed range forms (':2020', '2020:', '2018:2022:2024', '2018:22', '22:2018')", () => {
    // GROUND: PRD AC-7b — bad ranges rejected; both endpoints must be
    // 4-digit years in `from:to` shape.
    for (const year of [":2020", "2020:", "2018:2022:2024", "2018:22", "22:2018"]) {
      assert.throws(
        () => validateScienceSearchRequest({ query: "q", controls: { year } }),
        ValidationError,
        `year "${year}" must be rejected`,
      );
    }
  });

  it("rejects a reversed range '2022:2018'", () => {
    // GROUND: PRD AC-7b "bad ranges rejected" — from must not exceed to.
    assert.throws(
      () => validateScienceSearchRequest({ query: "q", controls: { year: "2022:2018" } }),
      ValidationError,
    );
  });
});

// ---------------------------------------------------------------------------
// parseScienceIdentifier — identifier grammar (D6, AC-4b)
// ---------------------------------------------------------------------------

describe("parseScienceIdentifier — grammar classification (D6)", () => {
  it("classifies a bare DOI '10.1038/nature12373' as 'doi'", () => {
    // GROUND: DESIGN D6 bare DOI regex ^10\.\d{4,9}/ (PRD AC-4b, AC-2).
    assert.strictEqual(parseScienceIdentifier("10.1038/nature12373"), "doi");
  });

  it("classifies a numeric PMID '23903748' as 'pmid'", () => {
    // GROUND: DESIGN D6 — PMID numeric (PRD AC-4b).
    assert.strictEqual(parseScienceIdentifier("23903748"), "pmid");
  });

  it("classifies arXiv ids '2401.12345' and '2310.06825' (4-5 digit tail) as 'arxiv'", () => {
    // GROUND: DESIGN D6 arXiv regex \d{4}\.\d{4,5} (PRD AC-4b).
    assert.strictEqual(parseScienceIdentifier("2401.12345"), "arxiv");
    assert.strictEqual(parseScienceIdentifier("2310.06825"), "arxiv");
  });

  it("classifies the legacy 'cs/0501001' form as 'arxiv'", () => {
    // GROUND: DESIGN D6 — legacy `cs/…`-style ids accepted (PRD AC-4b).
    assert.strictEqual(parseScienceIdentifier("cs/0501001"), "arxiv");
  });

  it("returns null for prefixed DOI 'doi:10.1038/nature12373' (bare forms only)", () => {
    // GROUND: DESIGN D6 — the grammar is BARE identifiers; the `doi:`
    // prefix is not one of the accepted closed forms.
    assert.strictEqual(parseScienceIdentifier("doi:10.1038/nature12373"), null);
  });

  it("returns null for '10.12/short' (registrant must be 4-9 digits)", () => {
    // GROUND: DESIGN D6 DOI regex — \d{4,9} after '10.'.
    assert.strictEqual(parseScienceIdentifier("10.12/short"), null);
  });

  it("returns null for '2401.123' (arXiv tail must be 4-5 digits)", () => {
    // GROUND: DESIGN D6 arXiv regex tail \d{4,5}.
    assert.strictEqual(parseScienceIdentifier("2401.123"), null);
  });

  it("returns null for non-numeric junk '12a45'", () => {
    // GROUND: DESIGN D6 — PMID is numeric; alphanumeric junk matches no
    // closed form.
    assert.strictEqual(parseScienceIdentifier("12a45"), null);
  });

  it("returns null for empty and whitespace identifiers", () => {
    // GROUND: DESIGN D1 GetRequest identifier grammar — an empty
    // identifier is not any of the three closed forms.
    assert.strictEqual(parseScienceIdentifier(""), null);
    assert.strictEqual(parseScienceIdentifier("   "), null);
  });
});

// ---------------------------------------------------------------------------
// validateScienceGetRequest (D1)
// ---------------------------------------------------------------------------

describe("validateScienceGetRequest — identifier validation", () => {
  it("accepts a valid DOI identifier (no throw)", () => {
    // GROUND: DESIGN D1 GetCapability.validate — identifier grammar
    // DOI/PMID/arXiv-id; valid ids validate clean.
    assert.doesNotThrow(() =>
      validateScienceGetRequest({ identifier: "10.1038/nature12373" }),
    );
  });

  it("rejects an unparsable identifier with ValidationError", () => {
    // GROUND: DESIGN D1 — validate throws on identifiers outside the
    // grammar (PRD AC-4b closed forms only).
    assert.throws(
      () => validateScienceGetRequest({ identifier: "not-an-identifier" }),
      (err) => err instanceof ValidationError && err.code === "VALIDATION_ERROR",
    );
  });
});
