/**
 * MiniMax Provider Media Module (DESIGN.md §9 — P3-02).
 *
 * Owns MiniMax-local image media facts: accepted extensions, size limit,
 * existence check, and absolute-path resolution. Commands pass raw
 * path-or-URL strings; this module is the single owner of every
 * Provider-specific media decision for MiniMax images.
 *
 * Boundary rules (ARCHITECTURE.md §2):
 *   - May import normalized errors from `lib/errors.ts` and the shared
 *     `ProviderQuotaFetch` port from `providers/types.ts` (HTTP-source
 *     image fetch only).
 *   - Content reads happen here, in the Adapter-local media Module,
 *     since the SDK no longer performs data-URI conversion. The Module
 *     owns every MiniMax image fact: accepted extensions, size limit,
 *     existence check, absolute-path resolution, MIME detection, and
 *     base64 conversion.
 *
 * Media rules (DESIGN.md §9 MiniMax Transitional SDK):
 *   - Local image: JPG, JPEG, PNG, WebP (case-insensitive), at most 50 MiB.
 *   - HTTP(S) source is accepted.
 *   - Local source becomes an absolute path after validation.
 *   - `convertToDataUri` performs data-URI conversion for HTTP sources
 *     (fetched bytes) and local paths (read bytes); `data:` URIs pass
 *     through unchanged.
 *   - No MiniMax video media module exists in this scope.
 *   - Missing local file rejects with `FILE_ERROR`.
 *   - Non-HTTP URL-like strings and unsupported extensions reject with
 *     `VALIDATION_ERROR` and Provider-specific supported-format help.
 */

import * as fs from "node:fs";
import { readFile } from "node:fs/promises";
import * as path from "node:path";

import {
  ApiError,
  FileError,
  NetworkError,
  TimeoutError,
  ValidationError,
} from "../../lib/errors.js";
import type { ProviderQuotaFetch, ProviderQuotaFetchResponse } from "../types.js";

// ---------------------------------------------------------------------------
// MiniMax media limits (DESIGN.md §9)
// ---------------------------------------------------------------------------

const MINIMAX_IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"];

const MINIMAX_MAX_IMAGE_BYTES = 50 * 1024 * 1024; // 50 MiB

const MINIMAX_IMAGE_FORMAT_HELP =
  "Supported MiniMax image formats: JPG, JPEG, PNG, WebP (max 50 MiB)";

/**
 * HTTP image-fetch timeout in milliseconds (DESIGN.md §9, critique G2).
 * Matches the SDK's effective default (`config.timeout * 1000`,
 * `config.timeout = 300` → 30 s). Local files are NOT bound by this
 * timeout — already validated synchronously by `resolveImageSource`
 * via `fs.statSync`, so a slow disk read is not a real risk here.
 */
export const MINIMAX_IMAGE_FETCH_TIMEOUT_MS = 30000;

/**
 * Local-file extension → MIME mapping for `convertToDataUri` (critique
 * G1). Mirrors the SDK's `IMAGE_MIME_TYPES` table at
 * `mmx-cli/dist/sdk.mjs:1581-1586` exactly. The extension has already
 * been validated against `MINIMAX_IMAGE_EXTENSIONS` by
 * `resolveImageSource`, so a missing entry is not expected at this
 * layer (we still fall back to `image/jpeg` defensively, matching SDK).
 */
export const MINIMAX_IMAGE_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

// ---------------------------------------------------------------------------
// Source classification
// ---------------------------------------------------------------------------

