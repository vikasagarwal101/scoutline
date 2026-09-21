/**
 * GLM-OCR ledger + batch/doctor non-interference (glm-ocr lane T4,
 * ADR-0014 D6/D7).
 *
 * Hermetic main()-level runs with an in-memory consumption sink and a
 * layout-parsing REST double injected through the production registry
 * descriptor seam. Pins:
 *   - a layout_parsing attempt records ONE billed vision-class ledger
 *     row (via the index.ts dispatch hook the MCP vision path uses);
 *   - an 1113 + fallback run records TWO rows (attempts counted, 0
 *     charges inferred);
 *   - a cache hit records ZERO rows;
 *   - `vision batch` extract-text rows route + fall back identically
 *     (composition pin);
 *   - doctor's vision probe surface unchanged;
 *   - MiniMax extract-text output byte-identical pre/post lane
 *     (fixture A/B against the pinned MCP mapping).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as nodeChildProcess from "node:child_process";
import { promisify } from "node:util";

import { main } from "../dist/index.js";
import { createInMemoryConsumptionSink } from "../dist/lib/consumption.js";
import { createZaiDescriptor } from "../dist/providers/zai/adapter.js";
import { createMiniMaxDescriptor } from "../dist/providers/minimax/adapter.js";
import { getMcpToolName } from "../dist/lib/mcp-config.js";
import { hermeticMainDeps } from "./helpers/hermetic-main.js";

const execFile = promisify(nodeChildProcess.execFile);

const ENV = { Z_AI_API_KEY: "test-zai-api-key-DO-NOT-LEAK" };

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
    json: async () => payload,
  };
}

function makeRest(script) {
  const calls = [];
  const steps = [...script];
  const fetch = async (url, init) => {
    calls.push({ url, init, body: init?.body });
    const respond = steps.shift();
    return respond ? respond(calls.length) : jsonResponse({ md_results: "warm default" });
  };
  return { calls, fetch };
}

const WARM = () => jsonResponse({ md_results: "# ledger text" });
const INSUFFICIENT = () =>
  jsonResponse({ error: { code: "1113", message: "Insufficient balance" } }, 429);

function makeMcpFactory(log) {
  return () => ({
    async callToolRaw(name, args) {
      log.push({ name, args });
      return "mcp fallback text";
    },
    async listTools() {
      return [];
    },
    async close() {},
  });
}

/** Capture BOTH stderr routes: invocation writes and production process.stderr. */
function captureAllStderr(fn) {
  const lines = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    lines.push(String(chunk));
    return true;
  };
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      process.stderr.write = realWrite;
    })
    .then((value) => ({ value, stderr: lines.join("\n") }));
}

/**
 * main()-level run with the production zai descriptor re-created with
 * the injected seams (layout double + mcp log + stderr notices) and an
 * in-memory consumption sink. Returns { code, stdout, stderr, sink,
 * rest, mcp }.
 */
async function runMain(args, { rest, mcpLog, env = ENV } = {}) {
  const writes = [];
  const invocation = {
    stdoutIsTTY: false,
    stdinIsTTY: false,
    environmentOutputMode: undefined,
    readStdin: async () => "",
    writeStdout(v) {
      writes.push(["out", v]);
    },
    writeStderr(v) {
      writes.push(["err", v]);
    },
    runQuietly: async (op) => op(),
    setExitCode() {},
  };
  const sink = createInMemoryConsumptionSink();
  const zai = Object.assign(
    createZaiDescriptor({
      clientFactory: makeMcpFactory(mcpLog),
      layoutParsingFetch: rest.fetch,
      // Production wiring shape (registry): notice forwards to stderr;
      // the ledger seam counts OCR-arm attempts at the adapter.
      notice: (line) => process.stderr.write(`${line}\n`),
      layoutParsingConsume: sink,
      layoutParsingConsumeNow: () => 1_700_000_000_000,
    }),
    // Marker mirroring the production rebuild: the executor suppresses
    // its own emission because the adapter owns the rows here.
    { zaiOcrLedgerSeam: true },
  );
  const deps = hermeticMainDeps({
    invocation,
    env: { ...env, SCOUTLINE_CACHE_DIR: await fs.mkdtemp(path.join(os.tmpdir(), "glm-t4-")) },
    now: () => 1_700_000_000_000,
    providerDescriptors: [zai],
    consume: sink,
    searchSleep: async () => {},
    searchRandom: () => 0.5,
  });
  const code = await main(args, deps);
  return {
    code,
    sink,
    stdout: writes.filter((w) => w[0] === "out").map((w) => w[1]).join("\n").trim(),
    stderr: writes.filter((w) => w[0] === "err").map((w) => w[1]).join("\n"),
  };
}

