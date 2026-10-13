import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {sandbox,bin,contract,content,noHTTP,output} from './helpers/caller-review-harness.mjs';
const offline={REVIEW_REFUSE_HTTP:'1'};
async function items(state,h,c) {
  let cursor=h.cursors[c],text='',end=0;
  while(cursor) {
    const r=await bin(state,{schemaVersion:1,operation:'inspect',investigationRef:h.investigationRef,collection:c,cursor,maxChars:2048},{env:offline});
    noHTTP(r);assert.equal(r.code,0,r.stderr);
    const p=output(r);assert.equal(p.range[0],end);end=p.range[1];text+=p.content;cursor=p.cursor;
  }
  const rows=JSON.parse(text);assert.equal(rows.length,h.counts[c]);return rows;
}
async function read(state,h,e) {
  let cursor,text='',end=0;
  do {
    const r=await bin(state,{schemaVersion:1,operation:'readEvidence',investigationRef:h.investigationRef,representationId:e.representationId,digest:e.digest,maxChars:2048,...(cursor?{cursor}:{})},{env:offline});
    noHTTP(r);assert.equal(r.code,0,r.stderr);
    const p=output(r);assert.equal(p.range[0],end);end=p.range[1];text+=p.content;cursor=p.cursor;
  }while(cursor);
  assert.equal('sha256:'+createHash('sha256').update(text).digest('hex'),e.digest);return text;
}
test('C01 actual compiled separate-process complete caller flow, full collections, fresh continuation, history and delete',async()=>{
  const state=await sandbox();
  const first=await bin(state,{schemaVersion:1,operation:'start',requirements:contract,dataScope:'synthetic'});
  assert.equal(first.signal,null);assert.equal(first.code,1,first.stderr);
  const h=output(first);assert.equal(h.kind,'caller-assisted-investigation');assert.equal(h.status,'partial');
  assert.ok(first.events.some(e=>e.url==='https://api.tavily.com/extract'),'useful native context acquired without extractor');
  const manifest=await items(state,h,'evidence');assert.ok(manifest.length);
  for(const c of Object.keys(h.counts)) await items(state,h,c);
  const source=await read(state,h,manifest[0]);assert.equal(source,content);
  const proposal=(id,value,quote)=>({requirementId:id,definitionRevision:h.definitions[id],mode:'string',value,binding:{representationId:manifest[0].representationId,digest:manifest[0].digest,range:[source.indexOf(quote),source.indexOf(quote)+quote.length],quote}});
  const req={schemaVersion:1,operation:'continue',investigationRef:h.investigationRef,expectedRevision:h.revision,dataScope:'synthetic',proposals:[proposal('version','2.4.0','ExampleApp release 2.4.0.'),proposal('license','MIT','License MIT applies to release 2.4.0.')],representations:[{format:'markdown',content:'ExampleApp 2.4.0 release supplement: MIT license and CSV support.',label:'caller release supplement',claimedSource:'https://example.test/supplement'}],roundLimits:{maxUniqueReads:2,maxSearchAttempts:2}};
  const continued=await bin(state,req);assert.equal(continued.signal,null);
  const next=output(continued);assert.equal(next.revision,h.revision+1);assert.equal(next.status,'complete');
  const outcomes=await items(state,next,'outcomes');
  assert.equal(outcomes.find(r=>r.requirementId==='version').outcome.status,'satisfied');
  assert.equal(outcomes.find(r=>r.requirementId==='license').outcome.status,'satisfied');
  assert.equal(outcomes.find(r=>r.requirementId==='csv').outcome.status,'satisfied');
  assert.ok(continued.events.some(e=>e.url==='https://api.typesafe.ai/v1/systemone'),'native semantic judging exercised');
  const changed=await bin(state,{schemaVersion:1,operation:'continue',investigationRef:h.investigationRef,expectedRevision:next.revision,dataScope:'synthetic',requirements:{...contract,scope:{...contract.scope,release:'3.0.0'},question:'Identify ExampleApp release 3.0.0.'}});
  const newer=output(changed);assert.equal(newer.revision,next.revision+1);assert.notDeepEqual(newer.definitions,next.definitions);
  const historic=await bin(state,{schemaVersion:1,operation:'inspect',investigationRef:h.investigationRef,revision:h.revision},{env:offline});noHTTP(historic);
  assert.equal(output(historic).status,'partial');assert.deepEqual(output(historic).definitions,h.definitions);
  const rounds=await items(state,newer,'rounds');assert.equal(rounds.length,3);
  const deleted=await bin(state,{schemaVersion:1,operation:'delete',investigationRef:h.investigationRef},{env:offline});noHTTP(deleted);assert.equal(output(deleted).deleted,true);
  const gone=await bin(state,{schemaVersion:1,operation:'inspect',investigationRef:h.investigationRef},{env:offline});noHTTP(gone);assert.notEqual(gone.code,0);
});
