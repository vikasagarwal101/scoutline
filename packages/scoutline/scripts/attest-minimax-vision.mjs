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
 *     and refuses a fixture-version mismatch, unless `--refresh` is
 *     passed (in which case the existing entry is removed before the
 *     new one is appended). `--refresh` also allows flipping the live
 *     state when it is already "pass" (re-verification); a deliberate
 *     "fail" state is still refused until cleared manually. `--refresh`
 *     still refuses a fixture-version mismatch.
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
 *   SCOUTLINE_LIVE_TESTS=1 node scripts/attest-minimax-vision.mjs \
 *     --operation ui-artifact --refresh
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
import {
  removeAttestationFromManifest,
  locateManifestSpan,
  canFlipLiveState as canFlipLiveStateFromState,
} from "./lib/attest-manifest.mjs";

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

// C3 (critique C3, direct-transport release): the Scoutline direct
// transport replaces the SDK-backed runtime. The attestation this script
// writes must tag itself with the new implementation identity so the
// registry's strict match in vision-conformance.ts accepts it.
const IMPLEMENTATION_ID = "scoutline-direct@0.5.0";

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
  let refresh = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--operation") {
      operation = argv[++i];
    } else if (arg === "--refresh") {
      // Replace an existing attestation for the operation instead of
      // refusing. Used to re-issue attestations when the implementation
      // identity, mapping revisions, or live result change between
      // releases (e.g. critique C3 direct-transport release).
      refresh = true;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        [
          "Usage: attest-minimax-vision.mjs --operation <op> [--refresh]",
          "",
          "Options:",
          "  --operation <op>   Exactly one specialized operation to attest",
          "                     (ui-artifact|extract-text|diagnose-error|diagram|chart).",
          "  --refresh          Replace an existing attestation for the operation",
          "                     instead of refusing the overwrite. Required to",
          "                     re-issue an attestation against a new",
          "                     implementation identity or mapping revision.",
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
  return { operation, refresh };
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
  // Walk the array body with the same brace-counting parser
  // removeAttestationFromManifest uses, so we match every entry
  // exactly (including ones whose assertions arrays contain nested
  // object literals).
  let i = 0;
  while (i < arrayBody.length) {
    while (i < arrayBody.length && /\s/.test(arrayBody[i])) i++;
    if (i >= arrayBody.length) break;
    if (arrayBody[i] !== "{") {
      i++;
      continue;
    }
    const close = findEntryClose(arrayBody, i);
    if (close === -1) break;
    const body = arrayBody.slice(i, close);
    const opMatch = body.match(/operation:\s*"([^"]+)"/);
    const verMatch = body.match(/fixtureVersion:\s*(\d+)/);
    if (opMatch && verMatch) {
      out.push({ operation: opMatch[1], fixtureVersion: Number(verMatch[1]) });
    }
    i = close;
  }
  return out;
}

// Lightweight brace-counting helper scoped to this module — used by
// readExistingAttestations to walk entry spans without re-implementing
// the full string/template/comment skip logic that lives in the lib.
// Only string literals appear in the per-operation source, and only
// backslash-escaped quotes need to be skipped.
function findEntryClose(body, openIdx) {
  let depth = 0;
  let i = openIdx;
  while (i < body.length) {
    const ch = body[i];
    if (ch === "{") {
      depth++;
      i++;
    } else if (ch === "}") {
      depth--;
      i++;
      if (depth === 0) return i;
    } else if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      while (i < body.length) {
        if (body[i] === "\\") {
          i += 2;
          continue;
        }
        if (body[i] === quote) {
          i++;
          break;
        }
        i++;
      }
    } else {
      i++;
    }
  }
  return -1;
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
 * refuses a fixture-version mismatch with any existing entry — unless
 * `refresh` is true, in which case the existing entry is removed first
 * (its fixtureVersion must still match the new attestation).
 */
