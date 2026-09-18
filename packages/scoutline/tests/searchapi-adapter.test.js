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
      source: "raft.github.io",
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
    assert.strictEqual(rows[0].source, "raft.github.io");
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

// ---------------------------------------------------------------------------
// SearchApi Quota + Diagnostics Capabilities (T3)
// ---------------------------------------------------------------------------

// Wire truth from FIXTURES.md — SearchApi.io GET /api/v1/me response shape.
const SEARCHAPI_ME_RAW = {
  account: { current_month_usage: 3200, monthly_allowance: 10000, remaining_credits: 6800 },
  api_usage: { searches_this_hour: 120, hourly_rate_limit: 200000 },
  subscription: {
    period_start: "2026-08-01T00:00:00Z",
    period_end: "2026-09-01T00:00:00Z",
  },
};

describe("searchapi quota and diagnostics capabilities", () => {
  it("quota.invoke maps remaining_credits to category searches", async () => {
    const calls = [];
    const fn = async (url, init) => {
      calls.push({ url: String(url), headers: init.headers });
      assert.strictEqual(String(url), "https://www.searchapi.io/api/v1/me");
      return jsonRes(SEARCHAPI_ME_RAW);
    };
    const descriptor = createSearchApiDescriptor({ transport: { fetch: fn } });
    const adapter = descriptor.create({ env: { SEARCHAPI_API_KEY: TEST_API_KEY } });
    const q = await adapter.quota.invoke();
    assert.strictEqual(q.provider, "searchapi");
    assert.strictEqual(q.status, "ok");
    assert.strictEqual(q.categories[0].name, "searches");
    assert.strictEqual(q.categories[0].unit, "credits");
    assert.strictEqual(q.categories[0].current.remaining, 6800);
    assert.strictEqual(q.categories[0].current.limit, 10000);
    assert.strictEqual(q.categories[0].current.used, 3200);
    assert.strictEqual(q.categories[0].current.resetsAt, "2026-09-01T00:00:00.000Z");
    assert.strictEqual(calls.length, 1);
  });

  it("diagnostics.invoke GETs /me; create() does not fetch", async () => {
    let calls = 0;
    const descriptor = createSearchApiDescriptor({
      transport: {
        fetch: async (url) => {
          calls += 1;
          assert.match(String(url), /\/api\/v1\/me$/);
          return jsonRes(SEARCHAPI_ME_RAW);
        },
      },
    });
    const adapter = descriptor.create({ env: { SEARCHAPI_API_KEY: TEST_API_KEY } });
    assert.strictEqual(calls, 0);
    await adapter.diagnostics.invoke({ probe: true });
    assert.strictEqual(calls, 1);
    await adapter.diagnostics.invoke({ probe: false });
    assert.strictEqual(calls, 1);
  });
});
