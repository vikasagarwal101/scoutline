/**
 * Web search command.
 *
 * P2-05: the command receives an injected SearchCapability and shared
 * execution dependencies instead of constructing a Provider client.
 * The command owns query splitting, parallel scheduling, normalized
 * merge, rank, occurrence, truncation, projection, notices, and
 * presentations; the Adapter owns credentials, transport, and Provider
 * field mapping. Count is applied AFTER normalization by shared
 * execution and never enters an Adapter request or cache identity.
 */

import type { CommandContext, CommandResult, DataCommandResult } from "../command-invocation.js";
import type {
  SearchCapability,
  SearchControls,
  SearchRequest,
  SearchSource,
  SearchTopic,
  SearchType,
} from "../capabilities/search.js";
import type { ResponseCache } from "../lib/cache.js";
import type { RetryPolicy } from "../lib/execution.js";
import { executeSearch } from "../lib/execution.js";
import { canonicalUrl } from "../lib/url.js";
import type { ProviderDescriptor, ProviderId } from "../providers/types.js";
import { formatSearchResultsPretty } from "../lib/tty.js";
import {
  ValidationError,
  UnsupportedOptionError,
  UnsupportedCapabilityError,
} from "../lib/errors.js";
import { redactCredentialString } from "../lib/redact.js";
import type { ConsumptionSink } from "../lib/consumption.js";
import { parseProviderId, parseProviderIds } from "../providers/selection.js";

type RecencyFilter = "oneDay" | "oneWeek" | "oneMonth" | "oneYear" | "noLimit";

export interface SearchOptions {
  count?: number;
  domain?: string;
  recency?: RecencyFilter;
  contentSize?: "medium" | "high";
  location?: "cn" | "us";
  topic?: SearchTopic;
  type?: SearchType;
  maxSummary?: number;
  fields?: string[];
  noCache?: boolean;
  merge?: boolean;
}

/**
 * Shared execution dependencies the search command consumes. The
 * Capability and cache/sleep/random are injected so tests run fully
 * offline; production wires the real Adapter from the selected Provider
 * and the default on-disk cache.
 */
export interface SearchExecutionDependencies {
  readonly capability: SearchCapability;
  readonly cache: ResponseCache;
  readonly sleep: (ms: number) => Promise<void>;
  readonly random: () => number;
  readonly retryPolicy?: RetryPolicy;
  /**
   * Optional consumption sink (usage-ledger DESIGN D7 — PB-T2 parity
   * with the fan-out executor and the other billable handlers). When
   * present, every sub-query's `executeSearch` emits one consumption
   * event per billable invoke attempt through it. When absent (the
   * default), no event is emitted and behavior is byte-for-byte
   * identical to before.
   */
  readonly consume?: ConsumptionSink;
  /** Timestamp source for consumption events; defaults to `Date.now`. */
  readonly now?: () => number;
}

interface FormattedResult {
  rank: number;
  title: string;
  url: string;
  summary: string;
  source?: string;
  date?: string;
  /** Set when merging multiple queries: how many sub-queries surfaced this URL. */
  occurrences?: number;
  /**
   * Provenance (fan-out only, DESIGN D3): distinct providers that
   * surfaced this URL, in first-encounter order. Omitted on the
   * single-provider path — SCHEMA.md.
   */
  mergedFrom?: ProviderId[];
}

function truncate(text: string | undefined, max?: number): string {
  if (!text) return "";
  if (!max || max <= 0 || text.length <= max) return text;
  return text.slice(0, max - 1).trimEnd() + "…";
}

function filterFields(result: FormattedResult, fields?: string[]): Partial<FormattedResult> {
  if (!fields || fields.length === 0) return result;
  const allowed = new Set(fields);
  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(result)) {
    if (allowed.has(key)) {
      filtered[key] = value;
    }
  }
  return filtered;
}

/**
 * Build Provider controls from command options. Every field is optional;
 * an Adapter that does not accept a control (MiniMax) rejects it inside
 * `validate` before any SDK access (FR-012).
 */
function buildControls(options: SearchOptions): SearchControls | undefined {
  const controls: SearchControls = {};
  if (options.domain) controls.domain = options.domain;
  if (options.recency) controls.recency = options.recency;
  if (options.contentSize) controls.contentSize = options.contentSize;
  if (options.location) controls.location = options.location;
  if (options.topic) controls.topic = options.topic;
  if (options.type) controls.type = options.type;
  return Object.keys(controls).length > 0 ? controls : undefined;
}

