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
import { createSpiderDescriptor } from "../dist/providers/spider/adapter.js";
import { ApiError, ConfigurationError, UnsupportedOptionError } from "../dist/lib/errors.js";

describe("spider credentials", () => {
  it("requires trimmed SPIDER_API_KEY", () => {
    assert.equal(getSpiderApiKey({ SPIDER_API_KEY: " s " }), "s");
    assert.throws(() => requireSpiderApiKey({}), ConfigurationError);
  });
});

describe("spider search", () => {
  it("search validate rejects type before fetch", () => {
    let calls = 0;
    const adapter = createSpiderDescriptor({
      transport: { fetch: async () => { calls += 1; throw new Error("no"); } },
    }).create({ env: { SPIDER_API_KEY: "k" } });
    assert.ok(adapter.search);
    assert.throws(
      () => adapter.search.validate({ query: "q", controls: { type: "video" } }),
      (e) => e instanceof UnsupportedOptionError && e.provider === "spider" && e.capability === "search" && e.option === "type",
    );
    assert.equal(calls, 0);
  });
  it("search invoke sends tbs and whitelist", async () => {
    const raw = [{ url: "https://example.test/a", status: 200, metadata: { title: "T", description: "D" }, content: "x" }];
    const calls = [];
    const adapter = createSpiderDescriptor({
      transport: { fetch: async (url, init) => {
        calls.push({ url: String(url), body: JSON.parse(init.body) });
        return { ok: true, status: 200, json: async () => raw, text: async () => JSON.stringify(raw), headers: { get: () => null } };
      } },
    }).create({ env: { SPIDER_API_KEY: "k" } });
    assert.ok(adapter.search);
    const rows = await adapter.search.invoke({
      query: "rust async",
      controls: { recency: "oneWeek", domain: "github.com" },
    });
    assert.equal(calls[0].url, "https://api.spider.cloud/search");
    assert.equal(calls[0].body.search, "rust async");
    assert.equal(calls[0].body.tbs, "qdr:w");
    assert.deepEqual(calls[0].body.whitelist, ["github.com"]);
    assert.equal(rows[0].url, "https://example.test/a");
    assert.equal(rows[0].title, "T");
  });
});


describe("spider reader", () => {
  it("reader.fetch POSTs /scrape and returns markdown content", async () => {
    const raw = [{ url: "https://example.test/doc", status: 200, content: "# Scraped Doc" }];
    const calls = [];
    const adapter = createSpiderDescriptor({
      transport: {
        fetch: async (url, init) => {
          calls.push({ url: String(url), body: JSON.parse(init.body) });
          return { ok: true, status: 200, json: async () => raw, text: async () => JSON.stringify(raw), headers: { get: () => null } };
        },
      },
    }).create({ env: { SPIDER_API_KEY: "k" } });
    assert.ok(adapter.reader);
    const result = await adapter.reader.fetch.invoke({ url: "https://example.test/doc" });
    assert.match(calls[0].url, /\/scrape$/);
    assert.equal(result.schemaVersion, 1);
    assert.equal(result.contentFormat, "markdown");
    assert.equal(result.content, "# Scraped Doc");
    assert.equal(adapter.reader.fetch.kind, "reader-fetch");
  });
  it("reader.fetch canonical body and empty content becomes ApiError", async () => {
    const calls = [];
    const adapter = createSpiderDescriptor({
      transport: {
        fetch: async (url, init) => {
          calls.push({ url: String(url), body: JSON.parse(init.body) });
          const raw = [{ url: "https://example.test/doc", status: 200, content: "" }];
          return { ok: true, status: 200, json: async () => raw, text: async () => JSON.stringify(raw), headers: { get: () => null } };
        },
      },
    }).create({ env: { SPIDER_API_KEY: "k" } });
    assert.ok(adapter.reader);
    await assert.rejects(
      adapter.reader.fetch.invoke({ url: "https://example.test/doc" }),
      (e) => e instanceof ApiError,
    );
    assert.match(calls[0].url, /\/scrape$/);
    assert.equal(calls[0].body.url, "https://example.test/doc");
    assert.equal(calls[0].body.return_format, "markdown");
    assert.equal(calls[0].body.filter_output_main_only, true);
    assert.equal(calls[0].body.stealth, true);
    assert.equal(adapter.reader.fetch.decodeCached({ bogus: true }), null);
  });
});

describe("spider crawl and map", () => {
  it("crawl.fetch drops non-200 pages", async () => {
    const raw = [
      { url: "https://example.test/ok", status: 200, content: "# Ok" },
      { url: "https://example.test/no", status: 404, content: "missing" },
    ];
    const adapter = createSpiderDescriptor({
      transport: { fetch: async () => ({ ok: true, status: 200, json: async () => raw, text: async () => JSON.stringify(raw), headers: { get: () => null } }) },
    }).create({ env: { SPIDER_API_KEY: "k" } });
    const result = await adapter.crawl.fetch.invoke({ url: "https://example.test" });
    assert.equal(adapter.crawl.fetch.kind, "crawl-fetch");
    assert.equal(result.schemaVersion, 1);
    assert.equal(result.baseUrl, "https://example.test");
    assert.equal(result.totalPages, 1);
    assert.equal(result.pages.length, 1);
    assert.equal(result.pages[0].url, "https://example.test/ok");
    assert.equal(result.pages[0].contentFormat, "markdown");
  });

  it("map.fetch dedupes links", async () => {
    const raw = [{ url: "https://example.test/a" }, { url: "https://example.test/a" }, { url: "https://example.test/b" }];
    const adapter = createSpiderDescriptor({
      transport: { fetch: async (url) => {
        assert.match(String(url), /\/links$/);
        return { ok: true, status: 200, json: async () => raw, text: async () => JSON.stringify(raw), headers: { get: () => null } };
      } },
    }).create({ env: { SPIDER_API_KEY: "k" } });
    const result = await adapter.map.fetch.invoke({ url: "https://example.test" });
    assert.equal(result.schemaVersion, 1);
    assert.equal(result.baseUrl, "https://example.test");
    assert.equal(result.totalUrls, 2);
    assert.deepEqual(result.urls, ["https://example.test/a", "https://example.test/b"]);
  });
});
