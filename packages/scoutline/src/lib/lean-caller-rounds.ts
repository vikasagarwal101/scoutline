import { createHash, randomUUID } from "node:crypto";
import { validateCallerPhysical, type CallerPhysicalSnapshot } from "./caller-physical.js";
import { ValidationError } from "./errors.js";
import { compileLeanContract, frozenLeanQueryPlan, runLeanInvestigation, prepareLeanCallerHistory, type LeanDeps, type LeanResult, type LeanUsage, type LeanEvidenceRecord, type LeanSeed, type LeanRoundCheckpoint } from "./lean-investigation.js";
import { ExpectedRevisionError, CorruptRecordError, openStore, type OwnershipHandle, type RetainedRecordStore, type RevisionSnapshot, type RetainedBodyRef, type OpenStoreOptions } from "./retained-record-store.js";

export interface CallerProposal {
  fieldId: string; mode: "string" | "classification"; value: string;
  definitionRevision: string; representationId?: string; digest?: string;
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
interface DefinitionPointer { schemaVersion: 1; definitionRevision: string; contract: Pointer; state: Pointer }
interface State {
  schemaVersion: 1;
  evidence: { record: Omit<LeanEvidenceRecord, "content">; body: RetainedBodyRef; format: string; suppliedAt: number }[];
  historyContinuity?: { schemaVersion: 1; fromRevision: 1 };
  checkpoint: LeanRoundCheckpoint; proposals: CallerProposal[]; coverageBasis: string;
  results?: { revision: number; roundId: string; intent: "start" | "continue"; contract: Pointer; result: Pointer }[];
}
export interface SuppliedProvenance { claimedSource: string; verification: "unverified" }
export type CallerEvidenceRecord = LeanEvidenceRecord & { suppliedProvenance?: SuppliedProvenance };
export type CallerResult = Omit<LeanResult, "evidence"> & { evidence: readonly CallerEvidenceRecord[] };
export interface CallerRoundHandoff {
  kind: "caller-assisted-investigation"; schemaVersion: 1; investigationRef: string; revision: number;
  definitionRevision: string; definitionDigest: string; definitions: Readonly<Record<string, string>>; baselineRequirementsDigest: string;
  round: { id: string; status: "settled"; intent: "start" | "continue" }; stopReason: string; result: CallerResult; gaps: readonly string[];
  evidence: readonly { representationId: string; digest: string; evidenceId: string; url: string; format: string; suppliedProvenance?: SuppliedProvenance }[];
  cumulativeUsage: { rounds: number; searches: number; reads: number; judgments: number; physicalAttempts: number | null; unknownStages: readonly string[] };
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
async function read(store: RetainedRecordStore, ref: string, p: Pointer, snapshot: RevisionSnapshot): Promise<string> {
  if (p === null || typeof p !== "object" || typeof p.digest !== "string" || !Array.isArray(p.chunks) || p.chunks.length > 128) throw new CorruptRecordError("Invalid retained chunk pointer.");
  let text = "";
  for (const b of p.chunks) {
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
  if ((input.leads?.length ?? 0) > 32 || (input.representations?.length ?? 0) > 16 || ((input as ContinueCallerRoundInput).proposals?.length ?? 0) > 24) throw new ValidationError("Feedback count cap exceeded.");
  for (const l of input.leads ?? []) { const u = new URL(l.url); if (!["https:", "http:"].includes(u.protocol) || u.username || u.password) throw new ValidationError("Invalid URL lead."); }
  for (const r of input.representations ?? []) if ((Object.hasOwn(r, "claimedSource") && typeof r.claimedSource !== "string") || !["text", "markdown", "json"].includes(r.format) || typeof r.content !== "string" || !r.content || Buffer.byteLength(r.content) > 16384) throw new ValidationError("Invalid bounded supplied representation.");
  if (Buffer.byteLength(canonical({ leads: input.leads, representations: input.representations, proposals: (input as ContinueCallerRoundInput).proposals })) > 1048576) throw new ValidationError("Feedback byte cap exceeded.");
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
function proposalsFor(contract: unknown, submitted: readonly CallerProposal[], state: State, evidence: readonly LeanEvidenceRecord[]): CallerProposal[] {
  const fields = compileLeanContract(contract).fields, ids = definitions(contract);
  for (const p of submitted) {
    if (p === null || typeof p !== "object" || Object.keys(p).some(k => !["fieldId", "mode", "value", "definitionRevision", "representationId", "digest", "quote", "charRange"].includes(k))) throw new ValidationError("Unknown proposal key.");
    const f = fields.find(f => f.id === p.fieldId);
    if (!f || p.definitionRevision !== ids[p.fieldId] || typeof p.value !== "string" || !["string", "classification"].includes(p.mode) || (f.schema.mode === "value") !== (p.mode === "string")) throw new ValidationError("Proposal definition/mode/value mismatch.");
    if (p.mode === "classification" && !f.schema.enum!.includes(p.value)) throw new ValidationError("Invalid classification label.");
    if (p.mode === "string" || p.representationId !== undefined) {
      const retained = state.evidence.find(e => e.body.bodyId === p.representationId && e.body.digest === p.digest);
      if (!retained) throw new ValidationError("Immutable proposal representation binding mismatch.");
      const source = evidence.find(e => e.evidenceId === retained.record.evidenceId)!;
      if (typeof p.quote !== "string" || !Array.isArray(p.charRange) || p.charRange.length !== 2 || !p.charRange.every(Number.isSafeInteger) || p.charRange[0] < 0 || p.charRange[1] <= p.charRange[0] || source.content.slice(...p.charRange) !== p.quote) throw new ValidationError("Proposal quote/range mismatch.");
    }
  }
  return [...state.proposals.filter(p => ids[p.fieldId] === p.definitionRevision && !submitted.some(n => n.fieldId === p.fieldId)), ...submitted];
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
  schemaVersion: 1; result: CallerResult; stopReason: string; definitions: Record<string, string>; proposals: CallerProposal[]; physical?: CallerPhysicalSnapshot;
}
function validateRetainedResult(value: unknown): asserts value is RetainedCallerResult {
  const v = value as RetainedCallerResult;
  if (!v || typeof v !== "object" || Object.keys(v).some(k => !["schemaVersion", "result", "stopReason", "definitions", "proposals", "physical"].includes(k)) || v.schemaVersion !== 1 || typeof v.stopReason !== "string" || !v.definitions || !Array.isArray(v.proposals)) throw new CorruptRecordError("Invalid retained caller result.");
  if (v.physical !== undefined) validateCallerPhysical(v.physical);
  const r = v.result;
  if (!r || r.schemaVersion !== 1 || !["complete", "partial"].includes(r.status) || !["semantic", "deterministic-only"].includes(r.assessment) || typeof r.question !== "string" || !r.data || !r.requirements || !Array.isArray(r.evidence) || !Array.isArray(r.acquisitionLog) || !Array.isArray(r.coverageNotes) || !r.usage || !Array.isArray(r.plan?.queries) || Object.keys(r.requirements).length > 3 || Buffer.byteLength(canonical(v)) > 524288) throw new CorruptRecordError("Invalid bounded retained result payload.");
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
  try {
    const payload: unknown = JSON.parse(await read(store, ref, latest.result, base));
    validateRetainedResult(payload);
    if (canonical(payload.definitions) !== canonical(definitions(stored))) throw new CorruptRecordError("Current result definition binding mismatch.");
    state.evidence = reconcileEvidence(state.evidence, payload.result.evidence);
  } catch (error) {
    if (error instanceof CorruptRecordError) throw error;
    throw new CorruptRecordError("Invalid current retained result authority.");
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
  const row = [...snapshot.audit].reverse().find(r => r.kind === "definition-ref");
  if (!row) throw new CorruptRecordError("Definition root unavailable.");
  const root = JSON.parse(row.detail) as { schemaVersion: number; root: string };
  if (root.schemaVersion !== 1 || !snapshot.bodies.some(b => b.bodyId === root.root)) throw new CorruptRecordError("Invalid committed root binding.");
  const pointer = JSON.parse((await store.readBody(investigationRef, root.root)).toString("utf8")) as DefinitionPointer;
  if (pointer.schemaVersion !== 1 || pointer.definitionRevision !== pointer.contract.digest) throw new CorruptRecordError("Invalid definition pointer.");
  const state = JSON.parse(await read(store, investigationRef, pointer.state, snapshot)) as State;
  if (state.schemaVersion !== 1 || !Array.isArray(state.results) || state.results.length !== snapshot.rounds.length) throw new CorruptRecordError("Complete caller result history unavailable.");
  const history: { revision: number; roundId: string; intent: string }[] = [];
  let selected: { entry: NonNullable<State["results"]>[number]; payload: RetainedCallerResult; contract: unknown } | undefined;
  for (const [i, entry] of state.results.entries()) {
    const round = snapshot.rounds[i];
    if (entry.revision !== i + 1 || entry.roundId !== round?.roundId || entry.intent !== round.intent) throw new CorruptRecordError("Result history binding mismatch.");
    const payload: unknown = JSON.parse(await read(store, investigationRef, entry.result, snapshot)); validateRetainedResult(payload);
    const contract: unknown = JSON.parse(await read(store, investigationRef, entry.contract, snapshot)); validateContract(contract);
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
  const contract = withLimits(input.contract, input.roundLimits), c = compileLeanContract(contract);
  const requirements = input.requirements ?? { schemaVersion: 1 as const, fields: Object.fromEntries(c.fields.map(f => [f.id, { definition: f.question, required: f.required }])) };
  const store = openStore({ root: input.storeRoot, ...input.storeOptions });
  const { investigationRef: ref } = await store.createInvestigation({ requirements });
  const handle = await store.acquireOwnership(ref);
  try { return await execute(input, store, handle, ref, (await store.inspect(ref)).committed!.snapshot, contract,
    { schemaVersion: 1, historyContinuity: { schemaVersion: 1, fromRevision: 1 }, evidence: [], checkpoint: { history: [], issuedQueries: [], leads: [] }, proposals: [], coverageBasis: "" }, "start"); }
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
    const row = [...base.audit].reverse().find(r => r.kind === "definition-ref");
    if (!row) throw new CorruptRecordError("Current definition pointer unavailable.");
    // Root-4 redesign: the audit row carries ONLY a bounded root-manifest
    // body reference — the pointer itself is a content-addressed body
    // (16KiB store bound), so round growth can never explode the audit row.
    const rootRef = JSON.parse(row.detail) as { schemaVersion: 1; root: string };
    if (rootRef === null || typeof rootRef !== "object" || rootRef.schemaVersion !== 1 || typeof rootRef.root !== "string" || !/^b:[0-9a-f]{64}$/.test(rootRef.root)) throw new CorruptRecordError("Invalid root manifest reference.");
    const pointer = JSON.parse((await store.readBody(input.investigationRef, rootRef.root)).toString("utf8")) as DefinitionPointer;
    if (pointer.schemaVersion !== 1 || pointer.definitionRevision !== pointer.contract.digest) throw new CorruptRecordError("Invalid definition identity.");
    const stored = JSON.parse(await read(store, input.investigationRef, pointer.contract, base)); validateContract(stored);
    const state = JSON.parse(await read(store, input.investigationRef, pointer.state, base)) as State;
    if (state.schemaVersion !== 1 || !Array.isArray(state.evidence) || !Array.isArray(state.proposals) || !Array.isArray(state.checkpoint?.history)) throw new CorruptRecordError("Invalid retained state.");
    await hydrateCurrentEvidence(store, input.investigationRef, base, pointer, stored, state);
    return await execute(input, store, handle, input.investigationRef, base, withLimits(input.contract ?? stored, input.roundLimits), state, "continue", definitions(stored));
  } catch (e) { return await releaseAfterFailure(handle, e); }
}
async function execute(input: StartCallerRoundInput | ContinueCallerRoundInput, store: RetainedRecordStore, handle: OwnershipHandle,
  ref: string, base: RevisionSnapshot, contract: unknown, state: State, intent: "start" | "continue", storedDefinitions?: Readonly<Record<string, string>>): Promise<CallerRoundOutcome> {
  const evidence: LeanEvidenceRecord[] = [];
  for (const e of state.evidence) {
    const b = await store.readBody(ref, e.body.bodyId);
    if (b.length !== e.body.bytes || hash(b.toString("utf8")) !== e.body.digest) throw new CorruptRecordError("Retained evidence identity mismatch.");
    evidence.push({ ...e.record, content: b.toString("utf8") });
  }
  const proposals = proposalsFor(contract, (input as ContinueCallerRoundInput).proposals ?? [], state, evidence);
  const submittedProposals = (input as ContinueCallerRoundInput).proposals ?? [];
  if (Object.hasOwn(state, "historyContinuity") && (!state.historyContinuity || state.historyContinuity.schemaVersion !== 1 || state.historyContinuity.fromRevision !== 1 || Object.keys(state.historyContinuity).some(k => !["schemaVersion", "fromRevision"].includes(k)))) throw new CorruptRecordError("Invalid caller history continuity marker.");
  const identity = input.judgeIdentity === undefined || input.policyRevision === undefined ? undefined
    : canonical([input.judgeIdentity, input.policyRevision, input.deps.judge !== null, (input.deps as { candidateJudge?: unknown }).candidateJudge != null]);
  const candidates = proposals.filter(p => p.mode === "string").map(p => {
    const retained = state.evidence.find(e => e.body.bodyId === p.representationId && e.body.digest === p.digest)!;
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
  state.proposals = proposals;
  const admitted = await stage(handle, canonical(state)); admitted.chunks.forEach(list);
  const admittedPointer = canonical({ schemaVersion: 1, definitionRevision: contractRef.digest, contract: contractRef, state: admitted });
  const admittedRoot = await handle.stageBody(admittedPointer); list({ bodyId: admittedRoot.bodyId, digest: `sha256:${admittedRoot.bodyId.slice(2)}`, bytes: admittedRoot.bytes });
  await handle.appendAudit({ at: Date.now(), kind: "definition-ref", detail: canonical({ schemaVersion: 1, root: admittedRoot.bodyId }) });
  // Full cumulative history is durable. Current candidate selection belongs
  // to the typed engine seam; never delete a prior disposition here.
  let engineUsage: LeanUsage | undefined;
  const seed: LeanSeed = { evidence, leads,
    issuedQueries, history: checkpoint.history,
    identity, callerHistory: prepared.history,
    retainEvidence: async e => { await retain(e); }, capture: s => { checkpoint = s; }, captureUsage: u => { engineUsage = u; } };
  const deps: LeanDeps & { seed: LeanSeed; extract?: unknown } = { ...input.deps, seed };
  const stringBound = proposals.filter(p => p.mode === "string" && p.representationId !== undefined);
  if (stringBound.length > 0) deps.extract = async (request: { sourceId: string; fields: readonly { id: string }[] }) => {
    const record = state.evidence.find(e => e.record.evidenceId === request.sourceId);
    const entries = Object.fromEntries(request.fields.map(f => { const p = proposals.find(p => p.fieldId === f.id && p.mode === "string" && p.representationId === record?.body.bodyId);
      return [f.id, p ? { value: p.value, quote: p.quote, charRange: p.charRange } : { value: null, quote: null }]; }));
    return { finishReason: "stop", rawOutput: JSON.stringify(entries), usage: null, observedCost: null, elapsedMs: 0, requestSha256: hash(canonical(entries)).slice(7) }; };
  try {
    let result: CallerResult;
    try { result = await runLeanInvestigation(contract, deps); }
    catch (engineError) {
      const measured = measuredFailureUsage(engineUsage);
      if (measured === null) reportSecondary(engineError, "settlementFailure", "engine-rejection", rid, null, "usage-unavailable");
      else {
        try { await handle.settleRound(rid, { status: "failed", measured, uncertainty: "engine-run-failed:measured-attempts-preserved" }); }
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
      const payload = { schemaVersion: 1 as const, result, stopReason, definitions: definitions(contract), proposals,
        ...(input.nativeObservation ? { physical: input.nativeObservation() } : {}) };
      validateRetainedResult(payload);
      const resultRef = await stage(handle, canonical(payload)); resultRef.chunks.forEach(list);
      state.results = [...(state.results ?? []), { revision: base.revision + 1, roundId: rid, intent, contract: contractRef, result: resultRef }];
      const stateRef = await stage(handle, canonical(state)); stateRef.chunks.forEach(list);
      const pointer: DefinitionPointer = { schemaVersion: 1, definitionRevision: contractRef.digest, contract: contractRef, state: stateRef };
      const root = await handle.stageBody(canonical(pointer));
      list({ bodyId: root.bodyId, digest: `sha256:${root.bodyId.slice(2)}`, bytes: root.bytes });
      const detail = canonical({ schemaVersion: 1, root: root.bodyId });
      await handle.settleRound(rid, { status: result.status, measured: usage, uncertainty: input.deps.externalSignal?.aborted ? "caller-cancelled" : null });
      publicationSettled = true;
      const snapshot: RevisionSnapshot = { schemaVersion: 1, revision: base.revision + 1, parentRevision: base.revision, createdAt: Date.now(), requirementsDigest: base.requirementsDigest,
        bodies, rounds: [...base.rounds, { roundId: rid, intent, settledAt: Date.now(), usage }], outcome: { status: result.status, data: result.data, evidence: state.evidence.map(e => e.record) },
        audit: [{ at: Date.now(), kind: "definition-ref", detail }] };
      await handle.commitRevision({ expectedRevision: base.revision, snapshot }); await handle.release();
      const cumulativeUsage = { rounds: snapshot.rounds.length, searches: 0, reads: 0, judgments: 0, physicalAttempts: null, unknownStages: ["acquisition", "judge", "producer"] };
      for (const r of snapshot.rounds) if (r.usage) { cumulativeUsage.searches += r.usage.searches; cumulativeUsage.reads += r.usage.reads; cumulativeUsage.judgments += r.usage.judgments; }
      const rows = Object.entries(result.requirements);
      const handoff: CallerRoundHandoff = { kind: "caller-assisted-investigation", schemaVersion: 1, investigationRef: ref, revision: snapshot.revision,
        definitionRevision: pointer.definitionRevision, definitionDigest: pointer.contract.digest, definitions: definitions(contract), baselineRequirementsDigest: base.requirementsDigest,
        round: { id: rid, status: "settled", intent }, stopReason: input.deps.externalSignal?.aborted ? "cancelled" : result.status === "complete" ? "work-fulfilled" : rows.some(([, r]) => r.reason === "no_extractor") ? "awaiting-caller-proposal" : rows.some(([, r]) => r.reason === "assessment_context_overflow") ? "assessment-context-overflow" : input.deps.judge === null ? "no-judge-evidence-retained" : "round-limit",
        result, evidence: state.evidence.map(e => ({ representationId: e.body.bodyId, digest: e.body.digest, evidenceId: e.record.evidenceId, url: e.record.url, format: e.format, ...(e.body.claimedSource !== undefined ? { suppliedProvenance: { claimedSource: e.body.claimedSource, verification: "unverified" as const } } : {}) })),
        gaps: rows.filter(([, r]) => r.status !== "satisfied").map(([id, r]) => `${proposals.some(p => p.fieldId === id) ? "proposal" : "requirement"}:${id}:${r.reason ?? "unresolved"}`), cumulativeUsage };
      return { result, handoff, handle, store, storeRoot: input.storeRoot, investigationRef: ref, contract };
    } catch (publicationError) {
      if (!publicationSettled) {
        try {
          await handle.settleRound(rid, { status: "failed", measured: usage, uncertainty: "definition-pointer-bound:measured-attempts-preserved" });
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
