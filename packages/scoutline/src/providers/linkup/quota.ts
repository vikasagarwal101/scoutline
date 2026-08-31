/**
 * Linkup Quota Capability.
 *
 * Maps the Linkup `GET /v1/credits/balance` response into the
 * normalized Provider-quota interface. Linkup is metered USD billing
 * (per-call costs of $0.005–$2.50 against a prepaid dollar balance):
 * the endpoint reports ONLY a remaining `balance`, never a limit, so
 * the single "credits" category publishes the exact `remaining` with
 * `unit: "USD"` — the number is dollars, "credits" is Linkup's
 * branding — and omits `used`, `limit`, and `remainingPercent`
 * (GitHub #49 unknown-limit window); nothing is fabricated against an
 * invented ceiling or percentage.
 *
 * Structurally cloned from the Jina quota pattern (non-destructive
 * GET, IMPLEMENTATION-CONTRACT analog-adapter table): one direct GET
 * per invoke, shared execution owns retry policy, quota never uses
 * the response cache.
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
} from "../../capabilities/quota.js";
import { buildQuotaWindow } from "../../capabilities/quota.js";
import { ApiError, ScoutlineError } from "../../lib/errors.js";
import { requireLinkupApiKey } from "./credentials.js";
import { fetchLinkupCreditBalance, type LinkupTransportDeps } from "./client.js";

// ---------------------------------------------------------------------------
// Normalizer
// ---------------------------------------------------------------------------

/**
 * Normalize a raw Linkup credit-balance payload
 * (`{ balance: <number> }`) into the shared quota interface. The
 * balance is USD-denominated (Linkup bills per-call dollar amounts
 * against a prepaid dollar balance), hence `unit: "USD"`.
 *
 * A missing or non-finite `balance` is a malformed response and throws
 * `ApiError` 500. A valid balance flows through
 * `buildQuotaWindow({ remaining: balance })`, which publishes the
 * exact remaining count and omits `used`, `limit`, and
 * `remainingPercent` — the limit is unknown and no percentage is
 * invented.
 */
export function normalizeLinkupQuota(raw: unknown): ProviderQuotaSuccess {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ApiError("Linkup quota returned a malformed response", 500);
  }
  const balance = (raw as Record<string, unknown>).balance;
  if (typeof balance !== "number" || !Number.isFinite(balance)) {
    throw new ApiError("Linkup quota returned a malformed response", 500);
  }
  return {
    provider: "linkup",
    status: "ok",
    categories: [
      {
        name: "credits",
        unit: "USD",
        current: { remaining: balance },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Capability factory
// ---------------------------------------------------------------------------

/**
 * Map a thrown error into a normalized Linkup quota error. Every typed
 * transport error (ConfigurationError, QuotaError, ValidationError,
 * ApiError, TimeoutError, NetworkError) extends
 * {@link ScoutlineError}, so the single guard passes them through
 * verbatim (GitHub #49); anything else is wrapped as a generic
 * `ApiError`.
 */
function normalizeLinkupQuotaError(error: unknown): Error {
  if (error instanceof ScoutlineError) {
    return error;
  }
  return new ApiError("Linkup quota request failed", 500);
}

/**
 * Options for the Linkup QuotaCapability. The API key is resolved
 * from `env`; transport dependencies (`fetch`, timers) are injectable
 * for deterministic tests through the unified `transport` seam.
 */
export interface LinkupQuotaCapabilityOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly transport?: LinkupTransportDeps;
}

/**
 * Build the Linkup QuotaCapability. `invoke` resolves the API key
 * (required — the credit-balance endpoint authenticates the Bearer
 * header), performs one non-destructive GET, and normalizes the
 * balance into the shared interface. Shared execution wraps this in
 * the retry policy; quota never uses the response cache.
 */
export function createLinkupQuotaCapability(
  options: LinkupQuotaCapabilityOptions,
): QuotaCapability {
  const { env, transport } = options;
  return {
    async invoke(): Promise<ProviderQuotaSuccess> {
      const apiKey = requireLinkupApiKey(env);
      try {
        const raw = await fetchLinkupCreditBalance(apiKey, transport);
        return normalizeLinkupQuota(raw);
      } catch (error) {
        throw normalizeLinkupQuotaError(error);
      }
    },
  };
}
