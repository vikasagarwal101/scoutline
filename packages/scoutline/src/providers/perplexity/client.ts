/**
 * Perplexity direct HTTP transport.
 *
 * Two endpoints:
 *   - POST /search — dedicated Search API (ranked results with snippets + dates)
 *   - POST /chat/completions — Sonar chat completions (research via sonar-deep-research)
 */

import pkg from "../../../package.json" with { type: "json" };
import { ApiError, AuthError, NetworkError, TimeoutError } from "../../lib/errors.js";
import type { ProviderQuotaFetchResponse } from "../types.js";

const { version: VERSION } = pkg;

const BASE_URL = "https://api.perplexity.ai";
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_DEEPSEARCH_TIMEOUT_MS = 300000;

const USER_AGENT = `scoutline/${VERSION}`;
const TIMEOUT_HELP_TEXT = "Try again or increase timeout with PERPLEXITY_TIMEOUT env var";
const RESEARCH_TIMEOUT_HELP_TEXT =
  "Try again or increase timeout with PERPLEXITY_RESEARCH_TIMEOUT env var";

export interface PerplexityTransportDeps {
  readonly fetch?: (
    input: string,
    init: Record<string, unknown>,
  ) => Promise<ProviderQuotaFetchResponse>;
  readonly setTimeout?: typeof setTimeout;
  readonly clearTimeout?: typeof clearTimeout;
  readonly env?: NodeJS.ProcessEnv;
}

// ---------------------------------------------------------------------------
// Search API types — POST /search
// ---------------------------------------------------------------------------

export interface PerplexitySearchResultItem {
  readonly title?: string;
  readonly url?: string;
  readonly snippet?: string;
  readonly date?: string | null;
  readonly last_updated?: string | null;
}

export interface PerplexitySearchResponse {
  readonly id?: string;
  readonly results?: readonly PerplexitySearchResultItem[];
  readonly server_time?: string | null;
}

export interface PerplexitySearchParams {
  readonly max_results?: number;
  readonly search_context_size?: "low" | "medium" | "high";
  readonly search_domain_filter?: readonly string[];
  readonly search_recency_filter?: "hour" | "day" | "week" | "month" | "year";
}

// ---------------------------------------------------------------------------
// Sonar Chat Completions types — POST /chat/completions
// ---------------------------------------------------------------------------

export interface PerplexitySearchResultEntry {
  readonly title?: string;
  readonly url?: string;
  readonly date?: string | null;
  readonly last_updated?: string | null;
  readonly snippet?: string;
  readonly source?: string;
}

export interface PerplexityChoice {
  readonly message?: {
    readonly role?: string;
    readonly content?: string;
  };
}

