import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTavilyDescriptor } from '../dist/providers/tavily/adapter.js';
import { createLeanAcquisitionDeps } from '../dist/lib/lean-acquisition-bridge.js';

// Capture actual return values before any assertion can discard a counterfactual witness.
const assertionErrorDocument = text => { try { return JSON.parse(text.trim().split('\n').at(-1)); } catch { return null; } };
const assertionStdout = text => { try { return {envelope: JSON.parse(text), parseError: null}; } catch(error) { return {envelope: null, parseError: error.message}; } };
const assertionSnapshot = (purpose, observed) => console.log(JSON.stringify({assertionEvidence: 1, purpose, ...observed}));
const root = fileURLToPath(new URL('..', import.meta.url));
const script = join(root, 'bin', 'scoutline.js');
const json = value => new Response(JSON.stringify(value), { status: 200 });
const sourceURL = 'https://offline.test/release';
const env = { TAVILY_API_KEY: 'offline-sentinel-secret', TAVILY_TIMEOUT: '1000' };
const noRetry = { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, jitterMs: 0 };
const cache = () => ({ get: async () => null, set: async () => {} });
const input = () => ({ schemaVersion: 1, question: 'Check release', requirements: { release: { question: 'Is release documented?', schema: { enum: ['supported', 'refuted', 'disputed'] } } }, limits: { maxSearchAttempts: 1, maxUniqueReads: 1, maxJudgeAttempts: 1, deadlineMs: 200 } });
function setup(fetch, extras = {}) {
  const transport = { fetch, env };
  const descriptor = createTavilyDescriptor({ transport });
  const opts = { transports: { tavily: transport }, descriptorFactory: (_id, tr) => createTavilyDescriptor({ transport: tr }), searchDescriptor: descriptor, readerDescriptor: descriptor, env, cache: cache(), sleep: async () => {}, random: () => 0, retryPolicy: noRetry, ...extras };
  return { opts, deps: createLeanAcquisitionDeps(opts), transport };
}
function runtime(opts, overrides = {}) {
  const output = { stdout: '', stderr: '' };
  return { output, acquisitionOptions: opts, engineDeps: { judge: null, now: Date.now }, invocation: { readFile: async () => JSON.stringify(input()), readStdin: async () => JSON.stringify(input()), writeOut: value => { output.stdout += value; }, writeErr: value => { output.stderr += value; }, setExit: value => { output.code = value; } }, ...overrides };
}

const sandbox = await mkdtemp(join(tmpdir(), 'scoutline-main-cold-'));
after(async()=>{await rm(sandbox,{recursive:true,force:true});});
const preload = join(sandbox, 'refuse-network.mjs');
await writeFile(preload, `import http from 'node:http'; import https from 'node:https';
const refuse=()=>{throw new Error('REAL_NETWORK_FORBIDDEN')};http.request=refuse;https.request=refuse;
globalThis.fetch=async(url,init)=>{process.stderr.write('OFFLINE_HTTP_ATTEMPT\\n');
const p=new URL(url).pathname;return new Response(JSON.stringify(p==='/search'?{results:[]}:{results:[{url:'https://offline.test/final',raw_content:'offline content'}]}));};`);
function child(args, extra = {}, stdin = '') {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['--import', preload, ...args], { cwd: root, env: { PATH: process.env.PATH, NODE_OPTIONS:process.env.NODE_OPTIONS,TMPDIR:process.env.TMPDIR, HOME: sandbox, SCOUTLINE_CONFIG_DIR: join(sandbox, 'config'), SCOUTLINE_CACHE_DIR: join(sandbox, 'cache'), SCOUTLINE_ARTIFACTS_DIR: join(sandbox, 'artifacts'), TAVILY_API_KEY: 'sentinel-ambient-not-a-real-key', ...extra }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { proc.kill(); reject(new Error('offline child timed out')); }, 3000);
    proc.stdout.on('data', data => { stdout += data; }); proc.stderr.on('data', data => { stderr += data; });
    proc.on('error', reject); proc.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr, calls: stderr.split('OFFLINE_HTTP_ATTEMPT').length - 1 }); });
    proc.stdin.end(stdin);
  });
}


test('actual stdin pipe is read and validated, not treated as a zero-length regular file', async () => {
  const result = await child([script, 'investigate', '--requirements', '-'], {}, JSON.stringify(input()));
  const document=assertionStdout(result.stdout);
  assertionSnapshot('pipe-cold',{...result,...document});
  assert.ok(result.stdout.length);assert.equal(document.parseError,null);
  assert.equal(document.envelope.kind,'requirements-investigation');assert.equal(document.envelope.schemaVersion,1);assert.equal(document.envelope.question,'Check release');
  assert.doesNotMatch(result.stderr, /not valid JSON|Unexpected end of JSON input/, 'valid pipe bytes must not disappear');
});

