#!/usr/bin/env node
/**
 * T6d sizing probe (PRD AC12, evidence not product): append + recall
 * latency on synthetic production-shaped journal logs at 10k / 50k /
 * 100k entries. No behavior change ships — this script is the
 * deliverable, run it explicitly:
 *
 *   node scripts/bench-journal.mjs [--entries 10000,50000,100000] [--runs 5]
 *
 * It imports the COMPILED journal + artifacts surfaces (build first)
 * and works on an isolated mkdtemp SCOUTLINE_ARTIFACTS_DIR, deleted
 * after. Never part of the test gates: a 100k-entry log is tens of MB
 * rewritten PER APPEND — probe work, not CI work.
 *
 * Measured at each scale:
 *   - append full entry: appendJournalEntry — the full read-modify-write
 *     of index.json under the write lock (the PRD AC12 scale risk: the
 *     log IS index.json, every append rewrites the whole file).
 *   - append repeat marker: the same seam with the ~150B T2b shape.
 *   - recall: readLog + buildJournalRecall, both hot (parsed entries
 *     reused) and cold (read included) — T5 end to end.
 *   - hit-path double-read: buildJournalCacheKeyMap + append — the T2b
 *     review F3 note (journaling a cache HIT reads the log an extra
 *     time before the append's own read).
 *
 * Logs are constructed by ONE direct atomic write, not N appends:
 * the append seam is O(size), so N appends is O(N²) — hours at 100k.
 * The quadratic total rebuild cost is stated arithmetically in the
 * threshold note instead (N × median-append / 2). Per-entry shapes,
 * ordering, and on-disk format are identical either way, so the
 * read-side and append numbers are unaffected by construction path.
 *
 * The recorded numbers feed the AC12 threshold note — segmented log /
 * compaction is the named future policy if these cross the
 * UX-noticeable ~100ms band.
 */
import { mkdtemp, rm, stat, writeFile, mkdir, rename, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(__dirname, "..", "dist");

const { appendJournalEntry, buildJournalRecall, buildJournalCacheKeyMap } = await import(
  path.join(dist, "lib", "journal.js")
);
const { readLog } = await import(path.join(dist, "lib", "artifacts.js"));

const argOf = (name, fallback) => {
  const i = process.argv.indexOf(name);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  if (v === undefined) throw new Error(`${name} requires a value`);
  return v;
};
const scales = argOf("--entries", "10000,50000,100000")
  .split(",")
  .map((n) => {
    const v = parseInt(n, 10);
    if (!Number.isInteger(v) || v <= 0) throw new Error(`bad --entries value: ${n}`);
    return v;
  });
const runs = parseInt(argOf("--runs", "5"), 10);

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const avg = (xs) => xs.reduce((s, v) => s + v, 0) / xs.length;
const max = (xs) => xs.reduce((a, b) => Math.max(a, b), 0);
const fmt = (xs) => `med ${median(xs).toFixed(1)}ms  avg ${avg(xs).toFixed(1)}ms  max ${max(xs).toFixed(1)}ms`;

// Realistic production shape: 5-result search skeleton (url+title), a
// ~15-token query, single-provider routing with #108 servedFrom.
// Mirrors what T2a/T3 write through the seam on a real cache-miss run.
function fullEntry(i) {
  return {
    kind: "journal",
    requestId: `req-${i.toString(36).padStart(7, "0")}-${Date.now().toString(36)}`,
    timestamp: 1700000000000 + i * 60000,
    capability: "search",
    provider: { mode: "single", effective: "tavily", servedFrom: "live" },
    query: `how to batch normalize embeddings for vector index shard ${i} without retraining`,
    contentHash: "a".repeat(64),
    cacheKey: `cache-${i}`,
    skeleton: {
      results: Array.from({ length: 5 }, (_, r) => ({
        url: `https://docs.example.com/guide/${i}/${r}/vector-normalization`,
        title: `Guide ${i}.${r}: normalizing vector embeddings at scale`,
      })),
    },
  };
}

// T2b repeat marker shape (~150B): identity + repeatOf, nothing else.
function markerEntry(i) {
  return {
    kind: "journal",
    timestamp: 1700000000000 + i * 60000,
    capability: "search",
    provider: { mode: "single", effective: "tavily", servedFrom: "cache" },
    repeatOf: "req-seed",
  };
}

/** One-shot direct write of an N-entry mixed log (85% full / 15% markers), 0600. */
async function writeMixedLog(dir, count) {
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    entries.push(i % 7 === 0 ? markerEntry(i) : fullEntry(i));
  }
  const file = path.join(dir, "index.json");
  const tmp = `${file}.tmp.probe`;
  await mkdir(dir, { recursive: true });
  await writeFile(tmp, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`);
  await chmod(tmp, 0o600);
  await rename(tmp, file);
}

/** One-shot direct write of an all-markers log (the AC2 counterfactual). */
async function writeMarkerLog(dir, count) {
  const entries = Array.from({ length: count }, (_, i) => markerEntry(i));
  const file = path.join(dir, "index.json");
  const tmp = `${file}.tmp.probe`;
  await writeFile(tmp, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`);
  await chmod(tmp, 0o600);
  await rename(tmp, file);
}

