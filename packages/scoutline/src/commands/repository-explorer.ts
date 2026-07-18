/**
 * Provider-neutral Repository Explorer (P6-05, DESIGN.md §18, §11,
 * PRD FR-081, FR-083–FR-086, FR-088, FR-091; NFR-004, NFR-005, NFR-007).
 *
 * The Explorer is the single non-Adapter consumer of the Repository
 * Capability contract. It owns canonical repository-path handling,
 * deterministic breadth-first traversal, duplicate-directory
 * protection, and local Search/File `--max-chars` projection. It
 * constructs canonical Capability requests, hands them to shared
 * execution, and projects the normalized results.
 *
 * Boundary rules (ARCHITECTURE.md §2, NFR-004):
 *   - Imports ONLY provider-neutral Repository Capability types and
 *     shared `executeRepositoryOperation` / `ExecutionDependencies`,
 *     plus the normalized `ValidationError`.
 *   - Imports NO concrete Provider Adapter, MCP/UTCP client, raw tool
 *     name, or Provider response type. Provider-specific facts (ZRead
 *     grammar, credentials, transports) remain Adapter-internal.
 *   - Owns canonicalization, BFS, and projection; never owns
 *     transport, credentials, Provider selection, or command
 *     presentation.
 *
 * Fixed ordering (DESIGN.md §18):
 *   1. Apply Explorer-level defaults (Search `language`, Tree
 *      `depth`) and canonicalize paths.
 *   2. Validate `repository` (at-least-one-slash), `query`
 *      (non-whitespace), `language`, and `depth`.
 *   3. Construct the canonical Capability request.
 *   4. Delegate to `executeRepositoryOperation`, which runs
 *      `operation.validate`, `operation.cacheIdentity`, the
 *      provider-partitioned cache read, ordered legacy candidates,
 *      retry-wrapped invoke, and the normalized cache write.
 *   5. Apply post-execution `--max-chars` projection (Search/File
 *      only). Tree is never character-limited.
 *
 * `--max-chars` is post-execution projection. It never appears in
 * the canonical request, the cache identity, or the cache itself.
 */

import type {
  RepositoryCapability,
  RepositoryDirectoryListing,
  RepositoryDirectoryRequest,
  RepositoryEntry,
  RepositoryFileRequest,
  RepositoryFileResult,
  RepositorySearchRequest,
  RepositorySearchResult,
  RepositoryTreeResult,
} from "../capabilities/repository.js";
import {
  executeRepositoryOperation,
  type ExecutionDependencies,
  type RetryPolicy,
} from "../lib/execution.js";
import { ValidationError } from "../lib/errors.js";

// ---------------------------------------------------------------------------
// Repository-path canonicalizer (DESIGN.md §18, technical plan
// "Settled architecture").
//
// One repository-relative POSIX canonicalizer governs Tree `--path`,
// `repo read` path, cache identity, and Provider-derived children.
// The canonicalizer is total: it returns the canonical form or
// throws a normalized `ValidationError`. It never decodes percent
// escapes — `%2e` is three literal characters, not `.`.
// ---------------------------------------------------------------------------

/**
 * The kind of path being canonicalized. Governs root handling and
 * the File-only leading `./` convenience.
 */
export type RepositoryPathKind = "file" | "directory";

/**
 * Canonicalize a repository-relative POSIX path.
 *
 * Rules (DESIGN.md §18, technical plan):
 *   - Backslashes (`\\`) and ASCII control characters (C0 plus DEL,
 *     code points 0–31 and 127) always throw `ValidationError`.
 *   - Whole-string root aliases (`undefined`, `""`, `"/"`, `"."`)
 *     map to root (`""`). For File (`kind: "file"`), root is
 *     invalid and throws.
 *   - File accepts a single leading `./` and any leading `/` as
 *     convenience; both are stripped. Directory does NOT get the
 *     leading `./` convenience (a leading `.` segment is unsafe and
 *     is rejected below); leading `/` is naturally stripped by the
 *     empty-segment collapse.
 *   - Repeated `/` collapses and trailing `/` is removed via the
 *     empty-segment skip.
 *   - Actual `.` or `..` segments at any position throw.
 *   - Percent escapes are never decoded.
 *
 * Returns the canonical repository-relative POSIX path. `""` is the
 * repository root.
 */
