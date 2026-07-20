/**
 * Reader Migration 05 — Cross-Adapter Reader Conformance (DESIGN.md §18,
 * §11; reader-migration-tech-plan ticket 05; applicable NFR-001–NFR-010).
 *
 * Purpose
 *   Prove the Reader Capability seam holds for a second Adapter by
 *   extending the existing fake-Adapter harness with a Reader capability
 *   and adding a cross-Adapter byte-parity matrix. Parallel to P6-08
 *   (compressed: no separate injected-key defect fix unless the matrix
 *   surfaces one).
 *
 * Coverage map (acceptance criteria from ticket 05)
 *   1. Cross-Adapter byte-parity matrix — content read × extract read ×
 *      {data, json, pretty, compact} × {Z.AI, fake}. Z.AI fed a raw
 *      WebReader object fixture vs. the fake fed the structured
 *      expected result; outward stdout is byte-identical and matches
 *      the exact expected public value.
 *   2. Real Z.AI alias matrix through the real Adapter: `ZAI_API_KEY`
 *      alias-only and `Z_AI_API_KEY`-over-`ZAI_API_KEY` precedence.
 *   3. Legacy-cache continuity through the REAL Z.AI Adapter: valid
 *      primary candidate read-through (zero transports, normalized key
 *      written once, legacy file preserved); `--no-cache` skips reads
 *      and writes; raw legacy data never crosses the public Interface.
 *   4. Integrated retry/lifecycle: cache hit constructs/closes zero
 *      transports; each uncached retry constructs a fresh transport
 *      (transport count == attempt count); close rejection never
 *      replaces success nor masks the primary failure; close timeout
 *      bounded. Per-port `closeEntered` vs `fake.closeCount` evidence.
 *   5. Exact encoded-error fixtures through the real Adapter: terminal
 *      exhausted quota (1310); terminal 401/403/other 4xx; one retry
 *      for transient 429, 5xx, malformed 502 (DESIGN.md §18 encoded
 *      MCP error taxonomy).
 *   6. Real dispatcher selection-order: default Z.AI success; explicit
 *      `--provider zai` wins over `SCOUTLINE_PROVIDER=minimax`;
 *      MiniMax UNSUPPORTED_CAPABILITY with zero cache/descriptor/
 *      operation work.
 *   7. Deterministic sleep/random injection (P6-08A pattern): readerSleep
 *      (no-op) and readerRandom (constant zero) so retryable malformed-
 *      response cases perform no real wall-clock backoff or jitter.
 *
 * Boundary
 *   The conformance tests import the REAL Z.AI Adapter, shared
 *   execution, the static production registry, the REAL dispatcher
 *   (`main`), the cache key builder, and the Ticket 05 fake Adapter
 *   helper. They never touch a network or a real credential. They do
 *   not edit production code.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { main } from "../dist/index.js";
import { createZaiDescriptor } from "../dist/providers/zai/adapter.js";
import { createMiniMaxDescriptor } from "../dist/providers/minimax/adapter.js";
import { getMcpToolName } from "../dist/lib/mcp-config.js";
import { buildLegacyReaderCacheKey, buildProviderCacheKey } from "../dist/lib/cache.js";
import { executeReaderOperation } from "../dist/lib/execution.js";
import {
  ApiError,
  AuthError,
  QuotaError,
  ScoutlineError,
  TimeoutError,
} from "../dist/lib/errors.js";
import { ZAI_READER_CLOSE_BOUND_MS } from "../dist/providers/zai/reader.js";
import { FakeUtcpClient } from "./helpers/fake-utcp-client.js";
import { createFakeReaderCapability, createFakeReaderDescriptor } from "./helpers/fake-adapter.js";

// ---------------------------------------------------------------------------
// Offline hermeticity: clear ambient Provider credentials so a developer
// shell with Z_AI_API_KEY set cannot leak into these tests. Every Adapter
// in this suite is fake or wired to a FakeUtcpClient.
// ---------------------------------------------------------------------------

const PROVIDER_ENV_VARS = ["Z_AI_API_KEY", "ZAI_API_KEY", "MINIMAX_API_KEY", "SCOUTLINE_PROVIDER"];
const savedProviderEnv = {};
before(() => {
  for (const key of PROVIDER_ENV_VARS) {
    savedProviderEnv[key] = process.env[key];
    delete process.env[key];
  }
});
after(() => {
  for (const key of PROVIDER_ENV_VARS) {
    const saved = savedProviderEnv[key];
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
});

// ---------------------------------------------------------------------------
// Constants and fixtures
// ---------------------------------------------------------------------------

const READER_TOOL_PUBLIC_NAME = getMcpToolName("reader", "webReader");
const INTERNAL_WEB_READER = "scoutline_zai.reader.webReader";

const DISCOVERED_READER_TOOLS = [
  {
    name: INTERNAL_WEB_READER,
    inputs: {
      type: "object",
      properties: {
        url: { type: "string" },
        timeout: { type: "number" },
        no_cache: { type: "boolean" },
        return_format: { type: "string", enum: ["markdown", "text"] },
        retain_images: { type: "boolean" },
        with_links_summary: { type: "boolean" },
        no_gfm: { type: "boolean" },
        keep_img_data_url: { type: "boolean" },
        with_images_summary: { type: "boolean" },
      },
      required: ["url"],
    },
    outputs: { type: "object" },
  },
];

const TEST_API_KEY = "test-zai-api-key-DO-NOT-LEAK";
const EXPECTED_FINGERPRINT = crypto.createHash("sha256").update(TEST_API_KEY).digest("hex");

// ---------------------------------------------------------------------------
// Controlled raw WebReader object fixture (synthesized from the
// characterization artifact's example.com probe, sanitized). This is the
// raw shape the Z.AI Adapter's total parser consumes.
// ---------------------------------------------------------------------------

function validRawResponse(overrides = {}) {
  return {
    title: "Example Domain",
    url: "https://example.com/",
    content: "# Example\n\nThis is the page body.",
    metadata: { viewport: "width=device-width", lang: "en" },
    external: { icon: { href: "/favicon.ico" } },
    ...overrides,
  };
}

/**
 * Build the expected normalized `ReaderFetchResult` that BOTH Adapters
 * converge on. The fake is fed this structured value directly; the Z.AI
 * Adapter produces it by parsing `validRawResponse()`.
 */
function expectedFetchResult({ url = "https://example.com/" } = {}) {
  const raw = validRawResponse();
  return {
    schemaVersion: 1,
    url,
    finalUrl: url,
    title: raw.title,
    content: raw.content,
    contentFormat: "markdown",
    metadata: raw.metadata,
    external: raw.external,
  };
}

// ---------------------------------------------------------------------------
// Fake ZaiAdapterClientPort factory: counts constructed transports, can
// script per-call errors, close rejection, or close timeout.
//
// Mirrors the P6-08 / repository-conformance precedent so the close
// lifecycle evidence (closeEntered vs fake.closeCount) is structurally
// identical between the two conformance suites. Each constructed port
// carries:
//   - `closeEntered`: a counter incremented at the START of `close()`,
//     before the close resolves/rejects/hangs. This proves the close
//     path was actually entered even when the close later rejects or
//     hangs.
//   - `fake.closeCount`: the underlying FakeUtcpClient close counter,
//     incremented only on a clean close. This is the per-attempt
//     "closed exactly once" evidence used by the success and primary-
//     failure cases.
// ---------------------------------------------------------------------------

function makeClientFactory({ discoveredTools, resultsByName, errorsByName } = {}) {
  const created = [];
  const factory = (options) => {
    const fake = new FakeUtcpClient({ discoveredTools, resultsByName, errorsByName });
    const port = {
      options,
      callToolCalls: [],
      closeEntered: 0,
      async callToolRaw(name, args) {
        this.callToolCalls.push({ name, args });
        const tools = fake.discoveredTools;
        let resolved = tools.find((t) => t.name === name);
        if (!resolved && name.startsWith("scoutline.zai.")) {
          const suffix = name.slice("scoutline.zai.".length);
          const matches = tools.filter((t) => t.name.endsWith(`.${suffix}`));
          if (matches.length === 1) resolved = matches[0];
        }
        if (!resolved) throw new Error(`API_ERROR: Unknown tool ${name}`);
        return fake.callTool(resolved.name, args);
      },
      async listTools() {
        return fake.getTools();
      },
      async close() {
        this.closeEntered += 1;
        return fake.close();
      },
    };
    created.push({ options, fake, port });
    return port;
  };
  factory.created = created;
  return factory;
}

/**
 * Wrap a Z.AI clientFactory so the next-created port's `close` rejects.
 * Mirrors the repository-conformance helper. The wrapper still
 * increments `closeEntered` BEFORE rejecting so the test can prove the
 * close path was entered.
 */
function withCloseRejection(factory) {
  const wrapper = (options) => {
    const port = factory(options);
    port.close = async () => {
      port.closeEntered += 1;
      throw new Error("close rejected (test)");
    };
    return port;
  };
  wrapper.created = factory.created;
  return wrapper;
}

/**
 * Wrap a Z.AI clientFactory so the next-created port's `close` never
 * resolves. Mirrors the repository-conformance helper. The wrapper
 * still increments `closeEntered` BEFORE hanging so the test can prove
 * the close path was entered.
 */
function withCloseHang(factory) {
  const wrapper = (options) => {
    const port = factory(options);
    port.close = () => {
      port.closeEntered += 1;
      return new Promise(() => {});
    };
    return port;
  };
  wrapper.created = factory.created;
  return wrapper;
}

// ---------------------------------------------------------------------------
// Recording ResponseCache for the legacy matrix and write-back proofs.
// ---------------------------------------------------------------------------

function makeRecordingCache(seed = {}) {
  const store = new Map(seed instanceof Map ? Array.from(seed.entries()) : Object.entries(seed));
  const gets = [];
  const sets = [];
  const cache = {
    gets,
    sets,
    store,
    async get(key) {
      gets.push(key);
      return store.has(key) ? store.get(key) : null;
    },
    async set(key, value) {
      sets.push({ key, value });
      store.set(key, value);
    },
  };
  return cache;
}

function makeDeps(cache) {
  return {
    cache,
    sleep: async () => {},
    random: () => 0,
  };
}

