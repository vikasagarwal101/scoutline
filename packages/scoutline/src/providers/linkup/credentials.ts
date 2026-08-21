/**
 * Linkup credential resolution.
 *
 * Single source of truth for the Linkup API key (`LINKUP_API_KEY`).
 * Whitespace-only values are treated as absent, matching the
 * descriptor's `isConfigured` contract. Resolved keys are returned
 * trimmed so wire headers never carry stray whitespace.
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

const MISSING_KEY_HELP = 'export LINKUP_API_KEY="your-api-key"';

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
 * Resolve the Linkup API key without throwing. Returns the trimmed key
 * or `undefined` when no non-blank value is present.
 */
export function getLinkupApiKey(env: NodeJS.ProcessEnv): string | undefined {
  return pickNonBlank(env.LINKUP_API_KEY);
}

/**
 * Resolve the Linkup API key or throw {@link ConfigurationError}
 * (exit 3) when it is missing. Call this at every capability
 * invocation gate.
 */
export function requireLinkupApiKey(env: NodeJS.ProcessEnv): string {
  const key = getLinkupApiKey(env);
  if (key === undefined) {
    throw new ConfigurationError(
      "LINKUP_API_KEY environment variable is required",
      MISSING_KEY_HELP,
    );
  }
  return key;
}

/**
 * True when a non-blank Linkup API key is configured. Metadata-only:
 * performs no transport construction and reads no other Provider's
 * credentials.
 */
export function isLinkupConfigured(env: NodeJS.ProcessEnv): boolean {
  return getLinkupApiKey(env) !== undefined;
}

/**
 * Lowercase hex SHA-256 fingerprint of the Linkup API key. Used for
 * partitioned cache identity; the raw key must never appear in cache
 * filenames, errors, or logs.
 */
export function hashLinkupApiKey(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex");
}
