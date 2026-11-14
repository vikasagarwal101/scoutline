// Native-composed offline transport. Only fake HTTP response solving is synthetic.
// Solvers see serialized native state only, never corpus labels or expected values.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { offlineDeps } from "./unified-review-offline-deps.mjs";
const root =
  new URL("..", import.meta.url).pathname;
const { buildCandidateJudgeRequest } = await import(`${root}/dist/lib/lean-candidates.js`);
const { createTypesafeJudge } = await import(`${root}/dist/lib/lean-typesafe-judge.js`);
const hash = (x) => createHash("sha256").update(x).digest("hex");
const p = (x) => (x === null ? 0.5 : x ? 0.97 : 0.01);
const config = (model) => ({
  endpoint: "https://native-fixture.invalid/never-network",
  apiKey: "obviously-fake-offline-key",
  model,
  allowedModels: [model],
  maxRequestBytes: 96 * 1024,
  maxResponseBytes: 64 * 1024,
  timeoutMs: 100,
});
function response(body, count) {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  count.responseBytes += bytes.length;
  return {
    status: 200,
    ok: true,
    headers: { get: () => "application/json" },
    body: new ReadableStream({
      start(controller) {
        // Split the body to exercise the real bounded incremental decoder.
        const middle = Math.floor(bytes.length / 2);
        controller.enqueue(bytes.slice(0, middle));
        controller.enqueue(bytes.slice(middle));
        controller.close();
      },
    }),
  };
}
function checkBindings(bindings) {
  for (const value of Object.values(bindings ?? {})) {
    assert.equal(typeof value.value, "string");
    assert.equal(typeof value.evidenceId, "string");
    assert.match(value.sourceDigest, /^[a-f0-9]{64}$/);
  }
}
function extraction(state) {
  assert(
    state.scope && typeof state.scope.entity === "string",
    "scope missing from actual extraction wire",
  );
  checkBindings(state.depBindings);
  const text = state.source.replace(/<script>[\s\S]*?<\/script>/g, "");
  const entity = state.scope.entity;
  const release = state.depBindings?.version?.value ?? state.scope.release;
  const escaped = release.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const output = {};
  for (const field of state.fields) {
    const bindings = field.depBindings ?? state.depBindings;
    checkBindings(bindings);
    if (field.id === "license")
      assert.equal(
        bindings?.version?.value,
        release,
        "license extraction lacks accepted version binding",
      );
    let value = null;
    if (field.id === "version") {
      const m = text.match(new RegExp(`${entity} release ([^\\s.;]+(?:\\.[^\\s.;]+)*)[.;\\s]`));
      if (m?.[1] === release) value = m[1];
    } else if (field.id === "license") {
      const m = text.match(
        new RegExp(
          `License for release ${escaped}: ([\\p{L}\\p{N}-]+(?:\\.[\\p{L}\\p{N}-]+)*)|release ${escaped} verification: license ([\\p{L}\\p{N}-]+(?:\\.[\\p{L}\\p{N}-]+)*)`,
          "iu",
        ),
      );
      if (m) value = m[1] ?? m[2];
    }
    const line =
      value === null
        ? null
        : state.source
            .split("\n")
            .find((line) => line.includes(value) && !line.includes("<script>"));
    output[field.id] = line ? { value, quote: line } : { value: null, quote: null };
  }
  return JSON.stringify(output);
}
function candidateAnswers(state) {
  checkBindings(state.depBindings);
  const all = [state.source.text, ...state.opposingContext.map((x) => x.text)].join("\n");
  const answers = {};
  for (const [i, field] of state.fields.entries()) {
    if (field.fieldId === "license")
      assert.equal(
        state.depBindings?.version?.value,
        state.scope.release,
        "candidate judgment lacks accepted version binding",
      );
    const conflict =
      field.fieldId === "license" &&
      /License for release 2\.0: GPL-3\.0/.test(all) &&
      /License for release 2\.0: MIT/.test(all);
    answers[`q${i}s`] = { type: "noul", noul: 0.97 };
    answers[`q${i}c`] = { type: "noul", noul: conflict ? 0.97 : 0.01 };
  }
  return answers;
}
function enumAnswers(state) {
  checkBindings(state.depBindings);
  if (/Does this release/.test(state.requirement) && state.depBindings?.license)
    assert.equal(typeof state.depBindings.license.value, "string");
  const answers = {};
  for (const [i, source] of state.sources.entries()) {
    const text = source.text.replace(/<script>[\s\S]*?<\/script>/g, "");
    const relevant =
      text.includes(state.scope.entity) &&
      (text.includes(`release ${state.scope.release}`) || state.scope.release === "current") &&
      !text.includes("These statements do not describe");
    answers[`q${i}r`] = { type: "noul", noul: p(relevant) };
    answers[`q${i}s`] = {
      type: "noul",
      noul: p(
        text.includes("does not independently document CSV behavior")
          ? null
          : /supports CSV export/.test(text),
      ),
    };
    answers[`q${i}f`] = { type: "noul", noul: p(/does not support CSV export/.test(text)) };
  }
  return answers;
}
export function nativeDeps(c) {
  const base = offlineDeps(c);
  const physical = {
    extraction: 0,
    candidate: 0,
    classification: 0,
    requestBytes: 0,
    responseBytes: 0,
  };
  const requests = [];
  const attempts = [];
  const fetchFor = (stage) => async (_url, init) => {
    assert.equal(init.method, "POST");
    assert.equal(init.redirect, "error");
    assert(init.signal instanceof AbortSignal);
    physical[stage]++;
    physical.requestBytes += Buffer.byteLength(init.body);
    const request = JSON.parse(init.body);
    const state =
      stage === "extraction"
        ? JSON.parse(request.messages.find((m) => m.role === "user").content)
        : request.state;
    requests.push({ stage, state, requestSha256: hash(init.body) });
    const body =
      stage === "extraction"
        ? {
            model: request.model,
            choices: [{ finish_reason: "stop", message: { content: extraction(state) } }],
            usage: { prompt_tokens: 11, completion_tokens: 7 },
          }
        : {
            model: request.model,
            answers: stage === "candidate" ? candidateAnswers(state) : enumAnswers(state),
            usage: { input_tokens: 13, output_tokens: 5 },
          };
    return response(body, physical);
  };
  const enumProfile = createTypesafeJudge({
    apiKey: "obviously-fake-offline-key",
    reserveAttempt: () => {},
    onAttempt: (event) => attempts.push({ stage: "classification", result: { kind: event.outcome, metadata: event } }),
    fetchLike: fetchFor("classification"),
  });
  const candidateProfile = createTypesafeJudge({
    apiKey: "obviously-fake-offline-key",
    reserveAttempt: () => {},
    fetchLike: fetchFor("candidate"),
  });
  const deps = {
    now: base.deps.now,
    search: base.deps.search,
    read: base.deps.read,
    extractorRevision: "native-composed-offline-v1",
    judge: enumProfile.judge,
    extract: async (input) => {
      // Extractor boundary over the same fake HTTP solver; the envelope
      // (choices/message/usage) is the contract the production engine
      // consumes via ExtractorDeps.
      const state = {
        source: input.sourceText,
        fields: input.fields,
        scope: input.scope ?? {},
        depBindings: input.depBindings ?? {},
      };
      const response = await fetchFor("extraction")(
        "https://parser.example.test/chat/completions",
        {
          method: "POST",
          redirect: "error",
          signal: new AbortController().signal,
          body: JSON.stringify({
            model: "fixture-native-extractor",
            messages: [
              { role: "system", content: "extract" },
              { role: "user", content: JSON.stringify(state) },
            ],
          }),
        },
      );
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let text = "";
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += decoder.decode(chunk.value, { stream: true });
      }
      const parsed = JSON.parse(text);
      attempts.push({ stage: "extraction", result: { kind: "ok", value: parsed } });
      return {
        finishReason: parsed.choices[0].finish_reason,
        rawOutput: parsed.choices[0].message.content,
        usage: { inputTokens: parsed.usage.prompt_tokens, outputTokens: parsed.usage.completion_tokens },
        observedCost: null,
      };
    },
    candidateJudge: async (input) => {
      try {
        const value = await candidateProfile.candidateJudge(input);
        attempts.push({ stage: "candidate", result: { kind: "ok", value } });
        return value;
      } catch (error) {
        attempts.push({ stage: "candidate", result: { kind: "error", code: error.code } });
        throw error;
      }
    },
  };
  return { deps, physical, requests, attempts, acquisition: base.calls };
}
