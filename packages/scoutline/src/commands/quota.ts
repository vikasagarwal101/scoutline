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
 * Default mode (effective Provider) propagates quota failures through
 * the ordinary error path (thrown → invokeCommand). All-provider mode
 * (`--all-providers`) uses settled collection, emits successful and
 * failed entries, and yields exit 1 when any configured Provider fails.
 */

import type { CommandResult } from "../command-invocation.js";
import type {
  ProviderQuotaFailure,
  ProviderQuotaSuccess,
  QuotaCapability,
  QuotaDashboard,
} from "../capabilities/quota.js";
import { quotaFailureFromError } from "../capabilities/quota.js";
import { executeProviderOperation } from "../lib/execution.js";
import { ConfigurationError, UnsupportedCapabilityError } from "../lib/errors.js";
import type { ProviderDescriptor, ProviderId } from "../providers/types.js";
import { getProviderDescriptor } from "../providers/selection.js";
import { redactSecrets, configuredSecrets, redactCredentialString } from "../lib/redact.js";
import { formatQuotaDashboard } from "../lib/tty.js";

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
 * Default-mode dashboard. Resolves the effective Provider, requires it
 * to be configured (ConfigurationError, exit 3, before transport), then
 * invokes its quota Capability. Failures propagate through the ordinary
 * error path.
 */
async function buildDefaultDashboard(deps: QuotaDashboardDependencies): Promise<QuotaDashboard> {
  const descriptor = getProviderDescriptor(deps.effectiveProvider, deps.descriptors);
  if (!descriptor.isConfigured(deps.env)) {
    throw new ConfigurationError(
      `Provider "${deps.effectiveProvider}" is not configured. Set its API key (Z_AI_API_KEY, MINIMAX_API_KEY, TAVILY_API_KEY, or BRAVE_SEARCH_API_KEY).`,
    );
  }
  const success = await invokeProviderQuota(descriptor, deps.env, deps.sleep, deps.random);
  return {
    schemaVersion: 1,
    effectiveProvider: deps.effectiveProvider,
    providers: [success],
  };
}

/**
 * All-provider dashboard. Queries every configured Provider in static
 * registry order using settled collection. No unconfigured Provider is
 * invoked; the effective Provider is dashboard metadata only. Failures
 * are normalized and recursively redacted before joining the dashboard.
 * No configured Provider is a configuration failure, not an empty
 * success.
 */
async function buildAllProvidersDashboard(
  deps: QuotaDashboardDependencies,
): Promise<QuotaDashboard> {
  const configured = deps.descriptors.filter((d) => d.isConfigured(deps.env));
  if (configured.length === 0) {
    throw new ConfigurationError(
      "No provider is configured. Set at least one API key (Z_AI_API_KEY, MINIMAX_API_KEY, TAVILY_API_KEY, or BRAVE_SEARCH_API_KEY).",
    );
  }
  const secrets = configuredSecrets(deps.env);
  const settled = await Promise.allSettled(
    configured.map((d) => invokeProviderQuota(d, deps.env, deps.sleep, deps.random)),
  );
  const providers: Array<ProviderQuotaSuccess | ProviderQuotaFailure> = configured.map((d, i) => {
    const result = settled[i];
    if (result.status === "fulfilled") {
      return result.value;
    }
    return redactSecrets(
      quotaFailureFromError(d.id, result.reason),
      secrets,
    ) as ProviderQuotaFailure;
  });
  return {
    schemaVersion: 1,
    effectiveProvider: deps.effectiveProvider,
    providers,
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

Reports plan usage for the effective Provider (or every configured
Provider with --all-providers) as a normalized, schema-version-1
dashboard (ADR-0001). Each entry carries named quota categories with
current and optional weekly windows, counts, remaining percentage, and
ISO reset time. No Provider-specific field crosses the Interface.

Options:
  --all-providers   Query every configured Provider in registry order.
                    Successful and failed entries both appear; the
                    command exits 1 when any Provider fails.

Examples:
  scoutline quota                  # effective Provider usage
  scoutline quota --all-providers  # every configured Provider
  scoutline quota -O pretty        # human-readable with progress bars
  scoutline quota -O json          # envelope-wrapped for scripts

Notes:
  - Quota is never cached by the local response cache.
  - Default-mode failures propagate as ordinary errors (exit 3 for an
    unconfigured effective Provider).
  - All-provider mode never invokes an unconfigured Provider.
`.trim();
