/**
 * Perplexity Provider Adapter.
 *
 * Implements Search, Research, and Diagnostics capabilities for the
 * Perplexity API.
 *
 * Search uses the dedicated Search API (POST /search) which returns
 * structured results with titles, URLs, snippets, and dates — far richer
 * than mapping chat completions to citations.
 *
 * Research uses the Sonar Chat Completions endpoint with the
 * `sonar-deep-research` model, which is designed for comprehensive
 * report synthesis. The response includes `search_results[]` with
 * structured source data (title, url, date, snippet).
 *
 * Reader is intentionally omitted: Perplexity does not offer a
 * dedicated webpage extraction API.
 *
 * Field mapping:
 *   Search (/search):
 *     results[].title   -> title
 *     results[].url     -> url
 *     results[].snippet -> summary
 *     results[].date    -> date
 *   Research (/chat/completions):
 *     choices[0].message.content -> report
 *     search_results[].title/url -> sources[]
 *     citations[] (fallback)     -> sources[]
 *
 * Control mapping (SearchControls → Search API params):
 *   domain      -> search_domain_filter: [domain]
 *   recency     -> search_recency_filter (oneDay→"day", oneWeek→"week",
 *                  oneMonth→"month", oneYear→"year", noLimit→omit)
 *   contentSize -> search_context_size (medium→"medium", high→"high")
 *   type        -> REJECTED (UnsupportedOptionError)
 *   location    -> REJECTED (UnsupportedOptionError)
 *   topic       -> REJECTED (UnsupportedOptionError)
 */

import crypto from "node:crypto";
import type {
  ProviderAdapter,
  ProviderCapability,
  ProviderContext,
  ProviderDescriptor,
  ProviderId,
} from "../types.js";
import type {
  SearchCacheIdentity,
  SearchControls,
  SearchRecency,
  SearchCapability,
  SearchRequest,
  SearchSource,
} from "../../capabilities/search.js";
import type {
  ResearchCapability,
  ResearchRequest,
  ResearchResult,
} from "../../capabilities/research.js";
import { decodeResearchResult } from "../../capabilities/research.js";
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
import { requirePerplexityApiKey, isPerplexityConfigured } from "./credentials.js";
import {
  fetchPerplexitySearch,
  fetchPerplexityChat,
  type PerplexitySearchParams,
  type PerplexityTransportDeps,
} from "./client.js";
import { createPerplexityDiagnosticsCapability } from "./diagnostics.js";

function credentialFingerprint(apiKey: string): string {
  return crypto.createHash("sha256").update(apiKey).digest("hex");
}

/**
 * Normalize a Provider failure with sanitized messages. Raw response
 * bodies never cross the adapter boundary. Curated constant messages
 * only, never interpolate `error.message`.
 */
function normalizePerplexityError(error: unknown): Error {
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
    return new AuthError("Perplexity authentication failed", "PERPLEXITY_API_KEY");
  }
  if (error instanceof NetworkError) {
    return new NetworkError("Perplexity network error");
  }
  if (error instanceof TimeoutError) {
    return new TimeoutError(
      error.durationMs,
      "Try again or increase timeout with PERPLEXITY_TIMEOUT env var",
    );
  }
  if (error instanceof ApiError) {
    const statusCode = error.statusCode || 500;
    if (statusCode === 429) {
      return new ApiError("Perplexity rate limit exceeded", 429);
    }
    return new ApiError("Perplexity request failed", statusCode);
  }
  return new ApiError("Perplexity request failed", 500);
}

