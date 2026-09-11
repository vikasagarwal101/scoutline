/**
 * Crossref Provider Adapter — science search + get via the works JSON
 * API.
 *
 * Credential model (DESIGN D2 supplier table): keyless — no credential
 * model exists for Crossref at all. `credentialEnvVars` is `[]`
 * (Crossref's `mailto` is politeness, not a credential), and the cache
 * fingerprint is ALWAYS `""` (DESIGN D4b note: keyless responses are
 * user-independent; no keyed partition exists to re-partition into).
 * The env flows through `create({ env })`, never the transport seam.
 *
 * Politeness (DESIGN D2 politeness bullet): the house
 * `scoutline/${VERSION}` User-Agent rides every request WITH a
 * `mailto:` contact embedded in the UA itself — the Crossref
 * polite-pool convention (UA-carried mailto), unlike OpenAlex's
 * query-param convention. Unconditional: there is no keyed tier.
 *
 * Controls (DESIGN D7 table crossref column): `author`, `year`,
 * `venue`, and `type` are ALL wire-consumed together on ONE works call
 * (`query.author=`, `filter=from-pub-date`/`until-pub-date`,
 * `query.container-title=`, `filter=type:`). Crossref is the only v1
 * supplier consuming venue. The `type` VALUE is rewritten per the D7
 * round-2 translation table; Crossref consumes ALL seven union values
 * — no rejection row.
 *
 * Junk filter (PRD AC-4 + AC-8): `type: "component"` records (figure
 * /table components riding a real DOI) NEVER surface; the default
 * filter is EXACTLY the component drop — nothing more, so every
 * non-component record still surfaces.
 *
 * Parsing (DESIGN D2/D3, PRD AC-7c/AC-7d): deterministic JSON field
 * mapping. `title` and `container-title` arrive as ARRAYS (ScienceWork
 * carries strings); `author` given+family join into display strings;
 * `is-referenced-by-count` → `citationCount` (verbatim pin). Absent
 * supplier fields stay absent, never undefined-valued and never
 * fabricated. Crossref carries no abstracts — `summary` is honestly
 * absent (AC-7c).
 *
 * Identifiers (DESIGN D10 ruling 3): bare DOI → the `works/<doi>`
 * entity route (message-type "work" single-record response). PMID and
 * arXiv ids do NOT route to Crossref — rejected at validate with
 * `UnsupportedOptionError`.
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
import { fetchCrossrefJson, type CrossrefTransportDeps } from "./client.js";
import { createCrossrefDiagnosticsCapability } from "./diagnostics.js";

// ---------------------------------------------------------------------------
// Wire mapping (DESIGN D7 table crossref column)
// ---------------------------------------------------------------------------

/**
 * D7 round-2 translation table, crossref column: union `type` values
 * map to Crossref wire literals. All seven values are consumed —
 * Crossref carries a literal for conference-paper, so there is no
 * rejection row.
 */
const TYPE_WIRE_LITERALS: Readonly<Record<string, string>> = Object.freeze({
  article: "journal-article",
  preprint: "posted-content",
  "conference-paper": "proceedings-article",
  chapter: "book-chapter",
  dataset: "dataset",
  review: "review-article",
  other: "other",
});

/**
 * Year control "2020" | "2018:2022" → the Crossref from/until pair.
 * The from-side is `from-pub-date` (D7 names it); the to-side is
 * Crossref's documented `until-pub-date`. Bare years are a closed form
 * Crossref accepts.
 */
function yearFilterPair(year: string): { from: string; until: string } {
  const match = /^(\d{4})(?::(\d{4}))?$/.exec(year);
  const from = match?.[1] ?? "";
  const until = match?.[2] ?? from;
  return { from, until };
}

/** Crossref-native query parameters for one search (D7 crossref column). */
function buildSearchParams(query: ScienceSearchRequest): Record<string, string> {
  const params: Record<string, string> = { query: query.query.trim() };
  const controls = query.controls ?? {};
  if (controls.author !== undefined) params["query.author"] = controls.author;
  if (controls.venue !== undefined) params["query.container-title"] = controls.venue;
  const filters: string[] = [];
  if (controls.year !== undefined) {
    const { from, until } = yearFilterPair(controls.year);
    filters.push(`from-pub-date:${from}`, `until-pub-date:${until}`);
  }
  if (controls.type !== undefined) {
    const literal = TYPE_WIRE_LITERALS[controls.type];
    if (literal !== undefined) filters.push(`type:${literal}`);
  }
  if (filters.length > 0) params["filter"] = filters.join(",");
  return params;
}

// ---------------------------------------------------------------------------
// Response normalization (PRD AC-7c/AC-7d)
// ---------------------------------------------------------------------------

