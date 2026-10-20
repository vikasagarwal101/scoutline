import test from 'node:test';
import assert from 'node:assert/strict';
import {sandbox,bin,contract,output,noHTTP,api} from './helpers/caller-review-harness.mjs';
const request={schemaVersion:1,operation:'start',dataScope:'synthetic',requirements:{...contract,requirements:{csv:contract.requirements.csv}}};
function measured(p,events) {
  const dispatches=events.filter(e=>e.url);
  const acquisition=dispatches.filter(e=>e.url.startsWith('https://api.tavily.com/')).length;
  const judge=dispatches.filter(e=>e.url==='https://api.typesafe.ai/v1/systemone').length;
  assert.equal(p.schemaVersion,1);
  assert.equal(p.source,'handler-owned-native-ledger');
  assert.equal(p.cutoff,'locally-settled');
  assert.equal(p.stages.acquisition,acquisition);
  assert.equal(p.stages.judge,judge);
  assert.equal(p.stages.producer,0,'absent production extractor has no dispatch');
  assert.equal(p.knownSubtotal,dispatches.length);
  assert.equal(p.total,dispatches.length);
  assert.equal(p.admission.acquisition,'shared');
  assert.equal(p.admission.judge,'shared');
  assert.equal(p.admission.producer,'not-configured');
}
async function saved(state,h) {
  const r=await bin(state,{schemaVersion:1,operation:'inspect',investigationRef:h.investigationRef},{env:{REVIEW_REFUSE_HTTP:'1'}});
  assert.equal(r.code,0,r.stderr);noHTTP(r);
  return output(r);
}
test('N01 production native observed dispatches equal persisted cross-process physical snapshot',async()=>{
  const state=await sandbox();
  const r=await bin(state,request);
  const h=output(r);
  assert.ok(r.events.some(e=>e.url==='https://api.typesafe.ai/v1/systemone'));
  measured(h.physical,r.events);
  assert.equal(h.physical.reservationsRefused,0);
  const inspected=await saved(state,h);
  assert.deepEqual(inspected.physical,h.physical,'offline inspect preserves exact measured snapshot');
  assert.equal(inspected.resultSha256,h.resultSha256,'unchanged view hashes exact stored projection');
});
test('N02 native retry last slot stops fourth HTTP and persists bounded known counts',async()=>{
  const state=await sandbox();
  const r=await bin(state,request,{env:{SCOUTLINE_REQUIREMENTS_MAX_PHYSICAL:'3',REVIEW_JUDGE_RETRY:'1'}});
  const h=output(r);
  assert.equal(r.events.filter(e=>e.url).length,3);
  measured(h.physical,r.events);
  assert.ok(h.physical.reservationsRefused>0,'real native retry refusal recorded');
  assert.deepEqual((await saved(state,h)).physical,h.physical);
});
test('N03 native cancellation freezes exact abort observations and retains inspectable record',async()=>{
  const state=await sandbox();
  const r=await bin(state,request,{signalEvent:'api.typesafe.ai',env:{REVIEW_HANG_JUDGE:'1'}});
  assert.equal(r.code,130,r.stderr);assert.equal(r.signal,null);
  const h=JSON.parse(r.stdout||r.stderr);
  assert.ok(h.investigationRef,'only actually created record referenced');
  assert.equal(h.stopReason,'cancelled');
  const abort=r.events.findIndex(e=>e.event==='native-abort');assert.ok(abort>=0);
  assert.equal(r.events.slice(abort+1).filter(e=>e.url).length,0);
  measured(h.physical,r.events);
  assert.deepEqual((await saved(state,h)).physical,h.physical,'postabort snapshot cannot change during offline inspect');
});
test('N04 deps-only library has unknown physical telemetry, never inferred native certificate',async()=>{
  const state=await sandbox();
  const {executeCallerInvestigation}=await api();
  const h=await executeCallerInvestigation(request,{storeRoot:state.env.SCOUTLINE_INVESTIGATIONS_DIR,deps:{search:async()=>[],read:async()=>{throw new Error('no source');},judge:null,now:()=>Date.now()}});
  assert.equal(h.physical,undefined);
  assert.equal(h.cumulativeUsage.physicalAttempts,null);
  assert.ok(h.cumulativeUsage.unknownStages.length>0);
});
