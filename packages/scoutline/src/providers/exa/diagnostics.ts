/**
 * Exa Diagnostics Capability (tech-plan §7, Diagnostics Probe).
 *
 * Probes Exa connectivity with a single, cheapest-possible request —
 * `POST /search` with `type: "auto"` and a stub query — so the doctor
 * command can verify a credential authenticates without burning deep
 * credits. Mirrors `providers/tavily/diagnostics.ts`.
 *
 * The probe intentionally avoids the (deferred) usage endpoint entirely.
 * `/search` with `type: "auto"` is the cheapest credible connectivity
 * check; doctor catches the throw and records a redacted error entry.
 *
 * Boundary rules (ARCHITECTURE.md §2):
 *   - May import the diagnostics capability contract, Adapter-local
 *     config, Adapter-local search transport, and normalized errors.
 *   - Must NOT import command presentation or another Provider's
 *     Adapter.
 */

import type { DiagnosticsCapability, DiagnosticOptions } from "../../capabilities/diagnostics.js";
import {
  ApiError,
  AuthError,
  ConfigurationError,
  NetworkError,
  QuotaError,
  TimeoutError,
} from "../../lib/errors.js";
import { requireExaApiKey } from "./credentials.js";
import { fetchExaSearch, type ExaTransportDeps } from "./client.js";

// ---------------------------------------------------------------------------
// Failure normalization (mirror the Adapter's search-path mapping)
// ---------------------------------------------------------------------------

/**
 * Probe failure wrapper. Mirrors the Adapter's `normalizeExaError`
 * for the subset of errors the probe can surface. The probe throws on
 * failure; the doctor command catches the throw and records a redacted
 * error entry. We never embed raw Provider bodies.
 */
function normalizeProbeError(error: unknown): Error {
  if (
    error instanceof AuthError ||
    error instanceof QuotaError ||
    error instanceof ApiError ||
    error instanceof NetworkError ||
    error instanceof TimeoutError ||
    error instanceof ConfigurationError
  ) {
    return error;
  }
  return new ApiError("Exa diagnostics probe failed", 500);
}

// ---------------------------------------------------------------------------
// Capability factory
// ---------------------------------------------------------------------------

/**
 * Options for the Exa DiagnosticsCapability. The API key is
 * resolved from `env`; transport dependencies (`fetch`, timer) are
 * injectable for deterministic tests through the unified `transport`
 * seam.
 */
export interface ExaDiagnosticsCapabilityOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly transport?: ExaTransportDeps;
}

/**
 * Build the Exa DiagnosticsCapability. The probe performs ONE
 * `/search` request with `type: "auto"` and a stub query so it costs
 * the cheapest credible request. Shared execution owns the retry policy;
 * this transport performs exactly one attempt per invocation.
 *
 * When `options.probe` is false, `invoke` resolves immediately without
 * touching the network — the doctor command skips probing unconfigured
 * or tools-disabled Providers before reaching this Capability.
 */
export function createExaDiagnosticsCapability(
  options: ExaDiagnosticsCapabilityOptions,
): DiagnosticsCapability {
  const { env, transport } = options;
  return {
    async invoke(diagOptions: DiagnosticOptions): Promise<void> {
      if (!diagOptions.probe) return;
      const apiKey = requireExaApiKey(env);
      try {
        // `type: "auto"` -> cheapest credible probe.
        await fetchExaSearch(apiKey, "scoutline-doctor-probe", { type: "auto" }, transport);
      } catch (error) {
        throw normalizeProbeError(error);
      }
    },
  };
}
