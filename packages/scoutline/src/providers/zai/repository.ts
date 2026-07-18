/**
 * Z.AI Repository Adapter (DESIGN.md §18, PRD FR-081, FR-087,
 * FR-089–FR-091, FR-093; NFR-004, NFR-006).
 *
 * Owns the Provider-facing half of the provider-neutral Repository
 * Capability defined in `src/capabilities/repository.ts`:
 *
 *   - total parsers for the characterized ZRead Search, File, and
 *     Directory Listing responses (`<excerpt>`, `<file_content>`,
 *     `<structure>`);
 *   - per-operation Z.AI descriptors with `validate`, `cacheIdentity`,
 *     `decodeCached`, and `invoke`;
 *   - a single resolved-credential fingerprint per cache identity and
 *     exact per-operation legacy cache candidates/decoders;
 *   - encoded MCP error classification BEFORE success parsing
 *     (exhausted quota is terminal `QUOTA_ERROR`; the rest of the
 *     taxonomy uses the shared retry/terminal classification);
 *   - a fresh transport per invocation attempt and exactly one
 *     best-effort close in `finally`; close failure never replaces
 *     success nor masks the primary failure;
 *   - no leakage of raw ZRead response types outside this module.
 *
 * Boundary rules (ARCHITECTURE.md §2):
 *   - May import capability types, normalized errors, the Z.AI MCP
 *     tool-name helpers, the legacy cache-key helper, and the
 *     shared `ZaiAdapterClientPort` typed client port.
 *   - Must NOT import another Provider's Adapter, command
 *     presentation, BFS/Explorer logic, or path canonicalization.
 *
 * Scope:
 *   - implements Search, File, and Directory Listing only. Tree
 *     projection, BFS, depth/path policy, and `--max-chars` all
 *     belong to the Explorer layer (P6-05+) or the command layer.
 *   - does NOT advertise Repository support on the descriptor
 *     metadata. `createZaiDescriptor.capabilities()` is unchanged;
 *     this module is reachable through `ProviderAdapter.repository`
 *     for tests and future Explorer integration, but no registry,
 *     selection, or command cutover is performed in this ticket.
 */

import crypto from "node:crypto";

import type { ZaiAdapterClientPort, ZaiMcpClientOptions } from "../types.js";
import {
  ApiError,
  AuthError,
  QuotaError,
  ScoutlineError,
  ValidationError,
} from "../../lib/errors.js";
import { getMcpToolName } from "../../lib/mcp-config.js";
import { buildLegacyRepositoryCacheKey } from "../../lib/cache.js";
import { requireZaiApiKey } from "./credentials.js";
import {
  decodeRepositoryDirectoryListing,
  decodeRepositoryFile,
  decodeRepositorySearch,
  type RepositoryCacheIdentity,
  type RepositoryCapability,
  type RepositoryDirectoryListing,
  type RepositoryDirectoryRequest,
  type RepositoryEntry,
  type RepositoryFileRequest,
  type RepositoryFileResult,
  type RepositoryOperation,
  type RepositorySearchRequest,
  type RepositorySearchResult,
} from "../../capabilities/repository.js";

/**
 * Production close bound (ms). Matches the existing
 * `ZaiMcpClient.close(timeoutMs = 2000)` semantic; the Adapter races
 * the close against a 2 second timer that resolves silently so a stuck
 * close cannot stall the attempt. Tests may inject a shorter bound via
 * {@link ZaiRepositoryCapabilityOptions.closeTimeoutMs}.
 */
export const ZAI_REPOSITORY_CLOSE_BOUND_MS = 2000;

// ---------------------------------------------------------------------------
// Public dotted MCP tool names — the Adapter invokes through these so the
// `ZaiMcpClient.callToolRaw` path resolves the discovered internal identity
// on a miss, exactly as it does for Search/Vision/Reader.
// ---------------------------------------------------------------------------

const SEARCH_TOOL_PUBLIC_NAME = getMcpToolName("zread", "search_doc");
const FILE_TOOL_PUBLIC_NAME = getMcpToolName("zread", "read_file");
const DIRECTORY_TOOL_PUBLIC_NAME = getMcpToolName("zread", "get_repo_structure");

// ---------------------------------------------------------------------------
// Encoded MCP error envelope (DESIGN.md §18, ZRead response
// characterization). The Adapter recognises the string BEFORE parsing
// any success grammar. Raw Provider body, message, and help fields are
// discarded; outward messages are sanitized.
//
// Envelope shape:
//
//     MCP error -<status>\n
//     error.code: <numeric>\n
//     error.message: <text>
//     <optional additional lines>
//
// The Adapter only consumes the documented fields; the rest is ignored.
// ---------------------------------------------------------------------------

