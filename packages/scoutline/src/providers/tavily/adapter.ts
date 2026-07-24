/**
 * Tavily Provider Adapter (DESIGN.md §5, §7, tech-plan §7).
 *
 * Implements the Tavily Provider Descriptor with Search, Reader, and
 * Crawl capabilities on top of the direct-HTTP transport (`./client.ts`). The
 * Adapter owns credentials, transport lifecycle, Provider field mapping,
 * and failure normalization; shared execution owns cache and retry
 * policy.
 *
 * Boundary rules (ARCHITECTURE.md §2):
 *   - May import capability types, normalized errors, Provider identity
 *     types, and the Adapter-local credential and transport Modules.
 *   - Must NOT import command presentation, output mode, or another
 *     Provider's Adapter.
 *
 * Field mapping (tech-plan §7 Tavily mapping):
 *   Search results[].title    -> title
 *   Search results[].url      -> url
 *   Search results[].content  -> summary
 *   Search results[].score    -> (dropped)
 *
 *   Extract results[0].raw_content -> content
 *   Extract results[0].url         -> finalUrl
 *   Extract results[0]             -> title: null (Tavily doesn't return one)
 *
 * Control mapping (SearchControls → Tavily-native API params):
 *   domain     -> include_domains: [domain]
 *   recency    -> time_range (oneDay→"day", oneWeek→"week",
 *                 oneMonth→"month", oneYear→"year", noLimit→omit)
 *   contentSize -> search_depth (medium→"basic", high→"advanced")
 *   topic      -> topic (native, pass as-is)
 *   location   -> REJECTED (UnsupportedOptionError)
 */

import crypto from "node:crypto";

import type {
  ProviderAdapter,
  ProviderCapability,
  ProviderContext,
  ProviderDescriptor,
} from "../types.js";
import type {
  SearchCacheIdentity,
  SearchCapability,
  SearchControls,
  SearchRecency,
  SearchRequest,
  SearchSource,
} from "../../capabilities/search.js";
import type {
  ReaderCacheIdentity,
  ReaderCapability,
  ReaderFetchRequest,
  ReaderFetchResult,
  ReaderOperation,
} from "../../capabilities/reader.js";
import { decodeReaderFetchResult } from "../../capabilities/reader.js";
import type {
  CrawlCapability,
  CrawlOperation,
  CrawlRequest,
  CrawlResult,
  CrawlPage,
} from "../../capabilities/crawl.js";
import { decodeCrawlResult } from "../../capabilities/crawl.js";
import type { MapCapability, MapOperation, MapRequest, MapResult } from "../../capabilities/map.js";
import { decodeMapResult } from "../../capabilities/map.js";
import type {
  ResearchCapability,
  ResearchOperation,
  ResearchRequest,
  ResearchResult,
  ResearchSource,
} from "../../capabilities/research.js";
import { decodeResearchResult } from "../../capabilities/research.js";
import type { AsyncJobState, AsyncJobStateFile } from "../../lib/async-job-state.js";
import {
  computeAsyncJobStateHash,
  createProductionAsyncJobStateFile,
} from "../../lib/async-job-state.js";
import type { DiagnosticsCapability } from "../../capabilities/diagnostics.js";
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
import type { CacheIdentity } from "../../lib/execution.js";
import { asyncJobStateDir } from "../../lib/cache.js";
import { requireTavilyApiKey, isTavilyConfigured } from "./credentials.js";
import {
  fetchTavilySearch,
  fetchTavilyExtract,
  fetchTavilyCrawl,
  fetchTavilyMap,
  createTavilyResearch,
  pollTavilyResearch,
  type TavilyCrawlParams,
  type TavilyExtractParams,
  type TavilyMapParams,
  type TavilyResearchParams,
  type TavilyResearchPollResult,
  type TavilySearchParams,
  type TavilyTransportDeps,
} from "./client.js";
import { createTavilyQuotaCapability } from "./quota.js";
import { createTavilyDiagnosticsCapability } from "./diagnostics.js";

/**
 * Dependencies the Tavily Adapter accepts. The unified `transport`
 * seam carries `fetch` and timer injection; `researchStateFile` is the
 * state-file port the Research Capability uses for resume-on-restart
 * (tech-plan §3). Production defaults to the on-disk implementation
 * under `~/.scoutline/research/`; tests inject in-memory doubles to
 * exercise the lifecycle deterministically.
 */
export interface TavilyAdapterDependencies {
  /** Optional transport injection (fetch, timers, env). */
  readonly transport?: TavilyTransportDeps;
  /** Optional Research state-file port (tech-plan §3). */
  readonly researchStateFile?: AsyncJobStateFile;
}

