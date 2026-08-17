/**
 * Batch Runner module (batch-runner DESIGN D5, D6, D8, D9).
 *
 * Executes an already-parsed manifest (D2) against an already-computed
 * provider assignment (D4, `batch-assign.ts`): per op it builds
 * `{...handlerDeps, provider, invocation}` where `invocation` is a
 * capture adapter buffering stdout/stderr, and calls the SAME handler
 * the main dispatch switch calls, forced to data mode, through a
 * bounded worker pool (manifest-order scheduling, drain-safe fail-fast).
 *
 * Process effects: the runner performs exactly ONE stdout write — the
 * summary envelope (D6) through `formatSuccessOutput` for the ambient
 * output mode — on the invocation adapter it is handed (the global
 * one). Everything the ops emit stays inside their per-op records.
 * Batch-level failures (validation, alignment) throw BEFORE any write,
 * so the caller (`handleBatch`, Ticket 4) owns the process-level error
 * envelope.
 *
 * The pool task wraps every handler invocation in try/catch: handlers
 * that throw `ValidationError` synchronously BEFORE entering
 * `invokeCommand` (repo parse-level checks, search `--type`/`--topic`
 * mutual exclusion, vision's operation switch) are converted into a
 * per-op failure whose `stderr` is byte-identical to what
 * `invokeCommand`'s own catch would have produced (`redactSecrets` →
 * `formatErrorOutput` in the op's data mode).
 *
 * D9: after a SUCCESSFUL op that declared an `output` target, the
 * captured stdout is persisted through a write-temp-then-rename seam so
 * readers never observe a half-written file. A write failure never
 * flips `ok` or the envelope counters — it is recorded as
 * `outputWriteError` on the op's record, so `total = ok + failed`
 * always holds. Ops that failed, and ops never scheduled because of
 * `--fail-fast`, write nothing.
 */

import { rename as fsRename, writeFile as fsWriteFile } from "node:fs/promises";
import { ValidationError, getErrorExitCode } from "./errors.js";
import { formatErrorOutput, formatSuccessOutput } from "./output.js";
import type { OutputMode } from "./output.js";
import { redactSecrets } from "./redact.js";
import { compileInput } from "./batch-manifest.js";
import type { AllowedBatchCommand, BatchManifest, BatchOperation } from "./batch-manifest.js";
import type { BatchProviderAssignment } from "./batch-assign.js";
import type { CommandInvocationAdapter } from "../command-invocation.js";
import type { HandlerDependencies } from "../index.js";
import type { ProviderId } from "../providers/types.js";

// ---------------------------------------------------------------------------
// D8 — bounded pool constants
// ---------------------------------------------------------------------------

/** Parallel-by-default posture (DESIGN D8); `vision batch` overrides to 1. */
export const BATCH_DEFAULT_CONCURRENCY = 4;

/** Hard ceiling for `--concurrency` (validation, not clamping). */
export const BATCH_MAX_CONCURRENCY = 8;

/** `stderr` of an op that was never scheduled because of `--fail-fast`. */
export const BATCH_NOT_RUN_STDERR = "not run (--fail-fast)";

/** Ops always run in data mode so captured stdout is raw JSON by construction (D6). */
const OP_OUTPUT_MODE: OutputMode = "data";

// ---------------------------------------------------------------------------
// Contracts (D6)
// ---------------------------------------------------------------------------

/**
 * A batch operation handler: the same shape the main dispatch switch
 * calls (`handleX(commandArgs, outputMode, handlerDeps) → exit code`).
 */
export type BatchOperationHandler = (
  args: string[],
  outputMode: OutputMode,
  deps: HandlerDependencies,
) => Promise<number>;

/** Injected dependencies. All of them are doubles in tests. */
export interface BatchRunnerDeps {
  /** The same object the main switch passes (`handlerDepsWithSelection`). */
  readonly handlerDeps: HandlerDependencies;
  /** One handler per allowed command; the spread-overrides seam is D5. */
  readonly handlers: Readonly<Record<AllowedBatchCommand, BatchOperationHandler>>;
  /** The GLOBAL invocation adapter — receives exactly one summary write. */
  readonly invocation: CommandInvocationAdapter;
  /** Ambient `--output-format`; the summary is formatted through it. */
  readonly outputMode: OutputMode;
  readonly now?: () => number;
  /**
   * D9 per-op output write seam (temp file write). Defaults to the real
   * `node:fs/promises` `writeFile`; tests inject doubles to observe or
   * fail the write.
   */
  readonly writeOutputFile?: (path: string, data: string) => Promise<void>;
  /**
   * D9 per-op output rename seam (atomic land over the target).
   * Defaults to the real `node:fs/promises` `rename`.
   */
  readonly renameOutputFile?: (from: string, to: string) => Promise<void>;
}

export interface BatchRunOptions {
  /** Integer in 1..8 (D8); defaults to {@link BATCH_DEFAULT_CONCURRENCY}. */
  readonly concurrency?: number;
  /** Stop scheduling on the first failed completion; drain in-flight ops. */
  readonly failFast?: boolean;
}

