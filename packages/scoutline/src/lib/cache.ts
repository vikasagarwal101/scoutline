/**
 * Unified cache storage module.
 *
 * Two sibling on-disk caches live under one root (`~/.scoutline/` by
 * default; overridable via `SCOUTLINE_CACHE_DIR`):
 *
 * ```text
 * ~/.scoutline/
 *   ├── cache/    response cache entries (Provider responses)
 *   └── tools/    tool discovery cache (consumed by mcp-client.ts)
 * ```
 *
 * The response cache stores the RAW response from a Provider (before any
 * post-processing like truncation, format conversion, or extraction)
 * keyed by a hash of the command + request-affecting arguments.
 * Post-processing flags like --max-chars, --output-format, --extract are
 * NOT part of the cache key, so the same cached response can serve
 * multiple presentation variants.
 *
 * Defaults: 24h TTL, 100MB size cap, LRU eviction when full. Disable
 * per-call with --no-cache, or globally with `SCOUTLINE_CACHE=0`.
 *
 * Env-var policy: `SCOUTLINE_CACHE*` are the canonical names. The legacy
 * `ZAI_CACHE*`, `ZAI_MCP_TOOL_CACHE*`, and `ZAI_MCP_CACHE_DIR` variables
 * are accepted as lower-precedence aliases (silent aliasing — no
 * deprecation notice in this release). All reads are call-time (H1 fix)
 * so per-suite env mutations remain observable.
 *
 * P2-02 extends this module with provider-partitioned keys
 * (`buildProviderCacheKey`) and a `ResponseCache` adapter that lets
 * shared execution read and write through the same on-disk store without
 * duplicating TTL or eviction logic.
 */

import crypto from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getApiKey } from "./config.js";
import type { ProviderId } from "../providers/types.js";

interface CacheEntry<T> {
  ts: number;
  data: T;
}

// ---------------------------------------------------------------------------
// Directory resolution — unified dotfile root with override aliases
// ---------------------------------------------------------------------------

/**
 * Environment surface consumed by the pure cache-root resolver. The legacy
 * aliases (`ZAI_MCP_CACHE_DIR`, `ZAI_CACHE_DIR`) are preserved so existing
 * operator configurations keep working silently. `XDG_CACHE_HOME` was
 * removed when the dotfile convention (`~/.scoutline/`) was adopted on
 * every platform.
 */
export interface CacheDirEnvironment {
  readonly SCOUTLINE_CACHE_DIR?: string | undefined;
  readonly ZAI_MCP_CACHE_DIR?: string | undefined; // legacy alias (precedence over ZAI_CACHE_DIR)
  readonly ZAI_CACHE_DIR?: string | undefined; // legacy alias
}

export interface CacheDirPlatform {
  readonly platform: NodeJS.Platform;
  readonly homedir: string;
}

/**
 * Pure cache-ROOT resolver. Accepts environment and platform explicitly
 * so tests can assert path resolution without touching process globals.
 * Returns the root directory (`~/.scoutline/`); each cache appends its
 * own subdirectory (`cache/` or `tools/`). Precedence:
 *   1. `SCOUTLINE_CACHE_DIR` (canonical)
 *   2. `ZAI_MCP_CACHE_DIR`   (legacy tool-cache override; B3 fix)
 *   3. `ZAI_CACHE_DIR`       (legacy response-cache override)
 *   4. `path.join(homedir, ".scoutline")` (dotfile default, all platforms)
 *
 * The process-backed {@link resolveCacheRoot} wraps this with live state.
 */
export function resolveCacheRootPure(env: CacheDirEnvironment, plat: CacheDirPlatform): string {
  const explicit = env.SCOUTLINE_CACHE_DIR ?? env.ZAI_MCP_CACHE_DIR ?? env.ZAI_CACHE_DIR;
  if (explicit) return explicit;
  return path.join(plat.homedir, ".scoutline");
}

