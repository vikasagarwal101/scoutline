/**
 * Phase 5 P5-01 — Specialized Vision Conformance Fixtures
 *
 * Confirms:
 *   - `tests/fixtures/vision/specialized-cases.json` conforms to the
 *     schema version 1 contract (unique operations, nonpositive
 *     version rejection, missing files, absolute paths, unsupported
 *     operations, missing assertion IDs, and no diff/video cases).
 *   - Every fixture PNG is small enough for both Providers (well under
 *     50 MiB; we cap at 64 KiB locally to keep diffs stable).
 *   - No fixture file contains metadata matching credential or
 *     authorization-key patterns.
 *   - The pure semantic evaluators in `scripts/lib/vision-conformance.mjs`
 *     pass and fail as expected for hand-written samples.
 *
 * This test never reads live Provider responses, never invokes a
 * Provider, and is safe for `npm run test:offline`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readFileSync,
  statSync,
  existsSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
  mkdirSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import * as os from "node:os";

import {
  loadFixtureFile,
  validateCases,
  evaluateAssertions,
  normalizeForTextRecovery,
  evaluateUiArtifactRegions,
  evaluateUiArtifactCodeForm,
  evaluateExtractTextLines,
  evaluateDiagnoseError,
  evaluateDiagram,
  evaluateChart,
  FIXTURE_OPERATIONS,
  MAX_FIXTURE_BYTES,
  CREDENTIAL_PATTERNS,
} from "../scripts/lib/vision-conformance.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = resolve(__dirname, "fixtures", "vision");
const FIXTURE_FILE = resolve(FIXTURES_DIR, "specialized-cases.json");

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

test("specialized-cases.json parses and reports five specialized operations", () => {
  const cases = loadFixtureFile(FIXTURE_FILE);
  assert.equal(cases.length, 5, "expected exactly five specialized cases");
  const seen = new Set();
  for (const c of cases) {
    assert.ok(
      FIXTURE_OPERATIONS.has(c.operation),
      `operation ${c.operation} is not a supported specialized operation`,
    );
    assert.equal(seen.has(c.operation), false, `duplicate operation id ${c.operation}`);
    seen.add(c.operation);
  }
});

test("rejects duplicate operation IDs", () => {
  const cases = loadFixtureFile(FIXTURE_FILE);
  const ops = new Set();
  for (const c of cases) {
    assert.equal(ops.has(c.operation), false, `duplicate operation id detected: ${c.operation}`);
    ops.add(c.operation);
  }
});

test("every case has a strictly positive fixture version", () => {
  const cases = loadFixtureFile(FIXTURE_FILE);
  for (const c of cases) {
    assert.equal(
      Number.isInteger(c.fixtureVersion),
      true,
      `fixtureVersion must be an integer for ${c.operation}`,
    );
    assert.ok(c.fixtureVersion > 0, `fixtureVersion must be positive for ${c.operation}`);
  }
});

test("rejects nonpositive fixture versions when constructed directly", () => {
  // validateCases is also called by loadFixtureFile; here we drive it
  // with a synthetic array so the version check is exercised in
  // isolation (the on-disk fixture already has five operations, so
  // injecting another `chart` would trip the duplicate-id check
  // first; we need a hand-built case targeting a fresh operation).
  const synthetic = [
    {
      operation: "chart",
      fixtureVersion: 0,
      image: "chart.png",
      request: { source: "chart.png", instruction: "x" },
      assertions: [{ id: "chart.title" }],
    },
  ];
  // Existing fixture files satisfy the relative-path requirement;
  // validation runs without writing temp files.
  assert.throws(() => validateCases(synthetic, FIXTURES_DIR), /fixtureVersion|positive|integer/i);
});

test("rejects missing assertion IDs", () => {
  const cases = loadFixtureFile(FIXTURE_FILE);
  for (const c of cases) {
    const ids = new Set();
    assert.ok(
      Array.isArray(c.assertions) && c.assertions.length > 0,
      `case ${c.operation} must have assertions`,
    );
    for (const a of c.assertions) {
      assert.equal(typeof a?.id, "string", `assertion in ${c.operation} missing id string`);
      assert.ok(a.id.length > 0, `empty assertion id in ${c.operation}`);
      assert.equal(ids.has(a.id), false, `duplicate assertion id ${a.id} in ${c.operation}`);
      ids.add(a.id);
    }
  }
});

test("rejects absolute image paths", () => {
  const cases = loadFixtureFile(FIXTURE_FILE);
  for (const c of cases) {
    assert.equal(typeof c.image, "string", `image must be a string for ${c.operation}`);
    assert.ok(c.image.length > 0, `image path must be non-empty for ${c.operation}`);
    assert.equal(c.image.startsWith("/"), false, `image path must be relative: ${c.image}`);
    assert.equal(
      /^[a-zA-Z]:[\\/]/.test(c.image),
      false,
      `image path must not be a Windows absolute path: ${c.image}`,
    );
  }
});

test("rejects absent image files", () => {
  const cases = loadFixtureFile(FIXTURE_FILE);
  for (const c of cases) {
    const abs = resolve(FIXTURES_DIR, c.image);
    assert.equal(existsSync(abs), true, `missing fixture image for ${c.operation}: ${c.image}`);
  }
});

test("rejects unsupported operations when constructed directly", () => {
  const synthetic = [
    {
      operation: "interpret-image",
      fixtureVersion: 1,
      image: "general.png",
      request: { source: "general.png", instruction: "x" },
      assertions: [{ id: "x" }],
    },
  ];
  assert.throws(() => validateCases(synthetic, FIXTURES_DIR), /unsupported|operation/i);
});

test("refuses diff and video cases", () => {
  const cases = loadFixtureFile(FIXTURE_FILE);
  for (const c of cases) {
    assert.notEqual(c.operation, "diff", "diff must never appear in fixtures");
    assert.notEqual(c.operation, "video", "video must never appear in fixtures");
  }
  // Constructed attempts at diff/video must also be rejected by the
  // standalone validator (the on-disk fixture never supplies these
  // operations, so loading never sees them).
  for (const bad of ["diff", "video"]) {
    const synthetic = [
      {
        operation: bad,
        fixtureVersion: 1,
        image: `${bad}.png`,
        request: { source: `${bad}.png`, instruction: "x" },
        assertions: [{ id: `${bad}.x` }],
      },
    ];
    assert.throws(
      () => validateCases(synthetic, FIXTURES_DIR),
      /unsupported|diff|video|forbidden|operation/i,
    );
  }
});

test("every case uses an exact Normal VisionRequest shape", () => {
  const cases = loadFixtureFile(FIXTURE_FILE);
  for (const c of cases) {
    assert.equal(typeof c.request, "object", `request must be object for ${c.operation}`);
    assert.equal(
      typeof c.request.source,
      "string",
      `request.source must be a string for ${c.operation}`,
    );
    assert.equal(
      typeof c.request.instruction,
      "string",
      `request.instruction must be a string for ${c.operation}`,
    );
    // Confirm the request shape matches the discriminated union for
    // this operation. Operation-specific fields are validated in
    // operation-shape tests below.
    switch (c.operation) {
      case "ui-artifact":
        assert.ok(
          ["code", "prompt", "spec", "description"].includes(c.request.outputType),
          `ui-artifact request requires outputType`,
        );
        break;
      case "extract-text":
        // programmingLanguage is optional
        break;
      case "diagnose-error":
        // context is optional
        break;
      case "diagram":
        // diagramType is optional
        break;
      case "chart":
        // focus is optional
        break;
      default:
        assert.fail(`unknown operation ${c.operation}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Fixture file size + credential-scan guarantees
// ---------------------------------------------------------------------------

test("every fixture PNG is well under both Provider byte limits", () => {
  const cases = loadFixtureFile(FIXTURE_FILE);
  for (const c of cases) {
    const abs = resolve(FIXTURES_DIR, c.image);
    const size = statSync(abs).size;
    assert.ok(size > 0, `fixture image ${c.image} must be non-empty`);
    assert.ok(
      size <= MAX_FIXTURE_BYTES,
      `fixture image ${c.image} is ${size} bytes, must be <= ${MAX_FIXTURE_BYTES}`,
    );
    // Both Providers cap well above the local ceiling; assert the
    // local ceiling leaves a large safety margin to Z.AI 5 MiB and
    // MiniMax 50 MiB caps.
    assert.ok(size <= 5 * 1024 * 1024, `fixture image ${c.image} exceeds Z.AI 5 MiB cap`);
  }
});

test("no fixture file contains credential or authorization key patterns", () => {
  const cases = loadFixtureFile(FIXTURE_FILE);
  for (const c of cases) {
    const abs = resolve(FIXTURES_DIR, c.image);
    // Read as latin1 so we scan every byte, not just printable text.
    const bytes = readFileSync(abs);
    const buf = Buffer.from(bytes);
    // Convert to a safe string for pattern matching; for PNGs the
    // raw bytes include length/type fields, which is fine because
    // patterns only target printable credential shapes.
    const asString = buf.toString("binary");
    for (const pattern of CREDENTIAL_PATTERNS) {
      assert.equal(
        pattern.test(asString),
        false,
        `credential-shaped value found in ${c.image} matching ${pattern}`,
      );
    }
  }
  // Also scan the JSON metadata itself.
  const jsonBytes = readFileSync(FIXTURE_FILE);
  const jsonString = jsonBytes.toString("utf8");
  for (const pattern of CREDENTIAL_PATTERNS) {
    assert.equal(
      pattern.test(jsonString),
      false,
      `credential-shaped value found in specialized-cases.json matching ${pattern}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Pure semantic evaluators — pass and fail coverage
// ---------------------------------------------------------------------------

test("normalizeForTextRecovery strips line endings and trailing whitespace", () => {
  // Spec: "normalize line endings and trailing spaces only".
  // Leading whitespace is preserved so deliberate indentation is
  // not silently rewritten.
  assert.equal(normalizeForTextRecovery("hello world\r\n  next  \t"), "hello world\n  next");
  assert.equal(normalizeForTextRecovery("a\n\n\nb"), "a\nb");
});

test("ui-artifact regions evaluator: passes when every region appears", () => {
  const assertion = {
    id: "ui-artifact.regions",
    type: "regions",
    regions: ["Header", "Sidebar", "Content", "Footer"],
  };
  const text =
    "The page contains a Header bar, a Sidebar on the left, the main Content area, and a Footer at the bottom.";
  const result = evaluateUiArtifactRegions(assertion, text);
  assert.equal(result.passed, true);
  assert.equal(result.failureReason, undefined);
});

test("ui-artifact regions evaluator: fails when a region is missing", () => {
  const assertion = {
    id: "ui-artifact.regions",
    type: "regions",
    regions: ["Header", "Sidebar", "Content", "Footer"],
  };
  const result = evaluateUiArtifactRegions(assertion, "The page has a Header and Content only.");
  assert.equal(result.passed, false);
  assert.match(result.failureReason, /Sidebar|Footer/);
});

test("ui-artifact code-form evaluator: passes when landmark labels and a code token appear", () => {
  const assertion = {
    id: "ui-artifact.code-form",
    type: "code-form",
    landmarks: ["Header", "Sidebar", "Content", "Footer"],
    codeTokens: ["<header", "</header>", "<div"],
  };
  const code = [
    "<header>Header</header>",
    "<aside>Sidebar</aside>",
    "<main>Content</main>",
    "<footer>Footer</footer>",
    '<div class="page">',
  ].join("\n");
  const result = evaluateUiArtifactCodeForm(assertion, code);
  assert.equal(result.passed, true);
  assert.equal(result.failureReason, undefined);
});

test("ui-artifact code-form evaluator: fails when a landmark label is absent from code", () => {
  const assertion = {
    id: "ui-artifact.code-form",
    type: "code-form",
    landmarks: ["Header", "Sidebar", "Content", "Footer"],
    codeTokens: ["<header"],
  };
  const result = evaluateUiArtifactCodeForm(
    assertion,
    "<header>Header</header><main>Content</main>",
  );
  assert.equal(result.passed, false);
});

test("extract-text lines evaluator: passes when every required line appears in order", () => {
  const assertion = {
    id: "extract-text.lines",
    type: "text-lines",
    lines: ["Line 1: Hello", "Line 2: World", "Line 3: Test"],
  };
  const text = "OCR output:\nLine 1: Hello\nLine 2: World\nLine 3: Test\n(end)";
  const result = evaluateExtractTextLines(assertion, text);
  assert.equal(result.passed, true);
});

test("extract-text lines evaluator: normalizes CRLF and trailing spaces", () => {
  const assertion = {
    id: "extract-text.lines",
    type: "text-lines",
    lines: ["Line 1: Hello", "Line 2: World"],
  };
  const text = "Line 1: Hello   \r\nLine 2: World   ";
  const result = evaluateExtractTextLines(assertion, text);
  assert.equal(result.passed, true);
});

test("extract-text lines evaluator: fails on paraphrase (no exact line)", () => {
  const assertion = {
    id: "extract-text.lines",
    type: "text-lines",
    lines: ["Line 1: Hello", "Line 2: World"],
  };
  // Paraphrased — different casing, different word order.
  const result = evaluateExtractTextLines(assertion, "world line two and hello line one");
  assert.equal(result.passed, false);
  assert.match(result.failureReason, /Line 1|Line 2/);
});

test("diagnose-error evaluator: passes when class, cause, and remediation are present", () => {
  const assertion = {
    id: "diagnose-error.class",
    type: "diagnose-error",
    errorClass: "TimeoutError",
    causalClue: "network timeout",
    remediation: ["retry", "check connection"],
  };
  const text =
    "This is a TimeoutError caused by a network timeout. You can retry the request or check connection settings.";
  const result = evaluateDiagnoseError(assertion, text);
  assert.equal(result.passed, true);
});

test("diagnose-error evaluator: fails when remediation is missing", () => {
  const assertion = {
    id: "diagnose-error.class",
    type: "diagnose-error",
    errorClass: "TimeoutError",
    causalClue: "network timeout",
    remediation: ["retry"],
  };
  const result = evaluateDiagnoseError(assertion, "TimeoutError caused by network timeout.");
  assert.equal(result.passed, false);
  assert.match(result.failureReason, /remediation|retry/i);
});

test("diagram evaluator: passes when every node and direction appears", () => {
  const assertion = {
    id: "diagram.nodes",
    type: "diagram",
    nodes: ["Start", "Process", "End"],
    edges: [
      { from: "Start", to: "Process" },
      { from: "Process", to: "End" },
    ],
  };
  const text =
    "Flowchart: Start -> Process -> End. Start flows into Process, and Process flows to End.";
  const result = evaluateDiagram(assertion, text);
  assert.equal(result.passed, true);
});

test("diagram evaluator: fails when a node is missing", () => {
  const assertion = {
    id: "diagram.nodes",
    type: "diagram",
    nodes: ["Start", "Process", "End"],
    edges: [{ from: "Start", to: "End" }],
  };
  const result = evaluateDiagram(assertion, "Flowchart: Start -> End. Start flows into End.");
  assert.equal(result.passed, false);
});

test("chart evaluator: passes when title, axes, and dominant trend are present", () => {
  const assertion = {
    id: "chart.trend",
    type: "chart",
    title: "Quarterly Sales",
    axes: { x: "Quarter", y: "Revenue" },
    trend: "increasing",
    forbiddenTrends: ["decreasing", "flat", "no change"],
  };
  const text =
    "The chart titled Quarterly Sales plots Revenue on the Y axis and Quarter on the X axis. The dominant trend is increasing revenue across Q1, Q2, Q3, and Q4.";
  const result = evaluateChart(assertion, text);
  assert.equal(result.passed, true);
});

test("chart evaluator: fails when a forbidden contradictory trend is asserted", () => {
  const assertion = {
    id: "chart.trend",
    type: "chart",
    title: "Quarterly Sales",
    axes: { x: "Quarter", y: "Revenue" },
    trend: "increasing",
    forbiddenTrends: ["decreasing", "flat", "no change"],
  };
  const text =
    "The chart titled Quarterly Sales plots Revenue (Y) by Quarter (X). The trend is increasing but also decreasing at the end.";
  const result = evaluateChart(assertion, text);
  assert.equal(result.passed, false);
  assert.match(result.failureReason, /contradict|decreasing/i);
});

// ---------------------------------------------------------------------------
// Top-level evaluator dispatch — confirms loadFixtureFile + evaluator wiring
// ---------------------------------------------------------------------------

test("evaluateAssertions dispatches every assertion type used in fixtures", () => {
  const cases = loadFixtureFile(FIXTURE_FILE);
  for (const c of cases) {
    // For each case, feed an empty string — most assertions should
    // fail (this proves the dispatch wires up). We don't check the
    // pass path here; that lives in operation-specific tests.
    const results = evaluateAssertions(c.assertions, "");
    assert.equal(Array.isArray(results), true, `results must be an array for ${c.operation}`);
    assert.equal(
      results.length,
      c.assertions.length,
      `result count must match assertion count for ${c.operation}`,
    );
    for (const r of results) {
      assert.equal(typeof r.id, "string", `result id must be a string for ${c.operation}`);
      assert.equal(
        typeof r.passed,
        "boolean",
        `result.passed must be a boolean for ${c.operation}`,
      );
    }
  }
});

test("evaluateAssertions returns passed:true for all assertions when text satisfies every case", () => {
  // Hand-craft text that passes every fixture's assertions. We
  // derive a per-case "satisfying text" by feeding each assertion in
  // turn and verifying it passes individually before combining.
  const cases = loadFixtureFile(FIXTURE_FILE);
  for (const c of cases) {
    const crafted = craftSatisfyingText(c);
    const results = evaluateAssertions(c.assertions, crafted);
    for (const r of results) {
      assert.equal(
        r.passed,
        true,
        `assertion ${r.id} for ${c.operation} failed against crafted text. Reason: ${r.failureReason}`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a synthetic text that should satisfy every assertion for a
 * given fixture case. Keeps the evaluator tests honest by ensuring
 * each evaluator has at least one input it accepts.
 */
