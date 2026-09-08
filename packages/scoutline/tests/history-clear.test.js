/**
 * History Journal Merge T6a — `history clear`, history's FIRST MUTATING
 * op (PRD AC7, DESIGN D5).
 *
 * Hermetic main()-driven pins (same harness class as history-note /
 * history-recall): injected `loadScoutlineConfig` via
 * `hermeticMainDeps`, fake invocation adapter, isolated
 * `SCOUTLINE_ARTIFACTS_DIR`, fixed clocks, hand-seeded stores.
 *
 * Pins:
 *   1. Bare `history clear` removes ALL kind:"journal" entries — full
 *      entries AND repeat markers — and NOTHING else (save entries and
 *      their master files untouched). Envelope reports what cleared.
 *   2. `--all` extends to save entries AND deletes their master files;
 *      no orphans remain.
 *   3. Corrupt/unrecognized pre-state log: fail-open to EMPTY (the
 *      readLog contract) — clear succeeds, store ends empty.
 *   4. Unknown flags rejected (family conventions, VALIDATION_ERROR);
 *      `--all` is the ONLY accepted flag.
 *   5. The rewrite runs under the write lock: a held
 *      `artifacts-write` lock times the clear out (lock-acquisition
 *      pin, the appendLockEntry precedent).
 *   6. Cache untouched (clear touches the artifacts store only).
 *   7. Journaling not disabled: a later journal write re-populates.
 *   8. Help identity: HISTORY_HELP Usage carries the clear line + says
 *      clear MUTATES (the "Read-only inventory" identity is gone);
 *      MAIN_HELP Commands line current.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../dist/index.js";
import { appendJournalEntry } from "../dist/lib/journal.js";

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

// Fixed clock: 2026-09-08T12:00:00Z.
const T0 = Date.UTC(2026, 8, 8, 12, 0, 0);
const fixedNow = () => T0;

/** Minimal hermetic deps (the history-command.test.js historyDeps shape — the credential-free path needs no cache triples). */
function clearDeps(adapter, extra = {}) {
  return {
    invocation: adapter,
    env: {},
    now: fixedNow,
    loadScoutlineConfig: async () => ({}),
    ...extra,
  };
}

/** Full journal entry factory with defaults; every field overridable. */
function fullEntry(overrides = {}) {
  return {
    kind: "journal",
    requestId: "j-1",
    timestamp: T0,
    capability: "search",
    provider: { mode: "single", effective: "zai", servedFrom: "live" },
    query: "rust vs go",
    contentHash: "a".repeat(64),
    cacheKey: "key-1",
    skeleton: { results: [] },
    ...overrides,
  };
}

function marker(overrides = {}) {
  return {
    kind: "journal",
    timestamp: T0,
    capability: "search",
    provider: { mode: "single", effective: "zai", servedFrom: "cache" },
    repeatOf: "j-1",
    ...overrides,
  };
}

function saveEntry(overrides = {}) {
  return {
    kind: "save",
    requestId: "s-1",
    timestamp: T0,
    command: "search",
    args: {},
    provider: { mode: "single", effective: "zai" },
    outputFormat: "json",
    artifactFormat: "json",
    cliVersion: "1.0.0",
    masterPath: "s-1.json",
    ...overrides,
  };
}

/** Seed a store: log entries + save masters on disk. */
function makeStore(dir, entries) {
  for (const entry of entries) {
    if (entry.kind === "save") writeFileSync(join(dir, entry.masterPath), "{}\n");
  }
  writeFileSync(join(dir, "index.json"), `${JSON.stringify({ version: 1, entries }, null, 2)}\n`);
}

function readStore(artifactsDir) {
  const logFile = join(artifactsDir, "index.json");
  assert.ok(existsSync(logFile), `no index.json in ${artifactsDir}`);
  return JSON.parse(readFileSync(logFile, "utf8"));
}

/** Mixed store used by most pins: 2 full journal entries, 1 marker, 2 saves. */
function seedMixedStore(dir) {
  makeStore(dir, [
    fullEntry({ requestId: "j-1", cacheKey: "key-1" }),
    fullEntry({ requestId: "j-2", cacheKey: "key-2", timestamp: T0 + 1000 }),
    marker(),
    saveEntry({ requestId: "s-1", masterPath: "s-1.json" }),
    saveEntry({ requestId: "s-2", masterPath: "s-2.md", artifactFormat: "markdown", timestamp: T0 + 2000 }),
  ]);
}

