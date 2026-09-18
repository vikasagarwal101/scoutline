/**
 * SearchApi Provider Adapter.
 *
 * T2 wires the Search Capability. The descriptor advertises `"search"`
 * and `create()` returns an Adapter whose `search` Capability owns
 * credentials, transport, Provider field mapping, and failure
 * normalization. The GET /api/v1/me quota probe and the
 * diagnostics/quota Capability slots arrive in T3.
 *
 * Engine routing (SPEC, locked): `topic:"news"` → `engine=google_news`;
 * every other topic (and no topic) → `engine=google`. Unlike the Z.AI/
 * MiniMax/Parallel/Jina adapters there is NO topic keyword appendage —
 * SearchApi routing is engine-only.
 *
 * Boundary rules (ARCHITECTURE.md §2):
 *   - May import capability types, normalized errors, Provider identity
 *     types, and the Adapter-local credential and transport Modules.
 *   - Must NOT import command presentation, output mode, or another
 *     Provider's Adapter.
 */

import type {
  ProviderAdapter,
  ProviderCapability,
  ProviderContext,
  ProviderDescriptor,
  ProviderId,
} from "../types.js";
import type {
  SearchCacheIdentity,
  SearchCapability,
  SearchControls,
  SearchRecency,
  SearchRequest,
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
import { hashSearchApiKey, isSearchApiConfigured, requireSearchApiKey } from "./credentials.js";
import {
  fetchSearchApiSearch,
  type SearchApiSearchParams,
  type SearchApiTransportDeps,
} from "./client.js";

/** Dependencies the SearchApi Adapter accepts. */
export interface SearchApiAdapterDependencies {
  /** Optional transport injection (fetch, timers, env). */
  readonly transport?: SearchApiTransportDeps;
}

const TIMEOUT_HELP_TEXT = "Try again or increase timeout with SEARCHAPI_TIMEOUT env var";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Validation (FR-012): reject unsupported controls before any API access
// ---------------------------------------------------------------------------

/**
 * Controls the SearchApi Search Adapter does NOT accept. `contentSize`
 * (SearchApi returns organic results, not sized extracts) and `type`
 * (`video` is Brave-only) are rejected individually before any
 * transport call. `domain`, `recency`, `location`, and `topic` are
 * honored.
 */
function assertNoUnsupportedControls(request: SearchRequest): void {
  const controls = request.controls;
  if (!controls) return;
  if (controls.contentSize !== undefined) {
    throw new UnsupportedOptionError("searchapi", "search", "contentSize");
  }
  if (controls.type !== undefined) {
    throw new UnsupportedOptionError("searchapi", "search", "type");
  }
}

// ---------------------------------------------------------------------------
// Control mapping (SearchControls → SearchApi-native API params)
// ---------------------------------------------------------------------------

function mapRecencyToTimePeriod(recency: SearchRecency): string | undefined {
  switch (recency) {
    case "oneDay":
      return "last_day";
    case "oneWeek":
      return "last_week";
    case "oneMonth":
      return "last_month";
    case "oneYear":
      return "last_year";
    case "noLimit":
      return undefined;
    default:
      return undefined;
  }
}

/**
 * Map the param-bearing controls into SearchApi-native API fields.
 * Engine routing is topic-only: `news` → `google_news`, everything else
 * (general/finance/absent) → `google`. Query-mutating `domain` is
 * handled separately in `invoke`.
 */
function mapSearchControls(controls?: SearchControls): SearchApiSearchParams {
  const params: { engine: string; gl?: string; time_period?: string } = {
    engine: controls?.topic === "news" ? "google_news" : "google",
  };
  if (controls?.recency) {
    const timePeriod = mapRecencyToTimePeriod(controls.recency);
    if (timePeriod) params.time_period = timePeriod;
  }
  if (controls?.location) {
    params.gl = controls.location.toLowerCase();
  }
  return params;
}

// ---------------------------------------------------------------------------
// Response normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a raw SearchApi.io search response into `SearchSource[]`.
 * Reads `raw.organic_results[]`:
 *
 *   title   -> title
 *   link    -> url
 *   snippet -> summary ("" when absent)
 *   date    -> date (only when present and string)
 *
 * A malformed shape (non-object root, `organic_results` not an array,
 * non-string title/link) is a retryable `ApiError` 500.
 */
export function normalizeSearchApiResults(raw: unknown): readonly SearchSource[] {
  if (!isPlainObject(raw)) {
    throw new ApiError("SearchApi.io returned a malformed response", 500);
  }
  const results = raw.organic_results;
  if (!Array.isArray(results)) {
    throw new ApiError("SearchApi.io returned a malformed response", 500);
  }
  const out: SearchSource[] = [];
  for (const entry of results) {
    if (!isPlainObject(entry)) {
      throw new ApiError("SearchApi.io returned a malformed response", 500);
    }
    const title = entry.title;
    const link = entry.link;
    if (typeof title !== "string" || typeof link !== "string") {
      throw new ApiError("SearchApi.io returned a malformed response", 500);
    }
    const source: SearchSource = {
      title,
      url: link,
      summary: typeof entry.snippet === "string" ? entry.snippet : "",
    };
    if (typeof entry.date === "string") {
      source.date = entry.date;
    }
    out.push(source);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Failure normalization: stable public codes, no raw payloads (NFR-006)
// ---------------------------------------------------------------------------

/**
 * Status-keyed outward message for rewrapped SearchApi ApiErrors. The
 * rewrap does not echo upstream `error.message` — a future change
 * embedding a raw Provider body in an ApiError message would leak
 * through normalization, the cache, and stdout. Curated constants only.
 */
function searchApiErrorMessage(statusCode: number): string {
  if (statusCode === 429) return "SearchApi.io rate limit exceeded";
  return "SearchApi.io request failed";
}

/**
 * Normalize a Provider failure with sanitized messages. Raw response
 * bodies never cross the adapter boundary. Same pattern as
 * `normalizeBraveError`.
 */
function normalizeSearchApiError(error: unknown): Error {
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
    return new AuthError("SearchApi.io authentication failed", "SEARCHAPI_API_KEY");
  }
  if (error instanceof NetworkError) {
    return new NetworkError("SearchApi.io network error");
  }
  if (error instanceof TimeoutError) {
    return new TimeoutError(error.durationMs, TIMEOUT_HELP_TEXT);
  }
  if (error instanceof ApiError) {
    const statusCode =
      typeof error.statusCode === "number" && Number.isFinite(error.statusCode)
        ? error.statusCode
        : 500;
    return new ApiError(searchApiErrorMessage(statusCode), statusCode);
  }
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (
    lower.includes("401") ||
    lower.includes("403") ||
    lower.includes("unauthorized") ||
    lower.includes("forbidden")
  ) {
    return new AuthError("SearchApi.io authentication failed", "SEARCHAPI_API_KEY");
  }
  if (lower.includes("timeout") || lower.includes("timed out") || lower.includes("etimedout")) {
    // Fallback branch: the transport wraps real timeouts into a typed
    // TimeoutError (which carries the configured duration) before they
    // reach this point. This untyped-message heuristic is rarely hit, so
    // a constant default is fine and keeps process.env out of the
    // normalization path (test isolation).
    return new TimeoutError(30000, TIMEOUT_HELP_TEXT);
  }
  if (
    lower.includes("econnrefused") ||
    lower.includes("econnreset") ||
    lower.includes("network") ||
    lower.includes("enotfound") ||
    lower.includes("fetch failed")
  ) {
    return new NetworkError("SearchApi.io network error");
  }
  if (lower.includes("429") || lower.includes("rate limit")) {
    return new ApiError("SearchApi.io rate limit exceeded", 429);
  }
  return new ApiError("SearchApi.io request failed", 500);
}

// ---------------------------------------------------------------------------
// Search Capability
// ---------------------------------------------------------------------------

interface SearchApiSearchCapabilityOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly transport?: SearchApiTransportDeps;
}

function createSearchApiSearchCapability(
  options: SearchApiSearchCapabilityOptions,
): SearchCapability {
  const { env, transport } = options;

  const capability: SearchCapability = {
    validate(request: SearchRequest): void {
      if (!request || typeof request.query !== "string" || request.query.trim() === "") {
        throw new ValidationError(
          "Search query must contain at least one non-whitespace character",
        );
      }
      // SearchApi supports domain, recency, location, and topic.
      // contentSize and type are rejected before any transport call.
      assertNoUnsupportedControls(request);
    },

    cacheIdentity(request: SearchRequest): SearchCacheIdentity {
      const apiKey = requireSearchApiKey(env);
      const identityRequest: { query: string; controls?: SearchControls } = {
        query: request.query,
      };
      if (request.controls) {
        identityRequest.controls = request.controls;
      }
      return {
        // ponytail: same PROVIDER_IDS cast as the descriptor (above).
        provider: "searchapi" as ProviderId,
        capability: "search",
        credentialFingerprint: hashSearchApiKey(apiKey),
        request: identityRequest,
      };
    },

    async invoke(request: SearchRequest): Promise<readonly SearchSource[]> {
      // Validate before any credential access or transport call.
      capability.validate(request);

      const apiKey = requireSearchApiKey(env);
      try {
        const controls = request.controls;
        // `domain` appends a `site:<domain>` operator to the query
        // (SearchApi has no dedicated domain param). Topic routing is
        // engine-only — no keyword appendage.
        const q =
          controls?.domain !== undefined
            ? `${request.query} site:${controls.domain}`
            : request.query;
        const params = mapSearchControls(controls);
        const raw = await fetchSearchApiSearch(
          apiKey,
          { engine: params.engine, q, gl: params.gl, time_period: params.time_period },
          transport,
        );
        return normalizeSearchApiResults(raw);
      } catch (error) {
        throw normalizeSearchApiError(error);
      }
    },
  };

  return capability;
}

// ---------------------------------------------------------------------------
// Descriptor factory
// ---------------------------------------------------------------------------

/**
 * Build the SearchApi Provider Descriptor. The descriptor advertises
 * the Search capability (T2); the Diagnostics and Quota capabilities
 * and the `/api/v1/me` quota transport arrive in T3 and widen this set
 * in lockstep with the matching Adapter slots. Construction is
 * side-effect-free; the transport is invoked per Capability call.
 * Tests pass `transport` (typically a fake-fetch wrapper); production
 * uses the no-argument factory which resolves to the global `fetch`
 * and timers inside the transport Module.
 */
export function createSearchApiDescriptor(
  dependencies?: SearchApiAdapterDependencies,
): ProviderDescriptor {
  const transport = dependencies?.transport;

  return {
    // ponytail: `searchapi` joins PROVIDER_IDS when the registry ticket
    // lands; until then the cast keeps the adapter compilable without
    // widening the built-in provider union (fallback order, fan-out
    // "all", routing validation all read PROVIDER_IDS).
    id: "searchapi" as ProviderId,
    isConfigured(env: NodeJS.ProcessEnv): boolean {
      return isSearchApiConfigured(env);
    },
    capabilities(): ReadonlySet<ProviderCapability> {
      return new Set<ProviderCapability>(["search"]);
    },
    create(context: ProviderContext): ProviderAdapter {
      const search = createSearchApiSearchCapability({ env: context.env, transport });
      return { id: "searchapi" as ProviderId, search };
    },
    credentialEnvVars: ["SEARCHAPI_API_KEY"],
  };
}
