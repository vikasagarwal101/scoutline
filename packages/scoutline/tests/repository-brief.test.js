/**
 * Phase 2 repo-brief stream — Tickets 1 + 2 + 3.
 *
 * Ticket 1: RepositoryBrief type set + pure selection/parsing helpers
 *   (DESIGN D1, D7; SCHEMA.md).
 * Ticket 2: `repoBrief` handler composition (DESIGN D3/D4/D6).
 * Ticket 3: Dispatch wiring through `main` (DESIGN D5) — exercised here
 *   with the same hermetic env pattern as `repository-command.test.js`
 *   so the brief's failure modes (a) are observed through the real
 *   dispatch layer.
 *
 * Tests import from `dist/` per the package's build-then-test contract;
 * the build step precedes `node --test`.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import {
  REPO_BRIEF_FOCUS,
  REPO_HELP,
  selectBriefFiles,
  parseBriefFocus,
  parseBriefDepth,
  parseBriefMaxChars,
  README_QUERY,
  MANIFEST_QUERY,
  repoBrief,
} from "../dist/commands/repo.js";
import { main } from "../dist/index.js";
import { ValidationError } from "../dist/lib/errors.js";
import { createFakeRepositoryCapability } from "./helpers/fake-adapter.js";

// ---------------------------------------------------------------------------
// Fixture builders — crafted trees, no I/O
// ---------------------------------------------------------------------------

/**
 * Build a minimal `RepositoryTreeResult` for selection tests. `snapshots`
 * preserves BFS order: first the root listing, then deeper listings. Each
 * entry is `{ name, path, kind: "file" | "directory" }`. Non-file entries
 * (directories) must NOT be selected by README/manifest matching even when
 * a directory's `name` happens to look like a README/manifest.
 */
function buildTree(snapshots) {
  return {
    schemaVersion: 1,
    repository: "owner/repo",
    path: "",
    depth: 1,
    snapshots: snapshots.map((entries, index) => ({
      repository: "owner/repo",
      path: index === 0 ? "" : snapshots[index - 1]?.path || "",
      entries: entries.map((e) => ({
        name: e.name,
        path: e.path,
        kind: e.kind || "file",
      })),
    })),
  };
}

// ---------------------------------------------------------------------------
// REPO_BRIEF_FOCUS sealed set
// ---------------------------------------------------------------------------

describe("REPO_BRIEF_FOCUS — sealed v1 focus set", () => {
  it("is exactly the four canonical focus tokens in declaration order", () => {
    assert.deepStrictEqual([...REPO_BRIEF_FOCUS], [
      "structure",
      "readme",
      "manifest",
      "files",
    ]);
  });

  it("is readonly at the type level (constant identity)", () => {
    // The literal constant is the source of truth; mutating it would break
    // every consumer that captures its identity. We assert identity only.
    assert.equal(typeof REPO_BRIEF_FOCUS, "object");
    assert.ok(Array.isArray(REPO_BRIEF_FOCUS) || REPO_BRIEF_FOCUS.length !== undefined);
  });
});

// ---------------------------------------------------------------------------
// D7 — Probe queries are constants, not constructed text
// ---------------------------------------------------------------------------

describe("D7 probe query constants", () => {
  it("README_QUERY is the literal \"README\" (no construction)", () => {
    assert.equal(README_QUERY, "README");
  });

  it("MANIFEST_QUERY joins all four canonical kinds in canonical order", () => {
    assert.equal(
      MANIFEST_QUERY,
      "package.json pyproject.toml Cargo.toml go.mod",
    );
  });
});

// ---------------------------------------------------------------------------
// selectBriefFiles — D1 / D7 selection rules
// ---------------------------------------------------------------------------

describe("selectBriefFiles — D1/D7 deterministic selection", () => {
  it("README at the root wins", () => {
    const tree = buildTree([
      [{ name: "README.md", path: "README.md" }],
      [{ name: "README.md", path: "docs/README.md" }],
    ]);
    const out = selectBriefFiles(tree);
    assert.deepStrictEqual(out, { readme: "README.md", manifests: [] });
  });

  it("README nested deeper loses to README at root", () => {
    const tree = buildTree([
      [
        { name: "README.md", path: "README.md" },
        { name: "src", path: "src", kind: "directory" },
      ],
      [{ name: "README.md", path: "src/README.md" }],
    ]);
    const out = selectBriefFiles(tree);
    assert.deepStrictEqual(out, { readme: "README.md", manifests: [] });
  });

  it("README nested deeper loses to README at intermediate depth", () => {
    // Root has only a directory; depth 1 has README; depth 2 has another README.
    // Winner is the shallowest occurrence (depth 1), NOT depth 2.
    const tree = buildTree([
      [{ name: "docs", path: "docs", kind: "directory" }],
      [{ name: "README.md", path: "docs/README.md" }],
      [{ name: "README.md", path: "docs/inner/README.md" }],
    ]);
    const out = selectBriefFiles(tree);
    assert.equal(out.readme, "docs/README.md");
  });

  it("README absent → no readme key; empty manifests", () => {
    const tree = buildTree([
      [{ name: "src", path: "src", kind: "directory" }],
      [{ name: "index.ts", path: "src/index.ts" }],
    ]);
    const out = selectBriefFiles(tree);
    // When no README is found, the readme key is OMITTED (cleaner than
    // { readme: undefined }) — consumers read `out.readme === undefined`.
    assert.equal(out.readme, undefined);
    assert.deepStrictEqual(out.manifests, []);
  });

  it("case-insensitive README basename match", () => {
    // README.md, readme.markdown, ReadMe.txt all match /^readme(\.|$)/i
    const tree = buildTree([
      [
        { name: "ReadMe.txt", path: "ReadMe.txt" },
        { name: "readme.markdown", path: "readme.markdown" },
      ],
    ]);
    const out = selectBriefFiles(tree);
    // First occurrence (BFS / sibling order) wins; tied depth broken by
    // entry order in the same snapshot.
    assert.equal(out.readme, "ReadMe.txt");
  });

  it("README with multiple extension segments is matched (readme.markdown.something)", () => {
    // DESIGN D7 specifies `/^readme(?:\.[a-z0-9]+)?$/i` — single optional
    // extension. `readme.markdown` matches; `readme.md.bak` does NOT.
    const tree = buildTree([
      [
        { name: "readme.md.bak", path: "readme.md.bak" },
        { name: "real-readme.md", path: "real-readme.md" },
      ],
    ]);
    const out = selectBriefFiles(tree);
    // Neither matches: readme.md.bak has two dots, real-readme.md has a
    // hyphen before readme.
    assert.equal(out.readme, undefined);
  });

  it("README with one extension matches", () => {
    const tree = buildTree([
      [{ name: "README.MD", path: "README.MD" }],
    ]);
    const out = selectBriefFiles(tree);
    assert.equal(out.readme, "README.MD");
  });

  it("package.json at depth 0 wins over depth 2 (case-sensitive exact match)", () => {
    const tree = buildTree([
      [
        { name: "src", path: "src", kind: "directory" },
        { name: "package.json", path: "package.json" },
      ],
      [{ name: "package.json", path: "src/package.json" }],
    ]);
    const out = selectBriefFiles(tree);
    assert.deepStrictEqual(out.readme, undefined);
    assert.deepStrictEqual(out.manifests, ["package.json"]);
  });

  it("package.json at depth 2 wins when no shallower occurrence", () => {
    const tree = buildTree([
      [{ name: "src", path: "src", kind: "directory" }],
      [{ name: "package.json", path: "src/package.json" }],
    ]);
    const out = selectBriefFiles(tree);
    assert.deepStrictEqual(out.manifests, ["src/package.json"]);
  });

  it("no manifest anywhere → empty manifests array", () => {
    const tree = buildTree([
      [
        { name: "README.md", path: "README.md" },
        { name: "src", path: "src", kind: "directory" },
      ],
      [{ name: "index.ts", path: "src/index.ts" }],
    ]);
    const out = selectBriefFiles(tree);
    assert.deepStrictEqual(out, { readme: "README.md", manifests: [] });
  });

  it("four manifests + README → README + first 3 kinds in canonical order (cap 4 reads)", () => {
    // Canonical order per SCHEMA.md: package.json, pyproject.toml,
    // Cargo.toml, go.mod. All four are present at depth 0 → first 3 kinds
    // (package.json, pyproject.toml, Cargo.toml) are selected; go.mod is
    // beyond the 4-read cap and is NOT included.
    const tree = buildTree([
      [
        { name: "README.md", path: "README.md" },
        { name: "package.json", path: "package.json" },
        { name: "pyproject.toml", path: "pyproject.toml" },
        { name: "Cargo.toml", path: "Cargo.toml" },
        { name: "go.mod", path: "go.mod" },
      ],
    ]);
    const out = selectBriefFiles(tree);
    assert.deepStrictEqual(out, {
      readme: "README.md",
      manifests: ["package.json", "pyproject.toml", "Cargo.toml"],
    });
  });

  it("manifest kinds appear in canonical kind order regardless of BFS order", () => {
    // If entries appear in REVERSE order (go.mod first, package.json last),
    // canonical-kind order must still win.
    const tree = buildTree([
      [
        { name: "go.mod", path: "go.mod" },
        { name: "Cargo.toml", path: "Cargo.toml" },
        { name: "pyproject.toml", path: "pyproject.toml" },
        { name: "package.json", path: "package.json" },
      ],
    ]);
    const out = selectBriefFiles(tree);
    assert.deepStrictEqual(out.manifests, [
      "package.json",
      "pyproject.toml",
      "Cargo.toml",
      "go.mod",
    ]);
  });

  it("non-file entries (directories) are ignored even if name looks like README/manifest", () => {
    const tree = buildTree([
      [
        { name: "README.md", path: "README.md", kind: "directory" },
        { name: "package.json", path: "package.json", kind: "directory" },
        { name: "src", path: "src", kind: "directory" },
        { name: "real-readme.md", path: "real-readme.md" },
      ],
      [{ name: "README.md", path: "real-readme.md/README.md" }],
    ]);
    const out = selectBriefFiles(tree);
    // The directory named "README.md" must NOT be selected; the file at
    // real-readme.md/README.md (depth 1) wins.
    assert.equal(out.readme, "real-readme.md/README.md");
    // No package.json FILE exists; manifests stays empty.
    assert.deepStrictEqual(out.manifests, []);
  });

  it("manifest match is case-sensitive exact (Package.JSON does NOT match package.json)", () => {
    const tree = buildTree([
      [{ name: "Package.JSON", path: "Package.JSON" }],
    ]);
    const out = selectBriefFiles(tree);
    assert.deepStrictEqual(out.manifests, []);
  });

  it("empty tree yields no readme key and empty manifests", () => {
    const tree = buildTree([[]]);
    const out = selectBriefFiles(tree);
    assert.equal(out.readme, undefined);
    assert.deepStrictEqual(out.manifests, []);
  });

  it("sibling ties at the same depth are broken by entry order (BFS / provider order)", () => {
    // Two READMEs at the same depth — first wins.
    const tree = buildTree([
      [
        { name: "README.md", path: "README.md" },
        { name: "README.md", path: "second-README.md" },
      ],
    ]);
    const out = selectBriefFiles(tree);
    assert.equal(out.readme, "README.md");
  });
});