function resolveCacheRoot(): string {
  return resolveCacheRootPure(
    {
      SCOUTLINE_CACHE_DIR: process.env.SCOUTLINE_CACHE_DIR,
      ZAI_MCP_CACHE_DIR: process.env.ZAI_MCP_CACHE_DIR,
      ZAI_CACHE_DIR: process.env.ZAI_CACHE_DIR,
    },
    { platform: process.platform, homedir: os.homedir() },
  );
}

/**
 * Internal directory for response-cache entries. Always a `cache/`
 * subdirectory under the unified root.
 */
function responseCacheDir(): string {
  return path.join(resolveCacheRoot(), "cache");
}

/**
 * Directory for the tool-discovery cache (consumed by mcp-client.ts).
 * Always a `tools/` subdirectory under the unified root, sibling of
 * {@link responseCacheDir}. Scanned by `cacheStats()` and cleared by
 * `clearAllCaches()`, but never touched by the response cache's LRU
 * eviction loop.
 */
export function toolCacheDir(): string {
  return path.join(resolveCacheRoot(), "tools");
}

// ---------------------------------------------------------------------------
// Call-time env reads (H1 fix: preserves the existing test contract)
// ---------------------------------------------------------------------------

/**
 * Read a cache env var with aliasing. The canonical `newName` wins; each
 * `oldName` is consulted in order. Returns the first defined value or
 * `undefined`.
 */
function readCacheEnv(newName: string, ...oldNames: string[]): string | undefined {
  if (process.env[newName]) return process.env[newName];
  for (const old of oldNames) {
    if (process.env[old]) return process.env[old];
  }
  return undefined;
}

/**
 * Call-time cache-enabled check for the RESPONSE cache (H1 fix). Honours
 * `SCOUTLINE_CACHE` (canonical) with `ZAI_CACHE` as a legacy alias. Read
 * on every cache operation so per-suite env mutations in tests remain
 * observable.
 *
 * Note: the legacy `ZAI_MCP_TOOL_CACHE` env var is intentionally NOT
 * consulted here. In v0.4.0 the tool cache's enable flag was independent
 * of the response cache's; mcp-client.ts still reads
 * `ZAI_MCP_TOOL_CACHE` directly for its own tool-cache enable check.
 * Aliasing it here would silently disable the response cache whenever a
 * user disabled the tool cache, which would break the four
 * `mcp-client.test.js` suites that set `ZAI_MCP_TOOL_CACHE=0` while
 * relying on response-cache hits. Unifying this granularity is deferred
 * to a future release (see tech-plan "what this plan does not decide").
 */
export function isCacheEnabled(): boolean {
  const v = readCacheEnv("SCOUTLINE_CACHE", "ZAI_CACHE");
  return !["0", "false"].includes((v ?? "1").toLowerCase());
}

/** Call-time TTL (ms) for the response cache. Default 24h. */
export function getCacheTtlMs(): number {
  // ZAI_MCP_TOOL_CACHE_TTL_MS is intentionally not aliased here — the
  // tool cache (mcp-client.ts) reads its own TTL directly. Aliasing it
  // would silently change response-cache TTL when a user set only the
  // tool-cache TTL, mirroring the granularity decision in isCacheEnabled.
  const v = readCacheEnv("SCOUTLINE_CACHE_TTL_MS", "ZAI_CACHE_TTL_MS");
  return parseInt(v ?? "", 10) || 24 * 60 * 60 * 1000;
}

/** Call-time response-cache size cap (bytes). Default 100MB. */
export function getCacheSizeCapBytes(): number {
  const v = readCacheEnv("SCOUTLINE_CACHE_SIZE_MB", "ZAI_CACHE_SIZE_MB");
  return parseInt(v ?? "", 10) * 1024 * 1024 || 100 * 1024 * 1024;
}

// ---------------------------------------------------------------------------
// Cache key builders
// ---------------------------------------------------------------------------

