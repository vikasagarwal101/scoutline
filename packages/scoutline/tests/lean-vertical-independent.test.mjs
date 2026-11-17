import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createTavilyDescriptor } from '../dist/providers/tavily/adapter.js';
import { createExaDescriptor } from '../dist/providers/exa/adapter.js';
import { executeWithFallback } from '../dist/lib/provider-fallback.js';
import { executeSearch, executeReaderOperation } from '../dist/lib/execution.js';
import { compileLeanContract, runLeanInvestigation } from '../dist/lib/lean-investigation.js';

// Callable baseline scaffold: real production adapter/client/normalization/executor,
// never a missing-import RED. Replace composition with the delivered bridge when built.
const bridgeUrl = new URL('../dist/lib/lean-acquisition-bridge.js', import.meta.url);
const bridge = process.env.VERTICAL_BASELINE !== '1' && existsSync(bridgeUrl) ? await import(bridgeUrl.href) : null;
const noRetry = { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, jitterMs: 0 };
const hash = value => createHash('sha256').update(value).digest('hex');
const cache = () => {
  const entries = new Map();
  return { get: async key => entries.get(key) ?? null, set: async (key, value) => { entries.set(key, value); } };
};
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const URL_USEFUL = 'https://example.test/release';
const URL_NOISE = 'https://example.test/noise';
const URL_CONTRARY = 'https://example.test/contrary';
const TEXT = 'ExampleApp release 2.4.0. License MIT applies to release 2.4.0. CSV export is supported.';
const contract = () => ({
  schemaVersion: 1,
  question: 'Identify the version, license, and CSV status for ExampleApp.',
  scope: { entity: 'ExampleApp', release: '2.4.0' },
  // Reverse declaration order deliberately exercises real dependency scheduling.
  requirements: {
    license: { question: 'Which license applies to the accepted release?', schema: { type: 'string' }, dependsOn: ['version'] },
    version: { question: 'Which exact release is documented?', schema: { type: 'string' } },
    csv: { question: 'Does ExampleApp release 2.4.0 support CSV export?', schema: { enum: ['supported', 'refuted', 'disputed'] } },
  },
});
function options(fetch, extras = {}) {
  const env = { TAVILY_API_KEY: 'offline-independent-key', TAVILY_TIMEOUT: '1000' };
  const transport = { fetch, env };
  const descriptor = createTavilyDescriptor({ transport });
  return { transports: { tavily: transport }, descriptorFactory: (_id, tr) => createTavilyDescriptor({ transport: tr }), searchDescriptor: descriptor, readerDescriptor: descriptor, env, cache: cache(), sleep: async () => {}, random: () => 0, retryPolicy: noRetry, now: Date.now, ...extras };
}
function acquisition(opts) {
  if (bridge) return bridge.createLeanAcquisitionDeps(opts);
  const search = opts.searchDescriptor.create({ env: opts.env }).search;
  const reader = opts.readerDescriptor.create({ env: opts.env }).reader.fetch;
  return {
    search: async (query, dispatch) => (await executeSearch(search, { query }, { signal: dispatch?.signal, retryPolicy: opts.retryPolicy }, opts)).map(({ url, title }) => ({ url, title })),
    read: async (url, dispatch) => (await executeReaderOperation(reader, { url }, { signal: dispatch?.signal, retryPolicy: opts.retryPolicy }, opts)).content,
  };
}
function semantics(trace = [], malformed = false) {
  return {
    judge: async input => ({ documents: input.documents.map(d => ({ evidenceId: d.evidenceId, relevant: d.url !== URL_NOISE, supportsClaim: d.url === URL_USEFUL, refutesClaim: false })) }),
    extract: async input => {
      trace.push(structuredClone(input));
      const output = Object.fromEntries(input.fields.map(f => {
        if (input.sourceText !== TEXT) return [f.id, { value: null, quote: null }];
        return [f.id, { value: f.id === 'version' ? '2.4.0' : 'MIT', quote: f.id === 'version' ? 'ExampleApp release 2.4.0.' : 'License MIT applies to release 2.4.0.' }];
      }));
      return { finishReason: 'stop', rawOutput: malformed ? '{not JSON' : JSON.stringify(output), usage: { inputTokens: 1, outputTokens: 1 }, observedCost: null, elapsedMs: 0, requestSha256: hash(JSON.stringify(input)) };
    },
    candidateJudge: async input => ({ model: 'offline-independent', answers: Object.fromEntries(input.candidates.flatMap((_, i) => [[`q${i}s`, { type: 'noul', noul: .99 }], [`q${i}c`, { type: 'noul', noul: .01 }]])), usage: { inputTokens: 1, outputTokens: 1 }, requestSha256: hash(JSON.stringify(input)), elapsedMs: 0 }),
    extractorRevision: 'independent-offline-v1',
    now: Date.now,
  };
}
function fixtureHTTP({ contraryFails = false } = {}) {
  const calls = [];
  let searchCount = 0;
  return {
    calls,
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push({ path: new URL(url).pathname, body, signal: init.signal });
      if (new URL(url).pathname === '/search') {
        searchCount++;
        const urls = body.query.includes('contrary evidence') ? (contraryFails ? [URL_CONTRARY] : [URL_USEFUL]) : searchCount === 1 ? [URL_NOISE] : [URL_USEFUL];
        return json({ results: urls.map(url => ({ url, title: `Discovery ${url}`, content: 'Search snippets are NOT evidence: version 9.9.9, license GPL.' })) });
      }
      assert.equal(new URL(url).pathname, '/extract');
      const target = body.urls[0];
      if (target === URL_CONTRARY) return json({ failed_results: [{ url: target, error: 'offline failure' }], results: [] });
      return json({ results: [{ url: target, raw_content: target === URL_NOISE ? 'Unrelated gardening advice.' : TEXT }], failed_results: [] });
    },
  };
}

