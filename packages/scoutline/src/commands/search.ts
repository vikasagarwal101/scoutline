/**
 * Web search command using Z.AI WebSearchPrime MCP
 */

import { ZaiMcpClient } from "../lib/mcp-client.js";
import { outputSuccess, getOutputMode } from "../lib/output.js";
import { formatErrorOutput } from "../lib/errors.js";
import { silenceConsole, restoreConsole } from "../lib/silence.js";
import { formatSearchResultsPretty } from "../lib/tty.js";

type RecencyFilter = "oneDay" | "oneWeek" | "oneMonth" | "oneYear" | "noLimit";

export interface SearchOptions {
  count?: number;
  domain?: string;
  recency?: RecencyFilter;
  contentSize?: "medium" | "high";
  location?: "cn" | "us";
  maxSummary?: number;
  fields?: string[];
  noCache?: boolean;
  merge?: boolean;
}

interface FormattedResult {
  rank: number;
  title: string;
  url: string;
  summary: string;
  source?: string;
  date?: string;
  /** Set when merging multiple queries: how many sub-queries surfaced this URL. */
  occurrences?: number;
}

function truncate(text: string | undefined, max?: number): string {
  if (!text) return "";
  if (!max || max <= 0 || text.length <= max) return text;
  return text.slice(0, max - 1).trimEnd() + "…";
}

function filterFields(result: FormattedResult, fields?: string[]): Partial<FormattedResult> {
  if (!fields || fields.length === 0) return result;
  const allowed = new Set(fields);
  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(result)) {
    if (allowed.has(key)) {
      filtered[key] = value;
    }
  }
  return filtered;
}

/**
 * Merge results from N parallel sub-queries: dedupe by URL, rank by
 * (occurrence count desc, then best position asc). First sub-query's
 * title/summary wins for each URL (highest-priority query).
 */
function mergeResults(byQuery: FormattedResult[][]): FormattedResult[] {
  const map = new Map<string, FormattedResult & { occurrences: number; bestPos: number }>();
  for (const [qIdx, results] of byQuery.entries()) {
    for (const r of results) {
      const existing = map.get(r.url);
      if (existing) {
        existing.occurrences += 1;
        existing.bestPos = Math.min(existing.bestPos, r.rank);
      } else {
        map.set(r.url, {
          ...r,
          occurrences: 1,
          bestPos: r.rank,
          // Keep title/summary from the EARLIEST sub-query that surfaced it.
          // r already has those since we're iterating in order.
        });
      }
      // Suppress unused-var warning
      void qIdx;
    }
  }
  const merged = Array.from(map.values());
  merged.sort((a, b) => {
    if (b.occurrences !== a.occurrences) return b.occurrences - a.occurrences;
    return a.bestPos - b.bestPos;
  });
  // Re-rank
  return merged.map((r, i) => {
    const { bestPos: _bp, ...rest } = r;
    void _bp;
    return { ...rest, rank: i + 1 };
  });
}

function renderTextFormat(
  results: FormattedResult[],
  mode: "compact" | "markdown" | "refs",
): string {
  if (results.length === 0) return "";
  const lines: string[] = [];
  for (const r of results) {
    const occBadge = r.occurrences && r.occurrences > 1 ? ` ×${r.occurrences}` : "";
    if (mode === "compact") {
      lines.push(`${r.title}${occBadge} — ${r.url}`);
    } else if (mode === "markdown") {
      lines.push(`${r.rank}. [${r.title}](${r.url})${occBadge}`);
      if (r.summary) lines.push(`   ${r.summary}`);
    } else if (mode === "refs") {
      lines.push(`[${r.rank}]${occBadge} ${r.title} — ${r.url}`);
    }
  }
  return lines.join("\n");
}

