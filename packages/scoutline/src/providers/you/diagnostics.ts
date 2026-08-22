/**
 * You.com Diagnostics Capability (SPEC §6).
 *
 * Probes You.com connectivity with a single, cheapest-possible request —
 * `POST /v1/search` with `count: 1` and a stub query — so the doctor
 * command can verify a credential authenticates without burning deep
 * credits. Mirrors `providers/exa/diagnostics.ts`.
 *
 * The probe targets the index host (`ydc-index.io`) because the search
 * endpoint is the cheapest credible connectivity check; the research
 * host (`api.you.com`) hosts the expensive research runs and is never
 * probed. The probe is billable (SPEC §6 — `probeCostsCredit: true`).
 *
 * Boundary rules (ARCHITECTURE.md §2):
 *   - May import the diagnostics capability contract, Adapter-local
 *     config, Adapter-local search transport, and normalized errors.
 *   - Must NOT import command presentation or another Provider's
 *     Adapter.
 */

import type { DiagnosticsCapability, DiagnosticOptions } from "../../capabilities/diagnostics.js";
import { createProbeErrorNormalizer, STANDARD_PROBE_PASS_THROUGH } from "../../lib/probe-errors.js";
import { requireYouApiKey } from "./credentials.js";
import { fetchYouSearch, type YouTransportDeps } from "./client.js";

/**
 * Probe failure wrapper. Mirrors the client's status mapping for the
 * subset of errors the probe can surface. The probe throws on failure;
 * the doctor command catches the throw and records a redacted error
 * entry. We never embed raw Provider bodies.
 */
const normalizeProbeError = createProbeErrorNormalizer({
  passThrough: STANDARD_PROBE_PASS_THROUGH,
  fallbackMessage: "You.com diagnostics probe failed",
});

/**
 * Options for the You.com DiagnosticsCapability. The API key is
 * resolved from `env`; transport dependencies (`fetch`, timers) are
 * injectable for deterministic tests through the unified `transport`
 * seam.
 */
export interface YouDiagnosticsCapabilityOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly transport?: YouTransportDeps;
}

/**
 * Build the You.com DiagnosticsCapability. The probe performs ONE
 * `/search` request with `count: 1` and a stub query so it costs the
 * cheapest credible request. Shared execution owns the retry policy;
 * this transport performs exactly one attempt per invocation.
 *
 * When `options.probe` is false, `invoke` resolves immediately without
 * touching the network — the doctor command skips probing unconfigured
 * or tools-disabled Providers before reaching this Capability.
 */
export function createYouDiagnosticsCapability(
  options: YouDiagnosticsCapabilityOptions,
): DiagnosticsCapability {
  const { env, transport } = options;
  return {
    async invoke(diagOptions: DiagnosticOptions): Promise<void> {
      if (!diagOptions.probe) return;
      const apiKey = requireYouApiKey(env);
      try {
        // One-count search — cheapest credible probe.
        await fetchYouSearch(apiKey, { query: "scoutline-doctor-probe", count: 1 }, transport);
      } catch (error) {
        throw normalizeProbeError(error);
      }
    },
  };
}
