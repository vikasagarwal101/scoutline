/**
 * GLM-OCR review fix rows (M1/M2/m1/m2/n2).
 *
 * Hermetic main()-level + adapter-level pins for the review round:
 *   - M1: --save vision runs keep the ledger seam (cache hit = 0 rows,
 *     1113+fallback = 2 rows) because journaling/save chains build from
 *     the ledger-rebuilt descriptor list;
 *   - M2: an --isolated run writes OCR cache entries ONLY under
 *     cache/isolated/<pid>, never the shared dir;
 *   - m1: a failed RETRIED parseLayout (after a successful prefetch)
 *     propagates its own taxonomy error, not the prefetch 422;
 *   - m2: vision batch globs pick up .pdf; extract-text .pdf passes
 *     --dry-run extension validation;
 *   - n2: diff/video dispatch byte-identity pins (same MCP tools+args
 *     as pre-lane, no layout_parsing).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { main } from "../dist/index.js";
import { createInMemoryConsumptionSink } from "../dist/lib/consumption.js";
import { createZaiDescriptor } from "../dist/providers/zai/adapter.js";
import { getMcpToolName } from "../dist/lib/mcp-config.js";
import { ApiError } from "../dist/lib/errors.js";
import { hermeticMainDeps } from "./helpers/hermetic-main.js";

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
const BAD_IMAGE = () =>
  jsonResponse({ error: { code: "1210", message: "bad image" } }, 422);

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

/**
 * main()-level run WITHOUT injected providerDescriptors (the production
 * registry path — that is what M1 exercises: the save/journal chains
 * must build from the REBUILT zai descriptor). The layout double and
 * MCP log ride the seams only the rebuilt descriptor wires... but the
 * production rebuild does NOT wire layoutParsingFetch. So this helper
 * instead stubs globalThis.fetch: layout_parsing calls hit the
 * restFetch route; everything else falls through to a failing fetch.
 */
async function runMainProduction(args, { rest, mcpLog, env = ENV, saveDir, cacheDir } = {}) {
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
  const deps = hermeticMainDeps({
    invocation,
    env: {
      ...env,
      SCOUTLINE_CACHE_DIR: cacheDir ?? (await fs.mkdtemp(path.join(os.tmpdir(), "glm-fix-"))),
    },
    now: () => 1_700_000_000_000,
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

// Isolated cache dir per test (the OCR cache is live).
let tmpRoot;
let savedCacheDir;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "glm-ocr-fix-"));
  savedCacheDir = process.env.SCOUTLINE_CACHE_DIR;
  process.env.SCOUTLINE_CACHE_DIR = tmpRoot;
});

afterEach(async () => {
  if (savedCacheDir === undefined) delete process.env.SCOUTLINE_CACHE_DIR;
  else process.env.SCOUTLINE_CACHE_DIR = savedCacheDir;
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("glm-ocr review M1 — --save runs keep the ledger seam", () => {
  it("--save vision run: cache hit = 0 ledger rows; 1113+fallback = 2 rows", async () => {
    // Production path: NO injected providerDescriptors (the registry
    // rebuild applies); layout double via globalThis.fetch stub.
    const restCalls = [];
    let scriptStep = 0;
    const script = [WARM, INSUFFICIENT];
    const savedGlobalFetch = globalThis.fetch;
    const realWrite = process.stderr.write.bind(process.stderr);
    const notices = [];
    process.stderr.write = (chunk) => {
      notices.push(String(chunk));
      return true;
    };
    globalThis.fetch = async (url, init) => {
      if (String(url).includes("layout_parsing")) {
        restCalls.push({ body: JSON.parse(String(init?.body ?? "{}")) });
        const respond = script[Math.min(scriptStep, script.length - 1)];
        scriptStep += 1;
        return respond(restCalls.length);
      }
      // MCP endpoint: answer 401 so the fallback attempt fails with a
      // TERMINAL AuthError — the executor does not retry, so the row
      // count isolates M1 (seam presence), not retry policy.
      return { ok: false, status: 401, text: async () => "", json: async () => ({}) };
    };
    try {
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "glm-save-"));
      const sharedCache = await fs.mkdtemp(path.join(os.tmpdir(), "glm-save-cache-"));
      const file = path.join(tmp, "doc.png");
      await fs.writeFile(file, Buffer.from("save-probe"));
      // Distinct export paths per run: --save refuses to overwrite an
      // existing export (FILE_ERROR) before dispatch.
      const argsFor = (n) => ["vision", "extract-text", file, "--save", path.join(tmp, `out-${n}.md`)];

      // Phase 1: warm attempt (1 row), then cache hit (0 rows).
      const first = await runMainProduction(argsFor(1), { cacheDir: sharedCache });
      assert.strictEqual(first.code, 0, `first exit 0, stderr: ${first.stderr}`);
      assert.strictEqual(first.sink.events.length, 1, "warm --save run: one adapter row");
      const second = await runMainProduction(argsFor(2), { cacheDir: sharedCache });
      assert.strictEqual(second.code, 0);
      assert.strictEqual(second.sink.events.length, 0, "--save cache hit: ZERO rows (M1)");

      // Phase 2: fresh file (cache-cold) + 1113 → fallback via the real
      // MCP client... which the stub fetch cannot serve. Instead assert
      // the row-count shape on a NEW cold run where the REST arm 1113s
      // and the fallback MCP path errors (row already counted by the
      // adapter before the MCP attempt) — the executor suppression is
      // what M1 pins, so a failing fallback still proves 2-vs-1.
      const fileB = path.join(tmp, "doc2.png");
      await fs.writeFile(fileB, Buffer.from("save-probe-2"));
      scriptStep = 1; // INSUFFICIENT next
      const third = await runMainProduction([
        "vision",
        "extract-text",
        fileB,
        "--save",
        path.join(tmp, "out2.md"),
      ]);
      // Non-zero exit is expected (fallback transport fails), but the
      // ROWS are what M1 pins: adapter emitted 1 (REST) + 1 (fallback
      // seam) = 2, NOT 1 executor row.
      assert.strictEqual(third.sink.events.length, 2, "--save 1113+fallback: TWO rows (M1)");
      assert.ok(
        third.sink.events.every((e) => e.capabilityId === "vision.extract-text"),
        "both rows are vision.extract-text",
      );
      await fs.rm(tmp, { recursive: true, force: true });
    } finally {
      globalThis.fetch = savedGlobalFetch;
      process.stderr.write = realWrite;
    }
  });
});

