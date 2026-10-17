/**
 * Bridge-local acquisition composition for the lean investigation engine
 * (experimental requirements and caller-assisted Investigation surfaces).
 *
 * Composes the REAL Provider-neutral execution seams the CLI uses —
 * `executeSearch` / `executeReaderOperation` over real Provider
 * descriptors — into the engine's `LeanDeps["search"|"read"]` shape.
 * No second registry, no duplicated retry/cache policy: validation,
 * cache identity, read-through, retry classification and consumption
 * events are the shared executor's.
 *
 * Authorized-main correction unit (ticket "Actual authorized-main
 * correction unit released", 2026-10-04) — properties owned here:
 *
 * 1. Transport ownership without caller mutation. Each search()/read()
 *    operation builds its OWN descriptor through the caller-supplied
 *    descriptor FACTORY captured at bridge construction... factories
 *    cannot be recovered from a descriptor, so the caller instead
 *    supplies `transports` and a `descriptorFactory(providerId,
 *    transport)`; the bridge constructs a per-operation descriptor over
 *    a SHALLOW-COPIED transport object (fetch wrapped, env carried).
 *    The caller's transport object is never touched; concurrent
 *    bridges over the same caller transport cannot nest or poison
 *    restoration. Absent transport entry = fail-closed before HTTP
 *    (never an unadvertised unwrapped opt-out), unless the caller
 *    has a map entry with a callable fetch plus the factory.
 * 2. Run-signal + remaining deadline govern headers AND every body
 *    read, and BOTH settle locally without awaiting an uncooperative
 *    transport: the losing race never awaits the pending headers
 *    promise (asynchronous late-response disposal attached instead);
 *    an idle body is cancelled the moment the caller aborts (abort
 *    couples DIRECTLY to reader.cancel, not only to the child
 *    controller).
 * 3. Truthful physical ledger: ONE immutable record created at actual
 *    fetch dispatch (inside the wrapper, which only real client
 *    invokes), terminal outcome updated only after body/normalization
 *    settles — headers success is NOT completion; byte-cap failure,
 *    abort, deadline and parse errors each set their own status;
 *    refusals counted distinctly; unfinished remote work stays
 *    "unknown". Records are frozen deep copies; sinks cannot edit.
 * 4. Serve-following cache provenance: the executor's own cache reads
 *    (normalized key AND legacy candidates) are observed through a
 *    pass-through wrapper; a decoded serve during the serve window
 *    certifies fromCache, anything else is an honest fresh retrieval.
 *    No invented probe keys.
 */

import type { ProviderDescriptor } from "../providers/types.js";
import type { LeanDeps, LeanDispatchOptions, LeanSearchResult } from "./lean-investigation.js";
import {
  executeReaderOperation,
  executeSearch,
  type ExecutionDependencies,
  type RetryPolicy,
} from "./execution.js";
import { buildProviderCacheKey, type ResponseCache } from "./cache.js";
import type { ConsumptionSink } from "./consumption.js";
import { TimeoutError, ValidationError } from "./errors.js";

/** Per-read serve provenance, recorded from the serve itself. */
export interface LeanReadProvenance {
  readonly url: string;
  readonly provider: string;
  readonly finalUrl: string;
  readonly fromCache: boolean;
  /** Pre-serve real-key probe (cacheHits accounting, investigate.ts
   *  boundary). NEVER certifies the serve — race visibility only. */
  readonly cacheProbeWarm: boolean | "unknown";
}

/** Caller-owned transport map keyed by provider id. */
export type LeanTransportMap = Readonly<
  Record<string, { fetch?: unknown; env?: NodeJS.ProcessEnv }>
>;

/** One physically observed HTTP attempt (sanitized: no bodies/headers). */
export interface LeanPhysicalAttempt {
  readonly provider: string;
  readonly path: string;
  readonly outcome: "complete" | "failed" | "refused" | "not-started" | "unknown";
}

/** Bridge-observed physical lifecycle, exposed with the result. */
export interface LeanPhysicalLedger {
  /** Actual fetch dispatches (retries included). */
  readonly attempts: number;
  readonly reservationsRefused: number;
  readonly perAttempt: readonly LeanPhysicalAttempt[];
}

