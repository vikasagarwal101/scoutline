/**
 * History Journal Merge T6c — `history export` (dossier renderer).
 *
 * Hermetic main()-driven pins (same harness class as
 * history-recall.test.js): every `main()` drive injects
 * `loadScoutlineConfig` (via `hermeticMainDeps`), a fake invocation
 * adapter, an isolated `SCOUTLINE_ARTIFACTS_DIR`, and FIXED injected
 * clocks — no ambient config, no provider work, no network.
 *
 * Pins (ticket T6c, PRD AC5, DESIGN D5):
 *   1. Deterministic markdown dossier over the filtered journal: one
 *      section per FULL entry (entry identity from the skeleton), a
 *      provenance line `{url, at, contentHash}` per skeleton row —
 *      frozen byte-exact fixture.
 *   2. Repeat markers are NEVER sections (mutation: marker rendered →
 *      fixture pin red).
 *   3. `--since <date>` lower bound: timestamp ≥ since (INCLUSIVE;
 *      off-by-one mutation pin).
 *   4. Same log → byte-identical output (deterministic rendering).
 *   5. ZERO network, ZERO cache reads, masters never opened for
 *      CONTENT — saveRef renders as a pointer, and only an existence
 *      stat on the master path is allowed I/O beyond the log read.
 *   6. Read-only: store byte-identical after export.
 *   7. Provider renders per family conventions incl. `zai (cache)`
 *      when servedFrom === "cache" (#108 distinction).
 *   8. Fail-open: missing/empty store → header-only dossier, exit 0,
 *      stderr stays clean on success.
 *   9. Parse errors follow the history family conventions
 *      (VALIDATION_ERROR, exit 1).
 *  10. Help: HISTORY_HELP Usage roster carries export; export's own
 *      help renders.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../dist/index.js";
import { hermeticMainDeps } from "./helpers/hermetic-main.js";
import { appendJournalEntry, skeletonContentHash } from "../dist/lib/journal.js";

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

function exportDeps(adapter, extra = {}) {
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
    args: { query: "q" },
    provider: { mode: "single", effective: "zai" },
    outputFormat: "json",
    artifactFormat: "json",
    cliVersion: "1.0.0",
    masterPath: "save-x.json",
    ...overrides,
  };
}

/** Seed a store dir with entries via the real append seam. */
async function seedStore(dir, entries) {
  for (const entry of entries) {
    await appendJournalEntry(dir, entry);
  }
}

/**
 * Fixture seed: two full entries + a marker + a save, ordered oldest
 * first in append order. The frozen dossier below is byte-exact over
 * THIS seed — any renderer drift reddens the pin.
 */
const FIXTURES = {
  eOld: {
    kind: "journal",
    requestId: "20260908T100000Z-old1",
    timestamp: Date.UTC(2026, 8, 8, 10, 0, 0),
    capability: "search",
    provider: { mode: "single", effective: "zai", servedFrom: "live" },
    query: "rust vs go",
    contentHash: skeletonContentHash({
      results: [
        { url: "https://go.dev/doc", title: "Go Documentation" },
        { url: "https://www.rust-lang.org", title: "Rust Programming Language" },
      ],
    }),
    cacheKey: "key-old",
    skeleton: {
      results: [
        { url: "https://go.dev/doc", title: "Go Documentation" },
        { url: "https://www.rust-lang.org", title: "Rust Programming Language" },
      ],
    },
  },
  eNew: {
    kind: "journal",
    requestId: "20260908T110000Z-new1",
    timestamp: Date.UTC(2026, 8, 8, 11, 0, 0),
    capability: "read",
    provider: { mode: "single", effective: "zai", servedFrom: "cache" },
    query: "https://blog.z.ai/launch",
    contentHash: skeletonContentHash({
      results: [{ url: "https://blog.z.ai/launch", title: "Launch Notes" }],
    }),
    cacheKey: "key-new",
    skeleton: { results: [{ url: "https://blog.z.ai/launch", title: "Launch Notes" }] },
    saveRef: "20260908T110000Z-save1",
  },
};

