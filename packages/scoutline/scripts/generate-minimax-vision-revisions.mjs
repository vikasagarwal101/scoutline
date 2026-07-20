#!/usr/bin/env node
/**
 * Prebuild generator for MiniMax specialized Vision revisions and the
 * operation map (DESIGN.md §15, phases/05-specialized-vision.md P5-02).
 *
 * Runs BEFORE `tsc` (see the `build` script in `package.json`). It:
 *   1. Discovers operation-specific mapping Modules under
 *      `src/providers/minimax/vision-mappings/` (one Module per
 *      specialized operation, excluding the common runtime and any
 *      `*.generated.ts` file).
 *   2. Writes `src/providers/minimax/vision-mappings.generated.ts`
 *      (the operation → Module map).
 *   3. Writes `src/providers/minimax/vision-revisions.ts` (per-operation
 *      SHA-256 revisions).
 *
 * SHA-256 revision contract (DESIGN.md §15):
 *   Each revision covers:
 *     - the Implementation ID (`mmx-cli-sdk@1.0.16`);
 *     - the byte content of the stable common runtime
 *       (`vision-mappings/common.ts`);
 *     - the byte content of ONLY that operation's mapping Module
 *       (the Module discovered under `vision-mappings/`);
 *     - the fixture image bytes for that operation (from
 *       `tests/fixtures/vision/`);
 *     - the canonical request fields (from
 *       `tests/fixtures/vision/specialized-cases.json`);
 *     - the exact required assertion IDs (from the same JSON).
 *
 *   Adding another operation's Module changes only that operation's
 *   revision; changing the common runtime intentionally changes every
 *   revision. When no Module exists for an operation (the P5-02 state
 *   for every operation), that operation's revision is the literal
 *   placeholder `"pending-no-mapping-module"`.
 *
 * The generator is idempotent: re-running against an unchanged source
 * tree produces byte-identical output. It accepts an optional
 * `--root <dir>` flag (and `--mappings-dir <dir>` for testability
 * against a synthetic mapping tree) so tests can verify the
 * independence property in a temporary directory.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---------------------------------------------------------------------------
// Constants — must match vision-conformance.ts
// ---------------------------------------------------------------------------

// C3 (critique C3, direct-transport release): the Scoutline direct
// transport replaces the SDK-backed runtime. The implementation ID
// participates in every revision digest, so the entire revisions map
// regenerates against this new identity. Run `npm run build` to refresh
// `src/providers/minimax/vision-revisions.ts`; every shipped
// attestation that pins `mappingRevision` must be refreshed
// alongside (live re-attestation against the new transport).
const IMPLEMENTATION_ID = "scoutline-direct@0.5.0";

const SPECIALIZED_OPERATIONS = [
  "ui-artifact",
  "extract-text",
  "diagnose-error",
  "diagram",
  "chart",
];

const PENDING_REVISION = "pending-no-mapping-module";

// ---------------------------------------------------------------------------
// CLI flag parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {
    root: null,
    mappingsDir: null,
    fixturesFile: null,
    fixturesDir: null,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--root") {
      out.root = argv[++i];
    } else if (arg === "--mappings-dir") {
      out.mappingsDir = argv[++i];
    } else if (arg === "--fixtures-file") {
      out.fixturesFile = argv[++i];
    } else if (arg === "--fixtures-dir") {
      out.fixturesDir = argv[++i];
    } else if (arg === "--quiet") {
      out.quiet = true;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        [
          "Usage: generate-minimax-vision-revisions.mjs [options]",
          "",
          "Options:",
          "  --root <dir>            Repository package root (default: inferred).",
          "  --mappings-dir <dir>    Mapping Modules dir (default: <root>/src/providers/minimax/vision-mappings).",
          "  --fixtures-file <path>  specialized-cases.json path.",
          "  --fixtures-dir <dir>    Directory containing fixture PNGs.",
          "  --quiet                 Suppress progress output.",
          "  --help                  Show this help.",
          "",
        ].join("\n") + "\n",
      );
      process.exit(0);
    } else {
      process.stderr.write(`unknown argument: ${arg}\n`);
      process.exit(2);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Return the set of operation IDs that currently have a mapping Module
 * under `mappingsDir`. A Module is any file named `<operation>.ts`
 * (case-sensitive) that is NOT `common.ts` and does NOT end with
 * `.generated.ts`. Returns a Map<operation, absPathToModule>.
 */
