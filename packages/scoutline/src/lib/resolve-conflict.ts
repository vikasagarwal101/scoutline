/**
 * Conflicting-evidence resolution consumer (seed 06 first slice, review
 * e09442fd repair). Reconciles a small caller-supplied set of competing
 * claims about a software-release license WITHOUT inventing consensus.
 *
 * Division of labor: the consumer owns the discrepancy inventory, scope
 * partitioning, mirror collapsing, URL admission at the dispatch boundary,
 * and the reconciliation projection. Judgment and acceptance stay in the
 * shared lean engine (runLeanInvestigation) — this module never scores,
 * votes or judges anything itself.
 *
 * Invariants (seed 06 rules + review P1/P2 repairs):
 *  - original alternatives and their source identities are preserved
 *    verbatim in every outcome, resolved or not;
 *  - AT MOST ONE correction can resolve, and only as an exact pair: the
 *    correcting record AND the superseded record must both be retained by
 *    the engine, the obligation question names both URLs, the judge must
 *    accept it under explicit authority/scope criteria, and the accepted
 *    license value must come from the correcting record AND match the
 *    declared correction value — anything else abstains;
 *  - a scalar is selected only when that whole path holds AND every
 *    material alternative is covered by verified evidence: an
 *    out-of-scope claim partitions out only when retained evidence
 *    corroborates its declared scope; unread or uncorroborated
 *    alternatives remain explicit blockers, never silently dropped;
 *  - mirrors/copies are one originating claim — never independent votes,
 *    never separate acquisition targets; canonical-identical search
 *    results are suppressed at dispatch, and a caller's unverified mirror
 *    claim can never collapse another material alternative;
 *  - the license dispute projection is separate from correction verdicts
 *    and requires the engine to have established actual opposite license
 *    values on two sides;
 *  - caller cancellation vetoes the projection entirely — held evidence
 *    and unknowns stay visible in the engine result, but no
 *    reconciliation object is produced;
 *  - every input URL passes the existing caller admission screen
 *    (assertCallerUrl) before validation completes, and again at every
 *    read/search dispatch.
 */
import {
  runLeanInvestigation,
  type LeanContract,
  type LeanDeps,
  type LeanEvidenceRecord,
  type LeanFieldRow,
  type LeanResult,
  type LeanUsage,
} from "./lean-investigation.js";
import type { LeanUnifiedDeps } from "./lean-investigation.js";
import { assertCallerUrl } from "./caller-url.js";
import { candidateIdentity, candidateSourceDigest, type CandidateFieldOutcome } from "./lean-candidates.js";
import { ValidationError } from "./errors.js";

// ---------------------------------------------------------------------------
// Caller input (untrusted — validated fail-loud before any acquisition)
// ---------------------------------------------------------------------------

export interface ConflictMirrorSource {
  readonly url: string;
  readonly title?: string;
}

export interface ConflictAlternative {
  readonly id: string;
  /** Original claimed value, recorded verbatim — never normalized away. */
  readonly value: string;
  readonly source: { readonly url: string; readonly title?: string };
  /** The scope this claim describes (its own entity/release). */
  readonly scope: { readonly entity: string; readonly release: string };
  /** Alternative id this claim explicitly supersedes (a hypothesis until
   *  the engine accepts the pair-bound correction obligation). */
  readonly correctionOf?: string | null;
  /** Copies of this origin. Recorded, never counted as independent claims. */
  readonly mirrors?: readonly ConflictMirrorSource[];
}

export interface ResolveConflictInput {
  readonly schemaVersion: 1;
  /** The caller's requested scope; alternatives outside it are partitioned. */
  readonly scope: { readonly entity: string; readonly release: string };
  readonly alternatives: readonly ConflictAlternative[];
  /** Passed through to the engine contract (budgets). */
  readonly limits?: LeanContract["limits"];
}

// ---------------------------------------------------------------------------
// Reconciliation projection (consumer-owned output)
// ---------------------------------------------------------------------------

export type AlternativeRelationship =
  | "different-scope"
  | "scope-unverified"
  | "superseded-by-correction"
  | "selection-source"
  | "unverified-correction"
  | "unexplained-conflict";

export interface AlternativeExplanation {
  readonly relationship: AlternativeRelationship;
  readonly detail: string;
  /** Seed rule that produced this relationship. */
  readonly rule: string;
  readonly evidence: readonly { readonly evidenceId?: string; readonly url: string }[];
}

export interface ResolvedAlternative {
  readonly id: string;
  readonly value: string;
  readonly source: { readonly url: string; readonly title?: string };
  readonly scope: { readonly entity: string; readonly release: string };
  readonly correctionOf: string | null;
  readonly mirrors: readonly ConflictMirrorSource[];
  readonly explanation: AlternativeExplanation;
}

export interface SelectedValue {
  readonly value: string;
  readonly basis: {
    readonly requirement: string;
    readonly evidenceId: string;
    readonly sourceDigest: string;
    readonly url: string;
    readonly quote: string;
    /** The verified correction claim whose record produced this value. */
    readonly correctingClaimId: string;
  };
}

