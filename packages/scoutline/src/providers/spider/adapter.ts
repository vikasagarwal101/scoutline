/**
 * Spider.cloud Adapter — Search, Reader, Crawl, and Map Capabilities.
 *
 * Owns credentials, transport lifecycle, Provider field mapping, and
 * failure normalization. Clones the Firecrawl adapter's capability
 * structure (the locked analog adapter) with Spider-specific wire
 * differences: the search term rides the `search` body field (not
 * `query`), `domain` maps to `whitelist`, `location` maps to
 * `country_code`, and a non-general `topic` is a query keyword (Z.AI /
 * MiniMax precedent). `type` is Brave-only and rejected in `validate`
 * before any transport call so the option-level fallback contract can
 * continue past Spider to a capable Provider. The Reader POSTs the
 * locked four-field `/scrape` body and rejects every request control
 * with no Spider-native wire equivalent instead of accept-and-drop.
 * Crawl and Map are SYNCHRONOUS one-shot POSTs (`/crawl`, `/links`)
 * returning the final JSON array — no async job file, no poll loop —
 * with the locked 200-status crawl filter and link deduplication.
 * Quota reads GET /data/credits into a single unknown-limit "credits"
 * category (remaining only — no fabricated percent/limit), and the
 * Diagnostics probe rides the same free credits endpoint.
 *
 * The descriptor and capability interfaces below are declared locally
 * with the `"spider"` literal; they become assignable to the shared
 * `ProviderDescriptor` / `SearchCapability` contracts once `"spider"`
 * joins `PROVIDER_IDS` during registry wiring.
 */
import crypto from "node:crypto";

import type {
  SearchRequest,
  SearchControls,
  SearchRecency,
  SearchSource,
} from "../../capabilities/search.js";
import type {
  ReaderFetchRequest,
  ReaderFetchResult,
  LegacyReaderCacheCandidate,
} from "../../capabilities/reader.js";
import { decodeReaderFetchResult } from "../../capabilities/reader.js";
import type { CrawlPage, CrawlRequest, CrawlResult } from "../../capabilities/crawl.js";
import { decodeCrawlResult } from "../../capabilities/crawl.js";
import type { MapRequest, MapResult } from "../../capabilities/map.js";
import type { DiagnosticsCapability } from "../../capabilities/diagnostics.js";
import { decodeMapResult } from "../../capabilities/map.js";
import {
  ApiError,
  AuthError,
  ConfigurationError,
  NetworkError,
  QuotaError,
  TimeoutError,
  UnsupportedOptionError,
  ValidationError,
} from "../../lib/errors.js";
import { applySearchTopic } from "../../lib/search-topic.js";
import type { ProviderCapability, ProviderContext } from "../types.js";
import {
  fetchSpiderCrawl,
  fetchSpiderLinks,
  fetchSpiderScrape,
  fetchSpiderSearch,
  type SpiderScrapeParams,
  type SpiderSearchParams,
  type SpiderTransportDeps,
} from "./client.js";
import { getSpiderApiKey, requireSpiderApiKey } from "./credentials.js";
import { createSpiderQuotaCapability, type SpiderQuotaCapability } from "./quota.js";
import { createSpiderDiagnosticsCapability } from "./diagnostics.js";

// ---------------------------------------------------------------------------
// Credential + shape helpers
// ---------------------------------------------------------------------------

/**
 * Full lowercase SHA-256 hex digest of the active credential. Cache code
 * consumes the digest directly and never re-hashes it.
 */
