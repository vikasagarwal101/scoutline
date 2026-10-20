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
/** Public proposal keys must remain addressable; lower and historical contracts are unchanged. */
export function validateCallerRequirementIds(requirements: unknown): void {
  const fields = (requirements as Obj)?.requirements;
  if (fields && typeof fields === "object") for (const id of Object.keys(fields)) {
    if (Buffer.byteLength(id) > 128) throw new ValidationError("Public requirement IDs exceed 128 UTF-8 bytes; supply a compatible full replacement requirements document.");
  }
}
export function validateCallerRequest(value: unknown): asserts value is Obj {
  depth(value);
  if (Buffer.byteLength(JSON.stringify(value) ?? "") > 1048576) throw new ValidationError("Caller input exceeds 1 MiB.");
  const v = value as Obj;
  const common = ["schemaVersion", "operation", "maxChars"];
  const mutation = ["requirements", "dataScope", "roundLimits", "representations", "leads"];
  // Own-property operation map: a prototype-named operation ("toString",
  // "constructor", "__proto__") must fall through to the typed unsupported-
  // operation rejection, never read inherited values as key arrays.
  const allowed = new Map<string, string[]>([
    ["start", [...common, ...mutation]],
    ["continue", [...common, ...mutation, "investigationRef", "expectedRevision", "proposals", "acknowledgeInterruptedRound"]],
    ["inspect", [...common, "investigationRef", "revision", "collection", "cursor"]],
    ["readEvidence", [...common, "investigationRef", "revision", "representationId", "digest", "evidenceId", "cursor", "range"]],
    ["delete", ["schemaVersion", "operation", "investigationRef"]],
  ]);
  object(v, allowed.get(v?.operation as string) ?? [], "caller request");
  if (v.schemaVersion !== 1 || !allowed.has(v.operation as string)) throw new ValidationError("Caller request requires schemaVersion 1 and a supported operation.");
  if (v.operation !== "start") string(v.investigationRef, "investigation reference", 128);
  if (v.maxChars !== undefined && (!Number.isSafeInteger(v.maxChars) || v.maxChars < 1024 || v.maxChars > 65536)) throw new ValidationError("maxChars must be an integer in 1024..65536.");
  // The fixed bounded header pages full definitions, raw usage and stop detail.
  if (["start", "continue"].includes(v.operation) && (v.maxChars ?? 16384) < 8192) throw new ValidationError("maxChars cannot fit the worst-case caller handoff header; minimum for mutating operations is 8192.");
  if (v.revision !== undefined) positive(v.revision, "historical revision");
  if (v.cursor !== undefined) string(v.cursor, "cursor", 2048);
  if (v.operation === "inspect" && v.collection !== undefined && !COLLECTIONS.includes(v.collection)) throw new ValidationError("Unknown inspection collection.");
  if (v.operation === "readEvidence") {
    string(v.representationId, "accessible representation ID", 80); string(v.digest, "representation digest", 80);
    if (v.evidenceId !== undefined) string(v.evidenceId, "evidence event ID", 128);
    if (v.range !== undefined) range(v.range);
    if (v.range !== undefined && v.cursor !== undefined) throw new ValidationError("Evidence range and cursor are mutually exclusive.");
  }
  if (!["start", "continue"].includes(v.operation)) return;
  if (!["public", "synthetic"].includes(v.dataScope)) throw new ValidationError("Explicit public or synthetic dataScope required; private inputs are unsupported.");
  if (v.operation === "continue") {
    positive(v.expectedRevision, "expectedRevision");
    if (v.acknowledgeInterruptedRound !== undefined && typeof v.acknowledgeInterruptedRound !== "boolean") throw new ValidationError("Invalid interrupted-round acknowledgment.");
  }
  if (v.operation === "start" || v.requirements !== undefined) { preflightRequirements(v.requirements); compileLeanContract(v.requirements); validateCallerRequirementIds(v.requirements); }
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
      object(p.binding, ["representationId", "digest", "evidenceId", "range", "quote"], "evidence binding");
      if (p.binding.evidenceId !== undefined) string(p.binding.evidenceId, "evidence event ID", 128);
      string(p.binding.representationId, "accessible representation ID", 80); string(p.binding.digest, "digest", 80); string(p.binding.quote, "quote"); range(p.binding.range);
    }
  }
}

