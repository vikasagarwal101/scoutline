/**
 * Jina AI Provider Adapter.
 *
 * Implements Search, Reader, Research, and Diagnostics capabilities for Jina AI.
 *
 * Field mapping (Jina API → Provider-neutral):
 *   Search (s.jina.ai):
 *     data[].title       -> title
 *     data[].url         -> url
 *     data[].description -> summary (fallback: content)
 *     data[].publishedTime -> date
 *   Reader (r.jina.ai):
 *     data.title         -> title
 *     data.url           -> finalUrl
 *     data.content       -> content (markdown mode)
 *     data.text          -> content (text mode; 8J.2)
 *   Research (deepsearch.jina.ai):
 *     choices[0].message.content -> report
 *     annotations[].url_citation -> sources[]
 *
 * Jina capability-aware credential model (8J.1):
 * - Reader (r.jina.ai) is keyless — available without JINA_API_KEY.
 * - Search (s.jina.ai), Research (deepsearch.jina.ai), and Diagnostics
 *   require JINA_API_KEY. The credential fingerprint hashes `"keyless"`
 *   when absent (Reader still works; others fail-closed at preflight).
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
  ReaderCapability,
  ReaderFetchRequest,
  ReaderFetchResult,
} from "../../capabilities/reader.js";
import { decodeReaderFetchResult } from "../../capabilities/reader.js";
import type {
  ResearchCapability,
  ResearchRequest,
  ResearchResult,
  ResearchSource,
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
import { resolveJinaApiKey, isJinaConfigured } from "./credentials.js";
import { applySearchTopic } from "../../lib/search-topic.js";
import { validateDomain } from "../../lib/domain-validation.js";
import {
  fetchJinaReader,
  fetchJinaSearch,
  fetchJinaDeepSearch,
  type JinaTransportDeps,
} from "./client.js";
import { createJinaDiagnosticsCapability } from "./diagnostics.js";

function credentialFingerprint(apiKey: string | undefined): string {
  return crypto.createHash("sha256").update(apiKey || "keyless").digest("hex");
}

/**
 * Normalize a Provider failure with sanitized messages. Raw response
 * bodies never cross the adapter boundary. Curated constant messages
 * only, never interpolate `error.message`.
 */
function normalizeJinaError(error: unknown): Error {
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
    return new AuthError("Jina AI authentication failed", "JINA_API_KEY");
  }
  if (error instanceof NetworkError) {
    return new NetworkError("Jina AI network error");
  }
  if (error instanceof TimeoutError) {
    // Preserve the transport-specific help text (Reader/Search point to
    // JINA_TIMEOUT; DeepSearch points to JINA_DEEPSEARCH_TIMEOUT).
    return new TimeoutError(
      error.durationMs,
      error.help,
    );
  }
  if (error instanceof ApiError) {
    const statusCode = error.statusCode || 500;
    if (statusCode === 429) {
      return new ApiError("Jina AI rate limit exceeded", 429);
    }
    return new ApiError("Jina AI request failed", statusCode);
  }
  return new ApiError("Jina AI request failed", 500);
}

function assertHttpUrl(url: unknown): asserts url is string {
  if (typeof url !== "string" || url.length === 0) {
    throw new ValidationError("Jina reader URL must be a non-empty string");
  }
  if (!/^https?:\/\//.test(url)) {
    throw new ValidationError("URL must start with http:// or https://");
  }
}

export interface JinaAdapterDependencies {
  readonly transport?: JinaTransportDeps;
}

export class JinaAdapter implements ProviderAdapter {
  readonly id: ProviderId = "jina";
  readonly search: SearchCapability;
  readonly reader: ReaderCapability;
  readonly research: ResearchCapability;
  readonly diagnostics: DiagnosticsCapability;

