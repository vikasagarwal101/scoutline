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
import type {
  VisionCapability,
  VisionOperation,
  VisionRequest,
} from "../../capabilities/vision.js";
import { visionOperationToCapability } from "../../capabilities/vision.js";
import type { DiagnosticsCapability, DiagnosticOptions } from "../../capabilities/diagnostics.js";
import {
  ApiError,
  AuthError,
  ConfigurationError,
  NetworkError,
  TimeoutError,
  UnsupportedCapabilityError,
  ValidationError,
  UnsupportedOptionError,
} from "../../lib/errors.js";
import { loadMiniMaxConfig } from "./config.js";
import { createMiniMaxSdk } from "./sdk-client.js";
import { resolveImageSource } from "./media.js";
import { createMiniMaxQuotaCapability, type MiniMaxQuotaCapabilityOptions } from "./quota.js";
import {
  fetchMiniMaxQuota,
  type MiniMaxQuotaClientDeps,
  type MiniMaxQuotaFetch,
} from "./quota-client.js";
import {
  isMiniMaxVisionOperationSupported,
  listSupportedMiniMaxVisionOperations,
  SPECIALIZED_VISION_OPERATION_SET,
  type SpecializedVisionOperation,
} from "./vision-conformance.js";

// ---------------------------------------------------------------------------
// Provider-owned credential fingerprint
// ---------------------------------------------------------------------------

function credentialFingerprint(apiKey: string): string {
  return crypto.createHash("sha256").update(apiKey).digest("hex");
}

function resolveApiKey(env: NodeJS.ProcessEnv): string {
  const key = env.MINIMAX_API_KEY;
  if (typeof key !== "string" || key.trim().length === 0) {
    // Missing credentials are a configuration failure (exit 3), not an
    // auth failure. AuthError (exit 1) is reserved for a credential the
    // Provider REJECTED (Fixup A — B7). This mirrors loadMiniMaxConfig.
    throw new ConfigurationError(
      "MINIMAX_API_KEY environment variable is required",
      'export MINIMAX_API_KEY="your-api-key"',
    );
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
// Failure normalization: stable public codes, no raw payloads (NFR-006)
// ---------------------------------------------------------------------------

/**
 * Resolve a stable HTTP-style status code for retry classification.
 * Explicit terminal client errors (404, 400, 410, 422) map to their
 * real codes; retryable server errors (500, 502, 503, 504) map to
 * themselves. Unknown failures default to 500 (transient). When the
 * caller already carries a numeric status (a typed ApiError), that
 * status is honoured directly (DESIGN.md §10).
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

function normalizeMiniMaxError(error: unknown): Error {
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
    return new AuthError("MiniMax authentication failed");
  }
  if (error instanceof NetworkError) {
    return new NetworkError("MiniMax network error");
  }
  if (error instanceof TimeoutError) {
    // Fixup D: preserve the original error's duration instead of
    // reconstructing it from an ambient process.env that may differ from
    // the injected env. The rewrapped error carries the same duration.
    return new TimeoutError(error.durationMs);
  }
  if (error instanceof ApiError) {
    const statusCode = inferStatusCode("", error.statusCode);
    return new ApiError("MiniMax request failed", statusCode);
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
// Vision Capability (DESIGN.md §8, §9, §12 — P3-03)
// ---------------------------------------------------------------------------

/**
 * Decide whether the MiniMax Adapter supports a Vision operation.
 *
 * `interpret-image` is supported unconditionally (the base release
 * wires it through `sdk.vision.describe`). Specialized operations
 * (`ui-artifact`, `extract-text`, `diagnose-error`, `diagram`,
 * `chart`) are gated by the compiled conformance registry
 * (DESIGN.md §15) — at P5-02 every entry is pending, so every
 * specialized operation is unsupported here. `diff` and `video`
 * remain Z.AI-only and are never supported by MiniMax.
 *
 * Pure: no Provider call, no env read, no I/O. The conformance query
 * is a snapshot read of a frozen registry assembled at module load.
 */
function supportsMiniMaxVisionOperation(operation: VisionOperation): boolean {
  if (operation === "interpret-image") return true;
  if (SPECIALIZED_VISION_OPERATION_SET.has(operation as SpecializedVisionOperation)) {
    return isMiniMaxVisionOperationSupported(operation);
  }
  return false;
}

interface MiniMaxVisionCapabilityOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly sdkConstructor?: MiniMaxAdapterDependencies["sdkConstructor"];
}

/**
 * Build the MiniMax Vision Capability. Maps `interpret-image` to
 * `sdk.vision.describe`. The validated image source maps to `image`; the
 * instruction maps to the optional `prompt`. Only a nonempty text result
 * (extracted from the characterized `{ content }` envelope) is normalized.
 *
 * Media is resolved after the configuration check; the SDK performs
 * data-URI conversion, so the media module never reads file content.
 * Vision never uses the response cache (FR-022); shared execution owns
 * the retry policy.
 */
function createMiniMaxVisionCapability(options: MiniMaxVisionCapabilityOptions): VisionCapability {
  const { env, sdkConstructor } = options;

  const capability: VisionCapability = {
    supports(operation: VisionOperation): boolean {
      return supportsMiniMaxVisionOperation(operation);
    },

    async invoke(request: VisionRequest): Promise<string> {
      // Fail closed BEFORE any credential, media, or SDK access. The
      // support decision is the single registry-driven gate; every
      // specialized operation stays unsupported at P5-02 because every
      // registry entry is pending.
      if (!supportsMiniMaxVisionOperation(request.operation)) {
        throw new UnsupportedCapabilityError(
          "minimax",
          visionOperationToCapability(request.operation),
        );
      }
      if (request.operation !== "interpret-image") {
        // A specialized operation that the registry says is supported
        // would route through its operation-specific Module here. At
        // P5-02 this branch is unreachable because the registry gate
        // above rejects every specialized operation. Throw a clean
        // UnsupportedCapabilityError so the fail-closed invariant is
        // explicit even if a future change reorders the checks.
        throw new UnsupportedCapabilityError(
          "minimax",
          visionOperationToCapability(request.operation),
        );
      }

      // Configuration check (credential) before media resolution.
      const config = loadMiniMaxConfig(env);
      const image = resolveImageSource(request.source);

      try {
        const sdk = createMiniMaxSdk(config, sdkConstructor);
        const describeRequest: { image: string; prompt?: string } = { image };
        if (request.instruction && request.instruction.length > 0) {
          describeRequest.prompt = request.instruction;
        }
        const raw = await sdk.vision.describe(describeRequest);
        return normalizeMiniMaxVisionResult(raw);
      } catch (error) {
        throw normalizeMiniMaxError(error);
      }
    },
  };

  return capability;
}

/**
 * Normalize the MiniMax vision result to a nonempty text string. The
 * characterized `VlmResponse` envelope is `{ content: string }`; any other
 * shape, or an empty content, is a malformed result.
 */
function normalizeMiniMaxVisionResult(raw: unknown): string {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const record = raw as { content?: unknown };
    if (typeof record.content === "string" && record.content.trim().length > 0) {
      return record.content;
    }
  }
  throw new ApiError("MiniMax vision returned a malformed response", 500);
}

