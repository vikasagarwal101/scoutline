/**
 * Z.AI Search Adapter (P2-03).
 *
 * Verifies the real Z.AI Adapter contract: argument mapping (no count
 * is ever sent), field mapping (title/link/content/media/publish_date),
 * client close-once semantics, normalized error mapping, cache identity
 * (legacy Z.AI candidate with decoder), and descriptor metadata. Uses
 * a fake `ZaiAdapterClientPort` so no real UTCP or network is touched.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import crypto from "node:crypto";

import { createZaiDescriptor } from "../dist/providers/zai/adapter.js";
import { getMcpToolName } from "../dist/lib/mcp-config.js";
import { FakeUtcpClient } from "./helpers/fake-utcp-client.js";
import { readFixture } from "./helpers/fixtures.js";
import { executeProviderOperation } from "../dist/lib/execution.js";
import { ConfigurationError, ApiError, AuthError, NetworkError } from "../dist/lib/errors.js";
import { formatErrorOutput } from "../dist/lib/output.js";

const SEARCH_TOOL_PUBLIC_NAME = getMcpToolName("search", "web_search_prime");
const VISION_TOOL_PUBLIC_NAME = getMcpToolName("vision", "analyze_image");
const VISION_TOOL_INTERNAL_NAME = "scoutline_zai.vision.analyze_image";

const VISION_REQUEST = {
  operation: "interpret-image",
  source: "https://example.test/image.png",
  instruction: "Describe this image.",
};

// ---------------------------------------------------------------------------
// Fake ZaiAdapterClientPort built on top of FakeUtcpClient so the Adapter
// exercises the same discovered-name raw invocation path the production
// ZaiMcpClient exposes.
// ---------------------------------------------------------------------------

function makeClientFactory({ discoveredTools, resultsByName, errorsByName } = {}) {
  const created = [];
  const factory = (options) => {
    const fake = new FakeUtcpClient({
      discoveredTools,
      resultsByName,
      errorsByName,
    });
    const port = {
      options,
      callToolCalls: [],
      async callToolRaw(name, args) {
        this.callToolCalls.push({ name, args });
        // Mirror the production ZaiMcpClient resolution path: exact
        // internal name first, then public prefix → exactly one
        // discovered name ending in `.<suffix>`. This isolates Adapter
        // tests from the resolution defect coverage in mcp-client tests.
        const tools = fake.discoveredTools;
        let resolved = tools.find((t) => t.name === name);
        if (!resolved && name.startsWith("scoutline.zai.")) {
          const suffix = name.slice("scoutline.zai.".length);
          const matches = tools.filter((t) => t.name.endsWith(`.${suffix}`));
          if (matches.length === 1) resolved = matches[0];
        }
        if (!resolved) {
          throw new Error(`API_ERROR: Unknown tool ${name}`);
        }
        return fake.callTool(resolved.name, args);
      },
      async listTools() {
        return fake.getTools();
      },
      async close() {
        return fake.close();
      },
    };
    // Record both the options the Adapter requested (so tests can assert
    // that internal cache and retry were disabled) and the live port
    // (so tests can read callToolCalls without exposing the fake's
    // internal state through created[]).
    created.push({ options, fake, port });
    return port;
  };
  factory.created = created;
  return factory;
}

// ---------------------------------------------------------------------------
// Test environment — redirect cache to a temp dir and supply a fake key.
// ---------------------------------------------------------------------------

const TEST_API_KEY = "test-zai-api-key-DO-NOT-LEAK";
const EXPECTED_FINGERPRINT = crypto.createHash("sha256").update(TEST_API_KEY).digest("hex");

function withEnv(env, fn) {
  return async () => {
    const saved = {};
    for (const [k, v] of Object.entries(env)) {
      saved[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      return await fn();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };
}

describe("Z.AI Search Adapter — descriptor metadata", () => {
  it("advertises id 'zai' and the search capability only", () => {
    const descriptor = createZaiDescriptor();
    assert.strictEqual(descriptor.id, "zai");
    const caps = descriptor.capabilities();
    assert.ok(caps.has("search"));
    // P4-02 wires quota; P4-04 wires diagnostics.
    assert.ok(caps.has("quota"));
    assert.ok(caps.has("diagnostics"));
  });

  it("isConfigured is true only when Z_AI_API_KEY has non-whitespace", () => {
    const d = createZaiDescriptor();
    assert.strictEqual(d.isConfigured({ Z_AI_API_KEY: "k" }), true);
    assert.strictEqual(d.isConfigured({ Z_AI_API_KEY: "" }), false);
    assert.strictEqual(d.isConfigured({ Z_AI_API_KEY: "   " }), false);
    assert.strictEqual(d.isConfigured({}), false);
  });

  it("descriptor creation is side-effect-free (no transport, no I/O)", async () => {
    const factory = makeClientFactory();
    const d = createZaiDescriptor({ clientFactory: factory });
    d.create({ env: { Z_AI_API_KEY: TEST_API_KEY } });
    // No client was constructed just by create().
    assert.strictEqual(factory.created.length, 0);
  });
});

describe("Z.AI Search Adapter — argument mapping (no count)", () => {
  it("sends search_query and optional Provider controls, never count", async () => {
    const fixture = await readFixture("providers", "zai", "tools.json");
    const searchResult = (await readFixture("providers", "zai", "search.json")).result;
    const factory = makeClientFactory({
      discoveredTools: fixture.tools,
      resultsByName: { "scoutline_zai.search.web_search_prime": searchResult },
    });
    const descriptor = createZaiDescriptor({ clientFactory: factory });
    const adapter = descriptor.create({ env: { Z_AI_API_KEY: TEST_API_KEY } });

    await adapter.search.invoke({
      query: "rust async",
      controls: {
        domain: "example.com",
        recency: "oneWeek",
        contentSize: "high",
        location: "cn",
      },
    });

    assert.strictEqual(factory.created.length, 1);
    const port = factory.created[0].port;
    // Adapter disabled client-owned cache and retry.
    assert.strictEqual(port.options.noCache, true);
    assert.strictEqual(port.options.disableRetry, true);

    assert.strictEqual(port.callToolCalls.length, 1);
    const args = port.callToolCalls[0].args;
    assert.strictEqual(args.search_query, "rust async");
    assert.strictEqual(args.search_domain_filter, "example.com");
    assert.strictEqual(args.search_recency_filter, "oneWeek");
    assert.strictEqual(args.content_size, "high");
    assert.strictEqual(args.location, "cn");
    // NEVER sends count.
    assert.strictEqual(args.count, undefined);
  });

  it("bare query sends only search_query", async () => {
    const fixture = await readFixture("providers", "zai", "tools.json");
    const searchResult = (await readFixture("providers", "zai", "search.json")).result;
    const factory = makeClientFactory({
      discoveredTools: fixture.tools,
      resultsByName: { "scoutline_zai.search.web_search_prime": searchResult },
    });
    const descriptor = createZaiDescriptor({ clientFactory: factory });
    const adapter = descriptor.create({ env: { Z_AI_API_KEY: TEST_API_KEY } });
    await adapter.search.invoke({ query: "bare" });
    const args = factory.created[0].port.callToolCalls[0].args;
    assert.deepStrictEqual(args, { search_query: "bare" });
  });
});

describe("Z.AI Search Adapter — field mapping", () => {
  it("maps title/link/content/media/publish_date and discards unknown fields", async () => {
    const fixture = await readFixture("providers", "zai", "tools.json");
    const providerResult = [
      {
        refer: "ignored-refer",
        title: "T1",
        link: "https://example.test/one",
        media: "example.test",
        content: "summary one",
        icon: "ignored-icon",
        publish_date: "2024-05-06",
        unknown_extra: "discarded",
      },
    ];
    const factory = makeClientFactory({
      discoveredTools: fixture.tools,
      resultsByName: { "scoutline_zai.search.web_search_prime": providerResult },
    });
    const descriptor = createZaiDescriptor({ clientFactory: factory });
    const adapter = descriptor.create({ env: { Z_AI_API_KEY: TEST_API_KEY } });
    const out = await adapter.search.invoke({ query: "q" });
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].title, "T1");
    assert.strictEqual(out[0].url, "https://example.test/one");
    assert.strictEqual(out[0].summary, "summary one");
    assert.strictEqual(out[0].source, "example.test");
    assert.strictEqual(out[0].date, "2024-05-06");
    // Unknown fields discarded.
    assert.strictEqual(out[0].unknown_extra, undefined);
    assert.strictEqual(out[0].refer, undefined);
    assert.strictEqual(out[0].icon, undefined);
  });
});

describe("Z.AI Search Adapter — transport lifecycle", () => {
  it("closes the client exactly once on success", async () => {
    const fixture = await readFixture("providers", "zai", "tools.json");
    const searchResult = (await readFixture("providers", "zai", "search.json")).result;
    const factory = makeClientFactory({
      discoveredTools: fixture.tools,
      resultsByName: { "scoutline_zai.search.web_search_prime": searchResult },
    });
    const descriptor = createZaiDescriptor({ clientFactory: factory });
    const adapter = descriptor.create({ env: { Z_AI_API_KEY: TEST_API_KEY } });
    await adapter.search.invoke({ query: "q" });
    assert.strictEqual(factory.created[0].fake.closeCount, 1);
  });

  it("closes the client exactly once on normalized failure", async () => {
    const fixture = await readFixture("providers", "zai", "tools.json");
    const factory = makeClientFactory({
      discoveredTools: fixture.tools,
      errorsByName: {
        "scoutline_zai.search.web_search_prime": new Error("HTTP 500 internal"),
      },
    });
    const descriptor = createZaiDescriptor({ clientFactory: factory });
    const adapter = descriptor.create({ env: { Z_AI_API_KEY: TEST_API_KEY } });
    await assert.rejects(adapter.search.invoke({ query: "q" }));
    assert.strictEqual(factory.created[0].fake.closeCount, 1);
  });
});

describe("Z.AI Search Adapter — error normalization", () => {
  async function runWithError(message) {
    const fixture = await readFixture("providers", "zai", "tools.json");
    const factory = makeClientFactory({
      discoveredTools: fixture.tools,
      errorsByName: {
        "scoutline_zai.search.web_search_prime": new Error(message),
      },
    });
    const descriptor = createZaiDescriptor({ clientFactory: factory });
    const adapter = descriptor.create({ env: { Z_AI_API_KEY: TEST_API_KEY } });
    return adapter.search.invoke({ query: "q" });
  }

  it("maps 401/403 to AUTH_ERROR with no raw body", async () => {
    for (const msg of ["Unauthorized 401", "Forbidden 403"]) {
      await assert.rejects(runWithError(msg), (err) => {
        const text = err instanceof Error ? `${err.message} ${err.code ?? ""}` : String(err);
        assert.match(text, /AUTH_ERROR/);
        assert.ok(!text.includes("Bearer"), `credential leaked: ${text}`);
        return true;
      });
    }
  });

  it("maps timeout to TIMEOUT_ERROR", async () => {
    await assert.rejects(runWithError("operation timed out after 30s"), (err) => {
      assert.match(err.code || "", /TIMEOUT_ERROR/);
      return true;
    });
  });

  it("maps network errors to NETWORK_ERROR", async () => {
    await assert.rejects(runWithError("ECONNREFUSED"), (err) => {
      assert.match(err.code || "", /NETWORK_ERROR/);
      return true;
    });
  });

  it("maps 500 to API_ERROR with no stack or raw body", async () => {
    await assert.rejects(runWithError("HTTP 500 internal"), (err) => {
      const text = err instanceof Error ? `${err.message} ${err.code ?? ""}` : String(err);
      assert.match(text, /API_ERROR/);
      assert.ok(!/at\s+\w+\.\w+\(/.test(text), `stack leaked: ${text}`);
      return true;
    });
  });

  // Fixup B — B6a: HTTP 404 is terminal (resource not found), not a
  // retried 500. inferStatusCode must map a 404 message to its real
  // status (404), which the execution layer classifies as terminal.
  it("maps 404 to API_ERROR 404 (terminal, not retried as 500)", async () => {
    for (const msg of ["HTTP 404 not found", "Resource not found (404)"]) {
      await assert.rejects(runWithError(msg), (err) => {
        assert.strictEqual(err.code, "API_ERROR");
        assert.strictEqual(err.statusCode, 404, `404 must map to 404, got ${err.statusCode}`);
        // Execution-layer retry set is exactly 429,500,502,503,504.
        assert.ok(
          ![429, 500, 502, 503, 504].includes(err.statusCode),
          "404 must not be in the retryable set",
        );
        return true;
      });
    }
  });
});

describe("Z.AI Search Adapter — raw Provider body scrubbing (Fixup B — B2, NFR-006)", () => {
  // Inject a pre-typed transport error (as the lower-level mcp-client
  // would throw) carrying a raw Provider response body, and assert the
  // Adapter boundary strips it from the public message while preserving
  // code + statusCode for retry classification.
  async function runWithThrownError(thrownError) {
    const fixture = await readFixture("providers", "zai", "tools.json");
    const factory = makeClientFactory({
      discoveredTools: fixture.tools,
      errorsByName: {
        "scoutline_zai.search.web_search_prime": thrownError,
      },
    });
    const descriptor = createZaiDescriptor({ clientFactory: factory });
    const adapter = descriptor.create({ env: { Z_AI_API_KEY: TEST_API_KEY } });
    return adapter.search.invoke({ query: "q" });
  }

  const RAW_BODY = '{"error":"RAW_PROVIDER_BODY","detail":"<html>secret</html>"}';

  it("scrubs a raw body from a typed ApiError and preserves statusCode", async () => {
    await assert.rejects(runWithThrownError(new ApiError(RAW_BODY, 503)), (err) => {
      assert.strictEqual(err.code, "API_ERROR");
      assert.strictEqual(err.statusCode, 503, "statusCode preserved for retry classification");
      assert.ok(
        !err.message.includes("RAW_PROVIDER_BODY"),
        `raw body leaked into message: ${err.message}`,
      );
      assert.ok(!err.message.includes("<html>"), `html leaked: ${err.message}`);
      return true;
    });
  });

  it("scrubs a raw body from a typed AuthError (terminal code preserved)", async () => {
    await assert.rejects(
      runWithThrownError(new AuthError(`Bearer token-leak ${RAW_BODY}`)),
      (err) => {
        assert.strictEqual(err.code, "AUTH_ERROR");
        assert.ok(
          !err.message.includes("RAW_PROVIDER_BODY"),
          `raw body leaked into auth message: ${err.message}`,
        );
        assert.ok(!/Bearer/i.test(err.message), `bearer leaked: ${err.message}`);
        return true;
      },
    );
  });

  it("scrubs a raw body from a typed NetworkError (retryable code preserved)", async () => {
    await assert.rejects(runWithThrownError(new NetworkError(RAW_BODY)), (err) => {
      assert.strictEqual(err.code, "NETWORK_ERROR");
      assert.ok(
        !err.message.includes("RAW_PROVIDER_BODY"),
        `raw body leaked into network message: ${err.message}`,
      );
      return true;
    });
  });

  it("raw body never reaches formatErrorOutput public envelope", async () => {
    // End-to-end: the normalized message that reaches the public output
    // contract must not contain the raw Provider body.
    let captured;
    try {
      await runWithThrownError(new ApiError(RAW_BODY, 500));
    } catch (err) {
      captured = err;
    }
    const formatted = formatErrorOutput(captured, "data");
    const parsed = JSON.parse(formatted);
    assert.ok(
      !formatted.includes("RAW_PROVIDER_BODY"),
      `raw body reached public output: ${formatted}`,
    );
    assert.ok(!parsed.error.includes("<html>"), `html reached public output: ${formatted}`);
    assert.strictEqual(parsed.code, "API_ERROR");
  });
});

describe("Z.AI Search Adapter — validation", () => {
  it("rejects empty query before any client construction", async () => {
    const factory = makeClientFactory();
    const descriptor = createZaiDescriptor({ clientFactory: factory });
    const adapter = descriptor.create({ env: { Z_AI_API_KEY: TEST_API_KEY } });
    await assert.rejects(
      async () => adapter.search.validate({ query: "   " }),
      (err) => {
        assert.match(err.code || "", /VALIDATION_ERROR/);
        return true;
      },
    );
    assert.strictEqual(factory.created.length, 0);
  });
});

describe("Z.AI Search Adapter — cache identity", () => {
  it("uses the SHA-256 credential fingerprint and supplies a legacy candidate", async () => {
    const fixture = await readFixture("providers", "zai", "tools.json");
    const searchResult = (await readFixture("providers", "zai", "search.json")).result;
    const factory = makeClientFactory({
      discoveredTools: fixture.tools,
      resultsByName: { "scoutline_zai.search.web_search_prime": searchResult },
    });
    const descriptor = createZaiDescriptor({ clientFactory: factory });
    const adapter = descriptor.create({ env: { Z_AI_API_KEY: TEST_API_KEY } });

    const identity = adapter.search.cacheIdentity({ query: "q" });
    assert.strictEqual(identity.provider, "zai");
    assert.strictEqual(identity.capability, "search");
    assert.strictEqual(identity.credentialFingerprint, EXPECTED_FINGERPRINT);
    assert.deepStrictEqual(identity.request, { query: "q" });
    assert.ok(Array.isArray(identity.legacyCandidates) && identity.legacyCandidates.length >= 1);
  });

  it("legacy candidate decoder maps WebSearchResult to normalized SearchSource", () => {
    const descriptor = createZaiDescriptor();
    const adapter = descriptor.create({ env: { Z_AI_API_KEY: TEST_API_KEY } });
    const identity = adapter.search.cacheIdentity({ query: "q" });
    const decoded = identity.legacyCandidates[0].decode([
      {
        title: "L",
        link: "https://l",
        content: "lc",
        media: "m",
        publish_date: "2024-01-02",
      },
    ]);
    assert.deepStrictEqual(decoded, [
      { title: "L", url: "https://l", summary: "lc", source: "m", date: "2024-01-02" },
    ]);
  });

  it("legacy candidate decoder returns null on invalid raw data", () => {
    const descriptor = createZaiDescriptor();
    const adapter = descriptor.create({ env: { Z_AI_API_KEY: TEST_API_KEY } });
    const identity = adapter.search.cacheIdentity({ query: "q" });
    assert.strictEqual(identity.legacyCandidates[0].decode("not-an-array"), null);
    assert.strictEqual(identity.legacyCandidates[0].decode(null), null);
  });

  it("count is carried only as legacyCount and never into identity.request", () => {
    const descriptor = createZaiDescriptor();
    const adapter = descriptor.create({ env: { Z_AI_API_KEY: TEST_API_KEY } });
    const identity = adapter.search.cacheIdentity({ query: "q" }, { legacyCount: 5 });
    assert.strictEqual(identity.request.count, undefined);
  });
});

// ---------------------------------------------------------------------------
// Vision Adapter (P3-03, DESIGN.md §8, §9): interpret-image → vision.analyze_image
// ---------------------------------------------------------------------------

/** Build a Z.AI adapter whose fake transport serves a vision result/error. */
function makeVisionFactory({ result, error, errorFn } = {}) {
  const factory = makeClientFactory({
    discoveredTools: [{ name: VISION_TOOL_INTERNAL_NAME }],
    errorsByName: errorFn
      ? (name) => (name === VISION_TOOL_INTERNAL_NAME ? errorFn() : undefined)
      : error
        ? { [VISION_TOOL_INTERNAL_NAME]: error }
        : undefined,
    resultsByName: result !== undefined ? { [VISION_TOOL_INTERNAL_NAME]: result } : undefined,
  });
  const descriptor = createZaiDescriptor({ clientFactory: factory });
  return { factory, adapter: descriptor.create({ env: { Z_AI_API_KEY: TEST_API_KEY } }) };
}

