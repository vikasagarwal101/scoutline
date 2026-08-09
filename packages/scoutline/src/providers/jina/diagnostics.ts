/**
 * Jina AI Diagnostics Capability.
 *
 * Probes Jina AI connectivity with a lightweight probe request.
 *
 * The probe calls the Search endpoint (s.jina.ai), which requires
 * `JINA_API_KEY` (8J.1). Without a key the probe is skipped with a
 * `ConfigurationError` so the Doctor reports the correct reason instead
 * of a misleading 401 from the network.
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
      // The diagnostics probe uses s.jina.ai (Search), which requires
      // JINA_API_KEY (8J.1). Without a key, fail-closed with a clear
      // ConfigurationError instead of a guaranteed 401.
      const apiKey = resolveJinaApiKey(env);
      if (!apiKey) {
        throw new ConfigurationError(
          "Jina AI diagnostics requires JINA_API_KEY (the probe uses the Search endpoint, which is not keyless).",
          "Set JINA_API_KEY to enable Jina diagnostics.",
        );
      }
      try {
        await fetchJinaSearch(apiKey, "scoutline-doctor-probe", transport);
      } catch (error) {
        throw normalizeProbeError(error);
      }
    },
  };
}
