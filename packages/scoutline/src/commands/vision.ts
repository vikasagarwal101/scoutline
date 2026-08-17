/**
 * Vision commands.
 *
 * P3-04: the command no longer constructs a Provider client or validates
 * media directly. It receives the effective Provider's VisionCapability
 * through the dispatch dependency object (same pattern as Search in
 * P2-05), builds the discriminated `VisionRequest`, and invokes through
 * shared execution (`executeProviderOperation("vision", ...)`). The
 * support check — not a command branch on a Provider ID — decides
 * availability; Provider selection and capability gating live in the
 * dispatcher (`index.ts`).
 *
 * Default prompts and command presentation meaning stay here. Source
 * limits stay in the Adapter media Modules. Vision never uses the
 * response cache (FR-022).
 */

import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import type { CommandContext, CommandResult } from "../command-invocation.js";
import type { VisionCapability, VisionRequest, VisionOperation } from "../capabilities/vision.js";
import { executeProviderOperation } from "../lib/execution.js";
import { ValidationError } from "../lib/errors.js";
import type { OutputMode } from "../lib/output.js";
import { parseBatchManifest } from "../lib/batch-manifest.js";
import type {
  AllowedBatchCommand,
  BatchManifest,
  VisionBatchOperation,
} from "../lib/batch-manifest.js";
import { assignBatchProviders } from "../lib/batch-assign.js";
import { runBatch } from "../lib/batch-runner.js";
import type { BatchOperationHandler } from "../lib/batch-runner.js";
import type { HandlerDependencies } from "../index.js";
import type { ProviderId } from "../providers/types.js";
import type { ConsumptionSink } from "../lib/consumption.js";
import { defaultAmountForCapability } from "../lib/consumption.js";
import {
  isMiniMaxVisionOperationSupported,
  SPECIALIZED_VISION_OPERATION_SET,
  type SpecializedVisionOperation,
} from "../providers/minimax/vision-conformance.js";

type OutputType = "code" | "prompt" | "spec" | "description";

const DEFAULT_PROMPTS = {
  analyze: "Describe this image in detail.",
  uiToCode: "Convert this UI to production-ready code.",
  extractText: "Extract all text from this image.",
  diagnoseError: "Diagnose this error and suggest fixes.",
  diagram: "Explain this technical diagram.",
  chart: "Analyze this data visualization.",
  diff: "Compare these two UI screenshots and identify differences.",
  video: "Analyze this video content.",
};

/**
 * Render the MiniMax support suffix for a Vision operation's help line.
 * Derives from the conformance registry so help, doctor, and the
 * Adapter descriptor agree on a single source of truth (DESIGN.md §15).
 *
 *   - Specialized ops pending/fail/missing attestation: " (Z.AI; MiniMax gated)"
 *   - Specialized ops supported: " (Z.AI + MiniMax)"
 *   - `interpret-image`: no suffix (the help line already calls out
 *     the shared Provider surface).
 *   - `diff` and `video`: " (Z.AI only)" — never supported by MiniMax.
 */
function miniMaxSupportSuffix(operation: VisionOperation): string {
  if (operation === "interpret-image") return "";
  if (operation === "diff" || operation === "video") return " (Z.AI only)";
  if (SPECIALIZED_VISION_OPERATION_SET.has(operation as SpecializedVisionOperation)) {
    return isMiniMaxVisionOperationSupported(operation)
      ? " (Z.AI + MiniMax)"
      : " (Z.AI; MiniMax gated)";
  }
  return "";
}

/**
 * Build the Vision help text. Specialized-operation support derives
 * from the conformance registry, so P5-03's attested mappings flip
 * their help lines automatically without editing this template.
 */