/**
 * The frozen dossier (byte-exact). Sections newest-first; each section's
 * title is its first skeleton row's title; `at` = entry timestamp ISO;
 * contentHash = the ENTRY's hash on every row; the saveRef'd save entry
 * exists in the log but its master file does not → `(missing)`
 * annotation (existence-stat honesty); repeat markers + saves render
 * nothing; footer counts sections.
 */
const FROZEN_DOSSIER = [
  "# Research journal export",
  "",
  "## Launch Notes",
  "- query: https://blog.z.ai/launch",
  "- capability: read",
  "- provider: zai (cache)",
  "- recorded: 2026-09-08T11:00:00.000Z",
  "- requestId: 20260908T110000Z-new1",
  "- tags: -",
  "- saved artifact: 20260908T110000Z-save1 (missing)",
  "",
  "- https://blog.z.ai/launch — Launch Notes",
  "  `{url:https://blog.z.ai/launch, at:2026-09-08T11:00:00.000Z, contentHash:184f12f754c2e4f936cb8eb01da9b9b088a8685964193ed2caa3077b03d7355d}`",
  "",
  "## Go Documentation",
  "- query: rust vs go",
  "- capability: search",
  "- provider: zai",
  "- recorded: 2026-09-08T10:00:00.000Z",
  "- requestId: 20260908T100000Z-old1",
  "- tags: -",
  "- saved artifact: -",
  "",
  "- https://go.dev/doc — Go Documentation",
  "  `{url:https://go.dev/doc, at:2026-09-08T10:00:00.000Z, contentHash:8c55660565250c6c0c421d399df51667b52cacac55a94f4e582f0535d140f13e}`",
  "- https://www.rust-lang.org — Rust Programming Language",
  "  `{url:https://www.rust-lang.org, at:2026-09-08T10:00:00.000Z, contentHash:8c55660565250c6c0c421d399df51667b52cacac55a94f4e582f0535d140f13e}`",
  "",
  "2 finding(s)",
].join("\n");

/** Parse the data-mode stdout envelope of one export run. */
function parseEnvelope(stdout) {
  assert.ok(stdout.length >= 1, `expected stdout data, got ${JSON.stringify(stdout)}`);
  return JSON.parse(stdout[0]);
}

// I/O spy: fail the test on any global fetch attempt (recall's pattern).
let originalFetch;
let fetchAttempts;
function armFetchSpy() {
  fetchAttempts = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = (...args) => {
    fetchAttempts.push(String(args[0]));
    throw new Error(`EXPORT MADE A NETWORK CALL: ${args[0]}`);
  };
}
function disarmFetchSpy() {
  globalThis.fetch = originalFetch;
}

const H = 60 * 60 * 1000;

