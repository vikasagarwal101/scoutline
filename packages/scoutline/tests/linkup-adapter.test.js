/**
 * Linkup Adapter conformance tests.
 *
 * Verifies the Linkup direct-HTTP transport Adapter at the public seams:
 *   - Credentials: LINKUP_API_KEY trimming, presence, ConfigurationError
 *   - Search: `type` rejection before fetch, domain -> includeDomains,
 *     contentSize -> depth, Bearer auth, name/url/content normalization
 *   - Research: async submit/poll lifecycle — single POST /research,
 *     poll GET /research/:id to completion, model -> reasoningDepth
 *     mapping, failed-poll ApiError (no raw body), state-file resume
 *
 * Tests inject a fake `fetch` through descriptor transport deps; no real
 * network is touched.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  getLinkupApiKey,
  isLinkupConfigured,
  requireLinkupApiKey,
} from "../dist/providers/linkup/credentials.js";
import { createLinkupDescriptor } from "../dist/providers/linkup/adapter.js";
import {
  createLinkupResearch,
  fetchLinkupSearch,
} from "../dist/providers/linkup/client.js";
import { normalizeLinkupQuota } from "../dist/providers/linkup/quota.js";
import {
  computeAsyncJobStateHash,
  createInMemoryAsyncJobStateFile,
} from "../dist/lib/async-job-state.js";
import { ApiError, ConfigurationError, UnsupportedOptionError } from "../dist/lib/errors.js";
import { PROVIDER_IDS } from "../dist/providers/types.js";
import { getProviderDescriptor } from "../dist/providers/registry.js";
import {
  getCapabilityMapping,
  getProviderAuthorityPolicy,
} from "../dist/lib/quota-mapping.js";

describe("Linkup credentials & transport timeout", () => {
  it("trims LINKUP_API_KEY and throws ConfigurationError when missing", () => {
    assert.equal(getLinkupApiKey({ LINKUP_API_KEY: " abc " }), "abc");
    assert.equal(isLinkupConfigured({}), false);
    assert.throws(() => requireLinkupApiKey({}), ConfigurationError);
  });

  it("caps oversized LINKUP_TIMEOUT to Node 32-bit integer maximum", async () => {
    const timerDelays = [];
    const customSetTimeout = (cb, ms) => {
      timerDelays.push(ms);
      return setTimeout(cb, 0);
    };

    await fetchLinkupSearch(
      "k",
      { q: "test" },
      {
        fetch: async () => ({
          ok: true,
          status: 200,
          json: async () => ({ results: [] }),
          text: async () => JSON.stringify({ results: [] }),
          headers: { get: () => null },
        }),
        setTimeout: customSetTimeout,
        clearTimeout: () => {},
        env: { LINKUP_TIMEOUT: "999999999999" },
      },
    );

    assert.equal(timerDelays.length, 1);
    assert.equal(timerDelays[0], 2147483647);
  });

  it("createLinkupResearch defaults outputType to sourcedAnswer", async () => {
    let sentBody = null;
    await createLinkupResearch(
      "k",
      { q: "research query" },
      {
        fetch: async (_url, init) => {
          sentBody = JSON.parse(init.body);
          return {
            ok: true,
            status: 200,
            json: async () => ({ id: "job-1", status: "pending" }),
            text: async () => JSON.stringify({ id: "job-1", status: "pending" }),
            headers: { get: () => null },
          };
        },
      },
    );

    assert.ok(sentBody);
    assert.equal(sentBody.q, "research query");
    assert.equal(sentBody.mode, "research");
    assert.equal(sentBody.outputType, "sourcedAnswer");
  });
});

describe("Linkup Search Adapter — validation and control mapping", () => {
  it("search validate rejects type before fetch", () => {
    let calls = 0;
    const adapter = createLinkupDescriptor({
      transport: { fetch: async () => { calls += 1; throw new Error("no"); } },
    }).create({ env: { LINKUP_API_KEY: "k" } });
    assert.ok(adapter.search);
    assert.throws(
      () => adapter.search.validate({ query: "q", controls: { type: "video" } }),
      (e) => e instanceof UnsupportedOptionError && e.provider === "linkup" && e.capability === "search" && e.option === "type",
    );
    assert.equal(calls, 0);
  });

  it("search invoke POSTs /v1/search and maps includeDomains with Bearer auth", async () => {
    const LINKUP_SEARCH_RAW = {
      results: [
        {
          name: "Linkup Documentation",
          url: "https://docs.linkup.so",
          content: "Linkup provides deep search APIs.",
          favicon: "https://docs.linkup.so/favicon.ico",
          type: "text",
        },
      ],
    };
    const calls = [];
    const adapter = createLinkupDescriptor({
      transport: {
        fetch: async (url, init) => {
          calls.push({ url: String(url), method: init?.method, headers: init?.headers, body: JSON.parse(init?.body) });
          return {
            ok: true,
            status: 200,
            json: async () => LINKUP_SEARCH_RAW,
            text: async () => JSON.stringify(LINKUP_SEARCH_RAW),
            headers: { get: () => null },
          };
        },
      },
    }).create({ env: { LINKUP_API_KEY: "k" } });

    const rows = await adapter.search.invoke({
      query: "linkup",
      controls: { domain: "linkup.so", contentSize: "high" },
    });

    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/v1\/search$/);
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].headers["Authorization"] ?? calls[0].headers["authorization"], "Bearer k");
    assert.deepEqual(calls[0].body.includeDomains, ["linkup.so"]);
    assert.equal(calls[0].body.depth, "deep");
    assert.equal(rows[0].title, "Linkup Documentation");
    assert.equal(rows[0].url, "https://docs.linkup.so");
    assert.equal(rows[0].summary, "Linkup provides deep search APIs.");
  });

  it("search recency clamps month-end dates to valid target month end", async () => {
    let sentBody = null;
    const march31Epoch = Date.parse("2026-03-31T12:00:00.000Z");
    const adapter = createLinkupDescriptor({
      now: () => march31Epoch,
      transport: {
        fetch: async (_url, init) => {
          sentBody = JSON.parse(init?.body ?? "{}");
          return {
            ok: true,
            status: 200,
            json: async () => ({ results: [] }),
            text: async () => JSON.stringify({ results: [] }),
            headers: { get: () => null },
          };
        },
      },
    }).create({ env: { LINKUP_API_KEY: "k" } });

    await adapter.search.invoke({
      query: "recency test",
      controls: { recency: "oneMonth" },
    });

    assert.ok(sentBody);
    assert.equal(sentBody.fromDate, "2026-02-28");
    assert.equal(sentBody.toDate, "2026-03-31");
  });

  it("search recency clamps leap-year Feb 29 to Feb 28 for oneYear", async () => {
    let sentBody = null;
    const leapYearEpoch = Date.parse("2024-02-29T12:00:00.000Z");
    const adapter = createLinkupDescriptor({
      now: () => leapYearEpoch,
      transport: {
        fetch: async (_url, init) => {
          sentBody = JSON.parse(init?.body ?? "{}");
          return {
            ok: true,
            status: 200,
            json: async () => ({ results: [] }),
            text: async () => JSON.stringify({ results: [] }),
            headers: { get: () => null },
          };
        },
      },
    }).create({ env: { LINKUP_API_KEY: "k" } });

    await adapter.search.invoke({
      query: "leap recency test",
      controls: { recency: "oneYear" },
    });

    assert.ok(sentBody);
    assert.equal(sentBody.fromDate, "2023-02-28");
    assert.equal(sentBody.toDate, "2024-02-29");
  });
});

describe("Linkup Reader Adapter — renderJs control", () => {
  it("reader.fetch POSTs /fetch with renderJs true", async () => {
    const raw = { markdown: "# Page", url: "https://example.test/page" };
    const calls = [];
    const adapter = createLinkupDescriptor({
      transport: { fetch: async (url, init) => {
        calls.push({ url: String(url), body: JSON.parse(init.body) });
        return { ok: true, status: 200, json: async () => raw, text: async () => JSON.stringify(raw), headers: { get: () => null } };
      } },
    }).create({ env: { LINKUP_API_KEY: "k" } });
    const result = await adapter.reader.fetch.invoke({ url: "https://example.test/page" });
    assert.match(calls[0].url, /\/v1\/fetch$/);
    assert.equal(calls[0].body.renderJs, true);
    assert.equal(result.schemaVersion, 1);
    assert.ok(result.content.length > 0);
    assert.equal(adapter.reader.fetch.kind, "reader-fetch");
  });
});

// ---------------------------------------------------------------------------
// Research — async submit/poll lifecycle
// ---------------------------------------------------------------------------

/** Response double for the injected transport `fetch`. */
function jsonRes(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
    headers: { get: () => null },
  };
}

