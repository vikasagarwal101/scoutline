/**
 * Provider-neutral Research Capability Contract (tech-plan §2c, §3).
 *
 * Declares the single Research operation (`research-fetch`), its
 * provider-neutral request, identity, cache, and result shapes, and a
 * total normalized cache decoder.
 *
 * Research is the most complex of the three new Tavily capabilities: it
 * runs an asynchronous create→poll lifecycle server-side and costs 4-250
 * credits per request. The Adapter's `invoke()` owns that full lifecycle
 * (state-file resume, POST, poll loop, completion/failure/404 handling);
 * shared execution wraps it with the standard cache-then-invoke pattern
 * but forces `maxRetries: 0` so a transient POST failure never risks a
 * double-charge (tech-plan §3, §4).
 *
 * It imports NO concrete Provider, transport, or Adapter. It does no
 * query validation, raw response parsing, Provider field mapping,
 * Provider selection, retries, or presentation.
 */

import type { CacheIdentity, CachedOperation } from "../lib/execution.js";

// ---------------------------------------------------------------------------
// Operation kind
// ---------------------------------------------------------------------------

/**
 * The single Research Capability operation. Cache identity partitions by
 * the composite `${capability}-${operation}` literal; the v2 partitioned
 * key shape is
 * `v2.research-research-fetch.<provider>.<credential-hash>.<request-hash>.json`.
 *
 * `--max-chars`, `--no-cache`, `--timeout` (polling), and output mode are
 * handler-level projections/policy and do NOT participate in the cache
 * identity.
 */
export type ResearchOperationKind = "research-fetch";

// ---------------------------------------------------------------------------
// Request shape
// ---------------------------------------------------------------------------

/**
 * Provider-neutral research request. `query` MUST be supplied explicitly
 * (the handler rejects empty/whitespace queries at parse time before this
 * request reaches the Adapter).
 *
 * EVERY field except `query` participates in the v2 partitioned cache
 * identity: `model`, `outputLength`, `citationFormat`, and `domain` each
 * alter the report the Provider produces, so two requests differing only
 * in citation format MUST NOT share a cache entry. `--max-chars`,
 * `--no-cache`, `--timeout`, and output mode NEVER appear here — they are
 * projections/policy applied around the cached normalized result.
 */
export interface ResearchRequest {
  readonly query: string;
  /** Research model: mini (cheapest), pro (deepest), auto (default). */
  readonly model?: "mini" | "pro" | "auto";
  /** Output length: short, standard (default), long. */
  readonly outputLength?: "short" | "standard" | "long";
  /** Citation format: numbered (default), mla, apa, chicago. */
  readonly citationFormat?: "numbered" | "mla" | "apa" | "chicago";
  /** Restrict research to a single domain. */
  readonly domain?: string;
}

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/**
 * A single research source. `favicon` and other Provider-only fields are
 * dropped at the Adapter boundary.
 */
export interface ResearchSource {
  readonly title: string;
  readonly url: string;
}

/**
 * Normalized research result. `schemaVersion: 1` is the breaking shape.
 * `report` is the full report text (cache stores it untruncated;
 * `--max-chars` is a handler projection). `model` echoes the requested
 * model so the cached entry is self-describing.
 */
export interface ResearchResult {
  readonly schemaVersion: 1;
  readonly query: string;
  readonly model: string;
  readonly report: string;
  readonly sources: readonly ResearchSource[];
}

// ---------------------------------------------------------------------------
// Operation descriptor and Capability
// ---------------------------------------------------------------------------

/**
 * Generic Research operation descriptor. The Adapter supplies one of
 * these for the `research-fetch` operation it supports. The Adapter's
 * `invoke()` owns the full create→poll→state-file lifecycle internally
 * (tech-plan §3); shared execution wraps it with cache + zero-retry.
 */
export interface ResearchOperation extends CachedOperation<ResearchRequest, ResearchResult> {
  readonly kind: ResearchOperationKind;
}

/**
 * Research Capability contract. Every Adapter that supports research
 * implements this interface and exposes it as `adapter.research`.
 */
export interface ResearchCapability {
  readonly run: ResearchOperation;
}

// ===========================================================================
// Total normalized cache decoder
// ===========================================================================
//
// Accepts `unknown`, returns the typed result or `null`, never throws, and
// never trusts a generic cast. Shape contract is local; the Adapter is
// responsible for producing values that conform to `ResearchResult`.

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Decode a ResearchResult from the cache. Returns the canonical
 * `ResearchResult` on success, `null` for any malformed value.
 */
export function decodeResearchResult(value: unknown): ResearchResult | null {
  if (!isPlainObject(value)) return null;

  if (value.schemaVersion !== 1) return null;

  if (!isNonEmptyString(value.query)) return null;
  if (!isNonEmptyString(value.model)) return null;
  // `report` may legitimately be empty for a failed-but-completed run, but
  // it must be a string. Require the field; do not require non-empty.
  if (typeof value.report !== "string") return null;

  const sources = value.sources;
  if (!Array.isArray(sources)) return null;

  const decodedSources: ResearchSource[] = [];
  for (const entry of sources) {
    if (!isPlainObject(entry)) return null;
    if (!isNonEmptyString(entry.title)) return null;
    if (!isNonEmptyString(entry.url)) return null;
    decodedSources.push({ title: entry.title, url: entry.url });
  }

  return {
    schemaVersion: 1,
    query: value.query,
    model: value.model,
    report: value.report,
    sources: decodedSources,
  };
}

// Re-export the shared identity type to keep the import surface narrow at
// every callsite that only needs the Research identity shape.
export type ResearchCacheIdentity = CacheIdentity<ResearchRequest, ResearchResult>;
