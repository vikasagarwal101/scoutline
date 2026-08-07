/**
 * Quota normalization — capability/category mapping + authority-aware
 * scoring (Plan B — PB-T3).
 *
 * Derives a remaining score per `(provider, capability)` from the **raw
 * category snapshot** persisted by PB-T1, so PB-T4 can rank providers
 * without learning any Provider's category schema. Pure derivation only:
 * takes a {@link QuotaState} as input, returns scored/ranked results,
 * never touches disk or transport.
 *
 * Two review fixes shape the contract:
 *
 * 1. **Map raw categories, not a pre-derived remaining.** Each Provider
 *    normalizes its native quota payload into named {@link QuotaCategory}
 *    entries (PB-T1). This module declares which category name governs
 *    which `(provider, capability)` pair, then reads that category's
 *    `current.remainingPercent` as the score. The score is already
 *    normalized 0..100 by `buildQuotaWindow`; this module does NOT
 *    re-derive or re-clamp.
 *
 * 2. **Separate authority from score.** The "neutral 50 yet never
 *    fullest" contradiction is resolved by representing unknown
 *    authority explicitly rather than encoding it as a numeric score.
 *    Providers with a real credit/token signal form a **known tier**,
 *    ranked by score; providers without a signal (Brave rate-limit,
 *    Exa none) form an **unknown tier**, ranked after every known
 *    provider. The unknown tier never wins over a known provider, even
 *    a low-scored one.
 *
 * Boundary rules:
 *   - Imports the quota contract types from `capabilities/quota.js`,
 *     provider identity/capability types from `providers/types.js`, and
 *     PB-T1's `QuotaState` from `lib/quota-store.js`. No provider
 *     transport, no command presentation, no `MainDependencies`.
 *   - **Pure module.** No disk I/O, no transport, no
 *     `process.stderr.write`. Warning output is returned to the caller
 *     through an `onWarning` callback; the scoring result itself never
 *     observes the outside world.
 *   - **Fail-open on drift.** If a mapped category name is absent from
 *     the live snapshot (provider renamed it), degrade to the
 *     provider-level fallback, then to **unknown** — never hard-fail.
 *     Each degradation emits a structured warning so drift is visible.
 *
 * Relation to other Plan B tickets:
 *   - PB-T1: this module reads `QuotaState` (the persisted snapshot);
 *     it does not write.
 *   - PB-T2: consumption events advance `locallyUpdatedAt` and adjust
 *     category estimates. This module reads the resulting category
 *     `current` window; the locally-decremented value is the score.
 *   - PB-T4: consumes `rankProvidersForCapability` and applies the
 *     selection algorithm. This module never selects.
 */

import type { QuotaCategory } from "../capabilities/quota.js";
import type { ProviderCapability, ProviderId } from "../providers/types.js";
import { PROVIDER_IDS } from "../providers/types.js";
import type { QuotaState } from "./quota-store.js";

// ---------------------------------------------------------------------------
// Authority-bearing score result
// ---------------------------------------------------------------------------

/**
 * The authority-aware score for a single `(provider, capability)` pair.
 *
 * - `authority: "known"` — the provider exposes a real credit/token
 *   signal and the mapped category was found in the snapshot. `score`
 *   is the category's `current.remainingPercent` (already normalized
 *   0..100 by PB-T1). `category` is the matched category name (after
 *   alias resolution / fallback), so PB-T4 can surface which pool was
 *   ranked.
 * - `authority: "unknown"` — no authoritative signal is available
 *   (provider has no spend quota; snapshot missing; mapped category
 *   absent and no fallback matched; percent corrupt). `reason` is a
 *   stable, machine-readable reason code, NOT a user-facing message.
 *   Unknown entries are eligible as fallback but never win over a
 *   known-scored provider (PB-T4 contract).
 *
 * `unknown` is NEVER encoded as a numeric score (no neutral `50`, no
 * `Infinity`, no `0`). This is the explicit fix for the "neutral 50 yet
 * never fullest" contradiction flagged in review item 12: authority is
 * a separate axis from score, and PB-T4 sorts the two tiers
 * independently.
 */
