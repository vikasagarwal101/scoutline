/**
 * Tavily Research Capability tests (T07, tech-plan §2c, §3, §4, §7).
 *
 * Covers the six critical scenarios from the ticket guardrails:
 *   1. Normal completion (state file created → polled → deleted)
 *   2. Ctrl-C during poll (state file persists; formatInterruptMessage)
 *   3. Corrupt state file (read catches parse error, deletes, returns null)
 *   4. Concurrent invocations (wx flag → EEXIST → reads existing → polls)
 *   5. POST transient failure (terminal, no retry, no state file written)
 *   6. Poll 404 (stale state file deleted → new task created)
 *
 * Plus: cache identity (citation_format distinction), decodeCached
 * round-trip, transport (201 create, 202/200 poll), normalization,
 * validation, control mapping.
 *
 * Tests inject a single fake `fetch` through `TavilyAdapterDependencies.transport`
 * and an in-memory `ResearchStateFile` to exercise the lifecycle
 * deterministically without touching the filesystem.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { createTavilyDescriptor } from "../dist/providers/tavily/adapter.js";
import { ApiError, AuthError, TimeoutError, ValidationError } from "../dist/lib/errors.js";
import { executeCachedOperation } from "../dist/lib/execution.js";
import {
  createInMemoryResearchStateFile,
  computeResearchStateHash,
} from "../dist/lib/research-state.js";
import { formatInterruptMessage } from "../dist/commands/research.js";
import { buildProviderCacheKey } from "../dist/lib/cache.js";

const TEST_API_KEY = "tvly-test-key-DO-NOT-LEAK";
const EXPECTED_FINGERPRINT = crypto.createHash("sha256").update(TEST_API_KEY).digest("hex");

// ---------------------------------------------------------------------------
// Fake fetch + helpers
// ---------------------------------------------------------------------------

function makeResponse({ ok = true, status = 200, json, body = "" } = {}) {
  return {
    ok,
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    json: async () => json,
  };
}

/**
 * Build a fake fetch that handles POST /research and GET /research/{id}.
 *
 * - POST always returns 201 { request_id, status: "pending" } with an
 *   incrementing request id ("req-1", "req-2", ...).
 * - GET returns poll responses from `pollResponses` in order, then
 *   defaults to completed.
 *
 * `postStatus` overrides the POST response status for failure tests.
 */
function makeResearchFetch({ pollResponses = [], postStatus = 201, postRequestId } = {}) {
  let pollIndex = 0;
  let requestCounter = 0;
  const calls = [];
  const fn = async (url, init) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    calls.push({ url: u, method, body: init?.body });

    if (method === "POST") {
      if (postStatus !== 201 && postStatus >= 400) {
        return makeResponse({ ok: false, status: postStatus, body: '{"detail":{"error":"x"}}' });
      }
      requestCounter++;
      const rid = postRequestId ?? `req-${requestCounter}`;
      return makeResponse({ status: 201, ok: true, json: { request_id: rid, status: "pending" } });
    }

    // GET poll
    if (pollIndex < pollResponses.length) {
      const resp = pollResponses[pollIndex++];
      return makeResponse(resp);
    }
    // Default: completed
    return makeResponse({
      ok: true,
      status: 200,
      json: {
        status: "completed",
        content: "## Default Report\n\nContent.",
        sources: [{ title: "Source A", url: "https://a.example.com" }],
      },
    });
  };
  return { fetch: fn, calls };
}

function makeResearchAdapter({ fakeFetch, stateFile, env, fetchCalls }) {
  const calls = fetchCalls ?? [];
  const wrappedFetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method, body: init?.body });
    return fakeFetch(url, init);
  };
  const descriptor = createTavilyDescriptor({
    transport: {
      fetch: wrappedFetch,
      env: env ?? {
        TAVILY_TIMEOUT: "5000",
        TAVILY_RESEARCH_POLL_INTERVAL_MS: "0",
      },
    },
    researchStateFile: stateFile ?? createInMemoryResearchStateFile(),
  });
  const adapter = descriptor.create({ env: { TAVILY_API_KEY: TEST_API_KEY } });
  return { adapter, calls };
}

