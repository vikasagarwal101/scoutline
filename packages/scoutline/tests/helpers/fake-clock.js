/**
 * Test helper: createFakeClock — a deterministic clock for offline tests.
 *
 * now() returns the current virtual ms; sleep() advances time and resolves
 * without wall-clock waiting; random() returns a stable value.
 */
export function createFakeClock(start = 0) {
  let now = start;
  /** @type {Array<{ms:number,resolvedAt:number}>} */
  const delays = [];
  let rngState = 0x9e3779b9;

  const clock = {
    now() {
      return now;
    },
    async sleep(ms) {
      delays.push({ ms, resolvedAt: now });
      now += ms;
    },
    random() {
      // xorshift32 — deterministic, no wall clock dependency.
      let x = rngState | 0;
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      rngState = x | 0;
      // Map to [0, 1).
      return ((x >>> 0) % 1_000_000) / 1_000_000;
    },
    setNow(value) {
      now = value;
    },
    advance(ms) {
      now += ms;
    },
    delays,
  };

  return clock;
}
