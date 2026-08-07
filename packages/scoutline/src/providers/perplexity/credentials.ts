/**
 * Perplexity API credential resolution.
 *
 * Single source of truth for the Perplexity API key (`PERPLEXITY_API_KEY`).
 */

import { ConfigurationError } from "../../lib/errors.js";

const MISSING_KEY_HELP = 'export PERPLEXITY_API_KEY="your-perplexity-api-key"';

function pickNonBlank(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  return raw.trim().length > 0 ? raw : undefined;
}

export function resolvePerplexityApiKey(env: NodeJS.ProcessEnv): string | undefined {
  return pickNonBlank(env.PERPLEXITY_API_KEY);
}

export function requirePerplexityApiKey(env: NodeJS.ProcessEnv): string {
  const key = resolvePerplexityApiKey(env);
  if (key === undefined) {
    throw new ConfigurationError(
      "PERPLEXITY_API_KEY environment variable is required",
      MISSING_KEY_HELP,
    );
  }
  return key;
}

export function isPerplexityConfigured(env: NodeJS.ProcessEnv): boolean {
  return resolvePerplexityApiKey(env) !== undefined;
}
