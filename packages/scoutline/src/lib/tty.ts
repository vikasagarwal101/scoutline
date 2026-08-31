/**
 * TTY-aware pretty output.
 *
 * Agents always capture stdout (isTTY=false) → they get compact JSON unchanged.
 * Humans running scoutline in a terminal (isTTY=true) get human-friendly output
 * by default: colored search results, quota dashboards with progress bars.
 *
 * Force either way: --pretty-output (force human format) / --raw (force data).
 *
 * Honors NO_COLOR env var (https://no-color.org) — disables all ANSI codes.
 */

type ColorFn = (s: string) => string;

const NO_COLOR = "NO_COLOR" in process.env || process.env.NO_COLOR !== undefined;
const ANSI_ENABLED = !NO_COLOR;

function ansi(code: string): ColorFn {
  if (!ANSI_ENABLED) return (s) => s;
  return (s) => `\x1b[${code}m${s}\x1b[0m`;
}

export const color = {
  bold: ansi("1"),
  dim: ansi("2"),
  cyan: ansi("36"),
  green: ansi("32"),
  yellow: ansi("33"),
  red: ansi("31"),
  magenta: ansi("35"),
  gray: ansi("90"),
};

export function isTTY(): boolean {
  return Boolean(process.stdout.isTTY);
}

interface SearchResultLike {
  rank?: number;
  title?: string;
  url?: string;
  summary?: string;
  source?: string;
  date?: string;
  occurrences?: number;
}

export function formatSearchResultsPretty(results: SearchResultLike[]): string {
  if (results.length === 0) return color.dim("(no results)");
  const lines: string[] = [];
  for (const r of results) {
    const badge = r.occurrences && r.occurrences > 1 ? ` ${color.yellow(`×${r.occurrences}`)}` : "";
    const num = color.gray(`${r.rank}.`);
    lines.push(`${num} ${color.bold(r.title || "(untitled)")}${badge}`);
    lines.push(`   ${color.cyan(r.url || "")}`);
    if (r.summary) lines.push(`   ${color.dim(r.summary)}`);
    const meta: string[] = [];
    if (r.source) meta.push(r.source);
    if (r.date) meta.push(r.date);
    if (meta.length) lines.push(`   ${color.gray(meta.join("  ·  "))}`);
  }
  return lines.join("\n");
}

import type { QuotaDashboard } from "../capabilities/quota.js";

interface QuotaCategoryLike {
  name: string;
  unit: "requests" | "tokens";
  current: {
    used?: number;
    limit?: number;
    remaining?: number;
    remainingPercent?: number;
    resetsAt?: string;
  };
  weekly?: {
    remainingPercent?: number;
  };
}

interface QuotaSourceLike {
  source: "snapshot" | "live";
  observedAt: number;
  authoritative: boolean;
}

interface QuotaSuccessLike {
  provider: string;
  status: "ok";
  plan?: string;
  categories: QuotaCategoryLike[];
  quotaSource?: QuotaSourceLike;
}

interface QuotaFailureLike {
  provider: string;
  status: "error";
  error: { message: string };
}

interface QuotaNoneLike {
  provider: string;
  status: "none";
  reason: "no-capability";
}

/**
 * Remaining-percentage progress bar: 20 chars wide. Low remaining is
 * red (tight quota), high remaining is green. The bar represents the
 * REMAINING share, not the used share.
 */
function remainingBar(pct: number): string {
  const filled = Math.round((pct / 100) * 20);
  const bar = "█".repeat(filled) + "░".repeat(20 - filled);
  const colorFn = pct < 30 ? color.red : pct < 70 ? color.yellow : color.green;
  return colorFn(bar);
}

function formatResetLabel(resetsAt: string | undefined): string {
  if (!resetsAt) return "";
  return `resets ${color.gray(resetsAt)}`;
}

function renderCategory(category: QuotaCategoryLike, lines: string[]): void {
  const current = category.current;
  const pct = current.remainingPercent;
  const resetTxt = formatResetLabel(current.resetsAt);
  if (typeof pct === "number") {
    lines.push(`    ${color.bold(category.name)}  ${remainingBar(pct)}  ${pct}% remaining`);
  } else {
    lines.push(`    ${color.bold(category.name)}`);
  }
  const counts: string[] = [];
  if (typeof current.used === "number" && typeof current.limit === "number") {
    counts.push(`${current.used}/${current.limit}`);
  }
  if (typeof current.remaining === "number") {
    counts.push(`${color.green(`${current.remaining} left`)}`);
  }
  if (counts.length > 0 || resetTxt) {
    lines.push(`      ${[...counts, resetTxt].filter(Boolean).join("  ·  ")}`);
  }
  const w = category.weekly;
  if (w && typeof w.remainingPercent === "number") {
    lines.push(
      `      ${color.gray("weekly")} ${remainingBar(w.remainingPercent)} ${w.remainingPercent}%`,
    );
  }
}

