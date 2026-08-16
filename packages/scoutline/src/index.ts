/**
 * scoutline - CLI for Z.AI capabilities
 */

import * as vision from "./commands/vision.js";
import type { VisionExecutionDependencies } from "./commands/vision.js";
import { search, SEARCH_HELP, resolveFanoutPlan, executeFanoutPlan } from "./commands/search.js";
import { read, READ_HELP } from "./commands/read.js";
import { crawl, CRAWL_HELP } from "./commands/crawl.js";
import { map, MAP_HELP } from "./commands/map.js";
import { research, RESEARCH_HELP } from "./commands/research.js";
import {
  repoSearch,
  repoTree,
  repoRead,
  repoBrief,
  REPO_HELP,
  parseBriefFocus,
  parseBriefDepth,
  parseBriefMaxChars,
} from "./commands/repo.js";
import type { RepoBriefFocus } from "./capabilities/repository.js";
import { listTools, showTool, callTool, TOOLS_HELP, CALL_HELP } from "./commands/tools.js";
import { doctor, buildDiagnosticsReport, DOCTOR_HELP } from "./commands/doctor.js";
import { quota, buildQuotaDashboard, QUOTA_HELP } from "./commands/quota.js";
import {
  cacheStatsCommand,
  cacheClearCommand,
  cachePruneCommand,
  formatDoctorCacheSummary,
  CACHE_HELP,
  type CacheStatsReport,
  type CacheClearReport,
  type CachePruneReport,
} from "./commands/cache.js";
import {
  CONFIG_HELP,
  configGetCommand,
  configSetCommand,
  configUnsetCommand,
} from "./commands/config.js";
import { cacheStats, clearAllCaches, parsePruneDuration, pruneCaches } from "./lib/cache.js";
import type { PruneSelectors, PruneCachesResult } from "./lib/cache.js";
import { isExtractMode, type ExtractMode } from "./lib/extract.js";
import {
  runCodeFile,
  evalCode,
  printInterfaces,
  printPromptTemplate,
  CODE_HELP,
} from "./commands/code.js";
import { isOutputMode, OUTPUT_MODES, type OutputMode } from "./lib/output.js";
import { formatErrorOutput } from "./lib/output.js";
import {
  ConfigurationError,
  ValidationError,
  UnsupportedCapabilityError,
  getErrorExitCode,
} from "./lib/errors.js";
import * as os from "node:os";
import { invokeCommand, type CommandInvocationAdapter } from "./command-invocation.js";
import { defaultResponseCache, type ResponseCache } from "./lib/cache.js";
import { configuredSecrets } from "./lib/redact.js";
import {
  configFilePath,
  readConfig,
  resolveConfigRootPure,
  resolveEnvFromConfig,
  setConfigValue,
  unsetConfigValue,
  type ScoutlineConfig,
} from "./lib/config-store.js";
import {
  inspectConfig,
  createDefaultVerificationPromoter,
  createDefaultHintShownStore,
  type VerificationPromotionStore,
  type HintShownStore,
  type ProviderVerification,
} from "./lib/config-store.js";
import {
  createDefaultQuotaStore,
  refreshQuotaSnapshots,
  type QuotaStore,
  type QuotaState,
} from "./lib/quota-store.js";
import type { ProviderVerificationSummary } from "./capabilities/diagnostics.js";
import { createQuotaStoreConsumptionSink, type ConsumptionSink } from "./lib/consumption.js";
import {
  classifyCredentialState,
  formatEnvOnlyHint,
  isCommandHelpInvocation,
  OBSERVATIONAL_COMMANDS,
} from "./lib/trigger-detection.js";
import { resolveProviderId, resolveEffectiveProvider } from "./providers/selection.js";
import { BUILT_IN_PROVIDER_DESCRIPTORS } from "./providers/registry.js";
import type { ProviderDescriptor, ProviderId } from "./providers/types.js";
import { executeWithFallback, type FallbackOutcome } from "./lib/provider-fallback.js";
import type { SearchCapability } from "./capabilities/search.js";
import type { ExecutionDependencies } from "./lib/execution.js";
import { visionOperationToCapability, type VisionOperation } from "./capabilities/vision.js";
import {
  handleInitWithHelp,
  createInquirerPrompts,
  createDefaultConfigStore,
  type InitDependencies,
  type InitPrompts,
} from "./commands/init.js";
import pkg from "../package.json" with { type: "json" };
const { version: VERSION } = pkg;

const MAIN_HELP = `
scoutline v${VERSION} - Multimodal source investigation CLI

Usage: scoutline <command> [args] [options]

Commands:
  vision   Image and video analysis (Z.AI; MiniMax for interpret-image)
  search   Real-time web search (shared: all 9 Providers; --topic
           honored by every Provider)
  read     Fetch and parse web pages (Provider Capability; Z.AI, Tavily,
           Exa, Firecrawl, Parallel, and Jina supply it)
  crawl    Crawl a website from a starting URL (Provider Capability;
           Tavily and Firecrawl support it)
  map      Discover the URL structure of a website (Provider Capability;
           Tavily and Firecrawl support it)
  research Deep research with citations (Provider Capability; Tavily,
           Exa, Parallel, Perplexity, and Jina support it)
  repo     GitHub repository exploration (Provider Capability; Z.AI supports it,
           MiniMax and Tavily return UNSUPPORTED_CAPABILITY)
  quota    Provider-aware plan usage (calls remaining, reset time; default
           reports every configured Provider)
  tools    List available MCP tools (Z.AI)
  tool     Show a tool schema (Z.AI)
  call     Call a tool directly (Z.AI)
  doctor   Provider-aware environment + connectivity checks
  cache    Inspect or clear the local cache (stats / clear)
  code     Execute TypeScript tool chains (Code Mode, Z.AI)
  init     Interactive onboarding wizard (writes ~/.scoutline/config.json)

Provider selection (precedence: --provider, then SCOUTLINE_PROVIDER, then zai):
  --provider <zai|minimax|tavily|exa|brave|firecrawl|parallel|perplexity|jina>   Select the active Provider for shared capabilities
  SCOUTLINE_PROVIDER=<id>    Fallback when --provider is not passed

Shared capabilities accept --provider. The 'repo', 'read', 'crawl', 'map',
and 'research' commands participate in Provider selection: Z.AI
advertises and supplies repository-exploration and reader; Tavily
advertises and supplies reader plus crawl, map, and research; Exa
advertises and supplies search, reader, and research; Parallel AI
advertises search, research, and reader; Perplexity advertises search
and research; Jina AI advertises search, reader, and research (keyless
supported); MiniMax advertises and supplies none of those Provider-only
Capabilities.
Provider fallback is always-on by default (0.11.0+): selecting a
non-supplier emits a stderr notice and silently reroutes to the next
eligible configured Provider in registry order. Use --no-fallback (or
SCOUTLINE_NO_FALLBACK=1) to restore the previous strict
UNSUPPORTED_CAPABILITY behavior. Z.AI-only commands (tools, tool,
call, code) carry the flag but ignore it. Quota and doctor report
per-Provider; --provider picks the effective Provider for metadata.

Global Options:
  --output-format <data|json|pretty|compact|markdown|refs|tty>  Output mode (default: data)
  -O <mode>                                                     Alias for --output-format

Help:
  scoutline --help
  scoutline vision --help
  scoutline search --help
  scoutline read --help
  scoutline crawl --help
  scoutline map --help
  scoutline research --help
  scoutline repo --help
  scoutline tools --help
  scoutline call --help
  scoutline code --help
  scoutline cache --help
  scoutline init --help
`.trim();

function parseArgs(args: string[]): {
  flags: Record<string, string | boolean>;
  positional: string[];
} {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === undefined) break;

    if (arg.startsWith("--")) {
      const key = arg.slice(2);

      if (key.startsWith("no-")) {
        flags[key.slice(3)] = false;
        flags[key] = true;
        i++;
        continue;
      }

      const nextArg = args[i + 1];
      if (nextArg && !nextArg.startsWith("-")) {
        flags[key] = nextArg;
        i += 2;
      } else {
        flags[key] = true;
        i++;
      }
    } else if (arg.startsWith("-") && arg.length === 2) {
      const key = arg.slice(1);
      const nextArg = args[i + 1];
      if (nextArg && !nextArg.startsWith("-")) {
        flags[key] = nextArg;
        i += 2;
      } else {
        flags[key] = true;
        i++;
      }
    } else {
      positional.push(arg);
      i++;
    }
  }

  return { flags, positional };
}

/**
 * Collect every occurrence of a long `--<name>` flag in argv order,
 * mirroring parseArgs' value-consumption rule (the next argument is the
 * value iff it exists, is non-empty, and does not start with "-").
 * Valueless occurrences are returned as `true`. parseArgs keeps only the
 * LAST occurrence of a repeated flag; callers whose flag is repeatable
 * (e.g. the brief's `--focus`) scan argv with this helper instead.
 */
function collectLongFlagValues(args: string[], name: string): (string | true)[] {
  const values: (string | true)[] = [];
  const flag = `--${name}`;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== flag) continue;
    const nextArg = args[i + 1];
    if (nextArg && !nextArg.startsWith("-")) {
      values.push(nextArg);
      i += 1;
    } else {
      values.push(true);
    }
  }
  return values;
}

function extractGlobalOptions(args: string[]): {
  outputFormat?: string;
  forcePretty?: boolean;
  forceRaw?: boolean;
  provider?: string;
  noFallback?: boolean;
  rest: string[];
} {
  const rest: string[] = [];
  let outputFormat: string | undefined;
  let forcePretty = false;
  let forceRaw = false;
  let provider: string | undefined;
  let noFallback = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === "--output-format" || arg === "-O") {
      outputFormat = args[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--pretty-output") {
      forcePretty = true;
      continue;
    }
    if (arg === "--raw") {
      forceRaw = true;
      continue;
    }
    if (arg === "--provider") {
      // Global option: accepted before OR after the command token. It is
      // removed from the rest stream so command-local positional parsing
      // never observes it. Only shared Search resolves/validates it; the
      // Z.AI-only command families carry it but never consult it.
      // A valueless `--provider` — trailing, or followed by another
      // option token — is a VALIDATION_ERROR, not a silent no-op
      // (review fixup, round 2). Consuming a dash-prefixed follower as
      // the value made `cache prune --provider --older-than 60s` run a
      // prune scoped to provider "--older-than" while the selector-free
      // tool scan still deleted expired tool entries. Provider ids never
      // start with "-", so a dash-prefixed follower is a missing value;
      // this mirrors `parseArgs`' refusal to bind dash-prefixed values.
      const value = args[i + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new ValidationError(
          "--provider requires a value.",
          "Pass a Provider id after --provider, e.g. --provider zai.",
        );
      }
      provider = value;
      i += 1;
      continue;
    }
    if (arg === "--no-fallback") {
      // Provider-fallback kill-switch. Accepted before OR after the
      // command token and removed from the rest stream so command-local
      // parsing never observes it. Resolution against
      // `SCOUTLINE_NO_FALLBACK` lives in `main` so a test that drives
      // `extractGlobalOptions` directly can assert the flag shape in
      // isolation.
      noFallback = true;
      continue;
    }
    rest.push(arg);
  }

  return { outputFormat, forcePretty, forceRaw, provider, noFallback, rest };
}

/**
 * The single shared output-mode resolver for every path in `main`:
 * normal pre-dispatch resolution AND the extraction-failure boundary
 * (via `bestEffortOutputMode`). Precedence: explicit `--output-format`
 * > `--pretty-output` > `--raw` > env override > TTY detection >
 * deterministic `data` fallback.
 *
 * `options.lenient` swaps the strict invalid-explicit `ValidationError`
 * for a fall-through so the resolver is total on the error boundary,
 * where a throw would escape the very catch that formats it. A
 * well-formed argv always surfaces the invalid mode through the strict
 * path (review fixup, round 3).
 */
function resolveOutputMode(
  explicit: string | undefined,
  forcePretty: boolean,
  forceRaw: boolean,
  adapter: CommandInvocationAdapter,
  options: { lenient?: boolean } = {},
): OutputMode {
  if (explicit !== undefined) {
    if (isOutputMode(explicit)) {
      return explicit;
    }
    if (!options.lenient) {
      throw new ValidationError(
        `Invalid output format: ${explicit}`,
        `Use one of: ${OUTPUT_MODES.join(", ")}`,
      );
    }
    // Lenient: treat the invalid explicit mode as absent and fall
    // through the shared chain below.
  }
  if (forcePretty) return "tty";
  if (forceRaw) return "data";
  const envMode = adapter.environmentOutputMode;
  if (typeof envMode === "string" && isOutputMode(envMode)) {
    return envMode;
  }
  if (adapter.stdoutIsTTY) return "tty";
  return "data";
}

/**
 * Resolve the output mode for errors that escape `extractGlobalOptions`
 * itself (a valueless or option-shadowed `--provider`). The partially
 * parsed result never escapes the throw, so the requested mode is
 * re-derived from the raw argv. This helper owns ONLY the argv
 * re-extraction — token consumption mirrors `extractGlobalOptions`
 * exactly (the follower of `--output-format`/`-O` is its value) — and
 * delegates every precedence and fallback decision to the one shared
 * `resolveOutputMode` through its non-throwing `lenient` path, so
 * normal and extraction-error resolution cannot diverge (review
 * fixup, round 3). Round 2 context: the extraction catch previously
 * hardcoded `data`, so `--output-format pretty ... --provider`
 * reported the extraction failure in compact JSON despite the
 * requested mode.
 */
function bestEffortOutputMode(
  args: readonly string[],
  adapter: CommandInvocationAdapter,
): OutputMode {
  let outputFormat: string | undefined;
  let forcePretty = false;
  let forceRaw = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === "--output-format" || arg === "-O") {
      const value = args[i + 1];
      if (value !== undefined) {
        outputFormat = value;
        i += 1;
      }
      continue;
    }
    if (arg === "--pretty-output") {
      forcePretty = true;
      continue;
    }
    if (arg === "--raw") {
      forceRaw = true;
      continue;
    }
  }
  return resolveOutputMode(outputFormat, forcePretty, forceRaw, adapter, {
    lenient: true,
  });
}

