import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createDeepSeekDescriptor } from "../dist/providers/deepseek/adapter.js";
import { requestDeepSeek } from "../dist/providers/deepseek/client.js";
import { executeSearch, executeReaderOperation } from "../dist/lib/execution.js";

function completedBody(payload, cancel, microtasks = 4) {
  let sent = false;
  return new Response(new ReadableStream({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(new TextEncoder().encode(JSON.stringify(payload)));
      } else {
        controller.close();
        // Model cancellation queued by the transport as its final body read
        // completes, before the awaiting caller admits the response.
        let remaining = microtasks;
        const later = () => remaining-- ? queueMicrotask(later) : cancel();
        queueMicrotask(later);
      }
    },
  }, { highWaterMark: 0 }));
}

describe("DeepSeek cancellation admission", () => {
  it("transport rejects cancellation before admitting the completed response", async () => {
    const controller = new AbortController();
    await assert.rejects(requestDeepSeek("search", "test-key", { query: "q" }, {
      fetch: async () => completedBody({ results: [] }, () => controller.abort()),
    }, controller.signal), { code: "TIMEOUT_ERROR", durationMs: 0 });
  });

  for (const kind of ["search", "reader"]) {
    it(`${kind} rejects cancellation at body completion without caching success`, async () => {
      const controller = new AbortController();
      let calls = 0;
      const adapter = createDeepSeekDescriptor({ transport: { fetch: async () => {
        calls++;
        return completedBody(kind === "search" ? { results: [] } : { title: "Page", content: "Text" },
          () => controller.abort());
      } } }).create({ env: { DEEPSEEK_API_KEY: "test-key" } });
      const sleeps = [], writes = [];
      const deps = {
        cache: { async get() { return null; }, async set(...args) { writes.push(args); } },
        async sleep(ms) { sleeps.push(ms); }, random: () => 0,
      };
      const result = kind === "search"
        ? executeSearch(adapter.search, { query: "q" }, { signal: controller.signal }, deps)
        : executeReaderOperation(adapter.reader.fetch, { url: "https://example.test/page" }, { signal: controller.signal }, deps);
      await assert.rejects(result, { code: "TIMEOUT_ERROR", durationMs: 0 });
      assert.equal(calls, 1);
      assert.deepEqual(sleeps, []);
      assert.deepEqual(writes, []);
    });

    it(`${kind} rejects cancellation queued before adapter response admission`, async () => {
      const controller = new AbortController();
      const adapter = createDeepSeekDescriptor({ transport: { fetch: async () =>
        completedBody(kind === "search" ? { results: [] } : { title: "Page", content: "Text" },
          () => controller.abort(), 6),
      } }).create({ env: { DEEPSEEK_API_KEY: "test-key" } });
      const result = kind === "search"
        ? adapter.search.invoke({ query: "q" }, controller.signal)
        : adapter.reader.fetch.invoke({ url: "https://example.test/page" }, controller.signal);
      await assert.rejects(result, { code: "TIMEOUT_ERROR", durationMs: 0 });
    });
  }
});
