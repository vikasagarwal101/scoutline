/**
 * Node Command Invocation Adapter — unit tests (Story 0.13.9).
 *
 * Verifies the adapter's stderr newline ownership guarantee (3.1).
 * These tests exercise the REAL adapter from `dist/`, not a fake. They
 * capture process.stderr output via temporary overrides so no noise
 * leaks into the test runner.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createNodeCommandInvocationAdapter } from "../dist/node-command-invocation-adapter.js";

// ---------------------------------------------------------------------------
// 3.1 — writeStderr newline normalisation
// ---------------------------------------------------------------------------

describe("writeStderr newline normalisation (3.1)", () => {
  /**
   * Helper: call adapter.writeStderr and return exactly what reaches
   * process.stderr.write as a single string.
   */
  function captureStderr(value) {
    const adapter = createNodeCommandInvocationAdapter();
    let captured = "";
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk) => {
      captured += chunk.toString();
      return true;
    };
    try {
      adapter.writeStderr(value);
    } finally {
      process.stderr.write = original;
    }
    return captured;
  }

  it("appends a single newline when the caller omits one", () => {
    const out = captureStderr("no trailing newline");
    assert.strictEqual(out, "no trailing newline\n");
  });

  it("strips the caller's trailing newline so output has exactly one", () => {
    const out = captureStderr("already has newline\n");
    assert.strictEqual(out, "already has newline\n");
  });

  it("does not produce blank lines from double newlines", () => {
    const out = captureStderr("message\n");
    assert.ok(!out.includes("\n\n"), "stderr must not contain double newlines");
  });

  it("snapshot: multiple calls produce clean single-newline output", () => {
    const adapter = createNodeCommandInvocationAdapter();
    const lines = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk) => {
      lines.push(chunk.toString());
      return true;
    };
    try {
      adapter.writeStderr("first line\n");
      adapter.writeStderr("second line");
      adapter.writeStderr("third line\n");
    } finally {
      process.stderr.write = original;
    }
    const combined = lines.join("");
    assert.strictEqual(
      combined,
      "first line\nsecond line\nthird line\n",
      "combined stderr output must be single-newline separated",
    );
  });
});