/**
 * Dependencies threaded from `main` into every command handler.
 *
 * `now` flows onward to `invokeCommand` (DESIGN §2) as its optional fourth
 * argument so success envelopes carry deterministic timestamps under test.
 * `env` is the injectable environment seam: it is plumbed to the handler
 * boundary here so Phase 2 can route it into `CommandContext` /
 * `ProviderContext` without reshaping the dispatch layer again. Commands
 * still read `process.env` directly today; that migration is Phase 2 and
 * intentionally out of scope for this plumbing fix.
 *
 * `provider` is the parsed global `--provider` flag. Shared Search, the
 * P6-07 Repository commands, and the Reader Migration 04 `read` command
 * resolve/validate it; `cache prune` reads it as a PRUNE SELECTOR
 * (`--provider` is stripped from the rest stream before `handleCache`
 * sees it, so the dispatcher falls back to this field); the remaining
 * Z.AI-only command families (tools, tool, call, code) carry it but
 * never consult it. `providerDescriptors`
 * is the injectable registry (tests pass doubles; production uses the
 * static built-in list).
 *
 * `fallbackEnabled` is the resolved provider-fallback kill-switch
 * (Provider Fallback Tech Plan §"Kill-switch plumbing"). It is the
 * boolean AND of "flag absent" and "`SCOUTLINE_NO_FALLBACK` absent" —
 * either disables the cross-Provider candidate loop. The dispatch
 * layer plumbs the value through but no handler in this ticket
 * consumes it; the per-handler wiring lands in later tickets.
 *
 * Search execution dependencies (`searchCache`, `searchSleep`,
 * `searchRandom`) default to the on-disk cache and real sleep/random in
 * production; tests inject in-memory doubles.
 *
 * `repositoryCache`, `repositorySleep`, and `repositoryRandom` are the
 * analogous seams for the P6-07 Repository commands. They default to
 * the same production values as Search (single on-disk cache, real
 * sleep, Math.random) but stay as separate optional MainDependencies
 * so repository tests can inject isolated in-memory doubles without
 * touching Search state. They are not a rename of the Search seams.
 *
 * `readerCache`, `readerSleep`, and `readerRandom` are the analogous
 * seams for the Reader Migration 04 `read` command. Same defaults as
 * Search and Repository; separate optional MainDependencies so reader
 * tests can inject isolated in-memory doubles. Not a rename of either
 * prior seam.
 *
 * `pruneCaches` is the cache-prune dispatcher seam (Cache Prune
 * Ticket 5). Production wires the on-disk `pruneCaches` from
 * `src/lib/cache.js`; tests inject a double so the dispatcher can be
 * exercised in-process without real I/O. Defaults to the production
 * function when omitted.
 */
export interface HandlerDependencies {
  readonly invocation: CommandInvocationAdapter;
  readonly env: NodeJS.ProcessEnv;
  readonly secrets: string[];
  readonly now?: () => number;
  readonly provider?: string;
  readonly providerDescriptors: readonly ProviderDescriptor[];
  readonly fallbackEnabled: boolean;
  /**
   * Validated per-capability routing preference (routing-table plan).
   * Absent → handlers pass `routing: undefined` and selection is
   * byte-identical to pre-routing behavior.
   */
  readonly routing?: Readonly<Record<string, readonly ProviderId[]>>;
  /**
   * Whether multi-provider search fan-out is enabled (search-fanout
   * plan, Ticket 3). Production derives this from the loaded config
   * (`config.fanout === true`; the typed registry row + `config set`
   * surface arrive in Ticket 4); tests inject it directly so
   * activation-tier assertions stay hermetic. Absent/false → the
   * search handler's fan-out path never engages (byte-identical
   * pre-fan-out behavior).
   */
  readonly configFanout?: boolean;
  readonly searchCache: ResponseCache;
  readonly searchSleep: (ms: number) => Promise<void>;
  readonly searchRandom: () => number;
  readonly repositoryCache: ResponseCache;
  readonly repositorySleep: (ms: number) => Promise<void>;
  readonly repositoryRandom: () => number;
  readonly readerCache: ResponseCache;
  readonly readerSleep: (ms: number) => Promise<void>;
  readonly readerRandom: () => number;
  readonly crawlCache: ResponseCache;
  readonly crawlSleep: (ms: number) => Promise<void>;
  readonly crawlRandom: () => number;
  readonly mapCache: ResponseCache;
  readonly mapSleep: (ms: number) => Promise<void>;
  readonly mapRandom: () => number;
  readonly researchCache: ResponseCache;
  readonly researchSleep: (ms: number) => Promise<void>;
  readonly researchRandom: () => number;
  /**
   * Optional SIGINT registrar for the research command (Review Fix 3).
   * Production wires `process.on('SIGINT', ...)`. When provided, the
   * research handler uses this to register / tear down the listener on
   * every per-attempt entry / exit; when absent, the production
   * registrar is used.
   */
  readonly researchRegisterInterrupt?: (
    stateFilePath: string,
    resumeCommand: string,
  ) => (print: () => void) => () => void;
  /**
   * Optional verification promoter for Doctor (T3b). Production wires
   * the configured `verificationPromoter` from `MainDependencies`;
   * tests inject a double. When absent, Doctor runs without
   * promotion.
   */
  readonly verificationPromoter?: VerificationPromotionStore;
  /**
   * Optional consumption sink (PB-T2 — Plan B). Production wires the
   * configured `consume` from `MainDependencies` (a quota-store-backed
   * sink); tests inject an in-memory double so event-sequence
   * assertions stay hermetic. When absent, no consumption events are
   * emitted and shared execution is byte-for-byte identical to
   * pre-PB-T2.
   */
  readonly consume?: ConsumptionSink;
  /**
   * Optional quota snapshot (PB-T4 — Plan B). Production is read once
   * by `main` via `quotaStore.read()` after the PB-T1 pre-command
   * refresh and threaded through every handler; tests inject a crafted
   * snapshot so selection assertions stay hermetic — no real
   * `state.json` I/O. The seven shared handlers pass this to
   * `resolveEffectiveProvider` for quota-aware first-pick selection.
   * When absent, the resolver degrades to the first eligible provider
   * in registry order (the pre-PB-T4 behaviour). Doctor, quota,
   * cache, init, and raw Z.AI commands never read it.
   */
  readonly quotaState?: QuotaState;
  /**
   * Optional quota store for live-probe write-through (PB-T5 — Plan B).
   * Production wires the singleton constructed in `main`; tests inject
   * an in-memory double so write-through assertions stay hermetic.
   * Doctor never consults it (Doctor reads the snapshot, never
   * live-probes quota). The `quota` command consults it only when the
   * snapshot path is enabled AND a configured Provider's snapshot is
   * stale/missing (a successful live-probe fallback is persisted
   * before the dashboard returns). When absent, the `quota` command
   * emits a `quotaSource` label but does not persist the live refresh.
   */
  readonly quotaStore?: QuotaStore;
  /**
   * Optional verification records for Doctor's per-Provider
   * `verification` summary (PB-T5 — Plan B). Production maps
   * `config.providers[id].verification` (Plan A) to
   * `ProviderVerificationSummary` (capability contract); tests inject
   * a crafted record so Doctor assertions stay hermetic. When absent,
   * the `verification` field is omitted (pre-PB-T5 callers).
   */
  readonly verificationRecords?: Partial<Record<ProviderId, ProviderVerificationSummary>>;
  /**
   * Optional injectable `pruneCaches` for the `cache prune` subcommand
   * (Cache Prune Ticket 5). Production wires the on-disk
   * `pruneCaches` from `src/lib/cache.js` (see `MainDependencies`);
   * tests inject a double so the dispatcher's selector-parsing /
   * error-propagation contract can be exercised without touching disk.
   * When absent, the dispatcher uses the production function.
   */
  readonly pruneCaches?: (selectors: PruneSelectors) => Promise<PruneCachesResult>;
}

async function handleVision(
  args: string[],
  outputMode: OutputMode,
  deps: HandlerDependencies,
): Promise<number> {
  const { flags, positional } = parseArgs(args);

  if (flags.help || flags.h || positional.length === 0) {
    deps.invocation.writeStdout(vision.VISION_HELP);
    return 0;
  }

  const command = positional[0] ?? "";
  const source = positional[1] ?? "";
  const prompt = positional[2];

  // Map the subcommand to its Vision operation. Unknown subcommands are
  // a parse-time VALIDATION_ERROR and are rejected before any Provider
  // resolution, support check, or media access.
  const operation = visionOperationForCommand(command);

  // Per-operation capability id (e.g. `vision.interpret-image`,
  // `vision.chart`). The executor's preflight uses this to filter
  // descriptors, and notice wording carries it verbatim. Vision
  // sub-operations share the same `adapter.vision` slot — the
  // per-operation capability is in the descriptor metadata. Computed
  // before selection so PB-T4 can rank providers against the exact
  // sub-operation being dispatched.
  const capabilityId = visionOperationToCapability(operation);

  // Resolve the effective Provider for Vision (DESIGN.md §6). Invalid
  // explicit/env input fails here with VALIDATION_ERROR before any Vision
  // support check or media access. Selection never consults credentials
  // beyond the descriptor `isConfigured` metadata check (FR-003); the
  // configured check below is the executor's responsibility (Provider
  // Fallback Tech Plan §"Per-handler refactor pattern"). PB-T4: when
  // no pin is present, the effective provider is the highest-scored
  // configured+capable provider for this vision operation against the
  // injected quota snapshot; pin input still bypasses ranking.
  const providerId: ProviderId = resolveEffectiveProvider({
    explicitProvider: deps.provider,
    env: deps.env,
    capabilityId,
    descriptors: deps.providerDescriptors,
    quotaSnapshot: deps.quotaState,
    routing: deps.routing,
  });

  // Vision bypasses the response cache (FR-022). The shared execution
  // primitives (sleep/random) are the same ones Search consumes; they
  // drive retry backoff deterministically under test.
  const visionDepsShape = {
    sleep: deps.searchSleep,
    random: deps.searchRandom,
  };

  // Provider-fallback Ticket 02: route every vision operation through
  // the shared executor. The existing vision URL→temp-file fallback
  // stays inside the Z.AI adapter's invoke, layered beneath provider
  // fallback.
  return invokeCommand(
    deps.invocation,
    async (context) => {
      const outcome = await executeWithFallback(
        {
          capabilityId,
          commandLabel: "vision",
          effectiveProvider: providerId,
          descriptors: deps.providerDescriptors,
          env: deps.env,
          fallbackEnabled: deps.fallbackEnabled,
          writeStderr: (s) => deps.invocation.writeStderr(s),
        },
        async (descriptor) => {
          const adapter = descriptor.create({ env: deps.env });
          // The executor's preflight guarantees the descriptor advertises
          // the capability and supplies a non-null adapter slot, so the
          // cast is safe. Operation-level support is checked immediately
          // against `visionCapability.supports(operation)` — descriptor
          // metadata and adapter capability are independent sources of
          // truth, and the live dispatch must fail closed on disagreement
          // (Review Fix 4). A mismatch throws `UnsupportedCapabilityError`
          // before any media work / transport use, and the Executor treats
          // it as a `continue` so the next candidate (if any) gets a
          // chance.
          const visionCapability = adapter.vision as Parameters<
            typeof vision.analyze
          >[2]["capability"];
          if (!visionCapability || !visionCapability.supports(operation)) {
            throw new UnsupportedCapabilityError(descriptor.id, capabilityId);
          }
          const visionDeps: VisionExecutionDependencies = {
            capability: visionCapability,
            ...visionDepsShape,
            // PB-T2: thread the actual attempted descriptor ID + sink
            // through so vision emits one consumption event per
            // billable invoke attempt at the execution seam. The
            // descriptor ID is the *attempted* provider (not the
            // registry-derived effective provider) so fallback attempts
            // record the actual descriptor that invoked transport.
            ...(deps.consume !== undefined ? { consume: deps.consume } : {}),
            ...(deps.consume !== undefined ? { provider: descriptor.id } : {}),
            ...(deps.now !== undefined ? { now: deps.now } : {}),
          };
          switch (command) {
            case "analyze":
              return vision.analyze(source, prompt, visionDeps, context);
            case "ui-to-code": {
              const outputType = (flags.output as string) || "code";
              return vision.uiToCode(
                source,
                prompt,
                outputType as "code" | "prompt" | "spec" | "description",
                visionDeps,
                context,
              );
            }
            case "extract-text":
              return vision.extractText(
                source,
                prompt,
                flags.language as string,
                visionDeps,
                context,
              );
            case "diagnose-error":
              return vision.diagnoseError(
                source,
                prompt,
                flags.context as string,
                visionDeps,
                context,
              );
            case "diagram":
              return vision.diagram(source, prompt, flags.type as string, visionDeps, context);
            case "chart":
              return vision.chart(source, prompt, flags.focus as string, visionDeps, context);
            case "diff": {
              const actual = positional[2] ?? "";
              const diffPrompt = positional[3];
              return vision.diff(source, actual, diffPrompt, visionDeps, context);
            }
            case "video":
              return vision.video(source, prompt, visionDeps, context);
            default:
              throw new ValidationError(
                `Unknown vision command: ${command}`,
                'Run "scoutline vision --help" for available commands',
              );
          }
        },
      );
      return outcome.result;
    },
    outputMode,
    deps.now,
    deps.secrets,
  );
}

/**
 * Map a Vision subcommand to its discriminated operation id. Used by
 * `handleVision` to gate the operation against descriptor metadata before
 * Adapter construction. Unknown subcommands throw `ValidationError`.
 */
function visionOperationForCommand(command: string): VisionOperation {
  switch (command) {
    case "analyze":
      return "interpret-image";
    case "ui-to-code":
      return "ui-artifact";
    case "extract-text":
      return "extract-text";
    case "diagnose-error":
      return "diagnose-error";
    case "diagram":
      return "diagram";
    case "chart":
      return "chart";
    case "diff":
      return "diff";
    case "video":
      return "video";
    default:
      throw new ValidationError(
        `Unknown vision command: ${command}`,
        'Run "scoutline vision --help" for available commands',
      );
  }
}

/**
 * Parse and validate the `--count` flag value (Fixup C — B11, Fixup D). Per
 * DESIGN.md §7, count must be a safe integer >= 0. Invalid values (NaN,
 * negative, non-integer, Infinity, values above Number.MAX_SAFE_INTEGER)
 * throw `ValidationError` BEFORE any Provider resolution or invocation.
 *
 * Fixup D hardens two gaps:
 *   - `--count` without a value parses to `true`; that is a user error,
 *     not an absent flag, and now throws VALIDATION_ERROR instead of being
 *     silently treated as absent.
 *   - Uses `Number.isSafeInteger` instead of `Number.isFinite` +
 *     `Number.isInteger` so values above 2^53-1 are rejected rather than
 *     silently rounded.
 *
 * Exported for testing so the validation can be exercised without going
 * through the CLI parser (which does not deliver negative numbers as flag
 * values today).
 */
export function parseAndValidateCount(raw: unknown): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (raw === true) {
    throw new ValidationError(
      "Count requires a numeric value.",
      "Use a non-negative integer (e.g. --count 5).",
    );
  }
  const str = typeof raw === "string" ? raw : String(raw);
  if (!/^\d+$/.test(str)) {
    throw new ValidationError(
      `Invalid --count value "${str}": must be a non-negative integer`,
      "Use a non-negative integer (e.g. --count 5).",
    );
  }
  const parsed = Number(str);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ValidationError(
      `Invalid --count value "${str}": must be a non-negative safe integer`,
      "Use a non-negative integer (e.g. --count 5).",
    );
  }
  return parsed;
}

