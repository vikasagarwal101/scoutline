/**
 * Web search command.
 *
 * P2-05: the command receives an injected SearchCapability and shared
 * execution dependencies instead of constructing a Provider client.
 * The command owns query splitting, parallel scheduling, normalized
 * merge, rank, occurrence, truncation, projection, notices, and
 * presentations; the Adapter owns credentials, transport, and Provider
 * field mapping. Count is applied AFTER normalization by shared
 * execution and never enters an Adapter request or cache identity.
 */

import type { CommandContext, CommandResult, DataCommandResult } from "../command-invocation.js";
import type {
  SearchCapability,
  SearchControls,
  SearchRequest,
  SearchSource,
  SearchTopic,
} from "../capabilities/search.js";
import type { ResponseCache } from "../lib/cache.js";
import type { RetryPolicy } from "../lib/execution.js";
import { executeSearch } from "../lib/execution.js";
import { formatSearchResultsPretty } from "../lib/tty.js";

type RecencyFilter = "oneDay" | "oneWeek" | "oneMonth" | "oneYear" | "noLimit";

export interface SearchOptions {
  count?: number;
  domain?: string;
  recency?: RecencyFilter;
  contentSize?: "medium" | "high";
  location?: "cn" | "us";
  topic?: SearchTopic;
  maxSummary?: number;
  fields?: string[];
  noCache?: boolean;
  merge?: boolean;
}

/**
 * Shared execution dependencies the search command consumes. The
 * Capability and cache/sleep/random are injected so tests run fully
 * offline; production wires the real Adapter from the selected Provider
 * and the default on-disk cache.
 */
export interface SearchExecutionDependencies {
  readonly capability: SearchCapability;
  readonly cache: ResponseCache;
  readonly sleep: (ms: number) => Promise<void>;
  readonly random: () => number;
  readonly retryPolicy?: RetryPolicy;
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
 * Build Provider controls from command options. Every field is optional;
 * an Adapter that does not accept a control (MiniMax) rejects it inside
 * `validate` before any SDK access (FR-012).
 */
function buildControls(options: SearchOptions): SearchControls | undefined {
  const controls: SearchControls = {};
  if (options.domain) controls.domain = options.domain;
  if (options.recency) controls.recency = options.recency;
  if (options.contentSize) controls.contentSize = options.contentSize;
  if (options.location) controls.location = options.location;
  if (options.topic) controls.topic = options.topic;
  return Object.keys(controls).length > 0 ? controls : undefined;
}

/**
 * Merge results from N parallel sub-queries: dedupe by URL, rank by
 * (occurrence count desc, then best position asc). First sub-query's
 * title/summary wins for each URL (highest-priority query).
 */
function mergeResults(byQuery: FormattedResult[][]): FormattedResult[] {
  const map = new Map<string, FormattedResult & { occurrences: number; bestPos: number }>();
  for (const [, results] of byQuery.entries()) {
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
        });
      }
    }
  }
  const merged = Array.from(map.values());
  merged.sort((a, b) => {
    if (b.occurrences !== a.occurrences) return b.occurrences - a.occurrences;
    return a.bestPos - b.bestPos;
  });
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

function buildPresentations(
  formattedResults: FormattedResult[],
): NonNullable<DataCommandResult["presentations"]> {
  return {
    compact: renderTextFormat(formattedResults, "compact"),
    markdown: renderTextFormat(formattedResults, "markdown"),
    refs: renderTextFormat(formattedResults, "refs"),
    tty: formatSearchResultsPretty(formattedResults),
  };
}

/** Format a normalized SearchSource[] into ranked FormattedResult[]. */
function formatSources(sources: readonly SearchSource[], maxSummary?: number): FormattedResult[] {
  return sources.map((s, i) => {
    const formatted: FormattedResult = {
      rank: i + 1,
      title: s.title,
      url: s.url,
      summary: truncate(s.summary, maxSummary),
    };
    if (s.source) formatted.source = s.source;
    if (s.date) formatted.date = s.date;
    return formatted;
  });
}

export async function search(
  query: string,
  options: SearchOptions = {},
  deps: SearchExecutionDependencies,
  context?: CommandContext,
): Promise<CommandResult> {
  const { capability, cache, sleep, random, retryPolicy } = deps;

  // Split query on `|` if --merge is set. Empty fragments are dropped.
  // A literal pipe in a single query can be escaped as `\|` (won't split).
  let subQueries: string[] = [query];
  if (options.merge) {
    subQueries = query
      .split(/(?<!\\)\|/)
      .map((q) => q.replace(/\\\|/g, "|").trim())
      .filter((q) => q.length > 0);
    if (subQueries.length === 0) {
      throw new Error("--merge requires at least one non-empty query (split with '|')");
    }
  }

  const isMerge = subQueries.length > 1;
  const controls = buildControls(options);
  const executionDeps = { cache, sleep, random };
  // One executeSearch per sub-query. Each Adapter isolates its own
  // transport per invocation, so the command does not manage client
  // counts or close transports.
  const perQuerySources = await Promise.all(
    subQueries.map((q) => {
      const request: SearchRequest = controls ? { query: q, controls } : { query: q };
      return executeSearch(
        capability,
        request,
        {
          count: options.count,
          noCache: options.noCache,
          retryPolicy,
        },
        executionDeps,
      );
    }),
  );
  const perQueryFormatted: FormattedResult[][] = perQuerySources.map((sources) =>
    formatSources(sources, options.maxSummary),
  );

  const formattedResults: FormattedResult[] = isMerge
    ? mergeResults(perQueryFormatted)
    : perQueryFormatted[0] || [];

  if (isMerge && context) {
    context.notice(
      `ℹ️  merged ${subQueries.length} queries → ${formattedResults.length} unique results`,
    );
  }

  const presentations = buildPresentations(formattedResults);

  const data =
    options.fields && options.fields.length > 0
      ? formattedResults.map((r) => filterFields(r, options.fields))
      : formattedResults;

  return { kind: "data", data, presentations };
}

// Help text
export const SEARCH_HELP = `
Search Command - Real-time web search (Z.AI, MiniMax, Tavily, or Exa)

Usage: scoutline search <query> [options]

Provider selection (precedence: explicit flag, then SCOUTLINE_PROVIDER, then zai):
  --provider <zai|minimax|tavily|exa>   Select the search provider (default: zai)
  SCOUTLINE_PROVIDER=<id>           Fallback when --provider is not passed

Note: --domain, --recency, and --content-size are accepted by Z.AI,
Tavily, and Exa; --location is Z.AI-only. Unsupported controls are
rejected (UNSUPPORTED_OPTION) before invocation when --provider minimax
is selected. --topic is accepted by all providers.

Options:
  --topic <t>         Search topic hint (all providers): general, news, finance
                      (default: general). Z.AI/MiniMax append a keyword to the
                      query; Tavily passes it natively; Exa maps it to a category.
  --domain <d>        Limit to specific domain (Z.AI, Tavily, Exa; e.g., github.com)
  --recency <r>       Filter by time (Z.AI, Tavily, Exa): oneDay, oneWeek, oneMonth, oneYear, noLimit
  --content-size <s>  Content size (Z.AI, Tavily, Exa): medium, high
  --location <l>      Location hint (Z.AI only): cn, us
  --count <n>         Limit number of results (applied after normalization)
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
  scoutline --provider minimax search "AI news"
  SCOUTLINE_PROVIDER=minimax scoutline search "AI news"
  scoutline --provider tavily search "AI funding rounds" --topic news
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
