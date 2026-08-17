/**
 * Usage ledger (usage-ledger plan — Ticket 1).
 *
 * A per-day, per-provider, per-capability record of billable call
 * attempts, stored as `<config-root>/usage.json` (DESIGN D1: a sibling
 * of `config.json`/`state.json`, never a `state.json` v2 — the quota
 * store keeps exclusive ownership of `state.json`). Every
 * {@link ConsumptionEvent} recorded by a consumption sink increments
 * the matching counters under the UTC calendar date of `event.at`
 * (DESIGN D2).
 *
 * Boundary rules:
 *   - This module owns the ledger's schema, its pure merge/prune
 *     algebra, its fail-open reader, and its path resolution. The
 *     fs-writing sink (Ticket 2, `createUsageLedgerSink`) composes
 *     them under the async-file-lock with an atomic temp+rename.
 *   - No static fs import: all file I/O flows through injectable deps
 *     (`readUsageLedger`'s optional reader; the Ticket 2 sink's fs
 *     deps). The default reader lazily imports `node:fs/promises` so
 *     the production `usage` command can call `readUsageLedger(path)`
 *     bare (DESIGN D8: silent-on-corrupt, credential-free).
 *   - Fail-open on read, mirroring `quota-store.ts`'s state reads: a
 *     corrupt, wrong-version, or unreadable ledger yields an empty
 *     ledger plus a routed warning — never a thrown error, never a
 *     destructive rewrite on read.
 *   - Retention (DESIGN D5): 90 days, pruned on day-roll only — the
 *     first write whose UTC day key is absent from the loaded ledger
 *     drops out-of-window day keys in the same write. No other prune
 *     path; no config surface in v1.
 */

import * as path from "node:path";

import type { ProviderId } from "../providers/types.js";
import { resolveConfigRoot } from "./config-store.js";
import type { ConsumptionEvent, ConsumptionSink } from "./consumption.js";

// ---------------------------------------------------------------------------
// Schema v1 (DESIGN D2)
// ---------------------------------------------------------------------------

/** Ledger schema version; a mismatched version on read fails open. */
export const USAGE_LEDGER_VERSION = 1 as const;

/** Ledger file name — a config-root sibling of `config.json` (DESIGN D1). */
export const USAGE_LEDGER_FILENAME = "usage.json";

/** Default retention window in days (DESIGN D5: constant, no config surface in v1). */
export const DEFAULT_USAGE_RETENTION_DAYS = 90;

/**
 * Per-provider, per-capability counters for one UTC day. Every axis is
 * maintained by {@link mergeEventIntoLedger}:
 *   - `attempts` — every {@link ConsumptionEvent} (retries included).
 *   - `firstTries` — events with `attempt === 1`.
 *   - `exactUnits` — sum of exact amounts (0 today; reserved — no
 *     production emitter yet).
 *   - `estimateUnits` — sum of estimate values (search/reader/map/repo
 *     default to 1 each).
 *   - `unknownCount` — events whose amount kind is `"unknown"`.
 */
export interface UsageCounters {
  attempts: number;
  firstTries: number;
  exactUnits: number;
  estimateUnits: number;
  unknownCount: number;
}

/**
 * The on-disk ledger shape. `days` maps a UTC calendar date
 * `"YYYY-MM-DD"` to per-provider counter records; capability keys are
 * the emitted `capabilityId` verbatim (no normalization at the ledger
 * layer). `version` gates schema evolution via a strict-equality check
 * on read.
 */
export interface UsageLedger {
  readonly version: typeof USAGE_LEDGER_VERSION;
  /**
   * UTC calendar date `"YYYY-MM-DD"` → per-provider counters. The
   * provider map is `Partial` for the same reason `quota-store.ts`'s
   * schema is: strict TS cannot construct a full `Record<ProviderId,
   * …>` key-by-key. The on-disk JSON shape is unchanged from DESIGN D2
   * — only recorded providers appear as keys.
   */
  readonly days: Record<string, Partial<Record<ProviderId, Record<string /*capabilityId*/, UsageCounters>>>>;
}

/** A schema-v1 ledger with no recorded days. */
export function emptyUsageLedger(): UsageLedger {
  return { version: USAGE_LEDGER_VERSION, days: {} };
}

function emptyUsageCounters(): UsageCounters {
  return { attempts: 0, firstTries: 0, exactUnits: 0, estimateUnits: 0, unknownCount: 0 };
}

// ---------------------------------------------------------------------------
// UTC day keys
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The UTC calendar-date bucket key (`"YYYY-MM-DD"`) for a millisecond
 * instant. Deterministic and timezone-independent (DESIGN D2: UTC day
 * bucketing keyed off `event.at` — local-time bucketing would need a
 * TZ injection for no user value). Lexicographic order on these keys
 * is chronological order, which {@link pruneExpiredDays} relies on.
 */
