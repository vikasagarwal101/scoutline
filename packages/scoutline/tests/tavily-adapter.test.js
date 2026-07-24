/**
 * Tavily Adapter conformance tests (T04, DESIGN.md §7, tech-plan §7).
 *
 * Verifies the Tavily direct-HTTP transport Adapter:
 *   - Search validation: empty query, --location rejection
 *   - Search normalization: results[].title/url/content -> title/url/summary
 *   - Search control mapping: domain, recency, contentSize, topic
 *   - Search failure normalization: auth, timeout, 429, 432, 433, generic
 *   - Search cache identity: SHA-256 fingerprint, no legacy candidates
 *   - Reader validation: non-http URL, Z.AI-only option rejection
 *   - Reader normalization: raw_content -> content, finalUrl, title null
 *   - Reader failed_results -> terminal ApiError 422
 *   - Reader cache identity + decodeCached round-trip
 *
 * Tests inject a single fake `fetch` through
 * `TavilyAdapterDependencies.transport`; the fake returns Response-shaped
 * objects (ok/status/json/text). No real network is touched.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { createTavilyDescriptor } from "../dist/providers/tavily/adapter.js";
import {
  ApiError,
  AuthError,
  TimeoutError,
  UnsupportedOptionError,
  ValidationError,
} from "../dist/lib/errors.js";

const TEST_API_KEY = "tvly-test-key-DO-NOT-LEAK";
const EXPECTED_FINGERPRINT = crypto.createHash("sha256").update(TEST_API_KEY).digest("hex");

// ---------------------------------------------------------------------------
// Fake fetch helpers
// ---------------------------------------------------------------------------

function makeResponse({ ok = true, status = 200, json, body = "" } = {}) {
  return {
    ok,
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    json: async () => json,
  };
}

function makeFetchSequence(responses) {
  const calls = [];
  let i = 0;
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    const resp = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (resp.throw) throw resp.throw;
    return makeResponse(resp);
  };
  return { fn, calls };
}

/**
 * Build a descriptor + adapter with a single-fetch fake. Returns the
 * adapter and the calls array so the test can inspect the request.
 */
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

// ---------------------------------------------------------------------------
// Search: validation
// ---------------------------------------------------------------------------

describe("Tavily Search Adapter — validation", () => {
  it("rejects an empty query with ValidationError", () => {
    const { adapter } = makeAdapter(async () => makeResponse());
    assert.throws(
      () => adapter.search.validate({ query: "   " }),
      (e) => e instanceof ValidationError,
    );
  });

  it("rejects --location with UnsupportedOptionError", () => {
    const { adapter } = makeAdapter(async () => makeResponse());
    assert.throws(
      () =>
        adapter.search.validate({
          query: "test",
          controls: { location: "us" },
        }),
      (e) => e instanceof UnsupportedOptionError && e.message.includes("location"),
    );
  });

  it("rejects --type with UnsupportedOptionError", () => {
    const { adapter } = makeAdapter(async () => makeResponse());
    assert.throws(
      () =>
        adapter.search.validate({
          query: "test",
          controls: { type: "video" },
        }),
      (e) => e instanceof UnsupportedOptionError && e.message.includes("type"),
    );
  });

  it("accepts domain, recency, contentSize, and topic controls", () => {
    const { adapter } = makeAdapter(async () => makeResponse());
    // Should not throw — Tavily supports these natively.
    adapter.search.validate({
      query: "test",
      controls: {
        domain: "example.com",
        recency: "oneWeek",
        contentSize: "high",
        topic: "news",
      },
    });
  });
});

// ---------------------------------------------------------------------------
// Search: normalization
// ---------------------------------------------------------------------------

