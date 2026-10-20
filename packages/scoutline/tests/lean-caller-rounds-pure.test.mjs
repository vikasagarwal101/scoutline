// L6-only regressions. The successful memory store models no filesystem,
// ownership, reservation, ACK, fault, crash or durability guarantees.
// Actual compiled L6 bodies run unchanged; only their store import is replaced.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as crypto from 'node:crypto';
import { SourceTextModule, SyntheticModule } from 'node:vm';
import * as engine from '../dist/lib/lean-investigation.js';
import * as errors from '../dist/lib/errors.js';

const copy = value => structuredClone(value);
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
class ExpectedRevisionError extends Error {}
class CorruptRecordError extends Error {}
async function fixture(observeAdmission = false) {
  const records = new Map(), calls = { create: [], open: [], queries: [], begin: [], settlements: [], releases: 0, bodyWrites: 0, commits: 0, preparations: [], seeds: [] };
  const gates = { create: null, acquire: null, body: null, settlement: null, release: null };
  const store = {
    recoveryRecords: [], // Scalar fixture pages only, never native authority evidence.
    async createInvestigation({ requirements }) {
      calls.create.push(requirements); if (gates.create) await gates.create;
      const ref = `memory-${records.size}`;
      records.set(ref, { bodies: new Map(), snapshot: { schemaVersion: 1, revision: 0, parentRevision: null, createdAt: 1, requirementsDigest: 'synthetic-baseline', bodies: [], rounds: [], outcome: {}, audit: [] } });
      return { investigationRef: ref, revision: 0 };
    },
    async inspect(ref) { return { committed: { snapshot: copy(records.get(ref).snapshot) }, incomplete: null }; },
    async readBody(ref, id) { assert(records.get(ref).bodies.has(id)); return Buffer.from(records.get(ref).bodies.get(id)); },
    async acquireOwnership(ref) {
      if (gates.acquire) await gates.acquire;
      const record = records.get(ref);
      return {
        // Logical projection seam only: no native cursor/authority guarantee.
        async readRecoveryPage() { return { records: copy(store.recoveryRecords), cursor: null, complete: true, revision: record.snapshot.revision, viewDigest: digest(JSON.stringify(record.snapshot)) }; },
        async beginRound(round) { calls.begin.push(copy(round)); }, async appendAudit() {},
        async settleRound(roundId, summary) { calls.settlements.push({ roundId, summary: copy(summary) }); if (gates.settlement) await gates.settlement(); },
        async release() { calls.releases++; if (gates.release) await gates.release(); },
        async stageBody(text) { calls.bodyWrites++; if (gates.body) await gates.body(text); const bytes = Buffer.from(text), bodyId = `b:${digest(bytes)}`; record.bodies.set(bodyId, bytes); return { bodyId, bytes: bytes.length }; },
        async commitRevision({ snapshot }) { calls.commits++; record.snapshot = copy(snapshot); },
      };
    },
  };
  const synthetic = (namespace, identifier) => new SyntheticModule(Object.keys(namespace), function () { for (const [key, value] of Object.entries(namespace)) this.setExport(key, value); }, { identifier });
  const links = [], hashes = {};
  const body = name => { const url = new URL(`../dist/lib/${name}.js`, import.meta.url), bytes = readFileSync(url); hashes[name] = digest(bytes); return new SourceTextModule(bytes.toString(), { identifier: url.href }); };
  const physical = body('caller-physical'), caller = body('lean-caller-rounds');
  const modules = {
    'node:crypto': synthetic(crypto, 'real-crypto'), './errors.js': synthetic(errors, 'real-errors'),
    // Optional observation delegates unchanged to the actual engine/preflight;
    // it records their input references, never substitutes proof decisions.
    './lean-investigation.js': synthetic(observeAdmission ? { ...engine,
      prepareLeanCallerHistory(...args) { calls.preparations.push({ evidence: args[1], candidates: args[3] }); return engine.prepareLeanCallerHistory(...args); },
      runLeanInvestigation(contract, deps) { calls.seeds.push(deps.seed); return engine.runLeanInvestigation(contract, deps); },
    } : engine, 'real-engine'), './caller-physical.js': physical,
    './retained-record-store.js': synthetic({ ExpectedRevisionError, CorruptRecordError, openStore(options) { calls.open.push(options); return store; } }, 'successful-memory-store-only'),
  };
  const link = (specifier, importing) => { assert(Object.hasOwn(modules, specifier), `Unexpected import ${specifier}`); links.push({ from: importing.identifier, specifier }); return modules[specifier]; };
  // Default context deliberately shares the current realm; plain JSON objects
  // must reach the real compiler without prototype normalization or a shim.
  await physical.link(link); await caller.link(link); await caller.evaluate();
  assert.equal(Object.getPrototypeOf(caller.namespace), null);
  const deps = { now: () => 0, judge: null, search: async query => { calls.queries.push(query); return []; }, read: async () => { throw new Error('No acquired read expected'); } };
  return { api: caller.namespace, validatePhysical: physical.namespace.validateCallerPhysical, store, calls, gates, deps, binding: { hashes, links } };
}
const contract = () => ({ schemaVersion: 1, question: 'Version?', requirements: { version: { question: 'Version?', schema: { type: 'string' } } }, limits: { maxSearchAttempts: 1, maxUniqueReads: 1, maxJudgeAttempts: 1 } });
const start = (f, extra = {}) => f.api.startCallerRound({ storeRoot: 'successful-memory-only', contract: contract(), deps: f.deps, ...extra });

test('F1 canonical evidence criteria reach start and explicit replacement; unsupported keys still refuse', async () => {
  const f = await fixture(), submitted = { ...contract(), evidence: { criteria: ['Use the declared release.'] } };
  assert.deepEqual(engine.compileLeanContract(submitted).evidenceCriteria, submitted.evidence.criteria);
  let first;
  await assert.doesNotReject(async () => { first = await start(f, { contract: submitted }); }, 'canonical evidence criteria must reach the caller engine');
  assert.deepEqual(first.contract.evidence.criteria, submitted.evidence.criteria);
  const replacement = { ...contract(), evidence: { criteria: ['Use the replacement criteria.'] } };
  const second = await f.api.continueCallerRound({ storeRoot: first.storeRoot, investigationRef: first.investigationRef, expectedRevision: first.handoff.revision, contract: replacement, deps: f.deps });
  assert.deepEqual(second.contract.evidence.criteria, replacement.evidence.criteria);
  const retained = await f.api.readCallerRecord(first.storeRoot, first.investigationRef);
  assert.deepEqual(retained.contract.evidence.criteria, replacement.evidence.criteria);
  for (const extra of [{ unknownControl: true }, { evidenceCriteria: ['compiled-only spelling'] }]) {
    const before = f.calls.open.length;
    await assert.rejects(start(f, { contract: { ...contract(), ...extra } }), error => error.code === 'VALIDATION_ERROR');
    assert.equal(f.calls.open.length, before, 'bad contract refuses before store work');
  }
  console.log(JSON.stringify({ case: 'F1', actualBindings: f.binding, roundCount: retained.history.length }));
});

test('F2 start owns submitted JSON through the first successful await without cloning runtime dependencies', async () => {
  const f = await fixture(), controller = new AbortController(), reads = [];
  f.deps.externalSignal = controller.signal;
  f.deps.read = async url => { reads.push(url); return 'Test release 2.4 lead.'; };
  let release; f.gates.create = new Promise(resolve => { release = resolve; });
  const submitted = contract(); submitted.scope = { entity: 'Test', release: '2.4' }; submitted.limits.maxUniqueReads = 2;
  const requirements = { schemaVersion: 1, fields: { version: { definition: 'submitted definition', required: true } } };
  const representation = { format: 'text', content: 'Test release 2.4.', label: 'submitted label' };
  const lead = { url: 'https://fixture.invalid/submitted', title: 'submitted lead' }, storeDeps = {};
  let observations = 0;
  const input = { storeRoot: 'submitted-root', contract: submitted, requirements, representations: [representation], leads: [lead], roundLimits: { maxUniqueReads: 2 }, deps: f.deps, storeOptions: { deps: storeDeps },
    nativeObservation: () => { observations++; return { schemaVersion: 1, source: 'handler-owned-native-ledger', cutoff: 'locally-settled', stages: { acquisition: 0, judge: null, producer: null }, knownSubtotal: 0, total: 0, reservationsRefused: 0, admission: { acquisition: 'shared', judge: 'not-configured', producer: 'not-configured' }, attempts: [] }; } };
  const pending = f.api.startCallerRound(input);
  submitted.question = 'License?'; submitted.requirements.version.question = 'License?'; submitted.scope.release = '3.0';
  requirements.fields.version.definition = 'mutated definition'; requirements.fields.version.required = false;
  representation.content = 'Test release 3.0.'; representation.label = 'mutated label'; representation.format = 'markdown';
  lead.url = 'https://fixture.invalid/mutated'; input.roundLimits.maxUniqueReads = 1; input.storeRoot = 'mutated-root';
  release(); const result = await pending;
  assert.equal(result.result.question, 'Version?', 'start must execute the entry-time question');
  assert.equal(result.contract.requirements.version.question, 'Version?'); assert.equal(result.contract.scope.release, '2.4');
  assert.equal(result.storeRoot, 'submitted-root'); assert.equal(result.contract.limits.maxUniqueReads, 2);
  assert.deepEqual(f.calls.create[0], { schemaVersion: 1, fields: { version: { definition: 'submitted definition', required: true } } });
  const supplied = result.result.evidence.find(e => e.url.startsWith('caller:'));
  assert(supplied); assert.equal(supplied.content, 'Test release 2.4.'); assert.equal(supplied.title, 'submitted label');
  assert.equal(result.handoff.evidence.find(e => e.evidenceId === supplied.evidenceId).format, 'text');
  assert.deepEqual(reads, ['https://fixture.invalid/submitted'], 'the submitted lead, not its later mutation, drives the real engine');
  assert.equal(f.calls.open[0].deps, storeDeps, 'runtime store options stay by reference'); assert.equal(observations, 1);
  assert.equal(controller.signal.aborted, false); assert.equal(result.result.assessment, 'deterministic-only');
  console.log(JSON.stringify({ case: 'F2-start', actualBindings: f.binding, queries: f.calls.queries, reads }));
});

test('F2 continue owns nested proposal ranges and round feedback before successful acquisition', async () => {
  const f = await fixture(), first = await start(f, { representations: [{ format: 'text', content: 'Test release 2.4.', label: 'initial' }] });
  const evidence = first.handoff.evidence[0]; assert(evidence);
  const proposal = { fieldId: 'version', mode: 'string', value: '2.4', definitionRevision: first.handoff.definitions.version,
    representationId: evidence.representationId, digest: evidence.digest, quote: '2.4', charRange: [13, 16] };
  const input = { storeRoot: first.storeRoot, investigationRef: first.investigationRef, expectedRevision: first.handoff.revision, deps: f.deps,
    proposals: [proposal], roundLimits: { maxSearchAttempts: 1 }, representations: [{ format: 'text', content: 'Additional original context.', label: 'original' }] };
  let release; f.gates.acquire = new Promise(resolve => { release = resolve; });
  const pending = f.api.continueCallerRound(input);
  proposal.value = '9.9'; proposal.quote = 'bad'; proposal.charRange[0] = 0; proposal.charRange[1] = 3;
  input.expectedRevision = 999; input.roundLimits.maxSearchAttempts = 0; input.representations[0].content = 'Mutated context.';
  release(); let second;
  await assert.doesNotReject(async () => { second = await pending; }, 'continue must use admitted feedback, not later caller mutations');
  f.gates.acquire = null;
  const retained = await f.api.readCallerRecord(first.storeRoot, first.investigationRef);
  assert.deepEqual(retained.payload.proposals[0], { evidenceId: evidence.evidenceId, fieldId: 'version', mode: 'string', value: '2.4', definitionRevision: first.handoff.definitions.version,
    representationId: evidence.representationId, digest: evidence.digest, quote: '2.4', charRange: [13, 16] });
  assert(second.result.evidence.some(e => e.content === 'Additional original context.'));
  assert(!second.result.evidence.some(e => e.content === 'Mutated context.'));
  assert.equal(second.result.assessment, 'deterministic-only'); assert(!('version' in second.result.data));
  const replacement = contract(); replacement.question = 'License?'; replacement.requirements.version.question = 'License?';
  const third = await f.api.continueCallerRound({ storeRoot: first.storeRoot, investigationRef: first.investigationRef, expectedRevision: second.handoff.revision, contract: replacement, deps: f.deps });
  assert.equal(third.result.question, 'License?', 'a later explicit operation still supplies new intent');
  console.log(JSON.stringify({ case: 'F2-continue', actualBindings: f.binding, proposal: retained.payload.proposals[0], explicitReplacement: third.result.question }));
});

test('F2 corrected compatibility preserves accepted outer-class own data and null rejection', async () => {
  const f = await fixture(), ordinary = await fixture();
  await assert.rejects(start(f, { contract: null }), error => error.code === 'VALIDATION_ERROR');
  assert.equal(f.calls.open.length, 0, 'null contract still refuses before store work');
  class OwnDataContract { constructor() { Object.assign(this, contract()); } }
  const supplied = new OwnDataContract(), originalData = copy(supplied);
  assert.deepEqual(engine.compileLeanContract(supplied), engine.compileLeanContract(contract()));
  const fromClass = await start(f, { contract: supplied }), fromPlain = await start(ordinary);
  assert.deepEqual(fromClass.result, fromPlain.result, 'accepted own data has the same executed meaning');
  assert.deepEqual(copy(supplied), originalData, 'snapshotting does not mutate submitted own data');
});

test('F2 typed JSON clone boundary refuses uncloneable submitted requirements before store work', async () => {
  const f = await fixture();
  await assert.rejects(start(f, { requirements: { schemaVersion: 1, fields: { version: { definition: () => 'not JSON', required: true } } } }),
    error => error.code === 'VALIDATION_ERROR', 'typed JSON clone boundary must refuse before store work');
  assert.equal(f.calls.open.length, 0);
});

const observation = () => ({ schemaVersion: 1, source: 'handler-owned-native-ledger', cutoff: 'locally-settled', stages: { acquisition: 2, judge: 0, producer: 0 }, knownSubtotal: 2, total: 2, reservationsRefused: 0, admission: { acquisition: 'shared', judge: 'shared', producer: 'shared' }, attempts: [] });
test('F3 unknown configured measurements cannot certify a known total', async () => {
  const f = await fixture();
  for (const stage of ['judge', 'producer']) for (const admission of ['shared', 'unknown']) {
    const incomplete = observation(); incomplete.stages[stage] = null; incomplete.admission[stage] = admission;
    assert.throws(() => f.validatePhysical(incomplete), CorruptRecordError, 'unknown configured measurement must keep total null');
    assert.doesNotThrow(() => f.validatePhysical({ ...incomplete, total: null }));
  }
  const measured = observation(); measured.stages.judge = 3; measured.stages.producer = 1; measured.knownSubtotal = measured.total = 6;
  measured.admission.judge = measured.admission.producer = 'unknown';
  assert.doesNotThrow(() => f.validatePhysical(measured), 'known measurement and unknown admission are separate');
  assert.doesNotThrow(() => f.validatePhysical({ ...measured, total: null }), 'conservative unknown total stays valid');
  assert.throws(() => f.validatePhysical({ ...measured, knownSubtotal: 7 }), CorruptRecordError);
});

test('F3 not-configured stages retain known zero absence without positive attempts', async () => {
  const f = await fixture();
  for (const zero of [null, 0]) {
    const absent = observation(); absent.stages.judge = absent.stages.producer = zero;
    absent.admission.judge = absent.admission.producer = 'not-configured';
    assert.doesNotThrow(() => f.validatePhysical(absent), 'unconfigured null/zero is known absence');
  }
  for (const stage of ['judge', 'producer']) {
    const inconsistent = observation(); inconsistent.admission[stage] = 'not-configured'; inconsistent.stages[stage] = 1; inconsistent.knownSubtotal = inconsistent.total = 3;
    assert.throws(() => f.validatePhysical(inconsistent), CorruptRecordError, 'not-configured stage cannot report positive attempts');
  }
});

// Decode through the same content-addressed public memory-store surface.
async function documentAt(f, ref, pointer) {
  return JSON.parse((await Promise.all(pointer.chunks.map(b => f.store.readBody(ref, b.bodyId)))).map(b => b.toString('utf8')).join(''));
}
async function currentState(f, ref) {
  const snapshot = (await f.store.inspect(ref)).committed.snapshot;
  const root = JSON.parse(snapshot.audit.at(-1).detail).root;
  const pointer = JSON.parse((await f.store.readBody(ref, root)).toString('utf8'));
  return { snapshot, pointer, state: await documentAt(f, ref, pointer.state) };
}

