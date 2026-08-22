/**
 * Doctor command — Provider-aware diagnostics (P4-04, DESIGN.md §14).
 *
 * The command is presentation-only: it receives a report builder through
 * injected dependencies and wraps the resulting {@link DiagnosticsReport}
 * as base data with a computed exit code. Provider resolution, capability
 * probing, settled collection, and failure redaction live in
 * {@link buildDiagnosticsReport} so the command never imports a Provider
 * transport (ZaiMcpClient, monitor client, or environment credential
 * reads) directly.
 *
 * Exit semantics (DESIGN.md §14):
 *   - Missing effective Provider credentials -> exit 1.
 *   - Any configured probe error -> exit 1 (successful entries preserved).
 *   - All configured probes succeed, or only tools-disabled skips -> exit 0.
 *
 * Under `--no-tools` the command returns after metadata + configured-state
 * evaluation and constructs no Adapter and no transport (FR-034).
 */

import type { CommandResult } from "../command-invocation.js";
import type {
  DiagnosticsCapability,
  DiagnosticsReport,
  ProviderDiagnostic,
  ProviderDiagnosticQuota,
  ProviderVerificationSummary,
} from "../capabilities/diagnostics.js";
import { deriveCapabilityMatrix, diagnosticErrorFromError } from "../capabilities/diagnostics.js";
import { executeProviderOperation } from "../lib/execution.js";
import { UnsupportedCapabilityError } from "../lib/errors.js";
import { redactSecrets, configuredSecrets } from "../lib/redact.js";
import type { ProviderDescriptor, ProviderId, ProviderCapability } from "../providers/types.js";
import type { VerificationPromotionStore } from "../lib/config-store.js";
import {
  DEFAULT_QUOTA_STALE_THRESHOLD_MS,
  isQuotaSnapshotStale,
  type QuotaState,
} from "../lib/quota-store.js";

// ---------------------------------------------------------------------------
// Report builder
// ---------------------------------------------------------------------------

export interface DoctorDiagnosticsDependencies {
  readonly noTools: boolean;
  readonly effectiveProvider: ProviderId;
  readonly descriptors: readonly ProviderDescriptor[];
  readonly env: NodeJS.ProcessEnv;
  /**
   * Effective (post-validation) per-capability routing table from
   * config.json; absent when unconfigured. Embedded additively into
   * the report.
   */
  readonly routing?: Readonly<Record<string, readonly ProviderId[]>>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly random: () => number;
  /**
   * Pre-formatted one-line cache summary (Cache Module Unification
   * Ticket 03). The dispatcher formats this from `cacheStats()` output
   * before invoking the report builder; the report builder only embeds
   * it. Optional for backward compatibility with existing tests that
   * don't cover the cache surface. When omitted, the returned report
   * simply leaves out the `cache` field.
   */
  readonly cacheSummary?: string;
  /**
   * Optional verification promoter (T3b — review item 10). When
   * supplied, Doctor flips `verification.status: unverified → verified`
   * for each Provider whose probe SUCCEEDS. The promotion is
   * best-effort: a write failure is reported through
   * {@link DoctorDiagnosticsDependencies.onPromotionError} (when
   * supplied) and never turns a successful probe into a Doctor failure.
   * Skipped, failed, no-tools, and network-deferred records are NOT
   * promoted (the probe result is authoritative). When omitted, Doctor
   * runs without promotion (backward-compatible with existing tests).
   */
  readonly verificationPromoter?: VerificationPromotionStore;
  /**
   * Optional clock used for the promoted `checkedAt` timestamp.
   * Defaults to `Date.now`; tests inject a fixed clock for
   * deterministic timestamps.
   */
  readonly now?: () => number;
  /**
   * Optional sink for promotion-write failures. Doctor isolates write
   * failures (a successful probe never becomes a Doctor failure on the
   * back of a write error); when this sink is supplied, the failure is
   * reported there so the dispatcher can surface it as a stderr notice
   * without affecting the exit code. When omitted, write failures are
   * silently swallowed.
   */
  readonly onPromotionError?: (providerId: ProviderId, error: unknown) => void;
  /**
   * Optional quota snapshot for the per-Provider `quota` summary
   * (PB-T5 — Plan B). When supplied, each Provider entry embeds a
   * `{ source, observedAt?, authoritative }` summary derived from its
   * snapshot entry. When omitted, the `quota` field is omitted on
   * every entry (backward-compatible with pre-PB-T5 callers). Doctor
   * NEVER live-probes quota — it only reads the snapshot; the live
   * probe belongs to the `quota` command. Under `--no-tools` the
   * field still appears when a snapshot is available (a snapshot
   * read is a local state read, not transport).
   */
  readonly quotaSnapshot?: QuotaState;
  /**
   * Optional verification records (Plan A — surfaced in Doctor by
   * PB-T5). When supplied, each Provider entry embeds a
   * `verification` summary mirroring the Provider's
   * `config.providers[id].verification` record. The dispatcher maps
   * the config-store `ProviderVerification` shape to the capability
   * contract's `ProviderVerificationSummary` (structural twin — kept
   * separate so the capability contract does not import
   * `lib/config-store.ts`). When omitted, the field is omitted
   * (backward-compatible).
   */
  readonly verificationRecords?: Partial<Record<ProviderId, ProviderVerificationSummary>>;
  /**
   * Optional staleness threshold for the per-Provider `quota`
   * summary's `authoritative` flag. Defaults to
   * {@link DEFAULT_QUOTA_STALE_THRESHOLD_MS} (10 min — Tavily's
   * 10/10min key limit is the floor). Only consulted when
   * `quotaSnapshot` is supplied.
   */
  readonly thresholdMs?: number;
}