// ---------------------------------------------------------------------------
// Provider-owned credential fingerprint
// ---------------------------------------------------------------------------

function credentialFingerprint(apiKey: string): string {
  return crypto.createHash("sha256").update(apiKey).digest("hex");
}

function resolveApiKey(env: NodeJS.ProcessEnv): string {
  return requireTavilyApiKey(env);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Control mapping (SearchControls → Tavily-native API params)
// ---------------------------------------------------------------------------

function mapRecencyToTimeRange(recency: SearchRecency): string | undefined {
  switch (recency) {
    case "oneDay":
      return "day";
    case "oneWeek":
      return "week";
    case "oneMonth":
      return "month";
    case "oneYear":
      return "year";
    case "noLimit":
      return undefined;
    default:
      return undefined;
  }
}

function mapSearchControls(controls?: SearchControls): TavilySearchParams | undefined {
  if (!controls) return undefined;
  const params: {
    topic?: string;
    search_depth?: string;
    include_domains?: readonly string[];
    time_range?: string;
  } = {};
  if (controls.domain) {
    params.include_domains = [controls.domain];
  }
  if (controls.recency) {
    const timeRange = mapRecencyToTimeRange(controls.recency);
    if (timeRange) params.time_range = timeRange;
  }
  if (controls.contentSize) {
    params.search_depth = controls.contentSize === "high" ? "advanced" : "basic";
  }
  if (controls.topic) {
    params.topic = controls.topic;
  }
  return params;
}

// ---------------------------------------------------------------------------
// Response normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a raw Tavily search response into `SearchSource[]`.
 *
 *   results[].title    -> title
 *   results[].url      -> url
 *   results[].content  -> summary
 *   results[].score    -> (dropped)
 *
 * Any malformed shape is a retryable `ApiError` 500.
 */
function normalizeTavilySearchResults(raw: unknown): readonly SearchSource[] {
  if (!isPlainObject(raw)) {
    throw new ApiError("Tavily search returned a malformed response", 500);
  }
  const results = raw.results;
  if (!Array.isArray(results)) {
    throw new ApiError("Tavily search returned a malformed response", 500);
  }
  const out: SearchSource[] = [];
  for (const entry of results) {
    if (!isPlainObject(entry)) {
      throw new ApiError("Tavily search returned a malformed response", 500);
    }
    const title = entry.title;
    const url = entry.url;
    const content = entry.content;
    if (typeof title !== "string" || typeof url !== "string" || typeof content !== "string") {
      throw new ApiError("Tavily search returned a malformed response", 500);
    }
    out.push({ title, url, summary: content });
  }
  return out;
}

/**
 * Normalize a raw Tavily extract response into a `ReaderFetchResult`.
 *
 *   results[0].raw_content -> content
 *   results[0].url         -> finalUrl
 *   results[0]             -> title: null (Tavily doesn't return a title)
 *
 * If `failed_results` contains the requested URL, throw `ApiError` 422.
 * 422 (Unprocessable Entity) is a terminal 4xx code so the reader does
 * not retry a permanent extraction failure. Any other malformed shape
 * is a retryable `ApiError` 500.
 */
function normalizeTavilyExtractResult(
  raw: unknown,
  request: ReaderFetchRequest,
): ReaderFetchResult {
  if (!isPlainObject(raw)) {
    throw new ApiError("Tavily extract returned a malformed response", 500);
  }

  // Check failed_results for the requested URL.
  const failedResults = raw.failed_results;
  if (Array.isArray(failedResults)) {
    for (const f of failedResults) {
      if (isPlainObject(f) && typeof f.url === "string" && f.url === request.url) {
        throw new ApiError("Tavily extract failed for URL", 422);
      }
    }
  }

  const results = raw.results;
  if (!Array.isArray(results) || results.length === 0) {
    throw new ApiError("Tavily extract returned a malformed response", 500);
  }
  const first = results[0];
  if (!isPlainObject(first)) {
    throw new ApiError("Tavily extract returned a malformed response", 500);
  }
  const content = first.raw_content;
  if (typeof content !== "string" || content.length === 0) {
    throw new ApiError("Tavily extract returned a malformed response", 500);
  }
  const finalUrl = typeof first.url === "string" && first.url.length > 0 ? first.url : request.url;
  const contentFormat: "markdown" | "text" = request.format ?? "markdown";

  return {
    schemaVersion: 1,
    url: request.url,
    finalUrl,
    title: null,
    content,
    contentFormat,
  };
}

// ---------------------------------------------------------------------------
// Failure normalization: stable public codes, no raw payloads (NFR-006)
// ---------------------------------------------------------------------------

/**
 * Resolve a stable HTTP-style status code for retry classification.
 * Explicit terminal client errors (400, 404, 410, 422) map to their
 * real codes; transient failures map to a representative status in the
 * retryable set (429 or any 5xx 500..599 inclusive, per DESIGN.md §18 /
 * FR-090). Unknown failures default to 500 (transient). When the caller
 * already carries a numeric status (a typed ApiError), that status is
 * honoured directly.
 */
function inferStatusCode(lower: string, known?: number): number {
  if (typeof known === "number" && Number.isFinite(known)) return known;
  if (lower.includes("404") || lower.includes("not found")) return 404;
  if (lower.includes("400") || lower.includes("bad request")) return 400;
  if (lower.includes("410") || lower.includes("gone")) return 410;
  if (lower.includes("422") || lower.includes("unprocessable")) return 422;
  if (lower.includes("500") || lower.includes("internal")) return 500;
  if (lower.includes("502") || lower.includes("bad gateway")) return 502;
  if (lower.includes("503") || lower.includes("service unavailable")) return 503;
  if (lower.includes("504") || lower.includes("gateway timeout")) return 504;
  return 500;
}

/**
 * Status-keyed outward message for rewrapped Tavily ApiErrors. The rewrap
 * does not echo upstream `error.message` — a future change embedding a
 * raw Provider body in an ApiError message would leak through
 * normalization, the cache, and stdout. Curated constants only.
 */
function tavilyApiErrorMessage(statusCode: number): string {
  if (statusCode === 429) return "Tavily rate limit exceeded";
  if (statusCode === 432) {
    return "Tavily plan limit exceeded. Upgrade your plan at app.tavily.com.";
  }
  if (statusCode === 433) {
    return "Tavily pay-as-you-go limit exceeded. Increase your limit on the Tavily dashboard.";
  }
  return "Tavily request failed";
}

/**
 * Normalize a Provider failure with sanitized messages. Raw response
 * bodies never cross the adapter boundary. Same pattern as
 * `normalizeMiniMaxError`.
 */
function normalizeTavilyError(error: unknown): Error {
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
  // Provider response body embedded upstream never survives. Code +
  // statusCode (retry signal) are preserved.
  if (error instanceof AuthError) {
    return new AuthError("Tavily authentication failed", "TAVILY_API_KEY");
  }
  if (error instanceof NetworkError) {
    return new NetworkError("Tavily network error");
  }
  if (error instanceof TimeoutError) {
    return new TimeoutError(
      error.durationMs,
      "Try again or increase timeout with TAVILY_TIMEOUT env var",
    );
  }
  if (error instanceof ApiError) {
    const statusCode = inferStatusCode("", error.statusCode);
    return new ApiError(tavilyApiErrorMessage(statusCode), statusCode);
  }
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (
    lower.includes("401") ||
    lower.includes("403") ||
    lower.includes("unauthorized") ||
    lower.includes("forbidden")
  ) {
    return new AuthError("Tavily authentication failed");
  }
  if (lower.includes("timeout") || lower.includes("timed out") || lower.includes("etimedout")) {
    // Fallback branch: the transport wraps real timeouts into a typed
    // TimeoutError (which carries the configured duration) before they
    // reach this point. This untyped-message heuristic is rarely hit, so
    // a constant default is fine and keeps process.env out of the
    // normalization path (test isolation).
    return new TimeoutError(30000);
  }
  if (
    lower.includes("econnrefused") ||
    lower.includes("econnreset") ||
    lower.includes("network") ||
    lower.includes("enotfound") ||
    lower.includes("fetch failed")
  ) {
    return new NetworkError("Tavily network error");
  }
  if (lower.includes("429") || lower.includes("rate limit")) {
    return new ApiError("Tavily rate limit exceeded", 429);
  }
  return new ApiError("Tavily request failed", inferStatusCode(lower));
}

// ---------------------------------------------------------------------------
// Reader validation helpers
// ---------------------------------------------------------------------------

/** Z.AI-only reader options that Tavily does not accept. */
const UNSUPPORTED_READER_OPTIONS = [
  "withLinksSummary",
  "noGfm",
  "keepImgDataUrl",
  "withImagesSummary",
] as const;

function assertHttpUrl(url: unknown): asserts url is string {
  if (typeof url !== "string" || url.length === 0) {
    throw new ValidationError("Tavily reader URL must be a non-empty string");
  }
  if (!/^https?:\/\//.test(url)) {
    throw new ValidationError("URL must start with http:// or https://");
  }
}

function assertNoUnsupportedReaderOptions(request: ReaderFetchRequest): void {
  for (const key of UNSUPPORTED_READER_OPTIONS) {
    // Only reject when the user explicitly enabled the option (`true`).
    // The read command handler sets boolean options to `false` (not
    // `undefined`) when the flag is absent, so `!== undefined` would
    // over-reject. `false` means "user didn't pass the flag" → accept.
    if (request[key] === true) {
      throw new UnsupportedOptionError("tavily", "reader", key);
    }
  }
}

// ---------------------------------------------------------------------------
// Search Capability
// ---------------------------------------------------------------------------

interface TavilySearchCapabilityOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly transport?: TavilyTransportDeps;
}

