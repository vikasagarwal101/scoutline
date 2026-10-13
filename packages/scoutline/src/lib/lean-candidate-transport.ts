/**
 * Native transports for the arbitrary-candidate path (arbitrary-candidates
 * ticket; dev POC — NOT production attestation, no CLI registration).
 *
 * Two injected-config native calls, reusing the deadline/reader discipline
 * proven in lean-jev-adapter (NOT a casual copy — the race-settlement,
 * owned-reader-cancel and late-response-disposal patterns are re-derived
 * here with the same guards their suite pinned):
 *
 *  1. runLunaExtraction — OpenAI-compatible chat-completions structured
 *     output for the extractor (per EXTRACTION-COMPARISON, generation
 *     models use native chat-completions, not System One). Runtime env:
 *     LUNA_DEV_ENDPOINT/LUNA_DEV_MODEL/LUNA_DEV_API_KEY (parent-only;
 *     never defaults, never logged). finishReason must be "stop";
 *     usage counters REQUIRED present (no fabricated zero); response
 *     body bounded; request cap finite exact serialized bytes (schema +
 *     framing + full source), over → typed JEV_DEV-style error, never
 *     silent trim.
 *
 *  2. runCandidateJudge — System One native request built by
 *     buildCandidateJudgeRequest; same strict native validation as the
 *     enum adapter (exact ids/types/finite noul, resolved model, strict
 *     usage); allowedModels runtime-supplied; per-dispatch timeout.
 *
 * Both: one invocation = one HTTP attempt (no retries), redirect
 * forbidden, timer cleared on every race settlement, owned reader
 * cancelled on timeout/oversize, late responses disposed, sanitized
 * typed errors only (no body/header/config material).
 */

import { createHash } from "node:crypto";
import { ValidationError } from "./errors.js";
import type { CandidateJudgeInput } from "./lean-candidates.js";

// ---------------------------------------------------------------------------
// Shared transport core (single derivation of the deadline discipline)
// ---------------------------------------------------------------------------

export interface TransportConfig {
  readonly endpoint: string;
  readonly model: string;
  readonly apiKey: string;
  readonly allowHttp?: boolean;
  /** Finite exact serialized REQUEST ceiling (framing + schema + source). */
  readonly maxRequestBytes: number;
  readonly maxResponseBytes: number;
  readonly timeoutMs: number;
  readonly allowedModels?: readonly string[];
}

export interface TransportLike {
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
  }>;
}

export type TransportError = {
  readonly kind: "error";
  readonly code: "CAND_AUTH" | "CAND_PROTOCOL" | "CAND_NETWORK" | "CAND_TIMEOUT" | "CAND_MALFORMED" | "CAND_MODEL" | "CAND_REQUEST_CAP";
  readonly message: string;
  /** Structured composed-run stop root (e.g. global_extraction_cap)
   *  carried through normalization — present only when the failing
   *  dependency attached it; real network/timeout errors never do. */
  readonly stopReason?: string;
  /**
   * Observed metadata for a REJECTED attempt when the response carried it
   * (request hash, resolved model, measured usage, elapsed). Present only
   * when genuinely measured — never fabricated; null before any response
   * exists. Failure work counts in cost/time reporting.
   */
  readonly observed?: {
    readonly requestSha256: string;
    readonly requestedModel: string;
    readonly resolvedModel: string;
    readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
    readonly elapsedMs: number;
    readonly status?: number;
  };
};

export interface TransportOk<T> {
  readonly kind: "ok";
  readonly value: T;
  readonly metadata: {
    readonly requestSha256: string;
    readonly requestedModel: string;
    readonly resolvedModel: string;
    readonly status: number;
    readonly elapsedMs: number;
    readonly usage: { readonly inputTokens: number; readonly outputTokens: number; readonly reasoningTokens?: number };
    readonly observedCost: number | null;
    /**
     * Physical HTTP dispatches this result consumed (unified-investigation
     * finding 1): one per completed nativePost call. The native transport
     * is single-shot — retries, when they exist, live above this seam and
     * each surfaces as its own ok/error result — so a consumer merging
     * results reports Σattempts, and a caller wrapping two calls in one
     * logical producer invocation reports 2, not 1. Informational only;
     * no dispatch decision reads it.
     */
    readonly attempts: number;
  };
}

