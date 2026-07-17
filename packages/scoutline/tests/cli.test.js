/**
 * CLI integration tests for scoutline.
 *
 * All subprocess tests use the shared runProcess helper. The CLI is built
 * before these tests run by `npm run test:offline`.
 *
 * P0-02 adds bin.test.js as the focused command-grammar characterization
 * surface; the tests here retain their broader coverage of help, version,
 * and error handling flows.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runProcess } from "./helpers/run-process.js";

const TEST_KEY = "test-key";

describe("CLI Help Commands", () => {
  // Fixup C — W5: top-level help text must reflect provider-aware
  // behavior — mention --provider, identify shared vs Z.AI-only
  // capabilities, and note that quota/doctor are provider-aware.
  it("main help is provider-aware (Fixup C — W5)", async () => {
    const { stdout, code } = await runProcess(["--help"], {
      env: { Z_AI_API_KEY: TEST_KEY },
    });
    assert.strictEqual(code, 0);
    assert.match(stdout, /--provider/, "mentions --provider");
    assert.match(stdout, /minimax/i, "mentions MiniMax");
    assert.match(stdout, /shared/i, "calls out shared capabilities");
    assert.match(stdout, /Provider-aware/i, "notes quota/doctor are provider-aware");
    // The legacy "Z.AI-only" framing must NOT be the only framing.
    assert.ok(!/Z\.AI MCP services/.test(stdout), "main help must no longer say 'Z.AI MCP services'");
  });

  it("should show vision help", async () => {
    const { stdout, code } = await runProcess(["vision", "--help"], {
      env: { Z_AI_API_KEY: TEST_KEY },
    });
    assert.strictEqual(code, 0);
    assert.ok(stdout.includes("analyze"));
    assert.ok(stdout.includes("ui-to-code"));
    assert.ok(stdout.includes("extract-text"));
    assert.ok(stdout.includes("diagnose-error"));
    assert.ok(stdout.includes("diagram"));
    assert.ok(stdout.includes("chart"));
    assert.ok(stdout.includes("diff"));
    assert.ok(stdout.includes("video"));
  });

  it("should show search help", async () => {
    const { stdout, code } = await runProcess(["search", "--help"], {
      env: { Z_AI_API_KEY: TEST_KEY },
    });
    assert.strictEqual(code, 0);
    assert.ok(stdout.includes("--count"));
    assert.ok(stdout.includes("--domain"));
    assert.ok(stdout.includes("--recency"));
  });

  it("should show read help", async () => {
    const { stdout, code } = await runProcess(["read", "--help"], {
      env: { Z_AI_API_KEY: TEST_KEY },
    });
    assert.strictEqual(code, 0);
    assert.ok(stdout.includes("--format"));
    assert.ok(stdout.includes("markdown"));
    assert.ok(stdout.includes("--with-images-summary"));
    assert.ok(stdout.includes("--no-gfm"));
    assert.ok(stdout.includes("--keep-img-data-url"));
  });

  it("should show repo help", async () => {
    const { stdout, code } = await runProcess(["repo", "--help"], {
      env: { Z_AI_API_KEY: TEST_KEY },
    });
    assert.strictEqual(code, 0);
    assert.ok(stdout.includes("search"));
    assert.ok(stdout.includes("tree"));
    assert.ok(stdout.includes("read"));
    assert.ok(stdout.includes("--language"));
    assert.ok(stdout.includes("--path"));
    assert.ok(stdout.includes("--depth"));
  });

  it("should show code help", async () => {
    const { stdout, code } = await runProcess(["code", "--help"], {
      env: { Z_AI_API_KEY: TEST_KEY },
    });
    assert.strictEqual(code, 0);
    assert.ok(stdout.includes("run"));
    assert.ok(stdout.includes("eval"));
  });

  it("should show doctor help", async () => {
    const { stdout, code } = await runProcess(["doctor", "--help"], {
      env: { Z_AI_API_KEY: TEST_KEY },
    });
    assert.strictEqual(code, 0);
    assert.ok(stdout.includes("doctor"));
  });
});

describe("CLI Error Handling", () => {
  it("should error on unknown command", async () => {
    const { stderr, code } = await runProcess(["unknown"], {
      env: { Z_AI_API_KEY: TEST_KEY },
    });
    assert.strictEqual(code, 1);
    const error = JSON.parse(stderr);
    assert.strictEqual(error.success, false);
    assert.ok(error.error.includes("Unknown command"));
  });

  it("should error on unknown vision command", async () => {
    const { stderr, code } = await runProcess(["vision", "unknown", "file.png"], {
      env: { Z_AI_API_KEY: TEST_KEY },
    });
    assert.strictEqual(code, 1);
    const error = JSON.parse(stderr);
    assert.strictEqual(error.success, false);
    assert.ok(error.error.includes("Unknown vision command"));
  });

});
