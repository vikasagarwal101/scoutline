/**
 * Quota command — Provider-neutral quota dashboard (P4-03, ADR-0001).
 *
 * The command is presentation-only: it receives a dashboard builder
 * through injected dependencies and wraps the resulting
 * {@link QuotaDashboard} as base data with a TTY presentation override.
 * Provider resolution, capability invocation, settled collection, and
 * failure redaction live in {@link buildQuotaDashboard} so the command
 * never imports a Provider monitor client or maps a Provider response.
 *
 * The DEFAULT is multi-Provider (every configured Provider with a quota
 * Capability). Single-Provider mode is selected only when a Provider is
 * explicitly pinned (--provider or SCOUTLINE_PROVIDER); --all-providers
 * forces the multi-Provider default even under a pin.
 *
 * Single-Provider mode propagates quota failures through the ordinary
 * error path (thrown → invokeCommand). Multi-Provider mode uses settled
 * collection, emits successful and failed entries, and yields exit 1
 * when any configured Provider fails.
 */

import type { CommandResult } from "../command-invocation.js";
import type {
  ProviderQuotaFailure,
  ProviderQuotaNone,
  ProviderQuotaSuccess,
  QuotaCapability,
  QuotaDashboard,
  QuotaSourceLabel,
} from "../capabilities/quota.js";
import { quotaFailureFromError } from "../capabilities/quota.js";
import { executeProviderOperation } from "../lib/execution.js";
import { ConfigurationError, UnsupportedCapabilityError } from "../lib/errors.js";
import type { ProviderDescriptor, ProviderId } from "../providers/types.js";
import { getProviderDescriptor } from "../providers/selection.js";
import { redactSecrets, configuredSecrets, redactCredentialString } from "../lib/redact.js";
import { formatQuotaDashboard } from "../lib/tty.js";
import {
  DEFAULT_QUOTA_STALE_THRESHOLD_MS,
  isQuotaSnapshotStale,
  type ProviderQuotaSnapshot,
  type QuotaState,
  type QuotaStore,
} from "../lib/quota-store.js";

// ---------------------------------------------------------------------------
// Dashboard builder
// ---------------------------------------------------------------------------

export interface QuotaDashboardDependencies {
  readonly allProviders: boolean;
  readonly effectiveProvider: ProviderId;
  readonly descriptors: readonly ProviderDescriptor[];
  readonly env: NodeJS.ProcessEnv;
  readonly sleep: (ms: number) => Promise<void>;
  readonly random: () => number;
  /**
   * Optional quota snapshot (PB-T5 — Plan B). When supplied, the
   * dashboard reads each configured descriptor's snapshot entry first
   * and labels the row's source/freshness via {@link QuotaSourceLabel};
   * a stale or missing entry falls back to a live probe (the fallback's
   * refresh is awaited-write-through when `quotaStore` is supplied).
   * When omitted, every configured descriptor is live-probed
   * byte-for-byte (pre-PB-T5 behavior) and no `quotaSource` field is
   * attached.
   */
  readonly quotaSnapshot?: QuotaState;
  /**
   * Optional store for live-probe write-through (PB-T5). When supplied
   * alongside `quotaSnapshot`, a successful live-probe fallback is
   * persisted via `writeObserved(providerId, { observedAt, categories })`
   * before the dashboard returns. When omitted (tests), the live-probe
   * result is returned but NOT persisted. Never consulted when
   * `quotaSnapshot` is absent.
   */
  readonly quotaStore?: QuotaStore;
  /**
   * Optional clock for freshness evaluation. Defaults to `Date.now`.
   * Used only when `quotaSnapshot` is supplied.
   */
  readonly now?: () => number;
  /**
   * Optional staleness threshold in milliseconds. Defaults to
   * {@link DEFAULT_QUOTA_STALE_THRESHOLD_MS} (10 min — Tavily's
   * 10/10min key limit is the floor).
   */
  readonly thresholdMs?: number;
}

interface AdapterWithQuota {
  readonly quota?: QuotaCapability;
}

/**
 * Invoke one Provider's quota Capability through shared execution. The
 * Adapter transport performs a single attempt; the retry policy lives
 * in `executeProviderOperation("quota", ...)`. Quota never uses the
 * response cache.
 */
