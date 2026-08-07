/**
 * Jina AI direct HTTP transport.
 *
 * Performs direct HTTP requests against Jina Reader (r.jina.ai) and Search (s.jina.ai).
 */

import { createRequire } from "node:module";
import { ApiError, AuthError, NetworkError, TimeoutError } from "../../lib/errors.js";
import type { ProviderQuotaFetchResponse } from "../types.js";

const require = createRequire(import.meta.url);
const { version: VERSION } = require("../../../package.json") as { version: string };

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

function mapStatusError(status: number, timeoutMs: number): Error {
  if (status === 401 || status === 403) {
    return new AuthError("Jina AI authentication failed", "JINA_API_KEY");
  }
  if (status === 408 || status === 504) {
    return new TimeoutError(timeoutMs, TIMEOUT_HELP_TEXT);
  }
  if (status === 429) {
    return new ApiError("Jina AI rate limit exceeded", 429);
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
      throw mapStatusError(response.status, timeoutMs);
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
    if (err instanceof AuthError || err instanceof ApiError || err instanceof TimeoutError) {
      throw err;
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
      throw mapStatusError(response.status, timeoutMs);
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
    if (err instanceof AuthError || err instanceof ApiError || err instanceof TimeoutError) {
      throw err;
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
  const timer = setTimer(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchFn(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw mapStatusError(response.status, timeoutMs);
    }

    const text = await response.text();
    return JSON.parse(text) as JinaDeepSearchResponse;
  } catch (err: unknown) {
    if (err instanceof AuthError || err instanceof ApiError || err instanceof TimeoutError) {
      throw err;
    }
    if (err instanceof Error && err.name === "AbortError") {
      throw new TimeoutError(timeoutMs, TIMEOUT_HELP_TEXT);
    }
    throw new NetworkError(
      `Jina AI DeepSearch failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimer(timer);
  }
}
