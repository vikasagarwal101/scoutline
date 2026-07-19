/**
 * Provider Types (DESIGN.md §5, PRD FR-001, FR-004, NFR-004, NFR-010).
 *
 * This module defines the static shape of a Provider: a stable ID, the
 * set of Capabilities it advertises, and a factory that produces an
 * Adapter bound to a Provider context. No transport, no I/O, no
 * credential reads occur outside Capability invocation.
 *
 * Phase 2 (P2-01) declares only the Search Capability; Phase 3 (P3-01)
 * adds the `vision?: VisionCapability` slot on `ProviderAdapter` and
 * declares the matching descriptor metadata. Quota and diagnostics
 * attach to the `ProviderAdapter` interface in later phases. The
 * `ProviderCapability` union already enumerates them so descriptor
 * metadata stays forward-compatible.
 *
 * `BUILT_IN_PROVIDER_DESCRIPTORS` is intentionally empty in this stub
 * file; the production registry waits for P2-05, after both real
 * Search Adapters exist. Selection functions and tests operate on
 * explicit descriptor lists through `getProviderDescriptor` and
 * `getConfiguredProviderDescriptors`.
 */

import type { SearchCapability } from "../capabilities/search.js";
import type { VisionCapability } from "../capabilities/vision.js";
import type { QuotaCapability } from "../capabilities/quota.js";
import type { DiagnosticsCapability } from "../capabilities/diagnostics.js";
import type { RepositoryCapability } from "../capabilities/repository.js";

// ---------------------------------------------------------------------------
// Provider identity
// ---------------------------------------------------------------------------

/**
 * Built-in Provider IDs. Adding a new Provider is a Phase 2+ decision;
 * new entries must come with a real Adapter and conformance coverage.
 */
export const PROVIDER_IDS = ["zai", "minimax"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

/**
 * The set of Capability names a Provider may advertise. Phase 2
 * declares the full union so descriptor metadata stays forward-compatible
 * with Phase 3+ Adapters, but only `search` is wired into the
 * `ProviderAdapter` shape today.
 *
 * P6-06 adds `repository-exploration`: a descriptor advertises it iff
 * the Adapter it creates supplies `adapter.repository`. Z.AI advertises
 * it (P6-04 supplies the handle); MiniMax does not and remains free of
 * repository credential, transport, and fallback work until it ships
 * its own Adapter and conformance fixtures.
 */
export type ProviderCapability =
  | "search"
  | "vision.interpret-image"
  | "vision.ui-artifact"
  | "vision.extract-text"
  | "vision.diagnose-error"
  | "vision.diagram"
  | "vision.chart"
  | "vision.diff"
  | "vision.video"
  | "quota"
  | "diagnostics"
  | "repository-exploration";

// ---------------------------------------------------------------------------
// Provider context and Adapter
// ---------------------------------------------------------------------------

/**
 * Injected Provider context. Adapters capture but do not immediately
 * inspect this; credential resolution and transport construction happen
 * only inside Capability invocation after validation.
 */
export interface ProviderContext {
  readonly env: NodeJS.ProcessEnv;
}

/**
 * Provider Adapter contract (Phase 3 shape). Each Capability that the
 * Provider supports becomes a property on this interface. Phase 4 adds
 * `quota?: QuotaCapability` and `diagnostics?: DiagnosticsCapability`.
 * Phase 6 adds `repository?: RepositoryCapability` (P6-04), and P6-06
 * advertises `repository-exploration` in descriptor metadata so
 * Provider selection and Doctor inventory derive from a single source
 * of truth — the slot here is the implementation handle the future
 * Explorer layer (P6-05+) reaches through.
 */
export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly search?: SearchCapability;
  readonly vision?: VisionCapability;
  readonly quota?: QuotaCapability;
  readonly diagnostics?: DiagnosticsCapability;
  readonly repository?: RepositoryCapability;
}

// ---------------------------------------------------------------------------
// Provider descriptor: pure metadata + side-effect-free creation
// ---------------------------------------------------------------------------

/**
 * Provider Descriptor. `capabilities()` and `isConfigured()` construct
 * no Adapter or transport. `create()` is side-effect-free: it captures
 * the injected environment but shall not read credentials, inspect
 * media, construct a transport, or perform I/O. Credential resolution
 * and transport construction are allowed only inside Capability
 * invocation after validation.
 */
export interface ProviderDescriptor {
  readonly id: ProviderId;
  isConfigured(env: NodeJS.ProcessEnv): boolean;
  capabilities(): ReadonlySet<ProviderCapability>;
  create(context: ProviderContext): ProviderAdapter;
}

