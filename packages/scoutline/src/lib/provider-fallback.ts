/**
 * Provider Fallback Executor (Provider Fallback Tech Plan §"Core mechanism").
 *
 * Provider-neutral candidate loop. Imports only the descriptor + error
 * types and the `ProviderContext` injection shape; it never imports a
 * concrete Adapter, transport, UTCP client, or command module. Every
 * shared-capability handler passes a per-provider `attempt` callback
 * (which builds its own Adapter and invokes the appropriate
 * `executeX` primitive) and receives a single {@link FallbackOutcome}.
 *
 * Boundary rules (Provider Fallback Tech Plan §"Core mechanism"):
 *   - May import Provider descriptor + error types and the
 *     `ProviderContext` injection shape.
 *   - Must NOT import a concrete Adapter, a transport, a UTCP client,
 *     a command module, a Capability, or `executeX`/shared-execution
 *     primitives.
 *   - The dispatch layer owns the call site; the handlers own request
 *     shape and which `executeX` is invoked. This module owns
 *     candidate ordering, preflight, error classification, exhaustion,
 *     and notices.
 *
 * Algorithm (Tech Plan §"Algorithm"):
 *   1. Build a candidate plan (an ordered list, not a silent filter):
 *      `[effective, ...descriptors]`, deduplicated by id, with each
 *      entry tagged `eligible | incapable | unconfigured` from an
 *      ordered preflight (capability metadata → `isConfigured` →
 *      adapter-handle agreement). Ineligible entries are RETAINED
 *      with their reason so skip-notices fire and the effective
 *      provider's real error is preserved on exhaustion.
 *   2. Walk the plan. Emit skip-notices for ineligible entries
 *      (`⚠ <p> does not support '<cap>' — skipping`,
 *       `⚠ <p> is not configured — skipping`).
 *   3. For each eligible candidate, run the adapter-handle agreement
 *      step and `await attempt(d)`. On success, return
 *      `{ result, provider: d.id, fellBack: d.id !== effective }`. On
 *      throw, classify (Tech Plan §"Error classification"): re-throw
 *      `ValidationError` (no loop) and unknown errors (fail closed);
 *      continue on `UnsupportedCapabilityError`, `UnsupportedOptionError`,
 *      and the runtime-error family. Emit a switch notice when
 *      continuing to the next candidate.
 *   4. Exhaustion. If no eligible candidate succeeds, re-throw the
 *      **effective** provider's own error when it ran; otherwise the
 *      last eligible candidate's runtime error when the effective was
 *      skipped; otherwise the typed preflight error
 *      (`ConfigurationError` for `unconfigured`, `UnsupportedCapabilityError`
 *      for `incapable`). Never synthesize a substitute error type.
 *      Preserving the effective's own error when it ran keeps the
 *      0.10.x exit codes (critique #7).
 *
 * Kill-switch (Tech Plan §"Kill-switch plumbing"). When
 * `fallbackEnabled === false`, the plan is `[effective]` only, and
 * the SAME preflight runs on it. The kill-switch narrows the plan;
 * it does NOT bypass the preflight. So an incapable effective throws
 * `UnsupportedCapabilityError` and an unconfigured effective throws
 * `ConfigurationError` — the exact 0.10.x codes and ordering, with
 * zero adapter work for the unsupported case (FR-023/024). No notices
 * are emitted under the kill-switch.
 *
 * Notices (Tech Plan §"Failure, notice & cache semantics"). Every
 * notice is written via the injected `writeStderr` only; the executor
 * never writes to stdout. The summary line `✓ <cmd> completed via <p>
 * (fallback)` is emitted only when `fellBack === true` (i.e. the
 * winning provider is not the effective). Under the kill-switch,
 * `fellBack` can never be true, so no summary is emitted.
 */