/**
 * Build a stable cache key from command + request-affecting args.
 * Post-processing flags (maxChars, outputFormat, extract, fullEnvelope)
 * are intentionally excluded so one cached fetch serves many presentations.
 */
export function buildCacheKey(command: string, requestArgs: Record<string, unknown>): string {
  const apiKey = getApiKey();
  // Namespace by api key hash so different keys never collide
  const keyHash = crypto.createHash("sha256").update(apiKey).digest("hex").slice(0, 12);
  const payload = JSON.stringify({ command, args: requestArgs });
  const argsHash = crypto.createHash("sha256").update(payload).digest("hex").slice(0, 24);
  return `${command}.${keyHash}.${argsHash}.json`;
}

// ---------------------------------------------------------------------------
// P6-02 — Pure legacy repository cache key builder (DESIGN.md §18)
//
// The Repository Capability supplies its own cache identity through
// `buildProviderCacheKey`. The legacy Z.AI v0.2 keys produced by
// `buildCacheKey` are read-through candidates — they were the production
// path until P6 ships. The Z.AI Adapter reconstructs those legacy
// filenames exactly so a v0.2 cache entry remains valid as a miss-free
// read-through source.
//
// This helper:
//   - is PURE (no `process.env` reads, no `getApiKey` calls);
//   - accepts the resolved `apiKey`, `publicToolName`, and
//     insertion-ordered `args` explicitly;
//   - reproduces the v0.2 algorithm byte-for-byte;
//   - is a SEPARATE symbol from `buildCacheKey` and does NOT call or
//     wrap it.
//
// Algorithm (DESIGN.md §18):
//   credentialPart = sha256(apiKey).hex.slice(0, 12)
//   argumentPart   = sha256(JSON.stringify({ command: publicToolName,
//                                            args })).hex.slice(0, 24)
//   key            = `${publicToolName}.${credentialPart}.${argumentPart}.json`
//
// Legacy argument insertion order is fixed per operation (DESIGN.md §18):
//   - Search:    args = { repo_name, query, language }
//   - File:      args = { repo_name, file_path }
//   - Directory: args = { repo_name }                       (root)
//   - Directory: args = { repo_name, dir_path }            (non-root)
//
// The Adapter passes `args` in the documented order; this helper does
// not reorder, normalize, or sort keys.
// ---------------------------------------------------------------------------

/**
 * Build the exact v0.2 legacy repository cache key. Pure: the caller
 * MUST supply the already-resolved credential. The function never reads
 * `process.env` and never calls `getApiKey`. `args` is serialized in
 * its insertion order via `JSON.stringify`.
 *
 * The result never contains the raw credential — only the first 12 hex
 * chars of `sha256(apiKey)`.
 */
export function buildLegacyRepositoryCacheKey(
  apiKey: string,
  publicToolName: string,
  args: Record<string, unknown>,
): string {
  // SHA-256(apiKey) → first 12 hex chars.
  const credentialPart = crypto.createHash("sha256").update(apiKey).digest("hex").slice(0, 12);
  // SHA-256(JSON.stringify({command,args})) → first 24 hex chars.
  const argumentPayload = JSON.stringify({ command: publicToolName, args });
  const argumentPart = crypto
    .createHash("sha256")
    .update(argumentPayload)
    .digest("hex")
    .slice(0, 24);
  return `${publicToolName}.${credentialPart}.${argumentPart}.json`;
}

