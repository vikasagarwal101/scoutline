/**
 * Provider-neutral Reader Capability Contract (core-flows D1, D2;
 * tech-plan D1, D2).
 *
 * This module declares the single Reader operation (`reader-fetch`), its
 * provider-neutral request, identity, cache, and result shapes, the total
 * normalized cache decoder, and the `ReaderRawResponse` type capturing
 * what the Z.AI WebReader MCP actually returns at runtime.
 *
 * It imports NO concrete Provider, transport, or Adapter. It does no URL
 * rewriting, raw response parsing, Provider field mapping, Provider
 * selection, retries, or presentation.
 *
 * Scope of this file:
 *   - request, operation, cache-identity, and result type contracts;
 *   - the discriminated `ReaderOperationKind` union;
 *   - a total decoder for the cacheable normalized result
 *     (`decodeReaderFetchResult`);
 *   - the `ReaderRawResponse` type consumed by Ticket 02's `webRead`
 *     signature fix.
 *
 * Ticket 01 introduces ONLY this contract and the decoder. Ticket 02
 * fixes `webRead` to return `ReaderRawResponse`. Ticket 03 supplies the
 * Z.AI Reader Adapter. Ticket 04 cuts the handler over. Nothing in this
 * file is allowed to widen that boundary.
 *
 * Evidence base: [`artifacts/reader-webreader-characterization/`](../../../../.traycer/epics/4f065460-3416-4832-95a6-7ac5576fcfbc/artifacts/reader-webreader-characterization/index.md).
 */

import type { ProviderId } from "../providers/types.js";

// ---------------------------------------------------------------------------
// Operation kinds
// ---------------------------------------------------------------------------

/**
 * The single Reader Capability operation. Cache identity partitions by
 * this literal; the v2 partitioned key shape is
 * `v2.reader-fetch.<provider>.<credential-hash>.<request-hash>.json`.
 *
 * `--extract` and `--max-chars` are handler-level projections and do
 * NOT participate in the cache identity (tech-plan D1, D2).
 */
export type ReaderOperationKind = "reader-fetch";

// ---------------------------------------------------------------------------
// Request shape
// ---------------------------------------------------------------------------

/**
 * Provider-neutral Reader fetch request. `url` MUST be supplied
 * explicitly (the handler rejects non-`http(s)` values at parse time
 * with `VALIDATION_ERROR` before this request reaches the Adapter).
 *
 * Every field except `url` participates in the v0.2 legacy cache key
 * (`buildLegacyReaderCacheKey`) and in the v2 partitioned cache identity
 * (`buildProviderCacheKey`). `--extract`, `--max-chars`, `--full-envelope`,
 * `--no-cache`, and output mode NEVER appear here — they are projections
 * applied after the cached normalized result.
 *
 * Field name parity with the v0.2 `webRead` request shape is intentional;
 * the Adapter maps each field to the Z.AI WebReader MCP argument of the
 * same semantics. The field order in the v0.2 insertion-order key is
 * locked by the legacy helper, not by this interface.
 */
export interface ReaderFetchRequest {
  readonly url: string;
  readonly format?: "markdown" | "text";
  readonly retainImages?: boolean;
  readonly withLinksSummary?: boolean;
  readonly noGfm?: boolean;
  readonly keepImgDataUrl?: boolean;
  readonly withImagesSummary?: boolean;
  readonly timeout?: number;
}

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/**
 * Normalized Reader fetch result. `schemaVersion: 1` is the breaking
 * migration shape (core-flows D1 — `data`-mode returns the envelope,
 * not a raw string).
 *
 * `truncated` and `originalContentLength` are NOT part of this contract.
 * They are handler-level projections applied by `commands/read.ts` after
 * the cached normalized result is produced (tech-plan D5). The cache
 * stores the full content; truncation state is recomputed on every read.
 *
 * `title` is `string | null`. Every observed Z.AI WebReader response
 * carries a non-empty string title (see characterization artifact), but
 * the contract keeps the nullable arm for forward-compat and for
 * Adapter-side coercion of empty / whitespace-only titles.
 *
 * `metadata` and `external` are typed `unknown` defensively. The
 * characterization probe observed both as flat object maps, but the
 * contract does not promote or restructure them — they pass through
 * verbatim from the Provider.
 */