/**
 * One arm of a merge grid: a Provider's results split into sub-queries.
 * `provider` is absent on the single-provider `--merge` path (no
 * provenance is tracked there); the fan-out path always sets it.
 */
export interface MergeGridArm {
  provider?: ProviderId;
  results: FormattedResult[][];
}

export interface MergeResultsOptions {
  /** Emit mergedFrom provenance on every result (fan-out active). */
  emitMergedFrom?: boolean;
  /** Post-merge --count cap. Each arm was already asked for this count. */
  count?: number;
}

/**
 * Merge results from an (arm × sub-query) grid (DESIGN D3). Generalizes
 * the pre-fan-out sub-query merge with exactly one new key: dedupe by
 * `canonicalUrl(url)` (DESIGN D4) instead of the raw string. Ranking is
 * unchanged — (occurrence count desc, best position asc) — but
 * `occurrences` now counts across the whole arms × sub-queries grid.
 * First-writer-wins: the earlier arm's title/summary/url win a collision
 * (arm order is the tiebreak priority). Every URL accumulates
 * `mergedFrom` (distinct providers, first-encounter order) when
 * `emitMergedFrom` is set, and the merged list is sliced to `count`
 * post-merge. The single-provider `--merge` path and the fan-out path
 * share this one implementation.
 */
export function mergeResults(
  grid: MergeGridArm[],
  options: MergeResultsOptions = {},
): FormattedResult[] {
  const { emitMergedFrom = false, count } = options;
  const map = new Map<
    string,
    FormattedResult & { occurrences: number; bestPos: number; mergedFrom: ProviderId[] }
  >();
  for (const arm of grid) {
    for (const results of arm.results) {
      for (const r of results) {
        // canonicalUrl is the Map key only; the emitted url stays the
        // first writer's original string (DESIGN D3 "Identity").
        const key = canonicalUrl(r.url);
        const existing = map.get(key);
        if (existing) {
          existing.occurrences += 1;
          existing.bestPos = Math.min(existing.bestPos, r.rank);
          if (emitMergedFrom && arm.provider && !existing.mergedFrom.includes(arm.provider)) {
            existing.mergedFrom.push(arm.provider);
          }
        } else {
          map.set(key, {
            ...r,
            occurrences: 1,
            bestPos: r.rank,
            mergedFrom: emitMergedFrom && arm.provider ? [arm.provider] : [],
          });
        }
      }
    }
  }
  let merged = Array.from(map.values());
  merged.sort((a, b) => {
    if (b.occurrences !== a.occurrences) return b.occurrences - a.occurrences;
    return a.bestPos - b.bestPos;
  });
  // Post-merge --count slice (each arm was already asked for this count).
  if (count !== undefined) {
    merged = merged.slice(0, Math.max(0, count));
  }
  return merged.map((r, i) => {
    const { bestPos: _bp, ...rest } = r;
    void _bp;
    const rank = i + 1;
    if (!emitMergedFrom) {
      // Omit mergedFrom entirely on the single path (SCHEMA.md) so the
      // emitted objects stay byte-identical to the pre-fan-out merge.
      const { mergedFrom: _mf, ...restNoProvenance } = rest;
      void _mf;
      return { ...restNoProvenance, rank };
    }
    return { ...rest, rank };
  });
}

function renderTextFormat(
  results: FormattedResult[],
  mode: "compact" | "markdown" | "refs",
): string {
  if (results.length === 0) return "";
  const lines: string[] = [];
  for (const r of results) {
    const occBadge = r.occurrences && r.occurrences > 1 ? ` ×${r.occurrences}` : "";
    if (mode === "compact") {
      lines.push(`${r.title}${occBadge} — ${r.url}`);
    } else if (mode === "markdown") {
      lines.push(`${r.rank}. [${r.title}](${r.url})${occBadge}`);
      if (r.summary) lines.push(`   ${r.summary}`);
    } else if (mode === "refs") {
      lines.push(`[${r.rank}]${occBadge} ${r.title} — ${r.url}`);
    }
  }
  return lines.join("\n");
}

function buildPresentations(
  formattedResults: FormattedResult[],
): NonNullable<DataCommandResult["presentations"]> {
  return {
    compact: renderTextFormat(formattedResults, "compact"),
    markdown: renderTextFormat(formattedResults, "markdown"),
    refs: renderTextFormat(formattedResults, "refs"),
    tty: formatSearchResultsPretty(formattedResults),
  };
}