const SEARCH_TOPICS = ["general", "news", "finance"] as const;

/**
 * Validate the `--topic` flag value BEFORE Provider resolution, mirroring
 * the `--count` parse-level gate (Fixup D — B11). An invalid value
 * surfaces VALIDATION_ERROR regardless of which Provider would have been
 * selected, because parse-level validation fires before the support /
 * configuration gates. Exported for testing.
 */
export function parseAndValidateTopic(raw: unknown): "general" | "news" | "finance" | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (raw === true) {
    throw new ValidationError(
      "Topic requires a value.",
      `Use one of: ${SEARCH_TOPICS.join(", ")}.`,
    );
  }
  const str = typeof raw === "string" ? raw : String(raw);
  if (!(SEARCH_TOPICS as readonly string[]).includes(str)) {
    throw new ValidationError(
      `Invalid --topic value "${str}": must be one of ${SEARCH_TOPICS.join(", ")}`,
      `Use one of: ${SEARCH_TOPICS.join(", ")}.`,
    );
  }
  return str as "general" | "news" | "finance";
}

const SEARCH_TYPES = ["video"] as const;

/**
 * Validate the `--type` flag value BEFORE Provider resolution, mirroring
 * `parseAndValidateTopic`. `type` is a content axis (not an editorial
 * topic axis) and is mutually exclusive with `--topic` (checked in
 * `handleSearch`). Exported for testing.
 */
export function parseAndValidateType(raw: unknown): "video" | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (raw === true) {
    throw new ValidationError("Type requires a value.", `Use one of: ${SEARCH_TYPES.join(", ")}.`);
  }
  const str = typeof raw === "string" ? raw : String(raw);
  if (!(SEARCH_TYPES as readonly string[]).includes(str)) {
    throw new ValidationError(
      `Invalid --type value "${str}": must be one of ${SEARCH_TYPES.join(", ")}`,
      `Use one of: ${SEARCH_TYPES.join(", ")}.`,
    );
  }
  return str as "video";
}

async function handleSearch(
  args: string[],
  outputMode: OutputMode,
  deps: HandlerDependencies,
): Promise<number> {
  const { flags, positional } = parseArgs(args);

  if (flags.help || flags.h || positional.length === 0) {
    deps.invocation.writeStdout(SEARCH_HELP);
    return 0;
  }

  // Fixup D — B11: validate --count BEFORE Provider resolution and the
  // configured/credential check. A syntax error in a CLI argument must
  // not depend on whether credentials are present: `search q --count nope`
  // with NO credentials must surface VALIDATION_ERROR (exit 1), not
  // CONFIGURATION_ERROR (exit 3). Order: parse global options -> validate
  // count -> validate topic -> validate type -> reject type+topic combo
  // -> resolve provider -> check configured -> dispatch.
  const count = parseAndValidateCount(flags.count);
  const topic = parseAndValidateTopic(flags.topic);
  const type = parseAndValidateType(flags.type);
  // `type` is a content axis; `topic` is an editorial axis. They are
  // mutually exclusive. Enforced at parse time (before Provider
  // resolution) so the error is VALIDATION_ERROR regardless of provider.
  if (type !== undefined && topic !== undefined) {
    throw new ValidationError(
      "--type and --topic are mutually exclusive (--type has no editorial topic axis).",
      "Pass either --type or --topic, not both.",
    );
  }

  // Resolve the effective Provider ONLY inside shared Search (DESIGN.md §6).
  // Other command families carry the parsed flag but never resolve or
  // validate it. An invalid explicit/env value throws VALIDATION_ERROR
  // here, before any Adapter construction or invocation. Selection never
  // consults credentials beyond the descriptor `isConfigured` metadata
  // check (FR-003); the configured check is the executor's
  // responsibility (Provider Fallback Tech Plan §"Per-handler refactor
  // pattern"). PB-T4: when no pin is present, the effective provider is
  // the highest-scored configured+capable provider for `search` against
  // the injected quota snapshot; pin input still bypasses ranking.
  //
  // Ticket 3/5 — Fan-out activation (search-fanout plan, DESIGN D1):
  // resolve the activation plan BEFORE the single-pin resolver. A
  // Tier-1 multi-pin raw (`--provider a,b` / `--provider all`) is a
  // fan-out activation, and `parseProviderId` inside
  // `resolveEffectiveProvider` rejects the comma form as unknown — the
  // strict single-path resolution therefore runs only when the plan is
  // NOT fan-out (preserving its typed VALIDATION_ERROR contract for
  // unknown single pins, which the resolver deliberately falls through).
  // When fan-out is active there is no single effective provider: the
  // plan itself carries the ordered arm list, and `providerId` is never
  // consulted on the fan-out path.
  const configFanout = deps.configFanout === true;
  const fanoutPlan = resolveFanoutPlan({
    explicitProviderRaw: deps.provider,
    env: deps.env,
    configFanout,
    routing: deps.routing,
    descriptors: deps.providerDescriptors,
  });
  const providerId: ProviderId | undefined =
    fanoutPlan.mode === "fanout"
      ? undefined
      : resolveEffectiveProvider({
          explicitProvider: deps.provider,
          env: deps.env,
          capabilityId: "search",
          descriptors: deps.providerDescriptors,
          quotaSnapshot: deps.quotaState,
          routing: deps.routing,
        });

  const query = positional.join(" ");

  const fieldsRaw = flags.fields as string | undefined;
  const fields = fieldsRaw
    ? fieldsRaw
        .split(",")
        .map((f) => f.trim())
        .filter(Boolean)
    : undefined;

  const searchOptions = {
    count,
    domain: flags.domain as string,
    recency: flags.recency as "oneDay" | "oneWeek" | "oneMonth" | "oneYear" | "noLimit",
    contentSize: flags["content-size"] as "medium" | "high",
    location: flags.location as "cn" | "us",
    topic,
    type,
    maxSummary: flags["max-summary"] ? parseInt(flags["max-summary"] as string, 10) : undefined,
    fields: fields && fields.length > 0 ? fields : undefined,
    noCache: flags["no-cache"] === true,
    merge: flags.merge === true,
  };

  // Provider-fallback Ticket 02: route the call through the shared
  // fallback executor. The executor owns capability+configured+adapter
  // preflight (FR-023/024), candidate plan ordering, error
  // classification, exhaustion semantics, and notices. The handler
  // keeps command-specific work (request building, flag parsing, which
  // executeX). `--merge` runs the whole parallel sub-query batch inside
  // a single attempt so a fallback switch replaces the entire batch,
  // never individual sub-queries (Tech Plan §"Handler non-uniformity").
  //
  // Ticket 3 — Fan-out dispatch: the plan is resolved above (before the
  // single-pin resolver). When `mode === "fanout"`, the call routes
  // through `executeFanoutPlan` (parallel pinned arms, D2/D5/D6)
  // instead of the single-pin fallback executor. The single path stays
  // verbatim for byte-identical output (the single-pin golden test in
  // `tests/search-fanout.test.js` pins this).
  return invokeCommand(
    deps.invocation,
    async (context) => {
      // The suppress notice (explicit-pin precedence over the fan-out
      // switch) is emitted before dispatch on BOTH paths so the wording
      // is identical wherever the resolver flagged it. Fan-out mode
      // never sets `suppress` today (pins resolve to single), but the
      // hook is mode-agnostic by construction.
      if (fanoutPlan.suppress) {
        context.notice(fanoutPlan.suppress);
      }
      if (fanoutPlan.mode === "fanout") {
        return executeFanoutPlan(
          fanoutPlan,
          {
            descriptors: deps.providerDescriptors,
            env: deps.env,
            query,
            searchOptions,
            dependencies: {
              cache: deps.searchCache,
              sleep: deps.searchSleep,
              random: deps.searchRandom,
              retryPolicy: undefined,
              // PB-T2 parity (review fix, PR #36): thread the configured
              // consumption sink + clock so each arm's executeSearch
              // bills the arm's provider through local quota accounting.
              ...(deps.consume !== undefined ? { consume: deps.consume } : {}),
              ...(deps.now !== undefined ? { now: deps.now } : {}),
            },
            secrets: deps.secrets,
          },
          context,
        );
      }
      const outcome = await executeWithFallback(
        {
          capabilityId: "search",
          commandLabel: "search",
          // Non-null on this branch: `providerId` is resolved above
          // exactly when the plan is NOT fan-out, and this single-path
          // executor runs only in that case.
          effectiveProvider: providerId!,
          descriptors: deps.providerDescriptors,
          env: deps.env,
          fallbackEnabled: deps.fallbackEnabled,
          writeStderr: (s) => deps.invocation.writeStderr(s),
        },
        async (descriptor) => {
          const adapter = descriptor.create({ env: deps.env });
          const capability: SearchCapability = adapter.search as SearchCapability;
          return search(
            query,
            searchOptions,
            {
              capability,
              cache: deps.searchCache,
              sleep: deps.searchSleep,
              random: deps.searchRandom,
            },
            context,
          );
        },
      );
      return outcome.result;
    },
    outputMode,
    deps.now,
    deps.secrets,
  );
}

async function handleRead(
  args: string[],
  outputMode: OutputMode,
  deps: HandlerDependencies,
): Promise<number> {
  const { flags, positional } = parseArgs(args);

  if (flags.help || flags.h || positional.length === 0) {
    deps.invocation.writeStdout(READ_HELP);
    return 0;
  }

  const url = positional[0];

  // Parse-level validation BEFORE Provider resolution. URL scheme and
  // --extract mode are validated at parse time so an invalid value
  // surfaces VALIDATION_ERROR regardless of which Provider would have
  // been selected, because parse-level validation fires before the
  // support/configuration gates. The handler re-runs an identical
  // check as defensive backstop. The pre-dispatch
  // configuredSecrets(env) redaction read in `main` is the only
  // permitted credential-related read before this point.
  if (typeof url !== "string" || (!url.startsWith("http://") && !url.startsWith("https://"))) {
    throw new ValidationError("URL must start with http:// or https://");
  }
  const extractFlag = flags.extract as string | undefined;
  if (extractFlag !== undefined && !isExtractMode(extractFlag)) {
    throw new ValidationError(
      `Invalid --extract mode: ${extractFlag}. Use one of: code, links, tables, headings`,
    );
  }
  const extract = extractFlag !== undefined ? (extractFlag as ExtractMode) : undefined;

  // Resolve the effective Provider (DESIGN.md §6, FR-001–FR-005):
  // explicit --provider > SCOUTLINE_PROVIDER > quota-ranked pick.
  // Selection never consults credentials beyond the descriptor
  // `isConfigured` metadata check (FR-003) and never branches on
  // Provider ID; an unknown explicit/env value throws
  // VALIDATION_ERROR here. (PB-T4.)
  const providerId: ProviderId = resolveEffectiveProvider({
    explicitProvider: deps.provider,
    env: deps.env,
    capabilityId: "reader",
    descriptors: deps.providerDescriptors,
    quotaSnapshot: deps.quotaState,
    routing: deps.routing,
  });

  const readOptions = {
    format: flags.format as "markdown" | "text",
    noImages: flags["no-images"] === true,
    noCache: flags["no-cache"] === true,
    withLinks: flags["with-links"] === true,
    timeout: flags.timeout ? parseInt(flags.timeout as string, 10) : undefined,
    noGfm: flags["no-gfm"] === true,
    keepImgDataUrl: flags["keep-img-data-url"] === true,
    withImagesSummary: flags["with-images-summary"] === true,
    maxChars: flags["max-chars"] ? parseInt(flags["max-chars"] as string, 10) : undefined,
    fullEnvelope: flags["full-envelope"] === true,
    extract,
  };

  // Shared Reader execution dependencies. The cache/sleep/random
  // default to the same production values as Search and Repository
  // but are kept as separate optional MainDependencies so reader
  // tests can inject isolated in-memory doubles.
  const executionDeps: ExecutionDependencies = {
    cache: deps.readerCache,
    sleep: deps.readerSleep,
    random: deps.readerRandom,
  };

  // Provider-fallback Ticket 02: route the call through the shared
  // fallback executor. Capability + configured + adapter-handle
  // agreement preflight now lives in the executor (FR-023/024
  // preserved). Under --no-fallback the same preflight runs on the
  // effective Provider only.
  return invokeCommand(
    deps.invocation,
    async (context) => {
      const outcome = await executeWithFallback(
        {
          capabilityId: "reader",
          commandLabel: "read",
          effectiveProvider: providerId,
          descriptors: deps.providerDescriptors,
          env: deps.env,
          fallbackEnabled: deps.fallbackEnabled,
          writeStderr: (s) => deps.invocation.writeStderr(s),
        },
        async (descriptor) => {
          const adapter = descriptor.create({ env: deps.env });
          return read(
            url,
            readOptions,
            {
              capability: adapter.reader as Parameters<typeof read>[2]["capability"],
              execution: executionDeps,
            },
            context,
          );
        },
      );
      return outcome.result;
    },
    outputMode,
    deps.now,
    deps.secrets,
  );
}

