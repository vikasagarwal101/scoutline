/**
 * PubMed Provider Adapter — science search + get via the NCBI eutils
 * two-step (DESIGN D2 pubmed row + D4 one-cache-identity ruling; PRD
 * AC-8b).
 *
 * Two-step composition (the adapter's internal concern): ONE
 * `science search` invocation = ONE logical query, TWO wire calls —
 * `esearch.fcgi retmode=json` (the id-list envelope) then
 * `efetch.fcgi retmode=xml` (the PubmedArticleSet records). PLAN
 * DEVIATION (probe-verified 2026-09-11, live eutils wire): D2's
 * "efetch JSON" and D10 ruling 3's "esummary direct" do not carry
 * records — efetch retmode=json returns only the bare id list, and
 * esummary retmode=json, while it does carry title/authors/venue/
 * pubtype, carries NO AbstractText — so efetch retmode=xml is the
 * only record-complete second step. An empty esearch
 * idlist short-circuits to NO second call (the 3 r/s keyless budget
 * is not spent on a zero-record efetch).
 *
 * Credential model (DESIGN D2 supplier table + D4b note): keyless
 * 3 r/s; a free `NCBI_API_KEY` lifts to 10 r/s (consumed by eutils as
 * an `api_key=` query param in the client). `credentialEnvVars` is
 * `["NCBI_API_KEY"]`; the cache fingerprint is `""` when keyless
 * (keyless responses are user-independent) and the SHA-256 hex of the
 * key otherwise (house method, brave/openalex precedent) — keyed
 * upgrades re-partition (PRD AC-6b). The env flows through
 * `create({ env })`, never the transport seam.
 *
 * Controls (DESIGN D7 table pubmed column): `author`, `year`, and
 * `type` are wire-consumed on the esearch call ONLY (the efetch step
 * is id-addressed, carrying no control terms) — author → an `[AU]`
 * term, year → `mindate`/`maxdate`, type → a `[pt]` term with the D7
 * round-2 translation-table literal. `venue` is REJECTED at validate
 * (crossref-only in v1) — honest UNSUPPORTED_OPTION, never
 * accept-and-drop (PRD AC-3).
 *
 * Parsing (DESIGN D3, PRD AC-7c/AC-7d): a deterministic hand
 * PubmedArticleSet parser — no XML dependency (arXiv Atom-parser
 * class). Record-block scoped by construction. Absent supplier
 * fields stay absent, never undefined-valued and never fabricated;
 * `citationCount` is never set (the eutils wire carries no citation
 * signal). `url` is the PubMed landing page for the PMID
 * (https://pubmed.ncbi.nlm.nih.gov/<pmid>/).
 *
 * Identifiers (DESIGN D10 ruling 3): PMID → efetch addressed with the
 * id directly (no esearch step — id-known gets skip the lookup); DOI
 * → esearch `<doi>[DOI]` lookup then efetch. arXiv ids do NOT route
 * to PubMed — rejected at validate with `UnsupportedOptionError`.
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
import {
  fetchPubmedEfetch,
  fetchPubmedEsearch,
  resolvePubmedCredentials,
  type PubmedTransportDeps,
} from "./client.js";
import { createPubmedDiagnosticsCapability } from "./diagnostics.js";

// ---------------------------------------------------------------------------
// Wire mapping (DESIGN D7 table pubmed column)
// ---------------------------------------------------------------------------

/**
 * D7 round-2 translation table, pubmed `pt` column: union `type`
 * values map to eutils pt wire literals. All seven values are
 * consumed — the pt vocabulary carries a literal for every union
 * value, so there is no rejection row.
 */
const TYPE_WIRE_LITERALS: Readonly<Record<string, string>> = Object.freeze({
  article: "journal article",
  preprint: "preprint",
  "conference-paper": "congress",
  chapter: "book chapter",
  dataset: "dataset",
  review: "review",
  other: "other",
});

