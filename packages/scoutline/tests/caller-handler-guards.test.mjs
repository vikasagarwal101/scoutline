import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const root = process.cwd().endsWith('/packages/scoutline')?process.cwd():join(process.cwd(),'packages/scoutline');
assert.ok(root, 'REVIEW_PACKAGE required');
const contract = { schemaVersion:1,question:'Does ExampleApp support CSV?',scope:{entity:'ExampleApp'},requirements:{csv:{question:'Does ExampleApp support CSV?',schema:{enum:['supported','refuted','disputed']}}} };
const text = 'ExampleApp supports CSV export.';
async function run({cap=48, observe=false, producer=false}={}) {
  const { main } = await import(pathToFileURL(join(root, 'dist/index.js')));
  const { selectRequirementsJudge } = await import(pathToFileURL(join(root, 'dist/commands/investigate-requirements.js')));
  const { createTavilyDescriptor } = await import(pathToFileURL(join(root, 'dist/providers/tavily/adapter.js')));
  const { hermeticMainDeps } = await import(pathToFileURL(join(root, 'tests/helpers/hermetic-main.js')));

  const sandbox = await mkdtemp(join(tmpdir(),'caller-handler-proof-'));
  const originalFetch = globalThis.fetch;
  try {
  const calls=[], refusals=[];
  let bridgeRefusals=0;
  globalThis.fetch = async (url,init={}) => {
    const target=String(url); calls.push(target);
    if(target==='https://api.tavily.com/search') return Response.json({results:[{url:'https://example.test/a',title:'ExampleApp release',content:text}]});
    if(target==='https://api.tavily.com/extract') return Response.json({results:[{url:'https://example.test/a',raw_content:text}],failed_results:[]});
    if(target==='https://api.typesafe.ai/v1/systemone') {
      const body=JSON.parse(init.body);
      return Response.json({model:'jev-1.13.0',answers:Object.fromEntries(Object.keys(body.questions).map(k=>[k,{type:'noul',noul:/[fc]$/.test(k)?0.05:0.95}])),usage:{input_tokens:1,output_tokens:1}});
    }
    throw new Error(`Unexpected HTTP blocked: ${target}`);
  };
  const stdout=[],stderr=[];
  const env={TAVILY_API_KEY:'synthetic-acquisition-key',TYPESAFE_API_KEY:'synthetic-judge-key',SCOUTLINE_JUDGE_TRANSMIT:'1',SCOUTLINE_REQUIREMENTS_MAX_PHYSICAL:String(cap),SCOUTLINE_CONFIG_DIR:join(sandbox,'config'),SCOUTLINE_CACHE_DIR:join(sandbox,'cache'),SCOUTLINE_ARTIFACTS_DIR:join(sandbox,'artifacts')};
  const deps=hermeticMainDeps({env,invocation:{stdoutIsTTY:false,stdinIsTTY:false,readStdin:async()=>'',writeStdout:s=>stdout.push(s),writeStderr:s=>stderr.push(s),runQuietly:async op=>op(),setExitCode:()=>{}}});
  if(observe) deps.requirementsRuntime = context => {
    const reserve=()=>{try {context.reserveAttempt();} catch(e) {refusals.push(e); throw e;}};
    const transport={fetch:globalThis.fetch,env};
    const descriptor=createTavilyDescriptor({transport});
    const native=selectRequirementsJudge(env,reserve);
    const runtime={judgeAdmission:'shared',acquisitionOptions:{searchDescriptor:descriptor,readerDescriptor:descriptor,transports:{tavily:transport},descriptorFactory:(_id,t)=>createTavilyDescriptor({transport:t}),env,cache:{get:async()=>null,set:async()=>{}},sleep:async()=>{},random:()=>0,maxPhysicalAttempts:48},engineDeps:{...native}};
    // The original closure stays the acquisition authority; interception only records actual refused invocations.
    runtime.acquisitionOptions.reservePhysicalAttempt=context.reserveAttempt;
    runtime.acquisitionOptions.onPhysicalLedger=ledger=>{bridgeRefusals=ledger.reservationsRefused;};
    if(producer) {
      runtime.producerPhysical={reserve:context.observeProducerDispatch};
      runtime.engineDeps.extract=async()=>{context.observeProducerDispatch(); return {rawOutput:'{}',finishReason:'stop',usage:{inputTokens:0,outputTokens:0},attempts:1};};
    }
    return runtime;
  };
    const code=await main(['investigate','--provider','tavily','--requirements-json',JSON.stringify(contract),'--no-cache','--json'],deps);
    assert.ok(stdout.join(''), `handler output absent: ${stderr.join('')}`);
    return {code,data:JSON.parse(stdout.join('')),stderr:stderr.join(''),calls,refusals,bridgeRefusals};
  } finally {globalThis.fetch=originalFetch;await rm(sandbox,{recursive:true,force:true});}
}
test('RR2-1: production native judge declares shared admission without injected-judge narrative', async()=>{
  const r=await run();
  assert.ok(r.calls.includes('https://api.typesafe.ai/v1/systemone'),'real native judge request exercised');
  assert.equal(r.data.admission.judge,'shared');
  assert.equal(r.data.judgeAdmissionUnknown,undefined);
  assert.equal(r.data.usage.physicalHttpAttempts,r.calls.length);
});
test('RR2-2: delivered refusal count equals actual shared-closure refusals including native judge',async()=>{
  const r=await run({cap:2,observe:true});
  assert.equal(r.calls.length,2,`physical cap proved by actual native HTTP observations: ${JSON.stringify(r.data)} ${r.stderr}`);
  assert.ok(r.refusals.length>0,'native judge refusal exercised');
  // Acquisition reserve is authoritative too, so its own refused attempts are included in the delivered bridge ledger.
  // Native judge refusals are not bridge attempts; every one must add once, not be overwritten by the next bridge snapshot.
  assert.equal(r.data.acquisition.reservationsRefused,r.refusals.length+r.bridgeRefusals,
    `lost non-acquisition refusal: delivered ${r.data.acquisition.reservationsRefused}, native ${r.refusals.length}, bridge ${r.bridgeRefusals}`);
});


