/**
 * Node Command Invocation Adapter (DESIGN.md §2).
 *
 * This is the ONLY Module that reads process streams (`process.stdin`,
 * `process.stdout`, `process.stderr`), detects TTY state, or sets
 * `process.exitCode`. The executable imports `main` and this factory,
 * invokes `main`, and calls `adapter.setExitCode(status)`.
 *
 * `runQuietly` is reentrant and invocation-scoped: it owns
 * dependency-noise suppression (library console output) for the
 * complete command call and restores logging before returning so
 * notices and output are written with logging restored.
 *
 * Requirements: NFR-002, NFR-003, NFR-007.
 */

import type { CommandInvocationAdapter } from "./command-invocation.js";
import { redactCredentialString, configuredSecrets } from "./lib/redact.js";

/**
 * Reentrancy depth for `runQuietly`. Because `console.*` are process-global,
 * overlapping quiet runs must coordinate so that only the outermost call
 * captures the originals and only the outermost exit restores them.
 */
let quietDepth = 0;
let quietOriginals: {
  log: typeof console.log;
  warn: typeof console.warn;
  info: typeof console.info;
  debug: typeof console.debug;
  error: typeof console.error;
} | null = null;

/**
 * Reentrant, process-global console suppression: `console.*` are
 * replaced with no-ops for the duration of `operation` and restored on
 * exit (including on throw). Overlapping runs coordinate through
 * `quietDepth`, so only the outermost run captures and restores the
 * originals — inner runs (a per-op adapter inside an outer quiet run,
 * or several concurrent batch ops) neither double-capture nor
 * prematurely restore.
 *
 * Shared by the Node adapter's `runQuietly` and the batch runner's
 * per-op capture adapters, so a handler or provider library that logs
 * through `console.*` during a batch operation is quieted exactly like
 * a direct command invocation — it can never escape to the process
 * streams and corrupt the batch's single summary write.
 */
export async function runQuietlyWithSuppressedConsole<T>(operation: () => Promise<T>): Promise<T> {
  if (quietDepth === 0) {
    quietOriginals = {
      log: console.log,
      warn: console.warn,
      info: console.info,
      debug: console.debug,
      error: console.error,
    };
    console.log = () => {};
    console.warn = () => {};
    console.info = () => {};
    console.debug = () => {};
    console.error = () => {};
  }
  quietDepth++;
  try {
    return await operation();
  } finally {
    quietDepth--;
    if (quietDepth === 0 && quietOriginals) {
      console.log = quietOriginals.log;
      console.warn = quietOriginals.warn;
      console.info = quietOriginals.info;
      console.debug = quietOriginals.debug;
      console.error = quietOriginals.error;
      quietOriginals = null;
    }
  }
}

/**
 * Format a fatal load-failure message for the executable entrypoint.
 *
 * `bin/scoutline.js` calls this from its dynamic-import `.catch` handler
 * to produce the structured `LOAD_ERROR` envelope that reaches stderr.
 * P4-01 ensures the embedded message is run through the shared
 * `redactCredentialString` so any credential material in the import
 * error text is replaced before the value is emitted.
 */
export function formatLoadFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const redacted = redactCredentialString(message, configuredSecrets());
  const payload: Record<string, unknown> = {
    success: false,
    error: redacted,
    code: "LOAD_ERROR",
    help: 'Make sure to run "npm run build" before running scoutline',
  };
  return JSON.stringify(payload, null, 2);
}

export function createNodeCommandInvocationAdapter(): CommandInvocationAdapter {
  return {
    get stdoutIsTTY(): boolean {
      return process.stdout.isTTY === true;
    },

    get stdinIsTTY(): boolean {
      return process.stdin.isTTY === true;
    },

    get environmentOutputMode(): string | undefined {
      const value = process.env.ZAI_OUTPUT_MODE;
      return typeof value === "string" && value.length > 0 ? value : undefined;
    },

    async readStdin(maxBytes?: number, signal?: AbortSignal): Promise<string> {
      return (await readBytesBounded(process.stdin, maxBytes, signal)).toString("utf8");
    },

    writeStdout(value: string): void {
      process.stdout.write(value + "\n");
    },

    writeStderr(value: string): void {
      // The adapter is the sole authority for trailing newlines on stderr.
      // Strip ALL trailing newlines from the caller's value so that call
      // sites that already include them don't produce double-newline blank lines.
      const normalized = value.replace(/(?:\r?\n)+$/, "");
      process.stderr.write(normalized + "\n");
    },

    async runQuietly<T>(operation: () => Promise<T>): Promise<T> {
      // Reentrancy, capture/restore, and coordination with every other
      // quiet run (including the batch runner's per-op adapters) live in
      // the shared suppression helper.
      return runQuietlyWithSuppressedConsole(operation);
    },

    setExitCode(value: number): void {
      process.exitCode = value;
    },
  };
}

/**
 * Collects an async byte stream into one buffer, stopping as soon as the
 * running total exceeds `maxBytes` (when given): the crossing chunk is
 * kept — its over-cap length is the caller's rejection evidence — and
 * breaking the for-await destroys the stream so an oversized pipe is cut
 * off at the producer instead of drained into memory. Exported for
 * bounded-read tests.
 */
