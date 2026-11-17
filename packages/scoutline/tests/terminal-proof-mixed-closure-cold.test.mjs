import test from "node:test";
import assert from "node:assert/strict";
import { inputs } from "./unified-review-corpus.mjs";
import { offlineDeps } from "./unified-review-offline-deps.mjs";
import { runLeanInvestigation } from "../dist/lib/lean-investigation.js";

test("multiple passing prerequisite proofs publish dependent against chosen final value and provenance", async () => {
  const c = structuredClone(inputs[0]);
  c.sources[1].content =
    "Aster release 3.0.\nLicense for release 3.0: Apache-2.0.\nRelease 3.0 supports CSV export.";
  const { deps } = offlineDeps(c);
  deps.extract = async (input) => {
    const id = input.fields[0].id;
    const line = input.sourceText.split("\n")[id === "version" ? 0 : 1];
    const value =
      id === "version" ? line.match(/release ([\d.]+)\./)[1] : line.match(/: ([\w.-]+)\./)[1];
    return { finishReason: "stop", rawOutput: JSON.stringify({ [id]: { value, quote: line } }) };
  };
  const r = await runLeanInvestigation(c.contract, deps);
  assert(
    r.data.version && r.data.license,
    "positive multiple-accept control publishes both requested values",
  );
  const row = r.requirements.license;
  const audit = row.attemptedRecords.find((x) =>
    x.assessments.some((a) => a.candidateId === row.judgment.candidateId),
  );
  const binding = audit.metadata.depBindings.version;
  assert.equal(binding.value, r.data.version);
  assert.equal(binding.evidenceId, r.requirements.version.provenance.sourceId);
  assert.equal(binding.sourceDigest, r.requirements.version.provenance.sourceDigest);
});

for (const revised of [false, true]) {
  test(`terminal value withdrawal preserves mixed dependency closure: revision=${revised}`, async () => {
    const c = structuredClone(inputs[0]);
    const version = c.contract.requirements.version;
    const csv = c.contract.requirements.csv;
    const independent = {
      ...structuredClone(csv),
      question: "Independent CSV classification control",
    };
    csv.dependsOn = ["version"];
    c.contract.requirements = { version, csv, independent };
    const { deps, live } = offlineDeps(c, { captureLiveTargets: true });
    const judge = deps.candidateJudge,
      search = deps.search;
    let guide,
      armed = false,
      ticks = 0,
      exercised = false;
    deps.candidateJudge = async (input) => {
      if (input.source.evidenceId === "e1") guide = live.retained.get(input.source.evidenceId);
      return judge(input);
    };
    deps.search = async (query) => {
      const result = await search(query);
      if (query === `${independent.question} contrary evidence refuted`) armed = true;
      return result;
    };
    deps.now = () => {
      if (armed && ++ticks === 2) {
        assert(guide);
        if (revised) live.reviseSource(guide, (guide) => {
          guide.content += "\nRetained record revision.";
        });
        exercised = true;
      }
      return 0;
    };
    const r = await runLeanInvestigation(c.contract, deps);
    assert(exercised);
    assert.equal(r.data.independent, "supported", "independent classification stays valid");
    if (!revised) {
      assert.equal(r.data.version, "2.4");
      assert.equal(r.data.csv, "supported");
    } else {
      assert(!("version" in r.data), "actual final proof withdraws revised value prerequisite");
      assert(
        !("csv" in r.data),
        "classification dependent cannot publish after its mandatory prerequisite is withdrawn",
      );
    }
  });
}
