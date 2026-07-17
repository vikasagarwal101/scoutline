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

/** Resolve the effective output mode considering --raw / --pretty-output overrides. */
export function resolveTtyMode(
  explicitFormat: string | undefined,
  opts: { forcePretty?: boolean; forceRaw?: boolean },
): "tty" | "non-tty" {
  if (opts.forcePretty) return "tty";
  if (opts.forceRaw) return "non-tty";
  if (explicitFormat) return "non-tty"; // user picked a specific -O mode
  return isTTY() ? "tty" : "non-tty";
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
    remainingPercent: number;
    resetsAt?: string;
  };
  weekly?: {
    remainingPercent: number;
  };
}

interface QuotaSuccessLike {
  provider: string;
  status: "ok";
  plan?: string;
  categories: QuotaCategoryLike[];
}

interface QuotaFailureLike {
  provider: string;
  status: "error";
  error: { message: string };
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
  lines.push(`    ${color.bold(category.name)}  ${remainingBar(pct)}  ${pct}% remaining`);
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
  if (category.weekly) {
    const w = category.weekly;
    lines.push(
      `      ${color.gray("weekly")} ${remainingBar(w.remainingPercent)} ${w.remainingPercent}%`,
    );
  }
}

/**
 * Provider-neutral TTY rendering of a {@link QuotaDashboard}. Each
 * Provider entry is labelled with its Provider id and each category by
 * its normalized name; progress bars represent the REMAINING percentage.
 */
export function formatQuotaDashboard(dashboard: QuotaDashboard): string {
  const lines: string[] = [""];
  for (const entry of dashboard.providers) {
    if (entry.status === "ok") {
      const success = entry as QuotaSuccessLike;
      const planTxt = success.plan ? ` ${color.gray(`(${success.plan})`)}` : "";
      lines.push(`  ${color.bold(success.provider)}${planTxt}`);
      for (const category of success.categories) {
        renderCategory(category, lines);
      }
    } else {
      const failure = entry as QuotaFailureLike;
      lines.push(`  ${color.bold(failure.provider)} ${color.red("error")}`);
      lines.push(`    ${color.dim(failure.error.message)}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
