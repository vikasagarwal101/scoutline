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
  readStdin(maxBytes?: number): Promise<string>;
  notice(message: string): void;
}

export interface CommandInvocationAdapter {
  readonly stdoutIsTTY: boolean;
  readonly stdinIsTTY: boolean;
  readonly environmentOutputMode?: string;
  readStdin(maxBytes?: number): Promise<string>;
  writeStdout(value: string): void;
  writeStderr(value: string): void;
  runQuietly<T>(operation: () => Promise<T>): Promise<T>;
  setExitCode(value: number): void;
}

/**
 * Input handed to the optional save hook (save-artifacts T4). The seam
 * passes the successful CommandResult, the SAME resolved secrets the
 * output boundary redacts with, the invocation clock, and the notice
 * channel - a hook notice rides the existing stderr flush ahead of the
 * stdout write, so saving never reorders documented output.
 */
export interface SaveHookContext {
  readonly result: CommandResult;
  readonly resolvedSecrets: string[];
  readonly now: () => number;
  readonly notice: (message: string) => void;
}

/**
 * Optional post-behavior save hook (save-artifacts T4). Present only for
 * a save-capable command run with --save; every existing call site omits
 * it and is byte-identical to the pre-T4 seam. A hook throw rides the
 * existing catch: notices flush, one error envelope, no stdout.
 */
export type SaveHook = (context: SaveHookContext) => Promise<void>;

const TEXT_OUTPUT_MODES: readonly TextOutputMode[] = ["compact", "markdown", "refs", "tty"];

function isTextOutputMode(mode: OutputMode): mode is TextOutputMode {
  return (TEXT_OUTPUT_MODES as readonly string[]).includes(mode);
}

/**
 * Select the final output string for a successful CommandResult.
 *
 * - `TextCommandResult`: the text is redacted and used regardless of mode.
 * - `DataCommandResult` in a text-oriented mode: a command-supplied
 *   presentation override is preferred (redacted); otherwise the base
 *   data is redacted and formatted through `formatSuccessOutput`.
 * - `DataCommandResult` in a data-oriented mode: redacted base data
 *   formatted through `formatSuccessOutput` (data → raw JSON, json/pretty
 *   → success envelope).
 *
 * F1 (code-review-baseline): success-path output is redacted at this
 * boundary so a credential-shaped field embedded in provider output
 * (most exposed via `scoutline call <raw-tool>` and `scoutline read`)
 * never reaches stdout. The error path already redacted; the success
 * path now matches the documented "every outward boundary" contract.
 * Redaction is a no-op for normalised Capability data (it carries no
 * credential-shaped fields), so legitimate output is unchanged.
 */
function selectOutput(
  result: CommandResult,
  outputMode: OutputMode,
  now: () => number,
  secrets: string[],
): string {
  if (result.kind === "text") {
    return redactSecrets(result.text, secrets) as string;
  }

  if (isTextOutputMode(outputMode)) {
    const override = result.presentations?.[outputMode];
    if (typeof override === "string") {
      return redactSecrets(override, secrets) as string;
    }
  }

  const redactedData = redactSecrets(result.data, secrets);
  return formatSuccessOutput(redactedData, outputMode, now);
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
  save?: SaveHook,
): Promise<number> {
  const notices: string[] = [];

  // F1: resolve secrets once and redact at BOTH the success-output and
  // error boundaries. Previously only the error path consumed `secrets`;
  // the success path emitted `result.data`/presentations verbatim. This
  // honours injected env credentials (`MainDependencies.env`) even when
  // they are absent from ambient process.env.
  const resolvedSecrets = secrets ?? configuredSecrets();

  const context: CommandContext = {
    stdinIsTTY: adapter.stdinIsTTY,
    readStdin: (maxBytes?: number) => adapter.readStdin(maxBytes),
    notice: (message: string) => {
      notices.push(message);
    },
  };

  let result: CommandResult;
  try {
    result = await adapter.runQuietly(() => behavior(context));
    // save-artifacts T4: the hook runs INSIDE the try, after the behavior
    // produced its result and before any stdout write. A failure rides the
    // existing catch below (notices flushed, one error envelope, stdout
    // suppressed). With no hook this is a no-op.
    if (save !== undefined) {
      await save({ result, resolvedSecrets, now, notice: context.notice });
    }
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
    const redactedError = redactSecrets(error, resolvedSecrets) as unknown;
    adapter.writeStderr(formatErrorOutput(redactedError, outputMode, resolvedSecrets));
    return getErrorExitCode(error);
  }

  for (const notice of notices) {
    adapter.writeStderr(notice);
  }

  adapter.writeStdout(selectOutput(result, outputMode, now, resolvedSecrets));

  return result.exitCode ?? 0;
}
