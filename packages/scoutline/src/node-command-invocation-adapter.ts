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
export async function runQuietlyWithSuppressedConsole<T>(
  operation: () => Promise<T>,
): Promise<T> {
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

    async readStdin(maxBytes?: number): Promise<string> {
      return (await readBytesBounded(process.stdin, maxBytes)).toString("utf8");
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
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of input) {
    const buffer = chunk instanceof Buffer ? chunk : Buffer.from(chunk);
    chunks.push(buffer);
    total += buffer.length;
    if (maxBytes !== undefined && total > maxBytes) {
      break;
    }
  }
  return Buffer.concat(chunks);
}
