/**
 * Kagi Provider foundation tests.
 *
 * Verifies the Kagi credentials module:
 *   - getKagiApiKey resolves KAGI_API_KEY first, then KAGI_TOKEN; trims.
 *   - isKagiConfigured false for whitespace-only values.
 *   - requireKagiApiKey throws ConfigurationError (exit 3) when missing.
 *   - hashKagiApiKey: lowercase hex SHA-256, 64 chars, deterministic,
 *     distinct per distinct key. Raw key is never logged.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import crypto from "node:crypto";
import {
  getKagiApiKey,
  hashKagiApiKey,
  isKagiConfigured,
  requireKagiApiKey,
} from "../dist/providers/kagi/credentials.js";
import { ConfigurationError } from "../dist/lib/errors.js";

describe("kagi credentials", () => {
  it("kagi credentials prefer KAGI_API_KEY over KAGI_TOKEN", () => {
    assert.equal(getKagiApiKey({ KAGI_API_KEY: "a", KAGI_TOKEN: "b" }), "a");
    assert.equal(getKagiApiKey({ KAGI_TOKEN: " b " }), "b");
    assert.equal(isKagiConfigured({ KAGI_API_KEY: "  " }), false);
    assert.throws(() => requireKagiApiKey({}), (err) => {
      assert.ok(err instanceof ConfigurationError);
      assert.equal(err.code, "CONFIGURATION_ERROR");
      assert.equal(err.exitCode, 3);
      return true;
    });
  });

  it("hashKagiApiKey returns deterministic 64-char lowercase hex digests", () => {
    const h1 = hashKagiApiKey("key-one");
    const h1again = hashKagiApiKey("key-one");
    const h2 = hashKagiApiKey("key-two");
    assert.equal(h1, h1again);
    assert.notEqual(h1, h2);
    assert.equal(h1.length, 64);
    assert.match(h1, /^[0-9a-f]{64}$/);
    assert.equal(
      h1,
      crypto.createHash("sha256").update("key-one").digest("hex"),
    );
  });
});

// Shared helpers used by later tasks.
function jsonRes(json, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => json, text: async () => JSON.stringify(json), headers: { get: () => null } };
}
function header(init, name) {
  const h = init?.headers;
  if (!h) return undefined;
  if (typeof h.get === "function") return h.get(name);
  return h[name] ?? h[name.toLowerCase()];
}
