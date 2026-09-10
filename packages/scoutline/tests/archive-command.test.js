import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";

import {
  executeArchiveCdx,
  executeArchiveGet,
  executeArchiveDiff,
  parseArchiveArgs,
  fetchWithArchiveBackoff,
  ARCHIVE_HELP,
  resolveSinceInstant,
  charsetFromContentType,
  handleArchive,
} from "../dist/commands/archive.js";
import { main } from "../dist/index.js";
import { NetworkError, ValidationError } from "../dist/lib/errors.js";
import { useTempConfigDir } from "./helpers/config-dir-pin.js";

useTempConfigDir();

function makeAdapter() {
  const stdout = [];
  const stderr = [];
  let exitCode = 0;
  const adapter = {
    stdoutIsTTY: false,
    stdinIsTTY: false,
    environmentOutputMode: "data",
    readStdin: async () => "",
    writeStdout: (v) => stdout.push(v),
    writeStderr: (v) => stderr.push(v),
    runQuietly: async (op) => op(),
    setExitCode: (code) => {
      exitCode = code;
    },
  };
  return { adapter, stdout, stderr, getExitCode: () => exitCode };
}

describe("scoutline archive command", () => {
  describe("Option Parsing & Validation", () => {
    it("parses archive cdx arguments", () => {
      const parsed = parseArchiveArgs([
        "cdx",
        "https://example.com/*",
        "--from",
        "20220101",
        "--to",
        "20230101",
        "--status",
        "200",
        "--limit",
        "100",
      ]);

      assert.equal(parsed.subcommand, "cdx");
      assert.equal(parsed.positional[0], "https://example.com/*");
      assert.equal(parsed.flags.from, "20220101");
      assert.equal(parsed.flags.to, "20230101");
      assert.equal(parsed.flags.status, "200");
      assert.equal(parsed.flags.limit, "100");
    });

    it("parses archive get arguments", () => {
      const parsed = parseArchiveArgs([
        "get",
        "https://example.com/article",
        "--at",
        "20220501120000",
        "--raw",
      ]);

      assert.equal(parsed.subcommand, "get");
      assert.equal(parsed.positional[0], "https://example.com/article");
      assert.equal(parsed.flags.at, "20220501120000");
      assert.equal(parsed.flags.raw, true);
    });

    it("rejects missing url in cdx and get", async () => {
      const { adapter } = makeAdapter();
      await assert.rejects(
        () => executeArchiveCdx(""),
        { name: "ValidationError" },
      );
      await assert.rejects(
        () => executeArchiveGet(""),
        { name: "ValidationError" },
      );
    });

    it("rejects limit <= 0 or > 10000 in cdx", async () => {
      await assert.rejects(
        () => executeArchiveCdx("https://example.com/*", { limit: 10001 }),
        { name: "ValidationError" },
      );
      await assert.rejects(
        () => executeArchiveCdx("https://example.com/*", { limit: 0 }),
        { name: "ValidationError" },
      );
    });

    it("rejects invalid --at timestamp format in get", async () => {
      await assert.rejects(
        () => executeArchiveGet("https://example.com/", { at: "not-a-timestamp" }),
        { name: "ValidationError" },
      );
    });
  });

  describe("CDX Index Enumeration logic", () => {
    let mockServer;
    let mockPort;
    let mockBase;

    before(async () => {
      mockServer = http.createServer((req, res) => {
        const urlObj = new URL(req.url, `http://${req.headers.host}`);
        if (urlObj.pathname === "/cdx") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify([
              ["timestamp", "statuscode", "length", "digest", "original"],
              ["20230101000000", "200", "4560", "DIGESTABC123", "https://example.com/"],
              ["20230601000000", "200", "4610", "DIGESTDEF456", "https://example.com/"],
            ]),
          );
        } else if (urlObj.pathname === "/hang") {
          // Hold the socket open; never respond. Used to prove the
          // caller's --timeout governs the availability request.
        } else if (urlObj.pathname === "/available") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              archived_snapshots: {
                closest: {
                  status: "200",
                  available: true,
                  url: "http://web.archive.org/web/20230601000000/https://example.com/",
                  timestamp: "20230601000000",
                },
              },
            }),
          );
        } else if (urlObj.pathname === "/rate-limited") {
          res.writeHead(429, { "Content-Type": "text/plain" });
          res.end("Slow down");
        } else if (urlObj.pathname.includes("id_/")) {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end("<html><body>Historical Page Content</body></html>");
        } else {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("Not found");
        }
      });

      await new Promise((resolve) => {
        mockServer.listen(0, "127.0.0.1", () => {
          mockPort = mockServer.address().port;
          mockBase = `http://127.0.0.1:${mockPort}`;
          resolve();
        });
      });
    });

    after(async () => {
      if (mockServer) {
        await new Promise((resolve) => mockServer.close(resolve));
      }
    });

    it("handles rate limiting with backoff", async () => {
      let sleepCalls = 0;
      await assert.rejects(
        () =>
          fetchWithArchiveBackoff(`${mockBase}/rate-limited`, {
            timeout: 500,
            sleep: async () => {
              sleepCalls++;
            },
          }),
        (err) => err instanceof NetworkError && err.code === "NETWORK_ERROR",
      );
      assert.ok(sleepCalls >= 3);
    });

    it("enumerates historical captures from CDX endpoint", async () => {
      const result = await executeArchiveCdx(
        "https://example.com/*",
        { from: "20230101", to: "20231231", status: "200", limit: 10 },
        { cdxEndpoint: `${mockBase}/cdx` },
      );

      assert.equal(result.schemaVersion, 1);
      assert.equal(result.total, 2);
      assert.equal(result.captures[0].timestamp, "20230101000000");
      assert.equal(result.captures[0].statusCode, 200);
      assert.equal(result.captures[0].length, 4560);
      assert.equal(result.captures[0].digest, "DIGESTABC123");
    });

    it("fetches historical snapshot content via id_ verbatim mode", async () => {
      const result = await executeArchiveGet(
        "https://example.com/",
        { at: "best" },
        {
          availabilityEndpoint: `${mockBase}/available`,
          replayBaseUrl: mockBase,
        },
      );

      assert.equal(result.schemaVersion, 1);
      assert.equal(result.snapshotTimestamp, "20230601000000");
      assert.equal(result.statusCode, 200);
      assert.match(result.content, /Historical Page Content/);
    });

    it("honors the caller --timeout on the availability request, not just the replay", { timeout: 10000 }, async () => {
      // The /hang route never responds: only the CALLER timeout (150ms
      // here) aborting the request can end this quickly. The assertion
      // on the reported duration is the teeth — without propagation the
      // request would sit on the 30s default and report 30000.
      await assert.rejects(
        () =>
          executeArchiveGet(
            "https://example.com/x",
            { at: "best", timeout: 150 },
            { availabilityEndpoint: `${mockBase}/hang`, sleep: async () => {} },
          ),
        (err) => /timed out after 150ms/.test(err.message),
      );
    });
  });

  describe("CLI & Main Dispatch", () => {
    it("prints help when bare archive is called", async () => {
      const { adapter, stdout } = makeAdapter();
      const code = await main(["archive"], {
        invocation: adapter,
        env: {},
        loadScoutlineConfig: () => {
          throw new Error("Should not be called!");
        },
      });
      assert.equal(code, 0);
      assert.match(stdout.join(""), /scoutline archive <subcommand>/);
    });

    it("prints help when --help is passed", async () => {
      const { adapter, stdout } = makeAdapter();
      const code = await main(["archive", "--help"], {
        invocation: adapter,
        env: {},
        loadScoutlineConfig: () => {
          throw new Error("Should not be called!");
        },
      });
      assert.equal(code, 0);
      assert.match(stdout.join(""), /Options for 'archive cdx':/);
    });

    it("rejects unknown subcommands", async () => {
      const { adapter, stderr } = makeAdapter();
      const code = await main(["archive", "unknown-sub"], {
        invocation: adapter,
        env: {},
        loadScoutlineConfig: () => {
          throw new Error("Should not be called!");
        },
      });
      assert.equal(code, 1);
      assert.match(stderr.join(""), /Unknown archive subcommand.*unknown-sub/);
    });
  });

  describe("archive diff (T3 — snapshot-vs-live section diff)", () => {
    // The positional URL doubles as the live-side target: the live
    // loopback routes hang off the same server as the CDX/replay
    // fixtures, so the production "one URL, two sides" flow runs
    // end-to-end with real HTTP both ways.
    // CDX fixture: three captures straddling every plausible T. The
    // at-or-before rule picks 20230601 for T=2023-12-31 — NEVER the
    // nearest-after 20240101 and never a silent fallback.
    const CDX_ROWS = [
      ["timestamp", "statuscode", "length", "digest", "original"],
      ["20230101000000", "200", "100", "D1", "https://example.com/docs"],
      ["20230601000000", "200", "100", "D2", "https://example.com/docs"],
      ["20240101000000", "200", "100", "D3", "https://example.com/docs"],
    ];
    const OLD_HTML = `<HTML><HEAD><TITLE>Old</TITLE></HEAD><BODY>
<H1>Install</H1><P>Run the installer to set things up.
<H2>Security</H2><P>Enable the firewall before use.
</BODY></HTML>`;
    const LIVE_HTML = `<html><head><title>New</title></head><body>
<h1>Install</h1><p>Run the installer to set things up.</p>
<h2>Security</h2><p>Enable the firewall and audit logs before use.</p>
<h2>Pricing</h2><p>Plans start at zero.</p>
</body></html>`;
    let server;
    let base;
    let replayHits;

    before(async () => {
      server = http.createServer((req, res) => {
        const u = new URL(req.url, `http://${req.headers.host}`);
        const path = u.pathname;
        if (path === "/cdx") {
          // At-or-before selection: the engine must pass to=<T> so the
          // fixture answers with only the captures CDX would return.
          // limit<0 emulates the Wayback CDX documented contract:
          // the LAST |limit| captures (newest), not the first.
          const to = u.searchParams.get("to");
          const limit = Number(u.searchParams.get("limit") ?? "50");
          const eligible = CDX_ROWS.slice(1).filter((r) => !to || r[0] <= to);
          const window = limit < 0 ? eligible.slice(limit) : eligible.slice(0, limit);
          const rows = [CDX_ROWS[0]].concat(window);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(rows));
        } else if (path.startsWith("/replay/20230601000000id_")) {
          replayHits = true;
          // Old-era markup: uppercase tags, missing closers (T1 fixture class).
          res.writeHead(200, { "Content-Type": "text/html; charset=iso-8859-1" });
          res.end(Buffer.from(OLD_HTML, "latin1"));
        } else if (path.startsWith("/replay/20230101000000id_")) {
          replayHits = true;
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(OLD_HTML);
        } else if (path === "/live") {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(LIVE_HTML);
        } else if (path === "/live-binary") {
          res.writeHead(200, { "Content-Type": "application/octet-stream" });
          res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
        } else if (path === "/live-slash") {
          // 301 to a trailing-slash variant of the same document: a raw
          // string compare calls this a move; normalized comparison must
          // not (cross-surface parity with watch run).
          res.writeHead(301, { Location: "/live-slash/" });
          res.end();
        } else if (path === "/live-slash/") {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(LIVE_HTML);
        } else if (path === "/live-moved") {
          res.writeHead(301, { Location: "/live" });
          res.end();
        } else if (path === "/live-temp-moved") {
          res.writeHead(302, { Location: "/live" });
          res.end();
        } else if (path === "/live-500") {
          // A >= 400 live response is a FAILED CAPTURE, never content —
          // cross-surface rule already enforced by watch run.
          res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
          res.end("<html><body><h1>Server Error</h1></body></html>");
        } else if (path === "/replay-fail/*") {
          // Unreachable in dispatch; replay failure is injected via a
          // dedicated server below (replay route returning >= 400).
          res.writeHead(404);
          res.end();
        } else {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("Not found");
        }
      });
      await new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
          base = `http://127.0.0.1:${server.address().port}`;
          resolve();
        });
      });
    });

    after(async () => {
      if (server) await new Promise((resolve) => server.close(resolve));
    });

    const deps = () => ({
      cdxEndpoint: `${base}/cdx`,
      replayBaseUrl: `${base}/replay`,
    });

    it("resolves the at-or-before capture and reports the section diff", async () => {
      replayHits = false;
      const r = await executeArchiveDiff(`${base}/live`, { since: "2023-12-31" }, deps());
      assert.equal(r.schemaVersion, 1);
      assert.equal(r.snapshotTimestamp, "20230601000000");
      assert.equal(r.asOf, "2023-12-31");
      assert.equal(r.url, `${base}/live`);
      assert.deepEqual(r.added, ["Pricing"]);
      assert.deepEqual(r.removed, []);
      assert.deepEqual(r.changed, ["Security"]);
      assert.equal(r.hashOnly, false);
      assert.equal(r.moved, false);
      assert.equal(r.finalUrl, `${base}/live`);
      assert.ok(replayHits, "the selected snapshot was actually replayed");
    });

    it("parses --since as ISO datetime", async () => {
      const r = await executeArchiveDiff(`${base}/live`, { since: "2023-07-01T12:00:00Z" }, deps());
      assert.equal(r.snapshotTimestamp, "20230601000000");
      // Datetimes normalize to the computed ISO instant (plain dates echo verbatim).
      assert.equal(r.asOf, "2023-07-01T12:00:00.000Z");
    });

    it("parses --since as duration against the injected now", async () => {
      const r = await executeArchiveDiff(`${base}/live`, { since: "30d" }, {
        ...deps(),
        now: () => Date.parse("2023-07-15T00:00:00Z"),
      });
      assert.equal(r.snapshotTimestamp, "20230601000000");
      assert.equal(r.asOf, "2023-06-15T00:00:00.000Z");
    });

    it("supports h/w/y duration units and honors never-after", async () => {
      const now = () => Date.parse("2023-06-02T00:00:00Z");
      // 1w before Jun 2 = May 26: the Jun 1 capture is AFTER T, so the
      // only ≤ T capture is Jan 1 — selection, not proximity, wins.
      const r = await executeArchiveDiff(`${base}/live`, { since: "1w" }, { ...deps(), now });
      assert.equal(r.snapshotTimestamp, "20230101000000");
      // 12h before Jun 2 is still Jun 1: 20230601 qualifies.
      const r2 = await executeArchiveDiff(`${base}/live`, { since: "12h" }, { ...deps(), now });
      assert.equal(r2.snapshotTimestamp, "20230601000000");
    });

    it("zero-pads short CDX timestamps so truncated captures participate in selection", async () => {
      // CDX accepts truncated timestamps ("2023", "202301", ...); forms
      // of 6-12 digits parse as NaN and the capture is silently
      // excluded from selection. "202301" must win as 20230101000000
      // (CDX's own from/to padding semantics) — not be skipped in favor
      // of the later plain 20230101000000 row.
      const rows = [
        CDX_ROWS[0], // header: ["timestamp", "statuscode", ...]
        ["202301", "200", "100", "DSHORT", "https://example.com/docs"],
        ["20230101000000", "200", "100", "D1", "https://example.com/docs"],
        CDX_ROWS[1],
        CDX_ROWS[2],
      ];
      const shortServer = http.createServer((req, res) => {
        const u = new URL(req.url, `http://${req.headers.host}`);
        // ponytail: short keepAliveTimeout — undici holds the pooled
        // connection when a response body goes unconsumed; without this
        // server.close() waits out the default ~3s (artifact, not the
        // behavior under test).
        shortServer.keepAliveTimeout = 50;
        if (u.pathname === "/cdx") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(rows));
        } else if (
          u.pathname.startsWith("/replay/20230101000000id_") ||
          u.pathname.startsWith("/replay/202301id_")
        ) {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(OLD_HTML);
        } else if (u.pathname === "/live") {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(LIVE_HTML);
        } else {
          res.writeHead(404); res.end();
        }
      });
      await new Promise((resolve) => shortServer.listen(0, "127.0.0.1", resolve));
      try {
        const shortBase = `http://127.0.0.1:${shortServer.address().port}`;
        // T = 2023-01-15: "202301" must count as 20230101000000 (padded)
        // and win as the first-seen newest ≤ T. Unpadded it is NaN-excluded
        // and the plain 20230101000000 row wins instead — snapshotTimestamp
        // distinguishes the two rows.
        const r = await executeArchiveDiff(`${shortBase}/live`, { since: "2023-01-15" }, {
          cdxEndpoint: `${shortBase}/cdx`,
          replayBaseUrl: `${shortBase}/replay`,
        });
        assert.equal(r.snapshotTimestamp, "202301");
      } finally {
        await new Promise((resolve) => shortServer.close(resolve));
      }
    });

    it("8-digit short timestamp 20230115 pads to midnight and wins the inclusive at-or-before boundary", async () => {
      // "20230115" must count as 20230115T00:00:00 — exactly T, so the
      // inclusive at-or-before boundary selects it over the older
      // 20230101 row. If 8-digit rows ever parse NaN again they are
      // silently excluded and the older row wins instead —
      // snapshotTimestamp distinguishes the two.
      const rows = [
        CDX_ROWS[0], // header: ["timestamp", "statuscode", ...]
        ["20230101", "200", "100", "DOLD8", "https://example.com/docs"],
        ["20230115", "200", "100", "D8DIGIT", "https://example.com/docs"],
      ];
      const short8Server = http.createServer((req, res) => {
        const u = new URL(req.url, `http://${req.headers.host}`);
        // ponytail: short keepAliveTimeout — undici holds the pooled
        // connection when a response body goes unconsumed; without this
        // server.close() waits the default ~3s (artifact, not the
        // behavior under test).
        short8Server.keepAliveTimeout = 50;
        if (u.pathname === "/cdx") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(rows));
        } else if (
          u.pathname.startsWith("/replay/20230115id_") ||
          u.pathname.startsWith("/replay/20230101id_")
        ) {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(OLD_HTML);
        } else if (u.pathname === "/live") {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(LIVE_HTML);
        } else {
          res.writeHead(404); res.end();
        }
      });
      await new Promise((resolve) => short8Server.listen(0, "127.0.0.1", resolve));
      try {
        const short8Base = `http://127.0.0.1:${short8Server.address().port}`;
        // T = 2023-01-15T00:00:00Z: padded "20230115" lands exactly on T.
        const r = await executeArchiveDiff(`${short8Base}/live`, { since: "2023-01-15" }, {
          cdxEndpoint: `${short8Base}/cdx`,
          replayBaseUrl: `${short8Base}/replay`,
        });
        assert.equal(r.snapshotTimestamp, "20230115");
      } finally {
        await new Promise((resolve) => short8Server.close(resolve));
      }
    });

    it("selects the NEWEST capture <= T even when >50 captures precede T (negative limit)", async () => {
      // CDX returns captures ascending. With the naive first-50 window the
      // selection only ever sees the OLDEST 50 captures and silently picks
      // a decades-old snapshot. The Wayback CDX documented contract:
      // negative limit = LAST |limit| results (newest). Fixture mirrors
      // that contract; 60 status-200 captures <= T, newest far beyond
      // the first 50 — only a negative-limit query can see it.
      const MANY_ROWS = [CDX_ROWS[0]].concat(
        Array.from({ length: 60 }, (_, i) => {
          const day = String((i % 28) + 1).padStart(2, "0");
          const month = String(Math.floor(i / 28) + 1).padStart(2, "0");
          return ["2023" + month + day + "120000", "200", "100", `D${i}`, "https://example.com/docs"];
        }),
      );
      let cdxQuery;
      const manyServer = http.createServer((req, res) => {
        const u = new URL(req.url, `http://${req.headers.host}`);
        if (u.pathname === "/cdx") {
          cdxQuery = u;
          const to = u.searchParams.get("to");
          const limit = Number(u.searchParams.get("limit") ?? "50");
          const eligible = MANY_ROWS.slice(1).filter((r) => !to || r[0] <= to);
          const window = limit < 0 ? eligible.slice(limit) : eligible.slice(0, limit);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify([CDX_ROWS[0]].concat(window)));
        } else if (u.pathname.startsWith("/replay/20230304120000id_")) {
          // Capture #59 (Mar 4) — the newest <= 2023-03-05T00:00:00Z.
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(OLD_HTML);
        } else if (u.pathname === "/live") {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(LIVE_HTML);
        } else {
          res.writeHead(404);
          res.end();
        }
      });
      // ponytail: short keepAliveTimeout — unconsumed pooled response
      // bodies otherwise stall server.close() ~3s (see fixture note above).
      manyServer.keepAliveTimeout = 50;
      await new Promise((resolve) => manyServer.listen(0, "127.0.0.1", resolve));
      try {
        const manyBase = `http://127.0.0.1:${manyServer.address().port}`;
        const r = await executeArchiveDiff(`${manyBase}/live`, { since: "2023-03-05" }, {
          cdxEndpoint: `${manyBase}/cdx`,
          replayBaseUrl: `${manyBase}/replay`,
        });
        assert.equal(r.snapshotTimestamp, "20230304120000");
        // Teeth: only a NEGATIVE limit asks CDX for the newest window;
        // a positive limit (+100) yields the oldest 60 and selects
        // capture #1 (2023) instead. Fixture honors the sign (slice
        // direction) so the assertion pins the emitted param, not the
        // happy path — see mutation verification in the ticket report.
        assert.ok(cdxQuery, "CDX query was made");
        assert.equal(cdxQuery.searchParams.get("limit"), "-100");
        assert.equal(cdxQuery.searchParams.get("to"), "20230305000000");
        assert.equal(cdxQuery.searchParams.get("filter"), "statuscode:200");
      } finally {
        await new Promise((resolve) => manyServer.close(resolve));
      }
    });

    it("selects the capture EXACTLY at --since T, not the earlier one", async () => {
      // T = 2023-06-01 00:00:00Z equals the 20230601000000 capture
      // exactly: at-or-before means a capture at T wins (inclusive
      // boundary), never the fallback to the earlier 20230101 one.
      const r = await executeArchiveDiff(`${base}/live`, { since: "2023-06-01" }, deps());
      assert.equal(r.snapshotTimestamp, "20230601000000");
    });

    it("strips quotes around the charset so quoted non-UTF-8 content decodes correctly", async () => {
      // `charset="gbk"` (quoted — legal per RFC 9110) must not reach
      // TextDecoder as `"gbk"`: that label is unsupported, silently
      // falling back to UTF-8 and mis-decoding GBK bytes. GBK heading
      // 中文 (d6 d0 ce c4) extracts literally only when the hint works.
      // Snapshot side: GBK bytes for heading 中文 behind a QUOTED
      // `charset="gbk"`. Live side: the SAME document already decoded
      // and served as plain UTF-8. When the quoted hint is honored the
      // two sides extract identically (empty diff); when the quotes
      // poison the label the snapshot decodes as UTF-8 mojibake and the
      // heading reports as removed+added.
      const gbkDoc = Buffer.concat([
        Buffer.from("<h1>", "latin1"),
        Buffer.from([0xd6, 0xd0, 0xce, 0xc4]),
        Buffer.from("</h1><p>text</p>", "latin1"),
      ]);
      const utf8LiveDoc = Buffer.from("<h1>中文</h1><p>text</p>", "utf-8");
      // A dedicated server on its own port: leaves the suite-shared
      // fixture server (and its routes) untouched for the other tests.
      const gbkServer = http.createServer((req, res) => {
        const u = new URL(req.url, `http://${req.headers.host}`);
        const path = u.pathname;
        if (path === "/cdx") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify([CDX_ROWS[0], CDX_ROWS[2]]));
        } else if (path.startsWith("/replay/")) {
          res.writeHead(200, { "Content-Type": 'text/html; charset="gbk"' });
          res.end(gbkDoc);
        } else if (path === "/live") {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(utf8LiveDoc);
        } else {
          res.writeHead(404); res.end();
        }
      });
      await new Promise((resolve) => gbkServer.listen(0, "127.0.0.1", resolve));
      try {
        const gbkBase = `http://127.0.0.1:${gbkServer.address().port}`;
        const r = await executeArchiveDiff(`${gbkBase}/live`, { since: "2023-12-31" }, {
          cdxEndpoint: `${gbkBase}/cdx`,
          replayBaseUrl: `${gbkBase}/replay`,
        });
        assert.equal(r.hashOnly, false);
        assert.deepEqual(r.added, []);
        assert.deepEqual(r.removed, []);
        assert.deepEqual(r.changed, []);
      } finally {
        await new Promise((resolve) => gbkServer.close(resolve));
      }
    });

    it("rejects invalid --since forms", async () => {
      for (const bad of ["30", "garbage", "-30d", "30x", "2023-13-45"]) {
        await assert.rejects(
          () => executeArchiveDiff(`${base}/live`, { since: bad }, deps()),
          (err) => err instanceof ValidationError && /Invalid --since/.test(err.message),
          `expected ValidationError for --since ${bad}`,
        );
      }
    });

    it("fails with a ValidationError mentioning archive cdx when no capture is at-or-before T", async () => {
      await assert.rejects(
        () => executeArchiveDiff(`${base}/live`, { since: "2022-01-01" }, deps()),
        (err) =>
          err instanceof ValidationError &&
          /archive cdx/.test(`${err.message} ${err.help ?? ""}`),
      );
    });

    it("reports moved=true only for permanent redirects", async () => {
      const perm = await executeArchiveDiff(`${base}/live-moved`, { since: "2023-12-31" }, deps());
      assert.equal(perm.moved, true);
      assert.equal(perm.finalUrl, `${base}/live`);

      const temp = await executeArchiveDiff(`${base}/live-temp-moved`, { since: "2023-12-31" }, deps());
      assert.equal(temp.moved, false);
      assert.equal(temp.finalUrl, `${base}/live`);
    });

    it("moved=false when a permanent redirect lands on a trailing-slash variant of the same document", async () => {
      const r = await executeArchiveDiff(`${base}/live-slash`, { since: "2023-12-31" }, deps());
      assert.equal(r.moved, false);
      assert.equal(r.finalUrl, `${base}/live-slash/`);
    });

    it("live HTTP >= 400 is a failed capture, not content (NetworkError)", async () => {
      await assert.rejects(
        executeArchiveDiff(`${base}/live-500`, { since: "2023-12-31" }, deps()),
        (err) =>
          err instanceof NetworkError &&
          /Live fetch failed with HTTP 500/.test(err.message),
      );
    });

    it("snapshot replay HTTP >= 400 is a failed capture, not content (NetworkError)", async () => {
      // Dedicated server: CDX healthy, but the id_ replay route 502s —
      // a failed replay must never be diffed as "everything changed".
      const failServer = http.createServer((req, res) => {
        const u = new URL(req.url, `http://${req.headers.host}`);
        // ponytail: short keepAliveTimeout so close() below doesn't wait
        // out the default ~3s when an unconsumed 502 body holds the pooled
        // connection (undici artifact, not behavior under test).
        failServer.keepAliveTimeout = 50;
        if (u.pathname === "/cdx") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify([CDX_ROWS[0], CDX_ROWS[1]]));
        } else if (u.pathname.startsWith("/replay/")) {
          res.writeHead(502, { "Content-Type": "text/html; charset=utf-8" });
          res.end("<html><body><h1>Bad Gateway</h1></body></html>");
        } else if (u.pathname === "/live") {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(LIVE_HTML);
        } else {
          res.writeHead(404);
          res.end();
        }
      });
      await new Promise((resolve) => failServer.listen(0, "127.0.0.1", resolve));
      try {
        const failBase = `http://127.0.0.1:${failServer.address().port}`;
        await assert.rejects(
          executeArchiveDiff(`${failBase}/live`, { since: "2023-12-31" }, {
            cdxEndpoint: `${failBase}/cdx`,
            replayBaseUrl: `${failBase}/replay`,
          }),
          (err) =>
            err instanceof NetworkError &&
            /Snapshot replay failed with HTTP 502/.test(err.message),
        );
      } finally {
        await new Promise((resolve) => failServer.close(resolve));
      }
    });

    it("degrades to hash-only when the live side is not HTML", async () => {
      const r = await executeArchiveDiff(`${base}/live-binary`, { since: "2023-12-31" }, deps());
      assert.equal(r.hashOnly, true);
      assert.deepEqual(r.changed, ["(hash)"]);
      assert.deepEqual(r.added, []);
      assert.deepEqual(r.removed, []);
    });

    it("requires a URL positional", async () => {
      await assert.rejects(
        () => executeArchiveDiff("", { since: "2023-12-31" }, deps()),
        (err) => err instanceof ValidationError && /URL is required for archive diff/.test(err.message),
      );
    });

    it("requires --since", async () => {
      await assert.rejects(
        () => executeArchiveDiff(`${base}/live`, {}, deps()),
        (err) => err instanceof ValidationError && /--since is required/.test(err.message),
      );
    });

    it("dispatches via main and rejects an invalid --since at parse level", async () => {
      const { adapter, stderr } = makeAdapter();
      const code = await main(["archive", "diff", "https://example.com", "--since", "banana"], {
        invocation: adapter,
        env: {},
        loadScoutlineConfig: () => {
          throw new Error("Should not be called!");
        },
      });
      assert.equal(code, 1);
      assert.match(stderr.join(""), /VALIDATION_ERROR/);
    });

    it("rejects a valueless --timeout at parse level (family: watch --since/--timeout)", async () => {
      const { adapter, stderr } = makeAdapter();
      const code = await main(["archive", "diff", "https://example.com", "--since", "30d", "--timeout"], {
        invocation: adapter,
        env: {},
        loadScoutlineConfig: () => {
          throw new Error("Should not be called!");
        },
      });
      assert.equal(code, 1);
      assert.match(stderr.join(""), /VALIDATION_ERROR/);
      assert.match(stderr.join(""), /--timeout requires a value/);
    });

    it("lists diff in the subcommand error string and ARCHIVE_HELP", async () => {
      const { adapter, stderr } = makeAdapter();
      const code = await main(["archive", "unknown-sub"], {
        invocation: adapter,
        env: {},
        loadScoutlineConfig: () => {
          throw new Error("Should not be called!");
        },
      });
      assert.equal(code, 1);
      assert.match(stderr.join(""), /Valid subcommands: cdx, get, diff\./);
      assert.match(ARCHIVE_HELP, /diff <url>/);
      assert.match(ARCHIVE_HELP, /--since/);
    });
  });
});

