/**
 * GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * Regenerate with: `node scripts/generate-minimax-vision-revisions.mjs`.
 * The prebuild step in `packages/scoutline/package.json` runs the
 * generator before `tsc`, so this file is always fresh when the
 * TypeScript compiler runs.
 *
 * The operation map connects each specialized Vision operation id to
 * its mapping Module (`vision-mappings/{op}.ts`). No operation-specific Modules exist yet, so the map is empty (P5-02 state).
 */

import type { SpecializedVisionOperation } from "./vision-conformance.js";
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
> = Object.freeze({});
