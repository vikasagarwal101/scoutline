/**
 * history command — the artifacts-store front door: the read-only
 * inventory (save-artifacts plan, Ticket 5) widened by the
 * history-journal merge with `note` (T4), `recall` (T5), and `clear`
 * (T6a — history's first MUTATING op).
 *
 * Subcommands over `<artifacts>/index.json` and the master reports it
 * references:
 *
 *   - `history list [--since N] [--limit N] [--command C]` — newest
 *     first, from the LOG ONLY (a master file with no log entry is an
 *     orphan and invisible, DESIGN D5).
 *   - `history show <requestId>` — the join: the log entry plus the
 *     master report content, keyed by requestId. Unknown id and a live
 *     entry whose master vanished are FILE_ERROR (D7/D8).
 *   - `history stats` — counts by command / artifactFormat / kind,
 *     summed master bytes, and the oldest/newest span.
 *   - `history note` / `history recall` — see their own help.
 *   - `history clear [--all]` — the valve: journal kind by default,
 *     full wipe under --all (rewrites the log under the write lock).
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
import type { ArtifactsLog, LogEntryKind, SaveLogEntry } from "../lib/artifacts.js";
import { clearArtifactsLog } from "../lib/artifacts.js";
import { buildJournalRecall } from "../lib/journal.js";
import type { JournalRecallResult, JournalableCapability } from "../lib/journal.js";

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Report shapes
// ---------------------------------------------------------------------------

/** One list row: the inventory view of a log entry. */
export interface HistoryEntrySummary {
  readonly requestId?: string;
  readonly timestamp: number;
  /** Save entries: the command; journal entries: the capability (T2a review nit — journal rows have no command). */
  readonly command: string;
  readonly provider: SaveLogEntry["provider"];
  /** Save entries only; journal entries render "-" (no master, no format). */
  readonly artifactFormat: string;
  readonly kind: SaveLogEntry["kind"];
  readonly exportPath?: string;
  /** T6b `--repeats` rows only: the full entry a repeat marker repeats. */
  readonly repeatOf?: string;
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
  /**
   * T6b (DESIGN D5): the journal kind split into full skeleton entries
   * vs repeat markers. Absent when the store holds no journal rows;
   * the parts sum to `byKind.journal`.
   */
  readonly journalSplit?: { readonly full: number; readonly marker: number };
}

// ---------------------------------------------------------------------------
// Pure aggregation
// ---------------------------------------------------------------------------

export interface HistoryListOptions {
  readonly sinceDays?: number;
  readonly limit?: number;
  readonly command?: string;
  /** T6b: filter to one entry kind. */
  readonly kind?: LogEntryKind;
  /** T6b: include repeat-marker rows (skipped by default — D5 ruling). */
  readonly repeats?: boolean;
  readonly now: () => number;
}

