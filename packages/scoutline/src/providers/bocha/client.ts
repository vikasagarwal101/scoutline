/**
 * Bocha AI direct HTTP transport.
 *
 * POST /v1/web-search — Bing-compatible wrapped web search. The JSON
 * envelope carries `{ code, msg, data }`; results live at
 * `data.webPages.value[]`. Application-level envelope codes are the
 * adapter's concern (see adapter.ts normalization); this module owns
 * the HTTP status mapping.
 */

import pkg from "../../../package.json" with { type: "json" };
import {
  ApiError,
  ConfigurationError,
  NetworkError,
  QuotaError,
  TimeoutError,
  ValidationError,
} from "../../lib/errors.js";
import type { ProviderQuotaFetchResponse } from "../types.js";

const { version: VERSION } = pkg;

const BASE_URL = "https://api.bochaai.com/v1";
const DEFAULT_TIMEOUT_MS = 30000;
const MISSING_KEY_HELP = 'export BOCHA_API_KEY="your-bocha-api-key"';

const USER_AGENT = `scoutline/${VERSION}`;

export interface BochaTransportDeps {
  readonly fetch?: (
    input: string,
    init: Record<string, unknown>,
  ) => Promise<ProviderQuotaFetchResponse>;
  readonly setTimeout?: typeof setTimeout;
  readonly clearTimeout?: typeof clearTimeout;
  readonly env?: NodeJS.ProcessEnv;
}

/** One Bing-shaped page row inside `data.webPages.value[]`. */
export interface BochaWebPageItem {
  readonly id?: string;
  readonly name?: string;
  readonly url?: string;
  readonly siteName?: string;
  readonly snippet?: string;
  readonly summary?: string;
  readonly dateLastCrawled?: string;
}

/**
 * Wrapped Bing-compatible envelope. Results live at
 * `data.webPages.value[]` (SCHEMA.md — pinned, never the JSON root).
 */
export interface BochaSearchResponse {
  readonly code?: number;
  readonly msg?: string;
  readonly data?: {
    readonly webPages?: { readonly value?: readonly BochaWebPageItem[] };
  };
  readonly webPages?: { readonly value?: readonly BochaWebPageItem[] };
}

export interface BochaSearchParams {
  readonly query: string;
  readonly freshness?: "noLimit" | "oneDay" | "oneWeek" | "oneMonth" | "oneYear";
  readonly summary?: boolean;
  readonly count?: number;
}

function resolveTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = parseInt(env.BOCHA_TIMEOUT || String(DEFAULT_TIMEOUT_MS), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

/**
 * HTTP status → normalized Scoutline error (ERROR_HANDLING.md §1).
 * Curated constant messages only — the raw Provider body never enters
 * an error message.
 */
function mapStatusError(status: number): Error {
  if (status === 401) {
    return new ConfigurationError("Bocha AI rejected the API key (HTTP 401)", MISSING_KEY_HELP);
  }
  if (status === 403) {
    return new QuotaError("Bocha AI account balance is insufficient (HTTP 403)");
  }
  if (status === 429) {
    return new ApiError("Bocha AI rate limit exceeded (HTTP 429)", 429);
  }
  if (status === 400) {
    return new ValidationError("Bocha AI rejected the request as invalid (HTTP 400)");
  }
  return new ApiError(`Bocha AI request failed (${status})`, status);
}

export async function fetchBochaWebSearch(
  apiKey: string,
  params: BochaSearchParams,
  deps: BochaTransportDeps = {},
): Promise<BochaSearchResponse> {
  const fetchFn = deps.fetch || globalThis.fetch;
  const setTimer = deps.setTimeout || globalThis.setTimeout;
  const clearTimer = deps.clearTimeout || globalThis.clearTimeout;
  const env = deps.env || process.env;
  const timeoutMs = resolveTimeoutMs(env);

  const url = `${BASE_URL}/web-search`;
  const controller = new AbortController();
  const timer = setTimer(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchFn(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify(params),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw mapStatusError(response.status);
    }

    const text = await response.text();
    const parsed = JSON.parse(text) as BochaSearchResponse;
    // Success only when HTTP 2xx AND (code undefined or code === 200).
    // HTTP 200 + application code 401 is still a credential failure.
    if (parsed.code !== undefined && parsed.code !== 200) {
      if (parsed.code === 401) {
        throw new ConfigurationError(
          "Bocha AI rejected the API key (application code 401)",
          MISSING_KEY_HELP,
        );
      }
      throw new ApiError(`Bocha AI web-search failed (application code ${parsed.code})`, 502);
    }
    return parsed;
  } catch (err: unknown) {
    if (
      err instanceof ApiError ||
      err instanceof TimeoutError ||
      err instanceof ConfigurationError ||
      err instanceof QuotaError ||
      err instanceof ValidationError
    ) {
      throw err;
    }
    if (err instanceof SyntaxError) {
      throw new ApiError("Bocha AI returned a malformed JSON response", 500);
    }
    if (err instanceof Error && err.name === "AbortError") {
      throw new TimeoutError(timeoutMs, "Try again or increase timeout with BOCHA_TIMEOUT env var");
    }
    throw new NetworkError(
      `Bocha AI search failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimer(timer);
  }
}