import type {
  ProviderAdapter,
  ProviderCapability,
  ProviderDescriptor,
  ProviderId,
} from "../providers/types.js";
import { PROVIDER_FALLBACK_CREDENTIAL_MESSAGE } from "../providers/types.js";
import {
  ApiError,
  AuthError,
  ConfigurationError,
  NetworkError,
  QuotaError,
  ScoutlineError,
  TimeoutError,
  UnsupportedCapabilityError,
  UnsupportedOptionError,
  ValidationError,
} from "./errors.js";

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * Options for {@link executeWithFallback}. The executor owns no
 * environment, registry, or stderr writer of its own — every dependency
 * is injected so a unit test can drive the loop with doubles and
 * capture every emitted notice.
 *
 * - `capabilityId` — the Capability the handler is exercising. Used for
 *   descriptor preflight, notice wording, and the typed
 *   `UnsupportedCapabilityError` thrown on exhaustion.
 * - `commandLabel` — short human label used in switch / summary notices
 *   (e.g. `"search"`, `"read"`, `"crawl"`). Distinct from
 *   `capabilityId` so a single Capability can be reached under
 *   different user-facing command names without rewriting notice text.
 * - `effectiveProvider` — the Provider the handler resolved from
 *   explicit flag, env, or default. It is the first plan entry AND
 *   the Provider whose error is preserved on exhaustion.
 * - `descriptors` — the Provider registry, in registry order
 *   `[zai, minimax, tavily, exa, brave, firecrawl]`. The executor
 *   dedupes the plan by id; the first occurrence of an id wins.
 * - `env` — the environment used for `descriptor.isConfigured` and the
 *   `ProviderContext` passed to `descriptor.create`. Injected so the
 *   executor never reads `process.env` directly.
 * - `fallbackEnabled` — kill-switch. `false` narrows the plan to
 *   `[effective]` only and suppresses all notices.
 * - `writeStderr` — single-writer injection. All notices go through
 *   this function; the executor never calls `process.stderr.write`
 *   directly. This is the same `writeStderr` surface the handlers
 *   receive through `deps.invocation.writeStderr`.
 */
export interface FallbackExecutionOptions {
  readonly capabilityId: string;
  readonly commandLabel: string;
  readonly effectiveProvider: ProviderId;
  readonly descriptors: readonly ProviderDescriptor[];
  readonly env: NodeJS.ProcessEnv;
  readonly fallbackEnabled: boolean;
  readonly writeStderr: (s: string) => void;
}

/**
 * Result of {@link executeWithFallback}. The handler uses
 * `result` for its presentation output, `provider` to report the
 * winning Provider (later tickets will thread it into the data
 * envelope), and `fellBack` to gate the summary notice and (later)
 * downstream behaviour that depends on whether the original
 * preference held.
 */
export interface FallbackOutcome<T> {
  readonly result: T;
  readonly provider: ProviderId;
  readonly fellBack: boolean;
}

// ---------------------------------------------------------------------------
// Plan + preflight (internal)
// ---------------------------------------------------------------------------

/**
 * Typed preflight outcome for a single candidate.
 *
 * - `eligible` — passed capability, configuration, and adapter-handle
 *   agreement; the candidate is ready for `attempt`.
 * - `incapable` — capability metadata or adapter-handle agreement
 *   failed. The candidate cannot run the Capability at all.
 * - `unconfigured` — `isConfigured` returned `false`. The candidate
 *   advertises support but is missing its required credential.
 *
 * The two ineligible kinds are distinct so exhaustion surfaces the
 * correct typed error (`UnsupportedCapabilityError` vs
 * `ConfigurationError`) — the 0.10.x exit codes depend on this
 * distinction (critique #7 fix).
 */
type PreflightStatus =
  | { readonly kind: "eligible" }
  | { readonly kind: "incapable" }
  | { readonly kind: "unconfigured" };

/**
 * Plan entry. The descriptor is retained even for ineligible entries
 * so skip-notices can name the Provider and exhaustion can re-throw
 * the effective's typed error.
 */
interface CandidatePlanEntry {
  readonly descriptor: ProviderDescriptor;
  readonly status: PreflightStatus;
}

/**
 * Map a {@link ProviderCapability} id to the Adapter slot the
 * `ProviderAdapter` interface exposes for it. Vision sub-operations
 * (`vision.interpret-image`, `vision.ui-artifact`, ...) all share
 * the same `adapter.vision` slot, distinguished at the Capability
 * layer by `visionCapability.supports(operation)`. Returns
 * `undefined` for unknown capability ids so the preflight can
 * classify them as `incapable`.
 */
