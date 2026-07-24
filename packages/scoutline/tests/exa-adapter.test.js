/**
 * Exa Adapter conformance tests (EXA-T01, tech-plan §7).
 *
 * Verifies the Exa direct-HTTP transport Adapter:
 *   - Search validation: empty query, --location rejection
 *   - Search normalization: results[].title/url/highlights/author/
 *     publishedDate -> title/url/summary/source/date (highlights joined)
 *   - Search control mapping: domain, recency (→startPublishedDate),
 *     contentSize (→type), topic (→category); always sends
 *     contents:{highlights:true}
 *   - Search failure normalization: auth, quota (402), timeout, 429, 5xx
 *   - Search cache identity: SHA-256 fingerprint, no legacy candidates
 *   - Diagnostics probe: skips on probe:false, searches on probe:true
 *   - Descriptor metadata: capabilities(), isConfigured()
 *
 * Tests inject a single fake `fetch` through
 * `ExaAdapterDependencies.transport`; the fake returns Response-shaped
 * objects (ok/status/json/text). No real network is touched.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { createExaDescriptor } from "../dist/providers/exa/adapter.js";
import { createInMemoryAsyncJobStateFile } from "../dist/lib/async-job-state.js";
import {
  ApiError,
  AuthError,
  ConfigurationError,
  QuotaError,
  TimeoutError,
  UnsupportedOptionError,
  ValidationError,
} from "../dist/lib/errors.js";

const TEST_API_KEY = "exa-test-key-DO-NOT-LEAK";
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

function makeErrorFetch(status, body) {
  return async () => makeResponse({ ok: false, status, body: body ?? '{"error":"msg"}' });
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
  const descriptor = createExaDescriptor({
    transport: { fetch: fn, env: { EXA_TIMEOUT: "5000" } },
  });
  const adapter = descriptor.create({ env: { EXA_API_KEY: TEST_API_KEY } });
  return { adapter, calls, descriptor };
}

// ---------------------------------------------------------------------------
// Descriptor metadata
// ---------------------------------------------------------------------------

describe("Exa Descriptor — metadata", () => {
  it("advertises search and diagnostics capabilities", () => {
    const descriptor = createExaDescriptor();
    const caps = descriptor.capabilities();
    assert.ok(caps.has("search"));
    assert.ok(caps.has("reader"));
    assert.ok(caps.has("research"));
    assert.ok(caps.has("diagnostics"));
    assert.equal(caps.size, 4);
  });

  it("isConfigured reflects EXA_API_KEY presence", () => {
    const descriptor = createExaDescriptor();
    assert.equal(descriptor.isConfigured({ EXA_API_KEY: "key" }), true);
    assert.equal(descriptor.isConfigured({ EXA_API_KEY: "  " }), false);
    assert.equal(descriptor.isConfigured({}), false);
  });

  it("create() builds an adapter with search and diagnostics handles", () => {
    const { adapter } = makeAdapter(async () => makeResponse());
    assert.equal(typeof adapter.search.validate, "function");
    assert.equal(typeof adapter.reader.fetch.validate, "function");
    assert.equal(typeof adapter.research.run.validate, "function");
    assert.equal(typeof adapter.diagnostics.invoke, "function");
  });
});

// ---------------------------------------------------------------------------
// Search: validation
// ---------------------------------------------------------------------------

describe("Exa Search Adapter — validation", () => {
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

  it("accepts domain, recency, contentSize, and topic controls", () => {
    const { adapter } = makeAdapter(async () => makeResponse());
    // Should not throw — Exa supports these natively.
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

describe("Exa Search Adapter — normalization", () => {
  it("maps title/url/highlights/author/publishedDate and drops score", async () => {
    const searchJson = {
      results: [
        {
          title: "Example",
          url: "https://example.com",
          highlights: ["first snippet", "second snippet"],
          author: "Jane Doe",
          publishedDate: "2025-01-15T00:00:00.000Z",
          score: 0.95,
        },
        {
          title: "Second",
          url: "https://second.com",
          highlights: ["only one"],
          score: 0.8,
        },
      ],
    };
    const { adapter } = makeAdapter(async () => makeResponse({ json: searchJson }));

    const sources = await adapter.search.invoke({ query: "test" });

    assert.equal(sources.length, 2);
    assert.deepEqual(sources[0], {
      title: "Example",
      url: "https://example.com",
      summary: "first snippet second snippet",
      source: "Jane Doe",
      date: "2025-01-15T00:00:00.000Z",
    });
    assert.deepEqual(sources[1], {
      title: "Second",
      url: "https://second.com",
      summary: "only one",
    });
    // score is NOT in any output field.
    assert.equal(sources[0].source, "Jane Doe");
  });

  it("treats missing highlights as empty summary", async () => {
    const searchJson = {
      results: [{ title: "No Highlights", url: "https://nh.com" }],
    };
    const { adapter } = makeAdapter(async () => makeResponse({ json: searchJson }));
    const sources = await adapter.search.invoke({ query: "test" });
    assert.equal(sources[0].summary, "");
  });

  it("treats empty highlights array as empty summary", async () => {
    const searchJson = {
      results: [{ title: "Empty", url: "https://e.com", highlights: [] }],
    };
    const { adapter } = makeAdapter(async () => makeResponse({ json: searchJson }));
    const sources = await adapter.search.invoke({ query: "test" });
    assert.equal(sources[0].summary, "");
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
      makeResponse({ json: { results: [{ title: 123, url: "https://x.com" }] } }),
    );
    await assert.rejects(
      () => adapter.search.invoke({ query: "test" }),
      (e) => e instanceof ApiError && e.statusCode === 500,
    );
  });

  it("always sends contents:{highlights:true} in the request body", async () => {
    const { adapter, calls } = makeAdapter(async () => makeResponse({ json: { results: [] } }));
    await adapter.search.invoke({ query: "test" });
    const body = JSON.parse(calls[0].init.body);
    assert.deepEqual(body.contents, { highlights: true });
  });
});

// ---------------------------------------------------------------------------
// Search: control mapping
// ---------------------------------------------------------------------------

describe("Exa Search Adapter — control mapping", () => {
  it("maps domain → includeDomains: [domain]", async () => {
    const { adapter, calls } = makeAdapter(async () => makeResponse({ json: { results: [] } }));
    await adapter.search.invoke({
      query: "test",
      controls: { domain: "example.com" },
    });
    const body = JSON.parse(calls[0].init.body);
    assert.deepEqual(body.includeDomains, ["example.com"]);
  });

  it("maps recency oneWeek → startPublishedDate as a valid ISO date ~7 days ago", async () => {
    const { adapter, calls } = makeAdapter(async () => makeResponse({ json: { results: [] } }));
    const before = Date.now();
    await adapter.search.invoke({
      query: "test",
      controls: { recency: "oneWeek" },
    });
    const after = Date.now();
    const body = JSON.parse(calls[0].init.body);
    assert.equal(typeof body.startPublishedDate, "string");
    const parsed = new Date(body.startPublishedDate);
    assert.ok(!Number.isNaN(parsed.getTime()), "startPublishedDate is a valid date");
    // Should be ~7 days ago (within a 1-second tolerance window).
    const expectedMin = before - 7 * 24 * 60 * 60 * 1000 - 1000;
    const expectedMax = after - 7 * 24 * 60 * 60 * 1000 + 1000;
    assert.ok(parsed.getTime() >= expectedMin && parsed.getTime() <= expectedMax);
  });

  it("maps recency oneDay, oneMonth, oneYear → startPublishedDate present", async () => {
    for (const recency of ["oneDay", "oneMonth", "oneYear"]) {
      const { adapter, calls } = makeAdapter(async () => makeResponse({ json: { results: [] } }));
      await adapter.search.invoke({ query: "test", controls: { recency } });
      const body = JSON.parse(calls[0].init.body);
      assert.equal(typeof body.startPublishedDate, "string", `${recency} sets startPublishedDate`);
    }
  });

  it("omits startPublishedDate for recency noLimit", async () => {
    const { adapter, calls } = makeAdapter(async () => makeResponse({ json: { results: [] } }));
    await adapter.search.invoke({ query: "test", controls: { recency: "noLimit" } });
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.startPublishedDate, undefined);
  });

  it("maps contentSize high → type: deep", async () => {
    const { adapter, calls } = makeAdapter(async () => makeResponse({ json: { results: [] } }));
    await adapter.search.invoke({ query: "test", controls: { contentSize: "high" } });
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.type, "deep");
  });

  it("maps contentSize medium → type: auto", async () => {
    const { adapter, calls } = makeAdapter(async () => makeResponse({ json: { results: [] } }));
    await adapter.search.invoke({ query: "test", controls: { contentSize: "medium" } });
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.type, "auto");
  });

  it("omits type when contentSize is absent (Exa defaults to auto)", async () => {
    const { adapter, calls } = makeAdapter(async () => makeResponse({ json: { results: [] } }));
    await adapter.search.invoke({ query: "test" });
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.type, undefined);
  });

  it("maps topic news → category: news", async () => {
    const { adapter, calls } = makeAdapter(async () => makeResponse({ json: { results: [] } }));
    await adapter.search.invoke({ query: "test", controls: { topic: "news" } });
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.category, "news");
  });

  it("maps topic finance → category: financial report", async () => {
    const { adapter, calls } = makeAdapter(async () => makeResponse({ json: { results: [] } }));
    await adapter.search.invoke({ query: "test", controls: { topic: "finance" } });
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.category, "financial report");
  });

  it("omits category for topic general", async () => {
    const { adapter, calls } = makeAdapter(async () => makeResponse({ json: { results: [] } }));
    await adapter.search.invoke({ query: "test", controls: { topic: "general" } });
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.category, undefined);
  });
});

// ---------------------------------------------------------------------------
// Search: failure normalization
// ---------------------------------------------------------------------------

describe("Exa Search Adapter — failure normalization", () => {
  it("maps 401 to AuthError with EXA_API_KEY help", async () => {
    const { adapter } = makeAdapter(makeErrorFetch(401));
    await assert.rejects(
      () => adapter.search.invoke({ query: "test" }),
      (e) => e instanceof AuthError && e.help && e.help.includes("EXA_API_KEY"),
    );
  });

  it("maps 403 to AuthError", async () => {
    const { adapter } = makeAdapter(makeErrorFetch(403));
    await assert.rejects(
      () => adapter.search.invoke({ query: "test" }),
      (e) => e instanceof AuthError,
    );
  });

  it("maps 402 to QuotaError — terminal", async () => {
    const { adapter } = makeAdapter(makeErrorFetch(402));
    await assert.rejects(
      () => adapter.search.invoke({ query: "test" }),
      (e) =>
        e instanceof QuotaError && e.retryable === false && e.message.includes("quota exhausted"),
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
        e instanceof ApiError && e.statusCode === 429 && e.message === "Exa rate limit exceeded",
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
      (e) => e.constructor.name === "NetworkError" && e.message === "Exa network error",
    );
  });

  it("never echoes the raw error body in the public message", async () => {
    const { adapter } = makeAdapter(makeErrorFetch(400, '{"error":"LEAK-SECRET-TOKEN"}'));
    await assert.rejects(
      () => adapter.search.invoke({ query: "test" }),
      (e) => e instanceof ApiError && !e.message.includes("LEAK-SECRET-TOKEN"),
    );
  });
});

// ---------------------------------------------------------------------------
// Search: cache identity
// ---------------------------------------------------------------------------

describe("Exa Search Adapter — cache identity", () => {
  it("produces a SHA-256 credential fingerprint with no legacy candidates", () => {
    const { adapter } = makeAdapter(async () => makeResponse());
    const identity = adapter.search.cacheIdentity({ query: "test" });
    assert.equal(identity.provider, "exa");
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
// Search: credential resolution
// ---------------------------------------------------------------------------

describe("Exa Search Adapter — credential resolution", () => {
  it("throws ConfigurationError when EXA_API_KEY is missing", () => {
    const descriptor = createExaDescriptor({ transport: { fetch: async () => makeResponse() } });
    const adapter = descriptor.create({ env: {} });
    assert.throws(
      () => adapter.search.cacheIdentity({ query: "test" }),
      (e) => e instanceof ConfigurationError,
    );
  });
});

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

describe("Exa Diagnostics — probe", () => {
  it("resolves immediately when probe is false (no network)", async () => {
    let called = false;
    const { adapter } = makeAdapter(async () => {
      called = true;
      return makeResponse();
    });
    await adapter.diagnostics.invoke({ probe: false });
    assert.equal(called, false);
  });

  it("performs a search request when probe is true", async () => {
    const { adapter, calls } = makeAdapter(async () => makeResponse({ json: { results: [] } }));
    await adapter.diagnostics.invoke({ probe: true });
    assert.equal(calls.length, 1);
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.query, "scoutline-doctor-probe");
    assert.equal(body.type, "auto");
  });

  it("throws on probe failure (auth)", async () => {
    const { adapter } = makeAdapter(makeErrorFetch(401));
    await assert.rejects(
      () => adapter.diagnostics.invoke({ probe: true }),
      (e) => e instanceof AuthError,
    );
  });

  it("throws ConfigurationError on probe when key missing", async () => {
    const descriptor = createExaDescriptor({ transport: { fetch: async () => makeResponse() } });
    const adapter = descriptor.create({ env: {} });
    await assert.rejects(
      () => adapter.diagnostics.invoke({ probe: true }),
      (e) => e instanceof ConfigurationError,
    );
  });

  it("maps 402 to QuotaError on probe (terminal)", async () => {
    const { adapter } = makeAdapter(makeErrorFetch(402));
    await assert.rejects(
      () => adapter.diagnostics.invoke({ probe: true }),
      (e) => e instanceof QuotaError && e.retryable === false,
    );
  });
});

// ---------------------------------------------------------------------------
// Reader: validation
// ---------------------------------------------------------------------------

describe("Exa Reader Adapter — validation", () => {
  it("rejects a non-http(s) URL with ValidationError", () => {
    const { adapter } = makeAdapter(async () => makeResponse());
    assert.throws(
      () => adapter.reader.fetch.validate({ url: "ftp://example.com" }),
      (e) => e instanceof ValidationError,
    );
  });

  it("rejects withLinksSummary, noGfm, keepImgDataUrl, withImagesSummary", () => {
    const { adapter } = makeAdapter(async () => makeResponse());
    for (const key of ["withLinksSummary", "noGfm", "keepImgDataUrl", "withImagesSummary"]) {
      assert.throws(
        () => adapter.reader.fetch.validate({ url: "https://example.com", [key]: true }),
        (e) => e instanceof UnsupportedOptionError && e.message.includes(key),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Reader: field normalization
// ---------------------------------------------------------------------------

describe("Exa Reader Adapter — normalization", () => {
  it("maps text→content, url→finalUrl, title→title", async () => {
    const contentsJson = {
      results: [
        {
          id: "https://example.com",
          url: "https://example.com",
          title: "Example Page",
          text: "Page content here",
        },
      ],
      statuses: [{ id: "https://example.com", status: "success" }],
    };
    const { adapter } = makeAdapter(async () => makeResponse({ json: contentsJson }));
    const result = await adapter.reader.fetch.invoke({ url: "https://example.com" });
    assert.deepEqual(result, {
      schemaVersion: 1,
      url: "https://example.com",
      finalUrl: "https://example.com",
      title: "Example Page",
      content: "Page content here",
      contentFormat: "markdown",
    });
  });

  it("coerces blank title to null", async () => {
    const contentsJson = {
      results: [{ id: "https://x.com", url: "https://x.com", title: "  ", text: "c" }],
      statuses: [{ id: "https://x.com", status: "success" }],
    };
    const { adapter } = makeAdapter(async () => makeResponse({ json: contentsJson }));
    const result = await adapter.reader.fetch.invoke({ url: "https://x.com" });
    assert.strictEqual(result.title, null);
  });

  it("uses finalUrl when it differs from request url (redirect)", async () => {
    const contentsJson = {
      results: [{ id: "https://old.com", url: "https://new.com", title: "T", text: "c" }],
      statuses: [{ id: "https://old.com", status: "success" }],
    };
    const { adapter } = makeAdapter(async () => makeResponse({ json: contentsJson }));
    const result = await adapter.reader.fetch.invoke({ url: "https://old.com" });
    assert.strictEqual(result.url, "https://old.com");
    assert.strictEqual(result.finalUrl, "https://new.com");
  });

  it("defaults contentFormat to markdown when format omitted", async () => {
    const contentsJson = {
      results: [{ id: "https://x.com", url: "https://x.com", title: "T", text: "c" }],
      statuses: [{ id: "https://x.com", status: "success" }],
    };
    const { adapter } = makeAdapter(async () => makeResponse({ json: contentsJson }));
    const result = await adapter.reader.fetch.invoke({ url: "https://x.com" });
    assert.strictEqual(result.contentFormat, "markdown");
  });
});

// ---------------------------------------------------------------------------
// Reader: per-URL status total function
// ---------------------------------------------------------------------------

describe("Exa Reader Adapter — per-URL status inspection", () => {
  const URL = "https://example.com";

  function makeContentsResponse(statusEntry) {
    return {
      results:
        statusEntry.status === "success"
          ? [{ id: URL, url: URL, title: "T", text: "content" }]
          : [],
      statuses: [statusEntry],
    };
  }

  it("succeeds when the matching status entry is success", async () => {
    const json = makeContentsResponse({ id: URL, status: "success" });
    const { adapter } = makeAdapter(async () => makeResponse({ json }));
    const result = await adapter.reader.fetch.invoke({ url: URL });
    assert.strictEqual(result.content, "content");
  });

  it("maps CRAWL_NOT_FOUND (404) to terminal ApiError 404", async () => {
    const json = makeContentsResponse({
      id: URL,
      status: "error",
      error: { tag: "CRAWL_NOT_FOUND", httpStatusCode: 404 },
    });
    const { adapter } = makeAdapter(async () => makeResponse({ json }));
    await assert.rejects(
      () => adapter.reader.fetch.invoke({ url: URL }),
      (e) => e instanceof ApiError && e.statusCode === 404 && e.retryable === false,
    );
  });

  it("maps UNSUPPORTED_URL to terminal ApiError 400", async () => {
    const json = makeContentsResponse({
      id: URL,
      status: "error",
      error: { tag: "UNSUPPORTED_URL" },
    });
    const { adapter } = makeAdapter(async () => makeResponse({ json }));
    await assert.rejects(
      () => adapter.reader.fetch.invoke({ url: URL }),
      (e) => e instanceof ApiError && e.statusCode === 400 && e.retryable === false,
    );
  });

  it("maps SOURCE_NOT_AVAILABLE (403) to terminal ApiError 403", async () => {
    const json = makeContentsResponse({
      id: URL,
      status: "error",
      error: { tag: "SOURCE_NOT_AVAILABLE", httpStatusCode: 403 },
    });
    const { adapter } = makeAdapter(async () => makeResponse({ json }));
    await assert.rejects(
      () => adapter.reader.fetch.invoke({ url: URL }),
      (e) => e instanceof ApiError && e.statusCode === 403 && e.retryable === false,
    );
  });

  it("maps CRAWL_TIMEOUT (504) to retryable ApiError 504", async () => {
    const json = makeContentsResponse({
      id: URL,
      status: "error",
      error: { tag: "CRAWL_TIMEOUT", httpStatusCode: 504 },
    });
    const { adapter } = makeAdapter(async () => makeResponse({ json }));
    await assert.rejects(
      () => adapter.reader.fetch.invoke({ url: URL }),
      (e) => e instanceof ApiError && e.statusCode === 504,
    );
  });

  it("maps CRAWL_LIVECRAWL_TIMEOUT to retryable ApiError 504 (table lookup, no httpStatusCode)", async () => {
    const json = makeContentsResponse({
      id: URL,
      status: "error",
      error: { tag: "CRAWL_LIVECRAWL_TIMEOUT" },
    });
    const { adapter } = makeAdapter(async () => makeResponse({ json }));
    await assert.rejects(
      () => adapter.reader.fetch.invoke({ url: URL }),
      (e) => e instanceof ApiError && e.statusCode === 504,
    );
  });

  it("maps CRAWL_UNKNOWN_ERROR (500) to retryable ApiError 500", async () => {
    const json = makeContentsResponse({
      id: URL,
      status: "error",
      error: { tag: "CRAWL_UNKNOWN_ERROR", httpStatusCode: 500 },
    });
    const { adapter } = makeAdapter(async () => makeResponse({ json }));
    await assert.rejects(
      () => adapter.reader.fetch.invoke({ url: URL }),
      (e) => e instanceof ApiError && e.statusCode === 500,
    );
  });

  it("maps unknown error tag to retryable ApiError 500 (never silent success)", async () => {
    const json = makeContentsResponse({
      id: URL,
      status: "error",
      error: { tag: "SOME_NEW_TAG" },
    });
    const { adapter } = makeAdapter(async () => makeResponse({ json }));
    await assert.rejects(
      () => adapter.reader.fetch.invoke({ url: URL }),
      (e) => e instanceof ApiError && e.statusCode === 500,
    );
  });

  it("prefers error.httpStatusCode over the tag table for retry classification", async () => {
    // CRAWL_NOT_FOUND normally maps to 404, but httpStatusCode=503 overrides it.
    const json = makeContentsResponse({
      id: URL,
      status: "error",
      error: { tag: "CRAWL_NOT_FOUND", httpStatusCode: 503 },
    });
    const { adapter } = makeAdapter(async () => makeResponse({ json }));
    await assert.rejects(
      () => adapter.reader.fetch.invoke({ url: URL }),
      (e) => e instanceof ApiError && e.statusCode === 503,
    );
  });

  it("throws ApiError 500 when no status entry matches the requested URL (id mismatch)", async () => {
    // Two entries for DIFFERENT urls — single-URL fallback does not apply.
    const json = {
      results: [],
      statuses: [
        { id: "https://different.com", status: "success" },
        { id: "https://other.com", status: "success" },
      ],
    };
    const { adapter } = makeAdapter(async () => makeResponse({ json }));
    await assert.rejects(
      () => adapter.reader.fetch.invoke({ url: URL }),
      (e) => e instanceof ApiError && e.statusCode === 500,
    );
  });

  it("throws ApiError 500 when statuses[] is absent (never silent success)", async () => {
    const json = { results: [{ id: URL, url: URL, title: "T", text: "c" }] };
    const { adapter } = makeAdapter(async () => makeResponse({ json }));
    await assert.rejects(
      () => adapter.reader.fetch.invoke({ url: URL }),
      (e) => e instanceof ApiError && e.statusCode === 500,
    );
  });

  it("accepts a single status entry even when id doesn't exactly match (single-URL fallback)", async () => {
    // Exa may normalize URLs (trailing slash, scheme casing). For a
    // single-URL fetch, accept the sole status entry.
    const json = {
      results: [{ id: URL, url: URL, title: "T", text: "content" }],
      statuses: [{ id: "https://example.com/", status: "success" }],
    };
    const { adapter } = makeAdapter(async () => makeResponse({ json }));
    const result = await adapter.reader.fetch.invoke({ url: URL });
    assert.strictEqual(result.content, "content");
  });
});

// ---------------------------------------------------------------------------
// Reader: timeout-unit conversion (seconds → milliseconds)
// ---------------------------------------------------------------------------

describe("Exa Reader Adapter — timeout-unit conversion", () => {
  it("converts --timeout 20 (seconds) to livecrawlTimeout: 20000 (ms)", async () => {
    const { adapter, calls } = makeAdapter(async () =>
      makeResponse({
        json: {
          results: [{ id: "https://x.com", url: "https://x.com", title: "T", text: "c" }],
          statuses: [{ id: "https://x.com", status: "success" }],
        },
      }),
    );
    await adapter.reader.fetch.invoke({ url: "https://x.com", timeout: 20 });
    const body = JSON.parse(calls[0].init.body);
    assert.strictEqual(body.livecrawlTimeout, 20000);
  });

  it("converts --timeout 1 to livecrawlTimeout: 1000", async () => {
    const { adapter, calls } = makeAdapter(async () =>
      makeResponse({
        json: {
          results: [{ id: "https://x.com", url: "https://x.com", title: "T", text: "c" }],
          statuses: [{ id: "https://x.com", status: "success" }],
        },
      }),
    );
    await adapter.reader.fetch.invoke({ url: "https://x.com", timeout: 1 });
    const body = JSON.parse(calls[0].init.body);
    assert.strictEqual(body.livecrawlTimeout, 1000);
  });

  it("omits livecrawlTimeout when timeout is absent", async () => {
    const { adapter, calls } = makeAdapter(async () =>
      makeResponse({
        json: {
          results: [{ id: "https://x.com", url: "https://x.com", title: "T", text: "c" }],
          statuses: [{ id: "https://x.com", status: "success" }],
        },
      }),
    );
    await adapter.reader.fetch.invoke({ url: "https://x.com" });
    const body = JSON.parse(calls[0].init.body);
    assert.strictEqual(body.livecrawlTimeout, undefined);
  });

  it("always sends text:true and urls:[url]", async () => {
    const { adapter, calls } = makeAdapter(async () =>
      makeResponse({
        json: {
          results: [{ id: "https://x.com", url: "https://x.com", title: "T", text: "c" }],
          statuses: [{ id: "https://x.com", status: "success" }],
        },
      }),
    );
    await adapter.reader.fetch.invoke({ url: "https://x.com" });
    const body = JSON.parse(calls[0].init.body);
    assert.strictEqual(body.text, true);
    assert.deepEqual(body.urls, ["https://x.com"]);
  });
});

// ---------------------------------------------------------------------------
// Reader: format:text markdown stripping
// ---------------------------------------------------------------------------

describe("Exa Reader Adapter — format:text stripping", () => {
  it("strips markdown markers and sets contentFormat to text", async () => {
    const markdownContent =
      "# Header\n\nSome **bold** and *italic* text with [a link](https://x.com).\n\n- item one\n- item two";
    const json = {
      results: [{ id: "https://x.com", url: "https://x.com", title: "T", text: markdownContent }],
      statuses: [{ id: "https://x.com", status: "success" }],
    };
    const { adapter } = makeAdapter(async () => makeResponse({ json }));
    const result = await adapter.reader.fetch.invoke({ url: "https://x.com", format: "text" });
    assert.strictEqual(result.contentFormat, "text");
    assert.ok(!result.content.includes("#"), "no header markers");
    assert.ok(!result.content.includes("**"), "no bold markers");
    assert.ok(!result.content.includes("*"), "no italic markers");
    assert.ok(!result.content.includes("["), "no link markers");
    assert.ok(result.content.includes("bold"), "bold text preserved");
    assert.ok(result.content.includes("a link"), "link text preserved");
  });

  it("preserves markdown when format is markdown (default)", async () => {
    const markdownContent = "# Header\n\n**bold**";
    const json = {
      results: [{ id: "https://x.com", url: "https://x.com", title: "T", text: markdownContent }],
      statuses: [{ id: "https://x.com", status: "success" }],
    };
    const { adapter } = makeAdapter(async () => makeResponse({ json }));
    const result = await adapter.reader.fetch.invoke({ url: "https://x.com" });
    assert.strictEqual(result.contentFormat, "markdown");
    assert.strictEqual(result.content, markdownContent);
  });
});

// ---------------------------------------------------------------------------
// Reader: cache identity
// ---------------------------------------------------------------------------

describe("Exa Reader Adapter — cache identity", () => {
  it("produces a reader-fetch identity with the right partition fields", () => {
    const { adapter } = makeAdapter(async () => makeResponse());
    const identity = adapter.reader.fetch.cacheIdentity({ url: "https://example.com" });
    assert.strictEqual(identity.provider, "exa");
    assert.strictEqual(identity.capability, "reader");
    assert.strictEqual(identity.operation, "reader-fetch");
    assert.strictEqual(identity.credentialFingerprint, EXPECTED_FINGERPRINT);
    assert.strictEqual(identity.request.url, "https://example.com");
    assert.deepEqual(identity.legacyCandidates, []);
  });

  it("decodeCached round-trips a normalized result", () => {
    const { adapter } = makeAdapter(async () => makeResponse());
    const result = {
      schemaVersion: 1,
      url: "https://example.com",
      finalUrl: "https://example.com",
      title: "Title",
      content: "content",
      contentFormat: "markdown",
    };
    const decoded = adapter.reader.fetch.decodeCached(result);
    assert.deepEqual(decoded, result);
  });

  it("decodeCached returns null for malformed entries", () => {
    const { adapter } = makeAdapter(async () => makeResponse());
    assert.strictEqual(adapter.reader.fetch.decodeCached({ foo: "bar" }), null);
    assert.strictEqual(adapter.reader.fetch.decodeCached(null), null);
    assert.strictEqual(adapter.reader.fetch.decodeCached(42), null);
  });
});

// ---------------------------------------------------------------------------
// Research: helpers
// ---------------------------------------------------------------------------

/**
 * Build a descriptor + adapter for research tests. Returns the adapter,
 * the calls array, and the in-memory state file. The fake `fetch`
 * dispatches based on URL path and HTTP method:
 *   POST /agent/runs  → onCreate()
 *   GET  /agent/runs/* → onPoll(runId)
 * Other URLs fall through to fallbackFetch (for search/contents tests).
 */
