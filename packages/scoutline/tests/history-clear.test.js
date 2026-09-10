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
import { useTempConfigDir } from "./helpers/config-dir-pin.js";

useTempConfigDir();

function makeTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeAdapter(environmentOutputMode = "data") {
  const stdout = [];
  const stderr = [];
  const adapter = {
    stdoutIsTTY: false,
    stdinIsTTY: false,
    environmentOutputMode,
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
      // parseArgs binds the next non-dash token as --all's value; a
      // valued --all must be REJECTED, not silently downgraded to
      // journal-only scope with the stray token swallowed.
      ["history", "clear", "--all", "stray"],
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

  it("valued --all (`clear --all stray`) is rejected and the store is untouched (review batch 1)", async () => {
    const artifactsDir = makeTempDir("scoutline-clear-all-valued-");
    const { adapter, stderr } = makeAdapter();
    try {
      seedMixedStore(artifactsDir);
      const status = await main(
        ["history", "clear", "--all", "stray"],
        clearDeps(adapter, { env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir } }),
      );
      assert.strictEqual(status, 1, "valued --all must not run a wipe");
      const envelope = JSON.parse(stderr.find((line) => line.trim().startsWith("{")) ?? "{}");
      assert.strictEqual(envelope.error?.code ?? envelope.code, "VALIDATION_ERROR");
      assert.match(envelope.error ?? "", /boolean flag/);
      // The user asked for a full wipe; a journal-only downgrade would
      // silently destroy less than asked. Nothing may be touched.
      assert.strictEqual(readStore(artifactsDir).entries.length, 5);
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
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
    // Cache root is governed by SCOUTLINE_CACHE_DIR (resolveCacheRootPure),
    // not SCOUTLINE_ARTIFACTS_DIR — pin it to an isolated temp dir so the
    // stats comparison is about a hermetic root, never the real one.
    const cacheDir = makeTempDir("scoutline-clear-cachepin-cache-");
    const before = makeAdapter();
    const mid = makeAdapter();
    const after = makeAdapter();
    // resolveCacheRoot (cache.ts) reads process.env.SCOUTLINE_CACHE_DIR
    // directly — the clearDeps env NEVER reaches it — so the hermetic
    // pin is a process.env set/restore, not a deps pass-through. The
    // prior value is restored in finally.
    const priorCacheDir = process.env.SCOUTLINE_CACHE_DIR;
    try {
      seedMixedStore(artifactsDir);
      process.env.SCOUTLINE_CACHE_DIR = cacheDir;
      const beforeStatus = await main(
        ["cache", "stats"],
        clearDeps(before.adapter, {
          env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir, SCOUTLINE_CACHE_DIR: cacheDir },
        }),
      );
      assert.strictEqual(beforeStatus, 0, `stderr=${JSON.stringify(before.stderr)}`);
      const clearStatus = await main(
        ["history", "clear", "--all"],
        clearDeps(mid.adapter, { env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir } }),
      );
      assert.strictEqual(clearStatus, 0, `stderr=${JSON.stringify(mid.stderr)}`);
      const afterStatus = await main(
        ["cache", "stats"],
        clearDeps(after.adapter, {
          env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir, SCOUTLINE_CACHE_DIR: cacheDir },
        }),
      );
      assert.strictEqual(afterStatus, 0, `stderr=${JSON.stringify(after.stderr)}`);
      const beforeStats = JSON.parse(before.stdout[0]);
      const afterStats = JSON.parse(after.stdout[0]);
      assert.deepStrictEqual(afterStats, beforeStats, "cache must be untouched by history clear");
    } finally {
      if (priorCacheDir === undefined) delete process.env.SCOUTLINE_CACHE_DIR;
      else process.env.SCOUTLINE_CACHE_DIR = priorCacheDir;
      rmSync(cacheDir, { recursive: true, force: true });
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

// ---------------------------------------------------------------------------
// Review round 3 (PR #111): honest --all summary wording (coderabbit/cubic).
// ---------------------------------------------------------------------------

describe("review r3: history clear --all wording (coderabbit/cubic)", () => {
  it("--all summary labels the removed total as entries and separates journal from save counts", async () => {
    const artifactsDir = makeTempDir("scoutline-clear-wording-");
    const { adapter, stdout, stderr } = makeAdapter("compact");
    try {
      seedMixedStore(artifactsDir); // 2 full journal + 1 marker + 2 saves
      const status = await main(
        ["history", "clear", "--all"],
        clearDeps(adapter, { env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir } }),
      );
      assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
      const text = stdout.join("\n");
      assert.ok(text.length > 0, "compact mode prints the summary text");
      assert.match(text, /removed 5 entries \(3 journal, 2 save\)/, `text=${text}`);
      assert.ok(text.includes("2 save master file(s)"), `text=${text}`);
      assert.ok(!text.includes("5 journal"), "total must never be labelled journal");
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });

  it("bare clear wording keeps the journal-only phrasing with an explicit count", async () => {
    const artifactsDir = makeTempDir("scoutline-clear-wording-bare-");
    const { adapter, stdout, stderr } = makeAdapter("compact");
    try {
      seedMixedStore(artifactsDir);
      const status = await main(
        ["history", "clear"],
        clearDeps(adapter, { env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir } }),
      );
      assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
      const text = stdout.join("\n");
      assert.ok(text.length > 0, "compact mode prints the summary text");
      assert.match(text, /removed 3 journal entries/, `text=${text}`);
      assert.ok(text.includes("2 saved artifact(s) kept"), `text=${text}`);
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Review round 3 (PR #111): --all sweep respects the tmp-file discipline
// — an in-flight save's `.tmp.*` temp file must survive the wipe (the
// save renames it into place AFTER the log append; deleting it mid-save
// would corrupt the atomic-replace contract). User data files remain in
// scope of the wipe — --all is documented as the FULL wipe (the orphan
// pin above) — but process-internal temporaries are not store content.
// ---------------------------------------------------------------------------

describe("review r3: --all sweep spares atomic-replace temporaries (macroscope/cubic)", () => {
  it("a DOT-PREFIXED temp ENDING in `.tmp` (atomicReplaceFile staging shape) survives; a plain user `.tmp` file goes", async () => {
    const artifactsDir = makeTempDir("scoutline-clear-tmp-suffix-");
    const { adapter, stdout, stderr } = makeAdapter();
    try {
      seedMixedStore(artifactsDir);
      // The atomicReplaceFile / atomicPlaceNoClobber staging name:
      // `.<basename>.<pid>.<uuid>.tmp` — no ".tmp." substring, so this
      // only survives if the sweep spares the DOT-PREFIXED .tmp-suffix
      // staging class. A plain user file ending .tmp is NOT staging —
      // it is store content and goes under the documented full wipe.
      const tmpName = ".index.json.4242.0f1e2d3c-4b5a-6789-abcd-ef0123456789.tmp";
      writeFileSync(join(artifactsDir, tmpName), "{}\n");
      const plainTmpName = "notes.tmp";
      writeFileSync(join(artifactsDir, plainTmpName), "user notes\n");
      const status = await main(
        ["history", "clear", "--all"],
        clearDeps(adapter, { env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir } }),
      );
      assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
      const leftovers = readdirSync(artifactsDir);
      assert.ok(leftovers.includes(tmpName), `in-flight save temp must survive: ${JSON.stringify(leftovers)}`);
      assert.ok(!leftovers.includes(plainTmpName), "plain user .tmp file is store content — the full wipe deletes it");
      assert.ok(!leftovers.includes("s-1.json"), "logged master still deleted");
      assert.ok(!leftovers.includes("s-2.md"), "logged master still deleted");
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });

  it("a `.tmp.` temp file present during --all survives the sweep; logged masters + orphans still go", async () => {
    const artifactsDir = makeTempDir("scoutline-clear-tmp-");
    const { adapter, stdout, stderr } = makeAdapter();
    try {
      seedMixedStore(artifactsDir);
      const tmpName = "20260908T120000Z-tmp9.json.tmp.4242.deadbeef";
      writeFileSync(join(artifactsDir, tmpName), "{}\n");
      const status = await main(
        ["history", "clear", "--all"],
        clearDeps(adapter, { env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir } }),
      );
      assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
      const leftovers = readdirSync(artifactsDir);
      assert.ok(leftovers.includes(tmpName), `temp file must survive: ${JSON.stringify(leftovers)}`);
      assert.ok(!leftovers.includes("s-1.json"), "logged master still deleted");
      assert.ok(!leftovers.includes("index.json.lock") || leftovers.filter((n) => n.endsWith(".lock")).length <= 1);
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Review batch 1 (PR #111): --all failure honesty + export-copy sparing.
// ---------------------------------------------------------------------------

describe("review batch 1: --all wipe failure honesty (macroscope/greptile/cubic)", () => {
  it("read-only artifacts dir: exit 1 FILE_ERROR; log and masters byte-intact (skipped as root)", async (t) => {
    if (process.getuid?.() === 0) return t.skip("root ignores directory write bits");
    const { chmod } = await import("node:fs/promises");
    const artifactsDir = makeTempDir("scoutline-clear-ro-");
    const { adapter, stdout, stderr } = makeAdapter();
    try {
      seedMixedStore(artifactsDir);
      const logBefore = readFileSync(join(artifactsDir, "index.json"));
      const masterBefore = readFileSync(join(artifactsDir, "s-1.json"));
      await chmod(artifactsDir, 0o555);
      const status = await main(
        ["history", "clear", "--all"],
        clearDeps(adapter, { env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir } }),
      );
      assert.strictEqual(status, 1, "a wipe that cannot delete must not exit 0");
      assert.deepStrictEqual(stdout, [], "no success stdout past a failed wipe");
      const envelope = JSON.parse(stderr.at(-1));
      assert.strictEqual(envelope.code, "FILE_ERROR");
      // Store intact: the log is byte-identical and both masters survive.
      assert.ok(logBefore.equals(readFileSync(join(artifactsDir, "index.json"))));
      assert.ok(masterBefore.equals(readFileSync(join(artifactsDir, "s-1.json"))));
      assert.ok(existsSync(join(artifactsDir, "s-2.md")));
      assert.strictEqual(readStore(artifactsDir).entries.length, 5);
    } finally {
      await chmod(artifactsDir, 0o700).catch(() => {});
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });
});

describe("review batch 1: --all spares logged export copies inside the artifacts dir (cubic)", () => {
  it("a save entry's exportPath file inside the store survives the sweep; entry removed, master deleted", async () => {
    const artifactsDir = makeTempDir("scoutline-clear-export-");
    const { adapter, stdout, stderr } = makeAdapter();
    try {
      const exportName = "export-copy.md";
      makeStore(artifactsDir, [
        fullEntry({ requestId: "j-1", cacheKey: "key-1" }),
        saveEntry({
          requestId: "s-1",
          masterPath: "s-1.json",
          exportPath: join(artifactsDir, exportName),
        }),
      ]);
      writeFileSync(join(artifactsDir, exportName), "# export copy\n");
      const status = await main(
        ["history", "clear", "--all"],
        clearDeps(adapter, { env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir } }),
      );
      assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
      assert.ok(existsSync(join(artifactsDir, exportName)), "logged export copy survives the sweep");
      assert.ok(!existsSync(join(artifactsDir, "s-1.json")), "logged master still deleted");
      assert.deepStrictEqual(readStore(artifactsDir).entries, []);
      const envelope = JSON.parse(stdout[0]);
      assert.strictEqual(envelope.removed, 2);
      assert.strictEqual(envelope.mastersDeleted, 1, "export copy is not a master; not counted");
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Review batch 3 (PR #111): honest mastersDeleted (issue 7).
// ---------------------------------------------------------------------------

describe("review batch 3: honest mastersDeleted count (issue 7)", () => {
  it("--all sweeps orphans and counts only successful unlinks (3 masters on disk, 2 logged → mastersDeleted === 3)", async () => {
    const artifactsDir = makeTempDir("scoutline-clear-honest-");
    const { adapter, stdout, stderr } = makeAdapter();
    try {
      seedMixedStore(artifactsDir);
      writeFileSync(join(artifactsDir, "orphan.md"), "# orphan\n");
      const status = await main(
        ["history", "clear", "--all"],
        clearDeps(adapter, { env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir } }),
      );
      assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
      const envelope = JSON.parse(stdout[0]);
      assert.strictEqual(envelope.removed, 5);
      assert.strictEqual(envelope.kept, 0);
      // 2 logged masters + 1 orphan = 3 files actually unlinked.
      assert.strictEqual(
        envelope.mastersDeleted,
        3,
        `mastersDeleted must count every successful unlink: got ${envelope.mastersDeleted}`,
      );
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });

  it("--all does NOT count a subdirectory (fs.unlink on a dir fails → not counted in mastersDeleted)", async () => {
    const { mkdirSync } = await import("node:fs");
    const artifactsDir = makeTempDir("scoutline-clear-honest-dir-");
    const { adapter, stdout, stderr } = makeAdapter();
    try {
      seedMixedStore(artifactsDir);
      mkdirSync(join(artifactsDir, "subdir"));
      const status = await main(
        ["history", "clear", "--all"],
        clearDeps(adapter, { env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir } }),
      );
      assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
      const envelope = JSON.parse(stdout[0]);
      assert.strictEqual(envelope.mastersDeleted, 2, "only the two logged masters count");
      // The subdir survived (EISDIR — not a store file and not counted).
      assert.ok(readdirSync(artifactsDir).includes("subdir"), "subdir survives (not a master file)");
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });

  it("bare clear: the lib result carries no mastersDeleted key (only --all sets it)", async () => {
    const { clearArtifactsLog } = await import("../dist/lib/artifacts.js");
    const artifactsDir = makeTempDir("scoutline-clear-honest-bare-");
    try {
      seedMixedStore(artifactsDir);
      const result = await clearArtifactsLog(artifactsDir);
      assert.strictEqual(result.removed, 3);
      assert.strictEqual("mastersDeleted" in result, false, "bare clear omits mastersDeleted");
      // --all: key is present and a number.
      const allResult = await clearArtifactsLog(artifactsDir, { all: true });
      assert.strictEqual(typeof allResult.mastersDeleted, "number", "--all sets mastersDeleted");
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });
});