function writeAttestation(operation, attestation, refresh = false) {
  const existing = readExistingAttestations();
  const prior = existing.find((e) => e.operation === operation);
  if (prior) {
    if (prior.fixtureVersion !== attestation.fixtureVersion) {
      fail(
        `refusing overwrite: operation ${operation} already attested at fixtureVersion ${prior.fixtureVersion} (requested ${attestation.fixtureVersion}); remove the stale entry manually to re-attest`,
      );
    }
    if (!refresh) {
      fail(
        `refusing overwrite: operation ${operation} already has an attestation; remove it first to re-attest (or pass --refresh)`,
      );
    }
    const refreshed = removeAttestationFromManifest(
      readFileSync(ATTESTATIONS_FILE, "utf8"),
      operation,
    );
    writeFileSync(ATTESTATIONS_FILE, refreshed, "utf8");
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
 * Read-only validation: returns `{ ok: true }` when the operation's
 * live state may be flipped to "pass", or `{ ok: false, reason }`
 * when it must be refused. Performs no writes. Used as a precheck
 * before any disk mutation so a refused run leaves the manifest,
 * conformance file, and intermediate write-attempt artifacts all
 * untouched.
 *
 * Refusal rules (preserved verbatim from the prior
 * `flipLiveStateToPass` implementation, plus a defensive catch-all
 * for unrecognized state values):
 *   - current "fail"   → always refuse (deliberate regression;
 *                        caller must clear manually).
 *   - current "pass"   → refuse unless refresh=true (re-verifying a
 *                        passing operation without --refresh is
 *                        operator error; the C3 follow-up allows
 *                        pass → pass with --refresh).
 *   - current "pending" → always allow (normal flow).
 *   - anything else    → refuse defensively.
 *
 * If the per-operation source line cannot be located, refuses with
 * the same diagnostic the prior implementation used (so the operator
 * sees the file path and the missing operation).
 *
 * @param {string} operation
 * @param {boolean} refresh
 */
function canFlipLiveState(operation, refresh) {
  const content = readFileSync(CONFORMANCE_FILE, "utf8");
  const lineRe = new RegExp(
    `(${JSON.stringify(operation)}:\\s*\\{[^}]*offline:\\s*"[^"]+"\\s*,\\s*live:\\s*)"([^"]+)"`,
  );
  const match = content.match(lineRe);
  if (!match) {
    return {
      ok: false,
      reason: `could not locate conformance source line for ${operation} in ${CONFORMANCE_FILE}`,
    };
  }
  return canFlipLiveStateFromState(match[2], refresh);
}

/**
 * Flip the operation's live conformance state to "pass" in
 * vision-conformance.ts. Validates first via {@link canFlipLiveState}
 * (the same check `main()` runs as a precheck) and only writes when
 * the check passes. Refuses if the current state is "fail"
 * (a deliberate regression the caller must clear manually). Also
 * refuses "pass" unless `refresh` is set — re-verifying a passing
 * operation without --refresh is almost always operator error.
 * @param {string} operation
 * @param {boolean} refresh  When true, allow flipping from "pass"
 *                           (used by C3-style release re-issue).
 */
function flipLiveStateToPass(operation, refresh) {
  const check = canFlipLiveState(operation, refresh);
  if (!check.ok) {
    fail(check.reason);
  }
  const content = readFileSync(CONFORMANCE_FILE, "utf8");
  const lineRe = new RegExp(
    `(${JSON.stringify(operation)}:\\s*\\{[^}]*offline:\\s*"[^"]+"\\s*,\\s*live:\\s*)"([^"]+)"`,
  );
  const updated = content.replace(lineRe, `$1"pass"`);
  writeFileSync(CONFORMANCE_FILE, updated, "utf8");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Parse args first so --help works without the opt-in; the actual
  // attestation below still requires explicit opt-in + credentials.
  const { operation, refresh } = parseArgs(process.argv.slice(2));
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
  // C3 fixup: read-only precheck BEFORE any disk write. If the
  // live-state flip would be refused (e.g. current state is "fail",
  // or "pass" without --refresh), bail out without touching the
  // attestation manifest. Previously this check ran AFTER
  // writeAttestation, leaving the manifest in a "written but
  // unflipped" state on refusal.
  const flipCheck = canFlipLiveState(operation, refresh);
  if (!flipCheck.ok) {
    fail(flipCheck.reason);
  }
  writeAttestation(operation, attestation, refresh);
  flipLiveStateToPass(operation, refresh);

  process.stdout.write(
    `attest-minimax-vision: ${operation} PASSED. Sanitized attestation ${refresh ? "refreshed in" : "appended to"}\n  ${relative(PACKAGE_ROOT, ATTESTATIONS_FILE)}\n` +
      `and live state flipped to "pass" in\n  ${relative(PACKAGE_ROOT, CONFORMANCE_FILE)}\n` +
      `resultDigest: ${attestation.resultDigest.slice(0, 16)}...\n` +
      `Run \`npm run build && npm run test:offline\` to confirm runtime support is now true.\n`,
  );
}

main().catch((err) => fail(`unexpected error: ${err?.stack ?? err?.message ?? err}`));
