/**
 * Firecrawl Quota Capability (firecrawl tech-plan D8, critique C4).
 *
 * Maps the Firecrawl /v2/team/credit-usage response into one normalized
 * `QuotaCategory` with `unit:"credits"` and `name:"Credits"`. The
 * normalizer is pure; the capability factory owns configuration
 * resolution, the single direct transport attempt, and failure
 * normalization. Shared execution owns retry policy.
 *
 * Credit-usage shape: the live endpoint surfaces "remaining credits"
 * (investigation §1.2). The exact field names are a non-gating verify
 * item (tech-plan §7 #4), so the normalizer extracts `remaining` + `used`
 * defensively across common variants and derives `limit = used +
 * remaining`. Field names are tuned during live verification (FC-06).
 *
 * Boundary rules (ARCHITECTURE.md §2):
 *   - May import the quota contract, Adapter-local config, Adapter-local
 *     quota client, and normalized errors.
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
  TimeoutError,
} from "../../lib/errors.js";
import { requireFirecrawlApiKey } from "./credentials.js";
import { fetchFirecrawlCreditUsage, type FirecrawlTransportDeps } from "./client.js";

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Resolve the credit-usage record. Firecrawl wraps some responses in a
 * `data` array/object; accept either a top-level object or a `data`
 * wrapper (first array element when `data` is an array).
 */
function resolveUsageRecord(raw: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(raw)) return undefined;
  const data = raw.data;
  if (Array.isArray(data) && isPlainObject(data[0])) return data[0] as Record<string, unknown>;
  if (isPlainObject(data)) return data;
  return raw;
}

/**
 * Normalize a raw credit-usage payload into the shared Interface. Builds
 * one "Credits" category (`unit:"credits"`).
 *
 * Live-confirmed shape (FC-06): `data.{ remainingCredits, planCredits,
 * billingPeriodStart, billingPeriodEnd }`. Firecrawl reports a remaining
 * balance against a per-period plan allotment — `remainingCredits` may
 * exceed `planCredits` (banked credits), so the window is built against
 * the plan allotment and `used` is clamped ≥ 0. Throws `ApiError` 500 when
 * `remainingCredits`/`planCredits` are absent or invalid.
 */
export function normalizeFirecrawlQuota(raw: unknown): ProviderQuotaSuccess {
  const record = resolveUsageRecord(raw);
  if (record === undefined) {
    throw new ApiError("Firecrawl quota returned a malformed response", 500);
  }
  const remaining = readNumber(record.remainingCredits ?? record.remaining_credits);
  const planCredits = readNumber(record.planCredits ?? record.plan_credits);
  if (remaining === undefined || planCredits === undefined || planCredits <= 0) {
    throw new ApiError("Firecrawl quota returned a malformed response", 500);
  }
  // Window against the per-period allotment. `used` = the plan portion
  // consumed this period (clamped ≥ 0 when banked credits push remaining
  // past the plan, so remainingPercent caps at 100).
  const used = Math.max(planCredits - remaining, 0);

  const periodEnd =
    typeof record.billingPeriodEnd === "string" ? record.billingPeriodEnd : undefined;
  const periodStart =
    typeof record.billingPeriodStart === "string" ? record.billingPeriodStart : undefined;
  const endMs = periodEnd !== undefined ? Date.parse(periodEnd) : NaN;
  const startMs = periodStart !== undefined ? Date.parse(periodStart) : NaN;

  const window = buildQuotaWindow({
    used,
    limit: planCredits,
    ...(Number.isFinite(endMs) && endMs > 0 ? { resetsAtEpochMs: endMs } : {}),
    ...(Number.isFinite(startMs) && Number.isFinite(endMs)
      ? { durationSeconds: Math.max(Math.round((endMs - startMs) / 1000), 0) }
      : {}),
  });

  const category: QuotaCategory = { name: "Credits", unit: "credits", current: window };
  return { provider: "firecrawl", status: "ok", categories: [category] };
}

// ---------------------------------------------------------------------------
// Capability factory
// ---------------------------------------------------------------------------

function normalizeFirecrawlQuotaError(error: unknown): Error {
  if (
    error instanceof AuthError ||
    error instanceof ApiError ||
    error instanceof NetworkError ||
    error instanceof TimeoutError ||
    error instanceof ConfigurationError
  ) {
    return error;
  }
  return new ApiError("Firecrawl quota request failed", 500);
}

export interface FirecrawlQuotaCapabilityOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly transport?: FirecrawlTransportDeps;
}

/**
 * Build the Firecrawl QuotaCapability. `invoke` resolves the API key,
 * performs one direct /team/credit-usage attempt, and normalizes the
 * response into a single "Credits" category. Shared execution wraps this
 * in the retry policy; quota never uses the response cache.
 */
export function createFirecrawlQuotaCapability(
  options: FirecrawlQuotaCapabilityOptions,
): QuotaCapability {
  const { env, transport } = options;
  return {
    async invoke(): Promise<ProviderQuotaSuccess> {
      const apiKey = requireFirecrawlApiKey(env);
      try {
        const raw = await fetchFirecrawlCreditUsage(apiKey, transport);
        return normalizeFirecrawlQuota(raw);
      } catch (error) {
        throw normalizeFirecrawlQuotaError(error);
      }
    },
  };
}
