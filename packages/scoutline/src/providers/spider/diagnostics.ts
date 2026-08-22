/**
 * Spider.cloud Diagnostics Capability.
 *
 * Probes Spider.cloud connectivity with a single, cheapest-possible
 * request — one GET /data/credits — so the doctor command can verify a
 * credential authenticates without burning any credit. Unlike the
 * Firecrawl probe (a one-credit scrape), the credits endpoint is free,
 * so the probe rides the exact same transport as the Quota capability.
 *
 * Boundary rules (ARCHITECTURE.md §2):
 *   - May import the diagnostics contract, Adapter-local config,
 *     Adapter-local credits transport, and normalized errors.
 *   - Must NOT import command presentation or another Provider's Adapter.
 */

import type { DiagnosticsCapability, DiagnosticOptions } from "../../capabilities/diagnostics.js";
import { createProbeErrorNormalizer, STANDARD_PROBE_PASS_THROUGH } from "../../lib/probe-errors.js";
import { requireSpiderApiKey } from "./credentials.js";
import { fetchSpiderCredits, type SpiderTransportDeps } from "./client.js";

/**
 * Probe failure wrapper. The probe throws on failure; the doctor command
 * catches the throw and records a redacted error entry. We never embed
 * raw Provider bodies.
 */
const normalizeProbeError = createProbeErrorNormalizer({
  passThrough: STANDARD_PROBE_PASS_THROUGH,
  fallbackMessage: "Spider diagnostics probe failed",
});

export interface SpiderDiagnosticsCapabilityOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly transport?: SpiderTransportDeps;
}

/**
 * Build the Spider.cloud DiagnosticsCapability. The probe performs ONE
 * GET /data/credits — a free authentication check, the cheapest
 * credible probe. Shared execution owns the retry policy; this
 * transport performs exactly one attempt per invocation.
 *
 * When `diagOptions.probe` is false, `invoke` resolves immediately
 * without touching the network — the doctor command skips probing
 * unconfigured or tools-disabled Providers before reaching this
 * Capability.
 */
export function createSpiderDiagnosticsCapability(
  options: SpiderDiagnosticsCapabilityOptions,
): DiagnosticsCapability {
  const { env, transport } = options;
  return {
    async invoke(diagOptions: DiagnosticOptions): Promise<void> {
      if (!diagOptions.probe) return;
      const apiKey = requireSpiderApiKey(env);
      try {
        // One free credits read — cheapest credible probe (0 credits).
        await fetchSpiderCredits(apiKey, transport);
      } catch (error) {
        throw normalizeProbeError(error);
      }
    },
  };
}
