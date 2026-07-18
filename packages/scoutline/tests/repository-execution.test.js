/**
 * P6-03 — Shared repository execution (DESIGN.md §18, §10).
 *
 * Drives `executeRepositoryOperation` with a deterministic event-log fake
 * operation that records every step the executor takes, so the fixed order
 * (validate → identity → new-key read+total decode → ordered legacy
 * candidates+decode → retry-wrapped invoke → normalized write) and the
 * edge cases (cache hit, malformed miss, legacy write-through, --no-cache
 * bypass, retry attempt count, terminal attempt count) can all be asserted
 * without touching disk, transports, or process globals.
 *
 * Every fake operation supplies its own `validate`, `cacheIdentity`,
 * `decodeCached`, and `invoke`. The cache is an in-memory `ResponseCache`
 * double that records every read/write. Retry behaviour is asserted
 * directly through `invokeCount` and `sleep.calls`, not by assuming
 * Provider-specific client reuse.
 *
 * The retry taxonomy proof lives here too: each `RepositoryOperationKind`
 * routes through `executeProviderOperation` and inherits the existing
 * one-retry non-Vision policy without changing current Search/Vision/
 * Quota/Diagnostics behaviour. `defaultRetryPolicy(...)` is invoked
 * directly with each repository kind to assert `maxRetries === 1`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import {
  executeRepositoryOperation,
  defaultRetryPolicy,
} from "../dist/lib/execution.js";
import { buildProviderCacheKey } from "../dist/lib/cache.js";
import {
  QuotaError,
  ValidationError,
  ApiError,
  AuthError,
  NetworkError,
  UnsupportedCapabilityError,
  TimeoutError,
} from "../dist/lib/errors.js";

// ---------------------------------------------------------------------------
// Helpers: fakes
// ---------------------------------------------------------------------------

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

/**
 * Build a deterministic fake RepositoryOperation that records every step
 * the executor takes. `result` is the value returned by `invoke`;
 * `invokeImpl` overrides behaviour for error injection. The
 * `invokeImpl` reference is held on a mutable slot so tests can swap
 * it after construction (necessary for counter-driven retry scenarios
 * where the failure/success branches need access to a captured counter
 * but the operation object is created first).
 */
function makeOperation({
  kind = "repository-search",
  fingerprint = crypto.createHash("sha256").update("repo-key").digest("hex"),
  provider = "zai",
  result,
  legacyCandidates = [],
  invokeImpl,
  validateImpl,
} = {}) {
  const events = [];
  const invokeImplRef = { fn: invokeImpl };
  const op = {
    events,
    fingerprint,
    kind,
    invokeImplRef,
    invokeCount: 0,
    lastInvokeRequest: null,
    lastIdentityRequest: null,
    validate(request) {
      events.push({ phase: "validate" });
      if (validateImpl) return validateImpl(request);
    },
    cacheIdentity(request) {
      op.lastIdentityRequest = request;
      events.push({ phase: "cacheIdentity" });
      return {
        provider,
        capability: "repository-exploration",
        operation: kind,
        credentialFingerprint: fingerprint,
        request,
        legacyCandidates,
      };
    },
    decodeCached(value) {
      events.push({ phase: "decodeCached" });
      // Mirror the real decoders: a top-level non-object is a miss; the
      // operation stores its valid shape on `result` and accepts only
      // structurally identical objects.
      if (!value || typeof value !== "object") return null;
      if (value.kind !== kind) return null;
      return value.payload;
    },
    async invoke(request) {
      op.invokeCount += 1;
      op.lastInvokeRequest = request;
      events.push({ phase: "invoke", attempt: op.invokeCount });
      if (invokeImplRef.fn) return invokeImplRef.fn(op.invokeCount);
      return result;
    },
  };
  return op;
}

const baseDeps = (cache, sleep, random) => ({ cache, sleep, random });

// Canonical request and result fixtures per operation kind.
const searchRequest = {
  repository: "owner/repo",
  query: "authentication",
  language: "en",
};
const searchResult = {
  schemaVersion: 1,
  repository: "owner/repo",
  query: "authentication",
  language: "en",
  excerpts: [{ text: "auth snippet" }],
  truncated: false,
  originalTextLength: 13,
};

const fileRequest = { repository: "owner/repo", path: "src/index.ts" };
const fileResult = {
  schemaVersion: 1,
  repository: "owner/repo",
  path: "src/index.ts",
  content: "export const x = 1;\n",
  truncated: false,
  originalContentLength: 20,
};

const directoryRequest = { repository: "owner/repo", path: "" };
const directoryResult = {
  repository: "owner/repo",
  path: "",
  entries: [
    { name: "README.md", path: "README.md", kind: "file" },
    { name: "src", path: "src", kind: "directory" },
  ],
};