function adapterSlotFor(capabilityId: string): keyof ProviderAdapter | undefined {
  switch (capabilityId) {
    case "search":
      return "search";
    case "reader":
      return "reader";
    case "crawl":
      return "crawl";
    case "map":
      return "map";
    case "research":
      return "research";
    case "quota":
      return "quota";
    case "diagnostics":
      return "diagnostics";
    case "repository-exploration":
      return "repository";
    default:
      // Every Vision sub-operation is served by the same
      // `adapter.vision` slot, so any `vision.*` capability id maps
      // to that slot. The Capability layer handles operation-level
      // support via `visionCapability.supports`.
      if (capabilityId.startsWith("vision.")) {
        return "vision";
      }
      return undefined;
  }
}

/**
 * Run the ordered preflight (capability → configuration → adapter
 * handle) for a single descriptor. The adapter-handle step calls
 * `descriptor.create()`; the resulting adapter is dropped after the
 * slot check so the attempt callback re-creates a fresh one (this is
 * cheap because `create()` is documented as side-effect-free in
 * `ProviderDescriptor`). If `create()` itself throws, the candidate
 * is treated as `unconfigured` so the existing live
 * `ConfigurationError` exit code (3) is preserved — a descriptor that
 * cannot even construct an Adapter behaves indistinguishably from
 * one that is missing a credential.
 *
 * The capability-before-configuration ordering is a hard invariant
 * (FR-023/024): an unsupported Capability must surface as
 * `UnsupportedCapabilityError` (exit 1) BEFORE the configured check
 * runs, so an unsupported Provider with no credential surfaces
 * `UNSUPPORTED_CAPABILITY`, not `CONFIGURATION_ERROR`. The two
 * branches in this function preserve that ordering.
 */
function preflightDescriptor(
  descriptor: ProviderDescriptor,
  capabilityId: string,
  env: NodeJS.ProcessEnv,
): PreflightStatus {
  // Step 1 — capability metadata (FR-023).
  if (!descriptor.capabilities().has(capabilityId as ProviderCapability)) {
    return { kind: "incapable" };
  }
  // Step 2 — configuration (FR-024). Runs only if the capability is
  // supported; an unsupported Provider is incapable, never
  // unconfigured.
  if (!descriptor.isConfigured(env)) {
    return { kind: "unconfigured" };
  }
  // Step 3 — adapter-handle agreement. Construct the Adapter and
  // verify the Capability slot is non-null. `create()` is documented
  // as side-effect-free; if it throws (a programmer/constructor bug),
  // the exception propagates rather than being silently masked as
  // "unconfigured" — fail-closed on unknown errors (review fix).
  const slot = adapterSlotFor(capabilityId);
  if (slot === undefined) {
    return { kind: "incapable" };
  }
  const adapter = descriptor.create({ env });
  // `ProviderAdapter` is an interface with named properties only;
  // cast through `unknown` to access the slot by computed key.
  if ((adapter as unknown as Record<string, unknown>)[slot] === undefined) {
    return { kind: "incapable" };
  }
  return { kind: "eligible" };
}

/**
 * Build the candidate plan. The plan is a deduplicated ordered list
 * `[effective, ...descriptors]` (registry order) when
 * `fallbackEnabled === true`; a single-element list `[effective]`
 * when `fallbackEnabled === false`. Deduplication keeps the FIRST
 * occurrence of an id, so the effective always wins the first slot
 * even when it also appears in the registry.
 */
function buildCandidatePlan(
  effective: ProviderDescriptor,
  descriptors: readonly ProviderDescriptor[],
  capabilityId: string,
  env: NodeJS.ProcessEnv,
  fallbackEnabled: boolean,
): CandidatePlanEntry[] {
  if (!fallbackEnabled) {
    // Kill-switch: plan is `[effective]` only. The same preflight
    // runs on it, so an incapable / unconfigured effective still
    // surfaces its real typed error and ordering invariant. No
    // notices are emitted (see {@link executeWithFallback}).
    return [
      {
        descriptor: effective,
        status: preflightDescriptor(effective, capabilityId, env),
      },
    ];
  }
  const seen = new Set<ProviderId>();
  const plan: CandidatePlanEntry[] = [];
  for (const descriptor of [effective, ...descriptors]) {
    if (seen.has(descriptor.id)) continue;
    seen.add(descriptor.id);
    plan.push({
      descriptor,
      status: preflightDescriptor(descriptor, capabilityId, env),
    });
  }
  return plan;
}

