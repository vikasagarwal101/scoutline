/**
 * Quota command — authoritative Z.AI Coding Plan usage from the monitor API.
 *
 * P1-09: returns a `CommandResult` instead of writing to stdout/stderr and
 * terminating. The TTY dashboard is carried as a presentation override
 * (`presentations.tty`) so `invokeCommand` selects it only for tty output
 * mode; all other modes emit the normalized data object. Errors (including
 * a missing key thrown as `ConfigurationError` by the config accessor)
 * propagate to `invokeCommand`.
 *
 * NOTE: the normalized output shape below is the current Z.AI
 * characterization. It is deliberately replaced by the ProviderCapability
 * shape from ADR-0001 in P4-02.
 */

import {
  getQuotaLimit,
  getTimeLimit,
  getTokensLimit,
  formatResetTime,
  type QuotaLimit,
} from "../lib/monitor-client.js";
import { formatQuotaPretty } from "../lib/tty.js";
import type { CommandResult } from "../command-invocation.js";

export interface QuotaOptions {
  window?: "current"; // reserved for future: --window 7d etc.
}

/**
 * Behaviour-preserving optional dependencies for testing the quota command.
 * Omitted dependencies call the current monitor-API client, which in turn
 * resolves the API key through the config accessor.
 */
export interface QuotaDependencies {
  quotaFetcher?: () => Promise<QuotaLimit>;
}

export async function quota(
  _options: QuotaOptions = {},
  deps: QuotaDependencies = {},
): Promise<CommandResult> {
  const fetchQuota = deps.quotaFetcher || getQuotaLimit;
  const data = await fetchQuota();
  const timeLimit = getTimeLimit(data);
  const tokensLimit = getTokensLimit(data);

  const formatted = {
    plan: data.level,
    timeWindow: timeLimit
      ? {
          used: timeLimit.currentValue,
          limit: timeLimit.usage,
          remaining: timeLimit.remaining,
          percentage: timeLimit.percentage,
          windowHours: timeLimit.unit,
          resetsAt: timeLimit.nextResetTime
            ? new Date(timeLimit.nextResetTime).toISOString()
            : null,
          resetsIn: timeLimit.nextResetTime ? formatResetTime(timeLimit.nextResetTime) : null,
          byTool: timeLimit.usageDetails,
        }
      : null,
    tokens: tokensLimit
      ? {
          percentage: tokensLimit.percentage,
          resetsAt: tokensLimit.nextResetTime
            ? new Date(tokensLimit.nextResetTime).toISOString()
            : null,
          resetsIn: tokensLimit.nextResetTime ? formatResetTime(tokensLimit.nextResetTime) : null,
        }
      : null,
  };

  return {
    kind: "data",
    data: formatted,
    presentations: {
      tty: formatQuotaPretty(formatted),
    },
  };
}

export const QUOTA_HELP = `
Quota Command - Authoritative Z.AI Coding Plan usage from the monitor API

Usage: scoutline quota [options]

Hits GET https://api.z.ai/api/monitor/usage/quota/limit directly (NOT the MCP
endpoint) to return real-time plan usage, including:
  - Plan tier (pro / lite / max)
  - 5-hour rolling window: calls used / limit / remaining / reset time
  - Per-tool breakdown (search-prime, web-reader, zread)
  - Token budget percentage + reset time

Options:
  (none yet — future versions may add --history for 24h/7d/30d windows)

Examples:
  scoutline quota
  scoutline quota -O pretty    # human-readable with progress bars
  scoutline quota -O json      # envelope-wrapped for scripts

Notes:
  - This call hits a different endpoint than search/read/repo and is not
    cached by the local response cache.
  - Auth: tries raw API key first, falls back to Bearer prefix on 401.
`.trim();