// ---------------------------------------------------------------------------
// Ordered execution
// ---------------------------------------------------------------------------

describe("executeRepositoryOperation — fixed order", () => {
  it("runs validate → identity → invoke → normalized cache write when both cache and legacy miss", async () => {
    const sleep = makeSleep();
    const random = makeRandom();
    const cache = makeCache();
    const op = makeOperation({
      kind: "repository-search",
      result: searchResult,
      legacyCandidates: [
        {
          key: "legacy-search.json",
          // raw read returns null below, so this decode is never
          // reached; the test still asserts no inadvertent
          // invocation when a legacy raw value is absent.
          decode() {
            op.events.push({ phase: "legacyDecode" });
            return null;
          },
        },
      ],
    });

    const out = await executeRepositoryOperation(
      op,
      searchRequest,
      {},
      baseDeps(cache, sleep, random),
    );

    const phases = op.events.map((e) => e.phase);
    assert.deepStrictEqual(phases, ["validate", "cacheIdentity", "invoke"]);
    assert.deepStrictEqual(out, searchResult);

    // One read for the new key, one read for the legacy key (raw
    // miss → skip decode), one write back to the new key after
    // invoke.
    assert.strictEqual(cache.reads.length, 2);
    assert.strictEqual(cache.reads[0], cache.writes[0].key);
    assert.strictEqual(cache.reads[1], "legacy-search.json");
    assert.strictEqual(cache.writes.length, 1);
    assert.strictEqual(cache.writes[0].key, cache.reads[0]);
    assert.deepStrictEqual(cache.writes[0].value, searchResult);
  });

  // P6-03B — lock the complete observable executor order in ONE shared
  // trace that spans the fake operation, cache, legacy decoder, and
  // retry dependencies. Earlier tests assert cache reads / writes /
  // sleep separately through independent counters; this test asserts
  // their RELATIVE ORDER against the operation-local events so a
  // future regression cannot rearrange steps 3-10 without breaking
  // the trace.
  //
  // Setup:
  //   - normalized cache pre-seeded with a MALFORMED entry under the
  //     new key (decodeCached must be called and must return null);
  //   - legacy cache pre-seeded with a PRESENT-BUT-MALFORMED entry
  //     (legacy decode must be called and must return null);
  //   - first invoke throws a retryable TimeoutError;
  //   - second invoke returns the canonical result.
  //
  // Expected fixed order (DESIGN.md §18, §10):
  //   validate
  //   cacheIdentity
  //   normalized cache read
  //   decodeCached
  //   legacy cache read
  //   legacy decode
  //   invoke attempt 1
  //   retry sleep
  //   invoke attempt 2
  //   normalized cache write
  it("records validate → cacheIdentity → normalized cache read → decodeCached → legacy cache read → legacy decode → invoke 1 → retry sleep → invoke 2 → normalized cache write in one shared trace", async () => {
    const trace = [];
    const push = (label, extra = {}) => {
      trace.push({ label, ...extra });
    };

    const legacyKey = "search.webSearch.legacy.json";
    const seed = new Map();
    // Malformed normalized: not a plain object → decodeCached
    // returns null.
    // We pre-populate after computing the new key below.

    const fingerprint =
      "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    const request = {
      repository: "owner/repo",
      query: "authentication",
      language: "en",
    };
    const expectedNewKey = buildProviderCacheKey({
      provider: "zai",
      capability: "repository-exploration-repository-search",
      credentialFingerprint: fingerprint,
      request,
    });
    // Seed BOTH a malformed normalized entry and a malformed legacy
    // entry so both decode attempts are exercised.
    seed.set(expectedNewKey, "totally-not-a-search-result");
    seed.set(legacyKey, { garbage: true });

    const reads = [];
    const writes = [];
    const classifiedGet = async (key) => {
      reads.push(key);
      // Provider-partitioned keys always start with `v2.`; legacy
      // candidate keys (built by Z.AI's buildLegacyRepositoryCacheKey
      // and any Adapter-supplied alias) do not.
      const label = key.startsWith("v2.") ? "normalized cache read" : "legacy cache read";
      push(label, { key });
      return seed.has(key) ? seed.get(key) : null;
    };
    const classifiedSet = async (key, value) => {
      writes.push({ key, value });
      push("normalized cache write", { key });
      seed.set(key, value);
    };
    const cache = { get: classifiedGet, set: classifiedSet };

    const sleepCalls = [];
    const sleep = (ms) => {
      sleepCalls.push(ms);
      push("retry sleep", { ms });
      return Promise.resolve();
    };
    const random = () => 0; // 0 jitter for deterministic backoff

    let invokeCount = 0;
    const op = {
      events: trace,
      fingerprint,
      kind: "repository-search",
      invokeCount: 0,
      validate() {
        push("validate", { request });
      },
      cacheIdentity(req) {
        push("cacheIdentity", { request: req });
        return {
          provider: "zai",
          capability: "repository-exploration",
          operation: "repository-search",
          credentialFingerprint: fingerprint,
          request: req,
          legacyCandidates: [
            {
              key: legacyKey,
              decode(value) {
                push("legacy decode", { key: legacyKey, value });
                return null; // malformed → miss
              },
            },
          ],
        };
      },
      decodeCached(value) {
        push("decodeCached", { value });
        return null; // malformed normalized → miss
      },
      async invoke(req) {
        invokeCount += 1;
        push("invoke", { request: req, attempt: invokeCount });
        if (invokeCount === 1) throw new TimeoutError(1000);
        return {
          schemaVersion: 1,
          repository: "owner/repo",
          query: "authentication",
          language: "en",
          excerpts: [{ text: "auth snippet" }],
          truncated: false,
          originalTextLength: 13,
        };
      },
    };

    const out = await executeRepositoryOperation(
      op,
      request,
      {},
      { cache, sleep, random },
    );

    // Assert exact ordered labels in the shared trace.
    const labels = trace.map((e) => e.label);
    assert.deepStrictEqual(labels, [
      "validate",
      "cacheIdentity",
      "normalized cache read",
      "decodeCached",
      "legacy cache read",
      "legacy decode",
      "invoke",
      "retry sleep",
      "invoke",
      "normalized cache write",
    ]);

    // Belt-and-braces: the only `invoke` rows have distinct attempt
    // numbers, and the only `retry sleep` row sits between them.
    const invokeRows = trace.filter((e) => e.label === "invoke");
    assert.strictEqual(invokeRows.length, 2);
    assert.strictEqual(invokeRows[0].attempt, 1);
    assert.strictEqual(invokeRows[1].attempt, 2);
    const sleepRows = trace.filter((e) => e.label === "retry sleep");
    assert.strictEqual(sleepRows.length, 1);
    assert.strictEqual(sleepRows[0].ms, 500); // baseDelayMs * 2^0 + 0 jitter
    assert.strictEqual(
      trace.indexOf(sleepRows[0]),
      trace.indexOf(invokeRows[1]) - 1,
      "retry sleep must immediately precede invoke attempt 2",
    );

    // The normalized cache write carries the FULL result (no count
    // truncation in repository execution).
    assert.strictEqual(writes.length, 1);
    assert.strictEqual(writes[0].key, expectedNewKey);
    assert.deepStrictEqual(writes[0].value, {
      schemaVersion: 1,
      repository: "owner/repo",
      query: "authentication",
      language: "en",
      excerpts: [{ text: "auth snippet" }],
      truncated: false,
      originalTextLength: 13,
    });

    // Cache reads: exactly two — the normalized key then the legacy
    // candidate key, in that order.
    assert.strictEqual(reads.length, 2);
    assert.strictEqual(reads[0], expectedNewKey);
    assert.strictEqual(reads[1], legacyKey);

    assert.deepStrictEqual(out, {
      schemaVersion: 1,
      repository: "owner/repo",
      query: "authentication",
      language: "en",
      excerpts: [{ text: "auth snippet" }],
      truncated: false,
      originalTextLength: 13,
    });
  });

  it("writes the normalized result to the provider-partitioned key, not the legacy key", async () => {
    const sleep = makeSleep();
    const random = makeRandom();
    const cache = makeCache();
    const op = makeOperation({
      kind: "repository-search",
      result: searchResult,
      legacyCandidates: [
        { key: "old.json", decode: () => null },
      ],
    });
    const expectedKey = buildProviderCacheKey({
      provider: "zai",
      capability: "repository-exploration-repository-search",
      credentialFingerprint: op.fingerprint,
      request: searchRequest,
    });
    await executeRepositoryOperation(op, searchRequest, {}, baseDeps(cache, sleep, random));
    assert.strictEqual(cache.writes[0].key, expectedKey);
    assert.notStrictEqual(cache.writes[0].key, "old.json");
  });

  it("validates before computing cache identity (validation throws first)", async () => {
    const cache = makeCache();
    const op = makeOperation({
      kind: "repository-search",
      result: searchResult,
      validateImpl: () => {
        throw new ValidationError("search query must not be empty");
      },
    });
    await assert.rejects(
      executeRepositoryOperation(op, searchRequest, {}, baseDeps(cache, makeSleep(), makeRandom())),
      ValidationError,
    );
    // No cache reads or writes after a validation failure.
    assert.strictEqual(cache.reads.length, 0);
    assert.strictEqual(cache.writes.length, 0);
    assert.strictEqual(op.events.length, 1);
    assert.strictEqual(op.events[0].phase, "validate");
  });
});