export function usageDayKey(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Pure merge — ledger × ConsumptionEvent → ledger
// ---------------------------------------------------------------------------

export interface MergeEventOptions {
  /**
   * Retention window in days. When provided AND the event's UTC day key
   * is absent from the ledger (a day-roll), out-of-window day keys are
   * dropped in the same merge — exactly one prune pass per day-roll,
   * no other prune path (DESIGN D5).
   */
  readonly retentionDays?: number;
}

/**
 * Merge one {@link ConsumptionEvent} into a ledger, incrementing the
 * event's provider/capability counters under the UTC day key of
 * `event.at`. Pure: returns a new ledger, never mutates the input.
 *
 * When `options.retentionDays` is set and the event's day key is new
 * (day-roll), the merge also prunes expired days relative to the new
 * day — the single prune pass of DESIGN D5. Same-day merges never
 * prune.
 */
export function mergeEventIntoLedger(
  ledger: UsageLedger,
  event: ConsumptionEvent,
  options: MergeEventOptions = {},
): UsageLedger {
  const dayKey = usageDayKey(event.at);
  const isNewDay = !(dayKey in ledger.days);
  const base =
    isNewDay && options.retentionDays !== undefined
      ? pruneExpiredDays(ledger, options.retentionDays, dayKey)
      : ledger;
  return mergeIntoDay(base, dayKey, event);
}

function mergeIntoDay(ledger: UsageLedger, dayKey: string, event: ConsumptionEvent): UsageLedger {
  const priorDay: Partial<Record<ProviderId, Record<string, UsageCounters>>> =
    ledger.days[dayKey] ?? {};
  const priorCapabilities: Record<string, UsageCounters> = priorDay[event.provider] ?? {};
  const counters = applyEventToCounters(
    priorCapabilities[event.capabilityId] ?? emptyUsageCounters(),
    event,
  );
  const capabilities: Record<string, UsageCounters> = { ...priorCapabilities };
  capabilities[event.capabilityId] = counters;
  const day: Partial<Record<ProviderId, Record<string, UsageCounters>>> = { ...priorDay };
  day[event.provider] = capabilities;
  return { version: USAGE_LEDGER_VERSION, days: { ...ledger.days, [dayKey]: day } };
}

function applyEventToCounters(counters: UsageCounters, event: ConsumptionEvent): UsageCounters {
  const amount = event.amount;
  // Defensive: non-finite or negative values contribute 0 (mirrors
  // quota-store's treatment of invalid amounts — never fake-precise).
  const unitValue = amount.kind === "unknown" ? 0 : finiteNonNegative(amount.value);
  return {
    attempts: counters.attempts + 1,
    firstTries: counters.firstTries + (event.attempt === 1 ? 1 : 0),
    exactUnits: counters.exactUnits + (amount.kind === "exact" ? unitValue : 0),
    estimateUnits: counters.estimateUnits + (amount.kind === "estimate" ? unitValue : 0),
    unknownCount: counters.unknownCount + (amount.kind === "unknown" ? 1 : 0),
  };
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

// ---------------------------------------------------------------------------
// Pure prune — retention window
// ---------------------------------------------------------------------------

/**
 * Drop day keys outside the retention window. Pure: returns a new
 * ledger, never mutates the input.
 *
 * The window is exactly `retentionDays` day keys: the reference day
 * inclusive plus `retentionDays - 1` days back. The key exactly
 * `retentionDays` older than the reference is dropped (the 90-day
 * window of DESIGN D5). Day keys compare lexicographically, which for
 * `"YYYY-MM-DD"` is chronological.
 *
 * A reference key that is not a parsable UTC date leaves the ledger
 * unchanged (defensive — pruning must never destroy history on a
 * malformed input).
 */
export function pruneExpiredDays(
  ledger: UsageLedger,
  retentionDays: number,
  referenceDayKey: string,
): UsageLedger {
  const referenceMs = Date.parse(`${referenceDayKey}T00:00:00.000Z`);
  if (!Number.isFinite(referenceMs)) return ledger;
  const cutoffKey = usageDayKey(referenceMs - (retentionDays - 1) * DAY_MS);
  const days: UsageLedger["days"] = {};
  for (const [key, value] of Object.entries(ledger.days)) {
    if (key >= cutoffKey) days[key] = value;
  }
  return { version: USAGE_LEDGER_VERSION, days };
}

// ---------------------------------------------------------------------------
// Fail-open reader
// ---------------------------------------------------------------------------

export interface UsageLedgerReadDeps {
  /**
   * Injectable file reader (returns raw file contents). Default: the
   * real filesystem, imported lazily so this module carries no static
   * fs import.
   */
  readonly readFile?: (filePath: string) => Promise<string>;
  /**
   * Warning channel for fail-open conditions (corrupt JSON, version
   * mismatch, unreadable file). Default: no-op — the production
   * `usage` command reads bare so its silent-on-corrupt contract
   * holds (DESIGN D8); the Ticket 2 sink injects its own channel.
   */
  readonly onWarning?: (message: string) => void;
}

/**
 * Default reader: real filesystem read. The `node:fs/promises` import
 * is lazy so the module stays free of a static fs import — every I/O
 * path flows through the injectable `readFile` dep.
 */
async function defaultUsageLedgerReadFile(filePath: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(filePath, "utf8");
}

/**
 * Read and parse the ledger at `filePath`. Fail-open, never throws:
 *   - missing file (ENOENT) → empty ledger, no warning;
 *   - corrupt JSON / non-object payload / version mismatch /
 *     non-object `days` → empty ledger + warning;
 *   - any other read failure → empty ledger + warning.
 *
 * Never rewrites the file on read (DESIGN D2: no destructive rewrite
 * on the read path).
 */
export async function readUsageLedger(
  filePath: string,
  deps: UsageLedgerReadDeps = {},
): Promise<UsageLedger> {
  const readFile = deps.readFile ?? defaultUsageLedgerReadFile;
  const onWarning = deps.onWarning ?? (() => {});
  const fileName = path.basename(filePath);
  let contents: string;
  try {
    contents = await readFile(filePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") return emptyUsageLedger();
    onWarning(`Unable to read ${fileName}: ${errorMessage(error)}`);
    return emptyUsageLedger();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    onWarning(`${fileName} is not valid JSON; ignoring usage history.`);
    return emptyUsageLedger();
  }
  return parseUsageLedger(parsed, fileName, onWarning);
}

function parseUsageLedger(
  raw: unknown,
  fileName: string,
  onWarning: (message: string) => void,
): UsageLedger {
  if (!isRecord(raw)) {
    onWarning(`${fileName} is not a JSON object; ignoring usage history.`);
    return emptyUsageLedger();
  }
  if (raw.version !== USAGE_LEDGER_VERSION) {
    onWarning(
      `${fileName} version ${String(raw.version)} is unsupported (expected ${USAGE_LEDGER_VERSION}); ignoring usage history.`,
    );
    return emptyUsageLedger();
  }
  if (!isRecord(raw.days)) {
    onWarning(`${fileName} days field is not an object; ignoring usage history.`);
    return emptyUsageLedger();
  }
  // Shallow-normalize: non-record day/provider/capability entries are
  // silently skipped (defensive, mirroring quota-store's per-entry
  // drops); missing or non-finite counter fields default to 0 so a
  // later merge can never produce NaN.
  const days: UsageLedger["days"] = {};
  for (const [dayKey, providers] of Object.entries(raw.days)) {
    if (!isRecord(providers)) continue;
    const dayProviders: Partial<Record<ProviderId, Record<string, UsageCounters>>> = {};
    for (const [providerId, capabilities] of Object.entries(providers)) {
      if (!isRecord(capabilities)) continue;
      const parsedCapabilities: Record<string, UsageCounters> = {};
      for (const [capabilityId, counters] of Object.entries(capabilities)) {
        if (!isRecord(counters)) continue;
        parsedCapabilities[capabilityId] = {
          attempts: counterField(counters.attempts),
          firstTries: counterField(counters.firstTries),
          exactUnits: counterField(counters.exactUnits),
          estimateUnits: counterField(counters.estimateUnits),
          unknownCount: counterField(counters.unknownCount),
        };
      }
      dayProviders[providerId as ProviderId] = parsedCapabilities;
    }
    days[dayKey] = dayProviders;
  }
  return { version: USAGE_LEDGER_VERSION, days };
}

function counterField(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Ledger sink — the fs-writing ConsumptionSink (Ticket 2)
// ---------------------------------------------------------------------------

export interface UsageLedgerSinkOptions {
  /**
   * Absolute path to the ledger file — typically
   * {@link resolveUsageLedgerPath}.
   */
  readonly filePath: string;
  /**
   * Injectable reader, shared shape with
   * {@link UsageLedgerReadDeps.readFile}. Default: the real filesystem.
   */
  readonly readFile?: (filePath: string) => Promise<string>;
  /**
   * Injectable atomic write (temp-file + rename, DESIGN D4). Default:
   * config-store's `atomicReplaceFile`, imported lazily so this module
   * keeps no static fs import.
   */
  readonly writeFile?: (filePath: string, contents: string) => Promise<void>;
  /**
   * Injectable critical-section serializer for the read-modify-write.
   * Default: `withAsyncFileLock` over the ledger's directory with lock
   * identity `usage.json` — lock file `<dir>/usage.json.lock` (DESIGN
   * D4) — imported lazily.
   */
  readonly lock?: <T>(criticalSection: () => Promise<T>) => Promise<T>;
  /**
   * Injectable clock. Defensive fallback only: shared execution always
   * stamps `event.at` before the sink sees the event.
   */
  readonly now?: () => number;
  /**
   * Best-effort warning channel. Every internal failure — read, lock,
   * or write — surfaces here as a REDACTED, detail-free message;
   * `record()` never throws (DESIGN D3). Default: stderr, mirroring
   * the quota-store sink.
   */
  readonly onWarning?: (message: string) => void;
  /** Retention window in days (DESIGN D5). Default: 90. */
  readonly retentionDays?: number;
}

/**
 * The fixed, redacted failure message for {@link createUsageLedgerSink}.
 * The raw error text is deliberately NOT interpolated: an underlying
 * failure can embed provider/capability/timestamp detail that must never
 * reach a warning (redaction parity with the quota-store sink, one
 * degree stricter — no reason channel at all).
 */
const USAGE_LEDGER_SINK_WARNING = "usage ledger recording failed; the call was not counted";

function defaultUsageLedgerWarning(message: string): void {
  process.stderr.write(`scoutline: ${message}\n`);
}

async function defaultUsageLedgerWriteFile(filePath: string, contents: string): Promise<void> {
  const { atomicReplaceFile } = await import("./config-store.js");
  await atomicReplaceFile(filePath, contents);
}

async function defaultUsageLedgerLock<T>(
  dir: string,
  criticalSection: () => Promise<T>,
): Promise<T> {
  const { DEFAULT_LOCK_STALE_MS, DEFAULT_LOCK_TIMEOUT_MS, withAsyncFileLock } = await import(
    "./async-file-lock.js"
  );
  return withAsyncFileLock(dir, USAGE_LEDGER_FILENAME, criticalSection, {
    timeoutMs: DEFAULT_LOCK_TIMEOUT_MS,
    staleMs: DEFAULT_LOCK_STALE_MS,
    timeoutLabel: "Usage ledger",
  });
}

/**
 * Build the fs-writing {@link ConsumptionSink} for `usage.json` (DESIGN
 * D3/D4): one {@link ConsumptionEvent} becomes a read-modify-write under
 * the async file lock (`<dir>/usage.json.lock` — the `wx` lockfile
 * serializes writers in-process and cross-process), committed via an
 * atomic temp+rename, with the single day-roll prune pass of D5
 * (`retentionDays` flowing into {@link mergeEventIntoLedger}).
 *
 * Fail-open like the rest of the ledger: `record()` NEVER throws. A
 * corrupt or unreadable ledger yields an empty ledger (plus a routed
 * warning) and the write recreates the file; a lock or write failure
 * becomes one redacted warning and the recorded promise resolves so
 * shared execution never observes an accounting failure.
 */
export function createUsageLedgerSink(options: UsageLedgerSinkOptions): ConsumptionSink {
  const filePath = options.filePath;
  const readFile = options.readFile ?? defaultUsageLedgerReadFile;
  const writeFile = options.writeFile ?? defaultUsageLedgerWriteFile;
  const now = options.now ?? Date.now;
  const onWarning = options.onWarning ?? defaultUsageLedgerWarning;
  const retentionDays = options.retentionDays ?? DEFAULT_USAGE_RETENTION_DAYS;
  const dir = path.dirname(filePath);
  const lock: <T>(criticalSection: () => Promise<T>) => Promise<T> =
    options.lock ?? ((criticalSection) => defaultUsageLedgerLock(dir, criticalSection));
  return {
    async record(event: ConsumptionEvent): Promise<void> {
      try {
        // Defensive fallback only — shared execution always sets `at`.
        const at = event.at ?? now();
        await lock(async () => {
          const ledger = await readUsageLedger(filePath, { readFile, onWarning });
          const merged = mergeEventIntoLedger(ledger, { ...event, at }, { retentionDays });
          await writeFile(filePath, `${JSON.stringify(merged, null, 2)}\n`);
        });
      } catch {
        // Redacted by construction: no error text, no event detail.
        onWarning(USAGE_LEDGER_SINK_WARNING);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Path resolution — config-root sibling (pure)
// ---------------------------------------------------------------------------

/**
 * Resolve the absolute path to `usage.json`. Defaults to
 * `<config-root>/usage.json` where `<config-root>` is
 * `resolveConfigRoot()` (`SCOUTLINE_CONFIG_DIR` || `~/.scoutline`) —
 * the same dedicated root as `config.json` and `state.json` (DESIGN
 * D1). Pure: `path.join` over its inputs, no I/O.
 */
export function resolveUsageLedgerPath(root: string = resolveConfigRoot()): string {
  return path.join(root, USAGE_LEDGER_FILENAME);
}