export function canonicalizeRepositoryPath(
  input: string | undefined,
  kind: RepositoryPathKind,
): string {
  // 1. `undefined` is the canonical "omitted" value. For File this
  //    is invalid because File requires a non-root path; for
  //    Directory/Tree it is the root.
  if (input === undefined) {
    if (kind === "file") {
      throw new ValidationError("File path is required");
    }
    return "";
  }
  if (typeof input !== "string") {
    throw new ValidationError("Repository path must be a string");
  }

  // 2. Reject backslashes and ASCII control characters (C0 + DEL).
  //    Percent escapes are never decoded, so `%2e` and similar are
  //    preserved as literal three-character sequences.
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    if (code === 92 /* backslash */) {
      throw new ValidationError("Repository path must not contain backslashes");
    }
    if (code < 32 || code === 127) {
      throw new ValidationError("Repository path must not contain ASCII control characters");
    }
  }

  // 3. Whole-string root aliases. `""`, `"/"`, and `"."` all map
  //    to root. For File, root is invalid.
  if (input === "" || input === "/" || input === ".") {
    if (kind === "file") {
      throw new ValidationError("File path must not be the repository root");
    }
    return "";
  }

  // 4. File-only leading `./` convenience. Directory does not get
  //    this: a leading `.` segment is unsafe and is rejected below.
  //    Leading `/` is naturally stripped by the empty-segment
  //    collapse for both kinds.
  let work = input;
  if (kind === "file" && work.startsWith("./")) {
    work = work.slice(2);
  }

  // 5. Split, collapse empty segments (handles leading/trailing/
  //    repeated `/`), and reject any actual `.` or `..` segment.
  const segments: string[] = [];
  for (const segment of work.split("/")) {
    if (segment === "") continue;
    if (segment === "." || segment === "..") {
      throw new ValidationError(`Repository path must not contain a "${segment}" segment`);
    }
    segments.push(segment);
  }

  const canonical = segments.join("/");
  if (canonical === "") {
    // The input reduced to nothing (e.g., `"///"` or `"./"`). For
    // File, this is root and invalid; for Directory/Tree, this is
    // root.
    if (kind === "file") {
      throw new ValidationError("File path must not be the repository root");
    }
    return "";
  }
  return canonical;
}

// ---------------------------------------------------------------------------
// Defaults and Explorer-level pre-validation.
//
// Defaults and canonicalization happen BEFORE
// `operation.validate` / `operation.cacheIdentity`. The Explorer's
// pre-validation is provider-neutral (slash in repository,
// non-whitespace query, language in `{en, zh}`, finite positive
// integer depth); the Adapter's `operation.validate` runs after,
// as a defensive backstop with Provider-specific messaging.
// ---------------------------------------------------------------------------

/**
 * Normalize a Search language value. `undefined` defaults to `"en"`;
 * `"en"` and `"zh"` are passed through; any other value throws
 * `ValidationError`.
 */
function normalizeSearchLanguage(language: unknown): "en" | "zh" {
  if (language === undefined) return "en";
  if (language === "en" || language === "zh") return language;
  throw new ValidationError('Search language must be "en" or "zh"');
}

/**
 * Project a Tree depth value. `undefined` defaults to 1. Finite
 * positive values are floored to an integer; non-finite or
 * non-positive values throw `ValidationError`. Matches the
 * existing shipped behaviour.
 */
function projectTreeDepth(depth: unknown): number {
  if (depth === undefined) return 1;
  const n = Number(depth);
  if (!Number.isFinite(n) || n < 1) {
    throw new ValidationError("Tree depth must be a finite positive integer");
  }
  return Math.floor(n);
}

/**
 * Assert that `repository` is a string containing at least one `/`.
 * The check is provider-neutral and preserves the existing
 * at-least-one-slash rule. The exact repository text is preserved.
 */
function assertRepositoryString(repository: unknown): asserts repository is string {
  if (typeof repository !== "string") {
    throw new ValidationError("Repository must be a string");
  }
  let hasSlash = false;
  for (let i = 0; i < repository.length; i += 1) {
    if (repository.charCodeAt(i) === 47 /* "/" */) {
      hasSlash = true;
      break;
    }
  }
  if (!hasSlash) {
    throw new ValidationError(
      `Invalid repository format: "${repository}". Use "owner/repo" format (e.g., "facebook/react")`,
    );
  }
}

/**
 * Assert that `query` is a string containing at least one
 * non-whitespace character. The exact query text is preserved.
 */
