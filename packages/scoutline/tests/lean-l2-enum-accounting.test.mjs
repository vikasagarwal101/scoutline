import test from 'node:test';
import assert from 'node:assert/strict';
import { runLeanInvestigation } from '../dist/lib/lean-investigation.js';
const field = (overflow = false) => ({ question: 'CSV?', schema: { enum: ['supported'] }, criteria: [overflow ? 'x'.repeat(270000) : 'CSV claim'] });
for (const mode of ['overflow', 'short', 'overflow-peer', 'throw']) {
  test(`L2 counts only invoked enum judgments: ${mode}`, async () => {
    const calls = [];
    const requirements = mode === 'overflow-peer' ? { huge: field(true), valid: { ...field(), question: 'Does CSV work?' } } : { csv: field(mode === 'overflow') };
    const r = await runLeanInvestigation({ schemaVersion: 1, question: 'Assess CSV', requirements, limits: { maxJudgeAttempts: 1 } }, {
      now: () => 0, search: async () => [{ url: 'https://fixture.invalid/a' }], read: async () => 'CSV works.',
      judge: async ({ fieldId, documents }) => { calls.push(fieldId); if (mode === 'throw') throw Error('judge failure'); return { documents: documents.map(d => ({ evidenceId: d.evidenceId, relevant: true, supportsClaim: true, refutesClaim: false })) }; },
    });
    const count = mode === 'overflow' ? 0 : 1;
    assert.equal(r.usage.judgeCalls, calls.length, 'usage counts actual invocations');
    assert.equal(calls.length, count);
    assert.equal(Object.values(r.requirements).reduce((n, f) => n + f.judgmentCount, 0), count);
    assert.equal(r.acquisitionLog.filter(x => x.kind === 'judge').length, count);
    if (mode.startsWith('overflow')) {
      const f = r.requirements[mode === 'overflow' ? 'csv' : 'huge'];
      assert.equal(f.reason, 'assessment_context_overflow');
      assert.equal(f.judgmentCount, 0);
      const overflows = f.attemptedRecords.filter(x => x.reason === 'assessment_context_overflow');
      assert.equal(overflows.length, 1, 'visited overflow cannot spin/repeat unchanged context');
      assert.equal(overflows[0].trusted, false);
      assert.deepEqual(overflows[0].assessments, []);
      assert.equal(overflows[0].metadata.kind, 'classification-judgment');
      assert(!('usage' in overflows[0].metadata), 'unknown telemetry is not invented');
    }
    if (mode === 'overflow-peer') { assert.deepEqual(calls, ['valid']); assert.equal(r.data.valid, 'supported'); }
    if (mode === 'short') assert.equal(r.status, 'complete');
    if (mode === 'throw') assert.equal(r.requirements.csv.reason, 'judge_unavailable');
  });
}