function parseEndpoint(endpoint: string, allowHttp: boolean): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new ValidationError("Candidate dev endpoint is not a valid absolute URL.");
  }
  if (url.username !== "" || url.password !== "") {
    throw new ValidationError("Candidate dev endpoint must not embed userinfo.");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && allowHttp)) {
    throw new ValidationError(
      allowHttp
        ? "Candidate dev endpoint protocol must be http: or https:."
        : "Candidate dev endpoint must be https: (pass allowHttp for an explicit development route).",
    );
  }
  return url;
}

function validateTransportConfig(config: TransportConfig): void {
  for (const [name, value] of [
    ["maxRequestBytes", config.maxRequestBytes],
    ["maxResponseBytes", config.maxResponseBytes],
    ["timeoutMs", config.timeoutMs],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new ValidationError(`Candidate transport ${name} must be a positive safe integer.`);
    }
  }
}

function abortError(): Error & { name: string } {
  const err = new Error("attempt timeout") as Error & { name: string };
  err.name = "AbortError";
  return err;
}

/**
 * One bounded native POST. Generic over the parsed body; the caller owns
 * validation of the payload. Enforces: request cap (exact serialized
 * bytes), no redirects, single attempt, deadline raced at header AND body,
 * owned-reader cancel, late-response disposal, sanitized typed errors.
 *
 * Composition wrapper: single listener-cleanup point on EVERY exit
 * path (ok, typed error, throw) — the inner function keeps its many
 * early returns untouched.
 */
