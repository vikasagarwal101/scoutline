/**
 * T6b — `history list --kind` / `--repeats` + rendered kind column +
 * `history stats` full-vs-marker split (PRD list widening, DESIGN D5).
 *
 * Verifies:
 *   - `--kind save|journal` filters the list envelope (both values
 *     pinned); an invalid value is VALIDATION_ERROR at dispatch.
 *   - Default list SKIPS repeat markers (T2b's ruling held); `--repeats`
 *     opts in — markers render as their own row shape (repeatOf
 *     annotation, no requestId of their own).
 *   - The rendered TEXT table gains a kind column (compact / markdown /
 *     refs / tty all render the table), header + rows aligned.
 *   - `history stats` splits the journal kind into full entries vs
 *     repeat markers (byKind keeps the raw fold; the split is its own
 *     field) — pure builder AND main() envelope pins.
 *   - Red-first markers (mutation evidence): a marker leaking into the
 *     default list, an inverted split, and a kind column dropped from
 *     the header each fail a pin below.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildHistoryListReport,
  buildHistoryStatsReport,
  historyCommand,
} from "../dist/commands/history.js";
import { main } from "../dist/index.js";
import { appendLogEntry, writeArtifact } from "../dist/lib/artifacts.js";
import { runProcess } from "./helpers/run-process.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;
const fixedNow = () => NOW;

function makeTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeAdapter() {
  const stdout = [];
  const stderr = [];
  const adapter = {
    stdoutIsTTY: false,
    stdinIsTTY: false,
    environmentOutputMode: "data",
    readStdin: async () => "",
    writeStdout: (v) => stdout.push(v),
    writeStderr: (v) => stderr.push(v),
    runQuietly: async (op) => op(),
    setExitCode: () => {},
  };
  return { adapter, stdout, stderr };
}

function saveEntry(o = {}) {
  const requestId = o.requestId ?? "20260908T120000Z-0001";
  return {
    kind: "save",
    requestId,
    timestamp: o.timestamp ?? NOW,
    command: o.command ?? "search",
    args: {},
    provider: { mode: "single", effective: "zai" },
    outputFormat: "data",
    artifactFormat: "json",
    cliVersion: "0.0.0-test",
    masterPath: `${requestId}.json`,
    ...o,
  };
}

function fullJournal(requestId, o = {}) {
  return {
    kind: "journal",
    requestId,
    timestamp: o.timestamp ?? NOW,
    capability: o.capability ?? "search",
    provider: { mode: "single", effective: "zai", servedFrom: "live" },
    query: o.query ?? "rust vs go",
    contentHash: "a".repeat(64),
    cacheKey: "v2.search.zai.fp.json",
    skeleton: { results: [{ url: "https://zai/r", title: "t-zai" }] },
    ...o,
  };
}

function marker(repeatOf, o = {}) {
  return {
    kind: "journal",
    timestamp: o.timestamp ?? NOW + 1,
    capability: o.capability ?? "search",
    provider: { mode: "single", effective: "zai", servedFrom: "cache" },
    repeatOf,
    ...o,
  };
}

function historyDeps(adapter, env, extra = {}) {
  return {
    invocation: adapter,
    env,
    loadScoutlineConfig: async () => ({}),
    now: fixedNow,
    ...extra,
  };
}

/** The mixed log every list test folds: 1 save, 1 full journal, 1 marker. */
const MIXED_LOG = {
  version: 1,
  entries: [
    saveEntry({ requestId: "20260908T120000Z-0001" }),
    fullJournal("20260908T120000Z-0002", { capability: "read" }),
    marker("20260908T120000Z-0002"),
  ],
};

const listCommand = (logEntries, listOptions = {}) =>
  historyCommand({
    subcommand: "list",
    readLog: async () => ({ log: { version: 1, entries: logEntries } }),
    readMaster: async () => undefined,
    masterSizeOf: async () => 0,
    notice: () => {},
    now: fixedNow,
    ...listOptions,
  });

// ---------------------------------------------------------------------------
// --kind filter (pure + command)
// ---------------------------------------------------------------------------

