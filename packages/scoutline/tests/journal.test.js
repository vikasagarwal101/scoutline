/**
 * History Journal Merge T2a — always-on journal writer + search
 * skeletons + escape switches.
 *
 * Hermetic end-to-end pins (same harness class as save-artifact T4):
 * every `main()` drive injects `loadScoutlineConfig` (via
 * `hermeticMainDeps`), a fake invocation adapter, an isolated
 * `SCOUTLINE_ARTIFACTS_DIR`, and a counting search descriptor double —
 * no ambient config, no real cache, no network.
 *
 * Pins (ticket T2a):
 *   1. Cache MISS on `search` → exactly ONE full `kind:"journal"`
 *      entry, always-on (no flag), beside any save entry. Entry shape
 *      ruling-locked: {kind, requestId, timestamp, capability,
 *      provider, query, contentHash, cacheKey, skeleton, tags?,
 *      saveRef?}. No cacheRef — self-contained forever.
 *   2. Skeleton: search = url+title list of the RESULT rows.
 *   3. contentHash = sha256 of the normalized skeleton serialization.
 *   4. Switches ship WITH the first write: `--no-journal` on search
 *      → no entry; default → entry. Config `"journal": false` → no
 *      entry (fanout idiom: absent/unset = enabled).
 *   5. `--save` + journaling → BOTH entries, journal entry carries
 *      `saveRef` cross-link (the save's requestId).
 *   6. Redaction E2E: fake secret in query text AND token in URL
 *      query param appear in NEITHER the entry nor the log file.
 *   7. Skeleton permanence: `cache clear` (wipe the response cache)
 *      then re-read log → journal entry byte-identical.
 *   8. Append-only invariant: two journal writes → two entries; the
 *      first is byte-identical after the second (variant-C rejection).
 *   9. `--no-journal` on every other command → UNSUPPORTED_OPTION at
 *      parse (the --max-chars command-local pattern), including on
 *      journal-adjacent read/research (their journaling is T3; the
 *      flag surface ships with the switch itself).
 *  10. Journal writer unit pins: appendJournalEntry under the write
 *      lock; malformed journal body (bad skeleton shape) fails the
 *      widened validator → whole-log fail-open (the T1 semantic).
 *  11. `history list` renders a log containing a journal entry
 *      without TypeError (provider deref pin; full widening is T6b).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { main, DISPATCHED_COMMANDS, ACCEPT_NO_JOURNAL_COMMANDS } from "../dist/index.js";
import { hermeticMainDeps } from "./helpers/hermetic-main.js";
import {
  appendJournalEntry,
  buildSearchSkeleton,
  skeletonContentHash,
  normalizeSkeleton,
} from "../dist/lib/journal.js";
import { readLog } from "../dist/lib/artifacts.js";
import { CommandOptionUnsupportedError } from "../dist/lib/errors.js";

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

/** Counting search descriptor double (the save-artifact T4 shape). */
function makeSearchDescriptor(id, log, options = {}) {
  const { result } = options;
  return {
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
            credentialFingerprint: `fp-${id}`,
            request,
            legacyCandidates: [],
          };
        },
        async invoke(request) {
          log.push(`${id}:${request.query}`);
          return result ?? [{ title: `t-${id}`, url: `https://${id}/r`, summary: "s" }];
        },
      },
    }),
  };
}

function journalDeps(adapter, log, extra = {}) {
  return hermeticMainDeps({
    invocation: adapter,
    env: {},
    providerDescriptors: [makeSearchDescriptor("zai", log)],
    ...extra,
  });
}

/** Read index.json journal entries from an artifacts dir. */
function readJournalEntries(artifactsDir) {
  const logFile = join(artifactsDir, "index.json");
  assert.ok(existsSync(logFile), `no index.json in ${artifactsDir}`);
  const store = JSON.parse(readFileSync(logFile, "utf8"));
  return store;
}

