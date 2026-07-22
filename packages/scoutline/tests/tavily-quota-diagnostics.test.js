/**
 * Tavily Quota + Diagnostics Capability tests (T08, tech-plan §10).
 *
 * Verifies the Tavily operational capabilities:
 *   - Quota normalization: key.usage/limit -> "requests"; per-endpoint
 *     counts share the key-level limit; account.plan_usage/limit ->
 *     "plan"; account.current_plan -> metadata.plan.
 *   - Quota failure normalization: 401 -> AuthError, 432 -> ApiError(432).
 *   - Diagnostics probe: /search with search_depth=basic; probe=false
 *     short-circuits without network; success -> resolves; failure ->
 *     throws normalized error.
 *   - Adapter conformance: create() returns quota and diagnostics.
 *
 * Tests inject a single fake `fetch` through
 * `TavilyAdapterDependencies.transport`; the fake returns
 * Response-shaped objects (ok/status/json/text). No real network is
 * touched.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createTavilyDescriptor } from "../dist/providers/tavily/adapter.js";
import {
  normalizeTavilyQuota,
  createTavilyQuotaCapability,
} from "../dist/providers/tavily/quota.js";
import { createTavilyDiagnosticsCapability } from "../dist/providers/tavily/diagnostics.js";
import { ApiError, AuthError, NetworkError } from "../dist/lib/errors.js";

const TEST_API_KEY = "tvly-test-key-DO-NOT-LEAK";

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
// Quota: normalization
// ---------------------------------------------------------------------------

describe("Tavily Quota — normalization", () => {
  it("maps key.usage/limit to the aggregate 'requests' category", () => {
    const raw = {
      key: { usage: 150, limit: 1000 },
      account: { current_plan: "Bootstrap" },
    };
    const result = normalizeTavilyQuota(raw);
    assert.equal(result.provider, "tavily");
    assert.equal(result.status, "ok");
    assert.equal(result.plan, "Bootstrap");
    const aggregate = result.categories.find((c) => c.name === "requests");
    assert.ok(aggregate, "requests category present");
    assert.equal(aggregate.unit, "requests");
    assert.equal(aggregate.current.used, 150);
    assert.equal(aggregate.current.limit, 1000);
    assert.equal(aggregate.current.remaining, 850);
    assert.equal(aggregate.current.remainingPercent, 85);
  });

  it("creates per-endpoint categories sharing the key-level limit", () => {
    const raw = {
      key: {
        usage: 150,
        limit: 1000,
        search_usage: 100,
        extract_usage: 25,
        crawl_usage: 15,
        map_usage: 7,
        research_usage: 3,
      },
      account: { current_plan: "Bootstrap" },
    };
    const result = normalizeTavilyQuota(raw);
    for (const name of ["search", "extract", "crawl", "map", "research"]) {
      const category = result.categories.find((c) => c.name === name);
      assert.ok(category, `${name} category present`);
      assert.equal(category.unit, "requests");
      assert.equal(category.current.limit, 1000);
    }
    assert.equal(result.categories.find((c) => c.name === "search").current.used, 100);
    assert.equal(result.categories.find((c) => c.name === "extract").current.used, 25);
    assert.equal(result.categories.find((c) => c.name === "crawl").current.used, 15);
    assert.equal(result.categories.find((c) => c.name === "map").current.used, 7);
    assert.equal(result.categories.find((c) => c.name === "research").current.used, 3);
  });

  it("creates the 'plan' category from account.plan_usage/plan_limit", () => {
    const raw = {
      key: { usage: 500, limit: 15000 },
      account: {
        current_plan: "Pay-as-you-go",
        plan_usage: 500,
        plan_limit: 15000,
      },
    };
    const result = normalizeTavilyQuota(raw);
    const plan = result.categories.find((c) => c.name === "plan");
    assert.ok(plan, "plan category present");
    assert.equal(plan.current.used, 500);
    assert.equal(plan.current.limit, 15000);
    assert.equal(plan.current.remainingPercent, 96.7);
    assert.equal(result.plan, "Pay-as-you-go");
  });

  it("omits per-endpoint categories when their counters are missing", () => {
    const raw = {
      key: { usage: 100, limit: 1000, search_usage: 80 },
      account: { current_plan: "Bootstrap" },
    };
    const result = normalizeTavilyQuota(raw);
    assert.ok(result.categories.find((c) => c.name === "search"));
    for (const name of ["extract", "crawl", "map", "research"]) {
      assert.equal(
        result.categories.find((c) => c.name === name),
        undefined,
      );
    }
  });

  it("omits the 'plan' category when account fields are missing", () => {
    const raw = {
      key: { usage: 100, limit: 1000 },
      account: { current_plan: "Bootstrap" },
    };
    const result = normalizeTavilyQuota(raw);
    assert.equal(
      result.categories.find((c) => c.name === "plan"),
      undefined,
    );
    assert.equal(result.plan, "Bootstrap");
  });

  it("omits metadata.plan when account.current_plan is missing", () => {
    const raw = {
      key: { usage: 100, limit: 1000 },
      account: {},
    };
    const result = normalizeTavilyQuota(raw);
    assert.equal(result.plan, undefined);
  });

  it("clamps used > limit to limit so the category never throws QUOTA_ERROR", () => {
    const raw = {
      key: { usage: 1500, limit: 1000 },
      account: { current_plan: "Bootstrap" },
    };
    const result = normalizeTavilyQuota(raw);
    const aggregate = result.categories.find((c) => c.name === "requests");
    assert.equal(aggregate.current.used, 1000);
    assert.equal(aggregate.current.remainingPercent, 0);
  });

  it("rejects a response with missing key.usage; accepts null key.limit as unlimited", () => {
    assert.throws(
      () => normalizeTavilyQuota({ key: { limit: 1000 } }),
      (e) => e instanceof ApiError,
    );
    assert.throws(
      () => normalizeTavilyQuota({}),
      (e) => e instanceof ApiError,
    );
    const unlimited = normalizeTavilyQuota({ key: { usage: 100, limit: null } });
    assert.strictEqual(unlimited.categories.length >= 1, true);
    assert.strictEqual(unlimited.categories[0].name, "requests");
    assert.strictEqual(unlimited.categories[0].current.remainingPercent, 100);
  });

  it("rejects a malformed (non-object) response", () => {
    assert.throws(
      () => normalizeTavilyQuota(null),
      (e) => e instanceof ApiError,
    );
    assert.throws(
      () => normalizeTavilyQuota("foo"),
      (e) => e instanceof ApiError,
    );
    assert.throws(
      () => normalizeTavilyQuota([]),
      (e) => e instanceof ApiError,
    );
  });

  it("sorts categories alphabetically by name", () => {
    const raw = {
      key: {
        usage: 150,
        limit: 1000,
        search_usage: 100,
        extract_usage: 25,
        crawl_usage: 15,
        map_usage: 7,
        research_usage: 3,
      },
      account: {
        current_plan: "Bootstrap",
        plan_usage: 500,
        plan_limit: 15000,
      },
    };
    const result = normalizeTavilyQuota(raw);
    const names = result.categories.map((c) => c.name);
    const sorted = [...names].sort();
    assert.deepEqual(names, sorted);
  });
});

// ---------------------------------------------------------------------------
// Quota: capability invoke
// ---------------------------------------------------------------------------

describe("Tavily Quota — capability invoke", () => {
  it("calls /usage with the API key and parses the response", async () => {
    const usageJson = {
      key: { usage: 100, limit: 1000 },
      account: { current_plan: "Bootstrap" },
    };
    const { adapter, calls } = makeAdapter(async () => makeResponse({ json: usageJson }));

    const result = await adapter.quota.invoke();

    assert.equal(result.provider, "tavily");
    assert.equal(result.status, "ok");
    assert.equal(result.plan, "Bootstrap");

    // Verify the transport call: GET https://api.tavily.com/usage with Bearer auth.
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/usage$/);
    assert.equal(calls[0].init.method, "GET");
    assert.match(calls[0].init.headers.Authorization, new RegExp(`^Bearer ${TEST_API_KEY}$`));
  });

  it("maps 401 to AuthError", async () => {
    const { adapter } = makeAdapter(makeErrorFetch(401));
    await assert.rejects(
      () => adapter.quota.invoke(),
      (e) => e instanceof AuthError && e.help && e.help.includes("TAVILY_API_KEY"),
    );
  });

  it("maps 432 to ApiError(432) with plan-limit message", async () => {
    const { adapter } = makeAdapter(makeErrorFetch(432));
    await assert.rejects(
      () => adapter.quota.invoke(),
      (e) =>
        e instanceof ApiError && e.statusCode === 432 && e.message.includes("plan limit exceeded"),
    );
  });

  it("throws ConfigurationError when TAVILY_API_KEY is missing", async () => {
    let invoked = false;
    const descriptor = createTavilyDescriptor({
      transport: {
        fetch: async () => {
          invoked = true;
          return makeResponse({ json: {} });
        },
        env: { TAVILY_TIMEOUT: "5000" },
      },
    });
    const adapter = descriptor.create({ env: {} });
    await assert.rejects(
      () => adapter.quota.invoke(),
      (e) => e.name === "ConfigurationError" && e.message.includes("TAVILY_API_KEY"),
    );
    assert.equal(invoked, false, "transport must not be called without credentials");
  });
});

// ---------------------------------------------------------------------------
// Diagnostics: probe
// ---------------------------------------------------------------------------

describe("Tavily Diagnostics — probe", () => {
  it("resolves on a successful /search probe", async () => {
    const searchJson = { results: [] };
    const { adapter, calls } = makeAdapter(async () => makeResponse({ json: searchJson }));

    await adapter.diagnostics.invoke({ probe: true });

    // Verify the probe used /search (NOT /usage) with search_depth=basic.
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/search$/);
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.search_depth, "basic");
    assert.equal(body.query, "scoutline-doctor-probe");
  });

  it("does NOT call /usage (would risk 10/10min rate limit)", async () => {
    const searchJson = { results: [] };
    const { adapter, calls } = makeAdapter(async () => makeResponse({ json: searchJson }));

    await adapter.diagnostics.invoke({ probe: true });

    for (const call of calls) {
      assert.doesNotMatch(call.url, /\/usage$/);
    }
  });

  it("short-circuits without network when probe is false", async () => {
    let invoked = false;
    const descriptor = createTavilyDescriptor({
      transport: {
        fetch: async () => {
          invoked = true;
          return makeResponse({ json: { results: [] } });
        },
        env: { TAVILY_TIMEOUT: "5000" },
      },
    });
    const adapter = descriptor.create({ env: { TAVILY_API_KEY: TEST_API_KEY } });
    await adapter.diagnostics.invoke({ probe: false });
    assert.equal(invoked, false);
  });

  it("maps 401 to AuthError", async () => {
    const { adapter } = makeAdapter(makeErrorFetch(401));
    await assert.rejects(
      () => adapter.diagnostics.invoke({ probe: true }),
      (e) => e instanceof AuthError,
    );
  });

  it("maps network errors to NetworkError", async () => {
    const { adapter } = makeAdapter(async () => {
      throw new Error("fetch failed: ECONNREFUSED");
    });
    await assert.rejects(
      () => adapter.diagnostics.invoke({ probe: true }),
      (e) => e instanceof NetworkError && e.message === "Tavily network error",
    );
  });

  it("throws ConfigurationError when TAVILY_API_KEY is missing", async () => {
    const descriptor = createTavilyDescriptor({
      transport: {
        fetch: async () => makeResponse({ json: {} }),
        env: { TAVILY_TIMEOUT: "5000" },
      },
    });
    const adapter = descriptor.create({ env: {} });
    await assert.rejects(
      () => adapter.diagnostics.invoke({ probe: true }),
      (e) => e.name === "ConfigurationError",
    );
  });
});

// ---------------------------------------------------------------------------
// Adapter conformance — quota + diagnostics slots
// ---------------------------------------------------------------------------

describe("Tavily Adapter — quota + diagnostics slots", () => {
  it("create() returns quota and diagnostics", () => {
    const descriptor = createTavilyDescriptor();
    const adapter = descriptor.create({ env: { TAVILY_API_KEY: TEST_API_KEY } });
    assert.equal(adapter.id, "tavily");
    assert.ok(adapter.quota, "quota slot present");
    assert.ok(adapter.diagnostics, "diagnostics slot present");
  });

  it("createTavilyQuotaCapability returns a QuotaCapability with invoke()", () => {
    const capability = createTavilyQuotaCapability({
      env: { TAVILY_API_KEY: TEST_API_KEY },
    });
    assert.equal(typeof capability.invoke, "function");
  });

  it("createTavilyDiagnosticsCapability returns a DiagnosticsCapability with invoke()", () => {
    const capability = createTavilyDiagnosticsCapability({
      env: { TAVILY_API_KEY: TEST_API_KEY },
    });
    assert.equal(typeof capability.invoke, "function");
  });
});