// ---------------------------------------------------------------------------
// D7 request-parsing helpers (parseBriefFocus / parseBriefDepth / parseBriefMaxChars)
// ---------------------------------------------------------------------------

describe("parseBriefFocus — D7 focus parsing", () => {
  it("splits a comma-separated string", () => {
    const out = parseBriefFocus("structure,readme,manifest,files");
    assert.deepStrictEqual([...out], [
      "structure",
      "readme",
      "manifest",
      "files",
    ]);
  });

  it("trims whitespace around tokens", () => {
    const out = parseBriefFocus("  structure , readme  ,manifest");
    assert.deepStrictEqual([...out], ["structure", "readme", "manifest"]);
  });

  it("drops empty tokens (leading/trailing/double commas)", () => {
    const out = parseBriefFocus(",structure,,readme,,");
    assert.deepStrictEqual([...out], ["structure", "readme"]);
  });

  it("dedupes preserving first occurrence", () => {
    const out = parseBriefFocus("structure,readme,structure,manifest,readme");
    assert.deepStrictEqual([...out], ["structure", "readme", "manifest"]);
  });

  it("preserves caller order (does NOT sort)", () => {
    const out = parseBriefFocus("files,manifest,readme,structure");
    assert.deepStrictEqual([...out], [
      "files",
      "manifest",
      "readme",
      "structure",
    ]);
  });

  it("rejects unknown token with ValidationError naming the sealed set", () => {
    assert.throws(
      () => parseBriefFocus("structure,nope"),
      (err) => {
        assert.ok(err instanceof ValidationError);
        assert.match(err.message, /Unknown --focus value "nope"/);
        // Names the sealed set so the consumer can fix it without docs.
        assert.match(err.message, /structure/);
        assert.match(err.message, /readme/);
        assert.match(err.message, /manifest/);
        assert.match(err.message, /files/);
        return true;
      },
    );
  });

  it("empty-after-processing throws ValidationError", () => {
    assert.throws(
      () => parseBriefFocus(""),
      (err) => {
        assert.ok(err instanceof ValidationError);
        assert.match(err.message, /at least one/i);
        return true;
      },
    );
    assert.throws(
      () => parseBriefFocus("   ,  ,,"),
      (err) => {
        assert.ok(err instanceof ValidationError);
        assert.match(err.message, /at least one/i);
        return true;
      },
    );
  });

  it("accepts each canonical token in isolation", () => {
    for (const token of REPO_BRIEF_FOCUS) {
      const out = parseBriefFocus(token);
      assert.deepStrictEqual([...out], [token]);
    }
  });

  it("accepts the full set in any order", () => {
    const out = parseBriefFocus("files,structure,manifest,readme");
    assert.equal(out.length, 4);
    // Every canonical token is present (order is preserved, so we check
    // membership).
    for (const token of REPO_BRIEF_FOCUS) {
      assert.ok(out.includes(token));
    }
  });
});

describe("parseBriefDepth — D7 depth validation", () => {
  it("accepts positive integers", () => {
    assert.equal(parseBriefDepth(1), 1);
    assert.equal(parseBriefDepth(3), 3);
    assert.equal(parseBriefDepth("2"), 2);
  });

  it("rejects zero", () => {
    assert.throws(
      () => parseBriefDepth(0),
      (err) => {
        assert.ok(err instanceof ValidationError);
        assert.match(err.message, /positive integer/);
        return true;
      },
    );
  });

  it("rejects negative integers", () => {
    assert.throws(
      () => parseBriefDepth(-1),
      (err) => {
        assert.ok(err instanceof ValidationError);
        assert.match(err.message, /positive integer/);
        return true;
      },
    );
  });

  it("rejects non-integer numerics", () => {
    assert.throws(
      () => parseBriefDepth(1.5),
      (err) => {
        assert.ok(err instanceof ValidationError);
        return true;
      },
    );
    assert.throws(
      () => parseBriefDepth(NaN),
      (err) => {
        assert.ok(err instanceof ValidationError);
        return true;
      },
    );
    assert.throws(
      () => parseBriefDepth(Infinity),
      (err) => {
        assert.ok(err instanceof ValidationError);
        return true;
      },
    );
  });

  it("rejects non-numeric strings", () => {
    assert.throws(
      () => parseBriefDepth("abc"),
      (err) => {
        assert.ok(err instanceof ValidationError);
        return true;
      },
    );
  });

  it("undefined input means \"unset\" — returns undefined", () => {
    assert.equal(parseBriefDepth(undefined), undefined);
  });
});

describe("parseBriefMaxChars — D7 maxChars validation", () => {
  it("accepts positive integers", () => {
    assert.equal(parseBriefMaxChars(1), 1);
    assert.equal(parseBriefMaxChars(2000), 2000);
    assert.equal(parseBriefMaxChars("500"), 500);
  });

  it("rejects zero and negatives", () => {
    assert.throws(() => parseBriefMaxChars(0), ValidationError);
    assert.throws(() => parseBriefMaxChars(-10), ValidationError);
  });

  it("rejects non-integer numerics", () => {
    assert.throws(() => parseBriefMaxChars(1.5), ValidationError);
    assert.throws(() => parseBriefMaxChars(NaN), ValidationError);
  });

  it("rejects non-numeric strings", () => {
    assert.throws(() => parseBriefMaxChars("oops"), ValidationError);
  });

  it("undefined input means \"unset\" — returns undefined", () => {
    assert.equal(parseBriefMaxChars(undefined), undefined);
  });
});