async function nativePost<T>(
  config: TransportConfig,
  requestBody: string,
  protocol: "chat" | "systemone",
  parse: (parsedJson: Record<string, unknown>) => TransportError | { kind: "ok"; value: T },
  fetchLike?: TransportLike,
  now: () => number = () => Date.now(),
  options?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<TransportOk<T> | TransportError> {
  let runSignal: AbortSignal | undefined;
  let onRunAbort: (() => void) | undefined;
  try {
    runSignal = options?.signal;
    return await nativePostInner(config, requestBody, protocol, parse, fetchLike, now, {
      timeoutMs: options?.timeoutMs,
      get signal() { return runSignal; },
      bindAbort(c: AbortController) {
        if (runSignal === undefined) return;
        onRunAbort = () => c.abort();
        runSignal.addEventListener("abort", onRunAbort, { once: true });
        if (runSignal.aborted) c.abort();
      },
    });
  } finally {
    if (runSignal !== undefined && onRunAbort !== undefined) {
      runSignal.removeEventListener("abort", onRunAbort);
    }
  }
}

/**
 * FINITE composed-run stop-root vocabulary (trust boundary): a stop
 * reason is preserved through normalization ONLY when the error is the
 * approved stop type (code EVAL_STOPPED) AND the reason is EXACTLY one
 * of the declared roots. Anything else — wrong code, unknown/oversized/
 * arbitrary "global_"-prefixed strings, private dependency text — is
 * DISCARDED without serializing the raw marker. Ordinary network/
 * timeout/auth/protocol classification is untouched.
 */
export const COMPOSED_STOP_ROOTS: ReadonlySet<string> = new Set([
  "global_extraction_cap",
  "global_judgment_cap",
  "global_deadline",
]);
export function composedStopRootOf(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const code = (error as { code?: unknown }).code;
  const reason = (error as { reason?: unknown }).reason;
  if (code !== "EVAL_STOPPED") return null;
  if (typeof reason !== "string") return null;
  return COMPOSED_STOP_ROOTS.has(reason) ? reason : null;
};

async function nativePostInner<T>(
  config: TransportConfig,
  requestBody: string,
  protocol: "chat" | "systemone",
  parse: (parsedJson: Record<string, unknown>) => TransportError | { kind: "ok"; value: T },
  fetchLike?: TransportLike,
  now: () => number = () => Date.now(),
  inner?: { timeoutMs?: number; signal?: AbortSignal; bindAbort(c: AbortController): void },
): Promise<TransportOk<T> | TransportError> {
  validateTransportConfig(config);
  if (inner?.timeoutMs !== undefined && Number.isSafeInteger(inner.timeoutMs) && inner.timeoutMs > 0) {
    config = { ...config, timeoutMs: Math.min(config.timeoutMs, inner.timeoutMs) };
  }
  const url = parseEndpoint(config.endpoint, config.allowHttp === true);

  const requestBytes = Buffer.byteLength(requestBody, "utf8");
  if (requestBytes > config.maxRequestBytes) {
    return {
      kind: "error",
      code: "CAND_REQUEST_CAP",
      message: `Serialized request (${requestBytes} bytes) exceeds the ${config.maxRequestBytes}-byte ceiling — reduce source/context, never trimmed silently.`,
    };
  }
  const requestHash = createHash("sha256").update(requestBody).digest("hex");

  const controller = new AbortController();
  inner?.bindAbort?.(controller);
  // Pre-dispatch cancellation: an ALREADY-aborted run signal must settle
  // BEFORE any physical fetch — zero requests begun, and no attempt
  // charged. (Level-triggered: checked, not merely listened for, so an
  // abort that fired before registration cannot be missed.)
  if (controller.signal.aborted) {
    return { kind: "error", code: "CAND_TIMEOUT", message: "Candidate dev request was cancelled before dispatch." };
  }
  const startedAt = now();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  const deadline = startedAt + config.timeoutMs;
  const remaining = (): number => Math.max(1, deadline - now());
  const fetchFn: TransportLike = fetchLike ?? (globalThis.fetch as unknown as TransportLike);
  if (typeof fetchFn !== "function") {
    clearTimeout(timer);
    return { kind: "error", code: "CAND_NETWORK", message: "Candidate transport is unavailable." };
  }

  let response: Awaited<ReturnType<TransportLike>>;
  let headerTimer: ReturnType<typeof setTimeout> | undefined;
  let onHeaderAbort: (() => void) | undefined;
  let raceSettled = false;
  const observeFetch = (promise: Promise<Awaited<ReturnType<TransportLike>>>): void => {
    promise.then(
      (late) => {
        queueMicrotask(() => {
          queueMicrotask(() => {
            if (!raceSettled) late.body?.cancel().catch(() => {});
          });
        });
      },
      () => {
        /* late rejection consumed */
      },
    );
  };
  try {
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
    try {
      response = await Promise.race([
        fetchPromise,
        // The abort signal is a SETTLING event, not just a flag: a
        // fetch that ignores its signal must still unblock the header
        // wait promptly. Race fetch vs timeout vs abort-signal; the
        // winner rejects with the typed abort error, and observeFetch
        // disposes the late body.
        new Promise<never>((_, reject) => {
          headerTimer = setTimeout(() => reject(abortError()), remaining());
          onHeaderAbort = () => reject(abortError());
          controller.signal.addEventListener("abort", onHeaderAbort, { once: true });
          // Level-triggered: an abort that fired BEFORE this listener
          // was registered must still settle the wait.
          if (controller.signal.aborted) onHeaderAbort();
        }),
      ]);
      // Aborted mid-flight: a response that arrives after cancellation
      // is never a success.
      if (controller.signal.aborted) throw abortError();
      raceSettled = true;
    } finally {
      clearTimeout(headerTimer);
      if (onHeaderAbort !== undefined) {
        controller.signal.removeEventListener("abort", onHeaderAbort);
      }
    }
  } catch (error) {
    clearTimeout(timer);
    clearTimeout(headerTimer);
    if (onHeaderAbort !== undefined) {
      controller.signal.removeEventListener("abort", onHeaderAbort);
    }
    const aborted = error instanceof Error && error.name === "AbortError";
    // Structured stop preservation: a composed-run stop (cap/deadline)
    // carries its typed root reason ON the error object; it must survive
    // normalization so terminal field reasons name the root, not a
    // generic network refusal. Real network/timeout errors carry no
    // marker and classify exactly as before.
    const typedStop = composedStopRootOf(error);
    return {
      kind: "error",
      code: aborted ? "CAND_TIMEOUT" : "CAND_NETWORK",
      ...(typedStop !== null ? { stopReason: typedStop } : {}),
      message: aborted ? "Candidate dev request exceeded the attempt timeout." : "Candidate dev request failed at the transport layer.",
    };
  }

  if (response.status === 401 || response.status === 403) {
    clearTimeout(timer);
    response.body?.cancel().catch(() => {});
    return { kind: "error", code: "CAND_AUTH", message: `Candidate dev endpoint rejected credentials (status ${response.status}).` };
  }
  if (!response.ok) {
    clearTimeout(timer);
    response.body?.cancel().catch(() => {});
    return { kind: "error", code: "CAND_PROTOCOL", message: `Candidate dev endpoint returned status ${response.status}.` };
  }

  // Owned bounded body read with per-chunk deadline race + timer cleanup.
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
        let chunkTimer: ReturnType<typeof setTimeout> | undefined;
        let onChunkAbort: (() => void) | undefined;
        const read = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => {
            chunkTimer = setTimeout(() => reject(abortError()), remaining());
            onChunkAbort = () => reject(abortError());
            controller.signal.addEventListener("abort", onChunkAbort, { once: true });
            // Level-triggered: a between-phases abort is caught even if
            // it fired before this read's listener was registered.
            if (controller.signal.aborted) onChunkAbort();
          }),
        ]).finally(() => {
          clearTimeout(chunkTimer);
          if (onChunkAbort !== undefined) {
            controller.signal.removeEventListener("abort", onChunkAbort);
          }
        });
        // A chunk that arrives after cancellation never resumes a
        // successful parse.
        if (controller.signal.aborted) throw abortError();
        if (read.done) break;
        if (read.value) {
          totalBytes += read.value.byteLength;
          if (totalBytes > config.maxResponseBytes) {
            await reader.cancel().catch(() => {});
            clearTimeout(timer);
            return { kind: "error", code: "CAND_PROTOCOL", message: "Candidate dev response exceeded the bounded body ceiling." };
          }
          chunks.push(Buffer.from(read.value.buffer, read.value.byteOffset, read.value.byteLength));
        }
      }
      bodyText = Buffer.concat(chunks).toString("utf8");
    }
  } catch (error) {
    clearTimeout(timer);
    ownedReader?.cancel().catch(() => {});
    const aborted = error instanceof Error && error.name === "AbortError";
    // Structured stop preservation: a composed-run stop (cap/deadline)
    // carries its typed root reason ON the error object; it must survive
    // normalization so terminal field reasons name the root, not a
    // generic network refusal. Real network/timeout errors carry no
    // marker and classify exactly as before.
    const typedStop = composedStopRootOf(error);
    return {
      kind: "error",
      code: aborted ? "CAND_TIMEOUT" : "CAND_NETWORK",
      ...(typedStop !== null ? { stopReason: typedStop } : {}),
      message: aborted ? "Candidate dev request timed out during body consumption." : "Candidate dev response body could not be read.",
    };
  }
  clearTimeout(timer);

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(bodyText);
  } catch {
    return { kind: "error", code: "CAND_MALFORMED", message: "Candidate dev response was not valid JSON." };
  }
  if (parsedJson === null || typeof parsedJson !== "object") {
    return { kind: "error", code: "CAND_MALFORMED", message: "Candidate dev response was not an object." };
  }
  const raw = parsedJson as Record<string, unknown>;
  const resolvedModel = raw.model;
  if (typeof resolvedModel !== "string" || resolvedModel.length === 0) {
    return { kind: "error", code: "CAND_MALFORMED", message: "Candidate dev response lacked a resolved model identity." };
  }
  if (config.allowedModels !== undefined && !config.allowedModels.includes(resolvedModel)) {
    // Rejected for model identity — but everything safely parsed so far
    // (status/hash/requested model/resolved identity/usage) is conserved
    // as observed failure work. No raw body/config material crosses.
    const usageEarly = parseUsage(raw.usage, protocol);
    return {
      kind: "error",
      code: "CAND_MODEL",
      message: "Candidate dev response resolved to a model outside the allowed set.",
      observed: usageEarly === null ? undefined : {
        requestSha256: requestHash,
        requestedModel: config.model,
        resolvedModel,
        usage: usageEarly,
        elapsedMs: now() - startedAt,
        status: response.status,
      },
    };
  }
  // Protocol-strict usage (parametrized): each native protocol requires
  // ITS OWN counter names — chat completions (prompt/completion) and
  // System One (input/output) never cross-substitute.
  const usage = parseUsage(raw.usage, protocol);
  if (usage === null) {
    return { kind: "error", code: "CAND_MALFORMED", message: "Candidate dev usage counters must be the protocol's own present nonnegative integers." };
  }

  // Parser-callback containment: a throwing parser is a typed MALFORMED
  // outcome, never a raw TypeError escaping the transport.
  let parsed: TransportError | { kind: "ok"; value: T };
  try {
    parsed = parse(raw);
  } catch {
    return {
      kind: "error",
      code: "CAND_MALFORMED",
      message: "Candidate dev response could not be parsed into the expected shape.",
      observed: { requestSha256: requestHash, requestedModel: config.model, resolvedModel, usage, elapsedMs: now() - startedAt },
    };
  }
  if (parsed.kind === "error") {
    // Conserve measured identity/usage on rejected attempts.
    return { ...parsed, observed: { requestSha256: requestHash, requestedModel: config.model, resolvedModel, usage, elapsedMs: now() - startedAt } };
  }

  // Chat-protocol reasoning tokens are a completion-token SUBSET detail
  // (already inside completion_tokens): preserved for observability,
  // never added again when computing billed output.
  const details = (raw.usage as { completion_tokens_details?: { reasoning_tokens?: unknown } } | undefined | null)
    ?.completion_tokens_details;
  const reasoningTokens =
    protocol === "chat" &&
    details &&
    typeof details.reasoning_tokens === "number" &&
    Number.isSafeInteger(details.reasoning_tokens) &&
    details.reasoning_tokens >= 0
      ? details.reasoning_tokens
      : undefined;
  return {
    kind: "ok",
    value: parsed.value,
    metadata: {
      requestSha256: requestHash,
      requestedModel: config.model,
      resolvedModel,
      status: response.status,
      elapsedMs: now() - startedAt,
      usage: { ...usage, ...(reasoningTokens !== undefined ? { reasoningTokens } : {}) },
      observedCost: typeof raw.cost === "number" && Number.isFinite(raw.cost) ? raw.cost : null,
      attempts: 1,
    },
  };
}

