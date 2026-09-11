/**
 * Science Capability Contract (DESIGN D1; PRD AC-10d).
 *
 * One capability file, house shape mirroring `search.ts`. Declares the
 * Provider-neutral meaning shared by every science supplier: the control
 * record, search/get request shapes, the normalized `ScienceWork` result,
 * the supplier-partitioned cache identity, and the three capability
 * interfaces (search/get/cite). This ticket ships ONLY the contract — no
 * Provider, transport, or Adapter code lives here.
 *
 * Interfaces are compile-time only, so the validate() grammars are
 * implemented as exported pure helpers (`validateScienceSearchRequest`,
 * `validateScienceGetRequest`, `parseScienceIdentifier`) that the
 * interfaces' validate() methods delegate to.
 *
 * Scope rulings encoded here:
 *   - `year` accepts ONLY the closed forms "2020" | "2018:2022"
 *     (PRD AC-7/AC-7b). Empty, malformed, and reversed ranges throw.
 *   - The shared validator judges ONLY `query` + `year`. `author`,
 *     `venue`, and `type` pass through unjudged — per-control
 *     accept/reject is the Adapter concern, and the `--type` union
 *     vocabulary (including `component` rejection) lives at command
 *     parse, never here.
 *   - Identifier grammar is BARE forms only: DOI `^10\.\d{4,9}/`,
 *     numeric PMID, arXiv `\d{4}\.\d{4,5}` plus the legacy
 *     `archive/number` form (e.g. `cs/0501001`). A `doi:` prefix is not
 *     one of the closed forms. Parsed once at the command layer.
 */

import { ValidationError } from "../lib/errors.js";

// ---------------------------------------------------------------------------
// Suppliers
// ---------------------------------------------------------------------------

/**
 * The five science supplier ids, in the design listing order. This is the
 * PROVIDER_IDS insertion order, NOT the fan-out arm order (the
 * openalex-first arm ordering is an executor concern).
 */
export const SCIENCE_SUPPLIER_IDS: readonly [
  "arxiv",
  "openalex",
  "crossref",
  "pubmed",
  "europepmc",
] = Object.freeze(["arxiv", "openalex", "crossref", "pubmed", "europepmc"]);

/** A science supplier id. */
export type ScienceSupplierId = (typeof SCIENCE_SUPPLIER_IDS)[number];

// ---------------------------------------------------------------------------
// Requests and controls
// ---------------------------------------------------------------------------

/**
 * Science search controls. Every field is optional. The shared validator
 * judges only `year`; `author`/`venue`/`type` are Adapter-mapped and pass
 * through unjudged at this layer.
 */
export interface ScienceControls {
  /** Author filter; wire-consumed by openalex, crossref, pubmed. */
  author?: string;
  /** Closed forms only: "2020" | "2018:2022" (PRD AC-7/AC-7b). */
  year?: string;
  /** Venue filter; openalex and crossref native. */
  venue?: string;
  /** Content type; every supplier carries its own vocabulary. */
  type?: string;
}

/**
 * A science search request. `query` must contain at least one
 * non-whitespace character; `validate` throws `ValidationError`
 * otherwise.
 */
export interface ScienceSearchRequest {
  query: string;
  controls?: Readonly<ScienceControls>;
}

/**
 * A science get request. `identifier` must be one of the bare closed
 * forms (DOI, numeric PMID, arXiv id — see `parseScienceIdentifier`).
 */
export interface ScienceGetRequest {
  identifier: string;
}

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/**
 * Normalized science work. Adapters populate this from their supplier
 * response; commands merge, deduplicate, project, and present
 * downstream. Supplier-only fields are discarded. Every field except
 * `title` and `url` is optional — suppliers differ in coverage (e.g.
 * Crossref lacks abstracts; arXiv serves preprints only).
 */
export interface ScienceWork {
  title: string;
  url: string;
  /** Persistent identifiers as supplied by the responding source. */
  identifiers?: { doi?: string; pmid?: string; arxivId?: string };
  authors?: string[];
  year?: number;
  venue?: string;
  /** Abstract; absent when the supplier carries none. */
  summary?: string;
  citationCount?: number;
  pdfUrl?: string;
  openAccess?: boolean;
  type?: string;
  language?: string;
  updated?: string;
}

// ---------------------------------------------------------------------------
// Cache identity
// ---------------------------------------------------------------------------

/**
 * Identity used to read and write a supplier-partitioned science cache
 * entry. `credentialFingerprint` is the full lowercase SHA-256 hex digest
 * of the active credential, or the empty string for keyless suppliers
 * (keyless responses are user-independent, so the shared partition is
 * correct). `request` is the normalized Capability request.
 */
export interface ScienceCacheIdentity {
  readonly supplier: ScienceSupplierId;
  readonly capability: "science.search" | "science.get" | "science.cite";
  readonly credentialFingerprint: string;
  readonly request: Readonly<ScienceSearchRequest | ScienceGetRequest>;
}

// ---------------------------------------------------------------------------
// Capability interfaces
// ---------------------------------------------------------------------------

/**
 * Science search Capability contract. Every supplier Adapter that
 * supports search implements this interface and is consumed by the
 * science executor.
 */
export interface ScienceSearchCapability {
  /**
   * Validate a request before any supplier access. Throws
   * `ValidationError` for an empty or whitespace-only query and for a
   * malformed `year` control; `UnsupportedOptionError` for controls the
   * Adapter does not accept. Validation must occur before transport
   * construction.
   */
  validate(request: ScienceSearchRequest): void;
  /** Build the cache identity; called only after `validate` succeeds. */
  cacheIdentity(request: ScienceSearchRequest): ScienceCacheIdentity;
  /** Invoke the supplier and return normalized works; no retries here. */
  invoke(
    request: ScienceSearchRequest,
    signal?: AbortSignal,
  ): Promise<readonly ScienceWork[]>;
}