function assertSearchQuery(query: unknown): asserts query is string {
  if (typeof query !== "string" || query.trim().length === 0) {
    throw new ValidationError("Search query must contain at least one non-whitespace character");
  }
}

// ---------------------------------------------------------------------------
// Provider-derived listing validation (DESIGN.md §18).
//
// Every Provider-returned listing and child is validated BEFORE
// snapshot/enqueue. The validator binds the listing to the exact
// canonical request and requires every entry to be the immediate
// child of the listing's path. Unsafe, inconsistent, or
// non-immediate children fail the whole tree; partial success is
// never returned. The validation is read-only and never mutates
// the Adapter result.
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Assert that `name` is a valid single path segment: a non-empty
 * string with no `/`, no backslash, no ASCII control characters
 * (C0 + DEL), and not equal to `.` or `..`. Percent escapes remain
 * literal (`%2e` is three characters, not `.`).
 *
 * A directory entry name supplies exactly one path segment, so the
 * segment-level rules are stricter than the full-path rules: a `/`
 * in a name would split it into multiple segments and is therefore
 * rejected here rather than collapsed.
 */
function assertValidEntryName(name: unknown): asserts name is string {
  if (typeof name !== "string" || name.length === 0) {
    throw new ValidationError("Provider-derived directory entry name must be a non-empty string");
  }
  for (let i = 0; i < name.length; i += 1) {
    const code = name.charCodeAt(i);
    if (code === 47 /* "/" */) {
      throw new ValidationError("Provider-derived directory entry name must not contain '/'");
    }
    if (code === 92 /* backslash */) {
      throw new ValidationError(
        "Provider-derived directory entry name must not contain backslashes",
      );
    }
    if (code < 32 || code === 127) {
      throw new ValidationError(
        "Provider-derived directory entry name must not contain ASCII control characters",
      );
    }
  }
  if (name === "." || name === "..") {
    throw new ValidationError(`Provider-derived directory entry name must not be "${name}"`);
  }
}

/**
 * Assert that `entry` is a structurally valid
 * {@link RepositoryEntry} that is the IMMEDIATE child of
 * `listingPath` under the canonical request.
 *
 * The entry's `name` must be a valid single segment, and the
 * entry's `path` must equal the immediate-child path constructed
 * from `listingPath` and `name`:
 *
 *   expectedPath = listingPath === "" ? name : listingPath + "/" + name
 *
 * `entry.path` MUST equal `expectedPath` exactly. The expectedPath
 * is then canonicalized through the shared canonicalizer under the
 * entry's kind to reject any non-canonical residue. Because
 * `listingPath` arrived canonical (either the Explorer-canonical
 * starting path or a previously validated immediate-child path) and
 * `entry.name` is a validated single segment, the canonical form
 * should equal the expected form; this final canonicalize call is
 * defensive against any future regression.
 *
 * DESIGN §18: `entry.name` is the final path segment and the
 * DirectoryListing holds the requested directory's immediate
 * entries.
 */
function assertValidRepositoryEntry(
  entry: unknown,
  listingPath: string,
): asserts entry is RepositoryEntry {
  if (!isPlainObject(entry)) {
    throw new ValidationError("Provider-derived directory entry must be an object");
  }
  assertValidEntryName(entry.name);
  if (entry.kind !== "file" && entry.kind !== "directory") {
    throw new ValidationError(
      "Provider-derived directory entry kind must be 'file' or 'directory'",
    );
  }
  if (typeof entry.path !== "string" || entry.path.length === 0) {
    throw new ValidationError("Provider-derived directory entry path must be a non-empty string");
  }
  // Compute the expected immediate-child path. listingPath is
  // already canonical; entry.name supplies one validated segment.
  const expectedPath = listingPath === "" ? entry.name : `${listingPath}/${entry.name}`;
  if (entry.path !== expectedPath) {
    throw new ValidationError(
      `Provider-derived directory entry path "${entry.path}" must equal the immediate-child path "${expectedPath}"`,
    );
  }
  // Canonical-safety: canonicalize the expectedPath under the
  // entry's kind to reject any non-canonical residue. Files use the
  // File canonicalizer (root invalid); directories use the
  // Directory canonicalizer (root allowed). A root child is
  // structurally impossible for a non-root listing but is defended
  // against here all the same.
  const canonical = canonicalizeRepositoryPath(expectedPath, entry.kind);
  if (canonical !== expectedPath) {
    throw new ValidationError(
      `Provider-derived directory entry path is not canonical: "${expectedPath}"`,
    );
  }
}

