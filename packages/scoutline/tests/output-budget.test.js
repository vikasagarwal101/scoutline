/**
 * Output Budget engine tests (ADR-0007, lane T1).
 *
 * Pins the pure projection engine:
 *   - serializePayload/measurePayload: deterministic canonical serialization
 *     (sorted object keys, array order preserved), measured in chars
 *     (UTF-16 code units — the same unit --max-chars truncation uses).
 *   - applyBudget no-op path: an envelope that fits is returned by
 *     reference with NO compaction field (zero-diff invariant).
 *   - Ladder walk: rules apply in order, each to fixpoint, until the
 *     projection fits; trim-early rules must run before drop-late rules
 *     (order pin — the fixture makes the wrong order observable).
 *   - Floor clamp: a budget below the minimum viable envelope returns the
 *     exhausted-ladder projection with compaction.note "floor"; never throws.
 *   - compaction carries { budget } only; the ref slot stays absent at this
 *     layer (T2 fills it).
 *   - Determinism and input purity: identical input + budget gives a
 *     byte-identical projection; the input envelope is never mutated.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  measurePayload,
  serializePayload,
  applyBudget,
  COMPACTION_STAMP_RESERVE,
} from "../dist/lib/output-budget.js";

const SUMMARY_LEN = 40;
const TRIMMED_SUMMARY_LEN = 4;

function makeEnvelope(itemCount, summaryLen = SUMMARY_LEN) {
  return {
    query: "q",
    results: Array.from({ length: itemCount }, (_, i) => ({
      url: `https://example.com/r${i + 1}`,
      title: `Result ${i + 1}`,
      summary: "s".repeat(summaryLen),
    })),
  };
}

// Trim-early rule (priority table: summaries trim before anything drops).
const trimSummaries = {
  name: "trim-summaries",
  apply: (p) => ({
    ...p,
    results: p.results.map((r) =>
      r.summary.length > TRIMMED_SUMMARY_LEN
        ? { ...r, summary: r.summary.slice(0, TRIMMED_SUMMARY_LEN) }
        : r,
    ),
  }),
};

// Drop-late rule (priority table: lowest ranks drop last; rank 1 survives).
const dropLowestRank = {
  name: "drop-lowest-rank",
  apply: (p) => (p.results.length > 1 ? { ...p, results: p.results.slice(0, -1) } : p),
};

const LADDER = [trimSummaries, dropLowestRank];

describe("serializePayload / measurePayload", () => {
  it("serializes objects with sorted keys regardless of insertion order", () => {
    assert.equal(serializePayload({ a: 1, b: 2 }), '{"a":1,"b":2}');
    assert.equal(serializePayload({ a: 1, b: 2 }), serializePayload({ b: 2, a: 1 }));
  });

  it("measures serialized length in chars, not UTF-8 bytes", () => {
    const value = "héllo 🧪";
    assert.equal(serializePayload(value), '"héllo 🧪"');
    assert.equal(measurePayload(value), 10);
    assert.notEqual(measurePayload(value), Buffer.byteLength(serializePayload(value)));
  });

  it("is deterministic across structurally equal values and preserves array order", () => {
    assert.equal(
      measurePayload({ a: 1, b: { c: 2, d: 3 } }),
      measurePayload({ b: { d: 3, c: 2 }, a: 1 }),
    );
    assert.notEqual(serializePayload([1, 2]), serializePayload([2, 1]));
  });
});

describe("applyBudget — fits without shrinking", () => {
  it("returns the input by reference with no compaction when it already fits", () => {
    const envelope = makeEnvelope(3);
    const result = applyBudget(envelope, measurePayload(envelope) + 100, LADDER);
    assert.equal(result.projection, envelope);
    assert.equal(result.compaction, undefined);
  });

  it("treats an exact-size budget as fitting (<=)", () => {
    const envelope = makeEnvelope(3);
    const result = applyBudget(envelope, measurePayload(envelope), LADDER);
    assert.equal(result.projection, envelope);
    assert.equal(result.compaction, undefined);
  });

  it("treats an infinite budget as fitting everything", () => {
    const envelope = makeEnvelope(3);
    const result = applyBudget(envelope, Infinity, LADDER);
    assert.equal(result.projection, envelope);
    assert.equal(result.compaction, undefined);
  });
});

describe("applyBudget — ladder walk", () => {
  it("trims early fields before dropping late items (order pin)", () => {
    const envelope = makeEnvelope(3);
    const expected = makeEnvelope(2, TRIMMED_SUMMARY_LEN);
    // Fix-round: the engine reserves room for the mandatory `compaction`
    // stamp, so "fits" means projected payload + reserve <= budget.
    const result = applyBudget(
      envelope,
      measurePayload(expected) + COMPACTION_STAMP_RESERVE,
      LADDER,
    );
    assert.deepEqual(result.projection, expected);
    assert.equal(result.projection.results.length, 2);
    assert.equal(result.projection.results[0].summary.length, TRIMMED_SUMMARY_LEN);
    assert.equal(result.projection.results[0].url, "https://example.com/r1");
    assert.equal(result.projection.results[1].url, "https://example.com/r2");
    assert.deepEqual(result.compaction, {
      budget: measurePayload(expected) + COMPACTION_STAMP_RESERVE,
    });
    assert.equal("ref" in result.compaction, false);
    assert.equal("note" in result.compaction, false);
  });

  it("applies a rule repeatedly until the projection fits", () => {
    const envelope = makeEnvelope(3);
    const budget = measurePayload(makeEnvelope(1)) + COMPACTION_STAMP_RESERVE;
    const result = applyBudget(envelope, budget, [dropLowestRank]);
    assert.equal(result.projection.results.length, 1);
    assert.equal(result.projection.results[0].url, "https://example.com/r1");
    assert.deepEqual(result.compaction, { budget });
  });

  it("advances to the next rule when a rule can shrink no further", () => {
    const noopRule = { name: "noop", apply: (p) => p };
    const envelope = makeEnvelope(3);
    const expected = makeEnvelope(3, TRIMMED_SUMMARY_LEN);
    const budget = measurePayload(expected) + COMPACTION_STAMP_RESERVE;
    const result = applyBudget(envelope, budget, [noopRule, trimSummaries]);
    assert.deepEqual(result.projection, expected);
    assert.deepEqual(result.compaction, { budget });
  });
});

describe("applyBudget — floor clamp", () => {
  const trimToEmpty = {
    name: "trim-to-empty",
    apply: (p) => ({
      ...p,
      results: p.results.map((r) => (r.summary === "" ? r : { ...r, summary: "" })),
    }),
  };
  const floorLadder = [trimToEmpty, dropLowestRank];
  const floorEnvelope = {
    query: "q",
    results: [{ url: "https://example.com/r1", title: "Result 1", summary: "" }],
  };

  it("clamps to the exhausted-ladder floor with note 'floor' below the viable minimum", () => {
    const result = applyBudget(makeEnvelope(3), 10, floorLadder);
    assert.deepEqual(result.projection, floorEnvelope);
    assert.deepEqual(result.compaction, { budget: 10, note: "floor" });
  });

  it("never throws on zero, negative, or NaN budgets", () => {
    for (const budget of [0, -5, NaN]) {
      const result = applyBudget(makeEnvelope(3), budget, floorLadder);
      assert.deepEqual(result.projection, floorEnvelope);
      assert.deepEqual(result.compaction, { budget: 0, note: "floor" });
    }
  });

  it("floors fractional budgets to integer chars and reports the floored budget", () => {
    const integerBudget = 10;
    const fractional = applyBudget(makeEnvelope(3), integerBudget + 0.9, floorLadder);
    const integral = applyBudget(makeEnvelope(3), integerBudget, floorLadder);
    assert.deepEqual(fractional.projection, integral.projection);
    assert.deepEqual(fractional.compaction, { budget: integerBudget, note: "floor" });
  });

  it("uses the envelope itself as the floor when the ladder is empty", () => {
    const envelope = makeEnvelope(1);
    const result = applyBudget(envelope, 1, []);
    assert.equal(result.projection, envelope);
    assert.deepEqual(result.compaction, { budget: 1, note: "floor" });
  });
});

describe("applyBudget — determinism and purity", () => {
  it("produces byte-identical projections for identical input and budget", () => {
    const budget = measurePayload(makeEnvelope(2, TRIMMED_SUMMARY_LEN));
    const first = applyBudget(makeEnvelope(3), budget, LADDER);
    const second = applyBudget(makeEnvelope(3), budget, LADDER);
    assert.equal(serializePayload(first.projection), serializePayload(second.projection));
    assert.equal(JSON.stringify(first.projection), JSON.stringify(second.projection));
    assert.deepEqual(first.compaction, second.compaction);
  });

  it("is insensitive to input key insertion order", () => {
    const budget = measurePayload(makeEnvelope(2, TRIMMED_SUMMARY_LEN));
    const reordered = {
      results: makeEnvelope(3).results.map((r) => ({
        summary: r.summary,
        title: r.title,
        url: r.url,
      })),
      query: "q",
    };
    const a = applyBudget(makeEnvelope(3), budget, LADDER);
    const b = applyBudget(reordered, budget, [
      {
        name: "trim-summaries",
        apply: (p) => ({
          ...p,
          results: p.results.map((r) =>
            r.summary.length > TRIMMED_SUMMARY_LEN
              ? { ...r, summary: r.summary.slice(0, TRIMMED_SUMMARY_LEN) }
              : r,
          ),
        }),
      },
      dropLowestRank,
    ]);
    assert.equal(serializePayload(a.projection), serializePayload(b.projection));
  });

  it("never mutates the input envelope", () => {
    const envelope = makeEnvelope(3);
    const snapshot = serializePayload(envelope);
    applyBudget(envelope, 1, LADDER);
    applyBudget(envelope, measurePayload(makeEnvelope(2, TRIMMED_SUMMARY_LEN)), LADDER);
    assert.equal(serializePayload(envelope), snapshot);
  });
});

describe("PR #103 fix-round — serialization safety + stamp reserve", () => {
  it("own __proto__ keys survive measurement (no silent drop)", () => {
    // JSON.parse can produce an own `__proto__` key. The accumulator
    // must carry it (null-prototype), never route through the
    // Object.prototype setter (silent drop → under-measurement).
    const envelope = JSON.parse('{"__proto__":{"polluted":true},"a":1}');
    const raw = JSON.stringify(envelope);
    assert.ok(raw.includes("polluted"), "own key present pre-measurement");
    // Canonical serialization must not LOSE the key's bytes — the whole
    // hazard was the Object.prototype setter dropping it mid-measure.
    assert.ok(
      serializePayload(envelope).includes("polluted"),
      "serializePayload keeps the own __proto__ key",
    );
    // And measurement must therefore include its bytes.
    assert.equal(
      measurePayload(envelope),
      serializePayload(envelope).length,
      "measurement counts every emitted byte",
    );
  });

  it("projection + stamped compaction fit within the requested budget (reserve pin)", () => {
    // Boundary case: the requested budget sits exactly reserve-sized
    // above the reachable floor (one row, summary trimmed to
    // TRIMMED_SUMMARY_LEN — LADDER's floor never trims to empty, R5
    // review: the previous ""-summary fixture was an unreachable
    // floor), so the walk lands within the reserve and the stamped
    // payload must fit the requested budget exactly.
    const envelope = makeEnvelope(3);
    const floor = measurePayload({
      query: "q",
      results: [
        { url: "https://example.com/r1", title: "Result 1", summary: "s".repeat(TRIMMED_SUMMARY_LEN) },
      ],
    });
    const budget = floor + COMPACTION_STAMP_RESERVE;
    const out = applyBudget(envelope, budget, LADDER);
    assert.ok(out.compaction, "budget below size must fire");
    const stamped = {
      ...out.projection,
      compaction: { ...out.compaction, ref: "20270115T080000Z-a1b2" },
    };
    assert.ok(
      measurePayload(stamped) <= budget,
      `walked projection + stamp (${measurePayload(stamped)}) must fit ${budget}`,
    );
  });
});
