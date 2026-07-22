/**
 * Provider-neutral Crawl Capability Contract (tech-plan §2a).
 *
 * Declares the single Crawl operation (`crawl-fetch`), its
 * provider-neutral request, identity, cache, and result shapes, and a
 * total normalized cache decoder.
 *
 * It imports NO concrete Provider, transport, or Adapter. It does no URL
 * validation, raw response parsing, Provider field mapping, Provider
 * selection, retries, or presentation.
 */

import type { CacheIdentity, CachedOperation } from "../lib/execution.js";

// ---------------------------------------------------------------------------
// Operation kind
// ---------------------------------------------------------------------------

/**
 * The single Crawl Capability operation. Cache identity partitions by
 * the composite `${capability}-${operation}` literal; the v2 partitioned
 * key shape is
 * `v2.crawl-crawl-fetch.<provider>.<credential-hash>.<request-hash>.json`.
 *
 * `--max-chars` is a handler-level projection and does NOT participate in
 * the cache identity.
 */
export type CrawlOperationKind = "crawl-fetch";

// ---------------------------------------------------------------------------
// Request shape
// ---------------------------------------------------------------------------

/**
 * Provider-neutral crawl request. `url` MUST be supplied explicitly (the
 * handler rejects non-`http(s)` values at parse time before this request
 * reaches the Adapter).
 *
 * Every field except `url` participates in the v2 partitioned cache
 * identity. `--max-chars` and `--no-cache` NEVER appear here — they are
 * projections applied after the cached normalized result.
 */
export interface CrawlRequest {
  readonly url: string;
  /** Crawl depth, 1-5. Default 1 (single page). */
  readonly depth?: number;
  /** Max links to follow per page, 1-500. Default 20. */
  readonly breadth?: number;
  /** Total number of links to process, default 50. */
  readonly limit?: number;
  /** Regex patterns to select only matching URL paths. */
  readonly selectPaths?: string;
  /** Regex patterns to exclude matching URL paths. */
  readonly excludePaths?: string;
  /** Natural language instructions guiding which pages to crawl. */
  readonly instructions?: string;
  /** Output format: markdown (default) or text. */
  readonly format?: "markdown" | "text";
  /** Extraction depth: medium (basic, default) or high (advanced). */
  readonly contentSize?: "medium" | "high";
  /** Request timeout in seconds, default 150. */
  readonly timeout?: number;
}

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/**
 * A single crawled page. `truncated` and `originalContentLength` are NOT
 * part of this contract — they are handler-level projections applied by
 * `commands/crawl.ts` after the cached normalized result is produced.
 * The cache stores the full content; truncation state is recomputed on
 * every read.
 */
export interface CrawlPage {
  readonly url: string;
  readonly content: string;
  readonly contentFormat: "markdown" | "text";
}

/**
 * Normalized crawl result. `schemaVersion: 1` is the breaking shape.
 */
export interface CrawlResult {
  readonly schemaVersion: 1;
  readonly baseUrl: string;
  readonly pages: readonly CrawlPage[];
  readonly totalPages: number;
}

// ---------------------------------------------------------------------------
// Operation descriptor and Capability
// ---------------------------------------------------------------------------

/**
 * Generic Crawl operation descriptor. The Adapter supplies one of these
 * for the `crawl-fetch` operation it supports.
 */
export interface CrawlOperation extends CachedOperation<CrawlRequest, CrawlResult> {
  readonly kind: CrawlOperationKind;
}

/**
 * Crawl Capability contract. Every Adapter that supports crawl
 * implements this interface and exposes it as `adapter.crawl`.
 */
export interface CrawlCapability {
  readonly fetch: CrawlOperation;
}

// ===========================================================================
// Total normalized cache decoder
// ===========================================================================
//
// Accepts `unknown`, returns the typed result or `null`, never throws, and
// never trusts a generic cast. Shape contract is local; the Adapter is
// responsible for producing values that conform to `CrawlResult`.

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Decode a CrawlResult from the cache. Returns the canonical
 * `CrawlResult` on success, `null` for any malformed value.
 */
export function decodeCrawlResult(value: unknown): CrawlResult | null {
  if (!isPlainObject(value)) return null;

  if (value.schemaVersion !== 1) return null;

  if (!isNonEmptyString(value.baseUrl)) return null;

  const pages = value.pages;
  if (!Array.isArray(pages)) return null;

  const decodedPages: CrawlPage[] = [];
  for (const page of pages) {
    if (!isPlainObject(page)) return null;
    if (!isNonEmptyString(page.url)) return null;
    if (!isNonEmptyString(page.content)) return null;
    const contentFormat = page.contentFormat;
    if (contentFormat !== "markdown" && contentFormat !== "text") return null;
    decodedPages.push({ url: page.url, content: page.content, contentFormat });
  }

  const totalPages = value.totalPages;
  if (typeof totalPages !== "number" || !Number.isFinite(totalPages)) return null;

  return {
    schemaVersion: 1,
    baseUrl: value.baseUrl,
    pages: decodedPages,
    totalPages,
  };
}
