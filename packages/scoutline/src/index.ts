/**
 * scoutline - CLI for Z.AI capabilities
 */

import * as vision from "./commands/vision.js";
import type { VisionExecutionDependencies } from "./commands/vision.js";
import { search, SEARCH_HELP } from "./commands/search.js";
import { read, READ_HELP } from "./commands/read.js";
import { repoSearch, repoTree, repoRead, REPO_HELP } from "./commands/repo.js";
import { listTools, showTool, callTool, TOOLS_HELP, CALL_HELP } from "./commands/tools.js";
import { doctor, buildDiagnosticsReport, DOCTOR_HELP } from "./commands/doctor.js";
import { quota, buildQuotaDashboard, QUOTA_HELP } from "./commands/quota.js";
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
import { visionOperationToCapability, type VisionOperation } from "./capabilities/vision.js";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { version: VERSION } = require("../package.json") as { version: string };

const MAIN_HELP = `
scoutline v${VERSION} - CLI for Z.AI MCP services

Usage: scoutline <command> [args] [options]

Commands:
  vision   Image and video analysis (MCP)
  search   Real-time web search
  read     Fetch and parse web pages
  repo     GitHub repository exploration
  quota    Authoritative Z.AI plan usage (calls remaining, reset time)
  tools    List available MCP tools
  tool     Show a tool schema
  call     Call a tool directly
  doctor   Environment + connectivity checks
  code     Execute TypeScript tool chains (Code Mode)

Global Options:
  --output-format <data|json|pretty|compact|markdown|refs>  Output mode (default: data)
  -O <mode>                                                  Alias for --output-format

Help:
  scoutline --help
  scoutline vision --help
  scoutline search --help
  scoutline read --help
  scoutline repo --help
  scoutline tools --help
  scoutline call --help
  scoutline code --help
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
 * `provider` is the parsed global `--provider` flag. Only shared Search
 * resolves/validates it; Z.AI-only command families carry it but never
 * consult it. `providerDescriptors` is the injectable registry (tests
 * pass doubles; production uses the static built-in list). The shared
 * Search execution dependencies (`searchCache`, `searchSleep`,
 * `searchRandom`) default to the on-disk cache and real sleep/random in
 * production; tests inject in-memory doubles.
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
          count: flags.count ? parseInt(flags.count as string, 10) : undefined,
          domain: flags.domain as string,
          recency: flags.recency as "oneDay" | "oneWeek" | "oneMonth" | "oneYear" | "noLimit",
          contentSize: flags["content-size"] as "medium" | "high",
          location: flags.location as "cn" | "us",
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
          extract: isExtractMode(flags.extract as string)
            ? (flags.extract as ExtractMode)
            : undefined,
        },
        outputMode,
        context,
      ),
    outputMode,
    deps.now,
    deps.secrets,
  );
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

  switch (command) {
    case "search": {
      const query = positional.slice(2).join(" ");
      if (!repo || !query) {
        throw new ValidationError(
          "Missing repo or query",
          "Usage: scoutline repo search <owner/repo> <query>",
        );
      }
      return invokeCommand(
        deps.invocation,
        (context) =>
          repoSearch(
            repo,
            query,
            {
              language: flags.language as "en" | "zh",
              maxChars: flags["max-chars"] ? parseInt(flags["max-chars"] as string, 10) : undefined,
              noCache: flags["no-cache"] === true,
            },
            context,
          ),
        outputMode,
        deps.now,
        deps.secrets,
      );
    }

    case "tree": {
      if (!repo) {
        throw new ValidationError("Missing repo", "Usage: scoutline repo tree <owner/repo>");
      }
      return invokeCommand(
        deps.invocation,
        (context) =>
          repoTree(
            repo,
            {
              path: flags.path as string,
              depth: flags.depth ? parseInt(flags.depth as string, 10) : undefined,
              noCache: flags["no-cache"] === true,
            },
            context,
          ),
        outputMode,
        deps.now,
        deps.secrets,
      );
    }

    case "read": {
      const path = positional[2];
      if (!repo || !path) {
        throw new ValidationError(
          "Missing repo or path",
          "Usage: scoutline repo read <owner/repo> <path>",
        );
      }
      return invokeCommand(
        deps.invocation,
        (context) =>
          repoRead(
            repo,
            path,
            {
              maxChars: flags["max-chars"] ? parseInt(flags["max-chars"] as string, 10) : undefined,
              noCache: flags["no-cache"] === true,
            },
            context,
          ),
        outputMode,
        deps.now,
        deps.secrets,
      );
    }

    default:
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
          }),
      }),
    outputMode,
    deps.now,
    deps.secrets,
  );
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
  // Resolve configured Provider credentials from the INJECTED env (B3) so
  // redaction follows the same environment the handlers see — a secret
  // that exists only in MainDependencies.env is still redacted from output.
  const secrets = configuredSecrets(env);

  const { outputFormat, forcePretty, forceRaw, provider, rest } = extractGlobalOptions([...args]);

  let outputMode: OutputMode;
  try {
    outputMode = resolveOutputMode(
      outputFormat,
      forcePretty ?? false,
      forceRaw ?? false,
      invocation,
    );
  } catch (error) {
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
  };

  try {
    switch (command) {
      case "vision":
        return await handleVision(commandArgs, outputMode, handlerDeps);
      case "search":
        return await handleSearch(commandArgs, outputMode, handlerDeps);
      case "read":
        return await handleRead(commandArgs, outputMode, handlerDeps);
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
            "data",
            secrets,
          ),
        );
        return 1;
    }
  } catch (error) {
    invocation.writeStderr(formatErrorOutput(error, "data", secrets));
    return getErrorExitCode(error);
  }
}
