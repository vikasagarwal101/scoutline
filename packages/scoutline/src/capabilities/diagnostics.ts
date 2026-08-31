/**
 * Diagnostics Capability Contract (DESIGN.md §14, P4-04, P6-06, Doctor Schema v2).
 *
 * Defines the schema-version-2 diagnostics report every `doctor`
 * invocation returns, plus the capability contract each Provider
 * Adapter implements so its connectivity can be probed without a
 * generative request.
 *
 * The report is built by the doctor command from descriptor-derived
 * inventory plus the success/failure of each configured Provider
 * probe. Each Adapter performs exactly ONE connectivity attempt;
 * shared execution owns the retry policy.
 *
 * Boundary rules (ARCHITECTURE.md §2):
 *   - Imports Provider identity and metadata types (`ProviderCapability`,
 *     `ProviderDescriptor`, `ProviderId`) and shared errors. P6-06 keeps
 *     the inventory descriptor-derived; no concrete Adapter, no
 *     Provider transport, no production registry import lives here.
 *   - Imports no Provider transport, no Provider Adapter, no Vision
 *     operation→capability mapping, no MiniMax specialized-vision
 *     conformance registry, no command presentation. The previous
 *     hand-maintained inventory required those imports; the
 *     descriptor-derived inventory does not.
 *
 * Inventory derivation (Doctor Schema v2):
 *   - `capabilityMatrix` is the per-capability provider list across
 *     every descriptor passed to `buildDiagnosticsReport`. It replaced
 *     the schema-version-1 `sharedCapabilities` (intersection) and
 *     `zaiOnlyCapabilities` (Z.AI-minus-others) pair, which silently
 *     hid any capability shared by 2-of-3 providers under three
 *     built-ins. The matrix is strictly more informative: every
 *     capability is visible with exactly the providers that supply it.
 *   - Capability order: first descriptor's declared order, then
 *     capabilities unique to subsequent descriptors in descriptor
 *     order. Provider order within an entry: descriptor order.
 *   - Values are descriptor capability IDs only — no hand-maintained
 *     aliases.
 */

import type { ProviderCapability, ProviderDescriptor, ProviderId } from "../providers/types.js";
import { ScoutlineError, type ScoutlineErrorCode } from "../lib/errors.js";

// ---------------------------------------------------------------------------
// Report shapes (DESIGN.md §14 — copied exactly)
// ---------------------------------------------------------------------------

export interface DiagnosticOptions {
  readonly probe: boolean;
}

export interface ProviderDiagnostic {
  readonly provider: ProviderId;
  readonly configured: boolean;
  readonly capabilities: readonly ProviderCapability[];
  readonly status: "ok" | "error" | "skipped";
  readonly reason?: "not-configured" | "tools-disabled";
  readonly error?: { code: ScoutlineErrorCode; message: string; help?: string };
  /**
   * Quota snapshot summary for this Provider (PB-T5 — Plan B).
   * Optional: present when the dispatcher threads a quota snapshot
   * through `DoctorDiagnosticsDependencies.quotaSnapshot`. Doctor
   * reports each Provider's quota source (snapshot vs none) +
   * freshness (`observedAt` age; stale → flagged non-authoritative)
   * so a user can correlate a selection pick with the data that drove
   * it. Under `--no-tools` the field still appears when a snapshot is
   * available (a snapshot read is a local state read, not transport).
   *
   * Doctor NEVER live-probes quota — it only reads the snapshot. The
   * `source` is `"snapshot"` only when the Provider advertises the
   * `quota` capability AND the snapshot holds a real entry
   * (`observedAt > 0`) for it; anything else — no `quota` capability,
   * no snapshot entry, or a bare scaffold entry (`observedAt: 0`) —
   * is `"none"`. Additive under schema version 2: pre-PB-T5 callers
   * that omit the dependency produce entries without this field.
   */
  readonly quota?: ProviderDiagnosticQuota;
  /**
   * Verification summary mirroring the Provider's Plan A
   * `config.providers[id].verification` record (PB-T5). Optional:
   * present when the dispatcher threads the configured providers'
   * verification records through
   * `DoctorDiagnosticsDependencies.verificationRecords`. Additive under
   * schema version 2: pre-PB-T5 callers produce entries without it.
   */
  readonly verification?: ProviderVerificationSummary;
}