test('F4 distinct same-byte submissions keep exact unverified claims through current and immutable history', async () => {
  const f = await fixture(), content = 'Test release 2.4.', claims = ['  Publisher A  ', ''];
  const first = await start(f, { representations: claims.map((claimedSource, i) => ({ format: i ? 'markdown' : 'text', content,
    claimedSource, verification: 'verified', unwanted: { secret: true } })) });
  const supplied = first.result.evidence;
  assert.equal(supplied.length, 2);
  assert.notEqual(supplied[0].evidenceId, supplied[1].evidenceId);
  assert.notEqual(supplied[0].url, supplied[1].url);
  for (const [i, e] of supplied.entries()) {
    assert.deepEqual(e.suppliedProvenance, { claimedSource: claims[i], verification: 'unverified' });
    assert.deepEqual(first.handoff.evidence.find(r => r.evidenceId === e.evidenceId).suppliedProvenance, e.suppliedProvenance);
    assert.deepEqual(e.origins, []); assert.equal(Object.hasOwn(e, 'unwanted'), false);
  }
  const saved = copy((await f.api.readCallerRecord(first.storeRoot, first.investigationRef)).payload);
  const stored = await currentState(f, first.investigationRef);
  assert.equal(new Set(stored.state.evidence.map(e => e.body.bodyId)).size, 1);
  assert.equal(stored.snapshot.bodies.filter(b => b.bodyId === first.handoff.evidence[0].representationId).length, 1);
  assert(stored.snapshot.bodies.every(b => !Object.hasOwn(b, 'claimedSource')));
  assert.deepEqual(stored.state.evidence.map(e => e.body.claimedSource), claims);
  assert(stored.state.evidence.every(e => !Object.hasOwn(e.record, 'suppliedProvenance')));
  const second = await f.api.continueCallerRound({ storeRoot: first.storeRoot, investigationRef: first.investigationRef,
    expectedRevision: first.handoff.revision, deps: f.deps,
    representations: [{ format: 'text', content, claimedSource: 'later' }, { format: 'text', content: 'No claim.' }] });
  assert.deepEqual(second.result.evidence.slice(0, 3).map(e => e.suppliedProvenance.claimedSource), [...claims, 'later']);
  assert.equal(Object.hasOwn(second.result.evidence[3], 'suppliedProvenance'), false);
  assert.deepEqual((await f.api.readCallerRecord(first.storeRoot, first.investigationRef, 1)).payload, saved);
  const current = await f.api.readCallerRecord(first.storeRoot, first.investigationRef);
  assert.deepEqual(current.payload.result, second.result);
  second.result.evidence[0].suppliedProvenance.claimedSource = 'outward mutation';
  assert.deepEqual((await f.api.readCallerRecord(first.storeRoot, first.investigationRef, 1)).payload, saved);
});


test('F4 present non-string claims refuse before store work', async () => {
  const f = await fixture();
  for (const claimedSource of [undefined, null, 1, false, [], {}]) {
    const before = f.calls.open.length;
    await assert.rejects(start(f, { representations: [{ format: 'text', content: 'Context.', claimedSource }] }),
      error => error.code === 'VALIDATION_ERROR');
    assert.equal(f.calls.open.length, before);
  }
});


// Rewrite only content-addressed in-memory fixture documents to model a prior
// writer or corrupt persisted authority. This models no native-store fault.
async function rewriteCurrent(f, ref, mutate) {
  const { snapshot, pointer, state } = await currentState(f, ref);
  const handle = await f.store.acquireOwnership(ref);
  const list = b => { if (!snapshot.bodies.some(x => x.bodyId === b.bodyId)) snapshot.bodies.push(b); };
  const stage = async text => {
    const chunks = [];
    for (let i = 0; i < text.length; i += 4096) {
      const b = await handle.stageBody(text.slice(i, i + 4096));
      const chunk = { bodyId: b.bodyId, digest: `sha256:${b.bodyId.slice(2)}`, bytes: b.bytes };
      chunks.push(chunk); list(chunk);
    }
    return { digest: `sha256:${digest(text)}`, chunks };
  };
  try {
    await mutate({ state, pointer, snapshot, stage, read: p => documentAt(f, ref, p) });
    pointer.state = await stage(JSON.stringify(state));
    const root = await handle.stageBody(JSON.stringify(pointer));
    list({ bodyId: root.bodyId, digest: `sha256:${root.bodyId.slice(2)}`, bytes: root.bytes });
    snapshot.audit = [{ at: 1, kind: 'definition-ref', detail: JSON.stringify({ schemaVersion: 1, root: root.bodyId }) }];
    await handle.commitRevision({ snapshot });
  } finally { await handle.release(); }
}

test('F4 malformed recognized persisted provenance refuses while unrelated extensions and legacy absence stay valid', async () => {
  for (const bag of [null, { claimedSource: 7, verification: 'unverified' }, { claimedSource: 'x', verification: 'verified' },
    { verification: 'unverified' }, { claimedSource: 'x', verification: 'unverified', extra: true }]) {
    const f = await fixture(), first = await start(f, { representations: [{ format: 'text', content: 'Context.' }] });
    await rewriteCurrent(f, first.investigationRef, async ({ state, stage, read }) => {
      const entry = state.results.at(-1), payload = await read(entry.result);
      payload.result.evidence[0].suppliedProvenance = bag;
      entry.result = await stage(JSON.stringify(payload));
    });
    await assert.rejects(f.api.readCallerRecord(first.storeRoot, first.investigationRef), CorruptRecordError);
  }
  const f = await fixture(), first = await start(f, { representations: [{ format: 'text', content: 'Context.' }] });
  await rewriteCurrent(f, first.investigationRef, async ({ state, stage, read }) => {
    const entry = state.results.at(-1), payload = await read(entry.result);
    payload.result.evidence[0].unrelatedExtension = { allowed: true };
    entry.result = await stage(JSON.stringify(payload));
  });
  const retained = await f.api.readCallerRecord(first.storeRoot, first.investigationRef);
  assert.equal(Object.hasOwn(retained.payload.result.evidence[0], 'suppliedProvenance'), false);
  assert.deepEqual(retained.payload.result.evidence[0].unrelatedExtension, { allowed: true });
});


const lineageContract = () => ({ schemaVersion: 1, question: 'Assess LineageFixture 1.0 exports.', scope: { release: '1.0' },
  requirements: { csv: { question: 'Does LineageFixture 1.0 support CSV?', schema: { enum: ['supported', 'refuted', 'disputed'] } } },
  limits: { maxSearchAttempts: 3, maxUniqueReads: 2, readBatchSize: 1 } });
async function lineageFixture() {
  const f = await fixture(), url = 'https://fixture.invalid/l6-lineage', content = 'LineageFixture 1.0 supports CSV.';
  const calls = [], judged = [];
  f.deps.search = async query => { calls.push(['search', query]); return [{ url, title: 'Search title' }]; };
  f.deps.read = async readUrl => { calls.push(['read', readUrl]); return content; };
  f.deps.judge = async ({ documents }) => {
    judged.push({ documents, before: copy(documents) });
    return { documents: documents.map(d => ({ evidenceId: d.evidenceId, relevant: true, supportsClaim: true, refutesClaim: false })) };
  };
  const first = await start(f, { contract: lineageContract(), leads: [{ url, title: 'Caller title' }] });
  return { f, first, calls, judged };
}
const metadata = ({ content: _, suppliedProvenance: __, ...rest }) => rest;

test('R5 forward reconciliation owns final metadata in state/outcome and the next seed without changing early judgments or history', async () => {
  const { f, first, calls, judged } = await lineageFixture();
  const final = first.result.evidence[0];
  assert.equal(calls[0][0], 'read', 'lead was retained before discovery');
  assert.equal(first.result.usage.readAttempts, 1);
  assert.deepEqual(final.origins, first.result.plan.queries.map(q => q.query));
  assert.equal(final.origins.length, 3, 'nonempty late lineage is the causal precondition');
  assert(judged.length > 0);
  for (const early of judged) assert.deepEqual(early.documents, early.before, 'early custom judge metadata stays immutable');
  assert.notDeepEqual(judged[0].before[0].origins, final.origins, 'final metadata must add later discoveries');
  const stored = await currentState(f, first.investigationRef);
  assert.deepEqual(stored.state.evidence[0].record, metadata(final));
  assert.deepEqual(stored.snapshot.outcome.evidence, [metadata(final)]);
  const saved = copy((await f.api.readCallerRecord(first.storeRoot, first.investigationRef, 1)).payload);
  const before = calls.length;
  const second = await f.api.continueCallerRound({ storeRoot: first.storeRoot, investigationRef: first.investigationRef,
    expectedRevision: first.handoff.revision, deps: f.deps, roundLimits: { maxSearchAttempts: 1 } });
  assert.equal(calls.length, before, 'same basis reuses coverage and bodies with zero search/read');
  assert.deepEqual(second.result.evidence, first.result.evidence);
  assert.deepEqual((await currentState(f, first.investigationRef)).state.evidence[0].record, metadata(final));
  assert.deepEqual((await f.api.readCallerRecord(first.storeRoot, first.investigationRef, 1)).payload, saved);
  second.result.evidence[0].origins.push('outward mutation');
  assert.deepEqual((await f.api.readCallerRecord(first.storeRoot, first.investigationRef, 1)).payload, saved);
  for (const early of judged) assert.deepEqual(early.documents, early.before);
});


test('R5 hydration restores an old stale state from the accurate latest result with zero rediscovery', async () => {
  const { f, first, calls } = await lineageFixture();
  const accurate = copy(first.result.evidence), saved = copy((await f.api.readCallerRecord(first.storeRoot, first.investigationRef)).payload);
  await rewriteCurrent(f, first.investigationRef, async ({ state }) => {
    state.evidence[0].record.origins = []; state.evidence[0].record.title = 'Old writer title';
  });
  const old = await currentState(f, first.investigationRef);
  assert.notDeepEqual(old.state.evidence[0].record, metadata(accurate[0]));
  assert.deepEqual((await f.api.readCallerRecord(first.storeRoot, first.investigationRef)).payload, saved);
  const before = calls.length;
  const second = await f.api.continueCallerRound({ storeRoot: first.storeRoot, investigationRef: first.investigationRef,
    expectedRevision: first.handoff.revision, deps: f.deps, roundLimits: { maxSearchAttempts: 1 } });
  assert.equal(calls.length, before);
  assert.deepEqual(second.result.evidence, accurate, 'forward reconciliation alone cannot restore skipped discovery');
  const current = await currentState(f, first.investigationRef);
  assert.deepEqual(current.state.evidence[0].record, metadata(accurate[0]));
  assert.deepEqual(current.snapshot.outcome.evidence, accurate.map(metadata));
  assert.deepEqual((await f.api.readCallerRecord(first.storeRoot, first.investigationRef, 1)).payload, saved);
});


test('R5 legacy absent history remains limited through two upgraded continuations with a contiguous suffix', async () => {
  const f = await fixture(), first = await start(f, { representations: [{ format: 'text', content: 'Legacy context.' }] });
  await rewriteCurrent(f, first.investigationRef, async ({ state }) => { delete state.results; });
  await assert.rejects(f.api.readCallerRecord(first.storeRoot, first.investigationRef), CorruptRecordError);
  let last = first;
  for (let i = 0; i < 2; i++) {
    last = await f.api.continueCallerRound({ storeRoot: first.storeRoot, investigationRef: first.investigationRef,
      expectedRevision: last.handoff.revision, deps: f.deps });
    const { state } = await currentState(f, first.investigationRef);
    assert.deepEqual(state.results.map(r => r.revision), Array.from({ length: i + 1 }, (_, j) => j + 2));
    assert.equal(Object.hasOwn(last.result.evidence[0], 'suppliedProvenance'), false);
    await assert.rejects(f.api.readCallerRecord(first.storeRoot, first.investigationRef), CorruptRecordError,
      'continuation authority does not fabricate complete historical authority');
  }
});

test('R5 hydration binds against the stored contract while accepting explicit replacement intent', async () => {
  const { f, first } = await lineageFixture();
  await rewriteCurrent(f, first.investigationRef, async ({ state }) => { state.evidence[0].record.origins = []; });
  const replacement = lineageContract(); replacement.question = 'New explicit intent';
  const second = await f.api.continueCallerRound({ storeRoot: first.storeRoot, investigationRef: first.investigationRef,
    expectedRevision: first.handoff.revision, contract: replacement, deps: f.deps });
  assert.equal(second.result.question, replacement.question);
  assert(second.result.evidence[0].origins.includes(first.result.plan.queries[0].query));
});

test('R5 latest authority refuses malformed history, wrong tuple, contract, pointer, definitions and evidence before begin or dispatch', async () => {
  const cases = {
    empty: ({ state }) => { state.results = []; },
    nonarray: ({ state }) => { state.results = {}; },
    revision: ({ entry }) => { entry.revision += 1; },
    round: ({ entry }) => { entry.roundId = 'wrong-round'; },
    intent: ({ entry }) => { entry.intent = 'continue'; },
    contract: ({ entry }) => { entry.contract = { ...entry.contract, digest: 'sha256:' + '0'.repeat(64) }; },
    pointer: ({ entry }) => { entry.result = { ...entry.result, digest: 'sha256:' + '0'.repeat(64) }; },
    definitions: ({ payload }) => { payload.definitions.version = 'wrong'; },
    missing: ({ payload }) => { payload.result.evidence = []; },
    extra: ({ payload }) => { payload.result.evidence.push({ ...payload.result.evidence[0], evidenceId: 'extra' }); },
    duplicate: ({ payload }) => { payload.result.evidence.push(copy(payload.result.evidence[0])); },
    url: ({ payload }) => { payload.result.evidence[0].url += '/wrong'; },
    digest: ({ payload }) => { payload.result.evidence[0].content = 'Changed bytes.'; payload.result.evidence[0].byteLength = 14; },
    metadata: ({ payload }) => { payload.result.evidence[0].origins = [7]; },
    provenance: ({ payload }) => { payload.result.evidence[0].suppliedProvenance = { claimedSource: 'x', verification: 'verified' }; },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const f = await fixture(), first = await start(f, { representations: [{ format: 'text', content: 'Context.' }] });
    await rewriteCurrent(f, first.investigationRef, async ({ state, stage, read }) => {
      const entry = state.results.at(-1), payload = await read(entry.result);
      mutate({ state, entry, payload });
      if (!['empty', 'nonarray', 'pointer'].includes(name)) entry.result = await stage(JSON.stringify(payload));
    });
    const begin = f.calls.begin.length, queries = f.calls.queries.length;
    await assert.rejects(f.api.continueCallerRound({ storeRoot: first.storeRoot, investigationRef: first.investigationRef,
      expectedRevision: first.handoff.revision, deps: f.deps }), CorruptRecordError, name);
    assert.equal(f.calls.begin.length, begin, name + ' must refuse before begin');
    assert.equal(f.calls.queries.length, queries, name + ' must refuse before search');
  }
});

test('R5 reordered same-byte authority preserves distinct event joins and authoritative empty origins', async () => {
  const f = await fixture(), first = await start(f, { representations: ['A', 'B'].map(claimedSource => ({ format: 'text', content: 'Same bytes.', claimedSource })) });
  await rewriteCurrent(f, first.investigationRef, async ({ state, stage, read }) => {
    const entry = state.results.at(-1), payload = await read(entry.result);
    payload.result.evidence[0].title = 'Final A'; payload.result.evidence[0].origins = ['A query'];
    payload.result.evidence[1].title = 'Final B'; payload.result.evidence[1].origins = [];
    state.evidence[1].record.origins = ['Stale B query'];
    payload.result.evidence.reverse(); entry.result = await stage(JSON.stringify(payload));
  });
  const second = await f.api.continueCallerRound({ storeRoot: first.storeRoot, investigationRef: first.investigationRef,
    expectedRevision: first.handoff.revision, deps: f.deps });
  assert.deepEqual(second.result.evidence.map(e => [e.title, e.origins, e.suppliedProvenance.claimedSource]),
    [['Final A', ['A query'], 'A'], ['Final B', [], 'B']]);
});


