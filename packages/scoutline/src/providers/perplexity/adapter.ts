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
 * Research uses the Agent API (POST /v1/agent) with the `high`
 * preset — the official successor to `sonar-deep-research` on the
 * Sonar chat-completions endpoint (sunset 2026-09-27, #107). The
 * response carries an `output[]` trace: `message` items hold the
 * report text, `search_results` items hold structured sources
 * (title, url, date, snippet) — one item per search round.
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
 *   Research (/v1/agent, preset "high"):
 *     output[].message.content[].text -> report
 *     output[].search_results.results[] -> sources[] (union across
 *       search rounds, deduped by URL, first occurrence wins)
 *
 * Control mapping (SearchControls → Search API params):
 *   domain      -> search_domain_filter: [domain]
 *   recency     -> search_recency_filter (oneDay→"day", oneWeek→"week",
 *                  oneMonth→"month", oneYear→"year", noLimit→omit)
 *   contentSize -> search_context_size (medium→"medium", high→"high")
 *   type        -> REJECTED (UnsupportedOptionError)
 *   location    -> REJECTED (UnsupportedOptionError)
 *   topic       -> appended to query string via applySearchTopic
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
import { applySearchTopic } from "../../lib/search-topic.js";
import {
  fetchPerplexitySearch,
  fetchPerplexityAgent,
  type PerplexityAgentResponse,
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
    // Forward the transport-specific help text only if it's a known,
    // curated Perplexity constant (Search → PERPLEXITY_TIMEOUT;
    // research → PERPLEXITY_RESEARCH_TIMEOUT). This preserves
    // endpoint-specific guidance without exposing arbitrary upstream
    // text through the normalizer.
    const help = error.help;
    if (help && help.includes("PERPLEXITY_")) {
      return new TimeoutError(error.durationMs, help);
    }
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

function mapRecencyToFilter(
  recency: SearchRecency,
): PerplexitySearchParams["search_recency_filter"] {
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

/**
 * Collect the report text from an Agent API `output[]` trace: every
 * `message` item's `output_text` content parts, joined. The `high`
 * preset emits one final message; the join keeps the mapping total if
 * the trace ever carries more.
 */
function collectAgentReportText(response: PerplexityAgentResponse): string {
  const parts: string[] = [];
  for (const item of response.output ?? []) {
    if (item.type !== "message") continue;
    for (const content of item.content ?? []) {
      if (content.type === "output_text" && content.text) parts.push(content.text);
    }
  }
  return parts.join("\n\n");
}

/**
 * Collect sources from an Agent API `output[]` trace: every
 * `search_results` item's `results[]`, unioned across search rounds
 * and deduped by URL (first occurrence wins — earlier rounds rank
 * higher). Entries without a usable URL are skipped.
 */
function collectAgentSources(response: PerplexityAgentResponse): { title: string; url: string }[] {
  const sources: { title: string; url: string }[] = [];
  const seen = new Set<string>();
  for (const item of response.output ?? []) {
    if (item.type !== "search_results") continue;
    for (const entry of item.results ?? []) {
      if (!entry.url || seen.has(entry.url)) continue;
      seen.add(entry.url);
      sources.push({
        title: entry.title || `Source ${sources.length + 1}`,
        url: entry.url,
      });
    }
  }
  return sources;
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
        const query = applySearchTopic(request.query.trim(), request.controls?.topic);
        const params = mapSearchControls(request.controls) || {};

        try {
          const response = await fetchPerplexitySearch(apiKey, query, params, transport);
          const results = response.results || [];

          return results
            .filter((item) => item.url)
            .map((item) => {
              const result: SearchSource = {
                title: item.title || "Untitled",
                url: item.url!,
                summary: item.snippet || "",
              };
              if (item.date) result.date = item.date;
              return result;
            });
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
          // Perplexity research always runs the Agent API "high"
          // preset; model, outputLength, citationFormat, and domain have
          // no faithful mapping (domain/outputLength become mappable
          // via web_search filters / max_output_tokens if ever needed).
          for (const option of ["model", "outputLength", "citationFormat", "domain"] as const) {
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

        async invoke(request: ResearchRequest, signal?: AbortSignal): Promise<ResearchResult> {
          this.validate(request);
          if (signal?.aborted) throw new TimeoutError(0, "Research aborted before start");
          const apiKey = requirePerplexityApiKey(env);
          const query = request.query.trim();

          try {
            const response = await fetchPerplexityAgent(apiKey, query, transport, signal);
            // A failed run (error non-null / status != "completed") must
            // throw, never cache an empty report as a success.
            if (response.error) {
              throw new ApiError("Perplexity research run failed", 502);
            }

            return {
              schemaVersion: 1,
              query,
              // Echo the model the preset actually ran; fall back to the
              // preset name when the response omits it.
              model: response.model || "high",
              report: collectAgentReportText(response),
              sources: collectAgentSources(response),
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
