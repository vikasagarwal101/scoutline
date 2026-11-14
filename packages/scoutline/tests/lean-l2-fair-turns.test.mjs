import test from 'node:test';
import assert from 'node:assert/strict';
import { runLeanInvestigation } from '../dist/lib/lean-investigation.js';
import { inputs } from './unified-review-corpus.mjs';
import { offlineDeps } from './unified-review-offline-deps.mjs';
for (const reverse of [false, true]) for (const cap of [2, 4]) {
  test(`L2 mandatory peers alternate source-pair turns: reverse=${reverse} cap=${cap}`, async () => {
    const c = structuredClone(inputs[0]);
    delete c.contract.requirements.csv;
    delete c.contract.requirements.license.dependsOn;
    c.contract.requirements.license.question = 'What license applies to Aster release 2.4?';
    if (reverse) c.contract.requirements = { license: c.contract.requirements.license, version: c.contract.requirements.version };
    c.acquisition.initial = c.sources.map(s => s.id);
    c.contract.limits = { maxJudgeAttempts: cap };
    const { deps, calls } = offlineDeps(c);
    const r = await runLeanInvestigation(c.contract, deps);
    const order = Object.keys(c.contract.requirements);
    assert.deepEqual(calls.candidateJudge.map(x => x.candidates[0].fieldId), cap === 2 ? order : [...order, ...order]);
    assert.equal(r.usage.candidateJudgeCalls, cap);
    for (const id of order) {
      const pairCalls = calls.candidateJudge.filter(x => x.candidates[0].fieldId === id);
      assert.equal(pairCalls.length, cap / 2);
      assert.equal(r.requirements[id].judgmentCount, cap / 2);
      const audits = r.requirements[id].attemptedRecords.filter(x => x.metadata?.kind === 'candidate-judgment');
      assert.equal(audits.length, cap / 2);
      if (cap === 4) {
        assert.equal(new Set(pairCalls.map(x => x.source.evidenceId)).size, 2, 'yield retains both source pairs; no witness shortcut');
        assert.equal(new Set(audits.map(x => x.metadata.sourceId)).size, 2);
        assert.equal(r.status, 'complete');
        assert.equal(r.data.version, '2.4');
        assert.equal(r.data.license, 'MIT');
      }
    }
  });
}
for (const mode of ['invalid', 'unknown']) {
  test(`L2 ${mode} source pair yields to mandatory peer under frozen clock`, async () => {
    const c = structuredClone(inputs[0]);
    delete c.contract.requirements.csv;
    delete c.contract.requirements.license.dependsOn;
    c.acquisition.initial = c.sources.map(s => s.id);
    c.contract.limits = { maxJudgeAttempts: 4 };
    const { deps, calls } = offlineDeps(c);
    const extract = deps.extract, judge = deps.candidateJudge;
    deps.extract = async input => {
      const a = await extract(input);
      if (mode === 'invalid' && input.fields[0].id === 'version' && input.sourceId === 'e1') a.rawOutput = JSON.stringify({ version: { value: null, quote: null } });
      return a;
    };
    deps.candidateJudge = async input => {
      const a = await judge(input);
      if (mode === 'unknown' && input.candidates[0].fieldId === 'version') a.answers.q0s.noul = .5;
      return a;
    };
    const r = await runLeanInvestigation(c.contract, deps);
    assert.deepEqual(calls.extract.slice(0, 2).map(x => x.fields[0].id), ['version', 'license']);
    assert.equal(r.data.license, 'MIT');
    const versionJudges = calls.candidateJudge.filter(x => x.candidates[0].fieldId === 'version');
    assert.equal(versionJudges.length, mode === 'invalid' ? 1 : 2);
    assert.equal(new Set(calls.extract.filter(x => x.fields[0].id === 'version').map(x => x.sourceId)).size, 2);
  });
}