/** Format a normalized SearchSource[] into ranked FormattedResult[]. */
function formatSources(sources: readonly SearchSource[], maxSummary?: number): FormattedResult[] {
  return sources.map((s, i) => {
    const formatted: FormattedResult = {
      rank: i + 1,
      title: s.title,
      url: s.url,
      summary: truncate(s.summary, maxSummary),
    };
    if (s.source) formatted.source = s.source;
    if (s.date) formatted.date = s.date;
    return formatted;
  });
}

/**
 * Split a `--merge` query into sub-queries: split on unescaped `|` (a
 * literal pipe is escaped as `\|`), trim, and drop empty fragments. A
 * merge query with no non-empty fragments is a usage error. Shared by
 * the single-provider path and the fan-out executor — DESIGN D3's merge
 * grid is (arm × sub-query), so every arm runs every sub-query.
 */
function splitMergeSubQueries(query: string): string[] {
  const subQueries = query
    .split(/(?<!\\)\|/)
    .map((q) => q.replace(/\\\|/g, "|").trim())
    .filter((q) => q.length > 0);
  if (subQueries.length === 0) {
    throw new Error("--merge requires at least one non-empty query (split with '|')");
  }
  return subQueries;
}

export async function search(
  query: string,
  options: SearchOptions = {},
  deps: SearchExecutionDependencies,
  context?: CommandContext,
): Promise<CommandResult> {
  const { capability, cache, sleep, random, retryPolicy, consume, now } = deps;

  // Split query on `|` if --merge is set. Empty fragments are dropped.
  // A literal pipe in a single query can be escaped as `\|` (won't split).
  let subQueries: string[] = [query];
  if (options.merge) {
    subQueries = splitMergeSubQueries(query);
  }

  const isMerge = subQueries.length > 1;
  const controls = buildControls(options);
  // DESIGN D7: thread the optional consumption sink + clock through the
  // same conditional-spread shape the fan-out executor uses, so the
  // single-pin path bills exactly like a fan-out arm.
  const executionDeps = {
    cache,
    sleep,
    random,
    ...(consume !== undefined ? { consume } : {}),
    ...(now !== undefined ? { now } : {}),
  };
  // One executeSearch per sub-query. Each Adapter isolates its own
  // transport per invocation, so the command does not manage client
  // counts or close transports.
  const perQuerySources = await Promise.all(
    subQueries.map((q) => {
      const request: SearchRequest = controls ? { query: q, controls } : { query: q };
      return executeSearch(
        capability,
        request,
        {
          count: options.count,
          noCache: options.noCache,
          retryPolicy,
        },
        executionDeps,
      );
    }),
  );
  const perQueryFormatted: FormattedResult[][] = perQuerySources.map((sources) =>
    formatSources(sources, options.maxSummary),
  );

  // The single-provider --merge path and the fan-out path (Ticket 3)
  // share one merge implementation. The single path passes no provider
  // and no count, so its output is byte-identical to the pre-fan-out
  // merge (no mergedFrom field, no post-merge slice).
  const formattedResults: FormattedResult[] = isMerge
    ? mergeResults([{ results: perQueryFormatted }])
    : perQueryFormatted[0] || [];

  if (isMerge && context) {
    context.notice(
      `ℹ️  merged ${subQueries.length} queries → ${formattedResults.length} unique results`,
    );
  }

  const presentations = buildPresentations(formattedResults);

  const data =
    options.fields && options.fields.length > 0
      ? formattedResults.map((r) => filterFields(r, options.fields))
      : formattedResults;

  return { kind: "data", data, presentations };
}

// ---------------------------------------------------------------------------
// Fan-out activation resolver (Ticket 3 — DESIGN D1, pure)
//
// Pure, deterministic resolution of the activation tier + ordered arm list.
// Called once at the top of `handleSearch`. Decides between the existing
// single-pin path (Tier 2) and the new multi-provider fan-out path
// (Tiers 1, 3, 4 default). Untrusted tier boundaries are pinned by
// ADR-0004: explicit raw has the highest precedence; fanout=true is the
// ambient switch; absence falls through to today's single-pinned path
// unchanged. The resolver never performs I/O, reads credentials, or
// constructs an Adapter.
// ---------------------------------------------------------------------------

