import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isYouConfigured,
  getYouApiKey,
  requireYouApiKey,
} from "../dist/providers/you/credentials.js";
import { ConfigurationError } from "../dist/lib/errors.js";

describe("you credentials", () => {
  it("prefers YDC_API_KEY over YOU_API_KEY and treats whitespace as missing", () => {
    assert.equal(getYouApiKey({ YDC_API_KEY: " ydckey ", YOU_API_KEY: "other" }), "ydckey");
    assert.equal(getYouApiKey({ YOU_API_KEY: " youkey " }), "youkey");
    assert.equal(isYouConfigured({ YDC_API_KEY: "   " }), false);
  });
  it("requireYouApiKey throws ConfigurationError when unset", () => {
    assert.throws(() => requireYouApiKey({}), (err) => {
      assert.ok(err instanceof ConfigurationError);
      assert.equal(err.code, "CONFIGURATION_ERROR");
      assert.equal(err.exitCode, 3);
      return true;
    });
  });
});
