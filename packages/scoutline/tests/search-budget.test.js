/**
 * Output Budget — search integration (ADR-0007, lane T3).
 *
 * Pins:
 *   - `search --max-chars N` is whole-envelope: the ladder walks
 *     summaries-trim → source/date-drop → lowest-rank-drop (LAST);
 *     url/title/rank are never cut (invariant across shrink levels).
 *   - Budget applies POST-merge on the fan-out path (POST-merge final
 *     envelope) and POST-count (both the per-request cap and the
 *     post-merge slice): a dropped-by-budget result still exists in
 *     the artifact — the count REQUEST is never silently reduced.
 *   - `--max-summary` composes underneath: whole-envelope budgeting
 *     runs in ALL output modes (text modes included), while
 *     `--max-summary` keeps its JSON-modes-only per-field scope.
 *   - `compaction { budget, ref }` lands inside the data payload;
 *     the FULL untrimmed envelope is written to the artifacts store
 *     (redacted through the stdout seam) with a kind:"save" log
 *     entry; `history show` recovery works offline.
 *   - Zero-diff: without `--max-chars`, stdout/stderr are byte-identical
 *     to the pre-T3 output, with and without fan-out, with and without
 *     --save (nothing written to the store either).
 *   - Strict parse: `--max-chars` must be a positive integer
 *     (parseBriefMaxChars-class), rejecting `500x`/`0`/`1.5` with
 *     VALIDATION_ERROR through the established repo path.
 *
 * Hermeticity: main()-level via hermeticMainDeps (no ambient
 * ~/.scoutline), SCOUTLINE_ARTIFACTS_DIR isolated per test, injected
 * clock; fan-out via fake descriptors (search-fanout.test.js idiom).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { main } from "../dist/index.js";
import { SEARCH_LADDER } from "../dist/commands/search.js";
import { applyBudget, measurePayload } from "../dist/lib/output-budget.js";
import { readLog } from "../dist/lib/artifacts.js";
import { buildHistoryShowReport } from "../dist/commands/history.js";
import { ValidationError } from "../dist/lib/errors.js";
import { hermeticMainDeps, createInMemoryResponseCache } from "./helpers/hermetic-main.js";
import { withTempDir } from "./helpers/temp-dir.js";

// Fixed clock — injected, never Date.now() (repo time-bomb rule).
const NOW = 1_800_000_000_000;

function src(title, url, summary, extra = {}) {
  return { title, url, summary, ...extra };
}

/** Fan-out-capable fake descriptor (search-fanout.test.js idiom). */
function makeDescriptor(id, resultsByQuery) {
  return {
    id,
    isConfigured: () => true,
    capabilities: () => new Set(["search"]),
    create: () => ({
      id,
      search: {
        validate() {},
        cacheIdentity(request) {
          return {
            provider: id,
            capability: "search",
            credentialFingerprint: "fp-" + id,
            request,
            legacyCandidates: [],
          };
        },
        async invoke(request) {
          return resultsByQuery[request.query] ?? [];
        },
      },
    }),
  };
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

/** Five sources with distinct summaries/sources/dates — the ladder's raw material. */
function fiveSources() {
  return [
    src("One", "https://e/1", "a".repeat(120), { source: "e.com", date: "2026-01-01" }),
    src("Two", "https://e/2", "b".repeat(120), { source: "e.com", date: "2026-01-02" }),
    src("Three", "https://e/3", "c".repeat(120), { source: "e.com", date: "2026-01-03" }),
    src("Four", "https://e/4", "d".repeat(120), { source: "e.com", date: "2026-01-04" }),
    src("Five", "https://e/5", "e".repeat(120), { source: "e.com", date: "2026-01-05" }),
  ];
}

/** Run main() for `scoutline search <query> [extra args...]` hermetically. */
async function runMain(argv, { artifactsDir, extraDeps = {} } = {}) {
  const { adapter, stdout, stderr } = makeInvocation();
  const status = await main(argv, {
    ...hermeticMainDeps({
      invocation: adapter,
      ...(artifactsDir !== undefined
        ? { env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir } }
        : {}),
      now: () => NOW,
      ...extraDeps,
    }),
  });
  return { status, stdout, stderr };
}

/** Parsed data payload of a data-mode run. */
function parseData(stdout) {
  assert.ok(stdout.length > 0, "expected stdout output");
  return JSON.parse(stdout.join(""));
}

