/**
 * Parallel AI Diagnostics Capability.
 *
 * Probes Parallel AI connectivity with a lightweight probe request.
 */

import type { DiagnosticsCapability, DiagnosticOptions } from "../../capabilities/diagnostics.js";
import { createProbeErrorNormalizer, STANDARD_PROBE_PASS_THROUGH } from "../../lib/probe-errors.js";
import { requireParallelApiKey } from "./credentials.js";
import { fetchParallelSearch, type ParallelTransportDeps } from "./client.js";

const normalizeProbeError = createProbeErrorNormalizer({
  passThrough: STANDARD_PROBE_PASS_THROUGH,
  fallbackMessage: "Parallel AI diagnostics probe failed",
});

export interface ParallelDiagnosticsCapabilityOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly transport?: ParallelTransportDeps;
}

export function createParallelDiagnosticsCapability(
  options: ParallelDiagnosticsCapabilityOptions,
): DiagnosticsCapability {
  const { env, transport } = options;
  return {
    async invoke(diagOptions: DiagnosticOptions): Promise<void> {
      if (!diagOptions.probe) return;
      const apiKey = requireParallelApiKey(env);
      try {
        await fetchParallelSearch(apiKey, "scoutline-doctor-probe", {}, transport);
      } catch (error) {
        throw normalizeProbeError(error);
      }
    },
  };
}