describe("T6a: bare history clear — journal-kind valve (main-driven)", () => {
  it("clears kind:journal ONLY: full entries AND repeat markers removed; saves + masters untouched; envelope reports counts", async () => {
    const artifactsDir = makeTempDir("scoutline-clear-valve-");
    const { adapter, stdout, stderr } = makeAdapter();
    try {
      seedMixedStore(artifactsDir);
      const status = await main(
        ["history", "clear"],
        clearDeps(adapter, { env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir } }),
      );
      assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
      // Scope pin: ONLY the journal kind went away.
      const store = readStore(artifactsDir);
      assert.deepStrictEqual(
        store.entries.map((entry) => entry.kind),
        ["save", "save"],
        "bare clear must keep every save entry and remove every journal entry + marker",
      );
      assert.deepStrictEqual(
        store.entries.map((entry) => entry.requestId),
        ["s-1", "s-2"],
      );
      // Masters untouched.
      assert.ok(existsSync(join(artifactsDir, "s-1.json")), "save master s-1.json survives");
      assert.ok(existsSync(join(artifactsDir, "s-2.md")), "save master s-2.md survives");
      // Data envelope reports what was cleared.
      const envelope = JSON.parse(stdout[0]);
      assert.strictEqual(envelope.scope, "journal");
      assert.strictEqual(envelope.removed, 3); // 2 full + 1 marker
      assert.deepStrictEqual(envelope.removedByKind, { journal: 3 });
      assert.strictEqual(envelope.kept, 2);
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });

  it("empty journal (saves only, or nothing): exit 0, removed 0, store byte-shape preserved", async () => {
    for (const seed of [
      [saveEntry({ requestId: "s-1", masterPath: "s-1.json" })],
      [],
    ]) {
      const artifactsDir = makeTempDir("scoutline-clear-empty-");
      const { adapter, stdout, stderr } = makeAdapter();
      try {
        makeStore(artifactsDir, seed);
        const status = await main(
          ["history", "clear"],
          clearDeps(adapter, { env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir } }),
        );
        assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
        const envelope = JSON.parse(stdout[0]);
        assert.strictEqual(envelope.removed, 0);
        assert.strictEqual(envelope.scope, "journal");
        const store = readStore(artifactsDir);
        assert.deepStrictEqual(
          store.entries.map((entry) => entry.requestId),
          seed.map((entry) => entry.requestId),
        );
      } finally {
        rmSync(artifactsDir, { recursive: true, force: true });
      }
    }
  });

  it("missing store dir: exit 0 with the empty-store contract (no throw)", async () => {
    const artifactsDir = makeTempDir("scoutline-clear-missing-inner-");
    const { adapter, stdout, stderr } = makeAdapter();
    try {
      const status = await main(
        ["history", "clear"],
        clearDeps(adapter, { env: { SCOUTLINE_ARTIFACTS_DIR: join(artifactsDir, "nope") } }),
      );
      assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
      const envelope = JSON.parse(stdout[0]);
      assert.strictEqual(envelope.removed, 0);
      assert.strictEqual(envelope.scope, "journal");
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });
});

describe("T6a: history clear --all — full wipe (main-driven)", () => {
  it("removes save entries AND journal entries AND deletes every master file; no orphans remain", async () => {
    const artifactsDir = makeTempDir("scoutline-clear-all-");
    const { adapter, stdout, stderr } = makeAdapter();
    try {
      seedMixedStore(artifactsDir);
      const status = await main(
        ["history", "clear", "--all"],
        clearDeps(adapter, { env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir } }),
      );
      assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
      const store = readStore(artifactsDir);
      assert.deepStrictEqual(store.entries, [], "--all must empty the log");
      assert.strictEqual(store.version, 1);
      // Orphan pin: every master file is gone.
      const leftovers = readdirSync(artifactsDir).filter((name) => name !== "index.json" && !name.endsWith(".lock"));
      assert.deepStrictEqual(leftovers, [], `--all must delete master files; found ${leftovers}`);
      const envelope = JSON.parse(stdout[0]);
      assert.strictEqual(envelope.scope, "all");
      assert.strictEqual(envelope.removed, 5);
      assert.deepStrictEqual(envelope.removedByKind, { journal: 3, save: 2 });
      assert.strictEqual(envelope.kept, 0);
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });

  it("orphan master (no log entry) is ALSO deleted under --all — nothing survives a full wipe", async () => {
    const artifactsDir = makeTempDir("scoutline-clear-all-orphan-");
    const { adapter, stdout, stderr } = makeAdapter();
    try {
      seedMixedStore(artifactsDir);
      writeFileSync(join(artifactsDir, "ghost.md"), "# orphan\n");
      const status = await main(
        ["history", "clear", "--all"],
        clearDeps(adapter, { env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir } }),
      );
      assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
      const leftovers = readdirSync(artifactsDir).filter((name) => name !== "index.json" && !name.endsWith(".lock"));
      assert.deepStrictEqual(leftovers, [], `orphan master must go too; found ${leftovers}`);
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });
});