// ---------------------------------------------------------------------------
// Strict parse (parseBriefMaxChars-class, via the repo path)
// ---------------------------------------------------------------------------

describe("search --max-chars — strict positive-integer parse", () => {
  it("rejects a trailing-garbage value (500x) with VALIDATION_ERROR", async (t) => {
    await withTempDir(t, async (dir) => {
      const { status, stderr } = await runMain(
        ["--provider", "zai", "search", "q", "--max-chars", "500x"],
        { artifactsDir: dir },
      );
      assert.equal(status, 1);
      assert.ok(
        stderr.some((l) => l.includes("--max-chars must be a positive integer")),
        `expected parse rejection, got: ${JSON.stringify(stderr)}`,
      );
    });
  });

  it("rejects zero, fractions, and negative values", async (t) => {
    for (const bad of ["0", "1.5", "-5"]) {
      const { status } = await runMain(
        ["--provider", "zai", "search", "q", "--max-chars", bad],
        {},
      );
      assert.equal(status, 1, `--max-chars ${bad} must fail`);
    }
  });

  it("rejects a valueless flag", async (t) => {
    const { status } = await runMain(["--provider", "zai", "search", "q", "--max-chars"], {});
    assert.equal(status, 1);
  });
});

// ---------------------------------------------------------------------------
// Ladder semantics (unit-level over the exported SEARCH_LADDER)
// ---------------------------------------------------------------------------

describe("SEARCH_LADDER — whole-envelope priority", () => {
  it("trims summaries before dropping source/date before dropping lowest ranks", () => {
    const envelope = { results: fiveSources().map((s, i) => ({ ...s, rank: i + 1 })) };
    const full = measurePayload(envelope);

    // Level 1: gentle budget — only summaries shrink.
    const level1 = applyBudget(envelope, Math.floor(full * 0.8), SEARCH_LADDER);
    assert.ok(level1.compaction, "budget below full size must fire");
    assert.equal(level1.compaction.note, undefined, "no floor at a gentle budget");
    assert.equal(level1.projection.results.length, 5);
    assert.ok(
      level1.projection.results.every(
        (r) => r.summary.length < 120 && r.source === "e.com" && r.date !== undefined,
      ),
      "level 1 trims summaries only",
    );

    // Level 2: tighter — source/date gone, all five rows still present.
    const floorOfFive = measurePayload({
      results: fiveSources().map((s, i) => ({
        rank: i + 1,
        title: s.title,
        url: s.url,
        summary: "",
      })),
    });
    const level2 = applyBudget(envelope, floorOfFive, SEARCH_LADDER);
    assert.equal(level2.projection.results.length, 5, "rows survive level 2");
    assert.ok(
      level2.projection.results.every((r) => r.source === undefined && r.date === undefined),
      "level 2 drops source/date",
    );

    // Level 3: only rank 1–2 fit — ranks 5,4,3 dropped LAST and in that order.
    const twoRows = measurePayload({
      results: [
        { rank: 1, title: "One", url: "https://e/1", summary: "" },
        { rank: 2, title: "Two", url: "https://e/2", summary: "" },
      ],
    });
    const level3 = applyBudget(envelope, twoRows, SEARCH_LADDER);
    assert.deepEqual(
      level3.projection.results.map((r) => r.rank),
      [1, 2],
      "lowest ranks drop last",
    );
  });

  it("url/title/rank survive every level — the never-cut invariant", () => {
    const envelope = { results: fiveSources().map((s, i) => ({ ...s, rank: i + 1 })) };
    for (const budget of [1400, 1000, 700, 500, 300, 200, 150]) {
      const { projection } = applyBudget(envelope, budget, SEARCH_LADDER);
      for (const r of projection.results) {
        assert.ok(r.url && r.title, `budget ${budget}: url/title survive`);
        assert.equal(typeof r.rank, "number");
      }
    }
  });

  it("floor clamp: below-minimum budget yields the floor envelope, never throws", () => {
    const envelope = { results: fiveSources().map((s, i) => ({ ...s, rank: i + 1 })) };
    const floor = applyBudget(envelope, 10, SEARCH_LADDER);
    assert.equal(floor.compaction.note, "floor");
    // Rank 1 is the floor survivor (lowest ranks drop last ⇒ 1 stays).
    assert.equal(floor.projection.results.length, 1);
    assert.equal(floor.projection.results[0].rank, 1);
    assert.ok(floor.projection.results[0].url);
    assert.ok(floor.projection.results[0].title);
  });

  it("mutation guard: a ladder that drops rank 1 early cannot satisfy this fixture", () => {
    // The fallback-rescue trap: the fixture must make the WRONG order
    // observable. Drop-highest-first must NOT beat drop-lowest-last on
    // this envelope: with rank 1 dropped first, url/title of rank 1
    // are gone, which the invariant forbids.
    const envelope = { results: fiveSources().map((s, i) => ({ ...s, rank: i + 1 })) };
    const twoRows = measurePayload({
      results: [
        { rank: 1, title: "One", url: "https://e/1", summary: "" },
        { rank: 2, title: "Two", url: "https://e/2", summary: "" },
      ],
    });
    const { projection } = applyBudget(envelope, twoRows, SEARCH_LADDER);
    assert.ok(
      projection.results.some((r) => r.rank === 1),
      "rank 1 must survive (drops start at the lowest rank)",
    );
  });
});

