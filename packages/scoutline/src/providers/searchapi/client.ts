/**
 * SearchApi.io direct HTTP transport.
 *
 * Performs direct GETs against the SearchApi.io REST API
 * (`https://www.searchapi.io/api/v1`) with an
 * `Authorization: Bearer <apiKey>` header — the key NEVER travels as a
 * query parameter. There is NO internal retry — shared execution owns
 * retry policy. Fetch and timers are injectable for tests.
 *
 * Structurally cloned from `providers/brave/client.ts`, simplified to
 * the Linkup shape (no retry-hint header parsing; SearchApi exposes no
 * rate-limit response headers to read).
 *
 * Failure taxonomy (SearchApi ERROR_HANDLING, locked):
 *   401 / 403 -> AuthError (never retry)
 *   402       -> QuotaError (never retry)
 *   408 / 504 -> TimeoutError (retryable by shared execution)
 *   422       -> ApiError 422 (never retry)
 *   429       -> ApiError 429 (retried by shared execution)
 *   >= 500 / default -> ApiError status (retried by shared execution)
 *
 * Raw response bodies NEVER cross this module's error boundary — every
 * thrown message is a curated constant (NFR-006).
 *
 * Boundary rules (ARCHITECTURE.md §2):
 *   - May import Adapter-local config and normalized errors.
 *   - May import `ProviderQuotaFetch` from `providers/types.js`.
 *   - Must NOT import command presentation, capability contracts, or
 *     another Provider's Adapter.
 *   - Must NOT perform response field normalization — the Adapter owns
 *     that. This module declares Provider-native request params only.
 */

import pkg from "../../../package.json" with { type: "json" };

import { ApiError, AuthError, NetworkError, QuotaError, TimeoutError } from "../../lib/errors.js";
import type { ProviderQuotaFetch } from "../types.js";
import { getGlobalFetch } from "../types.js";
import { clampTimeoutMs } from "../../lib/timeout.js";

const { version: VERSION } = pkg;

const BASE_URL = "https://www.searchapi.io";
const SEARCH_PATH = "/api/v1/search";
const ME_PATH = "/api/v1/me";
const DEFAULT_TIMEOUT_MS = 30000;

const USER_AGENT = `scoutline/${VERSION}`;
const TIMEOUT_HELP_TEXT = "Try again or increase timeout with SEARCHAPI_TIMEOUT env var";

/** Injectable transport dependencies (fetch, timers, env). */
export interface SearchApiTransportDeps {
  readonly fetch?: ProviderQuotaFetch;
  readonly setTimeout?: typeof setTimeout;
  readonly clearTimeout?: typeof clearTimeout;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Provider-native search request query params (SearchApi API field
 * names). The Adapter maps the Provider-neutral `SearchControls` into
 * these before calling {@link fetchSearchApiSearch}; the transport
 * never imports a capability contract. Result-count projection is a
 * client-side concern owned by shared execution, so no count field
 * exists here.
 */
export interface SearchApiSearchParams {
  readonly engine?: string;
  readonly q?: string;
  readonly gl?: string;
  readonly time_period?: string;
}

export function resolveTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = parseInt(env.SEARCHAPI_TIMEOUT || String(DEFAULT_TIMEOUT_MS), 10);
  return clampTimeoutMs(raw, DEFAULT_TIMEOUT_MS);
}

/**
 * Layer 1 — HTTP-status mapping. Runs BEFORE the body is parsed; on a
 * non-2xx response we discard the body and throw a typed error with a
 * curated message (no raw Provider body in any public error).
 */
function mapStatusError(status: number, timeoutMs: number): Error {
  if (status === 401 || status === 403) {
    return new AuthError("SearchApi.io authentication failed", "SEARCHAPI_API_KEY");
  }
  if (status === 402) {
    return new QuotaError("SearchApi.io credits exhausted");
  }
  if (status === 408 || status === 504) {
    return new TimeoutError(timeoutMs, TIMEOUT_HELP_TEXT);
  }
  if (status === 422) {
    return new ApiError("SearchApi.io request failed", 422);
  }
  if (status === 429) {
    return new ApiError("SearchApi.io rate limit exceeded", 429);
  }
  return new ApiError("SearchApi.io request failed", status);
}

