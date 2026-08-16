/**
 * Phase 2 repo-brief stream — Ticket 1: RepositoryBrief type set + pure
 * selection/parsing helpers (DESIGN D1, D7; SCHEMA.md).
 *
 * Scope (locked):
 *   - VERBATIM TypeScript type set for `RepositoryBrief` and friends
 *     lives in `src/capabilities/repository.ts`; runtime assertions here
 *     exercise the exported CONSTANTS and pure helpers only (types
 *     themselves are owned by the schema and by tsc).
 *   - `selectBriefFiles(tree)` — D1 / D7 selection rules: README at
 *     shallowest depth wins, manifest kinds in canonical order, cap 4.
 *   - `parseBriefFocus(raw)` / `parseBriefDepth(raw)` /
 *     `parseBriefMaxChars(raw)` — D7 request-parsing rules: split /
 *     trim / dedupe / sealed-set membership / empty-after-processing
 *     / positive-integer constraints. Every failure mode names the
 *     sealed set / constraint and is a `ValidationError`.
 *
 * Out-of-scope for this ticket (handled later):
 *   - `repoBrief` handler composition (Ticket 2).
 *   - Dispatch wiring + help text (Ticket 3).
 *   - Conformance + cache interaction (Ticket 4).
 *
 * No I/O, no Provider, no transport — pure tests against exported
 * helpers. Tests import from `dist/` per the package's build-then-test
 * contract; the build step precedes `node --test`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  REPO_BRIEF_FOCUS,
  selectBriefFiles,
  parseBriefFocus,
  parseBriefDepth,
  parseBriefMaxChars,
  README_QUERY,
  MANIFEST_QUERY,
  repoBrief,
} from "../dist/commands/repo.js";
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