export interface ReaderFetchResult {
  readonly schemaVersion: 1;
  /** Exactly what the caller passed to the operation. */
  readonly url: string;
  /**
   * The URL the operation actually fetched. Differs from `url` only when
   * a Provider-side rewrite occurred (e.g. `gist.github.com/<id>` →
   * `gist.github.com/<id>/raw`).
   */
  readonly finalUrl: string;
  /** Page title if the Provider returned one; `null` if absent or blank. */
  readonly title: string | null;
  /** Page content as markdown or plain text per `format`. */
  readonly content: string;
  /** Mirrors the request `format`; defaults to `"markdown"`. */
  readonly contentFormat: "markdown" | "text";
  /** Optional Provider-derived metadata blob; preserved verbatim. */
  readonly metadata?: unknown;
  /** Optional Provider-derived external-resource blob; preserved verbatim. */
  readonly external?: unknown;
}

// ---------------------------------------------------------------------------
// Raw Provider response (Ticket 02 consumes this)
// ---------------------------------------------------------------------------

/**
 * Object shape of a successful Z.AI WebReader MCP response. Field names
 * mirror the wire shape observed in the characterization probe. Every
 * field is optional at the wire layer — the Capability decoder enforces
 * the stronger invariants (`title`, `url`, `content` must be non-empty
 * strings) before promoting any value into a `ReaderFetchResult`.
 *
 * `description` is declared here so the Adapter can read it without
 * crashing on rich pages (the probe confirmed `description` appears
 * both at the top level and inside `metadata` for rich pages). The v1
 * envelope does NOT surface it; it is dropped during normalization.
 */
export interface ReaderRawObjectResponse {
  readonly title?: string;
  readonly description?: string;
  readonly url?: string;
  readonly content?: string;
  readonly metadata?: unknown;
  readonly external?: unknown;
}

/**
 * The complete raw shape returned by `scoutline.zai.reader.webReader` at
 * runtime. Either a structured object (the common case) or a bare
 * `string` carrying an MCP-level error envelope (the characterization
 * probe captured the exact shape: `"MCP error -500: ..."`).
 *
 * Ticket 02 widens the existing `webRead` method's TypeScript signature from
 * the inaccurate `Promise<string>` to `Promise<ReaderRawResponse>` so
 * raw-tool callers (`scoutline.zai.reader.*`) and the future Reader
 * Adapter both see an honest path.
 *
 * The Capability decoder (`decodeReaderFetchResult`) only trusts
 * object-shape values that satisfy the required field set. A raw
 * `string` is malformed at the Capability layer — it represents a
 * transport-level error that the Adapter must convert into a normalized
 * `API_ERROR` 502 per the failure-handling table, not a fetch result.
 */
export type ReaderRawResponse = ReaderRawObjectResponse | string;

// ---------------------------------------------------------------------------
// Cache identity
// ---------------------------------------------------------------------------

/**
 * Provider-owned legacy cache candidate. Old Z.AI v0.2 read cache entries
 * encode the raw WebReader response under the public dotted tool name
 * (`scoutline.zai.reader.webReader`). The Adapter supplies the decoder
 * so shared cache code never inspects Provider response shapes. An
 * invalid decode is a cache miss.
 */
export interface LegacyReaderCacheCandidate<Result> {
  readonly key: string;
  decode(value: unknown): Result | null;
}

/**
 * Identity used to read and write a Provider-partitioned Reader cache
 * entry. `credentialFingerprint` is the full lowercase SHA-256 hex
 * digest of the resolved credential and is NEVER re-hashed by cache
 * code. `request` is the normalized Capability request.
 */
export interface ReaderCacheIdentity<Request, Result> {
  readonly provider: ProviderId;
  readonly capability: "reader";
  readonly operation: ReaderOperationKind;
  readonly credentialFingerprint: string;
  readonly request: Readonly<Request>;
  readonly legacyCandidates: readonly LegacyReaderCacheCandidate<Result>[];
}

// ---------------------------------------------------------------------------
// Operation descriptor
// ---------------------------------------------------------------------------

