/**
 * Exa direct HTTP transport (tech-plan §7, Transport Client).
 *
 * Performs direct POSTs against the Exa REST endpoints with an
 * `Authorization: Bearer <apiKey>` header. There is NO internal retry —
 * shared execution owns retry policy. Fetch and timer are injectable for
 * tests.
 *
 * Mirrors `providers/tavily/client.ts` in structure, but Exa-specific
 * differences:
 *   - Base URL `https://api.exa.ai`.
 *   - JSON bodies use camelCase (contrast Tavily's snake_case).
 *   - Error body is `{"error": "message"}` — a single string. HTTP-status
 *     is the sole error signal; the body is discarded at the transport
 *     boundary and never echoed outward.
 *   - HTTP 402 maps to {@link QuotaError} (Exa returns 402 for three
 *     exhaustion states: account, key, and team budget).
 *   - The `Exa-Beta` header is endpoint-scoped to `/agent/runs*`
 *     (Research, EXA-T04); search and contents calls do NOT send it.
 *
 * Boundary rules (ARCHITECTURE.md §2):
 *   - May import Adapter-local config and normalized errors.
 *   - May import `ProviderQuotaFetch` from `providers/types.ts`.
 *   - Must NOT import command presentation, capability contracts, or
 *     another Provider's Adapter.
 *   - Must NOT perform response field normalization — the Adapter owns
 *     that. This module declares Provider-native request-body types
 *     only (Exa API field names); it does not import SearchControls
 *     or any capability contract.
 */

import { createRequire } from "node:module";

import { ApiError, AuthError, NetworkError, QuotaError, TimeoutError } from "../../lib/errors.js";
import type { ProviderQuotaFetch } from "../types.js";

const require = createRequire(import.meta.url);
const { version: VERSION } = require("../../../package.json") as { version: string };

const BASE_URL = "https://api.exa.ai";
const SEARCH_PATH = "/search";
const DEFAULT_TIMEOUT_MS = 30000;

const USER_AGENT = `scoutline/${VERSION}`;
const TIMEOUT_HELP_TEXT = "Try again or increase timeout with EXA_TIMEOUT env var";

/** Injectable transport dependencies (fetch, timers, env). */
export interface ExaTransportDeps {
  readonly fetch?: ProviderQuotaFetch;
  readonly setTimeout?: typeof setTimeout;
  readonly clearTimeout?: typeof clearTimeout;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Provider-native search request body fields (Exa API field names,
 * camelCase). The Adapter maps the Provider-neutral `SearchControls`
 * into these before calling {@link fetchExaSearch}; the transport never
 * imports a capability contract.
 */
export interface ExaSearchParams {
  readonly numResults?: number;
  readonly includeDomains?: readonly string[];
  readonly startPublishedDate?: string;
  readonly type?: string;
  readonly category?: string;
}

function resolveTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = parseInt(env.EXA_TIMEOUT || String(DEFAULT_TIMEOUT_MS), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

/**
 * Layer 1 — HTTP-status mapping. Runs BEFORE the body is parsed; on a
 * non-200 response we discard the body and throw a typed error.
 *
 * Exa uses HTTP-status exclusively. HTTP 402 maps to {@link QuotaError}
 * — Exa returns it for three distinct exhaustion states
 * (NO_MORE_CREDITS, API_KEY_BUDGET_EXCEEDED, TEAM_BUDGET_EXCEEDED) which
 * are all terminal for the running operation. The 429 rate limit and any
 * 5xx are retryable `ApiError`s; other 4xx are terminal `ApiError`s
 * (matching `isOperationRetryableError` in execution.ts).
 *
 * `timeoutMs` is forwarded so 408/504 can throw `TimeoutError` carrying
 * the configured duration (and the `EXA_TIMEOUT` help text). The
 * transport never embeds credential material in any error message.
 */
function mapStatusError(status: number, timeoutMs: number): Error {
  if (status === 401 || status === 403) {
    return new AuthError("Exa authentication failed", "EXA_API_KEY");
  }
  if (status === 402) {
    return new QuotaError(
      "Exa quota exhausted. Top up credits on the Exa dashboard.",
      "Check your Exa account credits and key/team budget at dashboard.exa.ai",
    );
  }
  if (status === 408 || status === 504) {
    return new TimeoutError(timeoutMs, TIMEOUT_HELP_TEXT);
  }
  if (status === 429) {
    return new ApiError("Exa rate limit exceeded", 429);
  }
  if (status === 400 || status === 404 || status === 410 || status === 422) {
    return new ApiError("Exa request failed", status);
  }
  if (status >= 500) {
    return new ApiError("Exa request failed", status);
  }
  return new ApiError("Exa request failed", status);
}

function normalizeTransportError(err: unknown, timeoutMs: number): Error {
  if (
    err instanceof AuthError ||
    err instanceof QuotaError ||
    err instanceof ApiError ||
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
      return new NetworkError("Exa network error");
    }
  }
  return new ApiError("Exa request failed", 500);
}

async function postExaJson(
  apiKey: string,
  path: string,
  body: Record<string, unknown>,
  deps: ExaTransportDeps,
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
      throw new ApiError(`Exa ${endpointLabel} returned a malformed response`, 500);
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
 * Perform ONE POST against the Exa /search endpoint. No retry; no
 * response body in public errors. Returns the parsed JSON body (raw;
 * the Adapter post-processes into normalized search sources).
 *
 * `params` carries Exa-native API fields (camelCase) already mapped
 * from `SearchControls` by the Adapter. Search always sends
 * `contents: { highlights: true }` (token-efficient; populates
 * `summary`). The `Exa-Beta` header is NOT sent on search calls.
 */
export async function fetchExaSearch(
  apiKey: string,
  query: string,
  params?: ExaSearchParams,
  deps: ExaTransportDeps = {},
): Promise<unknown> {
  const body: Record<string, unknown> = { query };
  if (params) {
    if (params.numResults !== undefined) {
      body.numResults = params.numResults;
    }
    if (params.includeDomains !== undefined) {
      body.includeDomains = [...params.includeDomains];
    }
    if (params.startPublishedDate !== undefined) {
      body.startPublishedDate = params.startPublishedDate;
    }
    if (params.type !== undefined) {
      body.type = params.type;
    }
    if (params.category !== undefined) {
      body.category = params.category;
    }
  }
  // Always request highlights — token-efficient summary source.
  body.contents = { highlights: true };
  return postExaJson(apiKey, SEARCH_PATH, body, deps, "search");
}
