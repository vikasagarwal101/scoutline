/**
 * Parallel AI Provider Adapter.
 *
 * Implements Search, Research, and Diagnostics capabilities for Parallel AI.
 *
 * Field mapping (Parallel API → Provider-neutral):
 *   results[].title         -> title
 *   results[].url           -> url
 *   results[].excerpts[]    -> summary (joined with double newlines)
 *   results[].publish_date  -> date
 *
 * Reader (Extract API):
 *   results[].full_content  -> content (fallback: excerpts joined)
 *   results[].title         -> title
 *   results[].url           -> finalUrl
 *
 * Control mapping (SearchControls → Parallel-native API params):
 *   topic     -> appended to query string (Parallel has no native topic field)
 *   type      -> REJECTED (UnsupportedOptionError)
 *   location  -> REJECTED (UnsupportedOptionError)
 *   domain    -> REJECTED (UnsupportedOptionError; API does not accept it)
 *   recency   -> REJECTED (UnsupportedOptionError; API does not accept it)
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
import type {
  ReaderCapability,
  ReaderFetchRequest,
  ReaderFetchResult,
} from "../../capabilities/reader.js";
import { decodeReaderFetchResult } from "../../capabilities/reader.js";
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
import { requireParallelApiKey, isParallelConfigured } from "./credentials.js";
import { applySearchTopic } from "../../lib/search-topic.js";
import {
  fetchParallelSearch,
  fetchParallelExtract,
  type ParallelSearchParams,
  type ParallelTransportDeps,
} from "./client.js";
import { createParallelDiagnosticsCapability } from "./diagnostics.js";

function credentialFingerprint(apiKey: string): string {
  return crypto.createHash("sha256").update(apiKey).digest("hex");
}

/**
 * Normalize a Provider failure with sanitized messages. Raw response
 * bodies never cross the adapter boundary. Same pattern as the Tavily
 * adapter's `normalizeTavilyError` — curated constant messages only,
 * never interpolate `error.message`.
 */
function normalizeParallelError(error: unknown): Error {
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
    return new AuthError("Parallel AI authentication failed", "PARALLEL_API_KEY");
  }
  if (error instanceof NetworkError) {
    return new NetworkError("Parallel AI network error");
  }
  if (error instanceof TimeoutError) {
    return new TimeoutError(
      error.durationMs,
      "Try again or increase timeout with PARALLEL_TIMEOUT env var",
    );
  }
  if (error instanceof ApiError) {
    const statusCode = error.statusCode || 500;
    if (statusCode === 429) {
      return new ApiError("Parallel AI rate limit exceeded", 429);
    }
    return new ApiError("Parallel AI request failed", statusCode);
  }
  return new ApiError("Parallel AI request failed", 500);
}

export interface ParallelAdapterDependencies {
  readonly transport?: ParallelTransportDeps;
}

function assertHttpUrl(url: unknown): asserts url is string {
  if (typeof url !== "string" || url.length === 0) {
    throw new ValidationError("Parallel reader URL must be a non-empty string");
  }
  if (!/^https?:\/\//.test(url)) {
    throw new ValidationError("URL must start with http:// or https://");
  }
}

export class ParallelAdapter implements ProviderAdapter {
  readonly id: ProviderId = "parallel";
  readonly search: SearchCapability;
  readonly research: ResearchCapability;
  readonly reader: ReaderCapability;
  readonly diagnostics: DiagnosticsCapability;

