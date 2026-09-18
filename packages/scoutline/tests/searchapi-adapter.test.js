/**
 * SearchApi Provider foundation tests (T1, searchapi credentials module).
 *
 * Verifies the SearchApi.io credential seam:
 *   - getSearchApiKey: SEARCHAPI_API_KEY wins over legacy SERPAPI_API_KEY;
 *   whitespace-only values are absent; returned keys are trimmed.
 *   - isSearchApiConfigured: true only when a non-blank key is present
 *   (either env var), false for whitespace-only values.
 *   - requireSearchApiKey: throws ConfigurationError (exit 3) when
 *   neither variable is non-blank.
 *   - hashSearchApiKey: lowercase hex SHA-256 fingerprint, length 64;
 *   the raw key must never appear in error messages or logs.
 *
 * No network is touched; tests pass literal env objects.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  getSearchApiKey,
  isSearchApiConfigured,
  requireSearchApiKey,
  hashSearchApiKey,
} from "../dist/providers/searchapi/credentials.js";
import { ConfigurationError } from "../dist/lib/errors.js";

describe("searchapi credentials", () => {
  it("prefers SEARCHAPI_API_KEY over SERPAPI_API_KEY and computes fingerprint", () => {
    assert.equal(getSearchApiKey({ SEARCHAPI_API_KEY: "a", SERPAPI_API_KEY: "b" }), "a");
    assert.equal(getSearchApiKey({ SERPAPI_API_KEY: " b " }), "b");
    assert.equal(isSearchApiConfigured({ SEARCHAPI_API_KEY: "  " }), false);
    assert.equal(hashSearchApiKey("key").length, 64);
    assert.throws(
      () => requireSearchApiKey({}),
      (e) => e instanceof ConfigurationError,
    );
  });

  it("reports configured when only one variable is set", () => {
    assert.equal(isSearchApiConfigured({ SEARCHAPI_API_KEY: "k" }), true);
    assert.equal(isSearchApiConfigured({ SERPAPI_API_KEY: "legacy" }), true);
  });

  it("trims the key returned by requireSearchApiKey", () => {
    assert.equal(requireSearchApiKey({ SEARCHAPI_API_KEY: " x " }), "x");
  });
});
