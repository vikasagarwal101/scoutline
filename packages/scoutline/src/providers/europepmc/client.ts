/**
 * Europe PMC direct HTTP transport.
 *
 * GETs against the REST search endpoint
 * `https://www.ebi.ac.uk/europepmc/webservices/rest/search` (DESIGN D2
 * supplier table) consuming JSON. `format=json` is LOAD-BEARING and set
 * on every call: the endpoint defaults to XML. Europe PMC is keyless —
 * no credential model exists (`credentialEnvVars: []`).
 *
 * Politeness (DESIGN D2 politeness bullet): every request sends the
 * plain house `USER_AGENT` (`scoutline/${VERSION}`). The mailto-bearing
 * variants are OpenAlex (query param) and Crossref (UA-carried)
 * specifics — Europe PMC carries neither.
 *
 * Boundary rules (ARCHITECTURE.md §2), cloning the arXiv/OpenAlex/
 * Crossref client shape:
 *   - May import normalized errors and the provider fetch seam.
 *   - Must NOT perform response field normalization — the Adapter owns
 *     parsing. This module returns the parsed JSON document as unknown.
 */
import pkg from "../../../package.json" with { type: "json" };
import { ApiError, AuthError, NetworkError, QuotaError, TimeoutError } from "../../lib/errors.js";
import type { ProviderQuotaFetch } from "../types.js";
import { getGlobalFetch } from "../types.js";

const { version: VERSION } = pkg;

export const EUROPEPMC_SEARCH_URL = "https://www.ebi.ac.uk/europepmc/webservices/rest/search";
const DEFAULT_TIMEOUT_MS = 30000;
/** Plain house UA (DESIGN D2 politeness bullet; no mailto variant here). */
const USER_AGENT = `scoutline/${VERSION}`;

/** Injectable transport dependencies (fetch, timers). */
export interface EuropepmcTransportDeps {
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
    return new AuthError("Europe PMC rejected the request");
  }
  if (status === 408 || status === 504) {
    return new TimeoutError(timeoutMs);
  }
  if (status === 429) {
    return new QuotaError("Europe PMC rate-limited — keyless budget; a free key raises the limit (see `scoutline init`)");
  }
  return new ApiError("Europe PMC request failed", status);
}

/** Same transport-error normalization contract as the arXiv/OpenAlex/Crossref clients. */
function normalizeTransportError(error: unknown, timeoutMs: number): Error {
  if (error instanceof AuthError ||
    error instanceof ApiError ||
    error instanceof QuotaError ||
    error instanceof TimeoutError) {
    return error;
  }
  if (error instanceof Error && error.name === "AbortError") {
    return new TimeoutError(timeoutMs);
  }
  return new NetworkError("Europe PMC network error");
}

/**
 * Core GET against the search endpoint. `params` carries the composed
 * EuropePMC query terms (`query`, `pageSize`) — the Adapter maps
 * Provider-neutral science requests into them; `format=json` is forced
 * here because the endpoint defaults to XML. Single GET, no entity
 * route. Returns the parsed JSON document. No internal retry — shared
 * execution owns retry policy.
 */
export async function fetchEuropepmcJson(
  params: Record<string, string>,
  deps: EuropepmcTransportDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const f = deps.fetch ?? getGlobalFetch<ProviderQuotaFetch>();
  const setT = deps.setTimeout ?? setTimeout;
  const clearT = deps.clearTimeout ?? clearTimeout;
  const url = new URL(EUROPEPMC_SEARCH_URL);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  url.searchParams.set("format", "json");
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
      throw new ApiError("Europe PMC returned a malformed response", 500);
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
