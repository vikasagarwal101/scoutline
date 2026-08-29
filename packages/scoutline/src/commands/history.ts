/**
 * history command — read-only inventory over the saved-artifact store
 * (save-artifacts plan, Ticket 5).
 *
 * Three subcommands over `<artifacts>/index.json` and the master reports
 * it references:
 *
 *   - `history list [--since N] [--limit N] [--command C]` — newest
 *     first, from the LOG ONLY (a master file with no log entry is an
 *     orphan and invisible, DESIGN D5).
 *   - `history show <requestId>` — the join: the log entry plus the
 *     master report content, keyed by requestId. Unknown id and a live
 *     entry whose master vanished are FILE_ERROR (D7/D8).
 *   - `history stats` — counts by command / artifactFormat / kind,
 *     summed master bytes, and the oldest/newest span.
 *
 * Like `usage` (DESIGN D8), this module is presentation + aggregation
 * only: I/O happens through injectable readers so every path is
 * hermetically testable, and reads are fail-open — a missing store is
 * the normal empty case, a corrupt log degrades to empty plus a notice.
 * The command is credential-free (no Provider resolution, no Adapter,
 * no transport) and dispatched before the credentialed config load.
 */

import type { CommandResult, TextOutputMode } from "../command-invocation.js";
import { FileError } from "../lib/errors.js";
import type { ArtifactsLog, SaveLogEntry } from "../lib/artifacts.js";

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Report shapes
// ---------------------------------------------------------------------------

/** One list row: the inventory view of a log entry. */
export interface HistoryEntrySummary {
  readonly requestId: string;
  readonly timestamp: number;
  readonly command: string;
  readonly provider: SaveLogEntry["provider"];
  readonly artifactFormat: SaveLogEntry["artifactFormat"];
  readonly kind: SaveLogEntry["kind"];
  readonly exportPath?: string;
}

/** `history list` data-mode envelope. */
export interface HistoryListReport {
  readonly schemaVersion: 1;
  readonly generatedAt: number;
  /** Matches after filtering, before --limit slicing. */
  readonly total: number;
  readonly entries: readonly HistoryEntrySummary[];
}

/** `history show` data-mode envelope: the join by requestId. */
export interface HistoryShowReport {
  readonly schemaVersion: 1;
  readonly entry: SaveLogEntry;
  /** Parsed report envelope for json masters; `{ markdown }` for md masters. */
  readonly report: unknown;
}

/** `history stats` data-mode envelope. */
export interface HistoryStatsReport {
  readonly schemaVersion: 1;
  readonly generatedAt: number;
  readonly total: number;
  readonly byCommand: Readonly<Record<string, number>>;
  readonly byArtifactFormat: Readonly<Record<string, number>>;
  readonly byKind: Readonly<Record<string, number>>;
  /** Sum of on-disk master sizes over logged entries (missing files add 0). */
  readonly masterBytes: number;
  readonly oldest?: number;
  readonly newest?: number;
}

// ---------------------------------------------------------------------------
// Pure aggregation
// ---------------------------------------------------------------------------

export interface HistoryListOptions {
  readonly sinceDays?: number;
  readonly limit?: number;
  readonly command?: string;
  readonly now: () => number;
}

/** List-row projection of a log entry (the inventory field set, pinned by tests). */
function toSummary(entry: SaveLogEntry): HistoryEntrySummary {
  return {
    requestId: entry.requestId,
    timestamp: entry.timestamp,
    command: entry.command,
    provider: entry.provider,
    artifactFormat: entry.artifactFormat,
    kind: entry.kind,
    ...(entry.exportPath !== undefined ? { exportPath: entry.exportPath } : {}),
  };
}

/** UTC-midnight floor of an instant — the `usage --days` window unit (whole days, today inclusive). */
function utcDayFloor(ms: number): number {
  const day = new Date(ms);
  day.setUTCHours(0, 0, 0, 0);
  return day.getTime();
}

/**
 * Fold the log into the list report: optional `--command` filter, a
 * `--since N` UTC-day window inclusive of today (the `usage --days`
 * semantics: the window's lower edge is UTC midnight `N-1` whole days
 * back, so every entry of today and the previous `N-1` days is kept —
 * a rolling `now - N*DAY` cutoff would silently drop same-day entries
 * and make `--since 1` effectively empty; cold-review round 1
 * finding 2), newest-first ordering (timestamp desc, requestId desc on
 * ties), then `--limit` slicing. `total` counts post-filter, pre-slice.
 * Pure.
 */
