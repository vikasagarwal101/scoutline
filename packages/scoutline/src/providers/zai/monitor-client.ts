/**
 * Z.AI Monitor API client — Provider-local transport (DESIGN.md §13, P4-02).
 *
 * This Module owns the Z.AI monitor endpoint fetch mechanics moved here
 * from `lib/monitor-client.ts`. It performs direct HTTP against
 * `https://api.z.ai` (overridable via `ZAI_MONITOR_BASE_URL`) with an
 * auth quirk: try the raw key first, and on 401 retry the same request
 * with a `Bearer` prefix. Every transport dependency (fetch, timer,
 * environment) is injectable so tests drive auth fallback and timeout
 * deterministically without touching globals.
 *
 * Boundary rules (ARCHITECTURE.md §2):
 *   - May import Provider identity types, normalized errors.
 *   - Must NOT import command presentation or another Provider's Adapter.
 *
 * Raw response text NEVER enters public errors. A non-2xx response is
 * mapped to a stable normalized error (`AuthError` for 401/403, `ApiError`
 * otherwise) whose message carries no response body. Transport failures
 * map to `TimeoutError`/`NetworkError`.
 *
 * This transport performs ONE logical attempt (including the auth-scheme
 * fallback). Shared execution owns retry policy.
 */

import { ApiError, AuthError, NetworkError, TimeoutError } from "../../lib/errors.js";
import type { ProviderQuotaFetch } from "../types.js";

const DEFAULT_MONITOR_BASE = "https://api.z.ai";
const DEFAULT_TIMEOUT_MS = 30000;

/** Injectable fetch signature (shared duck-typed port). */
export type ZaiMonitorFetch = ProviderQuotaFetch;

/** Fetch response shape this transport consumes. */
export type ZaiMonitorFetchResponse = Awaited<ReturnType<ZaiMonitorFetch>>;

/** Injectable transport dependencies. */
export interface ZaiMonitorDeps {
  readonly fetch?: ZaiMonitorFetch;
  readonly setTimeout?: typeof setTimeout;
  readonly clearTimeout?: typeof clearTimeout;
  readonly env?: NodeJS.ProcessEnv;
}

/** Raw Z.AI quota-limit response shape (monitor endpoint). */
export interface ZaiRawQuotaLimit {
  level?: string;
  limits?: unknown[];
}

function resolveBase(env: NodeJS.ProcessEnv): string {
  return env.ZAI_MONITOR_BASE_URL || DEFAULT_MONITOR_BASE;
}

function resolveTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = parseInt(env.Z_AI_TIMEOUT || String(DEFAULT_TIMEOUT_MS), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

function mapStatusError(status: number): Error {
  if (status === 401 || status === 403) {
    return new AuthError("Z.AI monitor API authentication failed");
  }
  return new ApiError("Z.AI monitor API request failed", status);
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
      return new NetworkError("Z.AI monitor network error");
    }
  }
  return new ApiError("Z.AI monitor request failed", 500);
}

/**
 * Perform one authenticated GET against the monitor API with the raw-key
 * then Bearer auth fallback. Returns the unwrapped `data` payload (or the
 * whole body when no `data` envelope is present).
 *
 * `path` is appended to the monitor base; `params` become query params.
 */
export async function fetchZaiMonitorPath(
  apiKey: string,
  path: string,
  params: Record<string, string> | undefined,
  deps: ZaiMonitorDeps = {},
): Promise<unknown> {
  const f = deps.fetch ?? (fetch as unknown as ZaiMonitorFetch);
  const setT = deps.setTimeout ?? setTimeout;
  const clearT = deps.clearTimeout ?? clearTimeout;
  const env = deps.env ?? process.env;
  const base = resolveBase(env);
  const timeoutMs = resolveTimeoutMs(env);

  const url = new URL(base + path);
  if (params) {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  }

  for (const authValue of [apiKey, `Bearer ${apiKey}`]) {
    const controller = new AbortController();
    const timeoutId = setT(() => controller.abort(), timeoutMs);
    try {
      const res = await f(url, {
        method: "GET",
        headers: {
          Authorization: authValue,
          "Accept-Language": "en-US,en",
          "Content-Type": "application/json",
        },
        signal: controller.signal,
      });
      clearT(timeoutId);

      if (res.status === 401 && authValue === apiKey) {
        // Auth-scheme fallback: retry the same request with Bearer.
        continue;
      }

      if (!res.ok) {
        // Drain the body so the connection can be reused, but NEVER let
        // the raw text reach a public error message.
        await res.text().catch(() => {});
        throw mapStatusError(res.status);
      }

      const body = (await res.json()) as { data?: unknown };
      return body.data ?? body;
    } catch (err) {
      clearT(timeoutId);
      throw normalizeTransportError(err, timeoutMs);
    }
  }
  throw new AuthError("Z.AI monitor API rejected both auth schemes");
}

/**
 * Fetch the Z.AI quota-limit payload (one attempt, auth-scheme fallback).
 */
export async function fetchZaiQuotaLimit(
  apiKey: string,
  deps: ZaiMonitorDeps = {},
): Promise<ZaiRawQuotaLimit> {
  return (await fetchZaiMonitorPath(
    apiKey,
    "/api/monitor/usage/quota/limit",
    undefined,
    deps,
  )) as ZaiRawQuotaLimit;
}
