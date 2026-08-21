/**
 * Spider.cloud Adapter tests.
 *
 * Credentials: SPIDER_API_KEY resolution trims surrounding whitespace;
 * a missing (or blank) key is a ConfigurationError (CONFIGURATION_ERROR,
 * exit 3), not a provider-side auth rejection.
 *
 * Tests stay at module boundaries and inject fakes at the transport
 * boundary in later capability sections; no real network.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  getSpiderApiKey,
  requireSpiderApiKey,
} from "../dist/providers/spider/credentials.js";
import { ConfigurationError } from "../dist/lib/errors.js";

describe("spider credentials", () => {
  it("requires trimmed SPIDER_API_KEY", () => {
    assert.equal(getSpiderApiKey({ SPIDER_API_KEY: " s " }), "s");
    assert.throws(() => requireSpiderApiKey({}), ConfigurationError);
  });
});
