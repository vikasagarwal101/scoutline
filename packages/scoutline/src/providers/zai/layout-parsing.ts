/**
 * Z.AI layout-parsing REST client (GLM-OCR, ADR-0014 D2 — glm-ocr lane T1).
 *
 * One POST to `<base>/paas/v4/layout_parsing` with the minimal wire
 * surface `{model:"glm-ocr", file}` (no page-range flags, no extra
 * options — the server owns page-count policy). The default base is the
 * PLAIN path `https://api.z.ai/api` (PAYG is account-level); the
 * `/coding/` variant's funded-key behavior is a plan-time check, not a
 * runtime concern here.
 *
 * Boundary rules (ARCHITECTURE.md §2):
 *   - May import normalized errors. Imports no transport beyond the
 *     injected fetch, no capability contract, no command presentation.
 *   - Raw response bodies NEVER enter public errors; messages are
 *     stable sanitized labels.
 *
 * Decode contract (fail closed): `md_results` must be a nonempty
 * string; `id`/`created`/`model` are tolerated and everything else is
 * ignored at the boundary. The two bbox spaces (pixel coordinates
 * embedded in `md_results` annotations vs normalized `layout_details.
 * bbox_2d`) never cross this module — `layout_details` is discarded
 * here, so no internal type ever conflates them.
 *
 * Error mapping: any envelope carrying `error.code === 1113` is the
 * exhaustion seam — {@link isInsufficientBalance} detects it in every
 * wrapper shape the wire can produce and `parseLayout` surfaces it as
 * a terminal `QuotaError` the caller's fallback seam consumes. Every
 * other failure maps through the existing zai error classes
 * (`AuthError` 401/403, `ApiError` with status, `NetworkError`,
 * `TimeoutError`); no bespoke classes.
 *
 * This transport performs ONE logical attempt; shared execution owns
 * retry policy, and the glm-ocr arm runs adapter-internal (no shared
 * retry on the fallback seam — ADR-0014 §1).
 */

import {
  ApiError,
  AuthError,
  NetworkError,
  QuotaError,
  TimeoutError,
} from "../../lib/errors.js";
import { clampTimeoutMs } from "../../lib/timeout.js";
import type { ProviderQuotaFetch } from "../types.js";
import { getGlobalFetch } from "../types.js";

/** Plain (non-coding) base: PAYG billing is account-level (D2). */
const DEFAULT_LAYOUT_PARSING_BASE = "https://api.z.ai/api";
const LAYOUT_PARSING_PATH = "/paas/v4/layout_parsing";

/** Default request timeout, matching the monitor client. */
const DEFAULT_LAYOUT_PARSING_TIMEOUT_MS = 30000;

/** The only model this client ever sends — the engine, not an option. */
const LAYOUT_PARSING_MODEL = "glm-ocr";