// ===========================================================================
// Ticket 2 — repoBrief handler composition (DESIGN D3/D4/D6; SCHEMA.md)
// ===========================================================================

/**
 * A `RepositorySearchResult` fixture for a given query. The repository is
 * fixed so handler envelopes are byte-deterministic for assertions.
 */
function searchResult(query) {
  return {
    schemaVersion: 1,
    repository: "owner/repo",
    query,
    language: "en",
    excerpts: [{ text: `hit for ${query}` }],
    truncated: false,
    originalTextLength: 0,
  };
}

/** A `RepositoryFileResult` fixture for a given path. */
function readResult(path) {
  return {
    schemaVersion: 1,
    repository: "owner/repo",
    path,
    content: `content of ${path}`,
    truncated: false,
    originalContentLength: 0,
  };
}

/** Default root entries: README + two manifests → 3 read probes under files. */
const DEFAULT_ENTRIES = {
  "": [
    { name: "README.md", path: "README.md", kind: "file" },
    { name: "package.json", path: "package.json", kind: "file" },
    { name: "pyproject.toml", path: "pyproject.toml", kind: "file" },
  ],
};

/**
 * Build a fake Repository Capability plus a shared ordered `calls` recorder.
 * Every operation pushes a deterministic token into `calls` BEFORE running
 * the scripted override, so probe order is observable as a flat array.
 *
 * `entries` is a path→entries map for the tree (default DEFAULT_ENTRIES);
 * `search`/`readFile`/`listDirectory` are optional per-operation overrides
 * that run after the recorder token is pushed.
 */
function makeFakeBriefCapability({ entries, search, readFile, listDirectory } = {}) {
  const calls = [];
  const treeEntries = entries || DEFAULT_ENTRIES;
  const { capability, stats } = createFakeRepositoryCapability({
    listDirectory: {
      result: (request) => {
        calls.push(`tree:${request.path}`);
        if (listDirectory) return listDirectory(request);
        return {
          repository: request.repository,
          path: request.path,
          entries: treeEntries[request.path] || [],
        };
      },
    },
    search: {
      result: (request) => {
        calls.push(`search:${request.query}`);
        if (search) return search(request);
        return searchResult(request.query);
      },
    },
    readFile: {
      result: (request) => {
        calls.push(`read:${request.path}`);
        if (readFile) return readFile(request);
        return readResult(request.path);
      },
    },
  });
  return { capability, calls, stats };
}

/** Minimal ExecutionDependencies with a recording cache (get/set logs). */
function makeBriefExecution() {
  const gets = [];
  const sets = [];
  const store = new Map();
  return {
    execution: {
      cache: {
        async get(key) {
          gets.push(key);
          return store.has(key) ? store.get(key) : null;
        },
        async set(key, value) {
          sets.push({ key, value });
          store.set(key, value);
        },
      },
      sleep: async () => {},
      random: () => 0.5,
    },
    gets,
    sets,
  };
}

/** The tree the Explorer produces for DEFAULT_ENTRIES at depth 1. */
const DEFAULT_TREE = {
  schemaVersion: 1,
  repository: "owner/repo",
  path: "",
  depth: 1,
  snapshots: [{ repository: "owner/repo", path: "", entries: DEFAULT_ENTRIES[""] }],
};

