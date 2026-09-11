/**
 * Science journal integration — T7 RED tests (TASKS T7, REVISED
 * 2026-09-10; PRD AC-5c, AC-11, AC-11 amendments, AC-12).
 *
 * GROUND map:
 *   - TASKS T7: journal lane LANDED (PR #111) — wire against the real
 *     seams: `JournalableCapability` (src/lib/journal.ts:40 union,
 *     :210 full-entry validator, :281 marker validator — science joins
 *     the journalable set), `--no-journal` escape (src/index.ts
 *     command-local parse), config `journal` kill-switch.
 *   - TASKS T7 "Skeletons: search = merged identity; get = single-work
 *     identity" — PRD AC-11 ("science search skeleton = the merged
 *     result-set identity (url+title list)") + AC-11 amendment 2
 *     ("science get's journal entry is a single-work skeleton").
 *   - TASKS T7 "Tests: entry append pins, --no-journal escape,
 *     kill-switch escape, marker/full branch per capability (cache-hit
 *     rules hold)".
 *   - PRD AC-12: journal seeding at the COMMAND layer — entries record
 *     what the USER asked (query/identifier), never per-supplier
 *     responses; journaled identity = user-visible identity.
 *   - PRD AC-12b: science journaling adds ZERO provider calls.
 *   - Interim note (TASKS T6): T6's resolver is single-supplier
 *     (openalex-first D5 arm order) with TODO(T10) fan-out — provider
 *     pins here assert the INTERIM single-arm shape; T10's diff
 *     UPDATES these pins to fan-out semantics, never deletes them.
 *
 * Hermeticity: main()-driven via hermeticMainDeps (config injection,
 * fake science descriptors, isolated SCOUTLINE_ARTIFACTS_DIR). Tests
 * import ../dist/... — verification order is build, then test.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main, ACCEPT_NO_JOURNAL_COMMANDS } from "../dist/index.js";
import { hermeticMainDeps } from "./helpers/hermetic-main.js";
import {
  appendJournalEntry,
  appendJournalEntryMaybeRepeat,
  skeletonContentHash,
} from "../dist/lib/journal.js";
import { readLog } from "../dist/lib/artifacts.js";

// The D5 openalex-first arm order (executor-side; TASKS T6 landed it as
// the interim walk order). Test-side literal: the interim journal
// provider pin below keys off arm #1 (openalex).
const D5_ARM_ORDER = ["openalex", "arxiv", "crossref", "pubmed", "europepmc"];

function makeTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeInvocation() {
  const stdout = [];
  const stderr = [];
  return {
    adapter: {
      stdoutIsTTY: false,
      stdinIsTTY: false,
      environmentOutputMode: "data",
      readStdin: async () => "",
      writeStdout: (v) => stdout.push(v),
      writeStderr: (v) => stderr.push(v),
      runQuietly: async (op) => op(),
      setExitCode: () => {},
    },
    stdout,
    stderr,
  };
}

/** Fake science supplier (science-command.test.js idiom, trimmed). */
function makeScienceDescriptor(id, opts = {}) {
  const calls = { search: [], get: [] };
  const searchWorks =
    opts.searchWorks ?? [
      { title: `work-${id}-1`, url: `https://example.org/${id}/1` },
      { title: `work-${id}-2`, url: `https://example.org/${id}/2` },
    ];
  const getWork = opts.getWork ?? { title: `single-${id}`, url: `https://example.org/${id}/work` };
  const descriptor = {
    id,
    isConfigured: () => opts.configured?.() ?? true,
    capabilities: () => new Set(opts.caps ?? ["science.search", "science.get"]),
    create() {
      return {
        id,
        science: {
          search: {
            validate() {},
            cacheIdentity: (request) => ({
              supplier: id,
              capability: "science.search",
              credentialFingerprint: "",
              request,
            }),
            async invoke(request) {
              calls.search.push(request);
              return searchWorks;
            },
          },
          get: {
            validate() {},
            cacheIdentity: (request) => ({
              supplier: id,
              capability: "science.get",
              credentialFingerprint: "",
              request,
            }),
            async invoke(request) {
              calls.get.push(request);
              return getWork;
            },
          },
        },
      };
    },
  };
  return { descriptor, calls };
}