/** Time one op `runs` times; prints median/avg/max, returns the median. */
async function bench(label, op) {
  const samples = [];
  for (let i = 0; i < runs; i += 1) {
    const t0 = performance.now();
    await op();
    samples.push(performance.now() - t0);
  }
  console.log(`  ${label.padEnd(44)} ${fmt(samples)}`);
  return median(samples);
}

async function sizeOf(dir) {
  const { size } = await stat(path.join(dir, "index.json"));
  return size;
}

console.log(`# journal scale probe — entries [${scales.join(", ")}], ${runs} runs/sample\n`);

const summary = [];
for (const scale of scales) {
  const dir = await mkdtemp(path.join(tmpdir(), "scoutline-journal-probe-"));
  try {
    console.log(`## ${scale.toLocaleString()} entries`);
    await writeMixedLog(dir, scale);
    const bytes = await sizeOf(dir);
    console.log(`  log size: ${(bytes / 1024 / 1024).toFixed(1)}MB`);

    const appendFull = await bench("append full entry (read-modify-write)", () =>
      appendJournalEntry(dir, fullEntry(scale)),
    );
    const appendMarker = await bench("append repeat marker", () =>
      appendJournalEntry(dir, markerEntry(scale)),
    );

    // T5 recall end to end: cold includes the full read+parse+validate.
    const recallCold = await bench("recall cold (readLog + score)", async () => {
      const fresh = await readLog(dir);
      return buildJournalRecall(fresh.log.entries, "vector embeddings scale", {});
    });
    const { log } = await readLog(dir);
    const recallHot = await bench("recall hot (entries pre-parsed)", () =>
      buildJournalRecall(log.entries, "vector embeddings scale", {}),
    );

    // T2b review F3: cache-HIT journaling reads the log for the
    // cacheKey map BEFORE the append reads it again. End to end:
    const hitPath = await bench("hit path (map read + marker append)", async () => {
      const map = await buildJournalCacheKeyMap(dir);
      const repeatOf = map.get(`cache-${scale % 7 === 0 ? scale - 1 : scale}`) ?? "req-seed";
      await appendJournalEntry(dir, markerEntry(scale));
      return repeatOf;
    });

    // Arithmetic-series quadratic statement: seeding this log by N
    // seam appends costs ~ N × append(N)/2 (each append rewrites the
    // whole file grown so far).
    const rebuildHours = ((scale * appendFull) / 2 / 3_600_000).toFixed(2);
    console.log(
      `  quadratic note: seeding this log via ${scale.toLocaleString()} seam appends ≈ ${rebuildHours}h (N × ${appendFull.toFixed(1)}ms / 2)`,
    );
    summary.push({ scale, bytes, appendFull, appendMarker, recallCold, recallHot, hitPath });
    console.log("");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// AC2 marker-smallness counterfactual at the largest scale: the log a
// hot repeated workload produces (all markers) — size + one append.
{
  const scale = scales[scales.length - 1];
  const dir = await mkdtemp(path.join(tmpdir(), "scoutline-journal-probe-m-"));
  try {
    console.log(`## marker-only log at ${scale.toLocaleString()} entries (counterfactual)`);
    await writeMarkerLog(dir, scale);
    const bytes = await sizeOf(dir);
    console.log(`  log size: ${(bytes / 1024 / 1024).toFixed(1)}MB`);
    await bench("append repeat marker (marker-only log)", () =>
      appendJournalEntry(dir, markerEntry(scale)),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
