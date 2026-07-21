/**
 * GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * Regenerate with: `node scripts/generate-minimax-vision-revisions.mjs`.
 * The prebuild step in `packages/scoutline/package.json` runs the
 * generator before `tsc`, so this file is always fresh when the
 * TypeScript compiler runs.
 *
 * Each value is a SHA-256 digest covering the Implementation ID
 * (`scoutline-direct@0.5.0`), the stable common mapping runtime
 * (`vision-mappings/common.ts`), only that operation's mapping Module
 * under `vision-mappings/`, the fixture image bytes, the canonical
 * request fields, and the exact required assertion IDs. Adding another
 * operation does not change an existing operation's revision; changing
 * the common runtime intentionally changes every revision.
 *
 * The Implementation ID participates in every revision digest, so
 * bumping it (e.g. critique C3 swapping the SDK-backed runtime for
 * the Scoutline direct transport) regenerates the entire map. Any
 * shipped attestation that pins `mappingRevision` must be re-issued
 * against the new revisions before the registry will accept it
 * (see `scripts/attest-minimax-vision.mjs`).
 *
 * Operations without a mapping Module carry the placeholder
 * `"pending-no-mapping-module"` until P5-03 creates their Module.
 */

import type { SpecializedVisionOperation } from "./vision-conformance.js";

export const MINIMAX_VISION_MAPPING_REVISIONS: Readonly<
  Record<SpecializedVisionOperation, string>
> = Object.freeze({
  "ui-artifact": "7428094e0ed28452b8c76290341b08d56e6581f2de543daf803049c418fc9fe8",
  "extract-text": "6387a8d3492f819a921105a14a791db9a78e7b14409bcbd4fce48a6e7dcc61c3",
  "diagnose-error": "f8ba9fc0c8053b3384a24395fc6100c6587c0af3280c0d96ac74f4b9f06ad18e",
  "diagram": "a665e58f86ede08feb6100d1c74153b21715e76e47955e469c2f027b546ffdfd",
  "chart": "1383fa97703b4833ce23001d1f36a68bb19b369c65909b9eb76aa50f7599ccf3",
});