test('R5 final reconciliation preserves the custom candidate descriptor and owned early origins', async () => {
  const f = await fixture(), url = 'https://fixture.invalid/l6-license', content = 'Release 1.0: License MIT.';
  const judged = [], snapshots = [];
  f.deps.search = async () => [{ url, title: 'Search title' }];
  f.deps.read = async () => content;
  f.deps.judge = async () => { assert.fail('no enum judgment for value field'); };
  f.deps.extract = async () => ({ finishReason: 'stop', rawOutput: JSON.stringify({ license: { value: 'MIT', quote: 'License MIT' } }), usage: null, observedCost: null });
  f.deps.candidateJudge = async input => {
    judged.push(input); snapshots.push(copy(input));
    Object.freeze(input.source.origins); Object.freeze(input.source);
    return { model: 'fixture', answers: { q0s: { type: 'noul', noul: 0.97 }, q0c: { type: 'noul', noul: 0.01 } },
      usage: { inputTokens: 1, outputTokens: 1 }, requestSha256: 'a'.repeat(64), elapsedMs: 1 };
  };
  const first = await start(f, { contract: { schemaVersion: 1, question: 'Assess license', scope: { release: '1.0' },
    requirements: { license: { question: 'License of scoped release', schema: { type: 'string' } } } },
    leads: [{ url, title: 'Caller license' }], judgeIdentity: 'fixture', policyRevision: '1' });
  assert.equal(first.result.data.license, 'MIT'); assert.equal(judged.length, 1);
  assert.deepEqual(judged[0], snapshots[0]); assert.deepEqual(judged[0].source.origins, []);
  assert.equal(first.result.evidence[0].origins.length, 3);
  const stored = await currentState(f, first.investigationRef);
  assert.deepEqual(stored.state.evidence[0].record, metadata(first.result.evidence[0]));
  assert.notEqual(stored.state.evidence[0].record.origins, judged[0].source.origins);
  const history = copy(stored.state.checkpoint.history), judgment = copy(first.result.requirements.license.judgment);
  const second = await f.api.continueCallerRound({ storeRoot: first.storeRoot, investigationRef: first.investigationRef,
    expectedRevision: first.handoff.revision, deps: f.deps, judgeIdentity: 'fixture', policyRevision: '1' });
  assert.equal(judged.length, 1, 'metadata reconciliation preserves valid proof reuse');
  assert.deepEqual(judged[0], snapshots[0]);
  assert.deepEqual(second.result.requirements.license.judgment, judgment);
  const nextHistory = (await currentState(f, first.investigationRef)).state.checkpoint.history;
  assert.deepEqual(nextHistory.slice(0, history.length), history, 'prior checkpoints remain immutable');
  assert.equal(nextHistory.length, history.length + 1, 'this single-field round appends one checkpoint');
  const prior = history.at(-1), appended = nextHistory.at(-1);
  assert.equal(appended.namespace, prior.namespace);
  assert.equal(appended.context, prior.context);
  assert.equal(appended.context, JSON.stringify(second.result.evidence.map(e => [e.evidenceId, digest(e.content)])));
  assert.deepEqual(appended.state.acceptedCandidate, prior.state.acceptedCandidate);
  assert.deepEqual(appended.state.acceptedCandidate.provenance, first.result.requirements.license.provenance);
  assert.deepEqual(appended.state.acceptedCandidate.provenance, second.result.requirements.license.provenance);
  assert.deepEqual(appended.state.acceptedCandidate.judgment, judgment);
  assert.deepEqual(appended.state.acceptedCandidate.judgment, second.result.requirements.license.judgment);
  console.log(JSON.stringify({ case: 'R5-corrected-history-bindings', oldLength: history.length, newLength: nextHistory.length,
    namespaceSHA256: digest(appended.namespace), context: appended.context,
    priorPrefixSHA256: digest(JSON.stringify(history)), actualPrefixSHA256: digest(JSON.stringify(nextHistory.slice(0, history.length))),
    acceptedProofSHA256: digest(JSON.stringify(appended.state.acceptedCandidate)) }));
});


test('P2 first explicit string binding is assessed after an automatic acceptance', async () => {
  const f = await fixture(), content = 'Release 1.0: License MIT; License Apache.', judged = [];
  const submitted = { schemaVersion: 1, question: 'License?', requirements: { license: { question: 'License?', schema: { type: 'string' } } } };
  f.deps.judge = async () => { assert.fail('value-only fixture has no enum judgment'); };
  f.deps.extract = async () => ({ finishReason: 'stop', rawOutput: JSON.stringify({ license: { value: 'MIT', quote: 'License MIT' } }), usage: null, observedCost: null });
  f.deps.candidateJudge = async input => {
    judged.push(copy(input));
    return { model: 'fixture', answers: { q0s: { type: 'noul', noul: 0.97 }, q0c: { type: 'noul', noul: 0.01 } },
      usage: { inputTokens: 1, outputTokens: 1 }, requestSha256: 'a'.repeat(64), elapsedMs: 1 };
  };
  const first = await start(f, { contract: submitted, representations: [{ format: 'text', content }], judgeIdentity: 'fixture', policyRevision: '1' });
  assert.equal(first.result.data.license, 'MIT', 'automatic A must be accepted before the first proposal');
  assert(judged.length > 0);
  const representation = first.handoff.evidence[0], quote = 'License Apache', offset = content.indexOf(quote);
  const proposal = { fieldId: 'license', mode: 'string', value: 'Apache', definitionRevision: first.handoff.definitions.license,
    representationId: representation.representationId, digest: representation.digest, quote, charRange: [offset, offset + quote.length] };
  const before = judged.length;
  const second = await f.api.continueCallerRound({ storeRoot: first.storeRoot, investigationRef: first.investigationRef,
    expectedRevision: first.handoff.revision, deps: f.deps, judgeIdentity: 'fixture', policyRevision: '1', proposals: [proposal] });
  assert(judged.length > before, 'first distinct bound B must be assessed, not ignored behind automatic A');
  assert.equal(judged.length - before, second.result.usage.candidateJudgeCalls);
  assert.equal(judged.at(-1).candidates[0].value, proposal.value);
  assert.equal(second.result.data.license, proposal.value);
  assert.equal(second.result.requirements.license.provenance.quote, quote);
  assert.deepEqual(second.result.requirements.license.provenance.charRange, proposal.charRange);
  assert.notEqual(second.result.requirements.license.judgment.candidateId, first.result.requirements.license.judgment.candidateId);
});


async function dispositionFixture(mode = 'accepted', observeAdmission = false) {
  const f = await fixture(observeAdmission), content = 'Release 1.0: License MIT; License Apache.', calls = [];
  f.deps.judge = async () => { assert.fail('value field only'); };
  f.deps.candidateJudge = async (input, options) => {
    calls.push({ input: copy(input), options });
    if (input.candidates[0].value === 'MIT' && mode === 'thrown') throw Object.assign(new Error('fixture unavailable'), { code: 'JUDGE_UNAVAILABLE' });
    if (input.candidates[0].value === 'MIT' && mode === 'returned') return { answers: {} };
    const support = input.candidates[0].value === 'MIT' && mode === 'rejected' ? 0.01 : input.candidates[0].value === 'MIT' && mode === 'uncertain' ? 0.5 : 0.97;
    return { model: 'fixture', answers: { q0s: { type: 'noul', noul: support }, q0c: { type: 'noul', noul: 0.01 } },
      usage: { inputTokens: 1, outputTokens: 1 }, requestSha256: 'b'.repeat(64), elapsedMs: 1 };
  };
  let last = await start(f, { contract: { schemaVersion: 1, question: 'License?', requirements: { license: { question: 'License?', schema: { type: 'string' } } } },
    representations: [{ format: 'text', content }], judgeIdentity: 'fixture', policyRevision: '1' });
  const rep = last.handoff.evidence[0];
  const proposal = value => { const quote = 'License ' + value, at = content.indexOf(quote); return { fieldId: 'license', mode: 'string', value,
    definitionRevision: last.handoff.definitions.license, representationId: rep.representationId, digest: rep.digest, quote, charRange: [at, at + quote.length] }; };
  const round = async (value, extra = {}) => last = await f.api.continueCallerRound({ storeRoot: last.storeRoot, investigationRef: last.investigationRef,
    expectedRevision: last.handoff.revision, deps: f.deps, judgeIdentity: 'fixture', policyRevision: '1', proposals: [proposal(value)], ...extra });
  return { f, calls, round, proposal, initial: last };
}

test('P3 rejected A survives B and exact A recovery without another candidate attempt', async () => {
  const w = await dispositionFixture('rejected'), a = await w.round('MIT');
  assert.equal(a.result.requirements.license.status, 'unresolved'); assert(w.calls.length > 0);
  const reason = a.result.requirements.license.reason, audit = copy(a.result.requirements.license.attemptedRecords);
  const b = await w.round('Apache'); assert.equal(b.result.data.license, 'Apache');
  const before = w.calls.length, restored = await w.round('MIT');
  assert.equal(w.calls.length - before, 0, 'negative A is an exact recorded disposition, not another paid opportunity');
  assert.equal(restored.result.usage.candidateJudgeCalls, 0);
  assert.equal(restored.result.requirements.license.status, 'unresolved');
  assert.equal(restored.result.requirements.license.reason, reason);
  assert.deepEqual(restored.result.requirements.license.attemptedRecords.slice(0, audit.length), audit);
});


test('P4 exact positive uncertain returned and thrown dispositions retain full attempt basis', async () => {
  for (const mode of ['accepted', 'uncertain', 'returned', 'thrown']) {
    const w = await dispositionFixture(mode), a = await w.round('MIT');
    assert(w.calls.length > 0, mode + ' must actually attempt A');
    const first = await currentState(w.f, a.investigationRef), row = first.state.checkpoint.history.at(-1);
    assert(Array.isArray(row.state.callerAttempts) && row.state.callerAttempts.length > 0, 'an actual semantic attempt retains its typed basis');
    const attempt = row.state.callerAttempts.at(-1), source = a.result.evidence[0];
    assert.equal(attempt.basis.kind, 'candidate'); assert.equal(attempt.basis.namespace, row.namespace);
    assert.deepEqual(attempt.basis.context, a.result.evidence.map(e => ({ evidenceId: e.evidenceId, url: e.url, digest: digest(e.content) })));
    assert.deepEqual(attempt.basis.dependencies, {});
    assert.deepEqual(attempt.basis.candidate, { fieldId: 'license', evidenceId: source.evidenceId, url: source.url,
      digest: digest(source.content), value: 'MIT', quote: w.proposal('MIT').quote, charRange: w.proposal('MIT').charRange });
    assert.equal(typeof attempt.auditDigest, 'string'); assert.equal(attempt.auditDigest.length, 64);
    assert(row.state.attemptedRecords[attempt.auditIndex]);
    const original = copy(attempt), beforeB = w.calls.length, b = await w.round('Apache');
    assert(w.calls.length > beforeB); assert.equal(b.result.data.license, 'Apache');
    const bState = await currentState(w.f, b.investigationRef);
    assert.deepEqual(bState.state.checkpoint.history.slice(0, first.state.checkpoint.history.length), first.state.checkpoint.history);
    const before = w.calls.length, restored = await w.round('MIT', { roundLimits: { maxJudgeAttempts: 1 } });
    assert.equal(w.calls.length, before, mode + ' returning A must not reattempt under the minimum valid semantic limit');
    assert.equal(restored.result.usage.candidateJudgeCalls, 0);
    assert.deepEqual(restored.result.data, a.result.data);
    assert.equal(restored.result.requirements.license.reason, a.result.requirements.license.reason);
    if (mode === 'accepted') assert.deepEqual(restored.result.requirements.license.judgment, a.result.requirements.license.judgment);
    const final = await currentState(w.f, restored.investigationRef);
    assert.deepEqual(final.state.checkpoint.history.slice(0, bState.state.checkpoint.history.length), bState.state.checkpoint.history);
    assert.deepEqual(final.state.checkpoint.history.at(-1).state.callerAttempts.find(a => a.basis.candidate?.value === 'MIT'), original);
  }
});


test('P5 reverse-declared enum child tracks actual prerequisite basis and preserves independent reuse', async () => {
  const f = await fixture(), content = 'Release 1.0: License MIT; License Apache.', enumCalls = [], candidateCalls = [];
  f.deps.judge = async input => {
    enumCalls.push(copy(input));
    const supports = input.fieldId !== 'child' || input.depBindings.parent.value === 'MIT';
    return { documents: input.documents.map(d => ({ evidenceId: d.evidenceId, relevant: true, supportsClaim: supports, refutesClaim: !supports })) };
  };
  f.deps.candidateJudge = async input => {
    candidateCalls.push(copy(input));
    return { model: 'fixture', answers: { q0s: { type: 'noul', noul: 0.97 }, q0c: { type: 'noul', noul: 0.01 } },
      usage: { inputTokens: 1, outputTokens: 1 }, requestSha256: 'c'.repeat(64), elapsedMs: 1 };
  };
  const fullContract = { schemaVersion: 1, question: 'License dependency?', requirements: {
    child: { question: 'Does the selected license qualify?', schema: { enum: ['supported', 'refuted', 'disputed'] }, dependsOn: ['parent'] },
    independent: { question: 'Is the release documented?', schema: { enum: ['supported', 'refuted', 'disputed'] } },
    parent: { question: 'License?', schema: { type: 'string' } } } };
  let last = await start(f, { contract: fullContract, representations: [{ format: 'text', content }], judgeIdentity: 'fixture', policyRevision: '1' });
  const rep = last.handoff.evidence[0];
  const round = async (value, narrow = false, extra = {}) => {
    const quote = narrow ? value : 'License ' + value, offset = content.indexOf(quote);
    return last = await f.api.continueCallerRound({ storeRoot: last.storeRoot, investigationRef: last.investigationRef, expectedRevision: last.handoff.revision,
      deps: f.deps, judgeIdentity: 'fixture', policyRevision: '1', ...(narrow ? { roundLimits: { maxJudgeAttempts: 1 } } : { contract: fullContract }), proposals: [{ fieldId: 'parent', mode: 'string', value,
        definitionRevision: last.handoff.definitions.parent, representationId: rep.representationId, digest: rep.digest, quote, charRange: [offset, offset + quote.length] }], ...extra });
  };
  const capped = await round('MIT', false, { roundLimits: { maxJudgeAttempts: 1 } });
  assert.equal(capped.result.data.parent, 'MIT'); assert.equal(capped.result.requirements.child.status, 'unresolved');
  assert.equal(capped.result.usage.candidateJudgeCalls, 1); assert.equal(capped.result.usage.judgeCalls, 0, 'new child basis stops finitely when the only slot is spent');
  const a = await round('MIT'); assert.equal(a.result.data.child, 'supported');
  const independentBefore = enumCalls.filter(c => c.fieldId === 'independent').length;
  const childBefore = enumCalls.filter(c => c.fieldId === 'child').length, parentBefore = candidateCalls.length;
  const quoteOnly = await round('MIT', true);
  assert.equal(candidateCalls.length - parentBefore, 1, 'new parent quote has its own candidate identity');
  assert.equal(enumCalls.filter(c => c.fieldId === 'child').length, childBefore, 'same proven value/event/digest preserves child disposition');
  assert.equal(quoteOnly.result.data.child, 'supported');
  assert.equal(quoteOnly.result.usage.candidateJudgeCalls, 1);
  assert.equal(quoteOnly.result.usage.judgeCalls, 0, 'cached enum recovery remains eligible after the sole semantic slot is spent');
  const changed = await round('Apache');
  assert.equal(changed.result.data.parent, 'Apache');
  assert.equal(changed.result.data.child, 'refuted', 'child cannot publish its MIT-conditioned enum result under Apache');
  assert.equal(enumCalls.filter(c => c.fieldId === 'child').length - childBefore, 1);
  const beforeReturn = enumCalls.length + candidateCalls.length, restored = await round('MIT');
  assert.equal(restored.result.data.child, 'supported'); assert.equal(restored.result.data.parent, 'MIT');
  assert.equal(enumCalls.length + candidateCalls.length, beforeReturn, 'exact parent/child basis recovers without semantic redispatch');
  assert.equal(enumCalls.filter(c => c.fieldId === 'independent').length, independentBefore);
  const state = await currentState(f, last.investigationRef);
  const child = state.state.checkpoint.history.filter(h => JSON.parse(h.namespace)[2].id === 'child').at(-1);
  assert(child.state.callerAttempts.some(a => a.basis.kind === 'enum' && a.basis.dependencies.parent.value === 'MIT'));
  assert(child.state.callerAttempts.some(a => a.basis.kind === 'enum' && a.basis.dependencies.parent.value === 'Apache'));
});


