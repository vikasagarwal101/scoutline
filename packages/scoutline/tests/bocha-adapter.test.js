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
import { ConfigurationError } from "../dist/lib/errors.js";

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
});