function buildVisionHelp(): string {
  const uiSuffix = miniMaxSupportSuffix("ui-artifact");
  const extractSuffix = miniMaxSupportSuffix("extract-text");
  const diagnoseSuffix = miniMaxSupportSuffix("diagnose-error");
  const diagramSuffix = miniMaxSupportSuffix("diagram");
  const chartSuffix = miniMaxSupportSuffix("chart");
  const diffSuffix = miniMaxSupportSuffix("diff");
  const videoSuffix = miniMaxSupportSuffix("video");

  return `
Vision Commands - Analyze images and video (Z.AI + MiniMax)

Usage: scoutline vision <command> <source> [prompt] [options]

Provider selection (precedence: explicit flag, then SCOUTLINE_PROVIDER, then zai):
  --provider <zai|minimax>   Select the vision provider (default: zai)
  SCOUTLINE_PROVIDER=<id>    Fallback when --provider is not passed

Commands:
  analyze <image> [prompt]            General image interpretation (shared: Z.AI + MiniMax)
  ui-to-code <image> [prompt]         Convert UI screenshot to code${uiSuffix}
  extract-text <image> [prompt]       OCR for code, terminals, documents${extractSuffix}
  diagnose-error <image> [prompt]     Analyze error screenshots${diagnoseSuffix}
  diagram <image> [prompt]            Interpret technical diagrams${diagramSuffix}
  chart <image> [prompt]              Analyze data visualizations${chartSuffix}
  diff <expected> <actual> [prompt]   Compare two UI screenshots${diffSuffix}
  video <video> [prompt]              Analyze video content${videoSuffix}
  batch <manifest|glob> [options]     Run many inputs through the shared
                                      batch runner (one op per media file,
                                      distributed across eligible vision
                                      providers, routing preferences
                                      ignored; concurrency default 1)

Options:
  --language <lang>  Programming language hint (extract-text)
  --context <ctx>    Error context (diagnose-error)
  --type <type>      Diagram type hint (diagram)
  --focus <focus>    Analysis focus (chart)
  --output <type>    Output type for ui-to-code: code, prompt, spec, description

Vision batch options (batch subcommand only):
  --out <dir>        Output directory (required for more than one input;
                     created if missing; writes one JSON file per input
                     plus <dir>/summary.json)
  --prompt <tpl>     Glob-mode prompt template ({filename}/{filepath});
                     manifest mode uses the manifest's promptTemplate
  --concurrency <n>  Parallel operations (integer 1-8; default 1)
  --dry-run          Validate inputs and preview the assignment only

Constraints:
  Z.AI images: <=5MB, JPG/PNG/JPEG ; Z.AI videos: <=8MB, MP4/MOV/M4V (URLs supported)
  MiniMax images: <=50MB, JPG/JPEG/PNG/WebP

Examples:
  scoutline vision analyze ./screenshot.png "What's in this image?"
  scoutline --provider minimax vision analyze ./shot.png
  scoutline vision ui-to-code ./design.png --output code
  scoutline vision extract-text ./code.png --language python
  scoutline vision diagnose-error ./error.png --context "during npm install"
  scoutline vision diagram ./arch.png --type architecture
  scoutline vision diff ./expected.png ./actual.png "Check alignment"
  scoutline vision video ./demo.mp4 "Summarize the key steps"
  scoutline vision batch './shots/*.png' --out ./out --prompt "Describe {filename}"
`.trim();
}

export const VISION_HELP = buildVisionHelp();

/**
 * Shared Vision execution dependencies. The Capability is the selected
 * Provider's `VisionCapability`; `sleep`/`random` drive retry backoff
 * deterministically under test. Vision bypasses the response cache, so
 * no cache dependency is threaded here.
 *
 * PB-T2: `provider` + `consume` enable consumption emission at the
 * execution seam. `provider` is the actual attempted descriptor ID
 * (NOT the registry-derived effective provider); `consume` is the
 * optional sink. When `consume` is absent, no event is emitted — the
 * pre-PB-T2 byte-for-byte behavior.
 */
export interface VisionExecutionDependencies {
  readonly capability: VisionCapability;
  readonly sleep: (ms: number) => Promise<void>;
  readonly random: () => number;
  readonly provider?: import("../providers/types.js").ProviderId;
  readonly consume?: ConsumptionSink;
  readonly now?: () => number;
}

/**
 * Invoke a Vision request through shared execution. Vision allows two
 * retries (DESIGN.md §10); the default policy is applied by
 * `executeProviderOperation`. No cache lookup. Provider fallback is
 * owned by the executor (executeWithFallback), not by this function.
 *
 * PB-T2: when `deps.consume` AND `deps.provider` are both present, one
 * consumption event is emitted per `invoke()` attempt at the execution
 * seam. Vision bills variable tokens (most adapters don't return
 * per-call usage), so the default amount is `unknown` — never a
 * fake-precise number.
 */
