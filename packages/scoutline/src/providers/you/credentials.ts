/**
 * You.com credential resolution.
 *
 * Single source of truth for the You.com API key. `YDC_API_KEY` (the
 * You.com Data Center index credential) is preferred; `YOU_API_KEY` is
 * the documented fallback. Whitespace-only values are treated as
 * absent, matching the descriptor's `isConfigured` contract.
 *
 * Boundary rules (same as the Exa credentials module):
 *   - May import the normalized-error contract only.
 *   - Must NOT import transport, command presentation, or another
 *     Provider's Adapter.
 *
 * Missing credentials are surfaced as {@link ConfigurationError}
 * (exit 3).
 */

import crypto from "node:crypto";

import { ConfigurationError } from "../../lib/errors.js";

/** Credential environment names, in resolution-preference order. */
const YOU_API_KEY_ENV_NAMES = ["YDC_API_KEY", "YOU_API_KEY"] as const;

/**
 * Resolve the You.com API key without throwing. Returns the trimmed key
 * from the first name holding a non-blank value, `undefined` when none
 * is present.
 */
export function getYouApiKey(env: NodeJS.ProcessEnv): string | undefined {
  for (const name of YOU_API_KEY_ENV_NAMES) {
    const raw = env[name];
    if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
  }
  return undefined;
}

/**
 * True when a non-blank You.com API key is configured. Metadata-only:
 * performs no transport construction and reads no other Provider's
 * credentials.
 */
export function isYouConfigured(env: NodeJS.ProcessEnv): boolean {
  return getYouApiKey(env) !== undefined;
}

/**
 * Resolve the You.com API key or throw {@link ConfigurationError}
 * (exit 3) when it is missing. Call this at every capability
 * invocation gate.
 */
export function requireYouApiKey(env: NodeJS.ProcessEnv): string {
  const key = getYouApiKey(env);
  if (!key) {
    throw new ConfigurationError(
      "You.com is not configured.",
      "Set YDC_API_KEY or YOU_API_KEY.",
    );
  }
  return key;
}

/**
 * Provider-owned credential fingerprint: lowercase SHA-256 hex of the
 * raw key. Never expose the raw key in cache filenames or logs.
 */
export function hashYouApiKey(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex");
}
