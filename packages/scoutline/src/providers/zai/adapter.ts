/**
 * Z.AI Search Adapter (DESIGN.md §5, §7, §11 — P2-03).
 *
 * Implements the real Z.AI Provider Descriptor with Search support.
 * The Adapter owns credentials, transport lifecycle, Provider field
 * mapping, and failure normalization. Shared execution owns cache and
 * retry policy, so Adapter invocations disable client-owned cache and
 * retries (`noCache: true, disableRetry: true`).
 *
 * Boundary rules (ARCHITECTURE.md §2):
 *   - May import capability types, normalized errors, Provider-specific
 *     transport (ZaiMcpClient), and Provider identity types.
 *   - Must NOT import command presentation, output mode, or another
 *     Provider's Adapter.
 *
 * Field mapping (DESIGN.md §7):
 *   title        -> title
 *   link         -> url
 *   content      -> summary
 *   media        -> source
 *   publish_date -> date
 *
 * The Adapter sends only `search_query`, domain, recency, content size,
 * and location to the Provider. It NEVER sends count.
 */

import crypto from "node:crypto";
import { promises as fsPromises } from "node:fs";
import { readFile } from "node:fs/promises";

import type {
  ProviderAdapter,
  ProviderCapability,
  ProviderContext,
  ProviderDescriptor,
  ProviderQuotaFetch,
  ProviderLayoutParsingFetch,
  ZaiAdapterClientPort,
  ZaiAdapterDependencies,
  ZaiMcpClientOptions,
  WebSearchResult,
} from "../types.js";
import type {
  LegacySearchCacheCandidate,
  SearchCapability,
  SearchCacheIdentity,
  SearchRequest,
  SearchSource,
} from "../../capabilities/search.js";
import type {
  VisionCapability,
  VisionOperation,
  VisionRequest,
} from "../../capabilities/vision.js";
import type { DiagnosticsCapability, DiagnosticOptions } from "../../capabilities/diagnostics.js";
import {
  ApiError,
  AuthError,
  NetworkError,
  TimeoutError,
  UnsupportedOptionError,
  ValidationError,
} from "../../lib/errors.js";
import { getMcpToolName } from "../../lib/mcp-config.js";
import {
  ZaiMcpClient,
} from "../../lib/mcp-client.js";
import { buildLegacyRepositoryCacheKey, buildProviderCacheKey, readCacheInDir, writeCacheInDir, responseCacheDir } from "../../lib/cache.js";
import { resolveTimeoutMs } from "./monitor-client.js";
import { readBoundedResponseBody } from "../../lib/bounded-body.js";
import { ZAI_OCR_MAX_IMAGE_BYTES, ZAI_OCR_MAX_PDF_BYTES } from "./media.js";
import { applySearchTopic } from "../../lib/search-topic.js";
import { isZaiConfigured, requireZaiApiKey } from "./credentials.js";
import {
  resolveImageSource,
  resolveVideoSource,
  resolveOcrSource,
  isOcrSourceFallbackEligible,
  fetchImageSource,
  fetchVideoSource,
} from "./media.js";
import { createZaiQuotaCapability, type ZaiQuotaCapabilityOptions } from "./quota.js";
import { createZaiRepositoryCapability } from "./repository.js";
import { createZaiReaderCapability } from "./reader.js";
import type { ZaiMonitorFetch } from "./monitor-client.js";
import { parseLayout } from "./layout-parsing.js";
import { QuotaError } from "../../lib/errors.js";
import {
  defaultAmountForCapability,
  emitConsumption,
  type ConsumptionSink,
} from "../../lib/consumption.js";

const SEARCH_TOOL_PUBLIC_NAME = getMcpToolName("search", "web_search_prime");
const VISION_ANALYZE_TOOL_PUBLIC_NAME = getMcpToolName("vision", "analyze_image");

// ---------------------------------------------------------------------------
// Vision Capability — operations wired in this Adapter (P3-03, P3-04)
// ---------------------------------------------------------------------------

/**
 * Public dotted MCP tool names for every Z.AI Vision operation. Each
 * resolves internally through the P2-03 name-translation fix. The Adapter
 * invokes only the raw tool path; it does NOT call the high-level
 * `ZaiMcpClient` wrapper methods.
 */
const VISION_UI_TO_ARTIFACT_TOOL_PUBLIC_NAME = getMcpToolName("vision", "ui_to_artifact");
const VISION_EXTRACT_TEXT_TOOL_PUBLIC_NAME = getMcpToolName(
  "vision",
  "extract_text_from_screenshot",
);
const VISION_DIAGNOSE_ERROR_TOOL_PUBLIC_NAME = getMcpToolName(
  "vision",
  "diagnose_error_screenshot",
);
const VISION_DIAGRAM_TOOL_PUBLIC_NAME = getMcpToolName("vision", "understand_technical_diagram");
const VISION_CHART_TOOL_PUBLIC_NAME = getMcpToolName("vision", "analyze_data_visualization");
const VISION_DIFF_TOOL_PUBLIC_NAME = getMcpToolName("vision", "ui_diff_check");
const VISION_VIDEO_TOOL_PUBLIC_NAME = getMcpToolName("vision", "analyze_video");

/**
 * Vision operations the Z.AI Adapter implements. P3-03 wired the general
 * single-image interpretation; P3-04 adds every specialized operation so
 * selecting Z.AI preserves Phase 1 behaviour (DESIGN.md §8: "Z.AI maps
 * all current operations to dedicated MCP operations"). The descriptor
 * advertises exactly what this set contains.
 */
const ZAI_VISION_OPERATIONS: ReadonlySet<VisionOperation> = new Set([
  "interpret-image",
  "ui-artifact",
  "extract-text",
  "diagnose-error",
  "diagram",
  "chart",
  "diff",
  "video",
]);

// ---------------------------------------------------------------------------
// Provider-owned legacy cache candidate
// ---------------------------------------------------------------------------

/**
 * Build the legacy Z.AI cache key for a request. The shape mirrors the
 * pre-P2-05 `buildCacheKey` calls the search command made through
 * `ZaiMcpClient.webSearch`. `legacyCount` reconstructs the old `count`
 * argument so an existing on-disk entry can still be served.
 *
 * P6-08A: the already-resolved `apiKey` is consumed through the same
 * pure explicit-key algorithm `buildLegacyRepositoryCacheKey` exposes
 * for the Repository Capability. The two algorithms are byte-identical
 * for the same `(apiKey, command, args)`:
 *
 *   credentialPart = sha256(apiKey).hex.slice(0, 12)
 *   argumentPart   = sha256(JSON.stringify({ command, args })).hex.slice(0, 24)
 *   key            = `${command}.${credentialPart}.${argumentPart}.json`
 *
 * Switching to the pure helper removes the ambient `getApiKey()` read
 * that the legacy `buildCacheKey` performed. An Adapter created with
 * `{ env: { Z_AI_API_KEY: "injected-only" } }` no longer throws
 * `CONFIGURATION_ERROR` from `search.cacheIdentity()` when ambient
 * credentials are absent. The output bytes for a given credential
 * are unchanged.
 */
