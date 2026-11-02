import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createTavilyDescriptor } from '../dist/providers/tavily/adapter.js';
import { createLeanAcquisitionDeps } from '../dist/lib/lean-acquisition-bridge.js';

// Capture actual return values before any assertion can discard a counterfactual witness.
const assertionErrorDocument = text => { try { return JSON.parse(text.trim().split('\n').at(-1)); } catch { return null; } };
const assertionStdout = text => { try { return {envelope: JSON.parse(text), parseError: null}; } catch(error) { return {envelope: null, parseError: error.message}; } };
const assertionSnapshot = (purpose, observed) => console.log(JSON.stringify({assertionEvidence: 1, purpose, ...observed}));
const root = fileURLToPath(new URL('..', import.meta.url));
const script = join(root, 'bin', 'scoutline.js');
const json = (v, status = 200) => new Response(JSON.stringify(v), { status });
const env = { TAVILY_API_KEY: 'synthetic-acquisition-key', TAVILY_TIMEOUT: '1000' };
const noRetry = { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, jitterMs: 0 };
const cache = () => ({ get: async () => null, set: async () => {} });
const url = 'https://offline.test/release';
const input = () => ({ schemaVersion: 1, question: 'Check release', requirements: { release: { question: 'Is release documented?', schema: { enum: ['supported', 'refuted', 'disputed'] } } }, limits: { maxSearchAttempts: 1, maxUniqueReads: 1, maxJudgeAttempts: 1, deadlineMs: 30 } });
function setup(fetch, extras = {}) {
 const transport = { fetch, env }; const descriptor = createTavilyDescriptor({ transport });
 const opts = { transports: { tavily: transport }, descriptorFactory: (_id, tr) => createTavilyDescriptor({ transport: tr }), searchDescriptor: descriptor, readerDescriptor: descriptor, env, cache: cache(), sleep: async () => {}, random: () => 0, retryPolicy: noRetry, ...extras };
 return { transport, opts, deps: createLeanAcquisitionDeps(opts) };
}
function runtime(opts) {
 const output = { stdout: '', stderr: '' };
 return { output, acquisitionOptions: opts, engineDeps: { judge: null, now: Date.now }, invocation: { readFile: async () => JSON.stringify(input()), readStdin: async () => JSON.stringify(input()), writeOut: t => { output.stdout += t; }, writeErr: t => { output.stderr += t; }, setExit: c => { output.code = c; } } };
}
const sandbox = await mkdtemp(join(tmpdir(), 'scoutline-correction-child-'));
after(async()=>{await rm(sandbox,{recursive:true,force:true});});
const preload = join(sandbox, 'offline.mjs');
await writeFile(preload, `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
const opened=new Set(),actualOpen=fs.open,actualClose=fs.close;
fs.open=function(path,...args){const callback=args.pop();return Reflect.apply(actualOpen,this,[path,...args,(error,fd)=>{if(!error&&String(path).endsWith('requirements.json')){opened.add(fd);process.stderr.write('FD_OPEN '+fd+'\\n');}callback(error,fd);}]);};
fs.close=function(fd,...args){const callback=args.pop();return Reflect.apply(actualClose,this,[fd,...args,(error)=>{if(!error&&opened.delete(fd))process.stderr.write('FD_CLOSE '+fd+'\\n');callback(error);}]);};
syncBuiltinESMExports();
import http from 'node:http';import https from 'node:https';const refuse=()=>{throw Error('REAL_NETWORK_FORBIDDEN')};http.request=refuse;https.request=refuse;
globalThis.fetch=async(url,init)=>{process.stderr.write('HTTP '+new URL(url).hostname+' '+JSON.stringify({callback:!!init.signal})+'\\n');if(process.env.JEV_DEV_ENDPOINT){const path=new URL(url).pathname;return new Response(JSON.stringify(path=== '/search' ? {results:[{url:'https://offline.test/release',title:'lead',content:'lead'}]} : path=== '/extract' ? {results:[{url:'https://offline.test/release',raw_content:'release documented'}]} : {}));}const signal=init.signal;return new Response(new ReadableStream({start(c){const abort=()=>{process.stderr.write('NATIVE_ABORT\\n');c.error(new DOMException('abort','AbortError'))};signal?.addEventListener('abort',abort,{once:true});setTimeout(()=>{if(!signal?.aborted){c.enqueue(new TextEncoder().encode('{"results":[]}'));c.close()}},75)}}));};`);
function child(args, overrides = {}, stdin = '') {
 return new Promise((resolve,reject) => {
 const proc=spawn(process.execPath,['--import',preload,...args],{cwd:root,env:{PATH:process.env.PATH,NODE_OPTIONS:process.env.NODE_OPTIONS,TMPDIR:process.env.TMPDIR,HOME:sandbox,SCOUTLINE_CONFIG_DIR:join(sandbox,'config'),SCOUTLINE_CACHE_DIR:join(sandbox,`cache-${Math.random()}`),SCOUTLINE_ARTIFACTS_DIR:join(sandbox,'artifacts'),TAVILY_API_KEY:'synthetic-ambient',SLICE_LIVE_PROFILE:'1',...overrides},stdio:['pipe','pipe','pipe']});let stdout='',stderr='';const timer=setTimeout(()=>{proc.kill();reject(Error('offline child timeout'))},1500);proc.stdout.on('data',x=>stdout+=x);proc.stderr.on('data',x=>stderr+=x);proc.on('error',reject);proc.on('close',code=>{clearTimeout(timer);resolve({code,stdout,stderr})});proc.stdin.end(stdin);
 });
}

