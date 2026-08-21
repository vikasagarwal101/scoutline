/**
 * Spider.cloud direct HTTP transport.
 *
 * Performs direct POSTs against the Spider.cloud REST endpoints with an
 * `Authorization: Bearer <SPIDER_API_KEY>` header. There is NO internal
 * retry — shared execution owns retry policy. Fetch and timers are
 * injectable for tests.
 *
 * Mirrors `providers/firecrawl/client.ts` in structure, with one
 * Spider-specific difference: the API returns a bare JSON array (or a
 * documented wrapper object) instead of an error envelope, so there is
 * no Firecrawl-style `{ success: false }` dual-check.
 *
 * Boundary rules (ARCHITECTURE.md §2):
 *   - May import Adapter-local config and normalized errors.
 *   - May import `ProviderQuotaFetch` from `providers/types.ts`.
 *   - Must NOT import command presentation, capability contracts, or
 *     another Provider's Adapter.
 *   - Must NOT perform response field normalization — the Adapter owns
 *     that. This module declares Provider-native request-body types only
 *     (Spider.cloud API field names); it does not import SearchControls
 *     or any capability contract.
 */
import pkg from "../../../package.json" with { type: "json" };
import { ApiError, AuthError, NetworkError, TimeoutError } from "../../lib/errors.js";
import type { ProviderQuotaFetch } from "../types.js";
import { getGlobalFetch } from "../types.js";

const { version: VERSION } = pkg;

const BASE_URL = "https://api.spider.cloud";
const SEARCH_PATH = "/search";
const SCRAPE_PATH = "/scrape";
const CRAWL_PATH = "/crawl";
const LINKS_PATH = "/links";
const CREDITS_PATH = "/data/credits";
const DEFAULT_TIMEOUT_MS = 30000;
const USER_AGENT = `scoutline/${VERSION}`;

