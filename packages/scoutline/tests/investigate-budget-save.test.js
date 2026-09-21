/**
 * T5 — pack assembly, hashing, budget, save (investigate-pipeline lane;
 * docs/plans/investigate-pipeline DESIGN D5 + D7, PRD AC-6/AC-8).
 *
 * Coverage split across lanes:
 *   - contentSha256 / contentFormat / fetchedAt pins ALREADY live in
 *     tests/investigate-orchestrator.test.js (T4 landed assembly +
 *     hashing; the pack tests there recompute the hash and pin the
 *     UTC-Z ISO shape). This file adds the T5-exclusive surface:
 *
 *   - INVESTIGATE_LADDER priority pins (unit, over the exported
 *     ladder): passages trim first — quote truncate from the END,
 *     charRange adjusts, the round-trip pin
 *     content.slice(...charRange) === quote SURVIVES — then LATE
 *     sources drop whole, then question/subQueries/coverage are
 *     never cut (expressed by omission). Mutation pin: swapping the
 *     cut order (sources before passages) must RED the crush
 *     fixture.
 *   - applyInvestigateOutputBudget (composition): compaction
 *     {budget, ref} stamped in the data payload; the FULL untrimmed
 *     pack persisted through persistCompaction (mirrored save shape:
 *     redacted, log entry MANDATORY, presentation-flag-free args)
 *     and recoverable via history show <ref>.
 *   - --save / --save-force semantics at the seam science.ts
 *     established for command modules (createSaveArtifactHook):
 *     --save writes the artifact; overwriting an existing export
 *     without --save-force fails FILE_ERROR.
 *
 * 100% hermetic: injected fixtures, isolated SCOUTLINE_ARTIFACTS_DIR
 * per test (the cross-process lock-contention flake class), fixed
 * clock. No network, no ambient config reads.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { investigate, INVESTIGATE_LADDER } from "../dist/commands/investigate.js";
import {
  applyBudget,
  measurePayload,
  COMPACTION_STAMP_RESERVE,
} from "../dist/lib/output-budget.js";
import { readLog } from "../dist/lib/artifacts.js";
import { buildHistoryShowReport } from "../dist/commands/history.js";
import { FileError } from "../dist/lib/errors.js";
import { createInMemoryConsumptionSink } from "../dist/lib/consumption.js";
import { createSaveArtifactHook } from "../dist/lib/save-artifacts.js";
import { withTempDir } from "./helpers/temp-dir.js";

const NOW = 1_800_000_000_000;

// ---------------------------------------------------------------------------
// Ladder fixtures
// ---------------------------------------------------------------------------

/** Five sources with long quotes — the ladder's raw material (late sources drop whole). */
function fivePackSources() {
  const mk = (n, tail) => ({
    url: `https://e/s${n}`,
    finalUrl: `https://e/s${n}`,
    title: `Source ${n}`,
    fetchedAt: "2026-09-20T00:00:0" + n + ".000Z",
    provider: "tavily",
    contentFormat: "markdown",
    contentSha256: createHash("sha256").update("c" + n + tail, "utf8").digest("hex"),
    passages: [
      { quote: "alpha " + "x".repeat(120) + " " + tail, charRange: [0, 128 + tail.length] },
    ],
  });
  return [mk(1, "one"), mk(2, "two"), mk(3, "three"), mk(4, "four"), mk(5, "five")];
}

function fivePack() {
  return {
    schemaVersion: 1,
    question: "alpha | beta",
    subQueries: ["alpha", "beta"],
    sources: fivePackSources(),
    coverage: {
      subQueries: 2,
      armsUsed: 2,
      sourcesConsidered: 5,
      sourcesRead: 5,
      cacheHits: 0,
      unread: [],
    },
  };
}

/**
 * The round-trip pin asserted over every passage of a projection —
 * the invariant a quote trim must preserve (charRange adjusts to the
 * truncated slice). Sources here carry the passage's own content
 * equivalent: charRange is pinned against the PAIRED content string
 * via the source's quote itself, so the pin below re-slices from the
 * recorded (pre-trim) range only where the trim preserved it; after
 * a trim the pin demands slice(...adjustedRange) === adjustedQuote.
 */
function assertRoundTrip(pack, contentsByUrl) {
  for (const source of pack.sources) {
    const content = contentsByUrl[source.url];
    for (const passage of source.passages) {
      assert.strictEqual(
        content.slice(passage.charRange[0], passage.charRange[1]),
        passage.quote,
        `round-trip pin failed for ${source.url}`,
      );
    }
  }
}

