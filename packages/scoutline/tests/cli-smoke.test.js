/**
 * Executable smoke tests.
 *
 * Only spawns the compiled CLI binary to confirm it loads and exposes its
 * top-level help/version surface. P1-03 extends this file with load and
 * validation failures.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runProcess } from "./helpers/run-process.js";

const BASE_ENV = { Z_AI_API_KEY: "smoke-test-key" };

describe("scoutline executable smoke", () => {
  it("--help writes stdout only and exits 0", async () => {
    const result = await runProcess(["--help"], { env: BASE_ENV });
    assert.strictEqual(result.code, 0);
    assert.strictEqual(result.stderr, "");
    assert.ok(result.stdout.includes("scoutline"));
  });

  it("-h writes stdout only and exits 0", async () => {
    const result = await runProcess(["-h"], { env: BASE_ENV });
    assert.strictEqual(result.code, 0);
    assert.strictEqual(result.stderr, "");
    assert.ok(result.stdout.includes("scoutline"));
  });

  it("no args writes main help to stdout only and exits 0", async () => {
    const result = await runProcess([], { env: BASE_ENV });
    assert.strictEqual(result.code, 0);
    assert.strictEqual(result.stderr, "");
    assert.ok(result.stdout.includes("Usage:"));
  });

  it("--version prints a semver to stdout only and exits 0", async () => {
    const result = await runProcess(["--version"], { env: BASE_ENV });
    assert.strictEqual(result.code, 0);
    assert.strictEqual(result.stderr, "");
    assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+$/);
  });

  it("-v prints a semver to stdout only and exits 0", async () => {
    const result = await runProcess(["-v"], { env: BASE_ENV });
    assert.strictEqual(result.code, 0);
    assert.strictEqual(result.stderr, "");
    assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+$/);
  });
});
