/**
 * Tavily Quota Capability (DESIGN.md §13, tech-plan §10, T08).
 *
 * Maps the Tavily /usage response into the normalized Provider-quota
 * Interface. The normalizer is pure; the capability factory owns
 * configuration resolution, the single direct transport attempt, and
 * failure normalization. Shared execution owns retry policy.
 *
 * Tavily mapping (tech-plan §10):
 *   - key.usage / key.limit             -> "requests" (aggregate)
 *   - key.search_usage / key.limit      -> "search" (named category)
 *   - key.extract_usage / key.limit     -> "extract" (named category)
 *   - key.crawl_usage / key.limit       -> "crawl" (named category)
 *   - key.map_usage / key.limit         -> "map" (named category)
 *   - key.research_usage / key.limit    -> "research" (named category)
 *   - account.plan_usage / plan_limit   -> "plan" (monthly plan window)
 *   - account.current_plan             -> metadata.plan
 *
 * Per-endpoint counters share the key-level `limit` because Tavily
 * bills against a single credit pool. The per-endpoint category shows
 * how much of that pool each endpoint has consumed; a category is
 * omitted entirely when its counter is missing or invalid.
 *
 * Boundary rules (ARCHITECTURE.md §2):
 *   - May import the quota capability contract, Adapter-local config,
 *     Adapter-local quota client, and normalized errors.
 *   - Must NOT import command presentation or another Provider's
 *     Adapter.
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
import { requireTavilyApiKey } from "./credentials.js";
import { fetchTavilyUsage, type TavilyTransportDeps } from "./client.js";

// ---------------------------------------------------------------------------
// Raw Tavily /usage response shape (characterized against the live
// /usage endpoint).
// ---------------------------------------------------------------------------

interface TavilyUsageKey {
  usage?: unknown;
  limit?: unknown;
  search_usage?: unknown;
  extract_usage?: unknown;
  crawl_usage?: unknown;
  map_usage?: unknown;
  research_usage?: unknown;
}

interface TavilyUsageAccount {
  current_plan?: unknown;
  plan_usage?: unknown;
  plan_limit?: unknown;
}

interface TavilyUsageResponse {
  key?: TavilyUsageKey;
  account?: TavilyUsageAccount;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readNonemptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/**
 * Build a per-endpoint category sharing the key-level limit. Skips the
 * category entirely when either the counter or the shared limit is
 * missing or invalid.
 */
function tryBuildEndpointCategory(
  name: string,
  usedRaw: unknown,
  sharedLimit: number | undefined,
): QuotaCategory | undefined {
  const used = readNumber(usedRaw);
  if (used === undefined || sharedLimit === undefined) return undefined;
  if (used < 0 || sharedLimit <= 0) return undefined;
  if (used > sharedLimit) {
    // Per-endpoint usage exceeding the shared limit means the live
    // pool is exhausted; clamp `used` to the limit so the derived
    // percentage is meaningful rather than throwing.
    const current = buildQuotaWindow({ used: sharedLimit, limit: sharedLimit });
    return { name, unit: "requests", current };
  }
  const current = buildQuotaWindow({ used, limit: sharedLimit });
  return { name, unit: "requests", current };
}

// ---------------------------------------------------------------------------
// Normalizer
// ---------------------------------------------------------------------------

/**
 * Normalize a raw Tavily /usage payload into the shared Interface.
 * Throws `QUOTA_ERROR` (via {@link buildQuotaWindow}) when a category
 * has neither a valid percentage nor valid counts.
 *
 * The "requests" aggregate category is mandatory: a response without
 * `key.usage` and `key.limit` is malformed and throws `ApiError 500`.
 * Per-endpoint and "plan" categories are optional — missing/invalid
 * inputs silently drop them so partial responses still surface useful
 * information.
 */
