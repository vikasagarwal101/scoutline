/**
 * Tavily Diagnostics Capability (DESIGN.md §14, tech-plan §10, T08).
 *
 * Probes Tavily connectivity with a single, cheapest-possible request
 * — `/search` with `search_depth: "basic"` and a stub query — so the
 * doctor command can verify a credential authenticates without
 * burning plan credits.
 *
 * The probe intentionally avoids `/usage`. Tavily throttles `/usage`
 * to 10 requests per 10 minutes per key (tech-plan §10), which would
 * make a routine doctor run rate-limit itself. `/search` with basic
 * depth costs a single credit and is bounded by the search rate limit,
 * which is far more generous than the usage endpoint.
 *
 * Boundary rules (ARCHITECTURE.md §2):
 *   - May import the diagnostics capability contract, Adapter-local
 *     config, Adapter-local search transport, and normalized errors.
 *   - Must NOT import command presentation or another Provider's
 *     Adapter.
 */

import type {
  DiagnosticsCapability,
  DiagnosticOptions,
} from "../../capabilities/diagnostics.js";
import {
  AuthError,
  ApiError,
  NetworkError,
  TimeoutError,
  ConfigurationError,
} from "../../lib/errors.js";
import { createProbeErrorNormalizer } from "../../lib/probe-errors.js";
import { requireTavilyApiKey } from "./credentials.js";
import {
  fetchTavilySearch,
  type TavilyTransportDeps,
} from "./client.js";

// ---------------------------------------------------------------------------
// Failure normalization (mirror the Adapter's search-path mapping)
// ---------------------------------------------------------------------------

/**
 * Probe failure wrapper. Mirrors the Adapter's `normalizeTavilyError`
 * for the subset of errors the probe can surface. The probe throws on
 * failure; the doctor command catches the throw and records a redacted
 * error entry. We never embed raw Provider bodies.
 */
// Tavily deliberately omits QuotaError from its pass-through list
// (mirroring the Adapter search-path mapping): a thrown QuotaError
// surfaces as the fallback ApiError instead.
const normalizeProbeError = createProbeErrorNormalizer({
  passThrough: [AuthError, ApiError, NetworkError, TimeoutError, ConfigurationError],
  fallbackMessage: "Tavily diagnostics probe failed",
});

// ---------------------------------------------------------------------------
// Capability factory
// ---------------------------------------------------------------------------

/**
 * Options for the Tavily DiagnosticsCapability. The API key is
 * resolved from `env`; transport dependencies (`fetch`, timer) are
 * injectable for deterministic tests through the unified `transport`
 * seam.
 */
export interface TavilyDiagnosticsCapabilityOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly transport?: TavilyTransportDeps;
}

/**
 * Build the Tavily DiagnosticsCapability. The probe performs ONE
 * `/search` request with `search_depth: "basic"` and a stub query so
 * it costs a single credit. Shared execution owns the retry policy;
 * this transport performs exactly one attempt per invocation.
 *
 * When `options.probe` is false, `invoke` resolves immediately without
 * touching the network — the doctor command skips probing unconfigured
 * or tools-disabled Providers before reaching this Capability.
 */
export function createTavilyDiagnosticsCapability(
  options: TavilyDiagnosticsCapabilityOptions,
): DiagnosticsCapability {
  const { env, transport } = options;
  return {
    async invoke(diagOptions: DiagnosticOptions): Promise<void> {
      if (!diagOptions.probe) return;
      const apiKey = requireTavilyApiKey(env);
      try {
        // `search_depth: "basic"` -> 1 credit; cheapest credible probe.
        await fetchTavilySearch(apiKey, "scoutline-doctor-probe", { search_depth: "basic" }, transport);
      } catch (error) {
        throw normalizeProbeError(error);
      }
    },
  };
}