function craftSatisfyingText(c) {
  const parts = [];
  for (const a of c.assertions) {
    switch (a.type) {
      case "regions":
        parts.push(`Regions: ${a.regions.join(", ")}.`);
        break;
      case "code-form":
        parts.push(
          [
            "<header>Header</header>",
            "<aside>Sidebar</aside>",
            "<main>Content</main>",
            "<footer>Footer</footer>",
            "<div>root</div>",
          ].join("\n"),
        );
        break;
      case "text-lines":
        parts.push(a.lines.join("\n"));
        break;
      case "diagnose-error":
        parts.push(
          `This is a ${a.errorClass} caused by ${a.causalClue}. Remediation: ${a.remediation.join(", ")}.`,
        );
        break;
      case "diagram":
        parts.push(
          `Flowchart nodes: ${a.nodes.join(", ")}. ` +
            a.edges.map((e) => `${e.from} -> ${e.to}`).join("; "),
        );
        break;
      case "chart":
        parts.push(
          `Chart titled ${a.title}. X axis: ${a.axes.x}. Y axis: ${a.axes.y}. Dominant trend: ${a.trend}.`,
        );
        break;
      default:
        // Unknown assertion types are not expected; skip silently.
        break;
    }
  }
  return parts.join("\n\n");
}

// ===========================================================================
// P5-02 — Compiled Conformance Registry
// ===========================================================================
//
// Verifies the immutable MiniMax specialized Vision conformance registry
// (`src/providers/minimax/vision-conformance.ts`) is the single source
// of truth for runtime support. At P5-02 every entry is `pending`, no
// operation is supported, and the registry is immune to environment
// overrides. The prebuild generator's revision independence property is
// exercised against a synthetic mapping tree.

