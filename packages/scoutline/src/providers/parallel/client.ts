/**
 * Parallel AI direct HTTP transport.
 *
 * Performs direct HTTP requests against Parallel AI API endpoints.
 */

import pkg from "../../../package.json" with { type: "json" };
import { ApiError, AuthError, NetworkError, QuotaError, TimeoutError, ValidationError } from "../../lib/errors.js";
import type { ProviderQuotaFetchResponse } from "../types.js";

const { version: VERSION } = pkg;

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
  /**
   * Advanced search settings forwarded to Parallel's API
   * (8P.3 — control acceptance). Contains source_policy, location,
   * and excerpt_settings mapped from provider-neutral SearchControls.
   */
  readonly advanced_settings?: {
    readonly source_policy?: {
      readonly include_domains?: readonly string[];
      readonly after_date?: string;
    };
    readonly location?: string;
    readonly excerpt_settings?: {
      readonly max_chars_per_result?: number;
    };
  };
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
  if (status === 402) {
    return new QuotaError(
      "Parallel AI quota exhausted. Insufficient account credit.",
      "Check your Parallel AI account credit at parallel.ai",
    );
  }
  if (status === 408 || status === 504) {
    return new TimeoutError(timeoutMs, TIMEOUT_HELP_TEXT);
  }
  if (status === 422) {
    return new ValidationError("Parallel AI request validation failed");
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
  externalSignal?: AbortSignal,
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
  if (params.advanced_settings) {
    body.advanced_settings = params.advanced_settings;
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
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
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
    if (err instanceof AuthError || err instanceof ApiError || err instanceof QuotaError || err instanceof TimeoutError || err instanceof ValidationError) {
      throw err;
    }
    if (err instanceof SyntaxError) {
      throw new ApiError("Parallel AI returned a malformed JSON response", 500);
    }
    if (err instanceof Error && err.name === "AbortError") {
      throw new TimeoutError(timeoutMs, TIMEOUT_HELP_TEXT);
    }
    throw new NetworkError(
      `Parallel AI request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    externalSignal?.removeEventListener("abort", onExternalAbort);
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
  // Request guaranteed full-page content (8P.2). Without
  // `advanced_settings.full_content`, Parallel returns bounded excerpts
  // by default, which the adapter would then present as the complete page.
  const body = {
    urls: [targetUrl],
    advanced_settings: { full_content: true },
  };

  const controller = new AbortController();
  const timer = setTimer(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchFn(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
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
    if (err instanceof AuthError || err instanceof ApiError || err instanceof QuotaError || err instanceof TimeoutError || err instanceof ValidationError) {
      throw err;
    }
    if (err instanceof SyntaxError) {
      throw new ApiError("Parallel AI returned a malformed JSON response", 500);
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

// ---------------------------------------------------------------------------
// Task API — /v1/tasks/runs (Deep Research) (8P.1)
// ---------------------------------------------------------------------------
//
// Deep Research is Parallel's asynchronous research product. It performs
// multi-step exploration, synthesis, inline citations, and verification.
// The lifecycle is:
//
//   1. POST /v1/tasks/runs  → 202 { run_id, status: "queued" }
//   2. GET  /v1/tasks/runs/{run_id}/result?timeout=N  (long-poll)
//      → 200 { run: { status, processor }, output: { content, basis } }
//      → 408 (run still active — re-poll)
//      → 404 (run failed or run_id not found)
//
// `output.content` is a markdown report string (text schema).
// `output.basis` is an array of FieldBasis objects, each carrying a
// `citations` array of { url, title?, excerpts? }. The adapter flattens
// and deduplicates these into ResearchSource[].

/**
 * Provider-native Task API request fields (Parallel field names). The
 * Adapter maps the provider-neutral `ResearchRequest` into these before
 * calling {@link createParallelTaskRun}.
 */
export interface ParallelTaskParams {
  /** Processor tier: pro, ultra, pro-fast, ultra-fast. */
  readonly processor: string;
  /** Restrict research to specific domains. */
  readonly source_policy?: {
    readonly include_domains?: readonly string[];
    readonly exclude_domains?: readonly string[];
    readonly after_date?: string;
  };
  /** Geo-targeted search results (ISO 3166-1 alpha-2). */
  readonly advanced_settings?: {
    readonly location?: string;
  };
  /** Output schema — text mode produces a markdown report. */
  readonly task_spec?: {
    readonly output_schema: {
      readonly type: "text";
      readonly description?: string;
    };
  };
}

/** Structured result of POST /v1/tasks/runs (HTTP 202). */
export interface ParallelTaskRunCreateResult {
  readonly runId: string;
  readonly status: string;
}

/** A single citation from the research basis. */
export interface ParallelTaskCitation {
  readonly title?: string;
  readonly url: string;
  readonly excerpts?: readonly string[];
}

/**
 * Structured result of GET /v1/tasks/runs/{run_id}/result. `status:
 * "running"` covers both the explicit 408 (server long-poll timed out)
 * and a 200 whose `run.status` is not yet terminal. `status:
 * "not_found"` covers HTTP 404 (run failed or run_id expired).
 */
export interface ParallelTaskRunResult {
  readonly status: "completed" | "running" | "failed" | "not_found";
  readonly content?: string;
  readonly citations?: readonly ParallelTaskCitation[];
  readonly processor?: string;
  readonly errorMessage?: string;
}

/**
 * Server-side long-poll window (seconds) for GET /result. The server
 * blocks up to this many seconds before returning 408 (still active).
 * 60 seconds balances responsiveness (a completed run returns ASAP) with
 * HTTP overhead (one request per minute while waiting, not per second).
 */
const RESULT_POLL_SERVER_TIMEOUT_S = 60;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Perform ONE POST against the Parallel /v1/tasks/runs endpoint to start
 * a Deep Research task run. No retry — a transient POST failure is
 * terminal (the user re-runs); retrying risks a double-charge if the
 * POST succeeded server-side but the response was lost. Returns the
 * structured create result `{ runId, status }`.
 */
export async function createParallelTaskRun(
  apiKey: string,
  input: string,
  params: ParallelTaskParams,
  deps: ParallelTransportDeps = {},
  externalSignal?: AbortSignal,
): Promise<ParallelTaskRunCreateResult> {
  const fetchFn = deps.fetch || globalThis.fetch;
  const setTimer = deps.setTimeout || globalThis.setTimeout;
  const clearTimer = deps.clearTimeout || globalThis.clearTimeout;
  const env = deps.env || process.env;
  const timeoutMs = resolveTimeoutMs(env);

  const url = `${BASE_URL}/v1/tasks/runs`;
  const body: Record<string, unknown> = {
    input,
    processor: params.processor,
    task_spec: params.task_spec ?? { output_schema: { type: "text" } },
  };
  if (params.source_policy) {
    body.source_policy = params.source_policy;
  }
  if (params.advanced_settings) {
    body.advanced_settings = params.advanced_settings;
  }

  const controller = new AbortController();
  const onExternalAbort = (): void => controller.abort();
  if (externalSignal?.aborted) controller.abort();
  externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
  const timer = setTimer(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchFn(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw mapStatusError(response.status, timeoutMs);
    }

    const text = await response.text();
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed)) {
      throw new ApiError("Parallel AI task run creation returned a malformed response", 500);
    }
    const runId = parsed.run_id;
    if (typeof runId !== "string" || runId.length === 0) {
      throw new ApiError("Parallel AI task run creation returned a malformed response", 500);
    }
    return {
      runId,
      status: typeof parsed.status === "string" ? parsed.status : "queued",
    };
  } catch (err: unknown) {
    if (
      err instanceof AuthError ||
      err instanceof ApiError ||
      err instanceof QuotaError ||
      err instanceof TimeoutError ||
      err instanceof ValidationError
    ) {
      throw err;
    }
    if (err instanceof SyntaxError) {
      throw new ApiError("Parallel AI returned a malformed JSON response", 500);
    }
    if (err instanceof Error && err.name === "AbortError") {
      if (externalSignal?.aborted) {
        throw new TimeoutError(0, "Research aborted");
      }
      throw new TimeoutError(timeoutMs, TIMEOUT_HELP_TEXT);
    }
    throw new NetworkError(
      `Parallel AI task run creation failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    externalSignal?.removeEventListener("abort", onExternalAbort);
    clearTimer(timer);
  }
}

/**
 * Flatten `output.basis[].citations[]` into a single citation array.
 * Handles both the standard FieldBasis shape (each item has a
 * `citations` array) and a potential flat-citation shape (items are
 * citations directly, as described for text-mode basis).
 */
function extractCitationsFromBasis(basis: unknown): ParallelTaskCitation[] {
  if (!Array.isArray(basis)) return [];
  const citations: ParallelTaskCitation[] = [];
  for (const item of basis) {
    if (!isRecord(item)) continue;
    const nested = item.citations;
    if (Array.isArray(nested)) {
      // FieldBasis shape: { field, citations: [...], reasoning, confidence }
      for (const c of nested) {
        if (isRecord(c) && typeof c.url === "string") {
          citations.push({
            ...(typeof c.title === "string" ? { title: c.title } : {}),
            url: c.url,
            ...(Array.isArray(c.excerpts) ? { excerpts: c.excerpts as string[] } : {}),
          });
        }
      }
    } else if (typeof item.url === "string") {
      // Flat citation shape (text-mode basis)
      citations.push({
        ...(typeof item.title === "string" ? { title: item.title } : {}),
        url: item.url,
      });
    }
  }
  return citations;
}

/**
 * Normalize a parsed /result response body into a
 * {@link ParallelTaskRunResult}. Maps `run.status` to the lifecycle
 * status, extracts `output.content` and flattens `output.basis`
 * citations. Any malformed shape is a retryable `ApiError` 500.
 */
function normalizeTaskRunResult(parsed: unknown): ParallelTaskRunResult {
  if (!isRecord(parsed)) {
    throw new ApiError("Parallel AI task result returned a malformed response", 500);
  }
  const run = parsed.run;
  const output = parsed.output;
  if (!isRecord(run)) {
    throw new ApiError("Parallel AI task result returned a malformed response", 500);
  }

  const runStatus = run.status;

  if (runStatus === "failed" || runStatus === "cancelled") {
    // "failed" and "cancelled" are terminal non-success states. Map
    // both to "failed" so the poll loop stops and cleans up.
    const error = run.error;
    const errorMessage =
      isRecord(error) && typeof error.message === "string" ? error.message : undefined;
    return {
      status: "failed",
      ...(errorMessage ? { errorMessage } : {}),
    };
  }

  if (runStatus === "completed") {
    // Completed — extract output.content and output.basis citations.
  } else if (
    runStatus === "queued" ||
    runStatus === "running" ||
    runStatus === "action_required" ||
    runStatus === "cancelling"
  ) {
    // Non-terminal — poll again.
    return { status: "running" };
  } else {
    // Unknown status — treat as malformed so the poll loop doesn't
    // spin forever on an unrecognized terminal state.
    throw new ApiError("Parallel AI task result returned a malformed response", 500);
  }

  // Completed — extract output.content and output.basis citations.
  if (!isRecord(output)) {
    throw new ApiError("Parallel AI task result returned a malformed response", 500);
  }
  const content = output.content;
  if (typeof content !== "string") {
    throw new ApiError("Parallel AI task result returned a malformed response", 500);
  }

  const citations = extractCitationsFromBasis(output.basis);
  const processor = typeof run.processor === "string" ? run.processor : undefined;

  return {
    status: "completed",
    content,
    ...(citations.length > 0 ? { citations } : {}),
    ...(processor ? { processor } : {}),
  };
}

/**
 * Perform ONE GET against the Parallel /v1/tasks/runs/{run_id}/result
 * endpoint. This is a server-side long-poll: the server blocks up to
 * `RESULT_POLL_SERVER_TIMEOUT_S` seconds, then returns 408 if the run is
 * still active. On 200, the response includes `run.status` and (if
 * completed) `output.content` + `output.basis`. On 404, the run failed
 * or the run_id expired.
 *
 * The client-side AbortController timeout is set to
 * `max(PARALLEL_TIMEOUT, (server_timeout + 30)s)` so the server's 408
 * arrives before our timeout fires. The external signal (from the
 * command handler's `--timeout`) can abort at any time.
 */
export async function retrieveParallelTaskRunResult(
  apiKey: string,
  runId: string,
  deps: ParallelTransportDeps = {},
  externalSignal?: AbortSignal,
): Promise<ParallelTaskRunResult> {
  const fetchFn = deps.fetch || globalThis.fetch;
  const setTimer = deps.setTimeout || globalThis.setTimeout;
  const clearTimer = deps.clearTimeout || globalThis.clearTimeout;
  const env = deps.env || process.env;
  const transportTimeoutMs = resolveTimeoutMs(env);
  // Client-side timeout MUST exceed the server long-poll window so the
  // server's 408 arrives before our AbortController fires.
  const clientTimeoutMs = Math.max(
    transportTimeoutMs,
    (RESULT_POLL_SERVER_TIMEOUT_S + 30) * 1000,
  );

  const url = `${BASE_URL}/v1/tasks/runs/${encodeURIComponent(runId)}/result?timeout=${RESULT_POLL_SERVER_TIMEOUT_S}`;

  const controller = new AbortController();
  const onExternalAbort = (): void => controller.abort();
  if (externalSignal?.aborted) controller.abort();
  externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
  const timer = setTimer(() => controller.abort(), clientTimeoutMs);

  try {
    const response = await fetchFn(url, {
      method: "GET",
      headers: {
        "x-api-key": apiKey,
        "User-Agent": USER_AGENT,
      },
      signal: controller.signal,
    });

    // 408 — server long-poll timed out; the run is still active.
    if (response.status === 408) {
      await response.text().catch(() => {});
      return { status: "running" };
    }
    // 404 — run failed or run_id not found (may have expired).
    if (response.status === 404) {
      await response.text().catch(() => {});
      return { status: "not_found" };
    }

    if (!response.ok) {
      throw mapStatusError(response.status, clientTimeoutMs);
    }

    const text = await response.text();
    const parsed = JSON.parse(text) as unknown;
    return normalizeTaskRunResult(parsed);
  } catch (err: unknown) {
    if (
      err instanceof AuthError ||
      err instanceof ApiError ||
      err instanceof QuotaError ||
      err instanceof TimeoutError ||
      err instanceof ValidationError
    ) {
      throw err;
    }
    if (err instanceof SyntaxError) {
      throw new ApiError("Parallel AI returned a malformed JSON response", 500);
    }
    if (err instanceof Error && err.name === "AbortError") {
      if (externalSignal?.aborted) {
        throw new TimeoutError(0, "Research polling aborted");
      }
      throw new TimeoutError(clientTimeoutMs, TIMEOUT_HELP_TEXT);
    }
    throw new NetworkError(
      `Parallel AI task run retrieval failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    externalSignal?.removeEventListener("abort", onExternalAbort);
    clearTimer(timer);
  }
}
