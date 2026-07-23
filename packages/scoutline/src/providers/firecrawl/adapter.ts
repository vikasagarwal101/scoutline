/**
 * Firecrawl Provider Adapter (firecrawl tech-plan §1, D3–D6).
 *
 * Implements the Firecrawl Provider Descriptor with Search, Reader, and Map
 * capabilities on top of the direct-HTTP transport (`./client.ts`). The
 * Adapter owns credentials, transport lifecycle, Provider field mapping,
 * and failure normalization; shared execution owns cache and retry policy.
 *
 * Async Crawl (FC-04), Quota, and Diagnostics (FC-05) are advertised by the
 * descriptor but NOT yet wired here — their `adapter` slots are omitted, so
 * the command dispatch's `if (!adapter.crawl) throw UnsupportedCapabilityError`
 * guard surfaces a clean error until they land.
 *
 * Boundary rules (ARCHITECTURE.md §2):
 *   - May import capability types, normalized errors, Provider identity
 *     types, and the Adapter-local credential and transport Modules.
 *   - Must NOT import command presentation, output mode, or another
 *     Provider's Adapter.
 *
 * Field mapping (tech-plan D4/D5/D6; investigation §3.1–§3.4):
 *   Search data[].title       -> title
 *   Search data[].url         -> url
 *   Search data[].markdown    -> summary  (high content-size; else description)
 *   Search data[].description -> summary  (medium content-size fallback)
 *
 *   Scrape data.markdown|text -> content
 *   Scrape data.metadata.sourceURL -> finalUrl
 *   Scrape data.metadata.title     -> title  (better than Tavily's null)
 *
 *   Map links[]               -> urls
 */

import crypto from "node:crypto";

import type {
  ProviderAdapter,
  ProviderCapability,
  ProviderContext,
  ProviderDescriptor,
} from "../types.js";
import type { CacheIdentity } from "../../lib/execution.js";
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
import type { MapCapability, MapOperation, MapRequest, MapResult } from "../../capabilities/map.js";
import { decodeMapResult } from "../../capabilities/map.js";
import type {
  CrawlCapability,
  CrawlOperation,
  CrawlPage,
  CrawlRequest,
  CrawlResult,
} from "../../capabilities/crawl.js";
import { decodeCrawlResult } from "../../capabilities/crawl.js";
import {
  computeAsyncJobStateHash,
  createProductionAsyncJobStateFile,
  type AsyncJobState,
  type AsyncJobStateFile,
} from "../../lib/async-job-state.js";
import { asyncJobStateDir } from "../../lib/cache.js";
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
import {
  createFirecrawlCrawl,
  fetchFirecrawlCrawlNext,
  fetchFirecrawlMap,
  fetchFirecrawlScrape,
  fetchFirecrawlSearch,
  listActiveFirecrawlCrawls,
  pollFirecrawlCrawl,
  type FirecrawlCrawlParams,
  type FirecrawlMapParams,
  type FirecrawlScrapeParams,
  type FirecrawlSearchParams,
  type FirecrawlTransportDeps,
} from "./client.js";
import { isFirecrawlConfigured, requireFirecrawlApiKey } from "./credentials.js";
import { createFirecrawlQuotaCapability } from "./quota.js";
import { createFirecrawlDiagnosticsCapability } from "./diagnostics.js";

// ---------------------------------------------------------------------------
// Credential + shape helpers
// ---------------------------------------------------------------------------

function credentialFingerprint(apiKey: string): string {
  return crypto.createHash("sha256").update(apiKey).digest("hex");
}