describe("INVESTIGATE_LADDER — passages trim first, late sources drop whole", () => {
  it("level 1: gentle budget trims quotes only; charRange adjusts; round-trip pin survives", () => {
    const pack = fivePack();
    // The paired contents: each source's full content string the
    // charRange indexes into. Quote starts at 0 ("alpha ..."), so the
    // paired content IS the quote (assembly slices passages from it).
    const contentsByUrl = Object.fromEntries(
      pack.sources.map((s) => [s.url, s.passages[0].quote]),
    );
    const full = measurePayload(pack);
    const level1 = applyBudget(pack, Math.floor(full * 0.8), INVESTIGATE_LADDER);
    assert.ok(level1.compaction, "budget below full size must fire");
    assert.equal(level1.compaction.note, undefined, "no floor at a gentle budget");
    assert.equal(level1.projection.sources.length, 5, "sources survive level 1");
    for (const source of level1.projection.sources) {
      assert.ok(source.passages.length >= 1, "passages survive level 1");
      for (const p of source.passages) {
        assert.ok(p.quote.length < 130, "quotes actually trimmed");
      }
    }
    assertRoundTrip(level1.projection, contentsByUrl);
    // Never-cut skeleton.
    assert.equal(level1.projection.question, pack.question);
    assert.deepEqual(level1.projection.subQueries, pack.subQueries);
    assert.equal(level1.projection.coverage.sourcesRead, 5);
  });

  it("level 2: tighter budget drops LATE sources whole, in order 5,4,3", () => {
    const pack = fivePack();
    const contentsByUrl = Object.fromEntries(
      pack.sources.map((s) => [s.url, s.passages[0].quote]),
    );
    const twoSources = measurePayload({ ...pack, sources: pack.sources.slice(0, 2) });
    const level2 = applyBudget(pack, twoSources + COMPACTION_STAMP_RESERVE, INVESTIGATE_LADDER);
    assert.deepEqual(
      level2.projection.sources.map((s) => s.url),
      ["https://e/s1", "https://e/s2"],
      "late sources drop LAST and in that order",
    );
    assertRoundTrip(level2.projection, contentsByUrl);
    assert.ok(level2.projection.sources[0].passages[0].quote.length > 0);
  });

  it("question/subQueries/coverage survive every level — the never-cut invariant", () => {
    const pack = fivePack();
    for (const budget of [4000, 3000, 2000, 1200, 800, 500, 300, 150]) {
      const { projection } = applyBudget(pack, budget, INVESTIGATE_LADDER);
      assert.equal(projection.question, pack.question, `budget ${budget}: question survives`);
      assert.deepEqual(projection.subQueries, pack.subQueries, `budget ${budget}: subQueries survive`);
      assert.ok(projection.coverage, `budget ${budget}: coverage survives`);
      assert.deepEqual(projection.coverage.unread, [], `budget ${budget}: unread survives`);
      for (const s of projection.sources) {
        assert.ok(s.url, `budget ${budget}: url survives`);
        assert.equal(s.contentSha256, s.contentSha256.toLowerCase());
      }
    }
  });

  it("floor clamp: below-minimum budget yields the floor envelope, never throws", () => {
    const pack = fivePack();
    const floor = applyBudget(pack, 10, INVESTIGATE_LADDER);
    assert.equal(floor.compaction.note, "floor");
    assert.ok(floor.projection.sources.length <= 1, "floor keeps at most the first source");
    assert.equal(floor.projection.question, pack.question);
  });

  it("MUTATION PIN: a sources-before-passages cut order cannot satisfy this fixture", () => {
    // The wrong ladder (drop sources first) on the GENTLE budget loses
    // whole sources where the right ladder trims quotes and keeps all
    // five — the crush-fixture RED for the swapped cut order.
    const pack = fivePack();
    const contentsByUrl = Object.fromEntries(
      pack.sources.map((s) => [s.url, s.passages[0].quote]),
    );
    const full = measurePayload(pack);
    const gentle = Math.floor(full * 0.8);
    const wrongOrder = [
      {
        name: "drop-late-source",
        apply: (envelope) => ({ ...envelope, sources: envelope.sources.slice(0, -1) }),
      },
      {
        name: "trim-passages",
        apply: (envelope) => ({
          ...envelope,
          sources: envelope.sources.map((s) => ({
            ...s,
            passages: s.passages.map((p) => ({ ...p, quote: p.quote.slice(0, 10) })),
          })),
        }),
      },
    ];
    const wrong = applyBudget(pack, gentle, wrongOrder);
    assert.ok(
      wrong.projection.sources.length < 5,
      "the WRONG order visibly drops whole sources at a budget the right ladder survives",
    );
    const right = applyBudget(pack, gentle, INVESTIGATE_LADDER);
    assert.equal(right.projection.sources.length, 5);
    assertRoundTrip(right.projection, contentsByUrl);
  });
});

// ---------------------------------------------------------------------------
// Orchestrator composition: --max-chars → compaction stamp + mirrored
// save + history-show recovery (deps-injected; the budget seam runs
// inside the command like science.ts, so a direct investigate() call
// with maxChars exercises the whole path)
// ---------------------------------------------------------------------------