  constructor(
    private readonly context: ProviderContext,
    deps: ParallelAdapterDependencies = {},
  ) {
    const transport = deps.transport;
    const env = context.env;

    this.search = {
      validate(request: SearchRequest): void {
        if (!request.query || request.query.trim().length === 0) {
          throw new ValidationError("Search query must not be empty");
        }
        if (request.controls?.type !== undefined) {
          throw new UnsupportedOptionError("parallel", "search", "type");
        }
        if (request.controls?.location !== undefined) {
          throw new UnsupportedOptionError("parallel", "search", "location");
        }
        if (request.controls?.domain !== undefined) {
          throw new UnsupportedOptionError("parallel", "search", "domain");
        }
        if (request.controls?.recency !== undefined) {
          throw new UnsupportedOptionError("parallel", "search", "recency");
        }
        if (request.controls?.contentSize !== undefined) {
          throw new UnsupportedOptionError("parallel", "search", "contentSize");
        }
      },

      cacheIdentity(request: SearchRequest): SearchCacheIdentity {
        const apiKey = requireParallelApiKey(env);
        return {
          provider: "parallel",
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
        const apiKey = requireParallelApiKey(env);
        const query = applySearchTopic(request.query.trim(), request.controls?.topic);

        const params: ParallelSearchParams = {};

        try {
          const response = await fetchParallelSearch(apiKey, query, params, transport);
          const results = response.results || [];

          return results.map((item) => ({
            title: item.title || "Untitled",
            url: item.url || "",
            summary: item.excerpts?.join("\n\n") || "",
            date: item.publish_date || undefined,
          }));
        } catch (error) {
          throw normalizeParallelError(error);
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
            "model",
            "outputLength",
            "citationFormat",
            "domain",
          ] as const) {
            if (request[option] !== undefined) {
              throw new UnsupportedOptionError("parallel", "research", option);
            }
          }
        },

        cacheIdentity(request: ResearchRequest) {
          const apiKey = requireParallelApiKey(env);
          return {
            provider: "parallel",
            capability: "research",
            operation: "research-fetch",
            credentialFingerprint: credentialFingerprint(apiKey),
            request,
          };
        },

        decodeCached: decodeResearchResult,

        async invoke(request: ResearchRequest, signal?: AbortSignal): Promise<ResearchResult> {
          this.validate(request);
          if (signal?.aborted) throw new TimeoutError(0, "Research aborted before start");
          const apiKey = requireParallelApiKey(env);
          const query = request.query.trim();

          try {
            const response = await fetchParallelSearch(
              apiKey,
              query,
              { objective: "deep-research" },
              transport,
              signal,
            );
            const results = response.results || [];

            // Parallel AI does not return a synthesized report field.
            // Build the report from the excerpts of all results.
            const report = results.length > 0
              ? results
                  .map((r) => r.excerpts?.join("\n"))
                  .filter((text): text is string => typeof text === "string" && text.length > 0)
                  .join("\n\n")
              : "No research findings available.";

            return {
              schemaVersion: 1,
              query,
              model: "auto",
              report,
              sources: results
                .filter((r) => r.url)
                .map((r) => ({
                  title: r.title || "Untitled",
                  url: r.url!,
                })),
            };
          } catch (error) {
            throw normalizeParallelError(error);
          }
        },
      },
    };

    this.reader = {
      fetch: {
        kind: "reader-fetch",
        validate(request: ReaderFetchRequest): void {
          assertHttpUrl(request.url);
          // Parallel Extract always returns markdown content.
          if (request.format === "text") {
            throw new UnsupportedOptionError("parallel", "reader", "format");
          }
          for (const key of [
            "withLinksSummary",
            "noGfm",
            "keepImgDataUrl",
            "withImagesSummary",
            "retainImages",
          ] as const) {
            if (request[key] === true) {
              throw new UnsupportedOptionError("parallel", "reader", key);
            }
          }
        },

        cacheIdentity(request: ReaderFetchRequest) {
          const apiKey = requireParallelApiKey(env);
          return {
            provider: "parallel",
            capability: "reader",
            operation: "reader-fetch",
            credentialFingerprint: credentialFingerprint(apiKey),
            request,
            legacyCandidates: [],
          };
        },

        decodeCached: decodeReaderFetchResult,

        async invoke(request: ReaderFetchRequest): Promise<ReaderFetchResult> {
          this.validate(request);
          const apiKey = requireParallelApiKey(env);

          try {
            const response = await fetchParallelExtract(apiKey, request.url, transport);

            // Check for extraction errors for the requested URL
            if (response.errors && response.errors.length > 0) {
              for (const err of response.errors) {
                if (err.url === request.url) {
                  throw new ApiError(
                    `Parallel AI extract failed for URL (${err.error_type || "unknown"})`,
                    err.http_status_code || 422,
                  );
                }
              }
            }

            const result = response.results?.[0];
            const content = result?.full_content || result?.excerpts?.join("\n\n") || "";

            if (content.length === 0) {
              throw new ApiError("Parallel AI extract returned no content", 422);
            }

            return {
              schemaVersion: 1,
              url: request.url,
              finalUrl: result?.url || request.url,
              title: result?.title || null,
              content,
              contentFormat: "markdown",
            };
          } catch (error) {
            throw normalizeParallelError(error);
          }
        },
      },
    };

    this.diagnostics = createParallelDiagnosticsCapability({ env, transport });
  }
}

export function createParallelDescriptor(): ProviderDescriptor {
  return {
    id: "parallel",
    credentialEnvVars: ["PARALLEL_API_KEY"],
    isConfigured: isParallelConfigured,
    capabilities(): ReadonlySet<ProviderCapability> {
      return new Set(["search", "research", "reader", "diagnostics"]);
    },
    create: (context: ProviderContext) => new ParallelAdapter(context),
  };
}
