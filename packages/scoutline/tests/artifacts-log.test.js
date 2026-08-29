/**
 * T2 — Metadata log (`index.json`): versioned entries, locked appends,
 * fail-open reads (save-artifacts epic, ticket t2-metadata-log).
 *
 * Pins (ticket + DESIGN.md D5):
 *   1. Entry schema — exactly: kind ("save"), requestId, timestamp (ms epoch
 *      from the CALLER's injected now — no Date.now() inside), command, args,
 *      provider routing (single: {mode,requested,effective}; fan-out:
 *      {mode,requested,arms} — no single effective), outputFormat,
 *      artifactFormat, cliVersion (pkg.version), masterPath (relative
 *      filename), optional exportPath (absolute). Unknown additions fail.
 *   2. appendLogEntry serializes through the `artifacts-write` file lock —
 *      20 concurrent appends all persist with no torn entries.
 *   3. readLog fail-open: missing dir/file → {version:1, entries:[]} with no
 *      notice; corrupt JSON / unrecognized shape → same + a notice string for
 *      stderr. readLog NEVER throws.
 *   4. Orphan rule: a master file with no log entry is invisible to log
 *      readers — the log is the listing truth, never a directory scan.
 *
 * Hermeticity: every path lives inside a withTempDir tmp dir. Nothing reads
 * process.env; nothing touches ~/.scoutline; no wall-clock entry data.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { withTempDir } from "./helpers/temp-dir.js";

const PKG_VERSION = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;

// 2026-08-29T14:22:33Z — injected, never Date.now() (repo time-bomb rule).
const NOW_BASE = Date.UTC(2026, 7, 29, 14, 22, 33);
const RID = "20260829T142233Z-7f3a";

/** Canonical save entry; overrides replace top-level keys. */
function saveEntry(overrides = {}) {
  return {
    kind: "save",
    requestId: RID,
    timestamp: NOW_BASE,
    command: "search",
    args: { provider: "tavily", limit: 10 },
    provider: { mode: "single", requested: "tavily", effective: "bocha" },
    outputFormat: "data",
    artifactFormat: "json",
    cliVersion: PKG_VERSION,
    masterPath: `${RID}.json`,
    ...overrides,
  };
}

/** Capped timer: lock-acquire retry loops resolve in ms, not the 500ms sleep. */
const fastTimer = (callback, ms) => setTimeout(callback, Math.min(ms, 5));

