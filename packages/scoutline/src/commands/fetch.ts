/**
 * fetch command — direct, evidentiary HTTP client (ADR-0006).
 *
 * Consolidates binary-safe direct retrieval and raw REST API calls:
 *
 *   - Evidentiary GET (default): byte-exact, streaming to --out with --md5
 *     hash verification, real browser User-Agent, following redirects.
 *   - Structured API: --method, --data (@body.json or inline), --header.
 *
 * This command is credential-free (no AI provider, no adapter, no LLM
 * translation) and is dispatched before credentialed config load.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { CommandResult, TextOutputMode } from "../command-invocation.js";
import { invokeCommand } from "../command-invocation.js";
import type { OutputMode } from "../lib/output.js";
import { ValidationError, FileError, TimeoutError, NetworkError, ApiError } from "../lib/errors.js";
import type { HandlerDependencies } from "../index.js";

export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export const DEFAULT_FETCH_TIMEOUT_MS = 30000;

export const FETCH_HELP = `
scoutline fetch <url> [options] - Direct, binary-safe HTTP client

Options:
  --out <file>             Save response body directly to a local file
  --md5                    Compute and report MD5 checksum of the response
  --raw                    Emit raw body content directly
  --ua <agent>             Custom User-Agent string (default: Chromium)
  --method <verb>          HTTP method: GET, POST, PUT, DELETE, PATCH, HEAD (default: GET)
  --data <@file|string>    Request body (prefix with @ to read from a local file)
  --header, -H <K:V>       Custom HTTP header (can be specified multiple times)
  --timeout <ms>           Request timeout in milliseconds (default: 30000)
  --help, -h               Show this help message

Global Options:
  --output-format, -O      Output format: data, json, pretty, compact, markdown, refs, tty
`.trim();

export interface FetchOptions {
  readonly out?: string;
  readonly md5?: boolean;
  readonly raw?: boolean;
  readonly ua?: string;
  readonly method?: string;
  readonly data?: string;
  readonly headers?: readonly string[];
  readonly timeout?: number;
}

export interface FetchResultData {
  readonly schemaVersion: 1;
  readonly url: string;
  readonly finalUrl: string;
  readonly status: number;
  readonly statusText: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly bytes: number;
  readonly md5?: string;
  readonly outPath?: string;
  readonly contentType?: string;
  readonly content?: string;
}

/**
 * Validate that a URL starts with http:// or https://.
 */
export function validateFetchUrl(url: string): void {
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    throw new ValidationError(
      "URL must start with http:// or https://",
      "Pass a valid HTTP or HTTPS URL, e.g. scoutline fetch https://example.com/data.json",
    );
  }
}

/**
 * Parse fetch CLI arguments supporting multi-flag headers (-H / --header).
 */
export function parseFetchArgs(args: readonly string[]): {
  readonly options: FetchOptions;
  readonly positional: readonly string[];
  readonly showHelp: boolean;
} {
  let out: string | undefined;
  let md5 = false;
  let raw = false;
  let ua: string | undefined;
  let method: string | undefined;
  let data: string | undefined;
  let timeout: number | undefined;
  let showHelp = false;
  const headers: string[] = [];
  const positional: string[] = [];

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === undefined) break;

    if (arg === "--help" || arg === "-h") {
      showHelp = true;
      i++;
    } else if (arg === "--md5") {
      md5 = true;
      i++;
    } else if (arg === "--raw") {
      raw = true;
      i++;
    } else if (arg === "--out") {
      const next = args[i + 1];
      if (!next || next.startsWith("-")) {
        throw new ValidationError("--out requires a file path argument.");
      }
      out = next;
      i += 2;
    } else if (arg === "--ua") {
      const next = args[i + 1];
      if (!next || next.startsWith("-")) {
        throw new ValidationError("--ua requires a User-Agent string argument.");
      }
      ua = next;
      i += 2;
    } else if (arg === "--method") {
      const next = args[i + 1];
      if (!next || next.startsWith("-")) {
        throw new ValidationError("--method requires an HTTP verb argument.");
      }
      method = next.toUpperCase();
      i += 2;
    } else if (arg === "--data") {
      const next = args[i + 1];
      if (next === undefined) {
        throw new ValidationError("--data requires a payload argument.");
      }
      data = next;
      i += 2;
    } else if (arg === "--header" || arg === "-H") {
      const next = args[i + 1];
      if (!next || !next.includes(":")) {
        throw new ValidationError(
          `${arg} requires a "Header: Value" argument.`,
          'Example: -H "Authorization: Bearer token"',
        );
      }
      headers.push(next);
      i += 2;
    } else if (arg === "--timeout") {
      const next = args[i + 1];
      if (!next || !/^\d+$/.test(next)) {
        throw new ValidationError("--timeout requires a positive integer in milliseconds.");
      }
      timeout = Number(next);
      i += 2;
    } else if (!arg.startsWith("-")) {
      positional.push(arg);
      i++;
    } else {
      // Unknown option — ignore or let invokeCommand handle global options
      i++;
    }
  }

  return {
    options: {
      ...(out ? { out } : {}),
      ...(md5 ? { md5: true } : {}),
      ...(raw ? { raw: true } : {}),
      ...(ua ? { ua } : {}),
      ...(method ? { method } : {}),
      ...(data !== undefined ? { data } : {}),
      ...(headers.length > 0 ? { headers } : {}),
      ...(timeout !== undefined ? { timeout } : {}),
    },
    positional,
    showHelp,
  };
}