function createTavilySearchCapability(options: TavilySearchCapabilityOptions): SearchCapability {
  const { env, transport } = options;

  const capability: SearchCapability = {
    validate(request: SearchRequest): void {
      if (!request || typeof request.query !== "string" || request.query.trim() === "") {
        throw new ValidationError(
          "Search query must contain at least one non-whitespace character",
        );
      }
      // Tavily supports domain, recency, contentSize, and topic natively.
      // location is Z.AI-specific and rejected before any transport call.
      // type (video content axis) is not supported by Tavily (Brave
      // supplies video), so it is rejected here.
      if (request.controls?.location !== undefined) {
        throw new UnsupportedOptionError("tavily", "search", "location");
      }
      if (request.controls?.type !== undefined) {
        throw new UnsupportedOptionError("tavily", "search", "type");
      }
    },

    cacheIdentity(request: SearchRequest): SearchCacheIdentity {
      const apiKey = resolveApiKey(env);
      const identityRequest: { query: string; controls?: SearchControls } = {
        query: request.query,
      };
      if (request.controls) {
        identityRequest.controls = request.controls;
      }
      return {
        provider: "tavily",
        capability: "search",
        credentialFingerprint: credentialFingerprint(apiKey),
        request: identityRequest,
        // Tavily never probes legacy keys — no legacyCandidates.
      };
    },

    async invoke(request: SearchRequest): Promise<readonly SearchSource[]> {
      capability.validate(request);

      const apiKey = resolveApiKey(env);
      try {
        const params = mapSearchControls(request.controls);
        const raw = await fetchTavilySearch(apiKey, request.query, params, transport);
        return normalizeTavilySearchResults(raw);
      } catch (error) {
        throw normalizeTavilyError(error);
      }
    },
  };

  return capability;
}

