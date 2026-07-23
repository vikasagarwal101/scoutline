/**
 * Brave direct HTTP transport skeleton (brave-tech-plan §5, §6).
 *
 * Performs direct GETs against the Brave Search REST API with an
 * `X-Subscription-Token: <apiKey>` header. There is NO internal retry —
 * shared execution owns retry policy. Fetch and timers are injectable
 * for tests.
 *
 * Mirrors `providers/tavily/client.ts` in structure, but SIMPLER in
 * T1: the foundation only ships the GET transport and a thin
 * HTTP-status → Scoutline error map. Capability-specific request body
 * mapping arrives in later tickets (search, quota, etc.) once those
 * Capability Modules land.
 *
 * The fetch dep's response type is the header-bearing
 * {@link ProviderImageFetchResponse} (not the narrower
 * {@link ProviderQuotaFetchResponse}) so the future Brave quota
 * Capability can read `X-RateLimit-*` headers off responses without a
 * second transport seam. T1 never reads those headers, but reusing the
 * existing type keeps the seam stable.
 *
 * Boundary rules (ARCHITECTURE.md §2):
 *   - May import Adapter-local config and normalized errors.
 *   - May import {@link ProviderImageFetchResponse} from `providers/types.ts`.
 *   - Must NOT import command presentation, capability contracts, or
 *     another Provider's Adapter.
 *   - Must NOT perform response field normalization — the Adapter owns
 *     that. This module declares Provider-native request paths and
 *     params only; it never imports a capability contract.
 */

import { createRequire } from "node:module";

import { ApiError, AuthError, NetworkError, TimeoutError } from "../../lib/errors.js";
import type { ProviderImageFetchResponse } from "../types.js";

const require = createRequire(import.meta.url);
const { version: VERSION } = require("../../../package.json") as { version: string };

const BASE_URL = "https://api.search.brave.com";
const DEFAULT_TIMEOUT_MS = 30000;

const USER_AGENT = `scoutline/${VERSION}`;
const TIMEOUT_HELP_TEXT = "Try again or increase timeout with BRAVE_TIMEOUT env var";

/** Injectable transport dependencies (fetch, timers, env). */
export interface BraveTransportDeps {
  readonly fetch?: (
    input: string,
    init: Record<string, unknown>,
  ) => Promise<ProviderImageFetchResponse>;
  readonly setTimeout?: typeof setTimeout;
  readonly clearTimeout?: typeof clearTimeout;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Provider-native search request query params (Brave API field names).
 * The Adapter maps the Provider-neutral `SearchControls` into these
 * before calling {@link fetchBraveSearch}; the transport never imports
 * a capability contract.
 *
 * NOTE: `count` is intentionally ABSENT here. Result-count projection
 * is a client-side concern owned by shared execution (`applyCount`)
 * AFTER `invoke`+cache; `SearchRequest`/`SearchControls` carry NO
 * `count` field, so the transport sends only `q` plus the mapped
 * controls below (`country`/`freshness`). Brave therefore returns its
 * default page size; `--count` above that is silently capped (no
 * pagination in T2).
 */
export interface BraveSearchParams {
  readonly country?: string;
  readonly freshness?: string;
}

function resolveTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = parseInt(env.BRAVE_TIMEOUT || String(DEFAULT_TIMEOUT_MS), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

/**
 * Layer 1 — HTTP-status mapping. Runs BEFORE the body is parsed; on a
 * non-200 response we discard the body and throw a typed error.
 *
 * `timeoutMs` is forwarded so 408/504 can throw `TimeoutError`
 * carrying the configured duration (and the `BRAVE_TIMEOUT` help text).
 * The transport never embeds credential material or raw response bodies
 * in any error message.
 */
function mapStatusError(status: number, timeoutMs: number): Error {
  if (status === 401 || status === 403) {
    return new AuthError("Brave authentication failed", "BRAVE_SEARCH_API_KEY");
  }
  if (status === 408 || status === 504) {
    return new TimeoutError(timeoutMs, TIMEOUT_HELP_TEXT);
  }
  if (status === 429) {
    return new ApiError("Brave rate limit exceeded", 429);
  }
  if (status === 400 || status === 404 || status === 410 || status === 422) {
    return new ApiError("Brave request failed", status);
  }
  if (status >= 500) {
    return new ApiError("Brave request failed", status);
  }
  return new ApiError("Brave request failed", status);
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
      return new NetworkError("Brave network error");
    }
  }
  return new ApiError("Brave request failed", 500);
}