function resolveApiKey(env: NodeJS.ProcessEnv): string {
  return requireFirecrawlApiKey(env);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertHttpUrl(url: unknown): asserts url is string {
  if (typeof url !== "string" || url.length === 0) {
    throw new ValidationError("Firecrawl reader URL must be a non-empty string");
  }
  if (!/^https?:\/\//.test(url)) {
    throw new ValidationError("URL must start with http:// or https://");
  }
}

// ---------------------------------------------------------------------------
// Search control mapping (SearchControls → Firecrawl-native API params)
// ---------------------------------------------------------------------------

/**
 * Map `--recency` to Firecrawl's Google-style `tbs` time filter
 * (investigation §3.2). `noLimit` and absent recency omit the param.
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
 * Map Provider-neutral `SearchControls` to Firecrawl-native search params.
 *
 *   domain      -> includeDomains: [domain]
 *   recency     -> tbs (qdr:*)
 *   contentSize -> scrapeOptions.formats:["markdown"]  (high only)
 *   topic       -> sources: news → [{type:"news"}], else [{type:"web"}]
 *
 * `location` is rejected in `validate` (Z.AI-specific). `sources` always
 * carries a default of `[{type:"web"}]` per the investigation's
 * recommended default.
 */
function mapSearchControls(controls?: SearchControls): FirecrawlSearchParams {
  const topic = controls?.topic;
  const sources = [{ type: topic === "news" ? "news" : "web" }];
  const params: {
    sources: { type: string }[];
    includeDomains?: string[];
    tbs?: string;
    scrapeOptions?: { formats: string[] };
  } = { sources };
  if (controls?.domain) {
    params.includeDomains = [controls.domain];
  }
  if (controls?.recency) {
    const tbs = mapRecencyToTbs(controls.recency);
    if (tbs) params.tbs = tbs;
  }
  if (controls?.contentSize === "high") {
    params.scrapeOptions = { formats: ["markdown"] };
  }
  return params;
}

// ---------------------------------------------------------------------------
// Response normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a raw Firecrawl search response into `SearchSource[]`.
 *
 * Firecrawl nests the result list under a source-type key inside `data`
 * (`data.web` for a web search, `data.news` for a news-topic search) rather
 * than as a flat `data` array. A flat `data` array is also accepted for
 * forward-compat.
 *
 *   data.web[].title        -> title
 *   data.web[].url          -> url
 *   data.web[].markdown     -> summary  (high content-size — richer)
 *   data.web[].description  -> summary  (medium fallback)
 *   data.web[].source|category -> source
 *
 * Any malformed shape is a retryable `ApiError` 500.
 */
function normalizeFirecrawlSearchResults(raw: unknown): readonly SearchSource[] {
  if (!isPlainObject(raw)) {
    throw new ApiError("Firecrawl search returned a malformed response", 500);
  }
  const data = raw.data;
  let results: unknown;
  if (Array.isArray(data)) {
    results = data;
  } else if (isPlainObject(data)) {
    // Results are keyed by source type (web for the default, news for a
    // news-topic search). Collect from web, falling back to news.
    results = Array.isArray(data.web) ? data.web : data.news;
  }
  if (!Array.isArray(results)) {
    throw new ApiError("Firecrawl search returned a malformed response", 500);
  }
  const out: SearchSource[] = [];
  for (const entry of results) {
    if (!isPlainObject(entry)) {
      throw new ApiError("Firecrawl search returned a malformed response", 500);
    }
    const title = entry.title;
    const url = entry.url;
    if (typeof title !== "string" || typeof url !== "string") {
      throw new ApiError("Firecrawl search returned a malformed response", 500);
    }
    // Prefer the scraped markdown (high content-size) over the bare
    // description (medium). An absent description is an empty summary.
    const markdown = typeof entry.markdown === "string" ? entry.markdown : undefined;
    const description = typeof entry.description === "string" ? entry.description : undefined;
    const summary = markdown ?? description ?? "";
    const source =
      typeof entry.source === "string"
        ? entry.source
        : typeof entry.category === "string"
          ? entry.category
          : undefined;
    const result: SearchSource = { title, url, summary };
    if (source !== undefined) result.source = source;
    out.push(result);
  }
  return out;
}

/**
 * Normalize a raw Firecrawl scrape response into a `ReaderFetchResult`.
 *
 *   data.markdown|text          -> content  (per requested format)
 *   data.metadata.sourceURL     -> finalUrl
 *   data.metadata.title         -> title    (null when absent/blank)
 *
 * Firecrawl returns a genuine title (better than Tavily's null). Any
 * malformed shape is a retryable `ApiError` 500.
 */
function normalizeFirecrawlScrapeResult(
  raw: unknown,
  request: ReaderFetchRequest,
): ReaderFetchResult {
  if (!isPlainObject(raw)) {
    throw new ApiError("Firecrawl scrape returned a malformed response", 500);
  }
  const data = raw.data;
  if (!isPlainObject(data)) {
    throw new ApiError("Firecrawl scrape returned a malformed response", 500);
  }
  const contentFormat: "markdown" | "text" = request.format ?? "markdown";
  const contentField = contentFormat === "text" ? "text" : "markdown";
  const content = data[contentField];
  if (typeof content !== "string" || content.length === 0) {
    throw new ApiError("Firecrawl scrape returned a malformed response", 500);
  }
  const metadata = isPlainObject(data.metadata) ? data.metadata : {};
  const sourceURL =
    typeof metadata.sourceURL === "string" && metadata.sourceURL.length > 0
      ? metadata.sourceURL
      : undefined;
  const finalUrl = sourceURL ?? request.url;
  const rawTitle = typeof metadata.title === "string" ? metadata.title : undefined;
  const title = rawTitle !== undefined && rawTitle.trim().length > 0 ? rawTitle : null;

  return {
    schemaVersion: 1,
    url: request.url,
    finalUrl,
    title,
    content,
    contentFormat,
  };
}

/**
 * Normalize a raw Firecrawl map response into a `MapResult`.
 *
 *   links[].url -> urls   (links are objects {url, title}, not strings)
 *   baseUrl     -> the request URL
 *   totalUrls   -> links array length
 *
 * A bare-string `links[]` entry is also accepted for forward-compat. Any
 * malformed shape is a retryable `ApiError` 500.
 */
function normalizeFirecrawlMapResult(raw: unknown, request: MapRequest): MapResult {
  if (!isPlainObject(raw)) {
    throw new ApiError("Firecrawl map returned a malformed response", 500);
  }
  const links = raw.links;
  if (!Array.isArray(links)) {
    throw new ApiError("Firecrawl map returned a malformed response", 500);
  }
  const urls: string[] = [];
  for (const entry of links) {
    let url: unknown;
    if (typeof entry === "string") {
      url = entry;
    } else if (isPlainObject(entry)) {
      url = entry.url;
    }
    if (typeof url !== "string" || url.length === 0) {
      throw new ApiError("Firecrawl map returned a malformed response", 500);
    }
    urls.push(url);
  }
  return {
    schemaVersion: 1,
    baseUrl: request.url,
    urls,
    totalUrls: urls.length,
  };
}

// ---------------------------------------------------------------------------
// Failure normalization: stable public codes, no raw payloads (NFR-006)
// ---------------------------------------------------------------------------

/**
 * Resolve a stable HTTP-style status code for retry classification.
 * Explicit typed errors carry their own status; the fallback default is
 * 500 (transient). Mirrors the Tavily helper.
 */
function inferStatusCode(known?: number): number {
  if (typeof known === "number" && Number.isFinite(known)) return known;
  return 500;
}

/**
 * Status-keyed outward message for rewrapped Firecrawl ApiErrors. Curated
 * constants only — a raw Provider body embedded upstream never survives.
 */
function firecrawlApiErrorMessage(statusCode: number): string {
  if (statusCode === 429) return "Firecrawl rate limit exceeded";
  return "Firecrawl request failed";
}

/**
 * Normalize a Provider failure with sanitized messages. Raw response
 * bodies never cross the adapter boundary. Mirrors `normalizeTavilyError`.
 */
function normalizeFirecrawlError(error: unknown): Error {
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
    return new AuthError("Firecrawl authentication failed", "FIRECRAWL_API_KEY");
  }
  if (error instanceof NetworkError) {
    return new NetworkError("Firecrawl network error");
  }
  if (error instanceof TimeoutError) {
    return new TimeoutError(
      error.durationMs,
      "Try again or increase timeout with FIRECRAWL_TIMEOUT env var",
    );
  }
  if (error instanceof ApiError) {
    const statusCode = inferStatusCode(error.statusCode);
    return new ApiError(firecrawlApiErrorMessage(statusCode), statusCode);
  }
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (
    lower.includes("401") ||
    lower.includes("403") ||
    lower.includes("unauthorized") ||
    lower.includes("forbidden")
  ) {
    return new AuthError("Firecrawl authentication failed");
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
    return new NetworkError("Firecrawl network error");
  }
  if (lower.includes("429") || lower.includes("rate limit")) {
    return new ApiError("Firecrawl rate limit exceeded", 429);
  }
  return new ApiError("Firecrawl request failed", 500);
}

