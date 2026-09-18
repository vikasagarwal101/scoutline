/**
 * Kagi Provider Adapter.
 *
 * Implements Search for the Kagi API (GET /api/v1/search, or
 * GET /api/v0/enrich/news when controls.topic === "news").
 *
 * Wire response is `{ meta, data: [...] }`. Only `t === 0` rows with a
 * truthy url are results; `t: 1` rows are related-query suggestions and
 * MUST be dropped (SCHEMA.md — pinned).
 *
 * Field mapping:
 *   item.title      -> title
 *   item.url        -> url
 *   item.snippet    -> summary
 *   item.published  -> date (when present)
 *   source          -> "kagi" (constant)
 *
 * Control mapping (SearchControls → wire):
 *   domain      -> `site:<domain> ` query prefix
 *   topic:news  -> v0 enrich/news endpoint (same q/limit)
 *   recency     -> REJECTED (UnsupportedOptionError)
 *   location    -> REJECTED (UnsupportedOptionError)
 *   contentSize -> REJECTED (UnsupportedOptionError)
 *   type        -> REJECTED (UnsupportedOptionError)
 *
 * Auth is `Authorization: Bot <key>` — Kagi wire truth, not Bearer.
 * Diagnostics probes the same v1 search endpoint with q=test&limit=1.
 */

import type { ProviderAdapter, ProviderContext, ProviderDescriptor, ProviderId } from "../types.js";
import type {
  SearchCacheIdentity,
  SearchRequest,
  SearchSource,
} from "../../capabilities/search.js";
import type { DiagnosticsCapability } from "../../capabilities/diagnostics.js";
import {
  ApiError,
  ConfigurationError,
  NetworkError,
  QuotaError,
  TimeoutError,
  UnsupportedOptionError,
  ValidationError,
} from "../../lib/errors.js";
import { hashKagiApiKey, isKagiConfigured, requireKagiApiKey } from "./credentials.js";
import { applySearchTopic } from "../../lib/search-topic.js";
import { fetchKagiSearch, fetchKagiNews, type KagiTransportDeps } from "./client.js";
import { createKagiDiagnosticsCapability } from "./diagnostics.js";

const KAGI_PROVIDER_ID: ProviderId = "kagi";

export interface KagiAdapterDependencies {
  readonly transport?: KagiTransportDeps;
}

/**
 * Normalize a Provider failure with sanitized messages. Raw response
 * bodies and envelope `msg` strings never cross the adapter boundary.
 */
function normalizeKagiError(error: unknown): Error {
  // QuotaError pass-through — terminal retry guarantee preserved.
  if (error instanceof QuotaError) return error;
  if (error instanceof ValidationError || error instanceof ConfigurationError) {
    return error;
  }
  if (error instanceof NetworkError) {
    return new NetworkError("Kagi network error");
  }
  if (error instanceof TimeoutError) {
    const help = error.help;
    if (help && help.includes("KAGI_")) {
      return new TimeoutError(error.durationMs, help);
    }
    return new TimeoutError(
      error.durationMs,
      "Try again or increase timeout with KAGI_TIMEOUT env var",
    );
  }
  if (error instanceof ApiError) {
    const statusCode = error.statusCode || 500;
    if (statusCode === 429) {
      return new ApiError("Kagi rate limit exceeded", 429);
    }
    return new ApiError("Kagi request failed", statusCode);
  }
  return new ApiError("Kagi request failed", 500);
}

