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

/**
 * Jina transport response — extends the base provider fetch response with
 * optional response headers. Production `fetch` returns a `Response` that
 * always has `headers`; test fakes may omit them (optional), and the
 * transport harvests headers defensively (skips when absent).
 *
 * Defined as a Jina-local type (not added to the shared
 * {@link ProviderQuotaFetchResponse}) because the base type has a CRITICAL
 * upstream blast radius (56 symbols across every provider).
 */
export interface JinaFetchResponse extends ProviderQuotaFetchResponse {
  readonly headers?: { get(name: string): string | null };
}

export interface JinaTransportDeps {
  readonly fetch?: (
    input: string,
    init: Record<string, unknown>,
  ) => Promise<JinaFetchResponse>;
  readonly setTimeout?: typeof setTimeout;
  readonly clearTimeout?: typeof clearTimeout;
  readonly env?: NodeJS.ProcessEnv;
}

export interface JinaDataItem {
  readonly title?: string;
  readonly url?: string;
  readonly content?: string;
  /**
   * Text-mode response field (8J.2). When `X-Return-Format: text` is
   * requested, Jina places the page content in `data.text` instead of
   * `data.content`. Declared so the adapter can decode text-mode responses
   * without normalizing valid text as empty.
   */
  readonly text?: string;
  readonly description?: string;
  readonly publishedTime?: string;
  readonly metadata?: unknown;
  readonly external?: unknown;
  /**
   * Token usage for this result item, as returned in the response body.
   * Visible in captured fixtures: Reader returns a single top-level
   * `usage.tokens`, Search returns per-result `usage.tokens`. Declared
   * so callers can access it; the quota capability uses response headers
   * (`X-RateLimit-Remaining-*`) rather than body usage for its probe.
   */
  readonly usage?: { readonly tokens?: number };
}

export interface JinaResponse {
  readonly code?: number;
  readonly data?: JinaDataItem | readonly JinaDataItem[];
}

/**
 * Normalized Reader options forwarded to Jina's documented headers (8J.2).
 * Each maps to a Jina Reader request header (see
 * https://github.com/jina-ai/reader/blob/main/src/dto/crawler-options.ts):
 *
 *   format         -> X-Return-Format ("markdown" | "text")
 *   retainImages   -> X-Retain-Images ("true" | "false")
 *   withLinksSummary -> X-With-Links-Summary ("true" | "false")
 *   noGfm          -> not forwarded (Jina has no GFM toggle; no-op)
 *   keepImgDataUrl -> X-Keep-Img-Data-Url ("true" | "false")
 *   withImagesSummary -> X-With-Images-Summary ("true" | "false")
 *   timeout        -> X-Timeout (seconds; clamped to Jina's 180s ceiling)
 */
export interface JinaReaderOptions {
  readonly format?: "markdown" | "text";
  readonly retainImages?: boolean;
  readonly withLinksSummary?: boolean;
  readonly noGfm?: boolean;
  readonly keepImgDataUrl?: boolean;
  readonly withImagesSummary?: boolean;
  readonly timeout?: number;
}

/**
 * Read the error response body for classification purposes. Preserves
 * AbortError so a timeout during body read still surfaces as
 * TimeoutError (not a status-derived error). Non-abort read failures
 * fall back to an empty string so classification proceeds normally.
 */
