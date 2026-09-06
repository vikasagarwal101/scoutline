/**
 * T2 — Watch store: registry CRUD, bounded snapshot ring, append-only
 * change log.
 *
 * Pins (watch-temporal-diff lane B, ticket T2):
 *   1. resolveWatchDir: SCOUTLINE_WATCH_DIR wins; else
 *      <resolveConfigRootPure(env)>/watch. Pure — no disk, no process.env.
 *   2. Registry: addTarget validates (URL, name uniqueness CASE-SENSITIVE,
 *      keep integer 1..100), mints newRequestId-style sortable ids, ids
 *      never reused (fresh id on re-add after remove); listTargets /
 *      getTarget / removeTarget (identity-guarded; default leaves the
 *      per-target dir, --purge removes it).
 *   3. Ring: appendSnapshot returns 1-based gens monotonic per target
 *      (derived from max, NOT file count); metadata-only snapshots are
 *      JSON, byte-exact round-trip through readSnapshot; atomic-enough
 *      write first + unlink old gens AFTER (a crash mid-prune leaves
 *      extra old gens; the next append re-prunes).
 *   4. Ring NEVER advances on a failed capture: an `error` change-log
 *      entry leaves the snapshot listing's max gen unchanged.
 *   5. Change log: JSONL append-only, NEVER pruned; kinds
 *      baseline|change|moved|error|no-change; unknown kind → ValidationError
 *      BEFORE any write; readChangeLog fails CLOSED LOUDLY on unknown kinds
 *      and malformed JSON (throws — never skips silently); missing/empty
 *      file → [].
 *   6. Concurrency: N concurrent appendSnapshot+appendChangeLog on the same
 *      target serialize — exactly N well-formed log lines, gens exactly
 *      1..N, no gaps or duplicates.
 *
 * Hermeticity: every path lives inside a withTempDir tmp dir, or is a pure
 * injected-env computation. Nothing reads process.env; nothing touches
 * ~/.scoutline.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { withTempDir } from "./helpers/temp-dir.js";
import { ValidationError } from "../dist/lib/errors.js";
import {
    resolveWatchDir,
    addTarget,
    listTargets,
    getTarget,
    removeTarget,
    appendSnapshot,
    listSnapshots,
    readSnapshot,
    appendChangeLog,
    readChangeLog,
    WATCH_REGISTRY_FILENAME,
} from "../dist/lib/watch-store.js";

// Injected instants — never Date.now() (repo time-injection rule).
const NOW_1 = new Date("2026-09-05T12:00:00Z");
const NOW_2 = new Date("2026-09-06T12:00:00Z");

/** Deterministic randomBytes double: distinct 2-byte tails per call. */
function byteStream(seed) {
    let n = seed & 0xff;
    return (size) => {
        const out = new Uint8Array(size);
        for (let i = 0; i < size; i += 1) {
            n = (n * 31 + 7) & 0xff;
            out[i] = n;
        }
        return out;
    };
}

// Small lock timings so contention tests resolve fast.
const FAST_LOCK = { timeoutMs: 5000, staleMs: 2000 };

// --------------------------------------------------------- resolveWatchDir

describe("resolveWatchDir", () => {
    it("SCOUTLINE_WATCH_DIR wins over the config root", () => {
        const dir = resolveWatchDir(
            { SCOUTLINE_WATCH_DIR: "/tmp/watch-override" },
            { homedir: "/home/tester" },
        );
        assert.equal(dir, "/tmp/watch-override");
    });

    it("falls back to <config root>/watch", () => {
        const dir = resolveWatchDir({}, { homedir: "/home/tester" });
        assert.equal(dir, path.join("/home/tester", ".scoutline", "watch"));
    });

    it("config-root env override composes into the fallback", () => {
        const dir = resolveWatchDir(
            { SCOUTLINE_CONFIG_DIR: "/tmp/cfg" },
            { homedir: "/home/tester" },
        );
        assert.equal(dir, path.join("/tmp/cfg", "watch"));
    });

    it("empty SCOUTLINE_WATCH_DIR is treated as unset", () => {
        const dir = resolveWatchDir(
            { SCOUTLINE_WATCH_DIR: "", SCOUTLINE_CONFIG_DIR: "/tmp/cfg" },
            { homedir: "/home/tester" },
        );
        assert.equal(dir, path.join("/tmp/cfg", "watch"));
    });
});

// ---------------------------------------------------------------- registry