export type CapabilityScore =
  | { readonly authority: "known"; readonly score: number; readonly category: string }
  | { readonly authority: "unknown"; readonly reason: UnknownScoreReason };

/**
 * Machine-readable reason for an unknown score. Stable across releases
 * so callers (PB-T4, dashboards) can branch without parsing prose. The
 * matching human-readable text lives in the warning metadata.
 */
export type UnknownScoreReason =
  /**
   * The provider is in the always-unknown authority tier by policy
   * (Brave rate-limit, Exa no quota capability). No category lookup
   * is attempted.
   */
  | "PROVIDER_NON_AUTHORITATIVE"
  /**
   * No mapping entry exists for `(provider, capability)`. Either the
   * capability is observational (`quota`/`diagnostics`) or the
   * mapping table has a gap (ticket: add a row + warn).
   */
  | "MAPPING_MISSING"
  /**
   * The provider has no snapshot in {@link QuotaState} (never
   * harvested, or the entry was cleared).
   */
  | "SNAPSHOT_MISSING"
  /**
   * The snapshot exists but its `categories` array is empty.
   */
  | "SNAPSHOT_EMPTY"
  /**
   * None of the mapped aliases matched a category, and no
   * provider-level fallback matched either. Likely provider-side
   * rename (drift).
   */
  | "CATEGORY_NOT_FOUND"
  /**
   * The matched category's `remainingPercent` is not a finite number
   * in 0..100. PB-T1's `buildQuotaWindow` is supposed to guarantee
   * this, but a hand-edited `state.json` could violate it; the scorer
   * treats corrupt input as unknown rather than synthesizing a score.
   */
  | "PERCENT_CORRUPT";

// ---------------------------------------------------------------------------
// Mapping table — (provider, capability) → category aliases
// ---------------------------------------------------------------------------

/**
 * One row of the static mapping table: for `(provider, capability)`,
 * which raw `QuotaCategory.name` governs the score.
 *
 * `categoryAliases` is an **ordered** list of acceptable category names.
 * The first alias that matches a category in the live snapshot wins.
 * This is the fail-open seam: when a provider renames a category, the
 * lookup silently misses and the scorer degrades to the
 * `providerFallbackCategory` (if any), then to unknown. Drift is
 * surfaced through a structured warning.
 *
 * Case-sensitivity follows the existing normalizers: Tavily emits
 * lowercase endpoint names (`search`, `crawl`, ...), Z.AI emits
 * `requests`/`tokens`, Firecrawl emits a case-sensitive `Credits`. The
 * alias list must match the normalizer's exact emission; do not
 * case-fold here or the mapping will hide drift.
 */
export interface CapabilityMappingEntry {
  readonly provider: ProviderId;
  readonly capability: ProviderCapability;
  readonly categoryAliases: readonly string[];
  /**
   * Optional provider-level category used when no alias matches.
   * For Tavily, this is the aggregate `requests` category — every
   * endpoint shares one credit pool, so a missing endpoint category
   * degrades to the pool-level remaining. For providers with one
   * category per capability (Z.AI, Firecrawl), this is intentionally
   * absent: a missing category means real drift, not a graceful
   * fallback target.
   */
  readonly providerFallbackCategory?: string;
}

/**
 * Default MiniMax model-name aliases per capability. MiniMax's
 * `/remains` normalizer emits one category per live `model_name`
 * string, and `model_name` values are arbitrary (the live schema does
 * NOT emit a stable `general` label — see ticket
 * `tests/quota-conformance.test.js:310-370` and fixtures including
 * `zorla-x` and `abab6.5s-chat`). This table is the documented
 * mapping policy: the first alias that matches a live category wins.
 *
 * Tests and PB-T4 callers can override this table via
 * {@link ScoreOptions.minimaxModelAliases} when a deployment uses
 * a different model name. Fail-open applies: an empty match degrades
 * to unknown + warn, never a throw.
 */
export const DEFAULT_MINIMAX_MODEL_ALIASES: Readonly<
  Record<"search" | "vision.interpret-image", readonly string[]>