describe("archive diff review fixes", () => {
  it("rejects --timeout above the Node setTimeout ceiling (review)", async () => {
    const stdout = [];
    const stderr = [];
    const invocation = {
      stdoutIsTTY: false,
      stdinIsTTY: false,
      environmentOutputMode: "data",
      readStdin: async () => "",
      writeStdout: (v) => stdout.push(v),
      writeStderr: (v) => stderr.push(v),
      runQuietly: async (op) => op(),
      setExitCode: () => {},
    };
    await assert.rejects(
      handleArchive(
        ["diff", "https://example.com", "--since", "30d", "--timeout", "3000000000"],
        "data",
        { invocation, env: {}, secrets: [], providerDescriptors: [], fallbackEnabled: false },
      ),
      (err) =>
        err instanceof ValidationError && /2147483647/.test(`${err.message} ${err.help ?? ""}`),
    );
  });

  it("accepts a plain date in any host timezone (review round 2)", () => {
    // Timezone-independent calendar validation: the field check reads
    // the input digits, never host-local or UTC projections.
    const { atMs } = resolveSinceInstant("2023-01-01", () => 0);
    assert.equal(atMs, Date.parse("2023-01-01T00:00:00Z"));
  });

  it("rejects impossible calendar fields: 2023-02-30, 2023-02-29 (non-leap), month 00/13 (review round 2)", () => {
    for (const bad of ["2023-02-30", "2023-02-29", "2023-00-10", "2023-13-01"]) {
      assert.throws(() => resolveSinceInstant(bad, () => 0), ValidationError, bad);
    }
  });

  it("resolves --since with a numeric offset crossing UTC midnight (review)", () => {
    const { atMs, asOf } = resolveSinceInstant(
      "2023-01-01T00:00:00+05:00",
      () => Date.parse("2026-09-06T00:00:00Z"),
    );
    assert.equal(atMs, Date.parse("2022-12-31T19:00:00Z"));
    assert.equal(asOf, "2022-12-31T19:00:00.000Z");
  });

  it("treats offset-less datetimes as UTC, not local time (review)", () => {
    const { atMs } = resolveSinceInstant("2026-08-01T12:00:00", () => 0);
    assert.equal(atMs, Date.parse("2026-08-01T12:00:00Z"));
  });

  it("rejects a calendar-overflow date (2023-13-45)", () => {
    assert.throws(
      () => resolveSinceInstant("2023-13-45", () => 0),
      ValidationError,
    );
  });

  it("rejects an oversized duration with ValidationError, not RangeError (review)", () => {
    assert.throws(
      () => resolveSinceInstant("9999999999y", () => 0),
      ValidationError,
    );
  });
});

