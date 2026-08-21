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
import { fetchSpiderCredits } from "../dist/providers/spider/client.js";
import { ApiError, ConfigurationError, TimeoutError, UnsupportedOptionError } from "../dist/lib/errors.js";

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
  it("reader.fetch preserves provider metadata and external blobs verbatim", async () => {
    const raw = [{
      url: "https://example.test/doc",
      status: 200,
      content: "# Doc",
      metadata: { title: "Doc Title", description: "d", word_count: 7 },
      external: { costs: { total_cost: 0.00004 } },
    }];
    const adapter = createSpiderDescriptor({
      transport: {
        fetch: async () => ({ ok: true, status: 200, json: async () => raw, text: async () => JSON.stringify(raw), headers: { get: () => null } }),
      },
    }).create({ env: { SPIDER_API_KEY: "k" } });
    assert.ok(adapter.reader);
    const result = await adapter.reader.fetch.invoke({ url: "https://example.test/doc" });
    assert.deepEqual(result.metadata, { title: "Doc Title", description: "d", word_count: 7 });
    assert.deepEqual(result.external, { costs: { total_cost: 0.00004 } });
  });
  it("reader.fetch omits metadata and external when the page carries none", async () => {
    const raw = [{ url: "https://example.test/doc", status: 200, content: "# Doc" }];
    const adapter = createSpiderDescriptor({
      transport: {
        fetch: async () => ({ ok: true, status: 200, json: async () => raw, text: async () => JSON.stringify(raw), headers: { get: () => null } }),
      },
    }).create({ env: { SPIDER_API_KEY: "k" } });
    assert.ok(adapter.reader);
    const result = await adapter.reader.fetch.invoke({ url: "https://example.test/doc" });
    assert.equal(result.metadata, undefined);
    assert.equal(result.external, undefined);
  });
});

describe("spider transport timeout", () => {
  it("keeps the timeout timer armed until the credits body finishes parsing", async () => {
    let releaseBody;
    const body = new Promise((resolve) => { releaseBody = resolve; });
    let onTimer;
    const clears = [];
    const pending = fetchSpiderCredits("k", {
      fetch: async () => ({ ok: true, status: 200, json: () => body, text: async () => "{}", headers: { get: () => null } }),
      setTimeout: (fn) => { onTimer = fn; return 1; },
      clearTimeout: () => { clears.push(1); },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(onTimer instanceof Function, true, "timeout timer is armed");
    assert.equal(clears.length, 0, "clearTimeout must not run while the body is still pending");
    releaseBody({ credits: 5 });
    assert.deepEqual(await pending, { credits: 5 });
    assert.equal(clears.length, 1, "clearTimeout runs exactly once after settle");
  });

  it("timeout firing during the credits body read surfaces TimeoutError", async () => {
    let fire;
    const pending = fetchSpiderCredits("k", {
      fetch: async (_url, init) => ({
        ok: true,
        status: 200,
        json: () => new Promise((_, reject) => {
          init.signal.addEventListener("abort", () => {
            reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
          });
        }),
        text: async () => "{}",
        headers: { get: () => null },
      }),
      setTimeout: (fn) => { fire = fn; return 1; },
      clearTimeout: () => {},
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fire instanceof Function, true, "timeout timer is armed");
    fire();
    await assert.rejects(pending, (e) => e instanceof TimeoutError);
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

describe("spider quota and diagnostics", () => {
  it("quota.invoke maps credits remaining and diagnostics probes /data/credits", async () => {
    let calls = 0;
    const jsonRes = (body) => ({
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
      headers: { get: () => null },
    });
    const descriptor = createSpiderDescriptor({
      transport: { fetch: async (url) => {
        calls += 1;
        assert.match(String(url), /\/data\/credits$/);
        return jsonRes({ credits: 84520 });
      } },
    });
    const env = { SPIDER_API_KEY: "k" };
    descriptor.create({ env });
    assert.equal(calls, 0);

    const adapter = descriptor.create({ env });
    const quota = await adapter.quota.invoke();
    assert.equal(quota.provider, "spider");
    assert.equal(quota.status, "ok");
    assert.equal(quota.categories[0].name, "credits");
    assert.equal(quota.categories[0].current.remaining, 84520);

    await adapter.diagnostics.invoke({ probe: true });
    assert.equal(calls, 2);
  });
});

// ---------------------------------------------------------------------------
// Registry wiring — "spider" joins PROVIDER_IDS and the built-in registry
// ---------------------------------------------------------------------------

describe("spider registry wiring", () => {
  it("spider is on PROVIDER_IDS", async () => {
    const { PROVIDER_IDS } = await import("../dist/providers/types.js");
    assert.ok(PROVIDER_IDS.includes("spider"));
  });

  it("built-in registry exposes the spider descriptor with all six capabilities", async () => {
    const { BUILT_IN_PROVIDER_DESCRIPTORS } = await import("../dist/providers/registry.js");
    const descriptor = BUILT_IN_PROVIDER_DESCRIPTORS.find((d) => d.id === "spider");
    assert.ok(descriptor, "spider descriptor must be in BUILT_IN_PROVIDER_DESCRIPTORS");
    assert.deepEqual(
      [...descriptor.capabilities()].sort(),
      ["crawl", "diagnostics", "map", "quota", "reader", "search"],
    );
    assert.deepEqual(descriptor.credentialEnvVars, ["SPIDER_API_KEY"]);
    assert.equal(descriptor.isConfigured({ SPIDER_API_KEY: "k" }), true);
    assert.equal(descriptor.isConfigured({ SPIDER_API_KEY: "  " }), false);
    assert.equal(descriptor.isConfigured({}), false);
  });
});
