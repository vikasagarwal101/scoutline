/**
 * Live MCP integration tests (opt-in).
 *
 * Enable with:
 *   ZAI_LIVE_TESTS=1 Z_AI_API_KEY=... node --test tests/mcp-live.test.js
 *
 * Optional:
 *   ZAI_TEST_ENABLE_VISION=1  (requires Node >= 22 and vision MCP deps)
 *   ZAI_TEST_IMAGE_SOURCE=/path/to/image.png (override generated pixel image)
 *   ZAI_TEST_REPO=owner/repo
 *   ZAI_TEST_REPO_FILE=README.md
 *   ZAI_TEST_REPO_DIR=path/inside/repo
 *   ZAI_TEST_VIDEO_SOURCE=/path/to/video.mp4 (or URL)
 *
 * P0-03 splits the test names so tool discovery, Normal Search, and raw
 * mapped coverage each have distinct intent:
 *   - "discovers tools and validates tool schemas" — UTCP discovery.
 *   - "includes expected core tools" — discovery presence assertions.
 *   - "Normal Search via webSearch returns a Z.AI result array" — P2-03
 *     regression (rewritten from the P0-03 "defect exists" baseline in
 *     0.6.1 after the callToolWithPublicCacheIdentity fix landed for
 *     webSearch).
 *   - "calls every discovered tool via mapped raw names (Z.AI transport
 *     check)" — raw mapped coverage as a Z.AI transport check.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { ToolSchema } from "@utcp/sdk";
import { ZaiMcpClient } from "../dist/lib/mcp-client.js";
import { getMcpToolName } from "../dist/lib/mcp-config.js";
import { loadMiniMaxConfig } from "../dist/providers/minimax/config.js";
import { convertToDataUri } from "../dist/providers/minimax/media.js";
import {
  fetchMiniMaxSearch,
  fetchMiniMaxVlm,
} from "../dist/providers/minimax/coding-plan-client.js";

const apiKey = process.env.Z_AI_API_KEY || process.env.ZAI_API_KEY;
const runLive = process.env.ZAI_LIVE_TESTS === "1" && Boolean(apiKey);
const enableVision = process.env.ZAI_TEST_ENABLE_VISION === "1";
const nodeMajor = Number(process.versions.node.split(".")[0] || 0);

// ---------------------------------------------------------------------------
// C2 — Layer T4 envelope-parity gate (critique D1 + L3)
//
// Requires BOTH ZAI_LIVE_TESTS=1 AND a non-empty MINIMAX_API_KEY. The
// runner's offline mode clears ZAI_LIVE_TESTS, so this block reports as
// skipped (not failed) when the suite is run via `npm test`. Live users
// opt in explicitly per ticket: `ZAI_LIVE_TESTS=1 MINIMAX_API_KEY=…`.
// ---------------------------------------------------------------------------
const miniMaxKey = process.env.MINIMAX_API_KEY || "";
const runMiniMaxLive = process.env.ZAI_LIVE_TESTS === "1" && miniMaxKey.length > 0;
const describeMiniMaxLive = runMiniMaxLive ? describe : describe.skip;

const describeLive = runLive ? describe : describe.skip;

describeLive("MCP Live Tests", () => {
  let client;
  let tools = [];
  let tempDir;
  let imagePath;

  before(async () => {
    client = new ZaiMcpClient({ enableVision });
    tools = await client.listTools();

    const providedImage = process.env.ZAI_TEST_IMAGE_SOURCE;
    if (providedImage) {
      await fs.access(providedImage);
      imagePath = providedImage;
    } else {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "scoutline-"));
      imagePath = path.join(tempDir, "pixel.png");
      const pngBase64 =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAEElEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==";
      await fs.writeFile(imagePath, Buffer.from(pngBase64, "base64"));
    }
  });

  after(async () => {
    if (client) {
      await client.close().catch(() => {});
    }
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("discovers tools and validates tool schemas", () => {
    assert.ok(Array.isArray(tools) && tools.length > 0, "expected tools to be discovered");
    for (const tool of tools) {
      ToolSchema.parse(tool);
      assert.ok(tool.name, "tool has name");
      assert.ok(tool.inputs, "tool has inputs");
      assert.ok(tool.outputs, "tool has outputs");
    }
  });

  it("includes expected core tools", () => {
    const expected = [
      getMcpToolName("search", "web_search_prime"),
      getMcpToolName("reader", "webReader"),
      getMcpToolName("zread", "search_doc"),
      getMcpToolName("zread", "get_repo_structure"),
      getMcpToolName("zread", "read_file"),
    ];

    for (const name of expected) {
      assert.ok(
        tools.some((tool) => tool.name === name),
        `expected tool not found: ${name}`,
      );
    }

    if (enableVision && nodeMajor >= 22) {
      const visionExpected = [
        getMcpToolName("vision", "analyze_image"),
        getMcpToolName("vision", "ui_to_artifact"),
        getMcpToolName("vision", "extract_text_from_screenshot"),
        getMcpToolName("vision", "diagnose_error_screenshot"),
        getMcpToolName("vision", "understand_technical_diagram"),
        getMcpToolName("vision", "analyze_data_visualization"),
        getMcpToolName("vision", "ui_diff_check"),
        getMcpToolName("vision", "analyze_video"),
      ];

      for (const name of visionExpected) {
        assert.ok(
          tools.some((tool) => tool.name === name),
          `expected vision tool not found: ${name}`,
        );
      }
    }
  });

  it("Normal Search via webSearch returns a Z.AI result array (P2-03 regression)", async () => {
    // P2-03 regression test (rewritten from the P0-03 "defect exists"
    // baseline in 0.6.1). webSearch must SUCCEED when called via the
    // public dotted operation name. Before the 0.6.1 fix, `webSearch`
    // routed through the unresolving `callTool` path; the public name
    // `scoutline.zai.search.web_search_prime` was forwarded verbatim to
    // UTCP, which only knew the sanitized internal identity
    // `scoutline_zai.search.web_search_prime`, so the call failed with
    // a generic "MCP tool call failed". The fix routes webSearch
    // through `callToolWithPublicCacheIdentity`, which resolves the
    // public name to the internal UTCP identity on a cache miss.
    //
    // Unique query guarantees an empty response cache so the call must
    // hit UTCP and exercise the public→internal name resolution path.
    // We assert the call succeeds and returns an array; we do NOT
    // assert non-empty results because Z.AI's search index is
    // non-deterministic for one-shot unique queries.
    const query = `scoutline-mcp-translation-${Date.now()}`;
    const results = await client.webSearch({
      query,
      count: 1,
      recencyFilter: "noLimit",
      contentSize: "medium",
    });
    assert.ok(Array.isArray(results), `webSearch must return an array, got: ${typeof results}`);
  });

  it("calls every discovered tool via mapped raw names (Z.AI transport check)", async () => {
    const repo = process.env.ZAI_TEST_REPO || "vikasagarwal101/scoutline";
    const repoFile = process.env.ZAI_TEST_REPO_FILE || "README.md";
    const repoDir = process.env.ZAI_TEST_REPO_DIR;
    const basePrompt = "Test prompt";

    const handlers = new Map();

    handlers.set(getMcpToolName("search", "web_search_prime"), async () =>
      client.callToolRaw(getMcpToolName("search", "web_search_prime"), {
        search_query: "hello world",
        search_recency_filter: "oneMonth",
        content_size: "medium",
        location: "us",
      }),
    );

    handlers.set(getMcpToolName("reader", "webReader"), async () =>
      client.callToolRaw(getMcpToolName("reader", "webReader"), {
        url: "https://example.com",
        return_format: "text",
        no_gfm: true,
        keep_img_data_url: false,
        with_images_summary: false,
        with_links_summary: true,
      }),
    );

    handlers.set(getMcpToolName("zread", "search_doc"), async () =>
      client.callToolRaw(getMcpToolName("zread", "search_doc"), {
        repo_name: repo,
        query: "config",
        language: "en",
      }),
    );

    handlers.set(getMcpToolName("zread", "get_repo_structure"), async () => {
      const args = { repo_name: repo };
      if (repoDir) {
        args.dir_path = repoDir;
      }
      return client.callToolRaw(getMcpToolName("zread", "get_repo_structure"), args);
    });

    handlers.set(getMcpToolName("zread", "read_file"), async () =>
      client.callToolRaw(getMcpToolName("zread", "read_file"), {
        repo_name: repo,
        file_path: repoFile,
      }),
    );

    if (enableVision) {
      if (nodeMajor < 22) {
        throw new Error("Vision MCP requires Node >= 22");
      }

      handlers.set(getMcpToolName("vision", "analyze_image"), async () =>
        client.callToolRaw(getMcpToolName("vision", "analyze_image"), {
          image_source: imagePath,
          prompt: basePrompt,
        }),
      );

      handlers.set(getMcpToolName("vision", "ui_to_artifact"), async () =>
        client.callToolRaw(getMcpToolName("vision", "ui_to_artifact"), {
          image_source: imagePath,
          prompt: basePrompt,
          output_type: "code",
        }),
      );

      handlers.set(getMcpToolName("vision", "extract_text_from_screenshot"), async () =>
        client.callToolRaw(getMcpToolName("vision", "extract_text_from_screenshot"), {
          image_source: imagePath,
          prompt: basePrompt,
          programming_language: "python",
        }),
      );

      handlers.set(getMcpToolName("vision", "diagnose_error_screenshot"), async () =>
        client.callToolRaw(getMcpToolName("vision", "diagnose_error_screenshot"), {
          image_source: imagePath,
          prompt: basePrompt,
          context: "during npm install",
        }),
      );

      handlers.set(getMcpToolName("vision", "understand_technical_diagram"), async () =>
        client.callToolRaw(getMcpToolName("vision", "understand_technical_diagram"), {
          image_source: imagePath,
          prompt: basePrompt,
          diagram_type: "architecture",
        }),
      );

      handlers.set(getMcpToolName("vision", "analyze_data_visualization"), async () =>
        client.callToolRaw(getMcpToolName("vision", "analyze_data_visualization"), {
          image_source: imagePath,
          prompt: basePrompt,
          analysis_focus: "trend",
        }),
      );

      handlers.set(getMcpToolName("vision", "ui_diff_check"), async () =>
        client.callToolRaw(getMcpToolName("vision", "ui_diff_check"), {
          expected_image_source: imagePath,
          actual_image_source: imagePath,
          prompt: basePrompt,
        }),
      );

      const videoSource = process.env.ZAI_TEST_VIDEO_SOURCE;
      handlers.set(getMcpToolName("vision", "analyze_video"), async () => {
        if (!videoSource) {
          return "skipped: no video source";
        }
        return client.callToolRaw(getMcpToolName("vision", "analyze_video"), {
          video_source: videoSource,
          prompt: basePrompt,
        });
      });
    }

    const missing = tools.map((tool) => tool.name).filter((name) => !handlers.has(name));
    assert.strictEqual(missing.length, 0, `Missing test handlers for tools: ${missing.join(", ")}`);

    for (const tool of tools) {
      const handler = handlers.get(tool.name);
      const result = await handler();
      assert.ok(result !== undefined, `tool returned undefined: ${tool.name}`);
    }
  });
});

// ---------------------------------------------------------------------------
// C2 — Layer T4 envelope-parity fixture (critique D1 + L3).
//
// Goal: prove that the direct transport (which sets
// `MM-API-Source: Scoutline` and `User-Agent: scoutline/<version>` on every
// request) yields a response envelope byte-equivalent to the legacy
// `mmx-cli/sdk` path. If MiniMax echoes any of those headers into the
// response body, attributes traffic to a different rate-limit bucket, or
// surfaces them in error payloads, this fixture fails with a clear diff
// from `assert.deepStrictEqual`. Drift is a contract amendment, not a
// silent pass.
//
// Skips cleanly when ZAI_LIVE_TESTS is unset or MINIMAX_API_KEY is empty
// (offline mode is the default — see scripts/run-tests.mjs).
//
// The `mmx-cli/sdk` import is intentionally lazy: it lives behind
// describeMiniMaxLive and uses dynamic `import()` so the OFFLINE suite
// never attempts to load the SDK module.
// ---------------------------------------------------------------------------

/**
 * Construct a `MiniMaxSDK` instance for the legacy comparison path with
 * the same `MMX_CONFIG_DIR` sentinel pattern the deleted `sdk-client.ts`
 * used. The SDK reads its config directory synchronously during
 * construction; pointing `MMX_CONFIG_DIR` at a unique nonexistent path
 * suppresses any read of the user's real `~/.mmx` state. The temporary
 * directory is never created on disk and the original env is restored in
 * `finally`.
 */
