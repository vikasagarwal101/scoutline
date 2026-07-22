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
  QuotaError,
  TimeoutError,
  UnsupportedCapabilityError,
  ValidationError,
  UnsupportedOptionError,
} from "../../lib/errors.js";
import { loadMiniMaxConfig } from "./config.js";
import { applySearchTopic } from "../../lib/search-topic.js";
import { resolveImageSource, convertToDataUri, type ConvertToDataUriDeps } from "./media.js";
import { createMiniMaxQuotaCapability, type MiniMaxQuotaCapabilityOptions } from "./quota.js";
import { fetchMiniMaxQuota, type MiniMaxQuotaClientDeps } from "./quota-client.js";
import {
  fetchMiniMaxSearch,
  fetchMiniMaxVlm,
  type MiniMaxTransportDeps,
} from "./coding-plan-client.js";
import {
  isMiniMaxVisionOperationSupported,
  SPECIALIZED_VISION_OPERATION_SET,
  SPECIALIZED_VISION_OPERATIONS,
  type SpecializedVisionOperation,
} from "./vision-conformance.js";
import { MINIMAX_VISION_MAPPINGS } from "./vision-mappings.generated.js";

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
 * real codes; transient failures map to a representative status in
 * the retryable set (429 or any 5xx 500..599 inclusive, per DESIGN.md
 * §18 / FR-090). Unknown failures default to 500 (transient). When
 * the caller already carries a numeric status (a typed ApiError), that
 * status is honoured directly.
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
 * The 2038 real-name-verification URL. This is a curated constant set in
 * the upstream transport (`coding-plan-client.ts`), not raw Provider
 * text. `normalizeMiniMaxError` preserves any ApiError message that
 * carries it so the user sees the actionable URL. The literal MUST agree
 * with `coding-plan-client.ts` and the adapter-layer test
 * (`minimax-adapter.test.js` C1); the test fails if they drift.
 */
const MINIMAX_VERIFICATION_URL = "https://platform.minimaxi.com/user-center/basic-information";

/**
 * Status-keyed outward message for rewrapped MiniMax ApiErrors (F3,
 * code-review-baseline). The rewrap no longer echoes upstream
 * `error.message` blindly — today every upstream ApiError message is a
 * hardcoded constant, but a future change embedding a raw Provider body
 * in an ApiError message would leak through normalization, the cache,
 * and stdout. The single intentional exception is the 2038 verification
 * URL, preserved by the caller.
 */
function miniMaxApiErrorMessage(statusCode: number): string {
  if (statusCode === 429) return "MiniMax rate limit exceeded";
  if (statusCode === 403) return "MiniMax request rejected";
  return "MiniMax request failed";
}

function normalizeMiniMaxError(error: unknown): Error {
  // C1: QuotaError pass-through — terminal retry guarantee preserved.
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
    // C2: 2-arg form keeps MINIMAX_API_KEY in the rendered help text.
    return new AuthError("MiniMax authentication failed", "MINIMAX_API_KEY");
  }
  if (error instanceof NetworkError) {
    return new NetworkError("MiniMax network error");
  }
  if (error instanceof TimeoutError) {
    // Fixup D: preserve the original error's duration instead of
    // reconstructing it from an ambient process.env that may differ from
    // the injected env. The rewrapped error carries the same duration.
    // G4: MINIMAX_TIMEOUT help text surfaces the right env var name.
    return new TimeoutError(
      error.durationMs,
      "Try again or increase timeout with MINIMAX_TIMEOUT env var",
    );
  }
  if (error instanceof ApiError) {
    // F3 (code-review-baseline): rebuild the outward message from a
    // status-keyed constant so a future upstream change that embeds a raw
    // Provider body in an ApiError message cannot leak through. The single
    // exception is the 2038 verification URL — a curated upstream constant
    // (not raw text) that a test asserts survives. statusCode (retry
    // signal) is preserved either way.
    const statusCode = inferStatusCode("", error.statusCode);
    if (error.message.includes(MINIMAX_VERIFICATION_URL)) {
      return new ApiError(error.message, statusCode);
    }
    return new ApiError(miniMaxApiErrorMessage(statusCode), statusCode);
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
  readonly transport?: MiniMaxTransportDeps;
}