describe("registry CRUD", () => {
    it("addTarget round-trips a target through listTargets and getTarget", async (t) => {
        await withTempDir(t, async (root) => {
            const added = await addTarget(root, {
                url: "https://example.com/docs",
                name: "example-docs",
                now: NOW_1,
                randomBytes: byteStream(1),
            });
            assert.equal(added.name, "example-docs");
            assert.equal(added.url, "https://example.com/docs");
            assert.equal(added.type, "page");
            assert.equal(added.keep, 5);
            assert.equal(added.createdAt, NOW_1.toISOString());
            assert.match(added.id, /^20260905T120000Z-[0-9a-f]{4}$/);

            const targets = await listTargets(root);
            assert.equal(targets.length, 1);
            assert.deepEqual(targets[0], added);

            assert.deepEqual(await getTarget(root, added.id), added);
        });
    });

    it("addTarget mints ids that differ within the same second (newRequestId style)", async (t) => {
        await withTempDir(t, async (root) => {
            const a = await addTarget(root, { url: "https://a.example/", now: NOW_1, randomBytes: byteStream(11) });
            const b = await addTarget(root, { url: "https://b.example/", now: NOW_1, randomBytes: byteStream(77) });
            assert.notEqual(a.id, b.id);
        });
    });

    it("addTarget rejects a non-http(s) URL with ValidationError", async (t) => {
        await withTempDir(t, async (root) => {
            await assert.rejects(
                addTarget(root, { url: "ftp://example.com/docs", now: NOW_1 }),
                (error) => error instanceof ValidationError,
            );
            await assert.rejects(
                addTarget(root, { url: "not a url", now: NOW_1 }),
                (error) => error instanceof ValidationError,
            );
            // Nothing was persisted by a rejected add.
            assert.deepEqual(await listTargets(root), []);
        });
    });

    it("name uniqueness is case-sensitive: 'Docs' and 'docs' are distinct names", async (t) => {
        await withTempDir(t, async (root) => {
            await addTarget(root, { url: "https://a.example/", name: "Docs", now: NOW_1 });
            await addTarget(root, { url: "https://b.example/", name: "docs", now: NOW_1 });
            const targets = await listTargets(root);
            assert.equal(targets.length, 2);
            assert.deepEqual(
                new Set(targets.map((x) => x.name)),
                new Set(["Docs", "docs"]),
            );
        });
    });

    it("duplicate name (exact, case-sensitively) is rejected with ValidationError", async (t) => {
        await withTempDir(t, async (root) => {
            await addTarget(root, { url: "https://a.example/", name: "docs", now: NOW_1 });
            await assert.rejects(
                addTarget(root, { url: "https://b.example/", name: "docs", now: NOW_2 }),
                (error) => error instanceof ValidationError,
            );
            assert.equal((await listTargets(root)).length, 1);
        });
    });

    it("keep must be an integer in 1..100 — 0, -1, 100.5, 101 are rejected", async (t) => {
        await withTempDir(t, async (root) => {
            for (const keep of [0, -1, 100.5, 101]) {
                await assert.rejects(
                    addTarget(root, { url: "https://a.example/", keep, now: NOW_1 }),
                    (error) => error instanceof ValidationError,
                );
            }
            await addTarget(root, { url: "https://a.example/", keep: 1, now: NOW_1 });
            await addTarget(root, { url: "https://b.example/", keep: 100, now: NOW_1 });
            assert.equal((await listTargets(root)).length, 2);
        });
    });

    it("removeTarget: default removal deletes ONLY the registry entry, leaves the per-target dir", async (t) => {
        await withTempDir(t, async (root) => {
            const added = await addTarget(root, { url: "https://example.com/", now: NOW_1 });
            await appendChangeLog(root, added.id, { at: NOW_1, kind: "baseline", exit: 0, gen: 1 });
            const removed = await removeTarget(root, added.name);
            assert.equal(removed.id, added.id);
            assert.deepEqual(await listTargets(root), []);
            const dir = await fs.readdir(root);
            assert.deepEqual(dir.sort(), [WATCH_REGISTRY_FILENAME, added.id].sort());
        });
    });

    it("removeTarget: purge removes the per-target dir too", async (t) => {
        await withTempDir(t, async (root) => {
            const added = await addTarget(root, { url: "https://example.com/", now: NOW_1 });
            await appendChangeLog(root, added.id, { at: NOW_1, kind: "baseline", exit: 0, gen: 1 });
            await removeTarget(root, added.id, { purge: true });
            assert.deepEqual(await fs.readdir(root), [WATCH_REGISTRY_FILENAME]);
        });
    });

    it("removeTarget resolves by exact id, else by exact name; unknown → ValidationError naming what was requested", async (t) => {
        await withTempDir(t, async (root) => {
            const added = await addTarget(root, { url: "https://example.com/", name: "docs", now: NOW_1 });
            await removeTarget(root, added.name); // by name
            const readded = await addTarget(root, { url: "https://example.com/", name: "docs", now: NOW_2 });
            await removeTarget(root, readded.id); // by id
            await assert.rejects(
                removeTarget(root, "no-such-target"),
                (error) =>
                    error instanceof ValidationError &&
                    error.message.includes("no-such-target"),
            );
        });
    });

    it("ids are never reused: re-adding after removal mints a fresh id (retired-id collision re-mints)", async (t) => {
        await withTempDir(t, async (root) => {
            const first = await addTarget(root, {
                url: "https://example.com/",
                now: NOW_1,
                randomBytes: byteStream(3),
            });
            await removeTarget(root, first.id);
            // Same now + same byteStream tail: the mint collides with the
            // RETIRED id first time around; the store must re-mint.
            let calls = 0;
            const collidingThenFresh = (size) => {
                calls += 1;
                return calls === 1 ? byteStream(3)(size) : byteStream(99)(size);
            };
            const second = await addTarget(root, {
                url: "https://example.com/",
                now: NOW_1,
                randomBytes: collidingThenFresh,
            });
            assert.notEqual(second.id, first.id);
        });
    });

    it("registry persists to targets.json across reads", async (t) => {
        await withTempDir(t, async (root) => {
            await addTarget(root, { url: "https://example.com/", name: "docs", now: NOW_1 });
            const raw = await fs.readFile(path.join(root, "targets.json"), "utf8");
            const parsed = JSON.parse(raw);
            assert.ok(Array.isArray(parsed.targets));
            assert.equal(parsed.targets.length, 1);
            assert.equal(parsed.targets[0].name, "docs");
        });
    });
});

