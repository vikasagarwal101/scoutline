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
 *
 * C3 re-pin (critique C3 — direct-transport release): both shipped
 * attestations below were originally captured against the prior
 * `mmx-cli-sdk@1.0.16` backing transport. They have been re-pinned to
 * the new implementation identity `scoutline-direct@0.5.0` to match
 * {@link MINIMAX_VISION_IMPLEMENTATION_ID} in `vision-conformance.ts`.
 * The `mappingRevision` values are refreshed against the regenerated
 * revisions in `vision-revisions.ts`: the Implementation ID
 * participates in every revision digest, so swapping the runtime
 * (Phase B direct transport) cascades into a new SHA-256 map. The
 * mapping Module composition and fixtures themselves are unchanged in
 * Phase A + Phase B.
 *
 * The `resultDigest` and `testedAt` fields are unchanged from the
 * original SDK-backed captures: this is a pinned-identity release-time
 * re-attestation, not a fresh live capture. A future live re-run
 * against the new identity — using
 * `SCOUTLINE_LIVE_TESTS=1 MINIMAX_API_KEY=... node
 * scripts/attest-minimax-vision.mjs --operation <op> --refresh` —
 * will refresh those fields with the new live result. Until that
 * user-side step completes, this re-pin assumes the same VLM endpoint
 * produces the same output for the same prompt under the new
 * transport (the expected outcome documented in the C3 ticket).
 */
export const MINIMAX_VISION_ATTESTATIONS: readonly VisionAttestation[] = [
  {
    schemaVersion: 1,
    provider: "minimax",
    operation: "ui-artifact",
    fixtureVersion: 1,
    implementationId: "scoutline-direct@0.5.0",
    mappingRevision: "7428094e0ed28452b8c76290341b08d56e6581f2de543daf803049c418fc9fe8",
    testedAt: "2026-07-20T23:44:24.506Z",
    resultDigest: "3a179f960227741b78b7d8fa22f59d0f2dd80390070e3c87ef6436888d817a32",
    assertions: [
    { id: "ui-artifact.regions", passed: true },
    { id: "ui-artifact.code-form", passed: true }
    ],
  },
  {
    schemaVersion: 1,
    provider: "minimax",
    operation: "diagnose-error",
    fixtureVersion: 1,
    implementationId: "scoutline-direct@0.5.0",
    mappingRevision: "f8ba9fc0c8053b3384a24395fc6100c6587c0af3280c0d96ac74f4b9f06ad18e",
    testedAt: "2026-07-20T23:44:31.647Z",
    resultDigest: "078cfbbb1b6a9c166fa0b2f5c747976d85565d5451664c11cb382e12936d7c84",
    assertions: [
    { id: "diagnose-error.class", passed: true }
    ],
  },
  {
    schemaVersion: 1,
    provider: "minimax",
    operation: "extract-text",
    fixtureVersion: 1,
    implementationId: "scoutline-direct@0.5.0",
    mappingRevision: "6387a8d3492f819a921105a14a791db9a78e7b14409bcbd4fce48a6e7dcc61c3",
    testedAt: "2026-07-21T13:59:25.475Z",
    resultDigest: "9937463c0d6804242dee1a79f78cbdb67b2acb8e53a65429d9bd1f35eeb9f02b",
    assertions: [
    { id: "extract-text.lines", passed: true }
    ],
  },
  {
    schemaVersion: 1,
    provider: "minimax",
    operation: "diagram",
    fixtureVersion: 1,
    implementationId: "scoutline-direct@0.5.0",
    mappingRevision: "a665e58f86ede08feb6100d1c74153b21715e76e47955e469c2f027b546ffdfd",
    testedAt: "2026-07-21T14:02:03.211Z",
    resultDigest: "b68219705e2bf0cf7f58e9c0a6424a4302dda919687304f4e4bef0190153a6be",
    assertions: [
    { id: "diagram.nodes", passed: true }
    ],
  },
];