function credentialFingerprint(apiKey: string): string {
  return crypto.createHash("sha256").update(apiKey, "utf8").digest("hex");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertHttpUrl(url: unknown): asserts url is string {
  if (typeof url !== "string" || url.length === 0) {
    throw new ValidationError("Spider reader URL must be a non-empty string");
  }
  if (!/^https?:\/\//.test(url)) {
    throw new ValidationError("URL must start with http:// or https://");
  }
}

// ---------------------------------------------------------------------------
// Request mapping
// ---------------------------------------------------------------------------

/**
 * Map `controls.recency` to the Google-style `tbs` filter Spider.cloud
 * accepts. `noLimit` (and any unknown value) omits `tbs` entirely.
 */
function mapRecencyToTbs(recency: SearchRecency): string | undefined {
  switch (recency) {
    case "oneDay":
      return "qdr:d";
    case "oneWeek":
      return "qdr:w";
    case "oneMonth":
      return "qdr:m";
    case "oneYear":
      return "qdr:y";
    case "noLimit":
      return undefined;
    default:
      return undefined;
  }
}

/**
 * Map Provider-neutral `SearchControls` to Spider-native search params.
 *
 *   domain      -> whitelist: [domain]
 *   recency     -> tbs (qdr:*)
 *   location    -> country_code (lowercased)
 *   contentSize -> no branch: the canonical payload always requests
 *                  `return_format: "markdown"` with `metadata: true`
 *                  (SCHEMA §1), which is exactly what `high` observes;
 *                  `medium` sees the same default format on the body.
 *   topic       -> keyword appended to the search field (never a wire
 *                  parameter)
 */
function mapSearchControls(request: SearchRequest): SpiderSearchParams {
  const controls = request.controls;
  const params: {
    search: string;
    return_format: "markdown";
    metadata: true;
    country_code?: string;
    tbs?: string;
    whitelist?: string[];
  } = {
    search: applySearchTopic(request.query, controls?.topic),
    return_format: "markdown",
    metadata: true,
  };
  if (controls?.domain) {
    params.whitelist = [controls.domain];
  }
  if (controls?.recency) {
    const tbs = mapRecencyToTbs(controls.recency);
    if (tbs) params.tbs = tbs;
  }
  if (controls?.location) {
    params.country_code = controls.location.toLowerCase();
  }
  return params;
}

// ---------------------------------------------------------------------------
// Response normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a raw Spider.cloud search response into `SearchSource[]`.
 *
 * The endpoint returns a flat array of page objects; a documented
 * wrapper (`{ content: [...] }`) is also accepted. Per-item mapping
 * (SCHEMA §1): `metadata.title` (empty string when absent) -> title,
 * `url` -> url, `metadata.description || content || ""` -> summary, and
 * every row is attributed to `"spider.cloud"`. Any malformed shape is a
 * retryable `ApiError` 500.
 */
function normalizeSpiderSearchResults(raw: unknown): readonly SearchSource[] {
  const results = Array.isArray(raw)
    ? raw
    : isPlainObject(raw) && Array.isArray(raw.content)
      ? raw.content
      : undefined;
  if (results === undefined) {
    throw new ApiError("Spider search returned a malformed response", 500);
  }
  const out: SearchSource[] = [];
  for (const entry of results) {
    if (!isPlainObject(entry) || typeof entry.url !== "string") {
      throw new ApiError("Spider search returned a malformed response", 500);
    }
    const metadata = isPlainObject(entry.metadata) ? entry.metadata : undefined;
    const title = typeof metadata?.title === "string" ? metadata.title : "";
    const description =
      typeof metadata?.description === "string" ? metadata.description : undefined;
    const content = typeof entry.content === "string" ? entry.content : undefined;
    const result: SearchSource = {
      title,
      url: entry.url,
      summary: description || content || "",
      source: "spider.cloud",
    };
    out.push(result);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reader response normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a raw Spider.cloud /scrape response into a
 * `ReaderFetchResult`.
 *
 * The endpoint returns an array of page objects (one for the requested
 * URL); a documented wrapper (`{ content: [...] }`) is also accepted.
 * Per-item mapping: `content` -> content (non-empty, else `ApiError` —
 * an empty fetch is an error, not a degenerate result), `url` ->
 * finalUrl (request URL fallback), `metadata.title` -> title (null when
 * absent/blank). Any malformed shape is a retryable `ApiError` 500.
 */
function normalizeSpiderScrapeResult(
  raw: unknown,
  request: ReaderFetchRequest,
): ReaderFetchResult {
  const results = Array.isArray(raw)
    ? raw
    : isPlainObject(raw) && Array.isArray(raw.content)
      ? raw.content
      : undefined;
  if (results === undefined || results.length === 0) {
    throw new ApiError("Spider scrape returned a malformed response", 500);
  }
  const page = results[0];
  if (!isPlainObject(page)) {
    throw new ApiError("Spider scrape returned a malformed response", 500);
  }
  const content = typeof page.content === "string" ? page.content : undefined;
  if (content === undefined || content.length === 0) {
    throw new ApiError("Spider scrape returned no content", 500);
  }
  const finalUrl = typeof page.url === "string" && page.url.length > 0 ? page.url : request.url;
  const metadata = isPlainObject(page.metadata) ? page.metadata : undefined;
  const rawTitle = typeof metadata?.title === "string" ? metadata.title : undefined;
  const title = rawTitle !== undefined && rawTitle.trim().length > 0 ? rawTitle : null;

  return {
    schemaVersion: 1,
    url: request.url,
    finalUrl,
    title,
    content,
    contentFormat: request.format ?? "markdown",
  };
}

// ---------------------------------------------------------------------------
// Crawl / map response normalization
// ---------------------------------------------------------------------------

/**
 * Resolve the Spider response envelope: a bare JSON array, or the
 * documented `{ content: [...] }` wrapper. `undefined` means the payload
 * is neither — a malformed response.
 */
function resolveSpiderEnvelope(raw: unknown): readonly unknown[] | undefined {
  if (Array.isArray(raw)) return raw;
  if (isPlainObject(raw) && Array.isArray(raw.content)) return raw.content;
  return undefined;
}

/**
 * Normalize a raw Spider.cloud /crawl response into a `CrawlResult`.
 *
 * The endpoint is synchronous (locked contract): the response IS the
 * final array of crawled pages — no job id, no poll. The locked filter
 * keeps only pages with `status === 200` AND a non-empty `content`
 * (SCHEMA §3); everything else (404s, error rows, empty bodies) is
 * dropped, not an error. Per-page mapping: `url` -> url, `content` ->
 * content, `contentFormat` defaults to `"markdown"` (Firecrawl
 * precedent). Any non-object entry is a retryable `ApiError` 500.
 */
function normalizeSpiderCrawlResult(raw: unknown, request: CrawlRequest): CrawlResult {
  const results = resolveSpiderEnvelope(raw);
  if (results === undefined) {
    throw new ApiError("Spider crawl returned a malformed response", 500);
  }
  const contentFormat: "markdown" | "text" = request.format ?? "markdown";
  const pages: CrawlPage[] = [];
  for (const entry of results) {
    if (!isPlainObject(entry)) {
      throw new ApiError("Spider crawl returned a malformed response", 500);
    }
    if (entry.status !== 200) continue;
    const content = typeof entry.content === "string" ? entry.content : undefined;
    if (content === undefined || content.length === 0) continue;
    if (typeof entry.url !== "string" || entry.url.length === 0) {
      throw new ApiError("Spider crawl returned a malformed response", 500);
    }
    pages.push({ url: entry.url, content, contentFormat });
  }
  return {
    schemaVersion: 1,
    baseUrl: request.url,
    pages,
    totalPages: pages.length,
  };
}

/**
 * Normalize a raw Spider.cloud /links response into a `MapResult`.
 *
 * Two accepted item shapes: the documented `{ url, status, links: [...] }`
 * row (SCHEMA §4 — each `links[]` string is a discovered URL) and the
 * flat `{ url }` row the API also returns for single-page maps. All
 * URLs are deduplicated through a `Set` (insertion order preserved);
 * `totalUrls` is the deduplicated count. Any non-object entry or
 * non-string link is a retryable `ApiError` 500.
 */
function normalizeSpiderLinksResult(raw: unknown, request: MapRequest): MapResult {
  const results = resolveSpiderEnvelope(raw);
  if (results === undefined) {
    throw new ApiError("Spider links returned a malformed response", 500);
  }
  const urls = new Set<string>();
  for (const entry of results) {
    if (!isPlainObject(entry)) {
      throw new ApiError("Spider links returned a malformed response", 500);
    }
    if (Array.isArray(entry.links)) {
      for (const link of entry.links) {
        if (typeof link !== "string" || link.length === 0) {
          throw new ApiError("Spider links returned a malformed response", 500);
        }
        urls.add(link);
      }
      continue;
    }
    if (typeof entry.url !== "string" || entry.url.length === 0) {
      throw new ApiError("Spider links returned a malformed response", 500);
    }
    urls.add(entry.url);
  }
  const unique = [...urls];
  return {
    schemaVersion: 1,
    baseUrl: request.url,
    urls: unique,
    totalUrls: unique.length,
  };
}

// ---------------------------------------------------------------------------
// Failure normalization
// ---------------------------------------------------------------------------

function inferStatusCode(known?: number): number {
  if (typeof known === "number" && Number.isFinite(known)) return known;
  return 500;
}

/**
 * Status-keyed outward message for rewrapped Spider ApiErrors. Curated
 * constants only — a raw Provider body embedded upstream never survives.
 */
function spiderApiErrorMessage(statusCode: number): string {
  if (statusCode === 429) return "Spider rate limit exceeded";
  return "Spider request failed";
}

/**
 * Normalize a Provider failure with sanitized messages. Raw response
 * bodies never cross the adapter boundary. Mirrors the Firecrawl
 * adapter's `normalizeFirecrawlError`.
 */
function normalizeSpiderError(error: unknown): Error {
  // QuotaError pass-through — terminal retry guarantee preserved.
  if (error instanceof QuotaError) return error;
  // Configuration/option/validation errors carry clean, human-authored
  // messages and are safe to surface verbatim.
  if (
    error instanceof ValidationError ||
    error instanceof UnsupportedOptionError ||
    error instanceof ConfigurationError
  ) {
    return error;
  }
  // Re-wrap typed transport errors with sanitized messages so a raw
  // Provider response body embedded upstream never survives.
  if (error instanceof AuthError) {
    return new AuthError("Spider authentication failed", "SPIDER_API_KEY");
  }
  if (error instanceof NetworkError) {
    return new NetworkError("Spider network error");
  }
  if (error instanceof TimeoutError) {
    return new TimeoutError(error.durationMs);
  }
  if (error instanceof ApiError) {
    const statusCode = inferStatusCode(error.statusCode);
    return new ApiError(spiderApiErrorMessage(statusCode), statusCode);
  }
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (
    lower.includes("401") ||
    lower.includes("403") ||
    lower.includes("unauthorized") ||
    lower.includes("forbidden")
  ) {
    return new AuthError("Spider authentication failed");
  }
  if (lower.includes("timeout") || lower.includes("timed out") || lower.includes("etimedout")) {
    return new TimeoutError(30000);
  }
  if (
    lower.includes("econnrefused") ||
    lower.includes("econnreset") ||
    lower.includes("network") ||
    lower.includes("enotfound") ||
    lower.includes("fetch failed")
  ) {
    return new NetworkError("Spider network error");
  }
  if (lower.includes("429") || lower.includes("rate limit")) {
    return new ApiError("Spider rate limit exceeded", 429);
  }
  return new ApiError("Spider request failed", 500);
}

// ---------------------------------------------------------------------------
// Search Capability
// ---------------------------------------------------------------------------

interface SpiderSearchCapabilityOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly transport?: SpiderTransportDeps;
}

/**
 * Local cache-identity type: identical to the shared
 * `SearchCacheIdentity` except `provider` is the `"spider"` literal.
 * Assignable to the shared contract once `"spider"` joins `PROVIDER_IDS`.
 */
interface SpiderSearchCacheIdentity {
  readonly provider: "spider";
  readonly capability: "search";
  readonly credentialFingerprint: string;
  readonly request: Readonly<SearchRequest>;
}

/** Local Search contract — see the module header. */
interface SpiderSearchCapability {
  validate(request: SearchRequest): void;
  cacheIdentity(request: SearchRequest): SpiderSearchCacheIdentity;
  invoke(request: SearchRequest): Promise<readonly SearchSource[]>;
}

function createSpiderSearchCapability(
  options: SpiderSearchCapabilityOptions,
): SpiderSearchCapability {
  const { env, transport } = options;
  const capability: SpiderSearchCapability = {
    validate(request: SearchRequest): void {
      if (!request || typeof request.query !== "string" || request.query.trim() === "") {
        throw new ValidationError(
          "Search query must contain at least one non-whitespace character",
        );
      }
      // Spider.cloud supports domain, recency, contentSize, location, and
      // topic. `type` is Brave-only — reject before any transport call so
      // the option-level fallback contract can continue past Spider to a
      // Provider that supports it.
      if (request.controls?.type !== undefined) {
        throw new UnsupportedOptionError("spider", "search", "type");
      }
    },
    cacheIdentity(request: SearchRequest): SpiderSearchCacheIdentity {
      const apiKey = getSpiderApiKey(env) ?? "";
      const identityRequest: { query: string; controls?: SearchControls } = {
        query: request.query,
      };
      if (request.controls) {
        identityRequest.controls = request.controls;
      }
      return {
        provider: "spider",
        capability: "search",
        credentialFingerprint: credentialFingerprint(apiKey),
        request: identityRequest,
      };
    },
    async invoke(request: SearchRequest): Promise<readonly SearchSource[]> {
      capability.validate(request);
      const apiKey = requireSpiderApiKey(env);
      try {
        const params = mapSearchControls(request);
        const raw = await fetchSpiderSearch(apiKey, params, transport);
        return normalizeSpiderSearchResults(raw);
      } catch (error) {
        throw normalizeSpiderError(error);
      }
    },
  };
  return capability;
}

// ---------------------------------------------------------------------------
// Reader Capability
// ---------------------------------------------------------------------------

/** Z.AI-only reader options that Spider.cloud has no native equivalent for. */
const UNSUPPORTED_READER_OPTIONS = [
  "withLinksSummary",
  "noGfm",
  "keepImgDataUrl",
  "withImagesSummary",
] as const;

/**
 * Reject reader request controls the locked Spider `/scrape` body does
 * not document. Accept-and-drop is banned: a control is either
 * wire-consumed or rejected here, before any transport call.
 */
function assertNoUnsupportedReaderOptions(request: ReaderFetchRequest): void {
  for (const key of UNSUPPORTED_READER_OPTIONS) {
    // Only reject when the user explicitly enabled the option (`true`);
    // the read command handler sets `false` when the flag is absent.
    if (request[key] === true) {
      throw new UnsupportedOptionError("spider", "reader", key);
    }
  }
  // No native Spider `/scrape` image or timeout field exists — reject
  // rather than silently discard the intent. `retainImages` is set only
  // when an images flag is passed, so `!== undefined` is exact.
  if (request.retainImages !== undefined) {
    throw new UnsupportedOptionError("spider", "reader", "retainImages");
  }
  if (request.timeout !== undefined) {
    throw new UnsupportedOptionError("spider", "reader", "timeout");
  }
}

interface SpiderReaderCapabilityOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly transport?: SpiderTransportDeps;
}

/**
 * Local cache-identity type: identical to the shared
 * `ReaderCacheIdentity` except `provider` is the `"spider"` literal.
 * Assignable to the shared contract once `"spider"` joins `PROVIDER_IDS`.
 */
interface SpiderReaderCacheIdentity {
  readonly provider: "spider";
  readonly capability: "reader";
  readonly operation: "reader-fetch";
  readonly credentialFingerprint: string;
  readonly request: Readonly<ReaderFetchRequest>;
  readonly legacyCandidates: readonly LegacyReaderCacheCandidate<ReaderFetchResult>[];
}

/** Local Reader operation contract — see the module header. */
interface SpiderReaderOperation {
  readonly kind: "reader-fetch";
  validate(request: ReaderFetchRequest): void;
  cacheIdentity(request: ReaderFetchRequest): SpiderReaderCacheIdentity;
  decodeCached(value: unknown): ReaderFetchResult | null;
  invoke(request: ReaderFetchRequest, signal?: AbortSignal): Promise<ReaderFetchResult>;
}

/** Local Reader contract — see the module header. */
interface SpiderReaderCapability {
  readonly fetch: SpiderReaderOperation;
}

function createSpiderReaderCapability(
  options: SpiderReaderCapabilityOptions,
): SpiderReaderCapability {
  const { env, transport } = options;

  const fetch: SpiderReaderOperation = {
    kind: "reader-fetch",

    validate(request: ReaderFetchRequest): void {
      assertHttpUrl(request.url);
      assertNoUnsupportedReaderOptions(request);
    },

    cacheIdentity(request: ReaderFetchRequest): SpiderReaderCacheIdentity {
      const apiKey = getSpiderApiKey(env) ?? "";
      return {
        provider: "spider",
        capability: "reader",
        operation: "reader-fetch",
        credentialFingerprint: credentialFingerprint(apiKey),
        request,
        legacyCandidates: [],
      };
    },

    decodeCached(value: unknown): ReaderFetchResult | null {
      return decodeReaderFetchResult(value);
    },

    async invoke(request: ReaderFetchRequest): Promise<ReaderFetchResult> {
      fetch.validate(request);

      const apiKey = requireSpiderApiKey(env);
      try {
        const contentFormat: "markdown" | "text" = request.format ?? "markdown";
        const params: SpiderScrapeParams = {
          url: request.url,
          return_format: contentFormat,
          filter_output_main_only: true,
          stealth: true,
        };
        const raw = await fetchSpiderScrape(apiKey, params, transport);
        return normalizeSpiderScrapeResult(raw, request);
      } catch (error) {
        throw normalizeSpiderError(error);
      }
    },
  };

  return { fetch };
}

// ---------------------------------------------------------------------------
// Crawl Capability
// ---------------------------------------------------------------------------

/**
 * Crawl request controls the locked Spider `/crawl` body does not
 * document. Accept-and-drop is banned: a control is either
 * wire-consumed (`limit`, `depth`, `format`) or rejected here, before
 * any transport call. `breadth`/`selectPaths`/`excludePaths`/
 * `instructions`/`contentSize`/`timeout` have no Spider-native wire
 * equivalent (SCHEMA §3 documents `url`, `limit`, `depth`,
 * `return_format` — plus provider-side fields the neutral request
 * cannot express).
 */
const UNSUPPORTED_CRAWL_OPTIONS = [
  "breadth",
  "selectPaths",
  "excludePaths",
  "instructions",
  "contentSize",
  "timeout",
] as const;

interface SpiderCrawlCapabilityOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly transport?: SpiderTransportDeps;
}

