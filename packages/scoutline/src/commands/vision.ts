/**
 * Vision commands using Z.AI Vision MCP server
 *
 * P1-08: each command returns a CommandResult instead of writing
 * directly to stdout/stderr. Z.AI media preparation and client calls
 * remain unchanged; client cleanup still occurs on success and failure.
 */

import { ZaiMcpClient } from "../lib/mcp-client.js";
import { resolveImageSource, resolveVideoSource } from "../lib/image.js";
import { ValidationError } from "../lib/errors.js";
import type { CommandContext, CommandResult } from "../command-invocation.js";

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

async function withClient<T>(fn: (client: ZaiMcpClient) => Promise<T>): Promise<T> {
  const client = new ZaiMcpClient();
  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
  }
}

export async function analyze(
  imageSource: string,
  prompt: string = DEFAULT_PROMPTS.analyze,
  context?: CommandContext,
): Promise<CommandResult> {
  if (!imageSource) {
    throw new ValidationError(
      "Missing image source",
      "Usage: scoutline vision analyze <image> [prompt]",
    );
  }
  const image = resolveImageSource(imageSource);
  const result = await withClient((client) =>
    client.visionAnalyze({ imageSource: image, prompt }),
  );
  return { kind: "data", data: result };
}

export async function uiToCode(
  imageSource: string,
  prompt: string = DEFAULT_PROMPTS.uiToCode,
  outputType: OutputType = "code",
  context?: CommandContext,
): Promise<CommandResult> {
  if (!imageSource) {
    throw new ValidationError(
      "Missing image source",
      "Usage: scoutline vision ui-to-code <image> [prompt]",
    );
  }
  const image = resolveImageSource(imageSource);
  const result = await withClient((client) =>
    client.visionUiToArtifact({ imageSource: image, outputType, prompt }),
  );
  return { kind: "data", data: result };
}

export async function extractText(
  imageSource: string,
  prompt: string = DEFAULT_PROMPTS.extractText,
  language?: string,
  context?: CommandContext,
): Promise<CommandResult> {
  if (!imageSource) {
    throw new ValidationError(
      "Missing image source",
      "Usage: scoutline vision extract-text <image> [prompt] [--language <lang>]",
    );
  }
  const image = resolveImageSource(imageSource);
  const result = await withClient((client) =>
    client.visionExtractText({
      imageSource: image,
      prompt,
      programmingLanguage: language,
    }),
  );
  return { kind: "data", data: result };
}

export async function diagnoseError(
  imageSource: string,
  prompt: string = DEFAULT_PROMPTS.diagnoseError,
  contextFlag?: string,
  context?: CommandContext,
): Promise<CommandResult> {
  if (!imageSource) {
    throw new ValidationError(
      "Missing image source",
      "Usage: scoutline vision diagnose-error <image> [prompt] [--context <ctx>]",
    );
  }
  const image = resolveImageSource(imageSource);
  const result = await withClient((client) =>
    client.visionDiagnoseError({ imageSource: image, prompt, context: contextFlag }),
  );
  return { kind: "data", data: result };
}

export async function diagram(
  imageSource: string,
  prompt: string = DEFAULT_PROMPTS.diagram,
  diagramType?: string,
  context?: CommandContext,
): Promise<CommandResult> {
  if (!imageSource) {
    throw new ValidationError(
      "Missing image source",
      "Usage: scoutline vision diagram <image> [prompt] [--type <type>]",
    );
  }
  const image = resolveImageSource(imageSource);
  const result = await withClient((client) =>
    client.visionDiagram({ imageSource: image, prompt, diagramType }),
  );
  return { kind: "data", data: result };
}

export async function chart(
  imageSource: string,
  prompt: string = DEFAULT_PROMPTS.chart,
  focus?: string,
  context?: CommandContext,
): Promise<CommandResult> {
  if (!imageSource) {
    throw new ValidationError(
      "Missing image source",
      "Usage: scoutline vision chart <image> [prompt] [--focus <focus>]",
    );
  }
  const image = resolveImageSource(imageSource);
  const result = await withClient((client) =>
    client.visionChart({ imageSource: image, prompt, focus }),
  );
  return { kind: "data", data: result };
}

export async function diff(
  expectedSource: string,
  actualSource: string,
  prompt: string = DEFAULT_PROMPTS.diff,
  context?: CommandContext,
): Promise<CommandResult> {
  if (!expectedSource || !actualSource) {
    throw new ValidationError(
      "Missing image sources",
      "Usage: scoutline vision diff <expected> <actual> [prompt]",
    );
  }
  const expectedImage = resolveImageSource(expectedSource);
  const actualImage = resolveImageSource(actualSource);
  const result = await withClient((client) =>
    client.visionDiff({
      expectedImageSource: expectedImage,
      actualImageSource: actualImage,
      prompt,
    }),
  );
  return { kind: "data", data: result };
}

export async function video(
  videoSource: string,
  prompt: string = DEFAULT_PROMPTS.video,
  context?: CommandContext,
): Promise<CommandResult> {
  if (!videoSource) {
    throw new ValidationError(
      "Missing video source",
      "Usage: scoutline vision video <video> [prompt]",
    );
  }
  const videoPath = resolveVideoSource(videoSource);
  const result = await withClient((client) =>
    client.visionVideo({ videoSource: videoPath, prompt }),
  );
  return { kind: "data", data: result };
}

// Help text
export const VISION_HELP = `
Vision Commands - Analyze images and videos via Z.AI Vision MCP

Usage: scoutline vision <command> <source> [prompt] [options]

Commands:
  analyze <image> [prompt]           General image analysis
  ui-to-code <image> [prompt]        Convert UI screenshot to code
  extract-text <image> [prompt]      OCR for code, terminals, documents
  diagnose-error <image> [prompt]    Analyze error screenshots
  diagram <image> [prompt]           Interpret technical diagrams
  chart <image> [prompt]             Analyze data visualizations
  diff <expected> <actual> [prompt]  Compare two UI screenshots
  video <video> [prompt]             Analyze video content

Options:
  --language <lang>  Programming language hint (extract-text)
  --context <ctx>    Error context (diagnose-error)
  --type <type>      Diagram type hint (diagram)
  --focus <focus>    Analysis focus (chart)
  --output <type>    Output type for ui-to-code: code, prompt, spec, description

Constraints:
  Images: ≤5MB, JPG/PNG/JPEG
  Videos: ≤8MB, MP4/MOV/M4V (URLs supported)

Examples:
  scoutline vision analyze ./screenshot.png "What's in this image?"
  scoutline vision ui-to-code ./design.png --output code
  scoutline vision extract-text ./code.png --language python
  scoutline vision diagnose-error ./error.png --context "during npm install"
  scoutline vision diagram ./arch.png --type architecture
  scoutline vision diff ./expected.png ./actual.png "Check alignment"
  scoutline vision video ./demo.mp4 "Summarize the key steps"
`.trim();