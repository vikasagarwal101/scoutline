import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createDeepSeekDescriptor } from "../dist/providers/deepseek/adapter.js";
import { MAX_BUFFERED_RESPONSE_BYTES } from "../dist/lib/bounded-body.js";
import { executeSearch, executeReaderOperation } from "../dist/lib/execution.js";

function executionDeps() {
  const sleeps = [], events = [], writes = [];
  return {
    sleeps, events, writes,
    cache: { async get() { return null; }, async set(...args) { writes.push(args); } },
    async sleep(ms) { sleeps.push(ms); },
    random: () => 0,
    consume: { async record(event) { events.push(event); } },
  };
}

function execute(adapter, kind, deps) {
  return kind === "search"
    ? executeSearch(adapter.search, { query: "q" }, {}, deps)
    : executeReaderOperation(adapter.reader.fetch, { url: "https://example.test/page" }, {}, deps);
}

describe("DeepSeek response ceiling through shared execution", () => {
  for (const kind of ["search", "reader"]) {
    for (const declared of [true, false]) {
      it(`${kind} rejects ${declared ? "declared" : "chunked"} oversize without a second billable attempt`, async () => {
        let calls = 0, cancellations = 0, pulls = 0;
        const chunk = declared ? null : new Uint8Array(MAX_BUFFERED_RESPONSE_BYTES / 2 + 1);
        const adapter = createDeepSeekDescriptor({ transport: { fetch: async () => {
          calls++;
          return new Response(new ReadableStream({
            pull(controller) { pulls++; controller.enqueue(chunk); },
            cancel() { cancellations++; },
          }, { highWaterMark: 0 }), {
            headers: declared ? { "Content-Length": String(MAX_BUFFERED_RESPONSE_BYTES + 1) } : {},
          });
        } } }).create({ env: { DEEPSEEK_API_KEY: "test-key" } });
        const deps = executionDeps();
        await assert.rejects(execute(adapter, kind, deps), (error) => {
          assert.equal(error.code, "API_ERROR");
          assert.equal(error.message, "DeepSeek response exceeds the in-memory limit");
          assert.equal(Object.hasOwn(error, "statusCode"), true);
          assert.equal(error.statusCode, undefined, "a local ceiling must not claim an upstream HTTP status");
          return true;
        });
        await new Promise(setImmediate);
        assert.equal(calls, 1, "the fixed response ceiling cannot improve on retry");
        assert.deepEqual(deps.events.map(({ attempt }) => attempt), [1]);
        assert.deepEqual(deps.sleeps, []);
        assert.deepEqual(deps.writes, []);
        assert.equal(cancellations, 1);
        if (declared) assert.equal(pulls, 0);
        else assert.ok(pulls <= 3, `read too far: ${pulls} chunks`);
      });
    }

    for (const status of [429, 502]) {
      it(`${kind} still retries an upstream HTTP ${status}`, async () => {
        let calls = 0;
        const adapter = createDeepSeekDescriptor({ transport: { fetch: async () => {
          calls++;
          if (calls === 1) return new Response(null, { status });
          return Response.json(kind === "search" ? { results: [] } : { title: "Page", content: "Text" });
        } } }).create({ env: { DEEPSEEK_API_KEY: "test-key" } });
        const deps = executionDeps();
        const result = await execute(adapter, kind, deps);
        if (kind === "search") assert.deepEqual(result, []);
        else assert.equal(result.content, "Text");
        assert.equal(calls, 2);
        assert.deepEqual(deps.events.map(({ attempt }) => attempt), [1, 2]);
        assert.deepEqual(deps.sleeps, [500]);
        assert.equal(deps.writes.length, 1);
      });
    }
  }
});
