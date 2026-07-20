/**
 * Cache command — local cache inspection and clearing
 * (Cache Module Unification Ticket 03).
 *
 * The command is presentation-only: it receives already-resolved stats
 * or clear results through injected dependencies and wraps them with a
 * TTY presentation override. Directory resolution, env-var policy, and
 * on-disk I/O live in `src/lib/cache.ts` (Ticket 01). The dispatcher
 * (`src/index.ts`) wires production to the real `cacheStats()` and
 * `clearAllCaches()` and threads them through these dependencies; tests
 * inject doubles.
 *
 * Output format (core-flows artifact):
 *
 * ```text
 * Cache directory: ~/.scoutline/
 * Status: enabled (TTL 24h, cap 100MB)
 *
 * Response cache:
 *   Entries: 47
 *   Size: 12.3 MB
 *
 * Tool cache:
 *   Entries: 1
 *   Size: 8.2 KB
 * ```
 *
 * L1 fix: Doctor's one-line cache summary is computed from the same
 * `cacheStats()` shape but formatted by the dispatcher, not by this
 * module. See `formatDoctorCacheSummary`.
 */

import type { CommandResult, TextOutputMode } from "../command-invocation.js";

// ---------------------------------------------------------------------------
// Report shapes — mirror the return types of cacheStats() / clearAllCaches()
// in src/lib/cache.ts. Re-declared here (not imported) so the command
// module's contract is independent of the lib module's exact return-type
// spelling. The lib's runtime values are structurally compatible.
// ---------------------------------------------------------------------------

export interface CacheStatsReport {
  readonly dir: string;
  readonly enabled: boolean;
  readonly ttlMs: number;
  readonly sizeCapBytes: number;
  readonly responseCache: { readonly entries: number; readonly totalBytes: number };
  readonly toolCache: { readonly entries: number; readonly totalBytes: number };
}

export interface CacheClearReport {
  readonly responsesCleared: number;
  readonly toolsCleared: number;
  readonly bytesFreed: number;
}

// ---------------------------------------------------------------------------
// Pure formatting helpers
// ---------------------------------------------------------------------------

/**
 * Format a byte count as e.g. `"12.3 MB"`, `"8.2 KB"`, `"510 B"`. Used
 * by `cache stats` presentation and by Doctor's one-line summary. Pure:
 * no I/O, no env reads.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"] as const;
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

/**
 * Format a TTL in ms as `"24h"`, `"30m"`, or `"60s"`. Chooses the
 * largest whole-unit that divides the input evenly so the default
 * 24h renders as `24h` rather than `86400000ms`.
 */
export function formatTtl(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${Math.round(ms / 1000)}s`;
}

/**
 * Format the size cap (bytes) as e.g. `"100MB"`. Mirrors the
 * `SCOUTLINE_CACHE_SIZE_MB` env-var spelling so the operator surface
 * matches the documentation.
 */
function formatSizeCap(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))}MB`;
}

/**
 * Pluralize "entry"/"entries" for a count.
 */
function pluralEntry(count: number): string {
  return count === 1 ? "entry" : "entries";
}

/**
 * Format the inventory of both caches as a multi-line TTY block per
 * the core-flows artifact. Used as the TTY/compact/markdown/refs
 * presentation for `cache stats`. Pure.
 */
export function formatCacheStats(stats: CacheStatsReport): string {
  const lines: string[] = [];
  lines.push(`Cache directory: ${stats.dir}`);
  if (stats.enabled) {
    lines.push(
      `Status: enabled (TTL ${formatTtl(stats.ttlMs)}, cap ${formatSizeCap(stats.sizeCapBytes)})`,
    );
  } else {
    lines.push(`Status: disabled`);
  }
  lines.push("");
  lines.push("Response cache:");
  lines.push(`  Entries: ${stats.responseCache.entries}`);
  lines.push(`  Size: ${formatBytes(stats.responseCache.totalBytes)}`);
  lines.push("");
  lines.push("Tool cache:");
  lines.push(`  Entries: ${stats.toolCache.entries}`);
  lines.push(`  Size: ${formatBytes(stats.toolCache.totalBytes)}`);
  return lines.join("\n");
}

/**
 * Format a clear result as a one-line TTY notice.
 */
