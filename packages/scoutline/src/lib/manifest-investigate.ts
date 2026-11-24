/**
 * Lane-owned consumer entry point for the v3 structured-document-
 * extraction first slice: run ONE retained public/synthetic UTF-8
 * release manifest through the merged lean investigation engine and
 * return the engine's acceptance decisions.
 *
 * Division of labor (kept strict):
 *  - document-manifest.ts admits the text (UTF-16 well-formedness and
 *    byte ceiling BEFORE any hashing or parsing), parses the grammar and
 *    proposes candidates (deterministic, no model, exact original UTF-16
 *    spans, explicit abstention);
 *  - the SHARED engine (runLeanInvestigation) owns acquisition bounds,
 *    candidate validation, judgment and acceptance (acceptCandidate);
 *  - this module only wires them — nothing here decides acceptance.
 *
 * Source attribution is honest: the caller must explicitly admit the
 * material class ("public" or "synthetic" — the owner-confirmed
 * first-increment scope), and the claimed URL is recorded as an
 * UNVERIFIED claim. Retaining the manifest establishes content identity
 * (SHA-256), never a verification of its claimed origin. Every derived
 * artifact binds to one OWN IMMUTABLE SNAPSHOT captured at admission —
 * later mutation of the caller's input object cannot reach the record,
 * the read seam, or the parse report.
 *
 * CLOSED DOCUMENT SET — no fake acquisition. This slice configures NO
 * external search: the search dependency refuses loudly and the engine
 * records search-failed events (a failed search is never coverage, and
 * nothing is faked as a successful one). Contrary coverage for the
 * slice's fields closes through the engine's closed-evidence capability
 * (deps.closedEvidence, a private adapter capability declared HERE —
 * never a client-assertable contract key): the retained manifest record
 * is the one declared source, and acceptance publishes only while its
 * retained bytes match the admission digest, through the engine's
 * unchanged acceptCandidate and final-context proof checks. Without a
 * judge (no consent, no authorized runtime judge) nothing is judged and
 * the honest outcome stays unresolved/proposals.
 */

import { createHash } from "node:crypto";
import { CancellationError, ValidationError } from "./errors.js";
import {
  RELEASE_MANIFEST_FIELD_BINDINGS,
  RELEASE_MANIFEST_GRAMMAR_ID,
  RELEASE_MANIFEST_PRODUCER_REVISION,
  admitManifestText,
  manifestExtractorAttempt,
  parseReleaseManifest,
  resolveDocumentProducer,
} from "./document-manifest.js";
import type {
  LeanCandidateJudgeInput,
  LeanCandidateJudgeResponse,
  LeanEvidenceRecord,
  LeanResult,
} from "./lean-investigation.js";
import { runLeanInvestigation } from "./lean-investigation.js";

/**
 * Explicit admission of the retained material. `materialClass` confines
 * the slice to the owner-confirmed public/synthetic scope; `claimedUrl`
 * is the caller's CLAIM about origin and is carried as unverified.
 */
export interface ManifestAdmission {
  readonly materialClass: "public" | "synthetic";
  readonly claimedUrl: string;
  readonly title: string;
}

export interface ManifestInvestigationInput {
  /** Exact retained manifest text (the whole evidence representation). */
  readonly manifestText: string;
  /** Required consent: what the material is and where it claims to be from. */
  readonly admission: ManifestAdmission;
  /**
   * Declared producer id (admission). Defaults to the one registered
   * grammar; unknown ids fail closed.
   */
  readonly producerId?: string;
  /**
   * EXPLICIT judge-transmission consent, separate from material
   * admission. Not a claimable string or shape: the only accepted value
   * is the OfflineJudgeSeam token INSTANCE minted by this module's
   * createOfflineJudgeSeam factory, bound to its dispatcher through a
   * module-private WeakMap — IDENTITY, not resemblance, decides. A
   * copied lookalike (Object.assign spread of a real token with a
   * swapped dispatch) or an inherited object is rejected because it is
   * not the minted instance. Minting is a TRUSTED IN-PROCESS TEST SEAM:
   * it is not proof of offline execution and not production consent.
   * Optional: omitted (or denied) means no candidate judgment dispatches
   * at all — the engine retains validated candidates but accepts
   * nothing unless the workflow supplies its separately authorized runtime judge.
   */
  readonly judgeTransmission?: OfflineJudgeSeam;
  /** Deterministic by default; supply a real clock for deadline runs. */
  readonly now?: () => number;
  readonly externalSignal?: AbortSignal;
}

