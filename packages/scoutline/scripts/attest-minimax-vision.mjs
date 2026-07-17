#!/usr/bin/env node
/**
 * Phase 5 P5-03 — MiniMax specialized Vision live attestation script
 * (DESIGN.md §15, phases/05-specialized-vision.md P5-03).
 *
 * Runs ONE specialized Vision operation's fixture through the real
 * MiniMax SDK, evaluates the returned text against the fixture's
 * semantic assertions IN MEMORY, and — if every assertion passes —
 * appends ONLY a sanitized typed attestation entry to
 * `src/providers/minimax/vision-attestations.ts` and flips that
 * operation's live conformance state to "pass" in
 * `src/providers/minimax/vision-conformance.ts`.
 *
 * SAFETY CONTRACT (DESIGN.md §15):
 *   - Requires explicit opt-in (`SCOUTLINE_LIVE_TESTS=1`) AND
 *     `MINIMAX_API_KEY`. Refuses to run otherwise.
 *   - Accepts exactly one `--operation <op>`.
 *   - NEVER persists returned prose, keys, URLs with credentials,
 *     headers, raw response bodies, local paths, or stacks. The
 *     attestation contains only: provider id, operation id, fixture
 *     version, Implementation id, generated mapping revision, UTC
 *     timestamp, SHA-256 digest of normalized text, and the list of
 *     assertion IDs each marked `passed: true`.
 *   - Refuses to overwrite an existing attestation for the operation
 *     and refuses a fixture-version mismatch.
 *   - On failure: reports which assertions failed, exits non-zero, and
 *     writes nothing.
 *
 * This script imports fixture loading and the pure semantic evaluators
 * from `scripts/lib/vision-conformance.mjs`; it does NOT duplicate
 * predicates and does NOT import any test file.
 *
 * Usage:
 *   SCOUTLINE_LIVE_TESTS=1 node scripts/attest-minimax-vision.mjs \
 *     --operation ui-artifact
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadFixtureFile,
  evaluateAssertions,
  normalizeForTextRecovery,
} from "./lib/vision-conformance.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_ROOT = resolve(__dirname, "..");

const FIXTURE_FILE = join(PACKAGE_ROOT, "tests", "fixtures", "vision", "specialized-cases.json");
const FIXTURES_DIR = dirname(FIXTURE_FILE);
const ATTESTATIONS_FILE = join(
  PACKAGE_ROOT,
  "src",
  "providers",
  "minimax",
  "vision-attestations.ts",
);
const CONFORMANCE_FILE = join(PACKAGE_ROOT, "src", "providers", "minimax", "vision-conformance.ts");
const REVISIONS_FILE = join(PACKAGE_ROOT, "src", "providers", "minimax", "vision-revisions.ts");

// ---------------------------------------------------------------------------
// Constants — must match vision-conformance.ts
// ---------------------------------------------------------------------------

const IMPLEMENTATION_ID = "mmx-cli-sdk@1.0.16";

const SPECIALIZED_OPERATIONS = new Set([
  "ui-artifact",
  "extract-text",
  "diagnose-error",
  "diagram",
  "chart",
]);

// ---------------------------------------------------------------------------
// CLI flag parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  let operation = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--operation") {
      operation = argv[++i];
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        [
          "Usage: attest-minimax-vision.mjs --operation <op>",
          "",
          "Options:",
          "  --operation <op>   Exactly one specialized operation to attest",
          "                     (ui-artifact|extract-text|diagnose-error|diagram|chart).",
          "",
          "Environment:",
          "  SCOUTLINE_LIVE_TESTS=1  Required opt-in (live network call).",
          "  MINIMAX_API_KEY=...     Required credential.",
          "",
        ].join("\n") + "\n",
      );
      process.exit(0);
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }
  if (!operation) {
    fail("exactly one --operation <op> is required");
  }
  if (!SPECIALIZED_OPERATIONS.has(operation)) {
    fail(
      `unsupported operation ${operation}; expected one of ${[...SPECIALIZED_OPERATIONS].join(", ")}`,
    );
  }
  return { operation };
}

function fail(message, code = 1) {
  process.stderr.write(`attest-minimax-vision: ${message}\n`);
  process.exit(code);
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

function assertOptIn() {
  if (process.env.SCOUTLINE_LIVE_TESTS !== "1") {
    fail(
      "refusing to run: set SCOUTLINE_LIVE_TESTS=1 to confirm this script makes a live network call",
    );
  }
  const apiKey = process.env.MINIMAX_API_KEY;
  if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
    fail("refusing to run: MINIMAX_API_KEY is required for live attestation");
  }
}

// ---------------------------------------------------------------------------
// Compiled-source readers (no returned text is persisted by these reads)
// ---------------------------------------------------------------------------

/**
 * Read the generated mapping revision for `operation` from the compiled
 * revisions file. Refuses the placeholder (the operation must have a
 * mapping Module and a real SHA-256 revision before attestation).
 */