/**
 * Resolved activation plan. `mode` is the dispatcher hinge; `arms` is
 * the ordered Provider list to execute (already expanded and
 * filtered — never the `"all"` sentinel; the resolver owns the
 * expansion against its injected descriptors). `suppress` is the
 * human-readable reason the resolver ignored fan-out (e.g. "explicit
 * pin: fan-out ignored"); emitted on the single-pin path so the user
 * understands why fan-out did not engage.
 */
export interface FanoutPlan {
  readonly mode: "single" | "fanout";
  readonly arms: ProviderId[];
  readonly suppress?: string;
}

/**
 * Options for {@link resolveFanoutPlan}. The resolver is pure: every
 * input is an injected value, no I/O, no environment reads. `configFanout`
 * is the lone scalar read from the user config (Ticket 4 owns the
 * registry row); `routing` is the typed routing table already in
 * `HandlerDependencies`. `descriptors` is the live provider registry —
 * the resolver uses it for `isConfigured(env)` + `capabilities()`
 * filtering (the same gate `resolveEffectiveProvider` uses) so the
 * arm list the executor sees is the same list the executor would
 * otherwise walk, giving the dispatcher a single source of truth.
 */
export interface ResolveFanoutPlanOptions {
  /** Raw `--provider` value (or undefined). Empty string is treated as absent. */
  readonly explicitProviderRaw: string | undefined;
  /** The resolved env the handler runs under (env + file-configured keys). */
  readonly env: NodeJS.ProcessEnv;
  /** Whether `fanout` is enabled in the active config. */
  readonly configFanout: boolean;
  /** Resolved per-capability routing table (routing-table plan). */
  readonly routing?: Readonly<Record<string, readonly ProviderId[]>>;
  /** Live provider registry; the resolver filters by capability "search". */
  readonly descriptors: readonly ProviderDescriptor[];
}

/**
 * Configured ∩ advertising descriptors for `search`, in the registry
 * order the descriptors were injected (production passes the stable
 * `PROVIDER_IDS` order). Shared by the `"all"` expansion and the
 * tier-3 default fan-out arms.
 */
function eligibleSearchArms(
  descriptors: readonly ProviderDescriptor[],
  env: NodeJS.ProcessEnv,
): ProviderId[] {
  const arms: ProviderId[] = [];
  for (const descriptor of descriptors) {
    if (!descriptor.isConfigured(env, "search")) continue;
    if (!descriptor.capabilities().has("search")) continue;
    arms.push(descriptor.id);
  }
  return arms;
}

/**
 * Resolve the activation plan (D1). Tiers in precedence order:
 *
 *   1. **Explicit raw** (D1.1): a comma list or `"all"` → fanout
 *      (`"all"` expands to configured ∩ advertising in registry
 *      order); a single id → single (with suppress when
 *      `configFanout=true`).
 *   2. **SCOUTLINE_PROVIDER env** (D1.2): a pin → single (suppress
 *      when `configFanout=true`).
 *   3. **`configFanout=true` with no pin** (D1.3): fanout; arms =
 *      `routing.search` filtered/deduped (if set), else configured ∩
 *      advertising in registry order.
 *   4. **Default** (D1.4): single; arm = first configured ∩
 *      advertising in registry order (informational — the dispatcher
 *      still consults `resolveEffectiveProvider` for quota ranking).
 *
 * The resolver exposes its decision only through the returned
 * `FanoutPlan`; the dispatcher hinges on `mode`. The truth table is
 * pinned by Ticket 3 tests.
 */
