/**
 * Spider.cloud credential resolution.
 *
 * Single source of truth for the Spider.cloud API key
 * (`SPIDER_API_KEY`, Bearer-authenticated against
 * `https://api.spider.cloud`). Whitespace-only values are treated as
 * absent, matching the descriptor's `isConfigured` contract. Unlike the
 * Firecrawl variant, this resolver returns the *trimmed* value so the
 * Bearer header never carries surrounding whitespace.
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

const MISSING_KEY_HELP = 'export SPIDER_API_KEY="your-api-key"';

/**
 * Pick a non-blank value from the environment. Returns the trimmed
 * string when the raw value contains at least one non-whitespace
 * character, otherwise `undefined`.
 */
function pickNonBlank(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Resolve the Spider.cloud API key without throwing. Returns the
 * trimmed key, or `undefined` when no non-blank value is present.
 */
export function getSpiderApiKey(env: NodeJS.ProcessEnv): string | undefined {
  return pickNonBlank(env.SPIDER_API_KEY);
}

/**
 * Resolve the Spider.cloud API key or throw {@link ConfigurationError}
 * (exit 3) when it is missing. Call this at every capability
 * invocation gate.
 */
export function requireSpiderApiKey(env: NodeJS.ProcessEnv): string {
  const key = getSpiderApiKey(env);
  if (key === undefined) {
    throw new ConfigurationError(
      "SPIDER_API_KEY environment variable is required",
      MISSING_KEY_HELP,
    );
  }
  return key;
}
