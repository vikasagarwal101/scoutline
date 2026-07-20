/**
 * Offline unit tests for the pure helpers extracted from
 * `scripts/attest-minimax-vision.mjs` into
 * `scripts/lib/attest-manifest.mjs`.
 *
 * Covers the two bugs surfaced during the user's live run that
 * prompted the C3 fixup:
 *
 *   1. `removeAttestationFromManifest` — the previous regex-based
 *      implementation terminated at the first inner `}` it found,
 *      corrupting entries whose `assertions: [...]` array contained
 *      nested object literals (the `ui-artifact` case). The new
 *      brace-counting parser walks each entry with a depth counter
 *      that survives nested braces, escaped string contents, line
 *      comments, block comments, and template literals.
 *
 *   2. `canFlipLiveState` — the previous `main()` order wrote the
 *      attestation to disk BEFORE running the flip-state check, so a
 *      refused flip left a "written but unflipped" manifest. The
 *      precheck is now a pure function of (currentState, refresh)
 *      that `main()` (and `flipLiveStateToPass`) run BEFORE any
 *      write.
 *
 * No fixtures, no live calls, no filesystem access — the lib is
 * pure; we synthesize representative manifest content inline.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  removeAttestationFromManifest,
  canFlipLiveState,
} from "../scripts/lib/attest-manifest.mjs";

// ---------------------------------------------------------------------------
// Test fixtures: synthesized manifest content.
// ---------------------------------------------------------------------------

/**
 * Build a representative manifest with one entry per call, mirroring
 * the `export const MINIMAX_VISION_ATTESTATIONS: readonly
 * VisionAttestation[] = [ ... ];` shape the script reads.
 */
function manifestWith(...entries) {
  const body = entries.length === 0 ? "" : "\n" + entries.join("\n") + "\n";
  return `export const MINIMAX_VISION_ATTESTATIONS: readonly VisionAttestation[] = [${body}];`;
}

/**
 * Single-assertion entry (matches the `diagnose-error` style in the
 * shipped manifest).
 */
function entryFor(op, opts = {}) {
  const { assertions = [{ id: `${op}.class`, passed: true }], mappingRevision = "f".repeat(64), resultDigest = "0".repeat(64), implementationId = "scoutline-direct@0.5.0" } = opts;
  const lines = [
    "  {",
    "    schemaVersion: 1,",
    '    provider: "minimax",',
    `    operation: "${op}",`,
    "    fixtureVersion: 1,",
    `    implementationId: "${implementationId}",`,
    `    mappingRevision: "${mappingRevision}",`,
    '    testedAt: "2026-07-17T18:07:29.625Z",',
    `    resultDigest: "${resultDigest}",`,
    "    assertions: [",
    ...assertions.map((a, i) => `      { id: "${a.id}", passed: true }${i === assertions.length - 1 ? "" : ","}`),
    "    ],",
    "  },",
  ];
  return lines.join("\n");
}

/**
 * Two-assertion entry (matches the `ui-artifact` style — the case
 * that triggered Bug 1 in the user's run, because its assertions
 * array contains two nested object literals).
 */
function entryUiArtifact() {
  return entryFor("ui-artifact", {
    mappingRevision: "7428094e0ed28452b8c76290341b08d56e6581f2de543daf803049c418fc9fe8",
    resultDigest: "3be610d51d6e097a159890804652fd16073773bd6e01b9214d37fe093a9b31e7",
    assertions: [
      { id: "ui-artifact.regions", passed: true },
      { id: "ui-artifact.code-form", passed: true },
    ],
  });
}

/**
 * Single-assertion entry (matches the `diagnose-error` style).
 */
function entryDiagnoseError() {
  return entryFor("diagnose-error", {
    mappingRevision: "f8ba9fc0c8053b3384a24395fc6100c6587c0af3280c0d96ac74f4b9f06ad18e",
    resultDigest: "0ce4a1f9518da03d78aee97e04acb6b93a56697abe258042d9af692addc441f2",
    assertions: [{ id: "diagnose-error.class", passed: true }],
  });
}

// ---------------------------------------------------------------------------
// removeAttestationFromManifest — Bug 1 fix
// ---------------------------------------------------------------------------

test("removeAttestationFromManifest: removes a single-entry manifest cleanly", () => {
  const content = manifestWith(entryUiArtifact());
  const result = removeAttestationFromManifest(content, "ui-artifact");
  // The result must still be a syntactically valid (empty) array
  // literal. The helper strips the entry, its trailing comma, and the
  // inter-entry whitespace, leaving the indentation that was in
  // front of the entry preserved before the closing `];`.
  assert.strictEqual(result.includes("ui-artifact"), false);
  assert.strictEqual(
    result,
    "export const MINIMAX_VISION_ATTESTATIONS: readonly VisionAttestation[] = [\n  ];",
  );
});

test("removeAttestationFromManifest: removes the first entry of a multi-entry manifest", () => {
  const content = manifestWith(entryUiArtifact(), entryDiagnoseError());
  const result = removeAttestationFromManifest(content, "ui-artifact");
  assert.strictEqual(result.includes("ui-artifact"), false);
  assert.strictEqual(result.includes("diagnose-error"), true);
  assert.strictEqual(result.includes("diagnose-error.class"), true);
  // The diagnose-error entry must remain intact (no leftover bits of
  // the removed ui-artifact assertions array).
  assert.strictEqual(result.includes("ui-artifact.regions"), false);
  assert.strictEqual(result.includes("ui-artifact.code-form"), false);
});

