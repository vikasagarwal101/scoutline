/**
 * Tavily direct HTTP transport (DESIGN.md §5, §7; tech-plan §7).
 *
 * Performs direct POSTs against the Tavily REST endpoints with an
 * `Authorization: Bearer <apiKey>` header. There is NO internal retry —
 * shared execution owns retry policy. Fetch and timer are injectable for
 * tests.
 *
 * Mirrors `providers/minimax/coding-plan-client.ts` in structure, but
 * SIMPLER: Tavily uses HTTP-status exclusively for errors (no body-level
 * business status code like MiniMax's `base_resp.status_code`). Error
 * responses are `{ "detail": { "error": "message" } }`; the transport
 * maps HTTP status to Scoutline errors at the transport layer only — no
 * second body-parsing layer needed.
 *
 * Boundary rules (ARCHITECTURE.md §2):
 *   - May import Adapter-local config and normalized errors.
 *   - May import `ProviderQuotaFetch` from `providers/types.ts`.
 *   - Must NOT import command presentation, capability contracts, or
 *     another Provider's Adapter.
 *   - Must NOT perform response field normalization — the Adapter owns
 *     that. This module declares Provider-native request-body types
 *     only (Tavily API field names); it does not import SearchControls
 *     or any capability contract.
 */

import { createRequire } from "node:module";

import { ApiError, AuthError, NetworkError, TimeoutError } from "../../lib/errors.js";
import type { ProviderQuotaFetch } from "../types.js";

const require = createRequire(import.meta.url);
const { version: VERSION } = require("../../../package.json") as { version: string };

const BASE_URL = "https://api.tavily.com";
const SEARCH_PATH = "/search";
const EXTRACT_PATH = "/extract";
const CRAWL_PATH = "/crawl";
const MAP_PATH = "/map";
const RESEARCH_PATH = "/research";
const USAGE_PATH = "/usage";
const DEFAULT_TIMEOUT_MS = 30000;

const USER_AGENT = `scoutline/${VERSION}`;
const TIMEOUT_HELP_TEXT = "Try again or increase timeout with TAVILY_TIMEOUT env var";