async function readErrorBody(response: { text(): Promise<string> }): Promise<string> {
  try {
    return await response.text();
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw err;
    return "";
  }
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
function mapStatusError(status: number, timeoutMs: number, errorBody?: string, timeoutHelpText: string = TIMEOUT_HELP_TEXT): Error {
  if (status === 401) {
    return new AuthError("Jina AI authentication failed", "JINA_API_KEY");
  }
  if (status === 403) {
    // Jina returns 403 for BOTH invalid credentials AND insufficient
    // balance/resource limits. Parse the structured error body to
    // distinguish: balance indicators → QuotaError (terminal);
    // everything else → AuthError.
    //
    // Keywords are intentionally NARROW: "insufficient" alone would match
    // "insufficient permissions" (an auth issue), and "limit" alone would
    // match "rate limit" or "permission limit". Only balance/billing-
    // specific terms qualify.
    const body = (errorBody ?? "").toLowerCase();
    if (
      body.includes("balance") ||
      body.includes("quota") ||
      body.includes("exhausted") ||
      body.includes("credit") ||
      body.includes("billing")
    ) {
      return new QuotaError(
        "Jina AI quota exhausted. Insufficient balance or resource limit.",
        "Check your Jina AI account balance and plan at jina.ai",
      );
    }
    return new AuthError("Jina AI authentication failed", "JINA_API_KEY");
  }
  if (status === 408 || status === 504 || status === 524) {
    // 524 is Cloudflare's origin-timeout, the specific status Jina warns
    // about for non-streaming DeepSearch (8J.6). Classified as a timeout
    // rather than a generic API failure.
    return new TimeoutError(timeoutMs, timeoutHelpText);
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
  options?: JinaReaderOptions,
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

  // Forward normalized Reader options to Jina's documented headers (8J.2).
  // noGfm is intentionally NOT forwarded: Jina Reader has no GFM toggle
  // header, so the option has no faithful mapping and is a no-op.
  if (options) {
    if (options.format) {
      headers["X-Return-Format"] = options.format;
    }
    if (options.retainImages !== undefined) {
      headers["X-Retain-Images"] = options.retainImages ? "true" : "false";
    }
    if (options.withLinksSummary !== undefined) {
      headers["X-With-Links-Summary"] = options.withLinksSummary ? "true" : "false";
    }
    if (options.keepImgDataUrl !== undefined) {
      headers["X-Keep-Img-Data-Url"] = options.keepImgDataUrl ? "true" : "false";
    }
    if (options.withImagesSummary !== undefined) {
      headers["X-With-Images-Summary"] = options.withImagesSummary ? "true" : "false";
    }
    if (options.timeout !== undefined) {
      // ReaderFetchRequest.timeout is in seconds (see commands/read.ts
      // --timeout <s>). Jina's X-Timeout is also seconds with a 180s
      // ceiling. Forward directly — no unit conversion needed.
      headers["X-Timeout"] = String(Math.min(options.timeout, 180));
    }
  }

  // If the caller specified a server-side timeout, ensure the client-side
  // AbortController waits at least that long (plus a 5s network buffer)
  // so we don't abort before the server can deliver its response.
  const clientTimeoutMs = options?.timeout !== undefined
    ? Math.max(timeoutMs, options.timeout * 1000 + 5000)
    : timeoutMs;

  const controller = new AbortController();
  const timer = setTimer(() => controller.abort(), clientTimeoutMs);

  try {
    const response = await fetchFn(endpoint, {
      method: "GET",
      headers,
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorBody = await readErrorBody(response);
      throw mapStatusError(response.status, clientTimeoutMs, errorBody);
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
      throw new TimeoutError(clientTimeoutMs, TIMEOUT_HELP_TEXT);
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
  options?: {
    /**
     * Domain restriction forwarded as Jina's `X-Site` header (8J.3).
     * Accepts a bare hostname like "example.com".
     */
    readonly domain?: string;
    /**
     * Two-letter ISO country code for result localization (8J.3).
     * Sent as the `gl` field in a POST JSON body.
     */
    readonly location?: string;
  },
): Promise<readonly JinaDataItem[]> {
  const fetchFn = deps.fetch || globalThis.fetch;
  const setTimer = deps.setTimeout || globalThis.setTimeout;
  const clearTimer = deps.clearTimeout || globalThis.clearTimeout;
  const env = deps.env || process.env;
  const timeoutMs = resolveTimeoutMs(env);

  const headers: Record<string, string> = {
    "Accept": "application/json",
    "User-Agent": USER_AGENT,
  };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }
  // Forward domain restriction via Jina's documented X-Site header (8J.3).
  if (options?.domain) {
    headers["X-Site"] = options.domain;
  }

  const controller = new AbortController();
  const timer = setTimer(() => controller.abort(), timeoutMs);

  // When location is specified, use POST JSON (Jina documents gl as a
  // POST body field). Without location, GET path form remains the
  // simplest transport (8J.3).
  const usePost = options?.location !== undefined;
  const endpoint = usePost
    ? SEARCH_BASE_URL
    : `${SEARCH_BASE_URL}/${encodeURIComponent(query)}`;

  const init: Record<string, unknown> = {
    method: usePost ? "POST" : "GET",
    headers,
    signal: controller.signal,
  };
  if (usePost) {
    headers["Content-Type"] = "application/json";
    const body: Record<string, unknown> = { q: query };
    if (options?.location) {
      body.gl = options.location;
    }
    init.body = JSON.stringify(body);
  }

  try {
    const response = await fetchFn(endpoint, init);

    if (!response.ok) {
      const errorBody = await readErrorBody(response);
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
  readonly type?: string;
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

/**
 * Shape of a single SSE chunk from DeepSearch streaming (OpenAI-compatible
 * chat.completion.chunk). The `delta.type` field distinguishes reasoning
 * steps ("think") from the final answer ("text"):
 *
 *   delta.type === "think" — reasoning/search steps (internal, NOT the answer)
 *   delta.type === "text"  — the final answer content (accumulate this)
 *
 * The terminal chunk carries `finish_reason: "stop"`, `delta.annotations`
 * (citations), and top-level `visitedURLs`. There is no `data: [DONE]`
 * sentinel — the stream ends after the terminal chunk.
 *
 * Verified against Jina's live DeepSearch API and docs (jina.ai/deepsearch),
 * which explicitly recommends streaming: "We strongly recommend keeping
 * this option enabled since DeepSearch requests can take significant time
 * to complete. Disabling streaming may result in '524 timeout' errors."
 */
interface DeepSearchStreamChunk {
  readonly choices?: readonly {
    readonly delta?: {
      readonly content?: string;
      readonly type?: string;
      readonly annotations?: readonly JinaDeepSearchAnnotation[];
    };
    readonly finish_reason?: string | null;
  }[];
  readonly visitedURLs?: readonly string[];
}

/**
 * Parse a DeepSearch SSE response body into the same
 * {@link JinaDeepSearchResponse} shape the non-streaming path produced.
 *
 * Accumulates `delta.content` ONLY from chunks whose `delta.type` is
 * `"text"` (the final answer) or absent (defensive standard-OpenAI
 * fallback). Skips `"think"` chunks (reasoning/search steps) and any
 * unknown future types. Citations arrive as `delta.annotations` on the
 * terminal chunk; `visitedURLs` at top level.
 *
 * Fails closed: if the stream ends without a terminal event
 * (`finish_reason: "stop"` or `[DONE]`), throws rather than returning a
 * potentially incomplete report. Malformed data payloads are treated as
 * API errors rather than silently dropped.
 */
function parseDeepSearchSSE(text: string): JinaDeepSearchResponse {
  let content = "";
  let annotations: JinaDeepSearchAnnotation[] = [];
  const seenCitationUrls = new Set<string>();
  const visitedUrlSet = new Set<string>();
  let sawTerminal = false;

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;

    const payload = trimmed.slice("data:".length).trim();
    if (payload === "") continue;
    if (payload === "[DONE]") {
      sawTerminal = true;
      break;
    }

    let chunk: DeepSearchStreamChunk;
    try {
      const parsed: unknown = JSON.parse(payload);
      // Validate structural shape — not just JSON syntax. Reject any
      // non-object value (null, arrays, numbers, strings) as malformed.
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new ApiError("Jina AI returned a malformed SSE response", 502);
      }
      chunk = parsed as DeepSearchStreamChunk;
    } catch (err) {
      if (err instanceof ApiError) throw err;
      // JSON syntax error — indicates response corruption. Fail
      // rather than silently dropping answer text or citations.
      throw new ApiError("Jina AI returned a malformed SSE response", 502);
    }

    // Track terminal event (finish_reason: "stop").
    if (chunk.choices?.[0]?.finish_reason === "stop") {
      sawTerminal = true;
    }

    const delta = chunk.choices?.[0]?.delta;
    if (!delta) continue;

    // Only accumulate answer content from "text" chunks (or standard
    // OpenAI chunks with no type field). Excludes "think" (reasoning)
    // and any unknown future delta types from the report.
    if (delta.content && (delta.type === "text" || delta.type === undefined)) {
      content += delta.content;
    }

    // Annotations (citations) arrive on the terminal chunk. Validate the
    // annotation shape recursively (#53): an entry that is not an object,
    // or whose url_citation is present but not an object carrying a
    // string url, is malformed SSE payload — fail closed with ApiError
    // 502 instead of silently dropping or retaining the entry. Entries
    // without a url_citation are non-citation annotations and are
    // skipped. Well-formed citations are de-duplicated by URL.
    if (Array.isArray(delta.annotations) && delta.annotations.length > 0) {
      for (const ann of delta.annotations) {
        if (typeof ann !== "object" || ann === null || Array.isArray(ann)) {
          throw new ApiError("Jina AI returned a malformed SSE response", 502);
        }
        const citation = ann.url_citation;
        if (citation === undefined) continue;
        if (
          typeof citation !== "object" ||
          citation === null ||
          Array.isArray(citation) ||
          typeof citation.url !== "string"
        ) {
          throw new ApiError("Jina AI returned a malformed SSE response", 502);
        }
        if (seenCitationUrls.has(citation.url)) continue;
        seenCitationUrls.add(citation.url);
        annotations.push(ann);
      }
    }

    // visitedURLs arrive on the terminal chunk at the top level. De-duplicate
    // to avoid repeated URLs if sent across multiple chunks.
    if (Array.isArray(chunk.visitedURLs) && chunk.visitedURLs.length > 0) {
      for (const url of chunk.visitedURLs) {
        if (typeof url === "string") visitedUrlSet.add(url);
      }
    }
  }

  // Fail closed: a stream that ended without a terminal event indicates
  // a truncated response (network issue, server crash). Returning the
  // partial content would silently give the user an incomplete report.
  if (!sawTerminal) {
    throw new ApiError("Jina AI DeepSearch stream ended without completion", 502);
  }

  return {
    choices: [
      {
        message: {
          content,
          ...(annotations.length > 0 ? { annotations } : {}),
        },
      },
    ],
    ...(visitedUrlSet.size > 0 ? { visitedURLs: [...visitedUrlSet] } : {}),
  };
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
  options?: {
    /**
     * Domain restriction forwarded as DeepSearch's `only_hostnames`
     * array (8J.4). Accepts a bare hostname like "example.com".
     */
    readonly domain?: string;
  },
): Promise<JinaDeepSearchResponse> {
  const fetchFn = deps.fetch || globalThis.fetch;
  const setTimer = deps.setTimeout || globalThis.setTimeout;
  const clearTimer = deps.clearTimeout || globalThis.clearTimeout;
  const env = deps.env || process.env;
  const timeoutMs = resolveDeepSearchTimeoutMs(env);

  const url = `${DEEPSEARCH_BASE_URL}/v1/chat/completions`;
  const body: Record<string, unknown> = {
    model: "jina-deepsearch-v1",
    messages: [{ role: "user", content: query }],
    // Streaming is strongly recommended by Jina: non-streaming DeepSearch
    // can hit gateway HTTP 524 on long research runs because the origin
    // sends no data while processing (8J.6). With stream: true, the server
    // emits SSE events (reasoning steps + final answer) incrementally,
    // keeping the gateway alive. We read the full body via text() and parse
    // the SSE — the 524 prevention comes from the server actively sending
    // data, not from how the client reads it.
    stream: true,
    reasoning_effort: "medium",
    max_returned_urls: 10,
  };
  // Forward domain restriction via DeepSearch's only_hostnames (8J.4).
  if (options?.domain) {
    body.only_hostnames = [options.domain];
  }

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
      const errorBody = await readErrorBody(response);
      throw mapStatusError(response.status, timeoutMs, errorBody, DEEPSEARCH_TIMEOUT_HELP_TEXT);
    }

    const text = await response.text();
    // Parse the SSE stream into the same JinaDeepSearchResponse shape
    // the non-streaming path produced (8J.6).
    return parseDeepSearchSSE(text);
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

// ---------------------------------------------------------------------------
// Rate-limit header harvesting (8J.5 telemetry)
// ---------------------------------------------------------------------------

/**
 * Jina's rate-limit response headers, as documented in the OpenAPI schema
 * (api.jina.ai/openapi.json):
 *
 *   "Rate limit headers are included in responses:
 *    `X-RateLimit-Remaining-Requests`, `X-RateLimit-Remaining-Tokens`."
 *
 * **Header-name correction (lesson 0.14.8):** finding 8J.5 originally
 * claimed `x-ratelimit-limit`, `x-ratelimit-remaining`, and `x-usage-tokens`.
 * The OpenAPI schema contradicts this — the actual headers are
 * `X-RateLimit-Remaining-Requests` and `X-RateLimit-Remaining-Tokens`.
 * No `X-RateLimit-Limit` or reset header is exposed.
 *
 * The documented rate-limit tiers (per OpenAPI schema):
 *   Free:   500 RPM,   1M TPM,   5 concurrency
 *   Tier 1: 500 RPM,  10M TPM,  50 concurrency
 *   Tier 2: 5,000 RPM, 100M TPM, 500 concurrency
 */
export interface JinaRateLimitHeaders {
  /** Remaining requests in the current per-minute window (null if absent). */
  readonly remainingRequests: number | null;
  /** Remaining tokens in the current per-minute window (null if absent). */
  readonly remainingTokens: number | null;
}

/**
 * Read Jina's rate-limit headers from a fetch response. Returns null for
 * each header when absent or non-numeric. HTTP header names are
 * case-insensitive, so `headers.get("x-ratelimit-remaining-requests")`
 * matches `X-RateLimit-Remaining-Requests`.
 */
function readRateLimitHeaders(
  headers: { get(name: string): string | null } | undefined,
): JinaRateLimitHeaders {
  if (!headers) return { remainingRequests: null, remainingTokens: null };
  const h = headers; // non-undefined capture for closure

  function readNumber(name: string): number | null {
    const raw = h.get(name);
    if (raw === null || raw === "") return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }

  return {
    remainingRequests: readNumber("x-ratelimit-remaining-requests"),
    remainingTokens: readNumber("x-ratelimit-remaining-tokens"),
  };
}

/**
 * Perform a lightweight Search probe against `s.jina.ai` and return the
 * rate-limit response headers. The probe sends a minimal query (costs
 * exactly ONE request and ~10k fixed tokens) and drains the body — only
 * the headers are needed.
 *
 * Mirrors Brave's `fetchBraveRateLimit` pattern: one direct probe, read
 * headers, drain body, normalize outside. Requires `JINA_API_KEY` (Search
 * is not keyless — 8J.1).
 */
export async function fetchJinaRateLimit(
  apiKey: string,
  deps: JinaTransportDeps = {},
): Promise<JinaRateLimitHeaders> {
  const fetchFn = deps.fetch || globalThis.fetch;
  const setTimer = deps.setTimeout || globalThis.setTimeout;
  const clearTimer = deps.clearTimeout || globalThis.clearTimeout;
  const env = deps.env || process.env;
  const timeoutMs = resolveTimeoutMs(env);

  const endpoint = `${SEARCH_BASE_URL}/${encodeURIComponent("scoutline-quota-probe")}`;
  const headers: Record<string, string> = {
    "Accept": "application/json",
    "User-Agent": USER_AGENT,
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };

  const controller = new AbortController();
  const timer = setTimer(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchFn(endpoint, {
      method: "GET",
      headers,
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorBody = await readErrorBody(response);
      throw mapStatusError(response.status, timeoutMs, errorBody);
    }

    // Drain the body to free the socket — only headers are needed.
    await response.text().catch(() => {});
    return readRateLimitHeaders(response.headers);
  } catch (err: unknown) {
    if (err instanceof AuthError || err instanceof ApiError || err instanceof QuotaError || err instanceof TimeoutError) {
      throw err;
    }
    if (err instanceof Error && err.name === "AbortError") {
      throw new TimeoutError(timeoutMs, TIMEOUT_HELP_TEXT);
    }
    throw new NetworkError(
      `Jina AI rate-limit probe failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimer(timer);
  }
}
