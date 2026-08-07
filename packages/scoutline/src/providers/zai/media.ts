/**
 * Z.AI Provider Media Module (DESIGN.md §9 — P3-02).
 *
 * Owns Z.AI-local media facts: accepted image and video extensions, size
 * limits, existence checks, and absolute-path resolution. Commands pass
 * raw path-or-URL strings; this module is the single owner of every
 * Provider-specific media decision for Z.AI.
 *
 * Boundary rules (ARCHITECTURE.md §2):
 *   - May import normalized errors from `lib/errors.ts`.
 *   - Must NOT read file content. The Z.AI MCP receives the validated
 *     absolute path; it never receives a data URI or file bytes from
 *     this module. Only `stat` (existence + size) is performed.
 *
 * Media rules (DESIGN.md §9 Z.AI):
 *   - Local image: JPG, JPEG, PNG (case-insensitive), at most 5 MiB.
 *   - Local video: preserve the Phase 0 extension set and 8 MiB limit.
 *   - Local source becomes an absolute path after validation.
 *   - HTTP(S) source passes through without local filesystem access.
 *   - Missing local file rejects with `FILE_ERROR`.
 *   - Non-HTTP URL-like strings and unsupported extensions reject with
 *     `VALIDATION_ERROR` and Provider-specific supported-format help.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  ApiError,
  FileError,
  NetworkError,
  TimeoutError,
  ValidationError,
} from "../../lib/errors.js";

// ---------------------------------------------------------------------------
// Z.AI media limits (DESIGN.md §9)
// ---------------------------------------------------------------------------

const ZAI_IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png"];
const ZAI_VIDEO_EXTENSIONS = [".mp4", ".mov", ".m4v", ".avi", ".webm", ".wmv"];

const ZAI_MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MiB
const ZAI_MAX_VIDEO_BYTES = 8 * 1024 * 1024; // 8 MiB

const ZAI_IMAGE_FORMAT_HELP = "Supported Z.AI image formats: JPG, JPEG, PNG (max 5 MiB)";
const ZAI_VIDEO_FORMAT_HELP =
  "Supported Z.AI video formats: MP4, MOV, M4V, AVI, WebM, WMV (max 8 MiB)";

// ---------------------------------------------------------------------------
// Source classification
// ---------------------------------------------------------------------------

/**
 * A leading `<scheme>://` that is NOT `http(s)://` (e.g. `ftp://`, `file://`)
 * is a URL-like string Z.AI cannot consume. It is rejected up front with
 * `VALIDATION_ERROR` rather than falling through to a misleading local-file
 * `FILE_ERROR`.
 */
const URL_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;

type SourceKind = "http" | "unsupported-url" | "local";

function classifySource(source: string): SourceKind {
  if (source.startsWith("http://") || source.startsWith("https://")) {
    return "http";
  }
  if (URL_SCHEME_PATTERN.test(source)) {
    return "unsupported-url";
  }
  return "local";
}

// ---------------------------------------------------------------------------
// Local media validation (existence + size + extension; never reads content)
// ---------------------------------------------------------------------------