describe("Tavily Search Adapter — normalization", () => {
  it("maps results[].title/url/content to title/url/summary and drops score", async () => {
    const searchJson = {
      results: [
        {
          title: "Example",
          url: "https://example.com",
          content: "Summary text",
          score: 0.95,
        },
        {
          title: "Second",
          url: "https://second.com",
          content: "More text",
          score: 0.8,
        },
      ],
    };
    const { adapter, calls } = makeAdapter(async () => makeResponse({ json: searchJson }));

    const sources = await adapter.search.invoke({ query: "test" });

    assert.equal(sources.length, 2);
    assert.deepEqual(sources[0], {
      title: "Example",
      url: "https://example.com",
      summary: "Summary text",
    });
    assert.deepEqual(sources[1], {
      title: "Second",
      url: "https://second.com",
      summary: "More text",
    });
    // score is NOT in any output field.
    assert.equal(sources[0].source, undefined);

    // Verify the request body.
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.query, "test");
    assert.equal(body.score, undefined);
  });

  it("rejects a malformed response (missing results array)", async () => {
    const { adapter } = makeAdapter(async () => makeResponse({ json: { foo: "bar" } }));
    await assert.rejects(
      () => adapter.search.invoke({ query: "test" }),
      (e) => e instanceof ApiError && e.statusCode === 500,
    );
  });

  it("rejects a malformed result entry (non-string title)", async () => {
    const { adapter } = makeAdapter(async () =>
      makeResponse({
        json: { results: [{ title: 123, url: "https://x.com", content: "c" }] },
      }),
    );
    await assert.rejects(
      () => adapter.search.invoke({ query: "test" }),
      (e) => e instanceof ApiError && e.statusCode === 500,
    );
  });
});

// ---------------------------------------------------------------------------
// Search: control mapping
// ---------------------------------------------------------------------------

describe("Tavily Search Adapter — control mapping", () => {
  it("maps domain → include_domains: [domain]", async () => {
    const { adapter, calls } = makeAdapter(async () => makeResponse({ json: { results: [] } }));
    await adapter.search.invoke({
      query: "test",
      controls: { domain: "example.com" },
    });
    const body = JSON.parse(calls[0].init.body);
    assert.deepEqual(body.include_domains, ["example.com"]);
  });

  it("maps recency oneWeek → time_range: week", async () => {
    const { adapter, calls } = makeAdapter(async () => makeResponse({ json: { results: [] } }));
    await adapter.search.invoke({
      query: "test",
      controls: { recency: "oneWeek" },
    });
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.time_range, "week");
  });

  it("maps recency oneDay → time_range: day, oneMonth → month, oneYear → year", async () => {
    for (const [recency, expected] of [
      ["oneDay", "day"],
      ["oneMonth", "month"],
      ["oneYear", "year"],
    ]) {
      const { adapter, calls } = makeAdapter(async () => makeResponse({ json: { results: [] } }));
      await adapter.search.invoke({
        query: "test",
        controls: { recency },
      });
      const body = JSON.parse(calls[0].init.body);
      assert.equal(body.time_range, expected);
    }
  });

  it("omits time_range when recency is noLimit", async () => {
    const { adapter, calls } = makeAdapter(async () => makeResponse({ json: { results: [] } }));
    await adapter.search.invoke({
      query: "test",
      controls: { recency: "noLimit" },
    });
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.time_range, undefined);
  });

  it("maps contentSize medium → search_depth: basic, high → advanced", async () => {
    for (const [size, expected] of [
      ["medium", "basic"],
      ["high", "advanced"],
    ]) {
      const { adapter, calls } = makeAdapter(async () => makeResponse({ json: { results: [] } }));
      await adapter.search.invoke({
        query: "test",
        controls: { contentSize: size },
      });
      const body = JSON.parse(calls[0].init.body);
      assert.equal(body.search_depth, expected);
    }
  });

  it("passes topic natively as-is", async () => {
    const { adapter, calls } = makeAdapter(async () => makeResponse({ json: { results: [] } }));
    await adapter.search.invoke({
      query: "test",
      controls: { topic: "news" },
    });
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.topic, "news");
  });
});

// ---------------------------------------------------------------------------
// Search: failure normalization
// ---------------------------------------------------------------------------

