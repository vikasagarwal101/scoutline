/**
 * Tool-discovery cache — extracted from {@link ZaiMcpClient} (Ticket 02).
 *
 * Owns its filesystem I/O directly against the `tools/` subdirectory
 * under the unified cache root (D1 revised — does NOT reuse
 * `ResponseCache` for storage). Stores {@link redactTool}-scrubbed tools
 * (B2 fix) under a single TTL check (H2 fix).
 *
 * # Enable check (preserves v0.4.0 granularity — D3 deviation)
 *
 * ```text
 * isToolCacheEnabled = isCacheEnabled() && ZAI_MCP_TOOL_CACHE != "0"/"false"
 * ```
 *
 * - `SCOUTLINE_CACHE=0` (or legacy `ZAI_CACHE=0`) disables BOTH caches
 *   because `isCacheEnabled()` returns false.
 * - `ZAI_MCP_TOOL_CACHE=0` disables ONLY the tool cache; the response
 *   cache stays enabled because `isCacheEnabled()` does NOT consult
 *   this var. This preserves the four `mcp-client.test.js` suites that
 *   set `ZAI_MCP_TOOL_CACHE=0` per-suite while relying on
 *   response-cache hits.
 *
 * # Versioning
 *
 * {@link TOOL_CACHE_VERSION} is stamped into every cache envelope. A
 * mismatch (e.g. an old `tools-*.json` written by a future or past
 * release) yields a clean miss — never a throw — so an upgrade cannot
 * break tool discovery.
 */

import crypto from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import type { Tool } from "@utcp/sdk";
import { toolCacheDir, isCacheEnabled, getCacheTtlMs } from "./cache.js";
import { redactTool } from "./redact.js";

/**
 * Cache envelope version. Bumped when the on-disk shape of
 * {@link ToolCachePayload} changes; old envelopes are ignored.
 */
export const TOOL_CACHE_VERSION = 1;

/**
 * Inputs to the tool-cache key. Captures every dimension that affects
 * WHICH tools the MCP servers return: mode + baseUrl (ZAI vs ZHIPU),
 * the three HTTP endpoints, and whether the stdio vision server is
 * registered. The ZaiMcpClient adapter builds this from {@link loadConfig}
 * + {@link getMcpEndpoints} + its private `resolveEnableVision()`.
 */
export interface ToolCacheConfig {
  mode: string;
  baseUrl: string;
  endpoints: Record<string, string>;
  enableVision: boolean;
}

interface ToolCachePayload {
  version: number;
  timestamp: number;
  tools: Tool[];
}

/**
 * Tool-cache enable check (preserves v0.4.0 granularity — D3
 * deviation). The tool cache is enabled only when BOTH:
 *   - the response cache is enabled (`isCacheEnabled()` honours
 *     `SCOUTLINE_CACHE` / `ZAI_CACHE`); AND
 *   - the tool-specific `ZAI_MCP_TOOL_CACHE` env var is not "0"/"false".
 *
 * Read at call time (H1 fix) so per-suite env mutations in tests remain
 * observable.
 */
export function isToolCacheEnabled(): boolean {
  if (!isCacheEnabled()) return false;
  const v = (process.env.ZAI_MCP_TOOL_CACHE ?? "1").toLowerCase();
  return !["0", "false"].includes(v);
}

/**
 * Build the 16-char cache key for a config. Mirrors the v0.4.0 algorithm
 * in the extracted `ZaiMcpClient.getToolCacheKey`: SHA-256 of the
 * JSON-stringified config, first 16 hex chars. Two configs that produce
 * the same JSON yield the same key; distinct configs yield distinct keys.
 */
export function buildToolCacheKey(config: ToolCacheConfig): string {
  return crypto.createHash("sha256").update(JSON.stringify(config)).digest("hex").slice(0, 16);
}

/**
 * Build the absolute on-disk path for a config's tool-cache envelope.
 * Always lands under the `tools/` subdirectory (sibling of `cache/`).
 */
export function buildToolCachePath(config: ToolCacheConfig): string {
  return path.join(toolCacheDir(), `tools-${buildToolCacheKey(config)}.json`);
}

/**
 * Read the tool cache for a config. Returns `null` on miss, version
 * mismatch, TTL expiry, corruption (invalid JSON, missing file), or when
 * the tool cache is disabled. NEVER throws — a miss degrades cleanly to
 * discovery.
 */
export async function readToolCache(config: ToolCacheConfig): Promise<Tool[] | null> {
  if (!isToolCacheEnabled()) return null;
  const ttlMs = getCacheTtlMs();
  if (ttlMs <= 0) return null;
  try {
    const raw = await fs.readFile(buildToolCachePath(config), "utf8");
    const entry = JSON.parse(raw) as Partial<ToolCachePayload>;
    if (!entry || entry.version !== TOOL_CACHE_VERSION || !Array.isArray(entry.tools)) {
      return null;
    }
    if (Date.now() - (entry.timestamp ?? 0) > ttlMs) return null;
    return entry.tools;
  } catch {
    return null;
  }
}

/**
 * Write the tool cache for a config. Applies {@link redactTool} to every
 * tool before serialization (B2 fix) so the on-disk envelope never
 * contains raw Provider credentials. Best-effort: I/O failures are
 * swallowed (cache is disposable).
 */
export async function writeToolCache(config: ToolCacheConfig, tools: Tool[]): Promise<void> {
  if (!isToolCacheEnabled()) return;
  if (getCacheTtlMs() <= 0) return;
  try {
    const filePath = buildToolCachePath(config);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const payload: ToolCachePayload = {
      version: TOOL_CACHE_VERSION,
      timestamp: Date.now(),
      tools: tools.map((tool) => redactTool(tool)),
    };
    await fs.writeFile(filePath, JSON.stringify(payload));
  } catch {
    // Best-effort cache only.
  }
}
