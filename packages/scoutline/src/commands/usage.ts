/**
 * Usage command — local usage-ledger reporting (usage-ledger plan,
 * Ticket 5).
 *
 * The command is presentation + aggregation only: it receives an
 * already-read {@link UsageLedger} through its dependency and folds it
 * into the DESIGN D8 report envelope. Ledger reading (path resolution
 * against the config root, fail-open parse) is owned by the dispatcher
 * (`src/index.ts` `handleUsage`), which follows `handleCache`'s
 * injection-free posture — no injected reader object; tests inject
 * `env.SCOUTLINE_CONFIG_DIR` at a prepared directory and the production
 * `readUsageLedger(...)` (default deps: real reader, no `onWarning`)
 * preserves D8's silent-on-corrupt contract.
 *
 * Output shapes (DESIGN D8):
 *
 *   - data mode: the raw envelope JSON (`schemaVersion`, `windowDays`,
 *     `generatedAt`, `unitNote`, `providers[]` with per-provider
 *     `totals` and ascending `capabilities[]`).
 *   - tty/compact/markdown/refs: a fixed-order table of the same data.
 *
 * Missing or corrupt ledgers surface as an empty window with exit 0 —
 * never a throw, never stderr noise (the fail-open read already
 * normalized the failure away before this module sees a ledger).
 */

import type { CommandResult, TextOutputMode } from "../command-invocation.js";
import type { UsageCounters, UsageLedger } from "../lib/usage-ledger.js";
import { isCanonicalUsageDayKey, usageDayKey } from "../lib/usage-ledger.js";

/** One D8 envelope's unit note — also rendered as the table's caption. */
export const USAGE_UNIT_NOTE =
  "counts are billable call attempts; providers do not report credit costs";

/** Default reporting window in days (DESIGN D8). */
export const DEFAULT_USAGE_WINDOW_DAYS = 7;

/**
 * Maximum reporting window in days. Generous far beyond the 90-day
 * retention horizon (any larger window shows exactly the retained
 * history), while staying orders of magnitude below the ~±100,000,000
 * day range JavaScript Dates can represent — an unvalidated `--days
 * 1000000000` would otherwise pass the integer/≥1 checks and throw a
 * RangeError computing the cutoff date.
 */
export const MAX_USAGE_WINDOW_DAYS = 100000;

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Report shapes (DESIGN D8 envelope)
// ---------------------------------------------------------------------------

/** One capability row: the emitted `capabilityId` verbatim + its counters. */
export interface UsageCapabilitySummary {
  readonly capabilityId: string;
  readonly counters: UsageCounters;
}

/** One provider row: window totals plus per-capability rows (id asc). */
export interface UsageProviderSummary {
  readonly provider: string;
  readonly totals: UsageCounters;
  readonly capabilities: readonly UsageCapabilitySummary[];
}

/** The D8 data-mode envelope. */
export interface UsageReport {
  readonly schemaVersion: 1;
  readonly windowDays: number;
  readonly generatedAt: number;
  readonly unitNote: string;
  readonly providers: readonly UsageProviderSummary[];
}

// ---------------------------------------------------------------------------
// Pure aggregation
// ---------------------------------------------------------------------------

export interface UsageReportOptions {
  /** Window size in UTC days (dispatcher already validated ≥ 1). */
  readonly windowDays: number;
  /** Clock for `generatedAt` and the window's upper-edge day key. */
  readonly now: () => number;
  /** Optional provider filter (dispatcher already validated known ids). */
  readonly provider?: string;
}

/**
 * Fold a ledger into the D8 report: keep day keys within the last
 * `windowDays` UTC days (today's key inclusive; the key exactly
 * `windowDays - 1` days back is the oldest kept), optionally keep one
 * provider only, sum every counter axis across days and capabilities,
 * and emit providers ascending / capabilities ascending. Pure: no I/O,
 * never mutates the input ledger.
 */