/**
 * Quota summary embedded in a {@link ProviderDiagnostic} (PB-T5 —
 * Plan B). A structural view of PB-T1's snapshot entry for this
 * Provider: never carries categories (Doctor is observational; full
 * categories belong to the `quota` command). Doctor never live-probes
 * quota, so the source is `"snapshot"` only when the Provider
 * advertises `quota` and the snapshot holds a real entry for it
 * (`observedAt > 0`); otherwise `"none"`.
 */
export interface ProviderDiagnosticQuota {
  /**
   * `"snapshot"` — read from PB-T1's `state.json`, and only when the
   * Provider advertises the `quota` capability and the entry is a
   * real observation (`observedAt > 0`). `"none"` — the Provider does
   * not advertise `quota`, the snapshot has no entry for it, or the
   * entry is a bare scaffold (`observedAt: 0` — created but never
   * observed). Doctor never emits `"live"`; the live probe belongs
   * to the `quota` command, not Doctor.
   */
  readonly source: "snapshot" | "none";
  /**
   * Epoch-ms the snapshot was observed. Omitted when `source` is
   * `"none"` (including the scaffold case — an `observedAt: 0`
   * scaffold is never surfaced as an observation). Freshness is
   * judged solely from `observedAt` — never from
   * `locallyUpdatedAt` (PB-T2's local decrement never resets the
   * staleness clock).
   */
  readonly observedAt?: number;
  /**
   * Whether `observedAt` is within the authoritative staleness
   * threshold (`DEFAULT_QUOTA_STALE_THRESHOLD_MS`, 10 min). Always
   * `false` when `source` is `"none"`. Matches the same flag the
   * `quota` command and PB-T4's selection resolver use, so a user can
   * correlate Doctor's "stale" label with a selection pick that was
   * made against the same snapshot.
   */
  readonly authoritative: boolean;
}

/**
 * Verification summary mirroring Plan A's
 * `ProviderVerification` shape (PB-T5). Defined as a structural twin
 * in the capability contract so `capabilities/diagnostics.ts` does
 * not import from `lib/config-store.ts` (the capability contract
 * imports only Provider identity and metadata types and shared
 * errors — see the boundary rules at the top of this module). The
 * dispatcher maps `ProviderVerification → ProviderVerificationSummary`
 * at the report-dependency boundary.
 */
export interface ProviderVerificationSummary {
  readonly status: "verified" | "unverified";
  readonly checkedAt: number;
  readonly reason?: string;
}

/**
 * One row of the schema-version-2 capability matrix: a capability and
 * the providers (in descriptor order) that advertise it. Replaces the
 * schema-version-1 `sharedCapabilities`/`zaiOnlyCapabilities` pair,
 * which could not represent a capability supplied by 2-of-3 providers.
 */
export interface CapabilityProviderEntry {
  readonly capability: ProviderCapability;
  readonly providers: readonly ProviderId[];
}

export interface DiagnosticsReport {
  readonly schemaVersion: 2;
  readonly effectiveProvider: ProviderId;
  readonly capabilityMatrix: readonly CapabilityProviderEntry[];
  /**
   * Effective per-capability routing table (routing-table plan):
   * the post-validation, post-drop table from config.json, embedded
   * additively (absent when no routing is configured — older readers
   * never see the key). Provider-neutral: ids only, no credentials.
   */
  readonly routing?: Readonly<Record<string, readonly ProviderId[]>>;
  readonly node: {
    readonly version: string;
    readonly visionMcpCompatible: boolean;
  };
  readonly providers: readonly ProviderDiagnostic[];
  /**
   * One-line cache summary embedded by the CLI handler
   * (`Cache: enabled, 47 response entries (12.3 MB), 1 tool entry
   *  (8.2 KB), ~/.scoutline/`). Optional: present when the dispatcher
   * passes a pre-formatted `cacheSummary` through
   * `DoctorDiagnosticsDependencies`. The Doctor report builder NEVER
   * formats this itself (L1 fix); it only embeds what the caller
   * supplied. Older callers that omit the dependency produce a report
   * without this field.
   */
  readonly cache?: { readonly summary: string };
}

