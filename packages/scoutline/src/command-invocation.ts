/**
 * Command Invocation Seam (DESIGN.md §2).
 *
 * This Module defines the pure invocation contract that separates
 * command behaviour from process effects. `invokeCommand` owns
 * invocation-local presentation, notice storage, and error conversion.
 * The Node Adapter is the only Module that touches process streams,
 * TTY state, and `process.exitCode`.
 *
 * Requirements: NFR-002, NFR-003, NFR-007.
 */

import type { OutputMode } from "./lib/output.js";
import { formatSuccessOutput, formatErrorOutput } from "./lib/output.js";
import { getErrorExitCode } from "./lib/errors.js";
import { redactSecrets, configuredSecrets } from "./lib/redact.js";

export type TextOutputMode = "compact" | "markdown" | "refs" | "tty";

export type CommandPresentations = Readonly<Partial<Record<TextOutputMode, string>>>;

export interface DataCommandResult<T = unknown> {
  readonly kind: "data";
  readonly data: T;
  readonly presentations?: CommandPresentations;
  readonly exitCode?: number;
}

export interface TextCommandResult {
  readonly kind: "text";
  readonly text: string;
  readonly exitCode?: number;
}

export type CommandResult<T = unknown> = DataCommandResult<T> | TextCommandResult;

export interface CommandContext {
  readonly stdinIsTTY: boolean;
  readStdin(): Promise<string>;
  notice(message: string): void;
}

export interface CommandInvocationAdapter {
  readonly stdoutIsTTY: boolean;
  readonly stdinIsTTY: boolean;
  readonly environmentOutputMode?: string;
  readStdin(): Promise<string>;
  writeStdout(value: string): void;
  writeStderr(value: string): void;
  runQuietly<T>(operation: () => Promise<T>): Promise<T>;
  setExitCode(value: number): void;
}

const TEXT_OUTPUT_MODES: readonly TextOutputMode[] = ["compact", "markdown", "refs", "tty"];

function isTextOutputMode(mode: OutputMode): mode is TextOutputMode {
  return (TEXT_OUTPUT_MODES as readonly string[]).includes(mode);
}

/**
 * Select the final output string for a successful CommandResult.
 *
 * - `TextCommandResult`: the text is used verbatim regardless of mode.
 * - `DataCommandResult` in a text-oriented mode: a command-supplied
 *   presentation override is preferred; otherwise the base data is
 *   formatted through `formatSuccessOutput`.
 * - `DataCommandResult` in a data-oriented mode: base data formatted
 *   through `formatSuccessOutput` (data → raw JSON, json/pretty →
 *   success envelope).
 */
function selectOutput(result: CommandResult, outputMode: OutputMode, now: () => number): string {
  if (result.kind === "text") {
    return result.text;
  }

  if (isTextOutputMode(outputMode)) {
    const override = result.presentations?.[outputMode];
    if (typeof override === "string") {
      return override;
    }
  }

  return formatSuccessOutput(result.data, outputMode, now);
}

/**
 * Run command behaviour through the invocation seam.
 *
 * 1. Create invocation-local context and notice storage.
 * 2. Run command behaviour through `runQuietly`.
 * 3. `runQuietly` restores dependency logging before returning.
 * 4. Flush notices to stderr in encounter order.
 * 5. Select a presentation override or the base data.
 * 6. Write one final successful value to stdout.
 * 7. Convert a thrown error into one structured stderr value.
 * 8. Return an exit status without terminating the process.
 *
 * The trailing newline is appended at the Node Adapter boundary, not
 * here, so `invokeCommand` itself is process-effect-free.
 */
export async function invokeCommand(
  adapter: CommandInvocationAdapter,
  behavior: (context: CommandContext) => Promise<CommandResult>,
  outputMode: OutputMode,
  now: () => number = Date.now,
  secrets?: string[],
): Promise<number> {
  const notices: string[] = [];

  const context: CommandContext = {
    stdinIsTTY: adapter.stdinIsTTY,
    readStdin: () => adapter.readStdin(),
    notice: (message: string) => {
      notices.push(message);
    },
  };

  let result: CommandResult;
  try {
    result = await adapter.runQuietly(() => behavior(context));
  } catch (error) {
    for (const notice of notices) {
      adapter.writeStderr(notice);
    }
    // Recursively redact the thrown value at the outward boundary so any
    // credential-shaped field embedded in the error tree — whether in
    // `message`, `cause`, or any custom field — is replaced with the
    // redaction marker before formatting. `formatErrorOutput` then
    // performs an additional string-level pass on the message/help
    // fields it actually serialises.
    //
    // B3: secrets resolved from an injected env (MainDependencies.env)
    // are honoured here so a credential that exists only in the injected
    // env is redacted even when absent from ambient process.env.
    const resolvedSecrets = secrets ?? configuredSecrets();
    const redactedError = redactSecrets(error, resolvedSecrets) as unknown;
    adapter.writeStderr(formatErrorOutput(redactedError, outputMode, resolvedSecrets));
    return getErrorExitCode(error);
  }

  for (const notice of notices) {
    adapter.writeStderr(notice);
  }

  adapter.writeStdout(selectOutput(result, outputMode, now));

  return result.exitCode ?? 0;
}
