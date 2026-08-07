/**
 * Jina AI credential resolution.
 *
 * Single source of truth for the Jina AI API key (`JINA_API_KEY`).
 *
 * Jina supports keyless access (free tier), so the key is optional.
 * Callers use `resolveJinaApiKey` (returns `string | undefined`) rather
 * than a throwing `require*` variant. The credential fingerprint hashes
 * `"keyless"` when no key is present so cache entries are still stable.
 */

function pickNonBlank(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  return raw.trim().length > 0 ? raw : undefined;
}

export function resolveJinaApiKey(env: NodeJS.ProcessEnv): string | undefined {
  return pickNonBlank(env.JINA_API_KEY);
}

export function isJinaConfigured(env: NodeJS.ProcessEnv): boolean {
  return resolveJinaApiKey(env) !== undefined;
}
