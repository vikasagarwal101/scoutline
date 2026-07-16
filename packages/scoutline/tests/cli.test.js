/**
 * CLI integration tests for scoutline.
 *
 * All subprocess tests use the shared runProcess helper. The CLI is built
 * before these tests run by `npm run test:offline`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runProcess } from "./helpers/run-process.js";

const TEST_KEY = "test-key";

describe("CLI Help Commands", () => {
  it("should show main help with --help", async () => {
    const { stdout, code } = await runProcess(["--help"], {
      env: { Z_AI_API_KEY: TEST_KEY },
    });
    assert.strictEqual(code, 0);
    assert.ok(stdout.includes("scoutline"));
    assert.ok(stdout.includes("vision"));
    assert.ok(stdout.includes("search"));
    assert.ok(stdout.includes("read"));
    assert.ok(stdout.includes("repo"));
    assert.ok(stdout.includes("tools"));
    assert.ok(stdout.includes("doctor"));
  });

  it("should show main help with -h", async () => {
    const { stdout, code } = await runProcess(["-h"], {
      env: { Z_AI_API_KEY: TEST_KEY },
    });
    assert.strictEqual(code, 0);
    assert.ok(stdout.includes("scoutline"));
  });

  it("should show main help with no arguments", async () => {
    const { stdout, code } = await runProcess([], {
      env: { Z_AI_API_KEY: TEST_KEY },
    });
    assert.strictEqual(code, 0);
    assert.ok(stdout.includes("Usage:"));
  });

  it("should show version with --version", async () => {
    const { stdout, code } = await runProcess(["--version"], {
      env: { Z_AI_API_KEY: TEST_KEY },
    });
    assert.strictEqual(code, 0);
    assert.match(stdout.trim(), /^\d+\.\d+\.\d+$/);
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

  it("should error on vision without source", async () => {
    const { stderr, code } = await runProcess(["vision", "analyze"], {
      env: { Z_AI_API_KEY: TEST_KEY },
    });
    assert.strictEqual(code, 1);
    const error = JSON.parse(stderr);
    assert.strictEqual(error.success, false);
    assert.ok(error.error.includes("Missing"));
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

  it("should error on repo without repo name", async () => {
    const { stderr, code } = await runProcess(["repo", "tree"], {
      env: { Z_AI_API_KEY: TEST_KEY },
    });
    assert.strictEqual(code, 1);
    const error = JSON.parse(stderr);
    assert.strictEqual(error.success, false);
    assert.ok(error.error.includes("Missing"));
  });
});

describe("CLI Output Format", () => {
  it("should support --output-format json", async () => {
    const { stdout, code } = await runProcess(
      ["--output-format", "json", "--help"],
      { env: { Z_AI_API_KEY: TEST_KEY } },
    );
    assert.strictEqual(code, 0);
    assert.ok(stdout.includes("scoutline"));
  });

  it("should support --output-format pretty", async () => {
    const { stdout, code } = await runProcess(
      ["--output-format", "pretty", "--help"],
      { env: { Z_AI_API_KEY: TEST_KEY } },
    );
    assert.strictEqual(code, 0);
    assert.ok(stdout.includes("scoutline"));
  });

  it("should reject invalid output format", async () => {
    const { stderr, code } = await runProcess(
      ["--output-format", "invalid", "doctor"],
      { env: { Z_AI_API_KEY: TEST_KEY } },
    );
    assert.strictEqual(code, 1);
    const error = JSON.parse(stderr);
    assert.strictEqual(error.success, false);
    assert.ok(error.error.includes("Invalid output format"));
  });
});
