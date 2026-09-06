/**
 * watch command — keyless page monitoring registry (watch-temporal-diff
 * lane B, T4).
 *
 * The stateful family over the T2 watch store:
 *
 *   - `watch add <url> [--name <name>] [--keep <1..100>]` — register a
 *     page target; the name defaults to the URL host+path slug.
 *   - `watch list` — the registry, ascending by id (chronological).
 *   - `watch remove <name-or-id> [--purge]` — identity-guarded removal;
 *     the change-log evidence dir survives by default, `--purge` drops it.
 *   - `watch run` / `watch feed` — T5/T6 surfaces; they are named in
 *     help and the terminal subcommand string but dispatch to a
 *     not-yet-available error until their tickets land on this branch.
 *
 * Credential-free (no Provider resolution, no Adapter, no quota
 * tracking) and dispatched before the credentialed config load — but
 * stateful BY DESIGN: the persistent snapshot ring and change log live
 * under `SCOUTLINE_WATCH_DIR` / `<config root>/watch`, which is exactly
 * why the dispatcher rejects `--isolated` (a unique artifacts namespace
 * would silently orphan the monitored state).
 */

import type { CommandResult, TextOutputMode } from "../command-invocation.js";
import { invokeCommand } from "../command-invocation.js";
import type { OutputMode } from "../lib/output.js";
import { ValidationError } from "../lib/errors.js";
import type { HandlerDependencies } from "../index.js";
import {
  resolveWatchDir,
  addTarget,
  listTargets,
  removeTarget,
  WATCH_DEFAULT_KEEP,
  WATCH_MIN_KEEP,
  WATCH_MAX_KEEP,
  type WatchTarget,
  type WatchDirEnvironment,
} from "../lib/watch-store.js";

export const WATCH_HELP = `
scoutline watch <subcommand> [args] [options] - Keyless page monitoring

Register pages, run cron ticks, and read the change history — all
state lives under SCOUTLINE_WATCH_DIR (default ~/.scoutline/watch).
No credentials, no Providers; watch is stateful by design and cannot
run under --isolated.

Subcommands:
  add <url>                Register a page target (http(s) only)
  list                     List registered targets (oldest first)
  remove <name-or-id>      Remove a target; the change-log evidence dir
                           survives unless --purge is passed
  run <name-or-id|--all>   One monitoring tick (0=no change, 1=change,
                           2=fetch error; --all: worst wins)
  feed <name-or-id>        Change history as JSONL or RSS 2.0

Options for 'watch add':
  --name <name>            Target name (default: host+path slug); names
                           are unique case-sensitively
  --keep <1..100>          Snapshot ring size (default: 5)

Options for 'watch remove':
  --purge                  Also delete the per-target change log and
                           snapshots (default keeps the evidence)

Global Options:
  --output-format, -O      Output format: data, json, pretty, compact, markdown, refs, tty
`.trim();

/** Report envelope for `watch add` (the registry entry + removal evidence). */
export interface WatchAddReport extends WatchTarget {
  readonly schemaVersion: 1;
}

/** Report envelope for `watch remove`. */
export interface WatchRemoveReport {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly url: string;
  readonly keep: number;
  readonly createdAt: string;
  /** true when --purge deleted the per-target evidence dir. */
  readonly purged: boolean;
}

/** Report envelope for `watch list`. */
export interface WatchListReport {
  readonly schemaVersion: 1;
  readonly total: number;
  readonly targets: readonly WatchTarget[];
}

/**
 * Parse CLI args for the watch command (the `parseArchiveArgs` shape:
 * `--help`-aware, leading `--flags` never displace the subcommand).
 */
export function parseWatchArgs(args: readonly string[]): {
  readonly subcommand?: string;
  readonly positional: readonly string[];
  readonly flags: Record<string, string | boolean>;
  readonly showHelp: boolean;
} {
  let showHelp = false;
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === undefined) break;

    if (arg === "--help" || arg === "-h") {
      showHelp = true;
      i++;
    } else if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("-")) {
        flags[key] = next;
        i += 2;
      } else {
        flags[key] = true;
        i++;
      }
    } else if (!arg.startsWith("-")) {
      positional.push(arg);
      i++;
    } else {
      i++;
    }
  }

  const subcommand = positional[0];
  return { subcommand, positional: positional.slice(1), flags, showHelp };
}

/**
 * `--keep` gate: strict decimal integer in 1..100, BEFORE the store is
 * touched (same gate class as the limit parses — `Number()` alone would
 * admit "1e2", " 5", and "5.0" spellings the contract excludes).
 */
function parseKeep(raw: string | boolean | undefined): number | undefined {
  if (raw === undefined) return undefined;
  // `--no-keep <x>` lands here as `false` — same valueless refusal.
  if (typeof raw !== "string") {
    throw new ValidationError(
      "--keep requires a value.",
      `Pass an integer between ${WATCH_MIN_KEEP} and ${WATCH_MAX_KEEP}, e.g. --keep 10.`,
    );
  }
  if (!/^\d+$/.test(raw)) {
    throw new ValidationError(
      `Invalid --keep value "${raw}".`,
      `--keep must be an integer between ${WATCH_MIN_KEEP} and ${WATCH_MAX_KEEP}, e.g. --keep 10.`,
    );
  }
  const keep = Number(raw);
  if (keep < WATCH_MIN_KEEP || keep > WATCH_MAX_KEEP) {
    throw new ValidationError(
      `Invalid --keep value "${raw}".`,
      `--keep must be an integer between ${WATCH_MIN_KEEP} and ${WATCH_MAX_KEEP}, e.g. --keep 10.`,
    );
  }
  return keep;
}