function normalizeTransportError(err: unknown, timeoutMs: number): Error {
  if (
    err instanceof AuthError ||
    err instanceof ApiError ||
    err instanceof NetworkError ||
    err instanceof QuotaError ||
    err instanceof TimeoutError
  ) {
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
      return new NetworkError("SearchApi.io network error");
    }
  }
  return new ApiError("SearchApi.io request failed", 500);
}

/**
 * Build the query string for a GET. Skips `undefined`/`null` values.
 * Uses `encodeURIComponent` so callers can pass raw strings without
 * pre-encoding. The API key is NEVER a query parameter — it travels
 * only in the `Authorization: Bearer` header.
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
 * Shared GET plumbing for every SearchApi.io JSON endpoint. Performs
 * ONE GET against `path` with the canonical Bearer/Accept/User-Agent
 * headers, the injected timeout, the status map, and JSON parsing. No
 * retry; no response body in public errors. Returns the parsed JSON
 * body (raw; the Adapter post-processes into normalized shapes).
 *
 * `params` carries SearchApi-native API fields already mapped by the
 * Adapter (`engine`/`q`/`gl`/`time_period` for search). The API key is
 * NEVER a query parameter — it travels only in the `Authorization:
 * Bearer` header.
 */
async function getSearchApiJson(
  apiKey: string,
  path: string,
  params: Readonly<Record<string, unknown>> | undefined,
  deps: SearchApiTransportDeps,
): Promise<unknown> {
  const f = deps.fetch ?? getGlobalFetch<ProviderQuotaFetch>();
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
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      // Drain the body to free the socket, then drop it. The body must
      // NEVER reach the error message (NFR-006).
      await res.text().catch(() => {});
      throw mapStatusError(res.status, timeoutMs);
    }
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch (err) {
      // Only a genuine parse failure (non-JSON body → SyntaxError) is
      // the malformed-response case. Anything else — notably the
      // AbortError thrown when the transport timeout fires mid-read —
      // must flow to the outer catch so normalizeTransportError keeps
      // its AbortError → TimeoutError classification.
      if (err instanceof SyntaxError) {
        throw new ApiError("SearchApi.io returned a malformed response", 500);
      }
      throw err;
    }
    return parsed;
  } catch (err) {
    throw normalizeTransportError(err, timeoutMs);
  } finally {
    // Clear the timeout only after body consumption so the AbortController
    // timeout still covers a stalled/slow response body read.
    clearT(timeoutId);
    controller.abort();
  }
}

/**
 * Perform ONE GET against the SearchApi.io `/api/v1/search` endpoint.
 * No retry; no response body in public errors. Returns the parsed JSON
 * body (raw; the Adapter post-processes into normalized search
 * sources).
 *
 * `params` carries SearchApi-native API fields already mapped from
 * `SearchControls` by the Adapter (`engine`/`q`/`gl`/`time_period`).
 */
export async function fetchSearchApiSearch(
  apiKey: string,
  params: SearchApiSearchParams = {},
  deps: SearchApiTransportDeps = {},
): Promise<unknown> {
  return getSearchApiJson(apiKey, SEARCH_PATH, { ...(params ?? {}) }, deps);
}

/**
 * Perform ONE GET against the SearchApi.io `/api/v1/me` endpoint — the
 * account/subscription metadata probe used by the Quota and Diagnostics
 * Capabilities. Non-destructive: `/me` is not a search, so it consumes
 * no search credits. No retry; no response body in public errors.
 */
export async function fetchSearchApiMe(
  apiKey: string,
  deps: SearchApiTransportDeps = {},
): Promise<unknown> {
  return getSearchApiJson(apiKey, ME_PATH, undefined, deps);
}
