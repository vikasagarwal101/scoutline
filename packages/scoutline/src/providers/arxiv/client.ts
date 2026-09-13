/**
 * arXiv direct HTTP transport.
 *
 * Performs GETs against the arXiv Atom query endpoint
 * (`https://export.arxiv.org/api/query`). Keyless — no credential
 * model exists for arXiv (DESIGN D2 supplier table) — so there is no
 * credentials.ts: the adapter pins `credentialEnvVars: []` directly.
 * The response body is consumed as TEXT via `text()`: Atom is XML,
 * never JSON. No internal retry — shared execution owns retry policy.
 * Fetch and timers are injectable for tests; the house `USER_AGENT`
 * rides every request (D2 politeness).
 *
 * Boundary rules (ARCHITECTURE.md §2), cloning the Spider client shape:
 *   - May import normalized errors, the provider fetch seam, and the bounded-body lib helper.
 *   - Must NOT perform response field normalization — the Adapter owns
 *     parsing. This module returns the raw XML string.
 */
import pkg from "../../../package.json" with { type: "json" };
import {
  readBoundedResponseBody,
  MAX_BUFFERED_RESPONSE_BYTES,
} from "../../lib/bounded-body.js";
import {
  ApiError,
  AuthError,
  NetworkError,
  QuotaError,
  TimeoutError,
  ValidationError,
} from "../../lib/errors.js";
import type { ProviderQuotaFetch } from "../types.js";
import { getGlobalFetch } from "../types.js";

const { version: VERSION } = pkg;

export const ARXIV_QUERY_URL = "https://export.arxiv.org/api/query";
const DEFAULT_TIMEOUT_MS = 30000;
const USER_AGENT = `scoutline/${VERSION}`;

/** Injectable transport dependencies (fetch, timers). */
export interface ArxivTransportDeps {
  readonly fetch?: ProviderQuotaFetch;
  readonly setTimeout?: typeof setTimeout;
  readonly clearTimeout?: typeof clearTimeout;
}

/**
 * arXiv-native query params (API field names). The Adapter maps the
 * Provider-neutral science requests into these before calling
 * {@link fetchArxivQuery}; the transport never imports a capability
 * contract.
 */
export interface ArxivQueryParams {
  /** Free-text search expression, e.g. `all:attention`. */
  readonly search_query?: string;
  /** Comma-separated arXiv id list for identifier-addressed fetches. */
  readonly id_list?: string;
  /** Zero-based first result offset. */
  readonly start?: number;
  /** Page bound; the diagnostics probe pins 1 (D2 round-3). */
  readonly max_results?: number;
}

/**
 * Layer 1 — HTTP-status mapping. Runs BEFORE the body is consumed; on
 * a non-2xx response the body is discarded and a typed error thrown.
 * 401/403 → AuthError; 408/504 → TimeoutError; other 4xx/5xx → ApiError
 * with the real status preserved for the shared retry classifier.
 */
function mapStatusError(status: number, timeoutMs: number): Error {
  if (status === 401 || status === 403) {
    return new AuthError("arXiv rejected the request");
  }
  if (status === 408 || status === 504) {
    return new TimeoutError(timeoutMs);
  }
  if (status === 429) {
    return new QuotaError("arXiv rate-limited — keyless service; retry later");
  }
  return new ApiError("arXiv request failed", status);
}

/**
 * Map an unexpected transport-layer failure to a typed error. Typed
 * errors pass through; an AbortError is the injected timeout firing;
 * everything else (refused connections, DNS, `fetch failed`) is a
 * transient NetworkError. No raw provider body crosses the seam.
 */
function normalizeTransportError(
  error: unknown,
  timeoutMs: number,
  timedOut = false,
): Error {
  if (
    error instanceof AuthError ||
    error instanceof ApiError ||
    error instanceof QuotaError ||
    error instanceof TimeoutError ||
    error instanceof ValidationError
  ) {
    return error;
  }
  if (error instanceof Error && error.name === "AbortError") {
    if (timedOut) {
      return new TimeoutError(timeoutMs);
    }
    return new ApiError(
      "arXiv request was aborted by the caller (Ctrl-C or external signal)",
      499,
    );
  }
  return new NetworkError("arXiv network error");
}

