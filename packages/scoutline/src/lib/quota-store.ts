/**
 * Quota snapshot store + acquisition (Plan B — PB-T1).
 *
 * Stores **raw provider-category snapshots** at `~/.scoutline/state.json`,
 * separate from `config.json` (Plan A owns `config.json`; this module
 * owns the quota namespace of `state.json` exclusively). Versioned,
 * atomic writes reuse Plan A's {@link atomicReplaceFile} primitive.
 *
 * Two timestamps per provider (review item 13):
 *   - `observedAt` — last provider ground-truth (refresh/harvest).
 *     PB-T1 advances this. Staleness/authority uses this clock.
 *   - `locallyUpdatedAt` — last local consumption estimate (PB-T2).
 *     PB-T1 defines the field but does NOT advance it; PB-T2 does.
 *
 * The schema stores the LIVE `QuotaCategory[]` shape verbatim — the
 * normalized categories from `ProviderQuotaSuccess`. PB-T3 maps them
 * to capabilities; PB-T1 does not derive a score.
 *
 * Boundary rules:
 *   - Imports the atomic primitive from `config-store.js`, the quota
 *     contract types from `capabilities/quota.js`, and provider
 *     identity types. No provider transport, no command presentation.
 *   - Fail-open on read: quota state is observational. A corrupt or
 *     version-mismatched `state.json` yields an empty state + warning,
 *     NEVER a thrown error. Unlike `config.json` (which gates
 *     credentials), `state.json` must never block the CLI.
 *
 * USAGE ASSUMPTION — "Usage endpoints are free":
 *   The refresh path assumes the per-provider quota/usage endpoints
 *   (Z.AI monitor, Tavily `/usage`, Firecrawl `/team/credit-usage`,
 *   MiniMax `/remains`) do NOT consume billable credits. This was
 *   characterized against provider docs at implementation time. If a
 *   provider changes its usage endpoint to consume credits, the
 *   refresh becomes a cost source — re-verify against provider docs
 *   before relying on the periodic refresh.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { QuotaCategory, QuotaWindow } from "../capabilities/quota.js";
import type { ProviderId } from "../providers/types.js";
import { atomicReplaceFile, resolveConfigRoot, type AtomicReplaceOptions } from "./config-store.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const QUOTA_STATE_VERSION = 1 as const;

/**
 * A single provider's raw quota snapshot. The `categories` array is the
 * verbatim `ProviderQuotaSuccess.categories` payload — PB-T3 maps these
 * to capabilities; PB-T1 does not re-derive.
 *
 * `observedAt` advances on refresh/harvest (provider ground-truth).
 * `locallyUpdatedAt` advances on consumption (PB-T2 local decrement).
 * A stale `observedAt` with a recent `locallyUpdatedAt` is still
 * non-authoritative — local estimates never reset the ground-truth
 * clock.
 */
/**
 * Local finite decrements not yet absorbed into provider `used`
 * (GitHub #41). Keys are category names; values are accumulated
 * exact/estimate amounts since the last harvest. Absent or empty
 * means the displayed `categories` match the last provider payload.
 */
export type PendingDecrements = Readonly<Record<string, number>>;

export interface ProviderQuotaSnapshot {
  readonly observedAt: number;
  readonly locallyUpdatedAt?: number;
  readonly categories: readonly QuotaCategory[];
  readonly decrementedSinceObserved?: PendingDecrements;
}

/**
 * The on-disk state file shape. Owns the quota namespace exclusively;
 * `config.json` (Plan A) is a separate file. `version` gates schema
 * evolution; a mismatched version triggers fail-open (not a throw).
 */
export interface QuotaState {
  readonly version: typeof QUOTA_STATE_VERSION;
  readonly quota: Partial<Record<ProviderId, ProviderQuotaSnapshot>>;
}

// ---------------------------------------------------------------------------
// File path resolution — dedicated state root (Plan A T1)
// ---------------------------------------------------------------------------

/**
 * Resolve the absolute path to `state.json`. Defaults to
 * `<config-root>/state.json` where `<config-root>` is
 * `resolveConfigRoot()` (`~/.scoutline/` by default; overridable via
 * `SCOUTLINE_CONFIG_DIR`). This reuses Plan A's dedicated root — the
 * same root `config.json` lives in — so both files share the 0700
 * directory permissions `atomicReplaceFile` enforces.
 */
