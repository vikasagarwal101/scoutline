import test from 'node:test';
import assert from 'node:assert/strict';
import { runLeanInvestigation } from '../dist/lib/lean-investigation.js';
const urls = ['https://fixture.invalid/a', 'https://fixture.invalid/b'];
const contract = (batch = 2) => ({ schemaVersion: 1, question: 'Check CSV', requirements: { csv: { question: 'CSV?', schema: { enum: ['supported'] } } }, limits: { deadlineMs: 1000, readBatchSize: batch } });
const judge = async ({ documents }) => ({ documents: documents.map(d => ({ evidenceId: d.evidenceId, relevant: true, supportsClaim: true, refutesClaim: false })) });
for (const semantic of [false, true]) for (const stop of ['deadline', 'cancel']) for (const reject of [false, true]) {
  test(`L2 admits each read and retry: semantic=${semantic} stop=${stop} reject=${reject}`, async () => {
    let elapsed = 0, checkpoint;
    const controller = new AbortController(), reads = [];
    const r = await runLeanInvestigation(contract(), {
      now: () => elapsed, externalSignal: controller.signal,
      seed: { capture: x => checkpoint = x },
      search: async q => q === 'Check CSV' ? urls.map(url => ({ url })) : [],
      read: async (url, options) => {
        reads.push({ url, timeoutMs: options.timeoutMs, aborted: options.signal.aborted });
        if (stop === 'deadline') elapsed = 1001; else controller.abort();
        if (reject) throw Error('first read failed after stop');
        return 'CSV works.';
      }, judge: semantic ? judge : null,
    });
    assert.deepEqual(reads, [{ url: urls[0], timeoutMs: 1000, aborted: false }]);
    assert.equal(r.usage.readAttempts, reads.length);
    assert.equal(r.acquisitionLog.filter(x => ['read', 'read-retry'].includes(x.kind)).length, reads.length);
    assert.equal(r.acquisitionLog.filter(x => x.kind === 'read-retry').length, 0);
    assert.equal(r.acquisitionLog.filter(x => x.kind === 'read-failed').length, reject ? 1 : 0);
    assert.deepEqual(r.evidence.map(x => x.url), reject ? [] : [urls[0]]);
    assert.equal(r.usage.readsRetained, reject ? 0 : 1);
    assert.deepEqual(checkpoint.leads.map(x => x.url), reject ? urls : [urls[1]], 'unadmitted and failed URLs remain continuation leads');
    assert.equal(r.status, 'partial');
    assert.deepEqual(r.data, {});
  });
}
for (const semantic of [false, true]) for (const batch of [1, 2]) for (const retry of [false, true]) {
  test(`L2 ordinary read/retry control: semantic=${semantic} batch=${batch} retry=${retry}`, async () => {
    const reads = [];
    let failed = false;
    const r = await runLeanInvestigation(contract(batch), {
      now: () => 0, search: async q => q === 'Check CSV' ? urls.map(url => ({ url })) : [],
      read: async url => { reads.push(url); if (retry && !failed) { failed = true; throw Error('transient'); } return 'CSV works.'; },
      judge: semantic ? judge : null,
    });
    assert.deepEqual(reads, retry ? [urls[0], ...urls] : urls);
    assert.equal(r.usage.readAttempts, reads.length);
    assert.equal(r.acquisitionLog.filter(x => ['read', 'read-retry'].includes(x.kind)).length, reads.length);
    assert.equal(r.evidence.length, 2);
    assert.equal(r.acquisitionLog.filter(x => x.kind === 'read-retry').length, retry ? 1 : 0);
    assert.equal(r.status, semantic ? 'complete' : 'partial');
  });
}