describe("Linkup Research Adapter — async polling lifecycle", () => {
  it("research.run.validate rejects unsupported options", () => {
    const adapter = createLinkupDescriptor().create({ env: { LINKUP_API_KEY: "k" } });
    assert.ok(adapter.research);

    assert.throws(
      () => adapter.research.run.validate({ query: "q", outputLength: "long" }),
      (e) => e instanceof UnsupportedOptionError && e.provider === "linkup" && e.option === "outputLength",
    );
    assert.throws(
      () => adapter.research.run.validate({ query: "q", citationFormat: "numeric" }),
      (e) => e instanceof UnsupportedOptionError && e.provider === "linkup" && e.option === "citationFormat",
    );
    assert.throws(
      () => adapter.research.run.validate({ query: "q", domain: "example.com" }),
      (e) => e instanceof UnsupportedOptionError && e.provider === "linkup" && e.option === "domain",
    );
  });

  it("research.run submits once then polls to completion", async () => {
    const calls = [];
    const adapter = createLinkupDescriptor({
      transport: {
        fetch: async (url, init) => {
          calls.push({ url: String(url), method: init?.method ?? "GET" });
          if (String(url).endsWith("/research") && (init?.method ?? "GET") === "POST") {
            return jsonRes({ id: "job-1", status: "pending" });
          }
          if (String(url).includes("/research/job-1")) {
            return jsonRes({ status: "completed", markdown: "## Report", output: "## Report", sources: [{ name: "S", url: "https://example.test/s", snippet: "x" }] });
          }
          throw new Error(String(url));
        },
        setTimeout: (cb) => { setImmediate(cb); return 0; },
        clearTimeout: () => {},
      },
      researchStateFile: createInMemoryAsyncJobStateFile(),
    }).create({ env: { LINKUP_API_KEY: "k" } });
    const result = await adapter.research.run.invoke({ query: "q", model: "auto" });
    assert.equal(calls.filter((c) => c.method === "POST").length, 1);
    assert.ok(calls.some((c) => c.url.includes("/research/job-1")));
    assert.equal(result.schemaVersion, 1);
    assert.ok(result.report.includes("Report"));
    assert.equal(adapter.research.run.kind, "research-fetch");
  });

  it("research submit maps model to reasoningDepth (mini S, auto L, pro XL)", async () => {
    const bodies = [];
    const makeAdapter = () => createLinkupDescriptor({
      transport: {
        fetch: async (url, init) => {
          if ((init?.method ?? "GET") === "POST" && String(url).endsWith("/research")) {
            bodies.push(JSON.parse(init.body));
            return jsonRes({ id: "job-depth", status: "pending" });
          }
          return jsonRes({ status: "completed", output: { answer: "R", sources: [] } });
        },
        setTimeout: (cb) => { setImmediate(cb); return 0; },
        clearTimeout: () => {},
      },
      researchStateFile: createInMemoryAsyncJobStateFile(),
    }).create({ env: { LINKUP_API_KEY: "k" } });

    await makeAdapter().research.run.invoke({ query: "q", model: "mini" });
    await makeAdapter().research.run.invoke({ query: "q", model: "auto" });
    await makeAdapter().research.run.invoke({ query: "q", model: "pro" });

    assert.deepEqual(
      bodies.map((b) => b.reasoningDepth),
      ["S", "L", "XL"],
    );
    assert.equal(bodies[1].mode, "research");
    assert.equal(bodies[1].outputType, "sourcedAnswer");
    assert.equal(bodies[1].q, "q");
  });

  it("failed poll throws ApiError without raw body in message", async () => {
    const adapter = createLinkupDescriptor({
      transport: {
        fetch: async (url, init) => {
          if ((init?.method ?? "GET") === "POST" && String(url).endsWith("/research")) {
            return jsonRes({ id: "job-fail", status: "pending" });
          }
          return jsonRes({ status: "failed", error: "RAW_SECRET_BODY_DETAIL" });
        },
        setTimeout: (cb) => { setImmediate(cb); return 0; },
        clearTimeout: () => {},
      },
      researchStateFile: createInMemoryAsyncJobStateFile(),
    }).create({ env: { LINKUP_API_KEY: "k" } });
    await assert.rejects(
      adapter.research.run.invoke({ query: "q" }),
      (e) => e instanceof ApiError && !e.message.includes("RAW_SECRET_BODY_DETAIL"),
    );
  });

  it("research.run resumes a persisted job without a second POST", async () => {
    const calls = [];
    const stateFile = createInMemoryAsyncJobStateFile();
    const adapter = createLinkupDescriptor({
      transport: {
        fetch: async (url, init) => {
          calls.push({ url: String(url), method: init?.method ?? "GET" });
          if (String(url).includes("/research/job-existing")) {
            return jsonRes({ status: "completed", output: { answer: "Resumed report", sources: [] } });
          }
          return jsonRes({ id: "job-new", status: "pending" });
        },
        setTimeout: (cb) => { setImmediate(cb); return 0; },
        clearTimeout: () => {},
      },
      researchStateFile: stateFile,
    }).create({ env: { LINKUP_API_KEY: "k" } });

    const identity = adapter.research.run.cacheIdentity({ query: "resume q", model: "auto" });
    const identityHash = computeAsyncJobStateHash({
      provider: identity.provider,
      capability: identity.capability,
      credentialFingerprint: identity.credentialFingerprint,
      request: identity.request,
    });
    await stateFile.write(identityHash, {
      requestId: "job-existing",
      identityHash,
      createdAt: new Date().toISOString(),
      status: "pending",
    });

    const result = await adapter.research.run.invoke({ query: "resume q", model: "auto" });
    assert.equal(calls.filter((c) => c.method === "POST").length, 0);
    assert.equal(result.report, "Resumed report");
    assert.equal(stateFile.store.size, 0);
  });
});

