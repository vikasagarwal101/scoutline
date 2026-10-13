import { createHash } from "node:crypto";
import { ValidationError } from "./errors.js";
import { redactSecrets } from "./redact.js";
import { openStore, ExpectedRevisionError, CorruptRecordError } from "./retained-record-store.js";
import { startCallerRound, continueCallerRound, readCallerRecord, type CallerProposal } from "./lean-caller-rounds.js";
import { compileLeanContract, type LeanDeps } from "./lean-investigation.js";
import { preflightRequirements } from "../commands/investigate-requirements.js";

const COLLECTIONS = ["evidence", "outcomes", "proposals", "assessments", "changes", "gaps", "rounds"] as const;
type Collection = typeof COLLECTIONS[number];
type Obj = Record<string, any>;
export interface CallerInvestigationOptions {
  storeRoot: string; deps?: LeanDeps; secrets?: readonly string[]; judgeIdentity?: string; policyRevision?: string;
  /** Internal handler adapter only; absent library instrumentation remains unknown. */
  nativeObservation?: () => import("./caller-physical.js").CallerPhysicalSnapshot;
}
const digest = (text: string): string => `sha256:${createHash("sha256").update(text).digest("hex")}`;
function object(v: unknown, keys: readonly string[], label: string): asserts v is Obj {
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).some(k => !keys.includes(k))) throw new ValidationError(`Invalid closed ${label} object.`);
}
function depth(v: unknown, n = 0): void {
  if (n > 16) throw new ValidationError("Caller input exceeds depth 16.");
  if (v && typeof v === "object") for (const x of Object.values(v)) depth(x, n + 1);
}
function string(v: unknown, label: string, cap = 16384): asserts v is string {
  if (typeof v !== "string" || !v || Buffer.byteLength(v) > cap) throw new ValidationError(`Invalid bounded ${label}.`);
}
function positive(v: unknown, label: string): asserts v is number {
  if (!Number.isSafeInteger(v) || (v as number) < 1) throw new ValidationError(`Invalid ${label}.`);
}
function range(v: unknown): asserts v is [number, number] {
  if (!Array.isArray(v) || v.length !== 2 || !v.every(Number.isSafeInteger) || v[0] < 0 || v[1] <= v[0]) throw new ValidationError("Invalid UTF-16 half-open range.");
}
export function validateCallerRequest(value: unknown): asserts value is Obj {
  depth(value);
  if (Buffer.byteLength(JSON.stringify(value) ?? "") > 1048576) throw new ValidationError("Caller input exceeds 1 MiB.");
  const v = value as Obj;
  const common = ["schemaVersion", "operation", "maxChars"];
  const mutation = ["requirements", "dataScope", "roundLimits", "representations", "leads"];
  const allowed: Record<string, string[]> = {
    start: [...common, ...mutation],
    continue: [...common, ...mutation, "investigationRef", "expectedRevision", "proposals", "acknowledgeInterruptedRound"],
    inspect: [...common, "investigationRef", "revision", "collection", "cursor"],
    readEvidence: [...common, "investigationRef", "revision", "representationId", "digest", "cursor", "range"],
    delete: ["schemaVersion", "operation", "investigationRef"],
  };
  object(v, allowed[v?.operation] ?? [], "caller request");
  if (v.schemaVersion !== 1 || !allowed[v.operation]) throw new ValidationError("Caller request requires schemaVersion 1 and a supported operation.");
  if (v.operation !== "start") string(v.investigationRef, "investigation reference", 128);
  if (v.maxChars !== undefined && (!Number.isSafeInteger(v.maxChars) || v.maxChars < 1024 || v.maxChars > 65536)) throw new ValidationError("maxChars must be an integer in 1024..65536.");
  // ponytail: fixed supported three-field header ceiling; recompute if the contract grows.
  if (["start", "continue"].includes(v.operation) && (v.maxChars ?? 16384) < 4096) throw new ValidationError("maxChars cannot fit the worst-case caller handoff header; minimum for mutating operations is 4096.");
  if (v.revision !== undefined) positive(v.revision, "historical revision");
  if (v.cursor !== undefined) string(v.cursor, "cursor", 2048);
  if (v.operation === "inspect" && v.collection !== undefined && !COLLECTIONS.includes(v.collection)) throw new ValidationError("Unknown inspection collection.");
  if (v.operation === "readEvidence") {
    string(v.representationId, "accessible representation ID", 80); string(v.digest, "representation digest", 80);
    if (v.range !== undefined) range(v.range);
    if (v.range !== undefined && v.cursor !== undefined) throw new ValidationError("Evidence range and cursor are mutually exclusive.");
  }
  if (!["start", "continue"].includes(v.operation)) return;
  if (!["public", "synthetic"].includes(v.dataScope)) throw new ValidationError("Explicit public or synthetic dataScope required; private inputs are unsupported.");
  if (v.operation === "continue") {
    positive(v.expectedRevision, "expectedRevision");
    if (v.acknowledgeInterruptedRound !== undefined && typeof v.acknowledgeInterruptedRound !== "boolean") throw new ValidationError("Invalid interrupted-round acknowledgment.");
  }
  if (v.operation === "start" || v.requirements !== undefined) { preflightRequirements(v.requirements); compileLeanContract(v.requirements); }
  if (v.roundLimits !== undefined) {
    object(v.roundLimits, ["maxSearchAttempts", "maxJudgeAttempts", "readBatchSize", "maxUniqueReads", "deadlineMs"], "round limits");
    for (const n of Object.values(v.roundLimits)) positive(n, "lower round limit");
  }
  for (const [key, cap] of [["leads", 32], ["representations", 16], ["proposals", 24]] as const) {
    if (v[key] !== undefined && (!Array.isArray(v[key]) || v[key].length > cap)) throw new ValidationError(`Invalid bounded ${key}.`);
  }
  for (const lead of v.leads ?? []) {
    object(lead, ["url", "title"], "URL lead"); string(lead.url, "URL", 8192);
    let u: URL; try { u = new URL(lead.url); } catch { throw new ValidationError("Invalid URL lead."); }
    if (!["https:", "http:"].includes(u.protocol) || u.username || u.password) throw new ValidationError("Invalid public URL lead.");
    if (lead.title !== undefined) string(lead.title, "lead title");
  }
  for (const rep of v.representations ?? []) {
    object(rep, ["format", "content", "label", "claimedSource"], "supplied representation");
    if (!["text", "markdown", "json"].includes(rep.format)) throw new ValidationError("Only text, Markdown and JSON representations are supported.");
    string(rep.content, "representation content");
    for (const k of ["label", "claimedSource"]) if (rep[k] !== undefined) string(rep[k], k);
  }
  for (const p of v.proposals ?? []) {
    object(p, ["requirementId", "definitionRevision", "mode", "value", "binding"], "proposal");
    string(p.requirementId, "requirement ID", 128); string(p.definitionRevision, "definition revision", 80); string(p.value, "proposed value");
    if (!["string", "classification"].includes(p.mode)) throw new ValidationError("Invalid proposal mode.");
    if (p.mode === "string" || p.binding !== undefined) {
      object(p.binding, ["representationId", "digest", "range", "quote"], "evidence binding");
      string(p.binding.representationId, "accessible representation ID", 80); string(p.binding.digest, "digest", 80); string(p.binding.quote, "quote"); range(p.binding.range);
    }
  }
}