test('explicit authorized fake main uses bounded actual transport and reports observed HTTP attempts',async()=>{
 const r=await child([script,'investigate','--requirements-json',JSON.stringify(input())]);
 assert.match(r.stderr,/HTTP api.tavily.com/,'real client executed against fake HTTP');
 const out=JSON.parse(r.stdout);
 assert.equal(out.usage.physicalHttpAttempts,1,'actual main must not bypass transport admission');
 assert.ok(out.acquisition.physicalAttempts.length===1);
 assert.match(r.stderr,/NATIVE_ABORT/,'run expiry cancels native body before fixed Provider timeout');
});

test('actual authorized main file input reads valid bytes and closes its opened fd',async()=>{
 const path=join(sandbox,'requirements.json');await writeFile(path,JSON.stringify(input()));
 const r=await child([script,'investigate','--requirements',path]);
 assert.doesNotMatch(r.stderr,/requirements read failed|invalid|undefined/i);
 assert.ok(r.stdout.length,'same real main executes file input');
 assert.equal(JSON.parse(r.stdout).question,'Check release');
 const opened=[...r.stderr.matchAll(/FD_OPEN (\d+)/g)].map(m=>m[1]),closed=[...r.stderr.matchAll(/FD_CLOSE (\d+)/g)].map(m=>m[1]);
 assert.equal(opened.length,1,'actual file descriptor open observed');assert.deepEqual(closed,opened,'every opened requirements fd must close before child exit');
});

test('actual authorized main pipe parses valid requirements through its real incremental reader',async()=>{
 const r=await child([script,'investigate','--requirements','-'],{},JSON.stringify(input()));
 assert.doesNotMatch(r.stderr,/requirements read failed|not valid JSON/);
 assert.equal(JSON.parse(r.stdout).question,'Check release');
});

test('Search/Reader consent does not activate an ambient complete judge profile',async()=>{
 // MIGRATION (dual-route Jev): a bare credential is not consent, so it
 // stays inert instead of refusing. The run remains deterministic-only
 // and NO judge transmission happens; acquisition may run inside the
 // existing bounds and is not native work.
 const r=await child([script,'investigate','--requirements-json',JSON.stringify(input())],{TYPESAFE_API_KEY:'synthetic-judge-key'});
 const document=assertionStdout(r.stdout);
 assertionSnapshot('consent-correction',{...r,...document,httpMarkers:r.stderr.match(/HTTP [^\n]*/g)??[]});
 assert.equal(r.code,1);
 assert.equal(document.parseError,null,`expected a delivered envelope: ${r.stderr}`);
 assert.equal(document.envelope.assessment,'deterministic-only');
 assert.equal(document.envelope.usage.judgeCalls,0);
 assert.equal(document.envelope.usage.candidateJudgeCalls,0);
 assert.doesNotMatch(r.stderr,/HTTP api\.typesafe\.ai/,'no separately authorized judge transmission');
 assert.doesNotMatch(r.stdout,/synthetic-judge-key/,'an inert credential never reaches the output');
});

