/**
 * Quota command — authoritative Z.AI Coding Plan usage from the monitor API.
 */

import {
  getQuotaLimit,
  getTimeLimit,
  getTokensLimit,
  formatResetTime,
} from "../lib/monitor-client.js";
import { outputSuccess, getOutputMode } from "../lib/output.js";
import { formatErrorOutput } from "../lib/errors.js";
import { formatQuotaPretty } from "../lib/tty.js";

export interface QuotaOptions {
  window?: "current"; // reserved for future: --window 7d etc.
}

export async function quota(_options: QuotaOptions = {}): Promise<void> {
  try {
    const data = await getQuotaLimit();
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

    const mode = getOutputMode();
    if (mode === "tty") {
      outputSuccess(formatQuotaPretty(formatted));
    } else {
      outputSuccess(formatted);
    }
  } catch (error) {
    console.error(formatErrorOutput(error));
    process.exit(1);
  }
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