/**
 * Assert that `listing` is a structurally valid
 * {@link RepositoryDirectoryListing} BOUND to the canonical
 * {@link RepositoryDirectoryRequest}. The listing's `repository`
 * MUST equal `request.repository` and the listing's `path` MUST
 * equal `request.path`. Every entry MUST be a valid immediate
 * child of the listing's path.
 *
 * Without this binding a fake or buggy Adapter could return a
 * listing for a different repository or a different directory than
 * the one requested, and the BFS would snapshot or enqueue the
 * wrong subtree. Binding the listing to the request closes that
 * gap.
 */
function assertValidRepositoryDirectoryListing(
  listing: unknown,
  request: RepositoryDirectoryRequest,
): asserts listing is RepositoryDirectoryListing {
  if (!isPlainObject(listing)) {
    throw new ValidationError("Provider-derived directory listing must be an object");
  }
  if (typeof listing.repository !== "string") {
    throw new ValidationError("Provider-derived directory listing repository must be a string");
  }
  if (listing.repository !== request.repository) {
    throw new ValidationError(
      "Provider-derived directory listing repository must match the request repository",
    );
  }
  if (typeof listing.path !== "string") {
    throw new ValidationError("Provider-derived directory listing path must be a string");
  }
  if (listing.path !== request.path) {
    throw new ValidationError(
      "Provider-derived directory listing path must match the request path",
    );
  }
  if (!Array.isArray(listing.entries)) {
    throw new ValidationError("Provider-derived directory listing entries must be an array");
  }
  for (const entry of listing.entries) {
    assertValidRepositoryEntry(entry, listing.path);
  }
}

// ---------------------------------------------------------------------------
// Local `--max-chars` projection (DESIGN.md §18, technical plan).
//
// Projection is post-execution: it runs on the normalized result
// returned by shared execution. It is the only step that consumes
// `--max-chars`. `--max-chars` never enters the canonical request,
// the cache identity, or the cache itself. Tree is never
// character-limited.
// ---------------------------------------------------------------------------

/**
 * Apply the Search `--max-chars` budget. The budget is a single
 * total character count consumed by `excerpts[].text` in Provider
 * order. Absent, `NaN`, zero, or negative means no truncation
 * (matches the shipped `!max || max <= 0` rule). `Infinity` is
 * naturally unlimited (the loop fits every excerpt). Whole
 * excerpts are kept while they fit; the final retained excerpt is
 * truncated with the existing rule
 * `text.slice(0, remaining - 1).trimEnd() + "…"`; later excerpts
 * are omitted. Metadata (`repository`, `query`, `language`,
 * `originalTextLength`) is outside the budget. `originalTextLength`
 * reports the full pre-projection value; `truncated` is set if the
 * projection omitted or truncated any excerpt, OR if the Provider
 * flagged its own truncation.
 *
 * The input result is never mutated.
 */
function projectSearchResult(
  result: RepositorySearchResult,
  maxChars: number | undefined,
): RepositorySearchResult {
  if (!maxChars || maxChars <= 0) {
    return result;
  }

  let remaining = maxChars;
  const projectedExcerpts: { text: string }[] = [];
  let projectionTruncated = false;

  for (const excerpt of result.excerpts) {
    if (remaining <= 0) {
      projectionTruncated = true;
      break;
    }
    if (excerpt.text.length <= remaining) {
      projectedExcerpts.push({ text: excerpt.text });
      remaining -= excerpt.text.length;
    } else {
      const truncatedText = excerpt.text.slice(0, remaining - 1).trimEnd() + "…";
      projectedExcerpts.push({ text: truncatedText });
      remaining = 0;
      projectionTruncated = true;
    }
  }

  if (!projectionTruncated) {
    return result;
  }

  return {
    schemaVersion: 1,
    repository: result.repository,
    query: result.query,
    language: result.language,
    excerpts: projectedExcerpts,
    truncated: true,
    originalTextLength: result.originalTextLength,
  };
}

/**
 * Apply the File `--max-chars` budget to `content`. Absent, `NaN`,
 * zero, or negative means no truncation (matches the shipped
 * `!max || max <= 0` rule). `Infinity` is naturally unlimited.
 * Content shorter than or equal to the budget is returned
 * unchanged. Otherwise the content is truncated with the existing
 * rule `content.slice(0, max - 1).trimEnd() + "…"`. `truncated` is
 * set if the projection truncated the content or if the Provider
 * flagged its own truncation. `originalContentLength` reports the
 * full pre-projection value.
 *
 * The input result is never mutated.
 */