// --------------------------------------------------------------- ring

describe("snapshot ring", () => {
    it("appendSnapshot returns 1-based monotonic gens derived from the max gen, not the file count", async (t) => {
        await withTempDir(t, async (root) => {
            const added = await addTarget(root, { url: "https://example.com/", now: NOW_1 });
            assert.equal(await appendSnapshot(root, added.id, { body: new TextEncoder().encode("v1"), now: NOW_1, lock: FAST_LOCK }), 1);
            assert.equal(await appendSnapshot(root, added.id, { body: new TextEncoder().encode("v2"), now: NOW_2, lock: FAST_LOCK }), 2);
            // Plant a stale old generation on disk: gen numbering must come
            // from the MAX gen (2), not from counting files (3 files → 3).
            await fs.writeFile(
                path.join(root, added.id, "snapshots", "gen-1.snapshot"),
                JSON.stringify({ gen: 1, capturedAt: NOW_1.toISOString() }) + "\n",
            );
            assert.equal(await appendSnapshot(root, added.id, { body: new TextEncoder().encode("v3"), now: NOW_2, lock: FAST_LOCK }), 3);
        });
    });

    it("readSnapshot returns the raw bytes byte-exactly plus gen metadata", async (t) => {
        await withTempDir(t, async (root) => {
            const added = await addTarget(root, { url: "https://example.com/", now: NOW_1 });
            const body = new TextEncoder().encode("<h1>biñary\r\n\xff</h1>");
            const gen = await appendSnapshot(root, added.id, { body, now: NOW_1, lock: FAST_LOCK });
            const snapshot = await readSnapshot(root, added.id, gen);
            assert.equal(snapshot.gen, gen);
            assert.deepEqual(snapshot.body, body);
        });
    });

    it("readSnapshot on a missing gen throws ValidationError", async (t) => {
        await withTempDir(t, async (root) => {
            const added = await addTarget(root, { url: "https://example.com/", now: NOW_1 });
            await assert.rejects(
                readSnapshot(root, added.id, 1),
                (error) => error instanceof ValidationError,
            );
        });
    });

    it("appendSnapshot stores contentType/charset metadata alongside the bytes", async (t) => {
        await withTempDir(t, async (root) => {
            const added = await addTarget(root, { url: "https://example.com/", now: NOW_1 });
            const gen = await appendSnapshot(root, added.id, {
                body: new TextEncoder().encode("x"),
                now: NOW_1,
                contentType: "text/html; charset=gbk",
                finalUrl: "https://example.com/final",
                lock: FAST_LOCK,
            });
            const listing = await listSnapshots(root, added.id);
            assert.equal(listing.length, 1);
            assert.equal(listing[0].gen, gen);
            assert.equal(listing[0].contentType, "text/html; charset=gbk");
            assert.equal(listing[0].finalUrl, "https://example.com/final");
            assert.equal(listing[0].capturedAt, NOW_1.toISOString());
            assert.equal(listing[0].byteLength, 1);
        });
    });

    it("ring prunes to keep the newest N generations (default 5)", async (t) => {
        await withTempDir(t, async (root) => {
            const added = await addTarget(root, { url: "https://example.com/", now: NOW_1 });
            for (let i = 0; i < 8; i += 1) {
                await appendSnapshot(root, added.id, {
                    body: new TextEncoder().encode(`v${i}`),
                    now: NOW_1,
                    lock: FAST_LOCK,
                });
            }
            const listing = await listSnapshots(root, added.id);
            assert.equal(listing.length, 5);
            assert.deepEqual(
                listing.map((s) => s.gen),
                [4, 5, 6, 7, 8],
            );
        });
    });

    it("per-target keep overrides the default ring size", async (t) => {
        await withTempDir(t, async (root) => {
            const added = await addTarget(root, { url: "https://example.com/", keep: 2, now: NOW_1 });
            for (let i = 0; i < 4; i += 1) {
                await appendSnapshot(root, added.id, {
                    body: new TextEncoder().encode(`v${i}`),
                    now: NOW_1,
                    lock: FAST_LOCK,
                });
            }
            const listing = await listSnapshots(root, added.id);
            assert.deepEqual(
                listing.map((s) => s.gen),
                [3, 4],
            );
        });
    });

    it("leftover old generations beyond the ring are re-pruned on the next append", async (t) => {
        await withTempDir(t, async (root) => {
            const added = await addTarget(root, { url: "https://example.com/", keep: 2, now: NOW_1 });
            for (let i = 0; i < 3; i += 1) {
                await appendSnapshot(root, added.id, {
                    body: new TextEncoder().encode(`v${i}`),
                    now: NOW_1,
                    lock: FAST_LOCK,
                });
            }
            // Simulate a crash mid-prune: a stale gen-1 file survives.
            await fs.writeFile(
                path.join(root, added.id, "snapshots", "gen-1.snapshot"),
                JSON.stringify({ gen: 1, capturedAt: NOW_1.toISOString() }) + "\n",
            );
            await appendSnapshot(root, added.id, { body: new TextEncoder().encode("v3"), now: NOW_1, lock: FAST_LOCK });
            const listing = await listSnapshots(root, added.id);
            assert.deepEqual(
                listing.map((s) => s.gen),
                [3, 4],
            );
        });
    });

    it("appendSnapshot on an unknown target id is a ValidationError, not a silent directory creation", async (t) => {
        await withTempDir(t, async (root) => {
            await assert.rejects(
                appendSnapshot(root, "20260905T120000Z-dead", {
                    body: new TextEncoder().encode("x"),
                    now: NOW_1,
                    lock: FAST_LOCK,
                }),
                (error) => error instanceof ValidationError,
            );
            assert.deepEqual(await fs.readdir(root), []);
        });
    });

    it("listSnapshots on a target with no snapshots is []", async (t) => {
        await withTempDir(t, async (root) => {
            const added = await addTarget(root, { url: "https://example.com/", now: NOW_1 });
            assert.deepEqual(await listSnapshots(root, added.id), []);
        });
    });
});

