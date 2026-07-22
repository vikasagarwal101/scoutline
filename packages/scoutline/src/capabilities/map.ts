/**
 * Provider-neutral Map Capability Contract (tech-plan §2b).
 *
 * Declares the single Map operation (`map-fetch`), its provider-neutral
 * request, identity, cache, and result shapes, and a total normalized
 * cache decoder.
 *
 * It imports NO concrete Provider, transport, or Adapter. It does no URL
 * validation, raw response parsing, Provider field mapping, Provider
 * selection, retries, or presentation.
 *
 * Map is the simplest of the three new Tavily capabilities: the API
 * returns URLs only (no per-page content), so there is no per-page
 * projection or truncation concern. The handler therefore needs no
 * `--max-chars` flag.
 */

import type { CacheIdentity, CachedOperation } from "../lib/execution.js";

// ---------------------------------------------------------------------------
// Operation kind
// ---------------------------------------------------------------------------

/**
 * The single Map Capability operation. Cache identity partitions by the
 * composite `${capability}-${operation}` literal; the v2 partitioned key
 * shape is
 * `v2.map-map-fetch.<provider>.<credential-hash>.<request-hash>.json`.
 */
export type MapOperationKind = "map-fetch";

// ---------------------------------------------------------------------------
// Request shape
// ---------------------------------------------------------------------------

/**
 * Provider-neutral map request. `url` MUST be supplied explicitly (the
 * handler rejects non-`http(s)` values at parse time before this request
 * reaches the Adapter).
 *
 * Every field except `url` participates in the v2 partitioned cache
 * identity. `--no-cache` and output mode never appear here — they are
 * policy applied around the cached normalized result.
 */
export interface MapRequest {
  readonly url: string;
  /** Map depth, 1-5. Default 1 (single page). */
  readonly depth?: number;
  /** Max links to follow per page, 1-500. Default 20. */
  readonly breadth?: number;
  /** Total number of links to process, default 50. */
  readonly limit?: number;
  /** Regex patterns to select only matching URL paths. */
  readonly selectPaths?: string;
  /** Regex patterns to exclude matching URL paths. */
  readonly excludePaths?: string;
  /** Natural language instructions guiding which pages to map. */
  readonly instructions?: string;
}

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/**
 * Normalized map result. `schemaVersion: 1` is the breaking shape.
 * `urls` is the exact set of URLs the Provider returned (in Provider
 * order); `totalUrls` is the array length. `baseUrl` is the request
 * URL, recorded for symmetry with the Crawl result.
 */
export interface MapResult {
  readonly schemaVersion: 1;
  readonly baseUrl: string;
  readonly urls: readonly string[];
  readonly totalUrls: number;
}

// ---------------------------------------------------------------------------
// Operation descriptor and Capability
// ---------------------------------------------------------------------------

/**
 * Generic Map operation descriptor. The Adapter supplies one of these
 * for the `map-fetch` operation it supports.
 */
export interface MapOperation extends CachedOperation<MapRequest, MapResult> {
  readonly kind: MapOperationKind;
}

/**
 * Map Capability contract. Every Adapter that supports map implements
 * this interface and exposes it as `adapter.map`.
 */
export interface MapCapability {
  readonly fetch: MapOperation;
}

// ===========================================================================
// Total normalized cache decoder
// ===========================================================================
//
// Accepts `unknown`, returns the typed result or `null`, never throws, and
// never trusts a generic cast. Shape contract is local; the Adapter is
// responsible for producing values that conform to `MapResult`.

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Decode a MapResult from the cache. Returns the canonical `MapResult`
 * on success, `null` for any malformed value.
 */
export function decodeMapResult(value: unknown): MapResult | null {
  if (!isPlainObject(value)) return null;

  if (value.schemaVersion !== 1) return null;

  if (!isNonEmptyString(value.baseUrl)) return null;

  const urls = value.urls;
  if (!Array.isArray(urls)) return null;

  const decodedUrls: string[] = [];
  for (const entry of urls) {
    if (typeof entry !== "string" || entry.length === 0) return null;
    decodedUrls.push(entry);
  }

  const totalUrls = value.totalUrls;
  if (typeof totalUrls !== "number" || !Number.isFinite(totalUrls)) return null;

  return {
    schemaVersion: 1,
    baseUrl: value.baseUrl,
    urls: decodedUrls,
    totalUrls,
  };
}

// Re-export the shared identity type to keep the import surface narrow at
// every callsite that only needs the Map identity shape.
export type MapCacheIdentity = CacheIdentity<MapRequest, MapResult>;