export interface PerplexityChatResponse {
  readonly id?: string;
  readonly model?: string;
  readonly choices?: readonly PerplexityChoice[];
  readonly citations?: readonly string[];
  readonly search_results?: readonly PerplexitySearchResultEntry[];
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function resolveTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = parseInt(env.PERPLEXITY_TIMEOUT || String(DEFAULT_TIMEOUT_MS), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

function resolveResearchTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = parseInt(env.PERPLEXITY_RESEARCH_TIMEOUT || String(DEFAULT_DEEPSEARCH_TIMEOUT_MS), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DEEPSEARCH_TIMEOUT_MS;
}

function mapStatusError(status: number, timeoutMs: number, timeoutHelp: string = TIMEOUT_HELP_TEXT): Error {
  if (status === 401 || status === 403) {
    return new AuthError("Perplexity authentication failed", "PERPLEXITY_API_KEY");
  }
  if (status === 408 || status === 504) {
    return new TimeoutError(timeoutMs, timeoutHelp);
  }
  if (status === 429) {
    return new ApiError("Perplexity rate limit exceeded", 429);
  }
  if (status >= 400 && status < 500) {
    return new ApiError(`Perplexity API client error (${status})`, status);
  }
  if (status >= 500) {
    return new ApiError(`Perplexity API server error (${status})`, status);
  }
  return new ApiError(`Perplexity request failed (${status})`, status);
}

// ---------------------------------------------------------------------------
// Search API — POST /search
// ---------------------------------------------------------------------------

export async function fetchPerplexitySearch(
  apiKey: string,
  query: string,
  params: PerplexitySearchParams = {},
  deps: PerplexityTransportDeps = {},
): Promise<PerplexitySearchResponse> {
  const fetchFn = deps.fetch || globalThis.fetch;
  const setTimer = deps.setTimeout || globalThis.setTimeout;
  const clearTimer = deps.clearTimeout || globalThis.clearTimeout;
  const env = deps.env || process.env;
  const timeoutMs = resolveTimeoutMs(env);

  const url = `${BASE_URL}/search`;
  const body: Record<string, unknown> = { query };
  if (params.max_results !== undefined) body.max_results = params.max_results;
  if (params.search_context_size !== undefined) body.search_context_size = params.search_context_size;
  if (params.search_domain_filter) body.search_domain_filter = params.search_domain_filter;
  if (params.search_recency_filter) body.search_recency_filter = params.search_recency_filter;

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
    return JSON.parse(text) as PerplexitySearchResponse;
  } catch (err: unknown) {
    if (err instanceof AuthError || err instanceof ApiError || err instanceof TimeoutError) {
      throw err;
    }
    if (err instanceof SyntaxError) {
      throw new ApiError("Perplexity returned a malformed JSON response", 500);
    }
    if (err instanceof Error && err.name === "AbortError") {
      throw new TimeoutError(timeoutMs, TIMEOUT_HELP_TEXT);
    }
    throw new NetworkError(
      `Perplexity search failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimer(timer);
  }
}

// ---------------------------------------------------------------------------
// Sonar Chat Completions — POST /chat/completions
// ---------------------------------------------------------------------------

export async function fetchPerplexityChat(
  apiKey: string,
  prompt: string,
  model: string = "sonar",
  deps: PerplexityTransportDeps = {},
  externalSignal?: AbortSignal,
): Promise<PerplexityChatResponse> {
  const fetchFn = deps.fetch || globalThis.fetch;
  const setTimer = deps.setTimeout || globalThis.setTimeout;
  const clearTimer = deps.clearTimeout || globalThis.clearTimeout;
  const env = deps.env || process.env;
  const isResearch = model.includes("deep-research");
  const timeoutMs = isResearch ? resolveResearchTimeoutMs(env) : resolveTimeoutMs(env);

  const url = `${BASE_URL}/chat/completions`;
  const body = {
    model,
    messages: [
      {
        role: "user",
        content: prompt,
      },
    ],
  };

  const controller = new AbortController();
  // Honour external cancellation (e.g., research AbortSignal)
  const onExternalAbort = (): void => controller.abort();
  if (externalSignal?.aborted) controller.abort();
  externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
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
      throw mapStatusError(
        response.status,
        timeoutMs,
        isResearch ? RESEARCH_TIMEOUT_HELP_TEXT : TIMEOUT_HELP_TEXT,
      );
    }

    const text = await response.text();
    return JSON.parse(text) as PerplexityChatResponse;
  } catch (err: unknown) {
    if (err instanceof AuthError || err instanceof ApiError || err instanceof TimeoutError) {
      throw err;
    }
    if (err instanceof SyntaxError) {
      throw new ApiError("Perplexity returned a malformed JSON response", 500);
    }
    if (err instanceof Error && err.name === "AbortError") {
      throw new TimeoutError(
        timeoutMs,
        isResearch ? RESEARCH_TIMEOUT_HELP_TEXT : TIMEOUT_HELP_TEXT,
      );
    }
    throw new NetworkError(
      `Perplexity request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    externalSignal?.removeEventListener("abort", onExternalAbort);
    clearTimer(timer);
  }
}
