#!/usr/bin/env node
/**
 * Phase 5 P5-01 — Specialized Vision Conformance Library
 *
 * Pure (no I/O at import, no Provider calls, no global state) helpers
 * for loading and evaluating the specialized-vision fixture file
 * `tests/fixtures/vision/specialized-cases.json`.
 *
 * Consumed by:
 *   - tests/vision-specialized-conformance.test.js (this commit)
 *   - scripts/attest-minimax-vision.mjs (P5-03, later)
 *
 * Design rules (DESIGN.md §15 + phases/05-specialized-vision.md):
 *   - Evaluators are conservative and deterministic: case-folded,
 *     whitespace-normalized, explicit required terms only.
 *   - No environment override, no filesystem glob, no Provider call.
 *   - Diff and video are never accepted by the loader.
 *   - Credential patterns are exposed for test-side scanning; they
 *     must never appear in fixture files.
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve, isAbsolute } from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Operations that may appear in `specialized-cases.json`. Diff and
 * video are intentionally excluded: they remain Z.AI-only and never
 * enter the MiniMax specialized registry (DESIGN.md §15).
 */
export const FIXTURE_OPERATIONS = new Set([
  "ui-artifact",
  "extract-text",
  "diagnose-error",
  "diagram",
  "chart",
]);

/**
 * Operations that must NEVER appear in the specialized fixture file.
 */
export const FORBIDDEN_OPERATIONS = new Set(["diff", "video"]);

/**
 * Local ceiling on fixture PNG size. Both Providers support far
 * more (Z.AI 5 MiB, MiniMax 50 MiB); keeping fixtures small keeps
 * the diff stable and makes accidental credential embedding easier
 * to spot.
 */
export const MAX_FIXTURE_BYTES = 64 * 1024; // 64 KiB

/**
 * Credential / authorization-key patterns. Each pattern must be a
 * RegExp. Patterns are matched against fixture file bytes; any hit
 * is a fixture-load failure.
 */
