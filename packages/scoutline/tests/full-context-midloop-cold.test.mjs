import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { inputs } from "./unified-review-corpus.mjs";
import { offlineDeps } from "./unified-review-offline-deps.mjs";
import { runLeanInvestigation } from "../dist/lib/lean-investigation.js";
import { acceptCandidate } from "../dist/lib/lean-candidates.js";

for (const mode of ["unchanged", "source-revision", "scope-revision"]) {
  test(`mid-loop finalization requires standing accept full proof: ${mode}`, async () => {
    const c = structuredClone(inputs[0]);
    const { deps, live } = offlineDeps(c, { captureLiveTargets: true });
    const judge = deps.candidateJudge;
    const search = deps.search;
    let guide,
      scope,
      standingDispatch,
      preRevisionBasis,
      exercised = false;
    deps.candidateJudge = async (input) => {
      if (input.source.evidenceId === "e1") guide = live.retained.get(input.source.evidenceId);
      scope = live.scope;
      const presented = structuredClone(input);
      const response = await judge(input);
      if (
        input.source.evidenceId === "e1" &&
        input.opposingContext.length > 0 &&
        input.candidates.some((candidate) => candidate.fieldId === "version") &&
        !exercised
      ) {
        standingDispatch = { input: presented, requestSha256: response.requestSha256 };
      }
      return response;
    };
    deps.search = async (query) => {
      const result = await search(query);
      if (query === `${c.contract.requirements.csv.question} contrary evidence refuted`) {
        assert(guide && scope, "actual prior candidate dispatch supplied retained records");
        assert(standingDispatch, "version was judged on the full pre-revision context");
        const presented = [standingDispatch.input.source, ...standingDispatch.input.opposingContext];
        assert.deepEqual(
          presented.map((source) => source.evidenceId).sort(),
          [...live.retained.keys()].sort(),
          "the captured judgment covered every pre-revision retained record",
        );
        for (const source of presented) {
          const retained = live.retained.get(source.evidenceId);
          assert.equal(retained.url, source.url);
          assert.equal(retained.content, source.content);
        }
        assert.deepEqual(standingDispatch.input.scope, scope);
        preRevisionBasis = structuredClone(standingDispatch);
        if (mode === "source-revision") live.reviseSource(guide, (guide) => {
          guide.content += "\nThis record has been revised.";
        });
        if (mode === "scope-revision") live.reviseScope((scope) => { scope.release = "3.0"; });
        exercised = true;
      }
      return result;
    };
    const r = await runLeanInvestigation(c.contract, deps);
    assert(exercised);
    const row = r.requirements.version;
    const prior = preRevisionBasis.input;
    const acceptedAudit = row.attemptedRecords.find(
      (attempt) =>
        attempt.trusted &&
        attempt.metadata?.kind === "candidate-judgment" &&
        attempt.metadata.sourceId === prior.source.evidenceId &&
        attempt.metadata.requestSha256 === preRevisionBasis.requestSha256,
    );
    assert(acceptedAudit, "a genuine trusted candidate-judgment acceptance preceded the revision");
    assert.deepEqual(acceptedAudit.metadata.opposingIds, prior.opposingContext.map((source) => source.evidenceId));
    const judgment = acceptedAudit.assessments.find((assessment) => assessment.fieldId === "version");
    assert(judgment?.candidateId);
    const proposed = prior.candidates.find((candidate) => candidate.fieldId === "version");
    const candidate = row.candidates.find(
      (outcome) =>
        outcome.status === "candidate" &&
        outcome.fieldId === "version" &&
        outcome.value === proposed.value &&
        outcome.quote === proposed.quote &&
        outcome.charRange?.[0] === proposed.charRange[0] &&
        outcome.charRange?.[1] === proposed.charRange[1],
    );
    assert(candidate, "use the engine's actual validated candidate outcome");
    const sourceDigest = createHash("sha256").update(prior.source.content).digest("hex");
    const priorContext = {
      fieldMeanings: prior.fieldMeanings,
      scope: prior.scope,
      opposingContext: prior.opposingContext,
      depBindings: prior.depBindings,
    };
    assert.equal(
      acceptCandidate(candidate, judgment, prior.source, sourceDigest, priorContext).status,
      "accepted",
      "the actual trusted assessment must pass on its immutable pre-revision basis",
    );
    if (mode === "unchanged") {
      assert.equal(r.data.version, "2.4");
      assert.equal(r.data.license, "MIT");
    } else {
      const source = r.evidence.find((record) => record.evidenceId === prior.source.evidenceId);
      assert(source);
      const checked = acceptCandidate(candidate, judgment, source, sourceDigest, {
        ...priorContext,
        scope,
        opposingContext: r.evidence.filter((record) => record.evidenceId !== source.evidenceId),
      });
      assert.equal(
        checked.status,
        "unresolved",
        "existing deterministic seam rejects the captured trusted proof against actual current records",
      );
      assert(
        !("version" in r.data),
        "standing acceptance invalidated after judgment must not bypass live proof in mid-loop finalization",
      );
      assert(!("license" in r.data), "dependent cannot finalize on invalid prerequisite proof");
    }
  });
}

test("fixture extraction and relevance follow the actual compiled scope", async () => {
  const c = structuredClone(inputs[0]);
  const { deps, calls, live } = offlineDeps(c, { captureLiveTargets: true });
  const extract = deps.extract;
  const judge = deps.judge;
  const afterRevision = { extract: [], judge: [] };
  let revised = false;
  deps.extract = async (input) => {
    const wasRevised = revised;
    const response = await extract(input);
    assert.equal(live.scope, input.scope, "the helper captured the engine's actual scope object");
    if (wasRevised) {
      afterRevision.extract.push({ scope: structuredClone(input.scope), output: JSON.parse(response.rawOutput) });
    } else {
      live.reviseScope((scope) => {
        scope.entity = "OtherApp";
        scope.release = "3.0";
      });
      revised = true;
    }
    return response;
  };
  deps.judge = async (input) => {
    const response = await judge(input);
    if (revised) afterRevision.judge.push({ scope: structuredClone(input.scope), response });
    return response;
  };
  const result = await runLeanInvestigation(c.contract, deps);
  assert(revised);
  const versionExtractions = afterRevision.extract.filter((entry) => Object.hasOwn(entry.output, "version"));
  assert(versionExtractions.length > 0, "the engine actually extracted after the live scope revision");
  for (const entry of versionExtractions) {
    assert.deepEqual(entry.scope, { entity: "OtherApp", release: "3.0" });
    assert.equal(entry.output.version.value, null, "extraction must use the actual compiled scope");
    assert.equal(entry.output.version.quote, null);
  }
  assert(afterRevision.judge.length > 0, "the engine actually judged relevance after the live scope revision");
  for (const entry of afterRevision.judge) {
    assert.deepEqual(entry.scope, { entity: "OtherApp", release: "3.0" });
    assert(entry.response.documents.every((document) => document.relevant === false), "relevance must use the actual compiled entity and release");
  }
  assert.equal(c.contract.scope.entity, "Aster", "the original caller contract stays detached");
  assert.equal(c.contract.scope.release, "2.4");
  assert.equal(result.usage.extractorCalls, calls.extract.length, "one fixture extraction per actual dispatch");
  assert.equal(result.usage.judgeCalls, calls.judge.length);
});
