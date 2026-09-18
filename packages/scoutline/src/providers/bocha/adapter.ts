/**
 * Bocha AI Provider Adapter.
 *
 * Implements Search (and Diagnostics in T4) for the Bocha AI API
 * (POST /v1/web-search).
 *
 * The wire response is a Bing-compatible wrapped envelope: results
 * live at `data.webPages.value[]` — never the JSON root (SCHEMA.md).
 * Application-level envelope codes are checked here: success only when
 * HTTP 2xx AND (`code` undefined or `code === 200`); any other code is
 * an error with a curated message (the raw `msg` never surfaces).
 *
 * Field mapping:
 *   value[].name             -> title
 *   value[].url              -> url (rows without url are dropped)
 *   value[].summary|snippet  -> summary (summary preferred)
 *   value[].dateLastCrawled  -> date
 *   value[].siteName         -> source ("bocha (<siteName>|web)")
 *
 * Control mapping (SearchControls → wire body):
 *   domain      -> `site:<domain> ` query prefix
 *   recency     -> freshness (Scoutline enum passes through 1:1)
 *   contentSize -> summary: true (always pinned on the body)
 *   topic       -> appended to query via applySearchTopic
 *   type        -> REJECTED (UnsupportedOptionError)
 *   location    -> REJECTED (UnsupportedOptionError)
 */

import crypto from "node:crypto";
import type { ProviderAdapter, ProviderContext, ProviderDescriptor, ProviderId } from "../types.js";
import type {
  SearchCacheIdentity,
  SearchCapability,
  SearchRequest,
  SearchSource,
} from "../../capabilities/search.js";
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
import { requireBochaApiKey, isBochaConfigured } from "./credentials.js";
import { applySearchTopic } from "../../lib/search-topic.js";
import { createBochaDiagnosticsCapability } from "./diagnostics.js";
import {
  fetchBochaWebSearch,
  type BochaSearchParams,
  type BochaSearchResponse,
  type BochaTransportDeps,
} from "./client.js";

const BOCHA_PROVIDER_ID: ProviderId = "bocha";

export interface BochaAdapterDependencies {
  readonly transport?: BochaTransportDeps;
}

function credentialFingerprint(apiKey: string): string {
  return crypto.createHash("sha256").update(apiKey).digest("hex");
}

/**
 * Normalize a Provider failure with sanitized messages. Raw response
 * bodies and envelope `msg` strings never cross the adapter boundary.
 */
function normalizeBochaError(error: unknown): Error {
  // QuotaError pass-through — terminal retry guarantee preserved.
  if (error instanceof QuotaError) return error;

  // Configuration/option/validation errors carry clean, human-authored
  // messages and are safe to surface verbatim.
  if (error instanceof ValidationError || error instanceof ConfigurationError) {
    return error;
  }
  // Re-wrap typed transport errors with sanitized messages so a raw
  // Provider response body embedded upstream never survives. Code +
  // statusCode (retry signal) are preserved.
  if (error instanceof AuthError) {
    return new AuthError("Bocha AI authentication failed", "BOCHA_API_KEY");
  }
  if (error instanceof NetworkError) {
    return new NetworkError("Bocha AI network error");
  }
  if (error instanceof TimeoutError) {
    const help = error.help;
    if (help && help.includes("BOCHA_")) {
      return new TimeoutError(error.durationMs, help);
    }
    return new TimeoutError(
      error.durationMs,
      "Try again or increase timeout with BOCHA_TIMEOUT env var",
    );
  }
  if (error instanceof ApiError) {
    const statusCode = error.statusCode || 500;
    if (statusCode === 429) {
      return new ApiError("Bocha AI rate limit exceeded", 429);
    }
    return new ApiError("Bocha AI request failed", statusCode);
  }
  return new ApiError("Bocha AI request failed", 500);
}

function normalizeSearchResults(response: BochaSearchResponse): SearchSource[] {
  const value = response.data?.webPages?.value ?? response.webPages?.value ?? [];
  return value
    .filter((item) => item.url)
    .map((item) => {
      const result: SearchSource = {
        title: item.name ?? "",
        url: item.url!,
        summary: item.summary || item.snippet || "",
        source: `bocha (${item.siteName ?? "web"})`,
      };
      if (item.dateLastCrawled) result.date = item.dateLastCrawled;
      return result;
    });
}

export class BochaAdapter implements ProviderAdapter {
  readonly id: ProviderId = BOCHA_PROVIDER_ID;
  readonly search: SearchCapability;
  readonly diagnostics: DiagnosticsCapability;

  constructor(
    private readonly context: ProviderContext,
    deps: BochaAdapterDependencies = {},
  ) {
    const transport = deps.transport;
    const env = context.env;

    this.search = {
      validate(request: SearchRequest): void {
        if (!request.query || request.query.trim().length === 0) {
          throw new ValidationError("Search query must not be empty");
        }
        if (request.controls?.type !== undefined) {
          throw new UnsupportedOptionError("bocha", "search", "type");
        }
        if (request.controls?.location !== undefined) {
          throw new UnsupportedOptionError("bocha", "search", "location");
        }
      },

      cacheIdentity(request: SearchRequest): SearchCacheIdentity {
        const apiKey = requireBochaApiKey(env);
        return {
          provider: BOCHA_PROVIDER_ID,
          capability: "search",
          credentialFingerprint: credentialFingerprint(apiKey),
          request: {
            query: request.query.trim(),
            controls: request.controls,
          },
        };
      },

      async invoke(request: SearchRequest): Promise<readonly SearchSource[]> {
        this.validate(request);
        const apiKey = requireBochaApiKey(env);
        const controls = request.controls;
        let query = applySearchTopic(request.query.trim(), controls?.topic);
        if (controls?.domain) {
          query = `site:${controls.domain} ${query}`;
        }
        const params: BochaSearchParams = {
          query,
          summary: true,
          count: 10,
          ...(controls?.recency ? { freshness: controls.recency } : {}),
        };

        try {
          const response = await fetchBochaWebSearch(apiKey, params, transport);
          return normalizeSearchResults(response);
        } catch (error) {
          throw normalizeBochaError(error);
        }
      },
    };

    this.diagnostics = createBochaDiagnosticsCapability({ env, transport });
  }
}

export function createBochaDescriptor(deps: BochaAdapterDependencies = {}): ProviderDescriptor {
  return {
    id: BOCHA_PROVIDER_ID,
    credentialEnvVars: ["BOCHA_API_KEY"],
    isConfigured: isBochaConfigured,
    capabilities(): ReadonlySet<import("../types.js").ProviderCapability> {
      return new Set(["search", "diagnostics"]);
    },
    create: (context: ProviderContext) => new BochaAdapter(context, deps),
  };
}
