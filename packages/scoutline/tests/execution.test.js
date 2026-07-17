/**
 * Shared Search Execution — Provider-partitioned cache + retry (P2-02).
 *
 * Drives `executeSearch` and `executeProviderOperation` with fake
 * capabilities, fake cache, fake sleep, and a deterministic random
 * source so the exact ordering, retry, and cache-key partitioning
 * behaviour can be asserted without touching disk or process globals.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { executeSearch, executeProviderOperation } from "../dist/lib/execution.js";
import { buildProviderCacheKey } from "../dist/lib/cache.js";
import {
  ValidationError,
  AuthError,
  ApiError,
  TimeoutError,
  NetworkError,
  UnsupportedCapabilityError,
} from "../dist/lib/errors.js";

// ---------------------------------------------------------------------------
// Helpers: fakes
// ---------------------------------------------------------------------------

/** Deterministic random in [0, 1). Returns a fixed sequence. */
function makeRandom(sequence = [0.5]) {
  const queue = [...sequence];
  return () => {
    if (queue.length > 1) return queue.shift();
    return queue[0];
  };
}

function makeSleep() {
  const calls = [];
  const sleep = (ms) => {
    calls.push(ms);
    return Promise.resolve();
  };
  sleep.calls = calls;
  return sleep;
}

/** In-memory ResponseCache double. Records every get/set with the key. */
function makeCache(seed = {}) {
  const store = new Map(seed instanceof Map ? Array.from(seed.entries()) : Object.entries(seed));
  const reads = [];
  const writes = [];
  const cache = {
    reads,
    writes,
    async get(key) {
      reads.push(key);
      return store.has(key) ? store.get(key) : null;
    },
    async set(key, value) {
      writes.push({ key, value });
      store.set(key, value);
    },
    store,
  };
  return cache;
}

/** Fake SearchCapability that records every interaction in order. */
function makeCapability({
  id = "zai",
  fingerprint = crypto.createHash("sha256").update("test-key").digest("hex"),
  results = [{ title: "T", url: "https://example.test/x", summary: "S" }],
  legacyCandidates,
  invokeImpl,
  identityRequestFilter,
} = {}) {
  const events = [];
  const cap = {
    events,
    fingerprint,
    id,
    invokeCount: 0,
    lastInvokeRequest: null,
    lastIdentityRequest: null,
    lastLegacyCount: undefined,
    validate(request) {
      events.push({ phase: "validate", query: request.query });
      if (!request.query || !String(request.query).trim()) {
        throw new ValidationError("Query must not be empty");
      }
    },
    cacheIdentity(request, compatibility) {
      const filtered = identityRequestFilter
        ? identityRequestFilter(request)
        : { query: request.query, controls: request.controls };
      cap.lastIdentityRequest = filtered;
      cap.lastLegacyCount = compatibility?.legacyCount;
      events.push({
        phase: "cacheIdentity",
        legacyCount: compatibility?.legacyCount,
      });
      return {
        provider: id,
        capability: "search",
        credentialFingerprint: fingerprint,
        request: filtered,
        legacyCandidates,
      };
    },
    async invoke(request) {
      cap.invokeCount += 1;
      cap.lastInvokeRequest = {
        query: request.query,
        controls: request.controls,
      };
      events.push({ phase: "invoke", attempt: cap.invokeCount });
      if (invokeImpl) return invokeImpl(cap.invokeCount);
      return results.slice();
    },
  };
  return cap;
}

const baseOptions = (extra = {}) => ({ noCache: false, ...extra });

const baseDeps = (cache, sleep, random) => ({ cache, sleep, random });

// ---------------------------------------------------------------------------
// Order: validate → new-key read → optional legacy-key read → invoke →
//        retry delays → new-key write → count truncation
// ---------------------------------------------------------------------------

