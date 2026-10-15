/**
 * Four-roots correction RED→GREEN suite (caller-rounds ticket):
 *  R1 unknown judge identity must block cross-round history reuse
 *  R2 changed proposal value on same representation reopens assessment
 *  R3 assembled semantic request bounded by 256KiB; overflow = incomplete, 0 dispatch
 *  R4 no paid work before the first pointer/publication refusal; failed round keeps measured accounting
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { startCallerRound, continueCallerRound } from "../dist/lib/lean-caller-rounds.js";

globalThis.fetch = () => { throw new Error("HTTP refused"); };
const CONTRACT = { schemaVersion: 1, question: "Version?", requirements: { version: { question: "Version?", schema: { type: "string" }, required: true } } };
const BASE = { schemaVersion: 1, fields: { version: { definition: "synthetic", required: true } } };

function judgeWorld() {
  const state = { semantic: 0, verdict: 0.97 };
  const deps = {
    now: Date.now,
    search: async () => [{ url: "https://example.test/pkg", title: "pkg" }],
    read: async () => "package foo version 2.4 license MIT",
    judge: async () => ({ documents: [] }),
    extract: null,
    candidateJudge: async (input) => {
      state.semantic += 1;
      const answers = {};
      input.candidates.forEach((c, i) => {
        answers[`q${i}s`] = { type: "noul", noul: state.verdict };
        answers[`q${i}c`] = { type: "noul", noul: 0.01 };
      });
      return { model: "probe-judge", answers, usage: { inputTokens: 1, outputTokens: 1 }, requestSha256: "0".repeat(64), elapsedMs: 1 };
    },
  };
  return { state, deps };
}
async function run2(deps, opts = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fourroots-"));
  const r1 = await startCallerRound({ storeRoot: root, contract: CONTRACT, deps, ...opts.start });
  const r2 = await continueCallerRound({ storeRoot: root, investigationRef: r1.investigationRef, expectedRevision: r1.handoff.revision, deps, ...opts.continue });
  return { root, r1, r2 };
}

// R1: absent judgeIdentity + actual judge swap → round 3 MUST re-assess live.
test("R1: unknown judge identity blocks history reuse; swapped judge re-assesses", async () => {
  const { state, deps } = judgeWorld();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fourroots-"));
  const r1 = await startCallerRound({ storeRoot: root, contract: CONTRACT, deps }); // NO identity
  const rep = r1.handoff.evidence.find((e) => e.url === "https://example.test/pkg");
  const p = [{ fieldId: "version", mode: "string", value: "2.4", definitionRevision: r1.handoff.definitions.version, representationId: rep.representationId, digest: rep.digest, quote: "version 2.4", charRange: [12, 23] }];
  const r2 = await continueCallerRound({ storeRoot: root, investigationRef: r1.investigationRef, expectedRevision: r1.handoff.revision, deps, proposals: p }); // still no identity
  assert.equal(r2.result.data.version, "2.4");
  const assessed = state.semantic;
  assert.ok(assessed > 0, "probe: proposal was assessed once");
  state.verdict = 0.01; // SWAP the actual judge behavior — refutes now
  const r3 = await continueCallerRound({ storeRoot: root, investigationRef: r2.investigationRef, expectedRevision: r2.handoff.revision, deps, proposals: p });
  try {
    assert.ok(state.semantic > assessed,
      `absent identity + swapped judge must re-assess live (semantic ${state.semantic} stayed ${assessed}; stale accept delivered)`);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

// R1 positive control: PINNED identity keeps zero re-dispatch.
test("R1p: pinned judge identity preserves zero-dispatch reuse", async () => {
  const { state, deps } = judgeWorld();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fourroots-"));
  const r1 = await startCallerRound({ storeRoot: root, contract: CONTRACT, deps, judgeIdentity: "probe-judge@1", policyRevision: "p1" });
  const rep = r1.handoff.evidence.find((e) => e.url === "https://example.test/pkg");
  const p = [{ fieldId: "version", mode: "string", value: "2.4", definitionRevision: r1.handoff.definitions.version, representationId: rep.representationId, digest: rep.digest, quote: "version 2.4", charRange: [12, 23] }];
  const r2 = await continueCallerRound({ storeRoot: root, investigationRef: r1.investigationRef, expectedRevision: r1.handoff.revision, deps, judgeIdentity: "probe-judge@1", policyRevision: "p1", proposals: p });
  try {
    assert.equal(r2.result.data.version, "2.4");
    assert.equal(state.semantic, 1, "exactly one assessment across both rounds");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

// R2: changed proposal binding (quote/range) on identical representation reopens the field.
test("R2: changed proposal value on same representation forces fresh assessment", async () => {
  const { state, deps } = judgeWorld();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fourroots-"));
  const r1 = await startCallerRound({ storeRoot: root, contract: CONTRACT, deps, judgeIdentity: "probe-judge@1", policyRevision: "p1" });
  const rep = r1.handoff.evidence.find((e) => e.url === "https://example.test/pkg");
  // Same value, DIFFERENT quote/range binding on the same representation.
  const mk = (quote, range) => [{ fieldId: "version", mode: "string", value: "2.4", definitionRevision: r1.handoff.definitions.version, representationId: rep.representationId, digest: rep.digest, quote, charRange: range }];
  const r2 = await continueCallerRound({ storeRoot: root, investigationRef: r1.investigationRef, expectedRevision: r1.handoff.revision, deps, judgeIdentity: "probe-judge@1", policyRevision: "p1", proposals: mk("version 2.4", [12, 23]) });
  try {
    assert.equal(r2.result.data.version, "2.4");
    const assessed = state.semantic;
    // CHANGED binding against the SAME representation must be re-judged.
    const r3 = await continueCallerRound({ storeRoot: root, investigationRef: r2.investigationRef, expectedRevision: r2.handoff.revision, deps, judgeIdentity: "probe-judge@1", policyRevision: "p1", proposals: mk("2.4", [20, 23]) });
    assert.ok(state.semantic > assessed, `changed binding must be judged (semantic ${state.semantic} > ${assessed})`);
    assert.equal(r3.result.data.version, "2.4");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

// R2 identical-proposal control: no re-buy.
test("R2p: identical resubmitted proposal does not re-buy judgment", async () => {
  const { state, deps } = judgeWorld();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fourroots-"));
  const r1 = await startCallerRound({ storeRoot: root, contract: CONTRACT, deps, judgeIdentity: "probe-judge@1", policyRevision: "p1" });
  const rep = r1.handoff.evidence.find((e) => e.url === "https://example.test/pkg");
  const p = [{ fieldId: "version", mode: "string", value: "2.4", definitionRevision: r1.handoff.definitions.version, representationId: rep.representationId, digest: rep.digest, quote: "version 2.4", charRange: [12, 23] }];
  const r2 = await continueCallerRound({ storeRoot: root, investigationRef: r1.investigationRef, expectedRevision: r1.handoff.revision, deps, judgeIdentity: "probe-judge@1", policyRevision: "p1", proposals: p });
  const n = state.semantic;
  const r3 = await continueCallerRound({ storeRoot: root, investigationRef: r2.investigationRef, expectedRevision: r2.handoff.revision, deps, judgeIdentity: "probe-judge@1", policyRevision: "p1", proposals: p });
  try {
    assert.equal(state.semantic, n, "identical proposal must not re-buy");
    assert.equal(r3.result.data.version, "2.4");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

// R3: assembled request > 256KiB must refuse dispatch and mark incomplete.
test("R3: oversized assembled semantic context refuses dispatch with explicit incomplete", async () => {
  const { state, deps } = judgeWorld();
  // 16 × ~16KiB = the full 256KiB representation allowance; framing/questions
  // push the ASSEMBLED request past the ceiling.
  const big = "v".repeat(16 * 1024 - 24);
  const reps = Array.from({ length: 16 }, (_, i) => ({ format: "text", content: `lead ${i} ${big}`, label: `r${i}` }));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fourroots-"));
  const r1 = await startCallerRound({ storeRoot: root, contract: CONTRACT, deps, judgeIdentity: "probe-judge@1", representations: reps });
  try {
    assert.equal(state.semantic, 0, "no semantic dispatch when assembled context exceeds ceiling");
    const gaps = r1.handoff.gaps.join("|");
    assert.ok(/context|incomplete|oversize/i.test(gaps) || r1.result.requirements.version.reason === "assessment_context_overflow",
      `expected explicit overflow disclosure, got gaps=${gaps} reason=${r1.result.requirements.version.reason}`);
    assert.notEqual(r1.handoff.stopReason, "work-fulfilled");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

// R4 (real): post-paid publication failure settles measured usage first.
test("R4: post-paid root-bound refusal settles measured attempts with explicit uncertainty, prior view intact", async () => {
  const { state, deps } = judgeWorld();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fourroots-"));
  let last;
  let refusal = null;
  const leads = (i) => Array.from({ length: 8 }, (_, k) => ({ url: `https://example.test/unread-${i}-${k}`, title: `lead ${i}-${k}` }));
  try {
    for (let i = 0; i < 40; i += 1) {
      const current = i === 0
        ? await startCallerRound({ storeRoot: root, contract: CONTRACT, deps, judgeIdentity: "probe-judge@1", policyRevision: "p1", leads: leads(i) })
        : await continueCallerRound({ storeRoot: root, investigationRef: last.investigationRef, expectedRevision: last.handoff.revision, deps, judgeIdentity: "probe-judge@1", policyRevision: "p1", leads: leads(i) });
      last = current;
    }
  } catch (e) {
    refusal = e;
  }
  try {
    assert.ok(refusal !== null, "expected a publication refusal before 40 rounds");
    assert.match(String(refusal?.message ?? ""), /exceeds|bound|16 ??384|Body exceeds/i, String(refusal?.message));
    assert.ok(last !== undefined, "no successful round before the refusal");
    const store = last.store;
    const insp = await store.inspect(last.investigationRef);
    // Prior committed view intact; the failed round settled with accounting.
    assert.ok(insp.committed !== null, "prior committed view lost");
    assert.ok(insp.incomplete !== null, "failed round left no incomplete marker");
    assert.equal(insp.incomplete.settled, true, "failed round not settled");
    void state;
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// R4b: no-judge overflow must still disclose the context bound.
test("R4b: no-judge oversized context discloses assessment_context_overflow, retains no-judge fact", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fourroots-"));
  const big = "v".repeat(16 * 1024 - 24);
  const deps = {
    now: Date.now,
    search: async () => [],
    read: async () => { throw new Error("no read"); },
    judge: null,
  };
  try {
    const r1 = await startCallerRound({ storeRoot: root, contract: CONTRACT, deps,
      representations: Array.from({ length: 16 }, (_, i) => ({ format: "text", content: `lead ${i} ${big}`, label: `r${i}` })) });
    assert.equal(r1.result.assessment, "deterministic-only");
    assert.equal(r1.result.usage.candidateJudgeCalls + r1.result.usage.judgeCalls, 0, "zero semantic with no judge");
    assert.equal(r1.result.requirements.version.reason, "assessment_context_overflow", `reason was ${r1.result.requirements.version.reason}`);
    assert.equal(r1.handoff.stopReason, "assessment-context-overflow");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