describe("T6b: history list --kind", () => {
  it("--kind save keeps only save entries", async () => {
    const report = buildHistoryListReport(MIXED_LOG, { now: fixedNow, kind: "save" });
    assert.deepStrictEqual(
      report.entries.map((e) => e.requestId),
      ["20260908T120000Z-0001"],
    );
    assert.strictEqual(report.entries[0].kind, "save");
    assert.strictEqual(report.total, 1);
  });

  it("--kind journal keeps full journal entries (markers still skipped — they are not rows)", async () => {
    const report = buildHistoryListReport(MIXED_LOG, { now: fixedNow, kind: "journal" });
    assert.deepStrictEqual(
      report.entries.map((e) => e.requestId),
      ["20260908T120000Z-0002"],
    );
    assert.strictEqual(report.entries[0].kind, "journal");
    assert.strictEqual(report.total, 1);
  });

  it("--kind journal + --repeats lists the marker row too (filters compose)", async () => {
    const report = buildHistoryListReport(MIXED_LOG, {
      now: fixedNow,
      kind: "journal",
      repeats: true,
    });
    // Marker has no requestId of its own: newest-first order puts the
    // marker (NOW+1) before the full entry.
    assert.deepStrictEqual(
      report.entries.map((e) => e.requestId),
      [undefined, "20260908T120000Z-0002"],
    );
    assert.strictEqual(report.total, 2);
  });

  it("--kind save + --repeats stays save-only (no marker leak)", async () => {
    const report = buildHistoryListReport(MIXED_LOG, {
      now: fixedNow,
      kind: "save",
      repeats: true,
    });
    assert.deepStrictEqual(
      report.entries.map((e) => e.requestId),
      ["20260908T120000Z-0001"],
    );
  });
});

// ---------------------------------------------------------------------------
// --repeats opt-in (marker rows, own shape)
// ---------------------------------------------------------------------------

describe("T6b: history list --repeats", () => {
  it("default list still skips markers (T2b ruling held through T6b)", async () => {
    const result = await listCommand(MIXED_LOG.entries);
    assert.strictEqual(result.data.total, 2);
    assert.ok(
      result.data.entries.every((e) => e.requestId !== undefined),
      "no marker rows without --repeats",
    );
  });

  it("--repeats includes the marker as its own row shape: repeatOf annotation, no requestId, full entry does not double-list", async () => {
    const result = await listCommand(MIXED_LOG.entries, { repeats: true });
    assert.strictEqual(result.data.total, 3);
    const rows = result.data.entries;
    // Marker row: NO requestId key at all (not "" — absent), repeatOf named.
    const markerRow = rows.find((e) => e.kind === "journal" && e.repeatOf !== undefined);
    assert.ok(markerRow, "marker row present under --repeats");
    assert.ok(!("requestId" in markerRow), "marker row carries no requestId");
    assert.strictEqual(markerRow.repeatOf, "20260908T120000Z-0002");
    // Full entry + save unchanged alongside it.
    assert.deepStrictEqual(
      rows.filter((e) => e.requestId !== undefined).map((e) => e.requestId),
      ["20260908T120000Z-0002", "20260908T120000Z-0001"],
    );
  });

  it("--repeats renders the marker distinctly in text: repeatOf shown, table coherent (cells at header column offsets)", async () => {
    const result = await listCommand(MIXED_LOG.entries, { repeats: true });
    const lines = result.presentations.compact.split("\n");
    assert.strictEqual(lines.length, 5, "header + 3 rows");
    // Coherence by OFFSET, not whitespace-split: an exactly-full cell
    // pads to width+1 (single-space separator) by design — the pinned
    // separator invariant — so every row keeps the header's column
    // starts instead of a uniform gap count.
    const header = lines[1];
    const offsets = ["requestId", "saved (UTC)", "command", "format", "kind", "provider"].map(
      (label) => header.indexOf(label),
    );
    for (const row of lines.slice(2)) {
      const cells = offsets.map((at, i) => row.slice(at, offsets[i + 1] ?? undefined).trim());
      assert.ok(
        cells.every((c) => c.length > 0),
        `row fills every column: ${JSON.stringify({ header, row, cells })}`,
      );
    }
    const markerLine = lines.find((l) => l.includes("(repeat"));
    assert.ok(markerLine, `marker row annotated: ${lines.join("\n")}`);
    assert.ok(markerLine.includes("20260908T120000Z-0002"), "annotation names repeatOf id");
    assert.ok(!markerLine.includes("20260908T120000Z-0001"), "annotation is not the save id");
  });
});

// ---------------------------------------------------------------------------
// Rendered kind column (all text modes)
// ---------------------------------------------------------------------------