async function handleCrawl(
  args: string[],
  outputMode: OutputMode,
  deps: HandlerDependencies,
): Promise<number> {
  const { flags, positional } = parseArgs(args);

  if (flags.help || flags.h || positional.length === 0) {
    deps.invocation.writeStdout(CRAWL_HELP);
    return 0;
  }

  const url = positional[0];

  // Parse-level validation BEFORE Provider resolution. URL scheme is
  // validated at parse time so an invalid value surfaces
  // VALIDATION_ERROR regardless of which Provider would have been
  // selected.
  if (typeof url !== "string" || (!url.startsWith("http://") && !url.startsWith("https://"))) {
    throw new ValidationError("URL must start with http:// or https://");
  }

  // Resolve the effective Provider (DESIGN.md §6, FR-001–FR-005):
  // explicit --provider > SCOUTLINE_PROVIDER > quota-ranked pick.
  // (PB-T4.)
  const providerId: ProviderId = resolveEffectiveProvider({
    explicitProvider: deps.provider,
    env: deps.env,
    capabilityId: "crawl",
    descriptors: deps.providerDescriptors,
    quotaSnapshot: deps.quotaState,
    routing: deps.routing,
  });

  // Shared Crawl execution dependencies. The cache/sleep/random default
  // to the same production values as Search/Repository/Reader but are
  // kept as separate optional MainDependencies so crawl tests can inject
  // isolated in-memory doubles.
  const executionDeps: ExecutionDependencies = {
    cache: deps.crawlCache,
    sleep: deps.crawlSleep,
    random: deps.crawlRandom,
  };

  // Provider-fallback Ticket 03: route the call through the shared
  // fallback executor. Capability + configured + adapter-handle
  // preflight lives in the executor (FR-023/024 preserved). The
  // async cost-bearing accepted-risk path (Tech Plan §"Accepted
  // risk"): a runtime failure on crawl may fall back to another
  // Provider even if the failed Provider had already accepted
  // the job. `--no-fallback` eliminates this risk.
  return invokeCommand(
    deps.invocation,
    async (context) => {
      const outcome = await executeWithFallback(
        {
          capabilityId: "crawl",
          commandLabel: "crawl",
          effectiveProvider: providerId,
          descriptors: deps.providerDescriptors,
          env: deps.env,
          fallbackEnabled: deps.fallbackEnabled,
          writeStderr: (s) => deps.invocation.writeStderr(s),
        },
        async (descriptor) => {
          const adapter = descriptor.create({ env: deps.env });
          return crawl(
            url,
            {
              depth: flags.depth ? parseInt(flags.depth as string, 10) : undefined,
              breadth: flags.breadth ? parseInt(flags.breadth as string, 10) : undefined,
              limit: flags.limit ? parseInt(flags.limit as string, 10) : undefined,
              selectPaths: flags["select-paths"] as string | undefined,
              excludePaths: flags["exclude-paths"] as string | undefined,
              instructions: flags.instructions as string | undefined,
              format: flags.format as "markdown" | "text" | undefined,
              contentSize: flags["content-size"] as "medium" | "high" | undefined,
              timeout: flags.timeout ? parseInt(flags.timeout as string, 10) : undefined,
              noCache: flags["no-cache"] === true,
              maxChars: flags["max-chars"] ? parseInt(flags["max-chars"] as string, 10) : undefined,
            },
            {
              capability: adapter.crawl as Parameters<typeof crawl>[2]["capability"],
              execution: executionDeps,
            },
            context,
          );
        },
      );
      return outcome.result;
    },
    outputMode,
    deps.now,
    deps.secrets,
  );
}

async function handleMap(
  args: string[],
  outputMode: OutputMode,
  deps: HandlerDependencies,
): Promise<number> {
  const { flags, positional } = parseArgs(args);

  if (flags.help || flags.h || positional.length === 0) {
    deps.invocation.writeStdout(MAP_HELP);
    return 0;
  }

  const url = positional[0];

  // Parse-level validation BEFORE Provider resolution. URL scheme is
  // validated at parse time so an invalid value surfaces
  // VALIDATION_ERROR regardless of which Provider would have been
  // selected.
  if (typeof url !== "string" || (!url.startsWith("http://") && !url.startsWith("https://"))) {
    throw new ValidationError("URL must start with http:// or https://");
  }

  // Resolve the effective Provider (DESIGN.md §6, FR-001–FR-005):
  // explicit --provider > SCOUTLINE_PROVIDER > quota-ranked pick.
  // (PB-T4.)
  const providerId: ProviderId = resolveEffectiveProvider({
    explicitProvider: deps.provider,
    env: deps.env,
    capabilityId: "map",
    descriptors: deps.providerDescriptors,
    quotaSnapshot: deps.quotaState,
    routing: deps.routing,
  });

  // Shared Map execution dependencies. The cache/sleep/random default
  // to the same production values as Search/Repository/Reader/Crawl but
  // are kept as separate optional MainDependencies so map tests can
  // inject isolated in-memory doubles.
  const executionDeps: ExecutionDependencies = {
    cache: deps.mapCache,
    sleep: deps.mapSleep,
    random: deps.mapRandom,
  };

  // Provider-fallback Ticket 03: route the call through the shared
  // fallback executor. Map retries once per Provider today, so the
  // documented worst-case charged request count under retry+fallback
  // is `2 × N candidates` — see the troubleshooting entry added in
  // Ticket 04. `--no-fallback` is the strict-mode opt-out.
  return invokeCommand(
    deps.invocation,
    async (context) => {
      const outcome = await executeWithFallback(
        {
          capabilityId: "map",
          commandLabel: "map",
          effectiveProvider: providerId,
          descriptors: deps.providerDescriptors,
          env: deps.env,
          fallbackEnabled: deps.fallbackEnabled,
          writeStderr: (s) => deps.invocation.writeStderr(s),
        },
        async (descriptor) => {
          const adapter = descriptor.create({ env: deps.env });
          return map(
            url,
            {
              depth: flags.depth ? parseInt(flags.depth as string, 10) : undefined,
              breadth: flags.breadth ? parseInt(flags.breadth as string, 10) : undefined,
              limit: flags.limit ? parseInt(flags.limit as string, 10) : undefined,
              selectPaths: flags["select-paths"] as string | undefined,
              excludePaths: flags["exclude-paths"] as string | undefined,
              instructions: flags.instructions as string | undefined,
              noCache: flags["no-cache"] === true,
            },
            {
              capability: adapter.map as Parameters<typeof map>[2]["capability"],
              execution: executionDeps,
            },
            context,
          );
        },
      );
      return outcome.result;
    },
    outputMode,
    deps.now,
    deps.secrets,
  );
}

async function handleResearch(
  args: string[],
  outputMode: OutputMode,
  deps: HandlerDependencies,
): Promise<number> {
  const { flags, positional } = parseArgs(args);

  if (flags.help || flags.h || positional.length === 0) {
    deps.invocation.writeStdout(RESEARCH_HELP);
    return 0;
  }

  const query = positional.join(" ");

  // Parse-level enum validation BEFORE Provider resolution so an invalid
  // value surfaces VALIDATION_ERROR regardless of which Provider would
  // have been selected (mirrors --count and --topic in handleSearch).
  const model = validateResearchEnum(flags.model, ["mini", "pro", "auto"], "--model") as
    | "mini"
    | "pro"
    | "auto"
    | undefined;
  const outputLength = validateResearchEnum(
    flags["output-length"],
    ["short", "standard", "long"],
    "--output-length",
  ) as "short" | "standard" | "long" | undefined;
  const citationFormat = validateResearchEnum(
    flags["citation-format"],
    ["numbered", "mla", "apa", "chicago"],
    "--citation-format",
  ) as "numbered" | "mla" | "apa" | "chicago" | undefined;

  // Resolve the effective Provider (DESIGN.md §6, FR-001–FR-005):
  // explicit --provider > SCOUTLINE_PROVIDER > quota-ranked pick.
  // (PB-T4.)
  const providerId: ProviderId = resolveEffectiveProvider({
    explicitProvider: deps.provider,
    env: deps.env,
    capabilityId: "research",
    descriptors: deps.providerDescriptors,
    quotaSnapshot: deps.quotaState,
    routing: deps.routing,
  });

  // Shared Research execution dependencies.
  const executionDeps: ExecutionDependencies = {
    cache: deps.researchCache,
    sleep: deps.researchSleep,
    random: deps.researchRandom,
  };

  // Provider-fallback Ticket 03: route the call through the shared
  // fallback executor. The research command is the riskiest piece
  // of the async set: the SIGINT handler, the polling-timeout
  // controller, and the on-disk state-file identity/timeout must
  // RE-BIND to the Provider that actually wins the candidate loop
  // (Tech Plan §"Handler non-uniformity" — research bullet). The
  // `research` command accepts a `registerInterrupt` injection on
  // its handler dependencies; the executor's per-attempt callback
  // builds the descriptor's `capability.run` and re-registers the
  // SIGINT handler under THAT provider's identity before invoke,
  // tearing it down on throw so the next candidate installs its
  // own. The one-time credit warning is emitted ONCE, before the
  // first attempt, so it is not duplicated across candidate
  // switches.
  return invokeCommand(
    deps.invocation,
    async (context) => {
      const options = {
        model,
        outputLength,
        citationFormat,
        domain: flags.domain as string | undefined,
        maxChars: flags["max-chars"] ? parseInt(flags["max-chars"] as string, 10) : undefined,
        timeout: flags.timeout ? parseInt(flags.timeout as string, 10) : undefined,
        noCache: flags["no-cache"] === true,
      };

      // Closure-guarded one-time credit warning (Review Fix 7). The
      // flag is captured INSIDE the attempt closure, so the line is
      // written exactly once — the first time the executor actually
      // visits a candidate. When the executor's preflight rejects
      // every plan entry before invoking `attempt` (capability-
      // mismatch, no candidates configured), the closure is never
      // entered and the warning stays silent. Strict mode
      // (`--no-fallback`) already runs the same preflight on the
      // single remaining candidate so an ineligible effective also
      // stays silent.
      let warned = false;
      const creditWarning = `Research in progress — this is a credit-intensive operation that may take several minutes.\n`;
      const emitCreditWarning = (): void => {
        if (warned) return;
        warned = true;
        deps.invocation.writeStderr(creditWarning);
      };

      const outcome = await executeWithFallback(
        {
          capabilityId: "research",
          commandLabel: "research",
          effectiveProvider: providerId,
          descriptors: deps.providerDescriptors,
          env: deps.env,
          fallbackEnabled: deps.fallbackEnabled,
          writeStderr: (s) => deps.invocation.writeStderr(s),
        },
        async (descriptor) => {
          emitCreditWarning();
          const adapter = descriptor.create({ env: deps.env });
          return research(
            query,
            options,
            {
              capability: adapter.research as Parameters<typeof research>[2]["capability"],
              execution: executionDeps,
              registerInterrupt: deps.researchRegisterInterrupt,
            },
            context,
          );
        },
      );
      return outcome.result;
    },
    outputMode,
    deps.now,
    deps.secrets,
  );
}

/**
 * Validate a research enum flag (--model, --output-length,
 * --citation-format) at parse level. Returns the typed value or throws
 * ValidationError for an invalid/missing-value input. Mirrors the
 * --count / --topic parse-level gates.
 */
function validateResearchEnum(
  raw: unknown,
  valid: readonly string[],
  flagName: string,
): string | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (raw === true) {
    throw new ValidationError(`${flagName} requires a value.`, `Use one of: ${valid.join(", ")}.`);
  }
  const str = String(raw);
  if (!valid.includes(str)) {
    throw new ValidationError(
      `Invalid ${flagName} value "${str}": must be one of ${valid.join(", ")}`,
      `Use one of: ${valid.join(", ")}.`,
    );
  }
  return str;
}

async function handleRepo(
  args: string[],
  outputMode: OutputMode,
  deps: HandlerDependencies,
): Promise<number> {
  const { flags, positional } = parseArgs(args);

  if (flags.help || flags.h || positional.length === 0) {
    deps.invocation.writeStdout(REPO_HELP);
    return 0;
  }

  const command = positional[0];
  const repo = positional[1];

  // Parse-level validation. Subcommand grammar and required positionals
  // are validated BEFORE Provider resolution, capability support check,
  // configuration check, Adapter construction, or any
  // operation/cacheIdentity/credential/cache/transport work. The
  // pre-dispatch `configuredSecrets(env)` redaction read in `main` is
  // the only permitted credential-related read before this point; it is
  // not selected-Provider resolution and is covered separately by the
  // ordering tests.
  let searchQuery: string | undefined;
  let readPath: string | undefined;
  let briefFocus: readonly RepoBriefFocus[] | undefined;
  let briefDepth: number | undefined;
  let briefMaxChars: number | undefined;
  if (command === "search") {
    searchQuery = positional.slice(2).join(" ");
    if (!repo || !searchQuery) {
      throw new ValidationError(
        "Missing repo or query",
        "Usage: scoutline repo search <owner/repo> <query>",
      );
    }
  } else if (command === "tree") {
    if (!repo) {
      throw new ValidationError("Missing repo", "Usage: scoutline repo tree <owner/repo>");
    }
  } else if (command === "read") {
    readPath = positional[2];
    if (!repo || !readPath) {
      throw new ValidationError(
        "Missing repo or path",
        "Usage: scoutline repo read <owner/repo> <path>",
      );
    }
  } else if (command === "brief") {
    // Brief composes tree + search + read into one envelope; only the
    // `<owner/repo>` positional is required (DESIGN D5). The optional
    // `--focus`/`--path`/`--depth`/`--max-chars`/`--no-cache` flags are
    // threaded into the options object below. Parse-level validation for
    // every brief flag VALUE runs HERE, before Provider resolution and
    // the capability preflight, so malformed input surfaces
    // VALIDATION_ERROR uniformly (never UNSUPPORTED_CAPABILITY first):
    // the sealed focus set via `parseBriefFocus`, and strict
    // positive-integer `--depth`/`--max-chars` via the same exported
    // parsers `commands/repo.ts` re-runs for direct handler callers.
    // The raw flag strings are parsed here — NOT `parseInt`-coerced —
    // so `--depth 1.5` and `--max-chars 500x` are errors, not silently
    // truncated to 1 and 500.
    if (!repo) {
      throw new ValidationError(
        "Missing repo",
        "Usage: scoutline repo brief <owner/repo>",
      );
    }
    // `--no-focus` is meaningless for brief (focus is opt-in via
    // `--focus <list>`) and must fail even when combined with a valid
    // `--focus` — never silently ignored.
    if (flags["no-focus"] === true) {
      throw new ValidationError(
        "--no-focus is not a valid repo brief flag. Use --focus <list> to subset the focus set.",
      );
    }
    // `--focus` is repeatable: parseArgs keeps only the LAST occurrence,
    // so scan argv directly and combine every occurrence in first-seen
    // order — parseBriefFocus dedupes across the combined list. Any
    // valueless occurrence is an error, same as a lone valueless flag.
    const focusOccurrences = collectLongFlagValues(args, "focus");
    if (focusOccurrences.length > 0) {
      if (focusOccurrences.some((v) => v === true)) {
        throw new ValidationError("--focus requires a value.");
      }
      briefFocus = parseBriefFocus(focusOccurrences.join(","));
    }
    const depthRaw = flags.depth;
    if (depthRaw !== undefined) {
      if (depthRaw === true) {
        throw new ValidationError("--depth requires a value.");
      }
      briefDepth = parseBriefDepth(depthRaw);
    }
    const briefMaxCharsRaw = flags["max-chars"];
    if (briefMaxCharsRaw !== undefined) {
      if (briefMaxCharsRaw === true) {
        throw new ValidationError("--max-chars requires a value.");
      }
      briefMaxChars = parseBriefMaxChars(briefMaxCharsRaw);
    }
  } else {
    throw new ValidationError(
      `Unknown repo command: ${command}`,
      'Run "scoutline repo --help" for available commands',
    );
  }

  // Resolve the effective Provider (DESIGN.md §6, FR-001–FR-005):
  // explicit --provider > SCOUTLINE_PROVIDER > quota-ranked pick.
  // Selection never consults credentials beyond the descriptor
  // `isConfigured` metadata check (FR-003) and never branches on
  // Provider ID; an unknown explicit/env value throws
  // VALIDATION_ERROR here. (PB-T4.)
  const providerId: ProviderId = resolveEffectiveProvider({
    explicitProvider: deps.provider,
    env: deps.env,
    capabilityId: "repository-exploration",
    descriptors: deps.providerDescriptors,
    quotaSnapshot: deps.quotaState,
    routing: deps.routing,
  });

  // Shared Repository execution dependencies. The cache/sleep/random
  // default to the same production values as Search but are kept as
  // separate optional MainDependencies so repository tests can inject
  // isolated in-memory doubles.
  const executionDeps: ExecutionDependencies = {
    cache: deps.repositoryCache,
    sleep: deps.repositorySleep,
    random: deps.repositoryRandom,
  };

  const language = flags.language as "en" | "zh" | undefined;
  const maxChars = flags["max-chars"] ? parseInt(flags["max-chars"] as string, 10) : undefined;
  const noCache = flags["no-cache"] === true;
  const treePath = flags.path as string | undefined;
  const depth = flags.depth ? parseInt(flags.depth as string, 10) : undefined;

  // Provider-fallback Ticket 02: route every subcommand through the
  // shared executor. All three projections (search/tree/read) share
  // the `repository-exploration` Capability, so a single executor
  // invocation wraps the chosen subcommand.
  return invokeCommand(
    deps.invocation,
    async (context) => {
      const outcome = await executeWithFallback(
        {
          capabilityId: "repository-exploration",
          commandLabel: "repo",
          effectiveProvider: providerId,
          descriptors: deps.providerDescriptors,
          env: deps.env,
          fallbackEnabled: deps.fallbackEnabled,
          writeStderr: (s) => deps.invocation.writeStderr(s),
        },
        async (descriptor) => {
          const adapter = descriptor.create({ env: deps.env });
          const capability = adapter.repository as Parameters<typeof repoSearch>[3]["capability"];
          switch (command) {
            case "search":
              return repoSearch(
                repo,
                searchQuery as string,
                { language, maxChars, noCache },
                { capability, execution: executionDeps },
                context,
              );
            case "tree":
              return repoTree(
                repo,
                { path: treePath, depth, noCache },
                { capability, execution: executionDeps },
                context,
              );
            case "read":
              return repoRead(
                repo,
                readPath as string,
                { maxChars, noCache },
                { capability, execution: executionDeps },
                context,
              );
            case "brief":
              return repoBrief(
                repo,
                {
                  ...(briefFocus !== undefined ? { focus: briefFocus } : {}),
                  path: treePath,
                  depth: briefDepth,
                  maxChars: briefMaxChars,
                  noCache,
                },
                { capability, execution: executionDeps, secrets: deps.secrets },
                context,
              );
            default:
              // Unreachable: the parse-level validation above already
              // rejected unknown subcommands. Keep a defensive throw so
              // the dispatch table stays total.
              throw new ValidationError(
                `Unknown repo command: ${command}`,
                'Run "scoutline repo --help" for available commands',
              );
          }
        },
      );
      return outcome.result;
    },
    outputMode,
    deps.now,
    deps.secrets,
  );
}