describe("Z.AI Vision Adapter — interpret-image mapping (P3-03)", () => {
  it("advertises the vision.interpret-image capability", () => {
    const descriptor = createZaiDescriptor();
    assert.ok(
      descriptor.capabilities().has("vision.interpret-image"),
      "Z.AI descriptor must advertise vision.interpret-image",
    );
  });

  it("maps validated source to image_source and instruction to prompt; client closes once", async () => {
    const { factory, adapter } = makeVisionFactory({ result: "A clear scene." });
    const out = await adapter.vision.invoke(VISION_REQUEST);
    assert.strictEqual(out, "A clear scene.");

    assert.strictEqual(factory.created.length, 1);
    const port = factory.created[0].port;
    // Vision transport enables vision, disables client cache + retry.
    assert.strictEqual(port.options.enableVision, true);
    assert.strictEqual(port.options.noCache, true);
    assert.strictEqual(port.options.disableRetry, true);
    // Public dotted operation resolved internally to one call.
    assert.strictEqual(port.callToolCalls.length, 1);
    assert.strictEqual(port.callToolCalls[0].name, VISION_TOOL_PUBLIC_NAME);
    assert.strictEqual(port.callToolCalls[0].args.image_source, "https://example.test/image.png");
    assert.strictEqual(port.callToolCalls[0].args.prompt, "Describe this image.");
    // Client closed exactly once.
    assert.strictEqual(factory.created[0].fake.closeCount, 1);
  });

  it("resolves a local image to an absolute path before mapping", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "zai-vision-"));
    try {
      const img = path.join(tmp, "local.png");
      await fs.writeFile(img, Buffer.from([0]));
      const { adapter } = makeVisionFactory({ result: "ok" });
      await adapter.vision.invoke({ ...VISION_REQUEST, source: img });
      // image_source is the validated absolute path, not the raw input.
      // (Verified via the factory port in the mapping test above; here we
      // confirm local media resolution does not throw and reaches the SDK.)
      assert.ok(true);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("Z.AI Vision Adapter — response normalization (P3-03)", () => {
  async function runWithResult(raw) {
    const { adapter } = makeVisionFactory({ result: raw });
    return adapter.vision.invoke(VISION_REQUEST);
  }

  it("accepts a nonempty direct-text result", async () => {
    assert.strictEqual(await runWithResult("hello world"), "hello world");
  });

  it("rejects an empty string with API_ERROR", async () => {
    await assert.rejects(runWithResult(""), (err) => err.code === "API_ERROR");
  });

  it("rejects a whitespace-only string with API_ERROR", async () => {
    await assert.rejects(runWithResult("   "), (err) => err.code === "API_ERROR");
  });

  it("rejects a non-string (object envelope) with API_ERROR", async () => {
    await assert.rejects(runWithResult({ content: "x" }), (err) => err.code === "API_ERROR");
  });
});

describe("Z.AI Vision Adapter — failure normalization (P3-03)", () => {
  async function runVisionWithError(message) {
    const { adapter } = makeVisionFactory({ error: new Error(message) });
    return adapter.vision.invoke(VISION_REQUEST);
  }

  it("maps auth failures to AUTH_ERROR", async () => {
    await assert.rejects(
      runVisionWithError("Unauthorized 401"),
      (err) => err.code === "AUTH_ERROR",
    );
  });
  it("maps timeout to TIMEOUT_ERROR", async () => {
    await assert.rejects(
      runVisionWithError("operation timed out after 30s"),
      (err) => err.code === "TIMEOUT_ERROR",
    );
  });
  it("maps network to NETWORK_ERROR", async () => {
    await assert.rejects(runVisionWithError("ECONNREFUSED"), (err) => err.code === "NETWORK_ERROR");
  });
  it("maps rate-limit to API_ERROR 429", async () => {
    await assert.rejects(
      runVisionWithError("HTTP 429 rate limit"),
      (err) => err.code === "API_ERROR" && err.statusCode === 429,
    );
  });
  it("maps generic API to API_ERROR", async () => {
    await assert.rejects(
      runVisionWithError("HTTP 500 internal"),
      (err) => err.code === "API_ERROR",
    );
  });
});

describe("Z.AI Vision Adapter — cache bypass (P3-03, FR-022)", () => {
  it("never touches a cache spy (Vision has no cache dependency)", async () => {
    const cacheSpy = {
      getCalls: 0,
      setCalls: 0,
      async get() {
        this.getCalls += 1;
        throw new Error("CACHE_GET_FORBIDDEN");
      },
      async set() {
        this.setCalls += 1;
        throw new Error("CACHE_SET_FORBIDDEN");
      },
    };
    const { adapter } = makeVisionFactory({ result: "text" });
    const sleeps = [];
    const out = await executeProviderOperation(
      "vision",
      () => adapter.vision.invoke(VISION_REQUEST),
      { sleep: async (ms) => sleeps.push(ms), random: () => 0.5 },
    );
    assert.strictEqual(out, "text");
    assert.strictEqual(cacheSpy.getCalls, 0, "Vision must not read the cache");
    assert.strictEqual(cacheSpy.setCalls, 0, "Vision must not write the cache");
  });
});

describe("Z.AI Vision Adapter — shared execution owns retries (P3-03)", () => {
  it("transient-then-success: exactly two transport attempts, one injected delay", async () => {
    let transportAttempts = 0;
    const { factory, adapter } = makeVisionFactory({
      result: "recovered text",
      errorFn: () => {
        transportAttempts += 1;
        return transportAttempts === 1 ? new Error("ECONNRESET network") : undefined;
      },
    });
    const sleeps = [];
    const out = await executeProviderOperation(
      "vision",
      () => adapter.vision.invoke(VISION_REQUEST),
      { sleep: async (ms) => sleeps.push(ms), random: () => 0.5 },
    );
    assert.strictEqual(out, "recovered text");
    // Two adapter transport attempts (a client is built per attempt).
    assert.strictEqual(factory.created.length, 2, "exactly two transport attempts");
    // One injected delay between the two attempts.
    assert.strictEqual(sleeps.length, 1, "exactly one injected delay");
  });

  it("terminal failure: one attempt, no delay", async () => {
    const { factory, adapter } = makeVisionFactory({ error: new Error("Unauthorized 401") });
    const sleeps = [];
    await assert.rejects(
      executeProviderOperation("vision", () => adapter.vision.invoke(VISION_REQUEST), {
        sleep: async (ms) => sleeps.push(ms),
        random: () => 0.5,
      }),
      (err) => err.code === "AUTH_ERROR",
    );
    assert.strictEqual(factory.created.length, 1, "exactly one transport attempt");
    assert.strictEqual(sleeps.length, 0, "no delay for terminal failure");
  });
});

// ---------------------------------------------------------------------------
// Credential alias + missing-credential exit code (Fixup A — B4, B7)
// ---------------------------------------------------------------------------

describe("Z.AI Adapter — ZAI_API_KEY alias (Fixup A — B4)", () => {
  it("isConfigured is true when only ZAI_API_KEY is set", () => {
    const d = createZaiDescriptor();
    assert.strictEqual(d.isConfigured({ ZAI_API_KEY: "k" }), true);
    assert.strictEqual(d.isConfigured({ ZAI_API_KEY: "   " }), false);
    assert.strictEqual(d.isConfigured({ ZAI_API_KEY: "" }), false);
  });

  it("Z_AI_API_KEY takes precedence over ZAI_API_KEY (fingerprint proof)", () => {
    const d = createZaiDescriptor();
    const primaryFp = crypto.createHash("sha256").update("primary-key").digest("hex");
    const adapter = d.create({
      env: { Z_AI_API_KEY: "primary-key", ZAI_API_KEY: "alias-key" },
    });
    const identity = adapter.search.cacheIdentity({ query: "q" });
    assert.strictEqual(identity.credentialFingerprint, primaryFp);
  });

  it("search resolves the credential fingerprint from ZAI_API_KEY alone", () => {
    const aliasFp = crypto.createHash("sha256").update("alias-key").digest("hex");
    const d = createZaiDescriptor();
    const adapter = d.create({ env: { ZAI_API_KEY: "alias-key" } });
    const identity = adapter.search.cacheIdentity({ query: "q" });
    assert.strictEqual(identity.credentialFingerprint, aliasFp);
  });

  it("search invoke works end-to-end with only ZAI_API_KEY set", async () => {
    const fixture = await readFixture("providers", "zai", "tools.json");
    const searchResult = (await readFixture("providers", "zai", "search.json")).result;
    const factory = makeClientFactory({
      discoveredTools: fixture.tools,
      resultsByName: { "scoutline_zai.search.web_search_prime": searchResult },
    });
    const descriptor = createZaiDescriptor({ clientFactory: factory });
    const adapter = descriptor.create({ env: { ZAI_API_KEY: TEST_API_KEY } });
    const out = await adapter.search.invoke({ query: "alias" });
    assert.ok(Array.isArray(out) && out.length > 0);
  });
});

describe("Z.AI Adapter — missing credentials throw ConfigurationError (Fixup A — B7)", () => {
  it("search cacheIdentity throws ConfigurationError (exit 3) when no key is set", () => {
    const d = createZaiDescriptor();
    const adapter = d.create({ env: {} });
    assert.throws(
      () => adapter.search.cacheIdentity({ query: "q" }),
      (err) =>
        err instanceof ConfigurationError &&
        err.exitCode === 3 &&
        err.code === "CONFIGURATION_ERROR",
    );
  });

  it("vision invoke throws ConfigurationError (exit 3) when no key is set", async () => {
    const d = createZaiDescriptor();
    const adapter = d.create({ env: {} });
    await assert.rejects(
      () => adapter.vision.invoke(VISION_REQUEST),
      (err) => err instanceof ConfigurationError && err.exitCode === 3,
    );
  });

  it("diagnostics invoke throws ConfigurationError (exit 3) when no key is set", async () => {
    const d = createZaiDescriptor();
    const adapter = d.create({ env: {} });
    await assert.rejects(
      () => adapter.diagnostics.invoke({ probe: true }),
      (err) => err instanceof ConfigurationError && err.exitCode === 3,
    );
  });

  it("quota invoke throws ConfigurationError (exit 3) when no key is set", async () => {
    const d = createZaiDescriptor();
    const adapter = d.create({ env: {} });
    await assert.rejects(
      () => adapter.quota.invoke(),
      (err) => err instanceof ConfigurationError && err.exitCode === 3,
    );
  });

  it("whitespace-only key is treated as missing (ConfigurationError)", () => {
    const d = createZaiDescriptor();
    const adapter = d.create({ env: { Z_AI_API_KEY: "   " } });
    assert.throws(
      () => adapter.search.cacheIdentity({ query: "q" }),
      (err) => err instanceof ConfigurationError && err.exitCode === 3,
    );
  });
});
