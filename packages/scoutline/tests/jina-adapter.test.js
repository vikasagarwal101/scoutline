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
  NetworkError,
  QuotaError,
  ScoutlineError,
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

/**
 * Build a synthetic SSE response body for DeepSearch streaming (8J.6).
 * Each event is a `data: {JSON}\n` line. The terminal chunk carries
 * annotations, visitedURLs, and finish_reason: "stop".
 *
 * @param {string} answerContent — the final answer text (delta.type "text")
 * @param {object} [opts]
 * @param {string} [opts.thinkContent] — reasoning step content (delta.type "think"); skipped by parser
 * @param {Array} [opts.annotations] — citation annotations on the terminal chunk
 * @param {Array} [opts.visitedURLs] — visited URLs on the terminal chunk
 */
function mockDeepSearchSSE(answerContent, opts = {}) {
  const { thinkContent = "Reasoning about the query.", annotations = [], visitedURLs = [] } = opts;
  const events = [
    // Reasoning step (think) — should be skipped by the parser
    JSON.stringify({
      choices: [{ delta: { content: `<think>${thinkContent}</think>\n\n`, type: "think" }, finish_reason: "thinking_end" }],
    }),
    // Final answer (text) — should be accumulated
    JSON.stringify({
      choices: [{
        delta: { content: answerContent, type: "text", ...(annotations.length > 0 ? { annotations } : {}) },
        finish_reason: "stop",
      }],
      ...(visitedURLs.length > 0 ? { visitedURLs } : {}),
    }),
  ];
  return events.map((e) => `data: ${e}\n`).join("\n");
}

