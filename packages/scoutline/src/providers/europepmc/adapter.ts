/**
 * Europe PMC Provider Adapter — science search + get via the REST
 * search JSON endpoint.
 *
 * Credential model (DESIGN D2 supplier table): keyless — no credential
 * model exists for Europe PMC at all. `credentialEnvVars` is `[]` and
 * the cache fingerprint is ALWAYS `""` (DESIGN D4b note: keyless
 * responses are user-independent; no keyed partition exists to
 * re-partition into). The env flows through `create({ env })`, never
 * the transport seam.
 *
 * Politeness (DESIGN D2 politeness bullet): the plain house
 * `scoutline/${VERSION}` User-Agent rides every request — no mailto
 * variant (those are OpenAlex/Crossref specifics).
 *
 * Controls (DESIGN D7 table europepmc column): `author`, `year`, and
 * `type` are ALL wire-consumed together on ONE search call, composed
 * into the EuropePMC query language (`AUTH:"…"`, `PUB_YEAR:` range,
 * `PUB_TYPE:"…"`). `venue` is REJECTED at validate with
 * `UnsupportedOptionError` — never accept-and-drop (PRD AC-3;
 * `--venue` is crossref-only in v1). The `type` VALUE is rewritten per
 * the D7 round-2 translation table; EuropePMC consumes ALL seven union
 * values — no rejection row.
 *
 * Parsing (DESIGN D2/D3, PRD AC-7c/AC-7d): deterministic JSON field
 * mapping. `authorString` is a comma-separated display list with a
 * trailing `;` — split on `,`, strip the trailing `;`.
 * `firstPublicationDate` → `year` (NOT the `pubYear` string — TASKS T5
 * pin; the first-publication date is authoritative even when the two
 * disagree). `citedByCount` → `citationCount` (verbatim pin);
 * `isOpenAccess` `"Y"` → `openAccess: true`; `journalTitle` → `venue`;
 * `abstractText` → `summary` (the richest-fields supplier carries
 * abstracts). Absent supplier fields stay absent, never undefined-
 * valued and never fabricated.
 *
 * Identifiers (DESIGN D10 ruling 3): bare PMID →
 * `EXT_ID:<pmid> AND SRC:MED` on the search endpoint; bare DOI → the
 * DOI as a query term. arXiv ids do NOT route to Europe PMC —
 * rejected at validate with `UnsupportedOptionError`.
 */
import type {
  ScienceCacheIdentity,
  ScienceGetRequest,
  ScienceSearchRequest,
  ScienceWork,
} from "../../capabilities/science.js";
import {
  parseScienceIdentifier,
  validateScienceGetRequest,
  validateScienceSearchRequest,
} from "../../capabilities/science.js";
import { ApiError, UnsupportedOptionError } from "../../lib/errors.js";
import type { ProviderCapability, ProviderContext } from "../types.js";
import { fetchEuropepmcJson, type EuropepmcTransportDeps } from "./client.js";
import { createEuropepmcDiagnosticsCapability } from "./diagnostics.js";

// ---------------------------------------------------------------------------
// Wire mapping (DESIGN D7 table europepmc column)
// ---------------------------------------------------------------------------

/**
 * D7 round-2 translation table, europepmc column: union `type` values
 * map to quoted `PUB_TYPE:` literals. All seven values are consumed —
 * EuropePMC carries a literal for every union value, so there is no
 * rejection row.
 */
const TYPE_WIRE_LITERALS: Readonly<Record<string, string>> = Object.freeze({
  article: "Journal Article",
  preprint: "Preprint",
  "conference-paper": "Conference Paper",
  chapter: "Book Chapter",
  dataset: "Dataset",
  review: "Review",
  other: "Other",
});

/**
 * Year control "2020" | "2018:2022" → the EuropePMC PUB_YEAR term.
 * A single year maps to the closed single-year form `PUB_YEAR:2020`;
 * a range maps to `PUB_YEAR:[from TO to]`.
 */
function yearTerm(year: string): string {
  const match = /^(\d{4})(?::(\d{4}))?$/.exec(year);
  const from = match?.[1] ?? "";
  const to = match?.[2];
  return to !== undefined ? `PUB_YEAR:[${from} TO ${to}]` : `PUB_YEAR:${from}`;
}