function scienceFive(perIdOpts = {}) {
  const byId = {};
  const descriptors = [];
  for (const id of D5_ARM_ORDER) {
    const made = makeScienceDescriptor(id, perIdOpts[id] ?? {});
    byId[id] = made;
    descriptors.push(made.descriptor);
  }
  return { descriptors, byId };
}

async function runMain(argv, { descriptors, artifactsDir, loadScoutlineConfig } = {}) {
  const { adapter, stdout, stderr } = makeInvocation();
  const status = await main(argv, {
    ...hermeticMainDeps({
      invocation: adapter,
      env: {
        ...(artifactsDir !== undefined ? { SCOUTLINE_ARTIFACTS_DIR: artifactsDir } : {}),
      },
      ...(descriptors !== undefined ? { providerDescriptors: descriptors } : {}),
      ...(loadScoutlineConfig !== undefined ? { loadScoutlineConfig } : {}),
    }),
  });
  return { status, stdout, stderr };
}

/** Read index.json journal entries via the VALIDATING read seam. */
async function readJournalEntries(artifactsDir) {
  const { log, notice } = await readLog(artifactsDir);
  return { entries: log.entries, notice };
}

// ---------------------------------------------------------------------------
// The widened journalable set (TASKS T7 first bullet)
// ---------------------------------------------------------------------------

