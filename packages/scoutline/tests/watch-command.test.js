/**
 * T4 — watch add/list/remove command surface (watch-temporal-diff lane B).
 *
 * Pins:
 *   1. Hermetic main()-driven dispatch: SCOUTLINE_WATCH_DIR isolated per
 *      suite-scoped tmp dir, injected loadScoutlineConfig THROWS if
 *      called (watch is credential-free, dispatched before the config
 *      load — the archive/fetch precedent).
 *   2. add: entry shape (id/name/type/url/keep/createdAt), default name
 *      = host+path slug, --name, --keep bounds (CLI gate + store gate),
 *      http(s) URL validation, duplicate-name ValidationError.
 *   3. list: data envelope {schemaVersion, total, targets}.
 *   4. remove: by name AND by id; default keeps the per-target evidence
 *      dir, --purge deletes it; unknown target ValidationError.
 *   5. Parse-time guard: --isolated + watch subcommand = ValidationError;
 *      help/bare watch still render help.
 *   6. Terminal subcommand string (byte-pinned) and MAIN_HELP rows.
 *
 * Nothing reads process.env; nothing touches ~/.scoutline.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { main } from "../dist/index.js";
import { WATCH_HELP, parseWatchArgs } from "../dist/commands/watch.js";
import {
  appendChangeLog,
  listSnapshots,
  readChangeLog,
  WATCH_REGISTRY_FILENAME,
} from "../dist/lib/watch-store.js";

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
    setExitCode: (code) => {},
  };
  return { adapter, stdout, stderr };
}

/** One main() run against the suite-scoped watch root (per-test tmp subdir). */
function makeRunner(watchRoot, now) {
  return async (argv) => {
    const { adapter, stdout, stderr } = makeAdapter();
    const code = await main(argv, {
      invocation: adapter,
      env: { SCOUTLINE_WATCH_DIR: watchRoot },
      // Must never be reached: watch dispatches before the config load.
      loadScoutlineConfig: () => {
        throw new Error("Should not be called!");
      },
      ...(now ? { now } : {}),
    });
    return { code, stdout: stdout.join(""), stderr: stderr.join("") };
  };
}