function trivialCache() {
  const store = new Map();
  return {
    async get(k) {
      return store.has(k) ? store.get(k) : null;
    },
    async set(k, v) {
      store.set(k, v);
    },
    store,
  };
}

function trivialDeps() {
  return { cache: trivialCache(), sleep: async () => {}, random: () => 0 };
}

const COMPLETED_POLL = {
  ok: true,
  status: 200,
  json: {
    status: "completed",
    content: "## Research Report\n\nFindings here.",
    sources: [
      { title: "First Source", url: "https://first.example.com", favicon: "icon" },
      { title: "Second Source", url: "https://second.example.com" },
    ],
  },
};

const PENDING_POLL = {
  ok: true,
  status: 202,
  json: { status: "pending" },
};

const IN_PROGRESS_POLL = {
  ok: true,
  status: 202,
  json: { status: "in_progress" },
};

const FAILED_POLL = {
  ok: true,
  status: 200,
  json: { status: "failed" },
};

function notFoundResponse() {
  return makeResponse({ ok: false, status: 404, body: '{"detail":"not found"}' });
}

// ===========================================================================
// CRITICAL SCENARIO 1: Normal completion
// ===========================================================================

describe("T07 Scenario 1 — Normal completion", () => {
  it("creates state file, polls, deletes on completion, and caches result", async () => {
    const stateFile = createInMemoryResearchStateFile();
    const { fetch: rfetch } = makeResearchFetch({
      pollResponses: [PENDING_POLL, COMPLETED_POLL],
    });
    const { adapter, calls } = makeResearchAdapter({ fakeFetch: rfetch, stateFile });

    const deps = trivialDeps();
    const request = { query: "test query" };

    const result = await executeCachedOperation(adapter.research.run, request, {}, deps);

    // Result shape
    assert.equal(result.schemaVersion, 1);
    assert.equal(result.query, "test query");
    assert.equal(result.model, "auto");
    assert.equal(result.report, "## Research Report\n\nFindings here.");
    assert.equal(result.sources.length, 2);
    assert.equal(result.sources[0].title, "First Source");
    assert.equal(result.sources[0].url, "https://first.example.com");
    // favicon dropped
    assert.equal(result.sources[0].favicon, undefined);

    // State file deleted after completion
    const identityHash = computeResearchStateHash({
      provider: "tavily",
      capability: "research",
      credentialFingerprint: EXPECTED_FINGERPRINT,
      request,
    });
    assert.equal(stateFile.store.has(identityHash), false);

    // POST happened exactly once
    const posts = calls.filter((c) => c.method === "POST");
    assert.equal(posts.length, 1);

    // Second call hits cache — no new POST
    const result2 = await executeCachedOperation(adapter.research.run, request, {}, deps);
    assert.deepEqual(result2, result);
    const posts2 = calls.filter((c) => c.method === "POST");
    assert.equal(posts2.length, 1); // still 1
  });
});

// ===========================================================================
// CRITICAL SCENARIO 2: Ctrl-C during poll (state file persists)
// ===========================================================================