function makeSearchDescriptor(id, resultsByQuery) {
  const descriptor = {
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
  return descriptor;
}

function makeReaderDescriptor(id, results) {
  return {
    id,
    isConfigured: () => true,
    capabilities: () => new Set(["reader"]),
    create: () => ({
      id,
      reader: {
        fetch: {
          kind: "reader-fetch",
          validate() {},
          cacheIdentity(request) {
            return {
              provider: id,
              capability: "reader",
              operation: "reader-fetch",
              credentialFingerprint: "fp-" + id,
              request,
              legacyCandidates: [],
            };
          },
          decodeCached(value) {
            if (value === null || typeof value !== "object") return null;
            return value;
          },
          async invoke(request) {
            const canned = results[request.url];
            if (canned === undefined) throw new Error("no canned result");
            return {
              schemaVersion: 1,
              url: request.url,
              finalUrl: request.url,
              title: "t",
              content: canned.content,
              contentFormat: "markdown",
            };
          },
        },
      },
    }),
  };
}

/** Two-source grid: s1 then s2 in Fusion order. */
function budgetDeps({ artifactsDir } = {}) {
  // Term-bearing sentences long enough that the assembled pack
  // measures comfortably over the 900-char crush budget.
  const LONG = Array.from(
    { length: 8 },
    (_, i) => `alpha evidence sentence number ${i} ${"detail ".repeat(12)}`,
  ).join(" ");
  const searchDescriptor = makeSearchDescriptor("tavily", {
    alpha: [{ title: "one", url: "https://e/s1", summary: "s" }],
    beta: [{ title: "two", url: "https://e/s2", summary: "s" }],
  });
  const readerDescriptor = makeReaderDescriptor("zai", {
    "https://e/s1": { content: LONG },
    "https://e/s2": { content: LONG },
  });
  const cache = new Map();
  const deps = {
    descriptors: [searchDescriptor, readerDescriptor],
    // Isolated SCOUTLINE_ARTIFACTS_DIR per test (the recorded
    // lock-contention flake class) — the compaction save resolves its
    // artifacts root from THIS env.
    env: artifactsDir !== undefined ? { SCOUTLINE_ARTIFACTS_DIR: artifactsDir } : {},
    configFanout: false,
    cache: {
      async get(key) {
        return cache.has(key) ? cache.get(key) : null;
      },
      async set(key, value) {
        cache.set(key, value);
      },
    },
    sleep: async () => {},
    random: () => 0.5,
    consume: createInMemoryConsumptionSink(),
    now: () => NOW,
    nowWall: () => new Date(NOW),
    loadContextText: async () => {
      throw new Error("no --context here");
    },
    readerCapabilityFor: (d) => d.create({ env: {} }).reader,
  };
  return deps;
}

function makeContext() {
  const notices = [];
  return {
    context: { stdinIsTTY: false, readStdin: async () => "", notice: (m) => notices.push(m) },
    notices,
  };
}

describe("investigate --max-chars — compaction stamp + mirrored save + history-show recovery", () => {
  it("budgeted pack stamps compaction {budget, ref}; full untrimmed pack recoverable via history show", async (t) => {
    await withTempDir(t, async (dir) => {
      const deps = budgetDeps({ artifactsDir: dir });
      const { context, notices } = makeContext();
      const result = await investigate(
        "alpha | beta",
        { provider: "tavily", maxChars: 900 },
        deps,
        context,
      );
      assert.strictEqual(result.kind, "data");
      const data = result.data;
      assert.ok(data.compaction, "compaction stamped in-band");
      assert.strictEqual(data.compaction.budget, 900);
      assert.match(data.compaction.ref, /^\d{8}T\d{6}Z-[0-9a-f]{4}$/);
      // In-band (minus the stamp) fits the budget.
      const { compaction, ...payload } = data;
      void compaction;
      assert.ok(measurePayload(payload) <= 900, `in-band fits: ${measurePayload(payload)} <= 900`);
      // Never cut.
      assert.deepEqual(payload.question, "alpha | beta");
      assert.deepEqual(payload.subQueries, ["alpha", "beta"]);
      // Passages were trimmed before sources dropped: both sources survive.
      assert.strictEqual(payload.sources.length, 2);
      // The saved artifact is the FULL untrimmed pack.
      const { log } = await readLog(dir);
      const entry = log.entries.find((e) => e.command === "investigate");
      assert.ok(entry, "log entry mandatory per compaction artifact");
      assert.ok(!JSON.stringify(entry.args).includes("max-chars"), "presentation-flag-free args");
      const report = await buildHistoryShowReport(log, entry.requestId, async (e) =>
        fs.readFile(path.join(dir, e.masterPath), "utf8"),
      );
      const recovered = report.report.result;
      assert.strictEqual(recovered.sources.length, 2);
      for (const source of recovered.sources) {
        const inBand = payload.sources.find((s) => s.url === source.url);
        assert.ok(
          source.passages[0].quote.length > inBand.passages[0].quote.length,
          "the artifact holds the UNTRIMMED quote (longer than the budgeted one)",
        );
      }
      // The budget notice named the ref.
      assert.ok(
        notices.some((m) => m.includes("output budget: 900 chars") && m.includes(compaction.ref)),
        `expected budget notice, got: ${JSON.stringify(notices)}`,
      );
    });
  });

  it("no --max-chars → no compaction, no artifact writes (zero-diff)", async () => {
    const deps = budgetDeps();
    const result = await investigate(
      "alpha | beta",
      { provider: "tavily" },
      deps,
      makeContext().context,
    );
    assert.strictEqual(result.data.compaction, undefined);
  });

  it("--max-chars 0 / negative / non-integer is VALIDATION_ERROR", async () => {
    const deps = budgetDeps();
    for (const bad of [0, -5, 2.5]) {
      await assert.rejects(
        () => investigate("alpha | beta", { provider: "tavily", maxChars: bad }, deps, makeContext().context),
        (error) => error.code === "VALIDATION_ERROR",
      );
    }
  });
});

// ---------------------------------------------------------------------------
// --save / --save-force (createSaveArtifactHook seam, science.ts
// precedent — the hook is constructed beside the behavior and handed
// the investigate result)
// ---------------------------------------------------------------------------

describe("investigate --save / --save-force", () => {
  it("--save writes the clean report {schemaVersion, requestId, result} + log entry", async (t) => {
    await withTempDir(t, async (dir) => {
      const deps = budgetDeps();
      const { context } = makeContext();
      const result = await investigate("alpha | beta", { provider: "tavily" }, deps, context);
      const saved = [];
    const hook = createSaveArtifactHook(
      {
        save: { request: { format: "json", force: false }, capture: {} },
        env: { SCOUTLINE_ARTIFACTS_DIR: dir },
      },
      {
        command: "investigate",
        args: { provider: "tavily" },
        provider: { mode: "fanout", requested: "tavily", arms: ["tavily"] },
        outputMode: "data",
      },
    );
    await hook({ result, resolvedSecrets: [], now: () => NOW, notice: (m) => saved.push(m) });
    const { log } = await readLog(dir);
    const entry = log.entries.find((e) => e.kind === "save" && e.command === "investigate");
    assert.ok(entry, "save log entry present");
    const master = JSON.parse(await fs.readFile(path.join(dir, entry.masterPath), "utf8"));
    assert.deepEqual([...Object.keys(master)].sort(), ["requestId", "result", "schemaVersion"]);
    assert.strictEqual(master.schemaVersion, 1);
    assert.deepEqual(master.result, result.data);
    });
  });

  it("overwrite without --save-force fails FILE_ERROR; --save-force replaces", async (t) => {
    await withTempDir(t, async (dir) => {
      // The hook's requestId carries a random hex tail, so collision is
      // driven at the seam the hook itself delegates to:
      // writeArtifactWithLogEntry with an EXISTING target refuses
      // (FILE_ERROR) without force and replaces with it — the exact
      // --save / --save-force contract at the artifact store.
      const { writeArtifactWithLogEntry } = await import("../dist/lib/artifacts.js");
      const requestId = "20260920T000000Z-aaaa";
      const content = JSON.stringify({ schemaVersion: 1, requestId, result: {} });
      const entry = {
        kind: "save",
        requestId,
        timestamp: NOW,
        command: "investigate",
        args: {},
        provider: { mode: "single", effective: "tavily" },
        outputFormat: "data",
        artifactFormat: "json",
        cliVersion: "test",
        masterPath: `${requestId}.json`,
      };
      await writeArtifactWithLogEntry(dir, requestId, content, entry);
      const before = await fs.readFile(path.join(dir, entry.masterPath), "utf8");
      // Second write, same requestId, force NOT set → FILE_ERROR.
      await assert.rejects(
        () => writeArtifactWithLogEntry(dir, requestId, content, entry),
        (error) => error instanceof FileError && error.code === "FILE_ERROR",
      );
      assert.strictEqual(
        await fs.readFile(path.join(dir, entry.masterPath), "utf8"),
        before,
        "refusal leaves the master byte-identical",
      );
      // force → replaces through the same atomic path.
      await writeArtifactWithLogEntry(dir, requestId, content, entry, { force: true });
      const { log } = await readLog(dir);
      assert.strictEqual(
        log.entries.filter((e) => e.requestId === requestId).length,
        2,
        "forced replace appends its own log entry",
      );
    });
  });
});
