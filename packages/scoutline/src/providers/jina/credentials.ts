/**
 * Jina AI credential resolution.
 *
 * Single source of truth for the Jina AI API key (`JINA_API_KEY`).
 *
 * Jina supports keyless access (free tier), so the key is optional.
 * `isJinaConfigured` always returns true because the transport works
 * without authentication. An API key raises rate limits and is
 * recommended for production use, but is not required for the provider
 * to participate in selection, fallback, or diagnostics.
 */

function pickNonBlank(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  return raw.trim().length > 0 ? raw : undefined;
}

export function resolveJinaApiKey(env: NodeJS.ProcessEnv): string | undefined {
  return pickNonBlank(env.JINA_API_KEY);
}

export function isJinaConfigured(_env: NodeJS.ProcessEnv): boolean {
  // Jina supports keyless access — always available.
  return true;
}