function normalizeSearchResults(response: {
  data?: readonly {
    t?: number;
    url?: string;
    title?: string;
    snippet?: string;
    published?: string;
  }[];
}): SearchSource[] {
  // Fail closed (SCHEMA.md): results live at data[] ONLY — envelope
  // drift must reject, never degrade to a silent empty success.
  const data = response.data;
  if (!Array.isArray(data)) {
    throw new ApiError("Kagi returned a malformed response envelope", 502);
  }
  const malformed = () => new ApiError("Kagi returned a malformed result row", 502);
  const results: SearchSource[] = [];
  for (const item of data) {
    if (item === null || typeof item !== "object") throw malformed();
    const { t, url, title, snippet, published } = item as {
      t?: unknown;
      url?: unknown;
      title?: unknown;
      snippet?: unknown;
      published?: unknown;
    };
    // Rows without `t` and numeric t !== 0 rows (related-query
    // suggestions, t: 1) are dropped per the wire contract.
    if (t === undefined) continue;
    if (typeof t !== "number") throw malformed();
    if (t !== 0) continue;
    // t === 0 is a standard result by definition: url is required;
    // optional text fields, when present, must be strings.
    if (typeof url !== "string" || url.length === 0) throw malformed();
    if (title !== undefined && typeof title !== "string") throw malformed();
    if (snippet !== undefined && typeof snippet !== "string") throw malformed();
    if (published !== undefined && typeof published !== "string") throw malformed();
    const result: SearchSource = {
      title: (title as string | undefined) ?? "",
      url: url as string,
      summary: (snippet as string | undefined) ?? "",
      source: "kagi",
    };
    if (published) result.date = published as string;
    results.push(result);
  }
  return results;
}

export class KagiAdapter implements ProviderAdapter {
  readonly id: ProviderId = KAGI_PROVIDER_ID;
  readonly search;
  readonly diagnostics: DiagnosticsCapability;

  constructor(
    private readonly context: ProviderContext,
    deps: KagiAdapterDependencies = {},
  ) {
    const transport = deps.transport;
    const env = context.env;

    this.search = {
      validate(request: SearchRequest): void {
        if (!request.query || request.query.trim().length === 0) {
          throw new ValidationError("Search query must not be empty");
        }
        const controls = request.controls;
        if (controls?.type !== undefined) {
          throw new UnsupportedOptionError("kagi", "search", "type");
        }
        if (controls?.location !== undefined) {
          throw new UnsupportedOptionError("kagi", "search", "location");
        }
        if (controls?.contentSize !== undefined) {
          throw new UnsupportedOptionError("kagi", "search", "contentSize");
        }
        if (controls?.recency !== undefined) {
          throw new UnsupportedOptionError("kagi", "search", "recency");
        }
      },

      cacheIdentity(request: SearchRequest): SearchCacheIdentity {
        const apiKey = requireKagiApiKey(env);
        return {
          provider: KAGI_PROVIDER_ID,
          capability: "search",
          credentialFingerprint: hashKagiApiKey(apiKey),
          request: {
            query: request.query.trim(),
            controls: request.controls,
          },
        };
      },

      async invoke(request: SearchRequest): Promise<readonly SearchSource[]> {
        this.validate(request);
        const apiKey = requireKagiApiKey(env);
        const controls = request.controls;
        let query = request.query.trim();
        if (controls?.domain) {
          query = `site:${controls.domain} ${query}`;
        }
        // Topic: "news" is native (v0 enrich/news). Every other
        // non-general topic rides v1 search with the shared keyword
        // appendage (lib/search-topic.ts) — never silently dropped.
        if (controls?.topic !== "news") {
          query = applySearchTopic(query, controls?.topic);
        }
        const params = { query, limit: 10 };

        // Only the transport call is rewrapped (raw-body sanitization);
        // normalizeSearchResults fails closed with a curated ApiError
        // that must surface verbatim.
        const response = await (
          controls?.topic === "news"
            ? fetchKagiNews(apiKey, params, transport)
            : fetchKagiSearch(apiKey, params, transport)
        ).catch((error) => {
          throw normalizeKagiError(error);
        });
        return normalizeSearchResults(response);
      },
    };

    this.diagnostics = createKagiDiagnosticsCapability({ env, transport });
  }
}

export function createKagiDescriptor(deps: KagiAdapterDependencies = {}): ProviderDescriptor {
  return {
    id: KAGI_PROVIDER_ID,
    credentialEnvVars: ["KAGI_API_KEY", "KAGI_TOKEN"],
    isConfigured: isKagiConfigured,
    capabilities(): ReadonlySet<import("../types.js").ProviderCapability> {
      return new Set(["search", "diagnostics"]);
    },
    create: (context: ProviderContext) => new KagiAdapter(context, deps),
  };
}
