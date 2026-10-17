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
import * as tsr from "../dist/lib/lean-typesafe-judge.js";

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

/**
 * Fixture fetch capturing the wire request and returning a canned
 * response. The official judge is the caller: it owns the endpoint,
 * the pinned model, and every validation verdict under test.
 */
function makeFetch({ status = 200, answers, model = "jev-1.13.0", usage, bodyOverride, delayBody, stream } = {}) {
  const seen = [];
  const streamBody =
    stream ??
    (delayBody
      ? new ReadableStream({
          start() {
            // never enqueues; the deadline must cancel it
          },
        })
      : null);
  const fetchLike = async (url, init) => {
    seen.push({ url, init });
    let bodyText;
    if (bodyOverride !== undefined) bodyText = bodyOverride;
    else bodyText = JSON.stringify({ model, answers, usage: usage ?? { input_tokens: 100, output_tokens: 20 } });
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

/** Run the official judge over a fixture fetch; returns the response. */
async function judgeWith(fetchLike, deps = {}) {
  const profile = tsr.createTypesafeJudge({
    apiKey: "fixture-not-a-real-key",
    reserveAttempt: () => {},
    fetchLike,
    ...deps,
  });
  return profile.judge(INPUT);
}

/** Run the official judge and return its typed rejection, or undefined. */
async function rejectWith(fetchLike, deps = {}) {
  try {
    await judgeWith(fetchLike, deps);
    return undefined;
  } catch (error) {
    return error;
  }
}

describe("jev dev adapter: wire request", () => {
  it("state carries exact retained content and per-doc noul questions with safe ids", async () => {
    const body = JSON.parse(tsr.buildTypesafeNoulRequest(INPUT));
    assert.equal(body.model, tsr.TYPESAFE_PINNED_MODEL);
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
    await judgeWith(fetchLike);
    assert.equal(seen.length, 1, "exactly one HTTP attempt");
    assert.equal(seen[0].init.redirect, "error");
    assert.equal(seen[0].init.headers.authorization, "Bearer fixture-not-a-real-key");
    assert.equal(seen[0].init.method, "POST");
  });

  it("endpoint is the pinned https official route, never caller-configurable", async () => {
    const { fetchLike, seen } = makeFetch({
      answers: noulAnswers({ q0r: 1, q0s: 1, q0f: 0, q1r: 1, q1s: 0, q1f: 1 }),
    });
    await judgeWith(fetchLike);
    assert.equal(seen[0].url, tsr.TYPESAFE_SYSTEMONE_ENDPOINT);
    assert.equal(seen[0].url.startsWith("https://"), true);
    assert.equal(seen[0].url.includes("@"), false);
  });
});

describe("jev dev adapter: probability bands", () => {
  it("true/false bounds translate to the normalized boolean response", async () => {
    const { fetchLike } = makeFetch({ answers: noulAnswers({ q0r: 0.95, q0s: 0.97, q0f: 0.02, q1r: 0.93, q1s: 0.05, q1f: 0.96 }) });
    const response = await judgeWith(fetchLike);
    const metadata = response[Symbol.for("leanJevAttemptMeta")];
    assert.deepEqual(response.documents, [
      { evidenceId: "e1", relevant: true, supportsClaim: true, refutesClaim: false },
      { evidenceId: "e2", relevant: true, supportsClaim: false, refutesClaim: true },
    ]);
    assert.equal(metadata.thresholdRevision, tsr.TYPESAFE_THRESHOLD_REVISION);
    assert.equal(metadata.requestedModel, tsr.TYPESAFE_PINNED_MODEL);
    assert.equal(metadata.resolvedModel, tsr.TYPESAFE_PINNED_MODEL);
    assert.match(metadata.attemptSha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(metadata.usage, { inputTokens: 100, outputTokens: 20 });
  });

  it("middle-band probability becomes a per-source null flag, raw preserved", async () => {
    // SUPERSEDED (source-uncertainty policy): whole-attempt
    // indeterminate is replaced by COMPLETE per-source records with
    // null=unknown; the raw probability stays in metadata.
    const { fetchLike } = makeFetch({ answers: noulAnswers({ q0r: 0.5, q0s: 0.95, q0f: 0.02, q1r: 0.9, q1s: 0.05, q1f: 0.05 }) });
    const response = await judgeWith(fetchLike);
    const metadata = response[Symbol.for("leanJevAttemptMeta")];
    assert.deepEqual(response.documents, [
      { evidenceId: "e1", relevant: null, supportsClaim: true, refutesClaim: false },
      { evidenceId: "e2", relevant: true, supportsClaim: false, refutesClaim: false },
    ]);
    assert.equal(metadata.probabilities.q0r, 0.5);
    // q1r at exactly the true bound is TRUE (>=), not uncertain.
    assert.equal(metadata.probabilities.q1r, 0.9);
  });

  it("false bound is inclusive (<= falseBound)", async () => {
    const { fetchLike } = makeFetch({ answers: noulAnswers({ q0r: 0.1, q0s: 0.1, q0f: 0.1, q1r: 0.1, q1s: 0.1, q1f: 0.1 }) });
    const response = await judgeWith(fetchLike);
    assert.ok(response.documents.every((d) => !d.relevant && !d.supportsClaim && !d.refutesClaim));
  });
});

describe("jev dev adapter: response validation", () => {
  const base = { q0r: 1, q0s: 1, q0f: 0, q1r: 1, q1s: 0, q1f: 0 };

  it("missing question id is a protocol rejection", async () => {
    const partial = noulAnswers({ q0r: 1, q0s: 1, q0f: 0, q1r: 1, q1s: 0 });
    const { fetchLike } = makeFetch({ answers: partial });
    const r = await rejectWith(fetchLike);
    assert.equal(r.code, "TYPESAFE_PROTOCOL");
  });

  it("extra/unknown question id is rejected at the protocol boundary", async () => {
    const extra = noulAnswers({ ...base, q9r: 1 });
    const { fetchLike } = makeFetch({ answers: extra });
    const r = await rejectWith(fetchLike);
    assert.equal(r.code, "TYPESAFE_PROTOCOL");
  });

  it("non-noul type / non-finite / out-of-range probabilities are rejected", async () => {
    for (const answers of [
      { ...noulAnswers(base), q0r: { type: "choice", noul: 1 } },
      noulAnswers({ ...base, q0s: 2 }),
      noulAnswers({ ...base, q0f: -0.1 }),
    ]) {
      const { fetchLike } = makeFetch({ answers });
      const r = await rejectWith(fetchLike);
      assert.ok(["TYPESAFE_PROTOCOL", "TYPESAFE_MALFORMED"].includes(r.code));
    }
  });

  it("non-finite raw numeric probability is a protocol rejection", async () => {
    const { fetchLike } = makeFetch({
      bodyOverride: '{"model":"jev-1.13.0","usage":{"input_tokens":100,"output_tokens":20},"answers":{"q0r":{"type":"noul","noul":1e999},"q0s":{"type":"noul","noul":1},"q0f":{"type":"noul","noul":0},"q1r":{"type":"noul","noul":1},"q1s":{"type":"noul","noul":1},"q1f":{"type":"noul","noul":0}}}',
    });
    const r = await rejectWith(fetchLike);
    assert.equal(r.code, "TYPESAFE_PROTOCOL");
  });

  it("missing resolved model identity is rejected", async () => {
    const { fetchLike } = makeFetch({ answers: noulAnswers(base), bodyOverride: JSON.stringify({ answers: noulAnswers(base), usage: {} }) });
    const r = await rejectWith(fetchLike);
    assert.equal(r.code, "TYPESAFE_MALFORMED");
  });

  it("resolved model outside the pinned set is rejected", async () => {
    const { fetchLike } = makeFetch({ answers: noulAnswers(base), model: "unexpected-model" });
    const r = await rejectWith(fetchLike);
    assert.equal(r.code, "TYPESAFE_MODEL");
  });

  it("negative/fractional usage is malformed", async () => {
    const { fetchLike } = makeFetch({ answers: noulAnswers(base), usage: { input_tokens: -1, output_tokens: 0 } });
    const r = await rejectWith(fetchLike);
    assert.equal(r.code, "TYPESAFE_MALFORMED");
  });
});

describe("jev dev adapter: transport mapping", () => {
  const ok = noulAnswers({ q0r: 1, q0s: 1, q0f: 0, q1r: 1, q1s: 0, q1f: 0 });

  it("401 maps to an auth rejection with no body material", async () => {
    const { fetchLike } = makeFetch({ status: 401, answers: ok });
    const r = await rejectWith(fetchLike);
    assert.equal(r.code, "TYPESAFE_AUTH");
    assert.ok(!r.message.includes("fixture-not-a-real-key"));
  });

  it("non-JSON success body is rejected", async () => {
    const { fetchLike } = makeFetch({ bodyOverride: "<html>not json</html>" });
    const r = await rejectWith(fetchLike);
    assert.equal(r.code, "TYPESAFE_MALFORMED");
  });

  it("other non-2xx maps to a typed rejection with status only", async () => {
    const { fetchLike } = makeFetch({ status: 422, answers: ok });
    const r = await rejectWith(fetchLike);
    assert.deepEqual([r.code, r.observed.status], ["TYPESAFE_REQUEST", 422]);
  });

  it("fetch throw maps to a remote-uncertain rejection, no retry", async () => {
    let calls = 0;
    const fetchLike = async () => {
      calls += 1;
      throw new TypeError("connect ECONNREFUSED");
    };
    const r = await rejectWith(fetchLike);
    assert.equal(r.code, "TYPESAFE_REMOTE_UNCERTAIN");
    assert.equal(calls, 1, "no hidden retry");
  });

  it("body beyond the byte ceiling is rejected", async () => {
    const big = JSON.stringify({ model: "jev-1.13.0", answers: noulAnswers(ok), usage: { input_tokens: 1, output_tokens: 1 }, pad: "x".repeat(70_000) });
    const { fetchLike } = makeFetch({ bodyOverride: big });
    const r = await rejectWith(fetchLike, { maxResponseBytes: 1024 });
    assert.equal(r.code, "TYPESAFE_PROTOCOL");
  });

  it("timeout aborts through body consumption (stalled stream)", async () => {
    const { fetchLike } = makeFetch({ answers: ok, delayBody: true });
    // Timeout fires at 5ms; body never produces a chunk.
    const r = await rejectWith(fetchLike, { timeoutMs: 5 });
    assert.equal(r.code, "TYPESAFE_TIMEOUT");
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
    const response = await judgeWith(fetchLike, { onAttempt: (e) => attempts.push(e.outcome) });
    assert.equal(response.documents[0].supportsClaim, true);
    assert.deepEqual(attempts, ["ok"]);

    const mid = noulAnswers({ q0r: 0.5, q0s: 1, q0f: 0, q1r: 1, q1s: 0, q1f: 0 });
    const { fetchLike: fl2 } = makeFetch({ answers: mid });
    const mixed = await judgeWith(fl2);
    assert.deepEqual(mixed.documents, [
      { evidenceId: "e1", relevant: null, supportsClaim: true, refutesClaim: false },
      { evidenceId: "e2", relevant: true, supportsClaim: false, refutesClaim: false },
    ]);
  });
});