export function resolveFanoutPlan(options: ResolveFanoutPlanOptions): FanoutPlan {
  const { explicitProviderRaw, env, configFanout, routing, descriptors } = options;

  // Tier 1: explicit raw. parseProviderIds does the heavy lifting:
  // comma-list → IDs, "all" → sentinel, single id → one-element
  // array, garbage → null. We then translate each result into the
  // dispatcher-facing mode. Unknown ids are left to the existing
  // `resolveProviderId` path to surface VALIDATION_ERROR.
  if (explicitProviderRaw !== undefined && explicitProviderRaw.trim().length > 0) {
    const parsed = parseProviderIds(explicitProviderRaw);
    if (parsed === "all") {
      // `"all"` expands NOW so the executor never sees the sentinel.
      return { mode: "fanout", arms: eligibleSearchArms(descriptors, env) };
    }
    if (Array.isArray(parsed)) {
      if (parsed.length > 1) {
        return { mode: "fanout", arms: parsed };
      }
      // Single id → single mode. Suppress notice when fanout=true so the
      // user knows the explicit pin precedence overrode the switch.
      const arm = parsed[0] as ProviderId;
      if (configFanout) {
        return { mode: "single", arms: [arm], suppress: `explicit pin: fan-out ignored` };
      }
      return { mode: "single", arms: [arm] };
    }
    // parsed === null: a non-empty explicit value that names no valid
    // id, comma list, or the "all" sentinel. Surface the typed
    // VALIDATION_ERROR HERE (parseProviderId owns the CLI's
    // provider-error wording and throws for every input this parse
    // rejects) — falling through would let tier 3 (fanout=true)
    // silently convert the typo'd pin into a fan-out activation and
    // the error would never surface (review fix, PR #36).
    parseProviderId(explicitProviderRaw);
    // Unreachable: parseProviderId throws for every null-parse input.
    // The return keeps the branch total should the parsers diverge.
    return { mode: "single", arms: [] };
  }

  // Tier 2: SCOUTLINE_PROVIDER env pin → single.
  const envProvider = env.SCOUTLINE_PROVIDER;
  if (envProvider !== undefined && envProvider.trim().length > 0) {
    const arm = envProvider.trim().toLowerCase() as ProviderId;
    if (configFanout) {
      return { mode: "single", arms: [arm], suppress: `SCOUTLINE_PROVIDER pin: fan-out ignored` };
    }
    return { mode: "single", arms: [arm] };
  }

  // Tier 3: fanout=true with no pin → fanout; arms = routing.search
  // (filtered/deduped) when set, else configured ∩ advertising in
  // registry order.
  if (configFanout) {
    const routed = routing?.["search"];
    if (routed !== undefined && routed.length > 0) {
      // Filter against configured∩advertising while preserving the
      // routed order; dedupe by first encounter (the routing list is
      // a user-supplied preference, so first-write wins on the user's
      // intent).
      const eligible = new Set(eligibleSearchArms(descriptors, env));
      const arms: ProviderId[] = [];
      const seen = new Set<string>();
      for (const id of routed) {
        if (seen.has(id)) continue;
        seen.add(id);
        if (!eligible.has(id)) continue;
        arms.push(id);
      }
      return { mode: "fanout", arms };
    }
    return { mode: "fanout", arms: eligibleSearchArms(descriptors, env) };
  }

  // Tier 4: default single path. The dispatcher still consults
  // `resolveEffectiveProvider` for quota-ranked first-pick; the arm
  // reported here is the informational first-eligible in registry
  // order.
  const firstEligible = eligibleSearchArms(descriptors, env);
  return { mode: "single", arms: firstEligible.slice(0, 1) };
}

// ---------------------------------------------------------------------------
// Fan-out executor (Ticket 3 — DESIGN D2, D5, D6)
//
// Parallel per-arm execution with one client per arm. Arms are pinned
// (no `executeWithFallback` per arm, ADR-0004 §1) and the per-arm
// pipeline is the same `executeSearch` we use for the single path,
// so each arm reads/writes its own provider-partitioned cache key
// (`v2.search.<provider>…`). Settled wrapper per arm: an `UnsupportedOptionError`
// is an arm drop (never a whole-invocation failure); any other error
// counts as a failure. ≥1 arm ok → merged output, exit 0; all arms
// failed → throw the last arm's typed error through the standard
// boundary (exit per its code); zero arms → `VALIDATION_ERROR`.
// ---------------------------------------------------------------------------

/**
 * Options for {@link executeFanoutPlan}. The executor owns the
 * per-arm Lifecycle (descriptor.create → adapter → executeSearch →
 * close) and the merged error envelope. `query` is the resolved raw
 * query; when `searchOptions.merge` is set the executor splits it on
 * unescaped `|` and runs EVERY sub-query on EVERY arm — DESIGN D3's
 * (arm × sub-query) merge grid.
 *
 * `dependencies` is a subset of {@link SearchExecutionDependencies}:
 * the per-arm capability is constructed internally by the executor
 * (one per arm), so the caller does not supply a single shared
 * capability. Only the shared cache/policy seams cross arms.
 */
export interface FanoutExecutionDependencies {
  readonly cache: ResponseCache;
  readonly sleep: (ms: number) => Promise<void>;
  readonly random: () => number;
  readonly retryPolicy?: RetryPolicy;
  /**
   * Optional consumption sink (PB-T2 parity with the other billable
   * seams). When present, every arm's `executeSearch` emits one
   * consumption event per billable invoke attempt through it — fan-out
   * arms must not silently skip local quota accounting (review fix,
   * PR #36).
   */
  readonly consume?: ConsumptionSink;
  /** Timestamp source for consumption events; defaults to `Date.now`. */
  readonly now?: () => number;
}