// ---------------------------------------------------------------------------
// Error classification (Tech Plan §"Error classification")
// ---------------------------------------------------------------------------

/**
 * Classify a thrown error against the Tech Plan decision table.
 *
 * - `ValidationError` — `validation`. The loop must re-throw
 *   immediately; user input is bad for every Provider, so iterating
 *   is wasted work + extra noise.
 * - `UnsupportedCapabilityError`, `UnsupportedOptionError` — `continue`.
 *   The Provider does not support this Capability or option, so the
 *   next candidate is meaningful.
 * - `ApiError`, `NetworkError`, `TimeoutError`, `AuthError`,
 *   `ConfigurationError`, `QuotaError` — `continue`. Runtime failures
 *   fall through to the next candidate under the Tech Plan's
 *   accepted-risk path (and per critique #1's revised rule, async
 *   cost-bearing ops MAY double-charge on a runtime failure; the
 *   kill-switch is the documented safety valve).
 * - Anything else (non-`ScoutlineError` or unrecognised
 *   `ScoutlineError` subclass) — `throw`. Fail closed on unknown
 *   errors so a programmer mistake cannot be silently masked by a
 *   cross-Provider fallback.
 */
function classifyError(err: unknown): "validation" | "continue" | "throw" {
  if (err instanceof ValidationError) return "validation";
  if (err instanceof UnsupportedCapabilityError) return "continue";
  if (err instanceof UnsupportedOptionError) return "continue";
  if (
    err instanceof ApiError ||
    err instanceof NetworkError ||
    err instanceof TimeoutError ||
    err instanceof AuthError ||
    err instanceof ConfigurationError ||
    err instanceof QuotaError
  ) {
    return "continue";
  }
  // Some normalized errors are base ScoutlineError instances carrying a
  // code field rather than a concrete subclass (e.g. Z.AI Reader 403 is
  // a base ScoutlineError with code AUTH_ERROR, not a concrete AuthError).
  // Match by code on ScoutlineError instances so they still continue to
  // the next provider, while plain Errors (test doubles, programmer
  // mistakes) stay fail-closed.
  if (err instanceof ScoutlineError) {
    const continueCodes = new Set([
      "AUTH_ERROR",
      "API_ERROR",
      "NETWORK_ERROR",
      "TIMEOUT_ERROR",
      "QUOTA_ERROR",
      "CONFIGURATION_ERROR",
    ]);
    if (continueCodes.has(err.code)) return "continue";
  }
  return "throw";
}

// ---------------------------------------------------------------------------
// Credential message (Provider Fallback execution-log flag, ticket 02)
// ---------------------------------------------------------------------------

/**
 * Build the Provider-specific "missing credential" message for an
 * unconfigured descriptor. Surfaces the env-var name(s) the Provider
 * reads so the user sees the same targeted guidance today's handlers
 * emitted (e.g. "Set Z_AI_API_KEY." instead of the generic "Set the
 * required API key.").
 *
 * Reads the OPTIONAL `credentialEnvVars` field added to
 * `ProviderDescriptor` by Ticket 02. When the field is absent (older
 * test doubles) or empty, falls back to the provider-neutral
 * {@link PROVIDER_FALLBACK_CREDENTIAL_MESSAGE} so the executor never
 * crashes on a Provider that has not been updated yet. This keeps the
 * change strictly backward-compatible per AGENTS.md.
 *
 * Single-var: "Set Z_AI_API_KEY."
 * Multi-var: "Set Z_AI_API_KEY or ZAI_API_KEY."
 */
function credentialMessageFor(descriptor: ProviderDescriptor): string {
  const vars = descriptor.credentialEnvVars;
  if (!vars || vars.length === 0) {
    return PROVIDER_FALLBACK_CREDENTIAL_MESSAGE;
  }
  if (vars.length === 1) {
    return `Set ${vars[0]}.`;
  }
  const head = vars.slice(0, -1).join(", ");
  const tail = vars[vars.length - 1];
  return `Set ${head} or ${tail}.`;
}

