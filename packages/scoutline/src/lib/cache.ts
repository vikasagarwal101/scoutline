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
import { atomicReplaceFile } from "./config-store.js";
import {
  withAsyncFileLock,
  DEFAULT_LOCK_TIMEOUT_MS,
  DEFAULT_LOCK_STALE_MS,
} from "./async-file-lock.js";
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

/**
 * Directory for async-job state files (tech-plan §3, T07 / FC-01). One
 * subdirectory per capability under the unified cache root — `research/`
 * for in-flight research tasks, `crawl/` for async crawl jobs — sibling
 * of {@link responseCacheDir} and {@link toolCacheDir}.
 *
 * Each file holds a single in-flight task's `requestId` so the CLI can
 * resume polling after Ctrl-C instead of creating a second task
 * (double-charge prevention). State files have their own lifecycle
 * (deleted on task completion or failure); they are NOT cleared by
 * `clearAllCaches()` and are NOT scanned by `cacheStats()` — they are
 * billing state, not cache entries.
 *
 * `capability` is the single path segment naming the subdirectory. It is
 * guarded: a non-empty segment with no path separators, no `..`/`.`
 * self-references, and no NUL bytes, whose resolved path stays inside the
 * cache root. A bad segment throws rather than silently writing billing
 * state outside the root. Callers pass an internal constant
 * (`"research"`, `"crawl"`); it is never user input.
 */