function parseName(raw: string | boolean | undefined): string | undefined {
  if (raw === undefined) return undefined;
  // `--no-name <x>` lands here as `false` — same valueless refusal.
  if (typeof raw !== "string") {
    throw new ValidationError(
      "--name requires a value.",
      "Pass a non-empty target name, e.g. --name example-docs.",
    );
  }
  if (raw.trim() === "") {
    throw new ValidationError(
      "--name cannot be empty.",
      "Pass a non-empty target name, e.g. --name example-docs.",
    );
  }
  return raw;
}

function watchPresentations(
  text: string,
): Partial<Record<TextOutputMode, string>> {
  return { tty: text, compact: text, markdown: text, refs: text };
}

function formatTargetRow(target: WatchTarget): string {
  return `${target.id}  ${target.name}  keep=${target.keep}  ${target.url}`;
}

/**
 * Dispatcher handler for `watch` in `src/index.ts`. `isolated` is the
 * global-flag extraction result: watch state is a design feature (the
 * persistent ring + change log), so a subcommand run under --isolated
 * is refused here — at parse time, before any store I/O. Help surfaces
 * (bare `watch`, `--help`) still render documentation.
 */
export async function handleWatch(
  args: string[],
  outputMode: OutputMode,
  deps: HandlerDependencies,
  isolated = false,
): Promise<number> {
  const { subcommand, positional, flags, showHelp } = parseWatchArgs(args);

  if (showHelp || subcommand === undefined) {
    deps.invocation.writeStdout(WATCH_HELP);
    return 0;
  }

  // Parse-time guard (plan T4): fires for every subcommand INCLUDING the
  // not-yet-live ones — the statefulness rationale applies to the whole
  // family, and a later landing run/feed must not re-litigate it.
  if (isolated) {
    throw new ValidationError(
      "watch cannot run under --isolated.",
      "watch is stateful by design: the persistent snapshot ring and change log live under SCOUTLINE_WATCH_DIR (default ~/.scoutline/watch). Drop --isolated to keep the monitored state.",
    );
  }

  if (subcommand === "add") {
    const url = positional[0];
    if (!url) {
      throw new ValidationError(
        "URL is required for watch add.",
        "Example: scoutline watch add https://example.com/docs --name example-docs",
      );
    }
    const keep = parseKeep(flags.keep);
    const name = parseName(flags.name);
    const root = resolveWatchDir(deps.env as WatchDirEnvironment);
    return invokeCommand(
      deps.invocation,
      async () => {
        const target = await addTarget(root, {
          url,
          ...(name !== undefined ? { name } : {}),
          ...(keep !== undefined ? { keep } : {}),
          // Timestamp from the caller's injected instant, never wall clock.
          ...(deps.now ? { now: deps.now() } : {}),
        });
        const data: WatchAddReport = { schemaVersion: 1, ...target };
        const text = `added watch target ${target.name} (${target.id}), ring keeps ${target.keep}`;
        return {
          kind: "data" as const,
          data,
          presentations: watchPresentations(text),
        };
      },
      outputMode,
      deps.now,
      deps.secrets,
    );
  }

  if (subcommand === "list") {
    const root = resolveWatchDir(deps.env as WatchDirEnvironment);
    return invokeCommand(
      deps.invocation,
      async () => {
        const targets = await listTargets(root);
        const data: WatchListReport = {
          schemaVersion: 1,
          total: targets.length,
          targets,
        };
        const lines = [`watch: ${targets.length} target(s)`];
        for (const target of targets) lines.push(formatTargetRow(target));
        return {
          kind: "data" as const,
          data,
          presentations: watchPresentations(lines.join("\n")),
        };
      },
      outputMode,
      deps.now,
      deps.secrets,
    );
  }

  if (subcommand === "remove") {
    const ref = positional[0];
    if (!ref) {
      throw new ValidationError(
        "watch remove requires a target name or id.",
        'Run "scoutline watch list" to see the registered targets.',
      );
    }
    const purge = flags.purge === true;
    const root = resolveWatchDir(deps.env as WatchDirEnvironment);
    return invokeCommand(
      deps.invocation,
      async () => {
        const target = await removeTarget(root, ref, { purge });
        const data: WatchRemoveReport = {
          schemaVersion: 1,
          ...target,
          purged: purge,
        };
        const text = purge
          ? `removed watch target ${target.name} (${target.id}) and purged its evidence`
          : `removed watch target ${target.name} (${target.id}); evidence kept (use --purge to delete)`;
        return {
          kind: "data" as const,
          data,
          presentations: watchPresentations(text),
        };
      },
      outputMode,
      deps.now,
      deps.secrets,
    );
  }

  // Named-but-not-yet-landed subcommands: help and the terminal string
  // enumerate the full family; dispatch refuses until T5/T6 land so the
  // strings never need re-editing (they are byte-pinned by tests).
  if (subcommand === "run" || subcommand === "feed") {
    throw new ValidationError(
      `watch ${subcommand} is not available in this build.`,
      "It lands with the watch tick/feed tickets on this branch.",
    );
  }

  throw new ValidationError(
    `Unknown watch subcommand "${subcommand}".`,
    "Valid subcommands: add, list, remove, run, feed.",
  );
}