function runVision(request: VisionRequest, deps: VisionExecutionDependencies): Promise<string> {
  const operation = request.operation;
  // Canonical capability id matches descriptor metadata
  // (`vision.interpret-image`, `vision.chart`, etc.).
  const capabilityId =
    operation === "interpret-image" ? "vision.interpret-image" : `vision.${String(operation)}`;
  const consumption =
    deps.consume && deps.provider
      ? {
          provider: deps.provider,
          capabilityId,
          category: "vision",
          unit: "tokens" as const,
          amount: defaultAmountForCapability("vision"),
        }
      : undefined;
  return executeProviderOperation(
    "vision",
    () => deps.capability.invoke(request),
    {
      sleep: deps.sleep,
      random: deps.random,
      ...(deps.consume !== undefined ? { consume: deps.consume } : {}),
      ...(deps.now !== undefined ? { now: deps.now } : {}),
    },
    undefined,
    consumption,
  );
}

export async function analyze(
  imageSource: string,
  prompt: string | undefined,
  deps: VisionExecutionDependencies,
  context?: CommandContext,
): Promise<CommandResult> {
  void context;
  if (!imageSource) {
    throw new ValidationError(
      "Missing image source",
      "Usage: scoutline vision analyze <image> [prompt]",
    );
  }
  const instruction = prompt ?? DEFAULT_PROMPTS.analyze;
  const result = await runVision(
    { operation: "interpret-image", source: imageSource, instruction },
    deps,
  );
  return { kind: "data", data: result };
}

export async function uiToCode(
  imageSource: string,
  prompt: string | undefined,
  outputType: OutputType,
  deps: VisionExecutionDependencies,
  context?: CommandContext,
): Promise<CommandResult> {
  void context;
  if (!imageSource) {
    throw new ValidationError(
      "Missing image source",
      "Usage: scoutline vision ui-to-code <image> [prompt]",
    );
  }
  const instruction = prompt ?? DEFAULT_PROMPTS.uiToCode;
  const result = await runVision(
    {
      operation: "ui-artifact",
      source: imageSource,
      instruction,
      outputType: outputType ?? "code",
    },
    deps,
  );
  return { kind: "data", data: result };
}

export async function extractText(
  imageSource: string,
  prompt: string | undefined,
  language: string | undefined,
  deps: VisionExecutionDependencies,
  context?: CommandContext,
): Promise<CommandResult> {
  void context;
  if (!imageSource) {
    throw new ValidationError(
      "Missing image source",
      "Usage: scoutline vision extract-text <image> [prompt] [--language <lang>]",
    );
  }
  const instruction = prompt ?? DEFAULT_PROMPTS.extractText;
  const result = await runVision(
    {
      operation: "extract-text",
      source: imageSource,
      instruction,
      programmingLanguage: language,
    },
    deps,
  );
  return { kind: "data", data: result };
}

export async function diagnoseError(
  imageSource: string,
  prompt: string | undefined,
  contextFlag: string | undefined,
  deps: VisionExecutionDependencies,
  context?: CommandContext,
): Promise<CommandResult> {
  void context;
  if (!imageSource) {
    throw new ValidationError(
      "Missing image source",
      "Usage: scoutline vision diagnose-error <image> [prompt] [--context <ctx>]",
    );
  }
  const instruction = prompt ?? DEFAULT_PROMPTS.diagnoseError;
  const result = await runVision(
    {
      operation: "diagnose-error",
      source: imageSource,
      instruction,
      context: contextFlag,
    },
    deps,
  );
  return { kind: "data", data: result };
}

export async function diagram(
  imageSource: string,
  prompt: string | undefined,
  diagramType: string | undefined,
  deps: VisionExecutionDependencies,
  context?: CommandContext,
): Promise<CommandResult> {
  void context;
  if (!imageSource) {
    throw new ValidationError(
      "Missing image source",
      "Usage: scoutline vision diagram <image> [prompt] [--type <type>]",
    );
  }
  const instruction = prompt ?? DEFAULT_PROMPTS.diagram;
  const result = await runVision(
    {
      operation: "diagram",
      source: imageSource,
      instruction,
      diagramType,
    },
    deps,
  );
  return { kind: "data", data: result };
}

