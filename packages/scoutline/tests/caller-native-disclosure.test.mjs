import test from 'node:test';
import assert from 'node:assert/strict';
import {sandbox,bin,contract,output,noHTTP,api} from './helpers/caller-review-harness.mjs';
const request={schemaVersion:1,operation:'start',dataScope:'synthetic',requirements:{...contract,requirements:{csv:contract.requirements.csv}}};
// Two independently required enum fields: no dependency between them, so
// each one demands its own semantic judgment.
const twoFieldRequest={schemaVersion:1,operation:'start',dataScope:'synthetic',requirements:{schemaVersion:1,question:contract.question,scope:contract.scope,requirements:{csv:contract.requirements.csv,license:{question:'Is the release licensed under MIT?',schema:{enum:['supported','refuted','disputed']}}}}};
/**
 * The FIXED expected fixture for the two-field last-slot stimulus. These
 * are LITERAL expected values, never derived from an observed array
 * length: one search + one extract + exactly one native judge = three
 * physical dispatches.
 */
const FIXTURE={acquisition:2,judge:1,producer:0,total:3,knownSubtotal:3};
/**
 * The exact native refusal reason the engine records when the SECOND
 * required classification is refused by the shared pre-dispatch native
 * admission. This is the genuine native boundary witness: the native
 * lifecycle threw TYPESAFE_ATTEMPT_REFUSED BEFORE any HTTP, and the
 * engine persisted that exact reason against the second requirement.
 */
const NATIVE_REFUSAL_REASON='enum_judge_failed:TYPESAFE_ATTEMPT_REFUSED';
/**
 * The two public native routes under test, with their exact endpoints and
 * their metadata-backed requested/resolved model pairs. The direct route
 * is the harness default; the OpenRouter route overrides it with its own
 * synthetic key, route and consent.
 */
const ROUTES={
  direct:{endpoint:'https://api.typesafe.ai/v1/systemone',requestedModel:'jev-1.13.0',resolvedModel:'jev-1.13.0',env:{SCOUTLINE_JUDGE:'typesafe',TYPESAFE_API_KEY:'synthetic-direct-key',SCOUTLINE_JUDGE_TRANSMIT:'1'}},
  openrouter:{endpoint:'https://openrouter.ai/api/v1/systemone',requestedModel:'typesafe/jev-1.14',resolvedModel:'typesafe/jev-1.14-20261014',env:{SCOUTLINE_JUDGE:'openrouter',OPENROUTER_API_KEY:'synthetic-openrouter-key',SCOUTLINE_JUDGE_TRANSMIT:'1'}},
};
function measured(p,events,route) {
  const dispatches=events.filter(e=>e.url);
  const acquisition=dispatches.filter(e=>e.url.startsWith('https://api.tavily.com/')).length;
  const judge=dispatches.filter(e=>e.url===route.endpoint).length;
  assert.equal(p.schemaVersion,1);
  assert.equal(p.source,'handler-owned-native-ledger');
  assert.equal(p.cutoff,'locally-settled');
  assert.equal(p.stages.acquisition,acquisition);
  assert.equal(p.stages.judge,judge);
  assert.equal(p.stages.producer,0,'absent production extractor has no dispatch');
  assert.equal(p.knownSubtotal,dispatches.length);
  assert.equal(p.total,dispatches.length);
  assert.equal(p.admission.acquisition,'shared');
  assert.equal(p.admission.judge,'shared');
  assert.equal(p.admission.producer,'not-configured');
}
async function saved(state,h) {
  const r=await bin(state,{schemaVersion:1,operation:'inspect',investigationRef:h.investigationRef},{env:{REVIEW_REFUSE_HTTP:'1'}});
  assert.equal(r.code,0,r.stderr);noHTTP(r);
  return output(r);
}
/**
 * The persisted per-requirement outcomes of the ACTUAL retained record,
 * read back through the public caller result path. Each outcome carries
 * that field's real attemptedRecords.
 */