test('judge credentials without transmit consent stay inert: deterministic-only, no judge request', async () => {
  // MIGRATION (dual-route Jev): credentials alone are NOT consent, so a
  // bare credential no longer refuses. It stays INERT — the run stays
  // deterministic-only and no judge request is made. Acquisition may
  // run inside the existing bounds; it is NOT native work.
  const result = await child([script, 'investigate', '--requirements-json', JSON.stringify(input())], { TYPESAFE_API_KEY: 'synthetic-partial-key' });
  const document=assertionStdout(result.stdout);
  assertionSnapshot('consent-cold',{...result,...document,httpMarkers:result.stderr.match(/OFFLINE_HTTP_ATTEMPT/g)??[]});
  assert.equal(result.code,1);
  assert.equal(document.parseError,null,`expected a delivered envelope: ${result.stderr}`);
  assert.equal(document.envelope.assessment,'deterministic-only');
  assert.equal(document.envelope.usage.judgeCalls,0);
  assert.equal(document.envelope.usage.candidateJudgeCalls,0);
  assert.equal(document.envelope.admission.judge,undefined,'an inert credential configures no judge stage');
  assert.doesNotMatch(result.stdout,/synthetic-partial-key/,'an inert credential never reaches the output');
});

test('bridge reused sequentially with same transport binds second run signal and its own physical budget', async () => {
  let calls = 0;
  const fetch = async () => { calls++; return json({ results: [] }); };
  const first = setup(fetch, { maxPhysicalAttempts: 1 });
  await first.deps.search('first', { signal: new AbortController().signal, timeoutMs: 1000 });
  const second = createLeanAcquisitionDeps({ ...first.opts, maxPhysicalAttempts: 2 });
  await second.search('second', { signal: new AbortController().signal, timeoutMs: 1000 });
  assert.equal(calls, 2, 'second run must not inherit exhausted first bridge budget');
});

test('remaining dispatch timeout applies while caller signal remains un-aborted', async () => {
  const { deps } = setup(async () => { await new Promise(resolve => setTimeout(resolve, 80)); return json({ results: [] }); });
  const start = Date.now();
  await assert.rejects(() => deps.search('q', { signal: new AbortController().signal, timeoutMs: 10 }));
  assert.ok(Date.now() - start < 60, 'remaining time bounds headers, not fixed Provider timeout');
});

test('abort cancels an idle native body whose producer ignores fetch signal', async () => {
  let cancelled = false;
  let controller;
  const { deps } = setup(async () => new Response(new ReadableStream({ start(c) { controller = c; c.enqueue(new TextEncoder().encode('{"results":[')); }, cancel() { cancelled = true; } })));
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 10);
  const pending = deps.search('q', { signal: abort.signal, timeoutMs: 40 });
  try {
    const result = await Promise.race([pending.then(() => 'resolved', () => 'rejected'), new Promise(resolve => setTimeout(() => resolve('watchdog'), 70))]);
    assert.equal(result, 'rejected');
    assert.equal(cancelled, true, 'abort must cancel idle reader, not wait for next chunk');
  } finally { clearTimeout(timer); if (!cancelled) controller.error(new Error('offline test cleanup')); await pending.catch(() => {}); }
});

test('native late success after caller abort cannot be normalized into successful coverage', async () => {
  let bodyCancelled = false;
  const { deps } = setup(async () => { await new Promise(resolve => setTimeout(resolve, 35)); return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"results":[]}')); c.close(); }, cancel() { bodyCancelled = true; } })); });
  const abort = new AbortController(); setTimeout(() => abort.abort(), 5);
  await assert.rejects(() => deps.search('q', { signal: abort.signal, timeoutMs: 30 }));
  assert.equal(bodyCancelled, true);
});

test('actual cache serve provenance follows executor read rather than a separate warmth probe', async () => {
  let gets = 0;
  let calls = 0;
  const provenance = [];
  const valid = { schemaVersion: 1, url: sourceURL, finalUrl: sourceURL, title: null, content: 'cached', contentFormat: 'markdown' };
  const { deps } = setup(async () => { calls++; return json({ results: [{ url: sourceURL, raw_content: 'fresh' }] }); }, { cache: { get: async () => ++gets === 1 ? valid : null, set: async () => {} }, onReadProvenance: record => provenance.push(record) });
  assert.equal(await deps.read(sourceURL), 'fresh');
  assert.equal(calls, 1);
  assert.equal(provenance[0].fromCache, false, 'cache evicted between probe and executor serve');
});
