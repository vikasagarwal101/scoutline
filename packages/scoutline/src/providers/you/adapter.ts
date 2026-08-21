/**
 * You.com Provider Adapter (SPEC: dual-host — `ydc-index.io` for
 * Search/Contents, `api.you.com` for Research).
 *
 * Implements the You.com Provider Descriptor. The Adapter owns
 * credentials, transport lifecycle, Provider field mapping, and failure
 * normalization; shared execution owns cache and retry policy. This
 * module wires the wire-level Search capability; the Reader, Research,
 * and Diagnostics capabilities land in follow-up commits.
 *
 * Boundary rules (same as the Exa adapter):
 *   - May import capability types, normalized errors, Provider identity
 *     types, and the Adapter-local credential and client Modules.
 *   - Must NOT import command presentation, output mode, or another
 *     Provider's Adapter.
 *
 * Control mapping (SearchControls → You.com-native request fields):
 *   domain      -> include_domains: [domain]
 *   recency     -> freshness: day|week|month|year
 *                 (oneDay/oneWeek/oneMonth/oneYear); noLimit omits
 *                 freshness entirely
 *   location    -> country: "US"|"CN" (us|cn)
 *   contentSize -> extraction.extraction_mode: "full_page" (high) |
 *                 "highlights" (medium)
 *   topic       -> query keyword appendage (shared `applySearchTopic`,
 *                 same approach as the Z.AI and MiniMax adapters)
 *   type        -> rejected (no You.com-native mapping; it is Brave-only
 *                 and routes to its video endpoint). Rejection happens
 *                 in `validate`, before credential resolution or any
 *                 transport call, so option-level provider fallback can
 *                 continue past You.com to the capable Provider.
 */

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
import type {
  ReaderCacheIdentity,
  ReaderCapability,
  ReaderFetchRequest,
  ReaderFetchResult,
  ReaderOperation,
} from "../../capabilities/reader.js";
import { decodeReaderFetchResult } from "../../capabilities/reader.js";
import type {
  ResearchCapability,
  ResearchOperation,
  ResearchRequest,
  ResearchResult,
  ResearchSource,
} from "../../capabilities/research.js";
import { decodeResearchResult } from "../../capabilities/research.js";
import type { DiagnosticsCapability } from "../../capabilities/diagnostics.js";
import type { CacheIdentity } from "../../lib/execution.js";
import { ApiError, UnsupportedOptionError, ValidationError } from "../../lib/errors.js";
import { applySearchTopic } from "../../lib/search-topic.js";
import { hashYouApiKey, isYouConfigured, requireYouApiKey } from "./credentials.js";
import { fetchYouContents, fetchYouResearch, fetchYouSearch } from "./client.js";
import type {
  YouContentsWireRequest,
  YouResearchWireRequest,
  YouSearchWireRequest,
  YouTransportDeps,
} from "./client.js";
import { createYouDiagnosticsCapability } from "./diagnostics.js";

export type { YouTransportDeps } from "./client.js";

/** Dependencies the You.com Adapter accepts. */
export interface YouAdapterDependencies {
  /** Optional transport injection (fetch, timers). */
  readonly transport?: YouTransportDeps;
}

/**
 * `PROVIDER_IDS` widens with `"you"` when the registry wires this
 * descriptor; until then these local intersections keep the factory's
 * return types assignable to the contract types (`ProviderDescriptor` /
 * `ProviderAdapter`) without widening the public Provider ID union from
 * inside the Adapter. Once `"you"` joins `ProviderId`, every local type
 * here collapses into the shared contract type unchanged.
 */
export type YouSearchCacheIdentity = Omit<SearchCacheIdentity, "provider"> & {
  readonly provider: "you";
};
export type YouSearchCapability = Omit<SearchCapability, "cacheIdentity"> & {
  cacheIdentity(
    request: SearchRequest,
    compatibility?: { readonly legacyCount?: number },
  ): YouSearchCacheIdentity;
};
export type YouReaderCacheIdentity = Omit<
  ReaderCacheIdentity<ReaderFetchRequest, ReaderFetchResult>,
  "provider"
> & {
  readonly provider: "you";
};
export type YouReaderFetchOperation = Omit<
  ReaderOperation<ReaderFetchRequest, ReaderFetchResult>,
  "cacheIdentity"
