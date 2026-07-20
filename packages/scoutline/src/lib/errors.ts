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
 * `ZaiError` for backward compatibility. The legacy 1-arg
 * `formatErrorOutput` helper is preserved so Phase 1 command handlers
 * keep compiling; the pure invocation-local replacement lives in
 * `./output.js` (DESIGN.md §3) and replaces it in P1-10.
 *
 * P4-01 routes both the legacy and the invocation-local error
 * formatters through `lib/redact.js` so redaction is a single source of
 * truth.
 */

import { redactCredentialString, configuredSecrets } from "./redact.js";

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
  | "UNKNOWN_ERROR";

export interface ScoutlineErrorOptions {
  statusCode?: number;
  help?: string;
  retryable?: boolean;
  exitCode?: number;
}

export class ScoutlineError extends Error {
  readonly code: ScoutlineErrorCode | string;
  readonly statusCode?: number;
  readonly help?: string;
  readonly retryable: boolean;
  readonly exitCode: number;

  constructor(
    message: string,
    code: ScoutlineErrorCode | string,
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
 */
export class ZaiError extends ScoutlineError {
  constructor(message: string, code: string, statusCode?: number, help?: string) {
    super(message, code, { statusCode, help });
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
      { exitCode: 1 },
    );
    this.name = "UnsupportedCapabilityError";
  }
}

export class UnsupportedOptionError extends ScoutlineError {
  constructor(provider: string, capability: string, option: string) {
    super(
      `Provider "${provider}" does not support option "${option}" for capability "${capability}"`,
      "UNSUPPORTED_OPTION",
      { exitCode: 1 },
    );
    this.name = "UnsupportedOptionError";
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

// ---------------------------------------------------------------------------
// Legacy 1-arg `formatErrorOutput` (compat). Phase 1 command handlers
// still call this with an unknown error value and rely on the legacy
// `ZAI_OUTPUT_MODE` env var for pretty-print decisions. The pure,
// invocation-local replacement lives in `./output.js` (DESIGN.md §3) and
// replaces this helper in P1-10.
//
// P4-01: every field that reaches the public envelope is run through the
// shared `redactCredentialString` from `./redact.js` so credential
// material embedded in `message` or `help` is replaced with
// `[REDACTED]` before the value reaches stdout/stderr. The configured
// Provider credentials from the process environment are passed in as
// extra replacement targets.
// ---------------------------------------------------------------------------

export function formatErrorOutput(error: unknown): string {
  const pretty =
    typeof process !== "undefined" && process.env && process.env.ZAI_OUTPUT_MODE === "pretty";
  const secrets = configuredSecrets();
  if (error instanceof ScoutlineError) {
    const payload: Record<string, unknown> = {
      success: false,
      error: redactCredentialString(error.message, secrets),
      code: error.code,
    };
    if (error.help) {
      payload.help = redactCredentialString(error.help, secrets);
    }
    if (typeof error.statusCode === "number") {
      payload.statusCode = error.statusCode;
    }
    return JSON.stringify(payload, null, pretty ? 2 : 0);
  }

  if (error instanceof Error) {
    return JSON.stringify(
      {
        success: false,
        error: redactCredentialString(error.message, secrets),
        code: "UNKNOWN_ERROR",
      },
      null,
      pretty ? 2 : 0,
    );
  }

  return JSON.stringify(
    {
      success: false,
      error: redactCredentialString(String(error), secrets),
      code: "UNKNOWN_ERROR",
    },
    null,
    pretty ? 2 : 0,
  );
}
