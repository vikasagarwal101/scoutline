/**
 * Z.AI Quota Capability (DESIGN.md §13, P4-02).
 *
 * Maps the Z.AI monitor quota-limit response into the normalized
 * Provider-quota Interface. The normalizer is pure; the capability
 * factory owns credential resolution, the single monitor transport
 * attempt, and failure normalization. Shared execution owns retry.
 *
 * Z.AI mapping (DESIGN.md §13):
 *   - `level` -> `plan`.
 *   - Rolling `TIME_LIMIT` -> `requests` category with current counts,
 *     duration in seconds, derived remaining percent, and ISO reset.
 *   - `TOKENS_LIMIT` -> `tokens` category; convert the Provider's used
 *     percentage to a remaining percentage.
 *   - Categories are named `requests` then `tokens` when present.
 *   - Per-tool breakdown (`usageDetails`) is omitted — no field in
 *     ADR-0001.
 *
 * Boundary rules (ARCHITECTURE.md §2):
 *   - May import the quota capability contract, Provider-local monitor
 *     transport, and normalized errors.
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
import {
  fetchZaiQuotaLimit,
  type ZaiMonitorDeps,
  type ZaiRawQuotaLimit,
} from "./monitor-client.js";
import { requireZaiApiKey } from "./credentials.js";

// ---------------------------------------------------------------------------
// Raw Z.AI limit shapes
// ---------------------------------------------------------------------------

interface ZaiToolUsage {
  modelCode?: string;
  usage?: number;
}

interface ZaiTimeLimit {
  type: "TIME_LIMIT";
  unit: number; // hours
  number?: number;
  usage?: number; // call cap in window (limit)
  currentValue?: number; // calls used
  remaining?: number;
  percentage?: number; // USED percentage
  nextResetTime?: number; // epoch ms
  usageDetails?: ZaiToolUsage[];
}

interface ZaiTokensLimit {
  type: "TOKENS_LIMIT";
  unit?: number;
  number?: number;
  percentage?: number; // USED percentage
  nextResetTime?: number; // epoch ms
}

type ZaiLimit = ZaiTimeLimit | ZaiTokensLimit;

function isTimeLimit(value: unknown): value is ZaiTimeLimit {
  return (
    !!value && typeof value === "object" && (value as { type?: unknown }).type === "TIME_LIMIT"
  );
}

function isTokensLimit(value: unknown): value is ZaiTokensLimit {
  return (
    !!value && typeof value === "object" && (value as { type?: unknown }).type === "TOKENS_LIMIT"
  );
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// ---------------------------------------------------------------------------
// Normalizer
// ---------------------------------------------------------------------------

/**
 * Normalize a raw Z.AI quota-limit payload into the shared Interface.
 * Throws `QUOTA_ERROR` (via {@link buildQuotaWindow}) when a present
 * limit entry has neither a valid percentage nor valid counts.
 */
export function normalizeZaiQuota(raw: unknown): ProviderQuotaSuccess {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ApiError("Z.AI quota returned a malformed response", 500);
  }
  const data = raw as Partial<ZaiRawQuotaLimit> & { limits?: unknown };
  const categories: QuotaCategory[] = [];

  const limits = Array.isArray(data.limits) ? data.limits : [];

  const timeLimit = limits.find(isTimeLimit);
  if (timeLimit) {
    const durationSeconds =
      typeof timeLimit.unit === "number" && Number.isFinite(timeLimit.unit)
        ? timeLimit.unit * 3600
        : undefined;
    categories.push({
      name: "requests",
      unit: "requests",
      current: buildQuotaWindow({
        used: readNumber(timeLimit.currentValue),
        limit: readNumber(timeLimit.usage),
        durationSeconds,
        resetsAtEpochMs: readNumber(timeLimit.nextResetTime),
        // Z.AI `percentage` is a USED percentage — do NOT treat it as an
        // explicit remaining percentage. Derive from counts instead.
      }),
    });
  }

  const tokensLimit = limits.find(isTokensLimit);
  if (tokensLimit) {
    const usedPercent = readNumber(tokensLimit.percentage);
    const remainingPercent = usedPercent !== undefined ? 100 - usedPercent : undefined;
    categories.push({
      name: "tokens",
      unit: "tokens",
      current: buildQuotaWindow({
        explicitRemainingPercent: remainingPercent,
        resetsAtEpochMs: readNumber(tokensLimit.nextResetTime),
      }),
    });
  }

  return {
    provider: "zai",
    status: "ok",
    plan: typeof data.level === "string" && data.level.length > 0 ? data.level : undefined,
    categories,
  };
}

// ---------------------------------------------------------------------------
// Capability factory
// ---------------------------------------------------------------------------

function normalizeZaiQuotaError(error: unknown): Error {
  if (
    error instanceof AuthError ||
    error instanceof ApiError ||
    error instanceof NetworkError ||
    error instanceof TimeoutError ||
    error instanceof ConfigurationError
  ) {
    return error;
  }
  return new ApiError("Z.AI quota request failed", 500);
}

/**
 * Options for the Z.AI QuotaCapability. `env` resolves the API key and
 * monitor base/timeout. The transport dependencies (`fetch`, timer) are
 * injectable for deterministic tests.
 */
export interface ZaiQuotaCapabilityOptions extends ZaiMonitorDeps {
  readonly env: NodeJS.ProcessEnv;
}

/**
 * Build the Z.AI QuotaCapability. `invoke` resolves the credential,
 * performs one monitor transport attempt (auth-scheme fallback inside),
 * and normalizes the response. Shared execution wraps this in the retry
 * policy; quota never uses the response cache.
 */
export function createZaiQuotaCapability(options: ZaiQuotaCapabilityOptions): QuotaCapability {
  const { env, ...transportDeps } = options;
  return {
    async invoke(): Promise<ProviderQuotaSuccess> {
      // Shared credential resolver (Fixup A — B4/B7): honours the
      // ZAI_API_KEY alias and treats a missing key as a configuration
      // failure (ConfigurationError, exit 3).
      const apiKey = requireZaiApiKey(env);
      try {
        const raw = await fetchZaiQuotaLimit(apiKey, transportDeps);
        return normalizeZaiQuota(raw);
      } catch (error) {
        throw normalizeZaiQuotaError(error);
      }
    },
  };
}
