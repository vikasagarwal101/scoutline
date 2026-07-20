/**
 * MiniMax Coding Plan direct transport (DESIGN.md §12, P4-02).
 *
 * The pinned `mmx-cli/sdk` 1.0.16 does not preserve an arbitrary
 * configured host for the Coding Plan endpoints. This module performs
 * direct POSTs against the two `/v1/coding_plan/*` endpoints with an
 * `Authorization: Bearer <apiKey>` header so `MINIMAX_BASE_URL` is
 * authoritative. There is NO internal retry — shared execution owns
 * retry policy. Fetch and timer are injectable for tests.
 *
 * Mirrors `providers/minimax/quota-client.ts` line-for-line in
 * structure; that module is the canon direct-transport pattern. The
 * `MiniMaxTransportDeps` shape is the renamed `MiniMaxQuotaClientDeps`
 * (same four fields — rename, not superset).
 *
 * Boundary rules (ARCHITECTURE.md §2):
 *   - May import Adapter-local config and normalized errors.
 *   - May import `ProviderQuotaFetch` from `providers/types.ts`.
 *   - Must NOT import `mmx-cli/sdk`, command presentation, or another
 *     Provider's Adapter.
 *   - Must NOT perform field normalization — the Adapter owns that.
 */

import { createRequire } from "node:module";

import type { MiniMaxConfig } from "./config.js";
import {
  ApiError,
  AuthError,
  NetworkError,
  QuotaError,
  TimeoutError,
} from "../../lib/errors.js";
import type { ProviderQuotaFetch } from "../types.js";

const require = createRequire(import.meta.url);
const { version: VERSION } = require("../../../package.json") as { version: string };

const SEARCH_PATH = "/v1/coding_plan/search";
const VLM_PATH = "/v1/coding_plan/vlm";
const DEFAULT_TIMEOUT_MS = 30000;

const MM_API_SOURCE = "Scoutline";
const USER_AGENT = `scoutline/${VERSION}`;
const TIMEOUT_HELP_TEXT = "Try again or increase timeout with MINIMAX_TIMEOUT env var";

/** Injectable transport dependencies (renamed from `MiniMaxQuotaClientDeps`). */
export interface MiniMaxTransportDeps {
  readonly fetch?: ProviderQuotaFetch;
  readonly setTimeout?: typeof setTimeout;
  readonly clearTimeout?: typeof clearTimeout;
  readonly env?: NodeJS.ProcessEnv;
}

/** Raw MiniMax search response shape (search endpoint). */
export interface MiniMaxRawSearchResponse {
  organic?: unknown[];
  related_searches?: unknown[];
  base_resp?: unknown;
}

/** Raw MiniMax VLM response shape (vision-language endpoint). */
export interface MiniMaxRawVlmResponse {
  content?: unknown;
  base_resp?: unknown;
}

function resolveTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = parseInt(env.MINIMAX_TIMEOUT || String(DEFAULT_TIMEOUT_MS), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

/**
 * Layer 1 — HTTP-status mapping. Runs BEFORE the body is parsed; on a
 * non-200 response we discard the body and throw a typed error.
 *
 * `timeoutMs` is forwarded so 408/504 can throw `TimeoutError`
 * carrying the configured duration (and the `MINIMAX_TIMEOUT` help
 * text). The transport never embeds credential material in any
 * error message.
 */
function mapStatusError(status: number, timeoutMs: number): Error {
  if (status === 401 || status === 403) {
    return new AuthError("MiniMax authentication failed", "MINIMAX_API_KEY");
  }
  if (status === 408 || status === 504) {
    return new TimeoutError(timeoutMs, TIMEOUT_HELP_TEXT);
  }
  if (status === 429) {
    return new ApiError("MiniMax rate limit exceeded", 429);
  }
  if (status === 400 || status === 404 || status === 410 || status === 422) {
    return new ApiError("MiniMax request failed", status);
  }
  if (status >= 500) {
    return new ApiError("MiniMax request failed", status);
  }
  return new ApiError("MiniMax request failed", status);
}

/**
 * Layer 2 — `base_resp.status_code` mapping. Runs ONLY when HTTP 200
 * AND body parses as JSON. If body is missing `base_resp`, the body
 * is treated as malformed and a 500-status `ApiError` is thrown.
 */
function mapBaseRespError(statusCode: unknown): Error | null {
  if (statusCode === 0 || statusCode === undefined || statusCode === null) {
    // status_code === 0 is success; undefined/null are also treated as
    // "no business error" so a missing-but-present `base_resp` with no
    // status_code field doesn't break the success path. The malformed
    // branch handles the missing-`base_resp`-entirely case.
    return null;
  }
  if (typeof statusCode !== "number" || !Number.isFinite(statusCode)) {
    return new ApiError("MiniMax returned a malformed response", 500);
  }
  if (statusCode === 1002 || statusCode === 1039) {
    return new ApiError("MiniMax content filter rejected the request", 400);
  }
  if (statusCode === 1004) {
    return new AuthError("MiniMax authentication failed", "MINIMAX_API_KEY");
  }
  if (statusCode === 1028 || statusCode === 1030) {
    return new QuotaError();
  }
  if (statusCode === 2038) {
    return new ApiError(
      "MiniMax account requires real-name verification. Visit https://platform.minimaxi.com/user-center/basic-information to resolve.",
      403,
    );
  }
  if (statusCode === 2061) {
    return new ApiError("MiniMax model not available on current Token Plan", 403);
  }
  return new ApiError("MiniMax request failed", 500);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getBaseRespStatusCode(body: unknown): {
  statusCode: unknown;
  malformed: boolean;
} {
  if (!isPlainObject(body)) {
    return { statusCode: undefined, malformed: true };
  }
  const baseResp = body.base_resp;
  if (baseResp === undefined) {
    return { statusCode: undefined, malformed: true };
  }
  if (!isPlainObject(baseResp)) {
    return { statusCode: undefined, malformed: true };
  }
  return { statusCode: baseResp.status_code, malformed: false };
}

function normalizeTransportError(err: unknown, timeoutMs: number): Error {
  if (
    err instanceof AuthError ||
    err instanceof ApiError ||
    err instanceof QuotaError ||
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
      return new NetworkError("MiniMax network error");
    }
  }
  return new ApiError("MiniMax request failed", 500);
}

async function postCodingPlanJson(
  config: MiniMaxConfig,
  path: string,
  body: Record<string, unknown>,
  deps: MiniMaxTransportDeps,
  endpointLabel: "search" | "vlm",
): Promise<unknown> {
  const f = deps.fetch ?? (fetch as unknown as ProviderQuotaFetch);
  const setT = deps.setTimeout ?? setTimeout;
  const clearT = deps.clearTimeout ?? clearTimeout;
  const env = deps.env ?? process.env;
  const timeoutMs = resolveTimeoutMs(env);

  const url = `${config.baseUrl}${path}`;
  const controller = new AbortController();
  const timeoutId = setT(() => controller.abort(), timeoutMs);
  try {
    const res = await f(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        "MM-API-Source": MM_API_SOURCE,
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
      throw new ApiError(
        `MiniMax ${endpointLabel} returned a malformed response`,
        500,
      );
    }
    const { statusCode, malformed } = getBaseRespStatusCode(parsed);
    if (malformed) {
      throw new ApiError(
        `MiniMax ${endpointLabel} returned a malformed response`,
        500,
      );
    }
    const mapped = mapBaseRespError(statusCode);
    if (mapped) {
      throw mapped;
    }
    return parsed;
  } catch (err) {
    clearT(timeoutId);
    throw normalizeTransportError(err, timeoutMs);
  }
}

/**
 * Perform ONE POST against the MiniMax Coding Plan search endpoint. No
 * retry; no response body in public errors. Returns the parsed JSON
 * body (raw; the Adapter post-processes into normalized search
 * sources).
 */
export async function fetchMiniMaxSearch(
  config: MiniMaxConfig,
  query: string,
  deps: MiniMaxTransportDeps = {},
): Promise<MiniMaxRawSearchResponse> {
  return postCodingPlanJson(
    config,
    SEARCH_PATH,
    { q: query },
    deps,
    "search",
  ) as Promise<MiniMaxRawSearchResponse>;
}

/**
 * Perform ONE POST against the MiniMax Coding Plan VLM endpoint. No
 * retry; no response body in public errors. Returns the parsed JSON
 * body (raw; the Adapter post-processes the content field).
 *
 * `image` is the pre-resolved data URI produced by the Adapter's
 * `convertToDataUri` step. The transport does NOT perform any
 * data-URI conversion.
 */
export async function fetchMiniMaxVlm(
  config: MiniMaxConfig,
  image: string,
  prompt: string,
  deps: MiniMaxTransportDeps = {},
): Promise<MiniMaxRawVlmResponse> {
  return postCodingPlanJson(
    config,
    VLM_PATH,
    { prompt, image_url: image },
    deps,
    "vlm",
  ) as Promise<MiniMaxRawVlmResponse>;
}