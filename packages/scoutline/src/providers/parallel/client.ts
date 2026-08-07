/**
 * Parallel AI direct HTTP transport.
 *
 * Performs direct HTTP requests against Parallel AI API endpoints.
 */

import { createRequire } from "node:module";
import { ApiError, AuthError, NetworkError, TimeoutError } from "../../lib/errors.js";
import type { ProviderQuotaFetchResponse } from "../types.js";

const require = createRequire(import.meta.url);
const { version: VERSION } = require("../../../package.json") as { version: string };

const BASE_URL = "https://api.parallel.ai";
const DEFAULT_TIMEOUT_MS = 30000;

const USER_AGENT = `scoutline/${VERSION}`;
const TIMEOUT_HELP_TEXT = "Try again or increase timeout with PARALLEL_TIMEOUT env var";

export interface ParallelTransportDeps {
  readonly fetch?: (
    input: string,
    init: Record<string, unknown>,
  ) => Promise<ProviderQuotaFetchResponse>;
  readonly setTimeout?: typeof setTimeout;
  readonly clearTimeout?: typeof clearTimeout;
  readonly env?: NodeJS.ProcessEnv;
}

export interface ParallelSearchParams {
  readonly objective?: string;
}

export interface ParallelSearchResultItem {
  readonly title?: string;
  readonly url?: string;
  readonly excerpts?: readonly string[];
  readonly publish_date?: string | null;
}

export interface ParallelSearchResponse {
  readonly search_id?: string;
  readonly results?: readonly ParallelSearchResultItem[];
  readonly usage?: readonly unknown[];
  readonly session_id?: string;
}

function resolveTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = parseInt(env.PARALLEL_TIMEOUT || String(DEFAULT_TIMEOUT_MS), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

function mapStatusError(status: number, timeoutMs: number): Error {
  if (status === 401 || status === 403) {
    return new AuthError("Parallel AI authentication failed", "PARALLEL_API_KEY");
  }
  if (status === 408 || status === 504) {
    return new TimeoutError(timeoutMs, TIMEOUT_HELP_TEXT);
  }
  if (status === 429) {
    return new ApiError("Parallel AI rate limit exceeded", 429);
  }
  if (status >= 400 && status < 500) {
    return new ApiError(`Parallel AI API client error (${status})`, status);
  }
  if (status >= 500) {
    return new ApiError(`Parallel AI API server error (${status})`, status);
  }
  return new ApiError(`Parallel AI request failed (${status})`, status);
}

export async function fetchParallelSearch(
  apiKey: string,
  query: string,
  params: ParallelSearchParams = {},
  deps: ParallelTransportDeps = {},
): Promise<ParallelSearchResponse> {
  const fetchFn = deps.fetch || globalThis.fetch;
  const setTimer = deps.setTimeout || globalThis.setTimeout;
  const clearTimer = deps.clearTimeout || globalThis.clearTimeout;
  const env = deps.env || process.env;
  const timeoutMs = resolveTimeoutMs(env);

  const url = `${BASE_URL}/v1/search`;
  const body: Record<string, unknown> = {
    search_queries: [query],
  };
  if (params.objective) {
    body.objective = params.objective;
  }

  const controller = new AbortController();
  const timer = setTimer(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchFn(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw mapStatusError(response.status, timeoutMs);
    }

    const text = await response.text();
    return JSON.parse(text) as ParallelSearchResponse;
  } catch (err: unknown) {
    if (err instanceof AuthError || err instanceof ApiError || err instanceof TimeoutError) {
      throw err;
    }
    if (err instanceof Error && err.name === "AbortError") {
      throw new TimeoutError(timeoutMs, TIMEOUT_HELP_TEXT);
    }
    throw new NetworkError(
      `Parallel AI request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimer(timer);
  }
}

// ---------------------------------------------------------------------------
// Extract API — /v1/extract
// ---------------------------------------------------------------------------

export interface ParallelExtractResultItem {
  readonly url?: string;
  readonly title?: string;
  readonly publish_date?: string | null;
  readonly excerpts?: readonly string[];
  readonly full_content?: string;
}

export interface ParallelExtractErrorEntry {
  readonly url?: string;
  readonly error_type?: string;
  readonly http_status_code?: number;
}

export interface ParallelExtractResponse {
  readonly results?: readonly ParallelExtractResultItem[];
  readonly errors?: readonly ParallelExtractErrorEntry[];
}

export async function fetchParallelExtract(
  apiKey: string,
  targetUrl: string,
  deps: ParallelTransportDeps = {},
): Promise<ParallelExtractResponse> {
  const fetchFn = deps.fetch || globalThis.fetch;
  const setTimer = deps.setTimeout || globalThis.setTimeout;
  const clearTimer = deps.clearTimeout || globalThis.clearTimeout;
  const env = deps.env || process.env;
  const timeoutMs = resolveTimeoutMs(env);

  const url = `${BASE_URL}/v1/extract`;
  const body = { urls: [targetUrl] };

  const controller = new AbortController();
  const timer = setTimer(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchFn(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw mapStatusError(response.status, timeoutMs);
    }

    const text = await response.text();
    return JSON.parse(text) as ParallelExtractResponse;
  } catch (err: unknown) {
    if (err instanceof AuthError || err instanceof ApiError || err instanceof TimeoutError) {
      throw err;
    }
    if (err instanceof Error && err.name === "AbortError") {
      throw new TimeoutError(timeoutMs, TIMEOUT_HELP_TEXT);
    }
    throw new NetworkError(
      `Parallel AI extract failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimer(timer);
  }
}
