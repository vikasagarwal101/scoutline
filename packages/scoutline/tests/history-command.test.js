/**
 * history command — `scoutline history list|show|stats` over the
 * saved-artifact metadata log (save-artifacts plan, Ticket 5).
 *
 * Verifies:
 *   - Pure aggregation: list (newest-first, --since/--limit/--command),
 *     show (log entry + master joined by requestId; unknown id and
 *     missing master are FILE_ERROR), stats (counts + bytes + span).
 *   - Orphan rule: a master file with no log entry is invisible.
 *   - Fail-open: missing artifacts dir and corrupt index.json both exit 0
 *     with empty data; the corrupt case surfaces a stderr notice.
 *   - Credential-free early dispatch through main() with hermetic deps.
 *   - Bare `history` prints help (exit 0); unknown subcommand is
 *     VALIDATION_ERROR (exit 1).
 *   - The CLI surface via subprocess against isolated config + artifacts
 *     dirs.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildHistoryListReport,
  buildHistoryStatsReport,
  buildHistoryShowReport,
  HISTORY_HELP,
} from "../dist/commands/history.js";
import { main } from "../dist/index.js";
import { appendLogEntry, writeArtifact } from "../dist/lib/artifacts.js";
import { runProcess } from "./helpers/run-process.js";

const DAY = 24 * 60 * 60 * 1000;
// Fixed clock (numeric instant — no calendar-date fixture, so nothing ages).
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

/** SaveLogEntry fixture with sane derivable defaults. */
function entry(o = {}) {
  const { exportPath, ...rest } = o;
  const requestId = rest.requestId ?? "20260829T120000Z-0001";
  return {
    kind: "save",
    requestId,
    timestamp: NOW,
    command: "search",
    args: {},
    provider: { mode: "single", effective: "zai" },
    outputFormat: "data",
    artifactFormat: "json",
    cliVersion: "0.0.0-test",
    masterPath: `${requestId}.json`,
    ...(exportPath !== undefined ? { exportPath } : {}),
    ...rest,
  };
}

/** Build a real store in a temp dir: masters + log via the production lib. */
async function makeStore(dir, entries) {
  for (const e of entries) {
    await writeArtifact(dir, e.requestId, JSON.stringify({ schemaVersion: 1, requestId: e.requestId, result: [{ ok: e.requestId }] }), { format: e.artifactFormat });
    await appendLogEntry(dir, e, { timeoutMs: 50, staleMs: 50 });
  }
}

