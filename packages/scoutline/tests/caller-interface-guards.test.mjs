import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {createHash} from 'node:crypto';
import { api,sandbox,contract,content,bin,output,noHTTP,root } from './helpers/caller-review-harness.mjs';
const {executeCallerInvestigation:run}=await api();
const hash=s=>'sha256:'+createHash('sha256').update(s).digest('hex');
function localWorld() {
  const calls=[];
  return {calls,deps:{search:async q=>{calls.push(['search',q]);return [{url:'https://example.test/release',title:'ExampleApp release',rawContent:content}];},read:async url=>{calls.push(['read',url]);return content;},judge:null,now:()=>Date.now()}};
}
async function setup({secrets=[],representations=[],requirements=contract,maxChars=16384}={}) {
  const s=await sandbox(),w=localWorld();
  const options={storeRoot:s.env.SCOUTLINE_INVESTIGATIONS_DIR,deps:w.deps,secrets};
  const h=await run({schemaVersion:1,operation:'start',requirements,dataScope:'synthetic',representations,maxChars},options);
  return {s,w,options,h};
}
async function collection(h,c,options,maxChars=2048) {
  let cursor=h.cursors[c],text='',end=0,count,pages=[];
  for(let n=0;cursor;n++) {
    assert.ok(n<2000,'cursor must terminate');
    const p=await run({schemaVersion:1,operation:'inspect',investigationRef:h.investigationRef,revision:h.revision,collection:c,cursor,maxChars},options);
    assert.ok(JSON.stringify(p).length<=maxChars,'whole serialized collection page bound');
    assert.equal(p.range[0],end,'no skip/duplicate metadata chars');end=p.range[1];
    assert.equal(p.content.length,end-p.range[0]);
    count=p.count;text+=p.content;pages.push(p);cursor=p.cursor;
    if(!cursor)assert.equal(end,p.totalChars);
  }
  const items=JSON.parse(text);
  assert.equal(items.length,count);assert.equal(items.length,h.counts[c]);
  return {items,pages,text};
}
async function body(h,e,options,maxChars=2048) {
  let cursor,all='',end=0,pages=[];
  do {
    const p=await run({schemaVersion:1,operation:'readEvidence',investigationRef:h.investigationRef,revision:h.revision,representationId:e.representationId,digest:e.digest,maxChars,...(cursor?{cursor}:{})},options);
    assert.ok(JSON.stringify(p).length<=maxChars,'whole serialized evidence page bound');
    assert.equal(p.range[0],end);end=p.range[1];all+=p.content;pages.push(p);cursor=p.cursor;
    if(!cursor)assert.equal(end,p.totalChars);
  } while(cursor);
  assert.equal(hash(all),e.digest,'accessible derivative hash exact across pages');
  return {all,pages};
}
test('I01 whole-body and metadata redaction before bounded paging, complete inventory',async()=>{
  const secret='synthetic-split-private-key-0123456789';
  const source='a'.repeat(490)+secret+' visible version 2.4.0. '+'z'.repeat(6000)+secret;
  const {h,options,w}=await setup({secrets:[secret],representations:[{format:'text',content:source,label:'q'.repeat(1500)+secret,claimedSource:'https://example.test/'+secret}]});
  const before=w.calls.length;
  const manifest=await collection(h,'evidence',options);
  const e=manifest.items.find(e=>e.displayRedacted);
  assert.ok(e,'redacted supplied evidence manifested');
  const b=await body(h,e,options);
  assert.ok(b.pages.length>1);assert.equal(b.all,source.replaceAll(secret,'[REDACTED]'));
  for(const c of Object.keys(h.counts)) {
    const result=await collection(h,c,options);
    assert.ok(!result.text.includes(secret),`metadata secret leaked in ${c}`);
    for(const p of result.pages) assert.ok(!JSON.stringify(p).includes(secret));
  }
  assert.equal(w.calls.length,before,'offline pages never acquire/judge');
});
test('I02 unique visible derivative quote maps after redaction; markers/altered bindings reject before work',async()=>{
  const secret='synthetic-original-only-key';
  const source=`hidden ${secret}; ExampleApp unique version 2.4.0.`;
  const {h,options,w}=await setup({secrets:[secret],representations:[{format:'text',content:source}]});
  const e=(await collection(h,'evidence',options)).items.find(e=>e.displayRedacted);
  const display=(await body(h,e,options)).all;
  const quote='ExampleApp unique version 2.4.0.',a=display.indexOf(quote);
  const base={schemaVersion:1,operation:'continue',investigationRef:h.investigationRef,expectedRevision:h.revision,dataScope:'synthetic',proposals:[{requirementId:'version',definitionRevision:h.definitions.version,mode:'string',value:'2.4.0',binding:{representationId:e.representationId,digest:e.digest,range:[a,a+quote.length],quote}}]};
  const before=w.calls.length;
  for(const override of [{digest:'sha256:'+'0'.repeat(64)},{quote:'altered'},{range:[0,8],quote:'hidden ['},{range:[display.indexOf('[REDACTED]'),display.indexOf('[REDACTED]')+10],quote:'[REDACTED]'}]) {
    const req=structuredClone(base);Object.assign(req.proposals[0].binding,override);
    await assert.rejects(run(req,options));assert.equal(w.calls.length,before,'invalid binding triggered work');
  }
  const next=await run(base,options);assert.equal(next.revision,h.revision+1);
  const proposals=(await collection(next,'proposals',options)).items;
  const p=proposals.find(p=>p.fieldId==='version');
  assert.deepEqual(p.charRange,[source.indexOf(quote),source.indexOf(quote)+quote.length]);
  assert.equal(p.quote,quote);assert.equal(p.digest,e.originalDigest);
});
test('I03 changed secret basis invalidates old derivative/cursor without page mixing',async()=>{
  const source='a'.repeat(3000)+'new-configured-secret'+'b'.repeat(3000);
  const {h,options,w}=await setup({representations:[{format:'text',content:source}]});
  const e=(await collection(h,'evidence',options)).items.find(e=>e.contentLength===source.length);
  const p=await run({schemaVersion:1,operation:'readEvidence',investigationRef:h.investigationRef,representationId:e.representationId,digest:e.digest,maxChars:1024},options);
  assert.ok(p.cursor);
  const before=w.calls.length,newOptions={...options,secrets:['new-configured-secret']};
  await assert.rejects(run({schemaVersion:1,operation:'readEvidence',investigationRef:h.investigationRef,representationId:e.representationId,digest:e.digest,cursor:p.cursor,maxChars:1024},newOptions));
  await assert.rejects(run({schemaVersion:1,operation:'inspect',investigationRef:h.investigationRef,cursor:h.cursors.evidence,maxChars:1024},newOptions));
  const next=await run({schemaVersion:1,operation:'inspect',investigationRef:h.investigationRef},newOptions);
  assert.notEqual(next.redactionBasis,h.redactionBasis);
  const newE=(await collection(next,'evidence',newOptions)).items.find(e=>e.displayRedacted);
  assert.notEqual(newE.representationId,e.representationId);
  assert.ok(!(await body(next,newE,newOptions)).all.includes('new-configured-secret'));
  assert.equal(w.calls.length,before);
});
test('I04 historical complete result pages persist, current cursors stale after revision',async()=>{
  const {h,options}=await setup();
  const oldOutcomes=(await collection(h,'outcomes',options)).items;
  const next=await run({schemaVersion:1,operation:'continue',investigationRef:h.investigationRef,expectedRevision:h.revision,dataScope:'synthetic',requirements:{...contract,scope:{...contract.scope,release:'3.0.0'}}},options);
  assert.equal(next.revision,h.revision+1);
  await assert.rejects(run({schemaVersion:1,operation:'inspect',investigationRef:h.investigationRef,cursor:h.cursors.outcomes,maxChars:1024},options));
  const historic=await run({schemaVersion:1,operation:'inspect',investigationRef:h.investigationRef,revision:h.revision},options);
  assert.equal(historic.revision,h.revision);assert.equal(historic.committedRevision,next.revision);
  assert.deepEqual(historic.definitions,h.definitions);
  assert.deepEqual((await collection(historic,'outcomes',options)).items,oldOutcomes);
  const rounds=(await collection(next,'rounds',options)).items;
  assert.ok(rounds.some(r=>r.resultAccess.revision===h.revision),'historical result access manifested');
});
test('I05 supported 4096 header fits and assessments paging retains the exact physical ledger offline',async()=>{
  const requirements={...contract,requirements:Object.fromEntries(['a'.repeat(64),'b'.repeat(64),'c'.repeat(64)].map((id,i)=>[id,{question:`Which audit value ${i}?`,schema:{type:'string'}}]))};
  const s=await sandbox();
  const request={schemaVersion:1,operation:'start',requirements,dataScope:'synthetic',maxChars:4096};
  // Audit witness stimulus: exact retried-read preload clone (REVIEW_RETRIED_READ), no judge
  // configured — synthetic acquisition key only, judge selection disabled (unset, not empty).
  const result=await bin(s,request,{env:{REVIEW_RETRIED_READ:'1',TYPESAFE_API_KEY:undefined,SCOUTLINE_JUDGE_TRANSMIT:undefined}});
  const dispatches=result.events.filter(e=>e.url).length;
  assert.equal(dispatches,38,'exact audit witness dispatch trace');
  assert.ok(result.stdout,`committed bounded handoff must be delivered, not a bare validation error: ${result.stderr}`);
  assert.equal(result.code,1,`partial no-judge round settles exit 1, not 0: ${result.stderr}`);
  const header=JSON.parse(result.stdout);
  assert.equal(header.kind,'caller-assisted-investigation');
  assert.equal(header.status,'partial');assert.equal(header.stopReason,'no-judge-evidence-retained');
  assert.ok(header.investigationRef,'bounded handoff retains committed reference');
  assert.equal(header.revision,1);
  assert.ok(JSON.stringify(header).length<=4096,'serialized header fits maxChars character bound');
  assert.ok(!Array.isArray(header.physical.attempts),'summary never embeds full attempt rows');
  assert.equal(header.physical.stages.acquisition,38);assert.equal(header.physical.total,38);
  assert.equal(header.physical.detail,'summary');assert.equal(header.physical.detailLocation,'assessments');
  assert.equal(header.physical.detailIncomplete,true,'omitted attempt rows cannot read as complete snapshot');
  const offlineEnv={REVIEW_REFUSE_HTTP:'1',TAVILY_API_KEY:undefined,TYPESAFE_API_KEY:undefined,SCOUTLINE_JUDGE_TRANSMIT:undefined};
  const inspected=await bin(s,{schemaVersion:1,operation:'inspect',investigationRef:header.investigationRef,collection:'assessments',maxChars:16384},{env:offlineEnv});
  assert.equal(inspected.code,0,inspected.stderr);noHTTP(inspected);
  const assessments=JSON.parse(output(inspected).content);
  assert.equal(assessments.length,1);
  const snapshot=assessments[0].physical;
  assert.equal(snapshot.schemaVersion,1);assert.equal(snapshot.source,'handler-owned-native-ledger');assert.equal(snapshot.cutoff,'locally-settled');
  assert.equal(snapshot.attempts.length,38,'full persisted ledger intact');
  const traceUrls=result.events.filter(e=>e.url);
  assert.equal(snapshot.stages.acquisition,traceUrls.length,'stored count equals native trace dispatches');
  assert.equal(snapshot.attempts.filter(a=>a.phase==='acquisition').length,traceUrls.length,'one ledger row per actual dispatch');
  assert.equal(snapshot.total,38);assert.deepEqual(Object.keys(snapshot).sort(),['admission','attempts','cutoff','knownSubtotal','reservationsRefused','schemaVersion','source','stages','total']);
  // Raw-storage parity (public dist API, no local projection replica): the
  // paged assessments snapshot must be deep-equal to the raw stored
  // record.payload.physical, and that stored snapshot must pass the actual
  // CallerPhysicalSnapshot validator.
  const {readCallerRecord}=await import(pathToFileURL(join(root,'dist/lib/lean-caller-rounds.js')));
  const {validateCallerPhysical}=await import(pathToFileURL(join(root,'dist/lib/caller-physical.js')));
  const raw=await readCallerRecord(s.env.SCOUTLINE_INVESTIGATIONS_DIR,header.investigationRef);
  validateCallerPhysical(raw.payload.physical);
  assert.deepEqual(snapshot,raw.payload.physical,'paged full snapshot deep-equals raw stored ledger');
  // Historical revision: safe continue to revision 2, then inspect revision 1
  // offline — its recovered full ledger must still equal the original 38.
  const cont=await bin(s,{schemaVersion:1,operation:'continue',investigationRef:header.investigationRef,expectedRevision:1,requirements,dataScope:'synthetic',maxChars:4096},{env:{REVIEW_RETRIED_READ:'1',TYPESAFE_API_KEY:undefined,SCOUTLINE_JUDGE_TRANSMIT:undefined}});
  assert.equal(cont.code,1,cont.stderr);
  const h2=JSON.parse(cont.stdout);
  assert.equal(h2.revision,2,'continuation committed revision 2');
  const hist=await bin(s,{schemaVersion:1,operation:'inspect',investigationRef:header.investigationRef,revision:1,collection:'assessments',maxChars:16384},{env:offlineEnv});
  assert.equal(hist.code,0,hist.stderr);noHTTP(hist);
  const histAssessments=JSON.parse(output(hist).content);
  assert.deepEqual(histAssessments[0].physical,snapshot,'historical revision retains the exact original full ledger');
  // One-field control: same stimulus, 1 field — 30 dispatches, same compact contract.
  const s1=await sandbox();
  const oneField={...request,requirements:{...contract,requirements:Object.fromEntries(['a'.repeat(64)].map((id)=>[id,{question:'Which audit value 0?',schema:{type:'string'}}]))}};
  const r1=await bin(s1,oneField,{env:{REVIEW_RETRIED_READ:'1',TYPESAFE_API_KEY:undefined,SCOUTLINE_JUDGE_TRANSMIT:undefined}});
  assert.equal(r1.events.filter(e=>e.url).length,30,'one-field witness dispatch trace');
  assert.equal(r1.code,1,r1.stderr);
  const h1=JSON.parse(r1.stdout);
  assert.ok(h1.investigationRef);assert.ok(JSON.stringify(h1).length<=4096);
  assert.equal(h1.physical.stages.acquisition,30);assert.equal(h1.physical.total,30);
  assert.equal(h1.physical.detailIncomplete,true);
});
test('I06 delete active ownership denied; safe-owned delete; missing ref typed',async()=>{
  const {h,options}=await setup();
  const {openStore}=await import('./../dist/lib/retained-record-store.js');
  const store=openStore({root:options.storeRoot});
  const owner=await store.acquireOwnership(h.investigationRef);
  try {await assert.rejects(run({schemaVersion:1,operation:'delete',investigationRef:h.investigationRef},{storeRoot:options.storeRoot}),e=>e.code==='OWNER_BUSY');}
  finally {await owner.release();}
  const deleted=await run({schemaVersion:1,operation:'delete',investigationRef:h.investigationRef},{storeRoot:options.storeRoot});
  assert.equal(deleted.deleted,true);
  await assert.rejects(run({schemaVersion:1,operation:'inspect',investigationRef:h.investigationRef},{storeRoot:options.storeRoot}),e=>typeof e.code==='string');
});
