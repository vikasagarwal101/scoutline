/**
 * Development-only native Jev judge adapter (dev-jev ticket; NOT a
 * production provider integration, not registered in any CLI surface).
 *
 * Translates the lean engine's normalized LeanJudgeInput/LeanJudgeResponse
 * boundary to one native System One POST: structured state (requirement,
 * scope, criteria, retained source documents) plus named Noul questions
 * — per-document relevance/support/refutation with deterministic safe
 * question IDs (`q0r`/`q0s`/`q0f`, index-based — never raw evidence IDs
 * as object keys). Source text is data inside state, never instructions;
 * question instructions reference stable source indexes only, not
 * untrusted URL/title text.
 *
 * Boundary rules (dev-jev brief + Sol preflight round):
 *   - endpoint/model/credential arrive ONLY via runtime config; no
 *     defaults, no env reads, no logging of config material.
 *   - one adapter invocation = exactly one HTTP attempt: native fetch
 *     (used by default when no fetch is injected), redirect: "error",
 *     no retries. The attempt timeout races BOTH the header wait and
 *     body consumption; every exit path cancels owned unread bodies
 *     and the resolved stream's active reader.
 *   - finite ceilings validated before dispatch: the complete request
 *     body (default 24 KiB — the probe input bound) and the response
 *     body (default 64 KiB). Config timers/caps must themselves be
 *     finite positive numbers.
 *   - strict response validation: exact question IDs, exact Noul types,
 *     finite probabilities [0,1], resolved model identity, usage MUST be
 *     a present object with both nonnegative integer counters (missing
 *     measurement is not measured zero — it is malformed).
 *   - non-success statuses classify from the STATUS without reading a
 *     (possibly stalled) body: 401/403 → AUTH, others → PROTOCOL; the
 *     body is cancelled, not consumed.
 *   - probability→boolean translation uses explicit experimental bounds
 *     (default .9/.1 — TRIAL values, not calibrated). Middle-band
 *     uncertainty is INDETERMINATE, never silently false: the wrapper
 *     throws typed JEV_DEV_INDETERMINATE, which the engine treats as a
 *     recognized non-contribution — pending cleared, judge NOT marked
 *     unavailable, rejudging only on changed evidence identity.
 *
 * ponytail: single flat module; AbortSignal plumbed via AbortController
 * (an external caller signal can be threaded when a caller exists).
 */

import { createHash } from "node:crypto";
import { ValidationError } from "./errors.js";
import { composedStopRootOf } from "./lean-candidate-transport.js";
import type { LeanJudgeInput, LeanJudgeResponse } from "./lean-investigation.js";

// ---------------------------------------------------------------------------
// Runtime config (no defaults — caller supplies everything)
// ---------------------------------------------------------------------------

export interface LeanJevAdapterConfig {
  /** Absolute endpoint URL. http: allowed only when allowHttp is true. */
  readonly endpoint: string;
  /** Route-specific model identifier, verbatim from runtime config. */
  readonly model: string;
  /** Bearer credential, used only in the Authorization header. */
  readonly apiKey: string;
  /** Explicit opt-in for non-https development endpoints. */
  readonly allowHttp?: boolean;
  /** Experimental true/false bounds for Noul probability translation. */
  readonly trueBound?: number;
  readonly falseBound?: number;
  /** Complete request body ceiling in bytes (default 24 KiB). */
  readonly maxRequestBytes?: number;
  /** Response body ceiling in bytes (default 64 KiB, the probe bound). */
  readonly maxResponseBytes?: number;
  /** Per-attempt timeout ms (default 15s, the probe bound). */
  readonly timeoutMs?: number;
  /**
   * Allowed resolved-model labels. When absent any non-empty resolved
   * model is accepted (dev route); never assume request==response.
   */
  readonly allowedModels?: readonly string[];
}

/** Symbol under which the wrapper attaches attempt metadata to the
 *  normalized response so engine diagnostics can preserve raw
 *  probabilities (uncertainty policy) without changing the judge
 *  function signature. */
export const LEAN_JEV_ATTEMPT_META = Symbol.for("leanJevAttemptMeta");

