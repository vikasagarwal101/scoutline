/**
 * Shared Execution Contract (DESIGN.md §10).
 *
 * Owns cache lookup, legacy read-through, retry policy, and local count
 * truncation for every Provider Capability. Capability Modules define
 * shared meaning; Adapters perform a single transport attempt; this
 * module is the single retry and cache-policy owner.
 *
 * Boundary rules (ARCHITECTURE.md §2):
 *   - May import capability types, Provider identity types, cache, and
 *     normalized errors.
 *   - Must NOT import a concrete Provider Adapter, UTCP, or `mmx-cli`.
 *   - Must NOT import command presentation or output mode modules.
 *
 * Order of operations for `executeSearch`:
 *   1. `capability.validate(request)`
 *   2. `capability.cacheIdentity(request, { legacyCount: options.count })`
 *   3. Read the provider-partitioned cache key
 *   4. Try and decode Adapter-supplied legacy candidates when applicable
 *   5. Invoke through `executeProviderOperation`
 *   6. Retry only normalized retryable failures
 *   7. Cache the full normalized result
 *   8. Apply local count truncation
 */

import type { SearchCapability, SearchRequest, SearchSource } from "../capabilities/search.js";
import { ScoutlineError } from "./errors.js";
import { buildProviderCacheKey, type ResponseCache } from "./cache.js";

// ---------------------------------------------------------------------------
// Retry policy
// ---------------------------------------------------------------------------

/**
 * Retry policy for a single Provider operation. Defaults are applied
 * per-operation from {@link defaultRetryPolicy}.
 */
export interface RetryPolicy {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterMs: number;
}

/**
 * Dependencies shared execution requires. `sleep` and `random` are
 * injected so retry backoff is deterministic under test.
 */
export interface ExecutionDependencies {
  cache: ResponseCache;
  sleep(ms: number): Promise<void>;
  random(): number;
}

/** Provider operations that share a single retry policy table. */
export type ProviderOperation = "search" | "vision" | "quota" | "diagnostics";

const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 8000;
const DEFAULT_JITTER_MS = 250;

/**
 * Default retry policy per operation. Search, quota, and diagnostics
 * allow one retry; Vision allows two to preserve shipped Z.AI
 * behaviour. Base delay 500 ms, max delay 8000 ms, jitter up to 250 ms.
 */
export function defaultRetryPolicy(operation: ProviderOperation): RetryPolicy {
  const base = {
    baseDelayMs: DEFAULT_BASE_DELAY_MS,
    maxDelayMs: DEFAULT_MAX_DELAY_MS,
    jitterMs: DEFAULT_JITTER_MS,
  };
  switch (operation) {
    case "vision":
      return { ...base, maxRetries: 2 };
    case "search":
    case "quota":
    case "diagnostics":
    default:
      return { ...base, maxRetries: 1 };
  }
}

/**
 * Classify whether a normalized error is retryable for a Provider
 * operation. Authentication, validation, unsupported, content-policy,
 * and exhausted-quota failures are terminal. Normalized timeout,
 * network, HTTP 429, 500, 502, 503, and 504 equivalents are retryable.
 *
 * An explicit `retryable: true` on a `ScoutlineError` wins; an explicit
 * `retryable: false` overrides a code-based default. Non-Scoutline
 * errors never retry — Adapters must normalize failures before they
 * leave the Adapter boundary.
 */
function isOperationRetryableError(error: unknown): boolean {
  if (!(error instanceof ScoutlineError)) return false;
  // Explicit retryable flag wins over code-based defaults.
  if (error.retryable) return true;
  switch (error.code) {
    case "TIMEOUT_ERROR":
    case "NETWORK_ERROR":
      return true;
    case "API_ERROR":
      return (
        error.statusCode === 429 ||
        error.statusCode === 500 ||
        error.statusCode === 502 ||
        error.statusCode === 503 ||
        error.statusCode === 504
      );
    default:
      return false;
  }
}