/**
 * Science get Capability contract. Identifier-addressed single-work
 * fetch: the identifier is parsed once (DOI/PMID/arXiv-id) and routed to
 * suppliers serving that id type.
 */
export interface ScienceGetCapability {
  /**
   * Validate a request before any supplier access. Throws
   * `ValidationError` when the identifier is outside the grammar
   * (`parseScienceIdentifier` returns null).
   */
  validate(request: ScienceGetRequest): void;
  /** Build the cache identity; called only after `validate` succeeds. */
  cacheIdentity(request: ScienceGetRequest): ScienceCacheIdentity;
  /** Invoke the supplier and return one normalized work; no retries here. */
  invoke(request: ScienceGetRequest, signal?: AbortSignal): Promise<ScienceWork>;
}

/**
 * Science cite Capability contract. Typed but not shipped in v1 (PRD
 * Non-goal: no science cite) — the type exists so provider descriptors
 * can reference it later without contract churn. Ships when needed.
 */
export interface ScienceCiteCapability {
  /** Identifier grammar plus citation direction. */
  validate(request: ScienceGetRequest): void;
  cacheIdentity(request: ScienceGetRequest): ScienceCacheIdentity;
  invoke(
    request: ScienceGetRequest,
    signal?: AbortSignal,
  ): Promise<readonly ScienceWork[]>;
}

/**
 * The science Capability surface an Adapter exposes. `cite` is named in
 * the contract but ships later; it is absent here in v1.
 */
export interface ScienceCapability {
  search: ScienceSearchCapability;
  get: ScienceGetCapability;
  // cite: named in contract, ships when needed (v2)
}

// ---------------------------------------------------------------------------
// Year grammar (PRD AC-7/AC-7b)
// ---------------------------------------------------------------------------

/** Single year "2020" or closed range "2018:2022"; nothing else. */
const SCIENCE_YEAR_PATTERN = /^(\d{4})(?::(\d{4}))?$/;

function validateScienceYear(year: string): void {
  const match = SCIENCE_YEAR_PATTERN.exec(year);
  if (!match) {
    throw new ValidationError(
      `Invalid year "${year}": expected a year "2020" or closed range "2018:2022"`,
    );
  }
  const from = match[1];
  const to = match[2];
  if (to !== undefined && Number(from) > Number(to)) {
    throw new ValidationError(
      `Invalid year range "${year}": the start year must not exceed the end year`,
    );
  }
}

// ---------------------------------------------------------------------------
// Identifier grammar (DESIGN D6; PRD AC-4b)
// ---------------------------------------------------------------------------

/** The identifier kinds the closed grammar recognizes. */
export type ScienceIdentifierKind = "doi" | "pmid" | "arxiv";

/** Bare DOI: `10.` registrant (4-9 digits) then a slash suffix. */
const BARE_DOI_PATTERN = /^10\.\d{4,9}\/.+$/;
/** Modern arXiv id: YYMM.NNNNN (4-digit head, 4-5 digit tail). */
const ARXIV_ID_PATTERN = /^\d{4}\.\d{4,5}$/;
/** Legacy arXiv id: archive/YYMMNNN (e.g. `cs/0501001`). */
const ARXIV_LEGACY_PATTERN = /^[a-z][a-z-]*\/\d{7}$/;
/** Numeric PMID. */
const PMID_PATTERN = /^\d+$/;

/**
 * Classify a bare science identifier. Returns `"doi"`, `"pmid"`, or
 * `"arxiv"` when the identifier matches one of the closed forms, null
 * otherwise. Bare forms only — prefixed input (e.g. `doi:10.1038/…`)
 * returns null. Parsed once at the command layer; routing to suppliers
 * serving that id type happens downstream.
 */
export function parseScienceIdentifier(
  identifier: string,
): ScienceIdentifierKind | null {
  if (BARE_DOI_PATTERN.test(identifier)) return "doi";
  if (ARXIV_ID_PATTERN.test(identifier)) return "arxiv";
  if (ARXIV_LEGACY_PATTERN.test(identifier)) return "arxiv";
  if (PMID_PATTERN.test(identifier)) return "pmid";
  return null;
}

// ---------------------------------------------------------------------------
// Shared validate helpers
// ---------------------------------------------------------------------------

/**
 * Validate a science search request. Judges only the `query` (at least
 * one non-whitespace character) and the `year` control grammar.
 * `author`, `venue`, and `type` pass through unjudged — per-control
 * accept/reject is the Adapter concern.
 */
export function validateScienceSearchRequest(
  request: ScienceSearchRequest,
): void {
  if (typeof request.query !== "string" || request.query.trim() === "") {
    throw new ValidationError("Query must contain at least one non-whitespace character");
  }
  const year = request.controls?.year;
  if (year !== undefined) {
    validateScienceYear(year);
  }
}

/**
 * Validate a science get request. The identifier must be one of the bare
 * closed forms (`parseScienceIdentifier` non-null); anything outside the
 * grammar throws `ValidationError`.
 */
export function validateScienceGetRequest(request: ScienceGetRequest): void {
  if (
    typeof request.identifier !== "string" ||
    parseScienceIdentifier(request.identifier) === null
  ) {
    throw new ValidationError(
      `Invalid identifier: expected a bare DOI, numeric PMID, or arXiv id`,
    );
  }
}