export interface LeanJevFetchLike {
  (input: string, init: {
    method: "POST";
    headers: Record<string, string>;
    body: string;
    redirect: "error";
    signal: AbortSignal;
  }): Promise<{
    readonly status: number;
    readonly ok: boolean;
    readonly headers: { get(name: string): string | null };
    readonly body: ReadableStream<Uint8Array> | null;
    readonly text?: () => Promise<string>;
  }>;
}

// ---------------------------------------------------------------------------
// Typed outcomes (sanitized — no body/header material crosses)
// ---------------------------------------------------------------------------

/** Experimental threshold policy revision, recorded in metadata. */
export const LEAN_JEV_THRESHOLD_REVISION = "trial-v1-p9-p1" as const;

/**
 * Source-uncertainty policy revision: middle-band Noul probabilities
 * normalize to per-source `null` (unknown) flags inside a COMPLETE
 * response, instead of discarding the whole attempt. Distinct from the
 * threshold and question revisions.
 */
export const LEAN_JEV_UNCERTAINTY_REVISION = "per-source-null-v1" as const;

export const LEAN_JEV_DEFAULT_MAX_REQUEST_BYTES = 24 * 1024;
export const LEAN_JEV_DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;
export const LEAN_JEV_DEFAULT_TIMEOUT_MS = 15_000;

export interface LeanJevAttemptMetadata {
  readonly attemptSha256: string;
  readonly requestedModel: string;
  readonly resolvedModel: string;
  readonly thresholdRevision: string;
  readonly questionRevision: string;
  readonly uncertaintyRevision: string;
  readonly status: number;
  readonly elapsedMs: number;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  /** Raw per-question probabilities actually observed (sanitized). */
  readonly probabilities: Readonly<Record<string, number>>;
  /** Observed cost field when present — metadata only, never a promise. */
  readonly observedCost: number | null;
}

export type LeanJevJudgeResult =
  | { readonly kind: "ok"; readonly response: LeanJudgeResponse; readonly metadata: LeanJevAttemptMetadata }
  | {
      readonly kind: "error";
      readonly code: "JEV_DEV_AUTH" | "JEV_DEV_PROTOCOL" | "JEV_DEV_NETWORK" | "JEV_DEV_TIMEOUT" | "JEV_DEV_MALFORMED" | "JEV_DEV_MODEL";
      readonly message: string;
      /** Validated composed-run stop root (finite vocabulary, shared
       *  with the candidate transport) — present only when the failure
       *  carried an approved stop marker; real network/timeout errors
       *  never do. */
      readonly stopReason?: string;
    };

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/** Deterministic safe question id for doc index i — never the evidenceId. */
function qid(i: number, kind: "r" | "s" | "f"): string {
  return `q${i}${kind}`;
}

function parseEndpoint(endpoint: string, allowHttp: boolean): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new ValidationError("Jev dev endpoint is not a valid absolute URL.");
  }
  if (url.username !== "" || url.password !== "") {
    throw new ValidationError("Jev dev endpoint must not embed userinfo.");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && allowHttp)) {
    throw new ValidationError(
      allowHttp
        ? "Jev dev endpoint protocol must be http: or https:."
        : "Jev dev endpoint must be https: (pass allowHttp for an explicit development route).",
    );
  }
  return url;
}

function finitePositiveConfig(config: LeanJevAdapterConfig): {
  maxRequestBytes: number;
  maxResponseBytes: number;
  timeoutMs: number;
  trueBound: number;
  falseBound: number;
} {
  const maxRequestBytes = config.maxRequestBytes ?? LEAN_JEV_DEFAULT_MAX_REQUEST_BYTES;
  const maxResponseBytes = config.maxResponseBytes ?? LEAN_JEV_DEFAULT_MAX_RESPONSE_BYTES;
  const timeoutMs = config.timeoutMs ?? LEAN_JEV_DEFAULT_TIMEOUT_MS;
  const trueBound = config.trueBound ?? 0.9;
  const falseBound = config.falseBound ?? 0.1;
  for (const [name, value] of [
    ["maxRequestBytes", maxRequestBytes],
    ["maxResponseBytes", maxResponseBytes],
    ["timeoutMs", timeoutMs],
  ] as const) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
      throw new ValidationError(`Jev dev config ${name} must be a positive finite integer.`);
    }
  }
  if (!(falseBound < trueBound) || trueBound <= 0.5 || trueBound >= 1 || falseBound >= 0.5 || falseBound < 0) {
    throw new ValidationError("Jev dev bounds must satisfy 0 <= falseBound < 0.5 < trueBound <= 1 with falseBound < trueBound.");
  }
  return { maxRequestBytes, maxResponseBytes, timeoutMs, trueBound, falseBound };
}

