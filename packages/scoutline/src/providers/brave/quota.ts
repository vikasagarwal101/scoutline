/**
 * Brave Quota Capability (brave-tech-plan §3.5, §7, §10 #5; T6).
 *
 * Brave has NO `/usage` endpoint, so quota is read from the four
 * `X-RateLimit-*` response headers on a 1-query `/web/search` probe.
 * The normalizer is pure; the capability factory owns configuration
 * resolution, the single direct transport attempt, and failure
 * normalization. Shared execution owns retry policy.
 *
 * Brave rate-limit mapping (brave-tech-plan §10):
 *   - `X-RateLimit-Policy` declares the windows as `"<limit>;w=<sec>"`
 *     entries separated by `,` (e.g. `"1;w=1, 15000;w=2592000"`).
 *   - `X-RateLimit-Limit` / `-Remaining` / `-Reset` are comma-separated
 *     arrays ALIGNED with Policy by index.
 *
 * The LARGEST window (≈ monthly) is surfaced as a single "monthly"
 * category; the per-second window is DROPPED — a rate cap does not fit
 * the used/limit shape and there is no numeric metadata slot in
 * {@link ProviderQuotaSuccess} (critique H3). Because the number is a
 * rate-limit window, NOT spend or credits consumed under Brave's
 * metered billing, a prominent caveat is attached via the generic
 * `warnings` channel so the quota command can render it to stderr
 * without learning Brave's billing model.
 *
 * Boundary rules (ARCHITECTURE.md §2):
 *   - May import the quota capability contract, Adapter-local config,
 *     Adapter-local quota client, and normalized errors.
 *   - Must NOT import command presentation or another Provider's
 *     Adapter.
 */

import type {
  ProviderQuotaSuccess,
  QuotaCapability,
  QuotaCategory,
} from "../../capabilities/quota.js";
import { buildQuotaWindow } from "../../capabilities/quota.js";
import {
  ApiError,
  AuthError,
  ConfigurationError,
  NetworkError,
  ScoutlineError,
  TimeoutError,
} from "../../lib/errors.js";
import { requireBraveApiKey } from "./credentials.js";
import { fetchBraveRateLimit, type BraveTransportDeps } from "./client.js";

/**
 * Caveat attached to every Brave quota result: the number is a
 * rate-limit window (requests remaining this period), NOT spend or
 * credits consumed. Brave uses metered billing, so this is not a budget
 * signal. Surfaced to stderr by the provider-neutral quota command.
 */
export const BRAVE_QUOTA_CAVEAT =
  "Brave quota reflects a rate-limit window (requests remaining this period), not spend or credits consumed. Brave uses metered billing — this is not a budget signal.";

/**
 * Error thrown when the rate-limit headers cannot be parsed into a
 * usable window. Brave's header format is the only quota signal, so a
 * malformed/missing/unaligned set is unrecoverable: never guess, never
 * crash — surface `QUOTA_ERROR` instead.
 */
function braveQuotaParseError(): ScoutlineError {
  return new ScoutlineError("Brave quota headers could not be parsed", "QUOTA_ERROR", {
    exitCode: 1,
  });
}

// ---------------------------------------------------------------------------
// Header parsing helpers
// ---------------------------------------------------------------------------

interface ParsedWindow {
  readonly limit: number;
  readonly windowSeconds: number;
}

/**
 * Split a comma-separated header value into trimmed entries. Returns
 * `null` when the value is absent or blank (no windows to parse).
 */
function readHeaderCsv(raw: string | null): string[] | null {
  if (raw === null || raw.trim() === "") return null;
  return raw.split(",").map((s) => s.trim());
}

/**
 * Parse a header slot as a finite nonnegative number. Returns `NaN`
 * (falsy for `Number.isFinite`) when the value is absent or non-numeric
 * so callers can treat it uniformly as "indeterminate".
 */
function parseFiniteNumber(value: string | undefined): number {
  if (value === undefined) return NaN;
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}

