/**
 * Consumption event + sink (Plan B — PB-T2).
 *
 * A **typed consumption event** represents one billable Provider
 * transport attempt. Shared execution emits it at the execution seam
 * (`lib/execution.ts`) — after the cache-miss check, around each
 * `operation.invoke()` call — so cache hits emit nothing and a retried
 * operation emits one event per attempt.
 *
 * Boundary rules:
 *   - Imports quota-store types (the sink writes to it) and provider
 *     identity types. No provider transport, no command presentation.
 *   - The sink is **best-effort**: a record failure is converted to a
 *     redacted warning and never propagates. A successful Provider
 *     result still returns; the retry/fallback classifier is never
 *     consulted on accounting state.
 *   - The amount is an explicit exact/estimate/unknown discriminated
 *     value. There is no `number = 1` default — Research/Vision and
 *     other variable-cost capabilities persist `unknown` or an
 *     explicit estimate rather than fake-precise consumption.
 *
 * Persistence lifecycle:
 *   - The sink's `record()` promise is awaited before the billable
 *     invoke returns outward, so the consumption write survives the
 *     bin's immediate `process.exit(status)`. A rejection is converted
 *     to a stderr warning; the outer promise still resolves.
 *
 * Relation to PB-T1 / PB-T3:
 *   - The sink calls PB-T1's `QuotaStore.writeConsumption`, advancing
 *     `locallyUpdatedAt` and adjusting the matching category's count
 *     set when one is exposed. `observedAt` (ground truth) never moves.
 *   - The event carries canonical data (capability ID, category, unit,
 *     amount). PB-T3 maps capabilities→categories and PB-T4 ranks;
 *     PB-T2 records raw, provider-neutral events and lets later layers
 *     interpret them.
 */

import type { ProviderId } from "../providers/types.js";
import type { QuotaUnit, ConsumptionAmount, QuotaStore } from "./quota-store.js";

// ---------------------------------------------------------------------------
// Event + context types
// ---------------------------------------------------------------------------

/**
 * A single billable Provider transport attempt. Emitted once per
 * `invoke()` inside `executeProviderOperation` — never at wrapper
 * level, never on cache hit, never from `quota`/`doctor`.
 *
 * `attempt` is the 1-based attempt index within one
 * `executeProviderOperation` loop (1 = first try, 2 = first retry...).
 */
export interface ConsumptionEvent {
  readonly provider: ProviderId;
  readonly capabilityId: string;
  readonly category?: string;
  readonly unit?: QuotaUnit;
  readonly amount: ConsumptionAmount;
  readonly attempt: number;
  readonly at: number;
}

/**
 * Provider-neutral metadata a billable wrapper passes into
 * `executeProviderOperation`. Identifies *what* is being consumed,
 * independent of *where* the event is recorded. The sink
 * (`ExecutionDependencies.consume`) is the *where*.
 *
 * `amount` defaults to {@link defaultAmountForCapability} when the
 * wrapper does not know a precise cost from the response usage — most
 * providers do not return per-call usage.
 */
export interface ConsumptionContext {
  readonly provider: ProviderId;
  readonly capabilityId: string;
  readonly category?: string;
  readonly unit?: QuotaUnit;
  readonly amount: ConsumptionAmount;
}

/**
 * Injectable sink. Production wires
 * {@link createQuotaStoreConsumptionSink} (atomic read-merge-write
 * against `~/.scoutline/state.json` via PB-T1's store); tests inject
 * {@link createInMemoryConsumptionSink} so assertions never touch disk.
 *
 * Contract: `record()` MUST NOT throw on accounting failure. The
 * shared-execution emission site does not catch — the sink converts
 * any internal failure to a warning before resolution. This keeps the
 * retry/fallback classifier free of accounting concerns.
 */
export interface ConsumptionSink {
  record(event: ConsumptionEvent): Promise<void>;
}

// ---------------------------------------------------------------------------
// Default amount per capability (honest cost model)
// ---------------------------------------------------------------------------

/**
 * Default {@link ConsumptionAmount} for a capability when the wrapper
 * has no response-usage to derive from. Most providers do not return
 * per-call usage, so the default is **unknown** — never a fake-precise
 * "1".
 *
 * Capabilities whose unit-cost is reliably one (Search, Repository,
 * Reader, Map) get `{ kind: "estimate", value: 1 }`. Capabilities
 * with variable cost (Research = 4–250 credits, Vision = variable
 * tokens, Crawl = per-page) default to `unknown`. PB-T3 refines these
 * mappings; PB-T2 records the honest default.
 */
export function defaultAmountForCapability(capabilityId: string): ConsumptionAmount {
  switch (capabilityId) {
    case "search":
    case "reader":
    case "repository-exploration":
    case "map":
      // Single-call cost; count-bearing categories get decremented by 1.
      return { kind: "estimate", value: 1 };
    case "vision":
    case "crawl":
    case "research":
      // Variable-cost: vision bills tokens; crawl bills per-page
      // credits; research bills 4–250 credits per request. Without a
      // response-carried usage, persist `unknown` rather than a
      // fake-precise number.
      return { kind: "unknown" };
    default:
      // Unrecognized capability — never guess.
      return { kind: "unknown" };
  }
}

// ---------------------------------------------------------------------------
// Production sink — writes to QuotaStore
// ---------------------------------------------------------------------------