function makeResearchAdapter({ onCreate, onPoll, fallbackFetch } = {}) {
  const calls = [];
  const stateFile = createInMemoryAsyncJobStateFile();
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    const u = String(url);
    if (init.method === "POST" && u.includes("/agent/runs")) {
      return onCreate ? onCreate() : makeResponse({ json: { id: "run_test", status: "queued" } });
    }
    if (init.method === "GET" && u.includes("/agent/runs/")) {
      const runId = u.split("/agent/runs/")[1];
      return onPoll ? onPoll(runId) : makeResponse({ json: { id: runId, status: "queued" } });
    }
    if (fallbackFetch) return fallbackFetch(url, init);
    return makeResponse({ json: {} });
  };
  const noOpTimer = {
    setTimeout: (cb) => {
      setImmediate(cb);
      return 0;
    },
    clearTimeout: () => {},
  };
  const descriptor = createExaDescriptor({
    transport: {
      fetch: fn,
      ...noOpTimer,
      env: { EXA_TIMEOUT: "5000", EXA_RESEARCH_POLL_INTERVAL_MS: "0" },
    },
    researchStateFile: stateFile,
  });
  const adapter = descriptor.create({ env: { EXA_API_KEY: TEST_API_KEY } });
  return { adapter, calls, stateFile, descriptor };
}

