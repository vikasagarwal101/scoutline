/**
 * Crossref direct HTTP transport.
 *
 * GETs against `https://api.crossref.org/works` (DESIGN D2 supplier
 * table) consuming JSON. Crossref is keyless — no credential model
 * exists (`credentialEnvVars: []`; mailto is politeness, not a
 * credential). The polite-pool contact rides the User-Agent itself —
 * the Crossref convention (UA-carried mailto), unlike OpenAlex's
 * query-param convention — so the house `USER_AGENT` carries a
 * `mailto:` contact on every request, unconditionally.
 *
 * Boundary rules (ARCHITECTURE.md §2), cloning the arXiv/OpenAlex
 * client shape:
 *   - May import normalized errors and the provider fetch seam.
 *   - Must NOT perform response field normalization — the Adapter owns
 *     parsing. This module returns the parsed JSON document as unknown.
 */
import pkg from "../../../package.json" with { type: "json" };
import { ApiError, AuthError, NetworkError, QuotaError, TimeoutError } from "../../lib/errors.js";
import type { ProviderQuotaFetch } from "../types.js";
import { getGlobalFetch } from "../types.js";

const { version: VERSION } = pkg;

export const CROSSREF_WORKS_URL = "https://api.crossref.org/works";
const DEFAULT_TIMEOUT_MS = 30000;
/**
 * House UA with the polite-pool contact (DESIGN D2 politeness bullet):
 * Crossref reads the `mailto:` contact out of the User-Agent, so every
 * request lands in the polite pool. Keyless posture — unconditional.
 */
const USER_AGENT = `scoutline/${VERSION} (mailto:scoutline@localhost)`;

/** Injectable transport dependencies (fetch, timers). */
export interface CrossrefTransportDeps {
  readonly fetch?: ProviderQuotaFetch;
  readonly setTimeout?: typeof setTimeout;
  readonly clearTimeout?: typeof clearTimeout;
}

/**
 * Layer 1 — HTTP-status mapping, before the body is consumed. 401/403
 * → AuthError; 408/504 → TimeoutError; other 4xx/5xx → ApiError with
 * the real status preserved for the shared retry classifier.
 */
function mapStatusError(status: number, timeoutMs: number): Error {
  if (status === 401 || status === 403) {
    return new AuthError("Crossref rejected the request");
  }
  if (status === 408 || status === 504) {
    return new TimeoutError(timeoutMs);
  }
  if (status === 429) {
    return new QuotaError("Crossref rate-limited — keyless service; retry later");
  }
  return new ApiError("Crossref request failed", status);
}

/** Same transport-error normalization contract as the arXiv/OpenAlex clients. */
function normalizeTransportError(error: unknown, timeoutMs: number): Error {
  if (
    error instanceof AuthError ||
    error instanceof ApiError ||
    error instanceof QuotaError ||
    error instanceof TimeoutError
  ) {
    return error;
  }
  if (error instanceof Error && error.name === "AbortError") {
    return new TimeoutError(timeoutMs);
  }
  return new NetworkError("Crossref network error");
}

/**
 * Core GET. `params` carries Crossref-native query parameters (query,
 * query.author, query.container-title, filter, rows — the Adapter maps
 * Provider-neutral science requests into these); `path` addresses an
 * entity route for identifier-addressed gets (e.g. `10.1038/...`).
 * Returns the parsed JSON document. No internal retry — shared
 * execution owns retry policy.
 */
/**
 * Percent-encode one entity-route path segment, preserving `/` at the
 * caller. Encodes the URL-delimiter characters (`?`, `#`) and a stray
 * `%` (keeps the segment unambiguous); leaves the DOI-legal punctuation
 * (`: . - _ ~`) readable.
 */
function encodePathSegment(segment: string): string {
  // Dot-only segments are double-encoded (review): `new URL`
  // normalizes an unencoded `..` away (`/works/../x` → `/works/x`),
  // silently addressing the WRONG entity. %252E survives URL parsing
  // as the literal segment `..`.
  if (segment === "." || segment === "..") {
    return segment.replaceAll(".", "%252E");
  }
  return segment.replace(/[?#%]/g, (c) => encodeURIComponent(c));
}

export async function fetchCrossrefJson(
  params: Record<string, string>,
  deps: CrossrefTransportDeps = {},
  signal?: AbortSignal,
  path = "",
): Promise<unknown> {
  const f = deps.fetch ?? getGlobalFetch<ProviderQuotaFetch>();
  const setT = deps.setTimeout ?? setTimeout;
  const clearT = deps.clearTimeout ?? clearTimeout;
  // Entity-route path segments are percent-encoded (review): a DOI
  // suffix containing `?` or `#` would otherwise be truncated into the
  // query/fragment by `new URL`. `/` separators are preserved.
  const url = new URL(
    `${CROSSREF_WORKS_URL}${
      path ? `/${path.replace(/^\/+/, "").split("/").map(encodePathSegment).join("/")}` : ""
    }`,
  );
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  // A pre-aborted caller signal must not reach the transport (review):
  // reject before the fetch is invoked at all.
  if (signal?.aborted) {
    throw new TimeoutError(DEFAULT_TIMEOUT_MS);
  }
  const controller = new AbortController();
  const timeoutId = setT(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  const abortWithExternal = () => controller.abort();
  if (signal !== undefined) {
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener("abort", abortWithExternal, { once: true });
    }
  }
  try {
    const res = await f(url, {
      method: "GET",
      headers: { "User-Agent": USER_AGENT },
      signal: controller.signal,
    });
    if (!res.ok) {
      await res.text().catch(() => {});
      throw mapStatusError(res.status, DEFAULT_TIMEOUT_MS);
    }
    try {
      return await res.json();
    } catch (err) {
      // The timeout stays armed through body consumption; an abort here
      // is the injected timeout firing, not a malformed payload.
      if (controller.signal.aborted) throw err;
      throw new ApiError("Crossref returned a malformed response", 500);
    }
  } catch (err) {
    throw normalizeTransportError(err, DEFAULT_TIMEOUT_MS);
  } finally {
    if (signal !== undefined) {
      signal.removeEventListener("abort", abortWithExternal);
    }
    clearT(timeoutId);
    controller.abort();
  }
}
