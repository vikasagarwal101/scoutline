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

interface QuotaLike {
  plan?: string;
  timeWindow?: {
    used?: number;
    limit?: number;
    remaining?: number;
    percentage?: number;
    windowHours?: number;
    resetsIn?: string | null;
    byTool?: Array<{ modelCode?: string; usage?: number }>;
  } | null;
  tokens?: { percentage?: number; resetsIn?: string | null } | null;
}

/** ASCII progress bar: 20 chars wide. */
function progressBar(pct: number): string {
  const filled = Math.round((pct / 100) * 20);
  const bar = "█".repeat(filled) + "░".repeat(20 - filled);
  const colorFn = pct >= 90 ? color.red : pct >= 70 ? color.yellow : color.green;
  return colorFn(bar);
}

export function formatQuotaPretty(q: QuotaLike): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(`  ${color.bold("Z.AI Coding Plan")} — ${color.magenta(q.plan || "unknown")} tier`);
  lines.push("");

  if (q.timeWindow) {
    const tw = q.timeWindow;
    const pct = tw.percentage ?? 0;
    const resetTxt = tw.resetsIn ? `resets in ${color.dim(tw.resetsIn)}` : "";
    lines.push(
      `  ${color.bold(`Time window`)} ${color.gray(`(${tw.windowHours || 5}h rolling)`)}  ${resetTxt}`,
    );
    lines.push("");
    lines.push(`  ${progressBar(pct)}  ${tw.used ?? 0}/${tw.limit ?? 0} calls (${pct}%)`);
    if (tw.remaining !== undefined) {
      lines.push(`  ${color.green(`${tw.remaining} remaining`)}`);
    }
    if (tw.byTool && tw.byTool.length > 0) {
      lines.push("");
      const sorted = [...tw.byTool].sort((a, b) => (b.usage || 0) - (a.usage || 0));
      for (const t of sorted) {
        lines.push(`    ${color.gray("•")} ${t.modelCode}: ${t.usage || 0}`);
      }
    }
    lines.push("");
  }

  if (q.tokens) {
    const pct = q.tokens.percentage ?? 0;
    const resetTxt = q.tokens.resetsIn ? `resets in ${color.dim(q.tokens.resetsIn)}` : "";
    lines.push(`  ${color.bold("Token budget")}  ${resetTxt}`);
    lines.push(`  ${progressBar(pct)}  ${pct}% used`);
    lines.push("");
  }

  return lines.join("\n");
}