> & {
  cacheIdentity(request: ReaderFetchRequest): YouReaderCacheIdentity;
};
export type YouReaderCapability = { readonly fetch: YouReaderFetchOperation };
export type YouResearchCacheIdentity = Omit<
  CacheIdentity<ResearchRequest, ResearchResult>,
  "provider"
> & {
  readonly provider: "you";
};
export type YouResearchOperation = Omit<ResearchOperation, "cacheIdentity"> & {
  cacheIdentity(request: ResearchRequest): YouResearchCacheIdentity;
};
export type YouResearchCapability = { readonly run: YouResearchOperation };
export type YouAdapter = Omit<
  ProviderAdapter,
  "id" | "search" | "reader" | "research" | "diagnostics"
> & {
  readonly id: "you";
  readonly search: YouSearchCapability;
  readonly reader: YouReaderCapability;
  readonly research: YouResearchCapability;
  readonly diagnostics: DiagnosticsCapability;
};
export type YouDescriptor = Omit<ProviderDescriptor, "id" | "create"> & {
  readonly id: "you";
  create(context: ProviderContext): YouAdapter;
};

// ---------------------------------------------------------------------------
// Field mapping (SearchControls → You.com-native request fields)
// ---------------------------------------------------------------------------
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Map `SearchRecency` onto the You.com `freshness` field.
 * `noLimit` is the explicit "do not constrain" value and omits the
 * field rather than sending an unknown enum member.
 */
const RECENCY_TO_FRESHNESS: Readonly<
  Record<Exclude<SearchRecency, "noLimit">, "day" | "week" | "month" | "year">
> = {
  oneDay: "day",
  oneWeek: "week",
  oneMonth: "month",
  oneYear: "year",
};

/**
 * Map a Provider-neutral Search request onto a You.com-native wire
 * request. `type` never reaches this mapping — `validate` rejects it
 * before credential resolution or any transport call.
 */
function mapYouSearchRequest(request: SearchRequest): YouSearchWireRequest {
  const controls = request.controls;
  const wire: {
    query: string;
    include_domains?: readonly string[];
    freshness?: "day" | "week" | "month" | "year";
    country?: string;
    extraction?: { readonly extraction_mode?: "highlights" | "full_page" };
  } = {
    // You.com has no native topic parameter; a non-general topic is a
    // query keyword appendage (same approach as Z.AI and MiniMax).
    query: applySearchTopic(request.query, controls?.topic),
  };
  if (controls?.domain) {
    wire.include_domains = [controls.domain];
  }
  if (controls?.recency && controls.recency !== "noLimit") {
    wire.freshness = RECENCY_TO_FRESHNESS[controls.recency];
  }
  if (controls?.location) {
    wire.country = controls.location === "cn" ? "CN" : "US";
  }
  if (controls?.contentSize) {
    wire.extraction = {
      extraction_mode: controls.contentSize === "high" ? "full_page" : "highlights",
    };
  }
  return wire;
}

// ---------------------------------------------------------------------------
// Response normalization
// ---------------------------------------------------------------------------
/**
 * Normalize a raw You.com search response into `SearchSource[]`.
 *
 *   results.web[].title       -> title
 *   results.web[].url         -> url
 *   results.web[].snippets[0] -> summary (fallback: `description`)
 *
 * Items missing a `url` are skipped, not fatal. A malformed envelope
 * (non-object body, missing or non-object `results`, non-array
 * `results.web`) is a terminal `ApiError` 500; the wire body never
 * crosses the adapter boundary in the error message.
 */
