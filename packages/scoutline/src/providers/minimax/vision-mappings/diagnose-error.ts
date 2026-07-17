/**
 * diagnose-error specialized Vision mapping (DESIGN.md §15, P5-03c).
 *
 * Composes the user instruction, an optional context hint, and the
 * error-diagnosis intent into a single prompt for
 * `sdk.vision.describe`. The user instruction is preserved verbatim;
 * the optional context hint is rendered exactly once. The mapping
 * routes ONLY through `sdk.vision.describe` with one image — it never
 * claims a dedicated MiniMax operation.
 *
 * This Module is wired into the generated operation map
 * (`vision-mappings.generated.ts`) by the prebuild generator and
 * contributes the diagnose-error input to the conformance registry's
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
  formatOptionalOption,
  type MappingPromptSegment,
} from "./common.js";

/**
 * The Normal VisionRequest shape for diagnose-error.
 */
interface DiagnoseErrorRequest {
  readonly operation: "diagnose-error";
  readonly source: string;
  readonly instruction: string;
  readonly context?: string;
}

/**
 * Error-diagnosis intent. Rendered once per prompt as the opening
 * intent segment. Deliberately does NOT reuse the user instruction's
 * phrasing so the instruction remains intact and distinct.
 */
const DIAGNOSE_ERROR_INTENT =
  "Diagnose the error shown in the image. Identify the error class, the cause, and at least one remediation.";

/**
 * The diagnose-error mapping Module. Satisfies the
 * {@link MiniMaxVisionMappingModule} interface declared in the generated
 * operation map.
 */
export const diagnoseErrorMapping: {
  readonly operation: SpecializedVisionOperation;
  composePrompt(request: unknown): string;
  normalizeResult(raw: unknown): string;
} = {
  operation: "diagnose-error",
  composePrompt(request: unknown): string {
    const req = request as DiagnoseErrorRequest;
    const segments: MappingPromptSegment[] = [
      { kind: "intent", text: DIAGNOSE_ERROR_INTENT },
      { kind: "instruction", text: req.instruction },
    ];
    // Optional context hint, rendered at most once.
    const context = formatOptionalOption("Context", req.context);
    if (context.length > 0) {
      segments.push({ kind: "option", text: context });
    }
    return composeMappingPrompt(segments);
  },
  normalizeResult(raw: unknown): string {
    return normalizeMappingResult(raw);
  },
};