// ---------------------------------------------------------------------------
// main()-level: single-provider whole-envelope budgeting
// ---------------------------------------------------------------------------

describe("search --max-chars (main, single provider) — whole envelope", () => {
  it("fits the printed envelope and stamps compaction {budget, ref} in the data payload", async (t) => {
    await withTempDir(t, async (dir) => {
      const { status, stdout } = await runMain(
        ["--provider", "tavily", "search", "q", "--max-chars", "900"],
        {
          artifactsDir: dir,
          extraDeps: {
            providerDescriptors: [makeDescriptor("tavily", { q: fiveSources() })],
          },
        },
      );
      assert.equal(status, 0);
      const data = parseData(stdout);
      assert.ok(data.compaction, "compaction stamped in-band");
      assert.equal(data.compaction.budget, 900);
      assert.match(data.compaction.ref, /^2\d{7}T\d{6}Z-/);

      // In-band fits (compaction stamp itself excluded from the budget —
      // it is metadata about the projection, not gathered material).
      const { compaction, ...results } = data;
      void compaction;
      assert.ok(
        measurePayload(results) <= 900,
        `in-band envelope fits: ${measurePayload(results)} <= 900`,
      );
      for (const r of data.results) {
        assert.ok(r.url && r.title, "never-cut fields survive in-band");
      }
    });
  });

  it("writes the FULL untrimmed envelope (post-redaction, pre-compaction) and recovers via history show", async (t) => {
    await withTempDir(t, async (dir) => {
      const { status } = await runMain(
        ["--provider", "tavily", "search", "q", "--max-chars", "700"],
        {
          artifactsDir: dir,
          extraDeps: {
            providerDescriptors: [makeDescriptor("tavily", { q: fiveSources() })],
          },
        },
      );
      assert.equal(status, 0);

      // Unbudgeted reference run for the cardinal comparison.
      const secondDir = await fs.mkdtemp(path.join(dir, "ref-"));
      const { stdout: refOut } = await runMain(
        ["--provider", "tavily", "search", "q"],
        {
          artifactsDir: secondDir,
          extraDeps: {
            providerDescriptors: [makeDescriptor("tavily", { q: fiveSources() })],
          },
        },
      );

      const { log } = await readLog(dir);
      assert.ok(log.entries.length >= 1, "log entry mandatory per compaction artifact");
      const entry = log.entries.find((e) => e.command === "search");
      assert.ok(entry);
      // Presentation-flag-free args (no --max-chars in the log).
      assert.ok(!JSON.stringify(entry.args).includes("max-chars"));

      const report = await buildHistoryShowReport(log, entry.requestId, async (e) =>
        fs.readFile(path.join(dir, e.masterPath), "utf8"),
      );
      // Cardinal pin: artifact result == the unbudgeted run's payload.
      assert.deepEqual(report.report.result, parseData(refOut));
    });
  });

  it("--count applies BEFORE budget: count requested 3, budget drops visible rows, artifact still holds the three", async (t) => {
    await withTempDir(t, async (dir) => {
      const { status, stdout } = await runMain(
        ["--provider", "tavily", "search", "q", "--count", "3", "--max-chars", "150"],
        {
          artifactsDir: dir,
          extraDeps: {
            providerDescriptors: [makeDescriptor("tavily", { q: fiveSources() })],
          },
        },
      );
      assert.equal(status, 0);
      const data = parseData(stdout);
      assert.ok(data.compaction, "budget fires below the count-3 envelope");
      assert.ok(
        data.results.length < 3,
        "shown-by-budget is smaller than the count REQUEST",
      );
      assert.ok(
        data.results.every((r) => r.url && r.title),
        "survivors keep never-cut fields",
      );

      const { log } = await readLog(dir);
      const report = await buildHistoryShowReport(
        log,
        log.entries[0].requestId,
        async (e) => fs.readFile(path.join(dir, e.masterPath), "utf8"),
      );
      // The artifact holds the post-count envelope: exactly 3, not 5.
      assert.equal(report.report.result.length, 3);
    });
  });
});