function normalizeYouSearchResults(raw: unknown): readonly SearchSource[] {
  if (!isPlainObject(raw)) {
    throw new ApiError("You.com search returned a malformed response", 500);
  }
  const results = raw.results;
  if (!isPlainObject(results)) {
    throw new ApiError("You.com search returned a malformed response", 500);
  }
  const web = results.web;
  if (!Array.isArray(web)) {
    throw new ApiError("You.com search returned a malformed response", 500);
  }
  const out: SearchSource[] = [];
  for (const entry of web) {
    if (!isPlainObject(entry)) continue;
    const url = entry.url;
    if (typeof url !== "string" || url.length === 0) continue;
    const title = typeof entry.title === "string" ? entry.title : "";
    const snippet = Array.isArray(entry.snippets)
      ? entry.snippets.find((s): s is string => typeof s === "string")
      : undefined;
    const summary =
      snippet ?? (typeof entry.description === "string" ? entry.description : "");
    out.push({ title, url, summary });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Search Capability
// ---------------------------------------------------------------------------
/** Options the You.com Search Capability binds at construction time. */
interface YouSearchCapabilityOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly transport?: YouTransportDeps;
}

function createYouSearchCapability(options: YouSearchCapabilityOptions): YouSearchCapability {
  const { env, transport } = options;
  const capability: YouSearchCapability = {
    validate(request: SearchRequest): void {
      if (!request || typeof request.query !== "string" || request.query.trim() === "") {
        throw new ValidationError(
          "Search query must contain at least one non-whitespace character",
        );
      }
      // type has no You.com-native param (it is Brave-only and routes
      // to its video endpoint); reject before any transport call so the
      // option-level fallback contract can continue past You.com to the
      // capable provider.
      if (request.controls?.type !== undefined) {
        throw new UnsupportedOptionError("you", "search", "type");
      }
    },
    cacheIdentity(request: SearchRequest): YouSearchCacheIdentity {
      // Metadata-only: resolves the key from the environment and
      // fingerprints it; performs no transport call.
      const apiKey = requireYouApiKey(env);
      const identityRequest: { query: string; controls?: SearchControls } = {
        query: request.query,
      };
      if (request.controls) {
        identityRequest.controls = request.controls;
      }
      return {
        provider: "you",
        capability: "search",
        credentialFingerprint: hashYouApiKey(apiKey),
        request: identityRequest,
        // You.com never probes legacy keys — no legacyCandidates.
      };
    },
    async invoke(request: SearchRequest): Promise<readonly SearchSource[]> {
      capability.validate(request);
      const apiKey = requireYouApiKey(env);
      const wire = mapYouSearchRequest(request);
      const raw = await fetchYouSearch(apiKey, wire, transport);
      return normalizeYouSearchResults(raw);
    },
  };
  return capability;
}

// ---------------------------------------------------------------------------
// Reader Capability
// ---------------------------------------------------------------------------

/** Options the You.com Reader does NOT accept (Z.AI-only booleans).
 * Mirrors the Exa reader's rejection list. */
const UNSUPPORTED_READER_OPTIONS = [
  "withLinksSummary",
  "noGfm",
  "keepImgDataUrl",
  "withImagesSummary",
] as const;

function assertHttpUrl(url: unknown): asserts url is string {
  if (typeof url !== "string" || url.length === 0) {
    throw new ValidationError("You.com reader URL must be a non-empty string");
  }
  if (!/^https?:\/\//.test(url)) {
    throw new ValidationError("URL must start with http:// or https://");
  }
}

function assertNoUnsupportedReaderOptions(request: ReaderFetchRequest): void {
  for (const key of UNSUPPORTED_READER_OPTIONS) {
    if (request[key] === true) {
      throw new UnsupportedOptionError("you", "reader", key);
    }
  }
  // You.com /contents speaks markdown only; a text projection has no
  // native field and is not silently downgraded (SPEC §4 — reject
  // reader options this adapter cannot map; fallback reaches a
  // text-capable Provider).
  if (request.format === "text") {
    throw new UnsupportedOptionError("you", "reader", "format");
  }
}

/**
 * Map a `ReaderFetchRequest` onto a You.com-native contents request.
 * The CLI `--timeout` is in seconds; You.com's `crawl_timeout` shares
 * that unit (SCHEMA example `crawl_timeout: 15`), so the value passes
 * through unchanged.
 */
function mapYouContentsRequest(request: ReaderFetchRequest): YouContentsWireRequest {
  const wire: {
    urls: readonly string[];
    formats: readonly ("markdown" | "html" | "metadata")[];
    crawl_timeout?: number;
  } = {
    urls: [request.url],
    formats: ["markdown"],
  };
  if (
    typeof request.timeout === "number" &&
    Number.isFinite(request.timeout) &&
    request.timeout > 0
  ) {
    wire.crawl_timeout = request.timeout;
  }
  return wire;
}

/**
 * Normalize a raw You.com `/contents` response (array of page entries)
 * into a `ReaderFetchResult`.
 *
 * A null/empty `markdown` means the page failed to scrape (anti-bot,
 * paywall, 404) and is a terminal `ApiError` — never an empty-content
 * success (the Reader contract requires non-empty `content`; empty is
 * an error, not a degenerate hit). The entry whose `url` matches the
 * requested URL is used; the sole entry is accepted even on a URL
 * mismatch to absorb You.com-side URL normalization.
 *
 * Field mapping:
 *   entry.markdown -> content
 *   entry.url      -> finalUrl (fallback: request.url)
 *   entry.title    -> title (coerce blank -> null)
 *   request.url    -> url
 */
function normalizeYouContentsResult(
  raw: unknown,
  request: ReaderFetchRequest,
): ReaderFetchResult {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ApiError("You.com contents returned a malformed response", 500);
  }
  const entry =
    raw.find(
      (r): r is Record<string, unknown> => isPlainObject(r) && r.url === request.url,
    ) ?? (isPlainObject(raw[0]) ? (raw[0] as Record<string, unknown>) : null);
  if (!entry) {
    throw new ApiError("You.com contents returned a malformed response", 500);
  }
  const content = entry.markdown;
  if (typeof content !== "string" || content.length === 0) {
    // Per-URL failure: You.com returns HTTP 200 with `markdown: null`.
    throw new ApiError("You.com contents request failed", 500);
  }
  const finalUrl =
    typeof entry.url === "string" && entry.url.length > 0 ? entry.url : request.url;
  const rawTitle = typeof entry.title === "string" ? entry.title.trim() : "";
  const title: string | null = rawTitle.length > 0 ? rawTitle : null;
  return {
    schemaVersion: 1,
    url: request.url,
    finalUrl,
    title,
    content,
    contentFormat: "markdown",
  };
}

