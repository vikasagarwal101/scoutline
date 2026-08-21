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

import { ApiError } from "../dist/lib/errors.js";

const YOU_CONTENTS_RAW = [
  {
    url: "https://example.test/page",
    title: "Example Page",
    markdown: "# Hi",
    html: "<h1>Hi</h1>",
    status: 200,
  },
];

it("reader.fetch POSTs contents and returns ReaderFetchResult", async () => {
  const calls = [];
  const adapter = createYouDescriptor({
    transport: {
      fetch: async (url, init) => {
        calls.push({ url: String(url), body: init?.body });
        return {
          ok: true,
          status: 200,
          json: async () => YOU_CONTENTS_RAW,
          text: async () => JSON.stringify(YOU_CONTENTS_RAW),
          headers: { get: () => null },
        };
      },
    },
  }).create({ env: { YDC_API_KEY: "k" } });
  assert.ok(adapter.reader);
  const result = await adapter.reader.fetch.invoke({ url: "https://example.test/page" });
  assert.equal(calls[0].url, "https://ydc-index.io/v1/contents");
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.contentFormat, "markdown");
  assert.ok(result.content.length > 0);
  assert.equal(adapter.reader.fetch.kind, "reader-fetch");
  assert.equal(
    adapter.reader.fetch.decodeCached({
      schemaVersion: 1,
      url: "https://example.test/page",
      finalUrl: "https://example.test/page",
      title: null,
      content: "# Hi",
      contentFormat: "markdown",
    }).content,
    "# Hi",
  );
});

it("reader.fetch throws ApiError when markdown is null without extra semantics", async () => {
  const adapter = createYouDescriptor({
    transport: {
      fetch: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ markdown: null, html: null }),
        text: async () => "{}",
        headers: { get: () => null },
      }),
    },
  }).create({ env: { YDC_API_KEY: "k" } });
  await assert.rejects(
    () => adapter.reader.fetch.invoke({ url: "https://example.test/x" }),
    ApiError,
  );
});

const YOU_RESEARCH_RAW = {
  output: {
    content: "RocksDB and LMDB represent two distinct database engine architectures [[1]]:\n\n### 1. Write Throughput\nRocksDB utilizes a Log-Structured Merge (LSM) tree architecture [[1]]...",
    content_type: "text",
    sources: [
      {
        title: "RocksDB Architecture Guide",
        url: "https://github.com/facebook/rocksdb/wiki/RocksDB-Basics",
        snippets: ["RocksDB is an LSM-tree database engine optimized for fast storage..."],
      },
      {
        title: "LMDB Design Documentation",
        url: "http://www.lmdb.tech/doc/",
        snippets: ["LMDB is an extraordinarily fast, compact key-value embedded data store..."],
      },
    ],
  },
  metadata: {
    research_uuid: "research-fixture-001",
    latency: 3.45,
  },
};

it("research.run POSTs api.you.com with lite for mini", async () => {
  const calls = [];
  const adapter = createYouDescriptor({
    transport: {
      fetch: async (url, init) => {
        calls.push({ url: String(url), body: JSON.parse(init.body) });
        return {
          ok: true,
          status: 200,
          json: async () => YOU_RESEARCH_RAW,
          text: async () => JSON.stringify(YOU_RESEARCH_RAW),
          headers: { get: () => null },
        };
      },
    },
  }).create({ env: { YDC_API_KEY: "k" } });
  const result = await adapter.research.run.invoke({ query: "q", model: "mini" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.you.com/v1/research");
  assert.equal(calls[0].body.research_effort, "lite");
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.model, "mini");
  assert.ok(result.report.length > 0);
  assert.equal(adapter.research.run.kind, "research-fetch");
});

it("diagnostics.invoke probes with a single search and create() does not fetch", async () => {
  let calls = 0;
  const descriptor = createYouDescriptor({
    transport: {
      fetch: async () => {
        calls += 1;
        return {
          ok: true,
          status: 200,
          json: async () => YOU_SEARCH_RAW,
          text: async () => "{}",
          headers: { get: () => null },
        };
      },
    },
  });
  descriptor.create({ env: { YDC_API_KEY: "k" } });
  assert.equal(calls, 0);
  const adapter = descriptor.create({ env: { YDC_API_KEY: "k" } });
  await adapter.diagnostics.invoke({ probe: true });
  assert.equal(calls, 1);
});

import { PROVIDER_IDS } from "../dist/providers/types.js";
import { BUILT_IN_PROVIDER_DESCRIPTORS } from "../dist/providers/registry.js";
import {
  PROVIDER_AUTHORITY_POLICIES,
  CAPABILITY_MAPPINGS,
} from "../dist/lib/quota-mapping.js";

describe("you registry wiring", () => {
  it("registers you in PROVIDER_IDS and the static registry", () => {
    assert.ok(PROVIDER_IDS.includes("you"));
    const ids = BUILT_IN_PROVIDER_DESCRIPTORS.map((d) => d.id);
    assert.ok(ids.includes("you"));
    // Appended after jina, preserving canonical registry order.
    assert.deepEqual(ids.slice(-2), ["jina", "you"]);
    const you = BUILT_IN_PROVIDER_DESCRIPTORS.find((d) => d.id === "you");
    assert.deepEqual(you.credentialEnvVars, ["YDC_API_KEY", "YOU_API_KEY"]);
  });

  it("you quota authority is always-unknown with no capability mappings", () => {
    const policy = PROVIDER_AUTHORITY_POLICIES.find((p) => p.provider === "you");
    assert.ok(policy, "you must have a PROVIDER_AUTHORITY_POLICIES row");
    assert.equal(policy.kind, "always-unknown");
    assert.ok(policy.reason.length > 0);
    assert.equal(
      CAPABILITY_MAPPINGS.filter((m) => m.provider === "you").length,
      0,
      "always-unknown providers must not have CAPABILITY_MAPPINGS rows",
    );
  });
});