/**
 * Build the esearch `term`. Controls compose onto the free-text query
 * (eutils term grammar): author → `<name>[AU]`, type →
 * `<literal>[pt]`. Year rides `mindate`/`maxdate` params instead.
 */
function buildEsearchTerm(query: ScienceSearchRequest): string {
  const controls = query.controls ?? {};
  const parts = [query.query.trim()];
  if (controls.author !== undefined) parts.push(`${controls.author}[AU]`);
  if (controls.type !== undefined) {
    const literal = TYPE_WIRE_LITERALS[controls.type];
    if (literal !== undefined) parts.push(`${literal}[pt]`);
  }
  return parts.join(" AND ");
}

/** Year control "2020" | "2018:2022" → the mindate/maxdate pair. */
function yearRange(year: string): { min: string; max: string } {
  const m = /^(\d{4})(?::(\d{4}))?$/.exec(year);
  const min = m?.[1] ?? year;
  return { min, max: m?.[2] ?? min };
}

// ---------------------------------------------------------------------------
// PubmedArticleSet hand parser (D3; arXiv-Atom-parser class)
// ---------------------------------------------------------------------------

/** Strip a CDATA wrapper when present, returning plain text. */
function stripCdata(text: string): string {
  const m = /^<!\[CDATA\[([\s\S]*)\]\]>$/s.exec(text.trim());
  if (!m || m[1] === undefined) return text;
  return m[1];
}

/**
 * Extract the inner text of the FIRST element with the given tag name
 * inside `block`, accepting a CDATA wrapper. Returns undefined when
 * absent.
 */
function elementText(block: string, tag: string): string | undefined {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i");
  const m = re.exec(block);
  if (!m || m[1] === undefined) return undefined;
  return innerText(m[1]);
}

/**
 * Decode the predefined XML entities plus numeric character references
 * (review): `&amp;` and friends in a title/abstract previously surfaced
 * literally. CDATA content is literal text — it never passes through
 * here.
 */
const XML_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};
function decodeXmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isNaN(code) ? whole : String.fromCodePoint(code);
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isNaN(code) ? whole : String.fromCodePoint(code);
    }
    return XML_ENTITIES[body] ?? whole;
  });
}

/** Inner text of a matched element: CDATA stays literal, plain text is entity-decoded. */
function innerText(raw: string): string {
  const stripped = stripCdata(raw);
  return stripped === raw ? decodeXmlEntities(stripped) : stripped;
}

/** `<PubmedArticle>…</PubmedArticle>` blocks, in document order. */
function pubmedArticleBlocks(xml: string): string[] {
  const out: string[] = [];
  const re = /<PubmedArticle(?:\s[^>]*)?>([\s\S]*?)<\/PubmedArticle>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    if (m[0] !== undefined) out.push(m[0]);
  }
  return out;
}

/**
 * Map one `<Author>` block to a display string: `LastName` plus the
 * `Initials` (eutils house form), falling back to `ForeName` when
 * Initials is absent.
 */
function authorDisplayName(authorBlock: string): string | undefined {
  const last = elementText(authorBlock, "LastName");
  if (last === undefined || last.trim() === "") return undefined;
  const initials = elementText(authorBlock, "Initials");
  const fore = elementText(authorBlock, "ForeName");
  const given = initials !== undefined && initials.trim() !== "" ? initials.trim() : fore?.trim();
  return given === undefined || given === "" ? last.trim() : `${last.trim()} ${given}`;
}

/**
 * Map one `<PubmedArticle>` block to a `ScienceWork`. Absent supplier
 * fields stay absent — keys are omitted, never set to undefined (the
 * AC-7c honesty teeth: `Object.hasOwn(w, k) === false`), never
 * fabricated. `citationCount` is never set: the eutils wire carries no
 * citation signal.
 */
