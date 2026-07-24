/**
 * Research command — thin handler over the Research Capability
 * (tech-plan §2c, §3, §8).
 *
 * Research runs an asynchronous create→poll lifecycle server-side and
 * costs 4-250 credits per request. The handler shows a wait disclaimer
 * before invoke, sets up a Ctrl-C signal handler that prints the
 * request_id + resume command, and applies `--max-chars` as a report
 * projection after the cached normalized result is produced.
 *
 * The Adapter's `invoke()` owns the full lifecycle (state-file resume,
 * POST, poll loop, completion/failure/404 handling); shared execution
 * wraps it with cache + zero-retry.
 *
 * Provider selection, capability support, configuration, Adapter
 * construction, and adapter.research agreement live in `src/index.ts`.
 *
 * Cache stores the full report; `--max-chars` is a handler projection.
 */

import * as fs from "node:fs";
import path from "node:path";

import type { CommandContext, CommandResult } from "../command-invocation.js";
import type {
  ResearchCapability,
  ResearchRequest,
  ResearchResult,
} from "../capabilities/research.js";
import type { ExecutionDependencies } from "../lib/execution.js";
import { executeCachedOperation } from "../lib/execution.js";
import { asyncJobStateDir } from "../lib/cache.js";
import { computeAsyncJobStateHash } from "../lib/async-job-state.js";
import { OUTPUT_MODES } from "../lib/output.js";
import { TimeoutError, ValidationError } from "../lib/errors.js";

// ---------------------------------------------------------------------------
// Option and dependency types
// ---------------------------------------------------------------------------

export interface ResearchOptions {
  readonly model?: "mini" | "pro" | "auto";
  readonly outputLength?: "short" | "standard" | "long";
  readonly citationFormat?: "numbered" | "mla" | "apa" | "chicago";
  readonly domain?: string;
  readonly maxChars?: number;
  /** Polling timeout in seconds. Default 300. */
  readonly timeout?: number;
  readonly noCache?: boolean;
}

/**
 * Dependencies injected by `src/index.ts` after Provider selection,
 * capability support check, configuration check, Adapter construction,
 * and adapter.research agreement.
 */
export interface ResearchHandlerDependencies {
  readonly capability: ResearchCapability;
  readonly execution: ExecutionDependencies;
  /**
   * Registers a Ctrl-C (SIGINT) handler before invoke. Receives a
   * `print` callback (already bound to the request identity) that
   * reads the state file and prints the request_id + resume command.
   * Returns a cleanup function that removes the handler after the
   * operation completes. Production wires `process.on('SIGINT', ...)`;
   * tests inject a recorder or no-op.
   */
  readonly registerInterrupt?: (print: () => void) => () => void;
}

// ---------------------------------------------------------------------------
// Parse-level validation
// ---------------------------------------------------------------------------

const VALID_MODES = ["mini", "pro", "auto"] as const;
const VALID_OUTPUT_LENGTHS = ["short", "standard", "long"] as const;
const VALID_CITATION_FORMATS = ["numbered", "mla", "apa", "chicago"] as const;

export function validateModel(value: unknown): "mini" | "pro" | "auto" | undefined {
  if (value === undefined || value === "") return undefined;
  if (value === true) {
    throw new ValidationError(
      "--model requires a value.",
      `Use one of: ${VALID_MODES.join(", ")}.`,
    );
  }
  const str = String(value);
  if (!(VALID_MODES as readonly string[]).includes(str)) {
    throw new ValidationError(
      `Invalid --model value "${str}": must be one of ${VALID_MODES.join(", ")}`,
      `Use one of: ${VALID_MODES.join(", ")}.`,
    );
  }
  return str as "mini" | "pro" | "auto";
}

export function validateOutputLength(value: unknown): "short" | "standard" | "long" | undefined {
  if (value === undefined || value === "") return undefined;
  if (value === true) {
    throw new ValidationError(
      "--output-length requires a value.",
      `Use one of: ${VALID_OUTPUT_LENGTHS.join(", ")}.`,
    );
  }
  const str = String(value);
  if (!(VALID_OUTPUT_LENGTHS as readonly string[]).includes(str)) {
    throw new ValidationError(
      `Invalid --output-length value "${str}": must be one of ${VALID_OUTPUT_LENGTHS.join(", ")}`,
      `Use one of: ${VALID_OUTPUT_LENGTHS.join(", ")}.`,
    );
  }
  return str as "short" | "standard" | "long";
}

export function validateCitationFormat(
  value: unknown,
): "numbered" | "mla" | "apa" | "chicago" | undefined {
  if (value === undefined || value === "") return undefined;
  if (value === true) {
    throw new ValidationError(
      "--citation-format requires a value.",
      `Use one of: ${VALID_CITATION_FORMATS.join(", ")}.`,
    );
  }
  const str = String(value);
  if (!(VALID_CITATION_FORMATS as readonly string[]).includes(str)) {
    throw new ValidationError(
      `Invalid --citation-format value "${str}": must be one of ${VALID_CITATION_FORMATS.join(", ")}`,
      `Use one of: ${VALID_CITATION_FORMATS.join(", ")}.`,
    );
  }
  return str as "numbered" | "mla" | "apa" | "chicago";
}

