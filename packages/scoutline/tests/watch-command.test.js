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
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { main } from "../dist/index.js";
import { WATCH_HELP, parseWatchArgs } from "../dist/commands/watch.js";
import {
  appendChangeLog,
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
});