// ---------------------------------------------------------------------------
// Fan-out: budget applies POST-merge on the final envelope
// ---------------------------------------------------------------------------

describe("search --max-chars (main, fan-out) — POST-merge budgeting", () => {
  function twoArmDeps(dir1, dir2) {
    const tav = makeDescriptor("tavily", { q: dir1 });
    const exa = makeDescriptor("exa", { q: dir2 });
    return {
      providerDescriptors: [tav, exa],
      searchCache: createInMemoryResponseCache(),
      searchSleep: async () => {},
      searchRandom: () => 0.5,
    };
  }

  it("budgets the merged envelope: rank 1 of the MERGE keeps its url/title, arms' data dedupes first", async (t) => {
    await withTempDir(t, async (dir) => {
      const shared = src("Shared", "https://e/shared", "s".repeat(150));
      const { status, stdout, stderr } = await runMain(
        ["--provider", "tavily,exa", "search", "q", "--max-chars", "200"],
        {
          artifactsDir: dir,
          extraDeps: twoArmDeps(
            [shared, src("T2", "https://e/t2", "t2 ".repeat(40))],
            [shared, src("E2", "https://e/e2", "e2 ".repeat(40))],
          ),
        },
      );
      assert.equal(status, 0);
      assert.ok(stderr.some((l) => /fanned out to 2 providers/.test(l)), "fan-out engaged");
      const data = parseData(stdout);
      assert.ok(data.compaction, "compaction stamped on the fan-out path");
      // The shared URL deduped to ONE row (merge happened BEFORE budget).
      const sharedRows = data.results.filter((r) => r.url === "https://e/shared");
      assert.equal(sharedRows.length, 1, "dedupe precedes budget (POST-merge)");
      assert.ok(sharedRows[0].title === "Shared");
    });
  });

  it("fan-out budget artifact holds the merged envelope with mergedFrom provenance", async (t) => {
    await withTempDir(t, async (dir) => {
      const shared = src("Shared", "https://e/shared", "s".repeat(150));
      await runMain(["--provider", "tavily,exa", "search", "q", "--max-chars", "700"], {
        artifactsDir: dir,
        extraDeps: twoArmDeps(
          [shared, src("T2", "https://e/t2", "t2 ".repeat(40))],
          [shared, src("E2", "https://e/e2", "e2 ".repeat(40))],
        ),
      });
      const { log } = await readLog(dir);
      const report = await buildHistoryShowReport(
        log,
        log.entries[0].requestId,
        async (e) => fs.readFile(path.join(dir, e.masterPath), "utf8"),
      );
      const sharedRow = report.report.result.find((r) => r.url === "https://e/shared");
      assert.ok(sharedRow, "full merged row in the artifact");
      assert.deepEqual(sharedRow.mergedFrom, ["tavily", "exa"], "provenance preserved unbudgeted");
    });
  });
});

// ---------------------------------------------------------------------------
// Output modes: compaction in every mode; --max-summary reconciliation
// ---------------------------------------------------------------------------

