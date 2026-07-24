/**
 * Brave Diagnostics Capability (brave-tech-plan §3, §7; T5).
 *
 * Probes Brave connectivity with a single, cheapest-possible request
 * — one `/res/v1/web/search` GET with a stub query — so the doctor
 * command can verify a credential authenticates without a generative
 * request. Brave has no `search_depth`-style knob (unlike Tavily), so
 * the probe sends a bare `q` and no other params.
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
 *     credentials, Adapter-local search transport, and normalized errors.
 *   - Must NOT import command presentation or another Provider's Adapter.
 */

import type { DiagnosticsCapability, DiagnosticOptions } from "../../capabilities/diagnostics.js";
import {
  ApiError,
  AuthError,
  ConfigurationError,
  NetworkError,
  TimeoutError,
} from "../../lib/errors.js";
import { requireBraveApiKey } from "./credentials.js";
import { fetchBraveSearch, type BraveTransportDeps } from "./client.js";

// ---------------------------------------------------------------------------
// Failure normalization (mirror the Adapter's search-path mapping)
// ---------------------------------------------------------------------------

/**
 * Probe failure wrapper. Mirrors the Adapter's `normalizeBraveError`
 * for the subset of errors the probe can surface. The probe throws on
 * failure; the doctor command catches the throw and records a redacted
 * error entry. The Brave transport already drains/discards response
 * bodies, and these typed errors carry only curated messages, so no
 * raw Brave body ever crosses this boundary.
 */
function normalizeProbeError(error: unknown): Error {
  if (
    error instanceof AuthError ||
    error instanceof ApiError ||
    error instanceof NetworkError ||
    error instanceof TimeoutError ||
    error instanceof ConfigurationError
  ) {
    return error;
  }
  return new ApiError("Brave diagnostics probe failed", 500);
}

// ---------------------------------------------------------------------------
// Capability factory
// ---------------------------------------------------------------------------

/**
 * Options for the Brave DiagnosticsCapability. The API key is resolved
 * from `env`; transport dependencies (`fetch`, timer) are injectable
 * for deterministic tests through the unified `transport` seam.
 */
export interface BraveDiagnosticsCapabilityOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly transport?: BraveTransportDeps;
}

/**
 * Build the Brave DiagnosticsCapability. The probe performs ONE
 * `/res/v1/web/search` request with a stub query (`scoutline-doctor-
 * probe`) and no params — the cheapest credible probe. Shared
 * execution owns the retry policy; this transport performs exactly one
 * attempt per invocation.
 *
 * When `options.probe` is false, `invoke` resolves immediately without
 * touching the network — the doctor command skips probing unconfigured
 * Providers before reaching this Capability.
 */
export function createBraveDiagnosticsCapability(
  options: BraveDiagnosticsCapabilityOptions,
): DiagnosticsCapability {
  const { env, transport } = options;
  return {
    async invoke(diagOptions: DiagnosticOptions): Promise<void> {
      if (!diagOptions.probe) return;
      const apiKey = requireBraveApiKey(env);
      try {
        // One web-search GET, bare `q`, no params — cheapest credible
        // probe (Brave has no search_depth knob).
        await fetchBraveSearch(apiKey, "scoutline-doctor-probe", undefined, transport);
      } catch (error) {
        throw normalizeProbeError(error);
      }
    },
  };
}
