/**
 * parseZonedInstant unit tests (#217).
 *
 * The zone-less grammar must accept MINUTE precision (valid ISO 8601 /
 * ECMAScript: `2026-09-01T00:00`) and trim surrounding whitespace
 * before matching — both shapes previously slipped the UTC anchor and
 * fell through to bare `Date.parse`, which reads zone-less strings in
 * the HOST timezone (the exact host-TZ shift the helper exists to
 * prevent). Seconds-precision anchoring is pinned alongside as the
 * regression guard, with TZ forced to a non-UTC zone for teeth.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseZonedInstant } from "../dist/lib/parse-zoned-instant.js";

function withTz(tz, fn) {
  const prev = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.TZ;
    else process.env.TZ = prev;
  }
}

describe("parseZonedInstant — zone-less grammar (#217)", () => {
  it("anchors a zone-less seconds form to UTC regardless of TZ", () => {
    withTz("America/New_York", () => {
      assert.strictEqual(
        parseZonedInstant("2026-09-01 00:00:00"),
        Date.parse("2026-09-01T00:00:00Z"),
      );
    });
  });

  it("anchors a zone-less MINUTE form to UTC regardless of TZ (#217)", () => {
    withTz("America/New_York", () => {
      // In a non-UTC host zone a minute-form string parsed bare would
      // land 4h later than the UTC anchor — equality proves anchoring.
      assert.strictEqual(
        parseZonedInstant("2026-09-01T00:00"),
        Date.parse("2026-09-01T00:00Z"),
      );
      assert.strictEqual(
        parseZonedInstant("2026-09-01 00:00"),
        Date.parse("2026-09-01T00:00Z"),
      );
    });
  });

  it("anchors a zone-less minute form with fractional seconds (#217)", () => {
    withTz("America/New_York", () => {
      assert.strictEqual(
        parseZonedInstant("2026-09-01T00:00:30.500"),
        Date.parse("2026-09-01T00:00:30.500Z"),
      );
    });
  });

  it("trims surrounding whitespace before matching (#217)", () => {
    withTz("America/New_York", () => {
      assert.strictEqual(
        parseZonedInstant("  2026-09-01T00:00:00  "),
        Date.parse("2026-09-01T00:00:00Z"),
      );
      assert.strictEqual(
        parseZonedInstant(" 2026-09-01T00:00 "),
        Date.parse("2026-09-01T00:00Z"),
      );
    });
  });

  it("parses values already carrying a zone as-is", () => {
    assert.strictEqual(
      parseZonedInstant("2026-09-01T00:00:00.086Z"),
      Date.parse("2026-09-01T00:00:00.086Z"),
    );
    assert.strictEqual(
      parseZonedInstant("2026-09-01T00:00:00+05:30"),
      Date.parse("2026-09-01T00:00:00+05:30"),
    );
  });

  it("yields NaN for unparseable input", () => {
    assert.strictEqual(Number.isNaN(parseZonedInstant("not a date")), true);
    assert.strictEqual(Number.isNaN(parseZonedInstant("")), true);
  });
});
