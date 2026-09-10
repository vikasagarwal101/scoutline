/**
 * OpenAlex Provider Adapter — science search + get via the works JSON API.
 *
 * Credential model (DESIGN D2 supplier table + D4b note): keyless by
 * default (1000 credits/day), with the optional `OPENALEX_API_KEY`
 * upgrade. `credentialEnvVars` is `["OPENALEX_API_KEY"]`; the cache
 * fingerprint is `""` when keyless (keyless responses are
 * user-independent) and the SHA-256 hex of the key otherwise (house
 * method, brave/linkup precedent) — keyed upgrades re-partition
 * (PRD AC-6b). The env flows through `create({ env })`, never the
 * transport seam.
 *
 * Politeness (DESIGN D2 politeness bullet): the house
 * `scoutline/${VERSION}` User-Agent rides every request; the
 * `mailto=` query param rides whenever no api_key is present (the
 * diagnostics probe included — D2 round-3 posture applies to the
 * minimal wire call).
 *
 * Controls (DESIGN D7 table openalex column): `author`, `year`, and
 * `type` are wire-consumed together on ONE works call
 * (`filter=raw_author_name.search:`, `from/to_publication_date`,
 * `type:`). `venue` is REJECTED at validate — probe-closed: OpenAlex
 * has no name-based venue filter (`display_name.search` 400s) — honest
 * UNSUPPORTED_OPTION, never accept-and-drop (PRD AC-3). The `type`
 * VALUE is rewritten per the D7 round-2 translation table (chapter →
 * book-chapter etc.); `conference-paper` is rejected v1 (D10
 * type-vocabulary probe: the OpenAlex vocabulary carries no such
 * value).
 *
 * Parsing (DESIGN D2/D3, PRD AC-7c/AC-7d): deterministic JSON field
 * mapping with abstract_inverted_index reconstruction — one word per
 * POSITION (a repeated word occupies each of its positions), so the
 * output is token-entry-order independent. Absent supplier fields
 * stay absent, never undefined-valued and never fabricated.
 *
 * Identifiers (DESIGN D10 ruling 3): bare DOI → `works/doi:<doi>`
 * entity route; numeric PMID → `filter=ids.pmid:` search. The URL
 * forms OpenAlex returns (`https://doi.org/…`, the pubmed URL form of
 * ids.pmid) normalize to the bare house forms.
 */
import { createHash } from "node:crypto";

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
import { fetchOpenalexJson, resolveOpenalexCredentials, type OpenalexTransportDeps } from "./client.js";
import { createOpenalexDiagnosticsCapability } from "./diagnostics.js";

// ---------------------------------------------------------------------------
// Wire mapping (DESIGN D7 table openalex column)
// ---------------------------------------------------------------------------

/**
 * D7 round-2 translation table, openalex column: union `type` values
 * map to OpenAlex wire literals. `conference-paper` is absent — the
 * OpenAlex vocabulary carries no such value (D10 type-vocabulary
 * probe), so it is rejected at validate, never silently narrowed.
 */
const TYPE_WIRE_LITERALS: Readonly<Record<string, string>> = Object.freeze({
  article: "article",
  preprint: "preprint",
  chapter: "book-chapter",
  dataset: "dataset",
  review: "review",
  other: "other",
});

/** Year control "2020" | "2018:2022" → from/to publication-date pair. */
function yearFilterPair(year: string): { from: string; to: string } {
  const [from, to] = year.split(":");
  return { from: `${from}-01-01`, to: `${to ?? from}-01-01` };
}

/** Search filters (D7 table) as one `filter=` param string. */
function buildSearchFilter(
  query: ScienceSearchRequest,
): string {
  const controls = query.controls ?? {};
  const parts: string[] = [];
  if (controls.author !== undefined) {
    parts.push(`raw_author_name.search:${controls.author}`);
  }
  if (controls.year !== undefined) {
    const { from, to } = yearFilterPair(controls.year);
    parts.push(`from_publication_date:${from}`, `to_publication_date:${to}`);
  }
  if (controls.type !== undefined) {
    const literal = TYPE_WIRE_LITERALS[controls.type];
    if (literal !== undefined) parts.push(`type:${literal}`);
  }
  return parts.join(",");
}

