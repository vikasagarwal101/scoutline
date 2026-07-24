/**
 * Firecrawl Adapter tests (FC-03, tech-plan D3–D6).
 *
 * Verifies the Firecrawl direct-HTTP transport Adapter:
 *   - Search validation: empty query, --location rejection
 *   - Search normalization: data[].title/url/description|markdown -> title/url/summary
 *   - Search control mapping: contentSize high -> scrapeOptions.formats,
 *     topic -> sources, recency -> tbs, domain -> includeDomains
 *   - Reader normalization: data.markdown|text -> content,
 *     metadata.sourceURL -> finalUrl, metadata.title -> title
 *   - Reader --no-images -> removeBase64Images; Z.AI-only opts rejected
 *   - Map normalization: links[] -> urls
 *   - Error-envelope dual-check: 200 with {success:false} -> ApiError 422
 *   - Failure normalization: auth (401) -> AuthError
 *
 * Tests inject a single fake `fetch` through FirecrawlAdapterDependencies.transport;
 * the fake returns Response-shaped objects (ok/status/json/text). No real network.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createFirecrawlDescriptor } from "../dist/providers/firecrawl/adapter.js";
import {
  ApiError,
  AuthError,
  UnsupportedOptionError,
  ValidationError,
} from "../dist/lib/errors.js";
import {
  computeAsyncJobStateHash,
  createInMemoryAsyncJobStateFile,
} from "../dist/lib/async-job-state.js";

const TEST_API_KEY = "fc-test-key-DO-NOT-LEAK";

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
  const descriptor = createFirecrawlDescriptor({
    transport: { fetch: fn, env: { FIRECRAWL_TIMEOUT: "5000" } },
  });
  const adapter = descriptor.create({ env: { FIRECRAWL_API_KEY: TEST_API_KEY } });
  return { adapter, calls };
}

function lastBody(calls) {
  return JSON.parse(calls[calls.length - 1].init.body);
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

describe("Firecrawl Search Adapter", () => {
  it("rejects an empty query with ValidationError", () => {
    const { adapter } = makeAdapter(async () => makeResponse());
    assert.throws(() => adapter.search.validate({ query: "   " }), ValidationError);
  });

  it("rejects --location with UnsupportedOptionError", () => {
    const { adapter } = makeAdapter(async () => makeResponse());
    assert.throws(
      () => adapter.search.validate({ query: "x", controls: { location: "us" } }),
      UnsupportedOptionError,
    );
  });

  it("rejects --topic finance (no native Firecrawl source)", () => {
    const { adapter } = makeAdapter(async () => makeResponse());
    assert.throws(
      () => adapter.search.validate({ query: "x", controls: { topic: "finance" } }),
      ValidationError,
    );
  });

  it("maps data[].title/url/description -> title/url/summary", async () => {
    const { adapter } = makeAdapter(async () =>
      makeResponse({
        json: {
          success: true,
          data: [
            { title: "T1", url: "https://a.example", description: "desc-one" },
            { title: "T2", url: "https://b.example", description: "desc-two" },
          ],
        },
      }),
    );
    const out = await adapter.search.invoke({ query: "q" });
    assert.deepEqual(
      out.map((s) => ({ title: s.title, url: s.url, summary: s.summary })),
      [
        { title: "T1", url: "https://a.example", summary: "desc-one" },
        { title: "T2", url: "https://b.example", summary: "desc-two" },
      ],
    );
  });

  it("reads results nested under data.web (live shape)", async () => {
    const { adapter } = makeAdapter(async () =>
      makeResponse({
        json: {
          success: true,
          data: { web: [{ title: "T", url: "https://w.example", description: "d" }] },
        },
      }),
    );
    const out = await adapter.search.invoke({ query: "q" });
    assert.equal(out.length, 1);
    assert.equal(out[0].url, "https://w.example");
  });

  it("falls back to data.news when data.web is empty", async () => {
    const { adapter } = makeAdapter(async () =>
      makeResponse({
        json: {
          success: true,
          data: { web: [], news: [{ title: "N", url: "https://n.example", description: "d" }] },
        },
      }),
    );
    const out = await adapter.search.invoke({ query: "q", controls: { topic: "news" } });
    assert.equal(out.length, 1);
    assert.equal(out[0].url, "https://n.example");
  });

  it("prefers scraped markdown over description when content-size is high", async () => {
    const { adapter, calls } = makeAdapter(async () =>
      makeResponse({
        json: {
          success: true,
          data: [
            { title: "T", url: "https://a.example", description: "short", markdown: "# Full" },
          ],
        },
      }),
    );
    const out = await adapter.search.invoke({ query: "q", controls: { contentSize: "high" } });
    assert.equal(out[0].summary, "# Full");
    // high content-size must request scrapeOptions.formats=[markdown].
    assert.deepEqual(lastBody(calls).scrapeOptions, { formats: ["markdown"] });
  });

  it("maps topic -> sources and recency -> tbs and domain -> includeDomains", async () => {
    const { adapter, calls } = makeAdapter(async () =>
      makeResponse({ json: { success: true, data: [] } }),
    );
    await adapter.search.invoke({
      query: "q",
      controls: { topic: "news", recency: "oneWeek", domain: "example.com" },
    });
    const body = lastBody(calls);
    assert.deepEqual(body.sources, [{ type: "news" }]);
    assert.equal(body.tbs, "qdr:w");
    assert.deepEqual(body.includeDomains, ["example.com"]);
  });

  it("defaults sources to [{type:web}] for a general topic", async () => {
    const { adapter, calls } = makeAdapter(async () =>
      makeResponse({ json: { success: true, data: [] } }),
    );
    await adapter.search.invoke({ query: "q", controls: { topic: "general" } });
    assert.deepEqual(lastBody(calls).sources, [{ type: "web" }]);
  });

  it("normalizes a 401 into AuthError", async () => {
    const { adapter } = makeAdapter(async () =>
      makeResponse({ ok: false, status: 401, body: '{"error":"bad key"}' }),
    );
    await assert.rejects(() => adapter.search.invoke({ query: "q" }), AuthError);
  });
});

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

describe("Firecrawl Reader Adapter", () => {
  it("maps data.markdown + metadata.sourceURL/title -> content/finalUrl/title", async () => {
    const { adapter } = makeAdapter(async () =>
      makeResponse({
        json: {
          success: true,
          data: {
            markdown: "# Page",
            metadata: { sourceURL: "https://final.example", title: "The Title" },
          },
        },
      }),
    );
    const out = await adapter.reader.fetch.invoke({ url: "https://req.example" });
    assert.equal(out.content, "# Page");
    assert.equal(out.contentFormat, "markdown");
    assert.equal(out.finalUrl, "https://final.example");
    assert.equal(out.title, "The Title");
    assert.equal(out.url, "https://req.example");
    assert.equal(out.schemaVersion, 1);
  });

  it("uses data.text and contentFormat text when --format text", async () => {
    const { adapter } = makeAdapter(async () =>
      makeResponse({
        json: {
          success: true,
          data: { text: "plain text body", metadata: { sourceURL: "https://f.example" } },
        },
      }),
    );
    const out = await adapter.reader.fetch.invoke({ url: "https://r.example", format: "text" });
    assert.equal(out.content, "plain text body");
    assert.equal(out.contentFormat, "text");
  });

  it("coerces a blank metadata.title to null and falls back to request url", async () => {
    const { adapter } = makeAdapter(async () =>
      makeResponse({
        json: { success: true, data: { markdown: "x", metadata: { title: "   " } } },
      }),
    );
    const out = await adapter.reader.fetch.invoke({ url: "https://req.example" });
    assert.equal(out.title, null);
    assert.equal(out.finalUrl, "https://req.example");
  });

  it("sends removeBase64Images when --no-images (retainImages=false)", async () => {
    const { adapter, calls } = makeAdapter(async () =>
      makeResponse({ json: { success: true, data: { markdown: "x" } } }),
    );
    await adapter.reader.fetch.invoke({ url: "https://r.example", retainImages: false });
    assert.equal(lastBody(calls).removeBase64Images, true);
  });

  it("pins proxy:basic on scrape (cost-safety, D9)", async () => {
    const { adapter, calls } = makeAdapter(async () =>
      makeResponse({ json: { success: true, data: { markdown: "x" } } }),
    );
    await adapter.reader.fetch.invoke({ url: "https://r.example" });
    assert.equal(lastBody(calls).proxy, "basic");
  });

  it("rejects Z.AI-only reader options", () => {
    const { adapter } = makeAdapter(async () => makeResponse());
    assert.throws(
      () => adapter.reader.fetch.validate({ url: "https://r.example", withLinksSummary: true }),
      UnsupportedOptionError,
    );
  });

  it("rejects a non-http url", () => {
    const { adapter } = makeAdapter(async () => makeResponse());
    assert.throws(() => adapter.reader.fetch.validate({ url: "ftp://x" }), ValidationError);
  });
});

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------

describe("Firecrawl Map Adapter", () => {
  it("maps links[] -> urls and records baseUrl", async () => {
    const { adapter } = makeAdapter(async () =>
      makeResponse({
        json: {
          success: true,
          links: [{ url: "https://a.example/1", title: "A" }, { url: "https://a.example/2" }],
        },
      }),
    );
    const out = await adapter.map.fetch.invoke({ url: "https://a.example" });
    assert.deepEqual(out.urls, ["https://a.example/1", "https://a.example/2"]);
    assert.equal(out.totalUrls, 2);
    assert.equal(out.baseUrl, "https://a.example");
    assert.equal(out.schemaVersion, 1);
  });

  it("maps --limit and --instructions -> limit and search", async () => {
    const { adapter, calls } = makeAdapter(async () =>
      makeResponse({ json: { success: true, links: [] } }),
    );
    await adapter.map.fetch.invoke({ url: "https://a.example", limit: 10, instructions: "docs" });
    const body = lastBody(calls);
    assert.equal(body.limit, 10);
    assert.equal(body.search, "docs");
  });

  it("rejects unsupported map controls (depth/breadth/selectPaths/excludePaths)", () => {
    const { adapter } = makeAdapter(async () => makeResponse());
    assert.throws(
      () => adapter.map.fetch.validate({ url: "https://x.example", depth: 2 }),
      UnsupportedOptionError,
    );
    assert.throws(
      () => adapter.map.fetch.validate({ url: "https://x.example", breadth: 5 }),
      UnsupportedOptionError,
    );
    assert.throws(
      () => adapter.map.fetch.validate({ url: "https://x.example", selectPaths: "/a/*" }),
      UnsupportedOptionError,
    );
    assert.throws(
      () => adapter.map.fetch.validate({ url: "https://x.example", excludePaths: "/b/*" }),
      UnsupportedOptionError,
    );
  });
});

// ---------------------------------------------------------------------------
// Error-envelope dual-check (Firecrawl-specific)
// ---------------------------------------------------------------------------

describe("Firecrawl error-envelope dual-check", () => {
  it("treats HTTP 200 with {success:false} as a business error (ApiError 422)", async () => {
    const { adapter } = makeAdapter(async () =>
      makeResponse({ ok: true, status: 200, json: { success: false, error: "nope" } }),
    );
    await assert.rejects(
      () => adapter.search.invoke({ query: "q" }),
      (err) => err instanceof ApiError && err.statusCode === 422,
    );
  });
});

// ---------------------------------------------------------------------------
// Crawl — async create→poll→resume + reclaim-on-miss (FC-04 / D2)
// ---------------------------------------------------------------------------

const CRED_HASH = crypto.createHash("sha256").update(TEST_API_KEY).digest("hex");

/**
 * Build a crawl adapter with a routing fake fetch. `handlers`:
 *   onActive()  -> active-job array for GET /v2/crawl/active (default [])
 *   onCreate()  -> create body for POST /v2/crawl (default {success,id:"job-create"})
 *   onPoll(n)   -> poll body for the n-th GET /v2/crawl/{id} (default completed)
 * The poll-interval is zeroed so the loop never waits.
 */
