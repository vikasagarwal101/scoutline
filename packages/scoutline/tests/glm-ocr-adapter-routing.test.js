/**
 * GLM-OCR adapter routing + exhaustion fallback (glm-ocr lane T2,
 * ADR-0014 D1/D5/D6).
 *
 * Hermetic: layout-parsing REST double injected through
 * `createZaiDescriptor`'s new dependency seam; the MCP client is a
 * recording fake. Pins:
 *   - zai extract-text invokes layout_parsing FIRST (REST wire shape);
 *     no MCP client constructed on the warm path;
 *   - 1113 → notice line (exact text) → MCP
 *     `extract_text_from_screenshot` with pre-lane instruction
 *     semantics → its result is the command result;
 *   - non-1113 REST error propagates with NO engine fallback;
 *   - `--language` / custom prompt on the OCR arm warn-and-strip
 *     (notices pinned), honored verbatim on the fallback arm;
 *   - URL-source REST failure → ONE prefetch-to-base64 retry;
 *     failed prefetch terminal 422;
 *   - every other operation dispatches byte-identically (analyze /
 *     diagram pins — no layout_parsing call, same MCP tool + args).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { createZaiDescriptor } from "../dist/providers/zai/adapter.js";
import { getMcpToolName } from "../dist/lib/mcp-config.js";
import { ApiError, NetworkError, ValidationError } from "../dist/lib/errors.js";

const ENV = { Z_AI_API_KEY: "test-zai-api-key-DO-NOT-LEAK" };
const EXTRACT_TOOL = getMcpToolName("vision", "extract_text_from_screenshot");
const ANALYZE_TOOL = getMcpToolName("vision", "analyze_image");
const DIAGRAM_TOOL = getMcpToolName("vision", "understand_technical_diagram");
const LAYOUT_URL = "https://api.z.ai/api/paas/v4/layout_parsing";

/** The pinned fallback notice text (PRD AC-2, owner-approved). */
const FALLBACK_NOTICE =
  "glm-ocr unavailable (no PAYG balance); falling back to vision model";
const LANGUAGE_STRIP_NOTICE = "--language not supported by glm-ocr; ignored";
const PROMPT_STRIP_NOTICE = "custom prompt not supported by glm-ocr; ignored";

/**
 * REST double: scriptable per-URL responder over a byte-exact fetch
 * seam (url, status, payload headers) that supports arrayBuffer
 * (prefetch).
 */
function makeLayoutRest() {
  const calls = [];
  let script = [];
  const fetch = async (url, init) => {
    calls.push({ url, init, body: init?.body });
    const respond = script.shift() ?? (() => jsonResponse({ md_results: "ok" }));
    return typeof respond === "function" ? respond(url, init) : respond;
  };
  return {
    calls,
    fetch,
    set(...steps) {
      script = steps;
    },
  };
}

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
    json: async () => payload,
    headers: { get: () => "application/json" },
    arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(payload)).buffer,
  };
}

/**
 * MCP client factory double: records every callToolRaw; never talks to
 * a transport. Construction is observable so the warm path can prove
 * no client was built.
 */
function makeMcpFactory(result = "mcp text result") {
  const created = [];
  const calls = [];
  const factory = () => {
    created.push(true);
    return {
      async callToolRaw(name, args) {
        calls.push({ name, args });
        return result;
      },
      async listTools() {
        return [];
      },
      async close() {},
    };
  };
  factory.created = created;
  factory.calls = calls;
  return factory;
}

/** Notice capture: adapter default is silent; injected dep records. */
function makeNotices() {
  const lines = [];
  return { lines, notice: (line) => lines.push(line) };
}

// Isolated cache dir per test (T3 cache is live on the OCR arm).
let tmpCacheRoot;
let savedCacheDir;

beforeEach(async () => {
  tmpCacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), "glm-ocr-t2-cache-"));
  savedCacheDir = process.env.SCOUTLINE_CACHE_DIR;
  process.env.SCOUTLINE_CACHE_DIR = tmpCacheRoot;
});