describe("executeSearch — ordered execution", () => {
  it("records validate → new-key read → invoke → new-key write → count truncate", async () => {
    const sleep = makeSleep();
    const random = makeRandom();
    const cache = makeCache();
    const cap = makeCapability({
      results: [1, 2, 3].map((n) => ({
        title: `T${n}`,
        url: `https://x/${n}`,
        summary: `S${n}`,
      })),
    });

    const out = await executeSearch(
      cap,
      { query: "hello" },
      { count: 2, ...baseOptions() },
      baseDeps(cache, sleep, random),
    );

    // Validate ran first.
    assert.strictEqual(cap.events[0].phase, "validate");
    // Then identity.
    assert.strictEqual(cap.events[1].phase, "cacheIdentity");
    assert.strictEqual(cap.events[1].legacyCount, 2);
    // Then exactly one cache read for the new key.
    assert.deepStrictEqual(cache.reads, [
      buildProviderCacheKey({
        provider: "zai",
        capability: "search",
        credentialFingerprint: cap.fingerprint,
        request: cap.lastIdentityRequest,
      }),
    ]);
    // Then one invoke.
    assert.strictEqual(cap.invokeCount, 1);
    // Then exactly one cache write for the new key with the FULL result.
    assert.strictEqual(cache.writes.length, 1);
    assert.strictEqual(cache.writes[0].value.length, 3);
    // Count truncation applied only to the return value.
    assert.strictEqual(out.length, 2);
  });

  it("reads legacy candidate after a new-key miss before invoking", async () => {
    const sleep = makeSleep();
    const random = makeRandom();
    const legacyKey = "search.webSearch.abc.def.json";
    const legacyValue = [{ title: "L", link: "https://l", content: "lc", media: "m" }];
    const cache = makeCache({ [legacyKey]: legacyValue });
    const cap = makeCapability({
      legacyCandidates: [
        {
          key: legacyKey,
          decode(raw) {
            if (!Array.isArray(raw)) return null;
            return raw.map((r) => ({
              title: r.title,
              url: r.link,
              summary: r.content,
              source: r.media,
            }));
          },
        },
      ],
    });

    const out = await executeSearch(
      cap,
      { query: "legacy" },
      baseOptions(),
      baseDeps(cache, sleep, random),
    );

    // Two reads: new key then legacy key.
    assert.strictEqual(cache.reads.length, 2);
    assert.strictEqual(cache.reads[1], legacyKey);
    // Invoked never.
    assert.strictEqual(cap.invokeCount, 0);
    // Wrote the new key.
    assert.strictEqual(cache.writes.length, 1);
    // Returned decoded value.
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].title, "L");
  });

  it("does not read legacy candidates when capability advertises none (MiniMax)", async () => {
    const sleep = makeSleep();
    const random = makeRandom();
    const cache = makeCache();
    const cap = makeCapability({ id: "minimax" });

    await executeSearch(cap, { query: "mm" }, baseOptions(), baseDeps(cache, sleep, random));

    assert.strictEqual(cache.reads.length, 1, "exactly one read — new key only");
    assert.strictEqual(cap.invokeCount, 1);
  });

  it("returns from cache without invoking or retrying on a new-key hit", async () => {
    const sleep = makeSleep();
    const random = makeRandom();
    const cap = makeCapability();
    const newKey = buildProviderCacheKey({
      provider: "zai",
      capability: "search",
      credentialFingerprint: cap.fingerprint,
      request: { query: "cached" },
    });
    const cached = [{ title: "C", url: "https://c", summary: "cs" }];
    const cache = makeCache({ [newKey]: cached });

    const out = await executeSearch(
      cap,
      { query: "cached" },
      baseOptions(),
      baseDeps(cache, sleep, random),
    );

    assert.strictEqual(cap.invokeCount, 0);
    assert.strictEqual(sleep.calls.length, 0);
    assert.strictEqual(cache.writes.length, 0);
    assert.deepStrictEqual(out, cached);
  });
});

// ---------------------------------------------------------------------------
// Count behaviour
// ---------------------------------------------------------------------------

describe("executeSearch — cache failure and bypass semantics", () => {
  it("--no-cache bypasses a cached value, invokes the provider, and performs no write", async () => {
    const cap = makeCapability({
      results: [{ title: "fresh", url: "https://fresh.test", summary: "fresh" }],
    });
    const cache = {
      async get() {
        throw new Error("cache reads must be bypassed");
      },
      async set() {
        throw new Error("cache writes must be bypassed");
      },
    };
    const result = await executeSearch(
      cap,
      { query: "fresh" },
      { noCache: true },
      baseDeps(cache, makeSleep(), makeRandom()),
    );
    assert.deepStrictEqual(result, [
      { title: "fresh", url: "https://fresh.test", summary: "fresh" },
    ]);
    assert.strictEqual(cap.invokeCount, 1);
  });

  it("cache read failures surface before provider invocation", async () => {
    const cap = makeCapability();
    const failure = new Error("cache read failed");
    const cache = {
      async get() {
        throw failure;
      },
      async set() {
        assert.fail("write must not run after a read failure");
      },
    };
    await assert.rejects(
      executeSearch(
        cap,
        { query: "q" },
        baseOptions(),
        baseDeps(cache, makeSleep(), makeRandom()),
      ),
      failure,
    );
    assert.strictEqual(cap.invokeCount, 0);
  });

  it("cache write failures surface after a successful provider invocation", async () => {
    const cap = makeCapability();
    const failure = new Error("cache write failed");
    const cache = {
      async get() {
        return null;
      },
      async set() {
        throw failure;
      },
    };
    await assert.rejects(
      executeSearch(
        cap,
        { query: "q" },
        baseOptions(),
        baseDeps(cache, makeSleep(), makeRandom()),
      ),
      failure,
    );
    assert.strictEqual(cap.invokeCount, 1);
  });
});

