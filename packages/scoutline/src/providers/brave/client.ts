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

/**
 * Perform ONE GET against the Brave `/res/v1/videos/search` endpoint. No
 * retry; no response body in public errors. Returns the parsed JSON
 * body (raw; the Adapter post-processes into normalized search
 * sources).
 *
 * Dispatched when `controls.type === "video"`; precedence is
 * `video > news > web`. `params` carries the same Brave-native fields
 * as {@link fetchBraveSearch}.
 *
 * NOTE: Brave documents the videos endpoint as a POST body, but GET
 * with query params covers every field we send (`q`/`country`/
 * `freshness`) — confirm live, fall back to POST only if GET is
 * rejected. `count` is intentionally absent (see
 * {@link BraveSearchParams}); video results are client-side-truncated
 * via `applyCount` like every provider, and the video endpoint's
 * default page-size cap is unconfirmed (live gate).
 */
export async function fetchBraveVideoSearch(
  apiKey: string,
  query: string,
  params?: BraveSearchParams,
  deps: BraveTransportDeps = {},
): Promise<unknown> {
  return getBraveJson(apiKey, "/res/v1/videos/search", { q: query, ...(params ?? {}) }, deps);
}

/**
 * Perform ONE GET against the Brave LLM Context endpoint
 * (`/res/v1/llm/context`). No retry; no response body in public errors.
 * Returns the parsed JSON body (raw; the Adapter post-processes into
 * normalized search sources).
 *
 * Unlike the web/news/video endpoints, LLM Context is **query-keyed** —
 * it is a richer search that returns extracted passages
 * (`grounding.generic[]`), NOT a URL-keyed summarizer. It is dispatched
 * when `controls.contentSize === "high"` (the accepted 4th-meaning
 * overload of `--content-size`); precedence is `video > high > news >
 * web`. `high` overrides `topic`, so this path must receive a CLEAN
 * query (no `topic` keyword appendage); the Adapter is responsible for
 * that suppression.
 *
 * This helper sends ONLY `q`. Two live gates shape that:
 *   - **count:** `--count` never reaches the Adapter (it is applied
 *     client-side after normalization by shared execution). LLM
 *     Context's own source-count/token-budget param name is currently
 *     UNCONFIRMED, so a fixed default is intentionally NOT forwarded
 *     here — we send only `q` rather than guess the field name.
 *   - **country/freshness:** whether LLM Context accepts `country`/
 *     `freshness` is UNCONFIRMED. To avoid sending params the endpoint
 *     may reject, the Adapter does NOT pass `mapSearchControls(...)` to
 *     this helper (only `{ q }` flows through).
 * (GATES-1/4 in brave-tech-plan §9 — confirm live, then widen.)
 */
export async function fetchBraveLlmContext(
  apiKey: string,
  query: string,
  deps: BraveTransportDeps = {},
): Promise<unknown> {
  return getBraveJson(apiKey, "/res/v1/llm/context", { q: query }, deps);
}

// ---------------------------------------------------------------------------
// Rate-limit header probe (T6)
// ---------------------------------------------------------------------------

/**
 * The four Brave `X-RateLimit-*` response headers, read as raw strings.
 * Each is `null` when the header is absent. The quota normalizer parses
 * these into windows; this transport layer only collects them.
 */
export interface BraveRateLimitHeaders {
  readonly limit: string | null;
  readonly policy: string | null;
  readonly remaining: string | null;
  readonly reset: string | null;
}

/** Cheapest-credible probe query (same stub as diagnostics). */
const RATE_LIMIT_PROBE_QUERY = "scoutline-quota-probe";

/**
 * Perform ONE GET against `/res/v1/web/search` with a stub query and
 * return the four `X-RateLimit-*` response headers. Brave has NO
 * `/usage` endpoint, so quota is read from these headers on a 1-query
 * probe. The probe costs exactly ONE request and sends ONLY `q` — no
 * `count` (shared execution applies count client-side) and no other
 * controls.
 *
 * Mirrors {@link getBraveJson}'s transport setup (X-Subscription-Token/
 * Accept/User-Agent headers, AbortController timeout via `BRAVE_TIMEOUT`,
 * the same HTTP-status → error {@link mapStatusError}, and
 * {@link normalizeTransportError}). On 2xx the body is DRAINED
 * (`res.text()`) and discarded — only the headers are needed. On non-2xx
 * the body is drained and dropped before throwing the mapped error; no
 * raw Brave body ever reaches an error message.
 */
export async function fetchBraveRateLimit(
  apiKey: string,
  deps: BraveTransportDeps = {},
): Promise<BraveRateLimitHeaders> {
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

  const url = `${BASE_URL}/res/v1/web/search${buildQueryString({ q: RATE_LIMIT_PROBE_QUERY })}`;
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
    // Only the headers are needed; drain the body to free the socket.
    await res.text().catch(() => {});
    const headers = res.headers;
    return {
      limit: headers.get("X-RateLimit-Limit"),
      policy: headers.get("X-RateLimit-Policy"),
      remaining: headers.get("X-RateLimit-Remaining"),
      reset: headers.get("X-RateLimit-Reset"),
    };
  } catch (err) {
    clearT(timeoutId);
    throw normalizeTransportError(err, timeoutMs);
  } finally {
    controller.abort();
  }
}