/** Regex that captures the status of an encoded MCP error envelope. */
const ENCODED_MCP_ERROR_RE = /^MCP error -(\d+)\b/;

/**
 * Test whether `raw` looks like an encoded MCP error envelope. Returning
 * `true` forces the Adapter into the error classification path before any
 * success parser runs. The presence of a numeric status on the first
 * line is the only requirement; the body lines are still parsed lazily.
 */
function looksLikeEncodedMcpError(raw: unknown): boolean {
  return typeof raw === "string" && ENCODED_MCP_ERROR_RE.test(raw);
}

/**
 * Extract the numeric status code from an encoded MCP error envelope.
 * Returns `null` when the prefix is not present.
 */
function extractEncodedStatus(raw: string): number | null {
  const m = raw.match(ENCODED_MCP_ERROR_RE);
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

/** Extract the documented `error.code:` numeric value, if present. */
function extractEncodedCode(raw: string): number | null {
  const m = raw.match(/^error\.code:\s*(\d+)/m);
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

/** Extract the documented `error.message:` line text, if present. */
function extractEncodedMessage(raw: string): string | null {
  const m = raw.match(/^error\.message:\s*([^\n]+)/m);
  return m ? m[1] : null;
}

/**
 * Classify an encoded MCP error into a normalized error. The caller has
 * already established that the response is an encoded envelope. The
 * function NEVER embeds the raw Provider body, message, or help into
 * the outward text; it uses stable sanitized labels instead.
 *
 * Mapping (DESIGN.md §18; corrected by P6-04A):
 *   - code 1310 OR explicit exhausted/limit/quota meaning
 *                                            -> terminal QuotaError
 *                                              (REGARDLESS of the encoded
 *                                              status line; a non-429 line
 *                                              with code 1310 is still an
 *                                              exhausted-quota failure);
 *   - 401                                 -> AuthError, status 401, terminal;
 *   - 403                                 -> repository-local
 *                                              normalized ScoutlineError
 *                                              with code AUTH_ERROR and
 *                                              statusCode 403, terminal
 *                                              (avoids widening the
 *                                              global AuthError
 *                                              constructor);
 *   - 429 (without exhausted quota)       -> ApiError, status 429,
 *                                              retryable through the shared
 *                                              taxonomy;
 *   - 5xx                                 -> ApiError matching status,
 *                                              retryable;
 *   - other 4xx                           -> ApiError matching status,
 *                                              terminal;
 *   - malformed envelope (no parseable status)
 *                                            -> ApiError 502, retryable.
 *
 * Raw Provider body, `error.message`, `reset`, etc. are discarded. The
 * outward `message` and `help` are stable sanitized labels.
 */
function classifyEncodedMcpError(raw: string): Error {
  const status = extractEncodedStatus(raw);
  if (status === null) {
    // Malformed envelope: no parseable status. Retryable, sanitized.
    return new ApiError("Z.AI repository request failed", 502);
  }

  const code = extractEncodedCode(raw);
  const message = extractEncodedMessage(raw);
  const lowerMessage = (message ?? "").toLowerCase();

  // Exhausted quota: code 1310 OR explicit exhausted/quota/limit-reaching
  // meaning. This branches BEFORE the status mapping so a non-429 encoded
  // status line carrying code 1310 or an explicit exhausted message still
  // becomes terminal `QuotaError`.
  //
  // The bare word "limit" is intentionally NOT matched on its own:
  // "rate limited" is a transient retryable 429, not exhausted quota.
  // "exhausted", "quota", and the multi-word phrases "limit reached" /
  // "limit exceeded" are specific to the exhaustion context (P6-04B):
  //   - "Weekly/Monthly Limit Exhausted"  -> "exhausted"
  //   - "Quota has been exhausted"         -> "quota"
  //   - "Monthly limit reached"            -> "limit reached"
  //   - "usage limit exceeded"             -> "limit exceeded"
  // Code 1310 is the authoritative numeric signal.
  const isExhausted =
    code === 1310 ||
    lowerMessage.includes("exhausted") ||
    lowerMessage.includes("quota") ||
    lowerMessage.includes("limit reached") ||
    lowerMessage.includes("limit exceeded");
  if (isExhausted) {
    return new QuotaError(
      "Z.AI repository quota has been exhausted",
      "Check your Z.AI quota and try again later",
    );
  }

  if (status === 401) {
    return new AuthError("Z.AI authentication failed");
  }
  if (status === 403) {
    // 403 maps to AUTH_ERROR with status 403, terminal. Constructing
    // a repository-local normalized ScoutlineError (rather than
    // widening the global AuthError constructor) preserves the
    // documented exact status code without affecting legacy call
    // sites elsewhere in the codebase.
    return new ScoutlineError("Z.AI authentication failed", "AUTH_ERROR", {
      statusCode: 403,
      retryable: false,
      exitCode: 1,
    });
  }

  // 5xx and other 429 -> retryable; other 4xx -> terminal. The retry
  // classifier in `lib/execution.ts` reads `retryable` via the explicit
  // ApiError flag, but the per-status mapping here matches DESIGN.md §10
  // so the constructed errors carry the right shape regardless.
  if (status === 429) {
    return new ApiError("Z.AI repository request failed", 429);
  }
  if (status >= 500 && status <= 599) {
    return new ApiError("Z.AI repository request failed", status);
  }
  if (status >= 400 && status <= 499) {
    return new ApiError("Z.AI repository request failed", status);
  }

  // Unrecognized numeric status (e.g. 0, negative) -> retryable 502.
  return new ApiError("Z.AI repository request failed", 502);
}

// ---------------------------------------------------------------------------
// Total parsers for characterized ZRead responses (DESIGN.md §18, ZRead
// response characterization). Each parser is total over its expected
// shape: malformed responses throw a sanitized retryable ApiError 502.
//
// The parsers also accept a `request` so the normalized result can carry
// the validated request fields (`repository`, `query`, `language`, `path`).
// ---------------------------------------------------------------------------

/**
 * Parse a ZRead Search response into a normalized
 * `RepositorySearchResult`. The grammar is balanced `<excerpt>` framing
 * with at least one well-formed top-level block; arbitrary inner
 * Markdown, code, and HTML-like markup is preserved verbatim inside
 * each excerpt text.
 *
 * Malformed responses (no wrapper, unbalanced tags, non-string return)
 * throw `ApiError` with status 502 — the outward retryable envelope.
 *
 * Framing hardening (P6-04A): equal tag counts cannot admit nested,
 * reversed, or stray `<excerpt>` framing. The parser walks tokens in
 * source order with depth tracking so it can reject:
 *   - nested openings (`<excerpt>...<excerpt>...</excerpt>...</excerpt>`);
 *   - reversed/reversed openings (`</excerpt>...<excerpt>...</excerpt>`);
 *   - stray closings (`<excerpt>...</excerpt></excerpt>`).
 * Inner non-framing text between an open and its matching close is
 * preserved verbatim; Provider order is preserved.
 */
function parseZaiSearch(raw: unknown, request: RepositorySearchRequest): RepositorySearchResult {
  if (typeof raw !== "string") {
    throw new ApiError("Z.AI search returned a malformed response", 502);
  }
  if (looksLikeEncodedMcpError(raw)) {
    throw classifyEncodedMcpError(raw);
  }

  const openTag = "<excerpt>";
  const closeTag = "</excerpt>";
  const excerpts: { text: string }[] = [];
  let depth = 0;
  let pos = 0;
  let sawOpening = false;
  let originalTextLength = 0;

  while (pos < raw.length) {
    const nextOpen = raw.indexOf(openTag, pos);
    const nextClose = raw.indexOf(closeTag, pos);

    if (nextOpen === -1 && nextClose === -1) break;

    if (nextOpen !== -1 && (nextClose === -1 || nextOpen < nextClose)) {
      // Next token is an opening tag. Reject if depth != 0 (nested or
      // reversed framing).
      if (depth !== 0) {
        throw new ApiError("Z.AI search returned a malformed response", 502);
      }
      depth = 1;
      sawOpening = true;
      pos = nextOpen + openTag.length;
    } else {
      // Next token is a closing tag. Reject if depth != 1 (stray
      // closing before any open, or after a previous close).
      if (depth !== 1) {
        throw new ApiError("Z.AI search returned a malformed response", 502);
      }
      const innerText = raw.slice(pos, nextClose);
      excerpts.push({ text: innerText });
      originalTextLength += innerText.length;
      depth = 0;
      pos = nextClose + closeTag.length;
    }
  }

  if (depth !== 0 || !sawOpening) {
    throw new ApiError("Z.AI search returned a malformed response", 502);
  }

  return {
    schemaVersion: 1,
    repository: request.repository,
    query: request.query,
    language: request.language,
    excerpts,
    truncated: false,
    originalTextLength,
  };
}

/**
 * Count non-overlapping occurrences of a literal substring. Used by
 * the File and Directory parsers to enforce exactly one outer
 * Provider wrapper (P6-04B): duplicate or nested `<file_content>` /
 * `<structure>` framing is malformed, not content/entry data.
 */
function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let from = 0;
  while (true) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) return count;
    count += 1;
    from = idx + needle.length;
  }
}