async function handleTools(
  args: string[],
  outputMode: OutputMode,
  deps: HandlerDependencies,
): Promise<number> {
  const { flags } = parseArgs(args);

  if (flags.help || flags.h) {
    deps.invocation.writeStdout(TOOLS_HELP);
    return 0;
  }

  return invokeCommand(
    deps.invocation,
    (context) =>
      listTools(
        {
          filter: flags.filter as string,
          full: flags.full === true,
          typescript: flags.typescript === true || flags.ts === true,
          enableVision: flags.vision !== false,
          env: deps.env,
        },
        context,
      ),
    outputMode,
    deps.now,
    deps.secrets,
  );
}

async function handleTool(
  args: string[],
  outputMode: OutputMode,
  deps: HandlerDependencies,
): Promise<number> {
  const { flags, positional } = parseArgs(args);

  if (flags.help || flags.h || positional.length === 0) {
    deps.invocation.writeStdout(TOOLS_HELP);
    return 0;
  }

  return invokeCommand(
    deps.invocation,
    (context) =>
      showTool(
        positional[0] ?? "",
        { enableVision: flags.vision !== false, env: deps.env },
        context,
      ),
    outputMode,
    deps.now,
    deps.secrets,
  );
}

async function handleCall(
  args: string[],
  outputMode: OutputMode,
  deps: HandlerDependencies,
): Promise<number> {
  const { flags, positional } = parseArgs(args);

  if (flags.help || flags.h || positional.length === 0) {
    deps.invocation.writeStdout(CALL_HELP);
    return 0;
  }

  return invokeCommand(
    deps.invocation,
    (context) =>
      callTool(
        positional[0] ?? "",
        {
          json: flags.json as string,
          file: flags.file as string,
          stdin: flags.stdin === true,
          dryRun: flags["dry-run"] === true,
          enableVision: flags.vision !== false,
          env: deps.env,
        },
        context,
      ),
    outputMode,
    deps.now,
    deps.secrets,
  );
}

async function handleDoctor(
  args: string[],
  outputMode: OutputMode,
  deps: HandlerDependencies,
): Promise<number> {
  const { flags } = parseArgs(args);

  if (flags.help || flags.h) {
    deps.invocation.writeStdout(DOCTOR_HELP);
    return 0;
  }

  const noTools = flags["no-tools"] === true;
  // Resolve the effective Provider ID for report metadata, mirroring
  // Search/Vision/quota. Descriptors are intentionally NOT passed here so
  // the report always lists every built-in Provider even when the
  // effective Provider is unconfigured.
  const effectiveProvider = resolveProviderId(deps.provider, deps.env);

  // Cache Module Unification Ticket 03 — Doctor's one-line cache summary.
  // The dispatcher formats the summary here (L1 fix) from `cacheStats()`
  // output; the report builder only embeds the pre-formatted string.
  // `cacheStats()` never throws (it catches all I/O internally); on a
  // missing directory it returns zeros, which still format correctly.
  const cacheSummary = formatDoctorCacheSummary(await cacheStats());

  return invokeCommand(
    deps.invocation,
    () =>
      doctor({
        buildReport: () =>
          buildDiagnosticsReport({
            noTools,
            effectiveProvider,
            descriptors: deps.providerDescriptors,
            env: deps.env,
            sleep: deps.searchSleep,
            random: deps.searchRandom,
            routing: deps.routing,
            cacheSummary,
            // T3b: thread the injected promoter + clock through to the
            // report builder so a successful probe can flip the matching
            // record from `unverified` to `verified`. When the promoter
            // is absent (hermetic test path), Doctor runs without
            // promotion. The write-failure sink surfaces promotion
            // errors as a stderr notice without affecting the exit code.
            verificationPromoter: deps.verificationPromoter,
            now: deps.now ?? Date.now,
            onPromotionError: (providerId, error) => {
              const message = error instanceof Error ? error.message : String(error);
              deps.invocation.writeStderr(
                `scoutline: verification promotion failed for "${providerId}": ${message}\n`,
              );
            },
            // PB-T5: thread the snapshot + verification records through
            // to the report builder so each Provider entry carries a
            // `quota` summary (source/freshness) and a `verification`
            // summary. Both are pure state reads; Doctor never
            // live-probes quota. The snapshot appears even under
            // --no-tools (a snapshot read is local state, not
            // transport).
            ...(deps.quotaState !== undefined ? { quotaSnapshot: deps.quotaState } : {}),
            ...(deps.verificationRecords !== undefined
              ? { verificationRecords: deps.verificationRecords }
              : {}),
          }),
      }),
    outputMode,
    deps.now,
    deps.secrets,
  );
}

/**
 * `scoutline cache <stats|clear>` — local cache utility. Like Doctor,
 * it bypasses Provider resolution entirely (no descriptor lookup, no
 * Adapter, no transport). The command surfaces the inventory and clear
 * helpers owned by `src/lib/cache.ts` (Ticket 01) through the
 * presentation-only handlers in `src/commands/cache.ts`.
 */
async function handleConfig(
  args: string[],
  outputMode: OutputMode,
  deps: HandlerDependencies,
): Promise<number> {
  const { flags, positional } = parseArgs(args);

  if (flags.help || flags.h || positional.length === 0) {
    deps.invocation.writeStdout(CONFIG_HELP);
    return 0;
  }

  // Config-store warnings (lenient load-time validation) surface on
  // stderr through the invocation adapter so test harnesses observe
  // them. The messages are our own static strings, not provider-authored.
  const onWarning = (warning: { message: string }): void => {
    deps.invocation.writeStderr(`Warning: ${warning.message}\n`);
  };

  // Config I/O resolves against the INJECTED env (which production
  // derives from process.env, and hermetic tests override with
  // SCOUTLINE_CONFIG_DIR) — never directly against process.env, so the
  // handler never reads or writes outside the invocation's environment.
  const configOptions = {
    filePath: configFilePath(
      resolveConfigRootPure(deps.env, { homedir: os.homedir() }),
    ),
    onWarning,
  };

  const subcommand = positional[0];
  switch (subcommand) {
    case "get":
      if (positional.length > 2) {
        throw new ValidationError(
          `config get takes at most one key (got ${positional.length - 1} arguments).`,
          "Usage: scoutline config get [key]",
        );
      }
      return invokeCommand(
        deps.invocation,
        () =>
          configGetCommand(positional[1], {
            read: () => readConfig(configOptions),
            secrets: () => configuredSecrets(deps.env),
          }),
        outputMode,
        deps.now,
        deps.secrets,
      );
    case "set": {
      const setPath = positional[1];
      const setValue = positional[2];
      if (setPath === undefined || setValue === undefined) {
        throw new ValidationError(
          "config set requires a key and a value",
          "Usage: scoutline config set <key> <value>",
        );
      }
      if (positional.length > 3) {
        throw new ValidationError(
          `config set takes exactly a key and a value (got ${positional.length - 1} arguments).`,
          "Usage: scoutline config set <key> <value>",
        );
      }
      return invokeCommand(
        deps.invocation,
        (context) =>
          configSetCommand(setPath, setValue, {
            set: (path, value) => setConfigValue(path, value, configOptions),
            // Registry-mandated enable-time warnings (e.g. the fan-out
            // cost sentence, search-fanout DESIGN D7) ride stderr.
            notify: context.notice,
          }),
        outputMode,
        deps.now,
        deps.secrets,
      );
    }
    case "unset": {
      const unsetPath = positional[1];
      if (unsetPath === undefined) {
        throw new ValidationError(
          "config unset requires a key",
          "Usage: scoutline config unset <key>",
        );
      }
      if (positional.length > 2) {
        throw new ValidationError(
          `config unset takes exactly one key (got ${positional.length - 1} arguments).`,
          "Usage: scoutline config unset <key>",
        );
      }
      return invokeCommand(
        deps.invocation,
        () =>
          configUnsetCommand(unsetPath, {
            unset: (path) => unsetConfigValue(path, configOptions),
          }),
        outputMode,
        deps.now,
        deps.secrets,
      );
    }
    default:
      throw new ValidationError(
        `Unknown config command: ${subcommand}`,
        'Run "scoutline config --help" for available commands',
      );
  }
}

/**
 * `scoutline cache <stats|clear|prune>` — local cache utility. Like
 * Doctor, it bypasses Provider resolution entirely (no descriptor
 * lookup, no Adapter, no transport). The command surfaces the inventory
 * and clear helpers owned by `src/lib/cache.ts` (Ticket 01) through the
 * presentation-only handlers in `src/commands/cache.ts`. The `prune`
 * case was added in Cache Prune Ticket 5 and parses `--older-than` /
 * `--provider` / `--capability` flags into the `PruneSelectors` shape
 * the lib expects (DESIGN D2/D3); unknown provider/capability values
 * are intentionally NOT pre-validated against the registry — they
 * filename-match nothing in the response cache while the selector-free
 * tool scan still runs (DESIGN D2/D4). `--provider` may appear before
 * or after the command token: `extractGlobalOptions` strips it either
 * way and this handler recovers it from `deps.provider`. A valueless
 * `--older-than`/`--provider`/`--capability` is a VALIDATION_ERROR. A
 * lock-acquire timeout in the production `pruneCaches` THROWS (DESIGN
 * D5) so the dispatcher's error boundary emits a sanitized stderr
 * envelope with exit 1.
 */
export async function handleCache(
  args: string[],
  outputMode: OutputMode,
  deps: HandlerDependencies,
): Promise<number> {
  const { flags, positional } = parseArgs(args);

  if (flags.help || flags.h || positional.length === 0) {
    deps.invocation.writeStdout(CACHE_HELP);
    return 0;
  }

  const subcommand = positional[0];
  switch (subcommand) {
    case "stats":
      return invokeCommand(
        deps.invocation,
        () =>
          cacheStatsCommand({
            getStats: () => cacheStats() as Promise<CacheStatsReport>,
          }),
        outputMode,
        deps.now,
        deps.secrets,
      );
    case "clear":
      return invokeCommand(
        deps.invocation,
        () =>
          cacheClearCommand({
            clear: () => clearAllCaches() as Promise<CacheClearReport>,
          }),
        outputMode,
        deps.now,
        deps.secrets,
      );
    case "prune": {
      // Parse `--older-than` into milliseconds. A null result is the
      // contract for any unparseable spec (DESIGN D3); surface it as a
      // VALIDATION_ERROR (exit 1) BEFORE entering the command seam so a
      // bad flag never touches the on-disk cache. The flag may be
      // absent (undefined) — in which case the lib falls back to the
      // effective TTL (DESIGN D3) — but if present, it must parse.
      let olderThanMs: number | undefined;
      const rawOlderThan = flags["older-than"];
      if (rawOlderThan !== undefined && rawOlderThan !== true) {
        const parsed = parsePruneDuration(rawOlderThan as string);
        if (parsed === null) {
          throw new ValidationError(
            `Invalid --older-than value "${rawOlderThan}"`,
            "Use one of: Nh, Nm, Ns, or N (seconds). Examples: --older-than 24h, --older-than 30m.",
          );
        }
        olderThanMs = parsed;
      } else if (rawOlderThan === true) {
        // `--older-than` without a value: same parse-level failure mode
        // as `--count` (Fixup D — see `parseAndValidateCount`).
        throw new ValidationError(
          "--older-than requires a value.",
          "Use one of: Nh, Nm, Ns, or N (seconds). Examples: --older-than 24h, --older-than 30m.",
        );
      }
      // parseArgs yields `true` for a value flag with no argument, so
      // the boolean case is real here (bare `--provider`/`--capability`
      // guard below); the cast must keep it, unlike the old
      // `as string | undefined`.
      const provider = flags.provider as string | boolean | undefined;
      const capability = flags.capability as string | boolean | undefined;
      // A value flag parsed as `true` means the user passed a bare
      // `--provider`/`--capability` with no value. Mirror the bare
      // `--older-than` guard above instead of letting the boolean match
      // nothing and silently prune/exchange nothing (review fixup).
      if (provider === true) {
        throw new ValidationError(
          "--provider requires a value.",
          "Pass a Provider id after --provider, e.g. --provider zai.",
        );
      }
      if (capability === true) {
        throw new ValidationError(
          "--capability requires a value.",
          "Pass a capability id after --capability, e.g. --capability search.",
        );
      }
      // `extractGlobalOptions` removes `--provider` (in either position)
      // from the args before `handleCache` sees them and threads the
      // value through `deps.provider`; direct/in-process callers still
      // pass the flag in `args`. Consult both so the selector works via
      // `main` AND via `handleCache(args, ...)` (review P1).
      const providerSelector =
        typeof provider === "string" ? provider : deps.provider;
      const capabilitySelector = typeof capability === "string" ? capability : undefined;
      // Build the selector shape the lib expects. Undefined flags are
      // omitted so the lib's optional-field contract is preserved. The
      // command seam receives this verbatim; production
      // `cachePruneCommand` and the in-process test double observe the
      // exact same object.
      const selectors: PruneSelectors = {
        ...(olderThanMs !== undefined ? { olderThanMs } : {}),
        ...(providerSelector !== undefined ? { provider: providerSelector } : {}),
        ...(capabilitySelector !== undefined ? { capability: capabilitySelector } : {}),
      };
      // The injected seam is the existing dependency seam (Ticket 5);
      // production wires the on-disk `pruneCaches` from `src/lib/cache.js`
      // via `MainDependencies.pruneCaches` and a `buildHandlerDeps`
      // override. When the seam is absent the dispatcher falls back to
      // the production function so call sites outside `main` continue
      // to work.
      const runPrune = deps.pruneCaches ?? pruneCaches;
      return invokeCommand(
        deps.invocation,
        () =>
          cachePruneCommand(
            { prune: (s) => runPrune(s) as Promise<CachePruneReport> },
            selectors,
          ),
        outputMode,
        deps.now,
        deps.secrets,
      );
    }
    default:
      throw new ValidationError(
        `Unknown cache command: ${subcommand}`,
        'Run "scoutline cache --help" for available commands',
      );
  }
}

