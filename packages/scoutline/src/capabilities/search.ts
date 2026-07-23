/**
 * Search Capability Contract (DESIGN.md §7, PRD FR-010 through FR-016).
 *
 * Defines the normalized meaning shared by every Search Provider.
 * Commands consume the Capability through `SearchCapability.invoke`,
 * which returns `SearchSource[]` in the Provider-agnostic shape. All
 * Provider-specific fields (rank, occurrence count, count, summary
 * truncation, field projection, presentation) remain command meaning.
 *
 * The Cache Identity contract (`SearchCacheIdentity`,
 * `LegacySearchCacheCandidate`) is declared here so P2-02 can wire
 * Provider-partitioned cache keys without further type changes.
 *
 * Phase 2 implements only this contract. The Z.AI and MiniMax Search
 * Adapters arrive in P2-03 and P2-04; the production registry arrives
 * in P2-05. The Provider descriptors advertised in P2-01 already
 * declare the search Capability, so command wiring can begin once the
 * Adapters exist.
 */

import type { ProviderId } from "../providers/types.js";

// ---------------------------------------------------------------------------
// Search request: query and Provider controls
// ---------------------------------------------------------------------------

/** Recency filter accepted by Z.AI; MiniMax rejects it. */
export type SearchRecency = "oneDay" | "oneWeek" | "oneMonth" | "oneYear" | "noLimit";

/**
 * Topic hint accepted by all Search Providers. Each Adapter maps it
 * differently: Tavily passes it natively; Z.AI and MiniMax append a
 * keyword to the query inside `invoke()`.
 */
export type SearchTopic = "general" | "news" | "finance";

/**
 * Content-type axis. `video` selects video result content. It is a
 * content axis, not an editorial topic axis, so `type` and `topic` are
 * mutually exclusive (enforced at parse time). No Provider supports
 * `type` yet — every adapter rejects it with `UNSUPPORTED_OPTION` until
 * a later ticket wires Provider video dispatch.
 */
export type SearchType = "video";

/**
 * Provider controls accepted by the Search Capability. Every field is
 * optional. MiniMax rejects `domain`, `recency`, `contentSize`, and
 * `location` with `UNSUPPORTED_OPTION` before any SDK access. `topic`
 * is accepted by all adapters. `type` is rejected by every adapter
 * (provider support for `video` arrives in a later ticket).
 */
export interface SearchControls {
  domain?: string;
  recency?: SearchRecency;
  contentSize?: "medium" | "high";
  location?: "cn" | "us";
  topic?: SearchTopic;
  type?: SearchType;
}

/**
 * A Search request. `query` must contain at least one non-whitespace
 * character; the Capability's `validate` enforces this and throws
 * `ValidationError` otherwise.
 */
export interface SearchRequest {
  query: string;
  controls?: Readonly<SearchControls>;
}

/**
 * Normalized Search result. Adapters populate this from their Provider
 * response shape; commands merge, deduplicate, project, truncate, and
 * rank downstream. Provider-only fields are discarded.
 */
export interface SearchSource {
  title: string;
  url: string;
  summary: string;
  source?: string;
  date?: string;
}

// ---------------------------------------------------------------------------
// Cache identity
// ---------------------------------------------------------------------------

/**
 * Provider-owned legacy cache candidate. Old Z.AI keys encode raw
 * `WebSearchResult[]`; the Adapter supplies the decoder so shared cache
 * code never inspects Provider response shapes. Invalid decode is a
 * cache miss.
 */
export interface LegacySearchCacheCandidate {
  readonly key: string;
  decode(value: unknown): readonly SearchSource[] | null;
}

/**
 * Identity used to read and write a Provider-partitioned cache entry.
 * `credentialFingerprint` is the full lowercase SHA-256 hex digest of
 * the active credential and is never hashed a second time by cache
 * code. Request identity uses recursively key-sorted JSON of only
 * `query` and Provider controls.
 */
export interface SearchCacheIdentity {
  readonly provider: ProviderId;
  readonly capability: "search";
  readonly credentialFingerprint: string;
  readonly request: Readonly<SearchRequest>;
  readonly legacyCandidates?: readonly LegacySearchCacheCandidate[];
}

// ---------------------------------------------------------------------------
// Search Capability
// ---------------------------------------------------------------------------

/**
 * Search Capability contract. Every Adapter that supports Search
 * implements this interface and is consumed by shared execution. The
 * Adapter owns Provider field mapping; commands call only these three
 * methods.
 */
export interface SearchCapability {
  /**
   * Validate a request before any Provider access. Throws
   * `ValidationError` for an empty or whitespace-only query, and
   * `UnsupportedOptionError` for Provider-specific options the Adapter
   * does not accept. Validation must occur before credential resolution
   * or transport construction.
   */
  validate(request: SearchRequest): void;

  /**
   * Build the cache identity for a request. Called only after
   * `validate` succeeds. `compatibility.legacyCount` is the optional
   * command count; it may enter only `legacyCandidates` and never the
   * new request identity.
   */
  cacheIdentity(
    request: SearchRequest,
    compatibility?: { readonly legacyCount?: number },
  ): SearchCacheIdentity;

  /**
   * Invoke the Provider and return normalized sources. The Adapter
   * closes its transport and never retries inside this method; shared
   * execution owns retry policy.
   */
  invoke(request: SearchRequest): Promise<readonly SearchSource[]>;
}
