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
  const deps=hermeticMainDeps({env,loadScoutlineConfig:async()=>{counts.config++;if(['inspect','readEvidence'].includes(request.operation))return {version:1,providers:{}};throw new Error('early caller must not load config');},requirementsRuntime:()=>{counts.runtime++;throw new Error('early caller must not construct runtime');},invocation:{stdoutIsTTY:false,stdinIsTTY:false,environmentOutputMode:'data',readStdin:async(maxBytes,signal)=>{counts.stdin++;assert(maxBytes>0);assert(signal instanceof AbortSignal);return text;},writeStdout:s=>stdout.push(s),writeStderr:s=>stderr.push(s),runQuietly:async fn=>fn(),setExitCode:()=>{}}});
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
  assert.equal(Object.hasOwn(r.env,'TAVILY_API_KEY'),false);assert.equal(Object.hasOwn(r.env,'SCOUTLINE_JUDGE_TRANSMIT'),false);assert.equal(r.code,0,r.stderr);assert.equal(r.stderr,'');assert.deepEqual(r.counts,{config:1,runtime:0,http:0,stdin:0});
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
  assert.equal(r.caught,undefined);assert.equal(r.code,0);assert.equal(r.stderr,'');assert.equal(JSON.parse(r.stdout).revision,before.revision);assert.deepEqual(r.counts,{register:1,release:1,config:1,runtime:0,http:0});assert.deepEqual(await readCallerRecord(env.SCOUTLINE_INVESTIGATIONS_DIR,created.investigationRef),before);
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

test('PR291 A offline configured literal is protected in body and metadata',async()=>{
  const state=await sandbox(),{join}=await import('node:path'),{main}=await import('../dist/index.js'),{hermeticMainDeps}=await import('./helpers/hermetic-main.js'),{executeCallerInvestigation}=await import('../dist/lib/caller-investigation.js');
  const secret='bareconfig291literal731', storeRoot=state.env.SCOUTLINE_INVESTIGATIONS_DIR;
  const made=await executeCallerInvestigation({...start,requirements:{schemaVersion:1,question:'ordinary '+secret,requirements:{value:{question:'Which value?',schema:{type:'string'}}}},representations:[{format:'text',content:'ordinary body '+secret,label:'ordinary label '+secret}]},{storeRoot,deps:{search:async()=>[],read:async()=>{throw new Error('unexpected read');},judge:null,now:()=>0}});
  const env=Object.freeze({SCOUTLINE_CONFIG_DIR:join(state.path,'never-ambient'),SCOUTLINE_INVESTIGATIONS_DIR:storeRoot}),before={...env}; let loads=0,runtime=0;
  const invoke=async request=>{const stdout=[],stderr=[];const code=await main(['investigate','--caller-request-json',JSON.stringify(request)],hermeticMainDeps({env,loadScoutlineConfig:async()=>{loads++;return {version:1,providers:{exa:{apiKey:secret}}};},requirementsRuntime:()=>{runtime++;throw new Error('no runtime');},invocation:{stdoutIsTTY:false,stdinIsTTY:false,environmentOutputMode:'data',readStdin:async()=>{throw new Error('no stdin');},writeStdout:x=>stdout.push(x),writeStderr:x=>stderr.push(x),runQuietly:async fn=>fn(),setExitCode:()=>{}}}));assert.equal(code,0,stderr.join(''));assert.equal(stderr.join(''),'');assert(!stdout.join('').includes(secret),'offline valid view must redact config-only bare literal before identity and output');return JSON.parse(stdout.join(''));};
  const changes=await invoke({schemaVersion:1,operation:'inspect',investigationRef:made.investigationRef,collection:'changes',maxChars:65536});assert.match(changes.content,/ordinary \[REDACTED\]/);
  const metadata=await invoke({schemaVersion:1,operation:'inspect',investigationRef:made.investigationRef,collection:'evidence',maxChars:65536}),e=JSON.parse(metadata.content).find(x=>x.title==='ordinary label [REDACTED]');assert(e);
  const body=await invoke({schemaVersion:1,operation:'readEvidence',investigationRef:made.investigationRef,representationId:e.representationId,evidenceId:e.evidenceId,digest:e.digest});assert.equal(body.content,'ordinary body [REDACTED]');assert.equal(loads,3);assert.equal(runtime,0);assert.deepEqual({...env},before);
});