export async function chart(
  imageSource: string,
  prompt: string | undefined,
  focus: string | undefined,
  deps: VisionExecutionDependencies,
  context?: CommandContext,
): Promise<CommandResult> {
  void context;
  if (!imageSource) {
    throw new ValidationError(
      "Missing image source",
      "Usage: scoutline vision chart <image> [prompt] [--focus <focus>]",
    );
  }
  const instruction = prompt ?? DEFAULT_PROMPTS.chart;
  const result = await runVision(
    {
      operation: "chart",
      source: imageSource,
      instruction,
      focus,
    },
    deps,
  );
  return { kind: "data", data: result };
}

export async function diff(
  expectedSource: string,
  actualSource: string,
  prompt: string | undefined,
  deps: VisionExecutionDependencies,
  context?: CommandContext,
): Promise<CommandResult> {
  void context;
  if (!expectedSource || !actualSource) {
    throw new ValidationError(
      "Missing image sources",
      "Usage: scoutline vision diff <expected> <actual> [prompt]",
    );
  }
  const instruction = prompt ?? DEFAULT_PROMPTS.diff;
  const result = await runVision(
    {
      operation: "diff",
      expectedSource,
      actualSource,
      instruction,
    },
    deps,
  );
  return { kind: "data", data: result };
}

export async function video(
  videoSource: string,
  prompt: string | undefined,
  deps: VisionExecutionDependencies,
  context?: CommandContext,
): Promise<CommandResult> {
  void context;
  if (!videoSource) {
    throw new ValidationError(
      "Missing video source",
      "Usage: scoutline vision video <video> [prompt]",
    );
  }
  const instruction = prompt ?? DEFAULT_PROMPTS.video;
  const result = await runVision({ operation: "video", source: videoSource, instruction }, deps);
  return { kind: "data", data: result };
}

// ---------------------------------------------------------------------------
// `vision batch` wrapper (batch-runner DESIGN D10)
// ---------------------------------------------------------------------------

/**
 * The shared runner's handler map (D5) — the same object the main
 * dispatch switch passes to `runBatch`. Injected by `handleVision`'s
 * early branch because the handlers are module-private in `index.ts`.
 */
export type VisionBatchHandlers = Readonly<Record<AllowedBatchCommand, BatchOperationHandler>>;

/**
 * D10 media-extension filter: the UNION of the enrolled vision
 * providers' extension sets (Z.AI image `.jpg/.jpeg/.png` + video
 * `.mp4/.mov/.m4v/.avi/.webm/.wmv`, MiniMax image `.jpg/.jpeg/.png/
 * .webp`) so no file any eligible provider accepts is silently dropped
 * at expansion — a provider that cannot accept a given op's file
 * rejects it inside the handler as a per-op failure.
 */
const VISION_BATCH_ZAI_IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".jpg",
  ".jpeg",
  ".png",
]);

/**
 * Image extensions any ELIGIBLE provider accepts for an image
 * operation: Z.AI's `.jpg/.jpeg/.png` plus MiniMax's `.webp`. Kept as a
 * per-operation union (not the full media union) so dry-run extension
 * validation can be operation-aware (review fix).
 */
const VISION_BATCH_IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  ...VISION_BATCH_ZAI_IMAGE_EXTENSIONS,
  ".webp",
]);

/** Video extensions (D10): these infer the `video` subcommand. */
const VISION_BATCH_VIDEO_EXTENSIONS: ReadonlySet<string> = new Set([
  ".mp4",
  ".mov",
  ".m4v",
  ".avi",
  ".webm",
  ".wmv",
]);

/**
 * D10 media-extension filter: the UNION of the enrolled vision
 * providers' image and video sets so no file any eligible provider
 * accepts is silently dropped at expansion — a provider that cannot
 * accept a given op's file rejects it inside the handler as a per-op
 * failure.
 */
const VISION_BATCH_MEDIA_EXTENSIONS: ReadonlySet<string> = new Set([
  ...VISION_BATCH_IMAGE_EXTENSIONS,
  ...VISION_BATCH_VIDEO_EXTENSIONS,
]);

