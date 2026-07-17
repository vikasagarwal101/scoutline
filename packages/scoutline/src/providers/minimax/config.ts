/**
 * MiniMax Adapter-local configuration (DESIGN.md §12 — P2-04).
 *
 * Reads MiniMax credentials and endpoints from the injected environment.
 * This module is the Adapter-local companion to the SDK client; MiniMax
 * environment names intentionally do NOT appear in shared `lib/config.ts`
 * (that module remains Z.AI-only). No credential is persisted or read
 * from shared configuration.
 *
 * Resolution rules:
 *   - `MINIMAX_API_KEY`: required, non-empty after trim. Whitespace-only
 *     is invalid, not absent.
 *   - `MINIMAX_REGION`: optional; undefined defaults to `global`. An
 *     empty value is invalid, not absent. Must be exactly `global` or
 *     `cn`.
 *   - Region URLs: `global` -> `https://api.minimax.io`,
 *     `cn` -> `https://api.minimaxi.com`.
 *   - `MINIMAX_BASE_URL`: optional override; must be an absolute HTTPS
 *     URL. An empty value is invalid. Exactly one trailing slash is
 *     removed. Overrides the region URL for every SDK operation.
 */

import { ConfigurationError } from "../../lib/errors.js";

export interface MiniMaxConfig {
  readonly apiKey: string;
  readonly region: "global" | "cn";
  readonly baseUrl: string;
}

const REGION_BASE_URLS = {
  global: "https://api.minimax.io",
  cn: "https://api.minimaxi.com",
} as const;

const MISSING_KEY_HELP = 'export MINIMAX_API_KEY="your-api-key"';
const REGION_HELP = "Accepted MINIMAX_REGION values: global, cn";
const BASE_URL_HELP =
  "MINIMAX_BASE_URL must be an absolute HTTPS URL (e.g. https://api.minimax.io)";

/**
 * Load and validate MiniMax configuration from the injected environment.
 * Throws a normalized {@link ConfigurationError} for any invalid value.
 */
export function loadMiniMaxConfig(env: NodeJS.ProcessEnv): MiniMaxConfig {
  const apiKey = env.MINIMAX_API_KEY;
  if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
    throw new ConfigurationError(
      "MINIMAX_API_KEY environment variable is required",
      MISSING_KEY_HELP,
    );
  }

  const regionRaw = env.MINIMAX_REGION;
  let region: "global" | "cn";
  if (regionRaw === undefined) {
    region = "global";
  } else if (regionRaw.trim() === "") {
    throw new ConfigurationError('MINIMAX_REGION must be "global" or "cn"', REGION_HELP);
  } else if (regionRaw !== "global" && regionRaw !== "cn") {
    throw new ConfigurationError(`Unknown MINIMAX_REGION "${regionRaw}"`, REGION_HELP);
  } else {
    region = regionRaw;
  }

  const baseUrlRaw = env.MINIMAX_BASE_URL;
  let baseUrl: string;
  if (baseUrlRaw === undefined) {
    baseUrl = REGION_BASE_URLS[region];
  } else if (baseUrlRaw.trim() === "") {
    throw new ConfigurationError("MINIMAX_BASE_URL must not be empty", BASE_URL_HELP);
  } else if (!/^https:\/\//i.test(baseUrlRaw)) {
    throw new ConfigurationError(
      `MINIMAX_BASE_URL must be an absolute HTTPS URL (got "${baseUrlRaw}")`,
      BASE_URL_HELP,
    );
  } else {
    // Fixup C — W1: reject scheme-only URLs (no host). The previous
    // accept-and-normalize path turned `https://` into `https:/`, which
    // is not a valid URL and breaks SDK construction. Parse the URL and
    // require a non-empty host.
    let parsed: URL;
    try {
      parsed = new URL(baseUrlRaw);
    } catch {
      throw new ConfigurationError(
        `MINIMAX_BASE_URL must be an absolute HTTPS URL with a host (got "${baseUrlRaw}")`,
        BASE_URL_HELP,
      );
    }
    if (parsed.host.length === 0) {
      throw new ConfigurationError(
        `MINIMAX_BASE_URL must include a host (got "${baseUrlRaw}")`,
        BASE_URL_HELP,
      );
    }
    // Remove exactly one trailing slash so the SDK receives a clean base.
    baseUrl = baseUrlRaw.replace(/\/$/, "");
  }

  return { apiKey, region, baseUrl };
}