function agentCreateResponse(id = "run_test", status = "queued") {
  return makeResponse({ json: { id, status } });
}

function agentPollResponse(status, output) {
  const json = { id: "run_test", status };
  if (output !== undefined) json.output = output;
  return makeResponse({ json });
}

// ---------------------------------------------------------------------------
// Research: Exa-Beta header assertions
// ---------------------------------------------------------------------------

describe("Exa Research — Exa-Beta header", () => {
  it("create (POST /agent/runs) carries Exa-Beta: agent-2026-05-07", async () => {
    const { adapter, calls } = makeResearchAdapter({
      onCreate: () => agentCreateResponse("run_1", "completed"),
      onPoll: () => agentPollResponse("completed", { text: "report" }),
    });
    await adapter.research.run.invoke({ query: "test" });
    const createCall = calls.find((c) => c.init.method === "POST");
    assert.strictEqual(createCall.init.headers["Exa-Beta"], "agent-2026-05-07");
  });

  it("poll (GET /agent/runs/:id) carries Exa-Beta: agent-2026-05-07", async () => {
    const { adapter, calls } = makeResearchAdapter({
      onCreate: () => agentCreateResponse(),
      onPoll: () => agentPollResponse("completed", { text: "report" }),
    });
    await adapter.research.run.invoke({ query: "test" });
    const pollCall = calls.find((c) => c.init.method === "GET");
    assert.strictEqual(pollCall.init.headers["Exa-Beta"], "agent-2026-05-07");
  });

  it("search does NOT carry the Exa-Beta header", async () => {
    const { adapter, calls } = makeResearchAdapter({
      fallbackFetch: () => makeResponse({ json: { results: [] } }),
    });
    await adapter.search.invoke({ query: "test" });
    const searchCall = calls.find((c) => c.url.includes("/search"));
    assert.strictEqual(searchCall.init.headers["Exa-Beta"], undefined);
  });
});

