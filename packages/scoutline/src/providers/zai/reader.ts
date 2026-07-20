/**
 * Z.AI Reader Adapter (DESIGN.md §18; reader-migration-tech-plan D4;
 * PRD FR-??? — reader migration Ticket 03).
 *
 * Owns the Provider-facing half of the provider-neutral Reader
 * Capability defined in `src/capabilities/reader.ts`:
 *
 *   - URL rewrite (gist.github.com/<user>/<id> -> /raw) applied BEFORE
 *     invocation; the rewritten URL surfaces as `finalUrl` in the
 *     result. The rewrite is Z.AI-specific because Z.AI's WebReader
 *     MCP recognizes the rewritten URL.
 *   - a total parser for the characterized Z.AI WebReader response
 *     (`ReaderRawResponse`: object on success, bare string for MCP-
 *     level error envelopes);
 *   - encoded MCP error classification BEFORE success parsing
 *     (`quota` is terminal `QUOTA_ERROR`; the rest of the taxonomy
 *     uses the shared retry/terminal classification); the parsing
 *     helpers live in `./encoded-error.ts` and are shared with
 *     `./repository.ts`;
 *   - a single resolved-credential fingerprint per cache identity and
 *     exact per-operation legacy cache candidate using Ticket 01's
 *     `buildLegacyReaderCacheKey` helper;
 *   - `decodeCached` delegates to Ticket 01's total decoder
 *     (`decodeReaderFetchResult`);
 *   - a fresh transport per invocation attempt and exactly one
 *     best-effort close in `finally`; close failure never replaces
 *     success nor masks the primary failure;
 *   - no leakage of raw WebReader response types outside this module.
 *
 * Boundary rules (ARCHITECTURE.md §2):
 *   - May import capability types, normalized errors, the Z.AI MCP
 *     tool-name helpers, the legacy cache-key helper, the shared
 *     `ZaiAdapterClientPort` typed client port, and the shared
 *     encoded-error helpers.
 *   - Must NOT import another Provider's Adapter, command
 *     presentation, or extract/maxChars projection logic.
 *
 * Scope:
 *   - implements the single `reader-fetch` operation only. URL scheme
 *     validation, `--extract`, `--max-chars`, and `--full-envelope`
 *     belong to the command layer (Ticket 04 cuts the handler over).
 *   - descriptor metadata sequencing: Ticket 03 introduces this Adapter
 *     handle and wires it through `ProviderAdapter.reader` WITHOUT
 *     advertising `reader` on `createZaiDescriptor.capabilities()`;
 *     Ticket 04 then flips the descriptor to advertise `reader` so
 *     Provider selection and Doctor inventory derive from a single
 *     source of truth, AND cuts `commands/read.ts` over to dispatch
 *     through `adapter.reader.fetch`. This module owns no registry,
 *     selection, or command cutover.
 */

import crypto from "node:crypto";

import type { ZaiAdapterClientPort, ZaiMcpClientOptions } from "../types.js";
import { ApiError, ScoutlineError, ValidationError } from "../../lib/errors.js";
import { getMcpToolName } from "../../lib/mcp-config.js";
import { buildLegacyReaderCacheKey } from "../../lib/cache.js";
import { requireZaiApiKey } from "./credentials.js";
import { classifyEncodedMcpError, looksLikeEncodedMcpError } from "./encoded-error.js";
import {
  decodeReaderFetchResult,
  type ReaderCacheIdentity,
  type ReaderCapability,
  type ReaderFetchRequest,
  type ReaderFetchResult,
  type ReaderOperation,
} from "../../capabilities/reader.js";

/**
 * Production close bound (ms). Matches the existing
 * `ZaiMcpClient.close(timeoutMs = 2000)` semantic; the Adapter races
 * the close against a 2 second timer that resolves silently so a stuck
 * close cannot stall the attempt. Tests may inject a shorter bound via
 * {@link ZaiReaderCapabilityOptions.closeTimeoutMs}.
 */
export const ZAI_READER_CLOSE_BOUND_MS = 2000;

// ---------------------------------------------------------------------------
// Public dotted MCP tool name — the Adapter invokes through this so the
// `ZaiMcpClient.callToolRaw` path resolves the discovered internal
// identity on a miss, exactly as it does for Search/Vision/ZRead.
// ---------------------------------------------------------------------------

const READER_TOOL_PUBLIC_NAME = getMcpToolName("reader", "webReader");

