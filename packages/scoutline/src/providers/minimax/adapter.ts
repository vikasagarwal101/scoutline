/**
 * MiniMax Search Adapter (DESIGN.md §5, §7, §12 — P2-04).
 *
 * Implements the real MiniMax Provider Descriptor with Search support
 * on top of the transitional `mmx-cli/sdk`. The Adapter owns
 * credentials, SDK lifecycle, Provider field mapping, and failure
 * normalization; shared execution owns cache and retry policy.
 *
 * Boundary rules (ARCHITECTURE.md §2):
 *   - May import capability types, normalized errors, Provider identity
 *     types, and the Adapter-local SDK client factory.
 *   - Must NOT import `mmx-cli/sdk` directly (only sdk-client.ts does),
 *     command presentation, output mode, or another Provider's Adapter.
 *
 * Field mapping (DESIGN.md §7 MiniMax mapping):
 *   organic[].title   -> title
 *   organic[].link    -> url
 *   organic[].snippet -> summary
 *   organic[].date    -> date (optional)
 *
 * The Adapter sends ONLY the query string to `sdk.search.query`. It
 * NEVER sends count or unsupported controls. MiniMax rejects domain,
 * recency, contentSize, and location controls with
 * `UNSUPPORTED_OPTION` before SDK construction or credential access
 * (FR-012).
 */

import crypto from "node:crypto";

import type {
  MiniMaxAdapterDependencies,
  ProviderAdapter,
  ProviderCapability,
  ProviderContext,
  ProviderDescriptor,
} from "../types.js";
import type {
  SearchCacheIdentity,
  SearchCapability,
  SearchRequest,
  SearchSource,
} from "../../capabilities/search.js";
import {
  ApiError,
  AuthError,
  NetworkError,
  TimeoutError,
  ValidationError,
  UnsupportedOptionError,
} from "../../lib/errors.js";
import { loadMiniMaxConfig } from "./config.js";
import { createMiniMaxSdk } from "./sdk-client.js";

// ---------------------------------------------------------------------------
// Provider-owned credential fingerprint
// ---------------------------------------------------------------------------

function credentialFingerprint(apiKey: string): string {
  return crypto.createHash("sha256").update(apiKey).digest("hex");
}

function resolveApiKey(env: NodeJS.ProcessEnv): string {
  const key = env.MINIMAX_API_KEY;
  if (typeof key !== "string" || key.trim().length === 0) {
    throw new AuthError("MINIMAX_API_KEY is not configured");
  }
  return key;
}

// ---------------------------------------------------------------------------
// Validation (FR-012): reject unsupported controls before any SDK access
// ---------------------------------------------------------------------------

const UNSUPPORTED_CONTROLS = ["domain", "recency", "contentSize", "location"] as const;

function assertNoUnsupportedControls(request: SearchRequest): void {
  const controls = request.controls;
  if (!controls) return;
  for (const key of UNSUPPORTED_CONTROLS) {
    if (controls[key] !== undefined) {
      throw new UnsupportedOptionError("minimax", "search", key);
    }
  }
}

// ---------------------------------------------------------------------------
// Response normalization (DESIGN.md §7 MiniMax mapping)
// ---------------------------------------------------------------------------

function normalizeMiniMaxSearchResults(raw: unknown): readonly SearchSource[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ApiError("MiniMax search returned a malformed response", 500);
  }
  const envelope = raw as { organic?: unknown };
  if (!Array.isArray(envelope.organic)) {
    throw new ApiError("MiniMax search returned a malformed response", 500);
  }
  const out: SearchSource[] = [];
  for (const entry of envelope.organic) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ApiError("MiniMax search returned a malformed response", 500);
    }
    const record = entry as Record<string, unknown>;
    const title = record.title;
    const link = record.link;
    const snippet = record.snippet;
    if (typeof title !== "string" || typeof link !== "string" || typeof snippet !== "string") {
      throw new ApiError("MiniMax search returned a malformed response", 500);
    }
    const source: SearchSource = { title, url: link, summary: snippet };
    if (typeof record.date === "string") {
      source.date = record.date;
    }
    out.push(source);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Failure normalization: stable public codes, no raw payloads
// ---------------------------------------------------------------------------

