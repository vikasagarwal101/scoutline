/**
 * Diagnostics Capability Contract (DESIGN.md §14, P4-04).
 *
 * Defines the schema-version-1 diagnostics report every `doctor`
 * invocation returns, plus the capability contract each Provider
 * Adapter implements so its connectivity can be probed without a
 * generative request.
 *
 * The report is built by the doctor command from static descriptor
 * metadata plus the success/failure of each configured Provider probe.
 * Each Adapter performs exactly ONE connectivity attempt; shared
 * execution owns the retry policy.
 *
 * Boundary rules (ARCHITECTURE.md §2):
 *   - Imports Provider identity types, shared errors, the Vision
 *     operation→capability mapping, and the MiniMax specialized Vision
 *     conformance registry metadata (a pure snapshot, no transport).
 *   - Imports no Provider transport, no Provider Adapter, no command
 *     presentation.
 *
 * Normalization rules (DESIGN.md §14):
 *   - Z.AI connectivity uses tool discovery (list tools from UTCP).
 *   - MiniMax connectivity uses a raw single-attempt quota probe
 *     (Adapter-local quota client), NOT `QuotaCapability.invoke()`,
 *     because it authenticates without a generative request.
 *   - For the base release `sharedCapabilities` is Search, general
 *     single-image interpretation, quota, and diagnostics.
 *   - `zaiOnlyCapabilities` is Reader, repository exploration, raw
 *     provider tools, Code Mode, image diff, and video analysis.
 */

import type { ProviderCapability, ProviderId } from "../providers/types.js";
import { ScoutlineError, type ScoutlineErrorCode } from "../lib/errors.js";
import { visionOperationToCapability } from "./vision.js";
import { listSupportedMiniMaxVisionOperations } from "../providers/minimax/vision-conformance.js";

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
// Static base-release metadata
// ---------------------------------------------------------------------------

/**
 * Capabilities supported by every Provider in the base release (DESIGN.md
 * §14, §15). The four base capabilities are static; specialized Vision
 * operations move into shared metadata only when their compiled
 * conformance registry entry is supported. At P5-02 every specialized
 * entry is pending, so this list reduces to the base four. P5-03's
 * attested mappings automatically extend this list through the single
 * registry query — there is no parallel support list to maintain.
 */
export const SHARED_CAPABILITIES: readonly ProviderCapability[] = buildSharedCapabilities();

function buildSharedCapabilities(): readonly ProviderCapability[] {
  const caps: ProviderCapability[] = ["search", "vision.interpret-image", "quota", "diagnostics"];
  for (const op of listSupportedMiniMaxVisionOperations()) {
    caps.push(visionOperationToCapability(op));
  }
  return Object.freeze(caps);
}

/**
 * Capabilities that remain Z.AI-only in the base release (DESIGN.md §14),
 * in the documented order: Reader, repository exploration, raw provider
 * tools, Code Mode, image diff, and video analysis.
 */
export const ZAI_ONLY_CAPABILITIES: readonly string[] = [
  "reader",
  "repository-exploration",
  "raw-provider-tools",
  "code-mode",
  "image-diff",
  "video-analysis",
];

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