/** Options the You.com Reader Capability binds at construction time. */
interface YouReaderCapabilityOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly transport?: YouTransportDeps;
}

function createYouReaderCapability(options: YouReaderCapabilityOptions): YouReaderCapability {
  const { env, transport } = options;

  const fetchOp: YouReaderFetchOperation = {
    kind: "reader-fetch",

    validate(request: ReaderFetchRequest): void {
      assertHttpUrl(request.url);
      assertNoUnsupportedReaderOptions(request);
    },

    cacheIdentity(request: ReaderFetchRequest): YouReaderCacheIdentity {
      // Metadata-only: resolves the key from the environment and
      // fingerprints it; performs no transport call.
      const apiKey = requireYouApiKey(env);
      return {
        provider: "you",
        capability: "reader",
        operation: "reader-fetch",
        credentialFingerprint: hashYouApiKey(apiKey),
        request,
        legacyCandidates: [],
      };
    },

    decodeCached(value: unknown): ReaderFetchResult | null {
      return decodeReaderFetchResult(value);
    },

    async invoke(request: ReaderFetchRequest): Promise<ReaderFetchResult> {
      fetchOp.validate(request);
      const apiKey = requireYouApiKey(env);
      const raw = await fetchYouContents(apiKey, mapYouContentsRequest(request), transport);
      return normalizeYouContentsResult(raw, request);
    },
  };

  return { fetch: fetchOp };
}

// ---------------------------------------------------------------------------
// Research Capability
// ---------------------------------------------------------------------------

/**
 * Map `model` onto the You.com-native `research_effort` tier. The
 * result echoes the REQUESTED model (not the effort string) so the
 * contract is identical across research providers.
 */
const MODEL_TO_RESEARCH_EFFORT: Readonly<
  Record<"mini" | "pro" | "auto", "lite" | "deep" | "standard">
> = {
  mini: "lite",
  pro: "deep",
  auto: "standard",
};

/**
 * Map a Provider-neutral research request onto a You.com-native wire
 * request. `outputLength` and `citationFormat` have no You.com-native
 * fields — `validate` rejects them so option-level fallback reaches a
 * Provider that can honor them (SPEC §4). `domain` maps onto
 * `source_control.include_domains`.
 */
function mapYouResearchRequest(request: ResearchRequest): YouResearchWireRequest {
  const wire: {
    input: string;
    research_effort?: "lite" | "deep" | "standard";
    source_control?: { include_domains: readonly string[] };
  } = { input: request.query };
  if (request.model !== undefined) {
    wire.research_effort = MODEL_TO_RESEARCH_EFFORT[request.model];
  }
  if (request.domain) {
    wire.source_control = { include_domains: [request.domain] };
  }
  return wire;
}

/**
 * Normalize a raw You.com research response into a `ResearchResult`.
 *
 *   output.content        -> report
 *   output.sources[]      -> sources[] ({title, url}; drop incomplete)
 *   request.model         -> model (echoed; defaults "auto")
 */