async function persistedOutcomes(state,h) {
  const {executeCallerInvestigation}=await api();
  const page=await executeCallerInvestigation(
    {schemaVersion:1,operation:'inspect',investigationRef:h.investigationRef,collection:'outcomes'},
    {storeRoot:state.env.SCOUTLINE_INVESTIGATIONS_DIR,secrets:[]});
  const rows=JSON.parse(page.content);
  return Object.fromEntries(rows.map(r=>[r.requirementId,r.outcome]));
}
test('N01 production native observed dispatches equal persisted cross-process physical snapshot',async()=>{
  const state=await sandbox();
  const r=await bin(state,request);
  const h=output(r);
  assert.ok(r.events.some(e=>e.url==='https://api.typesafe.ai/v1/systemone'));
  measured(h.physical,r.events,ROUTES.direct);
  assert.equal(h.physical.reservationsRefused,0);
  const inspected=await saved(state,h);
  assert.deepEqual(inspected.physical,h.physical,'offline inspect preserves exact measured snapshot');
  assert.equal(inspected.resultSha256,h.resultSha256,'unchanged view hashes exact stored projection');
});
for(const [name,route] of Object.entries(ROUTES)){
  test(`N02 ${name}: two independently required judgments share the last slot — the second is refused by the NATIVE admission`,async()=>{
    // MIGRATION (dual-route Jev): the public native policy is ONE attempt
    // and ZERO retries, so the old "the native profile retried" stimulus
    // is gone. The stimulus is now two INDEPENDENTLY REQUIRED logical
    // semantic invocations (two enum fields, no dependency between them)
    // contending for the last physical slot of a ceiling that fits the
    // acquisition plus exactly one judge request.
    //
    // FIXED expected fixture outcome (never derived from the observed
    // array length): 1 search + 1 extract + 1 native judge = 3 dispatches;
    // the second required judgment is refused by the shared pre-dispatch
    // admission and therefore produces ZERO native dispatch.
    //
    // The oracle is the ACTUAL PERSISTED NATIVE REFUSAL of the second
    // requirement — not a generic acquisition refusal, not a logical
    // judge-call count, not a partial status, and not the aggregate
    // reservationsRefused total. The native lifecycle refused the second
    // classification BEFORE any HTTP, and the engine recorded that exact
    // reason, untrusted, with no accepted assessment.
    const state=await sandbox();
    const r=await bin(state,twoFieldRequest,{env:{SCOUTLINE_REQUIREMENTS_MAX_PHYSICAL:'3',...route.env}});
    const h=output(r);
    const dispatches=r.events.filter(e=>e.url);
    const native=dispatches.filter(e=>e.url===route.endpoint);
    const acquisition=dispatches.filter(e=>e.url.startsWith('https://api.tavily.com/'));
    const outcomes=await persistedOutcomes(state,h);
    // ONE labeled JSON witness, emitted BEFORE the first throwing
    // assertion. It carries the actual events/wire, the physical snapshot,
    // the per-field attempted reasons/trust and the public status — and
    // NO credential or auth bytes.
    const witness={
      label:'N02-NATIVE-LAST-SLOT-WITNESS',
      route:name,
      endpoint:route.endpoint,
      dispatches:dispatches.map(e=>({url:e.url,method:e.method})),
      nativeDispatchCount:native.length,
      acquisitionDispatchCount:acquisition.length,
      nativeWire:native.length>0,
      physical:h.physical,
      publicStatus:{status:h.status,stopReason:h.stopReason,fulfillment:h.fulfillment},
      fields:Object.fromEntries(Object.entries(outcomes).map(([id,o])=>[id,{
        status:o.status,
        reason:o.reason,
        judgmentCount:o.judgmentCount,
        attempted:o.attemptedRecords.map(a=>({
          trusted:a.trusted,
          reason:a.reason,
          assessmentCount:Array.isArray(a.assessments)?a.assessments.length:null,
          requestedModel:a.metadata?.requestedModel,
          resolvedModel:a.metadata?.resolvedModel,
        })),
      }])),
    };
    process.stderr.write(`${JSON.stringify(witness)}\n`);
    // --- the fixed physical fixture ---
    assert.equal(dispatches.length,FIXTURE.total,'exactly three physical dispatches');
    assert.equal(native.length,FIXTURE.judge,'exactly one native judge dispatch');
    assert.equal(acquisition.length,FIXTURE.acquisition,'exactly two acquisition dispatches');
    measured(h.physical,r.events,route);
    assert.equal(h.physical.stages.acquisition,FIXTURE.acquisition);
    assert.equal(h.physical.stages.judge,FIXTURE.judge);
    assert.equal(h.physical.stages.producer,FIXTURE.producer);
    assert.equal(h.physical.knownSubtotal,FIXTURE.knownSubtotal);
    assert.equal(h.physical.total,FIXTURE.total);
    // --- the exact selected native endpoint, method and model pair ---
    assert.equal(native[0].method,'POST','the native route is a POST');
    const nativeWire=r.events.filter(e=>e.event==='native-context');
    assert.equal(nativeWire.length,1,'exactly one native context was actually sent');
    assert.ok(nativeWire[0].requestBytes>0,'the native wire carried a nonempty request body');
    assert.equal(nativeWire[0].requestedModel,route.requestedModel,'the exact requested model was dispatched');
    assert.equal(nativeWire[0].resolvedModel,route.resolvedModel,'the exact expected resolved model came back');
    // --- the ACTUAL PERSISTED native refusal of the SECOND requirement ---
    const second=outcomes.license;
    assert.ok(second,'the second requirement has a persisted outcome');
    const refusals=second.attemptedRecords.filter(a=>a.reason===NATIVE_REFUSAL_REASON);
    assert.equal(refusals.length,1,'the second requirement records exactly one native refusal');
    assert.equal(refusals[0].trusted,false,'the refused native attempt is untrusted');
    assert.deepEqual(refusals[0].assessments,[],'the refused native attempt carries no assessment');
    assert.equal(second.status,'unresolved','the refused requirement is not satisfied');
    assert.deepEqual(second.assessments,[],'the refused requirement has no accepted assessment');
    // --- the FIRST native invocation kept its positive, trusted record ---
    const first=outcomes.csv;
    assert.ok(first,'the first requirement has a persisted outcome');
    const trustedFirst=first.attemptedRecords.filter(a=>a.trusted===true);
    assert.equal(trustedFirst.length,1,'the first native invocation has a trusted attempted record');
    assert.equal(trustedFirst[0].assessments.length,1,'the trusted record carries its actual assessment');
    assert.equal(trustedFirst[0].metadata.requestedModel,route.requestedModel,'the persisted attempt carries the exact requested model');
    assert.equal(trustedFirst[0].metadata.resolvedModel,route.resolvedModel,'the persisted attempt carries the exact resolved model');
    // --- no cross-route fallback ---
    const other=name==='direct'?ROUTES.openrouter.endpoint:ROUTES.direct.endpoint;
    assert.equal(dispatches.filter(e=>e.url===other).length,0,'no cross-route native request followed');
    // --- the persisted cross-process snapshot is the same bounded known state ---
    assert.deepEqual((await saved(state,h)).physical,h.physical,'the persisted cross-process snapshot is the same bounded known state');
  });
}
test('N03 native cancellation freezes exact abort observations and retains inspectable record',async()=>{
  const state=await sandbox();
  const r=await bin(state,request,{signalEvent:'api.typesafe.ai',env:{REVIEW_HANG_JUDGE:'1'}});
  assert.equal(r.code,130,r.stderr);assert.equal(r.signal,null);
  const h=JSON.parse(r.stdout||r.stderr);
  assert.ok(h.investigationRef,'only actually created record referenced');
  assert.equal(h.stopReason,'cancelled');
  const abort=r.events.findIndex(e=>e.event==='native-abort');assert.ok(abort>=0);
  assert.equal(r.events.slice(abort+1).filter(e=>e.url).length,0);
  measured(h.physical,r.events,ROUTES.direct);
  assert.deepEqual((await saved(state,h)).physical,h.physical,'postabort snapshot cannot change during offline inspect');
});
test('N04 deps-only library has unknown physical telemetry, never inferred native certificate',async()=>{
  const state=await sandbox();
  const {executeCallerInvestigation}=await api();
  const h=await executeCallerInvestigation(request,{storeRoot:state.env.SCOUTLINE_INVESTIGATIONS_DIR,deps:{search:async()=>[],read:async()=>{throw new Error('no source');},judge:null,now:()=>Date.now()}});
  assert.equal(h.physical,undefined);
  assert.equal(h.cumulativeUsage.physicalAttempts,null);
  assert.ok(h.cumulativeUsage.unknownStages.length>0);
});