describe("appendLogEntry", () => {
  it("writes version-1 index.json with the EXACT save-entry field set", async (t) => {
    await withTempDir(t, async (dir) => {
      const { appendLogEntry } = await import("../dist/lib/artifacts.js");

      await appendLogEntry(dir, saveEntry({ exportPath: "/abs/path/report.json" }));

      const logPath = path.join(dir, "index.json");
      const raw = JSON.parse(await fs.readFile(logPath, "utf8"));
      assert.strictEqual(raw.version, 1);
      assert.strictEqual(raw.entries.length, 1);
      const stored = raw.entries[0];
      assert.deepStrictEqual(
        Object.keys(stored).sort(),
        [
          "args",
          "artifactFormat",
          "cliVersion",
          "command",
          "exportPath",
          "kind",
          "masterPath",
          "outputFormat",
          "provider",
          "requestId",
          "timestamp",
        ],
        "entry field set is pinned — unknown additions fail loudly",
      );
      assert.strictEqual(stored.kind, "save");
      assert.strictEqual(stored.requestId, RID);
      assert.strictEqual(
        stored.timestamp,
        NOW_BASE,
        "timestamp is the CALLER's injected instant, never Date.now() inside",
      );
      assert.strictEqual(stored.command, "search");
      assert.deepStrictEqual(stored.args, { provider: "tavily", limit: 10 });
      assert.deepStrictEqual(Object.keys(stored.provider).sort(), [
        "effective",
        "mode",
        "requested",
      ]);
      assert.strictEqual(stored.provider.mode, "single");
      assert.strictEqual(stored.provider.requested, "tavily");
      assert.strictEqual(stored.provider.effective, "bocha");
      assert.strictEqual(stored.outputFormat, "data");
      assert.strictEqual(stored.artifactFormat, "json");
      assert.strictEqual(stored.cliVersion, PKG_VERSION);
      assert.strictEqual(
        stored.masterPath,
        `${RID}.json`,
        "masterPath is the filename relative to the artifacts dir",
      );
      assert.strictEqual(stored.exportPath, "/abs/path/report.json");
      assert.strictEqual((await fs.stat(logPath)).mode & 0o777, 0o600);
    });
  });

  it("pins the fan-out routing shape — arms list, no single effective", async (t) => {
    await withTempDir(t, async (dir) => {
      const { appendLogEntry } = await import("../dist/lib/artifacts.js");

      await appendLogEntry(
        dir,
        saveEntry({
          provider: { mode: "fanout", requested: "tavily", arms: ["bocha", "tavily"] },
        }),
      );

      const raw = JSON.parse(await fs.readFile(path.join(dir, "index.json"), "utf8"));
      const provider = raw.entries[0].provider;
      assert.deepStrictEqual(Object.keys(provider).sort(), ["arms", "mode", "requested"]);
      assert.strictEqual(provider.mode, "fanout");
      assert.deepStrictEqual(provider.arms, ["bocha", "tavily"]);
      assert.strictEqual(
        "effective" in provider,
        false,
        "fan-out has no single effective provider",
      );
    });
  });

  it("omits exportPath from the stored entry when absent", async (t) => {
    await withTempDir(t, async (dir) => {
      const { appendLogEntry } = await import("../dist/lib/artifacts.js");

      await appendLogEntry(dir, saveEntry());

      const raw = JSON.parse(await fs.readFile(path.join(dir, "index.json"), "utf8"));
      assert.strictEqual("exportPath" in raw.entries[0], false);
    });
  });

  it("appends preserve existing entries in order", async (t) => {
    await withTempDir(t, async (dir) => {
      const { appendLogEntry } = await import("../dist/lib/artifacts.js");

      await appendLogEntry(dir, saveEntry());
      await appendLogEntry(
        dir,
        saveEntry({ requestId: "20260829T142234Z-0002", timestamp: NOW_BASE + 1000 }),
      );

      const raw = JSON.parse(await fs.readFile(path.join(dir, "index.json"), "utf8"));
      assert.deepStrictEqual(
        raw.entries.map((entry) => entry.requestId),
        [RID, "20260829T142234Z-0002"],
      );
    });
  });

  it("creates a missing artifacts dir (0700) and the log inside it", async (t) => {
    await withTempDir(t, async (dir) => {
      const { appendLogEntry } = await import("../dist/lib/artifacts.js");
      const store = path.join(dir, "artifacts");

      await appendLogEntry(store, saveEntry());

      assert.strictEqual((await fs.stat(store)).mode & 0o777, 0o700);
      await fs.access(path.join(store, "index.json"));
    });
  });

  it("returns a stderr notice and resets when the existing log is corrupt", async (t) => {
    await withTempDir(t, async (dir) => {
      const { appendLogEntry, readLog } = await import("../dist/lib/artifacts.js");
      await fs.writeFile(path.join(dir, "index.json"), "{not json at all");

      const notice = await appendLogEntry(dir, saveEntry());

      assert.equal(typeof notice, "string", "corrupt-log reset must surface a notice");
      assert.ok(notice.includes("index.json"), `notice should name the file, got: ${notice}`);
      const { log } = await readLog(dir);
      assert.deepStrictEqual(
        log.entries.map((entry) => entry.requestId),
        [RID],
        "append recovers by starting a fresh log with the new entry",
      );
    });
  });

  it("serializes through the artifacts-write lock identity", async (t) => {
    await withTempDir(t, async (dir) => {
      const { appendLogEntry } = await import("../dist/lib/artifacts.js");
      const { LockTimeoutError } = await import("../dist/lib/async-file-lock.js");

      // Hold the lock identity the cache-write precedent uses: <id>.lock.
      const lockPath = path.join(dir, "artifacts-write.lock");
      const handle = await fs.open(lockPath, "wx");
      try {
        await assert.rejects(
          appendLogEntry(dir, saveEntry(), { timeoutMs: 50, setTimeout: fastTimer }),
          (error) =>
            error instanceof LockTimeoutError && error.label === "Artifacts log write",
        );
      } finally {
        await handle.close();
        await fs.rm(lockPath, { force: true });
      }

      // Lock released → the append goes through.
      await appendLogEntry(dir, saveEntry(), { timeoutMs: 50, setTimeout: fastTimer });
      const raw = JSON.parse(await fs.readFile(path.join(dir, "index.json"), "utf8"));
      assert.strictEqual(raw.entries.length, 1);
    });
  });

  it("20 concurrent appends all persist with no torn entries", async (t) => {
    await withTempDir(t, async (dir) => {
      const { appendLogEntry } = await import("../dist/lib/artifacts.js");

      const entries = Array.from({ length: 20 }, (_, i) =>
        saveEntry({
          requestId: `20260829T142233Z-${i.toString(16).padStart(4, "0")}`,
          timestamp: NOW_BASE + i,
        }),
      );
      await Promise.all(
        entries.map((entry) =>
          appendLogEntry(dir, entry, { timeoutMs: 5000, setTimeout: fastTimer }),
        ),
      );

      const raw = JSON.parse(await fs.readFile(path.join(dir, "index.json"), "utf8"));
      assert.strictEqual(
        raw.entries.length,
        20,
        "every concurrent append must persist — no lost update",
      );
      for (const entry of entries) {
        const stored = raw.entries.find((candidate) => candidate.requestId === entry.requestId);
        assert.ok(stored, `entry ${entry.requestId} missing from the log`);
        assert.deepStrictEqual(
          stored,
          entry,
          `entry ${entry.requestId} persisted torn — entries must be intact`,
        );
      }
    });
  });
});

