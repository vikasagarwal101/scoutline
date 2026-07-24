/**
 * Brave credential resolution (brave-tech-plan §2, §6).
 *
 * Single source of truth for the Brave Search API key. Whitespace-only
 * values are treated as absent, matching the descriptor's `isConfigured`
 * contract.
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

const MISSING_KEY_HELP = 'export BRAVE_SEARCH_API_KEY="your-api-key"';

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
 * Resolve the Brave API key without throwing. Returns `undefined` when
 * no non-blank value is present.
 */
export function resolveBraveApiKey(env: NodeJS.ProcessEnv): string | undefined {
  return pickNonBlank(env.BRAVE_SEARCH_API_KEY);
}

/**
 * Resolve the Brave API key or throw {@link ConfigurationError} (exit 3)
 * when it is missing. Call this at every Capability invocation gate.
 */
export function requireBraveApiKey(env: NodeJS.ProcessEnv): string {
  const key = resolveBraveApiKey(env);
  if (key === undefined) {
    throw new ConfigurationError(
      "BRAVE_SEARCH_API_KEY environment variable is required",
      MISSING_KEY_HELP,
    );
  }
  return key;
}

/**
 * True when a non-blank Brave API key is configured. Metadata-only:
 * performs no transport construction and reads no other Provider's
 * credentials.
 */
export function isBraveConfigured(env: NodeJS.ProcessEnv): boolean {
  return resolveBraveApiKey(env) !== undefined;
}
