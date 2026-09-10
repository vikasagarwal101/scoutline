/**
 * Crossref Diagnostics Capability.
 *
 * Keyless bounded probe (DESIGN D2 round-3 ruling): doctor probes
 * every always-configured science supplier, so the Crossref probe is
 * ONE minimal keyless wire call on the works endpoint (`rows=1`) —
 * never a full search. The politeness posture applies to it too: the
 * house UA carrying the mailto contact. When `diagOptions.probe` is
 * false, `invoke` resolves immediately without touching the network.
 */
import type { DiagnosticsCapability, DiagnosticOptions } from "../../capabilities/diagnostics.js";
import { createProbeErrorNormalizer, STANDARD_PROBE_PASS_THROUGH } from "../../lib/probe-errors.js";
import { fetchCrossrefJson, type CrossrefTransportDeps } from "./client.js";

const normalizeProbeError = createProbeErrorNormalizer({
  passThrough: STANDARD_PROBE_PASS_THROUGH,
  fallbackMessage: "Crossref diagnostics probe failed",
});

export interface CrossrefDiagnosticsCapabilityOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly transport?: CrossrefTransportDeps;
}

export function createCrossrefDiagnosticsCapability(
  options: CrossrefDiagnosticsCapabilityOptions,
): DiagnosticsCapability {
  const { transport } = options;
  return {
    async invoke(diagOptions: DiagnosticOptions): Promise<void> {
      if (!diagOptions.probe) return;
      try {
        // One minimal keyless wire call on the works endpoint.
        await fetchCrossrefJson({ rows: "1" }, transport);
      } catch (error) {
        throw normalizeProbeError(error);
      }
    },
  };
}