describe("executeSearch — count truncation", () => {
  const results = [1, 2, 3, 4].map((n) => ({
    title: `T${n}`,
    url: `https://x/${n}`,
    summary: `S${n}`,
  }));

  it("count zero returns an empty list after cache + normalization", async () => {
    const cache = makeCache();
    const cap = makeCapability({ results });
    const out = await executeSearch(
      cap,
      { query: "q" },
      { count: 0, noCache: true },
      baseDeps(cache, makeSleep(), makeRandom()),
    );
    assert.deepStrictEqual(out, []);
    // The full result was still normalized internally.
    assert.strictEqual(cap.invokeCount, 1);
  });

  it("positive count slices the normalized result", async () => {
    const cache = makeCache();
    const cap = makeCapability({ results });
    const out = await executeSearch(
      cap,
      { query: "q" },
      { count: 2, noCache: true },
      baseDeps(cache, makeSleep(), makeRandom()),
    );
    assert.strictEqual(out.length, 2);
  });

  it("absent count returns all results", async () => {
    const cache = makeCache();
    const cap = makeCapability({ results });
    const out = await executeSearch(
      cap,
      { query: "q" },
      { noCache: true },
      baseDeps(cache, makeSleep(), makeRandom()),
    );
    assert.strictEqual(out.length, results.length);
  });

  it("count never enters the cache identity request or invoke request", async () => {
    const cache = makeCache();
    const cap = makeCapability({ results });
    await executeSearch(
      cap,
      { query: "isolate" },
      { count: 5, noCache: true },
      baseDeps(cache, makeSleep(), makeRandom()),
    );
    // legacyCount carried through to identity.
    assert.strictEqual(cap.lastLegacyCount, 5);
    // But the identity request itself has no count.
    assert.strictEqual(cap.lastIdentityRequest.count, undefined);
    // And the invoke request has no count.
    assert.strictEqual(cap.lastInvokeRequest.count, undefined);
  });

  it("different counts produce the same new key", async () => {
    const cap1 = makeCapability({ results });
    const cap2 = makeCapability({ results });
    const cache1 = makeCache();
    const cache2 = makeCache();
    await executeSearch(
      cap1,
      { query: "k" },
      { count: 1, noCache: false },
      baseDeps(cache1, makeSleep(), makeRandom()),
    );
    await executeSearch(
      cap2,
      { query: "k" },
      { count: 9, noCache: false },
      baseDeps(cache2, makeSleep(), makeRandom()),
    );
    assert.strictEqual(cache1.writes[0].key, cache2.writes[0].key);
  });

  it("different queries produce different new keys", async () => {
    const cap1 = makeCapability({ results });
    const cap2 = makeCapability({ results });
    const cache1 = makeCache();
    const cache2 = makeCache();
    await executeSearch(
      cap1,
      { query: "alpha" },
      { noCache: false },
      baseDeps(cache1, makeSleep(), makeRandom()),
    );
    await executeSearch(
      cap2,
      { query: "beta" },
      { noCache: false },
      baseDeps(cache2, makeSleep(), makeRandom()),
    );
    assert.notStrictEqual(cache1.writes[0].key, cache2.writes[0].key);
  });
});

// ---------------------------------------------------------------------------
// Retry behaviour
// ---------------------------------------------------------------------------