/**
 * Pure execution of the fetch operation.
 */
export async function executeFetch(
  url: string,
  options: FetchOptions = {},
): Promise<FetchResultData> {
  validateFetchUrl(url);

  const method = options.method ?? "GET";
  const validMethods = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"];
  if (!validMethods.includes(method)) {
    throw new ValidationError(
      `Unsupported HTTP method "${method}".`,
      `Valid methods: ${validMethods.join(", ")}`,
    );
  }

  // Parse headers
  const reqHeaders: Record<string, string> = {
    "User-Agent": options.ua ?? DEFAULT_USER_AGENT,
    Accept: "*/*",
  };

  if (options.headers) {
    for (const h of options.headers) {
      const colonIdx = h.indexOf(":");
      if (colonIdx > 0) {
        const k = h.slice(0, colonIdx).trim();
        const v = h.slice(colonIdx + 1).trim();
        reqHeaders[k] = v;
      }
    }
  }

  // Parse body
  let reqBody: string | Buffer | undefined;
  if (options.data !== undefined) {
    if (method === "GET" || method === "HEAD") {
      throw new ValidationError(`Cannot send request body with HTTP ${method}.`);
    }
    if (options.data.startsWith("@")) {
      const filePath = path.resolve(process.cwd(), options.data.slice(1));
      try {
        reqBody = await fs.readFile(filePath);
      } catch (err) {
        throw new FileError(
          `Failed to read request body file "${filePath}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } else {
      reqBody = options.data;
    }
  }

  const timeoutMs = options.timeout ?? DEFAULT_FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: reqHeaders,
      body: reqBody,
      redirect: "follow",
      signal: controller.signal,
    });
  } catch (err: unknown) {
    if (controller.signal.aborted) {
      throw new TimeoutError(timeoutMs, `Direct fetch timed out after ${timeoutMs}ms`);
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new NetworkError(`Fetch failed: ${msg}`);
  } finally {
    clearTimeout(timer);
  }

  const resHeaders: Record<string, string> = {};
  response.headers.forEach((val, key) => {
    resHeaders[key.toLowerCase()] = val;
  });

  const contentType = resHeaders["content-type"] || undefined;
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const bytes = buffer.length;

  let md5: string | undefined;
  if (options.md5) {
    md5 = crypto.createHash("md5").update(buffer).digest("hex");
  }

  let outPath: string | undefined;
  if (options.out) {
    outPath = path.resolve(process.cwd(), options.out);
    try {
      await fs.mkdir(path.dirname(outPath), { recursive: true });
      await fs.writeFile(outPath, buffer);
    } catch (err) {
      throw new FileError(
        `Failed to write output file "${outPath}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Decode content string for text-compatible bodies
  let content: string | undefined;
  const isBinary =
    contentType &&
    !contentType.includes("text") &&
    !contentType.includes("json") &&
    !contentType.includes("xml") &&
    !contentType.includes("javascript") &&
    !contentType.includes("csv") &&
    !contentType.includes("html");

  if (!isBinary || !options.out) {
    try {
      content = buffer.toString("utf8");
    } catch {
      // Leave undefined if decoding fails
    }
  }

  return {
    schemaVersion: 1,
    url,
    finalUrl: response.url || url,
    status: response.status,
    statusText: response.statusText,
    headers: resHeaders,
    bytes,
    ...(md5 ? { md5 } : {}),
    ...(outPath ? { outPath: options.out } : {}),
    ...(contentType ? { contentType } : {}),
    ...(content !== undefined ? { content } : {}),
  };
}

/**
 * Invocation-seam command wrapper returning CommandResult.
 */
export async function fetchCommand(
  url: string,
  options: FetchOptions = {},
): Promise<CommandResult<FetchResultData>> {
  const data = await executeFetch(url, options);

  let presentationText = "";
  if (options.out) {
    const md5Text = data.md5 ? ` (MD5: ${data.md5})` : "";
    presentationText = `Fetched ${data.bytes} bytes from ${data.url} -> ${options.out}${md5Text} [HTTP ${data.status}]`;
  } else if (options.raw && data.content !== undefined) {
    presentationText = data.content;
  } else if (data.content !== undefined) {
    presentationText = data.content;
  } else {
    presentationText = `[Binary payload: ${data.bytes} bytes, HTTP ${data.status}]`;
  }

  const presentations: Partial<Record<TextOutputMode, string>> = {
    tty: presentationText,
    compact: presentationText,
    markdown: presentationText,
    refs: presentationText,
  };

  return {
    kind: "data",
    data,
    presentations,
    exitCode: data.status >= 400 ? 1 : 0,
  };
}

/**
 * Handler invoked by the dispatcher in `src/index.ts`.
 */
export async function handleFetch(
  args: string[],
  outputMode: OutputMode,
  deps: HandlerDependencies,
): Promise<number> {
  const { options, positional, showHelp } = parseFetchArgs(args);

  if (showHelp || positional.length === 0) {
    deps.invocation.writeStdout(FETCH_HELP);
    return 0;
  }

  const url = positional[0]!;
  return invokeCommand(
    deps.invocation,
    () => fetchCommand(url, options),
    outputMode,
    deps.now,
    deps.secrets,
  );
}
