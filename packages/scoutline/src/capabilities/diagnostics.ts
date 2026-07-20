/**
 * Diagnostics Capability Contract (DESIGN.md §14, P4-04, P6-06).
 *
 * Defines the schema-version-1 diagnostics report every `doctor`
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
 * Inventory derivation (P6-06):
 *   - `sharedCapabilities` is the intersection across every descriptor
 *     passed to `buildDiagnosticsReport`, preserving deterministic
 *     canonical order from the FIRST descriptor.
 *   - `zaiOnlyCapabilities` is the Z.AI descriptor's capabilities
 *     minus the union of every OTHER built-in descriptor's
 *     capabilities, preserving Z.AI descriptor order. Values are
 *     descriptor capability IDs only — no hand-maintained aliases.
 *   - `repository-exploration` is excluded from shared while any
 *     built-in lacks it, and included in Z.AI-only the moment Z.AI
 *     advertises it and another built-in does not.
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

export interface DiagnosticsReport {
  readonly schemaVersion: 1;
  readonly effectiveProvider: ProviderId;
  readonly sharedCapabilities: readonly ProviderCapability[];
  readonly zaiOnlyCapabilities: readonly string[];
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
 * Derive the shared Capabilities inventory: the intersection of every
 * descriptor's `capabilities()` set, preserving deterministic
 * canonical order from the FIRST descriptor in the list.
 *
 * Edge cases:
 *   - Empty descriptor list: returns an empty array.
 *   - Single descriptor: returns that descriptor's capabilities in
 *     their declared order (the intersection of one set is itself).
 *   - Two or more: keeps a capability from the first descriptor iff
 *     every other descriptor also advertises it.
 *
 * The returned array is frozen so callers cannot mutate the cached
 * derivation in place.
 */
export function deriveSharedCapabilities(
  descriptors: readonly ProviderDescriptor[],
): readonly ProviderCapability[] {
  if (descriptors.length === 0) return Object.freeze([]);
  const [first, ...rest] = descriptors;
  if (rest.length === 0) {
    return Object.freeze([...first.capabilities()]);
  }
  const otherSets = rest.map((d) => d.capabilities());
  const out: ProviderCapability[] = [];
  for (const cap of first.capabilities()) {
    if (otherSets.every((set) => set.has(cap))) {
      out.push(cap);
    }
  }
  return Object.freeze(out);
}

/**
 * Derive the Z.AI-only Capabilities inventory: capabilities advertised
 * by the Z.AI descriptor minus the union of capabilities advertised by
 * every OTHER descriptor in the list. Preserves Z.AI descriptor order.
 *
 * Edge cases:
 *   - Empty descriptor list: returns an empty array.
 *   - Z.AI absent from the list: returns an empty array.
 *   - Z.AI present as the only descriptor: returns its capabilities
 *     verbatim (the "minus nothing" case).
 *   - Z.AI with other descriptors: each capability in Z.AI descriptor
 *     order is kept iff no other descriptor advertises it.
 *
 * The returned values are descriptor capability IDs only. No
 * hand-maintained aliases, no parallel base-release list, no
 * invented names. `repository-exploration` lands here naturally the
 * moment Z.AI advertises it and another built-in does not.
 */
export function deriveZaiOnlyCapabilities(
  descriptors: readonly ProviderDescriptor[],
): readonly ProviderCapability[] {
  const zai = descriptors.find((d) => d.id === "zai");
  if (!zai) return Object.freeze([]);
  const others = descriptors.filter((d) => d.id !== "zai");
  if (others.length === 0) {
    return Object.freeze([...zai.capabilities()]);
  }
  const union = new Set<ProviderCapability>();
  for (const descriptor of others) {
    for (const cap of descriptor.capabilities()) {
      union.add(cap);
    }
  }
  const out: ProviderCapability[] = [];
  for (const cap of zai.capabilities()) {
    if (!union.has(cap)) {
      out.push(cap);
    }
  }
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
