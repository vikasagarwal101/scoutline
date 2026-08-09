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
 *   results[].full_content  -> content (primary; excerpts are a degraded fallback)
 *   results[].title         -> title
 *   results[].url           -> finalUrl
 *   Request: advanced_settings.full_content = true (8P.2)
 *
 * Control mapping (SearchControls → Parallel-native API params):
 *   topic       -> appended to query string (Parallel has no native topic field)
 *   type        -> REJECTED (UnsupportedOptionError)
 *   domain      -> advanced_settings.source_policy.include_domains (8P.3)
 *   recency     -> advanced_settings.source_policy.after_date (RFC 3339) (8P.3)
 *   location    -> advanced_settings.location (8P.3; only "us" accepted)
 *   contentSize -> advanced_settings.excerpt_settings.max_chars_per_result (8P.3)
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
import { validateDomain } from "../../lib/domain-validation.js";
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

/**
 * Maximum query length enforced by Parallel's Search API (8P.4).
 * Each element of `search_queries` is capped at 200 characters.
 */
const PARALLEL_MAX_QUERY_LENGTH = 200;

/**
 * Bounded Unicode code-point counter for the query-length limit. Uses a
 * quick upper-bound check with `.length` (UTF-16 code units) first; only
 * strings exceeding the limit are iterated, and the iteration
 * short-circuits at the (limit+1)th code point so rejecting an oversized
 * input is O(limit), not O(input).
 */
function exceedsCodePointLimit(str: string, limit: number): boolean {
  // Fast path: UTF-16 length ≤ limit means code points are also ≤ limit
  // (each code point is 1-2 UTF-16 code units, never more).
  if (str.length <= limit) return false;
  // Bounded code-point count (for...of yields code points). Short-circuit
  // at limit+1 so a huge payload is rejected without proportional work.
  let count = 0;
  for (const _ of str) {
    if (++count > limit) return true;
  }
  return false;
}

/**
 * Map a provider-neutral SearchRecency to a Parallel `after_date` string
 * (RFC 3339 / ISO 8601 date). Returns `undefined` for `noLimit` (no date
 * filter). Uses a 30-day convention for `oneMonth` to avoid month-end
 * rollover issues with `setUTCMonth`.
 */
function recencyToAfterDate(
  recency: import("../../capabilities/search.js").SearchRecency,
  now: Date = new Date(),
): string | undefined {
  if (recency === "noLimit") return undefined;
  const d = new Date(now.getTime());
  switch (recency) {
    case "oneDay":
      d.setUTCDate(d.getUTCDate() - 1);
      break;
    case "oneWeek":
      d.setUTCDate(d.getUTCDate() - 7);
      break;
    case "oneMonth":
      d.setUTCDate(d.getUTCDate() - 30);
      break;
    case "oneYear":
      d.setUTCDate(d.getUTCDate() - 365);
      break;
  }
  return d.toISOString().split("T")[0]!;
}

/**
 * Map contentSize to an excerpt budget (max_chars_per_result).
 * `high` requests more content per result; `medium` is the default
 * budget. Values are conservative within Parallel's documented ranges.
 */
function contentSizeToExcerptBudget(contentSize: "medium" | "high"): number {
  return contentSize === "high" ? 5000 : 1000;
}

/**
 * Map provider-neutral SearchControls to Parallel-native advanced_settings.
 * Returns `undefined` when no controls apply.
 */
function mapSearchControlsToParams(
  controls: import("../../capabilities/search.js").SearchControls | undefined,
  now: Date = new Date(),
): ParallelSearchParams | undefined {
  if (!controls) return undefined;
  if (!controls.domain && !controls.recency && !controls.location && !controls.contentSize)
    return undefined;

  const sourcePolicy: { include_domains?: readonly string[]; after_date?: string } = {};
  if (controls.domain) {
    sourcePolicy.include_domains = [controls.domain];
  }
  if (controls.recency) {
    const afterDate = recencyToAfterDate(controls.recency, now);
    if (afterDate) {
      sourcePolicy.after_date = afterDate;
    }
  }

  const advancedSettings: Record<string, unknown> = {};
  if (Object.keys(sourcePolicy).length > 0) {
    advancedSettings.source_policy = sourcePolicy;
  }
  if (controls.location) {
    advancedSettings.location = controls.location;
  }
  if (controls.contentSize) {
    advancedSettings.excerpt_settings = {
      max_chars_per_result: contentSizeToExcerptBudget(controls.contentSize),
    };
  }

  return {
    ...(Object.keys(advancedSettings).length > 0 ? { advanced_settings: advancedSettings } : {}),
  };
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
        // Enforce Parallel's documented 200-char per-query limit (8P.4).
        // Validate the final expanded query (after topic suffix) so topic
        // appends don't turn a locally-valid request into a remote 422.
        // Count Unicode code points (not UTF-16 code units) so queries
        // with non-BMP characters (emoji etc.) are not over-rejected.
        const expandedQuery = applySearchTopic(request.query.trim(), request.controls?.topic);
        if (exceedsCodePointLimit(expandedQuery, PARALLEL_MAX_QUERY_LENGTH)) {
          throw new ValidationError(
            `Parallel AI search query exceeds the ${PARALLEL_MAX_QUERY_LENGTH}-character limit (after topic expansion)`,
          );
        }
        if (request.controls?.type !== undefined) {
          throw new UnsupportedOptionError("parallel", "search", "type");
        }
        // Accept domain, recency, location, and contentSize (8P.3).
        // Validate domain syntax; reject locations Parallel can't honor.
        if (request.controls?.domain !== undefined) {
          validateDomain(request.controls.domain);
        }
        if (request.controls?.location !== undefined && request.controls.location !== "us") {
          throw new UnsupportedOptionError("parallel", "search", "location");
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

        const controlParams = mapSearchControlsToParams(request.controls);
        const params: ParallelSearchParams = { ...controlParams };

        try {
          const response = await fetchParallelSearch(apiKey, query, params, transport);
          const results = response.results || [];

          return results.map((item) => {
            const result: SearchSource = {
              title: item.title || "Untitled",
              url: item.url || "",
              summary: item.excerpts?.join("\n\n") || "",
            };
            if (item.publish_date) result.date = item.publish_date;
            return result;
          });
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
          // Research also sends queries via search_queries — enforce the
          // same 200-char per-query limit (8P.4, Cubic P2). Count Unicode
          // code points for consistency with the search check.
          const researchQuery = request.query.trim();
          if (exceedsCodePointLimit(researchQuery, PARALLEL_MAX_QUERY_LENGTH)) {
            throw new ValidationError(
              `Parallel AI research query exceeds the ${PARALLEL_MAX_QUERY_LENGTH}-character limit`,
            );
          }
          for (const option of ["model", "outputLength", "citationFormat", "domain"] as const) {
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
            const report =
              results.length > 0
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