/**
 * Question-formulation revision (attribution wording only — distinct
 * from the threshold policy revision). v2: explicit backticked state
 * paths (`sources[i].text`, `requirement`, `scope`, `criteria`,
 * `sources`) so the designated document is identified by its structural
 * path, never by interpolated untrusted URL/title text; the full
 * `sources` array remains available as qualification context.
 */
export const LEAN_JEV_QUESTION_REVISION = "attribution-v2-explicit-paths" as const;

/** Build the native request body for one judgment (exported for tests). */
export function buildLeanJevRequest(input: LeanJudgeInput, model: string): string {
  const questions: Record<string, { type: "noul"; instructions: string }> = {};
  input.documents.forEach((_, i) => {
    // Explicit structured-path attribution: each question names its
    // designated document as `sources[i].text` and anchors judgment to
    // the declared `requirement`, `scope` and `criteria`; the whole
    // `sources` array is cited for qualifications/corrections. No
    // URL/title/content interpolation into instructions.
    questions[qid(i, "r")] = {
      type: "noul",
      instructions: `Judging only the designated document at \`sources[${i}].text\`: against \`requirement\`, \`scope\` and \`criteria\` (consulting the full \`sources\` context only for qualifications or corrections), is the designated document substantively relevant to answering the requirement? Answer the probability that it is.`,
    };
    questions[qid(i, "s")] = {
      type: "noul",
      instructions: `Judging only the designated document at \`sources[${i}].text\`: does that document explicitly state evidence SUPPORTING the \`requirement\` claim for the exact \`scope\`, per \`criteria\` (consulting the full \`sources\` context only for qualifications or corrections)? Answer the probability that it does.`,
    };
    questions[qid(i, "f")] = {
      type: "noul",
      instructions: `Judging only the designated document at \`sources[${i}].text\`: does that document explicitly state evidence REFUTING the \`requirement\` claim for the exact \`scope\`, per \`criteria\` (consulting the full \`sources\` context only for qualifications or corrections)? Answer the probability that it does.`,
    };
  });
  const body = {
    model,
    state: {
      requirement: input.fieldQuestion,
      scope: input.scope,
      criteria: input.criteria,
      candidates: input.candidates,
      // Unified proof: accepted prerequisite values + provenance
      // revision the classification is conditioned on. A dependency
      // re-accept on new evidence changes this object, so the serialized
      // request (and its identity) changes with the revision alone.
      depBindings: input.depBindings ?? {},
      sources: input.documents.map((doc) => ({
        id: doc.evidenceId,
        url: doc.url,
        title: doc.title,
        text: doc.content,
      })),
    },
    questions,
  };
  return JSON.stringify(body);
}

/** Owned-body cleanup: cancel without consuming (auth/status/timeout paths). */
function cancelBody(body: ReadableStream<Uint8Array> | null): void {
  body?.cancel().catch(() => {});
}

function abortError(): Error & { name: string } {
  const err = new Error("attempt timeout") as Error & { name: string };
  err.name = "AbortError";
  return err;
}

/**
 * One bounded native attempt. Returns a typed outcome; never throws raw
 * transport errors and never embeds response bodies or headers in errors.
 * Omitted fetchLike falls back to global fetch (native in Node ≥18).
 */