/**
 * Module-private identity registry: minted token -> the dispatcher it
 * captured at mint time. WeakMap keys make the binding one of OBJECT
 * IDENTITY — copies, spreads and prototypes are never keys.
 */
const offlineSeamDispatchers = new WeakMap<
  OfflineJudgeSeam,
  OfflineJudgeSeam["dispatch"]
>();

/**
 * Type-level nominal brand (`declare` — ZERO runtime footprint: no such
 * property exists on minted tokens at runtime). It makes OfflineJudgeSeam
 * OPAQUE as a TypeScript type: a structural lookalike `{ dispatch }` is a
 * compile ERROR everywhere outside this module, while the runtime gate
 * stays the WeakMap identity binding — two independent layers.
 */
declare const offlineSeamBrand: unique symbol;

/** Opaque test-collaborator token for judge transmission. Only
 *  createOfflineJudgeSeam can produce a value of this type. */
export interface OfflineJudgeSeam {
  readonly [offlineSeamBrand]: true;
  readonly dispatch: (
    input: LeanCandidateJudgeInput,
    options?: { timeoutMs: number; signal: AbortSignal },
  ) => Promise<LeanCandidateJudgeResponse>;
}

/**
 * Mint the one admitted judge-transmission token: a frozen wrapper whose
 * dispatcher is registered in this module's private WeakMap. This is a
 * TRUSTED IN-PROCESS TEST SEAM, never offline proof and never
 * production consent — production judge authorization lives in the
 * shared integration.
 */
export function createOfflineJudgeSeam(
  dispatch: (
    input: LeanCandidateJudgeInput,
    options?: { timeoutMs: number; signal: AbortSignal },
  ) => Promise<LeanCandidateJudgeResponse>,
): OfflineJudgeSeam {
  if (typeof dispatch !== "function") {
    throw new ValidationError("Offline judge seam dispatch must be a function.");
  }
  // The brand exists only in the type system; the runtime object carries
  // just the dispatch, and the WeakMap — not any property — decides
  // identity at the consent gate.
  const token = Object.freeze({ dispatch }) as OfflineJudgeSeam;
  offlineSeamDispatchers.set(token, dispatch);
  return token;
}

/**
 * Compile-time opacity guard — NEVER CALLED (zero runtime behavior), but
 * type-checked by every build. A forged object literal must FAIL to
 * type-check against the opaque seam type; if the nominal brand is ever
 * dropped, the unused `@ts-expect-error` becomes a build error, so
 * structural forgery cannot sneak back in silently. The minted-token
 * line below pins the positive direction: factory output IS the type.
 */
function seamCompileTimeGuard(): void {
  const minted: OfflineJudgeSeam = createOfflineJudgeSeam(async () => {
    throw new Error("unreachable");
  });
  void minted;
  // @ts-expect-error a forged literal lacks the nominal brand
  const forged: OfflineJudgeSeam = { dispatch: async () => {
    throw new Error("unreachable");
  } };
  void forged;
}
void seamCompileTimeGuard;

/**
 * Normal outcome: the run settled without the external signal winning.
 * The shape is unchanged from before the run-level cancellation marker
 * existed — existing consumers read result/parse/record as they always
 * did (discriminate on `cancelled` only when they care).
 */
export interface ManifestInvestigationOutcome {
  readonly cancelled: false;
  readonly result: LeanResult;
  /** Lane-visible parse detail of the SAME admitted snapshot: exact
   *  spans plus ambiguous/missing statuses the engine's unresolved rows
   *  collapse into "extractor_abstained"; `sourceDigest` binds it to the
   *  exact retained representation. Prepared ONCE from the owned
   * admitted body before the engine runs; never re-scanned after it. */
  readonly parse: ReturnType<typeof parseReleaseManifest>;
  /** The admitted material class ("public" | "synthetic"). */
  readonly materialClass: ManifestAdmission["materialClass"];
  /** The caller's claimed URL, echoed for attribution only. */
  readonly claimedUrl: string;
  /** Always "unverified": the claimed URL is attribution, not origin proof. */
  readonly claimedUrlVerification: "unverified";
  /** The frozen evidence record everything downstream binds to. Its url
   *  is the digest-derived opaque locator (never the claimed URL). */
  readonly record: LeanEvidenceRecord;
}

