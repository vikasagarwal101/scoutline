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

import type { CommandContext, CommandResult } from "../command-invocation.js";
import type { VisionCapability, VisionRequest, VisionOperation } from "../capabilities/vision.js";
import { executeProviderOperation } from "../lib/execution.js";
import { ValidationError } from "../lib/errors.js";
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
  --provider <zai|minimax|exa>   Select the vision provider (default: zai)
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

Options:
  --language <lang>  Programming language hint (extract-text)
  --context <ctx>    Error context (diagnose-error)
  --type <type>      Diagram type hint (diagram)
  --focus <focus>    Analysis focus (chart)
  --output <type>    Output type for ui-to-code: code, prompt, spec, description

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
`.trim();
}

export const VISION_HELP = buildVisionHelp();

/**
 * Shared Vision execution dependencies. The Capability is the selected
 * Provider's `VisionCapability`; `sleep`/`random` drive retry backoff
 * deterministically under test. Vision bypasses the response cache, so
 * no cache dependency is threaded here.
 */
export interface VisionExecutionDependencies {
  readonly capability: VisionCapability;
  readonly sleep: (ms: number) => Promise<void>;
  readonly random: () => number;
}

/**
 * Invoke a Vision request through shared execution. Vision allows two
 * retries (DESIGN.md §10); the default policy is applied by
 * `executeProviderOperation`. No cache lookup, no fallback Provider.
 */
function runVision(request: VisionRequest, deps: VisionExecutionDependencies): Promise<string> {
  return executeProviderOperation("vision", () => deps.capability.invoke(request), {
    sleep: deps.sleep,
    random: deps.random,
  });
}

export async function analyze(
  imageSource: string,
  prompt: string,
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
  prompt: string,
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
  prompt: string,
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
  prompt: string,
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
  prompt: string,
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
  prompt: string,
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
  prompt: string,
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
  prompt: string,
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