/** Injectable transport dependencies (fetch, timers, env). */
export interface TavilyTransportDeps {
  readonly fetch?: ProviderQuotaFetch;
  readonly setTimeout?: typeof setTimeout;
  readonly clearTimeout?: typeof clearTimeout;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Provider-native search request body fields (Tavily API field names).
 * The Adapter maps the Provider-neutral `SearchControls` into these
 * before calling {@link fetchTavilySearch}; the transport never imports
 * a capability contract.
 */
export interface TavilySearchParams {
  readonly topic?: string;
  readonly search_depth?: string;
  readonly include_domains?: readonly string[];
  readonly time_range?: string;
}

/**
 * Provider-native extract request options. The Adapter maps
 * `contentSize` to `extract_depth`; the transport sends the body.
 */
export interface TavilyExtractParams {
  readonly extract_depth?: string;
}

/**
 * Provider-native crawl request body fields (Tavily API field names).
 * The Adapter maps the Provider-neutral `CrawlRequest` into these before
 * calling {@link fetchTavilyCrawl}; the transport never imports a
 * capability contract.
 */
export interface TavilyCrawlParams {
  readonly max_depth?: number;
  readonly max_breadth?: number;
  readonly limit?: number;
  readonly select_paths?: readonly string[];
  readonly exclude_paths?: readonly string[];
  readonly instructions?: string;
  readonly format?: string;
  readonly extract_depth?: string;
  readonly timeout?: number;
}

/**
 * Provider-native map request body fields (Tavily API field names).
 * The Adapter maps the Provider-neutral `MapRequest` into these before
 * calling {@link fetchTavilyMap}; the transport never imports a
 * capability contract.
 *
 * Map returns URLs only — no `format`, `extract_depth`, or `timeout`
 * fields. The /map endpoint surfaces the discovered site structure and
 * deliberately omits per-page extraction controls.
 */
export interface TavilyMapParams {
  readonly max_depth?: number;
  readonly max_breadth?: number;
  readonly limit?: number;
  readonly select_paths?: readonly string[];
  readonly exclude_paths?: readonly string[];
  readonly instructions?: string;
}

/**
 * Provider-native research request body fields (Tavily API field names).
 * The Adapter maps the Provider-neutral `ResearchRequest` into these
 * before calling {@link createTavilyResearch}; the transport never
 * imports a capability contract.
 */
export interface TavilyResearchParams {
  readonly query: string;
  readonly model?: string;
  readonly output_length?: string;
  readonly citation_format?: string;
  readonly domain?: string;
}

/**
 * Structured result of POST /research. The endpoint returns HTTP 201
 * (Created) with `{ request_id, status: "pending" }`.
 */
export interface TavilyResearchCreateResult {
  readonly requestId: string;
  readonly status: string;
}

/**
 * Structured result of GET /research/{id}. `status: "not_found"` is
 * returned (not thrown) for HTTP 404 so the Adapter can treat a stale
 * state file as "delete it and create a new task" rather than a terminal
 * transport error.
 */
export interface TavilyResearchPollResult {
  readonly status: "pending" | "in_progress" | "completed" | "failed" | "not_found";
  readonly content?: string;
  readonly sources?: readonly TavilyResearchPollSource[];
}

export interface TavilyResearchPollSource {
  readonly title?: string;
  readonly url?: string;
}

function resolveTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = parseInt(env.TAVILY_TIMEOUT || String(DEFAULT_TIMEOUT_MS), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

/**
 * Layer 1 — HTTP-status mapping. Runs BEFORE the body is parsed; on a
 * non-200 response we discard the body and throw a typed error.
 *
 * Tavily uses HTTP-status exclusively. The non-standard 432/433 codes
 * are Tavily-specific plan/paygo limits; they are mapped to `ApiError`
 * (NOT `QuotaError`, which hardcodes statusCode 429 and would collide
 * with actual rate limits) with the real status preserved so scripting
 * users can distinguish plan-limit from paygo-limit from rate-limit.
 * Both are terminal because `isOperationRetryableError` treats an
 * `ApiError` with non-429/non-5xx status as non-retryable.
 *
 * `timeoutMs` is forwarded so 408/504 can throw `TimeoutError`
 * carrying the configured duration (and the `TAVILY_TIMEOUT` help
 * text). The transport never embeds credential material in any error
 * message.
 */
function mapStatusError(status: number, timeoutMs: number): Error {
  if (status === 401 || status === 403) {
    return new AuthError("Tavily authentication failed", "TAVILY_API_KEY");
  }
  if (status === 408 || status === 504) {
    return new TimeoutError(timeoutMs, TIMEOUT_HELP_TEXT);
  }
  if (status === 429) {
    return new ApiError("Tavily rate limit exceeded", 429);
  }
  if (status === 432) {
    return new ApiError("Tavily plan limit exceeded. Upgrade your plan at app.tavily.com.", 432);
  }
  if (status === 433) {
    return new ApiError(
      "Tavily pay-as-you-go limit exceeded. Increase your limit on the Tavily dashboard.",
      433,
    );
  }
  if (status === 400 || status === 404 || status === 410 || status === 422) {
    return new ApiError("Tavily request failed", status);
  }
  if (status >= 500) {
    return new ApiError("Tavily request failed", status);
  }
  return new ApiError("Tavily request failed", status);
}

function normalizeTransportError(err: unknown, timeoutMs: number): Error {
  if (err instanceof AuthError || err instanceof ApiError || err instanceof TimeoutError) {
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
      return new NetworkError("Tavily network error");
    }
  }
  return new ApiError("Tavily request failed", 500);
}

async function postTavilyJson(
  apiKey: string,
  path: string,
  body: Record<string, unknown>,
  deps: TavilyTransportDeps,
  endpointLabel: string,
  /**
   * Optional client-side AbortController timeout in ms. When omitted, the
   * transport resolves the timeout from `deps.env` (`TAVILY_TIMEOUT`,
   * default 30s). Crawl passes an explicit value so the client waits at
   * least as long as the server-side `body.timeout` ceiling (150s default).
   */
  timeoutMsOverride?: number,
): Promise<unknown> {
  const f = deps.fetch ?? (fetch as unknown as ProviderQuotaFetch);
  const setT = deps.setTimeout ?? setTimeout;
  const clearT = deps.clearTimeout ?? clearTimeout;
  const env = deps.env ?? process.env;
  const timeoutMs = timeoutMsOverride ?? resolveTimeoutMs(env);

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
      throw mapStatusError(res.status, timeoutMs);
    }
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      throw new ApiError(`Tavily ${endpointLabel} returned a malformed response`, 500);
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
 * Perform ONE POST against the Tavily /search endpoint. No retry; no
 * response body in public errors. Returns the parsed JSON body (raw;
 * the Adapter post-processes into normalized search sources).
 *
 * `params` carries Tavily-native API fields already mapped from
 * `SearchControls` by the Adapter.
 */
export async function fetchTavilySearch(
  apiKey: string,
  query: string,
  params?: TavilySearchParams,
  deps: TavilyTransportDeps = {},
): Promise<unknown> {
  const body: Record<string, unknown> = { query };
  if (params) {
    if (params.topic !== undefined) {
      body.topic = params.topic;
    }
    if (params.search_depth !== undefined) {
      body.search_depth = params.search_depth;
    }
    if (params.include_domains !== undefined) {
      body.include_domains = [...params.include_domains];
    }
    if (params.time_range !== undefined) {
      body.time_range = params.time_range;
    }
  }
  return postTavilyJson(apiKey, SEARCH_PATH, body, deps, "search");
}

/**
 * Perform ONE POST against the Tavily /extract endpoint. No retry; no
 * response body in public errors. Returns the parsed JSON body (raw;
 * the Adapter post-processes into a normalized ReaderFetchResult).
 *
 * `url` is a single URL; the transport wraps it as `urls: [url]` per
 * the Tavily API contract.
 */
export async function fetchTavilyExtract(
  apiKey: string,
  url: string,
  params?: TavilyExtractParams,
  deps: TavilyTransportDeps = {},
): Promise<unknown> {
  const body: Record<string, unknown> = { urls: [url] };
  if (params?.extract_depth !== undefined) {
    body.extract_depth = params.extract_depth;
  }
  return postTavilyJson(apiKey, EXTRACT_PATH, body, deps, "extract");
}

/**
 * Perform ONE POST against the Tavily /crawl endpoint. No retry; no
 * response body in public errors. Returns the parsed JSON body (raw; the
 * Adapter post-processes into a normalized CrawlResult).
 *
 * `params` carries Tavily-native API fields already mapped from
 * `CrawlRequest` by the Adapter.
 */
export async function fetchTavilyCrawl(
  apiKey: string,
  url: string,
  params?: TavilyCrawlParams,
  deps: TavilyTransportDeps = {},
): Promise<unknown> {
  const body: Record<string, unknown> = { url };
  if (params) {
    if (params.max_depth !== undefined) {
      body.max_depth = params.max_depth;
    }
    if (params.max_breadth !== undefined) {
      body.max_breadth = params.max_breadth;
    }
    if (params.limit !== undefined) {
      body.limit = params.limit;
    }
    if (params.select_paths !== undefined) {
      body.select_paths = [...params.select_paths];
    }
    if (params.exclude_paths !== undefined) {
      body.exclude_paths = [...params.exclude_paths];
    }
    if (params.instructions !== undefined) {
      body.instructions = params.instructions;
    }
    if (params.format !== undefined) {
      body.format = params.format;
    }
    if (params.extract_depth !== undefined) {
      body.extract_depth = params.extract_depth;
    }
    if (params.timeout !== undefined) {
      body.timeout = params.timeout;
    }
  }
  // The client-side AbortController MUST wait at least as long as the
  // server-side ceiling. Tavily's crawl `timeout` (seconds) caps how long
  // the server works; the default is 150s. If the transport default
  // (`TAVILY_TIMEOUT`, 30s) is shorter, any crawl exceeding it would be
  // aborted client-side regardless of `--timeout`. Take the larger of the
  // transport default and (server ceiling * 1000 + 5s network buffer).
  const serverCeilingSeconds = params?.timeout ?? 150;
  const clientTimeoutMs = Math.max(
    resolveTimeoutMs(deps.env ?? process.env),
    serverCeilingSeconds * 1000 + 5000,
  );
  return postTavilyJson(apiKey, CRAWL_PATH, body, deps, "crawl", clientTimeoutMs);
}

/**
 * Perform ONE POST against the Tavily /map endpoint. No retry; no
 * response body in public errors. Returns the parsed JSON body (raw; the
 * Adapter post-processes into a normalized MapResult).
 *
 * `params` carries Tavily-native API fields already mapped from
 * `MapRequest` by the Adapter. The /map response is `{ results: string[] }`
 * — an array of URL strings, NOT an array of page objects — and is
 * returned as raw `unknown` for the Adapter to normalize.
 */
export async function fetchTavilyMap(
  apiKey: string,
  url: string,
  params?: TavilyMapParams,
  deps: TavilyTransportDeps = {},
): Promise<unknown> {
  const body: Record<string, unknown> = { url };
  if (params) {
    if (params.max_depth !== undefined) {
      body.max_depth = params.max_depth;
    }
    if (params.max_breadth !== undefined) {
      body.max_breadth = params.max_breadth;
    }
    if (params.limit !== undefined) {
      body.limit = params.limit;
    }
    if (params.select_paths !== undefined) {
      body.select_paths = [...params.select_paths];
    }
    if (params.exclude_paths !== undefined) {
      body.exclude_paths = [...params.exclude_paths];
    }
    if (params.instructions !== undefined) {
      body.instructions = params.instructions;
    }
  }
  return postTavilyJson(apiKey, MAP_PATH, body, deps, "map");
}

/**
 * Layer 1 — HTTP-status mapping for GET requests. Same semantics as
 * `postTavilyJson`'s mapping (`mapStatusError`); duplicated here so a
 * transport seam that only ever issues GETs does not have to import
 * the POST-only path.
 */
async function getTavilyJson(
  apiKey: string,
  path: string,
  deps: TavilyTransportDeps,
  endpointLabel: string,
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
    const res = await f(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "User-Agent": USER_AGENT,
      },
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
      throw new ApiError(`Tavily ${endpointLabel} returned a malformed response`, 500);
    }
    return parsed;
  } catch (err) {
    clearT(timeoutId);
    throw normalizeTransportError(err, timeoutMs);
  } finally {
    controller.abort();
  }
} /**
 * Perform ONE GET against the Tavily /usage endpoint. No retry; no
 * response body in public errors. Returns the parsed JSON body (raw;
 * the Adapter post-processes into normalized quota categories).
 *
 * Tavily's /usage is rate-limited (10 calls per 10 minutes per key).
 * It is therefore ONLY safe to invoke through the Quota Capability
 * path (interactive `quota` command) — the Diagnostics Capability
 * intentionally uses /search (1 credit) to avoid hitting this
 * restrictive window.
 */
