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
 *   - Descriptor: id === "brave"; capabilities() is empty; create({env:{}})
 *     returns { id: "brave" } with all capability slots undefined; create()
 *     constructs no transport (injected spy fetch is never called).
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
import { ApiError, AuthError, ConfigurationError, TimeoutError } from "../dist/lib/errors.js";

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
    assert.strictEqual(
      requireBraveApiKey({ BRAVE_SEARCH_API_KEY: TEST_API_KEY }),
      TEST_API_KEY,
    );
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

  it("capabilities() returns an empty set (T1 foundation)", () => {
    const descriptor = createBraveDescriptor();
    const caps = descriptor.capabilities();
    assert.ok(caps instanceof Set, "must be a Set");
    assert.strictEqual(caps.size, 0, "T1 advertises no capabilities");
  });

  it("isConfigured reflects BRAVE_SEARCH_API_KEY presence", () => {
    const descriptor = createBraveDescriptor();
    assert.strictEqual(descriptor.isConfigured({}), false);
    assert.strictEqual(descriptor.isConfigured({ BRAVE_SEARCH_API_KEY: "   " }), false);
    assert.strictEqual(descriptor.isConfigured({ BRAVE_SEARCH_API_KEY: TEST_API_KEY }), true);
  });

  it("create() returns { id: 'brave' } with all capability slots undefined", () => {
    const descriptor = createBraveDescriptor();
    const adapter = descriptor.create({ env: {} });
    assert.strictEqual(adapter.id, "brave");
    for (const slot of [
      "search",
      "reader",
      "quota",
      "diagnostics",
      "crawl",
      "map",
      "research",
      "vision",
      "repository",
    ]) {
      assert.strictEqual(
        adapter[slot],
        undefined,
        `${slot} slot must be undefined in T1`,
      );
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