// Root-approved pure seam: actual compiled L7/L6 and engine, no main,
// native supplier, registry, or real retained-store evaluation. The successful
// memory models make no filesystem/admission/durability guarantees.
import {readFileSync} from 'node:fs';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as util from 'node:util';
import {SourceTextModule,SyntheticModule} from 'node:vm';
import * as pureEngine from '../dist/lib/lean-investigation.js';
import * as pureErrors from '../dist/lib/errors.js';
import * as pureRedactor from '../dist/lib/redact.js';
import * as pureOutput from '../dist/lib/output.js';
const pureCopy=value=>structuredClone(value);
const pureHash=value=>crypto.createHash('sha256').update(value).digest('hex');
const pureContract=()=>({schemaVersion:1,question:'Version?',requirements:{version:{question:'Version?',schema:{type:'string'}}},limits:{maxSearchAttempts:1,maxUniqueReads:1,maxJudgeAttempts:1}});
async function pureFixture(config={}) {
  let nextReference=0;
  const records=new Map(), gates={create:null}, calls={create:0,begin:0,release:0,search:[],producer:0,resolved:[],unregister:0,sink:[],rankingInputs:[],runtimeInputs:[],formatSecrets:[]};
  let createReached;const reached=new Promise(resolve=>{createReached=resolve;});
  const store={
    recoveryRecords:[],
    async createInvestigation(){calls.create++;createReached();if(gates.create)await gates.create;nextReference++;assert(Number.isSafeInteger(nextReference),'fixture reference counter is bounded');const ref=`inv_${nextReference.toString(16).padStart(32,'0')}`;records.set(ref,{bodies:new Map(),snapshot:{schemaVersion:1,revision:0,parentRevision:null,createdAt:1,requirementsDigest:'synthetic-baseline',bodies:[],rounds:[],outcome:{},audit:[]}});return {investigationRef:ref,revision:0};},
    async inspect(ref){return {committed:{snapshot:pureCopy(records.get(ref).snapshot)},incomplete:null};},
    async readBody(ref,id){assert(records.get(ref).bodies.has(id));return Buffer.from(records.get(ref).bodies.get(id));},
    async deleteInvestigation(ref){records.delete(ref);},
    async acquireOwnership(ref){const record=records.get(ref);return {
      async readRecoveryPage(){return {records:pureCopy(store.recoveryRecords),cursor:null,complete:true,revision:record.snapshot.revision,viewDigest:pureHash(JSON.stringify(record.snapshot))};},
      async beginRound(){calls.begin++;},async appendAudit(){},async settleRound(){},async release(){calls.release++;},
      async stageBody(text){const bytes=Buffer.from(text),bodyId=`b:${pureHash(bytes)}`;record.bodies.set(bodyId,bytes);return {bodyId,bytes:bytes.length};},
      async commitRevision({snapshot}){record.snapshot=pureCopy(snapshot);},
    };},
  };
  class ExpectedRevisionError extends Error{} class CorruptRecordError extends Error{}
  const modules=new Map(), links=[], hashes={}, unused={};
  const synthetic=(namespace,id)=>new SyntheticModule(Object.keys(namespace),function(){for(const [k,v]of Object.entries(namespace))this.setExport(k,v);},{identifier:id});
  const inert=(id,names)=>synthetic(Object.fromEntries(names.map(name=>{const key=`${id}:${name}`;unused[key]=0;return [name,()=>{unused[key]++;throw new Error(`Unauthorized unused import invoked: ${key}`);}];})),`inert:${id}`);
  const horizonName='QUOTA_EXHAUSTION_DEMOTION_HORIZON_MS';
  const constantText=ext=>{const url=new URL(`../${ext==='ts'?'src':'dist'}/lib/quota-store.${ext}`,import.meta.url),bytes=readFileSync(url);const snippet=bytes.toString().split('\n').find(line=>line.startsWith(`export const ${horizonName} = `));assert(snippet);const expression=snippet.slice(snippet.indexOf('=')+1).replace(/;\s*$/,'').trim();assert(/^\d+(?:\s*\*\s*\d+)*$/.test(expression),'constant must be closed literal multiplication');return {url:url.href,sha256:pureHash(bytes),snippet,expression,value:expression.split('*').map(Number).reduce((a,b)=>a*b,1)};};
  const constantSource=constantText('ts'),constantCompiled=constantText('js');assert.equal(constantSource.expression,constantCompiled.expression);assert.equal(constantSource.value,constantCompiled.value);assert.equal(constantCompiled.value,86400000);
  const fixed={
    'node:crypto':synthetic(crypto,'real:crypto'),'node:fs':synthetic(fs,'real:fs-unused-IO'),'node:fs/promises':synthetic(fsPromises,'real:fs-promises-unused-IO'),'node:util':synthetic(util,'real:util'),
    'lib/errors.js':synthetic(pureErrors,'real:errors'),'lib/redact.js':synthetic(pureRedactor,'real:redactor'),'lib/output.js':synthetic({...pureOutput,formatErrorOutput:(...args)=>{calls.formatSecrets.push([...args[2]]);return Reflect.apply(pureOutput.formatErrorOutput,pureOutput,args);}},'real:output-observed-delegation'),'lib/lean-investigation.js':synthetic(pureEngine,'real:engine'),
    'lib/retained-record-store.js':synthetic({ExpectedRevisionError,CorruptRecordError,openStore:()=>store},'successful-memory-store'),
    'lib/lean-acquisition-bridge.js':synthetic({createLeanAcquisitionDeps:()=>({search:async q=>{calls.search.push(q);config.onSearch?.();return [];},read:async()=>''})},'successful-memory-acquisition'),
    'lib/quota-store.js':synthetic({[horizonName]:constantCompiled.value},'source-verified-single-constant-only'),
    'providers/registry.js':inert('registry',['getProviderDescriptor','getConfiguredProviderDescriptors']),
    'lib/lean-typesafe-judge.js':inert('native-judge',['resolveTypesafeJudgeProfile']),
  };
  for(const [provider,name]of [['tavily','Tavily'],['exa','Exa'],['firecrawl','Firecrawl'],['linkup','Linkup'],['spider','Spider']])fixed[`providers/${provider}/adapter.js`]=inert(provider,[`create${name}Descriptor`]);
  fixed['test:runtime-input-observer']=synthetic({observe:input=>calls.runtimeInputs.push(pureCopy(input))},'test-only-input-observer');
  const bodies=new Set(['commands/investigate-caller.js','commands/investigate-requirements.js','lib/caller-investigation.js','lib/lean-caller-rounds.js','lib/caller-physical.js','providers/selection.js','providers/types.js','lib/quota-mapping.js']);
  for(const name of ['lib/lean-investigation','lib/lean-candidates','lib/lean-composed-stop','lib/errors','lib/redact','lib/output'])for(const ext of ['src','dist']){const url=new URL(`../${ext}/${name}.${ext==='src'?'ts':'js'}`,import.meta.url);hashes[url.href]=pureHash(readFileSync(url));}
  const load=name=>{if(modules.has(name))return modules.get(name);
    if(config.observeRuntimeInput&&name==='commands/investigate-requirements.js'){
      const facade=new SourceTextModule(`export * from './actual-investigate-requirements.js'; import {withRequirementsRuntime as actual} from './actual-investigate-requirements.js'; import {observe} from 'test:runtime-input-observer'; export function withRequirementsRuntime(...args){observe(args[0]);return Reflect.apply(actual,this,args);}`,{identifier:new URL('../dist/commands/runtime-input-observer.js',import.meta.url).href});modules.set(name,facade);return facade;
    }
    if(name==='commands/actual-investigate-requirements.js'){
      const bytes=readFileSync(new URL('../dist/commands/investigate-requirements.js',import.meta.url));const actual=new SourceTextModule(bytes.toString(),{identifier:new URL('../dist/commands/actual-investigate-requirements.js',import.meta.url).href});hashes['actual-delegated-runtime']=pureHash(bytes);modules.set(name,actual);return actual;
    }
if(fixed[name]){modules.set(name,fixed[name]);return fixed[name];}assert(bodies.has(name),`Unauthorized module ${name}`);const url=new URL(`../dist/${name}`,import.meta.url),bytes=readFileSync(url);hashes[url.href]=pureHash(bytes);hashes[new URL(`../src/${name.replace(/\.js$/,'.ts')}`,import.meta.url).href]=pureHash(readFileSync(new URL(`../src/${name.replace(/\.js$/,'.ts')}`,import.meta.url)));const module=new SourceTextModule(bytes.toString(),{identifier:url.href});modules.set(name,module);return module;};
  const caller=load('commands/investigate-caller.js');
  await caller.link((specifier,importing)=>{const name=specifier.startsWith('node:')||specifier==='test:runtime-input-observer'?specifier:new URL(specifier,importing.identifier).pathname.split('/dist/')[1];assert(name);links.push({from:importing.identifier,specifier,target:name});return load(name);});
  await caller.evaluate();
  const noRankingAccess=label=>new Proxy([],{get(_target,key){calls.rankingInputs.push(`${label}:${String(key)}`);throw new Error('Explicit provider must bypass ranking inputs');}});
  const host={provider:' TaViLy ',quotaState:noRankingAccess('quota'),providerDescriptors:noRankingAccess('descriptors'),env:config.env??{},secrets:config.secrets??[]};
  let interrupt;
  const deps={now:()=>0,readFile:async()=>{throw new Error('No input file read permitted');},readStdin:async()=>{throw new Error('No stdin permitted');},registerUserInterrupt:fn=>{interrupt=fn;return()=>{calls.unregister++;};},onResolvedProvider:p=>calls.resolved.push(p),onRuntimeSecrets:values=>{calls.sink.push(values);config.onRuntimeSecrets?.(values);},requirementsRuntime:context=>{
    if(config.runtimeError)throw config.runtimeError;
    return {acquisitionOptions:{},engineDeps:{judge:null,candidateJudge:null,...(config.producer===false?{}:{extract:async()=>{calls.producer++;if(config.observe)context.observeProducerDispatch();return {rawOutput:'{}',attempts:config.attempts};}})},...(config.declared?{producerPhysical:{reserve:context.observeProducerDispatch}}:{}),secrets:config.runtimeSecrets??[]};
  }};
  const f={store,api:load('lib/caller-investigation.js').namespace,rounds:load('lib/lean-caller-rounds.js').namespace,requirements:load('commands/investigate-requirements.js').namespace,handler:caller.namespace.handleInvestigateCaller,calls,gates,reached,host,deps,interrupt:()=>{assert(interrupt);interrupt();},binding:{hashes,links,constantSource,constantCompiled,unused},check(){assert.deepEqual(Object.values(unused),Array(8).fill(0));assert.deepEqual(calls.rankingInputs,[]);assert(calls.resolved.every(p=>p==='tavily'));}};
  return f;
}