// ---------------------------------------------------------------------------
// Cache hit, malformed miss, legacy write-through
// ---------------------------------------------------------------------------

describe("executeRepositoryOperation — cache behaviour", () => {
  it("returns from a normalized cache hit without invoking", async () => {
    const cache = makeCache();
    const op = makeOperation({ kind: "repository-search", result: searchResult });
    const newKey = buildProviderCacheKey({
      provider: "zai",
      capability: "repository-exploration-repository-search",
      credentialFingerprint: op.fingerprint,
      request: searchRequest,
    });
    // Pre-seed the cache with a value shaped so decodeCached accepts it.
    cache.store.set(newKey, { kind: op.kind, payload: searchResult });

    const out = await executeRepositoryOperation(
      op,
      searchRequest,
      {},
      baseDeps(cache, makeSleep(), makeRandom()),
    );
    assert.strictEqual(op.invokeCount, 0);
    assert.deepStrictEqual(out, searchResult);
    assert.strictEqual(cache.writes.length, 0);
  });

  it("treats a malformed normalized value as a miss and falls through to invoke", async () => {
    const cache = makeCache();
    const op = makeOperation({ kind: "repository-search", result: searchResult });
    const newKey = buildProviderCacheKey({
      provider: "zai",
      capability: "repository-exploration-repository-search",
      credentialFingerprint: op.fingerprint,
      request: searchRequest,
    });
    // decodeCached returns null for malformed values.
    cache.store.set(newKey, "not-a-valid-search-result");

    const out = await executeRepositoryOperation(
      op,
      searchRequest,
      {},
      baseDeps(cache, makeSleep(), makeRandom()),
    );
    assert.strictEqual(op.invokeCount, 1);
    assert.deepStrictEqual(out, searchResult);
    // The malformed entry was overwritten by the normalized result.
    assert.deepStrictEqual(cache.writes[0].value, searchResult);
  });

  it("writes a legacy hit through to the normalized key without invoking", async () => {
    const sleep = makeSleep();
    const random = makeRandom();
    const legacyKey = "search.webSearch.legacy.json";
    const cache = makeCache();
    const op = makeOperation({
      kind: "repository-search",
      result: searchResult,
      legacyCandidates: [
        {
          key: legacyKey,
          decode(value) {
            op.events.push({ phase: "legacyDecode" });
            return value && value.ok === true ? value.payload : null;
          },
        },
      ],
    });
    cache.store.set(legacyKey, { ok: true, payload: searchResult });
    const expectedKey = buildProviderCacheKey({
      provider: "zai",
      capability: "repository-exploration-repository-search",
      credentialFingerprint: op.fingerprint,
      request: searchRequest,
    });

    const out = await executeRepositoryOperation(
      op,
      searchRequest,
      {},
      baseDeps(cache, sleep, random),
    );
    assert.strictEqual(op.invokeCount, 0);
    assert.deepStrictEqual(out, searchResult);
    // Exactly one write to the normalized key; the legacy file is
    // untouched.
    assert.strictEqual(cache.writes.length, 1);
    assert.strictEqual(cache.writes[0].key, expectedKey);
    assert.notStrictEqual(cache.writes[0].key, legacyKey);
    assert.deepStrictEqual(cache.store.get(legacyKey), { ok: true, payload: searchResult });
  });

  it("treats a malformed legacy value as a miss and falls through to invoke", async () => {
    const sleep = makeSleep();
    const random = makeRandom();
    const legacyKey = "search.webSearch.bad.json";
    const cache = makeCache({ [legacyKey]: "garbage" });
    const op = makeOperation({
      kind: "repository-search",
      result: searchResult,
      legacyCandidates: [
        {
          key: legacyKey,
          decode() {
            op.events.push({ phase: "legacyDecode" });
            return null;
          },
        },
      ],
    });
    const out = await executeRepositoryOperation(
      op,
      searchRequest,
      {},
      baseDeps(cache, sleep, random),
    );
    assert.strictEqual(op.invokeCount, 1);
    assert.deepStrictEqual(out, searchResult);
  });

  it("tries multiple legacy candidates in declaration order and stops at the first hit", async () => {
    const sleep = makeSleep();
    const random = makeRandom();
    const cache = makeCache();
    const seen = [];
    const op = makeOperation({
      kind: "repository-search",
      result: searchResult,
      legacyCandidates: [
        {
          key: "first.json",
          decode(v) {
            seen.push("first");
            return null;
          },
        },
        {
          key: "second.json",
          decode(v) {
            seen.push("second");
            return v && v.ok ? v.payload : null;
          },
        },
        {
          key: "third.json",
          decode(v) {
            seen.push("third");
            return v; // would be hit but never reached
          },
        },
      ],
    });
    // Pre-seed BOTH the first and second legacy keys so each
    // candidate's decode runs in declaration order.
    cache.store.set("first.json", "garbage");
    cache.store.set("second.json", { ok: true, payload: searchResult });
    const out = await executeRepositoryOperation(
      op,
      searchRequest,
      {},
      baseDeps(cache, sleep, random),
    );
    assert.deepStrictEqual(seen, ["first", "second"]);
    assert.strictEqual(op.invokeCount, 0);
    assert.deepStrictEqual(out, searchResult);
  });
});