function parsePubmedArticle(block: string): ScienceWork {
  const pmid = elementText(block, "PMID");
  const doiElement = /<ELocationID[^>]*EIdType="doi"[^>]*>([\s\S]*?)<\/ELocationID>/i.exec(block);
  const doi = doiElement !== null ? innerText(doiElement[1] ?? "").trim() : undefined;

  const out: ScienceWork = {
    title: (elementText(block, "ArticleTitle") ?? "").trim(),
    url: `https://pubmed.ncbi.nlm.nih.gov/${pmid ?? ""}/`,
  };
  // `identifiers` follows the doi (the cross-supplier dedup key, D12);
  // the PMID rides inside it when the block exists. A record without a
  // doi carries no mergeable identity — `identifiers` stays absent
  // (AC-7c: absent stays absent; the PMID's house identity is `url`).
  const identifiers: { doi?: string; pmid?: string } = {};
  if (doi !== undefined && doi !== "") {
    identifiers.doi = doi;
    if (pmid !== undefined && pmid.trim() !== "") identifiers.pmid = pmid.trim();
    out.identifiers = identifiers;
  }

  const authors: string[] = [];
  const authorRe = /<Author(?:\s[^>]*)?>([\s\S]*?)<\/Author>/gi;
  let a: RegExpExecArray | null;
  while ((a = authorRe.exec(block)) !== null) {
    const name = a[0] !== undefined ? authorDisplayName(a[0]) : undefined;
    if (name !== undefined) authors.push(name);
  }
  if (authors.length > 0) out.authors = authors;

  const pubDate = /<PubDate(?:\s[^>]*)?>([\s\S]*?)<\/PubDate>/i.exec(block);
  const yearText = pubDate !== null ? elementText(pubDate[0], "Year") : undefined;
  const year = yearText !== undefined ? /^(\d{4})/.exec(yearText.trim()) : null;
  if (year !== null) out.year = Number(year[1]);

  const venue = elementText(block, "Title");
  if (venue !== undefined && venue.trim() !== "") out.venue = venue.trim();

  // Multi-section abstracts (review): a structured abstract carries
  // SEVERAL labeled <AbstractText> blocks — join them all instead of
  // keeping only the first.
  const summary = [...block.matchAll(/<AbstractText(?:\s[^>]*)?>([\s\S]*?)<\/AbstractText>/gi)]
    .map((match) => innerText(match[1] ?? "").trim())
    .filter((text) => text !== "")
    .join(" ");
  if (summary !== "") out.summary = summary;

  const publicationType = elementText(block, "PublicationType");
  if (publicationType !== undefined && publicationType.trim() !== "") {
    out.type = publicationType.trim();
  }

  const language = elementText(block, "Language");
  if (language !== undefined && language.trim() !== "") out.language = language.trim();

  return out;
}

/** Parse a PubmedArticleSet XML document into normalized works. */
export function parsePubmedArticleSet(xml: string): readonly ScienceWork[] {
  return pubmedArticleBlocks(xml).map(parsePubmedArticle);
}

/** Extract the `esearchresult.idlist` (string ids) from an esearch envelope. */
function esearchIdlist(doc: unknown): string[] {
  const result =
    typeof doc === "object" && doc !== null && "esearchresult" in doc
      ? (doc as Record<string, unknown>)["esearchresult"]
      : undefined;
  const idlist =
    typeof result === "object" && result !== null && "idlist" in result
      ? (result as Record<string, unknown>)["idlist"]
      : undefined;
  if (!Array.isArray(idlist)) return [];
  return idlist.filter((id): id is string => typeof id === "string" && id !== "");
}

// ---------------------------------------------------------------------------
// Validation (shared validator + adapter-level control rulings)
// ---------------------------------------------------------------------------

function validatePubmedSearchRequest(request: ScienceSearchRequest): void {
  validateScienceSearchRequest(request);
  const controls = request.controls ?? {};
  if (controls.venue !== undefined) {
    // D7 venue row (pubmed column: reject); PRD AC-3 — never
    // accept-and-drop. Pubmed is not a venue-capable supplier (v1).
    throw new UnsupportedOptionError("pubmed", "science.search", "venue");
  }
  if (controls.type !== undefined && TYPE_WIRE_LITERALS[controls.type] === undefined) {
    throw new UnsupportedOptionError("pubmed", "science.search", "type");
  }
}

