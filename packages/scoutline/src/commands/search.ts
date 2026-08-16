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
  SearchType,
} from "../capabilities/search.js";
import type { ResponseCache } from "../lib/cache.js";
import type { RetryPolicy } from "../lib/execution.js";
import { executeSearch } from "../lib/execution.js";
import { canonicalUrl } from "../lib/url.js";
import type { ProviderId } from "../providers/types.js";
import { formatSearchResultsPretty } from "../lib/tty.js";

type RecencyFilter = "oneDay" | "oneWeek" | "oneMonth" | "oneYear" | "noLimit";

export interface SearchOptions {
  count?: number;
  domain?: string;
  recency?: RecencyFilter;
  contentSize?: "medium" | "high";
  location?: "cn" | "us";
  topic?: SearchTopic;
  type?: SearchType;
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
  /**
   * Provenance (fan-out only, DESIGN D3): distinct providers that
   * surfaced this URL, in first-encounter order. Omitted on the
   * single-provider path — SCHEMA.md.
   */
  mergedFrom?: ProviderId[];
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
  if (options.type) controls.type = options.type;
  return Object.keys(controls).length > 0 ? controls : undefined;
}

/**
 * One arm of a merge grid: a Provider's results split into sub-queries.
 * `provider` is absent on the single-provider `--merge` path (no
 * provenance is tracked there); the fan-out path always sets it.
 */
export interface MergeGridArm {
  provider?: ProviderId;
  results: FormattedResult[][];
}

export interface MergeResultsOptions {
  /** Emit mergedFrom provenance on every result (fan-out active). */
  emitMergedFrom?: boolean;
  /** Post-merge --count cap. Each arm was already asked for this count. */
  count?: number;
}

/**
 * Merge results from an (arm × sub-query) grid (DESIGN D3). Generalizes
 * the pre-fan-out sub-query merge with exactly one new key: dedupe by
 * `canonicalUrl(url)` (DESIGN D4) instead of the raw string. Ranking is
 * unchanged — (occurrence count desc, best position asc) — but
 * `occurrences` now counts across the whole arms × sub-queries grid.
 * First-writer-wins: the earlier arm's title/summary/url win a collision
 * (arm order is the tiebreak priority). Every URL accumulates
 * `mergedFrom` (distinct providers, first-encounter order) when
 * `emitMergedFrom` is set, and the merged list is sliced to `count`
 * post-merge. The single-provider `--merge` path and the fan-out path
 * share this one implementation.
 */
export function mergeResults(
  grid: MergeGridArm[],
  options: MergeResultsOptions = {},
): FormattedResult[] {
  const { emitMergedFrom = false, count } = options;
  const map = new Map<
    string,
    FormattedResult & { occurrences: number; bestPos: number; mergedFrom: ProviderId[] }
  >();
  for (const arm of grid) {
    for (const results of arm.results) {
      for (const r of results) {
        // canonicalUrl is the Map key only; the emitted url stays the
        // first writer's original string (DESIGN D3 "Identity").
        const key = canonicalUrl(r.url);
        const existing = map.get(key);
        if (existing) {
          existing.occurrences += 1;
          existing.bestPos = Math.min(existing.bestPos, r.rank);
          if (emitMergedFrom && arm.provider && !existing.mergedFrom.includes(arm.provider)) {
            existing.mergedFrom.push(arm.provider);
          }
        } else {
          map.set(key, {
            ...r,
            occurrences: 1,
            bestPos: r.rank,
            mergedFrom: emitMergedFrom && arm.provider ? [arm.provider] : [],
          });
        }
      }
    }
  }
  let merged = Array.from(map.values());
  merged.sort((a, b) => {
    if (b.occurrences !== a.occurrences) return b.occurrences - a.occurrences;
    return a.bestPos - b.bestPos;
  });
  // Post-merge --count slice (each arm was already asked for this count).
  if (count !== undefined) {
    merged = merged.slice(0, Math.max(0, count));
  }
  return merged.map((r, i) => {
    const { bestPos: _bp, ...rest } = r;
    void _bp;
    const rank = i + 1;
    if (!emitMergedFrom) {
      // Omit mergedFrom entirely on the single path (SCHEMA.md) so the
      // emitted objects stay byte-identical to the pre-fan-out merge.
      const { mergedFrom: _mf, ...restNoProvenance } = rest;
      void _mf;
      return { ...restNoProvenance, rank };
    }
    return { ...rest, rank };
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

  // The single-provider --merge path and the fan-out path (Ticket 3)
  // share one merge implementation. The single path passes no provider
  // and no count, so its output is byte-identical to the pre-fan-out
  // merge (no mergedFrom field, no post-merge slice).
  const formattedResults: FormattedResult[] = isMerge
    ? mergeResults([{ results: perQueryFormatted }])
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
Search Command - Real-time web search (Z.AI, MiniMax, Tavily, Exa, or Brave)

Usage: scoutline search <query> [options]

Provider selection (precedence: explicit flag, then SCOUTLINE_PROVIDER, then zai):
  --provider <zai|minimax|tavily|exa|brave|firecrawl|parallel|perplexity|jina>   Select the search provider (default: zai)
  SCOUTLINE_PROVIDER=<id>                 Fallback when --provider is not passed

Note: support for the optional controls below varies by provider AND by
control — a control accepted by one provider may be rejected
(UNSUPPORTED_OPTION) by another before invocation. Run
\`scoutline doctor\` for the live per-provider support matrix rather than
relying on a fixed list here.

Options:
  --topic <t>         Search topic hint (all providers): general, news, finance
                      (default: general). Z.AI/MiniMax append a keyword to the
                      query; Tavily passes it natively; Exa maps it to a
                      category; Brave uses a news endpoint for \`news\`.
  --type <video>      Content-type axis; supported by Brave (\`video\`).
                      Mutually exclusive with --topic.
  --domain <d>        Limit to specific domain (provider support varies; e.g., github.com)
  --recency <r>       Filter by time (provider support varies): oneDay, oneWeek, oneMonth, oneYear, noLimit
  --content-size <s>  Depth/size. medium = default. high maps per provider:
                      Z.AI content_size; Tavily search_depth=advanced; Exa accepted;
                      Brave → LLM Context (extracted passages); MiniMax rejected
                      (UNSUPPORTED_OPTION).
  --location <l>      Location hint (provider support varies): cn, us
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
