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
import {
  main,
  DISPATCHED_COMMANDS,
  ACCEPT_NO_JOURNAL_COMMANDS,
  captureServingDescriptorsForOp,
} from "../dist/index.js";
import { createInMemoryResponseCache, hermeticMainDeps } from "./helpers/hermetic-main.js";
import {
  appendJournalEntry,
  appendJournalEntryMaybeRepeat,
  buildSearchSkeleton,
  skeletonContentHash,
  normalizeSkeleton,
  buildJournalCacheKeyMap,
  buildJournalRecall,
  buildJournalRepeatMarker,
  remintRequestId,
} from "../dist/lib/journal.js";
import { readLog } from "../dist/lib/artifacts.js";
import { buildProviderCacheKey } from "../dist/lib/cache.js";
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
  const { result, invokeThrows } = options;
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
          if (invokeThrows !== undefined) throw invokeThrows;
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

describe("T2b unit pins: repeat-marker validation + cacheKey map", () => {
  it("a SMUGGLED marker (repeatOf + query/skeleton/contentHash/cacheKey/requestId) fails validation → whole-log fail-open (tiny-shape teeth)", async () => {
    const artifactsDir = makeTempDir("scoutline-journal-mkv-");
    try {
      await appendJournalEntry(artifactsDir, {
        kind: "journal",
        timestamp: 1,
        capability: "search",
        provider: { mode: "single", effective: "zai", servedFrom: "cache" },
        repeatOf: "20260907T000000Z-0000",
        // The smuggle: full-body fields on a marker shape.
        requestId: "20260907T000000Z-0001",
        query: "smuggled",
        contentHash: "a".repeat(64),
        cacheKey: "v2.json",
        skeleton: { results: [{ url: "https://x", title: "t" }] },
      });
      const { log, notice } = await readLog(artifactsDir);
      assert.strictEqual(log.entries.length, 0, "smuggled marker dropped");
      assert.ok(notice !== undefined && notice.length > 0, "corruption notice surfaced");
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });

  it("a WELL-FORMED marker validates (full entry + marker coexist in one readable log)", async () => {
    const artifactsDir = makeTempDir("scoutline-journal-mkvalid-");
    try {
      await appendJournalEntry(artifactsDir, {
        kind: "journal",
        requestId: "20260907T000000Z-0002",
        timestamp: 1,
        capability: "search",
        provider: { mode: "single", effective: "zai", servedFrom: "live" },
        query: "q",
        contentHash: "b".repeat(64),
        cacheKey: "v2.json",
        skeleton: { results: [{ url: "https://x", title: "t" }] },
      });
      await appendJournalEntry(artifactsDir, {
        kind: "journal",
        timestamp: 2,
        capability: "search",
        provider: { mode: "single", effective: "zai", servedFrom: "cache" },
        repeatOf: "20260907T000000Z-0002",
      });
      const { log, notice } = await readLog(artifactsDir);
      assert.strictEqual(log.entries.length, 2);
      assert.strictEqual(notice, undefined);
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });

  it("buildJournalCacheKeyMap: full entries map cacheKey→requestId, MARKERS NEVER MAP, last write wins", async () => {
    const artifactsDir = makeTempDir("scoutline-journal-map-");
    try {
      await appendJournalEntry(artifactsDir, {
        kind: "journal",
        requestId: "r-first",
        timestamp: 1,
        capability: "search",
        provider: { mode: "single", effective: "zai", servedFrom: "live" },
        query: "q",
        contentHash: "b".repeat(64),
        cacheKey: "key-a",
        skeleton: { results: [] },
      });
      await appendJournalEntry(artifactsDir, {
        kind: "journal",
        requestId: "r-second",
        timestamp: 2,
        capability: "search",
        provider: { mode: "single", effective: "zai", servedFrom: "live" },
        query: "q",
        contentHash: "c".repeat(64),
        cacheKey: "key-a", // same key, later entry wins
        skeleton: { results: [] },
      });
      await appendJournalEntry(artifactsDir, {
        kind: "journal",
        timestamp: 3,
        capability: "search",
        provider: { mode: "single", effective: "zai", servedFrom: "cache" },
        repeatOf: "r-second", // marker: must not enter the map
      });
      const map = await buildJournalCacheKeyMap(artifactsDir);
      assert.strictEqual(map.size, 1);
      assert.strictEqual(map.get("key-a"), "r-second", "latest full entry wins");
      assert.strictEqual(map.get("r-second"), undefined);
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });
});

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

describe("PR #111 cluster C: requestId collision remint under the log lock", () => {
  // Fixed colliding id: buildJournalRecall keys rows by requestId
  // last-wins, so a second append with this id would orphan the first
  // entry's row entirely.
  const COLLIDING_ID = "20260909T120000Z-beef";

  function collidingFullEntry(overrides = {}) {
    return {
      kind: "journal",
      requestId: COLLIDING_ID,
      timestamp: 1,
      capability: "search",
      provider: { mode: "single", effective: "zai", servedFrom: "live" },
      query: "second entry",
      contentHash: "c".repeat(64),
      cacheKey: "key-collision",
      skeleton: { results: [] },
      ...overrides,
    };
  }

  async function seedLog(dir, entries) {
    await appendJournalEntry(dir, entries[0]);
    for (const entry of entries.slice(1)) await appendJournalEntry(dir, entry);
  }

  it("appendJournalEntry: pre-seeded log holds the same requestId → appended entry gets a REMINTED tail; the seeded entry keeps its id and both stay queryable", async () => {
    const dir = makeTempDir("scoutline-journal-collision-");
    try {
      const seeded = {
        kind: "journal",
        requestId: COLLIDING_ID,
        timestamp: 1,
        capability: "search",
        provider: { mode: "single", effective: "zai", servedFrom: "live" },
        query: "first entry",
        contentHash: "b".repeat(64),
        cacheKey: "key-first",
        skeleton: { results: [] },
      };
      await seedLog(dir, [seeded]);
      await appendJournalEntry(dir, collidingFullEntry());
      const { log, notice } = await readLog(dir);
      assert.strictEqual(log.entries.length, 2);
      assert.strictEqual(notice, undefined, "remint is a normal append, not a corruption reset");
      const [first, second] = log.entries;
      assert.strictEqual(first.requestId, COLLIDING_ID, "seeded entry byte-untouched (append-only)");
      assert.notStrictEqual(second.requestId, COLLIDING_ID, "colliding append reminted");
      assert.ok(second.requestId.startsWith("20260909T120000Z-"), "timestamp prefix preserved");
      assert.match(second.requestId, /^20260909T120000Z-[0-9a-f]{4}$/, "tail is 4 lowercase hex");
      // The recall consequence: both rows survive (no last-wins orphan).
      const recalls = buildJournalRecall(await readLog(dir).then((r) => r.log.entries), "first second", {});
      assert.strictEqual(recalls.length, 2, "both entries queryable — no last-wins orphan");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("appendJournalEntryMaybeRepeat: MATCHING cacheKey → marker branch fires; markers carry no requestId, so the remint check never disturbs marker writes", async () => {
    const dir = makeTempDir("scoutline-journal-collision-mr-");
    try {
      const seeded = {
        kind: "journal",
        requestId: COLLIDING_ID,
        timestamp: 1,
        capability: "search",
        provider: { mode: "single", effective: "zai", servedFrom: "live" },
        query: "first entry",
        contentHash: "b".repeat(64),
        cacheKey: "key-first",
        skeleton: { results: [] },
      };
      // Same cacheKey as the seeded entry → the marker branch fires,
      // proving the remint check does not disturb marker writes.
      const markerSource = collidingFullEntry({ cacheKey: "key-first" });
      await seedLog(dir, [seeded]);
      await appendJournalEntryMaybeRepeat(dir, markerSource, (repeatOf) =>
        buildJournalRepeatMarker({
          capability: "search",
          provider: { mode: "single", effective: "zai", servedFrom: "cache" },
          repeatOf,
          now: () => 2,
        }),
      );
      const { log } = await readLog(dir);
      assert.strictEqual(log.entries.length, 2);
      const [first, marker] = log.entries;
      assert.strictEqual(first.requestId, COLLIDING_ID);
      assert.deepStrictEqual(
        Object.keys(marker).sort(),
        ["capability", "kind", "provider", "repeatOf", "timestamp"],
        "marker shape untouched — tiny ruling-locked shape",
      );
      assert.strictEqual(marker.repeatOf, COLLIDING_ID);
      assert.strictEqual(marker.requestId, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("appendJournalEntryMaybeRepeat: NON-matching cacheKey → FULL-entry branch, colliding requestId remints under the lock (no marker written)", async () => {
    const dir = makeTempDir("scoutline-journal-collision-mr-full-");
    try {
      const seeded = {
        kind: "journal",
        requestId: COLLIDING_ID,
        timestamp: 1,
        capability: "search",
        provider: { mode: "single", effective: "zai", servedFrom: "live" },
        query: "first entry",
        contentHash: "b".repeat(64),
        cacheKey: "key-first",
        skeleton: { results: [] },
      };
      // DIFFERENT cacheKey than the seed → journal-cold → the full-entry
      // branch fires, and the colliding requestId remints before append.
      const fullSource = collidingFullEntry({ cacheKey: "key-other" });
      await seedLog(dir, [seeded]);
      await appendJournalEntryMaybeRepeat(dir, fullSource, (repeatOf) =>
        buildJournalRepeatMarker({
          capability: "search",
          provider: { mode: "single", effective: "zai", servedFrom: "cache" },
          repeatOf,
          now: () => 2,
        }),
      );
      const { log, notice } = await readLog(dir);
      assert.strictEqual(log.entries.length, 2);
      assert.strictEqual(notice, undefined, "remint is a normal append, not a corruption reset");
      const [first, second] = log.entries;
      assert.strictEqual(
        first.requestId,
        COLLIDING_ID,
        "seeded entry byte-untouched (append-only)",
      );
      assert.notStrictEqual(
        second.requestId,
        COLLIDING_ID,
        "full-entry branch reminted the collision",
      );
      assert.ok(second.requestId.startsWith("20260909T120000Z-"), "timestamp prefix preserved");
      assert.match(second.requestId, /^20260909T120000Z-[0-9a-f]{4}$/, "tail is 4 lowercase hex");
      assert.strictEqual(
        second.repeatOf,
        undefined,
        "no marker written — full entry on the cold key",
      );
      assert.strictEqual(second.cacheKey, "key-other", "appended entry keeps its own cacheKey");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("remintRequestId swaps ONLY the 4-hex tail; injectable randomBytes keeps the mint hermetic", async () => {
    assert.strictEqual(
      remintRequestId(COLLIDING_ID, () => new Uint8Array([0x12, 0x34])),
      "20260909T120000Z-1234",
    );
    // Random default: still a valid shape.
    assert.match(remintRequestId(COLLIDING_ID), /^20260909T120000Z-[0-9a-f]{4}$/);
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

  it("malformed non-boolean config `journal` → MALFORMED_JOURNAL warning reaches stderr on the PRODUCTION inspectConfig path; journaling stays enabled (wave-2 config warning forwarding)", async () => {
    const artifactsDir = makeTempDir("scoutline-journal-malformed-");
    const configDir = makeTempDir("scoutline-journal-malformed-cfg-");
    const log = [];
    const { adapter, stderr } = makeAdapter();
    try {
      // Real config substrate: main() must run the production
      // inspectConfig branch — loadScoutlineConfig is explicitly
      // undefined (hermeticMainDeps would otherwise default an
      // injected loader and skip the branch under test), and
      // SCOUTLINE_CONFIG_DIR points at a crafted config.json the same
      // way main-config-hermetic.test.js drives ambient config.
      writeFileSync(
        join(configDir, "config.json"),
        JSON.stringify({ version: 1, providers: {}, journal: "yes" }),
      );
      const prev = process.env.SCOUTLINE_CONFIG_DIR;
      process.env.SCOUTLINE_CONFIG_DIR = configDir;
      let status;
      try {
        status = await main(
          ["search", "rust vs go"],
          journalDeps(adapter, log, {
            env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir },
            loadScoutlineConfig: undefined,
          }),
        );
      } finally {
        if (prev === undefined) delete process.env.SCOUTLINE_CONFIG_DIR;
        else process.env.SCOUTLINE_CONFIG_DIR = prev;
      }
      assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
      assert.strictEqual(log.length, 1, "the search itself ran");
      assert.ok(
        stderr.some((l) => l.includes('⚠️  config: Ignoring non-boolean "journal"')),
        `MALFORMED_JOURNAL warning forwarded to stderr; stderr=${JSON.stringify(stderr)}`,
      );
      // The dropped malformed value falls back to the enabled default:
      // visible AND recording. (The defect was the silently dropped
      // warning, not the enabled default itself.)
      const store = readJournalEntries(artifactsDir);
      assert.strictEqual(store.entries.length, 1, "journaling stayed enabled");
      assert.strictEqual(store.entries[0].kind, "journal");
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
      rmSync(configDir, { recursive: true, force: true });
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

  it('fanout search miss → journal entry with mode:"fanout" routing (must-fix 3 — no silent skip of an always-on surface)', async () => {
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
  it("batch of [search, read] → each op journals under its OWN capability (T3 completes the pair)", async () => {
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
      // T3: read journals too now — the pin is per-op capability
      // correctness, not a search-only count.
      assert.deepStrictEqual(
        journals.map((e) => e.capability).sort(),
        ["read", "search"],
        "both ops journal, each under its own capability",
      );
      const searchEntry = journals.find((e) => e.capability === "search");
      const readEntry = journals.find((e) => e.capability === "read");
      assert.strictEqual(searchEntry.query, "rust vs go");
      assert.ok(searchEntry.skeleton.results.length > 0);
      assert.strictEqual(readEntry.query, "https://example.com");
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

describe("T2b: warm-cache repeat markers (main-driven)", () => {
  /**
   * Shared warm-cache driver: run the same query twice against ONE
   * artifacts dir + ONE shared in-memory response cache (`searchCache`
   * dep — the hermetic-main idiom; the real on-disk cache resolves its
   * root from process.env at module scope, so injected env cannot steer
   * it). Run 1 is a cache MISS (full entry); run 2 is the same request
   * served from cache (T2b's marker branch). Distinct adapters per run
   * keep stdout/stderr isolated.
   */
  async function runTwice(artifactsDir, extra = {}, depsExtra = {}, argv2) {
    const seen = [];
    const responseCache = createInMemoryResponseCache();
    const mk = (runDeps = {}) =>
      journalDeps(makeAdapter().adapter, seen, {
        env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir, ...extra },
        searchCache: responseCache,
        ...depsExtra,
        ...runDeps,
      });
    const s1 = await main(["search", "rust vs go"], mk());
    const s2 = await main(argv2 ?? ["search", "rust vs go"], mk());
    return { statuses: [s1, s2], invokes: seen.length };
  }

  it("cache HIT on search → ONE tiny repeat marker {kind, timestamp, capability, provider, repeatOf} pointing at the prior FULL entry's requestId; full entry untouched", async () => {
    const artifactsDir = makeTempDir("scoutline-journal-marker-");
    try {
      const { statuses, invokes } = await runTwice(artifactsDir);
      assert.deepStrictEqual(statuses, [0, 0]);
      assert.strictEqual(invokes, 1, "run 2 served from cache (no second provider invoke)");
      const store = readJournalEntries(artifactsDir);
      assert.strictEqual(store.entries.length, 2, "full entry + marker");
      const [full, marker] = store.entries;
      assert.strictEqual(full.requestId !== undefined, true);
      // Repeat marker: EXACTLY the tiny ruling-locked shape — no query,
      // no skeleton, no contentHash, no cacheKey, no requestId.
      assert.deepStrictEqual(Object.keys(marker).sort(), [
        "capability",
        "kind",
        "provider",
        "repeatOf",
        "timestamp",
      ]);
      assert.strictEqual(marker.kind, "journal");
      assert.strictEqual(marker.capability, "search");
      assert.strictEqual(marker.repeatOf, full.requestId);
      assert.ok(typeof marker.timestamp === "number");
      // The marker is tiny — no payload fields leaked in.
      const serialized = JSON.stringify(marker);
      assert.ok(serialized.length < 300, `marker not tiny: ${serialized.length}B`);
      // Provider recorded from the capture cell (the #108 honesty): the
      // cache-serving provider, servedFrom "cache".
      assert.strictEqual(marker.provider.mode, "single");
      assert.strictEqual(marker.provider.effective, "zai");
      assert.strictEqual(marker.provider.servedFrom, "cache");
      // Append-only: the referenced full entry is byte-identical after
      // the marker write (variant-C rejection pin, now with a second
      // shape in the log).
      const store2 = readJournalEntries(artifactsDir);
      assert.deepStrictEqual(store2.entries[0], full);
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });

  it("journal-cold-but-cache-warm: cache hit with NO resolvable prior full entry → ONE FULL entry instead of a marker", async () => {
    const artifactsDir = makeTempDir("scoutline-journal-cold-");
    try {
      // Warm the shared response cache WITHOUT journaling (--no-journal
      // run 1), then a normal run hits the cache with an empty journal.
      const seen = [];
      const responseCache = createInMemoryResponseCache();
      const deps = (argv, runDeps = {}) =>
        journalDeps(makeAdapter().adapter, seen, {
          env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir },
          searchCache: responseCache,
          ...runDeps,
        });
      const s1 = await main(["search", "rust vs go", "--no-journal"], deps());
      assert.strictEqual(s1, 0);
      assert.strictEqual(seen.length, 1, "run 1 live (miss)");
      const s2 = await main(["search", "rust vs go"], deps());
      assert.strictEqual(s2, 0);
      assert.strictEqual(seen.length, 1, "run 2 cache-served");
      const store = readJournalEntries(artifactsDir);
      assert.strictEqual(store.entries.length, 1, "journal-cold rule → ONE FULL entry");
      const entry = store.entries[0];
      assert.strictEqual(entry.kind, "journal");
      assert.strictEqual(entry.repeatOf, undefined, "not a marker");
      assert.ok(Array.isArray(entry.skeleton?.results), "full skeleton present");
      assert.strictEqual(entry.query, "rust vs go");
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });

  it("marker branch resolves through the on-read map: after the journal is emptied, a cache hit writes a FULL entry (no stale pre-clear requestId resolution)", async () => {
    const artifactsDir = makeTempDir("scoutline-journal-stale-");
    try {
      const { statuses } = await runTwice(artifactsDir);
      assert.deepStrictEqual(statuses, [0, 0]);
      let store = readJournalEntries(artifactsDir);
      assert.strictEqual(store.entries.length, 2);
      // Wipe the journal by hand (history clear is T6a; same effect on
      // index.json) — the cacheKey map must rebuild from the CLEARED
      // log on the next write, not resolve the dead requestId.
      writeFileSync(
        join(artifactsDir, "index.json"),
        JSON.stringify({ version: 1, entries: [] }, null, 2) + "\n",
        { mode: 0o600 },
      );
      const seen = [];
      const responseCache = createInMemoryResponseCache();
      // Re-warm a FRESH cache (live miss, journaling off so the empty
      // journal stays empty), then hit it with journaling on.
      await main(
        ["search", "rust vs go", "--no-journal"],
        journalDeps(makeAdapter().adapter, seen, {
          env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir },
          searchCache: responseCache,
        }),
      );
      const s4 = await main(
        ["search", "rust vs go"],
        journalDeps(makeAdapter().adapter, seen, {
          env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir },
          searchCache: responseCache,
        }),
      );
      assert.strictEqual(s4, 0);
      assert.strictEqual(seen.length, 1, "run 4 cache-served (run 3 was the fresh miss)");
      store = readJournalEntries(artifactsDir);
      assert.strictEqual(store.entries.length, 1, "post-clear cache hit → ONE entry");
      assert.strictEqual(
        store.entries[0].repeatOf,
        undefined,
        "journal-cold rule fires (FULL entry, not a marker to a dead requestId)",
      );
      assert.ok(Array.isArray(store.entries[0].skeleton?.results));
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });

  it("escape switches hold on the marker branch too: --no-journal cache hit → NOTHING; config journal:false cache hit → NOTHING", async () => {
    const cases = [
      ["flag", { flags: ["--no-journal"], deps: {} }],
      [
        "config",
        {
          flags: [],
          deps: {
            loadScoutlineConfig: async () => ({ version: 1, providers: {}, journal: false }),
          },
        },
      ],
    ];
    for (const [name, { flags, deps }] of cases) {
      const artifactsDir = makeTempDir(`scoutline-journal-mkoff-${name}-`);
      try {
        // Warm the shared cache with a journaled miss first so the log
        // file exists.
        const seen = [];
        const responseCache = createInMemoryResponseCache();
        const mk = (runDeps = {}, argv) =>
          main(
            argv,
            journalDeps(makeAdapter().adapter, seen, {
              env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir },
              searchCache: responseCache,
              ...runDeps,
            }),
          );
        await mk({}, ["search", "warm only"]);
        const before = readFileSync(join(artifactsDir, "index.json"), "utf8");
        const s2 = await mk(deps, ["search", "warm only", ...flags]);
        assert.strictEqual(s2, 0);
        assert.strictEqual(seen.length, 1, "second run served from cache");
        const after = readFileSync(join(artifactsDir, "index.json"), "utf8");
        assert.strictEqual(after, before, `${name}: no marker, no full entry under the off switch`);
      } finally {
        rmSync(artifactsDir, { recursive: true, force: true });
      }
    }
  });

  it('fanout cache hit → marker with the fanout provider shape {mode:"fanout", arms} (mirrors T2a fanout handling)', async () => {
    const artifactsDir = makeTempDir("scoutline-journal-mk-fanout-");
    try {
      const seen = [];
      const twoArms = ["zai", "brave"].map((id) => makeSearchDescriptor(id, seen));
      const responseCache = createInMemoryResponseCache();
      const deps = () =>
        hermeticMainDeps({
          invocation: makeAdapter().adapter,
          env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir },
          providerDescriptors: twoArms,
          configFanout: true,
          loadScoutlineConfig: async () => ({ version: 1, providers: {} }),
          searchCache: responseCache,
        });
      const s1 = await main(["search", "rust vs go"], deps());
      const s2 = await main(["search", "rust vs go"], deps());
      assert.deepStrictEqual([s1, s2], [0, 0]);
      const store = readJournalEntries(artifactsDir);
      assert.strictEqual(store.entries.length, 2, "fanout full entry + fanout marker");
      const [full, marker] = store.entries;
      assert.strictEqual(full.provider.mode, "fanout");
      assert.strictEqual(marker.kind, "journal");
      assert.deepStrictEqual(
        marker.provider,
        { mode: "fanout", arms: ["zai", "brave"] },
        "fanout marker carries the fanout provider shape",
      );
      assert.strictEqual(marker.repeatOf, full.requestId);
      assert.strictEqual(marker.query, undefined, "marker stays tiny on fanout");
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });

  it("marker written ONLY on a cache hit: after cache expiry a live MISS with a still-resolvable map key writes a FULL entry (mutation pin: marker-on-miss)", async () => {
    const artifactsDir = makeTempDir("scoutline-journal-missfull-");
    try {
      const seen = [];
      const cacheStore = new Map();
      const responseCache = {
        async get(key) {
          return cacheStore.has(key) ? cacheStore.get(key) : null;
        },
        async set(key, value) {
          cacheStore.set(key, value);
        },
      };
      const deps = () =>
        journalDeps(makeAdapter().adapter, seen, {
          env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir },
          searchCache: responseCache,
        });
      await main(["search", "rust vs go"], deps()); // miss → FULL
      await main(["search", "rust vs go"], deps()); // hit → MARKER
      cacheStore.clear(); // 24h TTL expiry: next run is a LIVE miss
      await main(["search", "rust vs go"], deps()); // miss again → FULL
      assert.strictEqual(seen.length, 2, "two live invokes, one cache hit");
      const store = readJournalEntries(artifactsDir);
      assert.deepStrictEqual(
        store.entries.map((e) => (e.repeatOf !== undefined ? "MARKER" : "FULL")),
        ["FULL", "MARKER", "FULL"],
        "a live miss NEVER writes a marker even when the map holds the key",
      );
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });

  it("fanout: one arm cache-hit + one arm FAILED after a cache miss → FULL entry, never a repeat marker (failed arm's speculative cache stamp is cleared)", async () => {
    const artifactsDir = makeTempDir("scoutline-journal-fanout-failarm-");
    try {
      const seen = [];
      const cacheStore = new Map();
      const inMemoryCache = {
        async get(key) {
          return cacheStore.has(key) ? cacheStore.get(key) : null;
        },
        async set(key, value) {
          cacheStore.set(key, value);
        },
      };
      // brave's invoke always rejects (plain Error — terminal, never
      // retried); zai is a normal serving descriptor.
      const arms = [
        makeSearchDescriptor("zai", seen),
        makeSearchDescriptor("brave", seen, {
          invokeThrows: new Error("brave transport exploded"),
        }),
      ];
      const deps = () =>
        hermeticMainDeps({
          invocation: makeAdapter().adapter,
          env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir },
          providerDescriptors: arms,
          configFanout: true,
          loadScoutlineConfig: async () => ({ version: 1, providers: {} }),
          searchCache: inMemoryCache,
        });
      // Run 1: both arms miss → zai serves live, brave fails. FULL entry
      // (bug pin: before the fix, brave's speculative "cache" stamp kept
      // the arm cell reading all-cache → marker for an incomplete run).
      const s1 = await main(["search", "rust vs go"], deps());
      assert.strictEqual(s1, 0, "fan-out survives one failed arm (allSettled drop)");
      // Run 2: warm zai's cache ONLY (expire brave's slot — it never
      // wrote one, but pre-warm+expire keeps the reasoning explicit).
      cacheStore.clear();
      await cacheStore.set(
        buildProviderCacheKey({
          provider: "zai",
          capability: "search",
          credentialFingerprint: "fp-zai",
          request: { query: "rust vs go" },
        }),
        [{ title: "t-zai", url: "https://zai/warm", summary: "s" }],
      );
      const s2 = await main(["search", "rust vs go"], deps());
      assert.strictEqual(s2, 0);
      assert.strictEqual(
        seen.filter((e) => e.startsWith("brave:")).length,
        2,
        "brave invoked live once per run (both runs miss its slot)",
      );
      const store = readJournalEntries(artifactsDir);
      assert.deepStrictEqual(
        store.entries.map((e) => (e.repeatOf !== undefined ? "MARKER" : "FULL")),
        ["FULL", "FULL"],
        "cache-hit-arm + failed-arm runs journal FULL entries, never markers",
      );
      const [first, second] = store.entries;
      assert.strictEqual(first.provider.mode, "fanout");
      assert.ok(Array.isArray(first.skeleton?.results), "full entry carries skeleton");
      assert.strictEqual(first.query, "rust vs go");
      assert.strictEqual(second.provider.mode, "fanout");
      assert.ok(
        second.requestId !== undefined && second.skeleton !== undefined,
        "second run is a FULL entry (kind journal, requestId + skeleton), NOT a marker",
      );
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });

  it("fanout --merge grid: SAME arm — one sub-query fails live, a later sub-query cache-hits → FULL entry, never a marker (wave-2 sticky failed latch)", async () => {
    const artifactsDir = makeTempDir("scoutline-journal-fanout-mergelatch-");
    try {
      const seen = [];
      const cacheStore = new Map();
      const inMemoryCache = {
        async get(key) {
          return cacheStore.has(key) ? cacheStore.get(key) : null;
        },
        async set(key, value) {
          cacheStore.set(key, value);
        },
      };
      // zai's invoke ALWAYS throws: sub-query "alpha" cache-misses →
      // invoke fails (arm cell cleared + `failed` latched), sub-query
      // "beta" is pre-warmed → cache-hit without an invoke. brave serves
      // both sub-queries live, so the grid's combined result is fresh
      // AND incomplete — the exact shape that must journal FULL.
      const arms = [
        makeSearchDescriptor("zai", seen, {
          invokeThrows: new Error("zai merge transport exploded"),
        }),
        makeSearchDescriptor("brave", seen),
      ];
      const deps = () =>
        hermeticMainDeps({
          invocation: makeAdapter().adapter,
          env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir },
          providerDescriptors: arms,
          configFanout: true,
          loadScoutlineConfig: async () => ({ version: 1, providers: {} }),
          searchCache: inMemoryCache,
        });
      // Pre-warm zai's "beta" sub-query slot ONLY.
      await cacheStore.set(
        buildProviderCacheKey({
          provider: "zai",
          capability: "search",
          credentialFingerprint: "fp-zai",
          request: { query: "beta" },
        }),
        [{ title: "t-zai-beta", url: "https://zai/beta", summary: "s" }],
      );
      const status = await main(["search", "alpha | beta", "--merge"], deps());
      assert.strictEqual(
        status,
        0,
        "fan-out survives the partially failed zai arm (allSettled drop)",
      );
      assert.ok(
        seen.filter((e) => e.startsWith("zai:")).every((e) => e === "zai:alpha"),
        "zai's cache-hit sub-query never invoked; only the failing one did",
      );
      const store = readJournalEntries(artifactsDir);
      assert.strictEqual(store.entries.length, 1, "exactly one journal entry");
      const [entry] = store.entries;
      assert.strictEqual(
        entry.repeatOf,
        undefined,
        "never a repeat marker for the incomplete merge grid",
      );
      assert.strictEqual(entry.provider.mode, "fanout");
      assert.ok(Array.isArray(entry.skeleton?.results), "FULL entry carries the skeleton");
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });

  it("merge-grid latch unit pin: after a sub-query's invoke failure, a LATER sub-query's speculative cacheIdentity re-stamp stays suppressed (arm cell never reads cache → FULL entry, never marker)", async () => {
    const seen = [];
    // End-to-end the fail→re-stamp ordering is not expressible:
    // runFanoutArm starts every sub-query synchronously, so all
    // speculative stamps land before any invoke can reject. Pin the
    // wrapper seam directly — the exact interleaving the latch exists
    // for (whatever the scheduler does, the latch must hold).
    const descriptor = makeSearchDescriptor("zai", seen, {
      invokeThrows: new Error("sub-query transport exploded"),
    });
    // Hand-built fan-out capture: armServing is normally installed by
    // the (unexported) installFanoutArmCells; the wrapper only needs
    // the map present to resolve its arm cell at create() time.
    const capture = {};
    capture.armServing = new Map([["zai", {}]]);
    const [wrapped] = captureServingDescriptorsForOp([descriptor], capture);
    const slot = wrapped.create({ env: {} }).search;

    // Sub-query A: speculative stamp lands, then the failed invoke
    // clears the arm cell and latches `failed`.
    slot.cacheIdentity({ query: "alpha" });
    assert.strictEqual(
      capture.armServing.get("zai").servedFrom,
      "cache",
      "speculative cache stamp lands at sub-query start",
    );
    await assert.rejects(() => slot.invoke({ query: "alpha" }));
    assert.strictEqual(
      capture.armServing.get("zai").servedFrom,
      undefined,
      "invoke failure clears the arm cell",
    );
    assert.strictEqual(capture.armServing.get("zai").failed, true, "failure latches stickily");

    // Sub-query B (cache-hit): its speculative re-stamp is exactly the
    // resurrection path — suppressed, so the journal hook's
    // everyArmIsCache keeps reading this arm as not-cache (FULL entry,
    // never a repeat marker for the incomplete grid).
    slot.cacheIdentity({ query: "beta" });
    assert.strictEqual(
      capture.armServing.get("zai").servedFrom,
      undefined,
      "later speculative re-stamp suppressed by the failed latch",
    );

    // Shared-cell contract untouched (last-write-standing: the failed
    // invoke writes nothing to the shared cell).
    assert.strictEqual(capture.servedProvider, "zai");
    assert.strictEqual(capture.servedFrom, "cache");

    // Sibling gate: an arm that already went LIVE keeps "live" — a
    // later cache-hit sub-query's speculative stamp cannot clobber
    // fresh-generation truth either.
    const liveDescriptor = makeSearchDescriptor("brave", seen);
    const liveCapture = {};
    liveCapture.armServing = new Map([["brave", {}]]);
    const [liveWrapped] = captureServingDescriptorsForOp([liveDescriptor], liveCapture);
    const liveSlot = liveWrapped.create({ env: {} }).search;
    await liveSlot.invoke({ query: "alpha" });
    assert.strictEqual(liveCapture.armServing.get("brave").servedFrom, "live");
    liveSlot.cacheIdentity({ query: "beta" });
    assert.strictEqual(
      liveCapture.armServing.get("brave").servedFrom,
      "live",
      "speculative re-stamp cannot clobber a live arm cell",
    );
  });

  it("marker-vs-full discriminator: a full entry NEVER carries repeatOf; a marker NEVER carries skeleton/query/cacheKey — mixed log stays readable and countable", async () => {
    const artifactsDir = makeTempDir("scoutline-journal-mixed-");
    try {
      // Full (cold miss), marker (warm hit), full (new query miss).
      const seen = [];
      const responseCache = createInMemoryResponseCache();
      const deps = () =>
        journalDeps(makeAdapter().adapter, seen, {
          env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir },
          searchCache: responseCache,
        });
      await main(["search", "rust vs go"], deps());
      await main(["search", "rust vs go"], deps());
      await main(["search", "zig vs odin"], deps());
      assert.strictEqual(seen.length, 2, "two misses, one hit");
      const store = readJournalEntries(artifactsDir);
      assert.strictEqual(store.entries.length, 3);
      const [e1, e2, e3] = store.entries;
      assert.strictEqual(e1.repeatOf, undefined);
      assert.ok(Array.isArray(e1.skeleton?.results));
      assert.strictEqual(e3.repeatOf, undefined);
      assert.ok(Array.isArray(e3.skeleton?.results));
      assert.strictEqual(e2.repeatOf, e1.requestId);
      assert.strictEqual(e2.skeleton, undefined);
      assert.strictEqual(e2.query, undefined);
      assert.strictEqual(e2.cacheKey, undefined);
      // The stats substrate: distinct marker/full counts are derivable.
      const markers = store.entries.filter((e) => e.repeatOf !== undefined);
      const fulls = store.entries.filter((e) => e.repeatOf === undefined);
      assert.strictEqual(markers.length, 1);
      assert.strictEqual(fulls.length, 2);
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

// ---------------------------------------------------------------------------
// T3 — read + research journaling (capability-driven seam extension)
// ---------------------------------------------------------------------------

/** Reader descriptor double (the save-artifact T4 nested `{fetch}` shape). */
function makeReaderDescriptor(id, log, options = {}) {
  const { result } = options;
  return {
    id,
    isConfigured: () => true,
    capabilities: () => new Set(["reader"]),
    create: () => ({
      id,
      reader: {
        fetch: {
          kind: "reader-fetch",
          validate() {},
          cacheIdentity(request) {
            return {
              provider: id,
              capability: "reader",
              operation: "reader-fetch",
              credentialFingerprint: `fp-${id}`,
              request,
              legacyCandidates: [],
            };
          },
          decodeCached: (v) =>
            v !== null && typeof v === "object" && v.schemaVersion === 1 ? v : null,
          async invoke(request) {
            log.push(`${id}:${request.url}`);
            return (
              result ?? {
                schemaVersion: 1,
                url: request.url,
                finalUrl: request.url,
                title: `t-${id}`,
                content: `read by ${id}`,
                contentFormat: "markdown",
              }
            );
          },
        },
      },
    }),
  };
}

/** Research descriptor double (mirrors save-artifact's tavily shape). */
function makeResearchDescriptor(id, log, options = {}) {
  const { result } = options;
  return {
    id,
    isConfigured: (env) => typeof env.TAVILY_API_KEY === "string" && env.TAVILY_API_KEY.length > 0,
    capabilities: () => new Set(["research"]),
    create: () => ({
      id,
      research: {
        run: {
          kind: "research-run",
          validate() {},
          cacheIdentity(request) {
            return {
              provider: id,
              capability: "research",
              credentialFingerprint: `fp-${id}`,
              request,
              legacyCandidates: [],
            };
          },
          decodeCached: (v) =>
            v !== null && typeof v === "object" && v.schemaVersion === 1 ? v : null,
          async invoke(request) {
            log.push(`${id}:${request.query}`);
            return (
              result ?? {
                schemaVersion: 1,
                query: request.query,
                model: "auto",
                report: `Report from ${id}`,
                sources: [{ title: `${id} source`, url: `https://example.com/${id}-source` }],
              }
            );
          },
        },
      },
    }),
  };
}

describe("T3: read skeleton validator tooth (direct pin)", () => {
  it("a hand-written 2-row read journal entry fails validation → whole-log fail-open (read skeletons are EXACTLY one row)", async () => {
    const artifactsDir = makeTempDir("scoutline-journal-readtooth-");
    try {
      // Good search entry first, so the pin proves the read entry alone
      // blanks the log (the fail-open semantic), not an empty log.
      await appendJournalEntry(artifactsDir, {
        kind: "journal",
        requestId: "20260908T000000Z-0001",
        timestamp: 1800000000000,
        capability: "search",
        provider: { mode: "single", effective: "zai", servedFrom: "live" },
        query: "q",
        contentHash: "a".repeat(64),
        cacheKey: "v2.json",
        skeleton: { results: [{ url: "https://x", title: "t" }] },
      });
      // The tooth: capability "read" with TWO rows.
      await appendJournalEntry(artifactsDir, {
        kind: "journal",
        requestId: "20260908T000001Z-0002",
        timestamp: 1800000001000,
        capability: "read",
        provider: { mode: "single", effective: "zai", servedFrom: "live" },
        query: "https://example.com",
        contentHash: "b".repeat(64),
        cacheKey: "v2.read.json",
        skeleton: {
          results: [
            { url: "https://example.com", title: "one" },
            { url: "https://example.com/2", title: "two" },
          ],
        },
      });
      const { log, notice } = await readLog(artifactsDir);
      assert.strictEqual(log.entries.length, 0, "2-row read skeleton must fail open (whole log)");
      assert.ok(notice !== undefined && notice.length > 0, "corruption notice surfaced");
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });

  it("a 1-row read entry validates (the tooth does not over-bite)", async () => {
    const artifactsDir = makeTempDir("scoutline-journal-readtooth-ok-");
    try {
      await appendJournalEntry(artifactsDir, {
        kind: "journal",
        requestId: "20260908T000000Z-0003",
        timestamp: 1800000000000,
        capability: "read",
        provider: { mode: "single", effective: "zai", servedFrom: "live" },
        query: "https://example.com",
        contentHash: "c".repeat(64),
        cacheKey: "v2.read.json",
        skeleton: { results: [{ url: "https://example.com", title: "t" }] },
      });
      const { log, notice } = await readLog(artifactsDir);
      assert.strictEqual(log.entries.length, 1);
      assert.strictEqual(notice, undefined);
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });
});

describe("T3: read journaling (main-driven)", () => {
  it("cache MISS on read → ONE full entry: capability read, query = the URL, skeleton {url,title} from the read envelope", async () => {
    const artifactsDir = makeTempDir("scoutline-journal-read-");
    const log = [];
    const { adapter, stdout, stderr } = makeAdapter();
    try {
      const status = await main(
        ["read", "https://example.com/doc"],
        journalDeps(adapter, log, {
          env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir },
          providerDescriptors: [makeReaderDescriptor("zai", log)],
        }),
      );
      assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
      assert.strictEqual(log.length, 1, "provider invoked once (cache miss)");
      const store = readJournalEntries(artifactsDir);
      assert.strictEqual(store.entries.length, 1, "exactly one entry");
      const entry = store.entries[0];
      assert.strictEqual(entry.kind, "journal");
      assert.strictEqual(entry.capability, "read", "capability field names the surface");
      assert.strictEqual(entry.query, "https://example.com/doc");
      assert.strictEqual(entry.provider.mode, "single");
      assert.strictEqual(entry.provider.effective, "zai");
      assert.strictEqual(entry.provider.servedFrom, "live");
      // Read skeleton: EXACTLY one {url,title} row (the fetch identity).
      assert.deepStrictEqual(entry.skeleton, {
        results: [{ url: "https://example.com/doc", title: "t-zai" }],
      });
      assert.strictEqual(
        entry.contentHash,
        skeletonContentHash({
          results: [{ url: "https://example.com/doc", title: "t-zai" }],
        }),
      );
      assert.strictEqual(entry.cacheRef, undefined);
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });

  it("read cache HIT → ONE tiny repeat marker (capability read) pointing at the prior full entry", async () => {
    const artifactsDir = makeTempDir("scoutline-journal-read-hit-");
    const seen = [];
    const responseCache = createInMemoryResponseCache();
    const deps = () =>
      journalDeps(makeAdapter().adapter, seen, {
        env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir },
        readerCache: responseCache,
        providerDescriptors: [makeReaderDescriptor("zai", seen)],
      });
    const s1 = await main(["read", "https://example.com/doc"], deps());
    const s2 = await main(["read", "https://example.com/doc"], deps());
    assert.deepStrictEqual([s1, s2], [0, 0]);
    assert.strictEqual(seen.length, 1, "run 2 served from cache");
    const store = readJournalEntries(artifactsDir);
    assert.strictEqual(store.entries.length, 2, "full entry + marker");
    const [full, marker] = store.entries;
    assert.strictEqual(full.capability, "read");
    assert.deepStrictEqual(Object.keys(marker).sort(), [
      "capability",
      "kind",
      "provider",
      "repeatOf",
      "timestamp",
    ]);
    assert.strictEqual(marker.capability, "read");
    assert.strictEqual(marker.repeatOf, full.requestId);
    assert.strictEqual(marker.provider.servedFrom, "cache");
  });

  it("read marker written ONLY on a cache hit: after cache expiry a live MISS with a still-resolvable map key writes a FULL entry (mutation pin: marker-on-miss)", async () => {
    const artifactsDir = makeTempDir("scoutline-journal-read-missfull-");
    const seen = [];
    const cacheStore = new Map();
    const responseCache = {
      async get(key) {
        return cacheStore.has(key) ? cacheStore.get(key) : null;
      },
      async set(key, value) {
        cacheStore.set(key, value);
      },
    };
    const deps = (cache) =>
      journalDeps(makeAdapter().adapter, seen, {
        env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir },
        ...(cache === undefined ? {} : { readerCache: cache }),
        providerDescriptors: [makeReaderDescriptor("zai", seen)],
      });
    await main(["read", "https://example.com/doc"], deps(responseCache)); // miss → FULL
    await main(["read", "https://example.com/doc"], deps(responseCache)); // hit → MARKER
    cacheStore.clear(); // 24h TTL expiry: next run is a LIVE miss
    await main(["read", "https://example.com/doc"], deps(responseCache)); // miss again → FULL
    assert.strictEqual(seen.length, 2, "two live invokes, one cache hit");
    const store = readJournalEntries(artifactsDir);
    assert.deepStrictEqual(
      store.entries.map((e) => (e.repeatOf !== undefined ? "MARKER" : "FULL")),
      ["FULL", "MARKER", "FULL"],
      "a live read miss NEVER writes a marker even when the map holds the key",
    );
  });

  it("--no-journal on read + config journal:false on read → NO entry (switches honored on the new surface)", async () => {
    const cases = [
      ["flag", ["read", "https://example.com/doc", "--no-journal"], {}],
      [
        "config",
        ["read", "https://example.com/doc"],
        { loadScoutlineConfig: async () => ({ version: 1, providers: {}, journal: false }) },
      ],
    ];
    for (const [name, argv, extra] of cases) {
      const artifactsDir = makeTempDir(`scoutline-journal-read-off-${name}-`);
      const log = [];
      const { adapter } = makeAdapter();
      try {
        const status = await main(
          argv,
          journalDeps(adapter, log, {
            env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir },
            providerDescriptors: [makeReaderDescriptor("zai", log)],
            ...extra,
          }),
        );
        assert.strictEqual(status, 0);
        assert.strictEqual(log.length, 1, "the read itself ran");
        const indexFile = join(artifactsDir, "index.json");
        if (existsSync(indexFile)) {
          const store = JSON.parse(readFileSync(indexFile, "utf8"));
          assert.deepStrictEqual(
            store.entries.filter((e) => e.kind === "journal"),
            [],
            `${name}: no journal entry`,
          );
        }
      } finally {
        rmSync(artifactsDir, { recursive: true, force: true });
      }
    }
  });

  it("read entries land 0600 (stat pin)", async () => {
    const artifactsDir = makeTempDir("scoutline-journal-read-mode-");
    const log = [];
    const { adapter } = makeAdapter();
    try {
      await main(
        ["read", "https://example.com/doc"],
        journalDeps(adapter, log, {
          env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir },
          providerDescriptors: [makeReaderDescriptor("zai", log)],
        }),
      );
      const mode = statSync(join(artifactsDir, "index.json")).mode & 0o777;
      assert.strictEqual(mode, 0o600, "index.json must be 0600");
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });

  it("read redaction: token in URL query param absent from the entry and the log", async () => {
    const artifactsDir = makeTempDir("scoutline-journal-read-redact-");
    const TOKEN = "tok-read-8a41f2c9b7de";
    const log = [];
    const { adapter, stderr } = makeAdapter();
    try {
      const status = await main(
        ["read", `https://example.com/doc?token=${TOKEN}`],
        hermeticMainDeps({
          invocation: adapter,
          env: {
            SCOUTLINE_ARTIFACTS_DIR: artifactsDir,
            EXA_API_KEY: TOKEN,
          },
          providerDescriptors: [makeReaderDescriptor("zai", log)],
        }),
      );
      assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
      const raw = readFileSync(join(artifactsDir, "index.json"), "utf8");
      assert.ok(!raw.includes(TOKEN), "url token leaked into the log");
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });
});

describe("T3: research journaling (main-driven)", () => {
  const RESEARCH_ENV = { TAVILY_API_KEY: "tv" };

  it("cache MISS on research → ONE full entry: capability research, query text, skeleton = the citations block", async () => {
    const artifactsDir = makeTempDir("scoutline-journal-research-");
    const log = [];
    const { adapter, stderr } = makeAdapter();
    try {
      const status = await main(
        ["--provider", "tavily", "research", "scoutline state"],
        journalDeps(adapter, log, {
          env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir, ...RESEARCH_ENV },
          providerDescriptors: [makeResearchDescriptor("tavily", log)],
        }),
      );
      assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
      assert.strictEqual(log.length, 1, "provider invoked once");
      const store = readJournalEntries(artifactsDir);
      assert.strictEqual(store.entries.length, 1);
      const entry = store.entries[0];
      assert.strictEqual(entry.kind, "journal");
      assert.strictEqual(entry.capability, "research");
      assert.strictEqual(entry.query, "scoutline state");
      assert.strictEqual(entry.provider.mode, "single");
      assert.strictEqual(entry.provider.effective, "tavily");
      assert.strictEqual(entry.provider.servedFrom, "live");
      // Research skeleton: the citations (sources) url+title list.
      assert.deepStrictEqual(entry.skeleton, {
        results: [{ url: "https://example.com/tavily-source", title: "tavily source" }],
      });
      assert.strictEqual(
        entry.contentHash,
        skeletonContentHash({
          results: [{ url: "https://example.com/tavily-source", title: "tavily source" }],
        }),
      );
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });

  it("research cache HIT → ONE tiny repeat marker (capability research)", async () => {
    const artifactsDir = makeTempDir("scoutline-journal-research-hit-");
    const seen = [];
    const responseCache = createInMemoryResponseCache();
    const deps = () =>
      journalDeps(makeAdapter().adapter, seen, {
        env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir, ...RESEARCH_ENV },
        researchCache: responseCache,
        providerDescriptors: [makeResearchDescriptor("tavily", seen)],
      });
    const s1 = await main(["--provider", "tavily", "research", "scoutline state"], deps());
    const s2 = await main(["--provider", "tavily", "research", "scoutline state"], deps());
    assert.deepStrictEqual([s1, s2], [0, 0]);
    assert.strictEqual(seen.length, 1, "run 2 served from cache");
    const store = readJournalEntries(artifactsDir);
    assert.strictEqual(store.entries.length, 2, "full entry + marker");
    const [full, marker] = store.entries;
    assert.strictEqual(full.capability, "research");
    assert.deepStrictEqual(Object.keys(marker).sort(), [
      "capability",
      "kind",
      "provider",
      "repeatOf",
      "timestamp",
    ]);
    assert.strictEqual(marker.capability, "research");
    assert.strictEqual(marker.repeatOf, full.requestId);
    assert.strictEqual(marker.provider.servedFrom, "cache");
  });

  it("--no-journal on research + config journal:false on research → NO entry", async () => {
    const cases = [
      ["flag", ["--provider", "tavily", "research", "scoutline state", "--no-journal"], {}],
      [
        "config",
        ["--provider", "tavily", "research", "scoutline state"],
        { loadScoutlineConfig: async () => ({ version: 1, providers: {}, journal: false }) },
      ],
    ];
    for (const [name, argv, extra] of cases) {
      const artifactsDir = makeTempDir(`scoutline-journal-research-off-${name}-`);
      const log = [];
      const { adapter } = makeAdapter();
      try {
        const status = await main(
          argv,
          journalDeps(adapter, log, {
            env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir, ...RESEARCH_ENV },
            providerDescriptors: [makeResearchDescriptor("tavily", log)],
            ...extra,
          }),
        );
        assert.strictEqual(status, 0);
        const indexFile = join(artifactsDir, "index.json");
        if (existsSync(indexFile)) {
          const store = JSON.parse(readFileSync(indexFile, "utf8"));
          assert.deepStrictEqual(
            store.entries.filter((e) => e.kind === "journal"),
            [],
            `${name}: no journal entry`,
          );
        }
      } finally {
        rmSync(artifactsDir, { recursive: true, force: true });
      }
    }
  });

  it("research redaction: fake secret in query text AND token in citation URL appear in NEITHER the entry nor the log file", async () => {
    const artifactsDir = makeTempDir("scoutline-journal-research-redact-");
    const SECRET = "sk-research-secret-query-token-4d7b2";
    const TOKEN = "tok-research-8a41f2c9b7de";
    const log = [];
    const { adapter, stderr } = makeAdapter();
    try {
      const status = await main(
        ["--provider", "tavily", "research", `api keys ${SECRET}`],
        hermeticMainDeps({
          invocation: adapter,
          env: {
            SCOUTLINE_ARTIFACTS_DIR: artifactsDir,
            TAVILY_API_KEY: "tv",
            EXA_API_KEY: TOKEN,
            Z_AI_API_KEY: SECRET,
          },
          providerDescriptors: [
            makeResearchDescriptor("tavily", log, {
              result: {
                schemaVersion: 1,
                query: `api keys ${SECRET}`,
                model: "auto",
                report: "Report from tavily",
                sources: [{ title: "leaky", url: `https://example.com/doc?token=${TOKEN}` }],
              },
            }),
          ],
        }),
      );
      assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
      const raw = readFileSync(join(artifactsDir, "index.json"), "utf8");
      assert.ok(!raw.includes(SECRET), "fake secret leaked into the log via research query text");
      assert.ok(!raw.includes(TOKEN), "url token leaked into the log via citation url");
      const store = JSON.parse(raw);
      const entry = store.entries[0];
      assert.ok(!JSON.stringify(entry.query).includes(SECRET));
      assert.ok(!JSON.stringify(entry.skeleton).includes(TOKEN));
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });

  it("research entries land 0600 (stat pin)", async () => {
    const artifactsDir = makeTempDir("scoutline-journal-research-mode-");
    const log = [];
    const { adapter } = makeAdapter();
    try {
      await main(
        ["--provider", "tavily", "research", "scoutline state"],
        journalDeps(adapter, log, {
          env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir, ...RESEARCH_ENV },
          providerDescriptors: [makeResearchDescriptor("tavily", log)],
        }),
      );
      const mode = statSync(join(artifactsDir, "index.json")).mode & 0o777;
      assert.strictEqual(mode, 0o600, "index.json must be 0600");
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });
});

describe("T3: batch read/research ops journal (per-op capability)", () => {
  it("batch of [read] → the read op journals its own entry (search already pinned in T2a)", async () => {
    const artifactsDir = makeTempDir("scoutline-journal-batch-read-");
    const cacheDir = makeTempDir("scoutline-journal-batch-read-cache-");
    const log = [];
    const { adapter, stderr } = makeAdapter();
    const readDesc = makeReaderDescriptor("zai", log);
    const manifest = {
      schemaVersion: 1,
      operations: [{ name: "op-read", command: "read", input: { url: "https://example.com" } }],
    };
    const manifestDir = makeTempDir("scoutline-journal-batch-read-manifest-");
    const manifestFile = join(manifestDir, "manifest.json");
    writeFileSync(manifestFile, JSON.stringify(manifest), "utf8");
    try {
      const status = await main(
        ["batch", manifestFile],
        hermeticMainDeps({
          invocation: adapter,
          env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir, SCOUTLINE_CACHE_DIR: cacheDir },
          providerDescriptors: [readDesc],
          loadScoutlineConfig: async () => ({ version: 1, providers: {} }),
        }),
      );
      assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
      const store = readJournalEntries(artifactsDir);
      const journals = store.entries.filter((e) => e.kind === "journal");
      assert.strictEqual(journals.length, 1, "the read op journals");
      assert.strictEqual(journals[0].capability, "read");
      assert.strictEqual(journals[0].query, "https://example.com");
      assert.deepStrictEqual(journals[0].skeleton, {
        results: [{ url: "https://example.com", title: "t-zai" }],
      });
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
      rmSync(cacheDir, { recursive: true, force: true });
      rmSync(manifestDir, { recursive: true, force: true });
    }
  });
});

describe("T3: journal-write failure contract (carry-over pin from T2a review)", () => {
  it("an injected journal append failure FAILS the command — exit 1, no stdout (never a silent skip)", async () => {
    // SCOUTLINE_ARTIFACTS_DIR points at a FILE's parent with the dir path
    // occupied by a regular file: the locked append cannot create
    // index.json under it → the write throws → invokeCommand's catch owns
    // the error envelope.
    const blockedParent = makeTempDir("scoutline-journal-fail-parent-");
    const fileDir = join(blockedParent, "not-a-dir");
    writeFileSync(fileDir, "x");
    const log = [];
    const { adapter, stdout, stderr } = makeAdapter();
    try {
      const status = await main(
        ["read", "https://example.com/doc"],
        journalDeps(adapter, log, {
          env: { SCOUTLINE_ARTIFACTS_DIR: fileDir },
          providerDescriptors: [makeReaderDescriptor("zai", log)],
        }),
      );
      assert.strictEqual(status, 1, "journal write failure must fail the command");
      assert.deepStrictEqual(stdout, [], "stdout must stay empty when the journal write fails");
      const envelope = JSON.parse(stderr.at(-1));
      assert.strictEqual(envelope.success, false);
    } finally {
      rmSync(blockedParent, { recursive: true, force: true });
    }
  });
});

describe("T3: history surfaces render read + research journal rows", () => {
  it("history list/show/stats over read + research journal rows — exit 0, kind column values, capability counts", async () => {
    const artifactsDir = makeTempDir("scoutline-journal-hist-rr-");
    const readLog = [];
    const researchLog = [];
    const readRun = makeAdapter();
    const researchRun = makeAdapter();
    try {
      const r1 = await main(
        ["read", "https://example.com/doc"],
        journalDeps(readRun.adapter, readLog, {
          env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir },
          providerDescriptors: [makeReaderDescriptor("zai", readLog)],
        }),
      );
      assert.strictEqual(r1, 0, `stderr=${JSON.stringify(readRun.stderr)}`);
      const r2 = await main(
        ["--provider", "tavily", "research", "scoutline state"],
        journalDeps(researchRun.adapter, researchLog, {
          env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir, TAVILY_API_KEY: "tv" },
          providerDescriptors: [makeResearchDescriptor("tavily", researchLog)],
        }),
      );
      assert.strictEqual(r2, 0, `stderr=${JSON.stringify(researchRun.stderr)}`);

      const list = makeAdapter();
      const listStatus = await main(
        ["history", "list"],
        hermeticMainDeps({
          invocation: list.adapter,
          env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir },
          loadScoutlineConfig: async () => ({ version: 1, providers: {} }),
        }),
      );
      assert.strictEqual(listStatus, 0, `stderr=${JSON.stringify(list.stderr)}`);
      const listEnvelope = JSON.parse(list.stdout[0]);
      assert.strictEqual(listEnvelope.entries.length, 2);

      const show = makeAdapter();
      const store = readJournalEntries(artifactsDir);
      const readId = store.entries.find((e) => e.capability === "read").requestId;
      const showStatus = await main(
        ["history", "show", readId],
        hermeticMainDeps({
          invocation: show.adapter,
          env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir },
          loadScoutlineConfig: async () => ({ version: 1, providers: {} }),
        }),
      );
      assert.strictEqual(showStatus, 0, `stderr=${JSON.stringify(show.stderr)}`);
      const showEnvelope = JSON.parse(show.stdout[0]);
      assert.strictEqual(showEnvelope.entry.kind, "journal");
      assert.strictEqual(showEnvelope.entry.capability, "read");

      const stats = makeAdapter();
      const statsStatus = await main(
        ["history", "stats"],
        hermeticMainDeps({
          invocation: stats.adapter,
          env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir },
          loadScoutlineConfig: async () => ({ version: 1, providers: {} }),
        }),
      );
      assert.strictEqual(statsStatus, 0, `stderr=${JSON.stringify(stats.stderr)}`);
      const statsEnvelope = JSON.parse(stats.stdout[0]);
      assert.strictEqual(statsEnvelope.byCommand.read, 1);
      assert.strictEqual(statsEnvelope.byCommand.research, 1);
      assert.strictEqual(statsEnvelope.byKind.journal, 2);
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Review round 3 (PR #111): request/timestamp single-clock snapshot +
// Unicode recall tokens + mixed-fanout repeat-marker integrity.
// ---------------------------------------------------------------------------

const T0_R3 = Date.UTC(2026, 8, 8, 12, 0, 0);
const fixedNowR3 = () => T0_R3;

/** Full journal entry factory for the r3 pins (the T2a write shape). */
function r3FullEntry(overrides = {}) {
  return {
    kind: "journal",
    requestId: "20260908T120000Z-r3a1",
    timestamp: T0_R3,
    capability: "search",
    provider: { mode: "single", effective: "zai", servedFrom: "live" },
    query: "rust vs go",
    contentHash: "a".repeat(64),
    cacheKey: "r3-key",
    skeleton: { results: [] },
    ...overrides,
  };
}

/** Seed entries through the real append seam, then parse the store. */
async function r3Seed(artifactsDir, entries) {
  for (const entry of entries) {
    await appendJournalEntry(artifactsDir, entry);
  }
  return readJournalEntries(artifactsDir);
}

function r3RecallDeps(adapter, extra = {}) {
  return hermeticMainDeps({
    invocation: adapter,
    env: { SCOUTLINE_ARTIFACTS_DIR: extra.artifactsDir },
    now: fixedNowR3,
    loadScoutlineConfig: async () => ({ version: 1, providers: {} }),
  });
}

function r3Envelope(stdout) {
  assert.ok(stdout.length >= 1, `expected stdout data, got ${JSON.stringify(stdout)}`);
  return JSON.parse(stdout[0]);
}

describe("review r3: buildJournalEntry one-clock identity (cubic P3)", () => {
  it("a clock tick between the requestId mint and the timestamp read never splits the entry (requestId instant === timestamp)", async () => {
    const { buildJournalEntry } = await import("../dist/lib/journal.js");
    let ticks = 0;
    // First now() → 1000, second → 2000: a second-boundary wrap between
    // the two reads is the exact defect the snapshot must kill.
    const entry = buildJournalEntry({
      capability: "search",
      provider: { mode: "single", effective: "zai", servedFrom: "live" },
      query: "q",
      cacheKey: "k",
      skeleton: { results: [] },
      now: () => (ticks++ === 0 ? 1000 : 2000),
    });
    // newRequestId embeds utcCompactTimestamp (second floor) — with ONE
    // snapshot both fields derive from the SAME instant.
    const m = /^(\d{8}T\d{6}Z)-/.exec(entry.requestId);
    assert.ok(m, `requestId shape: ${entry.requestId}`);
    const instant = Date.parse(
      `${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6, 8)}T${m[1].slice(9, 11)}:${m[1].slice(11, 13)}:${m[1].slice(13, 15)}Z`,
    );
    assert.strictEqual(instant, entry.timestamp, "requestId instant must equal entry timestamp");
  });

  it("buildJournalRepeatMarker snapshots one clock too (marker identity pin)", async () => {
    const { buildJournalRepeatMarker } = await import("../dist/lib/journal.js");
    let ticks = 0;
    const marker = buildJournalRepeatMarker({
      capability: "search",
      provider: { mode: "single", effective: "zai", servedFrom: "cache" },
      repeatOf: "r-1",
      now: () => (ticks++ === 0 ? 1000 : 2000),
    });
    assert.strictEqual(marker.timestamp, 1000, "ONE now() read — no second read");
  });
});

describe("review r3: recall tokenize is Unicode-aware (coderabbit major)", () => {
  it("non-Latin queries recall their entries: CJK query tokens survive tokenize on BOTH sides", async () => {
    const artifactsDir = makeTempDir("scoutline-recall-cjk-");
    const { adapter, stdout, stderr } = makeAdapter();
    try {
      await r3Seed(artifactsDir, [
        r3FullEntry({ requestId: "r-cjk-1", query: "日本語 検索" }),
        r3FullEntry({ requestId: "r-latin-1", query: "rust vs go", cacheKey: "r3-key-2" }),
      ]);
      const status = await main(
        ["history", "recall", "日本語"],
        r3RecallDeps(adapter, { artifactsDir }),
      );
      assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
      const envelope = r3Envelope(stdout);
      assert.deepStrictEqual(
        envelope.results.map((r) => r.requestId),
        ["r-cjk-1"],
        "CJK query must match the CJK entry (score > 0)",
      );
      assert.ok(envelope.results[0].score >= 1);
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });

  it("accented Latin terms keep their atoms: café matches café, not fragments", async () => {
    const artifactsDir = makeTempDir("scoutline-recall-accent-");
    const { adapter, stdout, stderr } = makeAdapter();
    try {
      await r3Seed(artifactsDir, [r3FullEntry({ requestId: "r-acc-1", query: "café opened" })]);
      const status = await main(
        ["history", "recall", "café"],
        r3RecallDeps(adapter, { artifactsDir }),
      );
      assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
      const envelope = r3Envelope(stdout);
      assert.deepStrictEqual(
        envelope.results.map((r) => r.requestId),
        ["r-acc-1"],
      );
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });
});

describe("review batch 1: fixes (PR #111)", () => {
  it("--fields filtered search still journals url+title skeleton rows (pre-projection capture)", async () => {
    const artifactsDir = makeTempDir("scoutline-journal-fields-");
    const log = [];
    const { adapter, stderr } = makeAdapter();
    try {
      const status = await main(
        ["search", "rust vs go", "--fields", "summary"],
        journalDeps(adapter, log, { env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir } }),
      );
      assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
      const store = readJournalEntries(artifactsDir);
      assert.strictEqual(store.entries.length, 1);
      const entry = store.entries[0];
      assert.ok(Array.isArray(entry.skeleton.results));
      assert.strictEqual(entry.skeleton.results.length, 1);
      assert.strictEqual(entry.skeleton.results[0].url, "https://zai/r");
      assert.strictEqual(entry.skeleton.results[0].title, "t-zai");
      // The --fields projection stripped the stdout copy, not the journal.
      const rawJournal = readFileSync(join(artifactsDir, "index.json"), "utf8");
      assert.ok(
        !rawJournal.includes('"summary"'),
        "journal skeleton must not carry the projected field",
      );
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });

  it("fanout --fields keeps skeleton identities too (fan-out pre-projection capture)", async () => {
    const artifactsDir = makeTempDir("scoutline-journal-fields-fanout-");
    const log = [];
    const { adapter, stderr } = makeAdapter();
    const twoArms = ["zai", "brave"].map((id) => makeSearchDescriptor(id, log));
    try {
      const status = await main(
        ["search", "rust vs go", "--fields", "summary"],
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
      assert.strictEqual(store.entries.length, 1);
      const entry = store.entries[0];
      for (const row of entry.skeleton.results) {
        assert.ok(typeof row.url === "string" && row.url.length > 0);
        assert.ok(typeof row.title === "string" && row.title.length > 0);
      }
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });

  it("fan-out arm race: shared capture cell survives (live arm survives delayed cache-hit)", async () => {
    const artifactsDir = makeTempDir("scoutline-journal-armrace-");
    const log = [];
    const { adapter, stderr } = makeAdapter();
    // Two-arm fan-out where both arms run cold (live). The journal
    // hook must observe at least ONE live arm and write a full entry,
    // never a marker — even when the later-resolving arm's cache hit
    // would have over-written servedFrom without per-arm cells.
    const zaiDesc = makeSearchDescriptor("zai", log);
    const braveDesc = makeSearchDescriptor("brave", log);
    try {
      const status = await main(
        ["search", "rust vs go"],
        hermeticMainDeps({
          invocation: adapter,
          env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir },
          providerDescriptors: [zaiDesc, braveDesc],
          configFanout: true,
          loadScoutlineConfig: async () => ({ version: 1, providers: {} }),
        }),
      );
      assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
      const store = readJournalEntries(artifactsDir);
      const journals = store.entries.filter((e) => e.kind === "journal");
      assert.strictEqual(
        journals.length,
        1,
        `expected one journal entry, got ${JSON.stringify(journals)}`,
      );
      assert.strictEqual(journals[0].repeatOf, undefined, "must be a full entry, not a marker");
      assert.strictEqual(journals[0].provider.mode, "fanout");
      assert.ok(journals[0].skeleton.results.length > 0);
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });

  it("--fields read skeleton keeps the fetch identity (read pre-projection capture)", async () => {
    const artifactsDir = makeTempDir("scoutline-journal-read-fields-");
    const { adapter, stderr } = makeAdapter();
    const log = [];
    try {
      // --max-chars is a post-envelope budget; the read identity must
      // survive it for the skeleton.
      const status = await main(
        ["read", "https://example.com/doc", "--max-chars", "2000"],
        journalDeps(adapter, log, {
          env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir },
          providerDescriptors: [makeReaderDescriptor("zai", log)],
        }),
      );
      // --max-chars 2000 is floor-safe: status is deterministically 0,
      // and a success must journal the identity.
      assert.strictEqual(
        status,
        0,
        `read must succeed within budget: stderr=${JSON.stringify(stderr)}`,
      );
      const store = readJournalEntries(artifactsDir);
      assert.ok(store.entries.length >= 1);
      const readEntry = store.entries.find((e) => e.kind === "journal" && e.capability === "read");
      assert.ok(readEntry, "read entry present");
      assert.ok(readEntry.skeleton.results[0].url.length > 0);
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });

  it("read journal cacheKey carries the operation suffix matching the response-cache partition", async () => {
    const artifactsDir = makeTempDir("scoutline-journal-read-key-");
    const { adapter, stderr } = makeAdapter();
    const log = [];
    try {
      const status = await main(
        ["read", "https://example.com/doc"],
        journalDeps(adapter, log, {
          env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir },
          providerDescriptors: [makeReaderDescriptor("zai", log)],
        }),
      );
      assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
      const store = readJournalEntries(artifactsDir);
      const readEntry = store.entries.find((e) => e.kind === "journal" && e.capability === "read");
      assert.ok(readEntry, "read entry present");
      assert.ok(
        readEntry.cacheKey.includes("reader-reader-fetch"),
        `cacheKey must carry the operation suffix, got ${readEntry.cacheKey}`,
      );
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });

  it("two parallel cache-hits for the same key → exactly one FULL + one MARKER (atomic read-check-append)", async () => {
    const artifactsDir = makeTempDir("scoutline-journal-atomic-");
    try {
      const full = {
        kind: "journal",
        requestId: "20260908T000000Z-atomic",
        timestamp: 1800000000000,
        capability: "search",
        provider: { mode: "single", effective: "zai", servedFrom: "live" },
        query: "q",
        contentHash: skeletonContentHash(buildSearchSkeleton([{ title: "t", url: "https://x" }])),
        cacheKey: "v2.search.zai.atomic.json",
        skeleton: buildSearchSkeleton([{ title: "t", url: "https://x" }]),
      };
      await appendJournalEntry(artifactsDir, full);
      // Two concurrent cache-hit appends race: both resolve repeatOf
      // through the in-lock map; the first writes... (they both write
      // markers — the full entry already exists).
      await Promise.all([
        appendJournalEntryMaybeRepeat(
          artifactsDir,
          { ...full, requestId: "20260908T000001Z-a1", timestamp: 1800000000001 },
          (repeatOf) =>
            buildJournalRepeatMarker({
              capability: "search",
              provider: { mode: "single", effective: "zai", servedFrom: "cache" },
              repeatOf,
              now: () => 1800000000001,
            }),
        ),
        appendJournalEntryMaybeRepeat(
          artifactsDir,
          { ...full, requestId: "20260908T000001Z-a2", timestamp: 1800000000002 },
          (repeatOf) =>
            buildJournalRepeatMarker({
              capability: "search",
              provider: { mode: "single", effective: "zai", servedFrom: "cache" },
              repeatOf,
              now: () => 1800000000002,
            }),
        ),
      ]);
      const { log } = await readLog(artifactsDir);
      const markers = log.entries.filter((e) => e.repeatOf !== undefined);
      const fulls = log.entries.filter((e) => e.repeatOf === undefined);
      assert.strictEqual(fulls.length, 1, "exactly one full entry");
      assert.strictEqual(markers.length, 2, "both racers wrote markers (no duplicate full)");
      for (const m of markers) {
        assert.strictEqual(m.repeatOf, "20260908T000000Z-atomic");
      }
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });

  it("cache-hit + --save → the repeat marker carries the saveRef cross-link (single path)", async () => {
    const artifactsDir = makeTempDir("scoutline-journal-saveref-");
    const responseCache = createInMemoryResponseCache();
    try {
      const seen = [];
      const mkDeps = (adapter) =>
        journalDeps(adapter, seen, {
          env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir },
          searchCache: responseCache,
        });
      // Miss run with --save → full entry + save entry.
      const exportDir = makeTempDir("scoutline-journal-saveref-exp-");
      const exportTarget = join(exportDir, "report.json");
      const a1 = makeAdapter();
      const s1 = await main(["search", "rust vs go", "--save", exportTarget], mkDeps(a1.adapter));
      assert.strictEqual(s1, 0);
      let store = readJournalEntries(artifactsDir);
      assert.ok(store.entries.some((e) => e.kind === "save"));
      // Warm-cache hit run with --save → marker with saveRef.
      const a2 = makeAdapter();
      const s2 = await main(
        ["search", "rust vs go", "--save", exportTarget, "--save-force"],
        mkDeps(a2.adapter),
      );
      assert.strictEqual(s2, 0);
      store = readJournalEntries(artifactsDir);
      const markers = store.entries.filter((e) => e.kind === "journal" && e.repeatOf !== undefined);
      assert.ok(markers.length >= 1, "a marker was written for the cache hit");
      const marker = markers[markers.length - 1];
      assert.ok(
        typeof marker.saveRef === "string" && marker.saveRef.length > 0,
        `warm-cache marker must carry saveRef, got ${JSON.stringify(marker)}`,
      );
      const saves = store.entries.filter((e) => e.kind === "save");
      assert.ok(
        saves.some((s) => s.requestId === marker.saveRef),
        "saveRef points at a real save entry",
      );
      rmSync(exportDir, { recursive: true, force: true });
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });

  it("search query containing a literal LINKUP_API_KEY value redacts it in the journal entry", async () => {
    const artifactsDir = makeTempDir("scoutline-journal-linkup-redact-");
    const log = [];
    const SECRET = "sk-linkup-secret-8f2e1a9b4c";
    const { adapter, stderr } = makeAdapter();
    try {
      const status = await main(
        [`search`, `pricing ${SECRET}`],
        hermeticMainDeps({
          invocation: adapter,
          env: {
            SCOUTLINE_ARTIFACTS_DIR: artifactsDir,
            LINKUP_API_KEY: SECRET,
          },
          providerDescriptors: [makeSearchDescriptor("zai", log)],
          loadScoutlineConfig: async () => ({ version: 1, providers: {}, journal: true }),
        }),
      );
      assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
      const raw = readFileSync(join(artifactsDir, "index.json"), "utf8");
      assert.ok(!raw.includes(SECRET), "LINKUP secret leaked into the journal log");
      const store = JSON.parse(raw);
      assert.ok(!JSON.stringify(store.entries[0].query).includes(SECRET));
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });
});
