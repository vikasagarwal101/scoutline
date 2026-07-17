/**
 * Z.AI credential resolution (DESIGN.md §6, P0-02 — Fixup A — B4, B7).
 *
 * Single source of truth for the Z.AI API key. The primary
 * `Z_AI_API_KEY` is accepted alongside the characterized `ZAI_API_KEY`
 * alias; `Z_AI_API_KEY` takes precedence when both are set. Whitespace-
 * only values are treated as absent, matching the descriptor's
 * `isConfigured` contract.
 *
 * Boundary rules (ARCHITECTURE.md §2):
 *   - May import the normalized-error contract only.
 *   - Must NOT import transport, command presentation, or another
 *     Provider's Adapter.
 *
 * Missing credentials are surfaced as {@link ConfigurationError}
 * (exit 3), distinct from {@link AuthError} (exit 1) which means the
 * Provider REJECTED a presented credential. This mirrors `lib/config.ts`
 * (`loadConfig`/`getApiKey`) so every Z.AI entry point agrees on the
 * missing-credential exit code.
 */

import { ConfigurationError } from "../../lib/errors.js";

const MISSING_KEY_HELP = 'export Z_AI_API_KEY="your-api-key"';

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
 * Resolve the Z.AI API key without throwing. `Z_AI_API_KEY` takes
 * precedence over the `ZAI_API_KEY` alias. Returns `undefined` when no
 * non-blank value is present.
 */
export function resolveZaiApiKey(env: NodeJS.ProcessEnv): string | undefined {
  return pickNonBlank(env.Z_AI_API_KEY) ?? pickNonBlank(env.ZAI_API_KEY);
}

/**
 * Resolve the Z.AI API key or throw {@link ConfigurationError} (exit 3)
 * when it is missing. Call this at every capability invocation gate.
 */
export function requireZaiApiKey(env: NodeJS.ProcessEnv): string {
  const key = resolveZaiApiKey(env);
  if (key === undefined) {
    throw new ConfigurationError("Z_AI_API_KEY environment variable is required", MISSING_KEY_HELP);
  }
  return key;
}

/**
 * True when a non-blank Z.AI API key (primary or alias) is configured.
 * Metadata-only: performs no transport construction and reads no other
 * Provider's credentials.
 */
export function isZaiConfigured(env: NodeJS.ProcessEnv): boolean {
  return resolveZaiApiKey(env) !== undefined;
}