interface AdapterWithDiagnostics {
  readonly diagnostics?: DiagnosticsCapability;
}

/**
 * Static Provider metadata gathered before any probe. Each entry is
 * promoted to a full {@link ProviderDiagnostic} once its status is
 * resolved (skipped, ok, or error).
 */
interface ProviderDiagnosticBase {
  readonly provider: ProviderId;
  readonly configured: boolean;
  readonly capabilities: readonly ProviderCapability[];
}

function nodeMajor(): number {
  const [major] = process.versions.node.split(".");
  return parseInt(major ?? "0", 10);
}

/**
 * Probe one Provider's connectivity through shared execution. The Adapter
 * transport performs a single attempt (Z.AI tool discovery or MiniMax raw
 * quota probe); the retry policy lives in
 * `executeProviderOperation("diagnostics", ...)`.
 */
async function probeProvider(
  descriptor: ProviderDescriptor,
  env: NodeJS.ProcessEnv,
  sleep: (ms: number) => Promise<void>,
  random: () => number,
): Promise<void> {
  const adapter = descriptor.create({ env }) as AdapterWithDiagnostics;
  const capability = adapter.diagnostics;
  if (!capability) {
    throw new UnsupportedCapabilityError(descriptor.id, "diagnostics");
  }
  return executeProviderOperation("diagnostics", () => capability.invoke({ probe: true }), {
    sleep,
    random,
  });
}

/**
 * Build a schema-version-2 {@link DiagnosticsReport}. Inventory
 * (`capabilityMatrix`) is derived purely from `deps.descriptors` — no
 * descriptor.create(), no transport, no production registry import.
 * Under `--no-tools` the command returns after metadata +
 * configured-state evaluation. Otherwise each configured Provider is
 * probed through shared execution with settled collection, preserving
 * registry order and normalized redacted failures.
 *
 * PB-T5: when `deps.quotaSnapshot` is supplied, each entry carries a
 * `quota` summary derived from the snapshot (source/freshness). When
 * `deps.verificationRecords` is supplied, each entry carries a
 * `verification` summary mirroring Plan A's config record. Both fields
 * are omitted when their dependency is absent (backward-compatible).
 * Doctor never live-probes quota — it only reads the snapshot. The
 * `quota` field appears even under `--no-tools` (snapshot reads are
 * local state, not transport).
 */