/**
 * Format a relative-age label for an epoch-ms timestamp (PB-T5).
 * Returns a short "Xm"/"Xh"/"Xd" string suitable for a TTY row. Used
 * to surface `observedAt` age so a user can judge whether a selection
 * pick was made against stale or fresh data. The `now` parameter is
 * injected by the caller so a deterministic test clock produces a
 * deterministic label.
 */
function formatObservedAge(observedAt: number, now: number): string {
  const diff = Math.max(0, now - observedAt);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  return `${day}d`;
}

/**
 * Render the quotaSource label for a successful row (PB-T5). Mirrors
 * the public {@link QuotaSourceLabel} shape: source/observedAt/
 * authoritative. A non-authoritative row is dimmed so a user can see
 * at a glance that the displayed numbers may be stale. The age label
 * is computed against the injected clock so tests stay deterministic.
 */
function renderSourceLabel(source: QuotaSourceLike, lines: string[], now: number): void {
  const age = formatObservedAge(source.observedAt, now);
  const authority = source.authoritative
    ? color.green("fresh")
    : color.yellow("stale · non-authoritative");
  const sourceTxt = source.source === "snapshot" ? color.gray("snapshot") : color.cyan("live");
  lines.push(
    `      ${color.gray("source")} ${sourceTxt} · ${authority} ${color.gray(`(${age} ago`)}`,
  );
}

/**
 * Provider-neutral TTY rendering of a {@link QuotaDashboard}. Each
 * Provider entry is labelled with its Provider id and each category by
 * its normalized name; progress bars represent the REMAINING percentage.
 *
 * PB-T5: a successful row carries a `quotaSource` label rendered as a
 * separate `source` line beneath the categories (snapshot/live, fresh/
 * stale). The new `"none"` status (no quota Capability — Exa) renders
 * a single dim line; it never appears as a failure. The `now` argument
 * defaults to `Date.now()` so existing callers keep working; tests
 * inject a fixed clock for deterministic age labels.
 */
export function formatQuotaDashboard(dashboard: QuotaDashboard, now: number = Date.now()): string {
  const lines: string[] = [""];
  for (const entry of dashboard.providers) {
    if (entry.status === "ok") {
      const success = entry as QuotaSuccessLike;
      const planTxt = success.plan ? ` ${color.gray(`(${success.plan})`)}` : "";
      lines.push(`  ${color.bold(success.provider)}${planTxt}`);
      for (const category of success.categories) {
        renderCategory(category, lines);
      }
      if (success.quotaSource) {
        renderSourceLabel(success.quotaSource, lines, now);
      }
    } else if (entry.status === "none") {
      const none = entry as QuotaNoneLike;
      lines.push(`  ${color.bold(none.provider)} ${color.dim("(no quota)")}`);
      lines.push(`    ${color.gray("no quota capability — skipping probe")}`);
    } else {
      const failure = entry as QuotaFailureLike;
      lines.push(`  ${color.bold(failure.provider)} ${color.red("error")}`);
      lines.push(`    ${color.dim(failure.error.message)}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Doctor diagnostics report (T5 — fixes GitHub #95)
// ---------------------------------------------------------------------------

import type { ProviderDiagnosticQuota } from "../capabilities/diagnostics.js";
import type { ProviderAvailability } from "./availability.js";
import type { DiagnosticsReportWithAvailability } from "../commands/doctor.js";

/**
 * The per-row surface {@link formatDiagnosticsReport} renders. The
 * availability-carrying report rows satisfy this structurally; the
 * narrow shape keeps the formatter decoupled from the report builder.
 */
interface DiagnosticsRowLike {
  readonly provider: string;
  readonly status: "ok" | "error" | "skipped";
  readonly reason?: "not-configured" | "tools-disabled";
  readonly error?: { message: string };
  readonly availability: ProviderAvailability;
  readonly quota?: ProviderDiagnosticQuota;
  readonly verification?: {
    readonly status: "verified" | "unverified";
    readonly checkedAt: number;
  };
}

/**
 * The row's availability vocabulary class. #94 rows always carry
 * `availability`; a legacy row without it (old hand-built fixtures)
 * falls back to a status-derived class so the row never renders
 * "undefined".
 */
function availabilityOf(row: DiagnosticsRowLike): ProviderAvailability {
  return (
    row.availability ??
    (row.status === "error" ? "error" : row.status === "skipped" ? "unconfigured" : "ok")
  );
}

/**
 * Availability glyph + colored vocabulary label per class (T5). The
 * vocabulary word itself is always rendered so every row visibly
 * carries its availability class — even under NO_COLOR, where the
 * glyph color and the row dimming collapse to plain text.
 */
const AVAILABILITY_PRESENTATION: Readonly<
  Record<ProviderAvailability, { readonly glyph: string; readonly render: ColorFn }>
> = {
  ok: { glyph: "✓", render: color.green },
  exhausted: { glyph: "⚠", render: color.yellow },
  error: { glyph: "✗", render: color.red },
  unconfigured: { glyph: "·", render: color.gray },
};

/**
 * Diagnostics variant of the quota dashboard's source label (T5).
 * Doctor's quota summary is snapshot-or-none (Doctor never live-probes
 * quota), so the `"none"`/scaffold case renders an explicit dim "no
 * snapshot" instead of a source/age line — never the string
 * "undefined". The age label is computed against the injected clock so
 * tests stay deterministic.
 */
function renderDiagnosticsQuotaLabel(
  quota: ProviderDiagnosticQuota,
  lines: string[],
  now: number,
): void {
  if (quota.source === "snapshot" && typeof quota.observedAt === "number") {
    const age = formatObservedAge(quota.observedAt, now);
    const authority = quota.authoritative
      ? color.green("fresh")
      : color.yellow("stale · non-authoritative");
    lines.push(
      `      ${color.gray("quota")} ${color.gray("snapshot")} · ${authority} ${color.gray(`(${age} ago)`)}`,
    );
  } else {
    lines.push(`      ${color.gray("quota")} ${color.dim("no snapshot")}`);
  }
}

/**
 * Provider-neutral TTY rendering of a doctor DiagnosticsReport (T5 —
 * fixes GitHub #95). Header: the effective Provider, a capabilityMatrix
 * count summary, and the optional routing/cache summaries — an absent
 * optional field renders as absent (its line is omitted), never as the
 * string "undefined". Below the header, every provider row renders IN
 * THE ORDER THE REPORT CARRIES — the formatter never sorts; the report
 * builder delivers rows healthy-first (#94) and that order is rendered
 * verbatim. Each row carries an availability glyph + vocabulary label
 * (`ok` | `exhausted` | `error` | `unconfigured`), the probe status,
 * and the optional verification and snapshot source/age labels.
 *
 * The `now` argument defaults to `Date.now()` so existing callers keep
 * working; tests inject a fixed clock for deterministic age labels
 * (same signature style as {@link formatQuotaDashboard}).
 */
export function formatDiagnosticsReport(
  report: DiagnosticsReportWithAvailability,
  now: number = Date.now(),
): string {
  const lines: string[] = [""];
  lines.push(`  ${color.gray("effective provider")} ${color.bold(report.effectiveProvider)}`);
  const matrix = report.capabilityMatrix
    .map((entry) => `${entry.capability}×${entry.providers.length}`)
    .join("  ·  ");
  if (matrix.length > 0) {
    lines.push(`  ${color.gray("capabilityMatrix")} ${matrix}`);
  }
  if (report.routing !== undefined) {
    const routing = Object.entries(report.routing)
      .map(([capability, providers]) => `${capability} ← ${providers.join(", ")}`)
      .join("; ");
    if (routing.length > 0) {
      lines.push(`  ${color.gray("routing")} ${routing}`);
    }
  }
  if (report.cache !== undefined) {
    lines.push(`  ${color.gray("cache")} ${report.cache.summary}`);
  }
  const okCount = report.providers.filter(
    (row) => availabilityOf(row as DiagnosticsRowLike) === "ok",
  ).length;
  lines.push("");
  lines.push(
    `  ${color.bold("providers")} ${color.gray(`${okCount}/${report.providers.length} available · healthy-first`)}`,
  );
  for (const row of report.providers as readonly DiagnosticsRowLike[]) {
    const availability = availabilityOf(row);
    const presentation = AVAILABILITY_PRESENTATION[availability] ?? AVAILABILITY_PRESENTATION.error;
    lines.push(
      `  ${presentation.render(presentation.glyph)} ${color.bold(row.provider)} ${presentation.render(availability)}`,
    );
    if (row.status === "error" && row.error !== undefined) {
      lines.push(`      ${color.red("probe failed")} ${color.dim(row.error.message)}`);
    } else if (row.status === "skipped") {
      lines.push(`      ${color.gray(`probe skipped (${row.reason ?? "skipped"})`)}`);
    } else {
      lines.push(`      ${color.green("probe ok")}`);
    }
    if (row.verification !== undefined) {
      const verified =
        row.verification.status === "verified"
          ? color.green("verified")
          : color.gray("unverified");
      const age =
        row.verification.checkedAt > 0
          ? ` ${color.gray(`(${formatObservedAge(row.verification.checkedAt, now)} ago)`)}`
          : "";
      lines.push(`      ${color.gray("verification")} ${verified}${age}`);
    }
    if (row.quota !== undefined) {
      renderDiagnosticsQuotaLabel(row.quota, lines, now);
    }
  }
  lines.push("");
  return lines.join("\n");
}