describe("glm-ocr review M2 — isolated runs never write the shared dir", () => {
  it("SCOUTLINE_ISOLATED=1 lands OCR entries under cache/isolated/<pid>, not the shared cache/", async () => {
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "glm-shared-"));
    const file = path.join(tmpRoot, "iso.png");
    await fs.writeFile(file, Buffer.from("iso-probe"));
    const rest = makeRest([WARM]);
    const notices = [];
    try {
      const savedShared = process.env.SCOUTLINE_CACHE_DIR;
      process.env.SCOUTLINE_CACHE_DIR = sharedRoot;
      process.env.SCOUTLINE_ISOLATED = "1";
      const descriptor = createZaiDescriptor({
        clientFactory: () => {
          throw new Error("no MCP on the OCR arm");
        },
        layoutParsingFetch: rest.fetch,
        notice: (l) => notices.push(l),
      });
      const adapter = descriptor.create({ env: ENV });
      const result = await adapter.vision.invoke({
        operation: "extract-text",
        source: file,
        instruction: "Extract all text from this image.",
      });
      assert.strictEqual(result, "# ledger text");

      const sharedCache = path.join(sharedRoot, "cache");
      const sharedEntries = await fs.readdir(sharedCache).catch(() => []);
      const leaked = sharedEntries.filter(
        (e) => !e.startsWith("isolated") && e.startsWith("v2.vision-ocr-layout-parsing."),
      );
      assert.deepStrictEqual(leaked, [], "no OCR entry in the SHARED dir");

      const isolatedRoot = path.join(sharedCache, "isolated");
      const pidDirs = await fs.readdir(isolatedRoot).catch(() => []);
      assert.ok(pidDirs.includes(String(process.pid)), "entry landed under isolated/<pid>");
      for (const pidDir of pidDirs) {
        const entries = await fs.readdir(path.join(isolatedRoot, pidDir)).catch(() => []);
        assert.ok(
          entries.some((e) => e.startsWith("v2.vision-ocr-layout-parsing.")),
          "the OCR entry exists under the isolated pid dir",
        );
      }
      process.env.SCOUTLINE_CACHE_DIR = savedShared;
    } finally {
      delete process.env.SCOUTLINE_ISOLATED;
      await fs.rm(sharedRoot, { recursive: true, force: true });
    }
  });
});

describe("glm-ocr review m1 — retried-parse failure keeps its taxonomy", () => {
  it("1210 after a successful prefetch propagates as ApiError 422 carrying the REST status, not the prefetch message", async () => {
    // Script: first REST attempt 422/1210 (URL source, fallback-eligible)
    // → prefetch SUCCEEDS (image bytes) → retried parse returns 422/1210.
    const rest = makeRest([BAD_IMAGE, BAD_IMAGE]);
    const bytes = Buffer.from("fake-png-bytes");
    const fetch = async (url, init) => {
      if (String(url) === "https://example.test/shot.png") {
        return {
          ok: true,
          status: 200,
          text: async () => "",
          json: async () => ({}),
          headers: { get: () => "image/png" },
          arrayBuffer: async () =>
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
        };
      }
      return rest.fetch(url, init);
    };
    const descriptor = createZaiDescriptor({
      clientFactory: () => {
        throw new Error("no MCP fallback for non-1113");
      },
      layoutParsingFetch: fetch,
      notice: () => {},
    });
    const adapter = descriptor.create({ env: ENV });
    await assert.rejects(
      adapter.vision.invoke({
        operation: "extract-text",
        source: "https://example.test/shot.png",
        instruction: "x",
      }),
      (error) =>
        error instanceof ApiError &&
        error.statusCode === 422 &&
        !/prefetch failed/i.test(error.message),
      "the retried parse's own taxonomy error must propagate (not the prefetch 422)",
    );
    assert.strictEqual(rest.calls.length, 2, "exactly the initial + one retry");
  });
});