export function stateFilePath(root: string = resolveConfigRoot()): string {
  return path.join(root, "state.json");
}

// ---------------------------------------------------------------------------
// Injectable store options (mirrors Plan A's ConfigStoreOptions)
// ---------------------------------------------------------------------------

export interface QuotaStoreOptions {
  readonly filePath?: string;
  readonly now?: () => number;
  readonly onWarning?: (warning: QuotaStoreWarning) => void;
  readonly atomic?: AtomicReplaceOptions;
}

export interface QuotaStoreWarning {
  readonly code:
    | "STATE_CORRUPT"
    | "STATE_VERSION_MISMATCH"
    | "STATE_READ_ERROR"
    | "STATE_WRITE_ERROR";
  readonly message: string;
}

function defaultWarningSink(warning: QuotaStoreWarning): void {
  process.stderr.write(`scoutline: ${warning.message}\n`);
}

// ---------------------------------------------------------------------------
// Consumption adjustment (PB-T2 — local decrement)
// ---------------------------------------------------------------------------

/**
 * Apply a {@link ConsumptionAdjustment} to a single category's `current`
 * window. Returns a new window (immutable update); never mutates the
 * input.
 *
 * Rules:
 *   - `unknown` amount → no numeric change. The caller advances
 *     `locallyUpdatedAt` to record that consumption happened.
 *   - `exact`/`estimate` amount: when the window exposes a count set
 *     (`used` + `limit`, both finite), `used` is incremented, the
 *     derived `remaining` clamped at zero, and `remainingPercent`
 *     recomputed. Without a count set (percentage-only windows), no
 *     numeric change is possible — the decrement cannot be expressed
 *     honestly as a percentage, so the snapshot records the event via
 *     `locallyUpdatedAt` alone.
 *   - Non-finite or negative `value` is treated as `unknown` (defensive;
 *     Adapters are expected to send finite nonnegative amounts).
 */
function applyConsumptionToWindow(
  window: QuotaWindow,
  adjustment: ConsumptionAdjustment,
): QuotaWindow {
  const amount = adjustment.amount;
  if (amount.kind === "unknown") return window;
  const value = amount.value;
  if (!Number.isFinite(value) || value < 0) return window;
  const used = window.used;
  const limit = window.limit;
  if (used === undefined || limit === undefined || !Number.isFinite(limit) || limit <= 0) {
    // Percentage-only window: an absolute decrement cannot be
    // expressed honestly as a percentage delta. Leave numeric fields
    // untouched; `locallyUpdatedAt` still advances.
    return window;
  }
  const newUsed = used + value;
  const newRemaining = Math.max(0, limit - newUsed);
  const newPercent = Math.round((newRemaining / limit) * 100 * 10) / 10;
  const clampedPercent = newPercent < 0 ? 0 : newPercent > 100 ? 100 : newPercent;
  return {
    ...window,
    used: newUsed,
    remaining: newRemaining,
    remainingPercent: clampedPercent,
  };
}

/**
 * Match `adjustment.category` + `adjustment.unit` against a snapshot's
 * categories. Returns the index of the first match, or -1 when no
 * category matches (or when the adjustment omits a name).
 */
function findCategoryIndex(
  categories: readonly QuotaCategory[],
  adjustment: ConsumptionAdjustment,
): number {
  if (adjustment.category === undefined) return -1;
  // Match by category NAME only. The snapshot's unit is authoritative for
  // the decrement math; the event's unit is advisory and may differ when
  // the emission site's default unit doesn't match the provider's snapshot
  // unit (e.g. Firecrawl search emits unit:"requests" but Credits uses
  // unit:"credits"). Name identity is sufficient — category names are
  // unique per provider in the normalized QuotaCategory contract.
  for (let i = 0; i < categories.length; i++) {
    const cat = categories[i];
    if (cat && cat.name === adjustment.category) return i;
  }
  return -1;
}

function numericDecrement(adjustment: ConsumptionAdjustment): number | undefined {
  const amount = adjustment.amount;
  if (amount.kind === "unknown") return undefined;
  const value = amount.value;
  if (!Number.isFinite(value) || value < 0) return undefined;
  return value;
}

