/**
 * Shared timeout upper clamp (#214).
 *
 * Node's `setTimeout` treats delays above the 32-bit signed maximum
 * (2,147,483,647 ms ≈ 24.8 days) as an immediate-fire 1 ms timer, so a
 * user-supplied `*_TIMEOUT` env override beyond that bound would silently
 * turn a long timeout into a near-instant one. Every provider client's
 * `*_TIMEOUT` env resolver therefore clamps the parsed value to
 * {@link TIMEOUT_MS_MAX} through this helper — the uniform rule Linkup
 * pioneered inline (`providers/linkup/client.ts`).
 *
 * Invalid input (NaN, zero, negative, non-finite) falls to the caller's
 * provider default, preserving each resolver's pre-#214 fallback
 * behavior. Cross-provider conformance is pinned by
 * `tests/timeout-clamp.test.js` — a client that ships its own ad-hoc
 * unclamped parse fails its row there.
 */

/** The largest delay `setTimeout` accepts before wrapping to 1 ms. */
export const TIMEOUT_MS_MAX = 2147483647;

/**
 * Validate and upper-clamp a parsed `*_TIMEOUT` override.
 *
 * @param raw - The parsed env value (`parseInt(..., 10)`)
 * @param defaultMs - The provider default returned for invalid input
 * @returns `raw` clamped to `[1, TIMEOUT_MS_MAX]`, or `defaultMs`
 */
export function clampTimeoutMs(raw: number, defaultMs: number): number {
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, TIMEOUT_MS_MAX) : defaultMs;
}
