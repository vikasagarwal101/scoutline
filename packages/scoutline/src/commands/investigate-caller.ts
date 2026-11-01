import { ScoutlineError, ValidationError } from "../lib/errors.js";
import { executeCallerInvestigation, validateCallerRequest, validateCallerRequirementIds } from "../lib/caller-investigation.js";
import { readCallerRecord } from "../lib/lean-caller-rounds.js";
import { readRequirementsFileBounded, MAX_REQUIREMENTS_BYTES, withRequirementsRuntime, type InvestigateRequirementsDeps } from "./investigate-requirements.js";
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
  Inspect/readEvidence/delete are offline and credential-free.
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
export async function handleInvestigateCaller(request:unknown, storeRoot:string, deps:InvestigateRequirementsDeps,
  host:Parameters<typeof withRequirementsRuntime>[2]):Promise<CommandResult>{
  validateCallerRequest(request);const req=request as Record<string,any>;
  const secrets=[...(host.secrets??[])];
  if(host.env?.TYPESAFE_API_KEY&&!secrets.includes(host.env.TYPESAFE_API_KEY))secrets.push(host.env.TYPESAFE_API_KEY);
  if(!["start","continue"].includes(req.operation)){
    const data=await executeCallerInvestigation(request,{storeRoot,secrets});return {kind:"data",data,exitCode:0};
  }
  const contract=req.requirements??(await readCallerRecord(storeRoot,req.investigationRef)).baselineContract;
  validateCallerRequirementIds(contract);
  const runtime=await withRequirementsRuntime(contract,{...deps,onRuntimeSecrets:values=>{
    for(const value of values)if(value&&!secrets.includes(value))secrets.push(value);
    deps.onRuntimeSecrets?.(values);
  }},host,async (_contract,unified,nativeObservation)=>{
    let data: Awaited<ReturnType<typeof executeCallerInvestigation>>;
    try {
      data=await executeCallerInvestigation(request,{storeRoot,deps:unified,secrets,nativeObservation,
        judgeIdentity:host.env?.TYPESAFE_API_KEY?"direct-typesafe":"no-judge",policyRevision:"caller-v1"});
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