/**
 * Local cache-identity type: identical to the shared `CacheIdentity`
 * for crawl except `provider` is the `"spider"` literal. Assignable to
 * the shared contract once `"spider"` joins `PROVIDER_IDS`.
 */
interface SpiderCrawlCacheIdentity {
  readonly provider: "spider";
  readonly capability: "crawl";
  readonly credentialFingerprint: string;
  readonly request: Readonly<CrawlRequest>;
}

/** Local Crawl operation contract — see the module header. */
interface SpiderCrawlOperation {
  readonly kind: "crawl-fetch";
  validate(request: CrawlRequest): void;
  cacheIdentity(request: CrawlRequest): SpiderCrawlCacheIdentity;
  decodeCached(value: unknown): CrawlResult | null;
  invoke(request: CrawlRequest): Promise<CrawlResult>;
}

/** Local Crawl contract — see the module header. */
interface SpiderCrawlCapability {
  readonly fetch: SpiderCrawlOperation;
}

function createSpiderCrawlCapability(
  options: SpiderCrawlCapabilityOptions,
): SpiderCrawlCapability {
  const { env, transport } = options;

  const fetch: SpiderCrawlOperation = {
    kind: "crawl-fetch",

    validate(request: CrawlRequest): void {
      assertHttpUrl(request.url);
      // The crawl endpoint is synchronous: no async-job state file, no
      // poll loop, no request-scoped timeout field on the wire.
      if (request.depth !== undefined) {
        if (!Number.isInteger(request.depth) || request.depth < 1 || request.depth > 5) {
          throw new ValidationError("Crawl depth must be an integer between 1 and 5");
        }
      }
      if (request.limit !== undefined && request.limit <= 0) {
        throw new ValidationError("Crawl limit must be greater than 0");
      }
      for (const key of UNSUPPORTED_CRAWL_OPTIONS) {
        if (request[key] !== undefined) {
          throw new UnsupportedOptionError("spider", "crawl", key);
        }
      }
    },

    cacheIdentity(request: CrawlRequest): SpiderCrawlCacheIdentity {
      const apiKey = getSpiderApiKey(env) ?? "";
      return {
        provider: "spider",
        capability: "crawl",
        credentialFingerprint: credentialFingerprint(apiKey),
        request,
      };
    },

    decodeCached(value: unknown): CrawlResult | null {
      return decodeCrawlResult(value);
    },

    async invoke(request: CrawlRequest): Promise<CrawlResult> {
      fetch.validate(request);

      const apiKey = requireSpiderApiKey(env);
      try {
        const params: {
          url: string;
          return_format: "markdown" | "text";
          limit?: number;
          depth?: number;
        } = {
          url: request.url,
          return_format: request.format ?? "markdown",
        };
        if (request.limit !== undefined) {
          params.limit = request.limit;
        }
        if (request.depth !== undefined) {
          params.depth = request.depth;
        }
        // One-shot synchronous POST — the response is the final page
        // array (locked contract; never a job id to poll).
        const raw = await fetchSpiderCrawl(apiKey, params, transport);
        return normalizeSpiderCrawlResult(raw, request);
      } catch (error) {
        throw normalizeSpiderError(error);
      }
    },
  };

  return { fetch };
}

