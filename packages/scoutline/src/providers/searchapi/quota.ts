/**
 * SearchApi.io Quota Capability.
 *
 * Maps the SearchApi.io `GET /api/v1/me` response into the normalized
 * Provider-quota interface. SearchApi is credit-based: `account`
 * carries the current-month usage, the monthly allowance, and the
 * remaining credits. The single "searches" category (unit `"credits"`)
 * is built from `used = current_month_usage` and
 * `limit = monthly_allowance`, with `resetsAt` derived from
 * `subscription.period_end` when it parses. `remaining_credits` is
 * required by the wire contract but is not re-published verbatim —
 * `buildQuotaWindow` derives the honest `remaining` from the counts.
 *
 * Structurally cloned from the Linkup quota pattern (non-destructive
 * GET, IMPLEMENTATION-CONTRACT analog-adapter table): one direct GET
 * per invoke, shared execution owns retry policy, quota never uses the
 * response cache.
 *
 * Boundary rules (ARCHITECTURE.md §2):
 *   - May import the quota capability contract, Adapter-local
 *     credentials, Adapter-local quota transport, and normalized
 *     errors.
 *   - Must NOT import command presentation or another Provider's
 *     Adapter.
 */

import type {
  ProviderQuotaSuccess,
  QuotaCapability,
  QuotaCategory,
} from "../../capabilities/quota.js";
import { buildQuotaWindow } from "../../capabilities/quota.js";
import { ApiError, ScoutlineError } from "../../lib/errors.js";
import { parseZonedInstant } from "../../lib/parse-zoned-instant.js";
import { requireSearchApiKey } from "./credentials.js";
import { fetchSearchApiMe, type SearchApiTransportDeps } from "./client.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read a finite NONNEGATIVE number, or `undefined` for anything else. */
function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}


// ---------------------------------------------------------------------------
// Normalizer
// ---------------------------------------------------------------------------

/**
 * Normalize a raw SearchApi.io `/api/v1/me` payload into the shared
 * quota interface.
 *
 * The `account` object must carry finite `current_month_usage`,
 * `monthly_allowance`, and `remaining_credits`; a missing/non-object
 * root or account, or any non-finite count, is a malformed response and
 * throws `ApiError` 500. On success a single `"searches"` category
 * (`unit: "credits"`) is built through
 * `buildQuotaWindow({ used, limit, resetsAtEpochMs })`, where
 * `resetsAtEpochMs` is `parseZonedInstant(subscription.period_end)` when
 * that parses (a zone-less form is anchored to UTC) and is omitted
 * otherwise.
 */
export function normalizeSearchApiQuota(raw: unknown): ProviderQuotaSuccess {
  if (!isPlainObject(raw)) {
    throw new ApiError("SearchApi.io quota returned a malformed response", 500);
  }
  const account = raw.account;
  if (!isPlainObject(account)) {
    throw new ApiError("SearchApi.io quota returned a malformed response", 500);
  }
  const used = readFiniteNumber(account.current_month_usage);
  const limit = readFiniteNumber(account.monthly_allowance);
  const remainingCredits = readFiniteNumber(account.remaining_credits);
  if (used === undefined || limit === undefined || remainingCredits === undefined) {
    throw new ApiError("SearchApi.io quota returned a malformed response", 500);
  }

  const subscription = isPlainObject(raw.subscription) ? raw.subscription : undefined;
  const periodEnd = subscription ? subscription.period_end : undefined;
  const resetsAtEpochMs = typeof periodEnd === "string" ? parseZonedInstant(periodEnd) : NaN;

  const inputs: { used: number; limit: number; resetsAtEpochMs?: number } = { used, limit };
  if (Number.isFinite(resetsAtEpochMs)) {
    inputs.resetsAtEpochMs = resetsAtEpochMs;
  }

  const category: QuotaCategory = {
    name: "searches",
    unit: "credits",
    current: buildQuotaWindow(inputs),
  };

  return {
    provider: "searchapi",
    status: "ok",
    categories: [category],
  };
}

// ---------------------------------------------------------------------------
// Capability factory
// ---------------------------------------------------------------------------

/**
 * Map a thrown error into a normalized SearchApi.io quota error. Every
 * typed transport error (ConfigurationError, QuotaError, ApiError,
 * TimeoutError, NetworkError) extends {@link ScoutlineError}, so the
 * single guard passes them through verbatim; anything else is wrapped
 * as a generic `ApiError`.
 */
function normalizeSearchApiQuotaError(error: unknown): Error {
  if (error instanceof ScoutlineError) {
    return error;
  }
  return new ApiError("SearchApi.io quota request failed", 500);
}

/**
 * Options for the SearchApi.io QuotaCapability. The API key is resolved
 * from `env`; transport dependencies (`fetch`, timers) are injectable
 * for deterministic tests through the unified `transport` seam.
 */
export interface SearchApiQuotaCapabilityOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly transport?: SearchApiTransportDeps;
}

/**
 * Build the SearchApi.io QuotaCapability. `invoke` resolves the API key,
 * performs one non-destructive GET against `/api/v1/me` (not a search —
 * costs no credit), and normalizes the account counts into the shared
 * interface. Shared execution wraps this in the retry policy; quota
 * never uses the response cache.
 */
export function createSearchApiQuotaCapability(
  options: SearchApiQuotaCapabilityOptions,
): QuotaCapability {
  const { env, transport } = options;
  return {
    async invoke(): Promise<ProviderQuotaSuccess> {
      const apiKey = requireSearchApiKey(env);
      try {
        const raw = await fetchSearchApiMe(apiKey, transport);
        return normalizeSearchApiQuota(raw);
      } catch (error) {
        throw normalizeSearchApiQuotaError(error);
      }
    },
  };
}
