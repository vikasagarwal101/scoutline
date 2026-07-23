/**
 * Exa Provider Adapter (tech-plan §7, Control Mapping, Field Normalization,
 * Failure Normalization).
 *
 * Implements the Exa Provider Descriptor with Search, Reader, and
 * Diagnostics capabilities on top of the direct-HTTP transport
 * (`./client.ts`). The Adapter owns credentials, transport lifecycle,
 * Provider field mapping, and failure normalization; shared execution
 * owns cache and retry policy.
 *
 * EXA-T01 develops and tests this descriptor OFFLINE: `exa` is NOT yet in
 * `PROVIDER_IDS` or the production registry (`createExaDescriptor()` is
 * tested against injected descriptor lists only). EXA-T02 adds `"exa"` to
 * `PROVIDER_IDS` and wires the registry atomically with redaction, help
 * text, and conformance fixtures.
 *
 * Boundary rules (ARCHITECTURE.md §2):
 *   - May import capability types, normalized errors, Provider identity
 *     types, and the Adapter-local credential and transport Modules.
 *   - Must NOT import command presentation, output mode, or another
 *     Provider's Adapter.
 *
 * Field mapping (tech-plan §7 Exa mapping):
 *   Search results[].title          -> title
 *   Search results[].url            -> url
 *   Search results[].highlights[]   -> summary (join with " ")
 *   Search results[].author         -> source
 *   Search results[].publishedDate  -> date
 *   Search results[].score          -> (dropped)
 *
 * Control mapping (SearchControls → Exa-native API params):
 *   domain      -> includeDomains: [domain]
 *   recency     -> startPublishedDate (oneDay→now-1d ISO, etc.)
 *   contentSize -> type (medium/omitted→"auto", high→"deep")
 *   topic       -> category (general→omit, news→"news",
 *                  finance→"financial report")
 *   location    -> REJECTED (UnsupportedOptionError)
 */

import crypto from "node:crypto";

import type {
  ProviderAdapter,
  ProviderCapability,
  ProviderContext,
  ProviderDescriptor,
  ProviderId,
} from "../types.js";
import type {
  SearchCacheIdentity,
  SearchCapability,
  SearchControls,
  SearchRecency,
  SearchRequest,
  SearchSource,
} from "../../capabilities/search.js";
import type {
  ReaderCacheIdentity,
  ReaderCapability,
  ReaderFetchRequest,
  ReaderFetchResult,
  ReaderOperation,
} from "../../capabilities/reader.js";
import { decodeReaderFetchResult } from "../../capabilities/reader.js";
import type { DiagnosticsCapability } from "../../capabilities/diagnostics.js";
import {
  ApiError,
  AuthError,
  ConfigurationError,
  NetworkError,
  QuotaError,
  TimeoutError,
  UnsupportedOptionError,
  ValidationError,
} from "../../lib/errors.js";
import { requireExaApiKey, isExaConfigured } from "./credentials.js";
import {
  fetchExaSearch,
  fetchExaContents,
  type ExaSearchParams,
  type ExaContentsParams,
  type ExaTransportDeps,
} from "./client.js";
import { createExaDiagnosticsCapability } from "./diagnostics.js";

/**
 * Dependencies the Exa Adapter accepts. The unified `transport` seam
 * carries `fetch` and timer injection. Production defaults to the global
 * `fetch` and timers inside the transport Module.
 */
export interface ExaAdapterDependencies {
  /** Optional transport injection (fetch, timers, env). */
  readonly transport?: ExaTransportDeps;
}

// ---------------------------------------------------------------------------
// Provider-owned credential fingerprint
// ---------------------------------------------------------------------------

function credentialFingerprint(apiKey: string): string {
  return crypto.createHash("sha256").update(apiKey).digest("hex");
}