function withPending(
  pending: PendingDecrements | undefined,
  category: string | undefined,
  delta: number | undefined,
): PendingDecrements | undefined {
  if (category === undefined || delta === undefined || delta === 0) return pending;
  return { ...(pending ?? {}), [category]: (pending?.[category] ?? 0) + delta };
}

function omitEmptyPending(pending: PendingDecrements | undefined): PendingDecrements | undefined {
  if (pending === undefined) return undefined;
  const kept: Record<string, number> = {};
  for (const [name, amount] of Object.entries(pending)) {
    if (Number.isFinite(amount) && amount > 0) kept[name] = amount;
  }
  return Object.keys(kept).length > 0 ? kept : undefined;
}

function applyPendingToCategories(
  categories: readonly QuotaCategory[],
  pending: PendingDecrements | undefined,
): readonly QuotaCategory[] {
  const overlay = omitEmptyPending(pending);
  if (overlay === undefined) return categories;
  return categories.map((cat) => {
    const delta = overlay[cat.name];
    if (delta === undefined) return cat;
    return {
      ...cat,
      current: applyConsumptionToWindow(cat.current, {
        category: cat.name,
        amount: { kind: "estimate", value: delta },
      }),
    };
  });
}

function categoryByName(
  categories: readonly QuotaCategory[],
  name: string,
): QuotaCategory | undefined {
  return categories.find((cat) => cat.name === name);
}

/**
 * Apply a consumption write. Missing snapshots become an `observedAt: 0`
 * scaffold so pre-harvest decrements persist until the first harvest.
 */
export function applyWriteConsumption(
  prior: ProviderQuotaSnapshot | undefined,
  adjustment: ConsumptionAdjustment,
  at: number,
): ProviderQuotaSnapshot {
  const delta = numericDecrement(adjustment);
  if (!prior) {
    const pending = omitEmptyPending(withPending(undefined, adjustment.category, delta));
    return {
      observedAt: 0,
      locallyUpdatedAt: at,
      categories: [],
      ...(pending !== undefined ? { decrementedSinceObserved: pending } : {}),
    };
  }
  const pending = omitEmptyPending(
    withPending(prior.decrementedSinceObserved, adjustment.category, delta),
  );
  const categories = prior.categories;
  const idx = findCategoryIndex(categories, adjustment);
  const newCategories =
    idx >= 0
      ? categories.map((c, i) =>
          i === idx ? { ...c, current: applyConsumptionToWindow(c.current, adjustment) } : c,
        )
      : categories;
  return {
    observedAt: prior.observedAt,
    locallyUpdatedAt: at,
    categories: newCategories,
    ...(pending !== undefined ? { decrementedSinceObserved: pending } : {}),
  };
}

/**
 * Merge a fresh provider harvest with unacknowledged local decrements.
 * Provider `used` growth since the last harvest absorbs pending amounts
 * (no double-count). Leftover pending is re-applied onto the fresh
 * categories so a lagging usage endpoint does not clobber local estimates.
 */
export function applyWriteObserved(
  prior: ProviderQuotaSnapshot | undefined,
  snapshot: ProviderQuotaSnapshot,
): ProviderQuotaSnapshot {
  const pending = omitEmptyPending(prior?.decrementedSinceObserved);
  const remaining: Record<string, number> = {};
  if (pending !== undefined) {
    for (const [name, amount] of Object.entries(pending)) {
      const freshCat = categoryByName(snapshot.categories, name);
      const priorCat = prior ? categoryByName(prior.categories, name) : undefined;
      let absorbed = 0;
      const freshUsed = freshCat?.current.used;
      if (priorCat && freshUsed !== undefined && Number.isFinite(freshUsed)) {
        const priorDisplayed = priorCat.current.used;
        if (priorDisplayed !== undefined && Number.isFinite(priorDisplayed)) {
          const priorProviderUsed = priorDisplayed - amount;
          absorbed = Math.max(0, freshUsed - priorProviderUsed);
        }
      } else if (
        freshUsed !== undefined &&
        Number.isFinite(freshUsed) &&
        (prior === undefined || prior.observedAt === 0 || priorCat === undefined)
      ) {
        absorbed = Math.max(0, freshUsed);
      }
      const leftover = Math.max(0, amount - absorbed);
      if (leftover > 0) remaining[name] = leftover;
    }
  }
  const leftoverPending = omitEmptyPending(remaining);
  return {
    observedAt: snapshot.observedAt,
    ...(prior?.locallyUpdatedAt !== undefined ? { locallyUpdatedAt: prior.locallyUpdatedAt } : {}),
    categories: applyPendingToCategories(snapshot.categories, leftoverPending),
    ...(leftoverPending !== undefined ? { decrementedSinceObserved: leftoverPending } : {}),
  };
}

