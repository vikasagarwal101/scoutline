import test from "node:test";
import assert from "node:assert/strict";
const root =
  new URL("..", import.meta.url).pathname;
const { runLeanInvestigation } = await import(`${root}/dist/lib/lean-investigation.js`);
const { createLeanJevJudge } = await import(`${root}/dist/lib/lean-jev-adapter.js`);
const config = {
  endpoint: "https://fixture.invalid/no-network",
  model: "fixture",
  apiKey: "obviously-fake",
  timeoutMs: 1000,
};
async function tracked(body) {
  const originalSet = globalThis.setTimeout,
    originalClear = globalThis.clearTimeout;
  const timers = new Set();
  globalThis.setTimeout = (fn, ms, ...args) => {
    let timer;
    timer = originalSet(() => {
      timers.delete(timer);
      fn(...args);
    }, ms);
    timers.add(timer);
    return timer;
  };
  globalThis.clearTimeout = (timer) => {
    timers.delete(timer);
    return originalClear(timer);
  };
  try {
    await body();
    assert.equal(timers.size, 0, "owned timeout remains live after completed call");
  } finally {
    for (const timer of timers) originalClear(timer);
    globalThis.setTimeout = originalSet;
    globalThis.clearTimeout = originalClear;
  }
}
for (const mode of ["semantic", "deterministic-only"])
  test(`run expiry timer released on ordinary ${mode} exit`, async () =>
    tracked(async () => {
      let signal;
      const input = {
        schemaVersion: 1,
        question: "CSV?",
        requirements: { csv: { question: "CSV?", schema: { enum: ["supported"] } } },
      };
      const result = await runLeanInvestigation(input, {
        now: () => 0,
        search: async (_q, options) => {
          signal = options.signal;
          return [{ url: "https://fixture.invalid/doc" }];
        },
        read: async () => "CSV works.",
        judge:
          mode === "semantic"
            ? async (input) => ({
                documents: input.documents.map((x) => ({
                  evidenceId: x.evidenceId,
                  relevant: true,
                  supportsClaim: true,
                  refutesClaim: false,
                })),
              })
            : null,
      });
      assert(signal.aborted, "run-owned signal not disposed on exit");
      assert.equal(result.assessment, mode);
    }));
test("actual native chunked-body timeout cancels owned reader and removes external listener", async () =>
  tracked(async () => {
    const controller = new AbortController();
    let adds = 0,
      removes = 0,
      cancelled = false;
    const add = controller.signal.addEventListener.bind(controller.signal),
      remove = controller.signal.removeEventListener.bind(controller.signal);
    controller.signal.addEventListener = (...args) => {
      adds++;
      return add(...args);
    };
    controller.signal.removeEventListener = (...args) => {
      removes++;
      return remove(...args);
    };
    const judge = createLeanJevJudge(config, async () => ({
      status: 200,
      ok: true,
      headers: { get: () => "application/json" },
      body: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('{"model":'));
        },
        cancel() {
          cancelled = true;
        },
      }),
    }));
    await assert.rejects(
      judge(
        {
          fieldId: "csv",
          fieldQuestion: "CSV?",
          criteria: [],
          scope: {},
          candidates: ["supported"],
          documents: [
            {
              evidenceId: "e1",
              url: "https://fixture.invalid/doc",
              title: "doc",
              content: "CSV works.",
            },
          ],
        },
        { timeoutMs: 10, signal: controller.signal },
      ),
    );
    assert(cancelled);
    assert.equal(adds, removes);
  }));
