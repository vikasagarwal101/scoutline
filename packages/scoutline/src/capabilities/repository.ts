/**
 * Provider-neutral Repository Capability Contract (DESIGN.md §18,
 * PRD FR-081, FR-083, FR-086, FR-089; NFR-004, NFR-006, NFR-007).
 *
 * This module declares the three repository operations (Search, Read File,
 * Directory Listing), their provider-neutral request, identity, cache, and
 * result shapes, and the total normalized cache decoders used by shared
 * execution. It imports NO concrete Provider, transport, or Adapter. It
 * does no path canonicalization, raw ZRead parsing, Provider field
 * mapping, Provider selection, retries, or presentation.
 *
 * Scope of this file:
 *   - request, operation, cache-identity, and result type contracts;
 *   - total decoders for the three cacheable normalized result types
 *     (`decodeRepositorySearch`, `decodeRepositoryFile`,
 *     `decodeRepositoryDirectoryListing`);
 *   - the discriminated `RepositoryOperationKind` union shared by shared
 *     execution, retry policy, and diagnostics.
 *
 * P6-02 introduces ONLY this contract and the decoders. P6-03 supplies
 * shared execution, P6-04 the Z.AI Adapter, and P6-05 the Explorer. The
 * capability surface here is the boundary between those tickets and the
 * commands; nothing in this file is allowed to widen the boundary.
 */

import type { ProviderId } from "../providers/types.js";

// ---------------------------------------------------------------------------
// Operation kinds
// ---------------------------------------------------------------------------

/**
 * Discriminated union over the three repository operations. Shared
 * execution maps each kind to its retry policy branch and diagnostics
 * inventory. The union is the public source of truth; consumers iterate
 * by listing each literal explicitly when they need a runtime set.
 */
export type RepositoryOperationKind =
  | "repository-search"
  | "repository-read-file"
  | "repository-list-directory";

// ---------------------------------------------------------------------------
// Request shapes
// ---------------------------------------------------------------------------

/**
 * Provider-neutral Search request. `language` MUST be supplied explicitly
 * (default `"en"` applied at the command layer before validation); empty
 * or whitespace-only `query` is invalid at validate time.
 */
export interface RepositorySearchRequest {
  readonly repository: string;
  readonly query: string;
  readonly language: "en" | "zh";
}

/**
 * Provider-neutral File request. `path` is a non-empty
 * repository-relative POSIX path; `path: ""` (root) is invalid for File
 * and is rejected by the cache decoder.
 */
export interface RepositoryFileRequest {
  readonly repository: string;
  readonly path: string;
}

/**
 * Provider-neutral Directory Listing request. `path: ""` is the
 * repository root; every other path is a non-empty repository-relative
 * POSIX path.
 */
export interface RepositoryDirectoryRequest {
  readonly repository: string;
  readonly path: string;
}

// ---------------------------------------------------------------------------
// Result / entry types
// ---------------------------------------------------------------------------

/**
 * Provider-neutral directory or file entry. `name` is the final segment
 * and `path` is the repository-relative POSIX path of the entry
 * itself. Both fields are non-empty strings — root-level entries are
 * impossible because a directory entry sits below the listing's
 * `path`. Order is Provider-supplied and preserved.
 */
export interface RepositoryEntry {
  readonly name: string;
  readonly path: string;
  readonly kind: "file" | "directory";
}

/** Search excerpt: only text. ZRead does not supply reliable metadata. */
export interface RepositorySearchExcerpt {
  readonly text: string;
}

/**
 * Normalized Provider-derived Search result. `schemaVersion: 1` is the
 * breaking migration shape from P6 (`data-mode scripting impact`).
 */
export interface RepositorySearchResult {
  readonly schemaVersion: 1;
  readonly repository: string;
  readonly query: string;
  readonly language: "en" | "zh";
  readonly excerpts: readonly RepositorySearchExcerpt[];
  readonly truncated: boolean;
  readonly originalTextLength: number;
}

/**
 * Normalized File result. `path` is a non-empty repository-relative
 * POSIX path; the cache decoder rejects `path: ""` because File is
 * always non-root. `truncated` carries the existing ellipsis rule.
 */
