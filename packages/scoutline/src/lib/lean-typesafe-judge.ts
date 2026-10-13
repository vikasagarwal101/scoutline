/**
 * Direct official TypeSafe native judge (supplier-local; not a Provider
 * registry entry, not a CLI surface).
 *
 * Fixed official contract: POST https://api.typesafe.ai/v1/systemone,
 * `Authorization: Bearer <key>`, pinned `jev-1.13.0`, Noul-only questions,
 * documented error classes, opt-in transient retry on 429/529 only.
 *
 * Lifecycle rules (cold-review correction batch):
 *   - `reserveAttempt` is ENFORCEMENT before every physical fetch, retries
 *     included; throwing refuses with zero remote work. Cancellation and
 *     deadline are RECHECKED after admission, immediately before dispatch,
 *     so an admission callback that aborts cannot dispatch cancelled work.
 *   - Per-attempt deadline (timeoutMs) continues through incremental body
 *     reads even when the run budget is larger; one run deadline spans
 *     headers, body, backoff and all retries.
 *   - Retry-After is NEVER shortened. A server delay that does not fit the
 *     wait ceiling or the remaining budget stops honestly with no dispatch.
 *   - Dispatched unfinished work (timeout after dispatch, caller abort
 *     mid-flight, connection or body transport loss) is remote-uncertain.
 *     Pre-dispatch refusal and pre-dispatch cancellation are not. Network,
 *     timeout and lost response are NEVER automatically retried.
 *   - One event per dispatched physical attempt (plus explicit refusals);
 *     cancellation during backoff emits no duplicate for the prior attempt.
 *   - Strict validation with STATIC outward messages: no raw model, answer
 *     key, body or credential text is interpolated into any error. Safe
 *     measured facts (pin-matching resolved model, valid usage, known
 *     status) survive rejection through `observed` and the event; private
 *     response strings are discarded.
 *   - Cleanup never awaits stream cancellation; cancel/releaseLock/late
 *     promise rejections are each contained. Disposal is UNCONFIRMED.
 *   - Trial `.9/.1` bands are module-private experimental policy.
 *
 * ponytail: the bounded transport duplicates the reviewed dev adapter
 * deliberately (with the await-cancel stall fixed here). Extract on a THIRD
 * supplier or a one-sided defect fix — not before.
 */

import { createHash } from "node:crypto";
import { ValidationError } from "./errors.js";
import { composedStopRootOf } from "./lean-composed-stop.js";
import {
  buildCandidateJudgeRequest,
  type CandidateJudgeInput,
} from "./lean-candidates.js";
import type {
  LeanCandidateJudgeInput,
  LeanCandidateJudgeResponse,
  LeanDispatchOptions,
  LeanJudgeInput,
  LeanJudgeResponse,
} from "./lean-investigation.js";

/**
 * Bounded POST-only fetch shape for the official direct transport.
 * Structurally identical to the development adapter's seam type; defined
 * locally so the official adapter does not import the development module
 * (package-route-boundary: the dev adapter must not ship in dist).
 */
export type LeanJevFetchLike = (input: string, init: {
  method: "POST";
  headers: Record<string, string>;
  body: string;
  redirect: "error";
  signal: AbortSignal;
}) => Promise<{
  readonly status: number;
  readonly ok: boolean;
  readonly headers: { get(name: string): string | null };
  readonly body: ReadableStream<Uint8Array> | null;
  readonly text?: () => Promise<string>;
}>;

// ---------------------------------------------------------------------------
// Fixed official contract — constants, not configuration
// ---------------------------------------------------------------------------

/** `POST https://api.typesafe.ai/v1/systemone` (docs.typesafe.ai/api). */
export const TYPESAFE_SYSTEMONE_ENDPOINT = "https://api.typesafe.ai/v1/systemone";

/** Versioned official model. `jev-latest`/`jev-preview` are mutable aliases. */
export const TYPESAFE_PINNED_MODEL = "jev-1.13.0";

/** Trial policy bands — NOT a public knob, NOT supplier-calibrated. */
const TYPESAFE_TRIAL_TRUE_BOUND = 0.9;
const TYPESAFE_TRIAL_FALSE_BOUND = 0.1;

/** Policy revisions recorded in attempt metadata. */
export const TYPESAFE_QUESTION_REVISION = "native-noul-attribution-v1" as const;
export const TYPESAFE_THRESHOLD_REVISION = "trial-v1-p9-p1" as const;
export const TYPESAFE_UNCERTAINTY_REVISION = "per-source-null-v1" as const;

/** Engine-consumed audit seam (same symbol the dev adapter attaches). */
const LEAN_JEV_ATTEMPT_META_SYMBOL = Symbol.for("leanJevAttemptMeta");

// ---------------------------------------------------------------------------
// Typed outcomes
// ---------------------------------------------------------------------------

export type TypesafeJudgeErrorCode =
  | "TYPESAFE_AUTH"
  | "TYPESAFE_REQUEST"
  | "TYPESAFE_RATE_LIMIT"
  | "TYPESAFE_OVERLOADED"
  | "TYPESAFE_PROTOCOL"
  | "TYPESAFE_MALFORMED"
  | "TYPESAFE_MODEL"
  | "TYPESAFE_UNSUPPORTED_QUESTION"
  | "TYPESAFE_TIMEOUT"
  | "TYPESAFE_CANCELLED"
  | "TYPESAFE_REMOTE_UNCERTAIN"
  | "TYPESAFE_ATTEMPT_REFUSED"
  | "TYPESAFE_RETRY_REFUSED"
  | "TYPESAFE_PROFILE_CONFLICT"
  | "TYPESAFE_UNIMPLEMENTED";

export type TypesafeJudgeKind = "classification" | "candidate";

/** Safe measured observation preserved on a rejected attempt. Private
 *  response strings (non-pin models, raw ids, bodies) are discarded. */
export interface TypesafeObserved {
  readonly requestSha256: string;
  readonly requestedModel: typeof TYPESAFE_PINNED_MODEL;
  readonly resolvedModel: string | null;
  readonly status: number | null;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number } | null;
  readonly elapsedMs: number;
}

export interface TypesafeAttemptEvent {
  readonly kind: TypesafeJudgeKind;
  readonly attempt: number;
  readonly attemptSha256: string;
  readonly policySha256: string;
  readonly contextSha256: string;
  readonly requestedModel: typeof TYPESAFE_PINNED_MODEL;
  readonly resolvedModel: string | null;
  readonly outcome: "ok" | TypesafeJudgeErrorCode;
  readonly status: number | null;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number } | null;
  readonly elapsedMs: number;
  readonly remoteWorkUncertain: boolean;
  readonly stopReason?: string;
}

