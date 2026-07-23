/**
 * Brave Provider Adapter (brave-tech-plan §2, §5, §6).
 *
 * T2 wires the Search Capability (web + news). The descriptor
 * advertises `"search"` and `create()` returns an Adapter whose
 * `search` Capability owns credentials, transport, Provider field
 * mapping, and failure normalization. Credentials, the direct-HTTP GET
 * transport, and the header-bearing fetch seam come from T1; later
 * tickets widen the capability set (reader, etc.). T5 wires the
 * Diagnostics Capability (one-query doctor probe); T6 wires the Quota
 * Capability (1-query rate-limit-header probe with a spend caveat).
 *
 * Boundary rules (ARCHITECTURE.md §2):
 *   - May import capability types, normalized errors, Provider identity
 *     types, and the Adapter-local credential and transport Modules.
 *   - Must NOT import command presentation, output mode, or another
 *     Provider's Adapter.
 */

import crypto from "node:crypto";

import type {
  ProviderAdapter,
  ProviderCapability,
  ProviderContext,
  ProviderDescriptor,
} from "../types.js";
import type {
  SearchCacheIdentity,
  SearchCapability,
  SearchControls,
  SearchRecency,
  SearchRequest,
  SearchSource,
} from "../../capabilities/search.js";
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
import { applySearchTopic } from "../../lib/search-topic.js";
import { requireBraveApiKey, isBraveConfigured } from "./credentials.js";
import {
  fetchBraveSearch,
  fetchBraveNewsSearch,
  fetchBraveVideoSearch,
  fetchBraveLlmContext,
  type BraveSearchParams,
  type BraveTransportDeps,
} from "./client.js";
import { createBraveDiagnosticsCapability } from "./diagnostics.js";
import { createBraveQuotaCapability } from "./quota.js";

/**
 * Dependencies the Brave Adapter accepts. The unified `transport`
 * seam carries `fetch` and timer injection; the Search Capability
 * threads it through to the direct-HTTP transport.
 */
export interface BraveAdapterDependencies {
  /** Optional transport injection (fetch, timers, env). */
  readonly transport?: BraveTransportDeps;
}

// ---------------------------------------------------------------------------
// Provider-owned credential fingerprint
// ---------------------------------------------------------------------------

function credentialFingerprint(apiKey: string): string {
  return crypto.createHash("sha256").update(apiKey).digest("hex");
}