// ---------------------------------------------------------------------------
// Normalizer
// ---------------------------------------------------------------------------

const ONE_DAY_SECONDS = 86400;

/**
 * Derive a category name from the selected window's duration so the
 * label cannot drift from the window it represents (the largest window
 * is usually ~30 days, but Brave's tiers are not guaranteed monthly).
 * Falls back to a neutral `rate_limit` for unrecognized window sizes.
 */
function rateLimitWindowName(windowSeconds: number): string {
  if (windowSeconds >= 28 * ONE_DAY_SECONDS) return "monthly";
  if (windowSeconds >= 6 * ONE_DAY_SECONDS) return "weekly";
  if (windowSeconds >= ONE_DAY_SECONDS) return "daily";
  return "rate_limit";
}

/**
 * Normalize Brave `X-RateLimit-*` headers into the shared Interface.
 *
 * Selects the LARGEST `windowSeconds` window declared by `Policy` (≈
 * monthly) and surfaces it as a single category named for that window
 * (monthly/weekly/daily, else `rate_limit`); the per-second window is
 * dropped. For the selected window: `used = limit −
 * remaining` (clamped to `[0, limit]` when remaining is out of range),
 * `resetsAt = now + reset*1000ms`, `durationSeconds = windowSeconds`.
 *
 * Throws `QUOTA_ERROR` when the headers are missing/malformed, when no
 * window parses, or when the selected window's limit/remaining/reset
 * values are indeterminate (e.g. the arrays do not align by index).
 * Never guesses; never crashes.
 */
export function normalizeBraveQuota(
  headers: {
    readonly limit: string | null;
    readonly policy: string | null;
    readonly remaining: string | null;
    readonly reset: string | null;
  },
  /**
   * Injectable clock for the `resetsAt` derivation (`now + reset·s`).
   * Defaults to `Date.now`; tests pass a fixed value to assert the exact
   * ISO timestamp rather than a non-deterministic "now"-relative value.
   */
  now: () => number = Date.now,
): ProviderQuotaSuccess {
  // Parse Policy into windows: "1;w=1, 15000;w=2592000" → [{1,1},{15000,2592000}]
  const policyParts = readHeaderCsv(headers.policy);
  if (policyParts === null) {
    throw braveQuotaParseError();
  }
  const windows: ParsedWindow[] = [];
  for (const part of policyParts) {
    if (part === "") {
      throw braveQuotaParseError();
    }
    // Each entry is "<limit>;w=<seconds>".
    const segs = part.split(";").map((s) => s.trim());
    if (segs.length !== 2 || segs[0] === "" || segs[1] === "") {
      throw braveQuotaParseError();
    }
    const limit = parseFiniteNumber(segs[0]);
    const wMatch = /^w=(\d+)$/.exec(segs[1]);
    const windowSeconds = wMatch ? parseFiniteNumber(wMatch[1]) : NaN;
    if (
      !Number.isFinite(limit) ||
      limit < 0 ||
      !Number.isFinite(windowSeconds) ||
      windowSeconds <= 0
    ) {
      throw braveQuotaParseError();
    }
    windows.push({ limit, windowSeconds });
  }
  if (windows.length === 0) {
    throw braveQuotaParseError();
  }

  // Align Limit/Remaining/Reset arrays by index with Policy windows.
  const limitParts = readHeaderCsv(headers.limit);
  const remainingParts = readHeaderCsv(headers.remaining);
  const resetParts = readHeaderCsv(headers.reset);

  // Select the LARGEST window with a NON-ZERO limit. A limit of 0 means
  // "no fixed cap on that period" (e.g. a metered plan's monthly window
  // reports limit=0/remaining=0), which yields no usable used/remaining
  // and would otherwise throw — skip such windows and fall back to the
  // next-largest window that carries a real cap (do NOT hardcode 2592000).
  let selectedIndex = -1;
  for (let i = 0; i < windows.length; i++) {
    if (windows[i].limit <= 0) continue;
    if (selectedIndex === -1 || windows[i].windowSeconds > windows[selectedIndex].windowSeconds) {
      selectedIndex = i;
    }
  }
  if (selectedIndex === -1) {
    throw braveQuotaParseError();
  }

  const selectedLimit = parseFiniteNumber(limitParts?.[selectedIndex]);
  const selectedRemaining = parseFiniteNumber(remainingParts?.[selectedIndex]);
  const selectedReset = parseFiniteNumber(resetParts?.[selectedIndex]);

  // The selected window's counts must all be finite nonnegative numbers;
  // an unaligned/indeterminate set is unrecoverable.
  if (
    !Number.isFinite(selectedLimit) ||
    selectedLimit < 0 ||
    !Number.isFinite(selectedRemaining) ||
    selectedRemaining < 0 ||
    !Number.isFinite(selectedReset) ||
    selectedReset < 0
  ) {
    throw braveQuotaParseError();
  }

  // used = limit − remaining; clamp to [0, limit] when remaining is out
  // of range so the derived percentage stays meaningful.
  let used = selectedLimit - selectedRemaining;
  if (used < 0) used = 0;
  if (used > selectedLimit) used = selectedLimit;

  const resetsAtEpochMs = now() + selectedReset * 1000;
  const current = buildQuotaWindow({
    used,
    limit: selectedLimit,
    resetsAtEpochMs,
    durationSeconds: windows[selectedIndex].windowSeconds,
  });

  const category: QuotaCategory = {
    name: rateLimitWindowName(windows[selectedIndex].windowSeconds),
    unit: "requests",
    current,
  };

  return {
    provider: "brave",
    status: "ok",
    categories: [category],
    warnings: [BRAVE_QUOTA_CAVEAT],
  };
}