export interface ConsumptionSinkOptions {
  readonly store: QuotaStore;
  readonly now?: () => number;
  /**
   * Best-effort warning sink. A write failure is isolated through this
   * callback; the recorded event's promise still resolves. Production
   * wires a stderr notice; tests inject a recorder. Default writes a
   * redacted message to stderr (no event detail, no PII).
   */
  readonly onWarning?: (message: string) => void;
}

function defaultConsumptionWarning(message: string): void {
  process.stderr.write(`scoutline: ${message}\n`);
}

/**
 * Build a production {@link ConsumptionSink} that writes through
 * {@link QuotaStore.writeConsumption}. The sink is fail-safe: any
 * internal rejection (disk full, permission, race) is converted to a
 * warning and the recorded promise resolves so shared execution never
 * observes an accounting failure.
 *
 * The store's per-file mutex serializes concurrent writes within the
 * process; cross-process concurrency is last-write-wins (acceptable
 * for an observational heuristic; PB-T1's atomic rename keeps the
 * final state crash-safe).
 */
export function createQuotaStoreConsumptionSink(options: ConsumptionSinkOptions): ConsumptionSink {
  const store = options.store;
  const now = options.now ?? Date.now;
  const onWarning = options.onWarning ?? defaultConsumptionWarning;
  return {
    async record(event: ConsumptionEvent): Promise<void> {
      try {
        await store.writeConsumption(
          event.provider,
          {
            ...(event.category !== undefined ? { category: event.category } : {}),
            ...(event.unit !== undefined ? { unit: event.unit } : {}),
            amount: event.amount,
          },
          event.at ?? now(),
        );
      } catch (error) {
        // Redacted: never log event detail (provider, capability) —
        // accounting failure is observational only.
        const reason = error instanceof Error ? error.message : String(error);
        onWarning(`quota consumption recording failed: ${reason}`);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Composite sink — record to both, isolate either (usage-ledger D3)
// ---------------------------------------------------------------------------

export interface CompositeConsumptionSinkOptions {
  /**
   * Best-effort warning sink for the case where one side's `record`
   * REJECTS outright — a defective sink. The production sinks convert
   * their own internal failures to warnings and never reject, so in
   * practice this channel fires only on a sink bug or a test double.
   * Default: stderr, like the quota-store sink.
   */
  readonly onWarning?: (message: string) => void;
}

/**
 * The fixed, redacted composite warning. The raw rejection text is
 * deliberately NOT interpolated (never log event detail) and no side is
 * named, so the message stays true when the composite is nested.
 */
const COMPOSITE_SINK_FAILURE_WARNING =
  "consumption recording failed in one sink; the failure was isolated";

/**
 * Combine two sinks so a single `record` reaches both (DESIGN D3:
 * production wires `composite(quotaStoreSink, usageLedgerSink)`). Awaits
 * both sides; each side's rejection is isolated to one warning and never
 * blocks or fails the other. The composite itself never throws.
 */
export function createCompositeConsumptionSink(
  primary: ConsumptionSink,
  secondary: ConsumptionSink,
  options: CompositeConsumptionSinkOptions = {},
): ConsumptionSink {
  const onWarning = options.onWarning ?? defaultConsumptionWarning;
  return {
    async record(event: ConsumptionEvent): Promise<void> {
      const recordIsolated = async (sink: ConsumptionSink): Promise<void> => {
        try {
          await sink.record(event);
        } catch {
          onWarning(COMPOSITE_SINK_FAILURE_WARNING);
        }
      };
      await Promise.all([recordIsolated(primary), recordIsolated(secondary)]);
    },
  };
}

// ---------------------------------------------------------------------------
// In-memory sink double (tests)
// ---------------------------------------------------------------------------

/**
 * Build an in-memory {@link ConsumptionSink} for hermetic tests. Records
 * every event in `events` (in arrival order); never rejects. Use this
 * to assert exact event sequences for cache-hit suppression, retry
 * emission, and observational-handler silence.
 */
export function createInMemoryConsumptionSink(): ConsumptionSink & {
  readonly events: ConsumptionEvent[];
} {
  const events: ConsumptionEvent[] = [];
  return {
    async record(event: ConsumptionEvent): Promise<void> {
      events.push(event);
    },
    get events(): ConsumptionEvent[] {
      return events;
    },
  };
}

// ---------------------------------------------------------------------------
// Emission helper — used by executeProviderOperation
// ---------------------------------------------------------------------------

/**
 * Emit one {@link ConsumptionEvent} through `sink`, deriving the event
 * from `context` + `attempt`. The promise ALWAYS resolves: a sink
 * failure has already been converted to a warning inside the sink, and
 * this helper adds a defensive outer try/catch so an exception in the
 * context-derivation path can never escape into the retry classifier.
 *
 * Returns void — shared execution awaits it before the invoke returns
 * outward, but the resolution value carries no information.
 */
export async function emitConsumption(
  sink: ConsumptionSink,
  context: ConsumptionContext,
  attempt: number,
  now: () => number,
): Promise<void> {
  try {
    await sink.record({
      provider: context.provider,
      capabilityId: context.capabilityId,
      ...(context.category !== undefined ? { category: context.category } : {}),
      ...(context.unit !== undefined ? { unit: context.unit } : {}),
      amount: context.amount,
      attempt,
      at: now(),
    });
  } catch {
    // Defensive double-wall: the production sink already swallows.
    // If a test sink throws, we still don't let it reach the retry
    // classifier.
  }
}