test('P6 recognized history metadata refuses before begin and legacy absence permits only proven semantic closure', async () => {
  for (const corrupt of [
    state => { state.historyContinuity = { schemaVersion: 1, fromRevision: 2 }; },
    state => { state.checkpoint.history.at(-1).state.callerAttempts[0].auditIndex = 999; },
    state => { state.checkpoint.history.at(-1).state.callerStability = [{ dependencies: {}, sides: [{ evidenceId: 'e1', digest: 'bad', flags: [true] }], inconsistent: 0 }]; },
  ]) {
    const w = await dispositionFixture(), a = await w.round('MIT');
    await rewriteCurrent(w.f, a.investigationRef, async ({ state }) => { corrupt(state); });
    const before = w.f.calls.begin.length, paid = w.calls.length;
    await assert.rejects(w.round('MIT'), CorruptRecordError);
    assert.equal(w.f.calls.begin.length, before); assert.equal(w.calls.length, paid);
  }
  const w = await dispositionFixture(), a = await w.round('MIT');
  await rewriteCurrent(w.f, a.investigationRef, async ({ state }) => { delete state.historyContinuity; });
  const before = w.calls.length, hit = await w.round('MIT');
  assert.equal(hit.result.data.license, 'MIT'); assert.equal(w.calls.length, before);
  const begins = w.f.calls.begin.length;
  await assert.rejects(w.round('Apache'), e => e.code === 'VALIDATION_ERROR' && /legacy history continuity unavailable/.test(e.message));
  assert.equal(w.f.calls.begin.length, begins); assert.equal(w.calls.length, before);
  w.f.deps.judge = null;
  const unassessed = await w.round('Apache');
  assert.equal(unassessed.result.assessment, 'deterministic-only'); assert.equal(w.calls.length, before);
  w.f.deps.judge = async () => { assert.fail('value-only fixture'); };
  const beforeUnknown = await currentState(w.f, unassessed.investigationRef);
  const unknown = await w.round('Apache', { judgeIdentity: undefined, policyRevision: undefined });
  assert.equal(w.calls.length - before, 1, 'unknown identity permits fresh work without claiming history restoration');
  assert.equal(unknown.result.usage.candidateJudgeCalls, 1);
  assert.equal(unknown.result.data.license, 'Apache');
  const firstUnknown = await currentState(w.f, unknown.investigationRef);
  assert.deepEqual(firstUnknown.state.checkpoint.history.slice(0, beforeUnknown.state.checkpoint.history.length), beforeUnknown.state.checkpoint.history);
  const unknownRows = firstUnknown.state.checkpoint.history.filter(h => JSON.parse(h.namespace)[4] === null);
  assert.equal(unknownRows.length, 1, 'unknown semantic attempt must append its full typed basis without authorizing restoration');
  const attempt = unknownRows[0].state.callerAttempts.at(-1), audit = unknownRows[0].state.attemptedRecords[attempt.auditIndex];
  assert.equal(JSON.parse(attempt.basis.namespace)[4], null);
  assert.deepEqual(attempt.basis.dependencies, {});
  assert.equal(attempt.basis.candidate.value, 'Apache');
  assert.deepEqual(attempt.basis.context, unknown.result.evidence.map(e => ({ evidenceId: e.evidenceId, url: e.url, digest: digest(e.content) })));
  const sortedJSON = value => JSON.stringify(value, (_key, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : v);
  assert.equal(attempt.auditDigest, digest(sortedJSON({ trusted: audit.trusted, reason: audit.reason, assessments: audit.assessments })));
  assert.deepEqual(attempt.disposition, { status: 'satisfied', value: 'Apache' });
  const saved = copy((await w.f.api.readCallerRecord(unknown.storeRoot, unknown.investigationRef, unknown.handoff.revision)).payload);
  const secondBefore = w.calls.length;
  const secondUnknown = await w.round('Apache', { judgeIdentity: undefined, policyRevision: undefined });
  assert.equal(w.calls.length - secondBefore, 1, 'consecutive unknown identities each dispatch fresh despite retained positive history');
  assert.equal(secondUnknown.result.usage.candidateJudgeCalls, 1);
  const finalUnknown = await currentState(w.f, secondUnknown.investigationRef);
  assert.deepEqual(finalUnknown.state.checkpoint.history.slice(0, firstUnknown.state.checkpoint.history.length), firstUnknown.state.checkpoint.history);
  assert.equal(finalUnknown.state.checkpoint.history.filter(h => JSON.parse(h.namespace)[4] === null).length, 2);
  assert.deepEqual((await w.f.api.readCallerRecord(unknown.storeRoot, unknown.investigationRef, unknown.handoff.revision)).payload, saved);
});


test('P7 same prerequisite stability survives candidate and opposition changes without trusting rejected flips', async () => {
  const f = await fixture(), content = 'Release 1.0: License MIT.', childCalls = [];
  f.deps.judge = async input => {
    childCalls.push(copy(input));
    return { documents: input.documents.map((d, i) => ({ evidenceId: d.evidenceId, relevant: true,
      supportsClaim: i === 0 && input.documents.length > 1 ? input.documents.length === 2 ? null : false : true, refutesClaim: false })) };
  };
  f.deps.candidateJudge = async () => ({ model: 'fixture', answers: { q0s: { type: 'noul', noul: 0.97 }, q0c: { type: 'noul', noul: 0.01 } },
    usage: { inputTokens: 1, outputTokens: 1 }, requestSha256: 'd'.repeat(64), elapsedMs: 1 });
  let last = await start(f, { contract: { schemaVersion: 1, question: 'Stability?', requirements: {
    parent: { question: 'License?', schema: { type: 'string' } }, child: { question: 'Qualifies?', schema: { enum: ['supported', 'refuted', 'disputed'] }, dependsOn: ['parent'] } } },
    representations: [{ format: 'text', content }], judgeIdentity: 'fixture', policyRevision: '1' });
  const rep = last.handoff.evidence[0], originalId = last.result.evidence[0].evidenceId;
  const round = async (narrow, extra = {}) => {
    const quote = narrow ? 'MIT' : 'License MIT', at = content.indexOf(quote);
    return last = await f.api.continueCallerRound({ storeRoot: last.storeRoot, investigationRef: last.investigationRef, expectedRevision: last.handoff.revision,
      deps: f.deps, judgeIdentity: 'fixture', policyRevision: '1', proposals: [{ fieldId: 'parent', mode: 'string', value: 'MIT', definitionRevision: last.handoff.definitions.parent,
        representationId: rep.representationId, digest: rep.digest, quote, charRange: [at, at + quote.length] }], ...extra });
  };
  const a = await round(false); assert.equal(a.result.data.child, 'supported');
  const changed = await round(true, { representations: [{ format: 'text', content: 'Second source.' }] });
  assert.equal(changed.result.requirements.child.status, 'unresolved');
  assert(changed.result.requirements.child.attemptedRecords.some(a => !a.trusted && a.reason === 'inconsistent_history_flip'));
  const before = childCalls.length, same = await round(false);
  assert.equal(childCalls.length, before, 'candidate change cannot reset the same-basis enum rejection');
  assert.equal(same.result.requirements.child.status, 'unresolved');
  const later = await round(true, { representations: [{ format: 'text', content: 'Third source.' }] });
  assert.equal(later.result.requirements.child.status, 'unresolved');
  const state = await currentState(f, last.investigationRef), child = state.state.checkpoint.history.filter(h => JSON.parse(h.namespace)[2].id === 'child').at(-1).state;
  assert.equal(child.callerStability.length, 1, 'candidate/opposition do not partition the actual prerequisite stability domain');
  assert.deepEqual(child.callerStability[0].sides.find(s => s.evidenceId === originalId).flags, [true, true, false], 'rejected flips never replace trusted baseline');
});

test('P8 value dependent stays pending for rejected parent and reuses proof only on real accepted basis', async () => {
  const f = await fixture(), content = 'License MIT; License Apache; Label OK.', calls = [];
  f.deps.judge = async () => { assert.fail('value fields only'); };
  f.deps.candidateJudge = async input => {
    calls.push(copy(input)); const support = input.candidates[0].fieldId === 'parent' && input.candidates[0].value === 'MIT' ? 0.01 : 0.97;
    return { model: 'fixture', answers: { q0s: { type: 'noul', noul: support }, q0c: { type: 'noul', noul: 0.01 } },
      usage: { inputTokens: 1, outputTokens: 1 }, requestSha256: 'e'.repeat(64), elapsedMs: 1 };
  };
  let last = await start(f, { contract: { schemaVersion: 1, question: 'Dependency?', requirements: {
    child: { question: 'Label?', schema: { type: 'string' }, dependsOn: ['parent'] }, parent: { question: 'License?', schema: { type: 'string' } } } },
    representations: [{ format: 'text', content }], judgeIdentity: 'fixture', policyRevision: '1' });
  const rep = last.handoff.evidence[0];
  const round = async value => {
    const proposals = [['parent', value, 'License ' + value], ['child', 'OK', 'Label OK']].map(([fieldId, value, quote]) => { const at = content.indexOf(quote); return {
      fieldId, mode: 'string', value, definitionRevision: last.handoff.definitions[fieldId], representationId: rep.representationId, digest: rep.digest, quote, charRange: [at, at + quote.length] }; });
    return last = await f.api.continueCallerRound({ storeRoot: last.storeRoot, investigationRef: last.investigationRef, expectedRevision: last.handoff.revision,
      deps: f.deps, judgeIdentity: 'fixture', policyRevision: '1', proposals });
  };
  const a = await round('MIT'); assert.equal(a.result.requirements.child.status, 'unresolved');
  assert.equal(calls.filter(c => c.candidates[0].fieldId === 'child').length, 0);
  const b = await round('Apache'); assert.equal(b.result.data.child, 'OK');
  const assessed = calls.find(c => c.candidates[0].fieldId === 'child'); assert.equal(assessed.depBindings.parent.value, 'Apache');
  const before = calls.length, restored = await round('MIT');
  assert.equal(calls.length, before); assert.equal(restored.result.requirements.parent.status, 'unresolved');
  assert.equal(restored.result.requirements.child.status, 'unresolved'); assert.equal(Object.hasOwn(restored.result.data, 'child'), false);
});

test('P9 returned and thrown enum failures have full basis and recover without another attempt', async () => {
  for (const mode of ['returned', 'thrown']) {
    const f = await fixture(); let calls = 0;
    f.deps.judge = async () => { calls++; if (mode === 'thrown') throw Object.assign(new Error('enum unavailable'), { code: 'JUDGE_UNAVAILABLE' }); return { documents: [] }; };
    const first = await start(f, { contract: { schemaVersion: 1, question: 'Supported?', requirements: { flag: { question: 'Supported?', schema: { enum: ['supported', 'refuted', 'disputed'] } } } },
      representations: [{ format: 'text', content: 'A source.' }], judgeIdentity: 'fixture', policyRevision: '1' });
    assert.equal(calls, 1); const before = calls;
    const state = await currentState(f, first.investigationRef), row = state.state.checkpoint.history.at(-1), attempt = row.state.callerAttempts.at(-1);
    assert.equal(attempt.basis.kind, 'enum'); assert.deepEqual(attempt.basis.dependencies, {}); assert.equal(attempt.basis.candidate, null);
    assert.deepEqual(attempt.basis.context, first.result.evidence.map(e => ({ evidenceId: e.evidenceId, url: e.url, digest: digest(e.content) })));
    assert.equal(typeof attempt.auditDigest, 'string');
    const next = await f.api.continueCallerRound({ storeRoot: first.storeRoot, investigationRef: first.investigationRef, expectedRevision: first.handoff.revision,
      deps: f.deps, judgeIdentity: 'fixture', policyRevision: '1' });
    assert.equal(calls, before); assert.equal(next.result.usage.judgeCalls, 0); assert.equal(next.result.requirements.flag.reason, first.result.requirements.flag.reason);
  }
});


test('P10 two-parent identity reconstruction follows declared dependency order through canonical persistence', async () => {
  const f = await fixture(), content = 'Zed Z; Alpha A; Child C.', calls = [];
  f.deps.judge = async () => { assert.fail('value fields only'); };
  f.deps.candidateJudge = async input => {
    calls.push(copy(input)); return { model: 'fixture', answers: { q0s: { type: 'noul', noul: 0.97 }, q0c: { type: 'noul', noul: 0.01 } },
      usage: { inputTokens: 1, outputTokens: 1 }, requestSha256: 'f'.repeat(64), elapsedMs: 1 };
  };
  let last = await start(f, { contract: { schemaVersion: 1, question: 'Two parents?', requirements: {
    child: { question: 'Child?', schema: { type: 'string' }, dependsOn: ['z', 'a'] },
    a: { question: 'Alpha?', schema: { type: 'string' } }, z: { question: 'Zed?', schema: { type: 'string' } } } },
    representations: [{ format: 'text', content }], judgeIdentity: 'fixture', policyRevision: '1' });
  const rep = last.handoff.evidence[0];
  const proposals = [['z', 'Z', 'Zed Z'], ['a', 'A', 'Alpha A'], ['child', 'C', 'Child C']].map(([fieldId, value, quote]) => {
    const at = content.indexOf(quote); return { fieldId, mode: 'string', value, quote, charRange: [at, at + quote.length],
      definitionRevision: last.handoff.definitions[fieldId], representationId: rep.representationId, digest: rep.digest };
  });
  const round = async () => last = await f.api.continueCallerRound({ storeRoot: last.storeRoot, investigationRef: last.investigationRef,
    expectedRevision: last.handoff.revision, deps: f.deps, judgeIdentity: 'fixture', policyRevision: '1', proposals });
  const first = await round(); assert.equal(first.result.data.child, 'C');
  assert.deepEqual(Object.keys(calls.find(c => c.candidates[0].fieldId === 'child').depBindings), ['z', 'a']);
  const saved = await currentState(f, last.investigationRef), child = saved.state.checkpoint.history.filter(h => JSON.parse(h.namespace)[2].id === 'child').at(-1);
  assert.deepEqual(Object.keys(child.state.callerAttempts[0].basis.dependencies), ['a', 'z'], 'persisted codec sorts the dependency object');
  const before = calls.length; let second;
  await assert.doesNotReject(async () => { second = await round(); }, 'producer identity is reconstructed without weakening candidate checks');
  assert.equal(calls.length, before); assert.equal(second.result.usage.candidateJudgeCalls, 0);
  assert.deepEqual(second.result.requirements.child.judgment, first.result.requirements.child.judgment);
  await rewriteCurrent(f, last.investigationRef, async ({ state }) => {
    delete state.historyContinuity;
    for (const row of state.checkpoint.history) if (JSON.parse(row.namespace)[2].id === 'child') { delete row.state.callerAttempts; row.state.trustedAccepts = []; }
  });
  const begins = f.calls.begin.length;
  await assert.rejects(round(), e => e.code === 'VALIDATION_ERROR' && /legacy history continuity unavailable/.test(e.message));
  assert.equal(f.calls.begin.length, begins); assert.equal(calls.length, before, 'ambiguous affected descendant is refused before parent or child dispatch');
});


test('Q1 exact negative disposition survives two failed new-lead reads without semantic replay', async () => {
  for (const mode of ['rejected', 'thrown']) {
    const w = await dispositionFixture(mode), a = await w.round('MIT'), reads = [];
    const beforeState = await currentState(w.f, a.investigationRef), beforeField = beforeState.state.checkpoint.history.at(-1).state;
    const paid = w.calls.length, lead = 'https://fixture.invalid/new-failed-lead';
    w.f.deps.read = async url => { reads.push(url); throw new Error('ordinary failed new lead'); };
    const next = await w.round('MIT', { leads: [{ url: lead }], roundLimits: { maxJudgeAttempts: 1 } });
    assert.deepEqual(reads, [lead, lead], 'the exact two failed reads are a reachability precondition');
    assert.equal(next.result.usage.readAttempts, 2); assert.equal(next.result.usage.readsRetained, 0);
    assert.deepEqual(next.result.evidence, a.result.evidence);
    assert.equal(w.calls.length, paid, 'an unrelated failed acquisition is not a new semantic basis');
    assert.equal(next.result.usage.candidateJudgeCalls, 0);
    assert.equal(next.result.requirements.license.reason, a.result.requirements.license.reason);
    const after = await currentState(w.f, next.investigationRef), field = after.state.checkpoint.history.at(-1).state;
    assert.deepEqual(field.callerAttempts, beforeField.callerAttempts);
    assert.deepEqual(field.attemptedRecords, beforeField.attemptedRecords);
    assert.deepEqual(after.state.checkpoint.history.slice(0, beforeState.state.checkpoint.history.length), beforeState.state.checkpoint.history);
  }
});

test('Q2 exact positive candidate and enum caches preserve actual unsettled coverage after failed acquisition', async () => {
  for (const kind of ['candidate', 'enum']) {
    const reads = [], lead = 'https://fixture.invalid/new-failed-lead';
    let f, first, semanticCalls, continueRound, fieldId;
    if (kind === 'candidate') {
      const w = await dispositionFixture('accepted'); f = w.f; first = await w.round('MIT'); fieldId = 'license';
      semanticCalls = () => w.calls.length; continueRound = () => w.round('MIT', { leads: [{ url: lead }], roundLimits: { maxJudgeAttempts: 1 } });
    } else {
      f = await fixture(); const calls = [];
      f.deps.judge = async input => { calls.push(copy(input)); return { documents: input.documents.map(d => ({ evidenceId: d.evidenceId, relevant: true, supportsClaim: true, refutesClaim: false })) }; };
      first = await start(f, { contract: { schemaVersion: 1, question: 'Flag?', requirements: { flag: { question: 'Flag?', schema: { enum: ['supported', 'refuted', 'disputed'] } } } },
        representations: [{ format: 'text', content: 'A retained source.' }], judgeIdentity: 'fixture', policyRevision: '1' });
      fieldId = 'flag'; semanticCalls = () => calls.length;
      continueRound = () => f.api.continueCallerRound({ storeRoot: first.storeRoot, investigationRef: first.investigationRef, expectedRevision: first.handoff.revision,
        deps: f.deps, judgeIdentity: 'fixture', policyRevision: '1', leads: [{ url: lead }], roundLimits: { maxJudgeAttempts: 1 } });
    }
    assert.equal(first.result.requirements[fieldId].status, 'satisfied', 'passing prior proof/derivation is required');
    const original = await currentState(f, first.investigationRef), oldField = original.state.checkpoint.history.at(-1).state, paid = semanticCalls();
    f.deps.read = async url => { reads.push(url); throw new Error('ordinary failed new lead'); };
    const next = await continueRound();
    assert.deepEqual(reads, [lead, lead]); assert.equal(next.result.usage.readsRetained, 0);
    assert.equal(semanticCalls(), paid); assert.equal(next.result.usage.judgeCalls + next.result.usage.candidateJudgeCalls, 0);
    const retained = await currentState(f, next.investigationRef), field = retained.state.checkpoint.history.at(-1).state;
    assert(field.ctrvSources.includes(lead), 'this fixture must have actual unsettled required coverage');
    assert.notEqual(next.result.requirements[fieldId].status, 'satisfied', 'cache reuse cannot clear actual unsettled coverage');
    assert.equal(Object.hasOwn(next.result.data, fieldId), false);
    assert.deepEqual(field.callerAttempts, oldField.callerAttempts); assert.deepEqual(field.attemptedRecords, oldField.attemptedRecords);
    assert.deepEqual(retained.state.checkpoint.history.slice(0, original.state.checkpoint.history.length), original.state.checkpoint.history);
  }
});

test('Q3 a newly retained lead changes complete context and legitimately reopens assessment', async () => {
  const w = await dispositionFixture('rejected'), first = await w.round('MIT'), lead = 'https://fixture.invalid/new-retained-lead', reads = [];
  const old = await currentState(w.f, first.investigationRef), paid = w.calls.length;
  w.f.deps.read = async url => { reads.push(url); return 'New applicable source context.'; };
  const next = await w.round('MIT', { leads: [{ url: lead }], roundLimits: { maxJudgeAttempts: 1 } });
  assert(reads.includes(lead)); assert.equal(next.result.usage.readsRetained, 1);
  assert.equal(next.result.evidence.length, first.result.evidence.length + 1);
  assert(w.calls.length > paid); assert.equal(next.result.usage.candidateJudgeCalls, w.calls.length - paid);
  assert(w.calls.at(-1).input.opposingContext.some(e => e.url === lead));
  const current = await currentState(w.f, next.investigationRef), attempts = current.state.checkpoint.history.at(-1).state.callerAttempts;
  assert(attempts.length > old.state.checkpoint.history.at(-1).state.callerAttempts.length);
  assert.equal(attempts.at(-1).basis.context.length, first.result.evidence.length + 1);
  assert.deepEqual(current.state.checkpoint.history.slice(0, old.state.checkpoint.history.length), old.state.checkpoint.history);
});

test('L1 legacy exact disposition refuses prospective events before writes; continuous admission owns the same events', async () => {
  const w = await dispositionFixture('accepted', true), a = await w.round('MIT');
  assert.equal(a.result.data.license, 'MIT'); assert.equal(w.calls.length, 1);
  await rewriteCurrent(w.f, a.investigationRef, async ({ state }) => { delete state.historyContinuity; });
  const before = await currentState(w.f, a.investigationRef), calls = w.f.calls;
  const counts = [calls.begin.length, calls.bodyWrites, calls.commits, calls.queries.length, w.calls.length];
  let reads = 0; w.f.deps.read = async () => { reads++; throw new Error('Must refuse before acquisition'); };
  await assert.rejects(w.round('MIT', { representations: [{ format: 'text', content: 'Additional independent source.', claimedSource: 'new claim' }] }),
    e => e.code === 'VALIDATION_ERROR' && /legacy history continuity unavailable/.test(e.message));
  assert.equal(calls.preparations.at(-1).evidence.length, 2, 'preflight must see the new event');
  assert.deepEqual([calls.begin.length, calls.bodyWrites, calls.commits, calls.queries.length, w.calls.length], counts);
  assert.equal(reads, 0); assert.deepEqual(await currentState(w.f, a.investigationRef), before);

  const c = await dispositionFixture('accepted', true), first = await c.round('MIT');
  const content = 'Additional independent source.', claims = ['source one', ''];
  const next = await c.round('MIT', { representations: claims.map((claimedSource, i) => ({ format: i ? 'markdown' : 'text', content, claimedSource })) });
  const prepared = c.f.calls.preparations.at(-1).evidence, seed = c.f.calls.seeds.at(-1);
  assert.equal(prepared, seed.evidence, 'the exact prepared array is seeded');
  assert.deepEqual(prepared.map(e => e.evidenceId), ['e1', 'e2', 'e3']);
  assert.notEqual(prepared[1].url, prepared[2].url);
  const saved = await currentState(c.f, next.investigationRef);
  for (const [i, e] of prepared.entries()) {
    const retained = next.result.evidence.find(r => r.evidenceId === e.evidenceId);
    assert.deepEqual({ ...retained, suppliedProvenance: undefined }, { ...e, suppliedProvenance: undefined });
    assert.equal(saved.state.evidence[i].record.url, e.url);
  }
  assert.deepEqual(next.result.evidence.slice(1).map(e => e.suppliedProvenance), claims.map(claimedSource => ({ claimedSource, verification: 'unverified' })));
  assert.deepEqual(saved.state.evidence.slice(1).map(e => e.body.claimedSource), claims);
  assert.equal(saved.state.evidence[1].body.bodyId, saved.state.evidence[2].body.bodyId);
  assert.equal(saved.state.evidence[0].body.bodyId, first.handoff.evidence[0].representationId);
  assert.deepEqual(seed.leads, []);
});

test('L2 legacy admission considers effective new and carried leads and unissued frozen queries', async () => {
  for (const kind of ['new-lead', 'carried-lead', 'unissued-query', 'coverage-reset']) {
    const w = await dispositionFixture('accepted', true), a = await w.round('MIT'), lead = 'https://fixture.invalid/legacy-pending';
    await rewriteCurrent(w.f, a.investigationRef, async ({ state }) => {
      delete state.historyContinuity;
      if (kind === 'carried-lead' || kind === 'coverage-reset') state.checkpoint.leads.push({ url: lead, title: lead, origins: [] });
      if (kind === 'unissued-query') state.checkpoint.issuedQueries = [];
      if (kind === 'coverage-reset') state.coverageBasis = 'different coverage basis';
    });
    const before = await currentState(w.f, a.investigationRef), calls = w.f.calls;
    // The old context is a complete hit: only prospective acquisition makes it unsafe.
    const candidates = calls.preparations.at(-1).candidates;
    const identity = JSON.parse(before.state.checkpoint.history.at(-1).namespace)[4];
    assert.equal(engine.prepareLeanCallerHistory(a.contract, a.result.evidence, before.state.checkpoint.history, candidates, false, identity, true).unavailable, false);
    const counts = [calls.begin.length, calls.bodyWrites, calls.commits, calls.queries.length, w.calls.length];
    let reads = 0; w.f.deps.read = async () => { reads++; throw new Error('Must refuse before acquisition'); };
    await assert.rejects(w.round('MIT', kind === 'new-lead' ? { leads: [{ url: lead }] } : {}),
      e => e.code === 'VALIDATION_ERROR' && /legacy history continuity unavailable/.test(e.message), kind);
    assert.deepEqual([calls.begin.length, calls.bodyWrites, calls.commits, calls.queries.length, w.calls.length], counts, kind);
    assert.equal(reads, 0); assert.deepEqual(await currentState(w.f, a.investigationRef), before);
  }
  const w = await dispositionFixture(), a = await w.round('MIT');
  await rewriteCurrent(w.f, a.investigationRef, async ({ state }) => { delete state.historyContinuity; });
  const before = w.calls.length, hit = await w.round('MIT');
  assert.equal(hit.result.data.license, 'MIT'); assert.equal(w.calls.length, before, 'complete independent legacy hit still reuses');
});

test('L3 shared frozen plan preserves ordinary ordering and legacy bypasses never admit new proposal references', async () => {
  const c = { schemaVersion: 1, question: 'Shared?', requirements: {
    alpha: { question: 'Alpha?', schema: { enum: ['supported', 'refuted', 'disputed'] } },
    beta: { question: 'Beta?', schema: { enum: ['supported', 'refuted', 'disputed'] } },
  }, limits: { maxSearchAttempts: 5 } };
  const expected = [
    { query: 'Shared?', fieldId: null, kind: 'shared' },
    { query: 'Alpha?', fieldId: 'alpha', kind: 'primary' }, { query: 'Beta?', fieldId: 'beta', kind: 'primary' },
    { query: 'Alpha? contrary evidence refuted', fieldId: 'alpha', kind: 'counterevidence' },
    { query: 'Beta? contrary evidence refuted', fieldId: 'beta', kind: 'counterevidence' },
  ];
  assert.deepEqual(engine.frozenLeanQueryPlan(engine.compileLeanContract(c)), expected);
  const f = await fixture(), ordinary = await engine.runLeanInvestigation(c, f.deps);
  assert.deepEqual(ordinary.plan.queries, expected); assert.deepEqual(f.calls.queries, expected.map(p => p.query));
  f.calls.queries.length = 0;
  const caller = await start(f, { contract: c });
  assert.deepEqual(caller.result.plan.queries, expected); assert.deepEqual(f.calls.queries, expected.map(p => p.query));

  for (const mode of ['no-judge', 'unknown']) {
    const w = await dispositionFixture(), a = await w.round('MIT');
    await rewriteCurrent(w.f, a.investigationRef, async ({ state }) => { delete state.historyContinuity; });
    if (mode === 'no-judge') w.f.deps.judge = null;
    const next = await w.round('MIT', { representations: [{ format: 'text', content: 'New source in permitted mode.', claimedSource: mode }],
      ...(mode === 'unknown' ? { judgeIdentity: undefined, policyRevision: undefined } : {}) });
    assert.equal(next.result.evidence.length, 2);
    assert.deepEqual(next.result.evidence[1].suppliedProvenance, { claimedSource: mode, verification: 'unverified' });
    assert.equal(next.result.assessment, mode === 'no-judge' ? 'deterministic-only' : 'semantic');
  }
  const w = await dispositionFixture(), a = await w.round('MIT'), content = 'MIT fresh representation';
  const counts = [w.f.calls.begin.length, w.f.calls.bodyWrites, w.f.calls.commits, w.calls.length];
  await assert.rejects(w.round('MIT', { representations: [{ format: 'text', content }], proposals: [{ ...w.proposal('MIT'),
    representationId: 'b:' + digest(content), digest: 'sha256:' + digest(content), quote: 'MIT', charRange: [0, 3] }] }),
    e => e.code === 'VALIDATION_ERROR' && /Immutable proposal representation binding mismatch/.test(e.message));
  assert.deepEqual([w.f.calls.begin.length, w.f.calls.bodyWrites, w.f.calls.commits, w.calls.length], counts);
  assert.equal((await currentState(w.f, a.investigationRef)).state.evidence.length, 1);
});

async function repeatedDependencyFixture() {
  const f = await fixture(), content = 'Parent A; Child C.', candidates = [], enums = [], declared = ['parent', 'parent'];
  f.deps.judge = async input => {
    enums.push(copy(input));
    return { documents: input.documents.map(d => ({ evidenceId: d.evidenceId, relevant: true, supportsClaim: true, refutesClaim: false })) };
  };
  f.deps.candidateJudge = async input => {
    candidates.push(copy(input));
    return { model: 'fixture', answers: { q0s: { type: 'noul', noul: 0.97 }, q0c: { type: 'noul', noul: 0.01 } },
      usage: { inputTokens: 1, outputTokens: 1 }, requestSha256: 'd'.repeat(64), elapsedMs: 1 };
  };
  const submitted = { schemaVersion: 1, question: 'Repeated parent?', requirements: {
    child: { question: 'Child?', schema: { type: 'string' }, dependsOn: declared },
    flag: { question: 'Does this parent qualify?', schema: { enum: ['supported', 'refuted', 'disputed'] }, dependsOn: declared },
    parent: { question: 'Parent?', schema: { type: 'string' } },
  } };
  assert.deepEqual(engine.compileLeanContract(submitted).fields.find(f => f.id === 'child').dependsOn, declared);
  let last = await start(f, { contract: submitted, representations: [{ format: 'text', content }], judgeIdentity: 'fixture', policyRevision: '1' });
  const rep = last.handoff.evidence[0];
  const proposals = [['parent', 'A', 'Parent A'], ['child', 'C', 'Child C']].map(([fieldId, value, quote]) => {
    const at = content.indexOf(quote); return { fieldId, mode: 'string', value, quote, charRange: [at, at + quote.length],
      definitionRevision: last.handoff.definitions[fieldId], representationId: rep.representationId, digest: rep.digest };
  });
  const round = async () => last = await f.api.continueCallerRound({ storeRoot: last.storeRoot, investigationRef: last.investigationRef,
    expectedRevision: last.handoff.revision, deps: f.deps, judgeIdentity: 'fixture', policyRevision: '1', proposals });
  const first = await round();
  assert.deepEqual(first.result.data, { child: 'C', flag: 'supported', parent: 'A' });
  assert.equal(candidates.filter(c => c.candidates[0].fieldId === 'child').length, 1);
  assert.equal(enums.filter(c => c.fieldId === 'flag').length, 1);
  return { f, first, round, candidates, enums, declared };
}

test('D1 repeated declared prerequisites persist and recover actual value and enum attempts without semantic replay', async () => {
  const w = await repeatedDependencyFixture(), saved = await currentState(w.f, w.first.investigationRef);
  for (const id of ['child', 'flag']) {
    const row = saved.state.checkpoint.history.filter(h => JSON.parse(h.namespace)[2].id === id).at(-1);
    assert.deepEqual(JSON.parse(row.namespace)[2].dependsOn, w.declared, 'namespace retains the original duplicate declaration');
    const attempt = row.state.callerAttempts.at(-1);
    assert.deepEqual(Object.keys(attempt.basis.dependencies), ['parent'], 'actual binding object has one parent key');
    assert.equal(attempt.basis.dependencies.parent.value, 'A');
    assert.equal(attempt.disposition.status, 'satisfied');
    assert.equal(attempt.auditDigest.length, 64);
  }
  const before = w.candidates.length + w.enums.length;
  console.log(JSON.stringify({ case: 'D1-persisted-preconditions', revision: w.first.handoff.revision, candidateCalls: w.candidates.length, enumCalls: w.enums.length, declaration: w.declared, runtimeKeys: ['parent'] }));
  let next;
  await assert.doesNotReject(async () => { next = await w.round(); }, 'valid repeated dependencies must not be rejected as malformed generated history');
  assert.deepEqual(next.result.data, w.first.result.data);
  assert.equal(w.candidates.length + w.enums.length, before);
  assert.equal(next.result.usage.candidateJudgeCalls + next.result.usage.judgeCalls, 0);
  assert.deepEqual(next.result.requirements.child.judgment, w.first.result.requirements.child.judgment);
  const after = await currentState(w.f, next.investigationRef);
  assert.deepEqual(after.state.checkpoint.history.slice(0, saved.state.checkpoint.history.length), saved.state.checkpoint.history);
  assert.deepEqual(next.contract.requirements.child.dependsOn, w.declared);
});

test('D2 repeated declarations still refuse missing extra and changed actual dependency bindings before begin', async () => {
  for (const kind of ['missing', 'extra', 'changed']) {
    const w = await repeatedDependencyFixture();
    await rewriteCurrent(w.f, w.first.investigationRef, async ({ state }) => {
      const row = state.checkpoint.history.filter(h => JSON.parse(h.namespace)[2].id === 'child').at(-1);
      const basis = row.state.callerAttempts.at(-1).basis;
      assert.deepEqual(Object.keys(basis.dependencies), ['parent']);
      if (kind === 'missing') delete basis.dependencies.parent;
      else if (kind === 'extra') basis.dependencies.undeclared = copy(basis.dependencies.parent);
      else basis.dependencies.parent.value = 'Different proven parent';
    });
    const before = await currentState(w.f, w.first.investigationRef), calls = w.f.calls;
    const counts = [calls.begin.length, calls.bodyWrites, calls.commits, calls.queries.length, w.candidates.length, w.enums.length];
    let reads = 0; w.f.deps.read = async () => { reads++; throw new Error('No acquisition before malformed history refusal'); };
    await assert.rejects(w.round(), e => e instanceof CorruptRecordError && /Malformed recognized caller history or candidate descriptor/.test(e.message), kind);
    assert.deepEqual([calls.begin.length, calls.bodyWrites, calls.commits, calls.queries.length, w.candidates.length, w.enums.length], counts);
    assert.equal(reads, 0); assert.deepEqual(await currentState(w.f, w.first.investigationRef), before);
  }
});

const orderedScopeContract = () => ({ schemaVersion: 1, question: 'Version?', scope: { z: 'last', a: 'first' },
  requirements: { version: { question: 'Version?', schema: { type: 'string' } } } });
function orderWorld(f) {
  const content = 'Version 2.4. Parent A.', state = { support: true, candidates: [], enums: [], reads: [] };
  f.deps.extract = async request => ({ finishReason: 'stop', rawOutput: JSON.stringify(Object.fromEntries(request.fields.map(field => {
    const value = field.id === 'z' ? 'A' : '2.4', quote = field.id === 'z' ? 'Parent A' : 'Version 2.4', at = content.indexOf(quote);
    return [field.id, { value, quote, charRange: [at, at + quote.length] }];
  }))), usage: null, observedCost: null });
  f.deps.candidateJudge = async input => {
    state.candidates.push(copy(input));
    return { model: 'fixture', answers: { q0s: { type: 'noul', noul: state.support ? 0.97 : 0.01 }, q0c: { type: 'noul', noul: 0.01 } },
      usage: { inputTokens: 1, outputTokens: 1 }, requestSha256: 'c'.repeat(64), elapsedMs: 1 };
  };
  f.deps.judge = async input => {
    state.enums.push(copy(input));
    return { documents: input.documents.map(d => ({ evidenceId: d.evidenceId, relevant: true, supportsClaim: state.support, refutesClaim: !state.support })) };
  };
  f.deps.read = async url => { state.reads.push(url); throw new Error('No acquired document expected'); };
  return { content, state, semantic: () => state.candidates.length + state.enums.length };
}

test('S1 normalized caller scope survives stored and equivalent replacement rounds without resetting positive or negative history', async () => {
  for (const support of [true, false]) {
    const f = await fixture(), w = orderWorld(f); w.state.support = support;
    const raw = orderedScopeContract();
    let last = await start(f, { contract: raw, representations: [{ format: 'text', content: w.content }], judgeIdentity: 'fixture', policyRevision: '1' });
    assert.equal(last.result.requirements.version.status, support ? 'satisfied' : 'unresolved');
    assert.equal(w.semantic(), 1, 'first actual candidate assessment is required');
    const original = await currentState(f, last.investigationRef), row = original.state.checkpoint.history.at(-1);
    const before = w.semantic(), searches = f.calls.queries.length;
    const round = async extra => last = await f.api.continueCallerRound({ storeRoot: last.storeRoot, investigationRef: last.investigationRef,
      expectedRevision: last.handoff.revision, deps: f.deps, judgeIdentity: 'fixture', policyRevision: '1', ...extra });
    // No replacement: this is the missing persistence transition in the old control.
    let stored;
    await assert.doesNotReject(async () => { stored = await round({}); }, 'ordinary unchanged stored continuation must remain admissible');
    assert.equal(w.semantic(), before); assert.equal(f.calls.queries.length, searches); assert.equal(w.state.reads.length, 0);
    assert.equal(stored.result.usage.candidateJudgeCalls, 0);
    const same = (await currentState(f, last.investigationRef)).state.checkpoint.history.at(-1);
    assert.equal(same.namespace, row.namespace); assert.deepEqual(same.state.callerAttempts, row.state.callerAttempts);
    assert.deepEqual(stored.result.requirements.version.attemptedRecords, original.state.checkpoint.history.at(-1).state.attemptedRecords);
    if (support) assert.deepEqual(stored.result.requirements.version.judgment, original.state.checkpoint.history.at(-1).state.acceptedCandidate.judgment);
    const equivalent = { ...raw, scope: { a: 'first', z: 'last' } };
    await round({ contract: equivalent }); assert.equal(w.semantic(), before); assert.equal(f.calls.queries.length, searches);
    assert.deepEqual(Object.keys(last.contract.scope), ['a', 'z']);
    w.state.support = true;
    const changed = await round({ contract: { ...raw, scope: { z: 'last', a: 'changed' } } });
    assert.equal(changed.result.data.version, '2.4'); assert.equal(w.semantic(), before + 1);
    const paid = w.semantic(), restored = await round({ contract: raw });
    assert.equal(w.semantic(), paid); assert.equal(restored.result.usage.candidateJudgeCalls, 0);
    assert.equal(restored.result.requirements.version.status, support ? 'satisfied' : 'unresolved');
    const final = await currentState(f, last.investigationRef);
    assert.deepEqual(final.state.checkpoint.history.slice(0, original.state.checkpoint.history.length), original.state.checkpoint.history);
  }
  const f = await fixture(), w = orderWorld(f), canonical = { ...orderedScopeContract(), scope: { a: 'first', z: 'last' } };
  const first = await start(f, { contract: canonical, representations: [{ format: 'text', content: w.content }], judgeIdentity: 'fixture', policyRevision: '1' });
  const before = w.semantic();
  await f.api.continueCallerRound({ storeRoot: first.storeRoot, investigationRef: first.investigationRef, expectedRevision: first.handoff.revision,
    deps: f.deps, judgeIdentity: 'fixture', policyRevision: '1' });
  assert.equal(w.semantic(), before);
});

test('S2 canonical caller field priority and coverage stay stable while array order and duplicate dependencies survive', async () => {
  const f = await fixture(), w = orderWorld(f), raw = { ...orderedScopeContract(), evidence: { criteria: ['second', 'first'] }, requirements: {
    z: { question: 'Parent?', schema: { type: 'string' } },
    a: { question: 'Qualified?', schema: { enum: ['refuted', 'supported', 'disputed'] }, criteria: ['beta', 'alpha'], dependsOn: ['z', 'z'] },
  } };
  let last = await start(f, { contract: raw, roundLimits: { maxJudgeAttempts: 4 }, representations: [{ format: 'text', content: w.content }], judgeIdentity: 'fixture', policyRevision: '1' });
  assert.deepEqual(last.result.data, { a: 'supported', z: 'A' });
  const saved = await currentState(f, last.investigationRef), paid = w.semantic(), searches = f.calls.queries.length, plan = last.result.plan.queries;
  assert.deepEqual(plan.map(p => p.fieldId), [null, 'a', 'z', 'a', 'z']);
  const round = async extra => last = await f.api.continueCallerRound({ storeRoot: last.storeRoot, investigationRef: last.investigationRef,
    expectedRevision: last.handoff.revision, deps: f.deps, judgeIdentity: 'fixture', policyRevision: '1', ...extra });
  for (const extra of [{}, { contract: { ...raw, scope: { a: 'first', z: 'last' }, requirements: { a: raw.requirements.a, z: raw.requirements.z } } }]) {
    await round(extra);
    assert.equal(w.semantic(), paid); assert.equal(f.calls.queries.length, searches); assert.deepEqual(last.result.plan.queries, plan);
    assert.deepEqual(last.contract.requirements.a.dependsOn, ['z', 'z']); assert.deepEqual(last.contract.requirements.a.criteria, ['beta', 'alpha']);
    assert.deepEqual(last.contract.requirements.a.schema.enum, ['refuted', 'supported', 'disputed']); assert.deepEqual(last.contract.evidence.criteria, ['second', 'first']);
    assert.equal((await currentState(f, last.investigationRef)).state.coverageBasis, saved.state.coverageBasis);
  }
  const opens = f.calls.open.length;
  await assert.rejects(start(f, { contract: { ...raw, scope: { nested: { value: 'invalid' } } } }), e => e.code === 'VALIDATION_ERROR');
  assert.equal(f.calls.open.length, opens);
});

const orderJSON = value => JSON.stringify(value, (_key, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : v);
async function oldOrderFixture(kind = 'value', options = {}) {
  const f = await fixture(), w = orderWorld(f);
  const raw = kind === 'coverage' ? { ...orderedScopeContract(), scope: {}, requirements: {
    z: { question: 'Z?', schema: { enum: ['supported', 'refuted', 'disputed'] } },
    a: { question: 'A?', schema: { enum: ['supported', 'refuted', 'disputed'] } },
  } } : kind === 'enum' ? { ...orderedScopeContract(), requirements: { flag: { question: 'Qualified?', schema: { enum: ['supported', 'refuted', 'disputed'] } } } }
    : orderedScopeContract();
  if (options.canonical) raw.scope = { a: 'first', z: 'last' };
  // L6 supplies actual owned evidence/storage. The older semantic checkpoint
  // itself comes from the unchanged real engine, not a manufactured proof.
  let last = await start(f, { contract: raw, deps: options.mixed ? f.deps : { ...f.deps, judge: null },
    representations: [{ format: 'text', content: w.content }], judgeIdentity: 'fixture', policyRevision: '1' });
  const current = await currentState(f, last.investigationRef);
  if (options.mixed) { assert.equal(last.result.data.version, '2.4'); w.state.support = false; }
  let checkpoint;
  const beforeEngine = w.semantic();
  const result = await engine.runLeanInvestigation(raw, { ...f.deps, ...(options.inert ? { extract: null } : {}), seed: {
    evidence: last.result.evidence, history: options.mixed ? current.state.checkpoint.history : [],
    identity: JSON.stringify(['fixture', '1', true, true]), callerHistory: { candidates: [], continuous: true }, capture(value) { checkpoint = value; },
  } });
  assert(checkpoint); assert.deepEqual(result.evidence, last.result.evidence);
  if (options.inert) { assert.equal(w.semantic(), beforeEngine); assert.equal(result.requirements.version.reason, 'no_extractor'); }
  else assert(w.semantic() > beforeEngine, 'old authority must come from actual semantic work');
  if (options.mixed) assert.equal(result.requirements.version.status, 'unresolved', 'the old alias contains a real negative guard');
  const compiled = engine.compileLeanContract(raw);
  await rewriteCurrent(f, last.investigationRef, async ({ state, read, stage }) => {
    const entry = state.results.at(-1), payload = await read(entry.result);
    payload.result = result; payload.proposals = []; entry.result = await stage(orderJSON(payload));
    state.checkpoint = checkpoint; state.proposals = [];
    state.coverageBasis = 'sha256:' + digest(orderJSON([compiled.question, compiled.scope, compiled.fields, compiled.evidenceCriteria]));
    if (options.opaque) for (const row of state.checkpoint.history) { delete row.state.callerAttempts; delete row.state.attemptedRecords; }
  });
  w.state.support = true;
  const round = async extra => last = await f.api.continueCallerRound({ storeRoot: last.storeRoot, investigationRef: last.investigationRef,
    expectedRevision: last.handoff.revision, deps: f.deps, judgeIdentity: 'fixture', policyRevision: '1', ...extra });
  return { f, w, raw, last, round };
}

test('S3 real pre-normalization authority refuses paid aliases and unexplained coverage before work while inert and identity limits remain', async () => {
  for (const [kind, options] of [['value', {}], ['enum', {}], ['value', { mixed: true }], ['coverage', {}], ['value', { opaque: true }]]) {
    const x = await oldOrderFixture(kind, options), before = await currentState(x.f, x.last.investigationRef), calls = x.f.calls;
    const counts = [calls.begin.length, calls.bodyWrites, calls.commits, calls.queries.length, x.w.semantic(), x.w.state.reads.length];
    const rows = before.state.checkpoint.history;
    if (kind === 'coverage') assert.deepEqual(engine.compileLeanContract(x.raw).fields.map(f => f.id), ['z', 'a']);
    else assert(rows.some(r => Object.keys(JSON.parse(r.namespace)[1]).join(',') === 'z,a'));
    assert.equal(before.state.historyContinuity.schemaVersion, 1, 'the existing marker does not attest normalized identity');
    await assert.rejects(x.round({}), e => e.code === 'VALIDATION_ERROR' && /legacy history continuity unavailable/.test(e.message));
    assert.deepEqual([calls.begin.length, calls.bodyWrites, calls.commits, calls.queries.length, x.w.semantic(), x.w.state.reads.length], counts);
    assert.deepEqual(await currentState(x.f, x.last.investigationRef), before);
  }
  const inert = await oldOrderFixture('value', { inert: true }), paid = inert.w.semantic();
  const firstAssessment = await inert.round({}); assert.equal(firstAssessment.result.data.version, '2.4'); assert.equal(inert.w.semantic(), paid + 1);
  const canonical = await oldOrderFixture('value', { canonical: true }), canonicalPaid = canonical.w.semantic();
  const hit = await canonical.round({}); assert.equal(hit.result.data.version, '2.4'); assert.equal(canonical.w.semantic(), canonicalPaid);
  for (const mode of ['unknown', 'no-judge']) {
    const x = await oldOrderFixture(), paid = x.w.semantic();
    if (mode === 'no-judge') x.f.deps.judge = null;
    const next = await x.round(mode === 'unknown' ? { judgeIdentity: undefined, policyRevision: undefined } : {});
    assert.equal(next.result.assessment, mode === 'unknown' ? 'semantic' : 'deterministic-only');
    assert.equal(x.w.semantic(), paid + (mode === 'unknown' ? 1 : 0));
  }
  const changed = await oldOrderFixture(), prior = changed.w.semantic();
  const distinct = await changed.round({ contract: { ...changed.raw, scope: { z: 'last', a: 'different value' } } });
  assert.equal(distinct.result.data.version, '2.4'); assert.equal(changed.w.semantic(), prior + 1, 'unrelated old meaning does not prohibit new semantics');
});

test('T1 engine final usage is a fresh actual snapshot on success and retention failure after real retry and semantic work', async () => {
  const c = { schemaVersion: 1, question: 'Release documentation?', requirements: { flag: { question: 'Is the release stable?', schema: { enum: ['supported', 'refuted', 'disputed'] } } } };
  const success = [], one = await engine.runLeanInvestigation(c, { now: () => 0, judge: null, search: async () => [], read: async () => 'Retained source.',
    seed: { leads: [{ url: 'https://fixture.invalid/usage-success', title: 'source' }], captureUsage: u => success.push(u) } });
  assert.equal(success.length, 1, 'final actual usage must be captured exactly once');
  assert.deepEqual(success[0], one.usage); assert.notEqual(success[0], one.usage);
  const originalSearches = success[0].searches; one.usage.searches = 999;
  assert.equal(success[0].searches, originalSearches, 'capture does not alias the mutable returned result');

  const primary = new Error('retention refused after prefix'), observed = { searches: 0, reads: 0, judgments: 0, retained: 0 }, signals = [], captures = [];
  let checkpoints = 0, firstReadFailed = false;
  const deps = { now: () => 0,
    search: async (_query, options) => { observed.searches++; signals.push(options.signal); return [{ url: `https://fixture.invalid/prefix-${observed.searches}`, title: 'source' }]; },
    read: async (url, options) => { observed.reads++; signals.push(options.signal); if (!firstReadFailed) { firstReadFailed = true; throw new Error('one real read retry'); } return 'Read source ' + url; },
    judge: async (input, options) => { observed.judgments++; signals.push(options.signal); return { documents: input.documents.map(d => ({ evidenceId: d.evidenceId, relevant: true, supportsClaim: true, refutesClaim: false })) }; },
    seed: { retainEvidence: async () => { if (observed.retained === 1) throw primary; observed.retained++; }, capture: () => { checkpoints++; },
      captureUsage: u => captures.push({ usage: u, aborted: signals.every(s => s.aborted) }) },
  };
  await assert.rejects(engine.runLeanInvestigation(c, deps), e => e === primary);
  assert.deepEqual(observed, { searches: 2, reads: 3, judgments: 1, retained: 1 }, 'real bounded prefix, including retry and judgment, must precede failure');
  assert.equal(captures.length, 1); assert.equal(captures[0].aborted, true, 'owned abort cleanup precedes final capture');
  assert.deepEqual(captures[0].usage, { searches: observed.searches, readAttempts: observed.reads, readsRetained: observed.retained,
    judgeCalls: observed.judgments, extractorCalls: 0, extractorCacheHits: 0, candidateJudgeCalls: 0 });
  assert.equal(checkpoints, 0, 'usage capture does not publish a failed-run checkpoint');
});

test('T2 failed retention preserves the primary and earlier diagnostics through settlement release and rejected carriers', async () => {
  const primaries = [new Error('PRIVATE_RETENTION'), Object.freeze(new Error('PRIVATE_FROZEN')), 'PRIVATE_PRIMITIVE',
    new Proxy(new Error('PRIVATE_PROXY'), { defineProperty() { throw new Error('PRIVATE_CARRIER_REFUSAL'); } })];
  for (const [i, primary] of primaries.entries()) {
    const f = await fixture(), payload = 'fetched context for T2', output = [], originalConsole = console.error;
    let reads = 0;
    f.deps.read = async () => { reads++; return payload; };
    f.gates.body = text => { if (text === payload) throw primary; };
    f.gates.settlement = () => { throw new Error('PRIVATE_SETTLEMENT'); };
    f.gates.release = () => { throw new Error('PRIVATE_RELEASE'); };
    console.error = (...args) => output.push(args);
    try {
      await assert.rejects(start(f, { leads: [{ url: 'https://fixture.invalid/secondary-failure' }] }), e => e === primary);
      assert.equal(reads, 1); assert.equal(f.calls.queries.length, 0); assert.equal(f.calls.commits, 0);
      assert.equal(f.calls.settlements.length, 1, 'no repeated settlement or engine execution');
      assert.deepEqual(f.calls.settlements[0].summary, { status: 'failed', measured: { searches: 0, reads: 1, judgments: 0 }, uncertainty: 'engine-run-failed:measured-attempts-preserved' });
      assert.equal(f.calls.releases, 2, 'existing nested owners each attempt failure release');
      if (i === 0) {
        const settlement = JSON.parse(primary.settlementFailure), release = JSON.parse(primary.releaseFailure);
        assert.equal(settlement.reason, 'settlement-failed'); assert.equal(settlement.phase, 'engine-rejection');
        assert.deepEqual(settlement.measured, { searches: 0, reads: 1, judgments: 0 });
        assert.deepEqual(release.measured, settlement.measured, 'later wrapper release cannot overwrite the earlier known accounting');
        assert.equal(release.roundId, f.calls.begin[0].roundId); assert.equal(primary.message, 'PRIVATE_RETENTION');
      }
      assert(output.length > 0, 'rejected/repeated carriers use the bounded fallback');
      for (const args of output) {
        assert.equal(args.length, 1); assert.equal(typeof args[0], 'string'); assert(args[0].length <= 512);
        assert(!args[0].includes('PRIVATE_'), 'no primary or secondary content reaches stderr');
        const diagnostic = JSON.parse(args[0]);
        assert.deepEqual(Object.keys(diagnostic).sort(), ['event', 'measured', 'phase', 'reason', 'roundId']);
        assert(['caller-round-accounting-unavailable', 'caller-round-release-failed'].includes(diagnostic.event));
        assert(diagnostic.roundId === null || diagnostic.roundId === f.calls.begin[0].roundId);
        assert(diagnostic.measured === null || diagnostic.measured.reads === 1);
      }
      assert.equal((await f.store.inspect('memory-0')).committed.snapshot.revision, 0);
    } finally { console.error = originalConsole; f.gates.body = null; f.gates.settlement = null; f.gates.release = null; }
  }
});

test('T3 actual captured zero is settled while unavailable engine capture is disclosed without fabricated counters', async () => {
  for (const absent of [false, true]) {
    const f = await fixture(), primary = new Error('clock failure before dispatch'); let clockCalls = 0, reads = 0;
    f.deps.now = () => { clockCalls++; if (clockCalls === (absent ? 1 : 2)) throw primary; return 0; };
    f.deps.read = async () => { reads++; return 'unexpected'; };
    await assert.rejects(start(f), e => e === primary);
    assert.equal(reads, 0); assert.equal(f.calls.queries.length, 0); assert.equal(f.calls.commits, 0);
    assert.equal(f.calls.settlements.length, absent ? 0 : 1);
    if (absent) {
      const diagnostic = JSON.parse(primary.settlementFailure);
      assert.equal(diagnostic.reason, 'usage-unavailable'); assert.equal(diagnostic.measured, null);
    } else assert.deepEqual(f.calls.settlements[0].summary, { status: 'failed', measured: { searches: 0, reads: 0, judgments: 0 }, uncertainty: 'engine-run-failed:measured-attempts-preserved' });
    assert.equal((await f.store.inspect('memory-0')).committed.snapshot.revision, 0);
  }
});

test('ABD D14 malformed native attempts refuse with typed corruption before serialization', async () => {
  const f = await fixture();
  const cyclic = {}; cyclic.provider = cyclic;
  for (const attempt of [{ provider: 1n, phase: 'producer', outcome: 'ok' }, cyclic]) {
    assert.throws(() => f.validatePhysical({ ...observation(), attempts: [attempt] }), CorruptRecordError);
  }
  const unserializable = { ...observation(), attempts: [] }; Object.defineProperty(unserializable, 'toJSON', { value: () => { throw new Error('native serialization'); } });
  assert.throws(() => f.validatePhysical(unserializable), CorruptRecordError);
  assert.doesNotThrow(() => f.validatePhysical(observation()));
});

for (const [kind, feedback] of Object.entries({ leadArray: { leads: {} }, leadNull: { leads: [null] }, leadURL: { leads: [{ url: 'bad URL' }] },
  leadType: { leads: [{ url: 5 }] }, leadTitle: { leads: [{ url: 'https://fixture.invalid', title: 4 }] }, repArray: { representations: {} },
  repNull: { representations: [null] }, repLabel: { representations: [{ format: 'text', content: 'X', label: 5 }] }, proposals: { proposals: {} },
  serial: { representations: [{ format: 'text', content: 'X', extension: 1n }] } })) {
  test('ABD D10 malformed feedback ' + kind + ' refuses before store work', async () => {
    const f = await fixture();
    await assert.rejects(start(f, feedback), e => e.code === 'VALIDATION_ERROR'); assert.equal(f.calls.open.length, 0);
  });
}

const continueRound = (f, last, extra = {}) => f.api.continueCallerRound({ storeRoot: last.storeRoot, investigationRef: last.investigationRef,
  expectedRevision: last.handoff.revision, deps: f.deps, ...extra });
async function corruptBoundary(f, last, kind) {
  const ref = last.investigationRef, { snapshot, pointer } = await currentState(f, ref), handle = await f.store.acquireOwnership(ref);
  const body = async text => { const b = await handle.stageBody(text), item = { bodyId: b.bodyId, digest: 'sha256:' + b.bodyId.slice(2), bytes: b.bytes }; snapshot.bodies.push(item); return item; };
  try {
    if (kind === 'auditJSON' || kind === 'auditNull') snapshot.audit.at(-1).detail = kind === 'auditJSON' ? '{' : 'null';
    else {
      if (kind.startsWith('state') || kind === 'contractJSON') {
        const which = kind === 'contractJSON' ? 'contract' : 'state', b = await body(kind === 'stateShape' ? 'null' : '{');
        pointer[which] = { digest: b.digest, chunks: [b] }; if (which === 'contract') pointer.definitionRevision = b.digest;
      }
      const b = await body(kind === 'rootJSON' ? '{' : kind === 'rootNull' ? 'null' : JSON.stringify(pointer));
      snapshot.audit.at(-1).detail = JSON.stringify({ schemaVersion: 1, root: b.bodyId });
      if (kind === 'ghost') snapshot.bodies = snapshot.bodies.filter(x => x.bodyId !== b.bodyId);
    }
    await handle.commitRevision({ snapshot });
  } finally { await handle.release(); }
}
for (const kind of ['ghost', 'auditJSON', 'auditNull', 'rootJSON', 'rootNull', 'stateJSON', 'stateShape', 'contractJSON']) for (const action of ['continue', 'read']) {
  test(`ABD D9D11 ${kind} ${action} refuses with typed corruption before work`, async () => {
    const f = await fixture(), last = await start(f); await corruptBoundary(f, last, kind);
    const begin = f.calls.begin.length, writes = f.calls.bodyWrites, commits = f.calls.commits;
    let rootReads = 0; const original = f.store.readBody;
    f.store.readBody = async (...args) => { rootReads++; return original(...args); };
    await assert.rejects(action === 'read' ? f.api.readCallerRecord(last.storeRoot, last.investigationRef) : continueRound(f, last), CorruptRecordError);
    assert.deepEqual([f.calls.begin.length, f.calls.bodyWrites, f.calls.commits], [begin, writes, commits]);
    if (kind === 'ghost') assert.equal(rootReads, 0, 'committed membership precedes body access');
  });
}

const proposalFor = (last, event = last.handoff.evidence[0], extra = {}) => ({ fieldId: 'version', mode: 'string', value: '2.4',
  definitionRevision: last.handoff.definitions.version, representationId: event.representationId, digest: event.digest, quote: '2.4', charRange: [8, 11], ...extra });
for (const outcome of ['valid', 'invalid', 'ordinary-error', 'fatal']) test('ABD A1 delegates unrelated typed extraction ' + outcome, async () => {
  const f = await fixture(), c = { schemaVersion: 1, question: 'Release?', scope: { entity: 'fixture' }, requirements: {
    version: { question: 'Version?', schema: { type: 'string' } }, license: { question: 'License?', schema: { type: 'string' } } } };
  const first = await start(f, { contract: c, representations: [{ format: 'text', content: 'Version 2.4. License MIT.' }] });
  const w = orderWorld(f), requests = [], primary = Object.assign(new Error('delegated'), outcome === 'fatal' ? { fatalMeasurement: true } : {});
  const attempt = { finishReason: 'stop', rawOutput: outcome === 'invalid' ? 'not JSON' : JSON.stringify({ license: { value: 'MIT', quote: 'MIT', charRange: [21, 24] } }),
    usage: { inputTokens: 7, outputTokens: 3 }, observedCost: 0.5, elapsedMs: 17, requestSha256: 'a'.repeat(64) };
  f.deps.extract = async (request, options) => { requests.push({ request, options }); if (outcome.endsWith('error') || outcome === 'fatal') throw primary; return attempt; };
  const pending = continueRound(f, first, { proposals: [proposalFor(first)], judgeIdentity: 'fixture', policyRevision: '1' });
  if (outcome === 'fatal') await assert.rejects(pending, e => e === primary);
  else {
    const last = await pending;
    assert.equal(last.result.data.version, '2.4');
    assert.equal(last.result.data.license, outcome === 'valid' ? 'MIT' : undefined);
    if (outcome === 'valid') {
      const rows = (await currentState(f, first.investigationRef)).state.checkpoint.history.flatMap(r => r.state.attemptedRecords ?? []);
      const meta = rows.find(r => r.metadata?.requestSha256 === attempt.requestSha256)?.metadata;
      assert(meta); assert.deepEqual(meta.usage, attempt.usage); assert.equal(meta.observedCost, 0.5); assert.equal(meta.elapsedMs, 17);
    }
  }
  assert.equal(requests.length, 1, 'local proposal never delegates; unrelated field delegates exactly once');
  assert.deepEqual(requests[0].request.fields.map(x => x.id), ['license']);
  assert.equal(requests[0].request.sourceId, first.handoff.evidence[0].evidenceId); assert.equal(requests[0].request.sourceText, first.result.evidence[0].content);
  assert.deepEqual(requests[0].request.scope, c.scope); assert.deepEqual(requests[0].request.depBindings, {});
  assert(requests[0].options.signal instanceof AbortSignal); assert(requests[0].options.timeoutMs > 0); assert(requests[0].options.timeoutMs <= engine.compileLeanContract(c).limits.deadlineMs);
});

for (const kind of ['ambiguous', 'second', 'wrong', 'selectorWithoutBody', 'unique']) test('ABD A4 event binding ' + kind, async () => {
  const f = await fixture(), last = await start(f, { representations: Array.from({ length: kind === 'unique' ? 1 : 2 }, () => ({ format: 'text', content: 'Version 2.4.' })) });
  const before = f.calls.begin.length, p = proposalFor(last, last.handoff.evidence.at(-1));
  if (kind === 'second') p.evidenceId = last.handoff.evidence[1].evidenceId;
  if (kind === 'wrong') p.evidenceId = 'unrelated';
  if (kind === 'selectorWithoutBody') { p.evidenceId = last.handoff.evidence[1].evidenceId; delete p.representationId; }
  const owned = copy(p);
  if (['ambiguous', 'wrong', 'selectorWithoutBody'].includes(kind)) {
    await assert.rejects(continueRound(f, last, { proposals: [p] }), e => e.code === 'VALIDATION_ERROR'); assert.equal(f.calls.begin.length, before);
  } else {
    const w = orderWorld(f); f.deps.extract = null;
    const next = await continueRound(f, last, { proposals: [p], judgeIdentity: 'fixture', policyRevision: '1' });
    assert.equal(next.result.data.version, '2.4');
    const saved = await f.api.readCallerRecord(last.storeRoot, last.investigationRef);
    assert.equal(saved.payload.proposals[0].evidenceId, last.handoff.evidence.at(-1).evidenceId);
    const attempts = (await currentState(f, last.investigationRef)).state.checkpoint.history.flatMap(r => r.state.callerAttempts ?? []);
    assert(attempts.some(a => a.basis.candidate.evidenceId === last.handoff.evidence.at(-1).evidenceId && a.basis.candidate.url === last.handoff.evidence.at(-1).url));
    const paid = w.semantic(); await continueRound(f, next, { representations: [{ format: 'text', content: 'Version 2.4.' }], judgeIdentity: 'fixture', policyRevision: '1' });
    assert.equal((await currentState(f, last.investigationRef)).state.proposals[0].evidenceId, last.handoff.evidence.at(-1).evidenceId);
    assert(w.semantic() >= paid);
  }
  assert.deepEqual(p, owned, 'normalization owns its selector without mutating caller input');
});
for (const kind of ['null', 'body', 'classification', 'extra', 'duplicate']) test('ABD A12 malformed retained proposal ' + kind + ' refuses even obsolete intent', async () => {
  const f = await fixture(), last = await start(f, { representations: [{ format: 'text', content: 'Version 2.4.' }] });
  await rewriteCurrent(f, last.investigationRef, async ({ state }) => {
    const p = proposalFor(last);
    if (kind === 'null') state.proposals = [null];
    if (kind === 'body') state.proposals = [{ ...p, representationId: 'b:' + '0'.repeat(64) }];
    if (kind === 'classification') state.proposals = [{ ...p, mode: 'classification', value: 'nonsense' }];
    if (kind === 'extra') state.proposals = [{ ...p, evidenceId: 42 }];
    if (kind === 'duplicate') state.proposals = [p, p];
  });
  const before = f.calls.begin.length;
  await assert.rejects(continueRound(f, last, { contract: { ...contract(), question: 'Changed meaning?' } }), CorruptRecordError);
  assert.equal(f.calls.begin.length, before);
});

for (const kind of ['active', 'replacement', 'obsolete']) test('ABD A4 legacy ambiguous reference remains historical with ' + kind + ' continuation', async () => {
  const f = await fixture(), last = await start(f, { representations: [0, 1].map(() => ({ format: 'text', content: 'Version 2.4.' })) });
  await rewriteCurrent(f, last.investigationRef, async ({ state, read, stage }) => {
    state.proposals = [proposalFor(last)]; const entry = state.results.at(-1), payload = await read(entry.result);
    payload.proposals = copy(state.proposals); entry.result = await stage(JSON.stringify(payload));
  });
  const old = await f.api.readCallerRecord(last.storeRoot, last.investigationRef); assert.equal(Object.hasOwn(old.payload.proposals[0], 'evidenceId'), false);
  if (kind === 'active') {
    const before = f.calls.begin.length; await assert.rejects(continueRound(f, last), e => e.code === 'VALIDATION_ERROR' && /Ambiguous/.test(e.message)); assert.equal(f.calls.begin.length, before);
  } else {
    const next = await continueRound(f, last, kind === 'replacement' ? { proposals: [proposalFor(last, last.handoff.evidence[1], { evidenceId: last.handoff.evidence[1].evidenceId })] }
      : { contract: { ...contract(), question: 'Different intent?' } });
    assert.equal((await f.api.readCallerRecord(last.storeRoot, last.investigationRef)).payload.proposals.length, kind === 'replacement' ? 1 : 0);
    assert.deepEqual((await f.api.readCallerRecord(last.storeRoot, last.investigationRef, 1)).payload, old.payload);
    assert.equal(next.handoff.revision, 2);
  }
});

test('ABD B episode lowering restores baseline for genuinely eligible reads and preserves prior executed history', async () => {
  const f = await fixture(), reads = []; f.deps.read = async url => { reads.push(url); return 'Source ' + url; };
  const baseline = { ...contract(), limits: { ...contract().limits, maxUniqueReads: 3 } };
  const first = await start(f, { contract: baseline, roundLimits: { maxUniqueReads: 1 }, leads: Array.from({ length: 16 }, (_, i) => ({ url: 'https://fixture.invalid/baseline-' + i })) });
  assert.equal(reads.length, 1); const old = await f.api.readCallerRecord(first.storeRoot, first.investigationRef, 1); assert.equal(old.contract.limits.maxUniqueReads, 1);
  const second = await continueRound(f, first); assert.equal(second.result.usage.readAttempts, 3); assert.equal(reads.length, 4); assert.equal(second.contract.limits.maxUniqueReads, 3);
  const raised = await continueRound(f, second, { roundLimits: { maxUniqueReads: 4 } }); assert.equal(raised.result.usage.readAttempts, 3); assert.equal(raised.contract.limits.maxUniqueReads, 3); assert.equal(reads.length, 7);
  const replacement = await continueRound(f, raised, { contract: { ...baseline, limits: { ...baseline.limits, maxUniqueReads: 4 } } });
  assert.equal(replacement.result.usage.readAttempts, 4); assert.equal(reads.length, 11); assert.equal(new Set(reads).size, 11);
  assert.deepEqual((await f.api.readCallerRecord(first.storeRoot, first.investigationRef, 1)).payload, old.payload);
  assert.deepEqual((await f.api.readCallerRecord(first.storeRoot, first.investigationRef, 1)).contract, old.contract);
  assert.equal(replacement.handoff.cumulativeUsage.reads, reads.length);
});

test('ABD B absent legacy baseline stays conservatively effective until explicit replacement', async () => {
  const f = await fixture(); f.deps.read = async url => 'Source ' + url;
  const baseline = { ...contract(), limits: { ...contract().limits, maxUniqueReads: 3 } };
  const first = await start(f, { contract: baseline, roundLimits: { maxUniqueReads: 1 }, leads: Array.from({ length: 8 }, (_, i) => ({ url: 'https://fixture.invalid/legacy-' + i })) });
  await rewriteCurrent(f, first.investigationRef, async ({ pointer }) => { delete pointer.baselineContract; });
  const second = await continueRound(f, first, { roundLimits: { maxUniqueReads: 3 } }); assert.equal(second.contract.limits.maxUniqueReads, 1); assert.equal(second.result.usage.readAttempts, 1);
  const third = await continueRound(f, second, { contract: baseline }); assert.equal(third.contract.limits.maxUniqueReads, 3); assert.equal(third.result.usage.readAttempts, 3);
});
for (const baselineContract of [null, {}, { digest: 'bad', chunks: [] }]) test('ABD B malformed recognized baseline pointer refuses', async () => {
  const f = await fixture(), first = await start(f); await rewriteCurrent(f, first.investigationRef, async ({ pointer }) => { pointer.baselineContract = baselineContract; });
  const before = f.calls.begin.length; await assert.rejects(continueRound(f, first), CorruptRecordError); assert.equal(f.calls.begin.length, before);
  await assert.rejects(f.api.readCallerRecord(first.storeRoot, first.investigationRef), CorruptRecordError);
});

for (const kind of ['data', 'requirements', 'definitions']) test('ABD D payload dictionary shape ' + kind + ' refuses at its document boundary', async () => {
  const f = await fixture(), last = await start(f);
  await rewriteCurrent(f, last.investigationRef, async ({ state, read, stage }) => {
    const entry = state.results.at(-1), payload = await read(entry.result);
    if (kind === 'definitions') payload.definitions = Object.values(payload.definitions); else payload.result[kind] = [];
    entry.result = await stage(JSON.stringify(payload));
  });
  await assert.rejects(f.api.readCallerRecord(last.storeRoot, last.investigationRef), CorruptRecordError);
});

const c7Observation = (acquisition, judge = null, total = acquisition + (judge ?? 0), admission = judge === null ? "not-configured" : "shared") => ({
  schemaVersion:1,source:"handler-owned-native-ledger",cutoff:"locally-settled",stages:{acquisition,judge,producer:null},knownSubtotal:acquisition+(judge??0),total,reservationsRefused:0,
  admission:{acquisition:"shared",judge:admission,producer:"not-configured"},attempts:[],
});
test("C7 measured physical subtotals survive conservative totals and unknown admission", async () => {
  const f=await fixture(); let observations=0;
  const first=await start(f,{nativeObservation:()=>{observations++;return c7Observation(3,2,null,"unknown");}});
  assert.equal(first.handoff.cumulativeUsage.knownSubtotal.physicalAttempts,5,"measured subtotal must survive conservative totalnull");
  assert.equal(first.handoff.cumulativeUsage.physicalAttempts,null);
  assert.deepEqual(first.handoff.cumulativeUsage.unknownStages,[]);
  assert(first.handoff.cumulativeUsage.reasons.includes("physical-conservative-total"));
  const second=await f.api.continueCallerRound({storeRoot:first.storeRoot,investigationRef:first.investigationRef,expectedRevision:1,deps:f.deps,
    nativeObservation:()=>{observations++;return c7Observation(4);}});
  assert.equal(second.handoff.cumulativeUsage.knownSubtotal.physicalAttempts,9);
  assert.equal(second.handoff.cumulativeUsage.physicalAttempts,null);
  assert.deepEqual(second.handoff.cumulativeUsage.unknownStages,[]);
  assert.equal(observations,2,"physical callback sampled exactly once per episode");
  const old=await f.api.readCallerRecord(first.storeRoot,first.investigationRef,1);
  const {schemaVersion,...projection}=old.payload.accounting;
  assert.equal(schemaVersion,1); assert.deepEqual(projection,first.handoff.cumulativeUsage);
});

for(const state of ["unsafe-native","sum-overflow","missing-continuity","missing-prefix","missing-observation","legacy-accounting"])test(`C7 numeric and physical truth: ${state}`,async()=>{
  const f=await fixture(),first=await start(f,{nativeObservation:()=>c7Observation(2)});
  await rewriteCurrent(f,first.investigationRef,async({state:s,snapshot,stage,read})=>{
    if(state==="unsafe-native")snapshot.rounds[0].usage.searches=Number.MAX_SAFE_INTEGER+1;
    if(state==="sum-overflow")snapshot.rounds[0].usage.searches=Number.MAX_SAFE_INTEGER;
    if(state==="missing-continuity")delete s.accountingContinuity;
    if(state==="missing-prefix")delete s.results;
    if(state==="missing-observation"||state==="legacy-accounting"){
      const e=s.results[0],payload=await read(e.result);delete payload.accounting;
      if(state==="missing-observation")delete payload.physical;
      e.result=await stage(JSON.stringify(payload));
    }
  });
  if(state==="legacy-accounting")assert.equal(Object.hasOwn((await f.api.readCallerRecord(first.storeRoot,first.investigationRef,1)).payload,"accounting"),false);
  const next=await f.api.continueCallerRound({storeRoot:first.storeRoot,investigationRef:first.investigationRef,expectedRevision:1,deps:f.deps,
    contract:{...contract(),question:"A different version?"},nativeObservation:()=>c7Observation(3)});
  const c=next.handoff.cumulativeUsage;
  if(state==="unsafe-native"||state==="sum-overflow"){
    assert.equal(c.searches,null);assert.equal(c.knownSubtotal.searches,state==="sum-overflow"?Number.MAX_SAFE_INTEGER:next.result.usage.searches);
    assert(c.reasons.includes(`${state==="sum-overflow"?"numeric-overflow":"numeric-range"}:searches`));
    assert.equal(c.reads,0);assert.equal(c.judgments,0);assert.equal(c.rounds,2);assert.equal(c.physicalAttempts,5);
  }else if(state==="missing-continuity"){
    assert.equal(c.rounds,null);assert.equal(c.searches,null);assert.equal(c.physicalAttempts,null);assert.equal(c.knownSubtotal.physicalAttempts,5);assert(c.reasons.includes("missing-continuity"));
  }else if(state==="missing-prefix"||state==="missing-observation"){
    assert.equal(c.rounds,2);assert.equal(c.physicalAttempts,null);assert.equal(c.knownSubtotal.physicalAttempts,3);assert.deepEqual(c.unknownStages,["acquisition","judge","producer"]);
  }else{assert.equal(c.physicalAttempts,5);assert.equal(c.complete.physical,true);}
});

test("C7 failed extra has unknown physical work while measured committed subtotal survives",async()=>{
 const f=await fixture(),first=await start(f,{nativeObservation:()=>c7Observation(2)});
 f.store.recoveryRecords=[{publicationState:"unpublished",work:{schemaVersion:1,measured:{searches:0,reads:1,judgments:0},status:"failed",settledAt:1,unavailableReason:null}}];
 const next=await f.api.continueCallerRound({storeRoot:first.storeRoot,investigationRef:first.investigationRef,expectedRevision:1,deps:f.deps,nativeObservation:()=>c7Observation(3)});
 assert.equal(next.handoff.cumulativeUsage.physicalAttempts,null);assert.equal(next.handoff.cumulativeUsage.knownSubtotal.physicalAttempts,5);assert.deepEqual(next.handoff.cumulativeUsage.unknownStages,["acquisition","judge","producer"]);assert.equal(next.handoff.cumulativeUsage.rounds,3);assert.equal(next.handoff.cumulativeUsage.reads,1);
});

for (const disposition of ['positive', 'negative']) test('W2 selected later event owns the sole judgment ' + disposition, async () => {
  const f = await fixture(true), first = await start(f, { representations: [
    { format: 'text', content: 'Version 1.0.' }, { format: 'text', content: 'Version 2.4.' },
  ] });
  const earlier = first.handoff.evidence[0], selected = first.handoff.evidence[1], automatic = [], w = orderWorld(f);
  w.state.support = disposition === 'positive';
  f.deps.extract = async request => {
    automatic.push(copy(request));
    return { finishReason: 'stop', rawOutput: JSON.stringify({ version: { value: '1.0', quote: '1.0', charRange: [8, 11] } }), usage: null, observedCost: null };
  };
  const proposal = proposalFor(first, selected, { evidenceId: selected.evidenceId });
  const next = await continueRound(f, first, { proposals: [proposal], roundLimits: { maxJudgeAttempts: 1 }, judgeIdentity: 'fixture', policyRevision: '1' });
  const attempts = (await currentState(f, next.investigationRef)).state.checkpoint.history.flatMap(r => r.state.callerAttempts ?? []);
  console.log(JSON.stringify({ case: 'W2-proposal-priority', disposition, selectedEvent: selected.evidenceId, automaticEvents: automatic.map(r => r.sourceId),
    judgedCandidates: attempts.map(a => a.basis.candidate), usage: next.result.usage, data: next.result.data }));
  assert.equal(automatic.length, 0, 'an explicitly selected field must abstain on the earlier event instead of spending its judgment');
  assert.equal(w.state.candidates.length, 1); assert.equal(next.result.usage.candidateJudgeCalls, 1); assert.equal(next.result.usage.judgeCalls, 0);
  assert.equal(attempts.length, 1);
  assert.deepEqual(attempts[0].basis.candidate, { fieldId: 'version', evidenceId: selected.evidenceId, url: selected.url,
    digest: selected.digest.slice(7), value: proposal.value, quote: proposal.quote, charRange: proposal.charRange });
  assert.notEqual(attempts[0].basis.candidate.evidenceId, earlier.evidenceId);
  assert.equal(next.result.requirements.version.status, disposition === 'positive' ? 'satisfied' : 'unresolved');
  assert.equal(next.result.data.version, disposition === 'positive' ? '2.4' : undefined);
  if (disposition === 'positive') {
    assert.deepEqual(next.result.requirements.version.evidenceIds, []);
    assert.deepEqual(next.result.requirements.version.provenance, { fieldId: 'version', sourceId: selected.evidenceId, sourceDigest: selected.digest.slice(7),
      value: proposal.value, quote: proposal.quote, charRange: proposal.charRange });
  } else assert.equal(next.result.requirements.version.provenance, undefined);
  assert.equal(next.handoff.revision, 2); assert.equal(next.handoff.round.status, 'settled'); assert.equal(f.calls.begin.length, 2);
  assert.deepEqual((await f.api.readCallerRecord(next.storeRoot, next.investigationRef)).payload.proposals, [proposal]);
});

test('W2 no proposal preserves automatic field extraction', async () => {
  const f = await fixture(), first = await start(f, { representations: [{ format: 'text', content: 'Version 2.4.' }] });
  const w = orderWorld(f), original = f.deps.extract, requests = [];
  f.deps.extract = async (request, options) => { requests.push({ request, options }); return original(request, options); };
  const next = await continueRound(f, first, { roundLimits: { maxJudgeAttempts: 1 }, judgeIdentity: 'fixture', policyRevision: '1' });
  assert.equal(requests.length, 1); assert.equal(requests[0].request.sourceId, first.handoff.evidence[0].evidenceId);
  assert.equal(requests[0].request.sourceText, 'Version 2.4.'); assert.deepEqual(requests[0].request.fields.map(f => f.id), ['version']);
  assert.equal(next.result.data.version, '2.4'); assert.equal(w.state.candidates.length, 1); assert.equal(next.result.usage.candidateJudgeCalls, 1);
  assert.equal(next.result.requirements.version.provenance.sourceId, first.handoff.evidence[0].evidenceId);
});


test('L7 A latest baseline read API preserves intent without owner work or invented historical baseline', async () => {
  const f = await fixture();
  const baseline = { ...contract(), limits: { ...contract().limits, maxUniqueReads: 3 } };
  const first = await start(f, { contract: baseline, roundLimits: { maxUniqueReads: 1 } });
  const before = { begin: f.calls.begin.length, settlements: f.calls.settlements.length, releases: f.calls.releases, commits: f.calls.commits };
  const latest = await f.api.readCallerRecord(first.storeRoot, first.investigationRef);
  assert.equal(Object.hasOwn(latest, 'baselineContract'), true, 'selected latest must expose the validated baseline');
  assert.equal(latest.baselineContract.limits.maxUniqueReads, 3);
  assert.equal(latest.contract.limits.maxUniqueReads, 1, 'executed contract stays episode lowered');
  const explicitLatest = await f.api.readCallerRecord(first.storeRoot, first.investigationRef, 1);
  assert.deepEqual(explicitLatest.baselineContract, latest.baselineContract);
  assert.deepEqual({ begin: f.calls.begin.length, settlements: f.calls.settlements.length, releases: f.calls.releases, commits: f.calls.commits }, before, 'offline reading must not acquire or settle an owner');
  const second = await continueRound(f, first);
  const historical = await f.api.readCallerRecord(first.storeRoot, first.investigationRef, 1);
  assert.equal(Object.hasOwn(historical, 'baselineContract'), false, 'historical views have no invented baseline property');
  assert.deepEqual(historical.contract, latest.contract); assert.deepEqual(historical.payload, latest.payload);
  assert.equal((await f.api.readCallerRecord(first.storeRoot, first.investigationRef, second.handoff.revision)).baselineContract.limits.maxUniqueReads, 3);
  const legacy = await fixture(), legacyFirst = await start(legacy, { contract: baseline, roundLimits: { maxUniqueReads: 1 } });
  await rewriteCurrent(legacy, legacyFirst.investigationRef, async ({ pointer }) => { delete pointer.baselineContract; });
  const fallback = await legacy.api.readCallerRecord(legacyFirst.storeRoot, legacyFirst.investigationRef);
  assert.deepEqual(fallback.baselineContract, fallback.contract, 'legacy missing baseline retains the conservative executed ceiling');
  await rewriteCurrent(legacy, legacyFirst.investigationRef, async ({ pointer }) => { pointer.baselineContract = { digest: 'bad', chunks: [] }; });
  const ownersBefore = legacy.calls.begin.length;
  await assert.rejects(legacy.api.readCallerRecord(legacyFirst.storeRoot, legacyFirst.investigationRef), CorruptRecordError);
  assert.equal(legacy.calls.begin.length, ownersBefore);
});