function historyDeps(adapter, env, extra = {}) {
  // Minimal hermetic MainDependencies shape for the credential-free
  // history path: no providerDescriptors, no config loader (empty env +
  // injected empty config keep the run away from ~/.scoutline).
  return {
    invocation: adapter,
    env,
    loadScoutlineConfig: async () => ({}),
    now: fixedNow,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Pure aggregation
// ---------------------------------------------------------------------------

describe("history: buildHistoryListReport (pure)", () => {
  const log = {
    version: 1,
    entries: [
      entry({ requestId: "20260829T100000Z-0001", timestamp: NOW - 2 * DAY }),
      entry({ requestId: "20260829T140000Z-0002", timestamp: NOW }),
      entry({ requestId: "20260829T120000Z-0003", timestamp: NOW - 5 * DAY, command: "read" }),
    ],
  };

  it("lists newest first (timestamp desc, requestId desc on ties)", () => {
    const report = buildHistoryListReport(log, { now: fixedNow });
    assert.deepStrictEqual(
      report.entries.map((e) => e.requestId),
      ["20260829T140000Z-0002", "20260829T100000Z-0001", "20260829T120000Z-0003"],
    );
  });

  it("ties on timestamp break by requestId descending (deterministic order)", () => {
    const tied = {
      version: 1,
      entries: [
        entry({ requestId: "20260829T140000Z-aaaa", timestamp: NOW }),
        entry({ requestId: "20260829T140000Z-bbbb", timestamp: NOW }),
      ],
    };
    const report = buildHistoryListReport(tied, { now: fixedNow });
    assert.deepStrictEqual(
      report.entries.map((e) => e.requestId),
      ["20260829T140000Z-bbbb", "20260829T140000Z-aaaa"],
    );
  });

  it("rows carry exactly the inventory fields (exportPath only when present)", () => {
    const withExport = {
      version: 1,
      entries: [entry({ requestId: "20260829T140000Z-x", exportPath: "/tmp/r.json" })],
    };
    const report = buildHistoryListReport(log, { now: fixedNow });
    for (const row of report.entries) {
      assert.deepStrictEqual(
        [...Object.keys(row)].sort(),
        ["artifactFormat", "command", "kind", "provider", "requestId", "timestamp"],
      );
    }
    const exported = buildHistoryListReport(withExport, { now: fixedNow });
    assert.deepStrictEqual(
      [...Object.keys(exported.entries[0])].sort(),
      ["artifactFormat", "command", "exportPath", "kind", "provider", "requestId", "timestamp"],
    );
  });

  it("--limit slices after ordering", () => {
    const report = buildHistoryListReport(log, { now: fixedNow, limit: 2 });
    assert.deepStrictEqual(
      report.entries.map((e) => e.requestId),
      ["20260829T140000Z-0002", "20260829T100000Z-0001"],
    );
    assert.strictEqual(report.total, 3, "total counts pre-slice matches");
  });

  it("--command filters", () => {
    const report = buildHistoryListReport(log, { now: fixedNow, command: "read" });
    assert.deepStrictEqual(report.entries.map((e) => e.command), ["read"]);
  });

  it("--since N keeps the last N days inclusive of today (usage --days semantics)", () => {
    const stale = {
      version: 1,
      entries: [
        entry({ requestId: "20260829T090000Z-old", timestamp: NOW - 7 * DAY }),
        entry({ requestId: "20260829T100000Z-edge", timestamp: NOW - 6 * DAY }),
        entry({ requestId: "20260829T110000Z-new", timestamp: NOW - DAY }),
      ],
    };
    const report = buildHistoryListReport(stale, { now: fixedNow, sinceDays: 7 });
    // Edge (exactly 6 days back = day 7 of a 7-day window) stays; one day
    // older does not.
    assert.deepStrictEqual(
      report.entries.map((e) => e.requestId),
      ["20260829T110000Z-new", "20260829T100000Z-edge"],
    );
  });

  it("cold-review f2: --since windows are whole UTC days — early-yesterday survives --since 2, and --since 1 keeps all of today", () => {
    const midnight = new Date(NOW);
    midnight.setUTCHours(0, 0, 0, 0);
    const earlyYesterday = midnight.getTime() - 6 * 3600 * 1000; // 18:00 UTC yesterday
    const midToday = midnight.getTime() + 3600 * 1000; // 01:00 UTC today
    const log = {
      version: 1,
      entries: [
        entry({ requestId: "20260829T180000Z-early", timestamp: earlyYesterday }),
        entry({ requestId: "20260829T010000Z-today", timestamp: midToday }),
        entry({ requestId: "20260829T120000Z-now", timestamp: NOW }),
      ],
    };
    // --since 1 = the whole of today, not just entries after `now` (a
    // rolling cutoff would drop early-today entries; day-aligned keeps them).
    assert.deepStrictEqual(
      buildHistoryListReport(log, { now: fixedNow, sinceDays: 1 }).entries.map((e) => e.requestId),
      ["20260829T120000Z-now", "20260829T010000Z-today"],
    );
    // --since 2 = all of yesterday plus today — including yesterday-early.
    assert.deepStrictEqual(
      buildHistoryListReport(log, { now: fixedNow, sinceDays: 2 }).entries.map((e) => e.requestId),
      ["20260829T120000Z-now", "20260829T010000Z-today", "20260829T180000Z-early"],
    );
  });
});

describe("history: buildHistoryShowReport (pure)", () => {
  const e = entry({ requestId: "20260829T140000Z-0002" });
  const log = { version: 1, entries: [e] };

  it("joins the log entry with the parsed json master", async () => {
    const report = await buildHistoryShowReport(log, e.requestId, async (path) =>
      JSON.stringify({ schemaVersion: 1, requestId: e.requestId, result: [{ ok: true }] }),
    );
    assert.deepStrictEqual(report.entry, e);
    assert.deepStrictEqual(report.report, {
      schemaVersion: 1,
      requestId: e.requestId,
      result: [{ ok: true }],
    });
  });

  it("markdown masters surface as { markdown } rather than parsed JSON", async () => {
    const md = entry({ requestId: "20260829T140000Z-0009", artifactFormat: "markdown", masterPath: "20260829T140000Z-0009.md" });
    const report = await buildHistoryShowReport({ version: 1, entries: [md] }, md.requestId, async () =>
      `<!-- scoutline artifact requestId=${md.requestId} schemaVersion=1 -->\n# body`,
    );
    assert.strictEqual(report.report.markdown, `<!-- scoutline artifact requestId=${md.requestId} schemaVersion=1 -->\n# body`);
  });

  it("unknown requestId is FILE_ERROR", async () => {
    await assert.rejects(
      () => buildHistoryShowReport(log, "20990101T000000Z-nope", async () => "x"),
      (error) => error.code === "FILE_ERROR" && /no artifact with requestId/.test(error.message),
    );
  });

  it("missing master with a live entry is FILE_ERROR naming the master path", async () => {
    await assert.rejects(
      () => buildHistoryShowReport(log, e.requestId, async () => undefined),
      (error) =>
        error.code === "FILE_ERROR" &&
        error.message.includes(e.masterPath),
    );
  });

  it("a corrupt json master is FILE_ERROR (corrupt artifact), not a crash", async () => {
    await assert.rejects(
      () => buildHistoryShowReport(log, e.requestId, async () => "{not json"),
      (error) => error.code === "FILE_ERROR",
    );
  });
});

describe("history: buildHistoryStatsReport (pure)", () => {
  it("aggregates counts, master bytes, and the timestamp span", async () => {
    const log = {
      version: 1,
      entries: [
        entry({ requestId: "20260829T100000Z-0001", timestamp: NOW - 2 * DAY }),
        entry({ requestId: "20260829T140000Z-0002", timestamp: NOW, command: "read", artifactFormat: "markdown", masterPath: "20260829T140000Z-0002.md" }),
      ],
    };
    const report = await buildHistoryStatsReport(
      log,
      async (e) => (e.requestId.endsWith("0001") ? 10 : 32),
      fixedNow,
    );
    assert.strictEqual(report.total, 2);
    assert.deepStrictEqual(report.byCommand, { search: 1, read: 1 });
    assert.deepStrictEqual(report.byArtifactFormat, { json: 1, markdown: 1 });
    assert.deepStrictEqual(report.byKind, { save: 2 });
    assert.strictEqual(report.masterBytes, 42);
    assert.strictEqual(report.oldest, NOW - 2 * DAY);
    assert.strictEqual(report.newest, NOW);
  });

  it("an empty log is zeros with no span keys, never a throw", async () => {
    const report = await buildHistoryStatsReport({ version: 1, entries: [] }, async () => 0, fixedNow);
    assert.strictEqual(report.total, 0);
    assert.deepStrictEqual(report.byCommand, {});
    assert.strictEqual(report.masterBytes, 0);
    assert.ok(!("oldest" in report), "no oldest on empty");
    assert.ok(!("newest" in report), "no newest on empty");
  });
});

// ---------------------------------------------------------------------------
// Dispatch through main() — hermetic, credential-free, fail-open
// ---------------------------------------------------------------------------

describe("history: main() dispatch", () => {
  it("lists from the log only — orphan masters are invisible (newest first)", async () => {
    const dir = makeTempDir("scoutline-history-orphans-");
    const { adapter, stdout, stderr } = makeAdapter();
    try {
      await makeStore(dir, [
        entry({ requestId: "20260829T100000Z-a", timestamp: NOW - DAY }),
        entry({ requestId: "20260829T140000Z-b", timestamp: NOW }),
      ]);
      // Orphan: master on disk, no log entry.
      await writeArtifact(dir, "20260829T150000Z-orphan", JSON.stringify({ schemaVersion: 1, requestId: "20260829T150000Z-orphan", result: [] }), { format: "json" });
      const status = await main(["history", "list"], historyDeps(adapter, { SCOUTLINE_ARTIFACTS_DIR: dir }));
      assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
      const report = JSON.parse(stdout[0]);
      assert.deepStrictEqual(report.entries.map((e) => e.requestId), [
        "20260829T140000Z-b",
        "20260829T100000Z-a",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("history show <requestId> returns { entry, report } joined", async () => {
    const dir = makeTempDir("scoutline-history-show-");
    const { adapter, stdout, stderr } = makeAdapter();
    try {
      await makeStore(dir, [entry({ requestId: "20260829T140000Z-b" })]);
      const status = await main(["history", "show", "20260829T140000Z-b"], historyDeps(adapter, { SCOUTLINE_ARTIFACTS_DIR: dir }));
      assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
      const data = JSON.parse(stdout[0]);
      assert.strictEqual(data.entry.requestId, "20260829T140000Z-b");
      assert.strictEqual(data.report.requestId, "20260829T140000Z-b");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("history show of an unknown id is exit 1 FILE_ERROR", async () => {
    const dir = makeTempDir("scoutline-history-unknown-");
    const { adapter, stdout, stderr } = makeAdapter();
    try {
      const status = await main(["history", "show", "20990101T000000Z-nope"], historyDeps(adapter, { SCOUTLINE_ARTIFACTS_DIR: dir }));
      assert.strictEqual(status, 1);
      assert.deepStrictEqual(stdout, []);
      const envelope = JSON.parse(stderr.at(-1));
      assert.strictEqual(envelope.success, false);
      assert.strictEqual(envelope.code, "FILE_ERROR");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("history stats aggregates the store (bytes, counts, span)", async () => {
    const dir = makeTempDir("scoutline-history-stats-");
    const { adapter, stdout, stderr } = makeAdapter();
    try {
      await makeStore(dir, [
        entry({ requestId: "20260829T100000Z-a", timestamp: NOW - 2 * DAY }),
        entry({ requestId: "20260829T140000Z-b", timestamp: NOW, command: "read" }),
      ]);
      const status = await main(["history", "stats"], historyDeps(adapter, { SCOUTLINE_ARTIFACTS_DIR: dir }));
      assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
      const report = JSON.parse(stdout[0]);
      assert.strictEqual(report.total, 2);
      assert.deepStrictEqual(report.byCommand, { search: 1, read: 1 });
      assert.ok(report.masterBytes > 0, "master bytes are summed from disk");
      assert.strictEqual(report.newest, NOW);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fail-open: missing dir exits 0 with empty data (list + stats)", async () => {
    const missing = join(makeTempDir("scoutline-history-missing2-"), "nope");
    {
      const { adapter, stdout, stderr } = makeAdapter();
      const status = await main(["history", "list"], historyDeps(adapter, { SCOUTLINE_ARTIFACTS_DIR: missing }));
      assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
      const report = JSON.parse(stdout[0]);
      assert.deepStrictEqual(report.entries, []);
      assert.strictEqual(report.total, 0);
    }
    {
      const { adapter, stdout, stderr } = makeAdapter();
      const status = await main(["history", "stats"], historyDeps(adapter, { SCOUTLINE_ARTIFACTS_DIR: missing }));
      assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
      const report = JSON.parse(stdout[0]);
      assert.strictEqual(report.total, 0);
      assert.strictEqual(report.masterBytes, 0);
    }
  });

  it("fail-open: corrupt index.json exits 0, empty data, stderr notice", async () => {
    const dir = makeTempDir("scoutline-history-corrupt2-");
    const { adapter, stdout, stderr } = makeAdapter();
    try {
      writeFileSync(join(dir, "index.json"), "{corrupt");
      const status = await main(["history", "list"], historyDeps(adapter, { SCOUTLINE_ARTIFACTS_DIR: dir }));
      assert.strictEqual(status, 0);
      const report = JSON.parse(stdout[0]);
      assert.deepStrictEqual(report.entries, []);
      assert.ok(
        stderr.some((line) => /Artifacts log/.test(line)),
        `expected a readLog notice on stderr; got ${JSON.stringify(stderr)}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("bare history prints help with exit 0; --help too", async () => {
    for (const argv of [["history"], ["history", "--help"]]) {
      const { adapter, stdout, stderr } = makeAdapter();
      const status = await main(argv, historyDeps(adapter, {}));
      assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
      assert.ok(stdout[0].includes("history"), "help text mentions history");
    }
    assert.ok(HISTORY_HELP.includes("history list"));
  });

  it("unknown subcommand is VALIDATION_ERROR exit 1", async () => {
    const { adapter, stdout, stderr } = makeAdapter();
    const status = await main(["history", "bogus"], historyDeps(adapter, {}));
    assert.strictEqual(status, 1);
    assert.deepStrictEqual(stdout, []);
    const envelope = JSON.parse(stderr.at(-1));
    assert.strictEqual(envelope.code, "VALIDATION_ERROR");
  });

  it("list filters flow through main: --limit, --command, --since", async () => {
    const dir = makeTempDir("scoutline-history-filters-");
    const { adapter, stdout, stderr } = makeAdapter();
    try {
      await makeStore(dir, [
        entry({ requestId: "20260829T100000Z-a", timestamp: NOW - 2 * DAY }),
        entry({ requestId: "20260829T120000Z-r", timestamp: NOW - DAY, command: "read" }),
        entry({ requestId: "20260829T140000Z-b", timestamp: NOW }),
      ]);
      const status = await main(
        ["history", "list", "--limit", "1"],
        historyDeps(adapter, { SCOUTLINE_ARTIFACTS_DIR: dir }),
      );
      assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
      const report = JSON.parse(stdout[0]);
      assert.deepStrictEqual(report.entries.map((e) => e.requestId), ["20260829T140000Z-b"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--since 1 drops yesterday's entry", async () => {
    const dir = makeTempDir("scoutline-history-since-");
    const { adapter, stdout, stderr } = makeAdapter();
    try {
      await makeStore(dir, [
        entry({ requestId: "20260829T100000Z-a", timestamp: NOW - 2 * DAY }),
        entry({ requestId: "20260829T140000Z-b", timestamp: NOW }),
      ]);
      const status = await main(
        ["history", "list", "--since", "1"],
        historyDeps(adapter, { SCOUTLINE_ARTIFACTS_DIR: dir }),
      );
      assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
      const report = JSON.parse(stdout[0]);
      assert.deepStrictEqual(report.entries.map((e) => e.requestId), ["20260829T140000Z-b"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("bad --since / --limit values are VALIDATION_ERROR", async () => {
    for (const flag of ["--since", "--limit"]) {
      for (const value of ["0", "-1", "two", "1.5"]) {
        const { adapter, stderr } = makeAdapter();
        const status = await main(
          ["history", "list", flag, value],
          historyDeps(adapter, {}),
        );
        assert.strictEqual(status, 1, `${flag} ${value} must be rejected`);
        assert.strictEqual(JSON.parse(stderr.at(-1)).code, "VALIDATION_ERROR");
      }
      const { adapter, stderr } = makeAdapter();
      const bare = await main(["history", "list", flag], historyDeps(adapter, {}));
      assert.strictEqual(bare, 1, `bare ${flag} must be rejected`);
      assert.strictEqual(JSON.parse(stderr.at(-1)).code, "VALIDATION_ERROR");
    }
  });

  it("valueless --command is VALIDATION_ERROR; a known value filters", async () => {
    const dir = makeTempDir("scoutline-history-cmdfilter-");
    try {
      await makeStore(dir, [
        entry({ requestId: "20260829T100000Z-a", timestamp: NOW - DAY }),
        entry({ requestId: "20260829T120000Z-r", timestamp: NOW, command: "read" }),
      ]);
      {
        const { adapter, stderr } = makeAdapter();
        const status = await main(["history", "list", "--command"], historyDeps(adapter, {}));
        assert.strictEqual(status, 1);
        assert.strictEqual(JSON.parse(stderr.at(-1)).code, "VALIDATION_ERROR");
      }
      {
        const { adapter, stdout, stderr } = makeAdapter();
        const status = await main(
          ["history", "list", "--command", "read"],
          historyDeps(adapter, { SCOUTLINE_ARTIFACTS_DIR: dir }),
        );
        assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
        assert.deepStrictEqual(JSON.parse(stdout[0]).entries.map((e) => e.command), ["read"]);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("history show without a requestId is VALIDATION_ERROR", async () => {
    const { adapter, stderr } = makeAdapter();
    const status = await main(["history", "show"], historyDeps(adapter, {}));
    assert.strictEqual(status, 1);
    assert.strictEqual(JSON.parse(stderr.at(-1)).code, "VALIDATION_ERROR");
  });
});

// ---------------------------------------------------------------------------
// CLI surface (subprocess)
// ---------------------------------------------------------------------------

describe("history: CLI surface", () => {
  it("scoutline history list works against isolated dirs over the real bin", async () => {
    const dir = makeTempDir("scoutline-history-cli-");
    const configDir = makeTempDir("scoutline-history-cli-cfg-");
    try {
      await makeStore(dir, [entry({ requestId: "20260829T140000Z-b" })]);
      const result = await runProcess(
        ["history", "list"],
        { configDir, env: { SCOUTLINE_ARTIFACTS_DIR: dir } },
      );
      assert.strictEqual(result.code, 0, `stderr=${result.stderr}`);
      const report = JSON.parse(result.stdout);
      assert.deepStrictEqual(report.entries.map((e) => e.requestId), ["20260829T140000Z-b"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});