// ---------------------------------------------------------------------------
// Operation label passed to the shared encoded-error classifier. The
// label surfaces in the sanitized outward ApiError / QuotaError message
// ("Z.AI reader request failed", "Z.AI reader quota has been exhausted").
// Auth messages (401, 403) do not carry the label.
// ---------------------------------------------------------------------------

const ENCODED_ERROR_LABEL = "reader";

// ---------------------------------------------------------------------------
// URL rewrite (gist -> /raw). Duplicated from `commands/read.ts`
// `maybeRewriteToRaw` because the legacy read command still owns its own
// copy until Ticket 04 cuts the handler over. Once Ticket 04 lands, the
// command copy is removed; this is the single Adapter source of truth.
//
// The rewrite is Z.AI-specific because Z.AI's WebReader MCP is the thing
// that recognizes the rewritten URL. A future Provider's reader Adapter
// decides its own rewriting (or none).
//
// Behaviour matches the v0.2 command:
//   - Already raw (matching `/raw`, optionally followed by `/`, `?`, or
//     `#`)? Leave alone.
//   - Only rewrite `gist.github.com/<user>/<id>` (NOT
//     `github.com/<owner>/<repo>`).
//   - Preserve the fragment (file anchor still meaningful); drop the
//     query path segment before appending `/raw`.
// ---------------------------------------------------------------------------

/**
 * Rewrite rendered GitHub gist/file URLs to their raw form so Z.AI's
 * reader returns pure file content instead of the rendered HTML page
 * chrome.
 *
 *   gist.github.com/<user>/<id>          -> gist.github.com/<user>/<id>/raw
 *   gist.github.com/<user>/<id>#file-... -> gist.github.com/<user>/<id>/raw#file-...
 *
 * Leaves alone: URLs that already end in /raw, /raw/<rev>, or have a
 * query string. Non-gist URLs pass through unchanged.
 */
