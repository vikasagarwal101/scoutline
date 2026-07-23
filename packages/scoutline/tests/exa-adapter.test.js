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
    assert.ok(caps.has("diagnostics"));
    assert.equal(caps.size, 2);
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
});