// ---------------------------------------------------------------------------
// Reader Migration Ticket 01 — Pure legacy reader cache key builder.
//
// The Reader Capability (P-reader-01 onwards) supplies its own cache
// identity through `buildProviderCacheKey`. The legacy Z.AI v0.2 read
// cache keys produced by `buildCacheKey` are read-through candidates —
// they were the production path for `scoutline read` until the Reader
// migration ships. The Z.AI Reader Adapter (Ticket 03) reconstructs
// those legacy filenames exactly so a v0.2 cache entry remains valid as
// a miss-free read-through source.
//
// This helper:
//   - is PURE (no `process.env` reads, no `getApiKey` calls);
//   - accepts the resolved `apiKey`, `publicToolName`, and
//     insertion-ordered `args` explicitly;
//   - reproduces the v0.2 algorithm byte-for-byte;
//   - is a SEPARATE symbol from `buildCacheKey` and does NOT call or
//     wrap it.
//
// Algorithm (mirrors `buildLegacyRepositoryCacheKey` exactly):
//   credentialPart = sha256(apiKey).hex.slice(0, 12)
//   argumentPart   = sha256(JSON.stringify({ command: publicToolName,
//                                            args })).hex.slice(0, 24)
//   key            = `${publicToolName}.${credentialPart}.${argumentPart}.json`
//
// Legacy argument insertion order is fixed by the v0.2 `webRead`
// implementation (audited: src/lib/mcp-client.ts lines 619–647):
//   1. url                        (always)
//   2. timeout                    (optional, only if params.timeout !== undefined)
//   3. no_cache                   (optional, only if params.noCache !== undefined)
//   4. return_format              (optional, only if params.format is truthy)
//   5. retain_images              (optional)
//   6. with_links_summary         (optional)
//   7. no_gfm                     (optional)
//   8. keep_img_data_url          (optional)
//   9. with_images_summary        (optional)
//
// The Adapter passes `args` in the documented order; this helper does
// not reorder, normalize, or sort keys. `no_cache` IS part of the legacy
// cache key — the v0.2 args object reaches `buildCacheKey` before the
// no-cache directive is consulted. The helper preserves this quirk so
// legacy entries remain reconstructible.
// ---------------------------------------------------------------------------

/**
 * Build the exact v0.2 legacy reader cache key. Pure: the caller MUST
 * supply the already-resolved credential. The function never reads
 * `process.env` and never calls `getApiKey`. `args` is serialized in
 * its insertion order via `JSON.stringify`.
 *
 * The result never contains the raw credential — only the first 12 hex
 * chars of `sha256(apiKey)`.
 */
export function buildLegacyReaderCacheKey(
  apiKey: string,
  publicToolName: string,
  args: Record<string, unknown>,
): string {
  // SHA-256(apiKey) → first 12 hex chars.
  const credentialPart = crypto.createHash("sha256").update(apiKey).digest("hex").slice(0, 12);
  // SHA-256(JSON.stringify({command,args})) → first 24 hex chars.
  const argumentPayload = JSON.stringify({ command: publicToolName, args });
  const argumentPart = crypto
    .createHash("sha256")
    .update(argumentPayload)
    .digest("hex")
    .slice(0, 24);
  return `${publicToolName}.${credentialPart}.${argumentPart}.json`;
}

// ---------------------------------------------------------------------------
// Response cache I/O (writes land under <root>/cache/)
// ---------------------------------------------------------------------------

export async function readCache<T>(key: string, ttlMs = getCacheTtlMs()): Promise<T | null> {
  // H1 fix: call-time enabled check so per-suite env mutations are
  // observed. Module-load capture would silently freeze this to whatever
  // the env was at first import.
  if (!isCacheEnabled() || ttlMs <= 0) return null;
  const file = path.join(responseCacheDir(), key);
  try {
    const raw = await fs.readFile(file, "utf8");
    const entry = JSON.parse(raw) as CacheEntry<T>;
    if (!entry || typeof entry.ts !== "number") return null;
    if (Date.now() - entry.ts > ttlMs) return null;
    // Touch the file for LRU freshness (best-effort)
    await fs.utimes(file, new Date(), new Date()).catch(() => {});
    return entry.data;
  } catch {
    return null;
  }
}

