/**
 * Shared encoded MCP error envelope helpers (DESIGN.md §18).
 *
 * The ZRead and WebReader MCP transports occasionally surface a
 * bare-string error envelope of the shape:
 *
 *     MCP error -<status>\n
 *     error.code: <numeric>\n
 *     error.message: <text>
 *     <optional additional lines>
 *
 * The Repository Adapter (P6-04) and the Reader Adapter (Ticket 03)
 * both recognise this shape BEFORE attempting any success parsing.
 * Classification is centralized here so the taxonomy stays consistent
 * across Adapter implementations; each Adapter supplies an operation
 * `label` ("repository", "reader", …) that becomes part of the
 * sanitized outward message. Auth-message labels (401/403) are NOT
 * operation-specific and stay stable.
 *
 * Boundary rules:
 *   - This module imports normalized errors only; it imports no
 *     transport, no capability contract, and no other Adapter.
 *   - The raw Provider body, `error.message`, `reset`, etc. are
 *     discarded; outward messages and help text are stable sanitized
 *     labels.
 *
 * Historical note: P6-04A corrected the original mapping (status 403
 * must keep exact status 403, not collapse to 401) and P6-04B refined
 * the exhausted-quota phrase matching so that the bare word "limit"
 * inside "rate limited" does NOT trigger terminal QuotaError. Those
 * corrections are baked in here.
 */

import { ApiError, AuthError, QuotaError, ScoutlineError } from "../../lib/errors.js";

/** Regex that captures the status of an encoded MCP error envelope. */
export const ENCODED_MCP_ERROR_RE = /^MCP error -(\d+)\b/;

/**
 * Test whether `raw` looks like an encoded MCP error envelope. Returning
 * `true` forces the caller into the error classification path before any
 * success parser runs. The presence of a numeric status on the first
 * line is the only requirement; the body lines are still parsed lazily.
 */
export function looksLikeEncodedMcpError(raw: unknown): boolean {
  return typeof raw === "string" && ENCODED_MCP_ERROR_RE.test(raw);
}

/**
 * Extract the numeric status code from an encoded MCP error envelope.
 * Returns `null` when the prefix is not present or the trailing digits
 * do not parse to a finite integer.
 */
export function extractEncodedStatus(raw: string): number | null {
  const m = raw.match(ENCODED_MCP_ERROR_RE);
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

/** Extract the documented `error.code:` numeric value, if present. */
export function extractEncodedCode(raw: string): number | null {
  const m = raw.match(/^error\.code:\s*(\d+)/m);
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

/** Extract the documented `error.message:` line text, if present. */
export function extractEncodedMessage(raw: string): string | null {
  const m = raw.match(/^error\.message:\s*([^\n]+)/m);
  return m ? m[1] : null;
}

/**
 * Classify an encoded MCP error into a normalized error.
 *
 * The caller MUST have established that the response is an encoded
 * envelope (via {@link looksLikeEncodedMcpError}). This function NEVER
 * embeds the raw Provider body, message, or help into the outward text;
 * it uses stable sanitized labels instead.
 *
 * `label` is the operation name used in the outward ApiError / QuotaError
 * messages (e.g. "repository", "reader"). Auth messages (401, 403) do
 * not carry the label — they read "Z.AI authentication failed" regardless
 * of which Adapter surfaced them.
 *
 * Mapping (DESIGN.md §18; corrected by P6-04A, refined by P6-04B):
 *   - code 1310 OR explicit exhausted/limit/quota meaning
 *                                            -> terminal QuotaError
 *                                              (REGARDLESS of the encoded
 *                                              status line; a non-429 line
 *                                              with code 1310 is still an
 *                                              exhausted-quota failure);
 *   - 401                                 -> AuthError, status 401, terminal;
 *   - 403                                 -> normalized ScoutlineError
 *                                              with code AUTH_ERROR and
 *                                              statusCode 403, terminal
 *                                              (avoids widening the
 *                                              global AuthError
 *                                              constructor);
 *   - 429 (without exhausted quota)       -> ApiError, status 429,
 *                                              retryable through the shared
 *                                              taxonomy;
 *   - 5xx                                 -> ApiError matching status,
 *                                              retryable;
 *   - other 4xx                           -> ApiError matching status,
 *                                              terminal;
 *   - malformed envelope (no parseable status)
 *                                            -> ApiError 502, retryable.
 */
export function classifyEncodedMcpError(raw: string, label: string): Error {
  const status = extractEncodedStatus(raw);
  if (status === null) {
    // Malformed envelope: no parseable status. Retryable, sanitized.
    return new ApiError(`Z.AI ${label} request failed`, 502);
  }

  const code = extractEncodedCode(raw);
  const message = extractEncodedMessage(raw);
  const lowerMessage = (message ?? "").toLowerCase();

  // Exhausted quota: code 1310 OR explicit exhausted/limit-reaching
  // meaning. This branches BEFORE the status mapping so a non-429 encoded
  // status line carrying code 1310 or an explicit exhausted message still
  // becomes terminal `QuotaError`.
  //
  // The bare word "limit" is intentionally NOT matched on its own:
  // "rate limited" is a transient retryable 429, not exhausted quota.
  // The bare word "quota" is ALSO intentionally NOT matched on its own
  // (F4, code-review-baseline): a non-exhaustion message like "quota
  // window reset succeeded" or "quota header missing" would otherwise be
  // mis-classified as terminal QuotaError, blocking the legitimate
  // single retry. Exhaustion is signalled by code 1310 (authoritative)
  // or by the explicit phrases below:
  //   - "Weekly/Monthly Limit Exhausted"  -> "exhausted"
  //   - "Quota has been exhausted"         -> "exhausted"
  //   - "Monthly limit reached"            -> "limit reached"
  //   - "usage limit exceeded"             -> "limit exceeded"
  const isExhausted =
    code === 1310 ||
    lowerMessage.includes("exhausted") ||
    lowerMessage.includes("limit reached") ||
    lowerMessage.includes("limit exceeded");
  if (isExhausted) {
    return new QuotaError(
      `Z.AI ${label} quota has been exhausted`,
      "Check your Z.AI quota and try again later",
    );
  }

  if (status === 401) {
    return new AuthError("Z.AI authentication failed");
  }
  if (status === 403) {
    // 403 maps to AUTH_ERROR with status 403, terminal. Constructing
    // a localized normalized ScoutlineError (rather than widening
    // the global AuthError constructor) preserves the documented exact
    // status code without affecting legacy call sites elsewhere in the
    // codebase.
    return new ScoutlineError("Z.AI authentication failed", "AUTH_ERROR", {
      statusCode: 403,
      retryable: false,
      exitCode: 1,
    });
  }

  // 5xx and other 429 -> retryable; other 4xx -> terminal. The retry
  // classifier in `lib/execution.ts` reads `retryable` via the explicit
  // ApiError flag, but the per-status mapping here matches DESIGN.md §10
  // so the constructed errors carry the right shape regardless.
  if (status === 429) {
    return new ApiError(`Z.AI ${label} request failed`, 429);
  }
  if (status >= 500 && status <= 599) {
    return new ApiError(`Z.AI ${label} request failed`, status);
  }
  if (status >= 400 && status <= 499) {
    return new ApiError(`Z.AI ${label} request failed`, status);
  }

  // Unrecognized numeric status (e.g. 0, negative) -> retryable 502.
  return new ApiError(`Z.AI ${label} request failed`, 502);
}
