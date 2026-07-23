/**
 * Web reader command — thin handler over the Reader Capability
 * (DESIGN.md §18, reader-migration-core-flows, reader-migration-tech-plan
 * Ticket 04).
 *
 * The handler applies parse-level validation only (URL scheme, --extract
 * mode), delegates to `capability.fetch(request)` through shared
 * execution, then projects the normalized `ReaderFetchResult` into the
 * public v1 envelope(s) (content read vs extract read). The Adapter
 * (providers/zai/reader.ts) owns URL rewrite, credentials, transport,
 * raw response parsing, cache identity, and retry/terminal
 * classification; the handler owns projection (`--max-chars` truncation,
 * `--extract` slicing), output-mode presentation, and the
 * schema-version-1 envelope migration.
 *
 * Provider selection, capability support, configuration, Adapter
 * construction, and adapter.reader agreement live in `src/index.ts`.
 *
 * Handler interface (P6-07A pattern): `deps: ReadHandlerDependencies`
 * is REQUIRED — production and direct tests cross the same compile-
 * checked Interface. An optional trailing `CommandContext` follows when
 * a caller wants to surface per-invocation context; the handler does
 * not currently read it. A `CommandContext` is NOT a valid substitute
 * for `deps`.
 *
 * Output-mode behavior (core-flows table):
 *
 *   - data: the envelope object (content or extract).
 *   - json / pretty: standard `{success, data, timestamp}` envelope.
 *   - compact / markdown / refs / tty:
 *       * content read → the `content` string directly (presentations).
 *       * extract read → JSON fallback (the extract envelope object);
 *         no presentation override because extracted items are data,
 *         not prose.
 *
 * `--full-envelope` is silently accepted and ignored (D3): the v1
 * envelope is always returned.
 */

import type { CommandContext, CommandResult } from "../command-invocation.js";
import type {
  ReaderCapability,
  ReaderFetchRequest,
  ReaderFetchResult,
} from "../capabilities/reader.js";
import type { ExecutionDependencies } from "../lib/execution.js";
import { executeReaderOperation } from "../lib/execution.js";
import { OUTPUT_MODES } from "../lib/output.js";
import { ValidationError } from "../lib/errors.js";
import { extract, isExtractMode, type ExtractMode } from "../lib/extract.js";

// ---------------------------------------------------------------------------
// Option and dependency types
// ---------------------------------------------------------------------------

export interface ReadOptions {
  format?: "markdown" | "text";
  noImages?: boolean;
  withLinks?: boolean;
  timeout?: number;
  noCache?: boolean;
  noGfm?: boolean;
  keepImgDataUrl?: boolean;
  withImagesSummary?: boolean;
  maxChars?: number;
  /**
   * Silently accepted and ignored at v1 (core-flows D3). The envelope
   * is always returned. Retained on the options type so callers and
   * `handleRead` parse it without errors; it never reaches the Adapter
   * request, the cache identity, or the projection.
   */
  fullEnvelope?: boolean;
  extract?: ExtractMode;
}

/**
 * Dependencies injected by `src/index.ts` after Provider selection,
 * capability support check, configuration check, Adapter construction,
 * and adapter.reader agreement. The handler never resolves a Provider
 * descriptor itself. Required — a caller that omits `deps` is malformed
 * and fails loudly (a `CommandContext` is NOT a valid substitute).
 */
export interface ReadHandlerDependencies {
  readonly capability: ReaderCapability;
  readonly execution: ExecutionDependencies;
}

// ---------------------------------------------------------------------------
// Parse-level validation
// ---------------------------------------------------------------------------

/**
 * Validate the URL at parse time. Only `http://` and `https://` schemes
 * are accepted; everything else is a terminal `ValidationError` that
 * fires BEFORE Provider resolution. Mirrors the v0.2 contract so direct
 * handler tests keep their assertion shape.
 */
function validateUrl(url: string): void {
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    throw new ValidationError("URL must start with http:// or https://");
  }
}

/**
 * Validate `--extract` mode at parse time. An invalid value is a
 * terminal `ValidationError` that fires BEFORE Provider resolution.
 */
function validateExtractMode(mode: ExtractMode | undefined): void {
  if (mode !== undefined && !isExtractMode(mode)) {
    throw new ValidationError(
      `Invalid --extract mode: ${mode}. Use one of: code, links, tables, headings`,
    );
  }
}

// ---------------------------------------------------------------------------
// Projection helpers
// ---------------------------------------------------------------------------

/**
 * Apply `--max-chars` truncation to content. Mirrors the v0.2 contract:
 * slice to `max - 1`, trim trailing whitespace, and append `…`. Returns
 * the original text and `truncated: false` when no truncation occurs.
 */