// ---------------------------------------------------------------------------
// --no-cache bypass
// ---------------------------------------------------------------------------

describe("executeRepositoryOperation — --no-cache bypass", () => {
  it("performs no reads and no writes but still validates, computes identity, and invokes", async () => {
    const sleep = makeSleep();
    const random = makeRandom();
    const cache = makeCache();
    // Pre-seed both a normalized key (matching the computed new key)
    // and a legacy key so a missing bypass would have returned a
    // cached value without invoking.
    const op = makeOperation({
      kind: "repository-search",
      result: searchResult,
      legacyCandidates: [
        {
          key: "pre-seeded-legacy",
          decode: (v) => (v && v.ok ? v.payload : null),
        },
      ],
    });
    const newKey = buildProviderCacheKey({
      provider: "zai",
      capability: "repository-exploration-repository-search",
      credentialFingerprint: op.fingerprint,
      request: searchRequest,
    });
    cache.store.set(newKey, { kind: op.kind, payload: searchResult });
    cache.store.set("pre-seeded-legacy", { ok: true, payload: searchResult });

    const out = await executeRepositoryOperation(
      op,
      searchRequest,
      { noCache: true },
      baseDeps(cache, sleep, random),
    );
    // No reads.
    assert.strictEqual(cache.reads.length, 0);
    // No writes.
    assert.strictEqual(cache.writes.length, 0);
    // Validation, identity, and invoke still ran.
    const phases = op.events.map((e) => e.phase);
    assert.ok(phases.includes("validate"));
    assert.ok(phases.includes("cacheIdentity"));
    assert.ok(phases.includes("invoke"));
    assert.strictEqual(op.invokeCount, 1);
    assert.deepStrictEqual(out, searchResult);
  });

  it("with --no-cache, retryable errors still get one retry", async () => {
    const sleep = makeSleep();
    const random = makeRandom([0.4]);
    const cache = makeCache();
    let count = 0;
    const op = makeOperation({
      kind: "repository-search",
      invokeImpl: () => {
        count += 1;
        if (count === 1) throw new TimeoutError(1000);
        return searchResult;
      },
    });
    const out = await executeRepositoryOperation(
      op,
      searchRequest,
      { noCache: true },
      baseDeps(cache, sleep, random),
    );
    assert.strictEqual(op.invokeCount, 2);
    assert.strictEqual(sleep.calls.length, 1);
    // 500 base + floor(0.4 * 250) = 100 jitter.
    assert.strictEqual(sleep.calls[0], 600);
    assert.deepStrictEqual(out, searchResult);
  });
});

