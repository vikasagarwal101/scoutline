/**
 * Output Budget persistence (ADR-0007, lane T2).
 *
 * Reference preservation: when {@link applyBudget} fires (a compaction
 * is present), the FULL untrimmed envelope is written to the artifacts
 * store through the EXISTING seams — `writeArtifact` + `appendLogEntry`
 * (both REUSE-ONLY; the 90-symbol CRITICAL `writeArtifact` surface is
 * never modified, this is a new call site) — mirroring the save hook's
 * shape (createSaveArtifactHook, index.ts): master
 * `{schemaVersion:1, requestId, result}` where `result` is the
 * POST-REDACTION, PRE-COMPACTION payload — exactly what an unbudgeted
 * run would print. Redaction is the CALLER's job (same seam as the
 * save hook: the caller applies `redactSecrets(result.data,
 * resolvedSecrets)` and hands the redacted envelope in) — persistence
 * never rewrites data.
 *
 * `compaction.ref` = the master's requestId; a log entry is MANDATORY
 * per artifact (kind "save"; the log's per-kind dispatch — asLogEntry —
 * validates "journal" entries too since the history-journal merge), because `history
 * show` sees only LOGGED artifacts. The log's `args` field is the
 * caller's allow-list — presentation-flag-free by contract, so
 * `--max-chars` never appears there; compaction facts live only in the
 * persisted payload, never in the log entry.
 *
 * No compaction → no writes at all, `undefined` back (no gratuitous
 * side effects — the zero-diff invariant).
 */
import type {
  SaveLogEntry,
  ArtifactsDirEnvironment,
  ArtifactsPlatform,
  ProviderRouting,
  RandomBytesSource,
} from "./artifacts.js";
import {
  appendLogEntry,
  newRequestId,
  resolveArtifactsDir,
  writeArtifact,
  CLI_VERSION,
} from "./artifacts.js";
import type { BudgetCompaction } from "./output-budget.js";
import * as path from "node:path";

/**
 * Report schema version — the SAME 1 as the save hook's
 * REPORT_SCHEMA_VERSION (index.ts): one namespace for every json master
 * `history show` parses. Duplicated as a local literal because the
 * index.ts const is module-private; the T4 history recovery test fails
 * if either side drifts (report.schemaVersion is read from the master,
 * not from this const).
 */
export const BUDGET_REPORT_SCHEMA_VERSION = 1;

/** Metadata the caller supplies for the log entry (T3+ integration fills real values). */
export interface CompactionPersistenceMeta {
  /** e.g. "search" — the command being budgeted. */
  readonly command: string;
  /** Provider-influencing allow-list args; MUST be presentation-flag-free (no --max-chars). */
  readonly args: Readonly<Record<string, unknown>>;
  readonly provider: ProviderRouting;
  readonly outputFormat: string;
}

export interface PersistCompactionOptions {
  /** Env for {@link resolveArtifactsDir} — hermetic tests pass an isolated dir. */
  readonly env: ArtifactsDirEnvironment;
  readonly platform?: ArtifactsPlatform;
  /** The CALLER's clock (requestId timestamp + log timestamp; never wall clock here). */
  readonly now: () => number;
  /** Injectable entropy so hermetic tests never touch crypto. */
  readonly randomBytes?: RandomBytesSource;
  /**
   * Fix-round (review): sink for {@link appendLogEntry}'s corrupt-log
   * reset notice, mirroring createSaveArtifactHook's
   * `notice(logNotice)`. Without it a corrupt `index.json` is silently
   * reset by this run's append — earlier artifacts become unreachable
   * through `history` with NO stderr trace at all.
   */
  readonly onNotice?: (message: string) => void;
}

/**
 * Persist the full untrimmed envelope for a fired budget and return the
 * same `compaction` with `ref` filled in. The master's `result` equals
 * `envelope` verbatim (the caller already redacted it — the save seam's
 * contract, mirrored). Master first, then the log append (the save
 * hook's D6 write order, log entry MANDATORY so `history show` can
 * recover the artifact offline). Json-only by design: `history show`
 * parses json masters; a markdown extension on json content would be
 * an unrecoverable artifact.
 */
export async function persistCompaction(
  envelope: unknown,
  compaction: BudgetCompaction,
  meta: CompactionPersistenceMeta,
  options: PersistCompactionOptions,
): Promise<BudgetCompaction> {
  if (compaction.ref !== undefined) return compaction;
  const dir = resolveArtifactsDir(options.env, options.platform);
  // Fix-round R2 (HIGH): requestIds are seconds-timestamp + 2 random
  // bytes — a collision must not fail the whole budgeted invocation.
  // Retry with a fresh ID when writeArtifact refuses an existing
  // master; any other error still propagates. Bounded (3 attempts):
  // repeated refusal means the store is adversarial, not unlucky.
  let requestId = "";
  let masterPath = "";
  let attempts = 0;
  for (;;) {
    attempts += 1;
    requestId = newRequestId(options.now(), options.randomBytes);
    const content = `${serializeIndented({
      schemaVersion: BUDGET_REPORT_SCHEMA_VERSION,
      requestId,
      result: envelope,
    })}\n`;
    try {
      masterPath = await writeArtifact(dir, requestId, content, { format: "json" });
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (attempts < 3 && message.includes("Refusing to overwrite existing artifact")) continue;
      throw error;
    }
  }
  const entry: SaveLogEntry = {
    kind: "save",
    requestId,
    timestamp: options.now(),
    command: meta.command,
    args: meta.args,
    provider: meta.provider,
    outputFormat: meta.outputFormat,
    artifactFormat: "json",
    cliVersion: CLI_VERSION,
    masterPath: path.basename(masterPath),
  };
  const logNotice = await appendLogEntry(dir, entry);
  if (logNotice !== undefined) options.onNotice?.(logNotice);
  return { ...compaction, ref: requestId };
}

function serializeIndented(value: unknown): string {
  // Key order is insertion order — the save hook's exact JSON shape —
  // NOT sortKeysDeep: the artifact mirrors the report format, while
  // measurement (sortKeysDeep) stays a projection-time concern.
  return JSON.stringify(value, null, 2);
}