test('real Search/Reader composition accepts source-bound release/license and classification, not snippets', async () => {
  const http = fixtureHTTP();
  const trace = [];
  const input = contract();
  compileLeanContract(input);
  const deps = { ...acquisition(options(http.fetch)), ...semantics(trace) };
  const result = await runLeanInvestigation(input, deps);
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.data, { license: 'MIT', version: '2.4.0', csv: 'supported' });
  assert.deepEqual(result.evidence.map(e => e.content), ['Unrelated gardening advice.', TEXT]);
  const bound = trace.filter(x => x.fields.some(f => f.id === 'license'));
  assert.ok(bound.length > 0);
  for (const request of bound) {
    assert.equal(request.depBindings.version.value, '2.4.0');
    assert.equal(request.depBindings.version.sourceDigest, hash(TEXT));
  }
  for (const key of ['license', 'version']) {
    const row = result.requirements[key];
    assert.equal(row.status, 'satisfied');
    assert.equal(row.provenance.sourceDigest, hash(TEXT));
    assert.equal(row.provenance.sourceId, result.evidence.find(e => e.content === TEXT).evidenceId);
    assert.ok(row.attemptedRecords.some(r => r.metadata?.kind === 'extraction'));
    assert.ok(row.attemptedRecords.some(r => r.metadata?.kind === 'candidate-judgment'));
  }
  const coldCount = http.calls.length;
  const warm = await runLeanInvestigation(input, deps);
  assert.deepEqual(warm.data, result.data);
  assert.equal(http.calls.length, coldCount, 'warm normalized response cache must avoid HTTP');
});

test('contrary read failure keeps all mandatory answers out of accepted-only data', async () => {
  const http = fixtureHTTP({ contraryFails: true });
  const result = await runLeanInvestigation(contract(), { ...acquisition(options(http.fetch)), ...semantics() });
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.data, {});
  assert.ok(result.acquisitionLog.some(e => e.kind === 'read-failed' && e.detail === URL_CONTRARY));
  assert.ok(result.requirements.version.reason);
  assert.equal(result.requirements.license.status, 'unresolved');
  assert.ok(result.requirements.license.reason);
});

test('malformed extraction remains audited and cannot contaminate accepted values', async () => {
  const http = fixtureHTTP();
  const result = await runLeanInvestigation(contract(), { ...acquisition(options(http.fetch)), ...semantics([], true) });
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.data, { csv: 'supported' });
  assert.equal(result.requirements.version.status, 'unresolved');
  assert.ok(result.requirements.version.candidates.some(x => x.reason === 'json_parse_failed'));
});

