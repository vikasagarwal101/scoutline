/**
 * scoutline - CLI for Z.AI capabilities
 */

import * as vision from "./commands/vision.js";
import type { VisionExecutionDependencies } from "./commands/vision.js";
import { search, SEARCH_HELP } from "./commands/search.js";
import { read, READ_HELP } from "./commands/read.js";
import { crawl, CRAWL_HELP } from "./commands/crawl.js";
import { map, MAP_HELP } from "./commands/map.js";
import { research, RESEARCH_HELP } from "./commands/research.js";
import { repoSearch, repoTree, repoRead, REPO_HELP } from "./commands/repo.js";
import { listTools, showTool, callTool, TOOLS_HELP, CALL_HELP } from "./commands/tools.js";
import { doctor, buildDiagnosticsReport, DOCTOR_HELP } from "./commands/doctor.js";
import { quota, buildQuotaDashboard, QUOTA_HELP } from "./commands/quota.js";
import {
  cacheStatsCommand,
  cacheClearCommand,
  formatDoctorCacheSummary,
  CACHE_HELP,
  type CacheStatsReport,
  type CacheClearReport,
} from "./commands/cache.js";
import { cacheStats, clearAllCaches } from "./lib/cache.js";
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
import { invokeCommand, type CommandInvocationAdapter } from "./command-invocation.js";
import { defaultResponseCache, type ResponseCache } from "./lib/cache.js";
import { configuredSecrets } from "./lib/redact.js";
import { resolveProviderId } from "./providers/selection.js";
import { BUILT_IN_PROVIDER_DESCRIPTORS, getProviderDescriptor } from "./providers/registry.js";
import type { ProviderDescriptor, ProviderId } from "./providers/types.js";
import type { SearchCapability } from "./capabilities/search.js";
import type { ExecutionDependencies } from "./lib/execution.js";
import { visionOperationToCapability, type VisionOperation } from "./capabilities/vision.js";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { version: VERSION } = require("../package.json") as { version: string };