/**
 * Generic uncached retry wrapper. Performs no I/O of its own; the
 * caller supplies the invoke thunk and the cache strategy. Each
 * outward Provider operation has exactly one retry wrapper; Adapter
 * transport methods perform one attempt and never retry internally.
 */
export async function executeProviderOperation<T>(
  operation: ProviderOperation,
  invoke: () => Promise<T>,
  dependencies: Pick<ExecutionDependencies, "sleep" | "random">,
  retryPolicy?: RetryPolicy,
): Promise<T> {
  const policy = retryPolicy ?? defaultRetryPolicy(operation);
  let attempt = 0;
  for (;;) {
    try {
      return await invoke();
    } catch (error) {
      if (attempt >= policy.maxRetries) throw error;
      if (!isOperationRetryableError(error)) throw error;
      const backoff = Math.min(policy.maxDelayMs, policy.baseDelayMs * Math.pow(2, attempt));
      const jitter = Math.floor(dependencies.random() * policy.jitterMs);
      await dependencies.sleep(backoff + jitter);
      attempt += 1;
    }
  }
}

// ---------------------------------------------------------------------------
// Search execution
// ---------------------------------------------------------------------------

/**
 * Apply command-level count truncation to a normalized result. Count
 * is meaning local to the command Module: zero returns an empty list,
 * a positive count slices, and an absent count returns everything.
 */
function applyCount(
  result: readonly SearchSource[],
  count: number | undefined,
): readonly SearchSource[] {
  if (count === undefined) return result;
  if (count <= 0) return [];
  return result.slice(0, count);
}

/**
 * Execute a normalized Search through the shared pipeline:
 * validate → cache identity → new-key read → optional legacy
 * read-through → invoke with retry → cache the full result → apply
 * count truncation.
 *
 * Count never enters the cache identity request or the Provider
 * request; it is supplied only as `legacyCount` so the Z.AI Adapter
 * can reconstruct old keys.
 */
export async function executeSearch(
  capability: SearchCapability,
  request: SearchRequest,
  options: { count?: number; noCache?: boolean; retryPolicy?: RetryPolicy },
  dependencies: ExecutionDependencies,
): Promise<readonly SearchSource[]> {
  // 1. Validate Capability request.
  capability.validate(request);

  // 2. Adapter-owned cache identity (after validation).
  const identity = capability.cacheIdentity(request, {
    legacyCount: options.count,
  });

  // 3. Read the provider-partitioned cache key.
  const newKey = buildProviderCacheKey({
    provider: identity.provider,
    capability: identity.capability,
    credentialFingerprint: identity.credentialFingerprint,
    request: identity.request,
  });

  if (!options.noCache) {
    const cached = await dependencies.cache.get<readonly SearchSource[]>(newKey);
    if (cached !== null) {
      return applyCount(cached, options.count);
    }

    // 4. Adapter-owned legacy candidates (Z.AI only). Invalid raw data
    //    is a miss; a valid hit populates the new key but the legacy
    //    file is never changed or deleted.
    if (identity.legacyCandidates) {
      for (const candidate of identity.legacyCandidates) {
        const raw = await dependencies.cache.get<unknown>(candidate.key);
        if (raw === null) continue;
        const decoded = candidate.decode(raw);
        if (decoded !== null) {
          await dependencies.cache.set(newKey, decoded);
          return applyCount(decoded, options.count);
        }
      }
    }
  }

  // 5 + 6. Invoke through executeProviderOperation; retryable failures
  //        are retried with backoff driven by the injected sleep+random.
  const result = await executeProviderOperation(
    "search",
    () => capability.invoke(request),
    dependencies,
    options.retryPolicy,
  );

  // 7. Cache the full normalized result before count is applied.
  if (!options.noCache) {
    await dependencies.cache.set(newKey, result);
  }

  // 8. Local count truncation.
  return applyCount(result, options.count);
}