/**
 * Typed RUN-LEVEL cancelled indication (Qodo r4659857463) under the
 * STANDALONE ADAPTER SETTLEMENT CONTRACT: returned when the OWNED
 * captured signal aborts before this callable's continuation finishes
 * settling an INCOMPLETE result. This is deliberately NOT an assertion
 * that engine work was stopped — the tiny resource-teardown microtask
 * window at the end of the engine invocation falls inside callable
 * settlement and is disclosed here: an abort landing there still marks
 * the outcome cancelled. Row reasons are engine-owned (withholding or
 * judge-unavailable reasons appear for interrupted runs) and are never
 * consulted for this marker. Every field of the normal outcome is still
 * present — the EARNED PARTIAL EVIDENCE (retained sources,
 * extraction/judgment audit rows, any fields already satisfied) is
 * preserved, never dropped — so a consumer settling exit 130 can still
 * project what was earned. `stopReason` carries the settlement
 * vocabulary; the pre-dispatch windows keep their typed throws
 * (CancellationError). No success:false claim is made when the
 * signal wins — the marker, not an error envelope, is the settlement
 * signal. Pre-dispatch cancellation uses the shared USER_CANCELLED taxonomy.
 */
export interface ManifestRunCancelledOutcome {
  readonly cancelled: true;
  readonly stopReason: "cancelled";
  readonly result: LeanResult;
  readonly parse: ReturnType<typeof parseReleaseManifest>;
  readonly materialClass: ManifestAdmission["materialClass"];
  readonly claimedUrl: string;
  readonly claimedUrlVerification: "unverified";
  readonly record: LeanEvidenceRecord;
}

export type ManifestInvestigationSettlement =
  | ManifestInvestigationOutcome
  | ManifestRunCancelledOutcome;

/** First-slice contract shape (docs/plans/v3/FIRST-SLICE.json engineContract). */
export function manifestContract() {
  return {
    schemaVersion: 1,
    question: "Read the version and license from the retained public release manifest.",
    scope: { entity: "ExampleApp", documentType: "release-manifest" },
    requirements: {
      version: {
        question: "Which release version is stated in the manifest?",
        schema: { type: "string" },
        required: true,
      },
      license: {
        question: "Which license identifier is stated in the manifest?",
        schema: { type: "string" },
        required: true,
      },
    },
  } as const;
}

export function admitManifestInput(input: ManifestInvestigationInput): {
  readonly text: string;
  readonly admission: Readonly<ManifestAdmission>;
} {
  if (input.admission === null || typeof input.admission !== "object") {
    throw new ValidationError(
      "Manifest admission is required: declare materialClass (public|synthetic), claimedUrl and title.",
    );
  }
  const { materialClass, claimedUrl, title } = input.admission;
  if (materialClass !== "public" && materialClass !== "synthetic") {
    throw new ValidationError(
      'Manifest admission materialClass must be "public" or "synthetic" (private material is out of first-increment scope).',
    );
  }
  if (typeof claimedUrl !== "string" || claimedUrl.length === 0) {
    throw new ValidationError("Manifest admission claimedUrl must be a non-empty string.");
  }
  if (typeof title !== "string" || title.length === 0) {
    throw new ValidationError("Manifest admission title must be a non-empty string.");
  }
  // Material admission comes first, then bounds, both before any digest,
  // record or engine invocation.
  const text = admitManifestText(input.manifestText);
  return { text, admission: Object.freeze({ materialClass, claimedUrl, title }) };
}

/**
 * Build the immutable evidence record for an admitted manifest. The
 * record is frozen; its url is the DIGEST-DERIVED OPAQUE LOCATOR
 * (`urn:x-scoutline:manifest:sha256-<hex>`) — the identity the judge and
 * every provenance consumer see — never the caller's claimed URL. The
 * claim is attribution metadata only and stays out of the evidence
 * identity; content identity is established, origin is not.
 */
export function manifestEvidenceRecord(
  manifestText: string,
  admission: Readonly<ManifestAdmission>,
): LeanEvidenceRecord {
  const text = admitManifestText(manifestText);
  const hex = createHash("sha256").update(text, "utf8").digest("hex");
  return Object.freeze({
    evidenceId: `manifest-${hex.slice(0, 12)}`,
    url: `urn:x-scoutline:manifest:sha256-${hex}`,
    title: admission.title,
    content: text,
    byteLength: Buffer.byteLength(text, "utf8"),
    origins: Object.freeze([] as readonly string[]),
  });
}