export async function buildDiagnosticsReport(
  deps: DoctorDiagnosticsDependencies,
): Promise<DiagnosticsReport> {
  const secrets = configuredSecrets(deps.env);
  const now = (deps.now ?? Date.now)();
  const thresholdMs = deps.thresholdMs ?? DEFAULT_QUOTA_STALE_THRESHOLD_MS;

  const baseEntries: ProviderDiagnosticBase[] = deps.descriptors.map((descriptor) => ({
    provider: descriptor.id,
    configured: descriptor.isConfigured(deps.env),
    capabilities: [...descriptor.capabilities()],
  }));

  // PB-T5 — compute the additive `quota` and `verification` fields
  // once per Provider. Both are pure lookups against injected state
  // (snapshot/config records), never transport. Returned as a side
  // table so the probe branches can attach them without re-reading.
  const quotaFor = (provider: ProviderId): ProviderDiagnosticQuota | undefined => {
    if (!deps.quotaSnapshot) return undefined;
    const snapshot = deps.quotaSnapshot.quota[provider];
    if (!snapshot) {
      return { source: "none", authoritative: false };
    }
    return {
      source: "snapshot",
      observedAt: snapshot.observedAt,
      authoritative: !isQuotaSnapshotStale(snapshot, now, thresholdMs),
    };
  };
  const verificationFor = (provider: ProviderId): ProviderVerificationSummary | undefined =>
    deps.verificationRecords?.[provider];

  const providers: ProviderDiagnostic[] = deps.noTools
    ? baseEntries.map((entry) => ({
        ...entry,
        status: "skipped" as const,
        reason: entry.configured ? ("tools-disabled" as const) : ("not-configured" as const),
        ...(quotaFor(entry.provider) !== undefined ? { quota: quotaFor(entry.provider) } : {}),
        ...(verificationFor(entry.provider) !== undefined
          ? { verification: verificationFor(entry.provider) }
          : {}),
      }))
    : await probeEntries(baseEntries, deps, secrets, quotaFor, verificationFor);

  // T3b — verification promotion (review item 10). After a successful
  // probe, flip the matching Provider's `verification.status` from
  // `unverified` to `verified`. Best-effort: a write failure is
  // isolated through `onPromotionError` and never turns a successful
  // probe into a Doctor failure. Only `status: "ok"` records are
  // promotable; skipped, failed, no-tools, and network-deferred
  // records are not (the probe result is authoritative). Awaited so a
  // subsequent read after Doctor completion is deterministic.
  if (deps.verificationPromoter) {
    const checkedAt = now;
    for (const entry of providers) {
      if (entry.status !== "ok") continue;
      try {
        await deps.verificationPromoter.promote(entry.provider, checkedAt);
      } catch (error) {
        // Isolated: a write failure does not propagate. The sink (when
        // supplied) lets the dispatcher surface it as a stderr notice
        // without affecting the exit code.
        deps.onPromotionError?.(entry.provider, error);
      }
    }
  }

  // L1 fix: the cache summary is formatted by the CLI handler and
  // threaded through deps.cacheSummary. The report builder only embeds
  // it; it never reads `cacheStats()` itself.
  const cache = deps.cacheSummary === undefined ? undefined : { summary: deps.cacheSummary };

  return {
    schemaVersion: 2,
    effectiveProvider: deps.effectiveProvider,
    capabilityMatrix: deriveCapabilityMatrix(deps.descriptors),
    ...(deps.routing !== undefined && Object.keys(deps.routing).length > 0
      ? { routing: deps.routing }
      : {}),
    node: {
      version: process.version,
      visionMcpCompatible: nodeMajor() >= 22,
    },
    providers,
    ...(cache !== undefined ? { cache } : {}),
  };
}

/**
 * Probe every configured Provider in registry order using settled
 * collection. Unconfigured entries are skipped (not-configured) and do
 * NOT fail the report. A configured probe failure is normalized and
 * recursively redacted before joining the report; successful entries
 * are preserved alongside it.
 *
 * PB-T5: the additive `quota` and `verification` fields are attached
 * to EVERY entry (success/skipped/error) via the injected lookup
 * closures — they are pure state reads, not transport, so they appear
 * regardless of the probe outcome. A failed probe with a fresh
 * snapshot still surfaces the snapshot summary so a user can see both
 * the probe failure and the quota state.
 */
async function probeEntries(
  baseEntries: ProviderDiagnosticBase[],
  deps: DoctorDiagnosticsDependencies,
  secrets: string[],
  quotaFor: (provider: ProviderId) => ProviderDiagnosticQuota | undefined,
  verificationFor: (provider: ProviderId) => ProviderVerificationSummary | undefined,
): Promise<ProviderDiagnostic[]> {
  const configuredIndexes = baseEntries
    .map((entry, index) => (entry.configured ? index : -1))
    .filter((index) => index >= 0);

  const settled = await Promise.allSettled(
    // async: a missing descriptor must SETTLE as this provider's rejection,
    // not escape the map synchronously and fail the whole probe (audit #61).
    configuredIndexes.map(async (index) => {
      const descriptor = deps.descriptors[index];
      if (!descriptor) throw new Error(`Missing descriptor at index ${index}`);
      return probeProvider(descriptor, deps.env, deps.sleep, deps.random);
    }),
  );

  let settledCursor = 0;
  return baseEntries.map((entry) => {
    const quota = quotaFor(entry.provider);
    const verification = verificationFor(entry.provider);
    const additive = {
      ...(quota !== undefined ? { quota } : {}),
      ...(verification !== undefined ? { verification } : {}),
    };
    if (!entry.configured) {
      return {
        ...entry,
        status: "skipped" as const,
        reason: "not-configured" as const,
        ...additive,
      };
    }
    const result = settled[settledCursor++];
    if (result?.status === "fulfilled") {
      return { ...entry, status: "ok" as const, ...additive };
    }
    const redacted = redactSecrets(
      diagnosticErrorFromError(result?.reason),
      secrets,
    ) as NonNullable<ProviderDiagnostic["error"]>;
    return { ...entry, status: "error" as const, error: redacted, ...additive };
  });
}

// ---------------------------------------------------------------------------
// Exit code
// ---------------------------------------------------------------------------

/**
 * Compute the doctor exit code from a finalized report. Exit 1 when the
 * effective Provider is unconfigured or any configured probe errored;
 * otherwise exit 0. A tools-disabled or not-configured skip on a
 * non-effective Provider never fails the report.
 */
