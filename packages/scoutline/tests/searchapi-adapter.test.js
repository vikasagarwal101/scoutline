/**
 * SearchApi Provider foundation tests (T1, searchapi credentials module).
 *
 * Verifies the SearchApi.io credential seam:
 *   - getSearchApiKey: SEARCHAPI_API_KEY wins over legacy SERPAPI_API_KEY;
 *   whitespace-only values are absent; returned keys are trimmed.
 *   - isSearchApiConfigured: true only when a non-blank key is present
 *   (either env var), false for whitespace-only values.
 *   - requireSearchApiKey: throws ConfigurationError (exit 3) when
 *   neither variable is non-blank.
 *   - hashSearchApiKey: lowercase hex SHA-256 fingerprint, length 64;
 *   the raw key must never appear in error messages or logs.
 *
 * No network is touched; tests pass literal env objects.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  getSearchApiKey,
  isSearchApiConfigured,
  requireSearchApiKey,
  hashSearchApiKey,
} from "../dist/providers/searchapi/credentials.js";
import { createSearchApiDescriptor } from "../dist/providers/searchapi/adapter.js";
import { ConfigurationError, UnsupportedOptionError, ValidationError } from "../dist/lib/errors.js";

describe("searchapi credentials", () => {
  it("prefers SEARCHAPI_API_KEY over SERPAPI_API_KEY and computes fingerprint", () => {
    assert.equal(getSearchApiKey({ SEARCHAPI_API_KEY: "a", SERPAPI_API_KEY: "b" }), "a");
    assert.equal(getSearchApiKey({ SERPAPI_API_KEY: " b " }), "b");
    assert.equal(isSearchApiConfigured({ SEARCHAPI_API_KEY: "  " }), false);
    assert.equal(hashSearchApiKey("key").length, 64);
    assert.throws(
      () => requireSearchApiKey({}),
      (e) => e instanceof ConfigurationError,
    );
  });

  it("reports configured when only one variable is set", () => {
    assert.equal(isSearchApiConfigured({ SEARCHAPI_API_KEY: "k" }), true);
    assert.equal(isSearchApiConfigured({ SERPAPI_API_KEY: "legacy" }), true);
  });

  it("trims the key returned by requireSearchApiKey", () => {
    assert.equal(requireSearchApiKey({ SEARCHAPI_API_KEY: " x " }), "x");
  });
});

// ---------------------------------------------------------------------------
// SearchApi Search Capability (T2)
// ---------------------------------------------------------------------------

const TEST_API_KEY = "k";

// Wire truth from FIXTURES.md — SearchApi.io Google SERP response shape.
const SEARCHAPI_SEARCH_RAW = {
  search_metadata: {
    id: "search_fixture_001",
    status: "Success",
    created_at: "2026-08-20T10:00:00Z",
    total_time_taken: 0.85,
  },
  search_parameters: { engine: "google", q: "raft distributed consensus algorithm" },
  organic_results: [
    {
      position: 1,
      title: "In Search of an Understandable Consensus Algorithm (Raft)",
      link: "https://raft.github.io/raft.pdf",
      snippet: "Raft is consensus algorithm managing replicated log equivalent to Paxos...",
      date: "2026-05-12",
    },
    {
      position: 2,
      title: "Raft Consensus Algorithm",
      link: "https://raft.github.io/",
      snippet:
        "Raft is designed to be easy to understand provides leader election log replication.",
    },
  ],
};

function jsonRes(raw) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(raw),
    json: async () => raw,
    headers: { get: () => null },
  };
}

function header(captured, name) {
  return captured.headers[name];
}

/**
 * Build an adapter whose transport records every fetch URL/headers and
 * serves `fetchImpl`. The adapter is bound to an env carrying the test
 * API key so `invoke`/`cacheIdentity` can resolve credentials.
 */
function makeSearchAdapter(fetchImpl) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), headers: init.headers });
    return fetchImpl(url, init);
  };
  const descriptor = createSearchApiDescriptor({ transport: { fetch: fn } });
  const adapter = descriptor.create({ env: { SEARCHAPI_API_KEY: TEST_API_KEY } });
  return { adapter, calls };
}