/** Extract the PROTOCOL-NATIVE usage counters (no cross-protocol fallback). */
function parseUsage(
  usageRaw: unknown,
  protocol: "chat" | "systemone",
): { inputTokens: number; outputTokens: number } | null {
  if (typeof usageRaw !== "object" || usageRaw === null) return null;
  const u = usageRaw as Record<string, unknown>;
  const pickInt = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
  if (protocol === "chat") {
    const i = pickInt(u.prompt_tokens);
    const o = pickInt(u.completion_tokens);
    return i === undefined || o === undefined ? null : { inputTokens: i, outputTokens: o };
  }
  const i = pickInt(u.input_tokens);
  const o = pickInt(u.output_tokens);
  return i === undefined || o === undefined ? null : { inputTokens: i, outputTokens: o };
}

// ---------------------------------------------------------------------------
// 1. Extractor (chat-completions structured output)
// ---------------------------------------------------------------------------

export interface LunaExtractionRequest {
  readonly sourceId: string;
  readonly sourceText: string;
  readonly fields: readonly { readonly id: string; readonly description: string; readonly depBindings?: Readonly<Record<string, unknown>> }[];
  /** Unified proof: contract scope the extraction is conditioned on. */
  readonly scope?: Readonly<Record<string, string>>;
  /** Unified proof: accepted prerequisite values + provenance the
   *  extractor must interpret dependent fields under. */
  readonly depBindings?: Readonly<Record<string, unknown>>;
}