function discoverMappingModules(mappingsDir) {
  const found = new Map();
  if (!existsSync(mappingsDir)) return found;
  const entries = readdirSync(mappingsDir, { withFileTypes: true });
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    if (!ent.name.endsWith(".ts")) continue;
    if (ent.name === "common.ts") continue;
    if (ent.name.endsWith(".generated.ts")) continue;
    if (ent.name.endsWith(".d.ts")) continue;
    const stem = ent.name.slice(0, -3); // strip ".ts"
    if (SPECIALIZED_OPERATIONS.includes(stem)) {
      found.set(stem, join(mappingsDir, ent.name));
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Fixture loading
// ---------------------------------------------------------------------------

/**
 * Load `specialized-cases.json` and index cases by operation. The
 * generator needs the per-operation fixture image path, canonical
 * request fields, and exact required assertion IDs.
 */
function loadFixtureIndex(fixturesFile) {
  const raw = readFileSync(fixturesFile, "utf8");
  const parsed = JSON.parse(raw);
  if (parsed.schemaVersion !== 1) {
    throw new Error(`specialized-cases.json schemaVersion must be 1, got ${parsed.schemaVersion}`);
  }
  if (!Array.isArray(parsed.cases)) {
    throw new Error("specialized-cases.json must have a cases array");
  }
  const byOp = new Map();
  for (const c of parsed.cases) {
    byOp.set(c.operation, c);
  }
  return byOp;
}

/**
 * Canonical-JSON stringify. Object keys are sorted recursively so the
 * digest is stable across platforms and Node versions. Arrays preserve
 * order (order is semantically meaningful for assertion IDs and
 * required lines).
 */
function canonicalJson(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJson).join(",") + "]";
  }
  const keys = Object.keys(value).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(value[k])).join(",") + "}";
}

// ---------------------------------------------------------------------------
// Revision computation
// ---------------------------------------------------------------------------

/**
 * Compute the SHA-256 revision for a single operation given its Module
 * path, fixture case, and shared context. The digest is over a
 * canonical-JSON manifest of labeled chunks.
 */
function computeRevision({
  implementationId,
  commonBytes,
  moduleBytes,
  fixtureBytes,
  request,
  assertionIds,
}) {
  const manifest = [
    { label: "implementationId", value: implementationId },
    { label: "commonRuntimeSha256", value: sha256Hex(commonBytes) },
    { label: "mappingModuleSha256", value: sha256Hex(moduleBytes) },
    { label: "fixtureImageSha256", value: sha256Hex(fixtureBytes) },
    { label: "canonicalRequest", value: canonicalJson(request) },
    { label: "assertionIds", value: assertionIds },
  ];
  return sha256Hex(canonicalJson(manifest));
}

function sha256Hex(bytesOrText) {
  return createHash("sha256")
    .update(typeof bytesOrText === "string" ? Buffer.from(bytesOrText, "utf8") : bytesOrText)
    .digest("hex");
}

// ---------------------------------------------------------------------------
// Output file writers
// ---------------------------------------------------------------------------

function writeGeneratedMap(filePath, discovered) {
  const imports = [];
  const entries = [];
  for (const op of SPECIALIZED_OPERATIONS) {
    if (discovered.has(op)) {
      const relImport = `./vision-mappings/${op}.js`;
      imports.push(`import { ${moduleExportName(op)} } from "${relImport}";`);
      entries.push(`  ${JSON.stringify(op)}: ${moduleExportName(op)},`);
    }
  }

  const importBlock = imports.length > 0 ? imports.join("\n") + "\n\n" : "";
  const entriesBlock = entries.length > 0 ? "\n" + entries.join("\n") + "\n" : "";

  const content = `/**
 * GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * Regenerate with: \`node scripts/generate-minimax-vision-revisions.mjs\`.
 * The prebuild step in \`packages/scoutline/package.json\` runs the
 * generator before \`tsc\`, so this file is always fresh when the
 * TypeScript compiler runs.
 *
 * The operation map connects each specialized Vision operation id to
 * its mapping Module (\`vision-mappings/{op}.ts\`). ${
   discovered.size === 0
     ? "No operation-specific Modules exist yet, so the map is empty (P5-02 state)."
     : `Currently ${discovered.size} of ${SPECIALIZED_OPERATIONS.length} operations have Modules.`
 }
 */

import type { SpecializedVisionOperation } from "./vision-conformance.js";
${importBlock}/**
 * The interface every operation-specific mapping Module implements.
 * Defined here so the generated map has a stable type even when the
 * map itself is empty. P5-03's Modules will satisfy this shape.
 */
export interface MiniMaxVisionMappingModule {
  readonly operation: SpecializedVisionOperation;
  composePrompt(request: unknown): string;
  normalizeResult(raw: unknown): string;
}

/**
 * The generated operation map. The Adapter looks up the Module for a
 * supported operation; absence here means the operation is not wired
 * even if its registry entry is fully passing.
 */
export const MINIMAX_VISION_MAPPINGS: Readonly<
  Partial<Record<SpecializedVisionOperation, MiniMaxVisionMappingModule>>
> = Object.freeze({${entriesBlock}});
`;

  ensureDirOf(filePath);
  writeFileSync(filePath, content, "utf8");
}

