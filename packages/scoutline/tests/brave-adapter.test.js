/**
 * Brave Provider foundation tests (T1, brave-tech-plan §2, §5, §6).
 *
 * Verifies the Brave direct-HTTP transport skeleton:
 *   - Credentials: resolveBraveApiKey (present / whitespace-only / non-string);
 *     requireBraveApiKey throws ConfigurationError (exit 3) when missing;
 *     isBraveConfigured true/false.
 *   - Client getBraveJson: success → parsed JSON; request carries
 *     X-Subscription-Token + User-Agent + query string; timeout → TimeoutError;
 *     401/403 → AuthError; 429 → ApiError(429); 5xx → ApiError;
 *     NO raw Brave body leaks into thrown error messages.
 *   - Descriptor: id === "brave"; capabilities() advertises exactly
 *     "search" (T2); create({env:{}}) returns an adapter with a wired
 *     `search` object (other slots undefined); create() constructs no
 *     transport (injected spy fetch is never called).
 *   - Search Capability (T2): web invoke normalizes web.results[];
 *     --topic news routes to /res/v1/news/search; controls mapped per
 *     the Brave mapping; contentSize rejected before fetch; missing key
 *     → ConfigurationError (exit 3); malformed → ApiError 500; no raw
 *     Brave body leaks into error messages.
 *
 * Tests inject a single fake `fetch` through
 * `BraveAdapterDependencies.transport`; the fake returns Response-shaped
 * objects (ok/status/json/text/headers/arrayBuffer). No real network is
 * touched.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createBraveDescriptor } from "../dist/providers/brave/adapter.js";
import {
  resolveBraveApiKey,
  requireBraveApiKey,
  isBraveConfigured,
} from "../dist/providers/brave/credentials.js";
import { getBraveJson } from "../dist/providers/brave/client.js";
import {
  ApiError,
  AuthError,
  ConfigurationError,
  TimeoutError,
  UnsupportedOptionError,
} from "../dist/lib/errors.js";

const TEST_API_KEY = "brave-test-key-DO-NOT-LEAK";

// ---------------------------------------------------------------------------
// Fake fetch helpers
// ---------------------------------------------------------------------------

function makeResponse({ ok = true, status = 200, json, body = "", headers = {} } = {}) {
  return {
    ok,
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    json: async () => json,
    headers: { get: (name) => headers[name] ?? null },
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

function makeErrorFetch(status, body) {
  return async () =>
    makeResponse({
      ok: false,
      status,
      body: body ?? '{"error":"upstream message that must not leak"}',
    });
}

function makeRecordingFetch(impl) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    return impl(url, init);
  };
  return { fn, calls };
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

describe("Brave credentials", () => {
  it("resolveBraveApiKey returns undefined when env is empty", () => {
    assert.strictEqual(resolveBraveApiKey({}), undefined);
  });

  it("resolveBraveApiKey returns undefined for whitespace-only values", () => {
    assert.strictEqual(resolveBraveApiKey({ BRAVE_SEARCH_API_KEY: "   " }), undefined);
    assert.strictEqual(resolveBraveApiKey({ BRAVE_SEARCH_API_KEY: "\t\n" }), undefined);
  });

  it("resolveBraveApiKey returns undefined for non-string values", () => {
    assert.strictEqual(resolveBraveApiKey({ BRAVE_SEARCH_API_KEY: 0 }), undefined);
    assert.strictEqual(resolveBraveApiKey({ BRAVE_SEARCH_API_KEY: null }), undefined);
    assert.strictEqual(resolveBraveApiKey({ BRAVE_SEARCH_API_KEY: undefined }), undefined);
  });

  it("resolveBraveApiKey returns the raw value when present", () => {
    assert.strictEqual(resolveBraveApiKey({ BRAVE_SEARCH_API_KEY: "  sk-abc  " }), "  sk-abc  ");
  });

  it("requireBraveApiKey throws ConfigurationError (exit 3) when missing", () => {
    let thrown;
    try {
      requireBraveApiKey({});
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof ConfigurationError, "must be ConfigurationError");
    assert.strictEqual(thrown.exitCode, 3, "must use exit code 3");
    assert.ok(
      typeof thrown.message === "string" && thrown.message.includes("BRAVE_SEARCH_API_KEY"),
      "message must name the env var",
    );
    assert.ok(
      thrown.help && /BRAVE_SEARCH_API_KEY/.test(thrown.help),
      "help must include an export hint",
    );
  });

  it("requireBraveApiKey returns the resolved key when present", () => {
    assert.strictEqual(requireBraveApiKey({ BRAVE_SEARCH_API_KEY: TEST_API_KEY }), TEST_API_KEY);
  });

  it("isBraveConfigured reflects non-blank presence", () => {
    assert.strictEqual(isBraveConfigured({}), false);
    assert.strictEqual(isBraveConfigured({ BRAVE_SEARCH_API_KEY: "  " }), false);
    assert.strictEqual(isBraveConfigured({ BRAVE_SEARCH_API_KEY: TEST_API_KEY }), true);
  });
});

// ---------------------------------------------------------------------------
// getBraveJson — transport
// ---------------------------------------------------------------------------

describe("Brave client getBraveJson", () => {
  it("returns parsed JSON on a 2xx response", async () => {
    const payload = { results: [{ title: "ok" }] };
    const { fn, calls } = makeRecordingFetch(async () => makeResponse({ json: payload }));
    const out = await getBraveJson(TEST_API_KEY, "/res/v1/web/search", { q: "hi" }, { fetch: fn });
    assert.deepStrictEqual(out, payload);
    assert.strictEqual(calls.length, 1);
  });

  it("sends X-Subscription-Token, Accept: application/json, and the User-Agent", async () => {
    const { fn, calls } = makeRecordingFetch(async () => makeResponse({ json: {} }));
    await getBraveJson(TEST_API_KEY, "/res/v1/web/search", { q: "hi" }, { fetch: fn });
    const headers = calls[0].init.headers;
    assert.strictEqual(headers["X-Subscription-Token"], TEST_API_KEY);
    assert.strictEqual(headers.Accept, "application/json");
    assert.ok(
      typeof headers["User-Agent"] === "string" && headers["User-Agent"].startsWith("scoutline/"),
      "User-Agent must carry the scoutline version prefix",
    );
  });

  it("builds the query string with URL-encoded params", async () => {
    const { fn, calls } = makeRecordingFetch(async () => makeResponse({ json: {} }));
    await getBraveJson(
      TEST_API_KEY,
      "/res/v1/web/search",
      { q: "hello world", count: 5 },
      { fetch: fn },
    );
    const url = calls[0].url;
    assert.ok(url.startsWith("https://api.search.brave.com/res/v1/web/search?"), url);
    assert.ok(url.includes("q=hello%20world") || url.includes("q=hello+world"), url);
    assert.ok(/count=5/.test(url), url);
  });

  it("uses the X-Subscription-Token header (NOT Authorization: Bearer)", async () => {
    const { fn, calls } = makeRecordingFetch(async () => makeResponse({ json: {} }));
    await getBraveJson(TEST_API_KEY, "/res/v1/web/search", { q: "hi" }, { fetch: fn });
    const headers = calls[0].init.headers;
    assert.strictEqual(headers.Authorization, undefined, "must not send Authorization header");
  });

  it("throws TimeoutError when the AbortController fires", async () => {
    // Real fetch throws an AbortError when its AbortSignal fires; the
    // fake mirrors that by listening for `signal.aborted` and throwing
    // an AbortError, which the transport's `normalizeTransportError`
    // then maps to TimeoutError (with the configured duration).
    const fn = async (_url, init) => {
      return new Promise((_resolve, reject) => {
        const signal = init && init.signal;
        if (!signal) {
          reject(new Error("missing signal"));
          return;
        }
        if (signal.aborted) {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
          return;
        }
        signal.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    };
    // Inject setTimeout to fire the abort immediately.
    const fakeSet = (fnToCall) => {
      fnToCall();
      return 0;
    };
    const fakeClear = () => {};
    const err = await getBraveJson(
      TEST_API_KEY,
      "/res/v1/web/search",
      { q: "hi" },
      { fetch: fn, setTimeout: fakeSet, clearTimeout: fakeClear, env: { BRAVE_TIMEOUT: "5000" } },
    ).then(
      () => null,
      (e) => e,
    );
    assert.ok(err instanceof TimeoutError, "must be TimeoutError");
    assert.strictEqual(err.durationMs, 5000);
  });

  it("maps 401 to AuthError with the BRAVE_SEARCH_API_KEY help hint", async () => {
    const { fn } = makeRecordingFetch(makeErrorFetch(401));
    const err = await getBraveJson(TEST_API_KEY, "/res/v1/x", { q: "hi" }, { fetch: fn }).then(
      () => null,
      (e) => e,
    );
    assert.ok(err instanceof AuthError, "must be AuthError");
    assert.ok(err.help && /BRAVE_SEARCH_API_KEY/.test(err.help), "help must name the env var");
  });

  it("maps 403 to AuthError", async () => {
    const { fn } = makeRecordingFetch(makeErrorFetch(403));
    const err = await getBraveJson(TEST_API_KEY, "/res/v1/x", { q: "hi" }, { fetch: fn }).then(
      () => null,
      (e) => e,
    );
    assert.ok(err instanceof AuthError);
  });

  it("maps 429 to ApiError(429)", async () => {
    const { fn } = makeRecordingFetch(makeErrorFetch(429));
    const err = await getBraveJson(TEST_API_KEY, "/res/v1/x", { q: "hi" }, { fetch: fn }).then(
      () => null,
      (e) => e,
    );
    assert.ok(err instanceof ApiError && err.statusCode === 429, "must be ApiError 429");
  });

  it("maps 5xx to ApiError with the real status", async () => {
    const { fn } = makeRecordingFetch(makeErrorFetch(500));
    const err = await getBraveJson(TEST_API_KEY, "/res/v1/x", { q: "hi" }, { fetch: fn }).then(
      () => null,
      (e) => e,
    );
    assert.ok(err instanceof ApiError && err.statusCode === 500);
  });

  it("does NOT leak the raw Brave body into the thrown error message", async () => {
    const bodyText = "leak-marker-DO-NOT-EMBED-this-string-into-errors";
    const { fn } = makeRecordingFetch(makeErrorFetch(500, bodyText));
    const err = await getBraveJson(TEST_API_KEY, "/res/v1/x", { q: "hi" }, { fetch: fn }).then(
      () => null,
      (e) => e,
    );
    assert.ok(err instanceof Error, "must throw");
    assert.ok(
      !err.message.includes(bodyText),
      `error message must not contain raw Brave body: ${err.message}`,
    );
    if (err.help) {
      assert.ok(!err.help.includes(bodyText), "error help must not contain raw Brave body");
    }
  });

  it("maps fetch network failure to NetworkError", async () => {
    const { fn } = makeRecordingFetch(async () => {
      throw new Error("fetch failed: ECONNREFUSED");
    });
    const err = await getBraveJson(TEST_API_KEY, "/res/v1/x", { q: "hi" }, { fetch: fn }).then(
      () => null,
      (e) => e,
    );
    assert.ok(err && err.constructor.name === "NetworkError", "must be NetworkError");
    assert.strictEqual(err.message, "Brave network error");
  });
});

// ---------------------------------------------------------------------------
// Descriptor
// ---------------------------------------------------------------------------

describe("Brave descriptor", () => {
  it("id is brave", () => {
    const descriptor = createBraveDescriptor();
    assert.strictEqual(descriptor.id, "brave");
  });

  it("capabilities() advertises exactly search (T2)", () => {
    const descriptor = createBraveDescriptor();
    const caps = descriptor.capabilities();
    assert.ok(caps instanceof Set, "must be a Set");
    assert.strictEqual(caps.size, 1, "T2 advertises only search");
    assert.ok(caps.has("search"), "must advertise search");
    assert.ok(!caps.has("quota"), "quota is a later ticket");
    assert.ok(!caps.has("diagnostics"), "diagnostics is a later ticket");
  });

  it("isConfigured reflects BRAVE_SEARCH_API_KEY presence", () => {
    const descriptor = createBraveDescriptor();
    assert.strictEqual(descriptor.isConfigured({}), false);
    assert.strictEqual(descriptor.isConfigured({ BRAVE_SEARCH_API_KEY: "   " }), false);
    assert.strictEqual(descriptor.isConfigured({ BRAVE_SEARCH_API_KEY: TEST_API_KEY }), true);
  });

  it("create() returns { id: 'brave' } with a wired search capability", () => {
    const descriptor = createBraveDescriptor();
    const adapter = descriptor.create({ env: {} });
    assert.strictEqual(adapter.id, "brave");
    assert.strictEqual(typeof adapter.search, "object", "search must be wired in T2");
    assert.ok(adapter.search !== null, "search must not be null");
    // Other capability slots remain undefined (later tickets).
    for (const slot of [
      "reader",
      "quota",
      "diagnostics",
      "crawl",
      "map",
      "research",
      "vision",
      "repository",
    ]) {
      assert.strictEqual(adapter[slot], undefined, `${slot} slot must be undefined in T2`);
    }
  });

  it("create() constructs no transport (injected spy fetch is never called)", () => {
    let calls = 0;
    const descriptor = createBraveDescriptor({
      transport: {
        fetch: async () => {
          calls += 1;
          throw new Error("transport.fetch must not run during create()");
        },
      },
    });
    descriptor.create({ env: {} });
    assert.strictEqual(calls, 0, "transport.fetch must not be invoked during descriptor.create()");
  });
});

// ---------------------------------------------------------------------------
// Search Capability (T2)
// ---------------------------------------------------------------------------

/**
 * Build an adapter whose transport records every fetch URL/init and
 * serves `fetchImpl`. The adapter is bound to an env carrying the test
 * API key so `invoke`/`cacheIdentity` can resolve credentials.
 */