function resolveApiKey(env: NodeJS.ProcessEnv): string {
  return requireExaApiKey(env);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Control mapping (SearchControls → Exa-native API params)
// ---------------------------------------------------------------------------

/**
 * Map a recency filter to an Exa `startPublishedDate` (ISO 8601). Exa
 * accepts a date lower bound; `noLimit` omits the filter. The cutoff is
 * computed relative to `now` so the Adapter can produce a deterministic
 * value in tests.
 */
function mapRecencyToStartPublishedDate(recency: SearchRecency, now: Date): string | undefined {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  switch (recency) {
    case "oneDay":
      return new Date(now.getTime() - 1 * MS_PER_DAY).toISOString();
    case "oneWeek":
      return new Date(now.getTime() - 7 * MS_PER_DAY).toISOString();
    case "oneMonth":
      return new Date(now.getTime() - 30 * MS_PER_DAY).toISOString();
    case "oneYear":
      return new Date(now.getTime() - 365 * MS_PER_DAY).toISOString();
    case "noLimit":
      return undefined;
    default:
      return undefined;
  }
}

/**
 * Map a topic hint to an Exa `category`. Exa has no `general` category;
 * general is omitted so the search is unscoped. The Tavily adapter
 * passes `topic` natively; Exa remaps to `category`.
 */
function mapTopicToCategory(topic: string | undefined): string | undefined {
  switch (topic) {
    case "news":
      return "news";
    case "finance":
      return "financial report";
    case "general":
      return undefined;
    default:
      return undefined;
  }
}

/**
 * Map Provider-neutral `SearchControls` to Exa-native search params.
 * `now` defaults to the current time; tests pass a fixed date so the
 * `startPublishedDate` cutoff is deterministic.
 */
function mapSearchControls(
  controls?: SearchControls,
  now: Date = new Date(),
): ExaSearchParams | undefined {
  if (!controls) return undefined;
  const params: {
    includeDomains?: readonly string[];
    startPublishedDate?: string;
    type?: string;
    category?: string;
  } = {};
  if (controls.domain) {
    params.includeDomains = [controls.domain];
  }
  if (controls.recency) {
    const start = mapRecencyToStartPublishedDate(controls.recency, now);
    if (start) params.startPublishedDate = start;
  }
  if (controls.contentSize) {
    params.type = controls.contentSize === "high" ? "deep" : "auto";
  }
  if (controls.topic) {
    const category = mapTopicToCategory(controls.topic);
    if (category) params.category = category;
  }
  return params;
}

// ---------------------------------------------------------------------------
// Response normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a raw Exa search response into `SearchSource[]`.
 *
 *   results[].title          -> title
 *   results[].url            -> url
 *   results[].highlights[]   -> summary (join with " "; empty→"")
 *   results[].author         -> source
 *   results[].publishedDate  -> date
 *   results[].score          -> (dropped)
 *
 * `title` and `url` must be strings; any malformed shape is a retryable
 * `ApiError` 500. `highlights` is optional — when missing or empty,
 * `summary` is the empty string (the result is still returned with its
 * title/url). `author` and `publishedDate` are optional; when present
 * they must be strings.
 */
function normalizeExaSearchResults(raw: unknown): readonly SearchSource[] {
  if (!isPlainObject(raw)) {
    throw new ApiError("Exa search returned a malformed response", 500);
  }
  const results = raw.results;
  if (!Array.isArray(results)) {
    throw new ApiError("Exa search returned a malformed response", 500);
  }
  const out: SearchSource[] = [];
  for (const entry of results) {
    if (!isPlainObject(entry)) {
      throw new ApiError("Exa search returned a malformed response", 500);
    }
    const title = entry.title;
    const url = entry.url;
    if (typeof title !== "string" || typeof url !== "string") {
      throw new ApiError("Exa search returned a malformed response", 500);
    }
    // highlights is an optional string array; join with " ".
    const highlights = entry.highlights;
    let summary: string;
    if (highlights === undefined) {
      summary = "";
    } else if (Array.isArray(highlights)) {
      summary = highlights.filter((h) => typeof h === "string").join(" ");
    } else {
      throw new ApiError("Exa search returned a malformed response", 500);
    }
    const source: SearchSource = { title, url, summary };
    if (typeof entry.author === "string") {
      source.source = entry.author;
    }
    if (typeof entry.publishedDate === "string") {
      source.date = entry.publishedDate;
    }
    out.push(source);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Failure normalization: stable public codes, no raw payloads (NFR-006)
// ---------------------------------------------------------------------------

/**
 * Resolve a stable HTTP-style status code for retry classification.
 * Explicit terminal client errors (400, 404, 410, 422) map to their
 * real codes; transient failures map to a representative status in the
 * retryable set (429 or any 5xx 500..599 inclusive). Unknown failures
 * default to 500 (transient). When the caller already carries a numeric
 * status (a typed ApiError), that status is honoured directly.
 */
function inferStatusCode(lower: string, known?: number): number {
  if (typeof known === "number" && Number.isFinite(known)) return known;
  if (lower.includes("404") || lower.includes("not found")) return 404;
  if (lower.includes("400") || lower.includes("bad request")) return 400;
  if (lower.includes("410") || lower.includes("gone")) return 410;
  if (lower.includes("422") || lower.includes("unprocessable")) return 422;
  if (lower.includes("500") || lower.includes("internal")) return 500;
  if (lower.includes("502") || lower.includes("bad gateway")) return 502;
  if (lower.includes("503") || lower.includes("service unavailable")) return 503;
  if (lower.includes("504") || lower.includes("gateway timeout")) return 504;
  return 500;
}

/**
 * Status-keyed outward message for rewrapped Exa ApiErrors. The rewrap
 * does not echo upstream `error.message` — a future change embedding a
 * raw Provider body in an ApiError message would leak through
 * normalization, the cache, and stdout. Curated constants only.
 */
function exaApiErrorMessage(statusCode: number): string {
  if (statusCode === 429) return "Exa rate limit exceeded";
  return "Exa request failed";
}

/**
 * Normalize a Provider failure with sanitized messages. Raw response
 * bodies never cross the adapter boundary. Mirrors the Tavily adapter's
 * `normalizeTavilyError` pattern.
 */
function normalizeExaError(error: unknown): Error {
  // QuotaError pass-through — terminal retry guarantee preserved.
  if (error instanceof QuotaError) return error;

  // Configuration/option/validation errors carry clean, human-authored
  // messages and are safe to surface verbatim.
  if (
    error instanceof ValidationError ||
    error instanceof UnsupportedOptionError ||
    error instanceof ConfigurationError
  ) {
    return error;
  }
  // Re-wrap typed transport errors with sanitized messages so a raw
  // Provider response body embedded upstream never survives. Code +
  // statusCode (retry signal) are preserved.
  if (error instanceof AuthError) {
    return new AuthError("Exa authentication failed", "EXA_API_KEY");
  }
  if (error instanceof NetworkError) {
    return new NetworkError("Exa network error");
  }
  if (error instanceof TimeoutError) {
    return new TimeoutError(
      error.durationMs,
      "Try again or increase timeout with EXA_TIMEOUT env var",
    );
  }
  if (error instanceof ApiError) {
    const statusCode = inferStatusCode("", error.statusCode);
    return new ApiError(exaApiErrorMessage(statusCode), statusCode);
  }
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (
    lower.includes("401") ||
    lower.includes("403") ||
    lower.includes("unauthorized") ||
    lower.includes("forbidden")
  ) {
    return new AuthError("Exa authentication failed");
  }
  if (lower.includes("timeout") || lower.includes("timed out") || lower.includes("etimedout")) {
    return new TimeoutError(30000);
  }
  if (
    lower.includes("econnrefused") ||
    lower.includes("econnreset") ||
    lower.includes("network") ||
    lower.includes("enotfound") ||
    lower.includes("fetch failed")
  ) {
    return new NetworkError("Exa network error");
  }
  if (lower.includes("429") || lower.includes("rate limit")) {
    return new ApiError("Exa rate limit exceeded", 429);
  }
  return new ApiError("Exa request failed", inferStatusCode(lower));
}

// ---------------------------------------------------------------------------
// Search Capability
// ---------------------------------------------------------------------------

interface ExaSearchCapabilityOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly transport?: ExaTransportDeps;
}

function createExaSearchCapability(options: ExaSearchCapabilityOptions): SearchCapability {
  const { env, transport } = options;

  const capability: SearchCapability = {
    validate(request: SearchRequest): void {
      if (!request || typeof request.query !== "string" || request.query.trim() === "") {
        throw new ValidationError(
          "Search query must contain at least one non-whitespace character",
        );
      }
      // Exa supports domain, recency, contentSize, and topic natively.
      // location is Z.AI-specific and rejected before any transport call.
      if (request.controls?.location !== undefined) {
        throw new UnsupportedOptionError("exa", "search", "location");
      }
    },

    cacheIdentity(request: SearchRequest): SearchCacheIdentity {
      const apiKey = resolveApiKey(env);
      const identityRequest: { query: string; controls?: SearchControls } = {
        query: request.query,
      };
      if (request.controls) {
        identityRequest.controls = request.controls;
      }
      return {
        provider: "exa",
        capability: "search",
        credentialFingerprint: credentialFingerprint(apiKey),
        request: identityRequest,
        // Exa never probes legacy keys — no legacyCandidates.
      };
    },

    async invoke(request: SearchRequest): Promise<readonly SearchSource[]> {
      capability.validate(request);

      const apiKey = resolveApiKey(env);
      try {
        const params = mapSearchControls(request.controls);
        const raw = await fetchExaSearch(apiKey, request.query, params, transport);
        return normalizeExaSearchResults(raw);
      } catch (error) {
        throw normalizeExaError(error);
      }
    },
  };

  return capability;
}

// ---------------------------------------------------------------------------
// Reader validation helpers
// ---------------------------------------------------------------------------

/** Options the Exa Reader does NOT accept (Z.AI-only). */
const UNSUPPORTED_READER_OPTIONS = [
  "retainImages",
  "withLinksSummary",
  "noGfm",
  "keepImgDataUrl",
  "withImagesSummary",
] as const;

function assertHttpUrl(url: unknown): asserts url is string {
  if (typeof url !== "string" || url.length === 0) {
    throw new ValidationError("Exa reader URL must be a non-empty string");
  }
  if (!/^https?:\/\//.test(url)) {
    throw new ValidationError("URL must start with http:// or https://");
  }
}

function assertNoUnsupportedReaderOptions(request: ReaderFetchRequest): void {
  for (const key of UNSUPPORTED_READER_OPTIONS) {
    if (request[key] === true) {
      throw new UnsupportedOptionError("exa", "reader", key);
    }
  }
}

// ---------------------------------------------------------------------------
// Markdown stripping (format: text — best-effort)
// ---------------------------------------------------------------------------

/**
 * Best-effort markdown-to-text conversion. Exa always returns text
 * content; when the caller requests `format: "text"`, this strips
 * common markdown markers so the output is closer to plain text.
 * Code blocks and tables degrade (their content is kept but
 * formatting is lost); that is an acceptable edge case for a "rough
 * text" mode. This is adapter-local — no shared stripper exists.
 */
function stripMarkdown(input: string): string {
  let result = input;
  // Remove fenced code blocks (keep the inner text).
  result = result.replace(/```[\s\S]*?```/g, (block) =>
    block.replace(/```\w*\n?/g, "").replace(/```$/g, ""),
  );
  // Remove inline code backticks.
  result = result.replace(/`([^`]+)`/g, "$1");
  // Images: ![alt](url) → alt.
  result = result.replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1");
  // Links: [text](url) → text.
  result = result.replace(/\[([^\]]*)\]\([^)]+\)/g, "$1");
  // Headers: leading # markers.
  result = result.replace(/^#{1,6}\s+/gm, "");
  // Emphasis: **bold**, __bold__, *italic*, _italic_, ~~strike~~.
  result = result.replace(/\*\*(.+?)\*\*/g, "$1");
  result = result.replace(/__(.+?)__/g, "$1");
  result = result.replace(/\*(.+?)\*/g, "$1");
  result = result.replace(/_(.+?)_/g, "$1");
  result = result.replace(/~~(.+?)~~/g, "$1");
  // Blockquotes: leading > markers.
  result = result.replace(/^>\s+/gm, "");
  // Horizontal rules: ---, ***, ___.
  result = result.replace(/^[-*_]{3,}\s*$/gm, "");
  // List markers: -, *, +, 1.
  result = result.replace(/^[\s]*[-*+]\s+/gm, "");
  result = result.replace(/^[\s]*\d+\.\s+/gm, "");
  return result.trim();
}

// ---------------------------------------------------------------------------
// Per-URL status total function (the load-bearing mechanism)
// ---------------------------------------------------------------------------

/**
 * Known error-tag → HTTP status mapping. When `error.httpStatusCode` is
 * present on the response, it is preferred over this table for retry
 * classification. Unknown tags default to 500 (retryable).
 */
const CONTENTS_ERROR_STATUS: Record<string, number> = {
  CRAWL_NOT_FOUND: 404,
  UNSUPPORTED_URL: 400,
  SOURCE_NOT_AVAILABLE: 403,
  CRAWL_TIMEOUT: 504,
  CRAWL_LIVECRAWL_TIMEOUT: 504,
  CRAWL_UNKNOWN_ERROR: 500,
};

/**
 * Normalize a raw Exa `/contents` response into a `ReaderFetchResult`.
 *
 * **Critical mechanism — per-URL status inspection (total function).**
 * `/contents` returns HTTP 200 even when an individual URL fails. The
 * adapter MUST resolve the status entry whose `statuses[].id` matches
 * the requested URL, then apply a total mapping. Match by `id`, never
 * assume `results[0]` is the requested URL.
 *
 * Field mapping:
 *   results[].text   -> content   (the entry whose id/status matches)
 *   results[].url    -> finalUrl
 *   results[].title  -> title     (coerce blank → null)
 *   request.url      -> url
 *   request.format   -> contentFormat (after any text stripping)
 *
 * On `format: "text"`, the content is run through {@link stripMarkdown}
 * (best-effort) and `contentFormat` is set to `"text"`.
 */
function normalizeExaContentsResult(raw: unknown, request: ReaderFetchRequest): ReaderFetchResult {
  if (!isPlainObject(raw)) {
    throw new ApiError("Exa contents returned a malformed response", 500);
  }

  // Step 1: find the status entry matching the requested URL. Never
  // assume results[0] is the match — the API returns HTTP 200 even on
  // per-URL failure.
  const statuses = raw.statuses;
  if (!Array.isArray(statuses)) {
    throw new ApiError("Exa contents returned a malformed response", 500);
  }
  const statusEntry = statuses.find(
    (s): s is Record<string, unknown> =>
      isPlainObject(s) && typeof s.id === "string" && s.id === request.url,
  );
  if (!statusEntry) {
    // No matching id — malformed/absent status. Retryable, never silent success.
    throw new ApiError("Exa contents returned a malformed response", 500);
  }

  const statusValue = statusEntry.status;

  // Step 2: error path — map the tag + httpStatusCode to a sanitized ApiError.
  if (statusValue !== "success") {
    const errorObj = isPlainObject(statusEntry.error) ? statusEntry.error : {};
    const tag = typeof errorObj.tag === "string" ? errorObj.tag : undefined;
    const httpStatusCode =
      typeof errorObj.httpStatusCode === "number" ? errorObj.httpStatusCode : undefined;
    const statusCode = httpStatusCode ?? CONTENTS_ERROR_STATUS[tag ?? ""] ?? 500;
    throw new ApiError("Exa contents request failed", statusCode);
  }

  // Step 3: success path — find the matching result in results[].
  const results = raw.results;
  if (!Array.isArray(results)) {
    throw new ApiError("Exa contents returned a malformed response", 500);
  }
  // For a single-URL fetch, the result entry's id or url should match.
  const result = results.find(
    (r): r is Record<string, unknown> =>
      isPlainObject(r) &&
      ((typeof r.id === "string" && r.id === request.url) ||
        (typeof r.url === "string" && r.url === request.url)),
  );
  // Fall back to the first result if no URL match (single-URL fetch).
  const entry = result ?? (results.length > 0 && isPlainObject(results[0]) ? results[0] : null);
  if (!entry) {
    throw new ApiError("Exa contents returned a malformed response", 500);
  }

  // Step 4: field mapping.
  const content = entry.text;
  if (typeof content !== "string" || content.length === 0) {
    throw new ApiError("Exa contents returned a malformed response", 500);
  }
  const finalUrl = typeof entry.url === "string" && entry.url.length > 0 ? entry.url : request.url;
  const rawTitle = typeof entry.title === "string" ? entry.title.trim() : "";
  const title: string | null = rawTitle.length > 0 ? rawTitle : null;

  const requestedFormat = request.format ?? "markdown";
  if (requestedFormat === "text") {
    return {
      schemaVersion: 1,
      url: request.url,
      finalUrl,
      title,
      content: stripMarkdown(content),
      contentFormat: "text",
    };
  }
  return {
    schemaVersion: 1,
    url: request.url,
    finalUrl,
    title,
    content,
    contentFormat: "markdown",
  };
}

/**
 * Map a `ReaderFetchRequest` to Exa-native contents params. The CLI
 * `--timeout` is in seconds; Exa's `livecrawlTimeout` is in
 * milliseconds. The conversion (`* 1000`) is validated here so a direct
 * pass-through doesn't send 20ms instead of 20s.
 */
function mapReaderControls(request: ReaderFetchRequest): ExaContentsParams | undefined {
  if (
    typeof request.timeout !== "number" ||
    !Number.isFinite(request.timeout) ||
    request.timeout <= 0
  ) {
    return undefined;
  }
  const livecrawlTimeout = Math.round(request.timeout * 1000);
  if (!Number.isFinite(livecrawlTimeout) || livecrawlTimeout <= 0) {
    return undefined;
  }
  return { livecrawlTimeout };
}

// ---------------------------------------------------------------------------
// Reader Capability
// ---------------------------------------------------------------------------

interface ExaReaderCapabilityOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly transport?: ExaTransportDeps;
}

function createExaReaderCapability(options: ExaReaderCapabilityOptions): ReaderCapability {
  const { env, transport } = options;

  const fetchOp: ReaderOperation<ReaderFetchRequest, ReaderFetchResult> = {
    kind: "reader-fetch",

    validate(request: ReaderFetchRequest): void {
      assertHttpUrl(request.url);
      assertNoUnsupportedReaderOptions(request);
    },

    cacheIdentity(
      request: ReaderFetchRequest,
    ): ReaderCacheIdentity<ReaderFetchRequest, ReaderFetchResult> {
      const apiKey = resolveApiKey(env);
      return {
        provider: "exa",
        capability: "reader",
        operation: "reader-fetch",
        credentialFingerprint: credentialFingerprint(apiKey),
        request,
        legacyCandidates: [],
      };
    },

    decodeCached(value: unknown): ReaderFetchResult | null {
      return decodeReaderFetchResult(value);
    },

    async invoke(request: ReaderFetchRequest): Promise<ReaderFetchResult> {
      fetchOp.validate(request);

      const apiKey = resolveApiKey(env);
      try {
        const params = mapReaderControls(request);
        const raw = await fetchExaContents(apiKey, request.url, params, transport);
        return normalizeExaContentsResult(raw, request);
      } catch (error) {
        throw normalizeExaError(error);
      }
    },
  };

  return { fetch: fetchOp };
}

// ---------------------------------------------------------------------------
// Descriptor factory
// ---------------------------------------------------------------------------

/**
 * Build the Exa Provider Descriptor. The descriptor advertises the Exa
 * capability set (search + diagnostics for EXA-T01) and constructs an
 * Adapter whose Capabilities own credentials, transport, Provider field
 * mapping, and failure normalization. Construction is side-effect-free;
 * the transport is invoked per Capability call. Tests pass `transport`
 * (typically a fake-fetch wrapper); production uses the no-argument
 * factory which resolves to the global `fetch` and timers inside the
 * transport Module.
 *
 * EXA-T01 (offline): `exa` is NOT yet in `PROVIDER_IDS`. The `id` is
 * cast to `ProviderId` so the descriptor satisfies the interface for
 * injected-list testing. EXA-T02 adds `"exa"` to the tuple and removes
 * this cast atomically with the registry landing.
 */
export function createExaDescriptor(dependencies?: ExaAdapterDependencies): ProviderDescriptor {
  const transport = dependencies?.transport;

  return {
    id: "exa",
    isConfigured(env: NodeJS.ProcessEnv): boolean {
      return isExaConfigured(env);
    },
    capabilities(): ReadonlySet<ProviderCapability> {
      return new Set<ProviderCapability>(["search", "reader", "diagnostics"]);
    },
    create(context: ProviderContext): ProviderAdapter {
      const search = createExaSearchCapability({
        env: context.env,
        transport,
      });
      const reader = createExaReaderCapability({
        env: context.env,
        transport,
      });
      const diagnostics: DiagnosticsCapability = createExaDiagnosticsCapability({
        env: context.env,
        transport,
      });
      return { id: "exa", search, reader, diagnostics };
    },
  };
}
