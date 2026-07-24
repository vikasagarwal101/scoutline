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
 * (`--max-chars` per-page truncation) and output-mode presentation.
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
  - Tavily advertises the crawl Capability and supplies the Adapter.
  - Z.AI and MiniMax do NOT advertise crawl. Selecting them returns
    UNSUPPORTED_CAPABILITY with no fallback.

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
  --max-chars <n>      Truncate each page's content to <n> chars
                       (projection only; cache stores full content)
  --no-cache           Bypass the response cache for this invocation

Common Options:
  --provider <id>            Override the active Provider (zai | minimax | tavily | exa | firecrawl)
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
