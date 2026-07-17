/**
 * Unit tests for pure output formatting.
 *
 * P1-01 asserts the new pure output contract: `isOutputMode`,
 * `formatSuccessOutput`, and `formatErrorOutput` are invocation-local and
 * free of mutable global state, environment mutation, and console writes.
 * The legacy mutable `setOutputMode` / `getOutputMode` / `outputSuccess` /
 * `outputError` surface remains for Phase 1 consumers and is removed in
 * P1-10.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  OUTPUT_MODES,
  isOutputMode,
  formatSuccessOutput,
  formatErrorOutput,
  success,
  error,
} from "../dist/lib/output.js";
import { ZaiError } from "../dist/lib/errors.js";

describe("OUTPUT_MODES", () => {
  it("exposes the full canonical output mode list", () => {
    assert.deepStrictEqual([...OUTPUT_MODES], [
      "data",
      "json",
      "pretty",
      "compact",
      "markdown",
      "refs",
      "tty",
    ]);
  });
});

describe("isOutputMode", () => {
  it("recognises every canonical mode", () => {
    for (const mode of OUTPUT_MODES) {
      assert.strictEqual(isOutputMode(mode), true);
    }
  });

  it("rejects unknown strings", () => {
    assert.strictEqual(isOutputMode("xml"), false);
    assert.strictEqual(isOutputMode("JSON"), false);
    assert.strictEqual(isOutputMode(""), false);
  });

  it("rejects non-string values", () => {
    assert.strictEqual(isOutputMode(undefined), false);
    assert.strictEqual(isOutputMode(null), false);
    assert.strictEqual(isOutputMode(7), false);
    assert.strictEqual(isOutputMode({}), false);
  });
});

describe("formatSuccessOutput", () => {
  const FROZEN_NOW = 1_700_000_000_000;

  it("data mode emits raw JSON-encoded data without a success envelope", () => {
    const out = formatSuccessOutput({ count: 2 }, "data", () => FROZEN_NOW);
    assert.strictEqual(out, JSON.stringify({ count: 2 }));
  });

  it("json mode emits the success envelope using the injected `now` value", () => {
    const out = formatSuccessOutput({ count: 2 }, "json", () => FROZEN_NOW);
    const parsed = JSON.parse(out);
    assert.deepStrictEqual(parsed, {
      success: true,
      data: { count: 2 },
      timestamp: FROZEN_NOW,
    });
  });

  it("pretty mode emits an indented success envelope", () => {
    const out = formatSuccessOutput({ count: 2 }, "pretty", () => FROZEN_NOW);
    assert.strictEqual(out.includes("\n"), true);
    const parsed = JSON.parse(out);
    assert.strictEqual(parsed.success, true);
    assert.deepStrictEqual(parsed.data, { count: 2 });
    assert.strictEqual(parsed.timestamp, FROZEN_NOW);
  });

  it("text-oriented modes return the explicitly selected command presentation", () => {
    const data = {
      data: { count: 2 },
      presentations: {
        compact: "compact-form",
        markdown: "markdown-form",
        refs: "refs-form",
        tty: "tty-form",
      },
    };
    assert.strictEqual(formatSuccessOutput(data, "compact"), "compact-form");
    assert.strictEqual(formatSuccessOutput(data, "markdown"), "markdown-form");
    assert.strictEqual(formatSuccessOutput(data, "refs"), "refs-form");
    assert.strictEqual(formatSuccessOutput(data, "tty"), "tty-form");
  });

  it("text-oriented modes fall back to JSON when no presentation override exists", () => {
    const out = formatSuccessOutput({ count: 2 }, "compact");
    assert.strictEqual(out, JSON.stringify({ count: 2 }));
  });

  it("defaults the timestamp source to Date.now when no `now` is injected", () => {
    const before = Date.now();
    const out = formatSuccessOutput({ count: 2 }, "json");
    const after = Date.now();
    const parsed = JSON.parse(out);
    assert.ok(parsed.timestamp >= before);
    assert.ok(parsed.timestamp <= after);
  });

  it("does not mutate ZAI_OUTPUT_MODE across calls", () => {
    const envBefore = process.env.ZAI_OUTPUT_MODE;
    formatSuccessOutput({ a: 1 }, "compact");
    formatSuccessOutput({ b: 2 }, "tty");
    formatSuccessOutput({ c: 3 }, "refs");
    assert.strictEqual(process.env.ZAI_OUTPUT_MODE, envBefore);
  });

  it("does not share state between two calls with different modes", () => {
    const a = formatSuccessOutput({ id: "a" }, "data");
    const b = formatSuccessOutput({ id: "b" }, "json", () => 42);
    const c = formatSuccessOutput({ id: "c" }, "pretty", () => 99);
    assert.strictEqual(a, JSON.stringify({ id: "a" }));
    assert.strictEqual(JSON.parse(b).data.id, "b");
    assert.strictEqual(JSON.parse(b).timestamp, 42);
    assert.strictEqual(JSON.parse(c).data.id, "c");
    assert.strictEqual(JSON.parse(c).timestamp, 99);
    assert.notStrictEqual(a, b);
    assert.notStrictEqual(b, c);
  });

  it("does not write to stdout or stderr", () => {
    const originalLog = console.log;
    const originalError = console.error;
    let logCalls = 0;
    let errorCalls = 0;
    console.log = () => {
      logCalls += 1;
    };
    console.error = () => {
      errorCalls += 1;
    };
    try {
      formatSuccessOutput({ a: 1 }, "json", () => 1);
      formatSuccessOutput({ a: 1 }, "pretty", () => 1);
      formatSuccessOutput({ a: 1 }, "compact");
      formatSuccessOutput({ a: 1 }, "tty");
      formatSuccessOutput({ a: 1 }, "data");
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
    assert.strictEqual(logCalls, 0);
    assert.strictEqual(errorCalls, 0);
  });
});

describe("formatErrorOutput", () => {
  it("data mode emits a compact error envelope", () => {
    const err = new ZaiError("boom", "API_ERROR", 500);
    const out = formatErrorOutput(err, "data");
    const parsed = JSON.parse(out);
    assert.strictEqual(parsed.success, false);
    assert.strictEqual(parsed.error, "boom");
    assert.strictEqual(parsed.code, "API_ERROR");
    assert.strictEqual(parsed.statusCode, 500);
  });

  it("pretty mode emits an indented error envelope", () => {
    const err = new ZaiError("boom", "API_ERROR", 500);
    const out = formatErrorOutput(err, "pretty");
    assert.strictEqual(out.includes("\n"), true);
    const parsed = JSON.parse(out);
    assert.strictEqual(parsed.success, false);
    assert.strictEqual(parsed.error, "boom");
  });

  it("omits stack trace from the public envelope", () => {
    const err = new Error("deep boom");
    err.stack = "Error: deep boom\n    at internal:1:1";
    const out = formatErrorOutput(err, "json");
    const parsed = JSON.parse(out);
    assert.strictEqual(parsed.stack, undefined);
  });

  it("omits cause from the public envelope", () => {
    const err = new Error("outer");
    err.cause = new Error("inner secret");
    const out = formatErrorOutput(err, "json");
    const parsed = JSON.parse(out);
    assert.strictEqual(parsed.cause, undefined);
  });

  it("omits raw response bodies, authorization data, and known credentials", () => {
    const err = {
      message: "Request failed",
      code: "NETWORK_ERROR",
      help: "Check authorization header: Bearer abc.def.ghi",
      responseBody: "Authorization: Bearer abc.def.ghi\nZ_AI_API_KEY=xyz",
      Z_AI_API_KEY: "xyz",
      authorization: "Bearer abc.def.ghi",
    };
    const out = formatErrorOutput(err, "pretty");
    assert.ok(!out.includes("Bearer abc.def.ghi"));
    assert.ok(!out.includes("Z_AI_API_KEY=xyz"));
    assert.ok(!out.includes("xyz"));
  });

  it("does not share state between calls with different modes", () => {
    const err = new ZaiError("boom", "API_ERROR", 500);
    const data = formatErrorOutput(err, "data");
    const pretty = formatErrorOutput(err, "pretty");
    assert.ok(!data.includes("\n"));
    assert.ok(pretty.includes("\n"));
    assert.notStrictEqual(data, pretty);
  });

  it("does not write to stdout or stderr", () => {
    const originalLog = console.log;
    const originalError = console.error;
    let logCalls = 0;
    let errorCalls = 0;
    console.log = () => {
      logCalls += 1;
    };
    console.error = () => {
      errorCalls += 1;
    };
    try {
      formatErrorOutput(new Error("x"), "data");
      formatErrorOutput(new Error("x"), "pretty");
      formatErrorOutput(new Error("x"), "json");
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
    assert.strictEqual(logCalls, 0);
    assert.strictEqual(errorCalls, 0);
  });
});

describe("response builder compatibility exports", () => {
  it("`success` returns the documented SuccessResponse shape (pure compat export)", () => {
    const out = success({ key: "value" });
    assert.strictEqual(out.success, true);
    assert.deepStrictEqual(out.data, { key: "value" });
    assert.ok(typeof out.timestamp === "number");
    assert.ok(out.timestamp > 0);
  });

  it("`error` returns the documented ErrorResponse shape (pure compat export)", () => {
    const out = error("went wrong", "API_ERROR", "fix it");
    assert.strictEqual(out.success, false);
    assert.strictEqual(out.error, "went wrong");
    assert.strictEqual(out.code, "API_ERROR");
    assert.strictEqual(out.help, "fix it");
  });

  it("`error` omits optional fields when not provided", () => {
    const out = error("went wrong");
    assert.strictEqual(out.success, false);
    assert.strictEqual(out.error, "went wrong");
    assert.strictEqual(out.code, undefined);
    assert.strictEqual(out.help, undefined);
  });
});