/** One manifest operation's outcome. `results[]` stays 1:1 with the manifest. */
export interface BatchRunRecord {
  readonly name: string;
  readonly command: AllowedBatchCommand;
  readonly ok: boolean;
  readonly exitCode: number;
  /** The assignment made visible (D6): pin or round-robin distribution. */
  readonly resolvedProvider: ProviderId;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly durationMs: number;
  /**
   * Per-op output file target, present on every SCHEDULED op that
   * declared one (the file exists only after a successful write, D9).
   */
  readonly output?: string;
  /** D9 write failure message; never flips `ok` or the counters. */
  readonly outputWriteError?: string;
}

/** The stable v1 summary envelope (D6, D12). Written to stdout exactly once. */
export interface BatchRunEnvelope {
  readonly schemaVersion: 1;
  readonly total: number;
  readonly ok: number;
  readonly failed: number;
  readonly durationMs: number;
  readonly concurrency: number;
  /** Present only in dry runs (Ticket 6, D7). */
  readonly dryRun?: true;
  /** Present only when `--fail-fast` was set AND triggered (D6). */
  readonly failFast?: true;
  readonly results: readonly BatchRunRecord[];
}

// ---------------------------------------------------------------------------
// D5 — per-op capture adapter
// ---------------------------------------------------------------------------

interface PerOpCapture {
  readonly adapter: CommandInvocationAdapter;
  stdoutText(): string;
  stderrText(): string;
}

/**
 * Buffering `CommandInvocationAdapter` for one operation: stdout/stderr
 * append to per-op buffers, `setExitCode` records (the record's exit
 * code comes from the handler's return value, identical to the main
 * switch), `readStdin` throws (D1 — the manifest owns stdin), and TTY
 * flags read `false`.
 */
function createPerOpCapture(): PerOpCapture {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  return {
    adapter: {
      stdoutIsTTY: false,
      stdinIsTTY: false,
      readStdin(): Promise<string> {
        throw new ValidationError(
          "batch operations cannot read stdin (the manifest owns stdin; pass it via 'scoutline batch -')",
        );
      },
      writeStdout: (value: string): void => {
        stdoutChunks.push(value);
      },
      writeStderr: (value: string): void => {
        stderrChunks.push(value);
      },
      runQuietly: <T>(operation: () => Promise<T>): Promise<T> => operation(),
      setExitCode: (_value: number): void => {},
    },
    stdoutText: (): string => stdoutChunks.join(""),
    stderrText: (): string => stderrChunks.join(""),
  };
}

/**
 * `--concurrency` gate (D8): integer in 1..8 or VALIDATION_ERROR —
 * validation, never clamping. The default (4) applies when omitted.
 */
function normalizeConcurrency(raw: number | undefined): number {
  const value = raw ?? BATCH_DEFAULT_CONCURRENCY;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > BATCH_MAX_CONCURRENCY) {
    throw new ValidationError(
      `batch concurrency must be an integer between 1 and ${BATCH_MAX_CONCURRENCY}`,
      "Omit --concurrency for the default of 4, or pass an integer in 1..8.",
    );
  }
  return value;
}

/**
 * D9 post-success output write: captured stdout lands at `outputPath`
 * through write-temp-then-rename so a reader never observes a partial
 * file. The op index keeps concurrent temp names distinct even if two
 * ops (degenerately) declare the same target. Returns the failure
 * message on error — the caller records it as `outputWriteError`; it
 * NEVER propagates as a per-op failure.
 */
