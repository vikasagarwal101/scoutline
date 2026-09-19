/**
 * SearchApi credential resolution.
 *
 * Single source of truth for the SearchApi.io API key
 * (`SEARCHAPI_API_KEY`, with the legacy `SERPAPI_API_KEY` accepted as a
 * lower-precedence fallback). Whitespace-only values are treated as
 * absent, matching the descriptor's `isConfigured` contract. Resolved
 * keys are returned trimmed so wire headers never carry stray
 * whitespace.
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

import crypto from "node:crypto";

import { ConfigurationError } from "../../lib/errors.js";

/** Credential environment names read by this module (#232 derivation pin). */
export const ENV_NAMES = ["SEARCHAPI_API_KEY", "SERPAPI_API_KEY"] as const;

const MISSING_KEY_HELP = 'export SEARCHAPI_API_KEY="your-api-key"';

/**
 * Pick a non-blank raw value from the environment and trim it. Returns
 * `undefined` when the value is absent, non-string, or all whitespace.
 */
function pickNonBlank(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Resolve the SearchApi API key without throwing. Returns the trimmed
 * key or `undefined` when no non-blank value is present.
 * `SEARCHAPI_API_KEY` wins over the legacy `SERPAPI_API_KEY`.
 */
export function getSearchApiKey(env: NodeJS.ProcessEnv): string | undefined {
  return pickNonBlank(env.SEARCHAPI_API_KEY) ?? pickNonBlank(env.SERPAPI_API_KEY);
}

/**
 * Resolve the SearchApi API key or throw {@link ConfigurationError}
 * (exit 3) when it is missing. Call this at every capability
 * invocation gate.
 */
export function requireSearchApiKey(env: NodeJS.ProcessEnv): string {
  const key = getSearchApiKey(env);
  if (key === undefined) {
    throw new ConfigurationError(
      "SEARCHAPI_API_KEY environment variable is required",
      MISSING_KEY_HELP,
    );
  }
  return key;
}

/**
 * True when a non-blank SearchApi API key is configured. Metadata-only:
 * performs no transport construction and reads no other Provider's
 * credentials.
 */
export function isSearchApiConfigured(env: NodeJS.ProcessEnv): boolean {
  return getSearchApiKey(env) !== undefined;
}

/**
 * Lowercase hex SHA-256 fingerprint of the SearchApi API key. Used for
 * partitioned cache identity; the raw key must never appear in cache
 * filenames, errors, or logs.
 */
export function hashSearchApiKey(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex");
}