describe("Tavily Search Adapter — failure normalization", () => {
  it("maps 401 to AuthError with TAVILY_API_KEY help", async () => {
    const { adapter } = makeAdapter(makeErrorFetch(401));
    await assert.rejects(
      () => adapter.search.invoke({ query: "test" }),
      (e) => e instanceof AuthError && e.help && e.help.includes("TAVILY_API_KEY"),
    );
  });

  it("maps 403 to AuthError", async () => {
    const { adapter } = makeAdapter(makeErrorFetch(403));
    await assert.rejects(
      () => adapter.search.invoke({ query: "test" }),
      (e) => e instanceof AuthError,
    );
  });

  it("maps 408 to TimeoutError preserving the configured duration", async () => {
    const { adapter } = makeAdapter(makeErrorFetch(408));
    await assert.rejects(
      () => adapter.search.invoke({ query: "test" }),
      (e) => e instanceof TimeoutError && e.durationMs === 5000,
    );
  });

  it("maps 504 to TimeoutError", async () => {
    const { adapter } = makeAdapter(makeErrorFetch(504));
    await assert.rejects(
      () => adapter.search.invoke({ query: "test" }),
      (e) => e instanceof TimeoutError && e.durationMs === 5000,
    );
  });

  it("maps 429 to ApiError(429) — retryable", async () => {
    const { adapter } = makeAdapter(makeErrorFetch(429));
    await assert.rejects(
      () => adapter.search.invoke({ query: "test" }),
      (e) =>
        e instanceof ApiError && e.statusCode === 429 && e.message === "Tavily rate limit exceeded",
    );
  });

  it("maps 432 to ApiError(432) with plan-limit message — terminal (NOT QuotaError)", async () => {
    const { adapter } = makeAdapter(makeErrorFetch(432));
    await assert.rejects(
      () => adapter.search.invoke({ query: "test" }),
      (e) =>
        e instanceof ApiError &&
        e.statusCode === 432 &&
        e.message.includes("plan limit exceeded") &&
        e.retryable === false,
    );
  });

  it("maps 433 to ApiError(433) with paygo-limit message — terminal", async () => {
    const { adapter } = makeAdapter(makeErrorFetch(433));
    await assert.rejects(
      () => adapter.search.invoke({ query: "test" }),
      (e) =>
        e instanceof ApiError &&
        e.statusCode === 433 &&
        e.message.includes("pay-as-you-go") &&
        e.retryable === false,
    );
  });

  it("maps 5xx to ApiError with the real status", async () => {
    const { adapter } = makeAdapter(makeErrorFetch(503));
    await assert.rejects(
      () => adapter.search.invoke({ query: "test" }),
      (e) => e instanceof ApiError && e.statusCode === 503,
    );
  });

  it("maps AbortError (fetch throw) to TimeoutError", async () => {
    const { adapter } = makeAdapter(async () => {
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      throw err;
    });
    await assert.rejects(
      () => adapter.search.invoke({ query: "test" }),
      (e) => e instanceof TimeoutError,
    );
  });

  it("maps network errors (ECONNREFUSED) to NetworkError", async () => {
    const { adapter } = makeAdapter(async () => {
      throw new Error("fetch failed: ECONNREFUSED");
    });
    await assert.rejects(
      () => adapter.search.invoke({ query: "test" }),
      (e) => e.constructor.name === "NetworkError" && e.message === "Tavily network error",
    );
  });
});

// ---------------------------------------------------------------------------
// Search: cache identity
// ---------------------------------------------------------------------------

describe("Tavily Search Adapter — cache identity", () => {
  it("produces a SHA-256 credential fingerprint with no legacy candidates", () => {
    const { adapter } = makeAdapter(async () => makeResponse());
    const identity = adapter.search.cacheIdentity({ query: "test" });
    assert.equal(identity.provider, "tavily");
    assert.equal(identity.capability, "search");
    assert.equal(identity.credentialFingerprint, EXPECTED_FINGERPRINT);
    assert.equal(identity.legacyCandidates, undefined);
    assert.equal(identity.request.query, "test");
  });

  it("includes controls in the cache identity request", () => {
    const { adapter } = makeAdapter(async () => makeResponse());
    const identity = adapter.search.cacheIdentity({
      query: "test",
      controls: { topic: "news" },
    });
    assert.equal(identity.request.controls.topic, "news");
  });
});

// ---------------------------------------------------------------------------
// Reader: validation
// ---------------------------------------------------------------------------

