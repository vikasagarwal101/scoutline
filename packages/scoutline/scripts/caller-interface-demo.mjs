import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root=dirname(dirname(fileURLToPath(import.meta.url)));
const scratch=await mkdtemp(join(tmpdir(),'caller-demo-'));
try {
await mkdir(join(scratch,'home'));
const env={PATH:process.env.PATH,NODE_OPTIONS:process.env.NODE_OPTIONS,TMPDIR:process.env.TMPDIR,HOME:join(scratch,'home'),SCOUTLINE_CONFIG_DIR:join(scratch,'config'),SCOUTLINE_INVESTIGATIONS_DIR:join(scratch,'records'),SCOUTLINE_CACHE_DIR:join(scratch,'cache'),SCOUTLINE_ARTIFACTS_DIR:join(scratch,'artifacts'),TAVILY_API_KEY:'synthetic-acquisition-key',OPENROUTER_API_KEY:'synthetic-judge-key',CALLER_DEMO_TRACE:join(scratch,'trace.jsonl'),SCOUTLINE_JUDGE_TRANSMIT:'1',SCOUTLINE_NO_AGENT_CHECK:'1'};
function call(request){const child=spawnSync(process.execPath,['--import',join(root,'tests/helpers/caller-native-preload.mjs'),join(root,'bin/scoutline.js'),'investigate','--provider','tavily','--no-cache','--caller-request-json',JSON.stringify(request)],{env,encoding:'utf8',timeout:30000});
 if(child.error || child.signal || ![0,1].includes(child.status))throw new Error(child.stderr||String(child.error||child.signal||child.status));
 if(!child.stdout)throw new Error(child.stderr||'missing stdout');return JSON.parse(child.stdout);}
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
const trace=(await readFile(env.CALLER_DEMO_TRACE,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
const native=trace.filter(row=>row.url==='https://openrouter.ai/api/v1/systemone');
assert.ok(native.length>0);assert.ok(native.every(row=>row.method==='POST'&&row.requestedModel==='typesafe/jev-1.14'&&row.resolvedModel==='typesafe/jev-1.14-20261014'&&row.allowFallbacks===false&&row.authSha256===createHash('sha256').update('Bearer synthetic-judge-key').digest('hex')));
assert.ok(!trace.some(row=>row.url==='https://api.typesafe.ai/v1/systemone'));

const outcomes=JSON.parse(call(request('inspect',{investigationRef,collection:'outcomes'})).content);assert.equal(outcomes[0].outcome.value,'1.2.3');
const history=JSON.parse(call(request('inspect',{investigationRef,collection:'rounds'})).content);assert.equal(history.length,2);
const historical=call(request('inspect',{investigationRef,revision:1}));assert.equal(historical.status,'partial');
const deleted=call(request('delete',{investigationRef}));assert.equal(deleted.deleted,true);
console.log(JSON.stringify({start,evidence,continued,outcomes,history,historical,deleted},null,2));

} finally {await rm(scratch,{recursive:true,force:true});}
