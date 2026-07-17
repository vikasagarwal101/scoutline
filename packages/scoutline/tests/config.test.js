/**
 * Configuration characterization tests.
 *
 * Tests the precedence and alias behaviour of Z.AI environment variables.
 * Process-level config (loadConfig, getApiKey) terminates the process when the
 * key is missing — those cases are exercised by spawning a tiny Node child
 * script that imports dist/lib/config.js.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { runProcess } from "./helpers/run-process.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_JS = path.resolve(__dirname, "..", "dist", "lib", "config.js");

/**
 * Spawn a child Node process that imports dist/lib/config.js with the given
 * env. Resolves with { stdout, stderr, code } or rejects after timeoutMs.
 *
 * The child writes a JSON line on success describing the loaded config;
 * loadConfig terminates the process with exit 3 when no key is set.
 */
function runConfig(env, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const loader = `
      import(${JSON.stringify(CONFIG_JS)}).then((m) => {
        const c = m.loadConfig();
        console.log(JSON.stringify({
          apiKey: c.apiKey,
          mode: c.mode,
          baseUrl: c.baseUrl,
          timeout: c.timeout,
        }));
      });
    `;
    const proc = spawn(process.execPath, ["--input-type=module", "-e", loader], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`config child timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    proc.stdout.on("data", (c) => (stdout += c.toString()));
    proc.stderr.on("data", (c) => (stderr += c.toString()));
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? 0 });
    });
  });
}

describe("Z_AI_API_KEY precedence and aliases", () => {
  it("Z_AI_API_KEY is preferred over ZAI_API_KEY", async () => {
    const r = await runConfig({
      Z_AI_API_KEY: "primary-key",
      ZAI_API_KEY: "legacy-key",
    });
    assert.strictEqual(r.code, 0);
    const out = JSON.parse(r.stdout.trim().split("\n").pop());
    assert.strictEqual(out.apiKey, "primary-key");
  });

  it("ZAI_API_KEY is accepted when Z_AI_API_KEY is unset", async () => {
    const r = await runConfig({
      Z_AI_API_KEY: "",
      ZAI_API_KEY: "legacy-key",
    });
    assert.strictEqual(r.code, 0);
    const out = JSON.parse(r.stdout.trim().split("\n").pop());
    assert.strictEqual(out.apiKey, "legacy-key");
  });

  it("missing key causes exit 3 without hanging", async () => {
    const r = await runConfig({
      Z_AI_API_KEY: "",
      ZAI_API_KEY: "",
    });
    assert.strictEqual(r.code, 3);
    const err = JSON.parse(r.stderr);
    assert.strictEqual(err.success, false);
    assert.ok(err.error.includes("Z_AI_API_KEY"));
  });
});

describe("mode and base URL precedence", () => {
  it("Z_AI_MODE overrides PLATFORM_MODE", async () => {
    const r = await runConfig({
      Z_AI_API_KEY: "k",
      Z_AI_MODE: "ZHIPU",
      PLATFORM_MODE: "ZAI",
    });
    assert.strictEqual(r.code, 0);
    const out = JSON.parse(r.stdout.trim().split("\n").pop());
    assert.strictEqual(out.mode, "ZHIPU");
    assert.strictEqual(out.baseUrl, "https://open.bigmodel.cn/api/paas/v4");
  });

  it("PLATFORM_MODE is accepted when Z_AI_MODE is unset", async () => {
    const r = await runConfig({
      Z_AI_API_KEY: "k",
      PLATFORM_MODE: "ZHIPU",
    });
    assert.strictEqual(r.code, 0);
    const out = JSON.parse(r.stdout.trim().split("\n").pop());
    assert.strictEqual(out.mode, "ZHIPU");
  });

  it("default mode is ZAI with Z.AI base URL", async () => {
    const r = await runConfig({ Z_AI_API_KEY: "k" });
    assert.strictEqual(r.code, 0);
    const out = JSON.parse(r.stdout.trim().split("\n").pop());
    assert.strictEqual(out.mode, "ZAI");
    assert.strictEqual(out.baseUrl, "https://api.z.ai/api/coding/paas/v4");
  });

  it("Z_AI_BASE_URL overrides default URL for the resolved mode", async () => {
    const r = await runConfig({
      Z_AI_API_KEY: "k",
      Z_AI_BASE_URL: "https://example.test/api/v4/",
    });
    assert.strictEqual(r.code, 0);
    const out = JSON.parse(r.stdout.trim().split("\n").pop());
    assert.strictEqual(out.baseUrl, "https://example.test/api/v4/");
  });
});

describe("timeout precedence and default", () => {
  it("Z_AI_TIMEOUT overrides default", async () => {
    const r = await runConfig({
      Z_AI_API_KEY: "k",
      Z_AI_TIMEOUT: "12345",
    });
    assert.strictEqual(r.code, 0);
    const out = JSON.parse(r.stdout.trim().split("\n").pop());
    assert.strictEqual(out.timeout, 12345);
  });

  it("default timeout is 30000", async () => {
    const r = await runConfig({ Z_AI_API_KEY: "k" });
    assert.strictEqual(r.code, 0);
    const out = JSON.parse(r.stdout.trim().split("\n").pop());
    assert.strictEqual(out.timeout, 30000);
  });
});

describe("missing credential through the CLI", () => {
  it("scoutline quota with no key exits 3 with no hang", async () => {
    const r = await runProcess(["quota"], {
      env: { Z_AI_API_KEY: "", ZAI_API_KEY: "" },
      timeoutMs: 8000,
    });
    assert.strictEqual(r.code, 3);
    const err = JSON.parse(r.stderr);
    assert.strictEqual(err.success, false);
    assert.ok(err.error.includes("Z_AI_API_KEY"));
  });
});
