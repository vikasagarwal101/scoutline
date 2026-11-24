/**
 * Offline tests for per-profile judge threshold bands (#307 proof of
 * concept). 100% offline: fetch is a fixture; no endpoint, model or
 * credential value appears here — config is constructed inline with
 * obviously-fake values per the no-hardcoding rule.
 *
 * What this pins:
 *   - the band registry is the only source of the bounds;
 *   - every pinned profile is on the trial band until a calibrated band
 *     is listed for it;
 *   - the adapter reads answers under the descriptor's band on BOTH the
 *     classification and the candidate path, and reports which band it used;
 *   - a judgement records its band and is re-checked under that band;
 *   - the judgment identity changes when the band changes, numbers included.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as band from "../dist/lib/judge-threshold-band.js";
import * as jc from "../dist/lib/judge-config.js";
import * as tsr from "../dist/lib/lean-typesafe-judge.js";
import { assessCandidates, acceptCandidate, validateCandidates } from "../dist/lib/lean-candidates.js";
import { callerJudgeIdentity } from "../dist/commands/investigate-caller.js";

const TRIAL = band.JUDGE_TRIAL_THRESHOLD_BAND;
const FIXTURE = band.JUDGE_FIXTURE_THRESHOLD_BAND;
const MODEL = "liquid/d1.2";

/** A descriptor for MODEL read under `threshold` (must be a registered band). */
const descriptorUnder = (threshold) =>
  Object.freeze({ ...jc.judgeDescriptor("openrouter", MODEL), threshold, thresholdRevision: threshold.revision });

// ---------------------------------------------------------------------------
// Fixtures: classification
// ---------------------------------------------------------------------------

const INPUT = {
  fieldId: "csv",
  fieldQuestion: "Does ExampleApp 2.4.0 support CSV export?",
  criteria: ["Check relevant contrary evidence before accepting a result."],
  scope: { entity: "ExampleApp", release: "2.4.0" },
  candidates: ["supported", "refuted", "disputed"],
  documents: [
    { evidenceId: "e1", url: "https://docs.example/guide", title: "Guide", content: "ExampleApp 2.4.0 supports CSV export from the reports screen." },
  ],
};

function noulAnswers(map) {
  const answers = {};
  for (const [id, p] of Object.entries(map)) answers[id] = { type: "noul", noul: p };
  return answers;
}

function fetchReturning(model, answers) {
  return async () => ({
    status: 200,
    ok: true,
    headers: { get: () => "application/json" },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(JSON.stringify({ model, answers, usage: { input_tokens: 100, output_tokens: 20 } })),
        );
        controller.close();
      },
    }),
  });
}

function profileUnder(descriptor, answers) {
  return tsr.createNativeJudgeForDescriptor(
    {
      apiKey: "fixture-not-a-real-key",
      reserveAttempt: () => {},
      fetchLike: fetchReturning(descriptor.expectedResolvedModel, answers),
    },
    descriptor,
  );
}

// ---------------------------------------------------------------------------
// Fixtures: candidates (same shape as the independent candidate suite)
// ---------------------------------------------------------------------------

const CONTENT = "Invoice identifier: INV-73. License: Apache-2.0.";
const source = () => ({
  evidenceId: "source-one",
  url: "https://fixture.invalid/doc",
  title: "Guide",
  content: CONTENT,
  byteLength: Buffer.byteLength(CONTENT),
  origins: [],
});
const schemas = { invoiceId: { minLength: 1, maxLength: 64 } };
const raw = {
  finishReason: "stop",
  rawOutput: JSON.stringify({ invoiceId: { value: "INV-73", quote: "Invoice identifier: INV-73" } }),
};
const validated = () => validateCandidates(source(), raw, schemas);
const judgeInput = () => ({
  source: source(),
  fieldMeanings: { invoiceId: "Exact printed invoice identifier" },
  scope: { entity: "ExampleApp", release: "2.4.0" },
  candidates: validated().fields
    .filter((row) => row.status === "candidate")
    .map(({ fieldId, value, quote, charRange }) => ({ fieldId, value, quote, charRange })),
  opposingContext: [],
});
const native = (support, conflict = 0.01) => ({
  model: "fixture-resolved",
  answers: { q0s: { type: "noul", noul: support }, q0c: { type: "noul", noul: conflict } },
  usage: { inputTokens: 1, outputTokens: 1 },
  requestSha256: "a".repeat(64),
  elapsedMs: 1,
});

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