describe("T6c: export renderer (frozen fixture + marker skip)", () => {
  it("frozen markdown dossier: byte-exact over the fixed log (one section per finding, provenance per row)", async () => {
    const artifactsDir = makeTempDir("scoutline-export-frozen-");
    const { adapter, stdout, stderr } = makeAdapter();
    try {
      await seedStore(artifactsDir, [
        FIXTURES.eOld,
        marker({ timestamp: T0 - H, repeatOf: FIXTURES.eOld.requestId }),
        FIXTURES.eNew,
        saveEntry({ requestId: FIXTURES.eNew.saveRef, timestamp: FIXTURES.eNew.timestamp }),
      ]);
      const status = await main(
        ["history", "export"],
        exportDeps(adapter, { env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir }, now: fixedNow }),
      );
      assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
      const envelope = parseEnvelope(stdout);
      assert.strictEqual(envelope.markdown, FROZEN_DOSSIER);
      assert.strictEqual(envelope.total, 2, "sections = full entries only");
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });

  it("same log, two runs → byte-identical output (deterministic rendering)", async () => {
    const artifactsDir = makeTempDir("scoutline-export-determinism-");
    try {
      await seedStore(artifactsDir, [FIXTURES.eOld, FIXTURES.eNew]);
      const outs = [];
      for (let i = 0; i < 2; i++) {
        const { adapter, stdout } = makeAdapter();
        const status = await main(
          ["history", "export"],
          exportDeps(adapter, { env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir }, now: fixedNow }),
        );
        assert.strictEqual(status, 0);
        outs.push(parseEnvelope(stdout).markdown);
      }
      assert.strictEqual(outs[0], outs[1]);
      assert.ok(outs[0].length > 0);
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });

  it("determinism across capabilities: append order and seed variance never reorder sections (order pin)", async () => {
    // Two stores: reverse append order → sections newest-first both ways
    // (order is timestamp-derived, not append-derived).
    const a = makeTempDir("scoutline-export-order-a-");
    const b = makeTempDir("scoutline-export-order-b-");
    try {
      await seedStore(a, [FIXTURES.eOld, FIXTURES.eNew]);
      await seedStore(b, [FIXTURES.eNew, FIXTURES.eOld]);
      const outs = [];
      for (const dir of [a, b]) {
        const { adapter, stdout } = makeAdapter();
        const status = await main(
          ["history", "export"],
          exportDeps(adapter, { env: { SCOUTLINE_ARTIFACTS_DIR: dir }, now: fixedNow }),
        );
        assert.strictEqual(status, 0);
        outs.push(parseEnvelope(stdout).markdown);
      }
      assert.strictEqual(outs[0], outs[1], "section order derives from timestamps, not append order");
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });
});

describe("T6c: --since boundary (lower bound, INCLUSIVE ≥)", () => {
  it("entry timestamp EQUAL to --since is INCLUDED; earlier excluded (off-by-one mutation pin)", async () => {
    const artifactsDir = makeTempDir("scoutline-export-since-");
    const { adapter, stdout, stderr } = makeAdapter();
    const atBoundary = T0 - 2 * H;
    try {
      await seedStore(artifactsDir, [
        fullEntry({ requestId: "r-before", timestamp: T0 - 5 * H, query: "early", skeleton: { results: [] } }),
        fullEntry({ requestId: "r-exact", timestamp: atBoundary, query: "boundary", skeleton: { results: [] } }),
        fullEntry({ requestId: "r-after", timestamp: T0 - 1 * H, query: "late", skeleton: { results: [] } }),
      ]);
      const status = await main(
        ["history", "export", "--since", new Date(atBoundary).toISOString()],
        exportDeps(adapter, { env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir }, now: fixedNow }),
      );
      assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
      const envelope = parseEnvelope(stdout);
      assert.strictEqual(envelope.total, 2, "boundary-equal IN + after IN; before OUT");
      const markdown = envelope.markdown;
      assert.ok(!markdown.includes("r-before"), "entry before --since excluded");
      assert.ok(markdown.includes("r-exact"), "boundary-equal entry INCLUDED (≥)");
      assert.ok(markdown.includes("r-after"));
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });

  it("--since accepts epoch-ms too (family-tolerant date parsing)", async () => {
    const artifactsDir = makeTempDir("scoutline-export-sincems-");
    const { adapter, stdout } = makeAdapter();
    const atBoundary = T0 - 2 * H;
    try {
      await seedStore(artifactsDir, [
        fullEntry({ requestId: "r-exact", timestamp: atBoundary, query: "boundary", skeleton: { results: [] } }),
        fullEntry({ requestId: "r-after", timestamp: T0 - 1 * H, query: "late", skeleton: { results: [] } }),
      ]);
      const status = await main(
        ["history", "export", "--since", String(atBoundary)],
        exportDeps(adapter, { env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir }, now: fixedNow }),
      );
      assert.strictEqual(status, 0);
      assert.strictEqual(parseEnvelope(stdout).total, 2);
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });
});

describe("T6c: I/O honesty (zero network, zero cache reads, masters never opened, read-only)", () => {
  before(() => armFetchSpy());
  after(() => disarmFetchSpy());

  it("export makes ZERO network calls, ZERO cache reads, never opens masters for content (spies); store byte-identical", async () => {
    const artifactsDir = makeTempDir("scoutline-export-io-");
    const { adapter, stdout, stderr } = makeAdapter();
    // Cache-read tripwire: counting caches whose .get THROWS — the
    // recall-test pattern (history dispatches before cache wiring
    // today; the pin holds even if that changes).
    const throwingCache = () => ({
      async get() {
        throw new Error("EXPORT READ THE RESPONSE CACHE");
      },
      async set() {
        throw new Error("EXPORT WROTE THE RESPONSE CACHE");
      },
    });
    try {
      await seedStore(artifactsDir, [
        FIXTURES.eNew,
        saveEntry({ requestId: FIXTURES.eNew.saveRef, timestamp: FIXTURES.eNew.timestamp, masterPath: `${FIXTURES.eNew.saveRef}.json` }),
      ]);
      // Master-open-for-content tripwire: the save's master exists but
      // is chmod 0o000 — any content read during export surfaces as
      // EACCES and fails the run (existence stat is allowed; it opens
      // nothing — mode bits do not affect stat).
      const masterPath = join(artifactsDir, `${FIXTURES.eNew.saveRef}.json`);
      // Sentinel body: a readFile-for-content leak surfaces verbatim in
      // the dossier (master content must never reach the render).
      writeFileSync(masterPath, JSON.stringify({ body: "MASTER-BODY-SENTINEL-NEVER-RENDER" }), "utf8");
      const { chmodSync } = await import("node:fs");
      chmodSync(masterPath, 0o000);
      const before = readFileSync(join(artifactsDir, "index.json"), "utf8");
      const status = await main(
        ["history", "export"],
        exportDeps(adapter, {
          env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir },
          now: fixedNow,
          searchCache: throwingCache(),
          readerCache: throwingCache(),
          crawlCache: throwingCache(),
          mapCache: throwingCache(),
          researchCache: throwingCache(),
          repositoryCache: throwingCache(),
        }),
      );
      assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
      assert.strictEqual(fetchAttempts.length, 0, `fetch spy fired: ${JSON.stringify(fetchAttempts)}`);
      const envelope = parseEnvelope(stdout);
      assert.strictEqual(envelope.total, 1);
      assert.ok(envelope.markdown.includes(FIXTURES.eNew.saveRef), "saveRef rendered as pointer");
      // The master exists on disk (unreadable 0o000 — stat still sees
      // it): the pointer must render WITHOUT "(missing)". A
      // readFile-for-content probe instead of a stat surfaces EACCES
      // here and renders "(missing)" — the body-fetch mutation pin.
      assert.ok(
        !envelope.markdown.includes(`${FIXTURES.eNew.saveRef} (missing)`),
        "existence probe must be a stat, not a content read (chmod'd master exists)",
      );
      assert.ok(
        !envelope.markdown.includes("MASTER-BODY-SENTINEL-NEVER-RENDER"),
        "master body content leaked into the dossier (content must never be read)",
      );
      // Read-only: store byte-identical after export.
      const after = readFileSync(join(artifactsDir, "index.json"), "utf8");
      assert.strictEqual(after, before, "export mutated the store");
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });

  it("missing master under a saveRef: existence check annotates the pointer as gone (no FILE_ERROR, no fetch)", async () => {
    const artifactsDir = makeTempDir("scoutline-export-missing-master-");
    const { adapter, stdout, stderr } = makeAdapter();
    try {
      await seedStore(artifactsDir, [FIXTURES.eNew]); // saveRef names a save that does not exist
      const status = await main(
        ["history", "export"],
        exportDeps(adapter, { env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir }, now: fixedNow }),
      );
      assert.strictEqual(status, 0, "missing master under saveRef is an annotation, not an error");
      const envelope = parseEnvelope(stdout);
      assert.ok(
        /\(saved artifact \d+ no longer on disk\)|saved artifact: .*missing/.test(envelope.markdown),
        `pointer annotated as missing: ${JSON.stringify(envelope.markdown)}`,
      );
      assert.strictEqual(stderr.filter((l) => l.trim().length > 0).length, 0, "stderr clean on success");
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });
});

describe("T6c: fail-open + validation (family conventions)", () => {
  it("empty/missing store → header-only dossier, exit 0, stderr clean", async () => {
    const artifactsDir = makeTempDir("scoutline-export-empty-");
    const nested = join(artifactsDir, "nope");
    try {
      for (const dir of [artifactsDir, nested]) {
        const { adapter, stdout, stderr } = makeAdapter();
        const status = await main(
          ["history", "export"],
          exportDeps(adapter, { env: { SCOUTLINE_ARTIFACTS_DIR: dir }, now: fixedNow }),
        );
        assert.strictEqual(status, 0);
        const envelope = parseEnvelope(stdout);
        assert.strictEqual(envelope.total, 0);
        assert.strictEqual(envelope.markdown, "# Research journal export\n\n0 finding(s)");
        assert.strictEqual(stderr.filter((l) => l.trim().length > 0).length, 0, "stderr clean on success");
      }
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });

  it("invalid --since value → VALIDATION_ERROR (exit 1, family convention)", async () => {
    const artifactsDir = makeTempDir("scoutline-export-badsince-");
    try {
      for (const argv of [
        ["history", "export", "--since", "not-a-date"],
        ["history", "export", "--since"],
      ]) {
        const { adapter, stderr, stdout } = makeAdapter();
        const status = await main(
          argv,
          exportDeps(adapter, { env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir }, now: fixedNow }),
        );
        assert.strictEqual(status, 1, `argv=${JSON.stringify(argv)}`);
        const envelope = JSON.parse(stderr.find((l) => l.trim().startsWith("{")) ?? "{}");
        assert.strictEqual(envelope.error?.code ?? envelope.code, "VALIDATION_ERROR", `argv=${JSON.stringify(argv)}`);
        assert.strictEqual(stdout.length, 0, "no stdout data on validation error");
      }
      assert.ok(!existsSync(join(artifactsDir, "index.json")), "validation error writes nothing");
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });

  it("unexpected flags/positionals → VALIDATION_ERROR (family convention)", async () => {
    const artifactsDir = makeTempDir("scoutline-export-badflags-");
    try {
      for (const argv of [
        ["history", "export", "--repeats"],
        ["history", "export", "stray-positional"],
      ]) {
        const { adapter, stderr } = makeAdapter();
        const status = await main(
          argv,
          exportDeps(adapter, { env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir }, now: fixedNow }),
        );
        assert.strictEqual(status, 1, `argv=${JSON.stringify(argv)}`);
        const envelope = JSON.parse(stderr.find((l) => l.trim().startsWith("{")) ?? "{}");
        assert.strictEqual(envelope.error?.code ?? envelope.code, "VALIDATION_ERROR", `argv=${JSON.stringify(argv)}`);
      }
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });
});

describe("T6c: help surfaces", () => {
  it("HISTORY_HELP Usage roster carries export; export's own help renders its surface", async () => {
    const h1 = makeAdapter();
    const s1 = await main(["history", "--help"], exportDeps(h1.adapter));
    assert.strictEqual(s1, 0);
    const help = h1.stdout.join("");
    assert.ok(help.includes("scoutline history export [--since <date>]"), "HISTORY_HELP Usage must carry the export line");
    assert.ok(help.includes("export"), "HISTORY_HELP roster carries export");
    assert.ok(!help.includes("read-only inventory"), "identity wording updated for export");

    const h2 = makeAdapter();
    const s2 = await main(["history", "export", "--help"], exportDeps(h2.adapter));
    assert.strictEqual(s2, 0);
    const exportHelp = h2.stdout.join("");
    assert.ok(exportHelp.includes("History export"), "export help renders its own surface");
    assert.ok(exportHelp.includes("--since"), "export help documents --since");
  });

  it("unknown subcommand error roster names export (dispatcher dispatches it)", async () => {
    const artifactsDir = makeTempDir("scoutline-export-roster-");
    try {
      const { adapter, stderr } = makeAdapter();
      const status = await main(
        ["history", "nope"],
        exportDeps(adapter, { env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir }, now: fixedNow }),
      );
      assert.strictEqual(status, 1);
      assert.match(stderr.join(""), /list, show, stats, note, recall, export, clear/);
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });
});