function normalizeYouResearchResult(raw: unknown, request: ResearchRequest): ResearchResult {
  if (!isPlainObject(raw)) {
    throw new ApiError("You.com research returned a malformed response", 500);
  }
  const output = raw.output;
  if (!isPlainObject(output)) {
    throw new ApiError("You.com research returned a malformed response", 500);
  }
  const report = output.content;
  if (typeof report !== "string") {
    throw new ApiError("You.com research returned a malformed response", 500);
  }

  const sources: ResearchSource[] = [];
  const wireSources = output.sources;
  if (Array.isArray(wireSources)) {
    for (const entry of wireSources) {
      if (!isPlainObject(entry)) continue;
      if (typeof entry.title === "string" && typeof entry.url === "string") {
        sources.push({ title: entry.title, url: entry.url });
      }
    }
  }

  return {
    schemaVersion: 1,
    query: request.query,
    model: request.model ?? "auto",
    report,
    sources,
  };
}

/** Options the You.com Research Capability binds at construction time. */
interface YouResearchCapabilityOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly transport?: YouTransportDeps;
}

function createYouResearchCapability(options: YouResearchCapabilityOptions): YouResearchCapability {
  const { env, transport } = options;

  const run: YouResearchOperation = {
    kind: "research-fetch",

    validate(request: ResearchRequest): void {
      if (!request || typeof request.query !== "string" || request.query.trim() === "") {
        throw new ValidationError(
          "Research query must contain at least one non-whitespace character",
        );
      }
      // outputLength / citationFormat have no You.com-native fields —
      // reject so provider fallback can reach a Provider that honors
      // them (SPEC §4). model and domain are consumed.
      if (request.outputLength !== undefined) {
        throw new UnsupportedOptionError("you", "research", "outputLength");
      }
      if (request.citationFormat !== undefined) {
        throw new UnsupportedOptionError("you", "research", "citationFormat");
      }
    },

    cacheIdentity(request: ResearchRequest): YouResearchCacheIdentity {
      // Metadata-only: resolves the key from the environment and
      // fingerprints it; performs no transport call.
      const apiKey = requireYouApiKey(env);
      return {
        provider: "you",
        capability: "research",
        credentialFingerprint: hashYouApiKey(apiKey),
        request,
      };
    },

    decodeCached(value: unknown): ResearchResult | null {
      return decodeResearchResult(value);
    },

    async invoke(request: ResearchRequest): Promise<ResearchResult> {
      // You.com research is synchronous (single POST) and billable —
      // shared execution already sets maxRetries: 0 for research, and
      // this method never retries internally (SPEC §4).
      run.validate(request);
      const apiKey = requireYouApiKey(env);
      const raw = await fetchYouResearch(apiKey, mapYouResearchRequest(request), transport);
      return normalizeYouResearchResult(raw, request);
    },
  };

  return { run };
}

// ---------------------------------------------------------------------------
// Descriptor factory
// ---------------------------------------------------------------------------
/**
 * Build the You.com Provider Descriptor. Construction is
 * side-effect-free; `create()` captures the injected environment but
 * reads no credentials, constructs no transport, and performs no I/O —
 * credential resolution and transport calls happen only inside
 * Capability invocation after validation.
 */
export function createYouDescriptor(dependencies?: YouAdapterDependencies): YouDescriptor {
  const transport = dependencies?.transport;
  return {
    id: "you",
    isConfigured(env: NodeJS.ProcessEnv): boolean {
      return isYouConfigured(env);
    },
    capabilities(): ReadonlySet<ProviderCapability> {
      // Advertises exactly the slots the created Adapter supplies:
      // search, reader, research, diagnostics — nothing else.
      return new Set<ProviderCapability>(["search", "reader", "research", "diagnostics"]);
    },
    create(context: ProviderContext): YouAdapter {
      const search = createYouSearchCapability({
        env: context.env,
        transport,
      });
      const reader = createYouReaderCapability({
        env: context.env,
        transport,
      });
      const research = createYouResearchCapability({
        env: context.env,
        transport,
      });
      const diagnostics: DiagnosticsCapability = createYouDiagnosticsCapability({
        env: context.env,
        transport,
      });
      return { id: "you", search, reader, research, diagnostics };
    },
    credentialEnvVars: ["YDC_API_KEY", "YOU_API_KEY"],
  };
}