function safe(value: unknown, secrets: readonly string[]): any { return redactSecrets(value, [...secrets]); }
function validateDisplayInterval(display: string, original: string, a: number, b: number, secrets: readonly string[]): void {
  const marker = "[REDACTED]";
  // Literal markers are indistinguishable from replacements: conservatively taint both.
  for (let at = display.indexOf(marker); at !== -1; at = display.indexOf(marker, at + 1)) {
    if (a < at + marker.length && b > at) throw new ValidationError("Display quote/range does not bind unchanged evidence.");
  }
  if (display === original) return;
  for (const secret of secrets) {
    if (typeof secret !== "string" || secret.length === 0 || secret.trim().length === 0) continue;
    let overlaps = marker.includes(secret) || secret.includes(marker);
    for (let n = 1; !overlaps && n <= Math.min(marker.length, secret.length); n++) {
      overlaps = secret.endsWith(marker.slice(0, n)) || secret.startsWith(marker.slice(-n));
    }
    if (overlaps) throw new ValidationError("Display binding unavailable under the active redaction profile.");
  }
}
function unavailableView(): never {
  throw new ValidationError("Caller view unavailable under the active redaction profile.");
}
function requireVisibleIdentity(value: string, secrets: readonly string[]): void {
  if (safe(value, secrets) !== value) unavailableView();
}
function validateDefinitionIdentities(contract: unknown, secrets: readonly string[]): void {
  const requirements = (contract as Obj)?.requirements;
  if (requirements && typeof requirements === "object") for (const [id, field] of Object.entries(requirements)) {
    requireVisibleIdentity(id, secrets);
    for (const dependency of (field as Obj).dependsOn ?? []) requireVisibleIdentity(dependency, secrets);
  }
}
function projectContract(contract: unknown, secrets: readonly string[]): unknown {
  return Object.fromEntries(Object.entries(contract as Obj).map(([key, value]) => [key, key === "requirements"
    ? Object.fromEntries(Object.entries(value as Obj).map(([id, field]) => [id, safe(field, secrets)]))
    : safe(value, secrets)]));
}
function stablePage(value: Obj, secrets: readonly string[]): Obj {
  // Validate the completed page, including fragment context and computed digest. Never rewrite it.
  if (JSON.stringify(safe(value, secrets)) !== JSON.stringify(value)) unavailableView();
  return value;
}
function cursor(value: Obj): string { return Buffer.from(JSON.stringify(value)).toString("base64url"); }
function decode(text: string): Obj {
  try { const c = JSON.parse(Buffer.from(text, "base64url").toString()); object(c, ["v", "r", "h", "b", "c", "o", "d", "e"], "cursor"); if (c.v !== 1) throw new ValidationError("Unsupported caller cursor version."); return c; }
  catch { throw new ValidationError("Invalid caller view cursor."); }
}
function selectEvidence(evidence: Obj[], representationId: string, digest: string, evidenceId?: string): Obj {
  const matches = evidence.filter(e => e.representationId === representationId && e.digest === digest);
  const selected = evidenceId === undefined ? matches : matches.filter(e => e.evidenceId === evidenceId);
  if (selected.length !== 1) throw new ValidationError(matches.length > 1 && evidenceId === undefined
    ? "Ambiguous accessible representation; supply the exact evidenceId."
    : "Accessible derivative or evidence event unavailable or stale.");
  return selected[0]!;
}
async function view(options: CallerInvestigationOptions, ref: string, revision?: number) {
  const record = await readCallerRecord(options.storeRoot, ref, revision);
  const secrets = options.secrets ?? [];
  validateDefinitionIdentities(record.contract,secrets);
  if (Object.hasOwn(record,"baselineContract")) validateDefinitionIdentities(record.baselineContract,secrets);
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
  const usageKeys = ["searches","readAttempts","readsRetained","judgeCalls","extractorCalls","extractorCacheHits","candidateJudgeCalls"] as const;
  const usage = Object.fromEntries(usageKeys.map(k => [k, Number.isSafeInteger(result.usage[k]) && result.usage[k] >= 0 ? result.usage[k] : null]));
  const usageIncomplete = Object.values(usage).some(v => v === null) || Object.keys(result.usage).some(k => !usageKeys.includes(k as typeof usageKeys[number]));
  const stopLabels = ["cancelled","work-fulfilled","awaiting-caller-proposal","assessment-context-overflow","no-judge-evidence-retained","round-limit"];
  const stopReasonIncomplete = !stopLabels.includes(record.payload.stopReason);
  const stopReason = stopReasonIncomplete ? "unrecognized-retained-stop" : record.payload.stopReason;
  let definitionBlock: Obj = { contract: record.contract, definitions: record.payload.definitions,
    ...(Object.hasOwn(record,"baselineContract") ? { baselineContract: record.baselineContract } : {}) };
  const collections: Record<Collection, unknown[]> = {
    evidence: evidence.map(({ content, ...e }) => ({ ...e, contentLength: content.length })),
    outcomes: Object.entries(result.requirements).map(([requirementId, outcome]) => ({ requirementId, outcome })),
    proposals: record.payload.proposals,
    assessments: [{ assessment: result.assessment, data: result.data, plan: result.plan, acquisitionLog: result.acquisitionLog, usage: result.usage, stopReason: record.payload.stopReason, coverageNotes: result.coverageNotes, physical: record.payload.physical }],
    changes: [{ revision: record.revision, intent: record.intent, ...definitionBlock }],
    gaps: Object.entries(result.requirements).filter(([,r]) => r.status !== "satisfied").map(([requirementId,r]) => ({requirementId,reason:r.reason ?? "unresolved"})),
    rounds: record.history.map(h => ({...h, usage:record.snapshot.rounds[h.revision-1]?.usage, resultAccess:{operation:"inspect",revision:h.revision}})),
  };
  for (const c of COLLECTIONS) {
    if (c === "changes") {
      definitionBlock = { contract: projectContract(record.contract,secrets),
        definitions: Object.fromEntries(Object.entries(record.payload.definitions).map(([id, proof]) => [id,safe(proof,secrets)])),
        ...(Object.hasOwn(record,"baselineContract") ? {baselineContract:projectContract(record.baselineContract,secrets)} : {}) };
      collections[c] = [{...safe({revision:record.revision,intent:record.intent},secrets),...definitionBlock}];
    } else collections[c] = safe(collections[c], secrets);
  }
  const id = digest(JSON.stringify([record.snapshot.revision, record.revision, basis, evidence.map(e => e.digest), collections]));
  const header = { kind: "caller-assisted-investigation", schemaVersion: 2, investigationRef: ref,
    revision: record.revision, committedRevision: record.snapshot.revision, viewId:id, redactionBasis:basis,
    round:{id:record.roundId,status:"settled",intent:record.intent}, status:result.status,stopReason,stopReasonIncomplete,stopReasonLocation:"assessments",
    fulfillment:{satisfied:Object.values(result.requirements).filter(r=>r.status==="satisfied").length,total:Object.keys(result.requirements).length},
    definitionViewId:digest(JSON.stringify(definitionBlock)),definitionsLocation:"changes",
    usage,usageIncomplete,usageLocation:"assessments", ...(record.payload.physical ? {physical:{schemaVersion:1,source:record.payload.physical.source,cutoff:record.payload.physical.cutoff,
      stages:record.payload.physical.stages,knownSubtotal:record.payload.physical.knownSubtotal,total:record.payload.physical.total,
      reservationsRefused:record.payload.physical.reservationsRefused,admission:record.payload.physical.admission,
      attempts:record.payload.physical.attempts.length,
      detail:'summary',detailLocation:'assessments',detailIncomplete:true,
      detailNote:'Attempt rows are omitted here; the complete validated native ledger is retained in the paged assessments collection.'}} : {}), cumulativeUsage:record.payload.accounting??null,
    ...(record.payload.accounting === undefined ? {accountingUnavailable:"not-retained"} : {}),
    metadataIncomplete:true, contentIncomplete:evidence.length>0,
    collectionIncomplete:Object.fromEntries(COLLECTIONS.map(c=>[c,collections[c].length>0])),
    counts:Object.fromEntries(COLLECTIONS.map(c=>[c,collections[c].length])),
    cursors:Object.fromEntries(COLLECTIONS.map(c=>[c,cursor({v:1,r:record.snapshot.revision,h:record.revision,b:basis,c,o:0})])),
  };
  return {record,evidence,collections,header,basis,id};
}
function bounded(value: Obj, maxChars: number, secrets: readonly string[]): Obj {
  const resultSha256 = digest(JSON.stringify(value)); const output = {...value,resultSha256};
  if (JSON.stringify(output).length > maxChars) throw new ValidationError("maxChars cannot fit this caller page header.");
  return stablePage(output,secrets);
}
function cut(text: string, start: number, size: number): string {
  let end=Math.min(text.length,start+size); if (end<text.length && /[\uD800-\uDBFF]/.test(text[end-1]!)) end--;
  return text.slice(start,end);
}
function page(base: Obj, text: string, offset: number, maxChars: number, next: (offset:number)=>string, secrets: readonly string[]): Obj {
  if (!Number.isSafeInteger(offset) || offset<0 || offset>text.length) throw new ValidationError("Invalid cursor offset.");
  let low=0,high=text.length-offset,best:Obj|undefined;
  while(low<=high){const size=Math.floor((low+high)/2),content=cut(text,offset,size),end=offset+content.length;
    const candidate={...base,content,range:[offset,end],totalChars:text.length,contentIncomplete:end<text.length,cursor:end<text.length?next(end):null};
    if(JSON.stringify({...candidate,resultSha256:"sha256:"+"0".repeat(64)}).length<=maxChars){best=candidate;low=size+1;}else high=size-1;
  }
  if(!best || (!best.content && offset<text.length)) throw new ValidationError("maxChars cannot fit a progressing caller page.");
  return bounded(best,maxChars,secrets);
}
/** Five explicit operations over the approved round/store; no automatic producer or parser. */
export async function executeCallerInvestigation(request: unknown, options: CallerInvestigationOptions): Promise<Obj> {
  validateCallerRequest(request); const req=request as Obj; const maxChars=req.maxChars??16384; const secrets=options.secrets??[];
  if(req.operation==="delete") {await openStore({root:options.storeRoot}).deleteInvestigation(req.investigationRef);return stablePage({kind:"caller-assisted-investigation",schemaVersion:2,investigationRef:req.investigationRef,deleted:true},secrets);}
  let ref=req.investigationRef;
  if(["start","continue"].includes(req.operation)){
    if (req.requirements !== undefined) validateDefinitionIdentities(req.requirements,secrets);
    for (const proposal of req.proposals??[]) {
      requireVisibleIdentity(proposal.requirementId,secrets);
      requireVisibleIdentity(proposal.definitionRevision,secrets);
    }
    if(!options.deps) throw new ValidationError("Mutating caller operation requires explicit acquisition/judge runtime.");
    let proposals:CallerProposal[]=[];
    if(req.operation==="continue"){
      const old=await view(options,ref);
      if(old.record.snapshot.revision!==req.expectedRevision) throw new ExpectedRevisionError("Stale expected caller revision.");
      validateCallerRequirementIds(req.requirements ?? old.record.baselineContract);
      for(const p of req.proposals??[]){
        const item:CallerProposal={fieldId:p.requirementId,definitionRevision:p.definitionRevision,mode:p.mode,value:p.value};
        if(p.binding){const e=selectEvidence(old.evidence,p.binding.representationId,p.binding.digest,p.binding.evidenceId);
          const [a,b]=p.binding.range,quote=p.binding.quote;
          if(e.content.slice(a,b)!==quote || quote.includes("[REDACTED]"))throw new ValidationError("Display quote/range does not bind unchanged evidence.");
          const original=old.record.payload.result.evidence.find(r=>r.evidenceId===e.evidenceId)!.content;
          validateDisplayInterval(e.content,original,a,b,options.secrets??[]);
          const identity=e.content===original, start=identity?a:original.indexOf(quote);
          if(start<0 || (identity ? b>original.length || original.slice(a,b)!==quote : original.indexOf(quote,start+1)!==-1))throw new ValidationError("Display quote has no unique original binding.");
          item.evidenceId=e.evidenceId;item.representationId=e.originalRepresentationId;item.digest=e.originalDigest;item.quote=quote;item.charRange=identity?[a,b]:[start,start+quote.length];
        }proposals.push(item);
      }
    }
    const args={storeRoot:options.storeRoot,contract:req.requirements,deps:options.deps,dataScope:req.dataScope,leads:req.leads,representations:req.representations,roundLimits:req.roundLimits,judgeIdentity:options.judgeIdentity,policyRevision:options.policyRevision,nativeObservation:options.nativeObservation};
    const round=req.operation==="start"?await startCallerRound(args):await continueCallerRound({...args,investigationRef:ref,expectedRevision:req.expectedRevision,proposals,acknowledgeInterruptedRound:req.acknowledgeInterruptedRound});
    ref=round.investigationRef;
  }
  const v=await view(options,ref,req.revision);
  if(req.operation==="readEvidence"){
    const c=req.cursor?decode(req.cursor):undefined;
    if(c?.e!==undefined&&(typeof c.e!=="string"||req.evidenceId!==undefined&&req.evidenceId!==c.e))throw new ValidationError("Evidence cursor and request event selectors conflict.");
    // A legacy cursor has no event authority, even if its request supplies one.
    if(c&&c.e===undefined)selectEvidence(v.evidence,req.representationId,req.digest);
    const e=selectEvidence(v.evidence,req.representationId,req.digest,req.evidenceId??c?.e);
    let offset=0;
    if(c){if(c.r!==v.record.snapshot.revision||c.h!==v.record.revision||c.b!==v.basis||c.d!==e.digest||c.c!==e.representationId||c.e!==undefined&&c.e!==e.evidenceId)throw new ExpectedRevisionError("Stale or unavailable evidence cursor.");offset=c.o;}
    if(req.range){if(req.range[1]>e.content.length)throw new ValidationError("Evidence range exceeds accessible content.");for(const offset of req.range){if(offset>0&&offset<e.content.length&&/[\uD800-\uDBFF]/.test(e.content[offset-1]!)&&/[\uDC00-\uDFFF]/.test(e.content[offset]!))throw new ValidationError("Evidence range splits a surrogate-pair character.");}return bounded({kind:"caller-assisted-evidence",schemaVersion:2,investigationRef:ref,revision:v.record.revision,representationId:e.representationId,evidenceId:e.evidenceId,digest:e.digest,redactionBasis:v.basis,range:req.range,content:e.content.slice(...req.range),locatorUnit:"utf16-code-units",contentIncomplete:false},maxChars,secrets);}
    return page({kind:"caller-assisted-evidence",schemaVersion:2,investigationRef:ref,revision:v.record.revision,representationId:e.representationId,evidenceId:e.evidenceId,digest:e.digest,originalDigest:e.originalDigest,redactionBasis:v.basis,locatorUnit:"utf16-code-units"},e.content,offset,maxChars,o=>cursor({v:1,r:v.record.snapshot.revision,h:v.record.revision,b:v.basis,c:e.representationId,d:e.digest,e:e.evidenceId,o}),secrets);
  }
  if(req.operation==="inspect"&&(req.collection||req.cursor)){
    const c=req.cursor?decode(req.cursor):undefined;const collection:Collection=req.collection??c?.c;
    if(!COLLECTIONS.includes(collection)||c&&(c.e!==undefined||c.r!==v.record.snapshot.revision||c.h!==v.record.revision||c.b!==v.basis||c.c!==collection))throw new ExpectedRevisionError("Stale or unavailable metadata cursor.");
    return page({kind:"caller-assisted-page",schemaVersion:2,investigationRef:ref,revision:v.record.revision,viewId:v.id,redactionBasis:v.basis,collection,count:v.collections[collection].length,encoding:"json-fragments",metadataIncomplete:true},JSON.stringify(v.collections[collection]),c?.o??0,maxChars,o=>cursor({v:1,r:v.record.snapshot.revision,h:v.record.revision,b:v.basis,c:collection,o}),secrets);
  }
  return bounded(v.header,maxChars,secrets);
}