function validateLocalMedia(
  source: string,
  allowedExtensions: readonly string[],
  maxBytes: number,
  formatHelp: string,
): string {
  const resolved = path.resolve(source);
  if (!fs.existsSync(resolved)) {
    throw new FileError(`File not found: ${source}`, "Check the file path is correct");
  }
  const stats = fs.statSync(resolved);
  if (stats.size > maxBytes) {
    throw new ValidationError(
      `File exceeds the ${(maxBytes / 1024 / 1024).toFixed(0)} MiB limit ` +
        `(${(stats.size / 1024 / 1024).toFixed(2)} MiB)`,
      formatHelp,
    );
  }
  const ext = path.extname(resolved).toLowerCase();
  if (!allowedExtensions.includes(ext)) {
    throw new ValidationError(`Unsupported media format: ${ext || "(no extension)"}`, formatHelp);
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Public resolvers
// ---------------------------------------------------------------------------

/**
 * Resolve a Z.AI image source into the value the Z.AI MCP consumes. For a
 * local file, validates existence, size (≤ 5 MiB), and extension
 * (JPG/JPEG/PNG) and returns the absolute path. For an HTTP(S) URL,
 * returns the URL unchanged without touching the local filesystem.
 */
export function resolveImageSource(source: string): string {
  const kind = classifySource(source);
  if (kind === "http") return source;
  if (kind === "unsupported-url") {
    throw new ValidationError(
      `Unsupported source scheme for Z.AI vision`,
      "Use an HTTP(S) URL or a local file path",
    );
  }
  return validateLocalMedia(
    source,
    ZAI_IMAGE_EXTENSIONS,
    ZAI_MAX_IMAGE_BYTES,
    ZAI_IMAGE_FORMAT_HELP,
  );
}

/**
 * Resolve a Z.AI video source into the value the Z.AI MCP consumes. For a
 * local file, validates existence, size (≤ 8 MiB), and extension (the
 * Phase 0 set) and returns the absolute path. For an HTTP(S) URL, returns
 * the URL unchanged.
 */
export function resolveVideoSource(source: string): string {
  const kind = classifySource(source);
  if (kind === "http") return source;
  if (kind === "unsupported-url") {
    throw new ValidationError(
      `Unsupported source scheme for Z.AI vision`,
      "Use an HTTP(S) URL or a local file path",
    );
  }
  return validateLocalMedia(
    source,
    ZAI_VIDEO_EXTENSIONS,
    ZAI_MAX_VIDEO_BYTES,
    ZAI_VIDEO_FORMAT_HELP,
  );
}

// ---------------------------------------------------------------------------
// URL -> local temp file fallback (Issue E).
//
// Z.AI's vision MCP only accepts a local path or an HTTP(S) URL as
// `image_source`; it rejects base64/data URIs ("Image file not found").
// Its server-side URL fetcher is also unreliable for some URLs (returns
// code 1210 image-format errors, empty results, or hangs). When a URL
// source fails with a fast client error, the Adapter retries by fetching
// the URL here, validating it against the same Z.AI media limits, writing
// it to a process-private temp file, and passing that path to the next
// attempt. The caller owns unlinking the returned path.
// ---------------------------------------------------------------------------

/** Bound on a single URL fetch used for the fallback. */
const ZAI_FETCH_TIMEOUT_MS = 30_000;

/**
 * User-Agent sent on fallback URL fetches. Many CDNs and image hosts
 * (Cloudflare-fronted services, GitHub raw, etc.) reject requests that
 * carry no User-Agent with a 400/403. The string is identifiable but
 * browser-compatible so hosts that gate on a Mozilla prefix still serve.
 */
const ZAI_FETCH_USER_AGENT = `scoutline (https://github.com/vikasagarwal101/scoutline; +node ${process.version})`;

/**
 * Map a fetch `Content-Type` header value to a Z.AI media extension.
 * Returns `null` for an unknown/missing type so the caller can fall back
 * to a URL-derived extension or reject.
 */
function contentTypeToExtension(contentType: string | null): string | null {
  if (!contentType) return null;
  const base = (contentType.split(";")[0] ?? "").trim().toLowerCase();
  const map: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "video/mp4": ".mp4",
    "video/quicktime": ".mov",
    "video/x-m4v": ".m4v",
    "video/x-msvideo": ".avi",
    "video/webm": ".webm",
    "video/x-ms-wmv": ".wmv",
  };
  return map[base] ?? null;
}

/**
 * Fetch an HTTP(S) `url` to a process-private temp file, enforcing the
 * Z.AI media size limit and the allowed `extensions`. The extension is
 * derived from the response Content-Type when available, falling back to
 * the URL path's extension. Returns the absolute temp path. The caller
 * MUST unlink the file once the Provider attempt has finished.
 *
 * Failures throw normalized errors: `NetworkError` for transport failure,
 * `TimeoutError` for a fetch that exceeds the bound, `ValidationError`
 * for an oversize or unsupported-format response.
 */
async function fetchUrlToTempPath(
  url: string,
  maxBytes: number,
  extensions: readonly string[],
  formatHelp: string,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ZAI_FETCH_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "User-Agent": ZAI_FETCH_USER_AGENT },
    });
  } catch (error) {
    clearTimeout(timer);
    if (error instanceof Error && error.name === "AbortError") {
      throw new TimeoutError(ZAI_FETCH_TIMEOUT_MS);
    }
    throw new NetworkError("Z.AI vision URL fetch failed");
  }
  clearTimeout(timer);
  if (!response.ok) {
    throw new ApiError("Z.AI vision URL fetch failed", response.status);
  }

  const declaredLength = response.headers.get("content-length");
  if (declaredLength) {
    const n = Number.parseInt(declaredLength, 10);
    if (Number.isFinite(n) && n > maxBytes) {
      throw new ValidationError(
        `URL exceeds the ${(maxBytes / 1024 / 1024).toFixed(0)} MiB limit`,
        formatHelp,
      );
    }
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxBytes) {
    throw new ValidationError(
      `URL exceeds the ${(maxBytes / 1024 / 1024).toFixed(0)} MiB limit`,
      formatHelp,
    );
  }

  const ext =
    contentTypeToExtension(response.headers.get("content-type")) ??
    path.extname(new URL(url).pathname).toLowerCase();
  if (!ext || !extensions.includes(ext)) {
    throw new ValidationError(
      `Unsupported media format from URL: ${ext || "(no extension)"}`,
      formatHelp,
    );
  }

  const tempPath = path.join(
    os.tmpdir(),
    `scoutline-vision-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`,
  );
  await fs.promises.writeFile(tempPath, buffer);
  return tempPath;
}

/**
 * Fetch an HTTP(S) image URL to a validated temp file path (≤ 5 MiB,
 * JPG/JPEG/PNG). Used by the vision Adapter fallback when the Provider's
 * server-side fetcher rejects a URL. The caller owns unlinking the path.
 */
export async function fetchImageSource(url: string): Promise<string> {
  return fetchUrlToTempPath(url, ZAI_MAX_IMAGE_BYTES, ZAI_IMAGE_EXTENSIONS, ZAI_IMAGE_FORMAT_HELP);
}

/**
 * Fetch an HTTP(S) video URL to a validated temp file path (≤ 8 MiB,
 * the Phase 0 extension set). Used by the vision Adapter fallback when
 * the Provider's server-side fetcher rejects a URL. The caller owns
 * unlinking the path.
 */
export async function fetchVideoSource(url: string): Promise<string> {
  return fetchUrlToTempPath(url, ZAI_MAX_VIDEO_BYTES, ZAI_VIDEO_EXTENSIONS, ZAI_VIDEO_FORMAT_HELP);
}
