/**
 * Jina AI Quota Capability (8J.5 telemetry half).
 *
 * Jina has no dedicated `/usage` endpoint. Quota is derived from the two
 * rate-limit response headers documented in the OpenAPI schema
 * (api.jina.ai/openapi.json):
 *
 *   `X-RateLimit-Remaining-Requests` — remaining requests in the current
 *   per-minute window.
 *   `X-RateLimit-Remaining-Tokens` — remaining tokens in the current
 *   per-minute window.
 *
 * The documented rate-limit tiers (per OpenAPI schema) are used to infer
 * the limit (since Jina exposes only remaining, not limit):
 *
 *   Free:   500 RPM,   1M TPM
 *   Tier 1: 500 RPM,  10M TPM
 *   Tier 2: 5,000 RPM, 100M TPM
 *
 * The tier is inferred from the remaining values: if remaining RPM > 500,
 * the user must be on Tier 2 (limit 5000). Similarly for tokens: if
 * remaining TPM > 10M, must be Tier 2; if > 1M, must be Tier 1 or above.
 *
 * **Header-name correction (lesson 0.14.8):** finding 8J.5 claimed
 * `x-ratelimit-limit`, `x-ratelimit-remaining`, `x-usage-tokens`. The
 * OpenAPI schema contradicts this — see {@link JinaRateLimitHeaders}.
 *
 * Boundary rules (ARCHITECTURE.md §2):
 *   - May import the quota capability contract, Adapter-local config,
 *     Adapter-local quota client, and normalized errors.
 *   - Must NOT import command presentation or another Provider's Adapter.
 */

import type {
  ProviderQuotaSuccess,
  QuotaCapability,
  QuotaCategory,
} from "../../capabilities/quota.js";
import { buildQuotaWindow } from "../../capabilities/quota.js";
import {
  ApiError,
  AuthError,
  ConfigurationError,
  NetworkError,
  ScoutlineError,
  TimeoutError,
} from "../../lib/errors.js";
import { resolveJinaApiKey } from "./credentials.js";
import { fetchJinaRateLimit, type JinaTransportDeps } from "./client.js";

/**
 * Caveat attached to every Jina quota result: the numbers reflect a
 * per-minute rate-limit window (remaining RPM/TPM), NOT total account
 * quota or credits consumed. Surfaced to stderr by the provider-neutral
 * quota command, mirroring Brave's caveat.
 */
export const JINA_QUOTA_CAVEAT =
  "Jina quota reflects a per-minute rate-limit window (remaining RPM/TPM), not total account quota or credits consumed.";

/**
 * Error thrown when rate-limit headers are absent or unparseable. Jina's
 * headers are the only quota signal, so a missing/malformed set is
 * unrecoverable: surface `QUOTA_ERROR` rather than guessing.
 */
function jinaQuotaParseError(): ScoutlineError {
  return new ScoutlineError("Jina AI rate-limit headers could not be parsed", "QUOTA_ERROR", {
    exitCode: 1,
  });
}

// ---------------------------------------------------------------------------
// Rate-limit tier inference
// ---------------------------------------------------------------------------

/**
 * Documented RPM limits per tier (OpenAPI schema).
 * Free: 500, Tier 1: 500, Tier 2: 5,000.
 */
const TIER_RPM_LIMITS = [500, 5000] as const;

/**
 * Documented TPM limits per tier (OpenAPI schema).
 * Free: 1M, Tier 1: 10M, Tier 2: 100M.
 */
const TIER_TPM_LIMITS = [1_000_000, 10_000_000, 100_000_000] as const;

/**
 * Infer the smallest documented limit that is >= the remaining value.
 * Since remaining ≤ limit, the user's actual limit must be at least
 * `remaining`. Among the documented tiers, the smallest limit ≥ remaining
 * is the best inference.
 *
 * Returns null when remaining exceeds all documented limits (shouldn't
 * happen for valid API responses, but handled defensively).
 */