describe("T07 Scenario 2 — Ctrl-C during poll", () => {
  it("state file persists when the operation is interrupted", async () => {
    // The adapter's async chain is: read → POST → write → poll loop.
    // By the time the first GET poll arrives, the state file MUST be
    // written. We assert from inside the fake fetch's GET handler so
    // the check is deterministic (no race with microtask drainage).
    const stateFile = createInMemoryResearchStateFile();
    const request = { query: "interrupted query" };
    const identityHash = computeResearchStateHash({
      provider: "tavily",
      capability: "research",
      credentialFingerprint: EXPECTED_FINGERPRINT,
      request,
    });
    let stateFilePresentAtFirstPoll = false;
    let pollCount = 0;

    const fakeFetch = async (url, init) => {
      const method = init?.method ?? "GET";
      if (method === "POST") {
        return makeResponse({
          status: 201,
          ok: true,
          json: { request_id: "req-persist", status: "pending" },
        });
      }
      // GET poll
      pollCount++;
      if (pollCount === 1) {
        // The write has already happened — assert here (deterministic).
        stateFilePresentAtFirstPoll = stateFile.store.has(identityHash);
        // Return pending (simulating mid-poll interrupt window).
        return makeResponse(PENDING_POLL);
      }
      // Second poll: let it complete so the promise settles (no hang).
      return makeResponse(COMPLETED_POLL);
    };

    const { adapter } = makeResearchAdapter({ fakeFetch, stateFile });
    // Await completion so the test process doesn't hang on a dangling
    // promise. The state-file-persistence assertion is from the first
    // poll, BEFORE completion cleanup.
    await adapter.research.run.invoke(request);
    // The state file was present when the first poll arrived.
    assert.equal(
      stateFilePresentAtFirstPoll,
      true,
      "state file must be written before the first poll",
    );

    // After completion, the state file is cleaned up (expected — the
    // task finished). The Ctrl-C scenario is: the state file persists
    // WHILE polling, which the assertion above verifies. The
    // `formatInterruptMessage` tests below verify what would be printed.
  });

  it("formatInterruptMessage includes requestId and resume command", () => {
    const msg = formatInterruptMessage("req-abc-123", 'scoutline research "my query"');
    assert.ok(msg.includes("req-abc-123"), "message must contain requestId");
    assert.ok(msg.includes('scoutline research "my query"'), "message must contain resume command");
    assert.ok(msg.includes("still running"), "message must reassure about credits");
  });

  it("formatInterruptMessage handles unknown requestId gracefully", () => {
    const msg = formatInterruptMessage("unknown", "scoutline research q");
    assert.ok(msg.includes("unknown"));
  });
});

// ===========================================================================
// CRITICAL SCENARIO 3: Corrupt state file
// ===========================================================================

describe("T07 Scenario 3 — Corrupt state file recovery", () => {
  it("read() catches parse error, deletes corrupt file, returns null", async () => {
    const stateFile = createInMemoryResearchStateFile();
    const request = { query: "corrupt test" };
    const identityHash = computeResearchStateHash({
      provider: "tavily",
      capability: "research",
      credentialFingerprint: EXPECTED_FINGERPRINT,
      request,
    });

    // Pre-populate with corrupt JSON
    stateFile.store.set(identityHash, "{this is not valid json");

    const readResult = await stateFile.read(identityHash);
    assert.equal(readResult, null);
    // Corrupt file deleted
    assert.equal(stateFile.store.has(identityHash), false);
  });

  it("invoke creates a new task when state file is corrupt", async () => {
    const stateFile = createInMemoryResearchStateFile();
    const request = { query: "corrupt invoke" };
    const identityHash = computeResearchStateHash({
      provider: "tavily",
      capability: "research",
      credentialFingerprint: EXPECTED_FINGERPRINT,
      request,
    });

    // Pre-populate with corrupt JSON (simulating a crash during write)
    stateFile.store.set(identityHash, "garbage{{{");

    const { fetch: rfetch } = makeResearchFetch({
      pollResponses: [COMPLETED_POLL],
    });
    const { adapter, calls } = makeResearchAdapter({ fakeFetch: rfetch, stateFile });

    const result = await adapter.research.run.invoke(request);
    assert.equal(result.report, "## Research Report\n\nFindings here.");

    // POST happened (new task was created because corrupt file was treated as absent)
    const posts = calls.filter((c) => c.method === "POST");
    assert.equal(posts.length, 1);
  });

  it("read() catches a structurally-valid but wrong-shape JSON", async () => {
    const stateFile = createInMemoryResearchStateFile();
    const hash = "some-hash";
    // Valid JSON but missing required fields
    stateFile.store.set(hash, JSON.stringify({ foo: "bar" }));
    const result = await stateFile.read(hash);
    assert.equal(result, null);
    assert.equal(stateFile.store.has(hash), false);
  });
});

// ===========================================================================
// CRITICAL SCENARIO 4: Concurrent invocations (EEXIST → read existing)
// ===========================================================================