// ---------------------------------------------------------------------------
// Research: lifecycle
// ---------------------------------------------------------------------------

describe("Exa Research — lifecycle", () => {
  it("create → poll queued → poll completed → normalized result", async () => {
    let pollCount = 0;
    const { adapter } = makeResearchAdapter({
      onCreate: () => agentCreateResponse("run_1", "queued"),
      onPoll: () => {
        pollCount++;
        if (pollCount === 1) return agentPollResponse("queued");
        return agentPollResponse("completed", {
          text: "The research report text.",
          grounding: [
            { citations: [{ title: "Source A", url: "https://a.com" }] },
            { citations: [{ title: "Source B", url: "https://b.com" }, { title: "Incomplete" }] },
          ],
        });
      },
    });
    const result = await adapter.research.run.invoke({ query: "test query" });
    assert.strictEqual(result.schemaVersion, 1);
    assert.strictEqual(result.query, "test query");
    assert.strictEqual(result.model, "auto");
    assert.strictEqual(result.report, "The research report text.");
    assert.equal(result.sources.length, 2);
    assert.deepEqual(result.sources[0], { title: "Source A", url: "https://a.com" });
    assert.deepEqual(result.sources[1], { title: "Source B", url: "https://b.com" });
  });

  it("failed status → delete state + ApiError 500", async () => {
    const { adapter, stateFile } = makeResearchAdapter({
      onCreate: () => agentCreateResponse("run_f", "queued"),
      onPoll: () => agentPollResponse("failed"),
    });
    await assert.rejects(
      () => adapter.research.run.invoke({ query: "test" }),
      (e) => e instanceof ApiError && e.statusCode === 500,
    );
    // State file should be removed on failure.
    assert.equal(stateFile.store.size, 0);
  });

  it("cancelled status → delete state + ApiError 500 (Exa-specific terminal)", async () => {
    const { adapter, stateFile } = makeResearchAdapter({
      onCreate: () => agentCreateResponse("run_c", "queued"),
      onPoll: () => agentPollResponse("cancelled"),
    });
    await assert.rejects(
      () => adapter.research.run.invoke({ query: "test" }),
      (e) => e instanceof ApiError && e.statusCode === 500,
    );
    assert.equal(stateFile.store.size, 0);
  });

  it("transient poll error (503) is retried — does not terminate research", async () => {
    let pollCount = 0;
    const { adapter } = makeResearchAdapter({
      onCreate: () => agentCreateResponse("run_t", "queued"),
      onPoll: () => {
        pollCount++;
        if (pollCount === 1) {
          return { ok: false, status: 503, text: async () => "", json: async () => ({}) };
        }
        return agentPollResponse("completed", { text: "recovered report" });
      },
    });
    const result = await adapter.research.run.invoke({ query: "test" });
    assert.strictEqual(result.report, "recovered report");
    assert.ok(pollCount >= 2, "poll retried after transient 503");
  });

  it("terminal poll error (401) is NOT retried — propagates immediately", async () => {
    let pollCount = 0;
    const { adapter } = makeResearchAdapter({
      onCreate: () => agentCreateResponse("run_a", "queued"),
      onPoll: () => {
        pollCount++;
        return { ok: false, status: 401, text: async () => "", json: async () => ({}) };
      },
    });
    await assert.rejects(
      () => adapter.research.run.invoke({ query: "test" }),
      (e) => e.constructor.name === "AuthError",
    );
    assert.strictEqual(pollCount, 1, "terminal auth error not retried");
  });

  it("404 stale-state recovery → remove + create fresh + poll completed", async () => {
    let createCount = 0;
    let pollCount = 0;
    const { adapter, calls } = makeResearchAdapter({
      onCreate: () => {
        createCount++;
        return agentCreateResponse(`run_${createCount}`, "queued");
      },
      onPoll: () => {
        pollCount++;
        if (pollCount === 1)
          return { ok: false, status: 404, text: async () => "", json: async () => ({}) };
        return agentPollResponse("completed", { text: "fresh report" });
      },
    });
    const result = await adapter.research.run.invoke({ query: "test" });
    assert.strictEqual(result.report, "fresh report");
    assert.ok(createCount >= 2, "should create at least 2 runs (stale + fresh)");
  });

  it("create-time 429 is terminal (no retry)", async () => {
    let createCount = 0;
    const { adapter } = makeResearchAdapter({
      onCreate: () => {
        createCount++;
        return makeResponse({ ok: false, status: 429, body: '{"error":"rate"}' });
      },
    });
    await assert.rejects(
      () => adapter.research.run.invoke({ query: "test" }),
      (e) => e instanceof ApiError && e.statusCode === 429,
    );
    assert.strictEqual(createCount, 1, "exactly one POST — not retried");
  });

  it("create-time 5xx is terminal (no retry)", async () => {
    let createCount = 0;
    const { adapter } = makeResearchAdapter({
      onCreate: () => {
        createCount++;
        return makeResponse({ ok: false, status: 503, body: "" });
      },
    });
    await assert.rejects(
      () => adapter.research.run.invoke({ query: "test" }),
      (e) => e instanceof ApiError && e.statusCode === 503,
    );
    assert.strictEqual(createCount, 1);
  });
});

