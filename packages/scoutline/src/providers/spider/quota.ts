/**
 * Spider.cloud Quota Capability.
 *
 * Maps the Spider.cloud GET /data/credits response into one normalized
 * `QuotaCategory` with `unit:"credits"` and `name:"credits"` for
 * dashboard display. The authority policy is always-unknown: the
 * balance is absolute with an unknown limit, not a percentage plan
 * signal, so the quota-mapping scorer treats Spider as
 * non-authoritative (no CAPABILITY_MAPPINGS row). The normalizer is pure;
 * the capability factory owns configuration resolution, the single
 * direct transport attempt, and failure normalization. Shared execution
 * owns retry policy.
 *
 * Credits shape: the endpoint surfaces a remaining credit count ONLY
 * (`{ "credits": 84520 }`). There is no plan limit and no billing
 * window on the wire, so the window is built via the unknown-limit
 * path — `remaining` alone; no fabricated `limit`, `used`, or
 * `remainingPercent`.
 *
 * Boundary rules (ARCHITECTURE.md §2):
 *   - May import the quota contract, Adapter-local config, Adapter-local
 *     quota client, and normalized errors.
 *   - Must NOT import command presentation or another Provider's Adapter.
 */

import type { QuotaCapability, QuotaCategory } from "../../capabilities/quota.js";
import { buildQuotaWindow } from "../../capabilities/quota.js";
import {
  ApiError,
  AuthError,
  ConfigurationError,
  NetworkError,
  QuotaError,
  TimeoutError,
} from "../../lib/errors.js";
import { requireSpiderApiKey } from "./credentials.js";
import { fetchSpiderCredits, type SpiderTransportDeps } from "./client.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Local success type: identical to the shared `ProviderQuotaSuccess`
 * except `provider` is the `"spider"` literal. Assignable to the shared
 * contract once `"spider"` joins `PROVIDER_IDS` during registry wiring.
 */
export interface SpiderQuotaSuccess {
  readonly provider: "spider";
  readonly status: "ok";
  readonly categories: QuotaCategory[];
}

/**
 * Normalize a raw /data/credits payload into the shared Interface.
 * Builds one "credits" category (`unit:"credits"`) on the unknown-limit
 * window: `remaining` only, omitting fabricated percent/limit values.
 * Throws `ApiError` 500 when the payload is not a plain object carrying
 * a finite numeric `credits` field.
 */
export function normalizeSpiderQuota(raw: unknown): SpiderQuotaSuccess {
  if (!isPlainObject(raw)) {
    throw new ApiError("Spider quota returned a malformed response", 500);
  }
  const remaining = readNumber(raw.credits);
  if (remaining === undefined) {
    throw new ApiError("Spider quota returned a malformed response", 500);
  }
  const window = buildQuotaWindow({ remaining });
  const category: QuotaCategory = { name: "credits", unit: "credits", current: window };
  return { provider: "spider", status: "ok", categories: [category] };
}

// ---------------------------------------------------------------------------
// Capability factory
// ---------------------------------------------------------------------------

function normalizeSpiderQuotaError(error: unknown): Error {
  if (
    error instanceof AuthError ||
    error instanceof ApiError ||
    error instanceof NetworkError ||
    error instanceof QuotaError ||
    error instanceof TimeoutError ||
    error instanceof ConfigurationError
  ) {
    return error;
  }
  return new ApiError("Spider quota request failed", 500);
}

export interface SpiderQuotaCapabilityOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly transport?: SpiderTransportDeps;
}

/** Local Quota contract — see the module header. */
export interface SpiderQuotaCapability {
  invoke(): Promise<SpiderQuotaSuccess>;
}

/**
 * Build the Spider.cloud QuotaCapability. `invoke` resolves the API key,
 * performs one direct /data/credits attempt, and normalizes the response
 * into a single "credits" category on the unknown-limit window. Shared
 * execution wraps this in the retry policy; quota never uses the
 * response cache.
 */
export function createSpiderQuotaCapability(
  options: SpiderQuotaCapabilityOptions,
): SpiderQuotaCapability {
  const { env, transport } = options;
  return {
    async invoke(): Promise<SpiderQuotaSuccess> {
      const apiKey = requireSpiderApiKey(env);
      try {
        const raw = await fetchSpiderCredits(apiKey, transport);
        return normalizeSpiderQuota(raw);
      } catch (error) {
        throw normalizeSpiderQuotaError(error);
      }
    },
  };
}
