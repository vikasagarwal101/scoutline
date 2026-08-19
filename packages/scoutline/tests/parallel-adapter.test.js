/**
 * Parallel AI Provider unit tests.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import * as fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { createParallelDescriptor, ParallelAdapter } from "../dist/providers/parallel/adapter.js";
import {
  resolveParallelApiKey,
  requireParallelApiKey,
  isParallelConfigured,
} from "../dist/providers/parallel/credentials.js";
import {
  ApiError,
  AuthError,
  ConfigurationError,
  QuotaError,
  UnsupportedOptionError,
  ValidationError,
} from "../dist/lib/errors.js";
import {
  createInMemoryAsyncJobStateFile,
  computeAsyncJobStateHash,
} from "../dist/lib/async-job-state.js";

const TEST_KEY = "parallel-test-api-key";

function mockFetch(responseBody, status = 200) {
  return async (url, init) => {
    assert.ok(url.includes("/v1/search"));
    const body = JSON.parse(init.body);
    // Verify the request uses search_queries (array), not query (string)
    assert.ok(Array.isArray(body.search_queries), "request body must use search_queries array");
    assert.ok(!("query" in body), "request body must not use query field");
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(responseBody),
    };
  };
}

// ---------------------------------------------------------------------------
// Task API (Deep Research) mock — 8P.1
// ---------------------------------------------------------------------------

/**
 * Build a fake fetch that handles POST /v1/tasks/runs (create) and
 * GET /v1/tasks/runs/{run_id}/result (retrieve).
 *
 * - POST always returns 202 { run_id, status: "queued" } with an
 *   incrementing run id ("trun-test-1", "trun-test-2", ...).
 * - GET returns responses from `pollResponses` in order, then
 *   defaults to completed.
 *
 * `postStatus` overrides the POST response status for failure tests.
 */
function makeTaskFetch({ pollResponses = [], postStatus = 202, postRunId } = {}) {
  let pollIndex = 0;
  let runCounter = 0;
  const calls = [];
  const fn = async (url, init) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    calls.push({ url: u, method, body: init?.body });

    if (method === "POST" && u.includes("/v1/tasks/runs")) {
      if (postStatus >= 400) {
        return {
          ok: false,
          status: postStatus,
          text: async () => JSON.stringify({ error: { message: "fail" } }),
        };
      }
      runCounter++;
      const rid = postRunId ?? `trun-test-${runCounter}`;
      return {
        ok: true,
        status: 202,
        text: async () => JSON.stringify({ run_id: rid, status: "queued" }),
      };
    }

    if (method === "GET" && u.includes("/result")) {
      if (pollIndex < pollResponses.length) {
        const resp = pollResponses[pollIndex++];
        return {
          ok: resp.ok ?? (resp.status >= 200 && resp.status < 300),
          status: resp.status,
          text: async () => (typeof resp.body === "string" ? resp.body : JSON.stringify(resp.body)),
        };
      }
      // Default: completed with a synthesized report
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            run: { run_id: "trun-default", status: "completed", processor: "pro" },
            output: {
              type: "text",
              content: "## Research Report\n\nSynthesized findings with inline citations.",
              basis: [
                {
                  field: "summary",
                  reasoning: "Synthesized from multiple sources.",
                  citations: [
                    {
                      title: "Primary Source",
                      url: "https://example.com/primary",
                      excerpts: ["Key finding excerpt."],
                    },
                  ],
                  confidence: "high",
                },
              ],
            },
          }),
      };
    }

    // Fall through for any search/extract requests
    return { ok: true, status: 200, text: async () => JSON.stringify({ results: [] }) };
  };
  return { fetch: fn, calls };
}

const COMPLETED_RESULT = {
  status: 200,
  body: {
    run: { run_id: "trun-completed", status: "completed", processor: "ultra" },
    output: {
      type: "text",
      content: "## Deep Research Report\n\nMulti-step synthesized analysis.",
      basis: [
        {
          field: "analysis",
          reasoning: "Based on verified sources.",
          citations: [
            { title: "Source A", url: "https://a.example.com", excerpts: ["Finding A"] },
            { title: "Source B", url: "https://b.example.com", excerpts: ["Finding B"] },
          ],
          confidence: "high",
        },
      ],
    },
  },
};

const RUNNING_408 = { status: 408, body: '{"error":{"message":"timed out, run still active"}}' };
const NOT_FOUND_404 = { status: 404, body: '{"error":{"message":"Run failed or run id not found"}}' };
const FAILED_RESULT = {
  status: 200,
  body: {
    run: {
      run_id: "trun-failed",
      status: "failed",
      error: { message: "processing_error", ref_id: "ref-123" },
    },
    output: null,
  },
};