/** Injectable transport dependencies (tests pass fakes for both). */
export interface LayoutParsingDeps {
  readonly fetch?: ProviderQuotaFetch;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Whole-request form combining request + injected fetch, for callers
 * that prefer one object (the adapter always passes `deps.fetch`
 * explicitly; tests use either form). Equivalent to spreading `fetch`
 * into `deps`.
 */
export type LayoutParsingCall = LayoutParsingRequest & LayoutParsingDeps;

/** Request shape for one layout-parsing call. */
export interface LayoutParsingRequest {
  readonly apiKey: string;
  /** `file` wire value: canonical URL string or base64 payload. */
  readonly file: string;
  /** Overrides the plain default base (tests pin exact URLs). */
  readonly baseUrl?: string;
}

/** Injectable timer pair so timeout tests never arm real timers. */
export interface LayoutParsingTimers {
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
}

/**
 * Whether a decoded payload carries the Z.AI exhaustion code `1113` in
 * any wrapper shape the wire can produce. The code may be numeric or
 * string, at the top level or under `data` — both were observed in
 * live probes (2026-09-10/20, plan key). Message-only shapes are
 * deliberately NOT matched: the code is authoritative.
 */
export function isInsufficientBalance(payload: unknown): boolean {
  return codeAtPath(payload, 1113) || codeAtPath((payload as { data?: unknown })?.data, 1113);
}

function codeAtPath(value: unknown, want: number): boolean {
  const code = (value as { error?: { code?: unknown } } | null | undefined)?.error?.code;
  return code === want || code === String(want);
}

/**
 * POST one layout-parsing request and return the normalized text
 * (`md_results`). One logical attempt: no internal retry, no cache —
 * the adapter caller owns both (ADR-0014 D4).
 */
export async function parseLayout(
  request: LayoutParsingRequest,
  timers: LayoutParsingTimers,
  deps: LayoutParsingDeps = {},
): Promise<string> {
  const effectiveDeps: LayoutParsingDeps = {
    ...deps,
    ...(typeof (request as LayoutParsingCall).fetch === "function"
      ? { fetch: (request as LayoutParsingCall).fetch }
      : {}),
  };
  const f = effectiveDeps.fetch ?? getGlobalFetch<ProviderQuotaFetch>();
  const env = effectiveDeps.env ?? process.env;
  const base = request.baseUrl ?? DEFAULT_LAYOUT_PARSING_BASE;
  const url = `${base}${LAYOUT_PARSING_PATH}`;

  // Same timeout resolution as the rest of the Z.AI transports.
  const timeoutMs = resolveLayoutTimeoutMs(env);
  const controller = new AbortController();
  const timerId = timers.setTimeout(() => controller.abort(), timeoutMs);

  // G1 (PR #265): the timeout covers fetch AND body decode — the timer
  // clears exactly once in a finally on every path, so a stalled body or
  // JSON decoder aborts within the documented bound (abort during decode
  // maps to TimeoutError; malformed JSON stays ApiError).
  let payload: unknown;
  let responseStatus: number;
  try {
    const response = await f(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${request.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: LAYOUT_PARSING_MODEL, file: request.file }),
      signal: controller.signal,
    });
    responseStatus = response.status;
    try {
      payload = await response.json();
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      // Fail closed: a non-JSON body is a malformed result.
      throw new ApiError("Z.AI layout-parsing returned a malformed result", 500);
    }
  } catch (error) {
    throw normalizeTransportError(error, timeoutMs);
  } finally {
    timers.clearTimeout(timerId);
  }

  if (isInsufficientBalance(payload)) {
    throw new QuotaError(
      "Z.AI layout-parsing quota has been exhausted",
      "glm-ocr is PAYG-only; recharge your balance or rely on the fallback",
    );
  }

  if (responseStatus >= 400) {
    if (responseStatus === 401 || responseStatus === 403) {
      throw new AuthError("Z.AI layout-parsing authentication failed");
    }
    throw new ApiError("Z.AI layout-parsing request failed", responseStatus);
  }

  const mdResults = (payload as { md_results?: unknown }).md_results;
  if (typeof mdResults !== "string" || mdResults.trim().length === 0) {
    // `md_results` string required — fail closed otherwise (D2).
    throw new ApiError("Z.AI layout-parsing returned an empty or malformed result", 500);
  }
  return mdResults;
}

function resolveLayoutTimeoutMs(env: NodeJS.ProcessEnv): number {
  // Same resolution as the monitor client: Z_AI_TIMEOUT ms through the
  // shared clamp (invalid/negative values fall to the 30s default).
  return clampTimeoutMs(
    parseInt(env.Z_AI_TIMEOUT || String(DEFAULT_LAYOUT_PARSING_TIMEOUT_MS), 10),
    DEFAULT_LAYOUT_PARSING_TIMEOUT_MS,
  );
}

function normalizeTransportError(err: unknown, timeoutMs: number): Error {
  if (err instanceof AuthError || err instanceof ApiError || err instanceof QuotaError) return err;
  if (err instanceof Error && err.name === "AbortError") {
    return new TimeoutError(timeoutMs);
  }
  return new NetworkError("Z.AI layout-parsing network error");
}
