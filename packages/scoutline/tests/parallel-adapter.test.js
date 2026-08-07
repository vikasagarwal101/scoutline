/**
 * Parallel AI Provider unit tests.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createParallelDescriptor, ParallelAdapter } from "../dist/providers/parallel/adapter.js";
import {
  resolveParallelApiKey,
  requireParallelApiKey,
  isParallelConfigured,
} from "../dist/providers/parallel/credentials.js";
import { ApiError, AuthError, ConfigurationError, UnsupportedOptionError, ValidationError } from "../dist/lib/errors.js";

const TEST_KEY = "parallel-test-api-key";

function mockFetch(responseBody, status = 200) {
  return async (url, init) => {
    assert.ok(url.includes("/v1/search"));
    const body = JSON.parse(init.body);
    // Verify the request uses search_queries (array), not query (string)
    assert.ok(Array.isArray(body.search_queries), "request body must use search_queries array");
    assert.ok(!("query" in body), "request body must not use query field");
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(responseBody),
    };
  };
}

describe("Parallel AI Credentials", () => {
  it("resolves valid API key from environment", () => {
    assert.equal(resolveParallelApiKey({ PARALLEL_API_KEY: "  key123  " }), "  key123  ");
    assert.equal(resolveParallelApiKey({}), undefined);
    assert.equal(resolveParallelApiKey({ PARALLEL_API_KEY: "   " }), undefined);
  });

  it("requireParallelApiKey throws ConfigurationError when missing", () => {
    assert.throws(() => requireParallelApiKey({}), ConfigurationError);
    assert.equal(requireParallelApiKey({ PARALLEL_API_KEY: TEST_KEY }), TEST_KEY);
  });

  it("checks if parallel is configured", () => {
    assert.equal(isParallelConfigured({ PARALLEL_API_KEY: TEST_KEY }), true);
    assert.equal(isParallelConfigured({}), false);
  });
});

describe("Parallel AI Descriptor & Adapter", () => {
  it("creates descriptor with correct metadata", () => {
    const desc = createParallelDescriptor();
    assert.equal(desc.id, "parallel");
    assert.deepEqual(Array.from(desc.capabilities()), ["search", "research", "reader", "diagnostics"]);
  });

  it("invokes search with mock transport using real API shape", async () => {
    const fakeFetch = mockFetch({
      search_id: "search_test123",
      results: [
        {
          title: "Async Rust Guide",
          url: "https://example.com/rust",
          excerpts: ["Learn async in Rust", "Tokio runtime basics"],
          publish_date: "2024-01-15",
        },
      ],
      usage: [{ name: "sku_search", count: 1 }],
      session_id: "session_test123",
    });

    const adapter = new ParallelAdapter(
      { env: { PARALLEL_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );

    adapter.search.validate({ query: "rust async" });
    const results = await adapter.search.invoke({ query: "rust async" });
    assert.equal(results.length, 1);
    assert.equal(results[0].title, "Async Rust Guide");
    assert.equal(results[0].url, "https://example.com/rust");
    // Excerpts should be joined with double newlines
    assert.equal(results[0].summary, "Learn async in Rust\n\nTokio runtime basics");
    assert.equal(results[0].date, "2024-01-15");
    assert.equal(results[0].source, "Parallel AI");
  });

  it("handles results with null publish_date", async () => {
    const fakeFetch = mockFetch({
      results: [
        {
          title: "No Date Article",
          url: "https://example.com/nodate",
          excerpts: ["Content here"],
          publish_date: null,
        },
      ],
    });

    const adapter = new ParallelAdapter(
      { env: { PARALLEL_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );

    const results = await adapter.search.invoke({ query: "test" });
    assert.equal(results[0].date, undefined);
  });

  it("handles empty excerpts gracefully", async () => {
    const fakeFetch = mockFetch({
      results: [
        {
          title: "No Excerpts",
          url: "https://example.com/noexcept",
        },
      ],
    });

    const adapter = new ParallelAdapter(
      { env: { PARALLEL_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );

    const results = await adapter.search.invoke({ query: "test" });
    assert.equal(results[0].summary, "");
  });

  it("invokes reader capability (Extract API)", async () => {
    const fakeFetch = async (url, init) => {
      assert.ok(url.includes("/v1/extract"));
      const body = JSON.parse(init.body);
      assert.ok(Array.isArray(body.urls), "extract body must use urls array");
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          results: [
            {
              url: "https://example.com/page",
              title: "Example Page",
              publish_date: null,
              excerpts: ["Full page content extracted by Parallel AI."],
              full_content: "",
            },
          ],
          errors: [],
        }),
      };
    };

    const adapter = new ParallelAdapter(
      { env: { PARALLEL_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );

    adapter.reader.fetch.validate({ url: "https://example.com/page" });
    const res = await adapter.reader.fetch.invoke({ url: "https://example.com/page" });
    assert.equal(res.title, "Example Page");
    assert.equal(res.content, "Full page content extracted by Parallel AI.");
    assert.equal(res.finalUrl, "https://example.com/page");
    assert.equal(res.contentFormat, "markdown");
  });

  it("reader surfaces extraction errors from errors[]", async () => {
    const fakeFetch = async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        results: [],
        errors: [{ url: "https://broken.page", error_type: "fetch_failed", http_status_code: 404 }],
      }),
    });

    const adapter = new ParallelAdapter(
      { env: { PARALLEL_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );

    await assert.rejects(
      () => adapter.reader.fetch.invoke({ url: "https://broken.page" }),
      (err) => err instanceof ApiError,
    );
  });

  it("rejects reader URL without http(s) prefix", () => {
    const adapter = new ParallelAdapter(
      { env: { PARALLEL_API_KEY: TEST_KEY } },
      { transport: { fetch: async () => ({}) } },
    );

    assert.throws(
      () => adapter.reader.fetch.validate({ url: "ftp://example.com" }),
      ValidationError,
    );
  });

  it("invokes research capability using real API shape", async () => {
    const fakeFetch = mockFetch({
      search_id: "search_research123",
      results: [
        {
          title: "Parallel AI Docs",
          url: "https://parallel.ai/docs",
          excerpts: ["Deep research architecture overview"],
        },
        {
          title: "Research Paper",
          url: "https://example.com/paper",
          excerpts: ["Detailed findings on AI search"],
        },
      ],
    });

    const adapter = new ParallelAdapter(
      { env: { PARALLEL_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );

    adapter.research.run.validate({ query: "AI search engines" });
    const res = await adapter.research.run.invoke({ query: "AI search engines" });
    // Report is built from concatenated excerpts
    assert.equal(res.report, "Deep research architecture overview\n\nDetailed findings on AI search");
    assert.equal(res.sources.length, 2);
    assert.equal(res.sources[0].url, "https://parallel.ai/docs");
  });

  it("research falls back to placeholder when no results", async () => {
    const fakeFetch = mockFetch({ results: [] });

    const adapter = new ParallelAdapter(
      { env: { PARALLEL_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );

    const res = await adapter.research.run.invoke({ query: "empty topic" });
    assert.equal(res.report, "No research findings available.");
    assert.equal(res.sources.length, 0);
  });
});

describe("Parallel AI Error Handling", () => {
  it("maps 401 to AuthError", async () => {
    const fakeFetch = async () => ({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ message: "Invalid API key" }),
    });

    const adapter = new ParallelAdapter(
      { env: { PARALLEL_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );

    await assert.rejects(
      () => adapter.search.invoke({ query: "test" }),
      (err) => err instanceof AuthError,
    );
  });

  it("maps 429 to ApiError with status 429", async () => {
    const fakeFetch = async () => ({
      ok: false,
      status: 429,
      text: async () => JSON.stringify({ message: "Rate limited" }),
    });

    const adapter = new ParallelAdapter(
      { env: { PARALLEL_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );

    await assert.rejects(
      () => adapter.search.invoke({ query: "test" }),
      (err) => err instanceof ApiError && err.statusCode === 429,
    );
  });

  it("rejects domain control as UnsupportedOptionError", () => {
    const adapter = new ParallelAdapter(
      { env: { PARALLEL_API_KEY: TEST_KEY } },
      { transport: { fetch: async () => ({}) } },
    );

    assert.throws(
      () => adapter.search.validate({ query: "test", controls: { domain: "example.com" } }),
      UnsupportedOptionError,
    );
  });

  it("rejects recency control as UnsupportedOptionError", () => {
    const adapter = new ParallelAdapter(
      { env: { PARALLEL_API_KEY: TEST_KEY } },
      { transport: { fetch: async () => ({}) } },
    );

    assert.throws(
      () => adapter.search.validate({ query: "test", controls: { recency: "oneWeek" } }),
      UnsupportedOptionError,
    );
  });
});
