/**
 * Parallel AI credential resolution.
 *
 * Single source of truth for the Parallel AI API key (`PARALLEL_API_KEY`).
 */

import { ConfigurationError } from "../../lib/errors.js";

const MISSING_KEY_HELP = 'export PARALLEL_API_KEY="your-parallel-api-key"';

function pickNonBlank(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  return raw.trim().length > 0 ? raw : undefined;
}

export function resolveParallelApiKey(env: NodeJS.ProcessEnv): string | undefined {
  return pickNonBlank(env.PARALLEL_API_KEY);
}

export function requireParallelApiKey(env: NodeJS.ProcessEnv): string {
  const key = resolveParallelApiKey(env);
  if (key === undefined) {
    throw new ConfigurationError(
      "PARALLEL_API_KEY environment variable is required",
      MISSING_KEY_HELP,
    );
  }
  return key;
}

export function isParallelConfigured(env: NodeJS.ProcessEnv): boolean {
  return resolveParallelApiKey(env) !== undefined;
}
