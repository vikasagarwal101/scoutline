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

import type {
  ProviderAdapter,
  ProviderCapability,
  ProviderContext,
  ProviderDescriptor,
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
import {
  ApiError,
  AuthError,
  NetworkError,
  TimeoutError,
  ValidationError,
} from "../../lib/errors.js";
import { getMcpToolName } from "../../lib/mcp-config.js";
import {
  ZaiMcpClient,
  type ZaiMcpClientOptions as McpClientOptions,
} from "../../lib/mcp-client.js";
import { buildCacheKey } from "../../lib/cache.js";

const SEARCH_TOOL_PUBLIC_NAME = getMcpToolName("search", "web_search_prime");

// ---------------------------------------------------------------------------
// Provider-owned legacy cache candidate
// ---------------------------------------------------------------------------

/**
 * Build the legacy Z.AI cache key for a request. The shape mirrors the
 * pre-P2-05 `buildCacheKey` calls the search command made through
 * `ZaiMcpClient.webSearch`. `legacyCount` reconstructs the old `count`
 * argument so an existing on-disk entry can still be served.
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
  return buildCacheKey(SEARCH_TOOL_PUBLIC_NAME, args);
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
  readonly clientFactory: ZaiAdapterDependencies["clientFactory"];
}

function createZaiSearchCapability(options: ZaiSearchCapabilityOptions): SearchCapability {
  const { env, clientFactory } = options;

  function resolveApiKey(): string {
    const key = env.Z_AI_API_KEY;
    if (typeof key !== "string" || !/\S/.test(key)) {
      // Validation/credential errors are terminal; surface as AUTH so
      // callers see a clear, normalized failure.
      throw new AuthError("Z.AI API key is not configured");
    }
    return key;
  }

  const capability: SearchCapability = {
    validate(request: SearchRequest): void {
      if (!request || typeof request.query !== "string" || !request.query.trim()) {
        throw new ValidationError(
          "Search query must contain at least one non-whitespace character",
        );
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
        const args = buildZaiSearchArgs(request);
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
 * response bodies, and UTCP stack data are discarded.
 */
function normalizeZaiError(error: unknown): Error {
  if (
    error instanceof AuthError ||
    error instanceof ApiError ||
    error instanceof NetworkError ||
    error instanceof TimeoutError ||
    error instanceof ValidationError
  ) {
    return error;
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
    return new TimeoutError(parseInt(process.env.Z_AI_TIMEOUT || "30000", 10));
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

function inferStatusCode(lower: string): number {
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
// Descriptor factory
// ---------------------------------------------------------------------------

/**
 * Default Z.AI client factory bound to {@link ZaiMcpClient}. Tests inject
 * a fake factory through {@link createZaiDescriptor}'s dependencies.
 */
function defaultZaiClientFactory(options: ZaiMcpClientOptions): ZaiAdapterClientPort {
  // The Provider-types `ZaiMcpClientOptions` declares a narrower
  // `utcpFactory` return type (`UtcpClientPort`) than the
  // `ZaiMcpClient` constructor's local interface (`UtcpClient`). The
  // runtime object is structurally compatible — the narrower port is a
  // behavioural subset the client consumes via duck-typing — so we cast
  // at the boundary instead of leaking the SDK type outward.
  const client = new ZaiMcpClient(options as unknown as McpClientOptions);
  // Adapt the rich ZaiMcpClient surface to the narrow
  // ZaiAdapterClientPort the Z.AI Search Adapter needs.
  return {
    callToolRaw<T>(name: string, args: Record<string, unknown>): Promise<T> {
      return client.callToolRaw<T>(name, args);
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
  const clientFactory = dependencies?.clientFactory ?? defaultZaiClientFactory;

  return {
    id: "zai",
    isConfigured(env: NodeJS.ProcessEnv): boolean {
      const key = env.Z_AI_API_KEY;
      return typeof key === "string" && /\S/.test(key);
    },
    capabilities(): ReadonlySet<ProviderCapability> {
      return new Set<ProviderCapability>(["search"]);
    },
    create(context: ProviderContext): ProviderAdapter {
      const search = createZaiSearchCapability({
        env: context.env,
        clientFactory,
      });
      return { id: "zai", search };
    },
  };
}