/**
 * Parse a ZRead File response into a normalized `RepositoryFileResult`.
 * The grammar is a single whole-response `<file_content>...</file_content>`
 * wrapper; only characterized whitespace may appear outside the wrapper.
 * Exactly one outer opening and one outer closing wrapper tag are
 * required (P6-04B): duplicate or nested framing is malformed.
 */
function parseZaiFile(raw: unknown, request: RepositoryFileRequest): RepositoryFileResult {
  if (typeof raw !== "string") {
    throw new ApiError("Z.AI file returned a malformed response", 502);
  }
  if (looksLikeEncodedMcpError(raw)) {
    throw classifyEncodedMcpError(raw);
  }
  // Enforce exactly one outer wrapper pair (P6-04B). Duplicate or
  // nested `<file_content>` framing is malformed, not content data.
  if (
    countOccurrences(raw, "<file_content>") !== 1 ||
    countOccurrences(raw, "</file_content>") !== 1
  ) {
    throw new ApiError("Z.AI file returned a malformed response", 502);
  }
  const m = raw.match(/^\s*<file_content>([\s\S]*)<\/file_content>\s*$/);
  if (!m) {
    throw new ApiError("Z.AI file returned a malformed response", 502);
  }
  const content = m[1];
  return {
    schemaVersion: 1,
    repository: request.repository,
    path: request.path,
    content,
    truncated: false,
    originalContentLength: content.length,
  };
}

