import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTavilyDescriptor } from '../dist/providers/tavily/adapter.js';
import { createLeanAcquisitionDeps } from '../dist/lib/lean-acquisition-bridge.js';
import { runLeanVerticalSlice } from '../scripts/lean-vertical-slice.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
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
const preload = join(sandbox, 'refuse-network.mjs');
await writeFile(preload, `import http from 'node:http'; import https from 'node:https';
const refuse=()=>{throw new Error('REAL_NETWORK_FORBIDDEN')};http.request=refuse;https.request=refuse;
globalThis.fetch=async(url,init)=>{process.stderr.write('OFFLINE_HTTP_ATTEMPT\\n');
const p=new URL(url).pathname;return new Response(JSON.stringify(p==='/search'?{results:[]}:{results:[{url:'https://offline.test/final',raw_content:'offline content'}]}));};`);
function child(args, extra = {}, stdin = '') {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['--import', preload, ...args], { cwd: root, env: { PATH: process.env.PATH, HOME: sandbox, SCOUTLINE_CONFIG_DIR: join(sandbox, 'config'), SCOUTLINE_CACHE_DIR: join(sandbox, 'cache'), SCOUTLINE_ARTIFACTS_DIR: join(sandbox, 'artifacts'), TAVILY_API_KEY: 'sentinel-ambient-not-a-real-key', ...extra }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { proc.kill(); reject(new Error('offline child timed out')); }, 3000);
    proc.stdout.on('data', data => { stdout += data; }); proc.stderr.on('data', data => { stderr += data; });
    proc.on('error', reject); proc.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr, calls: stderr.split('OFFLINE_HTTP_ATTEMPT').length - 1 }); });
    proc.stdin.end(stdin);
  });
}
const script = join(root, 'scripts/lean-vertical-slice.mjs');

test('importing development entrypoint with sentinel ambient credential is inert', async () => {
  const result = await child(['--input-type=module', '-e', `await import(${JSON.stringify(new URL('../scripts/lean-vertical-slice.mjs', import.meta.url).href)})`]);
  assert.equal(result.calls, 0);
  assert.equal(result.stdout, '');
});
for (const disabled of [undefined, '0']) {
  test(`direct main without explicit live opt-in refuses ambient dispatch (${disabled ?? 'unset'})`, async () => {
    const result = await child([script, '--requirements-json', JSON.stringify(input())], disabled === undefined ? { SCOUTLINE_CACHE_DIR: join(sandbox, 'noopt-unset') } : { SLICE_DEV_MAIN: disabled, SCOUTLINE_CACHE_DIR: join(sandbox, 'noopt-zero') });
    assert.equal(result.calls, 0, 'ambient credential is not live authorization');
    assert.notEqual(result.code, 0);
    assert.equal(result.stdout, '', 'no fabricated completed/partial result before opt-in');
  });
}

test('actual stdin pipe is read and validated, not treated as a zero-length regular file', async () => {
  const result = await child([script, '--requirements', '-'], {}, JSON.stringify(input()));
  assert.doesNotMatch(result.stderr, /not valid JSON|Unexpected end of JSON input/, 'valid pipe bytes must not disappear');
});

test('partial configured judge profile fails closed before acquisition, not deterministic-only downgrade', async () => {
  const result = await child([script, '--requirements-json', JSON.stringify(input())], { JEV_DEV_ENDPOINT: 'https://offline.test/judge' });
  assert.equal(result.calls, 0);
  assert.doesNotMatch(result.stdout, /deterministic-only/);
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

test('development output includes actual acquisition provenance and physical counts', async () => {
  const records = [];
  const { opts } = setup(async (url) => new URL(url).pathname === '/search' ? json({ results: [{ url: sourceURL, title: 'discovery', content: 'lead' }] }) : json({ results: [{ url: 'https://offline.test/final', raw_content: 'retained' }] }), { onReadProvenance: record => records.push(record) });
  const rt = runtime(opts);
  await runLeanVerticalSlice(['--requirements-json', JSON.stringify(input())], rt);
  assert.ok(records.length);
  const result = JSON.parse(rt.output.stdout);
  assert.match(rt.output.stdout, /"finalUrl"\s*:\s*"https:\/\/offline.test\/final"/);
  assert.ok(Number.isSafeInteger(result.usage.physicalHttpAttempts), 'logical calls do not expose physical retry/HTTP admission');
});

test('development stdout and validation errors redact injected credentials', async () => {
  const { opts } = setup(async url => new URL(url).pathname === '/search' ? json({ results: [{ url: sourceURL, title: 'lead', content: 'lead' }] }) : json({ results: [{ url: sourceURL, raw_content: `upstream echoed ${env.TAVILY_API_KEY}` }] }));
  const rt = runtime(opts);
  await runLeanVerticalSlice(['--requirements-json', JSON.stringify(input())], rt);
  assert.doesNotMatch(rt.output.stdout, /offline-sentinel-secret/);
  const bad = input(); bad.requirements.release.schema.enum = [env.TAVILY_API_KEY];
  const rtBad = runtime(opts);
  await runLeanVerticalSlice(['--requirements-json', JSON.stringify(bad)], rtBad);
  assert.doesNotMatch(rtBad.output.stderr, /offline-sentinel-secret/);
});

test('unknown policy/deep fields reject before actual HTTP, never accept-and-drop', async () => {
  let calls = 0;
  const { opts } = setup(async () => { calls++; return json({ results: [] }); });
  const bad = input(); bad.retention = { privateTransmission: false, nested: { value: 'unsupported' } };
  const rt = runtime(opts);
  assert.equal(await runLeanVerticalSlice(['--requirements-json', JSON.stringify(bad)], rt), 2);
  assert.equal(calls, 0);
});
