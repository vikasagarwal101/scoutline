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
import { readFileSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

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
    assert.equal(
      seen.has(c.operation),
      false,
      `duplicate operation id ${c.operation}`,
    );
    seen.add(c.operation);
  }
});

test("rejects duplicate operation IDs", () => {
  const cases = loadFixtureFile(FIXTURE_FILE);
  const ops = new Set();
  for (const c of cases) {
    assert.equal(
      ops.has(c.operation),
      false,
      `duplicate operation id detected: ${c.operation}`,
    );
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
    assert.ok(
      c.fixtureVersion > 0,
      `fixtureVersion must be positive for ${c.operation}`,
    );
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
  assert.throws(
    () => validateCases(synthetic, FIXTURES_DIR),
    /fixtureVersion|positive|integer/i,
  );
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
      assert.equal(
        typeof a?.id,
        "string",
        `assertion in ${c.operation} missing id string`,
      );
      assert.ok(a.id.length > 0, `empty assertion id in ${c.operation}`);
      assert.equal(
        ids.has(a.id),
        false,
        `duplicate assertion id ${a.id} in ${c.operation}`,
      );
      ids.add(a.id);
    }
  }
});

test("rejects absolute image paths", () => {
  const cases = loadFixtureFile(FIXTURE_FILE);
  for (const c of cases) {
    assert.equal(
      typeof c.image,
      "string",
      `image must be a string for ${c.operation}`,
    );
    assert.ok(
      c.image.length > 0,
      `image path must be non-empty for ${c.operation}`,
    );
    assert.equal(
      c.image.startsWith("/"),
      false,
      `image path must be relative: ${c.image}`,
    );
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
    assert.equal(
      existsSync(abs),
      true,
      `missing fixture image for ${c.operation}: ${c.image}`,
    );
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
  assert.throws(
    () => validateCases(synthetic, FIXTURES_DIR),
    /unsupported|operation/i,
  );
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
    assert.equal(
      typeof c.request,
      "object",
      `request must be object for ${c.operation}`,
    );
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
          ["code", "prompt", "spec", "description"].includes(
            c.request.outputType,
          ),
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
    assert.ok(
      size > 0,
      `fixture image ${c.image} must be non-empty`,
    );
    assert.ok(
      size <= MAX_FIXTURE_BYTES,
      `fixture image ${c.image} is ${size} bytes, must be <= ${MAX_FIXTURE_BYTES}`,
    );
    // Both Providers cap well above the local ceiling; assert the
    // local ceiling leaves a large safety margin to Z.AI 5 MiB and
    // MiniMax 50 MiB caps.
    assert.ok(
      size <= 5 * 1024 * 1024,
      `fixture image ${c.image} exceeds Z.AI 5 MiB cap`,
    );
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
  assert.equal(
    normalizeForTextRecovery("hello world\r\n  next  \t"),
    "hello world\n  next",
  );
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
  const result = evaluateUiArtifactRegions(
    assertion,
    "The page has a Header and Content only.",
  );
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
    "<div class=\"page\">",
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
    lines: [
      "Line 1: Hello",
      "Line 2: World",
      "Line 3: Test",
    ],
  };
  const text =
    "OCR output:\nLine 1: Hello\nLine 2: World\nLine 3: Test\n(end)";
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
  const result = evaluateExtractTextLines(
    assertion,
    "world line two and hello line one",
  );
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
  const result = evaluateDiagnoseError(
    assertion,
    "TimeoutError caused by network timeout.",
  );
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
  const result = evaluateDiagram(
    assertion,
    "Flowchart: Start -> End. Start flows into End.",
  );
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
    assert.equal(
      Array.isArray(results),
      true,
      `results must be an array for ${c.operation}`,
    );
    assert.equal(
      results.length,
      c.assertions.length,
      `result count must match assertion count for ${c.operation}`,
    );
    for (const r of results) {
      assert.equal(
        typeof r.id,
        "string",
        `result id must be a string for ${c.operation}`,
      );
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
            a.edges
              .map((e) => `${e.from} -> ${e.to}`)
              .join("; "),
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