async function writeCapturedOutput(
  outputPath: string,
  data: string,
  index: number,
  deps: BatchRunnerDeps,
): Promise<string | undefined> {
  const tempPath = `${outputPath}.tmp-${index}`;
  try {
    const writeFile = deps.writeOutputFile ?? fsWriteFile;
    const renameFile = deps.renameOutputFile ?? fsRename;
    await writeFile(tempPath, data);
    await renameFile(tempPath, outputPath);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

// ---------------------------------------------------------------------------
// Runner core
// ---------------------------------------------------------------------------

/**
 * Execute a parsed manifest under a computed assignment (DESIGN D5/D6/D8).
 *
 * Scheduling is manifest order with a free-worker-takes-next-op pool;
 * max-active never exceeds `concurrency`. `--fail-fast` stops scheduling
 * after the first failed completion, drains in-flight ops (never
 * aborts), and backfills never-scheduled ops with
 * `{ok: false, exitCode: 1, stderr: "not run (--fail-fast)"}` so
 * `results[]` stays 1:1 with the manifest and `total = ok + failed`
 * always holds.
 *
 * Returns the envelope (for callers like the `vision batch` wrapper that
 * also persist it) and the process exit code: any failed op → 1. The
 * single stdout write happens here, before returning.
 */
export async function runBatch(
  manifest: BatchManifest,
  assignments: readonly BatchProviderAssignment[],
  deps: BatchRunnerDeps,
  options: BatchRunOptions = {},
): Promise<{ envelope: BatchRunEnvelope; exitCode: number }> {
  const concurrency = normalizeConcurrency(options.concurrency);

  // Batch-level guards run BEFORE the pool and before any stdout write:
  // a whole-batch VALIDATION_ERROR never produces a summary envelope.
  if (assignments.length !== manifest.operations.length) {
    throw new ValidationError("batch assignments must align 1:1 with manifest operations");
  }
  for (const op of manifest.operations) {
    if (deps.handlers[op.command] === undefined) {
      throw new ValidationError(`batch runner has no handler for command "${op.command}"`);
    }
  }

  const now = deps.now ?? Date.now;
  const secrets = deps.handlerDeps.secrets ?? [];
  const total = manifest.operations.length;
  const records: BatchRunRecord[] = new Array<BatchRunRecord>(total);
  let nextIndex = 0;
  let stopScheduling = false;
  let failFastTriggered = false;

  const runOne = async (index: number): Promise<BatchRunRecord> => {
    // Invariant: the worker checked `index < total` before calling, and
    // the alignment guard proved `assignments` matches 1:1.
    const op: BatchOperation = manifest.operations[index]!;
    const assignment: BatchProviderAssignment = assignments[index]!;
    const handler: BatchOperationHandler = deps.handlers[op.command]!;
    const capture = createPerOpCapture();

    // D5 spread seam: the ONLY override of the shared handler deps.
    const opDeps: HandlerDependencies = {
      ...deps.handlerDeps,
      provider: assignment.provider,
      invocation: capture.adapter,
    };

    const startedAt = now();
    let rawExitCode: number;
    try {
      rawExitCode = await handler(compileInput(op), OP_OUTPUT_MODE, opDeps);
    } catch (error) {
      // Pre-invokeCommand safety net (D5): mirror invokeCommand's catch —
      // redact, format through formatErrorOutput in the op's (data) mode,
      // return the typed exit code — so per-op capture survives handlers
      // that throw before reaching invokeCommand.
      const redactedError = redactSecrets(error, secrets) as unknown;
      capture.adapter.writeStderr(formatErrorOutput(redactedError, OP_OUTPUT_MODE, secrets));
      rawExitCode = getErrorExitCode(error);
    }
    const exitCode = typeof rawExitCode === "number" ? rawExitCode : 0;
    const stdoutText = capture.stdoutText();
    const stderrText = capture.stderrText();
    const ok = exitCode === 0;

    // D9: persist the captured stdout AFTER a successful op, only when a
    // target was declared (dirname was validated at manifest parse). A
    // write failure never flips `ok` or the counters — it is recorded on
    // the op as `outputWriteError` so `total = ok + failed` always holds.
    let outputWriteError: string | undefined;
    if (ok && op.output !== undefined) {
      outputWriteError = await writeCapturedOutput(op.output, stdoutText, index, deps);
    }

    return {
      name: op.name,
      command: op.command,
      ok,
      exitCode,
      resolvedProvider: assignment.provider,
      ...(stdoutText.length > 0 ? { stdout: stdoutText } : {}),
      ...(stderrText.length > 0 ? { stderr: stderrText } : {}),
      durationMs: now() - startedAt,
      ...(op.output !== undefined ? { output: op.output } : {}),
      ...(outputWriteError !== undefined ? { outputWriteError } : {}),
    };
  };

  const worker = async (): Promise<void> => {
    while (!stopScheduling) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= total) return;
      const record = await runOne(index);
      records[index] = record;
      if (!record.ok && options.failFast === true) {
        // Drain in-flight ops (they still complete and count); only the
        // SCHEDULING of new ops stops (D8).
        stopScheduling = true;
        failFastTriggered = true;
      }
    }
  };

  const poolStartedAt = now();
  const workerCount = Math.min(concurrency, total);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  // Fail-fast backfill: unscheduled ops keep the 1:1 results invariant.
  for (let index = 0; index < total; index++) {
    if (records[index] === undefined) {
      const op: BatchOperation = manifest.operations[index]!;
      const assignment: BatchProviderAssignment = assignments[index]!;
      records[index] = {
        name: op.name,
        command: op.command,
        ok: false,
        exitCode: 1,
        resolvedProvider: assignment.provider,
        stderr: BATCH_NOT_RUN_STDERR,
        durationMs: 0,
      };
    }
  }

  const okCount = records.reduce((count, record) => count + (record.ok ? 1 : 0), 0);
  const failed = total - okCount;
  const envelope: BatchRunEnvelope = {
    schemaVersion: 1,
    total,
    ok: okCount,
    failed,
    durationMs: now() - poolStartedAt,
    concurrency,
    ...(failFastTriggered ? { failFast: true as const } : {}),
    results: records,
  };

  // The ONE stdout write (D6/D12): the summary envelope through the
  // normal success path for the ambient output mode. Op output lives
  // inside the envelope only — data-only stdout is preserved.
  deps.invocation.writeStdout(formatSuccessOutput(envelope, deps.outputMode, now));

  return { envelope, exitCode: failed > 0 ? 1 : 0 };
}
