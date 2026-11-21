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
 * external search: the search dependency refuses loudly, the engine
 * records search-failed events, and a failed counterevidence search is
 * NOT coverage. A manifest whose candidates validate and even judge
 * clean therefore ends UNRESOLVED with reason `counterevidence_not_
 * acquired` — the honest outcome for a closed set. Legitimately
 * accepting values from a closed document set requires an EXPLICIT
 * engine contract declaration that does not exist today; the narrow
 * interface this needs (proposed for convergence, deliberately NOT
 * implemented here — it is an engine change):
 *
 *   contract.evidencePolicy = {
 *     acquisition: "none",                    // skip the search plan entirely; nothing faked
 *     documentSet: "closed",                  // evidence = the provided documents only
 *     counterevidence: "provided-documents",  // opposing context = other provided documents
 *   }
 *
 * With that declaration the engine could mark coverage
 * "closed-document-set" and finalize acceptance judged over the provided
 * set; without it, unresolved is the only truthful answer. No public CLI
 * surface is claimed — shared CLI/producer-registration wiring is
 * proposed in the coordination review.
 */

import { createHash } from "node:crypto";
import { ValidationError } from "./errors.js";
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
   * nothing. There is NO production route from this module: externally
   * authorized production judging stays in the shared integration,
   * behind its own consent review.
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

/** Opaque test-collaborator token for judge transmission. */
export interface OfflineJudgeSeam {
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
  const token: OfflineJudgeSeam = Object.freeze({ dispatch });
  offlineSeamDispatchers.set(token, dispatch);
  return token;
}

export interface ManifestInvestigationOutcome {
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

function admitManifestInput(input: ManifestInvestigationInput): {
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
  // Consent is checked FIRST; bounds next — both before any digest,
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

/**
 * Deps for the closed-document-set run. Exported so offline tests
 * compose the same wiring (e.g. omit `extract` for the producer-disabled
 * control). Everything derives from ONE admitted snapshot; mutating the
 * caller's input object afterwards changes nothing the engine sees.
 */
export function buildManifestDeps(input: ManifestInvestigationInput) {
  const producer = resolveDocumentProducer(input.producerId ?? RELEASE_MANIFEST_GRAMMAR_ID);
  const { text, admission } = admitManifestInput(input);
  const record = manifestEvidenceRecord(text, admission);
  const deps = {
    now: input.now ?? (() => 0),
    // Closed document set: NO external acquisition is configured. The
    // search dependency REFUSES — the engine logs search-failed and a
    // failed counterevidence search is not coverage, so nothing is
    // faked and acceptance honestly stays unresolved.
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
    // Judge transmission is consent-gated: without the module-minted
    // seam token there is NO dispatch (null), and the engine keeps
    // acceptance off.
    candidateJudge: manifestJudgeConsent(input),
    extract: producer.create(Object.keys(RELEASE_MANIFEST_FIELD_BINDINGS)).extract,
    extractorRevision: RELEASE_MANIFEST_PRODUCER_REVISION,
    ...(input.externalSignal !== undefined ? { externalSignal: input.externalSignal } : {}),
    seed: { evidence: [record] },
  };
  return { deps, record, producer, admission };
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
 * Locally distinguishable user-cancellation settlement (lane-local
 * subclass; the shared error taxonomy has no cancellation code yet —
 * production taxonomy is explicitly deferred to shared integration).
 * The inherited `code` stays "VALIDATION_ERROR" (the ScoutlineErrorCode
 * union is closed in the shared module); `name` and `stopReason`
 * distinguish cancellation locally, and exit stays 130 (user
 * cancellation per the repo's existing interruption convention — the
 * caller lane settles interrupted committed rounds the same way). The
 * lean engine itself reports aborts as the reason string "cancelled" on
 * unresolved fields.
 */
class ManifestRunCancelledError extends ValidationError {
  readonly stopReason: "cancelled" = "cancelled";
  constructor(message: string) {
    super(message);
    this.name = "ManifestRunCancelledError";
    Object.assign(this, { exitCode: 130 });
  }
}

function manifestRunCancelled(message: string): ManifestRunCancelledError {
  return new ManifestRunCancelledError(message);
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
 * closed-source engine contract (see module header) fields end
 * counterevidence_not_acquired rather than accepted.
 */
export async function investigateReleaseManifest(
  input: ManifestInvestigationInput,
): Promise<ManifestInvestigationOutcome> {
  // Pre-abort BEFORE reading input: nothing of the caller's material is
  // touched once cancellation is already signalled.
  if (input.externalSignal?.aborted) {
    throw manifestRunCancelled("Manifest run aborted before admission.");
  }
  const { deps, record, admission } = buildManifestDeps(input);
  // Prepare the parse ONCE from the OWNED admitted body — the report and
  // the engine dispatch share this snapshot, and no later mutation or
  // cancellation re-scans anything.
  const parse = parseReleaseManifest(record.content, Object.keys(RELEASE_MANIFEST_FIELD_BINDINGS));
  if (input.externalSignal?.aborted) {
    throw manifestRunCancelled("Manifest run aborted after admission.");
  }
  const result = (await runLeanInvestigation(manifestContract(), deps)) as LeanResult;
  return {
    result,
    parse,
    materialClass: admission.materialClass,
    claimedUrl: admission.claimedUrl,
    claimedUrlVerification: "unverified",
    record,
  };
}

export { manifestExtractorAttempt };
