import { createHash, randomUUID } from "node:crypto";
import { validateCallerPhysical, type CallerPhysicalSnapshot } from "./caller-physical.js";
import { ValidationError } from "./errors.js";
import { compileLeanContract, runLeanInvestigation, type LeanDeps, type LeanResult, type LeanEvidenceRecord, type LeanSeed, type LeanRoundCheckpoint } from "./lean-investigation.js";
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
  checkpoint: LeanRoundCheckpoint; proposals: CallerProposal[]; coverageBasis: string;
  results?: { revision: number; roundId: string; intent: "start" | "continue"; contract: Pointer; result: Pointer }[];
}
export interface CallerRoundHandoff {
  kind: "caller-assisted-investigation"; schemaVersion: 1; investigationRef: string; revision: number;
  definitionRevision: string; definitionDigest: string; definitions: Readonly<Record<string, string>>; baselineRequirementsDigest: string;
  round: { id: string; status: "settled"; intent: "start" | "continue" }; stopReason: string; result: LeanResult; gaps: readonly string[];
  evidence: readonly { representationId: string; digest: string; evidenceId: string; url: string; format: string }[];
  cumulativeUsage: { rounds: number; searches: number; reads: number; judgments: number; physicalAttempts: number | null; unknownStages: readonly string[] };
}
export interface CallerRoundOutcome {
  result: LeanResult; handoff: CallerRoundHandoff; store: RetainedRecordStore; storeRoot: string; investigationRef: string; contract: unknown;
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
  for (const k of Object.keys(input)) if (!["schemaVersion", "question", "scope", "requirements", "evidenceCriteria", "limits"].includes(k)) throw new ValidationError(`Unknown contract key ${k}.`);
  compileLeanContract(input);
}
function definitions(contract: unknown): Record<string, string> {
  const c = compileLeanContract(contract);
  return Object.fromEntries(c.fields.map(f => [f.id, hash(canonical([c.question, c.scope, c.evidenceCriteria, f]))]));
}
function withLimits(contract: unknown, lower?: Record<string, number>): unknown {
  if (lower === undefined) return contract;
  const requested = compileLeanContract({ ...(contract as object), limits: lower }).limits;
  const old = compileLeanContract(contract).limits;
  const values = Object.fromEntries(Object.keys(lower).map(k => [k, Math.min((requested as unknown as Record<string, number>)[k]!, (old as unknown as Record<string, number>)[k]!)]));
  return { ...(contract as object), limits: { ...((contract as { limits?: object }).limits ?? {}), ...values } };
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
  for (const r of input.representations ?? []) if (!["text", "markdown", "json"].includes(r.format) || typeof r.content !== "string" || !r.content || Buffer.byteLength(r.content) > 16384) throw new ValidationError("Invalid bounded supplied representation.");
  if (Buffer.byteLength(canonical({ leads: input.leads, representations: input.representations, proposals: (input as ContinueCallerRoundInput).proposals })) > 1048576) throw new ValidationError("Feedback byte cap exceeded.");
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
export interface RetainedCallerResult {
  schemaVersion: 1; result: LeanResult; stopReason: string; definitions: Record<string, string>; proposals: CallerProposal[]; physical?: CallerPhysicalSnapshot;
}
function validateRetainedResult(value: unknown): asserts value is RetainedCallerResult {
  const v = value as RetainedCallerResult;
  if (!v || typeof v !== "object" || Object.keys(v).some(k => !["schemaVersion", "result", "stopReason", "definitions", "proposals", "physical"].includes(k)) || v.schemaVersion !== 1 || typeof v.stopReason !== "string" || !v.definitions || !Array.isArray(v.proposals)) throw new CorruptRecordError("Invalid retained caller result.");
  if (v.physical !== undefined) validateCallerPhysical(v.physical);
  const r = v.result;
  if (!r || r.schemaVersion !== 1 || !["complete", "partial"].includes(r.status) || !["semantic", "deterministic-only"].includes(r.assessment) || typeof r.question !== "string" || !r.data || !r.requirements || !Array.isArray(r.evidence) || !Array.isArray(r.acquisitionLog) || !Array.isArray(r.coverageNotes) || !r.usage || !Array.isArray(r.plan?.queries) || Object.keys(r.requirements).length > 3 || Buffer.byteLength(canonical(v)) > 524288) throw new CorruptRecordError("Invalid bounded retained result payload.");
  for (const e of r.evidence) if (typeof e.content !== "string" || Buffer.byteLength(e.content) > 16384 || typeof e.evidenceId !== "string" || typeof e.url !== "string" || !Array.isArray(e.origins)) throw new CorruptRecordError("Invalid retained result evidence.");
  for (const n of [r.usage.searches, r.usage.readAttempts, r.usage.judgeCalls, r.usage.candidateJudgeCalls]) if (!Number.isSafeInteger(n) || n < 0) throw new CorruptRecordError("Invalid retained result usage.");
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
  const contract = withLimits(input.contract, input.roundLimits), c = compileLeanContract(contract);
  const requirements = input.requirements ?? { schemaVersion: 1 as const, fields: Object.fromEntries(c.fields.map(f => [f.id, { definition: f.question, required: f.required }])) };
  const store = openStore({ root: input.storeRoot, ...input.storeOptions });
  const { investigationRef: ref } = await store.createInvestigation({ requirements });
  const handle = await store.acquireOwnership(ref);
  try { return await execute(input, store, handle, ref, (await store.inspect(ref)).committed!.snapshot, contract,
    { schemaVersion: 1, evidence: [], checkpoint: { history: [], issuedQueries: [], leads: [] }, proposals: [], coverageBasis: "" }, "start"); }
  catch (e) { await handle.release(); throw e; }
}
export async function continueCallerRound(input: ContinueCallerRoundInput): Promise<CallerRoundOutcome> {
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
    return await execute(input, store, handle, input.investigationRef, base, withLimits(input.contract ?? stored, input.roundLimits), state, "continue");
  } catch (e) { await handle.release(); throw e; }
}
async function execute(input: StartCallerRoundInput | ContinueCallerRoundInput, store: RetainedRecordStore, handle: OwnershipHandle,
  ref: string, base: RevisionSnapshot, contract: unknown, state: State, intent: "start" | "continue"): Promise<CallerRoundOutcome> {
  const evidence: LeanEvidenceRecord[] = [];
  for (const e of state.evidence) {
    const b = await store.readBody(ref, e.body.bodyId);
    if (b.length !== e.body.bytes || hash(b.toString("utf8")) !== e.body.digest) throw new CorruptRecordError("Retained evidence identity mismatch.");
    evidence.push({ ...e.record, content: b.toString("utf8") });
  }
  const proposals = proposalsFor(contract, (input as ContinueCallerRoundInput).proposals ?? [], state, evidence);
  const submittedProposals = (input as ContinueCallerRoundInput).proposals ?? [];
  // Snapshot the STORED proposals before the merged list overwrites them:
  // the changed-binding compare below must see what the prior round
  // actually committed, not the incoming submission reflected back.
  const storedProposals = state.proposals.map(p => ({ ...p }));
  if (input.deps.externalSignal?.aborted) throw new ValidationError("Round cancelled before dispatch.");
  const rid = `r-${randomUUID()}`; await handle.beginRound({ roundId: rid, intent });
  const bodies = [...base.bodies]; let newBytes = 0;
  const list = (b: RetainedBodyRef): void => { if (!bodies.some(x => x.bodyId === b.bodyId)) bodies.push(b); };
  const retain = async (record: LeanEvidenceRecord, format = "text"): Promise<void> => {
    const bytes = Buffer.byteLength(record.content), digest = hash(record.content);
    if (bytes > 16384) throw new ValidationError("Body exceeds representation ceiling.");
    if (!state.evidence.some(e => e.body.digest === digest)) { newBytes += bytes; if (newBytes > 262144) throw new ValidationError("New round byte cap exceeded."); }
    const staged = await handle.stageBody(record.content), body = { bodyId: staged.bodyId, digest, bytes: staged.bytes }; list(body);
    if (!state.evidence.some(e => e.record.evidenceId === record.evidenceId)) { const { content: _, ...metadata } = record; state.evidence.push({ record: metadata, body, format, suppliedAt: Date.now() }); }
  };
  for (const r of input.representations ?? []) { const e: LeanEvidenceRecord = { evidenceId: `e${evidence.length + 1}`, url: `caller:${randomUUID()}`, title: r.label ?? "Caller-supplied", content: r.content, byteLength: Buffer.byteLength(r.content), origins: [] }; await retain(e, r.format); evidence.push(e); }
  const contractRef = await stage(handle, canonical(contract)); contractRef.chunks.forEach(list);
  state.proposals = proposals;
  const admitted = await stage(handle, canonical(state)); admitted.chunks.forEach(list);
  const admittedPointer = canonical({ schemaVersion: 1, definitionRevision: contractRef.digest, contract: contractRef, state: admitted });
  const admittedRoot = await handle.stageBody(admittedPointer); list({ bodyId: admittedRoot.bodyId, digest: `sha256:${admittedRoot.bodyId.slice(2)}`, bytes: admittedRoot.bytes });
  await handle.appendAudit({ at: Date.now(), kind: "definition-ref", detail: canonical({ schemaVersion: 1, root: admittedRoot.bodyId }) });
  const c = compileLeanContract(contract), basis = hash(canonical([c.question, c.scope, c.fields, c.evidenceCriteria]));
  const reuse = state.coverageBasis === basis;
  let checkpoint = state.checkpoint;
  // A CHANGED proposal (value/quote/range/source/definition) invalidates
  // the affected field's restored candidate accept even on identical
  // evidence — the new binding must be assessed, never ignored behind the
  // prior accept. Dependents reopen transitively; unchanged independent
  // fields keep their history; identical resubmission re-buys nothing.
  if (submittedProposals.length > 0) {
    const fields = compileLeanContract(contract).fields;
    const affected = new Set<string>();
    const collect = (id: string): void => {
      if (affected.has(id)) return; affected.add(id);
      for (const f of fields) if (f.dependsOn.includes(id)) collect(f.id);
    };
    for (const p of submittedProposals) {
      const prior = storedProposals.find(x => x.fieldId === p.fieldId);
      if (prior === undefined) continue;
      const changed = prior.value !== p.value || prior.quote !== p.quote
        || canonical(prior.charRange) !== canonical(p.charRange)
        || prior.representationId !== p.representationId || prior.digest !== p.digest;
      if (changed) collect(p.fieldId);
    }
    if (affected.size > 0) {
      checkpoint = { ...checkpoint, history: checkpoint.history.filter(h => {
        const m = h.namespace.match(/"id":"([^"]+)"/);
        return !(m !== null && m[1] !== undefined && affected.has(m[1]));
      }) };
    }
  }
  const seed: LeanSeed = { evidence, leads: [...(reuse ? checkpoint.leads : []), ...(input.leads ?? []).map(l => ({ url: l.url, title: l.title ?? l.url }))],
    issuedQueries: reuse ? checkpoint.issuedQueries : [], history: checkpoint.history,
    identity: input.judgeIdentity === undefined || input.policyRevision === undefined
      ? undefined
      : canonical([input.judgeIdentity, input.policyRevision, input.deps.judge !== null, (input.deps as { candidateJudge?: unknown }).candidateJudge != null]),
    retainEvidence: async e => { await retain(e); }, capture: s => { checkpoint = s; } };
  const deps: LeanDeps & { seed: LeanSeed; extract?: unknown } = { ...input.deps, seed };
  const stringBound = proposals.filter(p => p.mode === "string" && p.representationId !== undefined);
  if (stringBound.length > 0) deps.extract = async (request: { sourceId: string; fields: readonly { id: string }[] }) => {
    const record = state.evidence.find(e => e.record.evidenceId === request.sourceId);
    const entries = Object.fromEntries(request.fields.map(f => { const p = proposals.find(p => p.fieldId === f.id && p.mode === "string" && p.representationId === record?.body.bodyId);
      return [f.id, p ? { value: p.value, quote: p.quote, charRange: p.charRange } : { value: null, quote: null }]; }));
    return { finishReason: "stop", rawOutput: JSON.stringify(entries), usage: null, observedCost: null, elapsedMs: 0, requestSha256: hash(canonical(entries)).slice(7) }; };
  try {
    const result = await runLeanInvestigation(contract, deps);
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
        result, evidence: state.evidence.map(e => ({ representationId: e.body.bodyId, digest: e.body.digest, evidenceId: e.record.evidenceId, url: e.record.url, format: e.format })),
        gaps: rows.filter(([, r]) => r.status !== "satisfied").map(([id, r]) => `${proposals.some(p => p.fieldId === id) ? "proposal" : "requirement"}:${id}:${r.reason ?? "unresolved"}`), cumulativeUsage };
      return { result, handoff, handle, store, storeRoot: input.storeRoot, investigationRef: ref, contract };
    } catch (publicationError) {
      if (!publicationSettled) {
        try {
          await handle.settleRound(rid, { status: "failed", measured: usage, uncertainty: "definition-pointer-bound:measured-attempts-preserved" });
        } catch (settlementError) {
          // Settlement itself failed: report BOTH honestly — the original
          // publication error carries the accounting-unavailable fact; no
          // fabricated success, no swallowed original cause.
          (publicationError as { settlementFailure?: unknown }).settlementFailure = settlementError instanceof Error ? settlementError.message : String(settlementError);
        }
      }
      throw publicationError;
    }
  } catch (e) { await handle.release(); throw e; }
}
