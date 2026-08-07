/**
 * Error types and handling for Scoutline.
 *
 * P1-01 introduces the normalised error contract from DESIGN.md §4:
 *   `ScoutlineErrorCode`, `ScoutlineError`, `ValidationError`,
 *   `UnsupportedCapabilityError`, `UnsupportedOptionError`,
 *   `ConfigurationError`, `isRetryableError`, `getErrorExitCode`.
 *
 * The legacy `ZaiError` compatibility name is retained with its existing
 * 4-arg constructor signature so current imports keep working without
 * modification. Legacy subclasses (`AuthError`, `ApiError`,
 * `NetworkError`, `TimeoutError`, `FileError`) continue to extend
 * `ZaiError` for backward compatibility. The invocation-local
 * `formatErrorOutput` lives in `./output.js` (DESIGN.md §3).
 *
 * P4-01 routes the error formatter in `lib/output.js` through
 * `lib/redact.js` so redaction is a single source of truth.
 */

export type ScoutlineErrorCode =
  | "AUTH_ERROR"
  | "TIMEOUT_ERROR"
  | "NETWORK_ERROR"
  | "VALIDATION_ERROR"
  | "QUOTA_ERROR"
  | "UNSUPPORTED_CAPABILITY"
  | "UNSUPPORTED_OPTION"
  | "API_ERROR"
  | "FILE_ERROR"
  | "UNKNOWN_ERROR"
  | "CONFIGURATION_ERROR";

export interface ScoutlineErrorOptions {
  statusCode?: number;
  help?: string;
  retryable?: boolean;
  exitCode?: number;
}

export class ScoutlineError extends Error {
  readonly code: ScoutlineErrorCode;
  readonly statusCode?: number;
  readonly help?: string;
  readonly retryable: boolean;
  readonly exitCode: number;

  constructor(
    message: string,
    code: ScoutlineErrorCode,
    options: ScoutlineErrorOptions = {},
  ) {
    super(message);
    this.name = "ScoutlineError";
    this.code = code;
    this.statusCode = options.statusCode;
    this.help = options.help;
    this.retryable = options.retryable ?? false;
    this.exitCode = options.exitCode ?? 1;
  }
}

/**
 * Compatibility name for existing imports. The 4-arg constructor
 * signature matches the legacy `ZaiError` so current call sites keep
 * working without modification. Status codes passed here become
 * `statusCode`; `help` becomes `help`; `retryable` and `exitCode` keep
 * their defaults (`false` / `1`).
 *
 * The `code` parameter retains its legacy `string` type so existing
 * call sites (and tests) that pass non-union string codes keep
 * compiling. The value is cast through `ScoutlineErrorCode` at the
 * super call because TypeScript types are erased at runtime — the
 * parent constructor stores whatever string was passed.
 */
export class ZaiError extends ScoutlineError {
  constructor(message: string, code: string, statusCode?: number, help?: string) {
    super(message, code as ScoutlineErrorCode, { statusCode, help });
    this.name = "ZaiError";
  }
}

export class ValidationError extends ScoutlineError {
  constructor(message: string, help?: string) {
    super(message, "VALIDATION_ERROR", {
      statusCode: 400,
      help,
      exitCode: 1,
    });
    this.name = "ValidationError";
  }
}

export class UnsupportedCapabilityError extends ScoutlineError {
  constructor(provider: string, capability: string) {
    super(
      `Provider "${provider}" does not support capability "${capability}"`,
      "UNSUPPORTED_CAPABILITY",
      {
        help: "Use --provider <id> to select a Provider that supports this Capability, or remove --no-fallback to enable cross-Provider rerouting.",
        exitCode: 1,
      },
    );
    this.name = "UnsupportedCapabilityError";
  }
}

/**
 * Provider-specific option unsupported by a Capability. The constructor
 * signature is unchanged so all current throw sites keep compiling without
 * modification; the structured fields expose the same information notices
 * used to extract from the message string. Provider-fallback notices read
 * these fields directly (the message format MUST stay stable — it is
 * checked verbatim by existing adapter tests).
 */
export class UnsupportedOptionError extends ScoutlineError {
  readonly provider: string;
  readonly capability: string;
  readonly option: string;
  constructor(provider: string, capability: string, option: string) {
    super(
      `Provider "${provider}" does not support option "${option}" for capability "${capability}"`,
      "UNSUPPORTED_OPTION",
      { exitCode: 1 },
    );
    this.name = "UnsupportedOptionError";
    this.provider = provider;
    this.capability = capability;
    this.option = option;
  }
}