test('missing semantic judge retains real acquired evidence without invented answers', async () => {
  const http = fixtureHTTP();
  const result = await runLeanInvestigation(contract(), { ...acquisition(options(http.fetch)), judge: null, now: Date.now });
  assert.equal(result.status, 'partial');
  assert.equal(result.assessment, 'deterministic-only');
  assert.deepEqual(result.data, {});
  assert.ok(result.evidence.some(e => e.content === TEXT));
  assert.ok(Object.values(result.requirements).every(r => r.reason === 'no_semantic_judge'));
});

for (const operation of ['search', 'read']) {
  for (const phase of ['headers', 'body']) {
    test(`run abort reaches native ${operation} HTTP ${phase} before operation settles`, async () => {
      let cancelled = false;
      const fetch = async (url, init) => {
        const payload = operation === 'search' ? { results: [] } : { results: [{ url: URL_USEFUL, raw_content: TEXT }] };
        const slow = () => new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve(payload), 100);
          const abort = () => { cancelled = true; clearTimeout(timer); reject(new DOMException('aborted', 'AbortError')); };
          if (init.signal.aborted) abort();
          else init.signal.addEventListener('abort', abort, { once: true });
        });
        if (phase === 'headers') { await slow(); return json(payload); }
        // Supported native body shape: the same pending payload is now
        // signal-coupled to a real stream, so rejection alone cannot fake
        // the original cancellation assertion below.
        const stream = new ReadableStream({
          start(controller) {
            const finish = () => {
              init.signal.removeEventListener('abort', abort);
              controller.enqueue(new TextEncoder().encode(JSON.stringify(payload)));
              controller.close();
            };
            const timer = setTimeout(finish, 100);
            const abort = () => {
              cancelled = true;
              clearTimeout(timer);
              init.signal.removeEventListener('abort', abort);
              controller.error(new DOMException('aborted', 'AbortError'));
            };
            this.cleanup = () => { clearTimeout(timer); init.signal.removeEventListener('abort', abort); };
            if (init.signal.aborted) abort();
            else init.signal.addEventListener('abort', abort, { once: true });
          },
          cancel() { cancelled = true; this.cleanup(); },
        });
        return new Response(stream, { status: 200 });
      };
      const deps = acquisition(options(fetch));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10);
      try {
        await assert.rejects(() => operation === 'search' ? deps.search('ExampleApp', { signal: controller.signal, timeoutMs: 1000 }) : deps.read(URL_USEFUL, { signal: controller.signal, timeoutMs: 1000 }));
        assert.equal(cancelled, true, 'native fetch/body must observe cancellation, not a detached Promise.race');
      } finally { clearTimeout(timer); }
    });
  }
}

test('pre-aborted dispatch cannot make physical HTTP calls', async () => {
  let calls = 0;
  const deps = acquisition(options(async () => { calls++; return json({ results: [] }); }));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => deps.search('ExampleApp', { signal: controller.signal, timeoutMs: 10 }));
  await assert.rejects(() => deps.read(URL_USEFUL, { signal: controller.signal, timeoutMs: 10 }));
  assert.equal(calls, 0);
});

test('every retry reserves physical HTTP before side effects, exhaustion cannot become coverage', async () => {
  let calls = 0;
  const opts = options(async () => { calls++; return calls === 1 ? json({}, 429) : json({ results: [] }); }, {
    retryPolicy: { maxRetries: 1, baseDelayMs: 0, maxDelayMs: 0, jitterMs: 0 },
    // Runtime injection, not a change to the engine's policy or ceilings.
    maxPhysicalAttempts: 1,
  });
  const deps = acquisition(opts);
  await assert.rejects(() => deps.search('ExampleApp', { signal: new AbortController().signal, timeoutMs: 1000 }));
  assert.equal(calls, 1, 'retry must be refused before the second HTTP request');
});