function createMiniMaxSearchCapability(options: MiniMaxSearchCapabilityOptions): SearchCapability {
  const { env, transport } = options;

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
      // Validate before any credential access or transport call.
      capability.validate(request);

      const config = loadMiniMaxConfig(env);
      try {
        // T03: map a non-general topic to a query keyword appendage.
        // The topic never reaches the MiniMax API as a separate parameter;
        // it is purely a query enhancement owned by this Adapter.
        const effectiveQuery = applySearchTopic(request.query, request.controls?.topic);
        const raw = await fetchMiniMaxSearch(config, effectiveQuery, transport);
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
 * Resolve the support check function used by the MiniMax Vision
 * Capability. Production delegates to the compiled conformance
 * registry. Tests may pass `dependencies.isSpecializedVisionOperationSupported`
 * to force specific operations into the supported path so the routing
 * branch can be exercised deterministically.
 */
type SpecializedSupportCheck = (operation: SpecializedVisionOperation) => boolean;
function resolveSpecializedSupportCheck(
  injected: MiniMaxAdapterDependencies["isSpecializedVisionOperationSupported"],
): SpecializedSupportCheck {
  if (injected) return injected;
  return (operation) => isMiniMaxVisionOperationSupported(operation);
}

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
 *
 * `isSpecialized` is the injected support check (or the compiled
 * registry query). Tests pass it via
 * `dependencies.isSpecializedVisionOperationSupported`; production
 * passes nothing and the registry query is used.
 */
function supportsMiniMaxVisionOperation(
  operation: VisionOperation,
  isSpecialized: SpecializedSupportCheck,
): boolean {
  if (operation === "interpret-image") return true;
  if (SPECIALIZED_VISION_OPERATION_SET.has(operation as SpecializedVisionOperation)) {
    return isSpecialized(operation as SpecializedVisionOperation);
  }
  return false;
}

interface MiniMaxVisionCapabilityOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly transport?: MiniMaxTransportDeps;
  readonly isSpecializedVisionOperationSupported?: MiniMaxAdapterDependencies["isSpecializedVisionOperationSupported"];
}

/**
 * Build the MiniMax Vision Capability. Maps `interpret-image` to the
 * MiniMax Coding Plan VLM endpoint. The validated image source is
 * resolved and converted to a data URI before the transport call; the
 * instruction maps to the optional `prompt`. Only a nonempty text
 * result (extracted from the characterized `{ content }` envelope) is
 * normalized.
 *
 * Specialized operations route through their operation-specific mapping
 * Module when the support check returns true. The support decision is
 * derived from the compiled conformance registry; tests may inject a
 * forced-support function via `options.isSpecializedVisionOperationSupported`
 * so the routing branch can be exercised without flipping a compiled
 * attestation (DESIGN.md §15).
 *
 * Media is resolved after the configuration check; `convertToDataUri`
 * performs the data-URI conversion (HTTP fetch + local read). Vision
 * never uses the response cache (FR-022); shared execution owns the
 * retry policy.
 */
function createMiniMaxVisionCapability(options: MiniMaxVisionCapabilityOptions): VisionCapability {
  const { env, transport, isSpecializedVisionOperationSupported } = options;
  const isSpecialized = resolveSpecializedSupportCheck(isSpecializedVisionOperationSupported);

  const capability: VisionCapability = {
    supports(operation: VisionOperation): boolean {
      return supportsMiniMaxVisionOperation(operation, isSpecialized);
    },

    async invoke(request: VisionRequest): Promise<string> {
      // Fail closed BEFORE any credential, media, or transport access.
      // The support decision is the single registry-driven gate; every
      // specialized operation stays unsupported at P5-02 because every
      // registry entry is pending.
      if (!supportsMiniMaxVisionOperation(request.operation, isSpecialized)) {
        throw new UnsupportedCapabilityError(
          "minimax",
          visionOperationToCapability(request.operation),
        );
      }

      // Configuration check (credential) before media resolution.
      const config = loadMiniMaxConfig(env);

      // Specialized operations compose the prompt through their mapping
      // Module. The mapping Module is the single source of intent,
      // option formatting, and result normalization for that operation
      // (DESIGN.md §15). When the support gate is open but the Module is
      // somehow missing, surface an `API_ERROR` — the routing invariant
      // is broken only via a coding bug, never via runtime drift.
      if (request.operation !== "interpret-image") {
        const specializedOp = request.operation as SpecializedVisionOperation;
        const mapping = MINIMAX_VISION_MAPPINGS[specializedOp];
        if (!mapping) {
          throw new ApiError(
            `MiniMax vision mapping for ${specializedOp} is supported but no mapping Module is wired`,
            500,
          );
        }
        // Specialized requests always carry a `source`; the support gate
        // above excludes `diff` (no `source`) and `video` (unsupported).
        const resolved = resolveImageSource((request as { source: string }).source);
        const prompt = mapping.composePrompt(request);

        try {
          // Cast safe: the global `fetch` (production default when
          // `transport.fetch` is undefined) returns the full `Response`
          // which satisfies both ProviderQuotaFetch and the wider
          // ProviderImageFetch that `convertToDataUri` needs. Test
          // fakes via makeResponse also provide `headers` + `arrayBuffer`
          // by default. Widening `MiniMaxTransportDeps.fetch` instead
          // would force quota tests' fakes to carry unused fields.
          const dataUri = await convertToDataUri(
            resolved,
            transport as ConvertToDataUriDeps | undefined,
          );
          const raw = await fetchMiniMaxVlm(config, dataUri, prompt, transport);
          return mapping.normalizeResult(raw);
        } catch (error) {
          throw normalizeMiniMaxError(error);
        }
      }

      const resolved = resolveImageSource(request.source);
      const prompt =
        request.instruction && request.instruction.length > 0
          ? request.instruction
          : "Describe the image.";

      try {
        // Cast safe — see the matching call site in the specialized
        // branch above for the full rationale.
        const dataUri = await convertToDataUri(
          resolved,
          transport as ConvertToDataUriDeps | undefined,
        );
        const raw = await fetchMiniMaxVlm(config, dataUri, prompt, transport);
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
 * owns credentials, transport, Provider field mapping, and failure
 * normalization. Construction is side-effect-free; the transport is
 * invoked per Capability call. Tests pass `transport` (typically a
 * fake-fetch wrapper); production uses the no-argument factory which
 * resolves to the global `fetch` and timers inside each transport
 * Module.
 */
export function createMiniMaxDescriptor(
  dependencies?: MiniMaxAdapterDependencies,
): ProviderDescriptor {
  const transport = dependencies?.transport;
  const isSpecializedVisionOperationSupported = dependencies?.isSpecializedVisionOperationSupported;

  return {
    id: "minimax",
    isConfigured(env: NodeJS.ProcessEnv): boolean {
      const key = env.MINIMAX_API_KEY;
      return typeof key === "string" && /\S/.test(key);
    },
    capabilities(): ReadonlySet<ProviderCapability> {
      // Base capabilities always advertised by MiniMax. Specialized
      // Vision operations (`vision.ui-artifact`, etc.) are advertised
      // only when their conformance support check returns true
      // (DESIGN.md §15). Production derives this from the compiled
      // registry; tests may force specific operations into the
      // advertised set via
      // `dependencies.isSpecializedVisionOperationSupported` so the
      // routing branch can be exercised without flipping attestations.
      const caps: Set<ProviderCapability> = new Set<ProviderCapability>([
        "search",
        "vision.interpret-image",
        "quota",
        "diagnostics",
      ]);
      const isSpecialized = resolveSpecializedSupportCheck(isSpecializedVisionOperationSupported);
      for (const op of SPECIALIZED_VISION_OPERATIONS) {
        if (isSpecialized(op)) {
          caps.add(visionOperationToCapability(op) as ProviderCapability);
        }
      }
      return caps;
    },
    create(context: ProviderContext): ProviderAdapter {
      const search = createMiniMaxSearchCapability({
        env: context.env,
        transport,
      });
      const vision = createMiniMaxVisionCapability({
        env: context.env,
        transport,
        isSpecializedVisionOperationSupported,
      });
      const quotaOptions: MiniMaxQuotaCapabilityOptions = { env: context.env, ...transport };
      const quota = createMiniMaxQuotaCapability(quotaOptions);
      const diagnostics = createMiniMaxDiagnosticsCapability({
        env: context.env,
        ...transport,
      });
      return { id: "minimax", search, vision, quota, diagnostics };
    },
  };
}