export interface FanoutExecutionOptions {
  readonly descriptors: readonly ProviderDescriptor[];
  readonly env: NodeJS.ProcessEnv;
  readonly query: string;
  readonly searchOptions: SearchOptions;
  readonly dependencies: FanoutExecutionDependencies;
  readonly secrets?: string[];
}

interface FanoutArmSuccess {
  readonly arm: ProviderId;
  /** One FormattedResult[] per sub-query (DESIGN D3's grid column). */
  readonly results: FormattedResult[][];
}

/**
 * Run a single arm: create the adapter, run one executeSearch PER
 * SUB-QUERY, and format the normalized sources into one
 * FormattedResult[] per sub-query. The arm owns its transport per
 * call (the one-client-per-query pattern unconditionally — each
 * executeSearch isolates its client exactly like the single-provider
 * `--merge` sub-queries in `search`).
 */
async function runFanoutArm(
  armId: ProviderId,
  subQueries: readonly string[],
  options: FanoutExecutionOptions,
): Promise<FormattedResult[][]> {
  const descriptor = options.descriptors.find((d) => d.id === armId);
  if (!descriptor) {
    // Should never happen — the resolver already filtered — but a
    // surface error here is safer than a bare undefined deref.
    throw new ValidationError(
      `Unknown provider "${armId}" in fan-out plan.`,
      "Re-run with a configured provider.",
    );
  }
  const adapter = descriptor.create({ env: options.env });
  const capability = adapter.search as SearchCapability | undefined;
  if (!capability) {
    throw new UnsupportedCapabilityError(armId, "search");
  }
  const controls = buildControls(options.searchOptions);
  // One executeSearch per (arm × sub-query): sub-queries run in
  // parallel inside the arm (same scheduling as the single-provider
  // `--merge` path) and each call owns its transport. The consumption
  // sink + clock are threaded so every billable call records.
  const perSubQuerySources = await Promise.all(
    subQueries.map((q) => {
      const request: SearchRequest = controls ? { query: q, controls } : { query: q };
      return executeSearch(
        capability,
        request,
        {
          count: options.searchOptions.count,
          noCache: options.searchOptions.noCache,
          retryPolicy: options.dependencies.retryPolicy,
        },
        {
          cache: options.dependencies.cache,
          sleep: options.dependencies.sleep,
          random: options.dependencies.random,
          ...(options.dependencies.consume !== undefined
            ? { consume: options.dependencies.consume }
            : {}),
          ...(options.dependencies.now !== undefined ? { now: options.dependencies.now } : {}),
        },
      );
    }),
  );
  return perSubQuerySources.map((sources) =>
    formatSources(sources, options.searchOptions.maxSummary),
  );
}

/**
 * Build a single arm's notice line (D5). Every failed arm is a "drop"
 * in the D6 sense ("drops as notices + data"): an
 * `UnsupportedOptionError` names the rejected control; any other
 * error names its code and a redacted message. The message is
 * redacted via `redactCredentialString` so a transport error that
 * echoes a credential never reaches stderr verbatim.
 */
function armNotice(armId: ProviderId, error: unknown, secrets: readonly string[]): string {
  if (error instanceof UnsupportedOptionError) {
    return `arm ${armId} dropped: UNSUPPORTED_OPTION (${error.option})`;
  }
  const code = (error as { code?: string })?.code ?? "UNKNOWN_ERROR";
  const rawMessage = (error as { message?: string })?.message ?? String(error);
  const safeMessage = redactCredentialString(rawMessage, [...secrets]);
  return `arm ${armId} dropped: ${code}: ${safeMessage}`;
}

/**
 * Execute the fan-out plan: parallel per-arm search, settled wrapper,
 * per-arm notices, D5/D6 exit policy, combined summary notice. The
 * single-pin path is NOT routed through this executor (Tier 2 / Tier 4
 * stay verbatim through `executeWithFallback`); the executor asserts
 * `mode === "fanout"` on entry so a misuse throws loudly.
 */