describe("T6b: rendered kind column", () => {
  const TEXT_MODES = ["compact", "markdown", "refs", "tty"];

  it("every text presentation renders the table WITH a kind header column", async () => {
    const result = await listCommand([saveEntry({ requestId: "20260908T120000Z-0001" })]);
    for (const mode of TEXT_MODES) {
      const text = result.presentations[mode];
      assert.ok(typeof text === "string" && text.length > 0, `${mode} renders`);
      const header = text.split("\n")[1];
      assert.ok(
        /\bkind\b/.test(header),
        `${mode} header carries the kind column: ${JSON.stringify(header)}`,
      );
    }
  });

  it("each row renders its kind: save row says save, journal row says journal (aligned after format)", async () => {
    const result = await listCommand(MIXED_LOG.entries);
    const lines = result.presentations.compact.split("\n");
    const header = lines[1];
    const kindAt = header.indexOf("kind");
    assert.ok(kindAt > 0, "kind column positioned after earlier columns");
    const saveRow = lines.find((l) => l.startsWith("20260908T120000Z-0001"));
    const journalRow = lines.find((l) => l.startsWith("20260908T120000Z-0002"));
    assert.ok(saveRow.slice(kindAt).startsWith("save"), `save row: ${saveRow}`);
    assert.ok(journalRow.slice(kindAt).startsWith("journal"), `journal row: ${journalRow}`);
  });

  it("marker row (under --repeats) renders kind journal too — the kind column covers every row shape", async () => {
    const result = await listCommand(MIXED_LOG.entries, { repeats: true });
    const lines = result.presentations.compact.split("\n");
    const kindAt = lines[1].indexOf("kind");
    const markerLine = lines.find((l) => l.includes("(repeat"));
    assert.ok(markerLine.slice(kindAt).startsWith("journal"), `marker row kind: ${markerLine}`);
  });
});

// ---------------------------------------------------------------------------
// stats full-vs-marker split
// ---------------------------------------------------------------------------