// ---------------------------------------------------------------------------
// Reader Capability
// ---------------------------------------------------------------------------

interface TavilyReaderCapabilityOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly transport?: TavilyTransportDeps;
}

function createTavilyReaderCapability(options: TavilyReaderCapabilityOptions): ReaderCapability {
  const { env, transport } = options;

  const fetch: ReaderOperation<ReaderFetchRequest, ReaderFetchResult> = {
    kind: "reader-fetch",

    validate(request: ReaderFetchRequest): void {
      assertHttpUrl(request.url);
      assertNoUnsupportedReaderOptions(request);
    },

    cacheIdentity(
      request: ReaderFetchRequest,
    ): ReaderCacheIdentity<ReaderFetchRequest, ReaderFetchResult> {
      const apiKey = resolveApiKey(env);
      return {
        provider: "tavily",
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

      const apiKey = resolveApiKey(env);
      try {
        const raw = await fetchTavilyExtract(apiKey, request.url, undefined, transport);
        return normalizeTavilyExtractResult(raw, request);
      } catch (error) {
        throw normalizeTavilyError(error);
      }
    },
  };

  return { fetch };
}

// ---------------------------------------------------------------------------
// Crawl Capability
// ---------------------------------------------------------------------------

/**
 * Split a comma-separated path-pattern string into an array, trimming
 * whitespace from each entry. Returns `undefined` for empty/whitespace-
 * only input.
 */
function splitPathPatterns(value: string | undefined): readonly string[] | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Map a Provider-neutral `CrawlRequest` into Tavily-native API params.
 *
 *   url           -> url (handled by transport)
 *   depth         -> max_depth
 *   breadth       -> max_breadth
 *   limit         -> limit
 *   selectPaths   -> select_paths (split on comma if string)
 *   excludePaths  -> exclude_paths (split on comma if string)
 *   instructions  -> instructions
 *   format        -> format
 *   contentSize   -> extract_depth (medium→"basic", high→"advanced")
 *   timeout       -> timeout
 */
function mapCrawlControls(request: CrawlRequest): TavilyCrawlParams {
  const params: {
    max_depth?: number;
    max_breadth?: number;
    limit?: number;
    select_paths?: readonly string[];
    exclude_paths?: readonly string[];
    instructions?: string;
    format?: string;
    extract_depth?: string;
    timeout?: number;
  } = {};
  if (request.depth !== undefined) params.max_depth = request.depth;
  if (request.breadth !== undefined) params.max_breadth = request.breadth;
  if (request.limit !== undefined) params.limit = request.limit;
  const selectPaths = splitPathPatterns(request.selectPaths);
  if (selectPaths !== undefined) params.select_paths = selectPaths;
  const excludePaths = splitPathPatterns(request.excludePaths);
  if (excludePaths !== undefined) params.exclude_paths = excludePaths;
  if (request.instructions !== undefined) params.instructions = request.instructions;
  if (request.format !== undefined) params.format = request.format;
  if (request.contentSize !== undefined) {
    params.extract_depth = request.contentSize === "high" ? "advanced" : "basic";
  }
  if (request.timeout !== undefined) params.timeout = request.timeout;
  return params;
}

/**
 * Normalize a raw Tavily crawl response into a `CrawlResult`.
 *
 *   results[].url         -> page.url
 *   results[].raw_content -> page.content
 *   format                -> page.contentFormat (from request, default markdown)
 *   baseUrl               -> the request URL
 *   totalPages            -> results array length
 *
 * Any malformed shape is a retryable `ApiError` 500.
 */
function normalizeTavilyCrawlResult(raw: unknown, request: CrawlRequest): CrawlResult {
  if (!isPlainObject(raw)) {
    throw new ApiError("Tavily crawl returned a malformed response", 500);
  }
  const results = raw.results;
  if (!Array.isArray(results)) {
    throw new ApiError("Tavily crawl returned a malformed response", 500);
  }
  const contentFormat: "markdown" | "text" = request.format ?? "markdown";
  const pages: CrawlPage[] = [];
  for (const entry of results) {
    if (!isPlainObject(entry)) {
      throw new ApiError("Tavily crawl returned a malformed response", 500);
    }
    const url = entry.url;
    const content = entry.raw_content;
    if (typeof url !== "string" || typeof content !== "string") {
      throw new ApiError("Tavily crawl returned a malformed response", 500);
    }
    pages.push({ url, content, contentFormat });
  }
  return {
    schemaVersion: 1,
    baseUrl: request.url,
    pages,
    totalPages: pages.length,
  };
}

interface TavilyCrawlCapabilityOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly transport?: TavilyTransportDeps;
}