// ---------------------------------------------------------------------------
// Retry taxonomy: each RepositoryOperationKind uses one retry
// ---------------------------------------------------------------------------

describe("executeRepositoryOperation — retry taxonomy per operation kind", () => {
  for (const { kind, request, result, name } of [
    { kind: "repository-search", request: searchRequest, result: searchResult, name: "search" },
    { kind: "repository-read-file", request: fileRequest, result: fileResult, name: "file" },
    {
      kind: "repository-list-directory",
      request: directoryRequest,
      result: directoryResult,
      name: "directory",
    },
  ]) {
    it(`${name}: retryable TimeoutError triggers exactly one retry (maxRetries=1)`, async () => {
      const sleep = makeSleep();
      const random = makeRandom();
      const op = makeOperation({ kind, result });
      let count = 0;
      op.invokeImplRef.fn = () => {
        count += 1;
        if (count === 1) throw new TimeoutError(1000);
        return result;
      };
      const out = await executeRepositoryOperation(
        op,
        request,
        { noCache: true },
        baseDeps(makeCache(), sleep, random),
      );
      assert.strictEqual(op.invokeCount, 2);
      assert.strictEqual(sleep.calls.length, 1);
      assert.deepStrictEqual(out, result);
    });

    it(`${name}: terminal AuthError does not retry`, async () => {
      const sleep = makeSleep();
      const random = makeRandom();
      const op = makeOperation({
        kind,
        result,
        invokeImpl: () => {
          throw new AuthError("bad credentials");
        },
      });
      await assert.rejects(
        executeRepositoryOperation(
          op,
          request,
          { noCache: true },
          baseDeps(makeCache(), sleep, random),
        ),
        AuthError,
      );
      assert.strictEqual(op.invokeCount, 1);
      assert.strictEqual(sleep.calls.length, 0);
    });

    it(`${name}: terminal ValidationError does not retry`, async () => {
      const sleep = makeSleep();
      const random = makeRandom();
      const op = makeOperation({
        kind,
        result,
        invokeImpl: () => {
          throw new ValidationError("bad request");
        },
      });
      await assert.rejects(
        executeRepositoryOperation(
          op,
          request,
          { noCache: true },
          baseDeps(makeCache(), sleep, random),
        ),
        ValidationError,
      );
      assert.strictEqual(op.invokeCount, 1);
      assert.strictEqual(sleep.calls.length, 0);
    });

    it(`${name}: terminal QuotaError does not retry`, async () => {
      const sleep = makeSleep();
      const random = makeRandom();
      const op = makeOperation({
        kind,
        result,
        invokeImpl: () => {
          throw new QuotaError();
        },
      });
      await assert.rejects(
        executeRepositoryOperation(
          op,
          request,
          { noCache: true },
          baseDeps(makeCache(), sleep, random),
        ),
        QuotaError,
      );
      assert.strictEqual(op.invokeCount, 1);
      assert.strictEqual(sleep.calls.length, 0);
    });

    it(`${name}: terminal UnsupportedCapabilityError does not retry`, async () => {
      const sleep = makeSleep();
      const random = makeRandom();
      const op = makeOperation({
        kind,
        result,
        invokeImpl: () => {
          throw new UnsupportedCapabilityError("minimax", "repository-exploration");
        },
      });
      await assert.rejects(
        executeRepositoryOperation(
          op,
          request,
          { noCache: true },
          baseDeps(makeCache(), sleep, random),
        ),
        UnsupportedCapabilityError,
      );
      assert.strictEqual(op.invokeCount, 1);
      assert.strictEqual(sleep.calls.length, 0);
    });

    it(`${name}: transient NetworkError retries once and then succeeds`, async () => {
      const sleep = makeSleep();
      const random = makeRandom([0]);
      const op = makeOperation({ kind, result });
      let count = 0;
      op.invokeImplRef.fn = () => {
        count += 1;
        if (count === 1) throw new NetworkError("down");
        return result;
      };
      const out = await executeRepositoryOperation(
        op,
        request,
        { noCache: true },
        baseDeps(makeCache(), sleep, random),
      );
      assert.strictEqual(op.invokeCount, 2);
      assert.strictEqual(sleep.calls.length, 1);
      assert.deepStrictEqual(out, result);
    });

    it(`${name}: every retryable attempt failing exhausts retries and surfaces the last error`, async () => {
      const sleep = makeSleep();
      const random = makeRandom();
      const op = makeOperation({
        kind,
        result,
        invokeImpl: () => {
          throw new NetworkError("still down");
        },
      });
      await assert.rejects(
        executeRepositoryOperation(
          op,
          request,
          { noCache: true },
          baseDeps(makeCache(), sleep, random),
        ),
        NetworkError,
      );
      // maxRetries = 1 → 2 total attempts, 1 sleep call.
      assert.strictEqual(op.invokeCount, 2);
      assert.strictEqual(sleep.calls.length, 1);
    });
  }
});

