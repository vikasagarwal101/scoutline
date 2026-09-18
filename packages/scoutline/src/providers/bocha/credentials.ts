/**
 * Bocha AI API credential resolution.
 *
 * Single source of truth for the Bocha AI API key (`BOCHA_API_KEY`).
 */

import { ConfigurationError } from "../../lib/errors.js";

export const MISSING_KEY_HELP = 'export BOCHA_API_KEY="your-bocha-api-key"';

function pickTrimmedNonBlank(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function getBochaApiKey(env: NodeJS.ProcessEnv): string | undefined {
  return pickTrimmedNonBlank(env.BOCHA_API_KEY);
}

export function requireBochaApiKey(env: NodeJS.ProcessEnv): string {
  const key = getBochaApiKey(env);
  if (key === undefined) {
    throw new ConfigurationError(
      "BOCHA_API_KEY environment variable is required",
      MISSING_KEY_HELP,
    );
  }
  return key;
}

export function isBochaConfigured(env: NodeJS.ProcessEnv): boolean {
  return getBochaApiKey(env) !== undefined;
}
