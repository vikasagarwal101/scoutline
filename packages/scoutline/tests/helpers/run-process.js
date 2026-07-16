/**
 * Test helper: run the scoutline CLI as a subprocess with deterministic
 * environment, captured stdout/stderr, and a numeric exit code.
 *
 * On timeout, the helper aborts and surfaces an Error rather than returning
 * ambiguous output.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, "..", "..", "bin", "scoutline.js");

const DEFAULT_TIMEOUT_MS = 15000;

/**
 * @param {string[]} args - CLI arguments (without the node executable)
 * @param {object} [options]
 * @param {Record<string, string|undefined>} [options.env]
 * @param {number} [options.timeoutMs]
 * @param {string} [options.cwd]
 */
export function runProcess(args, options = {}) {
  const env = { ...process.env, ...(options.env || {}) };
  // Strip undefined entries so spawn does not pass literal "undefined".
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete env[key];
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
