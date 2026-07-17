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
import * as path from "node:path";

import { FileError, ValidationError } from "../../lib/errors.js";

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
