import test from "node:test";
import assert from "node:assert/strict";
import { inputs } from "./unified-review-corpus.mjs";
import { labels } from "./unified-review-labels.mjs";
import { nativeDeps } from "./unified-review-native-deps.mjs";
const root =
  new URL("..", import.meta.url).pathname;
const { runLeanInvestigation } = await import(`${root}/dist/lib/lean-investigation.js`);
for (const c of inputs)
  test(`native-composed independent corpus ${c.id}`, async () => {
    const { deps, physical, requests, attempts } = nativeDeps(c);
    const result = await runLeanInvestigation(structuredClone(c.contract), deps);
    const gold = labels.find((x) => x.id === c.id);
    for (const [field, value] of Object.entries(gold.fields)) {
      if (value === null) assert(!(field in result.data), `${c.id}.${field}: expected abstention`);
      else assert.equal(result.data[field], value, `${c.id}.${field}: eligible exact value`);
    }
    assert.equal(result.usage.extractorCalls, physical.extraction);
    assert.equal(result.usage.candidateJudgeCalls, physical.candidate);
    assert.equal(result.usage.judgeCalls, physical.classification);
    assert.equal(
      attempts.length,
      physical.extraction + physical.candidate + physical.classification,
    );
    assert(
      attempts.every((x) => x.result.kind === "ok"),
      JSON.stringify(attempts),
    );
    assert(requests.every((x) => /^[a-f0-9]{64}$/.test(x.requestSha256)));
    for (const [id, row] of Object.entries(result.requirements))
      if (row.provenance) {
        const source = result.evidence.find((s) => s.evidenceId === row.provenance.sourceId);
        assert(source, `${id}: provenance source missing`);
        assert.equal(source.content.slice(...row.provenance.charRange), row.provenance.quote);
      }
    const fields = c.contract.requirements;
    for (const request of requests) {
      if (request.stage === "classification") {
        const field = Object.values(fields).find((f) => f.question === request.state.requirement);
        for (const dep of field?.dependsOn ?? [])
          assert(request.state.depBindings?.[dep], "dependent enum wire lacks binding");
      }
    }
  });