function inferStatusCode(lower: string): number {
  if (lower.includes("500") || lower.includes("internal")) return 500;
  if (lower.includes("502") || lower.includes("bad gateway")) return 502;
  if (lower.includes("503") || lower.includes("service unavailable")) return 503;
  if (lower.includes("504") || lower.includes("gateway timeout")) return 504;
  return 500;
}

function normalizeMiniMaxError(error: unknown): Error {
  if (
    error instanceof AuthError ||
    error instanceof ApiError ||
    error instanceof NetworkError ||
    error instanceof TimeoutError ||
    error instanceof ValidationError ||
    error instanceof UnsupportedOptionError
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
    return new AuthError("MiniMax authentication failed");
  }
  if (lower.includes("timeout") || lower.includes("timed out") || lower.includes("etimedout")) {
    return new TimeoutError(parseInt(process.env.MINIMAX_TIMEOUT || "30000", 10));
  }
  if (
    lower.includes("econnrefused") ||
    lower.includes("econnreset") ||
    lower.includes("network") ||
    lower.includes("enotfound") ||
    lower.includes("fetch failed")
  ) {
    return new NetworkError("MiniMax network error");
  }
  if (lower.includes("429") || lower.includes("rate limit")) {
    return new ApiError("MiniMax rate limit exceeded", 429);
  }
  return new ApiError("MiniMax search request failed", inferStatusCode(lower));
}

// ---------------------------------------------------------------------------
// Search Capability
// ---------------------------------------------------------------------------

interface MiniMaxSearchCapabilityOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly sdkConstructor?: MiniMaxAdapterDependencies["sdkConstructor"];
}

function createMiniMaxSearchCapability(options: MiniMaxSearchCapabilityOptions): SearchCapability {
  const { env, sdkConstructor } = options;

  const capability: SearchCapability = {
    validate(request: SearchRequest): void {
      if (!request || typeof request.query !== "string" || request.query.trim() === "") {
        throw new ValidationError(
          "Search query must contain at least one non-whitespace character",
        );
      }
      assertNoUnsupportedControls(request);
    },

    cacheIdentity(request: SearchRequest): SearchCacheIdentity {
      const apiKey = resolveApiKey(env);
      const identityRequest: { query: string; controls?: SearchRequest["controls"] } = {
        query: request.query,
      };
      if (request.controls) {
        identityRequest.controls = request.controls;
      }
      return {
        provider: "minimax",
        capability: "search",
        credentialFingerprint: credentialFingerprint(apiKey),
        request: identityRequest,
        // MiniMax never probes legacy keys — no legacyCandidates.
      };
    },

    async invoke(request: SearchRequest): Promise<readonly SearchSource[]> {
      // Validate before any credential access or SDK construction.
      capability.validate(request);

      const config = loadMiniMaxConfig(env);
      try {
        const sdk = createMiniMaxSdk(config, sdkConstructor);
        const raw = await sdk.search.query(request.query);
        return normalizeMiniMaxSearchResults(raw);
      } catch (error) {
        throw normalizeMiniMaxError(error);
      }
    },
  };

  return capability;
}

// ---------------------------------------------------------------------------
// Descriptor factory
// ---------------------------------------------------------------------------

/**
 * Build the MiniMax Provider Descriptor. The descriptor advertises the
 * Search Capability and constructs an Adapter whose `search` Capability
 * owns credentials, SDK lifecycle, Provider field mapping, and failure
 * normalization. Construction is side-effect-free; the SDK is built and
 * torn down per invocation. Tests pass `sdkConstructor`; production uses
 * the no-argument factory which binds the pinned `mmx-cli/sdk`.
 */
export function createMiniMaxDescriptor(
  dependencies?: MiniMaxAdapterDependencies,
): ProviderDescriptor {
  const sdkConstructor = dependencies?.sdkConstructor;

  return {
    id: "minimax",
    isConfigured(env: NodeJS.ProcessEnv): boolean {
      const key = env.MINIMAX_API_KEY;
      return typeof key === "string" && /\S/.test(key);
    },
    capabilities(): ReadonlySet<ProviderCapability> {
      return new Set<ProviderCapability>(["search"]);
    },
    create(context: ProviderContext): ProviderAdapter {
      const search = createMiniMaxSearchCapability({
        env: context.env,
        sdkConstructor,
      });
      return { id: "minimax", search };
    },
  };
}
