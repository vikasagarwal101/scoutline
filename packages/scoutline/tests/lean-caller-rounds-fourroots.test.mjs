/**
 * Four-roots correction RED→GREEN suite (caller-rounds ticket):
 *  R1 unknown judge identity must block cross-round history reuse
 *  R2 changed proposal value on same representation reopens assessment
 *  R3 assembled semantic request bounded by 256KiB; overflow = incomplete, 0 dispatch
 *  R4 no paid work before the first pointer/publication refusal; failed round keeps measured accounting
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { startCallerRound, continueCallerRound, readCallerRecord } from "../dist/lib/lean-caller-rounds.js";
import { openStore, SETTLEMENT_RESERVE_BYTES } from "../dist/lib/retained-record-store.js";
import { atomicReplaceFile } from "../dist/lib/config-store.js";

globalThis.fetch = () => { throw new Error("HTTP refused"); };
const CONTRACT = { schemaVersion: 1, question: "Version?", requirements: { version: { question: "Version?", schema: { type: "string" }, required: true } } };
const BASE = { schemaVersion: 1, fields: { version: { definition: "synthetic", required: true } } };

function decodeBoundSettlement(raw, marker) {
  assert(Array.isArray(raw)); assert.equal(raw.length, 6); assert.equal(raw[0], 2);
  assert.equal(raw[1], createHash("sha256").update(JSON.stringify([marker.roundId, marker.ownerId, marker.revisionBase])).digest("hex"));
  assert(Number.isFinite(raw[2]) && raw[2] >= 0); assert.equal(raw[4].length, 3);
  return { roundId: marker.roundId, settledAt: raw[2], summary: { status: raw[3], measured: { searches: raw[4][0], reads: raw[4][1], judgments: raw[4][2] }, uncertainty: raw[5] } };
}

function judgeWorld() {
  const state = { semantic: 0, verdict: 0.97 };
  const deps = {
    now: Date.now,
    search: async () => [{ url: "https://example.test/pkg", title: "pkg" }],
    read: async () => "package foo version 2.4 license MIT",
    judge: async () => ({ documents: [] }),
    extract: null,
    candidateJudge: async (input) => {
      state.semantic += 1;
      const answers = {};
      input.candidates.forEach((c, i) => {
        answers[`q${i}s`] = { type: "noul", noul: state.verdict };
        answers[`q${i}c`] = { type: "noul", noul: 0.01 };
      });
      return { model: "probe-judge", answers, usage: { inputTokens: 1, outputTokens: 1 }, requestSha256: "0".repeat(64), elapsedMs: 1 };
    },
  };
  return { state, deps };
}
async function run2(deps, opts = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fourroots-"));
  const r1 = await startCallerRound({ storeRoot: root, contract: CONTRACT, deps, ...opts.start });
  const r2 = await continueCallerRound({ storeRoot: root, investigationRef: r1.investigationRef, expectedRevision: r1.handoff.revision, deps, ...opts.continue });
  return { root, r1, r2 };
}

// R1: absent judgeIdentity + actual judge swap → round 3 MUST re-assess live.
test("R1: unknown judge identity blocks history reuse; swapped judge re-assesses", async () => {
  const { state, deps } = judgeWorld();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fourroots-"));
  try {
    const r1 = await startCallerRound({ storeRoot: root, contract: CONTRACT, deps }); // NO identity
    const rep = r1.handoff.evidence.find((e) => e.url === "https://example.test/pkg");
    const p = [{ fieldId: "version", mode: "string", value: "2.4", definitionRevision: r1.handoff.definitions.version, representationId: rep.representationId, digest: rep.digest, quote: "version 2.4", charRange: [12, 23] }];
    const r2 = await continueCallerRound({ storeRoot: root, investigationRef: r1.investigationRef, expectedRevision: r1.handoff.revision, deps, proposals: p }); // still no identity
    assert.equal(r2.result.data.version, "2.4");
    const assessed = state.semantic;
    assert.ok(assessed > 0, "probe: proposal was assessed once");
    state.verdict = 0.01; // SWAP the actual judge behavior — refutes now
    const r3 = await continueCallerRound({ storeRoot: root, investigationRef: r2.investigationRef, expectedRevision: r2.handoff.revision, deps, proposals: p });
    assert.ok(state.semantic > assessed,
      `absent identity + swapped judge must re-assess live (semantic ${state.semantic} stayed ${assessed}; stale accept delivered)`);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

// R1 positive control: PINNED identity keeps zero re-dispatch.
test("R1p: pinned judge identity preserves zero-dispatch reuse", async () => {
  const { state, deps } = judgeWorld();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fourroots-"));
  try {
    const r1 = await startCallerRound({ storeRoot: root, contract: CONTRACT, deps, judgeIdentity: "probe-judge@1", policyRevision: "p1" });
    const rep = r1.handoff.evidence.find((e) => e.url === "https://example.test/pkg");
    const p = [{ fieldId: "version", mode: "string", value: "2.4", definitionRevision: r1.handoff.definitions.version, representationId: rep.representationId, digest: rep.digest, quote: "version 2.4", charRange: [12, 23] }];
    const r2 = await continueCallerRound({ storeRoot: root, investigationRef: r1.investigationRef, expectedRevision: r1.handoff.revision, deps, judgeIdentity: "probe-judge@1", policyRevision: "p1", proposals: p });
    assert.equal(r2.result.data.version, "2.4");
    assert.equal(state.semantic, 1, "exactly one assessment across both rounds");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

// R2: changed proposal binding (quote/range) on identical representation reopens the field.
test("R2: changed proposal value on same representation forces fresh assessment", async () => {
  const { state, deps } = judgeWorld();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fourroots-"));
  try {
    const r1 = await startCallerRound({ storeRoot: root, contract: CONTRACT, deps, judgeIdentity: "probe-judge@1", policyRevision: "p1" });
    const rep = r1.handoff.evidence.find((e) => e.url === "https://example.test/pkg");
    // Same value, DIFFERENT quote/range binding on the same representation.
    const mk = (quote, range) => [{ fieldId: "version", mode: "string", value: "2.4", definitionRevision: r1.handoff.definitions.version, representationId: rep.representationId, digest: rep.digest, quote, charRange: range }];
    const r2 = await continueCallerRound({ storeRoot: root, investigationRef: r1.investigationRef, expectedRevision: r1.handoff.revision, deps, judgeIdentity: "probe-judge@1", policyRevision: "p1", proposals: mk("version 2.4", [12, 23]) });
    assert.equal(r2.result.data.version, "2.4");
    const assessed = state.semantic;
    // CHANGED binding against the SAME representation must be re-judged.
    const r3 = await continueCallerRound({ storeRoot: root, investigationRef: r2.investigationRef, expectedRevision: r2.handoff.revision, deps, judgeIdentity: "probe-judge@1", policyRevision: "p1", proposals: mk("2.4", [20, 23]) });
    assert.ok(state.semantic > assessed, `changed binding must be judged (semantic ${state.semantic} > ${assessed})`);
    assert.equal(r3.result.data.version, "2.4");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

// R2 identical-proposal control: no re-buy.
test("R2p: identical resubmitted proposal does not re-buy judgment", async () => {
  const { state, deps } = judgeWorld();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fourroots-"));
  try {
    const r1 = await startCallerRound({ storeRoot: root, contract: CONTRACT, deps, judgeIdentity: "probe-judge@1", policyRevision: "p1" });
    const rep = r1.handoff.evidence.find((e) => e.url === "https://example.test/pkg");
    const p = [{ fieldId: "version", mode: "string", value: "2.4", definitionRevision: r1.handoff.definitions.version, representationId: rep.representationId, digest: rep.digest, quote: "version 2.4", charRange: [12, 23] }];
    const r2 = await continueCallerRound({ storeRoot: root, investigationRef: r1.investigationRef, expectedRevision: r1.handoff.revision, deps, judgeIdentity: "probe-judge@1", policyRevision: "p1", proposals: p });
    const n = state.semantic;
    const r3 = await continueCallerRound({ storeRoot: root, investigationRef: r2.investigationRef, expectedRevision: r2.handoff.revision, deps, judgeIdentity: "probe-judge@1", policyRevision: "p1", proposals: p });
    assert.equal(state.semantic, n, "identical proposal must not re-buy");
    assert.equal(r3.result.data.version, "2.4");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

// R3: assembled request > 256KiB must refuse dispatch and mark incomplete.
test("R3: oversized assembled semantic context refuses dispatch with explicit incomplete", async () => {
  const { state, deps } = judgeWorld();
  // 16 × ~16KiB = the full 256KiB representation allowance; framing/questions
  // push the ASSEMBLED request past the ceiling.
  const big = "v".repeat(16 * 1024 - 24);
  const reps = Array.from({ length: 16 }, (_, i) => ({ format: "text", content: `lead ${i} ${big}`, label: `r${i}` }));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fourroots-"));
  try {
    const r1 = await startCallerRound({ storeRoot: root, contract: CONTRACT, deps, judgeIdentity: "probe-judge@1", representations: reps });
    assert.equal(state.semantic, 0, "no semantic dispatch when assembled context exceeds ceiling");
    const gaps = r1.handoff.gaps.join("|");
    assert.ok(/context|incomplete|oversize/i.test(gaps) || r1.result.requirements.version.reason === "assessment_context_overflow",
      `expected explicit overflow disclosure, got gaps=${gaps} reason=${r1.result.requirements.version.reason}`);
    assert.notEqual(r1.handoff.stopReason, "work-fulfilled");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

// R4 (real): post-paid publication failure settles measured usage first.
test("R4: post-paid root-bound refusal settles measured attempts with explicit uncertainty, prior view intact", async () => {
  const { deps: originalDeps } = judgeWorld();
  const counts = { search: 0, read: 0, judge: 0, candidateJudge: 0 };
  const deps = { ...originalDeps };
  for (const name of Object.keys(counts)) deps[name] = async (...args) => {
    counts[name] += 1;
    return originalDeps[name](...args);
  };
  let before;
  const deltas = () => ({ searches: counts.search - before.search, reads: counts.read - before.read,
    judgments: counts.judge - before.judge + counts.candidateJudge - before.candidateJudge });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fourroots-"));
  try {
    let last;
    let refusal = null;
    const leads = (i) => Array.from({ length: 8 }, (_, k) => ({ url: `https://example.test/unread-${i}-${k}`, title: `lead ${i}-${k}` }));
    try {
      for (let i = 0; i < 40; i += 1) {
        before = { ...counts };
        const current = i === 0
          ? await startCallerRound({ storeRoot: root, contract: CONTRACT, deps, judgeIdentity: "probe-judge@1", policyRevision: "p1", leads: leads(i) })
          : await continueCallerRound({ storeRoot: root, investigationRef: last.investigationRef, expectedRevision: last.handoff.revision, deps, judgeIdentity: "probe-judge@1", policyRevision: "p1", leads: leads(i) });
        last = current;
      }
    } catch (e) {
      refusal = e;
    }
    assert.ok(refusal !== null, "expected a publication refusal before 40 rounds");
    assert.match(String(refusal?.message ?? ""), /exceeds|bound|16 ??384|Body exceeds/i, String(refusal?.message));
    assert.ok(last !== undefined, "no successful round before the refusal");
    const store = last.store;
    const insp = await store.inspect(last.investigationRef);
    // Prior committed view intact; the failed round settled with accounting.
    assert.ok(insp.committed !== null, "prior committed view lost");
    assert.ok(insp.incomplete !== null, "failed round left no incomplete marker");
    assert.equal(insp.incomplete.settled, true, "failed round not settled");
    const measured = deltas();
    const settlement = decodeBoundSettlement(JSON.parse(await fs.readFile(path.join(root, "investigations", last.investigationRef, "audit", `settlement-${insp.incomplete.roundId}.json`), "utf8")), insp.incomplete);
    console.log(JSON.stringify({ case: "F5-measured", root, refusal: String(refusal), lastRevision: last.handoff.revision,
      incomplete: insp.incomplete, measured, settlement }));
    assert.ok(measured.searches + measured.reads + measured.judgments > 0, "failed attempt must perform positive work");
    assert.equal(settlement.roundId, insp.incomplete.roundId);
    assert.deepEqual(settlement.summary.measured, measured);
    assert.equal(settlement.summary.status, "failed");
    assert.equal(settlement.summary.uncertainty, "definition-pointer-bound:measured-attempts-preserved");
    assert.equal(insp.committed.snapshot.revision, last.handoff.revision);
    assert.equal(insp.incomplete.revisionBase, last.handoff.revision);
    assert.deepEqual(insp.committed.snapshot.outcome.data, last.result.data);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    console.log(JSON.stringify({ cleanup: root, removed: true }));
  }
});

// R4b: no-judge overflow must still disclose the context bound.
test("R4b: no-judge oversized context discloses assessment_context_overflow, retains no-judge fact", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fourroots-"));
  try {
    const big = "v".repeat(16 * 1024 - 24);
    const deps = {
      now: Date.now,
      search: async () => [],
      read: async () => { throw new Error("no read"); },
      judge: null,
    };
    const r1 = await startCallerRound({ storeRoot: root, contract: CONTRACT, deps,
      representations: Array.from({ length: 16 }, (_, i) => ({ format: "text", content: `lead ${i} ${big}`, label: `r${i}` })) });
    assert.equal(r1.result.assessment, "deterministic-only");
    assert.equal(r1.result.usage.candidateJudgeCalls + r1.result.usage.judgeCalls, 0, "zero semantic with no judge");
    assert.equal(r1.result.requirements.version.reason, "assessment_context_overflow", `reason was ${r1.result.requirements.version.reason}`);
    assert.equal(r1.handoff.stopReason, "assessment-context-overflow");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

for (const semantic of [false, true]) test(`T4 retention after read settles actual usage in ${semantic ? 'ordinary' : 'deterministic'} acquisition`, async () => {
  let deps, storeOptions, armed = 0, fired = 0, enabled = true;
  let target, dir, marker, priorSnapshot, priorManifest, ref, outcome, caught;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'caller-retention-failure-'));
  try {
  const payload = 'Exact fetched body whose persistence fails.', bytes = Buffer.from(payload), hex = createHash('sha256').update(bytes).digest('hex');
  const primary = new Error('L6_EXACT_FETCHED_BODY_PERSISTENCE_REFUSED'), counts = { searches: 0, reads: 0, judgments: 0 }, signals = [];
  deps = {
    now: () => 0,
    search: async () => { counts.searches++; return []; },
    judge: semantic ? async () => { counts.judgments++; return { documents: [] }; } : null,
    read: async (url, options) => {
      counts.reads++; signals.push(options.signal); assert.equal(url, 'https://fixture.invalid/exact-retention');
      const refs = await fs.readdir(path.join(root, 'investigations')); assert.equal(refs.length, 1); ref = refs[0];
      dir = path.join(root, 'investigations', ref); marker = JSON.parse(await fs.readFile(path.join(dir, 'incomplete.json'), 'utf8'));
      assert.equal(marker.settled, false);
      const audit = JSON.parse(await fs.readFile(path.join(dir, 'audit', `round-${marker.roundId}.json`), 'utf8'));
      assert(audit.rows.some(row => row.kind === 'definition-ref'));
      assert.equal((await fs.stat(path.join(dir, 'reserve.settlement'))).size, SETTLEMENT_RESERVE_BYTES);
      priorSnapshot = await fs.readFile(path.join(dir, 'revisions', 'r0.json'));
      priorManifest = await fs.readFile(path.join(dir, 'store.json'));
      target = path.join(dir, 'bodies', `${hex}.bin`); armed++; return payload;
    },
  };
  storeOptions = { deps: { writeFileAtomic: async (file, content) => {
    const actual = Buffer.from(content);
    if (enabled && armed && file === target && actual.equals(bytes) && createHash('sha256').update(actual).digest('hex') === hex) { fired++; throw primary; }
    await atomicReplaceFile(file, content);
  } } };
  try { outcome = await startCallerRound({ storeRoot: root, contract: CONTRACT, deps, storeOptions, leads: [{ url: 'https://fixture.invalid/exact-retention' }] }); }
  catch (e) { caught = e; }
  assert.equal(caught, primary); assert.equal(armed, 1); assert.equal(fired, 1);
  assert.deepEqual(counts, { searches: 0, reads: 1, judgments: 0 }); assert(signals.every(s => s.aborted));
  const inspection = await openStore({ root }).inspect(ref);
  assert.equal(inspection.committed.snapshot.revision, 0);
  assert.equal(inspection.incomplete.settled, true, 'known dispatched work must settle even when retention rejected');
  const settlement = decodeBoundSettlement(JSON.parse(await fs.readFile(path.join(dir, 'audit', `settlement-${marker.roundId}.json`), 'utf8')), marker);
  assert.deepEqual(settlement.summary, { status: 'failed', measured: counts, uncertainty: 'engine-run-failed:measured-attempts-preserved' });
  await assert.rejects(fs.stat(path.join(dir, 'reserve.settlement')), e => e.code === 'ENOENT');
  await assert.rejects(fs.stat(target), e => e.code === 'ENOENT');
  assert(!inspection.committed.snapshot.bodies.some(b => b.bodyId === `b:${hex}`));
  assert.deepEqual(await fs.readFile(path.join(dir, 'revisions', 'r0.json')), priorSnapshot);
  assert.deepEqual(await fs.readFile(path.join(dir, 'store.json')), priorManifest);
  assert.equal(inspection.committed.snapshot.rounds.length, 0);
  } finally {
    enabled = false;
    try { await outcome?.handle.release(); } finally { await fs.rm(root, { recursive: true, force: true }); }
  }
});

test("C4 failed paid retention survives stale ACK and two later committed folds exactly once", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "caller-c4-"));
  const counts = { searches: 0, reads: 0, judgments: 0 }, primary = new Error("C4_EXACT_FETCHED_RETENTION_REFUSAL");
  const text = "Synthetic failed paid read", hex = createHash("sha256").update(text).digest("hex");
  let fail = false, fired = 0;
  const deps = { now: () => 0, judge: null, search: async () => { counts.searches++; return []; }, read: async () => { counts.reads++; return text; } };
  const storeOptions = { deps: { writeFileAtomic: async (file, bytes) => {
    if (fail && file.endsWith(`/bodies/${hex}.bin`) && Buffer.from(bytes).equals(Buffer.from(text))) { fired++; throw primary; }
    await atomicReplaceFile(file, bytes);
  } } };
  try {
    const first = await startCallerRound({ storeRoot: root, contract: CONTRACT, deps, storeOptions });
    const dir = path.join(root,"investigations",first.investigationRef), prior = await fs.readFile(path.join(dir,"revisions/r1.json"));
    fail = true;
    await assert.rejects(continueCallerRound({ storeRoot:root, investigationRef:first.investigationRef, expectedRevision:1, deps, storeOptions, leads:[{url:"https://fixture.invalid/c4"}] }), e => e === primary);
    assert.equal(fired,1); assert.equal(counts.reads,1);
    const inspection = await first.store.inspect(first.investigationRef);
    assert.equal(inspection.incomplete.settled,true); assert.equal(inspection.committed.snapshot.revision,1);
    await assert.rejects(fs.stat(path.join(dir,"reserve.settlement")),e=>e.code==="ENOENT");
    assert.deepEqual(await fs.readFile(path.join(dir,"revisions/r1.json")),prior);
    fail = false; const before = {...counts};
    await assert.rejects(continueCallerRound({ storeRoot:root, investigationRef:first.investigationRef, expectedRevision:0, acknowledgeInterruptedRound:true, deps, storeOptions }),e=>e.code==="EXPECTED_REVISION");
    assert.deepEqual(counts,before,"stale ACK must buy zero paid work");
    const sealedName = `ack-${createHash("sha256").update(JSON.stringify([inspection.incomplete.roundId,inspection.incomplete.ownerId,inspection.incomplete.revisionBase])).digest("hex")}.record`;
    const receipt = await fs.readFile(path.join(dir,"audit",sealedName));
    let current = first;
    for (let i=0;i<2;i++) {
      current=await continueCallerRound({storeRoot:root,investigationRef:first.investigationRef,expectedRevision:current.handoff.revision,deps,storeOptions});
      assert.equal(current.handoff.cumulativeUsage.reads,counts.reads,"failed paid read must be included once across both later folds");
      assert.equal(current.handoff.cumulativeUsage.searches,counts.searches);
      assert.equal(current.handoff.cumulativeUsage.rounds,current.handoff.revision+1);
      assert.equal(current.handoff.cumulativeUsage.complete.logical,true);
      assert.equal(current.handoff.cumulativeUsage.physicalAttempts,null);
      assert.deepEqual(await fs.readFile(path.join(dir,"audit",sealedName)),receipt);
      assert.equal((await first.store.inspect(first.investigationRef)).committed.snapshot.rounds.length,current.handoff.revision);
    }
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});

test("C5 completed native publication cleanup counts no extra episode and offline stays pinned", async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"caller-c5-")), unlink=fsp.unlink, primary=new Error("C5_POSTCOMMIT_MARKER_REFUSAL");
  const deps={now:()=>0,judge:null,search:async()=>[],read:async()=>{throw new Error("no read expected");}};
  let fired=0;
  const physical=()=>({schemaVersion:1,source:"handler-owned-native-ledger",cutoff:"locally-settled",stages:{acquisition:2,judge:null,producer:null},knownSubtotal:2,total:2,reservationsRefused:0,admission:{acquisition:"shared",judge:"not-configured",producer:"not-configured"},attempts:[]});
  try {
    fsp.unlink=async function(file,...args){if(String(file).startsWith(root+"/")&&String(file).endsWith("/incomplete.json")){fired++;throw primary;}return Reflect.apply(unlink,this,[file,...args]);};syncBuiltinESMExports();
    try { await assert.rejects(startCallerRound({storeRoot:root,contract:CONTRACT,deps,nativeObservation:physical}),e=>e===primary); }
    finally {fsp.unlink=unlink;syncBuiltinESMExports();}
    assert.equal(fired,1);
    const refs=await fs.readdir(path.join(root,"investigations"));assert.equal(refs.length,1);const ref=refs[0];
    const prior=await readCallerRecord(root,ref,1), projection=structuredClone(prior.payload.accounting);
    assert.equal(prior.snapshot.revision,1);assert.equal(projection.rounds,1);assert.equal(projection.physicalAttempts,2);
    const next=await continueCallerRound({storeRoot:root,investigationRef:ref,expectedRevision:1,acknowledgeInterruptedRound:true,deps,nativeObservation:physical});
    assert.equal(next.handoff.cumulativeUsage.rounds,2);assert.equal(next.handoff.cumulativeUsage.physicalAttempts,4);
    assert.deepEqual(next.handoff.cumulativeUsage.unknownStages,[]);assert.equal(next.handoff.cumulativeUsage.complete.physical,true);
    const old=await readCallerRecord(root,ref,1);assert.deepEqual(old.payload.accounting,projection);assert.equal(old.revision,1);
  } finally {fsp.unlink=unlink;syncBuiltinESMExports();await fs.rm(root,{recursive:true,force:true});}
});

test("C6 corrupt sealed recovery refuses caller continuation before paid work",async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"caller-c6-corrupt-"));let paid=0;
 const deps={now:()=>0,judge:null,search:async()=>{paid++;return[];},read:async()=>{paid++;return"synthetic";}};
 try{const first=await startCallerRound({storeRoot:root,contract:CONTRACT,deps});const h=await first.store.acquireOwnership(first.investigationRef),dir=h.dir;
 await h.beginRound({roundId:"corrupt-accounting",intent:"continue"});await h.settleRound("corrupt-accounting",{status:"failed",measured:{searches:0,reads:0,judgments:0},uncertainty:null},{bindInstance:true});const marker=JSON.parse(await fs.readFile(path.join(dir,"incomplete.json"),"utf8"));await h.release();const ack=await first.store.acknowledgeInterrupted(first.investigationRef);await ack.release();
 const name=`ack-${createHash("sha256").update(JSON.stringify([marker.roundId,marker.ownerId,marker.revisionBase])).digest("hex")}.record`,file=path.join(dir,"audit",name),bytes=await fs.readFile(file);bytes[2048]^=1;await fs.writeFile(file,bytes);
 const before=paid;await assert.rejects(continueCallerRound({storeRoot:root,investigationRef:first.investigationRef,expectedRevision:1,deps,leads:[{url:"https://fixture.invalid/no-paid"}]}),e=>e.code==="CORRUPT_RECORD");assert.equal(paid,before);const inspection=await first.store.inspect(first.investigationRef);assert.equal(inspection.committed.snapshot.revision,1);assert.equal(inspection.incomplete,null);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