function createTavilyCrawlCapability(options: TavilyCrawlCapabilityOptions): CrawlCapability {
  const { env, transport } = options;

  const fetch: CrawlOperation = {
    kind: "crawl-fetch",

    validate(request: CrawlRequest): void {
      assertHttpUrl(request.url);
      if (request.depth !== undefined) {
        if (!Number.isInteger(request.depth) || request.depth < 1 || request.depth > 5) {
          throw new ValidationError("Crawl depth must be an integer between 1 and 5");
        }
      }
      if (request.breadth !== undefined) {
        if (!Number.isInteger(request.breadth) || request.breadth < 1 || request.breadth > 500) {
          throw new ValidationError("Crawl breadth must be an integer between 1 and 500");
        }
      }
      if (request.limit !== undefined && request.limit <= 0) {
        throw new ValidationError("Crawl limit must be greater than 0");
      }
    },

    cacheIdentity(request: CrawlRequest): CacheIdentity<CrawlRequest, CrawlResult> {
      const apiKey = resolveApiKey(env);
      return {
        provider: "tavily",
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

      const apiKey = resolveApiKey(env);
      try {
        const params = mapCrawlControls(request);
        const raw = await fetchTavilyCrawl(apiKey, request.url, params, transport);
        return normalizeTavilyCrawlResult(raw, request);
      } catch (error) {
        throw normalizeTavilyError(error);
      }
    },
  };

  return { fetch };
}

// ---------------------------------------------------------------------------
// Map Capability
// ---------------------------------------------------------------------------

/**
 * Map a Provider-neutral `MapRequest` into Tavily-native API params.
 *
 *   url           -> url (handled by transport)
 *   depth         -> max_depth
 *   breadth       -> max_breadth
 *   limit         -> limit
 *   selectPaths   -> select_paths (split on comma if string)
 *   excludePaths  -> exclude_paths (split on comma if string)
 *   instructions  -> instructions
 *
 * Map returns URLs only — no `format`, `extract_depth`, or `timeout` are
 * sent on the /map request body.
 */
function mapMapControls(request: MapRequest): TavilyMapParams {
  const params: {
    max_depth?: number;
    max_breadth?: number;
    limit?: number;
    select_paths?: readonly string[];
    exclude_paths?: readonly string[];
    instructions?: string;
  } = {};
  if (request.depth !== undefined) params.max_depth = request.depth;
  if (request.breadth !== undefined) params.max_breadth = request.breadth;
  if (request.limit !== undefined) params.limit = request.limit;
  const selectPaths = splitPathPatterns(request.selectPaths);
  if (selectPaths !== undefined) params.select_paths = selectPaths;
  const excludePaths = splitPathPatterns(request.excludePaths);
  if (excludePaths !== undefined) params.exclude_paths = excludePaths;
  if (request.instructions !== undefined) params.instructions = request.instructions;
  return params;
}

/**
 * Normalize a raw Tavily map response into a `MapResult`.
 *
 *   results (string[]) -> urls
 *   baseUrl            -> the request URL
 *   totalUrls          -> results array length
 *
 * Any malformed shape is a retryable `ApiError` 500.
 */
function normalizeTavilyMapResult(raw: unknown, request: MapRequest): MapResult {
  if (!isPlainObject(raw)) {
    throw new ApiError("Tavily map returned a malformed response", 500);
  }
  const results = raw.results;
  if (!Array.isArray(results)) {
    throw new ApiError("Tavily map returned a malformed response", 500);
  }
  const urls: string[] = [];
  for (const entry of results) {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new ApiError("Tavily map returned a malformed response", 500);
    }
    urls.push(entry);
  }
  return {
    schemaVersion: 1,
    baseUrl: request.url,
    urls,
    totalUrls: urls.length,
  };
}