export async function fetchTavilyUsage(
  apiKey: string,
  deps: TavilyTransportDeps = {},
): Promise<unknown> {
  return getTavilyJson(apiKey, USAGE_PATH, deps, "usage");
}

// ---------------------------------------------------------------------------
// Research — async create/poll transport (tech-plan §3, §7)
// ---------------------------------------------------------------------------
//
// Research is the only Tavily capability with an asynchronous lifecycle:
// POST /research creates the task (HTTP 201, { request_id, status }),
// then GET /research/{id} polls until completion (200 completed), failure
// (200 failed), or the task disappears (404). The transport performs ONE
// request per call and never polls internally — the Adapter's `invoke()`
// owns the poll loop and the state file.

/**
 * Perform ONE POST against the Tavily /research endpoint. No retry; no
 * response body in public errors. Returns the structured create result
 * `{ requestId, status }`.
 *
 * Note: /research returns HTTP 201 (Created) on success, not 200. The
 * shared `postTavilyJson` treats any 2xx as success (`res.ok`), so 201
 * is handled correctly without special-casing the status mapping.
 */
export async function createTavilyResearch(
  apiKey: string,
  query: string,
  params?: Omit<TavilyResearchParams, "query">,
  deps: TavilyTransportDeps = {},
): Promise<TavilyResearchCreateResult> {
  const body: Record<string, unknown> = { query };
  if (params) {
    if (params.model !== undefined) body.model = params.model;
    if (params.output_length !== undefined) body.output_length = params.output_length;
    if (params.citation_format !== undefined) body.citation_format = params.citation_format;
    if (params.domain !== undefined) body.domain = params.domain;
  }
  const raw = (await postTavilyJson(apiKey, RESEARCH_PATH, body, deps, "research")) as unknown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ApiError("Tavily research returned a malformed response", 500);
  }
  const obj = raw as Record<string, unknown>;
  const requestId = obj.request_id;
  const status = obj.status;
  if (typeof requestId !== "string" || requestId.length === 0) {
    throw new ApiError("Tavily research returned a malformed response", 500);
  }
  return { requestId, status: typeof status === "string" ? status : "pending" };
}