function readGeneratedRevision(operation) {
  const content = readFileSync(REVISIONS_FILE, "utf8");
  const match = content.match(/Object\.freeze\(\{([\s\S]*?)\}\)/);
  if (!match) fail(`could not parse ${REVISIONS_FILE}`);
  for (const rawLine of match[1].split("\n")) {
    const line = rawLine.trim().replace(/,$/, "");
    if (line.length === 0) continue;
    const m = line.match(/^"([^"]+)":\s*"([^"]+)"/);
    if (!m) continue;
    if (m[1] === operation) {
      if (m[2] === "pending-no-mapping-module") {
        fail(
          `operation ${operation} has no mapping Module (revision is placeholder); create the Module first`,
        );
      }
      if (!/^[0-9a-f]{64}$/.test(m[2])) {
        fail(`operation ${operation} revision is not a valid SHA-256 digest: ${m[2]}`);
      }
      return m[2];
    }
  }
  fail(`operation ${operation} not found in generated revisions`);
}

/**
 * Locate the manifest array literal span: the `[` that opens the
 * assignment value (after `=`) and the matching `];` that closes it.
 * Returns `{ openIdx, closeIdx }` as indices into `content`, or throws
 * if the manifest shape cannot be found. Locating via `= [` (not the
 * first `[` after the export name) avoids matching the `[` in the
 * `VisionAttestation[]` type annotation.
 */
function locateManifestSpan(content) {
  const exportIdx = content.indexOf("MINIMAX_VISION_ATTESTATIONS");
  if (exportIdx === -1) {
    fail(`could not locate MINIMAX_VISION_ATTESTATIONS export in ${ATTESTATIONS_FILE}`);
  }
  const eqIdx = content.indexOf("=", exportIdx);
  if (eqIdx === -1) {
    fail(`could not locate manifest assignment '=' in ${ATTESTATIONS_FILE}`);
  }
  const openIdx = content.indexOf("[", eqIdx);
  if (openIdx === -1) {
    fail(`could not locate manifest array literal '[' in ${ATTESTATIONS_FILE}`);
  }
  const closeIdx = content.lastIndexOf("];");
  if (closeIdx === -1 || closeIdx < openIdx) {
    fail(`could not locate manifest array close '];' in ${ATTESTATIONS_FILE}`);
  }
  return { openIdx, closeIdx };
}

/**
 * Parse the existing compiled attestation manifest and return the list
 * of {operation, fixtureVersion} pairs already present. Used to refuse
 * overwrite and version mismatch. Scans only the object literals inside
 * the array literal span (between `= [` and `];`).
 */
