/**
 * Parallel AI Diagnostics Capability.
 *
 * Probes Parallel AI connectivity with a lightweight probe request.
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
import { requireParallelApiKey } from "./credentials.js";
import { fetchParallelSearch, type ParallelTransportDeps } from "./client.js";

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
  return new ApiError("Parallel AI diagnostics probe failed", 500);
}

export interface ParallelDiagnosticsCapabilityOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly transport?: ParallelTransportDeps;
}

export function createParallelDiagnosticsCapability(
  options: ParallelDiagnosticsCapabilityOptions,
): DiagnosticsCapability {
  const { env, transport } = options;
  return {
    async invoke(diagOptions: DiagnosticOptions): Promise<void> {
      if (!diagOptions.probe) return;
      const apiKey = requireParallelApiKey(env);
      try {
        await fetchParallelSearch(apiKey, "scoutline-doctor-probe", {}, transport);
      } catch (error) {
        throw normalizeProbeError(error);
      }
    },
  };
}
