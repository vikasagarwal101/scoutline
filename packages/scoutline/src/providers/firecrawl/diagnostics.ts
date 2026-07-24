/**
 * Firecrawl Diagnostics Capability (firecrawl tech-plan §3, D8).
 *
 * Probes Firecrawl connectivity with a single, cheapest-possible request
 * — one basic /v2/scrape of a small stub URL — so the doctor command can
 * verify a credential authenticates without burning many credits.
 *
 * The probe intentionally avoids /team/credit-usage (rate-limit safety,
 * mirroring the Tavily doctor which probes with /search rather than the
 * throttled /usage endpoint). A basic scrape costs one credit and is
 * bounded by the scrape rate limit.
 *
 * Boundary rules (ARCHITECTURE.md §2):
 *   - May import the diagnostics contract, Adapter-local config,
 *     Adapter-local scrape transport, and normalized errors.
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
import { requireFirecrawlApiKey } from "./credentials.js";
import { fetchFirecrawlScrape, type FirecrawlTransportDeps } from "./client.js";

/**
 * Probe failure wrapper. Mirrors the Adapter's `normalizeFirecrawlError`
 * for the subset of errors the probe can surface. The probe throws on
 * failure; the doctor command catches the throw and records a redacted
 * error entry. We never embed raw Provider bodies.
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
  return new ApiError("Firecrawl diagnostics probe failed", 500);
}

export interface FirecrawlDiagnosticsCapabilityOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly transport?: FirecrawlTransportDeps;
}

/**
 * Build the Firecrawl DiagnosticsCapability. The probe performs ONE
 * /v2/scrape of a small stub URL (`formats:["markdown"]`, `proxy:"basic"`)
 * so it costs a single credit — the cheapest credible authentication
 * probe. Shared execution owns the retry policy; this transport performs
 * exactly one attempt per invocation.
 *
 * When `diagOptions.probe` is false, `invoke` resolves immediately without
 * touching the network — the doctor command skips probing unconfigured or
 * tools-disabled Providers before reaching this Capability.
 */
export function createFirecrawlDiagnosticsCapability(
  options: FirecrawlDiagnosticsCapabilityOptions,
): DiagnosticsCapability {
  const { env, transport } = options;
  return {
    async invoke(diagOptions: DiagnosticOptions): Promise<void> {
      if (!diagOptions.probe) return;
      const apiKey = requireFirecrawlApiKey(env);
      try {
        // One basic scrape — cheapest credible probe (1 credit).
        await fetchFirecrawlScrape(
          apiKey,
          "https://example.com",
          { formats: ["markdown"], proxy: "basic" },
          transport,
        );
      } catch (error) {
        throw normalizeProbeError(error);
      }
    },
  };
}