export function normalizeTavilyQuota(raw: unknown): ProviderQuotaSuccess {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ApiError("Tavily quota returned a malformed response", 500);
  }
  const response = raw as Partial<TavilyUsageResponse>;

  const keyRecord = response.key;
  if (!keyRecord || typeof keyRecord !== "object" || Array.isArray(keyRecord)) {
    throw new ApiError("Tavily quota returned a malformed response", 500);
  }
  const keyUsed = readNumber(keyRecord.usage);
  const keyLimit = readNumber(keyRecord.limit);
  if (keyUsed === undefined) {
    throw new ApiError("Tavily quota returned a malformed response", 500);
  }

  const categories: QuotaCategory[] = [];

  // Aggregate "requests" category — key.usage / key.limit.
  // key.limit may be null (unlimited); in that case report usage with
  // 100% remaining since there is no ceiling to derive a ratio from.
  let aggregate: ReturnType<typeof buildQuotaWindow>;
  if (keyLimit !== undefined) {
    aggregate = buildQuotaWindow({
      used: Math.min(keyUsed, keyLimit),
      limit: keyLimit,
    });
  } else {
    aggregate = buildQuotaWindow({
      used: keyUsed,
      explicitRemainingPercent: 100,
    });
  }
  categories.push({ name: "requests", unit: "requests", current: aggregate });

  // Per-endpoint named categories — share the key-level limit.
  const perEndpoint: ReadonlyArray<readonly [string, unknown]> = [
    ["search", keyRecord.search_usage],
    ["extract", keyRecord.extract_usage],
    ["crawl", keyRecord.crawl_usage],
    ["map", keyRecord.map_usage],
    ["research", keyRecord.research_usage],
  ];
  for (const [name, counter] of perEndpoint) {
    const category = tryBuildEndpointCategory(name, counter, keyLimit);
    if (category) categories.push(category);
  }

  // Monthly plan window — account.plan_usage / account.plan_limit.
  const accountRecord = response.account;
  if (accountRecord && typeof accountRecord === "object" && !Array.isArray(accountRecord)) {
    const planUsed = readNumber(accountRecord.plan_usage);
    const planLimit = readNumber(accountRecord.plan_limit);
    if (planUsed !== undefined && planLimit !== undefined && planLimit > 0) {
      const planCurrent = buildQuotaWindow({
        used: Math.min(planUsed, planLimit),
        limit: planLimit,
      });
      categories.push({ name: "plan", unit: "requests", current: planCurrent });
    } else if (planUsed !== undefined) {
      const planCurrent = buildQuotaWindow({
        used: planUsed,
        explicitRemainingPercent: 100,
      });
      categories.push({ name: "plan", unit: "requests", current: planCurrent });
    }
  }

  categories.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const planName = readNonemptyString(accountRecord?.current_plan);
  const success: ProviderQuotaSuccess = {
    provider: "tavily",
    status: "ok",
    categories,
  };
  if (planName !== undefined) {
    success.plan = planName;
  }
  return success;
}

// ---------------------------------------------------------------------------
// Capability factory
// ---------------------------------------------------------------------------

function normalizeTavilyQuotaError(error: unknown): Error {
  if (
    error instanceof AuthError ||
    error instanceof ApiError ||
    error instanceof NetworkError ||
    error instanceof TimeoutError ||
    error instanceof ConfigurationError
  ) {
    return error;
  }
  return new ApiError("Tavily quota request failed", 500);
}

/**
 * Options for the Tavily QuotaCapability. The API key is resolved
 * from `env`; transport dependencies (`fetch`, timer) are injectable
 * for deterministic tests through the unified `transport` seam.
 */
export interface TavilyQuotaCapabilityOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly transport?: TavilyTransportDeps;
}

/**
 * Build the Tavily QuotaCapability. `invoke` resolves the API key,
 * performs one direct /usage attempt, and normalizes the response.
 * Shared execution wraps this in the retry policy; quota never uses
 * the response cache and never routes through the search transport.
 */
export function createTavilyQuotaCapability(
  options: TavilyQuotaCapabilityOptions,
): QuotaCapability {
  const { env, transport } = options;
  return {
    async invoke(): Promise<ProviderQuotaSuccess> {
      const apiKey = requireTavilyApiKey(env);
      try {
        const raw = await fetchTavilyUsage(apiKey, transport);
        return normalizeTavilyQuota(raw);
      } catch (error) {
        throw normalizeTavilyQuotaError(error);
      }
    },
  };
}
