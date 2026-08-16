/**
 * Provider Selection (DESIGN.md §6, PRD FR-001 through FR-005).
 *
 * Pure resolution of a Provider ID from explicit and environment input.
 * No credentials participate; no Adapter is constructed.
 *
 * Precedence:
 *   1. explicit option (trimmed, lowercased)
 *   2. SCOUTLINE_PROVIDER environment variable (trimmed, lowercased)
 *   3. compatibility default `zai`
 *
 * An explicitly empty Provider is present and invalid; it must NOT fall
 * through to the environment or default. Unknown values are invalid in
 * both explicit and environment positions.
 *
 * Only Search, Vision, quota, and diagnostics call this module.
 * Z.AI-only command families (raw tools, Code Mode) remove the global
 * flag during parsing and never resolve or validate it. Reader and
 * repository exploration participate in Provider selection.
 */

import type { ProviderCapability, ProviderDescriptor, ProviderId } from "./types.js";
import { PROVIDER_IDS } from "./types.js";
import { ValidationError } from "../lib/errors.js";
import type { QuotaState } from "../lib/quota-store.js";
import { rankProvidersForCapability } from "../lib/quota-mapping.js";

// Re-export descriptor helpers at the selection boundary so command
// Modules need only a single import.
export { getProviderDescriptor, getConfiguredProviderDescriptors } from "./types.js";

/**
 * Accepted Provider IDs shown in the help message when validation fails.
 */
const ACCEPTED_IDS_HELP = `Accepted provider IDs: ${PROVIDER_IDS.join(", ")}.`;

/**
 * Trim and lowercase a Provider candidate. Returns `null` when the
 * trimmed value is empty so callers can distinguish "absent" from
 * "invalid".
 */
function normalize(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Parse and validate a Provider ID. Trims and lowercases the input.
 * Empty and unknown values throw `ValidationError` whose `help` lists
 * the accepted IDs.
 */
export function parseProviderId(value: string): ProviderId {
  const normalized = normalize(value);
  if (normalized === null) {
    throw new ValidationError(
      `Provider ID must not be empty. ${ACCEPTED_IDS_HELP}`,
      ACCEPTED_IDS_HELP,
    );
  }
  if (!(PROVIDER_IDS as readonly string[]).includes(normalized)) {
    throw new ValidationError(
      `Unknown provider "${normalized}". ${ACCEPTED_IDS_HELP}`,
      ACCEPTED_IDS_HELP,
    );
  }
  return normalized as ProviderId;
}

/**
 * Parse a comma-separated list of Provider IDs for multi-provider fan-out.
 *
 * Returns:
 *   - `"all"` when the input is the literal sentinel (case-insensitive
 *     after trim, no commas present),
 *   - a `ProviderId[]` of the validated, deduplicated IDs in input order,
 *   - `null` when the input is empty, contains only empty fragments, or
 *     contains any unknown ID. A single bad ID fails the WHOLE parse —
 *     partial lists with one typo are not silently truncated.
 *
 * The `"all"` sentinel is mutually exclusive with the comma-list form:
 * `"all,tavily"` returns `null` because it is ambiguous (a sentinel
 * plus a list). The fan-out resolver expands `"all"` against configured
 * descriptors; this function only recognizes the literal token.
 *
 * Validation is performed against `PROVIDER_IDS` (same source of truth
 * as `parseProviderId`); IDs are lowercased before comparison so
 * `"TAVILY,Exa"` is accepted as `["tavily", "exa"]`.
 */
export function parseProviderIds(raw: string): ProviderId[] | "all" | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  // Single-token path: either the `"all"` sentinel or a single
  // ProviderId. Treated as mutually exclusive with the comma form so
  // ambiguous inputs like `"all,tavily"` fail loud rather than silently
  // dropping the trailing token.
  if (!trimmed.includes(",")) {
    const lower = trimmed.toLowerCase();
    if (lower === "all") return "all";
    if ((PROVIDER_IDS as readonly string[]).includes(lower)) {
      return [lower as ProviderId];
    }
    return null;
  }

  // Comma-list path: trim, lowercase, validate, dedupe (first
  // occurrence wins), drop empties. Any unknown ID fails the whole
  // parse — partial lists with one typo would otherwise be silently
  // truncated and the fan-out resolver would diverge from the user's
  // intent.
  const ids: ProviderId[] = [];
  const seen = new Set<string>();
  for (const fragment of trimmed.split(",")) {
    const candidate = fragment.trim().toLowerCase();
    if (candidate.length === 0) continue;
    if (!(PROVIDER_IDS as readonly string[]).includes(candidate)) {
      return null;
    }
    if (!seen.has(candidate)) {
      seen.add(candidate);
      ids.push(candidate as ProviderId);
    }
  }
  return ids.length > 0 ? ids : null;
}

