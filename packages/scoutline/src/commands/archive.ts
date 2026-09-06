/**
 * archive command — Internet Archive Wayback Machine integration (ADR-0006).
 *
 * Implements temporal archival intelligence:
 *
 *   - `archive cdx <url-or-pattern> [--from TS] [--to TS] [--status 200] [--limit N]`:
 *     Queries the CDX Server API to enumerate historical captures.
 *   - `archive get <url> [--at <timestamp|best>] [--raw]`:
 *     Replays a capture using Wayback's `id_` verbatim mode (toolbar stripped),
 *     auto-resolving the best snapshot via the Availability API when omitted.
 *   - `archive diff <url> --since <date|duration>`:
 *     One-shot snapshot-vs-live comparison: replays the capture at or
 *     before `--since` (CDX-selected, never nearest-after) and diffs its
 *     sections against the live page (watch-temporal-diff lane B, T3).
 *
 * Credential-free (public, keyless API) dispatched before config load.
 */

import type { CommandResult, TextOutputMode } from "../command-invocation.js";
import { invokeCommand } from "../command-invocation.js";
import type { OutputMode } from "../lib/output.js";
import { ValidationError, TimeoutError, NetworkError } from "../lib/errors.js";
import type { HandlerDependencies } from "../index.js";
import {
  readBoundedResponseBody,
  DEFAULT_USER_AGENT,
  DEFAULT_FETCH_TIMEOUT_MS,
} from "./fetch.js";
import { extractSections, diffDocuments } from "../lib/section-diff.js";

export const ARCHIVE_HELP = `
scoutline archive <subcommand> [args] [options] - Internet Archive Wayback Machine

Subcommands:
  cdx <url-or-pattern>     Query the CDX Server index to enumerate captures
  get <url>                Fetch a capture's raw original content (toolbar stripped)
  diff <url>               Compare a Wayback snapshot against the live page

Options for 'archive cdx':
  --from <timestamp>       Earliest timestamp (e.g. 2020, 20200101)
  --to <timestamp>         Latest timestamp (e.g. 2025, 20251231)
  --status <statuscode>    Filter by HTTP status code (e.g. 200)
  --limit <number>         Max records to return (default: 50, max: 10000)

Options for 'archive get':
  --at <timestamp|best>    Target timestamp or 'best' for nearest (default: best)
  --raw                    Emit raw body content directly

Options for 'archive diff':
  --since <date|duration>  Snapshot boundary: ISO date (2026-08-01), ISO datetime
                           (2026-08-01T12:00:00Z), or duration (30d, 12h, 1w, 2y)

Global Options:
  --output-format, -O      Output format: data, json, pretty, compact, markdown, refs, tty
`.trim();

export const WAYBACK_CDX_ENDPOINT = "https://web.archive.org/cdx/search/cdx";
export const WAYBACK_AVAILABILITY_ENDPOINT = "https://archive.org/wayback/available";
export const DEFAULT_ARCHIVE_TIMEOUT_MS = 30000;

export interface ArchiveCapture {
  readonly timestamp: string;
  readonly statusCode: number;
  readonly length: number;
  readonly digest: string;
  readonly originalUrl: string;
}

export interface ArchiveCdxReport {
  readonly schemaVersion: 1;
  readonly url: string;
  readonly total: number;
  readonly captures: readonly ArchiveCapture[];
}

export interface ArchiveGetReport {
  readonly schemaVersion: 1;
  readonly url: string;
  readonly snapshotTimestamp: string;
  readonly archiveUrl: string;
  readonly statusCode: number;
  readonly bytes: number;
  readonly contentType?: string;
  readonly content?: string;
}

export interface ArchiveDiffOptions {
  readonly since?: string;
  readonly timeout?: number;
}

export interface ArchiveDiffReport {
  readonly schemaVersion: 1;
  readonly url: string;
  readonly asOf: string;
  readonly snapshotTimestamp: string;
  readonly finalUrl: string;
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
  readonly hashOnly: boolean;
  readonly moved: boolean;
}

export interface ArchiveCdxOptions {
  readonly from?: string;
  readonly to?: string;
  readonly status?: string;
  readonly limit?: number;
  readonly timeout?: number;
}

export interface ArchiveGetOptions {
  readonly at?: string;
  readonly raw?: boolean;
  readonly timeout?: number;
}

/**
 * Fetch with exponential backoff on HTTP 429/503 (rate limiting).
 */