describe("executeSearch — retry policy", () => {
  it("validation, auth, and unsupported errors receive zero retries", async () => {
    for (const ErrorCtor of [ValidationError, AuthError, UnsupportedCapabilityError]) {
      const sleep = makeSleep();
      const random = makeRandom();
      const cap = makeCapability({
        invokeImpl: () => {
          throw new ErrorCtor("boom");
        },
      });
      await assert.rejects(
        executeSearch(cap, { query: "q" }, { noCache: true }, baseDeps(makeCache(), sleep, random)),
      );
      assert.strictEqual(sleep.calls.length, 0, `${ErrorCtor.name} must not retry`);
      assert.strictEqual(cap.invokeCount, 1);
    }
  });

  it("retryable timeout uses injected sleep+random and stops at the retry limit", async () => {
    const sleep = makeSleep();
    const random = makeRandom([0.4]);
    let count = 0;
    const cap = makeCapability({
      invokeImpl: () => {
        count += 1;
        if (count === 1) throw new TimeoutError(1000);
        return [{ title: "ok", url: "u", summary: "s" }];
      },
    });
    const out = await executeSearch(
      cap,
      { query: "q" },
      { noCache: true },
      baseDeps(makeCache(), sleep, random),
    );
    assert.strictEqual(cap.invokeCount, 2);
    assert.strictEqual(sleep.calls.length, 1);
    // baseDelayMs * 2^0 = 500, jitter floor(0.4 * 250) = 100
    assert.strictEqual(sleep.calls[0], 500 + 100);
    assert.strictEqual(out.length, 1);
  });

  it("network and 5xx/429 API errors are retryable", async () => {
    const cases = [
      () => new NetworkError("down"),
      () => new ApiError("rate", 429),
      () => new ApiError("s", 500),
      () => new ApiError("s", 502),
      () => new ApiError("s", 503),
      () => new ApiError("s", 504),
    ];
    for (const makeErr of cases) {
      const sleep = makeSleep();
      const random = makeRandom();
      let count = 0;
      const cap = makeCapability({
        invokeImpl: () => {
          count += 1;
          if (count === 1) throw makeErr();
          return [{ title: "T", url: "u", summary: "s" }];
        },
      });
      const out = await executeSearch(
        cap,
        { query: "q" },
        { noCache: true },
        baseDeps(makeCache(), sleep, random),
      );
      assert.strictEqual(cap.invokeCount, 2);
      assert.strictEqual(sleep.calls.length, 1);
      assert.strictEqual(out.length, 1);
    }
  });

  it("stops at retry limit when every attempt fails", async () => {
    const sleep = makeSleep();
    const random = makeRandom();
    const cap = makeCapability({
      invokeImpl: () => {
        throw new TimeoutError(1000);
      },
    });
    await assert.rejects(
      executeSearch(cap, { query: "q" }, { noCache: true }, baseDeps(makeCache(), sleep, random)),
    );
    // Search default = 1 retry → 2 total attempts.
    assert.strictEqual(cap.invokeCount, 2);
    assert.strictEqual(sleep.calls.length, 1);
  });

  it("non-retryable API status codes do not retry", async () => {
    const sleep = makeSleep();
    const random = makeRandom();
    const cap = makeCapability({
      invokeImpl: () => {
        throw new ApiError("bad", 400);
      },
    });
    await assert.rejects(
      executeSearch(cap, { query: "q" }, { noCache: true }, baseDeps(makeCache(), sleep, random)),
    );
    assert.strictEqual(cap.invokeCount, 1);
    assert.strictEqual(sleep.calls.length, 0);
  });

  it("executeProviderOperation honours a custom retry policy", async () => {
    const sleep = makeSleep();
    const random = makeRandom([0]);
    let count = 0;
    const out = await executeProviderOperation(
      "search",
      async () => {
        count += 1;
        if (count <= 3) throw new NetworkError("down");
        return "done";
      },
      { sleep, random },
      { maxRetries: 3, baseDelayMs: 100, maxDelayMs: 1000, jitterMs: 0 },
    );
    assert.strictEqual(out, "done");
    assert.strictEqual(count, 4);
    assert.strictEqual(sleep.calls.length, 3);
    // backoff sequence: 100, 200, 400 (capped at 1000)
    assert.deepStrictEqual(sleep.calls, [100, 200, 400]);
  });
});

// ---------------------------------------------------------------------------
// Provider / credential / query isolation
// ---------------------------------------------------------------------------

