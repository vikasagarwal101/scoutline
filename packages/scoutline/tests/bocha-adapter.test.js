/**
 * Bocha AI Provider foundation tests (PLAN tasks T1–T4).
 *
 * Verifies the Bocha direct-HTTP transport skeleton:
 *   - Credentials: getBochaApiKey trims BOCHA_API_KEY;
 *     requireBochaApiKey throws ConfigurationError (exit 3) when missing;
 *     isBochaConfigured false for whitespace-only values.
 *   - Envelope unwrap: results live at data.webPages.value (Bing-shaped),
 *     NOT the JSON root. Success only when HTTP 2xx AND (code undefined
 *     or code === 200).
 *   - Search controls: domain → `site:<domain> ` query prefix; recency →
 *     freshness passthrough; contentSize → summary:true; location/type
 *     rejected before any fetch.
 *   - Diagnostics: invoke({probe:true}) POSTs /v1/web-search with
 *     count 1; create() never fetches.
 *
 * Tests inject a single fake `fetch` through
 * `createBochaDescriptor({ transport })`; the fake returns
 * Response-shaped objects. No real network is touched.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import crypto from "node:crypto";

import { createBochaDescriptor } from "../dist/providers/bocha/adapter.js";
import {
  getBochaApiKey,
  isBochaConfigured,
  requireBochaApiKey,
} from "../dist/providers/bocha/credentials.js";
import {
  ApiError,
  ConfigurationError,
  NetworkError,
  QuotaError,
  TimeoutError,
  UnsupportedOptionError,
  ValidationError,
} from "../dist/lib/errors.js";

// ---------------------------------------------------------------------------
// Fake fetch helpers
// ---------------------------------------------------------------------------

function jsonRes(payload) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(payload),
    json: async () => payload,
    headers: { get: () => null },
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

function errorRes(status, body = '{"error":"upstream message that must not leak"}') {
  return {
    ok: false,
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    json: async () => body,
    headers: { get: () => null },
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

function header(call, name) {
  const headers = call.headers || {};
  return headers[name] ?? null;
}

// ---------------------------------------------------------------------------
// Credentials (T1)
// ---------------------------------------------------------------------------

describe("Bocha credentials", () => {
  it("trims BOCHA_API_KEY", () => {
    assert.equal(getBochaApiKey({ BOCHA_API_KEY: " k " }), "k");
    assert.equal(isBochaConfigured({ BOCHA_API_KEY: "  " }), false);
    assert.throws(
      () => requireBochaApiKey({}),
      (e) => {
        assert.ok(e instanceof ConfigurationError);
        assert.equal(e.exitCode, 3);
        assert.equal(e.help, 'export BOCHA_API_KEY="your-bocha-api-key"');
        return true;
      },
    );
  });

  it("getBochaApiKey returns undefined when absent", () => {
    assert.equal(getBochaApiKey({}), undefined);
    assert.equal(getBochaApiKey({ BOCHA_API_KEY: "   " }), undefined);
    assert.equal(isBochaConfigured({ BOCHA_API_KEY: " k " }), true);
  });
});

// ---------------------------------------------------------------------------
// Envelope unwrap (T2)
// ---------------------------------------------------------------------------

describe("Bocha envelope unwrap", () => {
  it("reads webPages from data, not the root", async () => {
    const fetchFn = async () =>
      jsonRes({
        code: 200,
        msg: "success",
        data: {
          webPages: {
            value: [{ name: "T", url: "https://example.test/a", snippet: "S" }],
          },
        },
      });
    const adapter = createBochaDescriptor({ transport: { fetch: fetchFn } }).create({
      env: { BOCHA_API_KEY: "k" },
    });
    assert.ok(adapter.search);
    const rows = await adapter.search.invoke({ query: "q" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].url, "https://example.test/a");
    assert.equal(rows[0].title, "T");
    assert.equal(rows[0].summary, "S");
  });

  it("fixture: FIXTURES.md wrapped payload normalizes webPages.value[] (summary preferred, date, source)", async () => {
    // Copied verbatim from docs/plans/providers-v3/bocha/FIXTURES.md §1.
    const fixture = {
      code: 200,
      msg: "success",
      data: {
        _type: "SearchResponse",
        queryContext: { originalQuery: "DeepSeek R1 架构" },
        webPages: {
          webSearchUrl: "https://bochaai.com/search?q=DeepSeek+R1",
          totalEstimatedMatches: 45000,
          value: [
            {
              id: "https://api.bochaai.com/v1/#WebPages.0",
              name: "DeepSeek-R1 论文详解与架构剖析",
              url: "https://arxiv.org/abs/2501.12948",
              siteName: "arXiv",
              siteIcon: "https://th.bochaai.com/favicon?domain_url=arxiv.org",
              snippet: "DeepSeek-R1 采用纯强化学习驱动推理能力提升...",
              summary:
                "DeepSeek-R1 论文深入探讨了大规模强化学习在消除监督微调阶段冷启动中的应用与成果。",
              dateLastCrawled: "2026-07-20T10:00:00",
            },
            {
              id: "https://api.bochaai.com/v1/#WebPages.1",
              name: "DeepSeek-R1 技术报告全面解读",
              url: "https://zhuanlan.zhihu.com/p/deepseek-r1-analysis",
              siteName: "知乎专栏",
              snippet: "本文从模型结构、奖励模型设计以及训练损失函数三个维度解析 R1...",
              summary: "详细拆解 DeepSeek-R1 的强化学习算法设计与长思维链推理表现。",
              dateLastCrawled: "2026-07-21T08:00:00",
            },
          ],
        },
      },
    };
    const adapter = createBochaDescriptor({
      transport: { fetch: async () => jsonRes(fixture) },
    }).create({ env: { BOCHA_API_KEY: "k" } });
    const rows = await adapter.search.invoke({ query: "DeepSeek R1 架构" });
    assert.equal(rows.length, 2);
    assert.deepStrictEqual(
      [...rows],
      [
        {
          title: "DeepSeek-R1 论文详解与架构剖析",
          url: "https://arxiv.org/abs/2501.12948",
          summary:
            "DeepSeek-R1 论文深入探讨了大规模强化学习在消除监督微调阶段冷启动中的应用与成果。",
          source: "bocha (arXiv)",
          date: "2026-07-20T10:00:00",
        },
        {
          title: "DeepSeek-R1 技术报告全面解读",
          url: "https://zhuanlan.zhihu.com/p/deepseek-r1-analysis",
          summary: "详细拆解 DeepSeek-R1 的强化学习算法设计与长思维链推理表现。",
          source: "bocha (知乎专栏)",
          date: "2026-07-21T08:00:00",
        },
      ],
    );
  });

  it("falls back to snippet when summary is absent and drops rows without url", async () => {
    const adapter = createBochaDescriptor({
      transport: {
        fetch: async () =>
          jsonRes({
            code: 200,
            data: {
              webPages: {
                value: [
                  { name: "Snip", url: "https://example.test/s", snippet: "snip body" },
                  { name: "NoUrl", snippet: "dropped" },
                ],
              },
            },
          }),
      },
    }).create({ env: { BOCHA_API_KEY: "k" } });
    const rows = await adapter.search.invoke({ query: "q" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].summary, "snip body");
    assert.equal(rows[0].url, "https://example.test/s");
  });

  it("POSTs web-search with Bearer and site + freshness + summary", async () => {
    const calls = [];
    const adapter = createBochaDescriptor({
      transport: {
        fetch: async (url, init) => {
          calls.push({ url: String(url), body: JSON.parse(init.body), headers: init.headers });
          return jsonRes({
            code: 200,
            data: {
              webPages: { value: [{ name: "T", url: "https://example.test/a", snippet: "S" }] },
            },
          });
        },
      },
    }).create({ env: { BOCHA_API_KEY: "k" } });
    await adapter.search.invoke({
      query: "q",
      controls: { domain: "example.test", recency: "oneWeek", contentSize: "high" },
    });
    assert.match(calls[0].url, /^https:\/\/api\.bochaai\.com\/v1\/web-search\/?$/);
    assert.equal(header(calls[0], "Authorization"), "Bearer k");
    assert.match(calls[0].body.query, /site:example\.test/);
    assert.equal(calls[0].body.freshness, "oneWeek");
    assert.equal(calls[0].body.summary, true);
    assert.equal(calls[0].body.count, 10);
  });

  it("appends the topic keyword to the query via applySearchTopic", async () => {
    const calls = [];
    const adapter = createBochaDescriptor({
      transport: {
        fetch: async (url, init) => {
          calls.push({ body: JSON.parse(init.body) });
          return jsonRes({ code: 200, data: { webPages: { value: [] } } });
        },
      },
    }).create({ env: { BOCHA_API_KEY: "k" } });
    await adapter.search.invoke({ query: "tesla", controls: { topic: "finance" } });
    assert.equal(calls[0].body.query, "tesla financial");
  });

  it("cacheIdentity fingerprints the credential as lowercase sha256 hex", () => {
    const adapter = createBochaDescriptor({
      transport: { fetch: async () => jsonRes({ code: 200, data: { webPages: { value: [] } } }) },
    }).create({ env: { BOCHA_API_KEY: "k" } });
    const identity = adapter.search.cacheIdentity({ query: "q", controls: { recency: "oneWeek" } });
    assert.equal(identity.provider, "bocha");
    assert.equal(identity.capability, "search");
    assert.equal(
      identity.credentialFingerprint,
      crypto.createHash("sha256").update("k").digest("hex"),
    );
    assert.equal(identity.request.query, "q");
  });

  it("forwards the caller's requested count to the wire and defaults to 10 (#211)", async () => {
    const calls = [];
    const adapter = createBochaDescriptor({
      transport: {
        fetch: async (url, init) => {
          calls.push({ body: JSON.parse(init.body) });
          return jsonRes({
            code: 200,
            data: { webPages: { value: [{ name: "T", url: "https://example.test/a", snippet: "S" }] } },
          });
        },
      },
    }).create({ env: { BOCHA_API_KEY: "k" } });
    await adapter.search.invoke({ query: "wide" }, undefined, 50);
    assert.equal(calls[0].body.count, 50, "requested count must reach the Bocha wire request");
    await adapter.search.invoke({ query: "narrow" }, undefined, 3);
    assert.equal(calls[1].body.count, 3);
    await adapter.search.invoke({ query: "default" });
    assert.equal(calls[2].body.count, 10, "absent count keeps the wire default of 10");
  });

  it("partitions the cache identity by requested count; default stays count-free (#211)", () => {
    const adapter = createBochaDescriptor().create({ env: { BOCHA_API_KEY: "k" } });
    const withCount = adapter.search.cacheIdentity({ query: "q" }, { count: 50 });
    assert.equal(withCount.request.count, 50, "forwarded count must partition the cache entry");
    const withoutCount = adapter.search.cacheIdentity({ query: "q" });
    assert.equal(
      withoutCount.request.count,
      undefined,
      "default path must stay byte-compatible with pre-#211 cache keys",
    );
  });
});

// ---------------------------------------------------------------------------
// Rejected controls + HTTP-200 application errors (T3)
// ---------------------------------------------------------------------------

describe("Bocha controls + application errors", () => {
  it("search validate rejects location and type before fetch", () => {
    let calls = 0;
    const adapter = createBochaDescriptor({
      transport: { fetch: async () => { calls += 1; throw new Error("no"); } },
    }).create({ env: { BOCHA_API_KEY: "k" } });
    assert.throws(
      () => adapter.search.validate({ query: "q", controls: { location: "us" } }),
      (e) => e instanceof UnsupportedOptionError && e.provider === "bocha" && e.capability === "search" && e.option === "location",
    );
    assert.throws(
      () => adapter.search.validate({ query: "q", controls: { type: "video" } }),
      (e) => e instanceof UnsupportedOptionError && e.provider === "bocha" && e.capability === "search" && e.option === "type",
    );
    assert.throws(
      () => adapter.search.validate({ query: "   " }),
      (e) => e instanceof ValidationError,
    );
    assert.equal(calls, 0);
  });

  it("HTTP 200 code 401 is ConfigurationError", async () => {
    const adapter = createBochaDescriptor({
      transport: { fetch: async () => jsonRes({ code: 401, msg: "invalid key", data: {} }) },
    }).create({ env: { BOCHA_API_KEY: "k" } });
    await assert.rejects(
      () => adapter.search.invoke({ query: "q" }),
      (e) => e instanceof ConfigurationError && e.code === "CONFIGURATION_ERROR",
    );
  });

  it("HTTP 200 code 200 with NO webPages in data fails closed (ApiError)", async () => {
    const adapter = createBochaDescriptor({
      transport: { fetch: async () => jsonRes({ code: 200, msg: "success", data: {} }) },
    }).create({ env: { BOCHA_API_KEY: "k" } });
    const err = await adapter.search.invoke({ query: "q" }).then(() => null, (e) => e);
    assert.ok(err instanceof ApiError, `must be ApiError, got ${err && err.constructor.name}`);
    assert.match(err.message, /malformed response envelope/);
  });

  it("HTTP 200 with non-array webPages.value fails closed (ApiError)", async () => {
    const adapter = createBochaDescriptor({
      transport: {
        fetch: async () =>
          jsonRes({ code: 200, msg: "success", data: { webPages: { value: "garbage" } } }),
      },
    }).create({ env: { BOCHA_API_KEY: "k" } });
    const err = await adapter.search.invoke({ query: "q" }).then(() => null, (e) => e);
    assert.ok(err instanceof ApiError, `must be ApiError, got ${err && err.constructor.name}`);
    assert.match(err.message, /malformed response envelope/);
  });

  it("HTTP 200 envelope code 403 is terminal QuotaError", async () => {
    const adapter = createBochaDescriptor({
      transport: { fetch: async () => jsonRes({ code: 403, msg: "insufficient balance", data: {} }) },
    }).create({ env: { BOCHA_API_KEY: "k" } });
    await assert.rejects(
      () => adapter.search.invoke({ query: "q" }),
      (e) => e instanceof QuotaError && e.code === "QUOTA_ERROR",
    );
  });

  it("HTTP 200 envelope code 400 is ValidationError", async () => {
    const adapter = createBochaDescriptor({
      transport: { fetch: async () => jsonRes({ code: 400, msg: "bad param", data: {} }) },
    }).create({ env: { BOCHA_API_KEY: "k" } });
    await assert.rejects(
      () => adapter.search.invoke({ query: "q" }),
      (e) => e instanceof ValidationError && e.code === "VALIDATION_ERROR",
    );
  });

  it("HTTP 200 with a non-200 non-401 envelope code is an ApiError; raw msg never leaks", async () => {
    const leakMsg = "internal boom DO-NOT-SURFACE";
    const adapter = createBochaDescriptor({
      transport: { fetch: async () => jsonRes({ code: 500, msg: leakMsg, data: {} }) },
    }).create({ env: { BOCHA_API_KEY: "k" } });
    const err = await adapter.search.invoke({ query: "q" }).then(() => null, (e) => e);
    assert.ok(err instanceof ApiError, `must be ApiError, got ${err && err.constructor.name}`);
    assert.ok(!err.message.includes(leakMsg), `raw msg must not leak: ${err.message}`);
  });

  it("invoke() rejects location before any fetch (validate runs inside invoke)", async () => {
    let calls = 0;
    const adapter = createBochaDescriptor({
      transport: { fetch: async () => { calls += 1; return jsonRes({ code: 200, data: {} }); } },
    }).create({ env: { BOCHA_API_KEY: "k" } });
    await assert.rejects(
      () => adapter.search.invoke({ query: "q", controls: { type: "video" } }),
      (e) => e instanceof UnsupportedOptionError && e.option === "type",
    );
    assert.equal(calls, 0);
  });

  it("HTTP 403 maps to a terminal QuotaError (insufficient balance)", async () => {
    const adapter = createBochaDescriptor({
      transport: { fetch: async () => errorRes(403) },
    }).create({ env: { BOCHA_API_KEY: "k" } });
    const err = await adapter.search.invoke({ query: "q" }).then(() => null, (e) => e);
    assert.ok(err instanceof QuotaError, `must be QuotaError, got ${err && err.constructor.name}`);
    assert.equal(err.retryable, false, "exhausted quota must never retry");
  });

  it("HTTP 401 maps to ConfigurationError with the export hint", async () => {
    const adapter = createBochaDescriptor({
      transport: { fetch: async () => errorRes(401) },
    }).create({ env: { BOCHA_API_KEY: "k" } });
    const err = await adapter.search.invoke({ query: "q" }).then(() => null, (e) => e);
    assert.ok(err instanceof ConfigurationError);
    assert.equal(err.exitCode, 3);
    assert.equal(err.help, 'export BOCHA_API_KEY="your-bocha-api-key"');
  });

  it("HTTP 429 maps to ApiError 429", async () => {
    const adapter = createBochaDescriptor({
      transport: { fetch: async () => errorRes(429) },
    }).create({ env: { BOCHA_API_KEY: "k" } });
    const err = await adapter.search.invoke({ query: "q" }).then(() => null, (e) => e);
    assert.ok(err instanceof ApiError && err.statusCode === 429);
  });

  it("HTTP 400 maps to ValidationError", async () => {
    const adapter = createBochaDescriptor({
      transport: { fetch: async () => errorRes(400) },
    }).create({ env: { BOCHA_API_KEY: "k" } });
    const err = await adapter.search.invoke({ query: "q" }).then(() => null, (e) => e);
    assert.ok(err instanceof ValidationError, `must be ValidationError, got ${err && err.constructor.name}`);
  });

  it("HTTP 5xx maps to ApiError with the real status; raw body never leaks", async () => {
    const bodyText = "leak-marker-DO-NOT-EMBED-this-string-into-errors";
    const adapter = createBochaDescriptor({
      transport: { fetch: async () => errorRes(500, bodyText) },
    }).create({ env: { BOCHA_API_KEY: "k" } });
    const err = await adapter.search.invoke({ query: "q" }).then(() => null, (e) => e);
    assert.ok(err instanceof ApiError && err.statusCode === 500);
    assert.ok(!err.message.includes(bodyText), `raw body must not leak: ${err.message}`);
  });

  it("a fetch network failure maps to NetworkError with a sanitized message", async () => {
    const adapter = createBochaDescriptor({
      transport: { fetch: async () => { throw new Error("fetch failed: ECONNREFUSED"); } },
    }).create({ env: { BOCHA_API_KEY: "k" } });
    const err = await adapter.search.invoke({ query: "q" }).then(() => null, (e) => e);
    assert.ok(err instanceof NetworkError, `must be NetworkError, got ${err && err.constructor.name}`);
    assert.equal(err.message, "Bocha AI network error");
  });

  it("an AbortError from the AbortController maps to TimeoutError", async () => {
    const adapter = createBochaDescriptor({
      transport: {
        fetch: async () => {
          throw Object.assign(new Error("aborted"), { name: "AbortError" });
        },
      },
    }).create({ env: { BOCHA_API_KEY: "k" } });
    const err = await adapter.search.invoke({ query: "q" }).then(() => null, (e) => e);
    assert.ok(err instanceof TimeoutError, `must be TimeoutError, got ${err && err.constructor.name}`);
    assert.ok(err.help.includes("BOCHA_TIMEOUT"), `help must name BOCHA_TIMEOUT: ${err.help}`);
  });
});

// ---------------------------------------------------------------------------
// Diagnostics (T4)
// ---------------------------------------------------------------------------

describe("Bocha diagnostics", () => {
  it("diagnostics POSTs count 1; create() does not fetch", async () => {
    let calls = 0;
    const descriptor = createBochaDescriptor({
      transport: { fetch: async (_url, init) => {
        calls += 1;
        const body = JSON.parse(init.body);
        assert.equal(body.count, 1);
        assert.equal(body.query, "scoutline-doctor-probe");
        return jsonRes({ code: 200, data: { webPages: { value: [] } } });
      } },
    });
    descriptor.create({ env: { BOCHA_API_KEY: "k" } });
    assert.equal(calls, 0);
    await descriptor.create({ env: { BOCHA_API_KEY: "k" } }).diagnostics.invoke({ probe: true });
    assert.equal(calls, 1);
  });

  it("invoke({probe:false}) resolves without any fetch call", async () => {
    let calls = 0;
    const adapter = createBochaDescriptor({
      transport: { fetch: async () => { calls += 1; return jsonRes({ code: 200, data: {} }); } },
    }).create({ env: { BOCHA_API_KEY: "k" } });
    await adapter.diagnostics.invoke({ probe: false });
    assert.equal(calls, 0);
  });

  it("a probe failure surfaces a normalized error with no raw body leak", async () => {
    const bodyText = "leak-marker-DO-NOT-EMBED-in-diagnostics";
    const adapter = createBochaDescriptor({
      transport: { fetch: async () => errorRes(500, bodyText) },
    }).create({ env: { BOCHA_API_KEY: "k" } });
    const err = await adapter.diagnostics.invoke({ probe: true }).then(() => null, (e) => e);
    assert.ok(err instanceof ApiError, `must be ApiError, got ${err && err.constructor.name}`);
    assert.ok(!err.message.includes(bodyText), `raw body must not leak: ${err.message}`);
  });

  it("a missing key throws ConfigurationError (exit 3) BEFORE any fetch", async () => {
    let calls = 0;
    const adapter = createBochaDescriptor({
      transport: { fetch: async () => { calls += 1; return jsonRes({ code: 200, data: {} }); } },
    }).create({ env: {} });
    const err = await adapter.diagnostics.invoke({ probe: true }).then(() => null, (e) => e);
    assert.ok(err instanceof ConfigurationError);
    assert.equal(err.exitCode, 3);
    assert.equal(calls, 0);
  });
});
