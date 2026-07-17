/**
 * Z.AI Monitor API client — compatibility delegate (P4-02).
 *
 * The Z.AI fetch mechanics moved to
 * {@link ../providers/zai/monitor-client.js} so the Provider Adapter owns
 * its transport. This module retains every existing export as a thin
 * delegate so current imports keep working while command Modules migrate
 * to the normalized Provider-quota Interface (ADR-0001).
 *
 * Distinct from the MCP/coding endpoints:
 *   - Base: https://api.z.ai  (no /api/coding/paas/v4 prefix)
 *   - Auth quirk: try `Authorization: <key>` first; on 401 retry with `Bearer <key>`
 */

import { getApiKey } from "./config.js";
import { ApiError, AuthError, NetworkError, TimeoutError } from "./errors.js";
import { fetchZaiMonitorPath } from "../providers/zai/monitor-client.js";

export interface ToolUsage {
  modelCode: string;
  usage: number;
}

export interface TimeLimit {
  type: "TIME_LIMIT";
  unit: number; // hours
  number: number;
  usage: number; // call cap in window
  currentValue: number; // calls used
  remaining: number;
  percentage: number;
  nextResetTime: number; // epoch ms
  usageDetails: ToolUsage[];
}

export interface TokensLimit {
  type: "TOKENS_LIMIT";
  unit: number;
  number: number;
  percentage: number;
  nextResetTime?: number; // optional — API sometimes omits this
}

export interface QuotaLimit {
  level: string; // "pro", "lite", "max", etc.
  limits: (TimeLimit | TokensLimit)[];
}

export interface ModelUsageTotal {
  totalModelCallCount: number;
  totalTokensUsage: number;
  modelSummaryList?: Array<{ modelName: string; totalTokens: number; sortOrder: number }>;
}

/**
 * Back-compat delegate. Resolves the API key through the shared config
 * accessor and delegates the fetch to the Provider-local monitor client.
 */
export async function getQuotaLimit(): Promise<QuotaLimit> {
  const apiKey = getApiKey();
  const data = (await fetchZaiMonitorPath(
    apiKey,
    "/api/monitor/usage/quota/limit",
    undefined,
    {},
  )) as Partial<QuotaLimit>;
  return {
    level: data.level || "unknown",
    limits: data.limits || [],
  };
}

/**
 * Back-compat delegate for the model-usage endpoint. Unused by commands
 * today; preserved so the public export surface is unchanged.
 */
export async function getModelUsage(startTime: string, endTime: string): Promise<ModelUsageTotal> {
  const apiKey = getApiKey();
  const data = (await fetchZaiMonitorPath(apiKey, "/api/monitor/usage/model-usage", {
    startTime,
    endTime,
  })) as { totalUsage?: ModelUsageTotal };
  return (
    data.totalUsage || {
      totalModelCallCount: 0,
      totalTokensUsage: 0,
    }
  );
}

// Convenience accessors with type narrowing
export function getTimeLimit(data: QuotaLimit): TimeLimit | undefined {
  return data.limits.find((l): l is TimeLimit => l.type === "TIME_LIMIT");
}

export function getTokensLimit(data: QuotaLimit): TokensLimit | undefined {
  return data.limits.find((l): l is TokensLimit => l.type === "TOKENS_LIMIT");
}

/** Human-readable "in 4h 23m" / "in 3d" / "now" from epoch-ms timestamp. */
export function formatResetTime(epochMs: number): string {
  const diff = epochMs - Date.now();
  if (diff <= 0) return "now";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours < 24) return mins ? `${hours}h ${mins}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

// Re-export the normalized error classes so existing imports from this
// module keep resolving.
export { ApiError, AuthError, NetworkError, TimeoutError };
