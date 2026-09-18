/**
 * Kagi direct HTTP transport.
 *
 * GET https://kagi.com/api/v1/search (q, limit) for general search;
 * GET https://kagi.com/api/v0/enrich/news for topic:"news". Auth is
 * `Authorization: Bot <key>` (Kagi wire truth — not Bearer). The
 * envelope is `{ meta, data: [...] }`; adapter.ts owns result
 * filtering (t === 0). This module owns the HTTP status mapping.
 */

import { getGlobalFetch, type ProviderQuotaFetchResponse } from "../types.js";
import {
  ApiError,
  ConfigurationError,
  NetworkError,
  QuotaError,
  TimeoutError,
  ValidationError,
} from "../../lib/errors.js";
import { MISSING_KEY_HELP } from "./credentials.js";

const BASE_URL = "https://kagi.com";
const SEARCH_URL = `${BASE_URL}/api/v1/search`;
const NEWS_URL = `${BASE_URL}/api/v0/enrich/news`;
const DEFAULT_TIMEOUT_MS = 30000;

export interface KagiTransportDeps {
  readonly fetch?: (
    input: string,
    init: Record<string, unknown>,
  ) => Promise<ProviderQuotaFetchResponse>;
  readonly setTimeout?: typeof setTimeout;
  readonly clearTimeout?: typeof clearTimeout;
  readonly env?: NodeJS.ProcessEnv;
}

/** One row inside `data[]`. `t: 1` rows are related-query suggestions. */
export interface KagiResultItem {
  readonly t?: number;
  readonly rank?: number;
  readonly title?: string;
  readonly url?: string;
  readonly snippet?: string;
  readonly published?: string;
}

/** Kagi search envelope. Results live at `data[]`. */
export interface KagiSearchResponse {
  readonly meta?: unknown;
  readonly data?: readonly KagiResultItem[];
}

/** Kagi error body shape: { error: [{ code, msg }] }. */
export interface KagiErrorBody {
  readonly error?: readonly { readonly code?: string; readonly msg?: string }[];
}

export interface KagiSearchParams {
  readonly query: string;
  readonly limit?: number;
}

function resolveTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = parseInt(env.KAGI_TIMEOUT || String(DEFAULT_TIMEOUT_MS), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

/**
 * HTTP status → normalized Scoutline error (ERROR_HANDLING.md §1).
 * Curated constant messages only — the raw Provider body and the API
 * key never enter an error message.
 */
function mapStatusError(status: number): Error {
  if (status === 401) {
    return new ConfigurationError("Kagi rejected the API key (HTTP 401)", MISSING_KEY_HELP);
  }
  if (status === 403) {
    return new QuotaError("Kagi quota is insufficient (HTTP 403)");
  }
  if (status === 429) {
    return new ApiError("Kagi rate limit exceeded (HTTP 429)", 429);
  }
  if (status === 400) {
    return new ValidationError("Kagi rejected the request as invalid (HTTP 400)");
  }
  return new ApiError(`Kagi request failed (${status})`, status);
}

export async function fetchKagiSearch(
  apiKey: string,
  params: KagiSearchParams,
  deps: KagiTransportDeps = {},
): Promise<KagiSearchResponse> {
  const fetchFn = deps.fetch || getGlobalFetch();
  const setTimer = deps.setTimeout || globalThis.setTimeout;
  const clearTimer = deps.clearTimeout || globalThis.clearTimeout;
  const env = deps.env || process.env;
  const timeoutMs = resolveTimeoutMs(env);

  const url = `${SEARCH_URL}?q=${encodeURIComponent(params.query)}&limit=${params.limit ?? 10}`;
  const controller = new AbortController();
  const timer = setTimer(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchFn(url, {
      method: "GET",
      headers: {
        Authorization: `Bot ${apiKey}`,
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw mapStatusError(response.status);
    }

    const text = await response.text();
    return JSON.parse(text) as KagiSearchResponse;
  } catch (err: unknown) {
    if (
      err instanceof ApiError ||
      err instanceof TimeoutError ||
      err instanceof ConfigurationError ||
      err instanceof QuotaError ||
      err instanceof ValidationError
    ) {
      throw err;
    }
    if (err instanceof SyntaxError) {
      throw new ApiError("Kagi returned a malformed JSON response", 500);
    }
    if (err instanceof Error && err.name === "AbortError") {
      throw new TimeoutError(timeoutMs, "Try again or increase timeout with KAGI_TIMEOUT env var");
    }
    throw new NetworkError(
      `Kagi search failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimer(timer);
  }
}

/** Topic:"news" GET — same q/limit params, v0 enrich/news endpoint. */
export async function fetchKagiNews(
  apiKey: string,
  params: KagiSearchParams,
  deps: KagiTransportDeps = {},
): Promise<KagiSearchResponse> {
  const fetchFn = deps.fetch || getGlobalFetch();
  const url = `${NEWS_URL}?q=${encodeURIComponent(params.query)}&limit=${params.limit ?? 10}`;
  const response = await fetchFn(url, {
    method: "GET",
    headers: {
      Authorization: `Bot ${apiKey}`,
    },
  });
  if (!response.ok) {
    throw mapStatusError(response.status);
  }
  const text = await response.text();
  try {
    return JSON.parse(text) as KagiSearchResponse;
  } catch {
    throw new ApiError("Kagi returned a malformed JSON response", 500);
  }
}
