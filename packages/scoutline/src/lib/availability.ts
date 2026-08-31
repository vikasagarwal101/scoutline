/**
 * Provider availability — classification and healthy-first ordering
 * (provider-availability plan, DESIGN D2/D7; fixes GitHub #94).
 *
 * Doctor keeps every row (a diagnostics tool that hides dead providers
 * is a tautology) and annotates each with a closed-vocabulary
 * `availability` value plus a top-level `availableProviders` short
 * list, sorted healthy-first so agents can read the usable providers
 * off the top of the report without destroying the diagnostic record.
 *
 * Availability NEVER fabricates: there is no snapshot entry ⇒ never
 * "exhausted". The exhaustion signal is snapshot-based (a fresh 0%
 * reading on a capability-relevant quota category), never
 * probe-error-based — Tavily and Perplexity structurally demote quota
 * failures to generic ApiError/NetworkError in probe normalization, so
 * an error-code classifier would miss exactly the live case this
 * module exists to surface.
 *
 * Boundary rules:
 *   - **Clock-free, registry-free.** `now` is a parameter and the
 *     registry tiebreak rank is injected by the caller; this module
 *     never reads the system clock nor imports the provider registry.
 *   - Pure derivation only: no disk I/O, no transport, no
 *     `process.stderr.write`. Imports the quota contract types and the
 *     staleness gate from `lib/quota-store.js` and the
 *     capability-relevant category names from `lib/quota-mapping.js`.
 */

import type { ProviderId } from "../providers/types.js";
import { getProviderQuotaCategoryNames } from "./quota-mapping.js";
import { isQuotaSnapshotStale, type ProviderQuotaSnapshot } from "./quota-store.js";

// ---------------------------------------------------------------------------
// Availability taxonomy (DESIGN D2 — closed set, no "degraded" tier)
// ---------------------------------------------------------------------------

/**
 * The closed availability vocabulary for a provider row:
 *
 * - `"ok"` — usable now.
 * - `"exhausted"` — fresh snapshot evidence of a capability-relevant
 *   quota pool at `remainingPercent === 0`, regardless of the probe
 *   outcome (a probe-error row with fresh-0% evidence is `exhausted`).
 * - `"error"` — the probe failed with no fresh-0% evidence.
 * - `"unconfigured"` — the provider is not configured (no credentials).
 */
export type ProviderAvailability = "ok" | "exhausted" | "error" | "unconfigured";

/**
 * Class rank for healthy-first ordering (DESIGN D7): healthy providers
 * first, then exhausted (data says "out of budget"), then probe errors,
 * then unconfigured. Stable: same-class rows keep registry order.
 */
export const AVAILABILITY_CLASS_RANK: Readonly<Record<ProviderAvailability, number>> = {
  ok: 0,
  exhausted: 1,
  error: 2,
  unconfigured: 3,
};

/**
 * The minimal row shape {@link classifyAvailability} needs. The doctor
 * report rows (`ProviderDiagnostic`) satisfy it structurally; keeping
 * the input narrow keeps this module decoupled from the capability
 * contract.
 */
export interface AvailabilityRowShape {
  readonly status: "ok" | "error" | "skipped";
  readonly provider: ProviderId;
  readonly reason?: "not-configured" | "tools-disabled";
}

/**
 * Classify one provider row's availability. Evaluated in precedence
 * order (first match wins):
 *
 * 1. `unconfigured` — the row is the not-configured skip
 *    (`status: "skipped"`, `reason: "not-configured"`; today's
 *    `!isConfigured(env)` row).
 * 2. `exhausted` — a snapshot entry exists AND is fresh
 *    (`!isQuotaSnapshotStale`, the standard 10-min gate) AND some
 *    **capability-relevant** category sits at
 *    `remainingPercent === 0`. Capability-relevant = the names
 *    `getProviderQuotaCategoryNames` maps for the provider's
 *    quota-capability scoring — Tavily's key-pool `requests`, not its
 *    account-level `plan`. Providers with no mapping rows fall back to
 *    the honest "any fresh category at 0%" rule. A tools-disabled
 *    (`--no-tools`) row takes this same snapshot rule — the gate is
 *    absence of snapshot evidence, not the flag.
 * 3. `error` — the probe failed with no fresh-0% evidence.
 * 4. `ok` — everything else.
 *
 * A bare scaffold entry (`observedAt === 0`) is stale for any realistic
 * `now`, so it can never fabricate exhaustion.
 */
export function classifyAvailability(
  row: AvailabilityRowShape,
  snapshotEntry: ProviderQuotaSnapshot | undefined,
  now: number,
): ProviderAvailability {
  if (row.status === "skipped" && row.reason === "not-configured") {
    return "unconfigured";
  }
  if (snapshotEntry !== undefined && !isQuotaSnapshotStale(snapshotEntry, now)) {
    const relevant = getProviderQuotaCategoryNames(row.provider);
    const exhausted =
      relevant === undefined || relevant.size === 0
        ? snapshotEntry.categories.some(
            (category) => category.current?.remainingPercent === 0,
          )
        : snapshotEntry.categories.some(
            (category) =>
              relevant.has(category.name) && category.current?.remainingPercent === 0,
          );
    if (exhausted) return "exhausted";
  }
  if (row.status === "error") return "error";
  return "ok";
}

/**
 * Stable healthy-first comparator (DESIGN D7). Primary key: the
 * caller-extracted availability class rank; secondary: the
 * caller-injected registry-order rank; ties keep input order (the
 * caller's sort must be stable — `Array.prototype.sort` is stable in
 * every ES2019+ engine).
 *
 * The class extraction is a parameter so the same comparator serves
 * other report orderings without editing this module (e.g. the quota
 * dashboard's `ok` < `error` < `none` row status). The registry rank
 * lookup is built by the caller — this module stays registry-free.
 */
export function compareAvailabilityRows<T>(
  a: T,
  b: T,
  classOf: (row: T) => number,
  tiebreakOf?: (row: T) => number,
): number {
  const classDelta = classOf(a) - classOf(b);
  if (classDelta !== 0) return classDelta;
  if (tiebreakOf !== undefined) {
    const tiebreakDelta = tiebreakOf(a) - tiebreakOf(b);
    if (tiebreakDelta !== 0) return tiebreakDelta;
  }
  return 0;
}
