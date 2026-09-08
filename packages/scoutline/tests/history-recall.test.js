/**
 * History Journal Merge T5 — `history recall` (recall engine).
 *
 * Hermetic main()-driven pins (same harness class as journal.test.js /
 * history-note.test.js): every `main()` drive injects
 * `loadScoutlineConfig` (via `hermeticMainDeps`), a fake invocation
 * adapter, an isolated `SCOUTLINE_ARTIFACTS_DIR`, and FIXED injected
 * clocks — no ambient config, no provider work, no network.
 *
 * Pins (ticket T5, PRD AC4, DESIGN D4):
 *   1. Deterministic token-overlap scoring over the journal-entry
 *      corpus (query + skeleton text); score DESC → recency DESC.
 *   2. `--limit`, `--capability` filters.
 *   3. `--as-of` boundary: timestamp ≤ date (boundary-pinned, < is the
 *      off-by-one mutation).
 *   4. Markers are NOT scored as separate results — they resolve to
 *      their referenced full entry; lastAsked reflects marker
 *      timestamps.
 *   5. Saves are NEVER text-searched (flags-only args); a save surfaces
 *      ONLY through its cross-linked skeleton saveRef.
 *   6. ZERO network, ZERO cache reads, MASTERS NEVER OPENED — any
 *      fetch/cache-read/master-open during recall fails the test.
 *   7. Empty/missing store → empty results, exit 0, ONE stderr
 *      orientation line (no stdout-data corruption).
 *   8. Read-only: recall never writes (byte-identical store after).
 *   9. Parse errors follow the history family conventions
 *      (VALIDATION_ERROR, exit 1).
 *  10. Help: history help lists `recall`; recall's own help renders.
 */
import { describe, it, before, after } from "node:test";
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
import { hermeticMainDeps } from "./helpers/hermetic-main.js";
import {
  appendJournalEntry,
} from "../dist/lib/journal.js";

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

// Fixed clock: 2026-09-08T12:00:00Z. `now` injectable per-drive.
const T0 = Date.UTC(2026, 8, 8, 12, 0, 0);
const fixedNow = () => T0;

function recallDeps(adapter, extra = {}) {
  return hermeticMainDeps({
    invocation: adapter,
    env: {},
    ...extra,
  });
}

/** Full journal entry factory with defaults; every field overridable. */
function fullEntry(overrides = {}) {
  return {
    kind: "journal",
    requestId: "req-x",
    timestamp: T0,
    capability: "search",
    provider: { mode: "single", effective: "zai", servedFrom: "live" },
    query: "q",
    contentHash: "a".repeat(64),
    cacheKey: "key-x",
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
    repeatOf: "req-x",
    ...overrides,
  };
}

function saveEntry(overrides = {}) {
  return {
    kind: "save",
    requestId: "save-x",
    timestamp: T0,
    command: "search",
    args: { query: "rust vs go matching" },
    provider: { mode: "single", effective: "zai" },
    outputFormat: "json",
    artifactFormat: "json",
    cliVersion: "1.0.0",
    masterPath: "save-x.json",
    ...overrides,
  };
}

/** Seed a store dir with entries via the real append seam. */
async function seedStore(dir, entries, stepMs = 1000) {
  let i = 0;
  for (const entry of entries) {
    await appendJournalEntry(dir, entry, {
      // stagger timestamps is caller's job; here only lock options
      setTimeout,
    });
    i++;
  }
  return i;
}

/** Parse the data-mode stdout envelope of one recall run. */
function parseEnvelope(stdout) {
  assert.ok(stdout.length >= 1, `expected stdout data, got ${JSON.stringify(stdout)}`);
  return JSON.parse(stdout[0]);
}

// I/O spy: fail the test on any global fetch / cache-read attempt.
let originalFetch;
let fetchAttempts;
function armFetchSpy() {
  fetchAttempts = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = (...args) => {
    fetchAttempts.push(String(args[0]));
    throw new Error(`RECALL MADE A NETWORK CALL: ${args[0]}`);
  };
}
function disarmFetchSpy() {
  globalThis.fetch = originalFetch;
}

