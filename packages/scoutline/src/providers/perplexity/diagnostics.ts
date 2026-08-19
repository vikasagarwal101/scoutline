/**
 * Perplexity Diagnostics Capability.
 *
 * Probes Perplexity connectivity with a lightweight search request.
 */

import type { DiagnosticsCapability, DiagnosticOptions } from "../../capabilities/diagnostics.js";
import { createProbeErrorNormalizer, STANDARD_PROBE_PASS_THROUGH } from "../../lib/probe-errors.js";
import { requirePerplexityApiKey } from "./credentials.js";
import { fetchPerplexitySearch, type PerplexityTransportDeps } from "./client.js";

const normalizeProbeError = createProbeErrorNormalizer({
  passThrough: STANDARD_PROBE_PASS_THROUGH,
  fallbackMessage: "Perplexity diagnostics probe failed",
});

export interface PerplexityDiagnosticsCapabilityOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly transport?: PerplexityTransportDeps;
}

export function createPerplexityDiagnosticsCapability(
  options: PerplexityDiagnosticsCapabilityOptions,
): DiagnosticsCapability {
  const { env, transport } = options;
  return {
    async invoke(diagOptions: DiagnosticOptions): Promise<void> {
      if (!diagOptions.probe) return;
      const apiKey = requirePerplexityApiKey(env);
      try {
        await fetchPerplexitySearch(apiKey, "scoutline-doctor-probe", { max_results: 1 }, transport);
      } catch (error) {
        throw normalizeProbeError(error);
      }
    },
  };
}