export async function executeFanoutPlan(
  plan: FanoutPlan,
  options: FanoutExecutionOptions,
  context?: CommandContext,
): Promise<CommandResult> {
  if (plan.mode !== "fanout") {
    throw new ValidationError(
      "executeFanoutPlan only accepts mode='fanout'.",
      "Use the single-pin path for single mode.",
    );
  }
  const arms = plan.arms;
  if (arms.length === 0) {
    // D6: zero arms resolved → VALIDATION_ERROR naming the configured
    // set and the registry so the operator sees both halves of the
    // mismatch (what could serve vs. what exists).
    const configuredSet =
      options.descriptors
        .filter((d) => d.isConfigured(options.env, "search") && d.capabilities().has("search"))
        .map((d) => d.id)
        .join(", ") || "(none)";
    const registrySet = options.descriptors.map((d) => d.id).join(", ") || "(none)";
    throw new ValidationError(
      `Fan-out produced no arms; configured search providers: ${configuredSet} (registry: ${registrySet}).`,
      "Configure at least one provider's API key, or unset 'fanout' / routing.search.",
    );
  }

  // Sub-query split (DESIGN D3: the merge grid is arms × sub-queries).
  // `--merge` composes with fan-out — every arm runs every sub-query
  // (review fix, PR #36); without it the raw query is one sub-query.
  const subQueries = options.searchOptions.merge
    ? splitMergeSubQueries(options.query)
    : [options.query];

  // Run every arm in parallel. Promise.allSettled ensures one arm's
  // failure does not abort the rest; the per-arm pipeline is isolated
  // (one client per arm, no fallback chain).
  const settled = await Promise.allSettled(
    arms.map((armId) =>
      runFanoutArm(armId, subQueries, options).then(
        (results): FanoutArmSuccess => ({ arm: armId, results }),
      ),
    ),
  );

  const successes: FanoutArmSuccess[] = [];
  const failures: { arm: ProviderId; error: unknown }[] = [];
  for (let i = 0; i < settled.length; i++) {
    const entry = settled[i];
    const armId = arms[i]!;
    if (entry !== undefined && entry.status === "fulfilled") {
      successes.push(entry.value);
    } else if (entry !== undefined) {
      failures.push({ arm: armId, error: entry.reason });
    }
  }

  // Per-arm notices (D5). Every non-success arm surfaces here as a
  // drop; UnsupportedOptionError carries the rejected control name.
  if (context) {
    for (const { arm, error } of failures) {
      context.notice(armNotice(arm, error, options.secrets ?? []));
    }
  }

  // D6: all-fail → throw the last arm's typed error through the boundary.
  if (successes.length === 0) {
    const last = failures[failures.length - 1];
    if (last) throw last.error;
    throw new Error("Fan-out produced no successes and no failures; plan was empty after filtering.");
  }

  // Build the (arm × sub-query) grid for mergeResults. Each success
  // carries one FormattedResult[] per sub-query; occurrence counting
  // and mergedFrom accumulation span the whole grid (D3).
  const grid: MergeGridArm[] = successes.map((s) => ({
    provider: s.arm,
    results: s.results,
  }));
  const merged: FormattedResult[] = mergeResults(grid, {
    emitMergedFrom: true,
    count: options.searchOptions.count,
  });

  // Summary notice (D5). K = total raw results across the whole
  // arms × sub-queries grid (the post-truncate counts the executor
  // collected); M = merged unique count. An arm with 0 results
  // contributes 0 to K — the notice still names the arm so the
  // operator sees the full set.
  const totalRaw = successes.reduce(
    (sum, s) => sum + s.results.reduce((n, list) => n + list.length, 0),
    0,
  );
  if (context) {
    const armList = arms.join(", ");
    context.notice(
      `fanned out to ${arms.length} providers (${armList}) → ${merged.length} unique of ${totalRaw} results`,
    );
  }

  const presentations = buildPresentations(merged);
  const data =
    options.searchOptions.fields && options.searchOptions.fields.length > 0
      ? merged.map((r) => filterFields(r, options.searchOptions.fields))
      : merged;
  return { kind: "data", data, presentations };
}