describe("T7: science joins the journalable set (seam pins)", () => {
  it("ACCEPT_NO_JOURNAL_COMMANDS contains the science noun (the --no-journal accept set widens)", async () => {
    // GROUND: TASKS T7 — "`--no-journal` escape (src/index.ts command-local
    // parse)": the escape only exists on commands inside the accept set;
    // science joins it (the T2a gate's flip owner was named in
    // science-command.test.js's pre-T7 rejection pin).
    assert.ok(
      ACCEPT_NO_JOURNAL_COMMANDS.has("science"),
      "science must join ACCEPT_NO_JOURNAL_COMMANDS (T7 flip)",
    );
  });

  it("the journal lib validator accepts a capability-\"science\" FULL entry (journal.ts:210 widening)", async () => {
    // GROUND: TASKS T7 — "`JournalableCapability` (src/lib/journal.ts:40/
    // 210/281 — science capabilities join the journalable set)". A full
    // entry whose capability is the science noun must survive the
    // VALIDATING readLog (a rejected shape is warn-dropped with a
    // corruption notice — journal.test.js's fail-open pin).
    const dir = makeTempDir("scoutline-scijr-unit-full-");
    try {
      await appendJournalEntry(dir, {
        kind: "journal",
        requestId: "20260911T000000Z-0001",
        timestamp: 1,
        capability: "science",
        provider: { mode: "single", effective: "openalex", servedFrom: "live" },
        query: "graph transformers",
        contentHash: "a".repeat(64),
        cacheKey: "v2.science:unit-full",
        skeleton: { results: [{ url: "https://example.org/1", title: "t1" }] },
      });
      const { entries, notice } = await readJournalEntries(dir);
      assert.strictEqual(notice, undefined, "no corruption notice for a science entry");
      assert.strictEqual(entries.length, 1, "the science full entry validates and reads back");
      assert.strictEqual(entries[0].capability, "science");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the journal lib validator accepts a capability-\"science\" repeat MARKER, and the marker branch resolves through the cacheKey map (journal.ts:281 widening)", async () => {
    // GROUND: TASKS T7 — "marker/full branch per capability (cache-hit
    // rules hold)": the T2b repeat-marker branch must accept science
    // entries — a warm re-ask under a resolvable cacheKey writes the
    // tiny marker referencing the prior full entry's requestId.
    const dir = makeTempDir("scoutline-scijr-unit-marker-");
    try {
      const full = {
        kind: "journal",
        requestId: "20260911T000000Z-0002",
        timestamp: 1,
        capability: "science",
        provider: { mode: "single", effective: "openalex", servedFrom: "live" },
        query: "graph transformers",
        contentHash: "b".repeat(64),
        cacheKey: "v2.science:unit-marker",
        skeleton: { results: [{ url: "https://example.org/1", title: "t1" }] },
      };
      await appendJournalEntry(dir, full);
      await appendJournalEntryMaybeRepeat(
        dir,
        full,
        (repeatOf) => ({
          kind: "journal",
          timestamp: 2,
          capability: "science",
          provider: { mode: "single", effective: "openalex", servedFrom: "cache" },
          repeatOf,
        }),
      );
      const { entries, notice } = await readJournalEntries(dir);
      assert.strictEqual(notice, undefined);
      assert.strictEqual(entries.length, 2, "full entry + marker both validate");
      const marker = entries[1];
      assert.strictEqual(marker.repeatOf, full.requestId, "marker resolves the prior full entry");
      assert.strictEqual(marker.capability, "science");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Entry append pins, main-driven (TASKS T7 "entry append pins";
// PRD AC-5c, AC-11, AC-11 amendment 2, AC-12)
// ---------------------------------------------------------------------------

describe("T7: science search journals one skeleton entry (main-driven)", () => {
  it("science search (default, journaling on) appends EXACTLY ONE full journal entry — merged result-set identity", async (t) => {
    // GROUND: TASKS T7 "entry append pins … Skeletons: search = merged
    // identity"; PRD AC-5c ("a science search run appends a skeleton
    // entry (url+title identity, query, provider) to the journal") +
    // AC-11 ("science search skeleton = the merged result-set identity
    // (url+title list)") + AC-12 ("journaled identity = user-visible
    // identity" — the query the USER typed, not a supplier munged form).
    // Provider pin is INTERIM single-arm (TASKS T6: D5 arm #1 openalex;
    // TODO(T10) fan-out updates this pin, never deletes it).
    const dir = makeTempDir("scoutline-scijr-search-");
    try {
      const works = [
        { title: "Attention Is All You Need", url: "https://doi.org/10.5555/3295222" },
        { title: "A second work", url: "https://example.org/second" },
      ];
      const { descriptors, byId } = scienceFive({
        openalex: { searchWorks: works },
      });
      const { status, stderr } = await runMain(
        ["science", "search", "attention mechanism"],
        { descriptors, artifactsDir: dir },
      );
      assert.equal(status, 0, `stderr=${JSON.stringify(stderr)}`);
      assert.equal(byId.openalex.calls.search.length, 1, "the search itself ran (AC-12b: journal adds zero provider calls)");
      const { entries, notice } = await readJournalEntries(dir);
      assert.strictEqual(notice, undefined, "no corruption notice");
      assert.strictEqual(entries.length, 1, "exactly ONE journal entry");
      const entry = entries[0];
      assert.strictEqual(entry.kind, "journal");
      assert.strictEqual(entry.repeatOf, undefined, "full entry, not a marker (live run)");
      assert.strictEqual(entry.capability, "science");
      assert.strictEqual(entry.query, "attention mechanism", "the USER's query, verbatim (AC-12)");
      // Interim single-arm provider: D5 arm #1, live serve.
      assert.deepStrictEqual(entry.provider, {
        mode: "single",
        effective: "openalex",
        servedFrom: "live",
      });
      // Search skeleton = the merged result-set identity: url+title of
      // every returned work, in row order (AC-11).
      assert.deepStrictEqual(
        entry.skeleton.results,
        works.map((w) => ({ url: w.url, title: w.title })),
      );
      // contentHash = sha256 of the normalized skeleton serialization.
      assert.strictEqual(entry.contentHash, skeletonContentHash(entry.skeleton));
      assert.ok(typeof entry.cacheKey === "string" && entry.cacheKey.length > 0, "non-empty cacheKey");
      assert.ok(typeof entry.requestId === "string" && entry.requestId.length > 0);
      assert.ok(typeof entry.timestamp === "number");
      assert.strictEqual(entry.cacheRef, undefined, "no cacheRef — self-contained forever");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("science search with ZERO results still appends exactly ONE full entry — skeleton.results deep-equals [] (the search precedent)", async (t) => {
    // GROUND: FIX round — the search seam journals a zero-result run as
    // one full entry with an EMPTY results array; the science twin must
    // not diverge. The pre-fix early-return on empty results was neither
    // pinned nor grounded — deleted; this test pins the widened shape.
    const dir = makeTempDir("scoutline-scijr-empty-");
    try {
      const { descriptors, byId } = scienceFive({
        openalex: { searchWorks: [] },
      });
      const { status, stderr } = await runMain(
        ["science", "search", "attention mechanism"],
        { descriptors, artifactsDir: dir },
      );
      assert.equal(status, 0, `stderr=${JSON.stringify(stderr)}`);
      assert.equal(byId.openalex.calls.search.length, 1, "the search itself ran (AC-12b)");
      const { entries, notice } = await readJournalEntries(dir);
      assert.strictEqual(notice, undefined, "no corruption notice");
      assert.strictEqual(entries.length, 1, "exactly ONE journal entry for a zero-works run");
      const entry = entries[0];
      assert.strictEqual(entry.repeatOf, undefined, "full entry, not a marker (live run)");
      assert.strictEqual(entry.capability, "science");
      assert.deepStrictEqual(entry.skeleton.results, [], "zero-works skeleton: empty results array");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("science get appends ONE journal entry with a SINGLE-WORK skeleton; query is the identifier (AC-11 amendment 2)", async (t) => {
    // GROUND: TASKS T7 "get = single-work identity"; PRD AC-11 amendment
    // 2 ("science get's journal entry is a single-work skeleton; no
    // provider-fanout semantics") + AC-12 (the identifier the USER
    // passed is the journaled query).
    const dir = makeTempDir("scoutline-scijr-get-");
    try {
      const work = { title: "A single work", url: "https://example.org/one" };
      const { descriptors } = scienceFive({
        openalex: { getWork: work },
      });
      const { status, stderr } = await runMain(
        ["science", "get", "10.1038/nature12373"],
        { descriptors, artifactsDir: dir },
      );
      assert.equal(status, 0, `stderr=${JSON.stringify(stderr)}`);
      const { entries, notice } = await readJournalEntries(dir);
      assert.strictEqual(notice, undefined);
      assert.strictEqual(entries.length, 1, "exactly ONE journal entry for get");
      const entry = entries[0];
      assert.strictEqual(entry.kind, "journal");
      assert.strictEqual(entry.repeatOf, undefined);
      assert.strictEqual(entry.capability, "science");
      assert.strictEqual(entry.query, "10.1038/nature12373", "the identifier is the journaled query (AC-12)");
      // Single-work identity: EXACTLY one row, the work's url+title.
      assert.ok(Array.isArray(entry.skeleton?.results), "skeleton carries a results list");
      assert.strictEqual(entry.skeleton.results.length, 1, "get skeleton is exactly one row (single-work identity)");
      assert.deepStrictEqual(entry.skeleton.results[0], { url: work.url, title: work.title });
      assert.strictEqual(entry.contentHash, skeletonContentHash(entry.skeleton));
      assert.strictEqual(entry.cacheRef, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a second identical live run appends a SECOND full entry — no false repeat marker from a cacheless path (interim; T10 owns the executor cache)", async (t) => {
    // GROUND: TASKS T7 "marker/full branch per capability (cache-hit
    // rules hold)": the marker branch fires ONLY on a cache-served
    // re-ask. The interim science path invokes the supplier directly
    // (no response-cache consult), so a re-ask is LIVE again and must
    // journal a second FULL entry — never a fabricated marker. Hold
    // pin for the flip: once a science executor consults a response
    // cache (T10's seam), the cache-hit rules from T2b apply unchanged.
    const dir = makeTempDir("scoutline-scijr-twice-");
    try {
      const { descriptors } = scienceFive();
      for (let i = 0; i < 2; i += 1) {
        const { status, stderr } = await runMain(
          ["science", "search", "attention mechanism"],
          { descriptors, artifactsDir: dir },
        );
        assert.equal(status, 0, `run ${i + 1}: stderr=${JSON.stringify(stderr)}`);
      }
      const { entries, notice } = await readJournalEntries(dir);
      assert.strictEqual(notice, undefined);
      assert.strictEqual(entries.length, 2, "two live runs → two full entries");
      for (const entry of entries) {
        assert.strictEqual(entry.repeatOf, undefined, "a live re-ask is never a marker");
        assert.strictEqual(entry.capability, "science");
      }
      // Append-only: the first entry is byte-identical after the second.
      assert.notStrictEqual(entries[0].requestId, entries[1].requestId);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Escape switches (TASKS T7 "--no-journal escape … kill-switch escape";
// PRD AC-5c)
// ---------------------------------------------------------------------------

describe("T7: science journal escapes (main-driven)", () => {
  it("--no-journal on science search: the run SUCCEEDS and writes NO journal entry (per-call escape)", async (t) => {
    // GROUND: TASKS T7 "`--no-journal` escape"; PRD AC-5c ("--no-journal
    // escapes"). Pre-T7 the flag was REJECTED on science (the T2a
    // command-local gate) — this is the flipped pin (the T6-era test in
    // science-command.test.js pinned the rejection and is updated by
    // this ticket).
    const dir = makeTempDir("scoutline-scijr-nojournal-");
    try {
      const { descriptors, byId } = scienceFive();
      const { status, stdout, stderr } = await runMain(
        ["science", "search", "attention mechanism", "--no-journal"],
        { descriptors, artifactsDir: dir },
      );
      assert.equal(status, 0, "--no-journal must be ACCEPTED on science (exit 0, not UNSUPPORTED_OPTION)");
      assert.equal(byId.openalex.calls.search.length, 1, "the search itself ran");
      assert.ok(stdout.length > 0, "data envelope still emitted");
      const indexFile = join(dir, "index.json");
      if (existsSync(indexFile)) {
        const { entries } = await readJournalEntries(dir);
        assert.deepStrictEqual(entries, [], "no journal entry under --no-journal");
      }
      assert.equal(stderr.length, 0, `no stderr noise: ${JSON.stringify(stderr)}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("config kill-switch (\"journal\": false): science search succeeds and writes NO journal entry", async (t) => {
    // GROUND: TASKS T7 "config `journal` kill-switch"; PRD AC-5c
    // ("config kill-switch escapes"). Inverted-fanout idiom: absent/
    // unset = ON; explicit false = off. NOTE: this is a HOLD pin — the
    // no-entry direction trivially holds pre-flip; its teeth come from
    // the DEFAULT-writes-entries pin above (the pair differentiates the
    // kill-switch from the always-on default).
    const dir = makeTempDir("scoutline-scijr-killswitch-");
    try {
      const { descriptors, byId } = scienceFive();
      const { status, stdout, stderr } = await runMain(
        ["science", "search", "attention mechanism"],
        {
          descriptors,
          artifactsDir: dir,
          loadScoutlineConfig: async () => ({
            version: 1,
            providers: {},
            journal: false,
          }),
        },
      );
      assert.equal(status, 0, `stderr=${JSON.stringify(stderr)}`);
      assert.equal(byId.openalex.calls.search.length, 1, "the search itself ran");
      assert.ok(stdout.length > 0);
      const indexFile = join(dir, "index.json");
      if (existsSync(indexFile)) {
        const { entries } = await readJournalEntries(dir);
        assert.deepStrictEqual(entries, [], "no journal entry under journal:false");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("help runs never journal (documentation, not a run — the T2a help exemption holds for science)", async (t) => {
    // GROUND: the T2a gate's isHelpInvocation exemption (src/index.ts:
    // `--no-journal`/journal wiring skips help runs); PRD AC-5c journals
    // "a science search RUN". HOLD pin (help writes nothing pre-flip
    // too) — guards the wiring against journaling `science --help`.
    const dir = makeTempDir("scoutline-scijr-help-");
    try {
      const { descriptors } = scienceFive();
      const { status } = await runMain(["science", "--help"], {
        descriptors,
        artifactsDir: dir,
      });
      assert.equal(status, 0);
      const indexFile = join(dir, "index.json");
      if (existsSync(indexFile)) {
        const { entries } = await readJournalEntries(dir);
        assert.deepStrictEqual(entries, [], "help writes no journal entry");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