// ---------------------------------------------------------------------------
// Notice wording
// ---------------------------------------------------------------------------

/**
 * Build the per-skip notice for an ineligible plan entry.
 * `incapable` and `unconfigured` have distinct wording so the user
 * can tell why a Provider was skipped.
 */
function skipNotice(capabilityId: string, entry: CandidatePlanEntry): string {
  if (entry.status.kind === "unconfigured") {
    return `⚠ ${entry.descriptor.id} is not configured — skipping`;
  }
  return `⚠ ${entry.descriptor.id} does not support '${capabilityId}' — skipping`;
}

/**
 * Build the per-switch notice when the executor moves from one
 * candidate to the next. The wording follows the Tech Plan
 * §"Error classification" table exactly:
 *
 *   - `UnsupportedCapabilityError` → "does not support '<cap>'"
 *   - `UnsupportedOptionError` → "does not support '<option>'" (uses
 *     the new structured `option` field)
 *   - Other runtime errors → "failed (<code>) for <cmd>"
 */
function switchNotice(
  entry: CandidatePlanEntry,
  err: unknown,
  capabilityId: string,
  commandLabel: string,
  nextId: ProviderId,
): string {
  if (err instanceof UnsupportedCapabilityError) {
    return `⚠ ${entry.descriptor.id} does not support '${capabilityId}' — trying ${nextId}`;
  }
  if (err instanceof UnsupportedOptionError) {
    return `⚠ ${entry.descriptor.id} does not support '${err.option}' — trying ${nextId}`;
  }
  // The classification table guarantees `err` is one of the typed
  // runtime-error family here. `code` is read defensively so a
  // custom subclass without a stable `code` still produces a
  // readable notice.
  const code =
    typeof err === "object" && err !== null && "code" in err
      ? String((err as { code: unknown }).code)
      : "ERROR";
  return `⚠ ${entry.descriptor.id} failed (${code}) for ${commandLabel} — trying ${nextId}`;
}

// ---------------------------------------------------------------------------
// Public executor
// ---------------------------------------------------------------------------

/**
 * Run a per-Provider attempt through the candidate loop.
 *
 * The executor walks the prebuilt plan, emitting skip-notices for
 * ineligible entries and switch-notices between failed candidates.
 * On success it returns the outcome and (if `fellBack === true`)
 * writes the summary notice `✓ <cmd> completed via <p> (fallback)`.
 * On exhaustion it re-throws the EFFECTIVE provider's own error when
 * that provider ran; when the effective was ineligible and eligible
 * candidates failed, it re-throws the last eligible failure so the
 * envelope stays actionable; otherwise the typed preflight error
 * (`ConfigurationError` / `UnsupportedCapabilityError`). The executor
 * never synthesizes a substitute error type, so the 0.10.x exit codes
 * are preserved when the effective ran (critique #7 fix).
 *
 * The kill-switch narrows the plan to `[effective]` and suppresses
 * all notices. The same preflight still runs on the effective
 * provider, so an incapable / unconfigured effective surfaces its
 * exact preflight error (FR-023/024 preserved).
 *
 * Throws:
 *   - `Error` only if the effective Provider is not present in
 *     `descriptors`. This is a programmer error (the handler should
 *     have validated the Provider id before calling); surfacing it
 *     as a regular `Error` keeps the dispatch try/catch honest.
 *   - `ValidationError` re-thrown without looping (no Provider will
 *     succeed on bad input).
 *   - Any other `ScoutlineError` (or its `UnsupportedCapabilityError` /
 *     `UnsupportedOptionError` subclasses) re-thrown from the
 *     effective candidate on exhaustion.
 *   - Non-`ScoutlineError` values re-thrown unchanged when they leak
 *     from an attempt; the classifier treats them as "unknown" and
 *     re-throws to fail closed.
 */
