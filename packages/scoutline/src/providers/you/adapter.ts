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
import { ApiError, UnsupportedOptionError, ValidationError } from "../../lib/errors.js";
import { applySearchTopic } from "../../lib/search-topic.js";
import { hashYouApiKey, isYouConfigured, requireYouApiKey } from "./credentials.js";
import { fetchYouSearch } from "./client.js";
import type { YouSearchWireRequest, YouTransportDeps } from "./client.js";

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
export type YouAdapter = Omit<ProviderAdapter, "id" | "search"> & {
  readonly id: "you";
  readonly search: YouSearchCapability;
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
      // Advertises exactly the slots the created Adapter supplies;
      // Reader, Research, and Diagnostics join as their handles land.
      return new Set<ProviderCapability>(["search"]);
    },
    create(context: ProviderContext): YouAdapter {
      const search = createYouSearchCapability({
        env: context.env,
        transport,
      });
      return { id: "you", search };
    },
    credentialEnvVars: ["YDC_API_KEY", "YOU_API_KEY"],
  };
}