// ------------------------------------------------------------ change log

describe("change log", () => {
    const baseEntry = { at: NOW_1, kind: "baseline", exit: 0, gen: 1 };

    it("appendChangeLog writes one \\n-terminated JSON line per entry, in order", async (t) => {
        await withTempDir(t, async (root) => {
            const added = await addTarget(root, { url: "https://example.com/", now: NOW_1 });
            await appendChangeLog(root, added.id, baseEntry);
            await appendChangeLog(root, added.id, {
                at: NOW_2,
                kind: "change",
                exit: 1,
                gen: 2,
                added: ["Security"],
                removed: [],
                changed: ["Install"],
                hashOnly: false,
                finalUrl: "https://example.com/docs",
            });
            const raw = await fs.readFile(path.join(root, added.id, "change-log.jsonl"), "utf8");
            const lines = raw.split("\n");
            assert.equal(lines.length, 3); // 2 entries + trailing newline
            assert.equal(lines[2], "");
            const entries = lines.slice(0, 2).map((l) => JSON.parse(l));
            assert.equal(entries[0].kind, "baseline");
            assert.equal(entries[1].kind, "change");
            assert.deepEqual(entries[1].added, ["Security"]);
            assert.equal(entries[1].hashOnly, false);
        });
    });

    it("every documented kind is accepted", async (t) => {
        await withTempDir(t, async (root) => {
            const added = await addTarget(root, { url: "https://example.com/", now: NOW_1 });
            for (const kind of ["baseline", "change", "moved", "error", "no-change"]) {
                await appendChangeLog(root, added.id, { at: NOW_1, kind, exit: 0, gen: 1 });
            }
            const entries = await readChangeLog(root, added.id);
            assert.deepEqual(
                entries.map((e) => e.kind),
                ["baseline", "change", "moved", "error", "no-change"],
            );
        });
    });

    it("unknown kind is rejected with ValidationError BEFORE any write", async (t) => {
        await withTempDir(t, async (root) => {
            const added = await addTarget(root, { url: "https://example.com/", now: NOW_1 });
            await appendChangeLog(root, added.id, baseEntry);
            await assert.rejects(
                appendChangeLog(root, added.id, { at: NOW_2, kind: "mystery", exit: 1, gen: 2 }),
                (error) => error instanceof ValidationError,
            );
            // The rejected entry never hit the file.
            const entries = await readChangeLog(root, added.id);
            assert.equal(entries.length, 1);
        });
    });

    it("readChangeLog: missing file → []; error entries carry gen null", async (t) => {
        await withTempDir(t, async (root) => {
            const added = await addTarget(root, { url: "https://example.com/", now: NOW_1 });
            assert.deepEqual(await readChangeLog(root, added.id), []);
            await appendChangeLog(root, added.id, { at: NOW_1, kind: "error", exit: 2, gen: null });
            const entries = await readChangeLog(root, added.id);
            assert.equal(entries.length, 1);
            assert.equal(entries[0].gen, null);
            assert.equal(entries[0].exit, 2);
        });
    });

    it("readChangeLog fails CLOSED LOUDLY on an unknown kind in the file (throws, never skips)", async (t) => {
        await withTempDir(t, async (root) => {
            const added = await addTarget(root, { url: "https://example.com/", now: NOW_1 });
            await appendChangeLog(root, added.id, baseEntry);
            // Scratch-corrupt: an unknown kind from a future writer.
            await fs.appendFile(
                path.join(root, added.id, "change-log.jsonl"),
                JSON.stringify({ at: NOW_1.toISOString(), kind: "future-kind", exit: 0, gen: 3 }) + "\n",
            );
            await assert.rejects(
                readChangeLog(root, added.id),
                (error) => error instanceof ValidationError,
            );
        });
    });

    it("readChangeLog fails CLOSED LOUDLY on malformed JSON (throws, never skips)", async (t) => {
        await withTempDir(t, async (root) => {
            const added = await addTarget(root, { url: "https://example.com/", now: NOW_1 });
            await appendChangeLog(root, added.id, baseEntry);
            await fs.appendFile(path.join(root, added.id, "change-log.jsonl"), "{not json\n");
            await assert.rejects(
                readChangeLog(root, added.id),
                (error) => error instanceof ValidationError,
            );
        });
    });

    it("the change log is NEVER pruned by ring advancement", async (t) => {
        await withTempDir(t, async (root) => {
            const added = await addTarget(root, { url: "https://example.com/", keep: 2, now: NOW_1 });
            for (let i = 0; i < 6; i += 1) {
                await appendSnapshot(root, added.id, { body: new TextEncoder().encode(`v${i}`), now: NOW_1, lock: FAST_LOCK });
                await appendChangeLog(root, added.id, { at: NOW_1, kind: "no-change", exit: 0, gen: i + 1 });
            }
            const entries = await readChangeLog(root, added.id);
            assert.equal(entries.length, 6);
        });
    });

    it("change-log.jsonl is created 0600 (the atomicReplaceFile discipline)", async (t) => {
        await withTempDir(t, async (root) => {
            const added = await addTarget(root, { url: "https://example.com/", now: NOW_1 });
            await appendChangeLog(root, added.id, baseEntry);
            const stat = await fs.stat(path.join(root, added.id, "change-log.jsonl"));
            assert.equal(stat.mode & 0o777, 0o600);
        });
    });
});

