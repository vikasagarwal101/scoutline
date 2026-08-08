/**
 * Provider raw-response fixture capture (Angle 8 prerequisite).
 *
 * Calls each provider's raw transport function (`fetch{Provider}{Op}` in
 * `src/providers/{provider}/client.ts`) once per capability with a stable
 * query/URL, and writes the un-normalized JSON response to
 * `tests/fixtures/providers/{provider}/{capability}.json`.
 *
 * These fixtures give Angle 8 (Provider Domain Correctness) agents a
 * ground-truth response shape to diff each adapter's field mapping
 * against — something the existing synthetic fixtures (zai/minimax) do
 * not provide.
 *
 * Credential resolution uses the app's CANONICAL source only: the same
 * `readConfig` from `lib/config-store.js` that `init` writes and the
 * dispatcher reads. Keys come from `providers[id].apiKey` in
 * `~/.scoutline/config.json`. The script does NOT consult `process.env`,
 * shell profiles, or any other source — config.json is the documented
 * canonical path. Re-running after `scoutline init` configures a
 * provider captures it with no code change.
 *
 * Usage:
 *   node scripts/capture-provider-fixtures.mjs          # capture all configured
 *   node scripts/capture-provider-fixtures.mjs --force   # overwrite existing
 *
 * Never writes API keys to disk; keys are request headers only.
 */
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readConfig } from "../dist/lib/config-store.js";
import { fetchTavilySearch, fetchTavilyExtract } from "../dist/providers/tavily/client.js";
import { fetchBraveSearch, fetchBraveNewsSearch } from "../dist/providers/brave/client.js";
import { fetchFirecrawlSearch, fetchFirecrawlMap } from "../dist/providers/firecrawl/client.js";
import { fetchExaSearch, fetchExaContents } from "../dist/providers/exa/client.js";
import { fetchParallelSearch } from "../dist/providers/parallel/client.js";
import { fetchPerplexitySearch } from "../dist/providers/perplexity/client.js";
import { fetchJinaSearch, fetchJinaReader } from "../dist/providers/jina/client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = resolve(__dirname, "..", "tests", "fixtures", "providers");
const force = process.argv.includes("--force");

const QUERY = "rust programming language";
const URL = "https://en.wikipedia.org/wiki/Rust_(programming_language)";

// Load the canonical config (~/.scoutline/config.json) via the app's own
// reader. Returns an empty config when the file is absent; on a corrupt
// file we degrade to no providers rather than crash.
let config;
try {
  config = await readConfig();
} catch {
  config = { providers: {} };
}

/**
 * Resolve a provider key from the canonical config only.
 *
 * @param {{ provider: string }} cap
 * @returns {string | undefined}
 */
function resolveKey(cap) {
  const k = config.providers?.[cap.provider]?.apiKey;
  return typeof k === "string" && k.trim() ? k : undefined;
}

/**
 * @typedef {{ provider: string, capability: string, fetch: (key: string) => Promise<unknown> }} Capture
 */

/** @type {Capture[]} */
const captures = [
  // Tavily
  {
    provider: "tavily",
    capability: "search",
    fetch: (key) => fetchTavilySearch(key, QUERY),
  },
  {
    provider: "tavily",
    capability: "extract",
    fetch: (key) => fetchTavilyExtract(key, URL),
  },
  // Brave
  {
    provider: "brave",
    capability: "search",
    fetch: (key) => fetchBraveSearch(key, QUERY),
  },
  {
    provider: "brave",
    capability: "news",
    fetch: (key) => fetchBraveNewsSearch(key, QUERY),
  },
  // Firecrawl
  {
    provider: "firecrawl",
    capability: "search",
    fetch: (key) => fetchFirecrawlSearch(key, QUERY, undefined),
  },
  {
    provider: "firecrawl",
    capability: "map",
    fetch: (key) => fetchFirecrawlMap(key, URL, undefined),
  },
  // Exa
  {
    provider: "exa",
    capability: "search",
    fetch: (key) => fetchExaSearch(key, QUERY),
  },
  {
    provider: "exa",
    capability: "contents",
    fetch: (key) => fetchExaContents(key, URL),
  },
  // Parallel
  {
    provider: "parallel",
    capability: "search",
    fetch: (key) => fetchParallelSearch(key, QUERY),
  },
  // Perplexity (skips until configured via `scoutline init`)
  {
    provider: "perplexity",
    capability: "search",
    fetch: (key) => fetchPerplexitySearch(key, QUERY),
  },
  // Jina
  {
    provider: "jina",
    capability: "search",
    fetch: (key) => fetchJinaSearch(key, QUERY),
  },
  {
    provider: "jina",
    capability: "reader",
    fetch: (key) => fetchJinaReader(key, URL),
  },
];

const results = [];

for (const cap of captures) {
  const key = resolveKey(cap);
  const outFile = resolve(FIXTURES_DIR, cap.provider, `${cap.capability}.json`);
  const label = `${cap.provider}/${cap.capability}`;

  if (!key) {
    results.push({ label, status: "SKIP", reason: `not in ~/.scoutline/config.json` });
    continue;
  }
  try {
    const raw = await cap.fetch(key);
    await mkdir(dirname(outFile), { recursive: true });
    const json = JSON.stringify(raw, null, 2) + "\n";
    await writeFile(outFile, json, "utf8");
    const bytes = Buffer.byteLength(json, "utf8");
    results.push({ label, status: "OK", bytes });
  } catch (err) {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    results.push({ label, status: "FAIL", reason: msg });
  }
}

// Summary table
const width = Math.max(...results.map((r) => r.label.length));
console.log("\nProvider fixture capture summary");
console.log(`${"CAPTURE".padEnd(width)}  STATUS  DETAIL`);
console.log("-".repeat(width + 16));
for (const r of results) {
  const detail = r.bytes !== undefined ? `${r.bytes} bytes` : (r.reason ?? "");
  console.log(`${r.label.padEnd(width)}  ${r.status.padEnd(6)}  ${detail}`);
}
const ok = results.filter((r) => r.status === "OK").length;
const fail = results.filter((r) => r.status === "FAIL").length;
const skip = results.filter((r) => r.status === "SKIP").length;
console.log("\n%d captured, %d failed, %d skipped (not configured).", ok, fail, skip);
process.exit(fail > 0 ? 1 : 0);
