import { createHash, randomUUID } from "node:crypto";
import { validateCallerPhysical, type CallerPhysicalSnapshot } from "./caller-physical.js";
import { ValidationError } from "./errors.js";
import { compileLeanContract, frozenLeanQueryPlan, runLeanInvestigation, prepareLeanCallerHistory, type LeanDeps, type LeanUnifiedDeps, type LeanResult, type LeanUsage, type LeanEvidenceRecord, type LeanSeed, type LeanRoundCheckpoint } from "./lean-investigation.js";
import { ExpectedRevisionError, CorruptRecordError, openStore, type OwnershipHandle, type RetainedRecordStore, type RevisionSnapshot, type RetainedBodyRef, type OpenStoreOptions } from "./retained-record-store.js";

export interface CallerProposal {
  fieldId: string; mode: "string" | "classification"; value: string;
  definitionRevision: string; evidenceId?: string; representationId?: string; digest?: string;
  quote?: string; charRange?: readonly [number, number];
}
export interface StartCallerRoundInput {
  storeRoot: string; contract: unknown; deps: LeanDeps;
  requirements?: { schemaVersion: 1; fields: Readonly<Record<string, { definition: string; required: boolean }>> };
  leads?: readonly { url: string; title?: string }[];
  representations?: readonly { format: "text" | "markdown" | "json"; content: string; label?: string; claimedSource?: string }[];
  roundLimits?: Record<string, number>; judgeIdentity?: string; policyRevision?: string; dataScope?: "public" | "synthetic";
  storeOptions?: Pick<OpenStoreOptions, "deps" | "caps">;
  /** Internal production adapter snapshot, not a request or collaborator response. */
  nativeObservation?: () => CallerPhysicalSnapshot;
}
export interface ContinueCallerRoundInput extends Omit<StartCallerRoundInput, "contract" | "requirements"> {
  investigationRef: string; expectedRevision: number; contract?: unknown;
  proposals?: readonly CallerProposal[]; acknowledgeInterruptedRound?: boolean;
}
interface Pointer { digest: string; chunks: RetainedBodyRef[] }
interface DefinitionPointer { schemaVersion: 1; definitionRevision: string; contract: Pointer; state: Pointer; baselineContract?: Pointer }
interface State {
  schemaVersion: 1;
  evidence: { record: Omit<LeanEvidenceRecord, "content">; body: RetainedBodyRef; format: string; suppliedAt: number }[];
  historyContinuity?: { schemaVersion: 1; fromRevision: 1 };
  accountingContinuity?: { schemaVersion: 1; fromRevision: 1 };
  checkpoint: LeanRoundCheckpoint; proposals: CallerProposal[]; coverageBasis: string;
  results?: { revision: number; roundId: string; intent: "start" | "continue"; contract: Pointer; result: Pointer }[];
}
export interface SuppliedProvenance { claimedSource: string; verification: "unverified" }
export type CallerEvidenceRecord = LeanEvidenceRecord & { suppliedProvenance?: SuppliedProvenance };
export type CallerResult = Omit<LeanResult, "evidence"> & { evidence: readonly CallerEvidenceRecord[] };
export interface CallerRoundHandoff {
  kind: "caller-assisted-investigation"; schemaVersion: 2; investigationRef: string; revision: number;
  definitionRevision: string; definitionDigest: string; definitions: Readonly<Record<string, string>>; baselineRequirementsDigest: string;
  round: { id: string; status: "settled"; intent: "start" | "continue" }; stopReason: string; result: CallerResult; gaps: readonly string[];
  evidence: readonly { representationId: string; digest: string; evidenceId: string; url: string; format: string; suppliedProvenance?: SuppliedProvenance }[];
  cumulativeUsage: CumulativeUsage;
}
type UsageDimension = "rounds" | "searches" | "reads" | "judgments" | "physicalAttempts";
export interface CumulativeUsage {
  rounds: number | null; searches: number | null; reads: number | null; judgments: number | null; physicalAttempts: number | null;
  knownSubtotal: Record<UsageDimension, number>;
  complete: { rounds: boolean; logical: boolean; physical: boolean };
  unknownStages: readonly string[]; reasons: readonly string[];
}
const usageDimensions: UsageDimension[] = ["rounds", "searches", "reads", "judgments", "physicalAttempts"];
const logicalDimensions: UsageDimension[] = ["searches", "reads", "judgments"];
function usageFold() {
  const subtotal: Record<UsageDimension, number> = { rounds: 0, searches: 0, reads: 0, judgments: 0, physicalAttempts: 0 };
  const incomplete = new Set<UsageDimension>(), frozen = new Set<UsageDimension>(), reasons = new Set<string>(), stages = new Set<string>();
  const unknown = (dims: readonly UsageDimension[], reason: string): void => { dims.forEach(d => incomplete.add(d)); reasons.add(reason); };
  const add = (dim: UsageDimension, value: number): void => {
    if (!Number.isSafeInteger(value) || value < 0) { unknown([dim], `numeric-range:${dim}`); return; }
    if (frozen.has(dim)) return;
    if (value > Number.MAX_SAFE_INTEGER - subtotal[dim]) { frozen.add(dim); unknown([dim], `numeric-overflow:${dim}`); return; }
    subtotal[dim] += value;
  };
  const logical = (value: FailureUsage | null): void => {
    if (!value) unknown(logicalDimensions, "unknown-logical-work");
    else { add("searches", value.searches); add("reads", value.reads); add("judgments", value.judgments); }
  };
  const missingPhysical = (): void => { unknown(["physicalAttempts"], "missing-physical"); ["acquisition", "judge", "producer"].forEach(s => stages.add(s)); };
  const physical = (observation: CallerPhysicalSnapshot | undefined): void => {
    if (observation === undefined) { missingPhysical(); return; }
    validateCallerPhysical(observation);
    add("physicalAttempts", observation.knownSubtotal);
    for (const stage of ["acquisition", "judge", "producer"] as const) {
      if (observation.stages[stage] === null && observation.admission[stage] !== "not-configured") {
        stages.add(stage); unknown(["physicalAttempts"], "missing-physical");
      }
    }
    if (observation.total === null) unknown(["physicalAttempts"], "physical-conservative-total");
  };
  const finish = (): CumulativeUsage => ({
    rounds: incomplete.has("rounds") ? null : subtotal.rounds, searches: incomplete.has("searches") ? null : subtotal.searches,
    reads: incomplete.has("reads") ? null : subtotal.reads, judgments: incomplete.has("judgments") ? null : subtotal.judgments,
    physicalAttempts: incomplete.has("physicalAttempts") ? null : subtotal.physicalAttempts, knownSubtotal: { ...subtotal },
    complete: { rounds: !incomplete.has("rounds"), logical: logicalDimensions.every(d => !incomplete.has(d)), physical: !incomplete.has("physicalAttempts") },
    unknownStages: [...stages].sort(), reasons: [...reasons].sort(),
  });
  return { add, logical, unknown, missingPhysical, physical, finish };
}
function validateAccounting(value: unknown): void {
  if (!object(value) || Object.keys(value).length !== 10 || value.schemaVersion !== 1 || !object(value.knownSubtotal) || Object.keys(value.knownSubtotal).length !== 5 ||
    !object(value.complete) || Object.keys(value.complete).length !== 3 || ![value.complete.rounds, value.complete.logical, value.complete.physical].every(v => typeof v === "boolean") ||
    !Array.isArray(value.unknownStages) || value.unknownStages.length > 3 || new Set(value.unknownStages).size !== value.unknownStages.length || !value.unknownStages.every(v => ["acquisition", "judge", "producer"].includes(v)) ||
    !Array.isArray(value.reasons) || value.reasons.length > 17 || new Set(value.reasons).size !== value.reasons.length || !value.reasons.every(v => typeof v === "string" &&
      (["missing-continuity", "recovery-incomplete", "unclassified-publication", "unknown-logical-work", "missing-physical", "physical-conservative-total"].includes(v) || /^numeric-(range|overflow):(rounds|searches|reads|judgments|physicalAttempts)$/.test(v)))) throw new CorruptRecordError("Invalid retained accounting projection.");
  for (const d of usageDimensions) {
    const sub = value.knownSubtotal[d], total = value[d];
    if (!Number.isSafeInteger(sub) || (sub as number) < 0 || !(total === null || Number.isSafeInteger(total) && total === sub)) throw new CorruptRecordError("Invalid accounting scalar.");
  }
  if (value.complete.rounds !== (value.rounds !== null) || value.complete.logical !== logicalDimensions.every(d => value[d] !== null) || value.complete.physical !== (value.physicalAttempts !== null)) throw new CorruptRecordError("Inconsistent accounting completeness.");
}
async function priorUsage(store: RetainedRecordStore, ref: string, handle: OwnershipHandle, base: RevisionSnapshot, state: State) {
  const fold = usageFold();
  if (state.accountingContinuity === undefined) fold.unknown(usageDimensions, "missing-continuity");
  for (const r of base.rounds) { fold.add("rounds", 1); fold.logical(r.usage); }
  const results = state.results ?? [];
  if (results.length < base.rounds.length) fold.missingPhysical();
  for (const entry of results) {
    const payload = retainedJSON(await read(store, ref, entry.result, base)); validateRetainedResult(payload);
    const contract = retainedJSON(await read(store, ref, entry.contract, base)); storedContract(contract); payloadProposals(payload, contract);
    if (canonical(payload.definitions) !== canonical(definitions(contract))) throw new CorruptRecordError("Physical result definition binding mismatch.");
    fold.physical(payload.physical);
  }
  let cursor: string | undefined;
  do {
    const page = await handle.readRecoveryPage(cursor === undefined ? {} : { cursor });
    if (page.revision !== base.revision) throw new CorruptRecordError("Recovery view changed.");
    for (const r of page.records) {
      if (r.publicationState === "completed") continue;
      if (r.publicationState === "unknown") { fold.unknown(usageDimensions, "unclassified-publication"); fold.missingPhysical(); continue; }
      fold.add("rounds", 1); fold.logical(r.work.measured); fold.missingPhysical();
    }
    if (!page.complete && page.cursor === null) fold.unknown(usageDimensions, "recovery-incomplete");
    cursor = page.cursor ?? undefined;
  } while (cursor !== undefined);
  return fold;
}
export interface CallerRoundOutcome {
  result: CallerResult; handoff: CallerRoundHandoff; store: RetainedRecordStore; storeRoot: string; investigationRef: string; contract: unknown;
  /** Already released; compatibility only, release remains idempotent. */
  handle: OwnershipHandle;
}
const hash = (s: string): string => `sha256:${createHash("sha256").update(s, "utf8").digest("hex")}`;
function canonical(v: unknown): string {
  const sort = (x: unknown): unknown => Array.isArray(x) ? x.map(sort) : x !== null && typeof x === "object"
    ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, sort(v)])) : x;
  return JSON.stringify(sort(v));
}
function validateContract(input: unknown): void {
  if (input === null || typeof input !== "object" || Array.isArray(input) || Buffer.byteLength(canonical(input)) > 1048576) throw new ValidationError("Invalid bounded executable contract.");
  for (const k of Object.keys(input)) if (!["schemaVersion", "question", "scope", "requirements", "evidence", "limits"].includes(k)) throw new ValidationError(`Unknown contract key ${k}.`);
  compileLeanContract(input);
}
function definitions(contract: unknown): Record<string, string> {
  const c = compileLeanContract(contract);
  return Object.fromEntries(c.fields.map(f => [f.id, hash(canonical([c.question, c.scope, c.evidenceCriteria, f]))]));
}
function withLimits(contract: unknown, lower?: Record<string, number>): unknown {
  if (lower === undefined) return JSON.parse(canonical(contract));
  const requested = compileLeanContract({ ...(contract as object), limits: lower }).limits;
  const old = compileLeanContract(contract).limits;
  const values = Object.fromEntries(Object.keys(lower).map(k => [k, Math.min((requested as unknown as Record<string, number>)[k]!, (old as unknown as Record<string, number>)[k]!)]));
  return JSON.parse(canonical({ ...(contract as object), limits: { ...((contract as { limits?: object }).limits ?? {}), ...values } }));
}
type FailureUsage = { searches: number; reads: number; judgments: number };
const measuredFailureUsage = (u: LeanUsage | undefined): FailureUsage | null => u === undefined ? null
  : { searches: u.searches, reads: u.readAttempts, judgments: u.judgeCalls + u.candidateJudgeCalls };