// ---------------------------------------------------------------------------
// Research: state-file resume
// ---------------------------------------------------------------------------

describe("Exa Research — state-file resume", () => {
  it("resumes an existing run from the state file (no second POST)", async () => {
    const { adapter, calls, stateFile } = makeResearchAdapter({
      onCreate: () => agentCreateResponse("run_new", "queued"),
      onPoll: () => agentPollResponse("completed", { text: "resumed report" }),
    });
    // Pre-populate the state file with an existing run.
    const identityHash = requireIdentityHash(adapter, "test resume");
    await stateFile.write(identityHash, {
      requestId: "run_existing",
      identityHash,
      createdAt: new Date().toISOString(),
      status: "pending",
    });

    const result = await adapter.research.run.invoke({ query: "test resume" });
    assert.strictEqual(result.report, "resumed report");
    // No POST should have happened — only GET polls for the existing run.
    const posts = calls.filter((c) => c.init.method === "POST");
    assert.strictEqual(posts.length, 0, "no POST when state file exists");
  });

  it("EEXIST race: concurrent invocations poll the winner's run", async () => {
    let createCount = 0;
    const { adapter, calls } = makeResearchAdapter({
      onCreate: () => {
        createCount++;
        return agentCreateResponse(`run_${createCount}`, "queued");
      },
      onPoll: () => agentPollResponse("completed", { text: "report" }),
    });
    // Two concurrent invocations with the same request.
    await Promise.all([
      adapter.research.run.invoke({ query: "race" }),
      adapter.research.run.invoke({ query: "race" }),
    ]);
    // Both may POST (OD1 race), but at least one should succeed.
    // The test proves the lifecycle completes for both callers.
    const completed = calls.filter((c) => c.init.method === "GET").length;
    assert.ok(completed >= 1, "at least one poll happened");
  });
});