function buildLegacyZaiSearchKey(
  apiKey: string,
  request: SearchRequest,
  legacyCount: number | undefined,
): string {
  const args: Record<string, unknown> = { search_query: request.query };
  if (legacyCount !== undefined) {
    args.count = legacyCount;
  }
  if (request.controls?.domain) {
    args.search_domain_filter = request.controls.domain;
  }
  if (request.controls?.recency) {
    args.search_recency_filter = request.controls.recency;
  }
  if (request.controls?.contentSize) {
    args.content_size = request.controls.contentSize;
  }
  if (request.controls?.location) {
    args.location = request.controls.location;
  }
  return buildLegacyRepositoryCacheKey(apiKey, SEARCH_TOOL_PUBLIC_NAME, args);
}

/**
 * Decode a raw legacy Z.AI search entry into normalized `SearchSource[]`.
 * Returns `null` for any shape that is not a `WebSearchResult[]` so the
 * cache layer treats invalid legacy data as a miss.
 */
function decodeLegacyZaiSearch(raw: unknown): readonly SearchSource[] | null {
  if (!Array.isArray(raw)) return null;
  const out: SearchSource[] = [];
  for (const entry of raw as unknown[]) {
    if (!entry || typeof entry !== "object") return null;
    const record = entry as Record<string, unknown>;
    const title = typeof record.title === "string" ? record.title : "";
    const link = typeof record.link === "string" ? record.link : "";
    const content = typeof record.content === "string" ? record.content : "";
    if (!title || !link || !content) {
      // Invalid legacy entry — treat the whole candidate as a miss.
      return null;
    }
    const source: SearchSource = { title, url: link, summary: content };
    if (typeof record.media === "string" && record.media.length > 0) {
      source.source = record.media;
    }
    if (typeof record.publish_date === "string" && record.publish_date.length > 0) {
      source.date = record.publish_date;
    }
    out.push(source);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Provider-owned credential fingerprint
// ---------------------------------------------------------------------------

function credentialFingerprint(apiKey: string): string {
  return crypto.createHash("sha256").update(apiKey).digest("hex");
}

// ---------------------------------------------------------------------------
// Search Capability
// ---------------------------------------------------------------------------

interface ZaiSearchCapabilityOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly clientFactory: NonNullable<ZaiAdapterDependencies["clientFactory"]>;
}

function createZaiSearchCapability(options: ZaiSearchCapabilityOptions): SearchCapability {
  const { env, clientFactory } = options;

  // Credential resolution is shared (Fixup A — B4/B7): the alias
  // `ZAI_API_KEY` is accepted and a missing key is a configuration
  // failure (ConfigurationError, exit 3), not an auth failure.
  function resolveApiKey(): string {
    return requireZaiApiKey(env);
  }

  const capability: SearchCapability = {
    validate(request: SearchRequest): void {
      if (!request || typeof request.query !== "string" || !request.query.trim()) {
        throw new ValidationError(
          "Search query must contain at least one non-whitespace character",
        );
      }
      // Z.AI accepts every other control natively, but `type` (video
      // content axis) is not supported by this adapter (Brave supplies
      // video), so it is rejected here.
      if (request.controls?.type !== undefined) {
        throw new UnsupportedOptionError("zai", "search", "type");
      }
    },

    cacheIdentity(
      request: SearchRequest,
      compatibility?: { readonly legacyCount?: number },
    ): SearchCacheIdentity {
      const apiKey = resolveApiKey();
      const legacyCandidates: LegacySearchCacheCandidate[] = [
        {
          key: buildLegacyZaiSearchKey(apiKey, request, compatibility?.legacyCount),
          decode: decodeLegacyZaiSearch,
        },
      ];
      // Mirror only `query` and Provider controls into identity. Count is
      // never part of identity (it enters only the legacy key above).
      const identityRequest: { query: string; controls?: SearchRequest["controls"] } = {
        query: request.query,
      };
      if (request.controls) {
        identityRequest.controls = request.controls;
      }
      return {
        provider: "zai",
        capability: "search",
        credentialFingerprint: credentialFingerprint(apiKey),
        request: identityRequest,
        legacyCandidates,
      };
    },

    async invoke(request: SearchRequest): Promise<readonly SearchSource[]> {
      // Validate before any transport access.
      capability.validate(request);

      // Disable client-owned cache and retry so shared execution is the
      // single policy owner.
      const clientOptions: ZaiMcpClientOptions = {
        enableVision: false,
        noCache: true,
        disableRetry: true,
      };
      const client = clientFactory(clientOptions);
      try {
        // T03: map a non-general topic to a query keyword appendage.
        // The topic never reaches the Z.AI API as a separate parameter;
        // it is purely a query enhancement owned by this Adapter.
        const effectiveQuery = applySearchTopic(request.query, request.controls?.topic);
        const args = buildZaiSearchArgs({ ...request, query: effectiveQuery });
        const raw = await invokeZaiSearch(client, args);
        return normalizeZaiSearchResults(raw);
      } finally {
        await client.close().catch(() => {});
      }
    },
  };

  return capability;
}

/**
 * Build the Z.AI Provider request arguments. The Adapter sends only
 * `search_query`, domain, recency, content size, and location. Count is
 * NEVER included — it remains command-local.
 */
function buildZaiSearchArgs(request: SearchRequest): Record<string, unknown> {
  const args: Record<string, unknown> = { search_query: request.query };
  const controls = request.controls;
  if (controls?.domain) {
    args.search_domain_filter = controls.domain;
  }
  if (controls?.recency) {
    args.search_recency_filter = controls.recency;
  }
  if (controls?.contentSize) {
    args.content_size = controls.contentSize;
  }
  if (controls?.location) {
    args.location = controls.location;
  }
  return args;
}

async function invokeZaiSearch(
  client: ZaiAdapterClientPort,
  args: Record<string, unknown>,
): Promise<readonly WebSearchResult[]> {
  try {
    const result = await client.callToolRaw<readonly WebSearchResult[]>(
      SEARCH_TOOL_PUBLIC_NAME,
      args,
    );
    if (!Array.isArray(result)) {
      throw new ApiError("Z.AI search returned a non-array result", 500);
    }
    return result;
  } catch (error) {
    throw normalizeZaiError(error);
  }
}

/**
 * Map a Provider failure into a normalized error. Numeric codes, raw
 * response bodies, and UTCP stack data are discarded (NFR-006).
 *
 * Typed transport errors thrown by the lower-level client (AuthError,
 * ApiError, NetworkError, TimeoutError) are re-wrapped with sanitized
 * messages so a raw Provider response body embedded upstream never
 * survives to public output. The `statusCode` is preserved so the
 * shared execution layer can classify retryability (DESIGN.md §10).
 * Our own `ValidationError` (from Capability `validate()`) carries a
 * clean, human-authored message and is returned verbatim.
 */
function normalizeZaiError(error: unknown): Error {
  // Validation messages are authored by Scoutline and are safe to surface.
  if (error instanceof ValidationError) {
    return error;
  }
  // Re-wrap typed transport errors with clean messages. The raw message
  // is discarded; only code + statusCode (retry signal) survive.
  if (error instanceof AuthError) {
    return new AuthError("Z.AI authentication failed");
  }
  if (error instanceof NetworkError) {
    return new NetworkError("Z.AI network error");
  }
  if (error instanceof TimeoutError) {
    // Fixup D: preserve the original error's duration instead of
    // reconstructing it from an ambient process.env that may differ from
    // the injected env. The rewrapped error carries the same duration.
    return new TimeoutError(error.durationMs);
  }
  if (error instanceof ApiError) {
    const statusCode = inferStatusCode("", error.statusCode);
    return new ApiError("Z.AI request failed", statusCode);
  }
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (
    lower.includes("401") ||
    lower.includes("403") ||
    lower.includes("unauthorized") ||
    lower.includes("forbidden")
  ) {
    return new AuthError("Z.AI authentication failed");
  }
  if (lower.includes("timeout") || lower.includes("timed out") || lower.includes("etimedout")) {
    return new TimeoutError(resolveTimeoutMs(process.env));
  }
  if (
    lower.includes("econnrefused") ||
    lower.includes("econnreset") ||
    lower.includes("network") ||
    lower.includes("enotfound") ||
    lower.includes("fetch failed")
  ) {
    return new NetworkError("Z.AI network error");
  }
  // Default: API_ERROR with no stack or raw body.
  return new ApiError("Z.AI search request failed", inferStatusCode(lower));
}

/**
 * Resolve a stable HTTP-style status code for retry classification.
 * Explicit client errors (404, 400, 410, 422) map to their real codes
 * so the execution layer treats them as terminal (DESIGN.md §10).
 * Transient failures (429 and any 5xx 500..599 inclusive) map to a
 * representative status in that range so the shared execution retry
 * classifier (DESIGN.md §18 / FR-090) treats them as retryable. An
 * unknown failure defaults to 500 (transient), preserving shipped
 * behaviour for genuine "unexpected system" conditions.
 *
 * When the caller already carries a numeric status (a typed ApiError),
 * that status is honoured directly so retryability is never lost.
 */
function inferStatusCode(lower: string, known?: number): number {
  if (typeof known === "number" && Number.isFinite(known)) return known;
  if (lower.includes("404") || lower.includes("not found")) return 404;
  if (lower.includes("400") || lower.includes("bad request")) return 400;
  if (lower.includes("410") || lower.includes("gone")) return 410;
  if (lower.includes("422") || lower.includes("unprocessable")) return 422;
  if (lower.includes("429") || lower.includes("rate limit")) return 429;
  if (lower.includes("500") || lower.includes("internal")) return 500;
  if (lower.includes("502") || lower.includes("bad gateway")) return 502;
  if (lower.includes("503") || lower.includes("service unavailable")) return 503;
  if (lower.includes("504") || lower.includes("gateway timeout")) return 504;
  return 500;
}

/**
 * Map Provider response fields to normalized `SearchSource[]`. Unknown
 * fields are discarded.
 */
function normalizeZaiSearchResults(raw: readonly WebSearchResult[]): readonly SearchSource[] {
  const out: SearchSource[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const title = typeof entry.title === "string" ? entry.title : "";
    const link = typeof entry.link === "string" ? entry.link : "";
    const content = typeof entry.content === "string" ? entry.content : "";
    const source: SearchSource = { title, url: link, summary: content };
    if (typeof entry.media === "string" && entry.media.length > 0) {
      source.source = entry.media;
    }
    if (typeof entry.publish_date === "string" && entry.publish_date.length > 0) {
      source.date = entry.publish_date;
    }
    out.push(source);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Vision Capability (DESIGN.md §8, §9 — P3-03)
// ---------------------------------------------------------------------------

interface ZaiVisionCapabilityOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly clientFactory: NonNullable<ZaiAdapterDependencies["clientFactory"]>;
  /** GLM-OCR layout-parsing seam (glm-ocr lane T2, ADR-0014 D2/D5). */
  readonly layoutParsingFetch?: ProviderLayoutParsingFetch;
  /** Notice channel (D5): default silent; index.ts wires stderr. */
  readonly notice?: (line: string) => void;
  /**
   * Cache-dir env override for the OCR cache (T3 tests isolate
   * SCOUTLINE_CACHE_DIR per suite; production resolves ambient).
   */
  readonly layoutParsingCacheEnv?: NodeJS.ProcessEnv;
  /**
   * Usage-ledger seam for the glm-ocr arm (T4, ADR-0014 D7): attempts
   * are counted at the ADAPTER level because the OCR cache is
   * adapter-internal — a warm hit never reaches the executor, and an
   * 1113+fallback run is TWO attempts inside ONE executor invoke.
   * index.ts threads the shared sink here for extract-text and
   * suppresses its own emission on that path (one row per attempt,
   * zero on a cache hit).
   */
  readonly layoutParsingConsume?: ConsumptionSink;
  readonly layoutParsingConsumeNow?: () => number;
}

/** The pinned fallback notice text (PRD AC-2, owner-approved). */
const GLM_OCR_FALLBACK_NOTICE =
  "glm-ocr unavailable (no PAYG balance); falling back to vision model";
const GLM_OCR_LANGUAGE_STRIP_NOTICE = "--language not supported by glm-ocr; ignored";
const GLM_OCR_PROMPT_STRIP_NOTICE = "custom prompt not supported by glm-ocr; ignored";

/** The default extract-text prompt (commands/vision.ts keeps the copy). */
const DEFAULT_EXTRACT_TEXT_PROMPT = "Extract all text from this image.";

/** Hermetic no-op timer pair for the layout-parsing client. */
const LAYOUT_PARSING_TIMERS = { setTimeout, clearTimeout };

/**
 * Read a local OCR source to base64 (one read pass — the cache-key
 * computation in T3 shares the same bytes).
 */
async function readOcrSourceAsBase64(resolvedPath: string): Promise<string> {
  const bytes = await readFile(resolvedPath);
  return bytes.toString("base64");
}

/**
 * Prefetch a URL source to base64 for the layout-parsing retry (D3 —
 * the recorded MCP URL-unreliability pattern applied to the REST arm).
 * Returns the data-URI form the REST `file` value accepts.
 */
async function prefetchOcrUrlAsDataUri(
  url: string,
  fetchImpl: ProviderLayoutParsingFetch | undefined,
): Promise<string> {
  // Same duck-typed double shape other Z.AI transports use: the
  // injected seam type REQUIRES a body stream (wave-3: refusal is
  // seam policy, the type states it); the ambient global fetch
  // satisfies it structurally.
  const f = (fetchImpl ??
    (globalThis.fetch as unknown as ProviderLayoutParsingFetch)) as ProviderLayoutParsingFetch;
  let res: Awaited<ReturnType<typeof f>>;
  try {
    res = await f(url, { method: "GET" });
  } catch {
    // Failed prefetch is terminal 422 (AC-3): no engine fallback for a
    // non-1113 failure, no retry loop around the retry.
    throw new ApiError("Z.AI layout-parsing URL prefetch failed", 422);
  }
  if (!res.ok) {
    throw new ApiError("Z.AI layout-parsing URL prefetch failed", 422);
  }
  // Incremental Stream Bounding: cap the download at the OCR media
  // rules' own ceilings (images ≤10MB, everything else — i.e. PDF —
  // ≤50MB) via the shared incremental reader (declared content-length
  // is untrusted — chunked servers omit/understate it; the counter
  // cancels the connection the moment the cap is crossed). A response
  // without a body stream is refused outright: an arrayBuffer() read
  // materializes before any check, which is exactly the unbounded
  // class this path exists to kill, so no materialization path exists
  // in any branch. Production fetch always supplies a body; injected
  // doubles must too (wave-2 ruling).
  if (!res.body) {
    throw new NetworkError("Z.AI layout-parsing URL prefetch response provides no bounded-readable body");
  }
  const isPdf = (res.headers?.get?.("content-type") ?? "").includes("pdf");
  const maxBytes = isPdf ? ZAI_OCR_MAX_PDF_BYTES : ZAI_OCR_MAX_IMAGE_BYTES;
  const buffer = await readBoundedResponseBody(res.body, maxBytes, "URL prefetch size");
  const mime = res.headers?.get?.("content-type")?.split(";")[0] || "application/octet-stream";
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

/**
 * The glm-ocr arm of extract-text (ADR-0014 D1/D2/D3/D6): resolve the
 * source through the WIDER OCR media rules (images ≤10MB, PDF ≤50MB),
 * warn-and-strip `--language` and a custom prompt, then POST
 * layout_parsing. A 1113 (insufficient PAYG balance) rejection throws
 * `QuotaError` — the caller's exhaustion seam. A URL-source REST
 * failure retries ONCE via prefetch-to-base64; a failed prefetch is
 * terminal 422.
 */
async function invokeZaiExtractTextOcrArm(
  request: ExtractTextRequest,
  apiKey: string,
  notice: (line: string) => void,
  layoutParsingFetch: ProviderLayoutParsingFetch | undefined,
  cacheEnv: NodeJS.ProcessEnv | undefined,
  ocrLedger: (attempt: number) => Promise<void>,
  adapterEnv: NodeJS.ProcessEnv,
): Promise<string> {
  const resolved = resolveOcrSource(request.source);
  const isUrl = /^https?:\/\//i.test(resolved);
  const fileValue = isUrl ? resolved : await readOcrSourceAsBase64(resolved);

  // Cache probe (D4) BEFORE any notice, transport, or ledger row: a
  // warm hit records NOTHING (AC-7). The key covers only
  // {model, file-identity} — strip-notice state never enters it.
  const key = ocrCacheKey(apiKey, ocrFileIdentity(resolved, isUrl ? undefined : fileValue));
  const cached = await readOcrCache(key, cacheEnv, adapterEnv);
  if (cached !== null) {
    return cached;
  }

  if (request.programmingLanguage) {
    notice(GLM_OCR_LANGUAGE_STRIP_NOTICE);
  }
  if (request.instruction !== DEFAULT_EXTRACT_TEXT_PROMPT) {
    notice(GLM_OCR_PROMPT_STRIP_NOTICE);
  }

  const deps = layoutParsingFetch !== undefined ? { fetch: layoutParsingFetch } : {};
  await ocrLedger(1);
  try {
    const result = await parseLayout({ apiKey, file: fileValue }, LAYOUT_PARSING_TIMERS, deps);
    await writeOcrCache(key, result, cacheEnv, adapterEnv);
    return result;
  } catch (error) {
    // One prefetch-to-base64 retry on a URL source whose REST attempt
    // failed with a fallback-eligible error (server-side URL fetching
    // shares the MCP's recorded unreliability). Exhaustion (1113),
    // auth, and local-file sources never retry — they are not
    // source-related.
    if (isUrl && isFallbackEligibleError(error)) {
      // m1 (review): the catch guards the PREFETCH step only — a
      // failed retried parseLayout propagates its own taxonomy error
      // (AC-2). Only EXPECTED transport failures (ApiError) remap to
      // terminal 422. An oversize ValidationError pierces (media-rule
      // source property, #266 AC) and an unexpected reader bug keeps
      // its own identity — neither is masked as 422.
      const dataUri = await prefetchOcrUrlAsDataUri(resolved, layoutParsingFetch).catch((err) => {
        if (err instanceof ApiError) {
          throw new ApiError("Z.AI layout-parsing URL prefetch failed", 422);
        }
        throw err;
      });
      await ocrLedger(2);
      const retried = await parseLayout({ apiKey, file: dataUri }, LAYOUT_PARSING_TIMERS, deps);
      await writeOcrCache(key, retried, cacheEnv, adapterEnv);
      return retried;
    }
    throw error;
  }
}

/** Narrowed request shape for the extract-text operation. */
interface ExtractTextRequest {
  operation: "extract-text";
  source: string;
  instruction: string;
  programmingLanguage?: string;
}

// ---------------------------------------------------------------------------
// GLM-OCR cache (ADR-0014 D4 — glm-ocr lane T3)
// ---------------------------------------------------------------------------

/** Cache capability segment of the key namespace. */
const GLM_OCR_CACHE_CAPABILITY = "vision-ocr-layout-parsing";

/**
 * File identity for the OCR cache key (D4): the canonical URL string
 * for URL sources, or `sha256:<hex>` of the local file CONTENT — same
 * bytes at different paths share one entry (path never enters the
 * key). The content hash rides the SAME read pass that produces the
 * base64 upload value (one `readFile` per invocation).
 */
function ocrFileIdentity(resolvedSource: string, contentBase64: string | undefined): string {
  if (/^https?:\/\//i.test(resolvedSource)) return resolvedSource;
  // contentBase64 is the file bytes in base64; hashing the decoded
  // bytes equals hashing the file content.
  const bytes = Buffer.from(contentBase64 ?? "", "base64");
  return `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}

/**
 * Build the OCR cache key through the shared provider-key grammar:
 * `v2.vision-ocr-layout-parsing.zai.<credential-hash>.<request-hash>.json`
 * where `<request-hash>` covers `{model, file-identity}` — the model is
 * constant, so the file identity is the only varying input.
 */
function ocrCacheKey(apiKey: string, fileIdentity: string): string {
  return buildProviderCacheKey({
    provider: "zai",
    capability: GLM_OCR_CACHE_CAPABILITY,
    credentialFingerprint: credentialFingerprint(apiKey),
    request: { model: "glm-ocr", file: fileIdentity },
  });
}

/**
 * Resolve the OCR cache dir. M2/R1 (review): the env-var leg and the
 * `--isolated` flag leg BOTH resolve through the adapter's OWN
 * injected env (the descriptor's `create({env})` value — main()
 * merges SCOUTLINE_ISOLATED into it), never a reread of ambient
 * process.env. `SCOUTLINE_ISOLATED` reroutes to
 * `cache/isolated/<pid>` (ADR-0006 §5: isolated runs never mutate the
 * shared dir).
 */
function ocrCacheDir(
  cacheEnv: NodeJS.ProcessEnv | undefined,
  adapterEnv: NodeJS.ProcessEnv,
): string {
  return responseCacheDir((cacheEnv ?? adapterEnv) as never);
}

/** Read the OCR cache; a miss/mismatch/poison returns null (fresh run). */
async function readOcrCache(
  key: string,
  cacheEnv: NodeJS.ProcessEnv | undefined,
  adapterEnv: NodeJS.ProcessEnv,
): Promise<string | null> {
  return readCacheInDir(
    ocrCacheDir(cacheEnv, adapterEnv),
    key,
    (raw): string | null => (typeof raw === "string" && raw.length > 0 ? raw : null),
  );
}

/** Write the OCR cache (best-effort; the shared module never throws). */
async function writeOcrCache(
  key: string,
  value: string,
  cacheEnv: NodeJS.ProcessEnv | undefined,
  adapterEnv: NodeJS.ProcessEnv,
): Promise<void> {
  await writeCacheInDir(ocrCacheDir(cacheEnv, adapterEnv), key, value);
}

/**
 * Build the Z.AI Vision Capability. Maps `interpret-image` to the
 * `vision.analyze_image` MCP operation through the same raw-tool path as
 * Search. The validated image source maps to `image_source`; the
 * instruction maps to `prompt`. Only a nonempty text result is normalized;
 * Provider envelopes and error bodies stay inside the Adapter.
 *
 * Vision never uses the response cache (FR-022) and never retries inside
 * the Adapter transport; shared execution owns the retry policy.
 */
function createZaiVisionCapability(options: ZaiVisionCapabilityOptions): VisionCapability {
  const { env, clientFactory } = options;
  const notice = options.notice ?? (() => {});
  // D7 adapter-owned ledger for the extract-text OCR arm (+ its
  // fallback attempt). No-op when the seam is unwired (tests that
  // don't care; the executor emission then stays active because the
  // descriptor is not seam-marked).
  const ocrLedger = async (attempt: number): Promise<void> => {
    if (options.layoutParsingConsume === undefined) return;
    await emitConsumption(
      options.layoutParsingConsume,
      {
        provider: "zai",
        capabilityId: "vision.extract-text",
        category: "vision",
        unit: "tokens",
        amount: defaultAmountForCapability("vision"),
      },
      attempt,
      options.layoutParsingConsumeNow ?? Date.now,
    );
  };

  // Shared credential resolver (Fixup A — B4/B7).
  function resolveApiKey(): string {
    return requireZaiApiKey(env);
  }

  const capability: VisionCapability = {
    supports(operation: VisionOperation): boolean {
      return ZAI_VISION_OPERATIONS.has(operation);
    },

    async invoke(request: VisionRequest): Promise<string> {
      // Credential resolved for the transport; media resolved inside
      // `buildZaiVisionInvocation` to the validated Z.AI source (absolute
      // path or HTTP(S) URL) — the media module never reads file content.
      // Unsupported operations never reach here: the descriptor-level
      // gate and `supports()` reject first (defence in depth).
      resolveApiKey();

      // glm-ocr lane (ADR-0014 D1): extract-text routes to the
      // layout-parsing REST arm FIRST; on 1113 (no PAYG balance) it
      // falls back — with one pinned stderr notice — to the pre-lane
      // MCP path below with the SAME instruction semantics. Every
      // other operation dispatches through the MCP path unchanged.
      if (request.operation === "extract-text") {
        try {
          return await invokeZaiExtractTextOcrArm(
            request,
            resolveApiKey(),
            notice,
            options.layoutParsingFetch,
            options.layoutParsingCacheEnv,
            ocrLedger,
            env,
          );
        } catch (error) {
          if (error instanceof QuotaError) {
            // G2 (PR #265): inputs the legacy vision MCP arm cannot
            // accept (PDFs; images over its 5 MiB ceiling) fail
            // TERMINAL here — naming both engines and the remedy —
            // instead of dispatching an incompatible source to a late
            // validation error.
            if (!isOcrSourceFallbackEligible(request.source)) {
              throw new ApiError(
                "Z.AI extract-text input is only supported by glm-ocr " +
                  "(PDF or oversized image), and glm-ocr is unavailable " +
                  "(no PAYG balance). A PAYG balance is required for this input.",
                422,
              );
            }
            notice(GLM_OCR_FALLBACK_NOTICE);
            // D7: the fallback attempt is its own ledger row (an
            // 1113 + fallback run = 2 rows). Emitted here because the
            // executor emission is suppressed on this seam-marked
            // path (the adapter owns extract-text rows).
            await ocrLedger(2);
            // Fall through to the pre-lane MCP path (no rethrow).
          } else {
            throw error;
          }
        }
      }

      const tempPaths: string[] = [];
      try {
        // First attempt: HTTP(S) URLs pass straight through to the
        // Provider's server-side fetcher.
        const first = buildZaiVisionInvocation(request, resolveImageSource, resolveVideoSource);
        try {
          return normalizeZaiVisionResult(
            await invokeZaiVisionOnce(clientFactory, first.toolName, first.args),
          );
        } catch (error) {
          // Automatic URL -> local fallback (Issue E): Z.AI's vision MCP
          // refuses base64 data URIs and its server-side URL fetcher is
          // unreliable — it rejects some image URLs with code 1210,
          // returns empty, or hangs. The MCP surfaces these inconsistently
          // (a 1210 reaches the Adapter as a sanitized ApiError 500 with
          // the original detail discarded, so it cannot be detected by
          // status code or message). Retry by fetching each URL source
          // here to a temp file (validated against the same Z.AI media
          // limits) and passing that path.
          //
          // The fallback fires for ANY transport/processing failure on a
          // URL source except auth/quota (those are not source-related and
          // a local fetch cannot remedy them). Auth (401/403) and
          // exhausted-quota failures therefore propagate untouched.
          if (isUrlVisionSource(request) && isFallbackEligibleError(error)) {
            try {
              const fetched = await prefetchVisionUrlSources(request);
              for (const local of fetched.values()) tempPaths.push(local);
              const resolveImage = makePrefetchResolver(fetched, resolveImageSource);
              const resolveVideo = makePrefetchResolver(fetched, resolveVideoSource);
              const fallback = buildZaiVisionInvocation(request, resolveImage, resolveVideo);
              return normalizeZaiVisionResult(
                await invokeZaiVisionOnce(clientFactory, fallback.toolName, fallback.args),
              );
            } catch (fallbackError) {
              // The local fetch or the retried attempt failed. Surface a
              // TERMINAL error (422, not in the shared retry policy's
              // retryable set) so the policy does not re-run the whole
              // URL attempt and multiply latency without benefit. The
              // message names both the original Provider failure and the
              // fallback failure so the user knows the fallback was
              // attempted and why it could not recover.
              throw new ApiError(
                `Z.AI vision request failed for the URL source and the local-fetch fallback also failed: ${
                  fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
                }`,
                422,
              );
            }
          }
          throw error;
        }
      } finally {
        await cleanupTempPaths(tempPaths);
      }
    },
  };

  return capability;
}

/**
 * Perform one vision transport attempt. A fresh client is constructed per
 * attempt (the Adapter never retries internally; shared execution owns the
 * retry policy) and closed exactly once in `finally`. Close failure never
 * replaces a successful result nor masks the primary failure.
 */
async function invokeZaiVisionOnce(
  clientFactory: NonNullable<ZaiAdapterDependencies["clientFactory"]>,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const clientOptions: ZaiMcpClientOptions = {
    enableVision: true,
    noCache: true,
    disableRetry: true,
  };
  const client = clientFactory(clientOptions);
  try {
    return await invokeZaiVision(client, toolName, args);
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * Whether a `VisionRequest` carries at least one HTTP(S) source. The
 * URL->local fallback only applies when a Provider-attempted URL is the
 * likely cause of a client error; local-file sources already resolved
 * before transport and are not re-attempted with a fetch.
 */
function isUrlVisionSource(request: VisionRequest): boolean {
  return visionSourceUrls(request).length > 0;
}

/**
 * Collect the HTTP(S) source strings carried by a `VisionRequest`.
 * `diff` carries two image sources; `video` carries one video source;
 * every other operation carries one image source.
 */
function visionSourceUrls(request: VisionRequest): string[] {
  const out: string[] = [];
  const pushIfUrl = (s: string | undefined): void => {
    if (typeof s === "string" && (s.startsWith("http://") || s.startsWith("https://"))) {
      out.push(s);
    }
  };
  switch (request.operation) {
    case "diff":
      pushIfUrl(request.expectedSource);
      pushIfUrl(request.actualSource);
      break;
    case "video":
      pushIfUrl(request.source);
      break;
    default:
      pushIfUrl(request.source);
  }
  return out;
}

/**
 * Whether a normalized vision error is eligible for the URL -> local
 * fallback. The fallback fires for any transport or processing failure
 * that a local fetch could plausibly remedy: client errors (400/422, e.g.
 * a 1210 image-format rejection), server errors (5xx), timeouts, and
 * network errors. Auth failures (401/403) and exhausted-quota failures are
 * NOT eligible — a local fetch cannot fix a missing credential or a spent
 * quota, so those propagate to the user unchanged.
 *
 * Note: the vision MCP surfaces a code 1210 image-format rejection as a
 * sanitized `ApiError` 500 with the original detail discarded, so this
 * check is deliberately type-and-status-based rather than message-based.
 */
function isFallbackEligibleError(error: unknown): boolean {
  if (error instanceof ApiError) {
    return error.statusCode !== 401 && error.statusCode !== 403;
  }
  return error instanceof TimeoutError || error instanceof NetworkError;
}

/**
 * Prefetch each HTTP(S) source URL on the request to a validated temp
 * file path, returning a Map from the original URL to its local path.
 * Video sources use the video media limits; every other source uses the
 * image limits. A fetch failure throws the normalized media error and
 * aborts the fallback (the original client error is then surfaced).
 */
async function prefetchVisionUrlSources(request: VisionRequest): Promise<Map<string, string>> {
  const isVideo = request.operation === "video";
  const fetched = new Map<string, string>();
  for (const url of visionSourceUrls(request)) {
    const local = isVideo ? await fetchVideoSource(url) : await fetchImageSource(url);
    fetched.set(url, local);
  }
  return fetched;
}

/**
 * Build a sync media resolver for the fallback attempt. A source present
 * in the prefetched `urlToPath` map is substituted with its local temp
 * path; every other source falls through to the normal passthrough
 * resolver (`resolveImageSource`/`resolveVideoSource`).
 */
function makePrefetchResolver(
  urlToPath: Map<string, string>,
  passthrough: (source: string) => string,
): (source: string) => string {
  return (source: string) => urlToPath.get(source) ?? passthrough(source);
}

/**
 * Unlink every prefetched temp file. Each unlink is best-effort: a
 * missing file or permission failure never replaces a successful result
 * nor masks a primary failure.
 */
async function cleanupTempPaths(tempPaths: string[]): Promise<void> {
  for (const p of tempPaths) {
    try {
      await fsPromises.unlink(p);
    } catch {
      // Best-effort cleanup; ignore.
    }
  }
}

/**
 * Map a discriminated `VisionRequest` to its dedicated Z.AI MCP tool name
 * and arguments, resolving media through the supplied resolvers. Field
 * names mirror the characterized transport schema (see `mcp-client.ts`
 * and the live discovery fixtures). Optional fields are omitted when
 * absent so the Provider receives the same request shape Phase 1 sent.
 *
 * The image/video resolvers are injected so the first attempt can pass
 * HTTP(S) URLs straight through (`resolveImageSource`) while a fallback
 * attempt can substitute a fetched temp-file path (`fetchImageSource`).
 */
function buildZaiVisionInvocation(
  request: VisionRequest,
  resolveImage: (source: string) => string,
  resolveVideo: (source: string) => string,
): {
  toolName: string;
  args: Record<string, unknown>;
} {
  switch (request.operation) {
    case "interpret-image":
      return {
        toolName: VISION_ANALYZE_TOOL_PUBLIC_NAME,
        args: {
          image_source: resolveImage(request.source),
          prompt: request.instruction,
        },
      };
    case "ui-artifact":
      return {
        toolName: VISION_UI_TO_ARTIFACT_TOOL_PUBLIC_NAME,
        args: {
          image_source: resolveImage(request.source),
          output_type: request.outputType,
          prompt: request.instruction,
        },
      };
    case "extract-text": {
      const args: Record<string, unknown> = {
        image_source: resolveImage(request.source),
        prompt: request.instruction,
      };
      if (request.programmingLanguage) {
        args.programming_language = request.programmingLanguage;
      }
      return { toolName: VISION_EXTRACT_TEXT_TOOL_PUBLIC_NAME, args };
    }
    case "diagnose-error": {
      const args: Record<string, unknown> = {
        image_source: resolveImage(request.source),
        prompt: request.instruction,
      };
      if (request.context) {
        args.context = request.context;
      }
      return { toolName: VISION_DIAGNOSE_ERROR_TOOL_PUBLIC_NAME, args };
    }
    case "diagram": {
      const args: Record<string, unknown> = {
        image_source: resolveImage(request.source),
        prompt: request.instruction,
      };
      if (request.diagramType) {
        args.diagram_type = request.diagramType;
      }
      return { toolName: VISION_DIAGRAM_TOOL_PUBLIC_NAME, args };
    }
    case "chart": {
      const args: Record<string, unknown> = {
        image_source: resolveImage(request.source),
        prompt: request.instruction,
      };
      if (request.focus) {
        args.analysis_focus = request.focus;
      }
      return { toolName: VISION_CHART_TOOL_PUBLIC_NAME, args };
    }
    case "diff":
      return {
        toolName: VISION_DIFF_TOOL_PUBLIC_NAME,
        args: {
          expected_image_source: resolveImage(request.expectedSource),
          actual_image_source: resolveImage(request.actualSource),
          prompt: request.instruction,
        },
      };
    case "video":
      return {
        toolName: VISION_VIDEO_TOOL_PUBLIC_NAME,
        args: {
          video_source: resolveVideo(request.source),
          prompt: request.instruction,
        },
      };
  }
}

async function invokeZaiVision(
  client: ZaiAdapterClientPort,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  try {
    return await client.callToolRaw<unknown>(toolName, args);
  } catch (error) {
    throw normalizeZaiError(error);
  }
}

/**
 * Normalize the Z.AI vision result to a nonempty text string. The
 * `vision.analyze_image` MCP operation returns direct text; an empty,
 * whitespace-only, or non-string value is a malformed result.
 */
function normalizeZaiVisionResult(raw: unknown): string {
  if (typeof raw === "string" && raw.trim().length > 0) {
    return raw;
  }
  throw new ApiError("Z.AI vision returned an empty or malformed result", 500);
}

// ---------------------------------------------------------------------------
// Diagnostics Capability (DESIGN.md §14 — P4-04)
// ---------------------------------------------------------------------------

interface ZaiDiagnosticsCapabilityOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly clientFactory: NonNullable<ZaiAdapterDependencies["clientFactory"]>;
}

/**
 * Build the Z.AI DiagnosticsCapability. Z.AI connectivity is probed
 * through tool discovery: a UTCP client is constructed and `listTools`
 * is called once. The probe authenticates and verifies the MCP
 * transport without a generative request. Shared execution wraps this
 * in the retry policy; the Adapter transport performs one attempt.
 */
function createZaiDiagnosticsCapability(
  options: ZaiDiagnosticsCapabilityOptions,
): DiagnosticsCapability {
  const { env, clientFactory } = options;

  return {
    async invoke(diagOptions: DiagnosticOptions): Promise<void> {
      if (!diagOptions.probe) return;
      // Shared credential resolver (Fixup A — B4/B7): missing key is a
      // configuration failure (ConfigurationError, exit 3).
      requireZaiApiKey(env);
      // Disable client-owned cache and retry so shared execution is the
      // single policy owner. Diagnostics needs no vision MCP server.
      const clientOptions: ZaiMcpClientOptions = {
        enableVision: false,
        noCache: true,
        disableRetry: true,
      };
      const client = clientFactory(clientOptions);
      try {
        await client.listTools();
      } catch (error) {
        throw normalizeZaiError(error);
      } finally {
        await client.close().catch(() => {});
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Descriptor factory
// ---------------------------------------------------------------------------

/**
 * Default Z.AI client factory bound to {@link ZaiMcpClient}. Tests inject
 * a fake factory through {@link createZaiDescriptor}'s dependencies.
 */
function defaultZaiClientFactory(options: ZaiMcpClientOptions): ZaiAdapterClientPort {
  // 4.10: Pass only the fields the adapter actually uses. The adapter
  // never injects `utcpFactory` (tests inject fakes through
  // `createZaiDescriptor`'s `dependencies.clientFactory` instead), so it
  // is omitted here and the lib's constructor falls through to the
  // default `UtcpClient.create()`. This avoids a cast at the options
  // boundary: the providers-layer `UtcpClientPort` declares
  // `getTools(): Promise<unknown[]>`, which is wider than the lib's
  // `McpUtcpClient` (`Promise<Tool[]>`).
  const client = new ZaiMcpClient({
    enableVision: options.enableVision,
    noCache: options.noCache,
    disableRetry: options.disableRetry,
    env: options.env,
  });
  // Adapt the rich ZaiMcpClient surface to the narrow
  // ZaiAdapterClientPort the Z.AI Search Adapter needs.
  return {
    callToolRaw<T>(name: string, args: Record<string, unknown>): Promise<T | string> {
      return client.callToolRaw<T>(name, args);
    },
    listTools(): Promise<unknown[]> {
      return client.listTools();
    },
    close(): Promise<void> {
      return client.close();
    },
  };
}

/**
 * Build the Z.AI Provider Descriptor. The descriptor advertises the
 * Search Capability and constructs an Adapter whose `search` Capability
 * owns credentials, transport lifecycle, Provider field mapping, and
 * failure normalization. Construction is side-effect-free; transport is
 * built and torn down per invocation.
 */
export function createZaiDescriptor(dependencies?: ZaiAdapterDependencies): ProviderDescriptor {
  const clientFactory =
    dependencies?.clientFactory ??
    ((options: ZaiMcpClientOptions) => defaultZaiClientFactory(options));

  // Quota-monitor transport injection (tests). Production uses the
  // global fetch and timers resolved inside the monitor client.
  const quotaTransport: {
    fetch?: ZaiMonitorFetch;
    setTimeout?: typeof setTimeout;
    clearTimeout?: typeof clearTimeout;
  } = {};
  if (dependencies?.quotaFetch) {
    quotaTransport.fetch = dependencies.quotaFetch as ZaiMonitorFetch;
  }
  if (dependencies?.quotaSetTimeout) {
    quotaTransport.setTimeout = dependencies.quotaSetTimeout;
  }
  if (dependencies?.quotaClearTimeout) {
    quotaTransport.clearTimeout = dependencies.quotaClearTimeout;
  }

  return {
    id: "zai",
    isConfigured(env: NodeJS.ProcessEnv): boolean {
      // Shared resolver honours the ZAI_API_KEY alias (Fixup A — B4).
      return isZaiConfigured(env);
    },
    // Provider-fallback Ticket 02 — see ProviderDescriptor.credentialEnvVars.
    // The real production descriptor publishes its env-var name so the
    // executor's `ConfigurationError` message targets the right key.
    credentialEnvVars: ["Z_AI_API_KEY", "ZAI_API_KEY"],
    capabilities(): ReadonlySet<ProviderCapability> {
      // P6-06: advertise `repository-exploration`. The Adapter has
      // supplied `adapter.repository` since P6-04; descriptor
      // metadata now mirrors that fact so Provider selection and
      // Doctor inventory derive from a single source of truth.
      // MiniMax stays free of repository-exploration until it ships
      // its own Adapter and conformance fixtures.
      //
      // Reader Migration Ticket 04: advertise `reader`. The Adapter
      // has supplied `adapter.reader` since Ticket 03; descriptor
      // metadata now mirrors that fact so Provider selection and
      // Doctor inventory derive from a single source of truth.
      // MiniMax stays free of reader until it ships its own Adapter
      // and conformance fixtures.
      return new Set<ProviderCapability>([
        "search",
        "vision.interpret-image",
        "vision.ui-artifact",
        "vision.extract-text",
        "vision.diagnose-error",
        "vision.diagram",
        "vision.chart",
        "vision.diff",
        "vision.video",
        "quota",
        "diagnostics",
        "repository-exploration",
        "reader",
      ]);
    },
    create(context: ProviderContext): ProviderAdapter {
      // T2b — bind the resolved env (injected env + file keys) into every
      // capability's client construction path. The capability closes over
      // `clientFactory` and calls it with per-operation options; wrapping
      // the factory here merges `env: context.env` into those options so
      // the real `ZaiMcpClient` (constructed inside `defaultZaiClientFactory`)
      // authorises with the resolved credential rather than ambient state.
      // Injected test factories keep working: they receive `env` as an
      // additive option they can ignore.
      const envBoundClientFactory = (options: ZaiMcpClientOptions): ZaiAdapterClientPort =>
        clientFactory({ ...options, env: context.env });
      const search = createZaiSearchCapability({
        env: context.env,
        clientFactory: envBoundClientFactory,
      });
      const vision = createZaiVisionCapability({
        env: context.env,
        clientFactory: envBoundClientFactory,
        layoutParsingFetch: dependencies?.layoutParsingFetch,
        notice: dependencies?.notice,
        ...(dependencies?.layoutParsingCacheEnv !== undefined && {
          layoutParsingCacheEnv: dependencies.layoutParsingCacheEnv,
        }),
        ...(dependencies?.layoutParsingConsume !== undefined && {
          layoutParsingConsume: dependencies.layoutParsingConsume,
        }),
        ...(dependencies?.layoutParsingConsumeNow !== undefined && {
          layoutParsingConsumeNow: dependencies.layoutParsingConsumeNow,
        }),
      });
      const quotaOptions: ZaiQuotaCapabilityOptions = { env: context.env, ...quotaTransport };
      const quota = createZaiQuotaCapability(quotaOptions);
      const diagnostics = createZaiDiagnosticsCapability({
        env: context.env,
        clientFactory: envBoundClientFactory,
      });
      // P6-04: wire the Repository Capability so tests and the future
      // Explorer layer (P6-05+) can reach the implementation through
      // `adapter.repository`. P6-06 advertises
      // `repository-exploration` in `capabilities()` so Provider
      // selection and Doctor inventory derive from a single source of
      // truth. P6-04A forwards the optional `repositoryCloseTimeoutMs`
      // test seam; production leaves it undefined and the capability
      // uses the documented 2000 ms default.
      const repository = createZaiRepositoryCapability({
        env: context.env,
        clientFactory: envBoundClientFactory,
        ...(dependencies?.repositoryCloseTimeoutMs !== undefined && {
          closeTimeoutMs: dependencies.repositoryCloseTimeoutMs,
        }),
      });
      // Reader Migration Ticket 03: wire the Reader Capability so tests
      // and the Ticket 04 handler cutover can reach the implementation
      // through `adapter.reader.fetch`. Ticket 04 advertised `reader`
      // in `capabilities()` so Provider selection and Doctor inventory
      // derive from a single source of truth, and cut
      // `commands/read.ts` over to dispatch through this handle.
      // The optional `readerCloseTimeoutMs` test seam mirrors the
      // repository seam; production leaves it undefined and the
      // capability uses the documented 2000 ms default.
      const reader = createZaiReaderCapability({
        env: context.env,
        clientFactory: envBoundClientFactory,
        ...(dependencies?.readerCloseTimeoutMs !== undefined && {
          closeTimeoutMs: dependencies.readerCloseTimeoutMs,
        }),
      });
      return { id: "zai", search, vision, quota, diagnostics, repository, reader };
    },
  };
}