async function buildLegacySdk(apiKey) {
  const hadPrev = Object.prototype.hasOwnProperty.call(process.env, "MMX_CONFIG_DIR");
  const prev = process.env.MMX_CONFIG_DIR;
  const temporaryDir = path.join(os.tmpdir(), `scoutline-c2-${randomUUID()}`);
  process.env.MMX_CONFIG_DIR = temporaryDir;
  try {
    const mod = await import("mmx-cli/sdk");
    const Ctor = mod.MiniMaxSDK;
    return new Ctor({ apiKey, region: "global", baseUrl: "https://api.minimax.io" });
  } finally {
    if (hadPrev) {
      process.env.MMX_CONFIG_DIR = prev;
    } else {
      delete process.env.MMX_CONFIG_DIR;
    }
  }
}

describeMiniMaxLive("Direct transport envelope parity (D1/L3)", () => {
  // C1 baseline: 1653 offline tests; the live layer adds 0 when skipped
  // and 2 when opted in (search + vlm parity). Drift is recorded as a
  // test failure; it never auto-passes.
  //
  // The original C2 design used `assert.deepStrictEqual(direct, legacy)`
  // to compare SDK-vs-direct response bodies byte-for-byte. That design
  // is wrong: MiniMax's API is non-deterministic across consecutive
  // calls (search returns different organic results as the index shifts;
  // VLM produces different prose for the same prompt). Byte-equality
  // can never hold against a non-deterministic API, regardless of
  // transport.
  //
  // The actual critique D1/L3 concern is narrower: does MiniMax echo
  // our request headers (`MM-API-Source: Scoutline`,
  // `User-Agent: scoutline/<version>`) into the response body? The
  // legacy SDK sends `MM-API-Source: Minimax-MCP` + `mmx-cli/<version>`;
  // direct transport sends `Scoutline` + `scoutline/<version>`. If
  // MiniMax echoes either value into a response field, the two
  // transports would produce observably different bodies for that
  // reason alone. The assertions below check exactly that — and the
  // structural shape contract — without coupling to API
  // non-determinism.
  let tempImagePath;
  let cleanupImage = false;

  before(async () => {
    const providedImage = process.env.ZAI_TEST_IMAGE_SOURCE;
    if (providedImage) {
      await fs.access(providedImage);
      tempImagePath = providedImage;
    } else {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "scoutline-c2-"));
      tempImagePath = path.join(tempDir, "general.png");
      // Reuse the repository-owned general vision fixture (a real 64x64
      // RGB PNG, ~140 bytes) so the bytes are stable across runs.
      const __dirname = path.dirname(fileURLToPath(import.meta.url));
      const fixturePath = path.join(__dirname, "fixtures", "vision", "general.png");
      const bytes = await fs.readFile(fixturePath);
      await fs.writeFile(tempImagePath, bytes);
      cleanupImage = true;
    }
  });

  after(async () => {
    if (cleanupImage && tempImagePath) {
      await fs.rm(path.dirname(tempImagePath), { recursive: true, force: true });
    }
  });

  // Critique D1/L3: MiniMax must NOT echo our request headers into
  // the response body. The two transports send different header values
  // (`MM-API-Source`, `User-Agent`); if MiniMax echoed either, the
  // response body would carry our identifying strings. This walk
  // catches that case directly, instead of relying on cross-call
  // byte-equality (which the API's non-determinism makes impossible).
  function assertNoHeaderEcho(label, value) {
    const visit = (node, path) => {
      if (node === null || typeof node !== "object") {
        if (typeof node === "string") {
          // Header values the direct transport sends.
          assert.ok(
            !/^Scoutline$/i.test(node) && !/^scoutline\//i.test(node),
            `${label}: response string at ${path} matches a direct-transport header value (${JSON.stringify(node)}), indicating MiniMax echoed the request header`,
          );
        }
        return;
      }
      if (Array.isArray(node)) {
        node.forEach((item, i) => visit(item, `${path}[${i}]`));
        return;
      }
      for (const key of Object.keys(node)) {
        // Header field names the direct transport sends.
        assert.ok(
          !/^mm-api-source$/i.test(key) && !/^user-agent$/i.test(key),
          `${label}: response object at ${path} has a header-shaped key "${key}", indicating MiniMax echoed the request header`,
        );
        visit(node[key], `${path}.${key}`);
      }
    };
    visit(value, "<root>");
  }

  it("search parity: direct transport body shape matches legacy SDK; no header echo", async () => {
    const config = loadMiniMaxConfig({ ...process.env, MINIMAX_API_KEY: miniMaxKey });
    const query = `scoutline-c2-t4-search-${Date.now()}`;

    const direct = await fetchMiniMaxSearch(config, query);
    const legacy = await buildLegacySdk(miniMaxKey).then((sdk) => sdk.search.query(query));

    // Structural shape: both transports must return the documented
    // success envelope (`organic` array, optional `related_searches`
    // array, `base_resp` with `status_code: 0`). Field VALUES are not
    // compared — MiniMax's search index is non-deterministic across
    // calls, so the same query produces different organic results.
    for (const [label, body] of [
      ["direct", direct],
      ["legacy", legacy],
    ]) {
      assert.ok(Array.isArray(body.organic), `${label}.organic must be an array`);
      assert.ok(body.organic.length > 0, `${label}.organic must be non-empty`);
      for (const entry of body.organic) {
        assert.strictEqual(
          typeof entry.title,
          "string",
          `${label}.organic[].title must be a string`,
        );
        assert.strictEqual(typeof entry.link, "string", `${label}.organic[].link must be a string`);
        assert.strictEqual(
          typeof entry.snippet,
          "string",
          `${label}.organic[].snippet must be a string`,
        );
      }
      assert.ok(body.base_resp, `${label}.base_resp must be present`);
      assert.strictEqual(body.base_resp.status_code, 0, `${label}.base_resp.status_code must be 0`);
    }

    // Critique D1/L3: neither response carries our request header
    // values. This is the actual concern — header echo would mean
    // changing `MM-API-Source` or `User-Agent` (which the plan did)
    // observably affects the response body.
    assertNoHeaderEcho("direct search body", direct);
    assertNoHeaderEcho("legacy search body", legacy);
  });

  it("vlm parity: direct transport body shape matches legacy SDK; no header echo", async () => {
    const config = loadMiniMaxConfig({ ...process.env, MINIMAX_API_KEY: miniMaxKey });
    const prompt =
      "Describe this image. Identify the dominant shape, its color, and the background color.";

    // The VLM endpoint requires a data URI; the legacy SDK's
    // `toDataUri` does the conversion at request time, and the direct
    // transport expects a pre-resolved source. Resolving ONCE here
    // ensures both transports receive byte-identical input — any
    // envelope drift after that point is a server-side decision, not
    // a client-side conversion artifact.
    const dataUri = await convertToDataUri(tempImagePath);

    const direct = await fetchMiniMaxVlm(config, dataUri, prompt);
    const legacy = await buildLegacySdk(miniMaxKey).then((sdk) =>
      sdk.vision.describe({ image: dataUri, prompt }),
    );

    // Structural shape: both transports must return the documented
    // success envelope (`content` non-empty string, `base_resp` with
    // `status_code: 0`). The `content` VALUE is not compared — VLM
    // output is non-deterministic; the same prompt produces different
    // prose on different calls.
    for (const [label, body] of [
      ["direct", direct],
      ["legacy", legacy],
    ]) {
      assert.strictEqual(typeof body.content, "string", `${label}.content must be a string`);
      assert.ok(body.content.trim().length > 0, `${label}.content must be non-empty`);
      assert.ok(body.base_resp, `${label}.base_resp must be present`);
      assert.strictEqual(body.base_resp.status_code, 0, `${label}.base_resp.status_code must be 0`);
    }

    // Critique D1/L3: neither response carries our request header
    // values. Same concern as the search test — header echo would
    // make changing `MM-API-Source` or `User-Agent` observable.
    assertNoHeaderEcho("direct vlm body", direct);
    assertNoHeaderEcho("legacy vlm body", legacy);
  });
});
