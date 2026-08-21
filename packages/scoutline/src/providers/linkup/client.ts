/**
 * Linkup direct HTTP transport.
 *
 * Performs POSTs against the Linkup REST endpoints
 * (`https://api.linkup.so/v1`) with an `Authorization: Bearer <apiKey>`
 * header. There is NO internal retry — shared execution owns retry
 * policy. Fetch and timers are injectable for tests.
 *
 * Structurally cloned from `providers/tavily/client.ts` (Tavily/Parallel
 * analog, IMPLEMENTATION-CONTRACT analog-adapter table), simplified to
 * Linkup's smaller endpoint surface.
 *
 * Failure taxonomy (Linkup ERROR_HANDLING, locked):
 *   401 / 403 -> ConfigurationError (never retry)
 *   402       -> QuotaError (never retry)
 *   404       -> ApiError 404 (never retry)
 *   422       -> ValidationError (never retry)
 *   429       -> ApiError 429 (retried by shared execution)
 *   5xx       -> ApiError status (retried by shared execution)
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
 *     that. This module declares Provider-native request-body types
 *     only (Linkup API field names).
 */

import pkg from "../../../package.json" with { type: "json" };

import {
  ApiError,
  ConfigurationError,
  NetworkError,
  QuotaError,
  TimeoutError,
  ValidationError,
} from "../../lib/errors.js";
import type { ProviderQuotaFetch } from "../types.js";
import { getGlobalFetch } from "../types.js";

const { version: VERSION } = pkg;

const BASE_URL = "https://api.linkup.so/v1";
const SEARCH_PATH = "/search";
const DEFAULT_TIMEOUT_MS = 30000;

const USER_AGENT = `scoutline/${VERSION}`;
const TIMEOUT_HELP_TEXT = "Try again or increase timeout with LINKUP_TIMEOUT env var";

/** Injectable transport dependencies (fetch, timers, env). */
export interface LinkupTransportDeps {
  readonly fetch?: ProviderQuotaFetch;
  readonly setTimeout?: typeof setTimeout;
  readonly clearTimeout?: typeof clearTimeout;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Provider-native search request body fields (Linkup API field names).
 * The Adapter maps the Provider-neutral `SearchControls` into these
 * before calling {@link fetchLinkupSearch}; the transport never imports
 * a capability contract.
 */
export interface LinkupSearchWireRequest {
  readonly q: string;
  readonly depth?: "fast" | "standard" | "deep";
  readonly outputType?: "searchResults" | "sourcedAnswer" | "structured";
  readonly includeDomains?: readonly string[];
  /** YYYY-MM-DD lower bound of the recency window. */
  readonly fromDate?: string;
  /** YYYY-MM-DD upper bound of the recency window. */
  readonly toDate?: string;
}

function resolveTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = parseInt(env.LINKUP_TIMEOUT || String(DEFAULT_TIMEOUT_MS), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

/**
 * Layer 1 — HTTP-status mapping. Runs BEFORE the body is parsed; on a
 * non-200 response we discard the body and throw a typed error with a
 * curated message (no raw Provider body in any public error).
 */
function mapStatusError(status: number): Error {
  if (status === 401 || status === 403) {
    return new ConfigurationError(
      "Linkup authentication failed",
      'export LINKUP_API_KEY="your-api-key"',
    );
  }
  if (status === 402) {
    return new QuotaError("Linkup credit balance is depleted");
  }
  if (status === 422) {
    return new ValidationError("Linkup rejected the request parameters");
  }
  if (status === 429) {
    return new ApiError("Linkup rate limit exceeded", 429);
  }
  return new ApiError("Linkup request failed", status);
}

function normalizeTransportError(err: unknown, timeoutMs: number): Error {
  if (
    err instanceof ConfigurationError ||
    err instanceof QuotaError ||
    err instanceof ValidationError ||
    err instanceof ApiError ||
    err instanceof TimeoutError ||
    err instanceof NetworkError
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
      return new NetworkError("Linkup network error");
    }
  }
  return new ApiError("Linkup request failed", 500);
}

async function postLinkupJson(
  apiKey: string,
  path: string,
  body: Record<string, unknown>,
  deps: LinkupTransportDeps,
  endpointLabel: string,
): Promise<unknown> {
  const f = deps.fetch ?? getGlobalFetch<ProviderQuotaFetch>();
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
      throw mapStatusError(res.status);
    }
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      throw new ApiError(`Linkup ${endpointLabel} returned a malformed response`, 500);
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
 * Perform ONE POST against the Linkup /search endpoint. No retry; no
 * response body in public errors. Returns the parsed JSON body (raw;
 * the Adapter post-processes into normalized search sources).
 *
 * `request` carries Linkup-native API fields already mapped from
 * `SearchControls` by the Adapter.
 */
export async function fetchLinkupSearch(
  apiKey: string,
  request: LinkupSearchWireRequest,
  deps: LinkupTransportDeps = {},
): Promise<unknown> {
  const body: Record<string, unknown> = {
    q: request.q,
    outputType: request.outputType ?? "searchResults",
  };
  if (request.depth !== undefined) {
    body.depth = request.depth;
  }
  if (request.includeDomains !== undefined) {
    body.includeDomains = [...request.includeDomains];
  }
  if (request.fromDate !== undefined) {
    body.fromDate = request.fromDate;
  }
  if (request.toDate !== undefined) {
    body.toDate = request.toDate;
  }
  return postLinkupJson(apiKey, SEARCH_PATH, body, deps, "search");
}