/** Physical admission — ENFORCEMENT, called before every fetch. */
export type TypesafeReserveAttempt = (context: {
  readonly kind: TypesafeJudgeKind;
  readonly attempt: number;
}) => void;

// ---------------------------------------------------------------------------
// Retry — opt-in, numeric, conservative, runtime-immutable defaults
// ---------------------------------------------------------------------------

export interface TypesafeRetrySettings {
  readonly maxTransientRetries: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly maxRetryAfterMs: number;
}

/** Frozen: no importer can broaden the documented transient pair. */
export const TYPESAFE_TRANSIENT_STATUSES: readonly number[] = Object.freeze([429, 529]);

export type TypesafeRetryRefusal =
  | "budget"
  | "deadline"
  | "status"
  | "header"
  | "remote_uncertain";

export type TypesafeRetryDecision =
  | { readonly retry: true; readonly delayMs: number }
  | { readonly retry: false; readonly reason: TypesafeRetryRefusal };

export const TYPESAFE_DEFAULT_RETRY_SETTINGS: TypesafeRetrySettings = Object.freeze({
  maxTransientRetries: 0,
  baseDelayMs: 500,
  maxDelayMs: 5_000,
  maxRetryAfterMs: 60_000,
});

export const TYPESAFE_DEFAULT_MAX_ATTEMPTS = 1;
export const TYPESAFE_DEFAULT_TIMEOUT_MS = 15_000;
export const TYPESAFE_DEFAULT_MAX_REQUEST_BYTES = 128 * 1024;
export const TYPESAFE_DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;

// ---------------------------------------------------------------------------
// Dependencies and seams
// ---------------------------------------------------------------------------

export interface TypesafeJudgeDeps {
  readonly apiKey: string;
  readonly fetchLike?: LeanJevFetchLike;
  readonly reserveAttempt: TypesafeReserveAttempt;
  readonly onAttempt?: (event: TypesafeAttemptEvent) => void;
  readonly retrySettings?: Partial<TypesafeRetrySettings>;
  readonly now?: () => number;
  readonly maxAttempts?: number;
  readonly timeoutMs?: number;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
}

export type TypesafeClassificationJudge = (
  input: LeanJudgeInput,
  options?: LeanDispatchOptions,
) => Promise<LeanJudgeResponse>;

export type TypesafeCandidateJudge = (
  input: LeanCandidateJudgeInput,
  options?: LeanDispatchOptions,
) => Promise<LeanCandidateJudgeResponse>;

export interface TypesafeJudgeProfile {
  readonly judge: TypesafeClassificationJudge;
  readonly candidateJudge: TypesafeCandidateJudge;
}

export interface TypesafeStoredConfig {
  readonly apiKey?: string;
}

export interface TypesafeProfileSelection {
  readonly env: NodeJS.ProcessEnv;
  readonly config?: TypesafeStoredConfig;
  readonly transmitConsent: boolean;
  readonly devProfileSelected?: boolean;
}

// ---------------------------------------------------------------------------
// Validation (finite, closed, before any absent-profile return)
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string): never {
  throw new ValidationError(message);
}

/** Validate every dependency BEFORE any profile logic. Static messages.
 *  `apiKey` is optional HERE: the resolver obtains it from the explicit
 *  env/config selection; `createTypesafeJudge` requires it absolutely. */
function validateDeps(deps: TypesafeJudgeDeps, requireApiKey: boolean): void {
  if (!isPlainObject(deps)) invalid("Direct TypeSafe judge dependencies must be an object.");
  if (requireApiKey && (typeof deps.apiKey !== "string" || deps.apiKey === "")) {
    invalid("Direct TypeSafe judge requires a nonempty string apiKey.");
  }
  if (deps.apiKey !== undefined && (typeof deps.apiKey !== "string" || deps.apiKey === "")) {
    invalid("Direct TypeSafe judge apiKey must be a nonempty string.");
  }
  if (typeof deps.reserveAttempt !== "function") {
    invalid("Direct TypeSafe judge requires an explicit reserveAttempt admission dependency; a missing admission closure is a preflight error.");
  }
  if (deps.now !== undefined && typeof deps.now !== "function") {
    invalid("Direct TypeSafe judge now must be a function.");
  }
  if (deps.onAttempt !== undefined && typeof deps.onAttempt !== "function") {
    invalid("Direct TypeSafe judge onAttempt must be a function.");
  }
  if (deps.fetchLike !== undefined && typeof deps.fetchLike !== "function") {
    invalid("Direct TypeSafe judge fetchLike must be a function.");
  }
  const intAtLeast = (name: string, value: unknown, min: number): void => {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) {
      invalid(`Direct TypeSafe judge ${name} must be an integer of at least ${min}.`);
    }
  };
  if (deps.maxAttempts !== undefined) intAtLeast("maxAttempts", deps.maxAttempts, 1);
  if (deps.timeoutMs !== undefined) {
    if (typeof deps.timeoutMs !== "number" || !Number.isFinite(deps.timeoutMs) || deps.timeoutMs <= 0) {
      invalid("Direct TypeSafe judge timeoutMs must be a positive finite number.");
    }
  }
  if (deps.maxRequestBytes !== undefined) intAtLeast("maxRequestBytes", deps.maxRequestBytes, 1);
  if (deps.maxResponseBytes !== undefined) intAtLeast("maxResponseBytes", deps.maxResponseBytes, 1);
  if (deps.retrySettings !== undefined) {
    if (!isPlainObject(deps.retrySettings)) {
      invalid("Direct TypeSafe judge retrySettings must be an object.");
    }
    const r = deps.retrySettings as Record<string, unknown>;
    const known: ReadonlySet<string> = new Set([
      "maxTransientRetries", "baseDelayMs", "maxDelayMs", "maxRetryAfterMs",
    ]);
    for (const key of Object.keys(r)) {
      if (!known.has(key)) invalid("Direct TypeSafe judge retrySettings contains an unknown field.");
    }
    if (r.maxTransientRetries !== undefined) intAtLeast("retrySettings.maxTransientRetries", r.maxTransientRetries, 0);
    for (const key of ["baseDelayMs", "maxDelayMs", "maxRetryAfterMs"] as const) {
      const value = r[key];
      if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
        invalid(`Direct TypeSafe judge retrySettings.${key} must be a nonnegative finite number.`);
      }
    }
  }
}

