/**
 * `monitor-fact` — v3 fact monitoring consumer entry point (lane-owned,
 * first slice; NOT yet wired into shared CLI dispatch).
 *
 * One explicit user-requested tick over one fact: runs one bounded lean
 * investigation for a monitor definition and reports value transitions
 * against the last accepted baseline. See {@link ../lib/fact-monitor.js}
 * for the authoritative-commit storage, the overlap sequence rule, the
 * durability guarantee and cancellation semantics.
 *
 * The engine dependencies (search/read/judge/now) are INJECTED — the
 * production provider wiring (the investigate-requirements runtime) is
 * the remaining shared-dependency integration, proposed in the lane
 * report rather than changed here. Definition input is bounded by the
 * requirements command's 1 MiB ceiling (MAX_REQUIREMENTS_BYTES).
 */
import * as nodePath from "node:path";

import { ValidationError } from "../lib/errors.js";
import { MAX_REQUIREMENTS_BYTES } from "./investigate-requirements.js";
import type { LeanDeps } from "../lib/lean-investigation.js";
import {
  FactMonitorCancelledError,
  readOwnedFileBounded,
  requireMonitorId,
  runFactMonitorTick,
  type FactMonitorOptions,
  type FactMonitorTickReport,
} from "../lib/fact-monitor.js";

export const MONITOR_FACT_USAGE = `
monitor-fact — accepted-value fact monitoring (v3 first slice)

Usage:
  monitor-fact tick --definition <file|-> --monitor-id <id> --state-root <dir>

Runs ONE bounded monitoring tick for the given monitor: one engine pass
over the definition, compared against the monitor's last accepted
baseline. Overlapping ticks are rejected by the documented sequence rule
(late older commits never regress a newer baseline). A malformed
definition fails as a validation error before any state is read.

Options:
  --definition <file|->   Engine contract (JSON, ≤ 1 MiB) from a file or stdin
  --monitor-id <id>       Stable monitor identity (1-128 chars:
                          letters, digits, '.', '_', '-', first char
                          alphanumeric). Baselines live under
                          <state-root>/<monitor-id>/
  --state-root <dir>      Monitor state root (REQUIRED; the default
                          resolution lands with shared CLI wiring, so no
                          implicit real-user store is ever created)

Report: the FactMonitorTickReport JSON document on stdout. Exit codes:
0 committed tick (including unresolved/error outcomes — the transition
IS the tick's result); 1 usage/validation; 2 rejected late commit;
130 cancelled before publication.
`.trim();

/** Injectable IO for {@link monitorFactMain} (tests inject both).
 *  `readStdin` receives the input ceiling so a streaming adapter can stop
 *  reading the moment it is exceeded (the post-read check remains as a
 *  backstop for adapters that ignore it). */
export interface MonitorFactDeps extends LeanDeps {
  /** Invocation-adapter order: (maxBytes, signal) — matches
   *  CommandInvocationAdapter.readStdin so the production adapter binds
   *  directly with no reordering wrapper. */
  readonly readStdin: (maxBytes?: number, signal?: AbortSignal) => Promise<string>;
}

export function parseMonitorFactArgs(args: readonly string[]): {
  readonly subcommand?: string;
  readonly definitionSource: { readonly path: string } | { readonly stdin: true } | undefined;
  readonly monitorId?: string;
  readonly stateRoot?: string;
  readonly showHelp: boolean;
} {
  let subcommand: string | undefined;
  let definitionSource: { readonly path: string } | { readonly stdin: true } | undefined;
  let monitorId: string | undefined;
  let stateRoot: string | undefined;
  let showHelp = false;

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === undefined) break;
    if (token === "--help" || token === "-h") {
      showHelp = true;
    } else if (token === "--definition") {
      const value = args[i + 1];
      if (value === undefined) throw new ValidationError("monitor-fact: --definition requires a value (<file> or -).");
      definitionSource = value === "-" ? { stdin: true } : { path: value };
      i += 1;
    } else if (token === "--monitor-id") {
      const value = args[i + 1];
      if (value === undefined) throw new ValidationError("monitor-fact: --monitor-id requires a value.");
      monitorId = value;
      i += 1;
    } else if (token === "--state-root") {
      const value = args[i + 1];
      if (value === undefined) throw new ValidationError("monitor-fact: --state-root requires a value.");
      stateRoot = value;
      i += 1;
    } else if (token.startsWith("--")) {
      throw new ValidationError(`monitor-fact: unknown option ${token}.`);
    } else if (subcommand === undefined) {
      subcommand = token;
    } else {
      throw new ValidationError(`monitor-fact: unexpected argument ${token}.`);
    }
  }
  return { subcommand, definitionSource, monitorId, stateRoot, showHelp };
}

/** Result envelope for {@link monitorFactMain}. */
export interface MonitorFactMainResult {
  readonly code: number;
  readonly stdout: string;
}

/**
 * Bounded definition-file read: delegates to the store's owned no-follow
 * reader (lstat screen against symlinks/fifos, O_NOFOLLOW|O_NONBLOCK on
 * Linux, incremental reads failing the moment the ceiling is exceeded;
 * observes the cancellation signal).
 */
export async function readFileBounded(filePath: string, signal?: AbortSignal): Promise<string> {
  return readOwnedFileBounded(filePath, "monitor-fact definition file", MAX_REQUIREMENTS_BYTES, signal);
}

