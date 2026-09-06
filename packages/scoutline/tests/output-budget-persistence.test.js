/**
 * Output Budget persistence tests (ADR-0007, lane T2).
 *
 * Pins:
 *   - When compaction fires, the FULL untrimmed envelope is written via
 *     writeArtifact under an isolated SCOUTLINE_ARTIFACTS_DIR; the
 *     master's result equals the (already-redacted) envelope verbatim —
 *     the cardinal pin: the artifact is exactly what an unbudgeted run
 *     would print, post-redaction, pre-compaction.
 *   - Master shape mirrors the save seam: {schemaVersion:1, requestId,
 *     result} (createSaveArtifactHook's json report shape).
 *   - A SaveLogEntry (kind "save") accompanies every artifact — history
 *     show recovers it offline (the log is the listing truth).
 *   - compaction.ref points at the artifact (requestId form).
 *   - Budget that does NOT fire → NO artifact write, NO log entry (the
 *     function resolves undefined; the store dir has no files).
 *   - The log entry's args is the caller's allow-list verbatim and the
 *     entry field set stays the pinned SaveLogEntry shape (no
 *     --max-chars can leak in via this layer: it writes what it is
 *     given, and compaction facts live in the payload, never the log).
 *
 * Hermeticity: every path lives inside a withTempDir tmp dir passed as
 * SCOUTLINE_ARTIFACTS_DIR; injected clock + randomBytes; nothing reads
 * process.env; nothing touches ~/.scoutline.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { readFileSync } from "node:fs";

import { applyBudget, measurePayload } from "../dist/lib/output-budget.js";
import {
  persistCompaction,
  BUDGET_REPORT_SCHEMA_VERSION,
} from "../dist/lib/output-budget-persistence.js";
import { readLog } from "../dist/lib/artifacts.js";
import { buildHistoryShowReport } from "../dist/commands/history.js";
import { withTempDir } from "./helpers/temp-dir.js";

const PKG_VERSION = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;

// Fixed clock — injected, never Date.now() (repo time-bomb rule).
const NOW = 1_800_000_000_000;
const fixedNow = () => NOW;

/** Deterministic randomBytes double (artifacts-store.test.js idiom). */
function byteStream(seed) {
  let n = seed & 0xff;
  return (size) => {
    const out = new Uint8Array(size);
    for (let i = 0; i < size; i += 1) {
      n = (n * 31 + 7) & 0xff;
      out[i] = n;
    }
    return out;
  };
}

const TRIMMED = 4;
const trimSummaries = {
  name: "trim-summaries",
  apply: (p) => ({
    ...p,
    results: p.results.map((r) =>
      r.summary.length > TRIMMED ? { ...r, summary: r.summary.slice(0, TRIMMED) } : r,
    ),
  }),
};
const dropLowestRank = {
  name: "drop-lowest-rank",
  apply: (p) => (p.results.length > 1 ? { ...p, results: p.results.slice(0, -1) } : p),
};
const LADDER = [trimSummaries, dropLowestRank];

function makeEnvelope(itemCount, summaryLen = 40) {
  return {
    query: "q",
    results: Array.from({ length: itemCount }, (_, i) => ({
      url: `https://example.com/r${i + 1}`,
      title: `Result ${i + 1}`,
      summary: "s".repeat(summaryLen),
    })),
  };
}

const META = {
  command: "search",
  args: { provider: "tavily", limit: 10 },
  provider: { mode: "single", requested: "tavily", effective: "tavily" },
  outputFormat: "data",
};

function persistenceOptions(dir) {
  return {
    env: { SCOUTLINE_ARTIFACTS_DIR: dir },
    now: fixedNow,
    randomBytes: byteStream(5),
  };
}

/** The full flow T3+ will compose: applyBudget → persistCompaction when fired. */
async function budgetRun(dir, envelope, budget) {
  const outcome = applyBudget(envelope, budget, LADDER);
  if (outcome.compaction === undefined) return outcome;
  const compaction = await persistCompaction(
    envelope,
    outcome.compaction,
    META,
    persistenceOptions(dir),
  );
  return { projection: outcome.projection, compaction };
}