async function invokeProviderQuota(
  descriptor: ProviderDescriptor,
  env: NodeJS.ProcessEnv,
  sleep: (ms: number) => Promise<void>,
  random: () => number,
): Promise<ProviderQuotaSuccess> {
  const adapter = descriptor.create({ env }) as AdapterWithQuota;
  const capability = adapter.quota;
  if (!capability) {
    throw new UnsupportedCapabilityError(descriptor.id, "quota");
  }
  return executeProviderOperation("quota", () => capability.invoke(), { sleep, random });
}

/**
 * Build a {@link QuotaSourceLabel} for a snapshot row. `authoritative`
 * is computed solely from `observedAt` against `thresholdMs`; the
 * snapshot's `locallyUpdatedAt` is intentionally NEVER consulted (it
 * advances on local consumption, never resetting the ground-truth
 * staleness clock — see PB-T1's `ProviderQuotaSnapshot` doc).
 */
function snapshotSourceLabel(
  snapshot: ProviderQuotaSnapshot,
  now: number,
  thresholdMs: number,
): QuotaSourceLabel {
  return {
    source: "snapshot",
    observedAt: snapshot.observedAt,
    authoritative: !isQuotaSnapshotStale(snapshot, now, thresholdMs),
  };
}

/**
 * Resolve a single configured Provider's quota row against the snapshot
 * (PB-T5). Resolution order, fully snapshot-aware:
 *
 *   1. **No `quota` capability (Exa)** — emit a `ProviderQuotaNone`
 *      row with ZERO adapter/transport calls. Only valid in
 *      all-provider mode; single-provider mode throws
 *      `UnsupportedCapabilityError` at the caller.
 *   2. **Snapshot path on** — read the snapshot entry:
 *        - fresh → return a `ProviderQuotaSuccess` carrying the
 *          snapshot's categories verbatim + a `quotaSource` label of
 *          `{source:"snapshot", authoritative:true}`;
 *        - missing/stale → fall through to step 3.
 *   3. **Live probe** — invoke the capability through shared execution;
 *      attach `quotaSource: {source:"live", authoritative:true}`. When
 *      `quotaStore` is supplied, await `writeObserved` so the next
 *      dashboard sees a fresh snapshot.
 *
 * Failures on the live probe propagate (single-provider mode throws;
 * all-provider mode is caught by the caller and normalized). The
 * `locallyUpdatedAt` field of any prior snapshot is preserved by
 * `writeObserved` (PB-T1's contract).
 */