/**
 * Compose the standard Z.AI Adapter through `createZaiDescriptor` so the
 * production descriptor path is exercised end-to-end. Mirrors the
 * repository-conformance helper.
 */
function makeZaiAdapter({ factory, closeTimeoutMs } = {}) {
  const adapter = createZaiDescriptor({
    clientFactory: factory,
    readerCloseTimeoutMs: closeTimeoutMs,
  }).create({ env: { Z_AI_API_KEY: TEST_API_KEY } });
  return adapter;
}

/**
 * Capture the error thrown by an async function. Fail the test if the
 * function resolves; return the error otherwise. Used everywhere an
 * `assert.rejects` matcher would obscure the captured error class.
 */
async function captureError(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  assert.fail("expected promise to reject, but it resolved");
}

// ===========================================================================
// 1. Cross-Adapter byte-parity matrix
//
// The Z.AI Adapter is fed a CONTROLLED raw WebReader object through
// FakeUtcpClient; the fake Adapter is fed the corresponding structured
// expected result. Both Adapters are driven through the same
// `executeReaderOperation`. The normalized outputs MUST be byte-identical.
//
// Using controlled raw fixtures (rather than sanitized evidence files)
// keeps the expected normalized value trivial and unambiguous — the
// purpose of THIS block is cross-Adapter shape identity, not parser
// totality (which is covered by `zai-reader-adapter.test.js`).
// ===========================================================================

describe("05 cross-Adapter normalized equivalence (Reader)", () => {
  it("Fetch: Z.AI raw object and fake structured produce the same normalized result", async () => {
    const expected = expectedFetchResult();

    const zaiFactory = makeClientFactory({
      discoveredTools: DISCOVERED_READER_TOOLS,
      resultsByName: { [INTERNAL_WEB_READER]: validRawResponse() },
    });
    const zaiAdapter = makeZaiAdapter({ factory: zaiFactory });
    const zaiResult = await executeReaderOperation(
      zaiAdapter.reader.fetch,
      { url: "https://example.com/" },
      { noCache: true },
      makeDeps(makeRecordingCache()),
    );

    const { capability: fakeCap } = createFakeReaderCapability({
      apiKey: TEST_API_KEY,
      provider: "zai",
      fetch: { result: expected },
    });
    const fakeResult = await executeReaderOperation(
      fakeCap.fetch,
      { url: "https://example.com/" },
      { noCache: true },
      makeDeps(makeRecordingCache()),
    );

    assert.deepStrictEqual(zaiResult, expected);
    assert.deepStrictEqual(fakeResult, expected);
    assert.deepStrictEqual(zaiResult, fakeResult);
  });

  it("normalized outputs carry no Provider-only fields (no raw description leaks)", async () => {
    // The v1 envelope drops `description`. A raw WebReader response that
    // includes `description` must not leak it through either Adapter.
    const expected = expectedFetchResult();

    const zaiFactory = makeClientFactory({
      discoveredTools: DISCOVERED_READER_TOOLS,
      resultsByName: {
        [INTERNAL_WEB_READER]: validRawResponse({ description: "should-not-leak" }),
      },
    });
    const zaiAdapter = makeZaiAdapter({ factory: zaiFactory });
    const zaiResult = await executeReaderOperation(
      zaiAdapter.reader.fetch,
      { url: "https://example.com/" },
      { noCache: true },
      makeDeps(makeRecordingCache()),
    );
    assert.deepStrictEqual(zaiResult, expected);
    assert.ok(!("description" in zaiResult));
  });

  it("fake Adapter explicit empty content cannot satisfy the contract (Reader requires non-empty content)", () => {
    // The Capability contract requires `content` to be a non-empty
    // string. The fake's `decodeCached` delegates to the shared
    // `decodeReaderFetchResult`, which rejects empty content as a miss.
    // This locks the empty-state contract for Reader: unlike Repository
    // (where `excerpts: []` is valid), Reader has no degenerate empty
    // state — a successful fetch always carries content.
    const { capability: fakeCap } = createFakeReaderCapability({
      apiKey: TEST_API_KEY,
      provider: "zai",
      fetch: {
        result: {
          schemaVersion: 1,
          url: "https://example.com/",
          finalUrl: "https://example.com/",
          title: null,
          content: "",
          contentFormat: "markdown",
        },
      },
    });
    // The cache decoder rejects empty content as a miss. The execute
    // path would then fall through to invoke, which scripts the same
    // empty result and surfaces it to the handler (where projection
    // happens). This test asserts only the decoder invariant.
    assert.strictEqual(
      fakeCap.fetch.decodeCached({
        schemaVersion: 1,
        url: "https://example.com/",
        finalUrl: "https://example.com/",
        title: null,
        content: "",
        contentFormat: "markdown",
      }),
      null,
    );
  });
});

// ===========================================================================
// 1b. Cross-Adapter dispatcher through `main()` — byte-parity matrix
//
// A fake Reader Provider Descriptor is registered under the "zai" ID
// (the production dispatcher only resolves IDs in PROVIDER_IDS). Each
// Adapter is fed inputs that normalize to the SAME structured value;
// the outward stdout is byte-identical across data/json/pretty/compact
// modes. Content reads emit the schema-version-1 envelope (or content
// string directly in text-oriented modes); extract reads emit the
// extract envelope (or JSON fallback in text-oriented modes).
// ===========================================================================

