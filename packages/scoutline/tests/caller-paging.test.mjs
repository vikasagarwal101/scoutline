import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp as actualMkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeCallerInvestigation as execute } from '../dist/lib/caller-investigation.js';
const requirements={schemaVersion:1,question:'version?',requirements:{v:{question:'version?',schema:{type:'string'}}},limits:{maxSearchAttempts:1}};
const deps={search:async()=>[],read:async()=>{throw new Error('no network');},judge:null,now:()=>1000};
async function world(content='version 1.2.3'){const storeRoot=await mkdtemp(join(tmpdir(),'caller-paging-'));const options={storeRoot,deps,secrets:['split-secret']};const h=await execute({schemaVersion:1,operation:'start',dataScope:'synthetic',requirements,representations:[{format:'text',content,label:'metadata split-secret'}]},options);return {h,options};}
async function collection(h,options,name,maxChars=2048){let cursor=h.cursors[name],all='';do{const p=await execute({schemaVersion:1,operation:'inspect',investigationRef:h.investigationRef,collection:name,cursor,maxChars},options);assert.ok(JSON.stringify(p).length<=maxChars);all+=p.content;cursor=p.cursor;}while(cursor);return JSON.parse(all);}
test('complete metadata and whole-redacted evidence page without split-secret leakage',async()=>{
 const {h,options}=await world('a'.repeat(4000)+'split-secret'+'version 1.2.3'+'😀'.repeat(2000));
 const manifest=await collection(h,options,'evidence');assert.equal(manifest.length,1);assert.ok(!JSON.stringify(manifest).includes('split-secret'));
 let cursor,all='';do{const p=await execute({schemaVersion:1,operation:'readEvidence',investigationRef:h.investigationRef,representationId:manifest[0].representationId,digest:manifest[0].digest,cursor,maxChars:2048},options);assert.ok(JSON.stringify(p).length<=2048);all+=p.content;cursor=p.cursor;}while(cursor);
 assert.ok(all.includes('[REDACTED]'));assert.ok(!all.includes('split-secret'));assert.ok(all.endsWith('😀'.repeat(2000)));
 const old=manifest[0];await assert.rejects(execute({schemaVersion:1,operation:'readEvidence',investigationRef:h.investigationRef,representationId:old.representationId,digest:old.digest},{...options,secrets:['split-secret','version']}),/unavailable/);
});
test('historical result stays partial while current result and cursors advance',async()=>{
 const {h,options}=await world();const next=await execute({schemaVersion:1,operation:'continue',investigationRef:h.investigationRef,expectedRevision:h.revision,dataScope:'synthetic',representations:[{format:'json',content:'{"public":"new"}'}]},options);
 assert.equal(next.revision,2);const historical=await execute({schemaVersion:1,operation:'inspect',investigationRef:h.investigationRef,revision:1},options);assert.equal(historical.revision,1);assert.equal(historical.stopReason,h.stopReason);
 await assert.rejects(execute({schemaVersion:1,operation:'inspect',investigationRef:h.investigationRef,cursor:h.cursors.evidence},options),/Stale/);
 assert.equal((await collection(next,options,'rounds')).length,2);
});
test('corrupt result binding refuses reopening but safe-owned delete still succeeds',async()=>{
 const {h,options}=await world();const dir=join(options.storeRoot,'investigations',h.investigationRef);const revisions=await readdir(join(dir,'revisions'));const file=join(dir,'revisions',revisions.find(n=>n==='r1.json'));await writeFile(file,'damaged');
 await assert.rejects(execute({schemaVersion:1,operation:'inspect',investigationRef:h.investigationRef},options),/verifiable/);
 assert.equal((await execute({schemaVersion:1,operation:'delete',investigationRef:h.investigationRef},options)).deleted,true);
});

const ownedFixtureRoots=new Set();
async function mkdtemp(...args){const path=await actualMkdtemp(...args);ownedFixtureRoots.add(path);return path;}
afterEach(async()=>{for(const path of ownedFixtureRoots){await rm(path,{recursive:true,force:true});ownedFixtureRoots.delete(path);}});