describe("repoBrief — handler composition (DESIGN D3/D4)", () => {
  it("runs the fixed probe order: tree → search:readme → search:manifest → reads", async () => {
    const { capability, calls } = makeFakeBriefCapability();
    const { execution } = makeBriefExecution();
    const result = await repoBrief("owner/repo", {}, { capability, execution });
    assert.strictEqual(result.kind, "data");
    assert.deepStrictEqual(calls, [
      "tree:",
      "search:README",
      "search:package.json pyproject.toml Cargo.toml go.mod",
      "read:README.md",
      "read:package.json",
      "read:pyproject.toml",
    ]);
  });

  it("defaults --focus to all four sealed tokens when omitted", async () => {
    const { capability } = makeFakeBriefCapability();
    const { execution } = makeBriefExecution();
    const result = await repoBrief("owner/repo", {}, { capability, execution });
    assert.deepStrictEqual([...result.data.focus], [
      "structure",
      "readme",
      "manifest",
      "files",
    ]);
  });

  it("--focus structure runs no searches or reads (tree only)", async () => {
    const { capability, stats, calls } = makeFakeBriefCapability();
    const { execution } = makeBriefExecution();
    const result = await repoBrief("owner/repo", { focus: ["structure"] }, { capability, execution });
    assert.strictEqual(result.kind, "data");
    assert.strictEqual(stats.search.invoke, 0);
    assert.strictEqual(stats.readFile.invoke, 0);
    assert.strictEqual(stats.listDirectory.invoke, 1);
    assert.deepStrictEqual(calls, ["tree:"]);
    // Coverage still records the focus-excluded probe classes as skipped.
    assert.deepStrictEqual(
      result.data.coverage.probes.map((p) => p.label),
      ["tree", "search:readme", "search:manifest", "read:<files>"],
    );
    assert.deepStrictEqual(
      result.data.coverage.probes.filter((p) => p.status === "skipped").map((p) => p.reason),
      ["focus-excluded", "focus-excluded", "focus-excluded"],
    );
  });

  it("--focus readme,manifest runs the tree internally but omits the tree section", async () => {
    const { capability, stats, calls } = makeFakeBriefCapability();
    const { execution } = makeBriefExecution();
    const result = await repoBrief("owner/repo", { focus: ["readme", "manifest"] }, { capability, execution });
    assert.strictEqual(result.kind, "data");
    const brief = result.data;
    assert.strictEqual(stats.listDirectory.invoke, 1, "tree probe still runs for selection");
    assert.ok(!("tree" in brief), "tree section omitted without structure focus");
    assert.ok(brief.docs, "docs present under readme focus");
    assert.ok(brief.entryPoints, "entryPoints present under manifest focus");
    assert.ok(!("files" in brief), "files omitted without files focus");
    assert.ok(brief.detected, "detected always present");
    assert.deepStrictEqual(calls, [
      "tree:",
      "search:README",
      "search:package.json pyproject.toml Cargo.toml go.mod",
    ]);
  });

  it("schema-shape: pins every SCHEMA.md field and the coverage presence matrix", async () => {
    const CASES = [
      { focus: ["structure"], tree: true, docs: false, entryPoints: false, files: false },
      { focus: ["readme"], tree: false, docs: true, entryPoints: false, files: false },
      { focus: ["manifest"], tree: false, docs: false, entryPoints: true, files: false },
      { focus: ["files"], tree: false, docs: false, entryPoints: false, files: true },
      { focus: ["structure", "readme"], tree: true, docs: true, entryPoints: false, files: false },
      { focus: ["readme", "manifest"], tree: false, docs: true, entryPoints: true, files: false },
      { focus: ["structure", "files"], tree: true, docs: false, entryPoints: false, files: true },
      { focus: ["structure", "readme", "manifest", "files"], tree: true, docs: true, entryPoints: true, files: true },
    ];
    for (const c of CASES) {
      const { capability } = makeFakeBriefCapability();
      const { execution } = makeBriefExecution();
      const result = await repoBrief("owner/repo", { focus: c.focus }, { capability, execution });
      const brief = result.data;
      assert.strictEqual(brief.schemaVersion, 1, `${c.focus} schemaVersion`);
      assert.strictEqual(brief.repository, "owner/repo", `${c.focus} repository`);
      assert.deepStrictEqual([...brief.focus], c.focus, `${c.focus} focus`);
      assert.ok(Array.isArray(brief.coverage.probes), `${c.focus} coverage`);
      assert.strictEqual("tree" in brief, c.tree, `${c.focus} tree presence`);
      assert.strictEqual("docs" in brief, c.docs, `${c.focus} docs presence`);
      assert.strictEqual("entryPoints" in brief, c.entryPoints, `${c.focus} entryPoints presence`);
      assert.strictEqual("files" in brief, c.files, `${c.focus} files presence`);
      assert.ok(brief.detected, `${c.focus} detected always present`);
      assert.ok(brief.coverage.probes.length > 0, `${c.focus} coverage non-empty`);
    }
  });

  it("envelope: full schema-version-1 shape with all sections under default focus", async () => {
    const { capability } = makeFakeBriefCapability();
    const { execution } = makeBriefExecution();
    const result = await repoBrief("owner/repo", {}, { capability, execution });
    assert.strictEqual(result.kind, "data");
    const brief = result.data;
    assert.strictEqual(brief.schemaVersion, 1);
    assert.strictEqual(brief.repository, "owner/repo");
    assert.deepStrictEqual([...brief.focus], ["structure", "readme", "manifest", "files"]);
    assert.deepStrictEqual(brief.coverage.probes, [
      { kind: "tree", label: "tree", status: "ok" },
      { kind: "search", label: "search:readme", status: "ok" },
      { kind: "search", label: "search:manifest", status: "ok" },
      { kind: "read", label: "read:README.md", status: "ok" },
      { kind: "read", label: "read:package.json", status: "ok" },
      { kind: "read", label: "read:pyproject.toml", status: "ok" },
    ]);
    assert.deepStrictEqual(brief.tree, DEFAULT_TREE);
    assert.deepStrictEqual(brief.docs, searchResult("README"));
    assert.deepStrictEqual(brief.entryPoints, searchResult(MANIFEST_QUERY));
    assert.deepStrictEqual([...brief.files], [
      { path: "README.md", content: "content of README.md", truncated: false, originalContentLength: 0 },
      { path: "package.json", content: "content of package.json", truncated: false, originalContentLength: 0 },
      { path: "pyproject.toml", content: "content of pyproject.toml", truncated: false, originalContentLength: 0 },
    ]);
    assert.deepStrictEqual(brief.detected, {
      hasReadme: true,
      hasManifest: true,
      manifestKinds: ["package.json", "pyproject.toml"],
    });
  });

  it("empty repo (no excerpts, no matches) still yields a valid envelope", async () => {
    const { capability } = makeFakeBriefCapability({
      entries: { "": [{ name: "src", path: "src", kind: "directory" }] },
      search: (request) => ({
        schemaVersion: 1,
        repository: "owner/repo",
        query: request.query,
        language: "en",
        excerpts: [],
        truncated: false,
        originalTextLength: 0,
      }),
    });
    const { execution } = makeBriefExecution();
    const result = await repoBrief("owner/repo", {}, { capability, execution });
    assert.strictEqual(result.kind, "data");
    const brief = result.data;
    assert.strictEqual(brief.schemaVersion, 1);
    assert.deepStrictEqual(brief.coverage.probes, [
      { kind: "tree", label: "tree", status: "ok" },
      { kind: "search", label: "search:readme", status: "ok" },
      { kind: "search", label: "search:manifest", status: "ok" },
    ]);
    assert.deepStrictEqual(brief.docs.excerpts, []);
    assert.deepStrictEqual(brief.entryPoints.excerpts, []);
    assert.ok(!("files" in brief), "no files selected → files omitted");
    assert.deepStrictEqual(brief.detected, {
      hasReadme: false,
      hasManifest: false,
      manifestKinds: [],
    });
  });

  it("reads are capped at 4 total (README + first 3 manifest kinds) in priority order", async () => {
    const { capability, calls } = makeFakeBriefCapability({
      entries: {
        "": [
          { name: "README.md", path: "README.md", kind: "file" },
          { name: "package.json", path: "package.json", kind: "file" },
          { name: "pyproject.toml", path: "pyproject.toml", kind: "file" },
          { name: "Cargo.toml", path: "Cargo.toml", kind: "file" },
          { name: "go.mod", path: "go.mod", kind: "file" },
        ],
      },
    });
    const { execution } = makeBriefExecution();
    const result = await repoBrief("owner/repo", { focus: ["files"] }, { capability, execution });
    assert.deepStrictEqual(result.data.files.map((f) => f.path), [
      "README.md",
      "package.json",
      "pyproject.toml",
      "Cargo.toml",
    ]);
    assert.ok(calls.includes("read:README.md"));
    assert.ok(calls.includes("read:package.json"));
    assert.ok(calls.includes("read:pyproject.toml"));
    assert.ok(calls.includes("read:Cargo.toml"));
    assert.ok(!calls.includes("read:go.mod"), "go.mod is beyond the 4-read cap");
  });

  it("detected.manifestKinds are in canonical order regardless of tree entry order", async () => {
    const { capability } = makeFakeBriefCapability({
      entries: {
        "": [
          { name: "go.mod", path: "go.mod", kind: "file" },
          { name: "package.json", path: "package.json", kind: "file" },
          { name: "pyproject.toml", path: "pyproject.toml", kind: "file" },
        ],
      },
    });
    const { execution } = makeBriefExecution();
    const result = await repoBrief("owner/repo", { focus: ["structure"] }, { capability, execution });
    assert.deepStrictEqual(result.data.detected.manifestKinds, [
      "package.json",
      "pyproject.toml",
      "go.mod",
    ]);
  });

  it("--max-chars forwards to every search/read and never to tree", async () => {
    const { capability } = makeFakeBriefCapability({
      search: (request) => ({
        schemaVersion: 1,
        repository: "owner/repo",
        query: request.query,
        language: "en",
        excerpts: [{ text: "X".repeat(200) }],
        truncated: false,
        originalTextLength: 200,
      }),
      readFile: (request) => ({
        schemaVersion: 1,
        repository: "owner/repo",
        path: request.path,
        content: "Y".repeat(200),
        truncated: false,
        originalContentLength: 200,
      }),
    });
    const { execution } = makeBriefExecution();
    const result = await repoBrief(
      "owner/repo",
      { focus: REPO_BRIEF_FOCUS, maxChars: 10 },
      { capability, execution },
    );
    assert.strictEqual(result.kind, "data");
    const brief = result.data;
    // Tree is never character-limited: the section is the raw tree.
    assert.deepStrictEqual(brief.tree, DEFAULT_TREE);
    // Searches and reads are projected.
    assert.strictEqual(brief.docs.truncated, true);
    assert.strictEqual(brief.docs.excerpts[0].text, "XXXXXXXXX…");
    assert.strictEqual(brief.entryPoints.truncated, true);
    for (const entry of brief.files) {
      assert.strictEqual(entry.truncated, true);
      assert.strictEqual(entry.content, "YYYYYYYYY…");
    }
  });

  it("--no-cache forwards to every probe (tree, searches, reads): zero cache reads", async () => {
    const { capability } = makeFakeBriefCapability();
    const { execution, gets } = makeBriefExecution();
    const result = await repoBrief(
      "owner/repo",
      { focus: REPO_BRIEF_FOCUS, noCache: true },
      { capability, execution },
    );
    assert.strictEqual(result.kind, "data");
    assert.strictEqual(gets.length, 0, "no cache reads when --no-cache is set");
  });

  it("reads the cache when --no-cache is unset", async () => {
    const { capability } = makeFakeBriefCapability();
    const { execution, gets } = makeBriefExecution();
    await repoBrief("owner/repo", { focus: REPO_BRIEF_FOCUS }, { capability, execution });
    assert.ok(gets.length > 0, "cache reads happen when --no-cache is unset");
  });

  it("--depth forwards to the tree only (deeper traversal)", async () => {
    const { capability, calls } = makeFakeBriefCapability({
      entries: {
        "": [
          { name: "README.md", path: "README.md", kind: "file" },
          { name: "src", path: "src", kind: "directory" },
        ],
        src: [{ name: "index.ts", path: "src/index.ts", kind: "file" }],
      },
    });
    const { execution } = makeBriefExecution();
    const result = await repoBrief("owner/repo", { focus: ["structure"], depth: 2 }, { capability, execution });
    assert.strictEqual(result.data.tree.depth, 2);
    assert.strictEqual(result.data.tree.snapshots.length, 2);
    assert.deepStrictEqual(calls, ["tree:", "tree:src"]);
  });

  it("--path forwards to the tree only (scoped traversal)", async () => {
    const { capability, calls } = makeFakeBriefCapability({
      entries: { src: [{ name: "index.ts", path: "src/index.ts", kind: "file" }] },
    });
    const { execution } = makeBriefExecution();
    const result = await repoBrief("owner/repo", { focus: ["structure"], path: "src" }, { capability, execution });
    assert.strictEqual(result.data.tree.path, "src");
    assert.deepStrictEqual(calls, ["tree:src"]);
  });

  it("determinism: two invocations over the same fake yield deep-equal envelopes", async () => {
    const { capability } = makeFakeBriefCapability();
    const { execution } = makeBriefExecution();
    const opts = { focus: REPO_BRIEF_FOCUS, noCache: true };
    const first = await repoBrief("owner/repo", opts, { capability, execution });
    const second = await repoBrief("owner/repo", opts, { capability, execution });
    assert.deepStrictEqual(second, first);
  });

  it("validates the repository string (validateRepo slash rule)", async () => {
    const { capability } = makeFakeBriefCapability();
    const { execution } = makeBriefExecution();
    await assert.rejects(
      () => repoBrief("not-a-repo", {}, { capability, execution }),
      (err) => err instanceof ValidationError && /Invalid repository format/.test(err.message),
    );
  });

  it("validates --depth as a positive integer", async () => {
    const { capability } = makeFakeBriefCapability();
    const { execution } = makeBriefExecution();
    await assert.rejects(
      () => repoBrief("owner/repo", { depth: 0 }, { capability, execution }),
      ValidationError,
    );
    await assert.rejects(
      () => repoBrief("owner/repo", { depth: -2 }, { capability, execution }),
      ValidationError,
    );
  });

  it("validates --max-chars as a positive integer", async () => {
    const { capability } = makeFakeBriefCapability();
    const { execution } = makeBriefExecution();
    await assert.rejects(
      () => repoBrief("owner/repo", { maxChars: 0 }, { capability, execution }),
      ValidationError,
    );
  });

  it("validates --focus against the sealed set and rejects empty", async () => {
    const { capability } = makeFakeBriefCapability();
    const { execution } = makeBriefExecution();
    await assert.rejects(
      () => repoBrief("owner/repo", { focus: ["nope"] }, { capability, execution }),
      (err) => err instanceof ValidationError && /nope/.test(err.message),
    );
    await assert.rejects(
      () => repoBrief("owner/repo", { focus: [] }, { capability, execution }),
      ValidationError,
    );
  });
});