afterEach(async () => {
  if (savedCacheDir === undefined) delete process.env.SCOUTLINE_CACHE_DIR;
  else process.env.SCOUTLINE_CACHE_DIR = savedCacheDir;
  await fs.rm(tmpCacheRoot, { recursive: true, force: true });
});

function makeAdapter({ rest, mcp, notices }) {
  const descriptor = createZaiDescriptor({
    clientFactory: mcp,
    layoutParsingFetch: rest.fetch,
    notice: notices.notice,
  });
  return descriptor.create({ env: ENV });
}

describe("glm-ocr T2 — warm routing", () => {
  it("extract-text invokes layout_parsing first with the URL verbatim; NO MCP client constructed", async () => {
    const rest = makeLayoutRest();
    rest.set(() => jsonResponse({ md_results: "# extracted" }));
    const mcp = makeMcpFactory();
    const adapter = makeAdapter({ rest, mcp, notices: makeNotices() });

    const result = await adapter.vision.invoke({
      operation: "extract-text",
      source: "https://example.test/shot.png",
      instruction: "Extract all text from this image.",
    });

    assert.strictEqual(result, "# extracted");
    assert.strictEqual(mcp.created.length, 0, "no MCP client on the warm path");
    assert.strictEqual(rest.calls.length, 1);
    assert.strictEqual(rest.calls[0].url, LAYOUT_URL);
    const body = JSON.parse(rest.calls[0].body);
    assert.deepStrictEqual(body, {
      model: "glm-ocr",
      file: "https://example.test/shot.png",
    });
  });

  it("local file input is base64 in `file`", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "glm-ocr-t2-"));
    const filePath = path.join(tmp, "shot.png");
    await fs.writeFile(filePath, Buffer.from("fake-png-bytes"));
    try {
      const rest = makeLayoutRest();
      rest.set(() => jsonResponse({ md_results: "ok" }));
      const adapter = makeAdapter({ rest, mcp: makeMcpFactory(), notices: makeNotices() });
      await adapter.vision.invoke({
        operation: "extract-text",
        source: filePath,
        instruction: "Extract all text from this image.",
      });
      const body = JSON.parse(rest.calls[0].body);
      assert.strictEqual(body.model, "glm-ocr");
      assert.ok(typeof body.file === "string" && body.file.length > 0);
      assert.strictEqual(
        Buffer.from(body.file, "base64").toString("utf8"),
        "fake-png-bytes",
        "file must be the base64 of the local bytes",
      );
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("default prompt extract-text still routes to glm-ocr (prompt stripped, no notice for the default)", async () => {
    const rest = makeLayoutRest();
    rest.set(() => jsonResponse({ md_results: "x" }));
    const notices = makeNotices();
    const adapter = makeAdapter({ rest, mcp: makeMcpFactory(), notices });
    await adapter.vision.invoke({
      operation: "extract-text",
      source: "https://example.test/a.png",
      instruction: "Extract all text from this image.",
    });
    assert.deepStrictEqual(notices.lines, [], "default prompt never warns");
  });
});

describe("glm-ocr T2 — 1113 exhaustion fallback", () => {
  it("1113 → pinned notice → MCP extract_text_from_screenshot with pre-lane semantics → result returned", async () => {
    const rest = makeLayoutRest();
    rest.set(() => jsonResponse({ error: { code: "1113", message: "Insufficient balance" } }, 429));
    const mcp = makeMcpFactory("fallback arm text");
    const notices = makeNotices();
    const adapter = makeAdapter({ rest, mcp, notices });

    const result = await adapter.vision.invoke({
      operation: "extract-text",
      source: "https://example.test/shot.png",
      instruction: "Extract all text from this image.",
      programmingLanguage: "rust",
    });

    assert.strictEqual(result, "fallback arm text");
    // The strip notices fire on the OCR arm BEFORE the 1113 rejection —
    // the ordered sequence is [strip notices..., FALLBACK_NOTICE].
    assert.deepStrictEqual(notices.lines, [
      LANGUAGE_STRIP_NOTICE,
      FALLBACK_NOTICE,
    ]);
    assert.strictEqual(mcp.calls.length, 1, "exactly one MCP fallback invocation");
    assert.strictEqual(mcp.calls[0].name, EXTRACT_TOOL);
    // Pre-lane semantics: image_source + prompt + programming_language.
    assert.deepStrictEqual(mcp.calls[0].args, {
      image_source: "https://example.test/shot.png",
      prompt: "Extract all text from this image.",
      programming_language: "rust",
    });
  });

  it("the 1113 fallback result is normalized like the pre-lane path (empty result rejects)", async () => {
    const rest = makeLayoutRest();
    rest.set(() => jsonResponse({ error: { code: 1113 } }, 402));
    const mcp = makeMcpFactory("   ");
    const adapter = makeAdapter({ rest, mcp, notices: makeNotices().notice });
    await assert.rejects(
      adapter.vision.invoke({
        operation: "extract-text",
        source: "https://example.test/s.png",
        instruction: "x",
      }),
      ApiError,
    );
  });
});