describe("05 cross-Adapter dispatcher through main() (Read content × extract × modes)", () => {
  const FIXED_NOW = 1_700_000_000_000;

  /**
   * Shared raw and structured values. The Z.AI Adapter parses
   * `sharedRawResponse()` into `sharedFetchResult()`; the fake Adapter
   * is handed `sharedFetchResult()` directly.
   */
  function sharedRawResponse() {
    return {
      title: "Shared Conformance Page",
      url: "https://example.com/conformance",
      content: "# Conformance\n\nShared reader body.",
      metadata: { lang: "en" },
      external: { icon: { href: "/favicon.ico" } },
    };
  }

  function sharedFetchResult() {
    const raw = sharedRawResponse();
    return {
      schemaVersion: 1,
      url: "https://example.com/conformance",
      finalUrl: "https://example.com/conformance",
      title: raw.title,
      content: raw.content,
      contentFormat: "markdown",
      metadata: raw.metadata,
      external: raw.external,
    };
  }

  /**
   * Build a Z.AI descriptor whose fake UTCP client serves the supplied
   * raw WebReader response for the fetch operation.
   */
  function buildZaiDescriptor({ raw }) {
    const factory = makeClientFactory({
      discoveredTools: DISCOVERED_READER_TOOLS,
      resultsByName: { [INTERNAL_WEB_READER]: raw },
    });
    return createZaiDescriptor({ clientFactory: factory });
  }

  /**
   * Build a fake reader Provider Descriptor. It is registered under the
   * `"zai"` ID because the production dispatcher only resolves IDs in
   * `PROVIDER_IDS`. This proves the dispatcher does NOT branch on
   * Provider ID — only on descriptor metadata and Adapter handles. The
   * fake remains UNADVERTISED as a real Provider (the canonical
   * `BUILT_IN_PROVIDER_DESCRIPTORS` registry is unchanged).
   */
  function buildFakeDescriptor({ result }) {
    const { descriptor } = createFakeReaderDescriptor({
      id: "fake",
      apiKey: TEST_API_KEY,
      capabilityOptions: { fetch: { result } },
    });
    return {
      id: "zai",
      isConfigured: () => true,
      capabilities: () => new Set(["reader"]),
      create: () => descriptor.create({ env: {} }),
    };
  }

  function makeRecordingAdapter(overrides = {}) {
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
      setExitCode: () => {},
      ...overrides,
    };
    return { adapter, stdout, stderr };
  }

  function makeRecordingCacheMain() {
    const store = new Map();
    const cache = {
      gets: [],
      sets: [],
      store,
      async get(key) {
        cache.gets.push(key);
        return store.has(key) ? store.get(key) : null;
      },
      async set(key, value) {
        cache.sets.push({ key, value });
        store.set(key, value);
      },
    };
    return cache;
  }

  /**
   * Run one operation+mode through main() with the given descriptor.
   * Injects deterministic sleep/random so retryable malformed-response
   * cases perform no real wall-clock backoff or jitter (P6-08A pattern).
   */
  async function runOne({ descriptor, argv, mode }) {
    const cache = makeRecordingCacheMain();
    const recorder = makeRecordingAdapter({ environmentOutputMode: undefined });
    const sleepCalls = [];
    const status = await main([...(mode === "data" ? [] : ["-O", mode]), ...argv], {
      env: { Z_AI_API_KEY: TEST_API_KEY },
      providerDescriptors: [descriptor],
      readerCache: cache,
      // Deterministic shared-execution dependencies.
      readerSleep: (ms) => {
        sleepCalls.push(ms);
        return Promise.resolve();
      },
      readerRandom: () => 0,
      // Mirror for the other execution seams (unused by read but
      // accepted by main).
      searchCache: cache,
      searchSleep: (ms) => {
        sleepCalls.push(ms);
        return Promise.resolve();
      },
      searchRandom: () => 0,
      repositoryCache: cache,
      repositorySleep: (ms) => {
        sleepCalls.push(ms);
        return Promise.resolve();
      },
      repositoryRandom: () => 0,
      invocation: recorder.adapter,
      now: () => FIXED_NOW,
    });
    return {
      status,
      stderr: recorder.stderr,
      stdout: recorder.stdout,
      cache,
      sleepCalls,
    };
  }

  /**
   * Run the SAME semantic operation through both Adapters in one mode
   * and assert: status 0, empty stderr, stdout-arrays deep-equal, and
   * the exact expected public value.
   *
   * For text-oriented modes on content reads, the handler emits the
   * `content` string directly via presentations — `stdout[0]` is NOT
   * JSON in that case. Pass `expectedRawText` to assert the literal
   * string value; otherwise the runner parses stdout as JSON and
   * compares to `expectedEnvelope(expectedData, mode)`.
   */
  async function runAndAssertBoth({ argv, mode, expectedData, expectedEnvelope, expectedRawText }) {
    const zaiResult = await runOne({
      descriptor: buildZaiDescriptor({ raw: sharedRawResponse() }),
      argv,
      mode,
    });
    const fakeResult = await runOne({
      descriptor: buildFakeDescriptor({ result: sharedFetchResult() }),
      argv,
      mode,
    });

    // Per-Adapter invariants.
    assert.strictEqual(
      zaiResult.status,
      0,
      `Z.AI status for mode ${mode}: ${zaiResult.stderr[0] || "<no stderr>"}`,
    );
    assert.strictEqual(fakeResult.status, 0, `fake status for mode ${mode}`);
    assert.deepStrictEqual(zaiResult.stderr, [], `Z.AI stderr for mode ${mode}`);
    assert.deepStrictEqual(fakeResult.stderr, [], `fake stderr for mode ${mode}`);
    assert.strictEqual(zaiResult.stdout.length, 1, `Z.AI stdout lines for mode ${mode}`);
    assert.strictEqual(fakeResult.stdout.length, 1, `fake stdout lines for mode ${mode}`);

    // Cross-Adapter byte-identical stdout.
    assert.deepStrictEqual(
      zaiResult.stdout,
      fakeResult.stdout,
      `mode ${mode}: Z.AI and fake stdout must match`,
    );

    if (expectedRawText !== undefined) {
      // Text-oriented mode emits a literal string (content
      // presentation); it is NOT JSON.
      assert.strictEqual(
        zaiResult.stdout[0],
        expectedRawText,
        `mode ${mode}: exact expected raw text`,
      );
      assert.throws(
        () => JSON.parse(zaiResult.stdout[0]),
        `mode ${mode}: text-oriented content read must not be JSON`,
      );
    } else {
      const parsed = JSON.parse(zaiResult.stdout[0]);
      const expected = expectedEnvelope(expectedData, mode);
      assert.deepStrictEqual(parsed, expected, `mode ${mode}: exact expected public value`);
    }
    return { zaiResult, fakeResult };
  }

  // -------------------------------------------------------------------------
  // Content read × {data,json,pretty,compact} × {Z.AI, fake}
  // -------------------------------------------------------------------------

  describe("Content read through main()", () => {
    const modeMatrix = ["data", "json", "pretty", "compact"];
    const fetchResult = sharedFetchResult();

    // The handler applies `--max-chars` truncation as a projection over
    // the cached content. With no `--max-chars`, the envelope carries
    // `truncated: false` and the full content length.
    function expectedContentEnvelope(content) {
      return {
        schemaVersion: 1,
        url: "https://example.com/conformance",
        finalUrl: "https://example.com/conformance",
        title: "Shared Conformance Page",
        content,
        contentFormat: "markdown",
        truncated: false,
        originalContentLength: content.length,
        metadata: { lang: "en" },
        external: { icon: { href: "/favicon.ico" } },
      };
    }

    const envelope = (data, mode) =>
      mode === "json" || mode === "pretty" ? { success: true, data, timestamp: FIXED_NOW } : data;

    for (const mode of modeMatrix) {
      it(`both Adapters produce status 0, empty stderr, and the exact expected value in ${mode} mode`, async () => {
        const expectedData = expectedContentEnvelope(fetchResult.content);
        // Compact mode on content reads emits the content string
        // directly via presentation (D4 — Reader content is naturally
        // prose). It is NOT JSON, so the matrix runner asserts the
        // literal string value instead of parsing.
        const expectedRawText = mode === "compact" ? fetchResult.content : undefined;
        await runAndAssertBoth({
          argv: ["read", "https://example.com/conformance"],
          mode,
          expectedData,
          expectedEnvelope: envelope,
          expectedRawText,
        });
      });
    }

    it(`compact mode emits the content string directly via presentation (cross-Adapter)`, async () => {
      // Belt-and-braces: compact mode emits the raw content string,
      // not JSON, on content reads. The cross-Adapter stdout equality
      // assertion above already covers this; this test pins the literal
      // value so the projection is unambiguous.
      const zaiResult = await runOne({
        descriptor: buildZaiDescriptor({ raw: sharedRawResponse() }),
        argv: ["read", "https://example.com/conformance"],
        mode: "compact",
      });
      assert.strictEqual(zaiResult.stdout[0], fetchResult.content);
    });
  });

  // -------------------------------------------------------------------------
  // Extract read × {data,json,pretty,compact} × {Z.AI, fake}
  //
  // Extract reads slice the cached content into typed items (code blocks
  // for `--extract code`). Text-oriented modes fall back to JSON for
  // extract reads because extracted items are data, not prose.
  // -------------------------------------------------------------------------

  describe("Extract read through main()", () => {
    const modeMatrix = ["data", "json", "pretty", "compact"];

    function sharedRawWithCodeBlocks() {
      return {
        title: "Code Page",
        url: "https://example.com/code",
        content: "Intro.\n\n```js\nconst x = 1;\n```\n\n```python\nprint('hi')\n```\n",
      };
    }

    function sharedFetchResultWithCodeBlocks() {
      const raw = sharedRawWithCodeBlocks();
      return {
        schemaVersion: 1,
        url: "https://example.com/code",
        finalUrl: "https://example.com/code",
        title: raw.title,
        content: raw.content,
        contentFormat: "markdown",
      };
    }

    function expectedExtractData() {
      return {
        schemaVersion: 1,
        url: "https://example.com/code",
        finalUrl: "https://example.com/code",
        mode: "code",
        items: [
          { language: "js", code: "const x = 1;" },
          { language: "python", code: "print('hi')" },
        ],
        truncated: false,
        originalItemCount: 2,
      };
    }

    const envelope = (data, mode) =>
      mode === "json" || mode === "pretty" ? { success: true, data, timestamp: FIXED_NOW } : data;

    for (const mode of modeMatrix) {
      it(`both Adapters produce status 0, empty stderr, and the exact extract envelope in ${mode} mode`, async () => {
        const zaiResult = await runOne({
          descriptor: buildZaiDescriptor({ raw: sharedRawWithCodeBlocks() }),
          argv: ["read", "https://example.com/code", "--extract", "code"],
          mode,
        });
        const fakeResult = await runOne({
          descriptor: buildFakeDescriptor({ result: sharedFetchResultWithCodeBlocks() }),
          argv: ["read", "https://example.com/code", "--extract", "code"],
          mode,
        });

        assert.strictEqual(zaiResult.status, 0, `Z.AI extract status for mode ${mode}`);
        assert.strictEqual(fakeResult.status, 0, `fake extract status for mode ${mode}`);
        assert.deepStrictEqual(zaiResult.stderr, [], `Z.AI extract stderr for mode ${mode}`);
        assert.deepStrictEqual(fakeResult.stderr, [], `fake extract stderr for mode ${mode}`);
        // Cross-Adapter byte-identical stdout.
        assert.deepStrictEqual(
          zaiResult.stdout,
          fakeResult.stdout,
          `mode ${mode}: Z.AI and fake extract stdout must match`,
        );
        // Exact expected public value.
        const parsed = JSON.parse(zaiResult.stdout[0]);
        assert.deepStrictEqual(
          parsed,
          envelope(expectedExtractData(), mode),
          `mode ${mode}: exact expected extract envelope`,
        );
      });
    }
  });
});

// ===========================================================================
// 2. Real Z.AI credential alias matrix — `ZAI_API_KEY` alias-only and
//    `Z_AI_API_KEY`-over-`ZAI_API_KEY` precedence.
//
// The Z.AI credential resolver treats `Z_AI_API_KEY` as primary and
// `ZAI_API_KEY` as its alias. The Reader Adapter reconstructs the
// legacy v0.2 cache key from the SAME resolved credential that drives
// the normalized fingerprint, so a v0.2 entry written under either
// credential alias is recognized. This matrix exercises:
//
//   - alias-only: Adapter constructed with only `ZAI_API_KEY` resolves
//     the credential from the alias and reconstructs the legacy key
//     from that resolved value;
//   - primary-over-alias: Adapter constructed with both values uses
//     `Z_AI_API_KEY` for legacy key reconstruction, NOT `ZAI_API_KEY`.
//
// All cases go through the REAL Z.AI Adapter; no fake candidates.
// ===========================================================================