describe("Tavily Reader Adapter — validation", () => {
  it("rejects a non-http(s) URL with ValidationError", () => {
    const { adapter } = makeAdapter(async () => makeResponse());
    assert.throws(
      () => adapter.reader.fetch.validate({ url: "ftp://example.com" }),
      (e) => e instanceof ValidationError,
    );
  });

  it("rejects withLinksSummary with UnsupportedOptionError", () => {
    const { adapter } = makeAdapter(async () => makeResponse());
    assert.throws(
      () =>
        adapter.reader.fetch.validate({
          url: "https://example.com",
          withLinksSummary: true,
        }),
      (e) => e instanceof UnsupportedOptionError && e.message.includes("withLinksSummary"),
    );
  });

  it("rejects noGfm, keepImgDataUrl, withImagesSummary", () => {
    const { adapter } = makeAdapter(async () => makeResponse());
    for (const opt of ["noGfm", "keepImgDataUrl", "withImagesSummary"]) {
      assert.throws(
        () =>
          adapter.reader.fetch.validate({
            url: "https://example.com",
            [opt]: true,
          }),
        (e) => e instanceof UnsupportedOptionError && e.message.includes(opt),
      );
    }
  });

  it("accepts a valid http(s) URL with retainImages and timeout", () => {
    const { adapter } = makeAdapter(async () => makeResponse());
    // Should not throw.
    adapter.reader.fetch.validate({
      url: "https://example.com",
      retainImages: false,
      timeout: 10000,
    });
  });

  it("accepts Z.AI-only options set to false (command handler default)", () => {
    const { adapter } = makeAdapter(async () => makeResponse());
    // The read command handler sets boolean options to `false` (not
    // `undefined`) when the flag is absent. These must NOT throw —
    // `false` means the user didn't enable the option.
    adapter.reader.fetch.validate({
      url: "https://example.com",
      withLinksSummary: false,
      noGfm: false,
      keepImgDataUrl: false,
      withImagesSummary: false,
    });
  });
});

// ---------------------------------------------------------------------------
// Reader: normalization
// ---------------------------------------------------------------------------

describe("Tavily Reader Adapter — normalization", () => {
  it("maps raw_content → content, url → finalUrl, title → null", async () => {
    const extractJson = {
      results: [
        {
          url: "https://example.com/page",
          raw_content: "# Page Title\n\nContent here.",
        },
      ],
    };
    const { adapter, calls } = makeAdapter(async () => makeResponse({ json: extractJson }));

    const result = await adapter.reader.fetch.invoke({
      url: "https://example.com",
    });

    assert.equal(result.schemaVersion, 1);
    assert.equal(result.url, "https://example.com");
    assert.equal(result.finalUrl, "https://example.com/page");
    assert.equal(result.title, null);
    assert.equal(result.content, "# Page Title\n\nContent here.");
    assert.equal(result.contentFormat, "markdown");

    // Verify the request body: urls is an array with the single URL.
    const body = JSON.parse(calls[0].init.body);
    assert.deepEqual(body.urls, ["https://example.com"]);
  });

  it("defaults contentFormat to markdown when format is omitted", async () => {
    const extractJson = {
      results: [{ url: "https://example.com", raw_content: "text" }],
    };
    const { adapter } = makeAdapter(async () => makeResponse({ json: extractJson }));
    const result = await adapter.reader.fetch.invoke({
      url: "https://example.com",
    });
    assert.equal(result.contentFormat, "markdown");
  });

  it("respects format: text", async () => {
    const extractJson = {
      results: [{ url: "https://example.com", raw_content: "plain text" }],
    };
    const { adapter } = makeAdapter(async () => makeResponse({ json: extractJson }));
    const result = await adapter.reader.fetch.invoke({
      url: "https://example.com",
      format: "text",
    });
    assert.equal(result.contentFormat, "text");
  });

  it("throws a terminal ApiError 422 when failed_results contains the requested URL", async () => {
    const extractJson = {
      results: [],
      failed_results: [{ url: "https://example.com", error: "timeout" }],
    };
    const { adapter } = makeAdapter(async () => makeResponse({ json: extractJson }));
    await assert.rejects(
      () => adapter.reader.fetch.invoke({ url: "https://example.com" }),
      (e) => e instanceof ApiError && e.statusCode === 422,
    );
  });

  it("rejects a malformed response (missing results)", async () => {
    const { adapter } = makeAdapter(async () => makeResponse({ json: { foo: "bar" } }));
    await assert.rejects(
      () => adapter.reader.fetch.invoke({ url: "https://example.com" }),
      (e) => e instanceof ApiError && e.statusCode === 500,
    );
  });

  it("rejects a malformed result (empty raw_content)", async () => {
    const { adapter } = makeAdapter(async () =>
      makeResponse({
        json: { results: [{ url: "https://example.com", raw_content: "" }] },
      }),
    );
    await assert.rejects(
      () => adapter.reader.fetch.invoke({ url: "https://example.com" }),
      (e) => e instanceof ApiError && e.statusCode === 500,
    );
  });
});

