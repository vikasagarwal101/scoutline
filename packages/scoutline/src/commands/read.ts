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
 * classification; the handler owns projection (`--max-chars`
 * whole-envelope budgeting at the dispatcher seam, `--extract` slicing), output-mode presentation, and the
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
import { wasBudgetWalked, type LadderRule } from "../lib/output-budget.js";

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
 * `--max-chars` budgets the whole envelope at the handler seam
 * (index.ts, READ_EXTRACT_LADDER): field VALUES trim, field names and
 * URLs are never dropped.
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
// Output Budget ladder (ADR-0007, T4)
// ---------------------------------------------------------------------------

/**
 * Content-read ladder: url/title never cut (envelope fields — no rule
 * touches them); headings are never cut MID-VALUE (no rule rewrites a
 * heading line), but the drop rule removes whole trailing sections —
 * headings included — at crush budgets. The LAST paragraphs trim
 * first (highest paragraph index = cheapest loss); the BOTTOM
 * sections drop late. `content` is markdown prose — sections are
 * `#{1,6}` heading blocks; within a surviving section the trim walks
 * paragraphs from the end.
 */
const trimLastParagraphsRule: LadderRule = {
  name: "trim-last-paragraphs",
  apply(envelope) {
    const e = envelope as { content?: string; truncated?: boolean };
    const content = e.content;
    if (!content) return envelope;
    const lines = content.split("\n");
    // Backward scan (fix-round A): halve the LAST line that is still
    // trimmable — the last paragraph's lines first, then earlier ones,
    // so the fixpoint bleeds every body before drop-bottom-sections
    // destroys whole trailing sections. Heading LINES are never trim
    // candidates (fix-round B): /^#{1,6}\s/ lines are skipped even
    // when a heading is the document's last line — no heading is ever
    // cut mid-value (the DROP rule can still remove a heading together
    // with its whole section at crush budgets).
    // Fix-round R2: fence-aware trim — never touch fenced code lines
    // (rewriting ```ts to …```typ corrupts the fence) and never trim
    // heading lines: ATX (incl. up to 3 leading spaces), Setext
    // underlines (===/---), or the title line above a Setext underline.
    const fenced: boolean[] = new Array<boolean>(lines.length).fill(false);
    let inFence = false;
    // R5/R6: a fence closes with a run of the OPENING delimiter's
    // char at least as long as the opening run (CommonMark) — a `~~~`
    // line inside a ``` block, or a ``` line inside a ```` fence, must
    // not flip the state.
    let fenceChar: "`" | "~" | undefined;
    let fenceLen = 0;
    for (let k = 0; k < lines.length; k++) {
      // R7: CommonMark both ways — an opening run needs 3+ delimiters
      // (a 1-2 backtick run is inline code, never a fence) and a
      // closing run must be followed by spaces ONLY (`` ```js `` is
      // content; only a bare closer ends the fence).
      const fenceMatch = /^ {0,3}((`|~)\2{2,})(.*)$/.exec(lines[k]!);
      if (fenceMatch) {
        fenced[k] = true;
        const run = fenceMatch[1]!;
        const thisChar = run[0] as "`" | "~";
        const tail = fenceMatch[3]!;
        if (!inFence) {
          inFence = true;
          fenceChar = thisChar;
          fenceLen = run.length;
        } else if (
          thisChar === fenceChar &&
          run.length >= fenceLen &&
          tail.trim() === ""
        ) {
          inFence = false;
          fenceChar = undefined;
          fenceLen = 0;
        }
        continue;
      }
      fenced[k] = inFence || /^ {0,3}(?: {4}|\t)/.test(lines[k]!);
    }
    const isHeadingLine = (idx: number): boolean => {
      const line = lines[idx]!;
      if (/^ {0,3}#{1,6}\s/.test(line)) return true;
      if (/^ {0,3}(?:=+|-+)\s*$/.test(line)) return true;
      const next = idx + 1 < lines.length ? lines[idx + 1]! : "";
      if (line.trim().length > 0 && /^ {0,3}(?:=+|-+)\s*$/.test(next)) return true;
      return false;
    };
    for (let i = lines.length - 1; i >= 0; i--) {
      if (fenced[i] === true || isHeadingLine(i)) continue;
      // Marker protocol (R3): strip ONE leading omission marker ONLY on
      // subsequent passes (wasBudgetWalked(e) || e.truncated === true — the ladder itself
      // flipped it). A source-content leading "…" on the first pass rides
      // into the kept prefix instead of being mistaken for a marker.
      const hasPriorMarker = wasBudgetWalked(e) || e.truncated === true;
      const clean = (hasPriorMarker ? lines[i]!.replace(/^…/, "") : lines[i]!).replace(/…$/, "");
      if (clean.length <= 1) continue;
      const half = Math.max(1, Math.floor(clean.length / 2));
      const next = [...lines];
      // Fix-round (review): halve the MARKER-FREE text — every pass
      // rebuilds exactly ONE leading omission marker (accumulating
      // "………" markers wasted budget and misread as stacked omissions)
      // and the replacement is strictly shorter than the line it
      // replaces (the engine's exhaust check).
      const replacement = "…" + clean.slice(0, half);
      if (replacement.length >= lines[i]!.length) continue;
      next[i] = replacement;
          // Fix-round (review): content changed — flip a pre-existing
    // `truncated: false` to true (truth flags: README/troubleshooting
    // promise this). Conditional so the flip never ADDS the key (that
    // would inflate first-pass size and defeat the engine's shrink
    // check); the seam stamps envelopes that never had one.
      return e.truncated === false
        ? { ...e, content: next.join("\n"), truncated: true }
        : { ...e, content: next.join("\n") };
    }
    return envelope;
  },
};

interface Section {
  /** `null` = the pre-heading preamble (fix-round B: a document with no headings is ONE section). */
  heading: string | null;
  bodyLines: string[];
}

function splitSections(content: string): Section[] {
  const sections: Section[] = [];
  let current: Section = { heading: null, bodyLines: [] };
  // Fix-round R2: fence-aware (a ``` fenced `# comment` is code, never a
  // heading) and indented-ATX-aware; a whitespace-only-or-empty preamble
  // merges into the following heading so the drop rule can never pop the
  // root section off and leave the preamble.
  let inFence = false;
  // R5/R6: a fence closes with a run of the OPENING delimiter's char
  // at least as long as the opening run — a ~~~ line inside a ```
  // block, or a ``` line inside a ```` fence, does not end the fence
  // (so a later fenced `# x` stays code, never a section heading).
  let fenceChar: "`" | "~" | undefined;
  let fenceLen = 0;
  for (const line of content.split("\n")) {
    // R7: same CommonMark open/close rules as the trim scanner — 3+
    // delimiter run to open, spaces-only tail to close.
    const fenceMatch = /^ {0,3}((`|~)\2{2,})(.*)$/.exec(line);
    if (fenceMatch) {
      const run = fenceMatch[1]!;
      const thisChar = run[0] as "`" | "~";
      const tail = fenceMatch[3]!;
      if (!inFence) {
        inFence = true;
        fenceChar = thisChar;
        fenceLen = run.length;
      } else if (
        thisChar === fenceChar &&
        run.length >= fenceLen &&
        tail.trim() === ""
      ) {
        inFence = false;
        fenceChar = undefined;
        fenceLen = 0;
      }
    }
    const match = !inFence ? line.match(/^ {0,3}(#{1,6})\s+(.*)$/) : null;
    if (match) {
      // An EMPTY preamble is not a section of its own (floor-shape
      // fix): otherwise the drop rule's `length <= 1` guard counts the
      // phantom preamble and lets every heading-bearing section drop,
      // killing the root heading at crush budgets. Merging it into the
      // following heading section keeps the document root as section 1.
      // Whitespace-only lines count as empty here (R2): leading blank
      // lines must not promote the preamble to a droppable section.
      if (current.heading === null && current.bodyLines.every((l) => l.trim() === "")) {
        current = { heading: line, bodyLines: [] };
      } else {
        sections.push(current);
        current = { heading: line, bodyLines: [] };
      }
    } else {
      current.bodyLines.push(line);
    }
  }
  sections.push(current);
  return sections;
}

const dropBottomSectionsRule: LadderRule = {
  name: "drop-bottom-sections",
  apply(envelope) {
    const e = envelope as { content?: string; truncated?: boolean };
    const content = e.content;
    if (!content) return envelope;
    const sections = splitSections(content);
    if (sections.length <= 1) return envelope;
    sections.pop();
        // Fix-round (review): content changed — flip a pre-existing
    // `truncated: false` to true (truth flags: README/troubleshooting
    // promise this). Conditional so the flip never ADDS the key (that
    // would inflate first-pass size and defeat the engine's shrink
    // check); the seam stamps envelopes that never had one.
    const rejoined = sections
      .map((s) => [...(s.heading ? [s.heading] : []), ...s.bodyLines].join("\n"))
      .join("\n");
    return e.truncated === false
      ? { ...e, content: rejoined, truncated: true }
      : { ...e, content: rejoined };
  },
};

/**
 * Extract-read ladder (D8): trim field VALUES (`code`, `markdown`,
 * `text`, `slug`), never drop field names or URLs. Only field NAMES
 * and `url` VALUES are never-cut: `url` is the one value the rule
 * exempts (below); every other string value (`language`, `slug`,
 * `code`, `text`, …) DOES trim at extreme budgets (D8's letter — trim
 * values, never drop names/URLs). `items` never shrink: an item is
 * the unit of extraction.
 */
const trimItemValuesRule: LadderRule = {
  name: "trim-item-values",
  apply(envelope) {
    const e = envelope as { items?: unknown[]; truncated?: boolean };
    const items = e.items;
    if (!items || items.length === 0) return envelope;
    let changed = false;
    const next = items.map((item) => {
      if (item === null || typeof item !== "object") return item;
      const row = item as Record<string, unknown>;
      let trimmed = false;
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(row)) {
        if (typeof value === "string" && value.length > 1 && key !== "url") {
          // Marker protocol (R3): same rule as the content trim — only
          // strip a leading marker the ladder itself emitted.
          const clean = (wasBudgetWalked(e) || e.truncated === true ? value.replace(/^…/, "") : value).replace(/…$/, "");
          const half = Math.max(1, Math.floor(clean.length / 2));
          // Fix-round (review): halve the MARKER-FREE text (exactly ONE
          // omission marker across repeated passes) and skip values the
          // halving cannot strictly shrink.
          const replacement = "…" + clean.slice(0, half);
          if (replacement.length >= value.length) {
            out[key] = value; // keep the field — skipping the copy would DROP the name
          } else {
            out[key] = replacement;
            trimmed = true;
          }
        } else {
          out[key] = value;
        }
      }
      if (trimmed) changed = true;
      return out;
    });
    if (!changed) return envelope;
        // Fix-round (review): content changed — flip a pre-existing
    // `truncated: false` to true (truth flags: README/troubleshooting
    // promise this). Conditional so the flip never ADDS the key (that
    // would inflate first-pass size and defeat the engine's shrink
    // check); the seam stamps envelopes that never had one.
    return e.truncated === false
      ? { ...e, items: next, truncated: true }
      : { ...e, items: next };
  },
};

/**
 * The read Output Budget ladder: content reads walk
 * trim-last-paragraphs → drop-bottom-sections; extract reads walk
 * trim-item-values only (exported separately — the two envelope shapes
 * share one command but never one ladder).
 */
export const READ_LADDER = [trimLastParagraphsRule, dropBottomSectionsRule] as const;
export const READ_EXTRACT_LADDER = [trimItemValuesRule] as const;

/**
 * Output Budget T4: rebuild the text presentations from a budgeted
 * content projection so -O compact/markdown/refs/tty reflect the
 * shrunken `content` (the same string every text mode emits).
 */
export function budgetedContentPresentations(content: string): {
  compact: string;
  markdown: string;
  refs: string;
  tty: string;
} {
  return { compact: content, markdown: content, refs: content, tty: content };
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
 *        `items`, `originalItemCount`); whole-envelope `--max-chars`
 *        budgeting happens at the handler seam (index.ts, READ_EXTRACT_LADDER).
 *      - Otherwise, whole-envelope `--max-chars` budgeting at the
 *        handler seam (index.ts, READ_LADDER); the legacy per-field
 *        `truncateContent` projection is retired by ADR-0007.
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
  // Byte-exact modes are fetch-only (ADR-0006 §8): the Reader path
  // returns provider-normalized content and cannot be byte-faithful.
  // Reject removed flags loudly instead of accepting and dropping them.
  const removedByteModes = options as { raw?: boolean; pdf?: unknown; pdfRepair?: boolean };
  if (
    removedByteModes.raw === true ||
    removedByteModes.pdf !== undefined ||
    removedByteModes.pdfRepair === true
  ) {
    throw new ValidationError(
      "read no longer supports --raw/--pdf/--pdf-repair: Reader content is provider-normalized. For byte-exact retrieval use `scoutline fetch <url> --raw` (verbatim body) or `scoutline fetch <url> --pdf text` / `--pdf raw` (add `--pdf-repair` for damaged PDFs); see `scoutline fetch --help`.",
    );
  }

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

  // The envelope reports exactly what the Reader provider returned
  // (`contentFormat: markdown|text`). Client-side relabeling or
  // reconstruction of provider-normalized content is intentionally
  // absent — byte-exact retrieval is `fetch`'s contract.
  // ADR-0007 (T4): whole-envelope `--max-chars` budgeting lives at the
  // handler seam (index.ts, READ_LADDER) — applied AFTER this return.
  // Without the flag this envelope is byte-identical to the pre-T4
  // shape (truncateContent with no max is the identity).
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
  - Exa and Firecrawl also advertise the reader Capability. Selecting
    exa or firecrawl routes Read through their Adapters; some Z.AI-only
    options are rejected with UNSUPPORTED_OPTION.
  - Parallel AI (Extract API), Jina AI (r.jina.ai), Linkup
    (api.linkup.so), and Spider.cloud (api.spider.cloud) also
    advertise reader. Selecting parallel, jina, linkup, or spider
    routes Read through their Adapters; some Z.AI-only options
    are rejected with UNSUPPORTED_OPTION.
    Jina supports keyless access (no API key required).
    Linkup renders page JavaScript by default and honors --timeout;
    --format text, --no-images, --with-links, --no-gfm,
    --keep-img-data-url, and --with-images-summary are rejected with
    UNSUPPORTED_OPTION (the Linkup /fetch endpoint has no equivalent).
    Spider.cloud sends the locked four-field /scrape body and rejects
    every Z.AI-only reader option.
  - MiniMax, Brave, and Perplexity do NOT advertise reader. By default (0.11.0+)
    Provider fallback emits a stderr notice and silently reroutes to
    the next eligible configured supplier (zai, tavily, exa,
    firecrawl, parallel, jina, linkup, or spider). Under --no-fallback (or SCOUTLINE_NO_FALLBACK=1) the
    preflight surfaces UNSUPPORTED_CAPABILITY for the selected
    non-supplier.

Options:
  --format <f>    Output format: markdown (default), text
  --no-images     Remove images from output
  --no-journal    Skip the research journal entry for this one call
                  (journaling is on by default; see
                  \`scoutline history --help\`)
  --no-cache      Bypass the response cache for this invocation
  --with-links    Include links summary
  --with-images-summary  Include images summary
  --no-gfm        Disable GitHub Flavored Markdown
  --keep-img-data-url  Keep image data URLs in output
  --timeout <s>   Request timeout in seconds (default: 20)
  --max-chars <n> Fit the whole printed output in ~<n> chars (later
                     paragraphs trim, bottom sections drop; url/title never
                     cut; headings are never cut mid-value but whole
                     sections (heading included) can drop at crush budgets;
                     extract reads trim field values only; when the budget
                     fires, the full untrimmed page is saved to the
                     artifacts store — recover via
                     "scoutline history show")
  (byte-exact PDF/raw retrieval: see "scoutline fetch --help")
  --full-envelope Silently accepted and ignored. The envelope is always
                  returned at schema-version-1 (deprecation: D3).
  --extract <m>   Pull a specific slice out as a typed envelope with
                  mode/items/originalItemCount. Mode is one of:
                  code | links | tables | headings

Common Options:
  --provider <id>            Override the active Provider (zai | minimax | tavily | exa | brave | firecrawl | parallel | perplexity | jina | you | linkup | spider)
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
  --max-chars is a whole-envelope budget on BOTH shapes; on extract
  reads it trims field VALUES only (field names and URLs are never
  dropped).

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