async function resolveQuotaRow(
  descriptor: ProviderDescriptor,
  deps: QuotaDashboardDependencies,
  secrets: string[],
  snapshotEnabled: boolean,
  now: number,
  thresholdMs: number,
): Promise<ProviderQuotaSuccess | ProviderQuotaFailure | ProviderQuotaNone> {
  // Step 1 — Exa and any descriptor without `quota`. Zero transport.
  // ONLY emitted in all-provider mode — a single-provider pin to a
  // no-quota Provider is a user error and must throw
  // `UnsupportedCapabilityError` (the user explicitly asked for one
  // Provider's quota; a no-signal row would hide the user error).
  if (deps.allProviders && !descriptor.capabilities().has("quota")) {
    return { provider: descriptor.id, status: "none", reason: "no-capability" };
  }

  // Step 2 — snapshot path. Fresh snapshots short-circuit the transport.
  // The snapshot stores categories only (PB-T1's contract); provider-
  // authored `warnings` (e.g. Brave's rate-limit caveat) are NOT
  // carried through the snapshot — they surface only when a live
  // probe runs (stale/missing). Extending the snapshot schema to
  // carry warnings is out of scope for PB-T5 (PB-T1 owns the schema).
  if (snapshotEnabled && deps.quotaSnapshot) {
    const snapshot = deps.quotaSnapshot.quota[descriptor.id];
    if (snapshot && !isQuotaSnapshotStale(snapshot, now, thresholdMs)) {
      // Carry the categories verbatim (PB-T1's contract: the snapshot
      // stores the LIVE `QuotaCategory[]` shape). The freshness label
      // is computed solely from `observedAt`; `locallyUpdatedAt` is
      // intentionally NEVER consulted (it advances on local
      // consumption, never resetting the ground-truth clock).
      return {
        provider: descriptor.id,
        status: "ok",
        categories: [...snapshot.categories],
        quotaSource: snapshotSourceLabel(snapshot, now, thresholdMs),
      };
    }
    // Stale/missing → fall through to live probe.
  }

  // Step 3 — live probe (snapshot disabled, stale, missing, or corrupt).
  try {
    const success = await invokeProviderQuota(descriptor, deps.env, deps.sleep, deps.random);
    // Awaited write-through so the next dashboard reflects fresh data.
    // Only attempted when the snapshot path is enabled (pre-PB-T5
    // callers that did not inject a snapshot have no store contract
    // either — write-through would surprise them).
    if (snapshotEnabled && deps.quotaStore) {
      try {
        await deps.quotaStore.writeObserved(descriptor.id, {
          observedAt: now,
          categories: success.categories,
        });
      } catch {
        // Best-effort: a store write failure does not turn a
        // successful live probe into a dashboard failure. The
        // snapshot stays stale; the next due-refresh retries.
        // The store's own warning sink emits the stderr notice.
      }
    }
    // Attach the `quotaSource` label ONLY when the snapshot path is
    // enabled. A pre-PB-T5 caller (no `quotaSnapshot` injected) gets
    // byte-for-byte the previous behavior — no `quotaSource` field,
    // matching the documented backward-compatibility contract.
    return snapshotEnabled
      ? ({
          ...success,
          // `source: "live"` is always authoritative (just observed).
          quotaSource: { source: "live", observedAt: now, authoritative: true },
        } satisfies ProviderQuotaSuccess)
      : success;
  } catch (error) {
    // Single-provider mode: re-throw (preserve the pre-PB-T5 ordinary
    // error path). All-provider mode: the caller wraps the row as a
    // redacted failure.
    if (!deps.allProviders) throw error;
    return redactSecrets(
      quotaFailureFromError(descriptor.id, error),
      secrets,
    ) as ProviderQuotaFailure;
  }
}

/**
 * Default-mode dashboard. Resolves the effective Provider, requires it
 * to be configured (ConfigurationError, exit 3, before transport), then
 * resolves its quota row. Under a pin to a Provider that does not
 * advertise `quota`, throws `UnsupportedCapabilityError` (the user
 * explicitly asked for one Provider's quota — a no-signal row would
 * hide the user error). Failures propagate through the ordinary error
 * path.
 *
 * The gate stays on GLOBAL configuration (deliberate — GitHub #49): a
 * pin is an explicit per-Provider request, so a keyless Jina pin is
 * allowed through this gate and fails inside the capability with its
 * own ConfigurationError ("Jina AI quota requires JINA_API_KEY... Set
 * JINA_API_KEY to enable Jina quota reporting.") — actionable help the
 * generic gate message cannot offer, at the same exit 3. Making this
 * gate capability-aware would only swap that help for a blander error.
 */
async function buildDefaultDashboard(deps: QuotaDashboardDependencies): Promise<QuotaDashboard> {
  const descriptor = getProviderDescriptor(deps.effectiveProvider, deps.descriptors);
  if (!descriptor.isConfigured(deps.env)) {
    throw new ConfigurationError(
      `Provider "${deps.effectiveProvider}" is not configured. Set its API key (Z_AI_API_KEY, MINIMAX_API_KEY, TAVILY_API_KEY, or BRAVE_SEARCH_API_KEY).`,
    );
  }
  const now = (deps.now ?? Date.now)();
  const thresholdMs = deps.thresholdMs ?? DEFAULT_QUOTA_STALE_THRESHOLD_MS;
  const snapshotEnabled = deps.quotaSnapshot !== undefined;
  const row = await resolveQuotaRow(descriptor, deps, [], snapshotEnabled, now, thresholdMs);
  return {
    schemaVersion: 1,
    effectiveProvider: deps.effectiveProvider,
    providers: [row],
  };
}