export function buildUsageReport(ledger: UsageLedger, options: UsageReportOptions): UsageReport {
  const nowMs = options.now();
  const cutoffKey = usageDayKey(nowMs - (options.windowDays - 1) * DAY_MS);

  const providers = new Map<string, Map<string, UsageCounters>>();
  for (const [dayKey, dayProviders] of Object.entries(ledger.days)) {
    // Data-integrity guard (review P2): a malformed day key must never
    // be aggregated through the lexicographic bound — any non-date
    // string sorts above the cutoff and would be counted as current
    // usage. Non-canonical keys are skipped, not summed.
    if (!isCanonicalUsageDayKey(dayKey)) continue;
    // Lower bound only: a future-dated day key (clock skew on the
    // writer) is still "within the window" rather than dropped — the
    // window is defined by age, not a two-sided range.
    if (dayKey < cutoffKey) continue;
    for (const [providerId, capabilities] of Object.entries(dayProviders)) {
      if (options.provider !== undefined && providerId !== options.provider) continue;
      const rows = providers.get(providerId) ?? new Map<string, UsageCounters>();
      for (const [capabilityId, counters] of Object.entries(capabilities)) {
        rows.set(capabilityId, sumCounters(rows.get(capabilityId) ?? zeroCounters(), counters));
      }
      providers.set(providerId, rows);
    }
  }

  const providerRows: UsageProviderSummary[] = [...providers.entries()]
    .sort(([a], [b]) => compareAscending(a, b))
    .map(([provider, capabilities]) => {
      const capabilityRows: UsageCapabilitySummary[] = [...capabilities.entries()]
        .sort(([a], [b]) => compareAscending(a, b))
        .map(([capabilityId, counters]) => ({ capabilityId, counters }));
      let totals = zeroCounters();
      for (const row of capabilityRows) totals = sumCounters(totals, row.counters);
      return { provider, totals, capabilities: capabilityRows };
    });

  return {
    schemaVersion: 1,
    windowDays: options.windowDays,
    generatedAt: nowMs,
    unitNote: USAGE_UNIT_NOTE,
    providers: providerRows,
  };
}

function zeroCounters(): UsageCounters {
  return { attempts: 0, firstTries: 0, exactUnits: 0, estimateUnits: 0, unknownCount: 0 };
}

function sumCounters(a: UsageCounters, b: UsageCounters): UsageCounters {
  return {
    attempts: a.attempts + b.attempts,
    firstTries: a.firstTries + b.firstTries,
    exactUnits: a.exactUnits + b.exactUnits,
    estimateUnits: a.estimateUnits + b.estimateUnits,
    unknownCount: a.unknownCount + b.unknownCount,
  };
}

