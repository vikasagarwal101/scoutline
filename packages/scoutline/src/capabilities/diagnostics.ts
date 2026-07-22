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
        providers.push(descriptors[index].id);
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