interface TavilyMapCapabilityOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly transport?: TavilyTransportDeps;
}

function createTavilyMapCapability(options: TavilyMapCapabilityOptions): MapCapability {
  const { env, transport } = options;

  const fetch: MapOperation = {
    kind: "map-fetch",

    validate(request: MapRequest): void {
      assertHttpUrl(request.url);
      if (request.depth !== undefined) {
        if (!Number.isInteger(request.depth) || request.depth < 1 || request.depth > 5) {
          throw new ValidationError("Map depth must be an integer between 1 and 5");
        }
      }
      if (request.breadth !== undefined) {
        if (!Number.isInteger(request.breadth) || request.breadth < 1 || request.breadth > 500) {
          throw new ValidationError("Map breadth must be an integer between 1 and 500");
        }
      }
      if (request.limit !== undefined && request.limit <= 0) {
        throw new ValidationError("Map limit must be greater than 0");
      }
    },

    cacheIdentity(request: MapRequest): CacheIdentity<MapRequest, MapResult> {
      const apiKey = resolveApiKey(env);
      return {
        provider: "tavily",
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

      const apiKey = resolveApiKey(env);
      try {
        const params = mapMapControls(request);
        const raw = await fetchTavilyMap(apiKey, request.url, params, transport);
        return normalizeTavilyMapResult(raw, request);
      } catch (error) {
        throw normalizeTavilyError(error);
      }
    },
  };

  return { fetch };
}

// ---------------------------------------------------------------------------
// Research Capability (tech-plan §2c, §3)
// ---------------------------------------------------------------------------

/**
 * Default polling interval between GET /research/{id} calls. Overridable
 * via `TAVILY_RESEARCH_POLL_INTERVAL_MS` in the transport env so tests
 * can poll instantly.
 */
const DEFAULT_RESEARCH_POLL_INTERVAL_MS = 5000;

function resolvePollIntervalMs(env: NodeJS.ProcessEnv | undefined): number {
  const raw = env?.TAVILY_RESEARCH_POLL_INTERVAL_MS;
  const parsed = parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_RESEARCH_POLL_INTERVAL_MS;
}

/**
 * Build a `sleep(ms)` from the injected timers so tests that pass fake
 * `setTimeout`/`clearTimeout` through the transport deps also control
 * poll-loop timing. A non-positive interval resolves immediately.
 *
 * When `signal` is supplied, the sleep is abortable: if the signal is
 * already aborted (or aborts while sleeping), the pending timer is
 * cleared and the promise rejects with a `TimeoutError`. This lets the
 * research poll loop unwind promptly when the command handler's
 * `--timeout` fires, so lingering `setTimeout`s do not keep the event
 * loop alive and freeze the CLI. The rejection is swallowed by the
 * command handler's late-rejection guard.
 */
function makeSleep(
  deps: TavilyTransportDeps | undefined,
  signal?: AbortSignal,
): (ms: number) => Promise<void> {
  const setT = deps?.setTimeout ?? setTimeout;
  const clearT = deps?.clearTimeout ?? clearTimeout;
  return (ms: number) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new TimeoutError(0, "Research polling aborted"));
        return;
      }
      if (ms <= 0) {
        // Yield to the event loop even for a zero interval so the poll
        // loop never starves macrotasks (tests, signal handlers).
        setImmediate(() => {
          if (signal?.aborted) {
            reject(new TimeoutError(0, "Research polling aborted"));
            return;
          }
          resolve();
        });
        return;
      }
      const onAbort = (): void => {
        clearT(id);
        reject(new TimeoutError(0, "Research polling aborted"));
      };
      const id = setT(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal?.addEventListener("abort", onAbort);
    });
}

