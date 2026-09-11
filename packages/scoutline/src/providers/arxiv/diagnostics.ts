/**
 * arXiv Diagnostics Capability.
 *
 * Keyless connectivity probe (DESIGN D2 round-3 ruling): doctor probes
 * every always-configured science supplier, so the arXiv probe is ONE
 * bounded keyless wire call on the arXiv query endpoint —
 * `max_results=1` — never a full search. When `diagOptions.probe` is
 * false, `invoke` resolves immediately without touching the network.
 *
 * Boundary rules (ARCHITECTURE.md §2):
 *   - May import the diagnostics contract, Adapter-local transport,
 *     and the shared probe-error normalizer.
 *   - Must NOT import command presentation or another Provider's Adapter.
 */
import type { DiagnosticsCapability, DiagnosticOptions } from "../../capabilities/diagnostics.js";
import { createProbeErrorNormalizer, STANDARD_PROBE_PASS_THROUGH } from "../../lib/probe-errors.js";
import { fetchArxivQuery, type ArxivTransportDeps } from "./client.js";

/**
 * Probe failure wrapper. The probe throws on failure; the doctor
 * command catches the throw and records a redacted error entry. No raw
 * Provider body ever crosses the diagnostics boundary.
 */
const normalizeProbeError = createProbeErrorNormalizer({
  passThrough: STANDARD_PROBE_PASS_THROUGH,
  fallbackMessage: "arXiv diagnostics probe failed",
});

export interface ArxivDiagnosticsCapabilityOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly transport?: ArxivTransportDeps;
}

/**
 * Build the arXiv DiagnosticsCapability. The probe performs ONE
 * bounded keyless query (max_results=1) — the cheapest credible
 * liveness check on the arXiv API. Shared execution owns the retry
 * policy; this transport performs exactly one attempt per invocation.
 */
export function createArxivDiagnosticsCapability(
  options: ArxivDiagnosticsCapabilityOptions,
): DiagnosticsCapability {
  const { transport } = options;
  return {
    async invoke(diagOptions: DiagnosticOptions): Promise<void> {
      if (!diagOptions.probe) return;
      try {
        // One bounded keyless call on the arXiv query endpoint.
        await fetchArxivQuery({ search_query: "all:probe", max_results: 1 }, transport);
      } catch (error) {
        throw normalizeProbeError(error);
      }
    },
  };
}