describe("05 Z.AI real credential alias matrix (ZAI_API_KEY alias-only and Z_AI_API_KEY-over-alias)", () => {
  const PRIMARY_KEY = "primary-zai-credential-DO-NOT-LEAK";
  const ALIAS_KEY = "alias-zai-credential-DO-NOT-LEAK";
  const PRIMARY_FP = crypto.createHash("sha256").update(PRIMARY_KEY).digest("hex");
  const ALIAS_FP = crypto.createHash("sha256").update(ALIAS_KEY).digest("hex");

  /**
   * Build a Z.AI Adapter bound to the supplied credential env. The
   * factory's `resultsByName` populates the WebReader response so a
   * fall-through invoke still succeeds defensively. Each test asserts
   * the legacy candidate was READ at the documented key.
   */
  function makeZaiAdapterForEnv(env, raw) {
    const factory = makeClientFactory({
      discoveredTools: DISCOVERED_READER_TOOLS,
      resultsByName: { [INTERNAL_WEB_READER]: raw },
    });
    return createZaiDescriptor({ clientFactory: factory }).create({ env });
  }

  // The Reader Adapter rewrites the URL only for gists; the example.com
  // URL passes through, so `finalUrl === url` and the legacy args.url
  // matches the request url verbatim.
  function legacyArgsFor(requestUrl) {
    return { url: requestUrl };
  }

  it("alias-only ZAI_API_KEY reconstructs the legacy key from the alias credential", async () => {
    const raw = validRawResponse({ content: "alias-only body" });
    const requestUrl = "https://example.com/alias";
    const adapter = makeZaiAdapterForEnv({ ZAI_API_KEY: ALIAS_KEY }, raw);
    const legacyKey = buildLegacyReaderCacheKey(
      ALIAS_KEY,
      READER_TOOL_PUBLIC_NAME,
      legacyArgsFor(requestUrl),
    );
    const cache = makeRecordingCache({ [legacyKey]: raw });

    const out = await executeReaderOperation(
      adapter.reader.fetch,
      { url: requestUrl },
      {},
      makeDeps(cache),
    );

    assert.deepStrictEqual(out, {
      schemaVersion: 1,
      url: requestUrl,
      finalUrl: requestUrl,
      title: raw.title,
      content: raw.content,
      contentFormat: "markdown",
      metadata: raw.metadata,
      external: raw.external,
    });
    assert.ok(cache.gets.includes(legacyKey), "alias-derived legacy key must be read");
    // The Adapter never invoked: alias-only reconstruction is sufficient.
    assert.strictEqual(cache.store.get(legacyKey), raw, "legacy file preserved verbatim");
    // Normalized write happened exactly once.
    assert.strictEqual(cache.sets.length, 1);
  });

  it("Z_AI_API_KEY-over-ZAI_API_KEY precedence uses the primary credential for legacy reconstruction", async () => {
    const raw = validRawResponse({ content: "primary-wins body" });
    const requestUrl = "https://example.com/primary";
    const adapter = makeZaiAdapterForEnv(
      { Z_AI_API_KEY: PRIMARY_KEY, ZAI_API_KEY: ALIAS_KEY },
      raw,
    );
    const primaryLegacyKey = buildLegacyReaderCacheKey(
      PRIMARY_KEY,
      READER_TOOL_PUBLIC_NAME,
      legacyArgsFor(requestUrl),
    );
    const aliasLegacyKey = buildLegacyReaderCacheKey(
      ALIAS_KEY,
      READER_TOOL_PUBLIC_NAME,
      legacyArgsFor(requestUrl),
    );
    assert.notStrictEqual(primaryLegacyKey, aliasLegacyKey);
    const cache = makeRecordingCache({ [primaryLegacyKey]: raw });

    const out = await executeReaderOperation(
      adapter.reader.fetch,
      { url: requestUrl },
      {},
      makeDeps(cache),
    );

    assert.strictEqual(out.content, "primary-wins body");
    assert.ok(cache.gets.includes(primaryLegacyKey), "primary-credential legacy key must be read");
    assert.ok(
      !cache.gets.includes(aliasLegacyKey),
      "alias credential must NOT be consulted when primary is present",
    );
  });

  it("fingerprint reflects the resolved alias credential", async () => {
    const adapter = makeZaiAdapterForEnv({ ZAI_API_KEY: ALIAS_KEY }, validRawResponse());
    const identity = adapter.reader.fetch.cacheIdentity({ url: "https://example.com/" });
    assert.strictEqual(identity.credentialFingerprint, ALIAS_FP);
  });

  it("fingerprint reflects the resolved primary credential under precedence", async () => {
    const adapter = makeZaiAdapterForEnv(
      { Z_AI_API_KEY: PRIMARY_KEY, ZAI_API_KEY: ALIAS_KEY },
      validRawResponse(),
    );
    const identity = adapter.reader.fetch.cacheIdentity({ url: "https://example.com/" });
    assert.strictEqual(identity.credentialFingerprint, PRIMARY_FP);
  });

  it("alias parity: same resolved credential produces byte-identical legacy keys", () => {
    // Z_AI_API_KEY and ZAI_API_KEY with the same resolved value must
    // produce the same legacy key (this is the property that lets v0.2
    // cache entries written under one alias remain readable under the
    // other).
    const resolved = "sk-shared-resolved-credential-XYZ";
    const a = createZaiDescriptor().create({ env: { Z_AI_API_KEY: resolved } });
    const b = createZaiDescriptor().create({ env: { ZAI_API_KEY: resolved } });
    const idA = a.reader.fetch.cacheIdentity({ url: "https://example.com/" });
    const idB = b.reader.fetch.cacheIdentity({ url: "https://example.com/" });
    assert.strictEqual(idA.legacyCandidates[0].key, idB.legacyCandidates[0].key);
    assert.strictEqual(idA.credentialFingerprint, idB.credentialFingerprint);
  });
});

// ===========================================================================
// 3. Legacy-cache matrix through the REAL Z.AI Adapter
//
//   - Primary public name candidate seeded with a valid raw v0.2 entry
//     is read through, decoded, written back to the normalized key, and
//     returned WITHOUT invoking the Provider.
//   - Malformed legacy entry is a miss and falls through to invoke.
//   - Injected-only credential: the candidate key is derived from the
//     RESOLVED credential (passed to the Adapter through env).
//   - `--no-cache` skips both reads and writes.
//   - Raw legacy Provider data NEVER crosses the normalized seam: the
//     written normalized key value is structurally clean schema-version-1
//     data, not the raw v0.2 string.
// ===========================================================================

describe("05 legacy-cache matrix — Z.AI Adapter (reader-fetch)", () => {
  const request = { url: "https://example.com/legacy" };
  const raw = validRawResponse({
    url: "https://example.com/legacy",
    content: "legacy reader body",
  });
  const expected = {
    schemaVersion: 1,
    url: "https://example.com/legacy",
    finalUrl: "https://example.com/legacy",
    title: raw.title,
    content: raw.content,
    contentFormat: "markdown",
    metadata: raw.metadata,
    external: raw.external,
  };

  it("reads a valid legacy v0.2 primary entry through to the normalized key without invoking", async () => {
    const factory = makeClientFactory({
      discoveredTools: DISCOVERED_READER_TOOLS,
      resultsByName: { [INTERNAL_WEB_READER]: raw },
    });
    const zaiAdapter = makeZaiAdapter({ factory });
    const legacyKey = buildLegacyReaderCacheKey(TEST_API_KEY, READER_TOOL_PUBLIC_NAME, {
      url: request.url,
    });
    const cache = makeRecordingCache({ [legacyKey]: raw });

    const out = await executeReaderOperation(zaiAdapter.reader.fetch, request, {}, makeDeps(cache));

    assert.deepStrictEqual(out, expected);
    // The Adapter was never invoked: zero transports constructed.
    assert.strictEqual(factory.created.length, 0, "no transport on a legacy hit");
    // The cache wrote the normalized key exactly once.
    assert.strictEqual(cache.sets.length, 1);
    // The legacy file is never overwritten.
    assert.strictEqual(cache.store.get(legacyKey), raw);
  });

  it("treats a malformed legacy entry as a miss and falls through to invoke", async () => {
    const factory = makeClientFactory({
      discoveredTools: DISCOVERED_READER_TOOLS,
      resultsByName: { [INTERNAL_WEB_READER]: raw },
    });
    const zaiAdapter = makeZaiAdapter({ factory });
    const legacyKey = buildLegacyReaderCacheKey(TEST_API_KEY, READER_TOOL_PUBLIC_NAME, {
      url: request.url,
    });
    // Bare strings are malformed at the Capability layer; the legacy
    // decoder returns null and the executor falls through to invoke.
    const malformedLegacy = "totally-not-a-webreader-object";
    const cache = makeRecordingCache({ [legacyKey]: malformedLegacy });

    const out = await executeReaderOperation(zaiAdapter.reader.fetch, request, {}, makeDeps(cache));

    assert.deepStrictEqual(out, expected);
    // Exactly one transport constructed (the invoke attempt).
    assert.strictEqual(factory.created.length, 1);
    // The legacy file is never overwritten even on a miss.
    assert.strictEqual(cache.store.get(legacyKey), malformedLegacy);
  });

  it("--no-cache skips the legacy read-through and the normalized write-back", async () => {
    const factory = makeClientFactory({
      discoveredTools: DISCOVERED_READER_TOOLS,
      resultsByName: { [INTERNAL_WEB_READER]: raw },
    });
    const zaiAdapter = makeZaiAdapter({ factory });
    const legacyKey = buildLegacyReaderCacheKey(TEST_API_KEY, READER_TOOL_PUBLIC_NAME, {
      url: request.url,
    });
    const cache = makeRecordingCache({ [legacyKey]: raw });

    const out = await executeReaderOperation(
      zaiAdapter.reader.fetch,
      request,
      { noCache: true },
      makeDeps(cache),
    );

    assert.deepStrictEqual(out, expected);
    // No reads, no writes.
    assert.strictEqual(cache.gets.length, 0);
    assert.strictEqual(cache.sets.length, 0);
    // Invoke still ran.
    assert.strictEqual(factory.created.length, 1);
  });

  it("raw legacy Provider data never crosses the normalized output (seam proof)", async () => {
    const factory = makeClientFactory({
      discoveredTools: DISCOVERED_READER_TOOLS,
      resultsByName: { [INTERNAL_WEB_READER]: raw },
    });
    const zaiAdapter = makeZaiAdapter({ factory });
    const legacyKey = buildLegacyReaderCacheKey(TEST_API_KEY, READER_TOOL_PUBLIC_NAME, {
      url: request.url,
    });
    const cache = makeRecordingCache({ [legacyKey]: raw });

    const out = await executeReaderOperation(zaiAdapter.reader.fetch, request, {}, makeDeps(cache));

    // The normalized result must NOT contain the raw Provider object's
    // structural noise. Both shapes are JSON objects here, but the
    // normalized result is the v1 envelope, not the raw probe response.
    // The `description` field is dropped; `metadata.viewport` is
    // preserved verbatim under the contract.
    assert.ok(!("description" in out));
    assert.deepStrictEqual(out.metadata, raw.metadata);

    // The normalized cache write is also clean.
    const normalizedWrite = cache.sets[0].value;
    assert.ok(!("description" in normalizedWrite));
    assert.deepStrictEqual(normalizedWrite, expected);
  });

  it("injected-only credential derives the candidate key from the injected value", async () => {
    const factory = makeClientFactory({
      discoveredTools: DISCOVERED_READER_TOOLS,
      resultsByName: { [INTERNAL_WEB_READER]: raw },
    });
    const zaiAdapter = makeZaiAdapter({ factory });
    const expectedKey = buildLegacyReaderCacheKey(TEST_API_KEY, READER_TOOL_PUBLIC_NAME, {
      url: request.url,
    });
    const cache = makeRecordingCache();

    await executeReaderOperation(zaiAdapter.reader.fetch, request, {}, makeDeps(cache));

    // The candidate read for the documented injected-key legacy
    // candidate must occur.
    assert.ok(
      cache.gets.includes(expectedKey),
      `expected legacy candidate read at ${expectedKey}, got ${cache.gets.join(", ")}`,
    );
  });

  it("conflicting ambient and injected credentials derive the candidate key from the injected value", async () => {
    // Stash and force an ambient credential that would change the
    // candidate key if the Adapter ever consulted process.env. The
    // injected credential (TEST_API_KEY) is passed through the
    // descriptor env; the candidate key must match the documented
    // value built from TEST_API_KEY, NOT from the ambient value.
    const savedKey = process.env.Z_AI_API_KEY;
    const savedAlt = process.env.ZAI_API_KEY;
    process.env.Z_AI_API_KEY = "sk-AMBIENT-DO-NOT-USE-999";
    process.env.ZAI_API_KEY = "sk-AMBIENT-ALT-DO-NOT-USE";
    try {
      const factory = makeClientFactory({
        discoveredTools: DISCOVERED_READER_TOOLS,
        resultsByName: { [INTERNAL_WEB_READER]: raw },
      });
      const zaiAdapter = makeZaiAdapter({ factory });
      const expectedKey = buildLegacyReaderCacheKey(TEST_API_KEY, READER_TOOL_PUBLIC_NAME, {
        url: request.url,
      });
      const wrongKey = buildLegacyReaderCacheKey(
        "sk-AMBIENT-DO-NOT-USE-999",
        READER_TOOL_PUBLIC_NAME,
        { url: request.url },
      );
      assert.notStrictEqual(expectedKey, wrongKey);
      const cache = makeRecordingCache();

      await executeReaderOperation(zaiAdapter.reader.fetch, request, {}, makeDeps(cache));

      assert.ok(
        cache.gets.includes(expectedKey),
        `expected injected-credential legacy key ${expectedKey}, got ${cache.gets.join(", ")}`,
      );
      assert.ok(
        !cache.gets.includes(wrongKey),
        "ambient credential value must NOT produce a legacy candidate read",
      );
    } finally {
      if (savedKey === undefined) delete process.env.Z_AI_API_KEY;
      else process.env.Z_AI_API_KEY = savedKey;
      if (savedAlt === undefined) delete process.env.ZAI_API_KEY;
      else process.env.ZAI_API_KEY = savedAlt;
    }
  });

  it("legacy read-through writes the normalized key, not the legacy key", async () => {
    const factory = makeClientFactory({
      discoveredTools: DISCOVERED_READER_TOOLS,
    });
    const zaiAdapter = makeZaiAdapter({ factory });
    const legacyKey = buildLegacyReaderCacheKey(TEST_API_KEY, READER_TOOL_PUBLIC_NAME, {
      url: request.url,
    });
    const normalizedKey = buildProviderCacheKey({
      provider: "zai",
      capability: "reader-reader-fetch",
      credentialFingerprint: EXPECTED_FINGERPRINT,
      request,
    });
    assert.notStrictEqual(legacyKey, normalizedKey);
    const cache = makeRecordingCache({ [legacyKey]: raw });

    await executeReaderOperation(zaiAdapter.reader.fetch, request, {}, makeDeps(cache));

    // Exactly one write, to the normalized key.
    assert.strictEqual(cache.sets.length, 1);
    assert.strictEqual(cache.sets[0].key, normalizedKey);
    assert.notStrictEqual(cache.sets[0].key, legacyKey);
  });

  it("legacy candidate is consulted only after the normalized key misses (cache.get order)", async () => {
    // The executor reads the normalized key first; on miss it falls
    // through to legacy candidates. The observable proof is the
    // cache.get sequence: [normalizedKey, legacyKey].
    const factory = makeClientFactory({
      discoveredTools: DISCOVERED_READER_TOOLS,
      resultsByName: { [INTERNAL_WEB_READER]: raw },
    });
    const zaiAdapter = makeZaiAdapter({ factory });
    const legacyKey = buildLegacyReaderCacheKey(TEST_API_KEY, READER_TOOL_PUBLIC_NAME, {
      url: request.url,
    });
    const normalizedKey = buildProviderCacheKey({
      provider: "zai",
      capability: "reader-reader-fetch",
      credentialFingerprint: EXPECTED_FINGERPRINT,
      request,
    });
    const cache = makeRecordingCache({ [legacyKey]: raw });

    await executeReaderOperation(zaiAdapter.reader.fetch, request, {}, makeDeps(cache));

    // The candidate read order proves normalized-before-legacy.
    const candidateReads = cache.gets.filter((k) => k === normalizedKey || k === legacyKey);
    assert.deepStrictEqual(candidateReads, [normalizedKey, legacyKey]);
  });
});

