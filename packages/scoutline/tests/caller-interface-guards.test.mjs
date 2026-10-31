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
  const base={schemaVersion:1,operation:'continue',investigationRef:h.investigationRef,expectedRevision:h.revision,dataScope:'synthetic',proposals:[{requirementId:'version',definitionRevision:(await collection(h,'changes',options)).items[0].definitions.version,mode:'string',value:'2.4.0',binding:{representationId:e.representationId,digest:e.digest,range:[a,a+quote.length],quote}}]};
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
  const p=await run({schemaVersion:1,operation:'readEvidence',investigationRef:h.investigationRef,representationId:e.representationId,digest:e.digest,maxChars:2048},options);
  assert.ok(p.cursor);
  const before=w.calls.length,newOptions={...options,secrets:['new-configured-secret']};
  await assert.rejects(run({schemaVersion:1,operation:'readEvidence',investigationRef:h.investigationRef,representationId:e.representationId,digest:e.digest,cursor:p.cursor,maxChars:2048},newOptions),{name:'ValidationError',code:'VALIDATION_ERROR',message:'Accessible derivative or evidence event unavailable or stale.'});
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
  const oldDefinitions=(await collection(h,'changes',options)).items[0].definitions;
  const next=await run({schemaVersion:1,operation:'continue',investigationRef:h.investigationRef,expectedRevision:h.revision,dataScope:'synthetic',requirements:{...contract,scope:{...contract.scope,release:'3.0.0'}}},options);
  assert.equal(next.revision,h.revision+1);
  await assert.rejects(run({schemaVersion:1,operation:'inspect',investigationRef:h.investigationRef,cursor:h.cursors.outcomes,maxChars:1024},options));
  const historic=await run({schemaVersion:1,operation:'inspect',investigationRef:h.investigationRef,revision:h.revision},options);
  assert.equal(historic.revision,h.revision);assert.equal(historic.committedRevision,next.revision);
  assert.deepEqual((await collection(historic,'changes',options)).items[0].definitions,oldDefinitions);
  assert.deepEqual((await collection(historic,'outcomes',options)).items,oldOutcomes);
  const rounds=(await collection(next,'rounds',options)).items;
  assert.ok(rounds.some(r=>r.resultAccess.revision===h.revision),'historical result access manifested');
});
test('I05 supported 8192 header fits and assessments paging retains the exact physical ledger offline',async()=>{
  const requirements={...contract,requirements:Object.fromEntries(['a'.repeat(64),'b'.repeat(64),'c'.repeat(64)].map((id,i)=>[id,{question:`Which audit value ${i}?`,schema:{type:'string'}}]))};
  const s=await sandbox();
  const request={schemaVersion:1,operation:'start',requirements,dataScope:'synthetic',maxChars:8192};
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
  assert.ok(JSON.stringify(header).length<=8192,'serialized header fits maxChars character bound');
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
  const cont=await bin(s,{schemaVersion:1,operation:'continue',investigationRef:header.investigationRef,expectedRevision:1,requirements,dataScope:'synthetic',maxChars:8192},{env:{REVIEW_RETRIED_READ:'1',TYPESAFE_API_KEY:undefined,SCOUTLINE_JUDGE_TRANSMIT:undefined}});
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
  assert.ok(h1.investigationRef);assert.ok(JSON.stringify(h1).length<=8192);
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

// Review repair controls append to the exact retained test prefix.
async function repairP1World(source,secrets=[]) {
  const requirements={schemaVersion:1,question:'Value?',requirements:{value:{question:'Value?',schema:{type:'string'}}},limits:{maxSearchAttempts:1,maxUniqueReads:1,maxJudgeAttempts:1}};
  const x=await setup({requirements,secrets,representations:[{format:'text',content:source,label:'P1 supplied'}]});
  const e=(await collection(x.h,'evidence',x.options)).items.find(e=>e.title==='P1 supplied');assert(e);
  const definitions=(await collection(x.h,'changes',x.options)).items[0].definitions;
  return {...x,e,definitions};
}
async function repairP1Submit(x,range,quote) {
  const {readCallerRecord}=await import('../dist/lib/lean-caller-rounds.js');
  const before=await readCallerRecord(x.options.storeRoot,x.h.investigationRef),calls=x.w.calls.length;
  const request={schemaVersion:1,operation:'continue',investigationRef:x.h.investigationRef,expectedRevision:x.h.revision,dataScope:'synthetic',proposals:[{requirementId:'value',definitionRevision:x.definitions.value,mode:'string',value:quote,binding:{representationId:x.e.representationId,digest:x.e.digest,evidenceId:x.e.evidenceId,range,quote}}]};
  let error;try{await run(request,x.options);}catch(e){error=e;}
  const after=await readCallerRecord(x.options.storeRoot,x.h.investigationRef);
  return {error,before,after,callsBefore:calls,callsAfter:x.w.calls.length};
}
test('review P1 selected marker interval refuses before retained mutation',async()=>{
  const source='hidden alpha-secret; RED',x=await repairP1World(source,['alpha-secret']);
  const display=(await body(x.h,x.e,x.options)).all;assert.equal(display,'hidden [REDACTED]; RED');assert.equal(source.slice(21,24),'RED');
  const r=await repairP1Submit(x,[8,11],'RED');
  console.log(JSON.stringify({case:'P1 marker-fragment',selectedDisplay:[8,11],coincidentalOriginal:[21,24],error:r.error?.code,beforeRevision:r.before.revision,afterRevision:r.after.revision,beforeRounds:r.before.snapshot.rounds.length,afterRounds:r.after.snapshot.rounds.length,proposals:r.after.payload.proposals.length,workDelta:r.callsAfter-r.callsBefore}));
  assert.equal(r.error?.code,'VALIDATION_ERROR','selected marker fragment must reject, never substitute the other original occurrence');
  assert.equal(r.after.revision,r.before.revision);assert.deepEqual(r.after.payload,r.before.payload);assert.equal(r.callsAfter,r.callsBefore);
  const {redactSecrets}=await import('../dist/lib/redact.js');
  for(const row of [
    {source:'literal [REDACTED]; RED',secrets:[],a:9,b:12},
    {source:'hidden alpha-secret; RED',secrets:['alpha-secret'],a:15,b:21},
    {source:'hidden alpha-secret; RED',secrets:['alpha-secret','ACTED]; '],pick:'first'},
    {source:'hidden alpha-secret; RED RED',secrets:['alpha-secret'],pick:'last'},
  ]){
    const y=await repairP1World(row.source,row.secrets),display=redactSecrets(row.source,row.secrets),a=row.a??(row.pick==='last'?display.lastIndexOf('RED'):display.indexOf('RED')),b=row.b??a+3;
    const got=await repairP1Submit(y,[a,b],display.slice(a,b));assert.equal(got.error?.code,'VALIDATION_ERROR');assert.equal(got.after.revision,got.before.revision);assert.deepEqual(got.after.payload,got.before.payload);assert.equal(got.callsAfter,got.callsBefore);
  }
  for(const row of [{source:'RED RED',secrets:[],quote:'RED',a:4},{source:'hidden alpha-secret; GREEN',secrets:['alpha-secret'],quote:'GREEN'}]){
    const y=await repairP1World(row.source,row.secrets),display=redactSecrets(row.source,row.secrets),a=row.a??display.indexOf(row.quote),got=await repairP1Submit(y,[a,a+row.quote.length],row.quote);
    assert.equal(got.error,undefined);assert.equal(got.after.revision,got.before.revision+1);const p=got.after.payload.proposals[0];assert.equal(p.evidenceId,y.e.evidenceId);assert.deepEqual(p.charRange,[row.source.lastIndexOf(row.quote),row.source.lastIndexOf(row.quote)+row.quote.length]);
  }
});

async function repairP2World(id='value',secrets=[]) {
  const s=await sandbox(),w=localWorld(),requirements={schemaVersion:1,question:'Value?',requirements:{[id]:{question:'Value? ordinary-synthetic-secret Authorization: Bearer Key-12345678',schema:{type:'string'}}},limits:{maxSearchAttempts:1,maxUniqueReads:3,maxJudgeAttempts:1}};
  const options={storeRoot:s.env.SCOUTLINE_INVESTIGATIONS_DIR,deps:w.deps,secrets};
  const h=await run({schemaVersion:1,operation:'start',requirements,dataScope:'synthetic',roundLimits:{maxUniqueReads:1},representations:[{format:'text',content:'Value 2.4.0.',label:'P2 supplied'}]},options);
  return {s,w,options,h,requirements};
}
async function repairInvoke(behavior,secrets=[]) {
  const {invokeCommand}=await import('../dist/command-invocation.js'),stdout=[],stderr=[];let error,page;
  const adapter={stdoutIsTTY:false,stdinIsTTY:false,readStdin:async()=>'',writeStdout:x=>stdout.push(x),writeStderr:x=>stderr.push(x),runQuietly:async fn=>fn(),setExitCode:()=>{}};
  const code=await invokeCommand(adapter,async()=>{try{page=await behavior();return {kind:'data',data:page};}catch(e){error=e;throw e;}},'data',()=>0,secrets);
  return {code,stdout:stdout.join(''),stderr:stderr.join(''),error,page};
}
test('review P2 declared ID maps retain usable public proof and complete contract',async()=>{
  const {readCallerRecord}=await import('../dist/lib/lean-caller-rounds.js'),{redactSecrets}=await import('../dist/lib/redact.js');
  for(const id of ['token','authorization','api_key']){
    const x=await repairP2World(id,['ordinary-synthetic-secret']),raw=await readCallerRecord(x.options.storeRoot,x.h.investigationRef),changed=(await collection(x.h,'changes',x.options)).items[0];
    assert.equal(changed.definitions[id],raw.payload.definitions[id],'declared credential-shaped ID must disclose its original usable proof');
    assert.deepEqual(changed.contract.requirements[id],redactSecrets(raw.contract.requirements[id],x.options.secrets));assert.deepEqual(changed.baselineContract.requirements[id],redactSecrets(raw.baselineContract.requirements[id],x.options.secrets));
    assert.equal(changed.contract.limits.maxUniqueReads,1);assert.equal(changed.baselineContract.limits.maxUniqueReads,3);
    const {revision,intent,...block}=changed;assert.equal(hash(JSON.stringify(block)),x.h.definitionViewId);assert(!JSON.stringify(changed).includes('ordinary-synthetic-secret'));assert(!JSON.stringify(changed).includes('Key-12345678'));
    const formatted=await repairInvoke(()=>run({schemaVersion:1,operation:'inspect',investigationRef:x.h.investigationRef,collection:'changes',maxChars:65536},x.options),x.options.secrets);
    assert.equal(formatted.code,0);assert.deepEqual(JSON.parse(formatted.stdout),formatted.page,'actual formatter must preserve the completed page');
    const manifest=(await collection(x.h,'evidence',x.options)).items,e=manifest.find(e=>e.title==='P2 supplied');assert(e);
    const next=await run({schemaVersion:1,operation:'continue',investigationRef:x.h.investigationRef,expectedRevision:x.h.revision,dataScope:'synthetic',proposals:[{requirementId:id,definitionRevision:changed.definitions[id],mode:'string',value:'2.4.0',binding:{representationId:e.representationId,digest:e.digest,evidenceId:e.evidenceId,range:[0,12],quote:'Value 2.4.0.'}}]},x.options);
    const saved=await readCallerRecord(x.options.storeRoot,x.h.investigationRef);assert.equal(saved.payload.proposals[0].definitionRevision,changed.definitions[id]);assert.equal(saved.payload.proposals[0].evidenceId,e.evidenceId);assert.equal(next.revision,2);
    const historical=await run({schemaVersion:1,operation:'inspect',investigationRef:x.h.investigationRef,revision:1},x.options),old=(await collection(historical,'changes',x.options)).items[0];assert.equal(old.definitions[id],raw.payload.definitions[id]);assert.equal(Object.hasOwn(old,'baselineContract'),false);
  }
});
test('review P2 colliding submitted raw proof cannot bypass active-profile unavailability',async()=>{
  const {readCallerRecord}=await import('../dist/lib/lean-caller-rounds.js'),x=await repairP2World(),raw=await readCallerRecord(x.options.storeRoot,x.h.investigationRef),proof=raw.payload.definitions.value;
  const options={...x.options,secrets:[proof]},h=await run({schemaVersion:1,operation:'inspect',investigationRef:x.h.investigationRef},options),changes=(await collection(h,'changes',options)).items[0];assert.equal(changes.definitions.value,'[REDACTED]');
  const e=(await collection(h,'evidence',options)).items.find(e=>e.title==='P2 supplied');assert(e);
  for(const submitted of [proof,changes.definitions.value,'sha256:'+'0'.repeat(64)]){
    const before=await readCallerRecord(options.storeRoot,h.investigationRef),calls=x.w.calls.length;let error;
    try{await run({schemaVersion:1,operation:'continue',investigationRef:h.investigationRef,expectedRevision:h.revision,dataScope:'synthetic',proposals:[{requirementId:'value',definitionRevision:submitted,mode:'string',value:'2.4.0',binding:{representationId:e.representationId,digest:e.digest,evidenceId:e.evidenceId,range:[0,12],quote:'Value 2.4.0.'}}]},options);}catch(e){error=e;}
    const after=await readCallerRecord(options.storeRoot,h.investigationRef);console.log(JSON.stringify({case:'P2 proof collision',submission:submitted===proof?'raw':submitted==='[REDACTED]'?'displayed':'wrong-clean',error:error?.code,before:before.revision,after:after.revision,workDelta:x.w.calls.length-calls}));
    assert.equal(error?.code,'VALIDATION_ERROR','known raw proof must not bypass active-profile scalar secrecy');assert(!error.message.includes(proof));assert.equal(after.revision,before.revision);assert.deepEqual(after.payload,before.payload);assert.equal(x.w.calls.length,calls);
  }
});
test('review P2 identity and dependency profile collisions refuse before mutation',async()=>{
  const s=await sandbox(),w=localWorld(),id='privateField',requirements={schemaVersion:1,question:'Value?',requirements:{[id]:{question:'Value?',schema:{type:'string'}},dependent:{question:'Dependent?',schema:{type:'string'},dependsOn:[id]}}},options={storeRoot:s.env.SCOUTLINE_INVESTIGATIONS_DIR,deps:w.deps,secrets:[id]};let error,h;
  try{h=await run({schemaVersion:1,operation:'start',requirements,dataScope:'synthetic'},options);}catch(e){error=e;}
  console.log(JSON.stringify({case:'P2 identity collision',error:error?.code,created:!!h,work:w.calls.length}));assert.equal(error?.code,'VALIDATION_ERROR','identity scalar collision must refuse before creating or dispatching');assert.equal(h,undefined);assert.equal(w.calls.length,0);assert(!error.message.includes(id));
  const x=await repairP2World(),{readCallerRecord}=await import('../dist/lib/lean-caller-rounds.js'),before=await readCallerRecord(x.options.storeRoot,x.h.investigationRef),calls=x.w.calls.length;
  const colliding={...x.options,secrets:['value']};await assert.rejects(run({schemaVersion:1,operation:'inspect',investigationRef:x.h.investigationRef},colliding),e=>e.code==='VALIDATION_ERROR');
  await assert.rejects(run({schemaVersion:1,operation:'continue',investigationRef:x.h.investigationRef,expectedRevision:x.h.revision,dataScope:'synthetic'},colliding),e=>e.code==='VALIDATION_ERROR');
  await assert.rejects(run({schemaVersion:1,operation:'continue',investigationRef:x.h.investigationRef,expectedRevision:x.h.revision,dataScope:'synthetic',requirements}, {...x.options,secrets:[id]}),e=>e.code==='VALIDATION_ERROR');
  assert.deepEqual((await readCallerRecord(x.options.storeRoot,x.h.investigationRef)).payload,before.payload);assert.equal(x.w.calls.length,calls);assert.equal((await run({schemaVersion:1,operation:'inspect',investigationRef:x.h.investigationRef},x.options)).revision,1);
});
test('review P2 actual completed pages are fixed points through existing invocation formatter',async()=>{
  const s=await sandbox(),w=localWorld(),options={storeRoot:s.env.SCOUTLINE_INVESTIGATIONS_DIR,deps:w.deps,secrets:[]},requirements={schemaVersion:1,question:'What ED value?',requirements:{value:{question:'Which ED value?',schema:{type:'string'}}}};
  const h=await run({schemaVersion:1,operation:'start',requirements,dataScope:'synthetic',representations:[{format:'text',content:'Value ED 2.4.0.',label:'P2 page'}]},options),calls=w.calls.length,active={...options,secrets:['ED']};
  const unavailable=e=>e?.name==='ValidationError'&&e.code==='VALIDATION_ERROR'&&e.message==='Caller view unavailable under the active redaction profile.';
  const checked=r=>{if(r.error){assert(unavailable(r.error));assert.equal(r.stdout,'');assert.notEqual(r.code,0);}else{assert.equal(r.code,0);assert.deepEqual(JSON.parse(r.stdout),r.page,'existing formatter must not rewrite a successful page with stale identity/hash/range');const {resultSha256,...value}=r.page;assert.equal(resultSha256,hash(JSON.stringify(value)));}};
  const r=await repairInvoke(()=>run({schemaVersion:1,operation:'inspect',investigationRef:h.investigationRef,collection:'changes',maxChars:2048},active),active.secrets);checked(r);assert.equal(w.calls.length,calls);
  const manifest=(await collection(h,'evidence',options)).items,e=manifest.find(e=>e.title==='P2 page');assert(e);
  const requests=[
    {schemaVersion:1,operation:'readEvidence',investigationRef:h.investigationRef,representationId:e.representationId,digest:e.digest,evidenceId:e.evidenceId,maxChars:2048},
    {schemaVersion:1,operation:'readEvidence',investigationRef:h.investigationRef,representationId:e.representationId,digest:e.digest,evidenceId:e.evidenceId,range:[0,15],maxChars:2048},
  ];
  for(const request of requests){
    const out=await repairInvoke(()=>run(request,options),options.secrets);assert.equal(out.error,undefined);checked(out);assert.equal(out.page.evidenceId,e.evidenceId);assert.equal(out.page.content,'Value ED 2.4.0.');assert.deepEqual(out.page.range,[0,15]);assert.equal(out.page.digest,hash('Value ED 2.4.0.'));assert.equal(out.page.contentIncomplete,false);
  }
  // Actual active metadata is a prerequisite, never a fabricated/stale selector.
  const underProfile=await repairInvoke(()=>run({schemaVersion:1,operation:'inspect',investigationRef:h.investigationRef,collection:'evidence',maxChars:65536},active),active.secrets);checked(underProfile);
  let unsafeEvidenceRangeReached=0;
  if(!underProfile.error){
    const item=JSON.parse(underProfile.page.content).find(e=>e.title==='P2 page');assert(item);
    for(const request of requests){const out=await repairInvoke(()=>run({...request,representationId:item.representationId,digest:item.digest,evidenceId:item.evidenceId},active),active.secrets);unsafeEvidenceRangeReached++;checked(out);}
  }
  console.log(JSON.stringify({case:'P2 completed-page reach',normalEvidenceAndRange:2,unsafeManifestUnavailable:!!underProfile.error,unsafeEvidenceRangeReached,unsafeEvidenceRangeUnreached:!!underProfile.error}));
  await assert.rejects(run({schemaVersion:1,operation:'inspect',investigationRef:h.investigationRef},{...options,secrets:['sha256:']}),unavailable,'actual computed digest collision is exact typed unavailability');assert.equal(w.calls.length,calls);
});

test('PR291 E forged pinned cursor cannot start inside surrogate pair',async()=>{
  const x=await repairP1World('a😀b'),request={schemaVersion:1,operation:'readEvidence',investigationRef:x.h.investigationRef,representationId:x.e.representationId,evidenceId:x.e.evidenceId,digest:x.e.digest,maxChars:2048};
  const cursor=Buffer.from(JSON.stringify({v:1,r:x.h.committedRevision,h:x.h.revision,b:x.h.redactionBasis,c:x.e.representationId,d:x.e.digest,e:x.e.evidenceId,o:2})).toString('base64url');
  await assert.rejects(run({...request,cursor},x.options),e=>e.code==='VALIDATION_ERROR'&&e.message==='Cursor offset splits a surrogate-pair character.');
});
test('PR291 E oversized displayed tail binding refuses before lower round',async()=>{
  const x=await repairP1World('hidden alpha-secret; GREEN',['alpha-secret']),display=(await body(x.h,x.e,x.options)).all,a=display.indexOf('GREEN');
  const r=await repairP1Submit(x,[a,display.length+1],'GREEN');
  assert.equal(r.error?.code,'VALIDATION_ERROR');assert.equal(r.error?.message,'Display quote/range does not bind unchanged evidence.');
  assert.equal(r.callsAfter,r.callsBefore);assert.deepEqual(r.after,r.before);
});

test('PR291 compatibility E adjacent surrogate offsets, exact end and metadata boundary',async()=>{
  const x=await repairP1World('a😀b'),base={schemaVersion:1,operation:'readEvidence',investigationRef:x.h.investigationRef,representationId:x.e.representationId,evidenceId:x.e.evidenceId,digest:x.e.digest,maxChars:2048};
  for(const [o,content] of [[1,'😀b'],[3,'b'],[4,'']]){const cursor=Buffer.from(JSON.stringify({v:1,r:x.h.committedRevision,h:x.h.revision,b:x.h.redactionBasis,c:x.e.representationId,d:x.e.digest,e:x.e.evidenceId,o})).toString('base64url'),p=await run({...base,cursor},x.options);assert.equal(p.content,content);assert.deepEqual(p.range,[o,4]);assert.equal(p.cursor,null);}
  assert.equal((await run({...base,range:[0,4]},x.options)).content,'a😀b');
  const y=await setup({requirements:{schemaVersion:1,question:'metadata 😀 question',requirements:{value:{question:'Value?',schema:{type:'string'}}}}}),text=(await collection(y.h,'changes',y.options)).text,o=text.indexOf('😀')+1;assert(o>0);
  const cursor=Buffer.from(JSON.stringify({v:1,r:y.h.committedRevision,h:y.h.revision,b:y.h.redactionBasis,c:'changes',o})).toString('base64url');await assert.rejects(run({schemaVersion:1,operation:'inspect',investigationRef:y.h.investigationRef,collection:'changes',cursor},y.options),e=>e.code==='VALIDATION_ERROR'&&e.message==='Cursor offset splits a surrogate-pair character.');
  const z=await repairP1World('hidden alpha-secret; GREEN',['alpha-secret']),display=(await body(z.h,z.e,z.options)).all,a=display.indexOf('GREEN'),r=await repairP1Submit(z,[a,display.length],'GREEN');assert.equal(r.error,undefined);assert.equal(r.after.revision,r.before.revision+1);
});


async function deletePreflightCase(profile) {
  const {rm}=await import('node:fs/promises');
  const {readCallerRecord}=await import('../dist/lib/lean-caller-rounds.js');
  const s=await sandbox(),w=localWorld(),options={storeRoot:s.env.SCOUTLINE_INVESTIGATIONS_DIR,deps:w.deps,secrets:[]};
  try {
    const h=await run({schemaVersion:1,operation:'start',requirements:contract,dataScope:'synthetic'},options);
    const before=await readCallerRecord(options.storeRoot,h.investigationRef),callsBefore=w.calls.length;
    let response,error,after,readError;
    try {response=await run({schemaVersion:1,operation:'delete',investigationRef:h.investigationRef},{...options,secrets:profile(h)});} catch(e) {error=e;}
    try {after=await readCallerRecord(options.storeRoot,h.investigationRef);} catch(e) {readError=e;}
    const callsAfter=w.calls.length;
    console.log(JSON.stringify({case:'delete preflight',profile:profile.name,error:error?.code,message:error?.message,beforeRevision:before?.revision,afterRevision:after?.revision,afterAvailable:!!after,readError:readError?.code,callsBefore,callsAfter}));
    return {h,before,after,error,response,readError,callsBefore,callsAfter};
  } finally {await rm(s.path,{recursive:true,force:true});await rm(s.home,{recursive:true,force:true});}
}
test('PR291 delete refusal preserves record for colliding fixed kind',async()=>{
  const x=await deletePreflightCase(function fixedKind(){return ['caller'];});
  assert.equal(x.error?.name,'ValidationError');assert.equal(x.error?.code,'VALIDATION_ERROR');assert.equal(x.error?.message,'Caller view unavailable under the active redaction profile.');
  assert.ok(x.after,'existing retained record must survive refused acknowledgement');assert.equal(x.after.revision,x.before.revision);assert.deepEqual(x.after,x.before);assert.equal(x.callsAfter,x.callsBefore);
});
test('PR291 delete refusal preserves record for colliding reference',async()=>{
  const x=await deletePreflightCase(function reference(h){return [h.investigationRef];});
  assert.equal(x.error?.name,'ValidationError');assert.equal(x.error?.code,'VALIDATION_ERROR');assert.equal(x.error?.message,'Caller view unavailable under the active redaction profile.');
  assert.ok(x.after,'existing retained record must survive refused acknowledgement');assert.equal(x.after.revision,x.before.revision);assert.deepEqual(x.after,x.before);assert.equal(x.callsAfter,x.callsBefore);
});
test('PR291 delete acknowledgement follows actual successful deletion',async()=>{
  const x=await deletePreflightCase(function normal(){return [];});
  assert.equal(x.error,undefined);assert.deepEqual(x.response,{kind:'caller-assisted-investigation',schemaVersion:2,investigationRef:x.h.investigationRef,deleted:true});
  assert.equal(x.after,undefined);assert.ok(x.readError,'deleted retained record must be unavailable');assert.equal(x.callsAfter,x.callsBefore);
});

test('promotion A1 unsafe native reference profile refuses before work',async()=>{
  const {readdir}=await import('node:fs/promises');
  const {readCallerRecord}=await import('../dist/lib/lean-caller-rounds.js');
  const s=await sandbox(),w=localWorld(),storeRoot=s.env.SCOUTLINE_INVESTIGATIONS_DIR;
  let response,error;
  try {response=await run({schemaVersion:1,operation:'start',requirements:contract,dataScope:'synthetic'},{storeRoot,deps:w.deps,secrets:['inv_']});}catch(e){error=e;}
  const records=(await readdir(join(storeRoot,'investigations')).catch(e=>{if(e.code==='ENOENT')return [];throw e;})).filter(n=>/^inv_[0-9a-f]{32}$/.test(n));
  const revisions=[];for(const ref of records)revisions.push((await readCallerRecord(storeRoot,ref)).revision);
  console.log(JSON.stringify({case:'promotion A1',code:error?.code,message:error?.message,response:!!response,calls:w.calls.length,records:records.length,revisions}));
  assert.equal(error?.code,'VALIDATION_ERROR');
  assert.equal(w.calls.length,0,'an unsafe recovery reference profile must refuse before acquisition');
  assert.deepEqual(records,[],'profile refusal must not create a hidden retained investigation');
});

async function promotionStartProfile(secrets) {
  const {readdir}=await import('node:fs/promises');
  const s=await sandbox(),w=localWorld(),storeRoot=s.env.SCOUTLINE_INVESTIGATIONS_DIR;
  let response,error;
  try {response=await run({schemaVersion:1,operation:'start',requirements:contract,dataScope:'synthetic'},{storeRoot,deps:w.deps,secrets});}catch(e){error=e;}
  const records=(await readdir(join(storeRoot,'investigations')).catch(e=>{if(e.code==='ENOENT')return [];throw e;})).filter(n=>/^inv_[0-9a-f]{32}$/.test(n));
  return {response,error,calls:w.calls.length,records};
}
test('promotion A2 complete recovery language and invariant identities refuse before work',async()=>{
  const profiles=[['caller'],['settled'],['committed'],['"investigationRef":"inv_'],['f'.repeat(32)],['v_'+'f'.repeat(32)],['f'],['mutation']];
  const rows=[];
  for(const secrets of profiles){const x=await promotionStartProfile(secrets);rows.push({profile:secrets,code:x.error?.code,message:x.error?.message,calls:x.calls,records:x.records.length,response:!!x.response});}
  console.log(JSON.stringify({case:'promotion A2',rows}));
  for(const x of rows){assert.equal(x.code,'VALIDATION_ERROR',JSON.stringify(x));assert.equal(x.calls,0,'the complete recovery language must be admitted before work: '+JSON.stringify(x));assert.equal(x.records,0);}
});

test('promotion A3 committed partial view failure returns an exact recoverable selector',async()=>{
  const {readdir}=await import('node:fs/promises');
  const {readCallerRecord}=await import('../dist/lib/lean-caller-rounds.js');
  const s=await sandbox(),w=localWorld(),storeRoot=s.env.SCOUTLINE_INVESTIGATIONS_DIR,secrets=['partial'];
  const request={schemaVersion:1,operation:'start',requirements:contract,dataScope:'synthetic'};
  const r=await repairInvoke(()=>run(request,{storeRoot,deps:w.deps,secrets}),secrets);
  const records=(await readdir(join(storeRoot,'investigations'))).filter(n=>/^inv_[0-9a-f]{32}$/.test(n));
  const native=await readCallerRecord(storeRoot,records[0]),error=JSON.parse(r.stderr),calls=w.calls.length;
  console.log(JSON.stringify({case:'promotion A3',records:records.length,reference:records[0],revision:native.revision,rounds:native.snapshot.rounds.length,calls,code:r.code,stdout:r.stdout,error}));
  assert.equal(records.length,1);assert.equal(native.revision,1);assert.equal(native.snapshot.rounds.length,1);assert.ok(calls>0);
  assert.equal(r.stdout,'');assert.equal(r.code,1);assert.equal(error.code,'VALIDATION_ERROR');
  assert.equal(error.error,'Caller round committed; do not repeat the mutation.');
  assert.equal(error.help,JSON.stringify({investigationRef:records[0],revision:1,operation:'inspect'}));
  assert.ok(!r.stderr.includes('partial'),'the raw colliding value is not copied to diagnostics');
  const selector=JSON.parse(error.help),page=await run({schemaVersion:1,...selector,collection:'outcomes',maxChars:65536},{storeRoot,secrets});
  assert.equal(page.collection,'outcomes');assert.equal(page.revision,1);assert.ok(JSON.parse(page.content).length>0);
  assert.equal(w.calls.length,calls,'recovery inspection adds no collaborator work');
  assert.deepEqual(await readCallerRecord(storeRoot,records[0]),native,'recovery neither retries nor mutates the committed round');
});

test('promotion A5 continuation admits the exact next revision and retains late recovery',async()=>{
  const {startCallerRound,readCallerRecord}=await import('../dist/lib/lean-caller-rounds.js');
  const rows=[];
  for(const secret of ['2','partial']){
    const s=await sandbox(),w=localWorld(),storeRoot=s.env.SCOUTLINE_INVESTIGATIONS_DIR;let identity=0;
    const lower=await startCallerRound({storeRoot,contract,deps:w.deps,storeOptions:{deps:{randomId:()=>`00000000-0000-4000-8000-${(++identity).toString(16).padStart(12,'0')}`}}});
    const ref=lower.investigationRef,before=await readCallerRecord(storeRoot,ref),calls=w.calls.length;
    assert.ok(!ref.includes('2'),'the numeric collision is in the next revision, not the concrete reference');
    const r=await repairInvoke(()=>run({schemaVersion:1,operation:'continue',investigationRef:ref,expectedRevision:1,dataScope:'synthetic',leads:[{url:'https://example.test/next',title:'Fresh continuation lead'}]},{storeRoot,deps:w.deps,secrets:[secret]}),[secret]);
    const after=await readCallerRecord(storeRoot,ref);rows.push({secret,ref,before,after,callsBefore:calls,callsAfter:w.calls.length,r,error:JSON.parse(r.stderr)});
  }
  console.log(JSON.stringify({case:'promotion A5',rows:rows.map(x=>({secret:x.secret,ref:x.ref,work:x.callsAfter-x.callsBefore,before:x.before.revision,after:x.after.revision,error:x.error}))}));
  const early=rows[0];assert.equal(early.r.stdout,'');assert.equal(early.error.code,'VALIDATION_ERROR');assert.equal(early.callsAfter,early.callsBefore,'a colliding next revision must refuse before new work');assert.deepEqual(early.after,early.before);
  const late=rows[1];assert.equal(late.after.revision,2);assert.equal(late.after.snapshot.rounds.length,2);assert.ok(late.callsAfter>late.callsBefore);assert.equal(late.r.stdout,'');assert.equal(late.error.error,'Caller round committed; do not repeat the mutation.');assert.equal(late.error.help,JSON.stringify({investigationRef:late.ref,revision:2,operation:'inspect'}));
});

test('promotion B start IDs reject the native-incompatible subset at public preflight',async()=>{
  const {validateCallerRequest}=await api(),rows=[];
  for(const id of ['release.version','a'.repeat(65),'a'.repeat(128),'é'.repeat(64)]){
    const requirements={schemaVersion:1,question:'Version?',requirements:{[id]:{question:'Version?',schema:{type:'string'}}}};let error;
    try{validateCallerRequest({schemaVersion:1,operation:'start',requirements,dataScope:'synthetic'});}catch(e){error=e;}
    rows.push({bytes:Buffer.byteLength(id),punctuation:id.includes('.'),unicode:id.includes('é'),code:error?.code,message:error?.message});
  }
  console.log(JSON.stringify({case:'promotion B',rows}));
  for(const row of rows){assert.equal(row.code,'VALIDATION_ERROR','public start must reject IDs that the native initial requirements cannot store: '+JSON.stringify(row));assert.equal(row.message,'Caller start requirement IDs must match [A-Za-z0-9_-]{1,64}.');}
});

test('promotion compatibility native ID boundaries and long-ID retained replacement stay usable',async()=>{
  const {startCallerRound,readCallerRecord}=await import('../dist/lib/lean-caller-rounds.js');
  const doc=id=>({schemaVersion:1,question:'Version?',requirements:{[id]:{question:'Version?',schema:{type:'string'}}},limits:{maxSearchAttempts:1,maxUniqueReads:1,maxJudgeAttempts:1}});
  for(const id of ['a','a'.repeat(64),'release_version-1']){
    const s=await sandbox(),w=localWorld(),storeRoot=s.env.SCOUTLINE_INVESTIGATIONS_DIR;
    const h=await run({schemaVersion:1,operation:'start',requirements:doc(id),dataScope:'synthetic'},{storeRoot,deps:w.deps});
    assert.match(h.investigationRef,/^inv_[0-9a-f]{32}$/);assert.equal(h.revision,1);
    const raw=await readCallerRecord(storeRoot,h.investigationRef);assert(Object.hasOwn(raw.contract.requirements,id));
    const {resultSha256,...value}=h;assert.equal(resultSha256,hash(JSON.stringify(value)));
  }
  for(const id of ['a'.repeat(128),'é'.repeat(64)]){
    const s=await sandbox(),w=localWorld(),storeRoot=s.env.SCOUTLINE_INVESTIGATIONS_DIR;
    // Real native store: valid initial requirements are distinct from the broad retained contract body.
    const lower=await startCallerRound({storeRoot,contract:doc(id),requirements:{schemaVersion:1,fields:{native_seed:{definition:'Version?',required:true}}},deps:w.deps});
    const before=await readCallerRecord(storeRoot,lower.investigationRef);
    const h=await run({schemaVersion:1,operation:'inspect',investigationRef:lower.investigationRef},{storeRoot});assert.equal(h.revision,1);
    const next=await run({schemaVersion:1,operation:'continue',investigationRef:h.investigationRef,expectedRevision:1,requirements:doc(id),dataScope:'synthetic'},{storeRoot,deps:w.deps});
    assert.equal(next.revision,2);const after=await readCallerRecord(storeRoot,h.investigationRef);assert(Object.hasOwn(after.baselineContract.requirements,id));assert.equal(after.snapshot.requirementsDigest,before.snapshot.requirementsDigest);
  }
});

test('promotion compatibility profile admission preserves exact literal and intrinsic semantics',async()=>{
  const profiles=[[],['',' \t '],['f'.repeat(33)],['F'.repeat(32)],[' f '],['tvly-synthetic-profile'],['Bearer Key-12345678'],['long-synthetic-secret','[REDACTED]'],['[REDACTED]','long-synthetic-secret']];
  for(const secrets of profiles){const frozen=Object.freeze([...secrets]),r=await promotionStartProfile(frozen);assert.equal(r.error,undefined,JSON.stringify({secrets,error:r.error?.message}));assert.equal(r.response.revision,1);assert.equal(r.records.length,1);assert.ok(r.calls>0);assert.deepEqual(frozen,secrets);}
});