describe("glm-ocr T2 — non-1113 propagation", () => {
  it("non-1113 REST error propagates with NO engine fallback (local source: no retry)", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "glm-ocr-t2b-"));
    const filePath = path.join(tmp, "bad.png");
    await fs.writeFile(filePath, Buffer.from("x"));
    try {
      const rest = makeLayoutRest();
      rest.set(() => jsonResponse({ error: { code: "1210", message: "bad image" } }, 422));
      const mcp = makeMcpFactory();
      const adapter = makeAdapter({ rest, mcp, notices: makeNotices().notice });
      await assert.rejects(
        adapter.vision.invoke({
          operation: "extract-text",
          source: filePath,
          instruction: "x",
        }),
        ApiError,
      );
      assert.strictEqual(mcp.created.length, 0, "no fallback transport");
      assert.strictEqual(rest.calls.length, 1, "no second REST attempt (local sources never prefetch-retry)");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("URL-source REST failure retries once via prefetch-to-base64", async () => {
    const rest = makeLayoutRest();
    let restAttempts = 0;
    rest.set(
      () => {
        restAttempts += 1;
        return jsonResponse({ error: { code: "1210" } }, 422);
      },
      () => {
        restAttempts += 1;
        return jsonResponse({ md_results: "recovered via base64" });
      },
    );
    // Prefetch fetch: serves the image bytes.
    const bytes = Buffer.from("fake-png-bytes");
    const restWithPrefetch = {
      calls: rest.calls,
      fetch: async (url, init) => {
        if (url === "https://example.test/shot.png") {
          return {
            ok: true,
            status: 200,
            text: async () => "",
            json: async () => ({}),
            headers: { get: () => "image/png" },
            arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
          };
        }
        return rest.fetch(url, init);
      },
    };
    const adapter = makeAdapter({ rest: restWithPrefetch, mcp: makeMcpFactory(), notices: makeNotices().notice });
    const result = await adapter.vision.invoke({
      operation: "extract-text",
      source: "https://example.test/shot.png",
      instruction: "x",
    });
    assert.strictEqual(result, "recovered via base64");
    assert.strictEqual(restAttempts, 2, "exactly one retry");
    const secondBody = JSON.parse(rest.calls[1].body);
    assert.match(secondBody.file, /^data:image\/png;base64,/, "retry sends base64 data URI");
  });

  it("failed prefetch is terminal 422 (no MCP fallback)", async () => {
    const rest = makeLayoutRest();
    rest.set(() => jsonResponse({ error: { code: "1210" } }, 422));
    const fetchAlwaysFails = async () => {
      throw new TypeError("fetch failed");
    };
    fetchAlwaysFails.calls = rest.calls;
    const mcp = makeMcpFactory();
    const adapter = makeAdapter({
      rest: { calls: rest.calls, fetch: fetchAlwaysFails },
      mcp,
      notices: makeNotices().notice,
    });
    await assert.rejects(
      adapter.vision.invoke({
        operation: "extract-text",
        source: "https://example.test/s.png",
        instruction: "x",
      }),
      (error) => error instanceof ApiError && error.statusCode === 422,
    );
    assert.strictEqual(mcp.created.length, 0);
  });

  it("oversize chunked prefetch (no content-length) streams past the 10MB image cap, then cancels the connection (ValidationError, not 422)", async () => {
    const rest = makeLayoutRest();
    rest.set(() => jsonResponse({ error: { code: "1210" } }, 422));
    // Chunked double: declares NO content-length, emits 1MB chunks until
    // cancelled. A correct bounded read cancels ~11 chunks in; an
    // unbounded arrayBuffer() drains all of them.
    const CHUNK = 1024 * 1024;
    let served = 0;
    let cancelled = false;
    const oversizeFetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      get body() {
        const self = this;
        return new ReadableStream({
          pull(controller) {
            if (cancelled) {
              controller.close();
              return;
            }
            served += CHUNK;
            controller.enqueue(new Uint8Array(CHUNK));
          },
          cancel() {
            cancelled = true;
          },
        });
      },
      arrayBuffer: async () => {
        throw new Error("unbounded arrayBuffer reached — bounded read required");
      },
    });
    oversizeFetch.calls = rest.calls;
    const mcp = makeMcpFactory();
    const adapter = makeAdapter({
      rest: { calls: rest.calls, fetch: oversizeFetch },
      mcp,
      notices: makeNotices().notice,
    });
    await assert.rejects(
      adapter.vision.invoke({
        operation: "extract-text",
        source: "https://example.test/shot.png",
        instruction: "x",
      }),
      (error) => error instanceof ValidationError,
    );
    assert.strictEqual(cancelled, true, "stream cancelled at cap");
    assert.ok(served <= 12 * 1024 * 1024, `read stopped at cap, served ${served}`);
    assert.strictEqual(mcp.created.length, 0);
  });

  it("arrayBuffer-only double (no body stream) uses the bounded fallback and still caps (oversize → ValidationError)", async () => {
    const rest = makeLayoutRest();
    rest.set(() => jsonResponse({ error: { code: "1210" } }, 422));
    // Legacy double shape: satisfies the ORIGINAL arrayBuffer() seam
    // contract, supplies no body stream. Content-length declared OVER
    // the 10MB image cap → rejected on the precheck; the post-read cap
    // catches underdeclared/undeclared servers.
    const bigPayload = new Uint8Array(10 * 1024 * 1024 + 1);
    const arrayBufferOnlyFetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: (name) => (name === "content-length" ? String(bigPayload.byteLength) : null) },
      arrayBuffer: async () => bigPayload.buffer,
    });
    arrayBufferOnlyFetch.calls = rest.calls;
    const mcp = makeMcpFactory();
    const adapter = makeAdapter({
      rest: { calls: rest.calls, fetch: arrayBufferOnlyFetch },
      mcp,
      notices: makeNotices().notice,
    });
    await assert.rejects(
      adapter.vision.invoke({
        operation: "extract-text",
        source: "https://example.test/shot.png",
        instruction: "x",
      }),
      (error) => error instanceof ValidationError,
    );
    assert.strictEqual(mcp.created.length, 0);
  });

  it("arrayBuffer-only double under the cap still prefetches (fallback preserves the seam contract)", async () => {
    const payload = new Uint8Array([1, 2, 3, 4]);
    // Call 1: layout_parsing 422 (fallback-eligible). Call 2: the
    // prefetch response — arrayBuffer-only legacy shape, under the
    // 10MB cap. Call 3: the retried layout_parsing, JSON md_results.
    let call = 0;
    const arrayBufferOnlyFetch = async () => {
      call += 1;
      if (call === 1) return jsonResponse({ error: { code: "1210" } }, 422);
      if (call === 2) {
        return {
          ok: true,
          status: 200,
          headers: { get: (name) => (name === "content-length" ? String(payload.byteLength) : null) },
          arrayBuffer: async () => payload.buffer,
        };
      }
      return jsonResponse({ md_results: "recovered via base64" });
    };
    const mcp = makeMcpFactory();
    const adapter = makeAdapter({
      rest: { calls: [], fetch: arrayBufferOnlyFetch },
      mcp,
      notices: makeNotices().notice,
    });
    const result = await adapter.vision.invoke({
      operation: "extract-text",
      source: "https://example.test/shot.png",
      instruction: "x",
    });
    assert.strictEqual(result, "recovered via base64");
  });

  it("response with NEITHER body NOR arrayBuffer is a loud transport error, never silent-empty", async () => {
    const rest = makeLayoutRest();
    rest.set(() => jsonResponse({ error: { code: "1210" } }, 422));
    const hollowFetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
    });
    hollowFetch.calls = rest.calls;
    const mcp = makeMcpFactory();
    const adapter = makeAdapter({
      rest: { calls: rest.calls, fetch: hollowFetch },
      mcp,
      notices: makeNotices().notice,
    });
    await assert.rejects(
      adapter.vision.invoke({
        operation: "extract-text",
        source: "https://example.test/shot.png",
        instruction: "x",
      }),
      (error) => error instanceof NetworkError && /no (readable )?body/.test(error.message),
    );
    assert.strictEqual(mcp.created.length, 0);
  });

  it("an unexpected reader failure keeps its own identity (not remapped to 422)", async () => {
    const rest = makeLayoutRest();
    rest.set(() => jsonResponse({ error: { code: "1210" } }, 422));
    const readerBugFetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: new ReadableStream({
        pull(controller) {
          controller.error(new TypeError("reader implementation bug"));
        },
      }),
      arrayBuffer: async () => {
        throw new Error("arrayBuffer must not be reached when body exists");
      },
    });
    readerBugFetch.calls = rest.calls;
    const mcp = makeMcpFactory();
    const adapter = makeAdapter({
      rest: { calls: rest.calls, fetch: readerBugFetch },
      mcp,
      notices: makeNotices().notice,
    });
    await assert.rejects(
      adapter.vision.invoke({
        operation: "extract-text",
        source: "https://example.test/shot.png",
        instruction: "x",
      }),
      (error) => error instanceof TypeError && /reader implementation bug/.test(error.message),
    );
    assert.strictEqual(mcp.created.length, 0);
  });
});