describe("T6a: corrupt pre-state + validation + lock (main-driven)", () => {
  it("corrupt (invalid JSON) pre-state log: fail-open — clear succeeds and the store ends EMPTY and VALID", async () => {
    for (const argv of [["history", "clear"], ["history", "clear", "--all"]]) {
      const artifactsDir = makeTempDir("scoutline-clear-corrupt-");
      const { adapter, stdout, stderr } = makeAdapter();
      try {
        writeFileSync(join(artifactsDir, "index.json"), "{not json");
        writeFileSync(join(artifactsDir, "s-1.json"), "{}\n");
        const status = await main(argv, clearDeps(adapter, { env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir } }));
        assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
        const envelope = JSON.parse(stdout[0]);
        assert.strictEqual(envelope.removed, 0, "corrupt log reads as empty; nothing countable");
        const store = readStore(artifactsDir);
        assert.deepStrictEqual(store.entries, [], "clear writes back a valid empty log over the corrupt one");
        if (argv.includes("--all")) {
          const leftovers = readdirSync(artifactsDir).filter((n) => n !== "index.json" && !n.endsWith(".lock"));
          assert.deepStrictEqual(leftovers, [], "--all sweeps masters even over a corrupt log");
        }
      } finally {
        rmSync(artifactsDir, { recursive: true, force: true });
      }
    }
  });

  it("unrecognized-shape pre-state log: same fail-open empty outcome", async () => {
    const artifactsDir = makeTempDir("scoutline-clear-shape-");
    const { adapter, stdout, stderr } = makeAdapter();
    try {
      writeFileSync(join(artifactsDir, "index.json"), JSON.stringify({ hello: "world" }));
      const status = await main(
        ["history", "clear"],
        clearDeps(adapter, { env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir } }),
      );
      assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
      assert.deepStrictEqual(readStore(artifactsDir).entries, []);
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });

  it("--all is the ONLY accepted flag: every other flag is VALIDATION_ERROR exit 1", async () => {
    for (const argv of [
      ["history", "clear", "--limit", "5"],
      ["history", "clear", "--since", "3"],
      ["history", "clear", "--force"],
      ["history", "clear", "extra"],
    ]) {
      const artifactsDir = makeTempDir("scoutline-clear-badflag-");
      const { adapter, stdout, stderr } = makeAdapter();
      try {
        seedMixedStore(artifactsDir);
        const status = await main(argv, clearDeps(adapter, { env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir } }));
        assert.strictEqual(status, 1, `argv=${JSON.stringify(argv)}`);
        assert.deepStrictEqual(stdout, []);
        const envelope = JSON.parse(stderr.at(-1));
        assert.strictEqual(envelope.code, "VALIDATION_ERROR");
        // Reject-BEFORE-mutate: the store is untouched.
        assert.strictEqual(readStore(artifactsDir).entries.length, 5);
      } finally {
        rmSync(artifactsDir, { recursive: true, force: true });
      }
    }
  });

  it("the rewrite holds the artifacts-write lock: a held lock blocks the clear (lock-acquisition pin; store untouched)", async () => {
    const { open, rm } = await import("node:fs/promises");
    const artifactsDir = makeTempDir("scoutline-clear-lock-");
    const { adapter, stderr } = makeAdapter();
    // Capped timer: retries resolve in ms, not the 500ms sleep.
    const fastTimer = (callback, ms) => setTimeout(callback, Math.min(ms, 5));
    try {
      seedMixedStore(artifactsDir);
      const lockPath = join(artifactsDir, "artifacts-write.lock");
      const handle = await open(lockPath, "wx");
      try {
        // Drive through the exported handler with shrunk lock options
        // so the test resolves in ms. The typed seam converts the lock
        // timeout to FILE_ERROR (the cache-prune precedent), so the CLI
        // boundary must surface it as exit 1 — never UNKNOWN_ERROR, and
        // never a silent success past a held lock.
        const { handleHistory } = await import("../dist/index.js");
        const status = await handleHistory(
          ["clear"],
          "data",
          clearDeps(adapter, { env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir } }),
          { timeoutMs: 50, setTimeout: fastTimer },
        );
        assert.strictEqual(status, 1, "held lock must fail the clear");
        const envelope = JSON.parse(stderr.at(-1));
        assert.strictEqual(envelope.code, "FILE_ERROR");
        assert.match(envelope.error, /Artifacts log clear create-lock timed out/);
        assert.match(envelope.help ?? "", /artifacts-write lock/);
        // Reject-BEFORE-mutate: the store is untouched.
        assert.strictEqual(readStore(artifactsDir).entries.length, 5);
      } finally {
        await handle.close();
        await rm(lockPath, { force: true });
      }
      // Lock released → clear goes through.
      const status = await main(
        ["history", "clear"],
        clearDeps(adapter, { env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir } }),
      );
      assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
      const store = readStore(artifactsDir);
      assert.deepStrictEqual(store.entries.map((e) => e.kind), ["save", "save"]);
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });
});