function moduleExportName(op) {
  // Convert kebab-case operation id to a valid TS identifier export name.
  // e.g. "ui-artifact" -> "uiArtifactMapping", "extract-text" -> "extractTextMapping".
  const camel = op
    .split("-")
    .map((part, idx) => (idx === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join("");
  return `${camel}Mapping`;
}

function writeGeneratedRevisions(filePath, revisions) {
  const entries = SPECIALIZED_OPERATIONS.map(
    (op) => `  ${JSON.stringify(op)}: ${JSON.stringify(revisions[op])},`,
  ).join("\n");

  const content = `/**
 * GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * Regenerate with: \`node scripts/generate-minimax-vision-revisions.mjs\`.
 * The prebuild step in \`packages/scoutline/package.json\` runs the
 * generator before \`tsc\`, so this file is always fresh when the
 * TypeScript compiler runs.
 *
 * Each value is a SHA-256 digest covering the Implementation ID
 * (\`scoutline-direct@0.5.0\`), the stable common mapping runtime
 * (\`vision-mappings/common.ts\`), only that operation's mapping Module
 * under \`vision-mappings/\`, the fixture image bytes, the canonical
 * request fields, and the exact required assertion IDs. Adding another
 * operation does not change an existing operation's revision; changing
 * the common runtime intentionally changes every revision.
 *
 * The Implementation ID participates in every revision digest, so
 * bumping it (e.g. critique C3 swapping the SDK-backed runtime for
 * the Scoutline direct transport) regenerates the entire map. Any
 * shipped attestation that pins \`mappingRevision\` must be re-issued
 * against the new revisions before the registry will accept it
 * (see \`scripts/attest-minimax-vision.mjs\`).
 *
 * Operations without a mapping Module carry the placeholder
 * \`"pending-no-mapping-module"\` until P5-03 creates their Module.
 */

import type { SpecializedVisionOperation } from "./vision-conformance.js";

export const MINIMAX_VISION_MAPPING_REVISIONS: Readonly<
  Record<SpecializedVisionOperation, string>
> = Object.freeze({
${entries}
});
`;

  ensureDirOf(filePath);
  writeFileSync(filePath, content, "utf8");
}

function ensureDirOf(filePath) {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const args = parseArgs(process.argv.slice(2));

  const root = args.root ? resolve(args.root) : resolve(__dirname, "..");

  const mappingsDir =
    args.mappingsDir ?? join(root, "src", "providers", "minimax", "vision-mappings");
  const fixturesFile =
    args.fixturesFile ?? join(root, "tests", "fixtures", "vision", "specialized-cases.json");
  const fixturesDir = args.fixturesDir ?? dirname(fixturesFile);

  const mappingsOutFile = join(root, "src", "providers", "minimax", "vision-mappings.generated.ts");
  const revisionsOutFile = join(root, "src", "providers", "minimax", "vision-revisions.ts");

  const discovered = discoverMappingModules(mappingsDir);
  const cases = loadFixtureIndex(fixturesFile);

  const commonPath = join(mappingsDir, "common.ts");
  const commonBytes = existsSync(commonPath) ? readFileSync(commonPath) : Buffer.alloc(0);

  const revisions = {};
  for (const op of SPECIALIZED_OPERATIONS) {
    const c = cases.get(op);
    if (!c) {
      throw new Error(`specialized-cases.json missing case for operation ${op}`);
    }
    const modulePath = discovered.get(op);
    if (!modulePath) {
      revisions[op] = PENDING_REVISION;
      continue;
    }
    const moduleBytes = readFileSync(modulePath);
    const fixturePath = join(fixturesDir, c.image);
    if (!existsSync(fixturePath)) {
      throw new Error(`fixture image missing for ${op}: ${fixturePath}`);
    }
    const fixtureBytes = readFileSync(fixturePath);
    const assertionIds = Array.isArray(c.assertions) ? c.assertions.map((a) => a.id) : [];
    revisions[op] = computeRevision({
      implementationId: IMPLEMENTATION_ID,
      commonBytes,
      moduleBytes,
      fixtureBytes,
      request: c.request,
      assertionIds,
    });
  }

  writeGeneratedMap(mappingsOutFile, discovered);
  writeGeneratedRevisions(revisionsOutFile, revisions);

  if (!args.quiet) {
    const summary = SPECIALIZED_OPERATIONS.map(
      (op) =>
        `  ${op}: ${discovered.has(op) ? "module" : "no-module"} -> ${shortRev(revisions[op])}`,
    ).join("\n");
    process.stdout.write(
      `Generated:\n  ${relative(root, mappingsOutFile)}\n  ${relative(root, revisionsOutFile)}\n` +
        `Revisions:\n${summary}\n`,
    );
  }
}

function shortRev(rev) {
  if (rev === PENDING_REVISION) return rev;
  return rev.slice(0, 12) + "...";
}

main();