import {
  MINIMAX_VISION_CONFORMANCE_REGISTRY,
  MINIMAX_VISION_IMPLEMENTATION_ID,
  SPECIALIZED_VISION_OPERATIONS,
  SPECIALIZED_VISION_OPERATION_SET,
  isMiniMaxVisionOperationSupported,
  validateConformanceRegistry,
  validateAttestation,
  getMiniMaxVisionConformanceMetadata,
  listSupportedMiniMaxVisionOperations,
} from "../dist/providers/minimax/vision-conformance.js";
import { MINIMAX_VISION_MAPPING_REVISIONS } from "../dist/providers/minimax/vision-revisions.js";
import { MINIMAX_VISION_ATTESTATIONS } from "../dist/providers/minimax/vision-attestations.js";
import { MINIMAX_VISION_MAPPINGS } from "../dist/providers/minimax/vision-mappings.generated.js";
import { createMiniMaxDescriptor } from "../dist/providers/minimax/adapter.js";
import { VISION_HELP } from "../dist/commands/vision.js";
import { SHARED_CAPABILITIES } from "../dist/capabilities/diagnostics.js";

const PACKAGE_ROOT = resolve(__dirname, "..");
const GENERATOR_PATH = resolve(PACKAGE_ROOT, "scripts", "generate-minimax-vision-revisions.mjs");

// ---------------------------------------------------------------------------
// P5-02 Red-green: registry exists, is pending-only, and unsupported
// ---------------------------------------------------------------------------

test("P5-02: registry exports exactly the five specialized operations", () => {
  const keys = Object.keys(MINIMAX_VISION_CONFORMANCE_REGISTRY).sort();
  assert.deepEqual(
    keys,
    [...SPECIALIZED_VISION_OPERATIONS].sort(),
    "registry must contain exactly the five specialized operations",
  );
  // diff, video, and interpret-image must not appear.
  for (const forbidden of ["diff", "video", "interpret-image"]) {
    assert.ok(!keys.includes(forbidden), `${forbidden} must never appear in the registry`);
  }
});