const MAIN_HELP = `
scoutline v${VERSION} - Multimodal source investigation CLI

Usage: scoutline <command> [args] [options]

Commands:
  vision   Image and video analysis (Z.AI; MiniMax for interpret-image)
  search   Real-time web search (shared: Z.AI + MiniMax + Tavily; --topic
           honored by every Provider)
  read     Fetch and parse web pages (Provider Capability; Z.AI and Tavily
           supply it, MiniMax returns UNSUPPORTED_CAPABILITY)
  crawl    Crawl a website from a starting URL (Provider Capability; Tavily
           supports it, Z.AI/MiniMax return UNSUPPORTED_CAPABILITY)
  map      Discover the URL structure of a website (Provider Capability;
           Tavily supports it, Z.AI/MiniMax return UNSUPPORTED_CAPABILITY)
  research Deep research with citations (Provider Capability; Tavily
           supports it, Z.AI/MiniMax return UNSUPPORTED_CAPABILITY)
  repo     GitHub repository exploration (Provider Capability; Z.AI supports it,
           MiniMax and Tavily return UNSUPPORTED_CAPABILITY)
  quota    Provider-aware plan usage (calls remaining, reset time)
  tools    List available MCP tools (Z.AI)
  tool     Show a tool schema (Z.AI)
  call     Call a tool directly (Z.AI)
  doctor   Provider-aware environment + connectivity checks
  cache    Inspect or clear the local cache (stats / clear)
  code     Execute TypeScript tool chains (Code Mode, Z.AI)

Provider selection (precedence: --provider, then SCOUTLINE_PROVIDER, then zai):
  --provider <zai|minimax|tavily|exa>   Select the active Provider for shared capabilities
  SCOUTLINE_PROVIDER=<id>    Fallback when --provider is not passed

Shared capabilities accept --provider. The 'repo', 'read', 'crawl', 'map',
and 'research' commands participate in Provider selection: Z.AI
advertises and supplies repository-exploration and reader; Tavily
advertises and supplies reader plus crawl, map, and research; Exa
advertises and supplies search and diagnostics only; MiniMax
advertises and supplies none of those Provider-only Capabilities. A
non-supplier returns UNSUPPORTED_CAPABILITY with no fallback. Z.AI-only
commands (tools, tool, call, code) carry the flag but ignore it.
Quota and doctor report per-Provider; --provider picks the effective
Provider for metadata.

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

function extractGlobalOptions(args: string[]): {
  outputFormat?: string;
  forcePretty?: boolean;
  forceRaw?: boolean;
  provider?: string;
  rest: string[];
} {
  const rest: string[] = [];
  let outputFormat: string | undefined;
  let forcePretty = false;
  let forceRaw = false;
  let provider: string | undefined;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
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
      provider = args[i + 1];
      i += 1;
      continue;
    }
    rest.push(arg);
  }

  return { outputFormat, forcePretty, forceRaw, provider, rest };
}

function resolveOutputMode(
  explicit: string | undefined,
  forcePretty: boolean,
  forceRaw: boolean,
  adapter: CommandInvocationAdapter,
): OutputMode {
  if (explicit !== undefined) {
    if (!isOutputMode(explicit)) {
      throw new ValidationError(
        `Invalid output format: ${explicit}`,
        `Use one of: ${OUTPUT_MODES.join(", ")}`,
      );
    }
    return explicit;
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
 * resolve/validate it; the remaining Z.AI-only command families (tools,
 * tool, call, code) carry it but never consult it. `providerDescriptors`
 * is the injectable registry (tests pass doubles; production uses the
 * static built-in list).
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
 */
interface HandlerDependencies {
  readonly invocation: CommandInvocationAdapter;
  readonly env: NodeJS.ProcessEnv;
  readonly secrets: string[];
  readonly now?: () => number;
  readonly provider?: string;
  readonly providerDescriptors: readonly ProviderDescriptor[];
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

  const command = positional[0];
  const source = positional[1];
  const prompt = positional[2];

  // Map the subcommand to its Vision operation. Unknown subcommands are
  // a parse-time VALIDATION_ERROR and are rejected before any Provider
  // resolution, support check, or media access.
  const operation = visionOperationForCommand(command);

  // Resolve the effective Provider for Vision (DESIGN.md §6). Invalid
  // explicit/env input fails here with VALIDATION_ERROR before any Vision
  // support check or media access. Selection never consults credentials
  // (FR-003); the configured check below is the caller's responsibility.
  const providerId: ProviderId = resolveProviderId(deps.provider, deps.env);
  const descriptor = getProviderDescriptor(providerId, deps.providerDescriptors);

  // Gate the operation on descriptor metadata BEFORE Adapter construction.
  // An unsupported operation (e.g. MiniMax for any specialized op, diff, or
  // video) fails with UNSUPPORTED_CAPABILITY before credentials, media,
  // transport, cache, or any Z.AI fallback (FR-023, FR-024). No command
  // branches on a Provider ID: the support check alone decides availability.
  const capabilityId = visionOperationToCapability(operation);
  if (!descriptor.capabilities().has(capabilityId)) {
    throw new UnsupportedCapabilityError(providerId, capabilityId);
  }
  // FR-003: selection returns the default zai even when unconfigured. The
  // dispatch layer surfaces a missing credential as ConfigurationError
  // (exit 3), AFTER the capability support check (FR-023) but before any
  // Adapter construction or media access (Fixup A — B5).
  if (!descriptor.isConfigured(deps.env)) {
    throw new ConfigurationError(
      `Provider "${providerId}" is not configured. Set the required API key.`,
    );
  }
  const adapter = descriptor.create({ env: deps.env });
  const visionCapability = adapter.vision;
  if (!visionCapability || !visionCapability.supports(operation)) {
    throw new UnsupportedCapabilityError(providerId, capabilityId);
  }

  // Vision bypasses the response cache (FR-022). The shared execution
  // primitives (sleep/random) are the same ones Search consumes; they
  // drive retry backoff deterministically under test.
  const visionDeps: VisionExecutionDependencies = {
    capability: visionCapability,
    sleep: deps.searchSleep,
    random: deps.searchRandom,
  };

  switch (command) {
    case "analyze":
      return invokeCommand(
        deps.invocation,
        (context) => vision.analyze(source, prompt, visionDeps, context),
        outputMode,
        deps.now,
        deps.secrets,
      );

    case "ui-to-code": {
      const outputType = (flags.output as string) || "code";
      return invokeCommand(
        deps.invocation,
        (context) =>
          vision.uiToCode(
            source,
            prompt,
            outputType as "code" | "prompt" | "spec" | "description",
            visionDeps,
            context,
          ),
        outputMode,
        deps.now,
        deps.secrets,
      );
    }

    case "extract-text":
      return invokeCommand(
        deps.invocation,
        (context) =>
          vision.extractText(source, prompt, flags.language as string, visionDeps, context),
        outputMode,
        deps.now,
        deps.secrets,
      );

    case "diagnose-error":
      return invokeCommand(
        deps.invocation,
        (context) =>
          vision.diagnoseError(source, prompt, flags.context as string, visionDeps, context),
        outputMode,
        deps.now,
        deps.secrets,
      );

    case "diagram":
      return invokeCommand(
        deps.invocation,
        (context) => vision.diagram(source, prompt, flags.type as string, visionDeps, context),
        outputMode,
        deps.now,
        deps.secrets,
      );

    case "chart":
      return invokeCommand(
        deps.invocation,
        (context) => vision.chart(source, prompt, flags.focus as string, visionDeps, context),
        outputMode,
        deps.now,
        deps.secrets,
      );

    case "diff": {
      const actual = positional[2];
      const diffPrompt = positional[3];
      return invokeCommand(
        deps.invocation,
        (context) => vision.diff(source, actual, diffPrompt, visionDeps, context),
        outputMode,
        deps.now,
        deps.secrets,
      );
    }

    case "video":
      return invokeCommand(
        deps.invocation,
        (context) => vision.video(source, prompt, visionDeps, context),
        outputMode,
        deps.now,
        deps.secrets,
      );

    default:
      throw new ValidationError(
        `Unknown vision command: ${command}`,
        'Run "scoutline vision --help" for available commands',
      );
  }
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
  // count -> validate topic -> resolve provider -> check configured -> dispatch.
  const count = parseAndValidateCount(flags.count);
  const topic = parseAndValidateTopic(flags.topic);

  // Resolve the Provider ONLY inside shared Search (DESIGN.md §6). Other
  // command families carry the parsed flag but never resolve or validate
  // it. An invalid explicit/env value throws VALIDATION_ERROR here, before
  // any Adapter construction or invocation. Selection never consults
  // credentials (FR-003); the configured check below is the caller's
  // responsibility (Fixup A — B5).
  const providerId: ProviderId = resolveProviderId(deps.provider, deps.env);
  const descriptor = getProviderDescriptor(providerId, deps.providerDescriptors);
  if (!descriptor.capabilities().has("search")) {
    throw new UnsupportedCapabilityError(providerId, "search");
  }
  // FR-003: selection returns the default zai even when unconfigured. The
  // dispatch layer surfaces a missing credential as ConfigurationError
  // (exit 3), AFTER the capability support check (FR-023) but before any
  // Adapter construction (Fixup A — B5).
  if (!descriptor.isConfigured(deps.env)) {
    throw new ConfigurationError(
      `Provider "${providerId}" is not configured. Set the required API key.`,
    );
  }
  const adapter = descriptor.create({ env: deps.env });
  const capability: SearchCapability | undefined = adapter.search;
  if (!capability) {
    throw new UnsupportedCapabilityError(providerId, "search");
  }

  const query = positional.join(" ");

  const fieldsRaw = flags.fields as string | undefined;
  const fields = fieldsRaw
    ? fieldsRaw
        .split(",")
        .map((f) => f.trim())
        .filter(Boolean)
    : undefined;

  return invokeCommand(
    deps.invocation,
    (context) =>
      search(
        query,
        {
          count,
          domain: flags.domain as string,
          recency: flags.recency as "oneDay" | "oneWeek" | "oneMonth" | "oneYear" | "noLimit",
          contentSize: flags["content-size"] as "medium" | "high",
          location: flags.location as "cn" | "us",
          topic,
          maxSummary: flags["max-summary"]
            ? parseInt(flags["max-summary"] as string, 10)
            : undefined,
          fields: fields && fields.length > 0 ? fields : undefined,
          noCache: flags["no-cache"] === true,
          merge: flags.merge === true,
        },
        {
          capability,
          cache: deps.searchCache,
          sleep: deps.searchSleep,
          random: deps.searchRandom,
        },
        context,
      ),
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
  // explicit --provider > SCOUTLINE_PROVIDER > default zai. Selection
  // never consults credentials (FR-003) and never branches on Provider
  // ID; an unknown explicit/env value throws VALIDATION_ERROR here.
  const providerId: ProviderId = resolveProviderId(deps.provider, deps.env);
  const descriptor = getProviderDescriptor(providerId, deps.providerDescriptors);

  // Capability support check BEFORE `descriptor.isConfigured`,
  // `descriptor.create`, Adapter access, operation validation/
  // cacheIdentity, credential use, cache, or transport. Unsupported
  // MiniMax (explicit or environment) returns UNSUPPORTED_CAPABILITY
  // with no fallback to Z.AI; zero selected-Provider work occurs.
  if (!descriptor.capabilities().has("reader")) {
    throw new UnsupportedCapabilityError(providerId, "reader");
  }

  // FR-003: selection returns the default zai even when unconfigured.
  // Supported-but-unconfigured Z.AI surfaces a missing credential as
  // ConfigurationError (exit 3) AFTER the support metadata check and
  // BEFORE `descriptor.create`.
  if (!descriptor.isConfigured(deps.env)) {
    throw new ConfigurationError(
      `Provider "${providerId}" is not configured. Set the required API key.`,
    );
  }

  const adapter = descriptor.create({ env: deps.env });
  const capability = adapter.reader;
  // Defensive fail-closed: the descriptor advertised support but the
  // Adapter omitted the handle. Treat as unsupported so a registry
  // mismatch can never reach transport.
  if (!capability) {
    throw new UnsupportedCapabilityError(providerId, "reader");
  }

  // Shared Reader execution dependencies. The cache/sleep/random
  // default to the same production values as Search and Repository
  // but are kept as separate optional MainDependencies so reader
  // tests can inject isolated in-memory doubles.
  const executionDeps: ExecutionDependencies = {
    cache: deps.readerCache,
    sleep: deps.readerSleep,
    random: deps.readerRandom,
  };

  return invokeCommand(
    deps.invocation,
    (context) =>
      read(
        url,
        {
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
        },
        { capability, execution: executionDeps },
        context,
      ),
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
  // explicit --provider > SCOUTLINE_PROVIDER > default zai.
  const providerId: ProviderId = resolveProviderId(deps.provider, deps.env);
  const descriptor = getProviderDescriptor(providerId, deps.providerDescriptors);

  // Capability support check BEFORE descriptor.isConfigured, descriptor.create,
  // or any Adapter work. Unsupported Z.AI/MiniMax returns
  // UNSUPPORTED_CAPABILITY with no fallback to Tavily.
  if (!descriptor.capabilities().has("crawl")) {
    throw new UnsupportedCapabilityError(providerId, "crawl");
  }

  if (!descriptor.isConfigured(deps.env)) {
    throw new ConfigurationError(
      `Provider "${providerId}" is not configured. Set the required API key.`,
    );
  }

  const adapter = descriptor.create({ env: deps.env });
  const capability = adapter.crawl;
  if (!capability) {
    throw new UnsupportedCapabilityError(providerId, "crawl");
  }

  // Shared Crawl execution dependencies. The cache/sleep/random default
  // to the same production values as Search/Repository/Reader but are
  // kept as separate optional MainDependencies so crawl tests can inject
  // isolated in-memory doubles.
  const executionDeps: ExecutionDependencies = {
    cache: deps.crawlCache,
    sleep: deps.crawlSleep,
    random: deps.crawlRandom,
  };

  return invokeCommand(
    deps.invocation,
    (context) =>
      crawl(
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
        { capability, execution: executionDeps },
        context,
      ),
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
  // explicit --provider > SCOUTLINE_PROVIDER > default zai.
  const providerId: ProviderId = resolveProviderId(deps.provider, deps.env);
  const descriptor = getProviderDescriptor(providerId, deps.providerDescriptors);

  // Capability support check BEFORE descriptor.isConfigured, descriptor.create,
  // or any Adapter work. Unsupported Z.AI/MiniMax returns
  // UNSUPPORTED_CAPABILITY with no fallback to Tavily.
  if (!descriptor.capabilities().has("map")) {
    throw new UnsupportedCapabilityError(providerId, "map");
  }

  if (!descriptor.isConfigured(deps.env)) {
    throw new ConfigurationError(
      `Provider "${providerId}" is not configured. Set the required API key.`,
    );
  }

  const adapter = descriptor.create({ env: deps.env });
  const capability = adapter.map;
  if (!capability) {
    throw new UnsupportedCapabilityError(providerId, "map");
  }

  // Shared Map execution dependencies. The cache/sleep/random default
  // to the same production values as Search/Repository/Reader/Crawl but
  // are kept as separate optional MainDependencies so map tests can
  // inject isolated in-memory doubles.
  const executionDeps: ExecutionDependencies = {
    cache: deps.mapCache,
    sleep: deps.mapSleep,
    random: deps.mapRandom,
  };

  return invokeCommand(
    deps.invocation,
    (context) =>
      map(
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
        { capability, execution: executionDeps },
        context,
      ),
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
  // explicit --provider > SCOUTLINE_PROVIDER > default zai.
  const providerId: ProviderId = resolveProviderId(deps.provider, deps.env);
  const descriptor = getProviderDescriptor(providerId, deps.providerDescriptors);

  // Capability support check BEFORE descriptor.isConfigured,
  // descriptor.create, or any Adapter work. Unsupported Z.AI/MiniMax
  // returns UNSUPPORTED_CAPABILITY with no fallback to Tavily.
  if (!descriptor.capabilities().has("research")) {
    throw new UnsupportedCapabilityError(providerId, "research");
  }

  if (!descriptor.isConfigured(deps.env)) {
    throw new ConfigurationError(
      `Provider "${providerId}" is not configured. Set the required API key.`,
    );
  }

  const adapter = descriptor.create({ env: deps.env });
  const capability = adapter.research;
  if (!capability) {
    throw new UnsupportedCapabilityError(providerId, "research");
  }

  // Shared Research execution dependencies.
  const executionDeps: ExecutionDependencies = {
    cache: deps.researchCache,
    sleep: deps.researchSleep,
    random: deps.researchRandom,
  };

  // Wait disclaimer — shown BEFORE invoke because research is
  // credit-intensive and may take several minutes. Written to stderr so
  // it never corrupts data-mode stdout.
  deps.invocation.writeStderr(
    "Research in progress — this is a credit-intensive operation that may take several minutes.\n",
  );

  return invokeCommand(
    deps.invocation,
    (context) =>
      research(
        query,
        {
          model,
          outputLength,
          citationFormat,
          domain: flags.domain as string | undefined,
          maxChars: flags["max-chars"] ? parseInt(flags["max-chars"] as string, 10) : undefined,
          timeout: flags.timeout ? parseInt(flags.timeout as string, 10) : undefined,
          noCache: flags["no-cache"] === true,
        },
        { capability, execution: executionDeps },
        context,
      ),
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
  } else {
    throw new ValidationError(
      `Unknown repo command: ${command}`,
      'Run "scoutline repo --help" for available commands',
    );
  }

  // Resolve the effective Provider (DESIGN.md §6, FR-001–FR-005):
  // explicit --provider > SCOUTLINE_PROVIDER > default zai. Selection
  // never consults credentials (FR-003) and never branches on Provider
  // ID; an unknown explicit/env value throws VALIDATION_ERROR here.
  const providerId: ProviderId = resolveProviderId(deps.provider, deps.env);
  const descriptor = getProviderDescriptor(providerId, deps.providerDescriptors);

  // Capability support check BEFORE `descriptor.isConfigured`,
  // `descriptor.create`, Adapter access, operation validation/
  // cacheIdentity, credential use, cache, or transport. Unsupported
  // MiniMax (explicit or environment) returns UNSUPPORTED_CAPABILITY
  // with no fallback to Z.AI; zero selected-Provider work occurs.
  if (!descriptor.capabilities().has("repository-exploration")) {
    throw new UnsupportedCapabilityError(providerId, "repository-exploration");
  }

  // FR-003: selection returns the default zai even when unconfigured.
  // Supported-but-unconfigured Z.AI surfaces a missing credential as
  // ConfigurationError (exit 3) AFTER the support metadata check and
  // BEFORE `descriptor.create`.
  if (!descriptor.isConfigured(deps.env)) {
    throw new ConfigurationError(
      `Provider "${providerId}" is not configured. Set the required API key.`,
    );
  }

  const adapter = descriptor.create({ env: deps.env });
  const capability = adapter.repository;
  // Defensive fail-closed: the descriptor advertised support but the
  // Adapter omitted the handle. Treat as unsupported so a registry
  // mismatch can never reach transport.
  if (!capability) {
    throw new UnsupportedCapabilityError(providerId, "repository-exploration");
  }

  // Shared Repository execution dependencies. The cache/sleep/random
  // default to the same production values as Search but are kept as
  // separate optional MainDependencies so repository tests can inject
  // isolated in-memory doubles.
  const executionDeps: ExecutionDependencies = {
    cache: deps.repositoryCache,
    sleep: deps.repositorySleep,
    random: deps.repositoryRandom,
  };

  switch (command) {
    case "search": {
      const language = flags.language as "en" | "zh" | undefined;
      const maxChars = flags["max-chars"] ? parseInt(flags["max-chars"] as string, 10) : undefined;
      const noCache = flags["no-cache"] === true;
      return invokeCommand(
        deps.invocation,
        () =>
          repoSearch(
            repo,
            searchQuery as string,
            { language, maxChars, noCache },
            { capability, execution: executionDeps },
          ),
        outputMode,
        deps.now,
        deps.secrets,
      );
    }

    case "tree": {
      const treePath = flags.path as string | undefined;
      const depth = flags.depth ? parseInt(flags.depth as string, 10) : undefined;
      const noCache = flags["no-cache"] === true;
      return invokeCommand(
        deps.invocation,
        () =>
          repoTree(
            repo,
            { path: treePath, depth, noCache },
            { capability, execution: executionDeps },
          ),
        outputMode,
        deps.now,
        deps.secrets,
      );
    }

    case "read": {
      const maxChars = flags["max-chars"] ? parseInt(flags["max-chars"] as string, 10) : undefined;
      const noCache = flags["no-cache"] === true;
      return invokeCommand(
        deps.invocation,
        () =>
          repoRead(
            repo,
            readPath as string,
            { maxChars, noCache },
            { capability, execution: executionDeps },
          ),
        outputMode,
        deps.now,
        deps.secrets,
      );
    }

    default:
      // Unreachable: the parse-level validation above already rejected
      // unknown subcommands. Keep a defensive throw so the dispatch
      // table stays total.
      throw new ValidationError(
        `Unknown repo command: ${command}`,
        'Run "scoutline repo --help" for available commands',
      );
  }
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
    (context) => showTool(positional[0], { enableVision: flags.vision !== false }, context),
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
        positional[0],
        {
          json: flags.json as string,
          file: flags.file as string,
          stdin: flags.stdin === true,
          dryRun: flags["dry-run"] === true,
          enableVision: flags.vision !== false,
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
            cacheSummary,
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
async function handleCache(
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

  const allProviders = flags["all-providers"] === true;
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
          }),
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
        (context) => runCodeFile(filePath, { timeout, includeLogs }, context),
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
        (context) => evalCode(code, { timeout, includeLogs }, context),
        outputMode,
        deps.now,
        deps.secrets,
      );
    }
    case "interfaces":
      return invokeCommand(
        deps.invocation,
        (context) => printInterfaces(context),
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
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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
  const secrets = configuredSecrets(env);

  const { outputFormat, forcePretty, forceRaw, provider, rest } = extractGlobalOptions([...args]);

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
    invocation.writeStderr(formatErrorOutput(error, "data", secrets));
    return getErrorExitCode(error);
  }

  if (rest.length === 0 || rest[0] === "--help" || rest[0] === "-h") {
    invocation.writeStdout(MAIN_HELP);
    return 0;
  }

  if (rest[0] === "--version" || rest[0] === "-v") {
    invocation.writeStdout(VERSION);
    return 0;
  }

  const command = rest[0];
  const commandArgs = rest.slice(1);

  const handlerDeps: HandlerDependencies = {
    invocation,
    env,
    secrets,
    now,
    provider,
    providerDescriptors,
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
  };

  try {
    switch (command) {
      case "vision":
        return await handleVision(commandArgs, outputMode, handlerDeps);
      case "search":
        return await handleSearch(commandArgs, outputMode, handlerDeps);
      case "read":
        return await handleRead(commandArgs, outputMode, handlerDeps);
      case "crawl":
        return await handleCrawl(commandArgs, outputMode, handlerDeps);
      case "map":
        return await handleMap(commandArgs, outputMode, handlerDeps);
      case "research":
        return await handleResearch(commandArgs, outputMode, handlerDeps);
      case "repo":
        return await handleRepo(commandArgs, outputMode, handlerDeps);
      case "tools":
        return await handleTools(commandArgs, outputMode, handlerDeps);
      case "tool":
        return await handleTool(commandArgs, outputMode, handlerDeps);
      case "call":
        return await handleCall(commandArgs, outputMode, handlerDeps);
      case "doctor":
        return await handleDoctor(commandArgs, outputMode, handlerDeps);
      case "cache":
        return await handleCache(commandArgs, outputMode, handlerDeps);
      case "quota":
        return await handleQuota(commandArgs, outputMode, handlerDeps);
      case "code":
        return await handleCode(commandArgs, outputMode, handlerDeps);
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
        return 1;
    }
  } catch (error) {
    // Fixup C — B10: pre-invocation validation errors (provider
    // resolution, missing credential, count parsing, etc.) MUST be
    // formatted in the resolved output mode — they used to be hardcoded
    // to "data" regardless of what the user asked for.
    invocation.writeStderr(formatErrorOutput(error, outputMode, secrets));
    return getErrorExitCode(error);
  }
}
