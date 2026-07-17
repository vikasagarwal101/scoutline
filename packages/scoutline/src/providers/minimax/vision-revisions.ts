/**
 * GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * Regenerate with: `node scripts/generate-minimax-vision-revisions.mjs`.
 * The prebuild step in `packages/scoutline/package.json` runs the
 * generator before `tsc`, so this file is always fresh when the
 * TypeScript compiler runs.
 *
 * Each value is a SHA-256 digest covering the Implementation ID
 * (`mmx-cli-sdk@1.0.16`), the stable common mapping runtime
 * (`vision-mappings/common.ts`), only that operation's mapping Module
 * under `vision-mappings/`, the fixture image bytes, the canonical
 * request fields, and the exact required assertion IDs. Adding another
 * operation does not change an existing operation's revision; changing
 * the common runtime intentionally changes every revision.
 *
 * Operations without a mapping Module carry the placeholder
 * `"pending-no-mapping-module"` until P5-03 creates their Module.
 */

import type { SpecializedVisionOperation } from "./vision-conformance.js";

export const MINIMAX_VISION_MAPPING_REVISIONS: Readonly<
  Record<SpecializedVisionOperation, string>
> = Object.freeze({
  "ui-artifact": "f359d5cda2f0f6fc7b8b1308a8842ede7a09b8c5517c46e205a46881afeb5290",
  "extract-text": "78758cfc03e282c2609eb4e05fab392be62d9b6d38c8911bf245f74206ccbf0e",
  "diagnose-error": "pending-no-mapping-module",
  "diagram": "pending-no-mapping-module",
  "chart": "pending-no-mapping-module",
});