function makeCrawlAdapter(handlers, stateFile) {
  const calls = [];
  let pollN = 0;
  const fn = async (url, init) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    calls.push({ url: u, method, init });
    if (method === "POST" && u.endsWith("/v2/crawl")) {
      return makeResponse({ json: handlers.onCreate?.() ?? { success: true, id: "job-create" } });
    }
    if (method === "GET" && u.endsWith("/v2/crawl/active")) {
      return makeResponse({ json: { success: true, data: handlers.onActive?.() ?? [] } });
    }
    if (method === "GET" && u.includes("/v2/crawl/")) {
      pollN += 1;
      return makeResponse({
        json: handlers.onPoll?.(pollN) ?? { success: true, status: "completed", data: [] },
      });
    }
    return makeResponse({ json: { success: true } });
  };
  const descriptor = createFirecrawlDescriptor({
    transport: {
      fetch: fn,
      env: { FIRECRAWL_TIMEOUT: "5000", FIRECRAWL_CRAWL_POLL_INTERVAL_MS: "0" },
    },
    crawlStateFile: stateFile ?? createInMemoryAsyncJobStateFile(),
  });
  const adapter = descriptor.create({
    env: { FIRECRAWL_API_KEY: TEST_API_KEY, FIRECRAWL_CRAWL_POLL_INTERVAL_MS: "0" },
  });
  return { adapter, calls };
}