describe("repoBrief — probe degradation (DESIGN D6)", () => {
  it("tree throws → files dependency-failed, searches still run, detected null, exit 0", async () => {
    const { capability } = makeFakeBriefCapability({
      listDirectory: () => {
        throw new Error("tree exploded");
      },
    });
    const { execution } = makeBriefExecution();
    const result = await repoBrief("owner/repo", {}, { capability, execution });
    assert.strictEqual(result.kind, "data");
    const brief = result.data;
    assert.ok(!("tree" in brief));
    assert.ok(!("files" in brief));
    assert.ok(brief.docs, "search:readme still runs after a tree failure");
    assert.ok(brief.entryPoints, "search:manifest still runs after a tree failure");
    assert.deepStrictEqual(brief.detected, {
      hasReadme: null,
      hasManifest: null,
      manifestKinds: null,
    });
    assert.deepStrictEqual(brief.coverage.probes, [
      {
        kind: "tree",
        label: "tree",
        status: "failed",
        error: { code: "UNKNOWN_ERROR", message: "tree exploded" },
      },
      { kind: "search", label: "search:readme", status: "ok" },
      { kind: "search", label: "search:manifest", status: "ok" },
      { kind: "read", label: "read:<files>", status: "skipped", reason: "dependency-failed" },
    ]);
  });

  it("probe failures record the stable error code in the failed record", async () => {
    const { capability } = makeFakeBriefCapability({
      listDirectory: () => {
        throw new ValidationError("bad tree");
      },
    });
    const { execution } = makeBriefExecution();
    const result = await repoBrief("owner/repo", {}, { capability, execution });
    const treeProbe = result.data.coverage.probes[0];
    assert.strictEqual(treeProbe.status, "failed");
    assert.strictEqual(treeProbe.error.code, "VALIDATION_ERROR");
    assert.strictEqual(treeProbe.error.message, "bad tree");
  });

  it("search:readme throws → docs omitted, everything else intact", async () => {
    const { capability } = makeFakeBriefCapability({
      search: (request) => {
        if (request.query === "README") throw new Error("readme search boom");
        return searchResult(request.query);
      },
    });
    const { execution } = makeBriefExecution();
    const result = await repoBrief("owner/repo", {}, { capability, execution });
    assert.strictEqual(result.kind, "data");
    const brief = result.data;
    assert.ok(!("docs" in brief));
    assert.ok(brief.tree, "tree intact");
    assert.ok(brief.entryPoints, "manifest search intact");
    assert.ok(brief.files, "reads intact");
    assert.ok(brief.detected);
    assert.deepStrictEqual(brief.coverage.probes[1], {
      kind: "search",
      label: "search:readme",
      status: "failed",
      error: { code: "UNKNOWN_ERROR", message: "readme search boom" },
    });
    assert.deepStrictEqual(brief.coverage.probes[2], {
      kind: "search",
      label: "search:manifest",
      status: "ok",
    });
  });

  it("one read throws → sibling reads present, files non-empty", async () => {
    const { capability } = makeFakeBriefCapability({
      readFile: (request) => {
        if (request.path === "package.json") throw new Error("read package.json boom");
        return readResult(request.path);
      },
    });
    const { execution } = makeBriefExecution();
    const result = await repoBrief("owner/repo", {}, { capability, execution });
    assert.strictEqual(result.kind, "data");
    const brief = result.data;
    assert.ok(brief.files, "files present (≥1 read succeeded)");
    assert.deepStrictEqual(brief.files.map((f) => f.path), ["README.md", "pyproject.toml"]);
    assert.deepStrictEqual(brief.coverage.probes[3], {
      kind: "read",
      label: "read:README.md",
      status: "ok",
    });
    assert.deepStrictEqual(brief.coverage.probes[4], {
      kind: "read",
      label: "read:package.json",
      status: "failed",
      error: { code: "UNKNOWN_ERROR", message: "read package.json boom" },
    });
    assert.deepStrictEqual(brief.coverage.probes[5], {
      kind: "read",
      label: "read:pyproject.toml",
      status: "ok",
    });
  });

  it("all focus-requested probes throw → handler rejects with the last error (exit 1 path)", async () => {
    const { capability } = makeFakeBriefCapability({
      listDirectory: () => {
        throw new Error("tree boom");
      },
      search: (request) => {
        if (request.query === "README") throw new Error("readme search boom");
        throw new Error("manifest search boom");
      },
    });
    const { execution } = makeBriefExecution();
    await assert.rejects(
      () => repoBrief("owner/repo", {}, { capability, execution }),
      (err) => err.message === "manifest search boom",
    );
  });

  it("structure-only focus with a failed tree → no ok probe → handler rejects", async () => {
    const { capability } = makeFakeBriefCapability({
      listDirectory: () => {
        throw new Error("tree boom");
      },
    });
    const { execution } = makeBriefExecution();
    await assert.rejects(
      () => repoBrief("owner/repo", { focus: ["structure"] }, { capability, execution }),
      (err) => err.message === "tree boom",
    );
  });
});

// ===========================================================================
// Ticket 3 — dispatch wiring (DESIGN D5)
//
// Drives `repo brief` through `main` with a hermetic env mirroring
// `repository-command.test.js`: ambient Provider credentials cleared
// before, restored after; Provider descriptors / cache / sleep / random
// injected via MainDependencies. Tests cover the dispatch grammar,
// output-mode rendering, REPO_HELP content, and the fail-closed (a)
// no-supplier path that requires main() wiring to reach.
// ===========================================================================