describe("searchapi search capability", () => {
  it("search validate rejects contentSize and type before fetch", async () => {
    let calls = 0;
    const { adapter } = makeSearchAdapter(async () => {
      calls += 1;
      throw new Error("fetch must not run");
    });
    assert.throws(
      () => adapter.search.validate({ query: "q", controls: { contentSize: "high" } }),
      (e) =>
        e instanceof UnsupportedOptionError &&
        e.provider === "searchapi" &&
        e.capability === "search" &&
        e.option === "contentSize",
    );
    assert.throws(
      () => adapter.search.validate({ query: "q", controls: { type: "video" } }),
      (e) =>
        e instanceof UnsupportedOptionError &&
        e.provider === "searchapi" &&
        e.capability === "search" &&
        e.option === "type",
    );
    assert.throws(
      () => adapter.search.validate({ query: "   " }),
      (e) => e instanceof ValidationError,
    );
    assert.strictEqual(calls, 0);
    await assert.rejects(
      adapter.search.invoke({ query: "q", controls: { type: "video" } }),
      (e) => e instanceof UnsupportedOptionError && e.option === "type",
    );
    assert.strictEqual(calls, 0);
  });

  it("search GET google engine with Bearer, site, gl, time_period", async () => {
    const { adapter, calls } = makeSearchAdapter(async () => jsonRes(SEARCHAPI_SEARCH_RAW));
    const rows = await adapter.search.invoke({
      query: "raft",
      controls: { domain: "github.io", recency: "oneWeek", location: "us" },
    });
    const url = new URL(calls[0].url);
    assert.strictEqual(url.origin, "https://www.searchapi.io");
    assert.strictEqual(url.pathname, "/api/v1/search");
    assert.strictEqual(url.searchParams.get("engine"), "google");
    assert.strictEqual(url.searchParams.get("time_period"), "last_week");
    assert.strictEqual(url.searchParams.get("gl"), "us");
    assert.match(url.searchParams.get("q"), /site:github\.io/);
    assert.strictEqual(header(calls[0], "Authorization"), "Bearer k");
    assert.strictEqual(url.searchParams.get("api_key"), null);
    assert.strictEqual(rows[0].url, "https://raft.github.io/raft.pdf");
    assert.strictEqual(rows[0].title, "In Search of an Understandable Consensus Algorithm (Raft)");
  });

  it("search topic news uses engine=google_news", async () => {
    const { adapter, calls } = makeSearchAdapter(async () => jsonRes(SEARCHAPI_SEARCH_RAW));
    await adapter.search.invoke({ query: "q", controls: { topic: "news" } });
    const url = new URL(calls[0].url);
    assert.strictEqual(url.searchParams.get("engine"), "google_news");
  });

  it("search recency oneDay/oneWeek/oneMonth/oneYear map time_period and noLimit omits it", async () => {
    const cases = {
      oneDay: "last_day",
      oneWeek: "last_week",
      oneMonth: "last_month",
      oneYear: "last_year",
    };
    for (const [recency, expected] of Object.entries(cases)) {
      const { adapter, calls } = makeSearchAdapter(async () => jsonRes(SEARCHAPI_SEARCH_RAW));
      await adapter.search.invoke({ query: "q", controls: { recency } });
      const url = new URL(calls[0].url);
      assert.strictEqual(url.searchParams.get("time_period"), expected, recency);
    }
    const { adapter, calls } = makeSearchAdapter(async () => jsonRes(SEARCHAPI_SEARCH_RAW));
    await adapter.search.invoke({ query: "q", controls: { recency: "noLimit" } });
    assert.strictEqual(new URL(calls[0].url).searchParams.get("time_period"), null);
  });

  it("search location cn maps gl to cn", async () => {
    const { adapter, calls } = makeSearchAdapter(async () => jsonRes(SEARCHAPI_SEARCH_RAW));
    await adapter.search.invoke({ query: "q", controls: { location: "cn" } });
    assert.strictEqual(new URL(calls[0].url).searchParams.get("gl"), "cn");
  });
});