function projectFileResult(
  result: RepositoryFileResult,
  maxChars: number | undefined,
): RepositoryFileResult {
  if (!maxChars || maxChars <= 0) {
    return result;
  }
  if (result.content.length <= maxChars) {
    return result;
  }
  const truncatedContent = result.content.slice(0, maxChars - 1).trimEnd() + "…";
  return {
    schemaVersion: 1,
    repository: result.repository,
    path: result.path,
    content: truncatedContent,
    truncated: true,
    originalContentLength: result.originalContentLength,
  };
}

// ---------------------------------------------------------------------------
// Breadth-first traversal (DESIGN.md §18).
//
// Deterministic BFS that preserves Provider sibling order,
// snapshots breadth-first, requests each canonical directory at
// most once, expands only directories while `level < depth`, and
// never returns partial success after a directory failure.
// ---------------------------------------------------------------------------

/**
 * Collect directory snapshots via deterministic breadth-first
 * traversal.
 *
 * Rules:
 *   - BFS starts at level 1 with the canonical starting path. The
 *     starting directory is requested exactly once and snapshotted
 *     even at depth 1.
 *   - Children are snapshot/enqueued in Provider sibling order.
 *     Only `kind: "directory"` children are enqueued, and only
 *     while `level < depth`.
 *   - Each canonical directory path is requested at most once.
 *     Duplicate encounters (a directory reachable from multiple
 *     parents) preserve first-encounter order and are not
 *     re-requested.
 *   - Every Provider-derived listing and entry is validated before
 *     snapshot/enqueue. Unsafe or inconsistent children fail the
 *     whole tree; partial success is never returned.
 *
 * `executeRepositoryOperation` is the single transport-touching
 * call per directory; it owns validate/cache-identity/cache/retry.
 * The Explorer never invokes the Adapter directly.
 */
async function collectTreeSnapshots(
  capability: RepositoryCapability,
  canonicalRequest: RepositoryDirectoryRequest,
  depth: number,
  options: { noCache?: boolean; retryPolicy?: RetryPolicy },
  dependencies: ExecutionDependencies,
): Promise<RepositoryDirectoryListing[]> {
  const snapshots: RepositoryDirectoryListing[] = [];
  const visited = new Set<string>();
  // Queue entries: { request, level }. The starting path is
  // enqueued at level 1. The visited set is populated at enqueue
  // time so a directory reachable from multiple parents is
  // requested exactly once and appears in first-encounter order.
  const queue: Array<{ request: RepositoryDirectoryRequest; level: number }> = [
    { request: canonicalRequest, level: 1 },
  ];
  visited.add(canonicalRequest.path);

  while (queue.length > 0) {
    const { request, level } = queue.shift()!;
    const listing = await executeRepositoryOperation(
      capability.listDirectory,
      request,
      options,
      dependencies,
    );
    // Validate the Adapter result before snapshot/enqueue. Bind the
    // listing to the canonical request so a fake or buggy Adapter
    // cannot snapshot or enqueue a different repository, a different
    // directory, or non-immediate children.
    assertValidRepositoryDirectoryListing(listing, request);
    snapshots.push(listing);

    if (level >= depth) continue;

    for (const entry of listing.entries) {
      if (entry.kind !== "directory") continue;
      if (visited.has(entry.path)) continue;
      visited.add(entry.path);
      queue.push({
        request: { repository: request.repository, path: entry.path },
        level: level + 1,
      });
    }
  }

  return snapshots;
}

// ---------------------------------------------------------------------------
// Public Explorer API.
// ---------------------------------------------------------------------------

/**
 * Request shape accepted by {@link explorerSearch}. `language` is
 * optional; the Explorer applies the `"en"` default before the
 * Capability sees the request. `repository` and `query` preserve
 * their exact case and text.
 */
export interface ExplorerSearchRequest {
  readonly repository: string;
  readonly query: string;
  readonly language?: "en" | "zh";
}

/**
 * Request shape accepted by {@link explorerReadFile}. `path` is
 * canonicalized through the File rules: leading `./` and `/` are
 * stripped, root is rejected, and unsafe segments throw.
 */
export interface ExplorerReadFileRequest {
  readonly repository: string;
  readonly path: string;
}

