import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";

import {
  executeArchiveCdx,
  executeArchiveGet,
  parseArchiveArgs,
  fetchWithArchiveBackoff,
  ARCHIVE_HELP,
} from "../dist/commands/archive.js";
import { main } from "../dist/index.js";
import { NetworkError } from "../dist/lib/errors.js";

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
});
