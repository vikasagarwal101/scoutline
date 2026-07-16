/**
 * Web reader command using Z.AI WebReader MCP
 */

import { ZaiMcpClient } from "../lib/mcp-client.js";
import { outputSuccess, getOutputMode } from "../lib/output.js";
import { formatErrorOutput, ValidationError } from "../lib/errors.js";
import { silenceConsole, restoreConsole } from "../lib/silence.js";
import { extract, isExtractMode, type ExtractMode } from "../lib/extract.js";

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
  fullEnvelope?: boolean;
  extract?: ExtractMode;
}

/**
 * Rewrite rendered GitHub gist/file URLs to their raw form so Z.AI's reader
 * returns pure file content instead of the rendered HTML page chrome
 * (Sign in / Star / Fork / Embed / etc.).
 *
 *   gist.github.com/<user>/<id>            -> gist.github.com/<user>/<id>/raw
 *   gist.github.com/<user>/<id>#file-...   -> gist.github.com/<user>/<id>/raw
 *
 * Leaves alone: URLs that already end in /raw, /raw/<rev>, or have a query string.
 */
function maybeRewriteToRaw(url: string): string {
  // Already raw? Leave alone.
  if (/\/raw(\/|$|\?|#)/.test(url)) return url;
  // Only rewrite gist.github.com (not github.com/owner/repo — that's different)
  const m = url.match(/^(https?:\/\/gist\.github\.com\/[^/]+\/[^/#?]+)(?:[/?#]|$)/);
  if (!m) return url;
  const base = m[1];
  // Append /raw, preserve any fragment (file anchor still meaningful)
  const frag = url.indexOf("#") >= 0 ? url.slice(url.indexOf("#")) : "";
  return `${base}/raw${frag}`;
}

/**
 * Pull just the content string out of a Z.AI reader response. The full envelope
 * (title, url, metadata, external) is rarely useful for agents — it just bloats
 * output and makes truncation limits harder to reason about.
 */
function extractContent(response: unknown): { content: string; original: unknown } {
  if (typeof response === "string") return { content: response, original: response };
  if (response && typeof response === "object") {
    const obj = response as { content?: string };
    if (typeof obj.content === "string") {
      return { content: obj.content, original: response };
    }
  }
  // Fallback: stringify whatever we got
  return { content: JSON.stringify(response), original: response };
}

/**
 * Truncate to max chars. Returns the (possibly truncated) content plus the
 * original length so the caller can warn about truncation.
 */
function truncate(
  content: string,
  max?: number,
): { text: string; originalLen: number; truncated: boolean } {
  const originalLen = content.length;
  if (!max || max <= 0 || originalLen <= max) {
    return { text: content, originalLen, truncated: false };
  }
  return { text: content.slice(0, max - 1).trimEnd() + "…", originalLen, truncated: true };
}

export async function read(url: string, options: ReadOptions = {}): Promise<void> {
  // Validate URL first (before silencing)
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    console.error(
      formatErrorOutput(new ValidationError("URL must start with http:// or https://")),
    );
    process.exit(1);
  }

  if (options.extract && !isExtractMode(options.extract)) {
    console.error(
      formatErrorOutput(
        new ValidationError(
          `Invalid --extract mode: ${options.extract}. Use one of: code, links, tables, headings`,
        ),
      ),
    );
    process.exit(1);
  }

  const finalUrl = maybeRewriteToRaw(url);
  if (finalUrl !== url) {
    process.stderr.write(`ℹ️  rewrote gist URL to raw form: ${finalUrl}\n`);
  }

  silenceConsole();
  const client = new ZaiMcpClient({ enableVision: false, noCache: options.noCache });
  try {
    try {
      const response = await client.webRead({
        url: finalUrl,
        format: options.format || "markdown",
        retainImages: !options.noImages,
        withLinksSummary: options.withLinks,
        timeout: options.timeout,
        noCache: options.noCache,
        noGfm: options.noGfm,
        keepImgDataUrl: options.keepImgDataUrl,
        withImagesSummary: options.withImagesSummary,
      });

      const { content: rawContent } = extractContent(response);

      // --extract short-circuits: returns the extracted slice as a JSON array,
      // bypassing truncation and envelope logic.
      if (options.extract) {
        const extracted = extract(rawContent, options.extract);
        process.stderr.write(`ℹ️  extracted ${extracted.length} ${options.extract}\n`);
        outputSuccess(extracted);
        return;
      }

      const { text, originalLen, truncated } = truncate(rawContent, options.maxChars);

      if (truncated) {
        process.stderr.write(
          `⚠️  content truncated from ${originalLen.toLocaleString()} to ${text.length.toLocaleString()} chars; use a higher --max-chars or omit it for full content\n`,
        );
      }

      // Default: content-only (drops title/metadata/external envelope).
      // --full-envelope or --output-format json/pretty keeps the structured object.
      const wantEnvelope =
        options.fullEnvelope || getOutputMode() === "json" || getOutputMode() === "pretty";
      if (wantEnvelope) {
        const envelope =
          response && typeof response === "object"
            ? { ...(response as object), content: text }
            : { content: text };
        outputSuccess(envelope);
      } else {
        outputSuccess(text);
      }
    } finally {
      await client.close().catch(() => {});
      restoreConsole();
    }
  } catch (error) {
    console.error(formatErrorOutput(error));
    process.exit(1);
  }
}

// Help text
export const READ_HELP = `
Read Command - Fetch and parse web page content using Z.AI WebReader MCP

Usage: scoutline read <url> [options]

URL handling:
  gist.github.com/<user>/<id> URLs are auto-rewritten to /raw so you get pure
  file content instead of rendered HTML chrome (Sign in / Star / Fork / Embed).

Options:
  --format <f>    Output format: markdown (default), text
  --no-images     Remove images from output
  --no-cache      Disable server-side caching
  --with-links    Include links summary
  --with-images-summary  Include images summary
  --no-gfm        Disable GitHub Flavored Markdown
  --keep-img-data-url  Keep image data URLs in output
  --timeout <s>   Request timeout in seconds (default: 20)
  --max-chars <n> Truncate content to <n> chars (warns on stderr when it kicks in)
  --full-envelope Include title/url/metadata/external fields (default: content-only)
  --extract <m>   Pull a specific slice out as JSON array: code | links | tables | headings

By default the command outputs just the page content (string). Use --full-envelope
or --output-format json/pretty to get the full structured response object. Use
--extract to return only matching elements (e.g. all code blocks, all links).

Examples:
  scoutline read https://docs.example.com/api
  scoutline read https://github.com/owner/repo --format text
  scoutline read https://gist.github.com/user/abc123          # auto-rewritten to /raw
  scoutline read https://blog.example.com/post --no-images --with-links
  scoutline read https://example.com/long-article --max-chars 2000
  scoutline read https://react.dev/learn/hooks --extract code        # just code blocks
  scoutline read https://example.com/page --extract links            # just URLs
  scoutline read https://en.wikipedia.org/wiki/X --extract headings  # section outline

Output format:
  Content string by default; structured object with --full-envelope or -O json;
  JSON array of extracted elements with --extract.
`.trim();