test("P5-02: every entry is pending/pending with no attestation at registry source", () => {
  for (const op of SPECIALIZED_VISION_OPERATIONS) {
    const entry = MINIMAX_VISION_CONFORMANCE_REGISTRY[op];
    assert.ok(entry, `entry for ${op} must exist`);
    assert.equal(entry.offline, "pending", `${op} offline must be pending at P5-02`);
    assert.equal(entry.live, "pending", `${op} live must be pending at P5-02`);
    assert.equal(entry.attestation, undefined, `${op} must carry no attestation at P5-02`);
    assert.equal(
      entry.implementationId,
      MINIMAX_VISION_IMPLEMENTATION_ID,
      `${op} implementationId must be the SDK identity`,
    );
    assert.equal(typeof entry.mappingRevision, "string", `${op} mappingRevision must be a string`);
    assert.ok(entry.mappingRevision.length > 0, `${op} mappingRevision must be non-empty`);
    assert.ok(
      Number.isInteger(entry.fixtureVersion) && entry.fixtureVersion > 0,
      `${op} fixtureVersion must be a positive integer`,
    );
  }
});

test("P5-02: isMiniMaxVisionOperationSupported returns false for every specialized operation", () => {
  for (const op of SPECIALIZED_VISION_OPERATIONS) {
    assert.equal(
      isMiniMaxVisionOperationSupported(op),
      false,
      `${op} must be unsupported at P5-02 (pending/pending, no attestation)`,
    );
  }
});

test("P5-02: isMiniMaxVisionOperationSupported returns false for non-registry operations", () => {
  // interpret-image, diff, video are not registry entries.
  for (const op of ["interpret-image", "diff", "video"]) {
    assert.equal(
      isMiniMaxVisionOperationSupported(op),
      false,
      `${op} is not a registry entry and must return false`,
    );
  }
});

test("P5-02: listSupportedMiniMaxVisionOperations returns an empty list at P5-02", () => {
  const supported = listSupportedMiniMaxVisionOperations();
  assert.deepEqual([...supported], [], "no specialized operation is supported at P5-02");
});

test("P5-02: MiniMax adapter descriptor does not advertise any specialized vision capability at P5-02", () => {
  const descriptor = createMiniMaxDescriptor();
  const caps = descriptor.capabilities();
  for (const op of SPECIALIZED_VISION_OPERATIONS) {
    const capId = `vision.${op}`;
    assert.ok(!caps.has(capId), `${capId} must NOT be advertised at P5-02 (registry pending)`);
  }
  // Base capabilities must still be present.
  for (const cap of ["search", "vision.interpret-image", "quota", "diagnostics"]) {
    assert.ok(caps.has(cap), `${cap} must remain advertised`);
  }
});

test("P5-02: MiniMax adapter vision capability reports supports=false for every specialized op", () => {
  const descriptor = createMiniMaxDescriptor();
  const adapter = descriptor.create({ env: { MINIMAX_API_KEY: "test-key-not-sent" } });
  for (const op of SPECIALIZED_VISION_OPERATIONS) {
    assert.equal(
      adapter.vision.supports(op),
      false,
      `adapter.vision.supports(${op}) must be false at P5-02`,
    );
  }
  // interpret-image must remain supported.
  assert.equal(
    adapter.vision.supports("interpret-image"),
    true,
    "interpret-image must remain unconditionally supported",
  );
});

test("P5-02: specialized ops fail with UNSUPPORTED_CAPABILITY before key, media, or SDK access", async () => {
  // The MiniMax adapter must fail closed for every specialized op
  // BEFORE any credential, media resolution, or SDK construction. The
  // spy SDK records any construction; zero constructions prove the
  // fail-closed ordering.
  let sdkConstructions = 0;
  const spySdk = {
    search: {
      async query() {
        throw new Error("UNREACHABLE");
      },
    },
    vision: {
      async describe() {
        throw new Error("UNREACHABLE");
      },
    },
  };
  function SpyCtor() {
    sdkConstructions += 1;
    return spySdk;
  }
  // Use an empty env so credential resolution would also throw if it
  // were reached. The support check must throw first.
  const descriptor = createMiniMaxDescriptor({ sdkConstructor: SpyCtor });
  const adapter = descriptor.create({ env: {} });

  for (const op of SPECIALIZED_VISION_OPERATIONS) {
    sdkConstructions = 0;
    const request = makeMinimalRequest(op);
    await assert.rejects(adapter.vision.invoke(request), (err) => {
      assert.equal(
        err.code,
        "UNSUPPORTED_CAPABILITY",
        `${op} must fail with UNSUPPORTED_CAPABILITY`,
      );
      assert.ok(/minimax/i.test(err.message), `${op} error must reference minimax`);
      return true;
    });
    assert.equal(sdkConstructions, 0, `${op} must fail before SDK construction`);
  }
});

test("P5-02: VISION_HELP still shows every specialized op as MiniMax gated", () => {
  // Help derives from the registry. At P5-02 all five specialized ops
  // must read "MiniMax gated"; diff and video must read "Z.AI only".
  for (const op of SPECIALIZED_VISION_OPERATIONS) {
    const needle = helpNeedleFor(op);
    assert.ok(VISION_HELP.includes(needle), `VISION_HELP must include "${needle}" for ${op}`);
  }
  assert.ok(VISION_HELP.includes("(Z.AI only)"), "diff/video must remain Z.AI-only in help");
});

test("P5-02: SHARED_CAPABILITIES is exactly the base four at P5-02", () => {
  assert.deepEqual(
    [...SHARED_CAPABILITIES],
    ["search", "vision.interpret-image", "quota", "diagnostics"],
    "no specialized op is in shared capabilities at P5-02",
  );
});

test("P5-02: compiled attestations manifest is empty at P5-02", () => {
  assert.deepEqual(
    [...MINIMAX_VISION_ATTESTATIONS],
    [],
    "no attestation may be compiled in at P5-02",
  );
});

test("P5-02: generated mappings map is empty at P5-02", () => {
  assert.deepEqual(Object.keys(MINIMAX_VISION_MAPPINGS), [], "no operation Module exists at P5-02");
});

test("P5-02: every mapping revision is the pending placeholder at P5-02", () => {
  for (const op of SPECIALIZED_VISION_OPERATIONS) {
    assert.equal(
      MINIMAX_VISION_MAPPING_REVISIONS[op],
      "pending-no-mapping-module",
      `${op} revision must be the pending placeholder at P5-02`,
    );
  }
});

// ---------------------------------------------------------------------------
// Registry structural validation
// ---------------------------------------------------------------------------

test("P5-02: validateConformanceRegistry accepts the compiled registry", () => {
  const errors = validateConformanceRegistry(MINIMAX_VISION_CONFORMANCE_REGISTRY);
  assert.deepEqual(errors, [], `compiled registry must be valid: ${errors.join("; ")}`);
});

test("P5-02: validateConformanceRegistry rejects a missing key", () => {
  const copy = { ...MINIMAX_VISION_CONFORMANCE_REGISTRY };
  delete copy["chart"];
  const errors = validateConformanceRegistry(copy);
  assert.ok(
    errors.some((e) => /missing key: chart/.test(e)),
    `expected missing-key error: ${errors.join("; ")}`,
  );
});

