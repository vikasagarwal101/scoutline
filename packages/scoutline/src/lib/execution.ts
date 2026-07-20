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
import type { RepositoryOperation, RepositoryOperationKind } from "../capabilities/repository.js";
import type {
  ReaderCacheIdentity,
  ReaderFetchRequest,
  ReaderFetchResult,
  ReaderOperation,
  ReaderOperationKind,
} from "../capabilities/reader.js";
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

/**
 * Provider operations that share a single retry policy table.
 *
 * The four legacy values identify Provider Capabilities that have a
 * 1:1 Capability-to-operation mapping (`"search"`, `"vision"`, ...)
 * The three repository operations are composed from the P6-02
 * {@link RepositoryOperationKind} source of truth so a future change
 * to that union (e.g. adding a fourth repository kind) propagates
 * here without further manual upkeep. The reader operation is
 * composed from the Reader Migration {@link ReaderOperationKind}
 * source of truth for the same reason.
 */
export type ProviderOperation =
  | "search"
  | "vision"
  | "quota"
  | "diagnostics"
  | RepositoryOperationKind
  | ReaderOperationKind;

const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 8000;
const DEFAULT_JITTER_MS = 250;

/**
 * Default retry policy per operation. Search, quota, diagnostics, the
 * three repository operations, and the reader operation allow one
 * retry; Vision allows two to preserve shipped Z.AI behaviour. Base
 * delay 500 ms, max delay 8000 ms, jitter up to 250 ms.
 *
 * The repository and reader operations inherit the existing single-
 * retry non-Vision policy (DESIGN.md §18) without altering the
 * behaviour of Search/Vision/Quota/Diagnostics; the new values are
 * routed through the same default branch as Search/Quota/Diagnostics.
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
    case "repository-search":
    case "repository-read-file":
    case "repository-list-directory":
    case "reader-fetch":
    default:
      return { ...base, maxRetries: 1 };
  }
}

/**
 * Classify whether a normalized error is retryable for a Provider
 * operation. Authentication, validation, unsupported, content-policy,
 * and exhausted-quota failures are terminal. Normalized timeout,
 * network, HTTP 429, and any 5xx (statusCode 500..599, inclusive)
 * equivalents are retryable.
 *
 * The 5xx range is matched as a closed interval so Provider-encoded
 * statuses that the upstream gateway passes through verbatim (501,
 * 505, 599, etc.) retry exactly once, matching Design §18 and
 * FR-090. Other 4xx codes remain terminal.
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
    case "API_ERROR": {
      // Design §18 / FR-090: 429 and any 5xx (500..599 inclusive) retry
      // once. The interval is closed so encoded Provider statuses that
      // pass through verbatim (501, 505, 599, ...) match the contract.
      const status = error.statusCode;
      return status !== undefined && (status === 429 || (status >= 500 && status <= 599));
    }
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

// ---------------------------------------------------------------------------
// Repository execution (DESIGN.md §18, §10)
// ---------------------------------------------------------------------------

/**
 * Options for {@link executeRepositoryOperation}. `noCache` bypasses
 * the provider-partitioned cache and the legacy read-through cache
 * for both reads and writes; it never bypasses validation, identity,
 * invoke, or retry semantics. `retryPolicy` overrides the default
 * single-retry non-Vision policy from {@link defaultRetryPolicy}.
 */
export interface ExecuteRepositoryOptions {
  noCache?: boolean;
  retryPolicy?: RetryPolicy;
}