export async function search(query: string, options: SearchOptions = {}): Promise<void> {
  silenceConsole();

  // Split query on `|` if --merge is set. Empty fragments are dropped.
  // A literal pipe in a single query can be escaped as `\|` (won't split).
  let subQueries: string[] = [query];
  if (options.merge) {
    subQueries = query
      .split(/(?<!\\)\|/)
      .map((q) => q.replace(/\\\|/g, "|").trim())
      .filter((q) => q.length > 0);
    if (subQueries.length === 0) {
      restoreConsole();
      console.error(
        formatErrorOutput(
          new Error("--merge requires at least one non-empty query (split with '|')"),
        ),
      );
      process.exit(1);
    }
  }

  const isMerge = subQueries.length > 1;

  try {
    try {
      // For merge, spawn one client per sub-query — the UTCP client isn't
      // concurrency-safe so sharing one client across parallel calls corrupts
      // responses. Single-query path keeps the cheaper shared-client flow.
      let allResults;
      if (isMerge) {
        const clients = subQueries.map(
          () => new ZaiMcpClient({ enableVision: false, noCache: options.noCache }),
        );
        try {
          allResults = await Promise.all(
            subQueries.map((q, i) =>
              clients[i].webSearch({
                query: q,
                count: options.count,
                domainFilter: options.domain,
                recencyFilter: options.recency,
                contentSize: options.contentSize,
                location: options.location,
              }),
            ),
          );
        } finally {
          await Promise.all(clients.map((c) => c.close().catch(() => {})));
        }
      } else {
        const client = new ZaiMcpClient({ enableVision: false, noCache: options.noCache });
        try {
          allResults = [
            await client.webSearch({
              query: subQueries[0],
              count: options.count,
              domainFilter: options.domain,
              recencyFilter: options.recency,
              contentSize: options.contentSize,
              location: options.location,
            }),
          ];
        } finally {
          await client.close().catch(() => {});
        }
      }

      // Format each sub-query's results, then merge if needed.
      const perQueryFormatted: FormattedResult[][] = allResults.map((results) =>
        Array.isArray(results)
          ? results.map((r, i) => ({
              rank: i + 1,
              title: r.title,
              url: r.link,
              summary: truncate(r.content, options.maxSummary),
              ...(r.media ? { source: r.media } : {}),
              ...(r.publish_date ? { date: r.publish_date } : {}),
            }))
          : [],
      );

      const formattedResults: FormattedResult[] = isMerge
        ? mergeResults(perQueryFormatted)
        : perQueryFormatted[0] || [];

      if (isMerge) {
        process.stderr.write(
          `ℹ️  merged ${subQueries.length} queries → ${formattedResults.length} unique results\n`,
        );
      }

      restoreConsole();
      const mode = getOutputMode();
      if (mode === "tty") {
        outputSuccess(formatSearchResultsPretty(formattedResults));
      } else if (mode === "compact" || mode === "markdown" || mode === "refs") {
        outputSuccess(renderTextFormat(formattedResults, mode));
      } else if (options.fields && options.fields.length > 0) {
        outputSuccess(formattedResults.map((r) => filterFields(r, options.fields)));
      } else {
        outputSuccess(formattedResults);
      }
    } finally {
      restoreConsole();
    }
  } catch (error) {
    restoreConsole();
    console.error(formatErrorOutput(error));
    process.exit(1);
  }
}

// Help text
export const SEARCH_HELP = `
Search Command - Real-time web search using Z.AI WebSearchPrime MCP

Usage: scoutline search <query> [options]

Options:
  --domain <d>        Limit to specific domain (e.g., github.com)
  --recency <r>       Filter by time: oneDay, oneWeek, oneMonth, oneYear, noLimit
  --content-size <s>  Content size: medium, high
  --location <l>      Location hint: cn, us
  --count <n>         Limit number of results
  --max-summary <n>   Truncate each result summary to <n> chars (JSON modes only)
  --fields <a,b,c>    Field allowlist for JSON output (e.g. title,url)
  --merge             Treat the query as multiple sub-queries split on '|'.
                      Runs them in parallel, dedupes by URL, ranks by how many
                      sub-queries surfaced each result. Escapes: '\\|' for literal pipe.

Output formats (--output-format / -O):
  data       JSON array (default, token-efficient)
  json       Envelope-wrapped JSON {success, data, timestamp}
  pretty     Pretty-printed json
  compact    "title — url" per line (no summaries)
  markdown   Numbered markdown list with summaries
  refs       "[N] title — url" per line (citation style)

Examples:
  scoutline search "React 19 new features"
  scoutline search "Node.js security" --domain nodejs.org
  scoutline search "AI news" --recency oneWeek
  scoutline search "x" -O compact                    # ultra-compact
  scoutline search "x" -O markdown --max-summary 80  # chat-ready
  scoutline search "x" --fields title,url            # field-filtered JSON
  scoutline search --merge "rust async|rust tokio|rust runtime"  # multi-query merge

Default JSON shape:
  [
    {
      "rank": 1,
      "title": "Page title",
      "url": "https://...",
      "summary": "Page summary",
      "source": "example.com",
      "date": "2024-01-15",
      "occurrences": 2   // only present with --merge when >1
    }
  ]
`.trim();
