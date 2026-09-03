import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { Readable } from "node:stream";

import {
  executeFetch,
  fetchCommand,
  parseFetchArgs,
  validateFetchUrl,
  readBoundedResponseBody,
  FETCH_HELP,
  DEFAULT_USER_AGENT,
} from "../dist/commands/fetch.js";
import { main } from "../dist/index.js";
import { FileError } from "../dist/lib/errors.js";

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

describe("scoutline fetch command", () => {
  let server;
  let serverPort;
  let serverBaseUrl;
  let tempDir;

  before(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "scoutline-fetch-test-"));

    server = http.createServer((req, res) => {
      if (req.url === "/hello") {
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Hello World!");
      } else if (req.url === "/json") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", count: 42 }));
      } else if (req.url === "/redirect") {
        res.writeHead(302, { Location: "/hello" });
        res.end();
      } else if (req.url === "/echo-headers") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(req.headers));
      } else if (req.url === "/echo-body") {
        let body = "";
        req.on("data", (chunk) => {
          body += chunk;
        });
        req.on("end", () => {
          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end(body);
        });
      } else if (req.url === "/not-found") {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found");
      } else if (req.url === "/aborted-stream") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.write("partial content before connection drop...");
        req.socket.destroy();
      } else if (req.url === "/damaged-pdf") {
        res.writeHead(200, { "Content-Type": "application/pdf" });
        res.end("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n");
      } else {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Server Error");
      }
    });

    await new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        serverPort = server.address().port;
        serverBaseUrl = `http://127.0.0.1:${serverPort}`;
        resolve();
      });
    });
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe("Validation & Option Parsing", () => {
    it("validates url schemes", () => {
      assert.throws(() => validateFetchUrl("ftp://example.com"), {
        name: "ValidationError",
      });
      assert.doesNotThrow(() => validateFetchUrl("http://example.com"));
      assert.doesNotThrow(() => validateFetchUrl("https://example.com"));
    });

    it("parses fetch flags including multiple headers", () => {
      const parsed = parseFetchArgs([
        "https://example.com",
        "--out",
        "file.txt",
        "--md5",
        "--raw",
        "-H",
        "Authorization: Bearer token123",
        "--header",
        "X-Custom: val456",
        "--method",
        "POST",
        "--data",
        "foo=bar",
      ]);

      assert.equal(parsed.positional[0], "https://example.com");
      assert.equal(parsed.options.out, "file.txt");
      assert.equal(parsed.options.md5, true);
      assert.equal(parsed.options.raw, true);
      assert.equal(parsed.options.method, "POST");
      assert.equal(parsed.options.data, "foo=bar");
      assert.deepEqual(parsed.options.headers, [
        "Authorization: Bearer token123",
        "X-Custom: val456",
      ]);
    });

    it("rejects request bodies on GET and HEAD methods", async () => {
      await assert.rejects(
        () => executeFetch("http://127.0.0.1/foo", { method: "GET", data: "hello" }),
        { name: "ValidationError" },
      );
    });

    it("rejects non-existent file path in --data @file", async () => {
      await assert.rejects(
        () =>
          executeFetch("http://127.0.0.1/foo", {
            method: "POST",
            data: "@/nonexistent/file/path.json",
          }),
        (err) => err instanceof FileError && err.code === "FILE_ERROR",
      );
    });
  });

  describe("HTTP Retrieval & Evidentiary Features", () => {
    it("fetches a text resource and follows redirects", async () => {
      const result = await executeFetch(`${serverBaseUrl}/redirect`);
      assert.equal(result.status, 200);
      assert.equal(result.content, "Hello World!");
      assert.equal(result.finalUrl, `${serverBaseUrl}/hello`);
      assert.equal(result.bytes, 12);
    });

    it("computes MD5 checksum when --md5 is passed", async () => {
      const result = await executeFetch(`${serverBaseUrl}/hello`, { md5: true });
      const expectedMd5 = crypto.createHash("md5").update("Hello World!").digest("hex");
      assert.equal(result.md5, expectedMd5);
    });

    it("writes byte-exact payload to file when --out is specified", async () => {
      const outFile = path.join(tempDir, "hello.txt");
      const result = await executeFetch(`${serverBaseUrl}/hello`, { out: outFile, md5: true });
      assert.equal(result.outPath, outFile);
      assert.equal(fs.existsSync(outFile), true);
      assert.equal(fs.readFileSync(outFile, "utf8"), "Hello World!");
    });

    it("uses default browser User-Agent unless overridden", async () => {
      const defaultRes = await executeFetch(`${serverBaseUrl}/echo-headers`);
      const defaultHeaders = JSON.parse(defaultRes.content);
      assert.equal(defaultHeaders["user-agent"], DEFAULT_USER_AGENT);

      const customRes = await executeFetch(`${serverBaseUrl}/echo-headers`, {
        ua: "CustomScout/1.0",
      });
      const customHeaders = JSON.parse(customRes.content);
      assert.equal(customHeaders["user-agent"], "CustomScout/1.0");
    });

    it("passes custom headers and body with POST", async () => {
      const testPayload = "test payload from pipeline";
      const result = await executeFetch(`${serverBaseUrl}/echo-body`, {
        method: "POST",
        data: testPayload,
        headers: ["X-Test-Id: 998877"],
      });
      assert.equal(result.status, 200);
      assert.equal(result.content, testPayload);
    });

    it("reads request body from @file.json", async () => {
      const jsonFile = path.join(tempDir, "body.json");
      fs.writeFileSync(jsonFile, JSON.stringify({ query: "scoutline" }));

      const result = await executeFetch(`${serverBaseUrl}/echo-body`, {
        method: "POST",
        data: `@${jsonFile}`,
      });
      assert.equal(result.status, 200);
      assert.equal(result.content, JSON.stringify({ query: "scoutline" }));
    });

    it("accepts -X for method and -A / --user-agent for User-Agent", () => {
      const parsedX = parseFetchArgs(["https://example.com", "-X", "post"]);
      assert.equal(parsedX.options.method, "POST");

      const parsedA = parseFetchArgs(["https://example.com", "-A", "CustomBot/1.0"]);
      assert.equal(parsedA.options.ua, "CustomBot/1.0");

      const parsedUa = parseFetchArgs(["https://example.com", "--user-agent", "CustomBot/2.0"]);
      assert.equal(parsedUa.options.ua, "CustomBot/2.0");
    });

    it("does not write to --out on HTTP error (404/500)", async () => {
      const errorOut = path.join(tempDir, "should-not-exist.txt");
      const result = await executeFetch(`${serverBaseUrl}/not-found`, {
        out: errorOut,
      });
      assert.equal(result.status, 404);
      assert.equal(fs.existsSync(errorOut), false, "--out file must not be written on HTTP error");
    });

    it("streams direct downloads to --out and computes md5", async () => {
      const streamOut = path.join(tempDir, "streamed.txt");
      const result = await executeFetch(`${serverBaseUrl}/hello`, {
        out: streamOut,
        md5: true,
      });
      assert.equal(result.status, 200);
      assert.equal(fs.existsSync(streamOut), true);
      const content = fs.readFileSync(streamOut, "utf8");
      assert.equal(content, "Hello World!");
      const expectedMd5 = crypto.createHash("md5").update(Buffer.from("Hello World!")).digest("hex");
      assert.equal(result.md5, expectedMd5);
    });

    it("rejects non-positive --timeout values", () => {
      assert.throws(
        () => parseFetchArgs(["https://example.com", "--timeout", "0"]),
        { name: "ValidationError" },
      );
      assert.throws(
        () => parseFetchArgs(["https://example.com", "--timeout", "-5"]),
        { name: "ValidationError" },
      );
    });

    it("rejects unknown options in parseFetchArgs", () => {
      assert.throws(
        () => parseFetchArgs(["https://example.com", "--bogus"]),
        { name: "ValidationError" },
      );
    });

    it("resolves relative --out to absolute path", async () => {
      const relOut = "relative-test.txt";
      const resolved = path.resolve(process.cwd(), relOut);
      try {
        const result = await executeFetch(`${serverBaseUrl}/hello`, { out: relOut });
        assert.equal(result.outPath, resolved);
        assert.equal(fs.existsSync(resolved), true);
      } finally {
        if (fs.existsSync(resolved)) fs.unlinkSync(resolved);
      }
    });

    it("cleans up temporary file and leaves destination empty on mid-stream network drop", async () => {
      const failOut = path.join(tempDir, "failed-stream.txt");
      await assert.rejects(
        () => executeFetch(`${serverBaseUrl}/aborted-stream`, { out: failOut }),
      );
      assert.equal(fs.existsSync(failOut), false);
      const files = fs.readdirSync(tempDir);
      const tmpFiles = files.filter((f) => f.includes("failed-stream.txt.tmp"));
      assert.equal(tmpFiles.length, 0, "temporary file must not linger after aborted stream");
    });

    it("repairs damaged PDF before writing to --out", async () => {
      const repairOut = path.join(tempDir, "repaired.pdf");
      const result = await executeFetch(`${serverBaseUrl}/damaged-pdf`, {
        out: repairOut,
        pdfRepair: true,
      });
      assert.equal(fs.existsSync(repairOut), true);
      const written = fs.readFileSync(repairOut, "latin1");
      assert.match(written, /startxref/);
      assert.match(written, /xref/);
    });

    it("throws ValidationError and cancels stream when chunked body exceeds limit", async () => {
      async function* generateChunks() {
        const chunk = new Uint8Array(1024);
        while (true) {
          yield chunk;
        }
      }
      const stream = Readable.toWeb(Readable.from(generateChunks()));
      await assert.rejects(
        () => readBoundedResponseBody(stream, 2048, "Test stream"),
        { name: "ValidationError" },
      );
    });
  });

  describe("CLI & Early Credential-Free Dispatch", () => {
    it("prints help when requested", async () => {
      const { adapter, stdout } = makeAdapter();
      const code = await main(["fetch", "--help"], {
        invocation: adapter,
        env: {},
        loadScoutlineConfig: () => {
          throw new Error("Should not be called!");
        },
      });
      assert.equal(code, 0);
      assert.match(stdout.join(""), /scoutline fetch <url>/);
    });

    it("runs credential-free through main() without reading config", async () => {
      const { adapter, stdout } = makeAdapter();
      const code = await main(
        ["fetch", `${serverBaseUrl}/hello`, "-O", "json"],
        {
          invocation: adapter,
          env: {},
          loadScoutlineConfig: () => {
            throw new Error("Should not be called for fetch!");
          },
        },
      );
      assert.equal(code, 0);
      const parsed = JSON.parse(stdout.join(""));
      assert.equal(parsed.success, true);
      assert.equal(parsed.data.content, "Hello World!");
    });
  });
});
