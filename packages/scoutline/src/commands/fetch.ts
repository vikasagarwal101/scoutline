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

import { createWriteStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { Readable } from "node:stream";
import type { CommandResult, TextOutputMode } from "../command-invocation.js";
import { invokeCommand } from "../command-invocation.js";
import type { OutputMode } from "../lib/output.js";
import { ValidationError, FileError, TimeoutError, NetworkError, ApiError } from "../lib/errors.js";
import { isPdfBuffer, extractPdfText, repairPdf } from "../lib/pdf.js";
import type { HandlerDependencies } from "../index.js";

export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export const DEFAULT_FETCH_TIMEOUT_MS = 30000;

/**
 * Incrementally read from a ReadableStream up to maxBytes.
 * Throws ValidationError if incoming data exceeds maxBytes without buffering the remainder.
 */
export async function readBoundedResponseBody(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  label = "Response size",
): Promise<Buffer> {
  if (!body) {
    return Buffer.alloc(0);
  }
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new ValidationError(
            `${label} (${totalBytes} bytes) exceeds in-memory ceiling (${Math.round(maxBytes / (1024 * 1024))}MB).`,
            "Use --out <file> to stream large responses directly to disk.",
          );
        }
        chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
      }
    }
    return Buffer.concat(chunks);
  } catch (err) {
    await reader.cancel().catch(() => {});
    throw err;
  }
}

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
  --pdf <text|raw>         PDF processing: text (extract text layer) or raw (preserve bytes)
  --pdf-repair             Attempt structural/xref repair on broken PDF documents
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
  readonly pdf?: "text" | "raw";
  readonly pdfRepair?: boolean;
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
  let pdf: "text" | "raw" | undefined;
  let pdfRepair = false;
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
    } else if (arg === "--ua" || arg === "-A" || arg === "--user-agent") {
      const next = args[i + 1];
      if (!next || next.startsWith("-")) {
        throw new ValidationError(`${arg} requires a User-Agent string argument.`);
      }
      ua = next;
      i += 2;
    } else if (arg === "--method" || arg === "-X") {
      const next = args[i + 1];
      if (!next || next.startsWith("-")) {
        throw new ValidationError(`${arg} requires an HTTP verb argument.`);
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
    } else if (arg === "--pdf") {
      const next = args[i + 1];
      if (next !== "text" && next !== "raw") {
        throw new ValidationError(
          `Invalid --pdf mode: "${next}".`,
          "Valid modes: text, raw.",
        );
      }
      pdf = next;
      i += 2;
    } else if (arg === "--pdf-repair") {
      pdfRepair = true;
      i++;
    } else if (arg === "--timeout") {
      const next = args[i + 1];
      if (!next || !/^\d+$/.test(next) || Number(next) <= 0) {
        throw new ValidationError("--timeout requires a positive integer in milliseconds.");
      }
      timeout = Number(next);
      i += 2;
    } else if (!arg.startsWith("-")) {
      positional.push(arg);
      i++;
    } else {
      // Global options accepted in rest stream
      if (arg === "-O" || arg === "--output-format" || arg === "--save-format") {
        i += 2;
      } else if (arg === "--save" || arg === "--save-force" || arg === "--isolated") {
        i++;
      } else {
        throw new ValidationError(
          `Unknown option: "${arg}".`,
          'Run "scoutline fetch --help" for available options.',
        );
      }
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
      ...(pdf ? { pdf } : {}),
      ...(pdfRepair ? { pdfRepair: true } : {}),
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
  const resHeaders: Record<string, string> = {};
  let contentType: string | undefined;
  let outPath: string | undefined;
  let rawBuffer: Buffer | null = null;
  let bytes = 0;
  let md5: string | undefined;
  const md5Hasher = options.md5 ? crypto.createHash("md5") : null;

  try {
    response = await fetch(url, {
      method,
      headers: reqHeaders,
      body: reqBody,
      redirect: "follow",
      signal: controller.signal,
    });

    response.headers.forEach((val, key) => {
      resHeaders[key.toLowerCase()] = val;
    });
    contentType = resHeaders["content-type"] || undefined;

    const isPdfHeader = Boolean(contentType && contentType.includes("application/pdf"));

    const MAX_IN_MEMORY_BYTES = 50 * 1024 * 1024; // 50MB ceiling without --out

    if (options.out && response.ok && response.body && !options.pdfRepair && options.pdf !== "text") {
      outPath = path.resolve(process.cwd(), options.out);
      const tempPath = `${outPath}.tmp.${process.pid}.${crypto.randomUUID()}`;
      try {
        await fs.mkdir(path.dirname(outPath), { recursive: true });
        const writeStream = createWriteStream(tempPath);
        const nodeReadable = Readable.fromWeb(
          response.body as import("node:stream/web").ReadableStream,
        );
        await new Promise<void>((resolve, reject) => {
          nodeReadable.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (md5Hasher) md5Hasher.update(chunk);
          });
          nodeReadable.pipe(writeStream);
          writeStream.on("finish", () => resolve());
          writeStream.on("error", (err) => {
            writeStream.destroy();
            reject(err);
          });
          nodeReadable.on("error", (err) => {
            writeStream.destroy();
            reject(err);
          });
        });
        await fs.rename(tempPath, outPath);
      } catch (err) {
        await fs.unlink(tempPath).catch(() => {});
        throw new FileError(
          `Failed to write output file "${outPath}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (md5Hasher) {
        md5 = md5Hasher.digest("hex");
      }
    } else {
      // Every buffered path — including error bodies reached when --out
      // cannot stream (non-ok responses have no evidentiary value worth
      // an unbounded buffer) — is subject to the same in-memory ceiling.
      const contentLengthHeader = resHeaders["content-length"];
      if (contentLengthHeader && Number(contentLengthHeader) > MAX_IN_MEMORY_BYTES) {
        throw new ValidationError(
          `Response size (${contentLengthHeader} bytes) exceeds in-memory ceiling (50MB).`,
          "Use --out <file> to stream large responses directly to disk.",
        );
      }
      rawBuffer = await readBoundedResponseBody(
        response.body as ReadableStream<Uint8Array> | null,
        MAX_IN_MEMORY_BYTES,
        "Response size",
      );
      bytes = rawBuffer.length;
      if (md5Hasher) {
        md5 = md5Hasher.update(rawBuffer).digest("hex");
      }
    }
  } catch (err: unknown) {
    if (controller.signal.aborted) {
      throw new TimeoutError(timeoutMs, `Direct fetch timed out after ${timeoutMs}ms`);
    }
    if (err instanceof FileError || err instanceof TimeoutError || err instanceof ValidationError) {
      throw err;
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new NetworkError(`Fetch failed: ${msg}`);
  } finally {
    clearTimeout(timer);
  }

  const isPdf =
    (rawBuffer !== null && isPdfBuffer(rawBuffer)) ||
    Boolean(contentType && contentType.includes("application/pdf"));

  // Decode content string for text-compatible bodies
  let content: string | undefined;
  if (isPdf && rawBuffer !== null) {
    let pdfBuf: Buffer = rawBuffer;
    if (options.pdfRepair) {
      pdfBuf = Buffer.from(await repairPdf(pdfBuf, timeoutMs));
      bytes = pdfBuf.length;
      if (md5Hasher) {
        md5 = crypto.createHash("md5").update(pdfBuf).digest("hex");
      }
    }
    if (options.pdf === "text") {
      content = await extractPdfText(pdfBuf, timeoutMs);
    }
    if (options.out && response.ok) {
      outPath = path.resolve(process.cwd(), options.out);
      const tempPath = `${outPath}.tmp.${process.pid}.${crypto.randomUUID()}`;
      try {
        await fs.mkdir(path.dirname(outPath), { recursive: true });
        await fs.writeFile(tempPath, pdfBuf);
        await fs.rename(tempPath, outPath);
      } catch (err) {
        await fs.unlink(tempPath).catch(() => {});
        throw new FileError(
          `Failed to write output file "${outPath}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  } else if (rawBuffer !== null) {
    if (options.out && response.ok) {
      outPath = path.resolve(process.cwd(), options.out);
      const tempPath = `${outPath}.tmp.${process.pid}.${crypto.randomUUID()}`;
      try {
        await fs.mkdir(path.dirname(outPath), { recursive: true });
        await fs.writeFile(tempPath, rawBuffer);
        await fs.rename(tempPath, outPath);
      } catch (err) {
        await fs.unlink(tempPath).catch(() => {});
        throw new FileError(
          `Failed to write output file "${outPath}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
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
        content = rawBuffer.toString("utf8");
      } catch {
        // Leave undefined if decoding fails
      }
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
    ...(outPath ? { outPath } : {}),
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
  forceRaw = false,
): Promise<number> {
  const { options, positional, showHelp } = parseFetchArgs(args);

  if (showHelp || positional.length === 0) {
    deps.invocation.writeStdout(FETCH_HELP);
    return 0;
  }

  const effectiveOptions: FetchOptions = {
    ...options,
    raw: forceRaw || options.raw === true,
  };

  const url = positional[0]!;
  return invokeCommand(
    deps.invocation,
    () => fetchCommand(url, effectiveOptions),
    outputMode,
    deps.now,
    deps.secrets,
  );
}