test('L7 pure F1: measured producer telemetry never grants retrospective shared admission',async()=>{
  const rows=[{label:'returned-only',attempts:3,count:3,admission:'unknown'},{label:'observed',attempts:1,observe:true,count:1,admission:'shared'},{label:'declared-zero',attempts:0,declared:true,count:0,admission:'shared'},{label:'opaque',count:null,admission:'unknown'},{label:'absent',producer:false,count:0,admission:'not-configured'}];
  for(const row of rows){const f=await pureFixture(row);const r=await f.requirements.withRequirementsRuntime(pureContract(),f.deps,f.host,async(input,unified,observation)=>{if(unified.extract)await unified.extract({});const result=await pureEngine.runLeanInvestigation(input,unified);return {result,value:observation()};});
    assert.equal(f.calls.producer,row.producer===false?0:1,'producer telemetry path actually reached');
    assert.equal(r.value.stages.producer,row.count,row.label);assert.equal(r.value.admission.producer,row.admission,'returned telemetry must not certify shared pre-admission');
    assert.equal(r.value.total,row.count===null?null:row.count);assert.equal(r.projected.data.admission.producer,row.producer===false?undefined:row.admission);
    assert.equal(r.projected.data.usage.physicalHttpAttempts,row.count??0);assert.equal(Boolean(r.projected.data.usage.physicalHttpAttemptsUnknown),row.count===null);f.check();console.log(JSON.stringify({family:'F1',row:row.label,binding:f.binding,physical:r.value}));
  }
  const invalid=await pureFixture({attempts:-1});await assert.rejects(invalid.requirements.withRequirementsRuntime(pureContract(),invalid.deps,invalid.host,async(_input,unified)=>{await unified.extract({});throw new Error('invalid telemetry must reject first');}),e=>e.code==='VALIDATION_ERROR');invalid.check();
});

test('L7 pure F2: unchanged display preserves exact repeated-quote coordinates',async()=>{
  const setup=async(content,secrets=[])=>{const f=await pureFixture({producer:false,secrets});const options={storeRoot:'memory',secrets};const first=await f.handler({schemaVersion:1,operation:'start',requirements:pureContract(),dataScope:'synthetic',representations:[{format:'text',content}]},'memory',f.deps,f.host);const h=first.data;
    const page=await f.api.executeCallerInvestigation({schemaVersion:1,operation:'inspect',investigationRef:h.investigationRef,collection:'evidence',maxChars:65536},options);const [e]=JSON.parse(page.content);assert(e);
    const body=await f.api.executeCallerInvestigation({schemaVersion:1,operation:'readEvidence',investigationRef:h.investigationRef,representationId:e.representationId,digest:e.digest,maxChars:65536},options);
    const quote='Version 2.4.',a=body.content.lastIndexOf(quote);assert(a>=0);const request={schemaVersion:1,operation:'continue',investigationRef:h.investigationRef,expectedRevision:h.revision,dataScope:'synthetic',proposals:[{requirementId:'version',definitionRevision:(await pureCollection(f,h,'changes',secrets))[0].definitions.version,mode:'string',value:'2.4',binding:{representationId:e.representationId,digest:e.digest,range:[a,a+quote.length],quote}}]};return {f,options,h,e,request,body};};
  const repeated='Version 2.4. Version 2.4.',v=await setup(repeated);let next;
  await assert.doesNotReject(async()=>{next=await v.f.handler(v.request,'memory',v.f.deps,v.f.host);},'unchanged display must preserve selected repeated occurrence');
  const retained=await v.f.rounds.readCallerRecord('memory',v.h.investigationRef);const p=retained.payload.proposals[0];
  assert.deepEqual(p.charRange,v.request.proposals[0].binding.range);assert.equal(p.charRange[0],repeated.lastIndexOf('Version 2.4.'));assert.equal(p.digest,v.e.originalDigest);assert.equal(p.representationId,v.e.originalRepresentationId);assert.equal(p.quote,'Version 2.4.');assert.equal(next.data.revision,v.h.revision+1);assert(!('version'in retained.payload.result.data));v.f.check();
  for(const content of ['Version 2.4.','hidden alpha-secret; Version 2.4.']){const x=await setup(content,['alpha-secret']);await x.f.handler(x.request,'memory',x.f.deps,x.f.host);const record=await x.f.rounds.readCallerRecord('memory',x.h.investigationRef);assert.deepEqual(record.payload.proposals[0].charRange,[content.indexOf('Version 2.4.'),content.indexOf('Version 2.4.')+12]);x.f.check();}
  const ambiguous=await setup('hidden alpha-secret; Version 2.4. Version 2.4.',['alpha-secret']),before=ambiguous.f.calls.begin;
  await assert.rejects(ambiguous.f.handler(ambiguous.request,'memory',ambiguous.f.deps,ambiguous.f.host),e=>e.code==='VALIDATION_ERROR');assert.equal(ambiguous.f.calls.begin,before);ambiguous.f.check();
  const bad=await setup('Version 2.4.');for(const override of [{digest:'sha256:'+'0'.repeat(64)},{representationId:'d:'+'0'.repeat(64)},{quote:'altered'},{range:[0,13]},{quote:'[REDACTED]',range:[0,10]}]){const request=pureCopy(bad.request);Object.assign(request.proposals[0].binding,override);const n=bad.f.calls.begin;await assert.rejects(bad.f.handler(request,'memory',bad.f.deps,bad.f.host),e=>e.code==='VALIDATION_ERROR');assert.equal(bad.f.calls.begin,n);}bad.f.check();
  console.log(JSON.stringify({family:'F2',selectedOriginalRange:p.charRange,binding:v.f.binding}));
});