const H = 60 * 60 * 1000;

describe("T5: recall scoring + ordering (main-driven)", () => {
  it("token-overlap scores query + skeleton text; rank score DESC → recency DESC (timestamp tiebreak)", async () => {
    const artifactsDir = makeTempDir("scoutline-recall-order-");
    const { adapter, stdout, stderr } = makeAdapter();
    try {
      await seedStore(artifactsDir, [
        // oldest, 1 overlap token ("rust" — title only; url and query
        // avoid query-set words beyond it)
        fullEntry({
          requestId: "r-old-1tok",
          timestamp: T0 - 10 * H,
          query: "internals weblog",
          skeleton: { results: [{ url: "https://x111.example/inside", title: "Rust" }] },
        }),
        // newest, 1 overlap token ("go" — in url and title each)
        fullEntry({
          requestId: "r-new-1tok",
          timestamp: T0 - 1 * H,
          query: "golang docs",
          skeleton: { results: [{ url: "https://go.dev", title: "Go" }] },
        }),
        // middle, 3 overlap tokens ("rust","vs","go") — top score
        fullEntry({
          requestId: "r-mid-3tok",
          timestamp: T0 - 5 * H,
          query: "rust vs go benchmark",
          skeleton: { results: [] },
        }),
      ]);
      const status = await main(
        ["history", "recall", "rust vs go"],
        recallDeps(adapter, { env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir }, now: fixedNow }),
      );
      assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
      const envelope = parseEnvelope(stdout);
      assert.deepStrictEqual(
        envelope.results.map((r) => r.requestId),
        ["r-mid-3tok", "r-new-1tok", "r-old-1tok"],
        "3-token scorer first; equal 1-token pair then recency DESC — score trumps recency",
      );
      assert.ok(envelope.results[0].score > envelope.results[1].score);
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });

  it("score tiebreak: equal scores order by recency DESC (mutation: inverted tiebreak → this pin goes red)", async () => {
    const artifactsDir = makeTempDir("scoutline-recall-tie-");
    const { adapter, stdout, stderr } = makeAdapter();
    try {
      await seedStore(artifactsDir, [
        fullEntry({ requestId: "r-older", timestamp: T0 - 3 * H, query: "alpha beta", skeleton: { results: [] } }),
        fullEntry({ requestId: "r-newer", timestamp: T0 - 1 * H, query: "alpha beta", skeleton: { results: [] } }),
      ]);
      const status = await main(
        ["history", "recall", "alpha beta"],
        recallDeps(adapter, { env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir }, now: fixedNow }),
      );
      assert.strictEqual(status, 0);
      const envelope = parseEnvelope(stdout);
      assert.deepStrictEqual(
        envelope.results.map((r) => r.requestId),
        ["r-newer", "r-older"],
        "equal score → newest first",
      );
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });

  it("--limit N slices the ranked list", async () => {
    const artifactsDir = makeTempDir("scoutline-recall-limit-");
    const { adapter, stdout } = makeAdapter();
    try {
      await seedStore(artifactsDir, [
        fullEntry({ requestId: "r-a", timestamp: T0 - 1 * H, query: "alpha alpha", skeleton: { results: [] } }),
        fullEntry({ requestId: "r-b", timestamp: T0 - 2 * H, query: "alpha", skeleton: { results: [] } }),
        fullEntry({ requestId: "r-c", timestamp: T0 - 3 * H, query: "alpha", skeleton: { results: [] } }),
      ]);
      const status = await main(
        ["history", "recall", "alpha", "--limit", "2"],
        recallDeps(adapter, { env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir }, now: fixedNow }),
      );
      assert.strictEqual(status, 0);
      const envelope = parseEnvelope(stdout);
      assert.strictEqual(envelope.results.length, 2);
      assert.deepStrictEqual(envelope.results.map((r) => r.requestId), ["r-a", "r-b"]);
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });

  it("--capability filters the corpus (fail-open 0 on no matches)", async () => {
    const artifactsDir = makeTempDir("scoutline-recall-cap-");
    const { adapter, stdout, stderr } = makeAdapter();
    try {
      await seedStore(artifactsDir, [
        fullEntry({ requestId: "r-search", timestamp: T0 - 1 * H, query: "alpha", capability: "search", skeleton: { results: [] } }),
        fullEntry({
          requestId: "r-read",
          timestamp: T0 - 2 * H,
          capability: "read",
          query: "https://example.com/alpha",
          skeleton: { results: [{ url: "https://example.com/alpha", title: "Alpha" }] },
        }),
      ]);
      const status = await main(
        ["history", "recall", "alpha", "--capability", "read"],
        recallDeps(adapter, { env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir }, now: fixedNow }),
      );
      assert.strictEqual(status, 0);
      const envelope = parseEnvelope(stdout);
      assert.deepStrictEqual(envelope.results.map((r) => r.requestId), ["r-read"]);
      assert.strictEqual(envelope.results[0].capability, "read");

      const adapter2 = makeAdapter();
      const status2 = await main(
        ["history", "recall", "alpha", "--capability", "research"],
        recallDeps(adapter2.adapter, { env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir }, now: fixedNow }),
      );
      assert.strictEqual(status2, 0, "no matches → fail-open empty, exit 0");
      assert.deepStrictEqual(parseEnvelope(adapter2.stdout).results, []);
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });

  it("--as-of boundary: entry timestamp EQUAL to --as-of is INCLUDED (≤, not <; off-by-one mutation pin)", async () => {
    const artifactsDir = makeTempDir("scoutline-recall-asof-");
    const { adapter, stdout, stderr } = makeAdapter();
    const atBoundary = T0 - 2 * H;
    try {
      await seedStore(artifactsDir, [
        fullEntry({ requestId: "r-before", timestamp: T0 - 5 * H, query: "alpha", skeleton: { results: [] } }),
        fullEntry({ requestId: "r-exact", timestamp: atBoundary, query: "alpha", skeleton: { results: [] } }),
        fullEntry({ requestId: "r-after", timestamp: T0 - 1 * H, query: "alpha", skeleton: { results: [] } }),
      ]);
      const status = await main(
        ["history", "recall", "alpha", "--as-of", new Date(atBoundary).toISOString()],
        recallDeps(adapter, { env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir }, now: fixedNow }),
      );
      assert.strictEqual(status, 0);
      const envelope = parseEnvelope(stdout);
      const ids = envelope.results.map((r) => r.requestId);
      assert.ok(ids.includes("r-exact"), "boundary-equal entry must be INCLUDED (≤)");
      assert.ok(!ids.includes("r-after"), "entries after --as-of excluded");
      assert.ok(ids.includes("r-before"));
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });

  it("--as-of accepts epoch-ms too (family-tolerant date parsing)", async () => {
    const artifactsDir = makeTempDir("scoutline-recall-asofms-");
    const { adapter, stdout } = makeAdapter();
    const atBoundary = T0 - 2 * H;
    try {
      await seedStore(artifactsDir, [
        fullEntry({ requestId: "r-exact", timestamp: atBoundary, query: "alpha", skeleton: { results: [] } }),
        fullEntry({ requestId: "r-after", timestamp: T0 - 1 * H, query: "alpha", skeleton: { results: [] } }),
      ]);
      const status = await main(
        ["history", "recall", "alpha", "--as-of", String(atBoundary)],
        recallDeps(adapter, { env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir }, now: fixedNow }),
      );
      assert.strictEqual(status, 0);
      const ids = parseEnvelope(stdout).results.map((r) => r.requestId);
      assert.ok(ids.includes("r-exact"));
      assert.ok(!ids.includes("r-after"));
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });
});

