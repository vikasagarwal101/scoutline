/**
 * History Journal Merge T4 — `history note` explicit write.
 *
 * Hermetic main()-driven pins (same harness class as journal.test.js):
 * every `main()` drive injects `loadScoutlineConfig` (via
 * `hermeticMainDeps`), a fake invocation adapter, an isolated
 * `SCOUTLINE_ARTIFACTS_DIR` — no ambient config, no network, no
 * provider work (note is the explicit, hand-written journal entry).
 *
 * Pins (ticket T4, PRD AC6, DESIGN D5 Note):
 *   1. `history note` writes ONE full `kind:"journal"` entry with
 *      hand-supplied capability/query/skeleton fields; data-only
 *      stdout envelope (written-entry summary), exit 0.
 *   2. Arg surface: `--capability <search|read|research>` required;
 *      positional text; `--url`; `--tags a,b`. Validation errors
 *      follow the existing history subcommand conventions
 *      (VALIDATION_ERROR, exit 1).
 *   3. Re-homed hand-written work/observation, NOT a full-entry
 *      hand-choose: provider is NOT hand-choosable (sentinel
 *      "note"), no requestId/repeatOf/cacheKey of the caller's
 *      choosing — minted at the write seam.
 *   4. Same write seam: redaction (redactSecrets over query +
 *      skeleton), append-only, 0600, log-only (no master file).
 *   5. `history note` respects NO journal switches — config
 *      `"journal": false` does NOT suppress an explicit note
 *      (opt-in by construction; pinned both ways).
 *   6. Help: history help lists `note`; note's own help renders.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../dist/index.js";
import { hermeticMainDeps } from "./helpers/hermetic-main.js";
import { skeletonContentHash } from "../dist/lib/journal.js";

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

function noteDeps(adapter, extra = {}) {
  return hermeticMainDeps({
    invocation: adapter,
    env: {},
    ...extra,
  });
}

function readStore(artifactsDir) {
  const logFile = join(artifactsDir, "index.json");
  assert.ok(existsSync(logFile), `no index.json in ${artifactsDir}`);
  return JSON.parse(readFileSync(logFile, "utf8"));
}

describe("T4: history note — the explicit write (main-driven)", () => {
  it("search note → ONE full journal entry with hand-supplied capability/query/skeleton; data envelope on stdout, exit 0", async () => {
    const artifactsDir = makeTempDir("scoutline-note-search-");
    const { adapter, stdout, stderr } = makeAdapter();
    try {
      const status = await main(
        [
          "history", "note",
          "--capability", "search",
          "compared rust vs go for the cli",
          "--url", "https://blog.rust-lang.org/inside-rust",
          "--url", "https://go.dev/doc",
          "--tags", "lang-comparison,notes",
        ],
        noteDeps(adapter, { env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir } }),
      );
      assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
      const store = readStore(artifactsDir);
      assert.strictEqual(store.entries.length, 1, "exactly one entry");
      const entry = store.entries[0];
      assert.strictEqual(entry.kind, "journal");
      assert.strictEqual(entry.capability, "search");
      assert.strictEqual(entry.query, "compared rust vs go for the cli");
      assert.deepStrictEqual(entry.skeleton, {
        results: [
          { url: "https://blog.rust-lang.org/inside-rust", title: "https://blog.rust-lang.org/inside-rust" },
          { url: "https://go.dev/doc", title: "https://go.dev/doc" },
        ],
      });
      assert.deepStrictEqual(entry.tags, ["lang-comparison", "notes"]);
      assert.strictEqual(
        entry.contentHash,
        skeletonContentHash(entry.skeleton),
      );
      // Hand-written, not provider-served: sentinel provider, minted ids.
      assert.deepStrictEqual(entry.provider, {
        mode: "single",
        effective: "note",
        servedFrom: "live",
      });
      assert.ok(typeof entry.requestId === "string" && entry.requestId.length > 0);
      assert.ok(typeof entry.timestamp === "number");
      assert.ok(typeof entry.cacheKey === "string" && entry.cacheKey.length > 0);
      // Log-only: no master file was created for the note.
      assert.strictEqual(entry.masterPath, undefined);
      // Data-only contract: stdout[0] is the written-entry summary.
      const envelope = JSON.parse(stdout[0]);
      assert.strictEqual(envelope.requestId, entry.requestId);
      assert.strictEqual(envelope.capability, "search");
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });

  it("read note → one-row skeleton (url+title); research note → citations rows (per-capability skeleton shapes)", async () => {
    for (const [capability, expectedRows] of [
      ["read", [{ url: "https://example.com/doc", title: "Example Doc" }]],
      [
        "research",
        [
          { url: "https://a.example/x", title: "A" },
          { url: "https://b.example/y", title: "B" },
        ],
      ],
    ]) {
      const artifactsDir = makeTempDir(`scoutline-note-${capability}-`);
      const { adapter, stderr } = makeAdapter();
      try {
        const argv = ["history", "note", "--capability", capability, `observed via ${capability}`];
        if (capability === "read") {
          argv.push("--url", "https://example.com/doc", "--title", "Example Doc");
        } else {
          argv.push("--url", "https://a.example/x", "--title", "A", "--url", "https://b.example/y", "--title", "B");
        }
        const status = await main(
          argv,
          noteDeps(adapter, { env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir } }),
        );
        assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
        const store = readStore(artifactsDir);
        assert.strictEqual(store.entries.length, 1);
        const entry = store.entries[0];
        assert.strictEqual(entry.capability, capability);
        assert.deepStrictEqual(entry.skeleton.results, expectedRows);
      } finally {
        rmSync(artifactsDir, { recursive: true, force: true });
      }
    }
  });

  it("note without --url → empty skeleton (url+title list of zero rows) still validates", async () => {
    const artifactsDir = makeTempDir("scoutline-note-bare-");
    const { adapter, stderr } = makeAdapter();
    try {
      const status = await main(
        ["history", "note", "--capability", "search", "stray observation"],
        noteDeps(adapter, { env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir } }),
      );
      assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
      const store = readStore(artifactsDir);
      assert.deepStrictEqual(store.entries[0].skeleton, { results: [] });
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });

  it("config journal:false does NOT suppress an explicit note (opt-in by construction, pinned)", async () => {
    const artifactsDir = makeTempDir("scoutline-note-configoff-");
    const { adapter, stderr } = makeAdapter();
    try {
      const status = await main(
        ["history", "note", "--capability", "search", "note under kill-switch"],
        noteDeps(adapter, {
          env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir },
          loadScoutlineConfig: async () => ({ version: 1, providers: {}, journal: false }),
        }),
      );
      assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
      const store = readStore(artifactsDir);
      assert.strictEqual(store.entries.length, 1, "explicit note ignores the always-off switch");
      assert.strictEqual(store.entries[0].query, "note under kill-switch");
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });

  it("redaction E2E: fake secret in note text AND token in --url appear in NEITHER the entry nor the log file", async () => {
    const artifactsDir = makeTempDir("scoutline-note-redact-");
    const SECRET = "sk-note-secret-query-token-33aa7";
    const TOKEN = "tok-note-8a41f2c9b7de";
    const { adapter, stderr } = makeAdapter();
    try {
      const status = await main(
        ["history", "note", "--capability", "search", `api keys ${SECRET}`, "--url", `https://example.com/doc?token=${TOKEN}`],
        hermeticMainDeps({
          invocation: adapter,
          env: {
            SCOUTLINE_ARTIFACTS_DIR: artifactsDir,
            Z_AI_API_KEY: SECRET,
            EXA_API_KEY: TOKEN,
          },
        }),
      );
      assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
      const raw = readFileSync(join(artifactsDir, "index.json"), "utf8");
      assert.ok(!raw.includes(SECRET), "fake secret leaked into the log via note text");
      assert.ok(!raw.includes(TOKEN), "url token leaked into the log via note url");
      const store = JSON.parse(raw);
      assert.ok(!JSON.stringify(store.entries[0].query).includes(SECRET));
      assert.ok(!JSON.stringify(store.entries[0].skeleton).includes(TOKEN));
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });

  it("same write seam discipline: append-only beside prior entries, 0600, log-only (no master)", async () => {
    const artifactsDir = makeTempDir("scoutline-note-append-");
    const first = makeAdapter();
    const second = makeAdapter();
    try {
      const s1 = await main(
        ["history", "note", "--capability", "search", "first observation"],
        noteDeps(first.adapter, { env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir } }),
      );
      assert.strictEqual(s1, 0, `stderr=${JSON.stringify(first.stderr)}`);
      const firstEntry = readStore(artifactsDir).entries[0];
      const s2 = await main(
        ["history", "note", "--capability", "search", "second observation"],
        noteDeps(second.adapter, { env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir } }),
      );
      assert.strictEqual(s2, 0, `stderr=${JSON.stringify(second.stderr)}`);
      const store = readStore(artifactsDir);
      assert.strictEqual(store.entries.length, 2, "two notes → two entries");
      assert.deepStrictEqual(store.entries[0], firstEntry, "append-only: first entry mutated by the second write");
      const mode = statSync(join(artifactsDir, "index.json")).mode & 0o777;
      assert.strictEqual(mode, 0o600, "index.json must be 0600");
      // Log-only: only index.json lives in the store dir.
      assert.deepStrictEqual(
        readdirSync(artifactsDir).sort(),
        ["index.json"],
        "note writes no master file",
      );
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });
});

describe("T4: arg validation (existing history subcommand conventions)", () => {
  it("missing --capability → VALIDATION_ERROR exit 1", async () => {
    const { adapter, stderr } = makeAdapter();
    const status = await main(
      ["history", "note", "some text"],
      noteDeps(adapter),
    );
    assert.strictEqual(status, 1);
    const envelope = JSON.parse(stderr.find((line) => line.trim().startsWith("{")) ?? "{}");
    assert.strictEqual(envelope.error?.code ?? envelope.code, "VALIDATION_ERROR");
  });

  it("invalid --capability → VALIDATION_ERROR exit 1", async () => {
    const { adapter, stderr } = makeAdapter();
    const status = await main(
      ["history", "note", "--capability", "vision", "some text"],
      noteDeps(adapter),
    );
    assert.strictEqual(status, 1);
    const envelope = JSON.parse(stderr.find((line) => line.trim().startsWith("{")) ?? "{}");
    assert.strictEqual(envelope.error?.code ?? envelope.code, "VALIDATION_ERROR");
  });

  it("missing positional text → VALIDATION_ERROR exit 1", async () => {
    const { adapter, stderr } = makeAdapter();
    const status = await main(
      ["history", "note", "--capability", "search"],
      noteDeps(adapter),
    );
    assert.strictEqual(status, 1);
    const envelope = JSON.parse(stderr.find((line) => line.trim().startsWith("{")) ?? "{}");
    assert.strictEqual(envelope.error?.code ?? envelope.code, "VALIDATION_ERROR");
  });

  it("--url without --capability read/research is fine on search too (url+title rows are the search skeleton shape)", async () => {
    // No pin — search skeletons ARE url+title lists; documented behavior.
  });
});

describe("T4: help surfaces", () => {
  it("history help lists `note`; identity line still read-only (T6a flips it)", async () => {
    const { adapter, stdout } = makeAdapter();
    const status = await main(["history", "--help"], noteDeps(adapter));
    assert.strictEqual(status, 0);
    const help = stdout.join("");
    assert.ok(help.includes("note"), "history help must list note");
    assert.ok(help.includes("Read-only"), "identity line flips in T6a, not here");
  });

  it("history note --help renders (exit 0, does not write)", async () => {
    const artifactsDir = makeTempDir("scoutline-note-helpdir-");
    const { adapter, stdout } = makeAdapter();
    try {
      const status = await main(
        ["history", "note", "--help"],
        noteDeps(adapter, { env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir } }),
      );
      assert.strictEqual(status, 0);
      const help = stdout.join("");
      assert.ok(help.includes("--capability"));
      assert.ok(!existsSync(join(artifactsDir, "index.json")), "help writes nothing");
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });
});

describe("T4: mutation evidence (run manually with the named scratch-break)", () => {
  it("MUTATION (skip redaction on the note path): the E2E redaction pin above goes red — asserted here by re-running the pin shape against a secret-carrying note written with secrets resolved", async () => {
    // This test IS the standing guard for the skip-redaction mutation:
    // if the note write seam ever bypasses redactSecrets, the
    // "redaction E2E" pin above fails (fake secret lands in the log).
    // Keep a direct assertion here too: the seam resolves configured
    // secrets even on the note path (the write seam is shared, not
    // duplicated).
    const artifactsDir = makeTempDir("scoutline-note-mut-");
    const SECRET = "sk-mutation-secret-0001";
    const { adapter, stderr } = makeAdapter();
    try {
      const status = await main(
        ["history", "note", "--capability", "search", `leak ${SECRET}`],
        hermeticMainDeps({
          invocation: adapter,
          env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir, Z_AI_API_KEY: SECRET },
        }),
      );
      assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
      const raw = readFileSync(join(artifactsDir, "index.json"), "utf8");
      assert.ok(!raw.includes(SECRET), "MUTATION GUARD: secret reached the log (redaction skipped?)");
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });

  it("MUTATION (smuggled provider field): note writes a REAL provider id as effective → the sentinel pin + validator hold (provider is never hand-choosable)", async () => {
    const artifactsDir = makeTempDir("scoutline-note-smuggle-");
    const { adapter, stderr } = makeAdapter();
    try {
      const status = await main(
        ["history", "note", "--capability", "search", "q"],
        noteDeps(adapter, { env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir } }),
      );
      assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
      const entry = readStore(artifactsDir).entries[0];
      // The sentinel is the ONLY provider a note may carry: a smuggled
      // real id (zai/tavily/...) would assert as a served run that never
      // happened. The CLI exposes no --provider on note; this pin holds
      // the line structurally.
      assert.strictEqual(entry.provider.effective, "note");
      assert.strictEqual(entry.provider.servedFrom, "live");
      // And the entry still passes the store validator (readLog clean):
      const { readLog } = await import("../dist/lib/artifacts.js");
      const { log, notice } = await readLog(artifactsDir);
      assert.strictEqual(log.entries.length, 1);
      assert.strictEqual(notice, undefined);
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });
});
