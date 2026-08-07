/**
 * Node Command Invocation Adapter — unit tests (Story 0.13.9).
 *
 * Verifies two UX-polish guarantees from the adapter:
 *   3.1 — writeStderr is the sole newline authority (no double newlines)
 *   3.4 — runQuietly suppresses console.error
 *
 * These tests exercise the REAL adapter from `dist/`, not a fake. They
 * capture process.stderr / console.error output via temporary overrides
 * so no noise leaks into the test runner.
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

// ---------------------------------------------------------------------------
// 3.4 — runQuietly suppresses console.error
// ---------------------------------------------------------------------------

describe("runQuietly console.error suppression (3.4)", () => {
  it("suppresses console.error during operation", async () => {
    const adapter = createNodeCommandInvocationAdapter();
    let errorWasNoop = false;
    const originalError = console.error;
    await adapter.runQuietly(async () => {
      // If suppression is in place, console.error is a noop (not the original)
      errorWasNoop = console.error === originalError;
    });
    assert.strictEqual(errorWasNoop, false, "console.error must be suppressed during runQuietly");
    assert.strictEqual(console.error, originalError, "console.error must be restored after runQuietly");
  });

  it("integration: dependency console.error noise does not reach stderr", async () => {
    const adapter = createNodeCommandInvocationAdapter();
    const stderrMessages = [];
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk) => {
      stderrMessages.push(chunk.toString());
      return true;
    };
    try {
      await adapter.runQuietly(async () => {
        // Simulate a dependency writing to console.error
        console.error("dependency noise");
        // Now write structured stderr through the adapter
        adapter.writeStderr("structured message\n");
      });
    } finally {
      process.stderr.write = originalStderrWrite;
    }
    const combined = stderrMessages.join("");
    assert.ok(!combined.includes("dependency noise"), "console.error noise must not reach stderr");
    assert.ok(combined.includes("structured message\n"), "structured stderr must still appear");
  });

  it("restores console.error even if operation throws", async () => {
    const adapter = createNodeCommandInvocationAdapter();
    const originalError = console.error;
    await assert.rejects(
      adapter.runQuietly(async () => {
        throw new Error("boom");
      }),
      /boom/,
    );
    assert.strictEqual(console.error, originalError, "console.error must be restored after throw");
  });
});
