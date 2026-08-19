/**
 * Shared diagnostics probe-error normalization (issue #57).
 *
 * Seven Provider diagnostics modules used to carry near-identical
 * module-private `normalizeProbeError` copies. This module replaces
 * them with one config-driven factory: each Provider supplies the
 * error classes its probe passes through unchanged plus the fallback
 * message used when a caught error matches none of them.
 *
 * The per-Provider config is deliberate and must not be unified:
 *   - Tavily intentionally omits QuotaError from its pass-through
 *     list, so a thrown QuotaError surfaces as the fallback ApiError.
 *   - Parallel's client rethrows ValidationError (HTTP 422), which no
 *     pass-through list includes, making Parallel the only Provider
 *     whose fallback is reachable through the probe seam.
 *   - Perplexity's client pre-wraps quota conditions into
 *     NetworkError, so its QuotaError entry is never exercised
 *     through the probe - preserve it anyway.
 */

import {
  ApiError,
  AuthError,
  ConfigurationError,
  NetworkError,
  QuotaError,
  TimeoutError,
} from "./errors.js";

/** Constructor of a normalized error class a probe passes through. */
export type ProbePassThroughError = abstract new (...args: never[]) => Error;

/** Per-Provider normalization contract for diagnostics probe failures. */
export interface ProbeErrorNormalizerConfig {
  /**
   * Error classes passed through unchanged. Membership is Provider
   * policy - see the module notes before changing a list.
   */
  readonly passThrough: readonly ProbePassThroughError[];

  /** ApiError message (status 500) wrapping non-pass-through errors. */
  readonly fallbackMessage: string;
}

/** Probe-error normalizer produced by `createProbeErrorNormalizer`. */
export type NormalizeProbeError = (error: unknown) => Error;

/**
 * Standard pass-through set shared by most probes: every typed error
 * the Provider clients surface. Tavily intentionally narrows it (no
 * QuotaError) and builds its own list.
 */
export const STANDARD_PROBE_PASS_THROUGH: readonly ProbePassThroughError[] = [
  AuthError,
  ApiError,
  NetworkError,
  QuotaError,
  TimeoutError,
  ConfigurationError,
];

/**
 * Build a diagnostics probe-error normalizer from Provider config.
 * Errors matching a pass-through class are returned unchanged; all
 * others are wrapped as `new ApiError(fallbackMessage, 500)` so no
 * raw Provider error crosses the diagnostics boundary.
 */
export function createProbeErrorNormalizer(
  config: ProbeErrorNormalizerConfig,
): NormalizeProbeError {
  return function normalizeProbeError(error: unknown): Error {
    for (const ErrorClass of config.passThrough) {
      if (error instanceof ErrorClass) {
        return error;
      }
    }
    return new ApiError(config.fallbackMessage, 500);
  };
}