> = {
  // MiniMax Coding Plan search endpoint (/v1/coding_plan/search) is
  // served by the Coding Plan model. The fixture's `zorla-x` is the
  // characterized representative; `MiniMax-Text-01` and `coding-plan`
  // are documented alternates the live API has used. `general` is the
  // policy label the original ticket named; it is intentionally last
  // because the live schema does not emit it.
  search: ["zorla-x", "MiniMax-Text-01", "coding-plan", "general"],
  // MiniMax Coding Plan VLM endpoint (/v1/coding_plan/vlm) is served
  // by the multimodal variant. `abab6.5-vl` and `MiniMax-VL-01` are
  // documented; the fixture's `abab6.5s-chat` is included as a
  // characterized fallback.
  "vision.interpret-image": ["abab6.5-vl", "MiniMax-VL-01", "abab6.5s-chat", "vlm"],
};

/**
 * The full Vision capability set advertised by Z.AI, plus the
 * specialized operations MiniMax may attest. They all share the same
 * category mapping within their provider (Z.AI → `tokens`, MiniMax →
 * the VLM model alias), so the table is generated from one constant
 * list per provider to keep the rows in sync.
 */
export const ZAI_VISION_CAPABILITIES: readonly ProviderCapability[] = [
  "vision.interpret-image",
  "vision.ui-artifact",
  "vision.extract-text",
  "vision.diagnose-error",
  "vision.diagram",
  "vision.chart",
  "vision.diff",
  "vision.video",
];

/**
 * Specialized MiniMax Vision operations (mirror of the descriptor's
 * attested set). They all share the VLM model alias.
 */
export const MINIMAX_VISION_CAPABILITIES: readonly ProviderCapability[] = [
  "vision.interpret-image",
  "vision.ui-artifact",
  "vision.extract-text",
  "vision.diagnose-error",
  "vision.diagram",
  "vision.chart",
];

/**
 * Z.AI capabilities that share the rolling `requests` category.
 * `quota` and `diagnostics` are intentionally absent — they are
 * observational, not selection candidates.
 */
export const ZAI_REQUEST_CAPABILITIES: readonly ProviderCapability[] = [
  "search",
  "reader",
  "repository-exploration",
];

/**
 * Tavily endpoint-mapped capabilities. Each maps to a same-named
 * endpoint category with a fallback to the aggregate `requests`
 * pool (every Tavily endpoint bills against one credit pool).
 */
export const TAVILY_ENDPOINT_CAPABILITIES: readonly ProviderCapability[] = [
  "search",
  "reader",
  "crawl",
  "map",
  "research",
];

/**
 * Tavily `(capability → endpoint category name)` resolution. `reader`
 * is mapped to the `extract` endpoint (the Tavily `/extract` endpoint
 * serves reader calls). Other capabilities map to the same-named
 * endpoint category.
 */
export const TAVILY_CAPABILITY_TO_ENDPOINT: Readonly<
  Record<ProviderCapability, string | undefined>
> = {
  search: "search",
  reader: "extract",
  crawl: "crawl",
  map: "map",
  research: "research",
  // Observational / non-Tavily capabilities are absent; the lookup
  // returns undefined and the mapping loop skips them.
  "vision.interpret-image": undefined,
  "vision.ui-artifact": undefined,
  "vision.extract-text": undefined,
  "vision.diagnose-error": undefined,
  "vision.diagram": undefined,
  "vision.chart": undefined,
  "vision.diff": undefined,
  "vision.video": undefined,
  quota: undefined,
  diagnostics: undefined,
  "repository-exploration": undefined,
};

/**
 * Firecrawl capabilities. All four consume the shared `Credits` pool.
 */
export const FIRECRAWL_CREDIT_CAPABILITIES: readonly ProviderCapability[] = [
  "search",
  "reader",
  "crawl",
  "map",
];