/**
 * Parse a ZRead Directory Listing response into a normalized
 * `RepositoryDirectoryListing`. The grammar is a single whole-response
 * `<structure>...</structure>` wrapper. The FIRST non-blank line inside
 * the wrapper MUST be a non-empty glyph-less root label (typically
 * `owner-repo/`). Every SUBSEQUENT non-blank line is either:
 *
 *   - a level-zero immediate entry: `├── name` or `└── name` (branch
 *     glyph at column 0, no leading whitespace); or
 *   - a well-formed nested descendant: one or more exact four-column
 *     indentation groups (`│   ` pipe+3spaces or `    ` 4 spaces),
 *     then `├── ` or `└── `, then a non-empty name.
 *
 * Only immediate entries are emitted. Valid descendants are silently
 * skipped (P6-04B). Glyph-bearing lines with arbitrary or misaligned
 * prefixes (e.g. `garbage├──`, `│  ├──` with only 2 spaces),
 * glyph-less lines, and descendants with empty names are rejected
 * (P6-04C).
 *
 * A trailing `/` on an entry marks a directory. Sibling order is
 * preserved verbatim.
 *
 * Child paths are repository-relative (P6-04A): for a listing at
 * `packages`, child `react/` yields
 * `{ name: "react", path: "packages/react", kind: "directory" }`.
 * Root listings (request.path === "") project the child name as the
 * entry path. The Adapter performs only this deterministic
 * parent/child projection — canonical safety validation and rejection
 * remain the Explorer's responsibility (P6-05).
 */