// ------------------------------------------------- ring non-advance on error

describe("ring non-advance on failed capture", () => {
    it("an error change-log entry leaves the snapshot listing's max gen unchanged", async (t) => {
        await withTempDir(t, async (root) => {
            const added = await addTarget(root, { url: "https://example.com/", now: NOW_1 });
            await appendSnapshot(root, added.id, { body: new TextEncoder().encode("v1"), now: NOW_1, lock: FAST_LOCK });
            const before = await listSnapshots(root, added.id);
            const maxBefore = Math.max(...before.map((s) => s.gen));
            // Failed capture: ONLY a change-log entry, no snapshot append —
            // the store exposes no other gen-advancing call than appendSnapshot.
            await appendChangeLog(root, added.id, { at: NOW_2, kind: "error", exit: 2, gen: null });
            const after = await listSnapshots(root, added.id);
            assert.equal(after.length, before.length);
            const maxAfter = Math.max(...after.map((s) => s.gen));
            assert.equal(maxAfter, maxBefore);
            const entries = await readChangeLog(root, added.id);
            assert.equal(entries[entries.length - 1].kind, "error");
        });
    });
});

// --------------------------------------------------------- concurrency

describe("watch store review fixes", () => {
    it("addTarget preserves retiredIds tombstones across a remove-then-add (review)", async () => {
        const root = await fs.mkdtemp(path.join("/tmp", "scoutline-store-review-"));
        try {
            const added = await addTarget(root, { url: "https://retire.example/a", name: "retire-a" });
            await removeTarget(root, added.id, { purge: true });
            await addTarget(root, { url: "https://retire.example/b", name: "retire-b" });
            const registry = JSON.parse(
                await fs.readFile(path.join(root, "targets.json"), "utf8"),
            );
            assert.ok(
                (registry.retiredIds ?? []).includes(added.id),
                "tombstone for the removed id must survive the next add",
            );
        } finally {
            await fs.rm(root, { recursive: true, force: true }).catch(() => {});
        }
    });

    it("extra blank JSONL lines in the log fail closed (review)", async () => {
        const root = await fs.mkdtemp(path.join("/tmp", "scoutline-store-review-"));
        try {
            const added = await addTarget(root, { url: "https://blank.example/a", name: "blank-a" });
            await appendChangeLog(root, added.id, { at: NOW_1, kind: "baseline", exit: 0, gen: 1 });
            const file = path.join(root, added.id, "change-log.jsonl");
            const original = await fs.readFile(file, "utf8");
            await fs.writeFile(file, original + "\n\n");
            await assert.rejects(
                () => readChangeLog(root, added.id),
                (err) => err instanceof ValidationError,
            );
        } finally {
            await fs.rm(root, { recursive: true, force: true }).catch(() => {});
        }
    });
});