/** Options for {@link createLeanAcquisitionDeps}. */
export interface LeanAcquisitionBridgeOptions {
  /** Descriptor whose adapter serves `.search` (used when transports
   *  entry + factory — see the fail-closed rule). */
  readonly searchDescriptor: ProviderDescriptor;
  /** Descriptor whose adapter serves `.reader.fetch`. */
  readonly readerDescriptor: ProviderDescriptor;
  /**
   * Descriptor factory: builds a descriptor over the per-operation
   * copied transport (e.g. `createTavilyDescriptor({ transport })`).
   * Required for a stage whose provider has an entry in `transports`.
   */
  readonly descriptorFactory?: (providerId: string, transport: unknown) => ProviderDescriptor;
  /**
   * Caller-owned transports keyed by provider id. Per-operation, a
   * shallow COPY of the entry is wrapped and handed to
   * descriptorFactory; the caller's object is never mutated. A stage
   * without a callable entry fails closed (no unwrapped route).
   */
  readonly transports?: LeanTransportMap;
  readonly env: NodeJS.ProcessEnv;
  readonly cache: ResponseCache;
  readonly sleep: (ms: number) => Promise<void>;
  readonly random: () => number;
  readonly retryPolicy?: RetryPolicy;
  readonly now?: () => number;
  readonly consume?: ConsumptionSink;
  /** Physical admission callback BEFORE every underlying HTTP attempt. */
  readonly reservePhysicalAttempt?: () => void;
  /** Per-bridge physical-HTTP ceiling; excess refused before side effects. */
  readonly maxPhysicalAttempts?: number;
  /** Incremental response-body byte ceiling (default 8 MiB dev bound). */
  readonly maxResponseBytes?: number;
  /** Serve-following read provenance sink (appended in call order). */
  readonly onReadProvenance?: (provenance: LeanReadProvenance) => void;
  /** Physical ledger sink (called after every dispatch/refusal). */
  readonly onPhysicalLedger?: (ledger: LeanPhysicalLedger) => void;
}

const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/** Stream-backed transport response consumed by real clients. Missing or
 * non-readable body shapes are unsupported even if json/text exists:
 * an unbounded own reader cannot provide incremental byte enforcement. */
interface FetchResponseLike {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
  json?(): Promise<unknown>;
  readonly body?: unknown;
  readonly headers?: { get(name: string): string | null };
}

type OriginalFetch = (
  input: string | URL,
  init: Record<string, unknown>,
) => Promise<FetchResponseLike>;

function isAbortSignal(value: unknown): value is AbortSignal {
  return typeof (value as AbortSignal | undefined)?.addEventListener === "function";
}

function isReadableStream(value: unknown): value is ReadableStream<Uint8Array> {
  return typeof (value as ReadableStream<Uint8Array> | undefined)?.getReader === "function";
}

/** Race a promise against the deadline; `onExpire` cancels owned work.
 *  The losing promise is NEVER awaited unboundedly (property 2). */
function withDeadline<T>(
  promise: Promise<T>,
  deadlineAt: number,
  onExpire: () => void,
  what: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    const remaining = deadlineAt - Date.now();
    timer = setTimeout(
      () => {
        onExpire();
        reject(
          new TimeoutError(Math.max(0, remaining), `${what} exceeded the remaining run deadline`),
        );
      },
      Math.max(0, remaining),
    );
  });
  return Promise.race([promise, expiry]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  }) as Promise<T>;
}

/**
 * Late-response disposal (current-mechanism review P1): an UNCONDITIONAL
 * asynchronous continuation is attached to the lost-race headers promise
 * — whenever it eventually settles, its body stream is cancelled. A
 * short bounded grace additionally lets a promptly-arriving response's
 * cancellation be observable synchronously with the local rejection
 * (caller-aborted case); a transport that outlives the grace releases
 * the local rejection while disposal continues attached, never awaited
 * and never leaking the eventually-arriving stream.
 */
const BODY_DISPOSAL_GRACE_MS = 25;
/** Abort grace (engineering detail): after a caller abort the headers
 *  race rejects after this window — prompt, but wide enough that a
 *  promptly-arriving response's body cancellation is observable. */
const ABORT_GRACE_MS = 35;

function disposeLateResponse(pending: Promise<FetchResponseLike>): void {
  // Unconditional async disposal, independent of any local wait.
  void pending.then(
    (late) => {
      const lateBody = (late as { body?: unknown }).body;
      if (isReadableStream(lateBody)) void lateBody.cancel().catch(() => {});
    },
    () => {},
  );
}