function parseZaiDirectory(
  raw: unknown,
  request: RepositoryDirectoryRequest,
): RepositoryDirectoryListing {
  if (typeof raw !== "string") {
    throw new ApiError("Z.AI directory returned a malformed response", 502);
  }
  if (looksLikeEncodedMcpError(raw)) {
    throw classifyEncodedMcpError(raw);
  }
  // Enforce exactly one outer wrapper pair (P6-04B). Duplicate or
  // nested `<structure>` framing is malformed, not entry data.
  if (countOccurrences(raw, "<structure>") !== 1 || countOccurrences(raw, "</structure>") !== 1) {
    throw new ApiError("Z.AI directory returned a malformed response", 502);
  }
  const wrapper = raw.match(/^\s*<structure>([\s\S]*)<\/structure>\s*$/);
  if (!wrapper) {
    throw new ApiError("Z.AI directory returned a malformed response", 502);
  }
  const body = wrapper[1];
  // Level-0 immediate entries: branch glyph at column 0 (no leading
  // whitespace).
  const immediateEntryRe = /^[├└]──\s(.+)$/;
  // Well-formed nested descendant: one or more exact four-column
  // indentation groups (`│   ` pipe+3spaces or `    ` 4 spaces),
  // then `├── `/`└── `, then the name (P6-04C). Misaligned prefixes
  // (`│  ├──`, `  ├──`, `garbage├──`) do not match and are rejected.
  const descendantRe = /^(?:│   |    )+[├└]──\s(.+)$/;
  const entries: RepositoryEntry[] = [];
  let sawImmediate = false;
  let isFirstNonBlank = true;
  for (const line of body.split("\n")) {
    if (!line.trim()) continue;
    if (isFirstNonBlank) {
      // The first non-blank line MUST be a glyph-less root label
      // (P6-04C). A glyph-bearing first line means the root label
      // is missing and the response is malformed.
      isFirstNonBlank = false;
      if (/[├└]──/.test(line)) {
        throw new ApiError("Z.AI directory returned a malformed response", 502);
      }
      continue;
    }
    const m = line.match(immediateEntryRe);
    if (m) {
      // Level-0 immediate entry — parse and emit.
      const name = m[1].trim();
      if (!name) {
        throw new ApiError("Z.AI directory returned a malformed response", 502);
      }
      sawImmediate = true;
      const isDir = name.endsWith("/");
      const cleanName = isDir ? name.slice(0, -1) : name;
      if (!cleanName) {
        throw new ApiError("Z.AI directory returned a malformed response", 502);
      }
      // Repository-relative child path: root listings project the
      // name unchanged; non-root listings join `request.path` and the
      // entry name with a single `/`. The Explorer later applies
      // canonical safety validation.
      const childPath = request.path === "" ? cleanName : `${request.path}/${cleanName}`;
      entries.push({ name: cleanName, path: childPath, kind: isDir ? "directory" : "file" });
      continue;
    }
    // Not a level-0 entry. Check whether the line is a well-formed
    // descendant with exact four-column indentation groups (P6-04C).
    const d = line.match(descendantRe);
    if (d) {
      // Valid descendant indentation — but a descendant with an empty
      // name is still malformed. Silently skip only if the name is
      // non-empty; otherwise reject.
      if (d[1].trim()) {
        continue;
      }
    }
    // Glyph-less, arbitrary/misaligned prefix, or empty descendant
    // name — reject.
    throw new ApiError("Z.AI directory returned a malformed response", 502);
  }
  if (!sawImmediate) {
    // A wrapper with no glyph-prefixed entries is malformed (the
    // characterization requires at least one documented immediate
    // entry). Reject uniformly rather than returning an empty list
    // so the Explorer never sees a silently empty normalized result.
    throw new ApiError("Z.AI directory returned a malformed response", 502);
  }
  return {
    repository: request.repository,
    path: request.path,
    entries,
  };
}

// ---------------------------------------------------------------------------
// Adapter-owned credential fingerprint (DESIGN.md §18). Identical
// algorithm to the Search Capability: full lowercase SHA-256 hex digest
// of the active credential; the cache key uses this verbatim.
// ---------------------------------------------------------------------------

function credentialFingerprint(apiKey: string): string {
  return crypto.createHash("sha256").update(apiKey).digest("hex");
}

// ---------------------------------------------------------------------------
// Operation factory — Search
// ---------------------------------------------------------------------------

/**
 * Internal shape passed from {@link createZaiRepositoryCapability} to
 * the three per-operation factories. Resolves the close bound once
 * before constructing the operations so every operation shares the
 * same production default (or the same injected test bound).
 */
interface ZaiRepositoryOperationOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly clientFactory: (options: ZaiMcpClientOptions) => ZaiAdapterClientPort;
  readonly closeTimeoutMs: number;
}

function createZaiSearchOperation(
  options: ZaiRepositoryOperationOptions,
): RepositoryOperation<RepositorySearchRequest, RepositorySearchResult> {
  const { env, clientFactory } = options;

  function resolveApiKey(): string {
    return requireZaiApiKey(env);
  }

  const operation: RepositoryOperation<RepositorySearchRequest, RepositorySearchResult> = {
    kind: "repository-search",
    validate(request: RepositorySearchRequest): void {
      assertRepository(request.repository);
      assertQuery(request.query);
      assertLanguage(request.language);
    },
    cacheIdentity(
      request: RepositorySearchRequest,
    ): RepositoryCacheIdentity<RepositorySearchRequest, RepositorySearchResult> {
      const apiKey = resolveApiKey();
      // Legacy argument insertion order is fixed (DESIGN.md §18):
      //   Search -> repo_name, query, language
      const legacyArgs: Record<string, unknown> = {
        repo_name: request.repository,
        query: request.query,
        language: request.language,
      };
      return {
        provider: "zai",
        capability: "repository-exploration",
        operation: "repository-search",
        credentialFingerprint: credentialFingerprint(apiKey),
        request,
        legacyCandidates: [
          {
            key: buildLegacyRepositoryCacheKey(apiKey, SEARCH_TOOL_PUBLIC_NAME, legacyArgs),
            decode: (raw: unknown) =>
              decodeLegacyZaiSearch(raw, {
                repository: request.repository,
                query: request.query,
                language: request.language,
              }),
          },
        ],
      };
    },
    decodeCached(value: unknown): RepositorySearchResult | null {
      // Total normalized cache decoder: delegate to the shared P6-02
      // `decodeRepositorySearch` (DESIGN.md §18). Shared decoder
      // rejects fractional `originalTextLength` values, missing
      // required scalars, malformed `excerpts`, and unknown
      // `language` values. Any malformed shape is a cache miss.
      return decodeRepositorySearch(value);
    },
    async invoke(request: RepositorySearchRequest): Promise<RepositorySearchResult> {
      // Validate before any transport access (DESIGN.md §18 / §2).
      operation.validate(request);
      const args: Record<string, unknown> = {
        repo_name: request.repository,
        query: request.query,
        language: request.language,
      };
      return invokeRepositoryOperation(
        clientFactory,
        SEARCH_TOOL_PUBLIC_NAME,
        args,
        (raw) => parseZaiSearch(raw, request),
        options.closeTimeoutMs,
      );
    },
  };
  return operation;
}