/**
 * A leading `<scheme>://` that is NOT `http(s)://` (e.g. `ftp://`, `file://`)
 * is a URL-like string MiniMax cannot consume. It is rejected up front with
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

function validateLocalImage(source: string): string {
  const resolved = path.resolve(source);
  if (!fs.existsSync(resolved)) {
    throw new FileError(`File not found: ${source}`, "Check the file path is correct");
  }
  const stats = fs.statSync(resolved);
  if (stats.size > MINIMAX_MAX_IMAGE_BYTES) {
    throw new ValidationError(
      `File exceeds the ${(MINIMAX_MAX_IMAGE_BYTES / 1024 / 1024).toFixed(0)} MiB limit ` +
        `(${(stats.size / 1024 / 1024).toFixed(2)} MiB)`,
      MINIMAX_IMAGE_FORMAT_HELP,
    );
  }
  const ext = path.extname(resolved).toLowerCase();
  if (!MINIMAX_IMAGE_EXTENSIONS.includes(ext)) {
    throw new ValidationError(
      `Unsupported media format: ${ext || "(no extension)"}`,
      MINIMAX_IMAGE_FORMAT_HELP,
    );
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Public resolver
// ---------------------------------------------------------------------------

/**
 * Resolve a MiniMax image source into the value the MiniMax SDK consumes.
 * For a local file, validates existence, size (≤ 50 MiB), and extension
 * (JPG/JPEG/PNG/WebP) and returns the absolute path (the SDK performs
 * data-URI conversion from this path). For an HTTP(S) URL, returns the URL
 * unchanged without touching the local filesystem.
 */
export function resolveImageSource(source: string): string {
  const kind = classifySource(source);
  if (kind === "http") return source;
  if (kind === "unsupported-url") {
    throw new ValidationError(
      `Unsupported source scheme for MiniMax vision`,
      "Use an HTTP(S) URL or a local file path",
    );
  }
  return validateLocalImage(source);
}

// ---------------------------------------------------------------------------
// MIME detection from HTTP Content-Type (critique G1)
// ---------------------------------------------------------------------------

/**
 * Map an HTTP `Content-Type` header to a MiniMax image MIME.
 *
 * Rules (mirror SDK behaviour at `sdk.mjs:1601-1602`, critique G1):
 *   - Missing/null → `image/jpeg` (SDK default).
 *   - Strip `;`-introduced parameters, then trim and lowercase.
 *   - Match `image/jpeg` or `image/jpg` → `image/jpeg`.
 *   - Match `image/png` → `image/png`.
 *   - Match `image/webp` → `image/webp`.
 *   - Anything else (e.g. `application/octet-stream`, an unrecognised
 *     vendor type) → `image/jpeg` (SDK default).
 */
function detectMimeFromContentType(contentType: string | null): string {
  if (!contentType) return "image/jpeg";
  const base = contentType.split(";")[0].trim().toLowerCase();
  if (base === "image/jpeg" || base === "image/jpg") return "image/jpeg";
  if (base === "image/png") return "image/png";
  if (base === "image/webp") return "image/webp";
  return "image/jpeg";
}

// ---------------------------------------------------------------------------
// Data-URI conversion (replaces SDK `toDataUri` — DESIGN.md §9)
// ---------------------------------------------------------------------------

/**
 * Injectable dependencies for `convertToDataUri`. Fetch and timer
 * injection mirror the `MiniMaxQuotaClientDeps` pattern in
 * `quota-client.ts` so a unit test can drive the HTTP branch
 * deterministically without real network I/O.
 */
export interface ConvertToDataUriDeps {
  readonly fetch?: ProviderQuotaFetch;
  readonly setTimeout?: typeof setTimeout;
  readonly clearTimeout?: typeof clearTimeout;
}

/**
 * Minimal HTTP-fetch response shape `convertToDataUri` reads beyond
 * the duck-typed `ProviderQuotaFetchResponse`. Production `fetch`
 * returns the full `Response` (which exposes both fields); tests
 * inject doubles that match.
 */
type ImageFetchResponse = ProviderQuotaFetchResponse & {
  headers?: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
};