export interface RepositoryFileResult {
  readonly schemaVersion: 1;
  readonly repository: string;
  readonly path: string;
  readonly content: string;
  readonly truncated: boolean;
  readonly originalContentLength: number;
}

/**
 * Normalized Directory Listing result. `path: ""` means the
 * repository root. `entries` is never `null` and preserves sibling
 * order from the Provider. Each entry's `name` and `path` are
 * non-empty.
 */
export interface RepositoryDirectoryListing {
  readonly repository: string;
  readonly path: string;
  readonly entries: readonly RepositoryEntry[];
}

/**
 * Normalized Repository Tree result, composed of provider-ordered
 * `snapshots`. `path: ""` means tree root. `depth` is the integer
 * tree depth applied at the Explorer layer. Tree is Explorer
 * projection and is not a cacheable `RepositoryOperation.decodeCached`
 * implementation; this type remains public because Explorer surfaces
 * it.
 */
export interface RepositoryTreeResult {
  readonly schemaVersion: 1;
  readonly repository: string;
  readonly path: string;
  readonly depth: number;
  readonly snapshots: readonly RepositoryDirectoryListing[];
}

// ---------------------------------------------------------------------------
// Cache identity
// ---------------------------------------------------------------------------

/**
 * Provider-owned legacy cache candidate. Old Z.AI keys encode the
 * raw v0.2 tool response; the Adapter supplies the decoder so shared
 * cache code never inspects Provider response shapes. An invalid
 * decode is a cache miss.
 */
export interface LegacyRepositoryCacheCandidate<Result> {
  readonly key: string;
  decode(value: unknown): Result | null;
}

/**
 * Identity used to read and write a Provider-partitioned cache entry.
 * `credentialFingerprint` is the full lowercase SHA-256 hex digest of
 * the resolved credential and is NEVER re-hashed by cache code.
 * `request` is the normalized Capability request.
 */
export interface RepositoryCacheIdentity<Request, Result> {
  readonly provider: ProviderId;
  readonly capability: "repository-exploration";
  readonly operation: RepositoryOperationKind;
  readonly credentialFingerprint: string;
  readonly request: Readonly<Request>;
  readonly legacyCandidates: readonly LegacyRepositoryCacheCandidate<Result>[];
}

// ---------------------------------------------------------------------------
// Operation descriptor
// ---------------------------------------------------------------------------

/**
 * Generic operation descriptor. Each Adapter supplies one of these for
 * each operation it supports. The Adapter owns Provider field mapping,
 * credentials, transport lifecycle, and error normalization. Commands
 * and shared execution call only these four methods.
 */
export interface RepositoryOperation<Request, Result> {
  readonly kind: RepositoryOperationKind;
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
  cacheIdentity(request: Request): RepositoryCacheIdentity<Request, Result>;
  /**
   * Total decoder for cached normalized entries. Accepts an `unknown`
   * value, validates shape, and returns the typed result or `null`.
   * NEVER throws, NEVER trusts a generic cast.
   */
  decodeCached(value: unknown): Result | null;
  /**
   * Invoke the Provider and return the normalized result. The Adapter
   * closes its transport and never retries inside this method;
   * shared execution owns retry policy.
   */
  invoke(request: Request): Promise<Result>;
}

// ---------------------------------------------------------------------------
// Repository Capability
// ---------------------------------------------------------------------------

/**
 * Repository Capability contract. Every Adapter that supports
 * repository exploration implements this interface and exposes it as
 * `adapter.repository` (P6-04 and beyond).
 */
export interface RepositoryCapability {
  readonly search: RepositoryOperation<RepositorySearchRequest, RepositorySearchResult>;
  readonly readFile: RepositoryOperation<RepositoryFileRequest, RepositoryFileResult>;
  readonly listDirectory: RepositoryOperation<
    RepositoryDirectoryRequest,
    RepositoryDirectoryListing
  >;
}

