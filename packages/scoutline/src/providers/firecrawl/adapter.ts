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
  fetchFirecrawlMap,
  fetchFirecrawlScrape,
  fetchFirecrawlSearch,
  type FirecrawlMapParams,
  type FirecrawlScrapeParams,
  type FirecrawlSearchParams,
  type FirecrawlTransportDeps,
} from "./client.js";
import { isFirecrawlConfigured, requireFirecrawlApiKey } from "./credentials.js";

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
 *   data[].title        -> title
 *   data[].url          -> url
 *   data[].markdown     -> summary  (high content-size — richer)
 *   data[].description  -> summary  (medium fallback)
 *   data[].source|category -> source
 *
 * Any malformed shape is a retryable `ApiError` 500.
 */
function normalizeFirecrawlSearchResults(raw: unknown): readonly SearchSource[] {
  if (!isPlainObject(raw)) {
    throw new ApiError("Firecrawl search returned a malformed response", 500);
  }
  const data = raw.data;
  if (!Array.isArray(data)) {
    throw new ApiError("Firecrawl search returned a malformed response", 500);
  }
  const out: SearchSource[] = [];
  for (const entry of data) {
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
 *   links (string[]) -> urls
 *   baseUrl          -> the request URL
 *   totalUrls        -> links array length
 *
 * Any malformed shape is a retryable `ApiError` 500.
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
    if (typeof entry !== "string" || entry.length === 0) {
      throw new ApiError("Firecrawl map returned a malformed response", 500);
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
// Descriptor factory
// ---------------------------------------------------------------------------

/**
 * Dependencies the Firecrawl Adapter accepts. The unified `transport`
 * seam carries `fetch` and timer injection; tests pass a fake-fetch
 * wrapper, production uses the no-argument factory.
 */
export interface FirecrawlAdapterDependencies {
  readonly transport?: FirecrawlTransportDeps;
}

/**
 * Build the Firecrawl Provider Descriptor. Advertises the full Firecrawl
 * capability set so Provider selection, `doctor`, and quota inventory
 * derive from a single source of truth. `create()` wires the synchronous
 * Search, Reader, and Map capabilities; Crawl (FC-04), Quota, and
 * Diagnostics (FC-05) slots are intentionally omitted, so the command
 * dispatch's `if (!adapter.<slot>) throw UnsupportedCapabilityError`
 * guard surfaces a clean error for those until they land. Construction is
 * side-effect-free; the transport is invoked per Capability call.
 */
export function createFirecrawlDescriptor(
  dependencies?: FirecrawlAdapterDependencies,
): ProviderDescriptor {
  const transport = dependencies?.transport;

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
      const map = createFirecrawlMapCapability({ env: context.env, transport });
      return { id: "firecrawl", search, reader, map };
    },
  };
}
