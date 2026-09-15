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
 *
 * #154: subprocess children cannot inherit the test process's perimeter
 * guards, so buildIsolatedEnv also default-injects fresh per-call
 * SCOUTLINE_CACHE_DIR and SCOUTLINE_ARTIFACTS_DIR temp dirs (caller- or
 * ambient-supplied values win). This is the child's ONLY isolation.
 *
 * #167: the per-call dirs this helper mkdtemp'd are removed once the
 * child closes (resolve and reject paths alike); caller-supplied values
 * are never touched. The resolved object carries `createdTempDirs` —
 * the dirs THIS call created — for pins.
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
 * Ambient store roots (PR #160 review): an inherited SCOUTLINE_CACHE_DIR /
 * SCOUTLINE_ARTIFACTS_DIR would direct the spawned child's cache/artifact
 * writes at a persistent host store (including ~/.scoutline). Deleted from
 * the cloned ambient env BEFORE the options.env merge — explicit
 * options.env values still win, and the per-call temp defaults below fill
 * the now-undefined keys.
 */
const AMBIENT_STORE_ROOT_ENV = ["SCOUTLINE_CACHE_DIR", "SCOUTLINE_ARTIFACTS_DIR"];

/**
 * Dirs THIS call mkdtemp'd (config/cache/artifacts defaults only —
 * never caller-supplied values). Attached to the returned env under a
 * Symbol: spawn ignores symbol keys, and the env object's visible
 * shape stays unchanged for direct pinning.
 */
const CREATED_TEMP_DIRS = Symbol("scoutline.runProcess.createdTempDirs");

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
/**
 * Build the final child env for a runProcess call: process.env minus
 * provider credentials, options.env merged on top, then the isolation
 * defaults (#154). Caller-supplied SCOUTLINE_CONFIG_DIR /
 * SCOUTLINE_CACHE_DIR / SCOUTLINE_ARTIFACTS_DIR always win — the temp-dir
 * injections are defaults only. Exported for direct pinning.
 */
export async function buildIsolatedEnv(options = {}) {
  const baseEnv = { ...process.env };
  for (const key of PROVIDER_CREDENTIAL_ENV) {
    delete baseEnv[key];
  }
  for (const key of AMBIENT_STORE_ROOT_ENV) {
    delete baseEnv[key];
  }
  const env = { ...baseEnv, ...(options.env || {}) };
  // Strip undefined entries so spawn does not pass literal "undefined".
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete env[key];
  }

  const createdTempDirs = [];
  // T3b: isolate the subprocess from the developer's real config. A
  // fresh temp dir means inspectConfig returns "absent" and trigger
  // detection never sees a stale file-configured state from the host.
  let configDir = options.configDir;
  if (configDir === undefined) {
    configDir = await fs.mkdtemp(path.join(os.tmpdir(), "scoutline-subprocess-"));
    createdTempDirs.push(configDir);
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

  // #154: subprocess children cannot inherit the test process's
  // perimeter guards. Default-inject fresh per-call cache + artifacts
  // temp dirs unless the merged env already carries a value (explicit
  // options.env or an ambient process.env var — both win).
  if (env.SCOUTLINE_CACHE_DIR === undefined) {
    env.SCOUTLINE_CACHE_DIR = await fs.mkdtemp(
      path.join(os.tmpdir(), "scoutline-subprocess-cache-"),
    );
    createdTempDirs.push(env.SCOUTLINE_CACHE_DIR);
  }
  if (env.SCOUTLINE_ARTIFACTS_DIR === undefined) {
    env.SCOUTLINE_ARTIFACTS_DIR = await fs.mkdtemp(
      path.join(os.tmpdir(), "scoutline-subprocess-artifacts-"),
    );
    createdTempDirs.push(env.SCOUTLINE_ARTIFACTS_DIR);
  }
  env[CREATED_TEMP_DIRS] = createdTempDirs;
  return env;
}

export async function runProcess(args, options = {}) {
  const env = await buildIsolatedEnv(options);

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

    proc.on("close", async (code) => {
      clearTimeout(timer);
      // #167 per-call cleanup: remove ONLY the dirs this call mkdtemp'd.
      // allSettled keeps an rm failure from failing a green subprocess
      // run (best-effort); awaiting it keeps pins deterministic.
      const created = env[CREATED_TEMP_DIRS] ?? [];
      await Promise.allSettled(
        created.map((dir) => fs.rm(dir, { recursive: true, force: true })),
      );
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
      resolve({ stdout, stderr, code: code ?? 0, createdTempDirs: created });
    });
  });
}