// ===========================================================================
// 3b. Generic legacy-candidate executor ordering (NOT Z.AI alias coverage)
//
// The fake Adapter accepts caller-supplied legacy candidates so the
// shared executor's candidate-sequence behaviour can be asserted without
// involving any Provider-specific credential. These tests prove the
// generic executor contract: primary-before-alias `cache.get` order,
// write-through to the normalized key on a hit, and fall-through to
// invoke when every candidate misses.
// ===========================================================================

describe("05 generic legacy-candidate executor ordering (fake Adapter, not Z.AI alias)", () => {
  const expectedResult = {
    schemaVersion: 1,
    url: "https://example.com/",
    finalUrl: "https://example.com/",
    title: "Fake",
    content: "fake-body",
    contentFormat: "markdown",
  };

  it("primary candidate hit writes through to the normalized key without invoking", async () => {
    const legacyKey = "fake-reader-legacy-primary.json";
    const fake = createFakeReaderCapability({
      apiKey: TEST_API_KEY,
      provider: "fake",
      fetch: { result: expectedResult },
      legacyCandidates: [
        {
          key: legacyKey,
          decode: (raw) => (raw && raw.ok === true ? expectedResult : null),
        },
      ],
    });
    const cache = makeRecordingCache({
      [legacyKey]: { ok: true, payload: expectedResult },
    });

    const out = await executeReaderOperation(
      fake.capability.fetch,
      { url: "https://example.com/" },
      {},
      makeDeps(cache),
    );

    assert.deepStrictEqual(out, expectedResult);
    // Invoke never ran.
    assert.strictEqual(fake.stats.fetch.invoke, 0);
    // Normalized write happened exactly once.
    assert.strictEqual(cache.sets.length, 1);
  });

  it("alias candidate is consulted only after the primary candidate misses (cache.get order)", async () => {
    // The executor skips a candidate's `decode` when the candidate key
    // is absent from the cache. The observable ordering proof is
    // therefore the cache.get sequence: [normalizedKey, primaryKey,
    // aliasKey] when both legacy candidates are declared.
    const primaryKey = "fake-reader-legacy-primary.json";
    const aliasKey = "fake-reader-legacy-alias.json";
    const fake = createFakeReaderCapability({
      apiKey: TEST_API_KEY,
      provider: "fake",
      fetch: { result: expectedResult },
      legacyCandidates: [
        { key: primaryKey, decode: () => null },
        {
          key: aliasKey,
          decode: (raw) => (raw && raw.ok === true ? expectedResult : null),
        },
      ],
    });
    const cache = makeRecordingCache({
      [aliasKey]: { ok: true, payload: expectedResult },
    });

    const out = await executeReaderOperation(
      fake.capability.fetch,
      { url: "https://example.com/" },
      {},
      makeDeps(cache),
    );

    assert.deepStrictEqual(out, expectedResult);
    // The candidate read order proves primary-before-alias.
    const candidateReads = cache.gets.filter((k) => k === primaryKey || k === aliasKey);
    assert.deepStrictEqual(candidateReads, [primaryKey, aliasKey]);
    // Invoke never ran because the alias hit returned early.
    assert.strictEqual(fake.stats.fetch.invoke, 0);
  });

  it("all legacy candidates missing falls through to invoke", async () => {
    const fake = createFakeReaderCapability({
      apiKey: TEST_API_KEY,
      provider: "fake",
      fetch: { result: expectedResult },
      legacyCandidates: [
        { key: "absent-1.json", decode: () => null },
        { key: "absent-2.json", decode: () => null },
      ],
    });
    const cache = makeRecordingCache();

    const out = await executeReaderOperation(
      fake.capability.fetch,
      { url: "https://example.com/" },
      {},
      makeDeps(cache),
    );

    assert.deepStrictEqual(out, expectedResult);
    assert.strictEqual(fake.stats.fetch.invoke, 1);
  });
});

// ===========================================================================
// 4. Integrated retry/lifecycle through the REAL Z.AI Adapter
//
//   - Cache hit constructs/closes zero transports.
//   - Each uncached retry constructs a fresh transport (transport count
//     equals attempt count).
//   - Close rejection never alters success nor masks the primary failure.
//   - Close timeout never alters success nor masks the primary failure.
// ===========================================================================

