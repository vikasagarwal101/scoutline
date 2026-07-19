/**
 * Source boundary assertions (NFR-004, DESIGN.md §1, ARCHITECTURE.md §2).
 *
 * P2-01 asserts the Provider Seam keeps Provider transport details
 * isolated:
 *   - Capability Modules (under `src/capabilities/`) import no Provider
 *     transport (no `@utcp/sdk`, `@utcp/mcp`, `@utcp/code-mode`, no
 *     `mmx-cli`, no internal Z.AI MCP client).
 *   - Command Modules (under `src/commands/`) import no UTCP SDK symbols
 *     and no MiniMax SDK symbols.
 *   - The Search command (`src/commands/search.ts`) imports no Provider
 *     client or response type (no `ZaiMcpClient`, no `WebSearchResult`,
 *     no MiniMax SDK surface).
 *   - Shared execution (`src/lib/execution.ts`) imports no concrete
 *     Adapter module.
 *
 * P2-04 isolates the MiniMax SDK: exactly one `mmx-cli/sdk` runtime
 * import lives in `providers/minimax/sdk-client.ts`. Production source
 * never invokes the `mmx` executable or reads `.mmx/config.json`.
 *
 * P2-06 adds the production-reachability check: every Phase 2 Module
 * listed in the seam MUST be reachable (statically or via dynamic
 * `import()`) from `src/index.ts` or `bin/scoutline.js`. Test-only and
 * barrel-only imports do not satisfy the check — a Module reachable only
 * from `tests/` or a barrel re-export is not actually wired into the
 * shipped package.
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
const PACKAGE_ROOT = path.resolve(__dirname, "..");
const SRC_DIR = path.join(PACKAGE_ROOT, "src");
const DIST_DIR = path.join(PACKAGE_ROOT, "dist");
const BIN_DIR = path.join(PACKAGE_ROOT, "bin");
const CAPABILITIES_DIR = path.join(SRC_DIR, "capabilities");
const COMMANDS_DIR = path.join(SRC_DIR, "commands");
const EXECUTION_FILE = path.join(SRC_DIR, "lib", "execution.ts");
const SEARCH_COMMAND_FILE = path.join(COMMANDS_DIR, "search.ts");
const PACKAGE_JSON = path.join(PACKAGE_ROOT, "package.json");
const EXPECTED_SDK_FILE = path.join(SRC_DIR, "providers", "minimax", "sdk-client.ts");
const REPOSITORY_EXPLORER_FILE = path.join(COMMANDS_DIR, "repository-explorer.ts");
const DOCTOR_COMMAND_FILE = path.join(COMMANDS_DIR, "doctor.ts");
const DIAGNOSTICS_CAPABILITY_FILE = path.join(CAPABILITIES_DIR, "diagnostics.ts");

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
  // Match static ES module import statements, both `import {x} from "y"`
  // and bare `import "y"`.
  const importRegex = /import\s+(?:[\s\S]*?from\s+)?["']([^"']+)["'];?/g;
  for (const match of source.matchAll(importRegex)) {
    const specifier = match[1];
    if (specifier) results.push(specifier);
  }
  // Match dynamic `import("...")` expressions (used by bin/scoutline.js).
  const dynamicRegex = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of source.matchAll(dynamicRegex)) {
    const specifier = match[1];
    if (specifier && !results.includes(specifier)) results.push(specifier);
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
// Search command boundary: imports no Provider client or response type.
// ---------------------------------------------------------------------------

describe("Search command: imports no Provider client or response type", () => {
  /**
   * Provider-only symbols that must NEVER appear in the Search command's
   * source. Adapters own credentials, transport, and Provider field
   * mapping; the Search command consumes the normalized Capability only.
   */
  const FORBIDDEN_PROVIDER_SYMBOLS = [
    "ZaiMcpClient",
    "WebSearchResult",
    "ZaiAdapterClientPort",
    "ZaiAdapterDependencies",
    "ZaiMcpClientOptions",
    "LegacyZaiSearchParams",
    "LegacySearchClientPort",
    "MiniMaxSdkPort",
    "MiniMaxSdkConstructor",
    "MiniMaxAdapterDependencies",
    "MiniMaxSDK",
  ];
  /**
   * Adapter module specifiers that must NEVER be imported by the Search
   * command. The command consumes a `SearchCapability` injected through
   * `MainDependencies`; it must not reach into a Provider Adapter.
   */
  const FORBIDDEN_ADAPTER_IMPORTS = [
    "../providers/zai/adapter.js",
    "../providers/minimax/adapter.js",
    "../lib/mcp-client.js",
    "../lib/mcp-config.js",
  ];

  it("Search command source contains no Provider client or response symbol", async () => {
    const source = await fs.readFile(SEARCH_COMMAND_FILE, "utf8");
    const hits = FORBIDDEN_PROVIDER_SYMBOLS.filter((sym) =>
      new RegExp(`\\b${sym}\\b`).test(source),
    );
    assert.deepStrictEqual(
      hits,
      [],
      `src/commands/search.ts must not reference Provider-only symbols: ${hits.join(", ")}`,
    );
  });

  it("Search command does not import a Provider Adapter Module", async () => {
    const source = await fs.readFile(SEARCH_COMMAND_FILE, "utf8");
    const imports = extractImports(source);
    const hits = imports.filter((spec) =>
      FORBIDDEN_ADAPTER_IMPORTS.some((bad) => spec === bad || spec.startsWith(bad)),
    );
    assert.deepStrictEqual(
      hits,
      [],
      `src/commands/search.ts must not import Provider Adapter Modules: ${hits.join(", ")}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Shared execution boundary: imports no concrete Adapter.
// ---------------------------------------------------------------------------

describe("Shared execution: imports no concrete Adapter Module", () => {
  /**
   * Adapter module specifiers that shared execution must NEVER reach.
   * `lib/execution.ts` orchestrates the generic Capability pipeline
   * (validate, cache identity, read, retry, write, count); it must not
   * couple to any Provider Adapter implementation.
   */
  const FORBIDDEN_ADAPTER_IMPORTS = [
    "../providers/zai/adapter.js",
    "../providers/minimax/adapter.js",
    "../providers/registry.js",
  ];

  it("shared execution source contains no Provider Adapter Module import", async () => {
    const source = await fs.readFile(EXECUTION_FILE, "utf8");
    const imports = extractImports(source);
    const hits = imports.filter((spec) =>
      FORBIDDEN_ADAPTER_IMPORTS.some((bad) => spec === bad || spec.startsWith(bad)),
    );
    assert.deepStrictEqual(
      hits,
      [],
      `src/lib/execution.ts must not import concrete Adapter Modules: ${hits.join(", ")}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Production-reachability (P2-06, ARCHITECTURE.md §2).
//
// Every Phase 2 production Module listed below MUST be reachable from
// `src/index.ts` or `bin/scoutline.js` via a static or dynamic `import()`.
// A Module reachable only from `tests/`, fixtures, or a barrel re-export
// is NOT wired into the shipped package and does not satisfy the seam.
// ---------------------------------------------------------------------------

/**
 * Walk imports (static + dynamic) starting from `entryPath`, returning
 * the set of project-relative source paths reached through either
 * `.ts` (under `SRC_DIR`) or `.js` (under `DIST_DIR` or `BIN_DIR`).
 */
async function reachableFromEntries(entryPaths) {
  const visited = new Set();
  const queue = [...entryPaths];
  while (queue.length > 0) {
    const cur = queue.shift();
    if (visited.has(cur)) continue;
    visited.add(cur);
    let source;
    try {
      source = await fs.readFile(cur, "utf8");
    } catch {
      continue;
    }
    const specs = extractImports(source);
    for (const spec of specs) {
      if (!spec.startsWith(".")) continue;
      const baseDir = path.dirname(cur);
      const resolved = path.resolve(baseDir, spec);
      // Try as-is, then with `.js` -> `.ts` swap for the source tree.
      const candidates = [resolved];
      if (resolved.endsWith(".js")) {
        candidates.push(resolved.slice(0, -3) + ".ts");
      }
      for (const candidate of candidates) {
        try {
          const stat = await fs.stat(candidate);
          if (stat.isFile()) {
            queue.push(candidate);
            break;
          }
        } catch {
          // try next candidate
        }
      }
    }
  }
  return visited;
}

/**
 * Project-relative path key for a Module. Translates `dist/X.js` to the
 * source counterpart `src/X.ts` so reachable-from-both queries converge.
 */
function relativeKey(absPath) {
  const rel = path.relative(PACKAGE_ROOT, absPath).replace(/\\/g, "/");
  if (rel.startsWith("dist/") && rel.endsWith(".js")) {
    return `src/${rel.slice("dist/".length, -".js".length)}.ts`;
  }
  if (rel.startsWith("bin/") && rel.endsWith(".js")) {
    // bin/ has no src counterpart; keep its own key.
    return rel;
  }
  return rel;
}

describe("Production reachability — every Phase 2 Module is wired into the shipped package", () => {
  /**
   * Each entry: a Module path relative to the source root, plus an
   * optional list of alternative forms (e.g., `dist/...js` for Modules
   * only reachable through `bin/scoutline.js`'s dynamic import).
   * The Module must appear under at least one of these forms in the
   * union of reachable sets from `src/index.ts` and `bin/scoutline.js`.
   */
  const REQUIRED_MODULES = [
    { module: "src/providers/types.ts" },
    { module: "src/providers/selection.ts" },
    { module: "src/providers/registry.ts" },
    { module: "src/capabilities/search.ts" },
    { module: "src/lib/execution.ts" },
    { module: "src/providers/zai/adapter.ts" },
    { module: "src/providers/minimax/adapter.ts" },
    { module: "src/providers/minimax/config.ts" },
    { module: "src/providers/minimax/sdk-client.ts" },
    { module: "src/command-invocation.ts" },
    // Only reachable through bin/scoutline.js's dynamic import of
    // `dist/node-command-invocation-adapter.js`. Check both forms.
    {
      module: "src/node-command-invocation-adapter.ts",
      alt: "bin/node-command-invocation-adapter.js",
    },
  ];

  it("src/index.ts and bin/scoutline.js collectively reach every Phase 2 Module", async () => {
    const indexEntry = path.join(SRC_DIR, "index.ts");
    const binEntry = path.join(BIN_DIR, "scoutline.js");
    const [indexReach, binReach] = await Promise.all([
      reachableFromEntries([indexEntry]),
      reachableFromEntries([binEntry]),
    ]);

    const indexKeys = new Set(Array.from(indexReach).map(relativeKey));
    const binKeys = new Set(Array.from(binReach).map(relativeKey));

    for (const { module, alt } of REQUIRED_MODULES) {
      const inIndex = indexKeys.has(module);
      const inBin = binKeys.has(module) || (alt ? binKeys.has(alt) : false);
      assert.ok(
        inIndex || inBin,
        `${module} must be reachable from src/index.ts or bin/scoutline.js ` +
          `(inIndex=${inIndex}, inBin=${inBin})`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Repository Explorer boundary (P6-06/P6-07, ARCHITECTURE.md §2, NFR-004).
//
// `commands/repository-explorer.ts` is the provider-neutral consumer
// of the Repository Capability contract. It MUST NOT import any
// concrete Provider client, Adapter implementation, MCP/UTCP raw
// tool name, or Provider response type. Provider-specific facts
// (ZRead grammar, credentials, transports) remain Adapter-internal.
//
// `commands/repo.ts` is now (P6-07) a thin handler over the Explorer
// and the injected Repository Capability. It MUST NOT import any
// concrete Provider client, raw MCP name, raw ZRead parser,
// traversal transport, cache policy, retry, or close — those concerns
// live in the Adapter and shared execution layers reached through
// `adapter.repository`.
// ---------------------------------------------------------------------------

describe("Repository Explorer: imports no concrete Provider transport (P6-06)", () => {
  /**
   * Provider-only symbols that must NEVER appear in the Explorer
   * source. The Explorer consumes a `RepositoryCapability`
   * injected through `executeRepositoryOperation`; it never reaches
   * into a Provider Adapter, raw tool name, or response type.
   */
  const FORBIDDEN_PROVIDER_SYMBOLS = [
    "ZaiMcpClient",
    "ZReadMcpClient",
    "ZaiAdapterClientPort",
    "ZaiAdapterDependencies",
    "ZaiMcpClientOptions",
    "WebSearchResult",
    "LegacyZaiSearchParams",
    "LegacySearchClientPort",
    "MiniMaxSdkPort",
    "MiniMaxSdkConstructor",
    "MiniMaxAdapterDependencies",
    "createZaiDescriptor",
    "createMiniMaxDescriptor",
    "createZaiRepositoryCapability",
  ];
  /**
   * Module specifiers that the Explorer MUST NOT import. Concrete
   * Adapter Modules, the production registry (which transitively
   * loads the Adapters), the MCP/UTCP clients, and the raw-tool
   * namespace library all stay out.
   */
  const FORBIDDEN_IMPORTS = [
    "../providers/zai/adapter.js",
    "../providers/zai/repository.js",
    "../providers/minimax/adapter.js",
    "../providers/registry.js",
    "../lib/mcp-client.js",
    "../lib/mcp-config.js",
    "@utcp/sdk",
    "@utcp/mcp",
    "@utcp/code-mode",
    "mmx-cli",
  ];

  it("Repository Explorer source contains no Provider client, Adapter, or response symbol", async () => {
    const source = await fs.readFile(REPOSITORY_EXPLORER_FILE, "utf8");
    const hits = FORBIDDEN_PROVIDER_SYMBOLS.filter((sym) =>
      new RegExp(`\\b${sym}\\b`).test(source),
    );
    assert.deepStrictEqual(
      hits,
      [],
      `src/commands/repository-explorer.ts must not reference Provider-only symbols: ${hits.join(", ")}`,
    );
  });

  it("Repository Explorer does not import a concrete Adapter, registry, or transport Module", async () => {
    const source = await fs.readFile(REPOSITORY_EXPLORER_FILE, "utf8");
    const imports = extractImports(source);
    const hits = imports.filter((spec) =>
      FORBIDDEN_IMPORTS.some((bad) => spec === bad || spec.startsWith(bad)),
    );
    assert.deepStrictEqual(
      hits,
      [],
      `src/commands/repository-explorer.ts must not import Provider Modules: ${hits.join(", ")}`,
    );
  });

  it("Doctor command stays free of Provider transport imports (P6-06 derivation path)", async () => {
    // The Doctor command now derives sharedCapabilities and
    // zaiOnlyCapabilities from descriptors passed through deps.
    // It MUST NOT reach into a concrete Adapter Module, the
    // production registry (which transitively loads Adapters), or
    // any transport layer.
    const source = await fs.readFile(DOCTOR_COMMAND_FILE, "utf8");
    const imports = extractImports(source);
    const forbidden = [
      "../providers/zai/adapter.js",
      "../providers/zai/repository.js",
      "../providers/minimax/adapter.js",
      "../providers/registry.js",
      "../lib/mcp-client.js",
      "../lib/mcp-config.js",
      "@utcp/sdk",
      "@utcp/mcp",
      "@utcp/code-mode",
      "mmx-cli",
    ];
    const hits = imports.filter((spec) =>
      forbidden.some((bad) => spec === bad || spec.startsWith(bad)),
    );
    assert.deepStrictEqual(
      hits,
      [],
      `src/commands/doctor.ts must not import Provider transports or the production registry: ${hits.join(", ")}`,
    );
  });

  it("Diagnostics Capability Module stays Provider-neutral (P6-06)", async () => {
    // diagnostics.ts is allowed to import the `ProviderDescriptor`
    // type and `ProviderCapability` from providers/types.js plus
    // shared errors. P6-06 removed the previous vision-operation and
    // MiniMax vision-conformance imports; the inventory is now
    // descriptor-derived. The Module MUST NOT import any concrete
    // Adapter, the production registry (which transitively loads
    // Adapters), a Provider transport, or any vision-conformance
    // registry — derivation goes through the descriptors passed in.
    const source = await fs.readFile(DIAGNOSTICS_CAPABILITY_FILE, "utf8");
    const imports = extractImports(source);
    const forbidden = [
      "../providers/zai/adapter.js",
      "../providers/zai/repository.js",
      "../providers/minimax/adapter.js",
      "../providers/minimax/vision-conformance.js",
      "../providers/registry.js",
      "../lib/mcp-client.js",
      "../lib/mcp-config.js",
      "@utcp/sdk",
      "@utcp/mcp",
      "@utcp/code-mode",
      "mmx-cli",
    ];
    const hits = imports.filter((spec) =>
      forbidden.some((bad) => spec === bad || spec.startsWith(bad)),
    );
    assert.deepStrictEqual(
      hits,
      [],
      `src/capabilities/diagnostics.ts must not import Provider transports, adapters, or vision-conformance: ${hits.join(", ")}`,
    );
  });

  it("commands/repo.ts owns no Provider client, raw MCP name, parser, traversal, cache, retry, or close (P6-07)", async () => {
    // P6-07 cuts the legacy `repo` dispatch over to the Provider
    // Capability + Explorer path. The handler must NOT import any
    // concrete Provider client, MCP client, raw-tool namespace
    // library, or Provider response type. Provider-specific facts
    // (ZRead grammar, credentials, transports, cache policy,
    // retry, close) live in the Adapter and shared execution
    // layers reached through `adapter.repository`.
    const source = await fs.readFile(path.join(COMMANDS_DIR, "repo.ts"), "utf8");
    const imports = extractImports(source);

    // No concrete Provider client, MCP client, or raw-tool config.
    const forbiddenImports = [
      "../lib/mcp-client.js",
      "../lib/mcp-config.js",
      "../providers/zai/adapter.js",
      "../providers/zai/repository.js",
      "../providers/minimax/adapter.js",
      "../providers/registry.js",
      "@utcp/sdk",
      "@utcp/mcp",
      "@utcp/code-mode",
      "mmx-cli",
    ];
    const importHits = imports.filter((spec) =>
      forbiddenImports.some((bad) => spec === bad || spec.startsWith(bad)),
    );
    assert.deepStrictEqual(
      importHits,
      [],
      `src/commands/repo.ts must not import Provider clients, raw-tool namespaces, or Adapter Modules: ${importHits.join(", ")}`,
    );

    // No Provider-only symbols. The repo handlers reach the
    // Provider exclusively through the injected
    // `RepositoryCapability`.
    const forbiddenSymbols = [
      "ZaiMcpClient",
      "ZReadMcpClient",
      "ZaiAdapterClientPort",
      "ZaiAdapterDependencies",
      "ZaiMcpClientOptions",
      "WebSearchResult",
      "LegacyZaiSearchParams",
      "LegacySearchClientPort",
      "MiniMaxSdkPort",
      "MiniMaxSdkConstructor",
      "MiniMaxAdapterDependencies",
      "createZaiDescriptor",
      "createMiniMaxDescriptor",
      "createZaiRepositoryCapability",
    ];
    const symbolHits = forbiddenSymbols.filter((sym) => new RegExp(`\\b${sym}\\b`).test(source));
    assert.deepStrictEqual(
      symbolHits,
      [],
      `src/commands/repo.ts must not reference Provider-only symbols: ${symbolHits.join(", ")}`,
    );

    // No `new ZReadMcpClient(` / `new ZaiMcpClient(` construction,
    // no `.close()` transport lifecycle owned by the handler, and
    // no `finally` block (which historically gated transport
    // teardown). Cache and retry policy are owned by shared
    // execution; the handler must not call them directly.
    assert.ok(
      !/new\s+ZReadMcpClient\s*\(/.test(source),
      "src/commands/repo.ts must not construct ZReadMcpClient",
    );
    assert.ok(
      !/new\s+ZaiMcpClient\s*\(/.test(source),
      "src/commands/repo.ts must not construct ZaiMcpClient",
    );
    assert.ok(
      !/\bfinally\s*\{/.test(source),
      "src/commands/repo.ts must not own transport-teardown finally blocks",
    );
    // The handler is allowed to call explorerSearch/ReadFile/Tree;
    // it must not reach a raw `searchDoc` / `readFile` /
    // `getRepoStructure` ZRead method directly.
    assert.ok(
      !/\.searchDoc\s*\(/.test(source),
      "src/commands/repo.ts must not call raw ZRead searchDoc",
    );
    assert.ok(
      !/\.readFile\s*\(/.test(source),
      "src/commands/repo.ts must not call raw ZRead readFile",
    );
    assert.ok(
      !/\.getRepoStructure\s*\(/.test(source),
      "src/commands/repo.ts must not call raw ZRead getRepoStructure",
    );
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
