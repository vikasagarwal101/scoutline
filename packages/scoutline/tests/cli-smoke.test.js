/**
 * Executable smoke tests.
 *
 * Only spawns the compiled CLI binary to confirm it loads and exposes its
 * top-level help/version surface. P1-03 extends this file with load and
 * validation failures.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { runProcess } from "./helpers/run-process.js";

const BASE_ENV = { Z_AI_API_KEY: "smoke-test-key" };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, "..", "bin", "scoutline.js");

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

  it("invalid output mode produces structured VALIDATION_ERROR on stderr and exits 1", async () => {
    const result = await runProcess(["--output-format", "invalid", "doctor"], {
      env: BASE_ENV,
    });
    assert.strictEqual(result.code, 1);
    const err = JSON.parse(result.stderr);
    assert.strictEqual(err.success, false);
    assert.strictEqual(err.code, "VALIDATION_ERROR");
    assert.ok(err.error.includes("Invalid output format"));
  });

  it("load failure (missing dist) produces structured LOAD_ERROR on stderr and exits 1", async () => {
    // Copy the bin to a temp dir where ../dist/index.js does not exist,
    // so the dynamic import fails and the catch handler fires.
    const tmpDir = path.join("/tmp", `scoutline-load-test-${process.pid}`);
    mkdirSync(tmpDir, { recursive: true });
    const tmpBin = path.join(tmpDir, "scoutline.js");
    copyFileSync(CLI_PATH, tmpBin);
    try {
      const result = await new Promise((resolve, reject) => {
        const proc = spawn(process.execPath, [tmpBin, "--help"], {
          env: { ...process.env, ...BASE_ENV },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        proc.stdout.on("data", (c) => (stdout += c));
        proc.stderr.on("data", (c) => (stderr += c));
        proc.on("close", (code) => resolve({ stdout, stderr, code: code ?? 0 }));
        proc.on("error", reject);
      });
      assert.strictEqual(result.code, 1);
      const err = JSON.parse(result.stderr);
      assert.strictEqual(err.success, false);
      assert.strictEqual(err.code, "LOAD_ERROR");
      assert.ok(err.error.length > 0);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("load failure redaction strips credential-shaped substrings from the message", async () => {
    // Reuse the same isolated-binary trick: copy bin/scoutline.js into a
    // tmp dir without dist, then run with credential-bearing env vars.
    // The dynamic import failure must surface a structured LOAD_ERROR
    // envelope whose `error` field is free of the credential material.
    const tmpDir = path.join("/tmp", `scoutline-load-redact-${process.pid}`);
    mkdirSync(tmpDir, { recursive: true });
    const tmpBin = path.join(tmpDir, "scoutline.js");
    copyFileSync(CLI_PATH, tmpBin);
    const secret = "smoke-load-secret-XYZ";
    const secretAlias = "smoke-load-secret-alias-UVW";
    const secretM = "smoke-load-secret-minimax-AAA";
    try {
      const result = await new Promise((resolve, reject) => {
        const proc = spawn(process.execPath, [tmpBin, "--help"], {
          env: {
            ...process.env,
            Z_AI_API_KEY: secret,
            ZAI_API_KEY: secretAlias,
            MINIMAX_API_KEY: secretM,
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        proc.stdout.on("data", (c) => (stdout += c));
        proc.stderr.on("data", (c) => (stderr += c));
        proc.on("close", (code) => resolve({ stdout, stderr, code: code ?? 0 }));
        proc.on("error", reject);
      });
      assert.strictEqual(result.code, 1);
      const stderr = result.stderr;
      const err = JSON.parse(stderr);
      assert.strictEqual(err.success, false);
      assert.strictEqual(err.code, "LOAD_ERROR");
      assert.ok(!stderr.includes(secret), `stderr leaked Z_AI_API_KEY: ${stderr}`);
      assert.ok(!stderr.includes(secretAlias), `stderr leaked ZAI_API_KEY: ${stderr}`);
      assert.ok(!stderr.includes(secretM), `stderr leaked MINIMAX_API_KEY: ${stderr}`);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