describe("glm-ocr T2 — off-wire controls (D6)", () => {
  it("--language on the OCR arm → warn-and-strip notice; wire body carries no language", async () => {
    const rest = makeLayoutRest();
    rest.set(() => jsonResponse({ md_results: "x" }));
    const notices = makeNotices();
    const adapter = makeAdapter({ rest, mcp: makeMcpFactory(), notices });
    await adapter.vision.invoke({
      operation: "extract-text",
      source: "https://example.test/a.png",
      instruction: "Extract all text from this image.",
      programmingLanguage: "rust",
    });
    assert.deepStrictEqual(notices.lines, [LANGUAGE_STRIP_NOTICE]);
    const body = JSON.parse(rest.calls[0].body);
    assert.deepStrictEqual(Object.keys(body).sort(), ["file", "model"]);
  });

  it("custom prompt on the OCR arm → warn-and-strip notice", async () => {
    const rest = makeLayoutRest();
    rest.set(() => jsonResponse({ md_results: "x" }));
    const notices = makeNotices();
    const adapter = makeAdapter({ rest, mcp: makeMcpFactory(), notices });
    await adapter.vision.invoke({
      operation: "extract-text",
      source: "https://example.test/a.png",
      instruction: "ONLY the code blocks please",
    });
    assert.deepStrictEqual(notices.lines, [PROMPT_STRIP_NOTICE]);
    const body = JSON.parse(rest.calls[0].body);
    assert.deepStrictEqual(Object.keys(body).sort(), ["file", "model"]);
  });

  it("both controls together → both notices, in order", async () => {
    const rest = makeLayoutRest();
    rest.set(() => jsonResponse({ md_results: "x" }));
    const notices = makeNotices();
    const adapter = makeAdapter({ rest, mcp: makeMcpFactory(), notices });
    await adapter.vision.invoke({
      operation: "extract-text",
      source: "https://example.test/a.png",
      instruction: "custom prompt",
      programmingLanguage: "python",
    });
    assert.deepStrictEqual(notices.lines, [LANGUAGE_STRIP_NOTICE, PROMPT_STRIP_NOTICE]);
  });

  it("the fallback arm honors --language and custom prompt verbatim (pre-lane semantics)", async () => {
    const rest = makeLayoutRest();
    rest.set(() => jsonResponse({ error: { code: 1113 } }));
    const mcp = makeMcpFactory();
    const notices = makeNotices();
    const adapter = makeAdapter({ rest, mcp, notices });
    await adapter.vision.invoke({
      operation: "extract-text",
      source: "https://example.test/a.png",
      instruction: "custom prompt on fallback",
      programmingLanguage: "go",
    });
    // Strip notices fired on the OCR arm before the 1113; the fallback
    // arm itself adds nothing beyond the fallback notice.
    assert.deepStrictEqual(notices.lines, [
      LANGUAGE_STRIP_NOTICE,
      PROMPT_STRIP_NOTICE,
      FALLBACK_NOTICE,
    ]);
    assert.deepStrictEqual(mcp.calls[0].args, {
      image_source: "https://example.test/a.png",
      prompt: "custom prompt on fallback",
      programming_language: "go",
    });
  });
});

