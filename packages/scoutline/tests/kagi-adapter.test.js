/**
 * Kagi Provider foundation tests.
 *
 * Verifies the Kagi credentials module:
 *   - getKagiApiKey resolves KAGI_API_KEY first, then KAGI_TOKEN; trims.
 *   - isKagiConfigured false for whitespace-only values.
 *   - requireKagiApiKey throws ConfigurationError (exit 3) when missing.
 *   - hashKagiApiKey: lowercase hex SHA-256, 64 chars, deterministic,
 *     distinct per distinct key. Raw key is never logged.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import crypto from "node:crypto";
import {
  getKagiApiKey,
  hashKagiApiKey,
  isKagiConfigured,
  requireKagiApiKey,
} from "../dist/providers/kagi/credentials.js";
import { ConfigurationError } from "../dist/lib/errors.js";
import { createKagiDescriptor } from "../dist/providers/kagi/adapter.js";
import {
  QuotaError,
  UnsupportedOptionError,
  ValidationError,
} from "../dist/lib/errors.js";

describe("kagi credentials", () => {
  it("kagi credentials prefer KAGI_API_KEY over KAGI_TOKEN", () => {
    assert.equal(getKagiApiKey({ KAGI_API_KEY: "a", KAGI_TOKEN: "b" }), "a");
    assert.equal(getKagiApiKey({ KAGI_TOKEN: " b " }), "b");
    assert.equal(isKagiConfigured({ KAGI_API_KEY: "  " }), false);
    assert.throws(() => requireKagiApiKey({}), (err) => {
      assert.ok(err instanceof ConfigurationError);
      assert.equal(err.code, "CONFIGURATION_ERROR");
      assert.equal(err.exitCode, 3);
      return true;
    });
  });

  it("hashKagiApiKey returns deterministic 64-char lowercase hex digests", () => {
    const h1 = hashKagiApiKey("key-one");
    const h1again = hashKagiApiKey("key-one");
    const h2 = hashKagiApiKey("key-two");
    assert.equal(h1, h1again);
    assert.notEqual(h1, h2);
    assert.equal(h1.length, 64);
    assert.match(h1, /^[0-9a-f]{64}$/);
    assert.equal(
      h1,
      crypto.createHash("sha256").update("key-one").digest("hex"),
    );
  });
});

// ---------------------------------------------------------------------------
// Search fixture + fetch recorder (T2)
// ---------------------------------------------------------------------------

const KAGI_SEARCH_RAW = {
  meta: { id: "kagi_search_uuid_001", node: "us-east", ms: 125 },
  data: [
    { t: 0, rank: 1, url: "https://docs.kernel.org/scheduler/index.html", title: "Linux Kernel Scheduler Documentation", snippet: "The Linux scheduler controls CPU task scheduling across cores...", published: "2026-06-15T00:00:00Z" },
    { t: 1, list: ["linux scheduler benchmarks", "cfs scheduler tuning"] },
  ],
};

function makeFetchRecorder(responses = []) {
  const calls = [];
  const queue = responses.slice();
  const fetchFn = async (url, init) => {
    calls.push({ url: String(url), init });
    const res = queue.shift() ?? jsonRes(KAGI_SEARCH_RAW);
    return res;
  };
  fetchFn.calls = calls;
  return fetchFn;
}

describe("kagi search", () => {
  it("search validate rejects recency location contentSize type before fetch", () => {
    const fetchFn = makeFetchRecorder();
    const adapter = createKagiDescriptor({ transport: { fetch: fetchFn } }).create({
      env: { KAGI_API_KEY: "k" },
    });
    for (const option of ["recency", "location", "contentSize", "type"]) {
      try {
        adapter.search.validate({ query: "q", controls: { [option]: "x" } });
        assert.fail(`expected UnsupportedOptionError for ${option}`);
      } catch (e) {
        assert.ok(e instanceof UnsupportedOptionError, `${option}: wrong type ${e}`);
        assert.equal(e.provider, "kagi");
        assert.equal(e.capability, "search");
        assert.equal(e.option, option);
      }
    }
    assert.throws(
      () => adapter.search.validate({ query: "   " }),
      ValidationError,
    );
    assert.equal(fetchFn.calls.length, 0);
  });

  it("search cacheIdentity returns provider kagi and 64-char fingerprint without fetching", () => {
    const fetchFn = makeFetchRecorder();
    const adapter = createKagiDescriptor({ transport: { fetch: fetchFn } }).create({
      env: { KAGI_API_KEY: "k" },
    });
    const id = adapter.search.cacheIdentity({ query: "q" });
    assert.equal(id.provider, "kagi");
    assert.equal(id.capability, "search");
    assert.equal(id.credentialFingerprint.length, 64);
    assert.equal(fetchFn.calls.length, 0);
  });

  it("search GET v1 drops t===1 and sends Bot header plus site:", async () => {
    const fetchFn = makeFetchRecorder();
    const adapter = createKagiDescriptor({ transport: { fetch: fetchFn } }).create({
      env: { KAGI_API_KEY: "k" },
    });
    const rows = await adapter.search.invoke({
      query: "linux scheduler",
      controls: { domain: "kernel.org" },
    });
    assert.equal(fetchFn.calls.length, 1);
    const parsed = new URL(fetchFn.calls[0].url);
    assert.equal(`${parsed.origin}${parsed.pathname}`, "https://kagi.com/api/v1/search");
    assert.match(parsed.searchParams.get("q"), /site:kernel\.org/);
    assert.equal(parsed.searchParams.get("limit"), "10");
    assert.equal(header(fetchFn.calls[0].init, "Authorization"), "Bot k");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].url, "https://docs.kernel.org/scheduler/index.html");
    assert.equal(rows[0].title, "Linux Kernel Scheduler Documentation");
  });

  it("search topic news uses enrich/news", async () => {
    const fetchFn = makeFetchRecorder();
    const adapter = createKagiDescriptor({ transport: { fetch: fetchFn } }).create({
      env: { KAGI_API_KEY: "k" },
    });
    await adapter.search.invoke({ query: "q", controls: { topic: "news" } });
    assert.match(fetchFn.calls[0].url, /\/api\/v0\/enrich\/news/);
  });

  it("HTTP 401 maps to ConfigurationError", async () => {
    const fetchFn = makeFetchRecorder([jsonRes(KAGI_SEARCH_RAW, 401)]);
    const adapter = createKagiDescriptor({ transport: { fetch: fetchFn } }).create({
      env: { KAGI_API_KEY: "k" },
    });
    await assert.rejects(
      adapter.search.invoke({ query: "q" }),
      (e) => {
        assert.ok(e instanceof ConfigurationError);
        assert.equal(e.code, "CONFIGURATION_ERROR");
        assert.equal(e.exitCode, 3);
        return true;
      },
    );
  });

  it("HTTP 403 maps to QuotaError", async () => {
    const fetchFn = makeFetchRecorder([jsonRes(KAGI_SEARCH_RAW, 403)]);
    const adapter = createKagiDescriptor({ transport: { fetch: fetchFn } }).create({
      env: { KAGI_API_KEY: "k" },
    });
    await assert.rejects(adapter.search.invoke({ query: "q" }), QuotaError);
  });
});

// ---------------------------------------------------------------------------
// Diagnostics (T3)
// ---------------------------------------------------------------------------

describe("kagi diagnostics", () => {
  it("diagnostics.invoke GETs limit=1 and create() does not fetch", async () => {
    let calls = 0;
    const descriptor = createKagiDescriptor({
      transport: { fetch: async (url) => {
        calls += 1;
        assert.match(String(url), /limit=1/);
        return jsonRes(KAGI_SEARCH_RAW);
      } },
    });
    descriptor.create({ env: { KAGI_API_KEY: "k" } });
    assert.equal(calls, 0);
    await descriptor.create({ env: { KAGI_API_KEY: "k" } }).diagnostics.invoke({ probe: true });
    assert.equal(calls, 1);
  });

  it("diagnostics probe GETs v1 search with q=test and Bot auth", async () => {
    const fetchFn = makeFetchRecorder();
    const adapter = createKagiDescriptor({ transport: { fetch: fetchFn } }).create({
      env: { KAGI_API_KEY: "k" },
    });
    await adapter.diagnostics.invoke({ probe: true });
    assert.equal(fetchFn.calls.length, 1);
    const parsed = new URL(fetchFn.calls[0].url);
    assert.equal(`${parsed.origin}${parsed.pathname}`, "https://kagi.com/api/v1/search");
    assert.equal(parsed.searchParams.get("q"), "test");
    assert.equal(parsed.searchParams.get("limit"), "1");
    assert.equal(header(fetchFn.calls[0].init, "Authorization"), "Bot k");
  });

  it("diagnostics HTTP 401 maps to ConfigurationError", async () => {
    const adapter = createKagiDescriptor({
      transport: { fetch: async () => jsonRes({}, 401) },
    }).create({ env: { KAGI_API_KEY: "k" } });
    await assert.rejects(
      adapter.diagnostics.invoke({ probe: true }),
      (e) => {
        assert.ok(e instanceof ConfigurationError, `wrong type: ${e}`);
        assert.equal(e.exitCode, 3);
        return true;
      },
    );
  });

  it("invoke({probe:false}) resolves without any fetch call", async () => {
    let calls = 0;
    const adapter = createKagiDescriptor({
      transport: { fetch: async () => { calls += 1; return jsonRes(KAGI_SEARCH_RAW); } },
    }).create({ env: { KAGI_API_KEY: "k" } });
    await adapter.diagnostics.invoke({ probe: false });
    assert.equal(calls, 0);
  });

  it("a missing key throws ConfigurationError before any fetch", async () => {
    let calls = 0;
    const adapter = createKagiDescriptor({
      transport: { fetch: async () => { calls += 1; return jsonRes(KAGI_SEARCH_RAW); } },
    }).create({ env: {} });
    const err = await adapter.diagnostics.invoke({ probe: true }).then(() => null, (e) => e);
    assert.ok(err instanceof ConfigurationError, `wrong type: ${err}`);
    assert.equal(err.exitCode, 3);
    assert.equal(calls, 0);
  });

  it("capabilities() advertises exactly search and diagnostics", () => {
    const caps = [...createKagiDescriptor().capabilities()].sort();
    assert.deepEqual(caps, ["diagnostics", "search"]);
  });
});

// Shared helpers used by later tasks.
function jsonRes(json, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => json, text: async () => JSON.stringify(json), headers: { get: () => null } };
}
function header(init, name) {
  const h = init?.headers;
  if (!h) return undefined;
  if (typeof h.get === "function") return h.get(name);
  return h[name] ?? h[name.toLowerCase()];
}