/** Trusted judge-transmission route for the public CLI wiring (function
 *  parameter — caller JSON can never assert it). Mirrors the offline
 *  test seam's dispatch shape. */
export type AuthorizedRuntimeJudge = (
  input: LeanCandidateJudgeInput,
  options?: { timeoutMs: number; signal: AbortSignal },
) => Promise<LeanCandidateJudgeResponse>;

/**
 * Deps for the closed-document-set run. Exported so offline tests
 * compose the same wiring (e.g. omit `extract` for the producer-disabled
 * control). Everything derives from ONE admitted snapshot; mutating the
 * caller's input object afterwards changes nothing the engine sees.
 */
export function buildManifestDeps(
  input: ManifestInvestigationInput,
  options: { authorizedRuntimeJudge?: AuthorizedRuntimeJudge } = {},
) {
  const producer = resolveDocumentProducer(input.producerId ?? RELEASE_MANIFEST_GRAMMAR_ID);
  const { text, admission } = admitManifestInput(input);
  // OWNED SIGNAL CAPTURE: one synchronous read of the caller's property,
  // taken before any await — the object the deps bridge hands the engine
  // and the object every later cancellation check consults. A mid-flight
  // replacement of `input.externalSignal` cannot swap what this run
  // observes.
  const signal = input.externalSignal;
  const record = manifestEvidenceRecord(text, admission);
  if (input.judgeTransmission !== undefined && options.authorizedRuntimeJudge !== undefined) {
    throw new ValidationError(
      "Only one judge transmission route may be admitted: the caller test seam or the authorized runtime judge, never both.",
    );
  }
  const deps = {
    now: input.now ?? (() => 0),
    // Closed document set: NO external acquisition is configured. The
    // search dependency REFUSES — the engine logs search-failed and a
    // failed counterevidence search is not coverage, so nothing is
    // faked.
    search: async () => {
      throw Object.assign(new Error("Manifest closed-document-set: no acquisition configured."), {
        code: "MANIFEST_NO_ACQUISITION",
      });
    },
    read: async (url: string) => {
      if (url === record.url) return text;
      throw new ValidationError(`manifest_only_source:${url}`);
    },
    // Value-mode contract only; the enum judge is never dispatched, but
    // the engine gates acceptance on a configured judge — fail loud if
    // anything ever reaches it.
    judge: async () => {
      throw new ValidationError("enum_fields_not_declared_in_manifest_slice");
    },
    // Judge transmission is consent-gated: without an admitted capability
    // there is NO dispatch (null), and the engine keeps acceptance off.
    candidateJudge: manifestJudgeConsent(input) ?? options.authorizedRuntimeJudge ?? null,
    extract: producer.create(Object.keys(RELEASE_MANIFEST_FIELD_BINDINGS)).extract,
    extractorRevision: RELEASE_MANIFEST_PRODUCER_REVISION,
    ...(signal !== undefined ? { externalSignal: signal } : {}),
    seed: { evidence: [record] },
    // Closed evidence set (engine capability, v3 public integration):
    // the manifest record is the ONE declared source; both slice fields
    // close contrary coverage only while its retained bytes match the
    // admission digest.
    closedEvidence: {
      sources: [{ url: record.url, sha256: record.url.slice("urn:x-scoutline:manifest:sha256-".length) }],
      fieldSources: Object.fromEntries(
        Object.keys(RELEASE_MANIFEST_FIELD_BINDINGS).map((field) => [field, [record.url]]),
      ),
    },
  };
  // The captured signal is RETURNED: it is the exact object the engine's
  // deps bridge consulted, so the entry point's post-admission and
  // post-run cancellation checks read the OWNED signal — never a later
  // reread of the caller's mutable `input.externalSignal` property.
  return { deps, record, producer, admission, signal };
}

/**
 * Consent gate for judge transmission: undefined → null (no dispatch
 * ever); the ONLY admitted value is the exact token INSTANCE whose
 * dispatcher lives in this module's private WeakMap. Identity decides —
 * copied lookalikes (Object.assign spreads carrying a swapped dispatch),
 * inherited objects, strings and plain shapes all fail closed.
 */
