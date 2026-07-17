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
  ValidationError,
} from "../../lib/errors.js";
import { getMcpToolName } from "../../lib/mcp-config.js";
import {
  ZaiMcpClient,
  type ZaiMcpClientOptions as McpClientOptions,
} from "../../lib/mcp-client.js";
import { buildCacheKey } from "../../lib/cache.js";
import { isZaiConfigured, requireZaiApiKey } from "./credentials.js";
import { resolveImageSource, resolveVideoSource } from "./media.js";
import { createZaiQuotaCapability, type ZaiQuotaCapabilityOptions } from "./quota.js";
import type { ZaiMonitorFetch } from "./monitor-client.js";

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
// Vision Capability (DESIGN.md §8, §9 — P3-03)
// ---------------------------------------------------------------------------

interface ZaiVisionCapabilityOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly clientFactory: ZaiAdapterDependencies["clientFactory"];
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
      const { toolName, args } = buildZaiVisionInvocation(request);

      // Disable client-owned cache and retry so shared execution is the
      // single policy owner. Vision enables the Z.AI vision MCP server.
      const clientOptions: ZaiMcpClientOptions = {
        enableVision: true,
        noCache: true,
        disableRetry: true,
      };
      const client = clientFactory(clientOptions);
      try {
        const raw = await invokeZaiVision(client, toolName, args);
        return normalizeZaiVisionResult(raw);
      } finally {
        await client.close().catch(() => {});
      }
    },
  };

  return capability;
}

/**
 * Map a discriminated `VisionRequest` to its dedicated Z.AI MCP tool name
 * and arguments, resolving media through the Z.AI media Module. Field
 * names mirror the characterized transport schema (see `mcp-client.ts`
 * and the live discovery fixtures). Optional fields are omitted when
 * absent so the Provider receives the same request shape Phase 1 sent.
 */
function buildZaiVisionInvocation(request: VisionRequest): {
  toolName: string;
  args: Record<string, unknown>;
} {
  switch (request.operation) {
    case "interpret-image":
      return {
        toolName: VISION_ANALYZE_TOOL_PUBLIC_NAME,
        args: {
          image_source: resolveImageSource(request.source),
          prompt: request.instruction,
        },
      };
    case "ui-artifact":
      return {
        toolName: VISION_UI_TO_ARTIFACT_TOOL_PUBLIC_NAME,
        args: {
          image_source: resolveImageSource(request.source),
          output_type: request.outputType,
          prompt: request.instruction,
        },
      };
    case "extract-text": {
      const args: Record<string, unknown> = {
        image_source: resolveImageSource(request.source),
        prompt: request.instruction,
      };
      if (request.programmingLanguage) {
        args.programming_language = request.programmingLanguage;
      }
      return { toolName: VISION_EXTRACT_TEXT_TOOL_PUBLIC_NAME, args };
    }
    case "diagnose-error": {
      const args: Record<string, unknown> = {
        image_source: resolveImageSource(request.source),
        prompt: request.instruction,
      };
      if (request.context) {
        args.context = request.context;
      }
      return { toolName: VISION_DIAGNOSE_ERROR_TOOL_PUBLIC_NAME, args };
    }
    case "diagram": {
      const args: Record<string, unknown> = {
        image_source: resolveImageSource(request.source),
        prompt: request.instruction,
      };
      if (request.diagramType) {
        args.diagram_type = request.diagramType;
      }
      return { toolName: VISION_DIAGRAM_TOOL_PUBLIC_NAME, args };
    }
    case "chart": {
      const args: Record<string, unknown> = {
        image_source: resolveImageSource(request.source),
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
          expected_image_source: resolveImageSource(request.expectedSource),
          actual_image_source: resolveImageSource(request.actualSource),
          prompt: request.instruction,
        },
      };
    case "video":
      return {
        toolName: VISION_VIDEO_TOOL_PUBLIC_NAME,
        args: {
          video_source: resolveVideoSource(request.source),
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
  readonly clientFactory: ZaiAdapterDependencies["clientFactory"];
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
  const clientFactory = dependencies?.clientFactory ?? defaultZaiClientFactory;

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
    capabilities(): ReadonlySet<ProviderCapability> {
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
      ]);
    },
    create(context: ProviderContext): ProviderAdapter {
      const search = createZaiSearchCapability({
        env: context.env,
        clientFactory,
      });
      const vision = createZaiVisionCapability({
        env: context.env,
        clientFactory,
      });
      const quotaOptions: ZaiQuotaCapabilityOptions = { env: context.env, ...quotaTransport };
      const quota = createZaiQuotaCapability(quotaOptions);
      const diagnostics = createZaiDiagnosticsCapability({
        env: context.env,
        clientFactory,
      });
      return { id: "zai", search, vision, quota, diagnostics };
    },
  };
}
