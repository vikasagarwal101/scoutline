import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const root = process.cwd().endsWith('/packages/scoutline')?process.cwd():join(process.cwd(),'packages/scoutline');
assert.ok(root, 'REVIEW_PACKAGE required');
const { main } = await import(pathToFileURL(join(root, 'dist/index.js')));
const { selectRequirementsJudge } = await import(pathToFileURL(join(root, 'dist/commands/investigate-requirements.js')));
const { createTavilyDescriptor } = await import(pathToFileURL(join(root, 'dist/providers/tavily/adapter.js')));
const { hermeticMainDeps } = await import(pathToFileURL(join(root, 'tests/helpers/hermetic-main.js')));
const contract = { schemaVersion:1,question:'Does ExampleApp support CSV?',scope:{entity:'ExampleApp'},requirements:{csv:{question:'Does ExampleApp support CSV?',schema:{enum:['supported','refuted','disputed']}}} };
const text = 'ExampleApp supports CSV export.';
async function run({cap=48, observe=false, producer=false}={}) {
  const sandbox = await mkdtemp(join(tmpdir(),'caller-handler-proof-'));
  const calls=[], refusals=[];
  let bridgeRefusals=0;
  const originalFetch = globalThis.fetch;
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
  try {
    const code=await main(['investigate','--provider','tavily','--requirements-json',JSON.stringify(contract),'--no-cache','--json'],deps);
    assert.ok(stdout.join(''), `handler output absent: ${stderr.join('')}`);
    return {code,data:JSON.parse(stdout.join('')),stderr:stderr.join(''),calls,refusals,bridgeRefusals};
  } finally {globalThis.fetch=originalFetch;}
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
