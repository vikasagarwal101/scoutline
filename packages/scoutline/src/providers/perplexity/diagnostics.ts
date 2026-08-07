/**
 * Perplexity Diagnostics Capability.
 *
 * Probes Perplexity connectivity with a lightweight search request.
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
import { requirePerplexityApiKey } from "./credentials.js";
import { fetchPerplexitySearch, type PerplexityTransportDeps } from "./client.js";

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
  return new ApiError("Perplexity diagnostics probe failed", 500);
}

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