/** Injectable transport dependencies (fetch, timers, env). */
export interface SpiderTransportDeps {
  readonly fetch?: ProviderQuotaFetch;
  readonly setTimeout?: typeof setTimeout;
  readonly clearTimeout?: typeof clearTimeout;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Provider-native search request body fields (Spider.cloud API field
 * names). The Adapter maps the Provider-neutral `SearchControls` into
 * these before calling {@link fetchSpiderSearch}; the transport never
 * imports a capability contract.
 *
 * The search term itself rides the `search` field — NOT `query`.
 */
export interface SpiderSearchParams {
  /** Search term (Provider-neutral `query` maps here). */
  readonly search: string;
  /** `markdown` (SCHEMA §1 canonical default), `raw`, or `text`. */
  readonly return_format?: "markdown" | "raw" | "text";
  /** Ask the API to attach `metadata` (title/description) to each page. */
  readonly metadata?: boolean;
  /** Country code mapped from `controls.location`. */
  readonly country_code?: string;
  /** Google-style recency filter mapped from `controls.recency`. */
  readonly tbs?: string;
  /** Domain allowlist mapped from `controls.domain`. */
  readonly whitelist?: readonly string[];
}

/**
 * Layer 1 — HTTP-status mapping. Runs BEFORE the body is parsed; on a
 * non-2xx response we discard the body and throw a typed error.
 * 401/403 → AuthError; 408/504 → TimeoutError; other 4xx/5xx → ApiError
 * with the real status preserved so the shared retry classifier sees the
 * true class. The transport never embeds credential material in any
 * error message.
 */
function mapStatusError(status: number, timeoutMs: number): Error {
  if (status === 401 || status === 403) {
    return new AuthError("Spider authentication failed", "SPIDER_API_KEY");
  }
  if (status === 408 || status === 504) {
    return new TimeoutError(timeoutMs);
  }
  return new ApiError("Spider request failed", status);
}

/**
 * Map an unexpected transport-layer failure to a typed error. Typed
 * errors from {@link mapStatusError} pass through; an AbortError is the
 * injected timeout firing; everything else (refused connections, DNS,
 * `fetch failed` TypeErrors) is a transient NetworkError.
 */
function normalizeTransportError(error: unknown, timeoutMs: number): Error {
  if (error instanceof AuthError || error instanceof ApiError || error instanceof TimeoutError) {
    return error;
  }
  if (error instanceof Error && error.name === "AbortError") {
    return new TimeoutError(timeoutMs);
  }
  return new NetworkError("Spider network error");
}

/**
 * Core POST. Sends the JSON body, maps a non-2xx status, and parses the
 * response. Returns the parsed JSON value (raw; the Adapter
 * post-processes into normalized results). No retry; no response body
 * in public errors.
 *
 * An external `signal` (cooperative cancellation, issue #47) chains
 * into the timeout controller: when the shared execution layer aborts,
 * the in-flight fetch rejects immediately instead of outliving its
 * caller. External aborts classify as `TimeoutError`, matching how
 * the shared executor classifies caller cancellation.
 */
async function postSpiderJson(
  apiKey: string,
  path: string,
  body: Record<string, unknown>,
  deps: SpiderTransportDeps,
  endpointLabel: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const f = deps.fetch ?? getGlobalFetch<ProviderQuotaFetch>();
  const setT = deps.setTimeout ?? setTimeout;
  const clearT = deps.clearTimeout ?? clearTimeout;
  const url = `${BASE_URL}${path}`;
  const controller = new AbortController();
  const timeoutId = setT(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  const abortWithExternal = () => controller.abort();
  if (signal !== undefined) {
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener("abort", abortWithExternal, { once: true });
    }
  }
  try {
    const res = await f(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      await res.text().catch(() => {});
      throw mapStatusError(res.status, DEFAULT_TIMEOUT_MS);
    }
    try {
      return await res.json();
    } catch (err) {
      // The timeout stays armed through body parsing; an abort here is
      // the injected timeout firing, not a malformed payload. Rethrow
      // so normalizeTransportError maps it to TimeoutError.
      if (controller.signal.aborted) throw err;
      throw new ApiError(`Spider ${endpointLabel} returned a malformed response`, 500);
    }
  } catch (err) {
    throw normalizeTransportError(err, DEFAULT_TIMEOUT_MS);
  } finally {
    if (signal !== undefined) {
      signal.removeEventListener("abort", abortWithExternal);
    }
    clearT(timeoutId);
    controller.abort();
  }
}

/**
 * Perform ONE POST against the Spider.cloud /search endpoint. No retry;
 * no response body in public errors. Returns the parsed JSON value (raw;
 * the Adapter post-processes into normalized search sources).
 *
 * `params` carries Spider-native API fields already mapped from
 * `SearchControls` by the Adapter.
 */
export async function fetchSpiderSearch(
  apiKey: string,
  params: SpiderSearchParams,
  deps: SpiderTransportDeps = {},
): Promise<unknown> {
  const body: Record<string, unknown> = { search: params.search };
  if (params.return_format !== undefined) {
    body.return_format = params.return_format;
  }
  if (params.metadata !== undefined) {
    body.metadata = params.metadata;
  }
  if (params.country_code !== undefined) {
    body.country_code = params.country_code;
  }
  if (params.tbs !== undefined) {
    body.tbs = params.tbs;
  }
  if (params.whitelist !== undefined) {
    body.whitelist = [...params.whitelist];
  }
  return postSpiderJson(apiKey, SEARCH_PATH, body, deps, "search");
}

/**
 * Provider-native scrape request body fields (Spider.cloud API field
 * names). The Adapter maps the Provider-neutral `ReaderFetchRequest`
 * into these before calling {@link fetchSpiderScrape}; the transport
 * never imports a capability contract. The locked canonical body is
 * exactly `url` + `return_format` + `filter_output_main_only` +
 * `stealth` (SPEC §Reader) — no undocumented field is ever sent.
 */
export interface SpiderScrapeParams {
  /** Page URL to scrape. */
  readonly url: string;
  /** `markdown` (canonical default) or `text`, mapped from `format`. */
  readonly return_format: "markdown" | "text";
  /** Spider's main-content filter (locked body field). */
  readonly filter_output_main_only: true;
  /** Spider's stealth proxy flag (locked body field). */
  readonly stealth: true;
}

/**
 * Perform ONE POST against the Spider.cloud /scrape endpoint. No retry;
 * no response body in public errors. Returns the parsed JSON value (raw;
 * the Adapter post-processes into a normalized `ReaderFetchResult`).
 *
 * `params` carries Spider-native API fields already mapped from the
 * Provider-neutral `ReaderFetchRequest` by the Adapter.
 */
export async function fetchSpiderScrape(
  apiKey: string,
  params: SpiderScrapeParams,
  deps: SpiderTransportDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const body: Record<string, unknown> = {
    url: params.url,
    return_format: params.return_format,
    filter_output_main_only: params.filter_output_main_only,
    stealth: params.stealth,
  };
  return postSpiderJson(apiKey, SCRAPE_PATH, body, deps, "scrape", signal);
}

/**
 * Provider-native crawl request body fields (Spider.cloud API field
 * names). The Adapter maps the Provider-neutral `CrawlRequest` into
 * these before calling {@link fetchSpiderCrawl}; the transport never
 * imports a capability contract.
 *
 * The crawl endpoint is SYNCHRONOUS (locked contract): the response is
 * the final JSON array of crawled pages — there is no job id to poll
 * and no async-job state file.
 */
export interface SpiderCrawlParams {
  /** Root URL to crawl. */
  readonly url: string;
  /** Total pages to process, mapped from `limit`. */
  readonly limit?: number;
  /** Crawl depth, mapped from `depth`. */
  readonly depth?: number;
  /** `markdown` (canonical default) or `text`, mapped from `format`. */
  readonly return_format: "markdown" | "text";
}

/**
 * Perform ONE POST against the Spider.cloud /crawl endpoint. No retry,
 * no poll loop; no response body in public errors. Returns the parsed
 * JSON value (raw; the Adapter post-processes into a normalized
 * `CrawlResult`).
 */
export async function fetchSpiderCrawl(
  apiKey: string,
  params: SpiderCrawlParams,
  deps: SpiderTransportDeps = {},
): Promise<unknown> {
  const body: Record<string, unknown> = {
    url: params.url,
    return_format: params.return_format,
  };
  if (params.limit !== undefined) {
    body.limit = params.limit;
  }
  if (params.depth !== undefined) {
    body.depth = params.depth;
  }
  return postSpiderJson(apiKey, CRAWL_PATH, body, deps, "crawl");
}

/**
 * Provider-native links (map) request body fields (Spider.cloud API
 * field names). The Adapter maps the Provider-neutral `MapRequest` into
 * these before calling {@link fetchSpiderLinks}; the transport never
 * imports a capability contract. The documented /links wire body is
 * exactly `url` + `limit`.
 */
export interface SpiderLinksParams {
  /** Root URL to map. */
  readonly url: string;
  /** Total URLs to discover, mapped from `limit`. */
  readonly limit?: number;
}

/**
 * Perform ONE POST against the Spider.cloud /links endpoint. No retry;
 * no response body in public errors. Returns the parsed JSON value
 * (raw; the Adapter post-processes into a normalized `MapResult`).
 */
export async function fetchSpiderLinks(
  apiKey: string,
  params: SpiderLinksParams,
  deps: SpiderTransportDeps = {},
): Promise<unknown> {
  const body: Record<string, unknown> = { url: params.url };
  if (params.limit !== undefined) {
    body.limit = params.limit;
  }
  return postSpiderJson(apiKey, LINKS_PATH, body, deps, "links");
}

/**
 * Core GET (mirrors {@link postSpiderJson} for GET verbs). Applies the
 * same HTTP-status layer-1 mapping and transport-error normalization;
 * like the POST core there is no Firecrawl-style `{ success: false }`
 * dual-check (the Spider.cloud API returns a bare JSON value, not an
 * error envelope). No retry; no response body in public errors.
 */
async function getSpiderJson(
  apiKey: string,
  path: string,
  deps: SpiderTransportDeps,
  endpointLabel: string,
): Promise<unknown> {
  const f = deps.fetch ?? getGlobalFetch<ProviderQuotaFetch>();
  const setT = deps.setTimeout ?? setTimeout;
  const clearT = deps.clearTimeout ?? clearTimeout;
  const url = `${BASE_URL}${path}`;
  const controller = new AbortController();
  const timeoutId = setT(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await f(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "User-Agent": USER_AGENT,
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      await res.text().catch(() => {});
      throw mapStatusError(res.status, DEFAULT_TIMEOUT_MS);
    }
    try {
      return await res.json();
    } catch (err) {
      // The timeout stays armed through body parsing; an abort here is
      // the injected timeout firing, not a malformed payload. Rethrow
      // so normalizeTransportError maps it to TimeoutError.
      if (controller.signal.aborted) throw err;
      throw new ApiError(`Spider ${endpointLabel} returned a malformed response`, 500);
    }
  } catch (err) {
    throw normalizeTransportError(err, DEFAULT_TIMEOUT_MS);
  } finally {
    clearT(timeoutId);
    controller.abort();
  }
}

/**
 * Perform ONE GET against the Spider.cloud /data/credits endpoint. No
 * retry; no response body in public errors. Returns the parsed JSON
 * value (raw; the quota Adapter post-processes into a normalized
 * `ProviderQuotaSuccess`). This is the cheapest credible probe — it
 * costs no credit — so both the Quota capability and the Diagnostics
 * probe ride this same transport.
 */
export async function fetchSpiderCredits(
  apiKey: string,
  deps: SpiderTransportDeps = {},
): Promise<unknown> {
  return getSpiderJson(apiKey, CREDITS_PATH, deps, "credits");
}