// ---------------------------------------------------------------------------
// Operation factory — File
// ---------------------------------------------------------------------------

function createZaiReadFileOperation(
  options: ZaiRepositoryOperationOptions,
): RepositoryOperation<RepositoryFileRequest, RepositoryFileResult> {
  const { env, clientFactory } = options;

  function resolveApiKey(): string {
    return requireZaiApiKey(env);
  }

  const operation: RepositoryOperation<RepositoryFileRequest, RepositoryFileResult> = {
    kind: "repository-read-file",
    validate(request: RepositoryFileRequest): void {
      assertRepository(request.repository);
      assertNonRootPath(request.path, "File");
    },
    cacheIdentity(
      request: RepositoryFileRequest,
    ): RepositoryCacheIdentity<RepositoryFileRequest, RepositoryFileResult> {
      const apiKey = resolveApiKey();
      // File uses a fixed insertion order (DESIGN.md §18):
      //   File -> repo_name, file_path
      const legacyArgs: Record<string, unknown> = {
        repo_name: request.repository,
        file_path: request.path,
      };
      return {
        provider: "zai",
        capability: "repository-exploration",
        operation: "repository-read-file",
        credentialFingerprint: credentialFingerprint(apiKey),
        request,
        legacyCandidates: [
          {
            key: buildLegacyRepositoryCacheKey(apiKey, FILE_TOOL_PUBLIC_NAME, legacyArgs),
            decode: (raw: unknown) =>
              decodeLegacyZaiFile(raw, {
                repository: request.repository,
                path: request.path,
              }),
          },
        ],
      };
    },
    decodeCached(value: unknown): RepositoryFileResult | null {
      // Total normalized cache decoder: delegate to the shared P6-02
      // `decodeRepositoryFile`. Shared decoder rejects fractional
      // `originalContentLength`, non-string `content`, empty `path`,
      // and primitives/arrays at the top level.
      return decodeRepositoryFile(value);
    },
    async invoke(request: RepositoryFileRequest): Promise<RepositoryFileResult> {
      operation.validate(request);
      const args: Record<string, unknown> = {
        repo_name: request.repository,
        file_path: request.path,
      };
      return invokeRepositoryOperation(
        clientFactory,
        FILE_TOOL_PUBLIC_NAME,
        args,
        (raw) => parseZaiFile(raw, request),
        options.closeTimeoutMs,
      );
    },
  };
  return operation;
}

// ---------------------------------------------------------------------------
// Operation factory — Directory
// ---------------------------------------------------------------------------

function createZaiListDirectoryOperation(
  options: ZaiRepositoryOperationOptions,
): RepositoryOperation<RepositoryDirectoryRequest, RepositoryDirectoryListing> {
  const { env, clientFactory } = options;

  function resolveApiKey(): string {
    return requireZaiApiKey(env);
  }

  const operation: RepositoryOperation<RepositoryDirectoryRequest, RepositoryDirectoryListing> = {
    kind: "repository-list-directory",
    validate(request: RepositoryDirectoryRequest): void {
      assertRepository(request.repository);
      assertDirectoryPath(request.path);
      // Directory allows `path: ""` (root) AND non-root paths. The
      // Adapter performs only the deterministic parent/child
      // projection; canonical child-path safety validation belongs to
      // the Explorer layer (P6-05).
    },
    cacheIdentity(
      request: RepositoryDirectoryRequest,
    ): RepositoryCacheIdentity<RepositoryDirectoryRequest, RepositoryDirectoryListing> {
      const apiKey = resolveApiKey();
      // Directory argument insertion order is fixed (DESIGN.md §18):
      //   root     -> repo_name only
      //   non-root -> repo_name, dir_path
      const legacyArgs: Record<string, unknown> = { repo_name: request.repository };
      if (request.path !== "") {
        legacyArgs.dir_path = request.path;
      }
      return {
        provider: "zai",
        capability: "repository-exploration",
        operation: "repository-list-directory",
        credentialFingerprint: credentialFingerprint(apiKey),
        request,
        legacyCandidates: [
          {
            key: buildLegacyRepositoryCacheKey(apiKey, DIRECTORY_TOOL_PUBLIC_NAME, legacyArgs),
            decode: (raw: unknown) =>
              decodeLegacyZaiDirectory(raw, {
                repository: request.repository,
                path: request.path,
              }),
          },
        ],
      };
    },
    decodeCached(value: unknown): RepositoryDirectoryListing | null {
      // Total normalized cache decoder: delegate to the shared P6-02
      // `decodeRepositoryDirectoryListing`. Shared decoder rejects
      // malformed entries (empty name/path, unknown kind) and
      // primitives/arrays at the top level.
      return decodeRepositoryDirectoryListing(value);
    },
    async invoke(request: RepositoryDirectoryRequest): Promise<RepositoryDirectoryListing> {
      operation.validate(request);
      const args: Record<string, unknown> = { repo_name: request.repository };
      if (request.path !== "") {
        args.dir_path = request.path;
      }
      return invokeRepositoryOperation(
        clientFactory,
        DIRECTORY_TOOL_PUBLIC_NAME,
        args,
        (raw) => parseZaiDirectory(raw, request),
        options.closeTimeoutMs,
      );
    },
  };
  return operation;
}