export async function readBytesBounded(
  input: AsyncIterable<Buffer | string>,
  maxBytes?: number,
  /**
   * Optional cancellation (final boundary repair). ABSENT signal: the
   * ORIGINAL for-await semantics — bounded chunk accumulation with the
   * crossing chunk retained, async iterator close AWAITED, and a
   * cleanup rejection propagating outward. PRESENT signal: the read
   * owns the actual iterator; cancelling destroys a Node Readable
   * (unblocking a pending next()), a pre-aborted read rejects without
   * calling next(), and every disposal invocation — synchronous or
   * asynchronous — is contained so the primary AbortError survives.
   */
  signal?: AbortSignal,
): Promise<Buffer> {
  if (signal === undefined) {
    return readBytesBoundedOriginal(input, maxBytes);
  }
  const iterator = input[Symbol.asyncIterator]();
  const abortError = (): Error =>
    Object.assign(new Error("input read cancelled"), { name: "AbortError" });
  /** Invoke a disposal callback that may throw SYNCHRONOUSLY without
   *  letting that failure displace the primary abort error. */
  const safeDispose = (dispose: () => unknown): void => {
    try {
      void Promise.resolve(dispose()).catch(() => undefined);
    } catch {
      // Synchronous return() throw: contained; the cancellation error
      // is the outward contract.
    }
  };
  if (signal.aborted) {
    safeDispose(() => iterator.return?.(undefined));
    return Promise.reject(abortError());
  }
  let onAbort: (() => void) | undefined;
  const dispose = (): void => {
    const destroyable = input as unknown as { destroy?: (error?: Error) => void };
    if (typeof destroyable.destroy === "function") destroyable.destroy(abortError());
    safeDispose(() => iterator.return?.(undefined));
  };
  onAbort = dispose;
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await readBytesBoundedSignalled(iterator, maxBytes, signal);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/**
 * The exact pre-signal implementation, preserved verbatim for every
 * caller that omits the cancellation signal (compatibility, root 1):
 * for-await drives the source, and the language runtime awaits the
 * iterator's return()/propagates its rejection on early exit.
 */
async function readBytesBoundedOriginal(
  input: AsyncIterable<Buffer | string>,
  maxBytes?: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of input) {
    const buffer = chunk instanceof Buffer ? chunk : Buffer.from(chunk);
    chunks.push(buffer);
    total += buffer.length;
    if (maxBytes !== undefined && total > maxBytes) {
      break; // crossing chunk retained
    }
  }
  return Buffer.concat(chunks);
}

/**
 * Signalled variant: drives the OWNED iterator directly, races each
 * chunk wait against the signal, and checks aborted before every step.
 */
async function readBytesBoundedSignalled(
  iterator: AsyncIterator<Buffer | string>,
  maxBytes?: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  // The iterator is OWNED here: every early exit — byte-cap crossing,
  // conversion failure, a throwing next(), cancellation — releases the
  // producer subscription exactly once (guarded by disposed). The
  // PRIMARY error always wins: when one exists, cleanup failure is
  // observed without displacing it. On SUCCESS (or cap crossing, no
  // primary error), an actual close rejection PROPAGATES as the outward
  // failure — the read claims its resource settled, so a failing close
  // cannot silently pass.
  let disposed = false;
  const closeIterator = (propagateRejection: boolean): Promise<unknown> => {
    if (disposed) return Promise.resolve(undefined);
    disposed = true;
    try {
      const settled = Promise.resolve(iterator.return?.(undefined));
      return propagateRejection ? settled : settled.catch(() => undefined);
    } catch (error) {
      if (propagateRejection) throw error;
      return Promise.resolve(undefined);
    }
  };
  try {
    for (;;) {
      if (signal?.aborted === true) {
        throw Object.assign(new Error("input read cancelled"), { name: "AbortError" });
      }
      let step: IteratorResult<Buffer | string>;
      if (signal === undefined) {
        step = await iterator.next();
      } else {
        let onChunkAbort: (() => void) | undefined;
        const cancelled = new Promise<never>((_resolve, reject) => {
          onChunkAbort = () => {
            reject(Object.assign(new Error("input read cancelled"), { name: "AbortError" }));
          };
          signal.addEventListener("abort", onChunkAbort, { once: true });
        });
        try {
          step = (await Promise.race([iterator.next(), cancelled])) as IteratorResult<
            Buffer | string
          >;
        } finally {
          if (onChunkAbort !== undefined) signal.removeEventListener("abort", onChunkAbort);
        }
      }
      if (step.done === true) break;
      const buffer = step.value instanceof Buffer ? step.value : Buffer.from(step.value);
      chunks.push(buffer);
      total += buffer.length;
      if (maxBytes !== undefined && total > maxBytes) {
        break;
      }
    }
  } catch (error) {
    // Early/ex exceptional exit: release the subscription, keep the
    // primary error (cleanup failure is observed, contained). After an
    // ABORT the outer dispose() already released the iterator — no
    // second call.
    if (signal?.aborted !== true) await closeIterator(false);
    throw error;
  }
  // Normal or cap-crossing completion (an abort exited via the catch):
  // no primary error exists, so an actual close rejection PROPAGATES.
  await closeIterator(true);
  return Buffer.concat(chunks);
}
