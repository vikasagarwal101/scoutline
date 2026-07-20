/**
 * MiniMax Quota Client — Adapter-local direct transport (DESIGN.md §12, P4-02).
 *
 * The pinned `mmx-cli/sdk` 1.0.16 does not preserve an arbitrary
 * configured host for quota. This Module performs ONE direct GET against
 * `<baseUrl>/v1/api/openplatform/coding_plan/remains` with an
 * `Authorization: Bearer <apiKey>` header so `MINIMAX_BASE_URL` is
 * authoritative for quota. There is NO internal retry — shared execution
 * owns retry policy. Fetch and timer are injectable for tests.
 *
 * Phase A (A2): the previously named `MiniMaxQuotaClientDeps` is now an
 * alias for the unified `MiniMaxTransportDeps` declared in
 * `./coding-plan-client.ts`. Same four fields — rename, not superset —
 * so existing imports and call sites keep working unchanged.
 *
 * Boundary rules (ARCHITECTURE.md §2):
 *   - May import Adapter-local config and normalized errors.
 *   - Must NOT import `mmx-cli/sdk`, command presentation, or another
 *     Provider's Adapter.
 */

import type { MiniMaxConfig } from "./config.js";
import { ApiError, AuthError, NetworkError, TimeoutError } from "../../lib/errors.js";
import type { ProviderQuotaFetch } from "../types.js";
import type { MiniMaxTransportDeps } from "./coding-plan-client.js";

const QUOTA_PATH = "/v1/api/openplatform/coding_plan/remains";
const DEFAULT_TIMEOUT_MS = 30000;

/** Injectable fetch signature (shared duck-typed port). */
export type MiniMaxQuotaFetch = ProviderQuotaFetch;

/** Fetch response shape this transport consumes. */
export type MiniMaxQuotaFetchResponse = Awaited<ReturnType<MiniMaxQuotaFetch>>;

/**
 * Renamed alias for {@link MiniMaxTransportDeps} (Phase A — A2). The
 * two type names describe the same shape; the unified name wins at
 * the new `coding-plan-client.ts`, this name is preserved here so
 * existing imports keep resolving.
 */
export type MiniMaxQuotaClientDeps = MiniMaxTransportDeps;

/** Raw MiniMax quota response shape (remains endpoint). */
export interface MiniMaxRawQuotaResponse {
  model_remains?: unknown[];
}

function resolveTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = parseInt(env.MINIMAX_TIMEOUT || String(DEFAULT_TIMEOUT_MS), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

function mapStatusError(status: number): Error {
  if (status === 401 || status === 403) {
    return new AuthError("MiniMax quota API authentication failed");
  }
  return new ApiError("MiniMax quota API request failed", status);
}

function normalizeTransportError(err: unknown, timeoutMs: number): Error {
  if (err instanceof AuthError || err instanceof ApiError) return err;
  if (err instanceof Error) {
    if (err.name === "AbortError") {
      return new TimeoutError(timeoutMs);
    }
    const lower = err.message.toLowerCase();
    if (
      lower.includes("fetch") ||
      lower.includes("econnrefused") ||
      lower.includes("econnreset") ||
      lower.includes("enotfound") ||
      lower.includes("network")
    ) {
      return new NetworkError("MiniMax quota network error");
    }
  }
  return new ApiError("MiniMax quota request failed", 500);
}

/**
 * Perform ONE GET against the MiniMax remains endpoint. No retry; no
 * response body in public errors. Returns the parsed JSON body.
 */
export async function fetchMiniMaxQuota(
  config: MiniMaxConfig,
  deps: MiniMaxQuotaClientDeps = {},
): Promise<MiniMaxRawQuotaResponse> {
  const f = deps.fetch ?? (fetch as unknown as MiniMaxQuotaFetch);
  const setT = deps.setTimeout ?? setTimeout;
  const clearT = deps.clearTimeout ?? clearTimeout;
  const env = deps.env ?? process.env;
  const timeoutMs = resolveTimeoutMs(env);

  const url = `${config.baseUrl}${QUOTA_PATH}`;
  const controller = new AbortController();
  const timeoutId = setT(() => controller.abort(), timeoutMs);
  try {
    const res = await f(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${config.apiKey}` },
      signal: controller.signal,
    });
    clearT(timeoutId);
    if (!res.ok) {
      await res.text().catch(() => {});
      throw mapStatusError(res.status);
    }
    return (await res.json()) as MiniMaxRawQuotaResponse;
  } catch (err) {
    clearT(timeoutId);
    throw normalizeTransportError(err, timeoutMs);
  }
}
