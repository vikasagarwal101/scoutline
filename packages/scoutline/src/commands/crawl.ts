/**
 * Crawl command — thin handler over the Crawl Capability
 * (tech-plan §2a, §8).
 *
 * The handler applies parse-level validation (URL scheme), delegates to
 * `capability.fetch(request)` through the generic shared execution
 * wrapper (`executeCachedOperation`), then projects the normalized
 * `CrawlResult` into the public envelope. The Adapter owns URL
 * validation, credentials, transport, raw response parsing, cache
 * identity, and error normalization; the handler owns projection
 * (`--max-chars` whole-envelope Output Budget at the dispatcher
 * seam) and output-mode presentation.
 *
 * Provider selection, capability support, configuration, Adapter
 * construction, and adapter.crawl agreement live in `src/index.ts`.
 *
 * Cache stores full content; `truncated` and `originalContentLength`
 * are handler projections (mirrors reader).
 */

import type { CommandContext, CommandResult } from "../command-invocation.js";
import type {
  CrawlCapability,
  CrawlRequest,
  CrawlResult,
  CrawlPage,
} from "../capabilities/crawl.js";
import type { ExecutionDependencies } from "../lib/execution.js";
import { executeCachedOperation } from "../lib/execution.js";
import { OUTPUT_MODES } from "../lib/output.js";
import { ValidationError } from "../lib/errors.js";
import type { LadderRule } from "../lib/output-budget.js";

// ---------------------------------------------------------------------------
// Option and dependency types
// ---------------------------------------------------------------------------

export interface CrawlOptions {
  readonly depth?: number;
  readonly breadth?: number;
  readonly limit?: number;
  readonly selectPaths?: string;
  readonly excludePaths?: string;
  readonly instructions?: string;
  readonly format?: "markdown" | "text";
  readonly contentSize?: "medium" | "high";
  readonly timeout?: number;
  readonly noCache?: boolean;
  readonly maxChars?: number;
}

/**
 * Dependencies injected by `src/index.ts` after Provider selection,
 * capability support check, configuration check, Adapter construction,
 * and adapter.crawl agreement.
 */
export interface CrawlHandlerDependencies {
  readonly capability: CrawlCapability;
  readonly execution: ExecutionDependencies;
}

// ---------------------------------------------------------------------------
// Parse-level validation
// ---------------------------------------------------------------------------

function validateUrl(url: string): void {
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    throw new ValidationError("URL must start with http:// or https://");
  }
}

// ---------------------------------------------------------------------------
// Projection helpers
// ---------------------------------------------------------------------------

/**
 * Apply `--max-chars` truncation to a single page's content. Mirrors the
 * reader's truncation contract: slice to `max - 1`, trim trailing
 * whitespace, append `…`.
 */
function truncateContent(
  content: string,
  max?: number,
): { text: string; originalLen: number; truncated: boolean } {
  const originalLen = content.length;
  if (!max || max <= 0 || originalLen <= max) {
    return { text: content, originalLen, truncated: false };
  }
  return { text: content.slice(0, max - 1).trimEnd() + "…", originalLen, truncated: true };
}

/**
 * Build the Provider-neutral CrawlRequest from CrawlOptions. Only fields
 * that affect the Provider request or the cache identity appear here;
 * `--max-chars`, `--no-cache`, and output mode never enter the request.
 */
function buildCrawlRequest(url: string, options: CrawlOptions): CrawlRequest {
  const request: { url: string } & Record<string, unknown> = { url };
  if (options.depth !== undefined) request.depth = options.depth;
  if (options.breadth !== undefined) request.breadth = options.breadth;
  if (options.limit !== undefined) request.limit = options.limit;
  if (options.selectPaths !== undefined) request.selectPaths = options.selectPaths;
  if (options.excludePaths !== undefined) request.excludePaths = options.excludePaths;
  if (options.instructions !== undefined) request.instructions = options.instructions;
  if (options.format !== undefined) request.format = options.format;
  if (options.contentSize !== undefined) request.contentSize = options.contentSize;
  if (options.timeout !== undefined) request.timeout = options.timeout;
  return request as CrawlRequest;
}

