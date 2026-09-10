/**
 * PubMed Diagnostics Capability.
 *
 * Keyless bounded probe (DESIGN D2 round-3 ruling): doctor probes
 * every always-configured science supplier, so the PubMed probe is ONE
 * minimal keyless wire call — an esearch with `retmax=1` (the cheapest
 * bounded eutils call; arXiv `max_results=1` precedent). Never a full
 * search and never an efetch. When `diagOptions.probe` is false,
 * `invoke` resolves immediately without touching the network.
 */
import type { DiagnosticsCapability, DiagnosticOptions } from "../../capabilities/diagnostics.js";
import { createProbeErrorNormalizer, STANDARD_PROBE_PASS_THROUGH } from "../../lib/probe-errors.js";
import { fetchPubmedEsearch, type PubmedTransportDeps } from "./client.js";

const normalizeProbeError = createProbeErrorNormalizer({
  passThrough: STANDARD_PROBE_PASS_THROUGH,
  fallbackMessage: "PubMed diagnostics probe failed",
});

export interface PubmedDiagnosticsCapabilityOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly transport?: PubmedTransportDeps;
}

export function createPubmedDiagnosticsCapability(
  options: PubmedDiagnosticsCapabilityOptions,
): DiagnosticsCapability {
  const { env, transport } = options;
  return {
    async invoke(diagOptions: DiagnosticOptions): Promise<void> {
      if (!diagOptions.probe) return;
      try {
        // One minimal keyless wire call: a bounded esearch (retmax=1).
        await fetchPubmedEsearch(
          { db: "pubmed", term: "pubmed", retmode: "json", retmax: "1" },
          { ...transport, env },
        );
      } catch (error) {
        throw normalizeProbeError(error);
      }
    },
  };
}
