/**
 * Kagi Diagnostics Capability.
 *
 * Probes Kagi connectivity with a lightweight web-search request
 * (query "scoutline-doctor-probe", limit 1) through the same client the Search
 * Capability uses — GET /api/v1/search with `Authorization: Bot <key>`.
 * Billable. Errors are normalized through the shared probe-error seam
 * so no raw Provider body crosses the diagnostics boundary.
 */

import type { DiagnosticsCapability, DiagnosticOptions } from "../../capabilities/diagnostics.js";
import { createProbeErrorNormalizer, STANDARD_PROBE_PASS_THROUGH } from "../../lib/probe-errors.js";
import { requireKagiApiKey } from "./credentials.js";
import { fetchKagiSearch, type KagiTransportDeps } from "./client.js";

const normalizeProbeError = createProbeErrorNormalizer({
  passThrough: STANDARD_PROBE_PASS_THROUGH,
  fallbackMessage: "Kagi diagnostics probe failed",
});

export interface KagiDiagnosticsCapabilityOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly transport?: KagiTransportDeps;
}

export function createKagiDiagnosticsCapability(
  options: KagiDiagnosticsCapabilityOptions,
): DiagnosticsCapability {
  const { env, transport } = options;
  return {
    async invoke(diagOptions: DiagnosticOptions): Promise<void> {
      if (!diagOptions.probe) return;
      const apiKey = requireKagiApiKey(env);
      try {
        await fetchKagiSearch(apiKey, { query: "scoutline-doctor-probe", limit: 1 }, transport);
      } catch (error) {
        throw normalizeProbeError(error);
      }
    },
  };
}
