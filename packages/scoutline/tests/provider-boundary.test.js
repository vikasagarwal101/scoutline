/**
 * Source boundary assertions (NFR-004, DESIGN.md §1).
 *
 * P2-01 asserts the Provider Seam keeps Provider transport details
 * isolated:
 *   - Capability Modules (under `src/capabilities/`) import no Provider
 *     transport (no `@utcp/sdk`, `@utcp/mcp`, `@utcp/code-mode`, no
 *     `mmx-cli`, no internal Z.AI MCP client).
 *   - Command Modules (under `src/commands/`) import no UTCP SDK symbols
 *     and no MiniMax SDK symbols.
 *
 * These are static source scans, not runtime checks. They exist so the
 * Phase 2 Provider Seam cannot regress: any new code that crosses these
 * boundaries must be justified and reviewed against DESIGN.md.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(__dirname, "..", "src");
const CAPABILITIES_DIR = path.join(SRC_DIR, "capabilities");
const COMMANDS_DIR = path.join(SRC_DIR, "commands");

async function listTsFiles(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === "ENOENT") return [];
    throw err;
  }
  const out = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      out.push(...(await listTsFiles(path.join(dir, entry.name))));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

function readSource(file) {
  return fs.readFile(file, "utf8");
}

function extractImports(source) {
  const results = [];
  // Match ES module import statements.
  const importRegex = /import\s+(?:[\s\S]*?from\s+)?["']([^"']+)["'];?/g;
  for (const match of source.matchAll(importRegex)) {
    const specifier = match[1];
    if (specifier) results.push(specifier);
  }
  // Match export ... from statements.
  const exportRegex = /export\s+(?:[\s\S]*?from\s+)?["']([^"']+)["'];?/g;
  for (const match of source.matchAll(exportRegex)) {
    const specifier = match[1];
    if (specifier && !results.includes(specifier)) results.push(specifier);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Capability boundary: no Provider transport
// ---------------------------------------------------------------------------

describe("Capability Modules: no Provider transport imports", () => {
  const FORBIDDEN_SUBSTRINGS = [
    "@utcp/sdk",
    "@utcp/mcp",
    "@utcp/code-mode",
    "mmx-cli",
    "mmx-cli/sdk",
    "../lib/mcp-client",
    "../lib/mcp-config",
  ];

  it("capabilities/ directory contains TypeScript files", async () => {
    const files = await listTsFiles(CAPABILITIES_DIR);
    // Capability Modules must exist for Phase 2 to satisfy the seam.
    assert.ok(files.length > 0, "expected at least one Capability Module");
  });

  it("no Capability Module imports a Provider transport", async () => {
    const files = await listTsFiles(CAPABILITIES_DIR);
    for (const file of files) {
      const source = await readSource(file);
      const imports = extractImports(source);
      const violations = imports.filter((spec) =>
        FORBIDDEN_SUBSTRINGS.some((bad) => spec.includes(bad)),
      );
      assert.deepStrictEqual(
        violations,
        [],
        `${path.relative(SRC_DIR, file)} imports forbidden transport: ${violations.join(", ")}`,
      );
    }
  });

  it("no Capability Module imports ZaiMcpClient by name", async () => {
    const files = await listTsFiles(CAPABILITIES_DIR);
    for (const file of files) {
      const source = await readSource(file);
      assert.ok(
        !/\bZaiMcpClient\b/.test(source),
        `${path.relative(SRC_DIR, file)} references ZaiMcpClient`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Command boundary: no UTCP SDK or MiniMax SDK symbols
// ---------------------------------------------------------------------------

describe("Command Modules: no UTCP or MiniMax SDK imports", () => {
  const FORBIDDEN_SUBSTRINGS = [
    "@utcp/sdk",
    "@utcp/mcp",
    "@utcp/code-mode",
    "mmx-cli",
    "mmx-cli/sdk",
  ];

  it("commands/ directory contains TypeScript files", async () => {
    const files = await listTsFiles(COMMANDS_DIR);
    assert.ok(files.length > 0, "expected at least one Command Module");
  });

  it("no Command Module imports a UTCP or MiniMax SDK package", async () => {
    const files = await listTsFiles(COMMANDS_DIR);
    for (const file of files) {
      const source = await readSource(file);
      const imports = extractImports(source);
      const violations = imports.filter((spec) =>
        FORBIDDEN_SUBSTRINGS.some((bad) => spec.includes(bad)),
      );
      assert.deepStrictEqual(
        violations,
        [],
        `${path.relative(SRC_DIR, file)} imports forbidden SDK: ${violations.join(", ")}`,
      );
    }
  });
});