/**
 * Build the query string for a GET. Skips `undefined`/`null` values.
 * Uses `encodeURIComponent` so callers can pass raw strings without
 * pre-encoding.
 */
function buildQueryString(params?: Readonly<Record<string, unknown>>): string {
  if (!params) return "";
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.length === 0 ? "" : `?${parts.join("&")}`;
}

/**
 * Perform ONE GET against the Brave Search API. No retry; no response
 * body in public errors. Returns the parsed JSON body (raw; the
 * Adapter post-processes into a normalized shape).
 *
 * The transport carries `X-Subscription-Token` (NOT
 * `Authorization: Bearer`) and a `User-Agent: scoutline/<version>`
 * string read from `package.json` at module load.
 */
export async function getBraveJson(
  apiKey: string,
  path: string,
  params?: Readonly<Record<string, unknown>>,
  deps: BraveTransportDeps = {},
): Promise<unknown> {
  const f =
    deps.fetch ??
    (fetch as unknown as (
      input: string,
      init: Record<string, unknown>,
    ) => Promise<ProviderImageFetchResponse>);
  const setT = deps.setTimeout ?? setTimeout;
  const clearT = deps.clearTimeout ?? clearTimeout;
  const env = deps.env ?? process.env;
  const timeoutMs = resolveTimeoutMs(env);

  const url = `${BASE_URL}${path}${buildQueryString(params)}`;
  const controller = new AbortController();
  const timeoutId = setT(() => controller.abort(), timeoutMs);
  try {
    const res = await f(url, {
      method: "GET",
      headers: {
        "X-Subscription-Token": apiKey,
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
      signal: controller.signal,
    });
    clearT(timeoutId);
    if (!res.ok) {
      // Drain the body to free the socket, then drop it. The body must
      // NEVER reach the error message (NFR-006).
      await res.text().catch(() => {});
      throw mapStatusError(res.status, timeoutMs);
    }
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      throw new ApiError("Brave returned a malformed response", 500);
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
 * Perform ONE GET against the Brave `/res/v1/web/search` endpoint. No
 * retry; no response body in public errors. Returns the parsed JSON
 * body (raw; the Adapter post-processes into normalized search
 * sources).
 *
 * `params` carries Brave-native API fields already mapped from
 * `SearchControls` by the Adapter (`country`/`freshness`). The query
 * is sent as the `q` query-string parameter.
 */
export async function fetchBraveSearch(
  apiKey: string,
  query: string,
  params?: BraveSearchParams,
  deps: BraveTransportDeps = {},
): Promise<unknown> {
  return getBraveJson(apiKey, "/res/v1/web/search", { q: query, ...(params ?? {}) }, deps);
}

/**
 * Perform ONE GET against the Brave `/res/v1/news/search` endpoint. No
 * retry; no response body in public errors. Returns the parsed JSON
 * body (raw; the Adapter post-processes into normalized search
 * sources).
 *
 * Dispatched when `controls.topic === "news"`; the web endpoint is the
 * default. `params` carries the same Brave-native fields as
 * {@link fetchBraveSearch}.
 */
export async function fetchBraveNewsSearch(
  apiKey: string,
  query: string,
  params?: BraveSearchParams,
  deps: BraveTransportDeps = {},
): Promise<unknown> {
  return getBraveJson(apiKey, "/res/v1/news/search", { q: query, ...(params ?? {}) }, deps);
}