// ---------------------------------------------------------------------------
// Map Capability
// ---------------------------------------------------------------------------

/**
 * Map request controls the locked Spider `/links` body does not
 * document. Accept-and-drop is banned: a control is either
 * wire-consumed (`limit`) or rejected here, before any transport call.
 * SCHEMA §4 documents exactly `url` + `limit`; `depth`, `breadth`,
 * `selectPaths`, `excludePaths`, and `instructions` have no
 * Spider-native wire equivalent.
 */
const UNSUPPORTED_MAP_OPTIONS = [
  "depth",
  "breadth",
  "selectPaths",
  "excludePaths",
  "instructions",
] as const;

interface SpiderMapCapabilityOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly transport?: SpiderTransportDeps;
}

/**
 * Local cache-identity type: identical to the shared `CacheIdentity`
 * for map except `provider` is the `"spider"` literal. Assignable to
 * the shared contract once `"spider"` joins `PROVIDER_IDS`.
 */
interface SpiderMapCacheIdentity {
  readonly provider: "spider";
  readonly capability: "map";
  readonly credentialFingerprint: string;
  readonly request: Readonly<MapRequest>;
}

/** Local Map operation contract — see the module header. */
interface SpiderMapOperation {
  readonly kind: "map-fetch";
  validate(request: MapRequest): void;
  cacheIdentity(request: MapRequest): SpiderMapCacheIdentity;
  decodeCached(value: unknown): MapResult | null;
  invoke(request: MapRequest): Promise<MapResult>;
}

