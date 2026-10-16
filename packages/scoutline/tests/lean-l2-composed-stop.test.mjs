import test from 'node:test';
import assert from 'node:assert/strict';
import { runLeanInvestigation } from '../dist/lib/lean-investigation.js';
import { inputs } from './unified-review-corpus.mjs';
import { offlineDeps } from './unified-review-offline-deps.mjs';
for (const stage of ['extract', 'candidateJudge', 'judge']) for (const carrier of ['reason', 'stopReason']) for (const root of ['global_extraction_cap', 'global_judgment_cap', 'global_deadline']) {
  test(`L2 composed stop blocks every subsequent collaborator: ${stage}/${carrier}/${root}`, async () => {
    const c = structuredClone(inputs[0]);
    delete c.contract.requirements.license.dependsOn;
    if (stage === 'judge') c.contract.requirements = { csv: c.contract.requirements.csv, version: c.contract.requirements.version, license: c.contract.requirements.license };
    c.acquisition.initial = c.sources.map(s => s.id);
    const { deps } = offlineDeps(c);
    let stopped = false, refused = 0;
    const after = [];
    for (const name of ['search', 'read', 'extract', 'candidateJudge', 'judge']) {
      const fn = deps[name];
      deps[name] = async (...args) => {
        if (stopped) after.push(name);
        if (name === stage && !stopped) {
          stopped = true; refused++;
          throw Object.assign(Error('secret body MUST NOT survive'), { code: 'EVAL_STOPPED', [carrier]: root, observed: { elapsedMs: 3, usage: null, secret: 'credential' } });
        }
        return fn(...args);
      };
    }
    const r = await runLeanInvestigation(c.contract, deps);
    assert.equal(refused, 1, 'target reached exactly once');
    assert.deepEqual(after, [], 'no work after the refused attempt');
    const field = stage === 'judge' ? 'csv' : 'version';
    assert.equal(r.requirements[field].reason, root);
    const audit = Object.values(r.requirements).flatMap(x => x.attemptedRecords);
    const refusedAudit = audit.filter(x => x.trusted === false && (x.reason?.includes('EVAL_STOPPED') || x.metadata?.error === 'judge_rejected'));
    assert.equal(refusedAudit.length, 1, 'one refused audit, including normalized rejection');
    assert(!JSON.stringify(r).includes('secret body'));
    assert(!JSON.stringify(r).includes('credential'));
    assert.equal(r.status, 'partial');
  });
}
for (const stage of ['extract', 'candidateJudge', 'judge']) for (const kind of ['unknown-root', 'ordinary']) {
  test(`L2 non-global errors retain continuation: ${stage}/${kind}`, async () => {
    const c = structuredClone(inputs[0]);
    delete c.contract.requirements.license.dependsOn;
    c.acquisition.initial = c.sources.map(s => s.id);
    const { deps } = offlineDeps(c);
    let failed = false;
    const after = [];
    for (const name of ['search', 'read', 'extract', 'candidateJudge', 'judge']) {
      const fn = deps[name];
      deps[name] = async (...args) => {
        if (failed) after.push(name);
        if (name === stage && !failed) {
          failed = true;
          throw Object.assign(Error('ordinary failure'), kind === 'unknown-root' ? { code: 'EVAL_STOPPED', reason: 'not_approved' } : {});
        }
        return fn(...args);
      };
    }
    await runLeanInvestigation(c.contract, deps);
    assert(failed);
    assert(after.length > 0, 'ordinary/unknown errors do not stop independent work');
  });
}