describe("readLog", () => {
  it("missing dir/file fails open to {version:1, entries:[]} with no notice", async (t) => {
    await withTempDir(t, async (dir) => {
      const { readLog } = await import("../dist/lib/artifacts.js");

      const missing = await readLog(dir);
      assert.deepStrictEqual(missing.log, { version: 1, entries: [] });
      assert.strictEqual(missing.notice, undefined);

      const missingDir = await readLog(path.join(dir, "nope"));
      assert.deepStrictEqual(missingDir.log, { version: 1, entries: [] });
      assert.strictEqual(missingDir.notice, undefined);
    });
  });

  it("corrupt JSON fails open: empty log + notice for stderr, never throws", async (t) => {
    await withTempDir(t, async (dir) => {
      const { readLog } = await import("../dist/lib/artifacts.js");
      await fs.writeFile(path.join(dir, "index.json"), '{"version":1,"entries":[{"kin');

      const { log, notice } = await readLog(dir);

      assert.deepStrictEqual(log, { version: 1, entries: [] });
      assert.equal(typeof notice, "string");
      assert.ok(notice.includes("index.json"), `notice should name the file, got: ${notice}`);
    });
  });

  it("unrecognized shape or future version fails open with a notice", async (t) => {
    await withTempDir(t, async (dir) => {
      const { readLog } = await import("../dist/lib/artifacts.js");

      for (const body of [
        '{"version":2,"entries":[]}',
        '{"entries":[]}',
        "null",
        '[{"kind":"save"}]',
      ]) {
        await fs.writeFile(path.join(dir, "index.json"), body);
        const { log, notice } = await readLog(dir);
        assert.deepStrictEqual(log, { version: 1, entries: [] }, `body: ${body}`);
        assert.equal(typeof notice, "string", `body: ${body}`);
      }
    });
  });

  it("returns parsed entries for a valid log", async (t) => {
    await withTempDir(t, async (dir) => {
      const { appendLogEntry, readLog } = await import("../dist/lib/artifacts.js");

      await appendLogEntry(dir, saveEntry({ exportPath: "/abs/path/report.json" }));

      const { log, notice } = await readLog(dir);
      assert.strictEqual(notice, undefined);
      assert.strictEqual(log.version, 1);
      assert.deepStrictEqual(log.entries, [
        saveEntry({ exportPath: "/abs/path/report.json" }),
      ]);
    });
  });
});

describe("orphan rule", () => {
  it("a master file with no log entry is invisible to log readers", async (t) => {
    await withTempDir(t, async (dir) => {
      const { appendLogEntry, readLog, writeArtifact } = await import(
        "../dist/lib/artifacts.js"
      );

      // Orphan master: written but never logged (crash window per D5).
      await writeArtifact(dir, RID, '{"orphan":true}');
      let { log } = await readLog(dir);
      assert.deepStrictEqual(log.entries, [], "unlogged master must not appear");

      // A logged save beside an orphan master: only the logged entry lists.
      await appendLogEntry(dir, saveEntry());
      await writeArtifact(dir, "20260829T142300Z-beef", '{"orphan":true}');
      ({ log } = await readLog(dir));
      assert.deepStrictEqual(
        log.entries.map((entry) => entry.requestId),
        [RID],
      );
    });
  });
});
