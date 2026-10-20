import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root=dirname(dirname(fileURLToPath(import.meta.url)));
const scratch=await mkdtemp(join(tmpdir(),'caller-demo-'));
try {
await mkdir(join(scratch,'home'));
const env={PATH:process.env.PATH,NODE_OPTIONS:process.env.NODE_OPTIONS,TMPDIR:process.env.TMPDIR,HOME:join(scratch,'home'),SCOUTLINE_CONFIG_DIR:join(scratch,'config'),SCOUTLINE_INVESTIGATIONS_DIR:join(scratch,'records'),SCOUTLINE_CACHE_DIR:join(scratch,'cache'),SCOUTLINE_ARTIFACTS_DIR:join(scratch,'artifacts'),TAVILY_API_KEY:'synthetic-acquisition-key',TYPESAFE_API_KEY:'synthetic-judge-key',SCOUTLINE_JUDGE_TRANSMIT:'1',SCOUTLINE_NO_AGENT_CHECK:'1'};
function call(request){const child=spawnSync(process.execPath,['--import',join(root,'tests/helpers/caller-native-preload.mjs'),join(root,'bin/scoutline.js'),'investigate','--provider','tavily','--no-cache','--output','data','--caller-request-json',JSON.stringify(request)],{env,encoding:'utf8',timeout:30000});
 if(!child.stdout)throw new Error(child.stderr||String(child.error));const data=JSON.parse(child.stdout);assert.ok([0,1].includes(child.status),child.stderr);return data;}
function request(operation,extra={}){return {schemaVersion:1,operation,...extra};}
const requirements={schemaVersion:1,question:'What version?',requirements:{version:{question:'What version?',schema:{type:'string'}}},limits:{maxSearchAttempts:1,deadlineMs:5000}};
const start=call(request('start',{requirements,dataScope:'synthetic'}));
assert.equal(start.status,'partial');const investigationRef=start.investigationRef;
const manifest=JSON.parse(call(request('inspect',{investigationRef,collection:'evidence'})).content);
const definitions=JSON.parse(call(request('inspect',{investigationRef,collection:'changes'})).content)[0].definitions;
const evidence=call(request('readEvidence',{investigationRef,evidenceId:manifest[0].evidenceId,representationId:manifest[0].representationId,digest:manifest[0].digest}));
const quote='version 1.2.3',a=evidence.content.indexOf(quote);assert.ok(a>=0);
const continued=call(request('continue',{investigationRef,expectedRevision:start.revision,dataScope:'synthetic',proposals:[{requirementId:'version',definitionRevision:definitions.version,mode:'string',value:'1.2.3',binding:{evidenceId:manifest[0].evidenceId,representationId:manifest[0].representationId,digest:manifest[0].digest,range:[a,a+quote.length],quote}}],representations:[{format:'markdown',content:'Independent public example confirms version 1.2.3.',label:'Caller source'}]}));
assert.equal(continued.status,'complete');
const outcomes=JSON.parse(call(request('inspect',{investigationRef,collection:'outcomes'})).content);assert.equal(outcomes[0].outcome.value,'1.2.3');
const history=JSON.parse(call(request('inspect',{investigationRef,collection:'rounds'})).content);assert.equal(history.length,2);
const historical=call(request('inspect',{investigationRef,revision:1}));assert.equal(historical.status,'partial');
const deleted=call(request('delete',{investigationRef}));assert.equal(deleted.deleted,true);
console.log(JSON.stringify({start,evidence,continued,outcomes,history,historical,deleted},null,2));

} finally {await rm(scratch,{recursive:true,force:true});}
