/**
 * Compiled MiniMax specialized-vision attestations (DESIGN.md §15, P5-02).
 *
 * Sanitized, schema-version-1 attestations written by the Phase 5
 * `scripts/attest-minimax-vision.mjs` flow (P5-03). Each entry contains
 * ONLY: provider id, operation id, fixture version, Implementation id,
 * generated mapping revision, UTC execution timestamp, SHA-256 result
 * digest, and the list of semantic assertion IDs each marked `passed:
 * true`. No returned prose, key, URL with credentials, headers, raw
 * response body, local path, or stack is ever present.
 *
 * At P5-02 the manifest is intentionally empty: no operation has been
 * attested. The support query in `vision-conformance.ts` therefore
 * returns false for every specialized operation until P5-03 fills this
 * array. The compiled manifest is the single source of attestation
 * truth; there is no runtime filesystem lookup or environment override.
 *
 * Boundary: this module exports a pure, immutable typed array. It
 * imports only the attestation type from `vision-conformance.ts` and
 * never touches the registry, environment, or filesystem.
 */

import type { VisionAttestation } from "./vision-conformance.js";

/**
 * The compiled sanitized attestation manifest. Each entry is keyed by
 * `operation`; the registry construction indexes this list at module
 * load. P5-03's attestation script appends sanitized entries here.
 */
export const MINIMAX_VISION_ATTESTATIONS: readonly VisionAttestation[] = [];
