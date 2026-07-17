/**
 * Configuration characterization tests.
 *
 * Tests the precedence and alias behaviour of Z.AI environment variables and
 * the normalized error contract for configuration accessors.
 *
 * P1-09: `loadConfig` and `getApiKey` THROW `ConfigurationError` (exit 3)
 * instead of terminating the process. The missing-key path is now testable
 * in-process without spawning children. The precedence/alias paths still
 * spawn a child that imports dist/lib/config.js so each case runs with an
 * isolated environment.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { runProcess } from "./helpers/run-process.js";
import { loadConfig, getApiKey } from "../dist/lib/config.js";
import { ConfigurationError } from "../dist/lib/errors.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_JS = path.resolve(__dirname, "..", "dist", "lib", "config.js");

/**
 * Spawn a child Node process that imports dist/lib/config.js with the given
 * env. Resolves with { stdout, stderr, code } or rejects after timeoutMs.
 *
 * The child writes a JSON line on success describing the loaded config.
 * (When no key is set loadConfig now throws ConfigurationError inside the
 * child; the missing-key contract is asserted in-process below instead.)
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

  it("missing key causes loadConfig to throw ConfigurationError (in-process, no transport)", () => {
    const savedZai = process.env.Z_AI_API_KEY;
    const savedLegacy = process.env.ZAI_API_KEY;
    delete process.env.Z_AI_API_KEY;
    delete process.env.ZAI_API_KEY;
    try {
      assert.throws(
        () => loadConfig(),
        (err) => {
          assert.ok(err instanceof ConfigurationError, "should be ConfigurationError");
          assert.strictEqual(err.exitCode, 3);
          assert.strictEqual(err.code, "CONFIGURATION_ERROR");
          assert.ok(err.message.includes("Z_AI_API_KEY"));
          return true;
        },
      );
    } finally {
      if (savedZai !== undefined) process.env.Z_AI_API_KEY = savedZai;
      else delete process.env.Z_AI_API_KEY;
      if (savedLegacy !== undefined) process.env.ZAI_API_KEY = savedLegacy;
      else delete process.env.ZAI_API_KEY;
    }
  });
});

describe("configuration accessors throw ConfigurationError", () => {
  function withClearedKey(fn) {
    const savedZai = process.env.Z_AI_API_KEY;
    const savedLegacy = process.env.ZAI_API_KEY;
    delete process.env.Z_AI_API_KEY;
    delete process.env.ZAI_API_KEY;
    try {
      return fn();
    } finally {
      if (savedZai !== undefined) process.env.Z_AI_API_KEY = savedZai;
      else delete process.env.Z_AI_API_KEY;
      if (savedLegacy !== undefined) process.env.ZAI_API_KEY = savedLegacy;
      else delete process.env.ZAI_API_KEY;
    }
  }

  it("loadConfig throws a single structured ConfigurationError with exit 3 and no transport", () => {
    withClearedKey(() => {
      assert.throws(
        () => loadConfig(),
        (err) => {
          assert.ok(err instanceof ConfigurationError);
          assert.strictEqual(err.exitCode, 3);
          assert.strictEqual(err.code, "CONFIGURATION_ERROR");
          // No transport/authorization fields leak onto the thrown error.
          assert.strictEqual(err.statusCode, undefined);
          assert.ok(err.message.includes("Z_AI_API_KEY"));
          return true;
        },
      );
    });
  });

  it("getApiKey throws ConfigurationError with exit 3 and no transport", () => {
    withClearedKey(() => {
      assert.throws(
        () => getApiKey(),
        (err) => {
          assert.ok(err instanceof ConfigurationError);
          assert.strictEqual(err.exitCode, 3);
          assert.strictEqual(err.code, "CONFIGURATION_ERROR");
          return true;
        },
      );
    });
  });

  it("configuration failure is testable in-process without a subprocess hang", () => {
    // The whole point of P1-09: a thrown error reaches the caller instead
    // of process.exit(3). This test would hang under the old contract.
    let threw = false;
    withClearedKey(() => {
      try {
        getApiKey();
      } catch {
        threw = true;
      }
    });
    assert.strictEqual(threw, true);
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
  it("scoutline quota with no key returns one structured error, exit 3, and no transport", async () => {
    const r = await runProcess(["quota"], {
      env: { Z_AI_API_KEY: "", ZAI_API_KEY: "" },
      timeoutMs: 8000,
    });
    assert.strictEqual(r.code, 3);
    // Exactly one structured stderr value (the invocation seam converts the
    // thrown ConfigurationError into a single envelope write).
    const lines = r.stderr.trim().split("\n");
    assert.strictEqual(lines.length, 1, "exactly one stderr line");
    const err = JSON.parse(lines[0]);
    assert.strictEqual(err.success, false);
    assert.strictEqual(err.code, "CONFIGURATION_ERROR");
    assert.ok(err.error.includes("Z_AI_API_KEY"));
    // No transport/authorization leakage in the public envelope.
    assert.strictEqual(err.statusCode, undefined);
    assert.strictEqual(err.authorization, undefined);
  });
});