// ---------------------------------------------------------------------------
// Reader: failure normalization (same wrapper as search)
// ---------------------------------------------------------------------------

describe("Tavily Reader Adapter — failure normalization", () => {
  it("maps 401 to AuthError", async () => {
    const { adapter } = makeAdapter(makeErrorFetch(401));
    await assert.rejects(
      () => adapter.reader.fetch.invoke({ url: "https://example.com" }),
      (e) => e instanceof AuthError,
    );
  });

  it("maps 432 to ApiError(432) — not QuotaError(429)", async () => {
    const { adapter } = makeAdapter(makeErrorFetch(432));
    await assert.rejects(
      () => adapter.reader.fetch.invoke({ url: "https://example.com" }),
      (e) => e instanceof ApiError && e.statusCode === 432,
    );
  });
});

// ---------------------------------------------------------------------------
// Reader: cache identity
// ---------------------------------------------------------------------------

describe("Tavily Reader Adapter — cache identity", () => {
  it("produces a reader-fetch identity with empty legacyCandidates", () => {
    const { adapter } = makeAdapter(async () => makeResponse());
    const identity = adapter.reader.fetch.cacheIdentity({
      url: "https://example.com",
    });
    assert.equal(identity.provider, "tavily");
    assert.equal(identity.capability, "reader");
    assert.equal(identity.operation, "reader-fetch");
    assert.equal(identity.credentialFingerprint, EXPECTED_FINGERPRINT);
    assert.equal(identity.request.url, "https://example.com");
    assert.deepEqual(identity.legacyCandidates, []);
  });
});

// ---------------------------------------------------------------------------
// Reader: decodeCached round-trip
// ---------------------------------------------------------------------------

describe("Tavily Reader Adapter — decodeCached", () => {
  it("round-trips a valid ReaderFetchResult", () => {
    const { adapter } = makeAdapter(async () => makeResponse());
    const value = {
      schemaVersion: 1,
      url: "https://example.com",
      finalUrl: "https://example.com/page",
      title: null,
      content: "Some content",
      contentFormat: "markdown",
    };
    const decoded = adapter.reader.fetch.decodeCached(value);
    assert.deepEqual(decoded, value);
  });

  it("returns null for a malformed value", () => {
    const { adapter } = makeAdapter(async () => makeResponse());
    assert.equal(adapter.reader.fetch.decodeCached({ foo: "bar" }), null);
    assert.equal(adapter.reader.fetch.decodeCached(null), null);
    assert.equal(adapter.reader.fetch.decodeCached(42), null);
  });
});

// ---------------------------------------------------------------------------
// Descriptor metadata
// ---------------------------------------------------------------------------

describe("Tavily Descriptor — metadata", () => {
  it("advertises the full capability set", () => {
    const descriptor = createTavilyDescriptor();
    const caps = descriptor.capabilities();
    assert.ok(caps.has("search"));
    assert.ok(caps.has("reader"));
    assert.ok(caps.has("crawl"));
    assert.ok(caps.has("map"));
    assert.ok(caps.has("research"));
    assert.ok(caps.has("quota"));
    assert.ok(caps.has("diagnostics"));
  });

  it("isConfigured reflects TAVILY_API_KEY presence", () => {
    const descriptor = createTavilyDescriptor();
    assert.equal(descriptor.isConfigured({}), false);
    assert.equal(descriptor.isConfigured({ TAVILY_API_KEY: "  " }), false);
    assert.equal(descriptor.isConfigured({ TAVILY_API_KEY: "tvly-real" }), true);
  });

  it("create() returns an adapter with id tavily, search, reader, crawl, quota, and diagnostics", () => {
    const descriptor = createTavilyDescriptor();
    const adapter = descriptor.create({ env: { TAVILY_API_KEY: "tvly-real" } });
    assert.equal(adapter.id, "tavily");
    assert.ok(adapter.search);
    assert.ok(adapter.reader);
    assert.ok(adapter.crawl);
    assert.ok(adapter.quota);
    assert.ok(adapter.diagnostics);
  });
});