/** Local Map contract — see the module header. */
interface SpiderMapCapability {
  readonly fetch: SpiderMapOperation;
}

function createSpiderMapCapability(options: SpiderMapCapabilityOptions): SpiderMapCapability {
  const { env, transport } = options;

  const fetch: SpiderMapOperation = {
    kind: "map-fetch",

    validate(request: MapRequest): void {
      assertHttpUrl(request.url);
      if (request.limit !== undefined && request.limit <= 0) {
        throw new ValidationError("Map limit must be greater than 0");
      }
      for (const key of UNSUPPORTED_MAP_OPTIONS) {
        if (request[key] !== undefined) {
          throw new UnsupportedOptionError("spider", "map", key);
        }
      }
    },

    cacheIdentity(request: MapRequest): SpiderMapCacheIdentity {
      const apiKey = getSpiderApiKey(env) ?? "";
      return {
        provider: "spider",
        capability: "map",
        credentialFingerprint: credentialFingerprint(apiKey),
        request,
      };
    },

    decodeCached(value: unknown): MapResult | null {
      return decodeMapResult(value);
    },

    async invoke(request: MapRequest): Promise<MapResult> {
      fetch.validate(request);

      const apiKey = requireSpiderApiKey(env);
      try {
        const params: { url: string; limit?: number } = { url: request.url };
        if (request.limit !== undefined) {
          params.limit = request.limit;
        }
        const raw = await fetchSpiderLinks(apiKey, params, transport);
        return normalizeSpiderLinksResult(raw, request);
      } catch (error) {
        throw normalizeSpiderError(error);
      }
    },
  };

  return { fetch };
}