// ---------------------------------------------------------------------------
// Response normalization (PRD AC-7c/AC-7d)
// ---------------------------------------------------------------------------

/** Structural read of one OpenAlex work record (parsed as unknown). */
interface OpenalexWorkWire {
  id?: string;
  doi?: string | null;
  ids?: { doi?: string | null; pmid?: string | null } | null;
  title?: string | null;
  publication_year?: number | null;
  authorships?: { author?: { display_name?: string } | null }[] | null;
  primary_location?: {
    landing_page_url?: string | null;
    pdf_url?: string | null;
    source?: { display_name?: string | null } | null;
  } | null;
  cited_by_count?: number | null;
  abstract_inverted_index?: Record<string, number[]> | null;
  open_access?: { is_oa?: boolean | null } | null;
  type?: string | null;
  language?: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toOpenalexWork(value: unknown): OpenalexWorkWire | undefined {
  return isRecord(value) ? (value as OpenalexWorkWire) : undefined;
}

/**
 * Deterministic abstract reconstruction (PRD AC-7c): one word per
 * POSITION, token-entry-order independent. A repeated word occupying
 * positions [0, 4] fills both slots; two parses of the same index are
 * identical.
 */
function reconstructAbstract(
  index: Record<string, number[]> | null | undefined,
): string | undefined {
  if (index === null || index === undefined) return undefined;
  const slots: string[] = [];
  for (const [word, positions] of Object.entries(index)) {
    for (const position of positions) {
      slots[position] = word;
    }
  }
  return slots.filter((s) => s !== undefined).join(" ");
}

/** `https://doi.org/10.1038/...` → `10.1038/...`; null stays absent. */
function bareDoi(doi: string | null | undefined): string | undefined {
  if (doi === null || doi === undefined || doi === "") return undefined;
  return doi.replace(/^https?:\/\/doi\.org\//i, "");
}

/** Pubmed URL form `https://pubmed.ncbi.nlm.nih.gov/23903748/` → `23903748`. */
function barePmid(pmid: string | null | undefined): string | undefined {
  if (pmid === null || pmid === undefined || pmid === "") return undefined;
  const m = /(\d+)\/?$/.exec(pmid);
  return m?.[1];
}

/**
 * Map one OpenAlex work record to a `ScienceWork`. Absent supplier
 * fields stay absent — keys are omitted, never set to undefined (the
 * AC-7c honesty teeth: `Object.hasOwn(w, k) === false`), never
 * fabricated.
 */
function mapWork(work: OpenalexWorkWire): ScienceWork {
  const identifiers: { doi?: string; pmid?: string } = {};
  const doi = bareDoi(work.doi ?? work.ids?.doi ?? null);
  const pmid = barePmid(work.ids?.pmid ?? null);
  if (doi !== undefined) identifiers.doi = doi;
  if (pmid !== undefined) identifiers.pmid = pmid;

  const location = work.primary_location ?? null;
  const authors = (work.authorships ?? [])
    .map((a) => a?.author?.display_name)
    .filter((n): n is string => typeof n === "string" && n !== "");
  const summary = reconstructAbstract(work.abstract_inverted_index);
  const pdfUrl = location?.pdf_url ?? undefined;
  const venue = location?.source?.display_name ?? undefined;
  const year = work.publication_year ?? undefined;
  const citationCount = work.cited_by_count ?? undefined;
  const openAccess = work.open_access?.is_oa ?? undefined;

  const out: ScienceWork = {
    title: work.title ?? "",
    url: location?.landing_page_url ?? work.id ?? "",
  };
  if (Object.keys(identifiers).length > 0) out.identifiers = identifiers;
  if (authors.length > 0) out.authors = authors;
  if (year !== undefined) out.year = year;
  if (venue !== undefined && venue !== "") out.venue = venue;
  if (summary !== undefined) out.summary = summary;
  if (citationCount !== undefined) out.citationCount = citationCount;
  if (pdfUrl !== undefined && pdfUrl !== "") out.pdfUrl = pdfUrl;
  if (openAccess !== undefined) out.openAccess = openAccess;
  if (work.type !== undefined && work.type !== null) out.type = work.type;
  if (work.language !== undefined && work.language !== null) out.language = work.language;
  return out;
}

/** Extract the `results` array (search) or accept a single work (get). */
function openalexResults(doc: unknown): unknown[] {
  if (!isRecord(doc)) return [];
  if (Array.isArray(doc["results"])) return doc["results"] as unknown[];
  return [doc];
}

// ---------------------------------------------------------------------------
// Validation (shared validator + adapter-level control rulings)
// ---------------------------------------------------------------------------

function validateOpenalexSearchRequest(request: ScienceSearchRequest): void {
  validateScienceSearchRequest(request);
  const controls = request.controls ?? {};
  if (controls.venue !== undefined) {
    throw new UnsupportedOptionError("openalex", "science.search", "venue");
  }
  if (controls.type !== undefined && TYPE_WIRE_LITERALS[controls.type] === undefined) {
    throw new UnsupportedOptionError("openalex", "science.search", "type");
  }
}

function validateOpenalexGetRequest(request: ScienceGetRequest): void {
  // Shared grammar first: out-of-bare-grammar identifiers (prefixed
  // `doi:…`, free text) throw ValidationError (DESIGN D1).
  validateScienceGetRequest(request);
  // D10 ruling 3: openalex serves DOI and PMID gets (arXiv ids route to
  // the arxiv adapter instead).
  if (parseScienceIdentifier(request.identifier) === "arxiv") {
    throw new UnsupportedOptionError("openalex", "science.get", "identifier");
  }
}

// ---------------------------------------------------------------------------
// Science capability
// ---------------------------------------------------------------------------

/**
 * Cache identity (DESIGN D4b note + PRD AC-6b): keyless `""`
 * (user-independent responses) or the SHA-256 hex of the active
 * `OPENALEX_API_KEY` — keyed upgrades re-partition.
 */
function openalexCacheIdentity(
  env: NodeJS.ProcessEnv,
  capability: "science.search" | "science.get",
  request: Readonly<ScienceSearchRequest | ScienceGetRequest>,
): ScienceCacheIdentity {
  const { apiKey } = resolveOpenalexCredentials(env);
  return {
    supplier: "openalex",
    capability,
    credentialFingerprint:
      apiKey === undefined ? "" : createHash("sha256").update(apiKey).digest("hex"),
    request,
  };
}

/** Local science search contract — see the module header. */
interface OpenalexScienceSearchCapability {
  validate(request: ScienceSearchRequest): void;
  cacheIdentity(request: ScienceSearchRequest): ScienceCacheIdentity;
  invoke(
    request: ScienceSearchRequest,
    signal?: AbortSignal,
  ): Promise<readonly ScienceWork[]>;
}

/** Local science get contract — see the module header. */
interface OpenalexScienceGetCapability {
  validate(request: ScienceGetRequest): void;
  cacheIdentity(request: ScienceGetRequest): ScienceCacheIdentity;
  invoke(request: ScienceGetRequest, signal?: AbortSignal): Promise<ScienceWork>;
}

/** Local ScienceCapability surface. */
interface OpenalexScienceCapability {
  readonly search: OpenalexScienceSearchCapability;
  readonly get: OpenalexScienceGetCapability;
}

function createOpenalexScienceCapability(options: {
  readonly env: NodeJS.ProcessEnv;
  readonly transport?: OpenalexTransportDeps;
}): OpenalexScienceCapability {
  const { env, transport } = options;
  const deps = { ...transport, env };

  const search: OpenalexScienceSearchCapability = {
    validate: validateOpenalexSearchRequest,
    cacheIdentity(request) {
      return openalexCacheIdentity(env, "science.search", request);
    },
    async invoke(request, signal) {
      search.validate(request);
      const filter = buildSearchFilter(request);
      const params: Record<string, string> = { search: request.query.trim() };
      if (filter !== "") params["filter"] = filter;
      const doc = await fetchOpenalexJson(params, deps, signal);
      return openalexResults(doc).map((r) => mapWork(toOpenalexWork(r) ?? {}));
    },
  };

  const get: OpenalexScienceGetCapability = {
    validate: validateOpenalexGetRequest,
    cacheIdentity(request) {
      return openalexCacheIdentity(env, "science.get", request);
    },
    async invoke(request, signal) {
      get.validate(request);
      const kind = parseScienceIdentifier(request.identifier);
      const doc =
        kind === "doi"
          ? await fetchOpenalexJson({}, deps, signal, `doi:${request.identifier}`)
          : await fetchOpenalexJson(
              { filter: `ids.pmid:${request.identifier}` },
              deps,
              signal,
            );
      const results = openalexResults(doc);
      const first = results[0];
      if (kind !== "doi" || first === undefined || !isRecord(first)) {
        if (first === undefined || !isRecord(first)) {
          throw new ApiError(`OpenAlex returned no work for ${request.identifier}`, 404);
        }
      }
      return mapWork(first as OpenalexWorkWire);
    },
  };

  return { search, get };
}

// ---------------------------------------------------------------------------
// Descriptor
// ---------------------------------------------------------------------------

/**
 * Dependencies the OpenAlex Adapter accepts. The unified `transport`
 * seam carries `fetch` and timer injection (house spider/linkup
 * pattern); credentials flow through `create({ env })`, never here.
 */
export interface OpenalexAdapterDependencies {
  readonly transport?: OpenalexTransportDeps;
}

/** Local Adapter contract — see the module header. */
interface OpenalexAdapter {
  readonly id: "openalex";
  readonly science: OpenalexScienceCapability;
  readonly diagnostics: ReturnType<typeof createOpenalexDiagnosticsCapability>;
}

/** Local Descriptor contract — see the module header. */
interface OpenalexDescriptor {
  readonly id: "openalex";
  isConfigured(env: NodeJS.ProcessEnv, capabilityId?: ProviderCapability): boolean;
  capabilities(): ReadonlySet<ProviderCapability>;
  create(context: ProviderContext): OpenalexAdapter;
  readonly credentialEnvVars: readonly string[];
}

/**
 * OpenAlex capability set — the science trio plus diagnostics (D2
 * round-3). `quota` never appears (quota dashboard filter exclusion),
 * with or without the optional key.
 */
const OPENALEX_CAPABILITIES: ReadonlySet<ProviderCapability> = new Set([
  "science.search",
  "science.get",
  "diagnostics",
]);

/**
 * Build the OpenAlex Provider Descriptor. Keyless-by-default with an
 * optional upgrade key: `isConfigured` is true for the no-capability
 * form (doctor) and the science trio + diagnostics — never `quota` or
 * non-science capabilities. `create()` is side-effect-free; transport
 * and credential resolution run per capability call.
 */
export function createOpenalexDescriptor(
  dependencies?: OpenalexAdapterDependencies,
): OpenalexDescriptor {
  const transport = dependencies?.transport;
  return {
    id: "openalex",
    isConfigured(_env, capabilityId) {
      if (capabilityId === undefined) return true;
      return OPENALEX_CAPABILITIES.has(capabilityId);
    },
    capabilities() {
      return OPENALEX_CAPABILITIES;
    },
    create(context: ProviderContext): OpenalexAdapter {
      return {
        id: "openalex",
        science: createOpenalexScienceCapability({ env: context.env, transport }),
        diagnostics: createOpenalexDiagnosticsCapability({
          transport,
          env: context.env,
        }),
      };
    },
    credentialEnvVars: ["OPENALEX_API_KEY"],
  };
}