// ===========================================================================
// Total normalized cache decoders
// ===========================================================================
//
// Every decoder accepts `unknown`, returns the typed result or `null`,
// never throws, and never trusts a generic cast. The shape contract is
// local; the three adapters in P6-04 are responsible for producing
// values that conform to the Result interfaces.
//
// Rules encoded in each decoder:
//   - reject primitives and arrays at the top level (results are objects);
//   - reject required scalar fields that are missing or of the wrong
//     type;
//   - reject arrays that are themselves nullable or contain malformed
//     items — partial goodness is NEVER a success;
//   - preserve exact order, exact strings, exact numeric values;
//   - accept an empty array as valid (a future Adapter contract).

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
 * Type guard for a non-negative finite integer (0 or positive, no
 * fractional part). `Number.NaN`, `Infinity`, and negatives are rejected.
 */
function isNonNegativeFiniteInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0
  );
}

/**
 * Decode a Search result from the cache. Returns the canonical
 * `RepositorySearchResult` on success, `null` for any malformed value.
 */
export function decodeRepositorySearch(value: unknown): RepositorySearchResult | null {
  if (!isPlainObject(value)) return null;

  if (value.schemaVersion !== 1) return null;
  if (typeof value.repository !== "string") return null;
  if (typeof value.query !== "string") return null;

  const language = value.language;
  if (language !== "en" && language !== "zh") return null;

  if (typeof value.truncated !== "boolean") return null;
  if (!isNonNegativeFiniteInteger(value.originalTextLength)) return null;

  const rawExcerpts = value.excerpts;
  if (!Array.isArray(rawExcerpts)) return null;
  const excerpts: RepositorySearchExcerpt[] = [];
  for (const item of rawExcerpts) {
    if (!isPlainObject(item)) return null;
    if (typeof item.text !== "string") return null;
    excerpts.push({ text: item.text });
  }

  return {
    schemaVersion: 1,
    repository: value.repository,
    query: value.query,
    language,
    excerpts,
    truncated: value.truncated,
    originalTextLength: value.originalTextLength,
  };
}

/**
 * Decode a File result from the cache. Returns the canonical
 * `RepositoryFileResult` on success, `null` otherwise. `path` MUST be
 * non-empty — File is always non-root; `path: ""` is rejected here
 * without performing any other path canonicalization.
 */
export function decodeRepositoryFile(value: unknown): RepositoryFileResult | null {
  if (!isPlainObject(value)) return null;

  if (value.schemaVersion !== 1) return null;
  if (typeof value.repository !== "string") return null;
  if (!isNonEmptyString(value.path)) return null;
  if (typeof value.content !== "string") return null;
  if (typeof value.truncated !== "boolean") return null;
  if (!isNonNegativeFiniteInteger(value.originalContentLength)) return null;

  return {
    schemaVersion: 1,
    repository: value.repository,
    path: value.path,
    content: value.content,
    truncated: value.truncated,
    originalContentLength: value.originalContentLength,
  };
}

/**
 * Decode a Directory Listing from the cache. Returns the canonical
 * `RepositoryDirectoryListing` on success, `null` otherwise. The
 * listing's own `path` may be `""` (root); every entry's `name` and
 * `path` MUST be non-empty. Empty entries arrays are valid (a future
 * Adapter contract). Each entry preserves Provider sibling order
 * verbatim.
 */
export function decodeRepositoryDirectoryListing(
  value: unknown,
): RepositoryDirectoryListing | null {
  if (!isPlainObject(value)) return null;

  if (typeof value.repository !== "string") return null;
  if (typeof value.path !== "string") return null;

  const rawEntries = value.entries;
  if (!Array.isArray(rawEntries)) return null;
  const entries: RepositoryEntry[] = [];
  for (const item of rawEntries) {
    if (!isPlainObject(item)) return null;
    if (!isNonEmptyString(item.name)) return null;
    if (!isNonEmptyString(item.path)) return null;
    if (item.kind !== "file" && item.kind !== "directory") return null;
    entries.push({
      name: item.name,
      path: item.path,
      kind: item.kind,
    });
  }

  return {
    repository: value.repository,
    path: value.path,
    entries,
  };
}