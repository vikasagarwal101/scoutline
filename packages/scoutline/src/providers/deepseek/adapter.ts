import crypto from "node:crypto";
import type { ProviderDescriptor } from "../types.js";
import type { SearchCapability, SearchRequest, SearchSource } from "../../capabilities/search.js";
import { decodeReaderFetchResult, type ReaderOperation, type ReaderFetchRequest, type ReaderFetchResult } from "../../capabilities/reader.js";
import { applySearchTopic } from "../../lib/search-topic.js";
import { ApiError, TimeoutError, UnsupportedOptionError, ValidationError } from "../../lib/errors.js";
import { isDeepSeekConfigured, requireDeepSeekApiKey } from "./credentials.js";
import { requestDeepSeek, type DeepSeekTransportDeps } from "./client.js";

export interface DeepSeekAdapterDependencies {
  readonly transport?: DeepSeekTransportDeps;
  readonly now?: () => Date;
}

function fingerprint(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex");
}

type SearchBody = { query: string; count: number; need_content: boolean };

function wireCount(count?: number): number {
  return typeof count === "number" && Number.isInteger(count) && count > 0 ? Math.min(count, 50) : 10;
}

function searchBody(request: SearchRequest, count?: number, now: () => Date = () => new Date()): SearchBody {
  for (const option of ["location", "type", "contentSize"] as const) {
    if (request.controls?.[option] !== undefined) {
      throw new UnsupportedOptionError("deepseek", "search", option);
    }
  }
  let query = applySearchTopic(request.query.trim(), request.controls?.topic);
  if (request.controls?.domain) query = `site:${request.controls.domain} ${query}`;
  const recency = request.controls?.recency;
  if (recency !== undefined && recency !== "noLimit") {
    const daysByRecency = { oneDay: 1, oneWeek: 7, oneMonth: 30, oneYear: 365 };
    if (typeof recency !== "string" || !Object.hasOwn(daysByRecency, recency)) {
      throw new ValidationError("DeepSeek search recency must be oneDay, oneWeek, oneMonth, oneYear, or noLimit");
    }
    const days = daysByRecency[recency];
    const date = new Date(now().getTime() - days * 86_400_000).toISOString().slice(0, 10);
    query += ` after:${date}`;
  }
  if (!request.query.trim() || [...query].length > 128) {
    throw new ValidationError("DeepSeek search query must contain 1 to 128 Unicode characters after applying controls");
  }
  return { query, count: wireCount(count), need_content: false };
}

function validateReader(request: ReaderFetchRequest): void {
  let url: URL;
  try { url = new URL(request.url); } catch { throw new ValidationError("DeepSeek Fetch requires an HTTP or HTTPS URL"); }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password || [...request.url].length > 8192) {
    throw new ValidationError("DeepSeek Fetch requires an HTTP or HTTPS URL of at most 8192 characters without credentials");
  }
  if (request.format === "text") throw new UnsupportedOptionError("deepseek", "reader", "format");
  // The read handler materializes default booleans: true is native for
  // retainImages, false means unrequested for summaries and formatting toggles.
  if (request.retainImages === false) throw new UnsupportedOptionError("deepseek", "reader", "retainImages");
  for (const option of ["withLinksSummary", "noGfm", "keepImgDataUrl", "withImagesSummary"] as const) {
    if (request[option] === true) throw new UnsupportedOptionError("deepseek", "reader", option);
  }
  if (request.renderJs !== undefined) throw new UnsupportedOptionError("deepseek", "reader", "renderJs");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeSearch(response: unknown): SearchSource[] {
  if (!isRecord(response) || !Array.isArray(response.results)) {
    throw new ApiError("DeepSeek returned a malformed search response", 502);
  }
  return response.results.map((row: unknown) => {
    if (!isRecord(row) || typeof row.title !== "string" || typeof row.url !== "string" || !row.url ||
      typeof row.summary !== "string" ||
      (row.snippet !== undefined && typeof row.snippet !== "string") ||
      (row.site_name != null && typeof row.site_name !== "string") ||
      (row.date != null && typeof row.date !== "string")) {
      throw new ApiError("DeepSeek returned a malformed search result", 502);
    }
    return { title: row.title, url: row.url, summary: row.summary || (row.snippet as string | undefined) || "",
      ...(typeof row.site_name === "string" && row.site_name ? { source: row.site_name } : {}),
      ...(typeof row.date === "string" && row.date ? { date: row.date } : {}) };
  });
}

