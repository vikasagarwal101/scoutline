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

import { createFirecrawlDescriptor } from "../dist/providers/firecrawl/adapter.js";
import {
  ApiError,
  AuthError,
  UnsupportedOptionError,
  ValidationError,
} from "../dist/lib/errors.js";

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
        json: { success: true, links: ["https://a.example/1", "https://a.example/2"] },
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
