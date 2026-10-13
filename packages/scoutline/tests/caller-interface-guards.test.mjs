import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import { api,sandbox,contract,content } from './helpers/caller-review-harness.mjs';
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
test('I05 variable header actually fits prework or rejects before dispatch',async()=>{
  const w=localWorld(),s=await sandbox();
  const requirements={...contract,requirements:{['long-field-'.repeat(1800)]:{question:'Which exact release?',schema:{type:'string'}}}};
  await assert.rejects(run({schemaVersion:1,operation:'start',requirements,dataScope:'synthetic',maxChars:4096},{storeRoot:s.env.SCOUTLINE_INVESTIGATIONS_DIR,deps:w.deps}));
  assert.equal(w.calls.length,0,'minimum header refused only after paid work');
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