// ---------------------------------------------------------------------------
// Review round 3: declared-length preflight before the bounded reader
// ---------------------------------------------------------------------------

describe("archive diff review round 3", () => {
    it("rejects an oversized live Content-Length before reading the body", async () => {
        const server = http.createServer((req, res) => {
            const u = new URL(req.url, `http://${req.headers.host}`);
            if (u.pathname === "/cdx") {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify([
                    ["timestamp", "statuscode", "length", "digest", "original"],
                    ["20230601000000", "200", "100", "D2", "https://example.com/docs"],
                ]));
                return;
            }
            if (u.pathname === "/live-huge") {
                res.writeHead(200, {
                    "Content-Type": "text/html; charset=utf-8",
                    "Content-Length": String(60 * 1024 * 1024),
                });
                // Send a sliver of the declared 60MB, then stall: the
                // preflight must reject from the DECLARED length before
                // the reader ever starts (a bare stalled response with
                // zero bytes would never even resolve fetch()).
                res.write("<h1>wait");
                return;
            }
            if (u.pathname.startsWith("/replay/")) {
                res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
                res.end("<h1>Old</h1>");
                return;
            }
            res.writeHead(404); res.end();
        });
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        const base = `http://127.0.0.1:${server.address().port}`;
        try {
            await assert.rejects(
                () => executeArchiveDiff(`${base}/live-huge`, { since: "2023-12-31", timeout: 5000 }, {
                    cdxEndpoint: `${base}/cdx`,
                    replayBaseUrl: `${base}/replay`,
                }),
                (err) => err instanceof ValidationError && /Live page size \(62914560 bytes\)/.test(err.message),
            );
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
    });

    it("rejects an oversized replay Content-Length before reading the body", async () => {
        const server = http.createServer((req, res) => {
            const u = new URL(req.url, `http://${req.headers.host}`);
            if (u.pathname === "/cdx") {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify([
                    ["timestamp", "statuscode", "length", "digest", "original"],
                    ["20230601000000", "200", "100", "D2", "https://example.com/docs"],
                ]));
                return;
            }
            if (u.pathname.startsWith("/replay/")) {
                res.writeHead(200, {
                    "Content-Type": "text/html; charset=utf-8",
                    "Content-Length": String(60 * 1024 * 1024),
                });
                res.write("<h1>wait"); // sliver, then stall
                return;
            }
            if (u.pathname === "/live") {
                res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
                res.end("<h1>Live</h1>");
                return;
            }
            res.writeHead(404); res.end();
        });
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        const base = `http://127.0.0.1:${server.address().port}`;
        try {
            await assert.rejects(
                () => executeArchiveDiff(`${base}/live`, { since: "2023-12-31", timeout: 5000 }, {
                    cdxEndpoint: `${base}/cdx`,
                    replayBaseUrl: `${base}/replay`,
                }),
                (err) => err instanceof ValidationError && /Archive capture size \(62914560 bytes\)/.test(err.message),
            );
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
    });
});

