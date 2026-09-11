/**
 * PubMed (eutils) direct HTTP transport.
 *
 * GETs against the eutils base `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/`
 * (DESIGN D2 supplier table). Two endpoints, two body modes:
 *   - `esearch.fcgi` with `retmode=json` — the id-list envelope (the PRD
 *     verbatim wire evidence: `{"esearchresult":{"count":…,"idlist":[…]}}`).
 *     Consumed as JSON.
 *   - `efetch.fcgi` with `retmode=xml` — the record-carrying step
 *     (PubmedArticleSet XML). efetch `retmode=json` returns only the
 *     bare id list, and esummary `retmode=json` — though it does carry
 *     title/authors/venue/pubtype — carries no AbstractText (live
 *     eutils probe 2026-09-11), so XML is the only record-complete
 *     mode. Consumed as TEXT via `text()`; the Adapter owns parsing.
 *
 * Credential model (DESIGN D2 + D4b note): keyless 3 r/s by default; a
 * free `NCBI_API_KEY` lifts the rate limit to 10 r/s. eutils consumes
 * the key as an `api_key=` QUERY PARAM (not a header), so it rides the
 * URL alongside the request params whenever present. The house
 * `scoutline/${VERSION}` User-Agent rides every request either way
 * (D2 politeness).
 *
 * Boundary rules (ARCHITECTURE.md §2), cloning the arXiv/OpenAlex
 * client shape:
 *   - May import normalized errors and the provider fetch seam.
 *   - Must NOT perform response field normalization — the Adapter owns
 *     parsing. This module returns the parsed esearch JSON as unknown
 *     and the raw efetch XML string.
 */
import pkg from "../../../package.json" with { type: "json" };
import { ApiError, AuthError, NetworkError, QuotaError, TimeoutError } from "../../lib/errors.js";
import type { ProviderQuotaFetch } from "../types.js";
import { getGlobalFetch } from "../types.js";

const { version: VERSION } = pkg;

export const EUTILS_BASE_URL = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/";
const DEFAULT_TIMEOUT_MS = 30000;
const USER_AGENT = `scoutline/${VERSION}`;

/** Injectable transport dependencies (fetch, timers). */
export interface PubmedTransportDeps {
  readonly fetch?: ProviderQuotaFetch;
  readonly setTimeout?: typeof setTimeout;
  readonly clearTimeout?: typeof clearTimeout;
}

/** Credential resolved per invocation from the injected env. */
export interface PubmedCredentials {
  /** `NCBI_API_KEY` when present; keyless (3 r/s) otherwise. */
  readonly apiKey?: string;
}

export function resolvePubmedCredentials(env: NodeJS.ProcessEnv): PubmedCredentials {
  const apiKey = env["NCBI_API_KEY"];
  return apiKey === undefined || apiKey === "" ? {} : { apiKey };
}

/**
 * Layer 1 — HTTP-status mapping, before the body is consumed. 401/403
 * → AuthError; 408/504 → TimeoutError; other 4xx/5xx → ApiError with
 * the real status preserved for the shared retry classifier.
 */
function mapStatusError(status: number, timeoutMs: number): Error {
  if (status === 401 || status === 403) {
    return new AuthError("PubMed rejected the request");
  }
  if (status === 408 || status === 504) {
    return new TimeoutError(timeoutMs);
  }
  if (status === 429) {
    return new QuotaError(
      "PubMed rate-limited — keyless budget; a free key raises the limit (see `scoutline init`)",
    );
  }
  return new ApiError("PubMed request failed", status);
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
  return new NetworkError("PubMed network error");
}

/** eutils endpoint selector — the two steps of the D2 two-step contract. */
type EutilsEndpoint = "esearch.fcgi" | "efetch.fcgi";

/**
 * Core GET against one eutils endpoint. `params` carries eutils-native
 * query parameters (db, term, retmode, id, retmax — the Adapter maps
 * Provider-neutral science requests into these). Returns the esearch
 * JSON document (asText=false) or the raw efetch XML string
 * (asText=true). No internal retry — shared execution owns retry
 * policy.
 */
async function eutilsRequest(
  endpoint: EutilsEndpoint,
  params: Record<string, string>,
  deps: PubmedTransportDeps & { readonly env?: NodeJS.ProcessEnv } = {},
  signal?: AbortSignal,
  asText = false,
): Promise<unknown> {
  const f = deps.fetch ?? getGlobalFetch<ProviderQuotaFetch>();
  const setT = deps.setTimeout ?? setTimeout;
  const clearT = deps.clearTimeout ?? clearTimeout;
  const { apiKey } = resolvePubmedCredentials(deps.env ?? {});
  const url = new URL(endpoint, EUTILS_BASE_URL);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  // eutils consumes the key as a query param, never a header.
  if (apiKey !== undefined) url.searchParams.set("api_key", apiKey);
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
      return asText ? await res.text() : await res.json();
    } catch (err) {
      // The timeout stays armed through body consumption; an abort here
      // is the injected timeout firing, not a malformed payload.
      if (controller.signal.aborted) throw err;
      throw new ApiError("PubMed returned a malformed response", 500);
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

/**
 * esearch step: the id-list lookup. Returns the parsed JSON envelope
 * (`esearchresult.idlist`); the Adapter extracts the ids.
 */
export async function fetchPubmedEsearch(
  params: Record<string, string>,
  deps: PubmedTransportDeps & { readonly env?: NodeJS.ProcessEnv } = {},
  signal?: AbortSignal,
): Promise<unknown> {
  return eutilsRequest("esearch.fcgi", params, deps, signal, false);
}

/**
 * efetch step: the record fetch (PubmedArticleSet XML). Returns the raw
 * XML string; the Adapter's hand parser owns field extraction.
 */
export async function fetchPubmedEfetch(
  params: Record<string, string>,
  deps: PubmedTransportDeps & { readonly env?: NodeJS.ProcessEnv } = {},
  signal?: AbortSignal,
): Promise<string> {
  return (await eutilsRequest("efetch.fcgi", params, deps, signal, true)) as string;
}