export async function fetchWithArchiveBackoff<T = Response>(
  url: string,
  options: {
    timeout?: number;
    headers?: Record<string, string>;
    sleep?: (ms: number) => Promise<void>;
  } = {},
  consumer?: (res: Response) => Promise<T>,
): Promise<T> {
  const timeoutMs = options.timeout ?? DEFAULT_ARCHIVE_TIMEOUT_MS;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const maxRetries = 3;
  let delay = 1000;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": "scoutline/1.0 (archive client; investigative research)",
          Accept: "*/*",
          ...options.headers,
        },
        signal: controller.signal,
      });

      if (res.status === 429 || res.status === 503) {
        if (attempt < maxRetries) {
          clearTimeout(timer);
          const jitter = 0.8 + Math.random() * 0.4;
          await sleep(Math.round(delay * jitter));
          delay *= 2;
          continue;
        }
        throw new NetworkError(
          `Archive request rate-limited (HTTP ${res.status}). Please wait before retrying.`,
        );
      }

      if (consumer) {
        return await consumer(res);
      }
      return res as unknown as T;
    } catch (err: unknown) {
      if (err instanceof NetworkError || err instanceof TimeoutError || err instanceof ValidationError) {
        throw err;
      }
      if (controller.signal.aborted) {
        throw new TimeoutError(timeoutMs, `Archive request timed out after ${timeoutMs}ms`);
      }
      if (attempt === maxRetries) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new NetworkError(`Archive request failed: ${msg}`);
      }
      await sleep(delay);
      delay *= 2;
    } finally {
      clearTimeout(timer);
    }
  }

  throw new NetworkError("Archive request failed after retries.");
}

/**
 * Enumerate captures via CDX server.
 */
export async function executeArchiveCdx(
  urlOrPattern: string,
  options: ArchiveCdxOptions = {},
  dependencies: { sleep?: (ms: number) => Promise<void>; cdxEndpoint?: string } = {},
): Promise<ArchiveCdxReport> {
  if (!urlOrPattern || urlOrPattern.trim().length === 0) {
    throw new ValidationError("URL or pattern is required for archive cdx.");
  }

  const queryParams = new URLSearchParams({
    url: urlOrPattern,
    output: "json",
    fl: "timestamp,statuscode,length,digest,original",
  });

  if (options.from) queryParams.set("from", options.from);
  if (options.to) queryParams.set("to", options.to);
  if (options.status) queryParams.set("filter", `statuscode:${options.status}`);
  if (options.limit !== undefined) {
    if (options.limit <= 0 || options.limit > 10000) {
      throw new ValidationError(`--limit must be between 1 and 10000, got ${options.limit}.`);
    }
    queryParams.set("limit", String(options.limit));
  } else {
    queryParams.set("limit", "50");
  }

  const endpoint = dependencies.cdxEndpoint ?? WAYBACK_CDX_ENDPOINT;
  const reqUrl = `${endpoint}?${queryParams.toString()}`;
  const raw = await fetchWithArchiveBackoff(
    reqUrl,
    {
      timeout: options.timeout,
      sleep: dependencies.sleep,
    },
    async (res) => {
      if (!res.ok) {
        throw new NetworkError(`CDX query failed with HTTP ${res.status}: ${res.statusText}`);
      }
      return (await res.json()) as unknown;
    },
  );
  if (!Array.isArray(raw)) {
    return {
      schemaVersion: 1,
      url: urlOrPattern,
      total: 0,
      captures: [],
    };
  }

  // Row 0 is header columns ["timestamp", "statuscode", "length", "digest", "original"]
  const dataRows = raw.slice(1);
  const captures: ArchiveCapture[] = [];

  for (const row of dataRows) {
    if (Array.isArray(row) && row.length >= 5) {
      captures.push({
        timestamp: String(row[0]),
        statusCode: Number(row[1]) || 0,
        length: Number(row[2]) || 0,
        digest: String(row[3]),
        originalUrl: String(row[4]),
      });
    }
  }

  return {
    schemaVersion: 1,
    url: urlOrPattern,
    total: captures.length,
    captures,
  };
}

/**
 * Resolve snapshot timestamp via Wayback Availability API.
 */
