/**
 * Linkup Provider Adapter.
 *
 * Implements the Linkup Provider Descriptor with the Search capability
 * on top of the direct-HTTP transport (`./client.ts`). The Adapter owns
 * credentials, transport lifecycle, Provider field mapping, and failure
 * normalization; shared execution owns cache and retry policy.
 *
 * Structurally cloned from `providers/tavily/adapter.ts` (Tavily/Parallel
 * research-poll analog, IMPLEMENTATION-CONTRACT analog-adapter table).
 *
 * Boundary rules (ARCHITECTURE.md §2):
 *   - May import capability types, normalized errors, Provider identity
 *     types, and the Adapter-local credential and transport Modules.
 *   - Must NOT import command presentation, output mode, or another
 *     Provider's Adapter.
 *
 * Field mapping (Linkup wire → normalized):
 *   Search results[].name    -> title
 *   Search results[].url     -> url
 *   Search results[].content -> summary (falls back to snippet)
 *   Search results[].favicon -> (dropped)
 *   Search results[].type    -> (dropped)
 *
 * Control mapping (SearchControls → Linkup-native API params):
 *   domain      -> includeDomains: [domain]
 *   recency     -> fromDate/toDate ISO date window (oneDay/oneWeek/
 *                  oneMonth/oneYear; noLimit omits dates)
 *   contentSize -> depth (high→"deep", medium/absent→"standard")
 *   topic       -> keyword appended to q
 *   location    -> locale keyword appended to q
 *   type        -> REJECTED (UnsupportedOptionError)
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
import { hashLinkupApiKey, isLinkupConfigured, requireLinkupApiKey } from "./credentials.js";
import {
  fetchLinkupSearch,
  type LinkupSearchWireRequest,
  type LinkupTransportDeps,
} from "./client.js";

/**
 * Dependencies the Linkup Adapter accepts. The unified `transport`
 * seam carries `fetch` and timer injection; `now` makes the
 * recency→date window deterministic in tests.
 */
export interface LinkupAdapterDependencies {
  /** Optional transport injection (fetch, timers, env). */
  readonly transport?: LinkupTransportDeps;
  /**
   * Injectable clock for the recency→fromDate window. Defaults to
   * `Date.now`; tests pass a fixed epoch.
   */
  readonly now?: () => number;
}

// ---------------------------------------------------------------------------
// Provider-owned credential fingerprint
// ---------------------------------------------------------------------------

function credentialFingerprint(apiKey: string): string {
  return hashLinkupApiKey(apiKey);
}