test('L7 pure F3: owned pre-engine cancellation translates only the specific typed guard',async()=>{
  const request={schemaVersion:1,operation:'start',requirements:pureContract(),dataScope:'synthetic'};
  const f=await pureFixture({producer:false});let release;f.gates.create=new Promise(resolve=>{release=resolve;});const pending=f.handler(request,'memory',f.deps,f.host);await f.reached;f.interrupt();release();
  await assert.rejects(pending,e=>{assert.equal(e.exitCode,130,'owned pre-engine cancellation must map to 130');assert.equal(e.constructor,pureErrors.ScoutlineError,'translation must construct a new base error, never mutate the caught ValidationError');assert.equal(e.message,'Round cancelled before dispatch.');assert.equal(e.code,'VALIDATION_ERROR');assert.equal(e.statusCode,400);assert.equal(e.help,undefined);assert.equal(e.retryable,false);assert.equal(e.retryAfterMs,undefined);return true;});
  assert.equal(f.calls.begin,0);assert.equal(f.calls.search.length,0);assert.equal(f.calls.unregister,1);f.check();
  for(const aborted of [false,true]){const original=Object.freeze(new pureErrors.ValidationError('Round cancelled before dispatch.','kept help'));const x=await pureFixture({producer:false,runtimeError:original});x.deps.registerUserInterrupt=fn=>{if(aborted)fn();return()=>{x.calls.unregister++;};};await assert.rejects(x.handler(request,'memory',x.deps,x.host),e=>e===original);assert.equal(original.exitCode,1);assert.equal(x.calls.unregister,1);x.check();}
  const different=await pureFixture({producer:false});
  const initial=(await different.handler({...request,representations:[{format:'text',content:'Version 2.4.'}]},'memory',different.deps,different.host)).data;
  const manifest=await different.api.executeCallerInvestigation({schemaVersion:1,operation:'inspect',investigationRef:initial.investigationRef,collection:'evidence',maxChars:65536},{storeRoot:'memory'});const [evidence]=JSON.parse(manifest.content);assert(evidence);
  different.deps.registerUserInterrupt=fn=>{fn();return()=>{different.calls.unregister++;};};const beginBefore=different.calls.begin,searchBefore=different.calls.search.length;
  const altered={schemaVersion:1,operation:'continue',investigationRef:initial.investigationRef,expectedRevision:initial.revision,dataScope:'synthetic',proposals:[{requirementId:'version',definitionRevision:(await pureCollection(different,initial,'changes'))[0].definitions.version,mode:'string',value:'2.4',binding:{representationId:evidence.representationId,digest:evidence.digest,range:[0,12],quote:'Version 9.9.'}}]};
  await assert.rejects(different.handler(altered,'memory',different.deps,different.host),error=>error instanceof pureErrors.ValidationError&&error.code==='VALIDATION_ERROR'&&error.exitCode===1&&error.message==='Display quote/range does not bind unchanged evidence.');assert.equal(different.calls.begin,beginBefore);assert.equal(different.calls.search.length,searchBefore);different.check();
  let active;active=await pureFixture({producer:false,onSearch:()=>active.interrupt()});const settled=await active.handler(request,'memory',active.deps,active.host);assert(active.calls.search.length>0);assert.equal(settled.exitCode,130);assert.equal(settled.data.stopReason,'cancelled');assert.equal(settled.data.kind,'caller-assisted-investigation');assert.equal(active.calls.unregister,1);active.check();
  console.log(JSON.stringify({family:'F3',actualGuardBeforeBeginRound:true,retentionGuarantee:false,binding:f.binding}));
});

test('L7 pure F4: readonly secret ownership preserves runtime sink and redaction basis',async()=>{
  const judgeKey='pure-configured-judge-secret',runtimeKey='pure-runtime-secret';
  const request={schemaVersion:1,operation:'start',requirements:pureContract(),dataScope:'synthetic',representations:[{format:'text',content:'Version 2.4.'}]};
  const frozen=Object.freeze(['host-only-secret']),offline=await pureFixture({producer:false,secrets:frozen});const first=(await offline.handler(request,'memory',offline.deps,offline.host)).data;offline.host.env={TYPESAFE_API_KEY:judgeKey};
  await assert.doesNotReject(offline.handler({schemaVersion:1,operation:'inspect',investigationRef:first.investigationRef},'memory',offline.deps,offline.host),'readonly host secrets must support offline inspect');assert.deepEqual(frozen,['host-only-secret']);offline.check();
  for(const original of [Object.freeze(['host-only-secret']),['host-only-secret'],undefined,['host-only-secret',judgeKey]]){
    const before=original===undefined?undefined:[...original],forwarded=[];const f=await pureFixture({producer:false,secrets:original,env:{TYPESAFE_API_KEY:judgeKey},runtimeSecrets:[runtimeKey],onRuntimeSecrets:values=>forwarded.push(values)});f.host.secrets=original;
    const r=await f.handler({...request,representations:[{format:'text',content:`Version 2.4. ${judgeKey} ${runtimeKey}`}]},'memory',f.deps,f.host);
    assert.deepEqual(original,before,'operation must not mutate caller-owned secret list');const expected=[...new Set([...(original??[]),judgeKey,runtimeKey])],options={storeRoot:'memory',secrets:expected};
    const inspect=await f.api.executeCallerInvestigation({schemaVersion:1,operation:'inspect',investigationRef:r.data.investigationRef},options);assert.equal(r.data.redactionBasis,inspect.redactionBasis,'runtime-reported secrets must join the operation-owned caller redaction basis');
    assert.equal(forwarded.length,1);assert.equal(forwarded[0],f.calls.sink[0],'forward identical runtime-secret value to original sink');assert.deepEqual(forwarded[0],[runtimeKey]);
    const page=await f.api.executeCallerInvestigation({schemaVersion:1,operation:'inspect',investigationRef:r.data.investigationRef,collection:'evidence',maxChars:65536},options),[e]=JSON.parse(page.content);
    const body=await f.handler({schemaVersion:1,operation:'readEvidence',investigationRef:r.data.investigationRef,representationId:e.representationId,digest:e.digest,maxChars:65536},'memory',f.deps,{...f.host,secrets:Object.freeze(expected)});
    assert(body.data.content.includes('[REDACTED]'));assert(!body.data.content.includes(judgeKey));assert(!body.data.content.includes(runtimeKey));assert.equal(forwarded.length,1,'offline read must not initialize runtime');f.check();
  }
  console.log(JSON.stringify({family:'F4',frozenAndSharedListsPreserved:true,dynamicRuntimeBasisAndSink:true,binding:offline.binding}));
});


test('L7 A handler forwards validated latest baseline intent (input-only causal proof)',async()=>{
  const f=await pureFixture({producer:false,observeRuntimeInput:true});
  const baseline={...pureContract(),limits:{...pureContract().limits,maxUniqueReads:3}};
  const first=(await f.handler({schemaVersion:1,operation:'start',requirements:baseline,dataScope:'synthetic',roundLimits:{maxUniqueReads:1}},'memory',f.deps,f.host)).data;
  const retained=await f.rounds.readCallerRecord('memory',first.investigationRef);
  assert.equal(retained.contract.limits.maxUniqueReads,1);
  assert.equal(retained.baselineContract.limits.maxUniqueReads,3);
  const next=await f.handler({schemaVersion:1,operation:'continue',investigationRef:first.investigationRef,expectedRevision:first.revision,dataScope:'synthetic'},'memory',f.deps,f.host);
  assert.equal(next.data.revision,2,'actual delegate must execute and return the real round result');
  assert.equal(f.calls.runtimeInputs.length,2);
  assert.deepEqual(f.calls.runtimeInputs[1],retained.baselineContract,'forward validated intent, not the prior lowered episode (input-only RED)');
  assert.equal((await f.rounds.readCallerRecord('memory',first.investigationRef)).contract.limits.maxUniqueReads,3,'separate existing lower allowance restoration; no handler budget regression claimed');
  f.check();
});

