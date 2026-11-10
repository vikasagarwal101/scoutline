import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateCallerRequest } from '../dist/lib/caller-investigation.js';
import { startCallerRound } from '../dist/lib/lean-caller-rounds.js';

const contract = {
  schemaVersion: 1,
  question: 'Does the source state release 1.2.3?',
  scope: { entity: 'Fixture Alpha' },
  requirements: { release: { question: 'Does the source state release 1.2.3?', schema: { enum: ['supported', 'refuted', 'disputed'] } } },
};
const start = url => ({ schemaVersion: 1, operation: 'start', requirements: contract,
  dataScope: 'public', leads: [{ url }] });

for (const [label, url] of [
  ['loopback IPv4', 'http://127.0.0.1/'],
  ['short IPv4', 'http://127.1/'],
  ['packed IPv4', 'http://2130706433/'],
  ['hex IPv4', 'http://0x7f000001/'],
  ['private IPv4', 'http://10.0.0.1/'],
  ['private 172 range', 'http://172.31.255.255/'],
  ['private 192 range', 'http://192.168.1.1/'],
  ['link-local metadata', 'http://169.254.169.254/'],
  ['shared address space', 'http://100.64.0.1/'],
  ['unspecified IPv4', 'http://0.0.0.0/'],
  ['IPv4 documentation', 'http://192.0.2.1/'],
  ['multicast IPv4', 'http://224.0.0.1/'],
  ['reserved IPv4', 'http://255.255.255.255/'],
  ['loopback IPv6', 'http://[::1]/'],
  ['unspecified IPv6', 'http://[::]/'],
  ['private IPv6', 'http://[fd00::1]/'],
  ['link-local IPv6', 'http://[fe80::1]/'],
  ['mapped loopback', 'http://[::ffff:127.0.0.1]/'],
  ['IPv6 documentation', 'http://[2001:db8::1]/'],
  ['6to4 private embedding', 'http://[2002:7f00:1::]/'],
  ['localhost name', 'http://localhost/'],
  ['localhost trailing dot', 'http://LOCALHOST./'],
  ['localhost subdomain', 'http://api.localhost/'],
  ['local suffix', 'http://printer.local/'],
  ['internal suffix', 'http://metadata.internal/'],
  ['single-label hostname', 'http://intranet/'],
]) {
  test(`caller URL preflight rejects ${label}`, () => {
    assert.throws(() => validateCallerRequest(start(url)), error =>
      error.code === 'VALIDATION_ERROR' && !error.message.includes(url));
  });
}

test('caller URL preflight retains normal domain and public-literal references', () => {
  for (const url of ['https://example.test/release', 'https://fixture.invalid/source',
    'https://PUBLIC.example.:8443/source', 'https://8.8.8.8/source', 'https://[2606:4700:4700::1111]/source']) {
    const request = start(url);
    assert.doesNotThrow(() => validateCallerRequest(request));
    assert.equal(request.leads[0].url, url, 'validation does not rewrite caller evidence identity');
  }
});

test('direct caller-round entry rejects a private lead before creating a store or dispatching', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'caller-url-preflight-'));
  const storeRoot = join(temp, 'not-created');
  const calls = [];
  const deps = { judge: null, now: Date.now,
    search: async () => { calls.push('search'); return []; },
    read: async () => { calls.push('read'); return 'Fixture Alpha release is 1.2.3.'; } };
  try {
    await assert.rejects(startCallerRound({ storeRoot, contract, deps, dataScope: 'public',
      leads: [{ url: 'http://127.0.0.1/private' }] }), { code: 'VALIDATION_ERROR' });
    assert.deepEqual(calls, []);
    await assert.rejects(access(storeRoot), { code: 'ENOENT' });
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('caller reader screens search-discovered destinations while retaining a nonempty allowed baseline', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'caller-reader-url-'));
  try {
    for (const [label, url] of [['allowed', 'https://fixture.test/release'], ['private', 'http://169.254.169.254/metadata']]) {
      const reads = [];
      const result = await startCallerRound({ storeRoot: join(temp, label), contract,
        dataScope: 'public', roundLimits: { maxUniqueReads: 1, maxSearchAttempts: 1 },
        deps: { judge: null, now: Date.now,
          search: async () => [{ url, title: 'Fixture Alpha release' }],
          read: async target => { reads.push(target); return 'Fixture Alpha release is 1.2.3.'; } } });
      assert.equal(result.result.status, 'partial');
      assert.deepEqual(reads, label === 'allowed' ? [url] : [], 'private targets never reach the reader collaborator');
    }
  } finally { await rm(temp, { recursive: true, force: true }); }
});