export function buildHistoryListReport(log: ArtifactsLog, options: HistoryListOptions): HistoryListReport {
  const cutoff =
    options.sinceDays !== undefined
      ? utcDayFloor(options.now()) - (options.sinceDays - 1) * DAY_MS
      : undefined;
  const kept = log.entries.filter((entry) => {
    if (options.command !== undefined && entry.command !== options.command) return false;
    if (cutoff !== undefined && entry.timestamp < cutoff) return false;
    return true;
  });
  const ordered = [...kept].sort((a, b) =>
    b.timestamp - a.timestamp || (a.requestId < b.requestId ? 1 : a.requestId > b.requestId ? -1 : 0),
  );
  const sliced = options.limit !== undefined ? ordered.slice(0, options.limit) : ordered;
  return {
    schemaVersion: 1,
    generatedAt: options.now(),
    total: kept.length,
    entries: sliced.map(toSummary),
  };
}

/** Master-content reader: returns the file text, or undefined when missing. */
export type ReadMaster = (entry: SaveLogEntry) => Promise<string | undefined>;

/**
 * The join: find the entry by requestId, read its master, and surface
 * `{ entry, report }`. Unknown ids are FILE_ERROR; a live entry whose
 * master is gone is FILE_ERROR naming the master path; a corrupt json
 * master is FILE_ERROR rather than a crash. Markdown masters surface as
 * `{ markdown }` (they are not JSON).
 */
export async function buildHistoryShowReport(
  log: ArtifactsLog,
  requestId: string,
  readMaster: ReadMaster,
): Promise<HistoryShowReport> {
  const entry = log.entries.find((candidate) => candidate.requestId === requestId);
  if (entry === undefined) {
    throw new FileError(
      `no artifact with requestId "${requestId}"`,
      "Run history list to see saved request ids.",
    );
  }
  const text = await readMaster(entry);
  if (text === undefined) {
    throw new FileError(
      `artifact master is missing: ${entry.masterPath}`,
      "The log entry exists but its report file was moved or deleted.",
    );
  }
  let report: unknown;
  if (entry.artifactFormat === "markdown") {
    report = { markdown: text };
  } else {
    try {
      report = JSON.parse(text);
    } catch {
      throw new FileError(
        `artifact master is corrupt (invalid JSON): ${entry.masterPath}`,
        "The saved report could not be parsed; re-run the command to save a fresh artifact.",
      );
    }
  }
  return { schemaVersion: 1, entry, report };
}

/** Master-size reader (bytes); missing files should resolve 0, not throw. */
export type MasterSizeOf = (entry: SaveLogEntry) => Promise<number>;

/** Aggregate counts, summed master bytes, and the timestamp span. Pure except the size reader. */
export async function buildHistoryStatsReport(
  log: ArtifactsLog,
  masterSizeOf: MasterSizeOf,
  now: () => number,
): Promise<HistoryStatsReport> {
  const byCommand: Record<string, number> = {};
  const byArtifactFormat: Record<string, number> = {};
  const byKind: Record<string, number> = {};
  let masterBytes = 0;
  let oldest: number | undefined;
  let newest: number | undefined;
  for (const entry of log.entries) {
    byCommand[entry.command] = (byCommand[entry.command] ?? 0) + 1;
    byArtifactFormat[entry.artifactFormat] = (byArtifactFormat[entry.artifactFormat] ?? 0) + 1;
    byKind[entry.kind] = (byKind[entry.kind] ?? 0) + 1;
    masterBytes += await masterSizeOf(entry);
    if (oldest === undefined || entry.timestamp < oldest) oldest = entry.timestamp;
    if (newest === undefined || entry.timestamp > newest) newest = entry.timestamp;
  }
  const total = log.entries.length;
  return {
    schemaVersion: 1,
    generatedAt: now(),
    total,
    byCommand,
    byArtifactFormat,
    byKind,
    masterBytes,
    ...(oldest !== undefined ? { oldest } : {}),
    ...(newest !== undefined ? { newest } : {}),
  };
}

// ---------------------------------------------------------------------------
// Presentations (all text modes share one fixed-order rendering)
// ---------------------------------------------------------------------------

function formatTimestamp(ms: number): string {
  return new Date(ms).toISOString();
}

function formatHistoryList(report: HistoryListReport): string {
  const lines = [
    `history: ${report.entries.length} of ${report.total} saved artifact(s)`,
    "requestId             saved (UTC)           command   format    provider",
  ];
  for (const row of report.entries) {
    const provider =
      row.provider.mode === "fanout" ? `fanout(${row.provider.arms.join("+")})` : row.provider.effective;
    lines.push(
      [
        row.requestId.padEnd(21),
        formatTimestamp(row.timestamp).padEnd(21),
        row.command.padEnd(10),
        row.artifactFormat.padEnd(10),
        provider,
      ].join(""),
    );
  }
  return lines.join("\n");
}

