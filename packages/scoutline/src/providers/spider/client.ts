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
 */
async function postSpiderJson(
  apiKey: string,
  path: string,
  body: Record<string, unknown>,
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
      throw mapStatusError(res.status, DEFAULT_TIMEOUT_MS);
    }
    try {
      return await res.json();
    } catch {
      throw new ApiError(`Spider ${endpointLabel} returned a malformed response`, 500);
    }
  } catch (err) {
    clearT(timeoutId);
    throw normalizeTransportError(err, DEFAULT_TIMEOUT_MS);
  } finally {
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
