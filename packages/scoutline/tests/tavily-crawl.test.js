/**
 * Tavily Crawl Capability tests (T05, tech-plan §2a, §4, §7).
 *
 * Verifies the Tavily Crawl Capability built on the generic
 * executeCachedOperation wrapper:
 *   - Normalization: results[].url/raw_content → pages[]
 *   - Control mapping: depth, breadth, limit, selectPaths, excludePaths,
 *     instructions, format, contentSize, timeout
 *   - Error wrapping: auth, 432, generic 5xx
 *   - Cache identity: SHA-256 fingerprint, no legacy candidates
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
import { fetchTavilyCrawl } from "../dist/providers/tavily/client.js";
import { ApiError, AuthError, ValidationError } from "../dist/lib/errors.js";
import { executeCachedOperation } from "../dist/lib/execution.js";

const TEST_API_KEY = "tvly-test-key-DO-NOT-LEAK";
const EXPECTED_FINGERPRINT = crypto.createHash("sha256").update(TEST_API_KEY).digest("hex");

// ---------------------------------------------------------------------------
// Fake fetch helpers (mirrors tavily-adapter.test.js)
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

describe("Tavily Crawl Adapter — normalization", () => {
  it("maps results[].url/raw_content to pages[] with contentFormat", async () => {
    const crawlJson = {
      results: [
        {
          url: "https://docs.example.com/page1",
          raw_content: "# Page One\n\nContent one.",
        },
        {
          url: "https://docs.example.com/page2",
          raw_content: "# Page Two\n\nContent two.",
        },
      ],
    };
    const { adapter, calls } = makeAdapter(async () => makeResponse({ json: crawlJson }));

    const result = await adapter.crawl.fetch.invoke({
      url: "https://docs.example.com",
    });

    assert.equal(result.schemaVersion, 1);
    assert.equal(result.baseUrl, "https://docs.example.com");
    assert.equal(result.totalPages, 2);
    assert.equal(result.pages[0].url, "https://docs.example.com/page1");
    assert.equal(result.pages[0].content, "# Page One\n\nContent one.");
    assert.equal(result.pages[0].contentFormat, "markdown");
    assert.equal(result.pages[1].url, "https://docs.example.com/page2");

    // Verify the request body carries the URL.
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.url, "https://docs.example.com");
  });

  it("defaults contentFormat to markdown when format is omitted", async () => {
    const crawlJson = {
      results: [{ url: "https://example.com", raw_content: "text" }],
    };
    const { adapter } = makeAdapter(async () => makeResponse({ json: crawlJson }));
    const result = await adapter.crawl.fetch.invoke({ url: "https://example.com" });
    assert.equal(result.pages[0].contentFormat, "markdown");
  });

  it("respects format: text", async () => {
    const crawlJson = {
      results: [{ url: "https://example.com", raw_content: "plain text" }],
    };
    const { adapter } = makeAdapter(async () => makeResponse({ json: crawlJson }));
    const result = await adapter.crawl.fetch.invoke({
      url: "https://example.com",
      format: "text",
    });
    assert.equal(result.pages[0].contentFormat, "text");
  });

  it("sets totalPages from results array length", async () => {
    const crawlJson = {
      results: [
        { url: "https://example.com/a", raw_content: "a" },
        { url: "https://example.com/b", raw_content: "b" },
        { url: "https://example.com/c", raw_content: "c" },
      ],
    };
    const { adapter } = makeAdapter(async () => makeResponse({ json: crawlJson }));
    const result = await adapter.crawl.fetch.invoke({ url: "https://example.com" });
    assert.equal(result.totalPages, 3);
  });

  it("handles an empty results array", async () => {
    const { adapter } = makeAdapter(async () => makeResponse({ json: { results: [] } }));
    const result = await adapter.crawl.fetch.invoke({ url: "https://example.com" });
    assert.equal(result.totalPages, 0);
    assert.deepEqual(result.pages, []);
  });

  it("rejects a malformed response (missing results array)", async () => {
    const { adapter } = makeAdapter(async () => makeResponse({ json: { foo: "bar" } }));
    await assert.rejects(
      () => adapter.crawl.fetch.invoke({ url: "https://example.com" }),
      (e) => e instanceof ApiError && e.statusCode === 500,
    );
  });

  it("rejects a malformed result entry (non-string url)", async () => {
    const { adapter } = makeAdapter(async () =>
      makeResponse({
        json: { results: [{ url: 123, raw_content: "c" }] },
      }),
    );
    await assert.rejects(
      () => adapter.crawl.fetch.invoke({ url: "https://example.com" }),
      (e) => e instanceof ApiError && e.statusCode === 500,
    );
  });
});

// ---------------------------------------------------------------------------
// Control mapping
// ---------------------------------------------------------------------------

describe("Tavily Crawl Adapter — control mapping", () => {
  it("maps depth → max_depth", async () => {
    const { adapter, calls } = makeAdapter(async () => makeResponse({ json: { results: [] } }));
    await adapter.crawl.fetch.invoke({ url: "https://example.com", depth: 3 });
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.max_depth, 3);
  });

  it("maps breadth → max_breadth", async () => {
    const { adapter, calls } = makeAdapter(async () => makeResponse({ json: { results: [] } }));
    await adapter.crawl.fetch.invoke({ url: "https://example.com", breadth: 50 });
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.max_breadth, 50);
  });

  it("maps limit → limit", async () => {
    const { adapter, calls } = makeAdapter(async () => makeResponse({ json: { results: [] } }));
    await adapter.crawl.fetch.invoke({ url: "https://example.com", limit: 10 });
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.limit, 10);
  });

  it("maps selectPaths (comma-separated) → select_paths array", async () => {
    const { adapter, calls } = makeAdapter(async () => makeResponse({ json: { results: [] } }));
    await adapter.crawl.fetch.invoke({
      url: "https://example.com",
      selectPaths: "/api/.*, /guide/.*",
    });
    const body = JSON.parse(calls[0].init.body);
    assert.deepEqual(body.select_paths, ["/api/.*", "/guide/.*"]);
  });

  it("maps excludePaths → exclude_paths array", async () => {
    const { adapter, calls } = makeAdapter(async () => makeResponse({ json: { results: [] } }));
    await adapter.crawl.fetch.invoke({
      url: "https://example.com",
      excludePaths: "/private/.*",
    });
    const body = JSON.parse(calls[0].init.body);
    assert.deepEqual(body.exclude_paths, ["/private/.*"]);
  });

  it("maps instructions → instructions", async () => {
    const { adapter, calls } = makeAdapter(async () => makeResponse({ json: { results: [] } }));
    await adapter.crawl.fetch.invoke({
      url: "https://example.com",
      instructions: "Focus on API documentation pages",
    });
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.instructions, "Focus on API documentation pages");
  });

  it("maps format → format", async () => {
    const { adapter, calls } = makeAdapter(async () => makeResponse({ json: { results: [] } }));
    await adapter.crawl.fetch.invoke({ url: "https://example.com", format: "text" });
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.format, "text");
  });

  it("maps contentSize medium → extract_depth: basic, high → advanced", async () => {
    for (const [size, expected] of [
      ["medium", "basic"],
      ["high", "advanced"],
    ]) {
      const { adapter, calls } = makeAdapter(async () => makeResponse({ json: { results: [] } }));
      await adapter.crawl.fetch.invoke({ url: "https://example.com", contentSize: size });
      const body = JSON.parse(calls[0].init.body);
      assert.equal(body.extract_depth, expected);
    }
  });

  it("maps timeout → timeout", async () => {
    const { adapter, calls } = makeAdapter(async () => makeResponse({ json: { results: [] } }));
    await adapter.crawl.fetch.invoke({ url: "https://example.com", timeout: 60 });
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.timeout, 60);
  });

  it("omits unset controls from the request body", async () => {
    const { adapter, calls } = makeAdapter(async () => makeResponse({ json: { results: [] } }));
    await adapter.crawl.fetch.invoke({ url: "https://example.com" });
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.url, "https://example.com");
    assert.equal(body.max_depth, undefined);
    assert.equal(body.max_breadth, undefined);
    assert.equal(body.limit, undefined);
    assert.equal(body.select_paths, undefined);
  });
});

// ---------------------------------------------------------------------------
// Error wrapping
// ---------------------------------------------------------------------------

describe("Tavily Crawl Adapter — failure normalization", () => {
  it("maps 401 to AuthError", async () => {
    const { adapter } = makeAdapter(makeErrorFetch(401));
    await assert.rejects(
      () => adapter.crawl.fetch.invoke({ url: "https://example.com" }),
      (e) => e instanceof AuthError,
    );
  });

  it("maps 432 to ApiError(432) — terminal", async () => {
    const { adapter } = makeAdapter(makeErrorFetch(432));
    await assert.rejects(
      () => adapter.crawl.fetch.invoke({ url: "https://example.com" }),
      (e) => e instanceof ApiError && e.statusCode === 432 && e.retryable === false,
    );
  });

  it("maps 5xx to ApiError with the real status", async () => {
    const { adapter } = makeAdapter(makeErrorFetch(503));
    await assert.rejects(
      () => adapter.crawl.fetch.invoke({ url: "https://example.com" }),
      (e) => e instanceof ApiError && e.statusCode === 503,
    );
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe("Tavily Crawl Adapter — validation", () => {
  it("rejects a non-http(s) URL with ValidationError", () => {
    const { adapter } = makeAdapter(async () => makeResponse());
    assert.throws(
      () => adapter.crawl.fetch.validate({ url: "ftp://example.com" }),
      (e) => e instanceof ValidationError,
    );
  });

  it("rejects depth < 1", () => {
    const { adapter } = makeAdapter(async () => makeResponse());
    assert.throws(
      () => adapter.crawl.fetch.validate({ url: "https://example.com", depth: 0 }),
      (e) => e instanceof ValidationError,
    );
  });

  it("rejects depth > 5", () => {
    const { adapter } = makeAdapter(async () => makeResponse());
    assert.throws(
      () => adapter.crawl.fetch.validate({ url: "https://example.com", depth: 6 }),
      (e) => e instanceof ValidationError,
    );
  });

  it("rejects breadth > 500", () => {
    const { adapter } = makeAdapter(async () => makeResponse());
    assert.throws(
      () => adapter.crawl.fetch.validate({ url: "https://example.com", breadth: 501 }),
      (e) => e instanceof ValidationError,
    );
  });

  it("rejects limit <= 0", () => {
    const { adapter } = makeAdapter(async () => makeResponse());
    assert.throws(
      () => adapter.crawl.fetch.validate({ url: "https://example.com", limit: 0 }),
      (e) => e instanceof ValidationError,
    );
  });

  it("accepts valid depth, breadth, and limit", () => {
    const { adapter } = makeAdapter(async () => makeResponse());
    // Should not throw.
    adapter.crawl.fetch.validate({
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

describe("Tavily Crawl Adapter — cache identity", () => {
  it("produces a crawl identity with SHA-256 fingerprint", () => {
    const { adapter } = makeAdapter(async () => makeResponse());
    const identity = adapter.crawl.fetch.cacheIdentity({
      url: "https://example.com",
    });
    assert.equal(identity.provider, "tavily");
    assert.equal(identity.capability, "crawl");
    assert.equal(identity.credentialFingerprint, EXPECTED_FINGERPRINT);
    assert.equal(identity.request.url, "https://example.com");
  });

  it("includes controls in the cache identity request", () => {
    const { adapter } = makeAdapter(async () => makeResponse());
    const identity = adapter.crawl.fetch.cacheIdentity({
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

describe("Tavily Crawl Adapter — decodeCached", () => {
  it("round-trips a valid CrawlResult", () => {
    const { adapter } = makeAdapter(async () => makeResponse());
    const value = {
      schemaVersion: 1,
      baseUrl: "https://example.com",
      pages: [
        {
          url: "https://example.com/page1",
          content: "Page one content",
          contentFormat: "markdown",
        },
      ],
      totalPages: 1,
    };
    const decoded = adapter.crawl.fetch.decodeCached(value);
    assert.deepEqual(decoded, value);
  });

  it("returns null for a malformed value", () => {
    const { adapter } = makeAdapter(async () => makeResponse());
    assert.equal(adapter.crawl.fetch.decodeCached({ foo: "bar" }), null);
    assert.equal(adapter.crawl.fetch.decodeCached(null), null);
    assert.equal(adapter.crawl.fetch.decodeCached(42), null);
  });

  it("returns null for wrong schemaVersion", () => {
    const { adapter } = makeAdapter(async () => makeResponse());
    assert.equal(
      adapter.crawl.fetch.decodeCached({
        schemaVersion: 2,
        baseUrl: "https://example.com",
        pages: [],
        totalPages: 0,
      }),
      null,
    );
  });

  it("returns null for malformed pages array", () => {
    const { adapter } = makeAdapter(async () => makeResponse());
    assert.equal(
      adapter.crawl.fetch.decodeCached({
        schemaVersion: 1,
        baseUrl: "https://example.com",
        pages: "not-an-array",
        totalPages: 0,
      }),
      null,
    );
  });
});

// ---------------------------------------------------------------------------
// executeCachedOperation integration (cache round-trip)
// ---------------------------------------------------------------------------

describe("Tavily Crawl Adapter — executeCachedOperation integration", () => {
  it("caches a result and returns it on the second call without invoking", async () => {
    let invokeCount = 0;
    const crawlJson = {
      results: [{ url: "https://example.com/p1", raw_content: "content" }],
    };
    const { adapter } = makeAdapter(async () => {
      invokeCount++;
      return makeResponse({ json: crawlJson });
    });

    const deps = trivialDeps();
    const request = { url: "https://example.com" };

    // First call invokes the transport.
    const result1 = await executeCachedOperation(adapter.crawl.fetch, request, {}, deps);
    assert.equal(invokeCount, 1);
    assert.equal(result1.totalPages, 1);

    // Second call should hit the cache — no new transport invocation.
    const result2 = await executeCachedOperation(adapter.crawl.fetch, request, {}, deps);
    assert.equal(invokeCount, 1);
    assert.deepEqual(result2, result1);
  });

  it("bypasses cache with noCache: true", async () => {
    let invokeCount = 0;
    const crawlJson = {
      results: [{ url: "https://example.com/p1", raw_content: "content" }],
    };
    const { adapter } = makeAdapter(async () => {
      invokeCount++;
      return makeResponse({ json: crawlJson });
    });

    const deps = trivialDeps();
    const request = { url: "https://example.com" };

    await executeCachedOperation(adapter.crawl.fetch, request, { noCache: true }, deps);
    await executeCachedOperation(adapter.crawl.fetch, request, { noCache: true }, deps);
    assert.equal(invokeCount, 2);
  });
});

// ===========================================================================
// Client-side timeout respects the server-side ceiling (I-2)
// ===========================================================================
//
// The crawl command sends body.timeout (seconds, default 150) to Tavily as
// the server-side work ceiling, but the transport's AbortController
// defaulted to TAVILY_TIMEOUT (30s). Any crawl >30s was aborted client-side
// regardless of --timeout. fetchTavilyCrawl now arms the client timer for at
// least (server ceiling * 1000 + 5s buffer), taking the max with the
// transport default.

describe("Tavily Crawl transport — client-side timeout (I-2)", () => {
  // A fake setTimeout that records the requested delay and never fires (the
  // fake fetch resolves immediately, so the abort callback is cleared before
  // it would run). We only assert on the recorded delay.
  function recordingTimers() {
    const delays = [];
    return {
      delays,
      setTimeout: (_fn, ms) => {
        delays.push(ms);
        return 1;
      },
      clearTimeout: () => {},
    };
  }

  it("client timeout >= server ceiling when params.timeout exceeds the transport default", async () => {
    const t = recordingTimers();
    await fetchTavilyCrawl(
      "key",
      "https://example.com",
      { timeout: 120 },
      { fetch: async () => makeResponse({ json: { results: [] } }), ...t, env: {} },
    );
    assert.equal(t.delays.length, 1);
    // max(30000 transport default, 120*1000 + 5000) = 125000
    assert.ok(t.delays[0] >= 120 * 1000 + 5000, `expected >= 125000, got ${t.delays[0]}`);
  });

  it("client timeout keeps the transport default when it exceeds the server ceiling", async () => {
    const t = recordingTimers();
    await fetchTavilyCrawl(
      "key",
      "https://example.com",
      { timeout: 10 },
      {
        fetch: async () => makeResponse({ json: { results: [] } }),
        ...t,
        env: { TAVILY_TIMEOUT: "60000" },
      },
    );
    assert.equal(t.delays.length, 1);
    // max(60000, 10*1000 + 5000 = 15000) = 60000
    assert.ok(t.delays[0] >= 60000, `expected >= 60000, got ${t.delays[0]}`);
  });

  it("client timeout defaults the server ceiling to 150s when params.timeout is absent", async () => {
    const t = recordingTimers();
    await fetchTavilyCrawl("key", "https://example.com", undefined, {
      fetch: async () => makeResponse({ json: { results: [] } }),
      ...t,
      env: {},
    });
    assert.equal(t.delays.length, 1);
    // default 150s → max(30000, 155000) = 155000
    assert.ok(t.delays[0] >= 150 * 1000 + 5000, `expected >= 155000, got ${t.delays[0]}`);
  });
});
