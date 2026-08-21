/**
 * Linkup Adapter conformance tests.
 *
 * Verifies the Linkup direct-HTTP transport Adapter at the public seams:
 *   - Credentials: LINKUP_API_KEY trimming, presence, ConfigurationError
 *
 * Tests inject a fake `fetch` through descriptor transport deps; no real
 * network is touched.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  getLinkupApiKey,
  isLinkupConfigured,
  requireLinkupApiKey,
} from "../dist/providers/linkup/credentials.js";
import { ConfigurationError } from "../dist/lib/errors.js";

describe("Linkup credentials", () => {
  it("trims LINKUP_API_KEY and throws ConfigurationError when missing", () => {
    assert.equal(getLinkupApiKey({ LINKUP_API_KEY: " abc " }), "abc");
    assert.equal(isLinkupConfigured({}), false);
    assert.throws(() => requireLinkupApiKey({}), ConfigurationError);
  });
});