/**
 * Compose the EuropePMC query string for one search (D7 europepmc column).
 * Control values interpolated into quoted terms are backslash-escaped
 * (review): a literal `"` or `\` in `--author` must not break out of the
 * `AUTH:"…"` phrase.
 */
function quotedTerm(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function buildQuery(query: ScienceSearchRequest): string {
  const terms: string[] = [query.query.trim()];
  const controls = query.controls ?? {};
  if (controls.author !== undefined) terms.push(`AUTH:${quotedTerm(controls.author)}`);
  if (controls.year !== undefined) terms.push(yearTerm(controls.year));
  if (controls.type !== undefined) {
    terms.push(`PUB_TYPE:"${TYPE_WIRE_LITERALS[controls.type]}"`);
  }
  return terms.join(" AND ");
}

// ---------------------------------------------------------------------------
// Response normalization (PRD AC-7c/AC-7d)
// ---------------------------------------------------------------------------

/** Structural read of one EuropePMC record (parsed as unknown). */
interface EuropepmcWorkWire {
  id?: string | null;
  source?: string | null;
  pmid?: string | null;
  doi?: string | null;
  title?: string | null;
  authorString?: string | null;
  journalTitle?: string | null;
  firstPublicationDate?: string | null;
  citedByCount?: number | null;
  isOpenAccess?: string | null;
  language?: string | null;
  abstractText?: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toEuropepmcWork(value: unknown): EuropepmcWorkWire | undefined {
  return isRecord(value) ? (value as EuropepmcWorkWire) : undefined;
}

/** `authorString` "Croitoru DO, Piguet V;" → ["Croitoru DO", "Piguet V"]. */
function authorNames(authorString: EuropepmcWorkWire["authorString"]): string[] {
  if (typeof authorString !== "string" || authorString === "") return [];
  return authorString
    .split(",")
    .map((name) => name.trim().replace(/;$/, "").trim())
    .filter((name) => name !== "");
}

/** EuropePMC landing identity: PMID-addressed for MED records, DOI fallback otherwise. */
function workUrl(work: EuropepmcWorkWire): string {
  if (work.source === "MED" && typeof work.pmid === "string" && work.pmid !== "") {
    return `https://europepmc.org/article/MED/${work.pmid}`;
  }
  if (typeof work.doi === "string" && work.doi !== "") {
    return `https://doi.org/${work.doi}`;
  }
  if (typeof work.pmid === "string" && work.pmid !== "") {
    return `https://europepmc.org/article/MED/${work.pmid}`;
  }
  // Source/id landing fallback (review): a record with neither DOI nor
  // PMID still carries a valid Europe PMC identity — never drop to "".
  if (
    typeof work.source === "string" &&
    work.source !== "" &&
    typeof work.id === "string" &&
    work.id !== ""
  ) {
    return `https://europepmc.org/article/${work.source}/${work.id}`;
  }
  return "";
}

/**
 * Map one EuropePMC record to a `ScienceWork`. Absent supplier fields
 * stay absent — keys are omitted, never set to undefined (the AC-7c
 * honesty teeth: `Object.hasOwn(w, k) === false`), never fabricated.
 */
function mapWork(work: EuropepmcWorkWire): ScienceWork {
  const out: ScienceWork = {
    title: work.title ?? "",
    url: workUrl(work),
  };
  const identifiers: { doi?: string; pmid?: string } = {};
  if (typeof work.pmid === "string" && work.pmid !== "") identifiers.pmid = work.pmid;
  if (typeof work.doi === "string" && work.doi !== "") identifiers.doi = work.doi;
  if (Object.keys(identifiers).length > 0) out.identifiers = identifiers;
  const authors = authorNames(work.authorString);
  if (authors.length > 0) out.authors = authors;
  // TASKS T5 pin: firstPublicationDate is authoritative, NOT pubYear.
  const year = Number((work.firstPublicationDate ?? "").slice(0, 4));
  if (Number.isFinite(year) && year > 0) out.year = year;
  if (typeof work.journalTitle === "string" && work.journalTitle !== "") {
    out.venue = work.journalTitle;
  }
  if (typeof work.abstractText === "string" && work.abstractText !== "") {
    out.summary = work.abstractText;
  }
  if (typeof work.citedByCount === "number") out.citationCount = work.citedByCount;
  // Map BOTH Y and N (review): a known-false `isOpenAccess: "N"` is a
  // real value, not an absent one — omitting it would lose it.
  if (work.isOpenAccess === "Y" || work.isOpenAccess === "N") {
    out.openAccess = work.isOpenAccess === "Y";
  }
  if (typeof work.language === "string" && work.language !== "") out.language = work.language;
  return out;
}

/** Extract the `resultList.result` array from a search response. */
function europepmcResults(doc: unknown): EuropepmcWorkWire[] {
  const resultList = isRecord(doc) ? doc["resultList"] : undefined;
  const result = isRecord(resultList) ? resultList["result"] : undefined;
  if (!Array.isArray(result)) return [];
  return result.map(toEuropepmcWork).filter((r): r is EuropepmcWorkWire => r !== undefined);
}

// ---------------------------------------------------------------------------
// Validation (shared validator + adapter-level identifier routing)
// ---------------------------------------------------------------------------

function validateEuropepmcSearchRequest(request: ScienceSearchRequest): void {
  // The shared validator's query/year grammar plus the adapter-level
  // control routing (PRD AC-3: reject at validation, never
  // accept-and-drop) are the rejections here.
  validateScienceSearchRequest(request);
  const controls = request.controls ?? {};
  if (controls.venue !== undefined) {
    throw new UnsupportedOptionError("europepmc", "science.search", "venue");
  }
  if (controls.type !== undefined && TYPE_WIRE_LITERALS[controls.type] === undefined) {
    throw new UnsupportedOptionError("europepmc", "science.search", "type");
  }
}

function validateEuropepmcGetRequest(request: ScienceGetRequest): void {
  // Shared grammar first: out-of-bare-grammar identifiers (prefixed
  // `pmcid:…`, free text) throw ValidationError (DESIGN D1).
  validateScienceGetRequest(request);
  // D10 ruling 3: PMID routes to openalex + europepmc + pubmed and DOI
  // routes to all suppliers except arxiv (europepmc included); arXiv
  // ids route to the arxiv adapter ONLY — unservable here.
  const kind = parseScienceIdentifier(request.identifier);
  if (kind !== "pmid" && kind !== "doi") {
    throw new UnsupportedOptionError("europepmc", "science.get", "identifier");
  }
}

// ---------------------------------------------------------------------------
// Science capability
// ---------------------------------------------------------------------------

/**
 * Cache identity (DESIGN D4b note + PRD AC-6b): ALWAYS `""` — Europe
 * PMC has no key model at all (D2 table), so there is no keyed
 * partition to re-partition into; keyless responses are
 * user-independent.
 */
function europepmcCacheIdentity(
  capability: "science.search" | "science.get",
  request: Readonly<ScienceSearchRequest | ScienceGetRequest>,
): ScienceCacheIdentity {
  return {
    supplier: "europepmc",
    capability,
    credentialFingerprint: "",
    request,
  };
}

/** Local science search contract — see the module header. */
interface EuropepmcScienceSearchCapability {
  validate(request: ScienceSearchRequest): void;
  cacheIdentity(request: ScienceSearchRequest): ScienceCacheIdentity;
  invoke(request: ScienceSearchRequest, signal?: AbortSignal): Promise<readonly ScienceWork[]>;
}

/** Local science get contract — see the module header. */
interface EuropepmcScienceGetCapability {
  validate(request: ScienceGetRequest): void;
  cacheIdentity(request: ScienceGetRequest): ScienceCacheIdentity;
  invoke(request: ScienceGetRequest, signal?: AbortSignal): Promise<ScienceWork>;
}

/** Local ScienceCapability surface. */
interface EuropepmcScienceCapability {
  readonly search: EuropepmcScienceSearchCapability;
  readonly get: EuropepmcScienceGetCapability;
}

function createEuropepmcScienceCapability(options: {
  readonly env: NodeJS.ProcessEnv;
  readonly transport?: EuropepmcTransportDeps;
}): EuropepmcScienceCapability {
  const { transport } = options;
  const deps = { ...transport };

  const search: EuropepmcScienceSearchCapability = {
    validate: validateEuropepmcSearchRequest,
    cacheIdentity(request) {
      return europepmcCacheIdentity("science.search", request);
    },
    async invoke(request, signal) {
      search.validate(request);
      const doc = await fetchEuropepmcJson({ query: buildQuery(request) }, deps, signal);
      return europepmcResults(doc).map(mapWork);
    },
  };

  const get: EuropepmcScienceGetCapability = {
    validate: validateEuropepmcGetRequest,
    cacheIdentity(request) {
      return europepmcCacheIdentity("science.get", request);
    },
    async invoke(request, signal) {
      get.validate(request);
      // D10 ruling 3: PMID → EXT_ID/SRC:MED probe shape (hits=1); DOI →
      // the bare DOI as the query term. One search call, then the
      // first record maps (AC-2: one work or fail).
      const kind = parseScienceIdentifier(request.identifier);
      const query =
        kind === "pmid" ? `EXT_ID:${request.identifier} AND SRC:MED` : `DOI:${request.identifier}`;
      const doc = await fetchEuropepmcJson({ query }, deps, signal);
      const first = europepmcResults(doc)[0];
      if (first === undefined) {
        throw new ApiError(`Europe PMC returned no work for ${request.identifier}`, 404);
      }
      return mapWork(first);
    },
  };

  return { search, get };
}

// ---------------------------------------------------------------------------
// Descriptor
// ---------------------------------------------------------------------------

/**
 * Dependencies the EuropePMC Adapter accepts. The unified `transport`
 * seam carries `fetch` and timer injection (house spider/arXiv/OpenAlex
 * pattern); credentials do not exist for Europe PMC, so nothing flows
 * through `create({ env })` beyond the context itself.
 */
export interface EuropepmcAdapterDependencies {
  readonly transport?: EuropepmcTransportDeps;
}

/** Local Adapter contract — see the module header. */
interface EuropepmcAdapter {
  readonly id: "europepmc";
  readonly science: EuropepmcScienceCapability;
  readonly diagnostics: ReturnType<typeof createEuropepmcDiagnosticsCapability>;
}

/** Local Descriptor contract — see the module header. */
interface EuropepmcDescriptor {
  readonly id: "europepmc";
  isConfigured(env: NodeJS.ProcessEnv, capabilityId?: ProviderCapability): boolean;
  capabilities(): ReadonlySet<ProviderCapability>;
  create(context: ProviderContext): EuropepmcAdapter;
  readonly credentialEnvVars: readonly string[];
}

/**
 * EuropePMC capability set — the science duo plus diagnostics (D2
 * round-3). `quota` never appears (quota dashboard filter exclusion,
 * PRD AC-5): keyless-true ONLY for the no-capability form and the
 * science set.
 */
const EUROPEPMC_CAPABILITIES: ReadonlySet<ProviderCapability> = new Set([
  "science.search",
  "science.get",
  "diagnostics",
]);

/**
 * Build the Europe PMC Provider Descriptor. Keyless — no credential
 * model exists — so `isConfigured` is true for the no-capability form
 * (doctor) and the science duo + diagnostics — never `quota` or
 * non-science capabilities. `create()` is side-effect-free; transport
 * runs per capability call.
 */
export function createEuropepmcDescriptor(
  dependencies?: EuropepmcAdapterDependencies,
): EuropepmcDescriptor {
  const transport = dependencies?.transport;
  return {
    id: "europepmc",
    isConfigured(_env, capabilityId) {
      if (capabilityId === undefined) return true;
      return EUROPEPMC_CAPABILITIES.has(capabilityId);
    },
    capabilities() {
      return EUROPEPMC_CAPABILITIES;
    },
    create(context: ProviderContext): EuropepmcAdapter {
      return {
        id: "europepmc",
        science: createEuropepmcScienceCapability({ env: context.env, transport }),
        diagnostics: createEuropepmcDiagnosticsCapability({
          transport,
          env: context.env,
        }),
      };
    },
    credentialEnvVars: [],
  };
}