test('L7 B exact event selector survives duplicate bodies and evidence cursors',async()=>{
  const f=await pureFixture({producer:false}),options={storeRoot:'memory'};
  const content='Version 2.4. '+ 'x'.repeat(3000);
  const first=(await f.handler({schemaVersion:1,operation:'start',requirements:pureContract(),dataScope:'synthetic',representations:[{format:'text',content,label:'first event',claimedSource:'https://unverified.test/first'},{format:'text',content,label:'second event',claimedSource:'https://unverified.test/second'}]},'memory',f.deps,f.host)).data;
  const page=await f.api.executeCallerInvestigation({schemaVersion:1,operation:'inspect',investigationRef:first.investigationRef,collection:'evidence',maxChars:65536},options);
  const [a,b]=JSON.parse(page.content);assert.notEqual(a.evidenceId,b.evidenceId);assert.equal(a.representationId,b.representationId);assert.equal(a.digest,b.digest);assert.notEqual(a.url,b.url);
  // Native-shaped refs carry a larger header than the old memory-* fixture.
  // This case proves event selection/paging; retain room for a progressing page.
  const read={schemaVersion:1,operation:'readEvidence',investigationRef:first.investigationRef,representationId:b.representationId,digest:b.digest,evidenceId:b.evidenceId,maxChars:2048};
  let selected;
  await assert.doesNotReject(async()=>{selected=await f.api.executeCallerInvestigation(read,options);},'new optional event selector must read the second exact duplicate event (feature RED)');
  assert.equal(selected.evidenceId,b.evidenceId);assert(selected.cursor);
  assert(JSON.stringify(selected).length<=read.maxChars);assert(selected.range[1]>selected.range[0]);assert(selected.content.length>0);
  const c=JSON.parse(Buffer.from(selected.cursor,'base64url'));assert.equal(c.e,b.evidenceId);
  const before=f.calls.begin,request={schemaVersion:1,operation:'continue',investigationRef:first.investigationRef,expectedRevision:first.revision,dataScope:'synthetic',proposals:[{requirementId:'version',definitionRevision:(await f.rounds.readCallerRecord('memory',first.investigationRef)).payload.definitions.version,mode:'string',value:'2.4',binding:{representationId:b.representationId,digest:b.digest,evidenceId:b.evidenceId,quote:'Version 2.4.',range:[0,12]}}]};
  for(const evidenceId of [undefined,'forged-event']){const bad=pureCopy(request);if(evidenceId===undefined)delete bad.proposals[0].binding.evidenceId;else bad.proposals[0].binding.evidenceId=evidenceId;await assert.rejects(f.handler(bad,'memory',f.deps,f.host),e=>e.code==='VALIDATION_ERROR');assert.equal(f.calls.begin,before);}
  await assert.rejects(f.api.executeCallerInvestigation({...read,evidenceId:a.evidenceId,cursor:selected.cursor},options));
  delete c.e;const legacy=Buffer.from(JSON.stringify(c)).toString('base64url');
  await assert.rejects(f.api.executeCallerInvestigation({...read,cursor:legacy},options),e=>e.code==='VALIDATION_ERROR','a request selector cannot authorize an ambiguous legacy cursor');
  await assert.rejects(f.api.executeCallerInvestigation({...read,evidenceId:undefined},options),e=>e.code==='VALIDATION_ERROR');
  const next=await f.handler(request,'memory',f.deps,f.host),record=await f.rounds.readCallerRecord('memory',first.investigationRef);
  assert.equal(next.data.revision,2);assert.equal(record.payload.proposals[0].evidenceId,b.evidenceId);assert.equal(record.payload.proposals[0].representationId,b.originalRepresentationId);
  assert.equal(record.payload.result.evidence.find(e=>e.evidenceId===b.evidenceId).url,b.url,'exact second event attribution survives lower projection');
  assert.deepEqual(record.payload.result.evidence.find(e=>e.evidenceId===b.evidenceId).suppliedProvenance,{claimedSource:'https://unverified.test/second',verification:'unverified'});
  const u=await pureFixture({producer:false});const h=(await u.handler({schemaVersion:1,operation:'start',requirements:pureContract(),dataScope:'synthetic',representations:[{format:'text',content}]},'memory',u.deps,u.host)).data;
  const [e]=JSON.parse((await u.api.executeCallerInvestigation({schemaVersion:1,operation:'inspect',investigationRef:h.investigationRef,collection:'evidence',maxChars:65536},options)).content);
  const unique=await u.api.executeCallerInvestigation({...read,investigationRef:h.investigationRef,representationId:e.representationId,digest:e.digest,evidenceId:undefined},options);
  const uc=JSON.parse(Buffer.from(unique.cursor,'base64url'));delete uc.e;
  assert.equal((await u.api.executeCallerInvestigation({...read,investigationRef:h.investigationRef,representationId:e.representationId,digest:e.digest,evidenceId:undefined,cursor:Buffer.from(JSON.stringify(uc)).toString('base64url')},options)).evidenceId,e.evidenceId);
  f.check();u.check();
});

async function pureDocumentAt(f,ref,pointer){return JSON.parse((await Promise.all(pointer.chunks.map(b=>f.store.readBody(ref,b.bodyId)))).map(b=>b.toString('utf8')).join(''));}
async function rewritePureCurrent(f, ref, mutate) {
  const { snapshot, pointer, state } = await (async()=>{const snapshot=(await f.store.inspect(ref)).committed.snapshot;const root=JSON.parse(snapshot.audit.at(-1).detail).root;const pointer=JSON.parse((await f.store.readBody(ref,root)).toString('utf8'));return {snapshot,pointer,state:await pureDocumentAt(f,ref,pointer.state)};})();
  const handle = await f.store.acquireOwnership(ref);
  const list = b => { if (!snapshot.bodies.some(x => x.bodyId === b.bodyId)) snapshot.bodies.push(b); };
  const stage = async text => {
    const chunks = [];
    for (let i = 0; i < text.length; i += 4096) {
      const b = await handle.stageBody(text.slice(i, i + 4096));
      const chunk = { bodyId: b.bodyId, digest: `sha256:${b.bodyId.slice(2)}`, bytes: b.bytes };
      chunks.push(chunk); list(chunk);
    }
    return { digest: `sha256:${pureHash(text)}`, chunks };
  };
  try {
    await mutate({ state, pointer, snapshot, stage, read: p => pureDocumentAt(f, ref, p) });
    pointer.state = await stage(JSON.stringify(state));
    const root = await handle.stageBody(JSON.stringify(pointer));
    list({ bodyId: root.bodyId, digest: `sha256:${root.bodyId.slice(2)}`, bytes: root.bytes });
    snapshot.audit = [{ at: 1, kind: 'definition-ref', detail: JSON.stringify({ schemaVersion: 1, root: root.bodyId }) }];
    await handle.commitRevision({ snapshot });
  } finally { await handle.release(); }
}


async function pureCollection(f,h,collection,secrets=[]){let cursor=h.cursors[collection],text='';do{const page=await f.api.executeCallerInvestigation({schemaVersion:1,operation:'inspect',investigationRef:h.investigationRef,revision:h.revision,collection,cursor,maxChars:1024},{storeRoot:'memory',secrets});text+=page.content;cursor=page.cursor;}while(cursor);return JSON.parse(text);}

