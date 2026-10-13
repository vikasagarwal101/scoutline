import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { inputs } from "../unified-review-corpus.mjs";
import { offlineDeps } from "../unified-review-offline-deps.mjs";
const root =
  new URL("../..", import.meta.url).pathname;
const { runLeanInvestigation } = await import(`${root}/dist/lib/lean-investigation.js`);
const { validateCandidates, assessCandidates, acceptCandidate } = await import(
  `${root}/dist/lib/lean-candidates.js`
);
// HISTORICAL RECOVERY GATE — NOT part of the ordinary test selector.
// Replays the frozen sanitized evaluation05 runtime report
// (expected raw SHA-256 3d755ba67573199b86f33107aa098113dacdbf3f4b8fc596c978df6904c3a1c3).
// No copy is currently authorized/recoverable; this gate MUST FAIL clearly
// (EVAL_REPORT_MISSING / EVAL_REPORT_HASH_MISMATCH) until the exact
// original is provided. No fallback, skip or synthesized response.
const EXPECTED_RAW_SHA256 =
  "3d755ba67573199b86f33107aa098113dacdbf3f4b8fc596c978df6904c3a1c3";
function loadHistoricalReport() {
  const candidate = [
    process.env.EVAL05_REPORT_PATH,
    new URL("./fixtures/evaluation-05/result.json", import.meta.url).pathname,
  ].find((p) => p && existsSync(p));
  if (!candidate)
    throw Object.assign(
      Error(
        `EVAL_REPORT_MISSING: sanitized evaluation05 result.json not provided. ` +
          `Set EVAL05_REPORT_PATH to the authorized sanitized original ` +
          `(raw SHA-256 ${EXPECTED_RAW_SHA256}) or place it at ` +
          `tests/historical-replay/fixtures/evaluation-05/result.json. ` +
          `Historical replay cannot run without the exact recorded evidence.`,
      ),
      { code: "EVAL_REPORT_MISSING" },
    );
  const raw = readFileSync(candidate, "utf8");
  const actual = createHash("sha256").update(raw).digest("hex");
  if (actual !== EXPECTED_RAW_SHA256)
    throw Object.assign(
      Error(
        `EVAL_REPORT_HASH_MISMATCH: ${candidate} hashes ${actual}, ` +
          `expected original ${EXPECTED_RAW_SHA256}. Refusing to replay ` +
          `from altered evidence.`,
      ),
      { code: "EVAL_REPORT_HASH_MISMATCH" },
    );
  return JSON.parse(raw);
}
const report = loadHistoricalReport();
const sha = (x) => createHash("sha256").update(x).digest("hex");
function key(stage, input) {
  if (stage === "extraction")
    return JSON.stringify([input.sourceText, input.fields, input.scope, input.depBindings]);
  if (stage === "candidate")
    return JSON.stringify([
      input.scope,
      input.depBindings,
      input.source.evidenceId,
      input.source.content,
      input.opposingContext.map((x) => [x.evidenceId, x.content]),
      input.candidates.map((x) => [
        x.fieldId,
        x.value,
        x.quote,
        x.charRange,
        input.fieldMeanings[x.fieldId],
      ]),
    ]);
  return JSON.stringify([
    input.fieldQuestion,
    input.scope,
    input.criteria,
    input.depBindings,
    input.documents.map((x) => [x.evidenceId, x.content]),
  ]);
}
function recordedKey(a) {
  const s =
    a.stage === "extraction"
      ? JSON.parse(a.request.messages.find((m) => m.role === "user").content)
      : a.request.state;
  if (a.stage === "extraction") return JSON.stringify([s.source, s.fields, s.scope, s.depBindings]);
  if (a.stage === "candidate")
    return JSON.stringify([
      s.scope,
      s.depBindings,
      s.source.id,
      s.source.text,
      s.opposingContext.map((x) => [x.id, x.text]),
      s.fields.map((x) => [x.fieldId, x.value, x.quote, x.charRange, x.meaning]),
    ]);
  return JSON.stringify([
    s.requirement,
    s.scope,
    s.criteria,
    s.depBindings,
    s.sources.map((x) => [x.id, x.text]),
  ]);
}
async function replay(id) {
  const c = structuredClone(inputs.find((x) => x.id === id)),
    base = offlineDeps(c),
    used = new Set(),
    newWork = [],
    calls = [];
  const records = report.attempts.filter((x) => x.caseId === id);
  const take = (stage, input) => {
    const k = key(stage, input),
      a = records.find((x) => x.stage === stage && !used.has(x.attemptId) && recordedKey(x) === k);
    if (!a) {
      newWork.push({
        stage,
        field:
          stage === "extraction"
            ? input.fields[0].id
            : stage === "candidate"
              ? input.candidates[0].fieldId
              : input.fieldId,
        input: structuredClone(input),
      });
      throw Object.assign(Error("No recorded response for exact newly enabled work"), {
        code: "REPLAY_EXHAUSTED",
      });
    }
    used.add(a.attemptId);
    calls.push(a.attemptId);
    return a;
  };
  const deps = {
    now: () => 0,
    search: base.deps.search,
    read: base.deps.read,
    extractorRevision: "frozen-native-live-v1",
    extract: async (input) => {
      const a = take("extraction", input);
      return { ...a.native.value, ...a.native.metadata };
    },
    candidateJudge: async (input) => {
      const a = take("candidate", input);
      return { ...a.native.metadata, model: "frozen-replay", answers: a.rawResponse.answers };
    },
    judge: async (input) => {
      const a = take("classification", input),
        flag = (p) => (p >= 0.9 ? true : p <= 0.1 ? false : null);
      return {
        documents: input.documents.map((d, i) => ({
          evidenceId: d.evidenceId,
          relevant: flag(a.rawResponse.answers[`q${i}r`].noul),
          supportsClaim: flag(a.rawResponse.answers[`q${i}s`].noul),
          refutesClaim: flag(a.rawResponse.answers[`q${i}f`].noul),
        })),
      };
    },
  };
  return { result: await runLeanInvestigation(c.contract, deps), newWork, used, calls, records };
}
for (const id of ["aster-clean", "dune-late-adverse", "ember-refuted"]) {
  test(`frozen ${id} current trusted prerequisite enables missing final dependent work`, async () => {
    const r = await replay(id);
    assert(r.result.data.version, "current final-context version remains accepted");
    const work = r.newWork.find((x) => x.field === "license");
    assert(work, "dependent MUST attempt bounded missing final-context work; no invented response");
    const bindings = work.input.depBindings;
    assert.equal(bindings.version.value, r.result.data.version);
    const p = r.result.requirements.version.provenance;
    assert.equal(bindings.version.evidenceId, p.sourceId);
    assert.equal(bindings.version.sourceDigest, p.sourceDigest);
    assert.equal(r.result.requirements.license.status, "unresolved");
    assert(!("license" in r.result.data), "unrecorded work cannot produce accepted license");
  });
  test(`frozen ${id} every unresolved outcome has explicit basis not internal fallback`, async () => {
    const r = await replay(id);
    for (const row of Object.values(r.result.requirements))
      if (row.status === "unresolved") {
        assert.equal(typeof row.reason, "string");
        assert(row.reason.length > 0);
        assert.notEqual(row.reason, "internal_stop");
      }
    assert(!("license" in r.result.data));
  });
}
async function identityFixture() {
  const source = {
    evidenceId: "e1",
    url: "https://fixture.invalid/source",
    title: "source",
    content: "Version 2.4 license MIT.",
    byteLength: 24,
    origins: [],
  };
  const opposing = {
    evidenceId: "e2",
    url: "https://fixture.invalid/verification",
    title: "verification",
    content: "Version 2.4 license MIT verification.",
    byteLength: 37,
    origins: [],
  };
  const raw = {
    finishReason: "stop",
    rawOutput: JSON.stringify({ license: { value: "MIT", quote: source.content } }),
  };
  const validation = validateCandidates(source, raw, { license: { maxLength: 40 } }),
    v = validation.fields[0];
  const context = {
    fieldMeanings: { license: "License for accepted version. Require audited attestation." },
    scope: { entity: "Fixture", release: "2.4" },
    opposingContext: [opposing],
    depBindings: {
      version: { value: "2.4", evidenceId: "version-evidence", sourceDigest: "a".repeat(64) },
    },
  };
  const judged = await assessCandidates(
    {
      source,
      ...context,
      candidates: [{ fieldId: "license", value: v.value, quote: v.quote, charRange: v.charRange }],
    },
    {
      judge: async () => ({
        model: "fixture",
        answers: { q0s: { type: "noul", noul: 0.96 }, q0c: { type: "noul", noul: 0.02 } },
        usage: { inputTokens: 1, outputTokens: 1 },
        requestSha256: "b".repeat(64),
        elapsedMs: 1,
      }),
    },
  );
  assert.equal(
    acceptCandidate(v, judged.judgements[0], source, validation.sourceDigest, context).status,
    "accepted",
  );
  return { source, opposing, validation, v, context, judgment: judged.judgements[0] };
}
test("full current source/opposition/dependency/scope/criteria identity rejects historical reuse", async () => {
  const f = await identityFixture();
  const changed = [
    { ...f.context, depBindings: { version: { ...f.context.depBindings.version, value: "3.0" } } },
    {
      ...f.context,
      depBindings: { version: { ...f.context.depBindings.version, sourceDigest: "c".repeat(64) } },
    },
    { ...f.context, scope: { ...f.context.scope, release: "3.0" } },
    {
      ...f.context,
      fieldMeanings: { license: "License for accepted version. Different mandatory criterion." },
    },
    {
      ...f.context,
      opposingContext: [{ ...f.opposing, content: "Version 2.4 license GPL; same-id correction." }],
    },
  ];
  for (const context of changed)
    assert.equal(
      acceptCandidate(f.v, f.judgment, f.source, f.validation.sourceDigest, context).status,
      "unresolved",
    );
  assert.equal(
    acceptCandidate(
      f.v,
      f.judgment,
      { ...f.source, content: "Version 2.4 license GPL." },
      f.validation.sourceDigest,
      f.context,
    ).status,
    "unresolved",
  );
});
test("clear final material conflict cannot unblock dependent acceptance", async () => {
  const c = structuredClone(inputs[0]),
    { deps, calls } = offlineDeps(c),
    judge = deps.candidateJudge;
  deps.candidateJudge = async (input) => {
    const r = await judge(input);
    if (input.candidates[0].fieldId === "version" && input.opposingContext.length)
      r.answers.q0c.noul = 0.97;
    return r;
  };
  const r = await runLeanInvestigation(c.contract, deps);
  assert(!("version" in r.data));
  assert(!("license" in r.data));
  assert.equal(r.status, "partial");
});
test("same final-context guide support survives unknown later candidate; mandatory challenge remains", async () => {
  const c = structuredClone(inputs[0]),
    { deps } = offlineDeps(c),
    judge = deps.candidateJudge;
  deps.candidateJudge = async (input) => {
    const r = await judge(input);
    if (input.source.evidenceId === "e2") r.answers.q0s.noul = 0.5;
    return r;
  };
  const r = await runLeanInvestigation(c.contract, deps);
  assert.equal(r.data.version, "2.4");
  assert.equal(r.data.license, "MIT");
});
test("mandatory returned contrary source and prerequisite closure cannot be waived by cached support", async () => {
  const c = structuredClone(inputs[0]);
  const blocked = structuredClone(c);
  blocked.contract.limits = { maxUniqueReads: 1 };
  const b = await runLeanInvestigation(blocked.contract, offlineDeps(blocked).deps);
  assert.deepEqual(b.data, {});
  assert.equal(b.status, "partial");
});