function resolveApiKey(env: NodeJS.ProcessEnv): string {
  return requireBraveApiKey(env);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Validation (FR-012): reject unsupported controls before any API access
// ---------------------------------------------------------------------------

/**
 * Controls the Brave Search Adapter does NOT accept as individuals.
 * Every control (`domain`/`recency`/`location`/`topic`/`type`/
 * `contentSize`) is now honored here — `contentSize:"high"` routes to
 * the LLM Context endpoint (T4), and `medium`/default is a no-op depth
 * on the web path. Brave therefore has NO per-control reject-list.
 *
 * The one Brave-specific constraint is a COMBINATION — `type:"video"`
 * has no depth mode, so `type:"video"` + `contentSize` is incompatible.
 * That is enforced separately as a combination guard in {@link validate}
 * (it fires BEFORE dispatch, naming `contentSize` as the offending
 * option, since `contentSize` is meaningful in general but not on the
 * video path).
 */
const UNSUPPORTED_CONTROLS = [] as const;

function assertNoUnsupportedControls(request: SearchRequest): void {
  const controls = request.controls;
  if (!controls) return;
  for (const key of UNSUPPORTED_CONTROLS) {
    if (controls[key] !== undefined) {
      throw new UnsupportedOptionError("brave", "search", key);
    }
  }
}

/**
 * Brave-specific combination guards for the `type:"video"` path. Video
 * results have no depth mode and no editorial topic axis, so
 * `type:"video"` combined with `contentSize` OR `topic` is rejected
 * BEFORE dispatch. Each error names the incompatible option
 * (`contentSize` / `topic`) — both are individually accepted elsewhere.
 * The `type`×`topic` rule mirrors the CLI parse-time gate so the
 * adapter contract holds for programmatic callers too, not just the CLI.
 */
function assertNoVideoCombinations(request: SearchRequest): void {
  const controls = request.controls;
  if (controls?.type !== "video") return;
  if (controls.contentSize !== undefined) {
    throw new UnsupportedOptionError("brave", "search", "contentSize");
  }
  if (controls.topic !== undefined) {
    throw new UnsupportedOptionError("brave", "search", "topic");
  }
}

// ---------------------------------------------------------------------------
// Control mapping (SearchControls → Brave-native API params + query mutators)
// ---------------------------------------------------------------------------

function mapRecencyToFreshness(recency: SearchRecency): string | undefined {
  switch (recency) {
    case "oneDay":
      return "pd";
    case "oneWeek":
      return "pw";
    case "oneMonth":
      return "pm";
    case "oneYear":
      return "py";
    case "noLimit":
      return undefined;
    default:
      return undefined;
  }
}

/**
 * Map the param-bearing controls into Brave-native API fields. Query-
 * mutating controls (`domain`, `topic:"finance"`) are handled separately
 * in `invoke` via {@link applyQueryMutators}; `topic:"news"` is an
 * endpoint switch, not a param.
 */
function mapSearchControls(controls?: SearchControls): BraveSearchParams | undefined {
  if (!controls) return undefined;
  const params: { country?: string; freshness?: string } = {};
  if (controls.recency) {
    const freshness = mapRecencyToFreshness(controls.recency);
    if (freshness) params.freshness = freshness;
  }
  if (controls.location) {
    params.country = controls.location === "us" ? "US" : "CN";
  }
  if (params.country === undefined && params.freshness === undefined) return undefined;
  return params;
}

/**
 * Apply the query-mutating controls to `query` BEFORE dispatch (not as
 * API params). `domain` appends a `site:<domain>` operator (Brave has no
 * dedicated domain param); `topic:"finance"` appends the finance keyword
 * via the shared helper. `topic:"news"` is NOT a query mutation — it is
 * an endpoint switch handled by the dispatcher.
 *
 * `suppressTopic` drops the `topic:"finance"` keyword appendage while
 * keeping the `domain` operator. The LLM Context (`high`) path sets it:
 * `high` overrides `topic` (it routes to LLM Context regardless of
 * `--topic`), so the editorial topic keyword must NOT pollute the
 * passage-extraction query. Domain is a filter and still applies on the
 * high path, so it is preserved.
 */
function applyQueryMutators(
  query: string,
  controls?: SearchControls,
  suppressTopic = false,
): string {
  let effective = query;
  if (controls?.domain) {
    effective = `${effective} site:${controls.domain}`;
  }
  if (!suppressTopic && controls?.topic === "finance") {
    effective = applySearchTopic(effective, "finance");
  }
  return effective;
}

// ---------------------------------------------------------------------------
// Response normalization
// ---------------------------------------------------------------------------

/**
 * Normalize one Brave result entry into a `SearchSource`.
 *
 *   title       -> title
 *   url         -> url
 *   description -> summary
 *   meta_url.netloc -> source (only when present and string)
 *   page_age ?? age  -> date (only when present and string)
 *
 * A missing/non-string title/url/description is a malformed response.
 */
function normalizeBraveResultEntry(entry: unknown): SearchSource {
  if (!isPlainObject(entry)) {
    throw new ApiError("Brave search returned a malformed response", 500);
  }
  const title = entry.title;
  const url = entry.url;
  const description = entry.description;
  if (typeof title !== "string" || typeof url !== "string" || typeof description !== "string") {
    throw new ApiError("Brave search returned a malformed response", 500);
  }
  const source: SearchSource = { title, url, summary: description };
  const metaUrl = entry.meta_url;
  if (isPlainObject(metaUrl) && typeof metaUrl.netloc === "string") {
    source.source = metaUrl.netloc;
  }
  let dateValue: string | undefined;
  if (typeof entry.page_age === "string") {
    dateValue = entry.page_age;
  } else if (typeof entry.age === "string") {
    dateValue = entry.age;
  }
  if (dateValue !== undefined) {
    source.date = dateValue;
  }
  return source;
}

/**
 * Normalize a raw Brave WEB search response into `SearchSource[]`.
 * Reads `raw.web.results[]`. Any malformed shape is a retryable
 * `ApiError` 500.
 */
function normalizeBraveWebResults(raw: unknown): readonly SearchSource[] {
  if (!isPlainObject(raw)) {
    throw new ApiError("Brave search returned a malformed response", 500);
  }
  const web = raw.web;
  if (!isPlainObject(web)) {
    throw new ApiError("Brave search returned a malformed response", 500);
  }
  const results = web.results;
  if (!Array.isArray(results)) {
    throw new ApiError("Brave search returned a malformed response", 500);
  }
  const out: SearchSource[] = [];
  for (const entry of results) {
    out.push(normalizeBraveResultEntry(entry));
  }
  return out;
}

/**
 * Normalize a raw Brave NEWS search response into `SearchSource[]`.
 * Reads the top-level `raw.results[]` (news responses are not nested
 * under `web`). Any malformed shape is a retryable `ApiError` 500.
 */
function normalizeBraveNewsResults(raw: unknown): readonly SearchSource[] {
  if (!isPlainObject(raw)) {
    throw new ApiError("Brave search returned a malformed response", 500);
  }
  const results = raw.results;
  if (!Array.isArray(results)) {
    throw new ApiError("Brave search returned a malformed response", 500);
  }
  const out: SearchSource[] = [];
  for (const entry of results) {
    out.push(normalizeBraveResultEntry(entry));
  }
  return out;
}

/**
 * Normalize a raw Brave VIDEO search response into `SearchSource[]`.
 * Reads the top-level `raw.results[]` (video responses use the same
 * top-level wrapper as news, NOT `web.results[]`). Brave-only video
 * fields (`duration`/`views`/`creator`/`thumbnail`) are naturally
 * DROPPED — the shared {@link normalizeBraveResultEntry} reads only
 * `title`/`url`/`description`/`meta_url.netloc`/`page_age`/`age`
 * (ADR-0001). Any malformed shape is a retryable `ApiError` 500.
 */
function normalizeBraveVideoResults(raw: unknown): readonly SearchSource[] {
  if (!isPlainObject(raw)) {
    throw new ApiError("Brave search returned a malformed response", 500);
  }
  const results = raw.results;
  if (!Array.isArray(results)) {
    throw new ApiError("Brave search returned a malformed response", 500);
  }
  const out: SearchSource[] = [];
  for (const entry of results) {
    out.push(normalizeBraveResultEntry(entry));
  }
  return out;
}

/**
 * Normalize a raw Brave LLM Context response into `SearchSource[]`.
 * Reads `raw.grounding.generic[]`; each entry carries `title`/`url` and
 * a `snippets` array of extracted passages. Passages are joined with a
 * blank line into `summary`. LLM Context entries do NOT carry
 * `meta_url.netloc` or `page_age`/`age` (the web/news/video shape), so
 * `source`/`date` are not synthesized here. Any malformed shape is a
 * retryable `ApiError` 500.
 */
function normalizeBraveLlmContextResults(raw: unknown): readonly SearchSource[] {
  if (!isPlainObject(raw)) {
    throw new ApiError("Brave search returned a malformed response", 500);
  }
  const grounding = raw.grounding;
  if (!isPlainObject(grounding)) {
    throw new ApiError("Brave search returned a malformed response", 500);
  }
  const generic = grounding.generic;
  if (!Array.isArray(generic)) {
    throw new ApiError("Brave search returned a malformed response", 500);
  }
  const out: SearchSource[] = [];
  for (const entry of generic) {
    if (!isPlainObject(entry)) {
      throw new ApiError("Brave search returned a malformed response", 500);
    }
    const title = entry.title;
    const url = entry.url;
    const snippets = entry.snippets;
    if (
      typeof title !== "string" ||
      typeof url !== "string" ||
      !Array.isArray(snippets) ||
      snippets.some((s) => typeof s !== "string")
    ) {
      throw new ApiError("Brave search returned a malformed response", 500);
    }
    out.push({ title, url, summary: snippets.join("\n\n") });
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
 * retryable set (429 or any 5xx 500..599 inclusive, per DESIGN.md §18 /
 * FR-090). Unknown failures default to 500 (transient). When the caller
 * already carries a numeric status (a typed ApiError), that status is
 * honoured directly.
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
 * Status-keyed outward message for rewrapped Brave ApiErrors. The rewrap
 * does not echo upstream `error.message` — a future change embedding a
 * raw Provider body in an ApiError message would leak through
 * normalization, the cache, and stdout. Curated constants only.
 */
function braveApiErrorMessage(statusCode: number): string {
  if (statusCode === 429) return "Brave rate limit exceeded";
  return "Brave request failed";
}

/**
 * Normalize a Provider failure with sanitized messages. Raw response
 * bodies never cross the adapter boundary. Same pattern as
 * `normalizeTavilyError` / `normalizeMiniMaxError`.
 */
function normalizeBraveError(error: unknown): Error {
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
    return new AuthError("Brave authentication failed", "BRAVE_SEARCH_API_KEY");
  }
  if (error instanceof NetworkError) {
    return new NetworkError("Brave network error");
  }
  if (error instanceof TimeoutError) {
    return new TimeoutError(
      error.durationMs,
      "Try again or increase timeout with BRAVE_TIMEOUT env var",
    );
  }
  if (error instanceof ApiError) {
    const statusCode = inferStatusCode("", error.statusCode);
    return new ApiError(braveApiErrorMessage(statusCode), statusCode);
  }
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (
    lower.includes("401") ||
    lower.includes("403") ||
    lower.includes("unauthorized") ||
    lower.includes("forbidden")
  ) {
    return new AuthError("Brave authentication failed");
  }
  if (lower.includes("timeout") || lower.includes("timed out") || lower.includes("etimedout")) {
    // Fallback branch: the transport wraps real timeouts into a typed
    // TimeoutError (which carries the configured duration) before they
    // reach this point. This untyped-message heuristic is rarely hit, so
    // a constant default is fine and keeps process.env out of the
    // normalization path (test isolation).
    return new TimeoutError(30000);
  }
  if (
    lower.includes("econnrefused") ||
    lower.includes("econnreset") ||
    lower.includes("network") ||
    lower.includes("enotfound") ||
    lower.includes("fetch failed")
  ) {
    return new NetworkError("Brave network error");
  }
  if (lower.includes("429") || lower.includes("rate limit")) {
    return new ApiError("Brave rate limit exceeded", 429);
  }
  return new ApiError("Brave request failed", inferStatusCode(lower));
}

// ---------------------------------------------------------------------------
// Search Capability
// ---------------------------------------------------------------------------

interface BraveSearchCapabilityOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly transport?: BraveTransportDeps;
}

function createBraveSearchCapability(options: BraveSearchCapabilityOptions): SearchCapability {
  const { env, transport } = options;

  const capability: SearchCapability = {
    validate(request: SearchRequest): void {
      if (!request || typeof request.query !== "string" || request.query.trim() === "") {
        throw new ValidationError(
          "Search query must contain at least one non-whitespace character",
        );
      }
      // Brave supports domain, recency, location, topic, and contentSize
      // (contentSize:"high" → LLM Context in T4; medium/default is a
      // no-op depth on the web path). type:"video" combined with
      // contentSize or topic is rejected as incompatible before any
      // transport call.
      assertNoUnsupportedControls(request);
      assertNoVideoCombinations(request);
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
        provider: "brave",
        capability: "search",
        credentialFingerprint: credentialFingerprint(apiKey),
        request: identityRequest,
        // Brave never probes legacy keys — no legacyCandidates.
      };
    },

    async invoke(request: SearchRequest): Promise<readonly SearchSource[]> {
      // Validate before any credential access or transport call.
      capability.validate(request);

      const apiKey = resolveApiKey(env);
      try {
        // Dispatch precedence: video > high > news > web.
        //   - `video` (type:"video") stays the top branch (the
        //     type×contentSize combination is already rejected in
        //     validate, so `isVideo` and `isHigh` never co-occur).
        //   - `high` (contentSize:"high") routes to LLM Context and
        //     OVERRIDES `topic`: a `high + topic:news|finance` request
        //     goes to LLM Context, NOT news/keyword-append.
        //   - `news` (topic:"news") is the news endpoint switch.
        //   - everything else falls through to web search.
        const isVideo = request.controls?.type === "video";
        const isHigh = !isVideo && request.controls?.contentSize === "high";
        const isNews = !isVideo && !isHigh && request.controls?.topic === "news";

        // Query-mutating controls are applied to the query BEFORE
        // dispatch; param-bearing controls (recency/location) are mapped
        // separately. The high path MUST suppress the `topic:finance`
        // keyword appendage (`high` overrides topic, so the editorial
        // keyword must not pollute the passage-extraction query); the
        // `domain` operator is a filter and still applies on every path.
        const effectiveQuery = isHigh
          ? applyQueryMutators(request.query, request.controls, true)
          : applyQueryMutators(request.query, request.controls);
        const params = mapSearchControls(request.controls);

        // The high path sends ONLY `q` to LLM Context — `params`
        // (country/freshness) are NOT forwarded (whether LLM Context
        // accepts them is unconfirmed; see fetchBraveLlmContext). All
        // other paths pass `params` as today.
        const raw = isVideo
          ? await fetchBraveVideoSearch(apiKey, effectiveQuery, params, transport)
          : isHigh
            ? await fetchBraveLlmContext(apiKey, effectiveQuery, transport)
            : isNews
              ? await fetchBraveNewsSearch(apiKey, effectiveQuery, params, transport)
              : await fetchBraveSearch(apiKey, effectiveQuery, params, transport);
        return isVideo
          ? normalizeBraveVideoResults(raw)
          : isHigh
            ? normalizeBraveLlmContextResults(raw)
            : isNews
              ? normalizeBraveNewsResults(raw)
              : normalizeBraveWebResults(raw);
      } catch (error) {
        throw normalizeBraveError(error);
      }
    },
  };

  return capability;
}