describe("judge threshold band: registry", () => {
  it("resolves the trial band by revision and nothing else that is not registered", () => {
    assert.equal(band.judgeThresholdBandByRevision("trial-v1-p9-p1"), TRIAL);
    assert.equal(band.judgeThresholdBandByRevision("not-registered"), undefined);
    assert.equal(band.judgeThresholdBandByRevision(undefined), undefined);
    assert.equal(band.judgeThresholdBandByRevision(0.9), undefined);
    assert.equal(band.judgeThresholdBandByRevision({ revision: "trial-v1-p9-p1" }), undefined);
  });

  it("accepts a band only when revision AND bounds match a registered band", () => {
    assert.equal(band.isRegisteredThresholdBand(TRIAL), true);
    assert.equal(band.isRegisteredThresholdBand(FIXTURE), true);
    // Same revision, different numbers: not a registered band.
    assert.equal(band.isRegisteredThresholdBand({ ...TRIAL, trueBound: 0.85 }), false);
    // Registered numbers under another revision's name: not a registered band.
    assert.equal(band.isRegisteredThresholdBand({ ...FIXTURE, revision: TRIAL.revision }), false);
    assert.equal(band.isRegisteredThresholdBand(undefined), false);
    assert.equal(band.isRegisteredThresholdBand(null), false);
  });

  it("translates with inclusive bounds and keeps the middle band unknown", () => {
    assert.deepEqual(
      [0.2, 0.21, 0.79, 0.8].map((p) => band.translateNoul(p, FIXTURE)),
      [false, null, null, true],
    );
    assert.deepEqual(
      [0.1, 0.11, 0.89, 0.9].map((p) => band.translateNoul(p, TRIAL)),
      [false, null, null, true],
    );
  });
});

// ---------------------------------------------------------------------------
// Descriptor: band selected by pinned profile
// ---------------------------------------------------------------------------

describe("judge threshold band: descriptor", () => {
  it("puts every pinned profile on the trial band until a calibrated band is listed", () => {
    const seen = [];
    for (const route of ["openrouter", "typesafe"]) {
      for (const model of jc.JUDGE_ROUTE_MODELS[route]) {
        const descriptor = jc.judgeDescriptor(route, model);
        assert.deepEqual(descriptor.threshold, TRIAL, `${route} ${model}`);
        assert.equal(descriptor.thresholdRevision, TRIAL.revision, `${route} ${model}`);
        assert.equal(descriptor.threshold.calibrated, false, `${route} ${model}`);
        assert.equal(jc.judgeThresholdBandFor(route, model), TRIAL, `${route} ${model}`);
        seen.push(`${route}:${model}`);
      }
    }
    // 17 OpenRouter profiles and 2 direct TypeSafe ones.
    assert.equal(seen.length, 19);
  });

  it("the literal trial revision is no longer repeated outside the band module", () => {
    assert.equal(tsr.TYPESAFE_THRESHOLD_REVISION, TRIAL.revision);
    assert.equal(jc.judgeDescriptor("openrouter").thresholdRevision, TRIAL.revision);
  });
});

// ---------------------------------------------------------------------------
// Adapter: both paths read answers under the descriptor's band
// ---------------------------------------------------------------------------

describe("judge threshold band: adapter", () => {
  // 0.85 and 0.15 are inside the trial middle band and outside the fixture's.
  const answers = noulAnswers({ q0r: 0.95, q0s: 0.85, q0f: 0.15 });

  it("classification: the same raw answers translate differently under each band", async () => {
    const onTrial = await profileUnder(descriptorUnder(TRIAL), answers).judge(INPUT);
    const onFixture = await profileUnder(descriptorUnder(FIXTURE), answers).judge(INPUT);
    assert.deepEqual(onTrial.documents[0], { evidenceId: "e1", relevant: true, supportsClaim: null, refutesClaim: null });
    assert.deepEqual(onFixture.documents[0], { evidenceId: "e1", relevant: true, supportsClaim: true, refutesClaim: false });
    // The raw answers are identical: only the band differs.
    const metaOf = (response) => response[Symbol.for("leanJevAttemptMeta")];
    assert.deepEqual(metaOf(onTrial).probabilities, metaOf(onFixture).probabilities);
    assert.equal(metaOf(onTrial).probabilities.q0s, 0.85);
  });

  it("classification: attempt metadata reports the band that was applied", async () => {
    const metaOf = (response) => response[Symbol.for("leanJevAttemptMeta")];
    const onTrial = await profileUnder(descriptorUnder(TRIAL), answers).judge(INPUT);
    const onFixture = await profileUnder(descriptorUnder(FIXTURE), answers).judge(INPUT);
    assert.equal(metaOf(onTrial).thresholdRevision, TRIAL.revision);
    assert.equal(metaOf(onFixture).thresholdRevision, FIXTURE.revision);
    assert.equal(metaOf(onFixture).requestedModel, MODEL);
  });

  it("candidate: the adapter returns raw answers and names the band it applied", async () => {
    const raw = { q0s: { type: "noul", noul: 0.85 }, q0c: { type: "noul", noul: 0.01 } };
    const onTrial = await profileUnder(descriptorUnder(TRIAL), raw).candidateJudge(judgeInput());
    const onFixture = await profileUnder(descriptorUnder(FIXTURE), raw).candidateJudge(judgeInput());
    // Raw values are not translated here; the candidate path translates.
    assert.deepEqual(onTrial.answers, raw);
    assert.deepEqual(onFixture.answers, raw);
    assert.equal(onTrial.thresholdRevision, TRIAL.revision);
    assert.equal(onFixture.thresholdRevision, FIXTURE.revision);
  });

  it("a descriptor whose band is not registered is refused before any attempt", () => {
    const drifted = descriptorUnder({ ...TRIAL, trueBound: 0.85 });
    let attempts = 0;
    assert.throws(
      () =>
        tsr.createNativeJudgeForDescriptor(
          { apiKey: "fixture-not-a-real-key", reserveAttempt: () => { attempts += 1; }, fetchLike: fetchReturning(drifted.expectedResolvedModel, {}) },
          drifted,
        ),
      /registered threshold band/,
    );
    assert.equal(attempts, 0);
  });
});