function validatePubmedGetRequest(request: ScienceGetRequest): void {
  // Shared grammar first: out-of-bare-grammar identifiers (prefixed
  // `pmid:…`, free text) throw ValidationError (DESIGN D1).
  validateScienceGetRequest(request);
  // D10 ruling 3: pubmed serves PMID and DOI gets; arXiv ids route to
  // the arxiv adapter instead.
  if (parseScienceIdentifier(request.identifier) === "arxiv") {
    throw new UnsupportedOptionError("pubmed", "science.get", "identifier");
  }
}

// ---------------------------------------------------------------------------
// Science capability
// ---------------------------------------------------------------------------

/**
 * Cache identity (DESIGN D4b note + PRD AC-6b): keyless `""`
 * (user-independent responses) or the SHA-256 hex of the active
 * `NCBI_API_KEY` — keyed upgrades re-partition. One identity covers
 * the whole two-call sequence (D4).
 */
function pubmedCacheIdentity(
  env: NodeJS.ProcessEnv,
  capability: "science.search" | "science.get",
  request: Readonly<ScienceSearchRequest | ScienceGetRequest>,
): ScienceCacheIdentity {
  const { apiKey } = resolvePubmedCredentials(env);
  return {
    supplier: "pubmed",
    capability,
    credentialFingerprint:
      apiKey === undefined ? "" : createHash("sha256").update(apiKey).digest("hex"),
    request,
  };
}

/** Local science search contract — see the module header. */
interface PubmedScienceSearchCapability {
  validate(request: ScienceSearchRequest): void;
  cacheIdentity(request: ScienceSearchRequest): ScienceCacheIdentity;
  invoke(request: ScienceSearchRequest, signal?: AbortSignal): Promise<readonly ScienceWork[]>;
}

/** Local science get contract — see the module header. */
interface PubmedScienceGetCapability {
  validate(request: ScienceGetRequest): void;
  cacheIdentity(request: ScienceGetRequest): ScienceCacheIdentity;
  invoke(request: ScienceGetRequest, signal?: AbortSignal): Promise<ScienceWork>;
}

/** Local ScienceCapability surface. */
interface PubmedScienceCapability {
  readonly search: PubmedScienceSearchCapability;
  readonly get: PubmedScienceGetCapability;
}

function createPubmedScienceCapability(options: {
  readonly env: NodeJS.ProcessEnv;
  readonly transport?: PubmedTransportDeps;
}): PubmedScienceCapability {
  const { env, transport } = options;
  const deps = { ...transport, env };

  /**
   * Record step: efetch the comma-joined ids as PubmedArticleSet XML.
   * `db=pubmed retmode=xml` is pinned by the wire-shape deviation
   * (efetch json carries no records).
   */
  async function fetchRecords(
    ids: string[],
    signal?: AbortSignal,
  ): Promise<readonly ScienceWork[]> {
    const xml = await fetchPubmedEfetch(
      { db: "pubmed", retmode: "xml", id: ids.join(",") },
      deps,
      signal,
    );
    return parsePubmedArticleSet(xml);
  }

  const search: PubmedScienceSearchCapability = {
    validate: validatePubmedSearchRequest,
    cacheIdentity(request) {
      return pubmedCacheIdentity(env, "science.search", request);
    },
    async invoke(request, signal) {
      search.validate(request);
      const params: Record<string, string> = {
        db: "pubmed",
        term: buildEsearchTerm(request),
        retmode: "json",
      };
      const controls = request.controls ?? {};
      if (controls.year !== undefined) {
        const { min, max } = yearRange(controls.year);
        params["mindate"] = min;
        params["maxdate"] = max;
        params["datetype"] = "pdat";
      }
      const doc = await fetchPubmedEsearch(params, deps, signal);
      const ids = esearchIdlist(doc);
      if (ids.length === 0) return [];
      return fetchRecords(ids, signal);
    },
  };

  const get: PubmedScienceGetCapability = {
    validate: validatePubmedGetRequest,
    cacheIdentity(request) {
      return pubmedCacheIdentity(env, "science.get", request);
    },
    async invoke(request, signal) {
      get.validate(request);
      const kind = parseScienceIdentifier(request.identifier);
      let works: readonly ScienceWork[];
      if (kind === "pmid") {
        // Id-known: ONE id-direct efetch, no esearch lookup.
        works = await fetchRecords([request.identifier], signal);
      } else {
        // DOI: lookup step (the DOI rides an esearch term), then fetch.
        const doc = await fetchPubmedEsearch(
          { db: "pubmed", term: `${request.identifier}[DOI]`, retmode: "json" },
          deps,
          signal,
        );
        const ids = esearchIdlist(doc);
        if (ids.length === 0) {
          throw new ApiError(`PubMed returned no work for ${request.identifier}`, 404);
        }
        works = await fetchRecords(ids.slice(0, 1), signal);
      }
      const work = works[0];
      if (work === undefined) {
        throw new ApiError(`PubMed returned no work for ${request.identifier}`, 404);
      }
      return work;
    },
  };

  return { search, get };
}