export async function runLeanJevJudgment(
  input: LeanJudgeInput,
  config: LeanJevAdapterConfig,
  fetchLike?: LeanJevFetchLike,
  now: () => number = () => Date.now(),
  /** Composition hook: receives the transport's own AbortController so
   *  a run-owned signal can abort the in-flight request through the
   *  same path as the transport timer (headers/chunk timers + body
   *  disposal all hang off it). Optional — existing callers unchanged. */
  onControllerReady?: (controller: AbortController) => void,
): Promise<LeanJevJudgeResult> {
  const { maxRequestBytes, maxResponseBytes, timeoutMs, trueBound, falseBound } =
    finitePositiveConfig(config);
  const url = parseEndpoint(config.endpoint, config.allowHttp === true);

  // --- finite input ceiling BEFORE any transport attempt ---------------
  const requestBody = buildLeanJevRequest(input, config.model);
  const requestBytes = Buffer.byteLength(requestBody, "utf8");
  if (requestBytes > maxRequestBytes) {
    throw new ValidationError(
      `Jev dev request (${requestBytes} bytes) exceeds the input ceiling (${maxRequestBytes} bytes).`,
    );
  }

  const controller = new AbortController();
  onControllerReady?.(controller);
  // Pre-dispatch cancellation: an ALREADY-aborted run signal settles
  // BEFORE any physical request (level-triggered, not merely listened
  // for, so an abort that fired before registration cannot be missed).
  if (controller.signal.aborted) {
    return { kind: "error", code: "JEV_DEV_TIMEOUT", message: "Jev dev request was cancelled before dispatch." };
  }
  const startedAt = now();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const deadline = startedAt + timeoutMs;
  const remaining = (): number => Math.max(1, deadline - now());
  const requestHash = createHash("sha256").update(requestBody).digest("hex");

  const finishMetadata = (
    status: number,
    probabilities: Record<string, number>,
    usage: { inputTokens: number; outputTokens: number },
    resolvedModel: string,
    observedCost: number | null,
  ): LeanJevAttemptMetadata => ({
    attemptSha256: requestHash,
    requestedModel: config.model,
    resolvedModel,
    thresholdRevision: LEAN_JEV_THRESHOLD_REVISION,
    questionRevision: LEAN_JEV_QUESTION_REVISION,
    uncertaintyRevision: LEAN_JEV_UNCERTAINTY_REVISION,
    status,
    elapsedMs: now() - startedAt,
    usage,
    probabilities,
    observedCost,
  });

  const fetchFn: LeanJevFetchLike = fetchLike ?? (globalThis.fetch as unknown as LeanJevFetchLike);
  if (typeof fetchFn !== "function") {
    clearTimeout(timer);
    return { kind: "error", code: "JEV_DEV_NETWORK", message: "Jev dev transport is unavailable." };
  }

  let response: Awaited<ReturnType<LeanJevFetchLike>>;
  let headerTimer: ReturnType<typeof setTimeout> | undefined;
  // Observe the losing fetch promise: a late-resolving response (after a
  // timeout settlement) has its body cancelled, and a late rejection is
  // consumed — no unread-body leak, no unhandled rejection.
  // Attach an eventual-settlement observer to the fetch promise itself:
  // on a timeout settlement the promise is still pending and a late
  // response gets its body cancelled; a late rejection is consumed. On
  // the success path the promise is already settled with the response we
  // are reading — cancelling an already-fully-read body is a no-op, and a
  // fully-drained reader makes stream.cancel() harmless.
  // Late-response disposal with EXPLICIT settlement tracking: the
  // observer microtask fires before the race await resumes (it was
  // attached first), so `response` cannot distinguish winners. A settled
  // flag set inside the race's own continuation is the only reliable
  // signal: if the fetch resolves and the race has NOT consumed it, the
  // body is late and gets cancelled; its rejection is consumed either way.
  let raceSettled = false;
  const observeFetch = (promise: Promise<Awaited<ReturnType<LeanJevFetchLike>>>): void => {
    promise.then(
      (late) => {
        // Double-microtask: the race continuation (queued after this
        // .then) must get its chance to set raceSettled before the
        // disposal decision runs — one queueMicrotask still fires first.
        queueMicrotask(() => {
          queueMicrotask(() => {
            if (!raceSettled) cancelBody(late.body);
          });
        });
      },
      () => {
        /* late rejection consumed */
      },
    );
  };
  try {
    // Race the header wait against the deadline — an injected fetch that
    // ignores the AbortSignal is still bounded. The losing timer is
    // cleared on EVERY settlement.
    const fetchPromise = fetchFn(url.toString(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.apiKey}`,
        accept: "application/json",
      },
      body: requestBody,
      redirect: "error",
      signal: controller.signal,
    });
    observeFetch(fetchPromise);
    let onHeaderAbort: (() => void) | undefined;
    try {
      response = await Promise.race([
        fetchPromise,
        // Abort is a SETTLING event, not just a flag: a fetch that
        // ignores its signal must still unblock this wait promptly.
        new Promise<never>((_, reject) => {
          headerTimer = setTimeout(() => reject(abortError()), remaining());
          onHeaderAbort = () => reject(abortError());
          controller.signal.addEventListener("abort", onHeaderAbort, { once: true });
          // Level-triggered: a pre-registration abort still settles.
          if (controller.signal.aborted) onHeaderAbort();
        }),
      ]);
      // A response arriving after cancellation is never a success.
      if (controller.signal.aborted) throw abortError();
      raceSettled = true;
    } finally {
      clearTimeout(headerTimer);
      if (onHeaderAbort !== undefined) {
        controller.signal.removeEventListener("abort", onHeaderAbort);
      }
    }
  } catch (error) {
    clearTimeout(headerTimer);
    clearTimeout(timer);
    const aborted = error instanceof Error && error.name === "AbortError";
    // Same FINITE trust boundary as the candidate transport: only an
    // approved stop code+root is preserved; anything else is discarded
    // without serializing the raw marker.
    const typedStop = composedStopRootOf(error);
    return {
      kind: "error",
      code: aborted ? "JEV_DEV_TIMEOUT" : "JEV_DEV_NETWORK",
      ...(typedStop !== null ? { stopReason: typedStop } : {}),
      message: aborted ? "Jev dev request exceeded the attempt timeout." : "Jev dev request failed at the transport layer.",
    };
  }

  // --- status classification WITHOUT reading the body ------------------
  if (response.status === 401 || response.status === 403) {
    clearTimeout(timer);
    cancelBody(response.body);
    return { kind: "error", code: "JEV_DEV_AUTH", message: `Jev dev endpoint rejected credentials (status ${response.status}).` };
  }
  if (!response.ok) {
    clearTimeout(timer);
    cancelBody(response.body);
    return { kind: "error", code: "JEV_DEV_PROTOCOL", message: `Jev dev endpoint returned status ${response.status}.` };
  }

  // --- bounded body consumption with owned cancellation ----------------
  let bodyText: string;
  let ownedReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const reader = response.body?.getReader();
    ownedReader = reader;
    if (reader === undefined) {
      bodyText = "";
    } else {
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      while (true) {
        // Per-chunk deadline race with the losing timer CLEARED on every
        // settlement — no accumulating timeout handles past the read.
        let chunkTimer: ReturnType<typeof setTimeout> | undefined;
        let onChunkAbort: (() => void) | undefined;
        const read = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => {
            chunkTimer = setTimeout(() => reject(abortError()), remaining());
            onChunkAbort = () => reject(abortError());
            controller.signal.addEventListener("abort", onChunkAbort, { once: true });
            // Level-triggered: a between-phase abort is caught.
            if (controller.signal.aborted) onChunkAbort();
          }),
        ]).finally(() => {
          clearTimeout(chunkTimer);
          if (onChunkAbort !== undefined) {
            controller.signal.removeEventListener("abort", onChunkAbort);
          }
        });
        // A chunk arriving after cancellation never resumes a parse.
        if (controller.signal.aborted) throw abortError();
        if (read.done) break;
        if (read.value) {
          totalBytes += read.value.byteLength;
          if (totalBytes > maxResponseBytes) {
            // Owned reader: cancel the active stream, never leave pending.
            await reader.cancel().catch(() => {});
            clearTimeout(timer);
            return { kind: "error", code: "JEV_DEV_PROTOCOL", message: "Jev dev response exceeded the bounded body ceiling." };
          }
          chunks.push(Buffer.from(read.value.buffer, read.value.byteOffset, read.value.byteLength));
        }
      }
      bodyText = Buffer.concat(chunks).toString("utf8");
    }
  } catch (error) {
    clearTimeout(timer);
    // Cancel the OWNED READER (the stream is locked to it) — a stalled
    // stream must be cancelled, never left pending.
    ownedReader?.cancel().catch(() => {});
    const aborted = error instanceof Error && error.name === "AbortError";
    const typedStopBody = composedStopRootOf(error);
    return {
      kind: "error",
      code: aborted ? "JEV_DEV_TIMEOUT" : "JEV_DEV_NETWORK",
      ...(typedStopBody !== null ? { stopReason: typedStopBody } : {}),
      message: aborted ? "Jev dev request timed out during body consumption." : "Jev dev response body could not be read.",
    };
  }
  clearTimeout(timer);

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { kind: "error", code: "JEV_DEV_MALFORMED", message: "Jev dev response was not valid JSON." };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "error", code: "JEV_DEV_MALFORMED", message: "Jev dev response was not an object." };
  }
  const raw = parsed as Record<string, unknown>;
  const resolvedModel = raw.model;
  if (typeof resolvedModel !== "string" || resolvedModel.length === 0) {
    return { kind: "error", code: "JEV_DEV_MALFORMED", message: "Jev dev response lacked a resolved model identity." };
  }
  if (config.allowedModels !== undefined && !config.allowedModels.includes(resolvedModel)) {
    return { kind: "error", code: "JEV_DEV_MODEL", message: "Jev dev response resolved to a model outside the allowed set." };
  }
  // --- STRICT usage: present object, both counters nonnegative ints ----
  const usageRaw = raw.usage;
  if (
    typeof usageRaw !== "object" ||
    usageRaw === null ||
    Array.isArray(usageRaw) ||
    typeof (usageRaw as Record<string, unknown>).input_tokens !== "number" ||
    typeof (usageRaw as Record<string, unknown>).output_tokens !== "number" ||
    !Number.isSafeInteger((usageRaw as Record<string, unknown>).input_tokens) ||
    !Number.isSafeInteger((usageRaw as Record<string, unknown>).output_tokens) ||
    ((usageRaw as Record<string, unknown>).input_tokens as number) < 0 ||
    ((usageRaw as Record<string, unknown>).output_tokens as number) < 0
  ) {
    return { kind: "error", code: "JEV_DEV_MALFORMED", message: "Jev dev usage must be a present object with nonnegative integer input_tokens/output_tokens." };
  }
  const usage = usageRaw as { input_tokens: number; output_tokens: number };
  const cost = typeof raw.cost === "number" && Number.isFinite(raw.cost) ? raw.cost : null;

  // --- answers: exact ID set, exact noul type, finite [0,1] -----------
  const answersRaw = raw.answers;
  if (typeof answersRaw !== "object" || answersRaw === null || Array.isArray(answersRaw)) {
    return { kind: "error", code: "JEV_DEV_MALFORMED", message: "Jev dev response lacked an answers object." };
  }
  const expectedIds = new Set<string>();
  input.documents.forEach((_, i) => {
    expectedIds.add(qid(i, "r"));
    expectedIds.add(qid(i, "s"));
    expectedIds.add(qid(i, "f"));
  });
  const answerIds = Object.keys(answersRaw);
  for (const id of answerIds) {
    if (!expectedIds.has(id)) {
      return { kind: "error", code: "JEV_DEV_PROTOCOL", message: "Jev dev response contained an unknown question id." };
    }
  }
  for (const id of expectedIds) {
    if (!(id in (answersRaw as Record<string, unknown>))) {
      return { kind: "error", code: "JEV_DEV_PROTOCOL", message: "Jev dev response was missing a requested question id." };
    }
  }
  const probabilities: Record<string, number> = {};
  for (const [id, value] of Object.entries(answersRaw as Record<string, unknown>)) {
    const entry = value as Record<string, unknown> | null;
    if (typeof entry !== "object" || entry === null || entry.type !== "noul" || typeof entry.noul !== "number" || !Number.isFinite(entry.noul) || entry.noul < 0 || entry.noul > 1) {
      return { kind: "error", code: "JEV_DEV_PROTOCOL", message: `Jev dev answer ${id} was not a finite noul probability in [0,1].` };
    }
    probabilities[id] = entry.noul;
  }

  const metadata = finishMetadata(response.status, probabilities, { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens }, resolvedModel, cost);

  // --- threshold translation (per-source uncertainty policy) -----------
  // Middle-band probability → per-source `null` (unknown) flag inside a
  // COMPLETE response; the attempt is never discarded for uncertainty.
  // Raw probabilities remain in metadata for inspection.
  const documents = input.documents.map((doc, i) => {
    const readP = (k: "r" | "s" | "f"): boolean | null => {
      const p = probabilities[qid(i, k)]!;
      if (p >= trueBound) return true;
      if (p <= falseBound) return false;
      return null;
    };
    return {
      evidenceId: doc.evidenceId,
      relevant: readP("r"),
      supportsClaim: readP("s"),
      refutesClaim: readP("f"),
    };
  });
  return { kind: "ok", response: { documents }, metadata };
}

/**
 * Wrap the adapter as the engine's judge dep.
 *
 * JEV_DEV_INDETERMINATE throws typed — the engine's recognized-code path
 * treats it as a non-contribution (pending cleared, judge NOT
 * unavailable, rejudge only on changed evidence identity).
 * Every other error also throws typed; the engine's containment marks
 * the field judge_unavailable (permanent) as before.
 */
export function createLeanJevJudge(
  config: LeanJevAdapterConfig,
  fetchLike?: LeanJevFetchLike,
  hooks?: { readonly onAttempt?: (result: LeanJevJudgeResult) => void },
): (input: LeanJudgeInput, options?: { timeoutMs?: number; signal?: AbortSignal }) => Promise<LeanJudgeResponse> {
  return async (input: LeanJudgeInput, options?: { timeoutMs?: number; signal?: AbortSignal }) => {
    // Runtime composition (unified proof): the engine hands each
    // dispatch the REMAINING run time and a run-owned AbortSignal. The
    // native timeout CLAMPS to the remaining time (never lengthens the
    // fixed config) and the run signal aborts in-flight work through
    // the SAME controller the transport timer uses — so a 10ms run
    // bounds a 1000ms-configured request, and run expiry cancels a
    // request even while awaited.
    const baseTimeout = config.timeoutMs ?? LEAN_JEV_DEFAULT_TIMEOUT_MS;
    const clampedTimeout =
      options?.timeoutMs !== undefined && Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0
        ? Math.min(baseTimeout, options.timeoutMs)
        : baseTimeout;
    const runSignal = options?.signal;
    let onRunAbort: (() => void) | undefined;
    if (runSignal !== undefined) {
      onRunAbort = () => controllerAbortBridge?.abort();
      runSignal.addEventListener("abort", onRunAbort, { once: true });
    }
    // The bridge is created by runLeanJevJudgment via an injection hook
    // (the native function keeps its stable signature for existing
    // callers); cleanup happens in finally below.
    let controllerAbortBridge: AbortController | undefined;
    let externalAbortBound = false;
    const bridgeCapture = (c: AbortController): void => {
      controllerAbortBridge = c;
      if (runSignal?.aborted) c.abort();
    };
    try {
      const result = await runLeanJevJudgment(
        input,
        { ...config, timeoutMs: clampedTimeout },
        fetchLike,
        undefined,
        runSignal === undefined ? undefined : bridgeCapture,
      );
      externalAbortBound = controllerAbortBridge !== undefined;
      hooks?.onAttempt?.(result);
      if (result.kind === "ok") {
        // Carry attempt metadata (incl. raw probabilities) into the engine
        // via a symbol-keyed own property on the response object.
        const enriched = { ...result.response, [LEAN_JEV_ATTEMPT_META]: result.metadata };
        return enriched;
      }
      const err = new Error(result.message) as Error & { code?: string; reason?: string };
      err.code = result.code;
      // Structured (validated) stop root — the engine promotion seam
      // checks exact vocabulary membership; raw error text is never
      // serialized into reasons or audit rows.
      if (typeof result.stopReason === "string") err.reason = result.stopReason;
      throw err;
    } finally {
      // Listener cleanup on EVERY exit (ok, typed error, throw).
      if (runSignal !== undefined && onRunAbort !== undefined) {
        runSignal.removeEventListener("abort", onRunAbort);
      }
      void externalAbortBound;
    }
  };
}