// Held file I/O is a named test-only filesystem boundary. Load complete
// compiled modules in memory; export facades delegate every other binding.
async function pr291FileMain(reader) {
  const {SourceTextModule,SyntheticModule}=await import('node:vm'),{readFile}=await import('node:fs/promises');
  const callerURL=new URL('../dist/commands/investigate-caller.js',import.meta.url),requirementsURL=new URL('../dist/commands/investigate-requirements.js',import.meta.url);
  const facades=new Map();let caller;
  const link=async(specifier,referencing,extra)=>{
    const id=specifier.startsWith('.')?new URL(specifier,referencing.identifier).href:specifier;
    if(id===callerURL.href){if(!caller){caller=new SourceTextModule(await readFile(callerURL,'utf8'),{identifier:callerURL.href,initializeImportMeta:meta=>{meta.url=callerURL.href;}});await caller.link(link);}return caller;}
    if(!facades.has(id)){const real=await import(id,{with:extra.attributes}),names=Object.keys(real),facade=new SyntheticModule(names,function(){for(const name of names)this.setExport(name,id===requirementsURL.href&&name==='readRequirementsFileBounded'?reader:real[name]);},{identifier:id});facades.set(id,facade);}
    return facades.get(id);
  };
  const url=new URL('../dist/index.js',import.meta.url),module=new SourceTextModule(await readFile(url,'utf8'),{identifier:url.href,initializeImportMeta:meta=>{meta.url=url.href;}});
  await module.link(link);await module.evaluate();return module.namespace.main;
}
function pr291Barrier(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
const pr291Turn=async()=>new Promise(resolve=>setImmediate(resolve));
test('PR291 F main file cancellation settles before held bounded reader releases',async()=>{
  const entered=pr291Barrier(),held=pr291Barrier();let starts=0,joined=0,interrupt,settled=false,code,release=0,config=0;
  const main=await pr291FileMain(()=>{starts++;entered.resolve();return held.promise.finally(()=>{joined++;});}),{hermeticMainDeps}=await import('./helpers/hermetic-main.js'),stdout=[],stderr=[];
  const pending=main(['investigate','--caller-request','synthetic-held.json'],hermeticMainDeps({env:{},requirementsUserInterrupt:fn=>{interrupt=fn;return()=>{release++;};},loadScoutlineConfig:async()=>{config++;throw new Error('no config');},invocation:{stdoutIsTTY:false,stdinIsTTY:false,environmentOutputMode:'data',readStdin:async()=>{throw new Error('no stdin');},writeStdout:x=>stdout.push(x),writeStderr:x=>stderr.push(x),runQuietly:async fn=>fn(),setExitCode:()=>{}}})).then(value=>{settled=true;code=value;});
  try {await entered.promise;interrupt();await pr291Turn();assert.equal(settled,true,'main must select owned cancellation while file I/O remains held');assert.equal(code,130);assert.equal(starts,1);assert.equal(joined,0);assert.equal(release,1);assert.equal(config,0);assert.equal(stdout.join(''),'');assert.equal(JSON.parse(stderr.join('')).code,'VALIDATION_ERROR');}
  finally {held.resolve(JSON.stringify(start));await held.promise;await pending;await pr291Turn();assert.equal(joined,1);}
});

async function pr291InvokeFile(main,register){
  const {hermeticMainDeps}=await import('./helpers/hermetic-main.js'),stdout=[],stderr=[];let release=0,config=0,runtime=0;
  const code=await main(['investigate','--caller-request','synthetic-held.json'],hermeticMainDeps({env:{},requirementsUserInterrupt:fn=>{register(fn);return()=>{release++;};},loadScoutlineConfig:async()=>{config++;throw new Error('unexpected config');},requirementsRuntime:()=>{runtime++;throw new Error('unexpected runtime');},invocation:{stdoutIsTTY:false,stdinIsTTY:false,environmentOutputMode:'data',readStdin:async()=>{throw new Error('no stdin');},writeStdout:x=>stdout.push(x),writeStderr:x=>stderr.push(x),runQuietly:async fn=>fn(),setExitCode:()=>{}}}));
  return {code,stdout:stdout.join(''),stderr:stderr.join(''),release,config,runtime};
}
test('PR291 compatibility F preabort, selected file error and reentrant late rejection',async()=>{
  let starts=0;const pre=await pr291InvokeFile(await pr291FileMain(async()=>{starts++;return JSON.stringify(start);}),fn=>fn());assert.equal(pre.code,130);assert.equal(starts,0);assert.equal(pre.release,1);assert.equal(pre.config,0);assert.equal(pre.runtime,0);
  let interrupt;const {ValidationError}=await import('../dist/lib/errors.js');const selected=await pr291InvokeFile(await pr291FileMain(()=>{queueMicrotask(()=>interrupt());throw new ValidationError('selected file failure');}),fn=>{interrupt=fn;});
  assert.equal(selected.code,1,'a later abort cannot replace the selected file failure');assert.equal(JSON.parse(selected.stderr).error,'selected file failure');assert.equal(selected.stdout,'');assert.equal(selected.release,1);assert.equal(selected.config,0);
  const held=pr291Barrier(),late=new Error('late held read rejection');let joined=0;const unhandled=[];const observe=e=>unhandled.push(e);process.on('unhandledRejection',observe);
  try {const main=await pr291FileMain(()=>{interrupt();return held.promise.finally(()=>{joined++;});});const r=await pr291InvokeFile(main,fn=>{interrupt=fn;});assert.equal(r.code,130);assert.equal(r.release,1);assert.equal(joined,0);held.reject(late);await pr291Turn();assert.equal(joined,1);assert.deepEqual(unhandled,[]);await held.promise.catch(e=>assert.equal(e,late));}
  finally {held.resolve(JSON.stringify(start));await pr291Turn();process.removeListener('unhandledRejection',observe);}
  const {readCallerRequest}=await import('../dist/commands/investigate-caller.js'),{getEventListeners}=await import('node:events');
  for(const reject of [false,true]){const controller=new AbortController(),original=new ValidationError('stdin selected error');let began=0;const pending=readCallerRequest({kind:'stdin'},async()=>{began++;assert.equal(getEventListeners(controller.signal,'abort').length,1,'listener precedes lazy work');if(reject)throw original;return JSON.stringify(start);},controller.signal);if(reject)await assert.rejects(pending,e=>e===original);else assert.equal((await pending).operation,'start');assert.equal(began,1);assert.equal(getEventListeners(controller.signal,'abort').length,0);}
});

test('PR291 compatibility A config precedence, unavailable views, delete bypass and equal secret basis',async()=>{
  const s=await sandbox(),{join}=await import('node:path'),{writeFile,mkdir,rm}=await import('node:fs/promises'),{main}=await import('../dist/index.js'),{hermeticMainDeps}=await import('./helpers/hermetic-main.js'),{executeCallerInvestigation}=await import('../dist/lib/caller-investigation.js');
  const loaderKey='loaderliteral291y',configKey='configliteral291z',envKey='envliteral291x',storeRoot=s.env.SCOUTLINE_INVESTIGATIONS_DIR;
  const made=await executeCallerInvestigation({...start,requirements:{schemaVersion:1,question:'ordinary '+loaderKey,requirements:{value:{question:'Value?',schema:{type:'string'}}}},representations:[{format:'text',content:[loaderKey,configKey,envKey].join(' '),label:'profile source'}]},{storeRoot,deps:{search:async()=>[],read:async()=>{throw new Error('no setup read');},judge:null,now:()=>0}});
  const inspect={schemaVersion:1,operation:'inspect',investigationRef:made.investigationRef};let runtime=0,http=0;
  const invoke=async(request,injected={},extraEnv={})=>{const env=Object.freeze({SCOUTLINE_CONFIG_DIR:s.env.SCOUTLINE_CONFIG_DIR,SCOUTLINE_INVESTIGATIONS_DIR:storeRoot,...extraEnv}),before={...env},stdout=[],stderr=[],previous=globalThis.fetch;globalThis.fetch=async()=>{http++;throw new Error('offline HTTP prohibited');};
    try {const code=await main(['investigate','--caller-request-json',JSON.stringify(request),'--no-cache','--provider','exa','--output-format','data'],hermeticMainDeps({env,...injected,requirementsRuntime:()=>{runtime++;throw new Error('offline runtime prohibited');},invocation:{stdoutIsTTY:false,stdinIsTTY:false,environmentOutputMode:'data',readStdin:async()=>{throw new Error('no stdin');},writeStdout:x=>stdout.push(x),writeStderr:x=>stderr.push(x),runQuietly:async fn=>fn(),setExitCode:()=>{}}}));assert.deepEqual({...env},before);return {code,stdout:stdout.join(''),stderr:stderr.join(''),data:stdout.length?JSON.parse(stdout.join('')):undefined};}finally{globalThis.fetch=previous;}};
  const config={version:1,providers:{exa:{apiKey:configKey}}},loader=async()=>({version:1,providers:{exa:{apiKey:loaderKey}}});
  const loaded=await invoke(inspect,{config,loadScoutlineConfig:loader}),expected=await executeCallerInvestigation(inspect,{storeRoot,secrets:[loaderKey]});assert.equal(loaded.code,0,loaded.stderr);assert.deepEqual(loaded.data,expected,'identical complete secret sets give identical derivatives and page identities');
  const cfg=await invoke(inspect,{config,loadScoutlineConfig:undefined}),cfgExpected=await executeCallerInvestigation(inspect,{storeRoot,secrets:[configKey]});assert.deepEqual(cfg.data,cfgExpected);
  const env=await invoke(inspect,{loadScoutlineConfig:loader},{EXA_API_KEY:envKey}),envExpected=await executeCallerInvestigation(inspect,{storeRoot,secrets:[envKey]});assert.deepEqual(env.data,envExpected,'environment credential takes normal precedence over file credential');
  const absent=await invoke(inspect,{loadScoutlineConfig:undefined});assert.equal(absent.code,0,absent.stderr);
  const unavailable=r=>{assert.equal(r.code,1);assert.equal(r.stdout,'');const error=JSON.parse(r.stderr);assert.equal(error.code,'VALIDATION_ERROR');assert.equal(error.error,'Caller view unavailable under the active redaction profile.');assert(!r.stderr.includes(loaderKey));};
  unavailable(await invoke(inspect,{loadScoutlineConfig:async()=>{throw new Error(loaderKey);}}));
  const file=join(s.env.SCOUTLINE_CONFIG_DIR,'config.json');await writeFile(file,'{"untrusted":"'+loaderKey+'",');unavailable(await invoke(inspect,{loadScoutlineConfig:undefined}));await rm(file);await mkdir(file);unavailable(await invoke(inspect,{loadScoutlineConfig:undefined}));
  let calls=0;const deleted=await invoke({schemaVersion:1,operation:'delete',investigationRef:made.investigationRef},{loadScoutlineConfig:async()=>{calls++;throw new Error(loaderKey);}});assert.equal(deleted.code,0,deleted.stderr);assert.equal(deleted.data.deleted,true);assert.equal(calls,0);assert.equal(runtime,0);assert.equal(http,0);
});