describe("05 integrated retry/lifecycle — Z.AI Adapter (reader-fetch)", () => {
  it("cache hit constructs and closes zero transports (no close path entered)", async () => {
    const factory = makeClientFactory({
      discoveredTools: DISCOVERED_READER_TOOLS,
      resultsByName: { [INTERNAL_WEB_READER]: validRawResponse() },
    });
    const zaiAdapter = makeZaiAdapter({ factory });

    const request = { url: "https://example.com/" };

    // First call: populates the cache. Exactly one transport is
    // constructed AND closed exactly once.
    const cache = makeRecordingCache();
    const result = await executeReaderOperation(
      zaiAdapter.reader.fetch,
      request,
      {},
      makeDeps(cache),
    );
    assert.strictEqual(factory.created.length, 1, "uncached populate constructs one transport");
    assert.strictEqual(
      factory.created[0].fake.closeCount,
      1,
      "uncached populate closes the transport exactly once",
    );
    assert.strictEqual(
      factory.created[0].port.closeEntered,
      1,
      "uncached populate entered close exactly once",
    );

    // Reset the factory counter so the cache-hit call starts from zero.
    factory.created.length = 0;
    // Wipe the writes log so the cache-hit assertion is unambiguous.
    cache.sets.length = 0;

    // Second call: same Adapter, same request, seeded cache → cache hit.
    const out = await executeReaderOperation(zaiAdapter.reader.fetch, request, {}, makeDeps(cache));

    assert.deepStrictEqual(out, result);
    assert.strictEqual(
      factory.created.length,
      0,
      "no transport should be constructed on a cache hit",
    );
    assert.strictEqual(cache.sets.length, 0, "no cache write on a cache hit");
  });

  it("each uncached retry constructs and closes a distinct transport (transport count == attempt count)", async () => {
    // First invoke throws a retryable TimeoutError; second invoke
    // returns the valid WebReader response. The factory should
    // construct exactly two transports — one per attempt — and each
    // transport must be closed exactly once.
    let attempt = 0;
    const scriptedFactory = (options) => {
      attempt += 1;
      const fake = new FakeUtcpClient({
        discoveredTools: DISCOVERED_READER_TOOLS,
        resultsByName: { [INTERNAL_WEB_READER]: validRawResponse() },
      });
      const port = {
        options,
        callToolCalls: [],
        closeEntered: 0,
        async callToolRaw(name, args) {
          this.callToolCalls.push({ name, args });
          if (attempt === 1) {
            throw new TimeoutError(1000);
          }
          return fake.callTool(INTERNAL_WEB_READER, args);
        },
        async listTools() {
          return fake.getTools();
        },
        async close() {
          this.closeEntered += 1;
          return fake.close();
        },
      };
      scriptedFactory.created.push({ options, port, fake });
      return port;
    };
    scriptedFactory.created = [];

    const zaiAdapter = makeZaiAdapter({ factory: scriptedFactory });
    const sleepCalls = [];
    const out = await executeReaderOperation(
      zaiAdapter.reader.fetch,
      { url: "https://example.com/" },
      { noCache: true },
      {
        cache: makeRecordingCache(),
        sleep: (ms) => {
          sleepCalls.push(ms);
          return Promise.resolve();
        },
        random: () => 0,
      },
    );

    assert.strictEqual(out.content, validRawResponse().content);
    assert.strictEqual(scriptedFactory.created.length, 2, "one fresh transport per attempt");
    assert.strictEqual(sleepCalls.length, 1, "exactly one retry backoff");
    // Each constructed transport must be closed exactly once. The first
    // attempt threw and was still closed in its `finally`; the second
    // attempt succeeded and was also closed in its `finally`.
    assert.strictEqual(
      scriptedFactory.created[0].fake.closeCount,
      1,
      "first (failed) transport closed exactly once",
    );
    assert.strictEqual(
      scriptedFactory.created[0].port.closeEntered,
      1,
      "first (failed) transport entered close exactly once",
    );
    assert.strictEqual(
      scriptedFactory.created[1].fake.closeCount,
      1,
      "second (successful) transport closed exactly once",
    );
    assert.strictEqual(
      scriptedFactory.created[1].port.closeEntered,
      1,
      "second (successful) transport entered close exactly once",
    );
  });

  it("success path closes the constructed transport exactly once", async () => {
    const factory = makeClientFactory({
      discoveredTools: DISCOVERED_READER_TOOLS,
      resultsByName: { [INTERNAL_WEB_READER]: validRawResponse() },
    });
    const zaiAdapter = makeZaiAdapter({ factory });
    const out = await executeReaderOperation(
      zaiAdapter.reader.fetch,
      { url: "https://example.com/" },
      { noCache: true },
      makeDeps(makeRecordingCache()),
    );
    assert.strictEqual(out.content, validRawResponse().content);
    assert.strictEqual(factory.created.length, 1);
    assert.strictEqual(factory.created[0].fake.closeCount, 1, "success closes transport once");
    assert.strictEqual(factory.created[0].port.closeEntered, 1, "success entered close once");
  });

  it("primary failure path still closes every constructed transport (one per attempt)", async () => {
    // Malformed WebReader response (null) → primary ApiError 502. The
    // 502 is retryable through the shared taxonomy, so the executor
    // makes exactly two attempts. Each constructed transport must still
    // be closed exactly once in its attempt's `finally`.
    const factory = makeClientFactory({
      discoveredTools: DISCOVERED_READER_TOOLS,
      resultsByName: { [INTERNAL_WEB_READER]: null },
    });
    const zaiAdapter = makeZaiAdapter({ factory });
    const err = await captureError(
      executeReaderOperation(
        zaiAdapter.reader.fetch,
        { url: "https://example.com/" },
        { noCache: true },
        makeDeps(makeRecordingCache()),
      ),
    );
    assert.ok(err instanceof ApiError);
    assert.strictEqual(err.statusCode, 502);
    // 502 is retryable → exactly two attempts → two transports, each
    // closed exactly once.
    assert.strictEqual(factory.created.length, 2, "retryable 502 must construct two transports");
    for (let i = 0; i < factory.created.length; i += 1) {
      assert.strictEqual(
        factory.created[i].fake.closeCount,
        1,
        `transport #${i + 1} must be closed exactly once`,
      );
      assert.strictEqual(
        factory.created[i].port.closeEntered,
        1,
        `transport #${i + 1} must enter close exactly once`,
      );
    }
  });

  it("close rejection never replaces a successful result AND the close path was entered", async () => {
    const baseFactory = makeClientFactory({
      discoveredTools: DISCOVERED_READER_TOOLS,
      resultsByName: { [INTERNAL_WEB_READER]: validRawResponse() },
    });
    const factory = withCloseRejection(baseFactory);
    const zaiAdapter = makeZaiAdapter({ factory });
    const out = await executeReaderOperation(
      zaiAdapter.reader.fetch,
      { url: "https://example.com/" },
      { noCache: true },
      makeDeps(makeRecordingCache()),
    );
    assert.strictEqual(out.content, validRawResponse().content);
    // The close wrapper was actually entered (FR-093: best-effort close
    // must be attempted even when it later rejects).
    assert.strictEqual(factory.created.length, 1);
    assert.strictEqual(
      factory.created[0].port.closeEntered,
      1,
      "close rejection path must still enter close exactly once",
    );
    // The underlying FakeUtcpClient close counter stays at zero because
    // the wrapper rejected before delegating; this is the evidence that
    // the rejection branch actually ran.
    assert.strictEqual(
      factory.created[0].fake.closeCount,
      0,
      "close rejection wrapper must not delegate to the underlying fake close",
    );
  });

  it("close rejection never masks a primary operation failure AND every attempt enters close", async () => {
    // Force a malformed response (primary 502) and a close that
    // rejects. The 502 is retryable, so the executor makes two
    // attempts. The outward error MUST be the 502, not the close error;
    // every constructed transport must have entered the close path.
    const baseFactory = makeClientFactory({
      discoveredTools: DISCOVERED_READER_TOOLS,
      resultsByName: { [INTERNAL_WEB_READER]: null },
    });
    const factory = withCloseRejection(baseFactory);
    const zaiAdapter = makeZaiAdapter({ factory });
    const err = await captureError(
      executeReaderOperation(
        zaiAdapter.reader.fetch,
        { url: "https://example.com/" },
        { noCache: true },
        makeDeps(makeRecordingCache()),
      ),
    );
    assert.ok(err instanceof ApiError);
    assert.strictEqual(err.statusCode, 502);
    assert.ok(!err.message.includes("close rejected"));
    // 502 is retryable → exactly two attempts → two transports, each
    // with closeEntered === 1 and fake.closeCount === 0 (because the
    // rejection wrapper does not delegate to the underlying fake).
    assert.strictEqual(factory.created.length, 2);
    for (let i = 0; i < factory.created.length; i += 1) {
      assert.strictEqual(
        factory.created[i].port.closeEntered,
        1,
        `transport #${i + 1} must enter close exactly once even under rejection`,
      );
      assert.strictEqual(
        factory.created[i].fake.closeCount,
        0,
        `transport #${i + 1} close rejection must not delegate to underlying fake close`,
      );
    }
  });

  it("close timeout never replaces a successful result AND the close path was entered (bounded close)", async () => {
    const baseFactory = makeClientFactory({
      discoveredTools: DISCOVERED_READER_TOOLS,
      resultsByName: { [INTERNAL_WEB_READER]: validRawResponse() },
    });
    const factory = withCloseHang(baseFactory);
    // Inject a 50 ms close bound so the never-resolving close is bounded
    // well below the 2000 ms production default.
    const zaiAdapter = makeZaiAdapter({ factory, closeTimeoutMs: 50 });
    const start = Date.now();
    const out = await executeReaderOperation(
      zaiAdapter.reader.fetch,
      { url: "https://example.com/" },
      { noCache: true },
      makeDeps(makeRecordingCache()),
    );
    const elapsed = Date.now() - start;
    assert.strictEqual(out.content, validRawResponse().content);
    assert.ok(elapsed < 1000, `never-resolving close should be bounded, took ${elapsed} ms`);
    // FR-093: the close path was actually entered even though the
    // wrapper never resolved.
    assert.strictEqual(factory.created.length, 1);
    assert.strictEqual(
      factory.created[0].port.closeEntered,
      1,
      "close hang path must still enter close exactly once",
    );
  });

  it("close timeout never masks a primary operation failure AND every retry attempt enters close (bounded close)", async () => {
    // Mirrors the P6-08A re-review: the success+hang case above proves
    // the close timeout race preserves success. This case proves the
    // same race preserves a PRIMARY operation failure: a malformed
    // response (retryable ApiError 502) is wrapped with a never-
    // resolving close. The outward error MUST remain the primary 502,
    // every retry attempt's close must be actually entered, and each
    // attempt must use a distinct transport.
    const baseFactory = makeClientFactory({
      discoveredTools: DISCOVERED_READER_TOOLS,
      resultsByName: { [INTERNAL_WEB_READER]: null },
    });
    const factory = withCloseHang(baseFactory);
    const zaiAdapter = makeZaiAdapter({ factory, closeTimeoutMs: 50 });
    const sleepCalls = [];
    const start = Date.now();
    const err = await captureError(
      executeReaderOperation(
        zaiAdapter.reader.fetch,
        { url: "https://example.com/" },
        { noCache: true },
        {
          cache: makeRecordingCache(),
          sleep: (ms) => {
            sleepCalls.push(ms);
            return Promise.resolve();
          },
          random: () => 0,
        },
      ),
    );
    const elapsed = Date.now() - start;

    // Primary failure survives: outward ApiError 502, NOT a close
    // timeout or hang error.
    assert.ok(err instanceof ApiError, `expected ApiError, got ${err && err.constructor.name}`);
    assert.strictEqual(err.statusCode, 502);
    assert.ok(
      !err.message.includes("close"),
      `primary failure must not mention close: ${err.message}`,
    );

    // 502 is retryable → exactly two attempts, two distinct transports,
    // one injected sleep call.
    assert.strictEqual(
      factory.created.length,
      2,
      "primary failure + retryable 502 must construct two distinct transports",
    );
    assert.strictEqual(sleepCalls.length, 1, "exactly one injected retry sleep");
    assert.strictEqual(sleepCalls[0], 500, "base delay × 2^0 + zero jitter");

    // Every retry attempt entered close exactly once.
    for (let i = 0; i < factory.created.length; i += 1) {
      assert.strictEqual(
        factory.created[i].port.closeEntered,
        1,
        `transport #${i + 1} must enter close exactly once under hang`,
      );
      assert.strictEqual(
        factory.created[i].fake.closeCount,
        0,
        `transport #${i + 1} hang must not delegate to the underlying fake close`,
      );
    }

    // Two transports are distinct instances (not the same one reused).
    assert.notStrictEqual(
      factory.created[0].port,
      factory.created[1].port,
      "retry attempts must use distinct transport instances",
    );

    // Secondary upper-bound evidence: the bounded-close race keeps
    // the total wall-clock well under the production default ×
    // attempts. Generous margin to avoid CI flake.
    assert.ok(
      elapsed < 1000,
      `two bounded-close attempts should complete well under 1 s, took ${elapsed} ms`,
    );
  });

  it("production close bound constant is 2000 ms (matches ZaiMcpClient.close)", () => {
    assert.strictEqual(ZAI_READER_CLOSE_BOUND_MS, 2000);
  });
});