/**
 * All-provider dashboard. For every Provider configured FOR QUOTA in
 * static registry order: resolve its row via {@link resolveQuotaRow},
 * which honors the snapshot path, emits a `ProviderQuotaNone` row for
 * descriptors without `quota` (Exa), and falls back to a live probe
 * when the snapshot is stale/missing/corrupt. Settled collection is
 * preserved: a configured Provider's failure is normalized and
 * recursively redacted before joining the dashboard, and the command
 * exits 1 when any configured Provider fails. No configured Provider
 * is a configuration failure, not an empty success.
 *
 * The filter is CAPABILITY-AWARE (GitHub #49): `isConfigured(env,
 * "quota")` excludes a Provider that can serve some capabilities
 * keylessly but requires a key for quota (Jina — Reader is keyless,
 * the quota probe uses Search). Filtering on global configuration
 * alone dragged keyless Jina into every dashboard and periodic
 * refresh, where its quota capability can only throw
 * ConfigurationError. Providers whose `isConfigured` ignores the
 * capability argument (Z.AI, MiniMax, Tavily, Brave, Exa) are
 * unaffected; Exa's no-signal row is driven by `capabilities()`, not
 * by this filter, and keeps appearing.
 */
async function buildAllProvidersDashboard(
  deps: QuotaDashboardDependencies,
): Promise<QuotaDashboard> {
  const configured = deps.descriptors.filter((d) => d.isConfigured(deps.env, "quota"));
  if (configured.length === 0) {
    throw new ConfigurationError(
      "No provider is configured. Set at least one API key (Z_AI_API_KEY, MINIMAX_API_KEY, TAVILY_API_KEY, or BRAVE_SEARCH_API_KEY).",
    );
  }
  const secrets = configuredSecrets(deps.env);
  const now = (deps.now ?? Date.now)();
  const thresholdMs = deps.thresholdMs ?? DEFAULT_QUOTA_STALE_THRESHOLD_MS;
  const snapshotEnabled = deps.quotaSnapshot !== undefined;
  // Resolve every configured Provider in registry order. Settled
  // collection preserves partial failure: a `resolveQuotaRow` throw is
  // caught here (single-row callers re-throw). Note `resolveQuotaRow`
  // already redacts all-provider failures itself; the outer
  // `Promise.allSettled` is a defensive guard against a future code
  // path that throws synchronously after the per-row try/catch.
  const settled = await Promise.all(
    configured.map((d) => resolveQuotaRow(d, deps, secrets, snapshotEnabled, now, thresholdMs)),
  );
  return {
    schemaVersion: 1,
    effectiveProvider: deps.effectiveProvider,
    providers: settled,
  };
}

/**
 * Build a {@link QuotaDashboard} for the selected mode. The effective
 * Provider is resolved by the dispatcher (`index.ts`) and passed in as
 * metadata; config validation happens here.
 */