function reportSecondary(primary: unknown, key: "settlementFailure" | "releaseFailure", phase: "engine-rejection" | "publication" | "release",
  roundId: string | null, measured: FailureUsage | null, reason: "usage-unavailable" | "settlement-failed" | "release-failed"): void {
  // Only locally generated identifiers, fixed labels and actual scalar counts.
  // Never read/stringify an unknown error or overwrite an earlier diagnostic.
  try {
    const detail = JSON.stringify({ event: key === "settlementFailure" ? "caller-round-accounting-unavailable" : "caller-round-release-failed", phase, roundId, measured, reason });
    let attached = false;
    try {
      if ((typeof primary === "object" && primary !== null) || typeof primary === "function") {
        if (!Reflect.has(primary, key)) attached = Reflect.defineProperty(primary, key, { value: detail, enumerable: true, configurable: true, writable: true });
      }
    } catch { /* Rejected/frozen carriers use the fixed fallback. */ }
    if (!attached) { try { console.error(detail); } catch { /* Preserve primary even if diagnostics are unavailable. */ } }
  } catch { /* Diagnostics must never replace the original throwable. */ }
}
async function releaseAfterFailure(handle: OwnershipHandle, primary: unknown, roundId: string | null = null, measured: FailureUsage | null = null): Promise<never> {
  try { await handle.release(); }
  catch { reportSecondary(primary, "releaseFailure", "release", roundId, measured, "release-failed"); }
  throw primary;
}
async function stage(handle: OwnershipHandle, text: string): Promise<Pointer> {
  const chunks: RetainedBodyRef[] = [];
  for (let i = 0; i < text.length;) {
    let end = Math.min(i + 4096, text.length);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
    const b = await handle.stageBody(text.slice(i, end));
    chunks.push({ bodyId: b.bodyId, digest: `sha256:${b.bodyId.slice(2)}`, bytes: b.bytes }); i = end;
  }
  if (chunks.length > 128) throw new ValidationError("Retained chunk manifest exceeds bound.");
  return { digest: hash(text), chunks };
}
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
function retainedJSON(text: string): unknown {
  try { return JSON.parse(text); } catch { throw new CorruptRecordError("Invalid retained JSON document."); }
}
function storedContract(value: unknown): void {
  try { validateContract(value); } catch { throw new CorruptRecordError("Invalid retained executable contract."); }
}
function storedState(value: unknown): asserts value is State {
  const s = value as State;
  if (!object(s) || s.schemaVersion !== 1 || !Array.isArray(s.evidence) || !Array.isArray(s.proposals) || s.proposals.length > 24 || !object(s.checkpoint) || !Array.isArray(s.checkpoint.history) || !Array.isArray(s.checkpoint.issuedQueries) || !s.checkpoint.issuedQueries.every(q => typeof q === "string") || !Array.isArray(s.checkpoint.leads) || !s.checkpoint.leads.every(l => object(l) && typeof l.url === "string" && typeof l.title === "string") || typeof s.coverageBasis !== "string") throw new CorruptRecordError("Invalid retained state.");
  for (const e of s.evidence) if (!object(e) || !object(e.record) || typeof e.record.evidenceId !== "string" || typeof e.record.url !== "string" || typeof e.record.title !== "string" || !Array.isArray(e.record.origins) || !e.record.origins.every(o => typeof o === "string") || !object(e.body) || typeof e.body.bodyId !== "string" || typeof e.body.digest !== "string" || !Number.isSafeInteger(e.body.bytes) || e.body.bytes < 0 || typeof e.format !== "string" || !Number.isFinite(e.suppliedAt)) throw new CorruptRecordError("Invalid retained evidence entry.");
}
async function definitionPointer(store: RetainedRecordStore, ref: string, snapshot: RevisionSnapshot): Promise<DefinitionPointer> {
  const row = [...snapshot.audit].reverse().find(r => r.kind === "definition-ref");
  if (!row) throw new CorruptRecordError("Definition root unavailable.");
  const root = retainedJSON(row.detail);
  if (!object(root) || root.schemaVersion !== 1 || typeof root.root !== "string" || !/^b:[0-9a-f]{64}$/.test(root.root) || !snapshot.bodies.some(b => b.bodyId === root.root)) throw new CorruptRecordError("Invalid committed root binding.");
  const pointer = retainedJSON((await store.readBody(ref, root.root)).toString("utf8"));
  if (!object(pointer) || pointer.schemaVersion !== 1 || !object(pointer.contract) || !object(pointer.state) || typeof pointer.definitionRevision !== "string" || pointer.definitionRevision !== pointer.contract.digest) throw new CorruptRecordError("Invalid definition pointer.");
  return pointer as unknown as DefinitionPointer;
}
async function retainedBaseline(store: RetainedRecordStore, ref: string, pointer: DefinitionPointer, snapshot: RevisionSnapshot, executed: unknown): Promise<unknown> {
  if (!Object.hasOwn(pointer, "baselineContract")) return executed;
  const baseline = retainedJSON(await read(store, ref, pointer.baselineContract!, snapshot)); storedContract(baseline);
  const b = compileLeanContract(baseline), e = compileLeanContract(executed);
  if (Object.keys(e.limits).some(k => (e.limits as unknown as Record<string, number>)[k]! > (b.limits as unknown as Record<string, number>)[k]!) || canonical({ ...b, limits: e.limits }) !== canonical(e)) throw new CorruptRecordError("Invalid baseline/executed contract binding.");
  return baseline;
}
async function read(store: RetainedRecordStore, ref: string, p: Pointer, snapshot: RevisionSnapshot): Promise<string> {
  if (p === null || typeof p !== "object" || typeof p.digest !== "string" || !Array.isArray(p.chunks) || p.chunks.length > 128) throw new CorruptRecordError("Invalid retained chunk pointer.");
  let text = "";
  for (const b of p.chunks) {
    if (!object(b) || typeof b.bodyId !== "string" || !/^b:[0-9a-f]{64}$/.test(b.bodyId) || !Number.isSafeInteger(b.bytes) || b.bytes < 0 || typeof b.digest !== "string") throw new CorruptRecordError("Invalid retained chunk.");
    if (!snapshot.bodies.some(x => canonical(x) === canonical(b))) throw new CorruptRecordError("Pointer body not in committed view.");
    const bytes = await store.readBody(ref, b.bodyId);
    if (bytes.length !== b.bytes || b.digest !== `sha256:${b.bodyId.slice(2)}`) throw new CorruptRecordError("Chunk binding mismatch.");
    text += bytes.toString("utf8");
  }
  if (hash(text) !== p.digest) throw new CorruptRecordError("Whole retained document digest mismatch.");
  return text;
}
function validateFeedback(input: StartCallerRoundInput | ContinueCallerRoundInput): void {
  if (input.dataScope !== undefined && !["public", "synthetic"].includes(input.dataScope)) throw new ValidationError("Private input unsupported.");
  for (const value of [input.leads, input.representations, (input as ContinueCallerRoundInput).proposals]) if (value !== undefined && !Array.isArray(value)) throw new ValidationError("Feedback must be arrays.");
  if ((input.leads?.length ?? 0) > 32 || (input.representations?.length ?? 0) > 16 || ((input as ContinueCallerRoundInput).proposals?.length ?? 0) > 24) throw new ValidationError("Feedback count cap exceeded.");
  for (const l of input.leads ?? []) {
    if (!l || typeof l !== "object" || Array.isArray(l) || typeof l.url !== "string" || (l.title !== undefined && typeof l.title !== "string")) throw new ValidationError("Invalid URL lead.");
    let u: URL; try { u = new URL(l.url); } catch { throw new ValidationError("Invalid URL lead."); }
    if (!["https:", "http:"].includes(u.protocol) || u.username || u.password) throw new ValidationError("Invalid URL lead.");
  }
  for (const r of input.representations ?? []) if (!r || typeof r !== "object" || Array.isArray(r) || (Object.hasOwn(r, "claimedSource") && typeof r.claimedSource !== "string") || (r.label !== undefined && typeof r.label !== "string") || !["text", "markdown", "json"].includes(r.format) || typeof r.content !== "string" || !r.content || Buffer.byteLength(r.content) > 16384) throw new ValidationError("Invalid bounded supplied representation.");
  let text: string;
  try { text = canonical({ leads: input.leads, representations: input.representations, proposals: (input as ContinueCallerRoundInput).proposals }); }
  catch { throw new ValidationError("Feedback could not be serialized."); }
  if (Buffer.byteLength(text) > 1048576) throw new ValidationError("Feedback byte cap exceeded.");
}
function snapshotCallerInput<T extends StartCallerRoundInput | ContinueCallerRoundInput>(input: T): T {
  // Runtime collaborators/options/signals remain live references. Only submitted
  // intent/feedback data is detached, synchronously before the first await.
  const captured = { ...input };
  try {
    return { ...captured, ...structuredClone({
      contract: captured.contract, requirements: (captured as StartCallerRoundInput).requirements,
      roundLimits: captured.roundLimits, leads: captured.leads, representations: captured.representations,
      proposals: (captured as ContinueCallerRoundInput).proposals,
    }) };
  } catch {
    throw new ValidationError("Caller JSON intent could not be snapshotted.");
  }
}
function validateProposals(contract: unknown, input: unknown, entries: State["evidence"], evidence: readonly LeanEvidenceRecord[], ErrorType: new (message: string) => Error, historical = false): CallerProposal[] {
  const fail = (message: string): never => { throw new ErrorType(message); };
  if (!Array.isArray(input) || input.length > 24) return fail("Invalid bounded proposals.");
  const fields = compileLeanContract(contract).fields, ids = definitions(contract), seen = new Set<string>();
  return input.map((value: unknown) => {
    if (!object(value) || Object.keys(value).some(k => !["fieldId", "mode", "value", "definitionRevision", "evidenceId", "representationId", "digest", "quote", "charRange"].includes(k))) return fail("Unknown proposal key.");
    const p = value as unknown as CallerProposal;
    if (typeof p.fieldId !== "string" || typeof p.definitionRevision !== "string" || typeof p.value !== "string" || !["string", "classification"].includes(p.mode) || seen.has(p.fieldId)) return fail("Invalid proposal shape or duplicate field intent.");
    seen.add(p.fieldId);
    const f = fields.find(f => f.id === p.fieldId);
    if (!f || p.definitionRevision !== ids[p.fieldId] || (f.schema.mode === "value") !== (p.mode === "string")) return fail("Proposal definition/mode/value mismatch.");
    if (p.mode === "classification" && !f.schema.enum!.includes(p.value)) return fail("Invalid classification label.");
    for (const k of ["evidenceId", "representationId", "digest", "quote"] as const) if (Object.hasOwn(p, k) && typeof p[k] !== "string") return fail("Invalid proposal binding scalar.");
    const bound = p.mode === "string" || ["evidenceId", "representationId", "digest", "quote", "charRange"].some(k => Object.hasOwn(p, k));
    if (!bound) return { ...p };
    if (typeof p.representationId !== "string" || typeof p.digest !== "string" || typeof p.quote !== "string" || !Array.isArray(p.charRange) || p.charRange.length !== 2 || !p.charRange.every(Number.isSafeInteger) || p.charRange[0] < 0 || p.charRange[1] <= p.charRange[0]) return fail("Proposal quote/range binding mismatch.");
    const matches = entries.filter(e => e.body.bodyId === p.representationId && e.body.digest === p.digest && (p.evidenceId === undefined || e.record.evidenceId === p.evidenceId));
    if (!matches.length) return fail("Immutable proposal representation binding mismatch.");
    for (const retained of matches) {
      const source = evidence.find(e => e.evidenceId === retained.record.evidenceId && e.url === retained.record.url);
      if (!source || hash(source.content) !== p.digest || source.content.slice(...p.charRange) !== p.quote) return fail("Proposal quote/range mismatch.");
    }
    if (matches.length !== 1 && !historical) return fail("Ambiguous proposal event requires evidenceId.");
    return { ...p, charRange: [...p.charRange] as [number, number], ...(matches.length === 1 ? { evidenceId: matches[0]!.record.evidenceId } : {}) };
  });
}
function payloadProposals(payload: RetainedCallerResult, contract: unknown): void {
  const entries = payload.result.evidence.map(e => ({ record: e, body: { bodyId: `b:${hash(e.content).slice(7)}`, digest: hash(e.content), bytes: Buffer.byteLength(e.content) }, format: "text", suppliedAt: 0 }));
  validateProposals(contract, payload.proposals, entries, payload.result.evidence, CorruptRecordError, true);
}
async function retainedEvidence(store: RetainedRecordStore, ref: string, state: State): Promise<LeanEvidenceRecord[]> {
  const evidence: LeanEvidenceRecord[] = [];
  for (const e of state.evidence) {
    const b = await store.readBody(ref, e.body.bodyId);
    if (b.length !== e.body.bytes || e.body.digest !== `sha256:${e.body.bodyId.slice(2)}` || hash(b.toString("utf8")) !== e.body.digest) throw new CorruptRecordError("Retained evidence identity mismatch.");
    evidence.push({ ...e.record, content: b.toString("utf8") });
  }
  return evidence;
}
function proposalsFor(contract: unknown, submitted: readonly CallerProposal[], state: State, evidence: readonly LeanEvidenceRecord[], stored: unknown): CallerProposal[] {
  const old = validateProposals(stored, state.proposals, state.evidence, evidence, CorruptRecordError, true);
  const fresh = validateProposals(contract, submitted, state.evidence, evidence, ValidationError), ids = definitions(contract);
  const active = old.filter(p => ids[p.fieldId] === p.definitionRevision && !fresh.some(n => n.fieldId === p.fieldId));
  return [...validateProposals(contract, active, state.evidence, evidence, ValidationError), ...fresh];
}
// Canonical observed metadata belongs to this revision, never the early
// hook record. Validate the complete event bijection before replacing state.
function reconcileEvidence(entries: State["evidence"], final: readonly LeanEvidenceRecord[]): State["evidence"] {
  const byId = new Map<string, LeanEvidenceRecord>();
  for (const e of final) {
    if (!e || typeof e.evidenceId !== "string" || byId.has(e.evidenceId) || typeof e.url !== "string" || typeof e.title !== "string" || typeof e.content !== "string" || !Array.isArray(e.origins) || !e.origins.every(o => typeof o === "string") || e.byteLength !== Buffer.byteLength(e.content)) throw new CorruptRecordError("Invalid canonical evidence metadata.");
    byId.set(e.evidenceId, e);
  }
  if (byId.size !== entries.length) throw new CorruptRecordError("Retained evidence set mismatch.");
  const seen = new Set<string>();
  return entries.map(entry => {
    const e = byId.get(entry.record.evidenceId);
    if (!e || seen.has(e.evidenceId) || e.url !== entry.record.url || hash(e.content) !== entry.body.digest || e.byteLength !== entry.body.bytes || (Object.hasOwn(entry.body, "claimedSource") && typeof entry.body.claimedSource !== "string")) throw new CorruptRecordError("Retained evidence binding mismatch.");
    seen.add(e.evidenceId);
    return { ...entry, body: { ...entry.body }, record: { evidenceId: e.evidenceId, url: e.url, title: e.title, byteLength: e.byteLength, origins: [...e.origins] } };
  });
}
export interface RetainedCallerResult {
  schemaVersion: 1; result: CallerResult; stopReason: string; definitions: Record<string, string>; proposals: CallerProposal[]; physical?: CallerPhysicalSnapshot; accounting?: CumulativeUsage & { schemaVersion: 1 };
}
function validateRetainedResult(value: unknown): asserts value is RetainedCallerResult {
  const v = value as RetainedCallerResult;
  if (!v || typeof v !== "object" || Object.keys(v).some(k => !["schemaVersion", "result", "stopReason", "definitions", "proposals", "physical", "accounting"].includes(k)) || v.schemaVersion !== 1 || typeof v.stopReason !== "string" || !object(v.definitions) || !Array.isArray(v.proposals)) throw new CorruptRecordError("Invalid retained caller result.");
  if (Object.hasOwn(v, "accounting")) validateAccounting(v.accounting);
  if (v.physical !== undefined) validateCallerPhysical(v.physical);
  const r = v.result;
  if (!object(r) || r.schemaVersion !== 1 || !["complete", "partial"].includes(r.status) || !["semantic", "deterministic-only"].includes(r.assessment) || typeof r.question !== "string" || !object(r.data) || !object(r.requirements) || !Array.isArray(r.evidence) || !Array.isArray(r.acquisitionLog) || !Array.isArray(r.coverageNotes) || !object(r.usage) || !Array.isArray(r.plan?.queries) || Object.keys(r.requirements).length > 3 || Buffer.byteLength(canonical(v)) > 524288) throw new CorruptRecordError("Invalid bounded retained result payload.");
  for (const e of r.evidence) {
    if (!e || typeof e.content !== "string" || Buffer.byteLength(e.content) > 16384 || typeof e.evidenceId !== "string" || typeof e.url !== "string" || !Array.isArray(e.origins)) throw new CorruptRecordError("Invalid retained result evidence.");
    if (Object.hasOwn(e, "suppliedProvenance")) {
      const p = e.suppliedProvenance;
      if (!p || typeof p !== "object" || Array.isArray(p) || Object.keys(p).some(k => !["claimedSource", "verification"].includes(k)) || typeof p.claimedSource !== "string" || p.verification !== "unverified") throw new CorruptRecordError("Invalid supplied provenance.");
    }
  }
  for (const n of [r.usage.searches, r.usage.readAttempts, r.usage.judgeCalls, r.usage.candidateJudgeCalls]) if (!Number.isSafeInteger(n) || n < 0) throw new CorruptRecordError("Invalid retained result usage.");
}
// An old writer may have persisted stale state beside an accurate final
// result. Only the latest bound payload hydrates the current owned seed.
async function hydrateCurrentEvidence(store: RetainedRecordStore, ref: string, base: RevisionSnapshot,
  pointer: DefinitionPointer, stored: unknown, state: State): Promise<void> {
  if (!Object.hasOwn(state, "results")) return; // Legacy absence has no recovery authority.
  if (!Array.isArray(state.results) || state.results.length === 0 || state.results.length > base.rounds.length) throw new CorruptRecordError("Invalid current result history.");
  const offset = base.rounds.length - state.results.length;
  for (const [i, entry] of state.results.entries()) {
    const round = base.rounds[offset + i];
    if (!entry || entry.revision !== offset + i + 1 || entry.roundId !== round?.roundId || entry.intent !== round.intent) throw new CorruptRecordError("Current result history binding mismatch.");
  }
  const latest = state.results.at(-1)!;
  if (latest.revision !== base.revision || canonical(latest.contract) !== canonical(pointer.contract)) throw new CorruptRecordError("Current result contract binding mismatch.");
  {
    const payload = retainedJSON(await read(store, ref, latest.result, base));
    validateRetainedResult(payload); payloadProposals(payload, stored);
    if (canonical(payload.definitions) !== canonical(definitions(stored))) throw new CorruptRecordError("Current result definition binding mismatch.");
    state.evidence = reconcileEvidence(state.evidence, payload.result.evidence);
  }
}
/** Read only verified content-addressed result history; no owner, runtime or directory creation. */
export async function readCallerRecord(storeRoot: string, investigationRef: string, revision?: number): Promise<{
  snapshot: RevisionSnapshot; revision: number; roundId: string; intent: "start" | "continue"; contract: unknown;
  payload: RetainedCallerResult; history: readonly { revision: number; roundId: string; intent: string }[];
}> {
  const store = openStore({ root: storeRoot });
  const snapshot = (await store.inspect(investigationRef)).committed?.snapshot;
  if (!snapshot) throw new CorruptRecordError("No verifiable committed caller view.");
  const pointer = await definitionPointer(store, investigationRef, snapshot);
  const stored = retainedJSON(await read(store, investigationRef, pointer.contract, snapshot)); storedContract(stored);
  await retainedBaseline(store, investigationRef, pointer, snapshot, stored);
  const state = retainedJSON(await read(store, investigationRef, pointer.state, snapshot)); storedState(state);
  if (!Array.isArray(state.results) || state.results.length !== snapshot.rounds.length) throw new CorruptRecordError("Complete caller result history unavailable.");
  validateProposals(stored, state.proposals, state.evidence, await retainedEvidence(store, investigationRef, state), CorruptRecordError, true);
  const history: { revision: number; roundId: string; intent: string }[] = [];
  let selected: { entry: NonNullable<State["results"]>[number]; payload: RetainedCallerResult; contract: unknown } | undefined;
  for (const [i, entry] of state.results.entries()) {
    const round = snapshot.rounds[i];
    if (!object(entry) || entry.revision !== i + 1 || entry.roundId !== round?.roundId || entry.intent !== round.intent) throw new CorruptRecordError("Result history binding mismatch.");
    const payload = retainedJSON(await read(store, investigationRef, entry.result, snapshot)); validateRetainedResult(payload);
    const contract = retainedJSON(await read(store, investigationRef, entry.contract, snapshot)); storedContract(contract);
    payloadProposals(payload, contract);
    if (canonical(payload.definitions) !== canonical(definitions(contract))) throw new CorruptRecordError("Result definition binding mismatch.");
    history.push({ revision: entry.revision, roundId: entry.roundId, intent: entry.intent });
    if (entry.revision === (revision ?? snapshot.revision)) selected = { entry, payload, contract };
  }
  if (!selected) throw new ExpectedRevisionError("Requested historical caller revision unavailable.");
  return { snapshot, revision: selected.entry.revision, roundId: selected.entry.roundId, intent: selected.entry.intent, contract: selected.contract, payload: selected.payload, history };
}