test('actual fallback preserves successful Provider identity and reserves fallback HTTP', async () => {
  let calls = 0;
  const env = { TAVILY_API_KEY: 'offline-independent-key', EXA_API_KEY: 'offline-independent-exa', TAVILY_TIMEOUT: '1000', EXA_TIMEOUT: '1000' };
  // Setup-only adjudication (current-mechanism review): the same fake
  // transport objects + an operation-local descriptor factory supply the
  // bounded route; every behavioral assertion below is unchanged.
  const transports = {
    tavily: { env, fetch: async () => { calls++; return json({}, 401); } },
    exa: { env, fetch: async () => { calls++; return json({ results: [{ url: URL_USEFUL, title: 'Actual Exa result', highlights: ['lead'] }] }); } } };
  const descriptorFactory = (id, transport) =>
    id === 'tavily' ? createTavilyDescriptor({ transport }) : createExaDescriptor({ transport });
  const descriptors = [descriptorFactory('tavily', transports.tavily), descriptorFactory('exa', transports.exa)];
  const base = { transports, descriptorFactory, env, cache: cache(), sleep: async () => {}, random: () => 0, retryPolicy: noRetry };
  const outcome = await executeWithFallback({ capabilityId: 'search', commandLabel: 'search', effectiveProvider: 'tavily', descriptors, env, fallbackEnabled: true, writeStderr: () => {} }, async descriptor => {
    const deps = acquisition({ ...base, searchDescriptor: descriptor, readerDescriptor: descriptors[0] });
    return deps.search('ExampleApp', { signal: new AbortController().signal, timeoutMs: 1000 });
  });
  assert.equal(outcome.provider, 'exa');
  assert.equal(outcome.fellBack, true);
  assert.equal(outcome.result[0].url, URL_USEFUL);
  assert.equal(calls, 2);
});

test('incremental native body cancellation leaves no stream producer or HTTP retry alive', async () => {
  let active = 0;
  let cancelled = false;
  let calls = 0;
  let interval;
  let streamController;
  const fetch = async () => {
    calls++;
    const stream = new ReadableStream({
      start(controller) {
        streamController = controller;
        active++;
        controller.enqueue(new TextEncoder().encode('{"results":['));
        interval = setInterval(() => controller.enqueue(new TextEncoder().encode(' ')), 5);
      },
      cancel() { cancelled = true; active--; clearInterval(interval); },
    });
    return new Response(stream, { status: 200 });
  };
  const controller = new AbortController();
  const deps = acquisition(options(fetch));
  const timer = setTimeout(() => controller.abort(), 10);
  let pending;
  try {
    pending = deps.search('ExampleApp', { signal: controller.signal, timeoutMs: 100 });
    // Hard test watchdog is NOT evidence of native cancellation. Assertion below
    // still requires cancel() and no active producer; it bounds broken baselines.
    const settled = await Promise.race([pending.then(() => 'resolved', () => 'rejected'), new Promise(resolve => setTimeout(() => resolve('watchdog'), 120))]);
    assert.equal(settled, 'rejected');
    assert.equal(cancelled, true);
    assert.equal(active, 0);
    assert.equal(calls, 1);
  } finally {
    clearTimeout(timer);
    // The broken baseline producer is deliberately cleaned by test-owned abort:
    // bounded process teardown, never counted as production success.
    controller.abort();
    if (active) { clearInterval(interval); streamController.error(new Error('test cleanup')); }
    await pending?.catch(() => {});
  }
});

test('read provenance is from actual normalized Reader serve, never search discovery or malformed warmth', async () => {
  const provenance = [];
  let calls = 0;
  const entries = new Map();
  const opts = options(async () => { calls++; return json({ results: [{ url: 'https://example.test/final', raw_content: TEXT }] }); }, {
    cache: { get: async key => entries.has(key) ? entries.get(key) : { invalid: true }, set: async (key, value) => { entries.set(key, value); } },
    onReadProvenance: record => provenance.push(record),
  });
  const deps = acquisition(opts);
  assert.equal(await deps.read(URL_USEFUL), TEXT);
  assert.equal(provenance.length, 1);
  assert.equal(provenance[0].provider, 'tavily');
  assert.equal(provenance[0].finalUrl, 'https://example.test/final');
  assert.equal(provenance[0].fromCache, false, 'invalid cached value is a miss, not cache provenance');
  assert.equal(await deps.read(URL_USEFUL), TEXT);
  assert.equal(provenance[1].fromCache, true);
  assert.equal(calls, 1);
});

