/**
 * OpenAlex direct HTTP transport.
 *
 * GETs against `https://api.openalex.org/works` (DESIGN D2 supplier
 * table) consuming JSON. OpenAlex is keyless-by-default with an
 * optional `OPENALEX_API_KEY` upgrade: with no key the request carries
 * the politeness `mailto=` query param (house contact address, D2
 * politeness bullet); with a key the `api_key=` query param replaces
 * it (OpenAlex consumes the key as a query param, not a header). The
 * house `USER_AGENT` rides every request either way.
 *
 * Boundary rules (ARCHITECTURE.md §2), cloning the arXiv client shape:
 *   - May import normalized errors and the provider fetch seam.
 *   - Must NOT perform response field normalization — the Adapter owns
 *     parsing. This module returns the parsed JSON document as unknown.
 */
import pkg from "../../../package.json" with { type: "json" };
import { ApiError, AuthError, NetworkError, QuotaError, TimeoutError } from "../../lib/errors.js";
import type { ProviderQuotaFetch } from "../types.js";
import { getGlobalFetch } from "../types.js";

const { version: VERSION } = pkg;

export const OPENALEX_WORKS_URL = "https://api.openalex.org/works";
const DEFAULT_TIMEOUT_MS = 30000;
const USER_AGENT = `scoutline/${VERSION}`;
/** House contact address for the OpenAlex polite pool (D2 politeness). */
const OPENALEX_MAILTO = "scoutline@localhost";

/** Injectable transport dependencies (fetch, timers). */
export interface OpenalexTransportDeps {
  readonly fetch?: ProviderQuotaFetch;
  readonly setTimeout?: typeof setTimeout;
  readonly clearTimeout?: typeof clearTimeout;
}

/** Credential resolved per invocation from the injected env. */
export interface OpenalexCredentials {
  /** `OPENALEX_API_KEY` when present; keyless otherwise. */
  readonly apiKey?: string;
}

export function resolveOpenalexCredentials(env: NodeJS.ProcessEnv): OpenalexCredentials {
  const apiKey = env["OPENALEX_API_KEY"];
  return apiKey === undefined || apiKey === "" ? {} : { apiKey };
}

/**
 * Layer 1 — HTTP-status mapping, before the body is consumed. 401/403
 * → AuthError; 408/504 → TimeoutError; other 4xx/5xx → ApiError with
 * the real status preserved for the shared retry classifier.
 */
function mapStatusError(status: number, timeoutMs: number): Error {
  if (status === 401 || status === 403) {
    return new AuthError("OpenAlex rejected the request");
  }
  if (status === 408 || status === 504) {
    return new TimeoutError(timeoutMs);
  }
  if (status === 429) {
    return new QuotaError(
      "OpenAlex rate-limited — keyless budget; a free key raises the limit (see `scoutline init`)",
    );
  }
  if (status === 503) {
    // Remedy (owner ruling): anonymous search may be paused under load —
    // the free key via `scoutline init` restores it. The class stays
    // ApiError (the mapping pin) — only the message carries the remedy.
    return new ApiError(
      "OpenAlex request failed (anonymous search may be paused under load — a free API key via `scoutline init` restores it)",
      status,
    );
  }
  return new ApiError("OpenAlex request failed", status);
}

/** Same transport-error normalization contract as the arXiv client. */
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
  return new NetworkError("OpenAlex network error");
}

/**
 * Core GET. `params` carries OpenAlex-native query parameters (search,
 * filter, per-page — the Adapter maps Provider-neutral science
 * requests into these); `path` addresses an entity route for
 * identifier-addressed gets (e.g. `doi:10.1038/...`). Returns the
 * parsed JSON document. No internal retry — shared execution owns
 * retry policy.
 */
/**
 * Percent-encode one entity-route path segment, preserving `/` at the
 * caller. Encodes the URL-delimiter characters (`?`, `#`) and a stray
 * `%` (keeps the segment unambiguous); leaves the `doi:` prefix colon
 * and DOI-legal punctuation readable.
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

export async function fetchOpenalexJson(
  params: Record<string, string>,
  deps: OpenalexTransportDeps & { readonly env?: NodeJS.ProcessEnv } = {},
  signal?: AbortSignal,
  path = "",
): Promise<unknown> {
  const f = deps.fetch ?? getGlobalFetch<ProviderQuotaFetch>();
  const setT = deps.setTimeout ?? setTimeout;
  const clearT = deps.clearTimeout ?? clearTimeout;
  const { apiKey } = resolveOpenalexCredentials(deps.env ?? {});
  // Entity-route path segments are percent-encoded (review): a DOI
  // suffix containing `?` or `#` would otherwise be truncated into the
  // query/fragment by `new URL`. `/` separators are preserved, and the
  // `doi:` prefix colon stays readable.
  const url = new URL(
    `${OPENALEX_WORKS_URL}${
      path ? `/${path.replace(/^\/+/, "").split("/").map(encodePathSegment).join("/")}` : ""
    }`,
  );
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  // Politeness (D2): mailto whenever keyless; api_key replaces it when
  // the upgrade key is present (never both).
  if (apiKey !== undefined) {
    url.searchParams.set("api_key", apiKey);
  } else {
    url.searchParams.set("mailto", OPENALEX_MAILTO);
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
      throw new ApiError("OpenAlex returned a malformed response", 500);
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