/**
 * Generic Reader operation descriptor. The Adapter supplies one of these
 * for the `reader-fetch` operation it supports. The Adapter owns
 * Provider field mapping, credentials, transport lifecycle, and error
 * normalization. Commands and shared execution call only these four
 * methods.
 *
 * Same shape as P6-02's `RepositoryOperation` — the surface is
 * unchanged; only the operation count differs (Reader has one).
 */
export interface ReaderOperation<Request, Result> {
  readonly kind: ReaderOperationKind;
  /**
   * Validate the request before any Provider access. Throws
   * `ValidationError` for missing required fields and
   * `UnsupportedOptionError` for Provider-specific options the Adapter
   * does not accept. Validation MUST occur before credential resolution
   * or transport construction.
   */
  validate(request: Request): void;
  /**
   * Build the cache identity for a request. Called only after
   * `validate` succeeds. The Adapter resolves its credential once and
   * returns full fingerprint, canonical request, and zero or more
   * legacy candidates. Candidate construction MUST NOT read ambient
   * environment.
   */
  cacheIdentity(request: Request): ReaderCacheIdentity<Request, Result>;
  /**
   * Total decoder for cached normalized entries. Accepts an `unknown`
   * value, validates shape, and returns the typed result or `null`.
   * NEVER throws, NEVER trusts a generic cast.
   */
  decodeCached(value: unknown): Result | null;
  /**
   * Invoke the Provider and return the normalized result. The Adapter
   * closes its transport and never retries inside this method; shared
   * execution owns retry policy.
   */
  invoke(request: Request): Promise<Result>;
}

// ---------------------------------------------------------------------------
// Reader Capability
// ---------------------------------------------------------------------------

/**
 * Reader Capability contract. Every Adapter that supports reader
 * fetching implements this interface and exposes it as
 * `adapter.reader` (Ticket 03 onwards).
 */
export interface ReaderCapability {
  readonly fetch: ReaderOperation<ReaderFetchRequest, ReaderFetchResult>;
}

// ===========================================================================
// Total normalized cache decoder
// ===========================================================================
//
// Accepts `unknown`, returns the typed result or `null`, never throws, and
// never trusts a generic cast. Shape contract is local; the Adapter (Ticket
// 03) is responsible for producing values that conform to
// `ReaderFetchResult`.
//
// Rules encoded:
//   - reject primitives and arrays at the top level (results are objects);
//   - reject schemaVersion other than the literal number 1;
//   - reject missing or non-string `url`, `finalUrl`, `content`;
//   - reject empty `url`, `finalUrl`, `content` (the Capability requires
//     non-empty content; an empty fetch is a miss, not a degenerate hit);
//   - reject `title` that is neither a string nor null;
//   - reject `contentFormat` other than the literal strings "markdown"
//     or "text";
//   - preserve `metadata` and `external` verbatim when present.

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Type guard for a non-empty string. `""` is rejected.
 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Decode a Reader fetch result from the cache. Returns the canonical
 * `ReaderFetchResult` on success, `null` for any malformed value.
 *
 * `title: null` is a valid decoded value (the Adapter coerces missing
 * or blank titles to null before writing; the decoder round-trips it).
 */
export function decodeReaderFetchResult(value: unknown): ReaderFetchResult | null {
  if (!isPlainObject(value)) return null;

  // `schemaVersion` MUST be the literal number 1. The strict equality
  // rejects numeric strings, bigints, and any future version.
  if (value.schemaVersion !== 1) return null;

  if (!isNonEmptyString(value.url)) return null;
  if (!isNonEmptyString(value.finalUrl)) return null;
  if (!isNonEmptyString(value.content)) return null;

  const title = value.title;
  if (title !== null && typeof title !== "string") return null;

  const contentFormat = value.contentFormat;
  if (contentFormat !== "markdown" && contentFormat !== "text") return null;

  // Optional fields preserved verbatim when present, omitted from the
  // decoded result when absent so the round-trip equals the input shape.
  // Built in one shot so `readonly` invariants on `ReaderFetchResult`
  // are honored.
  const hasMetadata = value.metadata !== undefined;
  const hasExternal = value.external !== undefined;
  return {
    schemaVersion: 1,
    url: value.url,
    finalUrl: value.finalUrl,
    title: title as string | null,
    content: value.content,
    contentFormat,
    ...(hasMetadata ? { metadata: value.metadata } : {}),
    ...(hasExternal ? { external: value.external } : {}),
  };
}
