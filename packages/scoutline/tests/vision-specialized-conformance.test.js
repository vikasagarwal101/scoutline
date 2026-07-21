/**
 * MiniMax specialized Vision production conformance.
 *
 * The registry is the source of truth for support. These tests cover the
 * compiled registry, attestation validation, fail-closed runtime behavior,
 * public descriptor/help projections, and the shipped mapping modules.
 * Fixture evaluator and revision-generator self-tests intentionally live
 * outside this production-behavior suite.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadFixtureFile, evaluateAssertions } from "../scripts/lib/vision-conformance.mjs";
import {
  MINIMAX_VISION_CONFORMANCE_REGISTRY,
  MINIMAX_VISION_IMPLEMENTATION_ID,
  SPECIALIZED_VISION_OPERATIONS,
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
import { createZaiDescriptor } from "../dist/providers/zai/adapter.js";
import { VISION_HELP } from "../dist/commands/vision.js";
import { deriveSharedCapabilities } from "../dist/capabilities/diagnostics.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_FILE = resolve(__dirname, "fixtures", "vision", "specialized-cases.json");
const FIXTURE_CASES = loadFixtureFile(FIXTURE_FILE);
const CASES_BY_OP = new Map(FIXTURE_CASES.map((entry) => [entry.operation, entry]));
const PROMOTED_OPS = new Set(["ui-artifact", "extract-text", "diagnose-error", "diagram", "chart"]);
const ATTESTED_OPS = new Set(
  SPECIALIZED_VISION_OPERATIONS.filter((op) => {
    const entry = MINIMAX_VISION_CONFORMANCE_REGISTRY[op];
    return entry.live === "pass" && entry.attestation !== undefined;
  }),
);
const UNATTESTED_OPS = new Set([...PROMOTED_OPS].filter((op) => !ATTESTED_OPS.has(op)));

function makeMinimalRequest(op) {
  if (op === "ui-artifact") {
    return { operation: op, source: "x.png", instruction: "x", outputType: "code" };
  }
  return { operation: op, source: "x.png", instruction: "x" };
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

function craftSatisfyingText(caseData) {
  return caseData.assertions
    .map((assertion) => {
      switch (assertion.type) {
        case "regions":
          return `Regions: ${assertion.regions.join(", ")}.`;
        case "code-form":
          return [
            "<header>Header</header>",
            "<aside>Sidebar</aside>",
            "<main>Content</main>",
            "<footer>Footer</footer>",
            "<div>root</div>",
          ].join("\n");
        case "text-lines":
          return assertion.lines.join("\n");
        case "diagnose-error":
          return `This is a ${assertion.errorClass} caused by ${assertion.causalClue}. Remediation: ${assertion.remediation.join(", ")}.`;
        case "diagram":
          return `Flowchart nodes: ${assertion.nodes.join(", ")}. ${assertion.edges
            .map((edge) => `${edge.from} -> ${edge.to}`)
            .join("; ")}`;
        case "chart":
          return `Chart titled ${assertion.title}. X axis: ${assertion.axes.x}. Y axis: ${assertion.axes.y}. Dominant trend: ${assertion.trend}.`;
        default:
          return "";
      }
    })
    .join("\n\n");
}

function helpNeedleFor(op) {
  const suffix = ATTESTED_OPS.has(op) ? "(Z.AI + MiniMax)" : "(Z.AI; MiniMax gated)";
  const labels = {
    "ui-artifact": `ui-to-code <image> [prompt]         Convert UI screenshot to code ${suffix}`,
    "extract-text": `extract-text <image> [prompt]       OCR for code, terminals, documents ${suffix}`,
    "diagnose-error": `diagnose-error <image> [prompt]     Analyze error screenshots ${suffix}`,
    diagram: `diagram <image> [prompt]            Interpret technical diagrams ${suffix}`,
    chart: `chart <image> [prompt]              Analyze data visualizations ${suffix}`,
  };
  return labels[op];
}

test("compiled registry contains exactly the five specialized operations and is valid", () => {
  assert.deepEqual(
    Object.keys(MINIMAX_VISION_CONFORMANCE_REGISTRY).sort(),
    [...SPECIALIZED_VISION_OPERATIONS].sort(),
  );
  assert.deepEqual(validateConformanceRegistry(MINIMAX_VISION_CONFORMANCE_REGISTRY), []);
});

test("registry entries bind implementation, fixture, revision, state, and attestation", () => {
  for (const op of SPECIALIZED_VISION_OPERATIONS) {
    const entry = MINIMAX_VISION_CONFORMANCE_REGISTRY[op];
    assert.equal(entry.implementationId, MINIMAX_VISION_IMPLEMENTATION_ID);
    assert.ok(Number.isInteger(entry.fixtureVersion) && entry.fixtureVersion > 0);
    assert.equal(entry.mappingRevision, MINIMAX_VISION_MAPPING_REVISIONS[op]);
    assert.equal(entry.offline, PROMOTED_OPS.has(op) ? "pass" : "pending");
    assert.equal(entry.live, ATTESTED_OPS.has(op) ? "pass" : "pending");
    assert.equal(entry.attestation !== undefined, ATTESTED_OPS.has(op));
  }
});

test("support queries return only attested operations in canonical order", () => {
  assert.deepEqual([...listSupportedMiniMaxVisionOperations()], [...ATTESTED_OPS]);
  for (const op of SPECIALIZED_VISION_OPERATIONS) {
    assert.equal(isMiniMaxVisionOperationSupported(op), ATTESTED_OPS.has(op));
  }
  for (const op of ["interpret-image", "diff", "video"]) {
    assert.equal(isMiniMaxVisionOperationSupported(op), false);
  }
});

test("MiniMax descriptor projects the registry support set and retains base capabilities", () => {
  const descriptor = createMiniMaxDescriptor();
  const capabilities = descriptor.capabilities();
  for (const op of SPECIALIZED_VISION_OPERATIONS) {
    assert.equal(capabilities.has(`vision.${op}`), ATTESTED_OPS.has(op));
  }
  for (const capability of ["search", "vision.interpret-image", "quota", "diagnostics"]) {
    assert.ok(capabilities.has(capability));
  }
  assert.ok(!capabilities.has("vision.diff"));
  assert.ok(!capabilities.has("vision.video"));
});

test("unattested operations fail closed before credentials or SDK construction", async () => {
  let constructions = 0;
  function SpySdk() {
    constructions += 1;
    return { vision: { describe: async () => "unreachable" } };
  }
  const adapter = createMiniMaxDescriptor({ sdkConstructor: SpySdk }).create({ env: {} });
  for (const op of UNATTESTED_OPS) {
    await assert.rejects(adapter.vision.invoke(makeMinimalRequest(op)), (error) => {
      assert.equal(error.code, "UNSUPPORTED_CAPABILITY");
      return true;
    });
  }
  assert.equal(constructions, 0);
});

test("Vision help and shared diagnostics capabilities project registry support", () => {
  for (const op of SPECIALIZED_VISION_OPERATIONS) {
    assert.ok(VISION_HELP.includes(helpNeedleFor(op)));
  }
  assert.ok(VISION_HELP.includes("(Z.AI only)"));
  // P6-06: Doctor's sharedCapabilities is now derived from descriptor
  // intersection (Z.AI ∩ MiniMax, in Z.AI's declared capability order)
  // rather than a hand-maintained base list. The derived list MUST
  // contain every capability advertised by both built-ins — including
  // any specialized op that is currently attested by MiniMax — and
  // MUST NOT contain capabilities MiniMax lacks (e.g. vision.diff,
  // vision.video, repository-exploration, reader).
  const shared = deriveSharedCapabilities([createZaiDescriptor(), createMiniMaxDescriptor()]);
  // Base capabilities both Providers advertise.
  for (const cap of ["search", "vision.interpret-image", "quota", "diagnostics"]) {
    assert.ok(shared.includes(cap), `shared includes ${cap}`);
  }
  // Specialized ops appear iff attested by MiniMax (Z.AI always has them).
  for (const op of SPECIALIZED_VISION_OPERATIONS) {
    assert.equal(
      shared.includes(`vision.${op}`),
      ATTESTED_OPS.has(op),
      `vision.${op} in shared iff attested`,
    );
  }
  // Capabilities MiniMax does not advertise stay out of shared.
  for (const cap of ["vision.diff", "vision.video", "repository-exploration", "reader"]) {
    assert.ok(!shared.includes(cap), `shared excludes ${cap}`);
  }
});

test("compiled attestation manifest matches the attested set", () => {
  // Compare as sets (sorted): the manifest is in append-history order
  // (attestations land as each op is live-verified), while ATTESTED_OPS
  // is in canonical SPECIALIZED_VISION_OPERATIONS order. The two diverge
  // once an op is attested out of canonical sequence (e.g. diagnose-error
  // was attested before extract-text). Set equality is the real invariant.
  assert.deepEqual(
    [...MINIMAX_VISION_ATTESTATIONS.map((entry) => entry.operation)].sort(),
    [...ATTESTED_OPS].sort(),
  );
  for (const entry of MINIMAX_VISION_ATTESTATIONS) {
    assert.deepEqual(validateAttestation(entry), []);
  }
});

test("generated mapping keys and revisions match promoted operations", () => {
  assert.deepEqual(Object.keys(MINIMAX_VISION_MAPPINGS).sort(), [...PROMOTED_OPS].sort());
  for (const op of SPECIALIZED_VISION_OPERATIONS) {
    const revision = MINIMAX_VISION_MAPPING_REVISIONS[op];
    if (PROMOTED_OPS.has(op)) assert.match(revision, /^[0-9a-f]{64}$/);
    else assert.equal(revision, "pending-no-mapping-module");
  }
});

test("registry validation rejects missing, unknown, and forbidden operation keys", () => {
  const baseEntry = {
    fixtureVersion: 1,
    implementationId: MINIMAX_VISION_IMPLEMENTATION_ID,
    mappingRevision: "x",
    offline: "pending",
    live: "pending",
  };
  const cases = [
    {
      label: "missing key",
      registry: (() => {
        const copy = { ...MINIMAX_VISION_CONFORMANCE_REGISTRY };
        delete copy.chart;
        return copy;
      })(),
      pattern: /missing key: chart/,
    },
    {
      label: "unknown key",
      registry: { ...MINIMAX_VISION_CONFORMANCE_REGISTRY, bogus: baseEntry },
      pattern: /unknown key: bogus/,
    },
    ...["diff", "video", "interpret-image"].map((op) => ({
      label: `forbidden ${op}`,
      registry: { ...MINIMAX_VISION_CONFORMANCE_REGISTRY, [op]: baseEntry },
      pattern: new RegExp(op),
    })),
  ];
  for (const { label, registry, pattern } of cases) {
    const errors = validateConformanceRegistry(registry);
    assert.ok(
      errors.some((error) => pattern.test(error)),
      `${label}: ${errors.join("; ")}`,
    );
  }
});

test("registry validation rejects malformed entry fields", () => {
  const fake = makeFakeAttestation("chart");
  const cases = [
    ["invalid state", { offline: "supported" }, /offline state invalid/],
    ["invalid fixture version", { fixtureVersion: 0 }, /fixtureVersion/],
    ["implementation mismatch", { implementationId: "other@2" }, /implementationId/],
    ["empty revision", { mappingRevision: "" }, /mappingRevision/],
    ["attestation on pending", { live: "pending", attestation: fake }, /attestation/],
  ];
  for (const [label, override, pattern] of cases) {
    const registry = {
      ...MINIMAX_VISION_CONFORMANCE_REGISTRY,
      chart: { ...MINIMAX_VISION_CONFORMANCE_REGISTRY.chart, ...override },
    };
    const errors = validateConformanceRegistry(registry);
    assert.ok(
      errors.some((error) => pattern.test(error)),
      `${label}: ${errors.join("; ")}`,
    );
  }
});

test("attestation validation rejects malformed identity fields", () => {
  const cases = [
    ["schema", { schemaVersion: 2 }],
    ["provider", { provider: "zai" }],
    ["operation", { operation: "diff" }],
    ["implementation", { implementationId: "" }],
  ];
  for (const [label, override] of cases) {
    assert.ok(
      validateAttestation({ ...makeFakeAttestation("chart"), ...override }).length > 0,
      label,
    );
  }
});

test("attestation validation rejects malformed evidence", () => {
  const cases = [
    ["fixture version", { fixtureVersion: 0 }],
    ["empty assertions", { assertions: [] }],
    ["failed assertion", { assertions: [{ id: "chart.trend", passed: false }] }],
  ];
  for (const [label, override] of cases) {
    assert.ok(
      validateAttestation({ ...makeFakeAttestation("chart"), ...override }).length > 0,
      label,
    );
  }
});

test("environment variables cannot override compiled support metadata", () => {
  const keys = [
    "MINIMAX_VISION_OFFLINE_PASSED",
    "MINIMAX_VISION_LIVE_PASSED",
    "MINIMAX_VISION_SUPPORT_UI_ARTIFACT",
    "MINIMAX_VISION_IMPLEMENTATION_ID",
    "MINIMAX_VISION_ATTESTATION",
    "MINIMAX_API_KEY",
  ];
  const before = getMiniMaxVisionConformanceMetadata();
  const supportBefore = listSupportedMiniMaxVisionOperations();
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) process.env[key] = "1";
    assert.deepEqual(getMiniMaxVisionConformanceMetadata(), before);
    assert.deepEqual(listSupportedMiniMaxVisionOperations(), supportBefore);
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});

test("only pass/pass with a matching attestation enables support", () => {
  const op = "ui-artifact";
  const entry = MINIMAX_VISION_CONFORMANCE_REGISTRY[op];
  const attestation = makeFakeAttestation(op, {
    fixtureVersion: entry.fixtureVersion,
    implementationId: entry.implementationId,
    mappingRevision: entry.mappingRevision,
  });
  const cases = [
    ["pending", "pending", undefined, false],
    ["pass", "pending", undefined, false],
    ["pending", "pass", undefined, false],
    ["pass", "pass", undefined, false],
    ["pass", "pass", attestation, true],
  ];
  for (const [offline, live, attached, expected] of cases) {
    const registry = {
      [op]: {
        ...entry,
        offline,
        live,
        ...(attached ? { attestation: attached } : { attestation: undefined }),
      },
    };
    assert.equal(isMiniMaxVisionOperationSupported(op, { registry }), expected);
  }
});

test("attestation version, implementation, and revision mismatches disable support", () => {
  const op = "ui-artifact";
  const entry = MINIMAX_VISION_CONFORMANCE_REGISTRY[op];
  const overrides = [
    { fixtureVersion: entry.fixtureVersion + 1 },
    { implementationId: "other@2" },
    { mappingRevision: `${entry.mappingRevision}-stale` },
  ];
  for (const override of overrides) {
    const registry = {
      [op]: {
        ...entry,
        offline: "pass",
        live: "pass",
        attestation: makeFakeAttestation(op, {
          fixtureVersion: entry.fixtureVersion,
          implementationId: entry.implementationId,
          mappingRevision: entry.mappingRevision,
          ...override,
        }),
      },
    };
    assert.equal(isMiniMaxVisionOperationSupported(op, { registry }), false);
  }
});

test("support metadata is deterministic and performs no network access", () => {
  const before = JSON.stringify(getMiniMaxVisionConformanceMetadata());
  let fetches = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    fetches += 1;
    throw new Error("registry must be static");
  };
  try {
    assert.equal(JSON.stringify(getMiniMaxVisionConformanceMetadata()), before);
    listSupportedMiniMaxVisionOperations();
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(fetches, 0);
});

test("each promoted mapping composes its prompt and passes offline semantics", () => {
  const hintMarkers = {
    "ui-artifact": "page regions",
    "extract-text": "verbatim",
    "diagnose-error": "error class",
    diagram: "report each node",
    chart: "analyze the chart",
  };
  for (const op of PROMOTED_OPS) {
    const caseData = CASES_BY_OP.get(op);
    const mapping = MINIMAX_VISION_MAPPINGS[op];
    assert.ok(caseData && mapping, `${op} must have a fixture and mapping`);
    const prompt = mapping.composePrompt(caseData.request);
    assert.ok(prompt.includes(caseData.request.instruction));
    assert.ok(prompt.toLowerCase().includes(hintMarkers[op]));
    const text = mapping.normalizeResult({ content: craftSatisfyingText(caseData) });
    const results = evaluateAssertions(caseData.assertions, text);
    assert.ok(
      results.every((result) => result.passed),
      `${op}: ${JSON.stringify(results)}`,
    );
  }
});

test("evaluators reject wrong answers and admit natural VLM variants", () => {
  // This is the load-bearing rejection suite (vision-evaluator-fix-review
  // G1): the loosened evaluators are a strict superset of the ideal shape
  // exercised by craftSatisfyingText, so "stays green" alone proves nothing
  // about over-loosening. These cases prove wrong answers still fail and
  // natural model variants now pass.
  const diagramCase = CASES_BY_OP.get("diagram");
  const chartCase = CASES_BY_OP.get("chart");
  const extractCase = CASES_BY_OP.get("extract-text");

  const rejects = (label, caseData, text) => {
    const results = evaluateAssertions(caseData.assertions, text);
    assert.ok(
      results.some((r) => !r.passed),
      `${label}: expected at least one assertion to FAIL.\n${JSON.stringify(results)}`,
    );
  };
  const accepts = (label, caseData, text) => {
    const results = evaluateAssertions(caseData.assertions, text);
    assert.ok(
      results.every((r) => r.passed),
      `${label}: expected every assertion to PASS.\n${JSON.stringify(results)}`,
    );
  };

  // --- diagram: reversed edge and node-only paragraphs MUST fail ---
  rejects("diagram reversed edge", diagramCase, "Process points to Start. End points to Process.");
  rejects(
    "diagram nodes without directional verb",
    diagramCase,
    "The diagram shows Start, Process, and End as nodes.",
  );
  // --- diagram: natural directional verbs and Unicode arrows now pass ---
  accepts(
    "diagram natural directional verbs",
    diagramCase,
    "The flowchart begins at Start, which connects to Process, which then leads to End.",
  );
  accepts("diagram Unicode arrow", diagramCase, "Start → Process → End");
  accepts(
    "diagram multi-edge single sentence",
    diagramCase,
    "Start flows to Process which flows to End.",
  );

  // --- chart: wrong trend / swapped axes MUST fail ---
  rejects(
    "chart wrong trend only",
    chartCase,
    "Chart titled Quarterly Sales. X axis: Quarter. Y axis: Revenue. Dominant trend: flat.",
  );
  rejects(
    "chart swapped axes (period-separated)",
    chartCase,
    "Chart titled Quarterly Sales. X axis: Revenue. Y axis: Quarter. Dominant trend: increasing.",
  );
  // NOTE: a single-sentence comma-separated swap ("X axis: Revenue,
  // Y axis: Quarter") is an acknowledged limitation of sentence-scoped
  // axis matching — rejecting it would require a tight char-window that
  // also rejects correct real VLM output (the chart fixture's real model
  // output places the Y-axis label ~40 chars from the marker). No
  // observed VLM formats both axes in one comma-separated sentence.
  // --- chart: natural phrasing, trend synonym, and negation now pass ---
  accepts(
    "chart natural phrasing with trend synonym",
    chartCase,
    "The chart Quarterly Sales plots Quarter on the horizontal axis and Revenue on the vertical axis. Values are rising overall.",
  );
  accepts(
    "chart negated forbidden word no longer trips (forbiddenTrends removed)",
    chartCase,
    "Chart titled Quarterly Sales. X axis: Quarter. Y axis: Revenue. The trend is increasing, not flat — revenue is higher each quarter.",
  );

  // --- extract-text: missing / reordered / substituted MUST fail ---
  rejects("extract-text missing line", extractCase, "Line 1: Hello\nLine 2: World");
  rejects(
    "extract-text reordered lines",
    extractCase,
    "Line 1: World\nLine 2: Hello\nLine 3: Test",
  );
  rejects(
    "extract-text substituted word",
    extractCase,
    "Line 1: Hello\nLine 2: Universe\nLine 3: Test",
  );
  // --- extract-text: prefix/separator/case variants, preamble, and markdown
  //     fences now pass (content-fidelity matching, option b) ---
  accepts(
    "extract-text prefix/separator/case variants",
    extractCase,
    "1. hello\n2. WORLD\n3) test",
  );
  accepts(
    "extract-text preamble tolerated",
    extractCase,
    "Here are the transcribed lines:\nLine 1: Hello\nLine 2: World\nLine 3: Test",
  );
  accepts(
    "extract-text markdown fence tolerated",
    extractCase,
    "```\nLine 1: Hello\nLine 2: World\nLine 3: Test\n```",
  );
});

test("current attested and unattested sets are explicit release non-regressions", () => {
  // extract-text + diagram attested live after the evaluator-loosening
  // change (vision-evaluator-fix-plan). chart remains unattested: its
  // fixture image (chart.png, 320x200) has a rotated, tiny Y-axis label
  // that VLMs read inconsistently (Sales/Revenue/Rupees across three
  // independent reads) — a fixture-image-quality blocker, not an
  // evaluator issue. Regenerating chart.png with a clear large label is
  // the follow-up that unblocks it.
  assert.deepEqual([...ATTESTED_OPS], ["ui-artifact", "extract-text", "diagnose-error", "diagram"]);
  assert.deepEqual([...UNATTESTED_OPS], ["chart"]);
});
