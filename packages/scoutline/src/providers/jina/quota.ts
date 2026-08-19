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
 * Jina exposes ONLY remaining, never a limit. The limit is therefore
 * published as EXPLICITLY UNKNOWN (GitHub #49): the shared interface
 * carries the exact `remaining` value and omits `used`, `limit`, and
 * `remainingPercent`. The documented rate-limit tiers (Free 500 RPM /
 * 1M TPM, Tier 1 500 RPM / 10M TPM, Tier 2 5,000 RPM / 100M TPM) are
 * deliberately NOT used to infer the limit — a paid Tier-2 account
 * whose remaining has fallen below a smaller tier's ceiling would be
 * misreported against that smaller tier, and two independently
 * inferred headers can even disagree. No authoritative plan/limit
 * signal exists to consult, so none is fabricated.
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
import { ApiError, ConfigurationError, ScoutlineError } from "../../lib/errors.js";
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
 * Each category publishes the exact `remaining` value with the limit
 * explicitly UNKNOWN (GitHub #49): `used` (which could only be
 * `limit - remaining` against an inferred tier), `limit`, and
 * `remainingPercent` are omitted, and `durationSeconds = 60` (the
 * per-minute window). Throws `QUOTA_ERROR` when both headers are
 * absent — Jina's headers are the only quota signal, so there is
 * nothing else to report.
 */
export function normalizeJinaQuota(
  headers: { readonly remainingRequests: number | null; readonly remainingTokens: number | null },
): ProviderQuotaSuccess {
  const categories: QuotaCategory[] = [];

  if (headers.remainingRequests !== null) {
    categories.push({
      name: "rate_limit_requests",
      unit: "requests",
      current: buildQuotaWindow({
        remaining: headers.remainingRequests,
        durationSeconds: 60,
      }),
    });
  }

  if (headers.remainingTokens !== null) {
    categories.push({
      name: "rate_limit_tokens",
      unit: "tokens",
      current: buildQuotaWindow({
        remaining: headers.remainingTokens,
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
 * Map a thrown error into a normalized Jina quota failure. Every typed
 * transport error (AuthError, ApiError, NetworkError, TimeoutError,
 * ConfigurationError, ...) extends {@link ScoutlineError}, so the single
 * guard passes them all through verbatim (GitHub #49); anything else is
 * wrapped as a generic `ApiError`.
 */
function normalizeJinaQuotaError(error: unknown): Error {
  if (error instanceof ScoutlineError) {
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
