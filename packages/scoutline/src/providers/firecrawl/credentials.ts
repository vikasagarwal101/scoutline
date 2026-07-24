/**
 * Firecrawl credential resolution (DESIGN.md §6, firecrawl tech-plan §3).
 *
 * Single source of truth for the Firecrawl API key. Whitespace-only values
 * are treated as absent, matching the descriptor's `isConfigured` contract.
 *
 * Firecrawl keys are `fc-`-prefixed and sent as `Authorization: Bearer fc-…`
 * on every request (transport arrives in FC-03). This module resolves the
 * raw env value only; it performs no transport and reads no other Provider's
 * credentials.
 *
 * Boundary rules (ARCHITECTURE.md §2):
 *   - May import the normalized-error contract only.
 *   - Must NOT import transport, command presentation, or another
 *     Provider's Adapter.
 *
 * Missing credentials are surfaced as {@link ConfigurationError}
 * (exit 3), distinct from {@link AuthError} (exit 1) which means the
 * Provider REJECTED a presented credential.
 */

import { ConfigurationError } from "../../lib/errors.js";

const MISSING_KEY_HELP = 'export FIRECRAWL_API_KEY="your-api-key"';

/**
 * Pick a non-blank raw value from the environment. Returns the original
 * (untrimmed) string when it contains at least one non-whitespace
 * character, otherwise `undefined`.
 */
function pickNonBlank(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  return raw.trim().length > 0 ? raw : undefined;
}

/**
 * Resolve the Firecrawl API key without throwing. Returns `undefined`
 * when no non-blank value is present.
 */
export function resolveFirecrawlApiKey(env: NodeJS.ProcessEnv): string | undefined {
  return pickNonBlank(env.FIRECRAWL_API_KEY);
}

/**
 * Resolve the Firecrawl API key or throw {@link ConfigurationError}
 * (exit 3) when it is missing. Call this at every capability
 * invocation gate.
 */
export function requireFirecrawlApiKey(env: NodeJS.ProcessEnv): string {
  const key = resolveFirecrawlApiKey(env);
  if (key === undefined) {
    throw new ConfigurationError(
      "FIRECRAWL_API_KEY environment variable is required",
      MISSING_KEY_HELP,
    );
  }
  return key;
}

/**
 * True when a non-blank Firecrawl API key is configured. Metadata-only:
 * performs no transport construction and reads no other Provider's
 * credentials.
 */
export function isFirecrawlConfigured(env: NodeJS.ProcessEnv): boolean {
  return resolveFirecrawlApiKey(env) !== undefined;
}