describe("T6b: history stats journal full-vs-marker split", () => {
  it("pure builder: journal kind splits into full and marker counts; byKind keeps the raw fold", async () => {
    const report = await buildHistoryStatsReport(MIXED_LOG, async () => 0, fixedNow);
    assert.deepStrictEqual(report.byKind, { save: 1, journal: 2 }, "raw byKind unchanged");
    assert.strictEqual(report.journalSplit.full, 1);
    assert.strictEqual(report.journalSplit.marker, 1);
    // Sum invariant: split parts reconstruct the journal byKind count.
    assert.strictEqual(report.journalSplit.full + report.journalSplit.marker, report.byKind.journal);
  });

  it("no journal rows → no split (absent keys, not zeros)", async () => {
    const report = await buildHistoryStatsReport(
      { version: 1, entries: [saveEntry()] },
      async () => 0,
      fixedNow,
    );
    assert.ok(!("journalSplit" in report), "journalSplit absent on a save-only store");
  });

  it("main() envelope carries the split over a real mixed store", async () => {
    const dir = makeTempDir("scoutline-t6b-stats-");
    const { adapter, stdout, stderr } = makeAdapter();
    try {
      // Save entry through the production writer; journal entries written
      // raw (the writer seam needs a Provider run — shape is what stats folds).
      await writeArtifact(
        dir,
        "20260908T120000Z-0001",
        JSON.stringify({ schemaVersion: 1, result: [] }),
        { format: "json" },
      );
      await appendLogEntry(dir, saveEntry({ requestId: "20260908T120000Z-0001" }), {
        timeoutMs: 50,
        staleMs: 50,
      });
      await appendLogEntry(dir, fullJournal("20260908T120000Z-0002", { capability: "read" }), {
        timeoutMs: 50,
        staleMs: 50,
      });
      await appendLogEntry(dir, marker("20260908T120000Z-0002"), { timeoutMs: 50, staleMs: 50 });
      const status = await main(["history", "stats"], historyDeps(adapter, { SCOUTLINE_ARTIFACTS_DIR: dir }));
      assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
      const envelope = JSON.parse(stdout[0]);
      assert.strictEqual(envelope.total, 3);
      assert.strictEqual(envelope.journalSplit.full, 1);
      assert.strictEqual(envelope.journalSplit.marker, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rendered stats text surfaces the split line", async () => {
    const result = await historyCommand({
      subcommand: "stats",
      readLog: async () => ({ log: MIXED_LOG }),
      readMaster: async () => undefined,
      masterSizeOf: async () => 0,
      notice: () => {},
      now: fixedNow,
    });
    assert.ok(
      /journal:\s*1 full, 1 marker/.test(result.presentations.compact),
      `stats text carries the split: ${result.presentations.compact}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Dispatch: flag plumbing through main()
// ---------------------------------------------------------------------------

describe("T6b: main() flag dispatch", () => {
  const store = async () => {
    const dir = makeTempDir("scoutline-t6b-dispatch-");
    await appendLogEntry(dir, saveEntry({ requestId: "20260908T120000Z-0001" }), { timeoutMs: 50, staleMs: 50 });
    await appendLogEntry(dir, fullJournal("20260908T120000Z-0002"), { timeoutMs: 50, staleMs: 50 });
    await appendLogEntry(dir, marker("20260908T120000Z-0002"), { timeoutMs: 50, staleMs: 50 });
    return dir;
  };

  it("history list --kind journal filters through main() (markers still skipped)", async () => {
    const dir = await store();
    const { adapter, stdout, stderr } = makeAdapter();
    try {
      const status = await main(
        ["history", "list", "--kind", "journal"],
        historyDeps(adapter, { SCOUTLINE_ARTIFACTS_DIR: dir }),
      );
      assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
      const report = JSON.parse(stdout[0]);
      assert.deepStrictEqual(report.entries.map((e) => e.requestId), ["20260908T120000Z-0002"]);
      assert.strictEqual(report.entries[0].kind, "journal");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("history list --kind save filters through main()", async () => {
    const dir = await store();
    const { adapter, stdout, stderr } = makeAdapter();
    try {
      const status = await main(
        ["history", "list", "--kind", "save"],
        historyDeps(adapter, { SCOUTLINE_ARTIFACTS_DIR: dir }),
      );
      assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
      const report = JSON.parse(stdout[0]);
      assert.deepStrictEqual(report.entries.map((e) => e.requestId), ["20260908T120000Z-0001"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("invalid --kind value is VALIDATION_ERROR (both save/journal pinned, trash rejected)", async () => {
    for (const value of ["trash", "Save", ""]) {
      const { adapter, stderr } = makeAdapter();
      const status = await main(
        ["history", "list", "--kind", value],
        historyDeps(adapter, {}),
      );
      assert.strictEqual(status, 1, `--kind "${value}" must be rejected`);
      assert.strictEqual(JSON.parse(stderr.at(-1)).code, "VALIDATION_ERROR");
    }
  });

  it("valueless --kind is VALIDATION_ERROR", async () => {
    const { adapter, stderr } = makeAdapter();
    const status = await main(["history", "list", "--kind"], historyDeps(adapter, {}));
    assert.strictEqual(status, 1);
    assert.strictEqual(JSON.parse(stderr.at(-1)).code, "VALIDATION_ERROR");
  });

  it("history list --repeats flows through main(): marker row appears with repeatOf", async () => {
    const dir = await store();
    const { adapter, stdout, stderr } = makeAdapter();
    try {
      const status = await main(
        ["history", "list", "--repeats"],
        historyDeps(adapter, { SCOUTLINE_ARTIFACTS_DIR: dir }),
      );
      assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
      const report = JSON.parse(stdout[0]);
      assert.strictEqual(report.total, 3);
      const markerRow = report.entries.find((e) => e.repeatOf !== undefined);
      assert.ok(markerRow, "marker row in the envelope under --repeats");
      assert.strictEqual(markerRow.repeatOf, "20260908T120000Z-0002");
      assert.ok(!("requestId" in markerRow), "marker row carries no requestId");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--kind and --repeats compose through main()", async () => {
    const dir = await store();
    const { adapter, stdout, stderr } = makeAdapter();
    try {
      const status = await main(
        ["history", "list", "--kind", "journal", "--repeats"],
        historyDeps(adapter, { SCOUTLINE_ARTIFACTS_DIR: dir }),
      );
      assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
      const report = JSON.parse(stdout[0]);
      assert.strictEqual(report.total, 2);
      assert.ok(report.entries.some((e) => e.repeatOf !== undefined));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// CLI surface (subprocess) — the flag really ships on the bin
// ---------------------------------------------------------------------------

describe("T6b: CLI surface", () => {
  it("scoutline history list --kind / --repeats over the real bin", async () => {
    const dir = makeTempDir("scoutline-t6b-cli-");
    const configDir = makeTempDir("scoutline-t6b-cli-cfg-");
    try {
      await appendLogEntry(dir, fullJournal("20260908T120000Z-0002"), { timeoutMs: 50, staleMs: 50 });
      await appendLogEntry(dir, marker("20260908T120000Z-0002"), { timeoutMs: 50, staleMs: 50 });
      {
        const result = await runProcess(
          ["history", "list", "--kind", "journal"],
          { configDir, env: { SCOUTLINE_ARTIFACTS_DIR: dir } },
        );
        assert.strictEqual(result.code, 0, `stderr=${result.stderr}`);
        const report = JSON.parse(result.stdout);
        assert.deepStrictEqual(report.entries.map((e) => e.requestId), ["20260908T120000Z-0002"]);
      }
      {
        const result = await runProcess(
          ["history", "list", "--kind", "bogus"],
          { configDir, env: { SCOUTLINE_ARTIFACTS_DIR: dir } },
        );
        assert.strictEqual(result.code, 1);
        assert.strictEqual(JSON.parse(result.stderr.trim().split("\n").at(-1)).code, "VALIDATION_ERROR");
      }
      {
        const result = await runProcess(
          ["history", "list", "--repeats"],
          { configDir, env: { SCOUTLINE_ARTIFACTS_DIR: dir } },
        );
        assert.strictEqual(result.code, 0, `stderr=${result.stderr}`);
        const report = JSON.parse(result.stdout);
        assert.strictEqual(report.total, 2);
        assert.ok(report.entries.some((e) => e.repeatOf !== undefined));
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});