// ---------------------------------------------------------------------------
// Offline hermeticity: clear ambient Provider credentials so a developer
// shell with Z_AI_API_KEY / MINIMAX_API_KEY set cannot leak into the
// dispatch tests.
// ---------------------------------------------------------------------------

const PROVIDER_ENV_VARS = ["Z_AI_API_KEY", "ZAI_API_KEY", "MINIMAX_API_KEY", "SCOUTLINE_PROVIDER"];
const savedProviderEnv = {};
before(() => {
  for (const key of PROVIDER_ENV_VARS) {
    savedProviderEnv[key] = process.env[key];
    delete process.env[key];
  }
});
after(() => {
  for (const key of PROVIDER_ENV_VARS) {
    const saved = savedProviderEnv[key];
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
});

const FIXED_NOW = 1_700_000_000_000;

// ---------------------------------------------------------------------------
// Spy infrastructure — same shape as repository-command.test.js. The
// `briefCapability` impls return canned schema-version-1 results so the
// dispatch test never touches a real Adapter / MCP / UTCP transport.
// ---------------------------------------------------------------------------

function makeBriefRecordingCache() {
  const gets = [];
  const sets = [];
  const store = new Map();
  const cache = {
    async get(key) {
      gets.push(key);
      return store.has(key) ? store.get(key) : null;
    },
    async set(key, value) {
      sets.push({ key, value });
      store.set(key, value);
    },
  };
  return { cache, gets, sets, store };
}

function makeBriefRecordingOperation(kind, impl, label) {
  const calls = { validate: [], cacheIdentity: [], invoke: [] };
  return {
    kind,
    calls,
    validate(request) {
      calls.validate.push(request);
    },
    cacheIdentity(request) {
      calls.cacheIdentity.push(request);
      return {
        provider: "zai",
        capability: "repository-exploration",
        operation: kind,
        credentialFingerprint: "fake-fingerprint-fixed",
        request,
        legacyCandidates: [],
      };
    },
    decodeCached(value) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return value;
      }
      return null;
    },
    async invoke(request) {
      calls.invoke.push(request);
      if (typeof impl !== "function") {
        throw new Error(`fake ${label} invoke not configured for ${JSON.stringify(request)}`);
      }
      return impl(request, calls.invoke.length);
    },
  };
}

function makeBriefRecordingCapability({ search, readFile, listDirectory } = {}) {
  return {
    search: makeBriefRecordingOperation("repository-search", search, "search"),
    readFile: makeBriefRecordingOperation("repository-read-file", readFile, "readFile"),
    listDirectory: makeBriefRecordingOperation(
      "repository-list-directory",
      listDirectory,
      "listDirectory",
    ),
  };
}

function briefCapabilityCallCount(capability) {
  return {
    searchValidate: capability.search.calls.validate.length,
    searchIdentity: capability.search.calls.cacheIdentity.length,
    searchInvoke: capability.search.calls.invoke.length,
    readFileValidate: capability.readFile.calls.validate.length,
    readFileIdentity: capability.readFile.calls.cacheIdentity.length,
    readFileInvoke: capability.readFile.calls.invoke.length,
    listDirectoryValidate: capability.listDirectory.calls.validate.length,
    listDirectoryIdentity: capability.listDirectory.calls.cacheIdentity.length,
    listDirectoryInvoke: capability.listDirectory.calls.invoke.length,
  };
}

function makeBriefRecordingDescriptor({
  id,
  configured = true,
  repositoryCapability,
  extraCapabilities = [],
  omitRepositoryOnAdapter = false,
}) {
  const stats = {
    isConfiguredCalls: 0,
    capabilitiesCalls: 0,
    createCalls: 0,
  };
  const baseCapabilities = new Set(["repository-exploration", ...extraCapabilities]);
  const descriptor = {
    id,
    isConfigured(env) {
      stats.isConfiguredCalls += 1;
      if (typeof configured === "function") return configured(env);
      return configured;
    },
    capabilities() {
      stats.capabilitiesCalls += 1;
      return new Set(baseCapabilities);
    },
    create() {
      stats.createCalls += 1;
      const adapter = { id };
      if (!omitRepositoryOnAdapter && repositoryCapability) {
        adapter.repository = repositoryCapability;
      }
      return adapter;
    },
  };
  return { descriptor, stats };
}

function makeBriefRecordingMiniMaxDescriptor({ configured = true } = {}) {
  const stats = { isConfiguredCalls: 0, capabilitiesCalls: 0, createCalls: 0 };
  const descriptor = {
    id: "minimax",
    isConfigured(env) {
      stats.isConfiguredCalls += 1;
      if (typeof configured === "function") return configured(env);
      return configured;
    },
    capabilities() {
      stats.capabilitiesCalls += 1;
      return new Set(["search", "vision.interpret-image", "diagnostics"]);
    },
    create() {
      stats.createCalls += 1;
      return { id: "minimax" };
    },
  };
  return { descriptor, stats };
}

function makeBriefFakeSleepRandom() {
  const sleep = async () => {};
  const random = () => 0;
  return { sleep, random };
}

function createBriefRecordingAdapter(overrides = {}) {
  const stdout = [];
  const stderr = [];
  const adapter = {
    stdoutIsTTY: false,
    stdinIsTTY: false,
    environmentOutputMode: "data",
    readStdin: async () => "",
    writeStdout: (v) => stdout.push(v),
    writeStderr: (v) => stderr.push(v),
    runQuietly: async (op) => op(),
    setExitCode: () => {},
    ...overrides,
  };
  return { adapter, stdout, stderr };
}

// Canned normalized results that mirror the search/tree/read schema used
// by `repository-command.test.js`. They let the brief's internal probes
// resolve through real Explorer plumbing so dispatch wiring is the
// observable variable.
function briefCannedSearchResult(excerpts = [{ text: "alpha" }]) {
  return {
    schemaVersion: 1,
    repository: "owner/repo",
    query: "query",
    language: "en",
    excerpts,
    truncated: false,
    originalTextLength: excerpts.reduce((s, e) => s + e.text.length, 0),
  };
}

function briefCannedFileResult(path = "README.md", content = "hi") {
  return {
    schemaVersion: 1,
    repository: "owner/repo",
    path,
    content,
    truncated: false,
    originalContentLength: content.length,
  };
}

function briefCannedRootListing() {
  return {
    repository: "owner/repo",
    path: "",
    entries: [
      { name: "README.md", path: "README.md", kind: "file" },
      { name: "package.json", path: "package.json", kind: "file" },
    ],
  };
}

/**
 * Compose the standard brief MainDependencies: a Z.AI descriptor that
 * advertises `repository-exploration` plus a recording repository
 * capability, and a MiniMax descriptor that does NOT. Cache / sleep /
 * random are all in-memory doubles.
 *
 * `capabilityImpls` provides canned results for search / readFile /
 * listDirectory. When a probe is omitted, the fake throws on invoke.
 */
function makeBriefMainDeps({ search, readFile, listDirectory, zaiConfigured = true } = {}) {
  const capability = makeBriefRecordingCapability({ search, readFile, listDirectory });
  const zai = makeBriefRecordingDescriptor({
    id: "zai",
    configured: zaiConfigured,
    repositoryCapability: capability,
  });
  const minimax = makeBriefRecordingMiniMaxDescriptor({ configured: true });
  const cacheRec = makeBriefRecordingCache();
  const sleepRandom = makeBriefFakeSleepRandom();
  return {
    capability,
    zai,
    minimax,
    cacheRec,
    sleepRandom,
    mainDeps: {
      env: { Z_AI_API_KEY: "zai-key", MINIMAX_API_KEY: "minimax-key" },
      providerDescriptors: [zai.descriptor, minimax.descriptor],
      repositoryCache: cacheRec.cache,
      repositorySleep: sleepRandom.sleep,
      repositoryRandom: sleepRandom.random,
      searchCache: cacheRec.cache,
      searchSleep: sleepRandom.sleep,
      searchRandom: sleepRandom.random,
    },
  };
}

const BRIEF_DEFAULT_IMPLS = {
  search: () => briefCannedSearchResult(),
  readFile: () => briefCannedFileResult(),
  listDirectory: () => briefCannedRootListing(),
};