describe("persistCompaction — fires", () => {
  it("writes the FULL untrimmed envelope via writeArtifact; master result == the unbudgeted payload (cardinal pin)", async (t) => {
    await withTempDir(t, async (dir) => {
      // Envelope pre-redacted by the caller (the save-seam contract): a
      // live-looking credential already swapped for the redaction marker.
      const envelope = makeEnvelope(3);
      const outcome = await budgetRun(dir, envelope, measurePayload(makeEnvelope(2, TRIMMED)));

      assert.ok(outcome.compaction, "compaction must fire at this budget");
      const ref = outcome.compaction.ref;
      assert.ok(typeof ref === "string" && ref.length > 0, "compaction.ref is a requestId");

      const files = await fs.readdir(dir);
      const masters = files.filter((f) => f !== "index.json");
      assert.equal(masters.length, 1, "exactly one master artifact");
      assert.equal(masters[0], `${ref}.json`, "master filename is <requestId>.json");

      const master = JSON.parse(await fs.readFile(path.join(dir, masters[0]), "utf8"));
      assert.equal(master.schemaVersion, BUDGET_REPORT_SCHEMA_VERSION);
      assert.equal(master.schemaVersion, 1, "schemaVersion is 1 — the save hook's REPORT_SCHEMA_VERSION namespace");
      assert.equal(master.requestId, ref);
      assert.deepEqual(master.result, envelope, "CARDINAL: artifact result is the FULL untrimmed envelope, not the projection");
      assert.notDeepEqual(master.result, outcome.projection);
    });
  });

  it("carries the post-redaction payload verbatim — no further rewriting at this layer", async (t) => {
    await withTempDir(t, async (dir) => {
      // Caller's redacted envelope mirrors what the save hook stores:
      // redactSecrets(result.data, resolvedSecrets) output.
      const redacted = { query: "token=REDACTED", results: [{ url: "https://e.com/1", title: "T", summary: "s".repeat(40) }] };
      const outcome = await budgetRun(dir, redacted, 50);
      const master = JSON.parse(await fs.readFile(path.join(dir, `${outcome.compaction.ref}.json`), "utf8"));
      assert.deepEqual(master.result, redacted, "persistence stores the redacted value byte-for-value");
      assert.equal(master.result.query, "token=REDACTED");
    });
  });

  it("stamps compaction.ref = master requestId and returns the enriched compaction (budget/note preserved)", async (t) => {
    await withTempDir(t, async (dir) => {
      const envelope = makeEnvelope(3);
      const outcome = applyBudget(envelope, 10, LADDER);
      assert.equal(outcome.compaction.note, "floor");
      const compaction = await persistCompaction(envelope, outcome.compaction, META, persistenceOptions(dir));
      assert.deepEqual(compaction, { budget: 10, note: "floor", ref: compaction.ref });
      assert.ok(compaction.ref.startsWith("20270115T080000Z-"), "requestId timestamp comes from the injected now");
    });
  });

  it("appends a kind:'save' log entry with the pinned SaveLogEntry field set — args stay the caller's allow-list", async (t) => {
    await withTempDir(t, async (dir) => {
      const outcome = await budgetRun(dir, makeEnvelope(3), measurePayload(makeEnvelope(2, TRIMMED)));
      const { log, notice } = await readLog(dir);
      assert.equal(notice, undefined);
      assert.equal(log.entries.length, 1);
      const entry = log.entries[0];
      assert.deepStrictEqual(
        Object.keys(entry).sort(),
        [
          "args", "artifactFormat", "cliVersion", "command", "kind",
          "masterPath", "outputFormat", "provider", "requestId", "timestamp",
        ],
        "log entry field set is the pinned SaveLogEntry shape",
      );
      assert.equal(entry.kind, "save");
      assert.equal(entry.requestId, outcome.compaction.ref);
      assert.equal(entry.timestamp, NOW);
      assert.equal(entry.command, "search");
      assert.deepEqual(entry.args, META.args);
      assert.equal(entry.masterPath, `${outcome.compaction.ref}.json`);
      assert.equal(entry.cliVersion, PKG_VERSION);
    });
  });

  it("history show <requestId> recovers the artifact offline — the log entry is MANDATORY", async (t) => {
    await withTempDir(t, async (dir) => {
      const envelope = makeEnvelope(3);
      const outcome = await budgetRun(dir, envelope, measurePayload(makeEnvelope(2, TRIMMED)));

      const { log } = await readLog(dir);
      const report = await buildHistoryShowReport(log, outcome.compaction.ref, async (e) =>
        fs.readFile(path.join(dir, e.masterPath), "utf8"),
      );
      assert.equal(report.entry.requestId, outcome.compaction.ref);
      assert.equal(report.report.schemaVersion, 1);
      assert.deepEqual(report.report.result, envelope, "offline recovery returns the full untrimmed envelope");
    });
  });
});

describe("persistCompaction — does NOT fire", () => {
  it("no compaction → NO artifact write, NO log entry (budgetRun resolves undefined compaction)", async (t) => {
    await withTempDir(t, async (dir) => {
      const envelope = makeEnvelope(3);
      const outcome = await budgetRun(dir, envelope, measurePayload(envelope) + 100);
      assert.equal(outcome.compaction, undefined);
      assert.equal(outcome.projection, envelope, "fits → returned by reference");

      // The store dir stays empty: no master, no index.json.
      const files = await fs.readdir(dir);
      assert.deepEqual(files, [], "no gratuitous side effects — nothing written");
    });
  });
});

describe("PR #103 fix-round — corrupt-log notice propagation", () => {
  it("persistCompaction forwards appendLogEntry's corrupt-index warning via onNotice", async (t) => {
    await withTempDir(t, async (dir) => {
      // Seed a CORRUPT index.json; the append must reset it and report.
      await fs.writeFile(path.join(dir, "index.json"), "{not valid json", "utf8");
      const notices = [];
      const compaction = await persistCompaction(
        makeEnvelope(1),
        { budget: 5, note: "floor" },
        META,
        { ...persistenceOptions(dir), onNotice: (m) => notices.push(m) },
      );
      assert.ok(compaction.ref, "ref still stamped");
      assert.ok(
        notices.some((m) => /corrupt/i.test(m)),
        `corrupt reset notice propagated, got: ${JSON.stringify(notices)}`,
      );
      // And the reset log survives with the new entry.
      const { log } = await readLog(dir);
      assert.equal(log.entries.length, 1);
    });
  });
});

describe("PR #103 R2 — requestId collision retry", () => {
  it("persists under an id collision instead of failing the invocation", async (t) => {
    await withTempDir(t, async (dir) => {
      // First write reserves the id the second persistCompaction call
      // will "choose" — force collision by seeding the store.
      const first = await persistCompaction(makeEnvelope(1), { budget: 5, note: "floor" }, META, persistenceOptions(dir));
      assert.ok(first.ref);
      const { writeFileSync } = await import("node:fs");
      writeFileSync(path.join(dir, `${first.ref}.json`), "occupied");
      const seen = [];
      const second = await persistCompaction(
        makeEnvelope(1),
        { budget: 5, note: "floor" },
        META,
        { ...persistenceOptions(dir), onNotice: (m) => seen.push(m) },
      );
      assert.ok(second.ref, "ref still produced despite the occupied id");
      assert.notEqual(second.ref, first.ref, "fresh id chosen on refusal");
    });
  });
});
