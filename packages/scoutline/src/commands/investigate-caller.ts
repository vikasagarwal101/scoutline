import { createHash } from "node:crypto";
import { ScoutlineError, ValidationError } from "../lib/errors.js";
import { executeCallerInvestigation, validateCallerRequest, validateCallerRequirementIds } from "../lib/caller-investigation.js";
import { readCallerRecord } from "../lib/lean-caller-rounds.js";
import { readRequirementsFileBounded, MAX_REQUIREMENTS_BYTES, withRequirementsRuntime, type InvestigateRequirementsDeps } from "./investigate-requirements.js";
import { collectJudgeSecrets, type JudgeDescriptor } from "../lib/judge-config.js";
import type { CommandResult } from "../command-invocation.js";

export const INVESTIGATE_CALLER_HELP = `
EXPERIMENTAL caller-assisted operations:
  --caller-request <file|->        Versioned operation JSON from file/stdin
  --caller-request-json '<json>'   Inline versioned operation JSON
  schemaVersion:1; operation:start|continue|inspect|readEvidence|delete.
  Start/continue require explicit public/synthetic dataScope; no automatic extractor.
  Start IDs: [A-Za-z0-9_-]{1,64}; continuation IDs remain bounded to 128 UTF-8 bytes.
  Unsafe recovery profiles refuse before work. A committed-view error carries
  an inspect selector in JSON help; do not repeat the mutation.
  Start/continue use the shared judge selection. Inspect/readEvidence/delete
  are offline and credential-free but read local config for redaction; an
  unsafe, corrupt or unreadable basis refuses before deletion.
  maxChars defaults to 16384 (1024..65536; mutating header minimum 8192).
  Records: SCOUTLINE_INVESTIGATIONS_DIR or <config-root>/investigations.
`;
/** Selected owned cancellation; a later abort must not replace a file error. */
export class CallerInputInterruptedError extends ValidationError {
  constructor() { super("Caller operation interrupted before record creation."); Object.assign(this,{exitCode:130}); }
}
function raceCallerInput(work:()=>Promise<string>,signal?:AbortSignal):Promise<string> {
  return new Promise((resolve,reject)=>{
    let selected=false;
    const finish=(complete:(value:any)=>void,value:unknown):void=>{
      if(selected)return;selected=true;signal?.removeEventListener("abort",onAbort);complete(value);
    };
    const onAbort=():void=>finish(reject,new CallerInputInterruptedError());
    signal?.addEventListener("abort",onAbort,{once:true});
    if(signal?.aborted){onAbort();return;}
    // Start lazily after listener registration. Both late outcomes remain observed.
    try { Promise.resolve(work()).then(value=>finish(resolve,value),error=>finish(reject,error)); }
    catch(error) { finish(reject,error); }
  });
}
export async function readCallerRequest(source: {kind:"file";path:string}|{kind:"stdin"}|{kind:"inline";value:string},
  readStdin:(signal?:AbortSignal)=>Promise<string>, signal?:AbortSignal):Promise<unknown>{
  const text=await raceCallerInput(()=>source.kind==="inline"?Promise.resolve(source.value)
    :source.kind==="file"?readRequirementsFileBounded(source.path,MAX_REQUIREMENTS_BYTES):readStdin(signal),signal);
  if(Buffer.byteLength(text)>MAX_REQUIREMENTS_BYTES)throw new ValidationError("Caller input exceeds 1 MiB.");
  let request:unknown;try{request=JSON.parse(text);}catch{throw new ValidationError("Caller request is not valid JSON.");}
  validateCallerRequest(request);return request;
}
/** Bounded non-secret digest of the selected native judge's canonical
 *  descriptor fields. No key, no credential fingerprint and no request
 *  content enters the hash — only the explicit route/policy identity. */
function sha256Hex(value:string):string{return createHash("sha256").update(value,"utf8").digest("hex");}