describe("watch store review fixes round 2", () => {
    it("an empty change-log file reads as [] (review)", async () => {
        const root = await fs.mkdtemp(path.join("/tmp", "scoutline-store-r2-"));
        try {
            const added = await addTarget(root, { url: "https://empty.example/a", name: "empty-a" });
            const file = path.join(root, added.id, "change-log.jsonl");
            await fs.mkdir(path.dirname(file), { recursive: true });
            await fs.writeFile(file, "");
            assert.deepEqual(await readChangeLog(root, added.id), []);
        } finally {
            await fs.rm(root, { recursive: true, force: true }).catch(() => {});
        }
    });

    it("a structurally malformed entry fails closed, not at:undefined/NaN (review)", async () => {
        const root = await fs.mkdtemp(path.join("/tmp", "scoutline-store-r2-"));
        try {
            const added = await addTarget(root, { url: "https://mal.example/a", name: "mal-a" });
            const file = path.join(root, added.id, "change-log.jsonl");
            await fs.mkdir(path.dirname(file), { recursive: true });
            await fs.writeFile(file, JSON.stringify({ kind: "change" }) + "\n");
            await assert.rejects(
                () => readChangeLog(root, added.id),
                (err) => err instanceof ValidationError,
            );
        } finally {
            await fs.rm(root, { recursive: true, force: true }).catch(() => {});
        }
    });
});

describe("concurrent double-fire serializes", () => {
    it("N concurrent appendSnapshot+appendChangeLog → N log lines, gens exactly 1..N", async (t) => {
        await withTempDir(t, async (root) => {
            const added = await addTarget(root, { url: "https://example.com/", now: NOW_1 });
            const N = 12;
            const work = [];
            for (let i = 0; i < N; i += 1) {
                const body = new TextEncoder().encode(`v${i}`);
                work.push(
                    appendSnapshot(root, added.id, { body, now: NOW_1, lock: FAST_LOCK }).then((gen) =>
                        appendChangeLog(root, added.id, {
                            at: NOW_1,
                            kind: gen === 1 ? "baseline" : "no-change",
                            exit: 0,
                            gen,
                        }, { lock: FAST_LOCK }),
                    ),
                );
            }
            await Promise.all(work);
            const entries = await readChangeLog(root, added.id);
            assert.equal(entries.length, N);
            const gens = entries.map((e) => e.gen).sort((a, b) => a - b);
            assert.deepEqual(gens, Array.from({ length: N }, (_, i) => i + 1));
            // Every line is well-formed JSON (readChangeLog would have thrown).
            const raw = await fs.readFile(path.join(root, added.id, "change-log.jsonl"), "utf8");
            assert.equal(raw.split("\n").filter((l) => l !== "").length, N);
        });
    });
});

// ---------------------------------------------------------------------------
// Review round 3: registry as trust boundary, purge/tick serialization,
// orphan-byte sweep, prune error propagation, log mode repair
// ---------------------------------------------------------------------------

