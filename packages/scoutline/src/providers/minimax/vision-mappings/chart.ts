/**
 * chart specialized Vision mapping (DESIGN.md §15, P5-03e).
 *
 * Composes the user instruction, an optional focus hint, and the
 * chart-analysis intent into a single prompt for
 * `sdk.vision.describe`. The user instruction is preserved verbatim;
 * the optional focus hint is rendered exactly once. The mapping routes
 * ONLY through `sdk.vision.describe` with one image — it never claims a
 * dedicated MiniMax operation.
 *
 * This Module is wired into the generated operation map
 * (`vision-mappings.generated.ts`) by the prebuild generator and
 * contributes the chart input to the conformance registry's SHA-256
 * mapping revision. It stays unsupported at runtime until a separate
 * opt-in live attestation flips the registry's live state to "pass"
 * (DESIGN.md §15).
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
  formatOptionalOption,
  type MappingPromptSegment,
} from "./common.js";

/**
 * The Normal VisionRequest shape for chart.
 */
interface ChartRequest {
  readonly operation: "chart";
  readonly source: string;
  readonly instruction: string;
  readonly focus?: string;
}

/**
 * Chart-analysis intent. Rendered once per prompt as the opening intent
 * segment. Deliberately distinct from the user instruction's phrasing
 * so the instruction remains intact.
 */
const CHART_INTENT =
  "Analyze the chart shown in the image. Report its title or subject, what each axis measures, and the overall direction of the data.";

/**
 * The chart mapping Module. Satisfies the
 * {@link MiniMaxVisionMappingModule} interface declared in the generated
 * operation map.
 */
export const chartMapping: {
  readonly operation: SpecializedVisionOperation;
  composePrompt(request: unknown): string;
  normalizeResult(raw: unknown): string;
} = {
  operation: "chart",
  composePrompt(request: unknown): string {
    const req = request as ChartRequest;
    const segments: MappingPromptSegment[] = [
      { kind: "intent", text: CHART_INTENT },
      { kind: "instruction", text: req.instruction },
    ];
    // Optional focus hint, rendered at most once.
    const focus = formatOptionalOption("Focus", req.focus);
    if (focus.length > 0) {
      segments.push({ kind: "option", text: focus });
    }
    return composeMappingPrompt(segments);
  },
  normalizeResult(raw: unknown): string {
    return normalizeMappingResult(raw);
  },
};
