/**
 * OpenAlex Diagnostics Capability.
 *
 * Keyless bounded probe (DESIGN D2 round-3 ruling): doctor probes
 * every always-configured science supplier, so the OpenAlex probe is
 * ONE minimal keyless wire call — still one call, still `per-page=1`,
 * but it rides the SEARCH surface (`search=test`). #145: anonymous
 * OpenAlex search can be 503-paused while the bare works list stays
 * green, so a works-list-only probe reports capability health it never
 * tested. Red during an anonymous pause is INTENDED — the row reports
 * the search capability, not bare connectivity. The politeness posture
 * applies to it too:
 * house UA plus the `mailto=` param whenever no api_key is present.
 * When `diagOptions.probe` is false, `invoke` resolves immediately
 * without touching the network.
 */
import type { DiagnosticsCapability, DiagnosticOptions } from "../../capabilities/diagnostics.js";
import { createProbeErrorNormalizer, STANDARD_PROBE_PASS_THROUGH } from "../../lib/probe-errors.js";
import { fetchOpenalexJson, type OpenalexTransportDeps } from "./client.js";

const normalizeProbeError = createProbeErrorNormalizer({
  passThrough: STANDARD_PROBE_PASS_THROUGH,
  fallbackMessage: "OpenAlex diagnostics probe failed",
});

export interface OpenalexDiagnosticsCapabilityOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly transport?: OpenalexTransportDeps;
}

export function createOpenalexDiagnosticsCapability(
  options: OpenalexDiagnosticsCapabilityOptions,
): DiagnosticsCapability {
  const { env, transport } = options;
  return {
    async invoke(diagOptions: DiagnosticOptions): Promise<void> {
      if (!diagOptions.probe) return;
      try {
        // One minimal keyless wire call, on the SEARCH surface (#145):
        // a bare works list can stay green while anonymous search is
        // 503-paused, so the probe must issue a search. The request
        // parameter is `per-page` (review) — `per_page` is only
        // response metadata the server ignores.
        await fetchOpenalexJson({ search: "test", "per-page": "1" }, { ...transport, env });
      } catch (error) {
        throw normalizeProbeError(error);
      }
    },
  };
}