/**
 * Stdin under cancellation AND the byte ceiling: race the adapter against
 * the abort signal so a BLOCKED adapter cannot leave the command pending
 * (an adapter that rejects on abort maps to the same exit-130 outcome),
 * and hand the adapter the input ceiling so a streaming adapter stops
 * reading once it is exceeded. The wrapper owns listener cleanup on every
 * exit path, including a synchronous adapter throw.
 */
async function readStdinWithCancellation(
  deps: MonitorFactDeps,
  monitorId: string,
  signal: AbortSignal | undefined,
  maxBytes: number,
): Promise<string> {
  if (signal === undefined) return deps.readStdin(maxBytes);
  try {
    return await new Promise<string>((resolve, reject) => {
      const onAbort = (): void => reject(new FactMonitorCancelledError(monitorId));
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      let adapter: Promise<string>;
      try {
        adapter = deps.readStdin(maxBytes, signal);
      } catch (error) {
        signal.removeEventListener("abort", onAbort);
        throw error;
      }
      adapter.then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (error) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  } catch (error) {
    if (signal.aborted && !(error instanceof FactMonitorCancelledError)) {
      throw new FactMonitorCancelledError(monitorId);
    }
    throw error;
  }
}

async function readDefinition(
  source: { readonly path: string } | { readonly stdin: true },
  deps: MonitorFactDeps,
  monitorId: string,
  signal: AbortSignal | undefined,
): Promise<object> {
  const read = async (): Promise<string> => {
    if ("stdin" in source) {
      return readStdinWithCancellation(deps, monitorId, signal, MAX_REQUIREMENTS_BYTES);
    }
    // File reads observe cancellation too: check before opening, check
    // per chunk inside the bounded reader, and map an abort-time failure
    // to the typed cancellation (ordinary file errors pass through when
    // no abort occurred).
    try {
      return await readFileBounded(source.path, signal);
    } catch (error) {
      if (signal?.aborted && !(error instanceof FactMonitorCancelledError)) {
        throw new FactMonitorCancelledError(monitorId);
      }
      throw error;
    }
  };
  const text = await read();
  if (Buffer.byteLength(text, "utf8") > MAX_REQUIREMENTS_BYTES) {
    throw new ValidationError(
      `monitor-fact: definition exceeds the ${MAX_REQUIREMENTS_BYTES}-byte input ceiling.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ValidationError(`monitor-fact: definition is not valid JSON (${(error as Error).message}).`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ValidationError("monitor-fact: definition must be a JSON object.");
  }
  return parsed;
}

/**
 * Entry point for one `monitor-fact tick` invocation. The --state-root
 * flag is required (the config-root default lands with shared CLI
 * wiring, so no implicit real-user store is ever created). An optional
 * signal (merged with deps.externalSignal) cancels input reads, the
 * engine run and publication (exit 130).
 */
export async function monitorFactMain(
  args: readonly string[],
  deps: MonitorFactDeps,
  options: {
    readonly now: Date;
    readonly stateRoot: string;
    readonly signal?: AbortSignal;
    /** Lock-timing passthrough (tests synchronize on lock backoff). */
    readonly lock?: FactMonitorOptions["lock"];
  },
): Promise<MonitorFactMainResult> {
  const parsed = parseMonitorFactArgs(args);
  if (parsed.showHelp) {
    return { code: 0, stdout: `${MONITOR_FACT_USAGE}\n` };
  }
  if (parsed.subcommand !== "tick") {
    throw new ValidationError(`monitor-fact: expected subcommand 'tick'${parsed.subcommand === undefined ? "" : `, got ${JSON.stringify(parsed.subcommand)}`}.`);
  }
  if (parsed.definitionSource === undefined) {
    throw new ValidationError("monitor-fact: --definition is required.");
  }
  if (parsed.monitorId === undefined) {
    throw new ValidationError("monitor-fact: --monitor-id is required.");
  }
  // Format validation IMMEDIATELY after parsing, before any input read:
  // an invalid id must fail fast instead of blocking on stdin (the store
  // independently re-validates before any path use).
  requireMonitorId(parsed.monitorId);
  if (parsed.stateRoot === undefined) {
    throw new ValidationError("monitor-fact: --state-root is required.");
  }
  // Canonical comparison: equivalent spellings of the same root are not a
  // conflict (raw-string comparison rejected trailing-slash variants).
  if (nodePath.resolve(parsed.stateRoot) !== nodePath.resolve(options.stateRoot)) {
    throw new ValidationError("monitor-fact: --state-root conflicts with the injected state root.");
  }
  // ONE effective signal from BOTH sources, merged BEFORE any input is
  // read: a blocked stdin adapter must respond to either channel.
  const signals = [options.signal, deps.externalSignal].filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  const effectiveSignal =
    signals.length === 0 ? undefined : signals.length === 1 ? signals[0] : AbortSignal.any(signals);
  try {
    const definition = await readDefinition(parsed.definitionSource, deps, parsed.monitorId, effectiveSignal);
    const report: FactMonitorTickReport = await runFactMonitorTick(
      options.stateRoot,
      parsed.monitorId,
      definition,
      deps,
      {
        now: options.now,
        ...(effectiveSignal !== undefined ? { signal: effectiveSignal } : {}),
        ...(options.lock !== undefined ? { lock: options.lock } : {}),
      },
    );
    return {
      code: report.rejection === "late_commit" ? 2 : 0,
      stdout: `${JSON.stringify(report)}\n`,
    };
  } catch (error) {
    if (error instanceof FactMonitorCancelledError) {
      return {
        code: 130,
        stdout: `${JSON.stringify({ schemaVersion: 1, monitorId: parsed.monitorId, cancelled: true })}\n`,
      };
    }
    throw error;
  }
}
