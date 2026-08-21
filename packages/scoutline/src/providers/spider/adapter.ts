/**
 * Spider.cloud Adapter — Search Capability.
 *
 * Owns credentials, transport lifecycle, Provider field mapping, and
 * failure normalization. Clones the Firecrawl adapter's capability
 * structure (the locked analog adapter) with Spider-specific wire
 * differences: the search term rides the `search` body field (not
 * `query`), `domain` maps to `whitelist`, `location` maps to
 * `country_code`, and a non-general `topic` is a query keyword (Z.AI /
 * MiniMax precedent). `type` is Brave-only and rejected in `validate`
 * before any transport call so the option-level fallback contract can
 * continue past Spider to a capable Provider.
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
import { fetchSpiderSearch, type SpiderSearchParams, type SpiderTransportDeps } from "./client.js";
import { getSpiderApiKey, requireSpiderApiKey } from "./credentials.js";

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
 * Build the Spider.cloud Provider Descriptor. Advertises the capabilities
 * the Adapter currently supplies (Search; reader/crawl/map/quota/
 * diagnostics land with their own tickets). `create()` is
 * side-effect-free; the transport is invoked per Capability call.
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
      return new Set<ProviderCapability>(["search"]);
    },
    create(context: ProviderContext): SpiderAdapter {
      const search = createSpiderSearchCapability({ env: context.env, transport });
      return { id: "spider", search };
    },
    credentialEnvVars: ["SPIDER_API_KEY"],
  };
}