export interface ConflictResolution {
  readonly schemaVersion: 1;
  readonly scope: { readonly entity: string; readonly release: string };
  readonly status: "resolved" | "disputed" | "unresolved";
  readonly selected?: SelectedValue;
  /** Every original alternative, preserved verbatim, each explained. */
  readonly alternatives: readonly ResolvedAlternative[];
  /** License-value disagreement only — never derived from correction verdicts. */
  readonly dispute?: {
    readonly established: boolean;
    readonly requirement: string;
    /** When established: each side exactly bound by BOTH engine identity
     *  witnesses (payload + assessment) to a retained evidence document
     *  with its validated quote, char range and digest. Distinct sides
     *  describe distinct retained documents — no publisher-origin
     *  authentication is claimed. */
    readonly sides?: readonly {
      readonly sourceId: string;
      readonly url: string;
      readonly value: string;
      readonly quote: string;
      readonly charRange: readonly [number, number];
      readonly sourceDigest: string;
      readonly candidateId: string;
      readonly assessmentId: string;
    }[];
  };
  /** Unmet obligations and coverage blockers — the honest gaps. */
  readonly gaps: readonly { readonly requirement: string; readonly reason: string }[];
  /** Admission drops and unverified-identity observations. */
  readonly notes: readonly string[];
  readonly engine: {
    readonly usage: LeanUsage;
    readonly coverageNotes: readonly string[];
    readonly evidenceIds: readonly string[];
  };
}

export interface ResolveConflictOutcome {
  /** null when the caller cancelled: held evidence stays in engineResult. */
  readonly resolution: ConflictResolution | null;
  readonly cancelled: boolean;
  /** Full engine result for audit; the projection above is derived from it. */
  readonly engineResult: LeanResult;
}

// ---------------------------------------------------------------------------
// Validation (trust boundary — zero acquisition on failure)
// ---------------------------------------------------------------------------

const MAX_ALTERNATIVES = 16;
const MAX_MIRRORS = 16;

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/** Conservative canonical fetch identity: scheme/host case, default port
 *  and fragment only. Path and query stay verbatim — anything more
 *  aggressive would let unverified near-matches collapse origins. */
export function canonicalFetchIdentity(url: string): string {
  const u = new URL(url);
  const port = u.port === "" || (u.protocol === "https:" && u.port === "443") || (u.protocol === "http:" && u.port === "80") ? "" : `:${u.port}`;
  return `${u.protocol}//${u.hostname.toLowerCase()}${port}${u.pathname}${u.search}`;
}

function scopeOf(value: unknown, what: string): { entity: string; release: string } {
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    !nonEmpty((value as { entity?: unknown }).entity) || !nonEmpty((value as { release?: unknown }).release)
  ) {
    throw new ValidationError(`Invalid conflicting-evidence input: ${what} needs non-empty entity and release.`);
  }
  const s = value as { entity: string; release: string };
  return { entity: s.entity, release: s.release };
}

/** Existing public-URL admission screen applied to every input URL. */
function admittedUrl(value: unknown, what: string): string {
  if (!nonEmpty(value)) throw new ValidationError(`Invalid conflicting-evidence input: ${what} must be a non-empty string.`);
  try {
    assertCallerUrl(value);
  } catch (error) {
    throw new ValidationError(`Invalid conflicting-evidence input: ${what} was refused by URL admission (${(error as Error).message})`);
  }
  return value;
}

function validatedAlternatives(value: unknown): ConflictAlternative[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ALTERNATIVES) {
    throw new ValidationError(`Invalid conflicting-evidence input: alternatives must be a non-empty array of at most ${MAX_ALTERNATIVES}.`);
  }
  const out: ConflictAlternative[] = [];
  const ids = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new ValidationError("Invalid conflicting-evidence input: each alternative must be an object.");
    }
    const a = raw as Record<string, unknown>;
    if (!nonEmpty(a.id) || ids.has(a.id as string)) {
      throw new ValidationError("Invalid conflicting-evidence input: alternative ids must be non-empty and unique.");
    }
    ids.add(a.id as string);
    if (!nonEmpty(a.value)) throw new ValidationError("Invalid conflicting-evidence input: alternative value must be a non-empty string.");
    const source = a.source as Record<string, unknown> | undefined;
    const url = admittedUrl(source?.url, "alternative source.url");
    const mirrors: ConflictMirrorSource[] = [];
    if (a.mirrors !== undefined) {
      if (!Array.isArray(a.mirrors) || a.mirrors.length > MAX_MIRRORS) {
        throw new ValidationError(`Invalid conflicting-evidence input: mirrors must be an array of at most ${MAX_MIRRORS}.`);
      }
      for (const m of a.mirrors) {
        const rec = m as Record<string, unknown> | null;
        const mirrorUrl = admittedUrl(rec?.url, "mirror url");
        if (rec!.title !== undefined && !nonEmpty(rec!.title)) throw new ValidationError("Invalid conflicting-evidence input: mirror title must be a non-empty string.");
        mirrors.push({ url: mirrorUrl, ...(nonEmpty(rec!.title) ? { title: rec!.title } : {}) });
      }
    }
    if (a.correctionOf !== undefined && a.correctionOf !== null && !nonEmpty(a.correctionOf)) {
      throw new ValidationError("Invalid conflicting-evidence input: correctionOf must be an alternative id or null.");
    }
    out.push({
      id: a.id as string,
      value: a.value as string,
      source: { url, ...(nonEmpty(source!.title) ? { title: source!.title } : {}) },
      scope: scopeOf(a.scope, "alternative scope"),
      correctionOf: (a.correctionOf ?? null) as string | null,
      mirrors,
    });
  }
  for (const a of out) {
    const target = a.correctionOf ?? null;
    if (target !== null) {
      if (!ids.has(target)) throw new ValidationError(`Invalid conflicting-evidence input: correctionOf '${target}' does not reference an alternative.`);
      let cursor: string | null = a.id;
      const seen = new Set<string>();
      while (cursor !== null) {
        if (seen.has(cursor)) throw new ValidationError("Invalid conflicting-evidence input: correction chains must not cycle.");
        seen.add(cursor);
        cursor = out.find(x => x.id === cursor)!.correctionOf ?? null;
      }
    }
  }
  return out;
}