test('L7 C selected recorded accounting includes modeled failed work and pages complete redacted definitions',async()=>{
  const secret='synthetic-definition-secret',f=await pureFixture({producer:false,secrets:[secret]});
  const c={...pureContract(),question:'Version and license?',scope:{entity:'Example',release:'2.4'},evidence:{criteria:['x'.repeat(1500)+secret]},requirements:{version:{question:'Version?',schema:{type:'string',minLength:1,maxLength:30},criteria:['Exact release.']},license:{question:'License?',schema:{type:'string'},dependsOn:['version']}},limits:{...pureContract().limits,maxUniqueReads:3}};
  const first=(await f.handler({schemaVersion:1,operation:'start',requirements:c,dataScope:'synthetic',roundLimits:{maxUniqueReads:1}},'memory',f.deps,f.host)).data;
  const historical=await f.rounds.readCallerRecord('memory',first.investigationRef,1);
  // Scalar memory recovery models measured failed-ACK work only. It proves projection,
  // not native ACK authority/durability; the real compiled lower fold stays unchanged.
  f.store.recoveryRecords=[{publicationState:'unpublished',work:{schemaVersion:1,measured:{searches:0,reads:2,judgments:0},status:'failed',settledAt:1,unavailableReason:null}}];
  const second=(await f.handler({schemaVersion:1,operation:'continue',investigationRef:first.investigationRef,expectedRevision:1,dataScope:'synthetic'},'memory',f.deps,f.host)).data;
  const recorded=await f.rounds.readCallerRecord('memory',first.investigationRef);
  assert.equal(recorded.payload.accounting.reads,2);assert.equal(recorded.payload.accounting.rounds,3);
  assert.deepEqual(second.cumulativeUsage,recorded.payload.accounting,'as-recorded selected accounting must include measured failed work, not sum only committed successes');
  assert.equal(second.cumulativeUsage.physicalAttempts,null);assert.equal(second.cumulativeUsage.knownSubtotal.physicalAttempts,0);
  const rows=await pureCollection(f,second,'changes',[secret]);const {revision,intent,...block}=rows[0];
  assert.deepEqual(block.contract,pureRedactor.redactSecrets(recorded.contract,[secret]));assert.deepEqual(block.definitions,recorded.payload.definitions);assert.deepEqual(block.baselineContract,pureRedactor.redactSecrets(recorded.baselineContract,[secret]));
  assert.equal(second.definitionViewId,'sha256:'+pureHash(JSON.stringify(block)));assert.equal(second.definitionsLocation,'changes');assert(!JSON.stringify(rows).includes(secret));
  assert.deepEqual((await f.rounds.readCallerRecord('memory',first.investigationRef,1)).payload,historical.payload);
  const old=await f.api.executeCallerInvestigation({schemaVersion:1,operation:'inspect',investigationRef:first.investigationRef,revision:1},{storeRoot:'memory',secrets:[secret]});
  assert.deepEqual(old.cumulativeUsage,historical.payload.accounting);assert.equal(Object.hasOwn((await pureCollection(f,old,'changes',[secret]))[0],'baselineContract'),false);
  await rewritePureCurrent(f,first.investigationRef,async({state,stage,read})=>{const entry=state.results.at(-1),payload=await read(entry.result);delete payload.accounting;entry.result=await stage(JSON.stringify(payload));});
  const legacy=await f.api.executeCallerInvestigation({schemaVersion:1,operation:'inspect',investigationRef:first.investigationRef},{storeRoot:'memory',secrets:[secret]});assert.equal(legacy.cumulativeUsage,null);assert.equal(legacy.accountingUnavailable,'not-retained');f.check();
});

test('L7 C complete selected definition context is accessible with its original proof tokens',async()=>{
  const f=await pureFixture({producer:false}),request={schemaVersion:1,operation:'start',requirements:pureContract(),dataScope:'synthetic'};
  const h=(await f.handler(request,'memory',f.deps,f.host)).data,record=await f.rounds.readCallerRecord('memory',h.investigationRef);
  const [row]=await pureCollection(f,h,'changes');
  assert.deepEqual(row.contract,record.contract,'changes must expose full selected executable meaning, not only hashes');
  assert.deepEqual(row.definitions,record.payload.definitions,'display identity never replaces original per-field proof revision tokens');
  const next=(await f.handler({schemaVersion:1,operation:'continue',investigationRef:h.investigationRef,expectedRevision:h.revision,dataScope:'synthetic',requirements:{...pureContract(),question:'Changed version meaning?'}},'memory',f.deps,f.host)).data;
  const [changed]=await pureCollection(f,next,'changes');
  assert.notEqual(changed.definitions.version,row.definitions.version,'changed meaning must change original proof binding, not just display identity');f.check();
});

test('L7 D mutation header minimum refuses before factory and library work',async()=>{
  const f=await pureFixture({producer:false});let factories=0;
  const original=f.deps.requirementsRuntime;f.deps.requirementsRuntime=(...args)=>{factories++;return Reflect.apply(original,f.deps,args);};
  const request={schemaVersion:1,operation:'start',requirements:pureContract(),dataScope:'synthetic',maxChars:8191};let error;
  try{await f.handler(request,'memory',f.deps,f.host);}catch(e){error=e;}
  assert.equal(factories,0,'below8192 mutation must refuse before actual runtime factory');
  assert.equal(f.calls.create,0);assert.equal(f.calls.begin,0);assert.equal(error?.code,'VALIDATION_ERROR');
  await assert.rejects(f.api.executeCallerInvestigation(request,{storeRoot:'memory',deps:{search:async()=>{throw new Error('no paid work');},read:async()=>'',judge:null}}),e=>e.code==='VALIDATION_ERROR');assert.equal(f.calls.create,0);
  const h=(await f.handler({...request,maxChars:8192},'memory',f.deps,f.host)).data;assert.equal(h.schemaVersion,2);assert(JSON.stringify(h).length<=8192);
  const keys=['kind','schemaVersion','investigationRef','revision','committedRevision','viewId','redactionBasis','round','status','stopReason','stopReasonIncomplete','stopReasonLocation','fulfillment','definitionViewId','definitionsLocation','usage','usageIncomplete','usageLocation','physical','cumulativeUsage','metadataIncomplete','contentIncomplete','collectionIncomplete','counts','cursors','resultSha256'];
  assert.deepEqual(Object.keys(h).sort(),keys.sort());assert.equal(Object.keys(h.cursors).length,7);assert.equal(Object.keys(h.collectionIncomplete).length,7);for(const key of Object.keys(h.counts))assert.equal(h.collectionIncomplete[key],h.counts[key]>0);f.check();
});

test('L7 D accepted legacy detail stays paged under bounded exact usage and stop headers',async()=>{
  const f=await pureFixture({producer:false}),id='a'.repeat(256),secret='synthetic-legacy-secret';
  const c={...pureContract(),requirements:{[id]:{question:'Version?',schema:{type:'string'},criteria:['meaning '+secret]}}};
  const lower=await f.rounds.startCallerRound({storeRoot:'memory',contract:c,deps:{search:async()=>[],read:async()=>'',judge:null,now:()=>0}});
  await rewritePureCurrent(f,lower.investigationRef,async({state,stage,read})=>{const entry=state.results.at(-1),payload=await read(entry.result);payload.result.usage.legacyDetail='\\"'.repeat(12000)+secret;payload.result.usage.extractorCacheHits='unknown-legacy';payload.stopReason='legacy stop '+secret+' '.repeat(10000);entry.result=await stage(JSON.stringify(payload));});
  const recorded=await f.rounds.readCallerRecord('memory',lower.investigationRef),options={storeRoot:'memory',secrets:[secret]};let h;
  await assert.doesNotReject(async()=>{h=await f.api.executeCallerInvestigation({schemaVersion:1,operation:'inspect',investigationRef:lower.investigationRef,maxChars:8192},options);},'accepted legacy strings must not overflow the bounded header');
  assert.equal(h.stopReason,'unrecognized-retained-stop');assert.equal(h.stopReasonIncomplete,true);assert.equal(h.stopReasonLocation,'assessments');assert.equal(h.usage.extractorCacheHits,null);assert.equal(h.usageIncomplete,true);assert.equal(h.usageLocation,'assessments');assert.equal(Object.keys(h.usage).length,7);assert(JSON.stringify(h).length<=8192);
  const [detail]=await pureCollection(f,h,'assessments',[secret]);assert.deepEqual(detail.usage,pureRedactor.redactSecrets(recorded.payload.result.usage,[secret]));assert.equal(detail.stopReason,pureRedactor.redactSecrets(recorded.payload.stopReason,[secret]));assert(!JSON.stringify(detail).includes(secret));
  const [definitions]=await pureCollection(f,h,'changes',[secret]);assert.deepEqual(definitions.contract,pureRedactor.redactSecrets(recorded.contract,[secret]));assert.equal(Object.keys(definitions.definitions)[0],id);
  const cursorKeys=Object.keys(h.cursors);for(const key of cursorKeys){const cursor=JSON.parse(Buffer.from(h.cursors[key],'base64url'));assert.equal(cursor.c,key);assert.equal(cursor.v,1);}f.check();
});