/**
 * Generic cache + retry executor for every cacheable Repository
 * Capability operation (Search, Read File, Directory Listing).
 *
 * The observable order is fixed and exhaustively enumerated in
 * DESIGN.md §18:
 *
 *   1. `operation.validate(request)` — throws `ValidationError`
 *      synchronously before any cache or Adapter work.
 *   2. `operation.cacheIdentity(request)` — Adapter computes the
 *      provider-partitioned cache key and ordered legacy candidates
 *      from the validated request and a single resolved credential.
 *   3. Read the provider-partitioned cache key and pass the raw value
 *      through `operation.decodeCached`. A valid decode returns
 *      immediately; `null` is a miss; malformed values never propagate
 *      through a generic cast.
 *   4. For each legacy candidate, in declaration order, read the
 *      legacy key and pass it through the candidate's `decode`. A
 *      valid legacy hit is written through to the normalized key
 *      (the legacy file is never changed or deleted) and returned.
 *      A malformed legacy value is a miss.
 *   5. `operation.invoke(request)` is wrapped through
 *      `executeProviderOperation` with the existing single-retry
 *      non-Vision policy. Each retry creates a fresh Adapter
 *      transport attempt; cache hits create no transport.
 *   6. The normalized result is written to the provider-partitioned
 *      cache key.
 *
 * `--no-cache` skips steps 3, 4, and 6. It never skips validation
 * (1), identity (2), invoke (5), or retry semantics.
 *
 * `executeRepositoryOperation` imports no Z.AI, MiniMax, MCP, UTCP,
 * command-output, BFS, selection, or presentation module.
 */
