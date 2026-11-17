/**
 * Self-contained test harness for the arbitrary-candidate path
 * (arbitrary-candidates ticket). All deps are fixtures; safe-stub
 * behaviors (always-unresolved judge) make the positive path RED until
 * real behavior lands, while negative guards are green by construction —
 * independent mutation proof must later scratch-break the guards
 * (per contract).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateCandidates,
  acceptCandidate,
  buildCandidateJudgeRequest,
  assessCandidates,
  candidateSourceDigest,
} from "../dist/lib/lean-candidates.js";

const SOURCE = {
  evidenceId: "e1",
  url: "https://fixture.invalid/guide",
  title: "Guide",
  content: "ExampleApp 2.4.0 is MIT licensed. Invoice identifier: INV-2026-041. Older docs say MIT licensed too.",
  byteLength: 0,
  origins: [],
};

const SCHEMAS = {
  invoiceId: { pattern: "^INV-[0-9]{4}-[0-9]{3}$", minLength: 8, maxLength: 20 },
  license: { pattern: "^[A-Za-z0-9.-]+$", minLength: 2, maxLength: 30 },
};

const stop = (obj) => ({ finishReason: "stop", rawOutput: JSON.stringify(obj) });

describe("candidate validation", () => {
  it("non-stop finish reasons produce zero candidates", () => {
    for (const finishReason of ["length", "refusal"]) {
      const r = validateCandidates(SOURCE, { finishReason, rawOutput: "{}" }, SCHEMAS);
      assert.equal(r.parsed, false);
      assert.ok(r.fields.every((f) => f.status === "invalid" && f.reason === `finish_reason:${finishReason}`));
    }
  });

  it("malformed JSON and non-object output are whole-response diagnostics", () => {
    for (const rawOutput of ["not json", "[1,2]", '"str"']) {
      const r = validateCandidates(SOURCE, { finishReason: "stop", rawOutput }, SCHEMAS);
      assert.equal(r.parsed, false);
    }
  });

  it("null+null is abstention, never an accepted null", () => {
    const r = validateCandidates(SOURCE, stop({ invoiceId: { value: null, quote: null }, license: { value: null, quote: null } }), SCHEMAS);
    assert.equal(r.fields[0].status, "abstained");
    const a = acceptCandidate(r.fields[0], null, SOURCE, r.sourceDigest);
    assert.equal(a.status, "unresolved");
    assert.equal(a.reason, "abstained");
  });

  it("exact quote with one occurrence binds a validated charRange", () => {
    const r = validateCandidates(SOURCE, stop({
      invoiceId: { value: "INV-2026-041", quote: "Invoice identifier: INV-2026-041" },
      license: { value: "MIT", quote: "ExampleApp 2.4.0 is MIT licensed" },
    }), SCHEMAS);
    assert.equal(r.fields[0].status, "candidate");
    const r0 = r.fields[0].charRange;
    assert.equal(SOURCE.content.slice(r0[0], r0[1]), "Invoice identifier: INV-2026-041");
    assert.equal(r.fields[1].status, "candidate");
  });

  it("hallucinated quote, value-not-in-quote and duplicate quotes reject", () => {
    const r = validateCandidates(SOURCE, stop({
      invoiceId: { value: "INV-9999-999", quote: "This text does not exist in the source." },
      license: { value: "MIT", quote: "MIT licensed" }, // occurs twice without locator → ambiguous
    }), SCHEMAS);
    assert.equal(r.fields[0].status, "invalid");
    assert.equal(r.fields[0].reason, "quote_not_in_source");
    assert.equal(r.fields[1].status, "invalid");
    assert.equal(r.fields[1].reason, "ambiguous_quote");
  });

  it("schema violations reject before binding", () => {
    const r = validateCandidates(SOURCE, stop({
      invoiceId: { value: "INV-26-1", quote: "Invoice identifier: INV-2026-041" }, // value not in quote AND pattern
      license: { value: "not a license!!", quote: "ExampleApp 2.4.0 is MIT licensed" },
    }), SCHEMAS);
    assert.ok(r.fields.every((f) => f.status === "invalid"));
  });

  it("explicit charRange locator validated exactly; wrong locator rejects", () => {
    const good = validateCandidates(SOURCE, stop({
      license: { value: "MIT", quote: "MIT licensed", charRange: [20, 32] },
    }), { license: SCHEMAS.license });
    assert.equal(good.fields[0].status, "candidate");
    assert.equal(SOURCE.content.slice(20, 32), "MIT licensed");
    const bad = validateCandidates(SOURCE, stop({
      license: { value: "MIT", quote: "MIT licensed", charRange: [0, 32] },
    }), { license: SCHEMAS.license });
    assert.equal(bad.fields[0].status, "invalid");
    assert.equal(bad.fields[0].reason, "locator_invalid");
  });

  it("digest is SHA-256 over exact UTF-8 content", () => {
    assert.match(candidateSourceDigest(SOURCE), /^[0-9a-f]{64}$/);
  });
});

describe("candidate judge request", () => {
  it("candidate identity lives in instruction text via explicit paths, full source + opposition in state", () => {
    const body = JSON.parse(buildCandidateJudgeRequest({
      source: SOURCE,
      fieldMeanings: { invoiceId: "The billing invoice identifier for release 2.4.0", license: "The license of release 2.4.0" },
      scope: { entity: "ExampleApp", release: "2.4.0" },
      candidates: [
        { fieldId: "invoiceId", value: "INV-2026-041", quote: "Invoice identifier: INV-2026-041", charRange: [46, 77] },
      ],
      opposingContext: [],
    }, "fixture-model"));
    assert.equal(body.state.source.text, SOURCE.content);
    const s = body.questions.q0s.instructions;
    assert.ok(s.includes("`fields[0].value`"));
    assert.ok(s.includes("`fields[0].quote`"));
    assert.ok(s.includes("`scope`"));
    const c = body.questions.q0c.instructions;
    assert.ok(c.includes("`fields[0].value`"));
    assert.ok(c.includes("`opposingContext`"));
    assert.ok(!s.includes(SOURCE.url));
  });
});

describe("assessment + acceptance", () => {
  const judgeInput = (candidates) => ({
    source: SOURCE,
    fieldMeanings: { license: "license" },
    scope: {},
    candidates,
    opposingContext: [],
  });

  it("strict validation: unknown/missing questions and bad usage", async () => {
    const base = { model: "m", usage: { inputTokens: 1, outputTokens: 1 }, requestSha256: "x", elapsedMs: 1 };
    const mk = (answers, usage = base.usage) => async () => ({ ...base, answers, usage });
    const cands = [{ fieldId: "license", value: "MIT", quote: "MIT licensed", charRange: [20, 32] }];
    const r1 = await assessCandidates(judgeInput(cands), { judge: mk({}) });
    assert.match(r1.error ?? "", /missing_question/);
    const r2 = await assessCandidates(judgeInput(cands), { judge: mk({ q0s: { type: "noul", noul: 1 }, q0c: { type: "noul", noul: 0 }, q9z: { type: "noul", noul: 1 } }) });
    assert.match(r2.error ?? "", /unknown_question/);
    const r3 = await assessCandidates(judgeInput(cands), { judge: mk({ q0s: { type: "noul", noul: 1 }, q0c: { type: "noul", noul: 0 } }, null) });
    assert.match(r3.error ?? "", /usage_invalid/);
  });

  it("clear support + no conflict accepts; unknown conflict blocks; middle band is null", async () => {
    const cands = [{ fieldId: "license", value: "MIT", quote: "MIT licensed", charRange: [20, 32] }];
    const mk = (s, c) => ({ judge: async () => ({ model: "m", usage: { inputTokens: 1, outputTokens: 1 }, requestSha256: "x", elapsedMs: 1, answers: { q0s: { type: "noul", noul: s }, q0c: { type: "noul", noul: c } } }) });
    const v = validateCandidates(SOURCE, stop({ license: { value: "MIT", quote: "MIT licensed", charRange: [20, 32] } }), { license: SCHEMAS.license });
    const judgedInput = judgeInput(cands);
    const ok = await assessCandidates(judgedInput, mk(0.97, 0.02));
    // Context-threaded (required-context acceptance): pass the judged context.
    const accepted = acceptCandidate(v.fields[0], ok.judgements[0], SOURCE, v.sourceDigest, judgedInput);
    assert.equal(accepted.status, "accepted");
    assert.equal(accepted.provenance.value, "MIT");
    const unknownConflict = await assessCandidates(judgeInput(cands), mk(0.97, 0.5));
    assert.equal(unknownConflict.judgements[0].conflict, null);
    const blocked = acceptCandidate(v.fields[0], unknownConflict.judgements[0], SOURCE, v.sourceDigest, judgedInput);
    assert.equal(blocked.status, "unresolved");
    assert.equal(blocked.reason, "conflict_unknown");
  });

  it("a good judgement for ANOTHER field never transfers", () => {
    // Identity-repair update: judgements now carry candidateId; a
    // hand-made foreign judgement (no valid candidateId) is rejected by
    // the identity gate (superset of the old fieldId-only check).
    const v = validateCandidates(SOURCE, stop({ license: { value: "MIT", quote: "MIT licensed", charRange: [20, 32] } }), { license: SCHEMAS.license });
    const foreign = { fieldId: "invoiceId", candidateId: "0".repeat(64), support: true, conflict: false, rawSupport: 0.97, rawConflict: 0.02 };
    const a = acceptCandidate(v.fields[0], foreign, SOURCE, v.sourceDigest);
    assert.equal(a.status, "unresolved");
    assert.match(a.reason ?? "", /judgement_(field|candidate)_mismatch/);
  });

  it("no judge dispatch leaves the candidate unresolved with provenance", () => {
    const v = validateCandidates(SOURCE, stop({ license: { value: "MIT", quote: "MIT licensed", charRange: [20, 32] } }), { license: SCHEMAS.license });
    const cands0 = [{ fieldId: "license", value: "MIT", quote: "MIT licensed", charRange: [20, 32] }];
    const a = acceptCandidate(v.fields[0], null, SOURCE, v.sourceDigest, judgeInput(cands0));
    assert.equal(a.status, "unresolved");
    assert.equal(a.reason, "not_judged");
    assert.equal(a.provenance.fieldId, "license");
  });
});