// ---------------------------------------------------------------------------
// Reader validation helpers
// ---------------------------------------------------------------------------

/** Z.AI-only reader options that Firecrawl does not accept. */
const UNSUPPORTED_READER_OPTIONS = [
  "withLinksSummary",
  "noGfm",
  "keepImgDataUrl",
  "withImagesSummary",
] as const;

function assertNoUnsupportedReaderOptions(request: ReaderFetchRequest): void {
  for (const key of UNSUPPORTED_READER_OPTIONS) {
    // Only reject when the user explicitly enabled the option (`true`).
    // The read command handler sets boolean options to `false` (not
    // `undefined`) when the flag is absent, so `!== undefined` would
    // over-reject. `false` means "user didn't pass the flag" → accept.
    if (request[key] === true) {
      throw new UnsupportedOptionError("firecrawl", "reader", key);
    }
  }
}

// ---------------------------------------------------------------------------
// Search Capability
// ---------------------------------------------------------------------------

interface FirecrawlSearchCapabilityOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly transport?: FirecrawlTransportDeps;
}

function createFirecrawlSearchCapability(
  options: FirecrawlSearchCapabilityOptions,
): SearchCapability {
  const { env, transport } = options;

  const capability: SearchCapability = {
    validate(request: SearchRequest): void {
      if (!request || typeof request.query !== "string" || request.query.trim() === "") {
        throw new ValidationError(
          "Search query must contain at least one non-whitespace character",
        );
      }
      // Firecrawl supports domain, recency, contentSize, and topic.
      // location is Z.AI-specific and rejected before any transport call.
      if (request.controls?.location !== undefined) {
        throw new UnsupportedOptionError("firecrawl", "search", "location");
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
        provider: "firecrawl",
        capability: "search",
        credentialFingerprint: credentialFingerprint(apiKey),
        request: identityRequest,
      };
    },

    async invoke(request: SearchRequest): Promise<readonly SearchSource[]> {
      capability.validate(request);

      const apiKey = resolveApiKey(env);
      try {
        const params = mapSearchControls(request.controls);
        const raw = await fetchFirecrawlSearch(apiKey, request.query, params, transport);
        return normalizeFirecrawlSearchResults(raw);
      } catch (error) {
        throw normalizeFirecrawlError(error);
      }
    },
  };

  return capability;
}

