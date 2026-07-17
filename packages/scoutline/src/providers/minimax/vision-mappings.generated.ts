/**
 * GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * Regenerate with: `node scripts/generate-minimax-vision-revisions.mjs`.
 * The prebuild step in `packages/scoutline/package.json` runs the
 * generator before `tsc`, so this file is always fresh when the
 * TypeScript compiler runs.
 *
 * The operation map connects each specialized Vision operation id to
 * its mapping Module (`vision-mappings/{op}.ts`). Currently 4 of 5 operations have Modules.
 */

import type { SpecializedVisionOperation } from "./vision-conformance.js";
import { uiArtifactMapping } from "./vision-mappings/ui-artifact.js";
import { extractTextMapping } from "./vision-mappings/extract-text.js";
import { diagnoseErrorMapping } from "./vision-mappings/diagnose-error.js";
import { diagramMapping } from "./vision-mappings/diagram.js";

/**
 * The interface every operation-specific mapping Module implements.
 * Defined here so the generated map has a stable type even when the
 * map itself is empty. P5-03's Modules will satisfy this shape.
 */
export interface MiniMaxVisionMappingModule {
  readonly operation: SpecializedVisionOperation;
  composePrompt(request: unknown): string;
  normalizeResult(raw: unknown): string;
}

/**
 * The generated operation map. The Adapter looks up the Module for a
 * supported operation; absence here means the operation is not wired
 * even if its registry entry is fully passing.
 */
export const MINIMAX_VISION_MAPPINGS: Readonly<
  Partial<Record<SpecializedVisionOperation, MiniMaxVisionMappingModule>>
> = Object.freeze({
  "ui-artifact": uiArtifactMapping,
  "extract-text": extractTextMapping,
  "diagnose-error": diagnoseErrorMapping,
  "diagram": diagramMapping,
});