function validatedInput(input: unknown): { scope: { entity: string; release: string }; alternatives: ConflictAlternative[]; limits?: LeanContract["limits"] } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ValidationError("Invalid conflicting-evidence input: expected an object.");
  }
  const rec = input as Record<string, unknown>;
  if (rec.schemaVersion !== 1) throw new ValidationError("Invalid conflicting-evidence input: schemaVersion must be 1.");
  const limits = rec.limits;
  if (limits !== undefined && (!limits || typeof limits !== "object" || Array.isArray(limits) || !Object.values(limits).every(v => typeof v === "number" && Number.isFinite(v) && v >= 0))) {
    throw new ValidationError("Invalid conflicting-evidence input: limits must be finite non-negative numbers.");
  }
  return { scope: scopeOf(rec.scope, "scope"), alternatives: validatedAlternatives(rec.alternatives), limits: limits as LeanContract["limits"] | undefined };
}

// ---------------------------------------------------------------------------
// Consumer
// ---------------------------------------------------------------------------

const RULE_PARTITION = "partition-before-judging";
const RULE_SCOPE_EVIDENCE = "scope-corroboration-by-retained-evidence";
const RULE_CORRECTION = "explicit-correction-evidence";
const RULE_UNVERIFIED = "correction-requires-acceptance";
const RULE_PRESERVE = "preserve-alternatives";

const CORRECTION_CRITERIA = [
  "The correcting document must explicitly state that it supersedes the target licensing notice.",
  "The correction must apply to the same release as the requested scope.",
  "The correcting document must be issued by the same release channel (origin host) as the target notice.",
] as const;

/** First-slice correction authority policy: the correcting record must sit
 *  on the same origin host as the notice it supersedes. */
function sameChannel(a: string, b: string): boolean {
  return new URL(a).hostname.toLowerCase() === new URL(b).hostname.toLowerCase();
}

/**
 * Resolve a conflicting-evidence set under the caller's requested scope.
 * `deps` are the caller's engine dependencies (acquisition + semantics);
 * this module attaches only the lead seed derived from the inventory,
 * wraps read/search with the existing URL admission screen, and never
 * installs its own judge.
 */