async function disposePendingBounded(pending: Promise<FetchResponseLike>): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      pending.then(
        async (late) => {
          if (isReadableStream(late.body)) await late.body.cancel().catch(() => {});
        },
        () => {},
      ),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, BODY_DISPOSAL_GRACE_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Per-operation wrapper state. `ledgerEntry` is created ONLY at actual
 * fetch dispatch (the wrapper body), mutated to a terminal outcome
 * after body/normalization settles, then frozen.
 */
interface OperationState {
  cancellationUnconfirmed: boolean;
  runSignal: AbortSignal | undefined;
  deadlineAt: number;
  cap: number;
  provider: string;
  reserve(): void;
  onRefused(path: string): void;
  recordNotStarted(path: string): void;
  begin(path: string): void;
  finish(outcome: "complete" | "failed" | "unknown"): void;
  /** Capability-level outcome: parsed JSON is NOT success — the actual
   *  Provider normalization must settle before the record completes. */
  finishOperation(ok: boolean): void;
  /** Register an active body reader so caller-abort cancels it directly. */
  cancelActiveBody(): void;
  registerBodyCancel(cancel: () => void): void;
}

/** Refuse completion as well as dispatch after the captured allowance. */
function assertOperationActive(state: OperationState): void {
  if (state.runSignal?.aborted === true || Date.now() >= state.deadlineAt) {
    throw new TimeoutError(0, "Acquisition exhausted its remaining operation allowance");
  }
}

/** Cache and retry waits share the operation allowance without changing
 * the executor's cache or retry policy. Late collaborator settlement is
 * observed by the race, but can never publish a late success. */
async function withinOperation<T>(
  state: OperationState,
  action: () => Promise<T>,
  what: string,
): Promise<T> {
  assertOperationActive(state);
  let detach: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = (): void => reject(new TimeoutError(0, "Acquisition was aborted by the caller"));
    state.runSignal?.addEventListener("abort", onAbort, { once: true });
    detach = () => state.runSignal?.removeEventListener("abort", onAbort);
  });
  const pending = Promise.resolve().then(() => {
    assertOperationActive(state);
    return action();
  });
  try {
    const value = await withDeadline(Promise.race([pending, aborted]), state.deadlineAt, () => {}, what);
    assertOperationActive(state);
    return value;
  } finally {
    detach?.();
  }
}