// ---------------------------------------------------------------------------
// Quota + Diagnostics (GET /credits/balance)
// ---------------------------------------------------------------------------

describe("Linkup Quota + Diagnostics Adapters — credits balance", () => {
  it("quota.invoke maps balance to credits remaining without inventing a limit", async () => {
    const adapter = createLinkupDescriptor({
      transport: { fetch: async (url) => {
        assert.match(String(url), /\/credits\/balance$/);
        return jsonRes({ balance: 42 });
      } },
    }).create({ env: { LINKUP_API_KEY: "k" } });
    const dash = await adapter.quota.invoke();
    assert.equal(dash.provider, "linkup");
    assert.equal(dash.status, "ok");
    assert.equal(dash.categories[0].name, "credits");
    assert.equal(dash.categories[0].unit, "credits");
    assert.equal(dash.categories[0].current.remaining, 42);
    assert.equal(dash.categories[0].current.remainingPercent, undefined);
  });

  it("normalizeLinkupQuota preserves negative balances without throwing QUOTA_ERROR", () => {
    const dash = normalizeLinkupQuota({ balance: -15.5 });
    assert.equal(dash.provider, "linkup");
    assert.equal(dash.status, "ok");
    assert.equal(dash.categories[0].name, "credits");
    assert.equal(dash.categories[0].current.remaining, -15.5);
    assert.equal(dash.categories[0].current.remainingPercent, undefined);
  });

  it("create() does not fetch and advertises quota + diagnostics capabilities", async () => {
    let calls = 0;
    const descriptor = createLinkupDescriptor({
      transport: { fetch: async () => { calls += 1; return jsonRes({ balance: 1 }); } },
    });
    const adapter = descriptor.create({ env: { LINKUP_API_KEY: "k" } });
    assert.equal(calls, 0);
    assert.ok(adapter.quota);
    assert.ok(adapter.diagnostics);
    assert.ok(descriptor.capabilities().has("quota"));
    assert.ok(descriptor.capabilities().has("diagnostics"));
  });

  it("diagnostics.invoke probes GET /credits/balance and never POSTs", async () => {
    const calls = [];
    const adapter = createLinkupDescriptor({
      transport: { fetch: async (url, init) => {
        calls.push({ url: String(url), method: init?.method ?? "GET" });
        return jsonRes({ balance: 42 });
      } },
    }).create({ env: { LINKUP_API_KEY: "k" } });
    await adapter.diagnostics.invoke({ probe: true });
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/credits\/balance$/);
    assert.equal(calls[0].method, "GET");
  });

  it("diagnostics.invoke skips the transport when probe is false", async () => {
    let calls = 0;
    const adapter = createLinkupDescriptor({
      transport: { fetch: async () => { calls += 1; return jsonRes({ balance: 1 }); } },
    }).create({ env: { LINKUP_API_KEY: "k" } });
    await adapter.diagnostics.invoke({ probe: false });
    assert.equal(calls, 0);
  });
});