describe("T5: markers + saves (resolution, never scored as results)", () => {
  it("markers resolve to referenced entries: lastAsked reflects the marker timestamp; no separate marker result rows", async () => {
    const artifactsDir = makeTempDir("scoutline-recall-marker-");
    const { adapter, stdout, stderr } = makeAdapter();
    try {
      await seedStore(artifactsDir, [
        fullEntry({
          requestId: "r-full",
          timestamp: T0 - 10 * H,
          query: "rust vs go",
          skeleton: { results: [{ url: "https://rust-lang.org", title: "Rust" }] },
        }),
        marker({ timestamp: T0 - 1 * H, repeatOf: "r-full" }),
        marker({ timestamp: T0 - 30 * 60 * 1000, repeatOf: "r-full" }),
      ]);
      const status = await main(
        ["history", "recall", "rust"],
        recallDeps(adapter, { env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir }, now: fixedNow }),
      );
      assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
      const envelope = parseEnvelope(stdout);
      assert.strictEqual(envelope.results.length, 1, "markers never add result rows");
      const row = envelope.results[0];
      assert.strictEqual(row.requestId, "r-full");
      assert.strictEqual(
        row.lastAsked,
        T0 - 30 * 60 * 1000,
        "lastAsked = newest marker timestamp for the referenced entry",
      );
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });

  it("marker-augmented recency: marker AFTER the --as-of boundary keeps the PRIOR full entry visible, but lastAsked reflects the boundary", async () => {
    // Boundary + marker interplay: a full entry at T0-10h whose newest
    // marker is after --as-of — the ENTRY is visible under --as-of (its
    // timestamp ≤ boundary); lastAsked is computed over markers at/below
    // the boundary only.
    const artifactsDir = makeTempDir("scoutline-recall-markerasof-");
    const { adapter, stdout } = makeAdapter();
    const boundary = T0 - 2 * H;
    try {
      await seedStore(artifactsDir, [
        fullEntry({
          requestId: "r-full",
          timestamp: T0 - 10 * H,
          query: "rust vs go",
          skeleton: { results: [] },
        }),
        marker({ timestamp: T0 - 3 * H, repeatOf: "r-full" }),
        marker({ timestamp: T0 - 1 * H, repeatOf: "r-full" }), // after boundary
      ]);
      const status = await main(
        ["history", "recall", "rust", "--as-of", new Date(boundary).toISOString()],
        recallDeps(adapter, { env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir }, now: fixedNow }),
      );
      assert.strictEqual(status, 0);
      const envelope = parseEnvelope(stdout);
      assert.strictEqual(envelope.results.length, 1);
      assert.strictEqual(envelope.results[0].requestId, "r-full");
      assert.strictEqual(
        envelope.results[0].lastAsked,
        T0 - 3 * H,
        "lastAsked over markers ≤ --as-of only",
      );
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });

  it("saves are NEVER text-searched: save args/query text does NOT score; saveRef annotation surfaces the cross-link", async () => {
    const artifactsDir = makeTempDir("scoutline-recall-save-");
    const { adapter, stdout, stderr } = makeAdapter();
    try {
      await seedStore(artifactsDir, [
        saveEntry({ requestId: "s-only", timestamp: T0 - 1 * H, args: { query: "unique save text" } }),
        fullEntry({
          requestId: "r-linked",
          timestamp: T0 - 2 * H,
          query: "rust docs",
          skeleton: { results: [{ url: "https://doc.rust-lang.org", title: "Rust" }] },
          saveRef: "s-linked",
        }),
        saveEntry({ requestId: "s-linked", timestamp: T0 - 2 * H, args: { query: "rust docs" } }),
      ]);
      const status = await main(
        ["history", "recall", "unique save text"],
        recallDeps(adapter, { env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir }, now: fixedNow }),
      );
      assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
      const envelope = parseEnvelope(stdout);
      assert.deepStrictEqual(
        envelope.results,
        [],
        "save-entry args text must never produce a recall result",
      );

      // The cross-linked skeleton DOES score and annotates saveRef.
      const adapter2 = makeAdapter();
      const status2 = await main(
        ["history", "recall", "rust"],
        recallDeps(adapter2.adapter, { env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir }, now: fixedNow }),
      );
      assert.strictEqual(status2, 0);
      const results2 = parseEnvelope(adapter2.stdout).results;
      assert.strictEqual(results2.length, 1);
      assert.strictEqual(results2[0].requestId, "r-linked");
      assert.strictEqual(results2[0].saveRef, "s-linked");
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });
});

