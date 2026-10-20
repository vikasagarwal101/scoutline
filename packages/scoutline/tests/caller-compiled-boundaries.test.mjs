import test from 'node:test';
import assert from 'node:assert/strict';
import { sandbox,bin,contract,noHTTP,output } from './helpers/caller-review-harness.mjs';
const start={schemaVersion:1,operation:'start',requirements:contract,dataScope:'synthetic'};
test('compiled preflight: closed request/private/binary/header limits reject with zero native HTTP',async()=>{
  const state=await sandbox();
  const invalid=[
    {...start,schemaVersion:2}, {...start,unknown:true}, {...start,dataScope:'private'},
    {...start,maxChars:8191}, {...start,maxChars:1023}, {...start,maxChars:65537}, {...start,maxChars:NaN},
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

const EARLY_JUDGE_KEY='caller-judge-secret-47';
async function earlyJudgeMain(transport,request,state) {
  state??=await sandbox();
  const {join}=await import('node:path'),{writeFile,access}=await import('node:fs/promises'),{main}=await import('../dist/index.js'),{hermeticMainDeps}=await import('./helpers/hermetic-main.js');
  const env=Object.freeze({SCOUTLINE_CONFIG_DIR:state.env.SCOUTLINE_CONFIG_DIR,SCOUTLINE_ARTIFACTS_DIR:state.env.SCOUTLINE_ARTIFACTS_DIR,SCOUTLINE_CACHE_DIR:state.env.SCOUTLINE_CACHE_DIR,SCOUTLINE_INVESTIGATIONS_DIR:join(state.path,'early-records'),TYPESAFE_API_KEY:EARLY_JUDGE_KEY}),envBefore={...env};
  const counts={config:0,runtime:0,http:0,stdin:0},stdout=[],stderr=[],text=JSON.stringify(request);
  let args;
  if(transport==='inline')args=['investigate','--caller-request-json',text];
  else if(transport==='file'){const file=join(state.path,'early-caller-request.json');await writeFile(file,text);args=['investigate','--caller-request',file];}
  else{assert.equal(transport,'injected-stdin');args=['investigate','--caller-request','-'];}
  const deps=hermeticMainDeps({env,loadScoutlineConfig:async()=>{counts.config++;throw new Error('early caller must not load config');},requirementsRuntime:()=>{counts.runtime++;throw new Error('early caller must not construct runtime');},invocation:{stdoutIsTTY:false,stdinIsTTY:false,environmentOutputMode:'data',readStdin:async(maxBytes,signal)=>{counts.stdin++;assert(maxBytes>0);assert(signal instanceof AbortSignal);return text;},writeStdout:s=>stdout.push(s),writeStderr:s=>stderr.push(s),runQuietly:async fn=>fn(),setExitCode:()=>{}}});
  const original=globalThis.fetch;globalThis.fetch=async()=>{counts.http++;throw new Error('synthetic early caller HTTP forbidden');};let code;
  try{code=await main(args,deps);}finally{globalThis.fetch=original;}
  const recordRootExists=await access(env.SCOUTLINE_INVESTIGATIONS_DIR).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;});
  assert.deepEqual({...env},envBefore,'main must preserve the frozen injected environment');
  return {state,env,envBefore,counts,code,stdout:stdout.join(''),stderr:stderr.join(''),recordRootExists};
}
for(const transport of ['inline','file','injected-stdin'])test('review early judge-key preflight: '+transport,async()=>{
  const requirements=structuredClone(contract);requirements[EARLY_JUDGE_KEY]=true;
  const r=await earlyJudgeMain(transport,{...start,requirements});
  assert.notEqual(r.code,0);assert.equal(r.stdout,'');const error=JSON.parse(r.stderr);assert.equal(error.success,false);assert.equal(error.code,'VALIDATION_ERROR');assert.match(error.error,/requirements declare unsupported key "/);assert.match(error.error,/strict subset; unknown declarations are rejected, not dropped/);
  assert.deepEqual(r.counts,{config:0,runtime:0,http:0,stdin:transport==='injected-stdin'?1:0});assert.equal(r.recordRootExists,false,'malformed input must not create an investigation store');
  console.log(JSON.stringify({case:'early judge-key',transport,stdinWitness:transport==='injected-stdin'?'injected function; not native pipe':'not used',code:r.code,stdout:r.stdout,stderr:r.stderr,counts:r.counts,recordRootExists:r.recordRootExists}));
  assert(!r.stdout.includes(EARLY_JUDGE_KEY)&&!r.stderr.includes(EARLY_JUDGE_KEY),'early '+transport+' error must redact the injected judge key from BOTH streams');assert(r.stderr.includes('[REDACTED]'));
});
test('review early judge-key offline compatibility preserves record and ordinary output',async()=>{
  const state=await sandbox(),{join}=await import('node:path'),{executeCallerInvestigation}=await import('../dist/lib/caller-investigation.js'),{readCallerRecord}=await import('../dist/lib/lean-caller-rounds.js');
  const storeRoot=join(state.path,'early-records'),requirements={schemaVersion:1,question:'ordinary-visible metadata '+EARLY_JUDGE_KEY,requirements:{v:{question:'Value?',schema:{type:'string'}}}};
  const created=await executeCallerInvestigation({schemaVersion:1,operation:'start',requirements,dataScope:'synthetic'},{storeRoot,deps:{search:async()=>[],read:async()=>{throw new Error('no setup source');},judge:null,now:()=>0}});
  const before=await readCallerRecord(storeRoot,created.investigationRef);
  const r=await earlyJudgeMain('inline',{schemaVersion:1,operation:'inspect',investigationRef:created.investigationRef,collection:'changes',maxChars:65536},state);
  assert.equal(Object.hasOwn(r.env,'TAVILY_API_KEY'),false);assert.equal(Object.hasOwn(r.env,'SCOUTLINE_JUDGE_TRANSMIT'),false);assert.equal(r.code,0,r.stderr);assert.equal(r.stderr,'');assert.deepEqual(r.counts,{config:0,runtime:0,http:0,stdin:0});
  assert(!r.stdout.includes(EARLY_JUDGE_KEY)&&!r.stderr.includes(EARLY_JUDGE_KEY));const page=JSON.parse(r.stdout);assert.equal(page.kind,'caller-assisted-page');assert.equal(page.schemaVersion,2);assert.equal(JSON.parse(page.content)[0].contract.question,'ordinary-visible metadata [REDACTED]');assert.equal(page.revision,before.revision);
  assert.deepEqual(await readCallerRecord(storeRoot,created.investigationRef),before,'offline main call must not mutate the setup record');console.log(JSON.stringify({case:'early judge-key offline',setup:'actual native API/store with synthetic no-network deps; separate from offline counts',counts:r.counts,revision:page.revision,ordinaryTextPreserved:true}));
});

const interruptRequirements={...contract,requirements:{csv:contract.requirements.csv}};
async function interruptMain({request={...start,requirements:interruptRequirements},state,handlerError,configError,releaseError}={}) {
  state??=await sandbox();
  const {main}=await import('../dist/index.js'),{hermeticMainDeps}=await import('./helpers/hermetic-main.js');
  const counts={register:0,release:0,config:0,runtime:0,http:0},stdout=[],stderr=[],atRelease=[];
  const duplicate=new Error('outer caller interrupt released twice');
  const deps=hermeticMainDeps({env:{...state.env},loadScoutlineConfig:async()=>{counts.config++;if(configError)throw configError;return {version:1,providers:{}};},requirementsUserInterrupt:listener=>{
    counts.register++;assert.equal(typeof listener,'function');
    return ()=>{counts.release++;atRelease.push({stdout:stdout.join(''),stderr:stderr.join('')});if(counts.release>1)throw duplicate;if(releaseError)throw releaseError;};
  },invocation:{stdoutIsTTY:false,stdinIsTTY:false,environmentOutputMode:'data',readStdin:async()=>{throw new Error('unexpected stdin');},writeStdout:s=>stdout.push(s),writeStderr:s=>stderr.push(s),runQuietly:async fn=>fn(),setExitCode:()=>{}}});
  if(handlerError)deps.requirementsRuntime=()=>{counts.runtime++;throw handlerError;};
  const original=globalThis.fetch;
  globalThis.fetch=async(url,init={})=>{
    counts.http++;const target=String(url),text='ExampleApp release 2.4.0. CSV export is supported.';
    if(target==='https://api.tavily.com/search')return Response.json({results:[{title:'ExampleApp release',url:'https://example.test/release',content:text}]});
    if(target==='https://api.tavily.com/extract'){const body=JSON.parse(init.body);return Response.json({results:body.urls.map(url=>({url,raw_content:text})),failed_results:[]});}
    if(target==='https://api.typesafe.ai/v1/systemone'){const body=JSON.parse(init.body);return Response.json({model:'jev-1.13.0',answers:Object.fromEntries(Object.keys(body.questions).map(k=>[k,{type:'noul',noul:/[fc]$/.test(k)?0.05:0.95}])),usage:{input_tokens:1,output_tokens:1}});}
    throw new Error('Unexpected synthetic interrupt HTTP: '+target);
  };
  let code,caught;
  try{code=await main(['investigate','--caller-request-json',JSON.stringify(request)],deps);}catch(error){caught=error;}finally{globalThis.fetch=original;}
  assert.equal(globalThis.fetch,original,'restore actual fetch even when main cleanup throws');
  return {state,counts,stdout:stdout.join(''),stderr:stderr.join(''),atRelease,code,caught,duplicate};
}
test('review caller interrupt once: settled success',async()=>{
  const r=await interruptMain(),data=JSON.parse(r.stdout),{readCallerRecord}=await import('../dist/lib/lean-caller-rounds.js');
  assert.equal(r.stderr,'');assert.equal(data.kind,'caller-assisted-investigation');assert.equal(data.status,'complete');assert.equal(data.revision,1);assert.equal((await readCallerRecord(r.state.env.SCOUTLINE_INVESTIGATIONS_DIR,data.investigationRef)).revision,1);
  assert.equal(r.counts.register,1);assert.equal(r.counts.config,1);assert(r.counts.http>0,'actual native acquisition/judging completed');assert.equal(r.atRelease[0].stdout,r.stdout);
  console.log(JSON.stringify({case:'interrupt success',counts:r.counts,revision:data.revision,status:data.status,code:r.code,caught:r.caught?.message,settledBeforeRelease:r.atRelease[0]}));
  assert.equal(r.caught,undefined,'settled success must not reject from a duplicate unregister');assert.equal(r.code,0);assert.equal(r.counts.release,1);
});
test('review caller interrupt once: formatted handler error',async()=>{
  const {ScoutlineError}=await import('../dist/lib/errors.js'),original=new ScoutlineError('synthetic caller handler failure','VALIDATION_ERROR',{exitCode:1});
  const r=await interruptMain({handlerError:original}),error=JSON.parse(r.stderr);
  assert.equal(r.stdout,'');assert.equal(error.success,false);assert.equal(error.code,original.code);assert.equal(error.error,original.message);assert.equal(r.atRelease[0].stderr,r.stderr);assert.deepEqual({...r.counts,release:0},{register:1,release:0,config:1,runtime:1,http:0});
  console.log(JSON.stringify({case:'interrupt formatted handler error',counts:r.counts,code:r.code,caught:r.caught?.message,settledBeforeRelease:r.atRelease[0]}));
  assert.equal(r.caught,undefined,'formatted handler error must keep its settled response after unregister');assert.equal(r.code,original.exitCode);assert.equal(r.counts.release,1);
});
test('review caller interrupt compatibility: malformed input releases before work',async()=>{
  const r=await interruptMain({request:{...start,schemaVersion:2}}),error=JSON.parse(r.stderr),{access}=await import('node:fs/promises');
  assert.equal(r.caught,undefined);assert.equal(r.code,1);assert.equal(r.stdout,'');assert.equal(error.code,'VALIDATION_ERROR');assert.match(error.error,/schemaVersion/);assert.deepEqual(r.counts,{register:1,release:1,config:0,runtime:0,http:0});
  await assert.rejects(access(r.state.env.SCOUTLINE_INVESTIGATIONS_DIR),e=>e.code==='ENOENT');
});
test('review caller interrupt compatibility: credential-free offline read releases once',async()=>{
  const state=await sandbox(),{executeCallerInvestigation}=await import('../dist/lib/caller-investigation.js'),{readCallerRecord}=await import('../dist/lib/lean-caller-rounds.js');
  const created=await executeCallerInvestigation({...start,requirements:interruptRequirements},{storeRoot:state.env.SCOUTLINE_INVESTIGATIONS_DIR,deps:{search:async()=>[],read:async()=>{throw new Error('unexpected setup read');},judge:null,now:()=>0}});
  const before=await readCallerRecord(state.env.SCOUTLINE_INVESTIGATIONS_DIR,created.investigationRef),env={...state.env};delete env.TAVILY_API_KEY;delete env.TYPESAFE_API_KEY;delete env.SCOUTLINE_JUDGE_TRANSMIT;
  const r=await interruptMain({state:{...state,env},request:{schemaVersion:1,operation:'inspect',investigationRef:created.investigationRef}});
  assert.equal(r.caught,undefined);assert.equal(r.code,0);assert.equal(r.stderr,'');assert.equal(JSON.parse(r.stdout).revision,before.revision);assert.deepEqual(r.counts,{register:1,release:1,config:0,runtime:0,http:0});assert.deepEqual(await readCallerRecord(env.SCOUTLINE_INVESTIGATIONS_DIR,created.investigationRef),before);
});
test('review caller interrupt compatibility: config failure releases once',async()=>{
  const {ScoutlineError}=await import('../dist/lib/errors.js'),original=new ScoutlineError('synthetic caller config failure','CONFIGURATION_ERROR',{exitCode:3});
  const r=await interruptMain({configError:original}),error=JSON.parse(r.stderr),{access}=await import('node:fs/promises');
  assert.equal(r.caught,undefined);assert.equal(r.code,original.exitCode);assert.equal(r.stdout,'');assert.equal(error.code,original.code);assert.equal(error.error,original.message);assert.deepEqual(r.counts,{register:1,release:1,config:1,runtime:0,http:0});await assert.rejects(access(r.state.env.SCOUTLINE_INVESTIGATIONS_DIR),e=>e.code==='ENOENT');
});
test('review caller interrupt compatibility: first cleanup throwable retains identity',async()=>{
  const original=new Error('first outer interrupt cleanup failure'),r=await interruptMain({releaseError:original}),data=JSON.parse(r.stdout),{readCallerRecord}=await import('../dist/lib/lean-caller-rounds.js');
  assert.equal(r.caught,original,'the first cleanup error must propagate without being replaced or swallowed');assert.equal(r.code,undefined);assert.equal(r.stderr,'');assert.equal(data.status,'complete');assert.equal((await readCallerRecord(r.state.env.SCOUTLINE_INVESTIGATIONS_DIR,data.investigationRef)).revision,data.revision);assert.equal(r.counts.register,1);assert.equal(r.counts.release,1);assert(r.counts.http>0);assert.equal(r.atRelease[0].stdout,r.stdout);
  console.log(JSON.stringify({case:'first interrupt cleanup throwable',message:r.caught.message,release:r.counts.release,settledRevision:data.revision}));
});