// ---------------------------------------------------------------------------
// Descriptor
// ---------------------------------------------------------------------------

/**
 * Dependencies the Spider Adapter accepts. The unified `transport` seam
 * carries `fetch` and timer injection.
 */
export interface SpiderAdapterDependencies {
  readonly transport?: SpiderTransportDeps;
}

/** Local Adapter contract — see the module header. */
interface SpiderAdapter {
  readonly id: "spider";
  readonly search: SpiderSearchCapability;
  readonly reader: SpiderReaderCapability;
  readonly crawl: SpiderCrawlCapability;
  readonly map: SpiderMapCapability;
  readonly quota: SpiderQuotaCapability;
  readonly diagnostics: DiagnosticsCapability;
}

/** Local Descriptor contract — see the module header. */
interface SpiderDescriptor {
  readonly id: "spider";
  isConfigured(env: NodeJS.ProcessEnv): boolean;
  capabilities(): ReadonlySet<ProviderCapability>;
  create(context: ProviderContext): SpiderAdapter;
  readonly credentialEnvVars: readonly string[];
}

/**
 * Build the Spider.cloud Provider Descriptor. Advertises the full
 * Spider.cloud capability set (Search, Reader, Crawl, Map, Quota,
 * Diagnostics). `create()` is side-effect-free; the transport is
 * invoked per Capability call.
 */
export function createSpiderDescriptor(
  dependencies?: SpiderAdapterDependencies,
): SpiderDescriptor {
  const transport = dependencies?.transport;
  return {
    id: "spider",
    isConfigured(env: NodeJS.ProcessEnv): boolean {
      return getSpiderApiKey(env) !== undefined;
    },
    capabilities(): ReadonlySet<ProviderCapability> {
      return new Set<ProviderCapability>([
        "search",
        "reader",
        "crawl",
        "map",
        "quota",
        "diagnostics",
      ]);
    },
    create(context: ProviderContext): SpiderAdapter {
      const search = createSpiderSearchCapability({ env: context.env, transport });
      const reader = createSpiderReaderCapability({ env: context.env, transport });
      const crawl = createSpiderCrawlCapability({ env: context.env, transport });
      const map = createSpiderMapCapability({ env: context.env, transport });
      const quota = createSpiderQuotaCapability({ env: context.env, transport });
      const diagnostics = createSpiderDiagnosticsCapability({ env: context.env, transport });
      return { id: "spider", search, reader, crawl, map, quota, diagnostics };
    },
    credentialEnvVars: ["SPIDER_API_KEY"],
  };
}
