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

    async readStdin(): Promise<string> {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) {
        chunks.push(chunk instanceof Buffer ? chunk : Buffer.from(chunk));
      }
      return Buffer.concat(chunks).toString("utf8");
    },

    writeStdout(value: string): void {
      process.stdout.write(value + "\n");
    },

    writeStderr(value: string): void {
      process.stderr.write(value + "\n");
    },

    async runQuietly<T>(operation: () => Promise<T>): Promise<T> {
      const originals = {
        log: console.log,
        warn: console.warn,
        info: console.info,
        debug: console.debug,
      };
      console.log = () => {};
      console.warn = () => {};
      console.info = () => {};
      console.debug = () => {};
      try {
        return await operation();
      } finally {
        console.log = originals.log;
        console.warn = originals.warn;
        console.info = originals.info;
        console.debug = originals.debug;
      }
    },

    setExitCode(value: number): void {
      process.exitCode = value;
    },
  };
}
