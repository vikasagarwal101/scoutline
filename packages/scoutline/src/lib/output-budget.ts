/**
 * Output Budget engine (ADR-0007).
 *
 * Pure projection library for the whole-envelope `--max-chars` budget.
 * The engine is shape-agnostic: command layers hand it a data payload
 * envelope, a char budget, and an ordered ladder of shrinking rules
 * expressing that command's priority table (never-cut fields are
 * expressed by omission — no rule ever touches them; trim-early rules
 * precede drop-late rules).
 *
 * Ladder contract: rules apply in array order, each to fixpoint, until
 * `measurePayload(projection) <= budget`. A rule is exhausted when it
 * returns the identical projection or one that does not strictly reduce
 * the measured size; the walk then advances to the next rule. When
 * every rule is exhausted and the projection still exceeds the budget,
 * the result clamps to that floor envelope with `compaction.note:
 * "floor"` — the budget never throws and never destroys data.
 *
 * `compaction` is present ONLY when shrinking happened and carries the
 * applied `budget`; the `ref` slot stays absent at this layer (the
 * persistence layer fills it with the artifact requestId).
 *
 * Rules must be pure: they receive the current projection and return a
 * smaller one without mutating their input (the untrimmed envelope is
 * persisted verbatim when compaction fires).
 */

/** One ordered step of a budget ladder. */
export interface LadderRule<T = unknown> {
  readonly name: string;
  /**
   * Return a smaller projection, or the input unchanged when this rule
   * can shrink no further. Must not mutate `projection`.
   */
  apply(projection: T): T;
}

/** Ordered shrinking rules; earlier rules are cheaper losses. */
export type BudgetLadder<T = unknown> = readonly LadderRule<T>[];

/** Shrink record stamped inside the data payload when the budget fires. */
export interface BudgetCompaction {
  readonly budget: number;
  readonly ref?: string;
  readonly note?: "floor";
}

export interface BudgetOutcome<T = unknown> {
  readonly projection: T;
  readonly compaction?: BudgetCompaction;
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Canonical serialization for budget measurement: JSON with object keys
 * sorted recursively (insertion-order independent) and array order
 * preserved. Assumes acyclic plain JSON data, matching what the output
 * layer prints.
 */
export function serializePayload(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

/**
 * Serialized payload length in chars (UTF-16 code units — the same unit
 * `--max-chars` truncation uses). Deterministic: structurally equal
 * values measure identically regardless of key insertion order.
 */
export function measurePayload(value: unknown): number {
  return serializePayload(value).length;
}

/**
 * Project `envelope` onto `budget` chars by walking `ladder`. Pure: the
 * input is never mutated and an envelope that already fits is returned
 * by reference with no `compaction`. Negative and NaN budgets normalize
 * to 0 (floor clamp); an infinite budget always fits.
 */
export function applyBudget<T>(
  envelope: T,
  budget: number,
  ladder: BudgetLadder<T>,
): BudgetOutcome<T> {
  const effectiveBudget = Number.isNaN(budget) || budget < 0 ? 0 : Math.floor(budget);
  let projection = envelope;
  let size = measurePayload(projection);
  if (size <= effectiveBudget) {
    return { projection };
  }
  for (const rule of ladder) {
    while (size > effectiveBudget) {
      const next = rule.apply(projection);
      if (next === projection) break;
      const nextSize = measurePayload(next);
      if (nextSize >= size) break;
      projection = next;
      size = nextSize;
    }
    if (size <= effectiveBudget) {
      return { projection, compaction: { budget: effectiveBudget } };
    }
  }
  return { projection, compaction: { budget: effectiveBudget, note: "floor" } };
}