/** Structural read of one Crossref work record (parsed as unknown). */
interface CrossrefWorkWire {
  DOI?: string | null;
  title?: unknown;
  author?: { given?: string; family?: string }[] | null;
  "container-title"?: unknown;
  "is-referenced-by-count"?: number | null;
  type?: string | null;
  issued?: { "date-parts"?: number[][] | null } | null;
  URL?: string | null;
  language?: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toCrossrefWork(value: unknown): CrossrefWorkWire | undefined {
  return isRecord(value) ? (value as CrossrefWorkWire) : undefined;
}

/** Crossref ships titles/container-titles as ARRAYS; take the first entry. */
function firstString(value: unknown): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === "string" && first !== "" ? first : undefined;
}

/** `author` given+family → joined display strings ("Yann LeCun"). */
function authorNames(authors: CrossrefWorkWire["author"]): string[] {
  return (authors ?? [])
    .map((a) => [a?.given, a?.family].filter((p) => typeof p === "string" && p !== "").join(" "))
    .filter((n) => n !== "");
}

/**
 * Map one Crossref work record to a `ScienceWork`. Absent supplier
 * fields stay absent — keys are omitted, never set to undefined (the
 * AC-7c honesty teeth: `Object.hasOwn(w, k) === false`), never
 * fabricated. `summary` is never set: Crossref carries no abstracts.
 */
function mapWork(work: CrossrefWorkWire): ScienceWork {
  const out: ScienceWork = {
    title: firstString(work.title) ?? "",
    url: work.URL ?? "",
  };
  const doi = work.DOI;
  if (typeof doi === "string" && doi !== "") {
    out.identifiers = { doi };
  }
  const authors = authorNames(work.author);
  if (authors.length > 0) out.authors = authors;
  const year = work.issued?.["date-parts"]?.[0]?.[0];
  if (typeof year === "number") out.year = year;
  const venue = firstString(work["container-title"]);
  if (venue !== undefined) out.venue = venue;
  const citationCount = work["is-referenced-by-count"];
  if (typeof citationCount === "number") out.citationCount = citationCount;
  if (typeof work.type === "string" && work.type !== "") out.type = work.type;
  if (typeof work.language === "string" && work.language !== "") out.language = work.language;
  return out;
}

/** Default junk filter (PRD AC-4/AC-8): drop `component` records, nothing more. */
function isComponentJunk(work: CrossrefWorkWire): boolean {
  return work.type === "component";
}

/** Extract the `message.items` array from a work-list response. */
function crossrefItems(doc: unknown): CrossrefWorkWire[] {
  const message = isRecord(doc) ? doc["message"] : undefined;
  const items = isRecord(message) ? message["items"] : undefined;
  if (!Array.isArray(items)) return [];
  return items.filter((r): r is CrossrefWorkWire => isRecord(r));
}

/** Extract the single `message` work record from an entity-route response. */
function crossrefMessage(doc: unknown): CrossrefWorkWire | undefined {
  const message = isRecord(doc) ? doc["message"] : undefined;
  return isRecord(message) ? (message as CrossrefWorkWire) : undefined;
}

// ---------------------------------------------------------------------------
// Validation (shared validator + adapter-level identifier routing)
// ---------------------------------------------------------------------------

function validateCrossrefSearchRequest(request: ScienceSearchRequest): void {
  // The four controls are wire-consumed (D7 crossref column); the
  // shared validator's query/year grammar plus the type-VALUE grammar
  // (translation-table membership) are the only rejections here.
  validateScienceSearchRequest(request);
  const controls = request.controls ?? {};
  if (controls.type !== undefined && TYPE_WIRE_LITERALS[controls.type] === undefined) {
    throw new UnsupportedOptionError("crossref", "science.search", "type");
  }
}

function validateCrossrefGetRequest(request: ScienceGetRequest): void {
  // Shared grammar first: out-of-bare-grammar identifiers (prefixed
  // `doi:…`, free text) throw ValidationError (DESIGN D1).
  validateScienceGetRequest(request);
  // D10 ruling 3: DOI routes to all suppliers except arxiv (crossref
  // included); PMID routes to openalex + europepmc + pubmed ONLY, and
  // arXiv ids route to the arxiv adapter — both are unservable here.
  const kind = parseScienceIdentifier(request.identifier);
  if (kind !== "doi") {
    throw new UnsupportedOptionError("crossref", "science.get", "identifier");
  }
}

// ---------------------------------------------------------------------------
// Science capability
// ---------------------------------------------------------------------------

/**
 * Cache identity (DESIGN D4b note + PRD AC-6b): ALWAYS `""` — Crossref
 * has no key model at all (D2 table), so there is no keyed partition
 * to re-partition into; keyless responses are user-independent.
 */
function crossrefCacheIdentity(
  capability: "science.search" | "science.get",
  request: Readonly<ScienceSearchRequest | ScienceGetRequest>,
): ScienceCacheIdentity {
  return {
    supplier: "crossref",
    capability,
    credentialFingerprint: "",
    request,
  };
}

/** Local science search contract — see the module header. */
interface CrossrefScienceSearchCapability {
  validate(request: ScienceSearchRequest): void;
  cacheIdentity(request: ScienceSearchRequest): ScienceCacheIdentity;
  invoke(request: ScienceSearchRequest, signal?: AbortSignal): Promise<readonly ScienceWork[]>;
}