test('L7 E public ID bytes reject before factory, preserve legacy reads and allow compatible replacement',async()=>{
  const f=await pureFixture({producer:false});let factories=0;const actual=f.deps.requirementsRuntime;f.deps.requirementsRuntime=(...args)=>{factories++;return Reflect.apply(actual,f.deps,args);};
  const doc=id=>({...pureContract(),requirements:{[id]:{question:'Version?',schema:{type:'string'}}}}),request=requirements=>({schemaVersion:1,operation:'start',requirements,dataScope:'synthetic'});
  let error;try{await f.handler(request(doc('a'.repeat(129))),'memory',f.deps,f.host);}catch(e){error=e;}
  assert.equal(factories,0,'129-byte public key must refuse before runtime factory');assert.equal(f.calls.create,0);assert.equal(error?.code,'VALIDATION_ERROR');
  for(const id of ['a','a'.repeat(64),'release_version-1']){const h=(await f.handler(request(doc(id)),'memory',f.deps,f.host)).data;assert.equal(h.revision,1);}
  for(const id of ['release.version','a'.repeat(65),'a'.repeat(128),'é'.repeat(64),'a'.repeat(129),'é'.repeat(65)]){const before=factories,created=f.calls.create,begun=f.calls.begin;await assert.rejects(f.handler(request(doc(id)),'memory',f.deps,f.host),e=>e.code==='VALIDATION_ERROR');assert.equal(factories,before);assert.equal(f.calls.create,created);assert.equal(f.calls.begin,begun);}
  // Broad IDs remain supported by explicit replacement/legacy contracts, not new native starts.
  for(const id of ['a'.repeat(128),'é'.repeat(64)]){const seed=await f.rounds.startCallerRound({storeRoot:'memory',contract:doc('compatible'),deps:{search:async()=>[],read:async()=>'',judge:null,now:()=>0}});const h=(await f.handler({schemaVersion:1,operation:'continue',investigationRef:seed.investigationRef,expectedRevision:1,requirements:doc(id),dataScope:'synthetic'},'memory',f.deps,f.host)).data;assert.equal(h.revision,2);const [block]=await pureCollection(f,h,'changes');assert(Object.hasOwn(block.contract.requirements,id));}
  const legacy=await f.rounds.startCallerRound({storeRoot:'memory',contract:doc('é'.repeat(65)),deps:{search:async()=>[],read:async()=>'',judge:null,now:()=>0}});
  const base={schemaVersion:1,operation:'continue',investigationRef:legacy.investigationRef,expectedRevision:legacy.handoff.revision,dataScope:'synthetic'};
  const before=factories;
  await assert.rejects(f.handler(base,'memory',f.deps,f.host),e=>e.code==='VALIDATION_ERROR'&&/replacement/i.test(e.message));assert.equal(factories,before);
  await assert.rejects(f.api.executeCallerInvestigation(base,{storeRoot:'memory',deps:{search:async()=>{throw new Error('no work');},read:async()=>'',judge:null}}),e=>e.code==='VALIDATION_ERROR');
  assert.equal((await f.handler({schemaVersion:1,operation:'inspect',investigationRef:legacy.investigationRef},'memory',f.deps,f.host)).data.revision,1);
  await assert.rejects(f.handler({...base,requirements:doc('a'.repeat(129))},'memory',f.deps,f.host),e=>e.code==='VALIDATION_ERROR');assert.equal(factories,before);
  const next=(await f.handler({...base,requirements:doc('compatible')},'memory',f.deps,f.host)).data;assert.equal(next.revision,2);f.check();
});


test('L7 D legacy maximum field keys and escaped full definitions leave seven bounded cursors',async()=>{
 const f=await pureFixture({producer:false});
 const ids=['a'.repeat(128),'é'.repeat(64),'c'.repeat(128)],escaped='"\\\n😀'.repeat(200);
 const c={...pureContract(),requirements:Object.fromEntries(ids.map(id=>[id,{question:'Version '+escaped,schema:{type:'string'},criteria:['Criterion '+escaped]}]))};
 const legacy=await f.rounds.startCallerRound({storeRoot:'memory',contract:c,deps:{search:async()=>[],read:async()=>'',judge:null,now:()=>0}});
 const h=(await f.handler({schemaVersion:1,operation:'inspect',investigationRef:legacy.investigationRef,maxChars:8192},'memory',f.deps,f.host)).data;
 assert(JSON.stringify(h).length<=8192);assert.equal(h.fulfillment.total,3);assert.equal(h.schemaVersion,2);assert.equal(h.definitions,undefined);
 const [block]=await pureCollection(f,h,'changes');assert.deepEqual(block.contract,(await f.rounds.readCallerRecord('memory',h.investigationRef)).contract);
 for(const id of ids)assert.equal(block.contract.requirements[id].question,'Version '+escaped);
 for(const collection of Object.keys(h.counts)){const decoded=JSON.parse(Buffer.from(h.cursors[collection],'base64url'));assert.deepEqual(Object.keys(decoded).sort(),['v','r','h','b','c','o'].sort());assert.equal(decoded.c,collection);assert.equal(decoded.r,h.committedRevision);}
 assert.equal(Object.keys(h.usage).length,7);assert(Object.values(h.usage).every(n=>n===null||Number.isSafeInteger(n)&&n>=0));f.check();
});

test('promotion fixture references remain native-shaped and distinct after deletion',async()=>{
  const f=await pureFixture({producer:false}),one=await f.store.createInvestigation();
  await f.store.deleteInvestigation(one.investigationRef);const two=await f.store.createInvestigation();
  assert.match(one.investigationRef,/^inv_[0-9a-f]{32}$/);assert.match(two.investigationRef,/^inv_[0-9a-f]{32}$/);assert.notEqual(one.investigationRef,two.investigationRef);f.check();
});

test('promotion handler passes the complete ordered normalized profile to actual continuation formatter',async()=>{
  const initial=['environment-secret-value','config-secret-value','duplicate-secret-value'];
  const runtime=['runtime-secret-value','duplicate-secret-value',' \t ','runtime-secret-value'];
  const f=await pureFixture({producer:false,secrets:Object.freeze(initial),env:Object.freeze({TYPESAFE_API_KEY:'judge-secret-value'}),runtimeSecrets:Object.freeze(runtime)});
  const h=(await f.handler({schemaVersion:1,operation:'start',requirements:pureContract(),dataScope:'synthetic'},'memory',f.deps,f.host)).data;
  const next=(await f.handler({schemaVersion:1,operation:'continue',investigationRef:h.investigationRef,expectedRevision:1,dataScope:'synthetic'},'memory',f.deps,f.host)).data;
  assert.equal(next.revision,2);assert.equal(f.calls.formatSecrets.length,1);
  const normalized=list=>[...new Set(list.filter(v=>typeof v==='string'&&v.length&&v.trim().length))];
  const expected=[...initial,'judge-secret-value','runtime-secret-value'];
  assert.deepEqual(normalized(f.calls.formatSecrets[0]),expected);assert.deepEqual(normalized([...initial,'judge-secret-value',...f.calls.sink.at(-1)]),expected);
  assert.deepEqual(initial,['environment-secret-value','config-secret-value','duplicate-secret-value']);assert.deepEqual(runtime,['runtime-secret-value','duplicate-secret-value',' \t ','runtime-secret-value']);f.check();
});

