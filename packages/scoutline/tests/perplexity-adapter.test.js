/**
 * Perplexity Provider unit tests.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  createPerplexityDescriptor,
  PerplexityAdapter,
} from "../dist/providers/perplexity/adapter.js";
import {
  resolvePerplexityApiKey,
  requirePerplexityApiKey,
  isPerplexityConfigured,
} from "../dist/providers/perplexity/credentials.js";
import {
  ApiError,
  AuthError,
  ConfigurationError,
  TimeoutError,
  UnsupportedOptionError,
} from "../dist/lib/errors.js";
import { fetchPerplexityAgent } from "../dist/providers/perplexity/client.js";

const TEST_KEY = "perplexity-test-api-key";

describe("Perplexity Credentials", () => {
  it("resolves valid API key from environment", () => {
    assert.equal(resolvePerplexityApiKey({ PERPLEXITY_API_KEY: "  key456  " }), "  key456  ");
    assert.equal(resolvePerplexityApiKey({}), undefined);
    assert.equal(resolvePerplexityApiKey({ PERPLEXITY_API_KEY: "   " }), undefined);
  });

  it("requirePerplexityApiKey throws ConfigurationError when missing", () => {
    assert.throws(() => requirePerplexityApiKey({}), ConfigurationError);
    assert.equal(requirePerplexityApiKey({ PERPLEXITY_API_KEY: TEST_KEY }), TEST_KEY);
  });

  it("checks if perplexity is configured", () => {
    assert.equal(isPerplexityConfigured({ PERPLEXITY_API_KEY: TEST_KEY }), true);
    assert.equal(isPerplexityConfigured({}), false);
  });
});

describe("Perplexity Descriptor & Adapter", () => {
  it("creates descriptor with correct metadata", () => {
    const desc = createPerplexityDescriptor();
    assert.equal(desc.id, "perplexity");
    assert.deepEqual(Array.from(desc.capabilities()), ["search", "research", "diagnostics"]);
  });

  it("invokes search via Search API with structured results", async () => {
    const fakeFetch = async (url, init) => {
      assert.ok(url.includes("/search"), "search must hit /search endpoint");
      assert.ok(!url.includes("/chat/completions"), "search must not use chat completions");
      const body = JSON.parse(init.body);
      assert.equal(body.query, "node js ESM");
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            id: "test-id",
            results: [
              {
                title: "Modules: ECMAScript modules | Node.js",
                url: "https://nodejs.org/api/esm.html",
                snippet: "ECMAScript modules are the official standard format.",
                date: "2025-06-15",
                last_updated: "2025-07-01",
              },
              {
                title: "ES Modules Guide",
                url: "https://example.com/esm",
                snippet: "A guide to ES modules.",
                date: null,
                last_updated: "2025-06-20",
              },
            ],
          }),
      };
    };

    const adapter = new PerplexityAdapter(
      { env: { PERPLEXITY_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );

    adapter.search.validate({ query: "node js ESM" });
    const results = await adapter.search.invoke({ query: "node js ESM" });
    assert.equal(results.length, 2);
    assert.equal(results[0].title, "Modules: ECMAScript modules | Node.js");
    assert.equal(results[0].url, "https://nodejs.org/api/esm.html");
    assert.equal(results[0].summary, "ECMAScript modules are the official standard format.");
    assert.equal(results[0].date, "2025-06-15");
    assert.equal(results[0].source, undefined);
    // null date maps to undefined
    assert.equal(results[1].date, undefined);
  });

  it("skips search results without a URL (no empty-url SearchSource)", async () => {
    const fakeFetch = async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          results: [
            { title: "Has URL", url: "https://example.com/a", snippet: "with url" },
            { title: "No URL", snippet: "no url field" },
          ],
        }),
    });

    const adapter = new PerplexityAdapter(
      { env: { PERPLEXITY_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );

    const results = await adapter.search.invoke({ query: "test" });
    assert.ok(
      results.every((r) => typeof r.url === "string" && r.url.length > 0),
      "no SearchSource may carry an empty url",
    );
    assert.equal(results.length, 1);
    assert.equal(results[0].url, "https://example.com/a");
  });

  it("maps search controls to API params", async () => {
    let captured;
    const fakeFetch = async (url, init) => {
      captured = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ results: [] }),
      };
    };

    const adapter = new PerplexityAdapter(
      { env: { PERPLEXITY_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );

    await adapter.search.invoke({
      query: "test",
      controls: { domain: "example.com", recency: "oneWeek", contentSize: "high" },
    });

    assert.deepEqual(captured.search_domain_filter, ["example.com"]);
    assert.equal(captured.search_recency_filter, "week");
    assert.equal(captured.search_context_size, "high");
  });

  it("invokes research via the Agent API high preset", async () => {
    const fakeFetch = async (url, init) => {
      assert.ok(url.includes("/v1/agent"), "research must hit the Agent API endpoint");
      assert.ok(
        !url.includes("/chat/completions"),
        "research must not use the deprecated chat completions surface",
      );
      assert.ok(
        init.headers["Authorization"].includes(TEST_KEY),
        "Authorization header carries the API key",
      );
      const body = JSON.parse(init.body);
      assert.equal(body.preset, "high");
      assert.equal(body.input, "AI search engines");
      assert.equal(body.model, undefined, "preset replaces the model field");
      assert.equal(body.messages, undefined, "input replaces the messages field");
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            id: "resp_test-1234",
            model: "openai/gpt-5.6-sol",
            object: "response",
            status: "completed",
            error: null,
            output: [
              {
                type: "search_results",
                queries: ["AI search engines 2026"],
                results: [
                  {
                    id: 1,
                    title: "AI Search Study",
                    url: "https://example.com/study",
                    date: "2025-01-01",
                    last_updated: null,
                    snippet: "A study.",
                    source: "web",
                  },
                  {
                    id: 2,
                    title: "Search Engine Analysis",
                    url: "https://example.com/analysis",
                    date: null,
                    last_updated: null,
                    snippet: "An analysis.",
                    source: "web",
                  },
                ],
              },
              {
                type: "message",
                id: "msg_test-5678",
                role: "assistant",
                status: "completed",
                content: [
                  {
                    type: "output_text",
                    text: "Comprehensive research report on AI search.",
                    annotations: [],
                  },
                ],
              },
            ],
          }),
      };
    };

    const adapter = new PerplexityAdapter(
      { env: { PERPLEXITY_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );

    adapter.research.run.validate({ query: "AI search engines" });
    const res = await adapter.research.run.invoke({ query: "AI search engines" });
    // Normalized envelope is byte-compatible: exactly these five fields,
    // nothing from the Agent API trace (queries, usage, output ids) leaks.
    assert.deepEqual(res, {
      schemaVersion: 1,
      query: "AI search engines",
      model: "openai/gpt-5.6-sol",
      report: "Comprehensive research report on AI search.",
      sources: [
        { title: "AI Search Study", url: "https://example.com/study" },
        { title: "Search Engine Analysis", url: "https://example.com/analysis" },
      ],
    });
  });

  it("research unions and dedupes sources across search rounds (the payload demands it)", async () => {
    const fakeFetch = async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          status: "completed",
          error: null,
          // model absent — the envelope falls back to the preset name
          output: [
            {
              type: "search_results",
              results: [
                {
                  id: 1,
                  title: "Round One Study",
                  url: "https://example.com/study",
                  source: "web",
                },
              ],
            },
            {
              type: "search_results",
              results: [
                {
                  id: 1,
                  title: "Duplicate URL from a later round",
                  url: "https://example.com/study",
                  source: "web",
                },
                { id: 2, url: "https://example.com/round-two", source: "web" },
              ],
            },
            {
              type: "message",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "Report text." }],
            },
          ],
        }),
    });

    const adapter = new PerplexityAdapter(
      { env: { PERPLEXITY_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );

    const res = await adapter.research.run.invoke({ query: "test" });
    assert.equal(res.model, "high");
    assert.deepEqual(res.sources, [
      { title: "Round One Study", url: "https://example.com/study" },
      { title: "Source 2", url: "https://example.com/round-two" },
    ]);
  });

  it("research rejects a failed agent run instead of caching an empty report", async () => {
    const fakeFetch = async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          status: "failed",
          error: { code: "server_error", message: "Run failed" },
          output: [],
        }),
    });

    const adapter = new PerplexityAdapter(
      { env: { PERPLEXITY_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );

    await assert.rejects(
      () => adapter.research.run.invoke({ query: "test" }),
      (err) => err instanceof ApiError,
    );
  });
  it("research rejects a non-completed agent run with null error instead of caching an empty report", async () => {
    const fakeFetch = async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          status: "incomplete",
          error: null,
          output: [],
        }),
    });

    const adapter = new PerplexityAdapter(
      { env: { PERPLEXITY_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );

    await assert.rejects(
      () => adapter.research.run.invoke({ query: "test" }),
      (err) => err instanceof ApiError,
    );
  });

  it("research cache identity is request-based — no transport or endpoint fields", () => {
    const adapter = new PerplexityAdapter(
      { env: { PERPLEXITY_API_KEY: TEST_KEY } },
      { transport: { fetch: async () => ({}) } },
    );

    const identity = adapter.research.run.cacheIdentity({ query: "  AI search  " });
    assert.equal(identity.provider, "perplexity");
    assert.equal(identity.capability, "research");
    assert.equal(identity.operation, "research-fetch");
    assert.equal(typeof identity.credentialFingerprint, "string");
    assert.equal(identity.credentialFingerprint.length, 64);
    assert.deepEqual(identity.request, { query: "AI search" });
  });
});

describe("Perplexity Error Handling", () => {
  it("maps 401 to AuthError", async () => {
    const fakeFetch = async () => ({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ message: "Unauthorized" }),
    });

    const adapter = new PerplexityAdapter(
      { env: { PERPLEXITY_API_KEY: TEST_KEY } },
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

    const adapter = new PerplexityAdapter(
      { env: { PERPLEXITY_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );

    await assert.rejects(
      () => adapter.search.invoke({ query: "test" }),
      (err) => err instanceof ApiError && err.statusCode === 429,
    );
  });

  it("rejects type control as UnsupportedOptionError", () => {
    const adapter = new PerplexityAdapter(
      { env: { PERPLEXITY_API_KEY: TEST_KEY } },
      { transport: { fetch: async () => ({}) } },
    );

    assert.throws(
      () => adapter.search.validate({ query: "test", controls: { type: "video" } }),
      UnsupportedOptionError,
    );
  });

  it("accepts --topic news and appends to query via applySearchTopic", async () => {
    let captured;
    const fakeFetch = async (url, init) => {
      captured = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ results: [] }),
      };
    };

    const adapter = new PerplexityAdapter(
      { env: { PERPLEXITY_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );

    // validate must not throw
    adapter.search.validate({ query: "rust async", controls: { topic: "news" } });
    await adapter.search.invoke({ query: "rust async", controls: { topic: "news" } });
    assert.equal(captured.query, "rust async latest news");
  });

  it("accepts --topic finance and appends to query via applySearchTopic", async () => {
    let captured;
    const fakeFetch = async (url, init) => {
      captured = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ results: [] }),
      };
    };

    const adapter = new PerplexityAdapter(
      { env: { PERPLEXITY_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );

    adapter.search.validate({ query: "tesla stock", controls: { topic: "finance" } });
    await adapter.search.invoke({ query: "tesla stock", controls: { topic: "finance" } });
    assert.equal(captured.query, "tesla stock financial");
  });

  it("accepts --topic general and leaves query unchanged", async () => {
    let captured;
    const fakeFetch = async (url, init) => {
      captured = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ results: [] }),
      };
    };

    const adapter = new PerplexityAdapter(
      { env: { PERPLEXITY_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );

    adapter.search.validate({ query: "rust async", controls: { topic: "general" } });
    await adapter.search.invoke({ query: "rust async", controls: { topic: "general" } });
    assert.equal(captured.query, "rust async");
  });

  it("rejects location control as UnsupportedOptionError", () => {
    const adapter = new PerplexityAdapter(
      { env: { PERPLEXITY_API_KEY: TEST_KEY } },
      { transport: { fetch: async () => ({}) } },
    );

    assert.throws(
      () => adapter.search.validate({ query: "test", controls: { location: "US" } }),
      UnsupportedOptionError,
    );
  });

  it("rejects research model as UnsupportedOptionError", () => {
    const adapter = new PerplexityAdapter(
      { env: { PERPLEXITY_API_KEY: TEST_KEY } },
      { transport: { fetch: async () => ({}) } },
    );

    assert.throws(
      () => adapter.research.run.validate({ query: "test", model: "pro" }),
      (err) =>
        err instanceof UnsupportedOptionError &&
        err.provider === "perplexity" &&
        err.capability === "research" &&
        err.option === "model",
    );
  });
});

// ---------------------------------------------------------------------------
// Diagnostics — offline probe tests (6.7.a)
// ---------------------------------------------------------------------------

describe("Perplexity Diagnostics — probe (6.7.a)", () => {
  it("resolves immediately when probe is false (no network)", async () => {
    let called = false;
    const fakeFetch = async () => {
      called = true;
      return { ok: true, status: 200, text: async () => JSON.stringify({ results: [] }) };
    };
    const adapter = new PerplexityAdapter(
      { env: { PERPLEXITY_API_KEY: TEST_KEY } },
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
      return { ok: true, status: 200, text: async () => JSON.stringify({ results: [] }) };
    };
    const adapter = new PerplexityAdapter(
      { env: { PERPLEXITY_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );
    await adapter.diagnostics.invoke({ probe: true });
    assert.ok(capturedUrl.includes("/search"), "diagnostics probe must hit /search endpoint");
    const body = JSON.parse(capturedInit.body);
    assert.equal(body.query, "scoutline-doctor-probe");
    assert.equal(body.max_results, 1);
    assert.ok(
      capturedInit.headers["Authorization"].includes(TEST_KEY),
      "Authorization header carries the API key",
    );
  });

  it("throws AuthError on 401", async () => {
    const fakeFetch = async () => ({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ message: "Unauthorized" }),
    });
    const adapter = new PerplexityAdapter(
      { env: { PERPLEXITY_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );
    await assert.rejects(
      () => adapter.diagnostics.invoke({ probe: true }),
      (e) => e instanceof AuthError,
    );
  });

  it("throws ConfigurationError when API key is missing", async () => {
    const fakeFetch = async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ results: [] }),
    });
    const adapter = new PerplexityAdapter({ env: {} }, { transport: { fetch: fakeFetch } });
    await assert.rejects(
      () => adapter.diagnostics.invoke({ probe: true }),
      (e) => e instanceof ConfigurationError,
    );
  });
});

// ---------------------------------------------------------------------------
// Transport — Agent API research (#107; research status-timeout help #51)
// ---------------------------------------------------------------------------

describe("Perplexity Transport — Agent API research (#107)", () => {
  it("posts preset high + input to /v1/agent with bearer auth", async () => {
    let capturedUrl;
    let capturedInit;
    const fakeFetch = async (url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ status: "completed", error: null, output: [] }),
      };
    };

    const res = await fetchPerplexityAgent(TEST_KEY, "q", { fetch: fakeFetch });
    assert.ok(capturedUrl.includes("/v1/agent"), "agent transport must hit /v1/agent");
    assert.ok(
      !capturedUrl.includes("/chat/completions"),
      "agent transport must not use the deprecated chat completions surface",
    );
    assert.equal(capturedInit.headers["Authorization"], `Bearer ${TEST_KEY}`);
    assert.deepEqual(JSON.parse(capturedInit.body), { preset: "high", input: "q" });
    assert.equal(res.status, "completed");
  });

  it("maps 504 on a research agent call to TimeoutError with research timeout help", async () => {
    const fakeFetch = async () => ({
      ok: false,
      status: 504,
      text: async () => JSON.stringify({ message: "Gateway Timeout" }),
    });

    await assert.rejects(
      () => fetchPerplexityAgent(TEST_KEY, "q", { fetch: fakeFetch }),
      (err) =>
        err instanceof TimeoutError &&
        typeof err.help === "string" &&
        err.help.includes("PERPLEXITY_RESEARCH_TIMEOUT"),
    );
  });

  it("maps 408 on a research agent call to TimeoutError with research timeout help", async () => {
    const fakeFetch = async () => ({
      ok: false,
      status: 408,
      text: async () => JSON.stringify({ message: "Request Timeout" }),
    });

    await assert.rejects(
      () => fetchPerplexityAgent(TEST_KEY, "q", { fetch: fakeFetch }),
      (err) =>
        err instanceof TimeoutError &&
        typeof err.help === "string" &&
        err.help.includes("PERPLEXITY_RESEARCH_TIMEOUT"),
    );
  });
});
