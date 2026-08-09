/**
 * Jina AI credential resolution.
 *
 * Single source of truth for the Jina AI API key (`JINA_API_KEY`).
 *
 * Capability-aware configuration (8J.1):
 * - Reader (`r.jina.ai`) is keyless — available without `JINA_API_KEY`.
 * - Search (`s.jina.ai`), DeepSearch (`deepsearch.jina.ai`), Quota, and
 *   the Search-based diagnostics probe all require `JINA_API_KEY`. Live
 *   probes confirmed they return HTTP 401 without a key.
 *
 * `isJinaConfigured` is capability-aware: when called with a specific
 * `capabilityId`, it checks the key requirement for that capability.
 * Without a `capabilityId`, it returns `true` whenever the Provider can
 * serve at least one capability keylessly (Reader), so the Doctor listing
 * and global availability checks still surface Jina.
 */

import type { ProviderCapability } from "../types.js";

function pickNonBlank(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  return raw.trim().length > 0 ? raw : undefined;
}

export function resolveJinaApiKey(env: NodeJS.ProcessEnv): string | undefined {
  return pickNonBlank(env.JINA_API_KEY);
}

/**
 * Capabilities that require `JINA_API_KEY`. Reader is excluded because
 * `r.jina.ai` supports keyless access. Quota uses the Search endpoint for
 * its probe (8J.5), so it requires a key.
 */
const KEYED_CAPABILITIES: ReadonlySet<ProviderCapability> = new Set([
  "search",
  "research",
  "quota",
  "diagnostics",
]);

export function isJinaConfigured(
  env: NodeJS.ProcessEnv,
  capabilityId?: ProviderCapability,
): boolean {
  // No capability context — Jina is "configured" as long as it can serve
  // at least one capability. Reader is keyless, so always available.
  if (capabilityId === undefined) {
    return true;
  }
  // Reader (r.jina.ai) is keyless — always available.
  if (capabilityId === "reader") {
    return true;
  }
  // Search, Research, and Diagnostics require JINA_API_KEY.
  if (KEYED_CAPABILITIES.has(capabilityId)) {
    return resolveJinaApiKey(env) !== undefined;
  }
  // Unknown capability for Jina — not configured.
  return false;
}