function safe(value: unknown, secrets: readonly string[]): any { return redactSecrets(value, [...secrets]); }
function cursor(value: Obj): string { return Buffer.from(JSON.stringify(value)).toString("base64url"); }
function decode(text: string): Obj {
  try { const c = JSON.parse(Buffer.from(text, "base64url").toString()); object(c, ["v", "r", "h", "b", "c", "o", "d"], "cursor"); if (c.v !== 1) throw new ValidationError("Unsupported caller cursor version."); return c; }
  catch { throw new ValidationError("Invalid caller view cursor."); }
}
async function view(options: CallerInvestigationOptions, ref: string, revision?: number) {
  const record = await readCallerRecord(options.storeRoot, ref, revision);
  const secrets = options.secrets ?? [];
  const basis = digest(JSON.stringify([safe(record.payload, secrets), safe(record.history, secrets)]));
  const evidence = record.payload.result.evidence.map(e => {
    const originalDigest = digest(e.content), content = safe(e.content, secrets) as string;
    const displayedDigest = digest(content);
    return { ...safe({ ...e, content: undefined }, secrets), content,
      representationId: `d:${digest(JSON.stringify([originalDigest, displayedDigest, basis])).slice(7)}`,
      digest: displayedDigest, originalRepresentationId: `b:${originalDigest.slice(7)}`, originalDigest,
      displayRedacted: content !== e.content, originalByteLength: Buffer.byteLength(e.content), displayByteLength: Buffer.byteLength(content),
      redactionBasis: basis, locatorBasis: "accessible-display", locatorUnit: "utf16-code-units", locatorRange: "half-open" };
  });
  const result = record.payload.result;
  const collections: Record<Collection, unknown[]> = {
    evidence: evidence.map(({ content, ...e }) => ({ ...e, contentLength: content.length })),
    outcomes: Object.entries(result.requirements).map(([requirementId, outcome]) => ({ requirementId, outcome })),
    proposals: record.payload.proposals,
    assessments: [{ assessment: result.assessment, data: result.data, plan: result.plan, acquisitionLog: result.acquisitionLog, usage: result.usage, coverageNotes: result.coverageNotes, physical: record.payload.physical }],
    changes: [{ revision: record.revision, intent: record.intent, definitionRevision: digest(JSON.stringify(record.contract)), definitions: record.payload.definitions }],
    gaps: Object.entries(result.requirements).filter(([,r]) => r.status !== "satisfied").map(([requirementId,r]) => ({requirementId,reason:r.reason ?? "unresolved"})),
    rounds: record.history.map(h => ({...h, usage:record.snapshot.rounds[h.revision-1]?.usage, resultAccess:{operation:"inspect",revision:h.revision}})),
  };
  for (const c of COLLECTIONS) collections[c] = safe(collections[c], secrets);
  const id = digest(JSON.stringify([record.snapshot.revision, record.revision, basis, evidence.map(e => e.digest), collections]));
  const header = { kind: "caller-assisted-investigation", schemaVersion: 1, investigationRef: ref,
    revision: record.revision, committedRevision: record.snapshot.revision, viewId:id, redactionBasis:basis,
    round:{id:record.roundId,status:"settled",intent:record.intent}, status:result.status,stopReason:record.payload.stopReason,
    fulfillment:{satisfied:Object.values(result.requirements).filter(r=>r.status==="satisfied").length,total:Object.keys(result.requirements).length},
    definitions:safe(record.payload.definitions,secrets),
    usage:result.usage, ...(record.payload.physical ? {physical:record.payload.physical} : {}), cumulativeUsage:{rounds:record.snapshot.rounds.length,searches:record.snapshot.rounds.reduce((n,r)=>n+(r.usage?.searches??0),0),reads:record.snapshot.rounds.reduce((n,r)=>n+(r.usage?.reads??0),0),judgments:record.snapshot.rounds.reduce((n,r)=>n+(r.usage?.judgments??0),0),physicalAttempts:null,unknownStages:["acquisition","judge","producer"]},
    metadataIncomplete:true, contentIncomplete:evidence.length>0,
    counts:Object.fromEntries(COLLECTIONS.map(c=>[c,collections[c].length])),
    cursors:Object.fromEntries(COLLECTIONS.map(c=>[c,cursor({v:1,r:record.snapshot.revision,h:record.revision,b:basis,c,o:0})])),
  };
  return {record,evidence,collections,header,basis,id};
}
function bounded(value: Obj, maxChars: number): Obj {
  const resultSha256 = digest(JSON.stringify(value)); const output = {...value,resultSha256};
  if (JSON.stringify(output).length > maxChars) throw new ValidationError("maxChars cannot fit this caller page header.");
  return output;
}
function cut(text: string, start: number, size: number): string {
  let end=Math.min(text.length,start+size); if (end<text.length && /[\uD800-\uDBFF]/.test(text[end-1]!)) end--;
  return text.slice(start,end);
}
function page(base: Obj, text: string, offset: number, maxChars: number, next: (offset:number)=>string): Obj {
  if (!Number.isSafeInteger(offset) || offset<0 || offset>text.length) throw new ValidationError("Invalid cursor offset.");
  let low=0,high=text.length-offset,best:Obj|undefined;
  while(low<=high){const size=Math.floor((low+high)/2),content=cut(text,offset,size),end=offset+content.length;
    const candidate={...base,content,range:[offset,end],totalChars:text.length,contentIncomplete:end<text.length,cursor:end<text.length?next(end):null};
    if(JSON.stringify({...candidate,resultSha256:"sha256:"+"0".repeat(64)}).length<=maxChars){best=candidate;low=size+1;}else high=size-1;
  }
  if(!best || (!best.content && offset<text.length)) throw new ValidationError("maxChars cannot fit a progressing caller page.");
  return bounded(best,maxChars);
}
/** Five explicit operations over the approved round/store; no automatic producer or parser. */
export async function executeCallerInvestigation(request: unknown, options: CallerInvestigationOptions): Promise<Obj> {
  validateCallerRequest(request); const req=request as Obj; const maxChars=req.maxChars??16384;
  if(req.operation==="delete") {await openStore({root:options.storeRoot}).deleteInvestigation(req.investigationRef);return {kind:"caller-assisted-investigation",schemaVersion:1,investigationRef:req.investigationRef,deleted:true};}
  let ref=req.investigationRef;
  if(["start","continue"].includes(req.operation)){
    if(!options.deps) throw new ValidationError("Mutating caller operation requires explicit acquisition/judge runtime.");
    let proposals:CallerProposal[]=[];
    if(req.operation==="continue"){
      const old=await view(options,ref);
      if(old.record.snapshot.revision!==req.expectedRevision) throw new ExpectedRevisionError("Stale expected caller revision.");
      for(const p of req.proposals??[]){
        const item:CallerProposal={fieldId:p.requirementId,definitionRevision:p.definitionRevision,mode:p.mode,value:p.value};
        if(p.binding){const e=old.evidence.find(e=>e.representationId===p.binding.representationId&&e.digest===p.binding.digest);
          if(!e)throw new ValidationError("Accessible derivative unavailable or stale.");
          const [a,b]=p.binding.range,quote=p.binding.quote;
          if(e.content.slice(a,b)!==quote || quote.includes("[REDACTED]"))throw new ValidationError("Display quote/range does not bind unchanged evidence.");
          const original=old.record.payload.result.evidence.find(r=>r.evidenceId===e.evidenceId)!.content;
          const start=original.indexOf(quote);
          if(start<0 || original.indexOf(quote,start+1)!==-1)throw new ValidationError("Display quote has no unique original binding.");
          item.representationId=e.originalRepresentationId;item.digest=e.originalDigest;item.quote=quote;item.charRange=[start,start+quote.length];
        }proposals.push(item);
      }
    }
    const args={storeRoot:options.storeRoot,contract:req.requirements,deps:options.deps,dataScope:req.dataScope,leads:req.leads,representations:req.representations,roundLimits:req.roundLimits,judgeIdentity:options.judgeIdentity,policyRevision:options.policyRevision,nativeObservation:options.nativeObservation};
    const round=req.operation==="start"?await startCallerRound(args):await continueCallerRound({...args,investigationRef:ref,expectedRevision:req.expectedRevision,proposals,acknowledgeInterruptedRound:req.acknowledgeInterruptedRound});
    ref=round.investigationRef;
  }
  const v=await view(options,ref,req.revision);
  if(req.operation==="readEvidence"){
    const e=v.evidence.find(e=>e.representationId===req.representationId&&e.digest===req.digest);
    if(!e)throw new ValidationError("Accessible derivative unavailable; inspect the current redacted evidence manifest.");
    let offset=0;
    if(req.cursor){const c=decode(req.cursor);if(c.r!==v.record.snapshot.revision||c.h!==v.record.revision||c.b!==v.basis||c.d!==e.digest||c.c!==e.representationId)throw new ExpectedRevisionError("Stale or unavailable evidence cursor.");offset=c.o;}
    if(req.range){if(req.range[1]>e.content.length)throw new ValidationError("Evidence range exceeds accessible content.");for(const offset of req.range){if(offset>0&&offset<e.content.length&&/[\uD800-\uDBFF]/.test(e.content[offset-1]!)&&/[\uDC00-\uDFFF]/.test(e.content[offset]!))throw new ValidationError("Evidence range splits a surrogate-pair character.");}return bounded({kind:"caller-assisted-evidence",schemaVersion:1,investigationRef:ref,revision:v.record.revision,representationId:e.representationId,digest:e.digest,redactionBasis:v.basis,range:req.range,content:e.content.slice(...req.range),locatorUnit:"utf16-code-units",contentIncomplete:false},maxChars);}
    return page({kind:"caller-assisted-evidence",schemaVersion:1,investigationRef:ref,revision:v.record.revision,representationId:e.representationId,digest:e.digest,originalDigest:e.originalDigest,redactionBasis:v.basis,locatorUnit:"utf16-code-units"},e.content,offset,maxChars,o=>cursor({v:1,r:v.record.snapshot.revision,h:v.record.revision,b:v.basis,c:e.representationId,d:e.digest,o}));
  }
  if(req.operation==="inspect"&&(req.collection||req.cursor)){
    const c=req.cursor?decode(req.cursor):undefined;const collection:Collection=req.collection??c?.c;
    if(!COLLECTIONS.includes(collection)||c&&(c.r!==v.record.snapshot.revision||c.h!==v.record.revision||c.b!==v.basis||c.c!==collection))throw new ExpectedRevisionError("Stale or unavailable metadata cursor.");
    return page({kind:"caller-assisted-page",schemaVersion:1,investigationRef:ref,revision:v.record.revision,viewId:v.id,redactionBasis:v.basis,collection,count:v.collections[collection].length,encoding:"json-fragments",metadataIncomplete:true},JSON.stringify(v.collections[collection]),c?.o??0,maxChars,o=>cursor({v:1,r:v.record.snapshot.revision,h:v.record.revision,b:v.basis,c:collection,o}));
  }
  return bounded(v.header,maxChars);
}
