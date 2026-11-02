import assert from 'node:assert/strict';
import {afterEach} from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp as actualMkdtemp,rm,readFile,writeFile,mkdir } from 'node:fs/promises';
import { dirname,join } from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
export const scratch=dirname(fileURLToPath(import.meta.url));
export const root=dirname(dirname(scratch));
assert.ok(root,'REVIEW_PACKAGE required');
export const contract={schemaVersion:1,question:'Identify ExampleApp release, license and CSV support.',scope:{entity:'ExampleApp',release:'2.4.0'},requirements:{version:{question:'Which release?',schema:{type:'string'}},license:{question:'Which license for the release?',schema:{type:'string'},dependsOn:['version']},csv:{question:'Does release 2.4.0 support CSV?',schema:{enum:['supported','refuted','disputed']}}}};
export const content='ExampleApp release 2.4.0. License MIT applies to release 2.4.0. CSV export is supported.';
export async function sandbox() {
  const path=await mkdtemp(join(tmpdir(),'compiled-caller-proof-'));
  const home=await mkdtemp(join(tmpdir(),'caller-review-home-'));
  const env={PATH:'/usr/bin:/bin',HOME:home,NODE_OPTIONS:process.env.NODE_OPTIONS,TMPDIR:process.env.TMPDIR,XDG_CONFIG_HOME:join(home,'xdg-config'),XDG_CACHE_HOME:join(home,'xdg-cache'),SCOUTLINE_CONFIG_DIR:join(path,'config'),SCOUTLINE_CACHE_DIR:join(path,'cache'),SCOUTLINE_ARTIFACTS_DIR:join(path,'artifacts'),SCOUTLINE_INVESTIGATIONS_DIR:join(path,'investigations'),TAVILY_API_KEY:'synthetic-acquisition-key',TYPESAFE_API_KEY:'synthetic-judge-key',SCOUTLINE_JUDGE:'typesafe',SCOUTLINE_JUDGE_TRANSMIT:'1'};
  await mkdir(env.SCOUTLINE_CONFIG_DIR,{recursive:true});
  // Empty directory intentionally has no config; default loader must not read ambient HOME.
  return {path,home,env};
}
export async function api() {return import(pathToFileURL(join(root,'dist/lib/caller-investigation.js')));}
export async function trace(path) {return (await readFile(path,'utf8').catch(()=>'' )).split('\n').filter(Boolean).map(line=>JSON.parse(line));}
export async function bin(state,request,{env={},args=[],stdin,signalEvent,rawArgs}={}) {
  const tracePath=join(state.path,`trace-${crypto.randomUUID()}.jsonl`);
  await writeFile(tracePath,'');
  const argv=rawArgs??['investigate','--caller-request-json',JSON.stringify(request),'--provider','tavily',...args];
  const child=spawn(process.execPath,['--import',join(scratch,'caller-review-fake-native.mjs'),join(root,'bin/scoutline.js'),...argv],{cwd:root,env:{...state.env,REVIEW_TRACE:tracePath,...env},stdio:['pipe','pipe','pipe']});
  let stdout='',stderr='';
  child.stdout.on('data',chunk=>stdout+=chunk);
  child.stderr.on('data',chunk=>stderr+=chunk);
  if(stdin!==undefined) child.stdin.write(stdin); else child.stdin.end();
  let sent=false;
  const watch=signalEvent?setInterval(async()=>{
    if(!sent && (await trace(tracePath)).some(event=>event.event===signalEvent || event.url?.includes(signalEvent))) {sent=true;child.kill('SIGINT');}
  },10):undefined;
  const timeout=setTimeout(()=>child.kill('SIGKILL'),30000);
  const result=await new Promise((resolve,reject)=>{
    child.on('error',reject);
    child.on('close',(code,signal)=>resolve({code,signal,stdout,stderr,tracePath,sent}));
  }).finally(()=>{clearTimeout(timeout);if(watch)clearInterval(watch);});
  assert.notEqual(result.signal,'SIGKILL',`child hung: ${result.stderr}`);
  return {...result,events:await trace(tracePath)};
}
export function output(r) {assert.ok(r.stdout,`no JSON output: ${r.stderr}`);return JSON.parse(r.stdout);}
export function noHTTP(r) {assert.equal(r.events.filter(e=>e.url).length,0,'read-only/invalid operation dispatched HTTP');}

const ownedSandboxRoots=new Set();
async function mkdtemp(...args){const path=await actualMkdtemp(...args);ownedSandboxRoots.add(path);return path;}
afterEach(async()=>{for(const path of ownedSandboxRoots){await rm(path,{recursive:true,force:true});ownedSandboxRoots.delete(path);}});
