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
} from "../dist/commands/archive.js";
import { main } from "../dist/index.js";
import { NetworkError, ValidationError } from "../dist/lib/errors.js";

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
          const to = u.searchParams.get("to");
          const rows = [CDX_ROWS[0]].concat(
            CDX_ROWS.slice(1).filter((r) => !to || r[0] <= to),
          );
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
        } else if (path === "/live-moved") {
          res.writeHead(301, { Location: "/live" });
          res.end();
        } else if (path === "/live-temp-moved") {
          res.writeHead(302, { Location: "/live" });
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