// ---------------------------------------------------------------------------
// Candidate path: translation and re-check under the recorded band
// ---------------------------------------------------------------------------

describe("judge threshold band: candidate path", () => {
  const accept = (judgement) => acceptCandidate(validated().fields[0], judgement, source(), validated().sourceDigest, judgeInput());

  it("translates under the band the judge names and records it on the judgement", async () => {
    const named = await assessCandidates(judgeInput(), {
      judge: async () => ({ ...native(0.85), thresholdRevision: FIXTURE.revision }),
    });
    assert.equal(named.judgements.length, 1);
    assert.equal(named.judgements[0].support, true);
    assert.equal(named.judgements[0].rawSupport, 0.85);
    assert.equal(named.judgements[0].thresholdRevision, FIXTURE.revision);
    // End to end: the same raw value accepts under the fixture band.
    assert.equal(accept(named.judgements[0]).status, "accepted");
  });

  it("a judge that names no band is read under the trial band", async () => {
    const unnamed = await assessCandidates(judgeInput(), { judge: async () => native(0.85) });
    assert.equal(unnamed.judgements[0].support, null);
    assert.equal(unnamed.judgements[0].thresholdRevision, TRIAL.revision);
    const outcome = accept(unnamed.judgements[0]);
    assert.equal(outcome.status, "unresolved");
    assert.equal(outcome.reason, "support_unknown");
  });

  it("an unknown band name is a typed rejection, never a silent fallback", async () => {
    for (const thresholdRevision of ["not-registered", 0.9, null, ""]) {
      const assessed = await assessCandidates(judgeInput(), { judge: async () => ({ ...native(0.97), thresholdRevision }) });
      assert.deepEqual(assessed, { judgements: [], error: "JEV_DEV_PROTOCOL:unknown_threshold_revision" }, String(thresholdRevision));
    }
  });

  it("re-checks raw values under the band the judgement records", async () => {
    const named = (await assessCandidates(judgeInput(), {
      judge: async () => ({ ...native(0.85), thresholdRevision: FIXTURE.revision }),
    })).judgements[0];
    // Without its band the record reads under the trial band: 0.85 is not support.
    const stripped = accept({ ...named, thresholdRevision: undefined });
    assert.equal(stripped.status, "unresolved");
    assert.equal(stripped.reason, "normalized_raw_inconsistency");
    // An unknown band never accepts.
    const unknown = accept({ ...named, thresholdRevision: "not-registered" });
    assert.equal(unknown.status, "unresolved");
    assert.equal(unknown.reason, "judgement_threshold_unknown");
  });

  it("a fabricated flag against a low raw value never accepts, under any band", async () => {
    const named = (await assessCandidates(judgeInput(), {
      judge: async () => ({ ...native(0.85), thresholdRevision: FIXTURE.revision }),
    })).judgements[0];
    assert.equal(accept({ ...named, rawSupport: 0.5 }).reason, "normalized_raw_inconsistency");
    assert.equal(accept({ ...named, support: null }).reason, "normalized_raw_inconsistency");
    assert.equal(accept({ ...named, conflict: true }).reason, "normalized_raw_inconsistency");
  });
});

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

describe("judge threshold band: judgment identity", () => {
  it("is stable for the same descriptor and changes with the band", () => {
    const onTrial = callerJudgeIdentity(descriptorUnder(TRIAL), false);
    assert.equal(callerJudgeIdentity(jc.judgeDescriptor("openrouter", MODEL), false).judgeIdentity, onTrial.judgeIdentity);
    const onFixture = callerJudgeIdentity(descriptorUnder(FIXTURE), false);
    assert.notEqual(onFixture.judgeIdentity, onTrial.judgeIdentity);
    assert.notEqual(onFixture.policyRevision, onTrial.policyRevision);
  });

  it("changes when the bounds change, even under an unchanged revision", () => {
    const onTrial = callerJudgeIdentity(descriptorUnder(TRIAL), false);
    const drifted = callerJudgeIdentity(descriptorUnder({ ...TRIAL, trueBound: 0.85 }), false);
    assert.notEqual(drifted.judgeIdentity, onTrial.judgeIdentity);
    assert.notEqual(drifted.policyRevision, onTrial.policyRevision);
  });
});