describe("Parallel AI Credentials", () => {
  it("resolves valid API key from environment", () => {
    assert.equal(resolveParallelApiKey({ PARALLEL_API_KEY: "  key123  " }), "key123");
    assert.equal(resolveParallelApiKey({}), undefined);
    assert.equal(resolveParallelApiKey({ PARALLEL_API_KEY: "   " }), undefined);
  });

  it("returns a whitespace-padded key trimmed (#58d)", () => {
    assert.equal(resolveParallelApiKey({ PARALLEL_API_KEY: "  key123  " }), "key123");
  });

  it("returns undefined for a fully blank key (#58d guard)", () => {
    assert.equal(resolveParallelApiKey({ PARALLEL_API_KEY: " \t " }), undefined);
  });

  it("requireParallelApiKey throws ConfigurationError when missing", () => {
    assert.throws(() => requireParallelApiKey({}), ConfigurationError);
    assert.equal(requireParallelApiKey({ PARALLEL_API_KEY: TEST_KEY }), TEST_KEY);
  });

  it("checks if parallel is configured", () => {
    assert.equal(isParallelConfigured({ PARALLEL_API_KEY: TEST_KEY }), true);
    assert.equal(isParallelConfigured({}), false);
  });
});

describe("Parallel AI Descriptor & Adapter", () => {
  it("creates descriptor with correct metadata", () => {
    const desc = createParallelDescriptor();
    assert.equal(desc.id, "parallel");
    assert.deepEqual(Array.from(desc.capabilities()), [
      "search",
      "research",
      "reader",
      "diagnostics",
    ]);
  });

  it("invokes search with mock transport using real API shape", async () => {
    const fakeFetch = mockFetch({
      search_id: "search_test123",
      results: [
        {
          title: "Async Rust Guide",
          url: "https://example.com/rust",
          excerpts: ["Learn async in Rust", "Tokio runtime basics"],
          publish_date: "2024-01-15",
        },
      ],
      usage: [{ name: "sku_search", count: 1 }],
      session_id: "session_test123",
    });

    const adapter = new ParallelAdapter(
      { env: { PARALLEL_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );

    adapter.search.validate({ query: "rust async" });
    const results = await adapter.search.invoke({ query: "rust async" });
    assert.equal(results.length, 1);
    assert.equal(results[0].title, "Async Rust Guide");
    assert.equal(results[0].url, "https://example.com/rust");
    // Excerpts should be joined with double newlines
    assert.equal(results[0].summary, "Learn async in Rust\n\nTokio runtime basics");
    assert.equal(results[0].date, "2024-01-15");
    assert.equal(results[0].source, undefined);
  });

  it("handles results with null publish_date", async () => {
    const fakeFetch = mockFetch({
      results: [
        {
          title: "No Date Article",
          url: "https://example.com/nodate",
          excerpts: ["Content here"],
          publish_date: null,
        },
      ],
    });

    const adapter = new ParallelAdapter(
      { env: { PARALLEL_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );

    const results = await adapter.search.invoke({ query: "test" });
    assert.equal(results[0].date, undefined);
  });

  it("handles empty excerpts gracefully", async () => {
    const fakeFetch = mockFetch({
      results: [
        {
          title: "No Excerpts",
          url: "https://example.com/noexcept",
        },
      ],
    });

    const adapter = new ParallelAdapter(
      { env: { PARALLEL_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );

    const results = await adapter.search.invoke({ query: "test" });
    assert.equal(results[0].summary, "");
  });

  it("invokes reader capability (Extract API)", async () => {
    const fakeFetch = async (url, init) => {
      assert.ok(url.includes("/v1/extract"));
      const body = JSON.parse(init.body);
      assert.ok(Array.isArray(body.urls), "extract body must use urls array");
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            results: [
              {
                url: "https://example.com/page",
                title: "Example Page",
                publish_date: null,
                excerpts: ["Full page content extracted by Parallel AI."],
                full_content: "",
              },
            ],
            errors: [],
          }),
      };
    };

    const adapter = new ParallelAdapter(
      { env: { PARALLEL_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );

    adapter.reader.fetch.validate({ url: "https://example.com/page" });
    const res = await adapter.reader.fetch.invoke({ url: "https://example.com/page" });
    assert.equal(res.title, "Example Page");
    assert.equal(res.content, "Full page content extracted by Parallel AI.");
    assert.equal(res.finalUrl, "https://example.com/page");
    assert.equal(res.contentFormat, "markdown");
  });

  it("reader request includes advanced_settings.full_content: true (8P.2)", async () => {
    let capturedBody = null;
    const fakeFetch = async (url, init) => {
      assert.ok(url.includes("/v1/extract"));
      capturedBody = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            results: [
              {
                url: "https://example.com",
                title: "Example Page",
                full_content: "Full page content.",
              },
            ],
          }),
      };
    };

    const adapter = new ParallelAdapter(
      { env: { PARALLEL_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );

    await adapter.reader.fetch.invoke({ url: "https://example.com" });
    assert.ok(capturedBody.advanced_settings, "body must include advanced_settings");
    assert.strictEqual(
      capturedBody.advanced_settings.full_content,
      true,
      "advanced_settings.full_content must be true",
    );
  });

  it("reader prefers full_content over excerpts (8P.2)", async () => {
    const fakeFetch = async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          results: [
            {
              url: "https://example.com",
              title: "Example Page",
              excerpts: ["Excerpt fragment one."],
              full_content: "The complete page body, not just a bounded excerpt.",
            },
          ],
        }),
    });

    const adapter = new ParallelAdapter(
      { env: { PARALLEL_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );

    const result = await adapter.reader.fetch.invoke({ url: "https://example.com" });
    assert.equal(result.content, "The complete page body, not just a bounded excerpt.");
    assert.notEqual(result.content, "Excerpt fragment one.");
  });

  it("reader surfaces extraction errors from errors[]", async () => {
    const fakeFetch = async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          results: [],
          errors: [
            // Decoy entry for a DIFFERENT url with a DIFFERENT status: an
            // adapter that surfaces an errors[] entry without matching by
            // url would surface this one and must fail the statusCode pin
            // below (#60 — a wrong-URL throw used to pass the checks).
            { url: "https://unrelated.page", error_type: "timeout", http_status_code: 503 },
            { url: "https://broken.page", error_type: "fetch_failed", http_status_code: 404 },
          ],
        }),
    });

    const adapter = new ParallelAdapter(
      { env: { PARALLEL_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );

    await assert.rejects(
      () => adapter.reader.fetch.invoke({ url: "https://broken.page" }),
      (err) =>
        err instanceof ApiError &&
        // The surfaced status must be the entry matching the REQUESTED url
        // (404), not the decoy entry's 503 (#60).
        err.statusCode === 404 &&
        // Pin the error-normalization contract for the errors[] path: at
        // HEAD normalizeParallelError replaces the inner
        // "Parallel AI extract failed for URL (fetch_failed)" message
        // (which names url/error_type) with this generic one while keeping
        // the mapped status. If normalization changes — e.g. starts
        // passing the error_type/URL detail through — update this pin
        // (#60).
        err.message === "Parallel AI request failed",
    );
  });

  it("rejects reader URL without http(s) prefix", () => {
    const adapter = new ParallelAdapter(
      { env: { PARALLEL_API_KEY: TEST_KEY } },
      { transport: { fetch: async () => ({}) } },
    );

    assert.throws(
      () => adapter.reader.fetch.validate({ url: "ftp://example.com" }),
      ValidationError,
    );
  });

  it("reader strips image markdown when retainImages:false (#52)", async () => {
    const fakeFetch = async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          results: [
            {
              url: "https://example.com",
              title: "Example Page",
              full_content:
                "Intro paragraph.\n\n![chart](https://example.com/chart.png)\n\nClosing paragraph.",
            },
          ],
        }),
    });

    const adapter = new ParallelAdapter(
      { env: { PARALLEL_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );

    const res = await adapter.reader.fetch.invoke({
      url: "https://example.com",
      retainImages: false,
    });
    assert.doesNotMatch(res.content, /!\[[^\]]*\]\([^)]*\)/);
  });

  it("reader keeps default image passthrough when retainImages omitted (#52)", async () => {
    const page = "Intro paragraph.\n\n![chart](https://example.com/chart.png)\n\nClosing paragraph.";
    const fakeFetch = async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          results: [{ url: "https://example.com", title: "Example Page", full_content: page }],
        }),
    });

    const adapter = new ParallelAdapter(
      { env: { PARALLEL_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );

    const res = await adapter.reader.fetch.invoke({ url: "https://example.com" });
    assert.equal(res.content, page);
  });

  it("reader rejects retainImages:true as UnsupportedOptionError (#52)", () => {
    const adapter = new ParallelAdapter(
      { env: { PARALLEL_API_KEY: TEST_KEY } },
      { transport: { fetch: async () => ({}) } },
    );

    assert.throws(
      () => adapter.reader.fetch.validate({ url: "https://example.com", retainImages: true }),
      (e) => e instanceof UnsupportedOptionError && e.option === "retainImages",
    );
  });

  it("invokes research via the Task/Deep Research API (create→poll→retrieve) (8P.1)", async () => {
    const stateFile = createInMemoryAsyncJobStateFile();
    const { fetch: taskFetch, calls } = makeTaskFetch({
      pollResponses: [RUNNING_408, COMPLETED_RESULT],
    });

    const adapter = new ParallelAdapter(
      { env: { PARALLEL_API_KEY: TEST_KEY } },
      { transport: { fetch: taskFetch }, researchStateFile: stateFile },
    );

    adapter.research.run.validate({ query: "AI search engines" });
    const res = await adapter.research.run.invoke({ query: "AI search engines" });

    // Result is a SYNTHESIZED report, not concatenated search excerpts
    assert.equal(res.schemaVersion, 1);
    assert.equal(res.query, "AI search engines");
    assert.equal(res.report, "## Deep Research Report\n\nMulti-step synthesized analysis.");
    assert.equal(res.model, "ultra"); // echoed processor from run
    assert.equal(res.sources.length, 2);
    assert.equal(res.sources[0].title, "Source A");
    assert.equal(res.sources[0].url, "https://a.example.com");

    // POST /v1/tasks/runs happened exactly once
    const posts = calls.filter((c) => c.method === "POST" && c.url.includes("/v1/tasks/runs"));
    assert.equal(posts.length, 1, "must POST exactly one create request");

    // GET /result happened (at least 2 polls: 408 then completed)
    const gets = calls.filter((c) => c.method === "GET" && c.url.includes("/result"));
    assert.ok(gets.length >= 2, "must poll at least twice (running → completed)");

    // Create request uses the Task API body shape (input, processor, task_spec)
    const createBody = JSON.parse(posts[0].body);
    assert.equal(createBody.input, "AI search engines");
    assert.ok(createBody.processor, "create body must include a processor");
    assert.ok(createBody.task_spec, "create body must include task_spec");
    assert.equal(createBody.task_spec.output_schema.type, "text");

    // State file cleaned up after completion
    const identityHash = computeAsyncJobStateHash({
      provider: "parallel",
      capability: "research",
      credentialFingerprint: crypto.createHash("sha256").update(TEST_KEY).digest("hex"),
      request: { query: "AI search engines" },
    });
    assert.equal(stateFile.store.has(identityHash), false, "state file must be deleted on completion");
  });

  it("research does NOT call /v1/search — uses Task API exclusively (8P.1)", async () => {
    const stateFile = createInMemoryAsyncJobStateFile();
    const { fetch: taskFetch, calls } = makeTaskFetch({
      pollResponses: [COMPLETED_RESULT],
    });

    const adapter = new ParallelAdapter(
      { env: { PARALLEL_API_KEY: TEST_KEY } },
      { transport: { fetch: taskFetch }, researchStateFile: stateFile },
    );

    await adapter.research.run.invoke({ query: "test query" });

    // No request should hit /v1/search
    const searchCalls = calls.filter((c) => c.url.includes("/v1/search"));
    assert.equal(searchCalls.length, 0, "research must NOT call /v1/search");
  });

  it("research deduplicates sources by URL from basis citations (8P.1)", async () => {
    const stateFile = createInMemoryAsyncJobStateFile();
    const dedupResult = {
      status: 200,
      body: {
        run: { run_id: "trun-dedup", status: "completed", processor: "pro" },
        output: {
          type: "text",
          content: "Report with deduplicated sources.",
          basis: [
            {
              field: "point1",
              reasoning: "From multiple sources.",
              citations: [
                { title: "Source A", url: "https://dup.example.com" },
                { title: "Source B", url: "https://unique.example.com" },
              ],
            },
            {
              field: "point2",
              reasoning: "Also references A.",
              citations: [
                { title: "Source A again", url: "https://dup.example.com" },
                { title: "Source C", url: "https://c.example.com" },
              ],
            },
          ],
        },
      },
    };

    const { fetch: taskFetch } = makeTaskFetch({ pollResponses: [dedupResult] });
    const adapter = new ParallelAdapter(
      { env: { PARALLEL_API_KEY: TEST_KEY } },
      { transport: { fetch: taskFetch }, researchStateFile: stateFile },
    );

    const res = await adapter.research.run.invoke({ query: "dedup test" });
    // 3 unique URLs (dup.example.com appears twice in basis)
    assert.equal(res.sources.length, 3);
    assert.equal(res.sources[0].url, "https://dup.example.com");
    assert.equal(res.sources[0].title, "Source A"); // first-seen title preserved
    assert.equal(res.sources[1].url, "https://unique.example.com");
    assert.equal(res.sources[2].url, "https://c.example.com");
  });

  it("research maps model to processor in create request (8P.1)", async () => {
    const stateFile = createInMemoryAsyncJobStateFile();
    const { fetch: taskFetch, calls } = makeTaskFetch({
      pollResponses: [COMPLETED_RESULT],
    });
    const adapter = new ParallelAdapter(
      { env: { PARALLEL_API_KEY: TEST_KEY } },
      { transport: { fetch: taskFetch }, researchStateFile: stateFile },
    );

    await adapter.research.run.invoke({ query: "model test", model: "pro" });
    const post = calls.find((c) => c.method === "POST" && c.url.includes("/v1/tasks/runs"));
    const body = JSON.parse(post.body);
    assert.equal(body.processor, "ultra", "model pro must map to processor ultra");
  });

  it("research maps domain to source_policy.include_domains (8P.1)", async () => {
    const stateFile = createInMemoryAsyncJobStateFile();
    const { fetch: taskFetch, calls } = makeTaskFetch({
      pollResponses: [COMPLETED_RESULT],
    });
    const adapter = new ParallelAdapter(
      { env: { PARALLEL_API_KEY: TEST_KEY } },
      { transport: { fetch: taskFetch }, researchStateFile: stateFile },
    );

    await adapter.research.run.invoke({ query: "domain test", domain: "example.com" });
    const post = calls.find((c) => c.method === "POST" && c.url.includes("/v1/tasks/runs"));
    const body = JSON.parse(post.body);
    assert.deepEqual(body.source_policy.include_domains, ["example.com"]);
  });

  it("research resumes from state file instead of creating new task (8P.1)", async () => {
    const stateFile = createInMemoryAsyncJobStateFile();
    const request = { query: "resume test" };
    const identityHash = computeAsyncJobStateHash({
      provider: "parallel",
      capability: "research",
      credentialFingerprint: crypto.createHash("sha256").update(TEST_KEY).digest("hex"),
      request,
    });

    // Pre-populate: simulate a task created by a previous (interrupted) run
    stateFile.store.set(
      identityHash,
      JSON.stringify({
        requestId: "trun-from-prev-run",
        identityHash,
        createdAt: new Date().toISOString(),
        status: "pending",
      }),
    );

    const { fetch: taskFetch, calls } = makeTaskFetch({
      pollResponses: [COMPLETED_RESULT],
    });
    const adapter = new ParallelAdapter(
      { env: { PARALLEL_API_KEY: TEST_KEY } },
      { transport: { fetch: taskFetch }, researchStateFile: stateFile },
    );

    const res = await adapter.research.run.invoke(request);
    assert.equal(res.report, "## Deep Research Report\n\nMulti-step synthesized analysis.");

    // No POST — the existing task was polled directly
    const posts = calls.filter((c) => c.method === "POST" && c.url.includes("/v1/tasks/runs"));
    assert.equal(posts.length, 0, "must not POST when resuming from state file");

    // State file cleaned up
    assert.equal(stateFile.store.has(identityHash), false);
  });

  it("research throws ApiError on task failure and cleans up state file (8P.1)", async () => {
    const stateFile = createInMemoryAsyncJobStateFile();
    const { fetch: taskFetch } = makeTaskFetch({
      pollResponses: [FAILED_RESULT],
    });
    const adapter = new ParallelAdapter(
      { env: { PARALLEL_API_KEY: TEST_KEY } },
      { transport: { fetch: taskFetch }, researchStateFile: stateFile },
    );

    await assert.rejects(
      () => adapter.research.run.invoke({ query: "fail test" }),
      (err) => err instanceof ApiError && err.statusCode === 500,
    );

    const identityHash = computeAsyncJobStateHash({
      provider: "parallel",
      capability: "research",
      credentialFingerprint: crypto.createHash("sha256").update(TEST_KEY).digest("hex"),
      request: { query: "fail test" },
    });
    assert.equal(stateFile.store.has(identityHash), false, "state file must be deleted on failure");
  });

  it("research handles 404 not_found by creating a fresh task (8P.1)", async () => {
    const stateFile = createInMemoryAsyncJobStateFile();
    const { fetch: taskFetch, calls } = makeTaskFetch({
      // First poll: 404 (stale/expired run)
      // Then new POST creates a fresh run
      // Then completed
      pollResponses: [NOT_FOUND_404, COMPLETED_RESULT],
    });
    const adapter = new ParallelAdapter(
      { env: { PARALLEL_API_KEY: TEST_KEY } },
      { transport: { fetch: taskFetch }, researchStateFile: stateFile },
    );

    const res = await adapter.research.run.invoke({ query: "404 recovery" });
    assert.equal(res.report, "## Deep Research Report\n\nMulti-step synthesized analysis.");

    // Two POSTs: initial create + fresh create after 404
    const posts = calls.filter((c) => c.method === "POST" && c.url.includes("/v1/tasks/runs"));
    assert.equal(posts.length, 2, "must create a fresh task after 404");
  });

  it("research terminates after repeated 404 instead of unbounded recreation (Cubic P0)", async () => {
    const stateFile = createInMemoryAsyncJobStateFile();
    const { fetch: taskFetch, calls } = makeTaskFetch({
      // Every poll returns 404 — the freshly created tasks keep disappearing
      pollResponses: [NOT_FOUND_404, NOT_FOUND_404, NOT_FOUND_404],
    });
    const adapter = new ParallelAdapter(
      { env: { PARALLEL_API_KEY: TEST_KEY } },
      { transport: { fetch: taskFetch }, researchStateFile: stateFile },
    );

    await assert.rejects(
      () => adapter.research.run.invoke({ query: "repeated 404" }),
      (err) => err instanceof ApiError && err.statusCode === 500,
    );

    // At most 2 POSTs: initial create + 1 recreation. NOT unbounded.
    const posts = calls.filter((c) => c.method === "POST" && c.url.includes("/v1/tasks/runs"));
    assert.equal(posts.length, 2, "must not create more than 2 tasks (initial + 1 recreation)");
  });

  it("research treats cancelled status as terminal failure (Cubic P1)", async () => {
    const stateFile = createInMemoryAsyncJobStateFile();
    const cancelledResult = {
      status: 200,
      body: {
        run: { run_id: "trun-cancelled", status: "cancelled" },
        output: null,
      },
    };
    const { fetch: taskFetch } = makeTaskFetch({ pollResponses: [cancelledResult] });
    const adapter = new ParallelAdapter(
      { env: { PARALLEL_API_KEY: TEST_KEY } },
      { transport: { fetch: taskFetch }, researchStateFile: stateFile },
    );

    await assert.rejects(
      () => adapter.research.run.invoke({ query: "cancelled test" }),
      (err) => err instanceof ApiError && err.statusCode === 500,
    );
  });

  it("research withResearchLock prevents concurrent double-create (Cubic P1)", async () => {
    const stateFile = createInMemoryAsyncJobStateFile();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "parallel-research-lock-"));
    let postCount = 0;

    // Simulate a realistic server long-poll: A's first /result poll
    // returns 408 after a short delay, keeping A in the poll loop while
    // B acquires the lock and finds A's persisted run_id. In production,
    // the server's 60s long-poll provides this window naturally.
    let getResultCount = 0;
    const fakeFetch = async (url, init) => {
      const u = String(url);
      const method = init?.method ?? "GET";

      if (method === "POST" && u.includes("/v1/tasks/runs")) {
        postCount++;
        return {
          ok: true,
          status: 202,
          text: async () =>
            JSON.stringify({ run_id: `trun-concurrent-${postCount}`, status: "queued" }),
        };
      }

      if (method === "GET" && u.includes("/result")) {
        getResultCount++;
        // First poll: delay 20ms then return 408 (running). This keeps
        // caller A in the poll loop while B acquires the lock and
        // re-reads the persisted state.
        if (getResultCount === 1) {
          await new Promise((r) => setTimeout(r, 20));
          return {
            ok: false,
            status: 408,
            text: async () => '{"error":{"message":"timed out, run still active"}}',
          };
        }
        // Subsequent polls: completed
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              run: { status: "completed", processor: "pro" },
              output: { type: "text", content: "Shared report.", basis: [] },
            }),
        };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ results: [] }) };
    };

    const adapter = new ParallelAdapter(
      { env: { PARALLEL_API_KEY: TEST_KEY } },
      {
        // Cap lock retry at 10ms (well under the 20ms poll delay) so B
        // acquires the lock while A is still in the poll loop.
        transport: { fetch: fakeFetch, setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 10)) },
        researchStateFile: stateFile,
        researchStateDir: tmpDir,
      },
    );

    const request = { query: "concurrent test" };
    const [result1, result2] = await Promise.all([
      adapter.research.run.invoke(request),
      adapter.research.run.invoke(request),
    ]);

    // Only ONE POST — the second invoke found the first's persisted run_id
    assert.equal(postCount, 1, "concurrent identical invokes must share a single POST");
    // Both get results
    assert.equal(result1.report, "Shared report.");
    assert.equal(result2.report, "Shared report.");

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("research sends x-api-key header on task create and result (8P.6)", async () => {
    const stateFile = createInMemoryAsyncJobStateFile();
    let createHeaders = null;
    let resultHeaders = null;
    const fakeFetch = async (url, init) => {
      const u = String(url);
      if (init?.method === "POST" && u.includes("/v1/tasks/runs")) {
        createHeaders = init.headers;
        return {
          ok: true,
          status: 202,
          text: async () => JSON.stringify({ run_id: "trun-hdr", status: "queued" }),
        };
      }
      if (init?.method === "GET" && u.includes("/result")) {
        resultHeaders = init.headers;
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              run: { status: "completed", processor: "pro" },
              output: { type: "text", content: "Report.", basis: [] },
            }),
        };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ results: [] }) };
    };
    const adapter = new ParallelAdapter(
      { env: { PARALLEL_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch }, researchStateFile: stateFile },
    );

    await adapter.research.run.invoke({ query: "header test" });
    assert.strictEqual(createHeaders["x-api-key"], TEST_KEY, "create must send x-api-key");
    assert.ok(!("Authorization" in createHeaders), "create must NOT send Authorization");
    assert.strictEqual(resultHeaders["x-api-key"], TEST_KEY, "result must send x-api-key");
    assert.ok(!("Authorization" in resultHeaders), "result must NOT send Authorization");
  });
});

