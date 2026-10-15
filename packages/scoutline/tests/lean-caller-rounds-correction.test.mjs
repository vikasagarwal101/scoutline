import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { startCallerRound, continueCallerRound } from '../dist/lib/lean-caller-rounds.js';

globalThis.fetch = () => { throw new Error('HTTP refused'); };
const contract = {
  schemaVersion: 1, question: 'Version of Test release?',
  requirements: { version: { question: 'Version of Test release?', schema: { type: 'string' }, required: true } },
};
const baseline = { schemaVersion: 1, fields: { version: { definition: 'synthetic', required: true } } };
function world() {
  const calls = { semantic: 0, search: 0, read: 0 };
  const deps = {
    now: Date.now,
    search: async () => { calls.search++; return [{ url: 'https://example.test/release', title: 'Release' }]; },
    read: async () => { calls.read++; return 'Test release 2.4'; },
    judge: async (input) => { calls.semantic++; return { documents: input.documents.map(d => ({ evidenceId: d.evidenceId, relevant: true, supportsClaim: true, refutesClaim: false })) }; },
    extract: async (input) => ({ finishReason: 'stop', rawOutput: JSON.stringify({ version: { value: '2.4', quote: 'Test release 2.4', charRange: [0,16] } }), usage: null, observedCost: null, elapsedMs: 0, requestSha256: '0'.repeat(64) }),
    candidateJudge: async (input) => {
      calls.semantic++;
      return { model: 'synthetic-judge-v1', answers: { q0s: { type: 'noul', noul: .97 }, q0c: { type: 'noul', noul: .01 } }, usage: { inputTokens: 1, outputTokens: 1 }, elapsedMs: 1, requestSha256: '0'.repeat(64) };
    },
  };
  return { calls, deps };
}

test('unchanged persisted basis across three rounds never buys another semantic judgment', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'caller-correction-'));
  const w = world();
  const handles = [];
  try {
    let r = await startCallerRound({ storeRoot: root, requirements: baseline, contract, deps: w.deps, judgeIdentity: 'synthetic-judge-v1', policyRevision: 'engine-policy-v1' });
    handles.push(r.handle); await r.handle?.release();
    assert.equal(r.result.data.version, '2.4');
    const initial = w.calls.semantic;
    assert.ok(initial > 0);
    for (let i = 0; i < 2; i++) {
      r = await continueCallerRound({ storeRoot: root, investigationRef: r.investigationRef, expectedRevision: r.handoff.revision, contract, deps: w.deps, judgeIdentity: 'synthetic-judge-v1', policyRevision: 'engine-policy-v1' });
      handles.push(r.handle); await r.handle?.release();
      assert.equal(r.result.data.version, '2.4');
      assert.equal(w.calls.semantic, initial, 'unchanged settled context re-bought judgment');
    }
  } finally {
    for (const h of handles) await h?.release();
    await fs.rm(root, { recursive: true, force: true });
  }
});
