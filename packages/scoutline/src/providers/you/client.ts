/**
 * You.com direct HTTP transport.
 *
 * Performs direct POSTs against the You.com Data Center index
 * (`https://ydc-index.io/v1`) with an `X-API-Key: <apiKey>` header.
 * There is NO internal retry — shared execution owns retry policy.
 * Fetch and timers are injectable for tests.
 *
 * Mirrors `providers/exa/client.ts` in structure, with You.com-specific
 * differences:
 *   - Base URL `https://ydc-index.io/v1` (Search/Contents host; the
 *     Research host `api.you.com` joins when the Research capability
 *     lands).
 *   - Auth header `X-API-Key` (not Bearer).
 *   - JSON bodies use snake_case (contrast Exa's camelCase).
 *   - Error taxonomy per the You.com error-code reference: 401/403 ->
 *     ConfigurationError, 402 -> QuotaError, 422 -> ValidationError,
 *     429 -> retryable ApiError, 502/503/504 -> NetworkError.
 *
 * Boundary rules (same as the Exa client):
 *   - May import normalized errors and fetch helpers from
 *     `providers/types.ts`.
 *   - Must NOT import command presentation, capability contracts, or
 *     another Provider's Adapter.
 *   - Must NOT perform response field normalization — the Adapter owns
 *     that. This module declares Provider-native request-body types
 *     only (You.com API field names); it does not import
 *     SearchControls or any capability contract.
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
import { getGlobalFetch } from "../types.js";

const { version: VERSION } = pkg;

const INDEX_BASE_URL = "https://ydc-index.io/v1";
const SEARCH_PATH = "/search";
const DEFAULT_TIMEOUT_MS = 30000;
const USER_AGENT = `scoutline/${VERSION}`;
const TIMEOUT_HELP_TEXT = "Try again later.";

/** Injectable transport dependencies (fetch, timers). */
export interface YouTransportDeps {
  readonly fetch?: typeof fetch;
  readonly setTimeout?: typeof setTimeout;
  readonly clearTimeout?: typeof clearTimeout;
}

/**
 * Provider-native search request body fields (You.com API field names,
 * snake_case). The Adapter maps the Provider-neutral `SearchControls`
 * into these before calling {@link fetchYouSearch}; the transport never
 * imports a capability contract.
 */
export interface YouSearchWireRequest {
  readonly query: string;
  readonly count?: number;
  readonly country?: string;
  readonly freshness?: "day" | "week" | "month" | "year";
  readonly include_domains?: readonly string[];
  readonly exclude_domains?: readonly string[];
  readonly extraction?: { readonly extraction_mode?: "highlights" | "full_page" };
}

/**
 * Map a non-2xx You.com status onto a normalized error (You.com error
 * taxonomy: 401/403 -> ConfigurationError, 402 -> QuotaError, 404 ->
 * ApiError, 422 -> ValidationError, 429 -> retryable ApiError, 502/
 * 503/504 -> NetworkError, other 5xx -> ApiError). The response body is
 * discarded at the transport boundary and never echoed outward.
 */
function mapStatusError(status: number): Error {
  if (status === 401) {
    return new ConfigurationError(
      "You.com rejected the API key.",
      "Check YDC_API_KEY or YOU_API_KEY.",
    );
  }
  if (status === 402) {
    return new QuotaError("You.com credits are depleted.");
  }
  if (status === 403) {
    return new ConfigurationError(
      "You.com denied access for this key or tier.",
      "Check the key's allowed domains and plan tier.",
    );
  }
  if (status === 422) {
    return new ValidationError("You.com rejected the request as invalid.");
  }
  if (status === 429) {
    return new ApiError("You.com rate limit exceeded", 429);
  }
  if (status === 502 || status === 503 || status === 504) {
    return new NetworkError("You.com upstream gateway error");
  }
  return new ApiError("You.com request failed", status);
}

function normalizeTransportError(err: unknown, timeoutMs: number): Error {
  if (
    err instanceof ConfigurationError ||
    err instanceof QuotaError ||
    err instanceof ValidationError ||
    err instanceof ApiError ||
    err instanceof NetworkError ||
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
      return new NetworkError("You.com network error");
    }
  }
  return new ApiError("You.com request failed", 500);
}

async function postYouJson(
  apiKey: string,
  path: string,
  body: Record<string, unknown>,
  deps: YouTransportDeps,
  endpointLabel: string,
): Promise<unknown> {
  const f = deps.fetch ?? getGlobalFetch<typeof fetch>();
  const setT = deps.setTimeout ?? setTimeout;
  const clearT = deps.clearTimeout ?? clearTimeout;
  const url = `${INDEX_BASE_URL}${path}`;
  const controller = new AbortController();
  const timeoutId = setT(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      "X-API-Key": apiKey,
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
    };
    const res = await f(url, {
      method: "POST",
      headers,
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
      throw new ApiError(`You.com ${endpointLabel} returned a malformed response`, 500);
    }
    return parsed;
  } catch (err) {
    clearT(timeoutId);
    throw normalizeTransportError(err, DEFAULT_TIMEOUT_MS);
  } finally {
    controller.abort();
  }
}

/**
 * Perform ONE POST against the You.com /v1/search endpoint. No retry;
 * no response body in public errors. Returns the parsed JSON body
 * (raw; the Adapter normalizes it into normalized search sources).
 *
 * `request` carries You.com-native API fields (snake_case) already
 * mapped from `SearchControls` by the Adapter.
 */
export async function fetchYouSearch(
  apiKey: string,
  request: YouSearchWireRequest,
  deps: YouTransportDeps = {},
): Promise<unknown> {
  const body: Record<string, unknown> = { query: request.query };
  if (request.count !== undefined) {
    body.count = request.count;
  }
  if (request.country !== undefined) {
    body.country = request.country;
  }
  if (request.freshness !== undefined) {
    body.freshness = request.freshness;
  }
  if (request.include_domains !== undefined) {
    body.include_domains = [...request.include_domains];
  }
  if (request.exclude_domains !== undefined) {
    body.exclude_domains = [...request.exclude_domains];
  }
  if (request.extraction !== undefined) {
    body.extraction = { extraction_mode: request.extraction.extraction_mode };
  }
  return postYouJson(apiKey, SEARCH_PATH, body, deps, "search");
}