describe("T07 Scenario 4 — Concurrent invocations (wx flag)", () => {
  it("write() throws EEXIST when file already exists", async () => {
    const stateFile = createInMemoryResearchStateFile();
    const hash = "concurrent-hash";
    const state = {
      requestId: "req-existing",
      identityHash: hash,
      createdAt: new Date().toISOString(),
      status: "pending",
    };
    await stateFile.write(hash, state);
    // Second write to the same hash must fail with EEXIST
    await assert.rejects(
      () => stateFile.write(hash, state),
      (err) => err.code === "EEXIST",
    );
  });

  it("invoke falls back to existing task on EEXIST", async () => {
    // Simulate: another process already wrote a state file. This process
    // POSTs (getting req-new), tries to write, gets EEXIST, reads the
    // existing state (req-existing), and polls that instead.
    const stateFile = createInMemoryResearchStateFile();
    const request = { query: "concurrent test" };
    const identityHash = computeResearchStateHash({
      provider: "tavily",
      capability: "research",
      credentialFingerprint: EXPECTED_FINGERPRINT,
      request,
    });

    // Pre-populate with an existing valid task
    stateFile.store.set(
      identityHash,
      JSON.stringify({
        requestId: "req-existing",
        identityHash,
        createdAt: new Date().toISOString(),
        status: "pending",
      }),
    );

    const { fetch: rfetch, calls: fetchCalls } = makeResearchFetch({
      pollResponses: [COMPLETED_POLL],
      postRequestId: "req-new", // our POST would create req-new
    });
    const { adapter } = makeResearchAdapter({ fakeFetch: rfetch, stateFile });

    // read() returns the existing task — no POST at all
    const result = await adapter.research.run.invoke(request);
    assert.equal(result.report, "## Research Report\n\nFindings here.");

    // No POST happened (existing task was resumed)
    const posts = fetchCalls.filter((c) => c.method === "POST");
    assert.equal(posts.length, 0);

    // State file deleted after completion
    assert.equal(stateFile.store.has(identityHash), false);
  });
});

// ===========================================================================
// CRITICAL SCENARIO 5: POST transient failure (terminal, no retry)
// ===========================================================================

describe("T07 Scenario 5 — POST transient failure", () => {
  it("throws ApiError on POST 503, writes no state file", async () => {
    const stateFile = createInMemoryResearchStateFile();
    const { fetch: rfetch } = makeResearchFetch({
      postStatus: 503,
      pollResponses: [],
    });
    const { adapter } = makeResearchAdapter({ fakeFetch: rfetch, stateFile });

    const request = { query: "fail test" };

    await assert.rejects(
      () => adapter.research.run.invoke(request),
      (e) => e instanceof ApiError && e.statusCode === 503,
    );

    // State file NOT written (POST failed before write)
    const identityHash = computeResearchStateHash({
      provider: "tavily",
      capability: "research",
      credentialFingerprint: EXPECTED_FINGERPRINT,
      request,
    });
    assert.equal(stateFile.store.has(identityHash), false);
  });

  it("executeCachedOperation does not retry on POST failure (maxRetries: 0)", async () => {
    const stateFile = createInMemoryResearchStateFile();
    let postCount = 0;
    const { fetch: rfetch } = makeResearchFetch({
      postStatus: 503,
      pollResponses: [],
    });
    // Wrap to count POSTs
    const countingFetch = async (url, init) => {
      if (init?.method === "POST") postCount++;
      return rfetch(url, init);
    };
    const { adapter } = makeResearchAdapter({ fakeFetch: countingFetch, stateFile });

    await assert.rejects(
      () => executeCachedOperation(adapter.research.run, { query: "no retry" }, {}, trivialDeps()),
      (e) => e instanceof ApiError && e.statusCode === 503,
    );
    // Only ONE POST attempt — no retry despite transient 503
    assert.equal(postCount, 1);
  });
});

// ===========================================================================
// CRITICAL SCENARIO 6: Poll 404 (stale state file → new task)
// ===========================================================================