export async function buildQuotaDashboard(
  deps: QuotaDashboardDependencies,
): Promise<QuotaDashboard> {
  return deps.allProviders ? buildAllProvidersDashboard(deps) : buildDefaultDashboard(deps);
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export interface QuotaOptions {
  allProviders?: boolean;
}

/**
 * Injectable dependencies for the quota command. `buildDashboard`
 * resolves the effective/all-provider dashboard; the command only wraps
 * it for presentation and exit-code selection.
 *
 * `writeStderr` is an OPTIONAL generic stderr sink. When provided, the
 * command collects every `warnings` entry from successful dashboard
 * entries and writes each as a prominent notice — provider-neutral
 * (iterates warnings, never branches on provider name). A Provider that
 * needs to flag a caveat about its quota numbers (e.g. Brave reports a
 * rate-limit window, not spend) populates `warnings`; the command
 * renders it here so the caveat text stays out of the neutral command.
 */
export interface QuotaCommandDependencies {
  readonly buildDashboard: () => Promise<QuotaDashboard>;
  readonly writeStderr?: (value: string) => void;
  /**
   * Configured credential values used to redact `warnings` text before
   * it reaches stderr. The `warnings` channel is provider-authored, so a
   * future Provider could put value-derived text there; running each
   * warning through `redactCredentialString` keeps the stderr seam under
   * the same redaction as the dashboard data. Optional — when omitted,
   * only the key/regex-based redaction applies.
   */
  readonly secrets?: string[];
}

/**
 * Run the quota command. Returns the dashboard as base data with a TTY
 * presentation override. Exit code is 1 when any dashboard entry failed
 * (all-provider mode); otherwise 0.
 *
 * Before returning, any `warnings` attached to successful entries are
 * rendered to `writeStderr` (when provided) as prominent notices. This
 * is the provider-neutral caveat channel: it does not branch on
 * provider identity.
 */
export async function quota(
  deps: QuotaCommandDependencies,
): Promise<CommandResult<QuotaDashboard>> {
  const dashboard = await deps.buildDashboard();

  const writeStderr = deps.writeStderr;
  if (writeStderr) {
    for (const entry of dashboard.providers) {
      if (entry.status === "ok" && entry.warnings && entry.warnings.length > 0) {
        for (const warning of entry.warnings) {
          // Redact before stderr: warnings are provider-authored and a
          // future Provider could embed value-derived text here.
          writeStderr(redactCredentialString(`⚠️  ${entry.provider}: ${warning}\n`, deps.secrets));
        }
      }
    }
  }

  const hasFailure = dashboard.providers.some((p) => p.status === "error");
  return {
    kind: "data",
    data: dashboard,
    presentations: { tty: formatQuotaDashboard(dashboard) },
    exitCode: hasFailure ? 1 : 0,
  };
}

export const QUOTA_HELP = `
Quota Command - Provider-normalized plan usage dashboard

Usage: scoutline quota [options]

Reports plan usage as a normalized, schema-version-1 dashboard
(ADR-0001). Each entry carries named quota categories with current and
optional weekly windows, counts, remaining percentage, and ISO reset
time. No Provider-specific field crosses the Interface.

Default mode reports EVERY configured Provider in registry order —
including those without a quota Capability (e.g. Exa emits a no-signal
row labeled "no-capability"). Pin a single Provider with --provider
<id> (or the SCOUTLINE_PROVIDER env var); --all-providers explicitly
forces the multi-Provider default even under a pin. A pin to a Provider
that does not advertise quota (Exa) errors with UNSUPPORTED_CAPABILITY —
the no-signal row only appears in multi-Provider mode.

Each successful row carries a quotaSource label (PB-T5): "snapshot"
(read from ~/.scoutline/state.json and within the freshness threshold),
"live" (the snapshot was stale/missing and the dashboard fell back to
a live probe), or omitted (a pre-PB-T5 caller that did not inject a
snapshot). The label's authoritative flag is false when the snapshot
is stale — selection (PB-T4) treats such rows as eligible-but-neutral,
and the dashboard surfaces the same flag so a user can correlate a
selection pick with the data that drove it.

Options:
  --all-providers   Force multi-Provider mode (the default). Successful
                    and failed entries both appear; the command exits 1
                    when any Provider fails.
  --provider <id>   Pin a single Provider (zai | minimax | tavily | exa |
                    brave | firecrawl | parallel | perplexity | jina | you | linkup | spider) instead of the multi-Provider default.
Examples:
  scoutline quota                  # every configured Provider
  scoutline quota --provider zai   # only zai
  scoutline quota --all-providers  # explicit multi-Provider (same as default)
  scoutline quota -O pretty        # human-readable with progress bars
  scoutline quota -O json          # envelope-wrapped for scripts

Notes:
  - Quota is never cached by the local response cache.
  - Multi-Provider mode never invokes a Provider that is not
    configured for quota (capability-aware: keyless Jina Reader does
    not drag the key-required quota probe into the dashboard).
  - Single-Provider mode (under a pin) propagates failures as ordinary
    errors (exit 3 for an unconfigured pinned Provider).
  - Under default (multi-Provider) mode, a Provider without a quota
    Capability (Exa) appears as a no-signal row with zero transport
    calls; it never triggers a live-probe fallback.
  - Brave's row reports a rate-limit window, NOT spend or credits —
    selection authority is always false for Brave regardless of the
    freshness label (see "Quota Capability Mapping" in the docs).
`.trim();
