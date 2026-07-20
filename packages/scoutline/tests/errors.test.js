/**
 * Unit tests for the normalised error contract.
 *
 * P1-01 asserts:
 *   - `ScoutlineError` carries `retryable` and `exitCode` and exposes
 *     normalised metadata used by the Command Invocation seam.
 *   - Configuration failures exit 3, ordinary failures exit 1.
 *   - `ZaiError` remains importable with its existing constructor
 *     signature for backward compatibility.
 *   - `formatErrorOutput` (the legacy one-arg compat wrapper) keeps the
 *     public envelope free of stack, cause, raw response bodies, and
 *     credential material.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ScoutlineError,
  ZaiError,
  ValidationError,
  ConfigurationError,
  UnsupportedCapabilityError,
  UnsupportedOptionError,
  AuthError,
  ApiError,
  NetworkError,
  TimeoutError,
  FileError,
  QuotaError,
  isRetryableError,
  getErrorExitCode,
  formatErrorOutput,
} from "../dist/lib/errors.js";

describe("ScoutlineError", () => {
  it("carries `code`, `retryable`, and `exitCode` from options", () => {
    const err = new ScoutlineError("boom", "API_ERROR", {
      statusCode: 500,
      help: "retry",
      retryable: true,
      exitCode: 1,
    });
    assert.strictEqual(err.message, "boom");
    assert.strictEqual(err.code, "API_ERROR");
    assert.strictEqual(err.statusCode, 500);
    assert.strictEqual(err.help, "retry");
    assert.strictEqual(err.retryable, true);
    assert.strictEqual(err.exitCode, 1);
    assert.strictEqual(err.name, "ScoutlineError");
  });

  it("defaults `retryable` to false and `exitCode` to 1", () => {
    const err = new ScoutlineError("plain", "API_ERROR");
    assert.strictEqual(err.retryable, false);
    assert.strictEqual(err.exitCode, 1);
  });
});

describe("ZaiError (compat name)", () => {
  it("extends ScoutlineError and keeps the original constructor signature", () => {
    const err = new ZaiError("Test error", "TEST_CODE", 500, "Help text");
    assert.strictEqual(err instanceof ScoutlineError, true);
    assert.strictEqual(err.message, "Test error");
    assert.strictEqual(err.code, "TEST_CODE");
    assert.strictEqual(err.statusCode, 500);
    assert.strictEqual(err.help, "Help text");
    assert.strictEqual(err.name, "ZaiError");
  });

  it("optional statusCode and help are supported", () => {
    const a = new ZaiError("msg", "CODE");
    assert.strictEqual(a.code, "CODE");
    assert.strictEqual(a.statusCode, undefined);
    assert.strictEqual(a.help, undefined);
  });
});

describe("ValidationError", () => {
  it("uses the VALIDATION_ERROR code and exits 1 by default", () => {
    const err = new ValidationError("Bad input");
    assert.strictEqual(err.code, "VALIDATION_ERROR");
    assert.strictEqual(err.exitCode, 1);
    assert.strictEqual(err.retryable, false);
    assert.strictEqual(err.message, "Bad input");
  });

  it("accepts an optional `help` argument", () => {
    const err = new ValidationError("Bad input", "use --help");
    assert.strictEqual(err.help, "use --help");
    assert.strictEqual(err.exitCode, 1);
  });
});

describe("ConfigurationError", () => {
  it("uses exit code 3 to signal a configuration failure", () => {
    const err = new ConfigurationError("Z_AI_API_KEY is required");
    assert.strictEqual(err.exitCode, 3);
    assert.strictEqual(err.retryable, false);
    assert.strictEqual(err.message, "Z_AI_API_KEY is required");
  });

  it("accepts an optional `help` argument", () => {
    const err = new ConfigurationError("bad config", "see docs");
    assert.strictEqual(err.help, "see docs");
    assert.strictEqual(err.exitCode, 3);
  });
});

describe("UnsupportedCapabilityError", () => {
  it("describes the provider and missing capability", () => {
    const err = new UnsupportedCapabilityError("minimax", "search");
    assert.strictEqual(err.code, "UNSUPPORTED_CAPABILITY");
    assert.strictEqual(err.exitCode, 1);
    assert.ok(err.message.includes("minimax"));
    assert.ok(err.message.includes("search"));
  });
});

describe("UnsupportedOptionError", () => {
  it("describes provider, capability, and unsupported option", () => {
    const err = new UnsupportedOptionError("minimax", "search", "domain");
    assert.strictEqual(err.code, "UNSUPPORTED_OPTION");
    assert.strictEqual(err.exitCode, 1);
    assert.ok(err.message.includes("minimax"));
    assert.ok(err.message.includes("search"));
    assert.ok(err.message.includes("domain"));
  });
});

describe("Legacy subclasses (compat)", () => {
  // Fixup C — W2: AuthError help text is generic (Provider-neutral),
  // not bound to Z_AI_API_KEY. The same AuthError surfaces for any
  // Provider transport failure, including MiniMax, so naming a single
  // env var would mislead callers configured against a different one.
  it("AuthError ships an AUTH_ERROR code with status 401 and a Provider-neutral help message", () => {
    const err = new AuthError("Invalid key");
    assert.strictEqual(err.code, "AUTH_ERROR");
    assert.strictEqual(err.statusCode, 401);
    assert.ok(typeof err.help === "string" && err.help.length > 0);
    assert.ok(
      !/Z_AI_API_KEY|ZAI_API_KEY|MINIMAX_API_KEY/.test(err.help),
      `help text must be Provider-neutral: ${err.help}`,
    );
    assert.ok(/credential|provider|key/i.test(err.help));
  });

  it("AuthError accepts a Provider-specific override for the help text", () => {
    // When the caller knows which Provider failed, the help can be
    // tightened by passing a `keyName` second argument. The default
    // constructor signature is unchanged (back-compat).
    const err = new AuthError("Invalid key", "Z_AI_API_KEY");
    assert.ok(err.help?.includes("Z_AI_API_KEY"));
  });

  it("ApiError carries the supplied status code", () => {
    const err = new ApiError("Server error", 503);
    assert.strictEqual(err.code, "API_ERROR");
    assert.strictEqual(err.statusCode, 503);
  });

  it("NetworkError carries a network failure help message", () => {
    const err = new NetworkError("Connection failed");
    assert.strictEqual(err.code, "NETWORK_ERROR");
    assert.ok(err.help?.includes("internet"));
  });

  it("TimeoutError encodes the timeout duration and exposes durationMs (Fixup D)", () => {
    const err = new TimeoutError(30000);
    assert.ok(err.message.includes("30000"));
    assert.strictEqual(err.code, "TIMEOUT_ERROR");
    assert.ok(err.help?.includes("Z_AI_TIMEOUT"));
    assert.strictEqual(err.durationMs, 30000);
  });

  it("TimeoutError accepts an optional `help` override (2-arg form)", () => {
    const err = new TimeoutError(30000, "Try again or increase timeout with MINIMAX_TIMEOUT env var");
    assert.strictEqual(
      err.help,
      "Try again or increase timeout with MINIMAX_TIMEOUT env var",
    );
  });

  it("FileError accepts an optional help hint", () => {
    const err = new FileError("File not found", "Check the path");
    assert.strictEqual(err.code, "FILE_ERROR");
    assert.strictEqual(err.help, "Check the path");
  });
});

// ---------------------------------------------------------------------------
// P6-03 — QuotaError (DESIGN.md §18, PRD FR-090). The concrete normalized
// class is the public construction path for Provider-side exhausted-quota
// conditions. It carries the documented public code, status, terminal
// retry behaviour, and exit code. Redaction is applied by the public
// envelope (`formatErrorOutput`, invocation adapter) so credential material
// and Provider bodies never reach the wire.
// ---------------------------------------------------------------------------

describe("QuotaError — concrete normalized construction", () => {
  it("uses QUOTA_ERROR code, status 429, terminal retry, and exit 1", () => {
    const err = new QuotaError();
    assert.strictEqual(err.code, "QUOTA_ERROR");
    assert.strictEqual(err.statusCode, 429);
    assert.strictEqual(err.retryable, false);
    assert.strictEqual(err.exitCode, 1);
    assert.strictEqual(err.name, "QuotaError");
    assert.ok(typeof err.message === "string" && err.message.length > 0);
  });

  it("accepts an explicit message and optional sanitized help", () => {
    const err = new QuotaError(
      "quota exhausted for the active provider",
      "Upgrade your plan or wait until the next reset window",
    );
    assert.strictEqual(err.message, "quota exhausted for the active provider");
    assert.strictEqual(err.help, "Upgrade your plan or wait until the next reset window");
  });

  it("extends ScoutlineError and is recognised by the shared taxonomy", () => {
    const err = new QuotaError();
    assert.ok(err instanceof ScoutlineError);
    assert.ok(err instanceof QuotaError);
    assert.strictEqual(getErrorExitCode(err), 1);
  });

  it("is treated as terminal by isRetryableError", () => {
    const err = new QuotaError();
    assert.strictEqual(isRetryableError(err), false);
  });

  it("surfaces through formatErrorOutput with the documented public envelope", () => {
    const err = new QuotaError("quota exhausted for the active provider");
    const parsed = JSON.parse(formatErrorOutput(err));
    assert.strictEqual(parsed.success, false);
    assert.strictEqual(parsed.code, "QUOTA_ERROR");
    assert.strictEqual(parsed.statusCode, 429);
    assert.strictEqual(parsed.error, "quota exhausted for the active provider");
    // No stack, cause, or other internal fields on the public envelope.
    assert.strictEqual(parsed.stack, undefined);
    assert.strictEqual(parsed.cause, undefined);
  });

  // P6-03A: QuotaError must be reachable through the public
  // `src/lib/index.ts` barrel so programmatic consumers can build
  // and surface quota errors without depending on the inner errors
  // module path. Lock the barrel surface here so a future barrel
  // edit cannot silently drop the export.
  it("is exported through the public lib barrel (`src/lib/index.ts`)", async () => {
    const barrel = await import("../dist/lib/index.js");
    assert.strictEqual(typeof barrel.QuotaError, "function");
    const err = new barrel.QuotaError("barrel test");
    assert.ok(err instanceof QuotaError);
    assert.strictEqual(err.code, "QUOTA_ERROR");
    assert.strictEqual(err.statusCode, 429);
    assert.strictEqual(err.retryable, false);
    assert.strictEqual(err.exitCode, 1);
  });
});

describe("isRetryableError", () => {
  it("returns the `retryable` flag for ScoutlineError", () => {
    const retryable = new ScoutlineError("boom", "API_ERROR", { retryable: true });
    const terminal = new ScoutlineError("boom", "AUTH_ERROR");
    assert.strictEqual(isRetryableError(retryable), true);
    assert.strictEqual(isRetryableError(terminal), false);
  });

  it("returns false for non-ScoutlineError values", () => {
    assert.strictEqual(isRetryableError(new Error("x")), false);
    assert.strictEqual(isRetryableError("x"), false);
    assert.strictEqual(isRetryableError(null), false);
  });
});

describe("getErrorExitCode", () => {
  it("returns 3 for configuration failures and 1 for ordinary failures", () => {
    assert.strictEqual(getErrorExitCode(new ConfigurationError("oops")), 3);
    assert.strictEqual(getErrorExitCode(new ValidationError("bad")), 1);
    assert.strictEqual(getErrorExitCode(new ScoutlineError("x", "API_ERROR")), 1);
  });

  it("returns 1 for unknown / non-error values", () => {
    assert.strictEqual(getErrorExitCode(new Error("x")), 1);
    assert.strictEqual(getErrorExitCode(null), 1);
    assert.strictEqual(getErrorExitCode("oops"), 1);
  });
});

describe("formatErrorOutput (compat)", () => {
  it("formats ZaiError with the documented public shape", () => {
    const err = new ZaiError("Test", "CODE", 400, "Help");
    const parsed = JSON.parse(formatErrorOutput(err));
    assert.strictEqual(parsed.success, false);
    assert.strictEqual(parsed.error, "Test");
    assert.strictEqual(parsed.code, "CODE");
    assert.strictEqual(parsed.help, "Help");
  });

  it("formats generic Error as UNKNOWN_ERROR without a stack", () => {
    const err = new Error("Generic error");
    err.stack = "Error: Generic error\n    at secret:1:1";
    const parsed = JSON.parse(formatErrorOutput(err));
    assert.strictEqual(parsed.success, false);
    assert.strictEqual(parsed.error, "Generic error");
    assert.strictEqual(parsed.code, "UNKNOWN_ERROR");
    assert.strictEqual(parsed.stack, undefined);
  });

  it("formats plain string errors as UNKNOWN_ERROR", () => {
    const parsed = JSON.parse(formatErrorOutput("String error"));
    assert.strictEqual(parsed.success, false);
    assert.strictEqual(parsed.error, "String error");
    assert.strictEqual(parsed.code, "UNKNOWN_ERROR");
  });

  it("omits stack, cause, raw response body, and credentials from the public envelope", () => {
    const err = new ZaiError("leak", "CODE", 500);
    err.stack = "ZaiError: leak\n    at secret:1:1";
    err.cause = { Authorization: "Bearer abc.def.ghi", Z_AI_API_KEY: "xyz" };
    err.responseBody = "Authorization: Bearer abc.def.ghi\nZ_AI_API_KEY=xyz";
    const out = formatErrorOutput(err);
    assert.ok(!out.includes("Bearer abc.def.ghi"));
    assert.ok(!out.includes("Z_AI_API_KEY=xyz"));
    assert.ok(!out.includes("xyz"));
    const parsed = JSON.parse(out);
    assert.strictEqual(parsed.stack, undefined);
    assert.strictEqual(parsed.cause, undefined);
    assert.strictEqual(parsed.responseBody, undefined);
  });
});