async function handleQuota(
  args: string[],
  outputMode: OutputMode,
  deps: HandlerDependencies,
): Promise<number> {
  const { flags } = parseArgs(args);

  if (flags.help || flags.h) {
    deps.invocation.writeStdout(QUOTA_HELP);
    return 0;
  }

  const forceAllProviders = flags["all-providers"] === true;
  // Default mode is all-providers: plain `scoutline quota` reports every
  // configured Provider. A Provider is "explicitly pinned" when the user
  // passed --provider <id> or set SCOUTLINE_PROVIDER; a pin selects
  // single-Provider mode so `--provider tavily quota` (or
  // SCOUTLINE_PROVIDER=tavily) shows just that Provider. An explicit
  // --all-providers always wins, even under a pin.
  const providerExplicitlyPinned =
    deps.provider !== undefined || deps.env.SCOUTLINE_PROVIDER !== undefined;
  const allProviders = forceAllProviders || !providerExplicitlyPinned;
  // Resolve the effective Provider ID for dashboard metadata. Config
  // validation is owned by the dashboard builder (ConfigurationError,
  // exit 3) so an unconfigured default is reported as configuration, not
  // a registry error. Descriptors are intentionally NOT passed here so
  // all-provider mode is not blocked by an unconfigured effective.
  const effectiveProvider = resolveProviderId(deps.provider, deps.env);

  return invokeCommand(
    deps.invocation,
    () =>
      quota({
        buildDashboard: () =>
          buildQuotaDashboard({
            allProviders,
            effectiveProvider,
            descriptors: deps.providerDescriptors,
            env: deps.env,
            sleep: deps.searchSleep,
            random: deps.searchRandom,
            // PB-T5: thread the snapshot + store + clock through so the
            // dashboard reads each Provider's snapshot first, labels
            // source/freshness, and persists a live-probe fallback via
            // the awaited write-through. When `quotaState` is absent
            // (test path that didn't opt in), the snapshot path is
            // disabled and every configured Provider is live-probed
            // (byte-for-byte pre-PB-T5 behavior — no `quotaSource`
            // field attached).
            ...(deps.quotaState !== undefined ? { quotaSnapshot: deps.quotaState } : {}),
            ...(deps.quotaStore !== undefined ? { quotaStore: deps.quotaStore } : {}),
            now: deps.now ?? Date.now,
          }),
        writeStderr: (value) => deps.invocation.writeStderr(value),
        secrets: deps.secrets,
      }),
    outputMode,
    deps.now,
    deps.secrets,
  );
}

async function handleCode(
  args: string[],
  outputMode: OutputMode,
  deps: HandlerDependencies,
): Promise<number> {
  const { flags, positional } = parseArgs(args);

  if (flags.help || flags.h || positional.length === 0) {
    deps.invocation.writeStdout(CODE_HELP);
    return 0;
  }

  const command = positional[0];
  const timeout = flags.timeout ? parseInt(flags.timeout as string, 10) : undefined;
  const includeLogs = flags.logs === true;

  switch (command) {
    case "run": {
      const filePath = positional[1];
      if (!filePath) {
        throw new ValidationError("Missing code file", "Usage: scoutline code run <file>");
      }
      return invokeCommand(
        deps.invocation,
        (context) => runCodeFile(filePath, { timeout, includeLogs, env: deps.env }, context),
        outputMode,
        deps.now,
        deps.secrets,
      );
    }
    case "eval": {
      const code = positional.slice(1).join(" ");
      if (!code) {
        throw new ValidationError("Missing code string", "Usage: scoutline code eval <code>");
      }
      return invokeCommand(
        deps.invocation,
        (context) => evalCode(code, { timeout, includeLogs, env: deps.env }, context),
        outputMode,
        deps.now,
        deps.secrets,
      );
    }
    case "interfaces":
      return invokeCommand(
        deps.invocation,
        (context) => printInterfaces({ env: deps.env }, context),
        outputMode,
        deps.now,
        deps.secrets,
      );
    case "prompt":
      return invokeCommand(
        deps.invocation,
        async (context) => printPromptTemplate(context),
        outputMode,
        deps.now,
        deps.secrets,
      );
    default:
      throw new ValidationError(
        `Unknown code command: ${command}`,
        'Run "scoutline code --help" for available commands',
      );
  }
}