export async function executeWithFallback<T>(
  opts: FallbackExecutionOptions,
  attempt: (descriptor: ProviderDescriptor) => Promise<T>,
): Promise<FallbackOutcome<T>> {
  // The handler is expected to validate the Provider id before
  // calling the executor; if it does not, surface a plain Error
  // rather than a typed `ScoutlineError` so the programmer mistake
  // is obvious in the dispatch catch.
  const effective = opts.descriptors.find((d) => d.id === opts.effectiveProvider);
  if (!effective) {
    throw new Error(
      `executeWithFallback: effective provider "${opts.effectiveProvider}" is not present in the descriptor list`,
    );
  }

  const plan = buildCandidatePlan(
    effective,
    opts.descriptors,
    opts.capabilityId,
    opts.env,
    opts.fallbackEnabled,
  );

  // Track the effective's outcome so exhaustion surfaces its real
  // error when the effective actually ran (critique #7). Also track
  // the last eligible attempt's error so that when the effective was
  // skipped (incapable / unconfigured) but later candidates ran and
  // failed, exhaustion reports an actionable failure instead of the
  // effective's preflight typed error.
  let effectiveError: unknown = undefined;
  let effectiveRan = false;
  let lastAttemptedId: ProviderId | null = null;
  let lastEligibleError: unknown = undefined;

  for (let i = 0; i < plan.length; i += 1) {
    const entry = plan[i];
    if (!entry) continue;

    // Skip-notices. Emitted only when fallback is enabled; the
    // kill-switch plan has a single entry and the user explicitly
    // opted out of fallback, so no notice is desired. Under the
    // kill-switch an ineligible effective must NEVER have its
    // adapter invoked; the loop must surface the typed
    // preflight error directly, restoring the 0.10.x
    // "zero-adapter-work for the unsupported case" guarantee.
    if (entry.status.kind === "incapable" || entry.status.kind === "unconfigured") {
      if (opts.fallbackEnabled) {
        opts.writeStderr(skipNotice(opts.capabilityId, entry));
        continue;
      }
      // Kill-switch on an ineligible effective: surface the
      // typed preflight error without ever calling `attempt`.
      // (The exhaustion branch below handles this case too, but
      // short-circuiting here keeps the loop shape identical to
      // the success / failure paths.)
      throw entry.status.kind === "unconfigured"
        ? new ConfigurationError(
            `Provider "${opts.effectiveProvider}" is not configured. ${credentialMessageFor(entry.descriptor)}`,
          )
        : new UnsupportedCapabilityError(opts.effectiveProvider, opts.capabilityId);
    }

    // Eligible. Run the attempt.
    try {
      lastAttemptedId = entry.descriptor.id;
      const result = await attempt(entry.descriptor);
      const fellBack = entry.descriptor.id !== opts.effectiveProvider;
      // The summary notice is the only line emitted on the
      // success path. It is gated on `fellBack` per the Tech
      // Plan: under the kill-switch `fellBack` can never be true
      // (the plan is `[effective]` only), so the explicit
      // `fallbackEnabled` check is redundant but documents the
      // intent and protects future changes that might widen the
      // kill-switch plan.
      if (fellBack && opts.fallbackEnabled) {
        opts.writeStderr(`✓ ${opts.commandLabel} completed via ${entry.descriptor.id} (fallback)`);
      }
      return { result, provider: entry.descriptor.id, fellBack };
    } catch (err) {
      // `ValidationError` short-circuits the loop (Tech Plan
      // §"Error classification"). Bad user input fails
      // identically on every Provider; looping is waste + noise.
      if (err instanceof ValidationError) {
        throw err;
      }
      // Unknown errors fail closed. The classification table
      // treats anything outside the typed-error family as
      // "re-throw unchanged" so a programmer mistake is not
      // masked by a cross-Provider fallback.
      const cls = classifyError(err);
      if (cls === "throw") {
        throw err;
      }
      // Continue: remember the effective's own error for
      // exhaustion, the last eligible error for the skipped-
      // effective case, then emit a switch notice if there is a
      // next candidate. Notices are stderr-only and only
      // emitted when fallback is enabled.
      lastEligibleError = err;
      if (entry.descriptor.id === opts.effectiveProvider) {
        effectiveError = err;
        effectiveRan = true;
      }
      if (opts.fallbackEnabled && i < plan.length - 1) {
        const next = plan[i + 1]?.descriptor;
        if (next) {
          opts.writeStderr(switchNotice(entry, err, opts.capabilityId, opts.commandLabel, next.id));
        }
      }
    }
  }

  // Exhaustion. Prefer the effective's OWN error when it ran
  // (critique #7 / exit-code contract). When the effective was
  // ineligible and never invoked but eligible candidates ran and
  // failed, surface the last eligible failure so the JSON envelope
  // is actionable. Otherwise keep the typed preflight error.
  //
  // Review Fix 5: emit a single terminal stderr notice BEFORE the
  // rethrow so the user sees the final state. Three observable
  // shapes:
  //   - Plan was empty of eligible candidates (all rejected at
  //     preflight): `no eligible candidates` for the command.
  //   - Last eligible candidate ran and failed: `<last> failed
  //     (<code>) for <command> — no further candidates`.
  //   - Otherwise: silent, because there is nothing new to convey
  //     beyond the effective's own error envelope.
  // Strict mode (`fallbackEnabled === false`) stays silent so the
  // JSON error contract for scripting users is unaffected.
  const exhaustionError =
    effectiveRan && effectiveError !== undefined
      ? effectiveError
      : lastEligibleError !== undefined
        ? lastEligibleError
        : null;

  if (opts.fallbackEnabled) {
    const eligibleCount = plan.filter((p) => p.status.kind === "eligible").length;
    if (eligibleCount === 0) {
      // Plan had no eligible entries (every preflight rejected the
      // candidate). Surface a single unambiguous terminal line so
      // the user knows the executor walked the plan and had nothing
      // to attempt.
      opts.writeStderr(`⚠ ${opts.commandLabel}: no eligible candidates`);
    } else if (exhaustionError !== null) {
      opts.writeStderr(
        terminalExhaustionNotice(
          lastAttemptedId ?? opts.effectiveProvider,
          exhaustionError,
          opts.commandLabel,
        ),
      );
    }
    // else: there were eligible candidates and none produced a runtime
    // error path to surface here. The plan was exhausted without an
    // eligible run (e.g. every candidate short-circuited on
    // preflight-rejected neighbours). In that case the typed error
    // from the preferred path carries enough signal; no extra line.
  }

  if (exhaustionError !== null) {
    throw exhaustionError;
  }
  // The effective was ineligible (preflight rejected it without
  // ever invoking `attempt`) and no eligible candidate ran either.
  // Surface the matching typed error so the dispatcher exit code
  // matches 0.10.x.
  const firstEntry = plan[0];
  if (firstEntry && firstEntry.status.kind === "unconfigured") {
    throw new ConfigurationError(
      `Provider "${opts.effectiveProvider}" is not configured. ${credentialMessageFor(firstEntry.descriptor)}`,
    );
  }
  // `incapable` — capability metadata or adapter-handle check
  // failed. Configuration was either irrelevant (capability
  // metadata failed first) or passed (adapter-handle failed);
  // either way the 0.10.x exit code is 1 via
  // `UnsupportedCapabilityError`.
  throw new UnsupportedCapabilityError(opts.effectiveProvider, opts.capabilityId);
}

/**
 * Build the terminal exhaustion notice for the last eligible
 * candidate that ran and failed. Carries the SAME stable error
 * code the typed error envelope exposes so the user can map
 * stderr text to a JSON error code without parsing. The
 * `<commandLabel>` matches the same label used by the in-loop
 * switch notices so the wording is consistent across a single
 * invocation.
 *
 * The notice format follows the orchestrator's Review Fix 5
 * guidance: `<last> failed (<code>) — no further candidates`.
 */
function terminalExhaustionNotice(lastId: ProviderId, err: unknown, _commandLabel: string): string {
  const code =
    typeof err === "object" && err !== null && "code" in err
      ? String((err as { code: unknown }).code)
      : "ERROR";
  // Format mirrors the orchestrator's literal Review-Fix-5 guidance:
  // `<last> failed (<code>) — no further candidates`. The `⚠`
  // icon matches the existing skip / switch notice family for
  // visual consistency across a single invocation.
  return `⚠ ${lastId} failed (${code}) — no further candidates`;
}