describe("watch store review round 3", () => {
    const withTemp = (t, fn) => withTempDir(t, fn);

    it("rejects a crafted registry row with a path-escaping id (../..)", async (t) => {
        await withTemp(t, async (root) => {
            await fs.mkdir(root, { recursive: true });
            const victim = path.join(path.dirname(root), "victim-" + Date.now());
            await fs.mkdir(victim, { recursive: true });
            await fs.writeFile(path.join(victim, "keep-me"), "evidence");
            await fs.writeFile(
                path.join(root, "targets.json"),
                JSON.stringify({
                    targets: [{
                        id: "../..",
                        name: "evil",
                        type: "page",
                        url: "https://evil.example/",
                        keep: 5,
                        createdAt: "2026-09-05T12:00:00Z",
                    }],
                }),
            );
            await assert.rejects(
                () => listTargets(root),
                (err) => err instanceof ValidationError && /row 0/.test(err.message),
            );
            await assert.rejects(
                () => removeTarget(root, "evil", { purge: true }),
                ValidationError,
            );
            // The escape was never reachable, but prove the victim survived.
            assert.equal((await fs.readdir(victim)).includes("keep-me"), true);
            await fs.rm(victim, { recursive: true, force: true }).catch(() => {});
        });
    });

    it("rejects a hand-edited registry row with a non-http(s) URL (fail closed before run)", async (t) => {
        await withTemp(t, async (root) => {
            await fs.mkdir(root, { recursive: true });
            for (const url of ["ftp://evil.example/docs", "file:///etc/passwd", "javascript:alert(1)"]) {
                await fs.writeFile(
                    path.join(root, "targets.json"),
                    JSON.stringify({
                        targets: [{
                            id: "20260905T120000Z-abcd",
                            name: "evil",
                            type: "page",
                            url,
                            keep: 5,
                            createdAt: "2026-09-05T12:00:00Z",
                        }],
                    }),
                );
                await assert.rejects(
                    () => listTargets(root),
                    (err) => err instanceof ValidationError,
                    `hand-edited url ${url} must fail closed`,
                );
            }
        });
    });

    it("purge waits for a holder of the tick lock (same lock file as runTick)", async (t) => {
        await withTemp(t, async (root) => {
            const added = await addTarget(root, { url: "https://tick.example/", name: "tick", now: NOW_1 });
            await appendSnapshot(root, added.id, {
                body: new TextEncoder().encode("v0"),
                now: NOW_1,
                lock: FAST_LOCK,
            });
            // Hold runTick's tick lock by hand: lock path mirrors
            // withTargetTickLock — stateDir = path.join(root, id),
            // identity = "watch-tick-<id>".
            const lockDir = path.join(root, added.id);
            await fs.mkdir(lockDir, { recursive: true });
            const lockPath = path.join(lockDir, `watch-tick-${added.id}.lock`);
            const handle = await fs.open(lockPath, "wx");
            let purged = false;
            const purge = removeTarget(root, added.id, { purge: true, lock: FAST_LOCK })
                .then(() => { purged = true; });
            // The purge must NOT complete while the tick lock is held —
            // it guards the same file the tick holds, not a root-level twin.
            await new Promise((r) => setTimeout(r, 150));
            assert.equal(purged, false, "purge completed without waiting for the tick lock");
            await handle.close();
            await fs.unlink(lockPath).catch(() => {});
            await purge;
            assert.equal(purged, true);
            await assert.rejects(() => fs.access(path.join(root, added.id)));
        });
    });

    it("rejects malformed registry rows: wrong-type fields, bad id grammar, bad keep", async (t) => {
        await withTemp(t, async (root) => {
            await fs.mkdir(root, { recursive: true });
            const badRows = [
                { id: "20260905T120000Z-0g0g", name: "n", url: "https://a.example/", keep: 5, createdAt: "2026-09-05T12:00:00Z" }, // non-hex
                { id: "20260905T120000Z-ab", name: "n", url: "https://a.example/", keep: 5, createdAt: "2026-09-05T12:00:00Z" }, // short
                { id: "20260905T120000Z-abcd", name: "", url: "https://a.example/", keep: 5, createdAt: "2026-09-05T12:00:00Z" }, // empty name
                { id: "20260905T120000Z-abcd", name: "n", url: "", keep: 5, createdAt: "2026-09-05T12:00:00Z" }, // empty url
                { id: "20260905T120000Z-abcd", name: "n", url: "https://a.example/", keep: 1.5, createdAt: "2026-09-05T12:00:00Z" }, // non-integer
                { id: "20260905T120000Z-abcd", name: "n", url: "https://a.example/", keep: 0, createdAt: "2026-09-05T12:00:00Z" }, // below min
                { id: "20260905T120000Z-abcd", name: "n", url: "https://a.example/", keep: 5, createdAt: "not-a-date" }, // bad createdAt
                { id: "20260905T120000Z-abcd", name: "n", type: "query", url: "https://a.example/", keep: 5, createdAt: "2026-09-05T12:00:00Z" }, // unknown type
                "not-an-object",
            ];
            for (const [i, row] of badRows.entries()) {
                await fs.writeFile(
                    path.join(root, "targets.json"),
                    JSON.stringify({ targets: [row] }),
                );
                await assert.rejects(
                    () => listTargets(root),
                    (err) => err instanceof ValidationError && /row 0|row 0/i.test(err.message),
                    `row ${i} (${JSON.stringify(row)}) must be rejected`,
                );
            }
        });
    });

    it("rejects a malformed retiredIds tombstone", async (t) => {
        await withTemp(t, async (root) => {
            await fs.mkdir(root, { recursive: true });
            await fs.writeFile(
                path.join(root, "targets.json"),
                JSON.stringify({ targets: [], retiredIds: ["../../etc"] }),
            );
            await assert.rejects(() => listTargets(root), ValidationError);
        });
    });

    it("purged target: an append racing after purge is rejected, not recreated", async (t) => {
        await withTemp(t, async (root) => {
            const added = await addTarget(root, { url: "https://race.example/", name: "race", now: NOW_1 });
            // Seed one generation so the directory exists.
            await appendSnapshot(root, added.id, {
                body: new TextEncoder().encode("v0"),
                now: NOW_1,
                lock: FAST_LOCK,
            });
            // Hold the target append lock, start the purge, let it wait
            // on the lock, then release: the registry rewrite happens
            // BEFORE the lock wait, so the late append must be refused.
            const unlock = await withHeldTargetLock(root, added.id);
            const purge = removeTarget(root, added.id, { purge: true, lock: FAST_LOCK });
            await new Promise((r) => setTimeout(r, 120));
            const lateAppend = appendSnapshot(root, added.id, {
                body: new TextEncoder().encode("late"),
                now: NOW_1,
                lock: FAST_LOCK,
            }).then(
                () => "appended",
                () => "rejected",
            );
            await unlock();
            await purge;
            const outcome = await lateAppend;
            assert.equal(outcome, "rejected");
            // And no evidence was recreated under the purged id.
            await assert.rejects(() => fs.access(path.join(root, added.id)));
        });
    });

    it("orphaned snapshot BYTES files (crashed prune) are swept by the next append", async (t) => {
        await withTemp(t, async (root) => {
            const added = await addTarget(root, {
                url: "https://sweep.example/", name: "sweep", keep: 2, now: NOW_1,
            });
            for (let i = 0; i < 3; i += 1) {
                await appendSnapshot(root, added.id, {
                    body: new TextEncoder().encode(`v${i}`),
                    now: NOW_1, lock: FAST_LOCK,
                });
            }
            const dir = path.join(root, added.id, "snapshots");
            // Simulate a crashed prune: bytes without metadata.
            await fs.writeFile(path.join(dir, "gen-99.snapshot.bytes"), "orphan");
            const before = await fs.readdir(dir);
            assert.equal(before.includes("gen-99.snapshot.bytes"), true);
            await appendSnapshot(root, added.id, {
                body: new TextEncoder().encode("v3"),
                now: NOW_1, lock: FAST_LOCK,
            });
            const after = await fs.readdir(dir);
            assert.equal(after.includes("gen-99.snapshot.bytes"), false);
            // Ring stays bounded at keep=2.
            assert.equal((await listSnapshots(root, added.id)).length, 2);
        });
    });

    it("appendChangeLog repairs an existing log with broader permissions to 0600", async (t) => {
        await withTemp(t, async (root) => {
            const added = await addTarget(root, { url: "https://perm.example/", name: "perm", now: NOW_1 });
            const file = path.join(root, added.id, "change-log.jsonl");
            await fs.mkdir(path.dirname(file), { recursive: true });
            await fs.writeFile(file, "");
            await fs.chmod(file, 0o644);
            await appendChangeLog(root, added.id, { at: NOW_1, kind: "baseline", exit: 0, gen: 1 });
            const mode = (await fs.stat(file)).mode & 0o777;
            assert.equal(mode, 0o600);
        });
    });
});

/** Hold a target's append lock from outside the store; returns an unlock. */
async function withHeldTargetLock(root, id) {
    // Lock path mirrors withAsyncFileLock: <stateDir>/<identityHash>.lock,
    // stateDir = path.join(root, id), identity = targetLock(id).
    const lockDir = path.join(root, id);
    await fs.mkdir(lockDir, { recursive: true });
    const lockPath = path.join(lockDir, `watch-target-${id}.lock`);
    const handle = await fs.open(lockPath, "wx");
    return async () => {
        await handle.close();
        await fs.unlink(lockPath).catch(() => {});
    };
}