/**
 * The caller's semantic identity for one round.
 *
 *   - a TRUSTED descriptor (produced by the profile factory that
 *     actually constructed the native judge) yields the bounded native
 *     hashes. A route, model, expected-resolved-model or policy change
 *     changes the hash, so a retained acceptance can never suppress a
 *     required rejudgment;
 *   - NO descriptor while a semantic collaborator IS present stays
 *     UNKNOWN (no identity at all): an opaque injected judge is never
 *     certified as native, and a credential's presence never derives an
 *     identity. EITHER collaborator counts — a runtime that carries only a
 *     candidate judge is still a semantic runtime;
 *   - no descriptor and no collaborator is the no-judge case.
 */
function callerJudgeIdentity(descriptor:JudgeDescriptor|undefined, hasSemanticCollaborator:boolean):{
  judgeIdentity?:string;policyRevision?:string;
}{
  if(descriptor!==undefined){
    const identityFields=JSON.stringify([
      descriptor.route,
      descriptor.endpoint,
      descriptor.requestedModel,
      descriptor.expectedResolvedModel,
      descriptor.questionRevision,
      descriptor.thresholdRevision,
      descriptor.uncertaintyRevision,
      descriptor.maxAttempts,
      descriptor.allowFallbacks,
    ]);
    const policyFields=JSON.stringify([
      descriptor.questionRevision,
      descriptor.thresholdRevision,
      descriptor.uncertaintyRevision,
      descriptor.maxAttempts,
      descriptor.allowFallbacks,
    ]);
    return {judgeIdentity:`native-jev:${sha256Hex(identityFields)}`,policyRevision:`native-jev-policy-v1:${sha256Hex(policyFields)}`};
  }
  if(hasSemanticCollaborator)return {};
  return {judgeIdentity:"no-judge",policyRevision:"caller-v1"};
}

export async function handleInvestigateCaller(request:unknown, storeRoot:string, deps:InvestigateRequirementsDeps,
  host:Parameters<typeof withRequirementsRuntime>[2]):Promise<CommandResult>{
  validateCallerRequest(request);const req=request as Record<string,any>;
  // Redaction basis (F5): the invocation's own secret list UNION the
  // COMPLETE judge-secret union — both routes' env keys AND both stored
  // route keys, including an inactive or overridden one. A credential
  // that is not the selected route's is still a credential.
  const secrets=[...(host.secrets??[])];
  for(const value of collectJudgeSecrets(host.env??{},host.judgeSettings??{})){
    if(value&&!secrets.includes(value))secrets.push(value);
  }
  if(!["start","continue"].includes(req.operation)){
    const data=await executeCallerInvestigation(request,{storeRoot,secrets});return {kind:"data",data,exitCode:0};
  }
  const contract=req.requirements??(await readCallerRecord(storeRoot,req.investigationRef)).baselineContract;
  validateCallerRequirementIds(contract);
  const runtime=await withRequirementsRuntime(contract,{...deps,onRuntimeSecrets:values=>{
    for(const value of values)if(value&&!secrets.includes(value))secrets.push(value);
    deps.onRuntimeSecrets?.(values);
  }},host,async (_contract,unified,nativeObservation,judgeDescriptor)=>{
    let data: Awaited<ReturnType<typeof executeCallerInvestigation>>;
    try {
      const identity=callerJudgeIdentity(judgeDescriptor,unified.judge!==null||unified.candidateJudge!==null);
      data=await executeCallerInvestigation(request,{storeRoot,deps:unified,secrets,nativeObservation,
        ...identity});
    } catch(error) {
      if(unified.externalSignal?.aborted && error instanceof ValidationError && error.code==="VALIDATION_ERROR" && error.message==="Round cancelled before dispatch.") {
        throw new ScoutlineError(error.message,error.code,{statusCode:error.statusCode,help:error.help,
          retryable:error.retryable,retryAfterMs:error.retryAfterMs,exitCode:130});
      }
      throw error;
    }
    const retained=await readCallerRecord(storeRoot,data.investigationRef);
    return {result:retained.payload.result,value:data};
  });
  return {kind:"data",data:runtime.value,exitCode:runtime.value.stopReason==="cancelled"?130:runtime.value.status==="complete"?0:1};
}
