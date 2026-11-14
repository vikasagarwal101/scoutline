import test from "node:test";
import assert from "node:assert/strict";
const root =
  new URL("..", import.meta.url).pathname;
const { createTypesafeJudge } = await import(`${root}/dist/lib/lean-typesafe-judge.js`);
const { createLeanAcquisitionDeps } = await import(`${root}/dist/lib/lean-acquisition-bridge.js`);
const { createTavilyDescriptor } = await import(`${root}/dist/providers/tavily/adapter.js`);
const source = {
  evidenceId: "e1",
  url: "https://fixture.invalid/source",
  title: "source",
  content: "License MIT.",
  byteLength: 12,
  origins: [],
};
const cand = {
  source,
  scope: {},
  fieldMeanings: { license: "License?" },
  opposingContext: [],
  candidates: [
    {
      fieldId: "license",
      value: "MIT",
      quote: source.content,
      charRange: [0, source.content.length],
    },
  ],
};
const enumInput = {
  fieldId: "csv",
  fieldQuestion: "CSV?",
  criteria: [],
  scope: {},
  candidates: ["supported"],
  documents: [{ evidenceId: "e1", url: source.url, title: "source", content: source.content }],
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Real production seams only: the acquisition bridge (extractor-side
// bounded native read) and the official direct-TypeSafe judge. No
// test-local abort races or read pumps — production owns them.
function bridgeOver(fetch) {
  const env = { TAVILY_API_KEY: "obviously-fake", TAVILY_TIMEOUT: "1000" };
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
    now: Date.now,
  });
}
async function invoke(stage, fetchLike, options) {
  if (stage === "extractor") {
    try {
      return { kind: "ok", value: await bridgeOver(fetchLike).read(source.url, options) };
    } catch (error) {
      return { kind: "error", code: error.code ?? error.name };
    }
  }
  const profile = createTypesafeJudge({
    apiKey: "obviously-fake",
    reserveAttempt: () => {},
    fetchLike,
  });
  const call = stage === "candidate" ? profile.candidateJudge : profile.judge;
  const input = stage === "candidate" ? cand : enumInput;
  try {
    return { kind: "ok", value: await call(input, options) };
  } catch (error) {
    return { kind: "error", code: error.code };
  }
}
for (const stage of ["extractor", "candidate", "classification"]) {
  test(`${stage} pre-aborted dispatch settles immediately without physical fetch`, async () => {
    const controller = new AbortController();
    controller.abort();
    let physical = 0;
    const start = performance.now();
    const result = await invoke(
      stage,
      async () => {
        physical++;
        await sleep(100);
        return {
          status: 401,
          ok: false,
          headers: { get: () => null },
          body: new ReadableStream({
            start(c) {
              c.close();
            },
          }),
        };
      },
      { timeoutMs: 1000, signal: controller.signal },
    );
    assert.equal(physical, 0, "already cancelled work still physically dispatched");
    assert(performance.now() - start < 60);
    assert.equal(result.kind, "error");
  });
  test(`${stage} external abort during chunked body cancels reader and removes listener`, async () => {
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
    const timer = setTimeout(() => controller.abort(), 5);
    const start = performance.now();
    const result = await invoke(
      stage,
      async () => ({
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
      }),
      { timeoutMs: 1000, signal: controller.signal },
    );
    clearTimeout(timer);
    assert(performance.now() - start < 60);
    assert.equal(result.kind, "error");
    assert(cancelled);
    assert.equal(adds, removes);
  });
}