// ---------------------------------------------------------------------------
// Interrupt message
// ---------------------------------------------------------------------------

/**
 * Format the Ctrl-C interrupt message. Pure and exported so tests verify
 * the request_id and resume command appear in the output without
 * simulating a real SIGINT. The message goes to stderr.
 */
export function formatInterruptMessage(requestId: string, resumeCommand: string): string {
  return [
    "",
    "Research interrupted.",
    `  request_id: ${requestId}`,
    "  The task is still running server-side — no credits lost.",
    "  Re-run to resume polling and retrieve the result:",
    `    ${resumeCommand}`,
    "",
  ].join("\n");
}

/**
 * Read the requestId from the on-disk state file synchronously (SIGINT
 * path must be sync). Returns "unknown" when the file is absent or
 * corrupt — the resume command alone is enough guidance.
 */
function readRequestIdSync(stateFilePath: string): string {
  try {
    const raw = fs.readFileSync(stateFilePath, "utf8");
    const parsed = JSON.parse(raw) as { requestId?: unknown };
    if (parsed && typeof parsed.requestId === "string" && parsed.requestId.length > 0) {
      return parsed.requestId;
    }
  } catch {
    // File absent (task not yet persisted) or corrupt — fall back.
  }
  return "unknown";
}

/**
 * Production SIGINT registrar. Reads the state file synchronously,
 * formats the interrupt message, writes it to stderr, and exits 130
 * (128 + SIGINT). Returns a cleanup that detaches the listener.
 */
function createProductionInterruptRegistrar(stateFilePath: string, resumeCommand: string) {
  return (print: () => void): (() => void) => {
    const handler = (): void => {
      print();
      process.exit(130);
    };
    process.on("SIGINT", handler);
    return () => {
      process.off("SIGINT", handler);
    };
  };
}

function buildResearchRequest(query: string, options: ResearchOptions): ResearchRequest {
  const request: { query: string } & Record<string, unknown> = { query };
  if (options.model !== undefined) request.model = options.model;
  if (options.outputLength !== undefined) request.outputLength = options.outputLength;
  if (options.citationFormat !== undefined) request.citationFormat = options.citationFormat;
  if (options.domain !== undefined) request.domain = options.domain;
  return request as ResearchRequest;
}