/**
 * Per-operation dry-run extension set (review fix): `video` sources are
 * video files, `diff` is advertised only by Z.AI (its image set —
 * MiniMax's `.webp` never applies), and every other vision operation is
 * an image operation served by the image union. Keeps `--dry-run` from
 * reporting ready for media the real handler will reject, while
 * provider-specific acceptance WITHIN an operation class (e.g. `.webp`
 * on Z.AI analyze) still defers to the handler per D10's rationale.
 */
function visionBatchAcceptedExtensions(subcommand: string): ReadonlySet<string> {
  if (subcommand === "video") return VISION_BATCH_VIDEO_EXTENSIONS;
  if (subcommand === "diff") return VISION_BATCH_ZAI_IMAGE_EXTENSIONS;
  return VISION_BATCH_IMAGE_EXTENSIONS;
}

/** Flags `vision batch` itself accepts (the D1 surface; strict). */
const VISION_BATCH_FLAGS: ReadonlySet<string> = new Set([
  "help",
  "h",
  "out",
  "prompt",
  "concurrency",
  "dry-run",
]);

/** One expanded glob input: a media file destined to become one op. */
interface VisionBatchInputFile {
  /** Absolute path — the op's `source`. */
  readonly file: string;
  /** Sanitized basename — the op's `name` (D2 rules). */
  readonly opName: string;
  /** Extension-driven subcommand inference (D10). */
  readonly subcommand: "analyze" | "video";
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * D10 op-name sanitization: runs of characters outside `[A-Za-z0-9._-]`
 * collapse to one `_`, the result truncates to 64 chars (D2's op-name
 * ceiling).
 */
function sanitizeVisionBatchName(basename: string): string {
  return basename.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 64);
}

/**
 * Hand-rolled single-directory glob matcher: `*` and `?` only (no
 * `**` — the wrapper rejects recursive globs up front), anchored to
 * the full leaf segment.
 */