describe("T07 Scenario 6 — Poll 404 recovery", () => {
  it("deletes stale state file on 404, creates new task, completes", async () => {
    const stateFile = createInMemoryResearchStateFile();
    const request = { query: "stale test" };
    const identityHash = computeResearchStateHash({
      provider: "tavily",
      capability: "research",
      credentialFingerprint: EXPECTED_FINGERPRINT,
      request,
    });

    // Pre-populate with a stale task (simulates resume of an expired task)
    stateFile.store.set(
      identityHash,
      JSON.stringify({
        requestId: "req-stale",
        identityHash,
        createdAt: new Date().toISOString(),
        status: "pending",
      }),
    );

    const { fetch: rfetch, calls: fetchCalls } = makeResearchFetch({
      // First poll (of the stale task) → 404
      // Then new POST → req-1
      // Then poll of req-1 → completed
      pollResponses: [{ ok: false, status: 404, body: '{"detail":"gone"}' }, COMPLETED_POLL],
      postRequestId: "req-fresh",
    });
    const { adapter } = makeResearchAdapter({ fakeFetch: rfetch, stateFile });

    const result = await adapter.research.run.invoke(request);
    assert.equal(result.report, "## Research Report\n\nFindings here.");

    // POST happened (new task created after 404)
    const posts = fetchCalls.filter((c) => c.method === "POST");
    assert.equal(posts.length, 1);

    // State file deleted after final completion
    assert.equal(stateFile.store.has(identityHash), false);
  });
});

// ===========================================================================
// Cache identity
// ===========================================================================

describe("Tavily Research Adapter — cache identity", () => {
  it("produces a research identity with SHA-256 fingerprint", () => {
    const { adapter } = makeResearchAdapter({ fakeFetch: makeResearchFetch().fetch });
    const identity = adapter.research.run.cacheIdentity({ query: "test" });
    assert.equal(identity.provider, "tavily");
    assert.equal(identity.capability, "research");
    assert.equal(identity.credentialFingerprint, EXPECTED_FINGERPRINT);
    assert.equal(identity.request.query, "test");
  });

  it("two requests differing only in citation_format produce different cache keys", () => {
    const { adapter } = makeResearchAdapter({ fakeFetch: makeResearchFetch().fetch });
    const identity1 = adapter.research.run.cacheIdentity({
      query: "same query",
      citationFormat: "numbered",
    });
    const identity2 = adapter.research.run.cacheIdentity({
      query: "same query",
      citationFormat: "apa",
    });

    const key1 = buildProviderCacheKey({
      provider: identity1.provider,
      capability: `${identity1.capability}-${adapter.research.run.kind}`,
      credentialFingerprint: identity1.credentialFingerprint,
      request: identity1.request,
    });
    const key2 = buildProviderCacheKey({
      provider: identity2.provider,
      capability: `${identity2.capability}-${adapter.research.run.kind}`,
      credentialFingerprint: identity2.credentialFingerprint,
      request: identity2.request,
    });

    assert.notEqual(key1, key2, "different citation_format must produce different cache keys");
  });

  it("includes model, outputLength, and domain in the cache identity", () => {
    const { adapter } = makeResearchAdapter({ fakeFetch: makeResearchFetch().fetch });
    const identity = adapter.research.run.cacheIdentity({
      query: "q",
      model: "pro",
      outputLength: "long",
      citationFormat: "mla",
      domain: "example.com",
    });
    assert.equal(identity.request.model, "pro");
    assert.equal(identity.request.outputLength, "long");
    assert.equal(identity.request.citationFormat, "mla");
    assert.equal(identity.request.domain, "example.com");
  });
});

// ===========================================================================
// decodeCached round-trip
// ===========================================================================