/** Validate the closed selection shape BEFORE the absent-profile return. */
function validateSelection(selection: TypesafeProfileSelection): void {
  if (!isPlainObject(selection)) invalid("Direct TypeSafe judge selection must be an object.");
  if (typeof selection.transmitConsent !== "boolean") {
    invalid("Direct TypeSafe judge transmitConsent must be a literal boolean.");
  }
  if (selection.env === undefined || !isPlainObject(selection.env)) {
    invalid("Direct TypeSafe judge selection requires an explicit env object.");
  }
  if (selection.config !== undefined) {
    if (!isPlainObject(selection.config)) {
      invalid("Direct TypeSafe judge stored config must be an object.");
    }
    for (const key of Object.keys(selection.config)) {
      if (key !== "apiKey") invalid("Direct TypeSafe judge stored config is closed; only apiKey is accepted.");
    }
    const stored = (selection.config as Record<string, unknown>).apiKey;
    if (stored !== undefined && (typeof stored !== "string" || stored === "")) {
      invalid("Direct TypeSafe judge stored apiKey must be a nonempty string.");
    }
  }
  const envKey = selection.env.TYPESAFE_API_KEY;
  if (envKey !== undefined && typeof envKey !== "string") {
    invalid("Direct TypeSafe judge env TYPESAFE_API_KEY must be a string.");
  }
}

// ---------------------------------------------------------------------------
// Request builders (Noul only; reuse the versioned trial formulations)
// ---------------------------------------------------------------------------

/** Classification state — the hashed judgment-context identity source. */
function classificationState(input: LeanJudgeInput): unknown {
  return {
    requirement: input.fieldQuestion,
    scope: input.scope,
    criteria: input.criteria,
    candidates: input.candidates,
    depBindings: input.depBindings ?? {},
    sources: input.documents.map((doc) => ({
      id: doc.evidenceId,
      url: doc.url,
      title: doc.title,
      text: doc.content,
    })),
  };
}

function classificationQuestions(input: LeanJudgeInput): Record<string, { type: "noul"; instructions: string }> {
  const questions: Record<string, { type: "noul"; instructions: string }> = {};
  input.documents.forEach((_, i) => {
    questions[`q${i}r`] = {
      type: "noul",
      instructions: `Judging only the designated document at \`sources[${i}].text\`: against \`requirement\`, \`scope\` and \`criteria\` (consulting the full \`sources\` context only for qualifications or corrections), is the designated document substantively relevant to answering the requirement? Answer the probability that it is.`,
    };
    questions[`q${i}s`] = {
      type: "noul",
      instructions: `Judging only the designated document at \`sources[${i}].text\`: does that document explicitly state evidence SUPPORTING the \`requirement\` claim for the exact \`scope\`, per \`criteria\` (consulting the full \`sources\` context only for qualifications or corrections)? Answer the probability that it does.`,
    };
    questions[`q${i}f`] = {
      type: "noul",
      instructions: `Judging only the designated document at \`sources[${i}].text\`: does that document explicitly state evidence REFUTING the \`requirement\` claim for the exact \`scope\`, per \`criteria\` (consulting the full \`sources\` context only for qualifications or corrections)? Answer the probability that it does.`,
    };
  });
  return questions;
}

export function buildTypesafeNoulRequest(input: LeanJudgeInput): string {
  return JSON.stringify({
    model: TYPESAFE_PINNED_MODEL,
    state: classificationState(input),
    questions: classificationQuestions(input),
  });
}

export function buildTypesafeCandidateRequest(input: LeanCandidateJudgeInput): string {
  return buildCandidateJudgeRequest(input as CandidateJudgeInput, TYPESAFE_PINNED_MODEL);
}

// ---------------------------------------------------------------------------
// Policy/context identity
// ---------------------------------------------------------------------------

function policyIdentity(): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        TYPESAFE_SYSTEMONE_ENDPOINT,
        TYPESAFE_PINNED_MODEL,
        TYPESAFE_QUESTION_REVISION,
        TYPESAFE_THRESHOLD_REVISION,
        TYPESAFE_UNCERTAINTY_REVISION,
      ]),
    )
    .digest("hex");
}

/** Full ordered judgment-context identity: question, scope, criteria,
 *  dependency bindings and actual source bytes — not evidence ids. */
function contextIdentityOf(requestBody: string): string {
  let state: unknown = null;
  try {
    state = (JSON.parse(requestBody) as { state?: unknown }).state ?? null;
  } catch {
    state = null;
  }
  return createHash("sha256").update(JSON.stringify(state ?? requestBody)).digest("hex");
}

// ---------------------------------------------------------------------------
// Typed rejection
// ---------------------------------------------------------------------------

export interface TypesafeRejection extends Error {
  code: TypesafeJudgeErrorCode;
  observed?: TypesafeObserved;
  stopReason?: string;
  remoteWorkUncertain?: boolean;
  /** Physical attempts actually dispatched before this rejection. */
  attempts?: number;
}

function typedRejection(
  code: TypesafeJudgeErrorCode,
  message: string,
  extra?: { observed?: TypesafeObserved; stopReason?: string; remoteWorkUncertain?: boolean; attempts?: number },
): TypesafeRejection {
  const error = new Error(message) as TypesafeRejection;
  error.name = "TypesafeJudgeError";
  error.code = code;
  if (extra?.observed !== undefined) error.observed = extra.observed;
  if (extra?.stopReason !== undefined) error.stopReason = extra.stopReason;
  if (extra?.remoteWorkUncertain !== undefined) error.remoteWorkUncertain = extra.remoteWorkUncertain;
  if (extra?.attempts !== undefined) error.attempts = extra.attempts;
  return error;
}

/** Contained cancellation: rejection observed, never awaited. */
function cancelStream(body: { cancel?: () => Promise<unknown> } | null | undefined): void {
  try {
    body?.cancel?.().catch(() => {});
  } catch {
    /* cancel() itself throwing is contained — disposal stays unconfirmed */
  }
}

function releaseReader(reader: { releaseLock?: () => void } | undefined): void {
  try {
    reader?.releaseLock?.();
  } catch {
    /* releaseLock throwing (e.g. after cancel) is contained */
  }
}

function abortError(): Error {
  const error = new Error("attempt deadline or cancellation");
  error.name = "AbortError";
  return error;
}

/** Parse `retry-after-ms`, then `retry-after` (seconds or HTTP-date). */
function parseRetryAfterMs(headerGet: (name: string) => string | null, now: () => number): number | null {
  const ms = headerGet("retry-after-ms");
  if (ms !== null) {
    const value = Number(ms);
    if (Number.isFinite(value) && value >= 0) return value;
  }
  const raw = headerGet("retry-after");
  if (raw === null) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds * 1000 : null;
  const date = Date.parse(raw);
  if (!Number.isNaN(date)) return Math.max(0, date - now());
  return null;
}