// ---------------------------------------------------------------------------
// Legacy decoder — total over `unknown`, returns normalized Result or
// `null`. Each legacy decoder runs the raw Provider string through the
// same production parser so the read-through path validates the same
// grammar the cache decoder does. `JSON.stringify(raw)` is used only
// when `raw` is already an object (the normalized shape); raw string
// values are passed through unchanged.
// ---------------------------------------------------------------------------

function decodeLegacyZaiSearch(
  raw: unknown,
  request: RepositorySearchRequest,
): RepositorySearchResult | null {
  try {
    return parseZaiSearch(raw, request);
  } catch {
    return null;
  }
}

function decodeLegacyZaiFile(
  raw: unknown,
  request: RepositoryFileRequest,
): RepositoryFileResult | null {
  try {
    return parseZaiFile(raw, request);
  } catch {
    return null;
  }
}

function decodeLegacyZaiDirectory(
  raw: unknown,
  request: RepositoryDirectoryRequest,
): RepositoryDirectoryListing | null {
  try {
    return parseZaiDirectory(raw, request);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Validation helpers
//
// Request validation throws `ValidationError` (P6-04A) for invalid
// repository, query, language, File path, and Directory path types —
// distinct from parser/envelope failures, which remain retryable
// `ApiError` 502. `ValidationError` is terminal at the request layer
// (the retry classifier treats `VALIDATION_ERROR` as non-retryable)
// and never reaches a transport.
// ---------------------------------------------------------------------------

function assertRepository(repository: unknown): asserts repository is string {
  if (typeof repository !== "string" || !containsSlash(repository)) {
    throw new ValidationError("Z.AI repository must be a string of the form 'owner/name'");
  }
}

function containsSlash(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) === 47 /* "/" */) return true;
  }
  return false;
}

function assertQuery(query: unknown): asserts query is string {
  if (typeof query !== "string" || query.trim().length === 0) {
    throw new ValidationError(
      "Z.AI search query must contain at least one non-whitespace character",
    );
  }
}

function assertLanguage(language: unknown): asserts language is "en" | "zh" {
  if (language !== "en" && language !== "zh") {
    throw new ValidationError("Z.AI search language must be 'en' or 'zh'");
  }
}

function assertNonRootPath(path: unknown, label: string): void {
  if (typeof path !== "string" || path.length === 0) {
    throw new ValidationError(`Z.AI ${label} path must be a non-empty string`);
  }
}

function assertDirectoryPath(path: unknown): void {
  // Directory allows both `path: ""` (root) and a non-root repository-
  // relative POSIX path. The Adapter only validates the type here;
  // canonical child-path safety validation belongs to the Explorer.
  if (typeof path !== "string") {
    throw new ValidationError("Z.AI directory path must be a string");
  }
}

// ---------------------------------------------------------------------------
// Per-invocation transport lifecycle (DESIGN.md §18 "Transport close
// semantics"). Each uncached attempt constructs a fresh client and
// closes it exactly once in `finally`. Close rejection or timeout
// never replaces success and never masks the primary operation failure.
//
// The Adapter NEVER retries internally — shared execution owns retry
// policy. A retry constructs a fresh Adapter attempt and therefore a
// fresh client.
// ---------------------------------------------------------------------------