function normalizeReader(url: string, response: unknown): ReaderFetchResult {
  if (!isRecord(response) || typeof response.title !== "string" || typeof response.content !== "string" || !response.content) {
    throw new ApiError("DeepSeek returned a malformed fetch response", 502);
  }
  // Fetch reports no resolved URL. Preserve the requested URL without
  // claiming observation of a provider-side redirect destination.
  return { schemaVersion: 1, url, finalUrl: url, title: response.title.trim() ? response.title : null,
    content: response.content, contentFormat: "markdown" };
}

export function createDeepSeekDescriptor(deps: DeepSeekAdapterDependencies = {}): ProviderDescriptor {
  return {
    id: "deepseek",
    credentialEnvVars: ["DEEPSEEK_API_KEY"],
    isConfigured: isDeepSeekConfigured,
    capabilities: () => new Set(["search", "reader", "diagnostics"]),
    create: ({ env }) => {
      const requestTransport = (): DeepSeekTransportDeps => ({
        ...deps.transport, env: { ...env, ...deps.transport?.env },
      });
      // Bind the effective date to the cache lookup and every retry of that
      // request. A fresh cacheIdentity call refreshes it, even on the same object.
      const prepared = new WeakMap<SearchRequest, { signature: string; body: SearchBody }>();
      const search: SearchCapability = {
        validate(request) { searchBody(request, undefined, deps.now); },
        cacheIdentity(request, compatibility) {
          const body = searchBody(request, compatibility?.count, deps.now);
          prepared.set(request, { signature: JSON.stringify(request), body: { ...body } });
          return {
            provider: "deepseek", capability: "search",
            credentialFingerprint: fingerprint(requireDeepSeekApiKey(env)),
            request: body,
          };
        },
        async invoke(request, signal, count): Promise<readonly SearchSource[]> {
          const cached = prepared.get(request);
          const body = cached?.signature === JSON.stringify(request) && cached.body.count === wireCount(count)
            ? cached.body : searchBody(request, count, deps.now);
          const response = await requestDeepSeek("search", requireDeepSeekApiKey(env),
            body, requestTransport(), signal);
          if (signal?.aborted) throw new TimeoutError(0, "DeepSeek request cancelled");
          return normalizeSearch(response);
        },
      };
      const fetch: ReaderOperation<ReaderFetchRequest, ReaderFetchResult> = {
        kind: "reader-fetch",
        validate: validateReader,
        cacheIdentity(request) {
          validateReader(request);
          return { provider: "deepseek", capability: "reader", operation: "reader-fetch",
            credentialFingerprint: fingerprint(requireDeepSeekApiKey(env)), request,
            legacyCandidates: [] };
        },
        decodeCached: decodeReaderFetchResult,
        async invoke(request, signal) {
          validateReader(request);
          const transport = requestTransport();
          const response = await requestDeepSeek("fetch", requireDeepSeekApiKey(env),
            { url: request.url }, request.timeout === undefined ? transport : {
              ...transport, env: { ...transport.env, DEEPSEEK_TIMEOUT: String(request.timeout * 1000) },
            }, signal);
          if (signal?.aborted) throw new TimeoutError(0, "DeepSeek request cancelled");
          return normalizeReader(request.url, response);
        },
      };
      return { id: "deepseek", search, reader: { fetch }, diagnostics: {
        async invoke(options) {
          if (options.probe) await search.invoke({ query: "scoutline-doctor-probe" }, undefined, 1);
        },
      } };
    },
  };
}