export async function writeCache<T>(key: string, data: T): Promise<void> {
  // H1 fix: call-time enabled check.
  if (!isCacheEnabled()) return;
  const dir = responseCacheDir();
  const file = path.join(dir, key);
  try {
    await fs.mkdir(dir, { recursive: true });
    const entry: CacheEntry<T> = { ts: Date.now(), data };
    await fs.writeFile(file, JSON.stringify(entry));
    await evictIfNeeded(dir);
  } catch {
    // Best-effort cache only
  }
}

async function evictIfNeeded(dir: string): Promise<void> {
  try {
    const entries = await fs.readdir(dir);
    const stats = await Promise.all(
      entries.map(async (name) => {
        try {
          const p = path.join(dir, name);
          const s = await fs.stat(p);
          return { name, size: s.size, mtimeMs: s.mtimeMs };
        } catch {
          return null;
        }
      }),
    );
    const valid = stats.filter((s): s is NonNullable<typeof s> => s !== null);
    const totalBytes = valid.reduce((sum, e) => sum + e.size, 0);
    const sizeCapBytes = getCacheSizeCapBytes();
    if (totalBytes <= sizeCapBytes) return;
    // Evict oldest until under cap
    const sorted = valid.sort((a, b) => a.mtimeMs - b.mtimeMs);
    let bytes = totalBytes;
    for (const entry of sorted) {
      if (bytes <= sizeCapBytes * 0.8) break;
      await fs.unlink(path.join(dir, entry.name)).catch(() => {});
      bytes -= entry.size;
    }
  } catch {
    // Best-effort
  }
}

// ---------------------------------------------------------------------------
// Clear + stats — extended to cover both subdirectories (H3 fix)
// ---------------------------------------------------------------------------

/**
 * Clear the response cache only. Kept for backward compatibility; new
 * callers should prefer {@link clearAllCaches} which covers both the
 * `cache/` and `tools/` subdirectories.
 */
export async function clearCache(): Promise<{ cleared: number; bytesFreed: number }> {
  const dir = responseCacheDir();
  let cleared = 0;
  let bytesFreed = 0;
  try {
    const entries = await fs.readdir(dir);
    for (const name of entries) {
      const p = path.join(dir, name);
      try {
        const s = await fs.stat(p);
        await fs.unlink(p);
        cleared += 1;
        bytesFreed += s.size;
      } catch {
        // skip
      }
    }
  } catch {
    // dir doesn't exist
  }
  return { cleared, bytesFreed };
}

/**
 * Internal: clear a single subdirectory. Returns the count and bytes
 * freed. Does NOT remove the directory itself (next invocation recreates
 * entries without a directory-creation race).
 */
async function clearSubdir(dir: string): Promise<{ cleared: number; bytesFreed: number }> {
  let cleared = 0;
  let bytesFreed = 0;
  try {
    const entries = await fs.readdir(dir);
    for (const name of entries) {
      const p = path.join(dir, name);
      try {
        const s = await fs.stat(p);
        await fs.unlink(p);
        cleared += 1;
        bytesFreed += s.size;
      } catch {
        // skip
      }
    }
  } catch {
    // dir doesn't exist
  }
  return { cleared, bytesFreed };
}

/**
 * Clear both the `cache/` (responses) and `tools/` (tool discovery)
 * subdirectories. Directories themselves are preserved. Existing
 * {@link clearCache} callers continue to clear `cache/` only.
 */
export async function clearAllCaches(): Promise<{
  responsesCleared: number;
  toolsCleared: number;
  bytesFreed: number;
}> {
  const [responses, tools] = await Promise.all([
    clearSubdir(responseCacheDir()),
    clearSubdir(toolCacheDir()),
  ]);
  return {
    responsesCleared: responses.cleared,
    toolsCleared: tools.cleared,
    bytesFreed: responses.bytesFreed + tools.bytesFreed,
  };
}