/**
 * The static capability→category mapping table. Built once at module
 * load from the per-provider capability lists so a future capability
 * addition only edits one constant, not 8 rows.
 *
 * Excluded by design:
 *   - Brave: always-unknown authority (rate-limit, not spend).
 *   - Exa: always-unknown authority (no quota capability).
 *   - `quota`/`diagnostics` on every provider: observational, not
 *     selection candidates.
 *
 * The table is `readonly` and exported so PB-T5/dashboards/Doctor can
 * render the same source of truth the scorer uses.
 */
export const CAPABILITY_MAPPINGS: readonly CapabilityMappingEntry[] = [
  // Z.AI — search/reader/repository share `requests`; vision ops share `tokens`.
  ...ZAI_REQUEST_CAPABILITIES.map(
    (capability): CapabilityMappingEntry => ({
      provider: "zai",
      capability,
      categoryAliases: ["requests"],
    }),
  ),
  ...ZAI_VISION_CAPABILITIES.map(
    (capability): CapabilityMappingEntry => ({
      provider: "zai",
      capability,
      categoryAliases: ["tokens"],
    }),
  ),

  // MiniMax — search and vision ops resolve via the model alias table.
  // The alias list is filled at scoring time from
  // DEFAULT_MINIMAX_MODEL_ALIASES (or the injected override); the
  // static table holds an empty alias list as a sentinel that the
  // mapping EXISTS but resolves dynamically. The scorer knows to
  // expand MiniMax rows via the alias table.
  {
    provider: "minimax",
    capability: "search",
    categoryAliases: [],
  },
  ...MINIMAX_VISION_CAPABILITIES.map(
    (capability): CapabilityMappingEntry => ({
      provider: "minimax",
      capability,
      categoryAliases: [],
    }),
  ),

  // Tavily — endpoint category with aggregate `requests` fallback.
  ...TAVILY_ENDPOINT_CAPABILITIES.map(
    (capability): CapabilityMappingEntry => ({
      provider: "tavily",
      capability,
      categoryAliases: [TAVILY_CAPABILITY_TO_ENDPOINT[capability]!],
      providerFallbackCategory: "requests",
    }),
  ),

  // Firecrawl — every capability consumes the shared `Credits` pool.
  ...FIRECRAWL_CREDIT_CAPABILITIES.map(
    (capability): CapabilityMappingEntry => ({
      provider: "firecrawl",
      capability,
      categoryAliases: ["Credits"],
    }),
  ),
];

// ---------------------------------------------------------------------------
// Authority policy — which providers carry authoritative spend signals
// ---------------------------------------------------------------------------

/**
 * Per-provider authority policy.
 *
 * - `"mapped"` — the provider exposes real credit/token signals; its
 *   categories map to capabilities via {@link CAPABILITY_MAPPINGS} and
 *   the score is the matched category's `remainingPercent`.
 * - `"always-unknown"` — the provider has no authoritative spend
 *   signal. {@link CapabilityScore} always returns `authority:"unknown"`
 *   with the documented reason, regardless of whether a snapshot
 *   exists. The provider remains **eligible** for PB-T4 fallback, but
 *   it never wins over a known-scored provider.
 *
 * `reason` is surfaced unchanged through the warning channel when a
 * score is requested for an always-unknown provider; it documents the
 * policy for dashboards and Doctor.
 */
export interface ProviderAuthorityPolicy {
  readonly provider: ProviderId;
  readonly kind: "mapped" | "always-unknown";
  readonly reason: string;
}

/**
 * The static authority-policy table. Two providers are explicitly
 * non-authoritative:
 *
 * - **Brave**: reports a rate-limit window via `X-RateLimit-*` headers,
 *   not spend or credits consumed. Brave uses metered billing, so the
 *   `remainingPercent` is a rate-limit signal, not a budget signal
 *   (see `BRAVE_QUOTA_CAVEAT` in `providers/brave/quota.ts`). The
 *   numeric window is retained for PB-T5 dashboard display; the
 *   authority axis deliberately ignores it.
 * - **Exa**: advertises no `quota` capability at all. There is nothing
 *   to map or synthesize.
 *
 * Both providers stay **eligible** for PB-T4 fallback (their
 * `authority:"unknown"` score sorts after every known provider), so
 * they can still be picked when no known provider remains.
 */