test('fallback shares physical reservation with failed preferred Provider and cannot reset budget', async () => {
  let calls = 0;
  let reservations = 0;
  let reservationChecks = 0;
  const requestedIds = [];
  const env = { TAVILY_API_KEY: 'offline-independent-key', EXA_API_KEY: 'offline-independent-exa', TAVILY_TIMEOUT: '1000', EXA_TIMEOUT: '1000' };
  const transports = {
    tavily: { env, fetch: async () => { calls++; return json({}, 401); } },
    exa: { env, fetch: async () => { calls++; return json({ results: [] }); } },
  };
  const descriptors = [createTavilyDescriptor({ transport: transports.tavily }), createExaDescriptor({ transport: transports.exa })];
  const reservePhysicalAttempt = () => {
    reservationChecks++;
    if (reservations >= 1) throw Object.assign(new Error('physical limit'), { code: 'ACQUISITION_LIMIT' });
    reservations++;
  };
  await assert.rejects(() => executeWithFallback({ capabilityId: 'search', commandLabel: 'search', effectiveProvider: 'tavily', descriptors, env, fallbackEnabled: true, writeStderr: () => {} }, async descriptor => {
    const deps = acquisition({ ...options(transports.tavily.fetch), transports, env, descriptorFactory: (id, transport) => {
      requestedIds.push(id);
      return id === 'tavily' ? createTavilyDescriptor({ transport }) : createExaDescriptor({ transport });
    }, searchDescriptor: descriptor, readerDescriptor: descriptors[0], reservePhysicalAttempt });
    return deps.search('ExampleApp', { signal: new AbortController().signal, timeoutMs: 1000 });
  }));
  assert.equal(calls, 1, 'failed preferred HTTP consumes slot; fallback cannot reset it');
  assert.deepEqual(requestedIds, ['tavily', 'exa']);
  assert.equal(reservationChecks, 2);
  assert.equal(reservations, 1);
});

test('engine resource stop is partial with explicit reasons and no out-of-cap acquisition', async () => {
  const http = fixtureHTTP();
  const input = contract();
  input.limits = { maxSearchAttempts: 1, maxUniqueReads: 1, maxJudgeAttempts: 1 };
  const result = await runLeanInvestigation(input, { ...acquisition(options(http.fetch)), ...semantics() });
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.data, {});
  assert.ok(result.usage.searches <= 1);
  assert.ok(result.usage.readsRetained <= 1);
  assert.ok(result.usage.judgeCalls + result.usage.candidateJudgeCalls <= 1);
  assert.ok(Object.values(result.requirements).every(row => row.status === 'unresolved' && row.reason));
});

test('completed native operations release caller listeners and child controllers', async () => {
  const controller = new AbortController();
  let active = 0;
  const originalAdd = controller.signal.addEventListener.bind(controller.signal);
  const originalRemove = controller.signal.removeEventListener.bind(controller.signal);
  const listeners = new Set();
  controller.signal.addEventListener = (type, fn, opts) => { if (type === 'abort') { listeners.add(fn); active++; } return originalAdd(type, fn, opts); };
  controller.signal.removeEventListener = (type, fn, opts) => { if (type === 'abort' && listeners.delete(fn)) active--; return originalRemove(type, fn, opts); };
  const signals = [];
  const deps = acquisition(options(async (url, init) => { signals.push(init.signal); return new URL(url).pathname === '/search' ? json({ results: [] }) : json({ results: [{ url: URL_USEFUL, raw_content: TEXT }] }); }));
  await deps.search('ExampleApp', { signal: controller.signal, timeoutMs: 1000 });
  await deps.read(URL_USEFUL, { signal: controller.signal, timeoutMs: 1000 });
  assert.equal(active, 0, 'completed operation must detach caller abort listener');
  assert.ok(signals.every(signal => signal.aborted), 'client-owned controllers disposed');
});

test('chunked native response is bounded before client JSON normalization and cancels its reader', async () => {
  let cancelled = false;
  let chunks = 0;
  const fetch = async () => new Response(new ReadableStream({
    pull(controller) {
      chunks++;
      if (chunks <= 3) controller.enqueue(new TextEncoder().encode(' '.repeat(600)));
      else controller.enqueue(new TextEncoder().encode('{"results":[]}'));
      if (chunks === 4) controller.close();
    },
    cancel() { cancelled = true; },
  }), { status: 200 });
  const deps = acquisition(options(fetch, { maxResponseBytes: 1000 }));
  await assert.rejects(() => deps.search('ExampleApp', { signal: new AbortController().signal, timeoutMs: 1000 }));
  assert.equal(cancelled, true, 'body must cancel at byte ceiling, not buffer and parse later');
  assert.ok(chunks < 4);
});