/** List-row projection of a log entry (the inventory field set, pinned by tests). */
function toSummary(entry: SaveLogEntry): HistoryEntrySummary {
  // T2a review nit: journal entries (kind === "journal") carry the
  // capability + provider + skeleton shape, NOT command/artifactFormat —
  // projecting those undefined fields crashed formatHistoryList's padEnd.
  if (entry.kind === "journal") {
    const journal = entry as unknown as {
      capability: string;
      repeatOf?: string;
    };
    // T6b `--repeats` marker row: no requestId of its own — the row is
    // the repeat annotation (repeatOf), everything else per-kind.
    if (journal.repeatOf !== undefined) {
      return {
        timestamp: entry.timestamp,
        command: journal.capability,
        provider: entry.provider,
        artifactFormat: "-",
        kind: entry.kind,
        repeatOf: journal.repeatOf,
      };
    }
    return {
      requestId: entry.requestId,
      timestamp: entry.timestamp,
      command: journal.capability,
      provider: entry.provider,
      artifactFormat: "-",
      kind: entry.kind,
    };
  }
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
    // `--command` deliberately matches the RENDERED command column: the
    // command for save entries, the CAPABILITY for journal rows (markers
    // included — they carry capability, not command; the stats fold has
    // folded journal rows under capability since T2a). T6b review F1:
    // every filter gate runs BEFORE the repeats decision so marker rows
    // are windowed/kind/command-filtered exactly like their siblings.
    const journal = entry.kind === "journal" ? (entry as unknown as { capability: string; repeatOf?: string }) : undefined;
    if (options.command !== undefined && (journal?.capability ?? entry.command) !== options.command) {
      return false;
    }
    if (cutoff !== undefined && entry.timestamp < cutoff) return false;
    if (options.kind !== undefined && entry.kind !== options.kind) return false;
    if (journal?.repeatOf !== undefined) {
      // T2b review F1 (DESIGN D5 ruled end-state): repeat markers are
      // skipped by default — no requestId, not inventory rows. T6b
      // `--repeats` opts in (kind gate already passed above).
      return options.repeats === true;
    }
    return true;
  });
  // Marker rows have no requestId: sort BEFORE projecting so id-based
  // tiebreaks compare raw entries (markers order by timestamp against
  // their siblings; requestIds only ever tiebreak full entries).
  const ordered = [...kept].sort((a, b) => {
    if (b.timestamp !== a.timestamp) return b.timestamp - a.timestamp;
    const aId = a.requestId ?? "";
    const bId = b.requestId ?? "";
    return aId < bId ? 1 : aId > bId ? -1 : 0;
  });
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
  // T2a review must-fix 2: a journal entry IS the artifact — log-only,
  // no master. Render the entry itself (the { entry, report } shape's
  // `report` is the journal entry's own body) with no master read.
  if (entry.kind === "journal") {
    return { schemaVersion: 1, entry, report: entry };
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
  let journalFull = 0;
  let journalMarker = 0;
  for (const entry of log.entries) {
    // T2a NIT 2: journal rows count under their CAPABILITY (they carry
    // no command); save rows keep the command. Same for artifactFormat
    // (journal rows have none — counted as "-" to keep the fold total).
    if (entry.kind === "journal") {
      const journal = entry as unknown as { capability: string; repeatOf?: string };
      byCommand[journal.capability] = (byCommand[journal.capability] ?? 0) + 1;
      byArtifactFormat["-"] = (byArtifactFormat["-"] ?? 0) + 1;
      // T6b (DESIGN D5): the journal kind splits full vs marker.
      if (journal.repeatOf !== undefined) journalMarker += 1;
      else journalFull += 1;
    } else {
      byCommand[entry.command] = (byCommand[entry.command] ?? 0) + 1;
      byArtifactFormat[entry.artifactFormat] =
        (byArtifactFormat[entry.artifactFormat] ?? 0) + 1;
      // must-fix 2 (latent guard): only save entries have masters — a
      // journal row's masterPath is absent, stat must never run.
      masterBytes += await masterSizeOf(entry);
    }
    byKind[entry.kind] = (byKind[entry.kind] ?? 0) + 1;
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
    // Absent on a store with no journal rows — split keys exist only
    // when the kind they describe does (empty-store stays zeros-shape).
    ...(journalFull + journalMarker > 0
      ? { journalSplit: { full: journalFull, marker: journalMarker } }
      : {}),
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
  // Review fixup: header and data rows share one column-width table, and
  // every non-final column pads to width+1 so an exactly-full value (the
  // 21-char requestId) still leaves a one-space separator — columns can
  // no longer run together under a wide timestamp or id.
  // T6b: the table gains a kind column (after format, before provider)
  // — every text presentation renders this one table, so one column
  // set covers compact/markdown/refs/tty. The id column widens to hold
  // the T6b `--repeats` marker annotation `(repeat <requestId>)`.
  const pad = (cell: string, width: number): string => cell.padEnd(width + 1);
  const columns = ([id, saved, command, format, kind]: [string, string, string, string, string]): string =>
    pad(id, 30) + pad(saved, 24) + pad(command, 10) + pad(format, 10) + pad(kind, 8);
  const header = columns(["requestId", "saved (UTC)", "command", "format", "kind"]) + "provider";
  const lines = [
    `history: ${report.entries.length} of ${report.total} saved artifact(s)`,
    header,
  ];
  for (const row of report.entries) {
    // T2a review nit: null-safe provider deref — journal rows carry a
    // single-provider routing shape; a row without a provider object
    // (never written today) renders "-" instead of crashing.
    const routing = row.provider as { mode?: string; arms?: string[]; effective?: string; servedFrom?: string } | undefined;
    const provider =
      routing === undefined || typeof routing !== "object"
        ? "-"
        : routing.mode === "fanout"
          ? `fanout(${(routing.arms ?? []).join("+")})`
          : // Issue #108: a cache-served run rendered bare `effective` reads
            // "zai served this" during an outage zai was never contacted in;
            // the qualifier restores the distinction (render-only — the
            // data envelope carries the field verbatim).
            routing.servedFrom === "cache"
              ? `${routing.effective} (cache)`
              : (routing.effective ?? "-");
    // T6b `--repeats` marker row: its own row shape — the requestId
    // column holds the repeat annotation (repeatOf names the full
    // entry), so the row stays addressable in a scan.
    const id = row.repeatOf !== undefined ? `(repeat ${row.repeatOf})` : row.requestId ?? "";
    lines.push(
      columns([
        id,
        formatTimestamp(row.timestamp),
        row.command,
        row.artifactFormat,
        row.kind,
      ]) + provider,
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
    // T6b (DESIGN D5): journal full-vs-marker split line — only when
    // the store holds journal rows (matches the envelope's absence rule).
    ...(report.journalSplit !== undefined
      ? [`journal: ${report.journalSplit.full} full, ${report.journalSplit.marker} marker`]
      : []),
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
  /** T6b: filter to one entry kind. */
  readonly kind?: LogEntryKind;
  /** T6b: include repeat-marker rows (skipped by default — D5 ruling). */
  readonly repeats?: boolean;
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
      ...(deps.kind !== undefined ? { kind: deps.kind } : {}),
      ...(deps.repeats === true ? { repeats: true } : {}),
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
// T6a — clear (the valve; DESIGN D5). History's first MUTATING op.
// ---------------------------------------------------------------------------

/** `history clear` data-mode envelope. */
export interface HistoryClearReport {
  readonly schemaVersion: 1;
  readonly generatedAt: number;
  /** "journal" (bare) or "all" (--all). */
  readonly scope: "journal" | "all";
  /** Total entries removed. */
  readonly removed: number;
  /** Removed counts by entry kind. */
  readonly removedByKind: Readonly<Record<string, number>>;
  /** Entries kept (0 under --all). */
  readonly kept: number;
  /** Save masters deleted under --all (0 bare). */
  readonly mastersDeleted: number;
}

/**
 * `history clear` (PRD AC7): bare = the journal-kind valve — every
 * kind:"journal" entry (full entries AND repeat markers) is rewritten
 * away; save entries and their masters are byte-untouched. `--all` is
 * the full wipe: save entries go too and their master files are
 * deleted. The rewrite runs inside the artifacts write lock
 * (`clearArtifactsLog`); a corrupt pre-state reads fail-open EMPTY, so
 * clear succeeds and writes back a valid empty log. Journaling itself
 * is untouched — the next search/read/research re-populates (the
 * response cache is never touched; that is \`cache clear\`).
 */
export async function historyClearCommand(input: {
  readonly dir: string;
  readonly all: boolean;
  readonly now: () => number;
  readonly notice: (message: string) => void;
  readonly lock?: { readonly timeoutMs?: number; readonly setTimeout?: typeof setTimeout };
}): Promise<CommandResult> {
  const result = await clearArtifactsLog(input.dir, {
    all: input.all,
    ...(input.lock?.timeoutMs !== undefined ? { timeoutMs: input.lock.timeoutMs } : {}),
    ...(input.lock?.setTimeout !== undefined ? { setTimeout: input.lock.setTimeout } : {}),
  });
  if (result.notice !== undefined) input.notice(result.notice);
  const mastersDeleted = input.all ? result.removedByKind.save ?? 0 : 0;
  const report: HistoryClearReport = {
    schemaVersion: 1,
    generatedAt: input.now(),
    scope: input.all ? "all" : "journal",
    removed: result.removed,
    removedByKind: result.removedByKind,
    kept: result.kept,
    mastersDeleted,
  };
  const text =
    `history clear (${report.scope}): removed ${report.removed} journal entr${report.removed === 1 ? "y" : "ies"}` +
    (input.all
      ? ` and ${mastersDeleted} save master file(s); 0 entries remain`
      : `; ${report.kept} saved artifact(s) kept`);
  return {
    kind: "data",
    data: report,
    presentations: { compact: text, markdown: text, refs: text, tty: text },
  };
}

// ---------------------------------------------------------------------------
// T6c — export (the dossier renderer; DESIGN D5 / PRD AC5)
// ---------------------------------------------------------------------------

/** One dossier section's identity set (derived from a full journal entry). */
export interface HistoryExportSection {
  readonly requestId: string;
  readonly timestamp: number;
  readonly capability: JournalableCapability;
  readonly query: string;
  /** Rendered per family conventions (incl. the `x (cache)` qualifier). */
  readonly provider: string;
  readonly contentHash: string;
  readonly rows: readonly { readonly url: string; readonly title: string }[];
  readonly tags: readonly string[];
  readonly saveRef?: string;
  /** Existence-stat verdict on the saveRef'd master: true/false, or absent when the save entry itself is gone from the log. */
  readonly saveMasterOnDisk?: boolean;
}

/** `history export` data-mode envelope. */
export interface HistoryExportReport {
  readonly schemaVersion: 1;
  readonly generatedAt: number;
  /** The parsed `--since` lower bound, when given. */
  readonly since?: number;
  /** Sections rendered — FULL entries only (repeat markers never). */
  readonly total: number;
  /** The deterministic markdown dossier (byte-identical for the same log). */
  readonly markdown: string;
}

/** Existence probe for a saveRef'd master (stat only — content is never read). */
export type MasterExists = (requestId: string) => Promise<boolean | undefined>;

/**
 * Render the export dossier (T6c, PRD AC5): pure markdown over the
 * filtered FULL journal entries — one section per finding (entry
 * identity from the skeleton), one provenance line
 * `{url, at, contentHash}` per skeleton row (`at` = entry timestamp
 * ISO, `contentHash` = the ENTRY's hash). Repeat markers are NEVER
 * sections (the list default-skip ruling, DESIGN D5); save entries are
 * not findings either — a save surfaces only as its skeleton's
 * `saveRef` pointer, annotated by an EXISTENCE check (stat only: the
 * master's content is never read, never fetched). Sections order
 * newest-first (timestamp desc, requestId desc) — derived from entry
 * fields, not append order, so the same set renders byte-identically
 * regardless of append sequence.
 */
export async function buildHistoryExportReport(
  log: ArtifactsLog,
  options: {
    readonly since?: number;
    readonly now: () => number;
    readonly masterExists?: MasterExists;
  },
): Promise<HistoryExportReport> {
  const sections: HistoryExportSection[] = [];
  for (const entry of log.entries) {
    if (entry.kind !== "journal") continue;
    const journal = entry as unknown as {
      requestId?: string;
      repeatOf?: string;
      capability: JournalableCapability;
      query: string;
      provider: SaveLogEntry["provider"];
      contentHash: string;
      skeleton: { results: readonly { url: string; title: string }[] };
      tags?: readonly string[];
      saveRef?: string;
    };
    if (journal.repeatOf !== undefined) continue; // markers are never sections
    if (options.since !== undefined && entry.timestamp < options.since) continue;
    let saveMasterOnDisk: boolean | undefined;
    if (journal.saveRef !== undefined && options.masterExists !== undefined) {
      saveMasterOnDisk = await options.masterExists(journal.saveRef);
    }
    sections.push({
      requestId: journal.requestId ?? "",
      timestamp: entry.timestamp,
      capability: journal.capability,
      query: journal.query,
      provider: formatExportProvider(journal.provider),
      contentHash: journal.contentHash,
      rows: journal.skeleton.results,
      tags: journal.tags ?? [],
      ...(journal.saveRef !== undefined ? { saveRef: journal.saveRef } : {}),
      ...(saveMasterOnDisk !== undefined ? { saveMasterOnDisk } : {}),
    });
  }
  sections.sort((a, b) => b.timestamp - a.timestamp || (a.requestId < b.requestId ? 1 : -1));
  return {
    schemaVersion: 1,
    generatedAt: options.now(),
    ...(options.since !== undefined ? { since: options.since } : {}),
    total: sections.length,
    markdown: renderHistoryExportDossier(sections, options.since),
  };
}

/** Provider rendering per family conventions: `x (cache)` on servedFrom cache, `fanout(a+b)` on arms (render-only). */
function formatExportProvider(provider: SaveLogEntry["provider"]): string {
  const routing = provider as { mode?: string; arms?: string[]; effective?: string; servedFrom?: string };
  if (routing.mode === "fanout") return `fanout(${(routing.arms ?? []).join("+")})`;
  if (routing.servedFrom === "cache") return `${routing.effective} (cache)`;
  return routing.effective ?? "-";
}

/** The deterministic markdown renderer (frozen byte-exact by tests). */
function renderHistoryExportDossier(
  sections: readonly HistoryExportSection[],
  since: number | undefined,
): string {
  const lines = ["# Research journal export", ""];
  if (since !== undefined) {
    lines.push(`since: ${new Date(since).toISOString()} (inclusive)`, "");
  }
  for (const section of sections) {
    const firstRow = section.rows[0];
    const title = firstRow !== undefined && firstRow.title.length > 0 ? firstRow.title : section.query;
    lines.push(
      `## ${title || section.capability}`,
      `- query: ${section.query}`,
      `- capability: ${section.capability}`,
      `- provider: ${section.provider}`,
      `- recorded: ${new Date(section.timestamp).toISOString()}`,
      `- requestId: ${section.requestId}`,
      `- tags: ${section.tags.length > 0 ? section.tags.join(",") : "-"}`,
      `- saved artifact: ${
        section.saveRef === undefined
          ? "-"
          : section.saveMasterOnDisk === false
            ? `${section.saveRef} (missing)`
            : section.saveRef
      }`,
      "",
    );
    const at = new Date(section.timestamp).toISOString();
    for (const row of section.rows) {
      lines.push(`- ${row.url} — ${row.title}`);
      lines.push(`  \`{url:${row.url}, at:${at}, contentHash:${section.contentHash}}\``);
    }
    lines.push("");
  }
  lines.push(`${sections.length} finding(s)`);
  return lines.join("\n");
}

/**
 * T6c: the export command. Read-only: `readLog` + existence stats on
 * saveRef'd masters are the ONLY I/O — zero network, zero cache reads,
 * master CONTENT never opened (owner: no re-fetch, ever). Fail-open on
 * a missing store (header-only dossier, exit 0); a corrupt log's
 * read-notice rides the stderr notice seam.
 */
export async function historyExportCommand(input: {
  readonly readLog: () => Promise<import("../lib/artifacts.js").ReadLogResult>;
  readonly masterExists?: MasterExists;
  readonly notice: (message: string) => void;
  readonly now: () => number;
  readonly since?: number;
}): Promise<CommandResult> {
  const { log, notice } = await input.readLog();
  if (notice !== undefined) input.notice(notice);
  const report = await buildHistoryExportReport(log, {
    now: input.now,
    ...(input.since !== undefined ? { since: input.since } : {}),
    ...(input.masterExists !== undefined ? { masterExists: input.masterExists } : {}),
  });
  const refs = log.entries
    .filter(
      (entry) =>
        (entry as unknown as Record<string, unknown>).kind === "journal" &&
        (entry as unknown as Record<string, unknown>).requestId !== undefined &&
        (entry as unknown as Record<string, unknown>).repeatOf === undefined,
    )
    .map((entry) => (entry as unknown as { requestId: string }).requestId)
    .reverse()
    .join("\n");
  return {
    kind: "data",
    data: report,
    presentations: {
      compact: report.markdown,
      markdown: report.markdown,
      refs,
      tty: report.markdown,
    },
  };
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

export const HISTORY_HELP = `History - Saved --save artifacts + research journal (list / show /
stats / note / recall / export; clear MUTATES)

Usage:
  scoutline history list [--since N] [--limit N] [--command <name>]
                         [--kind <save|journal>] [--repeats]
  scoutline history show <requestId>
  scoutline history stats
  scoutline history note --capability <search|read|research> <text>
                          [--url <url> [--title <title>]]... [--tags a,b]
  scoutline history recall <text> [--limit N] [--as-of <date>]
                           [--capability <search|read|research>]
  scoutline history export [--since <date>]
  scoutline history clear [--all]

Reads the artifact store (default ~/.scoutline/artifacts/, override with
SCOUTLINE_ARTIFACTS_DIR) without touching Providers, credentials, or the
response cache. Every subcommand except clear is read-only: reads fail
open — a missing store is an empty listing (exit 0); a corrupt log is
ignored with a stderr notice.

Options:
  list    Saved runs, newest first. --since N keeps the last N UTC days
          (today inclusive); --limit N slices the newest N; --command
          filters by command name; --kind narrows to save or journal
          entries; --repeats also lists warm-repeat markers (skipped
          by default — markers render as their own row naming the
          entry they repeat). The table's kind column marks each row.
  show    One saved run: the metadata record joined with the report
          content by requestId.
  stats   Counts by command, artifact format, and entry kind, plus the
          total master bytes and oldest/newest span. Journal rows also
          split into full entries vs repeat markers (journal: N full,
          M marker).
  note    Write an explicit journal entry: hand-supplied work record or
          observation (see \`scoutline history note --help\`). Not
          suppressed by config "journal": false — that switch governs
          the always-on recording, and note is opt-in by construction.
  recall  Re-find past research from journal skeletons: lexical token
          overlap over recorded queries + skeletons, ranked by score
          then recency (see \`scoutline history recall --help\`). No
          network, no cache reads, no master files — pure log scoring.
  clear   The valve (MUTATES the store; see \`scoutline history clear
          --help\`): bare clear removes the journal kind only — the
          fast-refilling layer. --save artifacts need \`--all\`.

Exit codes:
  0  Success (including the empty fail-open cases)
  1  Unknown requestId or missing master (FILE_ERROR); invalid flags
     (VALIDATION_ERROR)

Examples:
  scoutline search "rust vs go" --save report.json
  scoutline history list --limit 5
  scoutline history list --kind journal --repeats
  scoutline history show 20260829T142233Z-7f3a
  scoutline history stats
  scoutline history note --capability search "compared rust vs go" \\
    --url https://go.dev/doc --title "Go Documentation" --tags lang-comparison
  scoutline history clear
  scoutline history clear --all
`;

export const HISTORY_NOTE_HELP = `History note - Write an explicit journal entry

Usage:
  scoutline history note --capability <search|read|research> <text>
                          [--url <url> [--title <title>]]... [--tags a,b,c]

Records hand-written work or observations into the research journal —
the re-homed \`journal record\`: the same kind:"journal" entry the
always-on recording writes, but supplied by you rather than a Provider
run. Notes are local-only, redacted at the write seam, 0600, log-only
(no master file), and never re-fetched. The entry's provider field is
the sentinel "note": no Provider served it, and the routing is not
hand-choosable. Notes ignore the always-on escape hatches — config
"journal": false does NOT suppress an explicit note (that switch
governs automatic recording; note is opt-in by construction).

Options:
  --capability <search|read|research>
          The capability the note records (required). Drives the
          skeleton shape: search = url+title list; read = exactly one
          {url,title} row; research = citations list.
  <text>  The note itself: the query (search) or URL (read/research)
          plus any observation text (required, positional).
  --url <url>
          One skeleton row. Repeat for multi-row skeletons (search,
          research); a read note takes EXACTLY one. Without --url the
          skeleton is an empty list (a bare observation; invalid for
          read).
  --title <title>
          Title for the preceding --url row; defaults to the url
          itself. Belongs to the nearest preceding --url.
  --tags <a,b,c>
          Comma-separated tags stored on the entry.

Exit codes:
  0  Note recorded
  1  Missing/invalid --capability, missing text, a valueless --url or
     --title, a read note without exactly one --url (VALIDATION_ERROR)

Examples:
  scoutline history note --capability search "compared rust vs go" \\
    --url https://go.dev/doc --title "Go Documentation" --tags lang-comparison
  scoutline history note --capability read "read the announcement" \\
    --url https://example.com/changelog
  scoutline history note --capability research "open question on quotas"
`;

export const HISTORY_RECALL_HELP = `History recall - Re-find past research from the journal skeletons

Usage:
  scoutline history recall <text> [--limit N] [--as-of <date>] \\
                           [--capability <search|read|research>]

Lexical recollection over the recorded journal corpus: token overlap
between your recall text and each journal entry's query + skeleton
text (titles/urls/citations), ranked score DESC then recency DESC.
Repeat markers never appear as separate results - they resolve to the
entry they repeat and advance its lastAsked. Saved --save artifacts
are never text-searched (their args are flags-only); a save surfaces
only through its cross-linked skeleton (saveRef). No network, no
response-cache reads, no master files are ever opened - recall is
pure scoring over the log (no re-fetch, ever).

Options:
  <text>                The recall text (required, positional).
  --limit N             Keep the top N ranked results.
  --as-of <date>        Temporal boundary: entries with timestamp
                        <= date. Accepts ISO-8601 or epoch-ms.
  --capability <name>   Restrict the corpus to one capability.

An empty or missing journal recalls an empty list (exit 0) with one
stderr orientation line.

Exit codes:
  0  Success (including the empty fail-open cases)
  1  Missing text; invalid --limit/--as-of/--capability values
     (VALIDATION_ERROR)

Examples:
  scoutline history recall "rust vs go"
  scoutline history recall "quota design" --capability research --limit 5
  scoutline history recall "mcp transport" --as-of 2026-09-01T00:00:00Z
`;

/** T5 (`history recall`, DESIGN D4): the recall command. Pure scoring
 * over the read log — `readLog` is the only I/O (fail-open, missing
 * store = empty). Zero network, zero cache reads, masters never
 * opened. The empty-JOURNAL case emits ONE orientation notice (the
 * existing notice seam — stderr, stdout stays data-only). */
export async function historyRecallCommand(input: {
  readonly readLog: () => Promise<import("../lib/artifacts.js").ReadLogResult>;
  readonly notice: (message: string) => void;
  readonly text: string;
  readonly asOf?: number;
  readonly capability?: JournalableCapability;
  readonly limit?: number;
}): Promise<CommandResult> {
  const { log } = await input.readLog();
  const results = buildJournalRecall(log.entries as readonly unknown[], input.text, {
    ...(input.asOf !== undefined ? { asOf: input.asOf } : {}),
    ...(input.capability !== undefined ? { capability: input.capability } : {}),
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
  });
  // Orientation notice ONLY when the journal never had any full
  // journal entry — a non-match over a live journal is honest
  // silence (first-time UX, PRD AC4).
  const hasJournalEntry = log.entries.some(
    (entry) =>
      (entry as unknown as Record<string, unknown>).kind === "journal" &&
      (entry as unknown as Record<string, unknown>).repeatOf === undefined,
  );
  if (!hasJournalEntry) {
    input.notice(
      "journal is empty — entries appear as you run search/read/research (or history note).",
    );
  }
  return {
    kind: "data",
    data: {
      schemaVersion: 1,
      query: input.text,
      total: results.length,
      results: results.map((result: JournalRecallResult) => ({
        requestId: result.requestId,
        capability: result.capability,
        score: result.score,
        timestamp: result.timestamp,
        lastAsked: result.lastAsked,
        ...(result.saveRef !== undefined ? { saveRef: result.saveRef } : {}),
        query: result.query,
        results: result.results,
      })),
    },
    presentations: {
      compact: renderRecallCompact(results),
      markdown: renderRecallMarkdown(results),
      refs: results.map((result) => result.requestId).join("\n"),
      tty: renderRecallCompact(results),
    },
  };
}

function renderRecallCompact(results: readonly JournalRecallResult[]): string {
  if (results.length === 0) return "no matching journal entries";
  return results
    .map(
      (result) =>
        `${result.score}  ${new Date(result.lastAsked).toISOString()}  ${result.capability}  ${result.query}` +
        (result.saveRef !== undefined ? `  (saved: ${result.saveRef})` : ""),
    )
    .join("\n");
}

function renderRecallMarkdown(results: readonly JournalRecallResult[]): string {
  if (results.length === 0) return "No matching journal entries.";
  const lines = ["# Journal recall", ""];
  for (const result of results) {
    lines.push(
      `## ${result.query} (${result.capability}, score ${result.score})`,
      "",
      `- requestId: ${result.requestId}`,
      `- recorded: ${new Date(result.timestamp).toISOString()}`,
      `- lastAsked: ${new Date(result.lastAsked).toISOString()}`,
      ...(result.saveRef !== undefined ? [`- saveRef: ${result.saveRef}`] : []),
      "",
    );
    for (const row of result.results) {
      lines.push(`- [${row.title}](${row.url})`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

export const HISTORY_CLEAR_HELP = `History clear - Clear the research journal (the valve; MUTATES the store)

Usage:
  scoutline history clear [--all]

Bare \`history clear\` removes the JOURNAL kind only: every
kind:"journal" entry — full skeleton entries AND repeat markers — is
rewritten away under the artifacts write lock. --save artifacts and
their report files are untouched. The journal is the fast-refilling
layer: it repopulates as you run search/read/research (journaling is
never disabled by clearing).

--all extends the wipe: --save entries go too AND their master files
are deleted. This is the full wipe; nothing survives it.

A corrupt or unrecognized log reads fail-open EMPTY, so clear succeeds
and writes back a valid empty log. The response cache is NOT touched —
use \`scoutline cache clear\` for that.

Options:
  --all  Full wipe: remove save entries too and delete their master
         files (default: journal kind only).

Exit codes:
  0  Success (including clearing an empty or corrupt store)
  1  Invalid flags (VALIDATION_ERROR); lock timeout (LOCK_TIMEOUT)

Examples:
  scoutline history clear
  scoutline history clear --all
`;

export const HISTORY_EXPORT_HELP = `History export - Markdown dossier of journal findings (read-only)

Usage:
  scoutline history export [--since <date>]

Render a deterministic markdown dossier over the journal: one section
per finding (full journal entries only — search/read/research
skeletons), newest first. Each section carries the entry identity
(query, capability, provider, recorded time, requestId, tags) and a
provenance line \`{url, at, contentHash}\` per skeleton row — the cited
identity of every source, never its content. Repeat markers are never
sections (same ruling as list default). A cross-linked --save artifact
appears only as its saveRef pointer, annotated by an existence check;
master content is NEVER read and NOTHING is fetched (no re-fetch, ever
— no network, no response-cache reads, no master opens). Same log
renders byte-identical output.

Options:
  --since <date>  Lower bound on entry timestamps (inclusive: >=).
                  Accepts ISO-8601 or epoch-ms.

Exit codes:
  0  Success (including an empty or missing store — header-only
     dossier)
  1  Invalid --since value or unexpected arguments (VALIDATION_ERROR)

Examples:
  scoutline history export
  scoutline history export --since 2026-09-01
`;