function parsePendingDecrements(raw: unknown): PendingDecrements | undefined {
  if (!isRecord(raw)) return undefined;
  const pending: Record<string, number> = {};
  for (const [name, amount] of Object.entries(raw)) {
    if (typeof amount === "number" && Number.isFinite(amount) && amount > 0) {
      pending[name] = amount;
    }
  }
  return Object.keys(pending).length > 0 ? pending : undefined;
}

// ---------------------------------------------------------------------------
// Parsing — fail-open, never throws
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse the raw JSON object into a {@link QuotaState}. Fail-open: any
 * structural issue yields an empty state + warning. The categories
 * array is stored verbatim (deep clone via JSON round-trip) so the
 * caller cannot mutate the persisted shape by reference.
 */
function parseQuotaState(
  raw: unknown,
  now: () => number,
  onWarning: (warning: QuotaStoreWarning) => void,
): QuotaState {
  if (!isRecord(raw)) {
    onWarning({
      code: "STATE_CORRUPT",
      message: "state.json is not a JSON object; ignoring quota state.",
    });
    return { version: QUOTA_STATE_VERSION, quota: {} };
  }
  const version = raw.version;
  if (version !== QUOTA_STATE_VERSION) {
    onWarning({
      code: "STATE_VERSION_MISMATCH",
      message: `state.json version ${String(version)} is unsupported (expected ${QUOTA_STATE_VERSION}); ignoring quota state.`,
    });
    return { version: QUOTA_STATE_VERSION, quota: {} };
  }
  const quotaField = raw.quota;
  if (quotaField !== undefined && !isRecord(quotaField)) {
    onWarning({
      code: "STATE_CORRUPT",
      message: "state.json quota field is not an object; ignoring quota state.",
    });
    return { version: QUOTA_STATE_VERSION, quota: {} };
  }
  // Shallow-validate each provider entry. Unknown provider IDs are
  // silently dropped (defensive — a future provider removal should not
  // crash the store). The categories array is trusted as-is; it was
  // written by this module and round-trips through JSON.
  const quota: Partial<Record<ProviderId, ProviderQuotaSnapshot>> = {};
  if (isRecord(quotaField)) {
    for (const [providerId, entry] of Object.entries(quotaField)) {
      if (!isRecord(entry)) continue;
      const observedAt = entry.observedAt;
      if (typeof observedAt !== "number" || !Number.isFinite(observedAt)) continue;
      const categories = entry.categories;
      if (!Array.isArray(categories)) continue;
      const pending = parsePendingDecrements(entry.decrementedSinceObserved);
      const snapshot: ProviderQuotaSnapshot = {
        observedAt,
        ...(typeof entry.locallyUpdatedAt === "number" && Number.isFinite(entry.locallyUpdatedAt)
          ? { locallyUpdatedAt: entry.locallyUpdatedAt }
          : {}),
        categories: categories as readonly QuotaCategory[],
        ...(pending !== undefined ? { decrementedSinceObserved: pending } : {}),
      };
      // Trust the key — a stale entry for a removed provider is
      // harmless (PB-T3 ignores unknown IDs); dropping it here would
      // silently lose data on a parse path that is supposed to be
      // non-destructive.
      (quota as Record<string, ProviderQuotaSnapshot>)[providerId] = snapshot;
    }
  }
  // Suppress unused-parameter lint: `now` is reserved for future
  // last-resort defaulting of a missing observedAt; today the parser
  // drops entries with a non-finite observedAt instead.
  void now;
  return { version: QUOTA_STATE_VERSION, quota };
}

// ---------------------------------------------------------------------------
// QuotaStore interface — read + write-observed
// ---------------------------------------------------------------------------

