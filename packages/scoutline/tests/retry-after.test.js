/**
 * Retry-After / rate-limit header parser — Lane P P2 pins (#186).
 *
 * GROUND: RFC 9110 §10.2.1 — `Retry-After = HTTP-date / delay-seconds`
 * where delay-seconds is `1*DIGIT` (an INTEGER, never fractional). RFC
 * 9110 §5.6.7 makes a recipient accept all three HTTP-date shapes.
 *
 * The parser is the single seam every science client routes a status-map
 * site through. Header VALUES never leave this module — only the parsed
 * millisecond number does.
 *
 * Tests import ../dist/... — verification order is build, then test.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseRetryAfterHintMs } from "../dist/lib/retry-after.js";

/**
 * Minimal Headers double with case-INSENSITIVE lookup, mirroring the
 * fetch `Headers` contract the real call sites hand in. Keys are stored
 * lowercased exactly as `Headers` does.
 */
function headersOf(values = {}) {
  const lower = new Map();
  for (const [key, value] of Object.entries(values)) {
    lower.set(key.toLowerCase(), value);
  }
  return {
    get(name) {
      const hit = lower.get(String(name).toLowerCase());
      return hit === undefined ? null : hit;
    },
  };
}

// "Wed, 21 Oct 2015 07:28:00 GMT" is 1445412480000; the clock below sits
// exactly 42s earlier, so the HTTP-date form pins an exact 42000 ms.
const HTTP_DATE = "Wed, 21 Oct 2015 07:28:00 GMT";
const HTTP_DATE_MS = 1445412480000;
const NOW_42S_BEFORE = () => 1445412438000;

describe("parseRetryAfterHintMs — Retry-After delta-seconds (RFC 9110 §10.2.1)", () => {
  it("an integer delta-seconds value converts to milliseconds", () => {
    assert.equal(parseRetryAfterHintMs(headersOf({ "Retry-After": "2" })), 2000);
  });

  it("zero is a real hint (0 ms), not an absence", () => {
    assert.equal(parseRetryAfterHintMs(headersOf({ "Retry-After": "0" })), 0);
  });

  it("a fractional value is REJECTED — delay-seconds is 1*DIGIT, not a decimal", () => {
    // "1.5" is the trap: Number.isInteger(1.5) is false, but the naive
    // `Number(value)` route would accept it as 1500 ms. The RFC grammar
    // is integer-only, so the header contributes nothing.
    assert.equal(parseRetryAfterHintMs(headersOf({ "Retry-After": "1.5" })), undefined);
  });

  it("a negative delta-seconds value contributes nothing", () => {
    assert.equal(parseRetryAfterHintMs(headersOf({ "Retry-After": "-5" })), undefined);
  });

  it("a unit-suffixed value is garbage, not seconds", () => {
    assert.equal(parseRetryAfterHintMs(headersOf({ "Retry-After": "0.5s" })), undefined);
  });

  it("an empty value contributes nothing", () => {
    assert.equal(parseRetryAfterHintMs(headersOf({ "Retry-After": "" })), undefined);
  });

  it("a non-numeric word contributes nothing", () => {
    assert.equal(parseRetryAfterHintMs(headersOf({ "Retry-After": "soon" })), undefined);
  });

  it("a value that overflows the safe integer range contributes nothing", () => {
    assert.equal(
      parseRetryAfterHintMs(headersOf({ "Retry-After": "9".repeat(400) })),
      undefined,
    );
  });
});