/**
 * Core GET. Sends the query params, maps a non-2xx status, and returns
 * the response body as text (the Atom XML document — `json()` is never
 * called). An external `signal` chains into the timeout controller so a
 * caller abort rejects the in-flight fetch immediately (house
 * AbortSignal threading rule, D4b).
 */
export async function fetchArxivQuery(
  params: ArxivQueryParams,
  deps: ArxivTransportDeps = {},
  signal?: AbortSignal,
): Promise<string> {
  const f = deps.fetch ?? getGlobalFetch<ProviderQuotaFetch>();
  const setT = deps.setTimeout ?? setTimeout;
  const clearT = deps.clearTimeout ?? clearTimeout;
  const url = new URL(ARXIV_QUERY_URL);
  if (params.search_query !== undefined) url.searchParams.set("search_query", params.search_query);
  if (params.id_list !== undefined) url.searchParams.set("id_list", params.id_list);
  if (params.start !== undefined) url.searchParams.set("start", String(params.start));
  if (params.max_results !== undefined) {
    url.searchParams.set("max_results", String(params.max_results));
  }
  // A pre-aborted caller signal must not reach the transport (review):
  // reject before the fetch is invoked at all.
  if (signal?.aborted) {
    throw new ApiError(
      "arXiv request was aborted by the caller (Ctrl-C or external signal)",
      499,
    );
  }
  let timedOut = false;
  const controller = new AbortController();
  const timeoutId = setT(() => {
    timedOut = true;
    controller.abort();
  }, DEFAULT_TIMEOUT_MS);
  const abortWithExternal = () => controller.abort();
  if (signal !== undefined) {
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener("abort", abortWithExternal, { once: true });
    }
  }
  try {
    const res = (await f(url, {
      method: "GET",
      headers: { "User-Agent": USER_AGENT },
      signal: controller.signal,
    })) as unknown as {
      readonly ok: boolean;
      readonly status: number;
      readonly headers: { get(name: string): string | null };
      readonly body?: ReadableStream<Uint8Array> | null;
      text?(): Promise<string>;
      json?(): Promise<unknown>;
    };
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw mapStatusError(res.status, DEFAULT_TIMEOUT_MS);
    }
    const contentLengthHeader = res.headers.get("content-length");
    if (contentLengthHeader && Number(contentLengthHeader) > MAX_BUFFERED_RESPONSE_BYTES) {
      await res.body?.cancel().catch(() => {});
      throw new ApiError(
        `arXiv response exceeds the 50MB in-memory ceiling (${contentLengthHeader} bytes declared) — refusing to buffer`,
        413,
      );
    }
    try {
      if (res.body) {
        const buf = await readBoundedResponseBody(
          res.body,
          MAX_BUFFERED_RESPONSE_BYTES,
          "arXiv response",
        );
        return buf.toString("utf8");
      }
      if (typeof res.text === "function") {
        return await res.text();
      }
      return "";
    } catch (err) {
      // The timeout stays armed through body consumption; an abort here
      // may be the injected timeout firing OR a caller cancel. A caller
      // cancel can surface as a raw non-AbortError (undici "terminated"
      // TypeError) — classify by abort SOURCE, not error shape: a caller
      // cancel is never a network failure.
      if (controller.signal.aborted && !timedOut) {
        throw new ApiError(
          "arXiv request was aborted by the caller (Ctrl-C or external signal)",
          499,
        );
      }
      if (controller.signal.aborted) throw err;
      if (err instanceof ApiError || err instanceof ValidationError) throw err;
      throw new ApiError("arXiv returned a malformed response", 500);
    }
  } catch (err) {
    throw normalizeTransportError(err, DEFAULT_TIMEOUT_MS, timedOut);
  } finally {
    if (signal !== undefined) {
      signal.removeEventListener("abort", abortWithExternal);
    }
    clearT(timeoutId);
    controller.abort();
  }
}