/** Bounded incremental body read with deadline racing + idle-abort. */
async function readBodyBounded(
  response: FetchResponseLike,
  state: OperationState,
  isAborted: () => boolean,
  dispose: () => void,
): Promise<string | unknown> {
  try {
    const body = response.body;
    if (!isReadableStream(body)) {
      // An own json()/text() reader can buffer arbitrary input before
      // returning, so it cannot honor the incremental byte contract.
      // Fail closed BEFORE invoking it; native Response streams take
      // the bounded path below (including idle-abort cancellation).
      throw new TimeoutError(0, "Acquisition requires a readable response body stream");
    }
    const reader = body.getReader();
    let cancellation: Promise<boolean> | undefined;
    const cancelReader = (): Promise<boolean> => {
      cancellation ??= reader.cancel().then(
        () => true,
        () => false,
      );
      return cancellation;
    };
    const cancelBounded = async (): Promise<void> => {
      let timer: NodeJS.Timeout | undefined;
      try {
        const completed = await Promise.race([
          cancelReader(),
          new Promise<boolean>((resolve) => {
            timer = setTimeout(
              () => resolve(false),
              Math.max(0, Math.min(BODY_DISPOSAL_GRACE_MS, state.deadlineAt - Date.now())),
            );
          }),
        ]);
        if (!completed) state.cancellationUnconfirmed = true;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    };
    // Idle-abort coupling: from now on a caller abort cancels THIS
    // reader immediately (not only at the next chunk or deadline).
    state.registerBodyCancel(() => {
      void cancelReader();
    });
    const chunks: Uint8Array[] = [];
    let total = 0;
    const readChunk = (): Promise<IteratorResult<Uint8Array>> =>
      withDeadline(
        reader.read() as Promise<IteratorResult<Uint8Array>>,
        state.deadlineAt,
        () => {
          void cancelReader();
        },
        "Tavily response body",
      );
    try {
      for (;;) {
        if (isAborted())
          throw new TimeoutError(0, "Tavily response body was aborted by the caller");
        const { done, value } = await readChunk();
        if (done) {
          if (isAborted()) throw new TimeoutError(0, "Response body aborted before completion");
          break;
        }
        if (value !== undefined) {
          total += value.byteLength;
          if (total > state.cap) {
            await cancelBounded();
            throw new TimeoutError(
              state.cap,
              `Tavily response body exceeded the ${state.cap}-byte ceiling and was cancelled`,
            );
          }
          chunks.push(value);
        }
      }
    } catch (error) {
      await cancelBounded();
      throw error;
    } finally {
      reader.releaseLock();
    }
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(joined);
  } finally {
    dispose();
  }
}

/** Wrap one fetch for ONE operation over a COPIED transport (see
 *  property 1) with the truthful ledger (property 3). */
function wrapFetchForOperation(original: OriginalFetch, state: OperationState, notify: () => void): OriginalFetch {
  return async (input: string | URL, init: Record<string, unknown>): Promise<FetchResponseLike> => {
    let path = String(input);
    try {
      path = new URL(String(input)).pathname;
    } catch {
      /* keep raw string */
    }

    // Cache lookup and retry sleep belong to this operation's original
    // allowance. Expiry refuses dispatch before reserving a native attempt.
    if (Date.now() >= state.deadlineAt) {
      state.recordNotStarted(path);
      throw new TimeoutError(0, "Acquisition remaining operation deadline expired before native dispatch");
    }

    const runSignal = state.runSignal;
    const callerAborted = (): boolean =>
      (runSignal as { aborted?: boolean } | undefined)?.aborted === true;
    const clientSignal = init?.signal;
    if (callerAborted() || (isAbortSignal(clientSignal) && clientSignal.aborted)) {
      state.recordNotStarted(path);
      throw new TimeoutError(0, "Tavily request was aborted before dispatch");
    }

    // Admission first. A refusal is recorded and thrown — never a
    // dispatched attempt, never zero-work certification.
    try {
      state.reserve();
    } catch (error) {
      state.onRefused(path);
      throw error;
    }

    if (runSignal?.aborted === true || (isAbortSignal(clientSignal) && clientSignal.aborted)) {
      // Pre-aborted: the fetch was never started — a refusal-shaped
      // fact, NOT a dispatched attempt (attempts count native fetches).
      state.recordNotStarted(path);
      throw new TimeoutError(0, "Tavily request was aborted before dispatch");
    }

    // Caller-owned reservation hooks may themselves consume the allowance.
    // Recheck at the native boundary without recording a physical dispatch.
    if (Date.now() >= state.deadlineAt) {
      state.recordNotStarted(path);
      throw new TimeoutError(0, "Acquisition remaining operation deadline expired before native dispatch");
    }

    const child = new AbortController();
    let childAborted = false;
    const abortChild = (): void => {
      childAborted = true;
      child.abort();
    };
    let bodyCancel: (() => void) | undefined;
    state.registerBodyCancel = (cancel: () => void): void => {
      bodyCancel = cancel;
      // An abort that fired BEFORE the reader was acquired must still
      // cancel it the moment registration happens — a late registration
      // can never strand an idle body until the next chunk or deadline.
      if (childAborted || callerAborted()) cancel();
    };
    const abortAll = (): void => {
      abortChild();
      bodyCancel?.();
    };
    state.cancelActiveBody = () => {
      bodyCancel?.();
    };
    runSignal?.addEventListener("abort", abortAll, { once: true });
    if (isAbortSignal(clientSignal))
      clientSignal.addEventListener("abort", abortAll, { once: true });

    let cleaned = false;
    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      runSignal?.removeEventListener("abort", abortAll);
      if (isAbortSignal(clientSignal)) clientSignal.removeEventListener("abort", abortAll);
    };
    const dispose = (): void => {
      cleanup();
      child.abort();
    };
    const isAborted = (): boolean => childAborted || runSignal?.aborted === true;

    const nativeInit = { ...init, signal: child.signal };
    // Finish synchronous setup before admitting the actual native call.
    // Refusal creates no counted row and cannot finish a previous retry.
    if (Date.now() >= state.deadlineAt || callerAborted() ||
        (isAbortSignal(clientSignal) && clientSignal.aborted)) {
      dispose();
      state.recordNotStarted(path);
      throw new TimeoutError(0, "Acquisition allowance ended before native dispatch");
    }
    // No caller callback intervenes between private bookkeeping and dispatch.
    state.begin(path);
    try {
      const pending = original(input, nativeInit);
      let response: FetchResponseLike;
      let rejectedByAbortRace = false;
      try {
        // The public sink observes actual dispatch, within pending-response
        // disposal so an observer error cannot strand native headers/body.
        notify();
        // Headers race the remaining deadline AND both abort signals —
        // a caller abort settles the race immediately (never waiting
        // out the whole remaining deadline), the losing promise is
        // never awaited, and listeners/timers are released.
        // Caller/client abort races the headers with a short ABORT GRACE:
        // rejection is prompt (never the whole remaining deadline), but a
        // promptly-arriving response's body cancellation stays observable
        // synchronously with the rejection. The listener detaches on every
        // settle path — success included.
        let detachAbortRace: (() => void) | undefined;
        let abortTimer: NodeJS.Timeout | undefined;
        const abortRace = new Promise<never>((_resolve, reject) => {
          if (callerAborted() || (isAbortSignal(clientSignal) && clientSignal.aborted)) {
            abortAll();
            disposeLateResponse(pending);
            abortTimer = setTimeout(() => {
              rejectedByAbortRace = true;
              reject(new TimeoutError(0, "Tavily headers were aborted by the caller"));
            }, ABORT_GRACE_MS);
            return;
          }
          const onRaceAbort = (): void => {
            abortAll();
            // Attach late-response disposal AT ABORT TIME: whenever the
            // pending headers promise eventually settles, its body is
            // cancelled immediately — observable even when the local
            // rejection surfaces first.
            disposeLateResponse(pending);
            abortTimer = setTimeout(() => {
              rejectedByAbortRace = true;
              reject(new TimeoutError(0, "Tavily headers were aborted by the caller"));
            }, ABORT_GRACE_MS);
          };
          runSignal?.addEventListener("abort", onRaceAbort, { once: true });
          if (isAbortSignal(clientSignal))
            clientSignal.addEventListener("abort", onRaceAbort, { once: true });
          detachAbortRace = (): void => {
            runSignal?.removeEventListener("abort", onRaceAbort);
            if (isAbortSignal(clientSignal)) clientSignal.removeEventListener("abort", onRaceAbort);
          };
        });
        try {
          response = await withDeadline(
            Promise.race([pending, abortRace]),
            state.deadlineAt,
            abortAll,
            "Tavily headers",
          );
        } finally {
          detachAbortRace?.();
          if (abortTimer !== undefined) clearTimeout(abortTimer);
        }
      } catch (headersError) {
        // Unconditional async disposal of the eventually-arriving body.
        // The bounded wait runs ONLY for deadline-origin losses — an
        // abort-origin rejection already spent its abort grace here, and
        // a second wait would compound latency; disposal continues
        // attached (disposeLateResponse) without delaying the rejection.
        disposeLateResponse(pending);
        if (!rejectedByAbortRace) {
          await disposePendingBounded(pending);
        }
        throw headersError;
      }
      const headers = response.headers;
      let settled = false;
      const settleLedger = (outcome: "complete" | "failed" | "unknown"): void => {
        if (settled) return;
        settled = true;
        state.finish(outcome);
      };
      return {
        ok: response.ok,
        status: response.status,
        ...(headers !== undefined ? { headers } : {}),
        text: (): Promise<string> =>
          readBodyBounded(response, state, isAborted, dispose)
            .then((v) => {
              const rendered = typeof v === "string" ? v : JSON.stringify(v);
              settleLedger(isAborted() ? "unknown" : "complete");
              return rendered;
            })
            .catch((error) => {
              settleLedger("failed");
              throw error;
            }),
        json: async (): Promise<unknown> => {
          try {
            const value = await readBodyBounded(response, state, isAborted, dispose);
            if (isAborted()) {
              // Late success after abort: never normalized into coverage.
              settleLedger("unknown");
              throw new TimeoutError(0, "Tavily response body was aborted by the caller");
            }
            // Complete only after the intended parse succeeds — malformed
            // JSON is a FAILED physical outcome, never complete
            // (current-mechanism review P1).
            const parsed = typeof value === "string" ? JSON.parse(value) : value;
            settleLedger("complete");
            return parsed;
          } catch (error) {
            settleLedger("failed");
            throw error;
          }
        },
      } as FetchResponseLike;
    } catch (error) {
      dispose();
      // An aborted/lost race leaves a possibly still-running native
      // request unobserved — remote-unknown, never confidently failed.
      state.finish("unknown");
      throw error;
    }
  };
}