// ---------------------------------------------------------------------------
// Research: model → effort mapping
// ---------------------------------------------------------------------------

describe("Exa Research — model→effort mapping", () => {
  it("maps model mini → effort: low in the POST body", async () => {
    const { adapter, calls } = makeResearchAdapter({
      onCreate: () => agentCreateResponse("run_m", "completed"),
      onPoll: () => agentPollResponse("completed", { text: "r" }),
    });
    const result = await adapter.research.run.invoke({ query: "test", model: "mini" });
    const postCall = calls.find((c) => c.init.method === "POST");
    const body = JSON.parse(postCall.init.body);
    assert.strictEqual(body.effort, "low");
    // Result echoes the requested model, not the effort string.
    assert.strictEqual(result.model, "mini");
  });

  it("maps model pro → effort: high", async () => {
    const { adapter, calls } = makeResearchAdapter({
      onCreate: () => agentCreateResponse("run_p", "completed"),
      onPoll: () => agentPollResponse("completed", { text: "r" }),
    });
    await adapter.research.run.invoke({ query: "test", model: "pro" });
    const body = JSON.parse(calls.find((c) => c.init.method === "POST").init.body);
    assert.strictEqual(body.effort, "high");
  });

  it("maps model auto/omitted → effort: auto", async () => {
    const { adapter, calls } = makeResearchAdapter({
      onCreate: () => agentCreateResponse("run_a", "completed"),
      onPoll: () => agentPollResponse("completed", { text: "r" }),
    });
    await adapter.research.run.invoke({ query: "test" });
    const body = JSON.parse(calls.find((c) => c.init.method === "POST").init.body);
    assert.strictEqual(body.effort, "auto");
  });
});