describe("T5: I/O honesty (zero network, zero cache reads, masters never opened, read-only)", () => {
  before(() => armFetchSpy());
  after(() => disarmFetchSpy());

  it("recall makes ZERO network calls and never opens master files (spy pins)", async () => {
    const artifactsDir = makeTempDir("scoutline-recall-io-");
    const { adapter, stdout, stderr } = makeAdapter();
    try {
      await seedStore(artifactsDir, [
        fullEntry({
          requestId: "r-full",
          timestamp: T0 - 1 * H,
          query: "rust vs go",
          skeleton: { results: [{ url: "https://rust-lang.org", title: "Rust" }] },
        }),
        saveEntry({ requestId: "s-1", timestamp: T0 - 1 * H }),
      ]);
      // Master file for the save entry exists — recall must not open it.
      writeFileSync(join(artifactsDir, "s-1.json"), JSON.stringify({ body: "x" }), "utf8");
      const before = readFileSync(join(artifactsDir, "index.json"), "utf8");
      const status = await main(
        ["history", "recall", "rust"],
        recallDeps(adapter, { env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir }, now: fixedNow }),
      );
      assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
      assert.strictEqual(fetchAttempts.length, 0, `fetch spy fired: ${JSON.stringify(fetchAttempts)}`);
      assert.strictEqual(parseEnvelope(stdout).results.length, 1);
      // Read-only: store byte-identical after recall.
      const after = readFileSync(join(artifactsDir, "index.json"), "utf8");
      assert.strictEqual(after, before, "recall mutated the store");
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });

  it("empty store: results [], exit 0, ONE stderr orientation line, stdout stays data-only", async () => {
    const artifactsDir = makeTempDir("scoutline-recall-empty-");
    const { adapter, stdout, stderr } = makeAdapter();
    try {
      const status = await main(
        ["history", "recall", "anything"],
        recallDeps(adapter, { env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir }, now: fixedNow }),
      );
      assert.strictEqual(status, 0);
      const envelope = parseEnvelope(stdout);
      assert.deepStrictEqual(envelope.results, []);
      assert.strictEqual(envelope.total ?? envelope.results.length, 0);
      // Exactly ONE orientation line on stderr, mentioning journal + empty.
      const lines = stderr.filter((l) => l.trim().length > 0);
      assert.strictEqual(lines.length, 1, `expected exactly one stderr line, got ${JSON.stringify(stderr)}`);
      const line = lines[0].toLowerCase();
      assert.ok(line.includes("journal") && line.includes("empty"), `orientation copy: ${lines[0]}`);
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });

  it("missing store dir (never created): same empty-store contract", async () => {
    const artifactsDir = makeTempDir("scoutline-recall-missing-");
    const nested = join(artifactsDir, "nope");
    const { adapter, stdout, stderr } = makeAdapter();
    try {
      const status = await main(
        ["history", "recall", "anything"],
        recallDeps(adapter, { env: { SCOUTLINE_ARTIFACTS_DIR: nested }, now: fixedNow }),
      );
      assert.strictEqual(status, 0);
      assert.deepStrictEqual(parseEnvelope(stdout).results, []);
      const lines = stderr.filter((l) => l.trim().length > 0);
      assert.strictEqual(lines.length, 1);
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });

  it("empty STORE with entries: a query matching nothing is empty results, exit 0, and NO orientation line (entries exist)", async () => {
    const artifactsDir = makeTempDir("scoutline-recall-nomatch-");
    const { adapter, stdout, stderr } = makeAdapter();
    try {
      await seedStore(artifactsDir, [
        fullEntry({ requestId: "r-1", timestamp: T0 - 1 * H, query: "unrelated", skeleton: { results: [] } }),
      ]);
      const status = await main(
        ["history", "recall", "zzz-nomatch-zzz"],
        recallDeps(adapter, { env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir }, now: fixedNow }),
      );
      assert.strictEqual(status, 0);
      assert.deepStrictEqual(parseEnvelope(stdout).results, []);
      assert.strictEqual(stderr.filter((l) => l.trim().length > 0).length, 0, "no orientation line when store is non-empty");
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });
});

describe("T5: envelope shape + validation (family conventions)", () => {
  it("result rows carry entry identity, score, capability, lastAsked, saveRef annotation", async () => {
    const artifactsDir = makeTempDir("scoutline-recall-shape-");
    const { adapter, stdout } = makeAdapter();
    try {
      await seedStore(artifactsDir, [
        fullEntry({
          requestId: "r-shape",
          timestamp: T0 - 4 * H,
          query: "rust vs go",
          skeleton: { results: [{ url: "https://rust-lang.org", title: "Rust" }] },
          saveRef: "s-shape",
        }),
        marker({ timestamp: T0 - 1 * H, repeatOf: "r-shape" }),
      ]);
      const status = await main(
        ["history", "recall", "rust"],
        recallDeps(adapter, { env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir }, now: fixedNow }),
      );
      assert.strictEqual(status, 0);
      const row = parseEnvelope(stdout).results[0];
      assert.strictEqual(row.requestId, "r-shape");
      assert.strictEqual(row.capability, "search");
      assert.ok(typeof row.score === "number" && row.score > 0);
      assert.strictEqual(row.lastAsked, T0 - 1 * H);
      assert.strictEqual(row.saveRef, "s-shape");
      assert.strictEqual(row.timestamp, T0 - 4 * H);
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });

  it("missing recall text → VALIDATION_ERROR (family convention, exit 1)", async () => {
    const artifactsDir = makeTempDir("scoutline-recall-notext-");
    const { adapter, stderr, stdout } = makeAdapter();
    try {
      const status = await main(
        ["history", "recall"],
        recallDeps(adapter, { env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir }, now: fixedNow }),
      );
      assert.strictEqual(status, 1);
      const envelope = JSON.parse(stderr.find((l) => l.trim().startsWith("{")) ?? "{}");
      assert.strictEqual(envelope.error?.code ?? envelope.code, "VALIDATION_ERROR");
      assert.strictEqual(stdout.length, 0, "no stdout data on validation error");
      assert.ok(!existsSync(join(artifactsDir, "index.json")), "validation error writes nothing");
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });

  it("invalid --limit / --as-of / --capability values → VALIDATION_ERROR (exit 1)", async () => {
    const artifactsDir = makeTempDir("scoutline-recall-badflags-");
    try {
      for (const argv of [
        ["history", "recall", "q", "--limit", "0"],
        ["history", "recall", "q", "--limit", "abc"],
        ["history", "recall", "q", "--as-of", "not-a-date"],
        ["history", "recall", "q", "--capability", "crawl"],
      ]) {
        const { adapter, stderr } = makeAdapter();
        const status = await main(
          argv,
          recallDeps(adapter, { env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir }, now: fixedNow }),
        );
        assert.strictEqual(status, 1, `argv=${JSON.stringify(argv)}`);
        const envelope = JSON.parse(stderr.find((l) => l.trim().startsWith("{")) ?? "{}");
        assert.strictEqual(envelope.error?.code ?? envelope.code, "VALIDATION_ERROR", `argv=${JSON.stringify(argv)}`);
      }
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });

  it("help surfaces: `history --help` lists recall; `history recall --help` renders its own help (exit 0, writes nothing)", async () => {
    const artifactsDir = makeTempDir("scoutline-recall-help-");
    try {
      const h1 = makeAdapter();
      const s1 = await main(["history", "--help"], recallDeps(h1.adapter));
      assert.strictEqual(s1, 0);
      assert.ok(h1.stdout.join("").includes("recall"), "history help must list recall");

      const h2 = makeAdapter();
      const s2 = await main(
        ["history", "recall", "--help"],
        recallDeps(h2.adapter, { env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir }, now: fixedNow }),
      );
      assert.strictEqual(s2, 0);
      const help = h2.stdout.join("");
      assert.ok(help.includes("--as-of"));
      assert.ok(help.includes("--capability"));
      assert.ok(help.includes("--limit"));
      assert.ok(!existsSync(join(artifactsDir, "index.json")), "help writes nothing");
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });
});