/**
 * Resolve the effective Provider ID with explicit precedence over
 * environment over the compatibility default. An explicitly empty
 * value (including whitespace) is treated as present and invalid; it
 * throws `ValidationError` before consulting the environment.
 *
 * `env` defaults to `process.env` for production callers; tests pass
 * an explicit object so they do not touch process globals.
 *
 * FR-003: provider selection is NEVER inferred from available
 * credentials. The default branch always returns `"zai"`; whether the
 * effective Provider is configured is a question for the caller (which
 * throws `ConfigurationError`, exit 3), not for selection.
 */
export function resolveProviderId(
  explicitProvider: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ProviderId {
  // 1. Explicit option — present (including empty) and invalid if empty/unknown.
  if (explicitProvider !== undefined) {
    return parseProviderId(explicitProvider);
  }

  // 2. Environment variable. An empty value here means "explicitly empty":
  //    present, invalid, and must not fall through to the default.
  const envValue = env.SCOUTLINE_PROVIDER;
  if (envValue !== undefined) {
    return parseProviderId(envValue);
  }

  // 3. Compatibility default. No credentials, descriptors, or
  // configuration participate (FR-003). The "is the effective
  // Provider configured?" check lives in the dispatch caller, which
  // surfaces a missing credential as ConfigurationError (exit 3).
  return "zai";
}

// ---------------------------------------------------------------------------
// Effective provider selection (PB-T4 — Plan B)
// ---------------------------------------------------------------------------

/**
 * Options for {@link resolveEffectiveProvider}.
 *
 * The resolver is **pure**: it performs no I/O, reads no credentials
 * beyond the injected `descriptors[].isConfigured(env)` metadata check,
 * and writes nothing. The caller owns the snapshot read and descriptor
 * construction.
 */
export interface ResolveEffectiveProviderOptions {
  /**
   * The parsed `--provider <id>` flag value, or `undefined` when the
   * flag was not passed. An explicitly-empty value (`""`) is treated as
   * PRESENT and invalid; it surfaces `ValidationError` exactly as
   * {@link resolveProviderId} does today. The pin bypasses quota
   * ranking entirely — even when the pinned provider is unconfigured
   * or incapable, it is returned so the executor surfaces the existing
   * typed `ConfigurationError` / `UnsupportedCapabilityError`.
   */
  readonly explicitProvider: string | undefined;
  /**
   * The environment view the handlers run under (resolved env after
   * config-file keys are layered in). `SCOUTLINE_PROVIDER` is the
   * env-level pin; its precedence sits below `explicitProvider` and
   * above the no-pin ranking path.
   */
  readonly env: NodeJS.ProcessEnv;
  /**
   * The capability the dispatching handler is about to invoke (e.g.
   * `"search"`, `"reader"`, `"vision.interpret-image"`). Only
   * descriptors whose `capabilities()` set contains this id are
   * eligible for the no-pin ranking branch.
   */
  readonly capabilityId: ProviderCapability;
  /**
   * The provider registry, in stable tie-break order. Production
   * passes {@link BUILT_IN_PROVIDER_DESCRIPTORS}; tests inject doubles
   * so selection runs against the same descriptor list the executor
   * will subsequently walk.
   */
  readonly descriptors: readonly ProviderDescriptor[];
  /**
   * The quota snapshot read once by `main` before dispatch (PB-T1's
   * `quotaStore.read()`). When `undefined`, the resolver delegates to
   * {@link resolveProviderId} and returns the compatibility default
   * `"zai"` — byte-for-byte the pre-PB-T4 behaviour. This keeps
   * existing test suites (which inject descriptors but not a snapshot)
   * green unchanged. Production always supplies a snapshot (the store
   * read is fail-open and never rejects); tests that assert specific
   * selection outcomes inject a crafted snapshot explicitly.
   *
   * The resolver never refreshes, writes, or decrements against this
   * snapshot.
   */
  readonly quotaSnapshot?: QuotaState;
  /**
   * Override the stable registry order used for tie-breaking. Defaults
   * to {@link PROVIDER_IDS} (`[zai, minimax, tavily, exa, brave,
   * firecrawl]`). Tests pass a tailored order to assert specific
   * tie-break outcomes; production never overrides.
   */
  readonly registryOrder?: readonly ProviderId[];
  /**
   * Per-capability routed preference lists (routing-table plan). When
   * `routing[capabilityId]` exists and no pin is present, the resolver
   * walks that list in order and returns the FIRST provider that is
   * both configured and capable — routing is an instruction, not a
   * hint: quota ranking does NOT reorder the routed prefix. If no
   * routed provider is eligible, resolution falls through to the
   * existing ranked path unchanged (routing can only change the
   * answer, never eliminate candidates). Absent/undefined →
   * byte-identical pre-routing behavior. The resolver is never
   * responsible for validating list contents; an unknown id simply
   * matches no descriptor and is skipped.
   */
  readonly routing?: Readonly<Record<string, readonly ProviderId[]>>;
}

/**
 * Resolve the **effective** Provider for a single capability
 * invocation, blending the explicit/env pin path with the quota-aware
 * ranking introduced by Plan B (PB-T4).
 *
 * Resolution order:
 *   1. **Pin presence OR absent snapshot.** When `explicitProvider` is
 *      not `undefined`, `env.SCOUTLINE_PROVIDER` is not `undefined`, OR
 *      `quotaSnapshot` is `undefined`, delegate to
 *      {@link resolveProviderId}. Pin detection happens BEFORE the
 *      ranking branch so the no-pin path is not collapsed to `"zai"`
 *      by the delegation. Pin bypasses quota ranking entirely — even
 *      when the pinned provider is unconfigured or incapable, it is
 *      returned so the executor surfaces the existing typed
 *      `ConfigurationError`/`UnsupportedCapabilityError`. An absent
 *      snapshot delegates identically: tests that inject descriptors
 *      but no snapshot get byte-for-byte the pre-PB-T4 selection
 *      (compat `"zai"`), so the full existing test suite stays green.
 *   1.5 **Routed preference walk** (routing-table plan). When
 *      `routing[capabilityId]` is present (and only on the no-pin,
 *      snapshot-present path), walk it in order and return the first
 *      configured-and-capable entry; quota ranking does not reorder
 *      the routed prefix. Exhaustion falls through to step 2.
 *   2. **Eligibility filter.** Among the injected descriptors, keep
 *      those that are BOTH configured (`isConfigured(env)`) AND
 *      advertise `capabilityId` (`capabilities().has(capabilityId)`),
 *      in stable registry order.
 *   3. **Quota-aware ranking.** Delegate the eligible list to PB-T3's
 *      {@link rankProvidersForCapability} against the supplied
 *      snapshot. Known-tier providers are ranked by score descending;
 *      unknown-tier providers (Brave rate-limit, Exa no-quota) follow
 *      in registry order. A known provider at 5% remaining still wins
 *      over a non-authoritative provider.
 *   4. **None eligible.** When no descriptor is both configured and
 *      capable, return `"zai"` — the compatibility default — so the
 *      executor surfaces the same typed exhaustion error today's
 *      code does. Never returns `undefined`; the return is always a
 *      scalar `ProviderId` the executor takes unchanged.
 *
 * This function is synchronous and deterministic: same inputs → same
 * output, byte-for-byte. It never performs provider I/O, refreshes the
 * snapshot, or decrements quota state.
 *
 * Boundaries (locked by the PB-T4 ticket):
 *   - `executeWithFallback` and `lib/provider-fallback.ts` are
 *     byte-unchanged. This function supplies a different **first
 *     scalar** only; the candidate loop, error classification, and
 *     reactive fallback remain the executor's responsibility.
 *   - Doctor / quota / all-provider mode never call this function;
 *     they continue to use {@link resolveProviderId} for observational
 *     metadata.
 *   - Raw Z.AI commands (tools / tool / call / code) never enter
 *     provider selection.
 */
export function resolveEffectiveProvider(options: ResolveEffectiveProviderOptions): ProviderId {
  const { explicitProvider, env, capabilityId, descriptors, quotaSnapshot, registryOrder } =
    options;

  // 1. Pin presence OR absent snapshot → delegate to resolveProviderId.
  //    - Pin: preserves typed errors for empty/unknown pins; bypasses
  //      ranking even when the pinned provider is ineligible.
  //    - Absent snapshot: exact pre-PB-T4 compat. Tests that inject
  //      descriptors but not a snapshot get the "always zai" default
  //      unchanged; production always supplies a snapshot via
  //      quotaStore.read().
  if (
    explicitProvider !== undefined ||
    env.SCOUTLINE_PROVIDER !== undefined ||
    quotaSnapshot === undefined
  ) {
    return resolveProviderId(explicitProvider, env);
  }

  // 1.5 Routed preference walk (routing-table plan DESIGN D1/D3). Only
  //     the no-pin + snapshot-present path consults routing. The walk
  //     mirrors the eligibility checks of step 2 so a routed pick is
  //     indistinguishable from a ranked pick from the executor's point
  //     of view. Exhaustion falls through to the ranked path — routing
  //     never eliminates candidates.
  const routed = options.routing?.[capabilityId as string];
  if (routed !== undefined) {
    for (const id of routed) {
      const descriptor = descriptors.find((d) => d.id === id);
      if (!descriptor) continue;
      if (!descriptor.isConfigured(env, capabilityId)) continue;
      if (!descriptor.capabilities().has(capabilityId)) continue;
      return id;
    }
  }

  // 2. Eligibility filter in stable registry order. Passing candidates
  //    in registry order makes the ranker's inputOrder tiebreak align
  //    with registryOrder, keeping the sort fully deterministic.
  const order = registryOrder ?? PROVIDER_IDS;
  const eligibleIds: ProviderId[] = [];
  for (const id of order) {
    const descriptor = descriptors.find((d) => d.id === id);
    if (!descriptor) continue;
    if (!descriptor.isConfigured(env, capabilityId)) continue;
    if (!descriptor.capabilities().has(capabilityId)) continue;
    eligibleIds.push(id);
  }

  // 4. None eligible → compat default. The executor's preflight will
  //    surface the same typed error (ConfigurationError exit 3 when
  //    "zai" is unconfigured, UnsupportedCapabilityError exit 1 when
  //    incapable) today's code does. Never returns undefined.
  if (eligibleIds.length === 0) {
    return "zai";
  }

  // 3. Quota-aware ranking via PB-T3. The snapshot is present (guarded
  //    above), so known-tier providers win over unknown-tier
  //    providers. The first entry is the winner; the rest are available
  //    to the executor's reactive candidate loop (which rebuilds
  //    [effective, ...registry] independently).
  const ranked = rankProvidersForCapability(quotaSnapshot, capabilityId, eligibleIds, {
    registryOrder: order,
  });
  return ranked[0]?.provider ?? eligibleIds[0] ?? "zai";
}
