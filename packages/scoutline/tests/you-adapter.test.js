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

import { createYouDescriptor } from "../dist/providers/you/adapter.js";
import { UnsupportedOptionError } from "../dist/lib/errors.js";

it("search validate rejects type before fetch", async () => {
  let calls = 0;
  const descriptor = createYouDescriptor({
    transport: { fetch: async () => { calls += 1; throw new Error("no fetch"); } },
  });
  const adapter = descriptor.create({ env: { YDC_API_KEY: "k" } });
  assert.ok(adapter.search);
  assert.throws(
    () => adapter.search.validate({ query: "q", controls: { type: "video" } }),
    (err) => err instanceof UnsupportedOptionError && err.option === "type" && err.provider === "you",
  );
  await assert.rejects(
    () => adapter.search.invoke({ query: "q", controls: { type: "video" } }),
    UnsupportedOptionError,
  );
  assert.equal(calls, 0);
});