// Help text
export const SEARCH_HELP = `
Search Command - Real-time web search (Z.AI, MiniMax, Tavily, Exa, or Brave)

Usage: scoutline search <query> [options]

Provider selection (precedence: explicit flag, then SCOUTLINE_PROVIDER, then zai):
  --provider <zai|minimax|tavily|exa|brave|firecrawl|parallel|perplexity|jina>   Select the search provider (default: zai)
  SCOUTLINE_PROVIDER=<id>                 Fallback when --provider is not passed

Multi-provider fan-out — activation tiers (highest precedence first):
  1. --provider <tavily,exa,...> or --provider all
        Fan-out on the listed providers; \`all\` expands to every
        configured provider that advertises search, registry order.
  2. A single --provider id, or SCOUTLINE_PROVIDER set
        Single provider only — an explicit pin; fan-out is ignored.
  3. \`scoutline config set fanout true\` (with no pin)
        Fan-out on routing.search when set, else every configured
        search provider, registry order.
  4. No pin and fanout off (the default)
        Single provider via the standard selection order.

  Cost (when fan-out is active):
  every search will bill ALL configured search providers — N arms = N billable calls.
  Disable with \`scoutline config set fanout false\`.

  Merging: arms run in parallel (one client each, pinned — no per-arm
  fallback) and are deduped by canonical URL identity: scheme and host
  lowercased; :80/:443 ports, fragments, and trailing slashes stripped;
  utm_* and fbclid parameters removed (names are matched after
  percent-decoding, so ?%66bclid=x collapses with ?fbclid=x; the raw
  path — including dot segments — and userinfo are preserved verbatim).
  The canonical form is a dedupe identity ONLY — the emitted url,
  title, and summary are the first arm's originals. The first arm wins
  metadata collisions; \`occurrences\` counts across all arms; the
  merged list is sliced to --count after merging; \`--merge\` composes
  with fan-out: every arm runs every sub-query and occurrences span
  the arms × sub-queries grid. A failed arm is dropped with a stderr
  notice; if every arm fails, the last arm's error surfaces.

Note: support for the optional controls below varies by provider AND by
control — a control accepted by one provider may be rejected
(UNSUPPORTED_OPTION) by another before invocation. Run
\`scoutline doctor\` for the live per-provider support matrix rather than
relying on a fixed list here.

Options:
  --topic <t>         Search topic hint (all providers): general, news, finance
                      (default: general). Z.AI/MiniMax append a keyword to the
                      query; Tavily passes it natively; Exa maps it to a
                      category; Brave uses a news endpoint for \`news\`.
  --type <video>      Content-type axis; supported by Brave (\`video\`).
                      Mutually exclusive with --topic.
  --domain <d>        Limit to specific domain (provider support varies; e.g., github.com)
  --recency <r>       Filter by time (provider support varies): oneDay, oneWeek, oneMonth, oneYear, noLimit
  --content-size <s>  Depth/size. medium = default. high maps per provider:
                      Z.AI content_size; Tavily search_depth=advanced; Exa accepted;
                      Brave → LLM Context (extracted passages); MiniMax rejected
                      (UNSUPPORTED_OPTION).
  --location <l>      Location hint (provider support varies): cn, us
  --count <n>         Limit number of results (applied after normalization)
  --max-summary <n>   Truncate each result summary to <n> chars (JSON modes only)
  --fields <a,b,c>    Field allowlist for JSON output (e.g. title,url)
  --merge             Treat the query as multiple sub-queries split on '|'.
                      Runs them in parallel, dedupes by URL, ranks by how many
                      sub-queries surfaced each result. Escapes: '\\|' for literal pipe.

Output formats (--output-format / -O):
  data       JSON array (default, token-efficient)
  json       Envelope-wrapped JSON {success, data, timestamp}
  pretty     Pretty-printed json
  compact    "title — url" per line (no summaries)
  markdown   Numbered markdown list with summaries
  refs       "[N] title — url" per line (citation style)

Examples:
  scoutline search "React 19 new features"
  scoutline search "Node.js security" --domain nodejs.org
  scoutline --provider minimax search "AI news"
  SCOUTLINE_PROVIDER=minimax scoutline search "AI news"
  scoutline --provider tavily search "AI funding rounds" --topic news
  scoutline search "x" -O compact                    # ultra-compact
  scoutline search "x" -O markdown --max-summary 80  # chat-ready
  scoutline search "x" --fields title,url            # field-filtered JSON
  scoutline search --merge "rust async|rust tokio|rust runtime"  # multi-query merge

Default JSON shape:
  [
    {
      "rank": 1,
      "title": "Page title",
      "url": "https://...",
      "summary": "Page summary",
      "source": "example.com",
      "date": "2024-01-15",
      "occurrences": 2   // only present with --merge when >1
      "mergedFrom": ["tavily", "exa"]   // fan-out only: arms that surfaced this result
    }
  ]
`.trim();