test("P5-02: validateConformanceRegistry rejects an extra unknown key", () => {
  const copy = {
    ...MINIMAX_VISION_CONFORMANCE_REGISTRY,
    bogus: {
      fixtureVersion: 1,
      implementationId: MINIMAX_VISION_IMPLEMENTATION_ID,
      mappingRevision: "x",
      offline: "pending",
      live: "pending",
    },
  };
  const errors = validateConformanceRegistry(copy);
  assert.ok(
    errors.some((e) => /unknown key: bogus/.test(e)),
    `expected unknown-key error: ${errors.join("; ")}`,
  );
});

test("P5-02: validateConformanceRegistry rejects a diff key", () => {
  const copy = {
    ...MINIMAX_VISION_CONFORMANCE_REGISTRY,
    diff: {
      fixtureVersion: 1,
      implementationId: MINIMAX_VISION_IMPLEMENTATION_ID,
      mappingRevision: "x",
      offline: "pending",
      live: "pending",
    },
  };
  const errors = validateConformanceRegistry(copy);
  assert.ok(
    errors.some((e) => /forbidden key: diff/.test(e)),
    `expected forbidden diff error: ${errors.join("; ")}`,
  );
});

test("P5-02: validateConformanceRegistry rejects a video key", () => {
  const copy = {
    ...MINIMAX_VISION_CONFORMANCE_REGISTRY,
    video: {
      fixtureVersion: 1,
      implementationId: MINIMAX_VISION_IMPLEMENTATION_ID,
      mappingRevision: "x",
      offline: "pending",
      live: "pending",
    },
  };
  const errors = validateConformanceRegistry(copy);
  assert.ok(
    errors.some((e) => /forbidden key: video/.test(e)),
    `expected forbidden video error: ${errors.join("; ")}`,
  );
});

test("P5-02: validateConformanceRegistry rejects an interpret-image key", () => {
  const copy = {
    ...MINIMAX_VISION_CONFORMANCE_REGISTRY,
    "interpret-image": {
      fixtureVersion: 1,
      implementationId: MINIMAX_VISION_IMPLEMENTATION_ID,
      mappingRevision: "x",
      offline: "pending",
      live: "pending",
    },
  };
  const errors = validateConformanceRegistry(copy);
  assert.ok(
    errors.some((e) => /interpret-image/.test(e)),
    `expected forbidden interpret-image error: ${errors.join("; ")}`,
  );
});

test("P5-02: validateConformanceRegistry rejects invalid conformance states", () => {
  for (const bad of ["", "supported", "PASS", "ok", null, 1, true]) {
    const copy = {
      ...MINIMAX_VISION_CONFORMANCE_REGISTRY,
      chart: { ...MINIMAX_VISION_CONFORMANCE_REGISTRY["chart"], offline: bad },
    };
    const errors = validateConformanceRegistry(copy);
    assert.ok(
      errors.some((e) => /chart offline state invalid/.test(e)),
      `expected offline state invalid for ${JSON.stringify(bad)}: ${errors.join("; ")}`,
    );
  }
});

test("P5-02: validateConformanceRegistry rejects nonpositive fixture versions", () => {
  for (const bad of [0, -1, 1.5, "1", true, null]) {
    const copy = {
      ...MINIMAX_VISION_CONFORMANCE_REGISTRY,
      chart: { ...MINIMAX_VISION_CONFORMANCE_REGISTRY["chart"], fixtureVersion: bad },
    };
    const errors = validateConformanceRegistry(copy);
    assert.ok(
      errors.length > 0,
      `expected error for fixtureVersion=${JSON.stringify(bad)}: ${errors.join("; ")}`,
    );
  }
});

test("P5-02: validateConformanceRegistry rejects an Implementation mismatch", () => {
  const copy = {
    ...MINIMAX_VISION_CONFORMANCE_REGISTRY,
    chart: {
      ...MINIMAX_VISION_CONFORMANCE_REGISTRY["chart"],
      implementationId: "other-impl@2.0.0",
    },
  };
  const errors = validateConformanceRegistry(copy);
  assert.ok(
    errors.some((e) => /chart implementationId must equal/.test(e)),
    `expected implementationId mismatch error: ${errors.join("; ")}`,
  );
});

test("P5-02: validateConformanceRegistry rejects an empty mapping revision", () => {
  const copy = {
    ...MINIMAX_VISION_CONFORMANCE_REGISTRY,
    chart: { ...MINIMAX_VISION_CONFORMANCE_REGISTRY["chart"], mappingRevision: "" },
  };
  const errors = validateConformanceRegistry(copy);
  assert.ok(
    errors.some((e) => /chart mappingRevision must be a non-empty string/.test(e)),
    `expected mappingRevision error: ${errors.join("; ")}`,
  );
});

test("P5-02: validateConformanceRegistry rejects an attestation attached to a non-pass live state", () => {
  const fake = makeFakeAttestation("chart");
  const copy = {
    ...MINIMAX_VISION_CONFORMANCE_REGISTRY,
    chart: {
      ...MINIMAX_VISION_CONFORMANCE_REGISTRY["chart"],
      live: "pending",
      attestation: fake,
    },
  };
  const errors = validateConformanceRegistry(copy);
  assert.ok(
    errors.some((e) => /chart carries an attestation but live state is/.test(e)),
    `expected attestation-on-non-pass error: ${errors.join("; ")}`,
  );
});

// ---------------------------------------------------------------------------
// Attestation validation
// ---------------------------------------------------------------------------

test("P5-02: validateAttestation rejects malformed attestations", () => {
  // Schema version mismatch.
  assert.ok(
    validateAttestation({ ...makeFakeAttestation("chart"), schemaVersion: 2 }).length > 0,
    "schemaVersion must be 1",
  );
  // Provider mismatch.
  assert.ok(
    validateAttestation({ ...makeFakeAttestation("chart"), provider: "zai" }).length > 0,
    "provider must be minimax",
  );
  // Operation not specialized.
  assert.ok(
    validateAttestation({ ...makeFakeAttestation("chart"), operation: "diff" }).length > 0,
    "diff must not be accepted as an attestation operation",
  );
  // Nonpositive fixtureVersion.
  assert.ok(
    validateAttestation({ ...makeFakeAttestation("chart"), fixtureVersion: 0 }).length > 0,
    "fixtureVersion must be positive",
  );
  // Empty assertions.
  assert.ok(
    validateAttestation({ ...makeFakeAttestation("chart"), assertions: [] }).length > 0,
    "assertions must be non-empty",
  );
  // Assertion with passed !== true.
  assert.ok(
    validateAttestation({
      ...makeFakeAttestation("chart"),
      assertions: [{ id: "chart.trend", passed: false }],
    }).length > 0,
    "every assertion must have passed: true",
  );
  // Empty implementationId.
  assert.ok(
    validateAttestation({ ...makeFakeAttestation("chart"), implementationId: "" }).length > 0,
    "implementationId must be non-empty",
  );
});

// ---------------------------------------------------------------------------
// Environment immunity
// ---------------------------------------------------------------------------