// ---------------------------------------------------------------------------
// Reader Capability
// ---------------------------------------------------------------------------

interface FirecrawlReaderCapabilityOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly transport?: FirecrawlTransportDeps;
}

function createFirecrawlReaderCapability(
  options: FirecrawlReaderCapabilityOptions,
): ReaderCapability {
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
        provider: "firecrawl",
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
        const formats = request.format === "text" ? ["text"] : ["markdown"];
        // retainImages is set only when --no-images is passed (read.ts),
        // so `=== false` is exactly the "strip images" case. Inverted to
        // Firecrawl's removeBase64Images.
        const params: FirecrawlScrapeParams = {
          formats,
          proxy: "basic",
          ...(request.retainImages === false ? { removeBase64Images: true } : {}),
        };
        const raw = await fetchFirecrawlScrape(apiKey, request.url, params, transport);
        return normalizeFirecrawlScrapeResult(raw, request);
      } catch (error) {
        throw normalizeFirecrawlError(error);
      }
    },
  };

  return { fetch };
}

// ---------------------------------------------------------------------------
// Map Capability
// ---------------------------------------------------------------------------

/**
 * Map Provider-neutral `MapRequest` to Firecrawl-native map params.
 *
 *   limit           -> limit
 *   instructions    -> search
 *
 * `depth`, `breadth`, `selectPaths`, and `excludePaths` have NO native
 * Firecrawl /v2/map equivalent (map is discovery-only) and are omitted
 * (tech-plan D6).
 */