// ---------------------------------------------------------------------------
// Capability factory
// ---------------------------------------------------------------------------

/**
 * Map a thrown error into a normalized Brave quota failure. Typed
 * transport errors (Auth/Api/Network/Timeout/Configuration) pass
 * through verbatim, as does any {@link ScoutlineError} — notably the
 * `QUOTA_ERROR` thrown by {@link normalizeBraveQuota} on malformed
 * headers. Unknown errors become a generic `ApiError 500`. The Brave
 * transport already drains/discards response bodies, so no raw Brave
 * body ever crosses this boundary.
 */
function normalizeBraveQuotaError(error: unknown): Error {
  if (
    error instanceof ScoutlineError ||
    error instanceof AuthError ||
    error instanceof ApiError ||
    error instanceof NetworkError ||
    error instanceof TimeoutError ||
    error instanceof ConfigurationError
  ) {
    return error;
  }
  return new ApiError("Brave quota request failed", 500);
}

/**
 * Options for the Brave QuotaCapability. The API key is resolved from
 * `env`; transport dependencies (`fetch`, timer) are injectable for
 * deterministic tests through the unified `transport` seam.
 */
export interface BraveQuotaCapabilityOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly transport?: BraveTransportDeps;
  /** Optional injectable clock for deterministic `resetsAt` in tests. */
  readonly now?: () => number;
}

/**
 * Build the Brave QuotaCapability. `invoke` resolves the API key,
 * performs one direct `/web/search` probe (costs exactly ONE request),
 * reads the `X-RateLimit-*` headers, and normalizes the largest window
 * into the shared Interface. Shared execution wraps this in the retry
 * policy; quota never uses the response cache.
 */
export function createBraveQuotaCapability(options: BraveQuotaCapabilityOptions): QuotaCapability {
  const { env, transport, now } = options;
  return {
    async invoke(): Promise<ProviderQuotaSuccess> {
      const apiKey = requireBraveApiKey(env);
      try {
        const headers = await fetchBraveRateLimit(apiKey, transport);
        return normalizeBraveQuota(headers, now);
      } catch (error) {
        throw normalizeBraveQuotaError(error);
      }
    },
  };
}