function resolveApiKey(env: NodeJS.ProcessEnv): string {
  return requireLinkupApiKey(env);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Control mapping (SearchControls → Linkup-native API params)
// ---------------------------------------------------------------------------

/**
 * Map a `SearchRecency` to a `fromDate`/`toDate` ISO 8601 date window
 * (YYYY-MM-DD). `noLimit` (and unknown values) return `undefined` so
 * no date fields are sent.
 */
function mapRecencyToDateWindow(
  recency: SearchRecency,
  now: () => number,
): { fromDate: string; toDate: string } | undefined {
  const current = new Date(now());
  const from = new Date(now());
  switch (recency) {
    case "oneDay":
      from.setDate(from.getDate() - 1);
      break;
    case "oneWeek":
      from.setDate(from.getDate() - 7);
      break;
    case "oneMonth":
      from.setMonth(from.getMonth() - 1);
      break;
    case "oneYear":
      from.setFullYear(from.getFullYear() - 1);
      break;
    default:
      return undefined;
  }
  return {
    fromDate: from.toISOString().slice(0, 10),
    toDate: current.toISOString().slice(0, 10),
  };
}

/**
 * Map a Provider-neutral `SearchRequest` into a Linkup-native wire
 * request body.
 *
 *   q             -> q (with topic/location keywords appended)
 *   domain        -> includeDomains: [domain]
 *   recency       -> fromDate/toDate date window
 *   contentSize   -> depth (high→"deep", else "standard")
 */
function mapSearchControls(request: SearchRequest, now: () => number): LinkupSearchWireRequest {
  const controls: Readonly<SearchControls> | undefined = request.controls;
  const payload: {
    q: string;
    depth: "standard" | "deep";
    includeDomains?: readonly string[];
    fromDate?: string;
    toDate?: string;
  } = {
    q: request.query,
    depth: controls?.contentSize === "high" ? "deep" : "standard",
  };
  if (controls?.domain) {
    payload.includeDomains = [controls.domain];
  }
  if (controls?.recency) {
    const window = mapRecencyToDateWindow(controls.recency, now);
    if (window) {
      payload.fromDate = window.fromDate;
      payload.toDate = window.toDate;
    }
  }
  // Topic and location have no native Linkup field; they are injected
  // as keyword terms into the query (same pattern as Z.AI/MiniMax
  // topic handling).
  if (controls?.topic) {
    payload.q = `${payload.q} ${controls.topic}`;
  }
  if (controls?.location) {
    payload.q = `${payload.q} ${controls.location}`;
  }
  return payload;
}

// ---------------------------------------------------------------------------
// Response normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a raw Linkup search response into `SearchSource[]`.
 *
 *   results[].name    -> title (missing → "")
 *   results[].url     -> url
 *   results[].content -> summary (falls back to snippet, then "")
 *   results[].favicon -> (dropped)
 *   results[].type    -> (dropped)
 *
 * Any malformed shape is a retryable `ApiError` 500.
 */
function normalizeLinkupSearchResults(raw: unknown): readonly SearchSource[] {
  if (!isPlainObject(raw)) {
    throw new ApiError("Linkup search returned a malformed response", 500);
  }
  const results = raw.results;
  if (!Array.isArray(results)) {
    throw new ApiError("Linkup search returned a malformed response", 500);
  }
  const out: SearchSource[] = [];
  for (const entry of results) {
    if (!isPlainObject(entry)) {
      throw new ApiError("Linkup search returned a malformed response", 500);
    }
    const url = entry.url;
    if (typeof url !== "string") {
      throw new ApiError("Linkup search returned a malformed response", 500);
    }
    const title = typeof entry.name === "string" ? entry.name : "";
    const summary =
      typeof entry.content === "string"
        ? entry.content
        : typeof entry.snippet === "string"
          ? entry.snippet
          : "";
    out.push({ title, url, summary, source: "linkup" });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Search Capability
// ---------------------------------------------------------------------------

interface LinkupSearchCapabilityOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly transport?: LinkupTransportDeps;
  readonly now: () => number;
}

function createLinkupSearchCapability(
  options: LinkupSearchCapabilityOptions,
): SearchCapability {
  const { env, transport, now } = options;

  const capability: SearchCapability = {
    validate(request: SearchRequest): void {
      if (!request || typeof request.query !== "string" || request.query.trim() === "") {
        throw new ValidationError(
          "Search query must contain at least one non-whitespace character",
        );
      }
      // Linkup supports domain, recency, contentSize, topic, and
      // location (as query keywords). type (video content axis) is not
      // supported by Linkup (Brave supplies video), so it is rejected
      // before any credential resolution or transport call.
      if (request.controls?.type !== undefined) {
        throw new UnsupportedOptionError("linkup", "search", "type");
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
        provider: "linkup",
        capability: "search",
        credentialFingerprint: credentialFingerprint(apiKey),
        request: identityRequest,
        // Linkup never probes legacy keys — no legacyCandidates.
      };
    },

    async invoke(request: SearchRequest): Promise<readonly SearchSource[]> {
      capability.validate(request);

      const apiKey = resolveApiKey(env);
      const wireRequest = mapSearchControls(request, now);
      const raw = await fetchLinkupSearch(apiKey, wireRequest, transport);
      return normalizeLinkupSearchResults(raw);
    },
  };

  return capability;
}

// ---------------------------------------------------------------------------
// Descriptor factory
// ---------------------------------------------------------------------------

/**
 * Build the Linkup Provider Descriptor. The descriptor advertises the
 * capabilities the constructed Adapter supplies and constructs an
 * Adapter whose Search Capability owns credentials, transport,
 * Provider field mapping, and failure normalization. Construction is
 * side-effect-free; the transport is invoked per Capability call.
 * Tests pass `transport` (typically a fake-fetch wrapper); production
 * uses the no-argument factory which resolves to the global `fetch`
 * and timers inside the transport Module.
 */
export function createLinkupDescriptor(
  dependencies?: LinkupAdapterDependencies,
): ProviderDescriptor {
  const transport = dependencies?.transport;
  const now = dependencies?.now ?? (() => Date.now());

  return {
    id: "linkup",
    isConfigured(env: NodeJS.ProcessEnv): boolean {
      return isLinkupConfigured(env);
    },
    capabilities(): ReadonlySet<ProviderCapability> {
      return new Set<ProviderCapability>(["search"]);
    },
    create(context: ProviderContext): ProviderAdapter {
      const search = createLinkupSearchCapability({
        env: context.env,
        transport,
        now,
      });
      return { id: "linkup", search };
    },
    credentialEnvVars: ["LINKUP_API_KEY"],
  };
}