// Isolated cache dir per test file run (the OCR cache is live).
let tmpRoot;
let savedCacheDir;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "glm-ocr-t4-cache-"));
  savedCacheDir = process.env.SCOUTLINE_CACHE_DIR;
  process.env.SCOUTLINE_CACHE_DIR = tmpRoot;
});

afterEach(async () => {
  if (savedCacheDir === undefined) delete process.env.SCOUTLINE_CACHE_DIR;
  else process.env.SCOUTLINE_CACHE_DIR = savedCacheDir;
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("glm-ocr T4 — ledger rows (D7)", () => {
  it("a successful layout_parsing attempt records exactly ONE billed vision-class row", async () => {
    const rest = makeRest([WARM]);
    const mcpLog = [];
    const out = await runMain(["vision", "extract-text", "https://example.test/doc.png"], {
      rest,
      mcpLog,
    });
    assert.strictEqual(out.code, 0);
    assert.strictEqual(out.sink.events.length, 1, "one row per attempt");
    const row = out.sink.events[0];
    assert.strictEqual(row.provider, "zai");
    assert.strictEqual(row.capabilityId, "vision.extract-text");
    assert.strictEqual(row.category, "vision");
    assert.strictEqual(mcpLog.length, 0, "no MCP fallback on the warm path");
  });

  it("an 1113 + fallback run records TWO rows (attempts counted, charges not inferred)", async () => {
    const rest = makeRest([INSUFFICIENT]);
    const mcpLog = [];
    const { value: out, stderr: procStderr } = await captureAllStderr(() =>
      runMain(["vision", "extract-text", "https://example.test/doc.png"], { rest, mcpLog }),
    );
    assert.strictEqual(out.code, 0);
    assert.strictEqual(out.sink.events.length, 2, "layout_parsing attempt + fallback attempt");
    assert.ok(
      out.sink.events.every((e) => e.capabilityId === "vision.extract-text"),
      "both rows are vision-class",
    );
    assert.strictEqual(mcpLog.length, 1, "fallback invoked the MCP tool once");
    assert.match(
      `${out.stderr}\n${procStderr}`,
      /falling back to vision model/,
      "fallback notice reached stderr (production wiring: process.stderr)",
    );
  });

  it("a cache hit records ZERO rows", async () => {
    const rest = makeRest([WARM]);
    const mcpLog = [];
    const args = ["vision", "extract-text", "https://example.test/doc.png"];
    const first = await runMain(args, { rest, mcpLog });
    assert.strictEqual(first.sink.events.length, 1);
    // Second run: same URL, same credential, same hermetic cache dir.
    const second = await runMain(args, { rest, mcpLog });
    assert.strictEqual(second.sink.events.length, 0, "warm hit emits nothing");
    assert.strictEqual(rest.calls.length, 1, "and no transport");
  });
});

describe("glm-ocr T4 — vision batch composition pin", () => {
  it("batch extract-text routes to layout_parsing (warm) and falls back on 1113 (two single-op runs)", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "glm-t4-batch-"));
    const outDir = path.join(tmp, "out");
    const imgA = path.join(tmp, "a.png");
    const imgB = path.join(tmp, "b.png");
    await fs.writeFile(imgA, Buffer.from("batch-a"));
    await fs.writeFile(imgB, Buffer.from("batch-b"));
    try {
      // vision batch manifests carry exactly ONE op (wrapper contract);
      // two runs exercise both arms through the same composition.
      const runBatch = async (name, img) => {
        const manifest = path.join(tmp, `manifest-${name}.json`);
        await fs.writeFile(
          manifest,
          JSON.stringify({
            schemaVersion: 1,
            operations: [
              {
                name,
                command: "vision",
                input: { subcommand: "extract-text", source: img },
                output: path.join(outDir, `${name}.json`),
              },
            ],
          }),
          "utf8",
        );
        return manifest;
      };

      // Run A: warm glm-ocr. Run B: 1113 -> MCP fallback.
      const rest = makeRest([WARM, INSUFFICIENT]);
      const mcpLog = [];
      const outA = await runMain(["vision", "batch", await runBatch("op-a", imgA), "--out", outDir], {
        rest,
        mcpLog,
      });
      assert.strictEqual(outA.code, 0, `batch A exit 0, stderr: ${outA.stderr}`);
      const manifestB = await runBatch("op-b", imgB);
      const { value: outB, stderr: procStderrB } = await captureAllStderr(() =>
        runMain(["vision", "batch", manifestB, "--out", outDir], { rest, mcpLog }),
      );
      assert.strictEqual(outB.code, 0, `batch B exit 0, stderr: ${outB.stderr}`);

      assert.strictEqual(rest.calls.length, 2, "one layout_parsing per input");
      assert.strictEqual(mcpLog.length, 1, "the 1113 input fell back to MCP");
      const fallbackTool = getMcpToolName("vision", "extract_text_from_screenshot");
      assert.strictEqual(mcpLog[0].name, fallbackTool);
      assert.match(
        `${outB.stderr}\n${procStderrB}`,
        /falling back to vision model/,
        "fallback notice on the batch stderr (production wiring: process.stderr)",
      );
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("glm-ocr T4 — doctor vision probe unchanged", () => {
  it("doctor still reports visionMcpCompatible from node version (metadata only)", async () => {
    const rest = makeRest([WARM]);
    const mcpLog = [];
    const out = await runMain(["doctor", "--json"], { rest, mcpLog });
    assert.strictEqual(out.code, 0, `doctor exit 0, stderr: ${out.stderr}`);
    const report = JSON.parse(out.stdout);
    const nodeMajor = Number(process.versions.node.split(".")[0]);
    assert.strictEqual(report.node.visionMcpCompatible, nodeMajor >= 22);
    assert.strictEqual(rest.calls.length, 0, "doctor never transports to layout_parsing");
    assert.strictEqual(mcpLog.length, 0);
  });
});

describe("glm-ocr T4 — minimax extract-text byte-identity (pin)", () => {
  it("minimax extract-text keeps its specialized mapping; no layout_parsing call on its path", async () => {
    // Same driving pattern as minimax-adapter's P5-04 suite: forced
    // support gate + fetch sequence (image fetch, then the VLM
    // endpoint). The pin: the wire never touches layout_parsing or any
    // api.z.ai base — the glm-ocr REST arm is zai-only.
    const calls = [];
    let i = 0;
    const responses = [
      { ok: true, status: 200, contentType: "image/png", arrayBuffer: new ArrayBuffer(4) },
      { ok: true, status: 200, json: { content: "minimax text", base_resp: { status_code: 0 } } },
    ];
    const fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      const resp = responses[Math.min(i, responses.length - 1)];
      i += 1;
      return {
        ok: resp.ok,
        status: resp.status,
        text: async () => "",
        json: async () => resp.json,
        headers: { get: () => resp.contentType ?? null },
        arrayBuffer: async () => resp.arrayBuffer ?? new ArrayBuffer(0),
      };
    };
    const descriptor = createMiniMaxDescriptor({
      transport: { fetch, setTimeout: () => 0, clearTimeout: () => {} },
      isSpecializedVisionOperationSupported: (op) => op === "extract-text",
    });
    const adapter = descriptor.create({
      env: { MINIMAX_API_KEY: "k", SCOUTLINE_CACHE_DIR: tmpRoot },
    });
    const result = await adapter.vision.invoke({
      operation: "extract-text",
      source: "https://example.test/s.png",
      instruction: "Extract all text from this image.",
    });
    assert.strictEqual(result, "minimax text");
    // Byte-identity: image fetch + exactly one VLM POST to the MiniMax
    // endpoint — never layout_parsing, never the zai base.
    assert.strictEqual(calls.length, 2, "image fetch + one VLM call");
    const vlm = calls[1];
    assert.ok(!vlm.url.includes("layout_parsing"), "minimax never posts to layout_parsing");
    assert.ok(!vlm.url.includes("api.z.ai"), "minimax never posts to a zai base");
    assert.match(vlm.url, /minimax/i, "the VLM call targets the MiniMax endpoint");
  });
});