export function asyncJobStateDir(capability: string): string {
  if (
    typeof capability !== "string" ||
    capability.length === 0 ||
    capability === "." ||
    capability === ".." ||
    capability.includes("/") ||
    capability.includes("\\") ||
    capability.includes("\0")
  ) {
    throw new Error(`Invalid async-job-state capability segment: ${JSON.stringify(capability)}`);
  }
  const root = resolveCacheRoot();
  const dir = path.join(root, capability);
  // Defense in depth: confirm the resolved segment never escapes the
  // cache root (catches any traversal the lexical check above missed).
  const rel = path.relative(root, path.resolve(dir));
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Async-job-state capability escapes cache root: ${JSON.stringify(capability)}`);
  }
  return dir;
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
 *
 * T2b: an optional `env` parameter (defaulting to `process.env`) threads
 * the resolved credential view — built in `main` from injected env +
 * file-configured keys — into `getApiKey` so the cache fingerprint
 * follows the same credential that authorised the request. Source-
 * compatible: existing no-argument callers keep fingerprinting against
 * ambient `process.env`. The SHA-256 / filename algorithm is unchanged.
 */
export function buildCacheKey(
  command: string,
  requestArgs: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const apiKey = getApiKey(env);
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

/**
 * Read a cached value with a decoder function that validates and narrows
 * the raw JSON. Returns `null` on miss, expiry, or disabled cache.
 */
export async function readCache<T>(
  key: string,
  decoder: (raw: unknown) => T,
  ttlMs?: number,
): Promise<T | null>;

/**
 * Read a cached value without a decoder. Returns `unknown` so the caller
 * must narrow the result — no unsafe generic assumption is made about the
 * stored shape.
 */
export async function readCache(key: string, ttlMs?: number): Promise<unknown | null>;

export async function readCache(
  key: string,
  decoderOrTtl?: number | ((raw: unknown) => unknown),
  ttlMs = getCacheTtlMs(),
): Promise<unknown | null> {
  // H1 fix: call-time enabled check so per-suite env mutations are
  // observed. Module-load capture would silently freeze this to whatever
  // the env was at first import.
  const resolvedTtl = typeof decoderOrTtl === "number" ? decoderOrTtl : ttlMs;
  if (!isCacheEnabled() || resolvedTtl <= 0) return null;
  const file = path.join(responseCacheDir(), key);
  let data: unknown;
  try {
    const raw = await fs.readFile(file, "utf8");
    const entry = JSON.parse(raw) as CacheEntry<unknown>;
    if (!entry || typeof entry.ts !== "number") return null;
    if (Date.now() - entry.ts > resolvedTtl) return null;
    // Touch the file for LRU freshness (best-effort)
    await fs.utimes(file, new Date(), new Date()).catch(() => {});
    data = entry.data;
  } catch {
    return null;
  }
  // Run the decoder outside the file-I/O catch so a throwing validator
  // surfaces as an error rather than being silently swallowed as a miss.
  if (typeof decoderOrTtl === "function") return decoderOrTtl(data);
  return data;
}

export async function writeCache<T>(key: string, data: T): Promise<void> {
  // H1 fix: call-time enabled check.
  if (!isCacheEnabled()) return;
  const dir = responseCacheDir();
  const file = path.join(dir, key);
  try {
    const entry: CacheEntry<T> = { ts: Date.now(), data };
    // 5.5: serialize the write+evict critical section with an inter-process
    // advisory lock so concurrent CLI invocations don't race on the same
    // cache directory. The lock is write-only — readCache stays lock-free
    // (atomic temp+rename + self-healing read is sufficient for readers).
    // A single fixed identity means all writes to this dir serialize through
    // one lockfile. Lock-acquire failures are swallowed here alongside write
    // failures — the best-effort, never-throws contract is preserved.
    await withAsyncFileLock(
      dir,
      "cache-write",
      async () => {
        // 5.3: use atomic temp-file + rename so a crash mid-write cannot
        // leave a partially-written cache file. atomicReplaceFile handles
        // directory creation (mode 0700), exclusive temp-file creation
        // (mode 0600), fsync, rename, and directory sync.
        await atomicReplaceFile(file, JSON.stringify(entry));
        await evictIfNeeded(dir);
      },
      {
        timeoutMs: DEFAULT_LOCK_TIMEOUT_MS,
        staleMs: DEFAULT_LOCK_STALE_MS,
        timeoutLabel: "Cache write",
      },
    );
  } catch {
    // Best-effort cache only
  }
}

async function evictIfNeeded(dir: string): Promise<void> {
  try {
    const entries = await fs.readdir(dir);
    const stats = await Promise.all(
      entries.map(async (name) => {
        // Skip atomic-write temp files (.<basename>.<pid>.<uuid>.tmp)
        // so eviction cannot unlink a concurrent write's staging file
        // and cause its rename to fail (Greptile P2).
        // Also skip the inter-process write lockfile (cache-write.lock)
        // so eviction cannot delete the lock while a writer holds it (5.5).
        if ((name.startsWith(".") && name.endsWith(".tmp")) || name.endsWith(".lock"))
          return null;
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
 * Selectors narrowing a {@link pruneCaches} run. All are optional and
 * AND together. When `olderThanMs` is absent the effective TTL
 * (`getCacheTtlMs()`) is the age threshold (DESIGN D3); `provider` and
 * `capability` selectors match v2 filenames only (DESIGN D2) — legacy /
 * non-v2 entries are selectable by age only.
 */
export interface PruneSelectors {
  readonly olderThanMs?: number;
  readonly provider?: string;
  readonly capability?: string;
}

/**
 * Optional tuning for {@link pruneCaches}. Production callers pass no
 * options; the defaults mirror `writeCache`'s lock discipline. Tests use
 * a short `lockTimeoutMs` so the D5 timeout-rejection path is exercised
 * without waiting the production 30s.
 */
export interface PruneCachesOptions {
  /** Lock-acquire timeout for the response-dir scan (ms). Default `DEFAULT_LOCK_TIMEOUT_MS`. */
  readonly lockTimeoutMs?: number;
  /** Stale-lock threshold (ms). Default `DEFAULT_LOCK_STALE_MS`. */
  readonly lockStaleMs?: number;
}

/**
 * Outcome of a {@link pruneCaches} run. Counts reflect actual deletions;
 * per-entry failures are skipped best-effort like {@link clearSubdir}.
 */
export interface PruneCachesResult {
  readonly prunedResponses: number;
  readonly prunedTools: number;
  readonly bytesFreed: number;
}

/**
 * Prune expired entries from both caches (DESIGN D1–D6).
 *
 * Age is judged by the stored envelope timestamp, never mtime (D1):
 * response entries carry `ts`, tool entries carry `timestamp`. The
 * response scan runs inside the same `cache-write` inter-process lock
 * `writeCache` serializes on (D4), and a lock timeout THROWS rather than
 * being swallowed (D5) — prune is an explicit operator command, not a
 * best-effort cache write. The tool scan is lock-free (no write-lock
 * convention exists there) and selector-free (tool filenames are
 * unpartitioned); it applies the same age rule.
 *
 * A disabled cache does not stop a prune — deletion is not a cache
 * read/write (D6). But with NO explicit `olderThanMs`, a disabled cache
 * (TTL-0) means "no read freshness rule", so the prune is a zero-work
 * success reporting zeros. An explicit `--older-than` runs regardless.
 */
export async function pruneCaches(
  selectors: PruneSelectors,
  options: PruneCachesOptions = {},
): Promise<PruneCachesResult> {
  const thresholdMs = selectors.olderThanMs ?? getCacheTtlMs();
  if (selectors.olderThanMs === undefined && (!isCacheEnabled() || thresholdMs <= 0)) {
    return { prunedResponses: 0, prunedTools: 0, bytesFreed: 0 };
  }

  const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const lockStaleMs = options.lockStaleMs ?? DEFAULT_LOCK_STALE_MS;

  // Response dir: serialize with writers on the same identity so a prune
  // never races a concurrent evictIfNeeded sweep or atomic rename (D4).
  const responses = await withAsyncFileLock(
    responseCacheDir(),
    "cache-write",
    async () => pruneSubdirByAge(responseCacheDir(), thresholdMs, selectors),
    { timeoutMs: lockTimeoutMs, staleMs: lockStaleMs, timeoutLabel: "Cache prune" },
  );

  // Tool dir: same age rule, lock-free, no selectors (filenames are
  // unpartitioned — they encode the config hash, not provider/capability).
  const tools = await pruneSubdirByAge(toolCacheDir(), thresholdMs);

  return {
    prunedResponses: responses.pruned,
    prunedTools: tools.pruned,
    bytesFreed: responses.bytesFreed + tools.bytesFreed,
  };
}

/**
 * Age (ms) of a cache entry from its stored timestamp, or `null` when no
 * usable numeric age marker exists. Response entries use `ts` (DESIGN
 * D1); tool entries use the tool envelope's `timestamp` (mirroring
 * `readToolCache`). Entries without a readable marker are skipped by
 * prune — deletion is only attempted when the age is determinable.
 */
function entryAgeMs(raw: unknown): number | null {
  if (!raw || typeof raw !== "object") return null;
  const ts = (raw as { ts?: unknown }).ts;
  if (typeof ts === "number") return Date.now() - ts;
  const timestamp = (raw as { timestamp?: unknown }).timestamp;
  if (typeof timestamp === "number") return Date.now() - timestamp;
  return null;
}

/**
 * Best-effort per-entry prune of one cache subdirectory. Skips `.lock`
 * files and `.<name>.<pid>.<uuid>.tmp` staging files (mirrors
 * `evictIfNeeded`'s skip discipline); matches `provider`/`capability`
 * selectors against v2 filenames only (D2); deletes entries whose stored
 * age exceeds `thresholdMs`. Individual failures are skipped like
 * `clearSubdir`; counts reflect actual deletions.
 */
async function pruneSubdirByAge(
  dir: string,
  thresholdMs: number,
  selectors: { provider?: string; capability?: string } = {},
): Promise<{ pruned: number; bytesFreed: number }> {
  let pruned = 0;
  let bytesFreed = 0;
  try {
    const names = await fs.readdir(dir);
    for (const name of names) {
      // Skip atomic-write staging files and lockfiles (D4 skip discipline).
      if ((name.startsWith(".") && name.endsWith(".tmp")) || name.endsWith(".lock")) continue;
      // Filename-first selector matching (D2) — zero content reads.
      if (selectors.provider !== undefined || selectors.capability !== undefined) {
        const parsed = parseCacheFileName(name);
        // Non-v2 names are not selectable by provider/capability (D2);
        // they remain eligible under an age-only prune.
        if (!parsed) continue;
        if (selectors.provider !== undefined && parsed.provider !== selectors.provider) continue;
        if (selectors.capability !== undefined && parsed.capability !== selectors.capability) continue;
      }
      const p = path.join(dir, name);
      try {
        const s = await fs.stat(p);
        const ageMs = entryAgeMs(JSON.parse(await fs.readFile(p, "utf8")));
        if (ageMs === null || ageMs <= thresholdMs) continue;
        await fs.unlink(p);
        pruned += 1;
        bytesFreed += s.size;
      } catch {
        // Best-effort per entry, like clearSubdir.
      }
    }
  } catch {
    // dir doesn't exist yet
  }
  return { pruned, bytesFreed };
}

/**
 * Per-bucket cache inventory counts. Every breakdown bucket repeats
 * `{entries, totalBytes, live, expired}` (DESIGN D7).
 */
export interface CacheStatsBucket {
  readonly entries: number;
  readonly totalBytes: number;
  readonly live: number;
  readonly expired: number;
}

/**
 * Inventory both caches. The shape extends the v0.4.0 flat shape with
 * nested `responseCache` and `toolCache` sections (H3 fix). The
 * top-level `entries` and `totalBytes` fields are removed — callers
 * must read from the nested sections.
 *
 * Enrichment (DESIGN D7) is additive only: the response cache gains
 * `live`/`expired` counts and per-provider/per-capability breakdown
 * buckets (with a `legacy` bucket for non-v2 filenames); the tool
 * cache gains `live`/`expired` but has no `by*` keys (its filenames
 * are unpartitioned). Existing fields are byte-identical, so the
 * Doctor one-line summary (`formatDoctorCacheSummary`) is unaffected.
 */
export async function cacheStats(): Promise<{
  dir: string;
  enabled: boolean;
  ttlMs: number;
  sizeCapBytes: number;
  responseCache: CacheStatsBucket & {
    byProvider: Readonly<Record<string, CacheStatsBucket>>;
    byCapability: Readonly<Record<string, CacheStatsBucket>>;
  };
  toolCache: CacheStatsBucket;
}> {
  const dir = resolveCacheRoot();
  const responseDir = responseCacheDir();
  const toolDir = toolCacheDir();

  const [responseStats, toolStats] = await Promise.all([
    inventorySubdir(responseDir, true),
    inventorySubdir(toolDir),
  ]);

  return {
    dir,
    enabled: isCacheEnabled(),
    ttlMs: getCacheTtlMs(),
    sizeCapBytes: getCacheSizeCapBytes(),
    responseCache: {
      entries: responseStats.entries,
      totalBytes: responseStats.totalBytes,
      live: responseStats.live,
      expired: responseStats.expired,
      byProvider: responseStats.byProvider ?? {},
      byCapability: responseStats.byCapability ?? {},
    },
    toolCache: {
      entries: toolStats.entries,
      totalBytes: toolStats.totalBytes,
      live: toolStats.live,
      expired: toolStats.expired,
    },
  };
}

// ---------------------------------------------------------------------------
// Prune selection helpers (pure — no I/O, no env reads)
// ---------------------------------------------------------------------------

/**
 * Parse a `--older-than` duration into milliseconds (DESIGN D3).
 *
 * Accepted forms, mirroring `formatTtl`'s units in reverse:
 * `<N>h` (hours), `<N>m` (minutes), `<N>s` (seconds), and a bare
 * `<N>` interpreted as seconds. `N` must be a non-negative integer;
 * `0` is valid and means "prune everything".
 *
 * Returns `null` for any other input (unknown unit, missing number,
 * negative, fractional, empty). Callers translate `null` into a
 * `VALIDATION_ERROR` — this helper never throws.
 */
export function parsePruneDuration(spec: string): number | null {
  if (typeof spec !== "string") return null;
  const trimmed = spec.trim();
  if (trimmed === "") return null;

  const match = /^(\d+)([hms]?)$/.exec(trimmed);
  if (!match) return null;

  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount) || amount < 0) return null;

  switch (match[2]) {
    case "h":
      return amount * 60 * 60 * 1000;
    case "m":
      return amount * 60 * 1000;
    case "s":
      return amount * 1000;
    default:
      // Bare integer is seconds.
      return amount * 1000;
  }
}

/**
 * Capability/provider pair decoded from a v2 cache filename.
 */
export interface ParsedCacheFileName {
  readonly capability: string;
  readonly provider: string;
}

/**
 * Parse a provider-partitioned cache filename (DESIGN D2).
 *
 * v2 keys are `v2.<capability>.<provider>.<credential-hash>.<request-hash>.json`
 * (see {@link buildProviderCacheKey}), so selector matching is a pure
 * string operation with zero content reads.
 *
 * Returns `null` for every other shape — legacy (non-v2) entries,
 * `.tmp` staging files, `.lock` files, and malformed names. Those are
 * selectable by age only and bucket under `legacy` in stats.
 */
export function parseCacheFileName(name: string): ParsedCacheFileName | null {
  if (typeof name !== "string" || name === "") return null;
  if (!name.startsWith("v2.") || !name.endsWith(".json")) return null;

  const segments = name.split(".");
  // v2 | capability | provider | credential-hash | request-hash | json
  if (segments.length !== 6) return null;

  const capability = segments[1];
  const provider = segments[2];
  if (!capability || !provider) return null;
  if (!segments[3] || !segments[4]) return null;

  return { capability, provider };
}

async function inventorySubdir(
  dir: string,
  breakdown?: boolean,
): Promise<
  CacheStatsBucket & {
    byProvider?: Record<string, CacheStatsBucket>;
    byCapability?: Record<string, CacheStatsBucket>;
  }
> {
  let entries = 0;
  let totalBytes = 0;
  let live = 0;
  let expired = 0;
  const byProvider: Record<string, CacheStatsBucket> = {};
  const byCapability: Record<string, CacheStatsBucket> = {};
  try {
    const names = await fs.readdir(dir);
    // Live-vs-expired uses the same freshness boundary as prune (DESIGN
    // D3): an entry is expired when its stored age exceeds the TTL. Reading
    // every entry is the D8 cost note — stats is an explicit invocation.
    const ttlMs = getCacheTtlMs();
    for (const name of names) {
      const p = path.join(dir, name);
      try {
        const s = await fs.stat(p);
        entries += 1;
        totalBytes += s.size;
        let isExpired = false;
        try {
          const ageMs = entryAgeMs(JSON.parse(await fs.readFile(p, "utf8")));
          isExpired = ageMs !== null && ageMs > ttlMs;
        } catch {
          // Unreadable / unparseable: age unknown, not proven expired → live.
        }
        if (isExpired) expired += 1;
        else live += 1;

        if (breakdown) {
          const parsed = parseCacheFileName(name);
          const providerKey = parsed ? parsed.provider : "legacy";
          const capabilityKey = parsed ? parsed.capability : "legacy";
          addToBucket(byProvider, providerKey, s.size, isExpired);
          addToBucket(byCapability, capabilityKey, s.size, isExpired);
        }
      } catch {
        // skip unstat-able entries, like the pre-enrichment inventory
      }
    }
  } catch {
    // dir doesn't exist yet
  }
  const result: CacheStatsBucket & {
    byProvider?: Record<string, CacheStatsBucket>;
    byCapability?: Record<string, CacheStatsBucket>;
  } = { entries, totalBytes, live, expired };
  if (breakdown) {
    result.byProvider = byProvider;
    result.byCapability = byCapability;
  }
  return result;
}

/** Accumulate one entry into a per-key breakdown bucket (DESIGN D7). */
function addToBucket(
  buckets: Record<string, CacheStatsBucket>,
  key: string,
  sizeBytes: number,
  isExpired: boolean,
): void {
  const existing = buckets[key];
  buckets[key] = existing
    ? {
        entries: existing.entries + 1,
        totalBytes: existing.totalBytes + sizeBytes,
        live: existing.live + (isExpired ? 0 : 1),
        expired: existing.expired + (isExpired ? 1 : 0),
      }
    : {
        entries: 1,
        totalBytes: sizeBytes,
        live: isExpired ? 0 : 1,
        expired: isExpired ? 1 : 0,
      };
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
  get<T>(key: string, decoder: (raw: unknown) => T): Promise<T | null>;
  get(key: string): Promise<unknown | null>;
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
  get(key: string, decoder?: (raw: unknown) => unknown): Promise<unknown | null> {
    return decoder ? readCache(key, decoder) : readCache(key);
  },
  set<T>(key: string, value: T): Promise<void> {
    return writeCache<T>(key, value);
  },
};