function parseReportSections(report: string): readonly { heading: string; body: string }[] {
  const lines = report.split("\n");
  const sections: { heading: string; body: string }[] = [];
  let currentHeading = "";
  let currentBody: string[] = [];

  for (const line of lines) {
    const match = line.match(/^(#{1,6})\s+(.+)$/);
    if (match) {
      if (currentBody.some((l) => l.trim()) || currentHeading) {
        sections.push({ heading: currentHeading, body: currentBody.join("\n").trim() });
      }
      currentHeading = match[2]!.trim();
      currentBody = [];
    } else {
      currentBody.push(line);
    }
  }
  if (currentBody.some((l) => l.trim()) || currentHeading) {
    sections.push({ heading: currentHeading, body: currentBody.join("\n").trim() });
  }

  return sections.filter((s) => !/^(sources?|references?|citations?)$/i.test(s.heading));
}

function buildResearchPresentations(
  sections: readonly { heading: string; body: string }[],
  sources: readonly { title?: string; url?: string }[],
): Readonly<Partial<Record<string, string>>> {
  const compact = sections.map((s) => s.body).join("\n\n");

  const markdown =
    sections.map((s) => `## ${s.heading}\n\n${s.body}`).join("\n\n") +
    (sources.length > 0
      ? "\n\n---\n\n## Sources\n\n" +
        sources
          .map((s, i) => `${i + 1}. [${s.title ?? s.url ?? "Source"}](${s.url ?? ""})`)
          .join("\n")
      : "");

  const refs = sources
    .map((s) => s.url ?? "")
    .filter((u) => u.length > 0)
    .join("\n");

  return { compact, markdown, refs, tty: markdown };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

const DEFAULT_POLL_TIMEOUT_SECONDS = 300;

export async function research(
  query: string,
  options: ResearchOptions = {},
  deps: ResearchHandlerDependencies,
  _context?: CommandContext,
): Promise<CommandResult> {
  if (typeof query !== "string" || query.trim() === "") {
    throw new ValidationError("Research query must contain at least one non-whitespace character");
  }

  const request = buildResearchRequest(query, options);

  // Compute the state-file path for the SIGINT handler. The identity
  // hash uses the same formula as the adapter (CR3), so the file the
  // handler reads is the one the adapter wrote.
  const identity = deps.capability.run.cacheIdentity(request);
  const identityHash = computeAsyncJobStateHash({
    provider: identity.provider,
    capability: identity.capability,
    credentialFingerprint: identity.credentialFingerprint,
    request: identity.request,
  });
  const stateFilePath = path.join(asyncJobStateDir("research"), `${identityHash}.json`);
  const resumeCommand = `scoutline research "${query}"`;

  // Register the Ctrl-C handler. Production reads the state file sync
  // and exits 130; tests inject a recorder.
  const register =
    deps.registerInterrupt ?? createProductionInterruptRegistrar(stateFilePath, resumeCommand);
  const print = (): void => {
    const requestId = readRequestIdSync(stateFilePath);
    process.stderr.write(formatInterruptMessage(requestId, resumeCommand));
  };
  const cleanup = register(print);

  try {
    // Polling timeout: bounds the entire operation. The state file
    // persists on timeout, so re-running resumes polling. On timeout we
    // also abort the controller so the Adapter's poll loop stops early
    // and its pending poll-interval timers are cleared — otherwise a
    // lingering `setTimeout` keeps the event loop alive and the CLI
    // appears frozen after the error is printed (JS promises can't be
    // cancelled, so `Promise.race` leaves the loser running).
    const timeoutSeconds = options.timeout ?? DEFAULT_POLL_TIMEOUT_SECONDS;
    const timeoutMs = timeoutSeconds * 1000;
    const controller = new AbortController();

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        controller.abort();
        reject(new TimeoutError(timeoutMs, "Research polling timed out — re-run to resume"));
      }, timeoutMs);
    });

    const opPromise = executeCachedOperation(
      deps.capability.run,
      request,
      { noCache: options.noCache === true, signal: controller.signal },
      deps.execution,
    );
    // When the timeout wins the race, the Adapter poll loop is signalled
    // to abort and opPromise rejects shortly after. Nobody is awaiting it
    // by then, so attach a late-rejection guard to avoid an unhandled
    // rejection. The canonical error surfaced to the user is the timeout
    // rejection from the race, not this one.
    opPromise.catch(() => {});

    let result: ResearchResult;
    try {
      result = await Promise.race([opPromise, timeoutPromise]);
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }

    const reportText =
      options.maxChars && options.maxChars > 0 && result.report.length > options.maxChars
        ? result.report.slice(0, options.maxChars - 1).trimEnd() + "…"
        : result.report;

    const sections = parseReportSections(reportText);

    const envelope: Record<string, unknown> = {
      schemaVersion: result.schemaVersion,
      query: result.query,
      model: result.model,
      sections,
      sources: result.sources,
    };
    if (options.maxChars && options.maxChars > 0 && result.report.length > options.maxChars) {
      envelope.reportTruncated = true;
      envelope.originalReportLength = result.report.length;
    }

    return {
      kind: "data",
      data: envelope,
      presentations: buildResearchPresentations(sections, result.sources),
    };
  } finally {
    cleanup();
  }
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

const OUTPUT_MODE_LIST = OUTPUT_MODES.join(" | ");

export const RESEARCH_HELP = `
Research Command - Deep research with citations (Provider Capability)

Usage: scoutline research <query> [options]

Runs an asynchronous deep-research task: the Provider searches, reads,
and synthesizes a cited report. This is a CREDIT-INTENSIVE operation
(4-250 credits) that may take several minutes.

Ctrl-C safety: interrupting a research task does NOT lose credits. The
task keeps running server-side and its request_id is persisted to a state
file. Re-running the SAME command resumes polling instead of creating a
second task (no double charge).

Provider selection (precedence: --provider, then SCOUTLINE_PROVIDER,
then the configured default):
  - Tavily advertises the research Capability and supplies the Adapter.
  - Z.AI and MiniMax do NOT advertise research. Selecting them returns
    UNSUPPORTED_CAPABILITY with no fallback.

Options:
  --model <m>            Research model: mini | pro | auto (default: auto)
  --output-length <l>    Report length: short | standard | long (default: standard)
  --citation-format <f>  Citations: numbered | mla | apa | chicago (default: numbered)
  --domain <d>           Restrict research to a single domain
  --max-chars <n>        Truncate the report text to <n> chars
                         (projection only; cache stores full report)
  --timeout <s>          Polling timeout in seconds (default: 300)
  --no-cache             Bypass the response cache for this invocation

Common Options:
  --provider <id>            Override the active Provider (zai | minimax | tavily | exa | firecrawl)
  --output-format <mode>     One of: ${OUTPUT_MODE_LIST} (default: data)
  -O <mode>                  Alias for --output-format

Output format (schema-version-1):
  {
    "schemaVersion": 1,
    "query":    "<your query>",
    "model":    "<model used>",
    "sections": [{ "heading": "...", "body": "..." }],
    "sources":  [{ "title": "...", "url": "..." }]
  }

Examples:
  scoutline research "Compare React vs Svelte for enterprise apps"
  scoutline research "State of carbon capture 2025" --model pro
  scoutline research "Quantum computing benchmarks" --citation-format apa
  scoutline --provider tavily research "Rust async runtime comparison"
`.trim();