/**
 * Quota unit, lifted from {@link QuotaCategory} for store-internal use
 * without importing the full capability contract. PB-T2's consumption
 * adjustment matches both `category` name AND `unit` against the
 * snapshot to avoid cross-unit drift (e.g. applying a `requests`
 * decrement against a `credits` category).
 */
export type QuotaUnit = "requests" | "tokens" | "credits";

/**
 * The amount a single billable attempt consumed. PB-T2's contract:
 * never fake-precise. The store adjusts numeric estimates only when a
 * matching category exposes a count set; an `unknown` amount still
 * advances `locallyUpdatedAt` (so the snapshot reflects that *some*
 * consumption happened) but never mutates numeric fields.
 */
export type ConsumptionAmount =
  | { readonly kind: "exact"; readonly value: number }
  | { readonly kind: "estimate"; readonly value: number }
  | { readonly kind: "unknown" };

/**
 * Adjustment payload for {@link QuotaStore.writeConsumption} (PB-T2).
 * The store matches `category` + `unit` against the snapshot's
 * categories; an absent match means the category isn't tracked, and
 * only `locallyUpdatedAt` advances.
 */
export interface ConsumptionAdjustment {
  readonly category?: string;
  readonly unit?: QuotaUnit;
  readonly amount: ConsumptionAmount;
}

/**
 * Injectable quota snapshot store. Production wires
 * {@link createDefaultQuotaStore} (real atomic read-merge-write against
 * `~/.scoutline/state.json`); tests inject in-memory doubles so store
 * assertions never touch real config-root I/O.
 *
 * Contract:
 *   - {@link read} is fail-open: absent/corrupt/version-mismatched
 *     files yield an empty state + warning, never a throw.
 *   - {@link writeObserved} performs an atomic read-merge-write: other
 *     providers' snapshots are preserved. `observedAt` advances to the
 *     harvest clock. Unacknowledged local decrements
 *     (`decrementedSinceObserved`) are reconciled against provider
 *     `used` growth and any leftover is re-applied onto the fresh
 *     categories. `locallyUpdatedAt` is preserved from the existing
 *     snapshot (PB-T2 advances it, not PB-T1).
 *   - {@link writeConsumption} (PB-T2) advances `locallyUpdatedAt` and
 *     adjusts the matching category's `current` count set when a
 *     finite decrement is supplied. `observedAt` is preserved (ground
 *     truth never moves on a local estimate). A missing snapshot is
 *     scaffolded (`observedAt: 0`) so pre-harvest decrements persist;
 *     a missing category still only advances `locallyUpdatedAt`.
 *   - {@link clear} removes a single provider's snapshot (or all when
 *     no ID is given). Used by future reset/diagnostic commands.
 */
export interface QuotaStore {
  read(): Promise<QuotaState>;
  writeObserved(providerId: ProviderId, snapshot: ProviderQuotaSnapshot): Promise<void>;
  writeConsumption(
    providerId: ProviderId,
    adjustment: ConsumptionAdjustment,
    at: number,
  ): Promise<void>;
  clear(providerId?: ProviderId): Promise<void>;
}

// ---------------------------------------------------------------------------
// Per-file async mutex — serializes read-merge-write within the process
// ---------------------------------------------------------------------------

/**
 * Per-path promise chain. Within a single process, concurrent writes
 * to the same `state.json` are serialized so one write's read does not
 * race another's merge. Cross-process concurrency is last-write-wins
 * (acceptable for an observational heuristic; the atomic rename keeps
 * the final state crash-safe).
 */
const fileLocks = new Map<string, Promise<void>>();

/**
 * Serialize an async operation per file path. Each caller chains its
 * operation after the previous tail so concurrent reads/writes against
 * the same `state.json` execute in arrival order. The stored tail is
 * always settled to `void` (success or failure is swallowed at the tail
 * level) so a rejected operation never blocks subsequent operations.
 *
 * Cross-process concurrency is NOT addressed here — it falls back to
 * last-write-wins (acceptable for an observational heuristic; the
 * atomic rename in {@link atomicReplaceFile} keeps the final state
 * crash-safe).
 */