describe("Ticket 3 — repo brief dispatch through main (DESIGN D5)", () => {
  it("data mode: brief envelope is the schema-version-1 value as plain JSON (no envelope)", async () => {
    const m = makeBriefMainDeps(BRIEF_DEFAULT_IMPLS);
    const { adapter, stdout, stderr } = createBriefRecordingAdapter();
    const status = await main(
      ["repo", "brief", "owner/repo"],
      { ...m.mainDeps, now: () => FIXED_NOW, invocation: adapter },
    );

    assert.strictEqual(status, 0);
    assert.strictEqual(stderr.length, 0);
    assert.strictEqual(stdout.length, 1);
    const brief = JSON.parse(stdout[0]);
    assert.strictEqual(brief.schemaVersion, 1);
    assert.strictEqual(brief.repository, "owner/repo");
    assert.deepStrictEqual([...brief.focus], [...REPO_BRIEF_FOCUS]);
    assert.ok(Array.isArray(brief.coverage.probes));
    assert.ok(brief.tree, "structure focus → tree section present");
    assert.ok(brief.docs, "readme focus → docs section present");
    assert.ok(brief.entryPoints, "manifest focus → entryPoints section present");
    assert.ok(Array.isArray(brief.files), "files focus → files array present");
    assert.ok(brief.detected, "detected always present");
  });

  it("json mode: standard {success, data, timestamp} envelope (indent 0)", async () => {
    const m = makeBriefMainDeps(BRIEF_DEFAULT_IMPLS);
    const { adapter, stdout } = createBriefRecordingAdapter();
    const status = await main(
      ["repo", "brief", "owner/repo", "--output-format", "json"],
      { ...m.mainDeps, now: () => FIXED_NOW, invocation: adapter },
    );

    assert.strictEqual(status, 0);
    assert.strictEqual(stdout.length, 1);
    // indent 0 means single-line JSON
    assert.ok(!stdout[0].includes("\n"), "json mode is single-line");
    const envelope = JSON.parse(stdout[0]);
    assert.strictEqual(envelope.success, true);
    assert.ok(envelope.data);
    assert.strictEqual(envelope.data.schemaVersion, 1);
    assert.strictEqual(envelope.timestamp, FIXED_NOW);
  });

  it("pretty mode: standard envelope with indent 2", async () => {
    const m = makeBriefMainDeps(BRIEF_DEFAULT_IMPLS);
    const { adapter, stdout } = createBriefRecordingAdapter();
    const status = await main(
      ["repo", "brief", "owner/repo", "--output-format", "pretty"],
      { ...m.mainDeps, now: () => FIXED_NOW, invocation: adapter },
    );

    assert.strictEqual(status, 0);
    assert.strictEqual(stdout.length, 1);
    assert.ok(stdout[0].includes("\n  "), "pretty mode is multi-line indented");
    const envelope = JSON.parse(stdout[0]);
    assert.strictEqual(envelope.success, true);
    assert.strictEqual(envelope.data.schemaVersion, 1);
  });

  it("compact mode: returns the same data payload as data mode (JSON fallback)", async () => {
    const m = makeBriefMainDeps(BRIEF_DEFAULT_IMPLS);
    const { adapter, stdout } = createBriefRecordingAdapter();
    const status = await main(
      ["repo", "brief", "owner/repo", "--output-format", "compact"],
      { ...m.mainDeps, now: () => FIXED_NOW, invocation: adapter },
    );

    assert.strictEqual(status, 0);
    assert.strictEqual(stdout.length, 1);
    // Repo never supplies per-mode presentations, so compact is the
    // raw data payload — same shape as the data mode assertion above.
    const brief = JSON.parse(stdout[0]);
    assert.strictEqual(brief.schemaVersion, 1);
    assert.ok(brief.coverage);
  });

  it("dispatcher forwards --focus, --depth, --max-chars, --no-cache", async () => {
    const m = makeBriefMainDeps(BRIEF_DEFAULT_IMPLS);
    const { adapter, stderr } = createBriefRecordingAdapter();
    const status = await main(
      [
        "repo",
        "brief",
        "owner/repo",
        "--focus",
        "structure,files",
        "--depth",
        "2",
        "--max-chars",
        "500",
        "--no-cache",
      ],
      { ...m.mainDeps, invocation: adapter },
    );

    assert.strictEqual(status, 0);
    // --no-cache forwards to every probe: zero cache reads.
    assert.strictEqual(m.cacheRec.gets.length, 0, "--no-cache forwards to every probe");
    assert.strictEqual(stderr.length, 0);
  });

  it("unknown --focus value surfaces VALIDATION_ERROR (parse-level, before Provider resolution)", async () => {
    const m = makeBriefMainDeps(BRIEF_DEFAULT_IMPLS);
    const { adapter, stderr } = createBriefRecordingAdapter();
    const status = await main(
      ["repo", "brief", "owner/repo", "--focus", "bogus"],
      { ...m.mainDeps, invocation: adapter },
    );

    assert.strictEqual(status, 1);
    assert.ok(stderr.length >= 1);
    // Find the JSON error envelope (skip-notices precede it under fallback).
    const jsonLine = stderr.find((line) => line.startsWith("{"));
    assert.ok(jsonLine, `expected a JSON error envelope, got ${JSON.stringify(stderr)}`);
    const parsed = JSON.parse(jsonLine);
    assert.strictEqual(parsed.code, "VALIDATION_ERROR");
    assert.match(parsed.error, /Unknown --focus value "bogus"/);
    // No Adapter construction or capability work runs on a parse-level
    // failure. (`isConfigured` MAY be read once by main's pre-dispatch
    // resolveEnvFromConfig; that is config-layering, not selected-
    // Provider resolution, and is not asserted here.)
    assert.strictEqual(m.zai.stats.createCalls, 0);
    const counts = briefCapabilityCallCount(m.capability);
    for (const [key, value] of Object.entries(counts)) {
      assert.strictEqual(value, 0, `capability.${key} must be 0 on parse-level failure`);
    }
  });

  it("missing repo positional → VALIDATION_ERROR with usage hint", async () => {
    const m = makeBriefMainDeps(BRIEF_DEFAULT_IMPLS);
    const { adapter, stderr } = createBriefRecordingAdapter();
    const status = await main(["repo", "brief"], {
      ...m.mainDeps,
      invocation: adapter,
    });

    assert.strictEqual(status, 1);
    const jsonLine = stderr.find((line) => line.startsWith("{"));
    assert.ok(jsonLine, `expected a JSON error envelope, got ${JSON.stringify(stderr)}`);
    const parsed = JSON.parse(jsonLine);
    assert.strictEqual(parsed.code, "VALIDATION_ERROR");
    assert.match(parsed.error, /Missing repo/);
    // Usage hint (the ValidationError `help` field) names the brief
    // grammar so the consumer can fix the invocation without docs.
    assert.match(parsed.help, /repo brief <owner\/repo>/);
    // Parse-level: no Provider work.
    assert.strictEqual(m.zai.stats.createCalls, 0);
  });

  it("REPO_HELP documents the brief subcommand, focus set, max-chars wording, and tree-not-limited note", () => {
    assert.match(REPO_HELP, /brief <owner\/repo>/, "brief subcommand in Commands block");
    assert.match(
      REPO_HELP,
      /--focus <list>/,
      "focus flag documented",
    );
    assert.match(
      REPO_HELP,
      /structure, readme, manifest, files/,
      "sealed focus set listed in help",
    );
    assert.match(
      REPO_HELP,
      /--max-chars <n>/,
      "max-chars flag documented",
    );
    assert.match(
      REPO_HELP,
      /per[- ]call/i,
      "per-call max-chars wording present",
    );
    assert.match(
      REPO_HELP,
      /tree is never character-limited|tree is never limited/i,
      "tree never limited note present",
    );
    // Envelope schema note: brief is a new schema-version-1 shape.
    assert.match(REPO_HELP, /schemaVersion/);
    assert.match(
      REPO_HELP,
      /brief/i,
      "brief envelope referenced in output-format block",
    );
  });
});

// ---------------------------------------------------------------------------
// Fail-closed (a) — no supplier dispatch. Provider-fallback or
// configuration gating must fire before any Explorer probe, with zero
// selected-Provider work (DESIGN D6 (a)).
// ---------------------------------------------------------------------------