function mapMapControls(request: MapRequest): FirecrawlMapParams {
  const params: { limit?: number; search?: string } = {};
  if (request.limit !== undefined) params.limit = request.limit;
  if (request.instructions !== undefined) params.search = request.instructions;
  return params;
}

interface FirecrawlMapCapabilityOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly transport?: FirecrawlTransportDeps;
}

function createFirecrawlMapCapability(options: FirecrawlMapCapabilityOptions): MapCapability {
  const { env, transport } = options;

  const fetch: MapOperation = {
    kind: "map-fetch",

    validate(request: MapRequest): void {
      assertHttpUrl(request.url);
      if (request.limit !== undefined && request.limit <= 0) {
        throw new ValidationError("Map limit must be greater than 0");
      }
    },

    cacheIdentity(request: MapRequest): CacheIdentity<MapRequest, MapResult> {
      const apiKey = resolveApiKey(env);
      return {
        provider: "firecrawl",
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
        const raw = await fetchFirecrawlMap(apiKey, request.url, params, transport);
        return normalizeFirecrawlMapResult(raw, request);
      } catch (error) {
        throw normalizeFirecrawlError(error);
      }
    },
  };

  return { fetch };
}

// ---------------------------------------------------------------------------
// Crawl Capability — async create→poll→resume (tech-plan D2)
// ---------------------------------------------------------------------------

const DEFAULT_CRAWL_POLL_INTERVAL_MS = 2000;
/** Safety bound on `next`-cursor traversal for very large crawls. */
const MAX_CRAWL_NEXT_ITERATIONS = 500;
/** Reclaim-on-miss staleness guard — don't adopt jobs older than this. */
const CRAWL_RECLAIM_STALE_MS = 24 * 60 * 60 * 1000;

/** Split a comma-separated path-pattern string into a trimmed array. */
function splitPathPatterns(value: string | undefined): readonly string[] | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function isEexistError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === "EEXIST"
  );
}

function resolveCrawlPollIntervalMs(env: NodeJS.ProcessEnv | undefined): number {
  const raw = env?.FIRECRAWL_CRAWL_POLL_INTERVAL_MS;
  const parsed = parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_CRAWL_POLL_INTERVAL_MS;
}

/**
 * Abortable sleep built from the injected timers. When `signal` aborts
 * (the command handler's `--timeout`), the pending timer is cleared and
 * the promise rejects with a `TimeoutError` so the poll loop unwinds
 * promptly. Mirrors the research poll loop's `makeSleep`.
 */
function makeCrawlSleep(
  deps: FirecrawlTransportDeps | undefined,
  signal?: AbortSignal,
): (ms: number) => Promise<void> {
  const setT = deps?.setTimeout ?? setTimeout;
  const clearT = deps?.clearTimeout ?? clearTimeout;
  return (ms: number) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new TimeoutError(0, "Crawl polling aborted"));
        return;
      }
      if (ms <= 0) {
        setImmediate(() => {
          if (signal?.aborted) {
            reject(new TimeoutError(0, "Crawl polling aborted"));
            return;
          }
          resolve();
        });
        return;
      }
      const onAbort = (): void => {
        clearT(id);
        reject(new TimeoutError(0, "Crawl polling aborted"));
      };
      const id = setT(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal?.addEventListener("abort", onAbort);
    });
}

/**
 * Map a Provider-neutral `CrawlRequest` into Firecrawl-native /v2/crawl
 * body fields. `breadth` has no Firecrawl equivalent (rejected in
 * `validate`); `proxy` is pinned to `"basic"` (D9 cost-safety) and nests
 * under `scrapeOptions` (crawl nests scrape fields; `/scrape` takes
 * `proxy` top-level). `format` nests under `scrapeOptions.formats`.
 */
function mapCrawlControls(request: CrawlRequest): FirecrawlCrawlParams {
  const contentFormat = request.format ?? "markdown";
  const params: {
    maxDepth?: number;
    limit?: number;
    includePaths?: readonly string[];
    excludePaths?: readonly string[];
    scrapeOptions: { formats: readonly string[]; proxy: "basic" };
  } = { scrapeOptions: { formats: [contentFormat], proxy: "basic" } };
  if (request.depth !== undefined) params.maxDepth = request.depth;
  if (request.limit !== undefined) params.limit = request.limit;
  const includePaths = splitPathPatterns(request.selectPaths);
  if (includePaths !== undefined) params.includePaths = includePaths;
  const excludePaths = splitPathPatterns(request.excludePaths);
  if (excludePaths !== undefined) params.excludePaths = excludePaths;
  return params;
}