export const CREDENTIAL_PATTERNS = [
  /Z_AI_API_KEY\s*[:=]\s*["']?[A-Za-z0-9._\-]{8,}/i,
  /ZAI_API_KEY\s*[:=]\s*["']?[A-Za-z0-9._\-]{8,}/i,
  /MINIMAX_API_KEY\s*[:=]\s*["']?[A-Za-z0-9._\-]{8,}/i,
  /Bearer\s+[A-Za-z0-9._\-]{12,}/i,
  /x-api-key\s*[:=]\s*["']?[A-Za-z0-9._\-]{8,}/i,
  /sk-[A-Za-z0-9]{16,}/,
  /sk_live_[A-Za-z0-9]{16,}/,
];

// ---------------------------------------------------------------------------
// Loading + validation
// ---------------------------------------------------------------------------

/**
 * Load `specialized-cases.json` and return the validated case array.
 *
 * Throws if the file is missing, malformed, or any case fails schema
 * validation. `extraCases` (test-only) may be appended to exercise
 * rejection paths without writing temporary files.
 *
 * Schema rules enforced:
 *   - top-level has `schemaVersion: 1` and a `cases` array;
 *   - every case has a unique, supported operation id;
 *   - every case has a strictly positive integer `fixtureVersion`;
 *   - every case has a relative, non-empty `image` path that exists
 *     relative to `fixturesDir` (default: dir of `filePath`);
 *   - every case has a `request` object with `source` and
 *     `instruction` strings;
 *   - every case has at least one assertion with a unique string id;
 *   - `diff` and `video` cases are refused.
 */
export function loadFixtureFile(filePath, options = {}) {
  const { extraCases = [], fixturesDir } = options;

  let raw;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    throw new Error(
      `unable to read fixture file at ${filePath}: ${err.message}`,
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `specialized-cases.json is not valid JSON: ${err.message}`,
    );
  }

  if (parsed.schemaVersion !== 1) {
    throw new Error(
      `specialized-cases.json schemaVersion must be 1, got ${parsed.schemaVersion}`,
    );
  }
  if (!Array.isArray(parsed.cases)) {
    throw new Error("specialized-cases.json must have a `cases` array");
  }

  const baseDir = fixturesDir ?? dirname(filePath);
  const cases = [...parsed.cases, ...extraCases];
  validateCases(cases, baseDir);
  return cases;
}

/**
 * Validate an array of cases against the schema. Throws on the first
 * violation; otherwise returns silently.
 */
export function validateCases(cases, fixturesDir) {
  const seenOps = new Set();
  for (const c of cases) {
    if (!c || typeof c !== "object") {
      throw new Error("fixture case must be an object");
    }
    if (typeof c.operation !== "string") {
      throw new Error("fixture case operation must be a string");
    }
    if (FORBIDDEN_OPERATIONS.has(c.operation)) {
      throw new Error(
        `fixture case operation ${c.operation} is forbidden; diff and video never enter the specialized registry`,
      );
    }
    if (!FIXTURE_OPERATIONS.has(c.operation)) {
      throw new Error(
        `unsupported operation ${c.operation}; expected one of ${[...FIXTURE_OPERATIONS].join(", ")}`,
      );
    }
    if (seenOps.has(c.operation)) {
      throw new Error(`duplicate operation id ${c.operation}`);
    }
    seenOps.add(c.operation);

    if (!Number.isInteger(c.fixtureVersion)) {
      throw new Error(
        `fixtureVersion must be an integer for ${c.operation}`,
      );
    }
    if (c.fixtureVersion <= 0) {
      throw new Error(
        `fixtureVersion must be a positive integer for ${c.operation}, got ${c.fixtureVersion}`,
      );
    }

    if (typeof c.image !== "string" || c.image.length === 0) {
      throw new Error(`fixture case image must be a non-empty string for ${c.operation}`);
    }
    if (isAbsolute(c.image) || /^[a-zA-Z]:[\\/]/.test(c.image)) {
      throw new Error(
        `fixture case image must be a relative path for ${c.operation}, got ${c.image}`,
      );
    }
    const abs = resolve(fixturesDir, c.image);
    if (!existsSync(abs)) {
      throw new Error(
        `fixture image missing for ${c.operation}: ${abs}`,
      );
    }

    if (!c.request || typeof c.request !== "object") {
      throw new Error(
        `fixture case request must be an object for ${c.operation}`,
      );
    }
    if (typeof c.request.source !== "string") {
      throw new Error(
        `fixture case request.source must be a string for ${c.operation}`,
      );
    }
    if (typeof c.request.instruction !== "string") {
      throw new Error(
        `fixture case request.instruction must be a string for ${c.operation}`,
      );
    }

    if (!Array.isArray(c.assertions) || c.assertions.length === 0) {
      throw new Error(
        `fixture case ${c.operation} must have at least one assertion`,
      );
    }
    const seenAssertionIds = new Set();
    for (const a of c.assertions) {
      if (!a || typeof a !== "object") {
        throw new Error(
          `assertion for ${c.operation} must be an object`,
        );
      }
      if (typeof a.id !== "string" || a.id.length === 0) {
        throw new Error(
          `assertion id must be a non-empty string for ${c.operation}`,
        );
      }
      if (seenAssertionIds.has(a.id)) {
        throw new Error(
          `duplicate assertion id ${a.id} for ${c.operation}`,
        );
      }
      seenAssertionIds.add(a.id);
    }
  }
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/**
 * Normalize text for line-recovery evaluation. Only line endings and
 * trailing whitespace are touched — words, casing, and order are
 * preserved so paraphrase cannot accidentally pass.
 */
export function normalizeForTextRecovery(text) {
  if (typeof text !== "string") return "";
  return text
    .replace(/\r\n/g, "\n")          // CRLF -> LF
    .replace(/\r/g, "\n")            // bare CR -> LF
    .replace(/[ \t]+$/gm, "")        // strip trailing spaces/tabs
    .replace(/\n{2,}/g, "\n")        // collapse internal blank lines
    .trim();
}

/**
 * Case-fold a string for term matching. NFC-normalized first so
 * composed/decomposed Unicode behaves identically.
 */
function fold(text) {
  if (typeof text !== "string") return "";
  return text.normalize("NFC").toLowerCase();
}

/**
 * Returns true if `text` contains every whitespace-separated token
 * from `term` (case-insensitive). Useful for multi-word landmark
 * labels and code tokens that include punctuation.
 */
function containsTermFolded(foldedText, term) {
  if (!term) return true;
  const foldedTerm = fold(term);
  return foldedText.includes(foldedTerm);
}

// ---------------------------------------------------------------------------
// Evaluator dispatch
// ---------------------------------------------------------------------------

/**
 * Evaluate every assertion in `assertions` against `text` and return
 * an array of `{ id, passed, failureReason? }` results.
 */
export function evaluateAssertions(assertions, text) {
  return assertions.map((a) => {
    const result = evaluateOne(a, text);
    return {
      id: a.id,
      passed: result.passed,
      ...(result.failureReason ? { failureReason: result.failureReason } : {}),
    };
  });
}

function evaluateOne(assertion, text) {
  switch (assertion.type) {
    case "regions":
      return evaluateUiArtifactRegions(assertion, text);
    case "code-form":
      return evaluateUiArtifactCodeForm(assertion, text);
    case "text-lines":
      return evaluateExtractTextLines(assertion, text);
    case "diagnose-error":
      return evaluateDiagnoseError(assertion, text);
    case "diagram":
      return evaluateDiagram(assertion, text);
    case "chart":
      return evaluateChart(assertion, text);
    default:
      return {
        passed: false,
        failureReason: `unknown assertion type: ${assertion.type}`,
      };
  }
}

// ---------------------------------------------------------------------------
// ui-artifact
// ---------------------------------------------------------------------------

/**
 * Confirms that every page-region label from the fixture appears in
 * the candidate text. Landmarks are matched case-insensitively.
 */
export function evaluateUiArtifactRegions(assertion, text) {
  const folded = fold(text);
  const missing = (assertion.regions ?? []).filter(
    (label) => !containsTermFolded(folded, label),
  );
  if (missing.length === 0) {
    return { passed: true };
  }
  return {
    passed: false,
    failureReason: `missing region(s): ${missing.join(", ")}`,
  };
}

/**
 * Confirms the candidate text contains every landmark label AND at
 * least one structural code token. Code tokens are matched
 * case-sensitively to avoid admitting loosely-worded prose.
 */
export function evaluateUiArtifactCodeForm(assertion, text) {
  const folded = fold(text);
  const missingLandmarks = (assertion.landmarks ?? []).filter(
    (label) => !containsTermFolded(folded, label),
  );
  if (missingLandmarks.length > 0) {
    return {
      passed: false,
      failureReason: `missing landmark(s) in code form: ${missingLandmarks.join(", ")}`,
    };
  }
  const tokens = assertion.codeTokens ?? [];
  if (tokens.length === 0) {
    // No tokens requested; landmarks alone suffice.
    return { passed: true };
  }
  const foundAny = tokens.some((tok) => text.includes(tok));
  if (!foundAny) {
    return {
      passed: false,
      failureReason: `no structural code token found (expected one of: ${tokens.join(", ")})`,
    };
  }
  return { passed: true };
}

// ---------------------------------------------------------------------------
// extract-text
// ---------------------------------------------------------------------------

/**
 * Strict line-recovery evaluator. Every required line must appear
 * (in order) in the normalized candidate text. Paraphrase fails.
 */
export function evaluateExtractTextLines(assertion, text) {
  const normalized = normalizeForTextRecovery(text);
  const required = assertion.lines ?? [];
  if (required.length === 0) {
    return { passed: true };
  }
  const lines = normalized.split("\n");
  let cursor = 0;
  for (const requiredLine of required) {
    const target = normalizeForTextRecovery(requiredLine);
    let found = false;
    for (; cursor < lines.length; cursor++) {
      if (lines[cursor] === target) {
        cursor++;
        found = true;
        break;
      }
    }
    if (!found) {
      return {
        passed: false,
        failureReason: `required line not recovered verbatim: ${requiredLine}`,
      };
    }
  }
  return { passed: true };
}

// ---------------------------------------------------------------------------
// diagnose-error
// ---------------------------------------------------------------------------

/**
 * Confirms the candidate text identifies the error class, the causal
 * clue, and at least one approved remediation concept.
 */
export function evaluateDiagnoseError(assertion, text) {
  const folded = fold(text);
  if (!containsTermFolded(folded, assertion.errorClass)) {
    return {
      passed: false,
      failureReason: `error class not identified: ${assertion.errorClass}`,
    };
  }
  if (!containsTermFolded(folded, assertion.causalClue)) {
    return {
      passed: false,
      failureReason: `causal clue not identified: ${assertion.causalClue}`,
    };
  }
  const remedies = assertion.remediation ?? [];
  if (remedies.length === 0) {
    return {
      passed: false,
      failureReason: "remediation list is empty; fixture must declare at least one approved remediation",
    };
  }
  const foundRemedy = remedies.some((r) => containsTermFolded(folded, r));
  if (!foundRemedy) {
    return {
      passed: false,
      failureReason: `no approved remediation concept found (expected one of: ${remedies.join(", ")})`,
    };
  }
  return { passed: true };
}

// ---------------------------------------------------------------------------
// diagram
// ---------------------------------------------------------------------------

/**
 * Confirms every labeled node appears AND every required edge is
 * expressed with the correct direction. Edge direction is matched by
 * the literal "from -> to" sequence (case-folded, whitespace
 * flexible). Either the arrow form `A -> B` or the prose form
 * "A flows to B" satisfies an edge.
 */
export function evaluateDiagram(assertion, text) {
  const folded = fold(text);
  const missingNodes = (assertion.nodes ?? []).filter(
    (n) => !containsTermFolded(folded, n),
  );
  if (missingNodes.length > 0) {
    return {
      passed: false,
      failureReason: `missing diagram node(s): ${missingNodes.join(", ")}`,
    };
  }
  const edges = assertion.edges ?? [];
  for (const edge of edges) {
    const arrow = `${edge.from.toLowerCase()} -> ${edge.to.toLowerCase()}`;
    const flowTo = `${edge.from.toLowerCase()} flows to ${edge.to.toLowerCase()}`;
    const flowInto = `${edge.from.toLowerCase()} flows into ${edge.to.toLowerCase()}`;
    const into = `${edge.from.toLowerCase()} into ${edge.to.toLowerCase()}`;
    if (
      !folded.includes(arrow) &&
      !folded.includes(flowTo) &&
      !folded.includes(flowInto) &&
      !folded.includes(into)
    ) {
      return {
        passed: false,
        failureReason: `missing edge ${edge.from} -> ${edge.to}`,
      };
    }
  }
  return { passed: true };
}

// ---------------------------------------------------------------------------
// chart
// ---------------------------------------------------------------------------

/**
 * Confirms the chart's title or subject is identified, both axis
 * meanings are present, and the dominant trend is asserted WITHOUT
 * also asserting a contradictory forbidden trend.
 */
export function evaluateChart(assertion, text) {
  const folded = fold(text);
  if (!containsTermFolded(folded, assertion.title)) {
    return {
      passed: false,
      failureReason: `chart title/subject not identified: ${assertion.title}`,
    };
  }
  const axes = assertion.axes ?? {};
  const xLabel = axes.x;
  const yLabel = axes.y;
  if (!xLabel || !yLabel) {
    return {
      passed: false,
      failureReason: "chart assertion must declare axes.x and axes.y",
    };
  }
  // Accept either "X axis: Foo" or "Foo on the X axis" patterns.
  const xAxisHit =
    folded.includes(`${xLabel.toLowerCase()} on the x axis`) ||
    folded.includes(`x axis: ${xLabel.toLowerCase()}`) ||
    folded.includes(`x-axis: ${xLabel.toLowerCase()}`) ||
    folded.includes(`${xLabel.toLowerCase()} (x)`) ||
    folded.includes(`(x) ${xLabel.toLowerCase()}`);
  const yAxisHit =
    folded.includes(`${yLabel.toLowerCase()} on the y axis`) ||
    folded.includes(`y axis: ${yLabel.toLowerCase()}`) ||
    folded.includes(`y-axis: ${yLabel.toLowerCase()}`) ||
    folded.includes(`${yLabel.toLowerCase()} (y)`) ||
    folded.includes(`(y) ${yLabel.toLowerCase()}`);
  if (!xAxisHit || !yAxisHit) {
    return {
      passed: false,
      failureReason: `chart axes not identified (x=${xLabel}, y=${yLabel})`,
    };
  }
  if (!containsTermFolded(folded, assertion.trend)) {
    return {
      passed: false,
      failureReason: `dominant trend not asserted: ${assertion.trend}`,
    };
  }
  for (const forbidden of assertion.forbiddenTrends ?? []) {
    if (containsTermFolded(folded, forbidden)) {
      return {
        passed: false,
        failureReason: `contradictory trend asserted: ${forbidden}`,
      };
    }
  }
  return { passed: true };
}