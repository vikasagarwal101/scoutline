/**
 * diagram specialized Vision mapping (DESIGN.md §15, P5-03d).
 *
 * Composes the user instruction, an optional diagram-type hint, and the
 * diagram-interpretation intent into a single prompt for
 * `sdk.vision.describe`. The user instruction is preserved verbatim;
 * the optional diagram-type hint is rendered exactly once. The mapping
 * routes ONLY through `sdk.vision.describe` with one image — it never
 * claims a dedicated MiniMax operation.
 *
 * This Module is wired into the generated operation map
 * (`vision-mappings.generated.ts`) by the prebuild generator and
 * contributes the diagram input to the conformance registry's SHA-256
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
 * The Normal VisionRequest shape for diagram.
 */
interface DiagramRequest {
  readonly operation: "diagram";
  readonly source: string;
  readonly instruction: string;
  readonly diagramType?: string;
}

/**
 * Diagram-interpretation intent. Rendered once per prompt as the
 * opening intent segment. Deliberately distinct from the user
 * instruction's phrasing so the instruction remains intact.
 */
const DIAGRAM_INTENT =
  "Interpret the diagram shown in the image. Report each node by its label and describe how the nodes connect, including the direction of every relationship.";

/**
 * The diagram mapping Module. Satisfies the
 * {@link MiniMaxVisionMappingModule} interface declared in the generated
 * operation map.
 */
export const diagramMapping: {
  readonly operation: SpecializedVisionOperation;
  composePrompt(request: unknown): string;
  normalizeResult(raw: unknown): string;
} = {
  operation: "diagram",
  composePrompt(request: unknown): string {
    const req = request as DiagramRequest;
    const segments: MappingPromptSegment[] = [
      { kind: "intent", text: DIAGRAM_INTENT },
      { kind: "instruction", text: req.instruction },
    ];
    // Optional diagram-type hint, rendered at most once.
    const diagramType = formatOptionalOption("Diagram type", req.diagramType);
    if (diagramType.length > 0) {
      segments.push({ kind: "option", text: diagramType });
    }
    return composeMappingPrompt(segments);
  },
  normalizeResult(raw: unknown): string {
    return normalizeMappingResult(raw);
  },
};