function formatHistoryStats(report: HistoryStatsReport): string {
  const lines = [
    `history stats: ${report.total} saved artifact(s), ${report.masterBytes} byte(s) of masters`,
    `commands: ${Object.entries(report.byCommand).map(([k, v]) => `${k}=${v}`).join(" ") || "(none)"}`,
    `formats: ${Object.entries(report.byArtifactFormat).map(([k, v]) => `${k}=${v}`).join(" ") || "(none)"}`,
    `kinds: ${Object.entries(report.byKind).map(([k, v]) => `${k}=${v}`).join(" ") || "(none)"}`,
  ];
  if (report.oldest !== undefined && report.newest !== undefined) {
    lines.push(`span: ${formatTimestamp(report.oldest)} → ${formatTimestamp(report.newest)}`);
  }
  return lines.join("\n");
}

function historyPresentations(
  report: HistoryListReport | HistoryShowReport | HistoryStatsReport,
): Partial<Record<TextOutputMode, string>> {
  const text =
    "entries" in report
      ? formatHistoryList(report)
      : "total" in report
        ? formatHistoryStats(report)
        : JSON.stringify({ entry: report.entry, report: report.report }, null, 2);
  return { compact: text, markdown: text, refs: text, tty: text };
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export interface HistoryCommandDependencies {
  readonly subcommand: "list" | "show" | "stats";
  readonly readLog: () => Promise<{ log: ArtifactsLog; notice?: string }>;
  readonly readMaster: ReadMaster;
  readonly masterSizeOf: MasterSizeOf;
  readonly notice: (message: string) => void;
  readonly now: () => number;
  readonly sinceDays?: number;
  readonly limit?: number;
  readonly command?: string;
  readonly requestId?: string;
}

/**
 * Run one `history` subcommand: fail-open log read (a read notice is
 * flushed through the invocation seam's stderr channel), then the pure
 * aggregation above, returned as base data with the shared text-mode
 * presentation. Exit 0; the FILE_ERROR paths throw and ride the seam's
 * existing error boundary.
 */
export async function historyCommand(deps: HistoryCommandDependencies): Promise<CommandResult> {
  const { log, notice } = await deps.readLog();
  if (notice !== undefined) deps.notice(notice);
  if (deps.subcommand === "list") {
    const report = buildHistoryListReport(log, {
      ...(deps.sinceDays !== undefined ? { sinceDays: deps.sinceDays } : {}),
      ...(deps.limit !== undefined ? { limit: deps.limit } : {}),
      ...(deps.command !== undefined ? { command: deps.command } : {}),
      now: deps.now,
    });
    return { kind: "data", data: report, presentations: historyPresentations(report) };
  }
  if (deps.subcommand === "stats") {
    const report = await buildHistoryStatsReport(log, deps.masterSizeOf, deps.now);
    return { kind: "data", data: report, presentations: historyPresentations(report) };
  }
  const report = await buildHistoryShowReport(
    log,
    deps.requestId ?? "",
    deps.readMaster,
  );
  return { kind: "data", data: report, presentations: historyPresentations(report) };
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

export const HISTORY_HELP = `History - Read-only inventory of saved --save artifacts

Usage:
  scoutline history list [--since N] [--limit N] [--command <name>]
  scoutline history show <requestId>
  scoutline history stats

Reads the artifact store (default ~/.scoutline/artifacts/, override with
SCOUTLINE_ARTIFACTS_DIR) without touching Providers, credentials, or the
response cache. The listing comes from the metadata log only; a report
file without a log entry is invisible. Reads fail open: a missing store
is an empty listing (exit 0); a corrupt log is ignored with a stderr
notice.

Options:
  list    Saved runs, newest first. --since N keeps the last N UTC days
          (today inclusive); --limit N slices the newest N; --command
          filters by command name.
  show    One saved run: the metadata record joined with the report
          content by requestId.
  stats   Counts by command, artifact format, and entry kind, plus the
          total master bytes and oldest/newest span.

Exit codes:
  0  Success (including the empty fail-open cases)
  1  Unknown requestId or missing master (FILE_ERROR); invalid flags
     (VALIDATION_ERROR)

Examples:
  scoutline search "rust vs go" --save report.json
  scoutline history list --limit 5
  scoutline history show 20260829T142233Z-7f3a
  scoutline history stats
`;