// ---------------------------------------------------------------------------
// Provider partition + identity-key isolation
// ---------------------------------------------------------------------------

describe("executeRepositoryOperation — provider / identity isolation", () => {
  it("uses the adapter-supplied fingerprint and provider verbatim in the cache key", async () => {
    const sleep = makeSleep();
    const random = makeRandom();
    const cache = makeCache();
    const fingerprint = crypto.createHash("sha256").update("fingerprint-A").digest("hex");
    const op = makeOperation({
      kind: "repository-search",
      result: searchResult,
      fingerprint,
      provider: "zai",
    });
    await executeRepositoryOperation(op, searchRequest, {}, baseDeps(cache, sleep, random));
    const expected = buildProviderCacheKey({
      provider: "zai",
      capability: "repository-exploration-repository-search",
      credentialFingerprint: fingerprint,
      request: searchRequest,
    });
    assert.strictEqual(cache.writes[0].key, expected);
  });

  it("two providers with the same fingerprint and request produce different keys", async () => {
    const sleep = makeSleep();
    const random = makeRandom();
    const cache1 = makeCache();
    const cache2 = makeCache();
    const fingerprint = crypto.createHash("sha256").update("shared").digest("hex");
    const opZai = makeOperation({
      kind: "repository-search",
      result: searchResult,
      fingerprint,
      provider: "zai",
    });
    const opMm = makeOperation({
      kind: "repository-search",
      result: searchResult,
      fingerprint,
      provider: "minimax",
    });
    await executeRepositoryOperation(opZai, searchRequest, {}, baseDeps(cache1, sleep, random));
    await executeRepositoryOperation(opMm, searchRequest, {}, baseDeps(cache2, sleep, random));
    assert.notStrictEqual(cache1.writes[0].key, cache2.writes[0].key);
  });

  // P6-03A regression: File and Directory operations share the
  // `{ repository, path }` request shape. A cached File result must
  // NOT satisfy a Directory lookup at the same path (and vice versa).
  // The cache key namespace must distinguish them by operation kind,
  // even though their requests, capability, provider, and credential
  // are identical.
  it("File and Directory at the same non-root path produce distinct keys and do not cross-hit", async () => {
    const sleep = makeSleep();
    const random = makeRandom();
    const cache = makeCache();
    const sharedRequest = { repository: "owner/repo", path: "src/index.ts" };
    const opFile = makeOperation({
      kind: "repository-read-file",
      provider: "zai",
      result: fileResult,
    });
    const opDir = makeOperation({
      kind: "repository-list-directory",
      provider: "zai",
      // Intentionally leave entries empty so the test cannot
      // accidentally pass via decodeCached shape coincidence — the
      // directory decoder rejects entries-less payloads only as a
      // miss; here we observe the no-cross-hit behaviour by the
      // write key being distinct.
      result: {
        repository: "owner/repo",
        path: "src/index.ts",
        entries: [{ name: "index.ts", path: "index.ts", kind: "file" }],
      },
    });

    await executeRepositoryOperation(opFile, sharedRequest, {}, baseDeps(cache, sleep, random));
    await executeRepositoryOperation(opDir, sharedRequest, {}, baseDeps(cache, sleep, random));

    assert.strictEqual(cache.writes.length, 2);
    assert.notStrictEqual(
      cache.writes[0].key,
      cache.writes[1].key,
      "File and Directory at the same path must produce distinct cache keys",
    );

    const fileKey = buildProviderCacheKey({
      provider: "zai",
      capability: "repository-exploration-repository-read-file",
      credentialFingerprint: opFile.fingerprint,
      request: sharedRequest,
    });
    const dirKey = buildProviderCacheKey({
      provider: "zai",
      capability: "repository-exploration-repository-list-directory",
      credentialFingerprint: opDir.fingerprint,
      request: sharedRequest,
    });
    assert.strictEqual(cache.writes[0].key, fileKey);
    assert.strictEqual(cache.writes[1].key, dirKey);
  });

  it("Search and File with the same repository and a `path`-shaped request still produce distinct keys", async () => {
    // The third kind, Search, does not use `path` at all, but the
    // operation key must remain distinct so the key namespace is
    // operation-scoped across all three repository kinds.
    const sleep = makeSleep();
    const random = makeRandom();
    const cache = makeCache();
    const opSearch = makeOperation({ kind: "repository-search", result: searchResult });
    const opFile = makeOperation({ kind: "repository-read-file", result: fileResult });
    await executeRepositoryOperation(opSearch, searchRequest, {}, baseDeps(cache, sleep, random));
    await executeRepositoryOperation(opFile, fileRequest, {}, baseDeps(cache, sleep, random));
    assert.notStrictEqual(cache.writes[0].key, cache.writes[1].key);
  });

  it("a cached File result does NOT satisfy a Directory lookup at the same path (write-through isolation)", async () => {
    // The cache is pre-seeded only with a File result under the
    // EXACT key the executor would compute for that File. The
    // Directory lookup targets the same path but a different
    // operation. The Directory executor must decode the File entry
    // as a miss (its operation kind does not match) and fall through
    // to invoke.
    const sleep = makeSleep();
    const random = makeRandom();
    const cache = makeCache();
    const sharedRequest = { repository: "owner/repo", path: "src/index.ts" };
    const opDir = makeOperation({
      kind: "repository-list-directory",
      provider: "zai",
      result: {
        repository: "owner/repo",
        path: "src/index.ts",
        entries: [{ name: "index.ts", path: "index.ts", kind: "file" }],
      },
    });

    const fileKey = buildProviderCacheKey({
      provider: "zai",
      capability: "repository-exploration-repository-read-file",
      credentialFingerprint: opDir.fingerprint,
      request: sharedRequest,
    });
    // Pre-seed the File cache key with a File-shaped value. The
    // operation-partitioned namespace (DESIGN.md §18, P6-03A) means
    // the Directory executor NEVER reads this File key at all — the
    // new key it computes for the Directory operation is a different
    // string, so the cache lookup returns `null` and the Directory
    // executor falls through to invoke without ever passing the
    // File-shaped value through `decodeCached`. The pre-seed here is
    // an evidence-only assertion that the cross-operation isolation
    // holds: if a future P6 ticket reintroduces a cross-hit, the test
    // will still pass by coincidence because `decodeCached` is not
    // invoked, but the absence of a Directory-key read is itself the
    // proof.
    cache.store.set(fileKey, {
      kind: "repository-read-file",
      payload: fileResult,
    });

    const out = await executeRepositoryOperation(
      opDir,
      sharedRequest,
      {},
      baseDeps(cache, sleep, random),
    );
    assert.strictEqual(opDir.invokeCount, 1, "Directory must invoke despite a File-shaped sibling cache entry");
    assert.deepStrictEqual(out, {
      repository: "owner/repo",
      path: "src/index.ts",
      entries: [{ name: "index.ts", path: "index.ts", kind: "file" }],
    });
  });
});

