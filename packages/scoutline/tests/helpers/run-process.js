/**
 * Test helper: run the scoutline CLI as a subprocess with deterministic
 * environment, captured stdout/stderr, and a numeric exit code.
 *
 * On timeout, the helper aborts and surfaces an Error rather than returning
 * ambiguous output.
 *
 * T3b: the helper isolates the subprocess from the developer's real
 * ~/.scoutline/config.json by pointing SCOUTLINE_CONFIG_DIR at a temp
 * directory. Without this, trigger detection (T3b) would consult the
 * developer's real config and emit the env-only hint non-deterministically
 * (depending on whether the developer has run `scoutline init`). Pass
 * `configDir: false` to disable the isolation (rare; only for tests that
 * intentionally exercise the real config root).
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, "..", "..", "bin", "scoutline.js");

const DEFAULT_TIMEOUT_MS = 15000;

/**
 * Provider credential env vars stripped from the inherited process.env
 * by default so subprocess tests do not leak the developer's real keys
 * into the merged env (which would make trigger detection fire the
 * env-only hint non-deterministically). Tests that need a credential
 * set it explicitly via `options.env`.
 */
const PROVIDER_CREDENTIAL_ENV = [
  "Z_AI_API_KEY",
  "ZAI_API_KEY",
  "MINIMAX_API_KEY",
  "TAVILY_API_KEY",
  "EXA_API_KEY",
  "BRAVE_SEARCH_API_KEY",
  "FIRECRAWL_API_KEY",
];

/**
 * @param {string[]} args - CLI arguments (without the node executable)
 * @param {object} [options]
 * @param {Record<string, string|undefined>} [options.env]
 * @param {number} [options.timeoutMs]
 * @param {string} [options.cwd]
 * @param {false} [options.configDir] - When false, do not isolate
 *   SCOUTLINE_CONFIG_DIR (default: isolate to a temp dir).
 * @param {object} [options.config] - When provided, written as
 *   `config.json` into the temp config dir so the subprocess starts
 *   file-configured (trigger detection classifies as "file-configured"
 *   and does not emit the env-only hint). Use this for tests that need
 *   a credential to pass provider preflight but want clean stderr.
 */
export async function runProcess(args, options = {}) {
  // Start from process.env minus provider credentials so the developer's
  // real keys do not leak into the subprocess. Tests that need a key
  // pass it explicitly via options.env, which is merged on top.
  const baseEnv = { ...process.env };
  for (const key of PROVIDER_CREDENTIAL_ENV) {
    delete baseEnv[key];
  }
  const env = { ...baseEnv, ...(options.env || {}) };
  // Strip undefined entries so spawn does not pass literal "undefined".
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete env[key];
  }

  // T3b: isolate the subprocess from the developer's real config. A
  // fresh temp dir means inspectConfig returns "absent" and trigger
  // detection never sees a stale file-configured state from the host.
  let configDir = options.configDir;
  if (configDir === undefined) {
    configDir = await fs.mkdtemp(path.join(os.tmpdir(), "scoutline-subprocess-"));
  }
  if (configDir !== false) {
    env.SCOUTLINE_CONFIG_DIR = configDir;
    // When a config object is supplied, write it to the temp dir so the
    // subprocess starts file-configured. This avoids the env-only hint
    // while keeping stderr clean for tests that only care about
    // validation behavior past the provider preflight.
    if (options.config && typeof options.config === "object") {
      await fs.writeFile(path.join(configDir, "config.json"), JSON.stringify(options.config));
    }
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [CLI_PATH, ...args], {
      env,
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, timeoutMs);

    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(
          new Error(
            `scoutline process timed out after ${timeoutMs}ms. ` +
              `argv=${JSON.stringify(args)} ` +
              `stdout=${JSON.stringify(stdout.slice(0, 500))} ` +
              `stderr=${JSON.stringify(stderr.slice(0, 500))}`,
          ),
        );
        return;
      }
      resolve({ stdout, stderr, code: code ?? 0 });
    });
  });
}