export async function executeRepositoryOperation<Request, Result>(
  operation: RepositoryOperation<Request, Result>,
  request: Request,
  options: ExecuteRepositoryOptions,
  dependencies: ExecutionDependencies,
): Promise<Result> {
  // 1. Validate Capability request.
  operation.validate(request);

  // 2. Adapter-owned cache identity (after validation). The Adapter
  //    resolves its credential exactly once and returns legacy
  //    candidates alongside the full fingerprint and canonical
  //    request. Candidate construction performs no ambient
  //    environment read.
  const identity = operation.cacheIdentity(request);

  // 3. Provider-partitioned cache key.
  //
  // The key namespace is `<capability>-<operation>` rather than the
  // umbrella Capability alone, so File and Directory operations —
  // which share the `{ repository, path }` request shape — cannot
  // collide. This composes the existing `buildProviderCacheKey` slot
  // without mutating `buildProviderCacheKey` or its existing callers
  // (Search, Vision, Quota, Diagnostics still pass a single Capability
  // name). The canonical request object is unchanged; only the
  // capability argument gains the operation suffix.
  const newKey = buildProviderCacheKey({
    provider: identity.provider,
    capability: `${identity.capability}-${identity.operation}`,
    credentialFingerprint: identity.credentialFingerprint,
    request: identity.request,
  });

  if (!options.noCache) {
    const raw = await dependencies.cache.get<unknown>(newKey);
    if (raw !== null) {
      const decoded = operation.decodeCached(raw);
      if (decoded !== null) {
        return decoded;
      }
      // Malformed normalized value: treat as a miss and fall through.
    }

    // 4. Ordered legacy candidates. Each candidate's decode is
    //    total — invalid raw data is a miss. A valid legacy hit
    //    populates the new key but the legacy file is never
    //    changed or deleted.
    for (const candidate of identity.legacyCandidates) {
      const legacyRaw = await dependencies.cache.get<unknown>(candidate.key);
      if (legacyRaw === null) continue;
      const decoded = candidate.decode(legacyRaw);
      if (decoded !== null) {
        await dependencies.cache.set(newKey, decoded);
        return decoded;
      }
    }
  }

  // 5. Retry-wrapped invoke. Auth, Validation, Unsupported, and
  //    exhausted Quota failures are terminal; transient timeout,
  //    network, and 5xx/429-equivalent failures get one retry.
  const result = await executeProviderOperation(
    // `operation.kind` is `RepositoryOperationKind`, which is
    // composed into `ProviderOperation` directly — no cast needed
    // and a future kind union change propagates automatically.
    operation.kind,
    () => operation.invoke(request),
    dependencies,
    options.retryPolicy,
  );

  // 6. Cache the full normalized result before returning.
  if (!options.noCache) {
    await dependencies.cache.set(newKey, result);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Reader execution (DESIGN.md §18, reader-migration-core-flows,
// reader-migration-tech-plan Ticket 04).
// ---------------------------------------------------------------------------

/**
 * Options for {@link executeReaderOperation}. `noCache` bypasses the
 * provider-partitioned cache and the legacy read-through cache for
 * both reads and writes; it never bypasses validation, identity,
 * invoke, or retry semantics. `retryPolicy` overrides the default
 * single-retry non-Vision policy from {@link defaultRetryPolicy}.
 */
export interface ExecuteReaderOptions {
  noCache?: boolean;
  retryPolicy?: RetryPolicy;
}

/**
 * Generic cache + retry executor for the Reader Capability's
 * `reader-fetch` operation. Structurally identical to
 * {@link executeRepositoryOperation}; the two are duplicated rather
 * than shared because factoring them would widen this ticket's
 * scope (modifying repository.ts further). Future consolidation is
 * a separate refactor.
 *
 * The observable order is fixed:
 *
 *   1. `operation.validate(request)` — throws `ValidationError`
 *      synchronously before any cache or Adapter work.
 *   2. `operation.cacheIdentity(request)` — Adapter computes the
 *      provider-partitioned cache key and ordered legacy candidates
 *      from the validated request and a single resolved credential.
 *   3. Read the provider-partitioned cache key and pass the raw
 *      value through `operation.decodeCached`. A valid decode
 *      returns immediately; `null` is a miss; malformed values
 *      never propagate through a generic cast.
 *   4. For each legacy candidate, in declaration order, read the
 *      legacy key and pass it through the candidate's `decode`. A
 *      valid legacy hit is written through to the normalized key
 *      (the legacy file is never changed or deleted) and returned.
 *      A malformed legacy value is a miss.
 *   5. `operation.invoke(request)` is wrapped through
 *      `executeProviderOperation` with the single-retry non-Vision
 *      policy. Each retry creates a fresh Adapter transport attempt;
 *      cache hits create no transport.
 *   6. The normalized result is written to the provider-partitioned
 *      cache key.
 *
 * `--no-cache` skips steps 3, 4, and 6. It never skips validation
 * (1), identity (2), invoke (5), or retry semantics.
 *
 * `executeReaderOperation` imports no Z.AI, MiniMax, MCP, UTCP,
 * command-output, selection, or presentation module.
 */
export async function executeReaderOperation(
  operation: ReaderOperation<ReaderFetchRequest, ReaderFetchResult>,
  request: ReaderFetchRequest,
  options: ExecuteReaderOptions,
  dependencies: ExecutionDependencies,
): Promise<ReaderFetchResult> {
  // 1. Validate Capability request.
  operation.validate(request);

  // 2. Adapter-owned cache identity (after validation). The Adapter
  //    resolves its credential exactly once and returns legacy
  //    candidates alongside the full fingerprint and canonical
  //    request. Candidate construction performs no ambient
  //    environment read.
  const identity: ReaderCacheIdentity<ReaderFetchRequest, ReaderFetchResult> =
    operation.cacheIdentity(request);

  // 3. Provider-partitioned cache key.
  //
  // The key namespace is `${capability}-${operation}` rather than the
  // umbrella Capability alone, mirroring the repository convention so
  // future Reader operations cannot collide. The capability argument
  // gains the operation suffix.
  const newKey = buildProviderCacheKey({
    provider: identity.provider,
    capability: `${identity.capability}-${identity.operation}`,
    credentialFingerprint: identity.credentialFingerprint,
    request: identity.request,
  });

  if (!options.noCache) {
    const raw = await dependencies.cache.get<unknown>(newKey);
    if (raw !== null) {
      const decoded = operation.decodeCached(raw);
      if (decoded !== null) {
        return decoded;
      }
      // Malformed normalized value: treat as a miss and fall through.
    }

    // 4. Ordered legacy candidates. Each candidate's decode is
    //    total — invalid raw data is a miss. A valid legacy hit
    //    populates the new key but the legacy file is never
    //    changed or deleted.
    for (const candidate of identity.legacyCandidates) {
      const legacyRaw = await dependencies.cache.get<unknown>(candidate.key);
      if (legacyRaw === null) continue;
      const decoded = candidate.decode(legacyRaw);
      if (decoded !== null) {
        await dependencies.cache.set(newKey, decoded);
        return decoded;
      }
    }
  }

  // 5. Retry-wrapped invoke. Auth, Validation, Unsupported, and
  //    exhausted Quota failures are terminal; transient timeout,
  //    network, and 5xx/429-equivalent failures get one retry.
  const result = await executeProviderOperation(
    operation.kind,
    () => operation.invoke(request),
    dependencies,
    options.retryPolicy,
  );

  // 6. Cache the full normalized result before returning.
  if (!options.noCache) {
    await dependencies.cache.set(newKey, result);
  }

  return result;
}