/**
 * Request shape accepted by {@link explorerTree}. `path` is
 * canonicalized through the Directory/Tree rules:
 * omitted/empty/`/`/`.` map to root, and unsafe segments throw.
 * `depth` defaults to 1.
 */
export interface ExplorerTreeRequest {
  readonly repository: string;
  readonly path?: string;
  readonly depth?: number;
}

/**
 * Options for Search and File. `noCache` and `retryPolicy` are
 * forwarded to `executeRepositoryOperation`. `maxChars` is
 * post-execution projection only and never enters the canonical
 * request or cache identity.
 */
export interface ExplorerOptions {
  readonly noCache?: boolean;
  readonly retryPolicy?: RetryPolicy;
  readonly maxChars?: number;
}

/**
 * Options for Tree. Tree is never character-limited; `maxChars` is
 * intentionally absent.
 */
export interface ExplorerTreeOptions {
  readonly noCache?: boolean;
  readonly retryPolicy?: RetryPolicy;
}

/**
 * Provider-neutral Repository Search (DESIGN.md §18, PRD FR-081,
 * FR-083). Applies the `language` default, validates `repository`
 * (at-least-one-slash) and `query` (non-whitespace), constructs the
 * canonical request, delegates to shared execution, and applies the
 * `--max-chars` budget to `excerpts[].text` only.
 *
 * Defaults and canonicalization precede `operation.validate` /
 * `operation.cacheIdentity`. The Provider sees the canonical
 * request; the Explorer never widens into Provider-specific fields.
 */
export async function explorerSearch(
  capability: RepositoryCapability,
  request: ExplorerSearchRequest,
  options: ExplorerOptions,
  dependencies: ExecutionDependencies,
): Promise<RepositorySearchResult> {
  assertRepositoryString(request.repository);
  assertSearchQuery(request.query);
  const language = normalizeSearchLanguage(request.language);

  const canonicalRequest: RepositorySearchRequest = {
    repository: request.repository,
    query: request.query,
    language,
  };

  const result = await executeRepositoryOperation(
    capability.search,
    canonicalRequest,
    { noCache: options.noCache, retryPolicy: options.retryPolicy },
    dependencies,
  );

  return projectSearchResult(result, options.maxChars);
}

/**
 * Provider-neutral Repository File read (DESIGN.md §18, PRD FR-086).
 * Canonicalizes the File path (root rejected, leading `./` and `/`
 * stripped, unsafe segments throw), delegates to shared execution,
 * and applies the `--max-chars` budget to `content` only.
 */
export async function explorerReadFile(
  capability: RepositoryCapability,
  request: ExplorerReadFileRequest,
  options: ExplorerOptions,
  dependencies: ExecutionDependencies,
): Promise<RepositoryFileResult> {
  assertRepositoryString(request.repository);
  const canonicalPath = canonicalizeRepositoryPath(request.path, "file");

  const canonicalRequest: RepositoryFileRequest = {
    repository: request.repository,
    path: canonicalPath,
  };

  const result = await executeRepositoryOperation(
    capability.readFile,
    canonicalRequest,
    { noCache: options.noCache, retryPolicy: options.retryPolicy },
    dependencies,
  );

  return projectFileResult(result, options.maxChars);
}

/**
 * Provider-neutral Repository Tree (DESIGN.md §18, PRD FR-088).
 * Canonicalizes the starting path (root allowed), projects depth
 * (default 1, finite positive integer), and drives a deterministic
 * breadth-first traversal that preserves Provider sibling order,
 * requests each canonical directory at most once, and never returns
 * partial success. Tree is never character-limited.
 */
export async function explorerTree(
  capability: RepositoryCapability,
  request: ExplorerTreeRequest,
  options: ExplorerTreeOptions,
  dependencies: ExecutionDependencies,
): Promise<RepositoryTreeResult> {
  assertRepositoryString(request.repository);
  const canonicalPath = canonicalizeRepositoryPath(request.path, "directory");
  const depth = projectTreeDepth(request.depth);

  const canonicalRequest: RepositoryDirectoryRequest = {
    repository: request.repository,
    path: canonicalPath,
  };

  const snapshots = await collectTreeSnapshots(
    capability,
    canonicalRequest,
    depth,
    { noCache: options.noCache, retryPolicy: options.retryPolicy },
    dependencies,
  );

  return {
    schemaVersion: 1,
    repository: request.repository,
    path: canonicalPath,
    depth,
    snapshots,
  };
}