describe("glm-ocr review m2 — batch PDF surface", () => {
  it("glob expansion picks up .pdf inputs", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "glm-pdfglob-"));
    try {
      await fs.writeFile(path.join(dir, "doc1.pdf"), Buffer.from("pdf-one"));
      await fs.writeFile(path.join(dir, "pic1.png"), Buffer.from("png-one"));
      const rest = makeRest([WARM, WARM]);
      const mcpLog = [];
      const outDir = path.join(dir, "out");
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
      const zai = createZaiDescriptor({
        clientFactory: makeMcpFactory(mcpLog),
        layoutParsingFetch: rest.fetch,
        notice: () => {},
      });
      const deps = hermeticMainDeps({
        invocation,
        env: { ...ENV, SCOUTLINE_CACHE_DIR: tmpRoot },
        now: () => 1_700_000_000_000,
        providerDescriptors: [zai],
        searchSleep: async () => {},
        searchRandom: () => 0.5,
      });
      const code = await main(["vision", "batch", path.join(dir, "*"), "--out", outDir], deps);
      assert.strictEqual(code, 0, `glob batch exit 0, stderr: ${writes.filter(w => w[0] === "err").join("\n")}`);
      // The PNG (analyze) goes to MCP; the PDF infers extract-text and
      // hits layout_parsing — exactly one REST call, carrying the PDF
      // bytes (not silently dropped, not routed to analyze).
      assert.strictEqual(rest.calls.length, 1, "the PDF op hit layout_parsing");
      const pdfRan = rest.calls.some(
        (c) => Buffer.from(JSON.parse(c.body).file, "base64").toString("utf8") === "pdf-one",
      );
      assert.ok(pdfRan, "the .pdf input became an extract-text op (no silent drop)");
      assert.strictEqual(mcpLog.length, 1, "the PNG ran as analyze via MCP");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("manifest extract-text .pdf passes --dry-run", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "glm-pdfdry-"));
    try {
      const pdf = path.join(dir, "doc.pdf");
      await fs.writeFile(pdf, Buffer.from("pdf-bytes"));
      const manifest = path.join(dir, "m.json");
      await fs.writeFile(
        manifest,
        JSON.stringify({
          schemaVersion: 1,
          operations: [
            {
              name: "pdf-op",
              command: "vision",
              input: { subcommand: "extract-text", source: pdf },
            },
          ],
        }),
        "utf8",
      );
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
      const zai = createZaiDescriptor({
        clientFactory: makeMcpFactory([]),
        layoutParsingFetch: makeRest([WARM]).fetch,
        notice: () => {},
      });
      const deps = hermeticMainDeps({
        invocation,
        env: { ...ENV, SCOUTLINE_CACHE_DIR: tmpRoot },
        now: () => 1_700_000_000_000,
        providerDescriptors: [zai],
        searchSleep: async () => {},
        searchRandom: () => 0.5,
      });
      const code = await main(["vision", "batch", manifest, "--dry-run"], deps);
      assert.strictEqual(code, 0, `dry-run exit 0, stderr: ${writes.filter(w => w[0] === "err").join("\n")}`);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("glm-ocr review n2 — diff/video dispatch byte-identity pins", () => {
  it("diff and video map to the same MCP tools+args as pre-lane; no layout_parsing", async () => {
    const rest = makeRest([WARM]);
    const mcpLog = [];
    const descriptor = createZaiDescriptor({
      clientFactory: makeMcpFactory(mcpLog),
      layoutParsingFetch: rest.fetch,
      notice: () => {},
    });
    const adapter = descriptor.create({ env: ENV });

    await adapter.vision.invoke({
      operation: "diff",
      expectedSource: "https://example.test/exp.png",
      actualSource: "https://example.test/act.png",
      instruction: "compare",
    });
    await adapter.vision.invoke({
      operation: "video",
      source: "https://example.test/clip.mp4",
      instruction: "summarize",
    });

    assert.strictEqual(rest.calls.length, 0, "diff/video never touch layout_parsing");
    assert.deepStrictEqual(mcpLog[0], {
      name: getMcpToolName("vision", "ui_diff_check"),
      args: {
        expected_image_source: "https://example.test/exp.png",
        actual_image_source: "https://example.test/act.png",
        prompt: "compare",
      },
    });
    assert.deepStrictEqual(mcpLog[1], {
      name: getMcpToolName("vision", "analyze_video"),
      args: { video_source: "https://example.test/clip.mp4", prompt: "summarize" },
    });
  });
});
