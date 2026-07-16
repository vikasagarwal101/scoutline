/**
 * Z.AI Monitor API client — quota and usage endpoints.
 *
 * Distinct from the MCP/coding endpoints:
 *   - Base: https://api.z.ai  (no /api/coding/paas/v4 prefix)
 *   - Auth quirk: try `Authorization: <key>` first; on 401 retry with `Bearer <key>`
 *
 * Reference: /run/media/vikas/devdrive/glm-usage-indicator/API.md
 */

import { getApiKey } from "./config.js";
import { ApiError, AuthError, NetworkError, TimeoutError } from "./errors.js";

const MONITOR_BASE = process.env.ZAI_MONITOR_BASE_URL || "https://api.z.ai";
const TIMEOUT_MS = parseInt(process.env.Z_AI_TIMEOUT || "30000", 10);

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

async function fetchWithAuth(path: string, params?: Record<string, string>): Promise<unknown> {
  const apiKey = getApiKey();
  const url = new URL(MONITOR_BASE + path);
  if (params) {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  }

  // The monitor API accepts the key with OR without Bearer prefix.
  // Try raw first; on 401, retry with Bearer.
  for (const authValue of [apiKey, `Bearer ${apiKey}`]) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: authValue,
          "Accept-Language": "en-US,en",
          "Content-Type": "application/json",
        },
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (res.status === 401 && authValue === apiKey) {
        // Retry with Bearer prefix
        continue;
      }

      if (!res.ok) {
        const text = await res.text();
        let msg = `HTTP ${res.status}: ${text}`;
        try {
          const j = JSON.parse(text);
          msg = j.message || j.error?.message || msg;
        } catch {
          // keep raw text
        }
        if (res.status === 401 || res.status === 403) {
          throw new AuthError(`Monitor API auth failed: ${msg}`);
        }
        throw new ApiError(msg, res.status);
      }

      const body = (await res.json()) as { data?: unknown };
      // Endpoint wraps responses in { data: {...} } — unwrap.
      return body.data ?? body;
    } catch (err) {
      clearTimeout(timeoutId);
      if (err instanceof AuthError || err instanceof ApiError) throw err;
      if (err instanceof Error) {
        if (err.name === "AbortError") throw new TimeoutError(TIMEOUT_MS);
        if (err.message.includes("fetch") || err.message.includes("ECONNREFUSED")) {
          throw new NetworkError(err.message);
        }
      }
      throw err;
    }
  }
  throw new AuthError("Monitor API rejected both auth schemes");
}

export async function getQuotaLimit(): Promise<QuotaLimit> {
  const data = (await fetchWithAuth("/api/monitor/usage/quota/limit")) as Partial<QuotaLimit>;
  return {
    level: data.level || "unknown",
    limits: data.limits || [],
  };
}

export async function getModelUsage(startTime: string, endTime: string): Promise<ModelUsageTotal> {
  const data = (await fetchWithAuth("/api/monitor/usage/model-usage", {
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