/**
 * Normalize a batch of Firecrawl crawl page objects into `CrawlPage[]`.
 *
 *   data[].metadata.sourceURL -> url
 *   data[].markdown|text      -> content
 *
 * Any malformed entry is a retryable `ApiError` 500.
 */
function normalizeCrawlPages(data: readonly unknown[], request: CrawlRequest): CrawlPage[] {
  const contentFormat: "markdown" | "text" = request.format ?? "markdown";
  const contentField = contentFormat === "text" ? "text" : "markdown";
  const pages: CrawlPage[] = [];
  for (const entry of data) {
    if (!isPlainObject(entry)) {
      throw new ApiError("Firecrawl crawl returned a malformed response", 500);
    }
    const metadata = isPlainObject(entry.metadata) ? entry.metadata : {};
    const url = metadata.sourceURL;
    const content = entry[contentField];
    if (
      typeof url !== "string" ||
      url.length === 0 ||
      typeof content !== "string" ||
      content.length === 0
    ) {
      throw new ApiError("Firecrawl crawl returned a malformed response", 500);
    }
    pages.push({ url, content, contentFormat });
  }
  return pages;
}

/**
 * Collect the full crawl result from a completed poll, following the
 * pagination cursor `next` to exhaustion for large sets (each batch
 * distinct — no dedup needed; tech-plan D2 / G0 #1). Bounded by a
 * max-iteration guard against a runaway cursor.
 */
async function collectCrawlResult(
  poll: { readonly data?: readonly unknown[]; readonly next?: string },
  apiKey: string,
  request: CrawlRequest,
  transport: FirecrawlTransportDeps | undefined,
): Promise<CrawlResult> {
  const pages: CrawlPage[] = [];
  if (poll.data) pages.push(...normalizeCrawlPages(poll.data, request));
  let next = poll.next;
  let guard = 0;
  while (next !== undefined) {
    guard += 1;
    if (guard > MAX_CRAWL_NEXT_ITERATIONS) {
      throw new ApiError("Firecrawl crawl pagination exceeded the safety limit", 500);
    }
    const page = await fetchFirecrawlCrawlNext(apiKey, next, transport);
    if (page.data) pages.push(...normalizeCrawlPages(page.data, request));
    next = page.next;
  }
  return { schemaVersion: 1, baseUrl: request.url, pages, totalPages: pages.length };
}

/**
 * Best-effort compatibility check between an active-job `options` blob and
 * the params this request would send. The server echoes the request
 * options; verifying the cost-bearing fields (limit, maxDepth,
 * scrapeOptions.formats) is a strong signal it is the same job. Missing or
 * differently-shaped options → not compatible (safer to create fresh than
 * to mis-adopt a different crawl).
 */
function crawlOptionsCompatible(options: unknown, params: FirecrawlCrawlParams): boolean {
  if (!isPlainObject(options)) return false;
  if (params.maxDepth !== undefined && options.maxDepth !== params.maxDepth) return false;
  if (params.limit !== undefined && options.limit !== params.limit) return false;
  const expectedFormats = params.scrapeOptions?.formats;
  const so = options.scrapeOptions;
  if (expectedFormats !== undefined && isPlainObject(so) && Array.isArray(so.formats)) {
    const got = JSON.stringify([...(so.formats as unknown[])].sort());
    const want = JSON.stringify([...expectedFormats].sort());
    if (got !== want) return false;
  }
  return true;
}

/**
 * Reclaim-on-miss: find an in-flight job matching this request by `url`
 * (with a `created_at` recency guard against adopting stale jobs, and a
 * best-effort options check when the server echoes them). Returns the job
 * id, or `undefined` when no match exists.
 */
