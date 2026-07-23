/**
 * Firecrawl direct HTTP transport (firecrawl tech-plan §1, D3).
 *
 * Performs direct POSTs against the Firecrawl v2 REST endpoints with an
 * `Authorization: Bearer fc-<key>` header. There is NO internal retry —
 * shared execution owns retry policy. Fetch and timer are injectable for
 * tests.
 *
 * Mirrors `providers/tavily/client.ts` in structure, with one
 * Firecrawl-specific difference: the **error-envelope dual-check**.
 * Firecrawl returns HTTP 200 with `{ success: false }` for some business
 * errors (investigation §1.2), so the transport checks BOTH
 * `response.ok` and `body.success === false` after parsing.
 *
 * Boundary rules (ARCHITECTURE.md §2):
 *   - May import Adapter-local config and normalized errors.
 *   - May import `ProviderQuotaFetch` from `providers/types.ts`.
 *   - Must NOT import command presentation, capability contracts, or
 *     another Provider's Adapter.
 *   - Must NOT perform response field normalization — the Adapter owns
 *     that. This module declares Provider-native request-body types only
 *     (Firecrawl API field names); it does not import SearchControls or
 *     any capability contract.
 */

import { createRequire } from "node:module";

import { ApiError, AuthError, NetworkError, TimeoutError } from "../../lib/errors.js";
import type { ProviderQuotaFetch } from "../types.js";

const require = createRequire(import.meta.url);
const { version: VERSION } = require("../../../package.json") as { version: string };

const BASE_URL = "https://api.firecrawl.dev";
const SEARCH_PATH = "/v2/search";
const SCRAPE_PATH = "/v2/scrape";
const MAP_PATH = "/v2/map";
const DEFAULT_TIMEOUT_MS = 30000;

const USER_AGENT = `scoutline/${VERSION}`;
const TIMEOUT_HELP_TEXT = "Try again or increase timeout with FIRECRAWL_TIMEOUT env var";

/** Injectable transport dependencies (fetch, timers, env). */
export interface FirecrawlTransportDeps {
  readonly fetch?: ProviderQuotaFetch;
  readonly setTimeout?: typeof setTimeout;
  readonly clearTimeout?: typeof clearTimeout;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Provider-native search request body fields (Firecrawl API field names).
 * The Adapter maps the Provider-neutral `SearchControls` into these before
 * calling {@link fetchFirecrawlSearch}; the transport never imports a
 * capability contract.
 *
 * `scrapeOptions` is nested (unlike `/scrape` which takes `formats`
 * top-level) — investigation §3.2 / tech-plan D4.
 */
export interface FirecrawlSearchParams {
  /** `[{type:"web"}]` default; `[{type:"news"}]` for news topic. */
  readonly sources?: readonly { readonly type: string }[];
  readonly includeDomains?: readonly string[];
  readonly tbs?: string;
  /** Gated by `--content-size high` → `{ formats: ["markdown"] }`. */
  readonly scrapeOptions?: { readonly formats: readonly string[] };
}

/**
 * Provider-native scrape request body fields (Firecrawl API field names).
 * The Adapter maps the Reader request into these before calling
 * {@link fetchFirecrawlScrape}.
 */
export interface FirecrawlScrapeParams {
  /** `["markdown"]` (default) or `["text"]`. */
  readonly formats: readonly string[];
  /** Inverted from `retainImages`. */
  readonly removeBase64Images?: boolean;
  /** Pinned per tech-plan D9 (cost-safety — avoids 5-credit enhanced proxy). */
  readonly proxy: "basic";
}

/** Provider-native map request body fields (Firecrawl API field names). */
export interface FirecrawlMapParams {
  readonly limit?: number;
  /** Mapped from `--instructions`. */
  readonly search?: string;
}

function resolveTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = parseInt(env.FIRECRAWL_TIMEOUT || String(DEFAULT_TIMEOUT_MS), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Layer 1 — HTTP-status mapping. Runs BEFORE the body is parsed; on a
 * non-2xx response we discard the body and throw a typed error.
 *
 * Firecrawl uses HTTP-status for transport errors. 401/403 → AuthError;
 * 408/504 → TimeoutError; 429 → rate-limit ApiError; 4xx/5xx → ApiError
 * with the real status preserved so `isOperationRetryableError` classifies
 * retry correctly (terminal 400/404/410/422; retryable 429/5xx). The
 * transport never embeds credential material in any error message.
 */
function mapStatusError(status: number, timeoutMs: number): Error {
  if (status === 401 || status === 403) {
    return new AuthError("Firecrawl authentication failed", "FIRECRAWL_API_KEY");
  }
  if (status === 408 || status === 504) {
    return new TimeoutError(timeoutMs, TIMEOUT_HELP_TEXT);
  }
  return new ApiError("Firecrawl request failed", status);
}

function normalizeTransportError(err: unknown, timeoutMs: number): Error {
  if (err instanceof AuthError || err instanceof ApiError || err instanceof TimeoutError) {
    return err;
  }
  if (err instanceof Error) {
    if (err.name === "AbortError") {
      return new TimeoutError(timeoutMs, TIMEOUT_HELP_TEXT);
    }
    const lower = err.message.toLowerCase();
    if (
      lower.includes("fetch") ||
      lower.includes("econnrefused") ||
      lower.includes("econnreset") ||
      lower.includes("enotfound") ||
      lower.includes("network")
    ) {
      return new NetworkError("Firecrawl network error");
    }
  }
  return new ApiError("Firecrawl request failed", 500);
}

/**
 * Core POST. Sends the JSON body, maps a non-2xx status, parses the
 * response, and applies the **error-envelope dual-check**: Firecrawl
 * returns HTTP 200 with `{ success: false }` for some business errors,
 * so a parsed body that signals failure throws a terminal `ApiError`
 * (422 — business errors are not retried).
 */
async function postFirecrawlJson(
  apiKey: string,
  path: string,
  body: Record<string, unknown>,
  deps: FirecrawlTransportDeps,
  endpointLabel: string,
): Promise<unknown> {
  const f = deps.fetch ?? (fetch as unknown as ProviderQuotaFetch);
  const setT = deps.setTimeout ?? setTimeout;
  const clearT = deps.clearTimeout ?? clearTimeout;
  const env = deps.env ?? process.env;
  const timeoutMs = resolveTimeoutMs(env);

  const url = `${BASE_URL}${path}`;
  const controller = new AbortController();
  const timeoutId = setT(() => controller.abort(), timeoutMs);
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
    clearT(timeoutId);
    if (!res.ok) {
      await res.text().catch(() => {});
      throw mapStatusError(res.status, timeoutMs);
    }
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      throw new ApiError(`Firecrawl ${endpointLabel} returned a malformed response`, 500);
    }
    // Dual-check: 200 with { success: false } is a business error.
    if (isPlainObject(parsed) && parsed.success === false) {
      throw new ApiError(`Firecrawl ${endpointLabel} request failed`, 422);
    }
    return parsed;
  } catch (err) {
    clearT(timeoutId);
    throw normalizeTransportError(err, timeoutMs);
  } finally {
    controller.abort();
  }
}