  constructor(
    private readonly context: ProviderContext,
    deps: JinaAdapterDependencies = {},
  ) {
    const transport = deps.transport;
    const env = context.env;

    this.search = {
      validate(request: SearchRequest): void {
        if (!request.query || request.query.trim().length === 0) {
          throw new ValidationError("Search query must not be empty");
        }
        // Jina's s.jina.ai endpoint supports domain (X-Site header) and
        // location (gl field) (8J.3). recency, contentSize, and type have
        // no faithful mapping and are still rejected.
        // Topic is handled by appending a keyword via applySearchTopic in invoke().
        for (const option of [
          "type",
          "recency",
          "contentSize",
        ] as const) {
          if (request.controls?.[option] !== undefined) {
            throw new UnsupportedOptionError("jina", "search", option);
          }
        }
        if (request.controls?.domain !== undefined) {
          validateDomain(request.controls.domain);
        }
      },

      cacheIdentity(request: SearchRequest): SearchCacheIdentity {
        const apiKey = resolveJinaApiKey(env);
        return {
          provider: "jina",
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
        const apiKey = resolveJinaApiKey(env);
        const query = applySearchTopic(request.query.trim(), request.controls?.topic);

        try {
          const results = await fetchJinaSearch(apiKey, query, transport, {
            domain: request.controls?.domain,
            location: request.controls?.location,
          });

          return results.map((item) => {
            const result: SearchSource = {
              title: item.title || "Untitled",
              url: item.url || "",
              summary: item.description || item.content || "",
            };
            if (item.publishedTime) result.date = item.publishedTime;
            return result;
          });
        } catch (error) {
          throw normalizeJinaError(error);
        }
      },
    };

    this.reader = {
      fetch: {
        kind: "reader-fetch",
        validate(request: ReaderFetchRequest): void {
          assertHttpUrl(request.url);
        },

        cacheIdentity(request: ReaderFetchRequest) {
          const apiKey = resolveJinaApiKey(env);
          return {
            provider: "jina",
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
          const apiKey = resolveJinaApiKey(env);

          try {
            const data = await fetchJinaReader(apiKey, request.url, transport, {
              format: request.format,
              retainImages: request.retainImages,
              withLinksSummary: request.withLinksSummary,
              noGfm: request.noGfm,
              keepImgDataUrl: request.keepImgDataUrl,
              withImagesSummary: request.withImagesSummary,
              timeout: request.timeout,
            });

            // Decode content: markdown mode uses `data.content`, text mode
            // uses `data.text` (8J.2). Text-mode responses place the page
            // body in `data.text`, not `data.content`.
            const contentFormat = request.format ?? "markdown";
            const content = contentFormat === "text"
              ? (data.text || data.content || "")
              : (data.content || "");

            return {
              schemaVersion: 1,
              url: request.url,
              finalUrl: data.url || request.url,
              title: data.title || null,
              content,
              contentFormat,
              ...(data.metadata !== undefined ? { metadata: data.metadata } : {}),
              ...(data.external !== undefined ? { external: data.external } : {}),
            };
          } catch (error) {
            throw normalizeJinaError(error);
          }
        },
      },
    };

    this.research = {
      run: {
        kind: "research-fetch",
        validate(request: ResearchRequest): void {
          if (!request.query || request.query.trim().length === 0) {
            throw new ValidationError("Research query must not be empty");
          }
          // Jina DeepSearch supports domain via only_hostnames (8J.4).
          // model, outputLength, and citationFormat have no mapping.
          for (const option of [
            "model",
            "outputLength",
            "citationFormat",
          ] as const) {
            if (request[option] !== undefined) {
              throw new UnsupportedOptionError("jina", "research", option);
            }
          }
          if (request.domain !== undefined) {
            validateDomain(request.domain);
          }
        },

        cacheIdentity(request: ResearchRequest) {
          const apiKey = resolveJinaApiKey(env);
          return {
            provider: "jina",
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
          const apiKey = resolveJinaApiKey(env);
          const query = request.query.trim();

          try {
            const response = await fetchJinaDeepSearch(apiKey, query, transport, signal, {
              domain: request.domain,
            });
            const content = response.choices?.[0]?.message?.content || "";

            // Extract cited sources from annotations (preferred) or
            // fall back to visitedURLs.
            const sources: ResearchSource[] = [];
            const annotations = response.choices?.[0]?.message?.annotations;
            if (annotations && annotations.length > 0) {
              const seen = new Set<string>();
              for (const ann of annotations) {
                const cite = ann.url_citation;
                if (cite?.url && !seen.has(cite.url)) {
                  seen.add(cite.url);
                  sources.push({
                    title: cite.title || `Source ${sources.length + 1}`,
                    url: cite.url,
                  });
                }
              }
            } else if (response.visitedURLs && response.visitedURLs.length > 0) {
              for (const url of response.visitedURLs) {
                sources.push({ title: `Source ${sources.length + 1}`, url });
              }
            }

            return {
              schemaVersion: 1,
              query,
              model: "jina-deepsearch-v1",
              report: content,
              sources,
            };
          } catch (error) {
            throw normalizeJinaError(error);
          }
        },
      },
    };

    this.diagnostics = createJinaDiagnosticsCapability({ env, transport });
  }
}

export function createJinaDescriptor(): ProviderDescriptor {
  return {
    id: "jina",
    credentialEnvVars: ["JINA_API_KEY"],
    isConfigured: isJinaConfigured,
    capabilities(): ReadonlySet<ProviderCapability> {
      return new Set(["search", "reader", "research", "diagnostics"]);
    },
    create: (context: ProviderContext) => new JinaAdapter(context),
  };
}
