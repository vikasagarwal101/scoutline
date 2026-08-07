/**
 * Tests for ZaiApiClient redirect handling (1.2).
 *
 * Verifies that `redirect: "manual"` is set on every fetch call and that
 * a 3xx response fails closed with an ApiError instead of silently
 * following the redirect (which would forward the Authorization header
 * to a potentially different origin).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ZaiApiClient } from "../dist/lib/api-client.js";
import { ApiError } from "../dist/lib/errors.js";

const TEST_KEY = "test-key-redirect-1-2-abc";

function makeClient() {
  return new ZaiApiClient({
    apiKey: TEST_KEY,
    mode: "ZAI",
    baseUrl: "https://api.z.ai/test",
    timeout: 5000,
    visionModel: "test-model",
    temperature: 0.8,
    topP: 0.6,
    maxTokens: 100,
  });
}

/** Minimal Response-like mock for a 302 redirect. */
function redirectResponse(location) {
  return {
    ok: false,
    status: 302,
    headers: { get: (name) => (name === "Location" ? location : null) },
    text: async () => "",
    json: async () => ({}),
  };
}

describe("ZaiApiClient — redirect handling (1.2)", () => {
  let originalFetch;
  let calls;

  beforeEach(() => {
    originalFetch = global.fetch;
    calls = [];
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("sets redirect:'manual' on fetch so redirects are not silently followed", async () => {
    global.fetch = async (url, options) => {
      calls.push({ url: String(url), options });
      return redirectResponse("https://evil.example.com/steal");
    };

    const client = makeClient();

    await assert.rejects(client.webSearch({ query: "test" }), (err) => {
      assert.ok(err instanceof ApiError, `expected ApiError, got ${err.constructor?.name}`);
      assert.strictEqual(err.statusCode, 302);
      assert.ok(
        err.message.includes("redirect"),
        `error message should mention redirect: ${err.message}`,
      );
      return true;
    });

    // Every fetch call must carry redirect: "manual"
    assert.ok(calls.length > 0, "fetch must have been called at least once");
    for (const call of calls) {
      assert.strictEqual(
        call.options.redirect,
        "manual",
        "redirect:'manual' must be set on every fetch call",
      );
    }

    // No call should have gone to the redirect destination — proving
    // the Authorization header was never forwarded cross-origin.
    for (const call of calls) {
      assert.ok(
        !call.url.includes("evil.example.com"),
        `fetch called redirect destination: ${call.url}`,
      );
      assert.ok(
        call.url.startsWith("https://api.z.ai/test"),
        `fetch called unexpected URL: ${call.url}`,
      );
    }
  });

  it("Authorization header is present on the original request but not forwarded", async () => {
    global.fetch = async (url, options) => {
      calls.push({ url: String(url), options });
      return redirectResponse("https://evil.example.com/steal");
    };

    const client = makeClient();

    await assert.rejects(client.webRead({ url: "https://example.com" }));

    assert.ok(calls.length > 0);
    // The original request must carry the Authorization header.
    assert.ok(
      calls[0].options.headers.Authorization?.includes(TEST_KEY),
      "Authorization header must be set on the original request",
    );
    // The redirect destination must never have been fetched.
    assert.strictEqual(
      calls.filter((c) => c.url.includes("evil.example.com")).length,
      0,
      "no fetch to the redirect destination should occur",
    );
  });
});