// ===========================================================================
// 5. Exact encoded-error fixtures (DESIGN.md §18, WebReader
//    characterization)
//
//   - Exhausted quota (code 1310 or explicit exhausted-quota meaning) is
//     terminal QUOTA_ERROR; one attempt, zero sleeps.
//   - Auth 401/403 is terminal AUTH_ERROR with the matching status.
//   - Other 4xx is terminal API_ERROR with the matching status.
//   - Transient 429 (no exhausted meaning), 5xx, and malformed 502 each
//     receive exactly one retry.
// ===========================================================================

describe("05 encoded MCP error taxonomy through the Z.AI Adapter (reader-fetch)", () => {
  /**
   * Drive the Z.AI Reader Adapter with a given raw WebReader response
   * and return the captured outward error plus observable retry evidence.
   */
  async function captureErrorWithEvidence(raw) {
    const factory = makeClientFactory({
      discoveredTools: DISCOVERED_READER_TOOLS,
      resultsByName: { [INTERNAL_WEB_READER]: raw },
    });
    const zaiAdapter = makeZaiAdapter({ factory });
    const sleepCalls = [];
    const err = await captureError(
      executeReaderOperation(
        zaiAdapter.reader.fetch,
        { url: "https://example.com/" },
        { noCache: true },
        {
          cache: makeRecordingCache(),
          sleep: (ms) => {
            sleepCalls.push(ms);
            return Promise.resolve();
          },
          random: () => 0,
        },
      ),
    );
    return { err, sleepCalls, factory };
  }

  it("exhausted quota (code 1310) is terminal QUOTA_ERROR — single attempt, zero sleeps", async () => {
    const raw =
      "MCP error -429\nerror.code: 1310\nerror.message: Weekly/Monthly Limit Exhausted\nreset: 2026-08-08 06:07:26";
    const { err, sleepCalls, factory } = await captureErrorWithEvidence(raw);
    assert.ok(err instanceof QuotaError, `expected QuotaError, got ${err && err.constructor.name}`);
    assert.strictEqual(err.code, "QUOTA_ERROR");
    assert.strictEqual(err.statusCode, 429);
    assert.strictEqual(sleepCalls.length, 0);
    assert.strictEqual(
      factory.created.length,
      1,
      "terminal error must construct exactly one transport",
    );
  });

  it("exhausted quota body never crosses the public envelope (sanitized message)", async () => {
    const raw =
      "MCP error -429\nerror.code: 1310\nerror.message: Weekly/Monthly Limit Exhausted\nreset: 2026-08-08 06:07:26";
    const { err } = await captureErrorWithEvidence(raw);
    assert.ok(err instanceof QuotaError);
    assert.ok(!err.message.includes("Weekly/Monthly Limit Exhausted"));
    assert.ok(!err.message.includes("1310"));
    assert.ok(!err.help.includes("reset"));
  });

  it("encoded 5xx (500..599 inclusive) retries once: 2 transports, 2 closes, sleeps [500]", async () => {
    // Mirrors P6-09A / GATE-6 HIGH 1: the shared retry classifier must
    // retry any encoded 5xx. Probe the boundary literals (500, 599) and
    // an interior point (501) to prove the closed interval contract.
    const cases = [
      ["500", "MCP error -500\nerror.code: 9999\nerror.message: internal failure"],
      ["501", "MCP error -501\nerror.code: 9999\nerror.message: not implemented"],
      ["599", "MCP error -599\nerror.code: 9999\nerror.message: upstream timeout"],
    ];
    for (const [label, raw] of cases) {
      const { err, sleepCalls, factory } = await captureErrorWithEvidence(raw);
      assert.ok(err instanceof ApiError, `[${label}] expected ApiError`);
      assert.strictEqual(err.code, "API_ERROR", `[${label}] code`);
      assert.strictEqual(err.statusCode, Number(label), `[${label}] statusCode`);
      // Transports: one per attempt → 2.
      assert.strictEqual(
        factory.created.length,
        2,
        `[${label}] retryable 5xx must construct two transports`,
      );
      // Closes: each transport's `finally` closes once → 2.
      const closes = factory.created.reduce((sum, t) => sum + t.fake.closeCount, 0);
      assert.strictEqual(closes, 2, `[${label}] every transport must close exactly once`);
      for (let i = 0; i < factory.created.length; i += 1) {
        assert.strictEqual(
          factory.created[i].fake.closeCount,
          1,
          `[${label}] transport #${i + 1} must close exactly once`,
        );
        assert.strictEqual(
          factory.created[i].port.closeEntered,
          1,
          `[${label}] transport #${i + 1} must enter close exactly once`,
        );
      }
      // Sleeps: one injected backoff, value 500 ms exactly.
      assert.deepStrictEqual(sleepCalls, [500], `[${label}] sleeps must be [500]`);
    }
  });

  it("malformed envelope (no parseable status) maps to retryable ApiError 502", async () => {
    // A raw response that is neither a valid object nor a parseable
    // encoded MCP envelope: the success parser throws a sanitized
    // ApiError 502, which the retry classifier treats as retryable.
    const { err, sleepCalls, factory } = await captureErrorWithEvidence(
      "MCP error -not-a-status\nerror.message: garbage",
    );
    assert.ok(err instanceof ApiError);
    assert.strictEqual(err.statusCode, 502);
    assert.strictEqual(sleepCalls.length, 1);
    assert.strictEqual(factory.created.length, 2);
  });

  it("auth 401 is terminal AUTH_ERROR — single attempt, zero sleeps", async () => {
    const raw401 = "MCP error -401\nerror.code: 100\nerror.message: unauthorised";
    const { err, sleepCalls, factory } = await captureErrorWithEvidence(raw401);
    assert.ok(err instanceof AuthError);
    assert.strictEqual(err.code, "AUTH_ERROR");
    assert.strictEqual(err.statusCode, 401);
    assert.strictEqual(sleepCalls.length, 0);
    assert.strictEqual(factory.created.length, 1);
  });

  it("auth 403 is terminal AUTH_ERROR with statusCode 403", async () => {
    const raw403 = "MCP error -403\nerror.code: 100\nerror.message: forbidden";
    const { err, sleepCalls, factory } = await captureErrorWithEvidence(raw403);
    assert.ok(err instanceof ScoutlineError);
    assert.strictEqual(err.code, "AUTH_ERROR");
    assert.strictEqual(err.statusCode, 403);
    assert.strictEqual(sleepCalls.length, 0);
    assert.strictEqual(factory.created.length, 1);
  });

  it("other 4xx (404) is terminal API_ERROR: 1 transport, 1 close, 0 sleeps", async () => {
    // Mirrors P6-09A / GATE-6 HIGH 1 negative probe: 4xx other than
    // 429 must remain terminal under the widened classifier.
    const raw404 = "MCP error -404\nerror.code: 100\nerror.message: not found";
    const { err, sleepCalls, factory } = await captureErrorWithEvidence(raw404);
    assert.ok(err instanceof ApiError);
    assert.strictEqual(err.code, "API_ERROR");
    assert.strictEqual(err.statusCode, 404);
    // Transports: one (no retry).
    assert.strictEqual(
      factory.created.length,
      1,
      "terminal 404 must construct exactly one transport",
    );
    // Closes: the single transport's `finally` closes once.
    const closes = factory.created.reduce((sum, t) => sum + t.fake.closeCount, 0);
    assert.strictEqual(closes, 1, "terminal 404 transport must close exactly once");
    assert.strictEqual(factory.created[0].port.closeEntered, 1);
    // Sleeps: none.
    assert.deepStrictEqual(sleepCalls, [], "terminal 404 must not sleep");
  });

  it("transient 429 (no exhausted meaning) is retryable — exactly two attempts", async () => {
    const raw429 = "MCP error -429\nerror.code: 100\nerror.message: rate limited";
    const { err, sleepCalls, factory } = await captureErrorWithEvidence(raw429);
    assert.ok(err instanceof ApiError);
    assert.strictEqual(err.statusCode, 429);
    assert.strictEqual(sleepCalls.length, 1);
    assert.strictEqual(factory.created.length, 2);
  });

  it("encoded quota fixture cannot satisfy a valid-success shape", () => {
    // Direct characterization assertion: the encoded quota fixture raw
    // string is not a valid WebReader object response.
    const raw = "MCP error -429\nerror.code: 1310\nerror.message: Weekly/Monthly Limit Exhausted";
    assert.ok(typeof raw === "string");
    assert.ok(!raw.startsWith("{"));
  });
});

// ===========================================================================
// 6. Real dispatcher selection-order through `main()`
//
//   - default ZAI, explicit ZAI, environment ZAI all succeed.
//   - unsupported MiniMax (explicit or environment) returns
//     UNSUPPORTED_CAPABILITY with zero selected-Provider work.
//   - descriptor-advertises-but-Adapter-omits fail closed.
// ===========================================================================