// ---------------------------------------------------------------------------
// Descriptor
// ---------------------------------------------------------------------------

/**
 * Dependencies the PubMed Adapter accepts. The unified `transport`
 * seam carries `fetch` and timer injection (house spider/arXiv/OpenAlex
 * pattern); credentials flow through `create({ env })`, never here.
 */
export interface PubmedAdapterDependencies {
  readonly transport?: PubmedTransportDeps;
}

/** Local Adapter contract — see the module header. */
interface PubmedAdapter {
  readonly id: "pubmed";
  readonly science: PubmedScienceCapability;
  readonly diagnostics: ReturnType<typeof createPubmedDiagnosticsCapability>;
}

/** Local Descriptor contract — see the module header. */
interface PubmedDescriptor {
  readonly id: "pubmed";
  isConfigured(env: NodeJS.ProcessEnv, capabilityId?: ProviderCapability): boolean;
  capabilities(): ReadonlySet<ProviderCapability>;
  create(context: ProviderContext): PubmedAdapter;
  readonly credentialEnvVars: readonly string[];
}

/**
 * PubMed capability set — the science duo plus diagnostics (D2
 * round-3). `quota` never appears (quota dashboard filter exclusion,
 * PRD AC-5): keyless-true ONLY for the no-capability form and the
 * science set — the optional key lifts the rate limit, never the
 * capability list.
 */
const PUBMED_CAPABILITIES: ReadonlySet<ProviderCapability> = new Set([
  "science.search",
  "science.get",
  "diagnostics",
]);

/**
 * Build the PubMed Provider Descriptor. Keyless-by-default with an
 * optional rate-limit key: `isConfigured` is true for the
 * no-capability form (doctor) and the science duo + diagnostics —
 * never `quota` or non-science capabilities. `create()` is
 * side-effect-free; transport and credential resolution run per
 * capability call.
 */
export function createPubmedDescriptor(dependencies?: PubmedAdapterDependencies): PubmedDescriptor {
  const transport = dependencies?.transport;
  return {
    id: "pubmed",
    isConfigured(_env, capabilityId) {
      if (capabilityId === undefined) return true;
      return PUBMED_CAPABILITIES.has(capabilityId);
    },
    capabilities() {
      return PUBMED_CAPABILITIES;
    },
    create(context: ProviderContext): PubmedAdapter {
      return {
        id: "pubmed",
        science: createPubmedScienceCapability({ env: context.env, transport }),
        diagnostics: createPubmedDiagnosticsCapability({
          transport,
          env: context.env,
        }),
      };
    },
    credentialEnvVars: ["NCBI_API_KEY"],
  };
}