async function invokeRepositoryOperation<Request, Result>(
  clientFactory: (options: ZaiMcpClientOptions) => ZaiAdapterClientPort,
  publicToolName: string,
  args: Record<string, unknown>,
  parse: (raw: unknown) => Result,
  closeTimeoutMs: number,
): Promise<Result> {
  const clientOptions: ZaiMcpClientOptions = {
    enableVision: false,
    noCache: true,
    disableRetry: true,
  };
  const client = clientFactory(clientOptions);
  // The success and primary-failure paths must survive a close
  // rejection or timeout. We capture both outcomes separately so a
  // failing close cannot replace a successful result and cannot mask a
  // primary Provider failure.
  let primaryError: unknown;
  let result: Result | undefined;
  try {
    try {
      // Invoke through the public dotted tool name so the underlying
      // client resolves the discovered internal identity (P6-01A fix
      // path). No retry is performed inside this Adapter attempt;
      // shared execution owns the retry policy.
      result = parse(await client.callToolRaw<unknown>(publicToolName, args));
    } catch (error) {
      // Wrap any thrown MCP error into the normalized Adapter error.
      primaryError = normalizeMcpInvokeError(error);
      throw primaryError;
    }
    return result;
  } finally {
    // Best-effort close. Matches the existing `ZaiMcpClient.close`
    // semantic: race the close against a timeout that resolves
    // silently so a stuck close cannot stall the Adapter attempt.
    // Close rejection is also silently swallowed.
    await closeWithBound(client, closeTimeoutMs);
  }
}

/**
 * Close the client with a bounded timeout that matches the existing
 * `ZaiMcpClient.close(timeoutMs = 2000)` semantic. The timeout
 * resolves silently (not rejects) so the close never throws and the
 * Adapter attempt never stalls on a stuck close. Any close rejection
 * is also silently swallowed.
 */
async function closeWithBound(client: ZaiAdapterClientPort, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<void>((resolve) => {
    timer = setTimeout(() => resolve(), timeoutMs);
    if (timer && typeof timer === "object" && "unref" in timer) {
      (timer as { unref: () => void }).unref();
    }
  });
  try {
    await Promise.race([client.close().catch(() => undefined), timeoutPromise]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Normalize a Provider failure surfaced through `callToolRaw`. The
 * underlying client already normalizes typed transport errors
 * (`AuthError`, `NetworkError`, `TimeoutError`, `ApiError`,
 * `QuotaError`); this function preserves ANY normalized
 * `ScoutlineError` so the shared retry classifier sees the original
 * `code` and `statusCode`. This base-class check also covers the
 * repository-local `ScoutlineError` constructed for an encoded 403
 * (which intentionally does not widen the global `AuthError`
 * constructor). Untyped throwables surface as sanitized retryable
 * `ApiError` 502 — the Adapter never embeds a raw Provider string
 * into the public envelope.
 */
function normalizeMcpInvokeError(error: unknown): Error {
  if (error instanceof ScoutlineError) {
    return error;
  }
  // Defensive: never let a raw Provider string reach the public
  // envelope. An untyped throwable is a sanitized 502-equivalent.
  return new ApiError("Z.AI repository request failed", 502);
}

// ---------------------------------------------------------------------------
// Capability factory — wired into `createZaiDescriptor().create()` so the
// implementation is production-reachable through the adapter object even
// though the descriptor's `capabilities()` set does NOT yet advertise
// `repository-exploration`. The Explorer layer (P6-05+) is the first
// external consumer.
// ---------------------------------------------------------------------------

/**
 * Options accepted by {@link createZaiRepositoryCapability}.
 *
 * `closeTimeoutMs` defaults to {@link ZAI_REPOSITORY_CLOSE_BOUND_MS}
 * (2000 ms) — the existing `ZaiMcpClient.close(timeoutMs = 2000)`
 * semantic. Tests may inject a shorter bound to bound a never-
 * resolving `close()` without waiting for the production default.
 */
export interface ZaiRepositoryCapabilityOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly clientFactory: (options: ZaiMcpClientOptions) => ZaiAdapterClientPort;
  readonly closeTimeoutMs?: number;
}

/**
 * Build the Z.AI Repository Capability. The capability is composed of
 * three typed `RepositoryOperation` descriptors; the Adapter owns
 * credentials, transport lifecycle, raw request/response mapping, and
 * error normalization. No transport, credential resolution, or I/O
 * happens during construction.
 */
export function createZaiRepositoryCapability(
  options: ZaiRepositoryCapabilityOptions,
): RepositoryCapability {
  const closeTimeoutMs = options.closeTimeoutMs ?? ZAI_REPOSITORY_CLOSE_BOUND_MS;
  const sharedOptions = {
    env: options.env,
    clientFactory: options.clientFactory,
    closeTimeoutMs,
  };
  return {
    search: createZaiSearchOperation(sharedOptions),
    readFile: createZaiReadFileOperation(sharedOptions),
    listDirectory: createZaiListDirectoryOperation(sharedOptions),
  };
}
