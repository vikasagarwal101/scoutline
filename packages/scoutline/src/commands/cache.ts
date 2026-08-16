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

/**
 * Mirror of {@link PruneCachesResult} in `src/lib/cache.ts`. Counts
 * reflect actual deletions performed during the prune run.
 */
export interface CachePruneReport {
  readonly prunedResponses: number;
  readonly prunedTools: number;
  readonly bytesFreed: number;
}

/**
 * Selectors narrowing a prune run. All optional and AND together;
 * mirrors {@link PruneSelectors} from `src/lib/cache.ts` (DESIGN D2/D3).
 * The dispatcher parses `--older-than`/`--provider`/`--capability` into
 * this shape and passes it to the production `pruneCaches`.
 */
export interface CachePruneSelectors {
  readonly olderThanMs?: number;
  readonly provider?: string;
  readonly capability?: string;
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
 * Format a prune result as a one-line TTY notice. Same voice as
 * {@link formatCacheClear} (cleared vs pruned is the only swap).
 */
export function formatCachePrune(result: CachePruneReport): string {
  return (
    `Pruned ${result.prunedResponses} response ${pluralEntry(result.prunedResponses)} ` +
    `and ${result.prunedTools} tool ${pluralEntry(result.prunedTools)} ` +
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

export interface CachePruneDependencies {
  readonly prune: (selectors: CachePruneSelectors) => Promise<CachePruneReport>;
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

/** All text modes share the same one-line prune notice. */
function prunePresentations(result: CachePruneReport): Partial<Record<TextOutputMode, string>> {
  const text = formatCachePrune(result);
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

/**
 * Run the `cache prune` subcommand. Returns the count of pruned
 * entries and bytes freed as base data with a TTY presentation
 * override. Selectors are passed through to `deps.prune` verbatim
 * (the dispatcher parses `--older-than`/`--provider`/`--capability`
 * into this shape). Lock-timeout errors propagate so the
 * dispatcher's error boundary emits the sanitized stderr envelope
 * (DESIGN D5).
 */
export async function cachePruneCommand(
  deps: CachePruneDependencies,
  selectors: CachePruneSelectors,
): Promise<CommandResult<CachePruneReport>> {
  const result = await deps.prune(selectors);
  return {
    kind: "data",
    data: result,
    presentations: prunePresentations(result),
  };
}

export const CACHE_HELP = `
Cache - Inspect, clear, or prune the local cache

Usage:
  scoutline cache stats                       # show inventory of both cache subdirectories
  scoutline cache clear                       # delete every file in both cache subdirectories
  scoutline cache prune [--older-than <D>] [--provider <id>] [--capability <id>]

Subcommands:
  stats   Print the cache directory, status (enabled/disabled, TTL, size
          cap), and per-subdirectory entry count and total size for both
          the response cache (~/.scoutline/cache/) and the tool cache
          (~/.scoutline/tools/).
  clear   Delete every file under <root>/cache/ and <root>/tools/. The
          directories themselves are preserved so the next invocation
          recreates entries without a directory-creation race. The
          orphaned legacy ~/.cache/zai-cli/ directory is never touched.
  prune   Delete expired entries from both caches by stored timestamp
          (DESIGN D1: ts, never mtime). Without flags, prune uses the
          effective TTL; with --older-than, that duration replaces the
          TTL. --provider and --capability narrow the response-cache
          scan to v2 filenames only (DESIGN D2: legacy files are
          age-selected, never selector-selected). --provider may appear
          before or after the command token. Unknown
          --provider/--capability values are NOT pre-validated — they
          filename-match nothing in the response cache, while the
          selector-free tool scan still prunes expired tool entries
          (tool filenames are unpartitioned; DESIGN D4).

Duration syntax for --older-than (DESIGN D3): 24h, 90m, 30s, or a bare
integer (seconds). Example: --older-than 1h prunes anything older than
the effective TTL even when TTL is 24h.

The cache root defaults to ~/.scoutline/ on every platform; override it
with SCOUTLINE_CACHE_DIR (ZAI_MCP_CACHE_DIR and ZAI_CACHE_DIR are
accepted as lower-precedence legacy aliases). Disable both caches with
SCOUTLINE_CACHE=0 (legacy alias: ZAI_CACHE=0). A disabled cache does
NOT short-circuit prune: deletion is not a cache read/write (D6). With
no --older-than under a disabled cache, prune reports zeros (TTL of 0
means "no freshness rule", not "delete everything").

Exit codes:
  0  Success.
  1  Validation error (bad or valueless --older-than / --provider /
     --capability, unknown subcommand) or I/O error including a
     cache-write lock timeout (DESIGN D5: the prune scan serializes on
     the response-dir lock a concurrent write holds; a lock-acquire
     timeout throws and is reported as a sanitized FILE_ERROR JSON
     error envelope).

Examples:
  scoutline cache stats
  scoutline cache clear
  scoutline cache prune
  scoutline cache prune --older-than 1h
  scoutline cache prune --older-than 24h --provider zai --capability search
  scoutline cache --help
`.trim();