/**
 * Convert a MiniMax image source into the `data:<mime>;base64,...` form
 * the MiniMax VLM endpoint consumes. Three branches:
 *
 *   1. `data:` prefix → returned unchanged.
 *   2. `http(s)://` → bytes fetched via injected `fetch` with an
 *      `AbortController` timed out by `MINIMAX_IMAGE_FETCH_TIMEOUT_MS`,
 *      MIME detected via `detectMimeFromContentType`, base64-encoded.
 *      The 50 MiB cap (`MINIMAX_MAX_IMAGE_BYTES`) is enforced on the
 *      fetched byte length.
 *   3. Local path → bytes read via `node:fs/promises`, MIME from
 *      `MINIMAX_IMAGE_MIME_BY_EXTENSION`. The path has already been
 *      validated (existence, size, extension) by `resolveImageSource`,
 *      so this branch trusts the prior validation.
 *
 * The HTTP branch mirrors the abort/timeout + injected-fetch +
 * injected-setTimeout pattern from `quota-client.ts` so the same test
 * fixtures drive both transports.
 */
export async function convertToDataUri(
  source: string,
  deps: ConvertToDataUriDeps = {},
): Promise<string> {
  // 1. data: passthrough.
  if (source.startsWith("data:")) {
    return source;
  }

  // 2. http(s):// fetch.
  if (source.startsWith("http://") || source.startsWith("https://")) {
    return await fetchHttpImageAsDataUri(source, deps);
  }

  // 3. Local path — extension already validated by resolveImageSource.
  return await readLocalImageAsDataUri(source);
}

async function fetchHttpImageAsDataUri(
  source: string,
  deps: ConvertToDataUriDeps,
): Promise<string> {
  const f = deps.fetch ?? (fetch as unknown as ProviderQuotaFetch);
  const setT = deps.setTimeout ?? setTimeout;
  const clearT = deps.clearTimeout ?? clearTimeout;
  const timeoutMs = MINIMAX_IMAGE_FETCH_TIMEOUT_MS;

  const controller = new AbortController();
  const timeoutId = setT(() => controller.abort(), timeoutMs);
  try {
    const res = (await f(source, {
      method: "GET",
      signal: controller.signal,
    })) as unknown as ImageFetchResponse;
    clearT(timeoutId);
    if (!res.ok) {
      await res.text().catch(() => {});
      throw new ApiError(`Failed to download image: HTTP ${res.status}`, res.status);
    }
    const contentType = res.headers?.get("content-type") ?? null;
    const mime = detectMimeFromContentType(contentType);
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MINIMAX_MAX_IMAGE_BYTES) {
      throw new ValidationError(
        `Image too large (${(buf.byteLength / 1024 / 1024).toFixed(2)} MiB). ` +
          `Maximum is ${(MINIMAX_MAX_IMAGE_BYTES / 1024 / 1024).toFixed(0)} MiB.`,
        MINIMAX_IMAGE_FORMAT_HELP,
      );
    }
    return `data:${mime};base64,${Buffer.from(buf).toString("base64")}`;
  } catch (err) {
    clearT(timeoutId);
    if (err instanceof ValidationError || err instanceof ApiError) throw err;
    if (err instanceof Error) {
      if (err.name === "AbortError") {
        throw new TimeoutError(timeoutMs);
      }
      const lower = err.message.toLowerCase();
      if (
        lower.includes("fetch") ||
        lower.includes("econnrefused") ||
        lower.includes("econnreset") ||
        lower.includes("enotfound") ||
        lower.includes("network")
      ) {
        throw new NetworkError("MiniMax image fetch network error");
      }
    }
    throw err;
  }
}

async function readLocalImageAsDataUri(source: string): Promise<string> {
  const ext = path.extname(source).toLowerCase();
  // Extension was validated by resolveImageSource; the fallback matches
  // SDK behaviour if an unknown extension ever reaches this branch.
  const mime = MINIMAX_IMAGE_MIME_BY_EXTENSION[ext] ?? "image/jpeg";
  const data = await readFile(source);
  return `data:${mime};base64,${data.toString("base64")}`;
}