describe("parseRetryAfterHintMs — Retry-After HTTP-date (RFC 9110 §10.2.1)", () => {
  it("an IMF-fixdate resolves against the injected clock to exact ms", () => {
    assert.equal(
      parseRetryAfterHintMs(headersOf({ "Retry-After": HTTP_DATE }), NOW_42S_BEFORE),
      HTTP_DATE_MS - 1445412438000,
    );
    assert.equal(
      parseRetryAfterHintMs(headersOf({ "Retry-After": HTTP_DATE }), NOW_42S_BEFORE),
      42000,
    );
  });

  it("a date already in the past clamps to 0 (never a negative sleep)", () => {
    assert.equal(
      parseRetryAfterHintMs(headersOf({ "Retry-After": HTTP_DATE }), () => HTTP_DATE_MS + 60000),
      0,
    );
  });

  it("a date exactly now is 0", () => {
    assert.equal(
      parseRetryAfterHintMs(headersOf({ "Retry-After": HTTP_DATE }), () => HTTP_DATE_MS),
      0,
    );
  });

  it("the obsolete RFC 850 date shape is accepted (§5.6.7 recipient rule)", () => {
    assert.equal(
      parseRetryAfterHintMs(
        headersOf({ "Retry-After": "Sunday, 06-Nov-94 08:49:37 GMT" }),
        () => Date.parse("Sun, 06 Nov 1994 08:48:37 GMT"),
      ),
      60000,
    );
  });

  it("the obsolete asctime date shape is accepted (§5.6.7 recipient rule)", () => {
    // asctime carries no zone, so Node reads it in the RUNNER's zone —
    // both sides of the subtraction must come from the same reading, or
    // this pin would pass in UTC and fail in Asia/Calcutta. The delta is
    // what the parser reports; the absolute instant is not the contract.
    const asctime = "Sun Nov  6 08:49:37 1994";
    assert.equal(
      parseRetryAfterHintMs(headersOf({ "Retry-After": asctime }), () => Date.parse(asctime) - 60000),
      60000,
    );
  });

  it("a bare number that Date.parse would read as a year is NOT an HTTP-date", () => {
    // "2015" already took the delta-seconds branch (2015000 ms) — this
    // pin proves the date branch cannot be reached by a digit-only value
    // that Date.parse happens to accept as a year.
    assert.equal(parseRetryAfterHintMs(headersOf({ "Retry-After": "2015" })), 2015000);
  });
});

describe("parseRetryAfterHintMs — the rate-limit header family", () => {
  it("X-RateLimit-Retry-After is an integer delta-seconds value", () => {
    assert.equal(parseRetryAfterHintMs(headersOf({ "X-RateLimit-Retry-After": "30" })), 30000);
  });

  it("X-RateLimit-Reset is a RELATIVE seconds-until-reset value (OpenAlex semantic)", () => {
    assert.equal(parseRetryAfterHintMs(headersOf({ "X-RateLimit-Reset": "120" })), 120000);
  });

  it("X-RateLimit-Reset rejects the fractional/garbage forms too", () => {
    assert.equal(parseRetryAfterHintMs(headersOf({ "X-RateLimit-Reset": "1.5" })), undefined);
    assert.equal(parseRetryAfterHintMs(headersOf({ "X-RateLimit-Reset": "" })), undefined);
    assert.equal(parseRetryAfterHintMs(headersOf({ "X-RateLimit-Reset": "-1" })), undefined);
  });
});

describe("parseRetryAfterHintMs — lookup, precedence, absence", () => {
  it("lookup is case-insensitive (fetch Headers already lowercases; the double proves the contract)", () => {
    assert.equal(parseRetryAfterHintMs(headersOf({ "retry-after": "3" })), 3000);
    assert.equal(parseRetryAfterHintMs(headersOf({ "RETRY-AFTER": "3" })), 3000);
    assert.equal(parseRetryAfterHintMs(headersOf({ "x-ratelimit-reset": "3" })), 3000);
  });

  it("Retry-After beats X-RateLimit-Retry-After beats X-RateLimit-Reset", () => {
    assert.equal(
      parseRetryAfterHintMs(
        headersOf({
          "Retry-After": "1",
          "X-RateLimit-Retry-After": "2",
          "X-RateLimit-Reset": "3",
        }),
      ),
      1000,
    );
    assert.equal(
      parseRetryAfterHintMs(
        headersOf({ "X-RateLimit-Retry-After": "2", "X-RateLimit-Reset": "3" }),
      ),
      2000,
    );
    assert.equal(parseRetryAfterHintMs(headersOf({ "X-RateLimit-Reset": "3" })), 3000);
  });

  it("an unparseable higher-precedence header falls THROUGH to the next source", () => {
    assert.equal(
      parseRetryAfterHintMs(
        headersOf({ "Retry-After": "garbage", "X-RateLimit-Reset": "7" }),
      ),
      7000,
    );
  });

  it("no hint headers at all → undefined (the absence contract)", () => {
    assert.equal(parseRetryAfterHintMs(headersOf({})), undefined);
    assert.equal(parseRetryAfterHintMs(headersOf({ "Content-Type": "application/json" })), undefined);
  });

  it("a header source with no readable headers → undefined (never throws)", () => {
    assert.equal(parseRetryAfterHintMs(undefined), undefined);
    assert.equal(parseRetryAfterHintMs({}), undefined);
    assert.equal(parseRetryAfterHintMs({ get: () => null }), undefined);
  });
});