describe("Jina AI Credentials", () => {
  it("resolves valid API key from environment", () => {
    assert.equal(resolveJinaApiKey({ JINA_API_KEY: "  key789  " }), "key789");
    assert.equal(resolveJinaApiKey({}), undefined);
    assert.equal(resolveJinaApiKey({ JINA_API_KEY: "   " }), undefined);
  });

  it("returns a whitespace-padded key trimmed (#58d)", () => {
    assert.equal(resolveJinaApiKey({ JINA_API_KEY: "  key789  " }), "key789");
  });

  it("returns undefined for a fully blank key (#58d guard)", () => {
    assert.equal(resolveJinaApiKey({ JINA_API_KEY: " \t " }), undefined);
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
    // Quota requires a key (probe uses Search endpoint — 8J.5)
    assert.equal(isJinaConfigured({ JINA_API_KEY: TEST_KEY }, "quota"), true);
    assert.equal(isJinaConfigured({}, "quota"), false);
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
      "quota",
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
          mockDeepSearchSSE(
            "Rust async programming uses futures and the async/await syntax.",
            {
              annotations: [
                {
                  type: "url_citation",
                  url_citation: {
                    title: "Rust Book",
                    url: "https://doc.rust-lang.org/book",
                    exactQuote: "async/await",
                  },
                },
                {
                  type: "url_citation",
                  url_citation: {
                    title: "Tokio Tutorial",
                    url: "https://tokio.rs/tutorial",
                    exactQuote: "runtime",
                  },
                },
              ],
              visitedURLs: ["https://doc.rust-lang.org/book", "https://tokio.rs/tutorial"],
            },
          ),
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
        mockDeepSearchSSE("Research answer.", {
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
        text: async () => mockDeepSearchSSE("Research answer."),
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

// ---------------------------------------------------------------------------
// DeepSearch Streaming — 8J.6
// ---------------------------------------------------------------------------

describe("Jina DeepSearch Streaming (8J.6)", () => {
  it("sends stream: true in the request body", async () => {
    let capturedBody = null;
    const fakeFetch = async (url, init) => {
      capturedBody = JSON.parse(init.body);
      return { ok: true, status: 200, text: async () => mockDeepSearchSSE("Answer.") };
    };

    const adapter = new JinaAdapter(
      { env: { JINA_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );

    await adapter.research.run.invoke({ query: "test" });
    assert.equal(capturedBody.stream, true, "stream must be true in request body (8J.6)");
  });

  it("accumulates text content and skips think chunks", async () => {
    // Multi-chunk SSE: several think fragments + one text answer fragment
    const sseBody = [
      // Reasoning fragments (think) — must be skipped
      `data: ${JSON.stringify({ choices: [{ delta: { content: "<think>", type: "think" } }] })}\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Reasoning step.", type: "think" } }] })}\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "</think>\n\n", type: "think" }, finish_reason: "thinking_end" }] })}\n`,
      // Answer fragment (text) — must be accumulated
      `data: ${JSON.stringify({ choices: [{ delta: { content: "The answer is 42.", type: "text" }, finish_reason: "stop" }] })}\n`,
    ].join("\n");

    const fakeFetch = async () => ({
      ok: true,
      status: 200,
      text: async () => sseBody,
    });

    const adapter = new JinaAdapter(
      { env: { JINA_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );

    const res = await adapter.research.run.invoke({ query: "meaning of life" });
    assert.equal(res.report, "The answer is 42.", "only text content accumulated, think skipped");
    assert.ok(!res.report.includes("think"), "no think tags in report");
    assert.ok(!res.report.includes("Reasoning"), "no reasoning in report");
  });

  it("accumulates content across multiple text chunks", async () => {
    const sseBody = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "<think>skip</think>\n\n", type: "think" }, finish_reason: "thinking_end" }] })}\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Part 1. ", type: "text" } }] })}\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Part 2. ", type: "text" } }] })}\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Part 3.", type: "text" }, finish_reason: "stop" }] })}\n`,
    ].join("\n");

    const fakeFetch = async () => ({
      ok: true,
      status: 200,
      text: async () => sseBody,
    });

    const adapter = new JinaAdapter(
      { env: { JINA_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );

    const res = await adapter.research.run.invoke({ query: "test" });
    assert.equal(res.report, "Part 1. Part 2. Part 3.");
  });

  it("extracts citations from terminal chunk annotations", async () => {
    const sseBody = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "<think>reasoning</think>\n\n", type: "think" }, finish_reason: "thinking_end" }] })}\n`,
      `data: ${JSON.stringify({
        choices: [{
          delta: {
            content: "The answer with citations.",
            type: "text",
            annotations: [
              { type: "url_citation", url_citation: { title: "Source A", url: "https://a.example.com" } },
              { type: "url_citation", url_citation: { title: "Source B", url: "https://b.example.com" } },
            ],
          },
          finish_reason: "stop",
        }],
        visitedURLs: ["https://a.example.com", "https://b.example.com"],
      })}\n`,
    ].join("\n");

    const fakeFetch = async () => ({
      ok: true,
      status: 200,
      text: async () => sseBody,
    });

    const adapter = new JinaAdapter(
      { env: { JINA_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );

    const res = await adapter.research.run.invoke({ query: "test" });
    assert.equal(res.report, "The answer with citations.");
    assert.equal(res.sources.length, 2);
    assert.equal(res.sources[0].title, "Source A");
    assert.equal(res.sources[0].url, "https://a.example.com");
    assert.equal(res.sources[1].url, "https://b.example.com");
  });

  it("falls back to visitedURLs when no annotations in stream", async () => {
    const sseBody = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "<think>skip</think>\n\n", type: "think" }, finish_reason: "thinking_end" }] })}\n`,
      `data: ${JSON.stringify({
        choices: [{ delta: { content: "Answer without annotations.", type: "text" }, finish_reason: "stop" }],
        visitedURLs: ["https://visited1.com", "https://visited2.com"],
      })}\n`,
    ].join("\n");

    const fakeFetch = async () => ({
      ok: true,
      status: 200,
      text: async () => sseBody,
    });

    const adapter = new JinaAdapter(
      { env: { JINA_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );

    const res = await adapter.research.run.invoke({ query: "test" });
    assert.equal(res.sources.length, 2);
    assert.equal(res.sources[0].url, "https://visited1.com");
  });

  it("handles [DONE] sentinel gracefully", async () => {
    // Content chunk has NO finish_reason — termination depends solely
    // on the [DONE] sentinel, exercising that branch.
    const sseBody = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Done test.", type: "text" } }] })}\n`,
      "data: [DONE]\n",
    ].join("\n");

    const fakeFetch = async () => ({
      ok: true,
      status: 200,
      text: async () => sseBody,
    });

    const adapter = new JinaAdapter(
      { env: { JINA_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );

    const res = await adapter.research.run.invoke({ query: "test" });
    assert.equal(res.report, "Done test.");
  });

  it("honors AbortSignal — throws TimeoutError on abort", async () => {
    // The fake fetch returns a promise that rejects ONLY when init.signal
    // (the controller's signal) is actually aborted. This genuinely
    // exercises the externalSignal → controller.abort() → init.signal
    // wiring — if the linkage is broken, the promise never resolves and
    // the test times out rather than falsely passing.
    const fakeFetch = (url, init) => {
      if (init.signal.aborted) {
        const err = new Error("The user aborted a request");
        err.name = "AbortError";
        return Promise.reject(err);
      }
      return new Promise((_, reject) => {
        init.signal.addEventListener("abort", () => {
          const err = new Error("The user aborted a request");
          err.name = "AbortError";
          reject(err);
        });
      });
    };

    const adapter = new JinaAdapter(
      { env: { JINA_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );

    const ac = new AbortController();
    const promise = adapter.research.run.invoke({ query: "test" }, ac.signal);
    // Abort after the fetch is in-flight
    ac.abort();

    await assert.rejects(promise, (err) => err instanceof TimeoutError);
  });

  it("maps HTTP 524 to TimeoutError with DeepSearch-specific help text", async () => {
    const fakeFetch = async () => ({
      ok: false,
      status: 524,
      text: async () => JSON.stringify({ message: "origin timeout" }),
    });

    const adapter = new JinaAdapter(
      { env: { JINA_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );

    await assert.rejects(
      () => adapter.research.run.invoke({ query: "test" }),
      (err) => {
        if (!(err instanceof TimeoutError)) return false;
        // Help text must reference JINA_DEEPSEARCH_TIMEOUT, not the generic JINA_TIMEOUT
        return err.help?.includes("JINA_DEEPSEARCH_TIMEOUT");
      },
    );
  });

  it("accumulated streaming result matches non-stream mapping", async () => {
    // This test verifies that the streaming SSE parse produces the exact
    // same normalized ResearchResult shape as the old non-stream mapping:
    //   choices[0].message.content -> report
    //   message.annotations -> sources
    //   visitedURLs -> fallback sources
    const annotations = [
      { type: "url_citation", url_citation: { title: "Doc", url: "https://doc.example.com" } },
    ];
    const sseBody = mockDeepSearchSSE("Final research report content.", {
      thinkContent: "Complex reasoning about the query that should not appear in output.",
      annotations,
      visitedURLs: ["https://doc.example.com"],
    });

    const fakeFetch = async () => ({
      ok: true,
      status: 200,
      text: async () => sseBody,
    });

    const adapter = new JinaAdapter(
      { env: { JINA_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );

    const res = await adapter.research.run.invoke({ query: "test query" });
    // Same shape as non-stream mapping
    assert.equal(res.schemaVersion, 1);
    assert.equal(res.query, "test query");
    assert.equal(res.model, "jina-deepsearch-v1");
    assert.equal(res.report, "Final research report content.");
    assert.equal(res.sources.length, 1);
    assert.equal(res.sources[0].title, "Doc");
    assert.equal(res.sources[0].url, "https://doc.example.com");
  });

  it("fails closed on premature EOF — no terminal event", async () => {
    // Stream has content but no finish_reason: "stop" or [DONE] —
    // indicates a truncated response. Must NOT return partial content.
    const sseBody = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "<think>skip</think>\n\n", type: "think" }, finish_reason: "thinking_end" }] })}\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Partial answer.", type: "text" } }] })}\n`,
      // No terminal chunk — stream just ends
    ].join("\n");

    const fakeFetch = async () => ({
      ok: true,
      status: 200,
      text: async () => sseBody,
    });

    const adapter = new JinaAdapter(
      { env: { JINA_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );

    await assert.rejects(
      () => adapter.research.run.invoke({ query: "test" }),
      (err) => err instanceof ApiError,
    );
  });

  it("fails on malformed SSE data payload", async () => {
    // A data: line with invalid JSON indicates response corruption.
    const sseBody = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "<think>skip</think>\n\n", type: "think" }, finish_reason: "thinking_end" }] })}\n`,
      "data: {invalid json\n",
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Answer.", type: "text" }, finish_reason: "stop" }] })}\n`,
    ].join("\n");

    const fakeFetch = async () => ({
      ok: true,
      status: 200,
      text: async () => sseBody,
    });

    const adapter = new JinaAdapter(
      { env: { JINA_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );

    await assert.rejects(
      () => adapter.research.run.invoke({ query: "test" }),
      (err) => err instanceof ApiError,
    );
  });


  it("rejects wrong-shape url_citation annotations with ApiError 502 (#53)", async () => {
    // url_citation present but wrong shape (string instead of object) —
    // the parser must fail closed, not silently drop or retain the entry.
    const sseBody = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "<think>skip</think>\n\n", type: "think" }, finish_reason: "thinking_end" }] })}\n`,
      `data: ${JSON.stringify({
        choices: [{
          delta: {
            content: "Answer with a malformed citation.",
            type: "text",
            annotations: [
              { type: "url_citation", url_citation: "https://malformed.example.com" },
            ],
          },
          finish_reason: "stop",
        }],
      })}\n`,
    ].join("\n");

    const fakeFetch = async () => ({
      ok: true,
      status: 200,
      text: async () => sseBody,
    });

    const adapter = new JinaAdapter(
      { env: { JINA_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );

    await assert.rejects(
      () => adapter.research.run.invoke({ query: "test" }),
      (err) => err instanceof ApiError && err.statusCode === 502,
    );
  });

  it("retains well-formed url_citation annotations (#53 guard)", async () => {
    const sseBody = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "<think>skip</think>\n\n", type: "think" }, finish_reason: "thinking_end" }] })}\n`,
      `data: ${JSON.stringify({
        choices: [{
          delta: {
            content: "Answer.",
            type: "text",
            annotations: [
              {
                type: "url_citation",
                url_citation: {
                  title: "Well-formed Source",
                  url: "https://valid.example.com",
                  exactQuote: "quoted text",
                },
              },
            ],
          },
          finish_reason: "stop",
        }],
      })}\n`,
    ].join("\n");

    const fakeFetch = async () => ({
      ok: true,
      status: 200,
      text: async () => sseBody,
    });

    const adapter = new JinaAdapter(
      { env: { JINA_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );

    const res = await adapter.research.run.invoke({ query: "test" });
    assert.equal(res.sources.length, 1);
    assert.equal(res.sources[0].title, "Well-formed Source");
    assert.equal(res.sources[0].url, "https://valid.example.com");
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
    assert.ok(capsNoKey.has("quota"));
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

// ---------------------------------------------------------------------------
// Quota capability — X-RateLimit header harvesting (8J.5 telemetry)
// ---------------------------------------------------------------------------
//
// Header names verified against Jina's OpenAPI schema (api.jina.ai/openapi.json):
//   "Rate limit headers are included in responses:
//    X-RateLimit-Remaining-Requests, X-RateLimit-Remaining-Tokens"
//
// Finding 8J.5 originally claimed `x-ratelimit-limit`, `x-ratelimit-remaining`,
// `x-usage-tokens` — these do NOT exist. The actual headers are the
// Remaining-* variants above (lesson 0.14.8: a finding's premise can be inverted).
//
// Documented rate-limit tiers (OpenAPI schema) — CONTEXT ONLY since #49:
//   Free:   500 RPM,   1M TPM
//   Tier 1: 500 RPM,  10M TPM
//   Tier 2: 5,000 RPM, 100M TPM
// Jina exposes remaining but never a limit, so the tiers are NOT used to
// infer one (#49): windows publish the exact remaining with the limit
// explicitly unknown and omit `used` and `remainingPercent`.
describe("Jina AI Quota (8J.5 telemetry)", () => {
  /**
   * Build a fake fetch that returns rate-limit headers matching Jina's
   * documented response-header contract (OpenAPI schema).
   */
  function mockQuotaFetch(opts = {}) {
    const {
      remainingRequests = "499",
      remainingTokens = "999000",
      status = 200,
      body = { data: [] },
    } = opts;
    const headerMap = new Map();
    if (remainingRequests !== null) headerMap.set("x-ratelimit-remaining-requests", remainingRequests);
    if (remainingTokens !== null) headerMap.set("x-ratelimit-remaining-tokens", remainingTokens);
    return async () => ({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name) => headerMap.get(name.toLowerCase()) ?? null },
      text: async () => JSON.stringify(body),
    });
  }

  it("reports quota with correct header names (X-RateLimit-Remaining-Requests/Tokens)", async () => {
    // Free-tier remaining: 499 RPM (of 500), 999000 TPM (of 1M)
    const fakeFetch = mockQuotaFetch({ remainingRequests: "499", remainingTokens: "999000" });
    const adapter = new JinaAdapter(
      { env: { JINA_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );

    const result = await adapter.quota.invoke();
    assert.equal(result.provider, "jina");
    assert.equal(result.status, "ok");
    assert.ok(result.categories.length >= 1, "must have at least one category");

    // Requests category — exact remaining, explicitly unknown limit (#49).
    const reqCat = result.categories.find((c) => c.unit === "requests");
    assert.ok(reqCat, "must have a requests category");
    assert.equal(reqCat.name, "rate_limit_requests");
    assert.equal(reqCat.current.remaining, 499, "exact provider remaining");
    assert.equal(reqCat.current.used, undefined, "used omitted (would be inferred)");
    assert.equal(reqCat.current.limit, undefined, "limit explicitly unknown");
    assert.equal(
      reqCat.current.remainingPercent,
      undefined,
      "no remainingPercent without a limit (#49)",
    );
    assert.equal(reqCat.current.durationSeconds, 60, "per-minute window");

    // Tokens category — exact remaining, explicitly unknown limit (#49).
    const tokCat = result.categories.find((c) => c.unit === "tokens");
    assert.ok(tokCat, "must have a tokens category");
    assert.equal(tokCat.name, "rate_limit_tokens");
    assert.equal(tokCat.current.remaining, 999000, "exact provider remaining");
    assert.equal(tokCat.current.used, undefined, "used omitted (would be inferred)");
    assert.equal(tokCat.current.limit, undefined, "limit explicitly unknown");

    // Caveat warning
    assert.ok(result.warnings && result.warnings.length > 0, "must include rate-limit caveat");
  });

  it("publishes exact remaining with an unknown limit when remaining RPM exceeds the Free ceiling (#49)", async () => {
    // Remaining 4500 RPM / 95M TPM proves the account is above the Free
    // tier, but no single tier is proven — the limit stays unknown (#49).
    const fakeFetch = mockQuotaFetch({ remainingRequests: "4500", remainingTokens: "95000000" });
    const adapter = new JinaAdapter(
      { env: { JINA_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );

    const result = await adapter.quota.invoke();
    const reqCat = result.categories.find((c) => c.unit === "requests");
    assert.equal(reqCat.current.remaining, 4500, "exact provider remaining");
    assert.equal(reqCat.current.limit, undefined, "limit explicitly unknown (#49)");
    assert.equal(reqCat.current.used, undefined, "used omitted (would be inferred)");

    const tokCat = result.categories.find((c) => c.unit === "tokens");
    assert.equal(tokCat.current.remaining, 95_000_000, "exact provider remaining");
    assert.equal(tokCat.current.limit, undefined, "limit explicitly unknown (#49)");
  });

  it("does not misreport a high-tier account's low remaining against a smaller tier (#49)", async () => {
    // A Tier 2 account that has used most of its 5000 RPM window shows
    // remaining < 500. The old inference reported it against the Free
    // 500 limit (and 95M TPM against 100M) — overstating capacity. The
    // #49 contract keeps the limit unknown instead of guessing.
    const fakeFetch = mockQuotaFetch({ remainingRequests: "400", remainingTokens: "95000000" });
    const adapter = new JinaAdapter(
      { env: { JINA_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );

    const result = await adapter.quota.invoke();
    // RPM: limit unknown — never pinned to the Free 500 ceiling.
    const reqCat = result.categories.find((c) => c.unit === "requests");
    assert.equal(reqCat.current.remaining, 400, "exact provider remaining");
    assert.equal(reqCat.current.limit, undefined, "limit explicitly unknown (#49)");
    assert.equal(reqCat.current.used, undefined, "used omitted (would be inferred)");

    // TPM: limit unknown — the two headers no longer infer independently.
    const tokCat = result.categories.find((c) => c.unit === "tokens");
    assert.equal(tokCat.current.remaining, 95_000_000, "exact provider remaining");
    assert.equal(tokCat.current.limit, undefined, "limit explicitly unknown (#49)");
  });

  it("publishes exact TPM remaining between tier ceilings without picking a tier (#49)", async () => {
    // Remaining 8M TPM sits between the Free 1M and Tier 1 10M ceilings;
    // no tier is proven, so the limit stays unknown (#49).
    const fakeFetch = mockQuotaFetch({ remainingRequests: "200", remainingTokens: "8000000" });
    const adapter = new JinaAdapter(
      { env: { JINA_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );

    const result = await adapter.quota.invoke();
    const tokCat = result.categories.find((c) => c.unit === "tokens");
    assert.equal(tokCat.current.remaining, 8_000_000, "exact provider remaining");
    assert.equal(tokCat.current.limit, undefined, "limit explicitly unknown (#49)");
    assert.equal(tokCat.current.used, undefined, "used omitted (would be inferred)");
  });

  it("fails with QUOTA_ERROR when no rate-limit headers present", async () => {
    const fakeFetch = mockQuotaFetch({ remainingRequests: null, remainingTokens: null });
    const adapter = new JinaAdapter(
      { env: { JINA_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );

    await assert.rejects(
      () => adapter.quota.invoke(),
      (err) => err instanceof ScoutlineError && err.code === "QUOTA_ERROR",
    );
  });

  it("throws ConfigurationError without JINA_API_KEY", async () => {
    const fakeFetch = mockQuotaFetch();
    const adapter = new JinaAdapter(
      { env: {} },
      { transport: { fetch: fakeFetch } },
    );

    await assert.rejects(
      () => adapter.quota.invoke(),
      (err) => err instanceof ConfigurationError,
    );
  });

  it("quota probe sends Authorization header", async () => {
    let sentHeaders = null;
    const fakeFetch = async (url, init) => {
      sentHeaders = init?.headers;
      return {
        ok: true,
        status: 200,
        headers: { get: (name) => name.toLowerCase() === "x-ratelimit-remaining-requests" ? "499" : null },
        text: async () => JSON.stringify({ data: [] }),
      };
    };
    const adapter = new JinaAdapter(
      { env: { JINA_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );

    await adapter.quota.invoke();
    assert.equal(sentHeaders.Authorization, `Bearer ${TEST_KEY}`);
  });

  it("publishes an explicitly unknown RPM limit for a Tier-2-shaped remaining below the Free boundary (#49)", async () => {
    const fakeFetch = mockQuotaFetch({ remainingRequests: "499", remainingTokens: null });
    const adapter = new JinaAdapter(
      { env: { JINA_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );

    const result = await adapter.quota.invoke();
    const reqCat = result.categories.find((c) => c.name === "rate_limit_requests");
    assert.ok(reqCat, "requests category present");
    assert.ok(
      reqCat.current.limit === null || reqCat.current.limit === undefined,
      `limit must be explicitly unknown, got ${reqCat.current.limit}`,
    );
    assert.equal(reqCat.current.remaining, 499, "exact provider remaining");
    assert.equal(reqCat.current.used, undefined, "used omitted when it would be inferred");
  });

  it("publishes an explicitly unknown TPM limit for a Tier-2-shaped remaining below the Free boundary (#49)", async () => {
    const fakeFetch = mockQuotaFetch({ remainingRequests: null, remainingTokens: "950000" });
    const adapter = new JinaAdapter(
      { env: { JINA_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );

    const result = await adapter.quota.invoke();
    const tokCat = result.categories.find((c) => c.name === "rate_limit_tokens");
    assert.ok(tokCat, "tokens category present");
    assert.ok(
      tokCat.current.limit === null || tokCat.current.limit === undefined,
      `limit must be explicitly unknown, got ${tokCat.current.limit}`,
    );
    assert.equal(tokCat.current.remaining, 950000, "exact provider remaining");
    assert.equal(tokCat.current.used, undefined, "used omitted when it would be inferred");
  });

  it("does not report TPM against the Free-tier limit when the RPM header proves Tier 2 (#49)", async () => {
    const fakeFetch = mockQuotaFetch({ remainingRequests: "4500", remainingTokens: "950000" });
    const adapter = new JinaAdapter(
      { env: { JINA_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );

    const result = await adapter.quota.invoke();
    const tokCat = result.categories.find((c) => c.name === "rate_limit_tokens");
    assert.ok(tokCat, "tokens category present");
    assert.ok(
      tokCat.current.limit === null || tokCat.current.limit === undefined,
      `limit must be explicitly unknown, got ${tokCat.current.limit}`,
    );
    assert.equal(tokCat.current.remaining, 950000, "exact provider remaining");
  });

  it("passes a typed transport error through quota invocation verbatim (#49 pin)", async () => {
    const authError = new AuthError("jina transport rejected credentials");
    const fakeFetch = async () => {
      throw authError;
    };
    const adapter = new JinaAdapter(
      { env: { JINA_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );

    await assert.rejects(
      () => adapter.quota.invoke(),
      (err) => err === authError,
    );
  });

  it("surfaces an untyped transport failure from quota as NetworkError with the probe message (#49 pin)", async () => {
    const fakeFetch = async () => {
      throw new Error("socket exploded");
    };
    const adapter = new JinaAdapter(
      { env: { JINA_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );

    await assert.rejects(
      () => adapter.quota.invoke(),
      (err) =>
        err instanceof NetworkError &&
        err.message.includes("Jina AI rate-limit probe failed") &&
        err.message.includes("socket exploded"),
    );
  });
});
