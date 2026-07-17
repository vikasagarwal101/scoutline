/**
 * Quota Capability Contract (DESIGN.md §13, ADR-0001).
 *
 * Defines the normalized Provider-quota Interface shared by every
 * Provider that reports plan usage. Each Adapter maps its Provider
 * response shape into named quota categories with current and optional
 * weekly windows, optional counts, a remaining percentage, and a reset
 * time so callers do not need Provider-specific knowledge.
 *
 * Normalization rules (DESIGN.md §13):
 *   - Percentages are REMAINING percentages clamped to 0..100.
 *   - A valid explicit remaining percentage wins; otherwise derive
 *     `(remaining / limit) * 100` from finite nonnegative counts where
 *     used is not greater than limit.
 *   - Invalid optional counts are omitted together (not set to zero).
 *   - A category that has neither a valid percentage nor valid counts
 *     is rejected with `QUOTA_ERROR`.
 *   - Nonempty names, finite values, and ISO dates are mandatory.
 *
 * This module imports only Provider identity types and shared errors;
 * it imports no Provider transport and no Provider Adapter.
 */

import type { ProviderId } from "../providers/types.js";
import { ScoutlineError, type ScoutlineErrorCode } from "../lib/errors.js";

// ---------------------------------------------------------------------------
// Normalized quota shapes (DESIGN.md §13 — copied exactly)
// ---------------------------------------------------------------------------

export interface QuotaWindow {
  durationSeconds?: number;
  used?: number;
  limit?: number;
  remaining?: number;
  remainingPercent: number;
  resetsAt?: string;
}

export interface QuotaCategory {
  name: string;
  unit: "requests" | "tokens";
  current: QuotaWindow;
  weekly?: QuotaWindow;
}

export interface ProviderQuotaSuccess {
  provider: ProviderId;
  status: "ok";
  plan?: string;
  categories: QuotaCategory[];
}

export interface ProviderQuotaFailure {
  provider: ProviderId;
  status: "error";
  error: { code: ScoutlineErrorCode; message: string; help?: string };
}

export interface QuotaDashboard {
  schemaVersion: 1;
  effectiveProvider: ProviderId;
  providers: Array<ProviderQuotaSuccess | ProviderQuotaFailure>;
}

export interface QuotaCapability {
  invoke(): Promise<ProviderQuotaSuccess>;
}

// ---------------------------------------------------------------------------
// Window builder (shared by every Provider normalizer)
// ---------------------------------------------------------------------------

/**
 * Inputs to {@link buildQuotaWindow}. Every field is optional except
 * that at least one of `explicitRemainingPercent` or a valid count set
 * (`used` + `limit`) must be present, otherwise the window is
 * unrecoverable and `QUOTA_ERROR` is thrown.
 */
export interface QuotaWindowInputs {
  durationSeconds?: number;
  used?: number;
  limit?: number;
  resetsAtEpochMs?: number;
  /**
   * A Provider-supplied REMAINING percentage (already in remaining
   * terms, not used terms). A finite value wins over count-derived
   * derivation and is then clamped to 0..100.
   */
  explicitRemainingPercent?: number;
}

function isFiniteNonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isFinitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function clampPercent(value: number): number {
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}

/**
 * Validate a count set: both `used` and `limit` must be finite,
 * nonnegative, with `used` not greater than `limit`. Returns the pair
 * or `null` so an invalid set can be omitted together.
 */
function validCountSet(
  used: number | undefined,
  limit: number | undefined,
): { used: number; limit: number } | null {
  if (!isFiniteNonnegative(used) || !isFiniteNonnegative(limit)) return null;
  if (used! > limit!) return null;
  return { used: used!, limit: limit! };
}

/**
 * Derive a remaining percentage from finite nonnegative counts where
 * used is not greater than limit and limit is positive. Returns `null`
 * when the counts cannot yield a percentage.
 */
function derivePercentFromCounts(
  used: number | undefined,
  limit: number | undefined,
): number | null {
  const counts = validCountSet(used, limit);
  if (counts === null) return null;
  if (counts.limit <= 0) return null;
  return ((counts.limit - counts.used) / counts.limit) * 100;
}

function epochMsToIso(epochMs: unknown): string | undefined {
  if (!isFinitePositive(epochMs)) return undefined;
  return new Date(epochMs as number).toISOString();
}

/**
 * Build a normalized {@link QuotaWindow} from Provider inputs.
 *
 * Resolution order for `remainingPercent`:
 *   1. A finite explicit remaining percentage wins (then clamped).
 *   2. Otherwise derive from valid counts.
 *   3. Otherwise throw `QUOTA_ERROR` — the category is unrecoverable.
 *
 * Invalid optional counts are omitted together; valid counts populate
 * `used`, `limit`, and a derived `remaining`. `durationSeconds` and
 * `resetsAt` are included only when finite/ISO-valid.
 */
export function buildQuotaWindow(inputs: QuotaWindowInputs): QuotaWindow {
  let remainingPercent: number | undefined;
  if (Number.isFinite(inputs.explicitRemainingPercent)) {
    remainingPercent = inputs.explicitRemainingPercent;
  } else {
    const derived = derivePercentFromCounts(inputs.used, inputs.limit);
    if (derived !== null) remainingPercent = derived;
  }

  if (remainingPercent === undefined) {
    throw new ScoutlineError(
      "quota category has neither a valid remaining percentage nor valid counts",
      "QUOTA_ERROR",
      { exitCode: 1 },
    );
  }

  const window: QuotaWindow = { remainingPercent: clampPercent(remainingPercent) };

  const counts = validCountSet(inputs.used, inputs.limit);
  if (counts !== null) {
    window.used = counts.used;
    window.limit = counts.limit;
    window.remaining = counts.limit - counts.used;
  }

  if (isFinitePositive(inputs.durationSeconds)) {
    window.durationSeconds = inputs.durationSeconds;
  }

  const iso = epochMsToIso(inputs.resetsAtEpochMs);
  if (iso !== undefined) {
    window.resetsAt = iso;
  }

  return window;
}

// ---------------------------------------------------------------------------
// Failure normalization
// ---------------------------------------------------------------------------

/**
 * Map a thrown error into a normalized {@link ProviderQuotaFailure}. The
 * caller is responsible for recursive redaction before the failure
 * crosses an outward boundary (all-provider quota does this in P4-03).
 */
export function quotaFailureFromError(provider: ProviderId, error: unknown): ProviderQuotaFailure {
  const code: ScoutlineErrorCode =
    error instanceof ScoutlineError ? (error.code as ScoutlineErrorCode) : "UNKNOWN_ERROR";
  const message = error instanceof Error ? error.message : String(error);
  const failure: ProviderQuotaFailure = {
    provider,
    status: "error",
    error: { code, message },
  };
  if (error instanceof ScoutlineError && error.help) {
    failure.error.help = error.help;
  }
  return failure;
}
