/**
 * Kagi credential resolution.
 *
 * Single source of truth for the Kagi API key (`KAGI_API_KEY`, legacy
 * alias `KAGI_TOKEN`).
 */

import { createHash } from "node:crypto";

import { ConfigurationError } from "../../lib/errors.js";

export const MISSING_KEY_HELP = 'export KAGI_API_KEY="your-kagi-api-key"';

function pickTrimmedNonBlank(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function getKagiApiKey(env: NodeJS.ProcessEnv): string | undefined {
  return (
    pickTrimmedNonBlank(env.KAGI_API_KEY) ?? pickTrimmedNonBlank(env.KAGI_TOKEN)
  );
}

export function requireKagiApiKey(env: NodeJS.ProcessEnv): string {
  const key = getKagiApiKey(env);
  if (key === undefined) {
    throw new ConfigurationError(
      "KAGI_API_KEY or KAGI_TOKEN environment variable is required",
      MISSING_KEY_HELP,
    );
  }
  return key;
}

export function isKagiConfigured(env: NodeJS.ProcessEnv): boolean {
  return getKagiApiKey(env) !== undefined;
}

/** SHA-256 fingerprint of the key — safe to log; never log the raw key. */
export function hashKagiApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}