export const PROVIDER_AUTHORITY_POLICIES: readonly ProviderAuthorityPolicy[] = [
  { provider: "zai", kind: "mapped", reason: "Z.AI exposes TIME_LIMIT/TOKENS_LIMIT signals." },
  {
    provider: "minimax",
    kind: "mapped",
    reason: "MiniMax exposes per-model remaining counters.",
  },
  {
    provider: "tavily",
    kind: "mapped",
    reason: "Tavily exposes per-endpoint and aggregate usage counts.",
  },
  {
    provider: "firecrawl",
    kind: "mapped",
    reason: "Firecrawl exposes a credit-usage pool.",
  },
  {
    provider: "brave",
    kind: "always-unknown",
    reason:
      "Brave quota reflects a rate-limit window (requests remaining this period), not spend or credits consumed.",
  },
  {
    provider: "exa",
    kind: "always-unknown",
    reason: "Exa does not advertise a quota capability; no signal to map.",
  },
  {
    provider: "parallel",
    kind: "always-unknown",
    reason: "Parallel AI does not advertise a quota capability; no signal to map.",
  },
  {
    provider: "perplexity",
    kind: "always-unknown",
    reason: "Perplexity does not advertise a quota capability; no signal to map.",
  },
  {
    provider: "jina",
    kind: "always-unknown",
    reason: "Jina AI does not advertise a quota capability; no signal to map.",
  },
];

// ---------------------------------------------------------------------------
// Warning metadata — structured drift/diagnostic channel for callers
// ---------------------------------------------------------------------------

/**
 * A structured warning emitted by the scorer. The pure module never
 * writes to stderr; it returns warnings through the
 * {@link ScoreOptions.onWarning} callback so the caller (PB-T4 / main)
 * owns the rendering surface.
 *
 * `code` is stable across releases so dashboards can de-duplicate.
 * `message` is a single-line human-readable string suitable for stderr.
 */
export interface QuotaMappingWarning {
  readonly code:
    | "PROVIDER_NON_AUTHORITATIVE"
    | "MAPPING_MISSING"
    | "SNAPSHOT_MISSING"
    | "SNAPSHOT_EMPTY"
    | "CATEGORY_NOT_FOUND"
    | "PROVIDER_FALLBACK_USED"
    | "PERCENT_CORRUPT";
  readonly provider: ProviderId;
  readonly capability: ProviderCapability;
  readonly message: string;
}

// ---------------------------------------------------------------------------
// Lookup helpers — pure, total
// ---------------------------------------------------------------------------

/**
 * Look up the authority policy for a provider. Returns `undefined`
 * only if the registry learns a new provider ID without a corresponding
 * policy row; the scorer treats undefined as `"always-unknown"` so an
 * unmapped provider never accidentally wins.
 */
export function getProviderAuthorityPolicy(
  provider: ProviderId,
): ProviderAuthorityPolicy | undefined {
  return PROVIDER_AUTHORITY_POLICIES.find((p) => p.provider === provider);
}

/**
 * Look up the static mapping entry for `(provider, capability)`.
 * Returns `undefined` when no row exists (observational capability,
 * unknown capability, or a mapping-table gap).
 *
 * For MiniMax, the returned entry has an empty `categoryAliases`
 * sentinel; the scorer expands it via
 * {@link resolveMiniMaxAliasesForCapability}.
 */
export function getCapabilityMapping(
  provider: ProviderId,
  capability: ProviderCapability,
): CapabilityMappingEntry | undefined {
  return CAPABILITY_MAPPINGS.find((m) => m.provider === provider && m.capability === capability);
}

/**
 * Resolve the MiniMax alias list for a capability. Search returns the
 * `search` aliases; every MiniMax vision capability returns the
 * `vision.interpret-image` aliases (they all share the VLM transport).
 * Unknown capabilities return an empty list.
 */