export async function resolveAvailableSnapshot(
  url: string,
  timestampHint?: string,
  dependencies: { sleep?: (ms: number) => Promise<void>; timeout?: number; availabilityEndpoint?: string } = {},
): Promise<{ timestamp: string; archiveUrl: string }> {
  const queryParams = new URLSearchParams({ url });
  if (timestampHint && timestampHint !== "best") {
    queryParams.set("timestamp", timestampHint);
  }

  const endpoint = dependencies.availabilityEndpoint ?? WAYBACK_AVAILABILITY_ENDPOINT;
  const reqUrl = `${endpoint}?${queryParams.toString()}`;
  const data = await fetchWithArchiveBackoff(
    reqUrl,
    {
      timeout: dependencies.timeout,
      sleep: dependencies.sleep,
    },
    async (res) => {
      if (!res.ok) {
        throw new NetworkError(
          `Wayback availability check failed with HTTP ${res.status}: ${res.statusText}`,
        );
      }
      return (await res.json()) as {
        archived_snapshots?: {
          closest?: {
            available?: boolean;
            url?: string;
            timestamp?: string;
            status?: string;
          };
        };
      };
    },
  );


  const closest = data.archived_snapshots?.closest;
  if (!closest || !closest.available || !closest.timestamp) {
    throw new ValidationError(
      `No archived snapshot found for "${url}".`,
      "Use 'scoutline archive cdx <url>' to check if any captures exist.",
    );
  }

  return {
    timestamp: closest.timestamp,
    archiveUrl: closest.url ?? `https://web.archive.org/web/${closest.timestamp}/${url}`,
  };
}

/**
 * Fetch raw capture content via Wayback's `id_` verbatim mode.
 */
export async function executeArchiveGet(
  url: string,
  options: ArchiveGetOptions = {},
  dependencies: {
    sleep?: (ms: number) => Promise<void>;
    availabilityEndpoint?: string;
    replayBaseUrl?: string;
  } = {},
): Promise<ArchiveGetReport> {
  if (!url || url.trim().length === 0) {
    throw new ValidationError("URL is required for archive get.");
  }

  if (options.at !== undefined && options.at !== "best" && !/^\d{4,14}$/.test(options.at)) {
    throw new ValidationError(
      `Invalid --at timestamp: "${options.at}".`,
      'Allowed values: "best" or a 4 to 14 digit timestamp (YYYYMMDDhhmmss).',
    );
  }

  let snapshotTimestamp: string;
  let archiveUrl: string;

  if (options.at && options.at !== "best") {
    snapshotTimestamp = options.at;
    archiveUrl = `https://web.archive.org/web/${snapshotTimestamp}/${url}`;
  } else {
    const resolved = await resolveAvailableSnapshot(url, options.at, {
      ...dependencies,
      // The availability check honors the caller timeout like the replay
      // request does (default only when the caller did not set one).
      ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
    });
    snapshotTimestamp = resolved.timestamp;
    archiveUrl = resolved.archiveUrl;
  }

  // Notice the `id_` flag right after the timestamp: tells Wayback to return raw original bytes
  const replayBase = dependencies.replayBaseUrl ?? "https://web.archive.org/web";
  const verbatimFetchUrl = `${replayBase}/${snapshotTimestamp}id_/${url}`;
  const { statusCode, contentType, buffer } = await fetchWithArchiveBackoff(
    verbatimFetchUrl,
    {
      timeout: options.timeout,
      sleep: dependencies.sleep,
    },
    async (res) => {
      const contentLength = res.headers.get("content-length");
      const MAX_ARCHIVE_IN_MEMORY = 50 * 1024 * 1024;
      if (contentLength && Number(contentLength) > MAX_ARCHIVE_IN_MEMORY) {
        throw new ValidationError(
          `Archive capture size (${contentLength} bytes) exceeds in-memory limit (50MB).`,
        );
      }
      const buffer = await readBoundedResponseBody(
        res.body as ReadableStream<Uint8Array> | null,
        MAX_ARCHIVE_IN_MEMORY,
        "Archive capture size",
      );
      return {
        statusCode: res.status,
        contentType: res.headers.get("content-type") || undefined,
        buffer,
      };
    },
  );

  const bytes = buffer.length;

  let content: string | undefined;
  const isExplicitBinary = Boolean(
    contentType &&
      /application\/(pdf|zip|gzip|octet-stream)|image\/|audio\/|video\//i.test(contentType),
  );
  const isTextualMime = Boolean(
    contentType &&
      (contentType.startsWith("text/") ||
        /application\/(json|xml|javascript|atom\+xml|rss\+xml)/i.test(contentType)),
  );

  if (!isExplicitBinary) {
    if (isTextualMime) {
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
      } catch {
        content = buffer.toString("utf8");
      }
    } else {
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
      } catch {
        // Leave undefined if binary
      }
    }
  }

  return {
    schemaVersion: 1,
    url,
    snapshotTimestamp,
    archiveUrl,
    statusCode,
    bytes,
    ...(contentType ? { contentType } : {}),
    ...(content !== undefined ? { content } : {}),
  };
}

