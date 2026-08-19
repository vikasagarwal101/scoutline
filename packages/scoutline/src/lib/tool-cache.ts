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
import { atomicReplaceFile } from "./config-store.js";
import { redactTool } from "./redact.js";

/**
 * Cache envelope version. Bumped when the on-disk shape of
 * {@link ToolCachePayload} changes; old envelopes are ignored.
 *
 * v2 (1.2 review fix): invalidates pre-fix v1 entries that may contain
 * un-redacted file-only API keys. `writeToolCache` now threads resolved
 * secrets into `redactTool`, so v2 entries are safe — but old v1
 * envelopes must not be served.
 */
export const TOOL_CACHE_VERSION = 2;

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
 *
 * On a version mismatch the legacy envelope is unlinked best-effort
 * (B1-U2 / #45): pre-redaction v1 entries may carry plaintext Provider
 * credentials, so leaving them on disk after we detect they are unsafe
 * would let the secret linger until manual cleanup. `fs.unlink` is
 * wrapped — a failure to remove the file (race, permissions) degrades to
 * a clean miss; it never surfaces as an error from the read path.
 */
export async function readToolCache(config: ToolCacheConfig): Promise<Tool[] | null> {
  if (!isToolCacheEnabled()) return null;
  const ttlMs = getCacheTtlMs();
  if (ttlMs <= 0) return null;
  const filePath = buildToolCachePath(config);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const entry = JSON.parse(raw) as Partial<ToolCachePayload>;
    if (!entry || entry.version !== TOOL_CACHE_VERSION || !Array.isArray(entry.tools)) {
      // Legacy envelope: drop the file so un-redacted secrets do not
      // linger. Best-effort — a failed unlink still returns null.
      await fs.unlink(filePath).catch(() => {});
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
 *
 * The optional `secrets` argument lets a caller thread the credentials
 * resolved from an injected environment (e.g. `ZaiMcpClient.options.env`)
 * into redaction, so a secret that exists only in the injected env — and
 * not in ambient `process.env` — is still redacted. When omitted,
 * `redactTool` falls back to `configuredSecrets()` from `process.env`,
 * which may miss file-only configured keys (1.1.a).
 */
export async function writeToolCache(
  config: ToolCacheConfig,
  tools: Tool[],
  secrets?: string[],
): Promise<void> {
  if (!isToolCacheEnabled()) return;
  if (getCacheTtlMs() <= 0) return;
  try {
    const filePath = buildToolCachePath(config);
    const payload: ToolCachePayload = {
      version: TOOL_CACHE_VERSION,
      timestamp: Date.now(),
      tools: tools.map((tool) => redactTool(tool, secrets)),
    };
    // 5.4: use atomic temp-file + rename so a crash mid-write cannot
    // leave a partially-written tool-cache file. atomicReplaceFile
    // handles directory creation (mode 0700), exclusive temp-file
    // creation (mode 0600), fsync, rename, and directory sync.
    await atomicReplaceFile(filePath, JSON.stringify(payload));
  } catch {
    // Best-effort cache only.
  }
}