describe("Firecrawl Crawl Adapter", () => {
  it("rejects --breadth with UnsupportedOptionError", () => {
    const { adapter } = makeCrawlAdapter({}, createInMemoryAsyncJobStateFile());
    assert.throws(
      () => adapter.crawl.fetch.validate({ url: "https://x.example", breadth: 5 }),
      UnsupportedOptionError,
    );
  });

  it("creates, polls scraping→completed, and maps pages", async () => {
    const { adapter, calls } = makeCrawlAdapter({
      onPoll: (n) =>
        n === 1
          ? { success: true, status: "scraping" }
          : {
              success: true,
              status: "completed",
              data: [
                { markdown: "# A", metadata: { sourceURL: "https://a.example" } },
                { markdown: "# B", metadata: { sourceURL: "https://b.example" } },
              ],
            },
    });
    const out = await adapter.crawl.fetch.invoke({ url: "https://start.example" });
    assert.equal(out.schemaVersion, 1);
    assert.equal(out.baseUrl, "https://start.example");
    assert.equal(out.totalPages, 2);
    assert.deepEqual(
      out.pages.map((p) => ({ url: p.url, content: p.content })),
      [
        { url: "https://a.example", content: "# A" },
        { url: "https://b.example", content: "# B" },
      ],
    );
    // A create POST happened, and the request pinned proxy:basic.
    const createCall = calls.find((c) => c.method === "POST" && c.url.endsWith("/v2/crawl"));
    assert.ok(createCall);
  });

  it("pins proxy:basic on the create body (D9 cost-safety)", async () => {
    const { adapter, calls } = makeCrawlAdapter({});
    await adapter.crawl.fetch.invoke({ url: "https://p.example" });
    const createBody = JSON.parse(
      calls.find((c) => c.method === "POST" && c.url.endsWith("/v2/crawl")).init.body,
    );
    // proxy nests under scrapeOptions on crawl (top-level proxy is rejected).
    assert.equal(createBody.scrapeOptions.proxy, "basic");
    assert.deepEqual(createBody.scrapeOptions.formats, ["markdown"]);
    assert.equal(createBody.proxy, undefined);
  });

  it("resumes an in-flight job from the state file (NO create POST)", async () => {
    const stateFile = createInMemoryAsyncJobStateFile();
    const identityHash = computeAsyncJobStateHash({
      provider: "firecrawl",
      capability: "crawl",
      credentialFingerprint: CRED_HASH,
      request: { url: "https://r.example" },
    });
    await stateFile.write(identityHash, {
      requestId: "job-resume",
      identityHash,
      createdAt: new Date().toISOString(),
      status: "pending",
    });
    const { adapter, calls } = makeCrawlAdapter(
      {
        onPoll: () => ({
          success: true,
          status: "completed",
          data: [{ markdown: "# r", metadata: { sourceURL: "https://r.example" } }],
        }),
      },
      stateFile,
    );
    const out = await adapter.crawl.fetch.invoke({ url: "https://r.example" });
    assert.equal(out.totalPages, 1);
    // No create POST and no /active lookup — went straight to polling the id.
    assert.ok(!calls.some((c) => c.method === "POST"));
    assert.ok(!calls.some((c) => c.url.endsWith("/v2/crawl/active")));
    assert.ok(calls.some((c) => c.url.includes("/v2/crawl/job-resume")));
  });

  it("reclaims an in-flight job from /active on a state miss (NO create POST)", async () => {
    const { adapter, calls } = makeCrawlAdapter({
      onActive: () => [
        {
          id: "job-active",
          url: "https://rec.example",
          created_at: new Date().toISOString(),
          options: { maxDepth: 2, scrapeOptions: { formats: ["markdown"] }, proxy: "basic" },
        },
      ],
      onPoll: () => ({
        success: true,
        status: "completed",
        data: [{ markdown: "# x", metadata: { sourceURL: "https://rec.example" } }],
      }),
    });
    const out = await adapter.crawl.fetch.invoke({ url: "https://rec.example", depth: 2 });
    assert.equal(out.totalPages, 1);
    // Reclaimed — no create POST, polled the adopted id.
    assert.ok(!calls.some((c) => c.method === "POST" && c.url.endsWith("/v2/crawl")));
    assert.ok(calls.some((c) => c.url.includes("/v2/crawl/job-active")));
  });

  it("creates fresh when /active has no matching job", async () => {
    const { adapter, calls } = makeCrawlAdapter({
      onActive: () => [],
      onPoll: () => ({ success: true, status: "completed", data: [] }),
    });
    const out = await adapter.crawl.fetch.invoke({ url: "https://n.example" });
    assert.equal(out.totalPages, 0);
    assert.ok(calls.some((c) => c.method === "POST" && c.url.endsWith("/v2/crawl")));
  });

  it("removes state and throws ApiError on a failed job", async () => {
    const stateFile = createInMemoryAsyncJobStateFile();
    const { adapter } = makeCrawlAdapter(
      { onPoll: () => ({ success: true, status: "failed" }) },
      stateFile,
    );
    await assert.rejects(() => adapter.crawl.fetch.invoke({ url: "https://f.example" }), ApiError);
  });

  it("normalizes a 401 into AuthError", async () => {
    const fn = async () => makeResponse({ ok: false, status: 401, body: '{"error":"bad"}' });
    const descriptor = createFirecrawlDescriptor({
      transport: { fetch: fn, env: { FIRECRAWL_TIMEOUT: "5000" } },
      crawlStateFile: createInMemoryAsyncJobStateFile(),
    });
    const adapter = descriptor.create({ env: { FIRECRAWL_API_KEY: TEST_API_KEY } });
    await assert.rejects(() => adapter.crawl.fetch.invoke({ url: "https://a.example" }), AuthError);
  });

  it("drops state and creates a fresh job on a 404 (not_found)", async () => {
    let pollN = 0;
    const calls = [];
    const fn = async (url, init) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      calls.push({ url: u, method });
      if (method === "POST" && u.endsWith("/v2/crawl")) {
        return makeResponse({
          json: { success: true, id: `job-${calls.filter((c) => c.method === "POST").length}` },
        });
      }
      if (method === "GET" && u.endsWith("/v2/crawl/active")) {
        return makeResponse({ json: { success: true, data: [] } });
      }
      pollN += 1;
      // First poll: the job vanished (404 → not_found). Second: fresh job completed.
      if (pollN === 1) return makeResponse({ ok: false, status: 404, body: "{}" });
      return makeResponse({
        json: {
          success: true,
          status: "completed",
          data: [{ markdown: "# ok", metadata: { sourceURL: "https://ok.example" } }],
        },
      });
    };
    const descriptor = createFirecrawlDescriptor({
      transport: {
        fetch: fn,
        env: { FIRECRAWL_TIMEOUT: "5000", FIRECRAWL_CRAWL_POLL_INTERVAL_MS: "0" },
      },
      crawlStateFile: createInMemoryAsyncJobStateFile(),
    });
    const adapter = descriptor.create({ env: { FIRECRAWL_API_KEY: TEST_API_KEY } });
    const out = await adapter.crawl.fetch.invoke({ url: "https://n404.example" });
    assert.equal(out.totalPages, 1);
    // Two create POSTs: one before the 404, one after (fresh job created).
    const posts = calls.filter((c) => c.method === "POST" && c.url.endsWith("/v2/crawl"));
    assert.equal(posts.length, 2);
  });

  it("collects all pages following the next cursor (pagination)", async () => {
    const fn = async (url, init) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      if (method === "POST" && u.endsWith("/v2/crawl")) {
        return makeResponse({ json: { success: true, id: "job-page" } });
      }
      if (method === "GET" && u.endsWith("/v2/crawl/active")) {
        return makeResponse({ json: { success: true, data: [] } });
      }
      // Completed poll (no query): batch 1 + a next cursor.
      if (method === "GET" && u.includes("/v2/crawl/") && !u.includes("?")) {
        return makeResponse({
          json: {
            success: true,
            status: "completed",
            data: [{ markdown: "# p1", metadata: { sourceURL: "https://p1.example" } }],
            next: "https://api.firecrawl.dev/v2/crawl/job-page?after=1",
          },
        });
      }
      // next-cursor GET (has a query): batch 2, no further next.
      return makeResponse({
        json: {
          success: true,
          data: [{ markdown: "# p2", metadata: { sourceURL: "https://p2.example" } }],
        },
      });
    };
    const descriptor = createFirecrawlDescriptor({
      transport: { fetch: fn, env: { FIRECRAWL_TIMEOUT: "5000" } },
      crawlStateFile: createInMemoryAsyncJobStateFile(),
    });
    const adapter = descriptor.create({ env: { FIRECRAWL_API_KEY: TEST_API_KEY } });
    const out = await adapter.crawl.fetch.invoke({ url: "https://pg.example" });
    assert.equal(out.totalPages, 2);
    assert.deepEqual(
      out.pages.map((p) => p.url),
      ["https://p1.example", "https://p2.example"],
    );
  });

  it("keeps the state file when result collection throws (no double-charge on re-run)", async () => {
    const stateFile = createInMemoryAsyncJobStateFile();
    const fn = async (url, init) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      if (method === "POST" && u.endsWith("/v2/crawl")) {
        return makeResponse({ json: { success: true, id: "job-collect" } });
      }
      if (method === "GET" && u.endsWith("/v2/crawl/active")) {
        return makeResponse({ json: { success: true, crawls: [] } });
      }
      // Completed but with a malformed page (no metadata.sourceURL) → collect throws.
      return makeResponse({
        json: { success: true, status: "completed", data: [{ markdown: "x" }] },
      });
    };
    const descriptor = createFirecrawlDescriptor({
      transport: { fetch: fn, env: { FIRECRAWL_TIMEOUT: "5000" } },
      crawlStateFile: stateFile,
    });
    const adapter = descriptor.create({ env: { FIRECRAWL_API_KEY: TEST_API_KEY } });
    await assert.rejects(() => adapter.crawl.fetch.invoke({ url: "https://c.example" }), ApiError);
    // State file MUST persist so a re-run resumes instead of re-POSTing.
    assert.equal(stateFile.store.size, 1, "state file preserved after collect failure");
  });

  it("throws when a recreated job also vanishes (bounds the recreate loop)", async () => {
    const fn = async (url, init) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      if (method === "POST" && u.endsWith("/v2/crawl")) {
        return makeResponse({ json: { success: true, id: "job-r" } });
      }
      if (method === "GET" && u.endsWith("/v2/crawl/active")) {
        return makeResponse({ json: { success: true, crawls: [] } });
      }
      return makeResponse({ ok: false, status: 404, body: "{}" }); // always 404
    };
    const descriptor = createFirecrawlDescriptor({
      transport: {
        fetch: fn,
        env: { FIRECRAWL_TIMEOUT: "5000", FIRECRAWL_CRAWL_POLL_INTERVAL_MS: "0" },
      },
      crawlStateFile: createInMemoryAsyncJobStateFile(),
    });
    const adapter = descriptor.create({ env: { FIRECRAWL_API_KEY: TEST_API_KEY } });
    await assert.rejects(() => adapter.crawl.fetch.invoke({ url: "https://v.example" }), ApiError);
  });

  it("does not adopt an active job with mismatched path filters", async () => {
    const { adapter, calls } = makeCrawlAdapter({
      onActive: () => [
        {
          id: "job-other",
          url: "https://m.example",
          created_at: new Date().toISOString(),
          options: { includePaths: ["/other/*"] },
        },
      ],
      onPoll: () => ({ success: true, status: "completed", data: [] }),
    });
    await adapter.crawl.fetch.invoke({ url: "https://m.example", selectPaths: "/api/*" });
    // Mismatched filter → not adopted → a fresh create POST happened.
    assert.ok(calls.some((c) => c.method === "POST" && c.url.endsWith("/v2/crawl")));
  });

  it("reads active jobs from the live `crawls` key", async () => {
    const fn = async (url, init) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      if (method === "GET" && u.endsWith("/v2/crawl/active")) {
        return makeResponse({
          json: {
            success: true,
            crawls: [
              { id: "job-c", url: "https://ac.example", created_at: new Date().toISOString() },
            ],
          },
        });
      }
      if (method === "GET" && u.includes("/v2/crawl/")) {
        return makeResponse({ json: { success: true, status: "completed", data: [] } });
      }
      return makeResponse({ json: { success: true } });
    };
    const descriptor = createFirecrawlDescriptor({
      transport: { fetch: fn, env: { FIRECRAWL_TIMEOUT: "5000" } },
      crawlStateFile: createInMemoryAsyncJobStateFile(),
    });
    const adapter = descriptor.create({ env: { FIRECRAWL_API_KEY: TEST_API_KEY } });
    const out = await adapter.crawl.fetch.invoke({ url: "https://ac.example" });
    assert.equal(out.totalPages, 0); // reclaimed job-c, polled completed
  });

  it("serializes concurrent identical crawls via the create-lock (no double-POST)", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "fc-lock-"));
    const activeJobs = [];
    let postCount = 0;
    const fn = async (url, init) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      if (method === "POST" && u.endsWith("/v2/crawl")) {
        postCount += 1;
        const id = `job-${postCount}`;
        activeJobs.push({ id, url: "https://lock.example", created_at: new Date().toISOString() });
        // Hold the create critical section briefly so the second invoke contends.
        await new Promise((r) => setTimeout(r, 50));
        return makeResponse({ json: { success: true, id } });
      }
      if (method === "GET" && u.endsWith("/v2/crawl/active")) {
        return makeResponse({ json: { success: true, crawls: activeJobs } });
      }
      return makeResponse({ json: { success: true, status: "completed", data: [] } });
    };
    const descriptor = createFirecrawlDescriptor({
      transport: {
        fetch: fn,
        env: { FIRECRAWL_TIMEOUT: "5000", FIRECRAWL_CRAWL_POLL_INTERVAL_MS: "0" },
      },
      crawlStateFile: createInMemoryAsyncJobStateFile(),
      crawlStateDir: tmpDir,
    });
    const adapter = descriptor.create({
      env: { FIRECRAWL_API_KEY: TEST_API_KEY, FIRECRAWL_CRAWL_POLL_INTERVAL_MS: "0" },
    });
    await Promise.all([
      adapter.crawl.fetch.invoke({ url: "https://lock.example" }),
      adapter.crawl.fetch.invoke({ url: "https://lock.example" }),
    ]);
    // The lock serialized the create: only ONE POST (the second reclaimed the first's job).
    assert.equal(postCount, 1, "concurrent identical crawls must not both POST");
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });
});

