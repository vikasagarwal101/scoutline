/**
 * Offline protocol tests for the development Jev adapter
 * (dev-jev ticket). 100% offline: fetch is a fixture; no endpoint,
 * model or credential value appears here — config is constructed inline
 * with obviously-fake values per the no-hardcoding rule.
 *
 * Covers the brief's offline checklist: wire request attribution/exact
 * retained content, true/false/indeterminate bands, missing/extra/
 * malformed probabilities, invalid resolved identity, body stream
 * bounds, non-JSON/status mapping, no redirects/retries, timeout
 * through body consumption.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  runLeanJevJudgment,
  buildLeanJevRequest,
  createLeanJevJudge,
  LEAN_JEV_THRESHOLD_REVISION,
} from "../dist/lib/lean-jev-adapter.js";

const CONFIG = {
  endpoint: "https://jev-dev.invalid/v1/systemone",
  model: "route-specific-alias",
  apiKey: "fixture-not-a-real-key",
  allowHttp: false,
};

const INPUT = {
  fieldId: "csv",
  fieldQuestion: "Does ExampleApp 2.4.0 support CSV export?",
  criteria: ["Check relevant contrary evidence before accepting a result."],
  scope: { entity: "ExampleApp", release: "2.4.0" },
  candidates: ["supported", "refuted", "disputed"],
  documents: [
    { evidenceId: "e1", url: "https://docs.example/guide", title: "Guide", content: "ExampleApp 2.4.0 supports CSV export from the reports screen." },
    { evidenceId: "e2", url: "https://docs.example/limits", title: "Limits", content: "ExampleApp 2.4.0 does not support CSV export." },
  ],
};

// q<index><r|s|f> — deterministic safe IDs, never evidenceIds as keys.
const IDS = ["q0r", "q0s", "q0f", "q1r", "q1s", "q1f"];

function noulAnswers(map) {
  const answers = {};
  for (const [id, p] of Object.entries(map)) answers[id] = { type: "noul", noul: p };
  return answers;
}

/** Fixture fetch capturing the wire request and returning a canned response. */
function makeFetch({ status = 200, answers, model = "resolved-alias", usage, cost = 0, bodyOverride, delayBody, stream } = {}) {
  const seen = [];
  const streamBody =
    stream ??
    (delayBody
      ? // A body stream whose first read hangs until aborted (timeout path).
        new ReadableStream({
          start(controller) {
            // never enqueues; the abort must cancel it
          },
        })
      : null);
  const fetchLike = async (url, init) => {
    seen.push({ url, init });
    let bodyText;
    if (bodyOverride !== undefined) bodyText = bodyOverride;
    else bodyText = JSON.stringify({ model, answers, usage: usage ?? { input_tokens: 100, output_tokens: 20 }, cost });
    const body =
      streamBody ??
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(bodyText));
          controller.close();
        },
      });
    return { status, ok: status >= 200 && status < 300, headers: { get: () => "application/json" }, body };
  };
  return { fetchLike, seen };
}

describe("jev dev adapter: wire request", () => {
  it("state carries exact retained content and per-doc noul questions with safe ids", async () => {
    const body = JSON.parse(buildLeanJevRequest(INPUT, CONFIG.model));
    assert.equal(body.model, CONFIG.model);
    assert.deepEqual(Object.keys(body.state), ["requirement", "scope", "criteria", "candidates", "depBindings", "sources"]);
    assert.equal(body.state.sources[0].text, INPUT.documents[0].content, "retained text verbatim");
    assert.equal(body.state.sources[1].url, INPUT.documents[1].url);
    assert.deepEqual(Object.keys(body.questions).sort(), [...IDS].sort());
    for (const q of Object.values(body.questions)) assert.equal(q.type, "noul");
    // No evidenceId used as a question key.
    for (const key of Object.keys(body.questions)) assert.match(key, /^q\d[rsf]$/);
  });

  it("bearer header from config; redirect: error; single attempt", async () => {
    const { fetchLike, seen } = makeFetch({ answers: noulAnswers({ q0r: 1, q0s: 1, q0f: 0, q1r: 1, q1s: 0, q1f: 1 }) });
    await runLeanJevJudgment(INPUT, CONFIG, fetchLike, () => 0);
    assert.equal(seen.length, 1, "exactly one HTTP attempt");
    assert.equal(seen[0].init.redirect, "error");
    assert.equal(seen[0].init.headers.authorization, "Bearer fixture-not-a-real-key");
    assert.equal(seen[0].init.method, "POST");
  });

  it("endpoint scheme validation rejects http without opt-in, userinfo always", async () => {
    const { fetchLike } = makeFetch({ answers: noulAnswers({}) });
    await assert.rejects(
      () => runLeanJevJudgment(INPUT, { ...CONFIG, endpoint: "http://127.0.0.1:1/x" }, fetchLike),
      /https/,
    );
    await assert.rejects(
      () => runLeanJevJudgment(INPUT, { ...CONFIG, endpoint: "https://u:p@h.invalid/x" }, fetchLike),
      /userinfo/,
    );
  });
});