function visionBatchGlobToRegExp(pattern: string): RegExp {
  let source = "";
  for (const ch of pattern) {
    if (ch === "*") {
      source += "[^/]*";
    } else if (ch === "?") {
      source += "[^/]";
    } else {
      source += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

/**
 * Expand a single-directory glob into op inputs (D10): lexicographic
 * order, media-extension filter, extension-driven subcommand
 * inference, name sanitization with collision rejection naming both
 * files. Zero matches reject — an empty batch is never run.
 */
async function expandVisionBatchGlob(glob: string): Promise<readonly VisionBatchInputFile[]> {
  if (glob.includes("**")) {
    throw new ValidationError(
      `vision batch globs are single-directory only: "**" is not supported ("${glob}")`,
      "Point the glob at one directory, e.g. 'shots/*.png'.",
    );
  }
  const directory = path.dirname(glob);
  const leaf = path.basename(glob);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ValidationError(`failed to expand vision batch glob "${glob}": ${message}`);
  }
  const matcher = visionBatchGlobToRegExp(leaf);
  const inputs: VisionBatchInputFile[] = [];
  for (const name of entries
    .filter((entry) => entry.isFile() && matcher.test(entry.name))
    .map((entry) => entry.name)
    .sort()) {
    const ext = path.extname(name).toLowerCase();
    // The union filter: a non-media extension never becomes an op.
    if (!VISION_BATCH_MEDIA_EXTENSIONS.has(ext)) continue;
    inputs.push({
      file: path.resolve(directory, name),
      opName: sanitizeVisionBatchName(name),
      subcommand: VISION_BATCH_VIDEO_EXTENSIONS.has(ext) ? "video" : "analyze",
    });
  }
  if (inputs.length === 0) {
    throw new ValidationError(
      `vision batch glob "${glob}" matched no media files`,
      `Accepted extensions: ${[...VISION_BATCH_MEDIA_EXTENSIONS].sort().join(" ")}.`,
    );
  }
  const seen = new Map<string, string>();
  for (const input of inputs) {
    const prior = seen.get(input.opName);
    if (prior !== undefined) {
      throw new ValidationError(
        `vision batch name collision: "${prior}" and "${input.file}" both sanitize to "${input.opName}"`,
        "Rename one of the inputs so every op name is unique.",
      );
    }
    seen.set(input.opName, input.file);
  }
  return inputs;
}

/**
 * `{filename}` → basename, `{filepath}` → the op's source path (an
 * absolute path in glob mode; the manifest's own `source` verbatim in
 * manifest mode). Callback replacements insert the source text
 * LITERALLY — a replacement string would treat `$&`, `$\``, or `$'` in
 * a filename as replacement tokens and corrupt the prompt.
 */
function substituteVisionBatchPrompt(template: string, source: string): string {
  return template
    .replaceAll("{filename}", () => path.basename(source))
    .replaceAll("{filepath}", () => source);
}

/**
 * `--concurrency` for vision batch: integer in 1..8 with a default of 1
 * (D8 — vision is credit-heavy), validated at the wrapper so the error
 * names vision batch's own default.
 */
function parseVisionBatchConcurrency(raw: string | boolean | undefined): number {
  if (raw === undefined) return 1;
  const value = typeof raw === "string" ? Number(raw) : Number.NaN;
  if (!Number.isInteger(value) || value < 1 || value > 8) {
    throw new ValidationError(
      "vision batch concurrency must be an integer between 1 and 8",
      "Omit --concurrency for the default of 1, or pass an integer in 1..8.",
    );
  }
  return value;
}

/**
 * `vision batch <manifest|glob>` (batch-runner DESIGN D10, Ticket 7).
 *
 * The wrapper NEVER resolves a vision provider and never calls
 * `descriptor.create()` — per-op assignment happens inside the shared
 * runner (D4), exactly as in `scoutline batch`. It owns: strict flag
 * surface, input discrimination (manifest vs glob), glob expansion
 * (single directory, lexicographic, media union, sanitization,
 * collisions), `promptTemplate` extraction from the RAW manifest JSON
 * before the strict D2 parse (a wrapper field, not a D2 schema field),
 * the `--out` contract (per-input `output` targets + the wrapper's own
 * `<out>/summary.json` write after the runner returns — the only extra
 * write path), concurrency default 1, and the dry-run boundary
 * (existence + extension validation only; media size validation stays
 * in the handler). The shared runner still performs the ONE stdout
 * write (the summary envelope); the wrapper adds none.
 */
export async function handleVisionBatch(
  positional: string[],
  flags: Record<string, string | boolean>,
  outputMode: OutputMode,
  deps: HandlerDependencies,
  handlers: VisionBatchHandlers,
): Promise<number> {
  // Unknown flags reject BEFORE the help short-circuit (the
  // handleBatch precedent: parseArgs would otherwise swallow the
  // input into the unknown flag and render help instead of naming
  // the offender).
  for (const key of Object.keys(flags)) {
    if (!VISION_BATCH_FLAGS.has(key)) {
      throw new ValidationError(
        `unknown vision batch flag "--${key}"`,
        'Run "scoutline vision --help" for the accepted flags.',
      );
    }
  }

  // Boolean-only flags never take a value: `--dry-run false` would
  // otherwise silently disable the safety boundary and RUN providers.
  if (flags["dry-run"] !== undefined && flags["dry-run"] !== true) {
    throw new ValidationError(
      "--dry-run is a boolean flag and takes no value",
      "Pass the bare --dry-run to enable it, or omit it.",
    );
  }
  // A valueless `--prompt` must reject rather than silently fall back
  // to the default prompt (the template is the user's whole intent).
  if (flags.prompt === true) {
    throw new ValidationError(
      "--prompt requires a template",
      'Pass e.g. --prompt "Describe {filename} in detail."',
    );
  }

  if (flags.help || flags.h || positional.length === 0) {
    deps.invocation.writeStdout(VISION_HELP);
    return 0;
  }

  if (positional.length > 1) {
    throw new ValidationError(
      "vision batch takes exactly one input (a manifest file or a single-directory glob)",
    );
  }

  const dryRun = flags["dry-run"] === true;
  if (flags.out === true) {
    throw new ValidationError("--out requires a directory path");
  }
  const outDir = typeof flags.out === "string" ? flags.out : undefined;
  const concurrency = parseVisionBatchConcurrency(flags.concurrency);
  const input = positional[0] ?? "";

  // `--out <dir>` creates its directory (recursively) so the strict D2
  // dirname-existence check passes for the wrapper-generated targets —
  // the user is never required to pre-create the output directory.
  if (outDir !== undefined) {
    try {
      await mkdir(outDir, { recursive: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ValidationError(
        `failed to create vision batch --out directory "${outDir}": ${message}`,
      );
    }
  }

  /**
   * The wrapper's own `<out>/summary.json` write reserves the name: an
   * op whose per-input target would land on `summary.json` would be
   * silently overwritten by (or silently overwrite) the summary, losing
   * one captured result.
   */
  const assertNotReservedOpName = (opName: string, detail: string): void => {
    if (outDir !== undefined && opName === "summary") {
      throw new ValidationError(
        `vision batch operation name "summary" is reserved when --out is used ` +
          `(the wrapper writes ${path.join(outDir, "summary.json")}); ${detail}`,
        "Rename the input or manifest operation so per-input results do not collide with summary.json.",
      );
    }
  };

  let manifest: BatchManifest;
  let manifestPromptTemplate: string | undefined;

  // Input discrimination (D10): a `.json` path without glob
  // metacharacters is a manifest; everything else is a glob.
  const looksLikeManifest =
    !input.includes("*") && !input.includes("?") && input.toLowerCase().endsWith(".json");

  if (looksLikeManifest) {
    let rawText: string;
    try {
      rawText = await readFile(input, "utf8");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ValidationError(`failed to read vision batch manifest "${input}": ${message}`);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(rawText);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ValidationError(`vision batch manifest is not valid JSON: ${message}`);
    }
    if (!isPlainRecord(raw)) {
      throw new ValidationError("vision batch manifest must be a JSON object");
    }
    // `promptTemplate` is a WRAPPER-level field, not a D2 schema field:
    // extract it from the raw JSON BEFORE the strict parse so plain
    // `batch` manifests still reject it as an unknown top-level field.
    if ("promptTemplate" in raw) {
      if (typeof raw.promptTemplate !== "string") {
        throw new ValidationError('vision batch manifest "promptTemplate" must be a string');
      }
      manifestPromptTemplate = raw.promptTemplate;
      delete raw.promptTemplate;
    }
    // Wrapper shape gate (D10): exactly one op, and it must be vision.
    if (!Array.isArray(raw.operations)) {
      throw new ValidationError("vision batch manifest must carry an operations array");
    }
    if (raw.operations.length !== 1) {
      throw new ValidationError(
        `vision batch manifest must contain exactly one operation (found ${raw.operations.length})`,
      );
    }
    const rawOp = raw.operations[0];
    if (!isPlainRecord(rawOp) || rawOp.command !== "vision") {
      throw new ValidationError('vision batch manifest operation must have "command": "vision"');
    }
    // Reserved-name gate runs BEFORE the strict parse: a manifest op
    // named "summary" with --out would collide with summary.json.
    if (typeof rawOp.name === "string") {
      assertNotReservedOpName(rawOp.name, `manifest operation "${rawOp.name}"`);
    }
    // `--out` overrides the op's own output target (never rejected),
    // set BEFORE the strict parse so the D2 dirname-existence check
    // covers it.
    if (outDir !== undefined && typeof rawOp.name === "string") {
      rawOp.output = path.join(outDir, `${rawOp.name}.json`);
    }
    manifest = parseBatchManifest(raw, {
      descriptors: deps.providerDescriptors,
      dirExists: (dir) => existsSync(dir),
    });
    // `promptTemplate` overrides `input.prompt`, substituted against
    // the op's own `source`.
    if (manifestPromptTemplate !== undefined) {
      const op = manifest.operations[0] as VisionBatchOperation;
      const substituted =
        typeof op.input.source === "string"
          ? substituteVisionBatchPrompt(manifestPromptTemplate, op.input.source)
          : manifestPromptTemplate;
      manifest = {
        schemaVersion: 1,
        operations: [{ ...op, input: { ...op.input, prompt: substituted } }],
      };
    }
  } else {
    const inputs = await expandVisionBatchGlob(input);
    for (const entry of inputs) {
      assertNotReservedOpName(entry.opName, `input file "${entry.file}"`);
    }
    if (inputs.length > 1 && outDir === undefined) {
      throw new ValidationError(
        `--out is required when the vision batch input matches more than one file (matched ${inputs.length})`,
        "Pass --out <dir>; per-input results land next to <dir>/summary.json.",
      );
    }
    // `--prompt` is glob-mode only (manifest mode ignores it — the
    // manifest's `promptTemplate` is the only template source there).
    const promptTemplate = typeof flags.prompt === "string" ? flags.prompt : undefined;
    const raw = {
      schemaVersion: 1,
      operations: inputs.map((entry) => ({
        name: entry.opName,
        command: "vision",
        input: {
          subcommand: entry.subcommand,
          source: entry.file,
          ...(promptTemplate !== undefined
            ? { prompt: substituteVisionBatchPrompt(promptTemplate, entry.file) }
            : {}),
        },
        ...(outDir !== undefined ? { output: path.join(outDir, `${entry.opName}.json`) } : {}),
      })),
    };
    manifest = parseBatchManifest(raw, {
      descriptors: deps.providerDescriptors,
      dirExists: (dir) => existsSync(dir),
    });
  }

  // Dry-run boundary (D10): existence + extension validation ONLY —
  // media SIZE validation stays inside the handler. Local paths only;
  // URL sources are the provider's to validate. A `diff` op validates
  // BOTH of its sources (`expected` + `actual`), not `input.source`,
  // which diff ops do not carry.
  if (dryRun) {
    for (const op of manifest.operations) {
      const input = (op as VisionBatchOperation).input;
      const sources =
        input.subcommand === "diff" ? [input.expected, input.actual] : [input.source];
      for (const source of sources) {
        if (typeof source !== "string" || /^https?:\/\//i.test(source)) continue;
        if (!existsSync(source)) {
          throw new ValidationError(
            `vision batch dry run: input file not found: "${source}"`,
            "Fix the source path, or drop --dry-run to let the handler report it per op.",
          );
        }
        const ext = path.extname(source).toLowerCase();
        const accepted = visionBatchAcceptedExtensions(input.subcommand);
        if (!accepted.has(ext)) {
          throw new ValidationError(
            `vision batch dry run: extension "${ext || "(none)"}" is not accepted for vision subcommand "${input.subcommand}" (source "${source}")`,
            `Accepted extensions for ${input.subcommand}: ${[...accepted].sort().join(" ")}.`,
          );
        }
      }
    }
  }

  // Per-op assignment happens HERE (D4), never at the `handleVision`
  // seam: precedence per-op pin > global --provider > distribution.
  const assignments = assignBatchProviders(manifest, {
    descriptors: deps.providerDescriptors,
    env: deps.env,
    globalProvider: deps.provider as ProviderId | undefined,
  });

  const { envelope, exitCode } = await runBatch(
    manifest,
    assignments,
    {
      handlerDeps: deps,
      handlers,
      invocation: deps.invocation,
      outputMode,
      now: deps.now,
    },
    { concurrency, dryRun },
  );

  // The wrapper's one extra write path: `<out>/summary.json` after the
  // runner returns, through the SAME write-temp-then-rename seam the
  // runner uses for per-op outputs so a concurrent reader never
  // observes a truncated summary. Dry runs write nothing (D7), so the
  // summary file appears only in real runs.
  if (outDir !== undefined && !dryRun) {
    const summaryPath = path.join(outDir, "summary.json");
    // Unique temp name (review fix, mirroring the runner's per-op
    // temps): a fixed "<summary>.tmp" is predictable — a concurrent
    // vision batch run against the same --out would clobber it, and a
    // failed write's cleanup could then remove the other run's temp.
    const tempPath = `${summaryPath}.tmp-${randomUUID()}`;
    try {
      await writeFile(tempPath, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
      await rename(tempPath, summaryPath);
    } catch (error) {
      try {
        await rm(tempPath, { force: true });
      } catch {
        // Best-effort cleanup of an already-failing write.
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new ValidationError(
        `failed to write vision batch summary "${summaryPath}": ${message}`,
      );
    }
  }
  return exitCode;
}