/**
 * Built-in Provider registry. Phase 2 leaves this empty; P2-05 wires
 * the real Z.AI and MiniMax descriptors once both Adapters exist. Tests
 * inject descriptor lists explicitly through `getProviderDescriptor` and
 * `getConfiguredProviderDescriptors`; the production registry is static
 * and never accepts package names, file paths, or dynamic imports.
 */
export const BUILT_IN_PROVIDER_DESCRIPTORS: readonly ProviderDescriptor[] = [];

/**
 * Look up a descriptor by ID. Throws when the ID is unknown. The
 * optional `descriptors` parameter lets tests inject doubles; production
 * uses the static built-in list.
 */
export function getProviderDescriptor(
  id: ProviderId,
  descriptors?: readonly ProviderDescriptor[],
): ProviderDescriptor {
  const list = descriptors ?? BUILT_IN_PROVIDER_DESCRIPTORS;
  const descriptor = list.find((d) => d.id === id);
  if (!descriptor) {
    throw new Error(`Unknown provider "${id}". Built-in providers: ${PROVIDER_IDS.join(", ")}.`);
  }
  return descriptor;
}

/**
 * Return the descriptors that are configured for the given environment.
 * Configuration is purely metadata-driven and never constructs an
 * Adapter.
 */
export function getConfiguredProviderDescriptors(
  env: NodeJS.ProcessEnv,
  descriptors?: readonly ProviderDescriptor[],
): readonly ProviderDescriptor[] {
  const list = descriptors ?? BUILT_IN_PROVIDER_DESCRIPTORS;
  return list.filter((d) => d.isConfigured(env));
}

// ---------------------------------------------------------------------------
// Injectable ports: UTCP and Z.AI MCP client surfaces used by Adapters
// ---------------------------------------------------------------------------

/**
 * Narrow UTCP client surface used by Adapters. Production code passes
 * `UtcpClient.create()` factories wrapped to this shape; tests inject
 * doubles with the same surface.
 */