function readExistingAttestations() {
  if (!existsSync(ATTESTATIONS_FILE)) return [];
  const content = readFileSync(ATTESTATIONS_FILE, "utf8");
  const { openIdx, closeIdx } = locateManifestSpan(content);
  const arrayBody = content.slice(openIdx + 1, closeIdx);
  const out = [];
  const objectRe = /\{([\s\S]*?)\}/g;
  let m;
  while ((m = objectRe.exec(arrayBody)) !== null) {
    const body = m[1];
    const opMatch = body.match(/operation:\s*"([^"]+)"/);
    const verMatch = body.match(/fixtureVersion:\s*(\d+)/);
    if (opMatch && verMatch) {
      out.push({ operation: opMatch[1], fixtureVersion: Number(verMatch[1]) });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// SDK invocation (live network call)
// ---------------------------------------------------------------------------

/**
 * Build the real MiniMax SDK through the same factory the Adapter uses.
 * Imported lazily from the compiled dist so this script never runs
 * before `npm run build`.
 */
async function describeWithRealSdk(operation, fixtureCase, prompt) {
  const { loadMiniMaxConfig } = await import(
    join(PACKAGE_ROOT, "dist", "providers", "minimax", "config.js")
  );
  const { createMiniMaxSdk } = await import(
    join(PACKAGE_ROOT, "dist", "providers", "minimax", "sdk-client.js")
  );
  const { resolveImageSource } = await import(
    join(PACKAGE_ROOT, "dist", "providers", "minimax", "media.js")
  );
  const config = loadMiniMaxConfig(process.env);
  const sdk = createMiniMaxSdk(config);
  const image = resolveImageSource(join(FIXTURES_DIR, fixtureCase.image));
  const raw = await sdk.vision.describe({ image, prompt });
  // Characterized envelope is `{ content: string }`.
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const record = raw;
    if (typeof record.content === "string" && record.content.trim().length > 0) {
      return record.content;
    }
  }
  fail("MiniMax vision returned a malformed response (no non-empty content field)");
}

/**
 * Compose the prompt for the operation through its compiled mapping
 * Module from the generated operation map. Mirrors the adapter's
 * intended flow.
 */
async function composePromptViaMapping(operation, fixtureCase) {
  const { MINIMAX_VISION_MAPPINGS } = await import(
    join(PACKAGE_ROOT, "dist", "providers", "minimax", "vision-mappings.generated.js")
  );
  const module = MINIMAX_VISION_MAPPINGS[operation];
  if (!module) {
    fail(`operation ${operation} has no compiled mapping Module; run \`npm run build\` first`);
  }
  return module.composePrompt(fixtureCase.request);
}

// ---------------------------------------------------------------------------
// Attestation construction + persistence (sanitized)
// ---------------------------------------------------------------------------

/**
 * Build the sanitized typed attestation entry. Contains ONLY the
 * DESIGN.md §15 fields. The returned text never appears; only its
 * SHA-256 digest (over normalized text) is recorded.
 */
function buildAttestation({ operation, fixtureVersion, mappingRevision, text, assertionResults }) {
  const normalized = operation === "extract-text" ? normalizeForTextRecovery(text) : text.trim();
  const resultDigest = sha256Hex(normalized);
  const testedAt = new Date().toISOString();
  return {
    schemaVersion: 1,
    provider: "minimax",
    operation,
    fixtureVersion,
    implementationId: IMPLEMENTATION_ID,
    mappingRevision,
    testedAt,
    resultDigest,
    assertions: assertionResults.map((r) => ({ id: r.id, passed: true })),
  };
}

function sha256Hex(text) {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

/**
 * Append the sanitized attestation entry to the compiled manifest file.
 * Refuses overwrite of an existing entry for the same operation and
 * refuses a fixture-version mismatch with any existing entry.
 */
function writeAttestation(operation, attestation) {
  const existing = readExistingAttestations();
  const prior = existing.find((e) => e.operation === operation);
  if (prior) {
    if (prior.fixtureVersion !== attestation.fixtureVersion) {
      fail(
        `refusing overwrite: operation ${operation} already attested at fixtureVersion ${prior.fixtureVersion} (requested ${attestation.fixtureVersion}); remove the stale entry manually to re-attest`,
      );
    }
    fail(
      `refusing overwrite: operation ${operation} already has an attestation; remove it first to re-attest`,
    );
  }

  const entry = formatAttestationEntry(attestation);
  const content = readFileSync(ATTESTATIONS_FILE, "utf8");
  const updated = injectEntryIntoManifest(content, entry);
  writeFileSync(ATTESTATIONS_FILE, updated, "utf8");
}

/**
 * Format a single attestation object literal matching the
 * {@link VisionAttestation} TypeScript interface, in the same style
 * the source file uses.
 */
function formatAttestationEntry(att) {
  const assertions = att.assertions
    .map((a) => `    { id: ${JSON.stringify(a.id)}, passed: true }`)
    .join(",\n");
  return [
    "  {",
    "    schemaVersion: 1,",
    '    provider: "minimax",',
    `    operation: ${JSON.stringify(att.operation)},`,
    `    fixtureVersion: ${att.fixtureVersion},`,
    `    implementationId: ${JSON.stringify(att.implementationId)},`,
    `    mappingRevision: ${JSON.stringify(att.mappingRevision)},`,
    `    testedAt: ${JSON.stringify(att.testedAt)},`,
    `    resultDigest: ${JSON.stringify(att.resultDigest)},`,
    "    assertions: [",
    assertions,
    "    ],",
    "  },",
  ].join("\n");
}

/**
 * Inject a formatted entry into the manifest array. The manifest is a
 * `readonly VisionAttestation[]` literal `[]`; we insert before the
 * closing `];`. Uses {@link locateManifestSpan} to find the array
 * literal span precisely (not the `[` in the type annotation).
 *
 * Separator handling: {@link formatAttestationEntry} emits every entry
 * with a trailing comma (e.g. `  },`), so when appending after an
 * existing entry we must NOT add another comma — that would produce
 * `},,`. We strip trailing whitespace from the existing body and use a
 * bare newline as the separator when the body already ends with `,`;
 * otherwise (defensive: a hand-edited last entry without a trailing
 * comma) we insert the comma ourselves. The new entry always ends with
 * its own trailing comma, matching the existing style.
 */
function injectEntryIntoManifest(content, entry) {
  const { openIdx, closeIdx } = locateManifestSpan(content);
  const between = content.slice(openIdx + 1, closeIdx);
  const hasEntries = between.trim().length > 0;
  const prefix = content.slice(0, openIdx + 1);
  const suffix = content.slice(closeIdx);
  if (!hasEntries) {
    return `${prefix}\n${entry}\n${suffix}`;
  }
  // Append after the last existing entry. Trim trailing whitespace so
  // the new entry lands on its own line right before the closing `];`.
  const trimmed = between.replace(/\s+$/, "");
  const separator = trimmed.endsWith(",") ? "\n" : ",\n";
  return `${prefix}${trimmed}${separator}${entry}\n${suffix}`;
}

/**
 * Flip the operation's live conformance state from "pending" to "pass"
 * in vision-conformance.ts. Refuses if the source line is not currently
 * "pending" (avoids clobbering an explicit "fail" state).
 */
function flipLiveStateToPass(operation) {
  const content = readFileSync(CONFORMANCE_FILE, "utf8");
  // Match the per-operation source line, e.g.:
  //   "ui-artifact": { fixtureVersion: 1, offline: "pass", live: "pending" },
  const lineRe = new RegExp(
    `(${JSON.stringify(operation)}:\\s*\\{[^}]*offline:\\s*"[^"]+"\\s*,\\s*live:\\s*)"([^"]+)"`,
  );
  const match = content.match(lineRe);
  if (!match) {
    fail(`could not locate conformance source line for ${operation} in ${CONFORMANCE_FILE}`);
  }
  if (match[2] !== "pending") {
    fail(
      `refusing to flip ${operation} live state: current value is "${match[2]}" (expected "pending")`,
    );
  }
  const updated = content.replace(lineRe, `$1"pass"`);
  writeFileSync(CONFORMANCE_FILE, updated, "utf8");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Parse args first so --help works without the opt-in; the actual
  // attestation below still requires explicit opt-in + credentials.
  const { operation } = parseArgs(process.argv.slice(2));
  assertOptIn();

  const cases = loadFixtureFile(FIXTURE_FILE);
  const fixtureCase = cases.find((c) => c.operation === operation);
  if (!fixtureCase) fail(`no fixture case for operation ${operation}`);

  const mappingRevision = readGeneratedRevision(operation);

  // Compose the prompt through the compiled mapping Module, then call
  // the real SDK. The returned text is held only in memory.
  const prompt = await composePromptViaMapping(operation, fixtureCase);
  let text;
  try {
    text = await describeWithRealSdk(operation, fixtureCase, prompt);
  } catch (err) {
    fail(`live MiniMax call failed for ${operation}: ${err.message ?? err}`);
  }

  // Evaluate semantics in memory.
  const results = evaluateAssertions(fixtureCase.assertions, text);
  const failures = results.filter((r) => !r.passed);
  if (failures.length > 0) {
    process.stderr.write(
      `attest-minimax-vision: ${operation} FAILED ${failures.length} assertion(s):\n`,
    );
    for (const f of failures) {
      process.stderr.write(`  - ${f.id}: ${f.failureReason ?? "no reason"}\n`);
    }
    process.stderr.write(
      'no attestation written; live state remains pending. Set live state to "fail" manually if this is a permanent regression.\n',
    );
    process.exit(1);
  }

  // Build + persist the sanitized attestation, then flip live state.
  const attestation = buildAttestation({
    operation,
    fixtureVersion: fixtureCase.fixtureVersion,
    mappingRevision,
    text,
    assertionResults: results,
  });
  writeAttestation(operation, attestation);
  flipLiveStateToPass(operation);

  process.stdout.write(
    `attest-minimax-vision: ${operation} PASSED. Sanitized attestation appended to\n  ${relative(PACKAGE_ROOT, ATTESTATIONS_FILE)}\n` +
      `and live state flipped to "pass" in\n  ${relative(PACKAGE_ROOT, CONFORMANCE_FILE)}\n` +
      `resultDigest: ${attestation.resultDigest.slice(0, 16)}...\n` +
      `Run \`npm run build && npm run test:offline\` to confirm runtime support is now true.\n`,
  );
}

main().catch((err) => fail(`unexpected error: ${err?.stack ?? err?.message ?? err}`));
