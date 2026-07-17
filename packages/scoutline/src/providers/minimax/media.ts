/**
 * MiniMax Provider Media Module (DESIGN.md §9 — P3-02).
 *
 * Owns MiniMax-local image media facts: accepted extensions, size limit,
 * existence check, and absolute-path resolution. Commands pass raw
 * path-or-URL strings; this module is the single owner of every
 * Provider-specific media decision for MiniMax images.
 *
 * Boundary rules (ARCHITECTURE.md §2):
 *   - May import normalized errors from `lib/errors.ts`.
 *   - Must NOT read file content. The transitional MiniMax SDK performs
 *     data-URI conversion; this module only `stat`s for existence and size
 *     and returns the validated absolute path.
 *
 * Media rules (DESIGN.md §9 MiniMax Transitional SDK):
 *   - Local image: JPG, JPEG, PNG, WebP (case-insensitive), at most 50 MiB.
 *   - HTTP(S) source is accepted.
 *   - Local source becomes an absolute path after validation.
 *   - The SDK performs data-URI conversion; this module does NOT read
 *     file content.
 *   - No MiniMax video media module exists in this scope.
 *   - Missing local file rejects with `FILE_ERROR`.
 *   - Non-HTTP URL-like strings and unsupported extensions reject with
 *     `VALIDATION_ERROR` and Provider-specific supported-format help.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { FileError, ValidationError } from "../../lib/errors.js";

// ---------------------------------------------------------------------------
// MiniMax media limits (DESIGN.md §9)
// ---------------------------------------------------------------------------

const MINIMAX_IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"];

const MINIMAX_MAX_IMAGE_BYTES = 50 * 1024 * 1024; // 50 MiB

const MINIMAX_IMAGE_FORMAT_HELP =
  "Supported MiniMax image formats: JPG, JPEG, PNG, WebP (max 50 MiB)";

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