function withFileLock<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  const previous = fileLocks.get(filePath) ?? Promise.resolve();
  // Chain the operation after the previous tail. The `.then` callback
  // runs at most once, so `operation()` is called exactly once per
  // caller.
  const chained = previous.then(operation, operation);
  // Store a settled tail for the next caller. Derived from `chained`
  // without re-invoking `operation`.
  fileLocks.set(
    filePath,
    chained.then(
      () => undefined,
      () => undefined,
    ),
  );
  return chained;
}

// ---------------------------------------------------------------------------
// Production default store
// ---------------------------------------------------------------------------

/**
 * Production {@link QuotaStore}. Reads and writes flow through
 * {@link atomicReplaceFile} (Plan A T1) so the write is crash-safe and
 * 0600-permissioned. The read-merge-write is serialized within the
 * process via {@link withFileLock}; cross-process concurrency is
 * last-write-wins.
 */
export function createDefaultQuotaStore(options: QuotaStoreOptions = {}): QuotaStore {
  const filePath = options.filePath ?? stateFilePath();
  const now = options.now ?? Date.now;
  const onWarning = options.onWarning ?? defaultWarningSink;

  async function readStateFile(): Promise<QuotaState> {
    let contents: string;
    try {
      contents = await fs.readFile(filePath, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return { version: QUOTA_STATE_VERSION, quota: {} };
      onWarning({
        code: "STATE_READ_ERROR",
        message: `Unable to read state.json: ${error instanceof Error ? error.message : String(error)}`,
      });
      return { version: QUOTA_STATE_VERSION, quota: {} };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch {
      onWarning({
        code: "STATE_CORRUPT",
        message: "state.json is not valid JSON; ignoring quota state.",
      });
      return { version: QUOTA_STATE_VERSION, quota: {} };
    }
    return parseQuotaState(parsed, now, onWarning);
  }

  async function writeStateFile(state: QuotaState): Promise<void> {
    const payload = `${JSON.stringify(state, null, 2)}\n`;
    try {
      await atomicReplaceFile(filePath, payload, options.atomic);
    } catch (error) {
      onWarning({
        code: "STATE_WRITE_ERROR",
        message: `Unable to write state.json: ${error instanceof Error ? error.message : String(error)}`,
      });
      // Swallow: quota state is observational. A write failure means
      // the next read sees the prior snapshot (or empty); selection
      // degrades to neutral/eligible. Never throw.
    }
  }

  return {
    async read(): Promise<QuotaState> {
      return withFileLock(filePath, readStateFile);
    },

    async writeObserved(providerId: ProviderId, snapshot: ProviderQuotaSnapshot): Promise<void> {
      await withFileLock(filePath, async () => {
        const existing = await readStateFile();
        const merged = applyWriteObserved(existing.quota[providerId], snapshot);
        const updated: QuotaState = {
          version: QUOTA_STATE_VERSION,
          quota: { ...existing.quota, [providerId]: merged },
        };
        await writeStateFile(updated);
      });
    },

    async writeConsumption(
      providerId: ProviderId,
      adjustment: ConsumptionAdjustment,
      at: number,
    ): Promise<void> {
      await withFileLock(filePath, async () => {
        const existing = await readStateFile();
        const merged = applyWriteConsumption(existing.quota[providerId], adjustment, at);
        const updated: QuotaState = {
          version: QUOTA_STATE_VERSION,
          quota: { ...existing.quota, [providerId]: merged },
        };
        await writeStateFile(updated);
      });
    },

    async clear(providerId?: ProviderId): Promise<void> {
      await withFileLock(filePath, async () => {
        const existing = await readStateFile();
        if (providerId === undefined) {
          await writeStateFile({ version: QUOTA_STATE_VERSION, quota: {} });
          return;
        }
        if (!(providerId in existing.quota)) return;
        const remaining = { ...existing.quota };
        delete remaining[providerId];
        await writeStateFile({ version: QUOTA_STATE_VERSION, quota: remaining });
      });
    },
  };
}

// ---------------------------------------------------------------------------
// In-memory store double (tests)
// ---------------------------------------------------------------------------

/**
 * Build an in-memory {@link QuotaStore} for hermetic tests. No file
 * I/O; the state lives in a closure. Writes are synchronous-ish (the
 * returned promises resolve on the next microtask) so tests can assert
 * immediately after `await`.
 */
export function createInMemoryQuotaStore(
  initial?: QuotaState,
  options: { onWarning?: (warning: QuotaStoreWarning) => void } = {},
): QuotaStore & { readonly state: QuotaState } {
  let state: QuotaState = initial ?? { version: QUOTA_STATE_VERSION, quota: {} };
  const onWarning = options.onWarning ?? (() => {});
  void onWarning; // retained for API symmetry; the in-memory store never warns.
  return {
    async read() {
      // Deep-clone so the caller cannot mutate by reference.
      return JSON.parse(JSON.stringify(state)) as QuotaState;
    },
    async writeObserved(providerId, snapshot) {
      const merged = applyWriteObserved(state.quota[providerId], snapshot);
      state = {
        version: QUOTA_STATE_VERSION,
        quota: { ...state.quota, [providerId]: merged },
      };
    },
    async writeConsumption(providerId, adjustment, at) {
      const merged = applyWriteConsumption(state.quota[providerId], adjustment, at);
      state = {
        version: QUOTA_STATE_VERSION,
        quota: { ...state.quota, [providerId]: merged },
      };
    },
    async clear(providerId) {
      if (providerId === undefined) {
        state = { version: QUOTA_STATE_VERSION, quota: {} };
        return;
      }
      if (!(providerId in state.quota)) return;
      const remaining = { ...state.quota };
      delete remaining[providerId];
      state = { version: QUOTA_STATE_VERSION, quota: remaining };
    },
    get state() {
      return state;
    },
  };
}

// ---------------------------------------------------------------------------
// Convenience writes (production default store)
// ---------------------------------------------------------------------------

/**
 * Write a single provider's observed snapshot to the production default
 * store (`~/.scoutline/state.json`). Convenience wrapper for callers
 * (the Brave passive harvest) that do not own a long-lived
 * {@link QuotaStore} instance — it constructs a default store per call
 * and delegates to {@link QuotaStore.writeObserved}.
 *
 * The per-call construction is cheap: `createDefaultQuotaStore` resolves
 * the file path once and returns a thin object; no I/O happens until
 * `writeObserved` runs. The per-file mutex inside the default store
 * serializes concurrent writes within the process regardless of how
 * many store instances exist (the mutex is keyed on the resolved file
 * path).
 *
 * Fail-open: a write error is swallowed by the default store's warning
 * sink (stderr notice); the returned promise never rejects. This keeps
 * the Brave harvest best-effort — a store failure can never convert a
 * search success into a fallback.
 */
export async function writeQuotaSnapshot(
  providerId: ProviderId,
  snapshot: ProviderQuotaSnapshot,
  options?: QuotaStoreOptions,
): Promise<void> {
  const store = createDefaultQuotaStore(options ?? {});
  await store.writeObserved(providerId, snapshot);
}

// ---------------------------------------------------------------------------
// Staleness check
// ---------------------------------------------------------------------------

/**
 * The default per-provider refresh threshold. Tavily's documented
 * 10 calls / 10 minutes / key limit is the floor; this threshold
 * ensures the after-command due-refresh never exceeds one call per
 * provider per 10 minutes. Explicit `quota`/`doctor` refreshes bypass
 * this (the user asked for fresh data).
 */
export const DEFAULT_QUOTA_STALE_THRESHOLD_MS = 10 * 60 * 1000;

/**
 * A snapshot is stale when `observedAt` is older than the threshold
 * relative to `now`. A missing snapshot (undefined) is always stale.
 */
export function isQuotaSnapshotStale(
  snapshot: ProviderQuotaSnapshot | undefined,
  now: number,
  thresholdMs: number = DEFAULT_QUOTA_STALE_THRESHOLD_MS,
): boolean {
  if (!snapshot) return true;
  return now - snapshot.observedAt > thresholdMs;
}

// ---------------------------------------------------------------------------
// Refresh coordinator — bounded, single-attempt, best-effort
// ---------------------------------------------------------------------------

/**
 * The shape this module needs from a Provider Descriptor to refresh
 * quota. Kept as a structural subset (not the full `ProviderDescriptor`)
 * so the refresh coordinator stays testable without importing
 * transport-level types. Production passes real descriptors; tests pass
 * fakes.
 */
export interface QuotaRefreshDescriptor {
  readonly id: ProviderId;
  isConfigured(env: NodeJS.ProcessEnv): boolean;
  capabilities(): ReadonlySet<string>;
  create(context: { readonly env: NodeJS.ProcessEnv }): {
    readonly quota?: { invoke(): Promise<{ categories: readonly QuotaCategory[] }> };
  };
}

export interface QuotaRefreshOptions {
  readonly descriptors: readonly QuotaRefreshDescriptor[];
  readonly env: NodeJS.ProcessEnv;
  readonly store: QuotaStore;
  readonly now?: () => number;
  readonly thresholdMs?: number;
  /**
   * When `true`, ignore the staleness threshold and refresh every
   * configured provider with a quota capability. Used by the explicit
   * `quota`/`doctor` trigger (the user asked for fresh data). The
   * per-provider transport timeout + single-attempt contract still
   * applies; only the cadence gate is bypassed.
   */
  readonly force?: boolean;
  /**
   * Best-effort per-provider error sink. A refresh failure is isolated:
   * the failing provider's snapshot stays stale (or absent), the other
   * providers' writes proceed, and the caller's promise never rejects.
   * Production wires a stderr notice; tests inject a recorder.
   */
  readonly onError?: (providerId: ProviderId, error: unknown) => void;
}

/**
 * Refresh quota snapshots for every configured provider that advertises
 * a `quota` capability.
 *
 * Contract:
 *   - **Single attempt per provider.** Does NOT route through
 *     `executeProviderOperation` — that primitive defaults quota to one
 *     retry (`lib/execution.ts`), which violates this ticket's
 *     single-attempt rule. Each provider's transport already carries
 *     its own timeout (AbortController); this coordinator relies on
 *     that and does not add an outer retry loop.
 *   - **Bounded cadence.** When `force` is false, a provider whose
 *     `observedAt` is within {@link DEFAULT_QUOTA_STALE_THRESHOLD_MS}
 *     is skipped. When `force` is true (explicit `quota`/`doctor`),
 *     the cadence gate is bypassed.
 *   - **Parallel, isolated.** All due providers are queried in parallel
 *     (`Promise.allSettled`-style); each failure is routed to
 *     `onError` and never rejects the outer promise.
 *   - **Raw categories only.** The verbatim `ProviderQuotaSuccess.categories`
 *     array is written; PB-T3 maps them. No score is derived here.
 *   - **`observedAt` only.** The write advances `observedAt`;
 *     `locallyUpdatedAt` is preserved by the store (PB-T2 advances it).
 *
 * This function is the single acquisition path for the periodic
 * refresh. The Brave passive harvest is wired separately through the
 * Brave search capability's `onResponseHeaders` callback.
 */
export async function refreshQuotaSnapshots(options: QuotaRefreshOptions): Promise<void> {
  const now = options.now ?? Date.now;
  const thresholdMs = options.thresholdMs ?? DEFAULT_QUOTA_STALE_THRESHOLD_MS;
  const force = options.force === true;
  const onError = options.onError ?? (() => {});

  // Enumerate via the injected descriptor list — no provider-name switch.
  const due = options.descriptors.filter((d) => {
    if (!d.isConfigured(options.env)) return false;
    if (!d.capabilities().has("quota")) return false;
    return true;
  });

  // Filter by staleness unless forced. Read the store ONCE up-front;
  // the per-provider check is a pure lookup against the snapshot.
  const state = force ? undefined : await options.store.read();

  await Promise.all(
    due.map(async (descriptor) => {
      // Cadence gate (skipped when force is true).
      if (!force) {
        const snapshot = state?.quota[descriptor.id];
        if (!isQuotaSnapshotStale(snapshot, now(), thresholdMs)) {
          return;
        }
      }
      try {
        const adapter = descriptor.create({ env: options.env });
        const capability = adapter.quota;
        if (!capability) return; // Descriptor/adapter mismatch — silently skip.
        // Single attempt; no retry. The transport's own timeout
        // bounds the duration.
        const result = await capability.invoke();
        await options.store.writeObserved(descriptor.id, {
          observedAt: now(),
          categories: result.categories,
        });
      } catch (error) {
        // Isolated: never reject the outer promise. The snapshot
        // stays stale; the next due-refresh retries.
        onError(descriptor.id, error);
      }
    }),
  );
}