export function doctorExitCode(report: DiagnosticsReport): number {
  const effective = report.providers.find((p) => p.provider === report.effectiveProvider);
  if (!effective || !effective.configured) return 1;
  if (report.providers.some((p) => p.status === "error")) return 1;
  return 0;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export interface DoctorOptions {
  noTools?: boolean;
}

/**
 * Injectable dependencies for the doctor command. `buildReport` resolves
 * the diagnostics report; the command only wraps it for presentation and
 * exit-code selection.
 */
export interface DoctorCommandDependencies {
  readonly buildReport: () => Promise<DiagnosticsReport>;
}

/**
 * Run the doctor command. Returns the diagnostics report as base data
 * with a computed exit code (1 when the effective Provider is
 * unconfigured or any configured probe failed; otherwise 0).
 */
export async function doctor(
  deps: DoctorCommandDependencies,
): Promise<CommandResult<DiagnosticsReport>> {
  const report = await deps.buildReport();
  return {
    kind: "data",
    data: report,
    exitCode: doctorExitCode(report),
  };
}

export const DOCTOR_HELP = `
Doctor - Provider-aware environment and connectivity diagnostics

Usage: scoutline doctor [options]

Reports a schema-version-2 diagnostics report listing every built-in
Provider (zai, minimax, tavily, exa, brave, firecrawl, parallel, perplexity, jina, linkup, spider) with its configured state, declaredCapabilities, and connectivity status. The effective Provider (resolved
from --provider, SCOUTLINE_PROVIDER, or a per-capability routing table
in config.json, or the quota-ranked default) is the
Provider that serves a requested capability. The routing field embeds
the effective routing table when one is configured (view/edit it with
"scoutline config get routing" / "config set routing.<capability>").
The capabilityMatrix field
lists, for each advertised capability, which providers supply it —
derived from descriptor metadata, so it always reflects the descriptors
passed to this command.

Z.AI connectivity is probed through MCP tool discovery; MiniMax
connectivity through a single raw quota probe that authenticates
without a generative request; Tavily connectivity through a single
raw quota probe against the Tavily account endpoint; Exa connectivity
through a single lightweight search request.

Repository exploration is a Provider Capability. Z.AI descriptor
metadata advertises repository-exploration and the Z.AI Adapter
supplies it; MiniMax, Tavily, and Exa advertise and supply neither. The
capabilityMatrix field reflects that descriptor state
(repository-exploration currently lists only Z.AI while MiniMax and
Tavily lack it).

Reader is a Provider Capability. Z.AI, Tavily, Exa, Parallel, Jina,
and Spider.cloud descriptor metadata all advertise reader; MiniMax,
Brave, and Perplexity advertise and supply neither. The
capabilityMatrix field lists Z.AI, Tavily, Exa, Parallel, Jina, and
Spider.cloud for reader.

Crawl and Map are Provider Capabilities owned by Tavily, Firecrawl,
and Spider.cloud. Z.AI, MiniMax, Exa, and Brave do not advertise
either; the capabilityMatrix lists Tavily, Firecrawl, and Spider.cloud
for each. Research is
supplied by Tavily, Exa, Parallel, Perplexity, and Jina. By default (0.11.0+) Provider fallback
emits a stderr notice and silently reroutes to the next eligible
configured supplier when a non-supplier is selected; under
--no-fallback (or SCOUTLINE_NO_FALLBACK=1) the preflight surfaces
UNSUPPORTED_CAPABILITY for the selected non-supplier.

Public 'repo' and 'read' commands participate in Provider selection.
They honour --provider / SCOUTLINE_PROVIDER / the default zai, route
through the matching Adapter's Repository / Reader Capability, and
return UNSUPPORTED_CAPABILITY when the selected Provider does not
advertise the requested capability (e.g. 'repo --provider minimax'
or 'read --provider minimax' trigger Provider fallback by default in
0.11.0+; under --no-fallback (or SCOUTLINE_NO_FALLBACK=1) the
preflight surfaces UNSUPPORTED_CAPABILITY before any Adapter work).
A supported-but-unconfigured Provider returns ConfigurationError; a
supported-and-configured Provider dispatches through the
corresponding Adapter.

Options:
  --no-tools   Skip every connectivity probe (metadata-only). Under
               --no-tools no Provider transport is constructed: a
               configured Provider is reported as skipped
               (tools-disabled) and does not fail the report.

Exit codes:
  0  All configured probes succeeded (or only tools-disabled skips).
  1  The effective Provider is unconfigured or any configured probe
       failed; successful entries are still reported.

Examples:
  scoutline doctor                 # full diagnostics
  scoutline doctor --provider minimax
  scoutline doctor --no-tools      # metadata only, no transport
`.trim();