describe("scoutline watch command (T4)", () => {
  let watchRoot;
  let run;

  before(async () => {
    watchRoot = await fs.mkdtemp(path.join(os.tmpdir(), "scoutline-watch-cmd-"));
    run = makeRunner(watchRoot);
  });

  after(async () => {
    await fs.rm(watchRoot, { recursive: true, force: true }).catch(() => {});
  });

  describe("Option Parsing & Validation", () => {
    it("parses add/list/remove argument shapes", () => {
      const parsed = parseWatchArgs([
        "add",
        "https://example.com/docs",
        "--name",
        "docs",
        "--keep",
        "10",
      ]);
      assert.equal(parsed.subcommand, "add");
      assert.equal(parsed.positional[0], "https://example.com/docs");
      assert.equal(parsed.flags.name, "docs");
      assert.equal(parsed.flags.keep, "10");

      assert.equal(parseWatchArgs(["list"]).subcommand, "list");
      const remove = parseWatchArgs(["remove", "docs", "--purge"]);
      assert.equal(remove.subcommand, "remove");
      assert.equal(remove.positional[0], "docs");
      assert.equal(remove.flags.purge, true);
    });

    it("rejects --keep outside 1..100, non-numeric, or valueless", async () => {
      for (const keep of ["0", "101", "abc", "1.5"]) {
        const r = await run(["watch", "add", "https://a.example/", "--keep", keep]);
        assert.equal(r.code, 1, `--keep ${keep} must be rejected`);
        assert.match(r.stderr, /VALIDATION_ERROR/);
        assert.match(r.stderr, /Invalid --keep/);
      }
      const valueless = await run(["watch", "add", "https://a.example/", "--keep"]);
      assert.equal(valueless.code, 1);
      assert.match(valueless.stderr, /--keep requires a value/);
    });

    it("rejects a valueless or empty --name", async () => {
      const valueless = await run(["watch", "add", "https://a.example/", "--name"]);
      assert.equal(valueless.code, 1);
      assert.match(valueless.stderr, /--name requires a value/);
      const empty = await run(["watch", "add", "https://a.example/", "--name", ""]);
      assert.equal(empty.code, 1);
      assert.match(empty.stderr, /VALIDATION_ERROR/);
    });

    it("requires a URL for add and a ref for remove", async () => {
      const add = await run(["watch", "add"]);
      assert.equal(add.code, 1);
      assert.match(add.stderr, /URL is required for watch add/);
      const remove = await run(["watch", "remove"]);
      assert.equal(remove.code, 1);
      assert.match(remove.stderr, /watch remove requires a target name or id/);
    });

    it("rejects non-http(s) URLs with VALIDATION_ERROR and persists nothing", async () => {
      for (const url of ["ftp://example.com/docs", "not a url", "httpx://example.com/"]) {
        const r = await run(["watch", "add", url]);
        assert.equal(r.code, 1, `${url} must be rejected`);
        assert.match(r.stderr, /VALIDATION_ERROR/);
      }
      // The rejected adds never wrote a registry.
      const list = await run(["watch", "list"]);
      assert.equal(JSON.parse(list.stdout).total, 0);
    });

    it("rejects a duplicate name (case-sensitive)", async () => {
      const first = await run(["watch", "add", "https://a.example/", "--name", "dup-docs"]);
      assert.equal(first.code, 0);
      const second = await run(["watch", "add", "https://b.example/", "--name", "dup-docs"]);
      assert.equal(second.code, 1);
      assert.match(second.stderr, /already in use/);
      const data = JSON.parse(first.stdout);
      assert.equal(data.total, undefined); // add reports the entry, not a list
      const list = await run(["watch", "list"]);
      assert.equal(JSON.parse(list.stdout).total, 1);
    });
  });

  describe("CLI & Main Dispatch", () => {
    it("prints help when bare watch is called", async () => {
      const r = await run(["watch"]);
      assert.equal(r.code, 0);
      assert.match(r.stdout, /scoutline watch <subcommand>/);
    });

    it("prints help when --help is passed", async () => {
      const r = await run(["watch", "--help"]);
      assert.equal(r.code, 0);
      assert.match(r.stdout, /Options for 'watch add':/);
    });

    it("rejects unknown subcommands with the byte-pinned terminal string", async () => {
      const r = await run(["watch", "teleport"]);
      assert.equal(r.code, 1);
      assert.match(r.stderr, /Unknown watch subcommand \\"teleport\\"/);
      assert.match(r.stderr, /Valid subcommands: add, list, remove, run, feed\./);
    });

    it("--isolated plus a subcommand is a parse-time VALIDATION_ERROR", async () => {
      const r = await run(["watch", "--isolated", "add", "https://example.com/iso"]);
      assert.equal(r.code, 1);
      assert.match(r.stderr, /VALIDATION_ERROR/);
      assert.match(r.stderr, /isolated/i);
      // And with the flag after the subcommand (extraction order-agnostic).
      const r2 = await run(["watch", "add", "https://example.com/iso2", "--isolated"]);
      assert.equal(r2.code, 1);
      assert.match(r2.stderr, /VALIDATION_ERROR/);
      // Neither run registered a target (suite watchRoot may hold earlier
      // suites' targets — assert the ISO URLs are absent, not global zero).
      const list = await run(["watch", "list"]);
      const urls = JSON.parse(list.stdout).targets.map((x) => x.url);
      assert.ok(!urls.some((u) => u.includes("example.com/iso")), "isolated add must not persist");
    });

    it("--isolated still renders help for bare watch and --help", async () => {
      const bare = await run(["watch", "--isolated"]);
      assert.equal(bare.code, 0);
      assert.match(bare.stdout, /scoutline watch <subcommand>/);
      const help = await run(["watch", "--isolated", "--help"]);
      assert.equal(help.code, 0);
      assert.match(help.stdout, /scoutline watch <subcommand>/);
    });

    it("MAIN_HELP lists the watch command and its help entry", async () => {
      const { adapter, stdout } = makeAdapter();
      const code = await main(["--help"], {
        invocation: adapter,
        env: {},
        loadScoutlineConfig: () => {
          throw new Error("Should not be called!");
        },
      });
      assert.equal(code, 0);
      const text = stdout.join("");
      assert.match(text, /watch\s+Keyless page monitoring/);
      assert.ok(text.includes("scoutline watch --help"));
    });

    it("WATCH_HELP documents every subcommand and the --keep bounds", () => {
      assert.match(WATCH_HELP, /add <url>/);
      assert.match(WATCH_HELP, /--name <name>/);
      assert.match(WATCH_HELP, /--keep <1\.\.100>/);
      assert.match(WATCH_HELP, /--purge/);
      assert.match(WATCH_HELP, /run/);
      assert.match(WATCH_HELP, /feed/);
    });
  });

  describe("add / list round-trip", () => {
    it("registers a target with the default host+path slug name and keep 5", async () => {
      const r = await makeRunner(watchRoot, () => Date.parse("2026-09-05T12:00:00Z"))([
        "watch",
        "add",
        "https://example.com/docs/getting-started",
      ]);
      assert.equal(r.code, 0);
      const data = JSON.parse(r.stdout);
      assert.equal(data.schemaVersion, 1);
      assert.equal(data.name, "example.com-docs-getting-started");
      assert.equal(data.type, "page");
      assert.equal(data.url, "https://example.com/docs/getting-started");
      assert.equal(data.keep, 5);
      assert.equal(data.createdAt, "2026-09-05T12:00:00.000Z");
      assert.match(data.id, /^20260905T120000Z-[0-9a-f]{4}$/);

      // Persisted to the real registry file under the isolated watch dir.
      const raw = JSON.parse(
        await fs.readFile(path.join(watchRoot, WATCH_REGISTRY_FILENAME), "utf8"),
      );
      const row = raw.targets.find((x) => x.id === data.id);
      assert.ok(row, "the added target is persisted to targets.json");
      assert.deepEqual(row, {
        id: data.id,
        name: data.name,
        type: "page",
        url: data.url,
        keep: 5,
        createdAt: data.createdAt,
      });

      const list = await run(["watch", "list"]);
      assert.equal(
        JSON.parse(list.stdout).targets.filter((x) => x.id === data.id).length,
        1,
      );
    });

    it("honors --name and --keep at both bounds", async () => {
      for (const keep of [1, 100]) {
        const r = await run([
          "watch", "add", "https://bounds.example/", "--name", `t${keep}`, "--keep", String(keep),
        ]);
        assert.equal(r.code, 0, `--keep ${keep} must be accepted`);
        assert.equal(JSON.parse(r.stdout).keep, keep);
      }
    });

    it("lists an empty registry as {schemaVersion:1, total:0, targets:[]}", async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "scoutline-watch-empty-"));
      try {
        const r = await makeRunner(root)(["watch", "list"]);
        assert.equal(r.code, 0);
        assert.deepEqual(JSON.parse(r.stdout), {
          schemaVersion: 1,
          total: 0,
          targets: [],
        });
      } finally {
        await fs.rm(root, { recursive: true, force: true }).catch(() => {});
      }
    });

    it("renders one-line text presentations in tty mode", async () => {
      const add = await run(["watch", "add", "https://tty.example/docs", "-O", "tty"]);
      assert.equal(add.code, 0);
      assert.match(add.stdout, /added watch target tty\.example-docs/);
      const list = await run(["watch", "list", "-O", "tty"]);
      assert.match(list.stdout, /target\(s\)/);
      assert.match(list.stdout, /tty\.example-docs/);
    });
  });

  describe("remove", () => {
    it("removes by name: registry entry gone, evidence dir KEPT by default", async () => {
      const add = await run(["watch", "add", "https://remove.example/", "--name", "rm-docs"]);
      const added = JSON.parse(add.stdout);
      const idDir = path.join(watchRoot, added.id);
      await appendChangeLog(watchRoot, added.id, {
        at: new Date("2026-09-05T12:00:00Z"),
        kind: "baseline",
        exit: 0,
        gen: 1,
      });

      const r = await run(["watch", "remove", "rm-docs"]);
      assert.equal(r.code, 0);
      const data = JSON.parse(r.stdout);
      assert.equal(data.id, added.id);
      assert.equal(data.name, "rm-docs");
      assert.equal(data.purged, false);
      // Registry no longer lists it; the evidence dir survives.
      const registry = JSON.parse(
        await fs.readFile(path.join(watchRoot, WATCH_REGISTRY_FILENAME), "utf8"),
      );
      assert.equal(registry.targets.filter((x) => x.id === added.id).length, 0);
      await fs.access(idDir);
    });

    it("removes by id, and --purge deletes the evidence dir too", async () => {
      const add = await run(["watch", "add", "https://purge.example/", "--name", "purge-docs"]);
      const added = JSON.parse(add.stdout);
      const idDir = path.join(watchRoot, added.id);
      await appendChangeLog(watchRoot, added.id, {
        at: new Date("2026-09-05T12:00:00Z"),
        kind: "baseline",
        exit: 0,
        gen: 1,
      });

      const r = await run(["watch", "remove", added.id, "--purge"]);
      assert.equal(r.code, 0);
      assert.equal(JSON.parse(r.stdout).purged, true);
      await assert.rejects(() => fs.access(idDir));
    });

    it("unknown target is a VALIDATION_ERROR naming the ref", async () => {
      const r = await run(["watch", "remove", "no-such-target"]);
      assert.equal(r.code, 1);
      assert.match(r.stderr, /VALIDATION_ERROR/);
      assert.match(r.stderr, /Unknown watch target \\"no-such-target\\"/);
    });
  });

  describe("watch run (T5 — cron tick with 0/1/2 exit contract)", () => {
    // Mutable loopback fixtures (T3 precedent): each test tunes routes
    // on a dedicated server, then drives `main()` ticks through the
    // real dispatcher against an isolated SCOUTLINE_WATCH_DIR subdir.
    const HTML_V1 = `<html><head><title>Doc</title></head><body>
<h1>Install</h1><p>Run the installer.</p>
</body></html>`;
    const HTML_V2 = `<html><head><title>Doc</title></head><body>
<h1>Install</h1><p>Run the installer.</p>
<h2>Security</h2><p>Enable the firewall.</p>
</body></html>`;

    const makeTickServer = async () => {
      const routes = { "/page": { body: HTML_V1, status: 200, type: "text/html; charset=utf-8" } };
      const server = http.createServer((req, res) => {
        const r = routes[new URL(req.url, `http://${req.headers.host}`).pathname] ?? { status: 404, body: "Not found", type: "text/plain" };
        if (r.location) {
          res.writeHead(r.status, { Location: r.location });
          res.end();
          return;
        }
        res.writeHead(r.status, { "Content-Type": r.type });
        res.end(Buffer.isBuffer(r.body) ? r.body : Buffer.from(r.body, "utf8"));
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      return { server, routes, base: `http://127.0.0.1:${server.address().port}` };
    };

    const makeRunnerAt = (dir, clock) => {
      let tick = 0;
      return async (argv) => {
        const { adapter, stdout, stderr } = makeAdapter();
        const now = clock ? () => clock + tick++ * 60000 : undefined;
        const code = await main(argv, {
          invocation: adapter,
          env: { SCOUTLINE_WATCH_DIR: dir },
          loadScoutlineConfig: () => {
            throw new Error("Should not be called!");
          },
          ...(now ? { now } : {}),
        });
        return { code, stdout: stdout.join(""), stderr: stderr.join("") };
      };
    };

    const ringState = async (root, id) => {
      const snaps = await listSnapshots(root, id);
      return { maxGen: snaps.reduce((m, s) => Math.max(m, s.gen), 0), count: snaps.length };
    };

    const addAt = async (runner, url, name) => {
      const r = await runner(["watch", "add", url, "--name", name]);
      assert.equal(r.code, 0, r.stderr);
      return JSON.parse(r.stdout);
    };

    it("first run is a baseline: exit 0, gen 1, log entry, snapshot exists", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scoutline-watch-run-"));
      const { server, base } = await makeTickServer();
      try {
        const runner = makeRunnerAt(dir, Date.parse("2026-09-06T08:00:00Z"));
        const target = await addAt(runner, `${base}/page`, "baseline-docs");
        const r = await runner(["watch", "run", "baseline-docs"]);
        assert.equal(r.code, 0);
        const data = JSON.parse(r.stdout);
        assert.equal(data.schemaVersion, 1);
        assert.equal(data.target, "baseline-docs");
        assert.equal(data.result, "baseline");
        assert.equal(data.baseline, true);
        assert.equal(data.gen, 1);
        assert.deepEqual(data.diff, { added: [], removed: [], changed: [] });
        assert.equal(data.hashOnly, false);
        assert.equal(data.finalUrl, `${base}/page`);
        assert.equal(data.prevAt, null);
        assert.equal(data.nowAt, "2026-09-06T08:01:00.000Z");
        const snaps = await listSnapshots(dir, target.id);
        assert.equal(snaps.length, 1);
        assert.equal(snaps[0].gen, 1);
        const log = await readChangeLog(dir, target.id);
        assert.equal(log.length, 1);
        assert.equal(log[0].kind, "baseline");
        assert.equal(log[0].exit, 0);
        assert.equal(log[0].gen, 1);
      } finally {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
        await new Promise((resolve) => server.close(resolve));
      }
    });

    it("identical second tick is no-change: exit 0, gen advances to 2", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scoutline-watch-run-"));
      const { server, base } = await makeTickServer();
      try {
        const runner = makeRunnerAt(dir, Date.parse("2026-09-06T08:00:00Z"));
        await addAt(runner, `${base}/page`, "nochange-docs");
        await runner(["watch", "run", "nochange-docs"]);
        const r = await runner(["watch", "run", "nochange-docs"]);
        assert.equal(r.code, 0);
        const data = JSON.parse(r.stdout);
        assert.equal(data.result, "no-change");
        assert.equal(data.baseline, false);
        assert.equal(data.gen, 2);
        assert.deepEqual(data.diff, { added: [], removed: [], changed: [] });
        assert.equal(data.hashOnly, false);
        const listed = JSON.parse((await runner(["watch", "list"])).stdout);
        const log = await readChangeLog(dir, listed.targets.find((t) => t.name === "nochange-docs").id);
        assert.equal(log.at(-1).kind, "no-change");
        assert.equal(log.at(-1).exit, 0);
        assert.equal(log.at(-1).gen, 2);
      } finally {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
        await new Promise((resolve) => server.close(resolve));
      }
    });

    it("mutated third tick is change: exit 1, diff arrays, gen 3", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scoutline-watch-run-"));
      const { server, routes, base } = await makeTickServer();
      try {
        const runner = makeRunnerAt(dir, Date.parse("2026-09-06T08:00:00Z"));
        const target = await addAt(runner, `${base}/page`, "change-docs");
        await runner(["watch", "run", "change-docs"]);
        await runner(["watch", "run", "change-docs"]);
        routes["/page"] = { body: HTML_V2, status: 200, type: "text/html; charset=utf-8" };
        const r = await runner(["watch", "run", "change-docs"]);
        assert.equal(r.code, 1);
        const data = JSON.parse(r.stdout);
        assert.equal(data.result, "change");
        assert.equal(data.baseline, false);
        assert.equal(data.gen, 3);
        assert.deepEqual(data.diff.added, ["Security"]);
        assert.deepEqual(data.diff.removed, []);
        assert.deepEqual(data.diff.changed, []);
        assert.equal(data.hashOnly, false);
        assert.equal(data.finalUrl, `${base}/page`);
        const log = await readChangeLog(dir, target.id);
        assert.equal(log.at(-1).kind, "change");
        assert.equal(log.at(-1).exit, 1);
        assert.equal(log.at(-1).gen, 3);
        assert.deepEqual(log.at(-1).added, ["Security"]);
        assert.deepEqual(log.at(-1).changed, []);
        assert.equal(log.at(-1).hashOnly, false);
        assert.equal(log.at(-1).finalUrl, `${base}/page`);
      } finally {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
        await new Promise((resolve) => server.close(resolve));
      }
    });

    it("fetch failure: exit 2, ring UNCHANGED, error log entry has gen:null", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scoutline-watch-run-"));
      const { server, routes, base } = await makeTickServer();
      try {
        const runner = makeRunnerAt(dir, Date.parse("2026-09-06T08:00:00Z"));
        const target = await addAt(runner, `${base}/page`, "err-docs");
        await runner(["watch", "run", "err-docs"]);
        const before = await ringState(dir, target.id);
        routes["/page"] = { status: 500, body: "boom", type: "text/plain" };
        const r = await runner(["watch", "run", "err-docs"]);
        assert.equal(r.code, 2);
        const data = JSON.parse(r.stdout);
        assert.equal(data.result, "error");
        assert.equal(data.gen, null);
        const after = await ringState(dir, target.id);
        assert.deepEqual(after, before, "ring must not advance on a failed capture");
        const log = await readChangeLog(dir, target.id);
        assert.equal(log.at(-1).kind, "error");
        assert.equal(log.at(-1).exit, 2);
        assert.equal(log.at(-1).gen, null);
      } finally {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
        await new Promise((resolve) => server.close(resolve));
      }
    });

    it("hash-only: non-HTML both sides, one mutated byte: exit 1, changed [(hash)]", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scoutline-watch-run-"));
      const { server, routes, base } = await makeTickServer();
      try {
        const runner = makeRunnerAt(dir, Date.parse("2026-09-06T08:00:00Z"));
        const target = await addAt(runner, `${base}/page`, "binary-docs");
        routes["/page"] = { body: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]), status: 200, type: "application/octet-stream" };
        await runner(["watch", "run", "binary-docs"]);
        routes["/page"] = { body: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01]), status: 200, type: "application/octet-stream" };
        const r = await runner(["watch", "run", "binary-docs"]);
        assert.equal(r.code, 1);
        const data = JSON.parse(r.stdout);
        assert.equal(data.result, "change");
        assert.equal(data.hashOnly, true);
        assert.deepEqual(data.diff.changed, ["(hash)"]);
        assert.deepEqual(data.diff.added, []);
        assert.deepEqual(data.diff.removed, []);
      } finally {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
        await new Promise((resolve) => server.close(resolve));
      }
    });

    it("permanent move (301, identical content): exit 1, result moved, finalUrl updated, gen advances", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scoutline-watch-run-"));
      const { server, routes, base } = await makeTickServer();
      try {
        const runner = makeRunnerAt(dir, Date.parse("2026-09-06T08:00:00Z"));
        const target = await addAt(runner, `${base}/a`, "moved-docs");
        routes["/a"] = { status: 301, location: `${base}/b` };
        routes["/b"] = { body: HTML_V1, status: 200, type: "text/html; charset=utf-8" };
        const r1 = await runner(["watch", "run", "moved-docs"]);
        assert.equal(r1.code, 0);
        assert.equal(JSON.parse(r1.stdout).result, "baseline");
        assert.equal(JSON.parse(r1.stdout).finalUrl, `${base}/b`);
        // Second tick: content byte-identical at /b — but the identity is
        // /a (moved to /b): durable move wins, exit 1, kind "moved".
        const r2 = await runner(["watch", "run", "moved-docs"]);
        assert.equal(r2.code, 1);
        const data = JSON.parse(r2.stdout);
        assert.equal(data.result, "moved");
        assert.equal(data.moved, true);
        assert.equal(data.finalUrl, `${base}/b`);
        assert.equal(data.gen, 2);
        assert.deepEqual(data.diff, { added: [], removed: [], changed: [] });
        const log = await readChangeLog(dir, target.id);
        assert.equal(log.at(-1).kind, "moved");
        assert.equal(log.at(-1).exit, 1);
        assert.equal(log.at(-1).gen, 2);
        assert.equal(log.at(-1).finalUrl, `${base}/b`);
      } finally {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
        await new Promise((resolve) => server.close(resolve));
      }
    });

    it("temporary redirect (302) is NOT moved: normal no-change semantics", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scoutline-watch-run-"));
      const { server, routes, base } = await makeTickServer();
      try {
        const runner = makeRunnerAt(dir, Date.parse("2026-09-06T08:00:00Z"));
        await addAt(runner, `${base}/a`, "temp-docs");
        routes["/a"] = { status: 302, location: `${base}/b` };
        routes["/b"] = { body: HTML_V1, status: 200, type: "text/html; charset=utf-8" };
        await runner(["watch", "run", "temp-docs"]);
        const r2 = await runner(["watch", "run", "temp-docs"]);
        assert.equal(r2.code, 0);
        const data = JSON.parse(r2.stdout);
        assert.equal(data.result, "no-change");
        assert.equal(data.moved ?? false, false);
        assert.equal(data.finalUrl, `${base}/b`);
      } finally {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
        await new Promise((resolve) => server.close(resolve));
      }
    });

    it("--all: worst exit wins, every target in results in id order", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scoutline-watch-run-"));
      const { server, routes, base } = await makeTickServer();
      try {
        const runner = makeRunnerAt(dir, Date.parse("2026-09-06T08:00:00Z"));
        // Seed baselines so the --all tick produces one of each outcome.
        routes["/change"] = { body: HTML_V1, status: 200, type: "text/html; charset=utf-8" };
        routes["/stable"] = { body: HTML_V1, status: 200, type: "text/html; charset=utf-8" };
        routes["/broken"] = { body: HTML_V1, status: 200, type: "text/html; charset=utf-8" };
        const tA = await addAt(runner, `${base}/change`, "a-change");
        const tB = await addAt(runner, `${base}/stable`, "b-stable");
        const tC = await addAt(runner, `${base}/broken`, "c-broken");
        await runner(["watch", "run", "--all"]);
        // First tick of each target is a baseline — second tick compares.
        routes["/change"] = { body: HTML_V2, status: 200, type: "text/html; charset=utf-8" };
        routes["/broken"] = { status: 500, body: "boom", type: "text/plain" };
        const r = await runner(["watch", "run", "--all"]);
        assert.equal(r.code, 2, "worst of (2,0,1) is 2");
        const data = JSON.parse(r.stdout);
        assert.equal(data.schemaVersion, 1);
        assert.ok(Array.isArray(data.results));
        const byName = new Map(data.results.map((x) => [x.target, x]));
        assert.equal(data.results.length, 3);
        assert.equal(byName.get("a-change").result, "change");
        assert.equal(byName.get("b-stable").result, "no-change");
        assert.equal(byName.get("c-broken").result, "error");
        // Id order (== chronological): a-change < b-stable < c-broken.
        const ids = [tA.id, tB.id, tC.id].sort();
        assert.deepEqual(data.results.map((x) => x.name ?? x.target), ["a-change", "b-stable", "c-broken"]);
        assert.ok(tA.id < tB.id && tB.id < tC.id, "ids minted in registration order");
        void ids;
        // And when the worst is 1: two targets (change + no-change) → 1.
        const dir2 = await fs.mkdtemp(path.join(os.tmpdir(), "scoutline-watch-run-"));
        const { server: s2, routes: r2, base: b2 } = await makeTickServer();
        try {
          const runner2 = makeRunnerAt(dir2, Date.parse("2026-09-06T08:00:00Z"));
          r2["/x"] = { body: HTML_V1, status: 200, type: "text/html; charset=utf-8" };
          r2["/y"] = { body: HTML_V1, status: 200, type: "text/html; charset=utf-8" };
          await addAt(runner2, `${b2}/x`, "x-docs");
          await addAt(runner2, `${b2}/y`, "y-docs");
          await runner2(["watch", "run", "--all"]);
          r2["/x"] = { body: HTML_V2, status: 200, type: "text/html; charset=utf-8" };
          const rr = await runner2(["watch", "run", "--all"]);
          assert.equal(rr.code, 1, "worst of (1,0) is 1");
          const d2 = JSON.parse(rr.stdout);
          assert.equal(d2.results.length, 2);
        } finally {
          await fs.rm(dir2, { recursive: true, force: true }).catch(() => {});
          await new Promise((resolve) => s2.close(resolve));
        }
      } finally {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
        await new Promise((resolve) => server.close(resolve));
      }
    });

    it("--all on an empty registry: exit 0, results []", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scoutline-watch-run-"));
      try {
        const runner = makeRunnerAt(dir, Date.parse("2026-09-06T08:00:00Z"));
        const r = await runner(["watch", "run", "--all"]);
        assert.equal(r.code, 0);
        const data = JSON.parse(r.stdout);
        assert.equal(data.schemaVersion, 1);
        assert.deepEqual(data.results, []);
      } finally {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    });

    it("validates --timeout (positive integer) and rejects unknown targets", async () => {
      const { server, base } = await makeTickServer();
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scoutline-watch-run-"));
      try {
        const runner = makeRunnerAt(dir);
        for (const bad of ["0", "-1", "abc", "5.5"]) {
          const r = await runner(["watch", "run", "some-target", "--timeout", bad]);
          assert.equal(r.code, 1, `--timeout ${bad} must be rejected`);
          assert.match(r.stderr, /VALIDATION_ERROR/);
          assert.match(r.stderr, /--timeout/);
        }
        const unknown = await runner(["watch", "run", "no-such-target"]);
        assert.equal(unknown.code, 1);
        assert.match(unknown.stderr, /Unknown watch target/);
      } finally {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
        await new Promise((resolve) => server.close(resolve));
      }
    });

    it("rejects --all combined with an explicit target", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scoutline-watch-run-"));
      const { server, base } = await makeTickServer();
      try {
        const runner = makeRunnerAt(dir);
        // Flag AFTER the ref: the parser eats `--all docs` as the flag's
        // value, so the order-swapped form is the honest probe.
        const r = await runner(["watch", "run", "docs", "--all"]);
        assert.equal(r.code, 1);
        assert.match(r.stderr, /VALIDATION_ERROR/);
        assert.match(r.stderr, /--all/);
        void base;
      } finally {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
        await new Promise((resolve) => server.close(resolve));
      }
    });
  });
});
