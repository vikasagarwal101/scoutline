/**
 * Jina AI direct HTTP transport.
 *
 * Performs direct HTTP requests against Jina Reader (r.jina.ai) and Search (s.jina.ai).
 */

import pkg from "../../../package.json" with { type: "json" };
import { ApiError, AuthError, NetworkError, QuotaError, TimeoutError } from "../../lib/errors.js";
import type { ProviderQuotaFetchResponse } from "../types.js";

const { version: VERSION } = pkg;

const READER_BASE_URL = "https://r.jina.ai";
const SEARCH_BASE_URL = "https://s.jina.ai";
const DEFAULT_TIMEOUT_MS = 30000;

const USER_AGENT = `scoutline/${VERSION}`;
const TIMEOUT_HELP_TEXT = "Try again or increase timeout with JINA_TIMEOUT env var";

export interface JinaTransportDeps {
  readonly fetch?: (
    input: string,
    init: Record<string, unknown>,
  ) => Promise<ProviderQuotaFetchResponse>;
  readonly setTimeout?: typeof setTimeout;
  readonly clearTimeout?: typeof clearTimeout;
  readonly env?: NodeJS.ProcessEnv;
}

export interface JinaDataItem {
  readonly title?: string;
  readonly url?: string;
  readonly content?: string;
  readonly description?: string;
  readonly publishedTime?: string;
  readonly metadata?: unknown;
  readonly external?: unknown;
}

export interface JinaResponse {
  readonly code?: number;
  readonly data?: JinaDataItem | readonly JinaDataItem[];
}

function resolveTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = parseInt(env.JINA_TIMEOUT || String(DEFAULT_TIMEOUT_MS), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

/**
 * Classify a Jina HTTP error status into a typed Scoutline error.
 *
 * Runs BEFORE the success body is parsed; on a non-200 response the body
 * is drained for error-classification purposes (not echoed outward).
 *
 * Jina-specific mappings (8J.5):
 *   - 429 → terminal {@link QuotaError} (rate window exhausted; must NOT
 *     be retried by the shared retry classifier).
 *   - 403 → parse the structured error body. Jina documents insufficient
 *     balance / resource limit as 403, distinct from credential failures.
 *     If the body indicates insufficient balance → {@link QuotaError};
 *     otherwise → {@link AuthError} (invalid/missing credentials).
 *   - 401 → {@link AuthError}.
 *
 * The transport never embeds credential material or raw response bodies
 * in any error message.
 */
function mapStatusError(status: number, timeoutMs: number, errorBody?: string): Error {
  if (status === 401) {
    return new AuthError("Jina AI authentication failed", "JINA_API_KEY");
  }
  if (status === 403) {
    // Jina returns 403 for BOTH invalid credentials AND insufficient
    // balance/resource limits. Parse the structured error body to
    // distinguish: balance/limit indicators → QuotaError (terminal);
    // everything else → AuthError.
    const body = (errorBody ?? "").toLowerCase();
    if (
      body.includes("insufficient") ||
      body.includes("balance") ||
      body.includes("quota") ||
      body.includes("limit") ||
      body.includes("exhausted") ||
      body.includes("credit")
    ) {
      return new QuotaError(
        "Jina AI quota exhausted. Insufficient balance or resource limit.",
        "Check your Jina AI account balance and plan at jina.ai",
      );
    }
    return new AuthError("Jina AI authentication failed", "JINA_API_KEY");
  }
  if (status === 408 || status === 504) {
    return new TimeoutError(timeoutMs, TIMEOUT_HELP_TEXT);
  }
  if (status === 429) {
    return new QuotaError(
      "Jina AI rate limit exceeded.",
      "Try again later or upgrade your Jina AI plan for higher rate limits",
    );
  }
  if (status >= 400 && status < 500) {
    return new ApiError(`Jina AI API client error (${status})`, status);
  }
  if (status >= 500) {
    return new ApiError(`Jina AI API server error (${status})`, status);
  }
  return new ApiError(`Jina AI request failed (${status})`, status);
}

export async function fetchJinaReader(
  apiKey: string | undefined,
  targetUrl: string,
  deps: JinaTransportDeps = {},
): Promise<JinaDataItem> {
  const fetchFn = deps.fetch || globalThis.fetch;
  const setTimer = deps.setTimeout || globalThis.setTimeout;
  const clearTimer = deps.clearTimeout || globalThis.clearTimeout;
  const env = deps.env || process.env;
  const timeoutMs = resolveTimeoutMs(env);

  const endpoint = `${READER_BASE_URL}/${encodeURIComponent(targetUrl)}`;
  const headers: Record<string, string> = {
    "Accept": "application/json",
    "User-Agent": USER_AGENT,
  };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const controller = new AbortController();
  const timer = setTimer(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchFn(endpoint, {
      method: "GET",
      headers,
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      throw mapStatusError(response.status, timeoutMs, errorBody);
    }

    const text = await response.text();
    const json = JSON.parse(text) as JinaResponse;
    const data = json.data;

    if (Array.isArray(data)) {
      return data[0] || { url: targetUrl, content: "" };
    }
    if (data && typeof data === "object") {
      return data as JinaDataItem;
    }
    return { url: targetUrl, content: "" };
  } catch (err: unknown) {
    if (err instanceof AuthError || err instanceof ApiError || err instanceof QuotaError || err instanceof TimeoutError) {
      throw err;
    }
    if (err instanceof SyntaxError) {
      throw new ApiError("Jina AI returned a malformed JSON response", 500);
    }
    if (err instanceof Error && err.name === "AbortError") {
      throw new TimeoutError(timeoutMs, TIMEOUT_HELP_TEXT);
    }
    throw new NetworkError(
      `Jina AI request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimer(timer);
  }
}

export async function fetchJinaSearch(
  apiKey: string | undefined,
  query: string,
  deps: JinaTransportDeps = {},
): Promise<readonly JinaDataItem[]> {
  const fetchFn = deps.fetch || globalThis.fetch;
  const setTimer = deps.setTimeout || globalThis.setTimeout;
  const clearTimer = deps.clearTimeout || globalThis.clearTimeout;
  const env = deps.env || process.env;
  const timeoutMs = resolveTimeoutMs(env);

  const endpoint = `${SEARCH_BASE_URL}/${encodeURIComponent(query)}`;
  const headers: Record<string, string> = {
    "Accept": "application/json",
    "User-Agent": USER_AGENT,
  };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const controller = new AbortController();
  const timer = setTimer(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchFn(endpoint, {
      method: "GET",
      headers,
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      throw mapStatusError(response.status, timeoutMs, errorBody);
    }

    const text = await response.text();
    const json = JSON.parse(text) as JinaResponse;
    const data = json.data;

    if (Array.isArray(data)) {
      return data;
    }
    if (data && typeof data === "object") {
      return [data as JinaDataItem];
    }
    return [];
  } catch (err: unknown) {
    if (err instanceof AuthError || err instanceof ApiError || err instanceof QuotaError || err instanceof TimeoutError) {
      throw err;
    }
    if (err instanceof SyntaxError) {
      throw new ApiError("Jina AI returned a malformed JSON response", 500);
    }
    if (err instanceof Error && err.name === "AbortError") {
      throw new TimeoutError(timeoutMs, TIMEOUT_HELP_TEXT);
    }
    throw new NetworkError(
      `Jina AI request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimer(timer);
  }
}

// ---------------------------------------------------------------------------
// DeepSearch API — deepsearch.jina.ai (OpenAI-compatible chat completions)
// ---------------------------------------------------------------------------

const DEEPSEARCH_BASE_URL = "https://deepsearch.jina.ai";
const DEFAULT_DEEPSEARCH_TIMEOUT_MS = 120000;
const DEEPSEARCH_TIMEOUT_HELP_TEXT =
  "Try again or increase timeout with JINA_DEEPSEARCH_TIMEOUT env var";

export interface JinaDeepSearchUrlCitation {
  readonly title?: string;
  readonly url: string;
  readonly exactQuote?: string;
}

export interface JinaDeepSearchAnnotation {
  readonly url_citation?: JinaDeepSearchUrlCitation;
}

export interface JinaDeepSearchResponse {
  readonly choices?: readonly {
    readonly message?: {
      readonly content?: string;
      readonly annotations?: readonly JinaDeepSearchAnnotation[];
    };
  }[];
  readonly visitedURLs?: readonly string[];
}

function resolveDeepSearchTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = parseInt(env.JINA_DEEPSEARCH_TIMEOUT || String(DEFAULT_DEEPSEARCH_TIMEOUT_MS), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DEEPSEARCH_TIMEOUT_MS;
}

export async function fetchJinaDeepSearch(
  apiKey: string | undefined,
  query: string,
  deps: JinaTransportDeps = {},
  externalSignal?: AbortSignal,
): Promise<JinaDeepSearchResponse> {
  const fetchFn = deps.fetch || globalThis.fetch;
  const setTimer = deps.setTimeout || globalThis.setTimeout;
  const clearTimer = deps.clearTimeout || globalThis.clearTimeout;
  const env = deps.env || process.env;
  const timeoutMs = resolveDeepSearchTimeoutMs(env);

  const url = `${DEEPSEARCH_BASE_URL}/v1/chat/completions`;
  const body = {
    model: "jina-deepsearch-v1",
    messages: [{ role: "user", content: query }],
    stream: false,
    reasoning_effort: "medium",
    max_returned_urls: 10,
  };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": USER_AGENT,
  };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const controller = new AbortController();
  // Honour external cancellation (e.g., research AbortSignal)
  const onExternalAbort = (): void => controller.abort();
  if (externalSignal?.aborted) controller.abort();
  externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
  const timer = setTimer(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchFn(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      throw mapStatusError(response.status, timeoutMs, errorBody);
    }

    const text = await response.text();
    return JSON.parse(text) as JinaDeepSearchResponse;
  } catch (err: unknown) {
    if (err instanceof AuthError || err instanceof ApiError || err instanceof QuotaError || err instanceof TimeoutError) {
      throw err;
    }
    if (err instanceof SyntaxError) {
      throw new ApiError("Jina AI returned a malformed JSON response", 500);
    }
    if (err instanceof Error && err.name === "AbortError") {
      throw new TimeoutError(timeoutMs, DEEPSEARCH_TIMEOUT_HELP_TEXT);
    }
    throw new NetworkError(
      `Jina AI DeepSearch failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    externalSignal?.removeEventListener("abort", onExternalAbort);
    clearTimer(timer);
  }
}
