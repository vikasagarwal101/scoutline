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
} from "../capabilities/diagnostics.js";
import { deriveCapabilityMatrix, diagnosticErrorFromError } from "../capabilities/diagnostics.js";
import { executeProviderOperation } from "../lib/execution.js";
import { UnsupportedCapabilityError } from "../lib/errors.js";
import { redactSecrets, configuredSecrets } from "../lib/redact.js";
import type { ProviderDescriptor, ProviderId, ProviderCapability } from "../providers/types.js";

// ---------------------------------------------------------------------------
// Report builder
// ---------------------------------------------------------------------------

export interface DoctorDiagnosticsDependencies {
  readonly noTools: boolean;
  readonly effectiveProvider: ProviderId;
  readonly descriptors: readonly ProviderDescriptor[];
  readonly env: NodeJS.ProcessEnv;
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
  return parseInt(major, 10);
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
 */
export async function buildDiagnosticsReport(
  deps: DoctorDiagnosticsDependencies,
): Promise<DiagnosticsReport> {
  const secrets = configuredSecrets(deps.env);

  const baseEntries: ProviderDiagnosticBase[] = deps.descriptors.map((descriptor) => ({
    provider: descriptor.id,
    configured: descriptor.isConfigured(deps.env),
    capabilities: [...descriptor.capabilities()],
  }));

  const providers: ProviderDiagnostic[] = deps.noTools
    ? baseEntries.map((entry) => ({
        ...entry,
        status: "skipped" as const,
        reason: entry.configured ? ("tools-disabled" as const) : ("not-configured" as const),
      }))
    : await probeEntries(baseEntries, deps, secrets);

  // L1 fix: the cache summary is formatted by the CLI handler and
  // threaded through deps.cacheSummary. The report builder only embeds
  // it; it never reads `cacheStats()` itself.
  const cache = deps.cacheSummary === undefined ? undefined : { summary: deps.cacheSummary };

  return {
    schemaVersion: 2,
    effectiveProvider: deps.effectiveProvider,
    capabilityMatrix: deriveCapabilityMatrix(deps.descriptors),
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
 */
async function probeEntries(
  baseEntries: ProviderDiagnosticBase[],
  deps: DoctorDiagnosticsDependencies,
  secrets: string[],
): Promise<ProviderDiagnostic[]> {
  const configuredIndexes = baseEntries
    .map((entry, index) => (entry.configured ? index : -1))
    .filter((index) => index >= 0);

  const settled = await Promise.allSettled(
    configuredIndexes.map((index) =>
      probeProvider(deps.descriptors[index], deps.env, deps.sleep, deps.random),
    ),
  );

  let settledCursor = 0;
  return baseEntries.map((entry) => {
    if (!entry.configured) {
      return { ...entry, status: "skipped" as const, reason: "not-configured" as const };
    }
    const result = settled[settledCursor++];
    if (result.status === "fulfilled") {
      return { ...entry, status: "ok" as const };
    }
    const redacted = redactSecrets(diagnosticErrorFromError(result.reason), secrets) as NonNullable<
      ProviderDiagnostic["error"]
    >;
    return { ...entry, status: "error" as const, error: redacted };
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
Provider (zai, minimax, tavily, exa, firecrawl) with its configured state, declared
Capabilities, and connectivity status. The effective Provider (resolved
from --provider, SCOUTLINE_PROVIDER, or the default zai) is the
Provider that serves a requested capability. The capabilityMatrix field
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

Reader is a Provider Capability. Z.AI, Tavily, and Exa descriptor
metadata all advertise reader; MiniMax advertises and supplies
neither. The capabilityMatrix field lists Z.AI, Tavily, and Exa for
reader.

Crawl and Map are Provider Capabilities owned by Tavily.
Z.AI, MiniMax, and Exa do not advertise either; the capabilityMatrix
lists Tavily alone for each. Research is supplied by Tavily and Exa.
Selecting Z.AI or MiniMax for crawl, map, or research returns
UNSUPPORTED_CAPABILITY with no fallback.

Public 'repo' and 'read' commands participate in Provider selection.
They honour --provider / SCOUTLINE_PROVIDER / the default zai, route
through the matching Adapter's Repository / Reader Capability, and
return UNSUPPORTED_CAPABILITY when the selected Provider does not
advertise the requested capability (e.g. 'repo --provider minimax' or
'read --provider minimax' fail without falling back to Z.AI). A
supported-but-unconfigured Provider returns ConfigurationError; a
supported-and-configured Provider dispatches through the corresponding
Adapter.

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