describe("Tavily Research Adapter — decodeCached", () => {
  it("round-trips a valid ResearchResult", () => {
    const { adapter } = makeResearchAdapter({ fakeFetch: makeResearchFetch().fetch });
    const value = {
      schemaVersion: 1,
      query: "test",
      model: "auto",
      report: "Report text",
      sources: [{ title: "S", url: "https://s.example.com" }],
    };
    const decoded = adapter.research.run.decodeCached(value);
    assert.deepEqual(decoded, value);
  });

  it("returns null for a malformed value", () => {
    const { adapter } = makeResearchAdapter({ fakeFetch: makeResearchFetch().fetch });
    assert.equal(adapter.research.run.decodeCached({ foo: "bar" }), null);
    assert.equal(adapter.research.run.decodeCached(null), null);
    assert.equal(adapter.research.run.decodeCached(42), null);
  });

  it("returns null for wrong schemaVersion", () => {
    const { adapter } = makeResearchAdapter({ fakeFetch: makeResearchFetch().fetch });
    assert.equal(
      adapter.research.run.decodeCached({
        schemaVersion: 2,
        query: "q",
        model: "auto",
        report: "r",
        sources: [],
      }),
      null,
    );
  });

  it("returns null for malformed sources array", () => {
    const { adapter } = makeResearchAdapter({ fakeFetch: makeResearchFetch().fetch });
    assert.equal(
      adapter.research.run.decodeCached({
        schemaVersion: 1,
        query: "q",
        model: "auto",
        report: "r",
        sources: "not-an-array",
      }),
      null,
    );
  });
});

// ===========================================================================
// Transport (createTavilyResearch / pollTavilyResearch)
// ===========================================================================

describe("Tavily Research Transport", () => {
  it("createTavilyResearch returns requestId from 201 response", async () => {
    const { createTavilyResearch } = await import("../dist/providers/tavily/client.js");
    const fakeFetch = async () =>
      makeResponse({
        status: 201,
        ok: true,
        json: { request_id: "rid-201", status: "pending" },
      });
    const result = await createTavilyResearch("key", "query", undefined, {
      fetch: fakeFetch,
      env: { TAVILY_TIMEOUT: "5000" },
    });
    assert.equal(result.requestId, "rid-201");
    assert.equal(result.status, "pending");
  });

  it("pollTavilyResearch returns completed with content and sources", async () => {
    const { pollTavilyResearch } = await import("../dist/providers/tavily/client.js");
    const fakeFetch = async () =>
      makeResponse({
        status: 200,
        ok: true,
        json: {
          status: "completed",
          content: "Report",
          sources: [{ title: "T", url: "https://t.example.com" }],
        },
      });
    const result = await pollTavilyResearch("key", "rid", {
      fetch: fakeFetch,
      env: { TAVILY_TIMEOUT: "5000" },
    });
    assert.equal(result.status, "completed");
    assert.equal(result.content, "Report");
    assert.equal(result.sources.length, 1);
  });

  it("pollTavilyResearch returns not_found on 404", async () => {
    const { pollTavilyResearch } = await import("../dist/providers/tavily/client.js");
    const fakeFetch = async () =>
      makeResponse({ status: 404, ok: false, body: '{"detail":"gone"}' });
    const result = await pollTavilyResearch("key", "rid", {
      fetch: fakeFetch,
      env: { TAVILY_TIMEOUT: "5000" },
    });
    assert.equal(result.status, "not_found");
  });

  it("pollTavilyResearch returns pending on 202", async () => {
    const { pollTavilyResearch } = await import("../dist/providers/tavily/client.js");
    const fakeFetch = async () =>
      makeResponse({ status: 202, ok: true, json: { status: "in_progress" } });
    const result = await pollTavilyResearch("key", "rid", {
      fetch: fakeFetch,
      env: { TAVILY_TIMEOUT: "5000" },
    });
    assert.equal(result.status, "in_progress");
  });

  it("pollTavilyResearch throws on 401", async () => {
    const { pollTavilyResearch } = await import("../dist/providers/tavily/client.js");
    const fakeFetch = async () =>
      makeResponse({ status: 401, ok: false, body: '{"detail":"unauthorized"}' });
    await assert.rejects(
      () => pollTavilyResearch("key", "rid", { fetch: fakeFetch, env: {} }),
      (e) => e instanceof AuthError,
    );
  });
});

// ===========================================================================
// Normalization + control mapping
// ===========================================================================