describe("Linkup registry and quota mapping", () => {
  it("PROVIDER_IDS includes linkup", () => {
    assert.ok(
      PROVIDER_IDS.includes("linkup"),
      "PROVIDER_IDS must include the linkup provider id",
    );
  });

  it("production registry resolves the linkup descriptor with all five capabilities", () => {
    const descriptor = getProviderDescriptor("linkup");
    assert.equal(descriptor.id, "linkup");
    const caps = descriptor.capabilities();
    assert.equal(caps.size, 5, "search/reader/research/quota/diagnostics — nothing more");
    for (const capability of ["search", "reader", "research", "quota", "diagnostics"]) {
      assert.ok(caps.has(capability), `linkup must advertise ${capability}`);
    }
    assert.ok(descriptor.isConfigured({ LINKUP_API_KEY: "k" }));
    assert.equal(descriptor.isConfigured({}), false);
  });

  it("linkup authority policy is always-unknown with a reason", () => {
    const policy = getProviderAuthorityPolicy("linkup");
    assert.ok(policy, "linkup must have an authority-policy row");
    assert.equal(policy.kind, "always-unknown");
    assert.match(policy.reason, /credit remaining balance/i);
  });

  it("linkup is not in CAPABILITY_MAPPINGS (always-unknown tier)", () => {
    for (const capability of ["search", "reader", "research"]) {
      const mapping = getCapabilityMapping("linkup", capability);
      assert.equal(mapping, undefined);
    }
  });
});
