/**
 * Binary-level command grammar and output contract tests.
 *
 * Characterizes shipped behaviour for help/version, global output options,
 * and missing positional value messages for Vision and repo exploration.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runProcess } from "./helpers/run-process.js";

const TEST_KEY = "test-key";
const BASE_ENV = { Z_AI_API_KEY: TEST_KEY };

describe("help and version: stdout-only", () => {
  it("no args → stdout-only exit 0", async () => {
    const r = await runProcess([], { env: BASE_ENV });
    assert.strictEqual(r.code, 0);
    assert.strictEqual(r.stderr, "");
    assert.ok(r.stdout.includes("Usage:"));
  });

  it("--help → stdout-only exit 0", async () => {
    const r = await runProcess(["--help"], { env: BASE_ENV });
    assert.strictEqual(r.code, 0);
    assert.strictEqual(r.stderr, "");
    assert.ok(r.stdout.includes("scoutline"));
  });

  it("-h → stdout-only exit 0", async () => {
    const r = await runProcess(["-h"], { env: BASE_ENV });
    assert.strictEqual(r.code, 0);
    assert.strictEqual(r.stderr, "");
    assert.ok(r.stdout.includes("scoutline"));
  });

  it("--version → stdout-only exit 0 with semver", async () => {
    const r = await runProcess(["--version"], { env: BASE_ENV });
    assert.strictEqual(r.code, 0);
    assert.strictEqual(r.stderr, "");
    assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+$/);
  });

  it("-v → stdout-only exit 0 with semver", async () => {
    const r = await runProcess(["-v"], { env: BASE_ENV });
    assert.strictEqual(r.code, 0);
    assert.strictEqual(r.stderr, "");
    assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+$/);
  });
});

describe("global output options: before and after command token", () => {
  it("--output-format json before command token is accepted", async () => {
    const r = await runProcess(["--output-format", "json", "--help"], { env: BASE_ENV });
    assert.strictEqual(r.code, 0);
    assert.strictEqual(r.stderr, "");
    assert.ok(r.stdout.includes("scoutline"));
  });

  it("-O pretty before command token is accepted", async () => {
    const r = await runProcess(["-O", "pretty", "--help"], { env: BASE_ENV });
    assert.strictEqual(r.code, 0);
    assert.strictEqual(r.stderr, "");
    assert.ok(r.stdout.includes("scoutline"));
  });

  it("--output-format after command token (vision --help) is accepted", async () => {
    const r = await runProcess(["vision", "--output-format", "json", "--help"], {
      env: BASE_ENV,
    });
    assert.strictEqual(r.code, 0);
    assert.strictEqual(r.stderr, "");
    assert.ok(r.stdout.includes("analyze"));
  });

  it("data mode is accepted", async () => {
    const r = await runProcess(["--output-format", "data", "--help"], { env: BASE_ENV });
    assert.strictEqual(r.code, 0);
    assert.strictEqual(r.stderr, "");
  });

  it("compact, markdown, refs, tty modes are accepted", async () => {
    for (const mode of ["compact", "markdown", "refs", "tty"]) {
      const r = await runProcess(["--output-format", mode, "--help"], { env: BASE_ENV });
      assert.strictEqual(r.code, 0, `${mode} mode should exit 0`);
      assert.strictEqual(r.stderr, "", `${mode} mode should have empty stderr`);
    }
  });
});

describe("invalid output modes: one JSON error to stderr, exit 1", () => {
  it("--output-format invalid → JSON error on stderr, exit 1", async () => {
    const r = await runProcess(["--output-format", "invalid", "doctor"], { env: BASE_ENV });
    assert.strictEqual(r.code, 1);
    const err = JSON.parse(r.stderr);
    assert.strictEqual(err.success, false);
    assert.ok(err.error.includes("Invalid output format"));
    assert.strictEqual(err.code, "INVALID_ARGS");
  });

  it("-O garbage → JSON error on stderr, exit 1", async () => {
    const r = await runProcess(["-O", "garbage", "doctor"], { env: BASE_ENV });
    assert.strictEqual(r.code, 1);
    const err = JSON.parse(r.stderr);
    assert.strictEqual(err.success, false);
    assert.ok(err.error.includes("Invalid output format"));
  });
});

describe("missing positional values: message, code, stream, exit", () => {
  it("vision analyze with no source → INVALID_ARGS exit 1 on stderr", async () => {
    const r = await runProcess(["vision", "analyze"], { env: BASE_ENV });
    assert.strictEqual(r.code, 1);
    const err = JSON.parse(r.stderr);
    assert.strictEqual(err.success, false);
    assert.strictEqual(err.code, "INVALID_ARGS");
    assert.ok(err.error.includes("Missing image source"));
  });

  it("vision video with no source → INVALID_ARGS exit 1", async () => {
    const r = await runProcess(["vision", "video"], { env: BASE_ENV });
    assert.strictEqual(r.code, 1);
    const err = JSON.parse(r.stderr);
    assert.strictEqual(err.code, "INVALID_ARGS");
    assert.ok(err.error.includes("Missing video source"));
  });

  it("vision diff with only one image → INVALID_ARGS exit 1", async () => {
    const r = await runProcess(["vision", "diff", "a.png"], { env: BASE_ENV });
    assert.strictEqual(r.code, 1);
    const err = JSON.parse(r.stderr);
    assert.strictEqual(err.code, "INVALID_ARGS");
    assert.ok(err.error.includes("Missing image sources"));
  });

  it("repo tree with no repo → INVALID_ARGS exit 1", async () => {
    const r = await runProcess(["repo", "tree"], { env: BASE_ENV });
    assert.strictEqual(r.code, 1);
    const err = JSON.parse(r.stderr);
    assert.strictEqual(err.code, "INVALID_ARGS");
    assert.ok(err.error.includes("Missing repo"));
  });

  it("repo search with no query → INVALID_ARGS exit 1", async () => {
    const r = await runProcess(["repo", "search", "owner/repo"], { env: BASE_ENV });
    assert.strictEqual(r.code, 1);
    const err = JSON.parse(r.stderr);
    assert.strictEqual(err.code, "INVALID_ARGS");
    assert.ok(err.error.includes("Missing repo or query"));
  });

  it("repo read with no path → INVALID_ARGS exit 1", async () => {
    const r = await runProcess(["repo", "read", "owner/repo"], { env: BASE_ENV });
    assert.strictEqual(r.code, 1);
    const err = JSON.parse(r.stderr);
    assert.strictEqual(err.code, "INVALID_ARGS");
    assert.ok(err.error.includes("Missing repo or path"));
  });

  it("code run with no file → INVALID_ARGS exit 1", async () => {
    const r = await runProcess(["code", "run"], { env: BASE_ENV });
    assert.strictEqual(r.code, 1);
    const err = JSON.parse(r.stderr);
    assert.strictEqual(err.code, "INVALID_ARGS");
    assert.ok(err.error.includes("Missing code file"));
  });

  it("code eval with no string → INVALID_ARGS exit 1", async () => {
    const r = await runProcess(["code", "eval"], { env: BASE_ENV });
    assert.strictEqual(r.code, 1);
    const err = JSON.parse(r.stderr);
    assert.strictEqual(err.code, "INVALID_ARGS");
    assert.ok(err.error.includes("Missing code string"));
  });
});