/**
 * Build engine `search`/`read` deps over the real execution seams with
 * per-operation transport copying and the truthful physical ledger.
 */
export function createLeanAcquisitionDeps(
  options: LeanAcquisitionBridgeOptions,
): Pick<LeanDeps, "search" | "read"> & { readonly physicalLedger: LeanPhysicalLedger } {
  const executionDeps: ExecutionDependencies = {
    cache: options.cache,
    sleep: options.sleep,
    random: options.random,
    ...(options.consume !== undefined ? { consume: options.consume } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  };

  const executionFor = (state: OperationState): ExecutionDependencies => ({
    ...executionDeps,
    cache: {
      get: ((key: string, decoder?: (raw: unknown) => unknown) =>
        withinOperation(
          state,
          () => decoder === undefined ? options.cache.get(key) : options.cache.get(key, decoder),
          "Acquisition cache read",
        )) as ResponseCache["get"],
      set: (key, value) => withinOperation(state, () => options.cache.set(key, value), "Acquisition cache write"),
    },
    sleep: (ms) => withinOperation(state, () => options.sleep(ms), "Acquisition retry wait"),
  });

  // ---- Physical ledger (immutable deep copies; property 3) ----
  const records: LeanPhysicalAttempt[] = [];
  let reservationsRefused = 0;
  let physicalAttempts = 0;
  const cap = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (!Number.isFinite(cap) || cap < 0) {
    throw new ValidationError("maxResponseBytes must be finite and nonnegative");
  }
  const notify = (): void => {
    options.onPhysicalLedger?.(ledgerSnapshot());
  };
  const ledgerSnapshot = (): LeanPhysicalLedger => ({
    // `attempts` counts ACTUAL native fetch dispatches only — refused
    // and not-started records are excluded (they are visible in
    // perAttempt with their own outcomes).
    attempts: records.filter((r) => r.outcome !== "refused" && r.outcome !== "not-started").length,
    reservationsRefused,
    perAttempt: records.map((r) => Object.freeze({ ...r })),
  });
  const reserve = (): void => {
    if (
      options.maxPhysicalAttempts !== undefined &&
      physicalAttempts + 1 > options.maxPhysicalAttempts
    ) {
      reservationsRefused += 1;
      notify();
      throw new TimeoutError(
        0,
        `Acquisition exceeded the ${options.maxPhysicalAttempts}-attempt physical HTTP ceiling`,
      );
    }
    try {
      options.reservePhysicalAttempt?.();
    } catch (error) {
      // An external reservation refusal counts even when the callback
      // throws before any internal bookkeeping.
      reservationsRefused += 1;
      notify();
      throw error;
    }
    physicalAttempts += 1;
  };

  const buildState = (
    providerId: string,
    dispatch: LeanDispatchOptions | undefined,
  ): OperationState => {
    let entry: { index: number } | undefined;
    const state: OperationState = {
      cancellationUnconfirmed: false,
      runSignal: dispatch?.signal,
      deadlineAt: Date.now() + (dispatch?.timeoutMs ?? 60_000),
      cap,
      provider: providerId,
      reserve,
      // Refused/not-started facts live OUTSIDE `attempts` (which counts
      // actual native fetch dispatches); they are visible in the ledger
      // snapshot's perAttempt list with their distinct outcomes.
      onRefused: (path: string): void => {
        records.push({ provider: providerId, path, outcome: "refused" });
        notify();
      },
      recordNotStarted: (path: string): void => {
        records.push({ provider: providerId, path, outcome: "not-started" });
        notify();
      },
      begin: (path: string): void => {
        state.cancellationUnconfirmed = false;
        records.push({ provider: providerId, path, outcome: "unknown" });
        entry = { index: records.length - 1 };
      },
      finishOperation: (ok: boolean): void => {
        if (entry === undefined) return;
        const current = records[entry.index];
        if (current === undefined) return;
        // Only DOWNGRADE a wire-level complete to failed when the
        // normalized operation rejected; wire success + normalization
        // failure is a failed acquisition attempt, not complete.
        if (!ok && current.outcome === "complete") {
          records[entry.index] = {
            provider: current.provider,
            path: current.path,
            outcome: "failed",
          };
          notify();
        }
      },
      finish: (outcome: "complete" | "failed" | "unknown"): void => {
        if (entry === undefined) return;
        const previous = records[entry.index];
        if (previous !== undefined) {
          records[entry.index] = {
            provider: previous.provider,
            path: previous.path,
            outcome: state.cancellationUnconfirmed ? "unknown" : outcome,
          };
        }
        notify();
      },
      registerBodyCancel: (): void => {},
      cancelActiveBody: (): void => {},
    };
    return state;
  };

  // Raw-fetch snapshot (current-mechanism review P1): the ORIGINAL
  // fetch of each declared transport is captured ONCE at bridge
  // construction. Even if a caller's descriptorFactory publishes an
  // operation-owned wrapped copy back into the map, later operations
  // wrap the captured raw fetch — never a nested wrapper, never an
  // inherited expired deadline or reservation state.
  const rawFetches = new Map<string, OriginalFetch>();
  for (const [id, transport] of Object.entries(options.transports ?? {})) {
    if (transport !== undefined && typeof transport.fetch === "function") {
      rawFetches.set(id, transport.fetch as OriginalFetch);
    }
  }

  // ---- Per-operation descriptor construction (property 1) ----
  const stageCapability = (
    stage: "search" | "reader",
    providerId: string,
    dispatch: LeanDispatchOptions | undefined,
  ): { capability: { invoke: unknown; decodeCached?: (raw: unknown) => unknown }; state: OperationState } => {
    const transport = options.transports?.[providerId];
    if (
      options.transports === undefined ||
      transport === undefined ||
      typeof transport.fetch !== "function"
    ) {
      // EVERY selected provider must have a callable bounded transport:
      // a missing map OR a missing/invalid entry fails closed before
      // any dispatch (current-mechanism review P1 — no unwrapped route,
      // no unwrapped route).
      throw new TimeoutError(
        0,
        `Provider "${providerId}" has no callable bounded transport in this run: must fail closed instead of unwrapped counted-as-zero work.`,
      );
    }
    if (options.descriptorFactory === undefined) {
      throw new TimeoutError(
        0,
        `Provider "${providerId}" requires an operation-local descriptorFactory in this bounded run.`,
      );
    }
    const state = buildState(providerId, dispatch);
    const rawFetch = rawFetches.get(providerId) ?? (transport.fetch as OriginalFetch);
    const copy = { ...transport, fetch: wrapFetchForOperation(rawFetch, state, notify) };
    const descriptor = options.descriptorFactory(providerId, copy);
    const capability = capabilityOf(descriptor, stage) as {
      invoke: (request: unknown, signal?: AbortSignal, count?: number) => Promise<unknown>;
      decodeCached?: (raw: unknown) => unknown;
      cacheIdentity?: (request: unknown) => {
        provider: string;
        capability: string;
        operation: string;
        credentialFingerprint: string;
        request: unknown;
        legacyCandidates?: readonly { key: string; decode(raw: unknown): unknown }[];
      };
    };
    const inner = capability.invoke.bind(capability);
    const invoke = async (
      request: unknown,
      signal?: AbortSignal,
      count?: number,
    ): Promise<unknown> => {
      try {
        const result = await inner(request, signal, count);
        state.finishOperation(true);
        return result;
      } catch (error) {
        state.finishOperation(false);
        throw error;
      }
    };
    return { capability: { ...capability, invoke }, state };
  };

  const capabilityOf = (
    descriptor: ProviderDescriptor,
    stage: "search" | "reader",
  ): { invoke: unknown; decodeCached?: (raw: unknown) => unknown } => {
    const adapter = descriptor.create({ env: options.env });
    if (stage === "search") {
      const capability = adapter.search;
      if (capability === undefined) {
        throw new Error(`Provider "${descriptor.id}" does not serve the search capability.`);
      }
      return capability as unknown as { invoke: unknown };
    }
    const reader = adapter.reader;
    if (reader === undefined) {
      throw new Error(`Provider "${descriptor.id}" does not serve the reader capability.`);
    }
    return reader.fetch as unknown as { invoke: unknown; decodeCached: (raw: unknown) => unknown };
  };

  return {
    async search(
      query: string,
      dispatch?: LeanDispatchOptions,
    ): Promise<readonly LeanSearchResult[]> {
      const staged = stageCapability("search", options.searchDescriptor.id, dispatch);
      const capability = staged.capability as Parameters<typeof executeSearch>[0];
      assertOperationActive(staged.state);
      const sources = await executeSearch(
        capability,
        { query },
        {
          ...(dispatch?.signal !== undefined ? { signal: dispatch.signal } : {}),
          ...(options.retryPolicy !== undefined ? { retryPolicy: options.retryPolicy } : {}),
        },
        executionFor(staged.state),
      );
      assertOperationActive(staged.state);
      return sources.map((source): LeanSearchResult => ({
        url: source.url,
        ...(source.title !== undefined && source.title !== "" ? { title: source.title } : {}),
      }));
    },

    async read(url: string, dispatch?: LeanDispatchOptions): Promise<string> {
      const staged = stageCapability("reader", options.readerDescriptor.id, dispatch);
      const operation = staged.capability as Parameters<typeof executeReaderOperation>[0];
      const operationDeps = executionFor(staged.state);
      assertOperationActive(staged.state);
      operation.validate({ url });
      // Serve-following provenance (property 4, current-mechanism
      // review): the executor's OWN cache reads (normalized key and
      // legacy candidates) are observed through a pass-through wrapper;
      // a raw value the operation's decoder chain ACCEPTS during the
      // serve certifies fromCache. A pre-serve REAL-KEY probe performs
      // the same production cacheHits accounting investigate.ts does
      // (purposeful instrumentation, not invented-key I/O): its result
      // is reported separately as `cacheProbeWarm` and NEVER certifies
      // the serve — fromCache follows the serve window only.
      let probeWarm: boolean | "unknown" = "unknown";
      try {
        const identity = operation.cacheIdentity({ url });
        const probeKey = buildProviderCacheKey({
          provider: identity.provider,
          capability: `${identity.capability}-${identity.operation}`,
          credentialFingerprint: identity.credentialFingerprint,
          request: identity.request,
        });
        const raw = await operationDeps.cache.get(probeKey);
        probeWarm =
          raw !== null && (operation.decodeCached as (v: unknown) => unknown)(raw) !== null;
      } catch {
        /* probe is accounting only; failure is honest unknown */
      }
      assertOperationActive(staged.state);
      let servedFromCache = false;
      // Only a decoder actually called by the executor certifies a serve.
      const observedOperation: typeof operation = {
        ...operation,
        decodeCached(raw) {
          const decoded = operation.decodeCached(raw);
          if (decoded !== null) servedFromCache = true;
          return decoded;
        },
        cacheIdentity(request) {
          const identity = operation.cacheIdentity(request);
          return {
            ...identity,
            legacyCandidates: identity.legacyCandidates.map((candidate) => ({
              ...candidate,
              decode(raw: unknown) {
                const decoded = candidate.decode(raw);
                if (decoded !== null) servedFromCache = true;
                return decoded;
              },
            })),
          };
        },
      };
      const result = await executeReaderOperation(
        observedOperation,
        { url },
        {
          ...(dispatch?.signal !== undefined ? { signal: dispatch.signal } : {}),
          ...(options.retryPolicy !== undefined ? { retryPolicy: options.retryPolicy } : {}),
        },
        operationDeps,
      );
      assertOperationActive(staged.state);
      options.onReadProvenance?.({
        url,
        provider: options.readerDescriptor.id,
        finalUrl: result.finalUrl,
        fromCache: servedFromCache,
        cacheProbeWarm: probeWarm,
      });
      return result.content;
    },

    physicalLedger: {
      get attempts(): number {
        return ledgerSnapshot().attempts;
      },
      get reservationsRefused(): number {
        return ledgerSnapshot().reservationsRefused;
      },
      get perAttempt(): readonly LeanPhysicalAttempt[] {
        return ledgerSnapshot().perAttempt;
      },
    },
  };
}