/**
 * Project a CrawlPage into the output envelope shape. When `--max-chars`
 * is set, each page gains `truncated` and `originalContentLength`.
 */
interface ProjectedPage {
  readonly url: string;
  readonly content: string;
  readonly contentFormat: "markdown" | "text";
  readonly truncated?: boolean;
  readonly originalContentLength?: number;
}

function projectPage(page: CrawlPage, maxChars?: number): ProjectedPage {
  if (!maxChars || maxChars <= 0) {
    return { url: page.url, content: page.content, contentFormat: page.contentFormat };
  }
  const { text, originalLen, truncated } = truncateContent(page.content, maxChars);
  return {
    url: page.url,
    content: text,
    contentFormat: page.contentFormat,
    truncated,
    originalContentLength: originalLen,
  };
}

function buildCrawlPresentations(
  pages: ProjectedPage[],
): Readonly<Partial<Record<string, string>>> {
  const urls = pages.map((p) => p.url);
  const compact = urls.join("\n");
  const refs = urls.map((u, i) => `[${i + 1}] ${u}`).join("\n");
  const markdown = pages.map((p) => `## ${p.url}\n\n${p.content}`).join("\n\n---\n\n");
  return { compact, markdown, refs, tty: markdown };
}

// ---------------------------------------------------------------------------
// Output Budget ladder (ADR-0007, T4)
// ---------------------------------------------------------------------------

/**
 * Crawl ladder: seed url + status survive (every page's `url` and the
 * envelope's `baseUrl`/`totalPages` are never-cut by omission); page
 * content trims; the TRAILING pages (urls) drop late — cheapest loss
 * is the last page's body, then earlier bodies, then trailing URLs.
 */
const trimPageContentsRule: LadderRule = {
  name: "trim-page-contents",
  apply(envelope) {
    const e = envelope as { pages?: unknown[] };
    const pages = e.pages;
    if (!pages || pages.length === 0) return envelope;
    // Backward scan (fix-round A): halve the LAST page whose content is
    // still trimmable, not just the final page. The engine's fixpoint
    // bleeds every page body before drop-trailing-pages destroys whole
    // trailing URLs whose bodies were never trimmed.
    for (let i = pages.length - 1; i >= 0; i--) {
      const page = pages[i] as { content?: string };
      const content = page.content;
      if (!content) continue;
      const stripped = content.replace(/…$/, "");
      if (stripped.length <= 1) continue;
      const half = Math.max(1, Math.floor(stripped.length / 2));
      const nextPages = [...pages];
      nextPages[i] = { ...page, content: "…" + stripped.slice(0, half) };
      return { ...e, pages: nextPages };
    }
    return envelope;
  },
};

const dropTrailingPagesRule: LadderRule = {
  name: "drop-trailing-pages",
  apply(envelope) {
    const e = envelope as { pages?: unknown[]; totalPages?: number };
    const pages = e.pages;
    if (!pages || pages.length <= 1) return envelope;
    return { ...e, pages: pages.slice(0, -1), totalPages: pages.length - 1 };
  },
};

/** The crawl Output Budget ladder (ordered; see ADR-0007 T4). */
export const CRAWL_LADDER = [trimPageContentsRule, dropTrailingPagesRule] as const;

/**
 * Output Budget T4: rebuild every text presentation from a budgeted
 * projection so -O compact/markdown/refs/tty reflect the shrunken
 * pages. Thin passthrough over `buildCrawlPresentations` — no separate
 * render logic to drift. Exported for the handler seam (index.ts).
 */