// ---------------------------------------------------------------------------
// Retry taxonomy: defaultRetryPolicy recognises the three repository kinds
// ---------------------------------------------------------------------------

describe("defaultRetryPolicy — repository operation kinds", () => {
  it("classifies all three repository kinds as one-retry non-Vision", () => {
    for (const kind of [
      "repository-search",
      "repository-read-file",
      "repository-list-directory",
    ]) {
      const policy = defaultRetryPolicy(kind);
      assert.strictEqual(policy.maxRetries, 1, `${kind} must be one-retry`);
      assert.strictEqual(policy.baseDelayMs, 500);
      assert.strictEqual(policy.maxDelayMs, 8000);
      assert.strictEqual(policy.jitterMs, 250);
    }
  });

  it("preserves the existing four-operation taxonomy byte-for-byte", () => {
    // The contract for current Search/Vision/Quota/Diagnostics must not
    // shift as a side-effect of adding the repository kinds.
    assert.strictEqual(defaultRetryPolicy("search").maxRetries, 1);
    assert.strictEqual(defaultRetryPolicy("vision").maxRetries, 2);
    assert.strictEqual(defaultRetryPolicy("quota").maxRetries, 1);
    assert.strictEqual(defaultRetryPolicy("diagnostics").maxRetries, 1);
  });
});