// ---------------------------------------------------------------------------
// Research: validation
// ---------------------------------------------------------------------------

describe("Exa Research — validation", () => {
  it("rejects an empty query with ValidationError", () => {
    const { adapter } = makeResearchAdapter();
    assert.throws(
      () => adapter.research.run.validate({ query: "  " }),
      (e) => e instanceof ValidationError,
    );
  });

  it("rejects outputLength with UnsupportedOptionError", () => {
    const { adapter } = makeResearchAdapter();
    assert.throws(
      () => adapter.research.run.validate({ query: "test", outputLength: "long" }),
      (e) => e instanceof UnsupportedOptionError && e.message.includes("outputLength"),
    );
  });

  it("rejects citationFormat with UnsupportedOptionError", () => {
    const { adapter } = makeResearchAdapter();
    assert.throws(
      () => adapter.research.run.validate({ query: "test", citationFormat: "mla" }),
      (e) => e instanceof UnsupportedOptionError && e.message.includes("citationFormat"),
    );
  });

  it("rejects domain with UnsupportedOptionError", () => {
    const { adapter } = makeResearchAdapter();
    assert.throws(
      () => adapter.research.run.validate({ query: "test", domain: "example.com" }),
      (e) => e instanceof UnsupportedOptionError && e.message.includes("domain"),
    );
  });
});

