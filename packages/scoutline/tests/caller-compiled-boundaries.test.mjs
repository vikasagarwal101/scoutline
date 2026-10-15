import test from 'node:test';
import assert from 'node:assert/strict';
import { sandbox,bin,contract,noHTTP,output } from './helpers/caller-review-harness.mjs';
const start={schemaVersion:1,operation:'start',requirements:contract,dataScope:'synthetic'};
test('compiled preflight: closed request/private/binary/header limits reject with zero native HTTP',async()=>{
  const state=await sandbox();
  const invalid=[
    {...start,schemaVersion:2}, {...start,unknown:true}, {...start,dataScope:'private'},
    {...start,maxChars:1023}, {...start,maxChars:65537}, {...start,maxChars:NaN},
    {...start,representations:[{format:'pdf',content:'binary document'}]},
    {...start,representations:[{format:'text',content:'ok',unknown:'ignored?'}]},
    {...start,roundLimits:{maxUniqueReads:7}}, {...start,roundLimits:{unknown:1}},
    {...start,leads:[{url:'https://user:pass@example.test/a'}]},
    {schemaVersion:1,operation:'continue',investigationRef:'../escape',expectedRevision:1},
    {schemaVersion:1,operation:'readEvidence',investigationRef:'../escape',representationId:'x',digest:'x'},
    {schemaVersion:1,operation:'delete',investigationRef:'../escape'},
    {schemaVersion:1,operation:'toString'}, {schemaVersion:1,operation:'constructor'}, {schemaVersion:1,operation:'__proto__'},
  ];
  for(const request of invalid) {
    const r=await bin(state,request,{env:{REVIEW_REFUSE_HTTP:'1'}});
    assert.notEqual(r.code,0,`invalid accepted: ${JSON.stringify(request)}`);
    noHTTP(r);
    const error=JSON.parse(r.stderr);
    assert.equal(error.success,false);
    assert.notEqual(error.code,'UNKNOWN_ERROR',`untyped failure: ${r.stderr}`);
  }
});
test('compiled caller input: pending native stdin SIGINT has owned130 and zero dispatch',async()=>{
  const state=await sandbox();
  const r=await bin(state,undefined,{rawArgs:['investigate','--caller-request','-','--provider','tavily'],stdin:'{"schemaVersion":1,',signalEvent:'stdin-read-started',env:{REVIEW_REFUSE_HTTP:'1'}});
  assert.equal(r.sent,true,'SIGINT fired only after actual stdin iterator starts');
  assert.equal(r.signal,null,'no raw signal death');
  assert.equal(r.code,130,r.stderr);
  noHTTP(r);
});
test('compiled native caller cancellation: no postabort dispatch, retained reference remains inspectable',async()=>{
  const state=await sandbox();
  const req={...start,requirements:{...contract,requirements:{csv:contract.requirements.csv}}};
  const r=await bin(state,req,{signalEvent:'api.typesafe.ai',env:{REVIEW_HANG_JUDGE:'1'}});
  assert.equal(r.sent,true,'actual native judge in-flight before SIGINT');
  assert.equal(r.signal,null);
  assert.equal(r.code,130,r.stderr);
  const abort=r.events.findIndex(e=>e.event==='native-abort');
  assert.ok(abort>=0,'native abort observed');
  assert.equal(r.events.slice(abort+1).filter(e=>e.url).length,0);
  // Either success-channel cancelled handoff or structured error may carry retained identity; no required output-channel preference.
  const data=JSON.parse(r.stdout || r.stderr);
  assert.ok(data.investigationRef,'cancelled known record reference returned');
  const inspect=await bin(state,{schemaVersion:1,operation:'inspect',investigationRef:data.investigationRef},{env:{REVIEW_REFUSE_HTTP:'1',TAVILY_API_KEY:'',TYPESAFE_API_KEY:'',SCOUTLINE_JUDGE_TRANSMIT:''}});
  noHTTP(inspect);
  assert.equal(output(inspect).investigationRef,data.investigationRef);
});