/**
 * Capability each Provider Adapter implements for connectivity
 * diagnostics. `invoke` resolves on a successful single connectivity
 * attempt and throws a normalized {@link ScoutlineError} on failure;
 * the doctor command catches the throw and records a redacted error
 * entry. Returning `void` keeps the report builder the single owner of
 * report shape.
 */
export interface DiagnosticsCapability {
  invoke(options: DiagnosticOptions): Promise<void>;
}

// ---------------------------------------------------------------------------
// Descriptor-derived inventory (P6-06).
//
// Pure calculations over the exact descriptor list passed to
// `buildDiagnosticsReport`. No descriptor.create(), no transport, no
// production registry import. Empty/single/missing-ZAI lists are
// handled deterministically; the algorithms never rely on array
// indexing accidents.
// ---------------------------------------------------------------------------

/**
 * Derive the schema-version-2 capability matrix: for each capability
 * advertised by any descriptor, the list of providers (in descriptor
 * order) that supply it.
 *
 * Capability order:
 *   - First, the FIRST descriptor's capabilities in their declared
 *     order.
 *   - Then, capabilities unique to each subsequent descriptor, in
 *     descriptor order.
 *
 * Provider order within an entry: descriptor order (the order
 * descriptors appear in the passed-in list).
 *
 * Edge cases:
 *   - Empty descriptor list: returns an empty array.
 *   - Single descriptor: one entry per capability, each listing only
 *     that descriptor's id.
 *   - Two or more: a capability supplied by multiple descriptors lists
 *     every supplying descriptor's id — unlike the schema-version-1
 *     intersection/minus pair, nothing is hidden.
 *
 * The returned array (and each entry's `providers`) is frozen so
 * callers cannot mutate the cached derivation in place.
 */
export function deriveCapabilityMatrix(
  descriptors: readonly ProviderDescriptor[],
): readonly CapabilityProviderEntry[] {
  if (descriptors.length === 0) return Object.freeze([]);

  // Materialize each descriptor's capability set once (pure metadata).
  const capabilitySets = descriptors.map((d) => d.capabilities());

  // Establish deterministic capability order: first descriptor's
  // declared order, then capabilities unique to subsequent descriptors
  // in descriptor order.
  const seen = new Set<ProviderCapability>();
  const ordered: ProviderCapability[] = [];
  for (const set of capabilitySets) {
    for (const cap of set) {
      if (!seen.has(cap)) {
        seen.add(cap);
        ordered.push(cap);
      }
    }
  }

  // For each capability, list the providers that advertise it, in
  // descriptor order.
  const out: CapabilityProviderEntry[] = ordered.map((cap) => {
    const providers: ProviderId[] = [];
    capabilitySets.forEach((set, index) => {
      if (set.has(cap)) {
        const descriptor = descriptors[index];
        if (descriptor) {
          providers.push(descriptor.id);
        } else {
          throw new Error(
            `Capability/descriptor mismatch: descriptor at index ${index} is missing while capabilitySets indicates it advertises "${cap}"`,
          );
        }
      }
    });
    return { capability: cap, providers: Object.freeze(providers) as readonly ProviderId[] };
  });

  return Object.freeze(out);
}

// ---------------------------------------------------------------------------
// Failure normalization
// ---------------------------------------------------------------------------

/**
 * Map a thrown error into a normalized diagnostic error entry. The
 * caller is responsible for recursive redaction before the entry
 * crosses an outward boundary (the doctor command does this in
 * {@link buildDiagnosticsReport}).
 */
export function diagnosticErrorFromError(error: unknown): {
  code: ScoutlineErrorCode;
  message: string;
  help?: string;
} {
  const code: ScoutlineErrorCode =
    error instanceof ScoutlineError ? (error.code as ScoutlineErrorCode) : "UNKNOWN_ERROR";
  const message = error instanceof Error ? error.message : String(error);
  const result: { code: ScoutlineErrorCode; message: string; help?: string } = {
    code,
    message,
  };
  if (error instanceof ScoutlineError && error.help) {
    result.help = error.help;
  }
  return result;
}
