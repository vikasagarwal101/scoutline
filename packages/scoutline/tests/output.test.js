/**
 * Unit tests for output formatting
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import { setOutputMode, getOutputMode, success, error } from "../dist/lib/output.js";

describe("Output Mode", () => {
  beforeEach(() => {
    setOutputMode("data");
  });

  it("should default to data mode", () => {
    assert.strictEqual(getOutputMode(), "data");
  });

  it("should set json mode", () => {
    setOutputMode("json");
    assert.strictEqual(getOutputMode(), "json");
  });

  it("should set pretty mode", () => {
    setOutputMode("pretty");
    assert.strictEqual(getOutputMode(), "pretty");
  });

  it("should set environment variable", () => {
    setOutputMode("json");
    assert.strictEqual(process.env.ZAI_OUTPUT_MODE, "json");
  });
});

describe("Response Builders", () => {
  it("should create success response", () => {
    const response = success({ key: "value" });
    assert.strictEqual(response.success, true);
    assert.deepStrictEqual(response.data, { key: "value" });
    assert.ok(typeof response.timestamp === "number");
    assert.ok(response.timestamp > 0);
  });

  it("should create success response with string data", () => {
    const response = success("Hello");
    assert.strictEqual(response.success, true);
    assert.strictEqual(response.data, "Hello");
  });

  it("should create success response with array data", () => {
    const response = success([1, 2, 3]);
    assert.strictEqual(response.success, true);
    assert.deepStrictEqual(response.data, [1, 2, 3]);
  });

  it("should create error response", () => {
    const response = error("Something went wrong");
    assert.strictEqual(response.success, false);
    assert.strictEqual(response.error, "Something went wrong");
  });

  it("should create error response with code", () => {
    const response = error("Error", "ERR_CODE");
    assert.strictEqual(response.success, false);
    assert.strictEqual(response.error, "Error");
    assert.strictEqual(response.code, "ERR_CODE");
  });

  it("should create error response with code and help", () => {
    const response = error("Error", "ERR_CODE", "Try this instead");
    assert.strictEqual(response.success, false);
    assert.strictEqual(response.error, "Error");
    assert.strictEqual(response.code, "ERR_CODE");
    assert.strictEqual(response.help, "Try this instead");
  });

  it("should not include code if not provided", () => {
    const response = error("Error");
    assert.strictEqual(response.code, undefined);
  });

  it("should not include help if not provided", () => {
    const response = error("Error", "CODE");
    assert.strictEqual(response.help, undefined);
  });
});
