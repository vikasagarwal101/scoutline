/**
 * Map command — thin handler over the Map Capability
 * (tech-plan §2b, §8).
 *
 * The handler applies parse-level validation (URL scheme), delegates to
 * `capability.fetch(request)` through the generic shared execution
 * wrapper (`executeCachedOperation`), then projects the normalized
 * `MapResult` into the public envelope. The Adapter owns URL validation,
 * credentials, transport, raw response parsing, cache identity, and
 * error normalization; the handler owns output-mode presentation only
 * (no per-page projection — Map returns URLs only).
 *
 * Provider selection, capability support, configuration, Adapter
 * construction, and adapter.map agreement live in `src/index.ts`.
 */

import type { CommandContext, CommandResult } from "../command-invocation.js";
import type { MapCapability, MapRequest, MapResult } from "../capabilities/map.js";
import type { ExecutionDependencies } from "../lib/execution.js";
import { executeCachedOperation } from "../lib/execution.js";
import { OUTPUT_MODES } from "../lib/output.js";
import { ValidationError } from "../lib/errors.js";

// ---------------------------------------------------------------------------
// Option and dependency types
// ---------------------------------------------------------------------------

export interface MapOptions {
  readonly depth?: number;
  readonly breadth?: number;
  readonly limit?: number;
  readonly selectPaths?: string;
  readonly excludePaths?: string;
  readonly instructions?: string;
  readonly noCache?: boolean;
}

/**
 * Dependencies injected by `src/index.ts` after Provider selection,
 * capability support check, configuration check, Adapter construction,
 * and adapter.map agreement.
 */
export interface MapHandlerDependencies {
  readonly capability: MapCapability;
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
// Request builder
// ---------------------------------------------------------------------------

/**
 * Build the Provider-neutral MapRequest from MapOptions. Only fields
 * that affect the Provider request or the cache identity appear here;
 * `--no-cache` and output mode never enter the request.
 */
function buildMapRequest(url: string, options: MapOptions): MapRequest {
  const request: { url: string } & Record<string, unknown> = { url };
  if (options.depth !== undefined) request.depth = options.depth;
  if (options.breadth !== undefined) request.breadth = options.breadth;
  if (options.limit !== undefined) request.limit = options.limit;
  if (options.selectPaths !== undefined) request.selectPaths = options.selectPaths;
  if (options.excludePaths !== undefined) request.excludePaths = options.excludePaths;
  if (options.instructions !== undefined) request.instructions = options.instructions;
  return request as MapRequest;
}

function buildMapPresentations(urls: readonly string[]): Readonly<Partial<Record<string, string>>> {
  const compact = urls.join("\n");
  const markdown = urls.map((u, i) => `${i + 1}. ${u}`).join("\n");
  const refs = urls.map((u, i) => `[${i + 1}] ${u}`).join("\n");
  return { compact, markdown, refs, tty: markdown };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function map(
  url: string,
  options: MapOptions = {},
  deps: MapHandlerDependencies,
  _context?: CommandContext,
): Promise<CommandResult> {
  validateUrl(url);

  const request = buildMapRequest(url, options);

  const result: MapResult = await executeCachedOperation(
    deps.capability.fetch,
    request,
    { noCache: options.noCache === true },
    deps.execution,
  );

  // Map returns URLs only — no per-page projection or truncation.
  // The envelope is the normalized result verbatim.
  const envelope: Record<string, unknown> = {
    schemaVersion: result.schemaVersion,
    baseUrl: result.baseUrl,
    urls: result.urls,
    totalUrls: result.totalUrls,
  };

  return { kind: "data", data: envelope, presentations: buildMapPresentations(result.urls) };
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

const OUTPUT_MODE_LIST = OUTPUT_MODES.join(" | ");

export const MAP_HELP = `
Map Command - Discover the URL structure of a website (Provider Capability)

Usage: scoutline map <url> [options]

Maps a website starting from <url>, returning the discovered URL set
without fetching page contents. Use this for site structure discovery
before deciding which pages to crawl or read.

Provider selection (precedence: --provider, then SCOUTLINE_PROVIDER,
then the configured default):
  - Tavily advertises the map Capability and supplies the Adapter.
  - Z.AI and MiniMax do NOT advertise map. Selecting them returns
    UNSUPPORTED_CAPABILITY with no fallback.

Options:
  --depth <n>          Map depth, 1-5 (default: 1)
  --breadth <n>        Max links to follow per page, 1-500 (default: 20)
  --limit <n>          Total URLs to discover (default: 50)
  --select-paths <rx>  Comma-separated regex patterns to select URL paths
  --exclude-paths <rx> Comma-separated regex patterns to exclude URL paths
  --instructions <t>   Natural language instructions for page selection
  --no-cache           Bypass the response cache for this invocation

Common Options:
  --provider <id>            Override the active Provider (zai | minimax | tavily | exa)
  --output-format <mode>     One of: ${OUTPUT_MODE_LIST} (default: data)
  -O <mode>                  Alias for --output-format

Output format (schema-version-1):
  {
    "schemaVersion": 1,
    "baseUrl":     "<the URL you passed>",
    "urls":        ["<discovered URL>", ...],
    "totalUrls":   <number>
  }

Examples:
  scoutline map https://docs.example.com
  scoutline map https://example.com --depth 2 --breadth 10 --limit 20
  scoutline map https://docs.example.com --select-paths "/api/.*,/guide/.*"
  scoutline --provider tavily map https://example.com --depth 3
`.trim();