describe("jev dev adapter: probability bands", () => {
  it("true/false bounds translate to the normalized boolean response", async () => {
    const { fetchLike } = makeFetch({ answers: noulAnswers({ q0r: 0.95, q0s: 0.97, q0f: 0.02, q1r: 0.93, q1s: 0.05, q1f: 0.96 }) });
    const result = await runLeanJevJudgment(INPUT, CONFIG, fetchLike, () => 0);
    assert.equal(result.kind, "ok");
    assert.deepEqual(result.response.documents, [
      { evidenceId: "e1", relevant: true, supportsClaim: true, refutesClaim: false },
      { evidenceId: "e2", relevant: true, supportsClaim: false, refutesClaim: true },
    ]);
    assert.equal(result.metadata.thresholdRevision, LEAN_JEV_THRESHOLD_REVISION);
    assert.equal(result.metadata.requestedModel, CONFIG.model);
    assert.equal(result.metadata.resolvedModel, "resolved-alias");
    assert.match(result.metadata.attemptSha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(result.metadata.usage, { inputTokens: 100, outputTokens: 20 });
  });

  it("middle-band probability becomes a per-source null flag, raw preserved", async () => {
    // SUPERSEDED (source-uncertainty policy): whole-attempt
    // indeterminate is replaced by COMPLETE per-source records with
    // null=unknown; the raw probability stays in metadata.
    const { fetchLike } = makeFetch({ answers: noulAnswers({ q0r: 0.5, q0s: 0.95, q0f: 0.02, q1r: 0.9, q1s: 0.05, q1f: 0.05 }) });
    const result = await runLeanJevJudgment(INPUT, CONFIG, fetchLike, () => 0);
    assert.equal(result.kind, "ok");
    assert.deepEqual(result.response.documents, [
      { evidenceId: "e1", relevant: null, supportsClaim: true, refutesClaim: false },
      { evidenceId: "e2", relevant: true, supportsClaim: false, refutesClaim: false },
    ]);
    assert.equal(result.metadata.probabilities.q0r, 0.5);
    // q1r at exactly the true bound is TRUE (>=), not uncertain.
    assert.equal(result.metadata.probabilities.q1r, 0.9);
  });

  it("false bound is inclusive (<= falseBound)", async () => {
    const { fetchLike } = makeFetch({ answers: noulAnswers({ q0r: 0.1, q0s: 0.1, q0f: 0.1, q1r: 0.1, q1s: 0.1, q1f: 0.1 }) });
    const result = await runLeanJevJudgment(INPUT, CONFIG, fetchLike, () => 0);
    assert.equal(result.kind, "ok");
    assert.ok(result.response.documents.every((d) => !d.relevant && !d.supportsClaim && !d.refutesClaim));
  });
});

describe("jev dev adapter: response validation", () => {
  const base = { q0r: 1, q0s: 1, q0f: 0, q1r: 1, q1s: 0, q1f: 0 };

  it("missing question id is JEV_DEV_PROTOCOL", async () => {
    const partial = noulAnswers({ q0r: 1, q0s: 1, q0f: 0, q1r: 1, q1s: 0 });
    const { fetchLike } = makeFetch({ answers: partial });
    const r = await runLeanJevJudgment(INPUT, CONFIG, fetchLike);
    assert.deepEqual([r.kind, r.code], ["error", "JEV_DEV_PROTOCOL"]);
  });

  it("extra/unknown question id is JEV_DEV_PROTOCOL", async () => {
    const extra = noulAnswers({ ...base, q9r: 1 });
    const { fetchLike } = makeFetch({ answers: extra });
    const r = await runLeanJevJudgment(INPUT, CONFIG, fetchLike);
    assert.equal(r.code, "JEV_DEV_PROTOCOL");
  });

  it("non-noul type / non-finite / out-of-range probabilities are rejected", async () => {
    for (const answers of [
      { ...noulAnswers(base), q0r: { type: "choice", noul: 1 } },
      noulAnswers({ ...base, q0s: 2 }),
      noulAnswers({ ...base, q0f: -0.1 }),
    ]) {
      const { fetchLike } = makeFetch({ answers });
      const r = await runLeanJevJudgment(INPUT, CONFIG, fetchLike);
      assert.equal(r.kind, "error");
      assert.ok(["JEV_DEV_PROTOCOL", "JEV_DEV_MALFORMED"].includes(r.code));
    }
  });

  it("missing resolved model identity is JEV_DEV_MALFORMED", async () => {
    const { fetchLike } = makeFetch({ answers: noulAnswers(base), bodyOverride: JSON.stringify({ answers: noulAnswers(base), usage: {} }) });
    const r = await runLeanJevJudgment(INPUT, CONFIG, fetchLike);
    assert.equal(r.code, "JEV_DEV_MALFORMED");
  });

  it("resolved model outside allowed set is JEV_DEV_MODEL", async () => {
    const { fetchLike } = makeFetch({ answers: noulAnswers(base), model: "unexpected-model" });
    const r = await runLeanJevJudgment(INPUT, { ...CONFIG, allowedModels: ["resolved-alias"] }, fetchLike);
    assert.equal(r.code, "JEV_DEV_MODEL");
  });

  it("negative/fractional usage is malformed", async () => {
    const { fetchLike } = makeFetch({ answers: noulAnswers(base), usage: { input_tokens: -1, output_tokens: 0 } });
    const r = await runLeanJevJudgment(INPUT, CONFIG, fetchLike);
    assert.equal(r.code, "JEV_DEV_MALFORMED");
  });
});

describe("jev dev adapter: transport mapping", () => {
  const ok = noulAnswers({ q0r: 1, q0s: 1, q0f: 0, q1r: 1, q1s: 0, q1f: 0 });

  it("401 maps to JEV_DEV_AUTH with no body material", async () => {
    const { fetchLike } = makeFetch({ status: 401, answers: ok });
    const r = await runLeanJevJudgment(INPUT, CONFIG, fetchLike);
    assert.deepEqual([r.kind, r.code], ["error", "JEV_DEV_AUTH"]);
    assert.ok(!r.message.includes("fixture-not-a-real-key"));
  });

  it("non-JSON success body is JEV_DEV_MALFORMED", async () => {
    const { fetchLike } = makeFetch({ bodyOverride: "<html>not json</html>" });
    const r = await runLeanJevJudgment(INPUT, CONFIG, fetchLike);
    assert.equal(r.code, "JEV_DEV_MALFORMED");
  });

  it("other non-2xx maps to JEV_DEV_PROTOCOL with status only", async () => {
    const { fetchLike } = makeFetch({ status: 422, answers: ok });
    const r = await runLeanJevJudgment(INPUT, CONFIG, fetchLike);
    assert.deepEqual([r.code, r.message], ["JEV_DEV_PROTOCOL", "Jev dev endpoint returned status 422."]);
  });

  it("fetch throw maps to JEV_DEV_NETWORK, no retry", async () => {
    let calls = 0;
    const fetchLike = async () => {
      calls += 1;
      throw new TypeError("connect ECONNREFUSED");
    };
    const r = await runLeanJevJudgment(INPUT, CONFIG, fetchLike);
    assert.deepEqual([r.kind, r.code], ["error", "JEV_DEV_NETWORK"]);
    assert.equal(calls, 1, "no hidden retry");
  });

  it("body beyond the byte ceiling is rejected as protocol", async () => {
    const big = JSON.stringify({ model: "m", answers: noulAnswers(ok), usage: {}, cost: 0, pad: "x".repeat(70_000) });
    const { fetchLike } = makeFetch({ bodyOverride: big });
    const r = await runLeanJevJudgment(INPUT, { ...CONFIG, maxResponseBytes: 1024 }, fetchLike);
    assert.equal(r.code, "JEV_DEV_PROTOCOL");
  });

  it("timeout aborts through body consumption (stalled stream)", async () => {
    const { fetchLike } = makeFetch({ answers: ok, delayBody: true });
    // Timeout fires at 5ms; body never produces a chunk.
    const r = await runLeanJevJudgment(INPUT, { ...CONFIG, timeoutMs: 5 }, fetchLike);
    assert.equal(r.code, "JEV_DEV_TIMEOUT");
  });
});

describe("jev dev adapter: engine wrapper", () => {
  const ok = noulAnswers({ q0r: 1, q0s: 1, q0f: 0, q1r: 1, q1s: 0, q1f: 0 });

  it("ok attempts pass through; mixed bands return full boolean|null records", async () => {
    // SUPERSEDED (source-uncertainty policy): the wrapper no longer
    // throws JEV_DEV_INDETERMINATE for mixed bands — it returns complete
    // per-source records with null=unknown; known flags retain values.
    const { fetchLike } = makeFetch({ answers: ok });
    const attempts = [];
    const judge = createLeanJevJudge(CONFIG, fetchLike, { onAttempt: (r) => attempts.push(r.kind) });
    const response = await judge(INPUT);
    assert.equal(response.documents[0].supportsClaim, true);
    assert.deepEqual(attempts, ["ok"]);

    const mid = noulAnswers({ q0r: 0.5, q0s: 1, q0f: 0, q1r: 1, q1s: 0, q1f: 0 });
    const { fetchLike: fl2 } = makeFetch({ answers: mid });
    const judge2 = createLeanJevJudge(CONFIG, fl2);
    const mixed = await judge2(INPUT);
    assert.deepEqual(mixed.documents, [
      { evidenceId: "e1", relevant: null, supportsClaim: true, refutesClaim: false },
      { evidenceId: "e2", relevant: true, supportsClaim: false, refutesClaim: false },
    ]);
  });
});