test("removeAttestationFromManifest: removes a middle entry", () => {
  const entryExtract = entryFor("extract-text");
  const content = manifestWith(entryUiArtifact(), entryExtract, entryDiagnoseError());
  const result = removeAttestationFromManifest(content, "extract-text");
  assert.strictEqual(result.includes("extract-text"), false);
  assert.strictEqual(result.includes("ui-artifact"), true);
  assert.strictEqual(result.includes("diagnose-error"), true);
});

test("removeAttestationFromManifest: removes the last entry", () => {
  const content = manifestWith(entryUiArtifact(), entryDiagnoseError());
  const result = removeAttestationFromManifest(content, "diagnose-error");
  assert.strictEqual(result.includes("diagnose-error"), false);
  assert.strictEqual(result.includes("ui-artifact"), true);
  // The ui-artifact entry must remain intact.
  assert.strictEqual(result.includes("ui-artifact.regions"), true);
  assert.strictEqual(result.includes("ui-artifact.code-form"), true);
});

test("removeAttestationFromManifest: correctly removes an entry whose assertions array contains nested object literals (Bug 1 regression)", () => {
  // This is the exact shape that corrupted the user's manifest: a
  // single entry with two assertions. The previous regex matched
  // from `{` to the FIRST `}` (the closing of the first assertion),
  // leaving `}, { id: "ui-artifact.code-form", passed: true }, ], }, ...`
  // behind. The new parser must walk past both inner object
  // literals and remove exactly the outer entry plus its trailing
  // comma + whitespace.
  const content = manifestWith(entryUiArtifact());
  const result = removeAttestationFromManifest(content, "ui-artifact");
  assert.strictEqual(result.includes("ui-artifact"), false);
  assert.strictEqual(result.includes("ui-artifact.regions"), false);
  assert.strictEqual(result.includes("ui-artifact.code-form"), false);
  // And critically: no orphaned assertion object literals or
  // dangling commas left behind.
  assert.strictEqual(result.includes("{ id:"), false);
  assert.strictEqual(result.includes(", ],"), false);
  assert.strictEqual(result.includes(",\n  ],"), false);
  assert.strictEqual(result, "export const MINIMAX_VISION_ATTESTATIONS: readonly VisionAttestation[] = [\n  ];");
});

test("removeAttestationFromManifest: is a no-op when the operation is absent", () => {
  const content = manifestWith(entryUiArtifact(), entryDiagnoseError());
  const result = removeAttestationFromManifest(content, "diagram");
  assert.strictEqual(result, content);
});

test("removeAttestationFromManifest: no-op on an empty manifest", () => {
  const content = manifestWith();
  const result = removeAttestationFromManifest(content, "ui-artifact");
  assert.strictEqual(result, content);
});

test("removeAttestationFromManifest: respects escaped quotes inside string literals", () => {
  // Defensive: an entry whose mappingRevision or other field
  // contains an escaped quote must not break the brace walker.
  const trickyEntry = entryFor("ui-artifact", {
    mappingRevision: "abc\\\"def" + "0".repeat(58),
  });
  const content = manifestWith(trickyEntry);
  const result = removeAttestationFromManifest(content, "ui-artifact");
  assert.strictEqual(result.includes("ui-artifact"), false);
  assert.strictEqual(result, "export const MINIMAX_VISION_ATTESTATIONS: readonly VisionAttestation[] = [\n  ];");
});

// ---------------------------------------------------------------------------
// canFlipLiveState — Bug 2 fix
// ---------------------------------------------------------------------------

test("canFlipLiveState: returns ok=true for current 'pending' with refresh=false", () => {
  assert.deepEqual(canFlipLiveState("pending", false), { ok: true });
});

test("canFlipLiveState: returns ok=true for current 'pending' with refresh=true", () => {
  assert.deepEqual(canFlipLiveState("pending", true), { ok: true });
});

test("canFlipLiveState: returns ok=true for current 'pass' with refresh=true", () => {
  // C3 follow-up: pass → pass is allowed when the operator
  // explicitly opts in to re-verification.
  assert.deepEqual(canFlipLiveState("pass", true), { ok: true });
});

test("canFlipLiveState: returns ok=false for current 'pass' with refresh=false", () => {
  const result = canFlipLiveState("pass", false);
  assert.strictEqual(result.ok, false);
  assert.match(result.reason, /pass/);
  assert.match(result.reason, /--refresh|refresh/);
});

test("canFlipLiveState: returns ok=false for current 'fail' with refresh=false", () => {
  const result = canFlipLiveState("fail", false);
  assert.strictEqual(result.ok, false);
  assert.match(result.reason, /fail/);
});

test("canFlipLiveState: returns ok=false for current 'fail' with refresh=true", () => {
  // Even --refresh cannot bypass a deliberate "fail" — the operator
  // must clear the value manually before re-attesting.
  const result = canFlipLiveState("fail", true);
  assert.strictEqual(result.ok, false);
  assert.match(result.reason, /fail/);
});

test("canFlipLiveState: returns ok=false for an unrecognized state value", () => {
  // Defensive: any value other than the three valid states
  // ("pending", "pass", "fail") must refuse, never silently pass.
  for (const state of ["", "unknown", "PASS", "Pending", "1", "null"]) {
    const result = canFlipLiveState(state, false);
    assert.strictEqual(result.ok, false, `state ${JSON.stringify(state)} should be refused`);
  }
  // And the reason must include the bad value so the operator can
  // diagnose the source-file corruption.
  const result = canFlipLiveState("oops", false);
  assert.match(result.reason, /"oops"/);
});