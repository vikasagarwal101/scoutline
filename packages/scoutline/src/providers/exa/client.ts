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
const CONTENTS_PATH = "/contents";
const AGENT_RUNS_PATH = "/agent/runs";
const DEFAULT_TIMEOUT_MS = 30000;

/**
 * Pinned Exa Agent API beta version. Every `/agent/runs*` request
 * (create, poll) MUST carry `Exa-Beta: <this value>` or the endpoint
 * returns 400 before any lifecycle logic runs. The header is
 * endpoint-scoped — search and contents calls do NOT send it. Pin as a
 * transport constant so a future version bump is a one-line change.
 */
const EXA_BETA_HEADER = "agent-2026-05-07";

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

/**
 * Provider-native contents request options (Exa API field names,
 * camelCase). The Adapter maps `ReaderFetchRequest` fields into these
 * before calling {@link fetchExaContents}; the transport never imports
 * a capability contract.
 *
 * `livecrawlTimeout` is in milliseconds (the CLI `--timeout` is in
 * seconds; the Adapter converts before calling).
 */
export interface ExaContentsParams {
  readonly livecrawlTimeout?: number;
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
  extraHeaders?: Record<string, string>,
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
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
    };
    if (extraHeaders) {
      for (const [key, value] of Object.entries(extraHeaders)) {
        headers[key] = value;
      }
    }
    const res = await f(url, {
      method: "POST",
      headers,
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

/**
 * Perform ONE POST against the Exa /contents endpoint. No retry; no
 * response body in public errors. Returns the parsed JSON body (raw;
 * the Adapter post-processes into a normalized `ReaderFetchResult`).
 *
 * The caller wraps a single URL as `urls: [url]`. `text: true` is
 * always set (Exa returns text content). The `Exa-Beta` header is NOT
 * sent on contents calls (endpoint-scoped to Agent only).
 *
 * `params.livecrawlTimeout` is in milliseconds. The Adapter converts
 * from the CLI's seconds-based `--timeout` before calling; the transport
 * does NOT re-convert.
 */
export async function fetchExaContents(
  apiKey: string,
  url: string,
  params?: ExaContentsParams,
  deps: ExaTransportDeps = {},
): Promise<unknown> {
  const body: Record<string, unknown> = { urls: [url], text: true };
  if (params?.livecrawlTimeout !== undefined) {
    body.livecrawlTimeout = params.livecrawlTimeout;
  }
  return postExaJson(apiKey, CONTENTS_PATH, body, deps, "contents");
}

// ---------------------------------------------------------------------------
// Agent — async create/poll transport (tech-plan §7, Research Lifecycle)
// ---------------------------------------------------------------------------

/**
 * Provider-native Agent run request body fields (Exa API field names,
 * camelCase). The Adapter maps the Provider-neutral `ResearchRequest`
 * into these before calling {@link createExaAgentRun}; the transport
 * never imports a capability contract.
 */
export interface ExaAgentRunParams {
  readonly query: string;
  readonly effort?: string;
}

/**
 * Structured result of POST /agent/runs. The endpoint returns
 * `{ id, status }` on success.
 */
export interface ExaAgentRunCreateResult {
  readonly id: string;
  readonly status: string;
}

/**
 * Structured result of GET /agent/runs/{id}. `output` is passed as raw
 * `unknown` — the Adapter normalizes it into a `ResearchResult`.
 *
 * `status: "not_found"` is returned (not thrown) for HTTP 404 so the
 * Adapter can treat a stale state file as "delete it and create a new
 * run" rather than a terminal transport error.
 */
export interface ExaAgentRunPollResult {
  readonly status: "queued" | "running" | "completed" | "failed" | "cancelled" | "not_found";
  readonly output?: unknown;
}

/**
 * Perform ONE POST against the Exa /agent/runs endpoint. No retry; no
 * response body in public errors. Returns the structured create result
 * `{ id, status }`.
 *
 * **MUST send** the `Exa-Beta: agent-2026-05-07` header — the endpoint
 * returns 400 without it. Shared execution wraps this with
 * `maxRetries: 0` (double-charge prevention on a usage-based endpoint),
 * so a transient create-time failure is terminal.
 */
export async function createExaAgentRun(
  apiKey: string,
  params: ExaAgentRunParams,
  deps: ExaTransportDeps = {},
): Promise<ExaAgentRunCreateResult> {
  const body: Record<string, unknown> = { query: params.query };
  if (params.effort !== undefined) {
    body.effort = params.effort;
  }
  const raw = await postExaJson(apiKey, AGENT_RUNS_PATH, body, deps, "agent-run", {
    "Exa-Beta": EXA_BETA_HEADER,
  });
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ApiError("Exa agent run returned a malformed response", 500);
  }
  const obj = raw as Record<string, unknown>;
  const id = obj.id;
  const status = obj.status;
  if (typeof id !== "string" || id.length === 0) {
    throw new ApiError("Exa agent run returned a malformed response", 500);
  }
  return { id, status: typeof status === "string" ? status : "queued" };
}

/**
 * Perform ONE GET against the Exa /agent/runs/{id} endpoint. No retry.
 * Returns a structured poll result.
 *
 * **MUST send** the `Exa-Beta: agent-2026-05-07` header.
 *
 * Unlike other GETs, a 404 is NOT a terminal transport error here: it
 * means the server-side run expired/disappeared, so the Adapter can
 * delete the stale state file and create a fresh run. The poll result
 * carries `status: "not_found"` for that case. All other non-2xx statuses
 * throw the standard mapped error.
 */
export async function pollExaAgentRun(
  apiKey: string,
  runId: string,
  deps: ExaTransportDeps = {},
): Promise<ExaAgentRunPollResult> {
  const f = deps.fetch ?? (fetch as unknown as ProviderQuotaFetch);
  const setT = deps.setTimeout ?? setTimeout;
  const clearT = deps.clearTimeout ?? clearTimeout;
  const env = deps.env ?? process.env;
  const timeoutMs = resolveTimeoutMs(env);

  const url = `${BASE_URL}${AGENT_RUNS_PATH}/${encodeURIComponent(runId)}`;
  const controller = new AbortController();
  const timeoutId = setT(() => controller.abort(), timeoutMs);
  try {
    let res;
    try {
      res = await f(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "User-Agent": USER_AGENT,
          "Exa-Beta": EXA_BETA_HEADER,
        },
        signal: controller.signal,
      });
      clearT(timeoutId);
    } catch (err) {
      clearT(timeoutId);
      throw normalizeTransportError(err, timeoutMs);
    }

    if (res.status === 404) {
      await res.text().catch(() => {});
      return { status: "not_found" };
    }
    if (!res.ok) {
      await res.text().catch(() => {});
      throw mapStatusError(res.status, timeoutMs);
    }
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      throw new ApiError("Exa agent run returned a malformed response", 500);
    }
    return normalizeAgentRunPollResult(parsed);
  } finally {
    controller.abort();
  }
}

/**
 * Normalize a parsed poll body into an {@link ExaAgentRunPollResult}.
 * Accepts `{ status, output? }`. Unknown/missing status maps to a
 * malformed-response error so the Adapter never silently advances on
 * garbage. The raw `output` is passed through for the Adapter to
 * normalize.
 */
function normalizeAgentRunPollResult(value: unknown): ExaAgentRunPollResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError("Exa agent run returned a malformed response", 500);
  }
  const obj = value as Record<string, unknown>;
  const status = obj.status;
  if (
    status !== "queued" &&
    status !== "running" &&
    status !== "completed" &&
    status !== "failed" &&
    status !== "cancelled"
  ) {
    throw new ApiError("Exa agent run returned a malformed response", 500);
  }
  const result: ExaAgentRunPollResult = { status };
  if (status === "completed" && obj.output !== undefined) {
    return { status, output: obj.output };
  }
  return result;
}