function manifestJudgeConsent(
  input: ManifestInvestigationInput,
):
  | ((
      input: LeanCandidateJudgeInput,
      options?: { timeoutMs: number; signal: AbortSignal },
    ) => Promise<LeanCandidateJudgeResponse>)
  | null {
  const consent = input.judgeTransmission;
  if (consent === undefined) return null;
  if (
    consent === null ||
    typeof consent !== "object" ||
    typeof consent.dispatch !== "function"
  ) {
    throw new ValidationError(
      "Judge transmission consent must be an OfflineJudgeSeam minted by createOfflineJudgeSeam, or omitted; no other transmission route is admitted.",
    );
  }
  const bound = offlineSeamDispatchers.get(consent);
  if (bound === undefined || bound !== consent.dispatch) {
    throw new ValidationError(
      "Judge transmission consent must be an OfflineJudgeSeam minted by createOfflineJudgeSeam, or omitted; no other transmission route is admitted.",
    );
  }
  return bound;
}

/**
 * Run the first-slice flow over one retained manifest. Cancellation is
 * cooperative and front-loaded: an already-aborted signal throws BEFORE
 * any input is read or admitted; a signal aborting after admission
 * throws before the engine dispatch; a signal aborting during the run is
 * observed by the engine itself (it is bridged through deps), and the
 * outcome returns the parse PREPARED ONCE from the owned admitted body —
 * a post-run abort never triggers a fresh scan.
 *
 * Acceptance is the engine's: validateCandidates → assessCandidates →
 * acceptCandidate — over a closed document set, so without an explicit
 * retained digest matching the closed-source declaration, withheld fields
 * remain unresolved.
 */
export async function investigateReleaseManifest(
  input: ManifestInvestigationInput,
  options: { authorizedRuntimeJudge?: AuthorizedRuntimeJudge } = {},
): Promise<ManifestInvestigationSettlement> {
  // Pre-abort BEFORE reading input: nothing of the caller's material is
  // touched once cancellation is already signalled.
  if (input.externalSignal?.aborted) {
    throw new CancellationError("Manifest run aborted before admission.");
  }
  const { deps, record, admission, signal } = buildManifestDeps(input, options);
  // Prepare the parse ONCE from the OWNED admitted body — the report and
  // the engine dispatch share this snapshot, and no later mutation or
  // cancellation re-scans anything.
  const parse = parseReleaseManifest(record.content, Object.keys(RELEASE_MANIFEST_FIELD_BINDINGS));
  // Post-admission check on the OWNED captured signal — the same object
  // the deps bridge handed the engine, never a reread of the caller's
  // (replaceable) input.externalSignal property.
  if (signal?.aborted) {
    throw new CancellationError("Manifest run aborted after admission.");
  }
  // Settlement observer (standalone adapter contract): no authoritative
  // run-stop field exists on LeanResult, so the OWNED captured signal is
  // observed directly — the listener is attached immediately before the
  // engine dispatch and removed when the awaiting continuation resumes,
  // so the observed window is exactly the callable's settlement of the
  // result (engine work AND its trailing resource-teardown microtasks).
  // An abort before the window is handled by the typed
  // pre-admission/post-admission throws; an abort after the window
  // cannot relabel anything (the outcome is already computed).
  let interruptedDuringRun = signal?.aborted === true;
  const onAbort = () => {
    interruptedDuringRun = true;
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  let result: LeanResult;
  try {
    result = (await runLeanInvestigation(manifestContract(), deps)) as LeanResult;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
  // Settlement contract (standalone adapter): mark cancelled iff the
  // owned captured signal aborted before this continuation finished
  // settling an INCOMPLETE result. NOT an assertion that engine work
  // stopped — the teardown microtask window at the end of the engine
  // invocation is inside callable settlement and is disclosed. Row
  // reasons are engine-owned and deliberately not consulted (the
  // engine's interrupt finalization skips standing-accept fields, which
  // then settle with withholding or judge-unavailable reasons). A fully
  // satisfied result is never relabeled; an abort after settlement
  // cannot relabel (the observer's lifetime ended with the invocation).
  const outcome = {
    result,
    parse,
    materialClass: admission.materialClass,
    claimedUrl: admission.claimedUrl,
    claimedUrlVerification: "unverified" as const,
    record,
  };
  const cancelled = interruptedDuringRun &&
    Object.values(result.requirements).some((row) => row.status !== "satisfied");
  return cancelled ? { ...outcome, cancelled: true, stopReason: "cancelled" } : { ...outcome, cancelled: false };
}

export { manifestExtractorAttempt };