/**
 * Perform ONE POST against the Firecrawl /v2/search endpoint. No retry;
 * no response body in public errors. Returns the parsed JSON body (raw;
 * the Adapter post-processes into normalized search sources).
 *
 * `params` carries Firecrawl-native API fields already mapped from
 * `SearchControls` by the Adapter.
 */
export async function fetchFirecrawlSearch(
  apiKey: string,
  query: string,
  params: FirecrawlSearchParams | undefined,
  deps: FirecrawlTransportDeps = {},
): Promise<unknown> {
  const body: Record<string, unknown> = { query };
  if (params) {
    if (params.sources !== undefined) {
      body.sources = params.sources.map((s) => ({ type: s.type }));
    }
    if (params.includeDomains !== undefined) {
      body.includeDomains = [...params.includeDomains];
    }
    if (params.tbs !== undefined) {
      body.tbs = params.tbs;
    }
    if (params.scrapeOptions !== undefined) {
      body.scrapeOptions = { formats: [...params.scrapeOptions.formats] };
    }
  }
  return postFirecrawlJson(apiKey, SEARCH_PATH, body, deps, "search");
}

/**
 * Perform ONE POST against the Firecrawl /v2/scrape endpoint. No retry;
 * no response body in public errors. Returns the parsed JSON body (raw;
 * the Adapter post-processes into a normalized ReaderFetchResult).
 *
 * `url` is a single URL; `params` carries the format + image/proxy options
 * already mapped from the Reader request by the Adapter.
 */
export async function fetchFirecrawlScrape(
  apiKey: string,
  url: string,
  params: FirecrawlScrapeParams,
  deps: FirecrawlTransportDeps = {},
): Promise<unknown> {
  const body: Record<string, unknown> = {
    url,
    formats: [...params.formats],
    proxy: params.proxy,
  };
  if (params.removeBase64Images !== undefined) {
    body.removeBase64Images = params.removeBase64Images;
  }
  return postFirecrawlJson(apiKey, SCRAPE_PATH, body, deps, "scrape");
}

/**
 * Perform ONE POST against the Firecrawl /v2/map endpoint. No retry; no
 * response body in public errors. Returns the parsed JSON body (raw; the
 * Adapter post-processes into a normalized MapResult).
 *
 * `params` carries Firecrawl-native API fields already mapped from
 * `MapRequest` by the Adapter. The /v2/map response is
 * `{ success, links: string[] }`.
 */
export async function fetchFirecrawlMap(
  apiKey: string,
  url: string,
  params: FirecrawlMapParams | undefined,
  deps: FirecrawlTransportDeps = {},
): Promise<unknown> {
  const body: Record<string, unknown> = { url };
  if (params) {
    if (params.limit !== undefined) {
      body.limit = params.limit;
    }
    if (params.search !== undefined) {
      body.search = params.search;
    }
  }
  return postFirecrawlJson(apiKey, MAP_PATH, body, deps, "map");
}