// ---------------------------------------------------------------------------
// Diagnostics Capability (DESIGN.md §12, §14 — P4-04)
// ---------------------------------------------------------------------------

/**
 * Options for the MiniMax DiagnosticsCapability. Configuration is
 * loaded from `env`; transport dependencies (`fetch`, timer) are the
 * same Adapter-local quota transport used by the quota Capability so
 * tests inject a single fake for both.
 */
export interface MiniMaxDiagnosticsCapabilityOptions extends MiniMaxQuotaClientDeps {
  readonly env: NodeJS.ProcessEnv;
}

/**
 * Build the MiniMax DiagnosticsCapability. MiniMax connectivity is
 * probed through a raw single-attempt quota inspection
 * ({@link fetchMiniMaxQuota}), NOT `QuotaCapability.invoke()`, because
 * the remains endpoint authenticates without a generative request.
 * There is NO nested retry wrapper here — shared execution owns the
 * retry policy; this transport performs exactly one attempt.
 */
function createMiniMaxDiagnosticsCapability(
  options: MiniMaxDiagnosticsCapabilityOptions,
): DiagnosticsCapability {
  const { env, ...transportDeps } = options;
  return {
    async invoke(diagOptions: DiagnosticOptions): Promise<void> {
      if (!diagOptions.probe) return;
      const config = loadMiniMaxConfig(env);
      try {
        await fetchMiniMaxQuota(config, transportDeps);
      } catch (error) {
        throw normalizeMiniMaxError(error);
      }
    },
  };
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

  // Direct quota transport injection (tests). Production uses the
  // global fetch and timers resolved inside the quota client.
  const quotaTransport: {
    fetch?: MiniMaxQuotaFetch;
    setTimeout?: typeof setTimeout;
    clearTimeout?: typeof clearTimeout;
  } = {};
  if (dependencies?.quotaFetch) {
    quotaTransport.fetch = dependencies.quotaFetch as MiniMaxQuotaFetch;
  }
  if (dependencies?.quotaSetTimeout) {
    quotaTransport.setTimeout = dependencies.quotaSetTimeout;
  }
  if (dependencies?.quotaClearTimeout) {
    quotaTransport.clearTimeout = dependencies.quotaClearTimeout;
  }

  return {
    id: "minimax",
    isConfigured(env: NodeJS.ProcessEnv): boolean {
      const key = env.MINIMAX_API_KEY;
      return typeof key === "string" && /\S/.test(key);
    },
    capabilities(): ReadonlySet<ProviderCapability> {
      // Base capabilities always advertised by MiniMax. Specialized
      // Vision operations (`vision.ui-artifact`, etc.) are advertised
      // only when their conformance registry entry is supported
      // (DESIGN.md §15). At P5-02 every entry is pending, so the set
      // reduces to the base four.
      const caps: Set<ProviderCapability> = new Set<ProviderCapability>([
        "search",
        "vision.interpret-image",
        "quota",
        "diagnostics",
      ]);
      for (const op of listSupportedMiniMaxVisionOperations()) {
        caps.add(visionOperationToCapability(op) as ProviderCapability);
      }
      return caps;
    },
    create(context: ProviderContext): ProviderAdapter {
      const search = createMiniMaxSearchCapability({
        env: context.env,
        sdkConstructor,
      });
      const vision = createMiniMaxVisionCapability({
        env: context.env,
        sdkConstructor,
      });
      const quotaOptions: MiniMaxQuotaCapabilityOptions = { env: context.env, ...quotaTransport };
      const quota = createMiniMaxQuotaCapability(quotaOptions);
      const diagnostics = createMiniMaxDiagnosticsCapability({
        env: context.env,
        ...quotaTransport,
      });
      return { id: "minimax", search, vision, quota, diagnostics };
    },
  };
}