function truncateContent(
  content: string,
  max?: number,
): {
  text: string;
  originalLen: number;
  truncated: boolean;
} {
  const originalLen = content.length;
  if (!max || max <= 0 || originalLen <= max) {
    return { text: content, originalLen, truncated: false };
  }
  return { text: content.slice(0, max - 1).trimEnd() + "…", originalLen, truncated: true };
}

/**
 * Build the Provider-neutral ReaderFetchRequest from ReadOptions. Built
 * as a single fresh object so the readonly invariants on
 * `ReaderFetchRequest` are honored. `--max-chars`, `--extract`,
 * `--full-envelope`, `--no-cache`, and output mode NEVER appear here —
 * they are projections applied after the cached normalized result.
 */
function buildReaderRequest(url: string, options: ReadOptions): ReaderFetchRequest {
  const request: { url: string } & Record<string, unknown> = { url };
  if (options.format) request.format = options.format;
  if (options.noImages !== undefined) request.retainImages = !options.noImages;
  if (options.withLinks !== undefined) request.withLinksSummary = options.withLinks;
  if (options.noGfm !== undefined) request.noGfm = options.noGfm;
  if (options.keepImgDataUrl !== undefined) request.keepImgDataUrl = options.keepImgDataUrl;
  if (options.withImagesSummary !== undefined) {
    request.withImagesSummary = options.withImagesSummary;
  }
  if (options.timeout !== undefined) request.timeout = options.timeout;
  return request as ReaderFetchRequest;
}

/**
 * Build the v1 content-read envelope. `truncated` and
 * `originalContentLength` are projection state recomputed on every read;
 * the cache stores the full content.
 */
function buildContentEnvelope(
  result: ReaderFetchResult,
  text: string,
  originalLen: number,
  truncated: boolean,
): Record<string, unknown> {
  // Preserve metadata/external verbatim when present on the cached
  // result. Built as a fresh object so the readonly invariants on
  // `ReaderFetchResult` are honored.
  const envelope: Record<string, unknown> = {
    schemaVersion: 1,
    url: result.url,
    finalUrl: result.finalUrl,
    title: result.title,
    content: text,
    contentFormat: result.contentFormat,
    truncated,
    originalContentLength: originalLen,
  };
  if (result.metadata !== undefined) envelope.metadata = result.metadata;
  if (result.external !== undefined) envelope.external = result.external;
  return envelope;
}

/**
 * Build the v1 extract-read envelope. `items` carry the extracted
 * slice; `originalItemCount` and `truncated` report projection state.
 * `--max-chars` is intentionally IGNORED for extract reads
 * (truncating a code block or link list mid-item is harmful).
 */
function buildExtractEnvelope(
  result: ReaderFetchResult,
  mode: ExtractMode,
  items: unknown[],
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    url: result.url,
    finalUrl: result.finalUrl,
    mode,
    items,
    truncated: false,
    originalItemCount: items.length,
  };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Read web page content through the injected Reader Capability.
 *
 * Ordering:
 *   1. Parse-level validation (URL scheme, --extract mode). Throws
 *      `ValidationError` BEFORE the Adapter or shared execution is
 *      reached.
 *   2. Build the Provider-neutral request and delegate to
 *      `executeProviderOperation` with shared cache + retry policy.
 *   3. Project the normalized result:
 *      - `--extract` slicing into the extract envelope (sets `mode`,
 *        `items`, `originalItemCount`); `--max-chars` is IGNORED.
 *      - Otherwise, `--max-chars` truncation on `content` (sets
 *        `truncated`, `originalContentLength`).
 *   4. Set presentations so text-oriented modes (compact/markdown/
 *      refs/tty) emit `content` directly for content reads. Extract
 *      reads omit presentations; text modes then fall back to JSON
 *      (the extract envelope), matching the core-flows table.
 */