export function formatCacheClear(result: CacheClearReport): string {
  return (
    `Cleared ${result.responsesCleared} response ${pluralEntry(result.responsesCleared)} ` +
    `and ${result.toolsCleared} tool ${pluralEntry(result.toolsCleared)} ` +
    `(${formatBytes(result.bytesFreed)} freed)`
  );
}

/**
 * Format the one-line Doctor cache summary from a `cacheStats()` value.
 * The dispatcher calls this before invoking `buildDiagnosticsReport`;
 * the report builder embeds the result verbatim. Examples:
 *
 * ```text
 * Cache: enabled, 47 response entries (12.3 MB), 1 tool entry (8.2 KB), ~/.scoutline/
 * Cache: disabled
 * ```
 *
 * Pure: never reads env or touches the filesystem.
 */
export function formatDoctorCacheSummary(stats: CacheStatsReport): string {
  if (!stats.enabled) return "Cache: disabled";
  return (
    `Cache: enabled, ${stats.responseCache.entries} response ${pluralEntry(stats.responseCache.entries)} ` +
    `(${formatBytes(stats.responseCache.totalBytes)}), ${stats.toolCache.entries} tool ${pluralEntry(stats.toolCache.entries)} ` +
    `(${formatBytes(stats.toolCache.totalBytes)}), ${stats.dir}`
  );
}

// ---------------------------------------------------------------------------
// Command dependencies (injectable for tests)
// ---------------------------------------------------------------------------

export interface CacheStatsDependencies {
  readonly getStats: () => Promise<CacheStatsReport>;
}

export interface CacheClearDependencies {
  readonly clear: () => Promise<CacheClearReport>;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** All text modes share the same multi-line inventory rendering. */
function statsPresentations(stats: CacheStatsReport): Partial<Record<TextOutputMode, string>> {
  const text = formatCacheStats(stats);
  return { compact: text, markdown: text, refs: text, tty: text };
}

/** All text modes share the same one-line clear notice. */
function clearPresentations(result: CacheClearReport): Partial<Record<TextOutputMode, string>> {
  const text = formatCacheClear(result);
  return { compact: text, markdown: text, refs: text, tty: text };
}

/**
 * Run the `cache stats` subcommand. Returns the inventory as base data
 * with a TTY presentation override. Exit code is always 0 on success;
 * I/O failures propagate as ordinary errors through the dispatcher.
 */
export async function cacheStatsCommand(
  deps: CacheStatsDependencies,
): Promise<CommandResult<CacheStatsReport>> {
  const stats = await deps.getStats();
  return {
    kind: "data",
    data: stats,
    presentations: statsPresentations(stats),
  };
}

/**
 * Run the `cache clear` subcommand. Returns the count of cleared
 * entries and bytes freed as base data with a TTY presentation
 * override.
 */
export async function cacheClearCommand(
  deps: CacheClearDependencies,
): Promise<CommandResult<CacheClearReport>> {
  const result = await deps.clear();
  return {
    kind: "data",
    data: result,
    presentations: clearPresentations(result),
  };
}

export const CACHE_HELP = `
Cache - Inspect and clear the local cache

Usage:
  scoutline cache stats   # show inventory of both cache subdirectories
  scoutline cache clear   # delete every file in both cache subdirectories

Subcommands:
  stats   Print the cache directory, status (enabled/disabled, TTL, size
          cap), and per-subdirectory entry count and total size for both
          the response cache (~/.scoutline/cache/) and the tool cache
          (~/.scoutline/tools/).
  clear   Delete every file under <root>/cache/ and <root>/tools/. The
          directories themselves are preserved so the next invocation
          recreates entries without a directory-creation race. The
          orphaned legacy ~/.cache/zai-cli/ directory is never touched.

The cache root defaults to ~/.scoutline/ on every platform; override it
with SCOUTLINE_CACHE_DIR (ZAI_MCP_CACHE_DIR and ZAI_CACHE_DIR are
accepted as lower-precedence legacy aliases). Disable both caches with
SCOUTLINE_CACHE=0 (legacy alias: ZAI_CACHE=0).

Exit codes:
  0  Success.
  1  I/O error (reported as a sanitized JSON error envelope).

Examples:
  scoutline cache stats
  scoutline cache clear
  scoutline cache --help
`.trim();