describe("T6a: blast-radius honesty (cache untouched, journaling still on)", () => {
  it("clearing does NOT touch the response cache: cache stats unchanged after clear", async () => {
    const artifactsDir = makeTempDir("scoutline-clear-cachepin-");
    const before = makeAdapter();
    const mid = makeAdapter();
    const after = makeAdapter();
    try {
      seedMixedStore(artifactsDir);
      await main(["cache", "stats"], clearDeps(before.adapter));
      await main(
        ["history", "clear", "--all"],
        clearDeps(mid.adapter, { env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir } }),
      );
      await main(["cache", "stats"], clearDeps(after.adapter));
      const beforeStats = JSON.parse(before.stdout[0]);
      const afterStats = JSON.parse(after.stdout[0]);
      assert.deepStrictEqual(afterStats, beforeStats, "cache must be untouched by history clear");
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });

  it("clearing does NOT disable journaling: a later journal write re-populates the log", async () => {
    const artifactsDir = makeTempDir("scoutline-clear-rejournal-");
    const { adapter, stdout, stderr } = makeAdapter();
    try {
      seedMixedStore(artifactsDir);
      const status = await main(
        ["history", "clear"],
        clearDeps(adapter, { env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir } }),
      );
      assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
      // Explicit journal write (the note seam) re-populates after clear.
      await appendJournalEntry(
        artifactsDir,
        fullEntry({ requestId: "j-new", cacheKey: "key-new", timestamp: T0 + 5000 }),
      );
      const store = readStore(artifactsDir);
      assert.strictEqual(store.entries.length, 3, "saves + the new journal entry");
      assert.ok(store.entries.some((entry) => entry.requestId === "j-new"));
      // stdout stays data-only for the clear itself.
      assert.ok(JSON.parse(stdout[0]).scope, "clear stdout is the data envelope");
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });
});

describe("T6a: help identity — no longer read-only (main-driven)", () => {
  it("history help Usage carries the clear line; the identity copy names the mutating exception", async () => {
    const artifactsDir = makeTempDir("scoutline-clear-help-");
    const { adapter, stdout } = makeAdapter();
    try {
      const status = await main(
        ["history", "--help"],
        clearDeps(adapter, { env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir } }),
      );
      assert.strictEqual(status, 0);
      const help = stdout.join("");
      assert.ok(
        help.includes("scoutline history clear [--all]"),
        "HISTORY_HELP Usage must carry the clear line",
      );
      assert.ok(!/Read-only inventory/.test(help), "the read-only identity must be gone");
      // The unknown-subcommand roster string gains clear (family error surface).
      const bogus = makeAdapter();
      await main(["history", "bogus"], clearDeps(bogus.adapter, { env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir } }));
      // T6c: the roster gains export (family error surface).
      assert.match(bogus.stderr.at(-1), /list, show, stats, note, recall, export, clear/);
      // clear's own help renders (the note/recall per-subcommand pattern).
      const own = makeAdapter();
      await main(["history", "clear", "--help"], clearDeps(own.adapter));
      assert.ok(own.stdout.join("").includes("scoutline history clear [--all]"));
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });

  it("MAIN_HELP history line reflects the widened family (clear included)", async () => {
    const { adapter, stdout, stderr } = makeAdapter();
    const status = await main(["--help"], clearDeps(adapter));
    assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
    const help = stdout.join("");
    const lines = help.split("\n");
    const start = lines.findIndex((l) => /^\s*history\s/.test(l));
    assert.ok(start >= 0, "MAIN_HELP carries a history commands line");
    const line = lines[start] + " " + (lines[start + 1] ?? "");
    assert.ok(!/read-only/i.test(line), `MAIN_HELP history entry must drop the read-only wording: "${line}"`);
    assert.ok(/clear/.test(line), `MAIN_HELP history entry must mention clear: "${line}"`);
  });
});
