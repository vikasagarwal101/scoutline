/**
 * Jina AI Provider unit tests.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createJinaDescriptor, JinaAdapter } from "../dist/providers/jina/adapter.js";
import {
  resolveJinaApiKey,
  isJinaConfigured,
} from "../dist/providers/jina/credentials.js";
import { ApiError, AuthError, UnsupportedOptionError, ValidationError } from "../dist/lib/errors.js";

const TEST_KEY = "jina-test-api-key";

function mockFetch(responseBody, status = 200) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(responseBody),
  });
}

describe("Jina AI Credentials", () => {
  it("resolves valid API key from environment", () => {
    assert.equal(resolveJinaApiKey({ JINA_API_KEY: "  key789  " }), "  key789  ");
    assert.equal(resolveJinaApiKey({}), undefined);
    assert.equal(resolveJinaApiKey({ JINA_API_KEY: "   " }), undefined);
  });

  it("checks if jina is configured (always true — keyless supported)", () => {
    assert.equal(isJinaConfigured({ JINA_API_KEY: TEST_KEY }), true);
    assert.equal(isJinaConfigured({}), true);
  });
});

describe("Jina AI Descriptor & Adapter", () => {
  it("creates descriptor with correct metadata", () => {
    const desc = createJinaDescriptor();
    assert.equal(desc.id, "jina");
    assert.deepEqual(Array.from(desc.capabilities()), ["search", "reader", "research", "diagnostics"]);
  });

  it("invokes search with mock transport", async () => {
    const fakeFetch = mockFetch({
      data: [
        {
          title: "Jina Search Result",
          url: "https://jina.ai/result",
          description: "Deep neural search for AI agents.",
        },
      ],
    });

    const adapter = new JinaAdapter(
      { env: { JINA_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );

    adapter.search.validate({ query: "jina reader API" });
    const results = await adapter.search.invoke({ query: "jina reader API" });
    assert.equal(results.length, 1);
    assert.equal(results[0].title, "Jina Search Result");
    assert.equal(results[0].url, "https://jina.ai/result");
  });

  it("works keyless (no JINA_API_KEY set)", async () => {
    const fakeFetch = mockFetch({
      data: [
        {
          title: "Keyless Result",
          url: "https://example.com/free",
          description: "Works without API key.",
        },
      ],
    });

    const adapter = new JinaAdapter(
      { env: {} },
      { transport: { fetch: fakeFetch } },
    );

    const results = await adapter.search.invoke({ query: "test" });
    assert.equal(results.length, 1);
    assert.equal(results[0].title, "Keyless Result");
  });

  it("invokes reader capability", async () => {
    const fakeFetch = mockFetch({
      data: {
        title: "Scoutline Docs",
        url: "https://example.com/docs",
        content: "# Markdown Content from Jina Reader",
      },
    });

    const adapter = new JinaAdapter(
      { env: { JINA_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );

    adapter.reader.fetch.validate({ url: "https://example.com/docs" });
    const res = await adapter.reader.fetch.invoke({ url: "https://example.com/docs" });
    assert.equal(res.title, "Scoutline Docs");
    assert.equal(res.content, "# Markdown Content from Jina Reader");
  });

  it("invokes research capability (DeepSearch API)", async () => {
    const fakeFetch = async (url) => {
      assert.ok(url.includes("deepsearch.jina.ai"), "must hit deepsearch endpoint");
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: "Rust async programming uses futures and the async/await syntax.",
                annotations: [
                  { url_citation: { title: "Rust Book", url: "https://doc.rust-lang.org/book", exactQuote: "async/await" } },
                  { url_citation: { title: "Tokio Tutorial", url: "https://tokio.rs/tutorial", exactQuote: "runtime" } },
                ],
              },
            },
          ],
          visitedURLs: ["https://doc.rust-lang.org/book", "https://tokio.rs/tutorial"],
        }),
      };
    };

    const adapter = new JinaAdapter(
      { env: { JINA_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );

    adapter.research.run.validate({ query: "rust async" });
    const res = await adapter.research.run.invoke({ query: "rust async" });
    assert.equal(res.report, "Rust async programming uses futures and the async/await syntax.");
    assert.equal(res.model, "jina-deepsearch-v1");
    assert.equal(res.sources.length, 2);
    assert.equal(res.sources[0].title, "Rust Book");
    assert.equal(res.sources[0].url, "https://doc.rust-lang.org/book");
  });

  it("research falls back to visitedURLs when no annotations", async () => {
    const fakeFetch = async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { content: "Research answer." } }],
        visitedURLs: ["https://source1.com", "https://source2.com"],
      }),
    });

    const adapter = new JinaAdapter(
      { env: { JINA_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );

    const res = await adapter.research.run.invoke({ query: "test" });
    assert.equal(res.sources.length, 2);
    assert.equal(res.sources[0].url, "https://source1.com");
  });
});

describe("Jina AI Error Handling", () => {
  it("maps 401 to AuthError", async () => {
    const fakeFetch = mockFetch({ message: "Unauthorized" }, 401);

    const adapter = new JinaAdapter(
      { env: { JINA_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );

    await assert.rejects(
      () => adapter.search.invoke({ query: "test" }),
      (err) => err instanceof AuthError,
    );
  });

  it("maps 429 to ApiError with status 429", async () => {
    const fakeFetch = mockFetch({ message: "Rate limited" }, 429);

    const adapter = new JinaAdapter(
      { env: { JINA_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );

    await assert.rejects(
      () => adapter.search.invoke({ query: "test" }),
      (err) => err instanceof ApiError && err.statusCode === 429,
    );
  });

  it("rejects type control as UnsupportedOptionError", () => {
    const adapter = new JinaAdapter(
      { env: { JINA_API_KEY: TEST_KEY } },
      { transport: { fetch: async () => ({}) } },
    );

    assert.throws(
      () => adapter.search.validate({ query: "test", controls: { type: "video" } }),
      UnsupportedOptionError,
    );
  });

  it("rejects reader URL without http(s) prefix", () => {
    const adapter = new JinaAdapter(
      { env: { JINA_API_KEY: TEST_KEY } },
      { transport: { fetch: async () => ({}) } },
    );

    assert.throws(
      () => adapter.reader.fetch.validate({ url: "ftp://example.com" }),
      ValidationError,
    );
    assert.throws(
      () => adapter.reader.fetch.validate({ url: "not-a-url" }),
      ValidationError,
    );
  });

  it("rejects empty reader URL", () => {
    const adapter = new JinaAdapter(
      { env: { JINA_API_KEY: TEST_KEY } },
      { transport: { fetch: async () => ({}) } },
    );

    assert.throws(
      () => adapter.reader.fetch.validate({ url: "  " }),
      ValidationError,
    );
  });
});