describe("05 real dispatcher selection-order (main → read)", () => {
  function makeRecordingCacheMain() {
    const gets = [];
    const sets = [];
    const store = new Map();
    const cache = {
      gets,
      sets,
      store,
      async get(key) {
        gets.push(key);
        return store.has(key) ? store.get(key) : null;
      },
      async set(key, value) {
        sets.push({ key, value });
        store.set(key, value);
      },
    };
    return cache;
  }

  function makeRecordingAdapter(overrides = {}) {
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
      setExitCode: () => {},
      ...overrides,
    };
    return { adapter, stdout, stderr };
  }

  /**
   * Standard Z.AI descriptor wired to a fake UTCP client so the reader
   * capability can return a known valid WebReader response.
   */
  function makeZaiDescriptorWithFake({ raw }) {
    const factory = makeClientFactory({
      discoveredTools: DISCOVERED_READER_TOOLS,
      resultsByName: { [INTERNAL_WEB_READER]: raw },
    });
    return { descriptor: createZaiDescriptor({ clientFactory: factory }), factory };
  }

  it("default ZAI dispatches read through the Z.AI Adapter (success)", async () => {
    const { descriptor: zai } = makeZaiDescriptorWithFake({ raw: validRawResponse() });
    const minimax = createMiniMaxDescriptor();
    const cache = makeRecordingCacheMain();
    const { adapter, stdout, stderr } = makeRecordingAdapter();
    const status = await main(["read", "https://example.com/"], {
      env: { Z_AI_API_KEY: TEST_API_KEY },
      providerDescriptors: [zai, minimax],
      readerCache: cache,
      searchCache: cache,
      repositoryCache: cache,
      invocation: adapter,
    });
    assert.strictEqual(status, 0);
    assert.deepStrictEqual(stderr, []);
    const parsed = JSON.parse(stdout[0]);
    assert.strictEqual(parsed.schemaVersion, 1);
    assert.strictEqual(parsed.title, "Example Domain");
  });

  it("explicit --provider zai wins over SCOUTLINE_PROVIDER=minimax", async () => {
    const { descriptor: zai } = makeZaiDescriptorWithFake({ raw: validRawResponse() });
    const minimax = createMiniMaxDescriptor();
    const cache = makeRecordingCacheMain();
    const { adapter, stdout, stderr } = makeRecordingAdapter();
    const status = await main(["--provider", "zai", "read", "https://example.com/"], {
      env: { Z_AI_API_KEY: TEST_API_KEY, SCOUTLINE_PROVIDER: "minimax" },
      providerDescriptors: [zai, minimax],
      readerCache: cache,
      searchCache: cache,
      repositoryCache: cache,
      invocation: adapter,
    });
    assert.strictEqual(status, 0);
    assert.deepStrictEqual(stderr, []);
    assert.strictEqual(JSON.parse(stdout[0]).title, "Example Domain");
  });

  it("unsupported explicit MiniMax returns UNSUPPORTED_CAPABILITY with zero selected-Provider work", async () => {
    const { descriptor: zai, factory: zaiFactory } = makeZaiDescriptorWithFake({
      raw: validRawResponse(),
    });
    const minimax = createMiniMaxDescriptor();
    const cache = makeRecordingCacheMain();
    const { adapter, stderr } = makeRecordingAdapter();
    const status = await main(["--provider", "minimax", "read", "https://example.com/"], {
      env: { Z_AI_API_KEY: TEST_API_KEY, MINIMAX_API_KEY: "mm-key" },
      providerDescriptors: [zai, minimax],
      readerCache: cache,
      searchCache: cache,
      repositoryCache: cache,
      invocation: adapter,
    });
    assert.strictEqual(status, 1);
    assert.strictEqual(JSON.parse(stderr[0]).code, "UNSUPPORTED_CAPABILITY");
    // Zero cache reads/writes.
    assert.strictEqual(cache.gets.length, 0);
    assert.strictEqual(cache.sets.length, 0);
    // Zero Z.AI fallback transports.
    assert.strictEqual(zaiFactory.created.length, 0);
  });

  it("unsupported environment MiniMax returns UNSUPPORTED_CAPABILITY with zero selected-Provider work", async () => {
    const { descriptor: zai, factory: zaiFactory } = makeZaiDescriptorWithFake({
      raw: validRawResponse(),
    });
    const minimax = createMiniMaxDescriptor();
    const cache = makeRecordingCacheMain();
    const { adapter, stderr } = makeRecordingAdapter();
    const status = await main(["read", "https://example.com/"], {
      env: {
        Z_AI_API_KEY: TEST_API_KEY,
        MINIMAX_API_KEY: "mm-key",
        SCOUTLINE_PROVIDER: "minimax",
      },
      providerDescriptors: [zai, minimax],
      readerCache: cache,
      searchCache: cache,
      repositoryCache: cache,
      invocation: adapter,
    });
    assert.strictEqual(status, 1);
    assert.strictEqual(JSON.parse(stderr[0]).code, "UNSUPPORTED_CAPABILITY");
    assert.strictEqual(cache.gets.length, 0);
    assert.strictEqual(cache.sets.length, 0);
    assert.strictEqual(zaiFactory.created.length, 0);
  });

  it("descriptor advertises reader but Adapter omits reader → fail closed", async () => {
    // Production path: createZaiDescriptor supplies the reader handle.
    // For this test we build a Z.AI-shaped descriptor that advertises
    // the capability but omits the handle, then assert main() returns
    // UNSUPPORTED_CAPABILITY.
    const descriptor = {
      id: "zai",
      isConfigured: () => true,
      capabilities: () => new Set(["search", "reader"]),
      create: () => ({ id: "zai" }), // no `reader` handle
    };
    const minimax = createMiniMaxDescriptor();
    const cache = makeRecordingCacheMain();
    const { adapter, stderr } = makeRecordingAdapter();
    const status = await main(["read", "https://example.com/"], {
      env: { Z_AI_API_KEY: TEST_API_KEY },
      providerDescriptors: [descriptor, minimax],
      readerCache: cache,
      searchCache: cache,
      repositoryCache: cache,
      invocation: adapter,
    });
    assert.strictEqual(status, 1);
    assert.strictEqual(JSON.parse(stderr[0]).code, "UNSUPPORTED_CAPABILITY");
  });

  it("MiniMax descriptor continues to advertise no reader", () => {
    // Static metadata proof — locks the MiniMax advertisement so a
    // future regression cannot silently enable reader selection.
    const minimax = createMiniMaxDescriptor();
    assert.ok(!minimax.capabilities().has("reader"));
    const adapter = minimax.create({ env: {} });
    assert.strictEqual(adapter.reader, undefined);
  });
});

// ===========================================================================
// 7. Z.AI malformed grammar remains malformed through main() — Reader
//    has no degenerate empty state. Re-asserting here keeps the
//    negative-space contract visible next to the cross-Adapter parity
//    proofs.
// ===========================================================================

describe("05 Z.AI malformed WebReader response remains malformed through main()", () => {
  const FIXED_NOW = 1_700_000_000_000;

  function makeRecordingAdapter(overrides = {}) {
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
      setExitCode: () => {},
      ...overrides,
    };
    return { adapter, stdout, stderr };
  }

  function makeRecordingCacheMain() {
    const store = new Map();
    const cache = {
      gets: [],
      sets: [],
      store,
      async get(key) {
        cache.gets.push(key);
        return store.has(key) ? store.get(key) : null;
      },
      async set(key, value) {
        cache.sets.push({ key, value });
        store.set(key, value);
      },
    };
    return cache;
  }

  async function runOne({ descriptor, argv, mode = "data" }) {
    const cache = makeRecordingCacheMain();
    const recorder = makeRecordingAdapter({ environmentOutputMode: undefined });
    const sleepCalls = [];
    const status = await main([...(mode === "data" ? [] : ["-O", mode]), ...argv], {
      env: { Z_AI_API_KEY: TEST_API_KEY },
      providerDescriptors: [descriptor],
      readerCache: cache,
      readerSleep: (ms) => {
        sleepCalls.push(ms);
        return Promise.resolve();
      },
      readerRandom: () => 0,
      searchCache: cache,
      searchSleep: (ms) => {
        sleepCalls.push(ms);
        return Promise.resolve();
      },
      searchRandom: () => 0,
      repositoryCache: cache,
      repositorySleep: (ms) => {
        sleepCalls.push(ms);
        return Promise.resolve();
      },
      repositoryRandom: () => 0,
      invocation: recorder.adapter,
      now: () => FIXED_NOW,
    });
    return {
      status,
      stderr: recorder.stderr,
      stdout: recorder.stdout,
      cache,
      sleepCalls,
    };
  }

  function buildZaiDescriptor({ raw }) {
    const factory = makeClientFactory({
      discoveredTools: DISCOVERED_READER_TOOLS,
      resultsByName: { [INTERNAL_WEB_READER]: raw },
    });
    return createZaiDescriptor({ clientFactory: factory });
  }

  it("Z.AI null WebReader response returns status 1 with API_ERROR and retries exactly once (injected sleep)", async () => {
    const zaiDescriptor = buildZaiDescriptor({ raw: null });
    const result = await runOne({
      descriptor: zaiDescriptor,
      argv: ["read", "https://example.com/"],
      mode: "data",
    });
    assert.strictEqual(result.status, 1);
    assert.strictEqual(JSON.parse(result.stderr[0]).code, "API_ERROR");
    // Retryable 502 → exactly one retry, exactly one injected sleep
    // call. No production wall-clock backoff or jitter is consulted
    // because the harness injects deterministic sleep/random.
    assert.strictEqual(
      result.sleepCalls.length,
      1,
      `retryable 502 must trigger exactly one sleep; got ${result.sleepCalls.length}`,
    );
    // The injected sleep call uses the documented base delay
    // (500 ms × 2^0) plus zero jitter from the injected random.
    assert.strictEqual(result.sleepCalls[0], 500);
  });

  it("Z.AI bare-string non-MCP-error response returns status 1 with API_ERROR and retries exactly once", async () => {
    const zaiDescriptor = buildZaiDescriptor({
      raw: "some prose without an MCP error envelope",
    });
    const result = await runOne({
      descriptor: zaiDescriptor,
      argv: ["read", "https://example.com/"],
      mode: "data",
    });
    assert.strictEqual(result.status, 1);
    assert.strictEqual(JSON.parse(result.stderr[0]).code, "API_ERROR");
    assert.strictEqual(result.sleepCalls.length, 1);
    assert.strictEqual(result.sleepCalls[0], 500);
  });
});
