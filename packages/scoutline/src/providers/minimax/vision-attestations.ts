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
export const MINIMAX_VISION_ATTESTATIONS: readonly VisionAttestation[] = [
  {
    schemaVersion: 1,
    provider: "minimax",
    operation: "ui-artifact",
    fixtureVersion: 1,
    implementationId: "mmx-cli-sdk@1.0.16",
    mappingRevision: "f359d5cda2f0f6fc7b8b1308a8842ede7a09b8c5517c46e205a46881afeb5290",
    testedAt: "2026-07-17T18:07:29.625Z",
    resultDigest: "3be610d51d6e097a159890804652fd16073773bd6e01b9214d37fe093a9b31e7",
    assertions: [
      { id: "ui-artifact.regions", passed: true },
      { id: "ui-artifact.code-form", passed: true },
    ],
  },
  {
    schemaVersion: 1,
    provider: "minimax",
    operation: "diagnose-error",
    fixtureVersion: 1,
    implementationId: "mmx-cli-sdk@1.0.16",
    mappingRevision: "f83d602a6177041d131cb05b4164e0529b04154a5651e042cea66f566d94d893",
    testedAt: "2026-07-17T18:07:41.170Z",
    resultDigest: "0ce4a1f9518da03d78aee97e04acb6b93a56697abe258042d9af692addc441f2",
    assertions: [{ id: "diagnose-error.class", passed: true }],
  },
];
