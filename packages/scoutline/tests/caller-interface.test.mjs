import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startCallerRound } from '../dist/lib/lean-caller-rounds.js';

// Callable baseline RED: paid work settles, but no complete inspectable result is retained.
test('caller round retains the complete result for credential-free reopening', async () => {
  const storeRoot = await mkdtemp(join(tmpdir(), 'caller-interface-'));
  const round = await startCallerRound({storeRoot, dataScope:'synthetic',
    contract:{schemaVersion:1,question:'version?',requirements:{v:{question:'version?',schema:{type:'string'}}}},
    deps:{search:async()=>[{url:'https://example.test/a',title:'a'}],read:async()=> 'version 1.2.3',judge:null,now:()=>1000}});
  const snapshot = (await round.store.inspect(round.investigationRef)).committed.snapshot;
  const pointer = JSON.parse((await round.store.readBody(round.investigationRef, JSON.parse(snapshot.audit[0].detail).root)).toString());
  const state = JSON.parse((await Promise.all(pointer.state.chunks.map(b=>round.store.readBody(round.investigationRef,b.bodyId)))).map(b=>b.toString()).join(''));
  assert.equal(state.results?.length,1,'complete current result must be retained, not reconstructed from reduced snapshot outcome');
  const retained = JSON.parse((await Promise.all(state.results[0].result.chunks.map(b=>round.store.readBody(round.investigationRef,b.bodyId)))).map(b=>b.toString()).join(''));
  assert.deepEqual(retained.result, round.result);
  assert.equal(retained.stopReason,round.handoff.stopReason);
});