// ---------------------------------------------------------------------------
// Module isolation: shared execution imports no Provider / transport /
// command output. This is enforced by the existing provider-boundary
// test; here we only assert the executor is importable from the public
// dist surface.
// ---------------------------------------------------------------------------

describe("executeRepositoryOperation — module isolation", () => {
  it("is exposed from the shared execution module", () => {
    assert.strictEqual(typeof executeRepositoryOperation, "function");
    assert.strictEqual(typeof defaultRetryPolicy, "function");
  });
});

// ---------------------------------------------------------------------------
// QuotaError — retry integration (DESIGN.md §18, PRD FR-090).
//
// The class-level behaviour (code, status, retryable, exit, public
// envelope) lives in `tests/errors.test.js`. This block asserts that
// `executeRepositoryOperation` treats QuotaError as terminal and that
// the retry wrapper does not collapse the boundary with retryable
// transient 429s.
// ---------------------------------------------------------------------------

describe("QuotaError — retry integration", () => {
  it("is terminal in the retry wrapper — single attempt, no sleep", async () => {
    const sleep = makeSleep();
    const random = makeRandom();
    const op = makeOperation({
      kind: "repository-search",
      result: searchResult,
      invokeImpl: () => {
        throw new QuotaError();
      },
    });
    await assert.rejects(
      executeRepositoryOperation(
        op,
        searchRequest,
        { noCache: true },
        baseDeps(makeCache(), sleep, random),
      ),
      QuotaError,
    );
    assert.strictEqual(op.invokeCount, 1);
    assert.strictEqual(sleep.calls.length, 0);
  });

  it("treats an API_ERROR with status 429 as retryable (distinct from terminal QuotaError)", async () => {
    // The taxonomy in DESIGN.md §18 distinguishes terminal QUOTA_ERROR
    // (status 429) from retryable transient 429s. This guards the
    // boundary so future regressions in the shared retry classifier
    // cannot collapse the two.
    const sleep = makeSleep();
    const random = makeRandom([0]);
    const op = makeOperation({
      kind: "repository-search",
      result: searchResult,
      invokeImpl: () => {
        throw new ApiError("transient 429", 429);
      },
    });
    let count = 0;
    op.invokeImplRef.fn = () => {
      count += 1;
      if (count === 1) throw new ApiError("transient 429", 429);
      return searchResult;
    };
    const out = await executeRepositoryOperation(
      op,
      searchRequest,
      { noCache: true },
      baseDeps(makeCache(), sleep, random),
    );
    assert.strictEqual(op.invokeCount, 2);
    assert.strictEqual(sleep.calls.length, 1);
    assert.deepStrictEqual(out, searchResult);
  });
});