export async function read(
  url: string,
  options: ReadOptions = {},
  deps: ReadHandlerDependencies,
  _context?: CommandContext,
): Promise<CommandResult> {
  // 1. Parse-level validation BEFORE Provider/Adapter work.
  validateUrl(url);
  validateExtractMode(options.extract);

  // 2. Build the Provider-neutral request. Only fields that affect
  //    the Provider request or the cache identity appear here;
  //    --max-chars, --extract, --full-envelope, --no-cache, and
  //    output mode never enter the request.
  const request = buildReaderRequest(url, options);

  const result = await executeReaderOperation(
    deps.capability.fetch,
    request,
    { noCache: options.noCache === true },
    deps.execution,
  );

  // 3. Projection.
  if (options.extract) {
    const items = extract(result.content, options.extract);
    const envelope = buildExtractEnvelope(result, options.extract, items);
    // No presentation override for extract reads: text modes fall
    // back to JSON (the envelope) because extracted items are data,
    // not prose.
    return { kind: "data", data: envelope };
  }

  const { text, originalLen, truncated } = truncateContent(result.content, options.maxChars);
  const envelope = buildContentEnvelope(result, text, originalLen, truncated);

  // 4. Presentations: text-oriented modes emit `content` directly for
  //    content reads (D4 — Reader content is naturally prose). All
  //    four text modes share the same value because the page body is
  //    the same prose regardless of mode.
  return {
    kind: "data",
    data: envelope,
    presentations: {
      compact: text,
      markdown: text,
      refs: text,
      tty: text,
    },
  };
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

/**
 * Canonical output-mode list for `--output-format`. Derived from the
 * shared `OUTPUT_MODES` contract so the help text cannot drift from
 * the accepted set.
 */
const OUTPUT_MODE_LIST = OUTPUT_MODES.join(" | ");

export const READ_HELP = `
Read Command - Fetch and parse web pages (Provider Capability)

Usage: scoutline read <url> [options]

URL handling:
  gist.github.com/<user>/<id> URLs are auto-rewritten to /raw by the
  Z.AI Adapter so you get pure file content instead of rendered HTML
  chrome (Sign in / Star / Fork / Embed). The rewritten URL surfaces
  as finalUrl in the v1 result.

Provider selection (precedence: --provider, then SCOUTLINE_PROVIDER,
then zai):
  - The 'read' command participates in Provider selection.
  - Z.AI advertises the reader Capability and supplies the Adapter;
    selecting zai routes Read through it.
  - Tavily also advertises the reader Capability (powered by the
    Tavily extract endpoint). Selecting tavily routes Read through
    the Tavily Adapter. Some Z.AI-only options
    (--with-links, --no-gfm, --keep-img-data-url, --with-images-summary)
    are rejected with UNSUPPORTED_OPTION when tavily is selected.
  - MiniMax does NOT advertise reader. Selecting minimax (explicitly
    or via SCOUTLINE_PROVIDER) returns UNSUPPORTED_CAPABILITY with
    no fallback to Z.AI.

Options:
  --format <f>    Output format: markdown (default), text
  --no-images     Remove images from output
  --no-cache      Bypass the response cache for this invocation
  --with-links    Include links summary
  --with-images-summary  Include images summary
  --no-gfm        Disable GitHub Flavored Markdown
  --keep-img-data-url  Keep image data URLs in output
  --timeout <s>   Request timeout in seconds (default: 20)
  --max-chars <n> Truncate content to <n> chars (content reads only)
  --full-envelope Silently accepted and ignored. The envelope is always
                  returned at schema-version-1 (deprecation: D3).
  --extract <m>   Pull a specific slice out as a typed envelope with
                  mode/items/originalItemCount. Mode is one of:
                  code | links | tables | headings

Common Options:
  --provider <id>            Override the active Provider (zai | minimax | tavily | firecrawl)
  --output-format <mode>     One of: ${OUTPUT_MODE_LIST} (default: data)
  -O <mode>                  Alias for --output-format

Output format (schema-version-1 migration):
  Content read (default):
    {
      "schemaVersion": 1,
      "url":             "<the URL you passed>",
      "finalUrl":        "<the URL the Adapter fetched>",
      "title":           "<page title or null>",
      "content":         "<page body as markdown/text>",
      "contentFormat":   "markdown" | "text",
      "truncated":       false,
      "originalContentLength": <number>
    }
  Extract read (--extract <mode>):
    {
      "schemaVersion": 1,
      "url":             "<the URL you passed>",
      "finalUrl":        "<the URL the Adapter fetched>",
      "mode":            "code" | "links" | "tables" | "headings",
      "items":           [<typed items per mode>],
      "truncated":       false,
      "originalItemCount": <number>
    }
  --max-chars applies ONLY to content reads (sets truncated:true and
  originalContentLength). --max-chars is IGNORED for extract reads —
  truncating a code block or link list mid-item is harmful.

Output modes for read results:
  - data: raw schema-version-1 envelope object.
  - json / pretty: standard {success, data, timestamp} envelope
    (indent 0 for json, indent 2 for pretty).
  - compact / markdown / refs / tty:
    * content read → the content string is emitted directly (Reader
      content is naturally prose).
    * extract read → JSON fallback (the extract envelope object).
      Extracted items are data, not prose, so the text-oriented modes
      do not synthesize a presentation for them.

Examples:
  scoutline read https://docs.example.com/api
  scoutline read https://github.com/owner/repo --format text
  scoutline read https://gist.github.com/user/abc123          # finalUrl shows /raw
  scoutline read https://blog.example.com/post --no-images --with-links
  scoutline read https://example.com/long-article --max-chars 2000
  scoutline read https://react.dev/learn/hooks --extract code        # code blocks
  scoutline read https://example.com/page --extract links            # links
  scoutline read https://en.wikipedia.org/wiki/X --extract headings  # section outline
  scoutline --provider minimax read https://example.com/   # UNSUPPORTED_CAPABILITY
  scoutline --provider tavily read https://example.com/    # Tavily-backed extract
`.trim();
