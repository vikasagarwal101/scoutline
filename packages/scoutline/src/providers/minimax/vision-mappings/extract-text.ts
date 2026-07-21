/**
 * extract-text specialized Vision mapping (DESIGN.md §15, P5-03b).
 *
 * Composes the user instruction, an optional programming-language hint,
 * and the exact-text recovery intent into a single prompt for
 * `sdk.vision.describe`. The user instruction is preserved verbatim;
 * the optional programming-language hint is rendered exactly once. The
 * mapping routes ONLY through `sdk.vision.describe` with one image — it
 * never claims a dedicated MiniMax operation.
 *
 * This Module is wired into the generated operation map
 * (`vision-mappings.generated.ts`) by the prebuild generator and
 * contributes the extract-text input to the conformance registry's
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
 * The Normal VisionRequest shape for extract-text.
 */
interface ExtractTextRequest {
  readonly operation: "extract-text";
  readonly source: string;
  readonly instruction: string;
  readonly programmingLanguage?: string;
}

/**
 * Exact-text recovery intent. Rendered once per prompt as the opening
 * intent segment. Deliberately does NOT reuse the user instruction's
 * phrasing so the instruction remains intact and distinct.
 *
 * The format prescription (preserve prefixes/punctuation/casing;
 * output each line on its own line with no preamble or markdown
 * wrapper) is the prompt-side companion to the evaluator's
 * content-body normalization (option (b), vision-evaluator-fix-review
 * C3): the evaluator tolerates prefix/separator/case variance, but
 * asking the model to preserve the rendered format reduces the chance
 * it reformats OCR output.
 */
const EXTRACT_TEXT_INTENT =
  "Recover every rendered line of text verbatim. Output each line in order; do not paraphrase, summarize, or reorder. Preserve any line numbers, prefixes, punctuation, and casing exactly as rendered. Output each transcribed line on its own line, with no preamble, commentary, or markdown wrapper.";

/**
 * The extract-text mapping Module. Satisfies the
 * {@link MiniMaxVisionMappingModule} interface declared in the generated
 * operation map.
 */
export const extractTextMapping: {
  readonly operation: SpecializedVisionOperation;
  composePrompt(request: unknown): string;
  normalizeResult(raw: unknown): string;
} = {
  operation: "extract-text",
  composePrompt(request: unknown): string {
    const req = request as ExtractTextRequest;
    const segments: MappingPromptSegment[] = [
      { kind: "intent", text: EXTRACT_TEXT_INTENT },
      { kind: "instruction", text: req.instruction },
    ];
    // Optional programming-language hint, rendered at most once.
    const language = formatOptionalOption("Programming language", req.programmingLanguage);
    if (language.length > 0) {
      segments.push({ kind: "option", text: language });
    }
    return composeMappingPrompt(segments);
  },
  normalizeResult(raw: unknown): string {
    return normalizeMappingResult(raw);
  },
};