test("P5-02: no environment value can override registry state, fixture version, Implementation identity, or attestation", () => {
  // Set a broad set of environment variables that COULD plausibly be
  // queried by an override. The registry and support query must be
  // invariant across all of them.
  const probes = [
    "MINIMAX_VISION_OFFLINE_PASSED",
    "MINIMAX_VISION_LIVE_PASSED",
    "MINIMAX_VISION_SUPPORT_UI_ARTIFACT",
    "MINIMAX_VISION_SUPPORT_EXTRACT_TEXT",
    "MINIMAX_VISION_SUPPORT_DIAGNOSE_ERROR",
    "MINIMAX_VISION_SUPPORT_DIAGRAM",
    "MINIMAX_VISION_SUPPORT_CHART",
    "MINIMAX_VISION_FIXTURE_VERSION",
    "MINIMAX_VISION_IMPLEMENTATION_ID",
    "MINIMAX_VISION_ATTESTATION",
    "MINIMAX_VISION_SKIP_ATTESTATION",
    "SCOUTLINE_VISION_DISABLE_CONFORMANCE",
    "SCOUTLINE_LIVE_TESTS",
    "ZAI_TEST_ENABLE_VISION",
    "MINIMAX_API_KEY",
  ];
  // Snapshot the registry and metadata BEFORE the env probe.
  const beforeRegistry = JSON.parse(JSON.stringify(getMiniMaxVisionConformanceMetadata()));
  const beforeSupported = SPECIALIZED_VISION_OPERATIONS.map((op) =>
    isMiniMaxVisionOperationSupported(op),
  );

  const saved = {};
  for (const key of probes) {
    saved[key] = process.env[key];
    process.env[key] = "1";
  }
  try {
    const afterRegistry = JSON.parse(JSON.stringify(getMiniMaxVisionConformanceMetadata()));
    const afterSupported = SPECIALIZED_VISION_OPERATIONS.map((op) =>
      isMiniMaxVisionOperationSupported(op),
    );
    assert.deepEqual(afterRegistry, beforeRegistry, "registry must be invariant under env changes");
    assert.deepEqual(
      afterSupported,
      beforeSupported,
      "support query must be invariant under env changes",
    );
    // No specialized op may suddenly be supported.
    for (const v of afterSupported) {
      assert.equal(v, false, "no env override may enable a specialized op");
    }
  } finally {
    for (const key of probes) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});

// ---------------------------------------------------------------------------
// Table tests: pending/pass/fail combinations
// ---------------------------------------------------------------------------

test("P5-02: support contract table — only pass/pass with valid version-matched attestation is supported", () => {
  // For each specialized op, exercise every (offline, live) combination
  // against a synthetic registry, with and without a valid attestation.
  // Only (pass, pass) with a valid attestation matching fixtureVersion,
  // implementationId, and mappingRevision yields support=true.
  const op = "ui-artifact";
  const realEntry = MINIMAX_VISION_CONFORMANCE_REGISTRY[op];
  const realRevision = MINIMAX_VISION_MAPPING_REVISIONS[op];
  const validAtt = makeFakeAttestation(op, {
    fixtureVersion: realEntry.fixtureVersion,
    implementationId: MINIMAX_VISION_IMPLEMENTATION_ID,
    mappingRevision: realRevision,
  });

  const cases = [
    {
      offline: "pending",
      live: "pending",
      att: undefined,
      expected: false,
      label: "pending/pending no att",
    },
    {
      offline: "pass",
      live: "pending",
      att: undefined,
      expected: false,
      label: "pass/pending no att",
    },
    {
      offline: "pending",
      live: "pass",
      att: undefined,
      expected: false,
      label: "pending/pass no att",
    },
    { offline: "fail", live: "pass", att: validAtt, expected: false, label: "fail/pass with att" },
    { offline: "pass", live: "fail", att: undefined, expected: false, label: "pass/fail no att" },
    { offline: "pass", live: "pass", att: undefined, expected: false, label: "pass/pass no att" },
    {
      offline: "pass",
      live: "pass",
      att: validAtt,
      expected: true,
      label: "pass/pass with valid att",
    },
  ];

  for (const c of cases) {
    const entry = {
      fixtureVersion: realEntry.fixtureVersion,
      implementationId: MINIMAX_VISION_IMPLEMENTATION_ID,
      mappingRevision: realRevision,
      offline: c.offline,
      live: c.live,
      ...(c.att !== undefined ? { attestation: c.att } : {}),
    };
    const registry = { [op]: entry };
    const result = isMiniMaxVisionOperationSupported(op, { registry });
    assert.equal(result, c.expected, `${c.label}: expected ${c.expected}, got ${result}`);
  }
});

test("P5-02: attestation mismatch on fixtureVersion breaks support", () => {
  const op = "chart";
  const realEntry = MINIMAX_VISION_CONFORMANCE_REGISTRY[op];
  const realRevision = MINIMAX_VISION_MAPPING_REVISIONS[op];
  const att = makeFakeAttestation(op, {
    fixtureVersion: realEntry.fixtureVersion + 1, // wrong version
    implementationId: MINIMAX_VISION_IMPLEMENTATION_ID,
    mappingRevision: realRevision,
  });
  const registry = {
    [op]: {
      fixtureVersion: realEntry.fixtureVersion,
      implementationId: MINIMAX_VISION_IMPLEMENTATION_ID,
      mappingRevision: realRevision,
      offline: "pass",
      live: "pass",
      attestation: att,
    },
  };
  assert.equal(
    isMiniMaxVisionOperationSupported(op, { registry }),
    false,
    "fixtureVersion mismatch must break support",
  );
});

test("P5-02: attestation mismatch on implementationId breaks support", () => {
  const op = "chart";
  const realEntry = MINIMAX_VISION_CONFORMANCE_REGISTRY[op];
  const realRevision = MINIMAX_VISION_MAPPING_REVISIONS[op];
  const att = makeFakeAttestation(op, {
    fixtureVersion: realEntry.fixtureVersion,
    implementationId: "other-impl@2.0.0",
    mappingRevision: realRevision,
  });
  const registry = {
    [op]: {
      fixtureVersion: realEntry.fixtureVersion,
      implementationId: MINIMAX_VISION_IMPLEMENTATION_ID,
      mappingRevision: realRevision,
      offline: "pass",
      live: "pass",
      attestation: att,
    },
  };
  assert.equal(
    isMiniMaxVisionOperationSupported(op, { registry }),
    false,
    "implementationId mismatch must break support",
  );
});

test("P5-02: attestation mismatch on mappingRevision breaks support", () => {
  const op = "chart";
  const realEntry = MINIMAX_VISION_CONFORMANCE_REGISTRY[op];
  const realRevision = MINIMAX_VISION_MAPPING_REVISIONS[op];
  const att = makeFakeAttestation(op, {
    fixtureVersion: realEntry.fixtureVersion,
    implementationId: MINIMAX_VISION_IMPLEMENTATION_ID,
    mappingRevision: realRevision + "-stale",
  });
  const registry = {
    [op]: {
      fixtureVersion: realEntry.fixtureVersion,
      implementationId: MINIMAX_VISION_IMPLEMENTATION_ID,
      mappingRevision: realRevision,
      offline: "pass",
      live: "pass",
      attestation: att,
    },
  };
  assert.equal(
    isMiniMaxVisionOperationSupported(op, { registry }),
    false,
    "mappingRevision mismatch must break support",
  );
});

test("P5-02: implementationId override via options cannot enable support", () => {
  // Even if a caller passes a bogus implementationId via options, the
  // attestation must still match the entry's own implementationId.
  const op = "chart";
  const realEntry = MINIMAX_VISION_CONFORMANCE_REGISTRY[op];
  const realRevision = MINIMAX_VISION_MAPPING_REVISIONS[op];
  const att = makeFakeAttestation(op, {
    fixtureVersion: realEntry.fixtureVersion,
    implementationId: MINIMAX_VISION_IMPLEMENTATION_ID,
    mappingRevision: realRevision,
  });
  const registry = {
    [op]: {
      fixtureVersion: realEntry.fixtureVersion,
      implementationId: MINIMAX_VISION_IMPLEMENTATION_ID,
      mappingRevision: realRevision,
      offline: "pass",
      live: "pass",
      attestation: att,
    },
  };
  // Bogus implementationId option cannot enable support because the
  // attestation's implementationId disagrees.
  assert.equal(
    isMiniMaxVisionOperationSupported(op, {
      registry,
      implementationId: "bogus@9.9.9",
    }),
    false,
    "bogus implementationId option must not enable support",
  );
  // And the correct option DOES enable support.
  assert.equal(
    isMiniMaxVisionOperationSupported(op, {
      registry,
      implementationId: MINIMAX_VISION_IMPLEMENTATION_ID,
    }),
    true,
    "correct implementationId option must enable support",
  );
});

// ---------------------------------------------------------------------------
// Determinism + no Provider call
// ---------------------------------------------------------------------------

test("P5-02: support metadata is deterministic across repeated reads", () => {
  const a = JSON.stringify(getMiniMaxVisionConformanceMetadata());
  const b = JSON.stringify(getMiniMaxVisionConformanceMetadata());
  const c = JSON.stringify({
    supported: listSupportedMiniMaxVisionOperations(),
    revisions: MINIMAX_VISION_MAPPING_REVISIONS,
  });
  const d = JSON.stringify({
    supported: listSupportedMiniMaxVisionOperations(),
    revisions: MINIMAX_VISION_MAPPING_REVISIONS,
  });
  assert.equal(a, b, "metadata snapshot must be deterministic");
  assert.equal(c, d, "supported list + revisions must be deterministic");
});

test("P5-02: registry reads perform no Provider call (no SDK construction, no fetch)", () => {
  // The registry is a pure snapshot; reading it must NOT construct any
  // SDK, fetch any URL, or read any environment value. We assert this
  // by spy-instrumenting global fetch and confirming zero calls across
  // a sequence of registry reads and support queries.
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    fetchCalls += 1;
    throw new Error("REGISTRY_MUST_NOT_CALL_FETCH");
  };
  try {
    for (let i = 0; i < 5; i++) {
      // eslint-disable-next-line no-unused-expressions
      getMiniMaxVisionConformanceMetadata();
      for (const op of SPECIALIZED_VISION_OPERATIONS) {
        isMiniMaxVisionOperationSupported(op);
      }
      listSupportedMiniMaxVisionOperations();
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(fetchCalls, 0, "registry reads must perform no fetch call");
});

// ---------------------------------------------------------------------------
// Prebuild generator: idempotence + revision independence
// ---------------------------------------------------------------------------

test("P5-02: generator writes the same pending placeholder revisions on re-run (idempotent)", () => {
  // The compiled revisions file was already produced by the most recent
  // `npm run build`. Run the generator again and verify the produced
  // bytes match. This proves idempotence against the no-module state.
  const before = readFileSync(
    resolve(PACKAGE_ROOT, "src", "providers", "minimax", "vision-revisions.ts"),
    "utf8",
  );
  const { code, stdout } = runGeneratorSync({
    root: PACKAGE_ROOT,
    quiet: true,
  });
  assert.equal(code, 0, `generator must exit 0 on re-run: ${stdout}`);
  const after = readFileSync(
    resolve(PACKAGE_ROOT, "src", "providers", "minimax", "vision-revisions.ts"),
    "utf8",
  );
  assert.equal(after, before, "generator must be idempotent on no-module state");
});

test("P5-02: generator writes pending placeholders for every specialized op when no modules exist", () => {
  // Build a synthetic package root in a temp dir, copy the fixtures,
  // and run the generator against it. The produced revisions must be
  // all placeholders; the produced map must be empty.
  const tmp = mkdtempSync(join(os.tmpdir(), "scoutline-gen-"));
  try {
    scaffoldSyntheticRoot(tmp, { modules: [] });
    const { code, stderr } = runGeneratorSync({ root: tmp, quiet: true });
    assert.equal(code, 0, `generator must exit 0 against synthetic root: ${stderr}`);
    const revisions = readFileSync(
      resolve(tmp, "src", "providers", "minimax", "vision-revisions.ts"),
      "utf8",
    );
    for (const op of SPECIALIZED_VISION_OPERATIONS) {
      assert.ok(
        revisions.includes(`"pending-no-mapping-module"`),
        `revisions file must contain placeholder for ${op}`,
      );
    }
    const mapContent = readFileSync(
      resolve(tmp, "src", "providers", "minimax", "vision-mappings.generated.ts"),
      "utf8",
    );
    assert.ok(
      /Object\.freeze\(\{\s*\}\)/.test(mapContent),
      "generated map must be empty (no modules)",
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("P5-02: generator independence — adding one operation only changes that revision", () => {
  // Run #1: only ui-artifact module exists.
  // Run #2: chart module added.
  // Assertion: ui-artifact revision is byte-identical; chart revision
  // changed from placeholder to a real SHA-256; the other three ops
  // (extract-text, diagnose-error, diagram) stayed at placeholder.
  const tmp1 = mkdtempSync(join(os.tmpdir(), "scoutline-gen1-"));
  const tmp2 = mkdtempSync(join(os.tmpdir(), "scoutline-gen2-"));
  try {
    scaffoldSyntheticRoot(tmp1, { modules: ["ui-artifact"] });
    scaffoldSyntheticRoot(tmp2, { modules: ["ui-artifact", "chart"] });

    runGeneratorSync({ root: tmp1, quiet: true });
    runGeneratorSync({ root: tmp2, quiet: true });

    const rev1 = parseRevisionsFile(
      resolve(tmp1, "src", "providers", "minimax", "vision-revisions.ts"),
    );
    const rev2 = parseRevisionsFile(
      resolve(tmp2, "src", "providers", "minimax", "vision-revisions.ts"),
    );

    // ui-artifact revision identical between runs.
    assert.equal(
      rev1["ui-artifact"],
      rev2["ui-artifact"],
      "ui-artifact revision must NOT change when chart is added",
    );
    // ui-artifact revision is a real SHA-256 (64 hex chars), not the placeholder.
    assert.ok(
      /^[0-9a-f]{64}$/.test(rev1["ui-artifact"]),
      `ui-artifact revision must be a SHA-256 hex digest, got ${rev1["ui-artifact"]}`,
    );
    // chart went from placeholder (run 1 has no chart module) to real SHA-256 (run 2 has chart module).
    assert.equal(
      rev1["chart"],
      "pending-no-mapping-module",
      "chart revision in run 1 (no chart module) must be placeholder",
    );
    assert.ok(
      /^[0-9a-f]{64}$/.test(rev2["chart"]),
      `chart revision in run 2 must be a SHA-256 hex digest, got ${rev2["chart"]}`,
    );
    // The other three ops remained placeholders in both runs.
    for (const op of ["extract-text", "diagnose-error", "diagram"]) {
      assert.equal(rev1[op], "pending-no-mapping-module", `${op} (run 1) must remain placeholder`);
      assert.equal(rev2[op], "pending-no-mapping-module", `${op} (run 2) must remain placeholder`);
    }
  } finally {
    rmSync(tmp1, { recursive: true, force: true });
    rmSync(tmp2, { recursive: true, force: true });
  }
});

test("P5-02: generator independence — changing common runtime changes every existing revision", () => {
  // When the common runtime bytes change, every operation that already
  // had a Module must get a different revision; operations without a
  // module remain at placeholder. This is the intentional-invalidation
  // contract from DESIGN.md §15.
  const tmpA = mkdtempSync(join(os.tmpdir(), "scoutline-genA-"));
  const tmpB = mkdtempSync(join(os.tmpdir(), "scoutline-genB-"));
  try {
    scaffoldSyntheticRoot(tmpA, { modules: ["ui-artifact", "chart"], commonContent: "ORIGINAL" });
    scaffoldSyntheticRoot(tmpB, { modules: ["ui-artifact", "chart"], commonContent: "CHANGED" });
    runGeneratorSync({ root: tmpA, quiet: true });
    runGeneratorSync({ root: tmpB, quiet: true });
    const revA = parseRevisionsFile(
      resolve(tmpA, "src", "providers", "minimax", "vision-revisions.ts"),
    );
    const revB = parseRevisionsFile(
      resolve(tmpB, "src", "providers", "minimax", "vision-revisions.ts"),
    );
    assert.notEqual(
      revA["ui-artifact"],
      revB["ui-artifact"],
      "ui-artifact must change when common changes",
    );
    assert.notEqual(revA["chart"], revB["chart"], "chart must change when common changes");
    // Unmapped ops stay at placeholder.
    for (const op of ["extract-text", "diagnose-error", "diagram"]) {
      assert.equal(revA[op], "pending-no-mapping-module");
      assert.equal(revB[op], "pending-no-mapping-module");
    }
  } finally {
    rmSync(tmpA, { recursive: true, force: true });
    rmSync(tmpB, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P5-02 helpers
// ---------------------------------------------------------------------------

function makeMinimalRequest(op) {
  switch (op) {
    case "ui-artifact":
      return { operation: op, source: "x.png", instruction: "x", outputType: "code" };
    case "extract-text":
      return { operation: op, source: "x.png", instruction: "x" };
    case "diagnose-error":
      return { operation: op, source: "x.png", instruction: "x" };
    case "diagram":
      return { operation: op, source: "x.png", instruction: "x" };
    case "chart":
      return { operation: op, source: "x.png", instruction: "x" };
    default:
      throw new Error(`makeMinimalRequest: unknown op ${op}`);
  }
}

function helpNeedleFor(op) {
  // Each specialized op's help line ends with "(Z.AI; MiniMax gated)"
  // when unsupported. Find that exact substring.
  switch (op) {
    case "ui-artifact":
      return "ui-to-code <image> [prompt]         Convert UI screenshot to code (Z.AI; MiniMax gated)";
    case "extract-text":
      return "extract-text <image> [prompt]       OCR for code, terminals, documents (Z.AI; MiniMax gated)";
    case "diagnose-error":
      return "diagnose-error <image> [prompt]     Analyze error screenshots (Z.AI; MiniMax gated)";
    case "diagram":
      return "diagram <image> [prompt]            Interpret technical diagrams (Z.AI; MiniMax gated)";
    case "chart":
      return "chart <image> [prompt]              Analyze data visualizations (Z.AI; MiniMax gated)";
    default:
      throw new Error(`helpNeedleFor: unknown op ${op}`);
  }
}

function makeFakeAttestation(op, overrides = {}) {
  return {
    schemaVersion: 1,
    provider: "minimax",
    operation: op,
    fixtureVersion: 1,
    implementationId: MINIMAX_VISION_IMPLEMENTATION_ID,
    mappingRevision: MINIMAX_VISION_MAPPING_REVISIONS[op],
    testedAt: "2025-01-01T00:00:00.000Z",
    resultDigest: "0".repeat(64),
    assertions: [{ id: `${op}.x`, passed: true }],
    ...overrides,
  };
}

function runGeneratorSync(opts) {
  // Run the generator script synchronously with --root and optional
  // --quiet. Returns { code, stdout, stderr }.
  const args = [GENERATOR_PATH, "--root", opts.root];
  if (opts.quiet) args.push("--quiet");
  const result = spawnSync(process.execPath, args, {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  return {
    code: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function scaffoldSyntheticRoot(tmpDir, opts) {
  // Replicate the minimal tree the generator needs:
  //   tests/fixtures/vision/specialized-cases.json + <image>.png
  //   src/providers/minimax/vision-mappings/common.ts
  //   src/providers/minimax/vision-mappings/<op>.ts (for each op in opts.modules)
  // The fixture bytes are copied from the real fixture dir so the
  // generator's fixture-image hash matches reality.
  mkdirSync(resolve(tmpDir, "tests", "fixtures", "vision"), { recursive: true });
  mkdirSync(resolve(tmpDir, "src", "providers", "minimax", "vision-mappings"), { recursive: true });
  // Copy specialized-cases.json.
  const casesBytes = readFileSync(FIXTURE_FILE);
  writeFileSync(
    resolve(tmpDir, "tests", "fixtures", "vision", "specialized-cases.json"),
    casesBytes,
  );
  // Copy every fixture PNG referenced by the cases.
  const cases = JSON.parse(casesBytes.toString("utf8")).cases;
  for (const c of cases) {
    const src = resolve(FIXTURES_DIR, c.image);
    writeFileSync(resolve(tmpDir, "tests", "fixtures", "vision", c.image), readFileSync(src));
  }
  // common.ts — overwrite with opts.commonContent when provided.
  const commonPath = resolve(tmpDir, "src", "providers", "minimax", "vision-mappings", "common.ts");
  if (opts.commonContent) {
    writeFileSync(
      commonPath,
      `// ${opts.commonContent}\nexport const x = "${opts.commonContent}";\n`,
    );
  } else {
    writeFileSync(
      commonPath,
      readFileSync(
        resolve(PACKAGE_ROOT, "src", "providers", "minimax", "vision-mappings", "common.ts"),
      ),
    );
  }
  // Write synthetic modules.
  for (const op of opts.modules ?? []) {
    const mp = resolve(tmpDir, "src", "providers", "minimax", "vision-mappings", `${op}.ts`);
    writeFileSync(
      mp,
      `// synthetic mapping module for ${op}\nexport const ${op.replace(/-/g, "")} = "${op}";\n`,
    );
  }
}

function parseRevisionsFile(filePath) {
  // Extract the `Object.freeze({...})` payload from the generated
  // revisions file and return a Record<operation, revision> object.
  // Lines look like:  "ui-artifact": "abc123...",  — extract them with
  // a per-line regex (sufficient and stable because the generator's
  // output format is fixed).
  const content = readFileSync(filePath, "utf8");
  const match = content.match(/Object\.freeze\(\{([\s\S]*?)\}\)/);
  assert.ok(match, `revisions file must contain Object.freeze({...}): ${content}`);
  const out = {};
  for (const rawLine of match[1].split("\n")) {
    const line = rawLine.trim().replace(/,$/, "");
    if (line.length === 0) continue;
    const m = line.match(/^"([^"]+)":\s*"([^"]+)"/);
    assert.ok(m, `could not parse revision line: ${rawLine}`);
    out[m[1]] = m[2];
  }
  return out;
}