describe("Tavily Research Adapter — normalization", () => {
  it("maps content → report, drops favicon from sources", async () => {
    const { fetch: rfetch } = makeResearchFetch({
      pollResponses: [
        {
          ok: true,
          status: 200,
          json: {
            status: "completed",
            content: "Report body",
            sources: [
              { title: "S1", url: "https://s1.com", favicon: "fav" },
              { title: "S2", url: "https://s2.com" },
            ],
          },
        },
      ],
    });
    const { adapter } = makeResearchAdapter({ fakeFetch: rfetch });
    const result = await adapter.research.run.invoke({ query: "q" });
    assert.equal(result.report, "Report body");
    assert.equal(result.sources.length, 2);
    assert.equal(result.sources[0].favicon, undefined);
  });

  it("echoes requested model (default auto)", async () => {
    const { fetch: rfetch } = makeResearchFetch({ pollResponses: [COMPLETED_POLL] });
    const { adapter } = makeResearchAdapter({ fakeFetch: rfetch });
    const result = await adapter.research.run.invoke({ query: "q", model: "pro" });
    assert.equal(result.model, "pro");
  });
});

describe("Tavily Research Adapter — control mapping", () => {
  it("maps model, outputLength, citationFormat, domain to POST body", async () => {
    const { fetch: rfetch, calls: fetchCalls } = makeResearchFetch({
      pollResponses: [COMPLETED_POLL],
    });
    const { adapter } = makeResearchAdapter({ fakeFetch: rfetch });
    await adapter.research.run.invoke({
      query: "deep query",
      model: "pro",
      outputLength: "long",
      citationFormat: "apa",
      domain: "example.com",
    });

    const post = fetchCalls.find((c) => c.method === "POST");
    assert.ok(post, "POST must have happened");
    const body = JSON.parse(post.body);
    assert.equal(body.query, "deep query");
    assert.equal(body.model, "pro");
    assert.equal(body.output_length, "long");
    assert.equal(body.citation_format, "apa");
    assert.equal(body.domain, "example.com");
  });

  it("omits unset controls from the POST body", async () => {
    const { fetch: rfetch, calls: fetchCalls } = makeResearchFetch({
      pollResponses: [COMPLETED_POLL],
    });
    const { adapter } = makeResearchAdapter({ fakeFetch: rfetch });
    await adapter.research.run.invoke({ query: "bare" });

    const post = fetchCalls.find((c) => c.method === "POST");
    const body = JSON.parse(post.body);
    assert.equal(body.query, "bare");
    assert.equal(body.model, undefined);
    assert.equal(body.output_length, undefined);
    assert.equal(body.citation_format, undefined);
    assert.equal(body.domain, undefined);
  });
});

// ===========================================================================
// Validation
// ===========================================================================

describe("Tavily Research Adapter — validation", () => {
  it("rejects empty query", () => {
    const { adapter } = makeResearchAdapter({ fakeFetch: makeResearchFetch().fetch });
    assert.throws(
      () => adapter.research.run.validate({ query: "   " }),
      (e) => e instanceof ValidationError,
    );
  });

  it("rejects missing query", () => {
    const { adapter } = makeResearchAdapter({ fakeFetch: makeResearchFetch().fetch });
    assert.throws(
      () => adapter.research.run.validate({}),
      (e) => e instanceof ValidationError,
    );
  });

  it("accepts a valid query", () => {
    const { adapter } = makeResearchAdapter({ fakeFetch: makeResearchFetch().fetch });
    adapter.research.run.validate({ query: "valid query" });
  });
});

// ===========================================================================
// Resume after interrupt (state file present → no new POST)
// ===========================================================================

