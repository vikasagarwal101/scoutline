/**
 * Linkup Diagnostics Capability.
 *
 * Probes Linkup connectivity with the SAME non-destructive
 * `GET /v1/credits/balance` the Quota Capability reads: the probe
 * authenticates the Bearer key without spending credits. The probe
 * NEVER POSTs a search — a diagnostics probe must not be metered.
 *
 * Structurally cloned from the Jina diagnostics pattern
 * (non-destructive GET, IMPLEMENTATION-CONTRACT analog-adapter table).
 *
 * Boundary rules (ARCHITECTURE.md §2):
 *   - May import the diagnostics capability contract, Adapter-local
 *     credentials, Adapter-local transport, and normalized errors.
 *   - Must NOT import command presentation or another Provider's
 *     Adapter.
 */

import type {
  DiagnosticsCapability,
  DiagnosticOptions,
} from "../../capabilities/diagnostics.js";
import { createProbeErrorNormalizer, STANDARD_PROBE_PASS_THROUGH } from "../../lib/probe-errors.js";
import { requireLinkupApiKey } from "./credentials.js";
import { fetchLinkupCreditBalance, type LinkupTransportDeps } from "./client.js";

const normalizeProbeError = createProbeErrorNormalizer({
  passThrough: STANDARD_PROBE_PASS_THROUGH,
  fallbackMessage: "Linkup diagnostics probe failed",
});

/**
 * Options for the Linkup DiagnosticsCapability. The API key is
 * resolved from `env`; transport dependencies (`fetch`, timers) are
 * injectable for deterministic tests through the unified `transport`
 * seam.
 */
export interface LinkupDiagnosticsCapabilityOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly transport?: LinkupTransportDeps;
}

/**
 * Build the Linkup DiagnosticsCapability. The probe performs ONE GET
 * against `/credits/balance` — the cheapest credible authentication
 * check, costless on metered billing. When `options.probe` is false,
 * `invoke` resolves immediately without touching the network — the
 * doctor command skips probing unconfigured or tools-disabled
 * Providers before reaching this Capability.
 */
export function createLinkupDiagnosticsCapability(
  options: LinkupDiagnosticsCapabilityOptions,
): DiagnosticsCapability {
  const { env, transport } = options;
  return {
    async invoke(diagOptions: DiagnosticOptions): Promise<void> {
      if (!diagOptions.probe) return;
      const apiKey = requireLinkupApiKey(env);
      try {
        await fetchLinkupCreditBalance(apiKey, transport);
      } catch (error) {
        throw normalizeProbeError(error);
      }
    },
  };
}