function isEexistError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === "EEXIST"
  );
}

/**
 * Map a Provider-neutral `ResearchRequest` into Tavily-native API params
 * (minus the query, which the transport adds).
 *
 *   model          -> model
 *   outputLength   -> output_length
 *   citationFormat -> citation_format
 *   domain         -> domain
 */
function mapResearchControls(request: ResearchRequest): Omit<TavilyResearchParams, "query"> {
  const params: {
    model?: string;
    output_length?: string;
    citation_format?: string;
    domain?: string;
  } = {};
  if (request.model !== undefined) params.model = request.model;
  if (request.outputLength !== undefined) params.output_length = request.outputLength;
  if (request.citationFormat !== undefined) params.citation_format = request.citationFormat;
  if (request.domain !== undefined) params.domain = request.domain;
  return params;
}

/**
 * Normalize a completed Tavily research poll result into a
 * `ResearchResult`.
 *
 *   content -> report
 *   sources[].title -> sources[].title
 *   sources[].url   -> sources[].url   (favicon dropped)
 *   model           -> echoed from the request (default "auto")
 */
function normalizeTavilyResearchResult(
  poll: TavilyResearchPollResult,
  request: ResearchRequest,
): ResearchResult {
  const sources: ResearchSource[] = [];
  if (poll.sources) {
    for (const entry of poll.sources) {
      // Drop sources missing title or url rather than failing the whole
      // report — a partial source list is still useful.
      if (entry.title && entry.url) {
        sources.push({ title: entry.title, url: entry.url });
      }
    }
  }
  return {
    schemaVersion: 1,
    query: request.query,
    model: request.model ?? "auto",
    report: poll.content ?? "",
    sources,
  };
}

interface TavilyResearchCapabilityOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly transport?: TavilyTransportDeps;
  readonly researchStateFile: AsyncJobStateFile;
}

function createTavilyResearchCapability(
  options: TavilyResearchCapabilityOptions,
): ResearchCapability {
  const { env, transport, researchStateFile } = options;

  const run: ResearchOperation = {
    kind: "research-fetch",

    validate(request: ResearchRequest): void {
      if (!request || typeof request.query !== "string" || request.query.trim() === "") {
        throw new ValidationError(
          "Research query must contain at least one non-whitespace character",
        );
      }
    },

    cacheIdentity(request: ResearchRequest): CacheIdentity<ResearchRequest, ResearchResult> {
      const apiKey = resolveApiKey(env);
      return {
        provider: "tavily",
        capability: "research",
        credentialFingerprint: credentialFingerprint(apiKey),
        request,
      };
    },

    decodeCached(value: unknown): ResearchResult | null {
      return decodeResearchResult(value);
    },

    async invoke(request: ResearchRequest, signal?: AbortSignal): Promise<ResearchResult> {
      run.validate(request);

      const apiKey = resolveApiKey(env);
      const credFingerprint = credentialFingerprint(apiKey);
      const identityHash = computeAsyncJobStateHash({
        provider: "tavily",
        capability: "research",
        credentialFingerprint: credFingerprint,
        request,
      });

      const pollIntervalMs = resolvePollIntervalMs(transport?.env);
      // Abortable sleep: when `signal` aborts (the command handler's
      // `--timeout` fired), the pending poll-interval timer is cleared
      // and rejects, unwinding the loop so the process can exit.
      const sleep = makeSleep(transport, signal);

      try {
        // 1. Check for an in-flight task (resume after Ctrl-C / crash).
        //    A valid state file with a pending/in_progress status means a
        //    task was already created server-side — poll it instead of
        //    creating a second one (double-charge prevention).
        const existingState = await researchStateFile.read(identityHash);
        let requestId: string;

        if (existingState !== null) {
          // Resume the existing task — no new POST.
          requestId = existingState.requestId;
        } else {
          // 2. No in-flight task: POST to create one. NO retry — a
          //    transient POST failure is terminal (the user re-runs);
          //    retrying risks a double-charge if the POST succeeded
          //    server-side but the response was lost.
          requestId = await createResearchTask(
            apiKey,
            request,
            identityHash,
            researchStateFile,
            transport,
          );
        }

        // 3. Poll loop until terminal status.
        for (;;) {
          // Re-check the abort signal each iteration. If the command
          // handler's --timeout fired during the create POST or between
          // sleeps, exit immediately rather than issuing another poll.
          if (signal?.aborted) {
            throw new TimeoutError(0, "Research polling aborted");
          }
          const poll = await pollTavilyResearch(apiKey, requestId, transport);

          if (poll.status === "completed") {
            // Success — delete the state file and return the result.
            await researchStateFile.remove(identityHash);
            return normalizeTavilyResearchResult(poll, request);
          }

          if (poll.status === "failed") {
            // Server-side failure — delete the state file and throw.
            await researchStateFile.remove(identityHash);
            throw new ApiError("Tavily research task failed", 500);
          }

          if (poll.status === "not_found") {
            // 404 — the server-side task expired/disappeared. Delete the
            // stale state file and create a fresh task, then continue
            // polling. The state file is removed first so the `wx`-flag
            // write in createResearchTask succeeds.
            await researchStateFile.remove(identityHash);
            requestId = await createResearchTask(
              apiKey,
              request,
              identityHash,
              researchStateFile,
              transport,
            );
            continue;
          }

          // pending or in_progress: sleep and poll again. The state file
          // already holds the requestId; we intentionally do NOT rewrite
          // it here — the `wx` flag only allows creation, and the
          // requestId (not the transient status) is the load-bearing
          // field for resume. The transient poll status is therefore not
          // persisted, which is why no reassignment is needed here.
          await sleep(pollIntervalMs);
        }
      } catch (error) {
        throw normalizeTavilyError(error);
      }
    },
  };

  return { run };
}