function maybeRewriteToRaw(url: string): string {
  // Already raw? Leave alone.
  if (/\/raw(\/|$|\?|#)/.test(url)) return url;
  // Only rewrite gist.github.com (not github.com/owner/repo — that's different)
  const m = url.match(/^(https?:\/\/gist\.github\.com\/[^/]+\/[^/#?]+)(?:[/?#]|$)/);
  if (!m) return url;
  const base = m[1];
  // Append /raw, preserve any fragment (file anchor still meaningful)
  const frag = url.indexOf("#") >= 0 ? url.slice(url.indexOf("#")) : "";
  return `${base}/raw${frag}`;
}

// ---------------------------------------------------------------------------
// Total parser for the characterized WebReader response (DESIGN.md §18,
// reader-webreader-characterization artifact). The parser is total over
// the `ReaderRawResponse` union:
//
//   - Object shape (the common success case): extract `title`, `url`,
//     `content`, optional `metadata`, optional `external`. The
//     `description` field is dropped (the v1 envelope does not surface
//     it). Blank / missing titles coerce to `null`. Missing `content`
//     or non-string `content` is malformed (retryable 502).
//   - String shape (MCP-level error envelope): if the string matches
//     the encoded MCP error pattern (`MCP error -<status>...`), route
//     through `classifyEncodedMcpError`. Any other bare string is a
//     degenerate shape the Adapter rejects as malformed (retryable 502)
//     — the characterization shows bare strings occur only for MCP-
//     level error envelopes, so any other string is unexpected.
//
// The parser accepts the operation's resolved `finalUrl` (the rewritten
// URL) and the original `request.url` so the v1 envelope carries both
// fields per the contract: `url` is exactly what the caller passed;
// `finalUrl` is the URL the operation actually fetched.
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse a WebReader response into a normalized `ReaderFetchResult`.
 *
 * @param raw    The raw WebReader response (object | string).
 * @param request The caller's request (used for `url`, `format`).
 * @param finalUrl The rewritten URL the Adapter actually fetched.
 */
function parseZaiReader(
  raw: unknown,
  request: ReaderFetchRequest,
  finalUrl: string,
): ReaderFetchResult {
  // Bare string → encoded MCP error path or malformed.
  if (typeof raw === "string") {
    if (looksLikeEncodedMcpError(raw)) {
      throw classifyEncodedMcpError(raw, ENCODED_ERROR_LABEL);
    }
    // The characterization shows bare strings occur only for MCP-level
    // error envelopes. Any other string is a degenerate shape.
    throw new ApiError("Z.AI reader returned a malformed response", 502);
  }

  if (!isPlainObject(raw)) {
    throw new ApiError("Z.AI reader returned a malformed response", 502);
  }

  // Title: string (blank coerced to null), missing → null, non-string → malformed.
  let title: string | null;
  const rawTitle = raw.title;
  if (rawTitle === undefined || rawTitle === null) {
    title = null;
  } else if (typeof rawTitle === "string") {
    title = rawTitle.trim().length > 0 ? rawTitle : null;
  } else {
    throw new ApiError("Z.AI reader returned a malformed response", 502);
  }

  // Content: must be a non-empty string.
  const content = raw.content;
  if (typeof content !== "string" || content.length === 0) {
    throw new ApiError("Z.AI reader returned a malformed response", 502);
  }

  // The Capability contract requires contentFormat to be exactly
  // "markdown" or "text". The Adapter resolves this from the request,
  // NOT from the response: the Provider does not echo the requested
  // format, so the Adapter is authoritative for which format was
  // requested. Defaults to "markdown" per the v0.2 command default.
  const contentFormat: "markdown" | "text" = request.format ?? "markdown";

  // Build the envelope. Optional metadata/external preserved verbatim
  // when present, omitted when absent so the round-trip equals the
  // input shape. Built in one shot so `readonly` invariants on
  // `ReaderFetchResult` are honored.
  const hasMetadata = raw.metadata !== undefined;
  const hasExternal = raw.external !== undefined;
  const envelope: ReaderFetchResult = {
    schemaVersion: 1,
    url: request.url,
    finalUrl,
    title,
    content,
    contentFormat,
    ...(hasMetadata ? { metadata: raw.metadata } : {}),
    ...(hasExternal ? { external: raw.external } : {}),
  };
  return envelope;
}

// ---------------------------------------------------------------------------
// Adapter-owned credential fingerprint (DESIGN.md §18). Identical
// algorithm to the Repository Capability: full lowercase SHA-256 hex
// digest of the active credential; the cache key uses this verbatim.
// ---------------------------------------------------------------------------

function credentialFingerprint(apiKey: string): string {
  return crypto.createHash("sha256").update(apiKey).digest("hex");
}

// ---------------------------------------------------------------------------
// Validation helpers
//
// Request validation throws `ValidationError` for invalid URL types or
// URL schemes — distinct from parser/envelope failures, which remain
// retryable `ApiError` 502. `ValidationError` is terminal at the
// request layer (the retry classifier treats `VALIDATION_ERROR` as non-
// retryable) and never reaches a transport.
// ---------------------------------------------------------------------------

/**
 * Validate the request URL. Only `http://` and `https://` schemes are
 * accepted; everything else is a terminal `ValidationError` (mirrors
 * the v0.2 command-level parse check). The Adapter runs this BEFORE
 * credential resolution and transport construction so an invalid URL
 * never reaches the network.
 *
 * Note: the v0.2 command's parse-level URL-scheme check is preserved
 * by Ticket 04's handler cutover; the Adapter repeats it as defence
 * in depth (the contract on `ReaderFetchRequest.url` requires http(s)
 * but the Adapter cannot trust callers to honour it).
 */
function assertHttpUrl(url: unknown): asserts url is string {
  if (typeof url !== "string" || url.length === 0) {
    throw new ValidationError("Z.AI reader URL must be a non-empty string");
  }
  if (!/^https?:\/\//.test(url)) {
    throw new ValidationError("URL must start with http:// or https://");
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
//
// The lifecycle helpers are structurally identical to the Repository
// Adapter's `invokeRepositoryOperation` / `closeWithBound` /
// `normalizeMcpInvokeError`. They are duplicated rather than shared
// because factoring them would widen this ticket's scope (modifying
// repository.ts further). Future consolidation is a separate refactor.
// ---------------------------------------------------------------------------

async function invokeReaderFetch<Result>(
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
      // path, mirrored by Ticket 02 for the Reader tool). No retry is
      // performed inside this Adapter attempt; shared execution owns
      // the retry policy.
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
 * reader-local `ScoutlineError` constructed for an encoded 403 (which
 * intentionally does not widen the global `AuthError` constructor).
 * Untyped throwables surface as sanitized retryable `ApiError` 502 —
 * the Adapter never embeds a raw Provider string into the public
 * envelope.
 */
function normalizeMcpInvokeError(error: unknown): Error {
  if (error instanceof ScoutlineError) {
    return error;
  }
  // Defensive: never let a raw Provider string reach the public
  // envelope. An untyped throwable is a sanitized 502-equivalent.
  return new ApiError("Z.AI reader request failed", 502);
}

// ---------------------------------------------------------------------------
// Legacy decoder — total over `unknown`, returns normalized Result or
// `null`. The legacy decoder runs the raw Provider string through the
// same production parser so the read-through path validates the same
// grammar the cache decoder does. `JSON.stringify(raw)` is NOT used;
// raw object values are passed through unchanged, raw strings are
// routed through the parser (which rejects anything that is not an
// object success or a recognized encoded MCP error envelope).
// ---------------------------------------------------------------------------

function decodeLegacyZaiReader(
  raw: unknown,
  request: ReaderFetchRequest,
  finalUrl: string,
): ReaderFetchResult | null {
  try {
    return parseZaiReader(raw, request, finalUrl);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Operation factory — Fetch
// ---------------------------------------------------------------------------

/**
 * Internal shape passed from {@link createZaiReaderCapability} to the
 * per-operation factory. Resolves the close bound once before
 * constructing the operation so the operation shares the production
 * default (or the same injected test bound).
 */
interface ZaiReaderOperationOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly clientFactory: (options: ZaiMcpClientOptions) => ZaiAdapterClientPort;
  readonly closeTimeoutMs: number;
}

function createZaiReaderFetchOperation(
  options: ZaiReaderOperationOptions,
): ReaderOperation<ReaderFetchRequest, ReaderFetchResult> {
  const { env, clientFactory } = options;

  function resolveApiKey(): string {
    return requireZaiApiKey(env);
  }

  const operation: ReaderOperation<ReaderFetchRequest, ReaderFetchResult> = {
    kind: "reader-fetch",
    validate(request: ReaderFetchRequest): void {
      assertHttpUrl(request.url);
    },
    cacheIdentity(
      request: ReaderFetchRequest,
    ): ReaderCacheIdentity<ReaderFetchRequest, ReaderFetchResult> {
      const apiKey = resolveApiKey();
      // Canonical request: URL is REWRITTEN so two requests that
      // normalize to the same fetched URL share the same cache entry
      // (e.g. `gist.github.com/<id>` and `gist.github.com/<id>/raw`
      // both fetch the same Provider content).
      const finalUrl = maybeRewriteToRaw(request.url);
      const canonicalRequest: ReaderFetchRequest = { ...request, url: finalUrl };

      // Legacy v0.2 argument insertion order is fixed (DESIGN.md §18 /
      // reader-webreader-characterization artifact):
      //   1. url                        (always)
      //   2. timeout                    (optional, only if request.timeout !== undefined)
      //   3. no_cache                   (NEVER set by the Adapter — the Capability surface has no noCache field)
      //   4. return_format              (optional, only if request.format is truthy)
      //   5. retain_images              (optional)
      //   6. with_links_summary         (optional)
      //   7. no_gfm                     (optional)
      //   8. keep_img_data_url          (optional)
      //   9. with_images_summary        (optional)
      //
      // The legacy args.url is the REWRITTEN url, matching what the
      // v0.2 path sent to WebReader. The Adapter never sends
      // `no_cache` (the Capability surface has no noCache field), so
      // legacy args never include it — this means the new Adapter
      // matches the common-case v0.2 cache entries (those written
      // without --no-cache). The v0.2 --no-cache entries were
      // intentionally uncached and remain unreconstructible, which is
      // correct behavior.
      const legacyArgs: Record<string, unknown> = { url: finalUrl };
      if (request.timeout !== undefined) {
        legacyArgs.timeout = request.timeout;
      }
      if (request.format) {
        legacyArgs.return_format = request.format;
      }
      if (request.retainImages !== undefined) {
        legacyArgs.retain_images = request.retainImages;
      }
      if (request.withLinksSummary !== undefined) {
        legacyArgs.with_links_summary = request.withLinksSummary;
      }
      if (request.noGfm !== undefined) {
        legacyArgs.no_gfm = request.noGfm;
      }
      if (request.keepImgDataUrl !== undefined) {
        legacyArgs.keep_img_data_url = request.keepImgDataUrl;
      }
      if (request.withImagesSummary !== undefined) {
        legacyArgs.with_images_summary = request.withImagesSummary;
      }

      return {
        provider: "zai",
        capability: "reader",
        operation: "reader-fetch",
        credentialFingerprint: credentialFingerprint(apiKey),
        request: canonicalRequest,
        legacyCandidates: [
          {
            key: buildLegacyReaderCacheKey(apiKey, READER_TOOL_PUBLIC_NAME, legacyArgs),
            decode: (raw: unknown) => decodeLegacyZaiReader(raw, canonicalRequest, finalUrl),
          },
        ],
      };
    },
    decodeCached(value: unknown): ReaderFetchResult | null {
      // Total normalized cache decoder: delegate to the shared Ticket 01
      // `decodeReaderFetchResult`. Shared decoder rejects missing
      // required fields (`url`, `finalUrl`, `content`), unknown
      // `contentFormat`, and primitives/arrays at the top level. Any
      // malformed shape is a cache miss.
      return decodeReaderFetchResult(value);
    },
    async invoke(request: ReaderFetchRequest): Promise<ReaderFetchResult> {
      // Validate before any transport access (DESIGN.md §18 / §2).
      operation.validate(request);
      const finalUrl = maybeRewriteToRaw(request.url);
      // Build args in the documented v0.2 insertion order minus
      // `no_cache` (the Capability surface has no noCache field).
      const args: Record<string, unknown> = { url: finalUrl };
      if (request.timeout !== undefined) {
        args.timeout = request.timeout;
      }
      if (request.format) {
        args.return_format = request.format;
      }
      if (request.retainImages !== undefined) {
        args.retain_images = request.retainImages;
      }
      if (request.withLinksSummary !== undefined) {
        args.with_links_summary = request.withLinksSummary;
      }
      if (request.noGfm !== undefined) {
        args.no_gfm = request.noGfm;
      }
      if (request.keepImgDataUrl !== undefined) {
        args.keep_img_data_url = request.keepImgDataUrl;
      }
      if (request.withImagesSummary !== undefined) {
        args.with_images_summary = request.withImagesSummary;
      }
      return invokeReaderFetch(
        clientFactory,
        READER_TOOL_PUBLIC_NAME,
        args,
        (raw) => parseZaiReader(raw, request, finalUrl),
        options.closeTimeoutMs,
      );
    },
  };
  return operation;
}

// ---------------------------------------------------------------------------
// Capability factory — wired into `createZaiDescriptor().create()` so the
// implementation is production-reachable through the adapter object.
// Historical sequencing: Ticket 03 introduces the Adapter handle and the
// `ProviderAdapter.reader` slot WITHOUT advertising `reader` on the
// descriptor; Ticket 04 then flips `createZaiDescriptor.capabilities()`
// to advertise `reader` so Provider selection and Doctor inventory
// derive from a single source of truth, AND cuts `commands/read.ts`
// over to dispatch through `adapter.reader.fetch`. This module owns no
// registry, selection, or command cutover.
// ---------------------------------------------------------------------------

/**
 * Options accepted by {@link createZaiReaderCapability}.
 *
 * `closeTimeoutMs` defaults to {@link ZAI_READER_CLOSE_BOUND_MS}
 * (2000 ms) — the existing `ZaiMcpClient.close(timeoutMs = 2000)`
 * semantic. Tests may inject a shorter bound to bound a never-
 * resolving `close()` without waiting for the production default.
 */
export interface ZaiReaderCapabilityOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly clientFactory: (options: ZaiMcpClientOptions) => ZaiAdapterClientPort;
  readonly closeTimeoutMs?: number;
}

/**
 * Build the Z.AI Reader Capability. The capability is composed of a
 * single typed `ReaderOperation` descriptor (`fetch`); the Adapter
 * owns credentials, transport lifecycle, raw request/response mapping,
 * URL rewrite, and error normalization. No transport, credential
 * resolution, or I/O happens during construction.
 */
export function createZaiReaderCapability(options: ZaiReaderCapabilityOptions): ReaderCapability {
  const closeTimeoutMs = options.closeTimeoutMs ?? ZAI_READER_CLOSE_BOUND_MS;
  return {
    fetch: createZaiReaderFetchOperation({
      env: options.env,
      clientFactory: options.clientFactory,
      closeTimeoutMs,
    }),
  };
}
