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
 *   - May import normalized errors, the provider fetch seam, and the bounded-body lib helper.
 *   - Must NOT perform response field normalization — the Adapter owns
 *     parsing. This module returns the parsed JSON document as unknown.
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
    return new QuotaError("Europe PMC rate-limited — keyless service; retry later");
  }
  return new ApiError("Europe PMC request failed", status);
}

/** Same transport-error normalization contract as the arXiv/OpenAlex/Crossref clients. */
function normalizeTransportError(
  error: unknown,
  timeoutMs: number,
  timedOut = false,
  signal?: AbortSignal,
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
    if (signal?.aborted) {
      return new ApiError(
        "Europe PMC request was aborted by the caller (Ctrl-C or external signal)",
        499,
      );
    }
    if (timedOut) {
      return new TimeoutError(timeoutMs);
    }
    return new ApiError(
      "Europe PMC request was aborted by the caller (Ctrl-C or external signal)",
      499,
    );
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
function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

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
  // `core` result type (review): the default `lite` set omits
  // `abstractText`, so the adapter could never populate
  // `ScienceWork.summary`. `core` keeps the abstract in every record.
  url.searchParams.set("resultType", "core");
  // A pre-aborted caller signal must not reach the transport (review):
  // reject before the fetch is invoked at all.
  if (signal?.aborted) {
    throw new ApiError(
      "Europe PMC request was aborted by the caller (Ctrl-C or external signal)",
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
      readonly headers?: { get?(name: string): string | null };
      readonly body?: ReadableStream<Uint8Array> | null;
      text?(): Promise<string>;
      json?(): Promise<unknown>;
    };
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw mapStatusError(res.status, DEFAULT_TIMEOUT_MS);
    }
    const contentLengthHeader = res.headers?.get?.("content-length");
    if (contentLengthHeader && Number(contentLengthHeader) > MAX_BUFFERED_RESPONSE_BYTES) {
      await res.body?.cancel().catch(() => {});
      throw new ApiError(
        `Europe PMC response exceeds the 50MB in-memory ceiling (${contentLengthHeader} bytes declared) — refusing to buffer`,
        413,
      );
    }
    try {
      if (res.body) {
        let buf;
        try {
          buf = await readBoundedResponseBody(
            res.body,
            MAX_BUFFERED_RESPONSE_BYTES,
            "Europe PMC response",
          );
        } catch (err) {
          if (err instanceof ValidationError) {
            throw new ApiError(
              "Europe PMC response exceeds the 50MB in-memory ceiling (stream exceeded it mid-read) — refusing to buffer",
              413,
            );
          }
          throw err;
        }
        return JSON.parse(stripBom(buf.toString("utf8")));
      }
      if (typeof res.text === "function") {
        return JSON.parse(stripBom(await res.text()));
      }
      if (typeof res.json === "function") {
        return await res.json();
      }
      return {};
    } catch (err) {
      // The timeout stays armed through body consumption; an abort here
      // may be the injected timeout firing OR a caller cancel. A caller
      // cancel can surface as a raw non-AbortError (undici "terminated"
      // TypeError) — classify by abort SOURCE, not error shape: a caller
      // cancel is never a network failure.
      if (controller.signal.aborted && signal?.aborted) {
        throw new ApiError(
          "Europe PMC request was aborted by the caller (Ctrl-C or external signal)",
          499,
        );
      }
      if (controller.signal.aborted && !timedOut) {
        throw new ApiError(
          "Europe PMC request was aborted by the caller (Ctrl-C or external signal)",
          499,
        );
      }
      if (controller.signal.aborted) throw err;
      if (err instanceof ApiError || err instanceof ValidationError) throw err;
      throw new ApiError("Europe PMC returned a malformed response", 500);
    }
  } catch (err) {
    throw normalizeTransportError(err, DEFAULT_TIMEOUT_MS, timedOut, signal);
  } finally {
    if (signal !== undefined) {
      signal.removeEventListener("abort", abortWithExternal);
    }
    clearT(timeoutId);
    controller.abort();
  }
}
