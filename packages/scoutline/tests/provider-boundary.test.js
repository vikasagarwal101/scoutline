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
const PACKAGE_JSON = path.resolve(__dirname, "..", "package.json");
const EXPECTED_SDK_FILE = path.join(SRC_DIR, "providers", "minimax", "sdk-client.ts");

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

// ---------------------------------------------------------------------------
// MiniMax SDK isolation (P2-04, DESIGN.md §12): exactly one `mmx-cli/sdk`
// import, located only in providers/minimax/sdk-client.ts. No executable
// invocation of `mmx`, no reads of `.mmx/config.json`, and no MiniMax
// credential read through shared lib/config.ts.
// ---------------------------------------------------------------------------

describe("MiniMax SDK isolation", () => {
  // Patterns that indicate the `mmx` executable is being invoked as a
  // subprocess (spawn/exec/run with "mmx" as the command token).
  const MMX_EXEC_PATTERN =
    /(["'`])mmx\1\s|child_process|\bexec(?:Sync|File)?\s*\(|\bspawn(?:Sync)?\s*\(/;
  const MMX_CONFIG_READ_PATTERN = /\.mmx[\\/]config\.json/;

  async function listAllSrcTs() {
    return listTsFiles(SRC_DIR);
  }

  it("mmx-cli is pinned to exactly 1.0.16 with no range prefix", async () => {
    const raw = await fs.readFile(PACKAGE_JSON, "utf8");
    const pkg = JSON.parse(raw);
    assert.strictEqual(
      pkg.dependencies && pkg.dependencies["mmx-cli"],
      "1.0.16",
      "mmx-cli must be an exact dependency (1.0.16), no ^ or ~ prefix",
    );
  });

  it("exactly one source file imports mmx-cli/sdk, and it is sdk-client.ts", async () => {
    const files = await listAllSrcTs();
    const matches = [];
    for (const file of files) {
      const source = await readSource(file);
      const imports = extractImports(source);
      if (imports.some((spec) => spec.includes("mmx-cli"))) {
        matches.push(file);
      }
    }
    assert.deepStrictEqual(
      matches.map((f) => path.relative(SRC_DIR, f)),
      [path.relative(SRC_DIR, EXPECTED_SDK_FILE)],
      `mmx-cli/sdk must be imported only by providers/minimax/sdk-client.ts; found: ${matches.join(", ")}`,
    );
  });

  it("no source file invokes the mmx executable or reads .mmx/config.json", async () => {
    const files = await listAllSrcTs();
    for (const file of files) {
      const source = await readSource(file);
      const rel = path.relative(SRC_DIR, file);
      // Allow child_process imports only when they are not used to invoke
      // `mmx`. We scan for the `mmx` command token in a string literal AND
      // for any read of the MMX config file path.
      assert.ok(!MMX_CONFIG_READ_PATTERN.test(source), `${rel} reads .mmx/config.json`);
      // Detect a string-literal `mmx` command invocation.
      const mmxCmd = source.match(/(["'`])mmx(?:\s|\1)/);
      assert.ok(!mmxCmd, `${rel} invokes the mmx executable: ${mmxCmd && mmxCmd[0]}`);
      void MMX_EXEC_PATTERN;
    }
  });

  it("MiniMax adapter modules never read credentials through shared lib/config.ts", async () => {
    const minimaxDir = path.join(SRC_DIR, "providers", "minimax");
    const files = await listTsFiles(minimaxDir);
    assert.ok(files.length > 0, "expected MiniMax adapter modules to exist");
    for (const file of files) {
      const source = await readSource(file);
      const imports = extractImports(source);
      const violations = imports.filter(
        (spec) => spec.includes("lib/config") || /(?:^|\/)config\.js$/.test(spec),
      );
      // The only permitted config import is the Adapter-local
      // providers/minimax/config.js sibling, whose specifier is relative
      // ("./config.js") and stays inside the minimax directory.
      const external = violations.filter((spec) => !spec.startsWith("./config"));
      assert.deepStrictEqual(
        external,
        [],
        `${path.relative(SRC_DIR, file)} reads shared lib/config.ts: ${external.join(", ")}`,
      );
    }
  });
});