export async function resolveConflict(
  input: unknown,
  deps: LeanDeps & Partial<Pick<LeanUnifiedDeps, "extract" | "candidateJudge" | "extractorRevision">>,
): Promise<ResolveConflictOutcome> {
  const { scope, alternatives, limits } = validatedInput(input);
  const notes: string[] = [];

  const inScope = (a: ConflictAlternative): boolean =>
    a.scope.entity === scope.entity && a.scope.release === scope.release;

  const material = alternatives.filter(inScope);
  const correctionClaims = alternatives.filter(a => (a.correctionOf ?? null) !== null);

  // --- narrow first-slice shapes: one resolvable pair, one scope subject --
  const shapeGaps: { requirement: string; reason: string }[] = [];
  let pair: { claim: ConflictAlternative; target: ConflictAlternative } | null = null;
  if (correctionClaims.length > 1) {
    shapeGaps.push({ requirement: "correction-shape", reason: `at most one correction can resolve in the first slice; ${correctionClaims.length} declared` });
  } else if (correctionClaims.length === 1) {
    const claim = correctionClaims[0]!;
    const target = alternatives.find(a => a.id === claim.correctionOf)!;
    const reasons: string[] = [];
    if (!inScope(claim)) reasons.push("correcting claim is outside the requested scope");
    if (!inScope(target)) reasons.push("superseded claim is outside the requested scope");
    if ((target.correctionOf ?? null) !== null) reasons.push("correction chains are not a supported shape");
    if (canonicalFetchIdentity(claim.source.url) === canonicalFetchIdentity(target.source.url)) reasons.push("correcting and superseded records must have distinct canonical fetch identities");
    if (!sameChannel(claim.source.url, target.source.url)) reasons.push("authority policy requires the same origin host for the correcting record");
    if (reasons.length === 0) pair = { claim, target };
    else shapeGaps.push({ requirement: "correction-shape", reason: reasons.join("; ") });
  }
  // Positive scope partition needs a dedicated applicability obligation
  // per out-of-scope alternative; the engine's 3-field ceiling makes more
  // than one an unsupported shape (abstain, alternatives preserved).
  const outOfScopeAlts = alternatives.filter(a => !inScope(a));
  let scopeSubject: ConflictAlternative | null = null;
  if (outOfScopeAlts.length > 1) {
    shapeGaps.push({ requirement: "scope-shape", reason: `at most one out-of-scope alternative can be partitioned in the first slice; ${outOfScopeAlts.length} declared` });
  } else if (outOfScopeAlts.length === 1) {
    scopeSubject = outOfScopeAlts[0]!;
  }

  // --- narrowly declared obligations --------------------------------------
  const licenseQuestion = `Which license applies to ${scope.entity} ${scope.release}?`;
  const requirements: Record<string, unknown> = {
    license: {
      question: licenseQuestion,
      schema: { type: "string" },
      required: true,
    },
  };
  if (pair !== null) {
    // Pair-bound: the judge is asked about THESE records, not a generic
    // "some correction exists" question that would rubber-stamp every
    // caller-declared link.
    requirements.correction = {
      question: `Does the correction document at ${pair.claim.source.url} explicitly supersede the licensing notice at ${pair.target.source.url} for the license of ${scope.entity} ${scope.release}?`,
      criteria: CORRECTION_CRITERIA,
      schema: { enum: ["supported", "refuted", "disputed"] },
      required: true,
    };
  } else if (correctionClaims.length === 0) {
    // License-value disagreement only; the judge must find actual
    // opposite values asserted by two same-scope sides.
    requirements.dispute = {
      question: `Do retained same-scope documents assert opposite license values for ${scope.entity} ${scope.release} (two sides with actual opposite values)?`,
      schema: { enum: ["supported", "refuted", "disputed"] },
      required: false,
    };
  }
  if (scopeSubject !== null) {
    // POSITIVE applicability proof for the single out-of-scope-declared
    // alternative: the engine judges whether that record's licensing
    // statement applies to the requested scope at all. A candidate
    // support=false verdict alone never stands in for this.
    requirements.applicability = {
      question: `Does the licensing statement at ${scopeSubject.source.url} apply to the license of ${scope.entity} ${scope.release}?`,
      schema: { enum: ["supported", "refuted", "disputed"] },
      required: true,
    };
  }
  const contract: Record<string, unknown> = {
    schemaVersion: 1,
    question: pair !== null
      ? `Assess the explicit correction for ${scope.entity} ${scope.release}.`
      : `Assess the license conflict for ${scope.entity} ${scope.release}.`,
    scope,
    requirements,
  };
  if (limits !== undefined) contract.limits = limits;

  // --- acquisition boundary: admission + conservative canonical identity --
  // An unverified mirror claim must never suppress another alternative:
  // if a canonical fetch identity is claimed by more than one
  // alternative (a mirror of one equals the source of another), both
  // stay independent origins and the overlap is recorded, not acted on.
  const identityOwners = new Map<string, Set<string>>();
  const recordIdentity = (url: string, id: string): void => {
    const key = canonicalFetchIdentity(url);
    const owners = identityOwners.get(key) ?? new Set<string>();
    owners.add(id);
    identityOwners.set(key, owners);
  };
  for (const a of alternatives) {
    recordIdentity(a.source.url, a.id);
    for (const m of a.mirrors ?? []) recordIdentity(m.url, a.id);
  }
  for (const [key, owners] of identityOwners) {
    if (owners.size > 1) notes.push(`unverified-mirror-overlap: canonical identity ${key} is claimed by ${[...owners].join(", ")}; all retained as distinct evidence documents, no publisher-origin claim`);
  }
  // Admission only at the dispatch boundary — NO result suppression. The
  // shared engine owns repeat handling (exact-URL queue dedupe, byte caps,
  // read failures); suppressing search results on resolved reads would let
  // a body the engine later rejected (oversize, refused) disappear from
  // contrary coverage. Everything admitted reaches the engine or fails
  // visibly in its acquisition log.
  const readAdmitted = async (url: string, options?: Parameters<LeanDeps["read"]>[1]): Promise<string> => {
    assertCallerUrl(url);
    return deps.read(url, options);
  };
  const searchAdmitted = async (query: string, options?: Parameters<LeanDeps["search"]>[1]) => {
    const results = await deps.search(query, options);
    const kept: { url: string; title?: string }[] = [];
    for (const r of results) {
      try {
        assertCallerUrl(r.url);
      } catch {
        notes.push(`search-result-refused: ${String(r.url)} failed URL admission`);
        continue;
      }
      kept.push({ url: r.url, ...(r.title !== undefined ? { title: r.title } : {}) });
    }
    return kept;
  };

  // One acquisition target per originating claim — mirrors are copies of a
  // known origin and never seeded as independent work.
  const leads: { url: string; title: string }[] = [];
  const seenIdentities = new Set<string>();
  for (const a of alternatives) {
    const id = canonicalFetchIdentity(a.source.url);
    if (seenIdentities.has(id)) continue;
    seenIdentities.add(id);
    leads.push({ url: a.source.url, title: a.source.title ?? a.id });
  }

  // The seed (lead URLs from the inventory) rides on deps exactly as the
  // engine's caller-rounds path expects; cast because LeanDeps types the
  // optional seed slot loosely on purpose.
  const engineResult = await runLeanInvestigation(contract, {
    ...deps,
    read: readAdmitted,
    search: searchAdmitted,
    seed: { leads },
  } as LeanDeps);

  // --- caller cancellation vetoes the projection entirely -----------------
  const cancelled =
    (deps as { externalSignal?: AbortSignal }).externalSignal?.aborted === true ||
    Object.values(engineResult.requirements).some(row => row.reason === "cancelled");
  if (cancelled) return { resolution: null, cancelled: true, engineResult };

  // --- projection ----------------------------------------------------------

  const rows = engineResult.requirements as Readonly<Record<string, LeanFieldRow>>;
  const evidenceByUrl = new Map(engineResult.evidence.map(e => [e.url, e]));
  const ref = (url: string): { evidenceId?: string; url: string } => {
    const rec = evidenceByUrl.get(url);
    return rec ? { evidenceId: rec.evidenceId, url } : { url };
  };

  const accepted = (row: LeanFieldRow | undefined, value: string): boolean =>
    row?.status === "satisfied" && row?.value === value;

  /** Current accepted per-source verdicts of a row (last judged round). */
  const currentVerdicts = (row: LeanFieldRow | undefined) => {
    const rounds = row?.assessments;
    return rounds !== undefined && rounds.length > 0 ? rounds[rounds.length - 1]! : [];
  };

  const correctionRow = rows.correction;
  const licenseRow = rows.license;
  const correctionRefuted = accepted(correctionRow, "refuted");

  // Exact retained pair + judge proof ON the correcting record itself: the
  // accepted 'supported' verdict must include a current relevant/supporting
  // verdict for the correcting record's own evidence id — an unrelated
  // document being the sole supporter proves nothing about the pair.
  const pairRetained = pair !== null &&
    evidenceByUrl.has(pair.claim.source.url) && evidenceByUrl.has(pair.target.source.url);
  const correctingRecord = pair !== null ? evidenceByUrl.get(pair.claim.source.url) : undefined;
  const correctingVerdict = correctingRecord !== undefined
    ? currentVerdicts(correctionRow).find(v => v.evidenceId === correctingRecord.evidenceId)
    : undefined;
  const correctingSupports = correctingVerdict?.relevant === true && correctingVerdict.supportsClaim === true;
  const correctionVerified = pair !== null && pairRetained && accepted(correctionRow, "supported") && correctingSupports;

  // Accepted value must come from the correcting record AND match the
  // declared correction value.
  const licenseAccepted = licenseRow?.status === "satisfied" && typeof licenseRow.value === "string";
  const provenance = licenseRow?.provenance;
  const acceptedSourceUrl = provenance !== undefined
    ? engineResult.evidence.find(e => e.evidenceId === provenance.sourceId)?.url
    : undefined;
  const sourceBound = pair !== null && acceptedSourceUrl === pair.claim.source.url;
  const valueBound = pair !== null && licenseAccepted === true && sourceBound && licenseRow!.value === pair.claim.value;

  // Per-source candidate judgments — CURRENCY + IDENTITY RULES (fix5).
  // The audit is append-only, so the MOST RECENT record for a source
  // decides, and a record counts only when BOTH witnesses bind:
  //   1. CURRENCY: a later FAILED attempt (empty assessments) voids older
  //      support; the record's opposing-IDs snapshot must equal the FULL
  //      FINAL retained opposing set; records rejected for IDENTITY or
  //      PROTOCOL INTEGRITY (judgement_context_mismatch,
  //      candidate/source identity or digest mismatches, invalid raw
  //      scores) are invalid proof — while legitimate non-accepted
  //      verdicts (material_conflict, support_refuted/unknown,
  //      conflict_unknown, not_accepted) remain valid evidence: the
  //      superseded target legitimately carries support-but-conflict.
  //   2. IDENTITY: the engine's own candidateIdentity must reproduce BOTH
  //      the outcome's payload id (source+digest+value+quote+range) and
  //      the judgment's assessment id (payload + live field meaning,
  //      scope, full final opposing context with digests/urls, dependency
  //      bindings) — exact recomputation, no structural guessing.
  // If either witness cannot be bound safely, the proof stays unverified.
  const licenseMeaning = licenseQuestion; // no field criteria or contract evidence criteria declared
  interface ProofWitness { support: boolean | null; conflict: boolean | null; value: string; outcome: CandidateFieldOutcome; assessmentId: string }
  const INVALID_PROOF_REASONS: ReadonlySet<string> = new Set([
    "judgement_context_mismatch", "judged_candidate_mismatch", "judged_context_required",
    "candidate_identity_mismatch", "source_digest_mismatch", "raw_score_invalid", "normalized_raw_inconsistency",
  ]);
  const finalOpposingIdsFor = (sourceId: string): string[] =>
    engineResult.evidence.filter(e => e.evidenceId !== sourceId).map(e => e.evidenceId).sort();
  const payloadBoundOutcome = (record: LeanEvidenceRecord, value: string): CandidateFieldOutcome | undefined => {
    const digest = candidateSourceDigest(record);
    const matches: CandidateFieldOutcome[] = [];
    for (const outcome of licenseRow?.candidates ?? []) {
      if (outcome.candidateId === undefined || outcome.value !== value || outcome.quote === undefined || outcome.charRange === undefined) continue;
      if (candidateIdentity(record, digest, "license", outcome.value, outcome.quote, outcome.charRange) === outcome.candidateId) matches.push(outcome);
    }
    return matches.length === 1 ? matches[0] : undefined;
  };
  const proofWitnessFor = (record: LeanEvidenceRecord): ProofWitness | null => {
    const records = licenseRow?.attemptedRecords ?? [];
    for (let i = records.length - 1; i >= 0; i -= 1) {
      const r = records[i]!;
      const meta = r.metadata as { kind?: string; sourceId?: string; opposingIds?: unknown } | null;
      if (meta?.kind !== "candidate-judgment" || meta.sourceId !== record.evidenceId) continue;
      const assessment = (Array.isArray(r.assessments) ? r.assessments[0] : undefined) as { support?: boolean | null; conflict?: boolean | null; value?: string; candidateId?: string } | undefined;
      if (assessment === undefined) return null; // failed current attempt: no inheritance
      if (r.reason !== undefined && INVALID_PROOF_REASONS.has(r.reason)) return null; // integrity-rejected: invalid proof
      const opposingIds = Array.isArray(meta.opposingIds) ? [...meta.opposingIds].map(String).sort() : null;
      if (opposingIds === null || JSON.stringify(opposingIds) !== JSON.stringify(finalOpposingIdsFor(record.evidenceId))) {
        return null; // judged under a non-final opposing context: stale
      }
      if (assessment.value === undefined || assessment.candidateId === undefined || assessment.candidateId === "") return null;
      const outcome = payloadBoundOutcome(record, assessment.value);
      if (outcome === undefined) return null; // payload witness failed
      const assessmentId = candidateIdentity(record, candidateSourceDigest(record), "license", outcome.value!, outcome.quote!, outcome.charRange!, {
        fieldMeaning: licenseMeaning,
        scope,
        opposingContext: engineResult.evidence.filter(e => e.evidenceId !== record.evidenceId),
        depBindings: {},
      });
      if (assessmentId !== assessment.candidateId) return null; // assessment witness failed
      return { support: assessment.support ?? null, conflict: assessment.conflict ?? null, value: assessment.value, outcome, assessmentId };
    }
    return null; // never judged on any context
  };

  // POSITIVE scope partition: the single out-of-scope-declared alternative
  // is excluded only when its applicability obligation was REFUTED by the
  // engine with a current relevant+refuting verdict on that exact record.
  // A candidate support=false verdict never substitutes for this; a
  // supported/unresolved/disputed applicability keeps the alternative a
  // visible blocker.
  const applicabilityRow = rows.applicability;
  const scopeRecord = scopeSubject !== null ? evidenceByUrl.get(scopeSubject.source.url) : undefined;
  const scopeVerdict = scopeRecord !== undefined
    ? currentVerdicts(applicabilityRow).find(v => v.evidenceId === scopeRecord.evidenceId)
    : undefined;
  const scopeExcluded = scopeSubject !== null && scopeRecord !== undefined &&
    accepted(applicabilityRow, "refuted") && scopeVerdict?.relevant === true && scopeVerdict.refutesClaim === true;


  // Target accountability: 'superseded' requires POSITIVE proof that the
  // target record itself asserts the caller-declared value in this scope —
  // a CURRENT protocol-valid supporting candidate judgment with BOTH the
  // payload and assessment identity witnesses bound to that exact record,
  // its quote/range/digest, the live scope and the full final opposing
  // context. Final acceptance of the contradicted target is NOT required
  // — it is the side being superseded. Retention alone, a mutated declared
  // target value, or a mutated target record scope proves nothing.
  const targetRecord = pair !== null ? evidenceByUrl.get(pair.target.source.url) : undefined;
  const targetWitness = targetRecord !== undefined ? proofWitnessFor(targetRecord) : null;
  const targetClaimEvidenced = pair !== null && targetRecord !== undefined &&
    targetWitness !== null && targetWitness.support === true && targetWitness.value === pair.target.value;
  const supersededVerified = correctionVerified && targetClaimEvidenced === true;

  const fallback = correctionRefuted ? "unexplained-conflict" : "unverified-correction";
  const resolvedAlternatives: ResolvedAlternative[] = alternatives.map(a => {
    let explanation: AlternativeExplanation;
    if (!inScope(a)) {
      if (scopeSubject !== null && a.id === scopeSubject.id && scopeExcluded) {
        explanation = {
          relationship: "different-scope",
          detail: `The engine's applicability judgment evidenced, on the record itself, that its licensing statement does NOT apply to the requested scope ${scope.entity} ${scope.release} (declared scope ${a.scope.entity} ${a.scope.release} is the caller's assertion, not a verified alternate scope); not a contradiction here.`,
          rule: RULE_PARTITION,
          evidence: [ref(a.source.url)],
        };
      } else if (scopeSubject !== null && a.id === scopeSubject.id && accepted(applicabilityRow, "supported")) {
        explanation = {
          relationship: "unexplained-conflict",
          detail: `Declared ${a.scope.entity} ${a.scope.release}, but the engine's applicability judgment SUPPORTS the record applying to the requested scope; kept as a material blocker.`,
          rule: RULE_PRESERVE,
          evidence: [ref(a.source.url)],
        };
      } else {
        explanation = {
          relationship: "scope-unverified",
          detail: `Declared ${a.scope.entity} ${a.scope.release} is outside the requested scope, but no positive engine applicability refutation excludes it; kept as a blocker.`,
          rule: RULE_SCOPE_EVIDENCE,
          evidence: [ref(a.source.url)],
        };
      }
    } else if (pair !== null && a.id === pair.claim.id) {
      explanation = supersededVerified
        ? {
            relationship: "selection-source",
            detail: `Engine accepted the explicit pair-bound correction with the target's own claim evidenced (${pair.target.id} superseded by this record).`,
            rule: RULE_CORRECTION,
            evidence: [ref(a.source.url)],
          }
        : {
            relationship: fallback,
            detail: correctionRefuted
              ? `Correction of ${a.correctionOf} was refuted by engine evidence; plain conflict remains.`
              : `Correction of ${a.correctionOf} claimed but not established by accepted pair-bound engine evidence.`,
            rule: correctionRefuted ? RULE_PRESERVE : RULE_UNVERIFIED,
            evidence: [ref(a.source.url)],
          };
    } else if (pair !== null && a.id === pair.target.id) {
      explanation = supersededVerified
        ? {
            relationship: "superseded-by-correction",
            detail: `Superseded by an engine-accepted explicit correction from ${pair.claim.source.url}; this record's own in-scope claim of '${pair.target.value}' is positively evidenced.`,
            rule: RULE_CORRECTION,
            evidence: [ref(pair.claim.source.url), ref(a.source.url)],
          }
        : {
            relationship: fallback,
            detail: correctionRefuted
              ? `The correction superseding this claim was refuted; plain conflict remains.`
              : `A correction superseding this claim was declared but not established${!pairRetained ? " (pair not retained by the engine)" : correctionVerified && !targetClaimEvidenced ? " (the target's declared claim is not positively evidenced on its record)" : ""}.`,
            rule: correctionRefuted ? RULE_PRESERVE : RULE_UNVERIFIED,
            evidence: [ref(a.source.url)],
          };
    } else if ((a.correctionOf ?? null) !== null || correctionClaims.some(c => c.correctionOf === a.id)) {
      // Correction involvement outside the supported shape.
      explanation = {
        relationship: "unverified-correction",
        detail: `Involved in a correction relationship the first slice cannot verify (unsupported shape).`,
        rule: RULE_UNVERIFIED,
        evidence: [ref(a.source.url)],
      };
    } else {
      explanation = {
        relationship: "unexplained-conflict",
        detail: `Same-scope alternative with no verified correction or scope partition covering it.`,
        rule: RULE_PRESERVE,
        evidence: engineResult.evidence.map(e => ({ evidenceId: e.evidenceId, url: e.url })),
      };
    }
    return {
      id: a.id,
      value: a.value,
      source: a.source,
      scope: a.scope,
      correctionOf: a.correctionOf ?? null,
      mirrors: a.mirrors ?? [],
      explanation,
    };
  });

  // --- gaps and selection ---------------------------------------------------
  const gaps: { requirement: string; reason: string }[] = [...shapeGaps];
  for (const [id, row] of Object.entries(rows)) {
    if (row.status === "unresolved") gaps.push({ requirement: id, reason: row.reason ?? "unresolved" });
  }
  const covered = new Set(["different-scope", "superseded-by-correction", "selection-source"]);
  const uncovered = resolvedAlternatives.filter(a => !covered.has(a.explanation.relationship));

  let selected: SelectedValue | undefined;
  if (pair !== null && !correctionVerified && !gaps.some(g => g.requirement === "correction")) {
    gaps.push({
      requirement: "correction",
      reason: !pairRetained
        ? "correcting/superseded pair not both retained by the engine"
        : accepted(correctionRow, "supported") && !correctingSupports
          ? "accepted correction verdict carries no current relevant/supporting verdict on the correcting record itself"
          : correctionRow?.reason ?? "pair-bound correction not accepted",
    });
  }
  if (correctionVerified && !targetClaimEvidenced) {
    gaps.push({
      requirement: "correction-target-claim",
      reason: pair !== null && targetWitness !== null
        ? `the target record's current witnessed judgment shows value '${targetWitness.value}', not the declared '${pair.target.value}'; supersession not evidenced`
        : "no current protocol-valid supporting judgment with bound payload+assessment identity on the target record (failed, stale-context, context-mismatch or absent); supersession not evidenced",
    });
  }
  if (correctionVerified && licenseAccepted === true && !sourceBound) {
    gaps.push({
      requirement: "correction-source-binding",
      reason: `accepted license came from ${acceptedSourceUrl ?? "an unknown record"}, not the correcting record ${pair!.claim.source.url}`,
    });
  } else if (correctionVerified && licenseAccepted === true && !valueBound) {
    gaps.push({
      requirement: "correction-value-binding",
      reason: `accepted license '${licenseRow!.value}' does not match the declared correction value '${pair!.claim.value}'`,
    });
  }
  if (correctionVerified && supersededVerified && valueBound && uncovered.length === 0 && provenance !== undefined) {
    const source = engineResult.evidence.find(e => e.evidenceId === provenance.sourceId)!;
    selected = {
      value: licenseRow!.value!,
      basis: {
        requirement: "license",
        evidenceId: provenance.sourceId,
        sourceDigest: provenance.sourceDigest,
        url: source.url,
        quote: provenance.quote,
        correctingClaimId: pair!.claim.id,
      },
    };
  } else if (correctionVerified && supersededVerified && valueBound && uncovered.length > 0) {
    gaps.push({ requirement: "coverage", reason: `${uncovered.length} material alternative(s) not explained by verified evidence.` });
  }

  // License dispute: no two-URL proxy, no alias or duplicate-representation
  // counting, no guessed quotes. A side counts only when BOTH identity
  // witnesses bind (payload + assessment) on a current supporting judgment
  // for a retained record. Byte-identical representations (same source
  // digest) collapse to one side — distinct fetch URLs alone prove nothing
  // about independent evidence, and no publisher-origin authentication is
  // claimed: sides describe distinct retained evidence documents.
  // Establishment needs >=2 surviving sides with DISTINCT values AND
  // DISTINCT canonical fetch identities; otherwise the generic verdict
  // stays an unverified audit note.
  const sideByDigest = new Map<string, { sourceId: string; url: string; value: string; quote: string; charRange: readonly [number, number]; sourceDigest: string; candidateId: string; assessmentId: string }>();
  for (const record of engineResult.evidence) {
    const witness = proofWitnessFor(record);
    if (witness === null || witness.support !== true) continue;
    const digest = candidateSourceDigest(record);
    if (!sideByDigest.has(digest)) {
      sideByDigest.set(digest, {
        sourceId: record.evidenceId,
        url: record.url,
        value: witness.value,
        quote: witness.outcome.quote!,
        charRange: witness.outcome.charRange!,
        sourceDigest: digest,
        candidateId: witness.outcome.candidateId!,
        assessmentId: witness.assessmentId,
      });
    }
  }
  const supportedValueClaims = [...sideByDigest.values()];
  const disputeVerdictSupported = accepted(rows.dispute, "supported");
  const distinctValues = new Set(supportedValueClaims.map(c => c.value));
  const distinctOrigins = new Set(supportedValueClaims.map(c => canonicalFetchIdentity(c.url)));
  const disputeEstablished = disputeVerdictSupported && distinctValues.size >= 2 && distinctOrigins.size >= 2;
  if (disputeVerdictSupported && !disputeEstablished) {
    notes.push(`dispute-verdict-unverified: disagreement verdict supported, but only ${distinctValues.size} exactly-bound distinct value(s) across ${distinctOrigins.size} distinct retained document(s); kept as audit evidence`);
  }
  const status: ConflictResolution["status"] =
    selected !== undefined ? "resolved" : disputeEstablished ? "disputed" : "unresolved";

  const resolution: ConflictResolution = {
    schemaVersion: 1,
    scope,
    status,
    ...(selected !== undefined ? { selected } : {}),
    alternatives: resolvedAlternatives,
    ...(rows.dispute !== undefined
      ? {
          dispute: {
            established: disputeEstablished,
            requirement: "dispute",
            ...(disputeEstablished ? { sides: supportedValueClaims } : {}),
          },
        }
      : {}),
    gaps,
    notes,
    engine: {
      usage: engineResult.usage,
      coverageNotes: engineResult.coverageNotes,
      evidenceIds: engineResult.evidence.map(e => e.evidenceId),
    },
  };
  return { resolution, cancelled: false, engineResult };
}