describe("glm-ocr T2 — non-interference dispatch pins", () => {
  it("analyze routes to the MCP tool unchanged; no layout_parsing call", async () => {
    const rest = makeLayoutRest();
    const mcp = makeMcpFactory();
    const adapter = makeAdapter({ rest, mcp, notices: makeNotices().notice });
    const result = await adapter.vision.invoke({
      operation: "interpret-image",
      source: "https://example.test/a.png",
      instruction: "describe",
    });
    assert.strictEqual(result, "mcp text result");
    assert.strictEqual(rest.calls.length, 0);
    assert.strictEqual(mcp.calls[0].name, ANALYZE_TOOL);
    assert.deepStrictEqual(mcp.calls[0].args, {
      image_source: "https://example.test/a.png",
      prompt: "describe",
    });
  });

  it("diagram routes to the MCP tool unchanged; no layout_parsing call", async () => {
    const rest = makeLayoutRest();
    const mcp = makeMcpFactory();
    const adapter = makeAdapter({ rest, mcp, notices: makeNotices().notice });
    await adapter.vision.invoke({
      operation: "diagram",
      source: "https://example.test/a.png",
      instruction: "explain",
      diagramType: "sequence",
    });
    assert.strictEqual(rest.calls.length, 0);
    assert.strictEqual(mcp.calls[0].name, DIAGRAM_TOOL);
    assert.deepStrictEqual(mcp.calls[0].args, {
      image_source: "https://example.test/a.png",
      prompt: "explain",
      diagram_type: "sequence",
    });
  });

  it("every non-extract-text operation maps to the same MCP tool + args as pre-lane (regression shape)", async () => {
    const rest = makeLayoutRest();
    const mcp = makeMcpFactory();
    const adapter = makeAdapter({ rest, mcp, notices: makeNotices().notice });
    const img = "https://example.test/a.png";
    const requests = [
      [{ operation: "ui-artifact", source: img, instruction: "p", outputType: "spec" }, getMcpToolName("vision", "ui_to_artifact"), { image_source: img, output_type: "spec", prompt: "p" }],
      [{ operation: "diagnose-error", source: img, instruction: "p", context: "ctx" }, getMcpToolName("vision", "diagnose_error_screenshot"), { image_source: img, prompt: "p", context: "ctx" }],
      [{ operation: "chart", source: img, instruction: "p", focus: "left" }, getMcpToolName("vision", "analyze_data_visualization"), { image_source: img, prompt: "p", analysis_focus: "left" }],
    ];
    for (const [request, tool, args] of requests) {
      await adapter.vision.invoke(request);
    }
    assert.strictEqual(rest.calls.length, 0, "no operation other than extract-text touches layout_parsing");
    assert.deepStrictEqual(
      mcp.calls.map((c) => c.name),
      requests.map(([, tool]) => tool),
    );
    for (let i = 0; i < requests.length; i += 1) {
      assert.deepStrictEqual(mcp.calls[i].args, requests[i][2]);
    }
  });
});
