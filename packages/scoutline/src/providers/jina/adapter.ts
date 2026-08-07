/**
 * Jina AI Provider Adapter.
 *
 * Implements Search, Reader, and Diagnostics capabilities for Jina AI.
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
 *     data.content       -> content
 *   Research (deepsearch.jina.ai):
 *     choices[0].message.content -> report
 *     annotations[].url_citation -> sources[]
 *
 * Jina supports keyless access; the API key is optional and the
 * credential fingerprint hashes `"keyless"` when absent.
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
 * bodies never cross the adapter boundary.
 */
function normalizeJinaError(error: unknown): Error {
  if (
    error instanceof QuotaError ||
    error instanceof ValidationError ||
    error instanceof UnsupportedOptionError ||
    error instanceof ConfigurationError ||
    error instanceof AuthError ||
    error instanceof ApiError ||
    error instanceof NetworkError ||
    error instanceof TimeoutError
  ) {
    return error;
  }
  return new ApiError(
    `Jina AI request failed: ${error instanceof Error ? error.message : String(error)}`,
    500,
  );
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
        if (request.controls?.type !== undefined) {
          throw new UnsupportedOptionError("jina", "search", "type");
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
        const apiKey = resolveJinaApiKey(env);
        const query = request.query.trim();

        try {
          const results = await fetchJinaSearch(apiKey, query, transport);

          return results.map((item) => ({
            title: item.title || "Untitled",
            url: item.url || "",
            summary: item.description || item.content || "",
            source: "Jina AI",
            date: item.publishedTime || undefined,
          }));
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
          const apiKey = resolveJinaApiKey(env);

          try {
            const data = await fetchJinaReader(apiKey, request.url, transport);

            return {
              schemaVersion: 1,
              url: request.url,
              finalUrl: data.url || request.url,
              title: data.title || null,
              content: data.content || "",
              // r.jina.ai always returns markdown content regardless of the
              // request format option; X-Return-Format: text returns empty
              // content (API bug). Report what the API actually delivers.
              contentFormat: "markdown",
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

        async invoke(request: ResearchRequest): Promise<ResearchResult> {
          const apiKey = resolveJinaApiKey(env);
          const query = request.query.trim();

          try {
            const response = await fetchJinaDeepSearch(apiKey, query, transport);
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