export async function startCallerRound(input: StartCallerRoundInput): Promise<CallerRoundOutcome> {
  validateContract(input.contract); validateFeedback(input);
  input = snapshotCallerInput(input);
  validateContract(input.contract); validateFeedback(input);
  const baseline = withLimits(input.contract), contract = withLimits(baseline, input.roundLimits), c = compileLeanContract(contract);
  const requirements = input.requirements ?? { schemaVersion: 1 as const, fields: Object.fromEntries(c.fields.map(f => [f.id, { definition: f.question, required: f.required }])) };
  const store = openStore({ root: input.storeRoot, ...input.storeOptions });
  const { investigationRef: ref } = await store.createInvestigation({ requirements });
  const handle = await store.acquireOwnership(ref);
  try { return await execute(input, store, handle, ref, (await store.inspect(ref)).committed!.snapshot, contract,
    { schemaVersion: 1, accountingContinuity: { schemaVersion: 1, fromRevision: 1 }, historyContinuity: { schemaVersion: 1, fromRevision: 1 }, evidence: [], checkpoint: { history: [], issuedQueries: [], leads: [] }, proposals: [], coverageBasis: "" }, "start", undefined, baseline); }
  catch (e) { return await releaseAfterFailure(handle, e); }
}
export async function continueCallerRound(input: ContinueCallerRoundInput): Promise<CallerRoundOutcome> {
  validateFeedback(input); if (input.contract !== undefined) validateContract(input.contract);
  input = snapshotCallerInput(input);
  validateFeedback(input); if (input.contract !== undefined) validateContract(input.contract);
  const store = openStore({ root: input.storeRoot, ...input.storeOptions });
  const handle = input.acknowledgeInterruptedRound ? await store.acknowledgeInterrupted(input.investigationRef) : await store.acquireOwnership(input.investigationRef);
  try {
    const inspection = await store.inspect(input.investigationRef), base = inspection.committed?.snapshot;
    if (!base) throw new CorruptRecordError("No verifiable committed view.");
    if (base.revision !== input.expectedRevision) throw new ExpectedRevisionError(`Expected revision ${input.expectedRevision} but record is at ${base.revision}.`);
    const pointer = await definitionPointer(store, input.investigationRef, base);
    const stored = retainedJSON(await read(store, input.investigationRef, pointer.contract, base)); storedContract(stored);
    const baseline = await retainedBaseline(store, input.investigationRef, pointer, base, stored);
    const state = retainedJSON(await read(store, input.investigationRef, pointer.state, base)); storedState(state);
    await hydrateCurrentEvidence(store, input.investigationRef, base, pointer, stored, state);
    return await execute(input, store, handle, input.investigationRef, base, withLimits(input.contract ?? baseline, input.roundLimits), state, "continue", stored, input.contract ?? baseline);
  } catch (e) { return await releaseAfterFailure(handle, e); }
}
async function execute(input: StartCallerRoundInput | ContinueCallerRoundInput, store: RetainedRecordStore, handle: OwnershipHandle,
  ref: string, base: RevisionSnapshot, contract: unknown, state: State, intent: "start" | "continue", stored?: unknown, baselineContract: unknown = contract): Promise<CallerRoundOutcome> {
  const storedDefinitions = stored === undefined ? undefined : definitions(stored);
  const evidence = await retainedEvidence(store, ref, state);
  const proposals = proposalsFor(contract, (input as ContinueCallerRoundInput).proposals ?? [], state, evidence, stored ?? contract);
  const submittedProposals = (input as ContinueCallerRoundInput).proposals ?? [];
  if (Object.hasOwn(state, "historyContinuity") && (!state.historyContinuity || state.historyContinuity.schemaVersion !== 1 || state.historyContinuity.fromRevision !== 1 || Object.keys(state.historyContinuity).some(k => !["schemaVersion", "fromRevision"].includes(k)))) throw new CorruptRecordError("Invalid caller history continuity marker.");
  if (Object.hasOwn(state, "accountingContinuity") && (!object(state.accountingContinuity) || state.accountingContinuity.schemaVersion !== 1 || state.accountingContinuity.fromRevision !== 1 || Object.keys(state.accountingContinuity).length !== 2)) throw new CorruptRecordError("Invalid accounting continuity marker.");
  const accountingFold = await priorUsage(store, ref, handle, base, state);
  const identity = input.judgeIdentity === undefined || input.policyRevision === undefined ? undefined
    : canonical([input.judgeIdentity, input.policyRevision, input.deps.judge !== null, (input.deps as { candidateJudge?: unknown }).candidateJudge != null]);
  const candidates = proposals.filter(p => p.mode === "string").map(p => {
    const retained = state.evidence.find(e => e.record.evidenceId === p.evidenceId && e.body.bodyId === p.representationId && e.body.digest === p.digest)!;
    return { fieldId: p.fieldId, evidenceId: retained.record.evidenceId, url: retained.record.url, digest: retained.body.digest.slice(7), value: p.value, quote: p.quote!, charRange: p.charRange! };
  });
  const c = compileLeanContract(contract), basis = hash(canonical([c.question, c.scope, c.fields, c.evidenceCriteria]));
  const reuse = state.coverageBasis === basis;
  let checkpoint = state.checkpoint;
  const leads = [...(reuse ? checkpoint.leads : []), ...(input.leads ?? []).map(l => ({ url: l.url, title: l.title ?? l.url }))];
  const issuedQueries = reuse ? checkpoint.issuedQueries : [];
  const coverageOrderUncertain = !reuse && storedDefinitions !== undefined && canonical(storedDefinitions) === canonical(definitions(contract));
  // Allocate each submitted event once. Preflight and the admitted run see
  // these same owned records; proposal references above still resolve only
  // against already admitted evidence.
  const supplied = (input.representations ?? []).map((r, i) => ({
    record: { evidenceId: `e${evidence.length + i + 1}`, url: `caller:${randomUUID()}`, title: r.label ?? "Caller-supplied", content: r.content, byteLength: Buffer.byteLength(r.content), origins: [] } as LeanEvidenceRecord,
    format: r.format, claimedSource: r.claimedSource,
  }));
  evidence.push(...supplied.map(r => r.record));
  let prepared;
  try { prepared = prepareLeanCallerHistory(contract, evidence, state.checkpoint.history, candidates, state.historyContinuity !== undefined, identity, input.deps.judge !== null, coverageOrderUncertain); }
  catch { throw new CorruptRecordError("Malformed recognized caller history or candidate descriptor."); }
  const pendingLegacyContext = state.historyContinuity === undefined && identity !== undefined && input.deps.judge !== null && candidates.length > 0 &&
    (leads.length > 0 || (c.limits.maxSearchAttempts > 0 && frozenLeanQueryPlan(c).some(p => !issuedQueries.includes(p.query))));
  if (prepared.unavailable || pendingLegacyContext) throw new ValidationError("Caller legacy history continuity unavailable for the requested semantic closure.");
  if (input.deps.externalSignal?.aborted) throw new ValidationError("Round cancelled before dispatch.");
  const rid = `r-${randomUUID()}`; await handle.beginRound({ roundId: rid, intent });
  const bodies = [...base.bodies]; let newBytes = 0;
  const list = (b: RetainedBodyRef): void => { if (!bodies.some(x => x.bodyId === b.bodyId)) bodies.push(b); };
  const retain = async (record: LeanEvidenceRecord, format = "text", claimedSource?: string): Promise<void> => {
    const bytes = Buffer.byteLength(record.content), digest = hash(record.content);
    if (bytes > 16384) throw new ValidationError("Body exceeds representation ceiling.");
    if (!state.evidence.some(e => e.body.digest === digest)) { newBytes += bytes; if (newBytes > 262144) throw new ValidationError("New round byte cap exceeded."); }
    const staged = await handle.stageBody(record.content), body = { bodyId: staged.bodyId, digest, bytes: staged.bytes }; list(body);
    if (!state.evidence.some(e => e.record.evidenceId === record.evidenceId)) { const { content: _, ...metadata } = record; state.evidence.push({ record: metadata, body: { ...body, ...(claimedSource !== undefined ? { claimedSource } : {}) }, format, suppliedAt: Date.now() }); }
  };
  for (const r of supplied) await retain(r.record, r.format, r.claimedSource);
  const contractRef = await stage(handle, canonical(contract)); contractRef.chunks.forEach(list);
  const baselineRef = canonical(baselineContract) === canonical(contract) ? undefined : await stage(handle, canonical(baselineContract));
  baselineRef?.chunks.forEach(list);
  state.proposals = proposals;
  const admitted = await stage(handle, canonical(state)); admitted.chunks.forEach(list);
  const admittedPointer = canonical({ schemaVersion: 1, definitionRevision: contractRef.digest, contract: contractRef, state: admitted, ...(baselineRef ? { baselineContract: baselineRef } : {}) });
  const admittedRoot = await handle.stageBody(admittedPointer); list({ bodyId: admittedRoot.bodyId, digest: `sha256:${admittedRoot.bodyId.slice(2)}`, bytes: admittedRoot.bytes });
  await handle.appendAudit({ at: Date.now(), kind: "definition-ref", detail: canonical({ schemaVersion: 1, root: admittedRoot.bodyId }) });
  // Full cumulative history is durable. Current candidate selection belongs
  // to the typed engine seam; never delete a prior disposition here.
  let engineUsage: LeanUsage | undefined;
  const seed: LeanSeed = { evidence, leads,
    issuedQueries, history: checkpoint.history,
    identity, callerHistory: prepared.history,
    retainEvidence: async e => { await retain(e); }, capture: s => { checkpoint = s; }, captureUsage: u => { engineUsage = u; } };
  const deps: { -readonly [K in keyof LeanUnifiedDeps]: LeanUnifiedDeps[K] } & { seed: LeanSeed } = { ...input.deps, seed };
  const originalExtract = deps.extract;
  const stringBound = proposals.filter(p => p.mode === "string" && p.representationId !== undefined);
  if (stringBound.length > 0) deps.extract = async (request, options) => {
    const record = state.evidence.find(e => e.record.evidenceId === request.sourceId);
    const p = stringBound.find(p => p.fieldId === request.fields[0]?.id && p.evidenceId === request.sourceId && p.representationId === record?.body.bodyId);
    if (!p && originalExtract) return originalExtract(request, options);
    const entries = { [request.fields[0]!.id]: p ? { value: p.value, quote: p.quote, charRange: p.charRange } : { value: null, quote: null } };
    return { finishReason: "stop", rawOutput: JSON.stringify(entries), usage: null, observedCost: null, elapsedMs: 0, requestSha256: hash(canonical(entries)).slice(7) };
  };
  try {
    let result: CallerResult;
    try { result = await runLeanInvestigation(contract, deps); }
    catch (engineError) {
      const measured = measuredFailureUsage(engineUsage);
      if (measured === null) reportSecondary(engineError, "settlementFailure", "engine-rejection", rid, null, "usage-unavailable");
      else {
        try { await handle.settleRound(rid, { status: "failed", measured, uncertainty: "engine-run-failed:measured-attempts-preserved" }, { bindInstance: true }); }
        catch { reportSecondary(engineError, "settlementFailure", "engine-rejection", rid, measured, "settlement-failed"); }
      }
      throw engineError;
    }
    const usage = { searches: result.usage.searches, reads: result.usage.readAttempts, judgments: result.usage.judgeCalls + result.usage.candidateJudgeCalls };
    // CR4-1: any publication refusal AFTER the engine has run (state/root
    // staging, commit) first writes the settlement with MEASURED usage and
    // the explicit uncertainty marker, then rethrows — the prior committed
    // view stays intact and paid accounting is never lost. If the
    // settlement write itself fails, the original publication error is
    // rethrown with the accounting-unavailable failure reported honestly
    // (never fabricated as a clean zero-usage success).
    let publicationSettled = false;
    try {
      state.evidence = reconcileEvidence(state.evidence, result.evidence);
      result = { ...result, evidence: result.evidence.map(e => {
        const retained = state.evidence.find(r => r.record.evidenceId === e.evidenceId && r.record.url === e.url && r.body.digest === hash(e.content));
        return retained?.body.claimedSource === undefined ? e : { ...e, suppliedProvenance: { claimedSource: retained.body.claimedSource, verification: "unverified" as const } };
      }) };
      state.checkpoint = checkpoint; state.coverageBasis = basis;
      const stopReason = input.deps.externalSignal?.aborted ? "cancelled" : result.status === "complete" ? "work-fulfilled" : Object.values(result.requirements).some(r => r.reason === "no_extractor") ? "awaiting-caller-proposal" : Object.values(result.requirements).some(r => r.reason === "assessment_context_overflow") ? "assessment-context-overflow" : input.deps.judge === null ? "no-judge-evidence-retained" : "round-limit";
      const physical = input.nativeObservation?.();
      accountingFold.add("rounds", 1); accountingFold.logical(usage); accountingFold.physical(physical);
      const cumulativeUsage = accountingFold.finish();
      const payload = { schemaVersion: 1 as const, result, stopReason, definitions: definitions(contract), proposals,
        accounting: { schemaVersion: 1 as const, ...cumulativeUsage },
        ...(physical !== undefined ? { physical } : {}) };
      validateRetainedResult(payload); payloadProposals(payload, contract);
      const resultRef = await stage(handle, canonical(payload)); resultRef.chunks.forEach(list);
      state.results = [...(state.results ?? []), { revision: base.revision + 1, roundId: rid, intent, contract: contractRef, result: resultRef }];
      const stateRef = await stage(handle, canonical(state)); stateRef.chunks.forEach(list);
      const pointer: DefinitionPointer = { schemaVersion: 1, definitionRevision: contractRef.digest, contract: contractRef, state: stateRef, ...(baselineRef ? { baselineContract: baselineRef } : {}) };
      const root = await handle.stageBody(canonical(pointer));
      list({ bodyId: root.bodyId, digest: `sha256:${root.bodyId.slice(2)}`, bytes: root.bytes });
      const detail = canonical({ schemaVersion: 1, root: root.bodyId });
      await handle.settleRound(rid, { status: result.status, measured: usage, uncertainty: input.deps.externalSignal?.aborted ? "caller-cancelled" : null }, { bindInstance: true });
      publicationSettled = true;
      const snapshot: RevisionSnapshot = { schemaVersion: 1, revision: base.revision + 1, parentRevision: base.revision, createdAt: Date.now(), requirementsDigest: base.requirementsDigest,
        bodies, rounds: [...base.rounds, { roundId: rid, intent, settledAt: Date.now(), usage }], outcome: { status: result.status, data: result.data, evidence: state.evidence.map(e => e.record) },
        audit: [{ at: Date.now(), kind: "definition-ref", detail }] };
      await handle.commitRevision({ expectedRevision: base.revision, snapshot }); await handle.release();
      const rows = Object.entries(result.requirements);
      const handoff: CallerRoundHandoff = { kind: "caller-assisted-investigation", schemaVersion: 2, investigationRef: ref, revision: snapshot.revision,
        definitionRevision: pointer.definitionRevision, definitionDigest: pointer.contract.digest, definitions: definitions(contract), baselineRequirementsDigest: base.requirementsDigest,
        round: { id: rid, status: "settled", intent }, stopReason: input.deps.externalSignal?.aborted ? "cancelled" : result.status === "complete" ? "work-fulfilled" : rows.some(([, r]) => r.reason === "no_extractor") ? "awaiting-caller-proposal" : rows.some(([, r]) => r.reason === "assessment_context_overflow") ? "assessment-context-overflow" : input.deps.judge === null ? "no-judge-evidence-retained" : "round-limit",
        result, evidence: state.evidence.map(e => ({ representationId: e.body.bodyId, digest: e.body.digest, evidenceId: e.record.evidenceId, url: e.record.url, format: e.format, ...(e.body.claimedSource !== undefined ? { suppliedProvenance: { claimedSource: e.body.claimedSource, verification: "unverified" as const } } : {}) })),
        gaps: rows.filter(([, r]) => r.status !== "satisfied").map(([id, r]) => `${proposals.some(p => p.fieldId === id) ? "proposal" : "requirement"}:${id}:${r.reason ?? "unresolved"}`), cumulativeUsage };
      return { result, handoff, handle, store, storeRoot: input.storeRoot, investigationRef: ref, contract };
    } catch (publicationError) {
      if (!publicationSettled) {
        try {
          await handle.settleRound(rid, { status: "failed", measured: usage, uncertainty: "definition-pointer-bound:measured-attempts-preserved" }, { bindInstance: true });
        } catch {
          // Settlement itself failed: report BOTH honestly — the original
          // publication error carries the accounting-unavailable fact; no
          // fabricated success, no swallowed original cause.
          reportSecondary(publicationError, "settlementFailure", "publication", rid, usage, "settlement-failed");
        }
      }
      throw publicationError;
    }
  } catch (e) { return await releaseAfterFailure(handle, e, rid, measuredFailureUsage(engineUsage)); }
}
