/**
 * Tavily Map Capability tests (T06, tech-plan §2b, §4, §7).
 *
 * Verifies the Tavily Map Capability built on the generic
 * executeCachedOperation wrapper:
 *   - Normalization: results[] (string array) -> urls[]
 *   - Control mapping: depth, breadth, limit, selectPaths, excludePaths,
 *     instructions
 *   - Error wrapping: auth, 432, generic 5xx
 *   - Cache identity: SHA-256 fingerprint
 *   - decodeCached round-trip
 *   - Validation: non-http URL, out-of-range depth/breadth/limit
 *
 * Tests inject a single fake `fetch` through
 * `TavilyAdapterDependencies.transport`; the fake returns Response-shaped
 * objects (ok/status/json/text). No real network is touched.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { createTavilyDescriptor } from "../dist/providers/tavily/adapter.js";
import { ApiError, AuthError, ValidationError } from "../dist/lib/errors.js";
import { executeCachedOperation } from "../dist/lib/execution.js";

const TEST_API_KEY = "tvly-test-key-DO-NOT-LEAK";
const EXPECTED_FINGERPRINT = crypto.createHash("sha256").update(TEST_API_KEY).digest("hex");

// ---------------------------------------------------------------------------
// Fake fetch helpers (mirrors tavily-crawl.test.js)
// ---------------------------------------------------------------------------

function makeResponse({ ok = true, status = 200, json, body = "" } = {}) {
  return {
    ok,
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    json: async () => json,
  };
}

function makeAdapter(fakeFetch) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    return fakeFetch(url, init);
  };
  const descriptor = createTavilyDescriptor({
    transport: { fetch: fn, env: { TAVILY_TIMEOUT: "5000" } },
  });
  const adapter = descriptor.create({ env: { TAVILY_API_KEY: TEST_API_KEY } });
  return { adapter, calls };
}

function makeErrorFetch(status, body) {
  return async () =>
    makeResponse({ ok: false, status, body: body ?? '{"detail":{"error":"msg"}}' });
}

function trivialCache() {
  const store = new Map();
  return {
    async get(k) {
      return store.has(k) ? store.get(k) : null;
    },
    async set(k, v) {
      store.set(k, v);
    },
    store,
  };
}

function trivialDeps() {
  return { cache: trivialCache(), sleep: async () => {}, random: () => 0 };
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

describe("Tavily Map Adapter — normalization", () => {
  it("maps results (string array) to urls[] with totalUrls count", async () => {
    const mapJson = {
      results: [
        "https://docs.example.com/page1",
        "https://docs.example.com/page2",
        "https://docs.example.com/page3",
      ],
    };
    const { adapter, calls } = makeAdapter(async () => makeResponse({ json: mapJson }));

    const result = await adapter.map.fetch.invoke({
      url: "https://docs.example.com",
    });

    assert.equal(result.schemaVersion, 1);
    assert.equal(result.baseUrl, "https://docs.example.com");
    assert.equal(result.totalUrls, 3);
    assert.deepEqual(result.urls, [
      "https://docs.example.com/page1",
      "https://docs.example.com/page2",
      "https://docs.example.com/page3",
    ]);

    // Verify the request body carries the URL.
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.url, "https://docs.example.com");
  });

  it("handles an empty results array", async () => {
    const { adapter } = makeAdapter(async () => makeResponse({ json: { results: [] } }));
    const result = await adapter.map.fetch.invoke({ url: "https://example.com" });
    assert.equal(result.totalUrls, 0);
    assert.deepEqual(result.urls, []);
  });

  it("rejects a malformed response (missing results array)", async () => {
    const { adapter } = makeAdapter(async () => makeResponse({ json: { foo: "bar" } }));
    await assert.rejects(
      () => adapter.map.fetch.invoke({ url: "https://example.com" }),
      (e) => e instanceof ApiError && e.statusCode === 500,
    );
  });

  it("rejects a malformed result entry (non-string url)", async () => {
    const { adapter } = makeAdapter(async () =>
      makeResponse({
        json: { results: ["ok", 123, "ok2"] },
      }),
    );
    await assert.rejects(
      () => adapter.map.fetch.invoke({ url: "https://example.com" }),
      (e) => e instanceof ApiError && e.statusCode === 500,
    );
  });
});

// ---------------------------------------------------------------------------
// Control mapping
// ---------------------------------------------------------------------------

describe("Tavily Map Adapter — control mapping", () => {
  it("maps depth → max_depth", async () => {
    const { adapter, calls } = makeAdapter(async () => makeResponse({ json: { results: [] } }));
    await adapter.map.fetch.invoke({ url: "https://example.com", depth: 3 });
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.max_depth, 3);
  });

  it("maps breadth → max_breadth", async () => {
    const { adapter, calls } = makeAdapter(async () => makeResponse({ json: { results: [] } }));
    await adapter.map.fetch.invoke({ url: "https://example.com", breadth: 50 });
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.max_breadth, 50);
  });

  it("maps limit → limit", async () => {
    const { adapter, calls } = makeAdapter(async () => makeResponse({ json: { results: [] } }));
    await adapter.map.fetch.invoke({ url: "https://example.com", limit: 10 });
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.limit, 10);
  });

  it("maps selectPaths (comma-separated) → select_paths array", async () => {
    const { adapter, calls } = makeAdapter(async () => makeResponse({ json: { results: [] } }));
    await adapter.map.fetch.invoke({
      url: "https://example.com",
      selectPaths: "/api/.*, /guide/.*",
    });
    const body = JSON.parse(calls[0].init.body);
    assert.deepEqual(body.select_paths, ["/api/.*", "/guide/.*"]);
  });

  it("maps excludePaths → exclude_paths array", async () => {
    const { adapter, calls } = makeAdapter(async () => makeResponse({ json: { results: [] } }));
    await adapter.map.fetch.invoke({
      url: "https://example.com",
      excludePaths: "/private/.*",
    });
    const body = JSON.parse(calls[0].init.body);
    assert.deepEqual(body.exclude_paths, ["/private/.*"]);
  });

  it("maps instructions → instructions", async () => {
    const { adapter, calls } = makeAdapter(async () => makeResponse({ json: { results: [] } }));
    await adapter.map.fetch.invoke({
      url: "https://example.com",
      instructions: "Focus on API documentation pages",
    });
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.instructions, "Focus on API documentation pages");
  });

  it("omits unset controls from the request body", async () => {
    const { adapter, calls } = makeAdapter(async () => makeResponse({ json: { results: [] } }));
    await adapter.map.fetch.invoke({ url: "https://example.com" });
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.url, "https://example.com");
    assert.equal(body.max_depth, undefined);
    assert.equal(body.max_breadth, undefined);
    assert.equal(body.limit, undefined);
    assert.equal(body.select_paths, undefined);
    assert.equal(body.exclude_paths, undefined);
    assert.equal(body.instructions, undefined);
  });

  it("does NOT send format, contentSize/extract_depth, or timeout on the map endpoint", async () => {
    // Map returns URLs only — those crawl-only controls must not leak onto
    // the /map request body.
    const { adapter, calls } = makeAdapter(async () => makeResponse({ json: { results: [] } }));
    await adapter.map.fetch.invoke({ url: "https://example.com" });
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.format, undefined);
    assert.equal(body.extract_depth, undefined);
    assert.equal(body.timeout, undefined);
  });
});

// ---------------------------------------------------------------------------
// Error wrapping
// ---------------------------------------------------------------------------

describe("Tavily Map Adapter — failure normalization", () => {
  it("maps 401 to AuthError", async () => {
    const { adapter } = makeAdapter(makeErrorFetch(401));
    await assert.rejects(
      () => adapter.map.fetch.invoke({ url: "https://example.com" }),
      (e) => e instanceof AuthError,
    );
  });

  it("maps 432 to ApiError(432) — terminal", async () => {
    const { adapter } = makeAdapter(makeErrorFetch(432));
    await assert.rejects(
      () => adapter.map.fetch.invoke({ url: "https://example.com" }),
      (e) => e instanceof ApiError && e.statusCode === 432 && e.retryable === false,
    );
  });

  it("maps 5xx to ApiError with the real status", async () => {
    const { adapter } = makeAdapter(makeErrorFetch(503));
    await assert.rejects(
      () => adapter.map.fetch.invoke({ url: "https://example.com" }),
      (e) => e instanceof ApiError && e.statusCode === 503,
    );
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe("Tavily Map Adapter — validation", () => {
  it("rejects a non-http(s) URL with ValidationError", () => {
    const { adapter } = makeAdapter(async () => makeResponse());
    assert.throws(
      () => adapter.map.fetch.validate({ url: "ftp://example.com" }),
      (e) => e instanceof ValidationError,
    );
  });

  it("rejects depth < 1", () => {
    const { adapter } = makeAdapter(async () => makeResponse());
    assert.throws(
      () => adapter.map.fetch.validate({ url: "https://example.com", depth: 0 }),
      (e) => e instanceof ValidationError,
    );
  });

  it("rejects depth > 5", () => {
    const { adapter } = makeAdapter(async () => makeResponse());
    assert.throws(
      () => adapter.map.fetch.validate({ url: "https://example.com", depth: 6 }),
      (e) => e instanceof ValidationError,
    );
  });

  it("rejects breadth > 500", () => {
    const { adapter } = makeAdapter(async () => makeResponse());
    assert.throws(
      () => adapter.map.fetch.validate({ url: "https://example.com", breadth: 501 }),
      (e) => e instanceof ValidationError,
    );
  });

  it("rejects limit <= 0", () => {
    const { adapter } = makeAdapter(async () => makeResponse());
    assert.throws(
      () => adapter.map.fetch.validate({ url: "https://example.com", limit: 0 }),
      (e) => e instanceof ValidationError,
    );
  });

  it("accepts valid depth, breadth, and limit", () => {
    const { adapter } = makeAdapter(async () => makeResponse());
    // Should not throw.
    adapter.map.fetch.validate({
      url: "https://example.com",
      depth: 5,
      breadth: 500,
      limit: 100,
    });
  });
});

// ---------------------------------------------------------------------------
// Cache identity
// ---------------------------------------------------------------------------

describe("Tavily Map Adapter — cache identity", () => {
  it("produces a map identity with SHA-256 fingerprint", () => {
    const { adapter } = makeAdapter(async () => makeResponse());
    const identity = adapter.map.fetch.cacheIdentity({
      url: "https://example.com",
    });
    assert.equal(identity.provider, "tavily");
    assert.equal(identity.capability, "map");
    assert.equal(identity.credentialFingerprint, EXPECTED_FINGERPRINT);
    assert.equal(identity.request.url, "https://example.com");
  });

  it("includes controls in the cache identity request", () => {
    const { adapter } = makeAdapter(async () => makeResponse());
    const identity = adapter.map.fetch.cacheIdentity({
      url: "https://example.com",
      depth: 2,
      breadth: 10,
    });
    assert.equal(identity.request.depth, 2);
    assert.equal(identity.request.breadth, 10);
  });
});

// ---------------------------------------------------------------------------
// decodeCached round-trip
// ---------------------------------------------------------------------------

describe("Tavily Map Adapter — decodeCached", () => {
  it("round-trips a valid MapResult", () => {
    const { adapter } = makeAdapter(async () => makeResponse());
    const value = {
      schemaVersion: 1,
      baseUrl: "https://example.com",
      urls: ["https://example.com/page1"],
      totalUrls: 1,
    };
    const decoded = adapter.map.fetch.decodeCached(value);
    assert.deepEqual(decoded, value);
  });

  it("returns null for a malformed value", () => {
    const { adapter } = makeAdapter(async () => makeResponse());
    assert.equal(adapter.map.fetch.decodeCached({ foo: "bar" }), null);
    assert.equal(adapter.map.fetch.decodeCached(null), null);
    assert.equal(adapter.map.fetch.decodeCached(42), null);
  });

  it("returns null for wrong schemaVersion", () => {
    const { adapter } = makeAdapter(async () => makeResponse());
    assert.equal(
      adapter.map.fetch.decodeCached({
        schemaVersion: 2,
        baseUrl: "https://example.com",
        urls: [],
        totalUrls: 0,
      }),
      null,
    );
  });

  it("returns null for malformed urls array", () => {
    const { adapter } = makeAdapter(async () => makeResponse());
    assert.equal(
      adapter.map.fetch.decodeCached({
        schemaVersion: 1,
        baseUrl: "https://example.com",
        urls: "not-an-array",
        totalUrls: 0,
      }),
      null,
    );
  });
});

// ---------------------------------------------------------------------------
// executeCachedOperation integration (cache round-trip)
// ---------------------------------------------------------------------------

describe("Tavily Map Adapter — executeCachedOperation integration", () => {
  it("caches a result and returns it on the second call without invoking", async () => {
    let invokeCount = 0;
    const mapJson = { results: ["https://example.com/p1"] };
    const { adapter } = makeAdapter(async () => {
      invokeCount++;
      return makeResponse({ json: mapJson });
    });

    const deps = trivialDeps();
    const request = { url: "https://example.com" };

    // First call invokes the transport.
    const result1 = await executeCachedOperation(adapter.map.fetch, request, {}, deps);
    assert.equal(invokeCount, 1);
    assert.equal(result1.totalUrls, 1);

    // Second call should hit the cache — no new transport invocation.
    const result2 = await executeCachedOperation(adapter.map.fetch, request, {}, deps);
    assert.equal(invokeCount, 1);
    assert.deepEqual(result2, result1);
  });

  it("bypasses cache with noCache: true", async () => {
    let invokeCount = 0;
    const mapJson = { results: ["https://example.com/p1"] };
    const { adapter } = makeAdapter(async () => {
      invokeCount++;
      return makeResponse({ json: mapJson });
    });

    const deps = trivialDeps();
    const request = { url: "https://example.com" };

    await executeCachedOperation(adapter.map.fetch, request, { noCache: true }, deps);
    await executeCachedOperation(adapter.map.fetch, request, { noCache: true }, deps);
    assert.equal(invokeCount, 2);
  });
});
