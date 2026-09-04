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

import { createReadStream, createWriteStream } from "node:fs";
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
 * Headers permitted to follow a redirect to a different origin. An
 * ALLOWLIST, not a denylist: any caller-supplied header (X-API-Key,
 * custom auth schemes, ...) is dropped before the other origin is
 * contacted — only the transport-neutral defaults survive.
 */
const CROSS_ORIGIN_ALLOWED_HEADERS = new Set([
  "user-agent",
  "accept",
  "accept-encoding",
  // Non-credential request metadata: 307/308 replay the body, and a
  // JSON endpoint needs its Content-Type to parse it.
  "content-type",
]);

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
  --sha256                 Compute and report SHA-256 checksum (evidentiary digest)
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
  readonly sha256?: boolean;
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
  readonly sha256?: string;
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
  let sha256 = false;
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
    } else if (arg === "--sha256") {
      sha256 = true;
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
      const parsedTimeout = Number(next);
      if (
        !next ||
        !/^\d+$/.test(next) ||
        parsedTimeout <= 0 ||
        !Number.isSafeInteger(parsedTimeout)
      ) {
        throw new ValidationError(
          "--timeout requires a positive integer in milliseconds.",
          "The value must be a safe integer (e.g. 30000), not zero or an oversized digit string.",
        );
      }
      timeout = parsedTimeout;
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
      ...(sha256 ? { sha256: true } : {}),
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
    // Ask the origin for an uncompressed body: undici transparently
    // decodes Content-Encoding, so accepting gzip/br would make --out,
    // --md5, and --sha256 describe DECODED bytes rather than what the
    // origin served. With identity the received body is the wire body.
    "Accept-Encoding": "identity",
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

  // Parse body. File-backed payloads (@file) STREAM from disk so a
  // large upload cannot exhaust the CLI's heap before the request
  // starts; the path is validated (regular file) up front and retained
  // so redirect hops can reopen a FRESH stream — undici cannot replay a
  // consumed ReadableStream on 307/308.
  let dataFilePath: string | undefined;
  let inlineData: string | undefined;
  if (options.data !== undefined) {
    if (method === "GET" || method === "HEAD") {
      throw new ValidationError(`Cannot send request body with HTTP ${method}.`);
    }
    if (options.data.startsWith("@")) {
      dataFilePath = path.resolve(process.cwd(), options.data.slice(1));
      try {
        const st = await fs.stat(dataFilePath);
        if (!st.isFile()) {
          throw new FileError(
            `Request body path "${dataFilePath}" is not a regular file.`,
          );
        }
      } catch (err) {
        if (err instanceof FileError) throw err;
        throw new FileError(
          `Failed to read request body file "${dataFilePath}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } else {
      inlineData = options.data;
    }
  }
  const buildRequestBody = (): string | ReadableStream<Uint8Array> | undefined =>
    dataFilePath !== undefined
      ? (Readable.toWeb(createReadStream(dataFilePath)) as ReadableStream<Uint8Array>)
      : inlineData;

  const timeoutMs = options.timeout ?? DEFAULT_FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  const resHeaders: Record<string, string> = {};
  let contentType: string | undefined;
  let contentTypeLower: string | undefined;
  let outPath: string | undefined;
  let rawBuffer: Buffer | null = null;
  let bytes = 0;
  let md5: string | undefined;
  let sha256: string | undefined;
  const md5Hasher = options.md5 ? crypto.createHash("md5") : null;
  // SHA-256 is the evidentiary digest (collision-resistant); MD5 stays
  // for transmission-integrity compatibility. Both, when requested,
  // always describe the ORIGINAL response bytes.
  const sha256Hasher = options.sha256 ? crypto.createHash("sha256") : null;

  try {
    // Redirects are followed MANUALLY: each hop rebuilds the request
    // body (a fresh file stream for @file payloads — undici cannot
    // replay a consumed stream on 307/308) and applies the standard
    // method downgrade (301/302/303 POST -> GET, per browser and
    // undici follow semantics).
    let currentMethod = method;
    let requestUrl = url;
    let hopHeaders: Record<string, string> = reqHeaders;
    for (let hop = 0; ; hop++) {
      const hopBody = buildRequestBody();
      response = await fetch(requestUrl, {
        method: currentMethod,
        headers: hopHeaders,
        body: hopBody,
        // Required by undici for streaming request bodies (@file payloads).
        ...(hopBody !== undefined && typeof hopBody !== "string" ? { duplex: "half" as const } : {}),
        redirect: "manual",
        signal: controller.signal,
      } as RequestInit);
      const location = response.headers.get("location");
      const redirectable = [301, 302, 303, 307, 308].includes(response.status);
      if (!redirectable || !location) break;
      await response.body?.cancel().catch(() => {});
      if (hop >= 10) {
        throw new NetworkError(`Too many redirects (>10) while fetching ${url}`);
      }
      const nextUrl = new URL(location, requestUrl).toString();
      // Cross-origin redirect: never forward credential-bearing headers
      // to the other origin (fetch-spec redirect semantics). Once
      // stripped they stay stripped for later hops.
      if (new URL(nextUrl).origin !== new URL(requestUrl).origin) {
        // Allowlist (case-insensitive): caller headers never cross
        // origins; only the default transport headers survive.
        hopHeaders = Object.fromEntries(
          Object.entries(hopHeaders).filter(([key]) =>
            CROSS_ORIGIN_ALLOWED_HEADERS.has(key.toLowerCase()),
          ),
        );
      }
      requestUrl = nextUrl;
      // 303 downgrades any method except GET and HEAD (a HEAD redirect
      // must stay metadata-only, never switch to a body-downloading
      // GET); 301/302 downgrade POST per browser semantics.
      if (
        (response.status === 303 && currentMethod !== "GET" && currentMethod !== "HEAD") ||
        ((response.status === 301 || response.status === 302) && currentMethod === "POST")
      ) {
        currentMethod = "GET";
        dataFilePath = undefined;
        inlineData = undefined;
      }
    }

    response.headers.forEach((val, key) => {
      resHeaders[key.toLowerCase()] = val;
    });
    contentType = resHeaders["content-type"] || undefined;
    // Media types are case-insensitive (Text/Plain is text): normalize
    // before any classification so mixed-case types are not binary.
    contentTypeLower = contentType?.toLowerCase();

    const isPdfHeader = Boolean(contentTypeLower && contentTypeLower.includes("application/pdf"));

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
            if (sha256Hasher) sha256Hasher.update(chunk);
          });
          nodeReadable.pipe(writeStream);
          writeStream.on("finish", () => resolve());
          writeStream.on("error", (err) => {
            writeStream.destroy();
            reject(err);
          });
          nodeReadable.on("error", (err) => {
            writeStream.destroy();
            // A body-stream failure is a REMOTE transfer failure, not a
            // local filesystem error — classify it so the JSON error
            // contract reports NETWORK, not FILE.
            reject(
              new NetworkError(
                `Response body stream failed while writing to disk: ${err instanceof Error ? err.message : String(err)}`,
              ),
            );
          });
        });
        await fs.rename(tempPath, outPath);
      } catch (err) {
        await fs.unlink(tempPath).catch(() => {});
        if (err instanceof NetworkError) throw err;
        throw new FileError(
          `Failed to write output file "${outPath}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (md5Hasher) {
        md5 = md5Hasher.digest("hex");
      }
      if (sha256Hasher) {
        sha256 = sha256Hasher.digest("hex");
      }
    } else {
      // Every buffered path — including error bodies reached when --out
      // cannot stream (non-ok responses have no evidentiary value worth
      // an unbounded buffer) — is subject to the same in-memory ceiling.
      // Bodiless responses (HEAD, 204, 304) never allocate a body, so
      // their (metadata-only) Content-Length must not trip the ceiling.
      const bodiless = method === "HEAD" || response.status === 204 || response.status === 304;
      const contentLengthHeader = resHeaders["content-length"];
      if (
        !bodiless &&
        contentLengthHeader &&
        Number(contentLengthHeader) > MAX_IN_MEMORY_BYTES
      ) {
        // Release the connection before throwing: an uncancelled body
        // keeps the keep-alive socket pinned until process exit.
        await response.body?.cancel().catch(() => {});
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
      if (sha256Hasher) {
        sha256 = sha256Hasher.update(rawBuffer).digest("hex");
      }
    }
  } catch (err: unknown) {
    if (controller.signal.aborted) {
      throw new TimeoutError(timeoutMs, `Direct fetch timed out after ${timeoutMs}ms`);
    }
    if (err instanceof FileError || err instanceof TimeoutError || err instanceof ValidationError) {
      throw err;
    }
    // A @file payload that vanishes or fails to open mid-flight surfaces
    // as a raw undici TypeError with a filesystem cause: classify it as
    // the local file error it is, not a network failure.
    const causeCode = (err as { cause?: { code?: string } })?.cause?.code;
    if (causeCode && ["ENOENT", "EISDIR", "EACCES", "EPERM"].includes(causeCode)) {
      throw new FileError(
        `Failed to read request body file: ${causeCode} (${dataFilePath ?? "unknown path"})`,
      );
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new NetworkError(`Fetch failed: ${msg}`);
  } finally {
    clearTimeout(timer);
  }

  const isPdf =
    (rawBuffer !== null && isPdfBuffer(rawBuffer)) ||
    Boolean(contentTypeLower && contentTypeLower.includes("application/pdf"));

  // Decode content string for text-compatible bodies
  let content: string | undefined;
  if (isPdf && rawBuffer !== null) {
    // The retrieved body is the evidence: --md5, --out, and the byte
    // count always describe the ORIGINAL response bytes. The repaired
    // buffer exists only to make extraction possible (--pdf text) —
    // hashing or persisting it would misdescribe what the origin sent.
    let pdfBuf: Buffer = rawBuffer;
    if (options.pdfRepair) {
      pdfBuf = Buffer.from(await repairPdf(pdfBuf, timeoutMs));
    }
    if (options.pdf === "text") {
      content = await extractPdfText(pdfBuf, timeoutMs);
    }
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
      contentTypeLower !== undefined &&
      !contentTypeLower.includes("text") &&
      !contentTypeLower.includes("json") &&
      !contentTypeLower.includes("xml") &&
      !contentTypeLower.includes("javascript") &&
      !contentTypeLower.includes("csv") &&
      !contentTypeLower.includes("html");

    // Binary classification is respected on the in-memory path too: a
    // binary body without --out must NOT be decoded as UTF-8 (lossy
    // mojibake); the presentation falls back to the binary summary and
    // byte-exact output remains --out's contract.
    if (!isBinary) {
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
    ...(sha256 ? { sha256 } : {}),
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
  // Gate on the file that was actually WRITTEN (data.outPath is set only
  // after a successful atomic rename): non-OK responses never produce a
  // file and must not claim one.
  if (data.outPath) {
    const md5Text = data.md5 ? ` (MD5: ${data.md5})` : "";
    presentationText = `Fetched ${data.bytes} bytes from ${data.url} -> ${data.outPath}${md5Text} [HTTP ${data.status}]`;
  } else if (data.content !== undefined) {
    // Text-compatible bodies are the presentation in every mode; the
    // raw/non-raw distinction is the OUTPUT ROUTING (the dispatcher
    // sends --raw to a text mode so the body prints without the JSON
    // envelope), not the string itself. Byte-exact binary output is
    // --out's contract — stdout remains a text surface.
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