/**
 * Invocation-seam wrapper for archive cdx.
 */
export async function archiveCdxCommand(
  urlOrPattern: string,
  options: ArchiveCdxOptions = {},
): Promise<CommandResult<ArchiveCdxReport>> {
  const data = await executeArchiveCdx(urlOrPattern, options);

  const lines = [
    `Archive CDX Index for ${data.url} (${data.total} captures found):`,
    "Timestamp        Status  Bytes   Digest                            Original URL",
    "--------------------------------------------------------------------------------",
  ];

  for (const c of data.captures.slice(0, 20)) {
    const ts = c.timestamp.padEnd(16);
    const st = String(c.statusCode).padEnd(7);
    const sz = String(c.length).padEnd(7);
    const dg = c.digest.slice(0, 32).padEnd(33);
    lines.push(`${ts} ${st} ${sz} ${dg} ${c.originalUrl}`);
  }
  if (data.total > 20) {
    lines.push(`... and ${data.total - 20} more captures.`);
  }

  const text = lines.join("\n");
  const presentations: Partial<Record<TextOutputMode, string>> = {
    tty: text,
    compact: text,
    markdown: text,
    refs: text,
  };

  return {
    kind: "data",
    data,
    presentations,
  };
}

/**
 * Invocation-seam wrapper for archive get.
 */
export async function archiveGetCommand(
  url: string,
  options: ArchiveGetOptions = {},
): Promise<CommandResult<ArchiveGetReport>> {
  const data = await executeArchiveGet(url, options);

  let presentationText = "";
  if (data.content !== undefined) {
    // Same contract as fetch: the body IS the presentation; `--raw`
    // routes output to a text mode (no JSON envelope) in the
    // dispatcher rather than changing this string.
    presentationText = data.content;
  } else {
    presentationText = `[Archived snapshot: ${data.snapshotTimestamp}, ${data.bytes} bytes, HTTP ${data.statusCode}]`;
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
    exitCode: data.statusCode >= 400 ? 1 : 0,
  };
}

/**
 * Duration units accepted by `--since` (e.g. `30d`), mapped to days.
 */
const SINCE_DURATION_UNITS: Record<string, number> = {
  d: 24 * 60 * 60,
  h: 60 * 60,
  w: 7 * 24 * 60 * 60,
  y: 365 * 24 * 60 * 60,
};

/**
 * Resolve `--since` to a target instant T (ms since epoch) and the
 * report's `asOf` echo (ISO date form for plain dates, computed ISO
 * instant for durations). Rejects bare numbers, unknown units, negative
 * durations, and invalid dates — never falls back to a guess.
 */
export function resolveSinceInstant(
  since: string,
  now: () => number = Date.now,
): { atMs: number; asOf: string } {
  const durationMatch = /^(\d+)([dhwy])$/.exec(since.trim());
  if (durationMatch) {
    const atMs = now() - Number(durationMatch[1]) * SINCE_DURATION_UNITS[durationMatch[2] ?? ""]! * 1000;
    return { atMs, asOf: new Date(atMs).toISOString() };
  }
  if (/^\d+([.,]\d+)?$/.test(since.trim())) {
    throw new ValidationError(
      `Invalid --since value: "${since}".`,
      "Durations require a unit: 30d, 12h, 1w, 2y.",
    );
  }
  const asDate = new Date(since);
  // Reject unparseable input AND calendar overflows (`2023-13-45` rolls
  // over to 2024-02-14 in the constructor rather than throwing).
  const overflowed =
    asDate.toString() !== "Invalid Date" &&
    /^\d{4}-\d{2}-\d{2}/.test(since.trim()) &&
    asDate.toISOString().slice(0, 10) !== since.trim().slice(0, 10);
  if (since.trim() === "" || asDate.toString() === "Invalid Date" || overflowed) {
    throw new ValidationError(
      `Invalid --since value: "${since}".`,
      "Use an ISO date (2026-08-01), ISO datetime (2026-08-01T12:00:00Z), or duration (30d).",
    );
  }
  const plainDate = /^\d{4}-\d{2}-\d{2}$/.test(since.trim());
  return {
    atMs: asDate.getTime(),
    // Plain dates echo in date form; datetimes echo the ISO instant.
    asOf: plainDate ? since.trim() : asDate.toISOString(),
  };
}