function compareAscending(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------------------
// tty presentation — a fixed-order table of the same data
// ---------------------------------------------------------------------------

/** One fixed table column: header, width, and alignment. */
interface UsageTableColumn {
  readonly header: string;
  readonly width: number;
  readonly align: "left" | "right";
}

const TABLE_COLUMNS: readonly UsageTableColumn[] = [
  { header: "provider", width: 10, align: "left" },
  { header: "capability", width: 24, align: "left" },
  { header: "attempts", width: 9, align: "right" },
  { header: "first-tries", width: 12, align: "right" },
  { header: "est-units", width: 10, align: "right" },
  { header: "exact-units", width: 12, align: "right" },
  { header: "unknown", width: 8, align: "right" },
];

function renderRow(cells: readonly string[]): string {
  return TABLE_COLUMNS.map((column, index) => {
    const cell = cells[index] ?? "";
    return column.align === "right" ? cell.padStart(column.width) : cell.padEnd(column.width);
  })
    .join("")
    .trimEnd();
}

/**
 * Render the report as a fixed-order table (DESIGN D8's tty
 * presentation): providers ascending, capabilities ascending, every
 * counter axis in a fixed column. Pure.
 */
export function formatUsageReport(report: UsageReport): string {
  const lines: string[] = [];
  lines.push(`Usage (last ${report.windowDays} days) — ${report.unitNote}`);
  lines.push("");
  if (report.providers.length === 0) {
    lines.push("No usage recorded in this window.");
    return lines.join("\n");
  }
  // Headers share renderRow's per-column alignment so the right-aligned
  // numeric columns line up with the data beneath them.
  lines.push(
    TABLE_COLUMNS.map((column) =>
      column.align === "right"
        ? column.header.padStart(column.width)
        : column.header.padEnd(column.width),
    )
      .join("")
      .trimEnd(),
  );
  for (const provider of report.providers) {
    for (const row of provider.capabilities) {
      lines.push(
        renderRow([
          provider.provider,
          row.capabilityId,
          String(row.counters.attempts),
          String(row.counters.firstTries),
          String(row.counters.estimateUnits),
          String(row.counters.exactUnits),
          String(row.counters.unknownCount),
        ]),
      );
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export interface UsageCommandDependencies {
  /** Reads the ledger (production: `readUsageLedger` over the resolved path). */
  readonly readLedger: () => Promise<UsageLedger>;
  /** Window size in UTC days; the dispatcher validated it before this seam. */
  readonly windowDays: number;
  /** Optional provider filter; the dispatcher validated it before this seam. */
  readonly provider?: string;
  /** Clock for `generatedAt` and the window edge. */
  readonly now: () => number;
}

/** All text modes share the same fixed-order table rendering. */
function usagePresentations(report: UsageReport): Partial<Record<TextOutputMode, string>> {
  const text = formatUsageReport(report);
  return { compact: text, markdown: text, refs: text, tty: text };
}

/**
 * Run the `usage` command: read the ledger, fold it into the D8
 * envelope, and return it as base data with the shared text-mode
 * presentation. Exit code is 0 on success; the fail-open read means a
 * missing or corrupt ledger is already an empty ledger here.
 */
export async function usageCommand(
  deps: UsageCommandDependencies,
): Promise<CommandResult<UsageReport>> {
  const ledger = await deps.readLedger();
  const report = buildUsageReport(ledger, {
    windowDays: deps.windowDays,
    ...(deps.provider !== undefined ? { provider: deps.provider } : {}),
    now: deps.now,
  });
  return {
    kind: "data",
    data: report,
    presentations: usagePresentations(report),
  };
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

export const USAGE_HELP = `
Usage - Report call-usage history from the local usage ledger

Usage:
  scoutline usage [--days N] [--provider <id>]

Every billable invoke - search (fan-out arms and --merge sub-queries
included), read, crawl, map, research, repo, and vision - appends
counters to the ledger; retries each count as an attempt, and cache
hits record nothing. Counts are billable call attempts; providers do
not report credit costs.

Options:
  --days N         Window size in UTC days (default 7). Must be an
                   integer between 1 and ${MAX_USAGE_WINDOW_DAYS};
                   --days 0, a non-numeric value, or an out-of-range
                   value is a validation error.
  --provider <id>  Narrow the report to one provider. The id must be a
                   known provider id; unknown ids are a validation
                   error listing the accepted ids. A known id with no
                   recorded history reports an empty window.

Reads <config-root>/usage.json (SCOUTLINE_CONFIG_DIR overrides the
default ~/.scoutline/). Days are UTC calendar dates; history is kept for
90 days. Only counters are stored - never queries, URLs, prompts,
results, or credentials. The command is credential-free and performs no
network calls; a missing or corrupt ledger reports an empty window with
exit 0.

Exit codes:
  0  Success (including an empty ledger).
  1  Validation error (--days out of range or not an integer between 1
     and ${MAX_USAGE_WINDOW_DAYS}, unknown or valueless --provider).

Examples:
  scoutline usage
  scoutline usage --days 30
  scoutline usage --provider zai --days 7
  scoutline usage --help
`.trim();