export interface UtcpClientPort {
  registerManual(template: unknown): Promise<{
    success: boolean;
    errors: string[];
  }>;
  getTools(): Promise<unknown[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

/**
 * Z.AI MCP client options. `utcpFactory` is the existing P0-02 injection
 * seam; `noCache` and `disableRetry` arrive in P2-03 so Adapters can
 * hand policy to shared execution.
 */
export interface ZaiMcpClientOptions {
  readonly enableVision?: boolean;
  readonly noCache?: boolean;
  readonly disableRetry?: boolean;
  readonly utcpFactory?: () => Promise<UtcpClientPort>;
}

/**
 * Legacy Z.AI search parameters as accepted by `ZaiMcpClient.webSearch`.
 * Preserved by the Adapter so legacy cache keys remain reconstructible.
 */
export interface LegacyZaiSearchParams {
  query: string;
  count?: number;
  domainFilter?: string;
  recencyFilter?: "oneDay" | "oneWeek" | "oneMonth" | "oneYear" | "noLimit";
  contentSize?: "medium" | "high";
  location?: "cn" | "us";
}

/** Result envelope produced by `ZaiMcpClient.webSearch`. */
export interface WebSearchResult {
  refer: string;
  title: string;
  link: string;
  media: string;
  content: string;
  icon: string;
  publish_date?: string;
}

/**
 * Legacy direct Z.AI search client surface used while P2-03 ships. P2-03
 * replaces this with a real Adapter; P2-05 removes it.
 */
export interface LegacySearchClientPort {
  webSearch(params: LegacyZaiSearchParams): Promise<WebSearchResult[]>;
  close(): Promise<void>;
}

/**
 * Injectable fetch response for quota transports (duck-typed). The
 * injected fetch returns this minimal shape so tests pass a plain object
 * without depending on the DOM `Response` type.
 */
export interface ProviderQuotaFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

export type ProviderQuotaFetch = (
  input: string | URL,
  init: Record<string, unknown>,
) => Promise<ProviderQuotaFetchResponse>;

/** Dependencies the Phase 2 Search wiring would inject into the registry. */
export interface SearchDependencies {
  clientFactory(options: ZaiMcpClientOptions): LegacySearchClientPort;
}

/**
 * Narrow surface a Z.AI Search Adapter uses from `ZaiMcpClient`. The
 * Adapter only invokes raw tools; cache and retry policy live in shared
 * execution. `listTools` is the tool-discovery surface the Z.AI
 * diagnostics capability probes (DESIGN.md §14).
 */
export interface ZaiAdapterClientPort {
  callToolRaw<T>(name: string, args: Record<string, unknown>): Promise<T>;
  listTools(): Promise<unknown[]>;
  close(): Promise<void>;
}

/** Dependencies the Z.AI Search Adapter accepts through injection. */
export interface ZaiAdapterDependencies {
  clientFactory(options: ZaiMcpClientOptions): ZaiAdapterClientPort;
  /** Optional Z.AI quota-monitor transport injection (tests). */
  readonly quotaFetch?: ProviderQuotaFetch;
  readonly quotaSetTimeout?: typeof setTimeout;
  readonly quotaClearTimeout?: typeof clearTimeout;
  /**
   * Optional Repository Capability close-bound override in
   * milliseconds (P6-04A). When omitted, the production default of
   * 2000 ms (matching `ZaiMcpClient.close`) applies. Tests inject a
   * shorter bound to keep the never-resolving-close test bounded
   * below the production default.
   */
  readonly repositoryCloseTimeoutMs?: number;
}

/**
 * Dependencies the MiniMax Adapter accepts. `sdkConstructor` is the
 * only escape hatch tests need; production never passes it.
 */
export interface MiniMaxAdapterDependencies {
  readonly sdkConstructor?: MiniMaxSdkConstructor;
  /** Optional MiniMax direct quota transport injection (tests). */
  readonly quotaFetch?: ProviderQuotaFetch;
  readonly quotaSetTimeout?: typeof setTimeout;
  readonly quotaClearTimeout?: typeof clearTimeout;
  /**
   * Optional injection point for the specialized-vision support check
   * (`MiniMaxAdapterDependencies.isSpecializedVisionOperationSupported`).
   * Production never sets this; tests pass a forced-support function so
   * the routing branch can be exercised deterministically without
   * flipping a compiled registry attestation. When omitted, the Adapter
   * delegates to the compiled conformance registry query.
   */
  readonly isSpecializedVisionOperationSupported?: (
    operation: import("./minimax/vision-conformance.js").SpecializedVisionOperation,
  ) => boolean;
}

/**
 * MiniMax SDK constructor type. Kept here so Adapter Modules do not
 * import `mmx-cli/sdk` directly; only `providers/minimax/sdk-client.ts`
 * references the implementation.
 */
export interface MiniMaxSdkConstructor {
  new (options: { apiKey: string; region: "global" | "cn"; baseUrl: string }): MiniMaxSdkPort;
}

/** Narrow MiniMax SDK surface used by the Adapter. */
export interface MiniMaxSdkPort {
  search: {
    query(query: string): Promise<unknown>;
  };
  vision: {
    describe(request: { image: string; prompt?: string }): Promise<unknown>;
  };
}

// ---------------------------------------------------------------------------
// Descriptor factories
// ---------------------------------------------------------------------------

/**
 * Build the Z.AI Provider Descriptor. Phase 2 returns a stub that
 * advertises the search Capability; P2-03 supplies the real Adapter.
 * P3-01 extends the capability set with every current Vision operation
 * so descriptor metadata advertises the Capability before any Adapter
 * is constructed; the real `vision` slot arrives in P3-03.
 *
 * The stub keeps the Provider registerable from day one while the
 * Search Adapter is implemented in P2-03. Throwing inside `create()`
 * surfaces the unfinished Adapter during testing rather than silently
 * failing later.
 */
export function createZaiDescriptor(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  dependencies?: ZaiAdapterDependencies,
): ProviderDescriptor {
  return {
    id: "zai",
    isConfigured(env) {
      const key = env.Z_AI_API_KEY;
      return typeof key === "string" && /\S/.test(key);
    },
    capabilities() {
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
        "diagnostics",
      ]);
    },
    create() {
      throw new Error("Z.AI Search Adapter is not yet implemented; arrives in P2-03.");
    },
  };
}

/**
 * Build the MiniMax Provider Descriptor. Phase 2 returns a stub that
 * advertises the search Capability; P2-04 supplies the real Adapter.
 * P3-01 advertises the general `vision.interpret-image` Capability
 * while leaving every specialized operation out until Phase 5
 * attests individual specialized mappings.
 */
export function createMiniMaxDescriptor(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  dependencies?: MiniMaxAdapterDependencies,
): ProviderDescriptor {
  return {
    id: "minimax",
    isConfigured(env) {
      const key = env.MINIMAX_API_KEY;
      return typeof key === "string" && /\S/.test(key);
    },
    capabilities() {
      return new Set<ProviderCapability>(["search", "vision.interpret-image", "diagnostics"]);
    },
    create() {
      throw new Error("MiniMax Search Adapter is not yet implemented; arrives in P2-04.");
    },
  };
}