/** CDX timestamp (YYYYMMDDhhmmss) of a capture, zero-padded for compare. */
function cdxTimestampMs(timestamp: string): number {
  return Date.parse(
    timestamp.replace(
      /^(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?$/,
      "$1-$2-$3T$4:$5:$6Z",
    ),
  );
}

/** Pull the charset parameter out of a Content-Type header, if present. */
export function charsetFromContentType(contentType: string | undefined): string | undefined {
  if (!contentType) return undefined;
  const match = /charset=([^;]+)/i.exec(contentType);
  // Strip surrounding quotes — `charset="utf-8"` is legal (RFC 9110)
  // but TextDecoder rejects the quoted label, silently mis-decoding
  // quoted non-UTF-8 content via the UTF-8 fallback.
  return match?.[1]?.trim().replace(/^['"]|['"]$/g, "");
}

/**
 * Select the newest CDX capture whose timestamp is at-or-before T
 * (strict; never nearest-after). No qualifying capture → ValidationError
 * pointing at `archive cdx` — no silent substitution (audit correction 1).
 */
async function selectSnapshotAtOrBefore(
  url: string,
  atMs: number,
  since: string,
  dependencies: { sleep?: (ms: number) => Promise<void>; cdxEndpoint?: string },
): Promise<string> {
  const to = new Date(atMs).toISOString().replace(/\D/g, "").slice(0, 14);
  const report = await executeArchiveCdx(url, { to, status: "200", limit: 50 }, dependencies);
  let best: { timestamp: string; ms: number } | undefined;
  for (const capture of report.captures) {
    const ms = cdxTimestampMs(capture.timestamp);
    if (!Number.isNaN(ms) && ms <= atMs && (!best || ms > best.ms)) {
      best = { timestamp: capture.timestamp, ms };
    }
  }
  if (!best) {
    throw new ValidationError(
      `No Wayback capture at or before --since ${since} for "${url}".`,
      "Use 'scoutline archive cdx <url>' to inspect capture coverage.",
    );
  }
  return best.timestamp;
}

/**
 * Replay a snapshot's RAW original bytes (Wayback `id_` mode) for
 * diff-side consumption. Same bounded-read discipline as archive get.
 */
async function fetchSnapshotRaw(
  url: string,
  snapshotTimestamp: string,
  dependencies: { sleep?: (ms: number) => Promise<void>; replayBaseUrl?: string },
): Promise<{ raw: Buffer; contentType?: string }> {
  const replayBase = dependencies.replayBaseUrl ?? "https://web.archive.org/web";
  const verbatimFetchUrl = `${replayBase}/${snapshotTimestamp}id_/${url}`;
  return fetchWithArchiveBackoff(
    verbatimFetchUrl,
    { sleep: dependencies.sleep },
    async (res) => {
      const MAX_ARCHIVE_IN_MEMORY = 50 * 1024 * 1024;
      const buffer = await readBoundedResponseBody(
        res.body as ReadableStream<Uint8Array> | null,
        MAX_ARCHIVE_IN_MEMORY,
        "Archive capture size",
      );
      return { raw: buffer, contentType: res.headers.get("content-type") || undefined };
    },
  );
}

/**
 * Fetch the LIVE side: manual redirect loop (≤10 hops, 303/301/302
 * downgrade semantics per fetch), 50MB bounded read (never
 * `arrayBuffer()`), browser UA, AbortController timeout. Returns the
 * final body plus `moved` — true only when the chain contains a
 * permanent (301/308) hop AND the final URL differs from the request.
 */
export async function fetchLiveDocument(
  url: string,
  timeoutMs: number,
): Promise<{ raw: Buffer; finalUrl: string; moved: boolean; contentType?: string; statusCode: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let sawPermanent = false;
  try {
    let requestUrl = url;
    for (let hop = 0; ; hop++) {
      const res = await fetch(requestUrl, {
        headers: { "User-Agent": DEFAULT_USER_AGENT },
        redirect: "manual",
        signal: controller.signal,
      });
      const location = res.headers.get("location");
      const redirectable = [301, 302, 303, 307, 308].includes(res.status);
      if (!redirectable || !location) {
        const MAX_LIVE_IN_MEMORY = 50 * 1024 * 1024;
        const raw = await readBoundedResponseBody(
          res.body as ReadableStream<Uint8Array> | null,
          MAX_LIVE_IN_MEMORY,
          "Live page size",
        );
        return {
          raw,
          finalUrl: requestUrl,
          moved: sawPermanent && requestUrl !== url,
          contentType: res.headers.get("content-type") || undefined,
          statusCode: res.status,
        };
      }
      await res.body?.cancel().catch(() => {});
      if (hop >= 10) {
        throw new NetworkError(`Too many redirects (>10) while fetching ${url}`);
      }
      if (res.status === 301 || res.status === 308) sawPermanent = true;
      requestUrl = new URL(location, requestUrl).toString();
    }
  } catch (err: unknown) {
    if (controller.signal.aborted) {
      throw new TimeoutError(timeoutMs, `Live fetch timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One-shot snapshot-vs-live section diff (watch-temporal-diff lane B, T3).
 *
 * Archive side = snapshot RAW bytes via `id_` replay; live side = real
 * HTTP fetch. Sections extracted from each side's bytes under its own
 * charset hint; non-HTML degrades to hash-only per the engine contract.
 */
export async function executeArchiveDiff(
  url: string,
  options: ArchiveDiffOptions = {},
  dependencies: {
    sleep?: (ms: number) => Promise<void>;
    cdxEndpoint?: string;
    replayBaseUrl?: string;
    now?: () => number;
  } = {},
): Promise<ArchiveDiffReport> {
  if (!url || url.trim().length === 0) {
    throw new ValidationError("URL is required for archive diff.");
  }
  if (typeof options.since !== "string") {
    throw new ValidationError(
      "--since is required for archive diff.",
      "Example: scoutline archive diff https://example.com --since 2026-08-01",
    );
  }

  const { atMs, asOf } = resolveSinceInstant(options.since, dependencies.now);
  const snapshotTimestamp = await selectSnapshotAtOrBefore(url, atMs, options.since, {
    sleep: dependencies.sleep,
    cdxEndpoint: dependencies.cdxEndpoint,
  });
  const [snapshot, live] = await Promise.all([
    fetchSnapshotRaw(url, snapshotTimestamp, dependencies),
    fetchLiveDocument(url, options.timeout ?? DEFAULT_FETCH_TIMEOUT_MS),
  ]);

  const diff = diffDocuments(
    extractSections(snapshot.raw, charsetFromContentType(snapshot.contentType)),
    extractSections(live.raw, charsetFromContentType(live.contentType)),
  );

  return {
    schemaVersion: 1,
    url,
    asOf,
    snapshotTimestamp,
    finalUrl: live.finalUrl,
    added: diff.added,
    removed: diff.removed,
    changed: diff.changed,
    hashOnly: diff.hashOnly,
    moved: live.moved,
  };
}

/**
 * Invocation-seam wrapper for archive diff.
 */
export async function archiveDiffCommand(
  url: string,
  options: ArchiveDiffOptions = {},
): Promise<CommandResult<ArchiveDiffReport>> {
  const data = await executeArchiveDiff(url, options);

  const parts = [
    `Snapshot ${data.snapshotTimestamp} vs live — as of ${data.asOf}:`,
    `${data.added.length} added, ${data.removed.length} removed, ${data.changed.length} changed` +
      `${data.hashOnly ? " (hash-only)" : ""}`,
  ];
  if (data.moved) {
    parts.push(`Page has permanently moved to ${data.finalUrl}`);
  }
  if (data.added.length > 0) parts.push(`added: ${data.added.join(", ")}`);
  if (data.removed.length > 0) parts.push(`removed: ${data.removed.join(", ")}`);
  if (data.changed.length > 0) parts.push(`changed: ${data.changed.join(", ")}`);
  const text = parts.join("\n");

  const presentations: Partial<Record<TextOutputMode, string>> = {
    tty: text,
    compact: text,
    markdown: text,
    refs: text,
  };

  return {
    kind: "data",
    data,
    presentations,
  };
}

/**
 * Parse CLI args for archive command.
 */
export function parseArchiveArgs(args: readonly string[]): {
  readonly subcommand?: string;
  readonly positional: readonly string[];
  readonly flags: Record<string, string | boolean>;
  readonly showHelp: boolean;
} {
  let showHelp = false;
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === undefined) break;

    if (arg === "--help" || arg === "-h") {
      showHelp = true;
      i++;
    } else if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("-")) {
        flags[key] = next;
        i += 2;
      } else {
        flags[key] = true;
        i++;
      }
    } else if (!arg.startsWith("-")) {
      positional.push(arg);
      i++;
    } else {
      i++;
    }
  }

  const subcommand = positional[0];
  const remainingPositional = positional.slice(1);

  return {
    subcommand,
    positional: remainingPositional,
    flags,
    showHelp,
  };
}

/**
 * Dispatcher handler for `archive` in `src/index.ts`.
 */
export async function handleArchive(
  args: string[],
  outputMode: OutputMode,
  deps: HandlerDependencies,
  forceRaw = false,
): Promise<number> {
  const { subcommand, positional, flags, showHelp } = parseArchiveArgs(args);

  if (showHelp || subcommand === undefined) {
    deps.invocation.writeStdout(ARCHIVE_HELP);
    return 0;
  }

  if (subcommand === "cdx") {
    const urlOrPattern = positional[0];
    if (!urlOrPattern) {
      throw new ValidationError(
        "URL or pattern is required for archive cdx.",
        "Example: scoutline archive cdx https://example.com/*",
      );
    }

    let limit: number | undefined;
    if (typeof flags.limit === "string") {
      if (!/^\d+$/.test(flags.limit)) {
        throw new ValidationError("Invalid --limit: must be a positive integer.");
      }
      const parsedLimit = Number(flags.limit);
      if (parsedLimit <= 0 || parsedLimit > 10000) {
        throw new ValidationError(
          `--limit must be between 1 and 10000, got ${parsedLimit}.`,
        );
      }
      limit = parsedLimit;
    }

    const options: ArchiveCdxOptions = {
      ...(typeof flags.from === "string" ? { from: flags.from } : {}),
      ...(typeof flags.to === "string" ? { to: flags.to } : {}),
      ...(typeof flags.status === "string" ? { status: flags.status } : {}),
      ...(limit !== undefined ? { limit } : {}),
    };

    return invokeCommand(
      deps.invocation,
      () => archiveCdxCommand(urlOrPattern, options),
      outputMode,
      deps.now,
      deps.secrets,
    );
  }

  if (subcommand === "get") {
    const url = positional[0];
    if (!url) {
      throw new ValidationError(
        "URL is required for archive get.",
        "Example: scoutline archive get https://example.com --at best",
      );
    }

    if (typeof flags.at === "string" && flags.at !== "best" && !/^\d{4,14}$/.test(flags.at)) {
      throw new ValidationError(
        `Invalid --at timestamp: "${flags.at}".`,
        'Allowed values: "best" or a 4 to 14 digit timestamp (YYYYMMDDhhmmss).',
      );
    }

    const options: ArchiveGetOptions = {
      ...(typeof flags.at === "string" ? { at: flags.at } : {}),
      ...(flags.raw === true || forceRaw ? { raw: true } : {}),
    };

    return invokeCommand(
      deps.invocation,
      () => archiveGetCommand(url, options),
      outputMode,
      deps.now,
      deps.secrets,
    );
  }

  if (subcommand === "diff") {
    const url = positional[0];
    if (!url) {
      throw new ValidationError(
        "URL is required for archive diff.",
        "Example: scoutline archive diff https://example.com --since 30d",
      );
    }
    if (typeof flags.since !== "string") {
      throw new ValidationError(
        "--since is required for archive diff.",
        "Example: scoutline archive diff https://example.com --since 2026-08-01",
      );
    }
    const since = flags.since;

    let timeout: number | undefined;
    if (typeof flags.timeout === "string") {
      if (!/^\d+$/.test(flags.timeout) || Number(flags.timeout) === 0) {
        throw new ValidationError(
          `Invalid --timeout: "${flags.timeout}".`,
          "Must be a positive integer number of milliseconds.",
        );
      }
      timeout = Number(flags.timeout);
    }

    return invokeCommand(
      deps.invocation,
      () =>
        archiveDiffCommand(url, {
          since,
          ...(timeout !== undefined ? { timeout } : {}),
        }),
      outputMode,
      deps.now,
      deps.secrets,
    );
  }

  throw new ValidationError(
    `Unknown archive subcommand "${subcommand}".`,
    "Valid subcommands: cdx, get, diff.",
  );
}