function matchActiveCrawl(
  active: readonly {
    id: string;
    url?: string;
    created_at?: string;
    options?: unknown;
  }[],
  request: CrawlRequest,
  params: FirecrawlCrawlParams,
): string | undefined {
  const now = Date.now();
  for (const entry of active) {
    if (entry.url !== request.url) continue;
    if (entry.created_at !== undefined) {
      const ts = Date.parse(entry.created_at);
      if (Number.isFinite(ts) && now - ts > CRAWL_RECLAIM_STALE_MS) continue;
    }
    if (entry.options !== undefined && !crawlOptionsCompatible(entry.options, params)) continue;
    return entry.id;
  }
  return undefined;
}

/**
 * Persist a crawl job id in the state file (atomic `wx` create). On EEXIST
 * (a concurrent invocation already persisted a job for this request), read
 * and return its id instead — the concurrent job is the one to poll.
 */
async function persistCrawlId(
  stateFile: AsyncJobStateFile,
  identityHash: string,
  id: string,
): Promise<string> {
  const state: AsyncJobState = {
    requestId: id,
    identityHash,
    createdAt: new Date().toISOString(),
    status: "pending",
  };
  try {
    await stateFile.write(identityHash, state);
    return id;
  } catch (err) {
    if (isEexistError(err)) {
      const existing = await stateFile.read(identityHash);
      return existing !== null ? existing.requestId : id;
    }
    throw err;
  }
}

/**
 * Reclaim an in-flight job whose create-POST response was lost, or create a
 * fresh one. On a state-file miss, GET /v2/crawl/active and adopt a
 * matching job; else POST /v2/crawl and persist the id. The create POST is
 * zero-retry at the shared-execution layer (defaultRetryPolicy), so a lost
 * response is terminal here and reclaimed on the next user invocation.
 */
async function reclaimOrCreateCrawlJob(
  apiKey: string,
  request: CrawlRequest,
  identityHash: string,
  params: FirecrawlCrawlParams,
  stateFile: AsyncJobStateFile,
  transport: FirecrawlTransportDeps | undefined,
): Promise<string> {
  const active = await listActiveFirecrawlCrawls(apiKey, transport);
  const matched = matchActiveCrawl(active, request, params);
  if (matched !== undefined) {
    return persistCrawlId(stateFile, identityHash, matched);
  }
  const created = await createFirecrawlCrawl(apiKey, request.url, params, transport);
  return persistCrawlId(stateFile, identityHash, created.id);
}

interface FirecrawlCrawlCapabilityOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly transport?: FirecrawlTransportDeps;
  readonly stateFile: AsyncJobStateFile;
}

