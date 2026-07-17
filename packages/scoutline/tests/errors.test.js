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
  it("AuthError still ships an AUTH_ERROR code with status 401", () => {
    const err = new AuthError("Invalid key");
    assert.strictEqual(err.code, "AUTH_ERROR");
    assert.strictEqual(err.statusCode, 401);
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

  it("TimeoutError encodes the timeout duration", () => {
    const err = new TimeoutError(30000);
    assert.ok(err.message.includes("30000"));
    assert.strictEqual(err.code, "TIMEOUT_ERROR");
    assert.ok(err.help?.includes("Z_AI_TIMEOUT"));
  });

  it("FileError accepts an optional help hint", () => {
    const err = new FileError("File not found", "Check the path");
    assert.strictEqual(err.code, "FILE_ERROR");
    assert.strictEqual(err.help, "Check the path");
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