describe("search --max-chars across output modes", () => {
  const deps = () => ({
    providerDescriptors: [makeDescriptor("tavily", { q: fiveSources() })],
  });

  async function runMode(mode, extra = []) {
    const { stdout } = await runMain(
      ["-O", mode, "--provider", "tavily", "search", "q", "--max-chars", "300", ...extra],
      { extraDeps: deps() },
    );
    return stdout.join("");
  }

  it("stamps compaction in -O data, -O json, and -O pretty", async (t) => {
    for (const mode of ["data", "json", "pretty"]) {
      const out = await runMode(mode);
      const parsed =
        mode === "data" ? JSON.parse(out) : JSON.parse(out).data;
      assert.ok(parsed.compaction, `compaction visible in -O ${mode}`);
      assert.equal(parsed.compaction.budget, 300);
    }
  });

  it("whole-envelope budgeting engages in TEXT modes too (presentations rebuilt from the projection)", async (t) => {
    // Budget 300 on the five-row fixture drops rank 5 (level-3
    // shrink) — the markdown presentation must show 4 URLs, not 5.
    const markdown = await runMode("markdown");
    const urls = markdown.match(/https:\/\/e\/\d+/g) ?? [];
    assert.equal(urls.length, 4, "text mode reflects the budgeted envelope");
    assert.ok(!markdown.includes("https://e/5"), "dropped rank stays dropped in text mode");
    const compact = await runMode("compact");
    assert.ok(compact.includes("https://e/1"), "compact mode keeps urls");
  });

  it("--max-summary composes underneath: per-field lever applies first, budget envelopes the rest (all modes)", async (t) => {
    // Case A (the lever rescues): max-summary 20 shrinks every summary
    // to ≤20 chars BEFORE the envelope budget decides what else must
    // go — a budget of 1100 then FITS (the ~592-char envelope is
    // under it), so no compaction fires and all five rows keep
    // source/date. Without max-summary the same 1100 budget would
    // have fired and trimmed summaries (fixture full size ~1.1k).
    const a = await runMain(
      ["--provider", "tavily", "search", "q", "--max-summary", "20", "--max-chars", "1100"],
      { extraDeps: deps() },
    );
    assert.equal(a.status, 0);
    const dataA = parseData(a.stdout);
    // Budget fit → NO wrapper, bare array, no compaction stamp.
    assert.ok(Array.isArray(dataA), "envelope fit — raw array shape preserved");
    assert.ok(
      dataA.every((r) => r.summary.length <= 20),
      "max-summary still trims per-field",
    );
    assert.ok(
      dataA.every((r) => r.source !== undefined && r.date !== undefined),
      "budget fit thanks to the per-field lever — source/date survive",
    );

    // Case B (the envelope still wins): a tighter budget over the
    // max-summary-20 envelope fires the whole-envelope stamp.
    const b = await runMain(
      ["--provider", "tavily", "search", "q", "--max-summary", "20", "--max-chars", "550"],
      { extraDeps: deps() },
    );
    assert.equal(b.status, 0);
    const dataB = parseData(b.stdout);
    assert.ok(dataB.compaction, "envelope over the cap still fires the budget stamp");
    assert.equal(dataB.compaction.budget, 550);
  });

  it("--context composes: budget fires on the wrapped envelope, context block never cut", async (t) => {
    await withTempDir(t, async (dir) => {
      const ctxFile = path.join(dir, "notes.md");
      await fs.writeFile(ctxFile, "# Heading One\nWhat about topic A?\n");
      const { status, stdout } = await runMain(
        ["--provider", "tavily", "search", "q", "--context", ctxFile, "--max-chars", "600"],
        {
          artifactsDir: dir,
          extraDeps: {
            providerDescriptors: [makeDescriptor("tavily", { q: fiveSources() })],
          },
        },
      );
      assert.equal(status, 0);
      const data = parseData(stdout);
      assert.ok(data.context, "context wrapper present");
      // Never-cut: the context block survives every shrink level.
      assert.equal(data.context.source, "file");
      assert.equal(data.context.derived.subQueries, 2);
      assert.ok(data.compaction, "budget fires on the wrapped envelope");
      assert.ok(
        data.results.every((r) => r.url && r.title),
        "rows keep never-cut fields inside the wrapper",
      );
      // Artifact holds the WRAPPER shape (what an unbudgeted --context
      // run prints), redacted.
      const { log } = await readLog(dir);
      const report = await buildHistoryShowReport(
        log,
        log.entries[0].requestId,
        async (e) => fs.readFile(path.join(dir, e.masterPath), "utf8"),
      );
      assert.ok(report.report.result.context, "artifact keeps the context wrapper");
      assert.equal(report.report.result.results.length, 5, "full untrimmed rows");
    });
  });
});

// ---------------------------------------------------------------------------
// Zero-diff invariant (the binding mitigation)
// ---------------------------------------------------------------------------