/**
 * Build the chat-completions body (exported for tests) using the
 * MEASURED Luna extraction contract: native strict `json_schema` with
 * one named nullable {value, quote} object per requested field,
 * additionalProperties:false at both levels, plus the explicit
 * extraction instructions the successful development sample used
 * (schema alone did not make this route extract — see
 * EXTRACTION-COMPARISON). A bare json_object response_format does NOT
 * request this contract and is not used.
 */
export function buildLunaRequestBody(req: LunaExtractionRequest, model: string): string {
  const fieldSchema = Object.fromEntries(
    req.fields.map((f) => [
      f.id,
      {
        type: "object",
        additionalProperties: false,
        properties: {
          value: { type: ["string", "null"], description: `Exact literal ${f.description}` },
          quote: { type: ["string", "null"], description: "Exact verbatim source passage containing the value" },
        },
        required: ["value", "quote"],
      },
    ]),
  );
  // Explicit output-envelope instructions: recorded boundary nonconformance
  // (flat {id,value,quote} / flat-null outputs on otherwise-correct requests)
  // motivates binding the keyed shape in prose, not only in response_format.
  // Structural placeholders only - never source-derived values or defaults.
  const envelopeExample = Object.fromEntries(
    req.fields.map((f) => [
      f.id,
      { value: "<<text-value-placeholder>>", quote: "<<verbatim-quote-placeholder>>" },
    ]),
  );
  const envelopeInstructions =
    ` Output envelope: return exactly one JSON object whose top-level keys are exactly the requested field IDs (${req.fields
      .map((f) => JSON.stringify(f.id))
      .join(", ")}). ` +
    `Each field ID maps to an object with exactly two keys, "value" and "quote". ` +
    `Structural placeholder illustration of the envelope only - the placeholder strings are not answers, evidence, or defaults: ${JSON.stringify(
      envelopeExample,
    )}. ` +
    `When a field is absent, ambiguous, or conflicting, express abstention as the null pair nested beneath that field's ID: {"value":null,"quote":null}. ` +
    `Do not return an array; do not return a flat top-level {"id","value","quote"} record or a flat top-level {"value","quote"} pair; ` +
    `no markdown fences and no commentary or explanation around the JSON.`;
  return JSON.stringify({
    model,
    temperature: 0,
    messages: [
      {
        role: "system",
        content:
          "You are an exact-value extractor. For each requested field return its value and the exact verbatim source quote containing it, or null for both when the field is absent, ambiguous, or a conflicting value exists for the field's exact scope. Never invent values; never paraphrase; quote must appear verbatim in the source. Use only the provided source." + envelopeInstructions,
      },
      {
        role: "user",
        // Unified proof: scope and explicit dependency bindings ride the
        // wire state — the extractor interprets dependent fields under
        // the ACCEPTED prerequisite values, never invents scope.
        content: JSON.stringify({
          source: req.sourceText,
          fields: req.fields,
          scope: req.scope ?? {},
          depBindings: req.depBindings ?? {},
        }),
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "candidate_extraction",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: fieldSchema,
          required: req.fields.map((f) => f.id),
        },
      },
    },
  });
}