export interface MainDependencies {
  readonly invocation: CommandInvocationAdapter;
  readonly env: NodeJS.ProcessEnv;
  readonly now?: () => number;
  /**
   * Injectable Provider registry. Production defaults to the static
   * built-in descriptors; tests pass doubles to route Search through a
   * fake Adapter without touching real transports.
   */
  readonly providerDescriptors?: readonly ProviderDescriptor[];
  /**
   * Injectable config-file reader (T2a — Plan A). Production defaults to
   * `readConfig` from `lib/config-store.js`, which reads the versioned
   * `~/.scoutline/config.json`. Tests inject an in-memory double so
   * `main()` stays hermetic — no real config-root I/O — and can drive
   * file-only credential flows without touching disk.
   *
   * The reader returns the parsed {@link ScoutlineConfig}; `main` uses it
   * to build `resolvedEnv` (file keys layered under the injected env) and
   * to resolve `fallbackEnabled`. A returned config with no `providers`
   * and no `fallbackEnabled` is a no-op: the env path is byte-for-byte
   * unchanged from the pre-T2a behavior.
   */
  readonly loadScoutlineConfig?: () => Promise<ScoutlineConfig>;
  /**
   * Injectable fan-out activation override (search-fanout plan,
   * Ticket 3). When provided, this wins over the file-configured
   * `fanout` value so activation-tier tests stay hermetic (no real
   * config.json needed). Production leaves it undefined and derives
   * the switch from the loaded config.
   */
  readonly configFanout?: boolean;
  /**
   * Injectable shared-Search execution dependencies. Production defaults
   * to the on-disk cache and real sleep/random; tests inject in-memory
   * doubles for deterministic, offline behaviour.
   */
  readonly searchCache?: ResponseCache;
  readonly searchSleep?: (ms: number) => Promise<void>;
  readonly searchRandom?: () => number;
  /**
   * Injectable shared-Repository execution dependencies (P6-07).
   * Production defaults to the same on-disk cache and real sleep/random
   * as Search; tests inject in-memory doubles so Repository dispatch
   * tests stay isolated from Search state. These are NOT a rename of
   * the Search seams.
   */
  readonly repositoryCache?: ResponseCache;
  readonly repositorySleep?: (ms: number) => Promise<void>;
  readonly repositoryRandom?: () => number;
  /**
   * Injectable shared-Reader execution dependencies (Reader Migration
   * Ticket 04). Production defaults to the same on-disk cache and real
   * sleep/random as Search/Repository; tests inject in-memory doubles
   * so Reader dispatch tests stay isolated from Search/Repository
   * state. NOT a rename of either prior seam.
   */
  readonly readerCache?: ResponseCache;
  readonly readerSleep?: (ms: number) => Promise<void>;
  readonly readerRandom?: () => number;
  /**
   * Injectable shared-Crawl execution dependencies (Tavily integration
   * Ticket 05). Production defaults to the same on-disk cache and real
   * sleep/random as Search/Repository/Reader; tests inject in-memory
   * doubles so Crawl dispatch tests stay isolated. NOT a rename of any
   * prior seam.
   */
  readonly crawlCache?: ResponseCache;
  readonly crawlSleep?: (ms: number) => Promise<void>;
  readonly crawlRandom?: () => number;
  /**
   * Injectable shared-Map execution dependencies (Tavily integration
   * Ticket 06). Production defaults to the same on-disk cache and real
   * sleep/random as Search/Repository/Reader/Crawl; tests inject
   * in-memory doubles so Map dispatch tests stay isolated. NOT a rename
   * of any prior seam.
   */
  readonly mapCache?: ResponseCache;
  readonly mapSleep?: (ms: number) => Promise<void>;
  readonly mapRandom?: () => number;
  /**
   * Injectable shared-Research execution dependencies (Tavily integration
   * Ticket 07). Production defaults to the same on-disk cache and real
   * sleep/random as Search/Repository/Reader/Crawl/Map; tests inject
   * in-memory doubles so Research dispatch tests stay isolated. NOT a
   * rename of any prior seam.
   */
  readonly researchCache?: ResponseCache;
  readonly researchSleep?: (ms: number) => Promise<void>;
  readonly researchRandom?: () => number;
  /**
   * Optional injectable SIGINT registrar factory for the research
   * command. Production wraps `process.on('SIGINT', ...)` inside the
   * command module; tests inject a recorder so they can capture the
   * registered callback, trigger it manually, and assert the printed
   * resume command / state-file path / loser listener cleanup. The
   * factory receives the per-attempt state-file path + canonical
   * resume command (binding is computed inside the research handler
   * from the per-attempt Provider capability). Review Fix 3.
   */
  readonly researchRegisterInterrupt?: (
    stateFilePath: string,
    resumeCommand: string,
  ) => (print: () => void) => () => void;
  /**
   * Optional injectable prompt IO seam for the `init` wizard (T3a —
   * Plan A). Production wires `createInquirerPrompts` (which lazily
   * resolves `@inquirer/prompts`); tests inject a scripted double so
   * the wizard runs fully hermetically without a real TTY.
   */
  readonly initPrompts?: InitPrompts;
  /**
   * Optional injectable config-store seam for the `init` wizard (T3a).
   * Production wires `createDefaultConfigStore()` (real `inspectConfig`
   * + `writeConfig` against `~/.scoutline/config.json`); tests inject
   * a temp-dir-backed double so onboarding assertions never touch the
   * user's real config root.
   */
  readonly initConfigStore?: InitDependencies["configStore"];
  /**
   * Optional injectable verification-promotion store (T3b). Production
   * wires `createDefaultVerificationPromoter()` (real read-modify-write
   * against `~/.scoutline/config.json`); tests inject an in-memory
   * double so Doctor's promotion assertions stay hermetic. When
   * omitted, the production promoter is constructed at dispatch time.
   *
   * Doctor calls `promote(providerId, checkedAt)` after a successful
   * probe to flip the matching record from `unverified` to `verified`.
   * Best-effort: a write failure is isolated and never turns a
   * successful probe into a Doctor failure.
   */
  readonly verificationPromoter?: VerificationPromotionStore;
  /**
   * Optional injectable hint-shown store (T3b). Production wires
   * `createDefaultHintShownStore()`; tests inject an in-memory double
   * so the trigger-detection hint persistence assertions are hermetic.
   * When omitted, the production store is constructed at dispatch time.
   *
   * Trigger detection calls `setHintShown()` once after emitting the
   * env-only hint so the hint never repeats.
   */
  readonly hintShownStore?: HintShownStore;
  /**
   * Optional injectable quota snapshot store (PB-T1 — Plan B). Production
   * defaults to `createDefaultQuotaStore()` (real atomic read-merge-write
   * against `~/.scoutline/state.json`); tests inject an in-memory double
   * so refresh assertions stay hermetic. When omitted, the production
   * store is constructed at dispatch time.
   *
   * `main` refreshes the store BEFORE the `quota`/`doctor` handlers
   * (force) and AFTER every other credentialed command (cadence-gated
   * by the per-provider staleness threshold). All refreshes and store
   * writes are awaited before `main` returns so they survive the bin's
   * immediate `process.exit`.
   */
  readonly quotaStore?: QuotaStore;
  /**
   * Optional injectable verification records for Doctor's per-Provider
   * `verification` summary (PB-T5 — Plan B). Production maps
   * `config.providers[id].verification` (Plan A) to
   * `ProviderVerificationSummary` (capability contract — structural
   * twin kept separate so the capability contract stays free of
   * `lib/config-store.ts` imports); tests inject a crafted record so
   * Doctor assertions stay hermetic — no real `~/.scoutline/config.json`
   * read. When omitted, the production path derives the records from
   * the loaded `config`.
   */
  readonly verificationRecords?: Partial<Record<ProviderId, ProviderVerificationSummary>>;
  /**
   * Optional injectable consumption sink (PB-T2 — Plan B). Production
   * defaults to `createQuotaStoreConsumptionSink({ store: quotaStore })`
   * (writes through PB-T1's store, advancing `locallyUpdatedAt` and
   * adjusting the matching category's count set); tests inject an
   * in-memory double so event-sequence assertions stay hermetic.
   *
   * The sink records ONE event per billable `invoke()` attempt at the
   * execution seam (`lib/execution.ts`), so cache hits emit nothing,
   * retries emit one event per attempt, and observational handlers
   * (`quota`/`doctor`) emit nothing. Variable/unknown-cost capabilities
   * (Research, Vision, Crawl) persist an explicit `unknown` amount
   * rather than a fake-precise number.
   *
   * Hermeticity gate: the PRODUCTION sink is constructed only in full
   * production mode (no injected `loadScoutlineConfig` AND no injected
   * `providerDescriptors`). Either injection signals a test that owns
   * its own descriptor/config construction; the production sink would
   * otherwise reach the user's real `~/.scoutline/state.json` during
   * such a test. Dedicated consumption tests inject this field directly
   * with `createInMemoryConsumptionSink()`.
   */
  readonly consume?: ConsumptionSink;
  /**
   * Optional injectable quota snapshot for selection (PB-T4 — Plan B).
   * Production reads it once via `quotaStore.read()` after the PB-T1
   * pre-command refresh (the seven shared handlers consume it through
   * `resolveEffectiveProvider`); tests inject a crafted snapshot so
   * selection assertions are hermetic — no real `state.json` read.
   *
   * Hermeticity gate mirrors `quotaStore`/`consume`: the PRODUCTION
   * read happens only in full production mode (no injected
   * `loadScoutlineConfig` AND no injected `providerDescriptors`).
   * Either injection signals a test that owns its own
   * descriptor/config construction; such a test injects `quotaState`
   * directly when it needs to assert a specific selection outcome, or
   * leaves it absent so the resolver degrades to first-eligible (the
   * pre-PB-T4 behaviour).
   */
  readonly quotaState?: QuotaState;
  /**
   * Optional injectable `pruneCaches` for the `cache prune` subcommand
   * (Cache Prune Ticket 5). Production defaults to the on-disk
   * `pruneCaches` from `src/lib/cache.js`; tests inject a double so the
   * dispatcher's selector-parsing / error-propagation contract can be
   * exercised without touching disk. When omitted, the dispatcher
   * falls back to the production function so the seam stays opt-in.
   */
  readonly pruneCaches?: (selectors: PruneSelectors) => Promise<PruneCachesResult>;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Map Plan A's `ProviderVerification` records (config-store shape) to
 * the capability contract's `ProviderVerificationSummary` (PB-T5). The
 * shapes are structurally identical; the indirection exists only so
 * `capabilities/diagnostics.ts` does not import `lib/config-store.ts`
 * (the capability contract keeps a strict import boundary). Returns
 * `undefined` when no Provider has a verification record, so the
 * dispatcher can omit the dependency entirely (Doctor's report builder
 * leaves the `verification` field off in that case).
 *
 * When the caller injected its own `verificationRecords` (test path),
 * that injection wins — the test owns the verification view.
 */
function loadVerificationRecords(
  config: ScoutlineConfig,
  dependencies: MainDependencies,
): Partial<Record<ProviderId, ProviderVerificationSummary>> | undefined {
  if (dependencies.verificationRecords !== undefined) return dependencies.verificationRecords;
  const out: Partial<Record<ProviderId, ProviderVerificationSummary>> = {};
  let hasAny = false;
  for (const id of Object.keys(config.providers) as ProviderId[]) {
    const record: ProviderVerification | undefined = config.providers[id]?.verification;
    if (!record) continue;
    out[id] = {
      status: record.status,
      checkedAt: record.checkedAt,
      ...(record.reason !== undefined ? { reason: record.reason } : {}),
    };
    hasAny = true;
  }
  return hasAny ? out : undefined;
}

export async function main(
  args: readonly string[],
  dependencies: MainDependencies,
): Promise<number> {
  const { invocation, env, now } = dependencies;
  const providerDescriptors = dependencies.providerDescriptors ?? BUILT_IN_PROVIDER_DESCRIPTORS;
  const searchCache = dependencies.searchCache ?? defaultResponseCache;
  const searchSleep = dependencies.searchSleep ?? realSleep;
  const searchRandom = dependencies.searchRandom ?? Math.random;
  // P6-07: Repository execution defaults to the same production values
  // as Search but stays as separate optional MainDependencies so
  // repository tests can inject isolated in-memory doubles.
  const repositoryCache = dependencies.repositoryCache ?? defaultResponseCache;
  const repositorySleep = dependencies.repositorySleep ?? realSleep;
  const repositoryRandom = dependencies.repositoryRandom ?? Math.random;
  // Reader Migration Ticket 04: Reader execution defaults to the same
  // production values as Search/Repository but stays as separate
  // optional MainDependencies so reader tests can inject isolated
  // in-memory doubles.
  const readerCache = dependencies.readerCache ?? defaultResponseCache;
  const readerSleep = dependencies.readerSleep ?? realSleep;
  const readerRandom = dependencies.readerRandom ?? Math.random;
  // Tavily integration Ticket 05: Crawl execution defaults to the same
  // production values as Search/Repository/Reader but stays as separate
  // optional MainDependencies so crawl tests can inject isolated
  // in-memory doubles.
  const crawlCache = dependencies.crawlCache ?? defaultResponseCache;
  const crawlSleep = dependencies.crawlSleep ?? realSleep;
  const crawlRandom = dependencies.crawlRandom ?? Math.random;
  // Tavily integration Ticket 06: Map execution defaults to the same
  // production values as Search/Repository/Reader/Crawl but stays as
  // separate optional MainDependencies so map tests can inject isolated
  // in-memory doubles.
  const mapCache = dependencies.mapCache ?? defaultResponseCache;
  const mapSleep = dependencies.mapSleep ?? realSleep;
  const mapRandom = dependencies.mapRandom ?? Math.random;
  // Tavily integration Ticket 07: Research execution defaults to the same
  // production values as Search/Repository/Reader/Crawl/Map but stays as
  // separate optional MainDependencies so research tests can inject
  // isolated in-memory doubles.
  const researchCache = dependencies.researchCache ?? defaultResponseCache;
  const researchSleep = dependencies.researchSleep ?? realSleep;
  const researchRandom = dependencies.researchRandom ?? Math.random;
  // Resolve configured Provider credentials from the INJECTED env (B3) so
  // redaction follows the same environment the handlers see — a secret
  // that exists only in MainDependencies.env is still redacted from output.
  // T2a: this env-only view is used by credential-free commands that
  // short-circuit before config load; the full resolvedEnv (env + file keys)
  // is computed below for credentialed paths.
  const envSecrets = configuredSecrets(env);

  // Extraction can now throw (valueless trailing `--provider`); give it
  // the same error boundary as `resolveOutputMode` below — a sanitized
  // envelope in the output mode the argv requested (re-derived from the
  // raw argv via `bestEffortOutputMode` because the partially parsed
  // result never escapes the throw) and the error's exit code.
  let extracted: ReturnType<typeof extractGlobalOptions>;
  try {
    extracted = extractGlobalOptions([...args]);
  } catch (error) {
    invocation.writeStderr(
      formatErrorOutput(error, bestEffortOutputMode(args, invocation), envSecrets),
    );
    return getErrorExitCode(error);
  }
  const { outputFormat, forcePretty, forceRaw, provider, noFallback, rest } = extracted;

  // Fixup C — B10: resolve the output mode BEFORE the dispatch try/catch.
  // An invalid explicit mode still surfaces as a typed ValidationError,
  // but the surface formatter uses the user's REQUESTED mode (or the
  // best deterministic fallback) so the envelope matches what the user
  // asked for. Pre-invocation validation errors (provider resolution,
  // missing credentials, count parsing, etc.) MUST honour the requested
  // output mode the same way handler errors do.
  let outputMode: OutputMode;
  try {
    outputMode = resolveOutputMode(
      outputFormat,
      forcePretty ?? false,
      forceRaw ?? false,
      invocation,
    );
  } catch (error) {
    // The explicit mode is invalid — fall back to a deterministic
    // compact form so we can still surface a structured error envelope.
    invocation.writeStderr(formatErrorOutput(error, "data", envSecrets));
    return getErrorExitCode(error);
  }

  // Credential-free commands: --help / --version short-circuit before any
  // config-file load so a corrupt or unreadable config.json never blocks
  // them (T2a — command classification).
  if (rest.length === 0 || rest[0] === "--help" || rest[0] === "-h") {
    invocation.writeStdout(MAIN_HELP);
    return 0;
  }

  if (rest[0] === "--version" || rest[0] === "-v") {
    invocation.writeStdout(VERSION);
    return 0;
  }

  const command = rest[0] ?? "";
  const commandArgs = rest.slice(1);

  // PB-T1/PB-T2 — Quota snapshot store + consumption sink.
  //
  // Constructed once here so `buildHandlerDeps` can close over
  // `consume` and thread it through every handler. The hermeticity
  // gate (`quotaRefreshEnabled`, mirroring trigger-detection): the
  // PRODUCTION sink is built ONLY in full production mode (no
  // injected `loadScoutlineConfig` AND no injected `providerDescriptors`).
  // Either injection signals a test that owns its own descriptor/config
  // construction; without this gate, the production sink would silently
  // reach the user's real `~/.scoutline/state.json` during a test run
  // that did not inject `quotaStore` either. Tests that need to assert
  // on consumption inject `MainDependencies.consume` directly.
  //
  // The sink is the *where* of consumption recording; shared execution
  // (`lib/execution.ts`) is the *when* (one event per billable invoke
  // attempt, after the cache-miss check, around each `invoke()` call).
  // Shared execution awaits `record()` per invoke attempt, so the write
  // is on the critical path before the result returns outward —
  // surviving the bin's immediate `process.exit(status)`.
  const quotaRefreshEnabled =
    !dependencies.loadScoutlineConfig && !dependencies.providerDescriptors;
  const quotaStore = dependencies.quotaStore ?? createDefaultQuotaStore();
  const consume: ConsumptionSink | undefined =
    dependencies.consume ??
    (quotaRefreshEnabled
      ? createQuotaStoreConsumptionSink({ store: quotaStore, now: now ?? Date.now })
      : undefined);
  // PB-T4: quota snapshot for selection. Declared here so
  // `buildHandlerDeps` closes over the binding; assigned AFTER the
  // PB-T1 pre-command refresh so observational commands' fresh data is
  // reflected. The seven shared handlers consume this via
  // `resolveEffectiveProvider`; Doctor/quota/cache/init/raw-tools
  // ignore it. Hermeticity gate mirrors `consume`: the PRODUCTION read
  // runs only in full production mode; tests inject `quotaState`
  // directly when they assert a specific selection outcome, and
  // otherwise leave it undefined so the resolver degrades to
  // first-eligible (pre-PB-T4 behaviour).
  let quotaState: QuotaState | undefined = dependencies.quotaState;

  // Build HandlerDependencies for a given credential view. The
  // cache/sleep/random fields are always available (resolved above); only
  // env/secrets/fallbackEnabled depend on whether config has been loaded.
  const buildHandlerDeps = (
    credEnv: NodeJS.ProcessEnv,
    credSecrets: string[],
    credFallback: boolean,
    credRouting: HandlerDependencies["routing"] = undefined,
    credFanout: boolean | undefined = undefined,
  ): HandlerDependencies => ({
    invocation,
    env: credEnv,
    secrets: credSecrets,
    now,
    provider,
    providerDescriptors,
    fallbackEnabled: credFallback,
    routing: credRouting,
    configFanout: credFanout,
    searchCache,
    searchSleep,
    searchRandom,
    repositoryCache,
    repositorySleep,
    repositoryRandom,
    readerCache,
    readerSleep,
    readerRandom,
    crawlCache,
    crawlSleep,
    crawlRandom,
    mapCache,
    mapSleep,
    mapRandom,
    researchCache,
    researchSleep,
    researchRandom,
    researchRegisterInterrupt: dependencies.researchRegisterInterrupt,
    // Promoter wiring (T3b). When the caller explicitly injects a
    // promoter, use it (tests assert behavior this way). Otherwise, in
    // PRODUCTION (no injected config reader), construct the default
    // real-file promoter. When a test injects `loadScoutlineConfig`
    // (hermetic in-memory config), promotion is DISABLED so the
    // default promoter never reaches the user's real
    // ~/.scoutline/config.json during a test run.
    verificationPromoter:
      dependencies.verificationPromoter ??
      (dependencies.loadScoutlineConfig ? undefined : createDefaultVerificationPromoter()),
    // PB-T2: thread the production consumption sink through. `consume`
    // is constructed once in `main` (below) and shared by every
    // handler; tests inject their own through `MainDependencies.consume`.
    // When undefined (test path that didn't opt in), no events fire.
    consume,
    // PB-T4: thread the quota snapshot for selection. `quotaState` is
    // resolved once in `main` (below) after the PB-T1 pre-command
    // refresh and shared by every handler; tests inject their own
    // through `MainDependencies.quotaState`. When undefined (test path
    // or no-snapshot production run), `resolveEffectiveProvider`
    // degrades to first-eligible in registry order.
    quotaState,
    // PB-T5: thread the quota store for `quota`'s live-probe
    // write-through. Doctor ignores this field (it never live-probes
    // quota). Tests inject an in-memory double; production wires the
    // singleton constructed in `main`.
    quotaStore: dependencies.quotaStore ?? (quotaRefreshEnabled ? quotaStore : undefined),
    // Cache Prune Ticket 5: thread the optional injected `pruneCaches`
    // through to `handleCache`. Production defaults to the on-disk
    // function from `src/lib/cache.js`; tests inject a double so the
    // dispatcher contract can be exercised without touching disk.
    pruneCaches: dependencies.pruneCaches,
    // PB-T5: verification records are NOT threaded here. They are
    // derived from `config` AFTER it is loaded (the credentialed
    // path); `buildHandlerDeps` runs once BEFORE config load (the
    // cache short-circuit), so referencing `config` here would be a
    // use-before-initialization error. The post-config
    // `handlerDepsWithVerification` spread below threads the resolved
    // records in for Doctor.
  });

  // Cache is credential-free (no Provider resolution, no descriptor lookup,
  // no transport). Short-circuit before config load so a corrupt
  // config.json never blocks cache inspection or clearing. Env-only
  // secrets suffice: the stats/clear output carries no credentials.
  if (command === "cache") {
    try {
      return await handleCache(commandArgs, outputMode, buildHandlerDeps(env, envSecrets, true));
    } catch (error) {
      invocation.writeStderr(formatErrorOutput(error, outputMode, envSecrets));
      return getErrorExitCode(error);
    }
  }

  // `init` manages config itself (it inspects + writes via the T1
  // primitives, never reads the resolvedEnv the credentialed path
  // produces). Short-circuit before the credentialed config load so a
  // corrupt or unreadable config.json never blocks the wizard that is
  // documented to repair it. The wizard is presented-only; it does not
  // dispatch through the credentialed handler boundary. Release gate
  // (T3a ticket): the command's code lands now, but its public docs
  // (MAIN_HELP Commands list, README setup, skills/) wait for T3b.
  if (command === "init") {
    const initDeps: InitDependencies = {
      descriptors: providerDescriptors,
      prompts: dependencies.initPrompts ?? createInquirerPrompts(),
      configStore: dependencies.initConfigStore ?? createDefaultConfigStore(),
      env,
      now: now ?? Date.now,
      stdinIsTTY: invocation.stdinIsTTY,
      writeStderr: (value) => invocation.writeStderr(value),
      writeStdout: (value) => invocation.writeStdout(value),
    };
    try {
      return await handleInitWithHelp(commandArgs, initDeps);
    } catch (error) {
      invocation.writeStderr(formatErrorOutput(error, outputMode, envSecrets));
      return getErrorExitCode(error);
    }
  }

  // `config` manages config.json itself through the typed key registry:
  // its own read/parse/write resolves against the INJECTED env, never
  // resolvedEnv, so the dispatcher's inspected file (ambient env) can
  // never diverge from the file the command acts on. Short-circuit
  // before the credentialed config load so a corrupt or unreadable
  // config.json never blocks the command family documented to inspect
  // and repair it (same rationale as `cache`/`init`).
  if (command === "config") {
    try {
      return await handleConfig(commandArgs, outputMode, buildHandlerDeps(env, envSecrets, true));
    } catch (error) {
      invocation.writeStderr(formatErrorOutput(error, outputMode, envSecrets));
      return getErrorExitCode(error);
    }
  }

  // Credentialed path: load the config file (T2a — Plan A). T3b makes
  // the load TOLERANT so command help remains usable under a corrupt
  // config (review item 9: "do not force a credential check merely to
  // render help"). The injected reader (when provided) is still strict
  // for backward compatibility with existing tests; the production
  // path uses `inspectConfig`.
  //
  // Classification of the corrupt case:
  //   - command help (`<cmd> --help`): proceed with an empty config so
  //     the handler can render its help. The handler's own help
  //     short-circuit never touches config.
  //   - everything else (including observational `doctor`/`quota`):
  //     refuse with the existing CONFIGURATION_ERROR (exit 3). The
  //     error's help points at `init` as the recovery path.
  // Observational commands do NOT bypass the corrupt refuse — they
  // still need `resolvedEnv` (which needs config) to probe/report.
  const isHelpInvocation = isCommandHelpInvocation(commandArgs);
  const isObservational = OBSERVATIONAL_COMMANDS.has(command);

  let config: ScoutlineConfig;
  if (dependencies.loadScoutlineConfig) {
    try {
      config = await dependencies.loadScoutlineConfig();
    } catch (error) {
      if (isHelpInvocation) {
        config = { version: 1, providers: {} };
      } else {
        invocation.writeStderr(formatErrorOutput(error, outputMode, envSecrets));
        return getErrorExitCode(error);
      }
    }
  } else {
    const inspection = await inspectConfig();
    if (inspection.status === "corrupt") {
      if (isHelpInvocation) {
        config = { version: 1, providers: {} };
      } else {
        invocation.writeStderr(formatErrorOutput(inspection.error, outputMode, envSecrets));
        return getErrorExitCode(inspection.error);
      }
    } else if (inspection.status === "absent") {
      config = { version: 1, providers: {} };
    } else {
      config = inspection.config;
    }
  }

  // Build resolvedEnv: the injected env with file-configured API keys
  // layered in for any Provider NOT already configured via env (env
  // overrides file; alias precedence preserved). process.env is never
  // mutated — the returned object is a fresh shallow copy owned by this
  // invocation.
  const resolvedEnv = resolveEnvFromConfig(env, config, providerDescriptors);
  const secrets = configuredSecrets(resolvedEnv);

  // Trigger detection (T3b — Option B). The ONLY interception here is
  // the env-only one-time hint: when the user is running on
  // environment-variable credentials and has never been through
  // `scoutline init`, we emit a single stderr hint pointing at the
  // wizard and persist `config.json.hintShown` so it never repeats.
  // The command then runs normally and preserves its natural output/exit.
  //
  // The "missing credential everywhere" case is NOT intercepted here:
  // the handler's own preflight already surfaces the existing
  // `CONFIGURATION_ERROR` exit 3 (see
  // {@link missingCredentialError} in trigger-detection.ts for the
  // shared error contract). Intercepting it pre-dispatch would break
  // the locked validation-before-configuration ordering (an invalid
  // `--count` must exit 1 with VALIDATION_ERROR even when no credential
  // is present — see search.test.js "count validation ordering").
  //
  // Hermeticity: trigger detection runs ONLY in full production mode
  // (no injected `loadScoutlineConfig` AND no injected
  // `providerDescriptors`). Either injection signals a test that owns
  // its own config/descriptor construction; fake descriptors routinely
  // lie about `isConfigured`, so trusting them here would mis-classify.
  // Dedicated trigger-detection tests run via subprocess (the real
  // binary) or via `main()` without injecting either, optionally
  // pointed at a temp `SCOUTLINE_CONFIG_DIR`.
  const triggerDetectionEnabled =
    !dependencies.loadScoutlineConfig && !dependencies.providerDescriptors;
  if (triggerDetectionEnabled && !isHelpInvocation && !isObservational) {
    const state = classifyCredentialState({
      descriptors: providerDescriptors,
      env,
      resolvedEnv,
      config,
    });
    if (state.kind === "env-only" && config.hintShown !== true) {
      invocation.writeStderr(formatEnvOnlyHint());
      // Persist hintShown best-effort. A write failure is isolated: the
      // hint simply does not repeat within this process; the next run
      // tries again. The injected store keeps tests hermetic.
      const hintStore = dependencies.hintShownStore ?? createDefaultHintShownStore();
      try {
        await hintStore.setHintShown();
      } catch {
        // Best-effort: do not turn a hint into a failure.
      }
    }
  }

  // Provider-fallback resolution (T2a — review blocker 5). Precedence:
  //   1. Invocation opt-out (`--no-fallback` flag or `SCOUTLINE_NO_FALLBACK`
  //      env non-empty) — either disables the cross-Provider candidate
  //      loop, matching the 0.11.0 kill-switch contract.
  //   2. `config.fallbackEnabled` — the wizard's Step-5 preference, so the
  //      onboarding answer is no longer write-only.
  //   3. Default `true` (the 0.11.0 always-on contract).
  const envDisablesFallback =
    typeof env.SCOUTLINE_NO_FALLBACK === "string" && env.SCOUTLINE_NO_FALLBACK.length > 0;
  const fallbackEnabled =
    noFallback || envDisablesFallback ? false : (config.fallbackEnabled ?? true);

  // Ticket 3 — resolve the fan-out activation switch. The injected
  // `MainDependencies.configFanout` (tests) wins over the file-configured
  // value; the typed registry row + `config set fanout` surface arrive in
  // Ticket 4. Read leniently: an absent or non-boolean field simply means
  // fan-out stays off.
  const configFanout =
    dependencies.configFanout ?? ((config as { fanout?: unknown }).fanout === true);
  const handlerDeps = buildHandlerDeps(
    resolvedEnv,
    secrets,
    fallbackEnabled,
    config.routing,
    configFanout,
  );

  // PB-T5 — derive Plan A verification records from the loaded config
  // AFTER `config` is in scope. `buildHandlerDeps` runs once BEFORE
  // config load (the cache short-circuit), so this derivation cannot
  // live inside it (TDZ on `config`). Returned as a fresh spread so
  // the cache/init paths that already returned are unaffected; only
  // the credentialed handler chain sees the verification records.
  // Returns `undefined` when no Provider has a verification record,
  // leaving the field absent (Doctor's report builder omits the
  // `verification` field in that case — backward-compatible).
  const verificationRecords = loadVerificationRecords(config, dependencies);
  const handlerDepsWithVerification: HandlerDependencies =
    verificationRecords === undefined ? handlerDeps : { ...handlerDeps, verificationRecords };

  // PB-T1 — Quota snapshot refresh lifecycle.
  //
  // The refresh is awaited and bounded (review blocker 3): every
  // refresh and store write is awaited before `main` returns so it
  // survives the bin's immediate `process.exit(status)`. There is no
  // fire-and-forget tail.
  //
  // Two triggers:
  //   1. Explicit `quota`/`doctor` refresh (force) — runs BEFORE the
  //      handler so the dashboard/report reflects fresh data. The
  //      cadence gate is bypassed (the user asked for fresh data); the
  //      per-provider transport timeout + single-attempt contract
  //      still applies.
  //   2. After-command due-refresh (cadence-gated) — runs AFTER every
  //      other recognized credentialed command. A provider whose
  //      `observedAt` is within the staleness threshold is skipped
  //      (Tavily's 10/10min is the floor). This keeps the snapshot
  //      live between explicit refreshes without excessive polling.
  //
  // Failure policy: best-effort. A per-provider refresh failure is
  // routed to a stderr notice and never rejects the outer promise. The
  // snapshot stays stale; the next due-refresh retries.
  //
  // Lock scope: each provider's `capability.invoke()` runs in parallel
  // (Promise.all). Store writes are serialized within the process by
  // the per-file async mutex in `createDefaultQuotaStore`. Cross-process
  // concurrency is last-write-wins (acceptable for an observational
  // heuristic; the atomic rename keeps the final state crash-safe).
  //
  // Hermeticity gate: the refresh runs ONLY in full production mode
  // (no injected `loadScoutlineConfig` AND no injected
  // `providerDescriptors`). Either injection signals a test that owns
  // its own descriptor/config construction; fake descriptors routinely
  // count `invoke()` calls and would see the refresh as a stray
  // invocation. Dedicated refresh lifecycle tests run via subprocess
  // (the real binary) or through `refreshQuotaSnapshots` directly.
  // This mirrors the trigger-detection gate (T3b).
  //
  // (`quotaRefreshEnabled`, `quotaStore`, and `consume` are declared
  // earlier alongside `buildHandlerDeps` so the sink closes over a
  // defined binding — see PB-T2 above.)
  const isQuotaObservationalCommand = command === "quota" || command === "doctor";
  const refreshOnError = (_providerId: string, _error: unknown): void => {
    // Silent: quota-refresh failures are best-effort. Writing to stderr
    // would violate the JSON error contract (stderr is reserved for the
    // structured error envelope; data-only stdout).
  };

  if (quotaRefreshEnabled && isQuotaObservationalCommand) {
    await refreshQuotaSnapshots({
      descriptors: providerDescriptors,
      env: resolvedEnv,
      store: quotaStore,
      now: now ?? Date.now,
      force: true,
      onError: refreshOnError,
    });
  }

  // PB-T4: read the quota snapshot once for selection, AFTER any
  // pre-command refresh so observational commands' fresh data is
  // reflected. `quotaStore.read()` is fail-open (a corrupt or absent
  // `state.json` yields an empty state + warning, never a throw), so
  // this can never block dispatch. Tests that need a specific
  // selection outcome inject `MainDependencies.quotaState` directly,
  // which short-circuits this read. The snapshot is observational; the
  // resolver never writes or decrements it.
  if (dependencies.quotaState === undefined && quotaRefreshEnabled) {
    quotaState = await quotaStore.read();
  }
  // Thread the resolved snapshot into the handler deps. When undefined
  // (test path that didn't opt in, or non-production mode without an
  // injected snapshot), `resolveEffectiveProvider` degrades to
  // first-eligible — the pre-PB-T4 behaviour. Built on top of
  // `handlerDepsWithVerification` so PB-T5's verification records also
  // reach every handler.
  const handlerDepsWithSelection: HandlerDependencies =
    quotaState === undefined
      ? handlerDepsWithVerification
      : { ...handlerDepsWithVerification, quotaState };

  let exitCode: number;
  let commandRecognized = false;
  try {
    switch (command) {
      case "vision":
        commandRecognized = true;
        exitCode = await handleVision(commandArgs, outputMode, handlerDepsWithSelection);
        break;
      case "search":
        commandRecognized = true;
        exitCode = await handleSearch(commandArgs, outputMode, handlerDepsWithSelection);
        break;
      case "read":
        commandRecognized = true;
        exitCode = await handleRead(commandArgs, outputMode, handlerDepsWithSelection);
        break;
      case "crawl":
        commandRecognized = true;
        exitCode = await handleCrawl(commandArgs, outputMode, handlerDepsWithSelection);
        break;
      case "map":
        commandRecognized = true;
        exitCode = await handleMap(commandArgs, outputMode, handlerDepsWithSelection);
        break;
      case "research":
        commandRecognized = true;
        exitCode = await handleResearch(commandArgs, outputMode, handlerDepsWithSelection);
        break;
      case "repo":
        commandRecognized = true;
        exitCode = await handleRepo(commandArgs, outputMode, handlerDepsWithSelection);
        break;
      case "tools":
        commandRecognized = true;
        exitCode = await handleTools(commandArgs, outputMode, handlerDepsWithSelection);
        break;
      case "tool":
        commandRecognized = true;
        exitCode = await handleTool(commandArgs, outputMode, handlerDepsWithSelection);
        break;
      case "call":
        commandRecognized = true;
        exitCode = await handleCall(commandArgs, outputMode, handlerDepsWithSelection);
        break;
      case "doctor":
        commandRecognized = true;
        exitCode = await handleDoctor(commandArgs, outputMode, handlerDepsWithSelection);
        break;
      case "quota":
        commandRecognized = true;
        exitCode = await handleQuota(commandArgs, outputMode, handlerDepsWithSelection);
        break;
      case "code":
        commandRecognized = true;
        exitCode = await handleCode(commandArgs, outputMode, handlerDepsWithSelection);
        break;
      default:
        invocation.writeStderr(
          formatErrorOutput(
            new ValidationError(
              `Unknown command: ${command}`,
              'Run "scoutline --help" for available commands',
            ),
            outputMode,
            secrets,
          ),
        );
        exitCode = 1;
        break;
    }
  } catch (error) {
    // Fixup C — B10: pre-invocation validation errors (provider
    // resolution, missing credential, count parsing, etc.) MUST be
    // formatted in the resolved output mode — they used to be hardcoded
    // to "data" regardless of what the user asked for.
    invocation.writeStderr(formatErrorOutput(error, outputMode, secrets));
    exitCode = getErrorExitCode(error);
    commandRecognized = true;
  }

  // After-command due-refresh (cadence-gated). Skip for:
  //   - `quota`/`doctor` (already force-refreshed before the handler)
  //   - help invocations (`<cmd> --help` exits 0 but did no real work)
  //   - unrecognized commands (the default case above)
  // Run even when the handler threw (commandRecognized + caught):
  // the refresh is independent of the command's outcome and the
  // snapshot stays live regardless. The staleness check inside
  // `refreshQuotaSnapshots` skips providers whose `observedAt` is
  // within the threshold, so the common case (fresh snapshot) is a
  // single state-file read + no transport calls.
  if (
    quotaRefreshEnabled &&
    commandRecognized &&
    !isQuotaObservationalCommand &&
    !isHelpInvocation
  ) {
    await refreshQuotaSnapshots({
      descriptors: providerDescriptors,
      env: resolvedEnv,
      store: quotaStore,
      now: now ?? Date.now,
      force: false,
      // Silent: background quota-refresh failures must not pollute the
      // command's stderr (best-effort observational; use `scoutline quota`
      // or `doctor` to see refresh errors).
      onError: () => {},
    });
  }

  return exitCode;
}
