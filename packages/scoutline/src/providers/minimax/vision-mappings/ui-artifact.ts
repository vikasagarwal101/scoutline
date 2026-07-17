/**
 * ui-artifact specialized Vision mapping (DESIGN.md §15, P5-03a).
 *
 * Composes the user instruction, the selected output form, and the
 * UI-artifact analysis intent into a single prompt for
 * `sdk.vision.describe`. The user instruction is preserved verbatim;
 * the output-type hint is rendered exactly once. The mapping routes
 * ONLY through `sdk.vision.describe` with one image — it never claims a
 * dedicated MiniMax operation.
 *
 * This Module is wired into the generated operation map
 * (`vision-mappings.generated.ts`) by the prebuild generator and
 * contributes the ui-artifact input to the conformance registry's
 * SHA-256 mapping revision. It stays unsupported at runtime until a
 * separate opt-in live attestation flips the registry's live state to
 * "pass" (DESIGN.md §15).
 *
 * Boundary rules:
 *   - Pure prompt composition + result normalization only. No
 *     `process.env`, no filesystem, no network, no Provider imports.
 *   - Imports only the shared common runtime helpers; any change to
 *     `common.ts` intentionally invalidates this mapping's revision.
 */

import type { SpecializedVisionOperation } from "../vision-conformance.js";
import {
  composeMappingPrompt,
  normalizeMappingResult,
  type MappingPromptSegment,
} from "./common.js";

/**
 * The Normal VisionRequest shape for ui-artifact. Narrowed from
 * `unknown` so the compose logic is type-checked without re-exporting
 * the discriminated union across the Provider boundary.
 */
interface UiArtifactRequest {
  readonly operation: "ui-artifact";
  readonly source: string;
  readonly instruction: string;
  readonly outputType: "code" | "prompt" | "spec" | "description";
}

/**
 * UI-artifact analysis intent. Rendered once per prompt as the opening
 * intent segment. Deliberately does NOT mention the selected output
 * form — that hint lives in its own option segment so operation hints
 * are represented exactly once.
 */
const UI_ARTIFACT_INTENT =
  "You are analyzing a user-interface screenshot. Identify the visible page regions (such as header, sidebar, content, and footer) and produce the artifact requested below.";

/**
 * Map the ui-artifact outputType to a human-readable label for the
 * option segment. Kept here (not in common.ts) because it is
 * operation-specific.
 */
function outputFormLabel(outputType: UiArtifactRequest["outputType"]): string {
  switch (outputType) {
    case "code":
      return "code (markup)";
    case "prompt":
      return "a prompt";
    case "spec":
      return "a specification";
    case "description":
      return "a description";
  }
}

/**
 * The ui-artifact mapping Module. Satisfies the
 * {@link MiniMaxVisionMappingModule} interface declared in the generated
 * operation map.
 */
export const uiArtifactMapping: {
  readonly operation: SpecializedVisionOperation;
  composePrompt(request: unknown): string;
  normalizeResult(raw: unknown): string;
} = {
  operation: "ui-artifact",
  composePrompt(request: unknown): string {
    const req = request as UiArtifactRequest;
    const segments: readonly MappingPromptSegment[] = [
      { kind: "intent", text: UI_ARTIFACT_INTENT },
      { kind: "option", text: `Requested output form: ${outputFormLabel(req.outputType)}` },
      { kind: "instruction", text: req.instruction },
    ];
    return composeMappingPrompt(segments);
  },
  normalizeResult(raw: unknown): string {
    return normalizeMappingResult(raw);
  },
};