/**
 * POST /research to create a task, then persist its requestId in the
 * state file atomically. On EEXIST (a concurrent invocation already
 * created a task for this request), read the existing state file and
 * return its requestId instead — the concurrent task is polled, not
 * duplicated.
 */
async function createResearchTask(
  apiKey: string,
  request: ResearchRequest,
  identityHash: string,
  stateFile: AsyncJobStateFile,
  transport: TavilyTransportDeps | undefined,
): Promise<string> {
  const params = mapResearchControls(request);
  const created = await createTavilyResearch(apiKey, request.query, params, transport);
  const requestId = created.requestId;

  const state: AsyncJobState = {
    requestId,
    identityHash,
    createdAt: new Date().toISOString(),
    status: "pending",
  };
  try {
    await stateFile.write(identityHash, state);
  } catch (err) {
    if (isEexistError(err)) {
      // Concurrent invocation won the race — poll its task instead.
      const existing = await stateFile.read(identityHash);
      if (existing !== null) {
        return existing.requestId;
      }
      // The existing file was corrupt (read returned null after deleting
      // it). Fall through and poll the task we just created — it is
      // valid server-side even if we cannot persist it.
    } else {
      throw err;
    }
  }
  return requestId;
}

// ---------------------------------------------------------------------------
// Descriptor factory
// ---------------------------------------------------------------------------

/**
 * Build the Tavily Provider Descriptor. The descriptor advertises the
 * full Tavily capability set and constructs an Adapter whose `search`
 * and `reader` Capabilities own credentials, transport, Provider field
 * mapping, and failure normalization. Construction is side-effect-free;
 * the transport is invoked per Capability call. Tests pass `transport`
 * (typically a fake-fetch wrapper); production uses the no-argument
 * factory which resolves to the global `fetch` and timers inside the
 * transport Module.
 */
export function createTavilyDescriptor(
  dependencies?: TavilyAdapterDependencies,
): ProviderDescriptor {
  const transport = dependencies?.transport;
  const researchStateFile =
    dependencies?.researchStateFile ??
    createProductionAsyncJobStateFile(asyncJobStateDir("research"));

  return {
    id: "tavily",
    isConfigured(env: NodeJS.ProcessEnv): boolean {
      return isTavilyConfigured(env);
    },
    capabilities(): ReadonlySet<ProviderCapability> {
      return new Set<ProviderCapability>([
        "search",
        "reader",
        "crawl",
        "map",
        "research",
        "quota",
        "diagnostics",
      ]);
    },
    create(context: ProviderContext): ProviderAdapter {
      const search = createTavilySearchCapability({
        env: context.env,
        transport,
      });
      const reader = createTavilyReaderCapability({
        env: context.env,
        transport,
      });
      const crawl = createTavilyCrawlCapability({
        env: context.env,
        transport,
      });
      const map = createTavilyMapCapability({
        env: context.env,
        transport,
      });
      const research = createTavilyResearchCapability({
        env: context.env,
        transport,
        researchStateFile,
      });
      const quota = createTavilyQuotaCapability({
        env: context.env,
        transport,
      });
      const diagnostics: DiagnosticsCapability = createTavilyDiagnosticsCapability({
        env: context.env,
        transport,
      });
      return { id: "tavily", search, reader, crawl, map, research, quota, diagnostics };
    },
  };
}