/**
 * Perform ONE GET against the Tavily /research/{request_id} endpoint.
 * No retry. Returns a structured poll result.
 *
 * Unlike other GETs, a 404 is NOT a terminal transport error here: it
 * means the server-side task has expired/disappeared, so the Adapter can
 * delete the stale state file and create a fresh task. The poll result
 * carries `status: "not_found"` for that case. All other non-2xx statuses
 * throw the standard mapped error (auth, rate limit, 5xx).
 */
export async function pollTavilyResearch(
  apiKey: string,
  requestId: string,
  deps: TavilyTransportDeps = {},
): Promise<TavilyResearchPollResult> {
  const f = deps.fetch ?? (fetch as unknown as ProviderQuotaFetch);
  const setT = deps.setTimeout ?? setTimeout;
  const clearT = deps.clearTimeout ?? clearTimeout;
  const env = deps.env ?? process.env;
  const timeoutMs = resolveTimeoutMs(env);

  const url = `${BASE_URL}${RESEARCH_PATH}/${encodeURIComponent(requestId)}`;
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
      throw new ApiError("Tavily research returned a malformed response", 500);
    }
    return normalizeResearchPollResult(parsed);
  } finally {
    controller.abort();
  }
}

/**
 * Normalize a parsed poll body into a {@link TavilyResearchPollResult}.
 * Accepts `{ status, content?, sources? }`. Unknown/missing status maps
 * to a malformed-response error so the Adapter never silently advances
 * on garbage.
 */
