/**
 * Provider retry-hint parsing — the transport seam for `Retry-After` and
 * the rate-limit header family (#186).
 *
 * A supplier that answers with a delay hint is telling the caller when to
 * come back; the shared executor already honours the parsed value as a
 * floor over its own backoff (`lib/execution.ts`). This module is the
 * producer end: Adapters hand the Response headers in where the status
 * map throws, and get back a millisecond number — or nothing.
 *
 * Sources, in precedence order (first PARSEABLE wins):
 *   1. `Retry-After` — RFC 9110 §10.2.1: `delay-seconds` (`1*DIGIT`, an
 *      integer — never fractional) or an HTTP-date.
 *   2. `X-RateLimit-Retry-After` — integer delta-seconds.
 *   3. `X-RateLimit-Reset` — SECONDS UNTIL RESET, relative (OpenAlex's
 *      documented semantic), not an epoch timestamp.
 *
 * Header VALUES never leave this module: callers receive a number only,
 * so provider-controlled text cannot reach an error message, a log, or
 * the public envelope. Anything unparseable — garbage, empty, negative,
 * non-integer, absent — contributes nothing and falls through to the
 * next source; nothing parseable yields `undefined`, which the Adapters
 * turn into an OMITTED error field (byte-identical error path).
 */

/** Minimal header surface — a fetch `Headers` satisfies it directly. */
export interface RetryHintHeaders {
  get?(name: string): string | null;
}

/** `1*DIGIT` delta-seconds → milliseconds (undefined when not that shape). */
function parseDeltaSeconds(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    return undefined;
  }
  const ms = Number(trimmed) * 1000;
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * HTTP-date → milliseconds from `now()`, clamped at zero (never negative).
 *
 * A value that LEADS with a digit or sign is a malformed `delta-seconds`,
 * never a date: `Date.parse` is lenient enough to read `"1.5"` as a year
 * and `"-5"` as a year, which would invent a delay out of garbage. The
 * RFC grammar keeps the two forms disjoint at the first character, so
 * this is a grammar check, not a heuristic.
 */
function parseHttpDate(raw: string, now: () => number): number | undefined {
  if (/^[+-]?[\d.]/.test(raw.trim())) {
    return undefined;
  }
  const at = Date.parse(raw);
  if (Number.isNaN(at)) {
    return undefined;
  }
  return Math.max(0, at - now());
}

/** `Retry-After` accepts either form; the rate-limit family is integer-only. */
function parseHintValue(
  raw: string,
  allowHttpDate: boolean,
  now: () => number,
): number | undefined {
  const delta = parseDeltaSeconds(raw);
  if (delta !== undefined) {
    return delta;
  }
  return allowHttpDate ? parseHttpDate(raw, now) : undefined;
}

/**
 * Read the first parseable retry hint off a Response's headers.
 *
 * `now` is injectable so the HTTP-date form is deterministic under test;
 * production callers take the default `Date.now`.
 */
export function parseRetryAfterHintMs(
  headers: RetryHintHeaders | null | undefined,
  now: () => number = Date.now,
): number | undefined {
  const sources: ReadonlyArray<readonly [string, boolean]> = [
    ["Retry-After", true],
    ["X-RateLimit-Retry-After", false],
    ["X-RateLimit-Reset", false],
  ];
  const read = headers?.get?.bind(headers);
  if (read === undefined) {
    return undefined;
  }
  for (const [name, allowHttpDate] of sources) {
    const raw = read(name);
    if (raw === null || raw === undefined || raw === "") {
      continue;
    }
    const hint = parseHintValue(raw, allowHttpDate, now);
    if (hint !== undefined) {
      return hint;
    }
  }
  return undefined;
}

/**
 * Error-constructor options carrying the hint, or NOTHING when there was
 * no parseable hint — the options object omits the key entirely, so nothing
 * is attached and the error message and stdout envelope stay byte-identical.
 * (The instance itself still materializes an own `retryAfterMs: undefined`
 * — the constructor's standing idiom, same as `statusCode`/`help`.)
 */
export function retryHintOptions(
  retryAfterMs: number | undefined,
): { retryAfterMs?: number } {
  return retryAfterMs === undefined ? {} : { retryAfterMs };
}