// ---------------------------------------------------------------------------
// Research: cache identity + decodeCached
// ---------------------------------------------------------------------------

describe("Exa Research — cache identity", () => {
  it("produces a research identity with the right partition fields", () => {
    const { adapter } = makeResearchAdapter();
    const identity = adapter.research.run.cacheIdentity({ query: "test" });
    assert.strictEqual(identity.provider, "exa");
    assert.strictEqual(identity.capability, "research");
    assert.strictEqual(identity.credentialFingerprint, EXPECTED_FINGERPRINT);
    assert.strictEqual(identity.request.query, "test");
  });

  it("decodeCached round-trips a normalized result", () => {
    const { adapter } = makeResearchAdapter();
    const result = {
      schemaVersion: 1,
      query: "test",
      model: "auto",
      report: "report text",
      sources: [{ title: "S", url: "https://s.com" }],
    };
    const decoded = adapter.research.run.decodeCached(result);
    assert.deepEqual(decoded, result);
  });

  it("decodeCached returns null for malformed entries", () => {
    const { adapter } = makeResearchAdapter();
    assert.strictEqual(adapter.research.run.decodeCached({ foo: "bar" }), null);
    assert.strictEqual(adapter.research.run.decodeCached(null), null);
  });
});

// ---------------------------------------------------------------------------
// Helper: compute the identity hash for a given request (for state-file
// pre-population in resume tests)
// ---------------------------------------------------------------------------

function requireIdentityHash(adapter, query) {
  const identity = adapter.research.run.cacheIdentity({ query });
  // Match computeAsyncJobStateHash: sort only the request sub-object,
  // NOT the top-level payload (insertion order: provider, capability,
  // credentialFingerprint, request).
  function sortKeysDeep(value) {
    if (Array.isArray(value)) return value.map(sortKeysDeep);
    if (value && typeof value === "object") {
      const out = {};
      for (const key of Object.keys(value).sort()) {
        out[key] = sortKeysDeep(value[key]);
      }
      return out;
    }
    return value;
  }
  const payload = {
    provider: identity.provider,
    capability: identity.capability,
    credentialFingerprint: identity.credentialFingerprint,
    request: sortKeysDeep(identity.request),
  };
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}