describe("Parallel AI Error Handling", () => {
  it("maps 401 to AuthError", async () => {
    const fakeFetch = async () => ({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ message: "Invalid API key" }),
    });

    const adapter = new ParallelAdapter(
      { env: { PARALLEL_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );

    await assert.rejects(
      () => adapter.search.invoke({ query: "test" }),
      (err) => err instanceof AuthError,
    );
  });

  it("maps 429 to ApiError with status 429", async () => {
    const fakeFetch = async () => ({
      ok: false,
      status: 429,
      text: async () => JSON.stringify({ message: "Rate limited" }),
    });

    const adapter = new ParallelAdapter(
      { env: { PARALLEL_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );

    await assert.rejects(
      () => adapter.search.invoke({ query: "test" }),
      (err) => err instanceof ApiError && err.statusCode === 429,
    );
  });

  it("maps 402 to terminal QuotaError (8P.5)", async () => {
    const fakeFetch = async () => ({
      ok: false,
      status: 402,
      text: async () => JSON.stringify({ message: "Insufficient credit" }),
    });

    const adapter = new ParallelAdapter(
      { env: { PARALLEL_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );

    await assert.rejects(
      () => adapter.search.invoke({ query: "test" }),
      (err) => err instanceof QuotaError && err.retryable === false,
    );
  });

  it("maps 422 to ValidationError (8P.5)", async () => {
    const fakeFetch = async () => ({
      ok: false,
      status: 422,
      text: async () => JSON.stringify({ message: "Validation failed" }),
    });

    const adapter = new ParallelAdapter(
      { env: { PARALLEL_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );

    await assert.rejects(
      () => adapter.search.invoke({ query: "test" }),
      (err) => err instanceof ValidationError,
    );
  });

  it("sends x-api-key header, not Authorization: Bearer (8P.6)", async () => {
    let capturedHeaders = null;
    const fakeFetch = async (_url, init) => {
      capturedHeaders = init.headers;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ results: [] }),
      };
    };

    const adapter = new ParallelAdapter(
      { env: { PARALLEL_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );

    await adapter.search.invoke({ query: "test" });
    assert.ok(capturedHeaders, "headers must be captured");
    assert.strictEqual(capturedHeaders["x-api-key"], TEST_KEY, "must send x-api-key header");
    assert.ok(!("Authorization" in capturedHeaders), "must NOT send Authorization header");
  });

  it("maps 402 to QuotaError on extract path (8P.5)", async () => {
    const fakeFetch = async () => ({
      ok: false,
      status: 402,
      text: async () => JSON.stringify({ message: "Insufficient credit" }),
    });

    const adapter = new ParallelAdapter(
      { env: { PARALLEL_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );

    await assert.rejects(
      () => adapter.reader.fetch.invoke({ url: "https://example.com" }),
      (err) => err instanceof QuotaError && err.retryable === false,
    );
  });

  it("sends x-api-key header on extract path (8P.6)", async () => {
    let capturedHeaders = null;
    const fakeFetch = async (_url, init) => {
      capturedHeaders = init.headers;
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            results: [{ url: "https://example.com", full_content: "Page content" }],
          }),
      };
    };

    const adapter = new ParallelAdapter(
      { env: { PARALLEL_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );

    await adapter.reader.fetch.invoke({ url: "https://example.com" });
    assert.ok(capturedHeaders, "headers must be captured");
    assert.strictEqual(capturedHeaders["x-api-key"], TEST_KEY, "must send x-api-key header");
    assert.ok(!("Authorization" in capturedHeaders), "must NOT send Authorization header");
  });

  it("accepts domain control and maps to source_policy.include_domains (8P.3)", async () => {
    let capturedBody = null;
    const fakeFetch = async (url, init) => {
      capturedBody = JSON.parse(init.body);
      return { ok: true, status: 200, text: async () => JSON.stringify({ results: [] }) };
    };

    const adapter = new ParallelAdapter(
      { env: { PARALLEL_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );

    adapter.search.validate({ query: "test", controls: { domain: "example.com" } });
    await adapter.search.invoke({ query: "test", controls: { domain: "example.com" } });
    assert.deepEqual(
      capturedBody.advanced_settings.source_policy.include_domains,
      ["example.com"],
      "domain must map to source_policy.include_domains",
    );
  });

  it("accepts recency control and maps to source_policy.after_date (8P.3)", async () => {
    let capturedBody = null;
    const fakeFetch = async (url, init) => {
      capturedBody = JSON.parse(init.body);
      return { ok: true, status: 200, text: async () => JSON.stringify({ results: [] }) };
    };

    const adapter = new ParallelAdapter(
      { env: { PARALLEL_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );

    adapter.search.validate({ query: "test", controls: { recency: "oneWeek" } });
    await adapter.search.invoke({ query: "test", controls: { recency: "oneWeek" } });
    const afterDate = capturedBody.advanced_settings.source_policy.after_date;
    assert.ok(afterDate, "after_date must be present");
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(afterDate), "after_date must be an RFC 3339 date");
  });

  it("maps recency oneDay to the UTC date one day before the mapping instant (#58a pin)", async () => {
    let capturedBody = null;
    const fakeFetch = async (url, init) => {
      capturedBody = JSON.parse(init.body);
      return { ok: true, status: 200, text: async () => JSON.stringify({ results: [] }) };
    };

    const adapter = new ParallelAdapter(
      { env: { PARALLEL_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );

    const utcDateMinusOneDay = (instant) => {
      const d = new Date(instant.getTime());
      d.setUTCDate(d.getUTCDate() - 1);
      return d.toISOString().split("T")[0];
    };
    const before = new Date();
    await adapter.search.invoke({ query: "test", controls: { recency: "oneDay" } });
    const after = new Date();
    const afterDate = capturedBody.advanced_settings.source_policy.after_date;
    assert.ok(
      afterDate === utcDateMinusOneDay(before) || afterDate === utcDateMinusOneDay(after),
      `after_date ${afterDate} must equal the UTC calendar date one day before the mapping instant`,
    );
  });

  it("omits after_date for recency noLimit (8P.3)", async () => {
    let capturedBody = null;
    const fakeFetch = async (url, init) => {
      capturedBody = JSON.parse(init.body);
      return { ok: true, status: 200, text: async () => JSON.stringify({ results: [] }) };
    };

    const adapter = new ParallelAdapter(
      { env: { PARALLEL_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );

    await adapter.search.invoke({ query: "test", controls: { recency: "noLimit" } });
    assert.ok(
      !capturedBody.advanced_settings?.source_policy?.after_date,
      "after_date must be absent for noLimit",
    );
  });

  it("accepts location 'us' and maps to advanced_settings.location (8P.3)", async () => {
    let capturedBody = null;
    const fakeFetch = async (url, init) => {
      capturedBody = JSON.parse(init.body);
      return { ok: true, status: 200, text: async () => JSON.stringify({ results: [] }) };
    };

    const adapter = new ParallelAdapter(
      { env: { PARALLEL_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );

    adapter.search.validate({ query: "test", controls: { location: "us" } });
    await adapter.search.invoke({ query: "test", controls: { location: "us" } });
    assert.equal(capturedBody.advanced_settings.location, "us", "location must map to advanced_settings.location");
  });

  it("rejects unsupported location 'cn' as UnsupportedOptionError (8P.3)", () => {
    const adapter = new ParallelAdapter(
      { env: { PARALLEL_API_KEY: TEST_KEY } },
      { transport: { fetch: async () => ({}) } },
    );

    assert.throws(
      () => adapter.search.validate({ query: "test", controls: { location: "cn" } }),
      UnsupportedOptionError,
    );
  });

  it("accepts contentSize and maps to excerpt_settings.max_chars_per_result (8P.3)", async () => {
    let capturedBody = null;
    const fakeFetch = async (url, init) => {
      capturedBody = JSON.parse(init.body);
      return { ok: true, status: 200, text: async () => JSON.stringify({ results: [] }) };
    };

    const adapter = new ParallelAdapter(
      { env: { PARALLEL_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );

    adapter.search.validate({ query: "test", controls: { contentSize: "high" } });
    await adapter.search.invoke({ query: "test", controls: { contentSize: "high" } });
    assert.equal(
      capturedBody.advanced_settings.excerpt_settings.max_chars_per_result,
      5000,
      "contentSize high must map to 5000-char excerpt budget",
    );
  });

  it("rejects overlong query (>200 chars) with ValidationError (8P.4)", () => {
    const adapter = new ParallelAdapter(
      { env: { PARALLEL_API_KEY: TEST_KEY } },
      { transport: { fetch: async () => ({}) } },
    );

    const longQuery = "a".repeat(201);
    assert.throws(
      () => adapter.search.validate({ query: longQuery }),
      (e) => e instanceof ValidationError && e.message.includes("200"),
    );
  });

  it("rejects query that exceeds 200 chars after topic expansion (8P.4)", () => {
    const adapter = new ParallelAdapter(
      { env: { PARALLEL_API_KEY: TEST_KEY } },
      { transport: { fetch: async () => ({}) } },
    );

    // 195 chars + " latest news" (12 chars) = 207 chars — over the limit
    const baseQuery = "a".repeat(195);
    assert.throws(
      () => adapter.search.validate({ query: baseQuery, controls: { topic: "news" } }),
      (e) => e instanceof ValidationError && e.message.includes("topic expansion"),
    );
  });

  it("accepts query at exactly 200 chars after topic expansion (8P.4)", () => {
    const adapter = new ParallelAdapter(
      { env: { PARALLEL_API_KEY: TEST_KEY } },
      { transport: { fetch: async () => ({}) } },
    );

    // 188 chars + " latest news" (12 chars) = 200 chars — exactly at limit
    const baseQuery = "a".repeat(188);
    adapter.search.validate({ query: baseQuery, controls: { topic: "news" } });
  });

  it("rejects invalid domain syntax (8P.3)", () => {
    const adapter = new ParallelAdapter(
      { env: { PARALLEL_API_KEY: TEST_KEY } },
      { transport: { fetch: async () => ({}) } },
    );

    assert.throws(
      () => adapter.search.validate({ query: "test", controls: { domain: "https://example.com" } }),
      ValidationError,
    );
    assert.throws(
      () => adapter.search.validate({ query: "test", controls: { domain: "example.com/path" } }),
      ValidationError,
    );
  });

  it("rejects overlong research input (>15000 chars) with ValidationError (8P.1)", () => {
    const adapter = new ParallelAdapter(
      { env: { PARALLEL_API_KEY: TEST_KEY } },
      { transport: { fetch: async () => ({}) } },
    );

    const longQuery = "a".repeat(15001);
    assert.throws(
      () => adapter.research.run.validate({ query: longQuery }),
      (e) => e instanceof ValidationError && e.message.includes("15000"),
    );
  });

  it("accepts research input at exactly 15000 chars (8P.1)", () => {
    const adapter = new ParallelAdapter(
      { env: { PARALLEL_API_KEY: TEST_KEY } },
      { transport: { fetch: async () => ({}) } },
    );

    const maxQuery = "a".repeat(15000);
    adapter.research.run.validate({ query: maxQuery });
  });

  it("accepts model, domain, outputLength, citationFormat for research (8P.1)", () => {
    const adapter = new ParallelAdapter(
      { env: { PARALLEL_API_KEY: TEST_KEY } },
      { transport: { fetch: async () => ({}) } },
    );

    // These were previously rejected as UnsupportedOptionError.
    // Now they map to processor/source_policy/description.
    adapter.research.run.validate({ query: "test", model: "pro" });
    adapter.research.run.validate({ query: "test", domain: "example.com" });
    adapter.research.run.validate({ query: "test", outputLength: "long" });
    adapter.research.run.validate({ query: "test", citationFormat: "apa" });
  });
});