function normalizeResearchPollResult(value: unknown): TavilyResearchPollResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError("Tavily research returned a malformed response", 500);
  }
  const obj = value as Record<string, unknown>;
  const status = obj.status;
  if (
    status !== "pending" &&
    status !== "in_progress" &&
    status !== "completed" &&
    status !== "failed"
  ) {
    throw new ApiError("Tavily research returned a malformed response", 500);
  }
  const result: TavilyResearchPollResult = { status };
  if (status === "completed") {
    const content = obj.content;
    if (typeof content !== "string") {
      throw new ApiError("Tavily research returned a malformed response", 500);
    }
    const sources = obj.sources;
    if (sources !== undefined && !Array.isArray(sources)) {
      throw new ApiError("Tavily research returned a malformed response", 500);
    }
    let decodedSources: TavilyResearchPollSource[] | undefined;
    if (Array.isArray(sources)) {
      decodedSources = [];
      for (const entry of sources) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          throw new ApiError("Tavily research returned a malformed response", 500);
        }
        const src = entry as Record<string, unknown>;
        decodedSources.push({
          title: typeof src.title === "string" ? src.title : undefined,
          url: typeof src.url === "string" ? src.url : undefined,
        });
      }
    }
    return {
      status: "completed",
      content,
      ...(decodedSources !== undefined ? { sources: decodedSources } : {}),
    };
  }
  return result;
}
