/**
 * SearchApi.io Diagnostics Capability.
 *
 * Probes SearchApi connectivity with a single, non-destructive GET
 * against `/api/v1/me` — the account/subscription metadata endpoint,
 * NOT a search, so the probe costs no search credit. The doctor command
 * can therefore verify a credential authenticates without consuming a
 * paid request. SearchApi has no `search_depth`-style knob, so no probe
 * params are sent.
 *
 * The probe performs exactly ONE attempt. Shared execution owns the
 * retry policy; this transport never retries. The doctor command
 * catches the throw on failure and records a redacted error entry.
 *
 * When `options.probe` is false, `invoke` resolves immediately without
 * touching the network — the doctor command skips probing unconfigured
 * Providers (passing `probe: false`) before reaching this Capability.
 *
 * Boundary rules (ARCHITECTURE.md §2):
 *   - May import the diagnostics capability contract, Adapter-local
 *     credentials, Adapter-local quota transport, and normalized errors.
 *   - Must NOT import command presentation or another Provider's Adapter.
 */

import type { DiagnosticsCapability, DiagnosticOptions } from "../../capabilities/diagnostics.js";
import { createProbeErrorNormalizer, STANDARD_PROBE_PASS_THROUGH } from "../../lib/probe-errors.js";
import { requireSearchApiKey } from "./credentials.js";
import { fetchSearchApiMe, type SearchApiTransportDeps } from "./client.js";

// ---------------------------------------------------------------------------
// Failure normalization (mirror the Adapter's search-path mapping)
// ---------------------------------------------------------------------------

/**
 * Probe failure wrapper. Mirrors the Adapter's `normalizeSearchApiError`
 * for the subset of errors the probe can surface. The probe throws on
 * failure; the doctor command catches the throw and records a redacted
 * error entry. The SearchApi transport already drains/discards response
 * bodies, and these typed errors carry only curated messages, so no raw
 * SearchApi body ever crosses this boundary.
 */
const normalizeProbeError = createProbeErrorNormalizer({
  passThrough: STANDARD_PROBE_PASS_THROUGH,
  fallbackMessage: "SearchApi.io diagnostics probe failed",
});

// ---------------------------------------------------------------------------
// Capability factory
// ---------------------------------------------------------------------------

/**
 * Options for the SearchApi.io DiagnosticsCapability. The API key is
 * resolved from `env`; transport dependencies (`fetch`, timers) are
 * injectable for deterministic tests through the unified `transport`
 * seam.
 */
export interface SearchApiDiagnosticsCapabilityOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly transport?: SearchApiTransportDeps;
}

/**
 * Build the SearchApi.io DiagnosticsCapability. The probe performs ONE
 * non-destructive `/api/v1/me` request — the cheapest credible probe
 * (it authenticates the Bearer header without spending a search
 * credit). Shared execution owns the retry policy; this transport
 * performs exactly one attempt per invocation.
 *
 * When `options.probe` is false, `invoke` resolves immediately without
 * touching the network — the doctor command skips probing unconfigured
 * Providers before reaching this Capability.
 */
export function createSearchApiDiagnosticsCapability(
  options: SearchApiDiagnosticsCapabilityOptions,
): DiagnosticsCapability {
  const { env, transport } = options;
  return {
    async invoke(diagOptions: DiagnosticOptions): Promise<void> {
      if (!diagOptions.probe) return;
      const apiKey = requireSearchApiKey(env);
      try {
        // One non-destructive /me GET, no params — costs no search credit.
        await fetchSearchApiMe(apiKey, transport);
      } catch (error) {
        throw normalizeProbeError(error);
      }
    },
  };
}
