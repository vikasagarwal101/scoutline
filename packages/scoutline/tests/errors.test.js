/**
 * Unit tests for error types
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import {
  ZaiError,
  AuthError,
  ValidationError,
  ApiError,
  NetworkError,
  TimeoutError,
  FileError,
  formatErrorOutput,
} from "../dist/lib/errors.js";

describe("Error Classes", () => {
  it("should create ZaiError with all properties", () => {
    const err = new ZaiError("Test error", "TEST_CODE", 500, "Help text");
    assert.strictEqual(err.message, "Test error");
    assert.strictEqual(err.code, "TEST_CODE");
    assert.strictEqual(err.statusCode, 500);
    assert.strictEqual(err.help, "Help text");
    assert.strictEqual(err.name, "ZaiError");
  });

  it("should create AuthError with correct defaults", () => {
    const err = new AuthError("Invalid key");
    assert.strictEqual(err.message, "Invalid key");
    assert.strictEqual(err.code, "AUTH_ERROR");
    assert.strictEqual(err.statusCode, 401);
    assert.ok(err.help.includes("Z_AI_API_KEY"));
  });

  it("should create ValidationError with correct defaults", () => {
    const err = new ValidationError("Bad input");
    assert.strictEqual(err.message, "Bad input");
    assert.strictEqual(err.code, "VALIDATION_ERROR");
    assert.strictEqual(err.statusCode, 400);
  });

  it("should create ApiError with status code", () => {
    const err = new ApiError("Server error", 503);
    assert.strictEqual(err.message, "Server error");
    assert.strictEqual(err.code, "API_ERROR");
    assert.strictEqual(err.statusCode, 503);
  });

  it("should create NetworkError with help text", () => {
    const err = new NetworkError("Connection failed");
    assert.strictEqual(err.message, "Connection failed");
    assert.strictEqual(err.code, "NETWORK_ERROR");
    assert.ok(err.help.includes("internet"));
  });

  it("should create TimeoutError with duration", () => {
    const err = new TimeoutError(30000);
    assert.ok(err.message.includes("30000"));
    assert.strictEqual(err.code, "TIMEOUT_ERROR");
    assert.ok(err.help.includes("Z_AI_TIMEOUT"));
  });

  it("should create FileError with optional help", () => {
    const err = new FileError("File not found", "Check the path");
    assert.strictEqual(err.message, "File not found");
    assert.strictEqual(err.code, "FILE_ERROR");
    assert.strictEqual(err.help, "Check the path");
  });
});

describe("formatErrorOutput", () => {
  it("should format ZaiError correctly", () => {
    const err = new ZaiError("Test", "CODE", 400, "Help");
    const output = JSON.parse(formatErrorOutput(err));
    assert.strictEqual(output.success, false);
    assert.strictEqual(output.error, "Test");
    assert.strictEqual(output.code, "CODE");
    assert.strictEqual(output.help, "Help");
  });

  it("should format generic Error", () => {
    const err = new Error("Generic error");
    const output = JSON.parse(formatErrorOutput(err));
    assert.strictEqual(output.success, false);
    assert.strictEqual(output.error, "Generic error");
    assert.strictEqual(output.code, "UNKNOWN_ERROR");
  });

  it("should format string error", () => {
    const output = JSON.parse(formatErrorOutput("String error"));
    assert.strictEqual(output.success, false);
    assert.strictEqual(output.error, "String error");
    assert.strictEqual(output.code, "UNKNOWN_ERROR");
  });
});
