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
 *   - A Provider that publishes an exact `remaining` without a limit
 *     (unknown-limit window — GitHub #49) reports that value verbatim;
 *     `used`, `limit`, and `remainingPercent` are omitted rather than
 *     inferred or fabricated.
 *   - Invalid optional counts are omitted together (not set to zero).
 *   - A category that has neither a valid percentage, nor valid counts,
 *     nor an explicit remaining is rejected with `QUOTA_ERROR`.
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
  /**
   * Remaining share of the window, 0..100. OPTIONAL since #49: a
   * Provider that reports an exact `remaining` but no limit (Jina's
   * `X-RateLimit-Remaining-*` headers) has no honest percentage — the
   * field is omitted rather than fabricated against an inferred tier.
   */
  remainingPercent?: number;
  resetsAt?: string;
}

export interface QuotaCategory {
  name: string;
  unit: "requests" | "tokens" | "credits" | "USD";
  current: QuotaWindow;
  weekly?: QuotaWindow;
}

export interface ProviderQuotaSuccess {
  provider: ProviderId;
  status: "ok";
  plan?: string;
  categories: QuotaCategory[];
  /**
   * Optional provider-authored caveat(s) the quota command surfaces to
   * the user alongside the dashboard. A generic, provider-neutral
   * channel: a Provider that needs to flag a caveat about its quota
   * numbers (e.g. Brave reports a rate-limit window, NOT spend or
   * credits consumed under metered billing) populates this field; the
   * command renders each entry to stderr without branching on provider
   * identity. Additive and backward-compatible — Providers with no
   * caveat simply omit the field.
   */
  warnings?: readonly string[];
  /**
   * Source + freshness label (PB-T5 — Plan B). Additive under schema
   * version 1: when omitted (the pre-PB-T5 caller path), the row is a
   * direct live probe whose freshness is implicit (the dashboard was
   * just built). When the dashboard reads PB-T1's snapshot, this field
   * carries the source ("snapshot" vs "live" fallback) and the
   * authoritative flag so a user can correlate a selection pick with
   * the data that drove it without misattributing it to fresher data
   * than it is.
   *
   * Freshness is judged solely from `observedAt` — the snapshot's
   * ground-truth clock — never from `locallyUpdatedAt` (PB-T2's local
   * decrement never resets the staleness clock).
   */
  readonly quotaSource?: QuotaSourceLabel;
}

export interface ProviderQuotaFailure {
  provider: ProviderId;
  status: "error";
  error: { code: ScoutlineErrorCode; message: string; help?: string };
}

/**
 * A configured Provider that advertises no `quota` Capability (PB-T5 —
 * Plan B). Today only Exa matches this row in `all-providers` mode: it
 * is configured and capable inventory, but has no quota endpoint to
 * probe. The dashboard emits this variant with **zero adapter/transport
 * calls** — no descriptor.create(), no quota.invoke(), no fallback to a
 * live probe. The variant is additive under schema version 1: every
 * existing consumer (TTY renderer, exit-code computation, warnings
 * loop) handles `status` via fall-through, so the new `"none"` value
 * cannot break a pre-PB-T5 caller.
 *
 * Single-Provider (`--provider <id>`) mode still throws
 * `UnsupportedCapabilityError` when the pinned Provider lacks `quota` —
 * the user explicitly asked for one Provider's quota, so emitting a
 * no-signal row would hide the user error. The no-signal row appears
 * only in `all-providers` mode (the default).
 */
export interface ProviderQuotaNone {
  readonly provider: ProviderId;
  readonly status: "none";
  readonly reason: "no-capability";
}

/**
 * Where a {@link ProviderQuotaSuccess} row's data came from (PB-T5).
 * Carried as a flat sub-object so consumers that don't read it pay
 * nothing. See {@link ProviderQuotaSuccess.quotaSource}.
 */
export interface QuotaSourceLabel {
  /**
   * `"snapshot"` — read from PB-T1's `state.json` and judged fresh.
   * `"live"` — the snapshot was stale/missing/corrupt, so the
   * dashboard fell back to a live probe (and awaited the write-through
   * to the snapshot before returning).
   */
  readonly source: "snapshot" | "live";
  /** Epoch-ms the underlying observation was made (`observedAt`). */
  readonly observedAt: number;
  /**
   * Whether `observedAt` is within the authoritative staleness
   * threshold (`DEFAULT_QUOTA_STALE_THRESHOLD_MS`, 10 min). Selection
   * (PB-T4) treats non-authoritative rows as eligible-but-neutral; the
   * dashboard surfaces the same flag so a user can correlate a
   * selection pick with the data that drove it. A `"live"` row is
   * always authoritative (just observed); a `"snapshot"` row is
   * authoritative iff `observedAt` is within the threshold.
   */
  readonly authoritative: boolean;
}

export interface QuotaDashboard {
  schemaVersion: 1;
  effectiveProvider: ProviderId;
  providers: Array<ProviderQuotaSuccess | ProviderQuotaFailure | ProviderQuotaNone>;
}

export interface QuotaCapability {
  invoke(): Promise<ProviderQuotaSuccess>;
}

// ---------------------------------------------------------------------------
// Window builder (shared by every Provider normalizer)
// ---------------------------------------------------------------------------

/**
 * Inputs to {@link buildQuotaWindow}. Every field is optional except
 * that at least one of `explicitRemainingPercent`, a valid count set
 * (`used` + `limit`), or an explicit finite nonnegative `remaining`
 * must be present, otherwise the window is unrecoverable and
 * `QUOTA_ERROR` is thrown.
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
  /**
   * A Provider-supplied EXACT remaining count for a window whose limit
   * is unknown (GitHub #49). Used only when neither an explicit
   * percentage nor a valid count set is present: the built window
   * carries `remaining` verbatim and omits `used`, `limit`, and
   * `remainingPercent` — nothing is inferred from tier tables or
   * fabricated as a percentage.
   */
  remaining?: number;
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
  return Math.round(value * 10) / 10;
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
 * Resolution order:
 *   1. A finite explicit remaining percentage wins (then clamped).
 *   2. Otherwise derive the percentage from valid counts.
 *   3. Otherwise, when neither is available but an explicit finite
 *      nonnegative `remaining` is supplied (unknown-limit window,
 *      GitHub #49), publish that value verbatim with `used`, `limit`,
 *      and `remainingPercent` omitted — never inferred, never
 *      fabricated.
 *   4. Otherwise throw `QUOTA_ERROR` — the category is unrecoverable.
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

  const counts = validCountSet(inputs.used, inputs.limit);
  // Unknown-limit window (#49): the ONLY new accepting path is an
  // explicit remaining with no count set. A count set whose percentage
  // cannot be derived (e.g. `limit <= 0`) still throws exactly as
  // before, so every pre-#49 input keeps its previous outcome.
  const remainingOnly =
    counts === null &&
    remainingPercent === undefined &&
    typeof inputs.remaining === "number" &&
    Number.isFinite(inputs.remaining);

  if (remainingPercent === undefined && !remainingOnly) {
    throw new ScoutlineError(
      "quota category has neither a valid remaining percentage nor valid counts",
      "QUOTA_ERROR",
      { exitCode: 1 },
    );
  }

  const window: QuotaWindow = {};
  if (remainingPercent !== undefined) {
    window.remainingPercent = clampPercent(remainingPercent);
  }

  if (counts !== null) {
    window.used = counts.used;
    window.limit = counts.limit;
    window.remaining = counts.limit - counts.used;
  } else if (remainingOnly) {
    window.remaining = inputs.remaining;
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