export async function runLunaExtraction(
  req: LunaExtractionRequest,
  config: TransportConfig,
  fetchLike?: TransportLike,
  now: () => number = () => Date.now(),
  /** Composition options: forwarded to the native core (unified proof —
   *  the public entrypoint is the runtime composition path, so options
   *  must reach nativePost, not just exist there). */
  options?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<TransportOk<{ readonly finishReason: string; readonly rawOutput: string }> | TransportError> {
  const body = buildLunaRequestBody(req, config.model);
  return nativePost(
    config,
    body,
    "chat",
    (raw) => {
      const choices = raw.choices;
      if (!Array.isArray(choices) || choices.length === 0) {
        return { kind: "error", code: "CAND_MALFORMED", message: "Candidate extractor response lacked choices." };
      }
      const choice = choices[0] as Record<string, unknown> | null;
      // Null choice entries are contained, never dereferenced raw.
      if (choice === null || typeof choice !== "object") {
        return { kind: "error", code: "CAND_MALFORMED", message: "Candidate extractor choice was not an object." };
      }
      const finishReason = choice.finish_reason;
      const message = choice.message as Record<string, unknown> | null | undefined;
      const content = message && typeof message === "object" ? message.content : undefined;
      const refusal = message && typeof message === "object" ? message.refusal : undefined;
      if (typeof finishReason !== "string" || typeof content !== "string") {
        return { kind: "error", code: "CAND_MALFORMED", message: "Candidate extractor response lacked finish_reason/content." };
      }
      // EXPLICIT REFUSAL is a refusal regardless of apparently valid
      // content — relayed as finishReason "refusal" so validation
      // rejects the whole response.
      if (typeof refusal === "string" && refusal.length > 0) {
        return { kind: "ok", value: { finishReason: "refusal", rawOutput: content } };
      }
      return { kind: "ok", value: { finishReason, rawOutput: content } };
    },
    fetchLike,
    now,
    options,
  );
}

// ---------------------------------------------------------------------------
// 2. Candidate judge (System One via buildCandidateJudgeRequest)
// ---------------------------------------------------------------------------

export async function runCandidateJudge(
  input: CandidateJudgeInput,
  config: TransportConfig,
  buildRequest: (input: CandidateJudgeInput, model: string) => string,
  fetchLike?: TransportLike,
  now: () => number = () => Date.now(),
  /** Composition options: forwarded to the native core. */
  options?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<TransportOk<Readonly<Record<string, { readonly type: string; readonly noul: number }>>> | TransportError> {
  const body = buildRequest(input, config.model);
  // Exact requested question IDs are validated at the TRANSPORT boundary:
  // missing or extra IDs are protocol failures before success is declared.
  const expectedIds = new Set<string>();
  input.candidates.forEach((_, i) => {
    expectedIds.add(`q${i}s`);
    expectedIds.add(`q${i}c`);
  });
  return nativePost(
    config,
    body,
    "systemone",
    (raw) => {
      const answers = raw.answers;
      if (typeof answers !== "object" || answers === null || Array.isArray(answers)) {
        return { kind: "error", code: "CAND_MALFORMED", message: "Candidate judge response lacked an answers object." };
      }
      for (const id of Object.keys(answers as Record<string, unknown>)) {
        if (!expectedIds.has(id)) {
          return { kind: "error", code: "CAND_PROTOCOL", message: "Candidate judge response contained an unknown question id." };
        }
      }
      for (const id of expectedIds) {
        if (!(id in (answers as Record<string, unknown>))) {
          return { kind: "error", code: "CAND_PROTOCOL", message: "Candidate judge response was missing a requested question id." };
        }
      }
      for (const [id, value] of Object.entries(answers as Record<string, unknown>)) {
        const entry = value as Record<string, unknown> | null;
        if (
          entry === null ||
          typeof entry !== "object" ||
          entry.type !== "noul" ||
          typeof entry.noul !== "number" ||
          !Number.isFinite(entry.noul) ||
          entry.noul < 0 ||
          entry.noul > 1
        ) {
          return { kind: "error", code: "CAND_PROTOCOL", message: `Candidate judge answer ${id} was not a finite noul probability in [0,1].` };
        }
      }
      return { kind: "ok", value: answers as Record<string, { type: string; noul: number }> };
    },
    fetchLike,
    now,
    options,
  );
}