test('promotion pre-return and post-return non-projection failures retain their classifications',async()=>{
  const cases=[];
  for(const kind of ['runtime','release','view-read']){
    const marker=Object.assign(new Error('synthetic '+kind+' failure'),{code:'FILE_ERROR'}),f=await pureFixture({producer:false,...(kind==='runtime'?{runtimeError:marker}:{})});
    const acquire=f.store.acquireOwnership.bind(f.store),inspect=f.store.inspect.bind(f.store);
    if(kind==='release')f.store.acquireOwnership=async ref=>{const h=await acquire(ref);return {...h,release:async()=>{if((await inspect(ref)).committed.snapshot.revision>0)throw marker;return h.release();}};}; // committed but no successful round return
    if(kind==='view-read')f.store.inspect=async ref=>{const value=await inspect(ref);if(value.committed.snapshot.revision>0)throw marker;return value;};
    let error;try{await f.handler({schemaVersion:1,operation:'start',requirements:pureContract(),dataScope:'synthetic'},'memory',f.deps,f.host);}catch(e){error=e;}
    cases.push({kind,error,same:error===marker});
  }
  console.log(JSON.stringify({case:'promotion failure boundaries',rows:cases.map(x=>({kind:x.kind,code:x.error?.code,message:x.error?.message,same:x.same}))}));
  for(const x of cases){assert.equal(x.error?.code,'FILE_ERROR');assert.equal(x.same,true);assert.ok(!x.error.message.includes('round committed'));assert.equal(x.error.help,undefined);}
});

async function promotionMainCase(source,marker='partial',id='version') {
  const {main}=await import('../dist/index.js'),{hermeticMainDeps}=await import('./helpers/hermetic-main.js');
  const {createTavilyDescriptor}=await import('../dist/providers/tavily/adapter.js');
  const {readCallerRecord}=await import('../dist/lib/lean-caller-rounds.js');
  const dir=await mkdtemp(join(tmpdir(),'promotion-caller-main-')),storeRoot=join(dir,'store'),stdout=[],stderr=[],http=[];
  let factories=0,configs=0;
  const env=Object.freeze({SCOUTLINE_INVESTIGATIONS_DIR:storeRoot,SCOUTLINE_CONFIG_DIR:join(dir,'config'),SCOUTLINE_CACHE_DIR:join(dir,'cache'),SCOUTLINE_ARTIFACTS_DIR:join(dir,'artifacts'),
    ...(source==='configuration'?{}:{TAVILY_API_KEY:source==='environment'?marker:'environment-synthetic-secret'}),
    ...(source==='merged'?{TYPESAFE_API_KEY:'judge-synthetic-secret',SCOUTLINE_JUDGE_TRANSMIT:'1'}:{})});
  const configured=Object.freeze({version:1,providers:source==='configuration'?{tavily:{apiKey:marker}}:source==='merged'?{minimax:{apiKey:'configuration-synthetic-secret'}}:{}});
  const before=JSON.stringify({env,configured});
  const runtimeSecrets=Object.freeze(source==='runtime'?[marker]:source==='merged'?[marker,'runtime-synthetic-secret','environment-synthetic-secret']:[]);
  const deps=hermeticMainDeps({env,loadScoutlineConfig:async()=>{configs++;return configured;},
    invocation:{stdoutIsTTY:false,stdinIsTTY:false,readStdin:async()=>'',writeStdout:s=>stdout.push(s),writeStderr:s=>stderr.push(s),runQuietly:async f=>f(),setExitCode:()=>{}},
    requirementsRuntime:context=>{
      factories++;
      const transport={env:context.env,fetch:async(url,init={})=>{
        const target=String(url);http.push({url:target,method:init.method??'GET'});
        if(target==='https://api.tavily.com/search')return Response.json({results:[{url:'https://example.test/promotion',title:'ExampleApp',content:'ExampleApp version 2.4.0.'}]});
        if(target==='https://api.tavily.com/extract'){const b=JSON.parse(init.body);return Response.json({results:b.urls.map(url=>({url,raw_content:'ExampleApp version 2.4.0.'})),failed_results:[]});}
        throw new Error('Unexpected promotion fixture HTTP');
      }};
      const descriptor=createTavilyDescriptor({transport});
      return {acquisitionOptions:{searchDescriptor:descriptor,readerDescriptor:descriptor,transports:{tavily:transport},descriptorFactory:(_id,t)=>createTavilyDescriptor({transport:t}),env:context.env,cache:context.cache,sleep:context.sleep,random:context.random,maxPhysicalAttempts:48},engineDeps:{judge:null,candidateJudge:null},secrets:runtimeSecrets};
    }});
  const requirements={...pureContract(),requirements:{[id]:{question:'Version?',schema:{type:'string'}}}};
  try {
    const code=await main(['investigate','--provider','tavily','--caller-request-json',JSON.stringify({schemaVersion:1,operation:'start',requirements,dataScope:'synthetic'}),'--no-cache'],deps);
    const refs=(await fsPromises.readdir(join(storeRoot,'investigations')).catch(e=>{if(e.code==='ENOENT')return [];throw e;})).filter(n=>/^inv_[0-9a-f]{32}$/.test(n));
    const records=[];for(const ref of refs)records.push(await readCallerRecord(storeRoot,ref));
    return {source,marker,id,code,stdout:stdout.join(''),stderr:stderr.join(''),http,factories,configs,refs,records,inputsUnchanged:before===JSON.stringify({env,configured}),runtimeSecrets};
  } finally {await rm(dir,{recursive:true,force:true});}
}

test('promotion compiled main delivers exact recovery across environment config and runtime profiles',async()=>{
  const rows=[];for(const source of ['environment','configuration','runtime','merged'])rows.push(await promotionMainCase(source));
  console.log(JSON.stringify({case:'promotion compiled recovery',rows:rows.map(x=>({source:x.source,code:x.code,http:x.http.length,factories:x.factories,refs:x.refs,revisions:x.records.map(r=>r.revision),stdout:x.stdout,stderr:x.stderr,inputsUnchanged:x.inputsUnchanged}))}));
  for(const x of rows){const error=JSON.parse(x.stderr);assert.equal(x.stdout,'');assert.equal(x.code,1);assert.equal(error.code,'VALIDATION_ERROR');assert.equal(error.error,'Caller round committed; do not repeat the mutation.');assert.equal(x.refs.length,1);assert.equal(x.records[0].revision,1);assert.equal(x.records[0].snapshot.rounds.length,1);assert.ok(x.http.length>0);assert.equal(error.help,JSON.stringify({investigationRef:x.refs[0],revision:1,operation:'inspect'}));assert(!x.stderr.includes('partial'));assert.equal(x.inputsUnchanged,true);}
});

test('promotion compiled admission refuses dangerous profile contributions and invalid IDs without HTTP',async()=>{
  const rows=[];
  for(const source of ['environment','configuration','runtime'])rows.push(await promotionMainCase(source,'committed'));
  for(const marker of ['"investigationRef":"inv_','f'.repeat(32)])rows.push(await promotionMainCase('environment',marker));
  for(const id of ['release.version','a'.repeat(65),'é'.repeat(64)])rows.push(await promotionMainCase('environment','synthetic-acquisition-key',id));
  console.log(JSON.stringify({case:'promotion compiled refusal',rows:rows.map(x=>({source:x.source,bytes:Buffer.byteLength(x.id),code:x.code,http:x.http.length,factories:x.factories,configs:x.configs,refs:x.refs,stdout:x.stdout,stderr:x.stderr}))}));
  for(const x of rows){assert.equal(x.stdout,'');assert.equal(x.code,1);assert.equal(JSON.parse(x.stderr).code,'VALIDATION_ERROR');assert.equal(x.http.length,0);assert.deepEqual(x.refs,[]);assert.equal(x.inputsUnchanged,true);if(x.id!=='version'){assert.equal(x.configs,0);assert.equal(x.factories,0);assert.equal(JSON.parse(x.stderr).error,'Caller start requirement IDs must match [A-Za-z0-9_-]{1,64}.');}else{assert.equal(x.factories,1);assert.equal(JSON.parse(x.stderr).error,'Caller view unavailable under the active redaction profile.');}}
});