function mapRecencyToFilter(recency: SearchRecency): PerplexitySearchParams["search_recency_filter"] {
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

function mapSearchControls(controls?: SearchControls): PerplexitySearchParams | undefined {
  if (!controls) return undefined;
  const params: {
    max_results?: number;
    search_context_size?: "low" | "medium" | "high";
    search_domain_filter?: readonly string[];
    search_recency_filter?: "hour" | "day" | "week" | "month" | "year";
  } = {};
  if (controls.domain) {
    params.search_domain_filter = [controls.domain];
  }
  if (controls.recency) {
    const filter = mapRecencyToFilter(controls.recency);
    if (filter) params.search_recency_filter = filter;
  }
  if (controls.contentSize) {
    params.search_context_size = controls.contentSize === "high" ? "high" : "medium";
  }
  return params;
}

export interface PerplexityAdapterDependencies {
  readonly transport?: PerplexityTransportDeps;
}

export class PerplexityAdapter implements ProviderAdapter {
  readonly id: ProviderId = "perplexity";
  readonly search: SearchCapability;
  readonly research: ResearchCapability;
  readonly diagnostics: DiagnosticsCapability;

  constructor(
    private readonly context: ProviderContext,
    deps: PerplexityAdapterDependencies = {},
  ) {
    const transport = deps.transport;
    const env = context.env;

    this.search = {
      validate(request: SearchRequest): void {
        if (!request.query || request.query.trim().length === 0) {
          throw new ValidationError("Search query must not be empty");
        }
        if (request.controls?.type !== undefined) {
          throw new UnsupportedOptionError("perplexity", "search", "type");
        }
        if (request.controls?.location !== undefined) {
          throw new UnsupportedOptionError("perplexity", "search", "location");
        }
        if (request.controls?.topic !== undefined) {
          throw new UnsupportedOptionError("perplexity", "search", "topic");
        }
      },

      cacheIdentity(request: SearchRequest): SearchCacheIdentity {
        const apiKey = requirePerplexityApiKey(env);
        return {
          provider: "perplexity",
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
        const apiKey = requirePerplexityApiKey(env);
        const query = request.query.trim();
        const params = mapSearchControls(request.controls) || {};

        try {
          const response = await fetchPerplexitySearch(apiKey, query, params, transport);
          const results = response.results || [];

          return results
            .filter((item) => item.url)
            .map((item) => ({
              title: item.title || "Untitled",
              url: item.url!,
              summary: item.snippet || "",
              date: item.date || undefined,
            }));
        } catch (error) {
          throw normalizePerplexityError(error);
        }
      },
    };

    this.research = {
      run: {
        kind: "research-fetch",
        validate(request: ResearchRequest): void {
          if (!request.query || request.query.trim().length === 0) {
            throw new ValidationError("Research query must not be empty");
          }
          for (const option of [
            "outputLength",
            "citationFormat",
            "domain",
          ] as const) {
            if (request[option] !== undefined) {
              throw new UnsupportedOptionError("perplexity", "research", option);
            }
          }
        },

        cacheIdentity(request: ResearchRequest) {
          const apiKey = requirePerplexityApiKey(env);
          return {
            provider: "perplexity",
            capability: "research",
            operation: "research-fetch",
            credentialFingerprint: credentialFingerprint(apiKey),
            request: { ...request, query: request.query.trim() },
          };
        },

        decodeCached: decodeResearchResult,

        async invoke(request: ResearchRequest): Promise<ResearchResult> {
          this.validate(request);
          const apiKey = requirePerplexityApiKey(env);
          const query = request.query.trim();

          try {
            const response = await fetchPerplexityChat(
              apiKey,
              query,
              "sonar-deep-research",
              transport,
            );
            const content = response.choices?.[0]?.message?.content || "";

            // Prefer search_results[] (structured sources with titles)
            // over citations[] (bare URLs). Fall back to citations[] when
            // search_results[] has no usable URLs.
            const sources: { title: string; url: string }[] = [];
            if (response.search_results) {
              for (const entry of response.search_results) {
                if (entry.url) {
                  sources.push({
                    title: entry.title || `Source ${sources.length + 1}`,
                    url: entry.url,
                  });
                }
              }
            }
            if (sources.length === 0 && response.citations) {
              for (const url of response.citations) {
                sources.push({ title: `Source ${sources.length + 1}`, url });
              }
            }

            return {
              schemaVersion: 1,
              query,
              model: "sonar-deep-research",
              report: content,
              sources,
            };
          } catch (error) {
            throw normalizePerplexityError(error);
          }
        },
      },
    };

    this.diagnostics = createPerplexityDiagnosticsCapability({ env, transport });
  }
}

export function createPerplexityDescriptor(): ProviderDescriptor {
  return {
    id: "perplexity",
    credentialEnvVars: ["PERPLEXITY_API_KEY"],
    isConfigured: isPerplexityConfigured,
    capabilities(): ReadonlySet<ProviderCapability> {
      return new Set(["search", "research", "diagnostics"]);
    },
    create: (context: ProviderContext) => new PerplexityAdapter(context),
  };
}