describe("archive diff review round 4", () => {
    it("rejects non-ISO --since forms before Date parsing (host-local trap)", () => {
        // Node parses `2023/06/01` as LOCAL time — the same CLI input
        // must not select different cutoffs on different machines.
        for (const bad of ["2023/06/01", "June 1 2023", "2023-6-1", "2023-06-01 12:00:00", "20230601"]) {
            assert.throws(() => resolveSinceInstant(bad, () => 0), ValidationError, bad);
        }
        for (const ok of ["2023-06-01", "2023-06-01T12:00:00", "2023-06-01T12:00:00Z", "2023-06-01T12:00:00+05:00", "2023-06-01T12:00:00.500Z", "2023-06-01T12:00+0530"]) {
            assert.doesNotThrow(() => resolveSinceInstant(ok, () => 0), ok);
        }
    });

    it("parses charset with whitespace around the parameter '='", () => {
        assert.equal(charsetFromContentType("text/html; charset = iso-8859-1"), "iso-8859-1");
        assert.equal(charsetFromContentType("text/html; charset=utf-8"), "utf-8");
        assert.equal(charsetFromContentType('text/html; charset="utf-8"'), "utf-8");
        assert.equal(charsetFromContentType("text/html"), undefined);
    });

    it("live HTTP >= 400 rejects with NetworkError before any body read", async () => {
        const server = http.createServer((req, res) => {
            const u = new URL(req.url, `http://${req.headers.host}`);
            if (u.pathname === "/cdx") {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify([
                    ["timestamp", "statuscode", "length", "digest", "original"],
                    ["20230601000000", "200", "100", "D2", "https://example.com/docs"],
                ]));
                return;
            }
            if (u.pathname === "/live-500") {
                res.writeHead(500, {
                    "Content-Type": "text/html; charset=utf-8",
                    "Content-Length": String(60 * 1024 * 1024),
                });
                res.write("<h1>error sliver"); // stalled oversized error body
                return;
            }
            if (u.pathname.startsWith("/replay/")) {
                res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
                res.end("<h1>Old</h1>");
                return;
            }
            res.writeHead(404); res.end();
        });
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        const base = `http://127.0.0.1:${server.address().port}`;
        try {
            await assert.rejects(
                () => executeArchiveDiff(`${base}/live-500`, { since: "2023-12-31", timeout: 5000 }, {
                    cdxEndpoint: `${base}/cdx`,
                    replayBaseUrl: `${base}/replay`,
                }),
                (err) => err instanceof NetworkError && /Live fetch failed with HTTP 500/.test(err.message),
            );
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
    });
});