export class ConfigurationError extends ScoutlineError {
  constructor(message: string, help?: string) {
    // Configuration failures use exit 3 to distinguish them from
    // ordinary command failures (DESIGN.md §4, GATE-1). The public code is
    // CONFIGURATION_ERROR; the previous "FILE_ERROR" code was semantically
    // wrong (FILE_ERROR is reserved for file/media failures in Phase 3).
    super(message, "CONFIGURATION_ERROR", { help, exitCode: 3 });
    this.name = "ConfigurationError";
  }
}

/**
 * Normalized concrete quota-exhaustion error (DESIGN.md §18, PRD FR-090).
 *
 * P6 introduces this construction path because the public code (`QUOTA_ERROR`,
 * status 429, terminal retry) has been declared since P1 but no concrete
 * class existed. The Adapters and shared execution surface this class for
 * Provider-side exhausted-quota conditions; `formatErrorOutput` and the
 * invocation adapter apply the standard redaction/envelope so credential
 * material and Provider bodies never reach the public envelope.
 *
 * Retry semantics are intentionally terminal: an exhausted quota cannot be
 * resolved by another attempt. The shared retry classifier in
 * `lib/execution.ts` relies on `retryable === false` here.
 */
export class QuotaError extends ScoutlineError {
  constructor(message?: string, help?: string) {
    super(message ?? "Provider quota has been exhausted", "QUOTA_ERROR", {
      statusCode: 429,
      help,
      retryable: false,
      exitCode: 1,
    });
    this.name = "QuotaError";
  }
}

export function isRetryableError(error: unknown): boolean {
  if (error instanceof ScoutlineError) {
    return error.retryable;
  }
  return false;
}

export function getErrorExitCode(error: unknown): number {
  if (error instanceof ScoutlineError) {
    return error.exitCode;
  }
  return 1;
}

// ---------------------------------------------------------------------------
// Legacy subclasses (compat). Kept for Phase 1 command handlers; the ones
// that survive into Phase 2 are validated during that phase's migration.
// ---------------------------------------------------------------------------

export class AuthError extends ZaiError {
  // Fixup C — W2: AuthError help text is Provider-neutral. The default
  // message points at "your Provider credentials" instead of naming a
  // specific env var, since the same AuthError surfaces for any Provider
  // transport failure (including MiniMax). Callers that DO know which
  // Provider failed can pass `keyName` to tighten the guidance.
  constructor(message: string, keyName?: string) {
    const help = keyName
      ? `Check that ${keyName} is valid and has sufficient quota for the active Provider`
      : "Check that your Provider credentials are valid and have sufficient quota";
    super(message, "AUTH_ERROR", 401, help);
  }
}

export class ApiError extends ZaiError {
  constructor(message: string, statusCode: number) {
    super(message, "API_ERROR", statusCode);
  }
}

export class NetworkError extends ZaiError {
  constructor(message: string) {
    super(message, "NETWORK_ERROR", undefined, "Check your internet connection");
  }
}

export class TimeoutError extends ZaiError {
  /**
   * The configured timeout duration that elapsed, in milliseconds. Kept as
   * a first-class field (Fixup D) so an Adapter rewrapping a typed
   * `TimeoutError` can preserve the original duration instead of re-reading
   * an ambient `process.env` value that may differ from the injected env.
   *
   * Phase A MiniMax transport (critique G4): the constructor accepts an
   * optional `help` override so MiniMax callers can surface the
   * `MINIMAX_TIMEOUT` env var instead of the default `Z_AI_TIMEOUT`
   * reference. Strict superset — existing 1-arg callers continue to
   * receive the default help text unchanged.
   */
  readonly durationMs: number;
  constructor(timeoutMs: number, help?: string) {
    super(
      `Request timed out after ${timeoutMs}ms`,
      "TIMEOUT_ERROR",
      undefined,
      help ?? "Try again or increase timeout with Z_AI_TIMEOUT env var",
    );
    this.durationMs = timeoutMs;
  }
}

export class FileError extends ZaiError {
  constructor(message: string, help?: string) {
    super(message, "FILE_ERROR", undefined, help);
  }
}
