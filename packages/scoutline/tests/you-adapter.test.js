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

const YOU_SEARCH_RAW = {
  results: {
    web: [
      {
        title: "TypeScript 5.8 Release Notes",
        url: "https://devblogs.microsoft.com/typescript/announcing-typescript-5-8/",
        description: "TypeScript 5.8 introduces new compiler optimizations.",
        snippets: ["Granular return type checks..."],
      },
    ],
    news: [],
  },
};

it("search invoke POSTs ydc-index.io and normalizes web results", async () => {
  const calls = [];
  const descriptor = createYouDescriptor({
    transport: {
      fetch: async (url, init) => {
        calls.push({ url: String(url), method: init?.method, headers: init?.headers, body: init?.body });
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify(YOU_SEARCH_RAW),
          json: async () => YOU_SEARCH_RAW,
          headers: { get: () => null },
        };
      },
    },
  });
  const adapter = descriptor.create({ env: { YDC_API_KEY: "k" } });
  assert.ok(adapter.search);
  const rows = await adapter.search.invoke({
    query: "TypeScript 5.8",
    controls: { domain: "microsoft.com", recency: "oneWeek", location: "us", contentSize: "high" },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://ydc-index.io/v1/search");
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].headers["X-API-Key"] ?? calls[0].headers["x-api-key"], "k");
  const body = JSON.parse(calls[0].body);
  assert.equal(body.query, "TypeScript 5.8");
  assert.deepEqual(body.include_domains, ["microsoft.com"]);
  assert.equal(body.freshness, "week");
  assert.equal(body.country, "US");
  assert.equal(body.extraction.extraction_mode, "full_page");
  assert.equal(rows[0].title, "TypeScript 5.8 Release Notes");
  assert.equal(rows[0].url, "https://devblogs.microsoft.com/typescript/announcing-typescript-5-8/");
  assert.ok(rows[0].summary.length > 0);
});

it("search cacheIdentity fingerprints the key and does not fetch", () => {
  let calls = 0;
  const adapter = createYouDescriptor({
    transport: { fetch: async () => { calls += 1; throw new Error("no"); } },
  }).create({ env: { YDC_API_KEY: "k" } });
  const id = adapter.search.cacheIdentity({ query: "q" });
  assert.equal(id.provider, "you");
  assert.equal(id.capability, "search");
  assert.equal(id.credentialFingerprint.length, 64);
  assert.equal(calls, 0);
});