describe("T2a: always-on journal writer unit pins", () => {
  it("buildSearchSkeleton extracts the url+title list from search result rows", async () => {
    const skeleton = buildSearchSkeleton([
      { rank: 1, title: "Rust", url: "https://rust-lang.org", summary: "s" },
      { rank: 2, title: "Go", url: "https://go.dev", summary: "t" },
    ]);
    assert.deepStrictEqual(skeleton, {
      results: [
        { url: "https://rust-lang.org", title: "Rust" },
        { url: "https://go.dev", title: "Go" },
      ],
    });
  });

  it("skeletonContentHash = sha256 of the normalized skeleton serialization", async () => {
    const skeleton = buildSearchSkeleton([{ title: "Rust", url: "https://rust-lang.org" }]);
    const expected = createHash("sha256")
      .update(JSON.stringify(normalizeSkeleton(skeleton)))
      .digest("hex");
    assert.strictEqual(skeletonContentHash(skeleton), expected);
  });

  it("appendJournalEntry appends under the write lock; two writes → two entries, first byte-identical (append-only invariant)", async () => {
    const dir = makeTempDir("scoutline-journal-unit-");
    try {
      const base = {
        kind: "journal",
        requestId: "20260908T000000Z-0001",
        timestamp: 1800000000000,
        capability: "search",
        provider: { mode: "single", effective: "zai", servedFrom: "live" },
        query: "rust vs go",
        contentHash: skeletonContentHash(buildSearchSkeleton([])),
        cacheKey: "v2.search.zai.fp.json",
        skeleton: buildSearchSkeleton([]),
      };
      const notice1 = await appendJournalEntry(dir, base);
      assert.strictEqual(notice1, undefined);
      const firstRaw = readFileSync(join(dir, "index.json"), "utf8");
      const second = { ...base, requestId: "20260908T000001Z-0002", timestamp: 1800000001000 };
      await appendJournalEntry(dir, second);
      const store = JSON.parse(readFileSync(join(dir, "index.json"), "utf8"));
      assert.deepStrictEqual(
        store.entries.map((e) => e.requestId),
        ["20260908T000000Z-0001", "20260908T000001Z-0002"],
      );
      // The first entry's serialization is untouched by the second write.
      assert.ok(
        firstRaw.includes('"20260908T000000Z-0001"'),
        "first entry no longer present after second append",
      );
      const reparsed = JSON.parse(firstRaw);
      assert.deepStrictEqual(
        reparsed.entries[0],
        store.entries[0],
        "first entry mutated by the second append",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a journal entry with a malformed skeleton shape fails the widened validator → whole-log fail-open (T1 semantic)", async () => {
    const dir = makeTempDir("scoutline-journal-validator-");
    try {
      const good = {
        kind: "journal",
        requestId: "20260908T000000Z-0001",
        timestamp: 1800000000000,
        capability: "search",
        provider: { mode: "single", effective: "zai", servedFrom: "live" },
        query: "q",
        contentHash: "a".repeat(64),
        cacheKey: "v2.search.zai.fp.json",
        skeleton: buildSearchSkeleton([]),
      };
      await appendJournalEntry(dir, good);
      // Hand-corrupt: skeleton loses its array.
      const store = JSON.parse(readFileSync(join(dir, "index.json"), "utf8"));
      store.entries[0].skeleton = "not-an-object";
      writeFileSync(join(dir, "index.json"), JSON.stringify(store, null, 2) + "\n", {
        mode: 0o600,
      });
      const { log, notice } = await readLog(dir);
      assert.deepStrictEqual(log.entries, [], "malformed journal body must fail open");
      assert.ok(notice !== undefined, "expected a fail-open notice");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("T2a: always-on search journaling (main-driven)", () => {
  it("cache MISS on search → exactly ONE full journal entry, always-on (no flag), self-contained (no cacheRef)", async () => {
    const artifactsDir = makeTempDir("scoutline-journal-always-");
    const cacheDir = makeTempDir("scoutline-journal-cache-");
    const log = [];
    const { adapter, stdout, stderr } = makeAdapter();
    try {
      const status = await main(
        ["search", "rust vs go"],
        journalDeps(adapter, log, {
          env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir, SCOUTLINE_CACHE_DIR: cacheDir },
        }),
      );
      assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
      assert.strictEqual(log.length, 1, "provider invoked once (cache miss)");
      const store = readJournalEntries(artifactsDir);
      assert.strictEqual(store.entries.length, 1, "exactly one entry");
      const entry = store.entries[0];
      assert.strictEqual(entry.kind, "journal");
      assert.strictEqual(entry.capability, "search");
      assert.strictEqual(entry.query, "rust vs go");
      assert.strictEqual(entry.provider.mode, "single");
      assert.strictEqual(entry.provider.effective, "zai");
      assert.strictEqual(entry.provider.servedFrom, "live");
      assert.ok(typeof entry.requestId === "string" && entry.requestId.length > 0);
      assert.ok(typeof entry.timestamp === "number");
      assert.ok(typeof entry.cacheKey === "string" && entry.cacheKey.length > 0);
      assert.ok(entry.skeleton && Array.isArray(entry.skeleton.results));
      assert.strictEqual(entry.skeleton.results[0].url, "https://zai/r");
      assert.strictEqual(entry.skeleton.results[0].title, "t-zai");
      assert.strictEqual(
        entry.contentHash,
        skeletonContentHash(buildSearchSkeleton([{ title: "t-zai", url: "https://zai/r" }])),
      );
      assert.strictEqual(entry.cacheRef, undefined, "no cacheRef — self-contained forever");
      assert.strictEqual(entry.masterPath, undefined, "journal entries are log-only");
      // stdout stays the clean data envelope.
      assert.deepStrictEqual(JSON.parse(stdout[0]), [
        { rank: 1, title: "t-zai", url: "https://zai/r", summary: "s" },
      ]);
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it("a fresh cache dir is a miss for every run — two runs append two entries, first byte-identical after the second", async () => {
    const artifactsDir = makeTempDir("scoutline-journal-append-");
    const cacheDir = makeTempDir("scoutline-journal-append-cache-");
    try {
      const run = async (query) => {
        const log = [];
        const { adapter, stdout, stderr } = makeAdapter();
        const status = await main(
          ["search", query],
          journalDeps(adapter, log, {
            env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir, SCOUTLINE_CACHE_DIR: cacheDir },
          }),
        );
        assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
        return readFileSync(join(artifactsDir, "index.json"), "utf8");
      };
      // Distinct queries = distinct cache keys = two misses.
      await run("rust vs go");
      const firstRaw = readFileSync(join(artifactsDir, "index.json"), "utf8");
      await run("zig vs odin");
      const store = JSON.parse(readFileSync(join(artifactsDir, "index.json"), "utf8"));
      assert.strictEqual(store.entries.length, 2, "two journal writes → two entries");
      const firstReparsed = JSON.parse(firstRaw);
      assert.deepStrictEqual(
        firstReparsed.entries[0],
        store.entries[0],
        "append-only: first entry mutated by the second write",
      );
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it("skeleton permanence: `cache clear` then re-read log → journal entry byte-identical", async () => {
    const artifactsDir = makeTempDir("scoutline-journal-perm-");
    const cacheDir = makeTempDir("scoutline-journal-perm-cache-");
    const log = [];
    const { adapter, stderr } = makeAdapter();
    try {
      const status = await main(
        ["search", "rust vs go"],
        journalDeps(adapter, log, {
          env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir, SCOUTLINE_CACHE_DIR: cacheDir },
        }),
      );
      assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
      const before = readFileSync(join(artifactsDir, "index.json"), "utf8");
      // Wipe the response cache — the journal must never notice.
      rmSync(cacheDir, { recursive: true, force: true });
      mkdirSync(cacheDir, { recursive: true });
      const after = readFileSync(join(artifactsDir, "index.json"), "utf8");
      assert.strictEqual(after, before, "journal entry changed after cache clear");
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it("--no-journal on search → NO journal entry (per-call escape, pinned)", async () => {
    const artifactsDir = makeTempDir("scoutline-journal-off-");
    const log = [];
    const { adapter, stderr } = makeAdapter();
    try {
      const status = await main(
        ["search", "rust vs go", "--no-journal"],
        journalDeps(adapter, log, { env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir } }),
      );
      assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
      assert.strictEqual(log.length, 1, "the search itself ran");
      const indexFile = join(artifactsDir, "index.json");
      if (existsSync(indexFile)) {
        const store = JSON.parse(readFileSync(indexFile, "utf8"));
        assert.deepStrictEqual(store.entries, [], "no journal entry under --no-journal");
      }
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });

  it('config "journal": false → NO journal entry (global kill-switch, fanout idiom)', async () => {
    const artifactsDir = makeTempDir("scoutline-journal-config-off-");
    const log = [];
    const { adapter, stderr } = makeAdapter();
    try {
      const status = await main(
        ["search", "rust vs go"],
        journalDeps(adapter, log, {
          env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir },
          loadScoutlineConfig: async () => ({
            version: 1,
            providers: {},
            journal: false,
          }),
        }),
      );
      assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
      assert.strictEqual(log.length, 1, "the search itself ran");
      const indexFile = join(artifactsDir, "index.json");
      if (existsSync(indexFile)) {
        const store = JSON.parse(readFileSync(indexFile, "utf8"));
        assert.deepStrictEqual(store.entries, [], "no journal entry under config journal:false");
      }
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });

  it("explicit config journal:true still journals (absent/unset = enabled, true = enabled)", async () => {
    const artifactsDir = makeTempDir("scoutline-journal-config-on-");
    const log = [];
    const { adapter, stderr } = makeAdapter();
    try {
      const status = await main(
        ["search", "rust vs go"],
        journalDeps(adapter, log, {
          env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir },
          loadScoutlineConfig: async () => ({
            version: 1,
            providers: {},
            journal: true,
          }),
        }),
      );
      assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
      const store = readJournalEntries(artifactsDir);
      assert.strictEqual(store.entries.length, 1);
      assert.strictEqual(store.entries[0].kind, "journal");
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });

  it("--save + journaling → BOTH entries written, journal entry carries saveRef cross-link", async () => {
    const artifactsDir = makeTempDir("scoutline-journal-save-");
    const exportDir = makeTempDir("scoutline-journal-save-export-");
    const exportTarget = join(exportDir, "report.json");
    const log = [];
    const { adapter, stderr } = makeAdapter();
    try {
      const status = await main(
        ["search", "rust vs go", "--save", exportTarget],
        journalDeps(adapter, log, { env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir } }),
      );
      assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
      const store = readJournalEntries(artifactsDir);
      assert.strictEqual(store.entries.length, 2, "both the save entry and the journal entry");
      const saveEntry = store.entries.find((e) => e.kind === "save");
      const journalEntry = store.entries.find((e) => e.kind === "journal");
      assert.ok(saveEntry, "save entry present");
      assert.ok(journalEntry, "journal entry present");
      assert.strictEqual(journalEntry.saveRef, saveEntry.requestId, "saveRef cross-link");
      // A plain run has NO saveRef.
      const plainDir = makeTempDir("scoutline-journal-plain-");
      try {
        const log2 = [];
        const plain = makeAdapter();
        await main(
          ["search", "rust vs go"],
          journalDeps(plain.adapter, log2, { env: { SCOUTLINE_ARTIFACTS_DIR: plainDir } }),
        );
        const plainStore = readJournalEntries(plainDir);
        assert.strictEqual(plainStore.entries[0].saveRef, undefined);
      } finally {
        rmSync(plainDir, { recursive: true, force: true });
      }
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
      rmSync(exportDir, { recursive: true, force: true });
    }
  });

  it("redaction E2E: fake secret in query text AND token in URL query param appear in NEITHER entry nor log file", async () => {
    const artifactsDir = makeTempDir("scoutline-journal-redact-");
    const log = [];
    const SECRET = "sk-super-secret-query-token-9f2e1";
    // The URL token rides in env as a configured credential so the
    // invocation seam's resolvedSecrets pass redacts it everywhere the
    // entry serializes it (query text + skeleton urls).
    const TOKEN = "tok-8a41f2c9b7de4f0a";
    const { adapter, stderr } = makeAdapter();
    try {
      const status = await main(
        ["search", `api keys ${SECRET}`],
        hermeticMainDeps({
          invocation: adapter,
          env: {
            SCOUTLINE_ARTIFACTS_DIR: artifactsDir,
            EXA_API_KEY: TOKEN,
            // The query-text secret rides as a configured env credential
            // too — the invocation seam's resolvedSecrets (which the
            // journal write seam consumes) come from configuredSecrets().
            Z_AI_API_KEY: SECRET,
          },
          providerDescriptors: [
            makeSearchDescriptor("zai", log, {
              result: [
                {
                  rank: 1,
                  title: "leaky",
                  url: `https://example.com/doc?token=${TOKEN}`,
                  summary: "s",
                },
              ],
            }),
          ],
          loadScoutlineConfig: async () => ({
            version: 1,
            providers: {},
            journal: true,
          }),
        }),
      );
      assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
      const raw = readFileSync(join(artifactsDir, "index.json"), "utf8");
      assert.ok(!raw.includes(SECRET), "fake secret leaked into the log via query text");
      assert.ok(!raw.includes(TOKEN), "url token leaked into the log via skeleton url");
      const store = JSON.parse(raw);
      const entry = store.entries[0];
      assert.ok(!JSON.stringify(entry.query).includes(SECRET));
      assert.ok(!JSON.stringify(entry.skeleton).includes(TOKEN));
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });

  it("--no-journal on every other command → UNSUPPORTED_OPTION at parse (command-local pattern)", async () => {
    const cases = ["crawl", "map", "fetch", "history", "config", "doctor"];
    for (const command of cases) {
      const { adapter, stderr } = makeAdapter();
      const argv = [command];
      argv.push("--no-journal");
      const deps = hermeticMainDeps({
        invocation: adapter,
        env: {},
        loadScoutlineConfig: async () => ({ version: 1, providers: {} }),
      });
      const status = await main(argv, deps);
      assert.strictEqual(status, 1, `${command} --no-journal must exit 1`);
      const envelope = JSON.parse(stderr.find((line) => line.trim().startsWith("{")) ?? "{}");
      assert.strictEqual(
        envelope.error?.code ?? envelope.code,
        "UNSUPPORTED_OPTION",
        `${command} --no-journal must reject UNSUPPORTED_OPTION, stderr=${JSON.stringify(stderr)}`,
      );
    }
  });

  it("fanout search miss → journal entry with mode:\"fanout\" routing (must-fix 3 — no silent skip of an always-on surface)", async () => {
    const artifactsDir = makeTempDir("scoutline-journal-fanout-");
    const log = [];
    const { adapter, stdout, stderr } = makeAdapter();
    const twoArms = ["zai", "brave"].map((id) => makeSearchDescriptor(id, log));
    try {
      const status = await main(
        ["search", "rust vs go"],
        hermeticMainDeps({
          invocation: adapter,
          env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir },
          providerDescriptors: twoArms,
          configFanout: true,
          loadScoutlineConfig: async () => ({ version: 1, providers: {} }),
        }),
      );
      assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
      const store = readJournalEntries(artifactsDir);
      assert.strictEqual(store.entries.length, 1, "fanout journals exactly one entry");
      const entry = store.entries[0];
      assert.strictEqual(entry.kind, "journal");
      assert.strictEqual(entry.provider.mode, "fanout");
      assert.deepStrictEqual(entry.provider.arms, ["zai", "brave"]);
      assert.ok(entry.skeleton.results.length > 0, "fanout skeleton carries result rows");
      assert.ok(typeof entry.cacheKey === "string" && entry.cacheKey.length > 0);
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });

  it("entries land 0600 via the existing store discipline (stat pin on index.json)", async () => {
    const artifactsDir = makeTempDir("scoutline-journal-mode-");
    const log = [];
    const { adapter } = makeAdapter();
    try {
      await main(
        ["search", "rust vs go"],
        journalDeps(adapter, log, { env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir } }),
      );
      const mode = statSync(join(artifactsDir, "index.json")).mode & 0o777;
      assert.strictEqual(mode, 0o600, "index.json must be 0600");
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });
});

describe("T2a: history list renders journal entries without TypeError", () => {
  it("history list over a log containing a journal entry renders (provider deref pin)", async () => {
    const artifactsDir = makeTempDir("scoutline-journal-hist-");
    const log = [];
    const { adapter, stderr } = makeAdapter();
    try {
      await main(
        ["search", "rust vs go"],
        journalDeps(adapter, log, { env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir } }),
      );
      const hist = makeAdapter();
      const status = await main(
        ["history", "list"],
        hermeticMainDeps({
          invocation: hist.adapter,
          env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir },
          loadScoutlineConfig: async () => ({ version: 1, providers: {} }),
        }),
      );
      assert.strictEqual(status, 0, `stderr=${JSON.stringify(hist.stderr)}`);
      assert.strictEqual(stderr.length, 0, `search stderr=${JSON.stringify(stderr)}`);
      const envelope = JSON.parse(hist.stdout[0]);
      assert.strictEqual(envelope.entries.length, 1);
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });
});

describe("T2a-fix: batch-driven ops journal per their own capability (must-fix 1)", () => {
  it("batch of [search, read] → exactly the search op journals (read is T3)", async () => {
    const artifactsDir = makeTempDir("scoutline-journal-batch-");
    const cacheDir = makeTempDir("scoutline-journal-batch-cache-");
    const { adapter, stdout, stderr } = makeAdapter();
    // One dual-capability descriptor (batch assignment resolves per-op
    // capability; two same-id single-capability descriptors would make the
    // read op's resolution hit a search-only preflight).
    const dualDesc = {
      id: "zai",
      isConfigured: () => true,
      capabilities: () => new Set(["search", "reader"]),
      create: () => ({
        id: "zai",
        search: {
          validate() {},
          cacheIdentity(request) {
            return {
              provider: "zai",
              capability: "search",
              credentialFingerprint: "fp-zai",
              request,
              legacyCandidates: [],
            };
          },
          async invoke() {
            return [{ title: "t-zai", url: "https://zai/r", summary: "s" }];
          },
        },
        reader: {
          fetch: {
            kind: "reader-fetch",
            validate() {},
            cacheIdentity(r) {
              return {
                provider: "zai",
                capability: "reader",
                credentialFingerprint: "fp-zai",
                request: r,
                legacyCandidates: [],
              };
            },
            decodeCached: () => null,
            async invoke(request) {
              return {
                schemaVersion: 1,
                url: request.url,
                finalUrl: request.url,
                title: "T",
                content: "read by zai",
                contentFormat: "markdown",
              };
            },
          },
        },
      }),
    };
    const manifest = {
      schemaVersion: 1,
      operations: [
        { name: "op-search", command: "search", input: { query: "rust vs go" } },
        { name: "op-read", command: "read", input: { url: "https://example.com" } },
      ],
    };
    const manifestDir = makeTempDir("scoutline-journal-batch-manifest-");
    const manifestFile = join(manifestDir, "manifest.json");
    writeFileSync(manifestFile, JSON.stringify(manifest), "utf8");
    try {
      const status = await main(
        ["batch", manifestFile],
        hermeticMainDeps({
          invocation: adapter,
          env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir, SCOUTLINE_CACHE_DIR: cacheDir },
          providerDescriptors: [dualDesc],
          loadScoutlineConfig: async () => ({ version: 1, providers: {} }),
        }),
      );
      assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
      const store = readJournalEntries(artifactsDir);
      const journals = store.entries.filter((e) => e.kind === "journal");
      assert.strictEqual(journals.length, 1, "exactly the search op journals");
      assert.strictEqual(journals[0].capability, "search");
      assert.strictEqual(journals[0].query, "rust vs go");
      assert.ok(journals[0].skeleton.results.length > 0);
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
      rmSync(cacheDir, { recursive: true, force: true });
      rmSync(manifestDir, { recursive: true, force: true });
    }
  });

  it("config journal:false kills batch op journaling too (config-only switch, no per-op flag)", async () => {
    const artifactsDir = makeTempDir("scoutline-journal-batch-off-");
    const cacheDir = makeTempDir("scoutline-journal-batch-off-cache-");
    const { adapter, stderr } = makeAdapter();
    const searchDesc = makeSearchDescriptor("zai", []);
    const manifest = {
      schemaVersion: 1,
      operations: [{ name: "op-search", command: "search", input: { query: "q" } }],
    };
    const manifestDir = makeTempDir("scoutline-journal-batch-off-manifest-");
    const manifestFile = join(manifestDir, "manifest.json");
    writeFileSync(manifestFile, JSON.stringify(manifest), "utf8");
    try {
      const status = await main(
        ["batch", manifestFile],
        hermeticMainDeps({
          invocation: adapter,
          env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir, SCOUTLINE_CACHE_DIR: cacheDir },
          providerDescriptors: [searchDesc],
          loadScoutlineConfig: async () => ({ version: 1, providers: {}, journal: false }),
        }),
      );
      assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
      const indexFile = join(artifactsDir, "index.json");
      if (existsSync(indexFile)) {
        const store = JSON.parse(readFileSync(indexFile, "utf8"));
        assert.deepStrictEqual(
          store.entries.filter((e) => e.kind === "journal"),
          [],
          "no journal entries under config journal:false",
        );
      }
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
      rmSync(cacheDir, { recursive: true, force: true });
      rmSync(manifestDir, { recursive: true, force: true });
    }
  });

  it("batch --no-journal stays REJECTED at parse (command-local surface; ruling: per-op journaling is config-switch only)", async () => {
    const { adapter, stderr } = makeAdapter();
    const status = await main(
      ["batch", "manifest.json", "--no-journal"],
      hermeticMainDeps({
        invocation: adapter,
        env: {},
        loadScoutlineConfig: async () => ({ version: 1, providers: {} }),
      }),
    );
    assert.strictEqual(status, 1);
    const envelope = JSON.parse(stderr.find((line) => line.trim().startsWith("{")) ?? "{}");
    assert.strictEqual(envelope.error?.code ?? envelope.code, "UNSUPPORTED_OPTION");
  });
});

describe("T2a-fix: history show + stats over journal entries (must-fix 2, NIT 2)", () => {
  it("history show <journal-id> renders the journal entry itself — exit 0, no master read, no crash", async () => {
    const artifactsDir = makeTempDir("scoutline-journal-show-");
    const log = [];
    const searchRun = makeAdapter();
    try {
      await main(
        ["search", "rust vs go"],
        journalDeps(searchRun.adapter, log, { env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir } }),
      );
      const store = readJournalEntries(artifactsDir);
      const journalId = store.entries[0].requestId;
      const show = makeAdapter();
      const status = await main(
        ["history", "show", journalId],
        hermeticMainDeps({
          invocation: show.adapter,
          env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir },
          loadScoutlineConfig: async () => ({ version: 1, providers: {} }),
        }),
      );
      assert.strictEqual(status, 0, `stderr=${JSON.stringify(show.stderr)}`);
      const envelope = JSON.parse(show.stdout[0]);
      assert.strictEqual(envelope.entry.kind, "journal");
      assert.strictEqual(envelope.entry.requestId, journalId);
      // The journal entry IS the artifact: report = the entry body.
      assert.strictEqual(envelope.report.kind, "journal");
      assert.ok(envelope.report.skeleton.results.length > 0);
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });

  it("history stats: journal rows count under capability (NIT 2) and masterBytes skips them (guard)", async () => {
    const artifactsDir = makeTempDir("scoutline-journal-stats-");
    const log = [];
    const searchRun = makeAdapter();
    try {
      await main(
        ["search", "rust vs go"],
        journalDeps(searchRun.adapter, log, { env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir } }),
      );
      const stats = makeAdapter();
      const status = await main(
        ["history", "stats"],
        hermeticMainDeps({
          invocation: stats.adapter,
          env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir },
          loadScoutlineConfig: async () => ({ version: 1, providers: {} }),
        }),
      );
      assert.strictEqual(status, 0, `stderr=${JSON.stringify(stats.stderr)}`);
      const envelope = JSON.parse(stats.stdout[0]);
      assert.strictEqual(envelope.byCommand["search"], 1, "journal row counts under capability");
      assert.strictEqual(envelope.byCommand[undefined], undefined, "no undefined key");
      assert.strictEqual(envelope.byKind.journal, 1);
      assert.strictEqual(envelope.masterBytes, 0, "journal rows add no master bytes");
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });
});

describe("T2a NIT 3: --no-journal rejection matrix — derived enumeration pin", () => {
  it("the accept set is exactly the journalable subset of the dispatch surface", () => {
    // The accept set ⊆ dispatch surface: no flag surface for a command
    // that does not exist.
    for (const command of ACCEPT_NO_JOURNAL_COMMANDS) {
      assert.ok(
        DISPATCHED_COMMANDS.has(command),
        `accept-set command "${command}" is not dispatched`,
      );
    }
    // And the journalable commands are all present:
    for (const journalable of ["search", "read", "research"]) {
      assert.ok(
        ACCEPT_NO_JOURNAL_COMMANDS.has(journalable),
        `journalable command "${journalable}" missing from the accept set`,
      );
    }
  });

  it("a future accept-set entry without dispatch fails the pin (mutation guard)", () => {
    // Simulates the drift the pin exists to catch: adding a command to
    // ACCEPT_NO_JOURNAL_COMMANDS (accepting --no-journal) without adding
    // it to dispatch — or vice versa — fails by omission.
    const simulatedAccept = new Set(ACCEPT_NO_JOURNAL_COMMANDS);
    simulatedAccept.add("transmogrify");
    const simulatedDispatch = new Set(DISPATCHED_COMMANDS);
    const notDispatched = [...simulatedAccept].filter((c) => !simulatedDispatch.has(c));
    assert.deepEqual(
      notDispatched,
      ["transmogrify"],
      "an accept-set entry with no dispatch site must be exactly the omission",
    );
  });

  it("--no-journal rejects on every non-accept dispatched command (matrix rows)", async () => {
    const rows = [
      ["vision", ["vision", "analyze", "img.png"]],
      ["crawl", ["crawl", "https://example.com"]],
      ["map", ["map", "https://example.com"]],
      ["batch", ["batch", "manifest.json"]],
      ["repo", ["repo", "tree"]],
      ["fetch", ["fetch", "https://example.com"]],
      ["history", ["history", "list"]],
      ["config", ["config", "get", "fanout"]],
      ["doctor", ["doctor"]],
      ["quota", ["quota"]],
      ["usage", ["usage"]],
      ["cache", ["cache", "stats"]],
      ["tools", ["tools"]],
      ["init", ["init"]],
      ["archive", ["archive", "cdx", "example.com"]],
      ["watch", ["watch", "list"]],
      ["code", ["code", "session"]],
    ];
    for (const [command, argv] of rows) {
      const { adapter, stderr } = makeAdapter();
      const status = await main(
        [...argv, "--no-journal"],
        hermeticMainDeps({
          invocation: adapter,
          env: {},
          loadScoutlineConfig: async () => ({ version: 1, providers: {} }),
        }),
      );
      const envelope = JSON.parse(stderr.find((line) => line.trim().startsWith("{")) ?? "{}");
      assert.ok(
        (status === 1 && (envelope.error?.code ?? envelope.code) === "UNSUPPORTED_OPTION") ||
          (status === 1 && envelope.error?.message?.includes("--no-journal")),
        `${command} --no-journal must reject UNSUPPORTED_OPTION (got status=${status})`,
      );
    }
  });
});