// ---------------------------------------------------------------------------
// Descriptor factory
// ---------------------------------------------------------------------------

/**
 * Build the Brave Provider Descriptor. The descriptor advertises the
 * Search (T2), Diagnostics (T5), and Quota (T6) capabilities and
 * constructs an Adapter whose `search`/`diagnostics`/`quota`
 * Capabilities own credentials, transport, Provider field mapping, and
 * failure normalization. Construction is side-effect-free; the
 * transport is invoked per Capability call. Tests pass `transport`
 * (typically a fake-fetch wrapper); production uses the no-argument
 * factory which resolves to the global `fetch` and timers inside the
 * transport Module.
 */
export function createBraveDescriptor(dependencies?: BraveAdapterDependencies): ProviderDescriptor {
  const transport = dependencies?.transport;

  return {
    id: "brave",
    isConfigured(env: NodeJS.ProcessEnv): boolean {
      return isBraveConfigured(env);
    },
    capabilities(): ReadonlySet<ProviderCapability> {
      // T2 wires search; T5 wires diagnostics; T6 wires quota. Later
      // tickets (reader) widen this set in lockstep with the matching
      // Adapter slots.
      return new Set<ProviderCapability>(["search", "diagnostics", "quota"]);
    },
    create(context: ProviderContext): ProviderAdapter {
      const search = createBraveSearchCapability({ env: context.env, transport });
      const diagnostics = createBraveDiagnosticsCapability({ env: context.env, transport });
      const quota = createBraveQuotaCapability({ env: context.env, transport });
      return { id: "brave", search, diagnostics, quota };
    },
  };
}