function createFirecrawlCrawlCapability(options: FirecrawlCrawlCapabilityOptions): CrawlCapability {
  const { env, transport, stateFile } = options;

  const fetch: CrawlOperation = {
    kind: "crawl-fetch",

    validate(request: CrawlRequest): void {
      assertHttpUrl(request.url);
      // breadth has no Firecrawl equivalent (D9) — reject, don't ignore.
      if (request.breadth !== undefined) {
        throw new UnsupportedOptionError("firecrawl", "crawl", "breadth");
      }
      if (request.depth !== undefined) {
        if (!Number.isInteger(request.depth) || request.depth < 1 || request.depth > 5) {
          throw new ValidationError("Crawl depth must be an integer between 1 and 5");
        }
      }
      if (request.limit !== undefined && request.limit <= 0) {
        throw new ValidationError("Crawl limit must be greater than 0");
      }
    },

    cacheIdentity(request: CrawlRequest): CacheIdentity<CrawlRequest, CrawlResult> {
      const apiKey = resolveApiKey(env);
      return {
        provider: "firecrawl",
        capability: "crawl",
        credentialFingerprint: credentialFingerprint(apiKey),
        request,
      };
    },

    decodeCached(value: unknown): CrawlResult | null {
      return decodeCrawlResult(value);
    },

    async invoke(request: CrawlRequest, signal?: AbortSignal): Promise<CrawlResult> {
      fetch.validate(request);

      const apiKey = resolveApiKey(env);
      const credFingerprint = credentialFingerprint(apiKey);
      const identityHash = computeAsyncJobStateHash({
        provider: "firecrawl",
        capability: "crawl",
        credentialFingerprint: credFingerprint,
        request,
      });
      const params = mapCrawlControls(request);
      const pollIntervalMs = resolveCrawlPollIntervalMs(transport?.env);
      const sleep = makeCrawlSleep(transport, signal);

      try {
        // 1. Resume: an in-flight job for this request was already persisted
        //    (Ctrl-C / crash mid-poll). Poll it instead of creating a second
        //    one (double-charge prevention).
        const existing = await stateFile.read(identityHash);
        let id: string;
        if (existing !== null) {
          id = existing.requestId;
        } else {
          // 2. Reclaim-on-miss or create (zero-retry create; wx-flag write).
          id = await reclaimOrCreateCrawlJob(
            apiKey,
            request,
            identityHash,
            params,
            stateFile,
            transport,
          );
        }

        // 3. Poll status to terminal, then collect the result once. We do
        //    NOT accumulate data[] across pre-completion polls — the
        //    completed response carries the full set (G0 #1).
        for (;;) {
          if (signal?.aborted) {
            throw new TimeoutError(0, "Crawl polling aborted");
          }
          const poll = await pollFirecrawlCrawl(apiKey, id, transport);

          if (poll.status === "completed") {
            await stateFile.remove(identityHash);
            return collectCrawlResult(poll, apiKey, request, transport);
          }
          if (poll.status === "failed") {
            await stateFile.remove(identityHash);
            throw new ApiError("Firecrawl crawl job failed", 500);
          }
          if (poll.status === "not_found") {
            // Server-side job disappeared — drop state and create fresh.
            await stateFile.remove(identityHash);
            id = await reclaimOrCreateCrawlJob(
              apiKey,
              request,
              identityHash,
              params,
              stateFile,
              transport,
            );
            continue;
          }
          // scraping: sleep and poll again. The state file already holds
          // the id (the load-bearing field for resume).
          await sleep(pollIntervalMs);
        }
      } catch (error) {
        throw normalizeFirecrawlError(error);
      }
    },
  };

  return { fetch };
}

// ---------------------------------------------------------------------------
// Descriptor factory
// ---------------------------------------------------------------------------

/**
 * Dependencies the Firecrawl Adapter accepts. The unified `transport`
 * seam carries `fetch` and timer injection; `crawlStateFile` is the
 * async-job-state port the async Crawl Capability uses for
 * resume-on-restart (tech-plan D2). Production defaults to the on-disk
 * implementation under `~/.scoutline/crawl/`; tests inject in-memory
 * doubles to exercise the lifecycle deterministically.
 */
export interface FirecrawlAdapterDependencies {
  readonly transport?: FirecrawlTransportDeps;
  readonly crawlStateFile?: AsyncJobStateFile;
}

/**
 * Build the Firecrawl Provider Descriptor. Advertises the full Firecrawl
 * capability set. `create()` wires all six capabilities — Search, Reader,
 * Map, async Crawl (create→poll→resume + reclaim-on-miss), Quota
 * (`unit:"credits"`), and Diagnostics (single-scrape probe). Construction
 * is side-effect-free; the transport is invoked per Capability call.
 */
export function createFirecrawlDescriptor(
  dependencies?: FirecrawlAdapterDependencies,
): ProviderDescriptor {
  const transport = dependencies?.transport;
  const crawlStateFile =
    dependencies?.crawlStateFile ?? createProductionAsyncJobStateFile(asyncJobStateDir("crawl"));

  return {
    id: "firecrawl",
    isConfigured(env: NodeJS.ProcessEnv): boolean {
      return isFirecrawlConfigured(env);
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
    create(context: ProviderContext): ProviderAdapter {
      const search = createFirecrawlSearchCapability({ env: context.env, transport });
      const reader = createFirecrawlReaderCapability({ env: context.env, transport });
      const crawl = createFirecrawlCrawlCapability({
        env: context.env,
        transport,
        stateFile: crawlStateFile,
      });
      const map = createFirecrawlMapCapability({ env: context.env, transport });
      const quota = createFirecrawlQuotaCapability({ env: context.env, transport });
      const diagnostics = createFirecrawlDiagnosticsCapability({ env: context.env, transport });
      return { id: "firecrawl", search, reader, crawl, map, quota, diagnostics };
    },
  };
}
