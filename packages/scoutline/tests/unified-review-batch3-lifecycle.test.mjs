import test from "node:test";
import assert from "node:assert/strict";
const root =
  new URL("..", import.meta.url).pathname;
const { runLunaExtraction, runCandidateJudge } = await import(
  `${root}/dist/lib/lean-candidate-transport.js`
);
const { buildCandidateJudgeRequest } = await import(`${root}/dist/lib/lean-candidates.js`);
const { createLeanJevJudge } = await import(`${root}/dist/lib/lean-jev-adapter.js`);
const config = {
  endpoint: "https://fixture.invalid/no-network",
  model: "fixture",
  apiKey: "obviously-fake",
  timeoutMs: 1000,
  maxRequestBytes: 65536,
  maxResponseBytes: 65536,
};
const source = {
  evidenceId: "e1",
  url: "https://fixture.invalid/source",
  title: "source",
  content: "License MIT.",
  byteLength: 12,
  origins: [],
};
const candidate = {
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
function response(body, onCancel = () => {}) {
  return {
    status: 200,
    ok: true,
    headers: { get: () => "application/json" },
    body: new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(JSON.stringify(body)));
        c.close();
      },
      cancel: onCancel,
    }),
  };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (const stage of ["extractor", "candidate"])
  test(`public native ${stage} forwards cancellation and remaining timeout to its transport core`, async () => {
    const controller = new AbortController();
    let cancelled = false;
    const fetchLike = async () => {
      await sleep(100);
      return response(
        stage === "extractor"
          ? {
              model: "fixture",
              choices: [
                {
                  finish_reason: "stop",
                  message: { content: '{"license":{"value":"MIT","quote":"License MIT."}}' },
                },
              ],
              usage: { prompt_tokens: 1, completion_tokens: 1 },
            }
          : {
              model: "fixture",
              answers: { q0s: { type: "noul", noul: 0.97 }, q0c: { type: "noul", noul: 0.01 } },
              usage: { input_tokens: 1, output_tokens: 1 },
            },
        () => {
          cancelled = true;
        },
      );
    };
    const options = { timeoutMs: 10, signal: controller.signal };
    const started = performance.now();
    const result =
      stage === "extractor"
        ? await runLunaExtraction(
            {
              sourceId: "e1",
              sourceText: source.content,
              fields: [{ id: "license", description: "License?" }],
            },
            config,
            fetchLike,
            Date.now,
            options,
          )
        : await runCandidateJudge(
            candidate,
            config,
            buildCandidateJudgeRequest,
            fetchLike,
            Date.now,
            options,
          );
    const elapsed = performance.now() - started;
    assert(
      elapsed < 60,
      `public ${stage} ignored nativePost options; returned after ${elapsed.toFixed(1)}ms`,
    );
    assert.equal(result.kind, "error");
    await sleep(120);
    assert(cancelled);
  });
test("external cancellation promptly settles actual classification wrapper even when fetch ignores its signal", async () => {
  const controller = new AbortController();
  let cancelled = false;
  let nativeSignal;
  const judge = createLeanJevJudge(config, async (_url, init) => {
    nativeSignal = init.signal;
    await sleep(100);
    return response(
      {
        model: "fixture",
        answers: {
          q0r: { type: "noul", noul: 0.97 },
          q0s: { type: "noul", noul: 0.97 },
          q0f: { type: "noul", noul: 0.01 },
        },
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      () => {
        cancelled = true;
      },
    );
  });
  const input = {
    fieldId: "csv",
    fieldQuestion: "CSV?",
    criteria: [],
    scope: {},
    candidates: ["supported"],
    documents: [{ evidenceId: "e1", url: source.url, title: "source", content: source.content }],
  };
  const timer = setTimeout(() => controller.abort(), 5);
  const started = performance.now();
  let rejected = false;
  try {
    await judge(input, { timeoutMs: 1000, signal: controller.signal });
  } catch {
    rejected = true;
  }
  clearTimeout(timer);
  assert(nativeSignal.aborted, "actual native controller not connected");
  assert(performance.now() - started < 60, "abort hook set signal but did not settle header wait");
  assert(rejected, "aborted native request returned successful judgment");
  await sleep(120);
  assert(cancelled);
});