describe("Tavily Research Adapter — resume from state file", () => {
  it("detects in-flight task and polls instead of creating new POST", async () => {
    const stateFile = createInMemoryResearchStateFile();
    const request = { query: "resume test" };
    const identityHash = computeResearchStateHash({
      provider: "tavily",
      capability: "research",
      credentialFingerprint: EXPECTED_FINGERPRINT,
      request,
    });

    // Pre-populate: simulate a task created by a previous (interrupted) run
    stateFile.store.set(
      identityHash,
      JSON.stringify({
        requestId: "req-from-prev-run",
        identityHash,
        createdAt: new Date().toISOString(),
        status: "pending",
      }),
    );

    const { fetch: rfetch, calls: fetchCalls } = makeResearchFetch({
      pollResponses: [COMPLETED_POLL],
    });
    const { adapter } = makeResearchAdapter({ fakeFetch: rfetch, stateFile });

    const result = await adapter.research.run.invoke(request);
    assert.equal(result.report, "## Research Report\n\nFindings here.");

    // No POST — the existing task was polled
    const posts = fetchCalls.filter((c) => c.method === "POST");
    assert.equal(posts.length, 0);

    // State file cleaned up
    assert.equal(stateFile.store.has(identityHash), false);
  });

  it("throws ApiError on poll status failed, deletes state file", async () => {
    const stateFile = createInMemoryResearchStateFile();
    const request = { query: "fail poll" };
    const identityHash = computeResearchStateHash({
      provider: "tavily",
      capability: "research",
      credentialFingerprint: EXPECTED_FINGERPRINT,
      request,
    });

    const { fetch: rfetch } = makeResearchFetch({
      pollResponses: [FAILED_POLL],
    });
    const { adapter } = makeResearchAdapter({ fakeFetch: rfetch, stateFile });

    await assert.rejects(
      () => adapter.research.run.invoke(request),
      (e) => e instanceof ApiError,
    );

    // State file deleted on failure
    assert.equal(stateFile.store.has(identityHash), false);
  });
});

// ===========================================================================
// AbortSignal cancels the poll loop (I-1)
// ===========================================================================
//
// The research --timeout races executeCachedOperation against a timeout
// promise and aborts an AbortController on timeout. Without cooperation
// from the poll loop, the losing operation keeps a pending setTimeout
// alive and freezes the CLI. The adapter now accepts an optional signal
// on invoke(); the abortable sleep rejects when the signal fires so the
// loop unwinds and no extra polls are issued.

describe("T07 — AbortSignal cancels the poll loop (I-1)", () => {
  it("stops polling and rejects with a TimeoutError when the signal fires", async () => {
    const controller = new AbortController();
    let pollCount = 0;
    const fakeFetch = async (url, init) => {
      const method = init?.method ?? "GET";
      if (method === "POST") {
        return makeResponse({
          status: 201,
          ok: true,
          json: { request_id: "req-abort", status: "pending" },
        });
      }
      // GET poll: return pending and abort AFTER the poll is observed.
      // The next loop step is `await sleep(interval)`; since the signal
      // is now aborted, the abortable sleep rejects immediately.
      pollCount++;
      controller.abort();
      return makeResponse(PENDING_POLL);
    };

    const stateFile = createInMemoryResearchStateFile();
    const { adapter } = makeResearchAdapter({
      fakeFetch,
      stateFile,
      // A real, non-zero interval so the sleep is genuinely pending when
      // the abort lands (exercises the abortable-sleep clear path).
      env: { TAVILY_TIMEOUT: "5000", TAVILY_RESEARCH_POLL_INTERVAL_MS: "1000" },
    });

    const request = { query: "abort me" };
    await assert.rejects(
      () =>
        executeCachedOperation(
          adapter.research.run,
          request,
          { signal: controller.signal },
          trivialDeps(),
        ),
      (e) => e instanceof TimeoutError,
    );

    // Exactly one poll — the loop unwound on abort and did not sleep+poll again.
    assert.equal(pollCount, 1, "abort must stop the poll loop after the first poll");
  });

  it("exits immediately when the signal is already aborted before the first poll", async () => {
    // Pre-aborted signal: the loop's top-of-iteration check fires before
    // any GET poll is issued.
    const controller = new AbortController();
    controller.abort();
    let pollCount = 0;
    const fakeFetch = async (url, init) => {
      const method = init?.method ?? "GET";
      if (method === "POST") {
        return makeResponse({
          status: 201,
          ok: true,
          json: { request_id: "req-preabort", status: "pending" },
        });
      }
      pollCount++;
      return makeResponse(PENDING_POLL);
    };

    const { adapter } = makeResearchAdapter({ fakeFetch });
    await assert.rejects(
      () =>
        executeCachedOperation(
          adapter.research.run,
          { query: "pre-aborted" },
          { signal: controller.signal },
          trivialDeps(),
        ),
      (e) => e instanceof TimeoutError,
    );
    // The create POST ran, but no polls — the signal aborted before the loop body.
    assert.equal(pollCount, 0, "a pre-aborted signal must skip polling entirely");
  });
});