export function resolveMiniMaxAliasesForCapability(
  capability: ProviderCapability,
  aliases: Readonly<
    Record<"search" | "vision.interpret-image", readonly string[]>
  > = DEFAULT_MINIMAX_MODEL_ALIASES,
): readonly string[] {
  if (capability === "search") return aliases.search;
  if (MINIMAX_VISION_CAPABILITIES.includes(capability)) {
    return aliases["vision.interpret-image"];
  }
  return [];
}

/**
 * Resolve the effective alias list for a mapping entry. For non-MiniMax
 * providers, returns the entry's static `categoryAliases`. For MiniMax,
 * expands the alias table.
 */
function resolveEffectiveAliases(
  entry: CapabilityMappingEntry,
  minimaxAliases: Readonly<Record<"search" | "vision.interpret-image", readonly string[]>>,
): readonly string[] {
  if (entry.provider === "minimax") {
    return resolveMiniMaxAliasesForCapability(entry.capability, minimaxAliases);
  }
  return entry.categoryAliases;
}

function findCategoryByName(
  categories: readonly QuotaCategory[],
  name: string,
): QuotaCategory | undefined {
  for (const c of categories) {
    if (c.name === name) return c;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Scoring — the core pure derivation
// ---------------------------------------------------------------------------

/**
 * Options for {@link scoreCapability} and {@link rankProvidersForCapability}.
 */
export interface ScoreOptions {
  /**
   * Override the MiniMax model-name alias table. Production uses
   * {@link DEFAULT_MINIMAX_MODEL_ALIASES}; tests pass a tailored table
   * to assert specific match paths.
   */
  readonly minimaxModelAliases?: Readonly<
    Record<"search" | "vision.interpret-image", readonly string[]>
  >;
  /**
   * Best-effort warning sink. The scorer never calls
   * `process.stderr.write`; every degradation routes through this
   * callback. Caller owns the rendering surface. Production wires a
   * stderr writer; tests inject a recorder.
   */
  readonly onWarning?: (warning: QuotaMappingWarning) => void;
}

function isTrustworthyPercent(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
}

/**
 * Derive the authority-aware score for a single `(provider, capability)`
 * pair from the persisted {@link QuotaState}.
 *
 * Resolution order:
 *   1. **Authority policy.** An `always-unknown` provider returns
 *      `{ authority: "unknown", reason: "PROVIDER_NON_AUTHORITATIVE" }`
 *      without consulting the snapshot. This is the Brave/Exa contract.
 *   2. **Mapping presence.** A `(provider, capability)` with no row in
 *      {@link CAPABILITY_MAPPINGS} returns `reason: "MAPPING_MISSING"`.
 *      Observational capabilities (`quota`/`diagnostics`) hit this path
 *      by design.
 *   3. **Snapshot presence.** Missing snapshot → `SNAPSHOT_MISSING`;
 *      empty `categories` array → `SNAPSHOT_EMPTY`.
 *   4. **Alias match.** Walk the entry's effective alias list (static
 *      for most providers; MiniMax resolves through the alias table).
 *      The first category whose name matches wins.
 *   5. **Provider-level fallback.** When no alias matches and the entry
 *      declares a `providerFallbackCategory`, look it up. A match
 *      emits a `PROVIDER_FALLBACK_USED` warning so drift is visible.
 *   6. **Unknown + warn.** No match at all → `CATEGORY_NOT_FOUND`.
 *   7. **Percent validation.** A matched category whose
 *      `remainingPercent` is non-finite or outside 0..100 returns
 *      `PERCENT_CORRUPT`. PB-T1's `buildQuotaWindow` is supposed to
 *      guarantee this, but a hand-edited `state.json` could violate
 *      it; the scorer treats corrupt input as unknown rather than
 *      synthesizing a score.
 *
 * This function is total: it never throws. Every failure path returns
 * a typed unknown score; the warning channel explains why.
 */
export function scoreCapability(
  state: QuotaState,
  provider: ProviderId,
  capability: ProviderCapability,
  options: ScoreOptions = {},
): CapabilityScore {
  const onWarning = options.onWarning ?? (() => {});
  const minimaxAliases = options.minimaxModelAliases ?? DEFAULT_MINIMAX_MODEL_ALIASES;

  // 1. Authority policy gate.
  const policy = getProviderAuthorityPolicy(provider);
  if (!policy || policy.kind === "always-unknown") {
    onWarning({
      code: "PROVIDER_NON_AUTHORITATIVE",
      provider,
      capability,
      message: `${provider} is non-authoritative for quota scoring (${policy?.reason ?? "no policy"}); treated as unknown tier.`,
    });
    return { authority: "unknown", reason: "PROVIDER_NON_AUTHORITATIVE" };
  }

  // 2. Mapping presence.
  const entry = getCapabilityMapping(provider, capability);
  if (!entry) {
    onWarning({
      code: "MAPPING_MISSING",
      provider,
      capability,
      message: `No quota mapping for (${provider}, ${capability}); treat as unknown or add a mapping row.`,
    });
    return { authority: "unknown", reason: "MAPPING_MISSING" };
  }

  // 3. Snapshot presence.
  const snapshot = state.quota[provider];
  if (!snapshot) {
    onWarning({
      code: "SNAPSHOT_MISSING",
      provider,
      capability,
      message: `No quota snapshot for ${provider}; scoring degrades to unknown tier.`,
    });
    return { authority: "unknown", reason: "SNAPSHOT_MISSING" };
  }
  const categories = snapshot.categories;
  if (categories.length === 0) {
    onWarning({
      code: "SNAPSHOT_EMPTY",
      provider,
      capability,
      message: `Quota snapshot for ${provider} has no categories; scoring degrades to unknown tier.`,
    });
    return { authority: "unknown", reason: "SNAPSHOT_EMPTY" };
  }

  // 4. Alias match.
  const aliases = resolveEffectiveAliases(entry, minimaxAliases);
  let matched: QuotaCategory | undefined;
  for (const alias of aliases) {
    const found = findCategoryByName(categories, alias);
    if (found) {
      matched = found;
      break;
    }
  }

  // 5. Provider-level fallback.
  if (!matched && entry.providerFallbackCategory) {
    matched = findCategoryByName(categories, entry.providerFallbackCategory);
    if (matched) {
      onWarning({
        code: "PROVIDER_FALLBACK_USED",
        provider,
        capability,
        message: `(${provider}, ${capability}) mapped category not found; using provider fallback "${matched.name}".`,
      });
    }
  }

  // 6. Unknown + warn.
  if (!matched) {
    onWarning({
      code: "CATEGORY_NOT_FOUND",
      provider,
      capability,
      message: `(${provider}, ${capability}) mapped category not found in snapshot (aliases: [${aliases.join(", ")}]${entry.providerFallbackCategory ? `, fallback: "${entry.providerFallbackCategory}"` : ""}); likely provider-side rename.`,
    });
    return { authority: "unknown", reason: "CATEGORY_NOT_FOUND" };
  }

  // 7. Percent validation. PB-T1 should guarantee finite 0..100, but
  // a hand-edited state.json could violate the contract; treat corrupt
  // input as unknown rather than letting NaN/Infinity pollute ranking.
  const percent = matched.current?.remainingPercent;
  if (!isTrustworthyPercent(percent)) {
    onWarning({
      code: "PERCENT_CORRUPT",
      provider,
      capability,
      message: `(${provider}, ${capability}) category "${matched.name}" has corrupt remainingPercent (${String(percent)}); treated as unknown.`,
    });
    return { authority: "unknown", reason: "PERCENT_CORRUPT" };
  }

  return {
    authority: "known",
    score: percent,
    category: matched.name,
  };
}

// ---------------------------------------------------------------------------
// Ranking — known tier first (score desc), unknown tier last (registry order)
// ---------------------------------------------------------------------------

/**
 * A ranked provider entry. The order in the returned array is the
 * selection order PB-T4 walks.
 *
 * - Known-tier entries appear first, sorted by `score` descending.
 *   Ties break by registry order (`PROVIDER_IDS` by default, or the
 *   `registryOrder` option).
 * - Unknown-tier entries appear after every known entry, in registry
 *   order. They remain eligible as fallback.
 *
 * Optional fields are present only when meaningful: `score`/`category`
 * for known entries; `reason` for unknown entries.
 */
export interface RankedProvider {
  readonly provider: ProviderId;
  readonly authority: "known" | "unknown";
  readonly score?: number;
  readonly category?: string;
  readonly reason?: UnknownScoreReason;
}

/**
 * Rank candidate providers for a capability.
 *
 * Returns a new array (caller owns it). The ranking is deterministic
 * for identical inputs: same `state` + same `candidates` + same
 * `registryOrder` → byte-identical output order.
 *
 * Algorithm:
 *   1. Score each candidate via {@link scoreCapability}.
 *   2. Partition into known and unknown tiers.
 *   3. Sort known tier by score desc; break ties by registry order.
 *   4. Sort unknown tier by registry order only.
 *   5. Concatenate: known first, then unknown.
 *
 * The "5% known beats unknown" contract falls out of steps 3–5: every
 * known entry precedes every unknown entry regardless of score. A
 * known provider at 5% remaining still ranks above a non-authoritative
 * Brave/Exa provider, because Brave/Exa are in the unknown tier.
 *
 * Duplicate candidates are de-duplicated in first-occurrence order
 * before scoring (defensive — PB-T4 builds candidate lists, and a
 * duplicate would otherwise double-emit warnings).
 */
export function rankProvidersForCapability(
  state: QuotaState,
  capability: ProviderCapability,
  candidates: readonly ProviderId[],
  options: ScoreOptions & {
    /**
     * Stable registry order for tie-breaking. Defaults to
     * {@link PROVIDER_IDS} (the canonical production order
     * `[zai, minimax, tavily, exa, brave, firecrawl]`).
     */
    readonly registryOrder?: readonly ProviderId[];
  } = {},
): readonly RankedProvider[] {
  const registryOrder = options.registryOrder ?? PROVIDER_IDS;
  const orderRank = new Map<ProviderId, number>();
  for (let i = 0; i < registryOrder.length; i++) {
    orderRank.set(registryOrder[i], i);
  }
  // Providers absent from the supplied registryOrder sort after every
  // known entry, preserving first-occurrence order via a large offset.
  const unknownRank = registryOrder.length;

  // De-duplicate candidates (first occurrence wins) so a repeated
  // provider does not double-emit warnings or appear twice in output.
  const seen = new Set<ProviderId>();
  const unique: ProviderId[] = [];
  for (const c of candidates) {
    if (seen.has(c)) continue;
    seen.add(c);
    unique.push(c);
  }

  type Staged = {
    readonly provider: ProviderId;
    readonly score: CapabilityScore;
    readonly orderRank: number;
    readonly inputOrder: number;
  };
  const staged: Staged[] = unique.map((provider, idx) => ({
    provider,
    score: scoreCapability(state, provider, capability, options),
    orderRank: orderRank.get(provider) ?? unknownRank,
    inputOrder: idx,
  }));

  const known = staged.filter((s) => s.score.authority === "known");
  const unknown = staged.filter((s) => s.score.authority === "unknown");

  // Known tier: score desc, registry order, then input order (stable).
  known.sort((a, b) => {
    const sa = (a.score as { score: number }).score;
    const sb = (b.score as { score: number }).score;
    if (sb !== sa) return sb - sa;
    if (a.orderRank !== b.orderRank) return a.orderRank - b.orderRank;
    return a.inputOrder - b.inputOrder;
  });

  // Unknown tier: registry order, then input order (stable).
  unknown.sort((a, b) => {
    if (a.orderRank !== b.orderRank) return a.orderRank - b.orderRank;
    return a.inputOrder - b.inputOrder;
  });

  const toRanked = (s: Staged): RankedProvider => {
    if (s.score.authority === "known") {
      return {
        provider: s.provider,
        authority: "known",
        score: s.score.score,
        category: s.score.category,
      };
    }
    return {
      provider: s.provider,
      authority: "unknown",
      reason: s.score.reason,
    };
  };

  return [...known.map(toRanked), ...unknown.map(toRanked)];
}
