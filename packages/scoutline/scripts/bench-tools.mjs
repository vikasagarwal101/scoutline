import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const binPath = path.join(__dirname, "..", "bin", "scoutline.js");

const runs = parseInt(process.env.ZAI_BENCH_RUNS || "5", 10);
const args = ["tools", "--no-vision"];

function runOnce(envOverrides = {}) {
  const env = { ...process.env, ...envOverrides };
  const start = performance.now();
  const result = spawnSync("node", [binPath, ...args], {
    env,
    encoding: "utf8",
  });
  const durationMs = performance.now() - start;
  if (result.status !== 0) {
    throw new Error(`Command failed: ${result.stderr || result.stdout}`);
  }
  return durationMs;
}

function runSeries(label, envOverrides = {}, warmup = true) {
  if (warmup) {
    runOnce(envOverrides);
  }
  const samples = [];
  for (let i = 0; i < runs; i += 1) {
    samples.push(runOnce(envOverrides));
  }
  const avg = samples.reduce((sum, v) => sum + v, 0) / samples.length;
  return { label, samples, avg };
}

if (!process.env.Z_AI_API_KEY && !process.env.ZAI_API_KEY) {
  throw new Error("Z_AI_API_KEY is required to run benchmarks.");
}

// M3: ZAI_MCP_TOOL_CACHE is the legacy alias kept load-bearing for this
// benchmark by cache.ts's isCacheEnabled() alias chain
// (SCOUTLINE_CACHE > ZAI_CACHE > ZAI_MCP_TOOL_CACHE). Each runSeries
// spawns a fresh Node process, so the call-time env read picks the
// value up correctly. Switching to SCOUTLINE_CACHE here would change
// semantics (it would also toggle the response cache) and is out of
// scope for this benchmark.
const disabled = runSeries("cache-disabled", { ZAI_MCP_TOOL_CACHE: "0" }, false);
const enabled = runSeries("cache-enabled", { ZAI_MCP_TOOL_CACHE: "1" }, true);

const result = {
  runs,
  command: `node ${binPath} ${args.join(" ")}`,
  results: [disabled, enabled],
};

console.log(JSON.stringify(result, null, 2));