// ---------------------------------------------------------------------------
// Bounded native dispatch (one physical attempt)
// ---------------------------------------------------------------------------

interface DispatchFailure {
  readonly code: "TYPESAFE_TIMEOUT" | "TYPESAFE_CANCELLED" | "TYPESAFE_REMOTE_UNCERTAIN";
  readonly message: string;
  readonly stopReason?: string;
  /** Dispatched unfinished work is remote-uncertain. */
  readonly uncertain: boolean;
}

interface DispatchInput {
  readonly url: string;
  readonly requestBody: string;
  readonly apiKey: string;
  readonly fetchLike: LeanJevFetchLike;
  readonly runSignal: AbortSignal;
  /** Absolute per-attempt end (min of attempt timeout and run deadline). */
  readonly attemptEnd: number;
  readonly now: () => number;
}

async function dispatchOnce(input: DispatchInput): Promise<{
  response?: Awaited<ReturnType<LeanJevFetchLike>>;
  /** The single controller owning fetch-abort through the body read. */
  controller?: AbortController;
  /** Deadline/cancellation cleanup; run when the caller is done with the
   *  controller (success or failure). Never throws. */
  dispose?: () => void;
  failure?: DispatchFailure;
}> {
  const { runSignal, attemptEnd, now } = input;
  const controller = new AbortController();
  const abortFromSignal = (): void => controller.abort(runSignal.reason);
  if (runSignal.aborted) abortFromSignal();
  runSignal.addEventListener("abort", abortFromSignal, { once: true });
  let timedOut = false;
  // SINGLE timeout for the whole attempt: headers AND incremental body.
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, Math.max(1, attemptEnd - now()));
  const dispose = (): void => {
    clearTimeout(timer);
    runSignal.removeEventListener("abort", abortFromSignal);
  };
  const remaining = (): number => Math.max(1, attemptEnd - now());

  let raceSettled = false;
  const observeFetch = (promise: Promise<Awaited<ReturnType<LeanJevFetchLike>>>): void => {
    promise.then(
      (late) => {
        queueMicrotask(() => {
          queueMicrotask(() => {
            if (!raceSettled) cancelStream(late.body);
          });
        });
      },
      () => {
        /* late rejection consumed */
      },
    );
  };

  try {
    const fetchPromise = input.fetchLike(input.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${input.apiKey}`,
        accept: "application/json",
      },
      body: input.requestBody,
      redirect: "error",
      signal: controller.signal,
    });
    observeFetch(fetchPromise);
    let onHeaderAbort: (() => void) | undefined;
    let headerTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await Promise.race([
        fetchPromise,
        new Promise<never>((_, reject) => {
          headerTimer = setTimeout(() => reject(abortError()), remaining());
          onHeaderAbort = () => reject(abortError());
          runSignal.addEventListener("abort", onHeaderAbort, { once: true });
          controller.signal.addEventListener("abort", onHeaderAbort, { once: true });
          if (runSignal.aborted || controller.signal.aborted) onHeaderAbort();
        }),
      ]);
      if (controller.signal.aborted || runSignal.aborted) throw abortError();
      raceSettled = true;
      // The response returned; the controller + timer stay LIVE for the
      // body read (single timeout spans headers and incremental reads).
      return { response, controller, dispose };
    } finally {
      clearTimeout(headerTimer);
      if (onHeaderAbort !== undefined) {
        runSignal.removeEventListener("abort", onHeaderAbort);
        controller.signal.removeEventListener("abort", onHeaderAbort);
      }
    }
  } catch (error) {
    dispose();
    const stop = composedStopRootOf(error);
    const cancelled = runSignal.aborted;
    // Work WAS dispatched: unfinished remote work is uncertain either way.
    const code = cancelled ? "TYPESAFE_CANCELLED" : timedOut ? "TYPESAFE_TIMEOUT" : "TYPESAFE_REMOTE_UNCERTAIN";
    return {
      failure: {
        code,
        message: cancelled
          ? "Direct TypeSafe request was cancelled by the caller after dispatch; remote work may have happened."
          : timedOut
            ? "Direct TypeSafe request exceeded its deadline after dispatch; remote work may have happened."
            : "Direct TypeSafe request failed at the transport layer; remote work may have happened.",
        uncertain: true,
        ...(stop !== null ? { stopReason: stop } : {}),
      },
    };
  }
}

interface BodyFailure {
  readonly code: "TYPESAFE_TIMEOUT" | "TYPESAFE_CANCELLED" | "TYPESAFE_REMOTE_UNCERTAIN" | "TYPESAFE_PROTOCOL";
  readonly message: string;
  readonly stopReason?: string;
  readonly uncertain: boolean;
}

async function readBodyBounded(
  response: Awaited<ReturnType<LeanJevFetchLike>>,
  controller: AbortController | undefined,
  attemptEnd: number,
  maxResponseBytes: number,
  runSignal: AbortSignal,
  now: () => number,
): Promise<{ bodyText?: string; failure?: BodyFailure }> {
  let ownedReader: { read: () => Promise<{ done: boolean; value?: Uint8Array }>; cancel?: () => Promise<unknown>; releaseLock?: () => void } | undefined;
  try {
    const reader = response.body?.getReader();
    ownedReader = reader;
    if (reader === undefined) return { bodyText: "" };
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    for (;;) {
      let chunkTimer: ReturnType<typeof setTimeout> | undefined;
      let onChunkAbort: (() => void) | undefined;
      const read = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          chunkTimer = setTimeout(() => reject(abortError()), Math.max(1, attemptEnd - now()));
          onChunkAbort = () => reject(abortError());
          runSignal.addEventListener("abort", onChunkAbort, { once: true });
          if (runSignal.aborted) onChunkAbort();
        }),
      ]).finally(() => {
        clearTimeout(chunkTimer);
        if (onChunkAbort !== undefined) runSignal.removeEventListener("abort", onChunkAbort);
      });
      // Clock check BEFORE and AFTER every ready read: a buffered
      // microtask cannot beat an expired absolute deadline.
      if (runSignal.aborted || controller?.signal.aborted || now() >= attemptEnd) throw abortError();
      if (read.done) break;
      if (read.value) {
        totalBytes += read.value.byteLength;
        if (totalBytes > maxResponseBytes) {
          // NEVER awaited: a stalling/rejecting cancel cannot hold the run.
          // The controller aborts so the HELD FETCH observes the stop too.
          controller?.abort();
          cancelStream(reader);
          releaseReader(ownedReader);
          return {
            failure: {
              code: "TYPESAFE_PROTOCOL",
              message: "Direct TypeSafe response exceeded the bounded body ceiling.",
              uncertain: false,
            },
          };
        }
        chunks.push(Buffer.from(read.value.buffer, read.value.byteOffset, read.value.byteLength));
      }
    }
    // Final clock check before success: done≠within-deadline.
    if (runSignal.aborted || controller?.signal.aborted || now() >= attemptEnd) throw abortError();
    releaseReader(ownedReader);
    return { bodyText: Buffer.concat(chunks).toString("utf8") };
  } catch (error) {
    // Abort the HELD FETCH: the transport that produced this body must
    // observe the cancellation, not just our reader.
    controller?.abort();
    cancelStream(ownedReader);
    releaseReader(ownedReader);
    const stop = composedStopRootOf(error);
    const aborted = error instanceof Error && error.name === "AbortError";
    if (aborted) {
      return {
        failure: {
          code: runSignal.aborted ? "TYPESAFE_CANCELLED" : "TYPESAFE_TIMEOUT",
          message: runSignal.aborted
            ? "Direct TypeSafe body read was cancelled by the caller; remote work may have happened."
            : "Direct TypeSafe body read exceeded its deadline; remote work may have happened.",
          uncertain: true,
          ...(stop !== null ? { stopReason: stop } : {}),
        },
      };
    }
    // A body transport FAILURE after a dispatched request is remote-uncertain.
    return {
      failure: {
        code: "TYPESAFE_REMOTE_UNCERTAIN",
        message: "Direct TypeSafe response body could not be read; remote work may have happened.",
        uncertain: true,
        ...(stop !== null ? { stopReason: stop } : {}),
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Strict response validation (static messages; safe facts preserved)
// ---------------------------------------------------------------------------

interface ValidatedResponse {
  readonly model: string;
  readonly answers: Readonly<Record<string, { type: string; noul?: number }>>;
  readonly usage: { inputTokens: number; outputTokens: number };
}

/** Safe measured facts from an unparsed/raw body: pin-matching model and
 *  valid usage only — everything private is discarded. */
function safeFactsFromRaw(raw: unknown): {
  resolvedModel: string | null;
  usage: { inputTokens: number; outputTokens: number } | null;
} {
  if (!isPlainObject(raw)) return { resolvedModel: null, usage: null };
  const model = raw.model;
  const resolvedModel = model === TYPESAFE_PINNED_MODEL ? TYPESAFE_PINNED_MODEL : null;
  const usageRaw = raw.usage;
  let usage: { inputTokens: number; outputTokens: number } | null = null;
  if (
    isPlainObject(usageRaw) &&
    typeof usageRaw.input_tokens === "number" && Number.isSafeInteger(usageRaw.input_tokens) && usageRaw.input_tokens >= 0 &&
    typeof usageRaw.output_tokens === "number" && Number.isSafeInteger(usageRaw.output_tokens) && usageRaw.output_tokens >= 0
  ) {
    usage = { inputTokens: usageRaw.input_tokens, outputTokens: usageRaw.output_tokens };
  }
  return { resolvedModel, usage };
}

function validUsageOf(raw: unknown): { inputTokens: number; outputTokens: number } | undefined {
  const facts = safeFactsFromRaw({ usage: raw });
  return facts.usage ?? undefined;
}

function validateNativeResponse(
  bodyText: string,
  expectedIds: ReadonlySet<string>,
): { value?: ValidatedResponse; code?: TypesafeJudgeErrorCode; message?: string; safe?: { resolvedModel: string | null; usage: { inputTokens: number; outputTokens: number } | null } } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { code: "TYPESAFE_MALFORMED", message: "Direct TypeSafe response was not valid JSON." };
  }
  const safe = safeFactsFromRaw(parsed);
  if (!isPlainObject(parsed)) {
    return { code: "TYPESAFE_MALFORMED", message: "Direct TypeSafe response was not an object.", safe };
  }
  if (typeof parsed.model !== "string" || parsed.model.length === 0) {
    return { code: "TYPESAFE_MALFORMED", message: "Direct TypeSafe response lacked a resolved model identity.", safe };
  }
  if (parsed.model !== TYPESAFE_PINNED_MODEL) {
    // Static message: the raw model string never leaves the module.
    return { code: "TYPESAFE_MODEL", message: "Direct TypeSafe resolved to a model other than the pinned version.", safe };
  }
  const usage = validUsageOf(parsed.usage);
  if (usage === undefined) {
    return {
      code: "TYPESAFE_MALFORMED",
      message: "Direct TypeSafe usage must be a present object with nonnegative integer input_tokens/output_tokens.",
      safe,
    };
  }
  const answersRaw = parsed.answers;
  if (!isPlainObject(answersRaw)) {
    return { code: "TYPESAFE_MALFORMED", message: "Direct TypeSafe response lacked an answers object.", safe };
  }
  for (const id of Object.keys(answersRaw)) {
    if (!expectedIds.has(id)) {
      return { code: "TYPESAFE_PROTOCOL", message: "Direct TypeSafe response contained an unknown question id.", safe };
    }
  }
  for (const id of expectedIds) {
    if (!(id in answersRaw)) {
      return { code: "TYPESAFE_PROTOCOL", message: "Direct TypeSafe response was missing a requested question id.", safe };
    }
  }
  for (const entry of Object.values(answersRaw)) {
    const answer = entry as { type?: unknown; noul?: unknown } | null;
    if (
      answer === null ||
      typeof answer !== "object" ||
      answer.type !== "noul" ||
      typeof answer.noul !== "number" ||
      !Number.isFinite(answer.noul) ||
      answer.noul < 0 ||
      answer.noul > 1
    ) {
      // A non-Noul native answer (choice/score) is a PROTOCOL failure for
      // this Noul-only profile — never translated, never guessed.
      return { code: "TYPESAFE_PROTOCOL", message: "Direct TypeSafe answer was not a finite Noul probability in [0,1].", safe };
    }
  }
  return {
    value: {
      model: parsed.model,
      answers: answersRaw as Record<string, { type: string; noul?: number }>,
      usage,
    },
    safe,
  };
}

// ---------------------------------------------------------------------------
// Full lifecycle: validation, admission, dispatch, retry, normalization
// ---------------------------------------------------------------------------

interface LifecycleResult {
  readonly validated?: ValidatedResponse;
  readonly rejection?: TypesafeRejection;
  readonly attemptEvents: readonly TypesafeAttemptEvent[];
  readonly attempts: number;
}

function classifyStatus(status: number): TypesafeJudgeErrorCode {
  if (status === 401 || status === 403) return "TYPESAFE_AUTH";
  if (status === 422) return "TYPESAFE_REQUEST";
  if (status === 429) return "TYPESAFE_RATE_LIMIT";
  if (status === 529) return "TYPESAFE_OVERLOADED";
  return "TYPESAFE_PROTOCOL";
}

/** Contained observer delivery: never enables or suppresses work. */
function emit(onAttempt: ((event: TypesafeAttemptEvent) => void) | undefined, event: TypesafeAttemptEvent): void {
  if (onAttempt === undefined) return;
  try {
    onAttempt(event);
  } catch {
    /* observer failure is contained — the judgment stands */
  }
}

/** Sleep racing the caller signal; resolves false when aborted. */
function sleepContained(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

async function runLifecycle(
  kind: TypesafeJudgeKind,
  requestBody: string,
  expectedIds: ReadonlySet<string>,
  deps: TypesafeJudgeDeps,
  contextSha256: string,
  options: LeanDispatchOptions | undefined,
): Promise<LifecycleResult> {
  const now = deps.now ?? (() => Date.now());
  const maxAttempts = deps.maxAttempts ?? TYPESAFE_DEFAULT_MAX_ATTEMPTS;
  const timeoutMs = deps.timeoutMs ?? TYPESAFE_DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = deps.maxResponseBytes ?? TYPESAFE_DEFAULT_MAX_RESPONSE_BYTES;
  const retry: TypesafeRetrySettings = Object.freeze({
    ...TYPESAFE_DEFAULT_RETRY_SETTINGS,
    ...(deps.retrySettings ?? {}),
  });
  const fetchLike = deps.fetchLike ?? (globalThis.fetch as unknown as LeanJevFetchLike);
  const policySha = policyIdentity();
  const attemptSha = createHash("sha256").update(requestBody).digest("hex");
  const events: TypesafeAttemptEvent[] = [];

  const startedAt = now();
  // One absolute run deadline spans every attempt and all backoff.
  const runDeadline =
    options?.timeoutMs !== undefined && Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0
      ? startedAt + options.timeoutMs
      : startedAt + (timeoutMs + retry.maxDelayMs + retry.baseDelayMs) * maxAttempts + retry.maxRetryAfterMs;
  const signal = options?.signal ?? new AbortController().signal;

  if (typeof fetchLike !== "function") {
    return {
      rejection: typedRejection("TYPESAFE_REMOTE_UNCERTAIN", "Direct TypeSafe transport is unavailable."),
      attemptEvents: events,
      attempts: 0,
    };
  }
  // Already-aborted run signal: zero physical attempts, zero admissions.
  if (signal.aborted) {
    return {
      rejection: typedRejection("TYPESAFE_CANCELLED", "Direct TypeSafe call was cancelled before any attempt."),
      attemptEvents: events,
      attempts: 0,
    };
  }

  let attempt = 0;
  for (;;) {
    // ---- admission BEFORE every physical attempt (retries included) ----
    try {
      deps.reserveAttempt({ kind, attempt });
    } catch (error) {
      const stop = composedStopRootOf(error);
      const event: TypesafeAttemptEvent = {
        kind, attempt, attemptSha256: attemptSha, policySha256: policySha, contextSha256,
        requestedModel: TYPESAFE_PINNED_MODEL, resolvedModel: null, outcome: "TYPESAFE_ATTEMPT_REFUSED",
        status: null, usage: null, elapsedMs: now() - startedAt, remoteWorkUncertain: false,
        ...(stop !== null ? { stopReason: stop } : {}),
      };
      events.push(event);
      emit(deps.onAttempt, event);
      return {
        rejection: typedRejection(
          "TYPESAFE_ATTEMPT_REFUSED",
          "Direct TypeSafe physical admission was refused; no HTTP was sent.",
          { ...(stop !== null ? { stopReason: stop } : {}), attempts: attempt },
        ),
        attemptEvents: events,
        attempts: attempt,
      };
    }
    // ---- post-admission recheck: an aborting admission callback must not
    // dispatch already-cancelled work; a expired deadline likewise. ----
    if (signal.aborted || now() >= runDeadline) {
      return {
        rejection: typedRejection(
          signal.aborted ? "TYPESAFE_CANCELLED" : "TYPESAFE_RETRY_REFUSED",
          signal.aborted
            ? "Direct TypeSafe call was cancelled after admission and before dispatch; nothing was sent."
            : "Direct TypeSafe run deadline expired before dispatch; nothing was sent.",
          { attempts: attempt },
        ),
        attemptEvents: events,
        attempts: attempt,
      };
    }

    const attemptStartedAt = now();
    // Per-attempt deadline: min(attempt timeout, run deadline). It keeps
    // governing the incremental body read even under a larger run budget.
    const attemptEnd = Math.min(attemptStartedAt + timeoutMs, runDeadline);

    const dispatched = await dispatchOnce({
      url: TYPESAFE_SYSTEMONE_ENDPOINT,
      requestBody,
      apiKey: deps.apiKey,
      fetchLike,
      runSignal: signal,
      attemptEnd,
      now,
    });

    if (dispatched.failure !== undefined) {
      const failure = dispatched.failure;
      const event: TypesafeAttemptEvent = {
        kind, attempt, attemptSha256: attemptSha, policySha256: policySha, contextSha256,
        requestedModel: TYPESAFE_PINNED_MODEL, resolvedModel: null, outcome: failure.code,
        status: null, usage: null, elapsedMs: now() - attemptStartedAt,
        remoteWorkUncertain: failure.uncertain,
        ...(failure.stopReason !== undefined ? { stopReason: failure.stopReason } : {}),
      };
      events.push(event);
      emit(deps.onAttempt, event);
      return {
        rejection: typedRejection(failure.code, failure.message, {
          ...(failure.stopReason !== undefined ? { stopReason: failure.stopReason } : {}),
          remoteWorkUncertain: failure.uncertain,
          attempts: attempt + 1,
        }),
        attemptEvents: events,
        attempts: attempt + 1,
      };
    }

    const response = dispatched.response!;
    if (!response.ok) {
      const code = classifyStatus(response.status);
      const event: TypesafeAttemptEvent = {
        kind, attempt, attemptSha256: attemptSha, policySha256: policySha, contextSha256,
        requestedModel: TYPESAFE_PINNED_MODEL, resolvedModel: null, outcome: code,
        status: response.status, usage: null, elapsedMs: now() - attemptStartedAt,
        remoteWorkUncertain: false,
      };
      events.push(event);
      emit(deps.onAttempt, event);
      // Error body CANCELLED, not consumed — disposal unconfirmed.
      cancelStream(response.body);
      dispatched.dispose?.();

      // Last safe measured observation — preserved on the terminal status
      // rejection AND on every retry-refusal path below.
      const observed: TypesafeObserved = {
        requestSha256: attemptSha,
        requestedModel: TYPESAFE_PINNED_MODEL,
        resolvedModel: null,
        status: response.status,
        usage: null,
        elapsedMs: now() - attemptStartedAt,
      };
      const rejection = typedRejection(code, `Direct TypeSafe endpoint returned status ${response.status}.`, {
        observed,
        attempts: attempt + 1,
      });

      // ---- documented transient retry (frozen 429/529, opt-in only) ----
      const transient = (TYPESAFE_TRANSIENT_STATUSES as readonly number[]).includes(response.status);
      if (transient && attempt < retry.maxTransientRetries && attempt + 1 < maxAttempts) {
        const retryAfterMs = parseRetryAfterMs((n) => response.headers.get(n), () => now());
        let delayMs: number;
        if (retryAfterMs !== null) {
          if (retryAfterMs > retry.maxRetryAfterMs) {
            return {
              rejection: typedRejection(
                "TYPESAFE_RETRY_REFUSED",
                "Direct TypeSafe Retry-After exceeds the configured wait ceiling; stopping without another attempt.",
                { observed, attempts: attempt + 1 },
              ),
              attemptEvents: events,
              attempts: attempt + 1,
            };
          }
          delayMs = retryAfterMs; // NEVER shortened
        } else {
          delayMs = Math.min(retry.baseDelayMs * 2 ** attempt, retry.maxDelayMs);
        }
        const remainingRun = runDeadline - now();
        if (delayMs > remainingRun) {
          return {
            rejection: typedRejection(
              "TYPESAFE_RETRY_REFUSED",
              "Direct TypeSafe retry delay does not fit the remaining run budget; stopping without another attempt.",
              { observed, attempts: attempt + 1 },
            ),
            attemptEvents: events,
            attempts: attempt + 1,
          };
        }
        // Backoff races the caller signal; cancellation settles it WITHOUT
        // emitting a duplicate event for the already-recorded attempt.
        const slept = await sleepContained(delayMs, signal);
        if (!slept) {
          return {
            rejection: typedRejection(
              "TYPESAFE_CANCELLED",
              "Direct TypeSafe retry backoff was cancelled by the caller; remote work from the dispatched attempt may have happened.",
              { remoteWorkUncertain: true, attempts: attempt + 1 },
            ),
            attemptEvents: events,
            attempts: attempt + 1,
          };
        }
        attempt += 1;
        continue;
      }
      return { rejection, attemptEvents: events, attempts: attempt + 1 };
    }

    let body: Awaited<ReturnType<typeof readBodyBounded>>;
    try {
      body = await readBodyBounded(response, dispatched.controller, attemptEnd, maxResponseBytes, signal, now);
    } finally {
      dispatched.dispose?.();
    }
    if (body.failure !== undefined) {
      const failure = body.failure;
      const event: TypesafeAttemptEvent = {
        kind, attempt, attemptSha256: attemptSha, policySha256: policySha, contextSha256,
        requestedModel: TYPESAFE_PINNED_MODEL, resolvedModel: null, outcome: failure.code,
        status: response.status, usage: null, elapsedMs: now() - attemptStartedAt,
        remoteWorkUncertain: failure.uncertain,
        ...(failure.stopReason !== undefined ? { stopReason: failure.stopReason } : {}),
      };
      events.push(event);
      emit(deps.onAttempt, event);
      return {
        rejection: typedRejection(failure.code, failure.message, {
          observed: {
            requestSha256: attemptSha, requestedModel: TYPESAFE_PINNED_MODEL, resolvedModel: null,
            status: response.status, usage: null, elapsedMs: now() - attemptStartedAt,
          },
          ...(failure.stopReason !== undefined ? { stopReason: failure.stopReason } : {}),
          remoteWorkUncertain: failure.uncertain,
          attempts: attempt + 1,
        }),
        attemptEvents: events,
        attempts: attempt + 1,
      };
    }

    const validated = validateNativeResponse(body.bodyText ?? "", expectedIds);
    if (validated.value === undefined) {
      const code = validated.code ?? "TYPESAFE_MALFORMED";
      const safe = validated.safe ?? { resolvedModel: null, usage: null };
      const event: TypesafeAttemptEvent = {
        kind, attempt, attemptSha256: attemptSha, policySha256: policySha, contextSha256,
        requestedModel: TYPESAFE_PINNED_MODEL, resolvedModel: safe.resolvedModel, outcome: code,
        status: response.status, usage: safe.usage, elapsedMs: now() - attemptStartedAt,
        remoteWorkUncertain: false,
      };
      events.push(event);
      emit(deps.onAttempt, event);
      return {
        rejection: typedRejection(code, validated.message ?? "Direct TypeSafe response failed validation.", {
          observed: {
            requestSha256: attemptSha, requestedModel: TYPESAFE_PINNED_MODEL, resolvedModel: safe.resolvedModel,
            status: response.status, usage: safe.usage, elapsedMs: now() - attemptStartedAt,
          },
          attempts: attempt + 1,
        }),
        attemptEvents: events,
        attempts: attempt + 1,
      };
    }

    const usage = validated.value.usage;
    const event: TypesafeAttemptEvent = {
      kind, attempt, attemptSha256: attemptSha, policySha256: policySha, contextSha256,
      requestedModel: TYPESAFE_PINNED_MODEL, resolvedModel: validated.value.model, outcome: "ok",
      status: response.status, usage, elapsedMs: now() - attemptStartedAt, remoteWorkUncertain: false,
    };
    events.push(event);
    emit(deps.onAttempt, event);
    return { validated: validated.value, attemptEvents: events, attempts: attempt + 1 };
  }
}

// ---------------------------------------------------------------------------
// Normalization to the engine seams
// ---------------------------------------------------------------------------

function classificationIdsFor(input: LeanJudgeInput): Set<string> {
  const ids = new Set<string>();
  input.documents.forEach((_, i) => {
    ids.add(`q${i}r`);
    ids.add(`q${i}s`);
    ids.add(`q${i}f`);
  });
  return ids;
}

function candidateIdsFor(input: LeanCandidateJudgeInput): Set<string> {
  const ids = new Set<string>();
  input.candidates.forEach((_, i) => {
    ids.add(`q${i}s`);
    ids.add(`q${i}c`);
  });
  return ids;
}

function assertRequestCeiling(requestBody: string, deps: TypesafeJudgeDeps): void {
  const ceiling = deps.maxRequestBytes ?? TYPESAFE_DEFAULT_MAX_REQUEST_BYTES;
  const bytes = Buffer.byteLength(requestBody, "utf8");
  if (bytes > ceiling) {
    throw new ValidationError(
      `Direct TypeSafe request (${bytes} bytes) exceeds the input ceiling (${ceiling} bytes).`,
    );
  }
}

// ---------------------------------------------------------------------------
// Profile composition
// ---------------------------------------------------------------------------

export function createTypesafeJudge(deps: TypesafeJudgeDeps): TypesafeJudgeProfile {
  validateDeps(deps, true);
  const judge: TypesafeClassificationJudge = async (input, options) => {
    const requestBody = buildTypesafeNoulRequest(input);
    assertRequestCeiling(requestBody, deps);
    const contextSha256 = contextIdentityOf(requestBody);
    const policySha256 = policyIdentity();
    const result = await runLifecycle(
      "classification",
      requestBody,
      classificationIdsFor(input),
      deps,
      contextSha256,
      options,
    );
    if (result.rejection !== undefined) throw result.rejection;
    const validated = result.validated!;
    const answers = validated.answers;
    const translate = (p: number): boolean | null =>
      p >= TYPESAFE_TRIAL_TRUE_BOUND ? true : p <= TYPESAFE_TRIAL_FALSE_BOUND ? false : null;
    const documents = input.documents.map((doc, i) => ({
      evidenceId: doc.evidenceId,
      relevant: translate((answers[`q${i}r`] as { noul: number }).noul),
      supportsClaim: translate((answers[`q${i}s`] as { noul: number }).noul),
      refutesClaim: translate((answers[`q${i}f`] as { noul: number }).noul),
    }));
    const response: LeanJudgeResponse = { documents };
    const probabilities: Record<string, number> = {};
    for (const [id, entry] of Object.entries(answers)) probabilities[id] = (entry as { noul: number }).noul;
    // Engine audit channel: the SAME symbol the dev adapter attaches, read
    // by the engine at lean-investigation.ts:2490/:2556.
    return Object.assign(response, {
      [LEAN_JEV_ATTEMPT_META_SYMBOL]: Object.freeze({
        attemptSha256: result.attemptEvents.at(-1)?.attemptSha256 ?? "",
        requestedModel: TYPESAFE_PINNED_MODEL,
        resolvedModel: validated.model,
        thresholdRevision: TYPESAFE_THRESHOLD_REVISION,
        questionRevision: TYPESAFE_QUESTION_REVISION,
        uncertaintyRevision: TYPESAFE_UNCERTAINTY_REVISION,
        status: result.attemptEvents.at(-1)?.status ?? 200,
        elapsedMs: result.attemptEvents.reduce((a, e) => a + e.elapsedMs, 0),
        usage: validated.usage,
        probabilities,
        observedCost: null,
        attempts: result.attempts,
        contextSha256,
        policySha256,
      }),
    });
  };

  const candidateJudge: TypesafeCandidateJudge = async (input, options) => {
    const requestBody = buildTypesafeCandidateRequest(input);
    assertRequestCeiling(requestBody, deps);
    const now = deps.now ?? (() => Date.now());
    const startedAt = now();
    const contextSha256 = contextIdentityOf(requestBody);
    const policySha256 = policyIdentity();
    const result = await runLifecycle(
      "candidate",
      requestBody,
      candidateIdsFor(input),
      deps,
      contextIdentityOf(requestBody),
      options,
    );
    if (result.rejection !== undefined) throw result.rejection;
    const validated = result.validated!;
    const answers: Record<string, { type: string; noul: number }> = {};
    for (const [id, entry] of Object.entries(validated.answers)) {
      answers[id] = { type: "noul", noul: (entry as { noul: number }).noul };
    }
    return Object.assign(
      {
        model: validated.model,
        answers,
        usage: validated.usage,
        requestSha256: result.attemptEvents.at(-1)?.attemptSha256 ?? "",
        elapsedMs: now() - startedAt,
        contextSha256,
        policySha256,
      },
      { attempts: result.attempts },
    ) as LeanCandidateJudgeResponse;
  };

  return { judge, candidateJudge };
}

/**
 * Absent profile -> `null` (approved deterministic-only).
 * Partial/malformed/override/conflict selections -> typed `ValidationError`
 * at ZERO attempts — validated BEFORE the absent-profile return, so invalid
 * input can never silently become a default or a downgrade.
 */
export function resolveTypesafeJudgeProfile(
  selection: TypesafeProfileSelection,
  deps: TypesafeJudgeDeps,
): TypesafeJudgeProfile | null {
  validateDeps(deps, false);
  validateSelection(selection);

  const envKey = selection.env.TYPESAFE_API_KEY;
  const configKey = selection.config?.apiKey;

  // Closed-shape/override validation FIRST (before any absent return):
  // an endpoint/model override with NO key is still a malformed selection.
  if (selection.env.TYPESAFE_MODEL !== undefined || selection.env.TYPESAFE_ENDPOINT !== undefined) {
    throw new ValidationError(
      "TYPESAFE_MODEL/TYPESAFE_ENDPOINT are not accepted; the direct profile uses the fixed official endpoint and pin.",
    );
  }
  if (selection.devProfileSelected === true && (envKey !== undefined || configKey !== undefined)) {
    throw new ValidationError(
      "official TypeSafe and development judge profiles are both selected; refusing a precedence-based substitution.",
    );
  }

  const present = [envKey, configKey].filter((v) => v !== undefined).length;
  if (present === 0) {
    if (selection.transmitConsent) {
      throw new ValidationError(
        "judge transmission was selected but no TYPESAFE_API_KEY is configured; refusing a silent deterministic-only downgrade.",
      );
    }
    return null;
  }
  const apiKey = configKey ?? envKey!;
  if (apiKey === "") {
    throw new ValidationError("TYPESAFE_API_KEY is present but empty; refusing the direct judge profile.");
  }
  if (!selection.transmitConsent) {
    throw new ValidationError(
      "judge credentials are present but judge transmission was not selected; credentials alone are not consent.",
    );
  }
  return createTypesafeJudge({ ...deps, apiKey });
}

/** Facade injection: both judge functions from the SAME profile. */
export function composeTypesafeJudgeDeps(profile: TypesafeJudgeProfile | null): {
  readonly judge: TypesafeClassificationJudge | null;
  readonly candidateJudge: TypesafeCandidateJudge | null;
} {
  if (profile === null) return { judge: null, candidateJudge: null };
  return { judge: profile.judge, candidateJudge: profile.candidateJudge };
}