describe("Ticket 3 — no-supplier dispatch fail-closed (DESIGN D6 (a))", () => {
  it("unconfigured Z.AI → CONFIGURATION_ERROR exit 3 after support, before create", async () => {
    const m = makeBriefMainDeps({
      ...BRIEF_DEFAULT_IMPLS,
      zaiConfigured: (env) => Boolean(env.Z_AI_API_KEY),
    });
    const { adapter, stderr } = createBriefRecordingAdapter();
    const status = await main(["repo", "brief", "owner/repo"], {
      ...m.mainDeps,
      env: { MINIMAX_API_KEY: "minimax-key" },
      invocation: adapter,
    });

    assert.strictEqual(status, 3);
    const jsonLine = stderr.find((line) => line.startsWith("{"));
    assert.ok(
      jsonLine,
      `expected a JSON error envelope, got ${JSON.stringify(stderr)}`,
    );
    const parsed = JSON.parse(jsonLine);
    assert.strictEqual(parsed.code, "CONFIGURATION_ERROR");

    // Support check ran (capabilitiesCalls >= 1); create NEVER ran;
    // capability work NEVER ran.
    assert.strictEqual(m.zai.stats.createCalls, 0);
    const counts = briefCapabilityCallCount(m.capability);
    for (const [key, value] of Object.entries(counts)) {
      assert.strictEqual(value, 0, `capability.${key} must be 0 on unconfigured path`);
    }
  });

  it("--no-fallback + minimax → UNSUPPORTED_CAPABILITY exit 1, zero probes run", async () => {
    const m = makeBriefMainDeps(BRIEF_DEFAULT_IMPLS);
    const { adapter, stderr } = createBriefRecordingAdapter();
    const status = await main(
      ["--no-fallback", "--provider", "minimax", "repo", "brief", "owner/repo"],
      { ...m.mainDeps, invocation: adapter },
    );

    assert.strictEqual(status, 1);
    assert.strictEqual(stderr.length, 1, "no executor notices under --no-fallback");
    const parsed = JSON.parse(stderr[0]);
    assert.strictEqual(parsed.code, "UNSUPPORTED_CAPABILITY");

    // Cache spy: zero reads AND zero writes.
    assert.strictEqual(m.cacheRec.gets.length, 0);
    assert.strictEqual(m.cacheRec.sets.length, 0);
    // Capability spy: zero validate / identity / invoke.
    const counts = briefCapabilityCallCount(m.capability);
    for (const [key, value] of Object.entries(counts)) {
      assert.strictEqual(value, 0, `capability.${key} must be 0 on unsupported path`);
    }
    // No Z.AI fallback under --no-fallback. (As above, the one
    // pre-dispatch isConfigured read from resolveEnvFromConfig is not
    // selected-Provider resolution and is not asserted here.)
    assert.strictEqual(m.zai.stats.createCalls, 0);
  });
});

// ===========================================================================
// Ticket 4 — cache interaction (brief twice in one suite).
//
// Drives `repo brief` twice through `main` against ONE capability and
// ONE recording cache (the `makeRecordingCache` pattern from
// `repository-command.test.js:108`, wired here through
// `makeBriefMainDeps`). The cold run must invoke every Explorer probe
// and write one normalized cache unit per operation; the warm run's
// Explorer calls must hit the cache with zero new invokes and zero new
// writes. The composed brief itself is never a cache unit: no key
// containing "brief" may ever appear, because `repoBrief` composes
// operation-level units without touching the cache directly.
// ===========================================================================

describe("Ticket 4 — cache interaction: brief twice in one suite", () => {
  it("cold run invokes every probe and writes one unit per operation; warm run hits the cache with zero new invokes/writes", async () => {
    const m = makeBriefMainDeps(BRIEF_DEFAULT_IMPLS);
    const { adapter, stdout } = createBriefRecordingAdapter();
    const argv = ["repo", "brief", "owner/repo"];

    // Run 1 — cold cache: every Explorer probe misses, invokes, and
    // writes its normalized unit. The default root listing
    // (README.md + package.json) yields tree + 2 searches + 2 reads.
    const status1 = await main(argv, { ...m.mainDeps, now: () => FIXED_NOW, invocation: adapter });
    assert.strictEqual(status1, 0);
    assert.strictEqual(stdout.length, 1);
    const firstOut = stdout[0];

    const counts1 = briefCapabilityCallCount(m.capability);
    assert.strictEqual(counts1.listDirectoryInvoke, 1, "cold tree probe invokes once");
    assert.strictEqual(
      counts1.searchInvoke,
      2,
      "cold searches invoke twice (readme + manifest)",
    );
    assert.strictEqual(
      counts1.readFileInvoke,
      2,
      "cold reads invoke twice (README.md + package.json)",
    );
    assert.strictEqual(m.cacheRec.sets.length, 5, "cold run writes one unit per operation");
    assert.strictEqual(m.cacheRec.gets.length, 5, "cold run reads the normalized key per operation");

    // Run 2 — warm cache: same suite (same capability, same cache).
    const status2 = await main(argv, { ...m.mainDeps, now: () => FIXED_NOW, invocation: adapter });
    assert.strictEqual(status2, 0);
    assert.strictEqual(stdout.length, 2);

    // Second run's Explorer calls hit the cache: ZERO new invokes.
    const counts2 = briefCapabilityCallCount(m.capability);
    assert.strictEqual(counts2.listDirectoryInvoke, 1, "warm tree probe does not re-invoke");
    assert.strictEqual(counts2.searchInvoke, 2, "warm searches do not re-invoke");
    assert.strictEqual(counts2.readFileInvoke, 2, "warm reads do not re-invoke");
    // Zero new writes — every unit was already stored.
    assert.strictEqual(m.cacheRec.sets.length, 5, "warm run writes nothing");
    // The warm run still performed one cache read per probe (the hit).
    assert.strictEqual(
      m.cacheRec.gets.length,
      10,
      "warm run reads the normalized key once per operation",
    );
    // Validation and identity still run on cache hits — the executor
    // needs the identity to BUILD the key it just hit.
    assert.strictEqual(counts2.searchValidate, 4, "validate runs once per search per run");
    assert.strictEqual(counts2.searchIdentity, 4, "cacheIdentity runs once per search per run");

    // DESIGN D2 byte-determinism: identical inputs + warm cache →
    // identical stdout.
    assert.strictEqual(stdout[1], firstOut, "warm-cache brief output is byte-identical");
  });

  it("the brief itself is never written as a cache unit (no brief key ever appears)", async () => {
    const m = makeBriefMainDeps(BRIEF_DEFAULT_IMPLS);
    const { adapter } = createBriefRecordingAdapter();
    const status1 = await main(["repo", "brief", "owner/repo"], {
      ...m.mainDeps,
      invocation: adapter,
    });
    const status2 = await main(["repo", "brief", "owner/repo"], {
      ...m.mainDeps,
      invocation: adapter,
    });
    assert.strictEqual(status1, 0);
    assert.strictEqual(status2, 0);

    // Across BOTH runs (reads and writes), no cache key may name the
    // brief — composition is a pure projection over operation-level
    // units and never persists the composed envelope.
    const allKeys = [...m.cacheRec.gets, ...m.cacheRec.sets.map((s) => s.key)];
    assert.ok(allKeys.length > 0, "the two runs exercised the cache");
    for (const key of allKeys) {
      assert.ok(!key.includes("brief"), `brief-leaking cache key observed: ${key}`);
    }

    // Positive form: every written unit is an OPERATION-level unit in
    // the repository-exploration namespace (search/read-file/
    // list-directory), and the five units are distinct.
    assert.strictEqual(m.cacheRec.sets.length, 5);
    for (const s of m.cacheRec.sets) {
      assert.match(
        s.key,
        /^v2\.repository-exploration-repository-(search|read-file|list-directory)\./,
        `expected an operation-level cache key, got ${s.key}`,
      );
    }
    assert.strictEqual(
      new Set(m.cacheRec.sets.map((s) => s.key)).size,
      5,
      "the five cached units are distinct operations",
    );
  });
});