function inferLimit(remaining: number, documentedLimits: readonly number[]): number | null {
  // Find the smallest documented limit >= remaining.
  for (const limit of documentedLimits) {
    if (remaining <= limit) return limit;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Normalizer
// ---------------------------------------------------------------------------

/**
 * Normalize Jina's `X-RateLimit-Remaining-*` headers into the shared
 * quota interface.
 *
 * Produces up to two categories:
 *   - "rate_limit_requests" (unit: requests) — from
 *     `X-RateLimit-Remaining-Requests`.
 *   - "rate_limit_tokens" (unit: tokens) — from
 *     `X-RateLimit-Remaining-Tokens`.
 *
 * Each category infers the tier limit from the remaining value, computes
 * `used = limit - remaining`, and sets `durationSeconds = 60` (per-minute
 * window). Throws `QUOTA_ERROR` when both headers are absent or when the
 * inferred limit is null (remaining exceeds all documented tiers).
 *
 * **Limitation:** tier inference from remaining alone is inherently
 * imprecise — a high-tier account that has consumed most of its window
 * is indistinguishable from a lower-tier account. This is a fundamental
 * constraint of Jina's remaining-only header model (no limit header).
 */
export function normalizeJinaQuota(
  headers: { readonly remainingRequests: number | null; readonly remainingTokens: number | null },
): ProviderQuotaSuccess {
  const categories: QuotaCategory[] = [];

  if (headers.remainingRequests !== null) {
    const limit = inferLimit(headers.remainingRequests, TIER_RPM_LIMITS);
    if (limit === null) throw jinaQuotaParseError();
    const used = limit - headers.remainingRequests;
    categories.push({
      name: "rate_limit_requests",
      unit: "requests",
      current: buildQuotaWindow({
        used,
        limit,
        durationSeconds: 60,
      }),
    });
  }

  if (headers.remainingTokens !== null) {
    const limit = inferLimit(headers.remainingTokens, TIER_TPM_LIMITS);
    if (limit === null) throw jinaQuotaParseError();
    const used = limit - headers.remainingTokens;
    categories.push({
      name: "rate_limit_tokens",
      unit: "tokens",
      current: buildQuotaWindow({
        used,
        limit,
        durationSeconds: 60,
      }),
    });
  }

  if (categories.length === 0) {
    throw jinaQuotaParseError();
  }

  return {
    provider: "jina",
    status: "ok",
    categories,
    warnings: [JINA_QUOTA_CAVEAT],
  };
}

// ---------------------------------------------------------------------------
// Capability factory
// ---------------------------------------------------------------------------

/**
 * Map a thrown error into a normalized Jina quota failure. Typed transport
 * errors pass through verbatim, as does any {@link ScoutlineError}.
 */
function normalizeJinaQuotaError(error: unknown): Error {
  if (
    error instanceof ScoutlineError ||
    error instanceof AuthError ||
    error instanceof ApiError ||
    error instanceof NetworkError ||
    error instanceof TimeoutError ||
    error instanceof ConfigurationError
  ) {
    return error;
  }
  return new ApiError("Jina AI quota request failed", 500);
}

/**
 * Options for the Jina QuotaCapability. The API key is resolved from
 * `env`; transport dependencies (`fetch`, timer) are injectable for
 * deterministic tests through the unified `transport` seam.
 */
export interface JinaQuotaCapabilityOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly transport?: JinaTransportDeps;
}

/**
 * Build the Jina QuotaCapability. `invoke` resolves the API key (required —
 * the probe uses Search, which is not keyless), performs one direct Search
 * probe, reads the `X-RateLimit-Remaining-*` headers, and normalizes them
 * into the shared interface. Shared execution wraps this in the retry
 * policy; quota never uses the response cache.
 */
export function createJinaQuotaCapability(options: JinaQuotaCapabilityOptions): QuotaCapability {
  const { env, transport } = options;
  return {
    async invoke(): Promise<ProviderQuotaSuccess> {
      const apiKey = resolveJinaApiKey(env);
      if (!apiKey) {
        throw new ConfigurationError(
          "Jina AI quota requires JINA_API_KEY (the probe uses the Search endpoint, which is not keyless).",
          "Set JINA_API_KEY to enable Jina quota reporting.",
        );
      }
      try {
        const headers = await fetchJinaRateLimit(apiKey, transport);
        return normalizeJinaQuota(headers);
      } catch (error) {
        throw normalizeJinaQuotaError(error);
      }
    },
  };
}