/** Local science get contract — see the module header. */
interface CrossrefScienceGetCapability {
  validate(request: ScienceGetRequest): void;
  cacheIdentity(request: ScienceGetRequest): ScienceCacheIdentity;
  invoke(request: ScienceGetRequest, signal?: AbortSignal): Promise<ScienceWork>;
}

/** Local ScienceCapability surface. */
interface CrossrefScienceCapability {
  readonly search: CrossrefScienceSearchCapability;
  readonly get: CrossrefScienceGetCapability;
}

function createCrossrefScienceCapability(options: {
  readonly env: NodeJS.ProcessEnv;
  readonly transport?: CrossrefTransportDeps;
}): CrossrefScienceCapability {
  const { transport } = options;
  const deps = { ...transport };

  const search: CrossrefScienceSearchCapability = {
    validate: validateCrossrefSearchRequest,
    cacheIdentity(request) {
      return crossrefCacheIdentity("science.search", request);
    },
    async invoke(request, signal) {
      search.validate(request);
      const doc = await fetchCrossrefJson(buildSearchParams(request), deps, signal);
      return crossrefItems(doc)
        .filter((w) => !isComponentJunk(w))
        .map(mapWork);
    },
  };

  const get: CrossrefScienceGetCapability = {
    validate: validateCrossrefGetRequest,
    cacheIdentity(request) {
      return crossrefCacheIdentity("science.get", request);
    },
    async invoke(request, signal) {
      get.validate(request);
      // Entity route /works/<doi> — the message-type "work" single-record
      // response (D10 ruling 3). validate guarantees a bare DOI here.
      const doc = await fetchCrossrefJson({}, deps, signal, request.identifier);
      const work = crossrefMessage(doc);
      if (work === undefined) {
        throw new ApiError(`Crossref returned no work for ${request.identifier}`, 404);
      }
      // Direct gets obey the same junk policy as searches (review): a
      // component DOI resolves to a component record — reject it with
      // the 404 no-work behavior instead of returning the component.
      if (isComponentJunk(work)) {
        throw new ApiError(
          `Crossref returned no work for ${request.identifier} (component record)`,
          404,
        );
      }
      return mapWork(work);
    },
  };

  return { search, get };
}

// ---------------------------------------------------------------------------
// Descriptor
// ---------------------------------------------------------------------------

/**
 * Dependencies the Crossref Adapter accepts. The unified `transport`
 * seam carries `fetch` and timer injection (house spider/arXiv/OpenAlex
 * pattern); credentials do not exist for Crossref, so nothing flows
 * through `create({ env })` beyond the context itself.
 */
export interface CrossrefAdapterDependencies {
  readonly transport?: CrossrefTransportDeps;
}

/** Local Adapter contract — see the module header. */
interface CrossrefAdapter {
  readonly id: "crossref";
  readonly science: CrossrefScienceCapability;
  readonly diagnostics: ReturnType<typeof createCrossrefDiagnosticsCapability>;
}

/** Local Descriptor contract — see the module header. */
interface CrossrefDescriptor {
  readonly id: "crossref";
  isConfigured(env: NodeJS.ProcessEnv, capabilityId?: ProviderCapability): boolean;
  capabilities(): ReadonlySet<ProviderCapability>;
  create(context: ProviderContext): CrossrefAdapter;
  readonly credentialEnvVars: readonly string[];
}

/**
 * Crossref capability set — the science duo plus diagnostics (D2
 * round-3). `quota` never appears (quota dashboard filter exclusion,
 * PRD AC-5): keyless-true ONLY for the no-capability form and the
 * science set.
 */
const CROSSREF_CAPABILITIES: ReadonlySet<ProviderCapability> = new Set([
  "science.search",
  "science.get",
  "diagnostics",
]);

/**
 * Build the Crossref Provider Descriptor. Keyless — no credential model
 * exists — so `isConfigured` is true for the no-capability form
 * (doctor) and the science duo + diagnostics — never `quota` or
 * non-science capabilities. `create()` is side-effect-free; transport
 * runs per capability call.
 */
export function createCrossrefDescriptor(
  dependencies?: CrossrefAdapterDependencies,
): CrossrefDescriptor {
  const transport = dependencies?.transport;
  return {
    id: "crossref",
    isConfigured(_env, capabilityId) {
      if (capabilityId === undefined) return true;
      return CROSSREF_CAPABILITIES.has(capabilityId);
    },
    capabilities() {
      return CROSSREF_CAPABILITIES;
    },
    create(context: ProviderContext): CrossrefAdapter {
      return {
        id: "crossref",
        science: createCrossrefScienceCapability({ env: context.env, transport }),
        diagnostics: createCrossrefDiagnosticsCapability({
          transport,
          env: context.env,
        }),
      };
    },
    credentialEnvVars: [],
  };
}
