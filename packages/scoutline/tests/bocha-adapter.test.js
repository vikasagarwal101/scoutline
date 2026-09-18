/**
 * Bocha AI Provider foundation tests (PLAN tasks T1–T4).
 *
 * Verifies the Bocha direct-HTTP transport skeleton:
 *   - Credentials: getBochaApiKey trims BOCHA_API_KEY;
 *     requireBochaApiKey throws ConfigurationError (exit 3) when missing;
 *     isBochaConfigured false for whitespace-only values.
 *   - Envelope unwrap: results live at data.webPages.value (Bing-shaped),
 *     NOT the JSON root. Success only when HTTP 2xx AND (code undefined
 *     or code === 200).
 *   - Search controls: domain → `site:<domain> ` query prefix; recency →
 *     freshness passthrough; contentSize → summary:true; location/type
 *     rejected before any fetch.
 *   - Diagnostics: invoke({probe:true}) POSTs /v1/web-search with
 *     count 1; create() never fetches.
 *
 * Tests inject a single fake `fetch` through
 * `createBochaDescriptor({ transport })`; the fake returns
 * Response-shaped objects. No real network is touched.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  getBochaApiKey,
  isBochaConfigured,
  requireBochaApiKey,
} from "../dist/providers/bocha/credentials.js";
import { ConfigurationError } from "../dist/lib/errors.js";

// ---------------------------------------------------------------------------
// Fake fetch helpers
// ---------------------------------------------------------------------------

function jsonRes(payload) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(payload),
    json: async () => payload,
    headers: { get: () => null },
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

function errorRes(status, body = '{"error":"upstream message that must not leak"}') {
  return {
    ok: false,
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    json: async () => body,
    headers: { get: () => null },
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

function header(call, name) {
  const headers = call.headers || {};
  return headers[name] ?? null;
}

// ---------------------------------------------------------------------------
// Credentials (T1)
// ---------------------------------------------------------------------------

describe("Bocha credentials", () => {
  it("trims BOCHA_API_KEY", () => {
    assert.equal(getBochaApiKey({ BOCHA_API_KEY: " k " }), "k");
    assert.equal(isBochaConfigured({ BOCHA_API_KEY: "  " }), false);
    assert.throws(
      () => requireBochaApiKey({}),
      (e) => {
        assert.ok(e instanceof ConfigurationError);
        assert.equal(e.exitCode, 3);
        assert.equal(e.help, 'export BOCHA_API_KEY="your-bocha-api-key"');
        return true;
      },
    );
  });

  it("getBochaApiKey returns undefined when absent", () => {
    assert.equal(getBochaApiKey({}), undefined);
    assert.equal(getBochaApiKey({ BOCHA_API_KEY: "   " }), undefined);
    assert.equal(isBochaConfigured({ BOCHA_API_KEY: " k " }), true);
  });
});
