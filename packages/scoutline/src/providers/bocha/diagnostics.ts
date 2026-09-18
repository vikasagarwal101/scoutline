/**
 * Bocha AI Diagnostics Capability.
 *
 * Probes Bocha AI connectivity with a lightweight web-search request
 * (query "scoutline-doctor-probe", count 1) through the same client
 * the Search Capability uses. Billable. Errors are normalized through
 * the shared probe-error seam so no raw Provider body crosses the
 * diagnostics boundary.
 */

import type { DiagnosticsCapability, DiagnosticOptions } from "../../capabilities/diagnostics.js";
import { createProbeErrorNormalizer, STANDARD_PROBE_PASS_THROUGH } from "../../lib/probe-errors.js";
import { requireBochaApiKey } from "./credentials.js";
import { fetchBochaWebSearch, type BochaTransportDeps } from "./client.js";

const normalizeProbeError = createProbeErrorNormalizer({
  passThrough: STANDARD_PROBE_PASS_THROUGH,
  fallbackMessage: "Bocha AI diagnostics probe failed",
});

export interface BochaDiagnosticsCapabilityOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly transport?: BochaTransportDeps;
}

export function createBochaDiagnosticsCapability(
  options: BochaDiagnosticsCapabilityOptions,
): DiagnosticsCapability {
  const { env, transport } = options;
  return {
    async invoke(diagOptions: DiagnosticOptions): Promise<void> {
      if (!diagOptions.probe) return;
      const apiKey = requireBochaApiKey(env);
      try {
        await fetchBochaWebSearch(
          apiKey,
          { query: "scoutline-doctor-probe", summary: true, count: 1 },
          transport,
        );
      } catch (error) {
        throw normalizeProbeError(error);
      }
    },
  };
}
