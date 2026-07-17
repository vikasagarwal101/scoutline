/**
 * Binary-level command grammar and output contract tests.
 *
 * Characterizes shipped behaviour for help/version, global output options,
 * and missing positional value messages for Vision and repo exploration.
 * P1-03 adds the import-safety subprocess test and in-process main tests.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { runProcess } from "./helpers/run-process.js";
import { main } from "../dist/index.js";

const TEST_KEY = "test-key";
const BASE_ENV = { Z_AI_API_KEY: TEST_KEY };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_INDEX = path.resolve(__dirname, "..", "dist", "index.js");

/**
 * Spawn a node subprocess that imports a module URL and reports
 * whether the import resolved without executing the program.
 */
function spawnImportCheck(modulePath) {
  const url = pathToFileURL(path.resolve(modulePath));
  const script = `import(${JSON.stringify(url.href)})
    .then(() => { process.stderr.write("IMPORT_RESOLVED\\n"); })
    .catch((e) => { process.stderr.write("IMPORT_REJECTED:" + e.message + "\\n"); });`;
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ["--input-type=module", "-e", script], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (c) => (stdout += c));
    proc.stderr.on("data", (c) => (stderr += c));
    proc.on("error", reject);
    proc.on("close", (code) => resolve({ stdout, stderr, code: code ?? 0 }));
  });
}

function pathToFileURL(p) {
  return new URL("file://" + p);
}

describe("import safety: dist/index.js must not execute on import", () => {
  it("importing dist/index.js produces no stdout and resolves normally", async () => {
    const result = await spawnImportCheck(DIST_INDEX);
    assert.strictEqual(
      result.stdout,
      "",
      "importing must not write to stdout — main should not execute",
    );
    assert.ok(
      result.stderr.includes("IMPORT_RESOLVED"),
      "import should resolve without executing the program",
    );
    assert.strictEqual(result.code, 0);
  });
});

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
    assert.strictEqual(err.code, "VALIDATION_ERROR");
  });

  it("-O garbage → JSON error on stderr, exit 1", async () => {
    const r = await runProcess(["-O", "garbage", "doctor"], { env: BASE_ENV });
    assert.strictEqual(r.code, 1);
    const err = JSON.parse(r.stderr);
    assert.strictEqual(err.success, false);
    assert.ok(err.error.includes("Invalid output format"));
    assert.strictEqual(err.code, "VALIDATION_ERROR");
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

/**
 * Build a fake adapter that records stdout/stderr writes for in-process
 * main tests. The adapter does not touch real process streams.
 */
function createTestAdapter(overrides = {}) {
  const stdout = [];
  const stderr = [];
  const adapter = {
    stdoutIsTTY: false,
    stdinIsTTY: false,
    environmentOutputMode: undefined,
    readStdin: async () => "",
    writeStdout: (v) => stdout.push(v),
    writeStderr: (v) => stderr.push(v),
    runQuietly: async (op) => op(),
    setExitCode: () => {},
    ...overrides,
  };
  return { adapter, stdout, stderr };
}

describe("main(args, dependencies) in-process: returns numeric status", () => {
  it("--help returns 0 and writes help to adapter stdout", async () => {
    const { adapter, stdout } = createTestAdapter();
    const status = await main(["--help"], { invocation: adapter, env: {} });
    assert.strictEqual(typeof status, "number");
    assert.strictEqual(status, 0);
    assert.strictEqual(stdout.length, 1);
    assert.ok(stdout[0].includes("Usage:"));
  });

  it("--version returns 0 and writes version to adapter stdout", async () => {
    const { adapter, stdout } = createTestAdapter();
    const status = await main(["--version"], { invocation: adapter, env: {} });
    assert.strictEqual(status, 0);
    assert.strictEqual(stdout.length, 1);
    assert.match(stdout[0].trim(), /^\d+\.\d+\.\d+$/);
  });

  it("unknown command returns 1 and writes VALIDATION_ERROR to adapter stderr", async () => {
    const { adapter, stderr } = createTestAdapter();
    const status = await main(["nonexistent-cmd"], { invocation: adapter, env: {} });
    assert.strictEqual(status, 1);
    assert.strictEqual(stderr.length, 1);
    const err = JSON.parse(stderr[0]);
    assert.strictEqual(err.success, false);
    assert.strictEqual(err.code, "VALIDATION_ERROR");
    assert.ok(err.error.includes("Unknown command"));
  });

  it("invalid output mode returns 1 and writes VALIDATION_ERROR to adapter stderr", async () => {
    const { adapter, stderr } = createTestAdapter();
    const status = await main(["--output-format", "bogus", "doctor"], {
      invocation: adapter,
      env: {},
    });
    assert.strictEqual(status, 1);
    assert.strictEqual(stderr.length, 1);
    const err = JSON.parse(stderr[0]);
    assert.strictEqual(err.code, "VALIDATION_ERROR");
    assert.ok(err.error.includes("Invalid output format"));
  });

  it("no args returns 0 and writes help to adapter stdout", async () => {
    const { adapter, stdout } = createTestAdapter();
    const status = await main([], { invocation: adapter, env: {} });
    assert.strictEqual(status, 0);
    assert.ok(stdout[0].includes("Usage:"));
  });

  it("-h alias returns 0 and writes help to adapter stdout", async () => {
    const { adapter, stdout } = createTestAdapter();
    const status = await main(["-h"], { invocation: adapter, env: {} });
    assert.strictEqual(status, 0);
    assert.ok(stdout[0].includes("scoutline"));
  });

  it("-v alias returns 0 and writes version to adapter stdout", async () => {
    const { adapter, stdout } = createTestAdapter();
    const status = await main(["-v"], { invocation: adapter, env: {} });
    assert.strictEqual(status, 0);
    assert.match(stdout[0].trim(), /^\d+\.\d+\.\d+$/);
  });
});
