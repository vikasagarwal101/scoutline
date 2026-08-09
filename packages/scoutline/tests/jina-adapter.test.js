/**
 * Jina AI Provider unit tests.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createJinaDescriptor, JinaAdapter } from "../dist/providers/jina/adapter.js";
import { resolveJinaApiKey, isJinaConfigured } from "../dist/providers/jina/credentials.js";
import {
  ApiError,
  AuthError,
  ConfigurationError,
  QuotaError,
  TimeoutError,
  UnsupportedOptionError,
  ValidationError,
} from "../dist/lib/errors.js";

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

  it("checks capability-aware configuration (8J.1)", () => {
    // Without capabilityId — Jina is always configured (keyless Reader available)
    assert.equal(isJinaConfigured({ JINA_API_KEY: TEST_KEY }), true);
    assert.equal(isJinaConfigured({}), true);
    // Reader is keyless — always available
    assert.equal(isJinaConfigured({ JINA_API_KEY: TEST_KEY }, "reader"), true);
    assert.equal(isJinaConfigured({}, "reader"), true);
    // Search requires a key
    assert.equal(isJinaConfigured({ JINA_API_KEY: TEST_KEY }, "search"), true);
    assert.equal(isJinaConfigured({}, "search"), false);
    // Research requires a key
    assert.equal(isJinaConfigured({ JINA_API_KEY: TEST_KEY }, "research"), true);
    assert.equal(isJinaConfigured({}, "research"), false);
    // Diagnostics requires a key (probe uses Search endpoint)
    assert.equal(isJinaConfigured({ JINA_API_KEY: TEST_KEY }, "diagnostics"), true);
    assert.equal(isJinaConfigured({}, "diagnostics"), false);
  });
});

describe("Jina AI Descriptor & Adapter", () => {
  it("creates descriptor with correct metadata", () => {
    const desc = createJinaDescriptor();
    assert.equal(desc.id, "jina");
    assert.deepEqual(Array.from(desc.capabilities()), [
      "search",
      "reader",
      "research",
      "diagnostics",
    ]);
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

    const adapter = new JinaAdapter({ env: {} }, { transport: { fetch: fakeFetch } });

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
    assert.equal(res.contentFormat, "markdown");
  });

  it("reader forwards format option as X-Return-Format header (8J.2)", async () => {
    let capturedHeaders = null;
    const fakeFetch = async (url, init) => {
      capturedHeaders = init.headers;
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            data: {
              title: "Test",
              url: "https://example.com",
              content: "# Markdown",
            },
          }),
      };
    };

    const adapter = new JinaAdapter(
      { env: { JINA_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );

    await adapter.reader.fetch.invoke({
      url: "https://example.com",
      format: "markdown",
    });
    assert.equal(capturedHeaders["X-Return-Format"], "markdown");
  });

  it("reader decodes data.text for text-mode responses (8J.2)", async () => {
    const fixture = JSON.parse(
      await import("node:fs").then((fs) =>
        fs.readFileSync(new URL("./fixtures/providers/jina/reader-text.json", import.meta.url), "utf8"),
      ),
    );

    let capturedHeaders = null;
    const fakeFetch = async (url, init) => {
      capturedHeaders = init.headers;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(fixture),
      };
    };

    const adapter = new JinaAdapter(
      { env: { JINA_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );

    const res = await adapter.reader.fetch.invoke({
      url: "https://en.wikipedia.org/wiki/Rust_(programming_language)",
      format: "text",
    });

    // Text-mode: X-Return-Format must be forwarded.
    assert.equal(capturedHeaders["X-Return-Format"], "text");
    // data.text must be decoded (not data.content, which is empty in text mode).
    assert.ok(res.content.length > 0, "text-mode content must not be empty");
    assert.ok(
      res.content.includes("Rust is a multi-paradigm programming language"),
      "content must come from data.text",
    );
    assert.equal(res.contentFormat, "text");
    assert.equal(res.title, "Rust (programming language)");
  });

  it("reader forwards retainImages and timeout options as headers (8J.2)", async () => {
    let capturedHeaders = null;
    const fakeFetch = async (url, init) => {
      capturedHeaders = init.headers;
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            data: { title: "T", url: "https://example.com", content: "C" },
          }),
      };
    };

    const adapter = new JinaAdapter(
      { env: { JINA_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );

    await adapter.reader.fetch.invoke({
      url: "https://example.com",
      retainImages: true,
      timeout: 60,
    });
    assert.equal(capturedHeaders["X-Retain-Images"], "true");
    assert.equal(capturedHeaders["X-Timeout"], "60");
  });

  it("invokes research capability (DeepSearch API)", async () => {
    const fakeFetch = async (url) => {
      assert.ok(url.includes("deepsearch.jina.ai"), "must hit deepsearch endpoint");
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: "Rust async programming uses futures and the async/await syntax.",
                  annotations: [
                    {
                      url_citation: {
                        title: "Rust Book",
                        url: "https://doc.rust-lang.org/book",
                        exactQuote: "async/await",
                      },
                    },
                    {
                      url_citation: {
                        title: "Tokio Tutorial",
                        url: "https://tokio.rs/tutorial",
                        exactQuote: "runtime",
                      },
                    },
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
      text: async () =>
        JSON.stringify({
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

describe("Jina AI Control Acceptance (8J.3/8J.4)", () => {
  it("search accepts domain and sends X-Site header (8J.3)", async () => {
    let capturedHeaders = null;
    const fakeFetch = async (url, init) => {
      capturedHeaders = init.headers;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: [] }),
      };
    };

    const adapter = new JinaAdapter(
      { env: { JINA_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );

    adapter.search.validate({ query: "test", controls: { domain: "example.com" } });
    await adapter.search.invoke({ query: "test", controls: { domain: "example.com" } });
    assert.equal(capturedHeaders["X-Site"], "example.com", "domain must map to X-Site header");
  });

  it("search accepts location and sends gl in POST body (8J.3)", async () => {
    let capturedInit = null;
    const fakeFetch = async (url, init) => {
      capturedInit = init;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: [] }),
      };
    };

    const adapter = new JinaAdapter(
      { env: { JINA_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );

    adapter.search.validate({ query: "test", controls: { location: "us" } });
    await adapter.search.invoke({ query: "test", controls: { location: "us" } });
    assert.equal(capturedInit.method, "POST", "location must trigger POST");
    const body = JSON.parse(capturedInit.body);
    assert.equal(body.gl, "us", "location must map to gl field in POST body");
    assert.equal(body.q, "test", "query must be in q field");
  });

  it("search still uses GET when no location is specified (8J.3)", async () => {
    let capturedInit = null;
    const fakeFetch = async (url, init) => {
      capturedInit = init;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: [] }),
      };
    };

    const adapter = new JinaAdapter(
      { env: { JINA_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );

    await adapter.search.invoke({ query: "test" });
    assert.equal(capturedInit.method, "GET", "GET path used when no location");
  });

  it("search rejects invalid domain syntax (8J.3)", () => {
    const adapter = new JinaAdapter(
      { env: { JINA_API_KEY: TEST_KEY } },
      { transport: { fetch: async () => ({}) } },
    );

    assert.throws(
      () => adapter.search.validate({ query: "test", controls: { domain: "https://example.com" } }),
      ValidationError,
    );
  });

  it("research accepts domain and sends only_hostnames (8J.4)", async () => {
    let capturedBody = null;
    const fakeFetch = async (url, init) => {
      capturedBody = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            choices: [{ message: { content: "Research answer." } }],
          }),
      };
    };

    const adapter = new JinaAdapter(
      { env: { JINA_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );

    adapter.research.run.validate({ query: "test", domain: "example.com" });
    await adapter.research.run.invoke({ query: "test", domain: "example.com" });
    assert.deepEqual(
      capturedBody.only_hostnames,
      ["example.com"],
      "domain must map to only_hostnames array",
    );
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

  it("maps 429 to terminal QuotaError (8J.5)", async () => {
    const fakeFetch = mockFetch({ message: "Rate limited" }, 429);

    const adapter = new JinaAdapter(
      { env: { JINA_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );

    await assert.rejects(
      () => adapter.search.invoke({ query: "test" }),
      (err) => err instanceof QuotaError && err.retryable === false,
    );
  });

  it("maps 403 insufficient-balance to QuotaError (8J.5)", async () => {
    const fakeFetch = async () => ({
      ok: false,
      status: 403,
      text: async () => JSON.stringify({ message: "Insufficient balance" }),
    });

    const adapter = new JinaAdapter(
      { env: { JINA_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );

    await assert.rejects(
      () => adapter.search.invoke({ query: "test" }),
      (err) => err instanceof QuotaError && err.retryable === false,
    );
  });

  it("maps a timeout during error-body read to TimeoutError (8J.5)", async () => {
    // Non-OK response whose body read aborts (e.g. client timeout during
    // error classification) must surface as TimeoutError, not the
    // status-derived error classification would otherwise produce.
    const abortError = Object.assign(new Error("aborted"), { name: "AbortError" });
    const fakeFetch = async () => ({
      ok: false,
      status: 500,
      text: async () => {
        throw abortError;
      },
    });

    const adapter = new JinaAdapter(
      { env: { JINA_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );

    await assert.rejects(
      () => adapter.search.invoke({ query: "test" }),
      (err) => err instanceof TimeoutError,
    );
  });

  it("maps 403 credential-failure to AuthError (8J.5)", async () => {
    const fakeFetch = async () => ({
      ok: false,
      status: 403,
      text: async () => JSON.stringify({ message: "Forbidden" }),
    });

    const adapter = new JinaAdapter(
      { env: { JINA_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );

    await assert.rejects(
      () => adapter.search.invoke({ query: "test" }),
      (err) => err instanceof AuthError,
    );
  });

  it("maps 403 insufficient-permissions to AuthError, NOT QuotaError (Greptile P1)", async () => {
    const fakeFetch = async () => ({
      ok: false,
      status: 403,
      text: async () => JSON.stringify({ message: "Insufficient permissions for this resource" }),
    });

    const adapter = new JinaAdapter(
      { env: { JINA_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );

    await assert.rejects(
      () => adapter.search.invoke({ query: "test" }),
      (err) => err instanceof AuthError && !(err instanceof QuotaError),
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

  it("accepts --topic news and appends to query via applySearchTopic", async () => {
    let capturedUrl;
    const fakeFetch = async (url) => {
      capturedUrl = url;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: [] }),
      };
    };

    const adapter = new JinaAdapter(
      { env: { JINA_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );

    // validate must not throw
    adapter.search.validate({ query: "rust async", controls: { topic: "news" } });
    await adapter.search.invoke({ query: "rust async", controls: { topic: "news" } });
    // s.jina.ai/{encoded query} — applySearchTopic appends " latest news"
    assert.ok(capturedUrl.includes("rust%20async%20latest%20news"));
  });

  it("accepts --topic finance and appends to query via applySearchTopic", async () => {
    let capturedUrl;
    const fakeFetch = async (url) => {
      capturedUrl = url;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: [] }),
      };
    };

    const adapter = new JinaAdapter(
      { env: { JINA_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );

    adapter.search.validate({ query: "tesla stock", controls: { topic: "finance" } });
    await adapter.search.invoke({ query: "tesla stock", controls: { topic: "finance" } });
    assert.ok(capturedUrl.includes("tesla%20stock%20financial"));
  });

  it("accepts --topic general and leaves query unchanged", async () => {
    let capturedUrl;
    const fakeFetch = async (url) => {
      capturedUrl = url;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: [] }),
      };
    };

    const adapter = new JinaAdapter(
      { env: { JINA_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );

    adapter.search.validate({ query: "rust async", controls: { topic: "general" } });
    await adapter.search.invoke({ query: "rust async", controls: { topic: "general" } });
    assert.ok(capturedUrl.includes("rust%20async"));
    assert.ok(!capturedUrl.includes("latest%20news"));
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
    assert.throws(() => adapter.reader.fetch.validate({ url: "not-a-url" }), ValidationError);
  });

  it("rejects empty reader URL", () => {
    const adapter = new JinaAdapter(
      { env: { JINA_API_KEY: TEST_KEY } },
      { transport: { fetch: async () => ({}) } },
    );

    assert.throws(() => adapter.reader.fetch.validate({ url: "  " }), ValidationError);
  });
});

// ---------------------------------------------------------------------------
// Diagnostics — offline probe tests (6.7.b)
// ---------------------------------------------------------------------------

describe("Jina Diagnostics — probe (6.7.b)", () => {
  it("resolves immediately when probe is false (no network)", async () => {
    let called = false;
    const fakeFetch = async () => {
      called = true;
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: [] }) };
    };
    const adapter = new JinaAdapter(
      { env: { JINA_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );
    await adapter.diagnostics.invoke({ probe: false });
    assert.equal(called, false, "no network call when probe is false");
  });

  it("performs a search request when probe is true", async () => {
    let capturedUrl;
    let capturedInit;
    const fakeFetch = async (url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: [] }) };
    };
    const adapter = new JinaAdapter(
      { env: { JINA_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );
    await adapter.diagnostics.invoke({ probe: true });
    assert.ok(
      capturedUrl.includes("s.jina.ai"),
      "diagnostics probe must hit the s.jina.ai search endpoint",
    );
    assert.ok(
      capturedUrl.includes("scoutline-doctor-probe"),
      "probe query must be 'scoutline-doctor-probe'",
    );
    assert.equal(capturedInit.method, "GET");
    assert.ok(
      capturedInit.headers["Authorization"].includes(TEST_KEY),
      "Authorization header carries the API key when present",
    );
  });

  it("rejects keyless diagnostics probe with ConfigurationError (8J.1)", async () => {
    const fakeFetch = async () => {
      throw new Error("should not be called");
    };
    const adapter = new JinaAdapter({ env: {} }, { transport: { fetch: fakeFetch } });
    await assert.rejects(
      () => adapter.diagnostics.invoke({ probe: true }),
      (e) => e instanceof ConfigurationError && e.message.includes("JINA_API_KEY"),
    );
  });

  it("throws AuthError on 401", async () => {
    const fakeFetch = async () => ({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ message: "Unauthorized" }),
    });
    const adapter = new JinaAdapter(
      { env: { JINA_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );
    await assert.rejects(
      () => adapter.diagnostics.invoke({ probe: true }),
      (e) => e instanceof AuthError,
    );
  });
});

// ---------------------------------------------------------------------------
// Capability gating — 8J.1
// ---------------------------------------------------------------------------

describe("Jina Capability Gating (8J.1)", () => {
  it("descriptor isConfigured is capability-aware", () => {
    const desc = createJinaDescriptor();

    // Without capability context — always configured (keyless Reader)
    assert.equal(desc.isConfigured({}), true);
    assert.equal(desc.isConfigured({ JINA_API_KEY: TEST_KEY }), true);

    // Reader is keyless
    assert.equal(desc.isConfigured({}, "reader"), true);
    assert.equal(desc.isConfigured({ JINA_API_KEY: TEST_KEY }, "reader"), true);

    // Search/Research/Diagnostics require key
    assert.equal(desc.isConfigured({}, "search"), false);
    assert.equal(desc.isConfigured({ JINA_API_KEY: TEST_KEY }, "search"), true);
    assert.equal(desc.isConfigured({}, "research"), false);
    assert.equal(desc.isConfigured({ JINA_API_KEY: TEST_KEY }, "research"), true);
    assert.equal(desc.isConfigured({}, "diagnostics"), false);
    assert.equal(desc.isConfigured({ JINA_API_KEY: TEST_KEY }, "diagnostics"), true);
  });

  it("descriptor still advertises all capabilities regardless of key state", () => {
    const desc = createJinaDescriptor();
    // capabilities() is static metadata — it advertises what Jina CAN do.
    // The capability-aware isConfigured check gates whether it's ready
    // to serve a specific capability.
    const capsNoKey = desc.capabilities();
    const capsWithKey = desc.capabilities();
    assert.deepEqual(Array.from(capsNoKey), Array.from(capsWithKey));
    assert.ok(capsNoKey.has("search"));
    assert.ok(capsNoKey.has("reader"));
    assert.ok(capsNoKey.has("research"));
    assert.ok(capsNoKey.has("diagnostics"));
  });

  it("fallback never selects Jina for search without key (8J.1)", () => {
    // Simulate the preflight that provider-fallback.ts runs.
    // A descriptor that isConfigured(env, "search") === false is
    // tagged "unconfigured" and skipped, preventing a guaranteed 401.
    const desc = createJinaDescriptor();
    const isReady = desc.isConfigured({}, "search");
    assert.equal(isReady, false, "Jina search must not be eligible without JINA_API_KEY");
  });

  it("fallback selects Jina for reader even without key (8J.1)", () => {
    const desc = createJinaDescriptor();
    const isReady = desc.isConfigured({}, "reader");
    assert.equal(isReady, true, "Jina reader must be eligible keyless");
  });
});