export function rebuildBudgetedCrawlPresentations(
  pages: readonly { url: string; content: string }[],
): Readonly<Partial<Record<string, string>>> {
  return buildCrawlPresentations(pages as ProjectedPage[]);
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function crawl(
  url: string,
  options: CrawlOptions = {},
  deps: CrawlHandlerDependencies,
  _context?: CommandContext,
): Promise<CommandResult> {
  validateUrl(url);

  const request = buildCrawlRequest(url, options);

  const result: CrawlResult = await executeCachedOperation(
    deps.capability.fetch,
    request,
    { noCache: options.noCache === true },
    deps.execution,
  );

  // Projection: apply --max-chars per page. The cache stores full content;
  // truncation state is recomputed on every read.
  const projectedPages = result.pages.map((page) => projectPage(page, options.maxChars));

  const envelope: Record<string, unknown> = {
    schemaVersion: 1,
    baseUrl: result.baseUrl,
    pages: projectedPages,
    totalPages: result.totalPages,
  };

  return { kind: "data", data: envelope, presentations: buildCrawlPresentations(projectedPages) };
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

const OUTPUT_MODE_LIST = OUTPUT_MODES.join(" | ");

export const CRAWL_HELP = `
Crawl Command - Crawl a website starting from a URL (Provider Capability)

Usage: scoutline crawl <url> [options]

Crawls pages starting from <url>, following links up to the configured
depth and breadth. Returns a structured result with an array of pages.

Provider selection (precedence: --provider, then SCOUTLINE_PROVIDER,
then the configured default):
  - Tavily, Firecrawl, and Spider.cloud advertise the crawl Capability and supply the Adapter.
  - Z.AI and MiniMax do NOT advertise crawl. By default (0.11.0+) Provider
    fallback emits a stderr notice and silently reroutes to the next
    eligible configured supplier (Tavily, Firecrawl, or Spider.cloud). Under
    --no-fallback (or SCOUTLINE_NO_FALLBACK=1) the preflight surfaces
    UNSUPPORTED_CAPABILITY for the selected non-supplier.

> Accepted async risk: for \`crawl\`, a runtime failure on the effective
> Provider may fall back to another Provider even if the failed Provider
> had already accepted or charged a job (Firecrawl/Tavily do not offer
> idempotency or refunds). Pass --no-fallback for cost-sensitive
> workflows. See
> https://github.com/vikasagarwal101/scoutline/blob/main/docs/adr/0002-provider-fallback.md
> (the ADR is not packaged with the npm tarball; follow the link).

Options:
  --depth <n>          Crawl depth, 1-5 (default: 1)
  --breadth <n>        Max links to follow per page, 1-500 (default: 20)
  --limit <n>          Total pages to process (default: 50)
  --select-paths <rx>  Comma-separated regex patterns to select URL paths
  --exclude-paths <rx> Comma-separated regex patterns to exclude URL paths
  --instructions <t>   Natural language instructions for page selection
  --format <f>         Output format: markdown (default), text
  --content-size <s>   Extraction depth: medium (default), high
  --timeout <s>        Request timeout in seconds (default: 150)
  --max-chars <n>      Fit the whole printed output in ~<n> chars (page
                        contents trim, trailing pages drop late; page urls
                        never cut; full untrimmed crawl saved to the
                        artifacts store — recover via "scoutline history show")
  --no-cache           Bypass the response cache for this invocation

Common Options:
  --provider <id>            Override the active Provider (zai | minimax | tavily | exa | brave | firecrawl | parallel | perplexity | jina | you | linkup | spider)
  --output-format <mode>     One of: ${OUTPUT_MODE_LIST} (default: data)
  -O <mode>                  Alias for --output-format

Output format (schema-version-1):
  {
    "schemaVersion": 1,
    "baseUrl":         "<the URL you passed>",
    "pages": [
      {
        "url":            "<page URL>",
        "content":        "<page body as markdown/text>",
        "contentFormat":  "markdown" | "text",
        "truncated":      false,          // present when --max-chars is set
        "originalContentLength": <number>  // present when --max-chars is set
      }
    ],
    "totalPages": <number>
  }

Examples:
  scoutline crawl https://docs.example.com --depth 1
  scoutline crawl https://example.com --depth 2 --breadth 10 --limit 20
  scoutline crawl https://docs.example.com --select-paths "/api/.*,/guide/.*"
  scoutline crawl https://example.com --format text --max-chars 2000
  scoutline --provider tavily crawl https://example.com --depth 3
`.trim();
