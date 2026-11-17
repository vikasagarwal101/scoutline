import test from "node:test";
import assert from "node:assert/strict";
import { createTavilyDescriptor } from "../dist/providers/tavily/adapter.js";
import { createLeanAcquisitionDeps } from "../dist/lib/lean-acquisition-bridge.js";
const env = { TAVILY_API_KEY: "synthetic", TAVILY_TIMEOUT: "1000" };
function depsFor(fetch) {
  const transport = { fetch, env };
  const descriptor = createTavilyDescriptor({ transport });
  return createLeanAcquisitionDeps({
    transports: { tavily: transport },
    descriptorFactory: (_id, t) => createTavilyDescriptor({ transport: t }),
    searchDescriptor: descriptor,
    readerDescriptor: descriptor,
    env,
    cache: { get: async () => null, set: async () => {} },
    sleep: async () => {},
    random: () => 0,
    retryPolicy: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, jitterMs: 0 },
    maxResponseBytes: 10,
  });
}
for (const mode of ["resolved", "rejected", "pending"]) {
  test(`byte-cap cancel ${mode} maps confirmation truthfully and releases reader lock`, async () => {
    let cancelCalls = 0;
    let releaseCancel;
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(" ".repeat(20)));
      },
      cancel() {
        cancelCalls++;
        if (mode === "rejected")
          return Promise.reject(new Error("native cancellation was not confirmed"));
        if (mode === "pending")
          return new Promise((resolve) => {
            releaseCancel = resolve;
          });
      },
    });
    const deps = depsFor(async () => new Response(stream));
    try {
      await assert.rejects(() =>
        deps.search("q", { signal: new AbortController().signal, timeoutMs: 20 }),
      );
      assert.equal(cancelCalls, 1);
      assert.equal(stream.locked, false);
      assert.equal(deps.physicalLedger.attempts, 1);
      assert.equal(
        deps.physicalLedger.perAttempt[0].outcome,
        mode === "resolved" ? "failed" : "unknown",
        "contained cancel rejection is not cancellation confirmation",
      );
    } finally {
      releaseCancel?.();
    }
  });
}