describe("executeSearch — provider partition isolation", () => {
  it("Z.AI and MiniMax keys differ for the same query and key text", async () => {
    const fingerprint = crypto.createHash("sha256").update("shared-key").digest("hex");
    const cacheZai = makeCache();
    const cacheMm = makeCache();
    const capZai = makeCapability({ id: "zai", fingerprint, results: [] });
    const capMm = makeCapability({ id: "minimax", fingerprint, results: [] });
    await executeSearch(
      capZai,
      { query: "q" },
      { noCache: false },
      baseDeps(cacheZai, makeSleep(), makeRandom()),
    );
    await executeSearch(
      capMm,
      { query: "q" },
      { noCache: false },
      baseDeps(cacheMm, makeSleep(), makeRandom()),
    );
    assert.notStrictEqual(cacheZai.writes[0].key, cacheMm.writes[0].key);
  });

  it("different credential fingerprints differ for the same provider and query", async () => {
    const fp1 = crypto.createHash("sha256").update("k1").digest("hex");
    const fp2 = crypto.createHash("sha256").update("k2").digest("hex");
    const cache1 = makeCache();
    const cache2 = makeCache();
    const cap1 = makeCapability({ id: "zai", fingerprint: fp1, results: [] });
    const cap2 = makeCapability({ id: "zai", fingerprint: fp2, results: [] });
    await executeSearch(
      cap1,
      { query: "q" },
      { noCache: false },
      baseDeps(cache1, makeSleep(), makeRandom()),
    );
    await executeSearch(
      cap2,
      { query: "q" },
      { noCache: false },
      baseDeps(cache2, makeSleep(), makeRandom()),
    );
    assert.notStrictEqual(cache1.writes[0].key, cache2.writes[0].key);
  });

  it("projection/truncation/output mode never enter cache identity", async () => {
    const seen = new Set();
    const capturingFilter = (request) => {
      const filtered = { query: request.query, controls: request.controls };
      const key = JSON.stringify(filtered);
      seen.add(key);
      return filtered;
    };
    // Three invocations with different presentational concerns.
    for (const opts of [{ count: 1 }, { count: 5 }, {}]) {
      const cache = makeCache();
      const cap = makeCapability({
        results: [{ title: "T", url: "u", summary: "s" }],
        identityRequestFilter: capturingFilter,
      });
      await executeSearch(
        cap,
        { query: "same" },
        { noCache: false, ...opts },
        baseDeps(cache, makeSleep(), makeRandom()),
      );
    }
    // All three produced the same identity request.
    assert.strictEqual(seen.size, 1);
  });
});

// ---------------------------------------------------------------------------
// Legacy Z.AI compatibility
// ---------------------------------------------------------------------------

describe("executeSearch — legacy Z.AI cache compatibility", () => {
  it("legacy hit populates new key but never writes or deletes the legacy file", async () => {
    const legacyKey = "search.webSearch.old.json";
    const legacyValue = [
      { title: "L1", link: "https://l1", content: "lc1", media: "m1", publish_date: "2024-01-01" },
    ];
    const cache = makeCache({ [legacyKey]: legacyValue });
    const cap = makeCapability({
      legacyCandidates: [
        {
          key: legacyKey,
          decode(raw) {
            if (!Array.isArray(raw)) return null;
            return raw.map((r) => ({
              title: r.title,
              url: r.link,
              summary: r.content,
              source: r.media,
              date: r.publish_date,
            }));
          },
        },
      ],
    });

    const out = await executeSearch(
      cap,
      { query: "legacy" },
      baseOptions(),
      baseDeps(cache, makeSleep(), makeRandom()),
    );

    // Legacy file still in store, untouched.
    assert.deepStrictEqual(cache.store.get(legacyKey), legacyValue);
    // Writes: only the new key.
    assert.strictEqual(cache.writes.length, 1);
    assert.notStrictEqual(cache.writes[0].key, legacyKey);
    // Returned normalized shape.
    assert.strictEqual(out[0].url, "https://l1");
    assert.strictEqual(out[0].source, "m1");
    assert.strictEqual(out[0].date, "2024-01-01");
  });

  it("invalid legacy data is a miss and falls through to invoke", async () => {
    const legacyKey = "search.webSearch.bad.json";
    const cache = makeCache({ [legacyKey]: "not-an-array" });
    const cap = makeCapability({
      legacyCandidates: [
        {
          key: legacyKey,
          decode(raw) {
            return Array.isArray(raw) ? raw : null;
          },
        },
      ],
    });
    const out = await executeSearch(
      cap,
      { query: "fallthrough" },
      baseOptions(),
      baseDeps(cache, makeSleep(), makeRandom()),
    );
    assert.strictEqual(cap.invokeCount, 1);
    assert.strictEqual(out.length, 1);
  });
});
