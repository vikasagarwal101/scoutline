/**
 * Jina AI Diagnostics Capability.
 *
 * Probes Jina AI connectivity with a lightweight probe request.
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
import { resolveJinaApiKey } from "./credentials.js";
import { fetchJinaSearch, type JinaTransportDeps } from "./client.js";

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
  return new ApiError("Jina AI diagnostics probe failed", 500);
}

export interface JinaDiagnosticsCapabilityOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly transport?: JinaTransportDeps;
}

export function createJinaDiagnosticsCapability(
  options: JinaDiagnosticsCapabilityOptions,
): DiagnosticsCapability {
  const { env, transport } = options;
  return {
    async invoke(diagOptions: DiagnosticOptions): Promise<void> {
      if (!diagOptions.probe) return;
      const apiKey = resolveJinaApiKey(env);
      try {
        await fetchJinaSearch(apiKey, "scoutline-doctor-probe", transport);
      } catch (error) {
        throw normalizeProbeError(error);
      }
    },
  };
}
