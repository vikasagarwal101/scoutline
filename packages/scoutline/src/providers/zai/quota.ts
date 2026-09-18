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
 *     duration in seconds, the Provider's own remaining percentage, and
 *     ISO reset. The entry is trusted only when self-consistent
 *     (GitHub #191); an inconsistent counter emits the category with an
 *     empty window rather than a fabricated one.
 *   - `TIME_LIMIT.usageDetails` -> the additive optional `toolUsage`
 *     field on `requests` (`modelCode` -> `tool`, `usage` -> `usage`;
 *     entries without a name or without a positive count are dropped,
 *     and an all-dropped list omits the field rather than publishing an
 *     empty array). Mapped independently of the consistency guard: the
 *     per-tool rows are informational and survive a corrupt window.
 *   - `TOKENS_LIMIT` -> `tokens` category; convert the Provider's used
 *     percentage to a remaining percentage.
 *   - Categories are named `requests` then `tokens` when present.
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

/**
 * Is a raw `TIME_LIMIT` entry internally consistent? Z.AI's counter and
 * its own `remaining`/`percentage` must tell the same story before any
 * of them is trusted (GitHub #191). All six conditions are required
 * with PRESENT fields — an absent field fails its comparison, so a
 * partially-populated entry is corrupt rather than partially trusted:
 *
 *   - `usage > 0` — a zero cap describes no window.
 *   - `currentValue >= 0` — a negative count is impossible.
 *   - `0 <= remaining <= usage` — remaining cannot exceed the window.
 *   - `0 <= percentage <= 100` — `percentage` is a USED share.
 *   - `|(usage - currentValue) - remaining| <= 1` — the counts and the
 *     published remaining agree, allowing for upstream rounding.
 *   - `|(currentValue / usage) * 100 - percentage| <= 2` — the
 *     percentage agrees with the counts (ocr + opus converged finding:
 *     a pathological percentage alone re-created false exhaustion
 *     through the one field the five-condition guard didn't cross-check).
 */
function isConsistentTimeLimit(entry: {
  usage?: number;
  currentValue?: number;
  remaining?: number;
  percentage?: number;
}): boolean {
  const usage = readNumber(entry.usage);
  const currentValue = readNumber(entry.currentValue);
  const remaining = readNumber(entry.remaining);
  const percentage = readNumber(entry.percentage);
  if (
    usage === undefined ||
    currentValue === undefined ||
    remaining === undefined ||
    percentage === undefined
  ) {
    return false;
  }
  return (
    usage > 0 &&
    currentValue >= 0 &&
    remaining >= 0 &&
    remaining <= usage &&
    percentage >= 0 &&
    percentage <= 100 &&
    Math.abs(usage - currentValue - remaining) <= 1 &&
    Math.abs((currentValue / usage) * 100 - percentage) <= 2
  );
}

/**
 * Map `TIME_LIMIT.usageDetails` onto the additive `toolUsage` field
 * (GitHub #191). An entry contributes a row only when it carries BOTH a
 * nonempty string `modelCode` (the tool id, which IS the row's label)
 * and a finite `usage` greater than zero. An absent or non-positive
 * count is dropped rather than published as 0 — a zero row would assert
 * "this tool consumed nothing", a claim the Provider never made — and a
 * non-finite or non-numeric count is not an observation at all.
 *
 * Returns `undefined` (the field is omitted) when nothing survives,
 * which deliberately covers both an absent `usageDetails` and an
 * all-filtered one: an empty array would be a claim of its own. The
 * filter is self-contained and deliberately NOT coupled to
 * {@link isConsistentTimeLimit} — see {@link normalizeZaiQuota}.
 */
function readToolUsage(entry: ZaiTimeLimit): QuotaCategory["toolUsage"] {
  if (!Array.isArray(entry.usageDetails)) return undefined;
  const rows: { tool: string; usage: number }[] = [];
  for (const detail of entry.usageDetails) {
    if (!detail || typeof detail !== "object") continue;
    const tool = detail.modelCode;
    const usage = readNumber(detail.usage);
    if (typeof tool !== "string" || tool.length === 0) continue;
    if (usage === undefined || usage <= 0) continue;
    rows.push({ tool, usage });
  }
  return rows.length > 0 ? rows : undefined;
}

// ---------------------------------------------------------------------------
// Normalizer
// ---------------------------------------------------------------------------

/**
 * Normalize a raw Z.AI quota-limit payload into the shared Interface.
 *
 * The `requests` category trusts the RAW fields (`remaining` /
 * `percentage`, converted to a remaining percentage) over anything
 * derived from the counts, and only while {@link isConsistentTimeLimit}
 * holds. An inconsistent entry emits the category with an EMPTY
 * `current` window rather than a fabricated one: downstream consumers
 * read an absent `remainingPercent` as unknown (never `exhausted`,
 * never `KNOWN_EXHAUSTED` demotion, `PERCENT_CORRUPT` when scoring),
 * which is the honest report for a counter that contradicts itself.
 *
 * The per-tool `toolUsage` rows are mapped from the SAME entry but
 * INDEPENDENTLY of that guard: they are informational detail that
 * stands on its own filter, so a corrupt window suppresses the window
 * only. A category whose counts contradicted each other is exactly when
 * per-tool detail is most useful.
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
    // Trust the RAW fields while they agree with each other (#191).
    // Z.AI also reports cumulative currentValue (observed live: 5067
    // against a usage of 1000, with `remaining` 0) — there the counts and
    // the published remaining contradict each other by thousands, so
    // neither is evidence: deriving a percentage from such a counter
    // fabricated 0% remaining, which downstream read as exhaustion while
    // MCP calls kept succeeding (#109's partial rescue had the same
    // failure mode, publishing the untrustworthy `remaining` verbatim).
    // The category is still emitted so doctor and ranking can see the
    // provider row; it simply carries no window.
    const used = readNumber(timeLimit.currentValue);
    const limit = readNumber(timeLimit.usage);
    const usedPercent = readNumber(timeLimit.percentage);
    const duration = { durationSeconds, resetsAtEpochMs: readNumber(timeLimit.nextResetTime) };
    // Mapped OUTSIDE the guard, deliberately: a corrupt window (the
    // inconsistent-counter case below) suppresses the window, never the
    // per-tool rows.
    const toolUsage = readToolUsage(timeLimit);
    categories.push({
      name: "requests",
      unit: "requests",
      current: isConsistentTimeLimit(timeLimit)
        ? buildQuotaWindow({
            ...duration,
            used,
            limit,
            // Z.AI `percentage` is a USED percentage — convert it to a
            // remaining one. It is present whenever the entry is
            // consistent, and it wins over the counts-derived value, so
            // the Provider's own reading is what callers see.
            explicitRemainingPercent: 100 - usedPercent!,
          })
        : {},
      // Omitted entirely when nothing survives the filter — never `[]`.
      ...(toolUsage !== undefined ? { toolUsage } : {}),
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