describe("zero-diff: without --max-chars, byte-identical output", () => {
  it("single provider: no flag → identical stdout/stderr, store dir stays empty", async (t) => {
    await withTempDir(t, async (dir) => {
      const { status, stdout, stderr } = await runMain(
        ["--provider", "tavily", "search", "q"],
        {
          artifactsDir: dir,
          extraDeps: {
            providerDescriptors: [makeDescriptor("tavily", { q: fiveSources() })],
          },
        },
      );
      assert.equal(status, 0);
      assert.equal(stdout.length, 1);
      const data = parseData(stdout);
      assert.equal(data.length, 5, "raw array, no wrapper, no compaction");
      assert.ok(!("compaction" in data));
      const files = await fs.readdir(dir);
      assert.deepEqual(files, [], "no budget → no store writes");
      assert.deepEqual(stderr, [], "no notices without the flag");
    });
  });

  it("fan-out: no flag → byte-identical to the pre-T3 shape (mergedFrom, no compaction)", async (t) => {
    await withTempDir(t, async (dir) => {
      const shared = src("Shared", "https://e/shared", "s".repeat(30));
      const { status, stdout } = await runMain(
        ["--provider", "tavily,exa", "search", "q"],
        {
          artifactsDir: dir,
          extraDeps: {
            providerDescriptors: [
              makeDescriptor("tavily", { q: [shared, src("T2", "https://e/t2", "t")] }),
              makeDescriptor("exa", { q: [shared, src("E2", "https://e/e2", "e")] }),
            ],
            searchCache: createInMemoryResponseCache(),
          },
        },
      );
      assert.equal(status, 0);
      const data = parseData(stdout);
      assert.ok(!("compaction" in data));
      assert.ok(data.some((r) => r.mergedFrom), "fan-out provenance unchanged");
      const files = await fs.readdir(dir);
      assert.deepEqual(files, [], "no budget → no store writes");
    });
  });

  it("with --save: no budget → exactly one save artifact, budget adds its own separately", async (t) => {
    await withTempDir(t, async (dir) => {
      // No budget + --save: one artifact (the save hook's own).
      const a = await runMain(["--provider", "tavily", "search", "q", "--save"], {
        artifactsDir: dir,
        extraDeps: { providerDescriptors: [makeDescriptor("tavily", { q: fiveSources() })] },
      });
      assert.equal(a.status, 0);
      const { log: logA } = await readLog(dir);
      assert.equal(logA.entries.length, 1, "one save-hook entry, no budget artifact");

      const b = await runMain(
        ["--provider", "tavily", "search", "q", "--max-chars", "800"],
        {
          artifactsDir: dir,
          extraDeps: { providerDescriptors: [makeDescriptor("tavily", { q: fiveSources() })] },
        },
      );
      assert.equal(b.status, 0);
      const { log: logB } = await readLog(dir);
      assert.equal(logB.entries.length, 2, "budget artifact appends its own entry");
      const data = parseData(b.stdout);
      assert.ok(data.compaction, "budget run stamps compaction");
    });
  });
});

// ---------------------------------------------------------------------------
// Stamp accounting (pinned decision)
// ---------------------------------------------------------------------------

describe("stamp accounting — compaction metadata is outside the budget", () => {
  it("budgeted results+query fit the budget with the stamp excluded; stamp size is pinned (~40-char tolerance)", async (t) => {
    await withTempDir(t, async (dir) => {
      const { stdout } = await runMain(
        ["--provider", "tavily", "search", "q", "--max-chars", "900"],
        {
          artifactsDir: dir,
          extraDeps: { providerDescriptors: [makeDescriptor("tavily", { q: fiveSources() })] },
        },
      );
      const data = parseData(stdout);
      const { compaction, ...payload } = data;
      void payload;
      assert.ok(measurePayload(payload) <= 900, "projection fits");
      const stampSize = measurePayload({ compaction });
      assert.ok(
        stampSize >= 30 && stampSize <= 90,
        `compaction stamp ~40 chars (got ${stampSize}); pinned so it cannot drift silently`,
      );
    });
  });

  it("in-band rows == the direct applyBudget projection — the stamp never triggers a second ladder walk (M5 guard)", async (t) => {
    await withTempDir(t, async (dir) => {
      const { stdout } = await runMain(
        ["--provider", "tavily", "search", "q", "--max-chars", "900"],
        {
          artifactsDir: dir,
          extraDeps: { providerDescriptors: [makeDescriptor("tavily", { q: fiveSources() })] },
        },
      );
      const data = parseData(stdout);
      // Reproduce the pre-budget envelope from the fixture (rank
      // assignment starts at 1 in encounter order).
      const envelope = { results: fiveSources().map((s, i) => ({ ...s, rank: i + 1 })) };
      const expected = applyBudget(envelope, 900, SEARCH_LADDER);
      assert.deepEqual(data.results, expected.projection.results);
    });
  });
});
