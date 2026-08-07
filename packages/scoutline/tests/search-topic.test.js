/**
 * Shared search-topic helper tests.
 *
 * Verifies applySearchTopic directly and through the Parallel adapter's
 * search invoke (2.5), ensuring the shared keyword-appendage contract is
 * uniform across Providers that lack a native topic parameter.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { applySearchTopic } from "../dist/lib/search-topic.js";
import { ParallelAdapter } from "../dist/providers/parallel/adapter.js";

describe("applySearchTopic — shared keyword appendage", () => {
  it("returns the query unchanged for general or absent topic", () => {
    assert.equal(applySearchTopic("rust async", undefined), "rust async");
    assert.equal(applySearchTopic("rust async", "general"), "rust async");
  });

  it("appends ' latest news' for topic news", () => {
    assert.equal(applySearchTopic("rust", "news"), "rust latest news");
  });

  it("appends ' financial' for topic finance", () => {
    assert.equal(applySearchTopic("rust", "finance"), "rust financial");
  });

  it("does not double-append when query already ends with topic word", () => {
    assert.equal(applySearchTopic("rust news", "news"), "rust news");
  });
});

describe("Parallel adapter uses applySearchTopic (2.5)", () => {
  it("appends topic keyword to query via shared helper", async () => {
    let capturedBody;
    const fakeFetch = async (url, init) => {
      capturedBody = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ results: [] }),
      };
    };

    const adapter = new ParallelAdapter(
      { env: { PARALLEL_API_KEY: "k" } },
      { transport: { fetch: fakeFetch } },
    );

    await adapter.search.invoke({ query: "rust", controls: { topic: "news" } });
    // The shared helper appends " latest news", not the bare topic word.
    assert.deepEqual(capturedBody.search_queries, ["rust latest news"]);
  });

  it("does not append for general topic", async () => {
    let capturedBody;
    const fakeFetch = async (url, init) => {
      capturedBody = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ results: [] }),
      };
    };

    const adapter = new ParallelAdapter(
      { env: { PARALLEL_API_KEY: "k" } },
      { transport: { fetch: fakeFetch } },
    );

    await adapter.search.invoke({ query: "rust", controls: { topic: "general" } });
    assert.deepEqual(capturedBody.search_queries, ["rust"]);
  });
});