function makeSearchAdapter(fetchImpl) {
  const { fn, calls } = makeRecordingFetch(fetchImpl);
  const descriptor = createBraveDescriptor({ transport: { fetch: fn } });
  const adapter = descriptor.create({ env: { BRAVE_SEARCH_API_KEY: TEST_API_KEY } });
  return { adapter, calls };
}

function emptyWebResponse() {
  return makeResponse({ json: { web: { results: [] } } });
}

describe("Brave Search Capability", () => {
  it("web invoke normalizes web.results[] into SearchSource[] (source + date)", async () => {
    const raw = {
      web: {
        results: [
          {
            title: "Example One",
            url: "https://example.test/one",
            description: "Summary one.",
            meta_url: { netloc: "example.test" },
            page_age: "2025-01-02T00:00:00Z",
          },
          {
            title: "Example Two",
            url: "https://example.test/two",
            description: "Summary two.",
          },
        ],
      },
    };
    const { adapter, calls } = makeSearchAdapter(async () => makeResponse({ json: raw }));
    const out = await adapter.search.invoke({ query: "hello" });
    assert.strictEqual(calls.length, 1);
    assert.ok(
      calls[0].url.startsWith("https://api.search.brave.com/res/v1/web/search?"),
      `web endpoint: ${calls[0].url}`,
    );
    assert.deepStrictEqual(
      [...out],
      [
        {
          title: "Example One",
          url: "https://example.test/one",
          summary: "Summary one.",
          source: "example.test",
          date: "2025-01-02T00:00:00Z",
        },
        { title: "Example Two", url: "https://example.test/two", summary: "Summary two." },
      ],
    );
  });

  it("news result date falls back to `age` when `page_age` is absent", async () => {
    const raw = {
      results: [
        {
          title: "News One",
          url: "https://news.test/one",
          description: "News summary.",
          meta_url: { netloc: "news.test" },
          age: "3 hours ago",
        },
      ],
    };
    const { adapter, calls } = makeSearchAdapter(async () => makeResponse({ json: raw }));
    const out = await adapter.search.invoke({ query: "hello", controls: { topic: "news" } });
    assert.ok(
      calls[0].url.startsWith("https://api.search.brave.com/res/v1/news/search?"),
      `news endpoint: ${calls[0].url}`,
    );
    assert.deepStrictEqual(
      [...out],
      [
        {
          title: "News One",
          url: "https://news.test/one",
          summary: "News summary.",
          source: "news.test",
          date: "3 hours ago",
        },
      ],
    );
  });

  it("maps recency oneWeek to freshness=pw", async () => {
    const { adapter, calls } = makeSearchAdapter(emptyWebResponse);
    await adapter.search.invoke({ query: "q", controls: { recency: "oneWeek" } });
    assert.ok(/freshness=pw/.test(calls[0].url), calls[0].url);
  });

  it("maps location us to country=US", async () => {
    const { adapter, calls } = makeSearchAdapter(emptyWebResponse);
    await adapter.search.invoke({ query: "q", controls: { location: "us" } });
    assert.ok(/country=US/.test(calls[0].url), calls[0].url);
  });

  it("maps location cn to country=CN", async () => {
    const { adapter, calls } = makeSearchAdapter(emptyWebResponse);
    await adapter.search.invoke({ query: "q", controls: { location: "cn" } });
    assert.ok(/country=CN/.test(calls[0].url), calls[0].url);
  });

  it("appends site:<domain> to the query for --domain", async () => {
    const { adapter, calls } = makeSearchAdapter(emptyWebResponse);
    await adapter.search.invoke({ query: "rust async", controls: { domain: "example.com" } });
    assert.ok(calls[0].url.includes(encodeURIComponent("site:example.com")), calls[0].url);
  });

  it("appends the finance keyword for --topic finance and stays on the web endpoint", async () => {
    const { adapter, calls } = makeSearchAdapter(emptyWebResponse);
    await adapter.search.invoke({ query: "tesla", controls: { topic: "finance" } });
    assert.ok(calls[0].url.includes(encodeURIComponent("tesla financial")), calls[0].url);
    assert.ok(calls[0].url.includes("/res/v1/web/search"), calls[0].url);
  });

  // -------------------------------------------------------------------------
  // T4: --content-size high → LLM Context (grounding.generic[])
  // -------------------------------------------------------------------------

  function llmContextResponse(entries) {
    return async () => makeResponse({ json: { grounding: { generic: entries } } });
  }

  it("contentSize:high routes to /res/v1/llm/context and joins snippets with blank line", async () => {
    const raw = {
      grounding: {
        generic: [
          {
            title: "Passage One",
            url: "https://ctx.test/one",
            snippets: ["First passage.", "Second passage for the same source."],
          },
          {
            title: "Passage Two",
            url: "https://ctx.test/two",
            snippets: ["Solo passage."],
          },
        ],
      },
    };
    const { adapter, calls } = makeSearchAdapter(async () => makeResponse({ json: raw }));
    const out = await adapter.search.invoke({
      query: "deep learning",
      controls: { contentSize: "high" },
    });
    assert.strictEqual(calls.length, 1);
    assert.ok(
      calls[0].url.startsWith("https://api.search.brave.com/res/v1/llm/context?"),
      `llm context endpoint: ${calls[0].url}`,
    );
    assert.deepStrictEqual(
      [...out],
      [
        {
          title: "Passage One",
          url: "https://ctx.test/one",
          summary: "First passage.\n\nSecond passage for the same source.",
        },
        { title: "Passage Two", url: "https://ctx.test/two", summary: "Solo passage." },
      ],
    );
    // LLM Context entries carry no source/date — none synthesized.
    assert.strictEqual(out[0].source, undefined);
    assert.strictEqual(out[0].date, undefined);
  });

  it("high --topic news routes to LLM Context with NO 'latest news' keyword (topic overridden)", async () => {
    const { adapter, calls } = makeSearchAdapter(llmContextResponse([]));
    await adapter.search.invoke({
      query: "tesla",
      controls: { contentSize: "high", topic: "news" },
    });
    assert.ok(
      calls[0].url.startsWith("https://api.search.brave.com/res/v1/llm/context?"),
      `must route to LLM Context, not news: ${calls[0].url}`,
    );
    // The q= must be the plain query — no ` latest news` appended.
    assert.ok(calls[0].url.includes(encodeURIComponent("tesla")), `clean q: ${calls[0].url}`);
    assert.ok(!calls[0].url.includes("news"), `no news keyword on high path: ${calls[0].url}`);
  });

  it("high --topic finance routes to LLM Context with NO 'financial' keyword (topic suppressed)", async () => {
    const { adapter, calls } = makeSearchAdapter(llmContextResponse([]));
    await adapter.search.invoke({
      query: "tesla",
      controls: { contentSize: "high", topic: "finance" },
    });
    assert.ok(
      calls[0].url.startsWith("https://api.search.brave.com/res/v1/llm/context?"),
      `must route to LLM Context, not web: ${calls[0].url}`,
    );
    // The critical M4 correctness rule: no ` financial` appended on high path.
    assert.ok(calls[0].url.includes(encodeURIComponent("tesla")), `clean q: ${calls[0].url}`);
    assert.ok(
      !calls[0].url.includes("financial"),
      `no finance keyword on high path: ${calls[0].url}`,
    );
  });

  it("high --domain example.com applies site: filter but still suppresses the topic keyword", async () => {
    const { adapter, calls } = makeSearchAdapter(llmContextResponse([]));
    await adapter.search.invoke({
      query: "rust async",
      controls: { contentSize: "high", domain: "example.com", topic: "finance" },
    });
    assert.ok(
      calls[0].url.startsWith("https://api.search.brave.com/res/v1/llm/context?"),
      calls[0].url,
    );
    assert.ok(
      calls[0].url.includes(encodeURIComponent("site:example.com")),
      `domain still applied on high path: ${calls[0].url}`,
    );
    assert.ok(
      !calls[0].url.includes("financial"),
      `no finance keyword on high path even with --domain: ${calls[0].url}`,
    );
  });

  it("high sends ONLY q= to LLM Context (no country/freshness/count)", async () => {
    const { adapter, calls } = makeSearchAdapter(llmContextResponse([]));
    await adapter.search.invoke({
      query: "q",
      controls: { contentSize: "high", recency: "oneWeek", location: "us" },
    });
    assert.ok(calls[0].url.includes("/res/v1/llm/context?"), calls[0].url);
    // Only q= should be present — recency/location mapped to country/freshness
    // are NOT forwarded to LLM Context, and count never reaches the adapter.
    assert.ok(/ Freshness=/.test(" " + calls[0].url) === false, calls[0].url);
    assert.ok(!/country=/.test(calls[0].url), `no country on high path: ${calls[0].url}`);
    assert.ok(!/freshness=/.test(calls[0].url), `no freshness on high path: ${calls[0].url}`);
    assert.ok(!/count=/.test(calls[0].url), `no count on high path: ${calls[0].url}`);
  });

  it("contentSize:medium is a no-op depth and stays on the web endpoint", async () => {
    const { adapter, calls } = makeSearchAdapter(emptyWebResponse);
    await adapter.search.invoke({ query: "q", controls: { contentSize: "medium" } });
    assert.ok(
      calls[0].url.startsWith("https://api.search.brave.com/res/v1/web/search?"),
      `medium must NOT route to LLM Context: ${calls[0].url}`,
    );
  });

  it("contentSize high vs medium vs absent produce different cache identities", () => {
    const { adapter } = makeSearchAdapter(emptyWebResponse);
    const high = adapter.search.cacheIdentity({ query: "q", controls: { contentSize: "high" } });
    const medium = adapter.search.cacheIdentity({
      query: "q",
      controls: { contentSize: "medium" },
    });
    const absent = adapter.search.cacheIdentity({ query: "q" });
    assert.notDeepStrictEqual(high.request, medium.request, "high ≠ medium");
    assert.notDeepStrictEqual(high.request, absent.request, "high ≠ absent");
    assert.notDeepStrictEqual(medium.request, absent.request, "medium ≠ absent");
  });

  it("throws ApiError 500 on a malformed LLM Context response (generic not array)", async () => {
    const { adapter } = makeSearchAdapter(async () =>
      makeResponse({ json: { grounding: { generic: "not-an-array" } } }),
    );
    let thrown;
    try {
      await adapter.search.invoke({ query: "q", controls: { contentSize: "high" } });
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof ApiError && thrown.statusCode === 500);
  });

  it("throws ApiError 500 when an LLM Context entry is missing snippets", async () => {
    const raw = { grounding: { generic: [{ title: "t", url: "https://x.test" }] } };
    const { adapter } = makeSearchAdapter(async () => makeResponse({ json: raw }));
    let thrown;
    try {
      await adapter.search.invoke({ query: "q", controls: { contentSize: "high" } });
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof ApiError && thrown.statusCode === 500);
  });

  it("video invoke routes to /res/v1/videos/search and normalizes top-level results[] (extras dropped)", async () => {
    // Video-shaped fixture carries Brave-only fields (duration/views/
    // creator/thumbnail) which the shared entry parser must DROP.
    const raw = {
      results: [
        {
          title: "Cat Video",
          url: "https://video.test/cat",
          description: "A cat plays piano.",
          meta_url: { netloc: "video.test" },
          page_age: "2025-03-04T05:06:07Z",
          duration: "PT4M13S",
          views: 12345,
          creator: "pianocat",
          thumbnail: "https://img.test/cat.jpg",
        },
        {
          title: "Dog Clip",
          url: "https://video.test/dog",
          description: "A dog runs.",
          age: "2 days ago",
          thumbnail: "https://img.test/dog.jpg",
        },
      ],
    };
    const { adapter, calls } = makeSearchAdapter(async () => makeResponse({ json: raw }));
    const out = await adapter.search.invoke({ query: "cats", controls: { type: "video" } });
    assert.strictEqual(calls.length, 1);
    assert.ok(
      calls[0].url.startsWith("https://api.search.brave.com/res/v1/videos/search?"),
      `video endpoint: ${calls[0].url}`,
    );
    assert.deepStrictEqual(
      [...out],
      [
        {
          title: "Cat Video",
          url: "https://video.test/cat",
          summary: "A cat plays piano.",
          source: "video.test",
          date: "2025-03-04T05:06:07Z",
        },
        {
          title: "Dog Clip",
          url: "https://video.test/dog",
          summary: "A dog runs.",
          date: "2 days ago",
        },
      ],
    );
  });

  it("video normalizer reads top-level results[] (NOT web.results[]) and throws 500 on malformed", async () => {
    // A web-shaped body ({ web: { results: [] } }) must NOT be valid
    // for the video normalizer — it expects top-level results[].
    const { adapter } = makeSearchAdapter(async () =>
      makeResponse({ json: { web: { results: [] } } }),
    );
    let thrown;
    try {
      await adapter.search.invoke({ query: "q", controls: { type: "video" } });
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof ApiError && thrown.statusCode === 500);
  });

  it("rejects type:video + contentSize before any fetch (type×contentSize combination guard)", async () => {
    let fetchCalls = 0;
    const { adapter } = makeSearchAdapter(async () => {
      fetchCalls += 1;
      return emptyWebResponse();
    });
    let thrown;
    try {
      await adapter.search.invoke({ query: "q", controls: { type: "video", contentSize: "high" } });
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof UnsupportedOptionError, "must be UnsupportedOptionError");
    assert.ok(/brave/i.test(thrown.message) && /contentSize/.test(thrown.message), thrown.message);
    assert.strictEqual(fetchCalls, 0, "fetch must not be called for an unsupported control");
  });

  it("type:video takes precedence over web (no topic) and does not append the finance keyword", async () => {
    const { adapter, calls } = makeSearchAdapter(async () =>
      makeResponse({ json: { results: [] } }),
    );
    await adapter.search.invoke({ query: "cats", controls: { type: "video" } });
    // Routed to the video endpoint, not web.
    assert.ok(
      calls[0].url.startsWith("https://api.search.brave.com/res/v1/videos/search?"),
      calls[0].url,
    );
    // Video has no topic axis; the plain query is sent as q= (no
    // "financial" keyword appended by applyQueryMutators).
    assert.ok(
      calls[0].url.includes(encodeURIComponent("cats")),
      `q must be the plain query: ${calls[0].url}`,
    );
    assert.ok(!calls[0].url.includes("financial"), `no finance keyword: ${calls[0].url}`);
  });

  it("cache identity partitions by type (video vs web for the same query)", () => {
    const { adapter } = makeSearchAdapter(emptyWebResponse);
    const video = adapter.search.cacheIdentity({ query: "cats", controls: { type: "video" } });
    const web = adapter.search.cacheIdentity({ query: "cats" });
    assert.strictEqual(video.provider, "brave");
    assert.deepStrictEqual(video.request.controls, { type: "video" });
    assert.strictEqual(web.request.controls, undefined);
    assert.notDeepStrictEqual(video.request, web.request);
  });

  it("rejects an empty/whitespace query with ValidationError before any fetch", async () => {
    let fetchCalls = 0;
    const { adapter } = makeSearchAdapter(async () => {
      fetchCalls += 1;
      return emptyWebResponse();
    });
    for (const query of ["", "   ", "\t\n"]) {
      let thrown;
      try {
        await adapter.search.invoke({ query });
      } catch (err) {
        thrown = err;
      }
      assert.ok(thrown, "must throw for an empty query");
      assert.strictEqual(thrown.constructor.name, "ValidationError");
    }
    assert.strictEqual(fetchCalls, 0, "no fetch for an invalid query");
  });

  it("invoke throws ConfigurationError (exit 3) when the key is missing", async () => {
    const { fn } = makeRecordingFetch(emptyWebResponse);
    const descriptor = createBraveDescriptor({ transport: { fetch: fn } });
    const adapter = descriptor.create({ env: {} });
    let thrown;
    try {
      await adapter.search.invoke({ query: "q" });
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof ConfigurationError, "must be ConfigurationError");
    assert.strictEqual(thrown.exitCode, 3);
  });

  it("throws ApiError 500 on a malformed web response (missing results)", async () => {
    const { adapter } = makeSearchAdapter(async () => makeResponse({ json: { web: {} } }));
    let thrown;
    try {
      await adapter.search.invoke({ query: "q" });
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof ApiError && thrown.statusCode === 500);
  });

  it("throws ApiError 500 when a result entry is missing description", async () => {
    const raw = { web: { results: [{ title: "t", url: "https://x.test" }] } };
    const { adapter } = makeSearchAdapter(async () => makeResponse({ json: raw }));
    let thrown;
    try {
      await adapter.search.invoke({ query: "q" });
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof ApiError && thrown.statusCode === 500);
  });

  it("does NOT leak the raw Brave body into the adapter error message", async () => {
    const bodyText = "leak-marker-DO-NOT-EMBED-into-adapter-errors";
    const { adapter } = makeSearchAdapter(makeErrorFetch(500, bodyText));
    let thrown;
    try {
      await adapter.search.invoke({ query: "q" });
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof Error, "must throw");
    assert.ok(
      !thrown.message.includes(bodyText),
      `error message must not contain raw Brave body: ${thrown.message}`,
    );
    if (thrown.help) {
      assert.ok(!thrown.help.includes(bodyText), "error help must not contain raw Brave body");
    }
  });

  it("cacheIdentity echoes the full controls and partitions by credential", () => {
    const { adapter } = makeSearchAdapter(emptyWebResponse);
    const a = adapter.search.cacheIdentity({ query: "q", controls: { recency: "oneWeek" } });
    assert.strictEqual(a.provider, "brave");
    assert.strictEqual(a.capability, "search");
    assert.strictEqual(a.request.query, "q");
    assert.deepStrictEqual(a.request.controls, { recency: "oneWeek" });
    assert.ok(!("legacyCandidates" in a), "no legacyCandidates");

    // Different controls → different request payload.
    const b = adapter.search.cacheIdentity({ query: "q", controls: { recency: "oneDay" } });
    assert.notDeepStrictEqual(a.request.controls, b.request.controls);
  });
});