/**
 * Inventory both caches. The shape extends the v0.4.0 flat shape with
 * nested `responseCache` and `toolCache` sections (H3 fix). The
 * top-level `entries` and `totalBytes` fields are removed — callers
 * must read from the nested sections.
 */
export async function cacheStats(): Promise<{
  dir: string;
  enabled: boolean;
  ttlMs: number;
  sizeCapBytes: number;
  responseCache: { entries: number; totalBytes: number };
  toolCache: { entries: number; totalBytes: number };
}> {
  const dir = resolveCacheRoot();
  const responseDir = responseCacheDir();
  const toolDir = toolCacheDir();

  const [responseStats, toolStats] = await Promise.all([
    inventorySubdir(responseDir),
    inventorySubdir(toolDir),
  ]);

  return {
    dir,
    enabled: isCacheEnabled(),
    ttlMs: getCacheTtlMs(),
    sizeCapBytes: getCacheSizeCapBytes(),
    responseCache: responseStats,
    toolCache: toolStats,
  };
}

async function inventorySubdir(dir: string): Promise<{ entries: number; totalBytes: number }> {
  let entries = 0;
  let totalBytes = 0;
  try {
    const names = await fs.readdir(dir);
    for (const name of names) {
      try {
        const s = await fs.stat(path.join(dir, name));
        entries += 1;
        totalBytes += s.size;
      } catch {
        // skip
      }
    }
  } catch {
    // dir doesn't exist yet
  }
  return { entries, totalBytes };
}

// ---------------------------------------------------------------------------
// Provider-partitioned cache (DESIGN.md §11)
// ---------------------------------------------------------------------------

/**
 * Response cache surface consumed by shared execution
 * (`executeSearch`, future `executeVision`, etc.). Production wires
 * {@link defaultResponseCache} to the existing on-disk implementation;
 * tests inject in-memory doubles.
 */
export interface ResponseCache {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
}

/**
 * Inputs to a provider-partitioned cache key. `credentialFingerprint`
 * is the full lowercase SHA-256 hex digest of the active credential
 * supplied by the Adapter; it is NEVER re-hashed by cache code.
 * `request` is the normalized Capability request whose recursively
 * key-sorted JSON becomes the request hash.
 */
export interface ProviderCacheKeyInput {
  readonly provider: ProviderId;
  readonly capability: string;
  readonly credentialFingerprint: string;
  readonly request: unknown;
}

/**
 * Recursively sort object keys so `JSON.stringify` produces a stable
 * representation regardless of insertion order. Arrays preserve order
 * (positional meaning) and primitives pass through unchanged.
 */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((element) => sortKeysDeep(element));
  }
  if (value && typeof value === "object") {
    const input = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(input).sort()) {
      out[key] = sortKeysDeep(input[key]);
    }
    return out;
  }
  return value;
}

/**
 * Build a provider-partitioned cache key.
 *
 * Shape: `v2.<capability>.<provider>.<credential-hash>.<request-hash>.json`
 *
 * `<credential-hash>` is the Adapter-supplied fingerprint verbatim.
 * `<request-hash>` is the full SHA-256 hex digest of recursively
 * key-sorted JSON of the request. The key never contains a raw
 * credential.
 */
export function buildProviderCacheKey(input: ProviderCacheKeyInput): string {
  const sorted = sortKeysDeep(input.request);
  const requestHash = crypto.createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
  return `v2.${input.capability}.${input.provider}.${input.credentialFingerprint}.${requestHash}.json`;
}

/**
 * Default `ResponseCache` bound to the existing on-disk store. Reads
 * and writes flow through `readCache`/`writeCache`, so TTL, eviction,
 * and directory resolution remain identical to the legacy path.
 */
export const defaultResponseCache: ResponseCache = {
  get<T>(key: string): Promise<T | null> {
    return readCache<T>(key);
  },
  set<T>(key: string, value: T): Promise<void> {
    return writeCache<T>(key, value);
  },
};
