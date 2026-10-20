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
  Inspect/readEvidence/delete are offline and credential-free.
  maxChars defaults to 16384 (1024..65536; mutating header minimum 8192).
  Records: SCOUTLINE_INVESTIGATIONS_DIR or <config-root>/investigations.
`;
export async function readCallerRequest(source: {kind:"file";path:string}|{kind:"stdin"}|{kind:"inline";value:string},
  readStdin:(signal?:AbortSignal)=>Promise<string>, signal?:AbortSignal):Promise<unknown>{
  let text:string;
  if(source.kind==="inline")text=source.value;
  else if(source.kind==="file")text=await readRequirementsFileBounded(source.path,MAX_REQUIREMENTS_BYTES);
  else text=await readStdin(signal);
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
