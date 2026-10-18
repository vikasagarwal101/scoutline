import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getProviderDescriptor } from "../dist/providers/registry.js";
import { createDeepSeekDescriptor } from "../dist/providers/deepseek/adapter.js";
import { MAX_BUFFERED_RESPONSE_BYTES } from "../dist/lib/bounded-body.js";
import { NetworkError } from "../dist/lib/errors.js";

describe("DeepSeek provider", () => {
  it("is selectable with its credential and advertises search, reader, and diagnostics", () => {
    let descriptor;
    assert.doesNotThrow(() => { descriptor = getProviderDescriptor("deepseek"); });
    assert.deepEqual([...descriptor.capabilities()], ["search", "reader", "diagnostics"]);
    assert.equal(descriptor.isConfigured({}), false);
    assert.equal(descriptor.isConfigured({ DEEPSEEK_API_KEY: "   " }), false);
    assert.equal(descriptor.isConfigured({ DEEPSEEK_API_KEY: " key " }), true);
    assert.deepEqual(descriptor.credentialEnvVars, ["DEEPSEEK_API_KEY"]);
  });

  it("search sends bearer-authenticated JSON and returns provider-neutral sources", async () => {
    const calls = [];
    const descriptor = createDeepSeekDescriptor({ transport: { fetch: async (url, init) => {
      calls.push({ url, ...init });
      return Response.json({ results: [{
        title: "Title", url: "https://example.test/a", summary: "Long summary", snippet: "Short",
        content: "", site_name: "Example", site_icon: null, date: "2026-10-17T00:00:00Z",
        rerank_score: 2.4, authority: 3,
      }] });
    } } });
    const adapter = descriptor.create({ env: { DEEPSEEK_API_KEY: " key " } });
    assert.equal(calls.length, 0, "creation must not perform I/O");
    assert.ok(adapter.search, "search handle is required");
    const request = { query: " release ", controls: { domain: "example.test", topic: "news" } };
    const identity = adapter.search.cacheIdentity(request, { count: 5 });
    const rows = await adapter.search.invoke(request, undefined, 5);
    assert.deepEqual(rows, [{ title: "Title", url: "https://example.test/a", summary: "Long summary",
      source: "Example", date: "2026-10-17T00:00:00Z" }]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.deepseek.com/v1/tools/search");
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].headers.Authorization, "Bearer key");
    assert.equal(calls[0].headers["Content-Type"], "application/json");
    assert.equal(calls[0].redirect, "error");
    assert.deepEqual(JSON.parse(calls[0].body), {
      query: "site:example.test release latest news", count: 5, need_content: false,
    });
    assert.deepEqual(identity.request, JSON.parse(calls[0].body));
    assert.match(identity.credentialFingerprint, /^[a-f0-9]{64}$/);
  });

  it("validates the final Unicode query and rejects unsupported controls before credentials or I/O", async () => {
    let calls = 0;
    const search = createDeepSeekDescriptor({ transport: { fetch: async () => {
      calls++; throw new Error("must not fetch");
    } } }).create({ env: {} }).search;
    for (const request of [{ query: " " }, { query: "😀".repeat(129) },
      { query: "x".repeat(128), controls: { topic: "news" } },
      { query: "x".repeat(120), controls: { domain: "example.test" } }]) {
      assert.throws(() => search.validate(request), { code: "VALIDATION_ERROR" });
      await assert.rejects(search.invoke(request), { code: "VALIDATION_ERROR" });
    }
    assert.doesNotThrow(() => search.validate({ query: "😀".repeat(128) }));
    for (const [option, value] of [["location", "us"], ["type", "video"], ["contentSize", "high"]]) {
      const request = { query: "q", controls: { [option]: value } };
      assert.throws(() => search.validate(request), { code: "UNSUPPORTED_OPTION", option });
      await assert.rejects(search.invoke(request), { code: "UNSUPPORTED_OPTION", option });
    }
    assert.equal(calls, 0);
  });

  it("keys the resolved wire count and date cutoff, preserving the cutoff across midnight and retries", async () => {
    let instant = new Date("2026-10-18T23:59:59Z");
    const bodies = [];
    const search = createDeepSeekDescriptor({ now: () => instant, transport: { fetch: async (_url, init) => {
      bodies.push(JSON.parse(init.body)); return Response.json({ results: [] });
    } } }).create({ env: { DEEPSEEK_API_KEY: "k" } }).search;
    const request = { query: "q", controls: { recency: "oneWeek" } };
    const first = search.cacheIdentity(request, { count: 100 });
    assert.deepEqual(first.request, { query: "q after:2026-10-11", count: 50, need_content: false });
    instant = new Date("2026-10-19T00:00:01Z");
    await search.invoke(request, undefined, 100);
    await search.invoke(request, undefined, 100);
    assert.deepEqual(bodies, [first.request, first.request]);
    const next = search.cacheIdentity(request, { count: 100 });
    assert.equal(next.request.query, "q after:2026-10-12");
    assert.notDeepEqual(first.request, next.request);
    for (const [recency, date] of [["oneDay", "2026-10-18"], ["oneMonth", "2026-09-19"], ["oneYear", "2025-10-19"]]) {
      assert.equal(search.cacheIdentity({ query: "q", controls: { recency } }).request.query, `q after:${date}`);
    }
    assert.equal(search.cacheIdentity({ query: "q", controls: { recency: "noLimit" } }).request.query, "q");
    const plain = { query: "q" };
    assert.deepEqual(search.cacheIdentity(plain).request, search.cacheIdentity(plain, { count: 10 }).request);
    assert.equal(search.cacheIdentity(plain, { count: 0 }).request.count, 10);
    assert.notDeepEqual(search.cacheIdentity(plain, { count: 1 }).request, search.cacheIdentity(plain, { count: 5 }).request);
    assert.throws(() => search.validate({ query: "x".repeat(120), controls: { recency: "oneDay" } }), { code: "VALIDATION_ERROR" });
  });

  it("rejects unknown and inherited recency values before credentials or transport", async () => {
    let calls = 0;
    const search = createDeepSeekDescriptor({ transport: { fetch: async () => {
      calls++; throw new Error("must not fetch");
    } } }).create({ env: {} }).search;
    for (const recency of ["fortnight", "toString", "__proto__", "", null, false]) {
      const request = { query: "q", controls: { recency } };
      assert.throws(() => search.validate(request), { code: "VALIDATION_ERROR" });
      assert.throws(() => search.cacheIdentity(request), { code: "VALIDATION_ERROR" });
      await assert.rejects(search.invoke(request), { code: "VALIDATION_ERROR" });
    }
    assert.equal(calls, 0);
  });

  it("reads Markdown through Fetch and decodes cached reader envelopes", async () => {
    const calls = [];
    const adapter = createDeepSeekDescriptor({ transport: { fetch: async (url, init) => {
      calls.push({ url, ...init }); return Response.json({ title: "Page", content: "# Page\n\nText" });
    } } }).create({ env: { DEEPSEEK_API_KEY: "key" } });
    assert.ok(adapter.reader?.fetch, "reader handle is required");
    const reader = adapter.reader.fetch;
    const request = { url: "https://example.test/page", format: "markdown", retainImages: true,
      withLinksSummary: false, noGfm: false, keepImgDataUrl: false, withImagesSummary: false };
    reader.validate(request);
    const identity = reader.cacheIdentity(request);
    const result = await reader.invoke(request);
    assert.deepEqual(result, { schemaVersion: 1, url: request.url, finalUrl: request.url,
      title: "Page", content: "# Page\n\nText", contentFormat: "markdown" });
    assert.equal(calls[0].url, "https://api.deepseek.com/v1/tools/fetch");
    assert.deepEqual(JSON.parse(calls[0].body), { url: request.url });
    assert.deepEqual(reader.decodeCached(result), result);
    assert.equal(reader.decodeCached({ ...result, content: 5 }), null);
    assert.equal(identity.operation, "reader-fetch");
    assert.deepEqual(identity.legacyCandidates, []);
  });

  it("rejects invalid Fetch URLs and unsupported reader options before credentials", async () => {
    const reader = createDeepSeekDescriptor().create({ env: {} }).reader.fetch;
    for (const url of ["file:///tmp/a", "https://user:pass@example.test", "https://", "https://example.test/" + "x".repeat(8192)]) {
      assert.throws(() => reader.validate({ url }), { code: "VALIDATION_ERROR" });
      await assert.rejects(reader.invoke({ url }), { code: "VALIDATION_ERROR" });
    }
    const url = "https://example.test/";
    assert.doesNotThrow(() => reader.validate({ url: url + "x".repeat(8192 - url.length) }));
    for (const [option, value] of [["format", "text"], ["retainImages", false], ["withLinksSummary", true],
      ["noGfm", true], ["keepImgDataUrl", true], ["withImagesSummary", true], ["renderJs", true], ["renderJs", false]]) {
      const request = { url, [option]: value };
      assert.throws(() => reader.validate(request), { code: "UNSUPPORTED_OPTION", option });
      await assert.rejects(reader.invoke(request), { code: "UNSUPPORTED_OPTION", option });
    }
  });

  it("fails closed on malformed provider responses and accepts genuine empty searches", async () => {
    const env = { DEEPSEEK_API_KEY: "k" };
    for (const payload of [null, [], {}, { results: {} }, { results: [null] },
      { results: [{ title: "T", url: 42, summary: "S" }] },
      { results: [{ title: "T", url: "https://example.test", summary: {} }] }]) {
      const adapter = createDeepSeekDescriptor({ transport: { fetch: async () => Response.json(payload) } }).create({ env });
      await assert.rejects(adapter.search.invoke({ query: "q" }), { code: "API_ERROR", statusCode: 502 });
    }
    const empty = createDeepSeekDescriptor({ transport: { fetch: async () => Response.json({ results: [] }) } }).create({ env });
    assert.deepEqual(await empty.search.invoke({ query: "q" }), []);
    for (const payload of [null, {}, { title: 5, content: "text" }, { title: "T", content: "" }, { title: "T", content: {} }]) {
      const adapter = createDeepSeekDescriptor({ transport: { fetch: async () => Response.json(payload) } }).create({ env });
      await assert.rejects(adapter.reader.fetch.invoke({ url: "https://example.test" }), { code: "API_ERROR", statusCode: 502 });
    }
    const blank = createDeepSeekDescriptor({ transport: { fetch: async () => Response.json({ title: " ", content: "text" }) } }).create({ env });
    assert.equal((await blank.reader.fetch.invoke({ url: "https://example.test" })).title, null);
  });

  it("maps HTTP failures without leaking bodies and never retries inside the adapter", async () => {
    for (const [status, code] of [[400, "API_ERROR"], [401, "AUTH_ERROR"], [402, "QUOTA_ERROR"],
      [403, "API_ERROR"], [404, "API_ERROR"], [408, "TIMEOUT_ERROR"], [429, "API_ERROR"],
      [500, "API_ERROR"], [504, "TIMEOUT_ERROR"]]) {
      let calls = 0;
      let cancelled = false;
      const search = createDeepSeekDescriptor({ transport: { fetch: async () => {
        calls++;
        return new Response(new ReadableStream({ cancel() { cancelled = true; } }),
          { status, headers: { "Retry-After": "2" } });
      } } }).create({ env: { DEEPSEEK_API_KEY: "secret123" } }).search;
      await assert.rejects(search.invoke({ query: "q" }), (error) => {
        assert.equal(error.code, code, `HTTP ${status}`);
        if (code === "API_ERROR") assert.equal(error.statusCode, status);
        if (status === 429) assert.equal(error.retryAfterMs, 2000);
        if (status === 402) assert.equal(error.retryable, false);
        assert.ok(!error.message.includes("secret123"));
        return true;
      });
      assert.equal(calls, 1);
      assert.equal(cancelled, true);
    }
    const broken = createDeepSeekDescriptor({ transport: { fetch: async () => { throw new Error("secret123"); } } })
      .create({ env: { DEEPSEEK_API_KEY: "secret123" } }).search;
    await assert.rejects(broken.invoke({ query: "q" }), { code: "NETWORK_ERROR", message: "DeepSeek network error" });
  });

  it("honors injected timeout budgets through body consumption and rejects pre-aborted work without dispatch", async () => {
    const delays = [];
    const cleared = [];
    let calls = 0;
    const descriptor = createDeepSeekDescriptor({ transport: {
      setTimeout: (_cb, ms) => { delays.push(ms); return 1; }, clearTimeout: (id) => cleared.push(id),
      fetch: async () => { calls++; return Response.json({ title: "Page", content: "text", results: [] }); },
    } });
    const adapter = descriptor.create({ env: { DEEPSEEK_API_KEY: "k", DEEPSEEK_TIMEOUT: "1234" } });
    await adapter.search.invoke({ query: "q" });
    await adapter.reader.fetch.invoke({ url: "https://example.test", timeout: 2 });
    assert.deepEqual(delays, [1234, 2000]);
    assert.deepEqual(cleared, [1, 1]);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(adapter.search.invoke({ query: "q" }, controller.signal), { code: "TIMEOUT_ERROR" });
    await assert.rejects(adapter.reader.fetch.invoke({ url: "https://example.test" }, controller.signal), { code: "TIMEOUT_ERROR" });
    assert.equal(calls, 2);
  });

  it("performs exactly one small diagnostic search only when probing is requested", async () => {
    const bodies = [];
    const adapter = createDeepSeekDescriptor({ transport: { fetch: async (_url, init) => {
      bodies.push(JSON.parse(init.body)); return Response.json({ results: [] });
    } } }).create({ env: { DEEPSEEK_API_KEY: "k" } });
    assert.ok(adapter.diagnostics, "diagnostics handle is required");
    await adapter.diagnostics.invoke({ probe: false });
    assert.equal(bodies.length, 0);
    await adapter.diagnostics.invoke({ probe: true });
    assert.deepEqual(bodies, [{ query: "scoutline-doctor-probe", count: 1, need_content: false }]);
  });

  it("cancels stalled headers and body reads on deadline or caller abort, including late responses", async () => {
    for (const phase of ["headers", "body", "caller"]) {
      let fireDeadline, resolveHeaders;
      let cancelled = false;
      let cleared = false;
      const response = () => new Response(new ReadableStream({ cancel() { cancelled = true; } }));
      const controller = new AbortController();
      const search = createDeepSeekDescriptor({ transport: {
        env: { DEEPSEEK_TIMEOUT: "23" },
        setTimeout: (cb) => { fireDeadline = cb; return 1; }, clearTimeout: () => { cleared = true; },
        fetch: async () => phase === "headers" ? new Promise((resolve) => { resolveHeaders = resolve; }) : response(),
      } }).create({ env: { DEEPSEEK_API_KEY: "k" } }).search;
      const pending = search.invoke({ query: "q" }, controller.signal);
      const rejected = assert.rejects(pending, { code: "TIMEOUT_ERROR", durationMs: phase === "caller" ? 0 : 23 });
      await new Promise(setImmediate);
      if (phase === "caller") controller.abort(); else fireDeadline();
      await rejected;
      if (phase === "headers") resolveHeaders(response());
      await new Promise(setImmediate);
      assert.equal(cancelled, true, phase);
      assert.equal(cleared, true, phase);
    }
  });

  it("rejects oversized declared or chunked bodies incrementally and sanitizes malformed JSON", async () => {
    for (const declared of [true, false]) {
      let pulls = 0, cancelled = false;
      const stream = new ReadableStream({
        pull(controller) { pulls++; controller.enqueue(new Uint8Array(MAX_BUFFERED_RESPONSE_BYTES / 2 + 1)); },
        cancel() { cancelled = true; },
      }, { highWaterMark: 0 });
      const adapter = createDeepSeekDescriptor({ transport: { fetch: async () => new Response(stream,
        { headers: { "Content-Length": declared ? String(MAX_BUFFERED_RESPONSE_BYTES + 1) : "1" } }) } })
        .create({ env: { DEEPSEEK_API_KEY: "k" } });
      await assert.rejects(adapter.search.invoke({ query: "q" }), { code: "API_ERROR", statusCode: undefined });
      await new Promise(setImmediate);
      assert.equal(cancelled, true);
      if (declared) assert.equal(pulls, 0); else assert.ok(pulls <= 3, `read too far: ${pulls} chunks`);
    }
    const adapter = createDeepSeekDescriptor({ transport: { fetch: async () => new Response("secret123 invalid JSON") } })
      .create({ env: { DEEPSEEK_API_KEY: "secret123" } });
    await assert.rejects(adapter.search.invoke({ query: "q" }), {
      code: "API_ERROR", statusCode: 502, message: "DeepSeek returned malformed JSON",
    });
  });

  it("sanitizes typed fetch and body-stream failures too", async () => {
    for (const phase of ["fetch", "body"]) {
      const adapter = createDeepSeekDescriptor({ transport: { fetch: async () => {
        if (phase === "fetch") throw new NetworkError("secret123");
        return new Response(new ReadableStream({ start(controller) { controller.error(new NetworkError("secret123")); } }));
      } } }).create({ env: { DEEPSEEK_API_KEY: "secret123" } });
      await assert.rejects(adapter.search.invoke({ query: "q" }), {
        code: "NETWORK_ERROR", message: "DeepSeek network error",
      });
    }
  });
});
