/**
 * Europe PMC Diagnostics Capability.
 *
 * Keyless bounded probe (DESIGN D2 round-3 ruling): doctor probes
 * every always-configured science supplier, so the Europe PMC probe is
 * ONE minimal keyless wire call on the search endpoint
 * (`pageSize=1`) — never a full search (arXiv `max_results=1`
 * precedent). When `diagOptions.probe` is false, `invoke` resolves
 * immediately without touching the network.
 */
import type { DiagnosticsCapability, DiagnosticOptions } from "../../capabilities/diagnostics.js";
import { createProbeErrorNormalizer, STANDARD_PROBE_PASS_THROUGH } from "../../lib/probe-errors.js";
import { fetchEuropepmcJson, type EuropepmcTransportDeps } from "./client.js";

const normalizeProbeError = createProbeErrorNormalizer({
  passThrough: STANDARD_PROBE_PASS_THROUGH,
  fallbackMessage: "Europe PMC diagnostics probe failed",
});

export interface EuropepmcDiagnosticsCapabilityOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly transport?: EuropepmcTransportDeps;
}

export function createEuropepmcDiagnosticsCapability(
  options: EuropepmcDiagnosticsCapabilityOptions,
): DiagnosticsCapability {
  const { transport } = options;
  return {
    async invoke(diagOptions: DiagnosticOptions): Promise<void> {
      if (!diagOptions.probe) return;
      try {
        // One minimal keyless wire call on the search endpoint.
        await fetchEuropepmcJson({ query: "*", pageSize: "1" }, transport);
      } catch (error) {
        throw normalizeProbeError(error);
      }
    },
  };
}
