/**
 * MiniMax Quota Capability (DESIGN.md §12, §13, P4-02).
 *
 * Maps the MiniMax remains-endpoint response into the normalized
 * Provider-quota Interface. The normalizer is pure; the capability
 * factory owns configuration resolution, the single direct transport
 * attempt, and failure normalization. Shared execution owns retry.
 *
 * MiniMax mapping (DESIGN.md §13):
 *   - Each `model_remains` entry -> one category named by nonempty
 *     `model_name`, unit `requests`, sorted ascending by name.
 *   - Current counts + remaining percent; optional weekly counts +
 *     remaining percent.
 *   - `end_time` / `weekly_end_time` (epoch ms) -> ISO `resetsAt`.
 *   - Only characterized 1.0.16 fields are read: model name, counts,
 *     remaining percentages, reset timestamps. Status and boost fields
 *     are not interpreted.
 *
 * Boundary rules (ARCHITECTURE.md §2):
 *   - May import the quota capability contract, Adapter-local config,
 *     Adapter-local quota client, and normalized errors.
 *   - Must NOT import `mmx-cli/sdk`, command presentation, or another
 *     Provider's Adapter.
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
import { loadMiniMaxConfig, type MiniMaxConfig } from "./config.js";
import {
  fetchMiniMaxQuota,
  type MiniMaxQuotaClientDeps,
  type MiniMaxRawQuotaResponse,
} from "./quota-client.js";

// ---------------------------------------------------------------------------
// Raw MiniMax model_remains entry shape (characterized 1.0.16 fields only)
// ---------------------------------------------------------------------------

interface MiniMaxModelRemains {
  model_name?: unknown;
  used?: unknown;
  total?: unknown;
  remains_percentage?: unknown;
  end_time?: unknown;
  weekly_used?: unknown;
  weekly_total?: unknown;
  weekly_remains_percentage?: unknown;
  weekly_end_time?: unknown;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readNonemptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

// ---------------------------------------------------------------------------
// Normalizer
// ---------------------------------------------------------------------------

/**
 * Normalize a raw MiniMax remains payload into the shared Interface.
 * Throws `QUOTA_ERROR` (via {@link buildQuotaWindow}) when an entry has
 * neither a valid percentage nor valid counts.
 */
export function normalizeMiniMaxQuota(raw: unknown): ProviderQuotaSuccess {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ApiError("MiniMax quota returned a malformed response", 500);
  }
  const response = raw as Partial<MiniMaxRawQuotaResponse>;
  const entries = response.model_remains;
  if (!Array.isArray(entries)) {
    throw new ApiError("MiniMax quota returned a malformed response", 500);
  }

  const categories: QuotaCategory[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ApiError("MiniMax quota returned a malformed response", 500);
    }
    const record = entry as MiniMaxModelRemains;
    const name = readNonemptyString(record.model_name);
    if (!name) {
      throw new ApiError("MiniMax quota returned a malformed response", 500);
    }

    const current = buildQuotaWindow({
      used: readNumber(record.used),
      limit: readNumber(record.total),
      explicitRemainingPercent: readNumber(record.remains_percentage),
      resetsAtEpochMs: readNumber(record.end_time),
    });

    const category: QuotaCategory = { name, unit: "requests", current };

    const hasWeekly =
      readNumber(record.weekly_used) !== undefined ||
      readNumber(record.weekly_total) !== undefined ||
      readNumber(record.weekly_remains_percentage) !== undefined ||
      readNumber(record.weekly_end_time) !== undefined;
    if (hasWeekly) {
      category.weekly = buildQuotaWindow({
        used: readNumber(record.weekly_used),
        limit: readNumber(record.weekly_total),
        explicitRemainingPercent: readNumber(record.weekly_remains_percentage),
        resetsAtEpochMs: readNumber(record.weekly_end_time),
      });
    }

    categories.push(category);
  }

  categories.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  return { provider: "minimax", status: "ok", categories };
}

// ---------------------------------------------------------------------------
// Capability factory
// ---------------------------------------------------------------------------

function normalizeMiniMaxQuotaError(error: unknown): Error {
  if (
    error instanceof AuthError ||
    error instanceof ApiError ||
    error instanceof NetworkError ||
    error instanceof TimeoutError ||
    error instanceof ConfigurationError
  ) {
    return error;
  }
  return new ApiError("MiniMax quota request failed", 500);
}

/**
 * Options for the MiniMax QuotaCapability. Configuration is loaded from
 * `env`; transport dependencies (`fetch`, timer) are injectable for
 * deterministic tests.
 */
export interface MiniMaxQuotaCapabilityOptions extends MiniMaxQuotaClientDeps {
  readonly env: NodeJS.ProcessEnv;
}

/**
 * Build the MiniMax QuotaCapability. `invoke` loads Adapter-local
 * config, performs one direct remains-endpoint attempt, and normalizes
 * the response. Shared execution wraps this in the retry policy; quota
 * never uses the response cache and never routes through the SDK.
 */
export function createMiniMaxQuotaCapability(
  options: MiniMaxQuotaCapabilityOptions,
): QuotaCapability {
  const { env, ...transportDeps } = options;
  return {
    async invoke(): Promise<ProviderQuotaSuccess> {
      const config: MiniMaxConfig = loadMiniMaxConfig(env);
      try {
        const raw = await fetchMiniMaxQuota(config, transportDeps);
        return normalizeMiniMaxQuota(raw);
      } catch (error) {
        throw normalizeMiniMaxQuotaError(error);
      }
    },
  };
}
