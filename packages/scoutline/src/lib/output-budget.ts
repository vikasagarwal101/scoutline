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
    // Null-prototype accumulator (fix-round): a payload's OWN
    // `__proto__` key (legal in JSON — `JSON.parse` creates it as an
    // own property) must survive as an own key. On a `{}` accumulator
    // the assignment `sorted["__proto__"] = v` routes through
    // Object.prototype's setter and the key silently vanishes from
    // measurement while the printed JSON still carries it — the
    // measured size then under-reports the print.
    const sorted: Record<string, unknown> = Object.create(null);
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
 * Chars reserved for the `compaction {budget, ref}` stamp the handler
 * seam adds to every budgeted projection AFTER `applyBudget` returns
 * (ADR-0007 D6: the field lives inside the data payload). Upper bound
 * of `,"compaction":{"budget":<n>,"ref":"YYYYMMDDThhmmssZ-hex"}` at the
 * compact-JSON measurement the engine uses — deterministic, offline,
 * and honest at the seam: the walked projection plus this reserve fits
 * the budget in data mode (ADR-0007: "measurement is serialized payload
 * length"). Output wrappers (`-O json`'s success/timestamp envelope,
 * pretty indentation, text presentations) are presentation chrome the
 * ADR scopes OUT of the measured payload; README documents the budget
 * as applying to the payload.
 */
// Fix-round R2: exact upper bound of the appended JSON fragment
// `,"compaction":{"budget":<n>,"ref":"<21-char requestId>"}` (+16 for
// `,"note":"floor"` on the floor path). finalUrl/ids aside, the ref is a
// fixed 21-char requestId (`YYYYMMDDThhmmssZ-` + 4 hex), so the non-floor
// stamp is 36 + digits(budget) + 21 chars — bounded by the longest budget
// the CLI can print. Keep the constant exact so projections reach the
// budget without overshooting it.
// Measured: `,"compaction":{"budget":300,"ref":"<21-char>"}` is 68 chars;
// the floor form adds `,"note":"floor"` (16) = 84 max for realistic budgets.
// 84 reserves the exact worst case so stamped output never overshoots.
export const COMPACTION_STAMP_RESERVE = 84;

/**
 * Project `envelope` onto `budget` chars by walking `ladder`. Pure: the
 * input is never mutated and an envelope that already fits is returned
 * by reference with no `compaction`. Negative and NaN budgets normalize
 * to 0 (floor clamp); an infinite budget always fits.
 *
 * The walk reserves {@link COMPACTION_STAMP_RESERVE} chars for the
 * mandatory stamp, so a returned projection plus its `compaction` field
 * fits `budget` — the dispatcher no longer overshoots by appending the
 * stamp unmeasured.
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
  // ponytail: reserve assumes the compact stamp shape above; if the
  // stamp grows a third field (e.g. reason codes), bump the constant.
  const target = Math.max(0, effectiveBudget - COMPACTION_STAMP_RESERVE);
  // Fix-round R2: ladder rules run TO EXHAUSTION before the next rule —
  // an exhausted early rule (all lines bled) must not leave the next rule
  // (section drops) blind to the target. The old shape exited the whole
  // ladder the moment any rule could not shrink, so documents whose
  // never-cut skeleton alone exceeded the target skipped every drop and
  // floor-clamped with useless bled content instead of a minimal shape.
  let exhausted = true;
  for (const rule of ladder) {
    while (size > target) {
      const next = rule.apply(projection);
      if (next === projection) break;
      const nextSize = measurePayload(next);
      if (nextSize >= size) break;
      projection = next;
      size = nextSize;
    }
    if (size <= target) return { projection, compaction: { budget: effectiveBudget } };
    if (rule.apply(projection) !== projection) exhausted = false;
  }
  void exhausted;
  return { projection, compaction: { budget: effectiveBudget, note: "floor" } };
}