// ---------------------------------------------------------------------------
// Quota (FC-05 / D8 — unit:"credits")
// ---------------------------------------------------------------------------

describe("Firecrawl Quota Adapter", () => {
  it("maps remainingCredits/planCredits into a Credits category (unit:credits)", async () => {
    const fn = async () =>
      makeResponse({
        json: {
          success: true,
          data: [
            {
              remainingCredits: 75,
              planCredits: 100,
              billingPeriodStart: "2026-07-11T22:57:29.086Z",
              billingPeriodEnd: "2026-08-11T22:57:29.086Z",
            },
          ],
        },
      });
    const descriptor = createFirecrawlDescriptor({ transport: { fetch: fn, env: {} } });
    const adapter = descriptor.create({ env: { FIRECRAWL_API_KEY: TEST_API_KEY } });
    const out = await adapter.quota.invoke();
    assert.equal(out.provider, "firecrawl");
    assert.equal(out.status, "ok");
    assert.equal(out.categories.length, 1);
    const cat = out.categories[0];
    assert.equal(cat.name, "Credits");
    assert.equal(cat.unit, "credits");
    // used = planCredits(100) - remainingCredits(75) = 25.
    assert.equal(cat.current.used, 25);
    assert.equal(cat.current.limit, 100);
    assert.equal(cat.current.remaining, 75);
    assert.equal(cat.current.remainingPercent, 75);
    assert.equal(cat.current.resetsAt, "2026-08-11T22:57:29.086Z");
  });

  it("clamps used to 0 and caps at 100% when banked credits exceed the plan", async () => {
    // Matches the live shape: remainingCredits (11003) > planCredits (1000).
    const fn = async () =>
      makeResponse({
        json: { success: true, data: [{ remainingCredits: 11003, planCredits: 1000 }] },
      });
    const descriptor = createFirecrawlDescriptor({ transport: { fetch: fn, env: {} } });
    const adapter = descriptor.create({ env: { FIRECRAWL_API_KEY: TEST_API_KEY } });
    const cat = (await adapter.quota.invoke()).categories[0];
    assert.equal(cat.current.used, 0);
    assert.equal(cat.current.limit, 1000);
    assert.equal(cat.current.remainingPercent, 100);
  });

  it("throws ApiError when no credit figures can be extracted", async () => {
    const fn = async () => makeResponse({ json: { success: true, data: [{}] } });
    const descriptor = createFirecrawlDescriptor({ transport: { fetch: fn, env: {} } });
    const adapter = descriptor.create({ env: { FIRECRAWL_API_KEY: TEST_API_KEY } });
    await assert.rejects(() => adapter.quota.invoke(), ApiError);
  });
});

// ---------------------------------------------------------------------------
// Diagnostics probe (FC-05 — single-scrape, probe-gated)
// ---------------------------------------------------------------------------

describe("Firecrawl Diagnostics Adapter", () => {
  it("is a no-op when probe is false", async () => {
    const fn = async () => {
      throw new Error("should not fetch when probe is false");
    };
    const descriptor = createFirecrawlDescriptor({ transport: { fetch: fn, env: {} } });
    const adapter = descriptor.create({ env: { FIRECRAWL_API_KEY: TEST_API_KEY } });
    // Resolves without touching the network.
    await adapter.diagnostics.invoke({ probe: false });
  });

  it("performs one scrape when probe is true", async () => {
    let scraped = false;
    const fn = async (url, init) => {
      if (String(url).endsWith("/v2/scrape")) scraped = true;
      return makeResponse({ json: { success: true, data: { markdown: "ok" } } });
    };
    const descriptor = createFirecrawlDescriptor({ transport: { fetch: fn, env: {} } });
    const adapter = descriptor.create({ env: { FIRECRAWL_API_KEY: TEST_API_KEY } });
    await adapter.diagnostics.invoke({ probe: true });
    assert.equal(scraped, true);
  });
});