test('abort of ignored native headers settles locally without awaiting unresolved late response',async()=>{
 let resolveHeaders;
 const {deps}=setup(()=>new Promise(resolve=>{resolveHeaders=resolve}));const abort=new AbortController();
 const pending=deps.search('q',{signal:abort.signal,timeoutMs:15});setTimeout(()=>abort.abort(),3);
 try{const status=await Promise.race([pending.then(()=> 'resolved',()=> 'rejected'),new Promise(resolve=>setTimeout(()=>resolve('watchdog'),60))]);assert.equal(status,'rejected','unresponsive transport cannot make deadline wait infinite');}
 finally{resolveHeaders(json({results:[]}));await pending.catch(()=>{});}
});

test('caller abort cancels and settles an idle body promptly, not only at a distant deadline',async()=>{
 let controller;let cancelled=false;
 const {deps}=setup(async()=>new Response(new ReadableStream({start(c){controller=c;c.enqueue(new TextEncoder().encode('{"results":['))},cancel(){cancelled=true}})));
 const abort=new AbortController();const pending=deps.search('q',{signal:abort.signal,timeoutMs:1000});setTimeout(()=>abort.abort(),3);
 try{const status=await Promise.race([pending.then(()=> 'resolved',()=> 'rejected'),new Promise(resolve=>setTimeout(()=>resolve('watchdog'),40))]);assert.equal(status,'rejected');assert.equal(cancelled,true);}
 finally{if(!cancelled)controller.error(Error('test cleanup'));await pending.catch(()=>{});}
});

test('physical ledger records body failure and reservation refusal, never completed at headers',async()=>{
 const snapshots=[];
 const {deps}=setup(async()=>new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(' '.repeat(100)));}})),{maxResponseBytes:10,onPhysicalLedger:l=>snapshots.push(structuredClone({attempts:l.attempts,reservationsRefused:l.reservationsRefused,perAttempt:l.perAttempt}))});
 await assert.rejects(()=>deps.search('q',{signal:new AbortController().signal,timeoutMs:100}));
 assert.equal(deps.physicalLedger.attempts,1);
 assert.notEqual(deps.physicalLedger.perAttempt[0].outcome,'complete','headers success is not body success');
 const refused=setup(async()=>json({results:[]}),{reservePhysicalAttempt(){throw Error('external reservation refused')}});
 await assert.rejects(()=>refused.deps.search('q'));
 assert.equal(refused.deps.physicalLedger.reservationsRefused,1);
 assert.equal(refused.deps.physicalLedger.attempts,0);
});

test('bounded bridge cannot silently certify zero HTTP when its selected transport is absent',async()=>{
 const {opts}=setup(async()=>json({results:[]}));delete opts.transports;
 const deps=createLeanAcquisitionDeps(opts);
 await assert.rejects(()=>deps.search('q'),'must fail closed instead of unwrapped counted-as-zero work');
});



test('operation restoration cannot poison a shared transport across concurrent bridge calls',async()=>{
 let firstRelease;let secondRelease;let calls=0;
 const original=async()=>{calls++;if(calls===1)await new Promise(r=>firstRelease=r);else await new Promise(r=>secondRelease=r);return json({results:[]})};
 const first=setup(original);const second=createLeanAcquisitionDeps({...first.opts});const a=first.deps.search('a');await new Promise(r=>setImmediate(r));const b=second.search('b');await new Promise(r=>setImmediate(r));firstRelease();await a;secondRelease();await b;
 assert.equal(first.transport.fetch,original,'nested transient restore must not leave old operation wrapper installed');
});

test('promisified real file read returns an object with bytesRead', async()=>{
 const {read}=await import('node:fs');const {promisify}=await import('node:util');const {open}=await import('node:fs/promises');const path=join(sandbox,'read-protocol');await writeFile(path,'{}');const handle=await open(path,'r');
 try{const result=await promisify(read)(handle.fd,Buffer.alloc(8),0,8,null);assert.equal(typeof result,'object');assert.equal(result.bytesRead,2);}finally{await handle.close();}
});
