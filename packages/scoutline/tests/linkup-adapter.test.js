/**
 * Linkup Adapter conformance tests.
 *
 * Verifies the Linkup direct-HTTP transport Adapter at the public seams:
 *   - Credentials: LINKUP_API_KEY trimming, presence, ConfigurationError
 *   - Search: `type` rejection before fetch, domain -> includeDomains,
 *     contentSize -> depth, Bearer auth, name/url/content normalization
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
import { createLinkupDescriptor } from "../dist/providers/linkup/adapter.js";
import { ConfigurationError, UnsupportedOptionError } from "../dist/lib/errors.js";

describe("Linkup credentials", () => {
  it("trims LINKUP_API_KEY and throws ConfigurationError when missing", () => {
    assert.equal(getLinkupApiKey({ LINKUP_API_KEY: " abc " }), "abc");
    assert.equal(isLinkupConfigured({}), false);
    assert.throws(() => requireLinkupApiKey({}), ConfigurationError);
  });
});

describe("Linkup Search Adapter — validation and control mapping", () => {
  it("search validate rejects type before fetch", () => {
    let calls = 0;
    const adapter = createLinkupDescriptor({
      transport: { fetch: async () => { calls += 1; throw new Error("no"); } },
    }).create({ env: { LINKUP_API_KEY: "k" } });
    assert.ok(adapter.search);
    assert.throws(
      () => adapter.search.validate({ query: "q", controls: { type: "video" } }),
      (e) => e instanceof UnsupportedOptionError && e.provider === "linkup" && e.capability === "search" && e.option === "type",
    );
    assert.equal(calls, 0);
  });

  it("search invoke POSTs /v1/search and maps includeDomains with Bearer auth", async () => {
    const LINKUP_SEARCH_RAW = {
      results: [
        {
          name: "Linkup Documentation",
          url: "https://docs.linkup.so",
          content: "Linkup provides deep search APIs.",
          favicon: "https://docs.linkup.so/favicon.ico",
          type: "text",
        },
      ],
    };
    const calls = [];
    const adapter = createLinkupDescriptor({
      transport: {
        fetch: async (url, init) => {
          calls.push({ url: String(url), method: init?.method, headers: init?.headers, body: JSON.parse(init?.body) });
          return {
            ok: true,
            status: 200,
            json: async () => LINKUP_SEARCH_RAW,
            text: async () => JSON.stringify(LINKUP_SEARCH_RAW),
            headers: { get: () => null },
          };
        },
      },
    }).create({ env: { LINKUP_API_KEY: "k" } });

    const rows = await adapter.search.invoke({
      query: "linkup",
      controls: { domain: "linkup.so", contentSize: "high" },
    });

    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/v1\/search$/);
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].headers["Authorization"] ?? calls[0].headers["authorization"], "Bearer k");
    assert.deepEqual(calls[0].body.includeDomains, ["linkup.so"]);
    assert.equal(calls[0].body.depth, "deep");
    assert.equal(rows[0].title, "Linkup Documentation");
    assert.equal(rows[0].url, "https://docs.linkup.so");
    assert.equal(rows[0].summary, "Linkup provides deep search APIs.");
  });
});
